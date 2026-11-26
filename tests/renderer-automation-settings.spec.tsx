// @vitest-environment jsdom
/** 验证设置中心「浏览器与桌面操控」页的页头文案、回退警告、端口草稿缓冲、域名规则增删校验、IPC 错误剥离与系统权限跳转反馈。 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDefaultAutomationSettings,
  type AutomationRuntimeStatus,
  type AutomationSettings,
  type AutomationSettingsPatch,
} from '../src/shared/automation.ts'
import { AutomationSettings as AutomationSettingsPage } from '../src/renderer/src/features/settings/AutomationSettings.tsx'

function makeStatus(overrides?: Partial<AutomationRuntimeStatus>): AutomationRuntimeStatus {
  const settings = createDefaultAutomationSettings()
  return {
    settings,
    takeover: {
      active: false,
      kind: null,
      sessionId: null,
      targetLabel: null,
      stepCount: 0,
      killSwitchShortcut: 'Command+Shift+Escape',
      lastStoppedReason: null,
    },
    permissions: {
      platform: 'darwin',
      supported: true,
      nativeLoaded: true,
      accessibility: false,
      screenRecording: true,
    },
    externalConnected: false,
    externalTargetLabel: null,
    ...overrides,
  }
}

function installBridge(initialStatus: AutomationRuntimeStatus) {
  let currentSettings: AutomationSettings = structuredClone(initialStatus.settings)
  const status = vi.fn(async () => ({ ...initialStatus, settings: currentSettings }))
  const updateSettings = vi.fn(async (patch: AutomationSettingsPatch) => {
    currentSettings = {
      ...currentSettings,
      embeddedBrowser: { ...currentSettings.embeddedBrowser, ...patch.embeddedBrowser },
      externalBrowser: { ...currentSettings.externalBrowser, ...patch.externalBrowser },
      computerUse: { ...currentSettings.computerUse, ...patch.computerUse },
    }
    return currentSettings
  })
  const stopTakeover = vi.fn(async () => {})
  const openPermissionSettings = vi.fn(async () => false)
  const detectBrowsers = vi.fn(async () => [
    {
      id: 'chrome',
      name: 'Google Chrome',
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    },
  ])
  const testExternalBrowser = vi.fn(async () => ({
    ok: true,
    browser: 'Chrome/130',
    targetCount: 2,
    mode: 'managed' as const,
  }))
  Object.defineProperty(window, 'dshDesktop', {
    configurable: true,
    value: {
      automation: {
        status,
        readSettings: vi.fn(async () => currentSettings),
        updateSettings,
        stopTakeover,
        checkPermissions: vi.fn(async () => initialStatus.permissions),
        openPermissionSettings,
        detectBrowsers,
        testExternalBrowser,
        onStateChanged: vi.fn(() => () => {}),
        onSettingsChanged: vi.fn(() => () => {}),
      },
    },
  })
  return {
    status,
    updateSettings,
    stopTakeover,
    openPermissionSettings,
    detectBrowsers,
    testExternalBrowser,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
  }
})

afterEach(() => {
  cleanup()
})

describe('浏览器与桌面操控设置页', () => {
  it('渲染标准页头、回退警告，并支持端口草稿缓冲与保存', async () => {
    const initial = makeStatus({
      externalConnected: true,
      externalTargetLabel: 'Chrome/130',
    })
    initial.settings.warning = '检测到旧配置已安全回退'
    initial.settings.embeddedBrowser.enabled = true
    initial.settings.externalBrowser.enabled = true
    initial.settings.externalBrowser.mode = 'attached'
    initial.settings.externalBrowser.attachPort = 9222
    const bridge = installBridge(initial)

    render(<AutomationSettingsPage />)
    await screen.findByText('部分自动化设置已安全回退')
    expect(screen.getByRole('heading', { name: '浏览器与桌面操控' })).toBeTruthy()
    expect(
      screen.getByText('管理 Agent 使用内置浏览器、外置浏览器与系统桌面操控的授权和安全边界。'),
    ).toBeTruthy()
    expect(screen.getByText('已连接 · Chrome/130')).toBeTruthy()

    // 端口输入期间不频繁触发 updateSettings，失焦时一次性提交
    const savePortButton = screen.getByRole('button', { name: '保存端口' })
    expect((savePortButton as HTMLButtonElement).disabled).toBe(true)

    const portInput = screen.getByLabelText('外置浏览器调试端口')
    fireEvent.change(portInput, { target: { value: '9333' } })
    expect(bridge.updateSettings).not.toHaveBeenCalled()
    expect((savePortButton as HTMLButtonElement).disabled).toBe(false)

    fireEvent.blur(portInput)
    await waitFor(() =>
      expect(bridge.updateSettings).toHaveBeenCalledWith({
        externalBrowser: { attachPort: 9333 },
      }),
    )
    await waitFor(() => expect((portInput as HTMLInputElement).disabled).toBe(false))

    // 输入无效端口后按钮禁用，失焦自动恢复上次已保存值且不触发保存
    bridge.updateSettings.mockClear()
    fireEvent.change(portInput, { target: { value: '80' } })
    expect((savePortButton as HTMLButtonElement).disabled).toBe(true)
    await screen.findByText('端口号需为 1024 至 65535 之间的整数')
    fireEvent.blur(portInput)
    expect(bridge.updateSettings).not.toHaveBeenCalled()
  })

  it('支持信任白名单与禁止黑名单的即时校验、批量去重添加与移除', async () => {
    const initial = makeStatus()
    initial.settings.embeddedBrowser.enabled = true
    initial.settings.embeddedBrowser.allowedOrigins = ['https://docs.example.com']
    const bridge = installBridge(initial)

    render(<AutomationSettingsPage />)
    await screen.findByText('https://docs.example.com')

    // 非法格式给出简洁内联中文提示，不触发保存
    const allowInput = screen.getByLabelText('内置浏览器信任网站地址')
    fireEvent.change(allowInput, { target: { value: 'not-a-valid-origin' } })
    fireEvent.click(screen.getByRole('button', { name: '添加到内置浏览器信任白名单' }))
    await screen.findByText(/请包含 http:\/\/ 或 https:\/\/ 协议头/u)
    expect(bridge.updateSettings).not.toHaveBeenCalled()

    // 支持多行粘贴（含路径与重复项）并自动规范化去重后保存
    fireEvent.change(allowInput, { target: { value: '' } })
    fireEvent.paste(allowInput, {
      clipboardData: {
        getData: () =>
          'HTTPS://API.Example.com/v1\nhttps://docs.example.com\nhttps://app.example.com/home',
      },
    })
    fireEvent.keyDown(allowInput, { key: 'Enter', code: 'Enter' })
    await waitFor(() =>
      expect(bridge.updateSettings).toHaveBeenCalledWith({
        embeddedBrowser: {
          allowedOrigins: [
            'https://docs.example.com',
            'https://api.example.com',
            'https://app.example.com',
          ],
        },
      }),
    )

    // 也支持逗号分隔批量输入并自动去重
    bridge.updateSettings.mockClear()
    fireEvent.change(allowInput, {
      target: { value: 'https://api.example.com, https://portal.example.com/dashboard' },
    })
    fireEvent.click(screen.getByRole('button', { name: '添加到内置浏览器信任白名单' }))
    await waitFor(() =>
      expect(bridge.updateSettings).toHaveBeenCalledWith({
        embeddedBrowser: {
          allowedOrigins: [
            'https://docs.example.com',
            'https://api.example.com',
            'https://app.example.com',
            'https://portal.example.com',
          ],
        },
      }),
    )

    // 点击芯片关闭按钮立即移除并保存
    fireEvent.click(screen.getByRole('button', { name: '移除 https://docs.example.com' }))
    await waitFor(() =>
      expect(bridge.updateSettings).toHaveBeenCalledWith({
        embeddedBrowser: {
          allowedOrigins: [
            'https://api.example.com',
            'https://app.example.com',
            'https://portal.example.com',
          ],
        },
      }),
    )

    // 禁止访问黑名单独立添加与保存
    const blockInput = screen.getByLabelText('禁止访问网站地址')
    fireEvent.change(blockInput, { target: { value: 'https://bank.example.com/login' } })
    fireEvent.click(screen.getByRole('button', { name: '添加到禁止访问黑名单' }))
    await waitFor(() =>
      expect(bridge.updateSettings).toHaveBeenCalledWith({
        embeddedBrowser: {
          blockedOrigins: ['https://bank.example.com'],
        },
      }),
    )
    await screen.findByText('https://bank.example.com')
  })

  it('托管模式下支持自定义路径变更校验与连通性检测', async () => {
    const initial = makeStatus()
    initial.settings.externalBrowser.enabled = true
    initial.settings.externalBrowser.mode = 'managed'
    const bridge = installBridge(initial)

    render(<AutomationSettingsPage />)
    const applyPathButton = await screen.findByRole('button', { name: '应用路径' })
    expect((applyPathButton as HTMLButtonElement).disabled).toBe(true)

    const pathInput = screen.getByLabelText('自定义浏览器可执行路径')
    fireEvent.change(pathInput, { target: { value: '/opt/chrome/chrome' } })
    expect((applyPathButton as HTMLButtonElement).disabled).toBe(false)
    fireEvent.keyDown(pathInput, { key: 'Enter', code: 'Enter' })
    await waitFor(() =>
      expect(bridge.updateSettings).toHaveBeenCalledWith({
        externalBrowser: { executablePath: '/opt/chrome/chrome' },
      }),
    )

    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    await screen.findByText(/已连接外置浏览器：Chrome\/130/u)
    expect(bridge.testExternalBrowser).toHaveBeenCalledTimes(1)
  })

  it('展示急停横幅、剥离 IPC 错误前缀，并在系统权限设置打开失败时给出中文提示', async () => {
    const initial = makeStatus({
      takeover: {
        active: true,
        kind: 'computer-use',
        sessionId: 's-1',
        targetLabel: 'Notes',
        stepCount: 2,
        killSwitchShortcut: 'Control+Shift+F12',
        lastStoppedReason: null,
      },
    })
    const bridge = installBridge(initial)
    bridge.stopTakeover.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'dsh-desktop:automation:stop-takeover': Error: 急停超时",
      ),
    )

    render(<AutomationSettingsPage />)
    await screen.findByText('Agent 正在接管：Notes')
    expect(screen.getByText('已执行 2 步')).toBeTruthy()
    const shortcutEl = screen.getByText('Ctrl+Shift+F12')
    expect(shortcutEl.tagName.toLowerCase()).toBe('kbd')

    fireEvent.click(screen.getByRole('button', { name: '立即停止' }))
    await screen.findByText('急停超时')
    expect(screen.queryByText(/Error invoking remote method/u)).toBeNull()

    // 权限清单渲染三项并支持打开 macOS 辅助功能设置
    expect(screen.getByText('原生驱动')).toBeTruthy()
    expect(screen.getByText('屏幕录制')).toBeTruthy()
    expect(screen.getByText('辅助功能')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '打开辅助功能系统设置' }))
    await screen.findByText(/未能自动打开系统设置/u)
    expect(bridge.openPermissionSettings).toHaveBeenCalledWith('accessibility')
  })
})
