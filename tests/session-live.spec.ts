import { describe, expect, it } from 'vitest'
import {
  PluginProjectionCache,
  parsePluginProjectionChange,
  PROJECTION_VALUE_MAX_BYTES,
} from '../src/shared/plugin-projections.ts'

import {
  DESKTOP_QUEUE_EDIT_MAX_BYTES,
  parseDesktopSessionFrame,
} from '../src/shared/session-live.ts'

describe('插件投影缓存', () => {
  it('按会话与单键水位合并基线，保留较新增量并清除消失的键', () => {
    const cache = new PluginProjectionCache()
    const apply = (
      kind: 'snapshot' | 'patch',
      asOfSeq: number,
      values: Record<string, unknown>,
      session = '甲',
    ) => {
      cache.apply(session, parsePluginProjectionChange({ kind, asOfSeq, values })!)
    }
    apply('snapshot', -1, { 插件: null })
    apply('snapshot', 2, { 插件: '旧', 已删除: true })
    apply('patch', 5, { 插件: '新' })
    apply('patch', 5, { 另一个键: 10 })
    apply('snapshot', 3, { 插件: '迟到基线' })
    apply('patch', 4, { 插件: '迟到增量' })
    apply('snapshot', 1, { 插件: '乙' }, '乙')
    expect(cache.read('甲')?.values).toEqual({ 插件: '新', 另一个键: 10 })
    expect(cache.read('乙')?.values).toEqual({ 插件: '乙' })
    apply('snapshot', 6, {})
    expect(cache.read('甲')?.values).toEqual({})
    cache.clear()
    expect(cache.read('乙')).toBeUndefined()
  })

  it('丢弃超限或非法值并保留诊断，非法序号不改变缓存', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const parsed = parsePluginProjectionChange({
      kind: 'snapshot',
      asOfSeq: -1,
      values: {
        超大值: '中'.repeat(PROJECTION_VALUE_MAX_BYTES),
        循环: cyclic,
        非有限值: Infinity,
        ...Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`key-${index}`, index])),
      },
    })!
    expect(Object.keys(parsed.values)).toHaveLength(128)
    expect(parsed.omitted).toBe(4)
    expect(parsePluginProjectionChange({ kind: 'patch', asOfSeq: -1, values: {} })).toBeNull()
    expect(parsePluginProjectionChange({ kind: 'snapshot', asOfSeq: -2, values: {} })).toBeNull()
    const cache = new PluginProjectionCache()
    for (let seq = 0; seq < 9; seq += 1)
      cache.apply(
        '甲',
        parsePluginProjectionChange({
          kind: 'patch',
          asOfSeq: seq,
          values: { [`key-${seq}`]: 'x'.repeat(PROJECTION_VALUE_MAX_BYTES - 2) },
        })!,
      )
    expect(Object.keys(cache.read('甲')!.values)).toHaveLength(7)
    expect(cache.read('甲')?.omitted).toBe(2)
  })
})

function queueWithText(text: string) {
  return parseDesktopSessionFrame({
    type: 'session/queue',
    sessionId: '会话-1',
    items: [
      {
        id: '消息-1',
        placement: 'queued',
        message: { content: [{ type: 'text', text }] },
      },
    ],
  })
}

describe('桌面队列安全投影', () => {
  it('按 UTF-8 字节限制编辑正文，并逐字保留边界内的空白与 emoji', () => {
    const exact = `  ${'😀'.repeat((DESKTOP_QUEUE_EDIT_MAX_BYTES - 4) / 4)}  `
    const editable = queueWithText(exact)
    const item = editable?.type === 'session/queue' ? editable.queue.items[0] : undefined
    expect(item?.edit).toEqual({ kind: 'editable-text', text: exact })

    const oversized = queueWithText(`${exact}a`)
    const oversizedItem = oversized?.type === 'session/queue' ? oversized.queue.items[0] : undefined
    expect(oversizedItem?.edit).toEqual({ kind: 'read-only', reason: 'text-too-large' })
    expect(oversizedItem?.previewTruncated).toBe(true)
  })

  it('多文本块只生成预览，不把拼接副本伪装成可回写正文', () => {
    const frame = parseDesktopSessionFrame({
      type: 'session/queue',
      sessionId: '会话-1',
      items: [
        {
          id: '消息-1',
          placement: 'queued',
          message: {
            content: [
              { type: 'text', text: '第一块' },
              { type: 'text', text: '第二块' },
            ],
          },
        },
      ],
    })
    const item = frame?.type === 'session/queue' ? frame.queue.items[0] : undefined
    expect(item).toMatchObject({
      preview: '第一块\n第二块',
      previewTruncated: false,
      edit: { kind: 'read-only', reason: 'multiple-blocks' },
    })
  })

  it('超过可见容量时保留队首并报告真实总数，不忽略整份权威快照', () => {
    const frame = parseDesktopSessionFrame({
      type: 'session/queue',
      sessionId: '会话-1',
      items: Array.from({ length: 201 }, (_, index) => ({
        id: `消息-${String(index)}`,
        placement: 'queued',
        message: { content: [{ type: 'text', text: `内容-${String(index)}` }] },
      })),
    })
    expect(frame).toMatchObject({
      type: 'session/queue',
      queue: { totalCount: 201, omittedCount: 1, truncated: true },
    })
    if (frame?.type !== 'session/queue') throw new Error('未生成队列快照')
    expect(frame.queue.items).toHaveLength(200)
    expect(frame.queue.items[0]?.id).toBe('消息-0')
    expect(frame.queue.items.at(-1)?.id).toBe('消息-199')
  })
})

describe('桌面权限投影安全边界', () => {
  it('只把 permissions 投影的显示所需字段交给 renderer', () => {
    expect(
      parseDesktopSessionFrame({
        type: 'session/projection',
        sessionId: '会话-1',
        key: 'permissions',
        seq: 8,
        value: {
          currentValue: 'workspace-write',
          options: [
            {
              value: 'workspace-write',
              name: 'Workspace Write',
              description: '工作区内可写',
              internal: '丢弃',
            },
            { value: 'danger-full-access', name: 'Full Access' },
          ],
          internal: '丢弃',
        },
      }),
    ).toEqual({
      type: 'session/permissions',
      sessionId: '会话-1',
      seq: 8,
      value: {
        currentValue: 'workspace-write',
        options: [
          { value: 'workspace-write', name: 'Workspace Write', description: '工作区内可写' },
          { value: 'danger-full-access', name: 'Full Access' },
        ],
      },
    })
  })

  it('把标题投影收窄成列表更新所需的最小字段', () => {
    expect(
      parseDesktopSessionFrame({
        type: 'session/projection',
        sessionId: '会话-1',
        key: 'title',
        seq: 11,
        value: '固定标题',
        internal: '不外发',
      }),
    ).toEqual({
      type: 'session/title',
      sessionId: '会话-1',
      seq: 11,
      title: '固定标题',
    })
  })

  it('只把模型选择投影的下次选择交给 renderer', () => {
    expect(
      parseDesktopSessionFrame({
        type: 'session/projection',
        sessionId: '会话-1',
        key: 'modelSelection',
        seq: 12,
        value: {
          lastUsed: { provider: '旧提供方', model: '旧模型', internal: '丢弃' },
          next: {
            provider: '新提供方',
            model: '新模型',
            reasoningEffort: 'high',
            internal: '丢弃',
          },
          internal: '丢弃',
        },
      }),
    ).toEqual({
      type: 'session/model-selection',
      sessionId: '会话-1',
      seq: 12,
      value: {
        next: { provider: '新提供方', model: '新模型', reasoningEffort: 'high' },
      },
    })
  })

  it('有界接收其他投影，并继续拒绝伪造的模型与权限值', () => {
    expect(
      parseDesktopSessionFrame({
        type: 'session/projection',
        sessionId: '会话-1',
        key: '任意投影',
        seq: 9,
        value: { progress: '正在执行' },
      }),
    ).toEqual({
      type: 'session/plugin-projections',
      sessionId: '会话-1',
      change: {
        kind: 'patch',
        asOfSeq: 9,
        values: { 任意投影: { progress: '正在执行' } },
        omitted: 0,
      },
    })
    expect(
      parseDesktopSessionFrame({
        type: 'session/projection',
        sessionId: '会话-1',
        key: 'modelSelection',
        seq: 9,
        value: { next: { provider: '', model: '伪造模型' } },
      }),
    ).toBeNull()
    // 运行核心的权限投影只发布当前值；缺省选项是正常形态，可切换项另行来自目录。
    expect(
      parseDesktopSessionFrame({
        type: 'session/projection',
        sessionId: '会话-1',
        key: 'permissions',
        seq: 9,
        value: { currentValue: 'workspace-write' },
      }),
    ).toEqual({
      type: 'session/permissions',
      sessionId: '会话-1',
      seq: 9,
      value: { currentValue: 'workspace-write' },
    })
    // 没有当前值，或带选项但选项不合法时整帧拒绝。
    expect(
      parseDesktopSessionFrame({
        type: 'session/projection',
        sessionId: '会话-1',
        key: 'permissions',
        seq: 9,
        value: { currentValue: '' },
      }),
    ).toBeNull()
    expect(
      parseDesktopSessionFrame({
        type: 'session/projection',
        sessionId: '会话-1',
        key: 'permissions',
        seq: 9,
        value: { currentValue: 'workspace-write', options: [{ value: 'workspace-write' }] },
      }),
    ).toBeNull()
  })
})

describe('桌面命令 lifecycle 事件安全边界', () => {
  it('command/run 和 command/done 只保留专用白名单字段', () => {
    expect(
      parseDesktopSessionFrame({
        type: 'session/event',
        sessionId: '会话-1',
        event: {
          type: 'command/run',
          seq: 10,
          time: 1_700_000_000_000,
          data: {
            commandId: 'command-1',
            name: 'compact',
            args: '  当前会话',
            source: { kind: 'user', account: '不外发' },
            attachments: [{ data: '不外发' }],
          },
          transport: '不外发',
        },
      }),
    ).toEqual({
      type: 'session/event',
      sessionId: '会话-1',
      event: {
        type: 'command/run',
        seq: 10,
        time: 1_700_000_000_000,
        data: {
          commandId: 'command-1',
          name: 'compact',
          args: '  当前会话',
          source: { kind: 'user' },
        },
      },
    })

    expect(
      parseDesktopSessionFrame({
        type: 'session/event',
        sessionId: '会话-1',
        event: {
          type: 'command/done',
          seq: 12,
          time: 1_700_000_000_100,
          data: {
            commandId: 'command-1',
            kind: 'success',
            text: '完成',
            sourceEventSeq: 11,
            internal: '不外发',
          },
        },
      }),
    ).toEqual({
      type: 'session/event',
      sessionId: '会话-1',
      event: {
        type: 'command/done',
        seq: 12,
        time: 1_700_000_000_100,
        data: {
          commandId: 'command-1',
          kind: 'success',
          text: '完成',
          sourceEventSeq: 11,
        },
      },
    })
  })

  it('拒绝伪造 command data、非法名称和越界 sourceEventSeq', () => {
    const invalidEvents = [
      {
        type: 'command/run',
        seq: 10,
        data: { commandId: 'command-1', name: '../escape', source: { kind: 'user' } },
      },
      {
        type: 'command/run',
        seq: 10,
        data: { commandId: 'command-1', name: 'compact', source: { kind: 'model' } },
      },
      {
        type: 'command/done',
        seq: 12,
        data: { commandId: 'command-1', kind: 'success', sourceEventSeq: 12 },
      },
      {
        type: 'command/done',
        seq: 12,
        data: { commandId: 'command-1', kind: 'error', sourceEventSeq: 1 },
      },
    ]
    for (const event of invalidEvents) {
      expect(
        parseDesktopSessionFrame({
          type: 'session/event',
          sessionId: '会话-1',
          event: { ...event, time: 1_700_000_000_000 },
        }),
      ).toBeNull()
    }
  })
})

const planFrame = (callId: unknown) => ({
  type: 'question/requested',
  sessionId: '会话-1',
  questions: [
    {
      id: 'plan-review',
      question: '审阅计划',
      detail: '# 计划',
      options: [{ label: 'Approve' }],
      intent: { kind: 'plan-review', approve: 'Approve', callId, internal: '丢弃' },
    },
  ],
})

describe('待用户响应交互安全投影', () => {
  it('计划审阅保留受限调用标识并拒绝超长标识', () => {
    expect(parseDesktopSessionFrame(planFrame('调用-1'), 'rpc-plan')).toMatchObject({
      interaction: {
        questions: [{ intent: { kind: 'plan-review', approve: 'Approve', callId: '调用-1' } }],
      },
    })
    expect(parseDesktopSessionFrame(planFrame('x'.repeat(513)), 'rpc-plan')).toBeNull()
    expect(parseDesktopSessionFrame(planFrame(42), 'rpc-plan')).toBeNull()
  })
  it('保留回答关联标识，收窄问题与一次性审批，并解析权威结束帧', () => {
    expect(
      parseDesktopSessionFrame(
        {
          type: 'question/requested',
          sessionId: '会话-1',
          questions: [
            {
              id: 'school_choice',
              header: '学校归属',
              question: '请选择学校',
              detail: '仅用于本次导入。',
              options: [
                {
                  label: '红明小学 (Recommended)',
                  description: '使用新学校代码',
                  internal: '丢弃',
                },
              ],
              multiSelect: false,
              internal: '丢弃',
            },
          ],
          internal: '丢弃',
        },
        'rpc-question-1',
      ),
    ).toEqual({
      type: 'session/interaction-requested',
      sessionId: '会话-1',
      interaction: {
        kind: 'question',
        key: 'question:rpc-question-1',
        questions: [
          {
            id: 'school_choice',
            header: '学校归属',
            question: '请选择学校',
            detail: '仅用于本次导入。',
            options: [{ label: '红明小学 (Recommended)', description: '使用新学校代码' }],
            multiSelect: false,
          },
        ],
      },
    })

    expect(
      parseDesktopSessionFrame(
        {
          type: 'approval/requested',
          sessionId: '会话-1',
          approvalId: '审批-1',
          toolName: 'Bash',
          callId: '调用-1',
          reason: '复制交付文件到 Downloads',
          command: '不得从审批帧外发',
        },
        'rpc-approval-1',
      ),
    ).toEqual({
      type: 'session/interaction-requested',
      sessionId: '会话-1',
      interaction: {
        kind: 'approval',
        key: 'approval:rpc-approval-1',
        approvalId: '审批-1',
        toolName: 'Bash',
        callId: '调用-1',
        reason: '复制交付文件到 Downloads',
      },
    })

    expect(
      parseDesktopSessionFrame({
        type: 'question/resolved',
        sessionId: '会话-1',
        questionRpcId: 'rpc-question-1',
        outcome: 'answered',
      }),
    ).toMatchObject({
      resolution: { kind: 'question', key: 'question:rpc-question-1', outcome: 'answered' },
    })
    expect(
      parseDesktopSessionFrame({
        type: 'approval/resolved',
        sessionId: '会话-1',
        approvalId: '审批-1',
        outcome: 'allowed-once',
      }),
    ).toMatchObject({
      resolution: { kind: 'approval', approvalId: '审批-1', outcome: 'allowed-once' },
    })
    expect(
      parseDesktopSessionFrame({
        type: 'question/requested',
        sessionId: '会话-1',
        questions: [{ id: '问题-1', question: '缺少 rpcId' }],
      }),
    ).toBeNull()
  })
})
