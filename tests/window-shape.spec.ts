import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { describe, it, expect, vi } from 'vitest'
import {
  installWindowShape,
  roundedWindowShape,
  WINDOW_CORNER_RADIUS,
} from '../src/main/window-shape.ts'

describe('Windows 的自定义窗口圆角', () => {
  it('命中区域容纳整个抗锯齿像素，合成失败时重新收紧并释放监听', () => {
    const setShape = vi.fn()
    let fail = false
    const win = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      isMinimized: () => false,
      isMaximized: () => false,
      isFullScreen: () => false,
      getSize: () => [1280, 800],
      setShape,
    })
    const shape = installWindowShape(win as unknown as BrowserWindow, 'win32', () => {
      if (fail) shape.setAntialiasing(false)
    })
    shape.setAntialiasing(true)
    const padded = setShape.mock.lastCall?.[0] as ReturnType<typeof roundedWindowShape>
    expect(
      padded.some(
        rectangle => rectangle.x <= 12 && rectangle.x + rectangle.width > 12 && rectangle.y === 0,
      ),
    ).toBe(true)
    fail = true
    win.emit('move')
    expect(setShape.mock.lastCall?.[0]).toEqual(roundedWindowShape(1280, 800))
    shape.dispose()
    expect(win.eventNames()).toEqual([])
  })

  it('全屏事件早于尺寸变化且状态查询仍为 false 时保持矩形，退出后恢复并释放监听', () => {
    let size = [1280, 800]
    const setShape = vi.fn()
    const win = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      isMinimized: () => false,
      isMaximized: () => false,
      isFullScreen: () => false,
      getSize: () => size,
      setShape,
    })
    const dispose = installWindowShape(win as unknown as BrowserWindow, 'win32')
    expect(setShape.mock.lastCall?.[0]).not.toEqual([])
    win.emit('enter-full-screen')
    size = [1600, 1000]
    win.emit('resize')
    expect(setShape.mock.lastCall?.[0]).toEqual([])
    win.emit('leave-full-screen')
    size = [1280, 800]
    win.emit('resize')
    expect(setShape.mock.lastCall?.[0]).not.toEqual([])
    dispose.dispose()
    expect(win.eventNames()).toEqual([])
  })

  it('四角对称裁切，边中点保留，覆盖默认、放大和小窗口', () => {
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

  it('背景与命中共用圆角，跨显示器移动后重算，最小化与销毁期间停止更新', () => {
    let minimized = false
    let destroyed = false
    let maximized = false
    const setShape = vi.fn()
    const onShape = vi.fn()
    const win = Object.assign(new EventEmitter(), {
      isDestroyed: () => destroyed,
      isMinimized: () => minimized,
      isMaximized: () => maximized,
      isFullScreen: () => false,
      getSize: () => [1280, 800],
      setShape,
    })
    const dispose = installWindowShape(win as unknown as BrowserWindow, 'win32', onShape)
    expect(onShape).toHaveBeenLastCalledWith(WINDOW_CORNER_RADIUS, 1280)
    win.emit('move')
    expect(setShape).toHaveBeenCalledTimes(2)
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
    dispose.dispose()
    expect(win.eventNames()).toEqual([])
  })
})
