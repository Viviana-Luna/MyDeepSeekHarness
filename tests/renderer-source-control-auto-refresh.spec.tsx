/**
 * 渲染进程 Git 自动刷新测试：验证外部事件流、窗口聚焦节流、切入变更视图、
 * 写操作期间延后刷新、无变化去重以及显式手动刷新按钮。
 */
// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SourceControlProvider,
  useSourceControl,
} from '../src/renderer/src/features/source-control/SourceControlProvider.tsx'
import { SourceControlSections } from '../src/renderer/src/features/source-control/SourceControlSections.tsx'

const mockState = vi.hoisted(() => ({
  snapshot: {
    activeView: 'chat',
    selectedProjectId: 'proj-ui',
    selectedSessionId: null as string | null,
    projects: [{ id: 'proj-ui', cwd: '/repo', projectAccessId: 'proj-access-1' }],
    sessions: [] as { sessionId: string; cwd: string }[],
    sessionModels: null,
  },
  store: {
    callProject: vi.fn(),
    setView: vi.fn(),
  },
}))

vi.mock('../src/renderer/src/hooks/useWorkspace.ts', () => ({
  useWorkspaceSnapshot: () => mockState.snapshot,
  useWorkspaceStore: () => mockState.store,
}))

vi.mock('../src/renderer/src/features/source-control/useGitAiFlow.ts', () => ({
  useGitAiFlow: () => ({
    phase: 'normal',
    running: false,
    scope: { staged: false, working: false, untracked: false },
    enter: vi.fn(),
    release: vi.fn(),
  }),
}))

const summaryFixture = (
  revision: string,
  files: Array<{ relativePath: string; workingTreeStatus?: string; staged?: boolean }> = [],
) => ({
  available: true,
  branch: 'master',
  upstream: 'origin/master',
  ahead: 0,
  behind: 0,
  statusRevision: revision,
  additions: files.length,
  deletions: 0,
  files: files.map(file => ({
    relativePath: file.relativePath,
    indexStatus: file.staged ? 'M' : '.',
    workingTreeStatus: file.workingTreeStatus ?? 'M',
    staged: file.staged ?? false,
    conflict: false,
    additions: 1,
    deletions: 0,
    binary: false,
    workingAdditions: 1,
    workingDeletions: 0,
    workingBinary: false,
    stagedAdditions: 0,
    stagedDeletions: 0,
    stagedBinary: false,
  })),
})

const graphFixture = (hash: string, subject: string) => [
  {
    hash,
    shortHash: hash.slice(0, 7),
    parents: [],
    decorations: ['HEAD -> master'],
    author: 'Tester',
    time: 1_700_000_000_000,
    subject,
  },
]

function Probe() {
  const scm = useSourceControl()
  return (
    <div>
      <span data-testid="loading">{String(scm.loading)}</span>
      <span data-testid="revision">{String(scm.gitRevision)}</span>
      <span data-testid="files">{scm.gitSummary?.files.map(f => f.relativePath).join(',')}</span>
      <span data-testid="head">{scm.gitGraph[0]?.subject ?? ''}</span>
      <span data-testid="diff">{scm.selectedDiff?.relativePath ?? 'none'}</span>
      <span data-testid="error">{scm.error ?? 'none'}</span>
      <button
        type="button"
        onClick={() => {
          void scm.openDiff('src/app.ts', 'working')
        }}
      >
        打开差异
      </button>
      <button
        type="button"
        onClick={() => {
          void scm.stageChanges(['src/app.ts'])
        }}
      >
        执行暂存
      </button>
      <SourceControlSections>
        <div>内容</div>
      </SourceControlSections>
    </div>
  )
}

let projectEventListener: ((event: unknown) => void) | null = null

beforeEach(() => {
  projectEventListener = null
  mockState.snapshot = {
    activeView: 'chat',
    selectedProjectId: 'proj-ui',
    selectedSessionId: null,
    projects: [{ id: 'proj-ui', cwd: '/repo', projectAccessId: 'proj-access-1' }],
    sessions: [],
    sessionModels: null,
  }
  mockState.store.callProject.mockReset()
  mockState.store.setView.mockReset()
  window.dshDesktop = {
    version: 22,
    projects: {
      list: vi.fn(),
      call: vi.fn(),
      onEvent: vi.fn((listener: (event: unknown) => void) => {
        projectEventListener = listener
        return () => {
          if (projectEventListener === listener) projectEventListener = null
        }
      }),
    },
  } as unknown as NonNullable<Window['dshDesktop']>
})

afterEach(() => {
  cleanup()
  delete window.dshDesktop
  vi.restoreAllMocks()
})

describe('SourceControlProvider 自动刷新与手动刷新入口', () => {
  it('收到外部提交事件后静默更新摘要与提交图、清理已提交文件的 Diff，且不闪烁 loading', async () => {
    let currentSummary = summaryFixture('rev-1', [{ relativePath: 'src/app.ts' }])
    let currentGraph = graphFixture('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '初始提交')
    mockState.store.callProject.mockImplementation(async (operation: string) => {
      if (operation === 'gitSummary') return currentSummary
      if (operation === 'gitGraph') return currentGraph
      if (operation === 'gitDiff') {
        return {
          relativePath: 'src/app.ts',
          mode: 'working',
          patch: '@@ -1 +1 @@\n-old\n+new\n',
          truncated: false,
          presentation: 'text',
        }
      }
      return null
    })

    render(
      <SourceControlProvider>
        <Probe />
      </SourceControlProvider>,
    )

    await waitFor(() => expect(screen.getByTestId('files').textContent).toBe('src/app.ts'))
    expect(screen.getByTestId('head').textContent).toBe('初始提交')

    // 打开 src/app.ts 的工作区 Diff。
    fireEvent.click(screen.getByRole('button', { name: '打开差异' }))
    await waitFor(() => expect(screen.getByTestId('diff').textContent).toBe('src/app.ts'))

    // 模拟外部软件提交了 src/app.ts，并由 Runtime 推送 refs 变更事件。
    currentSummary = summaryFixture('rev-2', [])
    currentGraph = graphFixture('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '外部软件提交')
    act(() => {
      projectEventListener?.({
        type: 'git-changed',
        projectId: 'proj-access-1',
        scope: 'refs',
        reason: 'watcher',
        timestamp: Date.now(),
      })
    })

    await waitFor(() => expect(screen.getByTestId('head').textContent).toBe('外部软件提交'))
    expect(screen.getByTestId('files').textContent).toBe('')
    expect(screen.getByTestId('diff').textContent).toBe('none')
    expect(screen.getByTestId('loading').textContent).toBe('false')
    expect(Number(screen.getByTestId('revision').textContent)).toBeGreaterThan(0)

    // 工具栏显式刷新按钮可直接触发手动刷新。
    const beforeCalls = mockState.store.callProject.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: '刷新 Git 状态' }))
    await waitFor(() =>
      expect(mockState.store.callProject.mock.calls.length).toBeGreaterThan(beforeCalls),
    )
  })

  it('窗口重新聚焦与切入变更视图触发自动刷新，并对高频聚焦做节流；写操作期间自动延后', async () => {
    let currentSummary = summaryFixture('rev-1', [{ relativePath: 'src/app.ts' }])
    const currentGraph = graphFixture('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '初始提交')
    let finishStage!: (value: unknown) => void
    mockState.store.callProject.mockImplementation((operation: string) => {
      if (operation === 'gitSummary') return Promise.resolve(currentSummary)
      if (operation === 'gitGraph') return Promise.resolve(currentGraph)
      if (operation === 'gitStage') {
        return new Promise(resolve => {
          finishStage = resolve
        })
      }
      return Promise.resolve(null)
    })

    const view = render(
      <SourceControlProvider>
        <Probe />
      </SourceControlProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('files').textContent).toBe('src/app.ts'))

    // 窗口聚焦触发刷新，并在 1 秒内抑制重复聚焦风暴。
    currentSummary = summaryFixture('rev-2', [{ relativePath: 'src/focused.ts' }])
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(screen.getByTestId('files').textContent).toBe('src/focused.ts'))
    const callsAfterFocus = mockState.store.callProject.mock.calls.length
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(mockState.store.callProject.mock.calls.length).toBe(callsAfterFocus)

    // 从 chat 模式切换到 changes 模式时自动校对状态。
    currentSummary = summaryFixture('rev-3', [{ relativePath: 'src/view-switch.ts' }])
    mockState.snapshot = { ...mockState.snapshot, activeView: 'changes' }
    view.rerender(
      <SourceControlProvider>
        <Probe />
      </SourceControlProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('files').textContent).toBe('src/view-switch.ts'))

    // 写操作期间收到外部事件应延后执行，待写操作完成后自动冲刷。
    fireEvent.click(screen.getByRole('button', { name: '执行暂存' }))
    const callsDuringStage = mockState.store.callProject.mock.calls.length
    currentSummary = summaryFixture('rev-4', [{ relativePath: 'src/after-stage.ts' }])
    act(() => {
      projectEventListener?.({
        type: 'git-changed',
        projectId: 'proj-access-1',
        scope: 'working',
        reason: 'watcher',
        timestamp: Date.now(),
      })
    })
    expect(mockState.store.callProject.mock.calls.length).toBe(callsDuringStage)

    await act(async () => {
      finishStage(summaryFixture('rev-stage', [{ relativePath: 'src/app.ts', staged: true }]))
    })
    await waitFor(() => expect(screen.getByTestId('files').textContent).toBe('src/after-stage.ts'))
  })
})
