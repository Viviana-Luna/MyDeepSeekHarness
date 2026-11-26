/**
 * 主进程内置浏览器控制器：管理受隔离的 WebContentsView、导航守卫与本地项目预览会话。
 * 运行在 Electron 主进程；拥有每个标签对应的 WebContentsView 与项目预览引用计数，关闭或退出时释放。
 */
import { pathToFileURL } from 'node:url'
import {
  ipcMain,
  shell,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type WebContentsView,
} from 'electron'
import { captureManagedBrowserViewPng, resolveAutomationViewBounds } from './browser-capture.ts'
import {
  allowedRequestFields,
  createIsolatedBrowserSession,
  createSandboxedBrowserView,
  guardNavigation,
  isAllowedSamePreviewNavigation,
  isValidBrowserTabId,
  isViewBoundsInsideWindow,
  parseLayoutRequest,
} from './browser-guards.ts'
import {
  BROWSER_CHANNELS,
  EMPTY_BROWSER_STATE,
  browserUrl,
  isBrowserPreviewablePath,
  parsePreviewUrl,
  previewUrlForProjectFile,
  type BrowserState,
} from '../../shared/browser.ts'
import {
  installBrowserPreviewProtocol,
  resolvePreviewFile,
  type BrowserPreviewProtocolController,
} from './browser-preview.ts'

interface BrowserControllerOptions {
  readonly window: BrowserWindow
  assertSender(event: IpcMainInvokeEvent): void
  resolveProjectDirectory?(projectId: unknown): string
  onTabActivated?(tabId: string): void
  readonly browserSession: Electron.Session
  readonly previewProtocol: BrowserPreviewProtocolController
}

/** 远程网页与项目预览拥有独立 Session，无 preload、Node 或 MyDSH IPC；显隐与销毁分别处理。 */
function createBrowserView(options: BrowserControllerOptions, tabId: string) {
  const win = options.window
  const hostContents = win.webContents
  const browserSession = options.browserSession
  const previewProjectIds = new Set<string>()
  let view: WebContentsView | null = null
  let guestContents: Electron.WebContents | null = null
  let state: BrowserState = { ...EMPTY_BROWSER_STATE }
  let disposed = false
  let visible = false
  let navigation = 0
  let bounds = { x: 0, y: 0, width: 1, height: 1 }
  let captureTail: Promise<void> = Promise.resolve()

  const publish = (extra?: Partial<Pick<BrowserState, 'focused' | 'automated' | 'closed'>>) => {
    if (!disposed && !win.isDestroyed() && !hostContents.isDestroyed())
      hostContents.send(BROWSER_CHANNELS.changed, { ...state, ...extra, tabId })
  }
  const releasePreviews = () => {
    for (const id of previewProjectIds) options.previewProtocol.release(id)
    previewProjectIds.clear()
  }
  const authorizePreview = (projectAccessId: string) => {
    if (previewProjectIds.has(projectAccessId)) return
    previewProjectIds.add(projectAccessId)
    options.previewProtocol.authorize(projectAccessId)
  }
  const layout = () => {
    if (!view || win.isDestroyed()) return
    const valid = isViewBoundsInsideWindow(bounds, win.getContentSize())
    if (valid) view.setBounds(bounds)
    view.setVisible(visible && valid && state.error === null)
  }
  const close = (emitClosed = false) => {
    navigation += 1
    releasePreviews()
    const current = view,
      contents = guestContents
    view = null
    guestContents = null
    if (current && !win.isDestroyed()) win.contentView.removeChildView(current)
    if (contents && !contents.isDestroyed()) contents.close({ waitForBeforeUnload: false })
    state = { ...EMPTY_BROWSER_STATE }
    publish(emitClosed ? { closed: true } : undefined)
  }
  const loadTarget = async (
    targetUrl: string,
    previewPath: string | null,
    defaultTitle = '',
    automated = false,
    signal?: AbortSignal,
  ) => {
    signal?.throwIfAborted()
    const request = ++navigation
    const current = ensureView()
    state = {
      ...state,
      url: targetUrl,
      ...(defaultTitle ? { title: defaultTitle } : {}),
      loading: true,
      error: null,
      previewPath,
    }
    publish(automated ? { automated: true } : undefined)
    layout()
    const onAbort = () => {
      if (!current.webContents.isDestroyed()) current.webContents.stop()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await current.webContents.loadURL(targetUrl)
      signal?.throwIfAborted()
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error
      if (
        view !== current ||
        request !== navigation ||
        disposed ||
        current.webContents.isDestroyed()
      )
        return
      if (error instanceof Error && error.message.includes('ERR_ABORTED')) return
      state = {
        ...state,
        loading: false,
        error: previewPath
          ? '本地预览加载失败，请检查文件是否存在后重试。'
          : '网页加载失败，请检查地址或连接后重试。',
      }
      layout()
      publish()
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }
  const navigate = (url: string) => loadTarget(browserUrl(url), null)

  const openFile = async (projectId: string, relativePath: string) => {
    if (!options.resolveProjectDirectory) throw new Error('当前窗口暂不支持本地文件预览')
    if (!isBrowserPreviewablePath(relativePath))
      throw new Error('该文件类型暂不支持在内置浏览器中打开')
    const resolved = await resolvePreviewFile(
      options.resolveProjectDirectory,
      projectId,
      relativePath,
    )
    authorizePreview(projectId)
    const previewUrl = previewUrlForProjectFile(projectId, resolved.relativePath)
    const fileName = resolved.relativePath.split('/').at(-1) ?? resolved.relativePath
    void loadTarget(previewUrl, resolved.relativePath, fileName)
  }

  const ensureView = (): WebContentsView => {
    if (disposed || win.isDestroyed()) throw new Error('内置浏览器窗口已关闭')
    if (view) return view
    const current = createSandboxedBrowserView(browserSession)
    view = current
    win.contentView.addChildView(current)
    const contents = current.webContents
    guestContents = contents
    contents.on('focus', () => {
      options.onTabActivated?.(tabId)
      if (!disposed) publish({ focused: true })
    })
    contents.on('before-input-event', (event, input) => {
      if (
        input.type !== 'keyDown' ||
        !(input.meta || input.control) ||
        input.alt ||
        input.shift ||
        input.isAutoRepeat
      )
        return
      const key = input.key.toLowerCase()
      if (key === 'w' || key === 's') {
        event.preventDefault()
        hostContents.send('mydsh:workspace:tab-action', {
          action: key === 'w' ? 'close' : 'overview',
          browserId: tabId,
        })
      }
    })
    const update = () => {
      if (view !== current || contents.isDestroyed()) return
      const currentUrl = contents.getURL() || state.url
      const parsedPreview = parsePreviewUrl(currentUrl)
      const fallbackTitle = parsedPreview?.relativePath.split('/').at(-1) ?? ''
      state = {
        ...state,
        url: currentUrl,
        title: contents.getTitle() || fallbackTitle,
        loading: contents.isLoading(),
        canGoBack: contents.navigationHistory.canGoBack(),
        canGoForward: contents.navigationHistory.canGoForward(),
        previewPath: parsedPreview?.relativePath ?? null,
      }
      publish()
    }
    contents.setWindowOpenHandler(({ url }) => {
      const currentUrl = contents.getURL() || state.url
      if (isAllowedSamePreviewNavigation(url, currentUrl, previewProjectIds)) {
        const parsed = parsePreviewUrl(url)
        void loadTarget(url, parsed?.relativePath ?? null)
      } else {
        try {
          void navigate(browserUrl(url))
        } catch {
          /* 不放行本地或外部应用协议。 */
        }
      }
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, legacyUrl) => {
      guardNavigation(event, contents.getURL() || state.url, previewProjectIds, legacyUrl)
    })
    contents.on('will-redirect', (event, legacyUrl) => {
      guardNavigation(event, contents.getURL() || state.url, previewProjectIds, legacyUrl)
    })
    contents.on('will-attach-webview', event => {
      event.preventDefault()
    })
    contents.on('will-prevent-unload', event => {
      event.preventDefault()
    })
    contents.on('did-start-loading', update)
    contents.on('did-stop-loading', update)
    contents.on('did-navigate', () => {
      state = { ...state, error: null }
      update()
      layout()
    })
    contents.on('did-navigate-in-page', update)
    contents.on('page-title-updated', update)
    contents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
      if (view !== current || !isMainFrame || code === -3 || url !== state.url) return
      state = { ...state, loading: false, error: '网页加载失败，请检查地址或连接后重试。' }
      layout()
      publish()
    })
    contents.on('render-process-gone', () => {
      if (view === current) {
        close()
        state = { ...state, error: '网页进程已退出，请重新打开网址。' }
        publish()
      }
    })
    return current
  }

  const handleDownloadBlocked = (
    event: Electron.Event,
    contents: Electron.WebContents,
  ): boolean => {
    if (contents !== guestContents) return false
    event.preventDefault()
    state = { ...state, error: '请使用“在系统浏览器中打开”下载此文件。', loading: false }
    layout()
    publish()
    return true
  }

  const handleLayout = (request: Record<string, unknown>): BrowserState => {
    const parsed = parseLayoutRequest(request, hostContents.getZoomFactor())
    if (parsed.bounds !== undefined) bounds = parsed.bounds
    visible = parsed.visible
    if (visible) {
      options.onTabActivated?.(tabId)
      if (
        bounds.width >= 32 &&
        bounds.height >= 32 &&
        guestContents &&
        !guestContents.isDestroyed() &&
        guestContents.debugger?.isAttached()
      ) {
        // 视图恢复到真实分屏/面板布局后撤销后台 0x0 保护覆盖，让页面按实际面板宽度自适应排版。
        void guestContents.debugger
          .sendCommand('Emulation.clearDeviceMetricsOverride')
          .catch(() => {})
      }
    }
    layout()
    return state
  }

  const reloadCurrent = () => {
    const parsedPreview = parsePreviewUrl(state.url)
    if (view) {
      state = { ...state, error: null }
      layout()
      if (parsedPreview && typeof view.webContents.reloadIgnoringCache === 'function')
        view.webContents.reloadIgnoringCache()
      else view.webContents.reload()
      publish()
      return
    }
    if (!state.url) return
    if (parsedPreview && previewProjectIds.has(parsedPreview.projectAccessId))
      void loadTarget(state.url, parsedPreview.relativePath)
    else void navigate(state.url)
  }

  const openExternalCurrent = async () => {
    if (!state.url) return
    const parsedPreview = parsePreviewUrl(state.url)
    if (parsedPreview) {
      if (
        !options.resolveProjectDirectory ||
        !previewProjectIds.has(parsedPreview.projectAccessId) ||
        !isBrowserPreviewablePath(parsedPreview.relativePath)
      )
        throw new Error('当前预览文件不允许在系统浏览器中打开')
      const resolved = await resolvePreviewFile(
        options.resolveProjectDirectory,
        parsedPreview.projectAccessId,
        parsedPreview.relativePath,
      )
      await shell.openExternal(pathToFileURL(resolved.realPath).href)
      return
    }
    await shell.openExternal(browserUrl(state.url))
  }

  const handle = async (event: IpcMainInvokeEvent, input: unknown): Promise<BrowserState> => {
    options.assertSender(event)
    if (disposed || typeof input !== 'object' || input === null || !('action' in input))
      throw new Error('浏览器请求无效')
    const request = input as Record<string, unknown>
    if (request.action === 'layout') return handleLayout(request)
    const allowedFields = allowedRequestFields(request.action)
    if (Object.keys(request).some(key => !allowedFields.includes(key)))
      throw new Error('浏览器请求包含未知字段')
    switch (request.action) {
      case 'read':
        return state
      case 'navigate':
        if (typeof request.url !== 'string') throw new Error('浏览器地址无效')
        void navigate(request.url)
        break
      case 'openFile':
        if (typeof request.projectId !== 'string' || typeof request.relativePath !== 'string')
          throw new Error('本地预览文件参数无效')
        await openFile(request.projectId, request.relativePath)
        break
      case 'back':
        if (view?.webContents.navigationHistory.canGoBack())
          view.webContents.navigationHistory.goBack()
        break
      case 'forward':
        if (view?.webContents.navigationHistory.canGoForward())
          view.webContents.navigationHistory.goForward()
        break
      case 'reload':
        reloadCurrent()
        break
      case 'stop':
        view?.webContents.stop()
        break
      case 'close':
        close()
        break
      case 'external':
        await openExternalCurrent()
        break
      default:
        throw new Error('不支持的浏览器操作')
    }
    return state
  }
  const ensureAutomationBounds = (current: WebContentsView) => {
    const nextBounds = resolveAutomationViewBounds(win, bounds)
    if (nextBounds === bounds) return
    bounds = nextBounds
    current.setBounds(bounds)
  }
  const capturePng = async (captureOptions?: {
    fullPage?: boolean
    signal?: AbortSignal
  }): Promise<Buffer> => {
    captureOptions?.signal?.throwIfAborted()
    const prev = captureTail
    let release!: () => void
    captureTail = new Promise<void>(resolve => {
      release = resolve
    })
    try {
      await prev
      captureOptions?.signal?.throwIfAborted()
      const current = ensureView()
      ensureAutomationBounds(current)
      return await captureManagedBrowserViewPng({
        hostWindow: win,
        view: current,
        visible,
        bounds,
        ...captureOptions,
        canReattach: () => !disposed && view === current && !current.webContents.isDestroyed(),
        restoreLayout: () => {
          if (view === current) layout()
        },
      })
    } finally {
      release()
    }
  }
  const closeOnHostChange = () => {
    close()
  }
  win.on('resize', layout)
  hostContents.on('render-process-gone', closeOnHostChange)
  hostContents.on('did-navigate', closeOnHostChange)
  return {
    handle,
    getState: (): BrowserState => ({ ...state }),
    getWebContents: (): Electron.WebContents | null =>
      guestContents && !guestContents.isDestroyed() ? guestContents : null,
    capturePng,
    revealForAutomation() {
      options.onTabActivated?.(tabId)
      publish({ automated: true })
    },
    ensureWebContents(): Electron.WebContents {
      const current = ensureView()
      // 自动化操作可能在面板未聚焦时发生，按窗口内容区补足合理视口尺寸以保证截图与点击坐标有效。
      ensureAutomationBounds(current)
      return current.webContents
    },
    async navigateUrl(url: string, signal?: AbortSignal): Promise<BrowserState> {
      signal?.throwIfAborted()
      const current = ensureView()
      ensureAutomationBounds(current)
      options.onTabActivated?.(tabId)
      await loadTarget(browserUrl(url), null, '', true, signal)
      return { ...state }
    },
    handleDownloadBlocked,
    performAction(action: 'back' | 'forward' | 'reload' | 'stop' | 'close'): BrowserState {
      if (action === 'back' && view?.webContents.navigationHistory.canGoBack()) {
        view.webContents.navigationHistory.goBack()
      } else if (action === 'forward' && view?.webContents.navigationHistory.canGoForward()) {
        view.webContents.navigationHistory.goForward()
      } else if (action === 'reload') {
        reloadCurrent()
      } else if (action === 'stop') {
        view?.webContents.stop()
      } else if (action === 'close') {
        close(true)
      }
      return { ...state }
    },
    dispose() {
      if (disposed) return
      disposed = true
      close()
      win.removeListener('resize', layout)
      hostContents.removeListener('render-process-gone', closeOnHostChange)
      hostContents.removeListener('did-navigate', closeOnHostChange)
    },
  }
}

/** 暴露给主进程内置浏览器自动化驱动的标签元信息。 */
export interface EmbeddedBrowserTabSummary extends BrowserState {
  readonly tabId: string
}

/** 暴露给主进程内部调用的受管内置浏览器控制器句柄（不暴露给 renderer IPC）。 */
export interface EmbeddedBrowserController {
  listTabs(): EmbeddedBrowserTabSummary[]
  getActiveTabId(): string | null
  revealTab(tabId: string): void
  ensureTab(tabId?: string): {
    tabId: string
    webContents: Electron.WebContents
    state: BrowserState
  }
  getWebContents(tabId: string): Electron.WebContents | null
  captureTabPng(
    tabId: string,
    options?: { fullPage?: boolean; signal?: AbortSignal },
  ): Promise<Buffer>
  navigateTab(tabId: string, url: string, signal?: AbortSignal): Promise<BrowserState>
  tabAction(tabId: string, action: 'back' | 'forward' | 'reload' | 'stop' | 'close'): BrowserState
  dispose(): void
}

/** 每个标签只拥有一个受控网页；关闭、主文档导航和退出均释放对应实例与预览权限。 */
export function installBrowserController(options: {
  window: BrowserWindow
  assertSender(event: IpcMainInvokeEvent): void
  resolveProjectDirectory?(projectId: unknown): string
}): EmbeddedBrowserController {
  const hostContents = options.window.webContents
  const browserSession = createIsolatedBrowserSession()
  const previewProtocol = installBrowserPreviewProtocol({
    browserSession,
    ...(options.resolveProjectDirectory === undefined
      ? {}
      : { resolveProjectDirectory: options.resolveProjectDirectory }),
  })
  let activeTabId: string | null = null
  const viewOptions: BrowserControllerOptions = {
    window: options.window,
    assertSender: options.assertSender,
    browserSession,
    previewProtocol,
    onTabActivated: tabId => {
      activeTabId = tabId
    },
    ...(options.resolveProjectDirectory === undefined
      ? {}
      : { resolveProjectDirectory: options.resolveProjectDirectory }),
  }
  const views = new Map<string, ReturnType<typeof createBrowserView>>()
  const onSharedDownload = (
    event: Electron.Event,
    _item: Electron.DownloadItem,
    contents: Electron.WebContents,
  ) => {
    for (const managed of views.values()) {
      if (managed.handleDownloadBlocked(event, contents)) return
    }
  }
  browserSession.on('will-download', onSharedDownload)
  const ensureManagedView = (tabId: string) => {
    if (!isValidBrowserTabId(tabId)) throw new Error('浏览器标签标识无效')
    let view = views.get(tabId)
    if (!view) {
      if (views.size >= 12) throw new Error('一个窗口最多打开 12 个浏览器标签')
      view = createBrowserView(viewOptions, tabId)
      views.set(tabId, view)
    }
    return view
  }
  const clear = () => {
    for (const view of views.values()) view.dispose()
    views.clear()
    activeTabId = null
  }
  ipcMain.handle(BROWSER_CHANNELS.request, async (event, input: unknown) => {
    options.assertSender(event)
    if (typeof input !== 'object' || input === null) throw new Error('浏览器请求无效')
    const { tabId = 'default', ...request } = input as Record<string, unknown>
    if (!isValidBrowserTabId(tabId)) throw new Error('浏览器标签标识无效')
    let view = views.get(tabId)
    if (!view) {
      if (request.action === 'close' || (request.action === 'layout' && request.visible === false))
        return { ...EMPTY_BROWSER_STATE, tabId }
      view = ensureManagedView(tabId)
    }
    try {
      const state = await view.handle(event, request)
      if (request.action === 'navigate' || request.action === 'openFile') activeTabId = tabId
      if (request.action === 'close') {
        view.dispose()
        views.delete(tabId)
        if (activeTabId === tabId) activeTabId = null
      }
      return { ...state, tabId }
    } catch (error) {
      if (request.action === 'openFile' && view) {
        const currentState = await view.handle(event, { action: 'read' }).catch(() => null)
        if (currentState !== null && !currentState.url) {
          view.dispose()
          views.delete(tabId)
        }
      }
      throw error
    }
  })
  hostContents.on('did-navigate', clear)
  hostContents.on('render-process-gone', clear)
  return {
    listTabs: () => [...views.entries()].map(([tabId, view]) => ({ tabId, ...view.getState() })),
    getActiveTabId: () => (activeTabId && views.has(activeTabId) ? activeTabId : null),
    revealTab(tabId) {
      ensureManagedView(tabId).revealForAutomation()
    },
    ensureTab(tabId = 'default') {
      const view = ensureManagedView(tabId)
      return { tabId, webContents: view.ensureWebContents(), state: view.getState() }
    },
    getWebContents: tabId => views.get(tabId)?.getWebContents() ?? null,
    captureTabPng: (tabId, captureOptions) => ensureManagedView(tabId).capturePng(captureOptions),
    navigateTab: (tabId, url, signal) => ensureManagedView(tabId).navigateUrl(url, signal),
    tabAction(tabId, action) {
      const view = views.get(tabId)
      if (!view) return { ...EMPTY_BROWSER_STATE }
      const next = view.performAction(action)
      if (action === 'close') {
        view.dispose()
        views.delete(tabId)
        if (activeTabId === tabId) activeTabId = null
      }
      return next
    },
    dispose() {
      clear()
      browserSession.removeListener('will-download', onSharedDownload)
      previewProtocol.dispose()
      ipcMain.removeHandler(BROWSER_CHANNELS.request)
      hostContents.removeListener('did-navigate', clear)
      hostContents.removeListener('render-process-gone', clear)
    },
  }
}
