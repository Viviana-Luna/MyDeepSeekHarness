/**
 * 桌面 Computer Use 会话授权与截帧归属存储：按会话记忆已批准的目标作用域与 `captureId` 归属，随会话释放或急停自动撤销。
 * 运行在后台 Runtime，不持久化高危桌面操控授权。
 */
import type { Context } from '@deepseek-ai/cordis'
import '@mydsh/connection-access'

/** 主进程 `automation.computer.status` 返回的系统状态结构。 */
export interface ComputerUseStatusPayload {
  readonly permissions: {
    readonly platform: 'darwin' | 'win32' | 'other'
    readonly supported: boolean
    readonly nativeLoaded: boolean
    readonly accessibility: boolean
    readonly screenRecording: boolean
    readonly elevated?: boolean
    readonly note?: string
  }
  readonly scope: 'window' | 'display'
  readonly confirmEveryAction: boolean
  readonly maxImageLongEdge: number
  readonly displays: ReadonlyArray<{
    readonly id: number
    readonly label: string
    readonly bounds: {
      readonly x: number
      readonly y: number
      readonly width: number
      readonly height: number
    }
    readonly scaleFactor: number
    readonly primary: boolean
  }>
  readonly windows: ReadonlyArray<{
    readonly windowId: number
    readonly pid: number
    readonly appName: string
    readonly bundleId: string
    readonly title: string
    readonly bounds: {
      readonly x: number
      readonly y: number
      readonly width: number
      readonly height: number
    }
    readonly isFrontmost: boolean
  }>
}

/** 单个会话当前正在操控的目标应用记录。 */
export interface SessionTargetContext {
  readonly scopeKey: string
  readonly label: string
  readonly windowId?: number
  readonly pid?: number
}

/** 单次截图 `capture_id` 对应的受权作用域归属，防止跨应用复用旧截图绕过授权。 */
export interface CapturedTargetRecord {
  readonly captureId: string
  readonly scopeKey: string
  readonly label: string
  readonly scope: 'window' | 'display'
  readonly windowId?: number
  readonly pid?: number
}

/** 桌面 Computer Use 内存授权管理器。 */
export interface ComputerSessionGrantStore {
  hasTargetGrant(sessionId: string, scopeKey: string): boolean
  grantTarget(sessionId: string, scopeKey: string): void
  getActiveTarget(sessionId: string): SessionTargetContext | undefined
  setActiveTarget(sessionId: string, target: SessionTargetContext): void
  recordCapture(sessionId: string, record: CapturedTargetRecord): void
  getCapture(sessionId: string, captureId: string): CapturedTargetRecord | undefined
  revokeSession(sessionId: string): void
}

const BIDI_AND_CONTROL_RE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/gu

/** 清洗来自外部窗口标题或无障碍控件的不可信文本，剥离双向字符欺骗与控制字符。 */
export function sanitizeUntrustedText(raw: string, maxLen = 200, collapseNewlines = true): string {
  const cleaned = raw.replace(BIDI_AND_CONTROL_RE, '')
  const normalized = collapseNewlines ? cleaned.replace(/[\r\n]+/gu, ' ').trim() : cleaned
  return normalized.length > maxLen ? `${normalized.slice(0, maxLen)}…` : normalized
}

/** 严格按与主进程一致的顺序（`windowId` 优先于 `pid`）匹配窗口；显式传参未命中或两者冲突时拒绝。 */
export function matchWindowStrict(
  windows: ComputerUseStatusPayload['windows'],
  windowId?: number,
  pid?: number,
): ComputerUseStatusPayload['windows'][number] | undefined {
  if (windowId === undefined && pid === undefined) return undefined
  if (windowId !== undefined) {
    const byId = windows.find(item => item.windowId === windowId)
    if (!byId) {
      throw new Error(
        `未在当前可见窗口列表中找到 window_id=${windowId}，请重新调用 computer_status`,
      )
    }
    if (pid !== undefined && byId.pid !== pid) {
      throw new Error(
        `参数冲突：window_id=${windowId} 归属进程 pid=${byId.pid}，与传入的 pid=${pid} 不一致`,
      )
    }
    return byId
  }
  const byPid = windows.find(item => item.pid === pid)
  if (!byPid) {
    throw new Error(`未在当前可见窗口列表中找到 pid=${pid}，请重新调用 computer_status`)
  }
  return byPid
}

/** 校验工具参数对象不含 Schema 之外的未知字段。 */
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

/** 创建挂钩 Cordis 会话生命周期的桌面授权存储，确保会话关闭或归档即撤权。 */
export function createComputerSessionGrantStore(ctx: Context): ComputerSessionGrantStore {
  const grantsBySession = new Map<string, Set<string>>()
  const activeTargetBySession = new Map<string, SessionTargetContext>()
  const capturesBySession = new Map<string, Map<string, CapturedTargetRecord>>()

  const revokeSession = (sessionId: string): void => {
    grantsBySession.delete(sessionId)
    activeTargetBySession.delete(sessionId)
    capturesBySession.delete(sessionId)
  }

  ctx.on('agent/disposed', ({ agent }) => revokeSession(agent.id))
  ctx.on('session/disposed', session => revokeSession(session.id))
  ctx.on('api-session/removed', sessionId => revokeSession(sessionId))
  ctx.effect(() => () => {
    grantsBySession.clear()
    activeTargetBySession.clear()
    capturesBySession.clear()
  })

  return {
    hasTargetGrant: (sessionId, scopeKey) =>
      grantsBySession.get(sessionId)?.has(scopeKey.toLowerCase()) ?? false,
    grantTarget(sessionId, scopeKey) {
      let bucket = grantsBySession.get(sessionId)
      if (!bucket) {
        bucket = new Set()
        grantsBySession.set(sessionId, bucket)
      }
      bucket.add(scopeKey.toLowerCase())
    },
    getActiveTarget: sessionId => activeTargetBySession.get(sessionId),
    setActiveTarget(sessionId, target) {
      activeTargetBySession.set(sessionId, target)
    },
    recordCapture(sessionId, record) {
      let bucket = capturesBySession.get(sessionId)
      if (!bucket) {
        bucket = new Map()
        capturesBySession.set(sessionId, bucket)
      }
      bucket.set(record.captureId, record)
      while (bucket.size > 24) {
        const oldest = bucket.keys().next().value
        if (oldest) bucket.delete(oldest)
      }
    },
    getCapture: (sessionId, captureId) => capturesBySession.get(sessionId)?.get(captureId),
    revokeSession,
  }
}
