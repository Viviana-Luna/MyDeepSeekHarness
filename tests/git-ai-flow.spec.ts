/** 验证 renderer 只在明确操作后发送、取消丢弃迟到方案与剩余批次重试。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GitAiFlowController,
  type GitAiFlowOptions,
} from '../src/renderer/src/features/source-control/git-ai-flow.ts'
import {
  moveGitAiItems,
  reorderGitAiBatch,
} from '../src/renderer/src/features/source-control/git-ai-edit.ts'
import { validateGitAiPayload } from '../src/shared/git-ai-validation.ts'

const controllers: GitAiFlowController[] = []
const analysis = {
  id: 'test-id',
  items: [
    { id: 'a', relativePath: 'a.txt', mode: 'working' as const, requiresWholeFile: false },
    { id: 'b', relativePath: 'b.txt', mode: 'working' as const, requiresWholeFile: false },
  ],
  plan: {
    batches: [
      { message: '第一批', itemIds: ['a'] },
      { message: '第二批', itemIds: ['b'] },
    ],
    deferred: [],
  },
  excluded: [],
}
const models = {
  default: { provider: 'test', model: 'model' },
  current: { provider: 'test', model: 'model' },
  routable: true,
  routableProviders: ['test'],
  groups: [{ id: 'test', name: '测试提供方', models: [{ id: 'model', name: '测试模型' }] }],
  failures: [],
}
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose()
})

function fixture(call: GitAiFlowOptions['call']) {
  const controller = new GitAiFlowController({
    call,
    catalog: async () => models,
    models,
    openDiff: vi.fn(),
    refresh: vi.fn(async () => {}),
  })
  controllers.push(controller)
  return { controller, call }
}

describe('AI 提交前端状态与边界', () => {
  it('进入准备不发送代码，取消后迟到方案不能恢复审阅态', async () => {
    let finish!: (value: unknown) => void
    const call = vi.fn<GitAiFlowOptions['call']>(async operation =>
      operation === 'gitAiAnalyze'
        ? new Promise(resolve => {
            finish = resolve
          })
        : {},
    )
    const { controller } = fixture(call)
    await controller.enter()
    expect(call).not.toHaveBeenCalled()
    const pending = controller.analyze()
    await Promise.resolve()
    await Promise.resolve()
    expect(controller.snapshot().analyzing).toBe(true)
    await controller.release(false)
    finish(analysis)
    await pending
    expect(controller.snapshot().phase).toBe('prepare')
    expect(controller.snapshot().analysis).toBeNull()
    expect(call.mock.calls[0]?.[1]).toMatchObject({
      provider: 'test',
      model: 'model',
      confirmed: true,
    })
  })

  it('重复执行被同步挡住，失败后重试只发送剩余批次', async () => {
    const completed = [{ ...analysis.plan.batches[0]!, commitHash: '1'.repeat(40) }]
    const call = vi.fn<GitAiFlowOptions['call']>(async operation =>
      operation === 'gitAiAnalyze' ? analysis : { completed, error: 'hook 拒绝', stale: false },
    )
    const { controller } = fixture(call)
    await controller.enter()
    await controller.analyze()
    const first = controller.execute()
    await controller.execute()
    await first
    expect(call.mock.calls.filter(([operation]) => operation === 'gitAiExecute')).toHaveLength(1)
    await controller.execute()
    expect(call.mock.calls.at(-1)?.[1]).toMatchObject({
      plan: { batches: [analysis.plan.batches[1]] },
    })
    expect(controller.snapshot().completed).toEqual(completed)
  })

  it('分析失败后重试或退出不会再次释放已经被后台撤销的请求', async () => {
    const call = vi.fn<GitAiFlowOptions['call']>(async () => {
      throw new Error('差异超过大小上限 256 KiB')
    })
    const { controller } = fixture(call)
    await controller.enter()
    await controller.analyze()
    expect(controller.snapshot()).toMatchObject({
      phase: 'prepare',
      analyzing: false,
      error: '差异超过大小上限 256 KiB',
    })
    await controller.analyze()
    await controller.release(true)
    expect(call.mock.calls.map(([operation]) => operation)).toEqual([
      'gitAiAnalyze',
      'gitAiAnalyze',
    ])
    expect(call.mock.calls[0]?.[1].id).not.toBe(call.mock.calls[1]?.[1].id)
  })

  it('编辑归属、合并与排序不遗漏或重复变更标识', () => {
    const swapped = reorderGitAiBatch(analysis.plan, 1, -1)
    expect(swapped.batches[0]?.itemIds).toEqual(['b'])
    const deferred = moveGitAiItems(swapped, ['a'], -1)
    expect(deferred.deferred).toEqual(['a'])
    const merged = moveGitAiItems(deferred, ['a'], 0)
    expect(merged.batches).toHaveLength(1)
    expect(merged.batches[0]?.itemIds).toEqual(['b', 'a'])
    expect(moveGitAiItems(merged, ['a'], -2).batches[1]?.message).toBe('')
  })

  it('主进程契约拒绝未确认发送、伪造路径与未知字段', () => {
    const payload = {
      id: 'test',
      scope: { staged: true, working: true, untracked: true },
      provider: 'test',
      model: 'model',
      confirmed: true,
    }
    expect(validateGitAiPayload('gitAiAnalyze', payload)).toEqual(payload)
    expect(() => validateGitAiPayload('gitAiAnalyze', { ...payload, confirmed: false })).toThrow(
      '确认',
    )
    expect(() => validateGitAiPayload('gitAiAnalyze', { ...payload, patch: '任意补丁' })).toThrow(
      '字段',
    )
    expect(() => validateGitAiPayload('gitAiDiff', { id: 'test', itemId: '../outside' })).toThrow(
      '标识',
    )
    expect(() => validateGitAiPayload('gitAiRelease', { id: 'test', projectId: '伪造' })).toThrow(
      '字段',
    )
  })
})
