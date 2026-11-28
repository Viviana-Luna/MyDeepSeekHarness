// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConversationFrame } from '../src/renderer/src/features/conversation/ConversationFrame.tsx'
import {
  resolveWorkTabGroups,
  shouldShowSessionTabs,
} from '../src/renderer/src/features/workspace-tabs/work-tab-groups.ts'
import {
  WorkspaceTabsProvider,
  useWorkspaceTabs,
  type WorkTab,
} from '../src/renderer/src/features/workspace-tabs/WorkspaceTabsProvider.tsx'
import { Topbar } from '../src/renderer/src/pages/workspace/components/topbar/index.tsx'

const mocks = vi.hoisted(() => ({
  view: 'files',
  unassigned: false,
  allProjectsMode: false,
  navigationCollapsed: false,
  drag: null as
    | null
    | ((id: string, x: number, y: number, phase: 'detach' | 'move' | 'drop' | 'cancel') => boolean),
  selectSession: vi.fn(),
  closeSession: vi.fn(),
  closeProjectTabs: vi.fn(),
  selectFile: vi.fn(),
  closeFile: vi.fn(),
  pin: vi.fn(),
  setView: vi.fn(),
}))
vi.mock('../src/renderer/src/hooks/useWorkspace.ts', () => ({
  useWorkspaceSnapshot: () => ({
    openedSessionIds: mocks.unassigned ? ['chat', 'other'] : ['chat'],
    selectedSessionId: mocks.unassigned ? 'other' : 'chat',
    activeView: mocks.view,
    navigationCollapsed: mocks.navigationCollapsed,
    sessions: [
      { sessionId: 'chat', title: '项目聊天', cwd: '/project', running: true },
      { sessionId: 'other', title: '无项目聊天', cwd: '/project' },
    ],
    projects: [
      { id: 'project', name: '项目', cwd: '/project', source: 'legacy', sessionIds: ['chat'] },
    ],
    unreadSessionIds: [],
    selectedProjectId: mocks.allProjectsMode ? null : 'project',
    hostStatus: { kind: 'ready' },
  }),
  useWorkspaceStore: () => ({
    selectedProject: () => (mocks.allProjectsMode ? undefined : { id: 'project' }),
    moveSessionTab: vi.fn(),
    setView: mocks.setView,
  }),
}))
vi.mock('../src/renderer/src/features/project-workspace/ProjectWorkspaceProvider.tsx', () => ({
  useProjectWorkspace: () => ({
    openFiles: [{ relativePath: 'src/demo.ts', pinned: false }],
    selectedFile: { relativePath: 'src/demo.ts' },
    fileDirty: true,
    selectSessionTab: mocks.selectSession,
    closeSessionTab: mocks.closeSession,
    closeProjectTabs: mocks.closeProjectTabs,
    selectFileTab: mocks.selectFile,
    closeFileTab: mocks.closeFile,
    pinFile: mocks.pin,
  }),
}))
vi.mock('../src/renderer/src/features/window/WindowControls.tsx', () => ({
  WindowControls: () => null,
}))
vi.mock('../src/renderer/src/pages/workspace/components/topbar/useSessionTabGlass.ts', () => ({
  useSessionTabGlass: (
    _visible: boolean,
    _selected: string,
    _layout: string,
    _move: unknown,
    drag: typeof mocks.drag,
  ) => {
    mocks.drag = drag
    return {
      stripRef: { current: null },
      rootRef: { current: null },
      materialRef: { current: null },
      defsRef: { current: null },
      lensRef: { current: null },
      overflow: false,
    }
  },
}))
beforeEach(() => {
  vi.clearAllMocks()
  mocks.view = 'files'
  mocks.unassigned = false
  mocks.allProjectsMode = false
  mocks.navigationCollapsed = false
})
afterEach(cleanup)

function makeWorkTab(
  patch: Partial<WorkTab> & Pick<WorkTab, 'id' | 'kind' | 'projectId'>,
): WorkTab {
  return {
    title: patch.id,
    description: patch.id,
    active: false,
    select: vi.fn(),
    close: vi.fn(),
    ...patch,
  }
}

describe('统一工作标签导航', () => {
  it('侧栏展开与收起时顶栏均不显示左上角标签组按钮与搜索按钮，并保留既有标签状态', () => {
    const view = render(<Topbar visible />)
    const file = screen.getByRole('tab', { name: 'demo.ts' })
    expect(screen.queryByRole('button', { name: /切换标签组/u })).toBeNull()
    expect(document.querySelector('.session-group-switcher')).toBeNull()
    expect(document.querySelector('.session-search-trigger')).toBeNull()
    expect(file.getAttribute('aria-selected')).toBe('true')
    mocks.navigationCollapsed = true
    view.rerender(<Topbar visible />)
    expect(screen.queryByRole('button', { name: /切换标签组/u })).toBeNull()
    expect(document.querySelector('.session-group-switcher')).toBeNull()
    expect(document.querySelector('.session-search-trigger')).toBeNull()
    expect(screen.getByRole('tab', { name: 'demo.ts' })).toBe(file)
    mocks.navigationCollapsed = false
    view.rerender(<Topbar visible />)
    expect(screen.queryByRole('button', { name: /切换标签组/u })).toBeNull()
    expect(screen.getByRole('tab', { name: 'demo.ts' })).toBe(file)
    expect(mocks.selectFile).not.toHaveBeenCalled()
    expect(mocks.selectSession).not.toHaveBeenCalled()
  })

  it('平铺选择标签弹窗按工作区分组并提供整组关闭入口', () => {
    mocks.navigationCollapsed = true
    render(<Topbar visible />)
    fireEvent.click(screen.getByRole('button', { name: '平铺选择标签' }))
    expect(screen.getByRole('textbox', { name: '搜索工作标签' })).toBeTruthy()
    const closeGroupButton = screen.getByRole('button', { name: '关闭 项目 的全部标签' })
    fireEvent.click(closeGroupButton)
    expect(mocks.closeProjectTabs).toHaveBeenCalledWith(['chat'], expect.any(Function))
  })

  it('无项目聊天即使使用相同工作目录，也按会话归属切换顶部组', () => {
    mocks.unassigned = true
    mocks.view = 'conversation'
    render(<Topbar visible />)
    expect(screen.getByRole('tab', { name: '无项目聊天' }).getAttribute('aria-selected')).toBe(
      'true',
    )
    expect(screen.queryByRole('tab', { name: '项目聊天' })).toBeNull()
  })

  it('标签焦点独立于分屏组，切出与返回保留两侧和比例，新组不破坏旧组', () => {
    let workspaceTabs!: NonNullable<ReturnType<typeof useWorkspaceTabs>>
    function TabHarness() {
      workspaceTabs = useWorkspaceTabs()!
      return <Topbar visible />
    }
    const view = render(
      <WorkspaceTabsProvider>
        <TabHarness />
      </WorkspaceTabsProvider>,
    )
    let file = screen.getByRole('tab', { name: 'demo.ts' })
    let chat = screen.getByRole('tab', { name: '项目聊天' })
    expect(file.getAttribute('aria-selected')).toBe('true')
    expect(chat.getAttribute('aria-selected')).toBe('false')
    expect(file.title).toBe('src/demo.ts')
    fireEvent.click(chat)
    expect(mocks.selectSession).toHaveBeenCalledWith('chat')
    mocks.view = 'conversation'
    view.rerender(
      <WorkspaceTabsProvider>
        <TabHarness />
      </WorkspaceTabsProvider>,
    )
    expect(chat.getAttribute('aria-selected')).toBe('true')
    expect(file.getAttribute('aria-selected')).toBe('false')
    const fileId = 'file:project:src/demo.ts'
    act(() => {
      workspaceTabs.splitTab('chat', fileId, 'left')
    })
    act(() => {
      workspaceTabs.setSplitRatio(0.6)
    })
    file = screen.getByRole('tab', { name: 'demo.ts' })
    chat = screen.getByRole('tab', { name: '项目聊天' })
    const unit = file.closest('[data-split-group]')
    expect(unit).not.toBeNull()
    expect(chat.closest('[data-tab-unit]')).toBe(unit)
    expect(unit!.querySelectorAll('[role="tab"]')).toHaveLength(2)
    mocks.selectFile.mockClear()
    mocks.selectSession.mockClear()
    fireEvent.click(file)
    expect(workspaceTabs.focusedTabId).toBe(fileId)
    expect(file.getAttribute('aria-selected')).toBe('true')
    expect(mocks.view).toBe('conversation')
    expect(mocks.selectFile).not.toHaveBeenCalled()
    fireEvent.click(chat)
    expect(workspaceTabs.focusedTabId).toBe('chat')
    expect(mocks.selectSession).not.toHaveBeenCalled()
    act(() => {
      expect(workspaceTabs.splitTab('第三个标签', fileId, 'right')).toBe(false)
      expect(workspaceTabs.splitTab('chat', '第三个标签', 'left')).toBe(false)
    })
    expect(workspaceTabs.splitGroups).toEqual([{ tabs: ['chat', fileId], ratio: 0.6 }])
    expect(workspaceTabs.focusedTabId).toBe('chat')
    act(() => {
      workspaceTabs.focus('第三个标签')
    })
    expect(workspaceTabs.split).toBeNull()
    expect(workspaceTabs.splitGroups).toEqual([{ tabs: ['chat', fileId], ratio: 0.6 }])
    act(() => {
      workspaceTabs.focus(fileId)
    })
    expect(workspaceTabs.split).toEqual(['chat', fileId])
    expect(workspaceTabs.splitRatio).toBe(0.6)
    expect(file.title).toContain('与「项目聊天」组成分屏组')
    act(() => {
      workspaceTabs.splitTab('第三个标签', '第四个标签', 'left')
    })
    act(() => {
      workspaceTabs.setSplitRatio(0.4)
    })
    expect(workspaceTabs.splitGroups).toHaveLength(2)
    act(() => {
      workspaceTabs.focus('chat')
    })
    expect(workspaceTabs.split).toEqual(['chat', fileId])
    expect(workspaceTabs.splitRatio).toBe(0.6)
    act(() => {
      workspaceTabs.merge()
    })
    expect(workspaceTabs.splitGroups).toEqual([{ tabs: ['第三个标签', '第四个标签'], ratio: 0.4 }])
    act(() => {
      workspaceTabs.focus('第四个标签')
      workspaceTabs.removeTab('第三个标签')
    })
    expect(workspaceTabs.splitGroups).toEqual([])
  })

  it('文件动作保留领域保护，拖动展示已有正文快照，取消后不改变标签', () => {
    const view = render(
      <>
        <Topbar visible />
        <section data-work-panel="file:project:src/demo.ts">
          <div data-preview-scroll>
            <p>预览中的真实文件内容</p>
          </div>
          <textarea defaultValue="原草稿" />
        </section>
      </>,
    )
    const pane = view.container.querySelector<HTMLElement>('[data-work-panel]')!
    vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 80,
      left: 0,
      top: 80,
      right: 800,
      bottom: 680,
      width: 800,
      height: 600,
      toJSON: () => ({}),
    })
    pane.querySelector<HTMLElement>('[data-preview-scroll]')!.scrollTop = 80
    pane.querySelector<HTMLElement>('[data-preview-scroll]')!.scrollLeft = 12
    pane.querySelector('textarea')!.value = '当前未发送草稿'
    act(() => {
      mocks.drag?.('file:project:src/demo.ts', 150, 70, 'detach')
    })
    expect(document.querySelector('.tab-drag-card')?.textContent).toContain('预览中的真实文件内容')
    expect(document.querySelector('.tab-drag-card')?.textContent).toContain('demo.ts')
    expect(document.querySelector('.tab-drag-snapshot [data-preview-scroll]')?.scrollTop).toBe(80)
    expect(document.querySelector('.tab-drag-snapshot [data-preview-scroll]')?.scrollLeft).toBe(12)
    expect(document.querySelector<HTMLTextAreaElement>('.tab-drag-snapshot textarea')?.value).toBe(
      '当前未发送草稿',
    )
    expect(document.body.dataset.workbenchDragging).toBe('true')
    act(() => {
      mocks.drag?.('file:project:src/demo.ts', 150, 70, 'cancel')
    })
    expect(document.querySelector('.tab-drag-card')).toBeNull()
    expect(document.body.dataset.workbenchDragging).toBeUndefined()
    expect(mocks.selectFile).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('tab', { name: 'demo.ts' }))
    fireEvent.doubleClick(screen.getByRole('tab', { name: 'demo.ts' }))
    fireEvent.click(screen.getByRole('button', { name: '关闭 src/demo.ts' }))
    expect(mocks.selectFile).toHaveBeenCalledWith('src/demo.ts')
    expect(mocks.pin).toHaveBeenCalledWith('src/demo.ts')
    expect(mocks.closeFile).toHaveBeenCalledWith('src/demo.ts')
    expect(mocks.closeSession).not.toHaveBeenCalled()
  })

  it('键盘删除只关闭当前聚焦的资源，不误关闭后台聊天', () => {
    render(<Topbar visible />)
    fireEvent.keyDown(screen.getByRole('tab', { name: 'demo.ts' }), { key: 'Delete' })
    expect(mocks.closeFile).toHaveBeenCalledWith('src/demo.ts')
    expect(mocks.closeSession).not.toHaveBeenCalled()
  })

  it('单标签自动隐藏顶栏条件与共享分组计算一致，并计入窗口级 SSH 标签', () => {
    const projects = [
      { id: 'p1', name: '项目甲' },
      { id: 'p2', name: '项目乙' },
    ]
    const empty = resolveWorkTabGroups([], projects, 'p1')
    expect(empty.activeGroup?.id).toBe('p1')
    expect(empty.groupTabs).toHaveLength(0)
    expect(shouldShowSessionTabs(false, empty.groupTabs.length)).toBe(false)
    expect(shouldShowSessionTabs(true, empty.groupTabs.length)).toBe(false)

    const single = resolveWorkTabGroups(
      [makeWorkTab({ id: 'c1', kind: 'session', projectId: 'p1', active: true })],
      projects,
      'p1',
    )
    expect(single.groupTabs).toHaveLength(1)
    expect(shouldShowSessionTabs(false, single.groupTabs.length)).toBe(false)
    expect(shouldShowSessionTabs(false, single.groupTabs)).toBe(false)
    expect(shouldShowSessionTabs(true, single.groupTabs)).toBe(false)

    const singleTerminal = resolveWorkTabGroups(
      [makeWorkTab({ id: 'terminal:a:1', kind: 'terminal', projectId: 'p1', active: true })],
      projects,
      'p1',
    )
    expect(shouldShowSessionTabs(false, singleTerminal.groupTabs)).toBe(true)
    expect(shouldShowSessionTabs(true, singleTerminal.groupTabs)).toBe(true)

    const singleBrowser = resolveWorkTabGroups(
      [makeWorkTab({ id: 'browser:b1', kind: 'browser', projectId: 'p1', active: true })],
      projects,
      'p1',
    )
    expect(shouldShowSessionTabs(false, singleBrowser.groupTabs)).toBe(true)
    expect(shouldShowSessionTabs(true, singleBrowser.groupTabs)).toBe(true)

    const withSsh = resolveWorkTabGroups(
      [
        makeWorkTab({ id: 'c1', kind: 'session', projectId: 'p1', active: true }),
        makeWorkTab({ id: 'ssh:prod', kind: 'ssh', projectId: 'unassigned' }),
      ],
      projects,
      'p1',
    )
    expect(withSsh.groupTabs).toHaveLength(2)
    expect(shouldShowSessionTabs(false, withSsh.groupTabs.length)).toBe(true)
    expect(shouldShowSessionTabs(true, withSsh.groupTabs.length)).toBe(true)
  })

  it('顶栏隐藏时渲染唯一 Liquid Glass 浮动操作胶囊，且打开平铺选择与新建菜单互不重复', () => {
    const view = render(<Topbar visible={false} />)
    const floating = document.querySelector<HTMLElement>('[data-floating-tab-actions="true"]')
    const header = document.querySelector<HTMLElement>('.session-chrome')
    expect(floating).not.toBeNull()
    expect(header?.getAttribute('aria-hidden')).toBe('true')
    expect(header?.querySelector('[aria-label="平铺选择标签"]')).toBeNull()
    expect(header?.querySelector('[aria-label="新建工作标签"]')).toBeNull()
    expect(screen.getAllByRole('button', { name: '平铺选择标签' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: '新建工作标签' })).toHaveLength(1)
    const floatingButtons = [...floating!.querySelectorAll<HTMLButtonElement>('button')].map(
      button => button.getAttribute('aria-label'),
    )
    expect(floatingButtons).toEqual(['新建工作标签', '平铺选择标签'])

    fireEvent.click(screen.getByRole('button', { name: '新建工作标签' }))
    expect(screen.getByRole('menu', { name: '新建工作标签' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '平铺选择标签' }))
    expect(screen.getByRole('textbox', { name: '搜索工作标签' })).toBeTruthy()

    view.rerender(<Topbar visible />)
    expect(document.querySelector('[data-floating-tab-actions="true"]')).toBeNull()
    expect(header?.querySelector('[aria-label="平铺选择标签"]')).not.toBeNull()
    expect(header?.querySelector('[aria-label="新建工作标签"]')).not.toBeNull()
    expect(screen.getAllByRole('button', { name: '平铺选择标签' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: '新建工作标签' })).toHaveLength(1)
  })

  it('Windows 多标签展开顶栏时仍将新建与平铺按钮保留在右侧浮动胶囊内，不与窗口控制按钮挤占顶栏', () => {
    const previousPlatform = document.documentElement.dataset.platform
    document.documentElement.dataset.platform = 'win32'
    try {
      const view = render(<Topbar visible={false} />)
      const header = document.querySelector<HTMLElement>('.session-chrome')
      expect(document.querySelector('[data-floating-tab-actions="true"]')).not.toBeNull()
      expect(header?.querySelector('[aria-label="平铺选择标签"]')).toBeNull()
      expect(header?.querySelector('[aria-label="新建工作标签"]')).toBeNull()

      view.rerender(<Topbar visible />)
      const floating = document.querySelector<HTMLElement>('[data-floating-tab-actions="true"]')
      expect(floating).not.toBeNull()
      expect(header?.getAttribute('aria-hidden')).toBe('false')
      expect(header?.querySelector('[aria-label="平铺选择标签"]')).toBeNull()
      expect(header?.querySelector('[aria-label="新建工作标签"]')).toBeNull()
      expect(floating?.querySelector('[aria-label="新建工作标签"]')).not.toBeNull()
      expect(floating?.querySelector('[aria-label="平铺选择标签"]')).not.toBeNull()
      expect(screen.getAllByRole('button', { name: '平铺选择标签' })).toHaveLength(1)
      expect(screen.getAllByRole('button', { name: '新建工作标签' })).toHaveLength(1)
    } finally {
      if (previousPlatform === undefined) delete document.documentElement.dataset.platform
      else document.documentElement.dataset.platform = previousPlatform
    }
  })

  it('ConversationFrame 仅在 overlayComposer 对话框架内渲染单层顶部渐进遮罩', () => {
    const view = render(
      <ConversationFrame width={null} onWidthChange={undefined} overlayComposer>
        <div>对话正文</div>
      </ConversationFrame>,
    )
    const blur = document.querySelector<HTMLElement>('[data-top-progressive-blur="true"]')
    expect(blur).not.toBeNull()
    expect(blur?.getAttribute('aria-hidden')).toBe('true')
    expect(blur?.children).toHaveLength(0)

    view.rerender(
      <ConversationFrame width={null} onWidthChange={undefined} overlayComposer={false}>
        <div>非对话内容</div>
      </ConversationFrame>,
    )
    expect(document.querySelector('[data-top-progressive-blur="true"]')).toBeNull()
  })

  it('全部项目模式下新建浏览器归入当前活跃项目分组，且 replaceSplitTab 支持原位替换分屏成员', () => {
    mocks.allProjectsMode = true
    mocks.view = 'conversation'
    let workspaceTabs!: NonNullable<ReturnType<typeof useWorkspaceTabs>>
    function Harness() {
      workspaceTabs = useWorkspaceTabs()!
      return <Topbar visible />
    }
    render(
      <WorkspaceTabsProvider>
        <Harness />
      </WorkspaceTabsProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: '新建工作标签' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '新浏览器' }))
    expect(workspaceTabs.browserTabs).toHaveLength(1)
    expect(workspaceTabs.browserTabs[0]?.projectId).toBe('project')

    act(() => {
      expect(workspaceTabs.splitTab('session-b', 'session-a', 'right')).toBe(true)
      expect(workspaceTabs.replaceSplitTab('session-b', 'session-c')).toBe(true)
    })
    expect(workspaceTabs.splitGroups[0]?.tabs).toEqual(['session-a', 'session-c'])
    expect(workspaceTabs.focusedTabId).toBe('session-c')
  })
})
