import { createRequire } from 'node:module'
import type { BrowserWindow } from 'electron'
import { installWindowShape } from './window-shape.ts'
import { installWindowResize } from './window-resize.ts'
import type { DesktopCanvasClip } from '../shared/window.ts'

interface NativeWindowBackground {
  update: (handle: Buffer, radius: number, logicalWidth: number) => DesktopCanvasClip | undefined
  dispose: (handle: Buffer) => void
}

/** 原生窗口区域负责命中；HostBackdrop 的独立视觉裁剪负责背景，二者共用圆角。 */
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
  const release = (): void => {
    enabled = false
    clip = undefined
    try {
      if (native && handle) native.dispose(handle)
    } finally {
      shape.setAntialiasing(false)
    }
  }
  const shape = installWindowShape(win, platform, (nextRadius, width) => {
    radius = nextRadius
    logicalWidth = width
    resize.update(radius, logicalWidth)
    if (!enabled || !native || !handle) return
    try {
      clip = native.update(handle, radius, logicalWidth)
    } catch (error) {
      try {
        release()
      } catch (cleanupError) {
        console.warn('释放 Windows 背景失败：', cleanupError)
      }
      onFailure(error)
    }
  })

  return {
    setEnabled(value: boolean): void {
      if (disposed || platform !== 'win32') return
      if (!value) {
        release()
        return
      }
      native ??= createRequire(import.meta.url)(
        './window-background.node',
      ) as NativeWindowBackground
      handle ??= win.getNativeWindowHandle()
      try {
        clip = native.update(handle, radius, logicalWidth)
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
