import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

const mocked = vi.hoisted(() => ({ load: vi.fn(), updateResize: vi.fn(), disposeResize: vi.fn() }))
vi.mock('node:module', () => ({ createRequire: () => mocked.load }))
import { installWindowResize } from '../src/main/window-resize.ts'

function windowFixture() {
  const state = { resizable: false, destroyed: false }
  const handle = Buffer.alloc(8)
  const win = {
    isDestroyed: () => state.destroyed,
    isResizable: () => state.resizable,
    getNativeWindowHandle: vi.fn(() => handle),
  } as unknown as BrowserWindow
  return { win, handle, state }
}

beforeEach(() => {
  vi.resetAllMocks()
  mocked.load.mockReturnValue({
    updateResize: mocked.updateResize,
    disposeResize: mocked.disposeResize,
  })
})

describe('原生窗口缩放生命周期', () => {
  it('启动小窗、最大化和全屏不启用缩放，还原与跨缩放移动同步尺寸', () => {
    const { win, handle, state } = windowFixture()
    const resize = installWindowResize(win, 'win32')
    resize.update(18, 680)
    expect(mocked.updateResize).toHaveBeenLastCalledWith(handle, 18, 680, false)
    state.resizable = true
    resize.update(18, 1280)
    expect(mocked.updateResize).toHaveBeenLastCalledWith(handle, 18, 1280, true)
    resize.update(0, 1920)
    expect(mocked.updateResize).toHaveBeenLastCalledWith(handle, 0, 1920, false)
    resize.update(18, 900)
    expect(mocked.updateResize).toHaveBeenLastCalledWith(handle, 18, 900, true)
    resize.dispose()
    resize.dispose()
    resize.update(18, 1000)
    expect(mocked.disposeResize).toHaveBeenCalledExactlyOnceWith(handle)
    expect(mocked.updateResize).toHaveBeenCalledTimes(4)
  })

  it('安装失败时释放部分资源，后续更新不重复尝试或阻塞关闭', () => {
    const { win, handle } = windowFixture()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocked.updateResize.mockImplementationOnce(() => {
      throw new Error('原生命中检测安装失败')
    })
    const resize = installWindowResize(win, 'win32')
    resize.update(18, 680)
    resize.update(18, 1280)
    expect(mocked.disposeResize).toHaveBeenCalledWith(handle)
    expect(mocked.updateResize).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith('Windows 自定义缩放命中检测不可用：', expect.any(Error))
    resize.dispose()
    warn.mockRestore()
  })

  it('模块加载失败、已销毁窗口和其他平台不读取窗口句柄', () => {
    const { win, state } = windowFixture()
    installWindowResize(win, 'darwin').update(18, 1280)
    state.destroyed = true
    installWindowResize(win, 'win32').update(18, 1280)
    expect(mocked.load).not.toHaveBeenCalled()
    state.destroyed = false
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocked.load.mockImplementationOnce(() => {
      throw new Error('模块不可用')
    })
    const resize = installWindowResize(win, 'win32')
    expect(() => resize.update(18, 1280)).not.toThrow()
    expect(() => resize.dispose()).not.toThrow()
    expect(win.getNativeWindowHandle).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('安装与首次清理同时失败时保留关闭清理机会', () => {
    const { win } = windowFixture()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocked.updateResize.mockImplementationOnce(() => {
      throw new Error('安装失败')
    })
    mocked.disposeResize.mockImplementationOnce(() => {
      throw new Error('首次清理失败')
    })
    const resize = installWindowResize(win, 'win32')
    expect(() => resize.update(18, 1280)).not.toThrow()
    expect(warn).toHaveBeenCalledWith('释放 Windows 缩放命中检测失败：', expect.any(Error))
    expect(() => resize.dispose()).not.toThrow()
    expect(mocked.disposeResize).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})
