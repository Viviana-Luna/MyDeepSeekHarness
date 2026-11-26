/** 数据库多引擎方言工具：提供引擎规范化、系统库边界、标识符引用及元数据查询构造。 */
import type { DatabaseEngine, DatabaseProfile } from '../types.d.ts'

/** 受支持的四种主流关系型数据库引擎列表。 */
export const DATABASE_ENGINES: readonly DatabaseEngine[] = [
  'mysql',
  'mariadb',
  'postgresql',
  'sqlite',
] as const

const ENGINE_LABELS: Readonly<Record<DatabaseEngine, string>> = {
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  postgresql: 'PostgreSQL',
  sqlite: 'SQLite',
}

const MYSQL_SYSTEM_SCHEMAS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys'])
const POSTGRES_SYSTEM_SCHEMAS = new Set(['information_schema', 'pg_catalog', 'pg_toast'])
const SQLITE_SYSTEM_SCHEMAS = new Set([
  'sqlite_master',
  'sqlite_schema',
  'sqlite_temp_master',
  'sqlite_temp_schema',
])

/** 判断当前操作系统是否在跨平台连接支持范围内（macOS 与 Windows）。 */
export function isSupportedConnectionPlatform(platform: string = process.platform): boolean {
  return platform === 'darwin' || platform === 'win32'
}

/** 将可选或持久化配置中的引擎字段规范化，缺省视为 MySQL 以兼容旧版数据。 */
export function normalizeEngine(value: unknown): DatabaseEngine {
  if (value === undefined) return 'mysql'
  if (typeof value === 'string' && DATABASE_ENGINES.includes(value as DatabaseEngine)) {
    return value as DatabaseEngine
  }
  throw new Error('不支持的数据库引擎类型，仅支持 mysql、mariadb、postgresql 与 sqlite')
}

/** 判断指定数据库引擎是否通过网络端口（直连或 SSH 隧道）访问。 */
export function isNetworkEngine(engine: DatabaseEngine): boolean {
  return engine !== 'sqlite'
}

/** 返回引擎用于界面与错误提示的标准展示名称。 */
export function engineDisplayName(engine: DatabaseEngine): string {
  return ENGINE_LABELS[engine]
}

/** 返回不同数据库引擎的默认端口号；SQLite 本地文件固定返回 0。 */
export function defaultPortForEngine(engine: DatabaseEngine): number {
  if (engine === 'postgresql') return 5432
  if (engine === 'sqlite') return 0
  return 3306
}

/** 返回连接引擎所需的默认连接数据库名（PostgreSQL 默认连接 postgres）。 */
export function defaultDatabaseForEngine(engine: DatabaseEngine): string | null {
  return engine === 'postgresql' ? 'postgres' : null
}

/** 校验数据库、表或列名是否为合法且无控制字符的非空标识符。 */
export function validateIdentifierName(value: string, message = '数据库或表名称无效'): void {
  if (
    typeof value !== 'string' ||
    !value ||
    !value.trim() ||
    value.length > 64 ||
    /[\u0000-\u001f]/u.test(value)
  )
    throw new Error(message)
}

/** 按目标引擎语法对标识符加引号并转义内部引号字符。 */
export function quoteIdentifier(value: string, engine: DatabaseEngine = 'mysql'): string {
  validateIdentifierName(value)
  if (engine === 'postgresql' || engine === 'sqlite') return `"${value.replaceAll('"', '""')}"`
  return `\`${value.replaceAll('`', '``')}\``
}

/** 返回该引擎下用于过滤列表的系统保留命名空间集合。 */
export function systemSchemasForEngine(engine: DatabaseEngine): readonly string[] {
  if (engine === 'postgresql') return [...POSTGRES_SYSTEM_SCHEMAS]
  if (engine === 'sqlite') return [...SQLITE_SYSTEM_SCHEMAS]
  return [...MYSQL_SYSTEM_SCHEMAS]
}

/** 判断指定名称是否属于当前引擎禁止模型访问的系统保留库/命名空间。 */
export function isSystemSchema(schema: string, engine: DatabaseEngine = 'mysql'): boolean {
  const lower = schema.toLowerCase()
  if (engine === 'postgresql') {
    return (
      POSTGRES_SYSTEM_SCHEMAS.has(lower) ||
      lower.startsWith('pg_temp_') ||
      lower.startsWith('pg_toast_temp_')
    )
  }
  if (engine === 'sqlite') {
    return SQLITE_SYSTEM_SCHEMAS.has(lower) || lower.startsWith('sqlite_')
  }
  return MYSQL_SYSTEM_SCHEMAS.has(lower)
}

/** 判断具体数据表名是否为内部保留表（如 SQLite 的 sqlite_* 元数据表）。 */
export function isSystemTable(table: string, engine: DatabaseEngine = 'mysql'): boolean {
  if (engine === 'sqlite') return table.toLowerCase().startsWith('sqlite_')
  return false
}

/** 计算模型 SQL 默认表解析使用的 Schema 名称，并校验显式入参。 */
export function resolveDefaultSqlSchema(
  profile: DatabaseProfile,
  requestedDatabase: string | null,
): string | null {
  if (profile.engine === 'sqlite') {
    if (requestedDatabase !== null && requestedDatabase !== 'main') {
      throw new Error('SQLite 本地数据库仅支持 main 命名空间')
    }
    return 'main'
  }
  if (profile.engine === 'postgresql') {
    return requestedDatabase ?? 'public'
  }
  return requestedDatabase ?? profile.database
}

/** 判断数据库引擎是否支持实例下的独立数据库（Catalog）导航层级。 */
export function supportsCatalogLevel(engine: DatabaseEngine): boolean {
  return engine === 'postgresql'
}

/** 计算底层驱动建立会话时应连接的数据库名称（区别于 PostgreSQL Schema）。 */
export function connectionDatabaseForRun(
  profile: DatabaseProfile,
  selectedSchema: string | null,
  options?: { catalog?: string | null; omitDefaultDatabase?: boolean },
): string | null {
  if (profile.engine === 'sqlite') return null
  if (profile.engine === 'postgresql') {
    return options?.catalog?.trim() || profile.database?.trim() || 'postgres'
  }
  if (options?.omitDefaultDatabase) return null
  return selectedSchema ?? profile.database
}

/** 构造各引擎连接测试探活的只读 SQL。 */
export function buildTestQuery(engine: DatabaseEngine): string {
  if (engine === 'postgresql') return 'SELECT version() AS version'
  if (engine === 'sqlite') return 'SELECT sqlite_version() AS version'
  return 'SELECT VERSION() AS version'
}

/** 将各引擎版本返回值整理为清晰且不含重复前缀的展示文本。 */
export function formatVersionLabel(engine: DatabaseEngine, raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return engineDisplayName(engine)
  if (engine === 'postgresql') {
    const beforeHost = trimmed.split(/\s+on\s+/iu)[0]?.trim() ?? trimmed
    return /^postgresql\b/iu.test(beforeHost) ? beforeHost : `PostgreSQL ${beforeHost}`
  }
  if (engine === 'sqlite') {
    return /^sqlite\b/iu.test(trimmed) ? trimmed : `SQLite ${trimmed}`
  }
  if (engine === 'mariadb') {
    return /mariadb/iu.test(trimmed) ? trimmed : `MariaDB ${trimmed}`
  }
  return trimmed
}

/** 构造桌面工作区列出顶层数据库实例列表的查询计划（PostgreSQL 查 pg_database，其余复用 Schema 列表）。 */
export function buildDesktopDatabasesQuery(engine: DatabaseEngine): {
  sql: string
  values: unknown[]
} {
  if (engine === 'postgresql') {
    return {
      // 桌面端完整展示所有非模板物理库（与 DBX 对齐），同时将当前账号有 CONNECT 权限的库排在首位避免默认打开即报错。
      sql: "SELECT datname FROM pg_database WHERE datistemplate = false AND datallowconn = true ORDER BY CASE WHEN pg_catalog.has_database_privilege(oid, 'CONNECT') THEN 0 ELSE 1 END, CASE WHEN datname = 'postgres' THEN 1 ELSE 0 END, datname",
      values: [],
    }
  }
  return buildDesktopSchemasQuery(engine)
}

/** 构造桌面工作区列出 Schema 列表的查询计划（业务命名空间排在系统库之前）。 */
export function buildDesktopSchemasQuery(engine: DatabaseEngine): {
  sql: string
  values: unknown[]
} {
  if (engine === 'sqlite') {
    return { sql: "SELECT 'main' AS schema_name", values: [] }
  }
  if (engine === 'postgresql') {
    return {
      sql: [
        'SELECT schema_name FROM information_schema.schemata',
        "WHERE schema_name NOT LIKE 'pg_toast%' AND schema_name NOT LIKE 'pg_temp_%'",
        "ORDER BY CASE WHEN schema_name = 'public' THEN 0 WHEN schema_name IN ('information_schema', 'pg_catalog') THEN 2 ELSE 1 END, schema_name",
      ].join(' '),
      values: [],
    }
  }
  return {
    sql: "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY CASE WHEN LOWER(SCHEMA_NAME) IN ('information_schema', 'mysql', 'performance_schema', 'sys') THEN 1 ELSE 0 END, SCHEMA_NAME",
    values: [],
  }
}

/** 构造桌面工作区读取指定 Schema 下表、视图与物化视图列表的查询计划。 */
export function buildDesktopTablesQuery(
  engine: DatabaseEngine,
  schema: string,
): { sql: string; values: unknown[] } {
  validateIdentifierName(schema)
  if (engine === 'sqlite') {
    if (schema !== 'main') throw new Error('SQLite 仅包含 main 数据库')
    return {
      sql: "SELECT name, CASE WHEN type = 'view' THEN 'VIEW' ELSE 'BASE TABLE' END AS table_type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
      values: [],
    }
  }
  if (engine === 'postgresql') {
    return {
      sql: [
        'SELECT table_name, table_type FROM (',
        'SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = $1',
        'UNION ALL',
        "SELECT matviewname AS table_name, 'MATERIALIZED VIEW' AS table_type FROM pg_catalog.pg_matviews WHERE schemaname = $1",
        ') AS objects ORDER BY table_name',
      ].join(' '),
      values: [schema],
    }
  }
  return {
    sql: 'SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
    values: [schema],
  }
}

/** 构造桌面工作区读取表、视图及物化视图字段元数据的查询计划。 */
export function buildDesktopColumnsQuery(
  engine: DatabaseEngine,
  schema: string,
  table: string,
): { sql: string; values: unknown[] } {
  validateIdentifierName(schema)
  validateIdentifierName(table)
  if (engine === 'sqlite') {
    if (schema !== 'main') throw new Error('SQLite 仅包含 main 数据库')
    return { sql: `PRAGMA table_info(${quoteIdentifier(table, 'sqlite')})`, values: [] }
  }
  if (engine === 'postgresql') {
    return {
      sql: [
        'SELECT a.attname AS column_name,',
        'pg_catalog.format_type(a.atttypid, a.atttypmod) AS column_type,',
        "CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable,",
        "CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_index ix WHERE ix.indrelid = c.oid AND ix.indisprimary AND a.attnum = ANY((ix.indkey::int2[])[1:ix.indnkeyatts])) THEN 'PRI' ELSE '' END AS column_key",
        'FROM pg_catalog.pg_class c',
        'JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace',
        'JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid',
        "WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND a.attnum > 0 AND NOT a.attisdropped",
        'ORDER BY a.attnum',
      ].join(' '),
      values: [schema, table],
    }
  }
  return {
    sql: 'SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
    values: [schema, table],
  }
}

/** 构造桌面工作区分页预览表数据的查询计划。 */
export function buildDesktopPreviewQuery(input: {
  engine: DatabaseEngine
  schema: string
  table: string
  limit: number
  offset: number
}): { sql: string; values: unknown[] } {
  const { engine, schema, table, limit, offset } = input
  const qualified = `${quoteIdentifier(schema, engine)}.${quoteIdentifier(table, engine)}`
  if (engine === 'sqlite' && schema !== 'main') throw new Error('SQLite 仅包含 main 数据库')
  const placeholderSql =
    engine === 'postgresql'
      ? `SELECT * FROM ${qualified} LIMIT $1 OFFSET $2`
      : `SELECT * FROM ${qualified} LIMIT ? OFFSET ?`
  return { sql: placeholderSql, values: [limit + 1, offset] }
}
