import { release } from 'node:os'
import { ipcMain, nativeTheme, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import {
  DESKTOP_WINDOW_CHANNELS,
  type DesktopCanvasComposition,
  type DesktopWindowState,
} from '../shared/window.ts'
import { installWindowBackground } from './window-background.ts'

export function supportsWindowsBackdrop(platform: string, version: string): boolean {
  const [major = 0, , build = 0] = version.split('.').map(Number)
  return platform === 'win32' && (major > 10 || (major === 10 && build >= 22_621))
}

/** 启动页与工作台共用窗口按钮；只接受本窗口、受信任页面的主 frame。 */
export function installWindowController(options: {
  window: BrowserWindow
  isTrustedPage: (url: string) => boolean
  platform?: string
  osRelease?: string
}) {
  const win = options.window
  const contents = win.webContents
  const platform = options.platform ?? process.platform
  const backdropSupported = supportsWindowsBackdrop(platform, options.osRelease ?? release())
  let disposed = false
  let canvasComposition: DesktopCanvasComposition = platform === 'darwin' ? 'transparent' : 'opaque'
  let backdropFailed = false

  const read = (): DesktopWindowState => ({
    platform,
    maximized: win.isMaximized(),
    maximizable: win.isResizable() && win.isMaximizable(),
    minimizable: win.isMinimizable(),
    canvasComposition,
    cornerRadius: background.readCornerRadius(),
    canvasClip: background.readClip(),
  })
  const assertSender = (event: IpcMainInvokeEvent): void => {
    if (
      disposed ||
      win.isDestroyed() ||
      event.sender !== win.webContents ||
      event.senderFrame === null ||
      event.senderFrame !== win.webContents.mainFrame ||
      !options.isTrustedPage(event.senderFrame.url)
    ) {
      throw new Error('窗口请求不是来自受信任的本地主页面')
    }
  }
  let lastPublished = ''
  const publish = (): void => {
    if (
      disposed ||
      win.isDestroyed() ||
      win.webContents.isDestroyed() ||
      !options.isTrustedPage(win.webContents.getURL())
    )
      return
    const next = read()
    lastPublished = JSON.stringify(next)
    win.webContents.send(DESKTOP_WINDOW_CHANNELS.changed, next)
  }
  const publishIfChanged = (): void => {
    if (
      disposed ||
      win.isDestroyed() ||
      win.webContents.isDestroyed() ||
      !options.isTrustedPage(win.webContents.getURL())
    )
      return
    const next = read()
    const serialized = JSON.stringify(next)
    if (serialized === lastPublished) return
    lastPublished = serialized
    win.webContents.send(DESKTOP_WINDOW_CHANNELS.changed, next)
  }
  const updateComposition = (): void => {
    if (disposed || win.isDestroyed() || platform !== 'win32') return
    const useMica =
      backdropSupported &&
      !backdropFailed &&
      !nativeTheme.prefersReducedTransparency &&
      !nativeTheme.shouldUseHighContrastColors &&
      !nativeTheme.inForcedColorsMode
    const next: DesktopCanvasComposition = useMica ? 'mica' : 'opaque'
    try {
      // 使用系统级缓存壁纸的原生 Mica 材质，避免每帧实时采样模糊桌面造成窗口化掉帧。
      if (backdropSupported) win.setBackgroundMaterial(useMica ? 'mica' : 'none')
      win.setBackgroundColor(
        useMica ? '#00000000' : nativeTheme.shouldUseDarkColors ? '#101113' : '#f3f4f6',
      )
      background.setEnabled(useMica)
      canvasComposition = next
    } catch (error) {
      backdropFailed = true
      canvasComposition = 'opaque'
      try {
        background.setEnabled(false)
      } catch (cleanupError) {
        console.warn('释放 Windows 背景失败：', cleanupError)
      }
      try {
        if (backdropSupported) win.setBackgroundMaterial('none')
      } catch (cleanupError) {
        console.warn('关闭 Windows 系统背景失败：', cleanupError)
      }
      win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#101113' : '#f3f4f6')
      console.warn('Windows 背景合成不可用，已使用实色画布：', error)
    }
    publish()
  }
  const background = installWindowBackground(win, platform, error => {
    backdropFailed = true
    console.warn('Windows 背景裁剪不可用，已使用实色画布：', error)
    updateComposition()
  })

  ipcMain.handle(DESKTOP_WINDOW_CHANNELS.read, (event, ...args: unknown[]) => {
    assertSender(event)
    if (args.length !== 0) throw new Error('窗口状态请求不能携带参数')
    return read()
  })
  ipcMain.handle(DESKTOP_WINDOW_CHANNELS.act, (event, ...args: unknown[]) => {
    assertSender(event)
    if (
      args.length !== 1 ||
      typeof args[0] !== 'string' ||
      !['minimize', 'toggle-maximize', 'close'].includes(args[0])
    ) {
      throw new Error('窗口动作无效')
    }
    const action = args[0]
    if (action === 'minimize') {
      if (!win.isMinimizable()) throw new Error('当前窗口不能最小化')
      win.minimize()
    } else if (action === 'toggle-maximize') {
      if (!win.isResizable() || !win.isMaximizable()) throw new Error('当前窗口不能最大化')
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
    } else if (action === 'close') {
      // 经过原有关闭事件，保留未保存文档保护及运行核心的退出清理。
      win.close()
    }
  })
  win.on('maximize', publish)
  win.on('unmaximize', publish)
  win.on('minimize', publish)
  win.on('restore', publish)
  win.on('resize', publish)
  win.on('move', publishIfChanged)
  win.on('enter-full-screen', publish)
  win.on('leave-full-screen', publish)
  win.webContents.on('did-finish-load', publish)
  nativeTheme.on('updated', updateComposition)
  updateComposition()

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    ipcMain.removeHandler(DESKTOP_WINDOW_CHANNELS.read)
    ipcMain.removeHandler(DESKTOP_WINDOW_CHANNELS.act)
    nativeTheme.removeListener('updated', updateComposition)
    win.removeListener('closed', dispose)
    win.removeListener('maximize', publish)
    win.removeListener('unmaximize', publish)
    win.removeListener('minimize', publish)
    win.removeListener('restore', publish)
    win.removeListener('resize', publish)
    win.removeListener('move', publishIfChanged)
    win.removeListener('enter-full-screen', publish)
    win.removeListener('leave-full-screen', publish)
    contents.removeListener('did-finish-load', publish)
    try {
      background.dispose()
    } catch (error) {
      console.warn('释放 Windows 窗口视觉失败：', error)
    }
  }
  win.once('closed', dispose)
  return { read, publish, dispose }
}
