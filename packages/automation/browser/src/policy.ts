/**
 * 浏览器自动化策略守卫与会话临时授权存储：负责 URL 协议校验、域名白黑名单判定、目标选择与会话生命周期清理。
 * 运行在后台 Runtime；会话内授权仅驻留内存，随会话释放、归档或全局急停自动清除。
 */
import type { Context } from '@deepseek-ai/cordis'
import '@mydsh/connection-access'

/** 浏览器控制目标：内置隔离浏览器或外置本机浏览器（纯 CDP）。 */
export type BrowserTarget = 'embedded' | 'external'

/** 主进程 `automation.browser.status` 返回的实时配置与连接摘要。 */
export interface BrowserAutomationStatus {
  readonly embedded: {
    readonly enabled: boolean
    readonly allowLocalhostWithoutConfirm: boolean
    readonly allowedOrigins: readonly string[]
    readonly blockedOrigins: readonly string[]
  }
  readonly external: {
    readonly enabled: boolean
    readonly mode: 'managed' | 'attached'
    readonly executablePath: string | null
    readonly attachPort: number | null
    readonly allowedOrigins: readonly string[]
    readonly connected: boolean
    readonly targetLabel: string | null
  }
  readonly takeover: {
    readonly active: boolean
    readonly kind: string | null
    readonly stepCount: number
  }
}

/** 遇到验证码、支付或密码登录时主进程返回的人工接管信号。 */
export interface BrowserHandoffPayload {
  readonly required: true
  readonly category: 'captcha' | 'payment' | 'auth'
  readonly reason: string
  readonly url: string
}

const BIDI_AND_CONTROL_RE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/gu
const SENSITIVE_URL_KEY_RE =
  /(?:token|access_token|refresh_token|secret|password|passwd|api_key|apikey|key|auth|signature|sig|session|cookie)/iu

/** 清洗来自外部网页的不可信文本，去除双向字符欺骗与控制字符。 */
export function sanitizeUntrustedWebText(
  raw: string,
  maxLen = 32_768,
  collapseNewlines = false,
): string {
  const cleaned = raw.replace(BIDI_AND_CONTROL_RE, '')
  const normalized = collapseNewlines ? cleaned.replace(/[\r\n]+/gu, ' ').trim() : cleaned
  return normalized.length > maxLen ? `${normalized.slice(0, maxLen)}…` : normalized
}

/** 脱敏展示或诊断用的网页 URL（移除凭据及敏感 query/hash 参数）。 */
export function sanitizeWebUrlForOutput(rawUrl: string): string {
  if (!rawUrl) return ''
  try {
    const parsed = new URL(rawUrl)
    parsed.username = ''
    parsed.password = ''
    for (const [key] of parsed.searchParams) {
      if (SENSITIVE_URL_KEY_RE.test(key)) parsed.searchParams.set(key, '[REDACTED]')
    }
    if (parsed.hash.length > 1) {
      const hashBody = parsed.hash.slice(1)
      if (SENSITIVE_URL_KEY_RE.test(hashBody) && hashBody.includes('=')) {
        const params = new URLSearchParams(hashBody)
        for (const [key] of params) {
          if (SENSITIVE_URL_KEY_RE.test(key)) params.set(key, '[REDACTED]')
        }
        parsed.hash = `#${params.toString()}`
      } else if (SENSITIVE_URL_KEY_RE.test(hashBody)) {
        parsed.hash = '#[REDACTED]'
      }
    }
    return sanitizeUntrustedWebText(parsed.href, 500, true)
  } catch {
    return sanitizeUntrustedWebText(rawUrl, 500, true)
  }
}

/** 校验工具参数不含 Schema 之外的未知字段。 */
export function assertAllowedFields(
  args: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  toolName: string,
): void {
  const unknown = Object.keys(args).filter(key => !allowed.has(key))
  if (unknown.length > 0) {
    throw new Error(`参数错误：${toolName} 不支持未知参数 ${unknown.join(', ')}`)
  }
}

/** 校验并规范化浏览器导航 URL，仅允许 http/https，拒绝 file/javascript/data、控制字符与内嵌凭据。 */
export function normalizeBrowserNavigationUrl(rawUrl: string): { url: string; origin: string } {
  const trimmed = rawUrl.trim()
  if (!trimmed) throw new Error('网址不能为空')
  if (
    trimmed.length > 8192 ||
    [...trimmed].some(ch => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)
  ) {
    throw new Error('网址长度越界或包含非法控制字符')
  }
  let withScheme = `https://${trimmed}`
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(trimmed)) withScheme = trimmed
  else if (/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/iu.test(trimmed)) {
    withScheme = `http://${trimmed}`
  }
  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    throw new Error(`网址格式无效：${rawUrl}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `PERMISSION_DENIED：仅允许访问 http 或 https 网址，已拒绝协议 ${parsed.protocol}`,
    )
  }
  if (parsed.username || parsed.password) {
    throw new Error('PERMISSION_DENIED：不允许在网址中嵌入用户名或密码凭据')
  }
  return { url: parsed.href, origin: parsed.origin.toLowerCase() }
}

/** 判断 origin 是否属于本机 loopback 调试地址。 */
export function isLocalhostOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin)
    const host = parsed.hostname.toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

/** 判断目标浏览器（内置或外置），若未显式传入则优先选用当前已启用的目标。 */
export function resolveBrowserTarget(
  requested: string | undefined,
  status: BrowserAutomationStatus,
): BrowserTarget {
  if (requested === 'embedded') {
    if (!status.embedded.enabled) {
      throw new Error(
        'PERMISSION_DENIED：内置浏览器控制已关闭，请在「设置 → 浏览器与桌面操控」中开启',
      )
    }
    return 'embedded'
  }
  if (requested === 'external') {
    if (!status.external.enabled) {
      throw new Error(
        'PERMISSION_DENIED：外置浏览器控制已关闭，请在「设置 → 浏览器与桌面操控」中开启',
      )
    }
    return 'external'
  }
  if (requested !== undefined) {
    throw new Error('target 只能为 embedded（内置浏览器）或 external（外置浏览器）')
  }
  if (status.embedded.enabled) return 'embedded'
  if (status.external.enabled) return 'external'
  throw new Error(
    'PERMISSION_DENIED：内置浏览器控制与外置浏览器控制均已关闭，请先在「设置 → 浏览器与桌面操控」中开启其中一项',
  )
}

/** 根据用户配置与本会话临时同意判断某域名 origin 的放行策略。 */
export function evaluateOriginPolicy(input: {
  origin: string
  target: BrowserTarget
  status: BrowserAutomationStatus
  sessionOrigins: ReadonlySet<string>
}): 'allowed' | 'blocked' | 'needs-consent' {
  const normalized = input.origin.toLowerCase()
  const blocked = input.status.embedded.blockedOrigins.map(item => item.toLowerCase())
  if (blocked.includes(normalized)) return 'blocked'
  if (input.sessionOrigins.has(normalized)) return 'allowed'
  const allowedList =
    input.target === 'embedded'
      ? input.status.embedded.allowedOrigins
      : input.status.external.allowedOrigins
  if (allowedList.map(item => item.toLowerCase()).includes(normalized)) return 'allowed'
  if (
    input.target === 'embedded' &&
    input.status.embedded.allowLocalhostWithoutConfirm &&
    isLocalhostOrigin(normalized)
  ) {
    // 禁止内置浏览器借 localhost 免确认规则自动探测外置浏览器 CDP 调试端口。
    const attachPort = input.status.external.attachPort
    if (attachPort !== null) {
      try {
        if (Number(new URL(normalized).port) === attachPort) return 'needs-consent'
      } catch {
        /* 解析失败按需确认处理。 */
      }
    }
    return 'allowed'
  }
  return 'needs-consent'
}

/** 会话级浏览器域名与外置附着授权存储，随会话释放自动清空。 */
export interface BrowserSessionGrantStore {
  getOrigins(sessionId: string): ReadonlySet<string>
  grantOrigin(sessionId: string, origin: string): void
  hasExternalAttachApproval(sessionId: string, port: number): boolean
  grantExternalAttachApproval(sessionId: string, port: number): void
  revokeSession(sessionId: string): void
}

/** 创建挂钩 Cordis 会话生命周期的内存授权表，避免权限跨会话泄漏。 */
export function createBrowserSessionGrantStore(ctx: Context): BrowserSessionGrantStore {
  const originsBySession = new Map<string, Set<string>>()
  const externalPortsBySession = new Map<string, Set<number>>()

  const revokeSession = (sessionId: string): void => {
    originsBySession.delete(sessionId)
    externalPortsBySession.delete(sessionId)
  }

  ctx.on('agent/disposed', ({ agent }) => revokeSession(agent.id))
  ctx.on('session/disposed', session => revokeSession(session.id))
  ctx.on('api-session/removed', sessionId => revokeSession(sessionId))
  ctx.effect(() => () => {
    originsBySession.clear()
    externalPortsBySession.clear()
  })

  return {
    getOrigins: sessionId => originsBySession.get(sessionId) ?? new Set<string>(),
    grantOrigin(sessionId, origin) {
      let bucket = originsBySession.get(sessionId)
      if (!bucket) {
        bucket = new Set()
        originsBySession.set(sessionId, bucket)
      }
      bucket.add(origin.toLowerCase())
    },
    hasExternalAttachApproval: (sessionId, port) =>
      externalPortsBySession.get(sessionId)?.has(port) ?? false,
    grantExternalAttachApproval(sessionId, port) {
      let bucket = externalPortsBySession.get(sessionId)
      if (!bucket) {
        bucket = new Set()
        externalPortsBySession.set(sessionId, bucket)
      }
      bucket.add(port)
    },
    revokeSession,
  }
}
