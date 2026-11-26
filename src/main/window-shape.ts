import type { BrowserWindow, Rectangle } from 'electron'
import type { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { DESKTOP_WINDOW_CORNER_RADIUS } from '../shared/window.ts'

const require = createRequire(import.meta.url)

function readWindowDisplayKey(win: BrowserWindow): string | undefined {
  if (typeof win.getBounds !== 'function') return undefined
  try {
    const electronMod = require('electron') as {
      screen?: { getDisplayMatching?: (rect: Rectangle) => { id: number; scaleFactor: number } }
    }
    if (typeof electronMod?.screen?.getDisplayMatching !== 'function') return undefined
    const display = electronMod.screen.getDisplayMatching(win.getBounds())
    return `${String(display.id)}:${String(display.scaleFactor)}`
  } catch {
    return undefined
  }
}

/** Windows 窗口外角；工作台按外缘留白计算内侧浮岛圆角。 */
export const WINDOW_CORNER_RADIUS = DESKTOP_WINDOW_CORNER_RADIUS

/** 水平切片交给 Electron 合成为原生窗口区域，窗口外的像素与点击一起裁掉。 */
export function roundedWindowShape(
  width: number,
  height: number,
  radius = WINDOW_CORNER_RADIUS,
  coverage = 0,
): Rectangle[] {
  const r = Math.min(radius, Math.floor(width / 2), Math.floor(height / 2))
  const rectangles: Rectangle[] = [{ x: 0, y: r, width, height: height - r * 2 }]
  for (let y = 0; y < r; y += 1) {
    const inset = Math.ceil(r - Math.sqrt(r * r - (r - y - 0.5) ** 2))
    rectangles.push({ x: inset, y, width: width - inset * 2, height: 1 })
    rectangles.push({ x: inset, y: height - y - 1, width: width - inset * 2, height: 1 })
  }
  return rectangles
    .filter(rectangle => rectangle.width > 0 && rectangle.height > 0)
    .map(rectangle => {
      // 命中区域须容纳圆弧的部分覆盖像素；真正的可见边缘由前景与背景合成器抗锯齿。
      const x = Math.max(0, rectangle.x - coverage)
      const y = Math.max(0, rectangle.y - coverage)
      return {
        x,
        y,
        width: Math.min(width, rectangle.x + rectangle.width + coverage) - x,
        height: Math.min(height, rectangle.y + rectangle.height + coverage) - y,
      }
    })
}

export function installWindowShape(
  win: BrowserWindow,
  platform: string,
  onShape?: (radius: number, width: number) => void,
): { setAntialiasing: (enabled: boolean) => void; dispose: () => void } {
  if (platform !== 'win32') return { setAntialiasing: () => {}, dispose: () => {} }
  let previous = ''
  let previousDisplay = readWindowDisplayKey(win)
  let updating = false
  let fullScreen = win.isFullScreen()
  let antialiasing = false
  let pendingAntialiasing = false
  const update = (): void => {
    if (win.isDestroyed() || updating || win.isMinimized()) return
    const [width = 0, height = 0] = win.getSize()
    const square = win.isMaximized() || fullScreen || win.isFullScreen()
    const display = readWindowDisplayKey(win)
    previousDisplay = display
    const key = `${width}:${height}:${display ?? ''}:${square}:${antialiasing}`
    updating = true
    try {
      if (previous !== key) {
        win.setShape(
          square
            ? []
            : roundedWindowShape(width, height, WINDOW_CORNER_RADIUS, antialiasing ? 1 : 0),
        )
        previous = key
      }
      onShape?.(square ? 0 : WINDOW_CORNER_RADIUS, width)
    } finally {
      updating = false
      if (pendingAntialiasing) {
        pendingAntialiasing = false
        update()
      }
    }
  }
  // 无厚边框的 Windows 窗口发送全屏事件，但 Electron 的 isFullScreen 仍可能返回 false。
  const enterFullScreen = (): void => {
    fullScreen = true
    update()
  }
  const leaveFullScreen = (): void => {
    fullScreen = false
    update()
  }
  // 同显示器平移不重算 SetWindowRgn/DWM；跨显示器或缩放比变化时再重算，测试无 screen 时保持重算语义。
  const move = (): void => {
    const nextDisplay = readWindowDisplayKey(win)
    if (nextDisplay !== undefined && nextDisplay === previousDisplay) return
    previous = ''
    update()
  }
  const events = ['resize', 'maximize', 'unmaximize', 'restore']
  const emitter: EventEmitter = win
  for (const event of events) emitter.on(event, update)
  emitter.on('enter-full-screen', enterFullScreen)
  emitter.on('leave-full-screen', leaveFullScreen)
  emitter.on('move', move)
  update()
  return {
    setAntialiasing(enabled) {
      if (antialiasing === enabled) return
      antialiasing = enabled
      if (updating) {
        pendingAntialiasing = true
        return
      }
      update()
    },
    dispose() {
      for (const event of events) emitter.removeListener(event, update)
      emitter.removeListener('enter-full-screen', enterFullScreen)
      emitter.removeListener('leave-full-screen', leaveFullScreen)
      emitter.removeListener('move', move)
    },
  }
}
