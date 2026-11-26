import { describe, expect, it } from 'vitest'
import { projectConversation } from '../src/shared/session-projection.ts'
import { planFromTool, planReviewOf } from '../src/renderer/src/features/plan/plan-review.ts'

describe('计划文档与审阅识别', () => {
  it('长计划可从原始 Session 日志重开，保留完整表格和代码', () => {
    const text =
      '# 长计划\n\n' +
      '| 时间 | 活动 |\n| --- | --- |\n| 上午 | 徒步 |\n\n```text\n记录\n```\n'.repeat(500)
    const projection = projectConversation([
      {
        type: 'tool/call',
        seq: 1,
        time: 1,
        data: {
          turn: 1,
          callId: '调用-1',
          name: 'exit_plan_mode',
          arguments: JSON.stringify({ plan: text }),
        },
      },
    ])
    const tool = projection.find(item => item.type === 'tool')
    expect(tool?.type).toBe('tool')
    if (tool?.type !== 'tool') throw new Error('缺少工具投影')
    expect(planFromTool(tool)).toBe(text)
    expect(planFromTool({ ...tool, argumentsText: '{不完整' })).toBeNull()
    expect(planFromTool({ ...tool, name: '其他工具' })).toBeNull()
  })

  it('不完整计划意图与普通问题继续使用原问答流程', () => {
    const question = {
      id: '问题',
      question: '请审阅',
      detail: '# 计划',
      options: [{ label: 'Approve' }],
      intent: { kind: 'plan-review' as const, approve: 'Approve' },
    }
    expect(planReviewOf({ kind: 'question', key: '请求', questions: [question] })).not.toBeNull()
    for (const variant of [
      { ...question, multiSelect: true },
      { ...question, detail: '' },
      { ...question, options: [{ label: '其他' }] },
    ]) {
      expect(planReviewOf({ kind: 'question', key: '请求', questions: [variant] })).toBeNull()
    }
  })
})
