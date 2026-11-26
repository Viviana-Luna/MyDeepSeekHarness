/** 支持接入与治理的数据库引擎类型。 */
export type DatabaseEngine = 'mysql' | 'mariadb' | 'postgresql' | 'sqlite'

/** 数据库工作区与模型工具的公开类型；密码仅作为写入参数，状态与配置均不包含凭据。 */

/** 单个数据库或数据表支持的五类模型权限。 */
export type DatabasePermissionKey = 'select' | 'insert' | 'update' | 'delete' | 'ddl'

/** 数据库连接的模型访问档位；表级规则只能在档位允许的范围内进一步收窄。 */
export type DatabaseAgentAccessMode = 'readonly' | 'readwrite' | 'full'

/** 允许在变更工具中执行的操作类别。 */
export type DatabaseMutationOperation = 'insert' | 'update' | 'delete' | 'ddl'

/** 针对单个库表或默认规则的细粒度读写与结构变更开关。 */
export interface DatabasePermissionFlags {
  select: boolean
  insert: boolean
  update: boolean
  delete: boolean
  ddl: boolean
}

/** 针对指定库或表的权限覆盖规则；table 为 `*` 时表示匹配该库下全部表。 */
export interface DatabaseTablePermission extends DatabasePermissionFlags {
  schema: string
  table: string
}

/** 保存在连接配置中的模型访问策略，由用户在「数据库」模式配置。 */
export interface DatabaseAgentAccess {
  enabled: boolean
  mode: DatabaseAgentAccessMode
  tableRules: DatabaseTablePermission[]
}

/** 公开数据库连接档案，不包含密码或密文。 */
export interface DatabaseProfile {
  id: string
  revision: number
  engine: DatabaseEngine
  name: string
  host: string
  port: number
  username: string
  database: string | null
  filePath: string | null
  tlsEnabled: boolean
  tlsServerName: string
  tlsCa: string
  sshConnectionId: string | null
  environment: string
  projectId: string | null
  disabled: boolean
  credentialConfigured: boolean
  agentAccess: DatabaseAgentAccess
}

/** 创建或保存数据库连接时的请求参数；缺省引擎与本地路径默认按兼容模式处理。 */
export interface SaveDatabaseProfile extends Omit<
  DatabaseProfile,
  'id' | 'revision' | 'engine' | 'filePath' | 'credentialConfigured' | 'agentAccess'
> {
  id: string | null
  revision: number | null
  engine?: DatabaseEngine
  filePath?: string | null
  password?: string
  agentAccess?: DatabaseAgentAccess
}

/** 后台向桌面提供的数据库连接列表状态。 */
export interface DatabaseStatus {
  supported: boolean
  connections: DatabaseProfile[]
  busyIds: string[]
}

/** 数据库对象树中的表、视图或物化视图摘要。 */
export interface DatabaseTable {
  name: string
  kind: 'table' | 'view' | 'materialized_view'
}

/** 数据表的字段元数据摘要。 */
export interface DatabaseColumn {
  name: string
  type: string
  nullable: boolean
  key: string
}

/** 单条读取查询的表格结果，保持精确文本格式与截断标记。 */
export interface DatabaseResult {
  columns: { name: string; type: string }[]
  /** 数值和时间保留数据库文本；二进制使用 0x 十六进制，SQL NULL 保持 null。 */
  rows: (string | null)[][]
  rowCount: number
  bytes: number
  truncated: boolean
  elapsedMs: number
}

/** 连接测试返回的服务器版本信息。 */
export interface DatabaseTestResult {
  serverVersion: string
}

/** 模型只读结构读取请求；只接受固定动作，不接受 SQL。 */
export interface DatabaseStructureRequest {
  action: 'databases' | 'schemas' | 'tables' | 'columns' | 'indexes'
  database?: string
  schema?: string
  table?: string
  offset: number
  limit: number
}

/** 单条 SQL 语句提取出的权限校验目标。 */
export interface DatabaseStatementTarget {
  schema: string
  table: string
  operation: DatabasePermissionKey
}

/** 批量变更中单条语句的执行结果。 */
export interface DatabaseMutationResultItem {
  index: number
  operation: DatabaseMutationOperation
  schema: string
  table: string
  sql: string
  affectedRows: number
  changedRows: number
  insertId: string | null
}

/** 批量变更工具返回给模型的有界执行摘要。 */
export interface DatabaseBatchMutationResult {
  results: DatabaseMutationResultItem[]
  totalAffectedRows: number
  rolledBack: boolean
  hasDdl: boolean
  elapsedMs: number
  warning?: string
}
