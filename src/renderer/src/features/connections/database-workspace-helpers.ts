/** 数据库工作区纯辅助函数：多级缓存键生成、连接状态派生、对象类型中文标签、默认库筛选与 PostgreSQL 容错探测。 */
import type {
  DatabaseEngine,
  DatabaseProfile,
  DatabaseTable,
} from '../../../../../packages/connections/database/types.d.ts'

/** 数据库连接的界面可视状态。 */
export type DatabaseConnectionState =
  'disconnected' | 'connecting' | 'connected' | 'error' | 'disabled'

const SYSTEM_DATABASE_NAMESPACES = new Set([
  'information_schema',
  'pg_catalog',
  'pg_toast',
  'mysql',
  'performance_schema',
  'sys',
])

/** 派生单个数据库连接的实时可视状态（禁用、连接中、已连接、异常或未连接）。 */
export function resolveConnectionState(input: {
  profile: Pick<DatabaseProfile, 'id' | 'engine' | 'disabled'>
  view:
    | {
        catalogs?: string[] | null
        schemas?: string[] | null
        connectionError?: string | null
      }
    | undefined
  connectingId: string | null
  busyIds: readonly string[]
}): DatabaseConnectionState {
  if (input.profile.disabled) return 'disabled'
  const connected =
    input.profile.engine === 'postgresql'
      ? Boolean(input.view?.catalogs)
      : Boolean(input.view?.schemas)
  // 已加载结构的连接在执行查询或切换表时保持在线态，不闪烁回“连接中”并卸掉断开入口。
  if (connected) return 'connected'
  if (input.connectingId === input.profile.id || input.busyIds.includes(input.profile.id)) {
    return 'connecting'
  }
  if (input.view?.connectionError) return 'error'
  return 'disconnected'
}

/** 返回数据库连接状态对应的简短中文展示文案。 */
export function connectionStateLabel(state: DatabaseConnectionState): string {
  if (state === 'connected') return '已连接'
  if (state === 'connecting') return '连接中…'
  if (state === 'error') return '连接异常'
  if (state === 'disabled') return '已禁用'
  return '未连接'
}

/** 判断命名空间名称是否属于系统保留库，便于在侧栏以低饱和度区分业务库。 */
export function isSystemDatabaseNamespace(name: string): boolean {
  return SYSTEM_DATABASE_NAMESPACES.has(name.toLowerCase())
}

/** 生成表缓存键：PostgreSQL 按 `catalog\0schema` 隔离同名 Schema，其余直接返回 Schema。 */
export function databaseTableCacheKey(schema: string, catalog?: string | null): string {
  return catalog ? `${catalog}\0${schema}` : schema
}

/** 将表、视图与物化视图枚举转换为中文展示标签。 */
export function tableKindLabel(kind: DatabaseTable['kind']): string {
  if (kind === 'materialized_view') return '物化视图'
  if (kind === 'view') return '视图'
  return '表'
}

/** 按当前 Catalog 提取纯 Schema 键映射的表清单，供权限规则编辑器与树导航复用。 */
export function tablesBySchemaForCatalog(
  schemas: readonly string[] | null,
  tables: Readonly<Record<string, DatabaseTable[]>>,
  catalog: string | null,
): Record<string, DatabaseTable[]> {
  if (!schemas) return {}
  const mapped: Record<string, DatabaseTable[]> = {}
  for (const schema of schemas) {
    const entry = tables[databaseTableCacheKey(schema, catalog)]
    if (entry) mapped[schema] = entry
  }
  return mapped
}

/** 生成 PostgreSQL 默认库回退探测顺序，去重后优先尝试上次选择与配置默认库，再依次探测其余库。 */
export function orderPostgresCatalogCandidates(input: {
  catalogs: readonly string[]
  previous: string | null | undefined
  configured: string | null | undefined
}): string[] {
  const ordered = [input.previous, input.configured, ...input.catalogs]
  const seen = new Set<string>()
  const unique: string[] = []
  for (const candidate of ordered) {
    if (candidate && input.catalogs.includes(candidate) && !seen.has(candidate)) {
      seen.add(candidate)
      unique.push(candidate)
    }
  }
  return unique
}

/** 按上次选择、连接配置默认库与业务库优先顺序选出默认 PostgreSQL 数据库实例。 */
export function pickDefaultCatalog(input: {
  catalogs: readonly string[]
  previous: string | null | undefined
  configured: string | null | undefined
}): string | null {
  return orderPostgresCatalogCandidates(input)[0] ?? null
}

/** 按引擎规则选出默认打开的 Schema（业务命名空间排在系统库之前）。 */
export function pickDefaultSchema(input: {
  engine: DatabaseEngine
  schemas: readonly string[]
  previous: string | null | undefined
  configured: string | null | undefined
}): string | null {
  const { engine, schemas, previous, configured } = input
  if (previous && schemas.includes(previous)) return previous
  if (engine !== 'postgresql' && configured && schemas.includes(configured)) return configured
  if (engine === 'postgresql' && schemas.includes('public')) return 'public'
  return schemas[0] ?? null
}

/** 格式化查询历史中的库/Schema 作用域后缀。 */
export function formatHistoryScopeLabel(entry: {
  readonly catalog?: string | null
  readonly schema: string | null
}): string {
  if (entry.catalog && entry.schema) return ` · ${entry.catalog}.${entry.schema}`
  const single = entry.catalog ?? entry.schema
  return single ? ` · ${single}` : ''
}

/** 根据当前连接加载阶段返回表列表空态文案。 */
export function emptyTableMessage(input: {
  busy: boolean
  structureLoaded: boolean
  hasTablesEntry: boolean
  hasSchema: boolean
}): string {
  if (input.busy) return '正在读取数据库对象…'
  if (!input.structureLoaded) return '连接后，在左侧展开数据库并选择表。'
  if (input.hasTablesEntry) return '此数据库没有可见的表。'
  return input.hasSchema ? '尚未读取此数据库的表。' : '此连接没有可访问的数据库。'
}

/** 依次探测 PostgreSQL 候选库，遇到无权库（如 pg_hba/CONNECT 限制）时自动回退至下一个可用库。 */
export async function loadFirstAccessiblePostgresCatalog(input: {
  candidates: readonly string[]
  previousCatalog: string | null | undefined
  previousSchema: string | null | undefined
  configuredDatabase: string | null | undefined
  fetchSchemas: (catalog: string) => Promise<string[]>
  fetchTables: (catalog: string, schema: string) => Promise<DatabaseTable[]>
  messageOf: (error: unknown) => string
  signal?: AbortSignal
}): Promise<{
  catalog: string | null
  schemas: string[] | null
  schema: string | null
  tables: DatabaseTable[]
  error: string | null
}> {
  const tryIndex = async (
    index: number,
    firstError: string | null,
  ): Promise<{
    catalog: string | null
    schemas: string[] | null
    schema: string | null
    tables: DatabaseTable[]
    error: string | null
  }> => {
    if (input.signal?.aborted) {
      throw input.signal.reason ?? new DOMException('已取消', 'AbortError')
    }
    const catalog = input.candidates[index]
    if (!catalog) {
      return { catalog: null, schemas: null, schema: null, tables: [], error: firstError }
    }
    try {
      const schemas = await input.fetchSchemas(catalog)
      const schema = pickDefaultSchema({
        engine: 'postgresql',
        schemas,
        previous: input.previousCatalog === catalog ? input.previousSchema : null,
        configured: input.configuredDatabase,
      })
      const tables = schema ? await input.fetchTables(catalog, schema) : []
      return { catalog, schemas, schema, tables, error: null }
    } catch (cause) {
      if (input.signal?.aborted) throw cause
      return tryIndex(index + 1, firstError ?? input.messageOf(cause))
    }
  }
  return tryIndex(0, null)
}
