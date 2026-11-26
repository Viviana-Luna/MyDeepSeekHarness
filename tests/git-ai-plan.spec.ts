/** 验证后台不会把模型虚构或遗漏的变更接受为提交方案。 */
import { describe, expect, it } from 'vitest'
import { parseGitAiPlan } from '../src/runtime/workspace/git-ai-plan.ts'

const expected = ['change-1', 'change-2', 'change-3']

function plan(batches: unknown, deferred: unknown): string {
  return JSON.stringify({ batches, deferred })
}

describe('AI 提交方案校验', () => {
  it('接受完整分批与明确暂不提交的变更', () => {
    const result = parseGitAiPlan(
      plan(
        [
          { message: '修复列表滚动', itemIds: ['change-1'] },
          { message: '优化连接面板\n\n调整表单布局', itemIds: ['change-2'] },
        ],
        ['change-3'],
      ),
      expected,
    )
    expect(result).toEqual({
      batches: [
        { message: '修复列表滚动', itemIds: ['change-1'] },
        { message: '优化连接面板\n\n调整表单布局', itemIds: ['change-2'] },
      ],
      deferred: ['change-3'],
    })
  })

  it('拒绝未知、重复或被遗漏的变更', () => {
    expect(() =>
      parseGitAiPlan(plan([{ message: '更新', itemIds: ['change-1', 'forged'] }], []), expected),
    ).toThrow('未知或重复')
    expect(() =>
      parseGitAiPlan(
        plan([{ message: '更新', itemIds: ['change-1', 'change-2'] }], ['change-2', 'change-3']),
        expected,
      ),
    ).toThrow('未知或重复')
    expect(() =>
      parseGitAiPlan(plan([{ message: '更新', itemIds: ['change-1'] }], ['change-2']), expected),
    ).toThrow('遗漏')
  })

  it('拒绝空批次、无效消息和额外字段', () => {
    for (const message of ['', '  ', '含\0空字符', '字'.repeat(6_000)]) {
      expect(() => parseGitAiPlan(plan([{ message, itemIds: expected }], []), expected)).toThrow(
        '消息无效',
      )
    }
    expect(() =>
      parseGitAiPlan(plan([{ message: '更新', itemIds: [] }], expected), expected),
    ).toThrow('不能没有变更')
    expect(() =>
      parseGitAiPlan(
        plan([{ message: '更新', itemIds: expected, command: 'git add .' }], []),
        expected,
      ),
    ).toThrow('格式无效')
    expect(() => parseGitAiPlan('{"batches":[],"deferred":[],"patch":"bad"}', expected)).toThrow(
      '格式无效',
    )
  })

  it('限制输出大小并拒绝无效输入快照', () => {
    expect(() => parseGitAiPlan('不是 JSON', expected)).toThrow('不是有效的 JSON')
    expect(() => parseGitAiPlan('x'.repeat(64 * 1024 + 1), expected)).toThrow('超过大小上限')
    expect(() => parseGitAiPlan(plan([], expected), ['change-1', 'change-1'])).toThrow(
      '待分析变更标识无效',
    )
    expect(() => parseGitAiPlan(plan([], []), [])).toThrow('待分析变更标识无效')
  })

  it('允许模型将所有变更保留给用户手动处理', () => {
    expect(parseGitAiPlan(plan([], expected), expected)).toEqual({
      batches: [],
      deferred: expected,
    })
  })
})
