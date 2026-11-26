/** 后台多引擎数据库连接所有者：统一管理 MySQL、MariaDB、PostgreSQL 与 SQLite，桌面工作区与模型工具分别鉴权。 */
import { randomUUID, X509Certificate } from 'node:crypto'
import { isIP } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey, type CredentialRecordEntry } from '@deepseek-ai/dsh-credentials'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { SshConnections } from '@mydsh/ssh'
import type { ConnectionAccess, ConnectionLease } from '@mydsh/connection-access'
import type { ConnectionIdentity } from '@mydsh/connection-access/types'
import type {
  DatabaseAgentAccess,
  DatabaseBatchMutationResult,
  DatabaseColumn,
  DatabaseEngine,
  DatabaseProfile,
  DatabaseResult,
  DatabaseStatementTarget,
  DatabaseStatus,
  DatabaseStructureRequest,
  DatabaseTable,
  DatabaseTestResult,
  SaveDatabaseProfile,
} from '../types.d.ts'
import {
  assertOperationPermitted,
  assertTargetsPermitted,
  normalizeAgentAccess,
  type DatabasePermissionElevation,
} from './agent-policy.ts'
import { databaseStructureQuery, filterStructureRows } from './agent-structure.ts'
import { assertPostgresTableRuleCatalogBoundary } from './tools-format.ts'
import {
  buildDesktopColumnsQuery,
  buildDesktopDatabasesQuery,
  buildDesktopPreviewQuery,
  buildDesktopSchemasQuery,
  buildDesktopTablesQuery,
  buildTestQuery,
  connectionDatabaseForRun,
  formatVersionLabel,
  isNetworkEngine,
  isSupportedConnectionPlatform,
  normalizeEngine,
  quoteIdentifier,
  validateIdentifierName,
} from './dialect.ts'
import { validateSqliteFilePath } from './drivers/sqlite-path.ts'
import { admitReadQuery } from './read-query.ts'
import {
  DATABASE_LIMITS,
  directSocket,
  executeDatabaseBatch,
  readDatabase,
  readDatabaseBatch,
  type OpenSocket,
} from './transport.ts'
import type { AdmittedMutationStatement } from './write-query.ts'

export { DATABASE_LIMITS } from './transport.ts'

interface Stored {
  version: 1
  profile: Omit<
    DatabaseProfile,
    'credentialConfigured' | 'tlsEnabled' | 'agentAccess' | 'engine' | 'filePath'
  > & {
    engine?: DatabaseEngine
    filePath?: string | null
    tlsEnabled?: boolean
    agentAccess?: DatabaseAgentAccess
  }
  secret?: unknown
}

interface Operation {
  controller: AbortController
  done: Promise<unknown>
  lease: ConnectionLease | undefined
}

interface StoredPermissionElevation {
  connection: ConnectionIdentity
  dependencies: readonly ConnectionIdentity[]
  elevation: DatabasePermissionElevation
}

/** 面向模型工具解析后的就绪连接目标与依赖身份。 */
export interface ResolvedAgentDatabaseTarget {
  readonly profile: DatabaseProfile
  readonly connection: ConnectionIdentity
  readonly dependencies: readonly ConnectionIdentity[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mydshDatabase: DatabaseConnections
  }
}

const prefix = 'mydsh-database/connection-'
const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u
const keyOf = (id: string) => {
  if (!idPattern.test(id)) throw new Error('数据库连接标识无效')
  return credentialKey('mydsh-database', `connection-${id}`)
}

const publicProfile = ({ profile, secret }: Stored): DatabaseProfile => {
  const engine = normalizeEngine(profile.engine)
  const network = isNetworkEngine(engine)
  return {
    id: profile.id,
    revision: profile.revision,
    engine,
    name: profile.name,
    host: network ? profile.host : '',
    port: network ? profile.port : 0,
    username: network ? profile.username : '',
    database: network ? profile.database : null,
    filePath: engine === 'sqlite' ? (profile.filePath ?? null) : null,
    tlsEnabled: network ? (profile.tlsEnabled ?? true) : false,
    tlsServerName: network ? profile.tlsServerName : '',
    tlsCa: network ? profile.tlsCa : '',
    sshConnectionId: network ? profile.sshConnectionId : null,
    environment: profile.environment,
    projectId: profile.projectId,
    disabled: profile.disabled,
    credentialConfigured: engine === 'sqlite' ? true : secret !== undefined,
    agentAccess: normalizeAgentAccess(profile.agentAccess, engine),
  }
}

function parseSqliteColumnRow(row: (string | null)[]): DatabaseColumn {
  const type = row[2] ?? ''
  const isPrimaryKey = row[5] !== '0'
  // SQLite 的 INTEGER PRIMARY KEY 隐式关联 rowid，PRAGMA table_info 中 notnull 可能为 0。
  const isRowIdPrimaryKey = isPrimaryKey && type.trim().toUpperCase() === 'INTEGER'
  return {
    name: row[1]!,
    type,
    nullable: row[3] === '0' && !isRowIdPrimaryKey,
    key: isPrimaryKey ? 'PRI' : '',
  }
}

function validateTls(value: Omit<SaveDatabaseProfile, 'id' | 'revision' | 'password'>): void {
  const identity = value.tlsServerName || value.host
  if (
    value.tlsEnabled &&
    !isIP(identity) &&
    !identity
      .split('.')
      .every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label))
  )
    throw new Error('TLS 校验名称必须是有效的主机名或 IP 地址')
  if (value.tlsEnabled && value.tlsCa.trim()) {
    const certificates = value.tlsCa.match(
      /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu,
    )
    if (
      !certificates?.length ||
      value.tlsCa
        .replace(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu, '')
        .trim()
    )
      throw new Error('TLS CA 必须是 PEM 证书，不能包含私钥或其他内容')
    try {
      for (const certificate of certificates) new X509Certificate(certificate)
    } catch {
      throw new Error('TLS CA 证书无法解析')
    }
  }
}

function validate(
  value: Omit<SaveDatabaseProfile, 'id' | 'revision' | 'password'>,
): DatabaseEngine {
  if (
    !value ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    value.name.length > 100 ||
    typeof value.environment !== 'string' ||
    value.environment.length > 40 ||
    typeof value.disabled !== 'boolean' ||
    (value.projectId !== null &&
      (typeof value.projectId !== 'string' || value.projectId.length > 512))
  )
    throw new Error('请检查连接名称、环境及启用状态')
  const engine = normalizeEngine(value.engine)
  if (engine === 'sqlite') {
    if (
      typeof value.filePath !== 'string' ||
      !value.filePath.trim() ||
      value.filePath.length > 4096 ||
      typeof value.tlsEnabled !== 'boolean' ||
      value.tlsEnabled ||
      value.sshConnectionId !== null
    )
      throw new Error('SQLite 连接必须指定有效本地文件路径，且不能启用 TLS 或 SSH 隧道')
  } else {
    if (
      typeof value.host !== 'string' ||
      !value.host ||
      value.host.length > 253 ||
      /[\s/@?#\u0000-\u001f]/u.test(value.host) ||
      !Number.isInteger(value.port) ||
      value.port < 1 ||
      value.port > 65535 ||
      typeof value.username !== 'string' ||
      !value.username ||
      value.username.length > 128 ||
      /[\u0000-\u001f]/u.test(value.username) ||
      typeof value.tlsEnabled !== 'boolean' ||
      typeof value.tlsServerName !== 'string' ||
      value.tlsServerName.length > 253 ||
      typeof value.tlsCa !== 'string' ||
      Buffer.byteLength(value.tlsCa) > 128 * 1024 ||
      (value.sshConnectionId !== null && !idPattern.test(value.sshConnectionId))
    )
      throw new Error('请检查数据库名称、目标地址、端口、账号和 TLS 设置')
    if (value.database !== null) quoteIdentifier(value.database, engine)
    validateTls(value)
  }
  if ('agentAccess' in value && value.agentAccess !== undefined)
    normalizeAgentAccess(value.agentAccess, engine)
  return engine
}

/** 每次执行拥有独立连接；界面隐藏不取消，编辑、关闭、删除与退出取消所属操作。 */
export class DatabaseConnections extends TypertRemoteService {
  static inject = ['credentials', 'mydshConnectionSystem', 'mydshSsh']
  private readonly lifetime = new AbortController()
  private readonly operations = new Map<string, Operation>()
  private readonly agentQueues = new Map<string, Promise<void>>()
  private readonly agentElevations = new WeakMap<object, Map<string, StoredPermissionElevation>>()
  private mutations: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context) {
    super(ctx, 'mydshDatabase')
    ctx.effect(() => async () => {
      this.lifetime.abort()
      await this.closeOwned()
      await this.mutations.catch(() => {})
    })
  }

  private authorize(token: string): void {
    if (!isSupportedConnectionPlatform()) throw new Error('数据库连接目前仅支持 macOS 与 Windows')
    if (token !== this.ctx.mydshConnectionSystem.token)
      throw new Error('该桌面操作只允许当前窗口使用；模型请通过数据库工具调用')
    this.lifetime.signal.throwIfAborted()
  }

  private access(): ConnectionAccess {
    const access = this.ctx.get('mydshConnectionAccess')
    if (!access) throw new Error('会话连接授权服务不可用，请等待运行核心就绪')
    return access
  }

  /**
   * 列出数据库连接的凭据记录条目。
   *
   * 只允许作为实例方法被服务自身调用：静态入口收到的是服务代理，代理的 `ctx` 指向调用方上下文，
   * 而模型工具插件并未声明 `credentials`，直读会抛注入错误。
   */
  private async connectionRecords(): Promise<readonly CredentialRecordEntry[]> {
    const records = await this.ctx.credentials.listRecords()
    return records.filter(item => item.key.startsWith(prefix))
  }

  private async read(id: string): Promise<Stored> {
    const record = await this.ctx.credentials.readRecord(keyOf(id))
    const value = record?.kind === 'grant' ? (record.payload as unknown as Stored) : undefined
    if (
      !value ||
      value.version !== 1 ||
      !value.profile ||
      value.profile.id !== id ||
      !Number.isSafeInteger(value.profile.revision) ||
      value.profile.revision < 1
    )
      throw new Error('数据库连接记录不存在或格式无效')
    validate({ ...value.profile, tlsEnabled: value.profile.tlsEnabled ?? true })
    return value
  }

  private mutate<T>(work: () => Promise<T>): Promise<T> {
    const task = this.mutations.then(() => {
      this.lifetime.signal.throwIfAborted()
      return work()
    })
    this.mutations = task.catch(() => {})
    return task
  }

  private enqueueAgent<T>(id: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    keyOf(id)
    const previous = this.agentQueues.get(id) ?? Promise.resolve()
    const run = previous.then(async () => {
      signal.throwIfAborted()
      this.lifetime.signal.throwIfAborted()
      const active = this.operations.get(id)
      if (active) await active.done.catch(() => {})
      signal.throwIfAborted()
      this.lifetime.signal.throwIfAborted()
      return work()
    })
    const cleanup = run.then(
      () => undefined,
      () => undefined,
    )
    const tracked = cleanup.then(() => {
      if (this.agentQueues.get(id) === tracked) this.agentQueues.delete(id)
    })
    this.agentQueues.set(id, tracked)
    return run
  }

  private createSocketFactory(profile: DatabaseProfile): OpenSocket {
    return async connectionSignal =>
      profile.sshConnectionId === null
        ? directSocket(profile.host, profile.port)
        : SshConnections.openTunnel(
            this.ctx.mydshSsh,
            this.ctx.mydshConnectionSystem.token,
            profile.sshConnectionId,
            profile.host,
            profile.port,
            connectionSignal,
          )
  }

  private async buildTarget(stored: Stored): Promise<ResolvedAgentDatabaseTarget> {
    const profile = publicProfile(stored)
    if (profile.disabled) throw new Error('PERMISSION_DENIED：数据库连接已禁用')
    if (!profile.credentialConfigured) throw new Error('PERMISSION_DENIED：数据库连接尚未配置凭据')
    if (!profile.agentAccess.enabled)
      throw new Error('PERMISSION_DENIED：该数据库连接尚未开放给模型调用，请在「数据库」模式开启')
    const connection: ConnectionIdentity = {
      kind: 'database',
      id: profile.id,
      revision: profile.revision,
    }
    const dependencies: ConnectionIdentity[] = []
    if (profile.sshConnectionId !== null) {
      const ssh = await SshConnections.trustedIdentity(this.ctx.mydshSsh, profile.sshConnectionId)
      dependencies.push({
        kind: 'ssh',
        id: ssh.id,
        revision: ssh.revision,
        fingerprint: ssh.fingerprint,
      })
    }
    return { profile, connection, dependencies }
  }

  private elevationKey(target: ResolvedAgentDatabaseTarget, catalog?: string | null): string {
    if (target.profile.engine !== 'postgresql') return target.connection.id
    const effective = catalog?.trim() || target.profile.database?.trim() || 'postgres'
    return `${target.connection.id}\0${effective.toLowerCase()}`
  }

  private findAgentElevation(
    agent: object,
    target: ResolvedAgentDatabaseTarget,
    catalog?: string | null,
  ): DatabasePermissionElevation | undefined {
    const elevations = this.agentElevations.get(agent)
    const key = this.elevationKey(target, catalog)
    const stored = elevations?.get(key)
    if (!stored) return undefined
    const matches =
      stored.connection.revision === target.connection.revision &&
      stored.dependencies.length === target.dependencies.length &&
      stored.dependencies.every((dependency, index) => {
        const current = target.dependencies[index]
        return (
          current?.kind === dependency.kind &&
          current.id === dependency.id &&
          current.revision === dependency.revision &&
          current.fingerprint === dependency.fingerprint
        )
      })
    if (!matches) {
      elevations?.delete(key)
      return undefined
    }
    return stored.elevation
  }

  /** 读取当前会话临时提权；连接版本、SSH 依赖或 PostgreSQL 物理库变化后不跨库复用。 */
  static agentElevation(
    owner: DatabaseConnections,
    agent: object | undefined,
    target: ResolvedAgentDatabaseTarget,
    catalog?: string | null,
  ): DatabasePermissionElevation | undefined {
    return agent ? owner.findAgentElevation(agent, target, catalog) : undefined
  }

  /** 为当前 Agent 实例记住本会话临时提权（PostgreSQL 按物理库隔离）；连接改版后失效。 */
  static grantAgentElevation(
    owner: DatabaseConnections,
    agent: object,
    target: ResolvedAgentDatabaseTarget,
    elevation: DatabasePermissionElevation,
    catalog?: string | null,
  ): void {
    let elevations = owner.agentElevations.get(agent)
    if (!elevations) {
      elevations = new Map()
      owner.agentElevations.set(agent, elevations)
    }
    elevations.set(owner.elevationKey(target, catalog), {
      connection: target.connection,
      dependencies: target.dependencies,
      elevation,
    })
  }

  private assertTargetUnchanged(
    expected: ResolvedAgentDatabaseTarget,
    current: ResolvedAgentDatabaseTarget,
  ): void {
    if (
      expected.connection.id !== current.connection.id ||
      expected.connection.revision !== current.connection.revision
    )
      throw new Error('CONNECTION_CHANGED：数据库连接配置已修改，请重新确认授权')
    if (expected.dependencies.length !== current.dependencies.length)
      throw new Error('CONNECTION_CHANGED：数据库关联的 SSH 隧道配置已修改，请重新确认授权')
    for (const [index, dep] of current.dependencies.entries()) {
      const prior = expected.dependencies[index]
      if (
        !prior ||
        prior.kind !== dep.kind ||
        prior.id !== dep.id ||
        prior.revision !== dep.revision ||
        prior.fingerprint !== dep.fingerprint
      )
        throw new Error('CONNECTION_CHANGED：关联 SSH 节点配置或指纹已修改，请重新确认授权')
    }
  }

  private assertAgentLeaseTarget(
    lease: ConnectionLease,
    target: ResolvedAgentDatabaseTarget,
  ): void {
    this.access().assertLease(lease)
    const expected = lease.view.connection
    if (
      expected.kind !== 'database' ||
      expected.id !== target.connection.id ||
      expected.revision !== target.connection.revision
    )
      throw new Error('CONNECTION_CHANGED：数据库连接配置已修改，请重新确认授权')
    if (lease.view.dependencies.length !== target.dependencies.length)
      throw new Error('CONNECTION_CHANGED：数据库关联的 SSH 隧道配置已修改，请重新确认授权')
    for (const [index, dep] of target.dependencies.entries()) {
      const prior = lease.view.dependencies[index]
      if (
        !prior ||
        prior.kind !== dep.kind ||
        prior.id !== dep.id ||
        prior.revision !== dep.revision ||
        prior.fingerprint !== dep.fingerprint
      )
        throw new Error('CONNECTION_CHANGED：关联 SSH 节点配置或指纹已修改，请重新确认授权')
    }
  }

  private async runWithConnection<T>(input: {
    id: string
    database: string | null
    catalog?: string | null
    omitDefaultDatabase?: boolean
    signal: AbortSignal
    lease: ConnectionLease | undefined
    beforeExecute?: (target: Stored) => Promise<void>
    execute: (
      profile: DatabaseProfile,
      password: string,
      socket: OpenSocket,
      combinedSignal: AbortSignal,
      selectedSchema: string | null,
    ) => Promise<T>
  }): Promise<T> {
    const { id, database, catalog, omitDefaultDatabase, signal, lease, beforeExecute, execute } =
      input
    if (lease) this.access().assertLease(lease)
    keyOf(id)
    if (database !== null) validateIdentifierName(database)
    if (catalog !== undefined && catalog !== null) validateIdentifierName(catalog)
    if (this.operations.has(id)) throw new Error('该数据库正在执行操作，请等待或取消')
    if (this.operations.size >= 8) throw new Error('同时运行的数据库操作已达到 8 个上限')
    const controller = new AbortController()
    const combined = AbortSignal.any([
      signal,
      controller.signal,
      this.lifetime.signal,
      ...(lease ? [lease.signal] : []),
      AbortSignal.timeout(DATABASE_LIMITS.timeoutMs),
    ])
    let password: string | undefined
    const done = (async () => {
      try {
        const value = await this.read(id)
        if (value.profile.disabled) throw new Error('数据库连接已禁用')
        if (beforeExecute) await beforeExecute(value)
        const baseProfile = publicProfile(value)
        const profile: DatabaseProfile = {
          ...baseProfile,
          database: connectionDatabaseForRun(baseProfile, database, {
            catalog: catalog ?? null,
            omitDefaultDatabase: omitDefaultDatabase ?? false,
          }),
        }
        if (baseProfile.engine === 'sqlite') {
          password = ''
        } else {
          const plaintext = await this.ctx.mydshConnectionSystem.call(
            'database.open',
            { connectionId: id, purpose: 'database-password', envelope: value.secret },
            combined,
          )
          if (typeof plaintext !== 'string') throw new Error('系统未返回可用数据库凭据')
          password = plaintext
        }
        if (lease) this.access().assertLease(lease)
        combined.throwIfAborted()
        const result = await execute(
          profile,
          password,
          this.createSocketFactory(profile),
          combined,
          database,
        )
        if ((await this.read(id)).profile.revision !== profile.revision)
          throw new Error('数据库配置在执行期间被修改，本次结果已丢弃')
        combined.throwIfAborted()
        if (lease) this.access().assertLease(lease)
        return result
      } catch (error) {
        const message =
          error instanceof Error && error.name === 'TimeoutError'
            ? '数据库操作超过 20 秒，已停止执行'
            : error instanceof Error
              ? error.message
              : '数据库操作失败'
        throw new Error(password ? message.replaceAll(password, '[已隐藏]') : message)
      } finally {
        if (this.operations.get(id)?.controller === controller) this.operations.delete(id)
      }
    })()
    this.operations.set(id, { controller, done, lease })
    return done
  }

  /** 获取当前所有可用数据库连接（含已启用的直连、受信 SSH 隧道与本地 SQLite）及权限摘要。 */
  static async agentCatalog(owner: DatabaseConnections): Promise<ResolvedAgentDatabaseTarget[]> {
    if (!isSupportedConnectionPlatform()) return []
    owner.lifetime.signal.throwIfAborted()
    const records = await owner.connectionRecords()
    const results: ResolvedAgentDatabaseTarget[] = []
    for (const record of records) {
      owner.lifetime.signal.throwIfAborted()
      try {
        const stored = await owner.read(record.key.slice(prefix.length))
        results.push(await owner.buildTarget(stored))
      } catch {
        // 跳过禁用、缺少凭据、关闭模型访问或 SSH 尚不可用的连接，不影响其余连接发现。
      }
    }
    return results
  }

  /** 解析并校验单个可用于模型调用的数据库连接与关联 SSH 身份。 */
  static async resolveAgentConnection(
    owner: DatabaseConnections,
    connectionId: string,
  ): Promise<ResolvedAgentDatabaseTarget> {
    if (!isSupportedConnectionPlatform()) throw new Error('数据库连接目前仅支持 macOS 与 Windows')
    owner.lifetime.signal.throwIfAborted()
    return owner.buildTarget(await owner.read(connectionId))
  }

  /** 仅供同包模型结构工具调用；读取连接结构并按表级 select 权限过滤返回结果。 */
  static async readStructure(
    owner: DatabaseConnections,
    connectionId: string,
    request: {
      structure: DatabaseStructureRequest
      signal: AbortSignal
      elevation?: DatabasePermissionElevation
      expectedTarget?: ResolvedAgentDatabaseTarget
    },
  ): Promise<DatabaseResult> {
    return owner.enqueueAgent(connectionId, request.signal, () =>
      owner.runWithConnection({
        id: connectionId,
        database: request.structure.schema ?? null,
        catalog: request.structure.database ?? null,
        omitDefaultDatabase:
          request.structure.action === 'databases' || request.structure.action === 'schemas',
        signal: request.signal,
        lease: undefined,
        beforeExecute: async stored => {
          const target = await owner.buildTarget(stored)
          if (request.expectedTarget) owner.assertTargetUnchanged(request.expectedTarget, target)
          assertPostgresTableRuleCatalogBoundary(target.profile, request.structure.database)
          databaseStructureQuery(
            target.profile.agentAccess,
            request.structure,
            request.elevation,
            target.profile.engine,
          )
        },
        execute: async (profile, password, socket, combinedSignal, selectedSchema) => {
          const plan = databaseStructureQuery(
            profile.agentAccess,
            request.structure,
            request.elevation,
            profile.engine,
          )
          let raw: DatabaseResult
          try {
            raw = await readDatabase(
              {
                ...profile,
                database: connectionDatabaseForRun(profile, plan.schema ?? selectedSchema, {
                  catalog: plan.catalog ?? null,
                  omitDefaultDatabase:
                    request.structure.action === 'databases' ||
                    request.structure.action === 'schemas',
                }),
              },
              password,
              socket,
              plan.sql,
              plan.values,
              plan.rows,
              combinedSignal,
              profile.engine === 'postgresql' && (plan.schema ?? selectedSchema)
                ? { searchSchema: plan.schema ?? selectedSchema }
                : undefined,
            )
          } catch (error) {
            if (
              request.structure.action === 'databases' &&
              profile.engine === 'postgresql' &&
              typeof error === 'object' &&
              error !== null &&
              (error as { code?: unknown }).code === '42501'
            ) {
              raw = {
                columns: [{ name: 'datname', type: 'name' }],
                rows:
                  request.structure.offset === 0 ? [[profile.database?.trim() || 'postgres']] : [],
                rowCount: request.structure.offset === 0 ? 1 : 0,
                bytes: 64,
                truncated: false,
                elapsedMs: 0,
              }
            } else {
              throw error
            }
          }
          let rows = raw.rows
          if (plan.postFilterSqlitePragma === 'columns') {
            rows = rows
              .map(row => {
                const col = parseSqliteColumnRow(row)
                return [col.name, col.type, col.nullable ? 'YES' : 'NO', col.key]
              })
              .slice(
                request.structure.offset,
                request.structure.offset + request.structure.limit + 1,
              )
          } else if (plan.postFilterSqlitePragma === 'indexes') {
            rows = await owner.expandSqliteIndexes({
              profile,
              password,
              socket,
              listRows: rows,
              offset: request.structure.offset,
              limit: request.structure.limit,
              signal: combinedSignal,
            })
          }
          rows = filterStructureRows(profile.agentAccess, request.structure, rows, {
            ...(request.elevation ? { elevation: request.elevation } : {}),
            engine: profile.engine,
          })
          return { ...raw, rows, rowCount: rows.length }
        },
      }),
    )
  }

  private async expandSqliteIndexes(input: {
    profile: DatabaseProfile
    password: string
    socket: OpenSocket
    listRows: (string | null)[][]
    offset: number
    limit: number
    signal: AbortSignal
  }): Promise<(string | null)[][]> {
    const indexes = input.listRows
      .map(row => ({ name: row[1], unique: row[2] === '1' }))
      .filter((item): item is { name: string; unique: boolean } => typeof item.name === 'string')
    if (indexes.length === 0) return []
    const queries = indexes.map(
      item => `PRAGMA index_info(${quoteIdentifier(item.name, 'sqlite')})`,
    )
    const infoResults = await readDatabaseBatch(
      input.profile,
      input.password,
      input.socket,
      queries,
      DATABASE_LIMITS.rows,
      input.signal,
    )
    const expanded: (string | null)[][] = []
    for (const [idx, item] of indexes.entries()) {
      const colRows = infoResults[idx]?.rows ?? []
      for (const colRow of colRows) {
        const seq = Number(colRow[0] ?? 0) + 1
        expanded.push([item.name, colRow[2] ?? '(expr)', String(seq), item.unique ? '0' : '1'])
      }
    }
    return expanded
      .toSorted(
        (left, right) =>
          (left[0] ?? '').localeCompare(right[0] ?? '') ||
          Number(left[2] ?? 0) - Number(right[2] ?? 0),
      )
      .slice(input.offset, input.offset + input.limit + 1)
  }

  /** 仅供同包模型只读查询工具调用：在 READ ONLY 事务中批量执行已校验 SELECT 并按表鉴权。 */
  static async queryForAgent(
    owner: DatabaseConnections,
    request: {
      connectionId: string
      database: string | null
      catalog?: string | null
      queries: readonly { sql: string; targets: readonly DatabaseStatementTarget[] }[]
      limitPerQuery: number
      signal: AbortSignal
      elevation?: DatabasePermissionElevation
      expectedTarget?: ResolvedAgentDatabaseTarget
    },
  ): Promise<DatabaseResult[]> {
    const allTargets = request.queries.flatMap(item => item.targets)
    return owner.enqueueAgent(request.connectionId, request.signal, () =>
      owner.runWithConnection({
        id: request.connectionId,
        database: request.database,
        catalog: request.catalog ?? null,
        signal: request.signal,
        lease: undefined,
        beforeExecute: async stored => {
          const target = await owner.buildTarget(stored)
          if (request.expectedTarget) owner.assertTargetUnchanged(request.expectedTarget, target)
          assertPostgresTableRuleCatalogBoundary(target.profile, request.catalog)
          assertTargetsPermitted(
            target.profile.agentAccess,
            allTargets,
            request.elevation,
            target.profile.engine,
          )
        },
        execute: (profile, password, socket, combinedSignal, selectedSchema) =>
          readDatabaseBatch(
            profile,
            password,
            socket,
            request.queries.map(item => item.sql),
            request.limitPerQuery,
            combinedSignal,
            profile.engine === 'postgresql' && selectedSchema
              ? { searchSchema: selectedSchema }
              : undefined,
          ),
      }),
    )
  }

  /** 仅供同包模型变更工具调用：凭会话或单次变更租约执行已准入且用户同意的批量变更/DDL。 */
  static async mutateForAgent(
    owner: DatabaseConnections,
    lease: ConnectionLease,
    request: {
      database: string | null
      catalog?: string | null
      statements: readonly AdmittedMutationStatement[]
      signal: AbortSignal
      elevation?: DatabasePermissionElevation
    },
  ): Promise<DatabaseBatchMutationResult> {
    const connectionId = lease.view.connection.id
    const allTargets = request.statements.flatMap(item => item.targets)
    return owner.enqueueAgent(connectionId, request.signal, () =>
      owner.runWithConnection({
        id: connectionId,
        database: request.database,
        catalog: request.catalog ?? null,
        signal: request.signal,
        lease,
        beforeExecute: async stored => {
          const target = await owner.buildTarget(stored)
          owner.assertAgentLeaseTarget(lease, target)
          assertPostgresTableRuleCatalogBoundary(target.profile, request.catalog)
          assertTargetsPermitted(
            target.profile.agentAccess,
            allTargets,
            request.elevation,
            target.profile.engine,
          )
          for (const statement of request.statements)
            assertOperationPermitted(
              target.profile.agentAccess,
              statement.operation,
              request.elevation,
            )
        },
        execute: (profile, password, socket, combinedSignal, selectedSchema) =>
          executeDatabaseBatch(
            profile,
            password,
            socket,
            request.statements,
            combinedSignal,
            profile.engine === 'postgresql' && selectedSchema
              ? { searchSchema: selectedSchema }
              : undefined,
          ),
      }),
    )
  }

  @Remote
  async pickSqliteFile(windowToken: string): Promise<string | null> {
    this.authorize(windowToken)
    const response = (await this.ctx.mydshConnectionSystem.call(
      'database.pick-sqlite',
      {},
      this.lifetime.signal,
    )) as { path?: string | null } | null
    return typeof response?.path === 'string' ? response.path : null
  }

  @Remote
  async status(windowToken: string): Promise<DatabaseStatus> {
    if (!isSupportedConnectionPlatform()) return { supported: false, connections: [], busyIds: [] }
    this.authorize(windowToken)
    const records = await this.connectionRecords()
    if (records.length > 200) throw new Error('数据库连接超过 200 条上限')
    return {
      supported: true,
      connections: await Promise.all(
        records.map(async record =>
          publicProfile(await this.read(record.key.slice(prefix.length))),
        ),
      ),
      busyIds: [...this.operations.keys()],
    }
  }

  @Remote
  async save(windowToken: string, request: SaveDatabaseProfile): Promise<DatabaseProfile> {
    this.authorize(windowToken)
    const engine = validate(request)
    const sqlitePath =
      engine === 'sqlite'
        ? await validateSqliteFilePath(request.filePath, { writable: false })
        : null
    return this.mutate(async () => {
      const previous = request.id === null ? undefined : await this.read(request.id)
      if (previous && previous.profile.revision !== request.revision)
        throw new Error('数据库连接已修改，请刷新后重试')
      if (previous && normalizeEngine(previous.profile.engine) !== engine)
        throw new Error('不支持更改已有连接的数据库类型，请新建连接')
      if (!previous && (await this.status(windowToken)).connections.length >= 200)
        throw new Error('数据库连接已达到上限')
      const id = previous?.profile.id ?? randomUUID()
      let secret = previous?.secret
      if (engine === 'sqlite') {
        secret = undefined
      } else {
        if (request.password !== undefined)
          secret = await this.ctx.mydshConnectionSystem.call(
            'database.seal',
            { connectionId: id, purpose: 'database-password', secret: request.password },
            this.lifetime.signal,
          )
        if (secret === undefined) throw new Error('请填写数据库密码；空密码需明确保存为空字符串')
        if (request.sshConnectionId !== null) {
          const ssh = (await this.ctx.mydshSsh.status(windowToken)).connections.find(
            item => item.id === request.sshConnectionId,
          )
          if (!ssh || ssh.disabled || !ssh.fingerprint)
            throw new Error('请先在服务器连接中启用并信任所选 SSH 连接')
        }
      }
      this.ctx.get('mydshConnectionAccess')?.invalidate({ kind: 'database', id })
      await this.closeConnection(id)
      const agentAccess =
        request.agentAccess !== undefined
          ? normalizeAgentAccess(request.agentAccess, engine)
          : normalizeAgentAccess(previous?.profile.agentAccess, engine)
      const value: Stored = {
        version: 1,
        ...(secret === undefined ? {} : { secret }),
        profile: {
          id,
          revision: (previous?.profile.revision ?? 0) + 1,
          engine,
          name: request.name.trim(),
          host: engine === 'sqlite' ? '' : request.host,
          port: engine === 'sqlite' ? 0 : request.port,
          username: engine === 'sqlite' ? '' : request.username,
          database: engine === 'sqlite' ? null : request.database,
          filePath: sqlitePath,
          tlsEnabled: engine === 'sqlite' ? false : request.tlsEnabled,
          tlsServerName: engine === 'sqlite' ? '' : request.tlsServerName,
          tlsCa: engine === 'sqlite' ? '' : request.tlsCa,
          sshConnectionId: engine === 'sqlite' ? null : request.sshConnectionId,
          environment: request.environment.trim(),
          projectId: request.projectId,
          disabled: request.disabled,
          agentAccess,
        },
      }
      await this.ctx.credentials.modifyRecord(keyOf(id), async () => {
        this.lifetime.signal.throwIfAborted()
        return { kind: 'grant', payload: value }
      })
      return publicProfile(value)
    })
  }

  @Remote
  async remove(windowToken: string, id: string, revision: number): Promise<boolean> {
    this.authorize(windowToken)
    return this.mutate(async () => {
      if ((await this.read(id)).profile.revision !== revision)
        throw new Error('数据库连接已修改，请刷新后重试')
      this.ctx.get('mydshConnectionAccess')?.invalidate({ kind: 'database', id })
      await this.closeConnection(id)
      await this.ctx.credentials.deleteRecord(keyOf(id))
      return true
    })
  }

  private runForEngine(input: {
    windowToken: string
    id: string
    catalog: string | null
    schema: string | null
    omitDefaultDatabase?: boolean
    build: (engine: DatabaseEngine) => { sql: string; values: unknown[]; rows?: number }
    signal: AbortSignal
  }): Promise<DatabaseResult> {
    this.authorize(input.windowToken)
    return this.runWithConnection({
      id: input.id,
      database: input.schema,
      catalog: input.catalog,
      omitDefaultDatabase: input.omitDefaultDatabase ?? false,
      signal: input.signal,
      lease: undefined,
      execute: (profile, password, socket, combined, selectedSchema) => {
        const query = input.build(profile.engine)
        return readDatabase(
          profile,
          password,
          socket,
          query.sql,
          query.values,
          query.rows ?? DATABASE_LIMITS.rows,
          combined,
          profile.engine === 'postgresql' && selectedSchema
            ? { searchSchema: selectedSchema }
            : undefined,
        )
      },
    })
  }

  private metadata(result: DatabaseResult): (string | null)[][] {
    if (result.truncated) throw new Error('结构项目超过显示上限，请选择更小的数据库范围')
    return result.rows
  }

  @Remote
  async test(windowToken: string, id: string, signal: AbortSignal): Promise<DatabaseTestResult> {
    let detected: DatabaseEngine = 'mysql'
    const result = await this.runForEngine({
      windowToken,
      id,
      catalog: null,
      schema: null,
      build: engine => {
        detected = engine
        return { sql: buildTestQuery(engine), values: [], rows: 1 }
      },
      signal,
    })
    return { serverVersion: formatVersionLabel(detected, result.rows[0]?.[0] ?? '') }
  }

  @Remote
  async databases(windowToken: string, id: string, signal: AbortSignal): Promise<string[]> {
    this.authorize(windowToken)
    const result = await this.runWithConnection({
      id,
      database: null,
      catalog: null,
      omitDefaultDatabase: true,
      signal,
      lease: undefined,
      execute: async (profile, password, socket, combined) => {
        const query = buildDesktopDatabasesQuery(profile.engine)
        try {
          return await readDatabase(
            profile,
            password,
            socket,
            query.sql,
            query.values,
            DATABASE_LIMITS.rows,
            combined,
          )
        } catch (error) {
          if (
            profile.engine === 'postgresql' &&
            typeof error === 'object' &&
            error !== null &&
            (error as { code?: unknown }).code === '42501'
          ) {
            return {
              columns: [{ name: 'datname', type: 'name' }],
              rows: [[profile.database?.trim() || 'postgres']],
              rowCount: 1,
              bytes: 64,
              truncated: false,
              elapsedMs: 0,
            }
          }
          throw error
        }
      },
    })
    return this.metadata(result).map(row => row[0]!)
  }

  @Remote
  async schemas(
    windowToken: string,
    id: string,
    catalog: string | null,
    signal: AbortSignal,
  ): Promise<string[]> {
    const result = await this.runForEngine({
      windowToken,
      id,
      catalog,
      schema: null,
      omitDefaultDatabase: true,
      build: engine => buildDesktopSchemasQuery(engine),
      signal,
    })
    return this.metadata(result).map(row => row[0]!)
  }

  @Remote
  async tables(
    windowToken: string,
    id: string,
    catalog: string | null,
    schema: string,
    signal: AbortSignal,
  ): Promise<DatabaseTable[]> {
    const result = await this.runForEngine({
      windowToken,
      id,
      catalog,
      schema,
      build: engine => buildDesktopTablesQuery(engine, schema),
      signal,
    })
    return this.metadata(result).map(row => ({
      name: row[0]!,
      kind: tableKindFromType(row[1]),
    }))
  }

  @Remote
  async columns(
    windowToken: string,
    id: string,
    catalog: string | null,
    schema: string,
    table: string,
    signal: AbortSignal,
  ): Promise<DatabaseColumn[]> {
    let detected: DatabaseEngine = 'mysql'
    const result = await this.runForEngine({
      windowToken,
      id,
      catalog,
      schema,
      build: engine => {
        detected = engine
        return buildDesktopColumnsQuery(engine, schema, table)
      },
      signal,
    })
    return this.metadata(result).map(row => {
      if (detected === 'sqlite') return parseSqliteColumnRow(row)
      return {
        name: row[0]!,
        type: row[1] ?? '',
        nullable: row[2] === 'YES',
        key: row[3] ?? '',
      }
    })
  }

  @Remote
  async preview(
    windowToken: string,
    id: string,
    catalog: string | null,
    schema: string,
    table: string,
    page: number,
    pageSize: number,
    signal: AbortSignal,
  ): Promise<DatabaseResult> {
    if (
      !Number.isSafeInteger(page) ||
      page < 0 ||
      page > 10000 ||
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > DATABASE_LIMITS.previewRows
    )
      throw new Error('分页参数无效，每页最多 200 行')
    return this.runForEngine({
      windowToken,
      id,
      catalog,
      schema,
      build: engine => ({
        ...buildDesktopPreviewQuery({
          engine,
          schema,
          table,
          limit: pageSize,
          offset: page * pageSize,
        }),
        rows: pageSize,
      }),
      signal,
    })
  }

  @Remote
  async query(
    windowToken: string,
    id: string,
    catalog: string | null,
    schema: string | null,
    sql: string,
    signal: AbortSignal,
  ): Promise<DatabaseResult> {
    return this.runForEngine({
      windowToken,
      id,
      catalog,
      schema,
      build: engine => ({ sql: admitReadQuery(sql, engine), values: [] }),
      signal,
    })
  }

  private async closeConnection(id: string): Promise<void> {
    const operation = this.operations.get(id)
    if (!operation) return
    operation.controller.abort(new Error('数据库操作已取消'))
    await operation.done.catch(error => {
      if (error instanceof Error && error.message.includes('远端执行状态未知')) throw error
    })
  }

  private async closeOwned(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.operations.keys()].map(id => this.closeConnection(id)),
    )
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }

  @Remote
  async close(windowToken: string, id: string): Promise<boolean> {
    this.authorize(windowToken)
    keyOf(id)
    if (this.operations.get(id)?.lease)
      throw new Error('当前连接正在执行受会话授权的变更操作，请先取消或等待完成')
    await this.closeConnection(id)
    return true
  }

  @Remote
  async closeAll(windowToken: string): Promise<boolean> {
    this.authorize(windowToken)
    await Promise.all(
      [...this.operations.entries()]
        .filter(([, item]) => !item.lease)
        .map(([id]) => this.closeConnection(id)),
    )
    return true
  }
}

function tableKindFromType(tableType: string | null | undefined): DatabaseTable['kind'] {
  if (tableType === 'VIEW') return 'view'
  if (tableType === 'MATERIALIZED VIEW') return 'materialized_view'
  return 'table'
}

/** 数据库管理 Cordis 插件名称。 */
export const name = 'mydsh-database'

/** 数据库管理插件依赖的宿主服务。 */
export const inject = ['credentials', 'mydshConnectionSystem', 'mydshSsh']

/** 注册数据库后台服务到 Cordis 容器。 */
export function apply(ctx: Context): void {
  ctx.plugin(DatabaseConnections)
}
