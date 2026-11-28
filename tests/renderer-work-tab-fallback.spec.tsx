// @vitest-environment jsdom
/** 测试关闭最后一个浏览器或终端标签后优先切回同组剩余标签，否则进入欢迎新聊天界面。 */
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WorkspaceTabsProvider,
  useWorkspaceTabs,
  type WorkTab,
} from '../src/renderer/src/features/workspace-tabs/WorkspaceTabsProvider.tsx'
import { WorkTabPanels } from '../src/renderer/src/features/workspace-tabs/WorkTabPanels.tsx'
import { projectIdForCwd } from '../src/renderer/src/domain/project.ts'
import { WorkspaceStore } from '../src/renderer/src/models/workspace/store.ts'
import type { DesktopBridge } from '../src/renderer/src/platform/contracts.ts'

const panelMocks = vi.hoisted(() => ({
  activeView: 'browser',
  selectedProjectId: null as string | null,
  tabs: [] as WorkTab[],
  enterNewSessionWelcome: vi.fn(),
}))

vi.mock('../src/renderer/src/hooks/useWorkspace.ts', () => ({
  SessionScope: {
    Provider: ({ children }: { children: unknown }) => children,
  },
  useWorkspaceSnapshot: () => ({
    activeView: panelMocks.activeView,
    selectedProjectId: panelMocks.selectedProjectId,
  }),
  useWorkspaceStore: () => ({
    enterNewSessionWelcome: panelMocks.enterNewSessionWelcome,
  }),
}))

vi.mock('../src/renderer/src/features/workspace-tabs/useWorkTabs.ts', () => ({
  useWorkTabs: () => panelMocks.tabs,
}))

vi.mock('../src/renderer/src/plugins/builtin/session.tsx', () => ({
  ConversationMain: () => <div>会话内容</div>,
}))

vi.mock('../src/renderer/src/features/browser/BrowserPanel.tsx', () => ({
  BrowserPanel: () => <div>浏览器内容</div>,
}))

vi.mock('../src/renderer/src/features/files/FileViewer.tsx', () => ({
  FileViewer: () => <div>文件内容</div>,
}))

vi.mock('../src/renderer/src/features/project-workspace/ProjectWorkspaceProvider.tsx', () => ({
  FileDocumentScope: ({ children }: { children: unknown }) => children,
}))

vi.mock('../src/renderer/src/features/source-control/SourceControlProvider.tsx', () => ({
  diffKey: () => 'diff',
  useOptionalSourceControl: () => null,
}))

vi.mock('../src/renderer/src/features/source-control/SourceControlView.tsx', () => ({
  SourceControlView: () => <div>差异内容</div>,
}))

vi.mock('../src/renderer/src/features/window/WindowControls.tsx', () => ({
  WindowControls: () => null,
}))

class StubResizeObserver {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

function makeTab(patch: Partial<WorkTab> & Pick<WorkTab, 'id' | 'kind' | 'projectId'>): WorkTab {
  return {
    title: patch.id,
    description: patch.id,
    active: false,
    select: vi.fn(),
    close: vi.fn(),
    ...patch,
  }
}

function createStoreHarness() {
  const workspace = {
    workspaceId: 'ws-a',
    path: '/repo/alpha',
    title: 'Alpha',
    createdAt: '2026-11-27T00:00:00.000Z',
    updatedAt: '2026-11-27T00:00:00.000Z',
    sessionIds: [] as string[],
  }
  const sessions: Array<{
    sessionId: string
    cwd: string
    title: string
    running: boolean
    blank: boolean
    createdAt: number
    updatedAt: number
  }> = []
  const hostCall = vi.fn(
    async (operation: string, payload?: Record<string, unknown>): Promise<unknown> => {
      if (operation === 'listSessions') return { items: [...sessions] }
      if (operation === 'listWorkspaces')
        return { items: [{ ...workspace }], archivedSessionIds: [] }
      if (operation === 'listArchivedSessions') return { sessionIds: [] }
      if (operation === 'listPermissionPresets') return { items: [] }
      if (operation === 'listModels') return { providers: [], current: null }
      if (operation === 'loadSessionPage') return { records: [], hasMore: false }
      if (operation === 'listSessionCommands') return { commands: [], skills: [] }
      if (operation === 'createSessionForWorkspace') {
        const created = {
          sessionId: 'welcome-session-1',
          cwd: workspace.path,
          title: '新会话',
          running: false,
          blank: true,
          createdAt: 10,
          updatedAt: 10,
        }
        sessions.push(created)
        workspace.sessionIds = ['welcome-session-1']
        return { sessionId: created.sessionId }
      }
      if (operation === 'promptSession') return { accepted: true, payload }
      return {}
    },
  )
  const bridge = {
    version: 19,
    platform: 'win32',
    host: {
      status: vi.fn(async () => ({
        kind: 'ready' as const,
        ownership: 'external' as const,
        identity: {},
      })),
      call: hostCall,
      onStatusChanged: () => () => undefined,
      onHostFrame: () => () => undefined,
      onSessionFrame: () => () => undefined,
      followSession: vi.fn(async () => undefined),
      unfollowSession: vi.fn(async () => undefined),
      respondInteraction: vi.fn(async () => ({ accepted: true })),
    },
    settings: {
      read: vi.fn(async () => null),
      update: vi.fn(async () => null),
      onChanged: () => () => undefined,
      onOpenRequested: () => () => undefined,
    },
    project: {
      list: vi.fn(async () => []),
      call: vi.fn(async () => ({})),
    },
  } as unknown as DesktopBridge
  return {
    bridge,
    hostCall,
    storage: { getItem: () => null, setItem: () => undefined },
    projectId: projectIdForCwd(workspace.path),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('ResizeObserver', StubResizeObserver)
  panelMocks.activeView = 'browser'
  panelMocks.tabs = []
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('关闭最后浏览器与终端标签回退欢迎新聊天', () => {
  it('关闭当前组最后一个浏览器标签且无其他标签时，直接进入该工作区的欢迎新聊天', () => {
    panelMocks.activeView = 'browser'
    panelMocks.tabs = [
      makeTab({ id: 'browser:b1', kind: 'browser', projectId: 'project:alpha', active: true }),
    ]
    const view = render(
      <WorkspaceTabsProvider>
        <WorkTabPanels />
      </WorkspaceTabsProvider>,
    )

    panelMocks.tabs = []
    view.rerender(
      <WorkspaceTabsProvider>
        <WorkTabPanels />
      </WorkspaceTabsProvider>,
    )

    expect(panelMocks.enterNewSessionWelcome).toHaveBeenCalledTimes(1)
    expect(panelMocks.enterNewSessionWelcome).toHaveBeenCalledWith('project:alpha')
  })

  it('关闭当前组最后一个终端标签且无其他标签时，直接进入该工作区的欢迎新聊天', () => {
    panelMocks.activeView = 'terminal'
    panelMocks.tabs = [
      makeTab({
        id: 'terminal:access-1:terminal-1',
        kind: 'terminal',
        projectId: 'project:alpha',
        active: true,
      }),
    ]
    const view = render(
      <WorkspaceTabsProvider>
        <WorkTabPanels />
      </WorkspaceTabsProvider>,
    )

    panelMocks.tabs = []
    view.rerender(
      <WorkspaceTabsProvider>
        <WorkTabPanels />
      </WorkspaceTabsProvider>,
    )

    expect(panelMocks.enterNewSessionWelcome).toHaveBeenCalledTimes(1)
    expect(panelMocks.enterNewSessionWelcome).toHaveBeenCalledWith('project:alpha')
  })

  it('关闭最后一个浏览器标签但同组仍有会话标签时，切回剩余会话标签而不进入空欢迎页', () => {
    const selectSession = vi.fn()
    panelMocks.activeView = 'browser'
    panelMocks.tabs = [
      makeTab({
        id: 'session-1',
        kind: 'session',
        projectId: 'project:alpha',
        active: false,
        select: selectSession,
      }),
      makeTab({ id: 'browser:b1', kind: 'browser', projectId: 'project:alpha', active: true }),
    ]
    const view = render(
      <WorkspaceTabsProvider>
        <WorkTabPanels />
      </WorkspaceTabsProvider>,
    )

    panelMocks.tabs = [
      makeTab({
        id: 'session-1',
        kind: 'session',
        projectId: 'project:alpha',
        active: false,
        select: selectSession,
      }),
    ]
    view.rerender(
      <WorkspaceTabsProvider>
        <WorkTabPanels />
      </WorkspaceTabsProvider>,
    )

    expect(selectSession).toHaveBeenCalledTimes(1)
    expect(panelMocks.enterNewSessionWelcome).not.toHaveBeenCalled()
  })

  it('关闭甲项目最后一个浏览器标签时，不跨项目跳转到乙项目浏览器标签', () => {
    let tabsApi!: NonNullable<ReturnType<typeof useWorkspaceTabs>>
    function Harness() {
      tabsApi = useWorkspaceTabs()!
      return null
    }
    render(
      <WorkspaceTabsProvider>
        <Harness />
      </WorkspaceTabsProvider>,
    )

    act(() => {
      tabsApi.ensureBrowserTab('b-other', 'project:beta', '乙项目网页')
      tabsApi.ensureBrowserTab('b-alpha', 'project:alpha', '甲项目网页')
      tabsApi.selectBrowser('b-alpha')
    })
    expect(tabsApi.activeBrowserId).toBe('b-alpha')

    act(() => {
      tabsApi.removeBrowserTab('b-alpha')
    })
    expect(tabsApi.activeBrowserId).toBeNull()
    expect(tabsApi.browserTabs.map(tab => tab.id)).toEqual(['b-other'])
  })

  it('全部项目模式下关闭未分配项目的浏览器标签时，优先切回剩余已打开会话标签而不误入空欢迎页', () => {
    const selectSession = vi.fn()
    panelMocks.activeView = 'browser'
    panelMocks.selectedProjectId = null
    panelMocks.tabs = [
      makeTab({
        id: 'session-1',
        kind: 'session',
        projectId: 'project:alpha',
        active: false,
        select: selectSession,
      }),
      makeTab({ id: 'browser:b1', kind: 'browser', projectId: 'unassigned', active: true }),
    ]
    const view = render(
      <WorkspaceTabsProvider>
        <WorkTabPanels />
      </WorkspaceTabsProvider>,
    )

    panelMocks.tabs = [
      makeTab({
        id: 'session-1',
        kind: 'session',
        projectId: 'project:alpha',
        active: false,
        select: selectSession,
      }),
    ]
    view.rerender(
      <WorkspaceTabsProvider>
        <WorkTabPanels />
      </WorkspaceTabsProvider>,
    )

    expect(selectSession).toHaveBeenCalledTimes(1)
    expect(panelMocks.enterNewSessionWelcome).not.toHaveBeenCalled()
  })

  it('全部项目下关闭前即使终端标签曾因无选中会话失焦，移除最后终端标签后仍回到欢迎新聊天', () => {
    panelMocks.activeView = 'terminal'
    panelMocks.selectedProjectId = null
    panelMocks.tabs = [
      makeTab({
        id: 'terminal:access-1:terminal-1',
        kind: 'terminal',
        projectId: 'project:alpha',
        active: false,
        rawActive: false,
      }),
    ]
    const view = render(
      <WorkspaceTabsProvider>
        <WorkTabPanels />
      </WorkspaceTabsProvider>,
    )

    panelMocks.tabs = []
    view.rerender(
      <WorkspaceTabsProvider>
        <WorkTabPanels />
      </WorkspaceTabsProvider>,
    )

    expect(panelMocks.enterNewSessionWelcome).toHaveBeenCalledTimes(1)
    expect(panelMocks.enterNewSessionWelcome).toHaveBeenCalledWith('project:alpha')
  })

  it('全部项目下关闭前即使浏览器标签曾失焦，移除最后浏览器标签后仍回到欢迎新聊天', () => {
    panelMocks.activeView = 'browser'
    panelMocks.selectedProjectId = null
    panelMocks.tabs = [
      makeTab({
        id: 'browser:b-lost',
        kind: 'browser',
        projectId: 'project:alpha',
        active: false,
        rawActive: false,
      }),
    ]
    const view = render(
      <WorkspaceTabsProvider>
        <WorkTabPanels />
      </WorkspaceTabsProvider>,
    )

    panelMocks.tabs = []
    view.rerender(
      <WorkspaceTabsProvider>
        <WorkTabPanels />
      </WorkspaceTabsProvider>,
    )

    expect(panelMocks.enterNewSessionWelcome).toHaveBeenCalledTimes(1)
    expect(panelMocks.enterNewSessionWelcome).toHaveBeenCalledWith('project:alpha')
  })

  it('WorkspaceStore.enterNewSessionWelcome 在全部项目模式下也支持直接发送首条消息创建会话', async () => {
    const harness = createStoreHarness()
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()

    store.setView('browser')
    store.enterNewSessionWelcome(harness.projectId)

    expect(store.selectedProject()?.id).toBe(harness.projectId)
    expect(store.getSnapshot()).toMatchObject({
      activeView: 'conversation',
      selectedProjectId: null,
      selectedSessionId: null,
      openedSessionIds: [],
      newSessionProjectId: harness.projectId,
    })

    store.setNewSessionDraft('你好，从欢迎页发消息')
    await expect(store.submitComposerInput('你好，从欢迎页发消息')).resolves.toBe(true)
    expect(store.getSnapshot()).toMatchObject({
      activeView: 'conversation',
      selectedProjectId: null,
      selectedSessionId: 'welcome-session-1',
      newSessionProjectId: null,
    })
    store.dispose()
  })

  it('关闭空会话标签后再关闭最后一个终端或浏览器标签时，直接复用已有空会话并恢复模型加载', async () => {
    const harness = createStoreHarness()
    const baseCall = harness.hostCall.getMockImplementation()!
    const existingBlank = {
      sessionId: 'blank-existing-1',
      cwd: '/repo/alpha',
      title: '新会话',
      running: false,
      blank: true,
      createdAt: 5,
      updatedAt: 5,
    }
    harness.hostCall.mockImplementation(async (operation, payload) => {
      if (operation === 'listSessions') return { items: [existingBlank] }
      if (operation === 'listWorkspaces') {
        return {
          items: [
            {
              workspaceId: 'ws-a',
              path: '/repo/alpha',
              title: 'Alpha',
              createdAt: '2026-11-27T00:00:00.000Z',
              updatedAt: '2026-11-27T00:00:00.000Z',
              sessionIds: [existingBlank.sessionId],
            },
          ],
          archivedSessionIds: [],
        }
      }
      if (operation === 'getSessionModels') {
        return {
          default: { provider: 'deepseek-official', model: 'deepseek-flash' },
          routableProviders: ['deepseek-official'],
          groups: [
            {
              id: 'deepseek-official',
              name: 'DeepSeek',
              models: [{ id: 'deepseek-flash', name: 'DeepSeek-V41-Flash' }],
            },
          ],
          failures: [],
        }
      }
      return baseCall(operation, payload)
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()

    // 复现用户路径：默认空会话打开终端后，依次关闭会话标签与终端标签。
    store.setView('terminal')
    store.closeSessionTab(existingBlank.sessionId)
    expect(store.getSnapshot().openedSessionIds).toEqual([])
    harness.hostCall.mockClear()

    store.enterNewSessionWelcome(harness.projectId)

    expect(store.getSnapshot()).toMatchObject({
      activeView: 'conversation',
      selectedProjectId: null,
      selectedSessionId: existingBlank.sessionId,
      openedSessionIds: [existingBlank.sessionId],
      newSessionProjectId: null,
    })
    expect(harness.hostCall).not.toHaveBeenCalledWith(
      'createSessionForWorkspace',
      expect.anything(),
    )
    expect(harness.hostCall).toHaveBeenCalledWith(
      'loadSessionPage',
      expect.objectContaining({ sessionId: existingBlank.sessionId }),
    )
    await expect(store.loadSessionModels(false)).resolves.toBe(true)
    expect(harness.hostCall).toHaveBeenCalledWith('getSessionModels', {
      sessionId: existingBlank.sessionId,
    })
    store.dispose()
  })
})
