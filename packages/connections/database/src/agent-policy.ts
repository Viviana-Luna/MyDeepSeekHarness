/** 数据库模式中配置的模型访问策略：校验连接档位、表级规则与实际权限。 */
import type {
  DatabaseAgentAccess,
  DatabaseAgentAccessMode,
  DatabaseEngine,
  DatabasePermissionFlags,
  DatabasePermissionKey,
  DatabaseStatementTarget,
  DatabaseTablePermission,
} from '../types.d.ts'
import { isSystemSchema, isSystemTable, quoteIdentifier } from './dialect.ts'

export { isSystemSchema }

/** MySQL / MariaDB 系统库集合，保持导出供既有单测引用。 */
export const SYSTEM_SCHEMAS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys'])

/** 用户在单次调用或当前会话内临时批准的业务表权限；不修改连接配置。 */
export interface DatabasePermissionElevation {
  mode?: DatabaseAgentAccessMode
  connectionPermissions?: DatabasePermissionFlags
  targets?: readonly DatabaseTablePermission[]
}

const PERMISSION_KEYS: readonly DatabasePermissionKey[] = [
  'select',
  'insert',
  'update',
  'delete',
  'ddl',
]

const OPERATION_LABELS: Record<DatabasePermissionKey, string> = {
  select: '查询（SELECT / 结构）',
  insert: '新增（INSERT）',
  update: '修改（UPDATE）',
  delete: '删除（DELETE）',
  ddl: '结构变更（DDL）',
}

const MODE_PERMISSIONS: Readonly<Record<DatabaseAgentAccessMode, DatabasePermissionFlags>> =
  Object.freeze({
    readonly: Object.freeze({
      select: true,
      insert: false,
      update: false,
      delete: false,
      ddl: false,
    }),
    readwrite: Object.freeze({
      select: true,
      insert: true,
      update: true,
      delete: true,
      ddl: false,
    }),
    full: Object.freeze({
      select: true,
      insert: true,
      update: true,
      delete: true,
      ddl: true,
    }),
  })

const ACCESS_MODES = new Set<DatabaseAgentAccessMode>(['readonly', 'readwrite', 'full'])

/** 返回指定访问档位允许的最大权限集合。 */
export function permissionsForMode(mode: DatabaseAgentAccessMode): DatabasePermissionFlags {
  return { ...MODE_PERMISSIONS[mode] }
}

function legacyMode(flags: DatabasePermissionFlags): DatabaseAgentAccessMode {
  if (flags.ddl) return 'full'
  if (flags.insert || flags.update || flags.delete) return 'readwrite'
  return 'readonly'
}

function intersectFlags(
  ceiling: DatabasePermissionFlags,
  flags: DatabasePermissionFlags,
): DatabasePermissionFlags {
  return {
    select: ceiling.select && flags.select,
    insert: ceiling.insert && flags.insert,
    update: ceiling.update && flags.update,
    delete: ceiling.delete && flags.delete,
    ddl: ceiling.ddl && flags.ddl,
  }
}

function unionFlags(
  left: DatabasePermissionFlags,
  right: DatabasePermissionFlags | undefined,
): DatabasePermissionFlags {
  if (!right) return left
  return {
    select: left.select || right.select,
    insert: left.insert || right.insert,
    update: left.update || right.update,
    delete: left.delete || right.delete,
    ddl: left.ddl || right.ddl,
  }
}

function higherMode(
  current: DatabaseAgentAccessMode,
  requested: DatabaseAgentAccessMode | undefined,
): DatabaseAgentAccessMode {
  const rank: Record<DatabaseAgentAccessMode, number> = { readonly: 0, readwrite: 1, full: 2 }
  return requested && rank[requested] > rank[current] ? requested : current
}

function elevatedTargetPermissions(
  elevation: DatabasePermissionElevation | undefined,
  schema: string,
  table: string,
): DatabasePermissionFlags | undefined {
  if (!elevation?.targets) return undefined
  const targetSchema = schema.toLowerCase()
  const targetTable = table.toLowerCase()
  const exact = elevation.targets.find(
    rule => rule.schema.toLowerCase() === targetSchema && rule.table.toLowerCase() === targetTable,
  )
  if (exact) return exact
  return elevation.targets.find(
    rule => rule.schema.toLowerCase() === targetSchema && rule.table === '*',
  )
}

/** 合并连续提权，保留已批准的档位、连接级权限和目标表权限。 */
export function mergePermissionElevations(
  left: DatabasePermissionElevation | undefined,
  right: DatabasePermissionElevation | undefined,
): DatabasePermissionElevation | undefined {
  if (!left) return right
  if (!right) return left
  const targets = new Map<string, DatabaseTablePermission>()
  for (const rule of [...(left.targets ?? []), ...(right.targets ?? [])]) {
    const key = `${rule.schema.toLowerCase()}\0${rule.table.toLowerCase()}`
    const previous = targets.get(key)
    targets.set(
      key,
      previous
        ? {
            schema: rule.schema,
            table: rule.table,
            ...unionFlags(previous, rule),
          }
        : rule,
    )
  }
  return {
    ...(higherMode(left.mode ?? 'readonly', right.mode) === 'readonly'
      ? {}
      : { mode: higherMode(left.mode ?? 'readonly', right.mode) }),
    ...(left.connectionPermissions || right.connectionPermissions
      ? {
          connectionPermissions: unionFlags(
            left.connectionPermissions ?? {
              select: false,
              insert: false,
              update: false,
              delete: false,
              ddl: false,
            },
            right.connectionPermissions,
          ),
        }
      : {}),
    ...(targets.size ? { targets: [...targets.values()] } : {}),
  }
}

/** 判断连接是否已开放全部操作且没有表级覆盖规则，可按 DBX 式通用 SQL 入口执行。 */
export function hasUnrestrictedAgentAccess(access: DatabaseAgentAccess): boolean {
  return access.enabled && access.mode === 'full' && access.tableRules.length === 0
}

function normalizeFlags(
  value: unknown,
  fallback: DatabasePermissionFlags,
): DatabasePermissionFlags {
  if (value === undefined) return { ...fallback }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('数据库权限开关格式无效')
  const record = value as Record<string, unknown>
  const result: DatabasePermissionFlags = { ...fallback }
  for (const key of PERMISSION_KEYS) {
    if (key in record) {
      if (typeof record[key] !== 'boolean') throw new Error(`权限开关 ${key} 必须是布尔值`)
      result[key] = record[key]
    }
  }
  return result
}

function normalizeRule(
  value: unknown,
  mode: DatabaseAgentAccessMode,
  engine: DatabaseEngine = 'mysql',
): DatabaseTablePermission {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('表级权限规则必须是对象')
  const record = value as Record<string, unknown>
  if (typeof record.schema !== 'string' || typeof record.table !== 'string')
    throw new Error('表级权限规则必须指定数据库和表名称')
  const schema = record.schema.trim()
  const table = record.table.trim()
  quoteIdentifier(schema, engine)
  if (isSystemSchema(schema, engine)) throw new Error(`表级权限规则不能针对系统库：${schema}`)
  if (table !== '*') {
    quoteIdentifier(table, engine)
    if (isSystemTable(table, engine)) throw new Error(`表级权限规则不能针对系统保留表：${table}`)
  }
  return {
    schema,
    table,
    ...intersectFlags(permissionsForMode(mode), normalizeFlags(record, permissionsForMode(mode))),
  }
}

/** 校验并归一化模型访问策略；未配置的连接保持关闭，开启后默认仅可读取。 */
export function normalizeAgentAccess(
  value?: unknown,
  engine: DatabaseEngine = 'mysql',
): DatabaseAgentAccess {
  if (value === undefined || value === null) {
    return {
      enabled: false,
      mode: 'readonly',
      tableRules: [],
    }
  }
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('模型访问配置必须是对象')
  const record = value as Record<string, unknown>
  if (typeof record.enabled !== 'boolean') throw new Error('模型访问总开关必须是布尔值')
  let mode: DatabaseAgentAccessMode
  if (record.mode === undefined) {
    const legacyFlags = normalizeFlags(
      record.defaultPermissions,
      permissionsForMode(record.defaultPermissions === undefined ? 'readonly' : 'full'),
    )
    mode = legacyMode(legacyFlags)
  } else {
    if (
      typeof record.mode !== 'string' ||
      !ACCESS_MODES.has(record.mode as DatabaseAgentAccessMode)
    )
      throw new Error('数据库模型访问档位无效')
    mode = record.mode as DatabaseAgentAccessMode
  }
  if (!Array.isArray(record.tableRules) || record.tableRules.length > 200)
    throw new Error('表级权限规则必须是列表且最多 200 条')
  const seen = new Set<string>()
  const tableRules = record.tableRules.map(item => {
    const rule = normalizeRule(item, mode, engine)
    const key = `${rule.schema.toLowerCase()}\0${rule.table.toLowerCase()}`
    if (seen.has(key)) throw new Error(`表级权限规则重复：${rule.schema}.${rule.table}`)
    seen.add(key)
    return rule
  })
  return { enabled: record.enabled, mode, tableRules }
}

/** 解析具体库表生效的五项权限：精确表规则 > 整库通配规则 > 默认权限。 */
export function resolveTablePermissions(
  access: DatabaseAgentAccess,
  schema: string,
  table: string,
  elevation?: DatabasePermissionElevation,
  engine: DatabaseEngine = 'mysql',
): DatabasePermissionFlags {
  if (!access.enabled || isSystemSchema(schema, engine) || isSystemTable(table, engine)) {
    return { select: false, insert: false, update: false, delete: false, ddl: false }
  }
  const targetSchema = schema.toLowerCase()
  const targetTable = table.toLowerCase()
  const ceiling = permissionsForMode(higherMode(access.mode, elevation?.mode))
  const elevated = elevatedTargetPermissions(elevation, schema, table)
  const exact = access.tableRules.find(
    rule => rule.schema.toLowerCase() === targetSchema && rule.table.toLowerCase() === targetTable,
  )
  if (exact)
    return unionFlags(
      unionFlags(intersectFlags(ceiling, exact), elevation?.connectionPermissions),
      elevated,
    )
  const wildcard = access.tableRules.find(
    rule => rule.schema.toLowerCase() === targetSchema && rule.table === '*',
  )
  const resolved = wildcard ? intersectFlags(ceiling, wildcard) : ceiling
  return unionFlags(unionFlags(resolved, elevation?.connectionPermissions), elevated)
}

/** 判断没有具体表目标时，连接档位是否允许指定操作；用于完整访问模式的前置拒绝。 */
export function assertOperationPermitted(
  access: DatabaseAgentAccess,
  operation: DatabasePermissionKey,
  elevation?: DatabasePermissionElevation,
): void {
  if (!access.enabled) throw new Error('PERMISSION_DENIED：当前连接未开放给模型调用')
  const permissions = unionFlags(
    permissionsForMode(higherMode(access.mode, elevation?.mode)),
    elevation?.connectionPermissions,
  )
  if (!permissions[operation])
    throw new Error(`PERMISSION_DENIED：当前连接的模型访问档位不允许${OPERATION_LABELS[operation]}`)
}

/** 返回未获得业务表权限的目标；系统库仍交给硬边界处理，不进入提权流程。 */
export function deniedTargets(
  access: DatabaseAgentAccess,
  targets: readonly DatabaseStatementTarget[],
  elevation?: DatabasePermissionElevation,
  engine: DatabaseEngine = 'mysql',
): DatabaseStatementTarget[] {
  if (!access.enabled) return [...targets]
  return targets.filter(
    target =>
      !isSystemSchema(target.schema, engine) &&
      !isSystemTable(target.table, engine) &&
      !resolveTablePermissions(access, target.schema, target.table, elevation, engine)[
        target.operation
      ],
  )
}

/** 判断在结构发现阶段是否允许向模型列出该业务库，可叠加临时提权。 */
export function canListSchema(
  access: DatabaseAgentAccess,
  schema: string,
  elevation?: DatabasePermissionElevation,
  engine: DatabaseEngine = 'mysql',
): boolean {
  if (!access.enabled || isSystemSchema(schema, engine)) return false
  const targetSchema = schema.toLowerCase()
  if (!permissionsForMode(higherMode(access.mode, elevation?.mode)).select) return false
  if (elevation?.connectionPermissions?.select) return true
  if (elevation?.targets?.some(rule => rule.schema.toLowerCase() === targetSchema && rule.select))
    return true
  const wildcard = access.tableRules.find(
    rule => rule.schema.toLowerCase() === targetSchema && rule.table === '*',
  )
  const effectiveDefault = wildcard ? wildcard.select : true
  if (effectiveDefault) return true
  return access.tableRules.some(
    rule => rule.schema.toLowerCase() === targetSchema && rule.table !== '*' && rule.select,
  )
}

/** 校验全部语句涉及的目标是否均获得连接策略放行，未通过时立即抛出中文拒绝说明。 */
export function assertTargetsPermitted(
  access: DatabaseAgentAccess,
  targets: readonly DatabaseStatementTarget[],
  elevation?: DatabasePermissionElevation,
  engine: DatabaseEngine = 'mysql',
): void {
  if (!access.enabled) throw new Error('PERMISSION_DENIED：当前连接未开放给模型调用')
  for (const target of targets) {
    if (isSystemSchema(target.schema, engine))
      throw new Error(`PERMISSION_DENIED：系统库 ${target.schema} 不允许模型访问`)
    if (isSystemTable(target.table, engine))
      throw new Error(`PERMISSION_DENIED：系统保留表 ${target.table} 不允许模型访问`)
    const flags = resolveTablePermissions(access, target.schema, target.table, elevation, engine)
    if (!flags[target.operation]) {
      const targetName =
        target.table === '*' ? `${target.schema}.*` : `${target.schema}.${target.table}`
      throw new Error(
        `PERMISSION_DENIED：当前连接的模型权限策略不允许对 ${targetName} 执行${OPERATION_LABELS[target.operation]}`,
      )
    }
  }
}

/** 生成当前会话临时提权的公开摘要，便于模型与轨迹区分静态配置与本会话临时提权。 */
export function summarizePermissionElevation(elevation: DatabasePermissionElevation | undefined) {
  if (!elevation) return null
  return {
    ...(elevation.mode ? { mode: elevation.mode } : {}),
    ...(elevation.targets?.length
      ? {
          targets: elevation.targets.map(rule => ({
            schema: rule.schema,
            table: rule.table,
            select: rule.select,
            insert: rule.insert,
            update: rule.update,
            delete: rule.delete,
            ddl: rule.ddl,
          })),
        }
      : {}),
  }
}

/** 生成用于向模型发现接口展示的脱敏策略摘要。 */
export function summarizeAgentAccess(access: DatabaseAgentAccess) {
  const permissions = permissionsForMode(access.mode)
  return {
    enabled: access.enabled,
    mode: access.mode,
    mode_permissions: {
      select: permissions.select,
      insert: permissions.insert,
      update: permissions.update,
      delete: permissions.delete,
      ddl: permissions.ddl,
    },
    table_rules: access.tableRules.map(rule => ({
      schema: rule.schema,
      table: rule.table,
      select: rule.select,
      insert: rule.insert,
      update: rule.update,
      delete: rule.delete,
      ddl: rule.ddl,
    })),
  }
}
