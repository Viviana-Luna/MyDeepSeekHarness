import { renameWithRetry as rename } from '../filesystem/file-operations.ts'
/**
 * DSH 数据的一次性导入。只读取来源，沿用 Session ID、父子关系及存储格式。
 * 主进程必须先停止 MyDSH Runtime 并持有单实例锁，才能提交或恢复事务。
 * 来源应处于停止状态；预览、提交前和提交末尾的摘要核对拒绝并发变化。
 */
/* eslint-disable no-await-in-loop -- 会话验证和事务写入保持顺序，避免同时解压多个大日志。 */
import {
  SESSION_LOG_GENERATION,
  sessionDirectorySegment,
  sessionProjectDirectoryKey,
} from '../../shared/session-paths.ts'
import { createHash, randomUUID } from 'node:crypto'
import { realpath as fsRealpath } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { constants, zstdCompress, zstdDecompress } from 'node:zlib'
import { parseDocument, stringify } from 'yaml'

const realpath = promisify(fsRealpath.native)
const normalizeImportPath = (value: string): string =>
  process.platform === 'win32' ? value.toLowerCase() : value

const compress = promisify(zstdCompress)
const decompress = promisify(zstdDecompress)
const MAX_LOG_BYTES = 256 * 1024 * 1024
const DEFAULT_SETTINGS = [
  'llm-deepseek',
  'llm-pi-ai',
  'agent-presets',
  'permission-presets',
  'compaction',
  'skills',
  'goal',
  'subagent',
]

/** 注入随核心发布的格式目录，导入器不维护第二套 Session 校验规则。 */
export interface SessionImportCatalog {
  readonly currentVersion: number
  createRestore(
    header: unknown,
    options: { recovery: 'strict'; validation: 'current' },
  ): {
    readonly header: { readonly id: string; readonly cwd?: string; readonly parentSession?: string }
    decodeRow(row: unknown): void
    finish(): unknown
  }
}

export interface DshImportOptions {
  sourceHome: string
  mydshHome: string
  sessionFormat: SessionImportCatalog
  supportedSettingsNamespaces?: readonly string[]
  signal?: AbortSignal
}

export interface DshImportIssue {
  severity: 'warning' | 'error'
  code: string
  path: string
  message: string
}

export interface DshImportSession {
  id: string
  parentSession?: string
  cwd?: string
  generation: number
  sourcePath: string
  digest: string
}

export interface DshImportPreview {
  sourceHome: string
  fingerprint: string
  sessions: DshImportSession[]
  projects: Array<{ id: string; title: string; path: string; sessions: number }>
  settingsNamespaces: string[]
  credentialNames: string[]
  attachmentCount: number
  issues: DshImportIssue[]
}

interface WorkspaceRecord {
  path: string
  title: string
  sessionIds: string[]
  createdAt: string
  updatedAt: string
}

interface WorkspaceDocument {
  unit: { name: 'workspace'; version: 2 }
  global: { initialized: boolean; workspaceIds: string[]; archivedSessionIds: string[] }
  tables: { workspaces: Record<string, WorkspaceRecord> }
}

interface ImportSnapshot {
  preview: DshImportPreview
  files: Map<string, string>
  sessions: Map<string, { info: DshImportSession }>
  attachments: Set<string>
  workspace?: WorkspaceDocument
  settings: Record<string, unknown>
}

interface ImportLedger {
  version: 1
  sources: Record<
    string,
    {
      sourceHome: string
      importedAt: string
      sessions: Record<string, { digest: string; targetId: string }>
      projects: Record<string, string>
    }
  >
}

export interface DshImportResult {
  importedSessions: number
  skippedSessions: number
  sessionMapping: Record<string, string>
  projectMapping: Record<string, string>
  issues: DshImportIssue[]
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

/** Windows 的 relative() 用反斜杠，先统一分隔符再判断越界，避免把并列目录误判为包含关系。 */
function inside(root: string, path: string): boolean {
  const part = relative(root, path).replaceAll('\\', '/')
  return part === '' || (!part.startsWith('../') && part !== '..' && !isAbsolute(part))
}

/** 不跟随来源或目标中的链接，避免复制项目文件或越过用户选定目录。 */
async function readSafe(root: string, path: string, limit = MAX_LOG_BYTES): Promise<Buffer> {
  const absolute = join(root, path)
  if (!inside(root, absolute)) throw new Error('导入路径超出所选目录。')
  let current = root
  for (const part of relative(root, absolute).split(/[\\/]/)) {
    current = join(current, part)
    if ((await lstat(current)).isSymbolicLink()) throw new Error('导入不跟随符号链接。')
  }
  const info = await lstat(absolute)
  if (!info.isFile() || info.size > limit)
    throw new Error('导入文件不是普通文件或超过 256 MiB 限制。')
  return readFile(absolute)
}

async function optionalFile(root: string, path: string): Promise<Buffer | undefined> {
  try {
    return await readSafe(root, path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function entries(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** YAML 解析错误可能带有凭据原文，因此只返回固定的中文错误，不附带解析器 cause。 */
function yamlObject(bytes: Buffer): Record<string, unknown> {
  const document = parseDocument(bytes.toString('utf8'), { uniqueKeys: true, prettyErrors: false })
  if (document.errors.length) throw new Error('YAML 文档格式无效。')
  let value: unknown
  try {
    value = document.toJS({ maxAliasCount: 100 }) ?? {}
  } catch {
    throw new Error('YAML 文档无法安全解析。')
  }
  if (!object(value)) throw new Error('YAML 文档必须使用对象结构。')
  return value
}

function workspaceDocument(bytes: Buffer): WorkspaceDocument {
  const value: unknown = JSON.parse(bytes.toString('utf8'))
  if (
    !object(value) ||
    !object(value.unit) ||
    value.unit.name !== 'workspace' ||
    value.unit.version !== 2 ||
    !object(value.global) ||
    typeof value.global.initialized !== 'boolean' ||
    !strings(value.global.workspaceIds) ||
    (value.global.archivedSessionIds !== undefined && !strings(value.global.archivedSessionIds)) ||
    value.global.pendingMutation !== undefined ||
    !object(value.tables) ||
    !object(value.tables.workspaces)
  ) {
    throw new Error('项目存储格式不受支持，或来源尚有未完成的项目写入。')
  }
  const records: Record<string, WorkspaceRecord> = Object.create(null) as Record<
    string,
    WorkspaceRecord
  >
  const owners = new Set<string>()
  for (const [id, item] of Object.entries(value.tables.workspaces)) {
    if (
      !object(item) ||
      typeof item.path !== 'string' ||
      !isAbsolute(item.path) ||
      typeof item.title !== 'string' ||
      !strings(item.sessionIds) ||
      typeof item.createdAt !== 'string' ||
      typeof item.updatedAt !== 'string'
    ) {
      throw new Error('项目记录不完整。')
    }
    for (const sessionId of item.sessionIds) {
      if (owners.has(sessionId)) throw new Error('来源中的一个会话归属于多个项目。')
      owners.add(sessionId)
    }
    records[id] = item as unknown as WorkspaceRecord
  }
  const workspaceIds = value.global.workspaceIds
  if (
    new Set(workspaceIds).size !== workspaceIds.length ||
    workspaceIds.some(id => !records[id]) ||
    Object.keys(records).some(id => !workspaceIds.includes(id))
  ) {
    throw new Error('项目顺序与项目记录不一致。')
  }
  return {
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: value.global.initialized,
      workspaceIds: value.global.workspaceIds,
      archivedSessionIds: (value.global.archivedSessionIds ?? []) as string[],
    },
    tables: { workspaces: records },
  }
}

function attachmentPaths(value: unknown, paths: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) attachmentPaths(item, paths)
    return
  }
  if (!object(value)) return
  if (typeof value.attachmentId === 'string') {
    const match = /^sha256:([a-f0-9]{64})$/u.exec(value.attachmentId)
    if (match?.[1]) {
      const digest = match[1]
      if (typeof value.mediaType === 'string')
        paths.add(`attachments/v1/objects/${digest.slice(0, 2)}/${digest}`)
      else if (
        typeof value.name === 'string' &&
        value.name !== '.' &&
        value.name !== '..' &&
        !/[/\\]/u.test(value.name) &&
        !value.name.includes('\0')
      ) {
        paths.add(`attachments/v1/files/${digest.slice(0, 2)}/${digest}/${value.name}`)
        paths.add(`attachments/v1/file-objects/${digest.slice(0, 2)}/${digest}`)
      }
    }
  }
  for (const item of Object.values(value)) attachmentPaths(item, paths)
}

function withoutSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSecrets)
  if (!object(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !/^(api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|token)$/iu.test(key),
      )
      .map(([key, item]) => [key, withoutSecrets(item)]),
  )
}

function credentialEntries(bytes: Buffer): Map<string, string | Record<string, unknown>> {
  const data = yamlObject(bytes)
  if (!Object.keys(data).length) return new Map()
  if (
    data.version !== 1 ||
    Object.keys(data).some(key => !['version', 'refs', 'records'].includes(key))
  )
    throw new Error('凭据文档版本不受支持。')
  const result = new Map<string, string | Record<string, unknown>>()
  for (const section of ['refs', 'records']) {
    if (data[section] === undefined) continue
    if (!object(data[section])) throw new Error('凭据文档结构无效。')
    for (const [name, value] of Object.entries(data[section])) {
      if (
        !name ||
        (section === 'refs'
          ? typeof value !== 'string' || !value
          : !object(value) || !['api-key', 'grant'].includes(String(value.kind)))
      )
        throw new Error('凭据记录格式不受支持。')
      result.set(
        `${section === 'refs' ? 'ref' : 'record'}:${name}`,
        value as string | Record<string, unknown>,
      )
    }
  }
  return result
}

async function snapshot(options: DshImportOptions): Promise<ImportSnapshot> {
  options.signal?.throwIfAborted()
  if (!isAbsolute(options.sourceHome) || !isAbsolute(options.mydshHome))
    throw new Error('导入来源和 MyDSH 目录必须是绝对路径。')
  const source = await realpath(options.sourceHome)
  const target = resolve(options.mydshHome)
  if (inside(source, target) || inside(target, source))
    throw new Error('导入来源不能与 MyDSH 目录重叠。')
  const preview: DshImportPreview = {
    sourceHome: source,
    fingerprint: '',
    sessions: [],
    projects: [],
    settingsNamespaces: [],
    credentialNames: [],
    attachmentCount: 0,
    issues: [],
  }
  const state: ImportSnapshot = {
    preview,
    files: new Map(),
    sessions: new Map(),
    attachments: new Set(),
    settings: {},
  }
  const issue = (
    code: string,
    path: string,
    message: string,
    severity: DshImportIssue['severity'] = 'error',
  ): void => {
    preview.issues.push({ code, path, message, severity })
  }
  const read = async (path: string): Promise<Buffer | undefined> => {
    options.signal?.throwIfAborted()
    const bytes = await optionalFile(source, path)
    if (bytes) state.files.set(path, sha256(bytes))
    return bytes
  }
  for (const project of (await entries(join(source, 'sessions'))).toSorted()) {
    const projectPath = join(source, 'sessions', project)
    if (!(await lstat(projectPath)).isDirectory()) {
      issue('session-layout', `sessions/${project}`, '会话根目录中存在不支持的文件或链接。')
      continue
    }
    for (const session of (await entries(projectPath)).toSorted()) {
      const sessionPath = join(projectPath, session)
      if (!(await lstat(sessionPath)).isDirectory()) {
        issue(
          'session-layout',
          `sessions/${project}/${session}`,
          '不支持旧式平铺会话布局或符号链接。',
        )
        continue
      }
      const sessionFiles = await entries(sessionPath)
      const candidates = sessionFiles
        .flatMap(name => {
          const match = SESSION_LOG_GENERATION.exec(name)
          return match ? [{ name, version: Number(match[1] ?? 0), compressed: !!match[2] }] : []
        })
        .toSorted((a, b) => b.version - a.version)
      if (!candidates.length) {
        if (sessionFiles.some(name => name.startsWith('session') && name.includes('.jsonl')))
          issue(
            'session-layout',
            `sessions/${project}/${session}`,
            '会话文件名称不属于受支持的 generation 格式。',
          )
        continue
      }
      const selected = candidates[0]!
      const path = `sessions/${project}/${session}/${selected.name}`
      if (candidates.some(item => item.compressed !== selected.compressed)) {
        issue('session-encoding', path, '同一会话混用了 JSONL 和 Zstandard 编码。')
        continue
      }
      try {
        const bytes = await read(path)
        if (!bytes) throw new Error('来源会话在读取期间消失。')
        if (selected.version > options.sessionFormat.currentVersion) {
          issue(
            'session-version',
            path,
            `会话格式 v${selected.version} 高于当前支持的 v${options.sessionFormat.currentVersion}。`,
          )
          continue
        }
        const plaintext = selected.compressed
          ? await decompress(bytes, { maxOutputLength: MAX_LOG_BYTES })
          : bytes
        if (!plaintext.length || plaintext.at(-1) !== 10) throw new Error('会话日志末尾不完整。')
        const lines = new TextDecoder('utf-8', { fatal: true })
          .decode(plaintext)
          .trimEnd()
          .split('\n')
        const header: unknown = JSON.parse(lines[0]!)
        if (!object(header) || header.version !== selected.version)
          throw new Error('会话头与物理版本不一致。')
        const restore = options.sessionFormat.createRestore(header, {
          recovery: 'strict',
          validation: 'current',
        })
        for (const line of lines.slice(1)) {
          options.signal?.throwIfAborted()
          const event: unknown = JSON.parse(line)
          restore.decodeRow(event)
          attachmentPaths(event, state.attachments)
        }
        restore.finish()
        const { id, cwd, parentSession } = restore.header
        if (sessionDirectorySegment(id) !== session || sessionProjectDirectoryKey(cwd) !== project)
          throw new Error('会话 ID、项目路径与物理目录不一致。')
        if (state.sessions.has(id)) throw new Error('来源目录存在重复会话 ID。')
        const info: DshImportSession = {
          id,
          ...(cwd === undefined ? {} : { cwd }),
          ...(parentSession === undefined ? {} : { parentSession }),
          generation: selected.version,
          sourcePath: path,
          digest: sha256(plaintext),
        }
        state.sessions.set(id, { info })
        preview.sessions.push(info)
      } catch {
        options.signal?.throwIfAborted()
        issue('session-corrupt', path, '会话未通过完整性、格式或关系校验；不会修复或截断来源日志。')
      }
    }
  }
  for (const session of preview.sessions)
    if (session.parentSession && !state.sessions.has(session.parentSession))
      issue(
        'missing-parent',
        session.sourcePath,
        `父会话 ${session.parentSession} 不在本次来源中。`,
        'warning',
      )
  for (const path of state.attachments) {
    try {
      const bytes = await read(path)
      const expected = path.split('/').find(part => /^[a-f0-9]{64}$/u.test(part))
      if (!bytes || sha256(bytes) !== expected) {
        issue('missing-attachment', path, '附件缺失或摘要不匹配，导入后将显示为不可用。', 'warning')
        continue
      }
      preview.attachmentCount++
    } catch {
      issue('missing-attachment', path, '附件无法读取，导入后将显示为不可用。', 'warning')
    }
  }
  try {
    const bytes = await read('storages/workspace.json')
    if (bytes) {
      state.workspace = workspaceDocument(bytes)
      preview.projects = state.workspace.global.workspaceIds.map(id => ({
        id,
        title: state.workspace!.tables.workspaces[id]!.title,
        path: state.workspace!.tables.workspaces[id]!.path,
        sessions: state.workspace!.tables.workspaces[id]!.sessionIds.length,
      }))
      for (const item of Object.values(state.workspace.tables.workspaces))
        for (const id of item.sessionIds)
          if (!state.sessions.has(id))
            issue(
              'missing-session',
              'storages/workspace.json',
              `项目引用了缺失会话 ${id}。`,
              'warning',
            )
    } else if (state.sessions.size)
      issue(
        'workspace-bootstrap',
        'storages/workspace.json',
        '来源没有项目注册表；启动后会按会话头中的工作目录补齐项目。',
        'warning',
      )
  } catch {
    issue('workspace-invalid', 'storages/workspace.json', '项目存储不是受支持的完整 v2 记录。')
  }
  try {
    const bytes = await read('settings.yaml')
    if (bytes) {
      const allowed = new Set(options.supportedSettingsNamespaces ?? DEFAULT_SETTINGS)
      for (const [namespace, section] of Object.entries(yamlObject(bytes))) {
        if (!allowed.has(namespace)) {
          issue(
            'settings-skipped',
            'settings.yaml',
            `设置 ${namespace} 不在当前可导入范围内。`,
            'warning',
          )
          continue
        }
        if (!object(section)) throw new Error('设置项不是对象。')
        const clean = withoutSecrets(section)
        if (JSON.stringify(clean) !== JSON.stringify(section))
          issue(
            'settings-secret',
            'settings.yaml',
            `设置 ${namespace} 中的内联密钥未导入；请通过凭据界面重新配置。`,
            'warning',
          )
        state.settings[namespace] = clean
        preview.settingsNamespaces.push(namespace)
      }
    }
  } catch {
    issue('settings-invalid', 'settings.yaml', '设置文档格式不受支持。')
  }
  try {
    const bytes = await read('.credentials.yaml')
    if (bytes) preview.credentialNames = [...credentialEntries(bytes).keys()]
  } catch {
    issue(
      'credentials-invalid',
      '.credentials.yaml',
      '凭据格式不受支持；数据导入不会复制凭据文件。',
      'warning',
    )
  }
  preview.fingerprint = sha256(
    JSON.stringify([...state.files.entries()].toSorted(([a], [b]) => a.localeCompare(b))),
  )
  return state
}

/** 预览仅返回元信息与名称，事件正文、配置值及凭据值不会跨越此接口。 */
export async function previewDshImport(options: DshImportOptions): Promise<DshImportPreview> {
  return (await snapshot(options)).preview
}

async function copyDirectory(
  source: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  const info = await lstat(source)
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('MyDSH 数据目录必须是实际目录。')
  await mkdir(destination, { recursive: true, mode: 0o700 })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    signal?.throwIfAborted()
    if (entry.isSymbolicLink()) throw new Error('MyDSH 数据目录含有符号链接，已停止导入。')
    if (entry.isDirectory())
      await copyDirectory(join(source, entry.name), join(destination, entry.name), signal)
    else if (entry.isFile()) await copyFile(join(source, entry.name), join(destination, entry.name))
    else throw new Error('MyDSH 数据目录含有不支持的文件类型。')
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * data 与 config 不能用一次 rename 同时切换，因此以成功标记作为联合提交点。
 * Runtime 和配置写入者必须已经停止；提交前的任意中断均恢复两个目录的旧版本。
 * 恢复自身也可重入：已恢复的旧目录不再有 previous，不会再次删除。
 */
async function recoverImportTransaction(home: string, staging: string): Promise<void> {
  const bytes = await optionalFile(staging, 'transaction.json')
  if (bytes) {
    const journal: unknown = JSON.parse(bytes.toString('utf8'))
    if (
      !object(journal) ||
      journal.version !== 1 ||
      typeof journal.hadData !== 'boolean' ||
      typeof journal.hadConfig !== 'boolean'
    )
      throw new Error('导入恢复记录无效；已保留暂存目录，请勿手动删除。')
    if (await exists(join(staging, 'committed'))) {
      for (const name of ['data', 'config']) {
        const target = await lstat(join(home, name))
        if (!target.isDirectory() || target.isSymbolicLink())
          throw new Error('已提交导入的活动目录不完整；已保留旧副本。')
      }
    } else {
      for (const name of ['config', 'data'] as const) {
        const target = join(home, name),
          previous = join(staging, `previous-${name}`)
        if (await exists(previous)) {
          await rm(target, { recursive: true, force: true })
          await rename(previous, target)
        } else if (!(name === 'data' ? journal.hadData : journal.hadConfig)) {
          await rm(target, { recursive: true, force: true })
        }
      }
    }
  } else if (
    (await exists(join(staging, 'previous-data'))) ||
    (await exists(join(staging, 'previous-config')))
  ) {
    throw new Error('导入恢复记录缺失；已保留旧副本，请勿手动删除。')
  }
  await rm(staging, { recursive: true, force: true })
}

/** 应在安装器创建数据目录、Runtime 启动和任何配置写入之前调用。 */
export async function recoverDshImport(mydshHome: string): Promise<void> {
  if (!isAbsolute(mydshHome)) throw new Error('MyDSH 目录必须是绝对路径。')
  for (const name of await entries(mydshHome)) {
    if (!/^\.import-[A-Za-z0-9]+$/u.test(name)) continue
    const staging = join(mydshHome, name)
    if (!(await lstat(staging)).isDirectory()) continue
    await recoverImportTransaction(mydshHome, staging)
  }
}

function mergeWorkspace(
  target: WorkspaceDocument | undefined,
  source: WorkspaceDocument | undefined,
  sessionIds: Set<string>,
): { document?: WorkspaceDocument; mapping: Record<string, string> } {
  if (!source) {
    if (target) {
      target.global.initialized = false
      return { document: target, mapping: {} }
    }
    return { mapping: {} }
  }
  const output: WorkspaceDocument = target ?? {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [], archivedSessionIds: [] },
    tables: { workspaces: Object.create(null) as Record<string, WorkspaceRecord> },
  }
  const mapping: Record<string, string> = Object.create(null) as Record<string, string>
  if (!source.global.initialized) output.global.initialized = false
  const owned = new Set(Object.values(output.tables.workspaces).flatMap(item => item.sessionIds))
  for (const id of source.global.workspaceIds) {
    const incoming = source.tables.workspaces[id]!
    const existing = Object.entries(output.tables.workspaces).find(
      ([, item]) => normalizeImportPath(item.path) === normalizeImportPath(incoming.path),
    )
    const destination = existing?.[0] ?? (output.tables.workspaces[id] ? randomUUID() : id)
    mapping[id] = destination
    const appended = incoming.sessionIds.filter(
      sessionId => sessionIds.has(sessionId) && !owned.has(sessionId),
    )
    for (const sessionId of appended) owned.add(sessionId)
    if (existing) existing[1].sessionIds.push(...appended)
    else {
      output.tables.workspaces[destination] = { ...incoming, sessionIds: appended }
      output.global.workspaceIds.push(destination)
    }
  }
  output.global.archivedSessionIds = [
    ...new Set([
      ...output.global.archivedSessionIds,
      ...source.global.archivedSessionIds.filter(id => sessionIds.has(id)),
    ]),
  ]
  return { document: output, mapping }
}

/**
 * 提交需要 Runtime 已停止。完整暂存 data 和 config，再以成功标记联合提交。
 * 不复制运行任务、插件、profile、锁文件或凭据；导入结果保持停止，用户之后显式恢复。
 */
export async function commitDshImport(
  options: DshImportOptions & { expectedFingerprint: string },
): Promise<DshImportResult> {
  const state = await snapshot(options)
  if (state.preview.fingerprint !== options.expectedFingerprint)
    throw new Error('来源数据在预览后发生变化，请重新预览。')
  if (state.preview.issues.some(issue => issue.severity === 'error'))
    throw new Error('来源数据存在阻止导入的问题，请查看预览报告。')
  await recoverDshImport(options.mydshHome)
  const home = resolve(options.mydshHome)
  await mkdir(home, { recursive: true, mode: 0o700 })
  const data = join(home, 'data')
  const config = join(home, 'config')
  const staging = await mkdtemp(join(home, '.import-'))
  const candidate = join(staging, 'candidate-data')
  const candidateConfig = join(staging, 'candidate-config')
  try {
    if (await exists(data)) await copyDirectory(data, candidate, options.signal)
    else await mkdir(candidate, { mode: 0o700 })
    if (await exists(config)) await copyDirectory(config, candidateConfig, options.signal)
    else await mkdir(candidateConfig, { mode: 0o700 })
    const ledgerBytes = await optionalFile(candidate, '.mydsh-imports.json')
    const ledger: ImportLedger = ledgerBytes
      ? (JSON.parse(ledgerBytes.toString('utf8')) as ImportLedger)
      : { version: 1, sources: {} }
    if (ledger.version !== 1 || !object(ledger.sources))
      throw new Error('MyDSH 导入记录格式不受支持。')
    const sourceId = sha256(normalizeImportPath(state.preview.sourceHome))
    const prior = ledger.sources[sourceId]
    const mappings = Object.assign(
      Object.create(null) as Record<string, { digest: string; targetId: string }>,
      prior?.sessions,
    )
    const result: DshImportResult = {
      importedSessions: 0,
      skippedSessions: 0,
      sessionMapping: Object.create(null) as Record<string, string>,
      projectMapping: {},
      issues: [...state.preview.issues],
    }
    for (const [id, session] of state.sessions) {
      options.signal?.throwIfAborted()
      const saved = mappings[id]
      if (saved) {
        if (saved.digest !== session.info.digest)
          throw new Error(`已导入的来源会话 ${id} 后来发生变化；请保留现有会话并单独处理冲突。`)
        result.skippedSessions++
        result.sessionMapping[id] = saved.targetId
        continue
      }
      const sessionDirectory = `sessions/${sessionProjectDirectoryKey(session.info.cwd)}/${sessionDirectorySegment(id)}`
      // ID 在整个会话根目录唯一，不能仅检查来源使用的项目目录。
      for (const project of await entries(join(candidate, 'sessions'))) {
        if (await exists(join(candidate, 'sessions', project, sessionDirectorySegment(id))))
          throw new Error(`MyDSH 已有同名会话 ${id}，导入不会覆盖或重新编号。`)
      }
      const filename = `session${session.info.generation ? `.v${session.info.generation}` : ''}.jsonl.zstd`
      await mkdir(join(candidate, sessionDirectory), { recursive: true, mode: 0o700 })
      const sourceBytes = await readSafe(state.preview.sourceHome, session.info.sourcePath)
      if (sha256(sourceBytes) !== state.files.get(session.info.sourcePath))
        throw new Error('来源会话在导入期间发生变化。')
      const plaintext = session.info.sourcePath.endsWith('.zstd')
        ? await decompress(sourceBytes, { maxOutputLength: MAX_LOG_BYTES })
        : sourceBytes
      // 头帧必须恰好一行；每行独立编码也保留源后端的多帧恢复边界。
      const encoded: Buffer[] = []
      for (const line of plaintext.toString('utf8').trimEnd().split('\n')) {
        options.signal?.throwIfAborted()
        encoded.push(
          await compress(`${line}\n`, { params: { [constants.ZSTD_c_checksumFlag]: 1 } }),
        )
      }
      await writeFile(join(candidate, sessionDirectory, filename), Buffer.concat(encoded), {
        mode: 0o600,
      })
      mappings[id] = { digest: session.info.digest, targetId: id }
      result.sessionMapping[id] = id
      result.importedSessions++
    }
    for (const path of state.attachments) {
      const expected = state.files.get(path)
      if (!expected || state.preview.issues.some(issue => issue.path === path)) continue
      const bytes = await readSafe(state.preview.sourceHome, path)
      if (sha256(bytes) !== expected) throw new Error('来源附件在导入期间发生变化。')
      const existing = await optionalFile(candidate, path)
      if (existing && sha256(existing) !== expected)
        throw new Error('MyDSH 中存在内容冲突的同名附件。')
      if (!existing) {
        await mkdir(dirname(join(candidate, path)), { recursive: true, mode: 0o700 })
        await writeFile(join(candidate, path), bytes, { mode: 0o600 })
      }
    }
    const workspaceBytes = await optionalFile(candidate, 'storages/workspace.json')
    const merged = mergeWorkspace(
      workspaceBytes ? workspaceDocument(workspaceBytes) : undefined,
      state.workspace,
      new Set(Object.values(result.sessionMapping)),
    )
    result.projectMapping = merged.mapping
    if (merged.document) {
      await mkdir(join(candidate, 'storages'), { recursive: true, mode: 0o700 })
      await writeFile(
        join(candidate, 'storages/workspace.json'),
        `${JSON.stringify(merged.document, null, 2)}\n`,
        { mode: 0o600 },
      )
    }
    const currentSettings = await optionalFile(candidateConfig, 'settings.yaml')
    const settings = currentSettings ? yamlObject(currentSettings) : {}
    for (const [namespace, value] of Object.entries(state.settings)) {
      if (Object.hasOwn(settings, namespace))
        result.issues.push({
          severity: 'warning',
          code: 'settings-existing',
          path: 'settings.yaml',
          message: `MyDSH 已有 ${namespace} 配置，已保留现有值。`,
        })
      else settings[namespace] = value
    }
    if (Object.keys(state.settings).length)
      await writeFile(join(candidateConfig, 'settings.yaml'), stringify(settings), { mode: 0o600 })
    ledger.sources[sourceId] = {
      sourceHome: state.preview.sourceHome,
      importedAt: new Date().toISOString(),
      sessions: mappings,
      projects: merged.mapping,
    }
    await writeFile(
      join(candidate, '.mydsh-imports.json'),
      `${JSON.stringify(ledger, null, 2)}\n`,
      {
        mode: 0o600,
      },
    )
    // 重新扫描也能发现新出现的 Session；只复核旧文件会漏掉并发新增记录。
    const latest = (await snapshot(options)).preview
    if (
      latest.fingerprint !== options.expectedFingerprint ||
      latest.issues.some(issue => issue.severity === 'error')
    )
      throw new Error('来源在导入期间发生变化，请停止来源 DSH 后重试。')
    options.signal?.throwIfAborted()
    const journal = { version: 1, hadData: await exists(data), hadConfig: await exists(config) }
    await writeFile(join(staging, 'transaction.json'), `${JSON.stringify(journal)}\n`, {
      mode: 0o600,
      flag: 'wx',
    })
    await writeFile(join(staging, 'commit-ready'), '', { mode: 0o600, flag: 'wx' })
    // 切换阶段不再响应取消：必须提交成功，或在 finally 中完整恢复两个目录。
    if (journal.hadData) await rename(data, join(staging, 'previous-data'))
    await rename(candidate, data)
    if (journal.hadConfig) await rename(config, join(staging, 'previous-config'))
    await rename(candidateConfig, config)
    await rename(join(staging, 'commit-ready'), join(staging, 'committed'))
    return result
  } finally {
    await recoverImportTransaction(home, staging)
  }
}

/**
 * 只允许主进程调用，并将选中的原文直接交给加密写入回调。
 * 返回值和错误均不携带凭据值；调用方不得通过普通 RPC 把此回调暴露给 Agent。
 */
export async function importDshCredentials(options: {
  sourceHome: string
  names: readonly string[]
  writeCredential: (entry: {
    name: string
    value: string | Record<string, unknown>
  }) => Promise<void>
}): Promise<string[]> {
  const source = await realpath(options.sourceHome)
  const bytes = await optionalFile(source, '.credentials.yaml')
  const available = bytes
    ? credentialEntries(bytes)
    : new Map<string, string | Record<string, unknown>>()
  const selected = [...new Set(options.names)]
  if (selected.some(name => !available.has(name))) throw new Error('所选凭据已不存在，请重新预览。')
  const imported: string[] = []
  for (const name of selected) {
    try {
      await options.writeCredential({ name, value: available.get(name)! })
    } catch {
      throw new Error('凭据文件写入失败；已停止后续导入。')
    }
    imported.push(name)
  }
  return imported
}
