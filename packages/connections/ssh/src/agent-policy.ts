/**
 * SSH 模型访问策略与路径边界：运行在后台 Runtime，负责策略规范化、目录白名单校验与会话提权合并。
 * 不持有网络连接或系统凭据，所有路径检查均按 POSIX 远端语义执行。
 */
import { posix } from 'node:path'
import type { SshAgentAccess, SshAgentAccessMode } from '../types.d.ts'

/** 用户在单次调用或当前会话内临时批准的 SSH 权限提权；仅驻留内存，不修改连接配置。 */
export interface SshPermissionElevation {
  mode?: SshAgentAccessMode
  allowSudo?: boolean
}

const ACCESS_MODES = new Set<SshAgentAccessMode>(['readonly', 'standard', 'full'])

const MODE_RANK: Readonly<Record<SshAgentAccessMode, number>> = Object.freeze({
  readonly: 0,
  standard: 1,
  full: 2,
})

const MODE_LABELS: Readonly<Record<SshAgentAccessMode, string>> = Object.freeze({
  readonly: '只读',
  standard: '常规运维',
  full: '完整访问',
})

/** 当前平台是否支持 MyDSH SSH 连接与工具能力。 */
export function isSupportedSshPlatform(): boolean {
  return process.platform === 'darwin' || process.platform === 'win32'
}

/** 生成默认 SSH 模型访问策略：默认关闭，开启后默认只读且禁止 sudo。 */
export function createDefaultSshAgentAccess(): SshAgentAccess {
  return {
    enabled: false,
    mode: 'readonly',
    allowSudo: false,
    allowedPaths: [],
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  // 独立工作区包无法引用 src/shared，因此在边界处保留最小对象判别函数。
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 32 || code === 127) return true
  }
  return false
}

/**
 * 校验并规范化远端 POSIX 绝对路径。
 * @throws 路径为空、含控制字符、超长或不是以 `/` 开头的绝对路径时抛出。
 */
export function normalizeRemotePosixPath(value: unknown, label = '远端路径'): string {
  if (typeof value !== 'string') throw new Error(`${label}必须是字符串`)
  if (!value || value.length > 1024 || hasControlCharacters(value))
    throw new Error(`${label}格式无效或超过 1024 字符上限`)
  if (!value.startsWith('/'))
    throw new Error(`${label}必须是绝对 POSIX 路径（以 / 开头），不支持相对路径或 ~`)
  const normalized = posix.normalize(value)
  if (normalized.length > 1 && normalized.endsWith('/')) return normalized.slice(0, -1)
  return normalized
}

/**
 * 校验并规范化 SSH 连接保存的模型访问策略；旧记录缺失该字段时回退为关闭状态。
 * @throws 字段类型非法、模式无效或目录规则超过限制时抛出。
 */
export function normalizeSshAgentAccess(value: unknown, fallback?: SshAgentAccess): SshAgentAccess {
  if (value === undefined) {
    const base = fallback ?? createDefaultSshAgentAccess()
    return { ...base, allowedPaths: [...base.allowedPaths] }
  }
  if (!isPlainRecord(value)) throw new Error('SSH 模型访问策略格式无效')
  const allowedKeys = new Set(['enabled', 'mode', 'allowSudo', 'allowedPaths'])
  if (Object.keys(value).some(key => !allowedKeys.has(key)))
    throw new Error('SSH 模型访问策略包含未知字段')
  if (typeof value.enabled !== 'boolean') throw new Error('SSH 模型访问开关必须是布尔值')
  if (typeof value.mode !== 'string' || !ACCESS_MODES.has(value.mode as SshAgentAccessMode))
    throw new Error('SSH 模型访问档位无效，仅支持 readonly、standard 或 full')
  if (typeof value.allowSudo !== 'boolean') throw new Error('SSH sudo 提权开关必须是布尔值')
  if (!Array.isArray(value.allowedPaths) || value.allowedPaths.length > 50)
    throw new Error('允许访问路径必须是列表且最多 50 条')
  const normalizedPaths: string[] = []
  const seen = new Set<string>()
  for (const item of value.allowedPaths) {
    if (typeof item !== 'string' || item !== item.trim() || item.length > 512)
      throw new Error('允许访问路径不能含首尾空白或超过 512 字符')
    const normalized = normalizeRemotePosixPath(item, '允许访问路径')
    if (seen.has(normalized)) throw new Error(`允许访问路径存在重复项：${normalized}`)
    seen.add(normalized)
    normalizedPaths.push(normalized)
  }
  return {
    enabled: value.enabled,
    mode: value.mode as SshAgentAccessMode,
    allowSudo: value.allowSudo,
    allowedPaths: normalizedPaths,
  }
}

/** 返回档位对应的中文展示名称。 */
export function sshModeLabel(mode: SshAgentAccessMode): string {
  return MODE_LABELS[mode]
}

/** 判断规范化后的远端绝对路径是否落在允许目录白名单内；白名单为空时放行。 */
export function isPathWithinAllowed(
  resolvedPath: string,
  allowedPaths: readonly string[],
): boolean {
  if (allowedPaths.length === 0) return true
  const candidate = normalizeRemotePosixPath(resolvedPath, '远端路径')
  for (const allowed of allowedPaths) {
    const root = normalizeRemotePosixPath(allowed, '允许访问路径')
    if (root === '/') return true
    if (candidate === root || candidate.startsWith(`${root}/`)) return true
  }
  return false
}

/**
 * 断言解析后的远端真实路径符合目录白名单边界。
 * @throws 越出连接允许路径范围时抛出 `PERMISSION_DENIED` 错误。
 */
export function assertRemotePathAllowed(
  resolvedPath: string,
  allowedPaths: readonly string[],
  label = '目标路径',
): void {
  if (!isPathWithinAllowed(resolvedPath, allowedPaths)) {
    throw new Error(
      `PERMISSION_DENIED：${label} ${resolvedPath} 不在当前连接允许访问的路径范围内（允许：${allowedPaths.join('、')}）`,
    )
  }
}

/** 返回档位比较序，用于判断权限是否满足或需要提权。 */
export function sshModeRank(mode: SshAgentAccessMode): number {
  return MODE_RANK[mode]
}

/** 计算配置档位与会话提权合并后的有效最高档位。 */
export function effectiveSshMode(
  baseMode: SshAgentAccessMode,
  elevation?: SshPermissionElevation,
): SshAgentAccessMode {
  if (!elevation?.mode) return baseMode
  return MODE_RANK[elevation.mode] > MODE_RANK[baseMode] ? elevation.mode : baseMode
}

/** 计算配置与会话提权合并后是否允许进入 sudo 确认流。 */
export function effectiveAllowSudo(
  baseAllowSudo: boolean,
  elevation?: SshPermissionElevation,
): boolean {
  return baseAllowSudo || Boolean(elevation?.allowSudo)
}

/** 合并两次 SSH 会话提权，保留更高档位与已开启的 sudo 许可。 */
export function mergeSshElevations(
  left: SshPermissionElevation | undefined,
  right: SshPermissionElevation | undefined,
): SshPermissionElevation | undefined {
  if (!left) return right ? { ...right } : undefined
  if (!right) return { ...left }
  let mode = left.mode ?? right.mode
  if (left.mode && right.mode) {
    mode = MODE_RANK[right.mode] > MODE_RANK[left.mode] ? right.mode : left.mode
  }
  const allowSudo = Boolean(left.allowSudo || right.allowSudo)
  return {
    ...(mode ? { mode } : {}),
    ...(allowSudo ? { allowSudo: true } : {}),
  }
}

/** 生成用于 `ssh_connections_list` 的脱敏模型策略摘要。 */
export function summarizeSshAgentAccess(access: SshAgentAccess) {
  return {
    enabled: access.enabled,
    mode: access.mode,
    allow_sudo: access.allowSudo,
    allowed_paths: [...access.allowedPaths],
  }
}

/** 生成当前会话临时提权摘要，供模型与日志辨别有效范围。 */
export function summarizeSshElevation(elevation: SshPermissionElevation | undefined) {
  if (!elevation || (!elevation.mode && !elevation.allowSudo)) return null
  return {
    ...(elevation.mode ? { mode: elevation.mode } : {}),
    ...(elevation.allowSudo ? { allow_sudo: true } : {}),
  }
}
