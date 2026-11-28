/**
 * Windows 原生窗口圆角与无边框边缘缩放装配器：协调 `window-shape.ts` 圆角状态、
 * 原生 DWM 圆角偏好设置（`window-background.node`）与父子 HWND 8 向缩放子类化。
 * 运行在 Electron 主进程；由 `dispose()` 统一释放原生圆角登记与窗口子类化钩子。
 */
import { createRequire } from 'node:module'
import type { BrowserWindow } from 'electron'
import type { DesktopCanvasClip } from '../shared/window.ts'
import { installWindowResize } from './window-resize.ts'
import { installWindowShape } from './window-shape.ts'

interface NativeWindowBackground {
  update: (handle: Buffer, radius: number, logicalWidth: number) => DesktopCanvasClip | undefined
  dispose: (handle: Buffer) => void
}

/**
 * 为目标窗口安装 Windows 原生 DWM 圆角属性同步与 8 向缩放热区；非 Windows 平台返回无副作用空控制器。
 */
export function installWindowBackground(
  win: BrowserWindow,
  platform: string,
  onFailure: (error: unknown) => void,
) {
  let native: NativeWindowBackground | undefined
  let handle: Buffer | undefined
  let enabled = false
  let disposed = false
  let radius = 0
  let logicalWidth = 0
  let clip: DesktopCanvasClip | undefined
  const resize = installWindowResize(win, platform)

  const ensureNative = (): NativeWindowBackground => {
    native ??= createRequire(import.meta.url)('./window-background.node') as NativeWindowBackground
    handle ??= win.getNativeWindowHandle()
    return native
  }

  const release = (): void => {
    enabled = false
    clip = undefined
    try {
      if (native && handle) native.dispose(handle)
    } finally {
      shape.setAntialiasing(false)
    }
  }

  const syncCornerPreference = (): void => {
    if (disposed || platform !== 'win32' || logicalWidth <= 0 || win.isDestroyed()) return
    try {
      const addon = ensureNative()
      clip = addon.update(handle!, radius, logicalWidth)
    } catch (error) {
      if (!enabled) return
      try {
        release()
      } catch (cleanupError) {
        console.warn('释放 Windows 背景失败：', cleanupError)
      }
      onFailure(error)
    }
  }

  const shape = installWindowShape(win, platform, (nextRadius, width) => {
    radius = nextRadius
    logicalWidth = width
    resize.update(radius, logicalWidth)
    syncCornerPreference()
  })

  return {
    setEnabled(value: boolean): void {
      if (disposed || platform !== 'win32') return
      if (!value) {
        release()
        return
      }
      try {
        const addon = ensureNative()
        clip = addon.update(handle!, radius, logicalWidth)
        enabled = true
        shape.setAntialiasing(true)
      } catch (error) {
        try {
          release()
        } catch (cleanupError) {
          console.warn('释放 Windows 背景失败：', cleanupError)
        }
        throw error
      }
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      try {
        release()
      } finally {
        try {
          shape.dispose()
        } finally {
          resize.dispose()
        }
      }
    },
    readCornerRadius(): number {
      return radius
    },
    readClip(): DesktopCanvasClip | undefined {
      return enabled ? clip : undefined
    },
  }
}
