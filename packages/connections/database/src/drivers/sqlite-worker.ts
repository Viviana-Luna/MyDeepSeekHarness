/** SQLite 独立子进程入口：通过 stdin/stdout 与 node:sqlite 执行有界只读查询与事务化变更，支持 SIGKILL 即时终止。 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type {
  DatabaseBatchMutationResult,
  DatabaseMutationResultItem,
  DatabaseResult,
} from '../../types.d.ts'
import type { DatabaseBatchMutationExecutionItem } from './shared.ts'

interface SqliteReadTask {
  readonly mode: 'read'
  readonly filePath: string
  readonly sql: string
  readonly values: unknown[]
  readonly limit: number
  readonly cellBytes: number
  readonly resultBytes: number
}

interface SqliteReadBatchTask {
  readonly mode: 'readBatch'
  readonly filePath: string
  readonly queries: readonly string[]
  readonly limitPerQuery: number
  readonly cellBytes: number
  readonly resultBytes: number
}

interface SqliteExecuteBatchTask {
  readonly mode: 'executeBatch'
  readonly filePath: string
  readonly statements: readonly DatabaseBatchMutationExecutionItem[]
}

type SqliteWorkerTask = SqliteReadTask | SqliteReadBatchTask | SqliteExecuteBatchTask

function encodeSqliteCell(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`
  return String(value)
}

function toInputValues(values: readonly unknown[]): SQLInputValue[] {
  return values.map((value): SQLInputValue => {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      value instanceof Uint8Array
    ) {
      return value
    }
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    }
    if (typeof value === 'boolean') return value ? 1 : 0
    return String(value)
  })
}

function runSingleSqliteRead(
  db: DatabaseSync,
  input: {
    sql: string
    values: readonly unknown[]
    limit: number
    byteBudget: number
    cellBytes: number
  },
): DatabaseResult {
  const started = performance.now()
  const statement = db.prepare(input.sql)
  statement.setReadBigInts(true)
  statement.setReturnArrays(true)
  const columns = statement.columns().map(col => ({
    name: col.name,
    type: col.type ?? '',
  }))
  let bytes = 128 + Buffer.byteLength(JSON.stringify(columns))
  if (columns.length > 512 || bytes > input.byteBudget) {
    throw new Error('查询列数或列名超过显示上限')
  }
  const rows: (string | null)[][] = []
  let truncated = false
  const iterator = statement.iterate(...toInputValues(input.values))
  for (const raw of iterator) {
    if (!Array.isArray(raw)) throw new Error('SQLite 没有返回数组格式读取结果')
    const row = raw.map(encodeSqliteCell)
    if (row.some(value => value !== null && Buffer.byteLength(value) > input.cellBytes)) {
      throw new Error('单个数据库值超过 256 KiB，已停止读取')
    }
    const size = Buffer.byteLength(JSON.stringify(row)) + 1
    if (rows.length >= input.limit || bytes + size > input.byteBudget) {
      truncated = true
      break
    }
    rows.push(row)
    bytes += size
  }
  return {
    columns,
    rows,
    rowCount: rows.length,
    bytes,
    truncated,
    elapsedMs: Math.round(performance.now() - started),
  }
}

function runReadTask(task: SqliteReadTask): DatabaseResult {
  const db = new DatabaseSync(task.filePath, {
    readOnly: true,
    allowExtension: false,
    timeout: 5_000,
    readBigInts: true,
    returnArrays: true,
    enableDoubleQuotedStringLiterals: false,
  })
  try {
    db.exec('PRAGMA query_only = ON;')
    return runSingleSqliteRead(db, {
      sql: task.sql,
      values: task.values,
      limit: task.limit,
      byteBudget: task.resultBytes,
      cellBytes: task.cellBytes,
    })
  } finally {
    if (db.isOpen) db.close()
  }
}

function runReadBatchTask(task: SqliteReadBatchTask): DatabaseResult[] {
  const db = new DatabaseSync(task.filePath, {
    readOnly: true,
    allowExtension: false,
    timeout: 5_000,
    readBigInts: true,
    returnArrays: true,
    enableDoubleQuotedStringLiterals: false,
  })
  try {
    db.exec('PRAGMA query_only = ON;')
    const results: DatabaseResult[] = []
    let remainingBytes = task.resultBytes
    for (const sql of task.queries) {
      const budget = Math.max(4096, remainingBytes)
      const result = runSingleSqliteRead(db, {
        sql,
        values: [],
        limit: task.limitPerQuery,
        byteBudget: budget,
        cellBytes: task.cellBytes,
      })
      results.push(result)
      remainingBytes = Math.max(0, remainingBytes - result.bytes)
    }
    return results
  } finally {
    if (db.isOpen) db.close()
  }
}

function runExecuteBatchTask(task: SqliteExecuteBatchTask): DatabaseBatchMutationResult {
  const started = performance.now()
  const hasDdl = task.statements.some(item => item.operation === 'ddl')
  const db = new DatabaseSync(task.filePath, {
    readOnly: false,
    allowExtension: false,
    timeout: 5_000,
    readBigInts: true,
    returnArrays: true,
    enableDoubleQuotedStringLiterals: false,
  })
  const results: DatabaseMutationResultItem[] = []
  let totalAffectedRows = 0
  try {
    db.exec('BEGIN IMMEDIATE;')
    for (const [index, item] of task.statements.entries()) {
      const statement = db.prepare(item.sql)
      const outcome = statement.run()
      const affectedRows = Number(outcome.changes ?? 0)
      totalAffectedRows += affectedRows
      const insertId =
        item.operation === 'insert' &&
        affectedRows > 0 &&
        outcome.lastInsertRowid !== undefined &&
        outcome.lastInsertRowid !== 0n
          ? String(outcome.lastInsertRowid)
          : null
      results.push({
        index,
        ...item,
        affectedRows,
        changedRows: item.operation === 'update' ? affectedRows : 0,
        insertId,
      })
    }
    db.exec('COMMIT;')
    return {
      results,
      totalAffectedRows,
      rolledBack: false,
      hasDdl,
      elapsedMs: Math.round(performance.now() - started),
    }
  } catch (error) {
    let rolledBack = true
    try {
      if (db.isTransaction) db.exec('ROLLBACK;')
    } catch {
      rolledBack = false
    }
    const detail = error instanceof Error ? error.message : 'SQLite 变更失败'
    const failedIndex = results.length + 1
    throw new Error(
      rolledBack
        ? `第 ${failedIndex} 条语句执行失败，已自动回滚整个批次：${detail}`
        : `第 ${failedIndex} 条语句执行失败，且无法确认回滚：${detail}`,
    )
  } finally {
    if (db.isOpen) db.close()
  }
}

function executeTask(task: SqliteWorkerTask): unknown {
  if (task.mode === 'read') return runReadTask(task)
  if (task.mode === 'readBatch') return runReadBatchTask(task)
  return runExecuteBatchTask(task)
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer))
  }
  return Buffer.concat(chunks).toString('utf8')
}

function writeStdout(payload: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(payload)}\n`, error => {
      if (error) reject(error)
      else resolve()
    })
  })
}

async function runWorkerMain(): Promise<void> {
  try {
    const raw = await readStdin()
    if (!raw.trim()) throw new Error('SQLite 子进程未收到执行任务参数')
    const task = JSON.parse(raw) as SqliteWorkerTask
    const value = executeTask(task)
    await writeStdout({ ok: true, value })
  } catch (error) {
    await writeStdout({
      ok: false,
      message: error instanceof Error ? error.message : 'SQLite 执行失败',
    })
  }
}

void runWorkerMain()
