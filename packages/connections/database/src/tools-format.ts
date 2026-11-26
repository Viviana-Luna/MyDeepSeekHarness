/** 数据库 Agent 工具共享 Schema、参数解析与结果裁剪辅助函数。 */
import { boundTableRows, CONNECTION_TOOL_BYTES } from '@mydsh/connection-access/output'
import type { DatabaseProfile, DatabaseResult } from '../types.d.ts'
import { isSystemSchema, quoteIdentifier, resolveDefaultSqlSchema } from './dialect.ts'
import type { ResolvedAgentDatabaseTarget } from './index.ts'
import type { AdmittedReadQuery } from './read-query.ts'

/** 分页参数定义，供连接列表与结构读取工具复用。 */
export const pageParameters = {
  cursor: {
    oneOf: [{ type: 'string' as const }, { type: 'null' as const }],
    description: '上次返回的 next_cursor；首次读取时省略或传 null。',
  },
  limit: {
    type: 'integer' as const,
    description: '本页项目数；连接默认 20、最多 50，结构默认 50、最多 100。',
  },
} as const

/** 分页列表工具的标准输出契约。 */
export const pageSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    items: { type: 'array' as const, items: { type: 'json' as const }, required: true },
    next_cursor: {
      oneOf: [{ type: 'string' as const }, { type: 'null' as const }],
      required: true,
    },
    truncated: { type: 'boolean' as const, required: true },
  },
} as const

/** SQL 查询与变更工具的标准输出契约。 */
export const executeOutputSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    mode: { type: 'string' as const, enum: ['read', 'mutation'], required: true },
    connection_id: { type: 'string' as const, required: true },
    database: { oneOf: [{ type: 'string' as const }, { type: 'null' as const }], required: true },
    query_count: { type: 'integer' as const },
    results: { type: 'array' as const, items: { type: 'json' as const } },
    statement_count: { type: 'integer' as const },
    total_affected_rows: { type: 'integer' as const },
    rolled_back: { type: 'boolean' as const },
    has_ddl: { type: 'boolean' as const },
    elapsed_ms: { type: 'integer' as const },
    authorization: { type: 'string' as const },
    warning: { type: 'string' as const },
  },
} as const

/** 校验工具参数对象中是否出现未声明的额外字段。 */
export function checkFields(args: object, fields: readonly string[]): void {
  if (Object.keys(args).some(field => !fields.includes(field)))
    throw new Error('数据库工具包含未知参数')
}

/** 收集单条 SQL 与批量 SQL 列表中的非空语句文本。 */
export function collectSqlInputs(
  single: unknown,
  list: unknown,
  singleName: string,
  listName: string,
): string[] {
  const inputs: string[] = []
  if (single !== undefined) {
    if (typeof single !== 'string') throw new Error(`${singleName} 参数必须是 SQL 字符串`)
    if (single.trim()) inputs.push(single)
  }
  if (list !== undefined) {
    if (!Array.isArray(list) || list.some(item => typeof item !== 'string'))
      throw new Error(`${listName} 参数必须是 SQL 字符串数组`)
    for (const item of list) {
      if (item.trim()) inputs.push(item)
    }
  }
  return inputs
}

/** 校验并返回工具请求中的默认数据库/命名空间名称，拒绝首尾空白避免校验与连库规范化错位。 */
export function resolveDefaultDatabase(
  requested: unknown,
  fallback: string | null,
  label = 'database',
): string | null {
  if (requested === undefined) return fallback
  if (typeof requested !== 'string' || !requested.trim() || requested !== requested.trim())
    throw new Error(`${label} 参数必须是非空且不含首尾空白的数据库名称`)
  quoteIdentifier(requested)
  return requested
}

/** 计算 PostgreSQL 本次操作实际连入的物理数据库（Catalog）；非 PostgreSQL 返回 null。 */
export function effectiveAgentCatalog(
  profile: DatabaseProfile,
  catalog: string | null | undefined,
): string | null {
  if (profile.engine !== 'postgresql') return null
  return catalog?.trim() || profile.database?.trim() || 'postgres'
}

/** 校验 PostgreSQL 表级规则连接不跨默认库越界，避免二维 (schema, table) 规则碰撞其他物理库。 */
export function assertPostgresTableRuleCatalogBoundary(
  profile: DatabaseProfile,
  catalog: string | null | undefined,
): void {
  if (profile.engine !== 'postgresql' || profile.agentAccess.tableRules.length === 0) return
  const targetCatalog = effectiveAgentCatalog(profile, catalog)
  const defaultCatalog = effectiveAgentCatalog(profile, null)
  if (
    targetCatalog !== null &&
    defaultCatalog !== null &&
    targetCatalog.toLowerCase() !== defaultCatalog.toLowerCase()
  ) {
    throw new Error(
      'PERMISSION_DENIED：当前连接配置了表级规则，仅允许在连接默认数据库内访问；如需访问其他 PostgreSQL 数据库请单独建连或清空表级规则',
    )
  }
}

/** 按数据库引擎分别解析实例级 Catalog 与默认 Schema（PostgreSQL 分离两者，其余保持一致）。 */
export function resolveAgentSqlScope(
  profile: DatabaseProfile,
  args: { database?: string; schema?: string },
): { catalog: string | null; defaultSchema: string | null } {
  const requestedDatabase = resolveDefaultDatabase(args.database, null, 'database')
  const requestedSchema = resolveDefaultDatabase(args.schema, null, 'schema')
  if (profile.engine === 'postgresql') {
    if (
      requestedDatabase !== null &&
      ['template0', 'template1'].includes(requestedDatabase.trim().toLowerCase())
    ) {
      throw new Error('PERMISSION_DENIED：系统模板库不允许模型访问')
    }
    const defaultSchema = resolveDefaultSqlSchema(profile, requestedSchema)
    if (defaultSchema !== null && isSystemSchema(defaultSchema, profile.engine)) {
      throw new Error(`PERMISSION_DENIED：系统库 ${defaultSchema} 不允许模型访问`)
    }
    assertPostgresTableRuleCatalogBoundary(profile, requestedDatabase)
    return { catalog: requestedDatabase, defaultSchema }
  }
  if (
    requestedDatabase !== null &&
    requestedSchema !== null &&
    requestedDatabase !== requestedSchema
  ) {
    throw new Error('当前引擎下 database 与 schema 指向同一个命名空间，不能同时传入不同名称')
  }
  const defaultSchema = resolveDefaultSqlSchema(profile, requestedDatabase ?? requestedSchema)
  if (defaultSchema !== null && isSystemSchema(defaultSchema, profile.engine)) {
    throw new Error(`PERMISSION_DENIED：系统库 ${defaultSchema} 不允许模型访问`)
  }
  return { catalog: null, defaultSchema }
}

/** 将 SQL 文本折叠空白后截断为便于展示的摘要。 */
export function trimPreviewSql(sql: string, maxChars = 240): string {
  const compact = sql.replace(/\s+/gu, ' ').trim()
  return compact.length > maxChars ? `${compact.slice(0, maxChars - 3)}...` : compact
}

/** 按总字节预算裁剪批量只读结果集并组装工具输出载荷。 */
export function formatReadBatchPayload(
  connectionId: string,
  database: string | null,
  admitted: readonly AdmittedReadQuery[],
  results: readonly DatabaseResult[],
) {
  let remaining = CONNECTION_TOOL_BYTES - 2048
  const items = results.map((result, index) => {
    const budget = Math.max(512, remaining)
    const bounded = boundTableRows(result, budget)
    const entry = {
      index,
      sql: trimPreviewSql(admitted[index]?.sql ?? ''),
      columns: bounded.columns,
      rows: bounded.rows,
      row_count: bounded.rowCount,
      bytes: bounded.bytes,
      truncated: bounded.truncated,
      elapsed_ms: bounded.elapsedMs,
    }
    remaining = Math.max(0, remaining - Buffer.byteLength(JSON.stringify(entry), 'utf8'))
    return entry
  })
  return {
    mode: 'read' as const,
    connection_id: connectionId,
    database,
    query_count: items.length,
    results: items,
  }
}

/** 返回连接在工具摘要中展示的传输通道类型。 */
export function transportForTarget(
  target: ResolvedAgentDatabaseTarget,
): 'direct' | 'ssh' | 'local-file' {
  if (target.profile.engine === 'sqlite') return 'local-file'
  return target.profile.sshConnectionId === null ? 'direct' : 'ssh'
}
