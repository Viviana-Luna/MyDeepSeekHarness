/** 测试主进程内置浏览器控制器的网页导航、本地项目预览隔离边界与生命周期清理。 */
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import {
  browserUrl,
  BROWSER_CHANNELS,
  isBrowserDirectOpenPath,
  isBrowserPreviewablePath,
  parsePreviewUrl,
  previewUrlForProjectFile,
} from '../src/shared/browser.ts'
const mocks = vi.hoisted(() => ({
  handler: null as null | ((event: unknown, value: unknown) => Promise<unknown>),
  protocolHandlers: new Map<string, (request: Request) => Promise<Response>>(),
  unhandle: vi.fn((scheme: string) => {
    mocks.protocolHandlers.delete(scheme)
  }),
  views: [] as any[],
  openExternal: vi.fn(),
  removeHandler: vi.fn(),
  permission: null as any,
}))
vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  const partition = Object.assign(new Emitter(), {
    setPermissionRequestHandler: vi.fn(fn => {
      mocks.permission = fn
    }),
    setPermissionCheckHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    protocol: {
      handle: vi.fn((scheme: string, handler: (request: Request) => Promise<Response>) => {
        mocks.protocolHandlers.set(scheme, handler)
      }),
      unhandle: mocks.unhandle,
    },
  })
  return {
    ipcMain: {
      handle: vi.fn((_name, handler) => {
        mocks.handler = handler
      }),
      removeHandler: mocks.removeHandler,
    },
    session: { fromPartition: vi.fn(() => partition) },
    shell: { openExternal: mocks.openExternal },
    WebContentsView: class {
      preferences: unknown
      setBounds = vi.fn()
      setVisible = vi.fn()
      setBorderRadius = vi.fn()
      setBackgroundColor = vi.fn()
      webContents = Object.assign(new Emitter(), {
        currentUrl: 'https://example.com/',
        isDestroyed: () => false,
        loadURL: vi.fn(async (url: string) => {
          this.webContents.currentUrl = url
        }),
        close: vi.fn(),
        stop: vi.fn(),
        reload: vi.fn(),
        reloadIgnoringCache: vi.fn(),
        getURL: () => this.webContents.currentUrl,
        getTitle: () => '示例',
        isLoading: () => false,
        setWindowOpenHandler: vi.fn(),
        debugger: {
          attached: false,
          isAttached() {
            return this.attached
          },
          attach: vi.fn(function (this: { attached: boolean }) {
            this.attached = true
          }),
          detach: vi.fn(function (this: { attached: boolean }) {
            this.attached = false
          }),
          sendCommand: vi.fn(async () => ({})),
          on: vi.fn(),
          removeListener: vi.fn(),
        },
        navigationHistory: {
          canGoBack: () => true,
          canGoForward: () => false,
          goBack: vi.fn(),
          goForward: vi.fn(),
        },
      })
      constructor(options: unknown) {
        this.preferences = options
        mocks.views.push(this)
      }
    },
  }
})
import { installBrowserController } from '../src/main/browser/browser-controller.ts'

const temporaryRoots: string[] = []
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture(resolveProjectDirectory?: (projectId: unknown) => string) {
  mocks.views = []
  mocks.protocolHandlers.clear()
  mocks.unhandle.mockClear()
  mocks.openExternal.mockClear()
  mocks.removeHandler.mockClear()
  const win = Object.assign(new EventEmitter(), {
    isDestroyed: (): boolean => false,
    getContentSize: () => [1280, 800],
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    webContents: Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      send: vi.fn(),
      getZoomFactor: () => 1,
    }),
  })
  const sender = {}
  const controller = installBrowserController({
    window: win as unknown as BrowserWindow,
    assertSender: event => {
      if (event !== sender) throw new Error('拒绝不受信任的页面')
    },
    ...(resolveProjectDirectory === undefined ? {} : { resolveProjectDirectory }),
  })
  const request = (value: unknown) => mocks.handler!(sender as IpcMainInvokeEvent, value)
  return { win, controller, request }
}
describe('内置浏览器隔离与生命周期', () => {
  it('补全普通网址与本机预览地址，拒绝本地文件、脚本与外部应用协议', () => {
    expect(browserUrl('example.com')).toBe('https://example.com/')
    expect(browserUrl('localhost:4173/test')).toBe('http://localhost:4173/test')
    for (const url of [
      'file:///C:/secret',
      'javascript:alert(1)',
      'data:text/html,hello',
      'mydsh://settings',
      'https://user:password@example.com',
    ])
      expect(() => browserUrl(url)).toThrow()
  })
  it('远程网页没有桌面权限，隐藏保留页面，关闭与主窗口退出释放网页', async () => {
    const { request, controller, win } = fixture()
    try {
      await request({ action: 'navigate', url: 'https://example.com' })
      const view = mocks.views[0]
      expect(view.preferences.webPreferences).toMatchObject({
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
      })
      expect(view.preferences.webPreferences.preload).toBeUndefined()
      const permission = vi.fn()
      mocks.permission({}, 'camera', permission)
      expect(permission).toHaveBeenCalledWith(false)
      await request({
        action: 'layout',
        visible: true,
        bounds: { x: 900, y: 80, width: 360, height: 700 },
      })
      expect(view.setVisible).toHaveBeenLastCalledWith(true)
      await request({ action: 'layout', visible: false })
      expect(view.webContents.close).not.toHaveBeenCalled()
      expect(view.setVisible).toHaveBeenLastCalledWith(false)
      await request({
        action: 'layout',
        visible: true,
        bounds: { x: 1200, y: 0, width: 800, height: 700 },
      })
      expect(view.setVisible).toHaveBeenLastCalledWith(false)
      await request({ action: 'close' })
      expect(view.webContents.close).toHaveBeenCalledOnce()
      await request({ action: 'navigate', url: 'https://example.com' })
      controller.dispose()
      expect(mocks.views[1].webContents.close).toHaveBeenCalledOnce()
      expect(win.contentView.removeChildView).toHaveBeenCalledTimes(2)
      expect(mocks.removeHandler).toHaveBeenCalledWith(BROWSER_CHANNELS.request)
      expect(win.listenerCount('resize')).toBe(0)
    } finally {
      controller.dispose()
    }
  })
  it('拒绝伪造 IPC、未知动作和字段，并拦截网页协议跳转与弹窗', async () => {
    const { request, controller } = fixture()
    try {
      await expect(mocks.handler!({}, { action: 'read' })).rejects.toThrow('不受信任')
      await expect(request({ action: 'executeJavaScript', code: 'secret' })).rejects.toThrow()
      await expect(request({ action: 'read', path: 'secret' })).rejects.toThrow('未知字段')
      await expect(
        request({ action: 'layout', visible: true, bounds: { x: NaN, y: 0, width: 1, height: 1 } }),
      ).rejects.toThrow('边界无效')
      await request({ action: 'navigate', url: 'https://example.com' })
      const contents = mocks.views[0].webContents
      const event = { url: 'file:///C:/secret', preventDefault: vi.fn() }
      contents.emit('will-redirect', event)
      expect(event.preventDefault).toHaveBeenCalledOnce()
      const handler = contents.setWindowOpenHandler.mock.calls[0][0]
      expect(handler({ url: 'custom://application' })).toEqual({ action: 'deny' })
      expect(mocks.openExternal).not.toHaveBeenCalled()
    } finally {
      controller.dispose()
    }
  })
  it('主窗口先销毁时仍能清理浏览器监听，不再访问已释放的窗口或视图', async () => {
    const { request, controller, win } = fixture()
    await request({ action: 'navigate', url: 'https://example.com' })
    const host = win.webContents
    const guest = mocks.views[0].webContents
    win.isDestroyed = () => true
    guest.isDestroyed = () => true
    Object.defineProperty(win, 'webContents', {
      get() {
        throw new Error('窗口已销毁')
      },
    })
    Object.defineProperty(mocks.views[0], 'webContents', {
      get() {
        throw new Error('视图已销毁')
      },
    })
    expect(() => {
      controller.dispose()
      controller.dispose()
    }).not.toThrow()
    expect(host.listenerCount('render-process-gone')).toBe(0)
    expect(host.listenerCount('did-navigate')).toBe(0)
    expect(mocks.removeHandler).toHaveBeenCalledWith(BROWSER_CHANNELS.request)
  })
  it('取消主页面导航不关闭网页，真正切换主文档后才释放网页', async () => {
    const { request, controller, win } = fixture()
    try {
      await request({ action: 'navigate', url: 'https://example.com' })
      const contents = mocks.views[0].webContents
      win.webContents.emit('did-start-navigation', {}, 'file:///mydsh/startup.html', false, true)
      expect(contents.close).not.toHaveBeenCalled()
      await request({ action: 'back' })
      expect(contents.navigationHistory.goBack).toHaveBeenCalledOnce()
      win.webContents.emit('did-navigate', {}, 'file:///mydsh/renderer/index.html')
      expect(contents.close).toHaveBeenCalledOnce()
    } finally {
      controller.dispose()
    }
    expect(win.webContents.listenerCount('did-navigate')).toBe(0)
  })

  it('打开受授权项目内的 HTML 与子资源，隔离越界路径和跨域访问并在关闭后释放协议', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mydsh-preview-'))
    temporaryRoots.push(root)
    const projectDir = join(root, 'project')
    const outsideDir = join(root, 'outside')
    const outsideFile = join(root, 'secret.html')
    const outsideNestedFile = join(outsideDir, 'secret.html')
    mkdirSync(join(projectDir, 'pages'), { recursive: true })
    mkdirSync(outsideDir, { recursive: true })
    writeFileSync(join(projectDir, 'pages', 'index.html'), '<h1>本地预览</h1>')
    writeFileSync(join(projectDir, 'pages', 'about.html'), '<h1>关于</h1>')
    writeFileSync(join(projectDir, 'pages', 'style.css'), 'body { color: red; }')
    writeFileSync(outsideFile, '<h1>越界内容</h1>')
    writeFileSync(outsideNestedFile, '<h1>目录联接越界内容</h1>')
    // Windows 非开发者模式无法创建文件符号链接，改用目录联接同样验证软链越界拦截。
    const escapeRelativePath =
      process.platform === 'win32' ? 'escape-dir/secret.html' : 'escape.html'
    if (process.platform === 'win32') {
      symlinkSync(outsideDir, join(projectDir, 'escape-dir'), 'junction')
    } else {
      symlinkSync(outsideFile, join(projectDir, 'escape.html'))
    }

    const projectId = '0123456789abcdef01234567'
    const otherProjectId = 'fedcba9876543210fedcba98'
    expect(isBrowserPreviewablePath('pages/index.html')).toBe(true)
    expect(isBrowserPreviewablePath('docs/manual.pdf')).toBe(true)
    expect(isBrowserDirectOpenPath('docs/manual.pdf')).toBe(true)
    expect(isBrowserDirectOpenPath('pages/index.html')).toBe(false)
    expect(isBrowserPreviewablePath('secret.env')).toBe(false)
    expect(parsePreviewUrl(previewUrlForProjectFile(projectId, 'pages/index.html'))).toEqual({
      projectAccessId: projectId,
      relativePath: 'pages/index.html',
    })

    const { controller, request } = fixture(id => {
      if (id === projectId) return projectDir
      throw new Error('项目未授权')
    })
    try {
      await expect(
        request({
          action: 'openFile',
          tabId: 'tab-preview',
          projectId,
          relativePath: '../secret.html',
        }),
      ).rejects.toThrow('越界')
      await expect(
        request({
          action: 'openFile',
          tabId: 'tab-preview',
          projectId,
          relativePath: escapeRelativePath,
        }),
      ).rejects.toThrow('越出项目目录边界')
      await expect(
        request({
          action: 'openFile',
          tabId: 'tab-preview',
          projectId,
          relativePath: 'secret.env',
        }),
      ).rejects.toThrow('暂不支持在内置浏览器中打开')
      await expect(
        request({
          action: 'openFile',
          tabId: 'tab-preview',
          projectId: otherProjectId,
          relativePath: 'pages/index.html',
        }),
      ).rejects.toThrow('未授权')

      const state = (await request({
        action: 'openFile',
        tabId: 'tab-preview',
        projectId,
        relativePath: 'pages/index.html',
      })) as { url: string; previewPath: string }
      expect(state.url).toBe(`mydsh-preview://${projectId}/pages/index.html`)
      expect(state.previewPath).toBe('pages/index.html')

      const handler = mocks.protocolHandlers.get('mydsh-preview')
      expect(handler).toBeDefined()
      const htmlResponse = await handler!(
        new Request(`mydsh-preview://${projectId}/pages/index.html`),
      )
      expect(htmlResponse.status).toBe(200)
      expect(htmlResponse.headers.get('content-type')).toBe('text/html; charset=utf-8')
      expect(htmlResponse.headers.get('cache-control')).toBe('no-store')
      expect(await htmlResponse.text()).toContain('本地预览')

      const cssResponse = await handler!(
        new Request(`mydsh-preview://${projectId}/pages/style.css`, {
          headers: {
            origin: `mydsh-preview://${projectId}`,
            referer: `mydsh-preview://${projectId}/pages/index.html`,
          },
        }),
      )
      expect(cssResponse.status).toBe(200)
      expect(cssResponse.headers.get('content-type')).toBe('text/css; charset=utf-8')

      const crossOrigin = await handler!(
        new Request(`mydsh-preview://${projectId}/pages/index.html`, {
          headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
        }),
      )
      expect(crossOrigin.status).toBe(403)

      const foreignReferer = await handler!(
        new Request(`mydsh-preview://${projectId}/pages/index.html`, {
          headers: { referer: 'https://evil.example/' },
        }),
      )
      expect(foreignReferer.status).toBe(403)

      const unauthorizedProject = await handler!(
        new Request(`mydsh-preview://${otherProjectId}/pages/index.html`),
      )
      expect(unauthorizedProject.status).toBe(403)

      const view = mocks.views[0]
      const sameOriginLink = {
        url: `mydsh-preview://${projectId}/pages/about.html`,
        preventDefault: vi.fn(),
      }
      view.webContents.emit('will-navigate', sameOriginLink)
      expect(sameOriginLink.preventDefault).not.toHaveBeenCalled()

      const foreignPreview = {
        url: `mydsh-preview://${otherProjectId}/pages/index.html`,
        preventDefault: vi.fn(),
      }
      view.webContents.emit('will-navigate', foreignPreview)
      expect(foreignPreview.preventDefault).toHaveBeenCalledOnce()

      await request({ action: 'reload', tabId: 'tab-preview' })
      expect(view.webContents.reloadIgnoringCache).toHaveBeenCalledOnce()

      await request({ action: 'external', tabId: 'tab-preview' })
      expect(mocks.openExternal).toHaveBeenCalledWith(expect.stringContaining('/pages/index.html'))

      await request({ action: 'close', tabId: 'tab-preview' })
      const afterClose = await handler!(
        new Request(`mydsh-preview://${projectId}/pages/index.html`),
      )
      expect(afterClose.status).toBe(403)
    } finally {
      controller.dispose()
    }
    expect(mocks.unhandle).toHaveBeenCalledWith('mydsh-preview')
  })

  it('自动化导航/显露/关闭事件附带同步标记，且可见布局恢复时撤销后台视口覆盖', async () => {
    const { controller, request, win } = fixture()
    try {
      await request({ action: 'read', tabId: 'user-tab-1' })
      await request({
        action: 'layout',
        tabId: 'user-tab-1',
        visible: true,
        bounds: { x: 20, y: 80, width: 600, height: 680 },
      })
      expect(controller.getActiveTabId()).toBe('user-tab-1')

      await controller.navigateTab('user-tab-1', 'https://example.com/')
      expect(win.webContents.send).toHaveBeenCalledWith(
        BROWSER_CHANNELS.changed,
        expect.objectContaining({
          tabId: 'user-tab-1',
          url: 'https://example.com/',
          automated: true,
        }),
      )

      const guest = mocks.views[0].webContents
      guest.debugger.attached = true
      await request({
        action: 'layout',
        tabId: 'user-tab-1',
        visible: true,
        bounds: { x: 400, y: 80, width: 580, height: 680 },
      })
      expect(guest.debugger.sendCommand).toHaveBeenCalledWith(
        'Emulation.clearDeviceMetricsOverride',
      )

      controller.tabAction('user-tab-1', 'close')
      expect(win.webContents.send).toHaveBeenCalledWith(
        BROWSER_CHANNELS.changed,
        expect.objectContaining({
          tabId: 'user-tab-1',
          closed: true,
        }),
      )
      expect(controller.getActiveTabId()).toBeNull()
    } finally {
      controller.dispose()
    }
  })
})
