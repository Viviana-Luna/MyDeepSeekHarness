import { describe, expect, it, vi } from 'vitest'
import { focusPrimaryWindow, type PrimaryWindow } from '../src/main/lifecycle/app-lifecycle.ts'

function fakeWindow(overrides: Partial<PrimaryWindow> = {}): PrimaryWindow {
  return {
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => true,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    ...overrides,
  }
}

describe('桌面应用单实例唤醒', () => {
  it('第二次启动会恢复、显示并聚焦已有窗口', () => {
    const window = fakeWindow({
      isMinimized: () => true,
      isVisible: () => false,
    })
    expect(focusPrimaryWindow(window)).toBe(true)
    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
  })

  it('已可见窗口只需要聚焦', () => {
    const window = fakeWindow()
    expect(focusPrimaryWindow(window)).toBe(true)
    expect(window.restore).not.toHaveBeenCalled()
    expect(window.show).not.toHaveBeenCalled()
    expect(window.focus).toHaveBeenCalledOnce()
  })

  it('窗口不存在或已销毁时安全忽略唤醒请求', () => {
    expect(focusPrimaryWindow(undefined)).toBe(false)
    expect(focusPrimaryWindow(fakeWindow({ isDestroyed: () => true }))).toBe(false)
  })
})
