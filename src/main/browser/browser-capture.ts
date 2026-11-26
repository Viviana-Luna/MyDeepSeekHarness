/**
 * 内置浏览器截帧辅助：兼容前台可见与后台隐藏 `WebContentsView` 的视口/整页 PNG 捕获。
 * 运行在 Electron 主进程；后台截帧通过零透明度、不抢焦点的临时离屏窗口恢复 Chromium Viz 合成面，支持取消中断与销毁安全清理。
 */
import { BrowserWindow, type Rectangle, type WebContents, type WebContentsView } from 'electron'

const CDP_CAPTURE_TIMEOUT_MS = 5_000
const FRAME_WAIT_TIMEOUT_MS = 400

async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return
  signal?.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('内置浏览器截帧已取消'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('内置浏览器截帧已取消'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

async function waitForCompositorFrame(
  webContents: WebContents,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  if (webContents.isDestroyed()) return
  const frameReady = webContents
    .executeJavaScript(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))',
      true,
    )
    .catch(() => false)
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    await raceWithAbort(
      Promise.race([
        frameReady,
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, FRAME_WAIT_TIMEOUT_MS)
        }),
      ]),
      signal,
    )
  } finally {
    if (timer) clearTimeout(timer)
  }
  await abortableSleep(40, signal)
}

async function captureViaCdp(
  webContents: WebContents,
  fullPage: boolean,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  if (webContents.isDestroyed() || !webContents.debugger.isAttached()) return null
  signal?.throwIfAborted()
  const command = webContents.debugger.sendCommand('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    ...(fullPage ? { captureBeyondViewport: true } : {}),
  }) as Promise<{ data?: string }>
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    const result = await raceWithAbort(
      Promise.race([
        command.catch(() => null),
        new Promise<null>(resolve => {
          timer = setTimeout(() => resolve(null), CDP_CAPTURE_TIMEOUT_MS)
        }),
      ]),
      signal,
    )
    if (!result || typeof result.data !== 'string' || result.data.length === 0) return null
    const png = Buffer.from(result.data, 'base64')
    return png.byteLength > 0 ? png : null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function captureDirectPng(
  webContents: WebContents,
  fullPage: boolean,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted()
  if (webContents.isDestroyed()) throw new Error('内置浏览器标签已关闭')
  if (fullPage) {
    const fullPng = await captureViaCdp(webContents, true, signal)
    if (fullPng) return fullPng
  }
  let lastError: unknown = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    signal?.throwIfAborted()
    if (webContents.isDestroyed()) throw new Error('内置浏览器标签已关闭')
    try {
      const image = await raceWithAbort(webContents.capturePage(), signal)
      if (!image.isEmpty()) {
        const png = image.toPNG()
        if (png.byteLength > 0) return png
      }
    } catch (error) {
      if (signal?.aborted) throw error
      lastError = error
    }
    if (attempt === 0 && !webContents.isDestroyed()) {
      webContents.invalidate()
      await waitForCompositorFrame(webContents, signal)
    }
  }
  const fallback = await captureViaCdp(webContents, fullPage, signal)
  if (fallback) return fallback
  const detail = lastError instanceof Error ? lastError.message : '未获取到有效图像帧'
  throw new Error(`内置浏览器截图失败：${detail}`, lastError ? { cause: lastError } : undefined)
}

/** 捕获当前处于前台可见态的 `WebContentsView` PNG 字节，内置帧重绘重试与 CDP 回退。 */
export async function captureVisibleBrowserViewPng(options: {
  view: WebContentsView
  fullPage?: boolean
  signal?: AbortSignal
}): Promise<Buffer> {
  return captureDirectPng(options.view.webContents, options.fullPage === true, options.signal)
}

/** 在不改变主窗口用户可见状态与焦点的前提下捕获隐藏 `WebContentsView` 的 PNG 字节。 */
export async function captureHiddenBrowserViewPng(options: {
  hostWindow: BrowserWindow
  view: WebContentsView
  bounds: Rectangle
  fullPage?: boolean
  signal?: AbortSignal
  canReattach?(): boolean
  restoreLayout(): void
}): Promise<Buffer> {
  const { hostWindow, view, bounds, restoreLayout, canReattach } = options
  options.signal?.throwIfAborted()
  if (view.webContents.isDestroyed()) throw new Error('内置浏览器标签已关闭')
  const width = Math.max(320, bounds.width)
  const height = Math.max(240, bounds.height)
  const offscreen = new BrowserWindow({
    width,
    height,
    x: -10_000,
    y: -10_000,
    show: false,
    frame: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    paintWhenInitiallyHidden: true,
    enableLargerThanScreen: true,
    opacity: 0,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  if (typeof offscreen.setIgnoreMouseEvents === 'function') {
    offscreen.setIgnoreMouseEvents(true)
  }
  try {
    try {
      if (!hostWindow.isDestroyed()) hostWindow.contentView.removeChildView(view)
      offscreen.contentView.addChildView(view)
      view.setBounds({ x: 0, y: 0, width, height })
      view.setVisible(true)
      if (typeof offscreen.showInactive === 'function') offscreen.showInactive()
      if (!view.webContents.isDestroyed()) view.webContents.invalidate()
      await waitForCompositorFrame(view.webContents, options.signal)
      return await captureDirectPng(view.webContents, options.fullPage === true, options.signal)
    } finally {
      if (!offscreen.isDestroyed()) offscreen.contentView.removeChildView(view)
      const stillAlive =
        !hostWindow.isDestroyed() &&
        !view.webContents.isDestroyed() &&
        (canReattach ? canReattach() : true)
      if (stillAlive) {
        hostWindow.contentView.addChildView(view)
        restoreLayout()
      }
    }
  } finally {
    if (!offscreen.isDestroyed()) offscreen.destroy()
  }
}

/** 按宿主页窗口内容区补足自动化截帧所需的最小有效视口矩形。 */
export function resolveAutomationViewBounds(win: BrowserWindow, current: Rectangle): Rectangle {
  if (current.width > 1 && current.height > 1) return current
  const [contentWidth = 1280, contentHeight = 720] = win.isDestroyed()
    ? [1280, 720]
    : win.getContentSize()
  return {
    x: 0,
    y: 0,
    width: Math.max(320, contentWidth),
    height: Math.max(240, contentHeight),
  }
}

/** 统一捕获内置浏览器视图 PNG：前台可见时直采，隐藏或遮挡时自动降级到无焦点离屏合成面。 */
export async function captureManagedBrowserViewPng(options: {
  hostWindow: BrowserWindow
  view: WebContentsView
  visible: boolean
  bounds: Rectangle
  fullPage?: boolean
  signal?: AbortSignal
  canReattach(): boolean
  restoreLayout(): void
}): Promise<Buffer> {
  const { hostWindow, view, visible, bounds, fullPage, signal, canReattach, restoreLayout } =
    options
  const hostVisible =
    !hostWindow.isDestroyed() &&
    (typeof hostWindow.isVisible !== 'function' || hostWindow.isVisible()) &&
    (typeof hostWindow.isMinimized !== 'function' || !hostWindow.isMinimized())
  if (visible && hostVisible) {
    try {
      return await captureVisibleBrowserViewPng({
        view,
        ...(fullPage !== undefined ? { fullPage } : {}),
        ...(signal ? { signal } : {}),
      })
    } catch (error) {
      if (signal?.aborted) throw error
      // 面板切换或窗口遮挡期间捕获失败时降级到离屏合成面抓取。
    }
  }
  return captureHiddenBrowserViewPng({
    hostWindow,
    view,
    bounds,
    ...(fullPage !== undefined ? { fullPage } : {}),
    ...(signal ? { signal } : {}),
    canReattach,
    restoreLayout,
  })
}
