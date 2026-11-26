/** 主进程数据库模型权限参数边界；只校验桌面配置的公开策略字段，不接触凭据或连接执行。 */
import { isRecord } from '../../shared/validation.ts'

const PERMISSION_KEYS = ['select', 'insert', 'update', 'delete', 'ddl'] as const
const RULE_KEYS = ['schema', 'table', ...PERMISSION_KEYS] as const
const ACCESS_KEYS = ['enabled', 'mode', 'tableRules'] as const
const ACCESS_MODES = new Set(['readonly', 'readwrite', 'full'])
const SSH_ACCESS_KEYS = ['enabled', 'mode', 'allowSudo', 'allowedPaths'] as const
const SSH_ACCESS_MODES = new Set(['readonly', 'standard', 'full'])

function validIdentifier(value: unknown, maximum = 64): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !Array.from(value).some(character => character.charCodeAt(0) < 32)
  )
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).length === keys.length && keys.every(key => Object.hasOwn(record, key))
}

function checkPermissionFlags(value: unknown, keys: readonly string[]): void {
  if (!isRecord(value) || !hasExactKeys(value, keys))
    throw new Error('数据库模型权限开关字段不在允许范围内')
  for (const key of PERMISSION_KEYS) {
    if (typeof value[key] !== 'boolean') throw new Error(`数据库权限开关 ${key} 必须是布尔值`)
  }
}

/** 校验桌面「数据库」模式保存的模型访问策略与表级权限规则。 */
export function checkDatabaseAgentAccess(value: unknown): void {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ACCESS_KEYS) ||
    typeof value.enabled !== 'boolean' ||
    typeof value.mode !== 'string' ||
    !ACCESS_MODES.has(value.mode) ||
    Buffer.byteLength(JSON.stringify(value)) > 128 * 1024
  )
    throw new Error('数据库模型访问策略格式无效或超过大小上限')
  if (!Array.isArray(value.tableRules) || value.tableRules.length > 200)
    throw new Error('数据库表级权限规则必须是列表且最多 200 条')
  const seen = new Set<string>()
  for (const rule of value.tableRules) {
    checkPermissionFlags(rule, RULE_KEYS)
    const entry = rule as Record<string, unknown>
    if (!validIdentifier(entry.schema) || (entry.table !== '*' && !validIdentifier(entry.table)))
      throw new Error('表级权限规则中的数据库或表名无效')
    const dedupeKey = `${String(entry.schema).toLowerCase()}\0${String(entry.table).toLowerCase()}`
    if (seen.has(dedupeKey)) throw new Error('数据库表级权限规则存在重复目标')
    seen.add(dedupeKey)
  }
}

function hasControlChar(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 32 || code === 127) return true
  }
  return false
}

/** 校验桌面「SSH」模式保存的模型访问策略、sudo 开关与目录白名单。 */
export function checkSshAgentAccess(value: unknown): void {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, SSH_ACCESS_KEYS) ||
    typeof value.enabled !== 'boolean' ||
    typeof value.mode !== 'string' ||
    !SSH_ACCESS_MODES.has(value.mode) ||
    typeof value.allowSudo !== 'boolean' ||
    Buffer.byteLength(JSON.stringify(value)) > 64 * 1024
  )
    throw new Error('SSH 模型访问策略格式无效或超过大小上限')
  if (!Array.isArray(value.allowedPaths) || value.allowedPaths.length > 50)
    throw new Error('SSH 允许访问路径必须是列表且最多 50 条')
  const seen = new Set<string>()
  for (const item of value.allowedPaths) {
    if (
      typeof item !== 'string' ||
      !item ||
      item !== item.trim() ||
      item.length > 512 ||
      !item.startsWith('/') ||
      hasControlChar(item)
    )
      throw new Error('SSH 允许访问路径必须是不含控制字符的绝对 POSIX 路径')
    const normalized = item.length > 1 && item.endsWith('/') ? item.slice(0, -1) : item
    if (seen.has(normalized)) throw new Error('SSH 允许访问路径存在重复项')
    seen.add(normalized)
  }
}
