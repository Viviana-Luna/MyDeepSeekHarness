/** MySQL 与 MariaDB 驱动实现：复用 mysql2 线协议、严格 TLS 身份校验、只读事务、KILL QUERY 取消与批量变更。 */
import { isIP } from 'node:net'
import { Duplex } from 'node:stream'
import { checkServerIdentity, TLSSocket } from 'node:tls'
import mysql from 'mysql2'
import type { Connection, FieldPacket, Query } from 'mysql2'
import type {
  DatabaseBatchMutationResult,
  DatabaseMutationResultItem,
  DatabaseProfile,
  DatabaseResult,
} from '../../types.d.ts'
import {
  DATABASE_LIMITS,
  encodeCell,
  wrapLimitedWireStream,
  type DatabaseBatchMutationExecutionItem,
  type OpenSocket,
} from './shared.ts'

/** 已完成 TLS 校验与身份认证的 MySQL/MariaDB 连接句柄。 */
export interface DatabaseConnection {
  connection: Connection
  close(): Promise<void>
}

const exactTypes = new Set([
  'DECIMAL',
  'NEWDECIMAL',
  'TINY',
  'SHORT',
  'LONG',
  'LONGLONG',
  'INT24',
  'FLOAT',
  'DOUBLE',
  'YEAR',
  'DATE',
  'NEWDATE',
  'DATETIME',
  'DATETIME2',
  'TIMESTAMP',
  'TIMESTAMP2',
  'TIME',
  'TIME2',
])

const typeNames = new Map<number, string>(
  Object.entries(mysql.Types)
    .filter(([, value]) => typeof value === 'number')
    .map(([name, value]) => [Number(value), name]),
)

function enforceTlsIdentity(connection: Connection, identity: string): void {
  // mysql2 默认不以 IP host 校验证书 SAN；在 TLS 握手回调内强制执行证书与主机身份比对。
  const tls = connection as Connection & {
    stream: Duplex
    startTLS(onSecure: (error?: Error) => void): void
  }
  const startTLS = tls.startTLS.bind(tls)
  tls.startTLS = onSecure =>
    startTLS(error => {
      if (error) {
        onSecure(error)
        return
      }
      if (!(tls.stream instanceof TLSSocket)) {
        onSecure(new Error('数据库没有建立可校验的 TLS 连接'))
        return
      }
      onSecure(checkServerIdentity(identity, tls.stream.getPeerCertificate(true)))
    })
}

function createMysqlConnection(
  profile: DatabaseProfile,
  password: string,
  stream: Duplex,
): Connection {
  const tlsEnabled = profile.tlsEnabled !== false
  const identity = profile.tlsServerName || profile.host
  const connection = mysql.createConnection({
    host: identity,
    port: profile.port,
    stream,
    user: profile.username,
    password,
    ...(profile.database ? { database: profile.database } : {}),
    ...(tlsEnabled
      ? {
          ssl: {
            ...(profile.tlsCa ? { ca: profile.tlsCa } : {}),
            rejectUnauthorized: true,
            verifyIdentity: !isIP(identity),
            minVersion: 'TLSv1.2' as const,
          },
        }
      : {}),
    connectTimeout: 10_000,
    multipleStatements: false,
    flags: ['-LOCAL_FILES'],
    rowsAsArray: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    dateStrings: true,
    jsonStrings: true,
    typeCast(field, next) {
      if (exactTypes.has(field.type)) return field.string()
      if (field.type === 'JSON') return field.string('utf8')
      if (['GEOMETRY', 'VECTOR', 'BIT'].includes(field.type)) return field.buffer()
      return next()
    },
  })
  if (tlsEnabled) enforceTlsIdentity(connection, identity)
  connection.on('error', () => {})
  return connection
}

/** 建立并认证受 8 MiB 入站限制保护的 MySQL / MariaDB 连接。 */
export async function openMysqlDatabase(
  profile: DatabaseProfile,
  password: string,
  socket: OpenSocket,
  signal: AbortSignal,
): Promise<DatabaseConnection> {
  signal.throwIfAborted()
  const owned = await socket(signal)
  const limited = wrapLimitedWireStream(owned)
  const connection = createMysqlConnection(profile, password, limited.stream)
  let closed: Promise<void> | undefined
  const close = () =>
    (closed ??= (async () => {
      connection.destroy()
      await limited.destroyAll()
    })())
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        void close()
        reject(signal.reason)
      }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      else
        connection.connect(error => {
          signal.removeEventListener('abort', abort)
          error ? reject(error) : resolve()
        })
    })
    signal.throwIfAborted()
    return { connection, close }
  } catch (error) {
    await close()
    throw error
  }
}

interface QueryCancelTracker {
  attach(query: Query): void
  stop(): Promise<void>
}

function createQueryCancelTracker(
  profile: DatabaseProfile,
  password: string,
  socket: OpenSocket,
  connection: Connection,
): QueryCancelTracker {
  let activeQuery: Query | undefined
  let completed = false
  let uncertain = false
  let cancellationAttempted = false
  let queryDone: Promise<void> | undefined

  const attach = (query: Query): void => {
    activeQuery = query
    completed = false
    uncertain = false
    cancellationAttempted = false
    queryDone = new Promise<void>(done => {
      query.once('end', () => {
        completed = true
        done()
      })
      query.once('error', (error: { errno?: number }) => {
        uncertain = !Number.isInteger(error.errno)
        completed = true
        done()
      })
    })
  }

  const stop = async (): Promise<void> => {
    if (cancellationAttempted || !activeQuery || (completed && !uncertain)) return
    cancellationAttempted = true
    let control: DatabaseConnection | undefined
    try {
      const cancellation = AbortSignal.timeout(DATABASE_LIMITS.cancelMs)
      // 控制连接仅用于执行 KILL QUERY 与查 PROCESSLIST，不绑定默认库以免失效默认库阻断取消。
      control = await openMysqlDatabase(
        { ...profile, database: null },
        password,
        socket,
        cancellation,
      )
      if (!Number.isSafeInteger(connection.threadId)) throw new Error('数据库线程身份不可用')
      await control.connection
        .promise()
        .query({ sql: `KILL QUERY ${connection.threadId}`, timeout: DATABASE_LIMITS.cancelMs })
      await Promise.race([
        queryDone,
        new Promise<never>((_resolve, reject) => {
          const fail = () => reject(new Error('查询结束未确认'))
          if (cancellation.aborted) fail()
          else cancellation.addEventListener('abort', fail, { once: true })
        }),
      ])
      // 网络中断不等同于服务端结束；使用同账号控制连接核实本次线程不再执行语句。
      if (uncertain) {
        const [rows] = await control.connection.promise().execute({
          sql: 'SELECT ID FROM information_schema.PROCESSLIST WHERE ID = ? AND COMMAND = ?',
          values: [connection.threadId, 'Query'],
          typeCast: (_field, next) => next(),
          timeout: DATABASE_LIMITS.cancelMs,
        })
        if (!Array.isArray(rows) || rows.length) throw new Error('远端语句仍在执行')
        uncertain = false
      }
    } catch {
      if (!completed || uncertain)
        throw new Error('已关闭本地数据库连接，但未确认取消完成，远端执行状态未知')
    } finally {
      await control?.close()
    }
  }

  return { attach, stop }
}

/** 为 MySQL/MariaDB 只读查询设置会话级超时；遇到另一方引擎变量报错（1193）时自动回退切换。 */
export async function applyMysqlReadTimeout(
  connection: Connection,
  profile: DatabaseProfile,
): Promise<void> {
  // MariaDB 使用单位为秒的 max_statement_time，MySQL 8 使用毫秒级 max_execution_time；遇到未知系统变量时自动切换回退，避免误选引擎直接失败。
  const seconds = Math.max(1, DATABASE_LIMITS.timeoutMs / 1000)
  const mariadbSql = `SET SESSION max_statement_time = ${seconds}`
  const mysqlSql = `SET SESSION max_execution_time = ${DATABASE_LIMITS.timeoutMs}`
  const [primarySql, fallbackSql] =
    profile.engine === 'mariadb' ? [mariadbSql, mysqlSql] : [mysqlSql, mariadbSql]
  try {
    await connection.promise().query({ sql: primarySql, timeout: 5000 })
  } catch (error) {
    if ((error as { errno?: number })?.errno !== 1193) throw error
    try {
      await connection.promise().query({ sql: fallbackSql, timeout: 5000 })
    } catch (fallbackError) {
      if ((fallbackError as { errno?: number })?.errno !== 1193) throw fallbackError
    }
  }
}

function dispatchSelectQuery(connection: Connection, sql: string, values: unknown[]): Query {
  return values.length
    ? connection.execute({
        sql,
        values,
        rowsAsArray: true,
        typeCast: (field, next) =>
          ['GEOMETRY', 'VECTOR', 'BIT'].includes(field.type) ? field.buffer() : next(),
      })
    : connection.query({ sql, rowsAsArray: true })
}

async function runSingleReadQuery(
  connection: Connection,
  tracker: QueryCancelTracker,
  input: {
    sql: string
    values: unknown[]
    limit: number
    byteBudget: number
    signal: AbortSignal
  },
): Promise<DatabaseResult> {
  const started = performance.now()
  const rows: (string | null)[][] = []
  const columns: DatabaseResult['columns'] = []
  let bytes = 128
  let truncated = false
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      input.signal.removeEventListener('abort', abort)
      error ? reject(error) : resolve()
    }
    const abort = () => finish(input.signal.reason ?? new Error('数据库查询已取消'))
    input.signal.addEventListener('abort', abort, { once: true })
    if (input.signal.aborted) {
      abort()
      return
    }
    const query = dispatchSelectQuery(connection, input.sql, input.values)
    tracker.attach(query)
    query.on('fields', (fields: FieldPacket[]) => {
      if (settled) return
      columns.push(
        ...fields.map(field => ({
          name: field.name,
          type: typeNames.get(field.columnType ?? field.type ?? 0) ?? 'UNKNOWN',
        })),
      )
      bytes += Buffer.byteLength(JSON.stringify(columns))
      if (columns.length > 512 || bytes > input.byteBudget)
        finish(new Error('查询列数或列名超过显示上限'))
    })
    query.on('result', (raw: unknown[]) => {
      if (settled) return
      try {
        if (!Array.isArray(raw)) throw new Error('数据库没有返回读取结果')
        const row = raw.map(encodeCell)
        if (
          row.some(value => value !== null && Buffer.byteLength(value) > DATABASE_LIMITS.cellBytes)
        )
          throw new Error('单个数据库值超过 256 KiB，已停止读取')
        const size = Buffer.byteLength(JSON.stringify(row)) + 1
        if (rows.length >= input.limit || bytes + size > input.byteBudget) {
          truncated = true
          finish()
          return
        }
        rows.push(row)
        bytes += size
      } catch (error) {
        finish(error)
      }
    })
    query.once('error', finish)
    query.once('end', () => finish())
  })
  await tracker.stop()
  input.signal.throwIfAborted()
  return {
    columns,
    rows,
    rowCount: rows.length,
    bytes,
    truncated,
    elapsedMs: Math.round(performance.now() - started),
  }
}

/** 在 MySQL/MariaDB 只读事务内执行单条有界只读查询。 */
export async function readMysqlDatabase(input: {
  profile: DatabaseProfile
  password: string
  socket: OpenSocket
  sql: string
  values: unknown[]
  limit: number
  signal: AbortSignal
}): Promise<DatabaseResult> {
  const { profile, password, socket, sql, values, limit, signal } = input
  const primary = await openMysqlDatabase(profile, password, socket, signal)
  const tracker = createQueryCancelTracker(profile, password, socket, primary.connection)
  try {
    signal.throwIfAborted()
    await applyMysqlReadTimeout(primary.connection, profile)
    await primary.connection.promise().query({ sql: 'START TRANSACTION READ ONLY', timeout: 5000 })
    signal.throwIfAborted()
    return await runSingleReadQuery(primary.connection, tracker, {
      sql,
      values,
      limit,
      byteBudget: DATABASE_LIMITS.resultBytes,
      signal,
    })
  } catch (error) {
    await tracker.stop()
    throw error
  } finally {
    await primary.close()
  }
}

/** 在单一 MySQL/MariaDB 只读事务中顺序执行多条查询并控制总字节预算。 */
export async function readMysqlDatabaseBatch(input: {
  profile: DatabaseProfile
  password: string
  socket: OpenSocket
  queries: readonly string[]
  limitPerQuery: number
  signal: AbortSignal
}): Promise<DatabaseResult[]> {
  const { profile, password, socket, queries, limitPerQuery, signal } = input
  const primary = await openMysqlDatabase(profile, password, socket, signal)
  const tracker = createQueryCancelTracker(profile, password, socket, primary.connection)
  try {
    signal.throwIfAborted()
    await applyMysqlReadTimeout(primary.connection, profile)
    await primary.connection.promise().query({ sql: 'START TRANSACTION READ ONLY', timeout: 5000 })
    const results: DatabaseResult[] = []
    let remainingBytes: number = DATABASE_LIMITS.resultBytes
    for (const sql of queries) {
      signal.throwIfAborted()
      const budget = Math.max(4096, remainingBytes)
      const result = await runSingleReadQuery(primary.connection, tracker, {
        sql,
        values: [],
        limit: limitPerQuery,
        byteBudget: budget,
        signal,
      })
      results.push(result)
      remainingBytes = Math.max(0, remainingBytes - result.bytes)
    }
    return results
  } catch (error) {
    await tracker.stop()
    throw error
  } finally {
    await primary.close()
  }
}

interface OkPacketLike {
  affectedRows?: number
  changedRows?: number
  insertId?: number | string | bigint
}

async function runSingleMutation(
  connection: Connection,
  tracker: QueryCancelTracker,
  sql: string,
  signal: AbortSignal,
): Promise<{ affectedRows: number; changedRows: number; insertId: string | null }> {
  let affectedRows = 0
  let changedRows = 0
  let insertId: string | null = null
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      error ? reject(error) : resolve()
    }
    const abort = () => finish(signal.reason ?? new Error('数据库变更已取消'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
      return
    }
    const query = connection.query({ sql })
    tracker.attach(query)
    query.on('result', (packet: unknown) => {
      if (settled || Array.isArray(packet) || typeof packet !== 'object' || packet === null) return
      const ok = packet as OkPacketLike
      affectedRows = Number(ok.affectedRows ?? 0)
      changedRows = Number(ok.changedRows ?? 0)
      if (ok.insertId !== undefined && ok.insertId !== 0 && String(ok.insertId) !== '0')
        insertId = String(ok.insertId)
    })
    query.once('error', finish)
    query.once('end', () => finish())
  })
  await tracker.stop()
  signal.throwIfAborted()
  return { affectedRows, changedRows, insertId }
}

async function rollbackQuietly(connection: Connection): Promise<boolean> {
  try {
    await connection.promise().query({ sql: 'ROLLBACK', timeout: 5000 })
    return true
  } catch {
    return false
  }
}

/** 顺序执行 MySQL/MariaDB 批量 DML/DDL 语句：纯 DML 自动回滚，含 DDL 时给出隐式提交提示。 */
export async function executeMysqlDatabaseBatch(input: {
  profile: DatabaseProfile
  password: string
  socket: OpenSocket
  statements: readonly DatabaseBatchMutationExecutionItem[]
  signal: AbortSignal
}): Promise<DatabaseBatchMutationResult> {
  const { profile, password, socket, statements, signal } = input
  const started = performance.now()
  const hasDdl = statements.some(item => item.operation === 'ddl')
  const primary = await openMysqlDatabase(profile, password, socket, signal)
  const tracker = createQueryCancelTracker(profile, password, socket, primary.connection)
  const results: DatabaseMutationResultItem[] = []
  let totalAffectedRows = 0
  try {
    signal.throwIfAborted()
    await primary.connection.promise().query({
      sql: `SET SESSION lock_wait_timeout = ${Math.ceil(DATABASE_LIMITS.timeoutMs / 1000)}`,
      timeout: 5000,
    })
    if (!hasDdl) {
      await primary.connection.promise().query({ sql: 'START TRANSACTION', timeout: 5000 })
    }
    for (const [index, item] of statements.entries()) {
      signal.throwIfAborted()
      const outcome = await runSingleMutation(primary.connection, tracker, item.sql, signal)
      totalAffectedRows += outcome.affectedRows
      results.push({ index, ...item, ...outcome })
    }
    if (!hasDdl) {
      await primary.connection.promise().query({ sql: 'COMMIT', timeout: 5000 })
    }
    const label = profile.engine === 'mariadb' ? 'MariaDB' : 'MySQL'
    return {
      results,
      totalAffectedRows,
      rolledBack: false,
      hasDdl,
      elapsedMs: Math.round(performance.now() - started),
      ...(hasDdl
        ? {
            warning: `本批次包含 DDL 结构变更；${label} 会对 DDL 隐式提交，已完成语句无法作为整体事务回滚。`,
          }
        : {}),
    }
  } catch (error) {
    await tracker.stop()
    const detail = error instanceof Error ? error.message : '数据库变更失败'
    const failedIndex = results.length + 1
    if (!hasDdl) {
      const rolledBack = await rollbackQuietly(primary.connection)
      throw new Error(
        rolledBack
          ? `第 ${failedIndex} 条语句执行失败，已自动回滚整个批次：${detail}`
          : `第 ${failedIndex} 条语句执行失败，且连接异常未能确认回滚：${detail}`,
      )
    }
    const prefix =
      results.length > 0
        ? `第 ${failedIndex} 条语句执行失败；此前 ${results.length} 条语句可能已因 DDL 隐式提交而生效：${detail}`
        : `第 ${failedIndex} 条语句执行失败：${detail}`
    throw new Error(prefix)
  } finally {
    await primary.close()
  }
}
