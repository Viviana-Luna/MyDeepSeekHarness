/**
 * Windows 开发态桌面会话守卫单元测试：验证桌面内核对象名称分类、隔离桌面告警退出及取消清理语义。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  classifyWindowsDesktopEnvironment,
  startWindowsDevDesktopGuard,
} from '../src/main/lifecycle/desktop-session-guard.ts'

describe('Windows 开发态桌面会话守卫', () => {
  it('准确区分系统主桌面、沙箱隔离桌面与自定义桌面', () => {
    expect(classifyWindowsDesktopEnvironment('')).toBe('interactive')
    expect(classifyWindowsDesktopEnvironment('Default')).toBe('interactive')
    expect(classifyWindowsDesktopEnvironment(' default ')).toBe('interactive')
    expect(classifyWindowsDesktopEnvironment('exebox-73AREB7X3IKIMWFD')).toBe('isolated-sandbox')
    expect(classifyWindowsDesktopEnvironment('Service-0x0-3e7$')).toBe('isolated-sandbox')
    expect(classifyWindowsDesktopEnvironment('SysinternalsDesktop2')).toBe('custom-desktop')
  })

  it('在非 Windows、已打包或验收模式下不发起探测进程', () => {
    const query = vi.fn(async () => 'exebox-test')
    startWindowsDevDesktopGuard({
      platform: 'darwin',
      isPackaged: false,
      isVerifyMode: false,
      onIsolatedDesktop: vi.fn(),
      queryDesktopName: query,
    })
    startWindowsDevDesktopGuard({
      platform: 'win32',
      isPackaged: true,
      isVerifyMode: false,
      onIsolatedDesktop: vi.fn(),
      queryDesktopName: query,
    })
    startWindowsDevDesktopGuard({
      platform: 'win32',
      isPackaged: false,
      isVerifyMode: true,
      onIsolatedDesktop: vi.fn(),
      queryDesktopName: query,
    })
    expect(query).not.toHaveBeenCalled()
  })

  it('检测到 exebox 隔离桌面时输出中文错误并触发退出回调', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onIsolated = vi.fn()
    try {
      startWindowsDevDesktopGuard({
        platform: 'win32',
        isPackaged: false,
        isVerifyMode: false,
        onIsolatedDesktop: onIsolated,
        queryDesktopName: async () => 'exebox-ABCD1234',
      })
      await vi.waitFor(() => {
        expect(onIsolated).toHaveBeenCalledWith('exebox-ABCD1234')
      })
      expect(errorSpy).toHaveBeenCalledOnce()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('dispose 后取消在途探测且不再触发隔离桌面回调', async () => {
    const onIsolated = vi.fn()
    let resolveProbe: ((value: string) => void) | undefined
    let capturedSignal: AbortSignal | undefined
    const guard = startWindowsDevDesktopGuard({
      platform: 'win32',
      isPackaged: false,
      isVerifyMode: false,
      onIsolatedDesktop: onIsolated,
      queryDesktopName: signal => {
        capturedSignal = signal
        return new Promise<string>(resolve => {
          resolveProbe = resolve
        })
      },
    })
    guard.dispose()
    expect(capturedSignal?.aborted).toBe(true)
    resolveProbe?.('exebox-late')
    await Promise.resolve()
    expect(onIsolated).not.toHaveBeenCalled()
  })
})
