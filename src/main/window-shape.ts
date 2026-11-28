/**
 * Windows 窗口圆角状态与跨显示器缩放监听：根据窗口最大化、全屏、还原与跨屏移动状态，
 * 向原生 DWM 圆角层和 8 向无边框缩放热区同步当前有效圆角半径，不再向 HWND 写入破坏 DirectComposition 的 `SetWindowRgn`。
 * 运行在 Electron 主进程；由 `dispose()` 移除全部窗口事件监听。
 */
import type { BrowserWindow, Rectangle } from 'electron'
import type { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { WINDOWS_NATIVE_CORNER_RADIUS } from '../shared/window.ts'

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

/** Windows 11 原生 DWM 硬件圆角标准半径（8 DIP）。 */
export const WINDOW_CORNER_RADIUS = WINDOWS_NATIVE_CORNER_RADIUS

/**
 * 计算离散圆角水平切片矩形（仅供几何算法单测校验，实际窗口圆角由系统 DWM 硬件合成承担）。
 */
export function roundedWindowShape(
  width: number,
  height: number,
  radius = WINDOW_CORNER_RADIUS,
  coverage = 0,
): Rectangle[] {
  const clampedRadius = Math.min(radius, Math.floor(width / 2), Math.floor(height / 2))
  const rectangles: Rectangle[] = [
    { x: 0, y: clampedRadius, width, height: height - clampedRadius * 2 },
  ]
  for (let y = 0; y < clampedRadius; y += 1) {
    const inset = Math.ceil(
      clampedRadius - Math.sqrt(clampedRadius * clampedRadius - (clampedRadius - y - 0.5) ** 2),
    )
    rectangles.push({ x: inset, y, width: width - inset * 2, height: 1 })
    rectangles.push({ x: inset, y: height - y - 1, width: width - inset * 2, height: 1 })
  }
  return rectangles
    .filter(rectangle => rectangle.width > 0 && rectangle.height > 0)
    .map(rectangle => {
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

/**
 * 监听 Windows 窗口尺寸、最大化、全屏与跨显示器移动变化，同步原生圆角半径与缩放热区宽度。
 * 不调用 `win.setShape` 设置非矩形区域，保持 `GetWindowRgn` 为空以维持满帧 DirectComposition 合成。
 */
export function installWindowShape(
  win: BrowserWindow,
  platform: string,
  onShape?: (radius: number, width: number) => void,
): { setAntialiasing: (enabled: boolean) => void; dispose: () => void } {
  if (platform !== 'win32') return { setAntialiasing: () => {}, dispose: () => {} }
  let previous = ''
  let previousDisplay = readWindowDisplayKey(win)
  let updating = false
  let isFullScreen = win.isFullScreen()

  const update = (): void => {
    if (win.isDestroyed() || updating || win.isMinimized()) return
    const [width = 0, height = 0] = win.getSize()
    const isSquare = win.isMaximized() || isFullScreen || win.isFullScreen()
    const display = readWindowDisplayKey(win)
    previousDisplay = display
    const key = `${String(width)}:${String(height)}:${display ?? ''}:${String(isSquare)}`
    if (previous === key) return
    updating = true
    try {
      previous = key
      onShape?.(isSquare ? 0 : WINDOW_CORNER_RADIUS, width)
    } finally {
      updating = false
    }
  }

  // 无厚边框的 Windows 窗口发送全屏事件，但 Electron 的 isFullScreen 仍可能返回 false。
  const enterFullScreen = (): void => {
    isFullScreen = true
    update()
  }
  const leaveFullScreen = (): void => {
    isFullScreen = false
    update()
  }
  const forceUpdate = (): void => {
    previous = ''
    update()
  }
  // 同显示器平移不重复调用 DWM；跨显示器或缩放比变化时再重算，测试无 screen 时保持重算语义。
  const move = (): void => {
    const nextDisplay = readWindowDisplayKey(win)
    if (nextDisplay !== undefined && nextDisplay === previousDisplay) return
    forceUpdate()
  }

  const events = ['resize', 'maximize', 'unmaximize']
  const forceEvents = ['restore', 'show']
  const emitter: EventEmitter = win
  for (const event of events) emitter.on(event, update)
  for (const event of forceEvents) emitter.on(event, forceUpdate)
  emitter.on('enter-full-screen', enterFullScreen)
  emitter.on('leave-full-screen', leaveFullScreen)
  emitter.on('move', move)
  update()

  return {
    setAntialiasing() {
      // 原生 DWM 圆角由系统合成器直接完成边缘抗锯齿，保留空方法以兼容既有控制器接口。
    },
    dispose() {
      for (const event of events) emitter.removeListener(event, update)
      for (const event of forceEvents) emitter.removeListener(event, forceUpdate)
      emitter.removeListener('enter-full-screen', enterFullScreen)
      emitter.removeListener('leave-full-screen', leaveFullScreen)
      emitter.removeListener('move', move)
    },
  }
}
