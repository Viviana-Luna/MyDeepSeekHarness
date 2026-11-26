import { EventEmitter } from 'node:events'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  themeListeners: new Set<() => void>(),
  setBackgroundEnabled: vi.fn(),
  disposeBackground: vi.fn(),
  backgroundFailure: undefined as ((error: unknown) => void) | undefined,
  cornerRadius: 18,
  theme: {
    prefersReducedTransparency: false,
    shouldUseHighContrastColors: false,
    inForcedColorsMode: false,
    shouldUseDarkColors: true,
  },
}))
vi.mock('../src/main/window-background.ts', () => ({
  installWindowBackground: (
    _window: unknown,
    _platform: string,
    onFailure: (error: unknown) => void,
  ) => {
    mocked.backgroundFailure = onFailure
    return {
      setEnabled: mocked.setBackgroundEnabled,
      dispose: mocked.disposeBackground,
      readCornerRadius: () => mocked.cornerRadius,
      readClip: () => undefined,
    }
  },
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      mocked.handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => {
      mocked.handlers.delete(channel)
    },
  },
  nativeTheme: Object.assign(mocked.theme, {
    on: (_event: string, listener: () => void) => {
      mocked.themeListeners.add(listener)
    },
    removeListener: (_event: string, listener: () => void) => {
      mocked.themeListeners.delete(listener)
    },
  }),
}))
import { installWindowController, supportsWindowsBackdrop } from '../src/main/window-controller.ts'
import { DESKTOP_WINDOW_CHANNELS, windowClipStyle } from '../src/shared/window.ts'

function createWindow() {
  const state = { maximized: false, resizable: true, destroyed: false }
  const mainFrame = { url: 'file:///mydsh/renderer/index.html' }
  const webContents = Object.assign(new EventEmitter(), {
    mainFrame,
    send: vi.fn(),
    getURL: () => mainFrame.url,
    isDestroyed: () => state.destroyed,
  })
  const win = Object.assign(new EventEmitter(), {
    webContents,
    isDestroyed: () => state.destroyed,
    isMaximized: () => state.maximized,
    isMinimized: () => false,
    isFullScreen: () => false,
    getSize: () => [1280, 800],
    setShape: vi.fn(),
    isResizable: () => state.resizable,
    isMaximizable: () => true,
    isMinimizable: () => true,
    setBackgroundMaterial: vi.fn(),
    setBackgroundColor: vi.fn(),
    minimize: vi.fn(() => {
      win.emit('minimize')
    }),
    maximize: vi.fn(() => {
      state.maximized = true
      win.emit('maximize')
    }),
    unmaximize: vi.fn(() => {
      state.maximized = false
      win.emit('unmaximize')
    }),
    close: vi.fn(() => {
      win.emit('close')
    }),
  })
  const event = { sender: webContents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent
  const install = (osRelease = '10.0.22621') =>
    installWindowController({
      window: win as unknown as BrowserWindow,
      platform: 'win32',
      osRelease,
      isTrustedPage: url =>
        ['file:///mydsh/renderer/index.html', 'file:///mydsh/startup.html'].includes(url),
    })
  return { win, state, mainFrame, event, install }
}

beforeEach(() => {
  mocked.setBackgroundEnabled.mockReset()
  mocked.disposeBackground.mockReset()
  mocked.backgroundFailure = undefined
  mocked.cornerRadius = 18
  Object.assign(mocked.theme, {
    prefersReducedTransparency: false,
    shouldUseHighContrastColors: false,
    inForcedColorsMode: false,
    shouldUseDarkColors: true,
  })
})
afterEach(() => {
  mocked.handlers.clear()
  mocked.themeListeners.clear()
  vi.restoreAllMocks()
})

describe('自定义窗口控制', () => {
  it('分数缩放时按原生像素裁掉取整余量，最大化与实色降级不保留圆弧', () => {
    const state = {
      platform: 'win32',
      maximized: false,
      maximizable: true,
      minimizable: true,
      canvasComposition: 'acrylic' as const,
      cornerRadius: 18,
      canvasClip: { width: 542, height: 360, radius: 27 },
    }
    const viewport = { width: 362, height: 240, scale: 1.5 }
    const clip = windowClipStyle(state, viewport)
    expect(clip.radius).toBe(18)
    expect(clip.right).toBeCloseTo(2 / 3)
    expect(clip.bottom).toBe(0)
    expect(
      windowClipStyle({ ...state, canvasClip: { ...state.canvasClip, radius: 0 } }, viewport)
        .radius,
    ).toBe(0)
    expect(windowClipStyle({ ...state, canvasComposition: 'opaque' }, viewport)).toEqual({
      radius: 0,
      right: 0,
      bottom: 0,
    })
  })

  it('全屏和还原将同一圆角状态发送给绘制层，并释放新增订阅', () => {
    const { win, install } = createWindow()
    const controller = install()
    mocked.cornerRadius = 0
    win.emit('enter-full-screen')
    expect(win.webContents.send).toHaveBeenLastCalledWith(
      DESKTOP_WINDOW_CHANNELS.changed,
      expect.objectContaining({ cornerRadius: 0 }),
    )
    mocked.cornerRadius = 18
    win.emit('leave-full-screen')
    expect(controller.read().cornerRadius).toBe(18)
    controller.dispose()
    expect(win.listenerCount('enter-full-screen')).toBe(0)
    expect(win.listenerCount('leave-full-screen')).toBe(0)
  })

  it('拒绝其他窗口、子 frame、外部页面、未知动作与额外参数', () => {
    const { win, event, install } = createWindow()
    const controller = install()
    const read = mocked.handlers.get(DESKTOP_WINDOW_CHANNELS.read)!
    const act = mocked.handlers.get(DESKTOP_WINDOW_CHANNELS.act)!
    for (const candidate of [
      { ...event, sender: {} },
      { ...event, senderFrame: null },
      { ...event, senderFrame: { url: event.senderFrame!.url } },
    ])
      expect(() => act(candidate, 'close')).toThrow('受信任')
    win.webContents.mainFrame.url = 'https://example.com/'
    expect(() => read(event)).toThrow('受信任')
    win.webContents.mainFrame.url = 'file:///mydsh/startup.html'
    expect(() => read(event)).not.toThrow()
    expect(() => read(event, {})).toThrow('参数')
    for (const args of [[], ['quit'], [null], [{ action: 'close' }], ['close', {}]]) {
      expect(() => act(event, ...args)).toThrow('动作无效')
    }
    expect(win.close).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('跟随系统最大化与还原状态，启动小窗拒绝最大化，关闭经过原有保护事件', () => {
    const { win, state, event, install } = createWindow()
    const controller = install()
    const act = mocked.handlers.get(DESKTOP_WINDOW_CHANNELS.act)!
    state.resizable = false
    expect(controller.read().maximizable).toBe(false)
    expect(() => act(event, 'toggle-maximize')).toThrow('不能最大化')
    state.resizable = true
    act(event, 'toggle-maximize')
    expect(controller.read().maximized).toBe(true)
    expect(win.webContents.send).toHaveBeenLastCalledWith(
      DESKTOP_WINDOW_CHANNELS.changed,
      expect.objectContaining({ maximized: true }),
    )
    act(event, 'toggle-maximize')
    expect(controller.read().maximized).toBe(false)
    act(event, 'minimize')
    expect(win.minimize).toHaveBeenCalledOnce()
    const protect = vi.fn()
    win.on('close', protect)
    act(event, 'close')
    expect(protect).toHaveBeenCalledOnce()
    controller.dispose()
  })

  it('关闭时释放全部 IPC、主题和窗口订阅，拒绝已销毁窗口的在途动作', () => {
    const { win, state, event, install } = createWindow()
    const controller = install()
    const act = mocked.handlers.get(DESKTOP_WINDOW_CHANNELS.act)!
    const contents = win.webContents
    Object.defineProperty(win, 'webContents', {
      get: () => {
        if (state.destroyed) throw new Error('窗口已销毁，不能重新读取 WebContents')
        return contents
      },
    })
    state.destroyed = true
    win.emit('closed')
    expect(mocked.handlers.size).toBe(0)
    expect(mocked.themeListeners.size).toBe(0)
    expect(win.listenerCount('resize')).toBe(0)
    expect(contents.listenerCount('did-finish-load')).toBe(0)
    expect(() => act(event, 'close')).toThrow('受信任')
    controller.dispose()
    expect(mocked.disposeBackground).toHaveBeenCalledOnce()
  })

  it('Windows 11 新版启用 Acrylic；旧版、减少透明与高对比度使用实色，并响应系统变化', () => {
    expect(supportsWindowsBackdrop('win32', '10.0.22000')).toBe(false)
    expect(supportsWindowsBackdrop('darwin', '24.0.0')).toBe(false)
    const { win, install } = createWindow()
    const legacy = install('10.0.22000')
    expect(legacy.read().canvasComposition).toBe('opaque')
    expect(win.setBackgroundMaterial).not.toHaveBeenCalled()
    legacy.dispose()
    const controller = install()
    expect(controller.read().canvasComposition).toBe('acrylic')
    expect(mocked.setBackgroundEnabled).toHaveBeenLastCalledWith(true)
    expect(win.setBackgroundColor).toHaveBeenLastCalledWith('#00000000')
    for (const key of [
      'prefersReducedTransparency',
      'shouldUseHighContrastColors',
      'inForcedColorsMode',
    ] as const) {
      mocked.theme[key] = true
      mocked.themeListeners.forEach(listener => {
        listener()
      })
      expect(controller.read().canvasComposition).toBe('opaque')
      expect(win.setBackgroundMaterial).toHaveBeenLastCalledWith('none')
      expect(mocked.setBackgroundEnabled).toHaveBeenLastCalledWith(false)
      mocked.theme[key] = false
      mocked.themeListeners.forEach(listener => {
        listener()
      })
      expect(controller.read().canvasComposition).toBe('acrylic')
    }
    controller.dispose()
  })

  it('系统背景调用失败时保持可读实色，不在后续主题变化中反复重试', () => {
    const { win, install } = createWindow()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    win.setBackgroundMaterial.mockImplementationOnce(() => {
      throw new Error('原生合成不可用')
    })
    const controller = install()
    expect(controller.read().canvasComposition).toBe('opaque')
    expect(win.setBackgroundColor).toHaveBeenLastCalledWith('#101113')
    mocked.theme.shouldUseDarkColors = false
    mocked.themeListeners.forEach(listener => {
      listener()
    })
    expect(win.setBackgroundMaterial).toHaveBeenLastCalledWith('none')
    expect(win.setBackgroundColor).toHaveBeenLastCalledWith('#f3f4f6')
    controller.dispose()
  })

  it('原生视觉初始化或尺寸更新失败后关闭整窗背景，销毁失败仍释放 IPC 和监听', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const first = createWindow()
    mocked.setBackgroundEnabled.mockImplementationOnce(() => {
      throw new Error('视觉创建失败')
    })
    const failed = first.install()
    expect(failed.read().canvasComposition).toBe('opaque')
    expect(first.win.setBackgroundMaterial).toHaveBeenLastCalledWith('none')
    expect(mocked.setBackgroundEnabled).toHaveBeenLastCalledWith(false)
    failed.dispose()
    const second = createWindow()
    const controller = second.install()
    expect(controller.read().canvasComposition).toBe('acrylic')
    mocked.backgroundFailure?.(new Error('视觉尺寸更新失败'))
    expect(controller.read().canvasComposition).toBe('opaque')
    expect(second.win.setBackgroundMaterial).toHaveBeenLastCalledWith('none')
    mocked.disposeBackground.mockImplementationOnce(() => {
      throw new Error('视觉释放失败')
    })
    controller.dispose()
    expect(mocked.handlers.size).toBe(0)
    expect(mocked.themeListeners.size).toBe(0)
    expect(second.win.eventNames()).toEqual([])
    expect(second.win.webContents.eventNames()).toEqual([])
  })
})
