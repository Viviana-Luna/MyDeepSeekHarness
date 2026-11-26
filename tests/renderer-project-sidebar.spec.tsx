// @vitest-environment jsdom

import {
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProjectSessionNavigation } from '../src/renderer/src/pages/workspace/components/leftpanel/chat-leftpanel/index.tsx'
import type { ProjectSummary } from '../src/renderer/src/domain/project.ts'
import type { SessionSummary } from '../src/renderer/src/domain/session.ts'

const projects: readonly ProjectSummary[] = [
  {
    source: 'legacy',
    id: 'project-a',
    name: '甲项目',
    cwd: '/work/a',
    displayPath: '/work/a',
    sessionCount: 2,
    lastActivity: 300,
  },
  {
    source: 'legacy',
    id: 'project-b',
    name: '乙项目',
    cwd: '/work/b',
    displayPath: '/work/b',
    sessionCount: 1,
    lastActivity: 200,
  },
]

const sessions: readonly SessionSummary[] = [
  {
    sessionId: 'a-1',
    title: '甲项目当前会话',
    cwd: '/work/a',
    updatedAt: 300,
    running: false,
    blank: false,
  },
  {
    sessionId: 'a-2',
    title: '甲项目历史会话',
    cwd: '/work/a',
    updatedAt: 250,
    running: false,
    blank: false,
  },
  {
    sessionId: 'b-1',
    title: '乙项目会话',
    cwd: '/work/b',
    updatedAt: 200,
    running: false,
    blank: false,
  },
]

const durableProjects: readonly ProjectSummary[] = [
  {
    source: 'workspace',
    projectAccessId: 'trusted-a',
    workspaceId: 'workspace-a',
    sessionIds: ['a-1', 'a-2'],
    id: 'project-a',
    name: '甲项目',
    cwd: '/work/a',
    displayPath: '/work/a',
    sessionCount: 2,
    lastActivity: 300,
  },
  {
    source: 'workspace',
    projectAccessId: 'trusted-b',
    workspaceId: 'workspace-b',
    sessionIds: ['b-1'],
    id: 'project-b',
    name: '乙项目',
    cwd: '/work/b',
    displayPath: '/work/b',
    sessionCount: 1,
    lastActivity: 200,
  },
]

afterEach(cleanup)

function projectToggle(projectId: string): HTMLButtonElement {
  const button = document.querySelector(`[data-project-toggle="${projectId}"]`)
  if (!(button instanceof HTMLButtonElement)) throw new Error(`找不到项目折叠按钮：${projectId}`)
  return button
}

describe('项目与会话树', () => {
  it('选中空白会话时进入项目但不把它显示为历史项', async () => {
    const blankSession: SessionSummary = {
      sessionId: 'a-blank',
      title: '新会话',
      cwd: '/work/a',
      updatedAt: 400,
      running: false,
      blank: true,
    }
    render(
      <ProjectSessionNavigation
        projects={[{ ...projects[0]!, sessionCount: 3 }]}
        sessions={[blankSession, ...sessions.slice(0, 2)]}
        selectedProjectId="project-a"
        selectedSessionId="a-blank"
        initialized
        loadingSessions={false}
        onSelectSession={() => {}}
      />,
    )

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '会话' })).toBeTruthy()
    })
    expect(screen.queryByRole('button', { name: /新会话/u })).toBeNull()
    expect(
      screen.getByRole('group', { name: '甲项目的会话' }).querySelectorAll('.session-row'),
    ).toHaveLength(2)
    expect(screen.getByRole('button', { name: /甲项目当前会话/u })).toBeTruthy()
  })

  it('把新增项目和新建聊天放到项目区，并把拖动顺序交给 Durable Workspace', () => {
    const createWorkspace = vi.fn()
    const createSession = vi.fn()
    const reorderWorkspace = vi.fn()
    const reorderSession = vi.fn()
    const revealProject = vi.fn()
    render(
      <ProjectSessionNavigation
        projects={durableProjects}
        sessions={sessions}
        selectedProjectId={null}
        selectedSessionId={null}
        initialized
        loadingSessions={false}
        workspaceCapability="available"
        onSelectSession={() => {}}
        onCreateWorkspace={createWorkspace}
        onCreateSessionForProject={createSession}
        onReorderWorkspace={reorderWorkspace}
        onReorderSession={reorderSession}
        onRevealProject={revealProject}
      />,
    )

    expect(screen.queryByRole('button', { name: /^新建聊天$/u })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '添加项目' }))
    fireEvent.click(screen.getByRole('button', { name: '在甲项目中新建聊天' }))
    expect(createWorkspace).toHaveBeenCalledTimes(1)
    expect(createSession).toHaveBeenCalledWith('project-a')

    const first = document.querySelector('[data-project-group="project-a"]')
    const second = document.querySelector('[data-project-group="project-b"]')
    if (!(first instanceof HTMLElement) || !(second instanceof HTMLElement)) {
      throw new Error('项目拖动测试缺少项目行')
    }
    const firstDragHandle = first.querySelector('.project-group-heading')
    const secondDragHandle = second.querySelector('.project-group-heading')
    if (!(firstDragHandle instanceof HTMLElement) || !(secondDragHandle instanceof HTMLElement)) {
      throw new Error('项目拖动测试缺少项目标题行')
    }
    expect(first.getAttribute('draggable')).toBeNull()
    expect(secondDragHandle.getAttribute('draggable')).toBe('true')
    Object.defineProperty(first, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        top: 0,
        bottom: 32,
        left: 0,
        right: 220,
        width: 220,
        height: 32,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    })
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn() }
    fireEvent.dragStart(secondDragHandle, { dataTransfer })
    fireEvent.dragOver(first, { dataTransfer, clientY: 4 })
    expect(first.classList.contains('is-drop-before')).toBe(true)
    const bottomProjectDragOver = createEvent.dragOver(first, { dataTransfer })
    Object.defineProperty(bottomProjectDragOver, 'clientY', { value: 28 })
    fireEvent(first, bottomProjectDragOver)
    expect(first.classList.contains('is-drop-after')).toBe(true)
    fireEvent.dragOver(first, { dataTransfer, clientY: 4 })
    expect(first.classList.contains('is-drop-before')).toBe(true)
    fireEvent.drop(first, { dataTransfer, clientY: 4 })
    expect(reorderWorkspace).toHaveBeenCalledWith('project-b', 'project-a')
    expect(first.classList.contains('is-drop-before')).toBe(false)

    fireEvent.click(projectToggle('project-a'))
    const firstSession = document.querySelector('.session-row-shell[data-session-id="a-1"]')
    const secondSession = document.querySelector('.session-row-shell[data-session-id="a-2"]')
    if (!(firstSession instanceof HTMLElement) || !(secondSession instanceof HTMLElement)) {
      throw new Error('会话拖动测试缺少会话行')
    }
    Object.defineProperty(firstSession, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        top: 0,
        bottom: 34,
        left: 0,
        right: 220,
        width: 220,
        height: 34,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    })
    fireEvent.dragStart(secondSession, { dataTransfer })
    fireEvent.dragOver(firstSession, { dataTransfer, clientY: 4 })
    expect(firstSession.classList.contains('is-drop-before')).toBe(true)
    fireEvent.drop(firstSession, { dataTransfer, clientY: 4 })
    expect(reorderSession).toHaveBeenCalledWith('project-a', 'a-2', 'a-1')
    expect(firstSession.classList.contains('is-drop-before')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: '甲项目更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '在 Finder 中显示' }))
    expect(revealProject).toHaveBeenCalledWith('project-a')
  })

  it('没有当前会话时所有 Project 默认收起', () => {
    render(
      <ProjectSessionNavigation
        projects={projects}
        sessions={sessions}
        selectedProjectId={null}
        selectedSessionId={null}
        initialized
        loadingSessions={false}
        onSelectSession={() => {}}
      />,
    )

    expect(projectToggle('project-a').getAttribute('aria-expanded')).toBe('false')
    expect(projectToggle('project-b').getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: /甲项目当前会话/u })).toBeNull()
    expect(screen.queryByRole('button', { name: /乙项目会话/u })).toBeNull()
  })

  it('默认只展开当前会话所属 Project，其他 Project 保持收起', async () => {
    const selectSession = vi.fn()
    render(
      <ProjectSessionNavigation
        projects={projects}
        sessions={sessions}
        selectedProjectId={null}
        selectedSessionId="a-1"
        initialized
        loadingSessions={false}
        onSelectSession={selectSession}
      />,
    )

    const projectA = projectToggle('project-a')
    const projectB = projectToggle('project-b')
    await waitFor(() => {
      expect(projectA.getAttribute('aria-expanded')).toBe('true')
    })
    expect(projectB.getAttribute('aria-expanded')).toBe('false')
    expect(document.getElementById(projectA.getAttribute('aria-controls') ?? '')).toBeTruthy()
    expect(document.getElementById(projectB.getAttribute('aria-controls') ?? '')?.hidden).toBe(true)
    expect(screen.getByRole('button', { name: /甲项目当前会话/u })).toBeTruthy()

    fireEvent.click(projectA)
    expect(projectA.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: /甲项目当前会话/u })).toBeNull()

    fireEvent.click(projectA)
    fireEvent.click(screen.getByRole('button', { name: /甲项目当前会话/u }))
    expect(selectSession).toHaveBeenCalledWith('a-1')

    fireEvent.click(projectB)
    expect(projectA.getAttribute('aria-expanded')).toBe('true')
    expect(projectB.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: /乙项目会话/u })).toBeTruthy()

    fireEvent.click(projectA)
    expect(projectA.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: /甲项目当前会话/u })).toBeNull()
  })

  it('搜索或其他入口切换会话后自动展开其所属 Project', async () => {
    const view = render(
      <ProjectSessionNavigation
        projects={projects}
        sessions={sessions}
        selectedProjectId={null}
        selectedSessionId="a-1"
        initialized
        loadingSessions={false}
        onSelectSession={() => {}}
      />,
    )

    await waitFor(() => {
      expect(projectToggle('project-a').getAttribute('aria-expanded')).toBe('true')
      expect(projectToggle('project-b').getAttribute('aria-expanded')).toBe('false')
    })
    view.rerender(
      <ProjectSessionNavigation
        projects={projects}
        sessions={sessions}
        selectedProjectId={null}
        selectedSessionId="b-1"
        initialized
        loadingSessions={false}
        onSelectSession={() => {}}
      />,
    )

    await waitFor(() => {
      expect(projectToggle('project-b').getAttribute('aria-expanded')).toBe('true')
    })
    expect(screen.getByRole('button', { name: /乙项目会话/u })).toBeTruthy()
  })

  it('进入专注项目时直接展示会话，不再重复项目层级', async () => {
    const view = render(
      <ProjectSessionNavigation
        projects={projects}
        sessions={sessions}
        selectedProjectId={null}
        selectedSessionId="a-1"
        initialized
        loadingSessions={false}
        onSelectSession={() => {}}
      />,
    )

    view.rerender(
      <ProjectSessionNavigation
        projects={projects.slice(0, 1)}
        sessions={sessions}
        selectedProjectId="project-a"
        selectedSessionId="a-1"
        initialized
        loadingSessions={false}
        onSelectSession={() => {}}
      />,
    )

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '会话' })).toBeTruthy()
    })
    expect(document.querySelector('[data-project-toggle="project-a"]')).toBeNull()
    expect(screen.getByRole('button', { name: /甲项目当前会话/u })).toBeTruthy()
    expect(screen.getByRole('group', { name: '甲项目的会话' }).hasAttribute('hidden')).toBe(false)
  })

  it('会话动作区支持本地置顶和真实归档，点击动作不会误选会话', async () => {
    const selectSession = vi.fn()
    const togglePinnedSession = vi.fn()
    const archiveSession = vi.fn()
    const renameSession = vi.fn(async () => true)
    const forkSession = vi.fn(async () => true)
    render(
      <ProjectSessionNavigation
        projects={projects}
        sessions={sessions}
        selectedProjectId={null}
        selectedSessionId="a-1"
        initialized
        loadingSessions={false}
        pinnedSessionIds={[]}
        archiveCapability="available"
        archivingSessionIds={[]}
        onSelectSession={selectSession}
        onTogglePinnedSession={togglePinnedSession}
        onArchiveSession={archiveSession}
        onRenameSession={renameSession}
        onForkSession={forkSession}
      />,
    )

    const actions = await screen.findByRole('group', { name: '甲项目当前会话的会话操作' })
    const pin = within(actions).getByRole('button', { name: '置顶聊天' })
    expect((pin as HTMLButtonElement).disabled).toBe(false)
    expect(pin.getAttribute('title')).toBe('置顶聊天（仅在此设备显示）')

    fireEvent.click(pin)
    expect(togglePinnedSession).toHaveBeenCalledWith('a-1')
    expect(selectSession).not.toHaveBeenCalled()

    fireEvent.click(within(actions).getByRole('button', { name: '归档聊天' }))
    expect(archiveSession).toHaveBeenCalledWith('a-1')
    expect(selectSession).not.toHaveBeenCalled()

    fireEvent.click(within(actions).getByRole('button', { name: '更多聊天操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '重命名聊天' }))
    const titleInput = screen.getByRole('textbox', { name: '聊天名称' })
    fireEvent.change(titleInput, { target: { value: '新的聊天标题' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(renameSession).toHaveBeenCalledWith('a-1', '新的聊天标题')
    })

    fireEvent.click(within(actions).getByRole('button', { name: '更多聊天操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '分叉聊天' }))
    expect(forkSession).toHaveBeenCalledWith('a-1')
    expect(selectSession).not.toHaveBeenCalled()
  })

  it('置顶聊天移入顶部独立分区且不在原 Project 重复，取消后交还本地状态', async () => {
    const selectSession = vi.fn()
    const togglePinnedSession = vi.fn()
    render(
      <ProjectSessionNavigation
        projects={projects}
        sessions={sessions}
        selectedProjectId={null}
        selectedSessionId="a-1"
        initialized
        loadingSessions={false}
        pinnedSessionIds={['a-1']}
        archiveCapability="available"
        onSelectSession={selectSession}
        onTogglePinnedSession={togglePinnedSession}
      />,
    )

    expect(screen.getByRole('heading', { name: '置顶' })).toBeTruthy()
    const pinnedGroup = screen.getByRole('group', { name: '置顶聊天' })
    expect(within(pinnedGroup).getByRole('button', { name: /甲项目当前会话/u })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /甲项目当前会话/u })).toHaveLength(1)

    const actions = within(pinnedGroup).getByRole('group', { name: '甲项目当前会话的会话操作' })
    const unpin = within(actions).getByRole('button', { name: '取消置顶聊天' })
    expect(unpin.getAttribute('title')).toBe('取消置顶')
    fireEvent.click(unpin)
    expect(togglePinnedSession).toHaveBeenCalledWith('a-1')
    expect(selectSession).not.toHaveBeenCalled()
  })

  it('专注 Project 时只显示该 Project 的置顶聊天', async () => {
    render(
      <ProjectSessionNavigation
        projects={projects.slice(1)}
        sessions={sessions}
        selectedProjectId="project-b"
        selectedSessionId="b-1"
        initialized
        loadingSessions={false}
        pinnedSessionIds={['a-1', 'b-1']}
        onSelectSession={() => {}}
      />,
    )

    const pinnedGroup = await screen.findByRole('group', { name: '置顶聊天' })
    expect(within(pinnedGroup).queryByRole('button', { name: /甲项目当前会话/u })).toBeNull()
    expect(within(pinnedGroup).getByRole('button', { name: /乙项目会话/u })).toBeTruthy()
  })

  it('归档能力未确认或正在执行时禁用动作并说明原因', async () => {
    const view = render(
      <ProjectSessionNavigation
        projects={projects}
        sessions={sessions}
        selectedProjectId={null}
        selectedSessionId="a-1"
        initialized
        loadingSessions={false}
        archiveCapability="checking"
        onSelectSession={() => {}}
      />,
    )
    const actions = await screen.findByRole('group', { name: '甲项目当前会话的会话操作' })
    const checking = within(actions).getByRole('button', { name: '归档聊天' })
    expect((checking as HTMLButtonElement).disabled).toBe(true)
    expect(checking.parentElement?.getAttribute('title')).toBe('正在确认归档能力')

    view.rerender(
      <ProjectSessionNavigation
        projects={projects}
        sessions={sessions}
        selectedProjectId={null}
        selectedSessionId="a-1"
        initialized
        loadingSessions={false}
        archiveCapability="available"
        archivingSessionIds={['a-1']}
        onSelectSession={() => {}}
      />,
    )
    const archiving = within(actions).getByRole('button', { name: '正在归档聊天' })
    expect((archiving as HTMLButtonElement).disabled).toBe(true)
    expect(archiving.parentElement?.getAttribute('title')).toBe('正在归档聊天')
  })
})
