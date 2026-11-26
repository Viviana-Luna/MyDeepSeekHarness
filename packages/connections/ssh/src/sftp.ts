/**
 * SSH SFTP 远端文件读写引擎：运行在后台 Runtime，负责目录分页、文本读取、Diff 预览与原子落盘。
 * 复用连接池提供的 SFTP 通道，不持有额外网络连接；所有路径在远端 realpath 后校验目录白名单。
 */
import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type { FileEntry, SFTPWrapper, Stats } from 'ssh2'
import {
  CONNECTION_TOOL_BYTES,
  connectionPage,
  connectionPageKey,
} from '@mydsh/connection-access/output'
import { assertRemotePathAllowed, normalizeRemotePosixPath } from './agent-policy.ts'

const MAX_READ_BYTES = 2 * 1024 * 1024
const MAX_WRITE_BYTES = 1 * 1024 * 1024
const MAX_READ_CONTENT_BYTES = 34 * 1024
const MAX_DIFF_PREVIEW_LINES = 120
const FORBIDDEN_WRITE_PATHS = new Set(['/etc/shadow', '/etc/gshadow', '/etc/sudoers'])

/** SFTP 远端目录单项摘要。 */
export type RemoteDirEntry = {
  readonly name: string
  readonly path: string
  readonly kind: 'file' | 'directory' | 'symlink' | 'other'
  readonly size: number
  readonly mode: string
  readonly modified_at: string
}

/** SFTP 远端文本读取结果。 */
export interface RemoteReadResult {
  readonly path: string
  readonly total_lines: number
  readonly start_line: number
  readonly end_line: number
  readonly truncated: boolean
  readonly byte_size: number
  readonly content: string
}

/** 写前预演结果：包含完整 Diff 预览、原文件元数据与风险提示，供确认卡展示与冲突检测。 */
export interface PreparedRemoteWrite {
  readonly resolvedPath: string
  readonly existed: boolean
  readonly originalMode: number | null
  readonly originalMtime: number | null
  readonly nextContent: string
  readonly nextBytes: number
  readonly diff: string
  readonly addedLines: number
  readonly removedLines: number
  readonly risks: readonly string[]
}

function sftpRealpath(sftp: SFTPWrapper, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    sftp.realpath(target, (error, absPath) => (error ? reject(error) : resolve(absPath)))
  })
}

function sftpStat(sftp: SFTPWrapper, target: string): Promise<Stats> {
  return new Promise((resolve, reject) => {
    sftp.stat(target, (error, stats) => (error ? reject(error) : resolve(stats)))
  })
}

function sftpReaddir(sftp: SFTPWrapper, target: string): Promise<FileEntry[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(target, (error, list) => (error ? reject(error) : resolve(list)))
  })
}

function sftpReadFile(sftp: SFTPWrapper, target: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.readFile(target, (error, data) => (error ? reject(error) : resolve(data)))
  })
}

function sftpWriteFile(sftp: SFTPWrapper, target: string, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.writeFile(target, data, error => (error ? reject(error) : resolve()))
  })
}

function sftpChmod(sftp: SFTPWrapper, target: string, mode: number): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.chmod(target, mode, error => (error ? reject(error) : resolve()))
  })
}

function sftpUnlink(sftp: SFTPWrapper, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(target, error => (error ? reject(error) : resolve()))
  })
}

function isSftpNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  return code === 2 || code === 'ENOENT'
}

/**
 * 解析远端真实绝对路径（展开符号链接），写入新建文件时向上回溯已存在的父目录并校验白名单。
 */
export async function resolveRemoteRealPath(
  sftp: SFTPWrapper,
  rawPath: string,
  options: { allowMissingLeaf?: boolean; allowDot?: boolean } = {},
): Promise<string> {
  if (options.allowDot && rawPath === '.') {
    return normalizeRemotePosixPath(await sftpRealpath(sftp, '.'), '远端主目录')
  }
  const normalized = normalizeRemotePosixPath(rawPath, '远端路径')
  try {
    return normalizeRemotePosixPath(await sftpRealpath(sftp, normalized), '远端路径')
  } catch (error) {
    if (!options.allowMissingLeaf || !isSftpNotFound(error)) throw error
  }
  // 新建文件尚不存在时，逐级定位最近存在的祖先目录以防止经由软链逃逸允许路径。
  const missingSegments: string[] = []
  let cursor = normalized
  while (cursor !== '/') {
    missingSegments.unshift(posix.basename(cursor))
    cursor = posix.dirname(cursor)
    try {
      const ancestor = normalizeRemotePosixPath(await sftpRealpath(sftp, cursor), '远端父目录')
      return normalizeRemotePosixPath(posix.join(ancestor, ...missingSegments), '远端路径')
    } catch (error) {
      if (!isSftpNotFound(error)) throw error
    }
  }
  return normalized
}

function entryKindOf(mode: number): RemoteDirEntry['kind'] {
  const fileType = mode & 0o170000
  if (fileType === 0o040000) return 'directory'
  if (fileType === 0o100000) return 'file'
  if (fileType === 0o120000) return 'symlink'
  return 'other'
}

/** 经 SFTP 列出远端目录内容并分页返回；受允许路径与 48 KiB 字节预算约束。 */
export async function listRemoteDir(
  sftp: SFTPWrapper,
  input: {
    connectionId: string
    revision: number
    path?: string
    allowedPaths: readonly string[]
    cursor?: string | null
    limit?: number
  },
) {
  const requested = input.path ?? input.allowedPaths[0] ?? '.'
  const resolvedDir = await resolveRemoteRealPath(sftp, requested, { allowDot: requested === '.' })
  assertRemotePathAllowed(resolvedDir, input.allowedPaths, '目标目录')
  const rawEntries = await sftpReaddir(sftp, resolvedDir)
  const items: RemoteDirEntry[] = rawEntries
    .filter(item => item.filename !== '.' && item.filename !== '..')
    .map(item => ({
      name: item.filename,
      path: posix.join(resolvedDir, item.filename),
      kind: entryKindOf(item.attrs.mode),
      size: item.attrs.size,
      mode: (item.attrs.mode & 0o7777).toString(8).padStart(4, '0'),
      modified_at: new Date(item.attrs.mtime * 1000).toISOString(),
    }))
    .toSorted((left, right) => {
      if (left.kind === 'directory' && right.kind !== 'directory') return -1
      if (left.kind !== 'directory' && right.kind === 'directory') return 1
      return left.name.localeCompare(right.name)
    })
  const key = connectionPageKey([input.connectionId, input.revision, resolvedDir])
  const page = connectionPage(
    items,
    {
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    },
    { key, defaultLimit: 50, maxLimit: 200 },
  )
  return {
    directory: resolvedDir,
    ...page,
  }
}

function isBinaryBuffer(buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.length, 8192)
  for (let index = 0; index < sampleLength; index++) {
    if (buffer[index] === 0) return true
  }
  return false
}

/** 经 SFTP 按行范围读取远端文本文件，拦截二进制或超大文件。 */
export async function readRemoteFile(
  sftp: SFTPWrapper,
  input: {
    path: string
    allowedPaths: readonly string[]
    offsetLine?: number
    limitLines?: number
  },
): Promise<RemoteReadResult> {
  const offsetLine = input.offsetLine ?? 1
  const limitLines = input.limitLines ?? 200
  if (!Number.isInteger(offsetLine) || offsetLine < 1)
    throw new Error('offset_line 必须是大于等于 1 的整数')
  if (!Number.isInteger(limitLines) || limitLines < 1 || limitLines > 1000)
    throw new Error('limit_lines 必须是 1 至 1000 之间的整数')
  const resolved = await resolveRemoteRealPath(sftp, input.path)
  if (FORBIDDEN_WRITE_PATHS.has(resolved))
    throw new Error('PERMISSION_DENIED：禁止读取系统凭据敏感文件（shadow / sudoers）')
  assertRemotePathAllowed(resolved, input.allowedPaths, '目标文件')
  const stats = await sftpStat(sftp, resolved)
  if (entryKindOf(stats.mode) === 'directory')
    throw new Error(`目标路径 ${resolved} 是目录，请改用 ssh_list_dir`)
  if (stats.size > MAX_READ_BYTES)
    throw new Error(
      `FILE_TOO_LARGE：文件 ${resolved} 大小为 ${stats.size} 字节（超过 2 MiB 上限），请使用 ssh_exec 配合 tail/head/grep 读取`,
    )
  const raw = await sftpReadFile(sftp, resolved)
  if (isBinaryBuffer(raw))
    throw new Error(`BINARY_FILE：文件 ${resolved} 为二进制内容，无法按文本读取`)
  const text = raw.toString('utf8')
  const allLines = text.length === 0 ? [] : text.split(/\r?\n/u)
  const startIndex = Math.min(offsetLine - 1, allLines.length)
  const endCandidate = Math.min(startIndex + limitLines, allLines.length)
  const selected: string[] = []
  let bytes = 0
  let truncatedByBudget = false
  for (let index = startIndex; index < endCandidate; index++) {
    const line = allLines[index]!
    const lineBytes = Buffer.byteLength(line, 'utf8') + (selected.length > 0 ? 1 : 0)
    if (selected.length > 0 && bytes + lineBytes > MAX_READ_CONTENT_BYTES) {
      truncatedByBudget = true
      break
    }
    if (selected.length === 0 && lineBytes > MAX_READ_CONTENT_BYTES) {
      selected.push(line.slice(0, Math.floor(MAX_READ_CONTENT_BYTES / 2)))
      truncatedByBudget = true
      break
    }
    selected.push(line)
    bytes += lineBytes
  }
  const actualEnd = selected.length === 0 ? startIndex : startIndex + selected.length
  return {
    path: resolved,
    total_lines: allLines.length,
    start_line: selected.length === 0 ? offsetLine : startIndex + 1,
    end_line: actualEnd,
    truncated: truncatedByBudget || actualEnd < allLines.length,
    byte_size: raw.length,
    content: selected.join('\n'),
  }
}

/** 生成简洁的 Unified Diff 文本与增删行计数，用于确认卡预览远端文件变更。 */
export function buildUnifiedDiff(
  filePath: string,
  before: string,
  after: string,
): { diff: string; addedLines: number; removedLines: number } {
  const beforeLines = before.length === 0 ? [] : before.split('\n')
  const afterLines = after.length === 0 ? [] : after.split('\n')
  let prefix = 0
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix++
  }
  let suffix = 0
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix++
  }
  const removed = beforeLines.slice(prefix, beforeLines.length - suffix)
  const added = afterLines.slice(prefix, afterLines.length - suffix)
  const contextStart = Math.max(0, prefix - 3)
  const contextEndBefore = Math.min(beforeLines.length, beforeLines.length - suffix + 3)
  const contextEndAfter = Math.min(afterLines.length, afterLines.length - suffix + 3)
  const header = [
    `--- a${filePath}`,
    `+++ b${filePath}`,
    `@@ -${contextStart + 1},${contextEndBefore - contextStart} +${contextStart + 1},${contextEndAfter - contextStart} @@`,
  ]
  const body: string[] = []
  for (let index = contextStart; index < prefix; index++) body.push(` ${beforeLines[index]}`)
  for (const line of removed) body.push(`-${line}`)
  for (const line of added) body.push(`+${line}`)
  for (let index = beforeLines.length - suffix; index < contextEndBefore; index++) {
    body.push(` ${beforeLines[index]}`)
  }
  const preview =
    body.length > MAX_DIFF_PREVIEW_LINES
      ? [
          ...body.slice(0, MAX_DIFF_PREVIEW_LINES),
          `... (其余 ${body.length - MAX_DIFF_PREVIEW_LINES} 行已省略)`,
        ]
      : body
  return {
    diff: [...header, ...preview].join('\n'),
    addedLines: added.length,
    removedLines: removed.length,
  }
}

function writeTargetRisks(
  resolvedPath: string,
  existed: boolean,
  mode: 'replace' | 'overwrite',
): string[] {
  const risks: string[] = []
  if (resolvedPath.endsWith('/.ssh/authorized_keys') || resolvedPath.includes('/.ssh/'))
    risks.push('修改 SSH 密钥或认证目录文件，将强制单次确认')
  if (resolvedPath.startsWith('/etc/') || resolvedPath.startsWith('/usr/lib/systemd/'))
    risks.push('修改系统级配置文件，将强制单次确认')
  if (existed && mode === 'overwrite') risks.push('将整文件覆写已有远端文件')
  return risks
}

/** 预检远端写入并计算 Unified Diff；尚未修改远端文件，供确认卡审批。 */
export async function prepareRemoteWrite(
  sftp: SFTPWrapper,
  input: {
    path: string
    allowedPaths: readonly string[]
    mode: 'replace' | 'overwrite'
    oldText?: string
    newText?: string
    content?: string
  },
): Promise<PreparedRemoteWrite> {
  const resolvedPath = await resolveRemoteRealPath(sftp, input.path, { allowMissingLeaf: true })
  if (FORBIDDEN_WRITE_PATHS.has(resolvedPath))
    throw new Error('PERMISSION_DENIED：禁止直接写入系统凭据敏感文件（shadow / sudoers）')
  assertRemotePathAllowed(resolvedPath, input.allowedPaths, '目标文件')
  let existed = false
  let originalMode: number | null = null
  let originalMtime: number | null = null
  let beforeContent = ''
  try {
    const stats = await sftpStat(sftp, resolvedPath)
    if (entryKindOf(stats.mode) === 'directory')
      throw new Error(`目标路径 ${resolvedPath} 是目录，无法作为文件写入`)
    if (stats.size > MAX_WRITE_BYTES)
      throw new Error(`目标文件超过 1 MiB 写入上限（当前 ${stats.size} 字节）`)
    const raw = await sftpReadFile(sftp, resolvedPath)
    if (isBinaryBuffer(raw)) throw new Error('BINARY_FILE：不能修改二进制文件')
    existed = true
    originalMode = stats.mode & 0o7777
    originalMtime = stats.mtime
    beforeContent = raw.toString('utf8')
  } catch (error) {
    if (!isSftpNotFound(error)) throw error
  }
  let nextContent: string
  if (input.mode === 'replace') {
    if (!existed) throw new Error(`文件不存在，无法执行局部替换：${resolvedPath}`)
    if (!input.oldText) throw new Error('replace 模式必须提供非空的 old_text')
    const first = beforeContent.indexOf(input.oldText)
    if (first < 0) throw new Error('在目标文件中未找到指定的 old_text，请重新读取文件核对')
    if (beforeContent.indexOf(input.oldText, first + input.oldText.length) >= 0)
      throw new Error('old_text 在文件中出现多次，请补充更多上下文使其唯一匹配')
    nextContent =
      beforeContent.slice(0, first) +
      (input.newText ?? '') +
      beforeContent.slice(first + input.oldText.length)
  } else {
    if (typeof input.content !== 'string') throw new Error('overwrite 模式必须提供 content 字符串')
    nextContent = input.content
  }
  const nextBytes = Buffer.byteLength(nextContent, 'utf8')
  if (nextBytes > MAX_WRITE_BYTES)
    throw new Error(`写入内容超过 1 MiB 上限（当前 ${nextBytes} 字节）`)
  const { diff, addedLines, removedLines } = buildUnifiedDiff(
    resolvedPath,
    beforeContent,
    nextContent,
  )
  return {
    resolvedPath,
    existed,
    originalMode,
    originalMtime,
    nextContent,
    nextBytes,
    diff,
    addedLines,
    removedLines,
    risks: writeTargetRisks(resolvedPath, existed, input.mode),
  }
}

function renameOverExisting(
  sftp: SFTPWrapper,
  tempPath: string,
  targetPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const extRename = (
      sftp as SFTPWrapper & {
        ext_openssh_rename?: (
          src: string,
          dest: string,
          cb: (err?: Error | null) => void,
        ) => boolean
      }
    ).ext_openssh_rename
    if (typeof extRename === 'function') {
      extRename.call(sftp, tempPath, targetPath, error => {
        if (!error) {
          resolve()
          return
        }
        sftp.rename(tempPath, targetPath, fallbackError =>
          fallbackError ? reject(fallbackError) : resolve(),
        )
      })
      return
    }
    sftp.rename(tempPath, targetPath, error => (error ? reject(error) : resolve()))
  })
}

/**
 * 提交已批准的远端文件写入：复核 mtime 防止并发覆盖，并优先以临时文件原子重命名落盘。
 */
export async function commitRemoteWrite(
  sftp: SFTPWrapper,
  prepared: PreparedRemoteWrite,
): Promise<{ path: string; bytes: number; created: boolean; atomic: boolean }> {
  if (prepared.existed) {
    const current = await sftpStat(sftp, prepared.resolvedPath)
    if (prepared.originalMtime !== null && current.mtime !== prepared.originalMtime) {
      throw new Error('FILE_CONFLICT：远端文件在审批期间已被修改，已中止写入，请重新读取后再试')
    }
  }
  const data = Buffer.from(prepared.nextContent, 'utf8')
  const directory = posix.dirname(prepared.resolvedPath)
  const base = posix.basename(prepared.resolvedPath)
  const tempPath = posix.join(directory, `.${base}.mydsh-${randomUUID().slice(0, 8)}.tmp`)
  let wroteTemp = false
  try {
    await sftpWriteFile(sftp, tempPath, data)
    wroteTemp = true
    if (prepared.originalMode !== null) {
      await sftpChmod(sftp, tempPath, prepared.originalMode).catch(() => {})
    }
    try {
      await renameOverExisting(sftp, tempPath, prepared.resolvedPath)
      wroteTemp = false
      return {
        path: prepared.resolvedPath,
        bytes: data.length,
        created: !prepared.existed,
        atomic: true,
      }
    } catch {
      // 标准 SFTP v3 不允许 rename 覆盖已有目标且服务端未开启 posix-rename 时，安全回退为直接覆写。
      await sftpWriteFile(sftp, prepared.resolvedPath, data)
      if (prepared.originalMode !== null) {
        await sftpChmod(sftp, prepared.resolvedPath, prepared.originalMode).catch(() => {})
      }
      return {
        path: prepared.resolvedPath,
        bytes: data.length,
        created: !prepared.existed,
        atomic: false,
      }
    }
  } finally {
    if (wroteTemp) await sftpUnlink(sftp, tempPath).catch(() => {})
  }
}

/** 限制 SFTP 工具返回 JSON 尺寸的默认字节常量（便于同包工具复用）。 */
export const SFTP_TOOL_BUDGET = CONNECTION_TOOL_BYTES
