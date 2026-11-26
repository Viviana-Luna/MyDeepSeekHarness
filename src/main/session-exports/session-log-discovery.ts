/**
 * 主进程只读扫描 MyDSH 会话日志，按头行定位目标及子会话，不访问 HTTP 或外部 DSH。
 * 头行读取拥有短生命周期的文件流和解压流；完成、失败或取消时等待两者关闭。
 * 日志正文不在这里校验，运行中导出只代表读取期间取得的字节快照。
 */
/* oxlint-disable no-await-in-loop -- 顺序扫描限制文件句柄数量，并在每份日志之间处理取消。 */
import { constants, type Dirent } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { finished, pipeline } from 'node:stream/promises'
import { createZstdDecompress } from 'node:zlib'
import {
  SESSION_LOG_GENERATION,
  sessionDirectorySegment,
  sessionProjectDirectoryKey,
} from '../../shared/session-paths.ts'
import { isRecord } from '../../shared/validation.ts'

const MAX_HEADER_BYTES = 1024 * 1024

/** 可导出的单份日志；归档路径保持 sessions/<项目>/<会话>/<文件> 布局。 */
export interface SessionLogEntry {
  readonly sessionId: string
  readonly archivePath: string
  readonly sourcePath: string
}

interface ScannedSession extends SessionLogEntry {
  readonly parentSession?: string
}

interface LogFile {
  name: string
  version: number
  compressed: boolean
}

interface ScanResult {
  sessions: Map<string, ScannedSession[]>
  issues: Map<string, 'no-log' | 'corrupt'>
}

/**
 * 读取前复核固定深度的日志路径，不跟随数据目录下的链接或特殊文件。
 * 保存对话框可能长时间停留，调用方须在复制前再次调用，不能只信任扫描结果。
 */
export async function assertSessionLogSource(sourcePath: string): Promise<void> {
  const session = dirname(sourcePath)
  const project = dirname(session)
  const sessions = dirname(project)
  for (const directory of [dirname(sessions), sessions, project, session]) {
    if (!(await lstat(directory)).isDirectory()) throw new Error('会话日志目录无效或包含符号链接')
  }
  if (!(await lstat(sourcePath)).isFile()) throw new Error('会话日志不是普通文件')
}

async function readHeaderLine(sourcePath: string, compressed: boolean, signal?: AbortSignal) {
  await assertSessionLogSource(sourcePath)
  const handle = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  const source = handle.createReadStream({ signal })
  const decoder = compressed ? createZstdDecompress() : undefined
  const stream = decoder ?? source
  const completion = decoder ? pipeline(source, decoder) : finished(source, { cleanup: true })
  // 首行返回会主动结束管道；先观察其拒绝，避免清理前出现未处理异常。
  void completion.catch(() => {})
  const chunks: Buffer[] = []
  let received = 0
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      signal?.throwIfAborted()
      const newline = chunk.indexOf(0x0a)
      const part = newline < 0 ? chunk : chunk.subarray(0, newline)
      received += part.length
      if (received > MAX_HEADER_BYTES) throw new Error('会话头行超过大小上限')
      chunks.push(part)
      if (newline >= 0)
        return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    }
    throw new Error('会话日志没有完整头行')
  } finally {
    source.destroy()
    stream.destroy()
    await completion.catch(() => {})
  }
}

function parseHeader(line: string, version: number) {
  const header: unknown = JSON.parse(line)
  if (
    !isRecord(header) ||
    header.type !== 'session' ||
    header.version !== version ||
    typeof header.id !== 'string' ||
    (header.cwd !== undefined && typeof header.cwd !== 'string') ||
    (header.parentSession !== undefined &&
      (typeof header.parentSession !== 'string' || header.parentSession.length === 0))
  )
    throw new Error('会话头行字段无效')
  return {
    sessionId: header.id,
    cwd: header.cwd,
    ...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }),
  }
}

function selectLogFile(entries: Dirent[]): LogFile | undefined {
  const candidates = entries
    .flatMap(entry => {
      const match = SESSION_LOG_GENERATION.exec(entry.name)
      if (!match) return []
      if (!entry.isFile()) throw new Error('会话日志不是普通文件')
      const version = Number(match[1] ?? 0)
      if (!Number.isSafeInteger(version)) throw new Error('会话日志版本无效')
      return [{ name: entry.name, version, compressed: match[2] !== undefined }]
    })
    .toSorted((left, right) => right.version - left.version)
  if (candidates.some(item => item.compressed !== candidates[0]?.compressed))
    throw new Error('会话日志混用了 JSONL 和 Zstandard 编码')
  return candidates[0]
}

async function scanSession(
  path: { dataRoot: string; project: string; session: string },
  result: ScanResult,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted()
  const directory = join(path.dataRoot, 'sessions', path.project, path.session)
  let scanned: ScannedSession
  try {
    const selected = selectLogFile(await readdir(directory, { withFileTypes: true }))
    if (!selected) {
      result.issues.set(path.session, 'no-log')
      return
    }
    const sourcePath = join(directory, selected.name)
    const { cwd, ...header } = parseHeader(
      await readHeaderLine(sourcePath, selected.compressed, signal),
      selected.version,
    )
    // 归档使用头行推导的拼写，以便在区分大小写的文件系统上也能按头行找到日志。
    const archivePath = `sessions/${sessionProjectDirectoryKey(cwd)}/${sessionDirectorySegment(header.sessionId)}/${selected.name}`
    const expectedPath = join(path.dataRoot, archivePath)
    if (sourcePath !== expectedPath) {
      // 与持久化层一致，只接受指向同一文件的大小写别名，并继续拒绝符号链接。
      await assertSessionLogSource(expectedPath)
      const [actual, expected] = await Promise.all([realpath(sourcePath), realpath(expectedPath)])
      if (actual !== expected) throw new Error('会话头行与物理目录不一致')
    }
    scanned = { ...header, sourcePath, archivePath }
  } catch {
    signal?.throwIfAborted()
    result.issues.set(path.session, 'corrupt')
    return
  }
  const matches = result.sessions.get(scanned.sessionId)
  if (matches) matches.push(scanned)
  else result.sessions.set(scanned.sessionId, [scanned])
}

async function scanSessionDirectories(dataRoot: string, signal?: AbortSignal): Promise<ScanResult> {
  signal?.throwIfAborted()
  const result: ScanResult = { sessions: new Map(), issues: new Map() }
  const root = join(dataRoot, 'sessions')
  let projects: Dirent[]
  try {
    if (!(await lstat(root)).isDirectory()) throw new Error('会话根目录无效或包含符号链接')
    projects = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result
    throw new Error('无法读取会话日志目录，请检查目录权限', { cause: error })
  }
  for (const project of projects.toSorted((left, right) => left.name.localeCompare(right.name))) {
    signal?.throwIfAborted()
    if (!project.isDirectory()) continue
    const sessions = await readdir(join(root, project.name), { withFileTypes: true })
    for (const session of sessions.toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (!session.isDirectory()) continue
      await scanSession({ dataRoot, project: project.name, session: session.name }, result, signal)
    }
  }
  return result
}

function assertScannedSession(result: ScanResult, sessionId: string): ScannedSession {
  const matches = result.sessions.get(sessionId)
  if (matches?.length === 1) return matches[0]!
  if (matches) throw new Error('要导出的会话存在重复 ID，无法确定日志来源')
  const issue = result.issues.get(sessionDirectorySegment(sessionId))
  if (issue === 'corrupt') throw new Error('要导出的会话日志已损坏，无法导出')
  if (issue === 'no-log') throw new Error('要导出的会话还没有可导出的日志')
  throw new Error('要导出的会话已不存在')
}

/**
 * 收集目标及 parentSession 关联的全部可识别子会话，返回广度优先、同层按 ID 排序的日志。
 * 只校验头行，不修改或截断源文件；无关损坏日志不阻断扫描，重复的目标或子会话 ID 会拒绝导出。
 */
export async function collectSessionLogsForExport(
  dataRoot: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionLogEntry[]> {
  const result = await scanSessionDirectories(dataRoot, signal)
  const target = assertScannedSession(result, sessionId)
  const children = new Map<string, string[]>()
  for (const matches of result.sessions.values()) {
    // 重复 ID 的日志可能各自属于不同父会话，每个相关父会话都必须拒绝导出。
    for (const session of matches) {
      if (session.parentSession === undefined) continue
      const list = children.get(session.parentSession) ?? []
      list.push(session.sessionId)
      children.set(session.parentSession, list)
    }
  }
  const ordered = [target]
  const seen = new Set([target.sessionId])
  for (let index = 0; index < ordered.length; index += 1) {
    signal?.throwIfAborted()
    for (const childId of (children.get(ordered[index]!.sessionId) ?? []).toSorted()) {
      if (seen.has(childId)) continue
      seen.add(childId)
      ordered.push(assertScannedSession(result, childId))
    }
  }
  return ordered.map(entry => ({
    sessionId: entry.sessionId,
    sourcePath: entry.sourcePath,
    archivePath: entry.archivePath,
  }))
}
