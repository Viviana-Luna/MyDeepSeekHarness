/**
 * Windows 原生窗口圆角状态同步与几何算法测试。
 */
import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import {
  installWindowShape,
  roundedWindowShape,
  WINDOW_CORNER_RADIUS,
} from '../src/main/window-shape.ts'
import { WINDOWS_NATIVE_CORNER_RADIUS } from '../src/shared/window.ts'

describe('Windows 原生 DWM 圆角与状态同步', () => {
  it('采用 Windows 11 原生 8 DIP 圆角且不调用破坏硬件翻转的 setShape', () => {
    expect(WINDOW_CORNER_RADIUS).toBe(WINDOWS_NATIVE_CORNER_RADIUS)
    expect(WINDOW_CORNER_RADIUS).toBe(8)
    const setShape = vi.fn()
    const onShape = vi.fn()
    const win = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      isMinimized: () => false,
      isMaximized: () => false,
      isFullScreen: () => false,
      getSize: () => [1280, 800],
      setShape,
    })
    const shape = installWindowShape(win as unknown as BrowserWindow, 'win32', onShape)
    shape.setAntialiasing(true)
    expect(setShape).not.toHaveBeenCalled()
    expect(onShape).toHaveBeenLastCalledWith(WINDOW_CORNER_RADIUS, 1280)
    shape.dispose()
    expect(win.eventNames()).toEqual([])
  })

  it('全屏事件早于尺寸变化且状态查询仍为 false 时切换直角，退出后恢复圆角并释放监听', () => {
    let size = [1280, 800]
    const setShape = vi.fn()
    const onShape = vi.fn()
    const win = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      isMinimized: () => false,
      isMaximized: () => false,
      isFullScreen: () => false,
      getSize: () => size,
      setShape,
    })
    const shape = installWindowShape(win as unknown as BrowserWindow, 'win32', onShape)
    expect(onShape).toHaveBeenLastCalledWith(WINDOW_CORNER_RADIUS, 1280)
    win.emit('enter-full-screen')
    size = [1600, 1000]
    win.emit('resize')
    expect(onShape).toHaveBeenLastCalledWith(0, 1600)
    win.emit('leave-full-screen')
    size = [1280, 800]
    win.emit('resize')
    expect(onShape).toHaveBeenLastCalledWith(WINDOW_CORNER_RADIUS, 1280)
    expect(setShape).not.toHaveBeenCalled()
    shape.dispose()
    expect(win.eventNames()).toEqual([])
  })

  it('几何圆角切片函数保持四角对称裁切与边中点覆盖', () => {
    for (const [width, height] of [
      [1280, 800],
      [1600, 1000],
      [760, 480],
    ]) {
      const shape = roundedWindowShape(width!, height!)
      const includes = (x: number, y: number) =>
        shape.some(
          rectangle =>
            x >= rectangle.x &&
            x < rectangle.x + rectangle.width &&
            y >= rectangle.y &&
            y < rectangle.y + rectangle.height,
        )
      expect(includes(0, 0)).toBe(false)
      expect(includes(width! - 1, 0)).toBe(false)
      expect(includes(0, height! - 1)).toBe(false)
      expect(includes(width! - 1, height! - 1)).toBe(false)
      expect(includes(0, WINDOW_CORNER_RADIUS)).toBe(true)
      expect(includes(WINDOW_CORNER_RADIUS, 0)).toBe(true)
      expect(includes(width! / 2, height! / 2)).toBe(true)
    }
  })

  it('最大化置零圆角，跨显示器移动后重算，最小化与销毁期间停止更新', () => {
    let minimized = false
    let destroyed = false
    let maximized = false
    const onShape = vi.fn()
    const win = Object.assign(new EventEmitter(), {
      isDestroyed: () => destroyed,
      isMinimized: () => minimized,
      isMaximized: () => maximized,
      isFullScreen: () => false,
      getSize: () => [1280, 800],
      setShape: vi.fn(),
    })
    const shape = installWindowShape(win as unknown as BrowserWindow, 'win32', onShape)
    expect(onShape).toHaveBeenLastCalledWith(WINDOW_CORNER_RADIUS, 1280)
    win.emit('move')
    expect(onShape).toHaveBeenCalledTimes(2)
    maximized = true
    win.emit('maximize')
    expect(onShape).toHaveBeenLastCalledWith(0, 1280)
    minimized = true
    win.emit('resize')
    expect(onShape).toHaveBeenCalledTimes(3)
    minimized = false
    destroyed = true
    win.emit('restore')
    expect(onShape).toHaveBeenCalledTimes(3)
    shape.dispose()
    expect(win.eventNames()).toEqual([])
  })
})
