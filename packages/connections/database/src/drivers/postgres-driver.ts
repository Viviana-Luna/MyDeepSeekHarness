/** PostgreSQL 驱动：复用直连/SSH 通道与 8 MiB 入站限制，强制 TLS SAN 校验，保持精确文本类型并支持 pg_cancel_backend。 */
import type { Duplex } from 'node:stream'
import { checkServerIdentity, type PeerCertificate } from 'node:tls'
import pg, { type Client as PgClient, type FieldDef, type TypeOverridesLike } from 'pg'
import type {
  DatabaseBatchMutationResult,
  DatabaseMutationResultItem,
  DatabaseProfile,
  DatabaseResult,
} from '../../types.d.ts'
import { quoteIdentifier, validateIdentifierName } from '../dialect.ts'
import {
  DATABASE_LIMITS,
  wrapLimitedWireStream,
  type DatabaseBatchMutationExecutionItem,
  type DatabaseReadTransportOptions,
  type DatabaseSocket,
  type OpenSocket,
} from './shared.ts'

const PG_OID_NAMES: Readonly<Record<number, string>> = {
  16: 'BOOL',
  17: 'BYTEA',
  19: 'NAME',
  20: 'INT8',
  21: 'INT2',
  23: 'INT4',
  25: 'TEXT',
  26: 'OID',
  114: 'JSON',
  700: 'FLOAT4',
  701: 'FLOAT8',
  1042: 'CHAR',
  1043: 'VARCHAR',
  1082: 'DATE',
  1083: 'TIME',
  1114: 'TIMESTAMP',
  1184: 'TIMESTAMPTZ',
  1186: 'INTERVAL',
  1700: 'NUMERIC',
  2950: 'UUID',
  3802: 'JSONB',
  1007: 'INT4[]',
  1009: 'TEXT[]',
  1016: 'INT8[]',
}

const PG_EXACT_TYPES: TypeOverridesLike = {
  getTypeParser(oid: number, format?: string) {
    if (format === 'binary') {
      return (value: unknown) => {
        if (value === null || value === undefined) return null
        if (Buffer.isBuffer(value) || value instanceof Uint8Array)
          return `0x${Buffer.from(value).toString('hex')}`
        return String(value)
      }
    }
    return (value: unknown) => {
      if (value === null || value === undefined) return null
      const text = String(value)
      if (oid === 17 && text.startsWith('\\x')) return `0x${text.slice(2)}`
      return text
    }
  },
}

interface PgStreamShim extends Duplex {
  setNoDelay(noDelay?: boolean): void
  setKeepAlive(enable?: boolean, initialDelay?: number): void
  ref(): void
  unref(): void
  connect(): void
}

function createPgStreamShim(owned: DatabaseSocket): {
  stream: Duplex
  destroyAll(): Promise<void>
} {
  const limited = wrapLimitedWireStream(owned)
  const shim = limited.stream as PgStreamShim
  const underlying = owned.stream as Duplex & { connecting?: boolean }
  let preConnectError: unknown
  const catchEarlyError = (error: unknown) => {
    preConnectError = error
  }
  shim.on('error', catchEarlyError)
  shim.setNoDelay = () => {}
  shim.setKeepAlive = () => {}
  shim.ref = () => {}
  shim.unref = () => {}
  shim.connect = () => {
    if (preConnectError) {
      const error = preConnectError
      preConnectError = undefined
      process.nextTick(() => {
        shim.removeListener('error', catchEarlyError)
        shim.destroy(error as Error)
      })
      return
    }
    if (underlying.connecting) {
      underlying.once('connect', () => {
        shim.removeListener('error', catchEarlyError)
        if (!shim.destroyed) shim.emit('connect')
      })
      return
    }
    process.nextTick(() => {
      shim.removeListener('error', catchEarlyError)
      if (!shim.destroyed) shim.emit('connect')
    })
  }
  return { stream: shim, destroyAll: limited.destroyAll }
}

function createPgClient(profile: DatabaseProfile, password: string, stream: Duplex): PgClient {
  const tlsEnabled = profile.tlsEnabled !== false
  const identity = profile.tlsServerName || profile.host
  const client = new pg.Client({
    host: identity,
    port: profile.port,
    user: profile.username,
    password,
    database: profile.database?.trim() || 'postgres',
    stream,
    ssl: tlsEnabled
      ? {
          ...(profile.tlsCa ? { ca: profile.tlsCa } : {}),
          rejectUnauthorized: true,
          minVersion: 'TLSv1.2' as const,
          checkServerIdentity: (_host: string, cert: PeerCertificate) =>
            checkServerIdentity(identity, cert),
        }
      : false,
    connectionTimeoutMillis: 10_000,
    types: PG_EXACT_TYPES,
  })
  client.on('error', () => {})
  return client
}

interface OpenPgConnection {
  client: PgClient
  close(): Promise<void>
  destroyTransport(): void
}

async function openPgConnection(
  profile: DatabaseProfile,
  password: string,
  socket: OpenSocket,
  signal: AbortSignal,
): Promise<OpenPgConnection> {
  signal.throwIfAborted()
  const owned = await socket(signal)
  const shim = createPgStreamShim(owned)
  const client = createPgClient(profile, password, shim.stream)
  let closed: Promise<void> | undefined
  const destroyTransport = () => {
    const activeStream = (client as unknown as { connection?: { stream?: Duplex } }).connection
      ?.stream
    if (activeStream && activeStream !== shim.stream) activeStream.destroy()
    shim.stream.destroy()
  }
  const close = () =>
    (closed ??= (async () => {
      try {
        await Promise.race([
          client.end().catch(() => {}),
          new Promise<void>(resolve => setTimeout(resolve, 400)),
        ])
      } finally {
        await shim.destroyAll()
      }
    })())
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        void close()
        reject(signal.reason)
      }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) {
        abort()
        return
      }
      client
        .connect()
        .then(() => {
          signal.removeEventListener('abort', abort)
          resolve()
        })
        .catch(error => {
          signal.removeEventListener('abort', abort)
          reject(error)
        })
    })
    signal.throwIfAborted()
    return { client, close, destroyTransport }
  } catch (error) {
    await close()
    throw error
  }
}

interface PgCancelTracker {
  attach(active: boolean): void
  markDone(uncertain?: boolean): void
  stop(): Promise<void>
}

function createPgCancelTracker(
  profile: DatabaseProfile,
  password: string,
  socket: OpenSocket,
  primary: OpenPgConnection,
): PgCancelTracker {
  let active = false
  let completed = true
  let uncertain = false
  let cancellationAttempted = false

  const attach = (running: boolean): void => {
    active = running
    completed = !running
    uncertain = false
    cancellationAttempted = false
  }

  const markDone = (wasUncertain = false): void => {
    completed = true
    if (wasUncertain) uncertain = true
  }

  const stop = async (): Promise<void> => {
    if (cancellationAttempted || !active || (completed && !uncertain)) return
    cancellationAttempted = true
    primary.destroyTransport()
    const pid = primary.client.processID
    if (!Number.isSafeInteger(pid)) {
      throw new Error('已关闭本地数据库连接，但未取得服务端进程号，远端执行状态未知')
    }
    let control: OpenPgConnection | undefined
    try {
      const cancellation = AbortSignal.timeout(DATABASE_LIMITS.cancelMs)
      control = await openPgConnection(profile, password, socket, cancellation)
      await control.client.query({
        text: 'SELECT pg_cancel_backend($1)',
        values: [pid],
        rowMode: 'array',
      })
      for (;;) {
        const check = await control.client.query({
          text: 'SELECT state FROM pg_stat_activity WHERE pid = $1',
          values: [pid],
          rowMode: 'array',
        })
        const state = check.rows[0]?.[0]
        if (state !== 'active') break
        if (cancellation.aborted) throw new Error('远端语句仍在执行')
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      uncertain = false
    } catch {
      if (!completed || uncertain)
        throw new Error('已关闭本地数据库连接，但未确认取消完成，远端执行状态未知')
    } finally {
      await control?.close()
    }
  }

  return { attach, markDone, stop }
}

function fieldTypeName(field: FieldDef): string {
  return PG_OID_NAMES[field.dataTypeID] ?? `OID_${field.dataTypeID}`
}

function isPgServerStatementError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const record = error as { code?: unknown; severity?: unknown }
  return (
    typeof record.code === 'string' &&
    typeof record.severity === 'string' &&
    record.severity !== 'FATAL' &&
    record.severity !== 'PANIC'
  )
}

async function setupPgTransaction(
  client: PgClient,
  mode: 'readonly' | 'readwrite',
  options?: DatabaseReadTransportOptions,
): Promise<void> {
  await client.query(mode === 'readonly' ? 'BEGIN TRANSACTION READ ONLY' : 'BEGIN')
  await client.query(`SET LOCAL statement_timeout = ${DATABASE_LIMITS.timeoutMs}`)
  await client.query(`SET LOCAL lock_timeout = ${DATABASE_LIMITS.timeoutMs}`)
  if (options?.searchSchema) {
    validateIdentifierName(options.searchSchema)
    // 严格单 Schema 搜索路径，禁止静默回退到 public 以免绕过表级策略。
    await client.query(
      `SET LOCAL search_path TO ${quoteIdentifier(options.searchSchema, 'postgresql')}`,
    )
  }
}

async function runSinglePgReadQuery(
  primary: OpenPgConnection,
  tracker: PgCancelTracker,
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
  let columns: DatabaseResult['columns'] | undefined
  let bytes = 128
  let truncated = false
  let overLimitError: Error | undefined

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      input.signal.removeEventListener('abort', abort)
      error ? reject(error) : resolve()
    }
    const abort = () => {
      tracker.markDone(true)
      primary.destroyTransport()
      finish(input.signal.reason ?? new Error('数据库查询已取消'))
    }
    input.signal.addEventListener('abort', abort, { once: true })
    if (input.signal.aborted) {
      abort()
      return
    }
    const query = new pg.Query({
      text: input.sql,
      ...(input.values.length > 0 ? { values: [...input.values] } : {}),
      rowMode: 'array',
      types: PG_EXACT_TYPES,
    })
    tracker.attach(true)
    query.on('row', (rawRow: unknown[], result: { fields: FieldDef[] }) => {
      if (settled || overLimitError || truncated) return
      try {
        if (!columns) {
          columns = result.fields.map(field => ({ name: field.name, type: fieldTypeName(field) }))
          bytes += Buffer.byteLength(JSON.stringify(columns))
          if (columns.length > 512 || bytes > input.byteBudget) {
            overLimitError = new Error('查询列数或列名超过显示上限')
            return
          }
        }
        const row = rawRow.map(cell => (cell === null || cell === undefined ? null : String(cell)))
        if (
          row.some(value => value !== null && Buffer.byteLength(value) > DATABASE_LIMITS.cellBytes)
        ) {
          overLimitError = new Error('单个数据库值超过 256 KiB，已停止读取')
          return
        }
        const size = Buffer.byteLength(JSON.stringify(row)) + 1
        if (rows.length >= input.limit || bytes + size > input.byteBudget) {
          truncated = true
          return
        }
        rows.push(row)
        bytes += size
      } catch (error) {
        overLimitError = error instanceof Error ? error : new Error('读取 PostgreSQL 数据失败')
      }
    })
    query.once('error', (error: unknown) => {
      const serverDone = !overLimitError && !input.signal.aborted && isPgServerStatementError(error)
      tracker.markDone(!serverDone)
      finish(overLimitError ?? error)
    })
    query.once('end', (result: { fields: FieldDef[] }) => {
      if (!columns && Array.isArray(result?.fields)) {
        columns = result.fields.map(field => ({ name: field.name, type: fieldTypeName(field) }))
        bytes += Buffer.byteLength(JSON.stringify(columns))
      }
      tracker.markDone(false)
      finish(overLimitError)
    })
    primary.client.query(query)
  })
  await tracker.stop()
  input.signal.throwIfAborted()
  return {
    columns: columns ?? [],
    rows,
    rowCount: rows.length,
    bytes,
    truncated,
    elapsedMs: Math.round(performance.now() - started),
  }
}

/** 在 PostgreSQL READ ONLY 事务内执行单条有界只读查询。 */
export async function readPostgresDatabase(input: {
  profile: DatabaseProfile
  password: string
  socket: OpenSocket
  sql: string
  values: unknown[]
  limit: number
  signal: AbortSignal
  options?: DatabaseReadTransportOptions
}): Promise<DatabaseResult> {
  const { profile, password, socket, sql, values, limit, signal, options } = input
  const primary = await openPgConnection(profile, password, socket, signal)
  const tracker = createPgCancelTracker(profile, password, socket, primary)
  try {
    signal.throwIfAborted()
    await setupPgTransaction(primary.client, 'readonly', options)
    return await runSinglePgReadQuery(primary, tracker, {
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

/** 在单一 PostgreSQL 只读事务中顺序执行多条查询并共享 2 MiB 结果预算。 */
export async function readPostgresDatabaseBatch(input: {
  profile: DatabaseProfile
  password: string
  socket: OpenSocket
  queries: readonly string[]
  limitPerQuery: number
  signal: AbortSignal
  options?: DatabaseReadTransportOptions
}): Promise<DatabaseResult[]> {
  const { profile, password, socket, queries, limitPerQuery, signal, options } = input
  const primary = await openPgConnection(profile, password, socket, signal)
  const tracker = createPgCancelTracker(profile, password, socket, primary)
  try {
    signal.throwIfAborted()
    await setupPgTransaction(primary.client, 'readonly', options)
    const results: DatabaseResult[] = []
    let remainingBytes: number = DATABASE_LIMITS.resultBytes
    for (const sql of queries) {
      signal.throwIfAborted()
      const budget = Math.max(4096, remainingBytes)
      const result = await runSinglePgReadQuery(primary, tracker, {
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

async function runSinglePgMutation(
  primary: OpenPgConnection,
  tracker: PgCancelTracker,
  sql: string,
  signal: AbortSignal,
): Promise<{ affectedRows: number }> {
  let affectedRows = 0
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      error ? reject(error) : resolve()
    }
    const abort = () => {
      tracker.markDone(true)
      primary.destroyTransport()
      finish(signal.reason ?? new Error('数据库变更已取消'))
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
      return
    }
    const query = new pg.Query({ text: sql, rowMode: 'array', types: PG_EXACT_TYPES })
    tracker.attach(true)
    query.once('error', error => {
      const serverDone = !signal.aborted && isPgServerStatementError(error)
      tracker.markDone(!serverDone)
      finish(error)
    })
    query.once('end', result => {
      affectedRows = Number(result?.rowCount ?? 0)
      tracker.markDone(false)
      finish()
    })
    primary.client.query(query)
  })
  await tracker.stop()
  signal.throwIfAborted()
  return { affectedRows }
}

/** 在 PostgreSQL 单一事务内顺序执行 DML 与 DDL；任何一步失败均整体自动回滚。 */
export async function executePostgresDatabaseBatch(input: {
  profile: DatabaseProfile
  password: string
  socket: OpenSocket
  statements: readonly DatabaseBatchMutationExecutionItem[]
  signal: AbortSignal
  options?: DatabaseReadTransportOptions
}): Promise<DatabaseBatchMutationResult> {
  const { profile, password, socket, statements, signal, options } = input
  const started = performance.now()
  const hasDdl = statements.some(item => item.operation === 'ddl')
  const primary = await openPgConnection(profile, password, socket, signal)
  const tracker = createPgCancelTracker(profile, password, socket, primary)
  const results: DatabaseMutationResultItem[] = []
  let totalAffectedRows = 0
  try {
    signal.throwIfAborted()
    await setupPgTransaction(primary.client, 'readwrite', options)
    for (const [index, item] of statements.entries()) {
      signal.throwIfAborted()
      const { affectedRows } = await runSinglePgMutation(primary, tracker, item.sql, signal)
      totalAffectedRows += affectedRows
      results.push({
        index,
        ...item,
        affectedRows,
        changedRows: item.operation === 'update' ? affectedRows : 0,
        insertId: null,
      })
    }
    await primary.client.query('COMMIT')
    return {
      results,
      totalAffectedRows,
      rolledBack: false,
      hasDdl,
      elapsedMs: Math.round(performance.now() - started),
    }
  } catch (error) {
    await tracker.stop()
    const detail = error instanceof Error ? error.message : '数据库变更失败'
    const failedIndex = results.length + 1
    let rolledBack = !signal.aborted
    if (rolledBack) {
      try {
        await primary.client.query('ROLLBACK')
      } catch {
        rolledBack = false
      }
    }
    throw new Error(
      rolledBack
        ? `第 ${failedIndex} 条语句执行失败，已自动回滚整个批次：${detail}`
        : `第 ${failedIndex} 条语句执行失败，且连接异常未能确认回滚：${detail}`,
    )
  } finally {
    await primary.close()
  }
}
