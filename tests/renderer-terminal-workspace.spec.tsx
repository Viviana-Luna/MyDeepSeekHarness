// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  snapshot: {
    projects: [
      { id: '界面项目-1', projectAccessId: '项目-1', name: '甲项目' },
      { id: '界面项目-2', projectAccessId: '项目-2', name: '乙项目' },
    ],
    selectedProjectId: '界面项目-1',
  },
  launchRequest: null as null | {
    key: number
    projectId: string
    projectName: string
    taskId: string
    name: string
    allowConcurrent: boolean
  },
  consume: vi.fn(),
  captureIslandCollaborationIntent: vi.fn(() => ({
    sessionId: '会话-1',
    rightSelectionRevision: 0,
  })),
  presentIslandCollaboration: vi.fn(),
  selectProject: vi.fn(),
}))

vi.mock('../src/renderer/src/hooks/useWorkspace.ts', () => ({
  useWorkspaceSnapshot: () => fixture.snapshot,
  useWorkspaceStore: () => ({
    selectedProject: () =>
      fixture.snapshot.projects.find(project => project.id === fixture.snapshot.selectedProjectId),
    captureIslandCollaborationIntent: fixture.captureIslandCollaborationIntent,
    presentIslandCollaboration: fixture.presentIslandCollaboration,
    selectProject: fixture.selectProject,
  }),
}))

vi.mock('../src/renderer/src/features/project-tasks/ProjectTasksProvider.tsx', () => ({
  useProjectTasks: () => ({
    launchRequest: fixture.launchRequest,
    consumeLaunchRequest: fixture.consume,
  }),
}))

vi.mock('../src/renderer/src/features/terminal/TerminalView.tsx', () => ({
  TerminalView: ({
    projectId,
    visible,
    launchRequest,
    onOpenInMain,
  }: {
    projectId: string
    visible: boolean
    launchRequest: { key: number } | null
    onOpenInMain?: () => void
  }) => (
    <div
      data-testid={`终端组-${projectId}`}
      data-visible={String(visible)}
      data-request={launchRequest?.key ?? ''}
      hidden={!visible}
    >
      {onOpenInMain && <button onClick={onOpenInMain}>在主区打开终端</button>}
    </div>
  ),
}))

import { TerminalWorkspace } from '../src/renderer/src/features/terminal/TerminalWorkspace.tsx'

describe('当前项目终端工作台', () => {
  beforeEach(() => {
    fixture.snapshot.selectedProjectId = '界面项目-1'
    fixture.launchRequest = null
    fixture.consume.mockReset()
    fixture.presentIslandCollaboration.mockReset()
    fixture.selectProject.mockReset()
  })

  it('跟随当前项目切换，保留各自终端组，并把来源任务路由到对应组', async () => {
    const view = render(<TerminalWorkspace placement="main" visibility="foreground" />)
    await waitFor(() => {
      expect(screen.getByTestId('终端组-项目-1').dataset.visible).toBe('true')
    })
    const firstProjectGroup = screen.getByTestId('终端组-项目-1')
    expect(screen.queryByRole('tablist', { name: '终端项目' })).toBeNull()

    fixture.snapshot.selectedProjectId = '界面项目-2'
    view.rerender(<TerminalWorkspace placement="main" visibility="foreground" />)
    await waitFor(() => {
      expect(screen.getByTestId('终端组-项目-1')).toBeTruthy()
      expect(screen.getByTestId('终端组-项目-2').dataset.visible).toBe('true')
    })
    expect(screen.getByTestId('终端组-项目-1')).toBe(firstProjectGroup)

    fixture.snapshot.selectedProjectId = '界面项目-1'
    view.rerender(<TerminalWorkspace placement="main" visibility="foreground" />)
    expect(screen.getByTestId('终端组-项目-1').dataset.visible).toBe('true')
    expect(screen.getByTestId('终端组-项目-2').dataset.visible).toBe('false')
    expect(fixture.selectProject).not.toHaveBeenCalled()

    fixture.launchRequest = {
      key: 7,
      projectId: '项目-2',
      projectName: '乙项目',
      taskId: '任务-1',
      name: '运行任务',
      allowConcurrent: false,
    }
    view.rerender(<TerminalWorkspace placement="main" visibility="foreground" />)
    await waitFor(() => {
      expect(screen.getByTestId('终端组-项目-1').dataset.visible).toBe('true')
      expect(screen.getByTestId('终端组-项目-2').dataset.visible).toBe('false')
      expect(screen.getByTestId('终端组-项目-2').dataset.request).toBe('7')
    })

    view.rerender(<TerminalWorkspace placement="right" visibility="foreground" />)
    fireEvent.click(screen.getByRole('button', { name: '在主区打开终端' }))
    expect(fixture.presentIslandCollaboration).toHaveBeenCalledWith(
      { sessionId: '会话-1', rightSelectionRevision: 0 },
      'terminal',
      'main',
    )
  })
})
