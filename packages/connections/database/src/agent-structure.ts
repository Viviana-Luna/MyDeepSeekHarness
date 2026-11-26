/** 后台数据库结构准入与固定查询模板：按引擎生成受权限过滤的元数据计划，不接受任意 SQL。 */
import type { DatabaseAgentAccess, DatabaseEngine, DatabaseStructureRequest } from '../types.d.ts'
import {
  canListSchema,
  isSystemSchema,
  permissionsForMode,
  resolveTablePermissions,
  type DatabasePermissionElevation,
} from './agent-policy.ts'
import { isSystemTable, quoteIdentifier, systemSchemasForEngine } from './dialect.ts'

/** 经过权限过滤并生成的结构查询计划。 */
export interface DatabaseStructurePlan {
  readonly sql: string
  readonly values: unknown[]
  readonly rows: number
  readonly schema: string | null
  readonly catalog?: string | null
  readonly postFilterSqlitePragma?: 'columns' | 'indexes'
}

/** 结构行过滤附加选项，兼容旧版直接传入提权对象或传具名配置。 */
export type StructureFilterOptions =
  | DatabasePermissionElevation
  | {
      readonly elevation?: DatabasePermissionElevation
      readonly engine?: DatabaseEngine
    }

/** 将数据库工具的公开参数转换为经过分页字段补齐的结构读取请求。 */
export function databaseStructureRequestFromArguments(args: {
  action: DatabaseStructureRequest['action']
  database?: string
  schema?: string
  table?: string
  offset: number
  limit: number
}): DatabaseStructureRequest {
  return {
    action: args.action,
    offset: args.offset,
    limit: args.limit,
    ...(args.database === undefined ? {} : { database: args.database }),
    ...(args.schema === undefined ? {} : { schema: args.schema }),
    ...(args.table === undefined ? {} : { table: args.table }),
  }
}

function validateStructureRequest(request: DatabaseStructureRequest): void {
  if (
    !['databases', 'schemas', 'tables', 'columns', 'indexes'].includes(request.action) ||
    !Number.isSafeInteger(request.offset) ||
    request.offset < 0 ||
    request.offset > 1_000_000 ||
    !Number.isInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > 100
  )
    throw new Error('结构读取动作或分页参数无效')
}

/** 校验结构读取请求参数与系统库硬边界；必须在进入权限提权前调用。 */
export function assertStructureRequestValid(
  request: DatabaseStructureRequest,
  engine: DatabaseEngine = 'mysql',
): void {
  validateStructureRequest(request)
  if (request.database !== undefined) {
    if (request.database !== request.database.trim())
      throw new Error('database 参数不能包含首尾空白')
    quoteIdentifier(request.database, engine)
    if (engine === 'sqlite' && request.database !== 'main')
      throw new Error('SQLite 本地数据库仅包含 main 命名空间')
    if (
      engine === 'postgresql' &&
      ['template0', 'template1'].includes(request.database.trim().toLowerCase())
    )
      throw new Error('PERMISSION_DENIED：系统模板库不允许模型访问')
    if (engine !== 'postgresql' && isSystemSchema(request.database, engine))
      throw new Error(`PERMISSION_DENIED：系统库 ${request.database} 不允许模型读取`)
  }
  if (request.action === 'databases') {
    if (
      request.database !== undefined ||
      request.schema !== undefined ||
      request.table !== undefined
    )
      throw new Error('列出数据库实例时不接受库表定位参数')
    return
  }
  if (request.action === 'schemas') {
    if (request.schema !== undefined || request.table !== undefined)
      throw new Error('列出数据库时不接受库表定位参数')
    if (engine !== 'postgresql' && request.database !== undefined)
      throw new Error('当前引擎列出数据库时不接受 database 参数')
    return
  }
  if (typeof request.schema !== 'string')
    throw new Error(`执行 ${request.action} 结构读取时必须提供 schema 参数`)
  if (request.schema !== request.schema.trim()) throw new Error('schema 参数不能包含首尾空白')
  if (
    engine !== 'postgresql' &&
    request.database !== undefined &&
    request.database !== request.schema
  )
    throw new Error('当前引擎下 database 与 schema 指向同一个命名空间，不能同时传入不同名称')
  quoteIdentifier(request.schema, engine)
  if (engine === 'sqlite' && request.schema !== 'main')
    throw new Error('SQLite 本地数据库仅包含 main 命名空间')
  if (isSystemSchema(request.schema, engine))
    throw new Error(`PERMISSION_DENIED：系统库 ${request.schema} 不允许模型读取`)
  if (request.action === 'tables') {
    if (request.table !== undefined) throw new Error('列出数据表时不接受 table 参数')
    return
  }
  if (typeof request.table !== 'string')
    throw new Error(`执行 ${request.action} 结构读取时必须同时提供 schema 和 table 参数`)
  if (request.table !== request.table.trim()) throw new Error('table 参数不能包含首尾空白')
  quoteIdentifier(request.table, engine)
  if (isSystemTable(request.table, engine))
    throw new Error(`PERMISSION_DENIED：系统保留表 ${request.table} 不允许模型读取`)
}

function hasAnyReadGrant(
  access: DatabaseAgentAccess,
  elevation?: DatabasePermissionElevation,
): boolean {
  return (
    permissionsForMode(access.mode).select ||
    Boolean(elevation?.connectionPermissions?.select) ||
    access.tableRules.some(rule => rule.select) ||
    Boolean(elevation?.targets?.some(rule => rule.select))
  )
}

function buildDatabasesQuery(input: {
  access: DatabaseAgentAccess
  engine: DatabaseEngine
  limit: number
  offset: number
  elevation?: DatabasePermissionElevation
}): { sql: string; values: unknown[] } {
  if (input.engine === 'postgresql') {
    if (!hasAnyReadGrant(input.access, input.elevation)) {
      throw new Error('PERMISSION_DENIED：当前连接的模型权限策略未开放任何数据库读取权限')
    }
    return {
      sql: "SELECT datname FROM pg_catalog.pg_database WHERE datistemplate = false AND datallowconn = true AND LOWER(datname) NOT IN ('template0', 'template1') AND (pg_catalog.has_database_privilege(oid, 'CONNECT') OR datname = pg_catalog.current_database()) ORDER BY CASE WHEN datname = 'postgres' THEN 1 ELSE 0 END, datname LIMIT $1 OFFSET $2",
      values: [input.limit + 1, input.offset],
    }
  }
  return buildSchemasQuery(input)
}

function placeholders(count: number, engine: DatabaseEngine, startIndex = 1): string {
  if (engine === 'postgresql') {
    return Array.from({ length: count }, (_, idx) => `$${startIndex + idx}`).join(',')
  }
  return Array.from({ length: count }, () => '?').join(',')
}

function elevatedSchemaSelect(
  elevation: DatabasePermissionElevation | undefined,
  schema: string,
): boolean {
  if (elevation?.connectionPermissions?.select) return true
  const targetSchema = schema.toLowerCase()
  return (
    elevation?.targets?.some(rule => rule.schema.toLowerCase() === targetSchema && rule.select) ??
    false
  )
}

function buildSchemasQuery(input: {
  access: DatabaseAgentAccess
  engine: DatabaseEngine
  limit: number
  offset: number
  elevation?: DatabasePermissionElevation
}): { sql: string; values: unknown[] } {
  const { access, engine, limit, offset, elevation } = input
  if (engine === 'sqlite') {
    if (!canListSchema(access, 'main', elevation, 'sqlite')) {
      throw new Error('PERMISSION_DENIED：当前连接的模型权限策略未开放任何数据库读取权限')
    }
    return {
      sql: "SELECT 'main' AS schema_name LIMIT ? OFFSET ?",
      values: [limit + 1, offset],
    }
  }
  const excludedSchemas = new Set(systemSchemasForEngine(engine))
  for (const rule of access.tableRules) {
    if (
      rule.table === '*' &&
      !rule.select &&
      !canListSchema(access, rule.schema, elevation, engine) &&
      !elevatedSchemaSelect(elevation, rule.schema)
    )
      excludedSchemas.add(rule.schema.toLowerCase())
  }
  const values: unknown[] = [...excludedSchemas]
  const schemaExpr = engine === 'postgresql' ? 'schema_name' : 'SCHEMA_NAME'
  let sql =
    engine === 'postgresql'
      ? `SELECT ${schemaExpr} FROM information_schema.schemata WHERE LOWER(${schemaExpr}) NOT IN (${placeholders(values.length, engine)}) AND LOWER(${schemaExpr}) NOT LIKE 'pg_temp_%' AND LOWER(${schemaExpr}) NOT LIKE 'pg_toast_temp_%'`
      : `SELECT ${schemaExpr} FROM information_schema.SCHEMATA WHERE LOWER(${schemaExpr}) NOT IN (${placeholders(values.length, engine)})`
  if (!permissionsForMode(access.mode).select && !elevation?.connectionPermissions?.select) {
    const allowed = [
      ...new Set(
        [
          ...access.tableRules.filter(rule => rule.select),
          ...(elevation?.targets ?? []).filter(rule => rule.select),
        ].map(rule => rule.schema.toLowerCase()),
      ),
    ]
    if (allowed.length === 0)
      throw new Error('PERMISSION_DENIED：当前连接的模型权限策略未开放任何数据库读取权限')
    sql += ` AND LOWER(${schemaExpr}) IN (${placeholders(allowed.length, engine, values.length + 1)})`
    values.push(...allowed)
  }
  const orderCol = engine === 'postgresql' ? schemaExpr : `CAST(${schemaExpr} AS BINARY)`
  const limitExpr = engine === 'postgresql' ? `$${values.length + 1}` : '?'
  const offsetExpr = engine === 'postgresql' ? `$${values.length + 2}` : '?'
  sql += ` ORDER BY ${orderCol} LIMIT ${limitExpr} OFFSET ${offsetExpr}`
  values.push(limit + 1, offset)
  return { sql, values }
}

function resolveTableVisibility(input: {
  access: DatabaseAgentAccess
  schema: string
  elevation?: DatabasePermissionElevation
  engine: DatabaseEngine
}): { defaultSelect: boolean; denied: string[]; allowed: string[] } {
  const { access, schema, elevation, engine } = input
  if (!canListSchema(access, schema, elevation, engine))
    throw new Error(`PERMISSION_DENIED：当前连接的模型权限策略不允许读取数据库 ${schema}`)
  const targetSchema = schema.toLowerCase()
  const wildcard = access.tableRules.find(
    rule => rule.schema.toLowerCase() === targetSchema && rule.table === '*',
  )
  const exactRules = access.tableRules.filter(
    rule => rule.schema.toLowerCase() === targetSchema && rule.table !== '*',
  )
  const elevatedSelects = (elevation?.targets ?? []).filter(
    rule => rule.schema.toLowerCase() === targetSchema && rule.select,
  )
  const defaultSelect = Boolean(
    elevation?.connectionPermissions?.select ||
    elevatedSelects.some(rule => rule.table === '*') ||
    (wildcard ? wildcard.select : permissionsForMode(access.mode).select),
  )
  const elevatedTables = new Set(elevatedSelects.map(rule => rule.table.toLowerCase()))
  const denied = [
    ...new Set(
      exactRules
        .filter(rule => !rule.select && !elevatedTables.has(rule.table.toLowerCase()))
        .map(rule => rule.table.toLowerCase()),
    ),
  ]
  const allowed = [
    ...new Set(
      [...exactRules.filter(rule => rule.select), ...elevatedSelects].map(rule =>
        rule.table.toLowerCase(),
      ),
    ),
  ]
  return { defaultSelect, denied, allowed }
}

function buildTablesQuery(input: {
  access: DatabaseAgentAccess
  schema: string
  engine: DatabaseEngine
  limit: number
  offset: number
  elevation?: DatabasePermissionElevation
}): { sql: string; values: unknown[] } {
  const { access, schema, engine, limit, offset, elevation } = input
  quoteIdentifier(schema, engine)
  const { defaultSelect, denied, allowed } = resolveTableVisibility({
    access,
    schema,
    engine,
    ...(elevation ? { elevation } : {}),
  })
  if (engine === 'sqlite') {
    let sql =
      "SELECT name, CASE WHEN type = 'view' THEN 'VIEW' ELSE 'BASE TABLE' END AS table_type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'"
    const values: unknown[] = []
    if (defaultSelect && denied.length > 0) {
      sql += ` AND LOWER(name) NOT IN (${placeholders(denied.length, engine)})`
      values.push(...denied)
    } else if (!defaultSelect) {
      sql += ` AND LOWER(name) IN (${placeholders(allowed.length, engine)})`
      values.push(...allowed)
    }
    sql += ' ORDER BY name LIMIT ? OFFSET ?'
    values.push(limit + 1, offset)
    return { sql, values }
  }
  const isPg = engine === 'postgresql'
  const tableCol = isPg ? 'table_name' : 'TABLE_NAME'
  let sql = isPg
    ? "SELECT table_name, table_type FROM (SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = $1 UNION ALL SELECT c.relname AS table_name, 'MATERIALIZED VIEW' AS table_type FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'm' AND (pg_catalog.pg_has_role(c.relowner, 'USAGE') OR pg_catalog.has_table_privilege(c.oid, 'SELECT'))) t WHERE 1=1"
    : 'SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE CAST(TABLE_SCHEMA AS BINARY) = ?'
  const values: unknown[] = [schema]
  if (defaultSelect && denied.length > 0) {
    sql += ` AND LOWER(${tableCol}) NOT IN (${placeholders(denied.length, engine, 2)})`
    values.push(...denied)
  } else if (!defaultSelect) {
    sql += ` AND LOWER(${tableCol}) IN (${placeholders(allowed.length, engine, 2)})`
    values.push(...allowed)
  }
  const orderCol = isPg ? tableCol : `CAST(${tableCol} AS BINARY)`
  const limitExpr = isPg ? `$${values.length + 1}` : '?'
  const offsetExpr = isPg ? `$${values.length + 2}` : '?'
  sql += ` ORDER BY ${orderCol} LIMIT ${limitExpr} OFFSET ${offsetExpr}`
  values.push(limit + 1, offset)
  return { sql, values }
}

function buildTableDetailQuery(input: {
  access: DatabaseAgentAccess
  action: 'columns' | 'indexes'
  schema: string | undefined
  table: string | undefined
  engine: DatabaseEngine
  limit: number
  offset: number
  elevation?: DatabasePermissionElevation
}): { sql: string; values: unknown[]; postFilterSqlitePragma?: 'columns' | 'indexes' } {
  const { access, action, schema, table, engine, limit, offset, elevation } = input
  if (typeof schema !== 'string' || typeof table !== 'string')
    throw new Error(`执行 ${action} 结构读取时必须同时提供 schema 和 table 参数`)
  quoteIdentifier(schema, engine)
  quoteIdentifier(table, engine)
  if (!resolveTablePermissions(access, schema, table, elevation, engine).select)
    throw new Error(`PERMISSION_DENIED：当前连接的模型权限策略不允许读取 ${schema}.${table} 的结构`)
  if (engine === 'sqlite') {
    const quotedTable = quoteIdentifier(table, 'sqlite')
    return {
      sql:
        action === 'columns'
          ? `PRAGMA table_info(${quotedTable})`
          : `PRAGMA index_list(${quotedTable})`,
      values: [],
      postFilterSqlitePragma: action,
    }
  }
  if (engine === 'postgresql') {
    const sql =
      action === 'columns'
        ? [
            'SELECT a.attname AS column_name,',
            'pg_catalog.format_type(a.atttypid, a.atttypmod) AS column_type,',
            "CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable,",
            "CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_index ix WHERE ix.indrelid = c.oid AND ix.indisprimary AND a.attnum = ANY((ix.indkey::int2[])[1:ix.indnkeyatts])) THEN 'PRI' ELSE '' END AS column_key",
            'FROM pg_catalog.pg_class c',
            'JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace',
            'JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid',
            "WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND a.attnum > 0 AND NOT a.attisdropped",
            "AND (pg_catalog.pg_has_role(c.relowner, 'USAGE') OR pg_catalog.has_table_privilege(c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') OR pg_catalog.has_any_column_privilege(c.oid, 'SELECT, INSERT, UPDATE, REFERENCES'))",
            'ORDER BY a.attnum LIMIT $3 OFFSET $4',
          ].join(' ')
        : [
            'SELECT i.relname AS index_name,',
            "COALESCE(a.attname, '(expr)') AS column_name,",
            'k.ord::text AS seq_in_index,',
            "CASE WHEN ix.indisunique THEN '0' ELSE '1' END AS non_unique",
            'FROM pg_catalog.pg_class t',
            'JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace',
            'JOIN pg_catalog.pg_index ix ON ix.indrelid = t.oid',
            'JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid',
            'JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true',
            'LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum',
            'WHERE n.nspname = $1 AND t.relname = $2 ORDER BY i.relname, k.ord LIMIT $3 OFFSET $4',
          ].join(' ')
    return { sql, values: [schema, table, limit + 1, offset] }
  }
  const sql =
    action === 'columns'
      ? 'SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY FROM information_schema.COLUMNS WHERE CAST(TABLE_SCHEMA AS BINARY) = ? AND CAST(TABLE_NAME AS BINARY) = ? ORDER BY ORDINAL_POSITION LIMIT ? OFFSET ?'
      : 'SELECT INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX, NON_UNIQUE FROM information_schema.STATISTICS WHERE CAST(TABLE_SCHEMA AS BINARY) = ? AND CAST(TABLE_NAME AS BINARY) = ? ORDER BY CAST(INDEX_NAME AS BINARY), SEQ_IN_INDEX LIMIT ? OFFSET ?'
  return { sql, values: [schema, table, limit + 1, offset] }
}

/** 按连接配置的表级权限构造元数据查询；系统库与未授权库表在 SQL 端过滤。 */
export function databaseStructureQuery(
  access: DatabaseAgentAccess,
  request: DatabaseStructureRequest,
  elevation?: DatabasePermissionElevation,
  engine: DatabaseEngine = 'mysql',
): DatabaseStructurePlan {
  if (!access.enabled) throw new Error('PERMISSION_DENIED：当前连接未开放给模型调用')
  assertStructureRequestValid(request, engine)
  const shared = {
    access,
    engine,
    limit: request.limit,
    offset: request.offset,
    ...(elevation ? { elevation } : {}),
  }
  const catalog = engine === 'postgresql' ? (request.database ?? null) : null
  if (request.action === 'databases') {
    const built = buildDatabasesQuery(shared)
    return {
      sql: built.sql,
      values: built.values,
      rows: request.limit + 1,
      schema: null,
      catalog: null,
    }
  }
  if (request.action === 'schemas') {
    const built = buildSchemasQuery(shared)
    return { sql: built.sql, values: built.values, rows: request.limit + 1, schema: null, catalog }
  }
  const schema = request.schema!
  if (request.action === 'tables') {
    const built = buildTablesQuery({ ...shared, schema })
    return { sql: built.sql, values: built.values, rows: request.limit + 1, schema, catalog }
  }
  const built = buildTableDetailQuery({
    ...shared,
    action: request.action,
    schema,
    table: request.table,
  })
  return {
    sql: built.sql,
    values: built.values,
    rows: engine === 'sqlite' ? 500 : request.limit + 1,
    schema,
    catalog,
    ...(built.postFilterSqlitePragma
      ? { postFilterSqlitePragma: built.postFilterSqlitePragma }
      : {}),
  }
}

function parseFilterOptions(options?: StructureFilterOptions): {
  elevation?: DatabasePermissionElevation
  engine: DatabaseEngine
} {
  if (!options) return { engine: 'mysql' }
  if ('engine' in options || 'elevation' in options) {
    const shaped = options as { elevation?: DatabasePermissionElevation; engine?: DatabaseEngine }
    return {
      engine: shaped.engine ?? 'mysql',
      ...(shaped.elevation ? { elevation: shaped.elevation } : {}),
    }
  }
  return { elevation: options as DatabasePermissionElevation, engine: 'mysql' }
}

/** 对返回的结构元数据行执行二次纵深权限过滤，避免大小写规则差异泄露库表名。 */
export function filterStructureRows(
  access: DatabaseAgentAccess,
  request: DatabaseStructureRequest,
  rows: (string | null)[][],
  options?: StructureFilterOptions,
): (string | null)[][] {
  const { elevation, engine } = parseFilterOptions(options)
  if (request.action === 'databases') {
    if (engine === 'postgresql') {
      return rows.filter(
        row =>
          typeof row[0] === 'string' && !['template0', 'template1'].includes(row[0].toLowerCase()),
      )
    }
    return rows.filter(
      row => typeof row[0] === 'string' && canListSchema(access, row[0], elevation, engine),
    )
  }
  if (request.action === 'schemas') {
    return rows.filter(
      row => typeof row[0] === 'string' && canListSchema(access, row[0], elevation, engine),
    )
  }
  if (request.action === 'tables' && request.schema) {
    const schema = request.schema
    return rows.filter(
      row =>
        typeof row[0] === 'string' &&
        !isSystemTable(row[0], engine) &&
        resolveTablePermissions(access, schema, row[0], elevation, engine).select,
    )
  }
  return rows
}

function tableKindFromType(
  tableType: string | null | undefined,
): 'table' | 'view' | 'materialized_view' {
  if (tableType === 'VIEW') return 'view'
  if (tableType === 'MATERIALIZED VIEW') return 'materialized_view'
  return 'table'
}

/** 将固定元数据列转换为公开结构，不夹带样例数据和账号配置。 */
export function databaseStructureItems(
  action: DatabaseStructureRequest['action'],
  rows: (string | null)[][],
) {
  return rows.map(row => {
    if (typeof row[0] !== 'string') throw new Error('数据库结构返回了无效名称')
    if (action === 'databases' || action === 'schemas') return { name: row[0] }
    if (action === 'tables') return { name: row[0], kind: tableKindFromType(row[1]) }
    if (action === 'columns')
      return { name: row[0], type: row[1] ?? '', nullable: row[2] === 'YES', key: row[3] ?? '' }
    return {
      name: row[0],
      column: row[1] ?? null,
      sequence: row[2] ?? null,
      unique: row[3] === '0',
    }
  })
}
