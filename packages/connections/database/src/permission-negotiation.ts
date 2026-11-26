/** 数据库工具权限协商：构造确认卡，并向用户申请本次或本会话临时提权。 */
import type { Context } from '@deepseek-ai/cordis'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ConnectionLease } from '@mydsh/connection-access'
import type {
  DatabaseAgentAccessMode,
  DatabaseEngine,
  DatabasePermissionFlags,
  DatabasePermissionKey,
  DatabaseStructureRequest,
  DatabaseTablePermission,
} from '../types.d.ts'
import { engineDisplayName, isSystemSchema } from './dialect.ts'
import {
  canListSchema,
  deniedTargets,
  mergePermissionElevations,
  resolveTablePermissions,
  type DatabasePermissionElevation,
} from './agent-policy.ts'
import { DatabaseConnections, type ResolvedAgentDatabaseTarget } from './index.ts'
import type { AdmittedReadQuery } from './read-query.ts'
import {
  assertGeneralDatabaseSqlAllowed,
  classifyDatabaseSqlBatch,
  destructiveMutationReasons,
} from './query-execution.ts'
import type { AdmittedMutationStatement } from './write-query.ts'

const SQL_PREVIEW_MARKER = 'MYDSH_DATABASE_SQL_PREVIEW_V1:'

interface ConsentStatement {
  readonly sql: string
  readonly summary: string
  readonly targets: readonly { schema: string; table: string; operation: DatabasePermissionKey }[]
  readonly risks: readonly string[]
  readonly operation?: DatabaseMutationOperation | undefined
}

type DatabaseMutationOperation = 'insert' | 'update' | 'delete' | 'ddl'

const MODE_RANK: Record<DatabaseAgentAccessMode, number> = {
  readonly: 0,
  readwrite: 1,
  full: 2,
}

/** 数据库变更本次执行的授权来源，返回给工具结果以便模型与日志区分交互确认与会话复用。 */
export type DatabaseMutationAuthorization =
  'elevated-once' | 'elevated-session' | 'approved-once' | 'approved-session' | 'session-reused'

function rawDdlRiskNote(engine: DatabaseEngine): string {
  if (engine === 'postgresql' || engine === 'sqlite')
    return 'DDL 结构变更将在当前事务中执行（失败自动回滚）'
  if (engine === 'mariadb') return 'DDL 结构变更在 MariaDB 中会隐式提交，无法回滚'
  return 'DDL 结构变更在 MySQL 中会隐式提交，无法回滚'
}

function createRawMutationStatement(
  sql: string,
  operation: DatabaseMutationOperation,
  engine: DatabaseEngine = 'mysql',
): AdmittedMutationStatement {
  const baseRisks =
    operation === 'ddl'
      ? [rawDdlRiskNote(engine), '通用 SQL 未逐表解析，请核对目标对象']
      : ['通用 SQL 未逐表解析，请核对影响范围']
  const risks = [...new Set([...destructiveMutationReasons(sql, engine), ...baseRisks])]
  return {
    sql,
    operation,
    schema: '',
    table: '',
    targets: [],
    summary: `通用 ${operation.toUpperCase()} SQL`,
    risks,
  }
}

/** 将无表级规则的完整变更脚本转换为经过硬边界检查的执行语句。 */
export function admitGeneralMutationStatements(
  rawInputs: readonly string[],
  defaultDatabase: string | null,
  maxStatements = 50,
  engine: DatabaseEngine = 'mysql',
): AdmittedMutationStatement[] {
  const execution = classifyDatabaseSqlBatch(rawInputs, maxStatements, engine)
  if (execution.mode !== 'mutation')
    throw new Error('database_mutate 只接受插入、更新、删除或结构变更语句')
  return execution.statements.map(item => {
    assertGeneralDatabaseSqlAllowed(item.sql, defaultDatabase, engine)
    return createRawMutationStatement(item.sql, item.operation!, engine)
  })
}

function executionModeLabel(
  statements: readonly ConsentStatement[],
  engine: DatabaseEngine,
): string {
  if (statements.some(item => item.operation === 'ddl')) {
    if (engine === 'postgresql' || engine === 'sqlite')
      return '包含 DDL 结构变更（单一事务内执行，失败自动回滚）'
    if (engine === 'mariadb') return '包含 DDL 结构变更（顺序执行，MariaDB 会隐式提交）'
    return '包含 DDL 结构变更（顺序执行，MySQL 会隐式提交）'
  }
  if (statements.some(item => item.operation !== undefined))
    return '纯数据变更（单事务原子执行，失败自动回滚）'
  return '只读查询'
}

function formatTargetSummary(target: ResolvedAgentDatabaseTarget): string {
  const label = engineDisplayName(target.profile.engine)
  if (target.profile.engine === 'sqlite') {
    return `${target.profile.name} (${label} · ${target.profile.filePath ?? '本地文件'})`
  }
  const tunnel = target.profile.sshConnectionId ? '，经 SSH 隧道' : ''
  return `${target.profile.name} (${label} · ${target.profile.host}:${target.profile.port}${tunnel})`
}

function buildConsentDetail(
  target: ResolvedAgentDatabaseTarget,
  defaultDatabase: string | null,
  statements: readonly ConsentStatement[],
  permissionNote?: string,
): string {
  const affectedTargets = [
    ...new Set(
      statements.flatMap(item =>
        item.targets.map(t => `${t.schema}.${t.table} (${t.operation.toUpperCase()})`),
      ),
    ),
  ]
  const warnings = [...new Set(statements.flatMap(item => item.risks))]
  const lines = [
    `- 连接：${formatTargetSummary(target)}`,
    `- 默认库：${defaultDatabase ?? '未指定（按语句显式库名执行）'}`,
    `- 涉及对象：${affectedTargets.length > 0 ? affectedTargets.join('、') : '连接级通用 SQL'}`,
    `- 执行模式：${executionModeLabel(statements, target.profile.engine)}`,
  ]
  if (permissionNote) lines.splice(3, 0, `- 权限：${permissionNote}`)
  if (warnings.length > 0) lines.push(`- 风险提示：${warnings.join('；')}`)
  const previewLines: string[] = []
  let sqlChars = 0
  for (const [index, item] of statements.entries()) {
    const line = `-- [${index + 1}/${statements.length}] ${item.summary}\n${item.sql};`
    if (sqlChars + line.length > 5500) {
      previewLines.push(`-- ... 其余 ${statements.length - index} 条语句已省略预览 ...`)
      break
    }
    previewLines.push(line)
    sqlChars += line.length
  }
  const preview = previewLines.join('\n')
  lines.push(
    '',
    '```sql',
    preview,
    '```',
    '',
    `${SQL_PREVIEW_MARKER}${Buffer.from(preview, 'utf8').toString('base64url')}`,
  )
  return lines.join('\n')
}

function operationMode(operations: readonly DatabasePermissionKey[]): DatabaseAgentAccessMode {
  if (operations.includes('ddl')) return 'full'
  if (operations.some(operation => operation !== 'select')) return 'readwrite'
  return 'readonly'
}

function elevationForOperations(
  access: { mode: DatabaseAgentAccessMode },
  operations: readonly DatabasePermissionKey[],
): DatabasePermissionElevation | undefined {
  const mode = operationMode(operations)
  return MODE_RANK[mode] > MODE_RANK[access.mode] ? { mode } : undefined
}

function elevationForTargets(
  targets: readonly { schema: string; table: string; operation: DatabasePermissionKey }[],
): DatabasePermissionElevation {
  const rules = new Map<string, DatabaseTablePermission>()
  for (const target of targets) {
    const key = `${target.schema.toLowerCase()}\0${target.table.toLowerCase()}`
    const previous = rules.get(key)
    const flags: DatabasePermissionFlags = previous ?? {
      select: false,
      insert: false,
      update: false,
      delete: false,
      ddl: false,
    }
    flags[target.operation] = true
    rules.set(key, { schema: target.schema, table: target.table, ...flags })
  }
  return { targets: [...rules.values()] }
}

function modeDescription(mode: DatabaseAgentAccessMode): string {
  if (mode === 'full') return '完整访问（包含 DDL）'
  if (mode === 'readwrite') return '数据读写'
  return '只读'
}

function elevationDescription(elevation: DatabasePermissionElevation): string {
  const parts: string[] = []
  if (elevation.mode) parts.push(modeDescription(elevation.mode))
  if (elevation.connectionPermissions?.select) parts.push('连接级读取')
  if (elevation.targets?.length)
    parts.push(
      `${elevation.targets.map(rule => `${rule.schema}.${rule.table}`).join('、')} 的指定操作`,
    )
  return parts.join('；')
}

function effectiveAccessMode(
  access: { mode: DatabaseAgentAccessMode },
  elevation: DatabasePermissionElevation | undefined,
): DatabaseAgentAccessMode {
  return elevation?.mode && MODE_RANK[elevation.mode] > MODE_RANK[access.mode]
    ? elevation.mode
    : access.mode
}

/** 计算当前变更需要补充的临时提权；没有越界时返回 undefined。 */
export function requestedMutationElevation(
  target: ResolvedAgentDatabaseTarget,
  statements: readonly AdmittedMutationStatement[],
  existingElevation?: DatabasePermissionElevation,
): DatabasePermissionElevation | undefined {
  const access = target.profile.agentAccess
  const targets = statements.flatMap(item => item.targets)
  const operations =
    targets.length > 0
      ? targets.map(item => item.operation)
      : statements.map(item => item.operation as DatabasePermissionKey)
  const modeElevation = elevationForOperations(
    { mode: effectiveAccessMode(access, existingElevation) },
    operations,
  )
  const denied = deniedTargets(access, targets, existingElevation, target.profile.engine)
  const targetElevation = denied.length > 0 ? elevationForTargets(denied) : undefined
  return mergePermissionElevations(modeElevation, targetElevation)
}

async function askDatabaseApproval(
  ctx: Context,
  exec: ToolRunContext,
  input: {
    target: ResolvedAgentDatabaseTarget
    header: string
    question: string
    detail: string
    allowOnceLabel: string
    allowSessionLabel?: string
  },
): Promise<'once' | 'session' | 'deny'> {
  const denyLabel = '拒绝'
  const questionId = `mydsh-database-consent:${input.target.profile.id}`
  const options = [
    { label: input.allowOnceLabel, description: '只授权本次调用中的全部操作执行一次。' },
    ...(input.allowSessionLabel
      ? [
          {
            label: input.allowSessionLabel,
            description: '在当前 Agent 实例和当前连接版本内记住这次授权。',
          },
        ]
      : []),
    { label: denyLabel, description: '拒绝本次数据库操作。' },
  ]
  const answer: AskUserQuestionAnswer = await ctx.userQuestions.ask({
    questions: [
      {
        id: questionId,
        header: input.header,
        question: input.question,
        detail: input.detail,
        options,
      },
    ],
    ...(exec.agent ? { agent: exec.agent } : {}),
    signal: exec.signal,
  })
  const selected = answer.answers.find(item => item.id === questionId)?.selected ?? []
  if (input.allowSessionLabel && selected.includes(input.allowSessionLabel)) return 'session'
  if (selected.includes(input.allowOnceLabel)) return 'once'
  return 'deny'
}

/** 表级规则拒绝读取时申请本次或本会话提权，返回本次查询使用的权限叠加。 */
export async function ensureReadElevation(input: {
  ctx: Context
  exec: ToolRunContext
  target: ResolvedAgentDatabaseTarget
  catalog?: string | null
  defaultDatabase: string | null
  queries: readonly AdmittedReadQuery[]
  existingElevation?: DatabasePermissionElevation
}): Promise<DatabasePermissionElevation | undefined> {
  const { ctx, exec, target, catalog, defaultDatabase, queries, existingElevation } = input
  const engine = target.profile.engine
  const allTargets = queries.flatMap(item => item.targets)
  const denied = deniedTargets(target.profile.agentAccess, allTargets, existingElevation, engine)
  if (denied.length === 0) return existingElevation
  const liveAgent = ctx.mydshConnectionAccess.assertMainAgent(exec.agent)
  const requestedElevation = elevationForTargets(denied)
  const decision = await askDatabaseApproval(ctx, exec, {
    target,
    header: '数据库读取提权',
    question: `当前权限不允许读取 ${denied.length} 个目标表。是否临时提权并执行这次读取？`,
    detail: buildConsentDetail(
      target,
      defaultDatabase,
      queries.map(item => ({
        sql: item.sql,
        summary: '读取查询',
        targets: item.targets,
        risks: [],
      })),
      `${modeDescription(target.profile.agentAccess.mode)} → ${elevationDescription(requestedElevation)}`,
    ),
    allowOnceLabel: '提权并允许本次查询',
    allowSessionLabel: '本次会话允许该读取提权',
  })
  if (decision === 'deny') throw new Error('USER_REJECTED：用户拒绝了此次数据库读取提权')
  const elevation = mergePermissionElevations(existingElevation, requestedElevation)
  if (decision === 'session' && elevation)
    DatabaseConnections.grantAgentElevation(
      ctx.mydshDatabase,
      liveAgent,
      target,
      elevation,
      catalog,
    )
  return elevation
}

function buildPermissionDetail(
  target: ResolvedAgentDatabaseTarget,
  defaultDatabase: string | null,
  requirement: string,
): string {
  return [
    `- 连接：${formatTargetSummary(target)}`,
    `- 默认库：${defaultDatabase ?? '未指定'}`,
    `- 申请范围：${requirement}`,
  ].join('\n')
}

function structureElevationTargets(
  target: ResolvedAgentDatabaseTarget,
  structure: DatabaseStructureRequest,
  existingElevation?: DatabasePermissionElevation,
): DatabaseTablePermission[] {
  const engine = target.profile.engine
  if (!structure.schema || isSystemSchema(structure.schema, engine)) return []
  const access = target.profile.agentAccess
  if (
    structure.action === 'tables' &&
    !canListSchema(access, structure.schema, existingElevation, engine)
  )
    return [
      {
        schema: structure.schema,
        table: '*',
        select: true,
        insert: false,
        update: false,
        delete: false,
        ddl: false,
      },
    ]
  if (
    (structure.action === 'columns' || structure.action === 'indexes') &&
    structure.table &&
    !resolveTablePermissions(access, structure.schema, structure.table, existingElevation, engine)
      .select
  )
    return [
      {
        schema: structure.schema,
        table: structure.table,
        select: true,
        insert: false,
        update: false,
        delete: false,
        ddl: false,
      },
    ]
  return []
}

/** 表级规则拒绝结构读取时申请本次或本会话提权。 */
export async function ensureStructureElevation(input: {
  ctx: Context
  exec: ToolRunContext
  target: ResolvedAgentDatabaseTarget
  catalog?: string | null
  structure: DatabaseStructureRequest
  existingElevation?: DatabasePermissionElevation
}): Promise<DatabasePermissionElevation | undefined> {
  const { ctx, exec, target, catalog, structure, existingElevation } = input
  const deniedRules = structureElevationTargets(target, structure, existingElevation)
  if (deniedRules.length === 0) return existingElevation
  const liveAgent = ctx.mydshConnectionAccess.assertMainAgent(exec.agent)
  const requestedElevation: DatabasePermissionElevation = { targets: deniedRules }
  const scopeLabel =
    structure.action === 'tables'
      ? `${structure.schema}.* 的表列表`
      : `${structure.schema}.${structure.table} 的结构`
  const displayDatabase =
    catalog && structure.schema
      ? `${catalog}.${structure.schema}`
      : (catalog ?? structure.schema ?? null)
  const decision = await askDatabaseApproval(ctx, exec, {
    target,
    header: '数据库结构读取提权',
    question: '当前权限不允许读取所选表结构。是否临时提权并继续？',
    detail: buildPermissionDetail(target, displayDatabase, scopeLabel),
    allowOnceLabel: '提权并允许本次读取',
    allowSessionLabel: '本次会话允许该读取提权',
  })
  if (decision === 'deny') throw new Error('USER_REJECTED：用户拒绝了此次数据库结构读取提权')
  const elevation = mergePermissionElevations(existingElevation, requestedElevation)
  if (decision === 'session' && elevation)
    DatabaseConnections.grantAgentElevation(
      ctx.mydshDatabase,
      liveAgent,
      target,
      elevation,
      catalog,
    )
  return elevation
}

function mutationApprovalLabel(requested: boolean, count: number): string {
  if (requested) return '提权并允许本次操作'
  return count === 1 ? '允许本次操作' : `允许本次（全部 ${count} 条）`
}

/** 申请数据库变更执行授权，并在需要时同时登记本次或本会话提权。 */
export async function acquireMutationLease(
  ctx: Context,
  exec: ToolRunContext,
  input: {
    target: ResolvedAgentDatabaseTarget
    catalog?: string | null
    defaultDatabase: string | null
    statements: readonly AdmittedMutationStatement[]
    existingElevation?: DatabasePermissionElevation | undefined
    requestedElevation?: DatabasePermissionElevation | undefined
  },
): Promise<{
  lease: ConnectionLease
  elevation: DatabasePermissionElevation | undefined
  authorization: DatabaseMutationAuthorization
}> {
  const { target, catalog, defaultDatabase, statements, existingElevation, requestedElevation } =
    input
  const engine = target.profile.engine
  const requested = requestedElevation !== undefined
  const statementsWithRisks = statements.map(item => {
    const destructive = destructiveMutationReasons(item.sql, engine)
    return destructive.length > 0
      ? { ...item, risks: [...new Set([...destructive, ...item.risks])] }
      : item
  })
  // PostgreSQL 跨默认物理库变更始终单次确认，防止某个测试库的会话授权扩散到同集群其他业务库。
  const defaultCatalog =
    engine === 'postgresql' ? target.profile.database?.trim() || 'postgres' : null
  const isCrossCatalogMutation =
    engine === 'postgresql' &&
    Boolean(catalog) &&
    catalog!.toLowerCase() !== defaultCatalog!.toLowerCase()
  const requiresPerCallApproval =
    isCrossCatalogMutation ||
    statements.some(item => destructiveMutationReasons(item.sql, engine).length > 0)
  const hasConsent = ctx.mydshConnectionAccess.hasSessionConsent(
    exec.agent,
    target.connection,
    target.dependencies,
  )
  if (hasConsent && !requested && !requiresPerCallApproval) {
    const lease = ctx.mydshConnectionAccess.acquireLease(exec.agent, {
      name: target.profile.name,
      connection: target.connection,
      dependencies: target.dependencies,
      requireSessionConsent: true,
    })
    return { lease, elevation: existingElevation, authorization: 'session-reused' }
  }
  const elevation = mergePermissionElevations(existingElevation, requestedElevation)
  const permissionNote =
    requested && requestedElevation
      ? `${modeDescription(target.profile.agentAccess.mode)} → ${elevationDescription(requestedElevation)}`
      : undefined
  const decision = await askDatabaseApproval(ctx, exec, {
    target,
    header: requested ? '数据库权限提权' : '数据库变更确认',
    question: requested
      ? `当前权限不允许这次操作。是否临时提权并执行以下 ${statements.length} 条语句？`
      : `允许对数据库连接「${target.profile.name}」执行以下 ${statements.length} 条操作吗？`,
    detail: buildConsentDetail(target, defaultDatabase, statementsWithRisks, permissionNote),
    allowOnceLabel: mutationApprovalLabel(requested, statements.length),
    ...(requiresPerCallApproval
      ? {}
      : { allowSessionLabel: requested ? '本次会话允许该提权' : '本次会话允许该连接变更' }),
  })
  if (decision === 'session' && !requiresPerCallApproval) {
    if (!exec.agent) throw new Error('NOT_AUTHORIZED：数据库提权需要当前会话身份')
    if (requested && elevation)
      DatabaseConnections.grantAgentElevation(
        ctx.mydshDatabase,
        exec.agent,
        target,
        elevation,
        catalog,
      )
    ctx.mydshConnectionAccess.grantSessionConsent(exec.agent, {
      name: target.profile.name,
      connection: target.connection,
      dependencies: target.dependencies,
    })
    const lease = ctx.mydshConnectionAccess.acquireLease(exec.agent, {
      name: target.profile.name,
      connection: target.connection,
      dependencies: target.dependencies,
      requireSessionConsent: true,
    })
    return {
      lease,
      elevation,
      authorization: requested ? 'elevated-session' : 'approved-session',
    }
  }
  if (decision === 'once') {
    const lease = ctx.mydshConnectionAccess.acquireLease(exec.agent, {
      name: target.profile.name,
      connection: target.connection,
      dependencies: target.dependencies,
      requireSessionConsent: false,
    })
    return {
      lease,
      elevation,
      authorization: requested ? 'elevated-once' : 'approved-once',
    }
  }
  throw new Error('USER_REJECTED：用户拒绝了此次数据库变更操作')
}
