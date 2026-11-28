// @vitest-environment jsdom
/**
 * 验证空会话输入框上方的工作区指示与切换条，以及 WorkspaceStore 切换空会话工作区、分屏作用域与草稿附件边界逻辑。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  UNGROUPED_PROJECT_ID,
  projectIdForCwd,
  type ProjectSummary,
} from '../src/renderer/src/domain/project.ts'
import type { SessionSummary } from '../src/renderer/src/domain/session.ts'
import type {
  DesktopBridge,
  DesktopImageAttachment,
} from '../src/renderer/src/platform/contracts.ts'
import { WorkspaceStore } from '../src/renderer/src/models/workspace/store.ts'

const uiMocks = vi.hoisted(() => ({
  snapshot: {
    selectedSessionId: 'session-a' as string | null,
    selectedProjectId: null as string | null,
    newSessionProjectId: null as string | null,
    navigationCollapsed: false,
    activeView: 'conversation',
    openedSessionIds: ['session-a'] as string[],
    unreadSessionIds: [] as string[],
    creatingSession: false,
    workspaceCapability: 'available' as const,
    hostStatus: { kind: 'ready' as const, ownership: 'external' as const, identity: {} },
    projects: [] as ProjectSummary[],
    sessions: [] as SessionSummary[],
    pendingInteractions: [] as readonly unknown[],
    sessionDrafts: {} as Record<string, string>,
    sessionAttachments: {} as Record<string, readonly unknown[]>,
    sessionFiles: {} as Record<string, readonly unknown[]>,
    sessionQueue: { items: [], totalCount: 0, omittedCount: 0, truncated: false },
    awaitingResponseSessionIds: [] as string[],
    sessionModels: null,
    sessionPermission: null,
    sendingMessage: false,
    choosingAttachments: false,
    busyEnter: 'queue' as const,
    error: null as string | null,
    composerHeight: 112,
  },
  rootSnapshot: null as Record<string, unknown> | null,
  store: {
    getSnapshot: vi.fn(),
    selectedProject: vi.fn<() => ProjectSummary | undefined>(() => undefined),
    selectProject: vi.fn(),
    selectSession: vi.fn(),
    selectSessionTab: vi.fn(),
    closeSessionTab: vi.fn(),
    enterNewSessionWelcome: vi.fn(),
    switchDraftWorkspace: vi.fn(async (_projectId: string, _sessionId?: string | null) => true),
    createWorkspace: vi.fn(async () => true),
    clearError: vi.fn(),
    loadSessionModels: vi.fn(async () => true),
    loadPermissionCatalog: vi.fn(async () => true),
    resetComposerHeight: vi.fn(),
    resizeComposer: vi.fn(),
  },
  sourceControl: {
    gitSummaryProjectId: undefined as string | null | undefined,
    gitSummary: null as {
      available: boolean
      branch: string | null
      ahead: number
      behind: number
    } | null,
  },
  workspaceTabs: {
    replaceSplitTab: vi.fn(() => true),
  },
}))

vi.mock('../src/renderer/src/hooks/useWorkspace.ts', () => ({
  useWorkspaceSnapshot: () => uiMocks.snapshot,
  useWorkspaceStore: () => uiMocks.store,
}))

vi.mock('../src/renderer/src/features/source-control/SourceControlProvider.tsx', () => ({
  useOptionalSourceControl: () => uiMocks.sourceControl,
}))

vi.mock('../src/renderer/src/features/workspace-tabs/WorkspaceTabsProvider.tsx', () => ({
  useWorkspaceTabs: () => uiMocks.workspaceTabs,
}))

import { ComposerWorkspaceBar } from '../src/renderer/src/features/composer/ComposerWorkspaceBar.tsx'
import { WindowStateSync } from '../src/renderer/src/features/window/WindowControls.tsx'
import { ChatComposer } from '../src/renderer/src/pages/workspace/components/mainpanel/chat-mainpanel/index.tsx'

const projectA: ProjectSummary = {
  source: 'workspace',
  id: projectIdForCwd('/work/alpha'),
  workspaceId: 'ws-alpha',
  name: 'AlphaProject',
  cwd: '/work/alpha',
  displayPath: '/work/alpha',
  sessionIds: ['session-a'],
  sessionCount: 1,
  lastActivity: 200,
}

const projectB: ProjectSummary = {
  source: 'workspace',
  id: projectIdForCwd('/work/beta'),
  workspaceId: 'ws-beta',
  name: 'BetaProject',
  cwd: '/work/beta',
  displayPath: '/work/beta',
  sessionIds: ['session-b'],
  sessionCount: 1,
  lastActivity: 100,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  uiMocks.rootSnapshot = null
  uiMocks.store.getSnapshot.mockImplementation(() => uiMocks.rootSnapshot ?? uiMocks.snapshot)
  uiMocks.snapshot.projects = [projectA, projectB]
  uiMocks.snapshot.sessions = [
    { sessionId: 'session-a', cwd: '/work/alpha', updatedAt: 200, running: false, blank: true },
    { sessionId: 'session-b', cwd: '/work/beta', updatedAt: 100, running: false, blank: true },
  ]
  uiMocks.snapshot.selectedSessionId = 'session-a'
  uiMocks.snapshot.selectedProjectId = null
  uiMocks.snapshot.newSessionProjectId = null
  uiMocks.snapshot.navigationCollapsed = false
  uiMocks.snapshot.activeView = 'conversation'
  uiMocks.snapshot.openedSessionIds = ['session-a']
  uiMocks.snapshot.unreadSessionIds = []
  uiMocks.snapshot.creatingSession = false
  uiMocks.snapshot.pendingInteractions = []
  uiMocks.snapshot.hostStatus = { kind: 'ready', ownership: 'external', identity: {} }
  uiMocks.sourceControl.gitSummaryProjectId = projectA.id
  uiMocks.sourceControl.gitSummary = {
    available: true,
    branch: 'main',
    ahead: 1,
    behind: 0,
  }
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('输入区上方工作区胶囊', () => {
  it('在空会话展示当前工作区与匹配分支，并支持切换工作区或打开目录', () => {
    render(<ComposerWorkspaceBar />)

    const trigger = screen.getByRole('button', { name: '工作区：AlphaProject' })
    expect(trigger.textContent).toContain('AlphaProject')
    expect(screen.getByText('main')).toBeTruthy()

    fireEvent.click(trigger)
    const betaOption = screen.getByRole('menuitemradio', { name: /BetaProject/u })
    fireEvent.click(betaOption)
    expect(uiMocks.store.switchDraftWorkspace).toHaveBeenCalledWith(projectB.id, 'session-a')

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: '打开工作区目录…' }))
    expect(uiMocks.store.createWorkspace).toHaveBeenCalledOnce()
  })

  it('分屏副窗格按当前 SessionScope 传入会话标识、不串显主窗格项目分支，并在切换后同步替换分屏成员', async () => {
    uiMocks.rootSnapshot = {
      ...uiMocks.snapshot,
      selectedSessionId: 'session-a',
      selectedProjectId: projectA.id,
    }
    uiMocks.snapshot.selectedSessionId = 'session-b'
    uiMocks.snapshot.selectedProjectId = projectB.id
    uiMocks.sourceControl.gitSummaryProjectId = projectA.id
    uiMocks.sourceControl.gitSummary = {
      available: true,
      branch: 'feat/alpha-only',
      ahead: 0,
      behind: 0,
    }
    uiMocks.store.switchDraftWorkspace.mockImplementationOnce(async () => {
      uiMocks.rootSnapshot = {
        ...uiMocks.snapshot,
        selectedSessionId: 'session-alpha-new',
      }
      return true
    })

    render(<ComposerWorkspaceBar />)

    const trigger = screen.getByRole('button', { name: '工作区：BetaProject' })
    expect(screen.queryByText('feat/alpha-only')).toBeNull()

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitemradio', { name: /AlphaProject/u }))

    await waitFor(() => {
      expect(uiMocks.store.switchDraftWorkspace).toHaveBeenCalledWith(projectA.id, 'session-b')
      expect(uiMocks.workspaceTabs.replaceSplitTab).toHaveBeenCalledWith(
        'session-b',
        'session-alpha-new',
      )
    })
  })

  it('在 ChatComposer 中展开侧栏时仅空会话渲染工作区条，收起侧栏后已有消息会话也显示工作区选择按钮', () => {
    const view = render(<ChatComposer />)
    expect(screen.getByRole('group', { name: '当前工作区' })).toBeTruthy()

    uiMocks.snapshot.sessions = [
      { sessionId: 'session-a', cwd: '/work/alpha', updatedAt: 200, running: false, blank: false },
    ]
    view.rerender(<ChatComposer />)
    expect(screen.queryByRole('group', { name: '当前工作区' })).toBeNull()

    uiMocks.snapshot.navigationCollapsed = true
    view.rerender(<ChatComposer />)
    expect(screen.getByRole('group', { name: '当前工作区' })).toBeTruthy()
    expect(
      screen.getByRole('group', { name: '当前工作区' }).getAttribute('data-workspace-bar-mode'),
    ).toBe('switch')
  })

  it('左侧栏收缩且处于已有消息会话时，工作区胶囊提示后台未读并切换工作区而非改写当前会话目录', () => {
    uiMocks.snapshot.navigationCollapsed = true
    uiMocks.snapshot.sessions = [
      { sessionId: 'session-a', cwd: '/work/alpha', updatedAt: 200, running: false, blank: false },
      { sessionId: 'session-b', cwd: '/work/beta', updatedAt: 100, running: false, blank: false },
    ]
    uiMocks.snapshot.openedSessionIds = ['session-a', 'session-b']
    uiMocks.snapshot.unreadSessionIds = ['session-b']

    render(<ComposerWorkspaceBar />)

    const trigger = screen.getByRole('button', {
      name: '工作区：AlphaProject，其他工作区有 1 个会话更新',
    })
    expect(trigger.querySelector('[data-workspace-unread="true"]')?.textContent).toBe('1')

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitemradio', { name: /BetaProject/u }))

    expect(uiMocks.store.selectSessionTab).toHaveBeenCalledWith('session-b')
    expect(uiMocks.store.switchDraftWorkspace).not.toHaveBeenCalled()
  })

  it('左侧栏收缩且空白会话无草稿时优先切入目标工作区已打开的未读标签；有未发草稿时仍迁移草稿', () => {
    uiMocks.snapshot.navigationCollapsed = true
    uiMocks.snapshot.openedSessionIds = ['session-a', 'session-b']
    uiMocks.snapshot.unreadSessionIds = ['session-b']
    uiMocks.snapshot.sessionDrafts = {}

    const view = render(<ComposerWorkspaceBar />)
    fireEvent.click(screen.getByRole('button', { name: /工作区：AlphaProject/u }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /BetaProject/u }))
    expect(uiMocks.store.selectSessionTab).toHaveBeenCalledWith('session-b')
    expect(uiMocks.store.switchDraftWorkspace).not.toHaveBeenCalled()

    vi.clearAllMocks()
    uiMocks.snapshot.sessionDrafts = { 'session-a': '待带走的新任务草稿' }
    view.rerender(<ComposerWorkspaceBar />)
    fireEvent.click(screen.getByRole('button', { name: /工作区：AlphaProject/u }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /BetaProject/u }))
    expect(uiMocks.store.switchDraftWorkspace).toHaveBeenCalledWith(projectB.id, 'session-a')
  })

  it('左侧栏收缩时菜单保留已打开的无项目对话分组（project:ungrouped）并支持双向切换', () => {
    const ungroupedProject: ProjectSummary = {
      source: 'legacy',
      id: UNGROUPED_PROJECT_ID,
      name: '无项目对话',
      displayPath: '未绑定 Durable Workspace',
      sessionIds: ['session-ungrouped'],
      sessionCount: 1,
      lastActivity: 50,
    }
    uiMocks.snapshot.navigationCollapsed = true
    uiMocks.snapshot.projects = [projectA, ungroupedProject]
    uiMocks.snapshot.sessions = [
      { sessionId: 'session-a', cwd: '/work/alpha', updatedAt: 200, running: false, blank: false },
      {
        sessionId: 'session-ungrouped',
        cwd: '/tmp/other',
        updatedAt: 50,
        running: false,
        blank: false,
      },
    ]
    uiMocks.snapshot.selectedSessionId = 'session-a'
    uiMocks.snapshot.openedSessionIds = ['session-a', 'session-ungrouped']

    render(<ComposerWorkspaceBar />)

    fireEvent.click(screen.getByRole('button', { name: '工作区：AlphaProject' }))
    const ungroupedOption = screen.getByRole('menuitemradio', { name: /无项目对话/u })
    expect(ungroupedOption.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(ungroupedOption)
    expect(uiMocks.store.selectSessionTab).toHaveBeenCalledWith('session-ungrouped')
  })
})

function createWorkspaceSwitchHarness() {
  const sessionList: Array<{
    sessionId: string
    cwd: string
    updatedAt: number
    running: boolean
    blank: boolean
  }> = [
    { sessionId: 'session-a', cwd: '/work/alpha', updatedAt: 200, running: false, blank: true },
    { sessionId: 'session-b', cwd: '/work/beta', updatedAt: 100, running: false, blank: true },
  ]
  const workspaces = [
    {
      workspaceId: 'ws-alpha',
      title: 'AlphaProject',
      path: '/work/alpha',
      sessionIds: ['session-a'],
      createdAt: '2026-11-27T00:00:00.000Z',
      updatedAt: '2026-11-27T00:00:00.000Z',
    },
    {
      workspaceId: 'ws-beta',
      title: 'BetaProject',
      path: '/work/beta',
      sessionIds: ['session-b'],
      createdAt: '2026-11-27T00:00:00.000Z',
      updatedAt: '2026-11-27T00:00:00.000Z',
    },
  ]
  let createdCount = 0
  const hostCall = vi.fn<DesktopBridge['host']['call']>(async (operation, payload) => {
    if (operation === 'listSessions') return { items: [...sessionList] }
    if (operation === 'listWorkspaces') {
      return { items: workspaces.map(item => ({ ...item })), archivedSessionIds: [] }
    }
    if (operation === 'listArchivedSessions') return { sessionIds: [] }
    if (operation === 'loadSessionPage') return { records: [], hasMore: false }
    if (operation === 'listSessionCommands') return { commands: [], skills: [] }
    if (operation === 'createSessionForWorkspace') {
      createdCount += 1
      const sessionId = `session-created-${String(createdCount)}`
      const target = workspaces.find(
        item => item.workspaceId === (payload as { workspaceId?: string })?.workspaceId,
      )!
      sessionList.unshift({
        sessionId,
        cwd: target.path,
        updatedAt: 300 + createdCount,
        running: false,
        blank: true,
      })
      target.sessionIds = [sessionId, ...target.sessionIds]
      return { sessionId }
    }
    return {}
  })
  const bridge = {
    platform: 'win32',
    host: {
      status: vi.fn(async () => ({
        kind: 'ready' as const,
        ownership: 'external' as const,
        identity: {},
      })),
      onStatusChanged: vi.fn(() => () => {}),
      onHostFrame: vi.fn(() => () => {}),
      onSessionFrame: vi.fn(() => () => {}),
      followSession: vi.fn(async () => {}),
      unfollowSession: vi.fn(async () => {}),
      call: hostCall,
      respondInteraction: vi.fn(async () => ({ accepted: true })),
    },
    attachments: {
      importImages: vi.fn(async (): Promise<readonly DesktopImageAttachment[]> => [
        {
          name: 'preview.png',
          mediaType: 'image/png',
          base64: 'AAAA',
          bytes: 4,
        },
      ]),
    },
    settings: {
      read: vi.fn(async () => null),
      update: vi.fn(async () => null),
      onChanged: vi.fn(() => () => {}),
    },
    project: {
      list: vi.fn(async () => []),
      call: vi.fn(async () => ({})),
    },
  } as unknown as DesktopBridge
  return { bridge, hostCall, sessionList, workspaces }
}

describe('WorkspaceStore.switchDraftWorkspace', () => {
  it('切换空会话工作区时迁移草稿与图片附件，原位替换空会话标签且不收窄项目筛选', async () => {
    const harness = createWorkspaceSwitchHarness()
    const store = new WorkspaceStore(harness.bridge, {
      getItem: () => null,
      setItem: () => undefined,
    })
    await store.refreshSessions()
    store.setSessionDraft('session-a', '先把这段需求带到 Beta')
    await store.importSessionImages([{ name: 'preview.png', bytes: new Uint8Array([1, 2, 3, 4]) }])
    expect(store.getSnapshot().openedSessionIds).toEqual(['session-a'])

    const switched = await store.switchDraftWorkspace(projectIdForCwd('/work/beta'), 'session-a')
    expect(switched).toBe(true)
    expect(store.getSnapshot().selectedSessionId).toBe('session-b')
    expect(store.getSnapshot().selectedProjectId).toBeNull()
    expect(store.getSnapshot().openedSessionIds).toEqual(['session-b'])
    expect(store.getSnapshot().sessionDrafts['session-b']).toBe('先把这段需求带到 Beta')
    expect(store.getSnapshot().sessionDrafts['session-a']).toBeUndefined()
    expect(store.getSnapshot().sessionAttachments['session-b']).toHaveLength(1)
    expect(store.getSnapshot().sessionAttachments['session-a']).toBeUndefined()
    store.dispose()
  })

  it('分屏场景下主会话非空时仍可切换副窗格空会话，且目标空会话已有草稿时新建空会话避免丢草稿', async () => {
    const harness = createWorkspaceSwitchHarness()
    harness.sessionList[0]!.blank = false
    harness.sessionList.push({
      sessionId: 'session-alpha-blank',
      cwd: '/work/alpha',
      updatedAt: 150,
      running: false,
      blank: true,
    })
    harness.workspaces[0]!.sessionIds = ['session-a', 'session-alpha-blank']
    const store = new WorkspaceStore(harness.bridge, {
      getItem: () => null,
      setItem: () => undefined,
    })
    await store.refreshSessions()
    expect(store.getSnapshot().selectedSessionId).toBe('session-a')

    // 目标 Beta 空会话已有旧草稿时，不覆盖旧草稿也不丢弃欢迎页/副窗格的新草稿。
    store.setSessionDraft('session-b', 'Beta 原本的未发草稿')
    store.setSessionDraft('session-alpha-blank', '副窗格的新草稿')

    const switched = await store.switchDraftWorkspace(
      projectIdForCwd('/work/beta'),
      'session-alpha-blank',
    )
    expect(switched).toBe(true)
    expect(store.getSnapshot().selectedSessionId).toBe('session-created-1')
    expect(store.getSnapshot().sessionDrafts['session-created-1']).toBe('副窗格的新草稿')
    expect(store.getSnapshot().sessionDrafts['session-b']).toBe('Beta 原本的未发草稿')
    store.dispose()
  })
})

describe('WindowStateSync 外轮廓几何同步', () => {
  it('在 Windows 实色降级下保留 18px 外轮廓圆角，并在全屏零圆角下标记矩形窗口', async () => {
    let listener: ((state: unknown) => void) | undefined
    const previousDesktop = (window as { dshDesktop?: unknown }).dshDesktop
    ;(window as { dshDesktop?: unknown }).dshDesktop = {
      window: {
        read: vi.fn(async () => ({
          platform: 'win32',
          maximized: false,
          maximizable: true,
          minimizable: true,
          canvasComposition: 'opaque' as const,
          cornerRadius: 18,
        })),
        onChanged: vi.fn((callback: (state: unknown) => void) => {
          listener = callback
          return () => {
            listener = undefined
          }
        }),
        act: vi.fn(async () => undefined),
      },
    }
    try {
      const view = render(<WindowStateSync />)
      await waitFor(() => {
        expect(document.documentElement.style.getPropertyValue('--window-outline-radius')).toBe(
          '18px',
        )
      })
      expect(document.documentElement.dataset.windowSquare).toBe('false')

      listener?.({
        platform: 'win32',
        maximized: false,
        maximizable: true,
        minimizable: true,
        canvasComposition: 'opaque',
        cornerRadius: 0,
      })
      expect(document.documentElement.dataset.windowSquare).toBe('true')
      expect(document.documentElement.style.getPropertyValue('--window-outline-radius')).toBe('0px')
      view.unmount()
    } finally {
      ;(window as { dshDesktop?: unknown }).dshDesktop = previousDesktop
      delete document.documentElement.dataset.windowSquare
      delete document.documentElement.dataset.windowMaximized
      delete document.documentElement.dataset.canvasComposition
      document.documentElement.style.removeProperty('--window-outline-radius')
    }
  })
})
