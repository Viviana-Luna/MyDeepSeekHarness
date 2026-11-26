import { describe, expect, it } from 'vitest'

import {
  normalizeSessionEvents,
  projectConversation,
  projectTrajectory,
} from '../src/shared/session-projection.ts'

function event(type: string, seq: number, time: number, data: unknown): Record<string, unknown> {
  return { type, seq, time, data }
}

it('自动压缩失败留在会话中，取消和手动命令不重复生成警告', () => {
  const items = projectConversation([
    event('compaction/end', 1, 10, {
      turn: 1,
      error: '不支持参数',
      failure: { code: 'UNSUPPORTED_OPTION' },
    }),
    event('compaction/end', 2, 20, { turn: 1, error: '已取消', failure: { code: 'ABORTED' } }),
    event('compaction/end', 3, 30, { turn: null, sourceCommandId: '手动', error: '失败' }),
  ])
  expect(items).toEqual([
    expect.objectContaining({
      type: 'warning',
      message: '上下文压缩失败：不支持参数',
      code: 'UNSUPPORTED_OPTION',
    }),
  ])
})

describe('Session 事件规范化', () => {
  it('兼容旧 history，并按 seq 排序和去重', () => {
    const input = {
      events: [
        {
          event: event('assistant/message', 4, 140, {
            message: { content: [{ type: 'text', text: '完成' }] },
          }),
        },
        { event: event('user/message', 2, 120, { content: [{ type: 'text', text: '开始' }] }) },
        { event: event('user/message', 2, 121, { content: [{ type: 'text', text: '重复' }] }) },
        { event: { type: '损坏', seq: '3', time: 130, data: {} } },
      ],
    }

    expect(normalizeSessionEvents(input)).toEqual([
      event('user/message', 2, 120, { content: [{ type: 'text', text: '开始' }] }),
      event('assistant/message', 4, 140, {
        message: { content: [{ type: 'text', text: '完成' }] },
      }),
    ])
  })

  it('兼容 page event、chunks 批量记录和持久化压缩行', () => {
    const input = {
      records: [
        { type: 'event', event: event('turn/start', 1, 100, { turn: 1 }) },
        {
          type: 'chunks',
          event: {
            type: 'text-chunks',
            seq0: 2,
            time0: 105,
            data: { turn: 1, step: 1, index: 0, dt: [2], texts: ['你', '好'] },
          },
        },
        {
          type: 'chunks',
          events: [event('assistant/chunk', 4, 109, { turn: 1, chunk: { type: 'finish' } })],
        },
      ],
    }

    expect(normalizeSessionEvents(input)).toEqual([
      event('turn/start', 1, 100, { turn: 1 }),
      event('assistant/chunk', 2, 105, {
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: '你' },
      }),
      event('assistant/chunk', 3, 107, {
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: '好' },
      }),
      event('assistant/chunk', 4, 109, { turn: 1, chunk: { type: 'finish' } }),
    ])
  })

  it('把 reasoning-chunks 持久化压缩行规范化为连续的 reasoning-delta', () => {
    const input = {
      records: [
        {
          type: 'reasoning-chunks',
          seq0: 8,
          time0: 200,
          data: {
            turn: 2,
            step: 3,
            index: 0,
            dt: [4],
            texts: ['先检查协议', '再核对事件'],
          },
        },
      ],
    }

    expect(normalizeSessionEvents(input)).toEqual([
      event('assistant/chunk', 8, 200, {
        turn: 2,
        step: 3,
        chunk: { type: 'reasoning-delta', index: 0, text: '先检查协议' },
      }),
      event('assistant/chunk', 9, 204, {
        turn: 2,
        step: 3,
        chunk: { type: 'reasoning-delta', index: 0, text: '再核对事件' },
      }),
    ])
  })

  it('对无效和未知输入返回空数组而不抛错', () => {
    expect(normalizeSessionEvents(null)).toEqual([])
    expect(
      normalizeSessionEvents({
        records: [{ type: 'chunks', event: { type: 'text-chunks' } }, 1, null],
      }),
    ).toEqual([])
  })
})

describe('对话投影', () => {
  it('投影消息和工具摘要，并忽略无法关联 step 的 chunk 与未知事件', () => {
    const input = [
      event('turn/start', 1, 100, { turn: 1 }),
      event('user/message', 2, 110, { content: [{ type: 'text', text: '读取文件' }] }),
      event('assistant/chunk', 3, 120, { turn: 1, chunk: { type: 'text-delta', text: '重' } }),
      event('assistant/message', 4, 130, {
        turn: 1,
        message: {
          id: 'assistant-message-4',
          content: [
            { type: 'reasoning', text: '内部推理' },
            { type: 'text', text: '正在读取' },
          ],
        },
      }),
      event('tool/call', 5, 140, {
        turn: 1,
        callId: 'call-1',
        name: 'read',
        arguments: '{"path":"README.md"}',
      }),
      event('tool/result', 6, 155, {
        turn: 1,
        message: {
          source: { kind: 'tool', callId: 'call-1' },
          content: [
            { type: 'tool-result', isError: false, content: [{ type: 'text', text: '文件内容' }] },
          ],
        },
      }),
      event('未来/事件', 7, 160, { anything: true }),
    ]

    expect(projectConversation(input)).toEqual([
      { type: 'user', seq: 2, time: 110, turn: 1, step: null, text: '读取文件', status: 'settled' },
      {
        type: 'assistant',
        seq: 4,
        latestSeq: 4,
        time: 130,
        turn: 1,
        step: null,
        text: '正在读取',
        messageId: 'assistant-message-4',
        blocks: [
          { type: 'reasoning', index: 0, text: '内部推理', complete: true },
          { type: 'text', index: 1, text: '正在读取', complete: true },
        ],
        status: 'settled',
      },
      {
        type: 'tool',
        seq: 5,
        latestSeq: 6,
        time: 140,
        endTime: 155,
        turn: 1,
        callId: 'call-1',
        name: 'read',
        summary: 'README.md',
        argumentsText: '{\n  "path": "README.md"\n}',
        resultText: '文件内容',
        status: 'settled',
        isError: false,
      },
    ])
  })

  it('把同一 turn 和 step 的文本分片投影为一条生成中回复', () => {
    const input = [
      event('turn/start', 1, 100, { turn: 3 }),
      event('step/start', 2, 101, { turn: 3, step: 1 }),
      event('user/message', 3, 102, {
        id: '消息-1',
        source: { kind: 'user' },
        content: [{ type: 'text', text: '打个招呼' }],
      }),
      event('assistant/chunk', 4, 110, {
        turn: 3,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: '你' },
      }),
      event('assistant/chunk', 5, 120, {
        turn: 3,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: '好' },
      }),
    ]

    expect(projectConversation(input, { running: true })).toEqual([
      {
        type: 'user',
        seq: 3,
        time: 102,
        turn: 3,
        step: 1,
        text: '打个招呼',
        status: 'settled',
      },
      {
        type: 'assistant',
        seq: 4,
        latestSeq: 5,
        time: 110,
        turn: 3,
        step: 1,
        text: '你好',
        status: 'streaming',
      },
    ])
  })

  it('仅收到 reasoning-delta 时也投影一条生成中回复', () => {
    const input = [
      event('turn/start', 1, 100, { turn: 7 }),
      event('step/start', 2, 101, { turn: 7, step: 1 }),
      event('user/message', 3, 102, {
        source: { kind: 'user' },
        content: [{ type: 'text', text: '分析这个问题' }],
      }),
      event('assistant/chunk', 4, 110, {
        turn: 7,
        step: 1,
        chunk: { type: 'reasoning-delta', index: 0, text: '先检查协议' },
      }),
      event('assistant/chunk', 5, 120, {
        turn: 7,
        step: 1,
        chunk: { type: 'reasoning-delta', index: 0, text: '，再检查投影。' },
      }),
    ]

    expect(projectConversation(input, { running: true })).toEqual([
      {
        type: 'user',
        seq: 3,
        time: 102,
        turn: 7,
        step: 1,
        text: '分析这个问题',
        status: 'settled',
      },
      {
        type: 'assistant',
        seq: 4,
        latestSeq: 5,
        time: 110,
        turn: 7,
        step: 1,
        text: '',
        blocks: [
          {
            type: 'reasoning',
            index: 0,
            text: '先检查协议，再检查投影。',
            complete: false,
          },
        ],
        status: 'streaming',
      },
    ])
  })

  it('block-end 使用完整 reasoning 替换 delta 并标记 block 已完成', () => {
    const input = [
      event('turn/start', 1, 100, { turn: 10 }),
      event('step/start', 2, 101, { turn: 10, step: 1 }),
      event('assistant/chunk', 3, 110, {
        turn: 10,
        step: 1,
        chunk: { type: 'reasoning-delta', index: 2, text: '不完整' },
      }),
      event('assistant/chunk', 4, 120, {
        turn: 10,
        step: 1,
        chunk: {
          type: 'block-end',
          index: 2,
          block: { type: 'reasoning', text: '完整推理' },
        },
      }),
    ]

    expect(projectConversation(input, { running: true }).at(-1)).toMatchObject({
      type: 'assistant',
      latestSeq: 4,
      text: '',
      blocks: [{ type: 'reasoning', index: 2, text: '完整推理', complete: true }],
      status: 'streaming',
    })
  })

  it('最终消息覆盖同 step 临时回复，不把 chunk 和 final 投影成两条', () => {
    const input = [
      event('turn/start', 1, 100, { turn: 4 }),
      event('step/start', 2, 101, { turn: 4, step: 2 }),
      event('user/message', 3, 102, { content: [{ type: 'text', text: '继续' }] }),
      event('assistant/chunk', 4, 110, {
        turn: 4,
        step: 2,
        chunk: { type: 'text-delta', index: 0, text: '临时内容' },
      }),
      event('assistant/message', 5, 130, {
        turn: 4,
        step: 2,
        message: { id: 'assistant-message-5', content: [{ type: 'text', text: '最终内容' }] },
      }),
    ]

    expect(projectConversation(input, { running: true })).toEqual([
      {
        type: 'user',
        seq: 3,
        time: 102,
        turn: 4,
        step: 2,
        text: '继续',
        status: 'settled',
      },
      {
        type: 'assistant',
        seq: 4,
        latestSeq: 5,
        time: 130,
        turn: 4,
        step: 2,
        text: '最终内容',
        messageId: 'assistant-message-5',
        status: 'settled',
      },
    ])
  })

  it('最终多 block 内容按原始顺序原位替换流式内容且不重复', () => {
    const input = [
      event('turn/start', 1, 100, { turn: 8 }),
      event('step/start', 2, 101, { turn: 8, step: 2 }),
      event('user/message', 3, 102, { content: [{ type: 'text', text: '给出结论' }] }),
      event('assistant/chunk', 4, 110, {
        turn: 8,
        step: 2,
        chunk: { type: 'reasoning-delta', index: 0, text: '临时推理' },
      }),
      event('assistant/chunk', 5, 115, {
        turn: 8,
        step: 2,
        chunk: { type: 'text-delta', index: 2, text: '临时回答' },
      }),
      event('assistant/chunk', 6, 120, {
        turn: 8,
        step: 2,
        chunk: { type: 'reasoning-delta', index: 3, text: '第二段临时推理' },
      }),
      event('assistant/message', 7, 130, {
        turn: 8,
        step: 2,
        message: {
          content: [
            { type: 'reasoning', index: 99, text: '第一段最终推理' },
            { type: 'tool-call', id: '调用-1', name: 'read', arguments: '{}' },
            { type: 'text', index: 99, text: '最终回答前段' },
            { type: 'reasoning', index: 99, text: '第二段最终推理' },
            { type: 'text', index: 99, text: '最终回答后段' },
          ],
        },
      }),
    ]

    const projected = projectConversation(input, { running: true })
    expect(projected.filter(item => item.type === 'assistant')).toHaveLength(1)
    expect(projected.at(-1)).toEqual({
      type: 'assistant',
      seq: 4,
      latestSeq: 7,
      time: 130,
      turn: 8,
      step: 2,
      text: '最终回答前段\n最终回答后段',
      blocks: [
        { type: 'reasoning', index: 0, text: '第一段最终推理', complete: true },
        { type: 'text', index: 2, text: '最终回答前段', complete: true },
        { type: 'reasoning', index: 3, text: '第二段最终推理', complete: true },
        { type: 'text', index: 4, text: '最终回答后段', complete: true },
      ],
      status: 'settled',
    })
  })

  it('最终消息未包含 reasoning 时以权威 blocks 移除临时 Thinking', () => {
    const input = [
      event('turn/start', 1, 100, { turn: 9 }),
      event('step/start', 2, 101, { turn: 9, step: 1 }),
      event('user/message', 3, 102, { content: [{ type: 'text', text: '继续' }] }),
      event('assistant/chunk', 4, 110, {
        turn: 9,
        step: 1,
        chunk: { type: 'reasoning-delta', index: 0, text: '已流式收到的推理' },
      }),
      event('assistant/message', 5, 130, {
        turn: 9,
        step: 1,
        message: { content: [{ type: 'text', text: '最终结论' }] },
      }),
    ]

    expect(projectConversation(input, { running: true }).at(-1)).toEqual({
      type: 'assistant',
      seq: 4,
      latestSeq: 5,
      time: 130,
      turn: 9,
      step: 1,
      text: '最终结论',
      status: 'settled',
    })
  })

  it('保留 reasoning-only 的中断最终消息', () => {
    const input = [
      event('assistant/message', 1, 100, {
        turn: 11,
        step: 1,
        interrupted: true,
        message: {
          id: 'interrupted-assistant-message',
          content: [{ type: 'reasoning', text: '已经完成的部分推理' }],
        },
      }),
    ]

    expect(projectConversation(input)).toEqual([
      {
        type: 'assistant',
        seq: 1,
        latestSeq: 1,
        time: 100,
        turn: 11,
        step: 1,
        text: '',
        blocks: [
          {
            type: 'reasoning',
            index: 0,
            text: '已经完成的部分推理',
            complete: true,
          },
        ],
        status: 'interrupted',
      },
    ])
  })

  it('llm/retry 清除上一尝试的临时 Thinking', () => {
    const input = [
      event('turn/start', 1, 100, { turn: 12 }),
      event('step/start', 2, 101, { turn: 12, step: 1 }),
      event('user/message', 3, 102, {
        source: { kind: 'user' },
        content: [{ type: 'text', text: '重新尝试' }],
      }),
      event('assistant/chunk', 4, 110, {
        turn: 12,
        step: 1,
        chunk: { type: 'reasoning-delta', index: 0, text: '旧尝试推理' },
      }),
      event('llm/retry', 5, 120, {
        turn: 12,
        step: 1,
        retryId: '恢复-1',
        retry: 3,
        maxRetries: 5,
        delayMs: 4000,
        failure: { code: 'NETWORK', message: '连接中断' },
      }),
      event('assistant/chunk', 6, 130, {
        turn: 12,
        step: 1,
        chunk: { type: 'reasoning-delta', index: 0, text: '新尝试推理' },
      }),
    ]

    const waiting = projectConversation(input.slice(0, -1), { running: true }).find(
      item => item.type === 'assistant',
    )
    expect(waiting).toMatchObject({
      status: 'waiting',
      retry: { attempt: 3, maxAttempts: 5, nextAt: 4120, started: false, message: '连接中断' },
    })
    const sending = [
      ...input.slice(0, -1),
      event('llm/retry-started', 6, 4120, { turn: 12, step: 1, retryId: '恢复-1', retry: 3 }),
    ]
    expect(
      projectConversation(sending, { running: true }).find(item => item.type === 'assistant'),
    ).toMatchObject({ retry: { started: true } })
    expect(
      projectConversation(sending, { running: false }).some(
        item => item.type === 'assistant' && item.retry,
      ),
    ).toBe(false)
    const projected = projectConversation(input, { running: true })
    expect(projected.filter(item => item.type === 'assistant')).toEqual([
      {
        type: 'assistant',
        seq: 6,
        latestSeq: 6,
        time: 130,
        turn: 12,
        step: 1,
        text: '',
        blocks: [
          {
            type: 'reasoning',
            index: 0,
            text: '新尝试推理',
            complete: false,
          },
        ],
        status: 'streaming',
      },
    ])
  })

  it('只在权威运行中的当前 turn 已提交用户消息时显示首字等待项', () => {
    const input = [
      event('turn/start', 1, 100, { turn: 5 }),
      event('step/start', 2, 101, { turn: 5, step: 1 }),
      event('user/message', 3, 102, {
        id: '消息-2',
        source: { kind: 'user' },
        content: [{ type: 'text', text: '请回答' }],
      }),
    ]

    expect(projectConversation(input)).toHaveLength(1)
    expect(projectConversation(input, { running: true }).at(-1)).toEqual({
      type: 'assistant',
      seq: 2,
      latestSeq: 3,
      time: 101,
      turn: 5,
      step: 1,
      text: '',
      status: 'waiting',
    })

    expect(
      projectConversation(
        [
          event('turn/start', 1, 100, { turn: 5 }),
          event('step/start', 2, 101, { turn: 5, step: 1 }),
          event('user/message', 3, 102, {
            source: {
              kind: 'plugin',
              plugin: '@deepseek-ai/dsh-system-prompt',
              form: 'snapshot',
              sections: [{ name: 'sandbox:policy', text: '工作区可写' }],
            },
            content: [{ type: 'text', text: '注入内容' }],
          }),
        ],
        { running: true },
      ),
    ).toEqual([
      {
        type: 'context',
        seq: 3,
        time: 102,
        turn: 5,
        step: 1,
        text: '注入内容',
        status: 'settled',
        role: 'inject',
        sourceLabel: '@deepseek-ai/dsh-system-prompt',
        form: 'snapshot',
        summary: null,
        sections: [{ name: 'sandbox:policy', text: '工作区可写' }],
      },
    ])
  })

  it('首步骤之前和工具完成后的步骤间隙呈现等待，运行工具期间不重复', () => {
    const initial = [
      event('turn/start', 1, 100, { turn: 5 }),
      event('user/message', 2, 101, {
        source: { kind: 'user' },
        content: [{ type: 'text', text: '请回答' }],
      }),
    ]
    expect(projectConversation(initial, { running: true }).at(-1)).toMatchObject({
      type: 'assistant',
      status: 'waiting',
      turn: 5,
      step: null,
    })
    const running = [
      ...initial,
      event('step/start', 3, 102, { turn: 5, step: 1 }),
      event('tool/call', 4, 103, { turn: 5, step: 1, callId: 'a', name: 'read', arguments: {} }),
    ]
    expect(
      projectConversation(running, { running: true }).filter(
        item => item.type === 'assistant' && item.status === 'waiting',
      ),
    ).toHaveLength(0)
    const between = [
      ...running,
      event('tool/result', 5, 104, { turn: 5, step: 1, callId: 'a', result: '完成' }),
      event('step/end', 6, 105, { turn: 5, step: 1 }),
    ]
    expect(projectConversation(between, { running: true }).at(-1)).toMatchObject({
      type: 'assistant',
      status: 'waiting',
      turn: 5,
      step: null,
    })
    expect(
      projectConversation([...between, event('turn/end', 7, 106, { turn: 5 })], {
        running: true,
      }).some(item => item.type === 'assistant' && item.status === 'waiting'),
    ).toBe(false)
  })

  it('block-end 以完整文本替换已有 delta，并在未收到 final 的关闭 step 中保留中断回复', () => {
    const input = [
      event('turn/start', 1, 100, { turn: 6 }),
      event('step/start', 2, 101, { turn: 6, step: 1 }),
      event('user/message', 3, 102, { content: [{ type: 'text', text: '继续' }] }),
      event('assistant/chunk', 4, 110, {
        turn: 6,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: '半' },
      }),
      event('assistant/chunk', 5, 120, {
        turn: 6,
        step: 1,
        chunk: { type: 'block-end', index: 0, block: { type: 'text', text: '完整文本' } },
      }),
      event('step/end', 6, 130, { turn: 6, step: 1 }),
    ]

    expect(projectConversation(input, { running: true }).at(-1)).toMatchObject({
      type: 'assistant',
      latestSeq: 5,
      text: '完整文本',
      status: 'interrupted',
    })
  })
})

describe('轨迹投影', () => {
  it('按 turn 分组并配对工具结果、耗时与调用数', () => {
    const input = {
      records: [
        { type: 'event', event: event('turn/end', 7, 250, { turn: 2 }) },
        {
          type: 'event',
          event: event('tool/result', 5, 190, {
            turn: 2,
            message: {
              source: { callId: 'call-2' },
              content: [
                {
                  type: 'tool-result',
                  isError: true,
                  content: [{ type: 'text', text: '没有权限' }],
                },
              ],
            },
          }),
        },
        { type: 'event', event: event('turn/start', 1, 100, { turn: 2 }) },
        {
          type: 'event',
          event: event('user/message', 2, 110, { content: [{ type: 'text', text: '执行' }] }),
        },
        {
          type: 'event',
          event: event('tool/call', 4, 150, {
            turn: 2,
            callId: 'call-2',
            name: 'bash',
            arguments: 'pwd',
          }),
        },
        {
          type: 'event',
          event: event('assistant/message', 6, 210, {
            turn: 2,
            message: { content: [{ type: 'text', text: '执行失败' }] },
          }),
        },
      ],
    }

    expect(projectTrajectory(input)).toEqual([
      {
        turn: 2,
        startTime: 100,
        endTime: 250,
        duration: 150,
        calls: 1,
        entries: [
          { kind: 'input', seq: 2, time: 110, text: '执行' },
          {
            kind: 'tool',
            seq: 4,
            time: 150,
            callId: 'call-2',
            name: 'bash',
            summary: 'bash：pwd',
            argumentsText: 'pwd',
            resultSummary: '失败：没有权限',
            resultText: '没有权限',
            endTime: 190,
            duration: 40,
            isError: true,
          },
          { kind: 'model', seq: 6, time: 210, text: '执行失败' },
        ],
      },
    ])
  })

  it('跳过无法归属 turn 的事件和未配对结果', () => {
    expect(
      projectTrajectory([
        event('user/message', 1, 100, { content: [{ type: 'text', text: '孤立消息' }] }),
        event('tool/result', 2, 110, { message: { source: { callId: 'missing' } } }),
      ]),
    ).toEqual([])
  })
})

describe('会话投影的终端失败行', () => {
  it('把 turn/end 的失败原因投影成一轮里的常驻行', () => {
    const items = projectConversation([
      { type: 'turn/start', seq: 1, time: 1_000, data: { turn: 1 } },
      {
        type: 'user/message',
        seq: 2,
        time: 1_100,
        data: { turn: 1, content: [{ type: 'text', text: '跑一下' }] },
      },
      {
        type: 'turn/end',
        seq: 3,
        time: 1_900,
        data: {
          turn: 1,
          reason: {
            kind: 'error',
            error: { message: '模型请求失败：连接超时', code: 'LLM_TIMEOUT' },
          },
        },
      },
    ])
    const failure = items.find(item => item.type === 'error')
    expect(failure).toMatchObject({
      type: 'error',
      seq: 3,
      turn: 1,
      message: '模型请求失败：连接超时',
      code: 'LLM_TIMEOUT',
    })
  })

  it('区分正常结束、取消、输出上限与缺失失败消息', () => {
    const truncated = projectConversation([
      { type: 'turn/start', seq: 1, time: 1_000, data: { turn: 1 } },
      { type: 'turn/end', seq: 2, time: 1_100, data: { turn: 1, reason: { kind: 'max-tokens' } } },
    ])
    expect(truncated).toMatchObject([
      { type: 'warning', turn: 1, message: expect.stringContaining('输出上限') },
    ])
    const completed = projectConversation([
      { type: 'turn/start', seq: 1, time: 1_000, data: { turn: 1 } },
      { type: 'turn/end', seq: 2, time: 1_100, data: { turn: 1, reason: { kind: 'completed' } } },
    ])
    expect(completed.some(item => item.type === 'error')).toBe(false)

    const aborted = projectConversation([
      { type: 'turn/start', seq: 1, time: 1_000, data: { turn: 1 } },
      {
        type: 'turn/end',
        seq: 2,
        time: 1_100,
        data: { turn: 1, reason: { kind: 'aborted', reason: 'user' } },
      },
    ])
    expect(aborted.some(item => item.type === 'error')).toBe(false)

    const bare = projectConversation([
      { type: 'turn/start', seq: 1, time: 1_000, data: { turn: 1 } },
      {
        type: 'turn/end',
        seq: 2,
        time: 1_100,
        data: { turn: 1, reason: { kind: 'error', error: {} } },
      },
    ])
    expect(bare.find(item => item.type === 'error')).toMatchObject({ message: '本轮运行失败' })
  })
})
