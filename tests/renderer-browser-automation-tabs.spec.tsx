// @vitest-environment jsdom
/** 测试主进程内置浏览器自动化事件与前端工作台标签栏、分屏视图的实时同步与清理。 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_BROWSER_STATE, type BrowserState } from '../src/shared/browser.ts'
import { BrowserAutomationTabSync } from '../src/renderer/src/features/browser/BrowserAutomationTabSync.tsx'
import {
  WorkspaceTabsProvider,
  useWorkspaceTabs,
} from '../src/renderer/src/features/workspace-tabs/WorkspaceTabsProvider.tsx'
import { Topbar } from '../src/renderer/src/pages/workspace/components/topbar/index.tsx'

const mocks = vi.hoisted(() => ({
  view: 'conversation',
  selectedProjectId: 'project-a',
  activeSessionId: 'chat-a',
  setView: vi.fn((next: string) => {
    mocks.view = next
  }),
  listener: null as null | ((state: BrowserState) => void),
}))

vi.mock('../src/renderer/src/hooks/useWorkspace.ts', () => ({
  useWorkspaceSnapshot: () => ({
    openedSessionIds: ['chat-a', 'chat-b'],
    selectedSessionId: mocks.activeSessionId,
    activeView: mocks.view,
    navigationCollapsed: false,
    sessions: [
      { sessionId: 'chat-a', title: '项目 A 聊天', cwd: '/project-a', running: true },
      { sessionId: 'chat-b', title: '项目 B 聊天', cwd: '/project-b', running: false },
    ],
    projects: [
      {
        id: 'project-a',
        name: '项目 A',
        cwd: '/project-a',
        source: 'legacy',
        sessionIds: ['chat-a'],
      },
      {
        id: 'project-b',
        name: '项目 B',
        cwd: '/project-b',
        source: 'legacy',
        sessionIds: ['chat-b'],
      },
    ],
    unreadSessionIds: [],
    selectedProjectId: mocks.selectedProjectId,
    hostStatus: { kind: 'ready' },
  }),
  useWorkspaceStore: () => ({
    selectedProject: () => ({ id: mocks.selectedProjectId }),
    setView: mocks.setView,
    moveSessionTab: vi.fn(),
  }),
}))

vi.mock('../src/renderer/src/features/project-workspace/ProjectWorkspaceProvider.tsx', () => ({
  useProjectWorkspace: () => ({
    openFiles: [],
    selectedFile: null,
    fileDirty: false,
    selectSessionTab: vi.fn(),
    closeSessionTab: vi.fn(),
    selectFileTab: vi.fn(),
    closeFileTab: vi.fn(),
    pinFile: vi.fn(),
  }),
}))

vi.mock('../src/renderer/src/features/window/WindowControls.tsx', () => ({
  WindowControls: () => null,
}))

vi.mock('../src/renderer/src/pages/workspace/components/topbar/useSessionTabGlass.ts', () => ({
  useSessionTabGlass: () => ({
    stripRef: { current: null },
    rootRef: { current: null },
    materialRef: { current: null },
    defsRef: { current: null },
    lensRef: { current: null },
    overflow: false,
  }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.view = 'conversation'
  mocks.selectedProjectId = 'project-a'
  mocks.activeSessionId = 'chat-a'
  mocks.listener = null
  Object.defineProperty(window, 'dshDesktop', {
    configurable: true,
    value: {
      browser: {
        request: vi.fn(async () => EMPTY_BROWSER_STATE),
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
})

describe('内置浏览器自动化标签同步', () => {
  it('AI 打开内置浏览器时自动在顶栏登记页签并与当前对话并排展示，且保持原对话焦点', () => {
    let tabsApi!: NonNullable<ReturnType<typeof useWorkspaceTabs>>
    function Harness() {
      tabsApi = useWorkspaceTabs()!
      return (
        <>
          <BrowserAutomationTabSync />
          <Topbar visible searchTrigger={null} />
        </>
      )
    }

    render(
      <WorkspaceTabsProvider>
        <Harness />
      </WorkspaceTabsProvider>,
    )

    expect(screen.queryByRole('tab', { name: /极客湾/u })).toBeNull()
    expect(mocks.listener).not.toBeNull()

    act(() => {
      mocks.listener!({
        ...EMPTY_BROWSER_STATE,
        tabId: 'default',
        url: 'https://space.bilibili.com/25876945',
        title: '极客湾Geekerwan的个人空间',
        automated: true,
      })
    })

    const browserTab = screen.getByRole('tab', { name: '极客湾Geekerwan的个人空间' })
    expect(browserTab).toBeTruthy()
    expect(tabsApi.splitGroups).toEqual([{ tabs: ['chat-a', 'browser:default'], ratio: 0.5 }])
    expect(tabsApi.focusedTabId).toBe('chat-a')

    // 页面标题更新同步到顶栏，用户手动取消分屏后后续自动化事件不强制抢回分屏。
    act(() => {
      tabsApi.merge('chat-a')
    })
    expect(tabsApi.splitGroups).toEqual([])

    act(() => {
      mocks.listener!({
        ...EMPTY_BROWSER_STATE,
        tabId: 'default',
        url: 'https://space.bilibili.com/25876945/video',
        title: '极客湾最新视频',
        automated: true,
      })
    })
    expect(screen.getByRole('tab', { name: '极客湾最新视频' })).toBeTruthy()
    expect(tabsApi.splitGroups).toEqual([])

    // 主进程关闭该自动化页签后，顶栏同步移除；再次打开时重新自动并排展示。
    act(() => {
      mocks.listener!({
        ...EMPTY_BROWSER_STATE,
        tabId: 'default',
        closed: true,
      })
    })
    expect(screen.queryByRole('tab', { name: '极客湾最新视频' })).toBeNull()

    act(() => {
      mocks.listener!({
        ...EMPTY_BROWSER_STATE,
        tabId: 'default',
        url: 'https://example.com/',
        title: '示例站点',
        automated: true,
      })
    })
    expect(screen.getByRole('tab', { name: '示例站点' })).toBeTruthy()
    expect(tabsApi.splitGroups).toEqual([{ tabs: ['chat-a', 'browser:default'], ratio: 0.5 }])
  })

  it('跨项目复用同一自动化页签时迁移至当前项目分组并在顶栏可见', () => {
    let tabsApi!: NonNullable<ReturnType<typeof useWorkspaceTabs>>
    function Harness() {
      tabsApi = useWorkspaceTabs()!
      return (
        <>
          <BrowserAutomationTabSync />
          <Topbar visible searchTrigger={null} />
        </>
      )
    }

    const view = render(
      <WorkspaceTabsProvider>
        <Harness />
      </WorkspaceTabsProvider>,
    )

    act(() => {
      mocks.listener!({
        ...EMPTY_BROWSER_STATE,
        tabId: 'default',
        url: 'https://example.com/',
        title: '初始页',
        automated: true,
      })
    })
    act(() => {
      tabsApi.merge('chat-a')
    })

    // 切换到项目 B 并再次由 AI 操控 default 页签，应随项目 B 在顶栏显示。
    mocks.selectedProjectId = 'project-b'
    mocks.activeSessionId = 'chat-b'
    view.rerender(
      <WorkspaceTabsProvider>
        <Harness />
      </WorkspaceTabsProvider>,
    )

    act(() => {
      mocks.listener!({
        ...EMPTY_BROWSER_STATE,
        tabId: 'default',
        url: 'https://example.org/',
        title: '项目B页面',
        automated: true,
      })
    })
    expect(screen.getByRole('tab', { name: '项目B页面' })).toBeTruthy()
  })

  it('当前活动标签已在其他分屏组时，不抢占视图也不锁死后续自动分屏', () => {
    let tabsApi!: NonNullable<ReturnType<typeof useWorkspaceTabs>>
    function Harness() {
      tabsApi = useWorkspaceTabs()!
      return (
        <>
          <BrowserAutomationTabSync />
          <Topbar visible searchTrigger={null} />
        </>
      )
    }

    render(
      <WorkspaceTabsProvider>
        <Harness />
      </WorkspaceTabsProvider>,
    )

    // 先把 chat-a 与 chat-b 组成已有分屏组
    act(() => {
      tabsApi.splitTab('chat-b', 'chat-a', 'right')
      tabsApi.focus('chat-a')
    })

    // 首次自动化事件无法再拆分 chat-a，但页签仍应登记在顶栏
    act(() => {
      mocks.listener!({
        ...EMPTY_BROWSER_STATE,
        tabId: 'default',
        url: 'https://example.com/busy',
        title: '忙碌中页面',
        automated: true,
      })
    })
    expect(screen.getByRole('tab', { name: '忙碌中页面' })).toBeTruthy()
    expect(tabsApi.splitGroups).toEqual([{ tabs: ['chat-a', 'chat-b'], ratio: 0.5 }])

    // 合并原有分屏后，再次收到自动化事件应正常与 chat-a 并排展示
    act(() => {
      tabsApi.merge('chat-a')
    })
    act(() => {
      mocks.listener!({
        ...EMPTY_BROWSER_STATE,
        tabId: 'default',
        url: 'https://example.com/ready',
        title: '就绪页面',
        automated: true,
      })
    })
    expect(tabsApi.splitGroups).toEqual([{ tabs: ['chat-a', 'browser:default'], ratio: 0.5 }])
  })
})
