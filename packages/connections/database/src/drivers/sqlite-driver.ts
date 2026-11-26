/** SQLite 驱动：在独立隔离子进程中执行 node:sqlite，支持 20 秒超时与 AbortSignal 立即 SIGKILL 中断。 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { DatabaseBatchMutationResult, DatabaseProfile, DatabaseResult } from '../../types.d.ts'
import { DATABASE_LIMITS, type DatabaseBatchMutationExecutionItem } from './shared.ts'
import { validateSqliteFilePath } from './sqlite-path.ts'

interface WorkerEnvelope<T> {
  readonly ok: boolean
  readonly value?: T
  readonly message?: string
}

const WORKER_SCRIPT_URL = new URL(
  import.meta.url.endsWith('.ts') ? '../../lib/drivers/sqlite-worker.js' : './sqlite-worker.js',
  import.meta.url,
)
const WORKER_SCRIPT_PATH = fileURLToPath(WORKER_SCRIPT_URL)

function buildSqliteSubprocessEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(process.env.MYDSH_NODE_EXECUTABLE || process.versions.electron
      ? { ELECTRON_RUN_AS_NODE: '1' }
      : {}),
  }
}

function parseWorkerStdout<T>(rawStdout: string, stderrText: string, exitCode: number | null): T {
  const trimmed = rawStdout.trim()
  if (!trimmed) {
    const detail = stderrText.trim()
    throw new Error(
      detail
        ? `SQLite 执行失败（退出码 ${exitCode ?? '未知'}）：${detail}`
        : `SQLite 子进程意外退出（退出码 ${exitCode ?? '未知'}）`,
    )
  }
  const envelope = JSON.parse(trimmed) as WorkerEnvelope<T>
  if (envelope.ok && envelope.value !== undefined) return envelope.value
  throw new Error(envelope.message ?? 'SQLite 执行失败')
}

function runSqliteWorker<T>(workerData: Record<string, unknown>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  const executable = process.env.MYDSH_NODE_EXECUTABLE ?? process.execPath
  return new Promise<T>((resolve, reject) => {
    const child = spawn(executable, [WORKER_SCRIPT_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: buildSqliteSubprocessEnv(),
    })
    let settled = false
    const stdoutChunks: Buffer[] = []
    let stdoutBytes = 0
    const stderrChunks: Buffer[] = []
    let stderrBytes = 0

    const cleanup = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }

    const failNow = (error: unknown, killChild = false) => {
      if (settled) return
      settled = true
      cleanup()
      if (killChild && !child.killed) {
        try {
          child.kill('SIGKILL')
        } catch {
          // 子进程已退出时忽略终止异常。
        }
      }
      reject(error instanceof Error ? error : new Error(String(error)))
    }

    const onAbort = () => {
      failNow(signal.reason ?? new Error('数据库操作已取消'), true)
    }

    const timer = setTimeout(() => {
      failNow(new Error('数据库操作超过 20 秒，已终止本地 SQLite 查询'), true)
    }, DATABASE_LIMITS.timeoutMs)

    signal.addEventListener('abort', onAbort, { once: true })
    child.stdin.on('error', () => {})
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > DATABASE_LIMITS.wireBytes) {
        failNow(new Error('数据库返回数据超过 8 MiB，已停止读取'), true)
        return
      }
      stdoutChunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (settled || stderrBytes >= 8192) return
      const slice = chunk.subarray(0, 8192 - stderrBytes)
      stderrChunks.push(slice)
      stderrBytes += slice.byteLength
    })
    child.once('error', error => failNow(error, true))
    child.once('close', code => {
      if (settled) return
      settled = true
      cleanup()
      try {
        const stdoutText = Buffer.concat(stdoutChunks).toString('utf8')
        const stderrText = Buffer.concat(stderrChunks).toString('utf8')
        resolve(parseWorkerStdout<T>(stdoutText, stderrText, code))
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    child.stdin.end(JSON.stringify(workerData))
  })
}

/** 在只读工作线程中执行单条 SQLite 查询并返回有界结果。 */
export async function readSqliteDatabase(input: {
  profile: DatabaseProfile
  sql: string
  values: unknown[]
  limit: number
  signal: AbortSignal
}): Promise<DatabaseResult> {
  const filePath = await validateSqliteFilePath(input.profile.filePath, { writable: false })
  return runSqliteWorker<DatabaseResult>(
    {
      mode: 'read',
      filePath,
      sql: input.sql,
      values: input.values,
      limit: input.limit,
      cellBytes: DATABASE_LIMITS.cellBytes,
      resultBytes: DATABASE_LIMITS.resultBytes,
    },
    input.signal,
  )
}

/** 在单一只读 SQLite 快照连接中顺序执行多条查询。 */
export async function readSqliteDatabaseBatch(input: {
  profile: DatabaseProfile
  queries: readonly string[]
  limitPerQuery: number
  signal: AbortSignal
}): Promise<DatabaseResult[]> {
  const filePath = await validateSqliteFilePath(input.profile.filePath, { writable: false })
  return runSqliteWorker<DatabaseResult[]>(
    {
      mode: 'readBatch',
      filePath,
      queries: [...input.queries],
      limitPerQuery: input.limitPerQuery,
      cellBytes: DATABASE_LIMITS.cellBytes,
      resultBytes: DATABASE_LIMITS.resultBytes,
    },
    input.signal,
  )
}

/** 在写锁事务内执行批量 SQLite DML/DDL 语句并在失败时整体回滚。 */
export async function executeSqliteDatabaseBatch(input: {
  profile: DatabaseProfile
  statements: readonly DatabaseBatchMutationExecutionItem[]
  signal: AbortSignal
}): Promise<DatabaseBatchMutationResult> {
  const filePath = await validateSqliteFilePath(input.profile.filePath, { writable: true })
  return runSqliteWorker<DatabaseBatchMutationResult>(
    {
      mode: 'executeBatch',
      filePath,
      statements: input.statements.map(item => ({ ...item })),
    },
    input.signal,
  )
}
