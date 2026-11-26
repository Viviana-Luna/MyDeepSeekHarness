import { createRequire } from 'node:module'
import type { BrowserWindow } from 'electron'

interface NativeWindowResize {
  updateResize: (handle: Buffer, radius: number, logicalWidth: number, enabled: boolean) => void
  disposeResize: (handle: Buffer) => void
}

/** 缩放属于窗口生命周期，关闭毛玻璃或启用高对比度时仍保留原生命中与光标。 */
export function installWindowResize(win: BrowserWindow, platform: string) {
  let native: NativeWindowResize | undefined
  let handle: Buffer | undefined
  let failed = false
  let disposed = false
  const release = (): void => {
    if (native && handle) native.disposeResize(handle)
  }
  return {
    update(radius: number, logicalWidth: number): void {
      if (platform !== 'win32' || disposed || failed || win.isDestroyed()) return
      try {
        native ??= createRequire(import.meta.url)('./window-background.node') as NativeWindowResize
        handle ??= win.getNativeWindowHandle()
        native.updateResize(handle, radius, logicalWidth, win.isResizable() && radius > 0)
      } catch (error) {
        failed = true
        try {
          release()
        } catch (cleanupError) {
          console.warn('释放 Windows 缩放命中检测失败：', cleanupError)
        }
        console.warn('Windows 自定义缩放命中检测不可用：', error)
      }
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      release()
    },
  }
}
