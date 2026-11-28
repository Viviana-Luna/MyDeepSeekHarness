// @vitest-environment jsdom
/**
 * 测试内置浏览器面板地址栏交互与样式契约：覆盖前往、外部打开、提示语义及横向浮动胶囊布局。
 * 运行在 Vitest jsdom 环境；不依赖真实 Electron WebContentsView，清理测试创建的样式与桌面桥桩。
 */
import { readFileSync } from 'node:fs'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EMPTY_BROWSER_STATE,
  type BrowserRequest,
  type BrowserState,
} from '../src/shared/browser.ts'
import { BrowserPanel } from '../src/renderer/src/features/browser/BrowserPanel.tsx'

const mocks = vi.hoisted(() => ({
  request: vi.fn<(input: BrowserRequest & { tabId?: string }) => Promise<BrowserState>>(),
  listener: null as null | ((state: BrowserState) => void),
  setView: vi.fn(),
}))

vi.mock('../src/renderer/src/hooks/useWorkspace.ts', () => ({
  useWorkspaceStore: () => ({
    setView: mocks.setView,
  }),
}))

vi.mock('../src/renderer/src/features/workspace-tabs/WorkspaceTabsProvider.tsx', () => ({
  useWorkspaceTabs: () => null,
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listener = null
  mocks.request.mockResolvedValue({ ...EMPTY_BROWSER_STATE, tabId: 'default' })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  Object.defineProperty(window, 'dshDesktop', {
    configurable: true,
    value: {
      browser: {
        request: mocks.request,
        onChanged: vi.fn((listener: (state: BrowserState) => void) => {
          mocks.listener = listener
          return () => {
            if (mocks.listener === listener) mocks.listener = null
          }
        }),
      },
    },
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('内置浏览器地址栏与浮动胶囊适配', () => {
  it('地址栏按钮提供清晰文案与原生悬停提示，并正确触发前往与系统浏览器打开动作', async () => {
    render(<BrowserPanel placement="main" visibility="foreground" selectionRevision={0} />)

    const back = screen.getByRole('button', { name: '网页后退' }) as HTMLButtonElement
    const forward = screen.getByRole('button', { name: '网页前进' }) as HTMLButtonElement
    const reload = screen.getByRole('button', { name: '重新加载网页' }) as HTMLButtonElement
    const addressInput = screen.getByRole('textbox', { name: '网页地址' }) as HTMLInputElement
    const goButton = screen.getByRole('button', { name: '打开网页' }) as HTMLButtonElement
    const externalButton = screen.getByRole('button', {
      name: '在系统浏览器中打开',
    }) as HTMLButtonElement

    expect(back.title).toBe('后退')
    expect(forward.title).toBe('前进')
    expect(reload.title).toBe('重新加载')
    expect(goButton.title).toBe('前往输入的网址（Enter）')
    expect(goButton.textContent).toContain('前往')
    expect(goButton.closest('.browser-address-field')).not.toBeNull()
    expect(externalButton.title).toBe('在系统浏览器中打开当前网页')
    expect(externalButton.textContent).toContain('外部打开')
    expect(goButton.disabled).toBe(true)
    expect(externalButton.disabled).toBe(true)

    const loadedState: BrowserState = {
      ...EMPTY_BROWSER_STATE,
      tabId: 'default',
      url: 'http://localhost:3000/',
      title: '本地开发页',
      canGoBack: true,
    }
    mocks.request.mockResolvedValueOnce(loadedState)

    fireEvent.change(addressInput, { target: { value: 'http://localhost:3000/' } })
    expect(goButton.disabled).toBe(false)
    fireEvent.click(goButton)

    await waitFor(() => {
      expect(mocks.request).toHaveBeenCalledWith({
        action: 'navigate',
        url: 'http://localhost:3000/',
        tabId: 'default',
      })
    })
    await waitFor(() => {
      expect(externalButton.disabled).toBe(false)
    })

    mocks.request.mockResolvedValueOnce(loadedState)
    fireEvent.click(externalButton)
    await waitFor(() => {
      expect(mocks.request).toHaveBeenCalledWith({
        action: 'external',
        tabId: 'default',
      })
    })

    act(() => {
      mocks.listener?.({ ...loadedState, loading: true })
    })
    expect(screen.getByRole('button', { name: '停止加载网页' }).getAttribute('title')).toBe(
      '停止加载',
    )
  })

  it('终端与浏览器在浮动胶囊模式下仅由顶部工具栏预留横向胶囊轨道，不裁切内容视口宽度', () => {
    const browserCss = readFileSync('src/renderer/src/features/browser/browser.css', 'utf8')
    const terminalCss = readFileSync(
      'src/renderer/src/features/terminal/TerminalView.module.css',
      'utf8',
    )
    const tabsCss = readFileSync(
      'src/renderer/src/pages/workspace/components/topbar/session-tabs.css',
      'utf8',
    )

    expect(browserCss).not.toMatch(/\.browser-panel\s*\{\s*padding-right:\s*56px/u)
    expect(browserCss).toMatch(/\.browser-toolbar\s*\{\s*padding-right:\s*84px/u)
    expect(terminalCss).not.toMatch(/\.terminalHost\s*\{\s*padding-right:\s*56px/u)
    expect(terminalCss).toMatch(/\.toolbar\s*\{\s*padding-right:\s*84px/u)
    expect(tabsCss).toMatch(/\.floating-tab-actions\s*\{[^}]*height:\s*34px/u)
  })
})
