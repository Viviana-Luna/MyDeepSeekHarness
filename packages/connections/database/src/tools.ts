/** 数据库插件的 Agent 工具入口：暴露已配置的多引擎连接，按表级策略校验读写并在变更前向用户请求同意。 */
import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  connectionPage,
  connectionPageKey,
  connectionPageOffset,
  renderConnectionOutput,
  runConnectionTool,
} from '@mydsh/connection-access/output'
import {
  assertOperationPermitted,
  assertTargetsPermitted,
  summarizeAgentAccess,
  summarizePermissionElevation,
  type DatabasePermissionElevation,
} from './agent-policy.ts'
import {
  assertStructureRequestValid,
  databaseStructureItems,
  databaseStructureRequestFromArguments,
} from './agent-structure.ts'
import { isSupportedConnectionPlatform } from './dialect.ts'
import { DatabaseConnections, type ResolvedAgentDatabaseTarget } from './index.ts'
import {
  acquireMutationLease,
  admitGeneralMutationStatements,
  ensureReadElevation,
  ensureStructureElevation,
  requestedMutationElevation,
} from './permission-negotiation.ts'
import { assertGeneralDatabaseSqlAllowed, classifyDatabaseSqlBatch } from './query-execution.ts'
import { admitReadQueries, type AdmittedReadQuery } from './read-query.ts'
import {
  assertPostgresTableRuleCatalogBoundary,
  checkFields,
  collectSqlInputs,
  effectiveAgentCatalog,
  executeOutputSchema,
  formatReadBatchPayload,
  pageParameters,
  pageSchema,
  resolveAgentSqlScope,
  transportForTarget,
  trimPreviewSql,
} from './tools-format.ts'
import { admitMutateStatements, type AdmittedMutationStatement } from './write-query.ts'

function registerList(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'database_connections_list',
      description:
        '列出已在「数据库」模式开放给模型使用的数据库连接摘要（支持 MySQL、MariaDB、PostgreSQL 与 SQLite，含直连、可信 SSH 隧道与本地文件）及权限策略，不返回任何密码或密钥。',
      parameters: pageParameters,
      output: { schema: pageSchema, render: (_args, value) => renderConnectionOutput(value) },
      execute(args, exec) {
        return runConnectionTool(async () => {
          checkFields(args, ['cursor', 'limit'])
          ctx.mydshConnectionAccess.assertMainAgent(exec.agent)
          const targets = await DatabaseConnections.agentCatalog(ctx.mydshDatabase)
          exec.signal.throwIfAborted()
          const items = targets.map(target => ({
            connection_id: target.profile.id,
            name: target.profile.name,
            engine: target.profile.engine,
            transport: transportForTarget(target),
            default_database: target.profile.database,
            ...(target.profile.engine === 'sqlite' && target.profile.filePath
              ? { file_name: basename(target.profile.filePath) }
              : {}),
            environment: target.profile.environment,
            capabilities: ['schema', 'query', 'mutate'],
            agent_access: summarizeAgentAccess(target.profile.agentAccess),
            session_mutation_consented: ctx.mydshConnectionAccess.hasSessionConsent(
              exec.agent,
              target.connection,
              target.dependencies,
            ),
            session_elevation: summarizePermissionElevation(
              DatabaseConnections.agentElevation(ctx.mydshDatabase, exec.agent, target),
            ),
          }))
          const key = connectionPageKey(
            targets.map(item => `${item.connection.id}:${item.connection.revision}`),
          )
          return connectionPage(items, args, { key, defaultLimit: 20, maxLimit: 50 })
        })
      },
    }),
  )
}

interface DatabaseStructureArguments {
  connection_id: string
  action: 'databases' | 'schemas' | 'tables' | 'columns' | 'indexes'
  database?: string
  schema?: string
  table?: string
  cursor?: string | null
  limit?: number
}

async function executeDatabaseStructure(
  ctx: Context,
  args: DatabaseStructureArguments,
  exec: ToolRunContext,
) {
  checkFields(args, ['connection_id', 'action', 'database', 'schema', 'table', 'cursor', 'limit'])
  ctx.mydshConnectionAccess.assertMainAgent(exec.agent)
  const target = await DatabaseConnections.resolveAgentConnection(
    ctx.mydshDatabase,
    args.connection_id,
  )
  const key = connectionPageKey([
    target.connection.id,
    target.connection.revision,
    args.action,
    args.database ?? null,
    args.schema ?? null,
    args.table ?? null,
  ])
  const offset = connectionPageOffset(args.cursor, key)
  const limit = args.limit ?? 50
  const structure = databaseStructureRequestFromArguments({ ...args, offset, limit })
  assertStructureRequestValid(structure, target.profile.engine)
  assertPostgresTableRuleCatalogBoundary(target.profile, structure.database)
  const catalog = effectiveAgentCatalog(target.profile, structure.database)
  const existingElevation = DatabaseConnections.agentElevation(
    ctx.mydshDatabase,
    exec.agent,
    target,
    catalog,
  )
  const elevation = await ensureStructureElevation({
    ctx,
    exec,
    target,
    catalog,
    structure,
    ...(existingElevation ? { existingElevation } : {}),
  })
  const result = await DatabaseConnections.readStructure(ctx.mydshDatabase, target.profile.id, {
    structure,
    signal: exec.signal,
    expectedTarget: target,
    ...(elevation ? { elevation } : {}),
  })
  const items = databaseStructureItems(args.action, result.rows)
  return connectionPage(
    items,
    { limit },
    { key, defaultLimit: 50, maxLimit: 100, baseOffset: offset },
  )
}

function registerStructure(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'database_schema',
      description:
        '读取已开放数据库连接（MySQL、MariaDB、PostgreSQL、SQLite）的数据库实例、命名空间、数据表/视图/物化视图、字段或索引结构，也可用于确认连接是否可用。结果按连接权限过滤；表级规则拒绝目标时会先请求本次或本会话提权。',
      parameters: {
        connection_id: {
          type: 'string',
          required: true,
          description: 'database_connections_list 返回的连接标识。',
        },
        action: {
          type: 'string',
          enum: ['databases', 'schemas', 'tables', 'columns', 'indexes'],
          required: true,
          description:
            'databases 列出物理数据库实例（PostgreSQL 返回实例列表，其余等价于 schemas）；schemas 列出命名空间/库；tables 读取指定库的表/视图/物化视图；columns 和 indexes 读取指定对象结构。',
        },
        database: {
          type: 'string',
          description:
            'PostgreSQL 可选：指定要读取的物理数据库实例名称（配合 schemas/tables/columns/indexes 使用），不能是 template0/template1。',
        },
        schema: {
          type: 'string',
          description: 'tables/columns/indexes 必填；必须是业务命名空间，不能是系统库。',
        },
        table: {
          type: 'string',
          description: 'columns 和 indexes 必填；必须位于 schema 指定的库中。',
        },
        ...pageParameters,
      },
      output: { schema: pageSchema, render: (_args, value) => renderConnectionOutput(value) },
      execute(args, exec) {
        return runConnectionTool(() => executeDatabaseStructure(ctx, args, exec))
      },
    }),
  )
}

interface DatabaseQueryArguments {
  connection_id: string
  database?: string
  schema?: string
  sql?: string
  queries?: string[]
  limit?: number
}

async function executeDatabaseQuery(
  ctx: Context,
  args: DatabaseQueryArguments,
  exec: ToolRunContext,
) {
  checkFields(args, ['connection_id', 'database', 'schema', 'sql', 'queries', 'limit'])
  ctx.mydshConnectionAccess.assertMainAgent(exec.agent)
  const limit = args.limit ?? 100
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new Error('limit 参数必须在 1 至 200 之间')
  const rawInputs = collectSqlInputs(args.sql, args.queries, 'sql', 'queries')
  if (rawInputs.length === 0) throw new Error('请通过 sql 或 queries 提供至少一条 SQL')
  const target = await DatabaseConnections.resolveAgentConnection(
    ctx.mydshDatabase,
    args.connection_id,
  )
  const { catalog, defaultSchema: defaultDatabase } = resolveAgentSqlScope(target.profile, args)
  const engine = target.profile.engine
  if (target.profile.agentAccess.tableRules.length === 0) {
    const execution = classifyDatabaseSqlBatch(rawInputs, 20, engine)
    if (execution.mode === 'read') {
      for (const item of execution.statements)
        assertGeneralDatabaseSqlAllowed(item.sql, defaultDatabase, engine)
      const admitted = execution.statements.map(item => ({ sql: item.sql, targets: [] }))
      return executeReadBatch({
        ctx,
        target,
        catalog,
        defaultDatabase,
        queries: admitted,
        limit,
        exec,
      })
    }
    const statements = admitGeneralMutationStatements(rawInputs, defaultDatabase, 20, engine)
    return executeDatabaseMutation(
      ctx,
      {
        connection_id: target.profile.id,
        ...(args.database === undefined ? {} : { database: args.database }),
        ...(args.schema === undefined ? {} : { schema: args.schema }),
        statements: execution.statements.map(item => item.sql),
      },
      exec,
      { target, statements },
    )
  }
  return executeTableRestrictedQuery({
    ctx,
    args,
    exec,
    target,
    rawInputs,
    catalog,
    defaultDatabase,
    limit,
  })
}

async function executeTableRestrictedQuery(input: {
  ctx: Context
  args: DatabaseQueryArguments
  exec: ToolRunContext
  target: ResolvedAgentDatabaseTarget
  rawInputs: readonly string[]
  catalog: string | null
  defaultDatabase: string | null
  limit: number
}) {
  const { ctx, args, exec, target, rawInputs, catalog, defaultDatabase, limit } = input
  const engine = target.profile.engine
  const execution = classifyDatabaseSqlBatch(rawInputs, 20, engine)
  if (execution.mode === 'mutation') {
    const statements = admitMutateStatements({ statements: rawInputs }, defaultDatabase, engine)
    return executeDatabaseMutation(
      ctx,
      {
        connection_id: target.profile.id,
        ...(args.database === undefined ? {} : { database: args.database }),
        ...(args.schema === undefined ? {} : { schema: args.schema }),
        statements: execution.statements.map(item => item.sql),
      },
      exec,
      { target, statements },
    )
  }
  const admitted = admitReadQueries(rawInputs, defaultDatabase, engine)
  const effectiveCatalog = effectiveAgentCatalog(target.profile, catalog)
  const existingElevation = DatabaseConnections.agentElevation(
    ctx.mydshDatabase,
    exec.agent,
    target,
    effectiveCatalog,
  )
  const elevation = await ensureReadElevation({
    ctx,
    exec,
    target,
    catalog: effectiveCatalog,
    defaultDatabase:
      effectiveCatalog && defaultDatabase
        ? `${effectiveCatalog}.${defaultDatabase}`
        : (effectiveCatalog ?? defaultDatabase),
    queries: admitted,
    ...(existingElevation ? { existingElevation } : {}),
  })
  assertTargetsPermitted(
    target.profile.agentAccess,
    admitted.flatMap(item => item.targets),
    elevation,
    engine,
  )
  return executeReadBatch({
    ctx,
    target,
    catalog,
    defaultDatabase,
    queries: admitted,
    limit,
    exec,
    ...(elevation ? { elevation } : {}),
  })
}

async function executeReadBatch(input: {
  ctx: Context
  target: ResolvedAgentDatabaseTarget
  catalog: string | null
  defaultDatabase: string | null
  queries: readonly AdmittedReadQuery[]
  limit: number
  exec: ToolRunContext
  elevation?: DatabasePermissionElevation
}) {
  const effectiveCatalog = effectiveAgentCatalog(input.target.profile, input.catalog)
  const results = await DatabaseConnections.queryForAgent(input.ctx.mydshDatabase, {
    connectionId: input.target.profile.id,
    database: input.defaultDatabase,
    catalog: input.catalog,
    queries: input.queries,
    limitPerQuery: input.limit,
    signal: input.exec.signal,
    expectedTarget: input.target,
    ...(input.elevation ? { elevation: input.elevation } : {}),
  })
  return formatReadBatchPayload(
    input.target.profile.id,
    effectiveCatalog ?? input.defaultDatabase,
    input.queries,
    results,
  )
}

function registerQuery(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'database_query',
      description:
        '执行完整业务表 SQL（支持 MySQL、MariaDB、PostgreSQL、SQLite），最多 20 条同类读取或变更语句。读取在只读事务中执行；INSERT、UPDATE、DELETE、REPLACE 和 DDL 会先请求用户确认。连接档位或表级规则不足时先请求本次或本会话提权，而不是直接拒绝。读取与变更不能混在同一批；系统库、服务端文件和账号管理仍禁止。查询库表结构时优先使用 database_schema。',
      parameters: {
        connection_id: {
          type: 'string',
          required: true,
          description: 'database_connections_list 返回的连接标识。',
        },
        database: {
          type: 'string',
          description:
            '可选默认数据库（PostgreSQL 下为物理数据库实例名，MySQL/MariaDB 下为 Schema 名）；省略时使用连接默认库。',
        },
        schema: {
          type: 'string',
          description: 'PostgreSQL 可选：设置会话 search_path 的业务 Schema（默认为 public）。',
        },
        sql: {
          type: 'string',
          description: '一条 SQL，或用分号分隔的同类型 SQL 脚本；支持完整业务表查询、DML 和 DDL。',
        },
        queries: {
          type: 'array',
          items: { type: 'string' },
          description:
            '显式传入最多 20 条同类型 SQL；不能与读取语句混用变更语句；与 sql 至少提供一项。',
        },
        limit: {
          type: 'integer',
          description: '每条查询最多返回行数，默认 100，最大 200。',
        },
      },
      output: {
        schema: executeOutputSchema,
        render: (_args, value) => renderConnectionOutput(value),
      },
      execute(args, exec) {
        return runConnectionTool(() => executeDatabaseQuery(ctx, args, exec))
      },
    }),
  )
}

async function executeDatabaseMutation(
  ctx: Context,
  args: {
    connection_id: string
    database?: string
    schema?: string
    sql?: string
    statements?: string[]
  },
  exec: ToolRunContext,
  preAdmitted?: {
    target: ResolvedAgentDatabaseTarget
    statements: readonly AdmittedMutationStatement[]
  },
) {
  checkFields(args, ['connection_id', 'database', 'schema', 'sql', 'statements'])
  ctx.mydshConnectionAccess.assertMainAgent(exec.agent)
  const rawInputs = collectSqlInputs(args.sql, args.statements, 'sql', 'statements')
  if (rawInputs.length === 0)
    throw new Error('请通过 sql 或 statements 提供至少一条变更或 DDL 语句')
  // 透传预准入时的连接快照，防止 database_query 转入变更期间新增 tableRules 引发 TOCTOU 绕过。
  const target =
    preAdmitted?.target ??
    (await DatabaseConnections.resolveAgentConnection(ctx.mydshDatabase, args.connection_id))
  const engine = target.profile.engine
  const { catalog, defaultSchema: defaultDatabase } = resolveAgentSqlScope(target.profile, args)
  const effectiveCatalog = effectiveAgentCatalog(target.profile, catalog)
  const statements =
    preAdmitted?.statements ??
    (target.profile.agentAccess.tableRules.length === 0
      ? admitGeneralMutationStatements(rawInputs, defaultDatabase, 50, engine)
      : admitMutateStatements({ statements: rawInputs }, defaultDatabase, engine))
  const { result: batchResult, authorization } = await executeApprovedMutation({
    ctx,
    target,
    catalog,
    defaultDatabase,
    statements,
    exec,
  })
  return {
    mode: 'mutation' as const,
    connection_id: target.profile.id,
    database: effectiveCatalog ?? defaultDatabase,
    statement_count: batchResult.results.length,
    total_affected_rows: batchResult.totalAffectedRows,
    rolled_back: batchResult.rolledBack,
    has_ddl: batchResult.hasDdl,
    elapsed_ms: batchResult.elapsedMs,
    authorization,
    ...(batchResult.warning ? { warning: batchResult.warning } : {}),
    results: batchResult.results.map(item => ({
      index: item.index,
      operation: item.operation,
      schema: item.schema,
      table: item.table,
      sql: trimPreviewSql(item.sql),
      affected_rows: item.affectedRows,
      changed_rows: item.changedRows,
      insert_id: item.insertId,
    })),
  }
}

function executeApprovedMutation(input: {
  ctx: Context
  target: ResolvedAgentDatabaseTarget
  catalog: string | null
  defaultDatabase: string | null
  statements: readonly AdmittedMutationStatement[]
  exec: ToolRunContext
}) {
  const { ctx, target, catalog, defaultDatabase, statements, exec } = input
  const sessionKey = exec.agent?.id ?? 'anonymous'
  const effectiveCatalog = effectiveAgentCatalog(target.profile, catalog)
  return ctx.mydshConnectionAccess.serializeForConnection(
    sessionKey,
    target.profile.id,
    async () => {
      const existingElevation = DatabaseConnections.agentElevation(
        ctx.mydshDatabase,
        exec.agent,
        target,
        effectiveCatalog,
      )
      const requestedElevation = requestedMutationElevation(target, statements, existingElevation)
      const approved = await acquireMutationLease(ctx, exec, {
        target,
        catalog: effectiveCatalog,
        defaultDatabase:
          effectiveCatalog && defaultDatabase
            ? `${effectiveCatalog}.${defaultDatabase}`
            : (effectiveCatalog ?? defaultDatabase),
        statements,
        existingElevation,
        requestedElevation,
      })
      try {
        assertTargetsPermitted(
          target.profile.agentAccess,
          statements.flatMap(item => item.targets),
          approved.elevation,
          target.profile.engine,
        )
        for (const statement of statements)
          assertOperationPermitted(
            target.profile.agentAccess,
            statement.operation,
            approved.elevation,
          )
        const result = await DatabaseConnections.mutateForAgent(ctx.mydshDatabase, approved.lease, {
          database: defaultDatabase,
          catalog,
          statements,
          signal: exec.signal,
          ...(approved.elevation ? { elevation: approved.elevation } : {}),
        })
        return { result, authorization: approved.authorization }
      } finally {
        ctx.mydshConnectionAccess.releaseLease(approved.lease)
      }
    },
    exec.signal,
  )
}

function registerMutate(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'database_mutate',
      description:
        '批量执行业务表 INSERT、UPDATE、DELETE 或 DDL（CREATE/ALTER/DROP/TRUNCATE/RENAME，最多 50 条）。权限档位或表级规则不足时先请求本次或本会话提权；删库、删表、清空表和无 WHERE 删改每次单独确认。结果中的 authorization 说明本次放行来源。',
      parameters: {
        connection_id: {
          type: 'string',
          required: true,
          description: 'database_connections_list 返回的连接标识。',
        },
        database: {
          type: 'string',
          description:
            '可选默认数据库（PostgreSQL 下为物理数据库实例名，MySQL/MariaDB 下为 Schema 名）；省略时使用连接默认库。',
        },
        schema: {
          type: 'string',
          description: 'PostgreSQL 可选：设置会话 search_path 的业务 Schema（默认为 public）。',
        },
        sql: {
          type: 'string',
          description: '单条或分号分隔的多条变更/DDL 语句（最多 50 条）。',
        },
        statements: {
          type: 'array',
          items: { type: 'string' },
          description: '显式传入多条变更/DDL 语句（最多 50 条）；与 sql 至少提供一项。',
        },
      },
      output: {
        schema: executeOutputSchema,
        render: (_args, value) => renderConnectionOutput(value),
      },
      execute(args, exec) {
        return runConnectionTool(() => executeDatabaseMutation(ctx, args, exec))
      },
    }),
  )
}

/** 依赖由宿主共享：写入/DDL 通过 userQuestions 显式向用户请求单次或会话授权。 */
export const inject = ['tools', 'mydshDatabase', 'mydshConnectionAccess', 'userQuestions']

/** 工具目录按预设稳定暴露；实际可调用范围与权限由「数据库」模式配置和用户实时授权决定。 */
export function apply(ctx: Context): void {
  if (!isSupportedConnectionPlatform()) return
  registerList(ctx)
  registerStructure(ctx)
  registerQuery(ctx)
  registerMutate(ctx)
}
