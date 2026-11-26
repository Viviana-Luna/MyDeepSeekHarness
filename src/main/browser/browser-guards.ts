/**
 * 内置浏览器请求与导航守卫辅助：负责 IPC 字段白名单、同源本地预览校验、外部协议拦截及视口边界归一化。
 * 运行在 Electron 主进程，供 `browser-controller.ts` 复用。
 */
import { session, WebContentsView, type Event, type Rectangle } from 'electron'
import { browserUrl, parsePreviewUrl } from '../../shared/browser.ts'

/** 校验内置浏览器标签页标识格式。 */
export function isValidBrowserTabId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/u.test(value)
}

/** 创建禁用一切权限授予与设备访问的隔离内置浏览器 Session。 */
export function createIsolatedBrowserSession(): Electron.Session {
  const browserSession = session.fromPartition('persist:mydsh-browser-v1')
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
  browserSession.setPermissionCheckHandler(() => false)
  browserSession.setDevicePermissionHandler(() => false)
  return browserSession
}

/** 创建开启完整安全沙箱、隔离上下文且禁用 Node 集成的内置浏览器视图。 */
export function createSandboxedBrowserView(browserSession: Electron.Session): WebContentsView {
  const view = new WebContentsView({
    webPreferences: {
      session: browserSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  })
  view.setBorderRadius(8)
  view.setBackgroundColor('#ffffff')
  view.setVisible(false)
  return view
}

/** 判断浏览器视图矩形是否完整位于宿主窗口内容区内。 */
export function isViewBoundsInsideWindow(
  bounds: Rectangle,
  contentSize: readonly number[],
): boolean {
  const [width = 0, height = 0] = contentSize
  return (
    bounds.x >= 0 &&
    bounds.y >= 0 &&
    bounds.width >= 1 &&
    bounds.height >= 1 &&
    bounds.x + bounds.width <= width + 1 &&
    bounds.y + bounds.height <= height + 1
  )
}

/** 返回指定浏览器操作允许出现的 IPC 请求字段白名单。 */
export function allowedRequestFields(action: unknown): readonly string[] {
  if (action === 'navigate') return ['action', 'url']
  if (action === 'openFile') return ['action', 'projectId', 'relativePath']
  return ['action']
}

/** 判断目标地址是否属于已授权且与当前页同一项目的本地预览导航。 */
export function isAllowedSamePreviewNavigation(
  targetUrl: string,
  currentUrl: string,
  authorizedProjects: ReadonlySet<string>,
): boolean {
  const target = parsePreviewUrl(targetUrl)
  if (target === null || !authorizedProjects.has(target.projectAccessId)) return false
  const current = parsePreviewUrl(currentUrl)
  return current !== null && current.projectAccessId === target.projectAccessId
}

/** 拦截不受允许的协议跳转或跨项目预览访问。 */
export function guardNavigation(
  event: Event & { url?: string },
  currentUrl: string,
  authorizedProjects: ReadonlySet<string>,
  legacyUrl?: string,
): void {
  const targetUrl = event.url ?? legacyUrl ?? ''
  if (isAllowedSamePreviewNavigation(targetUrl, currentUrl, authorizedProjects)) return
  try {
    browserUrl(targetUrl)
  } catch {
    event.preventDefault()
  }
}

/** 校验并按宿主页面缩放系数归一化前端上报的浏览器布局请求。 */
export function parseLayoutRequest(
  request: Record<string, unknown>,
  zoomFactor: number,
): { visible: boolean; bounds?: Rectangle } {
  if (
    typeof request.visible !== 'boolean' ||
    Object.keys(request).some(key => !['action', 'visible', 'bounds'].includes(key))
  ) {
    throw new Error('浏览器布局参数无效')
  }
  if (request.bounds === undefined) return { visible: request.visible }
  if (typeof request.bounds !== 'object' || request.bounds === null) {
    throw new Error('浏览器边界无效')
  }
  const value = request.bounds as Record<string, unknown>
  const keys = ['x', 'y', 'width', 'height'] as const
  const valid =
    Object.keys(value).length === 4 &&
    keys.every(
      key =>
        typeof value[key] === 'number' &&
        Number.isFinite(value[key]) &&
        value[key] >= 0 &&
        value[key] <= 32768,
    )
  if (!valid) throw new Error('浏览器边界无效')
  return {
    visible: request.visible,
    bounds: {
      x: Math.round(Number(value.x) * zoomFactor),
      y: Math.round(Number(value.y) * zoomFactor),
      width: Math.round(Number(value.width) * zoomFactor),
      height: Math.round(Number(value.height) * zoomFactor),
    },
  }
}
