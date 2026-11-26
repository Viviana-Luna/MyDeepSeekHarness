// @vitest-environment jsdom
/** renderer 左栏实际组件测试：保留手动草稿、混合文件解套和二次明确确认。 */
import { useSyncExternalStore } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GitAiFlowController,
  type GitAiFlowOptions,
} from '../src/renderer/src/features/source-control/git-ai-flow.ts'
import { ChangesLeftPanel } from '../src/renderer/src/features/source-control/ChangesLeftPanel.tsx'

const state = vi.hoisted(() => ({ workspace: {} as Record<string, unknown> }))
vi.mock('../src/renderer/src/features/source-control/SourceControlProvider.tsx', () => ({
  useSourceControl: () => state.workspace,
}))
const controllers: GitAiFlowController[] = []
afterEach(() => {
  cleanup()
  for (const controller of controllers.splice(0)) controller.dispose()
})

const models = {
  default: { provider: 'test', model: 'model' },
  current: { provider: 'test', model: 'model' },
  routable: true,
  routableProviders: ['test'],
  groups: [{ id: 'test', name: '测试提供方', models: [{ id: 'model', name: '测试模型' }] }],
  failures: [],
}
const item = { id: 'a'.repeat(64), relativePath: 'a.txt', mode: 'working', requiresWholeFile: true }

function Harness({ controller }: { controller: GitAiFlowController }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.snapshot)
  state.workspace = {
    gitGraph: [],
    selectedCommit: null,
    selectedDiff: null,
    gitMutation: snapshot.running ? 'commit' : null,
    gitSummary: {
      available: true,
      branch: 'main',
      additions: 1,
      deletions: 1,
      files: [
        {
          relativePath: 'a.txt',
          indexStatus: '.',
          workingTreeStatus: 'M',
          conflict: false,
          workingAdditions: 1,
          workingDeletions: 1,
        },
      ],
    },
    refresh: vi.fn(),
    commitStaged: vi.fn(),
    openDiff: vi.fn(),
    openCommit: vi.fn(),
    ai: {
      ...snapshot,
      enter: controller.enter,
      release: controller.release,
      analyze: controller.analyze,
      execute: controller.execute,
      openFile: controller.openFile,
      setPlan: controller.setPlan,
      setScope: controller.setScope,
      setModel: controller.setModel,
      setWholeFileIds: controller.setWholeFileIds,
    },
  }
  return <ChangesLeftPanel />
}

function fixture() {
  const call = vi.fn<GitAiFlowOptions['call']>(async operation => {
    if (operation === 'gitAiAnalyze')
      return { id: 'test', items: [item], excluded: [], plan: { batches: [], deferred: [item.id] } }
    if (operation === 'gitAiExecute')
      return {
        completed: [{ itemIds: [item.id], message: '更新', commitHash: '1'.repeat(40) }],
        error: null,
        stale: false,
      }
    return {}
  })
  const controller = new GitAiFlowController({
    call,
    models,
    catalog: async () => models,
    openDiff: vi.fn(),
    refresh: async () => {},
  })
  controllers.push(controller)
  render(<Harness controller={controller} />)
  return { call, controller }
}

describe('AI 提交左栏', () => {
  it('轻量入口不发送代码，准备保留文件列表，退出保留手动草稿并归还焦点', async () => {
    const { call } = fixture()
    fireEvent.change(screen.getByLabelText('提交消息'), { target: { value: '我的手动草稿' } })
    fireEvent.click(screen.getByRole('button', { name: 'AI 提交' }))
    await screen.findByLabelText('AI 提交模型')
    expect(call).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '查看 a.txt 的工作区 Git Diff' })).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.keyDown(screen.getByRole('region', { name: 'AI 提交准备' }), { key: 'Escape' })
    await waitFor(() =>
      expect((screen.getByLabelText('提交消息') as HTMLTextAreaElement).value).toBe('我的手动草稿'),
    )
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'AI 提交' })),
    )
  })

  it('混合文件必须明确整文件确认，消息非空且再次确认后才执行', async () => {
    const { call } = fixture()
    fireEvent.click(screen.getByRole('button', { name: 'AI 提交' }))
    fireEvent.click(await screen.findByRole('button', { name: '开始分析' }))
    await screen.findByRole('region', { name: 'AI 提交方案' })
    expect(call.mock.calls.find(([operation]) => operation === 'gitAiAnalyze')?.[1]).toMatchObject({
      scope: { staged: false, working: true, untracked: false },
      provider: 'test',
      model: 'model',
      confirmed: true,
    })
    fireEvent.click(screen.getByRole('button', { name: '调整 a.txt' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '拆为独立新批次' }))
    fireEvent.change(screen.getByLabelText('批次 1 提交消息'), { target: { value: '更新文件' } })
    expect(
      (screen.getByRole('button', { name: '按序提交 1 批' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '调整 a.txt' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '确认此整文件版本一并提交' }))
    fireEvent.click(screen.getByRole('button', { name: '按序提交 1 批' }))
    expect(call.mock.calls.some(([operation]) => operation === 'gitAiExecute')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '确认创建本地提交' }))
    await screen.findByRole('button', { name: '完成' })
    expect(call.mock.calls.find(([operation]) => operation === 'gitAiExecute')?.[1]).toMatchObject({
      wholeFileIds: [item.id],
      confirmed: true,
    })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
