// @vitest-environment jsdom

/** 检查 renderer 在历史从轮次中途开始时的回复状态；用例结束后清理挂载的视图。 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ConversationView } from '../src/renderer/src/features/conversation/ConversationView.tsx'
import {
  projectConversation,
  type CanonicalSessionEvent,
} from '../src/shared/session-projection.ts'

function event(type: string, seq: number, data: unknown): CanonicalSessionEvent {
  return { type, seq, time: 1_700_000_000_000 + seq * 100, data }
}

const reasoning = event('assistant/chunk', 104.5, {
  turn: 12,
  step: 79,
  chunk: { type: 'reasoning-delta', index: 0, text: '正在核对检查结果' },
})

afterEach(cleanup)

describe('分页历史中的回复状态', () => {
  it.each([
    {
      name: '尾页保留步骤开始，但没有轮次开始',
      history: [event('step/start', 104, { turn: 12, step: 79 }), reasoning],
    },
    {
      name: '重连时只收到当前尝试的分片',
      history: [reasoning],
    },
    {
      name: '尾页从上一条完整回复开始',
      history: [
        event('assistant/message', 100, {
          turn: 12,
          step: 78,
          message: { content: [{ type: 'reasoning', text: '先检查已有结果' }] },
        }),
        event('step/end', 101, { turn: 12, step: 78 }),
        event('step/start', 104, { turn: 12, step: 79 }),
        reasoning,
      ],
    },
  ])('$name 时保持当前回复运行中', ({ history }) => {
    expect(projectConversation(history, { running: true }).at(-1)).toMatchObject({
      type: 'assistant',
      turn: 12,
      step: 79,
      status: 'streaming',
    })
    render(<ConversationView history={history} running />)
    expect(screen.queryByText('回复已停止')).toBeNull()
    expect(document.querySelector('[data-thinking-disclosure][data-active="true"]')).toBeTruthy()
  })

  it('尾页缺少轮次开始时仍显示重试等待，收到新分片后恢复输出', () => {
    const history = [
      event('step/start', 100, { turn: 12, step: 79 }),
      event('user/message', 101, {
        source: { kind: 'user' },
        content: [{ type: 'text', text: '继续检查' }],
      }),
      event('llm/retry', 102, {
        turn: 12,
        step: 79,
        retryId: '重试-1',
        retry: 1,
        maxRetries: 5,
        delayMs: 4000,
        failure: { code: 'NETWORK', message: '连接中断' },
      }),
    ]
    const view = render(<ConversationView history={history} running />)
    expect(screen.getByRole('status').textContent).toContain('正在重试请求（1 / 5）')
    expect(screen.queryByText('回复已停止')).toBeNull()

    view.rerender(<ConversationView history={[...history, reasoning]} running />)
    expect(document.querySelector('[data-model-retry]')).toBeNull()
    expect(screen.queryByText('回复已停止')).toBeNull()
    expect(document.querySelector('[data-thinking-disclosure][data-active="true"]')).toBeTruthy()
  })

  it('停止、步骤关闭和轮次结束后仍保留中断状态', () => {
    for (const [history, running] of [
      [[reasoning], false],
      [[reasoning, event('step/end', 105, { turn: 12, step: 79 })], true],
      [[reasoning, event('turn/end', 105, { turn: 12, reason: { kind: 'aborted' } })], true],
      [[reasoning, event('step/start', 105, { turn: 12, step: 80 })], true],
    ] as const) {
      expect(projectConversation(history, { running }).at(-1)).toMatchObject({
        type: 'assistant',
        status: 'interrupted',
      })
    }
    const view = render(<ConversationView history={[reasoning]} running />)
    view.rerender(<ConversationView history={[reasoning]} running={false} />)
    expect(screen.getByText('回复已停止')).toBeTruthy()
    expect(document.querySelector('[data-thinking-disclosure][data-active="true"]')).toBeNull()
  })

  it('完整消息到达后原位结算，仍保留核心明确记录的中断', () => {
    const history = [
      reasoning,
      event('assistant/message', 105, {
        turn: 12,
        step: 79,
        message: { content: [{ type: 'text', text: '检查完成' }] },
      }),
    ]
    const view = render(<ConversationView history={[reasoning]} running />)
    view.rerender(<ConversationView history={history} running />)
    expect(screen.getByText('检查完成')).toBeTruthy()
    expect(screen.queryByText('回复已停止')).toBeNull()
    expect(document.querySelectorAll('[data-message-status="settled"]')).toHaveLength(1)

    const last = history.at(-1)!
    view.rerender(
      <ConversationView
        history={[reasoning, { ...last, data: { ...(last.data as object), interrupted: true } }]}
        running
      />,
    )
    expect(screen.getByText('回复已停止')).toBeTruthy()
  })
})
