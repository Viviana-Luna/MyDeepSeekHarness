/**
 * 会话日志导出:在主进程内把 MyDSH 数据目录中的会话日志打包成 ZIP。
 * 目标会话与子会话由 session-log-discovery 从磁盘定位,内容经 zip-writer 流式写入
 * 用户通过原生对话框选择的路径;失败或取消时删除 .part,不留下半成品。
 * 导出是尽力快照:运行中的会话尾部可能处于写入中间态,这里只依赖头行校验,不逐行验证。
 */
/* eslint-disable no-await-in-loop -- 条目按顺序写入,失败清理与原子改名依赖先后关系。 */
import { renameWithRetry as rename } from '../../runtime/filesystem/file-operations.ts'
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { realpath, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { assertSessionLogSource, collectSessionLogsForExport } from './session-log-discovery.ts'
import { SessionLogZipWriter } from './zip-writer.ts'

const SESSION_ID_MAX_LENGTH = 512
const SESSION_LOG_EXPORT_TIMEOUT_MS = 15 * 60 * 1_000
const SESSION_LOG_EXPORT_MAX_BYTES = 2 * 1024 * 1024 * 1024
const SESSION_LOG_EXPORT_NAME = 'MyDSH-会话日志.zip'

/** 导出对话框取消或 ZIP 已保存的结果；不向 renderer 暴露目标绝对路径。 */
export type DesktopSessionLogExportResult =
  { status: 'cancelled' } | { status: 'saved'; fileName: string }

/** 主进程注入的私有数据根、受限会话标识、原生保存对话框和生命周期信号。 */
export interface SaveSessionLogOptions {
  /** MyDSH 数据目录(通常是 ~/.mydsh/data);导出只读取其下的 sessions 结构。 */
  dataRoot: string
  sessionId: unknown
  chooseDestination(suggestedName: string): Promise<string | null>
  signal?: AbortSignal
}

/** 这类前缀的错误已面向用户,失败清理后原样上抛,不再包一层含混的提示。 */
const USER_FACING_ERROR_PREFIXES = ['要导出的会话', '会话日志导出超过']

function parseSessionId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > SESSION_ID_MAX_LENGTH ||
    Array.from(value).some(character => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 0x1f || codePoint === 0x7f
    })
  ) {
    throw new Error('会话日志导出缺少有效的 Session ID')
  }
  return value
}

/** 按规范路径检查父目录，连通过目录别名覆盖原数据的情况也一并拒绝。 */
async function assertExportDestination(dataRoot: string, destination: string): Promise<void> {
  let part: string
  try {
    part = relative(await realpath(dataRoot), await realpath(dirname(destination)))
  } catch (error) {
    throw new Error('会话日志导出失败，请检查目标目录权限和可用空间', { cause: error })
  }
  if (part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)))
    throw new Error('会话日志导出不能覆盖原始日志或数据目录中的文件')
}

function exportSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(SESSION_LOG_EXPORT_TIMEOUT_MS)
  return signal === undefined ? timeout : AbortSignal.any([timeout, signal])
}

async function chooseExportDestination(
  choose: SaveSessionLogOptions['chooseDestination'],
  signal: AbortSignal,
): Promise<string | null> {
  signal.throwIfAborted()
  const cancelled = Promise.withResolvers<never>()
  const abort = () => cancelled.reject(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  try {
    // 原生对话框可能仍未返回。取消只结束选路径的等待，迟到的路径不能进入写入阶段。
    const selection = Promise.resolve().then(() => {
      signal.throwIfAborted()
      return choose(SESSION_LOG_EXPORT_NAME)
    })
    return await Promise.race([selection, cancelled.promise])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

/**
 * 从 MyDSH 数据目录导出一份会话日志 ZIP,条目包含目标会话及其全部子会话。
 * 先定位并校验会话再弹出保存对话框,避免用户选完路径才得知会话不可导出;
 * 成功以原子重命名落盘,失败或取消时不留下最终文件。
 * @throws 会话不存在、日志损坏、超过 2 GB 上限或目标路径无效时抛出,错误信息面向用户。
 */
export async function saveSessionLog(
  options: SaveSessionLogOptions,
): Promise<DesktopSessionLogExportResult> {
  const sessionId = parseSessionId(options.sessionId)
  const signal = exportSignal(options.signal)
  const entries = await collectSessionLogsForExport(options.dataRoot, sessionId, signal)

  const destination = await chooseExportDestination(options.chooseDestination, signal)
  signal.throwIfAborted()
  if (destination === null) return { status: 'cancelled' }
  if (!isAbsolute(destination)) throw new Error('会话日志导出目标路径无效')
  await assertExportDestination(options.dataRoot, destination)
  signal.throwIfAborted()

  const partial = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.part`)
  const stream = createWriteStream(partial, { flags: 'wx', mode: 0o600, signal })
  const writer = new SessionLogZipWriter(stream, { maxBytes: SESSION_LOG_EXPORT_MAX_BYTES })
  try {
    for (const entry of entries) {
      signal.throwIfAborted()
      await assertSessionLogSource(entry.sourcePath)
      await writer.addEntry(entry.archivePath, entry.sourcePath, signal)
    }
    await writer.finish()
    signal.throwIfAborted()
    await rename(partial, destination)
    return { status: 'saved', fileName: basename(destination) }
  } catch (error) {
    await writer.dispose()
    await rm(partial, { force: true })
    if (signal.aborted) throw new Error('会话日志导出已取消或超时', { cause: error })
    if (
      error instanceof Error &&
      USER_FACING_ERROR_PREFIXES.some(prefix => error.message.startsWith(prefix))
    )
      throw error
    throw new Error('会话日志导出失败，请检查目标目录权限和可用空间', {
      cause: error,
    })
  } finally {
    await writer.dispose()
  }
}
