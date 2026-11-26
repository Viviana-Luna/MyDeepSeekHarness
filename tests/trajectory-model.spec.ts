import { describe, expect, it } from 'vitest'
import {
  projectTrace,
  traceDuration,
} from '../src/renderer/src/features/trajectory/trajectory-model.ts'
const event = (type: string, seq: number, time: number, data: unknown) => ({
  type,
  seq,
  time,
  data,
})

describe('轨迹原始记录投影', () => {
  it('保留完整参数、嵌套归属和错误结果，Schema 只取调用时已有定义', () => {
    const args = JSON.stringify({ text: '长参数'.repeat(5000) })
    const records = projectTrace([
      event('turn/start', 1, 10, { turn: 2 }),
      event('step/start', 2, 20, { turn: 2, step: 3 }),
      event('request/header', 3, 25, {
        header: { tools: [{ name: 'run_code', parameters: { type: 'object' } }] },
      }),
      event('tool/call', 4, 30, {
        turn: 2,
        step: 3,
        callId: '父',
        name: 'run_code',
        arguments: args,
      }),
      event('tool/ptc-dispatch-start', 5, 40, {
        parentCallId: '父',
        subCallId: '子',
        name: 'read',
        arguments: { path: 'a' },
      }),
      event('tool/ptc-dispatch', 6, 50, {
        parentCallId: '父',
        subCallId: '子',
        name: 'read',
        content: [{ type: 'text', text: '失败详情' }],
        isError: true,
      }),
      event('tool/result', 7, 60, {
        message: { source: { callId: '父' }, content: [{ type: 'text', text: '完成' }] },
      }),
    ])[0]!.records
    expect(records[0]?.input).toBe(args)
    expect(records[0]?.schema).toContain('parameters')
    expect(traceDuration(records[0]!)).toBe(30)
    expect(records[1]).toMatchObject({
      parentCallId: '父',
      callId: '子',
      status: 'error',
      output: '失败详情',
      schema: null,
    })
  })
  it('将流式回复原位结算并读取持久流的首字时间，未加载起点时不杜撰耗时', () => {
    const history = [
      event('turn/start', 1, 100, { turn: 1 }),
      event('step/start', 2, 110, { turn: 1, step: 1 }),
      event('assistant/chunk', 3, 140, {
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: '回答' },
      }),
    ]
    expect(projectTrace(history, true)[0]?.records[0]).toMatchObject({
      status: 'running',
      endedAt: null,
      firstTokenAt: 140,
    })
    const final = event('assistant/message', 4, 200, {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'text', text: '回答完成' }] },
      stream: [{ type: 'text-chunks', time0: 140, index: 0, dt: [], texts: ['回答完成'] }],
      usage: { inputTokens: 15, outputTokens: 5 },
    })
    const records = projectTrace([...history, final])[0]!.records
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      output: '回答完成',
      usage: { input: 15, output: 5 },
      firstTokenAt: 140,
      status: 'complete',
    })
    expect(traceDuration(records[0]!)).toBe(90)
    const partial = projectTrace([final])[0]!.records[0]!
    expect(partial.firstTokenAt).toBe(140)
    expect(traceDuration(partial)).toBeNull()
  })
  it('区分上下文、用户与轮次之间的压缩；中断工具不伪造结束时间', () => {
    const turns = projectTrace(
      [
        event('compaction/summary', 1, 10, { summary: [{ type: 'text', text: '压缩摘要' }] }),
        event('turn/start', 2, 20, { turn: 1 }),
        event('user/message', 3, 30, {
          source: { kind: 'user' },
          content: [{ type: 'text', text: '提问' }],
        }),
        event('user/message', 4, 35, {
          source: { kind: 'plugin' },
          content: [{ type: 'text', text: '上下文' }],
        }),
        event('tool/call', 5, 40, { callId: '一', name: 'read', arguments: '{}' }),
        event('turn/end', 6, 50, { turn: 1 }),
      ],
      true,
    )
    expect(turns[0]?.records[0]?.kind).toBe('compaction')
    expect(turns[1]?.records.map(record => record.kind)).toEqual(['input', 'context', 'tool'])
    expect(turns[1]?.records[2]).toMatchObject({ status: 'interrupted', endedAt: null })
  })
  it('保留同一步的失败尝试，并解包真实工具结果块的错误与文本', () => {
    const records = projectTrace([
      event('step/start', 1, 10, { turn: 1, step: 1 }),
      event('assistant/attempt', 2, 20, {
        turn: 1,
        step: 1,
        stream: [{ type: 'text-chunks', time0: 15, index: 0, texts: ['未完成的输出'], dt: [] }],
      }),
      event('assistant/message', 3, 30, {
        turn: 1,
        step: 1,
        message: { content: [{ type: 'text', text: '重试完成' }] },
      }),
      event('tool/call', 4, 40, {
        turn: 1,
        step: 1,
        callId: '调用',
        name: 'read',
        arguments: '{}',
      }),
      event('tool/result', 5, 50, {
        turn: 1,
        step: 1,
        message: {
          source: { callId: '调用' },
          content: [
            { type: 'tool-result', isError: true, content: [{ type: 'text', text: '文件不存在' }] },
          ],
        },
      }),
    ])[0]!.records
    expect(records).toHaveLength(3)
    expect(records[0]).toMatchObject({ status: 'interrupted', output: '未完成的输出' })
    expect(records[1]).toMatchObject({ status: 'complete', output: '重试完成', startedAt: null })
    expect(records[2]).toMatchObject({ status: 'error', output: '文件不存在' })
  })
})
