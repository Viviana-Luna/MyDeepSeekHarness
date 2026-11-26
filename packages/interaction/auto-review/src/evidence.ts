/** 审核只读能力：受限路径、完整小文件、无 Shell/网络，不登记主工具的文件观察。 */
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import { parseObject } from './policy.ts'

const MAX_READ = 16 * 1024
const MAX_EVIDENCE = 64 * 1024
const MAX_READS = 6
const PARAMETERS = {
  type: 'object',
  properties: { path: { type: 'string' } },
  required: ['path'],
  additionalProperties: false,
}
export const EVIDENCE_TOOLS: ToolSchema[] = [
  {
    name: 'stat_path',
    description: '只读检查授权范围内路径的存在性、类型和大小。',
    parameters: PARAMETERS,
  },
  {
    name: 'list_directory',
    description: '列出授权目录的直接子项；不递归，不读取文件内容。',
    parameters: PARAMETERS,
  },
  {
    name: 'read_text',
    description: '完整读取不超过 16 KiB 的普通 UTF-8 文本；不读取凭据、特殊文件或符号链接。',
    parameters: PARAMETERS,
  },
]
type EvidenceTool = 'stat_path' | 'list_directory' | 'read_text'
const argsSchema = z.object({ path: z.string().min(1).max(4096) }).strict()
export class ReviewBudgetError extends Error {
  constructor() {
    super('审核输入或取证达到预算')
  }
}
export class ProtectedEvidenceError extends Error {
  constructor() {
    super('审核禁止访问私有配置和凭据')
  }
}
export class StaleEvidenceError extends Error {
  constructor() {
    super('审核证据已变化')
  }
}

/** 只拒绝明确敏感的路径，不把未匹配的路径宣称为没有秘密。 */
export function protectedPath(path: string): boolean {
  const parts = path.toLowerCase().split(/[\\/]/u)
  return parts.some(
    part =>
      /^\.(?:env(?:\..*)?|ssh|aws|azure|gnupg|kube|docker|config|mydsh|wish|git|npmrc|pypirc|netrc)$/u.test(
        part,
      ) ||
      /^(?:credentials(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|keychain(?:-db)?))$/u.test(
        part,
      ),
  )
}
function within(root: string, path: string): boolean {
  const part = relative(root, path)
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part))
}
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
interface EvidenceSnapshot {
  tool: EvidenceTool
  path: string
  fingerprint: string
}

export class ReviewEvidence {
  private readonly snapshots: EvidenceSnapshot[] = []
  private reads = 0
  private bytes = 0
  private root?: FsTarget
  private extra?: FsTarget
  incomplete = false
  get count(): number {
    return this.snapshots.length
  }
  /** 审计仅保留不可逆摘要，不复制路径内容或模型读取的正文。 */
  get references(): string[] {
    return this.snapshots.map(item => item.fingerprint)
  }

  constructor(
    private readonly fs: FileSystem | undefined,
    private readonly cwd: string,
    private readonly extraPath?: string,
  ) {}

  async prepare(signal: AbortSignal): Promise<void> {
    if (this.extraPath && protectedPath(this.extraPath)) throw new ProtectedEvidenceError()
    if (!this.fs) return
    this.root = await this.fs.resolve(this.cwd, { signal })
    if (this.extraPath) {
      this.extra = await this.fs.resolve(this.extraPath, { cwd: this.cwd, signal })
      if (protectedPath(this.fs.processPath(this.extra))) throw new ProtectedEvidenceError()
    }
  }

  async inspect(name: string, argumentsText: string, signal: AbortSignal): Promise<unknown> {
    if (!EVIDENCE_TOOLS.some(tool => tool.name === name))
      throw new Error('审核请求了未开放的取证工具')
    const { path } = argsSchema.parse(parseObject(argumentsText))
    if (++this.reads > MAX_READS) throw new ReviewBudgetError()
    try {
      const result = await this.read(name as EvidenceTool, path, signal)
      const size = Buffer.byteLength(JSON.stringify(result.value))
      if (size > MAX_READ || this.bytes + size > MAX_EVIDENCE) throw new ReviewBudgetError()
      this.bytes += size
      this.snapshots.push({ tool: name as EvidenceTool, path, fingerprint: result.fingerprint })
      return result.value
    } catch (error) {
      if (
        signal.aborted ||
        error instanceof ProtectedEvidenceError ||
        error instanceof StaleEvidenceError
      )
        throw error
      this.incomplete = true
      return {
        unavailable: true,
        reason:
          error instanceof ReviewBudgetError
            ? '取证超过预算，不返回截断内容'
            : '路径不可读取或不在本次取证范围内',
      }
    }
  }

  async validate(signal: AbortSignal): Promise<void> {
    // 有序复核每份证据；不把新内容交给模型，也不把过期证据升级为授权。
    for (const snapshot of this.snapshots) {
      // oxlint-disable-next-line no-await-in-loop
      const current = await this.read(snapshot.tool, snapshot.path, signal)
      if (current.fingerprint !== snapshot.fingerprint) throw new StaleEvidenceError()
    }
  }

  private async pathState(path: string, signal: AbortSignal) {
    signal.throwIfAborted()
    if (!this.fs || !this.root) throw new Error('文件取证服务不可用')
    const lexical = resolve(this.cwd, path)
    if (protectedPath(lexical)) throw new ProtectedEvidenceError()
    // 不跟随工作区内的符号链接；外部只允许明确文件动作的那个路径。
    const external = this.extraPath ? resolve(this.cwd, this.extraPath) : undefined
    if (!within(resolve(this.cwd), lexical) && lexical !== external) throw new Error('取证路径越界')
    const chain: Array<[string, string | null]> = []
    for (let current = lexical; ; current = dirname(current)) {
      // oxlint-disable-next-line no-await-in-loop
      const info = await this.fs.lstat(current, { cwd: this.cwd }, signal)
      if (info?.type === 'symlink' || info?.type === 'other')
        throw new Error('取证拒绝符号链接和特殊文件')
      chain.push([current, info?.version ?? null])
      if (
        current === resolve(this.cwd) ||
        current === dirname(current) ||
        (lexical === external && current === dirname(lexical))
      )
        break
    }
    const target = await this.fs.resolve(lexical, { cwd: this.cwd, signal })
    if (protectedPath(this.fs.processPath(target))) throw new ProtectedEvidenceError()
    if (!this.fs.contains(this.root, target) && target.targetKey !== this.extra?.targetKey)
      throw new Error('规范化后的取证路径越界')
    const info = await this.fs.stat(target, signal)
    if (info?.type === 'other') throw new Error('取证拒绝特殊文件')
    return {
      target,
      info,
      identity: digest({ target: target.targetKey, info: info ?? null, chain }),
    }
  }

  private async read(tool: EvidenceTool, path: string, signal: AbortSignal) {
    const before = await this.pathState(path, signal)
    const fs = this.fs!
    let value: unknown
    if (tool === 'stat_path')
      value = {
        exists: !!before.info,
        type: before.info?.type ?? null,
        size: before.info?.size ?? null,
      }
    else if (tool === 'read_text') {
      if (
        before.info?.type !== 'file' ||
        before.info.size === undefined ||
        before.info.size > MAX_READ
      )
        throw new ReviewBudgetError()
      const bytes = await fs.readBytes(before.target, signal, MAX_READ)
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      if (text.includes('\0')) throw new Error('不向审核模型提供二进制文件')
      if (
        /-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["']?[^\s"']{12,}/iu.test(
          text,
        )
      )
        throw new ProtectedEvidenceError()
      value = { text }
    } else {
      if (before.info?.type !== 'directory' || !this.root || !fs.contains(this.root, before.target))
        throw new Error('仅列出工作区目录')
      const children = await fs.listDir(before.target, signal)
      if (children.length > 128) throw new ReviewBudgetError()
      value = {
        entries: children
          .filter(child => !protectedPath(child.name))
          .map(child => ({ name: child.name, type: child.type, size: child.size ?? null })),
      }
    }
    const after = await this.pathState(path, signal)
    if (before.identity !== after.identity) throw new StaleEvidenceError()
    return { value, fingerprint: digest({ identity: before.identity, tool, value }) }
  }
}
