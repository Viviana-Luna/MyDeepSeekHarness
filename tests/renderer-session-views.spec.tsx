// @vitest-environment jsdom

import { Provider } from '@umijs/max'
import useWorkspaceModel from '../src/renderer/src/models/workspace.ts'

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useWorkspaceSnapshot } from '../src/renderer/src/hooks/useWorkspace.ts'
import { Composer } from '../src/renderer/src/features/composer/Composer.tsx'
import { ConversationView } from '../src/renderer/src/features/conversation/ConversationView.tsx'
import { parseDesktopSessionFrame } from '../src/shared/session-live.ts'
import { TrajectoryView } from '../src/renderer/src/features/trajectory/TrajectoryView.tsx'
import { SessionSearch } from '../src/renderer/src/features/search/SessionSearch.tsx'
import {
  ProjectWorkspaceProvider,
  useProjectWorkspace,
} from '../src/renderer/src/features/project-workspace/ProjectWorkspaceProvider.tsx'
import type {
  DesktopBridge,
  DesktopDroppedImage,
  DesktopSettings,
} from '../src/renderer/src/platform/contracts.ts'

function event(type: string, seq: number, time: number, data: unknown): Record<string, unknown> {
  return { type, seq, time, data }
}

let originalClipboardDescriptor: PropertyDescriptor | undefined
let originalExecCommandDescriptor: PropertyDescriptor | undefined

function setClipboard(writeText: (text: string) => Promise<void>): void {
  originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
}

function setExecCommand(execCommand: (commandId: string) => boolean): void {
  originalExecCommandDescriptor = Object.getOwnPropertyDescriptor(document, 'execCommand')
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    value: execCommand,
  })
}

afterEach(() => {
  cleanup()
  delete window.dshDesktop
  if (originalClipboardDescriptor === undefined)
    delete (navigator as { clipboard?: unknown }).clipboard
  else Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor)
  originalClipboardDescriptor = undefined
  if (originalExecCommandDescriptor === undefined) {
    Reflect.deleteProperty(document, 'execCommand')
  } else {
    Object.defineProperty(document, 'execCommand', originalExecCommandDescriptor)
  }
  originalExecCommandDescriptor = undefined
})

describe('对话视图', () => {
  it('围栏代码可以切换换行并复制原文，包括缩进与末尾空行', async () => {
    const writeText = vi.fn(async () => {})
    setClipboard(writeText)
    render(
      <ConversationView
        history={[
          event('assistant/message', 1, 100, {
            message: { content: [{ type: 'text', text: '## 示例\n\n```sh\n  echo 示例\n\n```' }] },
          }),
        ]}
      />,
    )
    expect(screen.getByRole('heading', { name: '示例', level: 2 })).toBeTruthy()
    const wrap = screen.getByRole('button', { name: '自动换行' })
    fireEvent.click(wrap)
    expect(wrap.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '复制代码' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('  echo 示例\n'))
    expect(screen.getByText('已复制代码')).toBeTruthy()
  })

  it('命令运行和结果合并成一行，压缩摘要可展开，失败内容保留在记录中', () => {
    const history = [
      event('command/run', 10, 100, {
        commandId: '压缩-1',
        name: 'compact',
        args: '',
        source: { kind: 'user' },
      }),
    ]
    const view = render(<ConversationView sessionId="会话-1" history={history} />)
    expect(screen.getByText('正在压缩…').closest('[data-state]')?.getAttribute('data-state')).toBe(
      'running',
    )
    view.rerender(
      <ConversationView
        sessionId="会话-1"
        history={[
          ...history,
          event('compaction/summary', 11, 110, {
            sourceCommandId: '压缩-1',
            shadowedSeqs: [1, 2, 3],
            shadowedTokenCount: 123,
            summary: [{ type: 'text', text: '保留的压缩摘要' }],
          }),
          event('user/message', 12, 120, {
            source: { kind: 'plugin', plugin: 'compact', sourceCommandId: '压缩-1' },
            content: [{ type: 'text', text: '不重复显示的压缩注入' }],
          }),
          event('command/done', 13, 130, {
            commandId: '压缩-1',
            kind: 'success',
            sourceEventSeq: 11,
          }),
          event('command/run', 14, 140, {
            commandId: '计划-1',
            name: 'plan',
            args: '',
            source: { kind: 'user' },
          }),
          event('command/done', 15, 150, {
            commandId: '计划-1',
            kind: 'success',
            text: '已进入计划模式',
          }),
          event('command/run', 16, 160, {
            commandId: '导出-1',
            name: 'export',
            args: '',
            source: { kind: 'user' },
          }),
          event('command/done', 17, 170, {
            commandId: '导出-1',
            kind: 'error',
            text: '导出失败\n没有可写入的目标目录',
          }),
        ]}
      />,
    )
    expect(view.container.querySelectorAll('[data-command-id]')).toHaveLength(3)
    expect(screen.queryByText('正在压缩…')).toBeNull()
    expect(screen.queryByText('不重复显示的压缩注入')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /已压缩 3 条历史记录（约 123 tokens）/u }))
    expect(screen.getByText('保留的压缩摘要')).toBeTruthy()
    expect(screen.getByText('已进入计划模式')).toBeTruthy()
    const failure = screen.getByRole('button', { name: /export.*导出失败/u })
    expect(failure.closest('[data-error]')?.getAttribute('data-error')).toBe('true')
    fireEvent.click(failure)
    expect(view.container.querySelector('[data-command-id="导出-1"] pre')?.textContent).toContain(
      '没有可写入的目标目录',
    )
  })

  it('将标题、表格和围栏代码渲染为块级结构，并显示用户图片附件', async () => {
    const call = vi.fn(async () => 'data:image/png;base64,iVBORw0KGgo=')
    window.dshDesktop = { version: 19, host: { call } } as unknown as DesktopBridge
    const { container } = render(
      <ConversationView
        sessionId="会话-1"
        history={[
          event('user/message', 1, 100, {
            source: { kind: 'user' },
            content: [{ type: 'image', attachment: { attachmentId: '图片-1', name: '截图.png' } }],
          }),
          event('assistant/message', 2, 110, {
            message: {
              id: '回答-1',
              content: [
                {
                  type: 'text',
                  text: '## 结构\n\n| 目录 | 作用 |\n| --- | --- |\n| src | 源码 |\n\n```text\n├─ main\n└─ renderer\n```',
                },
              ],
            },
          }),
        ]}
      />,
    )
    expect(screen.getByRole('heading', { name: '结构' })).toBeTruthy()
    expect(screen.getByRole('table').textContent).toContain('源码')
    expect(container.querySelector('pre code')?.textContent).toBe('├─ main\n└─ renderer\n')
    await waitFor(() =>
      expect(screen.getByRole('img', { name: '截图.png' }).getAttribute('src')).toContain(
        'data:image/png',
      ),
    )
    expect(call).toHaveBeenCalledWith('getSessionAttachment', {
      sessionId: '会话-1',
      attachmentId: '图片-1',
    })
  })

  it('在用户与助手消息下方复制正文，并在官方反馈可用时写入或撤销评分', async () => {
    const writeText = vi.fn(async () => undefined)
    setClipboard(writeText)
    const feedback = {
      messageId: 'assistant-message-1',
      rating: 'positive' as const,
      version: 'v1',
    }
    const listFeedback = vi.fn(async () => ({ items: [] }))
    const putFeedback = vi.fn(async () => ({ kind: 'committed' as const, item: feedback }))
    const deleteFeedback = vi.fn(async () => ({ kind: 'committed' as const, item: null }))
    const history = [
      event('user/message', 1, 100, {
        source: { kind: 'user' },
        content: [{ type: 'text', text: '用户提问' }],
      }),
      event('assistant/message', 2, 110, {
        message: {
          id: 'assistant-message-1',
          content: [
            { type: 'reasoning', text: '不应复制的内部推理' },
            { type: 'text', text: '可以复制的最终回答' },
          ],
        },
      }),
    ]

    render(
      <ConversationView
        history={history}
        sessionId="会话-1"
        onListMessageFeedback={listFeedback}
        onPutMessageFeedback={putFeedback}
        onDeleteMessageFeedback={deleteFeedback}
      />,
    )

    const userRow = screen.getByText('用户提问').closest('li')
    const assistantRow = screen.getByText('可以复制的最终回答').closest('li')
    if (userRow === null || assistantRow === null) throw new Error('测试消息行缺失')
    expect(screen.queryByText('你')).toBeNull()
    expect(screen.queryByText('DSH')).toBeNull()

    fireEvent.click(within(userRow).getByRole('button', { name: '复制' }))
    fireEvent.click(within(assistantRow).getByRole('button', { name: '复制' }))
    await waitFor(() => {
      expect(writeText).toHaveBeenNthCalledWith(1, '用户提问')
      expect(writeText).toHaveBeenNthCalledWith(2, '可以复制的最终回答')
    })

    expect(within(userRow).queryByRole('button', { name: '好的回答' })).toBeNull()
    const assistantActions = assistantRow.querySelector('[aria-label="消息操作"]')
    if (assistantActions === null) throw new Error('测试消息操作缺失')
    fireEvent.mouseEnter(assistantActions)

    await waitFor(() => expect(listFeedback).toHaveBeenCalledWith('会话-1'))
    const helpful = within(assistantRow).getByRole('button', { name: '好的回答' })
    fireEvent.click(helpful)
    await waitFor(() =>
      expect(putFeedback).toHaveBeenCalledWith('会话-1', 'assistant-message-1', 'positive', null),
    )
    await waitFor(() =>
      expect(
        within(assistantRow).getByRole('button', { name: '取消标记' }).getAttribute('aria-pressed'),
      ).toBe('true'),
    )
    expect(within(assistantRow).getByRole('status').textContent).toBe('已标记为好的回答')

    fireEvent.click(within(assistantRow).getByRole('button', { name: '取消标记' }))
    await waitFor(() =>
      expect(deleteFeedback).toHaveBeenCalledWith('会话-1', 'assistant-message-1', 'v1'),
    )
    await waitFor(() =>
      expect(within(assistantRow).getByRole('status').textContent).toBe('已取消反馈'),
    )
  })

  it('网页 Clipboard 写入失败时使用 DSH Web 同款同步回退且不显示错误文案', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('剪贴板权限被拒绝')
    })
    const execCommand = vi.fn(() => true)
    setClipboard(writeText)
    setExecCommand(execCommand)
    render(
      <ConversationView
        history={[
          event('user/message', 1, 100, {
            source: { kind: 'user' },
            content: [{ type: 'text', text: '需要复制的内容' }],
          }),
        ]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '复制' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('需要复制的内容'))
    await waitFor(() => expect(execCommand).toHaveBeenCalledWith('copy'))
    expect(screen.getByRole('button', { name: '已复制' })).toBeTruthy()
    expect(screen.queryByText('无法写入系统剪贴板')).toBeNull()
    expect(document.querySelector('textarea[readonly]')).toBeNull()
  })

  it('不支持官方消息反馈时仍保留复制按钮', async () => {
    const listFeedback = vi.fn(async () => {
      throw new Error('当前 DSH Host 不支持所需能力')
    })
    render(
      <ConversationView
        history={[
          event('assistant/message', 1, 100, {
            message: {
              id: 'assistant-message-1',
              content: [{ type: 'text', text: '旧 Host 的回答' }],
            },
          }),
        ]}
        sessionId="会话-1"
        onListMessageFeedback={listFeedback}
        onPutMessageFeedback={vi.fn()}
        onDeleteMessageFeedback={vi.fn()}
      />,
    )

    const row = screen.getByText('旧 Host 的回答').closest('li')
    if (row === null) throw new Error('测试助手消息行缺失')
    const actions = row.querySelector('[aria-label="消息操作"]')
    if (actions === null) throw new Error('测试消息操作缺失')
    fireEvent.mouseEnter(actions)

    await waitFor(() => expect(listFeedback).toHaveBeenCalledWith('会话-1'))
    await waitFor(() => expect(within(row).queryByRole('button', { name: '好的回答' })).toBeNull())
    expect(within(row).getByRole('button', { name: '复制' })).toBeTruthy()
  })

  it('发送瞬间显示等待并在真实事件接管后不重复', () => {
    const view = render(<ConversationView history={[]} pendingSend loading />)
    expect(screen.getByRole('status').textContent).toContain('正在构思回复')
    expect(document.querySelectorAll('[data-variant="wave"] i')).toHaveLength(9)
    view.rerender(<ConversationView history={[]} running />)
    expect(screen.getByRole('status').textContent).toContain('正在构思回复')
    const history = [
      event('turn/start', 1, 100, { turn: 1 }),
      event('user/message', 2, 110, {
        source: { kind: 'user' },
        content: [{ type: 'text', text: '开始' }],
      }),
    ]
    view.rerender(<ConversationView history={history} running />)
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(document.querySelectorAll('[data-variant="wave"] i')).toHaveLength(9)
    view.rerender(<ConversationView history={history} />)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('工具过程更新时保留原有行节点，避免重复触发入场', () => {
    const history = [
      event('turn/start', 1, 100, { turn: 1 }),
      event('step/start', 2, 110, { turn: 1, step: 1 }),
      event('user/message', 3, 120, {
        source: { kind: 'user' },
        content: [{ type: 'text', text: '读取文件' }],
      }),
      event('tool/call', 4, 130, {
        turn: 1,
        step: 1,
        callId: '工具-1',
        name: 'read',
        arguments: '{"path":"a.ts"}',
      }),
    ]
    const view = render(<ConversationView history={history} running />)
    const row = document.querySelector('[data-tool-disclosure]')?.parentElement
    expect(row).toBeTruthy()
    view.rerender(
      <ConversationView
        history={[
          ...history,
          event('assistant/chunk', 5, 140, {
            turn: 1,
            step: 1,
            chunk: { type: 'reasoning-delta', index: 0, text: '继续检查' },
          }),
        ]}
        running
      />,
    )
    expect(document.querySelector('[data-tool-disclosure]')?.parentElement).toBe(row)
  })

  it('从首字等待切换到流式回复，并由最终消息原位替换而不重复', () => {
    const waitingHistory = [
      event('turn/start', 1, 1_700_000_000_000, { turn: 1 }),
      event('step/start', 2, 1_700_000_000_050, { turn: 1, step: 1 }),
      event('user/message', 3, 1_700_000_000_100, {
        source: { kind: 'user' },
        content: [{ type: 'text', text: '读取说明' }],
      }),
    ]
    const streamingHistory = [
      ...waitingHistory,
      event('assistant/chunk', 4, 1_700_000_000_200, {
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: '开始' },
      }),
      event('assistant/chunk', 5, 1_700_000_000_250, {
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: '读取' },
      }),
    ]
    const settledHistory = [
      ...streamingHistory,
      event('assistant/message', 6, 1_700_000_000_300, {
        turn: 1,
        step: 1,
        message: { content: [{ type: 'text', text: '最终读取结果' }] },
      }),
    ]

    const view = render(<ConversationView history={waitingHistory} running />)

    expect(screen.getByRole('status').textContent).toContain('正在构思回复')
    expect(document.querySelectorAll('[data-message-status="waiting"]')).toHaveLength(1)

    const retryHistory = [
      ...waitingHistory,
      event('llm/retry', 7, 1_700_000_000_200, {
        turn: 1,
        step: 1,
        retryId: '重连-1',
        retry: 3,
        maxRetries: 5,
        delayMs: 4000,
        failure: {
          code: 'NETWORK',
          message: '发送请求或等待响应失败：other side closed (UND_ERR_SOCKET)',
        },
      }),
    ]
    view.rerender(<ConversationView history={retryHistory} running />)
    expect(screen.getByRole('status').textContent).toContain('正在重试请求（3 / 5）')
    expect(screen.getByText(/可使用停止按钮取消/)).toBeTruthy()
    fireEvent.click(screen.getByText('查看上次失败原因'))
    expect(screen.getByText(/other side closed/)).toBeTruthy()
    view.rerender(
      <ConversationView
        history={[
          ...retryHistory,
          event('llm/retry-started', 8, 1_700_000_004_200, {
            turn: 1,
            step: 1,
            retryId: '重连-1',
            retry: 3,
          }),
        ]}
        running
      />,
    )
    expect(document.querySelector('[data-model-retry="requesting"]')).toBeTruthy()
    view.rerender(<ConversationView history={retryHistory} running={false} />)
    expect(document.querySelector('[data-model-retry]')).toBeNull()

    view.rerender(<ConversationView history={streamingHistory} running />)

    expect(screen.getByText('开始读取')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('生成中')
    expect(document.querySelectorAll('[data-streaming-cursor="true"]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-message-status="streaming"]')).toHaveLength(1)
    expect(screen.queryByText('DSH')).toBeNull()

    view.rerender(<ConversationView history={settledHistory} running />)

    expect(screen.getByText('读取说明')).toBeTruthy()
    expect(screen.getByText('最终读取结果')).toBeTruthy()
    expect(screen.queryByText('开始读取')).toBeNull()
    expect(document.querySelector('[data-streaming-cursor="true"]')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    expect(document.querySelectorAll('[data-message-status="settled"]')).toHaveLength(2)
    expect(document.querySelectorAll('[data-message-status="settled"][aria-busy]')).toHaveLength(0)
  })

  it('Think 默认折叠并按需渲染正文，用户展开后在完成时保持状态', async () => {
    const baseHistory = [
      event('turn/start', 1, 1_700_000_000_000, { turn: 2 }),
      event('step/start', 2, 1_700_000_000_050, { turn: 2, step: 1 }),
      event('user/message', 3, 1_700_000_000_100, {
        source: { kind: 'user' },
        content: [{ type: 'text', text: '分析当前问题' }],
      }),
    ]
    const firstReasoningHistory = [
      ...baseHistory,
      event('assistant/chunk', 4, 1_700_000_000_200, {
        turn: 2,
        step: 1,
        chunk: { type: 'reasoning-delta', index: 0, text: '先检查协议\n当前步骤' },
      }),
    ]
    const updatedReasoningHistory = [
      ...firstReasoningHistory,
      event('assistant/chunk', 5, 1_700_000_000_250, {
        turn: 2,
        step: 1,
        chunk: { type: 'reasoning-delta', index: 0, text: '\n最新进展' },
      }),
    ]
    const settledHistory = [
      ...updatedReasoningHistory,
      event('assistant/message', 6, 1_700_000_000_300, {
        turn: 2,
        step: 1,
        message: {
          content: [
            { type: 'reasoning', text: '最终推理首行\n最终推理次行' },
            { type: 'text', text: '最终回答仍然显示' },
          ],
        },
      }),
    ]

    const view = render(<ConversationView history={firstReasoningHistory} running />)

    let thinking = screen.getByText('Think').closest('details') as HTMLDetailsElement | null
    expect(thinking).not.toBeNull()
    expect(thinking?.open).toBe(false)
    expect(screen.getByRole('status').textContent).toContain('正在思考')
    expect(thinking?.querySelectorAll('[data-variant="star"] i')).toHaveLength(9)
    const initialSummary = screen.getByText('Think').closest('summary')
    expect(initialSummary?.textContent).toContain('当前步骤')
    expect(initialSummary?.nextElementSibling).toBeNull()

    fireEvent.click(initialSummary as HTMLElement)
    expect(thinking?.open).toBe(true)
    await waitFor(() =>
      expect(initialSummary?.nextElementSibling?.textContent).toBe('先检查协议\n当前步骤'),
    )

    view.rerender(<ConversationView history={updatedReasoningHistory} running />)

    thinking = screen.getByText('Think').closest('details') as HTMLDetailsElement | null
    expect(thinking?.open).toBe(true)
    const updatedSummary = screen.getByText('Think').closest('summary')
    expect(updatedSummary?.nextElementSibling?.textContent).toBe('先检查协议\n当前步骤\n最新进展')
    expect(updatedSummary?.textContent).toContain('最新进展')

    view.rerender(<ConversationView history={settledHistory} running />)

    thinking = screen.getByText('Think').closest('details') as HTMLDetailsElement | null
    expect(thinking?.open).toBe(true)
    expect(screen.getByText('最终回答仍然显示')).toBeTruthy()
    expect(document.querySelectorAll('[data-message-status="settled"]')).toHaveLength(2)
    const settledSummary = screen.getByText('Think').closest('summary')
    expect(settledSummary?.querySelector('[data-variant="star"]')).toBeNull()
    expect(settledSummary?.textContent).toContain('最终推理首行')
    expect(settledSummary?.nextElementSibling?.textContent).toBe('最终推理首行\n最终推理次行')

    const summary = screen.getByText('Think').closest('summary')
    expect(summary).not.toBeNull()
    fireEvent.click(summary as HTMLElement)
    expect(thinking?.open).toBe(false)
    await waitFor(() => expect(summary?.nextElementSibling).toBeNull())

    fireEvent.click(summary as HTMLElement)
    expect(thinking?.open).toBe(true)
    await waitFor(() =>
      expect(summary?.nextElementSibling?.textContent).toBe('最终推理首行\n最终推理次行'),
    )
  })

  it('reasoning block 完成并开始输出正文后只显示回复生成状态', () => {
    const history = [
      event('turn/start', 1, 1_700_000_000_000, { turn: 3 }),
      event('step/start', 2, 1_700_000_000_050, { turn: 3, step: 1 }),
      event('user/message', 3, 1_700_000_000_100, {
        source: { kind: 'user' },
        content: [{ type: 'text', text: '继续分析' }],
      }),
      event('assistant/chunk', 4, 1_700_000_000_150, {
        turn: 3,
        step: 1,
        chunk: { type: 'reasoning-delta', index: 0, text: '推理完成' },
      }),
      event('assistant/chunk', 5, 1_700_000_000_180, {
        turn: 3,
        step: 1,
        chunk: {
          type: 'block-end',
          index: 0,
          block: { type: 'reasoning', text: '推理完成' },
        },
      }),
      event('assistant/chunk', 6, 1_700_000_000_200, {
        turn: 3,
        step: 1,
        chunk: { type: 'text-delta', index: 1, text: '正文开始' },
      }),
    ]

    render(<ConversationView history={history} running />)

    expect(screen.getByText('Think')).toBeTruthy()
    const status = screen.getByRole('status')
    expect(status.textContent).toContain('生成中')
    expect(status.textContent).not.toContain('正在思考')
    expect(screen.getByText('正文开始')).toBeTruthy()
  })

  it('后续空 text block 已开始时不把上一段 reasoning 继续标成思考中', () => {
    const history = [
      event('turn/start', 1, 1_700_000_000_000, { turn: 4 }),
      event('step/start', 2, 1_700_000_000_050, { turn: 4, step: 1 }),
      event('user/message', 3, 1_700_000_000_100, {
        source: { kind: 'user' },
        content: [{ type: 'text', text: '继续' }],
      }),
      event('assistant/chunk', 4, 1_700_000_000_150, {
        turn: 4,
        step: 1,
        chunk: { type: 'reasoning-delta', index: 0, text: '上一段推理' },
      }),
      event('assistant/chunk', 5, 1_700_000_000_180, {
        turn: 4,
        step: 1,
        chunk: { type: 'block-start', index: 1, blockType: 'text' },
      }),
    ]

    render(<ConversationView history={history} running />)

    expect(screen.getByText('Think')).toBeTruthy()
    const status = screen.getByRole('status')
    expect(status.textContent).toContain('生成中')
    expect(status.textContent).not.toContain('正在思考')
  })

  it('过程回复不带消息操作，完成后只为最终回答保留操作，展开过程也不重复显示', () => {
    const history = [
      event('turn/start', 1, 100, { turn: 1 }),
      event('assistant/message', 2, 110, {
        turn: 1,
        step: 1,
        message: { content: [{ type: 'text', text: '先读取说明' }] },
      }),
      event('tool/call', 3, 120, {
        turn: 1,
        callId: '读取',
        name: 'read',
        arguments: '{"path":"README.md"}',
      }),
      event('tool/result', 4, 130, {
        turn: 1,
        message: {
          source: { callId: '读取' },
          content: [{ type: 'tool-result', content: [{ type: 'text', text: '读取完成' }] }],
        },
      }),
      event('assistant/message', 5, 140, {
        turn: 1,
        step: 2,
        message: {
          content: [
            { type: 'reasoning', text: '核对后得到结论' },
            { type: 'text', text: '最终回答' },
          ],
        },
      }),
    ]
    const view = render(<ConversationView sessionId="过程会话" history={history} running />)
    expect(screen.getByText('先读取说明')).toBeTruthy()
    expect(screen.getByText('Think')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '1 次工具调用 · 1 条消息' })).toBeNull()
    expect(view.container.querySelector('[aria-label="消息操作"], time')).toBeNull()

    const completed = [
      ...history,
      event('turn/end', 6, 150, { turn: 1, reason: { kind: 'completed' } }),
    ]
    view.rerender(<ConversationView sessionId="过程会话" history={completed} />)
    const toggle = screen.getByRole('button', { name: '1 次工具调用 · 1 条消息' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('先读取说明')).toBeNull()
    expect(screen.queryByText('Think')).toBeNull()
    expect(screen.getByText('最终回答')).toBeTruthy()
    expect(view.container.querySelectorAll('[aria-label="消息操作"]')).toHaveLength(1)
    expect(document.querySelector('time')?.closest('[aria-label="消息操作"]')).toBeTruthy()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('先读取说明')).toBeTruthy()
    expect(screen.getByText('Read')).toBeTruthy()
    expect(screen.getByText('Think')).toBeTruthy()
    expect(
      screen.getByText('先读取说明').closest('li')?.querySelector('[aria-label="消息操作"], time'),
    ).toBeNull()
    expect(view.container.querySelectorAll('[aria-label="消息操作"]')).toHaveLength(1)
    fireEvent.click(toggle)
    expect(screen.queryByText('Read')).toBeNull()
    expect(screen.getByText('最终回答')).toBeTruthy()
  })

  it('运行失败时保留过程与错误，不收起未完成的回复', () => {
    render(
      <ConversationView
        history={[
          event('turn/start', 1, 100, { turn: 1 }),
          event('assistant/message', 2, 110, {
            turn: 1,
            message: {
              content: [
                { type: 'reasoning', text: '检查连接' },
                { type: 'text', text: '暂未完成' },
              ],
            },
          }),
          event('turn/end', 3, 120, {
            turn: 1,
            reason: { kind: 'error', error: { message: '模型连接中断' } },
          }),
        ]}
      />,
    )
    expect(screen.getByText('Think')).toBeTruthy()
    expect(screen.getByText('暂未完成')).toBeTruthy()
    expect(screen.getByText('模型连接中断')).toBeTruthy()
    expect(document.querySelector('[data-turn-process]')).toBeNull()
  })

  it('把工具调用和结果合成一条默认折叠的披露行', () => {
    const history = [
      event('turn/start', 1, 1_700_000_000_000, { turn: 1 }),
      event('user/message', 2, 1_700_000_000_100, {
        content: [{ type: 'text', text: '读取说明' }],
      }),
      event('assistant/message', 3, 1_700_000_000_300, {
        turn: 1,
        message: { content: [{ type: 'text', text: '开始读取' }] },
      }),
      event('tool/call', 4, 1_700_000_000_400, {
        turn: 1,
        callId: 'call-1',
        name: 'read',
        arguments: '{"path":"README.md"}',
      }),
      event('tool/result', 5, 1_700_000_000_500, {
        turn: 1,
        message: {
          source: { callId: 'call-1' },
          content: [{ type: 'tool-result', content: [{ type: 'text', text: '读取完成' }] }],
        },
      }),
    ]

    render(<ConversationView history={history} />)

    expect(screen.getByText('开始读取')).toBeTruthy()
    const tool = screen.getByText('Read').closest('details') as HTMLDetailsElement | null
    expect(tool).not.toBeNull()
    expect(tool?.open).toBe(false)
    expect(tool?.querySelector('summary')?.textContent).toContain('README.md')
    fireEvent.click(tool?.querySelector('summary') as HTMLElement)
    expect(tool?.open).toBe(true)
    expect(screen.getByText('读取完成')).toBeTruthy()
  })

  it('文件补丁预览来自工具请求，并保留原始输入和结果', () => {
    const patch =
      '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-旧内容\n+新内容\n*** End Patch'
    const history = [
      event('turn/start', 1, 100, { turn: 1 }),
      event('tool/call', 2, 110, {
        turn: 1,
        step: 1,
        callId: '补丁-1',
        name: 'apply_patch',
        arguments: { patch },
      }),
      event('tool/result', 3, 120, {
        turn: 1,
        step: 1,
        message: {
          source: { callId: '补丁-1' },
          content: [{ type: 'tool-result', content: [{ type: 'text', text: '文件已更新' }] }],
        },
      }),
    ]
    render(<ConversationView history={history} />)
    const tool = screen.getByText('apply_patch').closest('details') as HTMLDetailsElement
    expect(tool.querySelector('summary')?.textContent).toContain('src/app.ts')
    fireEvent.click(tool.querySelector('summary') as HTMLElement)
    const preview = within(tool).getByRole('region', { name: '请求的文件补丁预览' })
    expect(within(preview).getByText('*** Update File: src/app.ts')).toBeTruthy()
    expect(within(preview).getByText('-旧内容').getAttribute('data-kind')).toBe('deletion')
    expect(within(preview).getByText('+新内容').getAttribute('data-kind')).toBe('addition')
    expect(within(tool).getByText('输入')).toBeTruthy()
    expect(within(tool).getByText('文件已更新')).toBeTruthy()
  })

  it('把运行时快照和技能目录显示为可展开的上下文注入行', () => {
    const history = [
      event('user/message', 1, 100, {
        source: {
          kind: 'plugin',
          plugin: '@deepseek-ai/dsh-system-prompt',
          form: 'snapshot',
          sections: [{ name: 'sandbox:policy', text: '工作区可写' }],
        },
        content: [{ type: 'text', text: '运行时上下文正文' }],
      }),
      event('user/message', 2, 110, {
        source: {
          kind: 'skill-catalog',
          form: 'catalog',
          entries: [{ name: 'archify', description: '创建架构图' }],
        },
        content: [{ type: 'text', text: '技能目录正文' }],
      }),
    ]

    render(<ConversationView history={history} />)

    expect(screen.queryByText('你')).toBeNull()
    const disclosures = document.querySelectorAll<HTMLDetailsElement>(
      '[data-context-disclosure="true"]',
    )
    expect(disclosures).toHaveLength(2)
    expect([...disclosures].every(disclosure => !disclosure.open)).toBe(true)
    expect(disclosures[0]?.querySelector('summary')?.textContent).toContain(
      '@deepseek-ai/dsh-system-prompt',
    )
    expect(disclosures[1]?.querySelector('summary')?.textContent).toContain('skill-catalog')

    fireEvent.click(disclosures[0]?.querySelector('summary') as HTMLElement)
    expect(disclosures[0]?.open).toBe(true)
    expect(within(disclosures[0] as HTMLElement).getByText('sandbox:policy')).toBeTruthy()
    expect(within(disclosures[0] as HTMLElement).getByText('工作区可写')).toBeTruthy()

    fireEvent.click(disclosures[1]?.querySelector('summary') as HTMLElement)
    expect(disclosures[1]?.open).toBe(true)
    expect(within(disclosures[1] as HTMLElement).getByText('archify')).toBeTruthy()
    expect(within(disclosures[1] as HTMLElement).getByText('创建架构图')).toBeTruthy()
  })

  it('显示加载、错误与空状态', () => {
    const view = render(<ConversationView history={[]} loading />)
    expect(screen.getByRole('status').textContent).toContain('正在读取对话')

    view.rerender(<ConversationView history={[]} error="连接已断开" />)
    expect(screen.getByRole('alert').textContent).toContain('连接已断开')

    view.rerender(<ConversationView history={[]} />)
    expect(screen.getByText('这个对话还没有消息')).toBeTruthy()
  })

  it('回到最新位于滚动区外，保留未读提示、阅读位置和点击吸底行为', () => {
    const history = [
      event('user/message', 1, 100, {
        content: [{ type: 'text', text: '已经读到的消息' }],
      }),
    ]
    const view = render(<ConversationView sessionId="定位验收" history={history} />)
    const scrollport = screen.getByRole('region', { name: '会话对话' })
    Object.defineProperties(scrollport, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1_200 },
    })
    scrollport.scrollTop = 240
    fireEvent.scroll(scrollport)
    const button = screen.getByRole('button', { name: '回到最新' })
    expect(scrollport.contains(button)).toBe(false)
    expect(button.parentElement).toBe(scrollport.parentElement)
    expect(button.nextElementSibling).toBe(scrollport)
    view.rerender(
      <ConversationView
        sessionId="定位验收"
        history={[
          ...history,
          event('user/message', 2, 200, { content: [{ type: 'text', text: '新消息' }] }),
        ]}
      />,
    )
    expect(scrollport.scrollTop).toBe(240)
    fireEvent.click(screen.getByRole('button', { name: '有新内容，回到最新' }))
    expect(scrollport.scrollTop).toBe(800)
    expect(screen.queryByRole('button', { name: /回到最新/u })).toBeNull()
  })

  it('接近顶部时自动加载更早历史，并阻止重复飞行请求', async () => {
    let resolveLoad: ((value: boolean) => void) | undefined
    const onLoadOlder = vi.fn(
      () =>
        new Promise<boolean>(resolve => {
          resolveLoad = resolve
        }),
    )
    render(
      <ConversationView
        history={[
          event('user/message', 1, 100, {
            content: [{ type: 'text', text: '当前已经读到的消息' }],
          }),
        ]}
        hasMore
        onLoadOlder={onLoadOlder}
      />,
    )

    const scrollport = screen.getByRole('region', { name: '会话对话' })
    Object.defineProperties(scrollport, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1_200 },
    })
    scrollport.scrollTop = 120
    fireEvent.scroll(scrollport)
    fireEvent.scroll(scrollport)

    expect(onLoadOlder).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: '加载更早消息' })).toBeNull()
    resolveLoad?.(true)
    await Promise.resolve()
  })

  it('更早历史加载失败时保留当前对话和重试入口', async () => {
    const onLoadOlder = vi.fn(async () => false)
    render(
      <ConversationView
        history={[
          event('user/message', 1, 100, {
            content: [{ type: 'text', text: '当前已经读到的消息' }],
          }),
        ]}
        hasMore
        error="上一页暂时不可用"
        onLoadOlder={onLoadOlder}
      />,
    )

    expect(screen.getByText('当前已经读到的消息')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '加载更早消息' })).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('上一页暂时不可用')
    fireEvent.click(screen.getByRole('button', { name: '重试加载' }))
    await waitFor(() => {
      expect(onLoadOlder).toHaveBeenCalledOnce()
    })
  })

  it('轮次刻度预览真实问答，点击未加载轮次后分页定位到开场消息', async () => {
    const turn = (number: number, seq: number) => [
      event('turn/start', seq, 100, { turn: number }),
      event('user/message', seq + 1, 110, {
        turn: number,
        source: { kind: 'user' },
        content: [{ type: 'text', text: `第 ${String(number)} 次提问` }],
      }),
      event('assistant/message', seq + 2, 120, {
        turn: number,
        message: { content: [{ type: 'text', text: `第 ${String(number)} 次回答` }] },
      }),
      event('turn/end', seq + 3, 130, { turn: number }),
    ]
    const older = turn(1, 0)
    const recent = turn(2, 4)
    const outline = [{ turn: 1, seq: 0, prompt: '历史提问摘要', response: '历史回答摘要' }]
    let finish: ((value: boolean) => void) | undefined
    const onLoadOlder = vi.fn(
      () =>
        new Promise<boolean>(resolve => {
          finish = resolve
        }),
    )
    const geometry = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        return { top: this.dataset.conversationSeq === '1' ? 220 : 0, bottom: 300 } as DOMRect
      })
    const view = render(
      <ConversationView
        sessionId="导航会话"
        history={recent}
        turnOutline={outline}
        hasMore
        onLoadOlder={onLoadOlder}
      />,
    )
    const nav = screen.getByRole('navigation', { name: '对话轮次导航' })
    expect(within(nav).getAllByRole('button')).toHaveLength(2)
    const earlier = within(nav).getByRole('button', { name: '跳转到第 1 轮：历史提问摘要' })
    fireEvent.focus(earlier)
    expect(screen.getByRole('tooltip').textContent).toContain('历史回答摘要')
    fireEvent.click(earlier)
    await waitFor(() => expect(onLoadOlder).toHaveBeenCalledOnce())
    await act(async () => {
      view.rerender(
        <ConversationView
          sessionId="导航会话"
          history={[...older, ...recent]}
          turnOutline={outline}
        />,
      )
      finish?.(true)
    })
    await waitFor(() =>
      expect(
        within(nav)
          .getByRole('button', { name: '跳转到第 1 轮：第 1 次提问' })
          .getAttribute('aria-busy'),
      ).toBe('false'),
    )
    expect(screen.getByRole('region', { name: '会话对话' }).scrollTop).toBe(192)
    geometry.mockRestore()
  })

  it('轮次分页失败后停止请求并允许重试，切换会话取消旧定位', async () => {
    const history = [
      event('turn/start', 10, 100, { turn: 2 }),
      event('user/message', 11, 110, { turn: 2, content: [{ type: 'text', text: '当前消息' }] }),
    ]
    const outline = [{ turn: 1, seq: 0, prompt: '更早一轮', response: '' }]
    const onLoadOlder = vi.fn(async () => false)
    const view = render(
      <ConversationView
        sessionId="甲"
        history={history}
        turnOutline={outline}
        hasMore
        onLoadOlder={onLoadOlder}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '跳转到第 1 轮：更早一轮' }))
    await screen.findByText('未能加载这一轮，请重试。')
    expect(onLoadOlder).toHaveBeenCalledOnce()
    let finish: ((value: boolean) => void) | undefined
    onLoadOlder.mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve
        }),
    )
    fireEvent.click(screen.getByRole('button', { name: '跳转到第 1 轮：更早一轮' }))
    await waitFor(() => expect(onLoadOlder).toHaveBeenCalledTimes(2))
    view.rerender(
      <ConversationView sessionId="乙" history={history} hasMore onLoadOlder={onLoadOlder} />,
    )
    finish?.(true)
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '跳转到第 1 轮：更早一轮' })).toBeNull(),
    )
    expect(onLoadOlder).toHaveBeenCalledTimes(2)
  })

  it('按明确目标打开各类文件，并只把本轮唯一产出或交付文件的简称变成按钮', () => {
    const openFile = vi.fn(async () => {})
    const openFileInMain = vi.fn(async () => {})
    const history = [
      event('tool/call', 1, 100, {
        turn: 1,
        callId: '写入',
        name: 'write',
        arguments: JSON.stringify({ file_path: 'apps/web/index.html', content: '页面' }),
      }),
      {
        ...event('tool/result', 2, 110, {
          turn: 1,
          message: {
            source: { kind: 'tool', callId: '写入' },
            content: [{ type: 'tool-result', isError: false }],
          },
        }),
        surfaceOp: 'append',
      },
      event('deliverables/presented', 3, 120, {
        turn: 1,
        callId: '交付',
        files: [{ path: 'output/report.docx' }],
      }),
      event('assistant/message', 4, 130, {
        turn: 1,
        message: {
          content: [
            {
              type: 'text',
              text: [
                'apps/web/（index.html + src/main.ts）',
                '`index.html` 和 `report.docx`；`unknown.ts` 保持原样。',
                '| 文件 | 说明 |\n| --- | --- |\n| [`index.html`](apps/web/index.html#L2-L4) | 页面 |',
                '[源码](src/main.ts) [图片](assets/chart.png) [报告](output/report.pdf) [配置](Dockerfile)',
                '[中文文件](/project/docs/中文%20说明.txt#L3)',
                '[网站](https://example.com) [重复引用][source]\n\n[source]: apps/web/index.html',
                '```html\nindex.html\n```',
              ].join('\n\n'),
            },
          ],
        },
      }),
      event('assistant/message', 5, 140, {
        turn: 2,
        message: { content: [{ type: 'text', text: '`index.html`' }] },
      }),
    ]
    const snapshot = parseDesktopSessionFrame({
      type: 'session/snapshot',
      sessionId: '文件会话',
      events: history,
      lastSeq: 5,
      hasMore: false,
    })
    const { container } = render(
      <ConversationView
        history={snapshot}
        projectCwd="/project"
        onOpenFile={openFile}
        onOpenFileInMain={openFileInMain}
      />,
    )
    const row = container.querySelector('[data-conversation-seq="4"]') as HTMLElement
    const buttons = within(row).getAllByRole('button', { name: 'index.html' })
    fireEvent.click(buttons[0]!)
    fireEvent.click(buttons[1]!)
    fireEvent.click(within(row).getByRole('button', { name: 'report.docx' }))
    fireEvent.click(within(row).getByRole('button', { name: '源码' }))
    fireEvent.click(within(row).getByRole('button', { name: '图片' }))
    fireEvent.click(within(row).getByRole('button', { name: '报告' }))
    fireEvent.click(within(row).getByRole('button', { name: '配置' }))
    fireEvent.click(within(row).getByRole('button', { name: '中文文件' }))
    fireEvent.contextMenu(buttons[0]!)
    fireEvent.click(screen.getByRole('menuitem', { name: '在文件模式中打开' }))
    expect(openFile.mock.calls).toEqual([
      ['apps/web/index.html'],
      ['apps/web/index.html', 2],
      ['output/report.docx'],
      ['src/main.ts'],
      ['assets/chart.png'],
      ['output/report.pdf'],
      ['Dockerfile'],
      ['docs/中文 说明.txt', 3],
    ])
    expect(openFileInMain).toHaveBeenCalledWith('apps/web/index.html')
    expect(buttons[0]!.querySelector('svg')).not.toBeNull()
    expect(buttons[1]!.getAttribute('title')).toBe('apps/web/index.html')
    const website = within(row).getByRole('link', { name: '网站' })
    expect(website.getAttribute('href')).toBe('https://example.com')
    expect(website.getAttribute('target')).toBe('_blank')
    expect(website.querySelector('svg')).not.toBeNull()
    expect(within(row).queryByRole('button', { name: 'unknown.ts' })).toBeNull()
    expect(row.querySelector('pre button, button button')).toBeNull()
    expect(container.querySelector('[data-conversation-seq="5"] code button')).toBeNull()
  })

  it('歧义、失败、未产出、后续才交付的文件以及越界链接保持不可点击，流式回复结束后才启用链接', () => {
    const openFile = vi.fn(async () => {})
    const text =
      '`index.html` `failed.ts` `read.ts` `later.pdf`\n\n[外部](/project-other/a.ts) [越界](%2E%2E/a.ts) [协议](file:///project/a.ts) [错误行号](a.ts#L4-L2)'
    const history = [
      event('tool/call', 1, 100, {
        turn: 1,
        callId: '失败',
        name: 'write',
        arguments: '{"file_path":"failed.ts","content":"内容"}',
      }),
      {
        ...event('tool/result', 2, 110, {
          turn: 1,
          message: {
            source: { kind: 'tool', callId: '失败' },
            content: [{ type: 'tool-result', isError: true }],
          },
        }),
        surfaceOp: 'append',
      },
      event('tool/call', 3, 120, {
        turn: 1,
        callId: '读取',
        name: 'read',
        arguments: '{"file_path":"read.ts"}',
      }),
      {
        ...event('tool/result', 4, 130, {
          turn: 1,
          message: {
            source: { kind: 'tool', callId: '读取' },
            content: [{ type: 'tool-result', isError: false }],
          },
        }),
        surfaceOp: 'append',
      },
      event('deliverables/presented', 5, 140, {
        turn: 1,
        callId: '交付',
        files: [{ path: 'a/index.html' }, { path: 'b/index.html' }],
      }),
      event('assistant/message', 6, 150, {
        turn: 1,
        message: { content: [{ type: 'text', text }] },
      }),
      event('deliverables/presented', 7, 160, {
        turn: 1,
        callId: '后续交付',
        files: [{ path: 'later.pdf' }],
      }),
      event('turn/start', 8, 170, { turn: 2 }),
      event('step/start', 9, 180, { turn: 2, step: 1 }),
      event('assistant/chunk', 10, 190, {
        turn: 2,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: '[源码](src/main.ts)' },
      }),
    ]
    const view = render(
      <ConversationView history={history} projectCwd="/project" onOpenFile={openFile} running />,
    )
    expect(view.container.querySelector('[data-conversation-seq="6"] code button')).toBeNull()
    expect(view.container.querySelector('[data-conversation-seq="6"] a')).toBeNull()
    expect(screen.queryByRole('button', { name: '外部' })).toBeNull()
    expect(screen.queryByRole('button', { name: '越界' })).toBeNull()
    expect(screen.queryByRole('button', { name: '错误行号' })).toBeNull()
    expect(screen.queryByRole('button', { name: '源码' })).toBeNull()
    expect(openFile).not.toHaveBeenCalled()
    view.rerender(
      <ConversationView
        projectCwd="/project"
        onOpenFile={openFile}
        history={[
          ...history,
          event('assistant/message', 11, 200, {
            turn: 2,
            step: 1,
            message: { content: [{ type: 'text', text: '[源码](src/main.ts)' }] },
          }),
        ]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '源码' }))
    expect(openFile).toHaveBeenCalledWith('src/main.ts')
  })

  it('运行中的队列显示真实条目，并提供插入当前轮、编辑和移除操作', async () => {
    const updateQueue = vi.fn(async () => true)
    const history = [
      event('assistant/message', 1, 1_700_000_000_000, {
        turn: 1,
        message: { content: [{ type: 'text', text: '正在处理' }] },
      }),
    ]

    render(
      <ConversationView
        history={history}
        sessionId="运行会话"
        running
        queue={{
          items: [
            {
              id: '排队项',
              placement: 'queued',
              preview: '继续检查',
              previewTruncated: false,
              edit: { kind: 'editable-text', text: '继续检查' },
            },
            {
              id: '插入项',
              placement: 'steering',
              preview: '补充说明',
              previewTruncated: false,
              edit: { kind: 'editable-text', text: '补充说明' },
            },
          ],
          totalCount: 2,
          omittedCount: 0,
          truncated: false,
        }}
        onUpdateQueue={updateQueue}
      />,
    )

    expect(screen.getByRole('region', { name: '消息队列' })).toBeTruthy()
    const toggle = screen.getByRole('button', { name: '展开待处理消息' })
    const listId = toggle.getAttribute('aria-controls') ?? ''
    const queueList = document.getElementById(listId) as HTMLOListElement | null
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(queueList?.hidden).toBe(true)

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(queueList?.hidden).toBe(false)
    expect(screen.getByLabelText('正在插入当前轮')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '插入当前轮' }))
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.change(screen.getByRole('textbox', { name: '编辑排队消息' }), {
      target: { value: '修改后的消息' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await vi.waitFor(() => {
      expect(updateQueue).toHaveBeenCalledWith('排队项', {
        kind: 'edit',
        content: [{ type: 'text', text: '修改后的消息' }],
      })
      expect(screen.queryByRole('textbox', { name: '编辑排队消息' })).toBeNull()
    })

    fireEvent.click(screen.getByRole('button', { name: '移除' }))
    expect(updateQueue).toHaveBeenCalledWith('排队项', { kind: 'steer' })
    expect(updateQueue).toHaveBeenCalledWith('排队项', { kind: 'remove' })
  })

  it('单条队列直接显示紧凑行，不增加折叠标题', () => {
    render(
      <ConversationView
        history={[
          event('assistant/message', 1, 100, {
            message: { content: [{ type: 'text', text: '处理中' }] },
          }),
        ]}
        running
        queue={{
          items: [
            {
              id: '单条项',
              placement: 'queued',
              preview: '继续检查当前改动',
              previewTruncated: false,
              edit: { kind: 'editable-text', text: '继续检查当前改动' },
            },
          ],
          totalCount: 1,
          omittedCount: 0,
          truncated: false,
        }}
      />,
    )

    expect(screen.queryByRole('button', { name: '展开待处理消息' })).toBeNull()
    expect(screen.getByRole<HTMLOListElement>('list', { name: '待处理消息列表' })).toHaveProperty(
      'hidden',
      false,
    )
    expect(screen.getByText('继续检查当前改动')).toBeTruthy()
  })

  it('超长队列正文只显示裁剪预览且禁止编辑，并提示未展开条目', () => {
    const updateQueue = vi.fn(async () => true)
    render(
      <ConversationView
        history={[
          event('assistant/message', 1, 100, {
            message: { content: [{ type: 'text', text: '处理中' }] },
          }),
        ]}
        running
        queue={{
          items: [
            {
              id: '超长项',
              placement: 'queued',
              preview: '超长内容预览',
              previewTruncated: true,
              edit: { kind: 'read-only', reason: 'text-too-large' },
            },
          ],
          totalCount: 201,
          omittedCount: 200,
          truncated: true,
        }}
        onUpdateQueue={updateQueue}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '展开待处理消息' }))
    expect(screen.getByText('超长内容预览…')).toBeTruthy()
    const edit = screen.getByRole<HTMLButtonElement>('button', { name: '编辑' })
    expect(edit.disabled).toBe(true)
    expect(edit.getAttribute('title')).toBe('消息过长，只能移除或插入，不能在桌面端编辑')
    expect(screen.getByText('另有 200 条未显示；前面的消息处理后会自动出现。')).toBeTruthy()
    fireEvent.click(edit)
    expect(updateQueue).not.toHaveBeenCalled()
  })

  it('会话运行时只显示停止按钮，并保留 Enter 加入队列', async () => {
    const hostCall = vi.fn<DesktopBridge['host']['call']>(async (operation, payload) => {
      if (operation === 'listSessions') {
        return {
          items: [
            {
              sessionId: '运行会话',
              updatedAt: 100,
              running: true,
              blank: false,
              cwd: '/work/运行项目',
            },
          ],
        }
      }
      if (operation === 'loadSessionPage') return { records: [], sessionId: payload.sessionId }
      if (operation === 'cancelSession' || operation === 'promptSession') return { accepted: true }
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    window.dshDesktop = composerBridge(hostCall)

    render(
      <Provider models={{ workspace: useWorkspaceModel }}>
        <Composer />
      </Provider>,
    )

    const input = await screen.findByPlaceholderText('Enter 加入队列，Cmd/Ctrl + Enter 插话发送…')
    expect(screen.getByRole('button', { name: '停止运行' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '加入队列' })).toBeNull()
    expect(screen.queryByRole('button', { name: '发送' })).toBeNull()

    fireEvent.change(input, { target: { value: '下一条任务' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: '停止运行' }))

    await vi.waitFor(() => {
      expect(hostCall).toHaveBeenCalledWith('cancelSession', { sessionId: '运行会话' })
      expect(hostCall).toHaveBeenCalledWith(
        'promptSession',
        expect.objectContaining({
          sessionId: '运行会话',
          mode: 'queue',
          content: [{ type: 'text', text: '下一条任务' }],
        }),
      )
    })
  })

  it('拖入普通文件使用会话附件回执，图片和原有项目引用保持独立', async () => {
    const hostCall = vi.fn<DesktopBridge['host']['call']>(async (operation, payload) => {
      if (operation === 'listSessions') {
        return {
          items: [
            {
              sessionId: '拖放会话',
              updatedAt: 100,
              running: false,
              blank: false,
              cwd: '/work/拖放项目',
            },
          ],
        }
      }
      if (operation === 'promptSession') return {}
      if (operation === 'loadSessionPage') return { records: [], sessionId: payload.sessionId }
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const imported = {
      name: '拖入.png',
      mediaType: 'image/png' as const,
      base64: 'iVBORw0KGgo=',
      bytes: 8,
    }
    const importImages = vi.fn(async (_images: readonly DesktopDroppedImage[]) => [imported])
    const resolveDroppedFiles = vi.fn(async () => [{ path: '说明.txt', kind: 'file' as const }])
    const bridge = composerBridge(hostCall)
    bridge.attachments = {
      chooseImages: async () => [],
      importImages,
      resolveDroppedFiles,
    }
    bridge.projects = {
      list: async () => [
        {
          id: '拖放项目访问',
          name: '拖放项目',
          cwd: '/work/拖放项目',
          displayPath: '/work/拖放项目',
          sessionCount: 1,
          lastActivity: 100,
        },
      ],
      call: async () => ({}),
    }
    const upload = vi.fn(async () => ({
      receiptId: '附件回执',
      file: { attachmentId: 'sha256:测试附件', name: '说明.txt', bytes: 6 },
    }))
    bridge.remote.call = upload
    window.dshDesktop = bridge

    render(
      <Provider models={{ workspace: useWorkspaceModel }}>
        <Composer />
      </Provider>,
    )
    const composer = await screen.findByLabelText('消息输入')
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], '拖入.png', {
      type: 'image/png',
    })
    Object.defineProperty(png, 'arrayBuffer', {
      value: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer,
    })
    const imageTransfer = { types: ['Files'], files: [png], dropEffect: 'none' }

    fireEvent.dragEnter(composer, { dataTransfer: imageTransfer })
    expect(screen.getByText('松开以附加文件或图片')).toBeTruthy()
    fireEvent.drop(composer, { dataTransfer: imageTransfer })

    await waitFor(() => {
      expect(importImages).toHaveBeenCalledOnce()
    })
    expect(screen.getByRole('img', { name: '拖入.png' })).toBeTruthy()
    expect(importImages.mock.calls[0]?.[0]).toEqual([
      {
        name: '拖入.png',
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      },
    ])

    const text = new File(['正文'], '说明.txt', { type: 'text/plain' })
    Object.defineProperty(text, 'arrayBuffer', {
      value: async () => new TextEncoder().encode('正文').buffer,
    })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '保留 @原文件.ts' } })
    fireEvent.drop(composer, {
      dataTransfer: { types: ['Files'], files: [text], dropEffect: 'none' },
    })
    await waitFor(() => {
      expect(screen.getByRole('list', { name: '待发送文件' }).textContent).toContain('已就绪')
    })
    expect(resolveDroppedFiles).not.toHaveBeenCalled()
    expect(upload).toHaveBeenCalledWith('fileUploads/upload', {
      agentId: '拖放会话',
      request: { data: btoa(unescape(encodeURIComponent('正文'))), name: '说明.txt' },
    })
    expect(importImages).toHaveBeenCalledOnce()
    const input = screen.getByRole('combobox') as HTMLTextAreaElement
    fireEvent.paste(input, { clipboardData: { files: [png], getData: () => '' } })
    await waitFor(() => {
      expect(screen.getAllByRole('img', { name: '拖入.png' })).toHaveLength(2)
    })
    expect(importImages).toHaveBeenCalledTimes(2)
    expect(input.value).toBe('保留 @原文件.ts')
    fireEvent.click(screen.getAllByRole('button', { name: '移除附件 拖入.png' })[1]!)
    expect(screen.getAllByRole('img', { name: '拖入.png' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => {
      expect(hostCall).toHaveBeenCalledWith(
        'promptSession',
        expect.objectContaining({
          sessionId: '拖放会话',
          content: expect.arrayContaining([{ type: 'file', receiptId: '附件回执' }]),
        }),
      )
    })
  })
})

function UnsavedSessionTabHarness() {
  const snapshot = useWorkspaceSnapshot()
  const workspace = useProjectWorkspace()
  return (
    <>
      <output aria-label="当前会话">{snapshot.selectedSessionId ?? '无会话'}</output>
      <output aria-label="当前视图">{snapshot.activeView}</output>
      <output aria-label="打开标签">{snapshot.openedSessionIds.join(',')}</output>
      <output aria-label="文件索引">{workspace.fileIndexStatus.phase}</output>
      <output aria-label="文件草稿">{workspace.fileDraft ?? '无草稿'}</output>
      <output aria-label="未保存提示">{workspace.unsavedChangesReason ?? '无提示'}</output>
      <button
        type="button"
        onClick={() => {
          void workspace.openFile('src/main.ts')
        }}
      >
        打开文件
      </button>
      <button
        type="button"
        onClick={() => {
          workspace.updateFileDraft('本地修改')
        }}
      >
        修改文件
      </button>
      <button
        type="button"
        onClick={() => {
          workspace.closeSessionTab('会话-1')
        }}
      >
        关闭会话标签
      </button>
      <button
        type="button"
        onClick={() => {
          workspace.selectSessionTab('会话-1')
        }}
      >
        返回会话标签
      </button>
      <button
        type="button"
        onClick={() => {
          void workspace.resolveUnsavedChanges('cancel')
        }}
      >
        取消关闭
      </button>
    </>
  )
}

describe('会话标签未保存保护', () => {
  it.each([
    { name: '编辑文件时关闭后台会话标签，保持文件与草稿', returnToChat: false },
    { name: '全部项目视图关闭前台最后会话标签，取消后保留标签和文件草稿', returnToChat: true },
  ])('$name', async ({ returnToChat }) => {
    const hostCall = vi.fn<DesktopBridge['host']['call']>(async (operation, payload) => {
      if (operation === 'listSessions')
        return {
          items: [
            {
              sessionId: '会话-1',
              updatedAt: 100,
              running: false,
              blank: false,
              cwd: '/work/项目',
            },
          ],
        }
      if (operation === 'loadSessionPage') return { records: [], sessionId: payload.sessionId }
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const bridge = composerBridge(hostCall)
    bridge.projects = {
      list: async () => [
        {
          id: '项目访问-1',
          name: '项目',
          cwd: '/work/项目',
          displayPath: '/work/项目',
          sessionCount: 1,
          lastActivity: 100,
        },
      ],
      call: async (operation, payload) => {
        if (operation === 'buildFileIndex') return { phase: 'ready', fileCount: 2 }
        if (operation === 'listDirectory')
          return {
            relativePath: '',
            entries: [
              { name: 'package.json', relativePath: 'package.json', kind: 'file' },
              { name: 'main.ts', relativePath: 'src/main.ts', kind: 'file' },
            ],
            truncated: false,
          }
        if (operation === 'gitSummary') return { available: true, files: [] }
        if (operation === 'gitGraph') return []
        if (operation === 'readFile') {
          const relativePath = String(payload.relativePath)
          const content = relativePath === 'package.json' ? '{"scripts":{}}' : '原内容'
          return {
            kind: 'text',
            relativePath,
            content,
            revision: `sha256:${'0'.repeat(64)}`,
            byteLength: content.length,
            lineCount: 1,
            language: relativePath.endsWith('.ts') ? 'typescript' : 'json',
          }
        }
        if (operation === 'cancelContentSearch') return { cancelled: true }
        throw new Error(`测试未处理项目操作：${operation}`)
      },
    }
    window.dshDesktop = bridge

    render(
      <Provider models={{ workspace: useWorkspaceModel }}>
        <ProjectWorkspaceProvider>
          <UnsavedSessionTabHarness />
        </ProjectWorkspaceProvider>
      </Provider>,
    )

    await waitFor(() => expect(screen.getByLabelText('文件索引').textContent).toBe('ready'))
    fireEvent.click(screen.getByRole('button', { name: '打开文件' }))
    await waitFor(() => expect(screen.getByLabelText('文件草稿').textContent).toBe('原内容'))
    fireEvent.click(screen.getByRole('button', { name: '修改文件' }))
    await waitFor(() => expect(screen.getByLabelText('文件草稿').textContent).toBe('本地修改'))

    if (returnToChat) fireEvent.click(screen.getByRole('button', { name: '返回会话标签' }))
    fireEvent.click(screen.getByRole('button', { name: '关闭会话标签' }))
    if (!returnToChat) {
      expect(screen.getByLabelText('未保存提示').textContent).toBe('无提示')
      expect(screen.getByLabelText('打开标签').textContent).toBe('')
      expect(screen.getByLabelText('当前视图').textContent).toBe('files')
      expect(screen.getByLabelText('文件草稿').textContent).toBe('本地修改')
      return
    }
    expect(screen.getByLabelText('未保存提示').textContent).toBe('关闭会话标签并切换到其他项目')
    expect(screen.getByLabelText('当前会话').textContent).toBe('会话-1')
    expect(screen.getByLabelText('打开标签').textContent).toBe('会话-1')

    fireEvent.click(screen.getByRole('button', { name: '取消关闭' }))
    await waitFor(() => expect(screen.getByLabelText('未保存提示').textContent).toBe('无提示'))
    expect(screen.getByLabelText('当前会话').textContent).toBe('会话-1')
    expect(screen.getByLabelText('打开标签').textContent).toBe('会话-1')
    expect(screen.getByLabelText('文件草稿').textContent).toBe('本地修改')
  })
})

describe('多文件工作区保护', () => {
  it('保护达到固定上限的脏预览，显式刷新读盘，切换文件不打断原文件重载', async () => {
    const disk = Object.fromEntries(
      [
        ...Array.from({ length: 12 }, (_, index) => `固定-${String(index)}.ts`),
        '预览.ts',
        '其他.ts',
      ].map(path => [path, '磁盘原文']),
    )
    const projectFile = (relativePath: string, text?: string) => {
      const content = text ?? disk[relativePath]!
      return {
        kind: 'text' as const,
        relativePath,
        content,
        revision: `sha256:${'0'.repeat(64)}`,
        byteLength: content.length,
        lineCount: 1,
        language: 'typescript',
      }
    }
    const deferredRead = Promise.withResolvers<ReturnType<typeof projectFile>>()
    let delayRead = false
    const hostCall = vi.fn<DesktopBridge['host']['call']>(async (operation, payload) => {
      if (operation === 'listSessions')
        return {
          items: [
            {
              sessionId: '会话-1',
              updatedAt: 100,
              running: false,
              blank: false,
              cwd: '/work/项目',
            },
          ],
        }
      if (operation === 'loadSessionPage') return { records: [], sessionId: payload.sessionId }
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const bridge = composerBridge(hostCall)
    bridge.projects = {
      list: async () => [
        {
          id: '项目访问-1',
          name: '项目',
          cwd: '/work/项目',
          displayPath: '/work/项目',
          sessionCount: 1,
          lastActivity: 100,
        },
      ],
      call: async (operation, payload) => {
        if (operation === 'buildFileIndex') return { phase: 'ready', fileCount: 14 }
        if (operation === 'listDirectory')
          return {
            relativePath: '',
            truncated: false,
            entries: Object.keys(disk).map(relativePath => ({
              name: relativePath,
              relativePath,
              kind: 'file',
            })),
          }
        if (operation === 'cancelContentSearch') return { cancelled: true }
        if (operation === 'readFile') {
          const path = String(payload.relativePath)
          return delayRead && path === '固定-0.ts' ? deferredRead.promise : projectFile(path)
        }
        throw new Error(`测试未处理项目操作：${operation}`)
      },
    }
    window.dshDesktop = bridge
    let workspace!: ReturnType<typeof useProjectWorkspace>
    function FileHarness() {
      workspace = useProjectWorkspace()
      return null
    }
    render(
      <Provider models={{ workspace: useWorkspaceModel }}>
        <ProjectWorkspaceProvider>
          <FileHarness />
        </ProjectWorkspaceProvider>
      </Provider>,
    )
    await waitFor(() => expect(workspace.fileIndexStatus.phase).toBe('ready'))
    for (let index = 0; index < 12; index++) {
      // 固定标签按用户打开顺序进入同一工作区。
      // oxlint-disable-next-line no-await-in-loop
      await act(async () => {
        await workspace.openPinnedFile(`固定-${String(index)}.ts`)
      })
    }
    await act(async () => {
      await workspace.openFile('预览.ts')
    })
    act(() => {
      workspace.updateFileDraft('不能丢失的草稿')
    })
    await act(async () => {
      await workspace.openFile('其他.ts')
    })
    expect(workspace.unsavedChangesPaths).toEqual(['预览.ts'])
    await act(async () => {
      await workspace.resolveUnsavedChanges('cancel')
    })
    expect(workspace.documents['预览.ts']?.fileDraft).toBe('不能丢失的草稿')
    expect(workspace.selectedFile?.relativePath).toBe('预览.ts')
    await act(async () => {
      await workspace.openFile('其他.ts')
      await workspace.resolveUnsavedChanges('discard')
    })
    expect(workspace.selectedFile?.relativePath).toBe('其他.ts')
    expect(workspace.documents['预览.ts']).toBeUndefined()

    await act(async () => {
      await workspace.openFile('固定-0.ts')
    })
    disk['固定-0.ts'] = '外部修改后的磁盘内容'
    await act(async () => {
      await workspace.refresh()
    })
    expect(workspace.fileDraft).toBe(disk['固定-0.ts'])
    delayRead = true
    let reload!: Promise<void>
    act(() => {
      reload = workspace.reloadSelectedFile()
    })
    expect(workspace.documents['固定-0.ts']?.fileSaving).toBe(true)
    await act(async () => {
      await workspace.openFile('固定-1.ts')
    })
    await act(async () => {
      deferredRead.resolve(projectFile('固定-0.ts', '重载完成'))
      await reload
    })
    expect(workspace.selectedFile?.relativePath).toBe('固定-1.ts')
    expect(workspace.documents['固定-0.ts']).toMatchObject({
      fileSaving: false,
      fileDraft: '重载完成',
    })
    await act(async () => {
      await workspace.openFile('固定-0.ts')
    })
    expect(workspace.fileSaving).toBe(false)
    expect(workspace.fileDraft).toBe('重载完成')
  })
})

describe('轨迹视图', () => {
  it('显示真实指标、按轮次分组并搜索条目', async () => {
    const history = [
      event('turn/start', 1, 1_000, { turn: 1 }),
      event('user/message', 2, 1_100, { content: [{ type: 'text', text: '检查项目' }] }),
      event('tool/call', 3, 1_200, { turn: 1, callId: 'call-1', name: 'search', arguments: 'src' }),
      event('tool/result', 4, 1_500, {
        turn: 1,
        message: { source: { callId: 'call-1' }, content: [{ type: 'text', text: '找到文件' }] },
      }),
      event('assistant/message', 5, 1_700, {
        turn: 1,
        message: { content: [{ type: 'text', text: '检查完成' }] },
      }),
      event('turn/end', 6, 2_000, { turn: 1 }),
      event('turn/start', 7, 3_000, { turn: 2 }),
      event('user/message', 8, 3_100, { content: [{ type: 'text', text: '准备部署' }] }),
      event('assistant/message', 9, 3_400, {
        turn: 2,
        message: { content: [{ type: 'text', text: '部署说明' }] },
      }),
      event('turn/end', 10, 4_000, { turn: 2 }),
    ]

    const onExport = vi.fn(async () => ({ status: 'saved' as const, fileName: '会话日志.zip' }))
    render(<TrajectoryView history={history} canExport onExport={onExport} />)

    const metrics = screen.getByLabelText('轨迹指标')
    expect(within(metrics).getByText('轮次').nextElementSibling?.textContent).toBe('2')
    expect(within(metrics).getByText('调用').nextElementSibling?.textContent).toBe('1')
    const overview = screen.getByLabelText('轨迹概览')
    expect(within(overview).getByLabelText('输入，2 个事件')).toBeTruthy()
    expect(within(overview).getByLabelText('模型，2 个事件')).toBeTruthy()
    expect(within(overview).getByLabelText('工具，1 个事件')).toBeTruthy()
    expect(overview.querySelectorAll('[data-trajectory-kind="input"]')).toHaveLength(2)
    expect(overview.querySelectorAll('[data-trajectory-kind="model"]')).toHaveLength(2)
    expect(overview.querySelectorAll('[data-trajectory-kind="tool"]')).toHaveLength(1)
    expect((overview.querySelector('[data-sequence="3"]') as HTMLElement).style.left).toBe('20%')
    expect(within(overview).getByText('记录顺序')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '按真实时长显示' }))
    expect(within(overview).getByText('0 毫秒')).toBeTruthy()
    expect(within(overview).getByText('2.30 秒')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '第 1 轮' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '第 2 轮' })).toBeTruthy()
    expect(screen.getByText('search src → 找到文件')).toBeTruthy()

    fireEvent.click(screen.getByText('search src → 找到文件'))
    expect(screen.getByText('call-1')).toBeTruthy()
    expect(screen.getByLabelText('轨迹记录检查器')).toBeTruthy()
    expect(screen.getByRole('tab', { name: '参数' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '结果' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '导出日志' }))
    await waitFor(() => {
      expect(screen.getByText('已导出 会话日志.zip')).toBeTruthy()
    })
    expect(onExport).toHaveBeenCalledOnce()

    fireEvent.change(screen.getByRole('searchbox', { name: '搜索轨迹' }), {
      target: { value: '部署' },
    })

    expect(screen.queryByRole('heading', { name: '第 1 轮' })).toBeNull()
    expect(screen.getByRole('heading', { name: '第 2 轮' })).toBeTruthy()
    expect(screen.getByText('准备部署')).toBeTruthy()
    expect(screen.getByText('部署说明')).toBeTruthy()
    expect(
      screen.getByLabelText('轨迹概览').querySelectorAll('[data-trajectory-kind]'),
    ).toHaveLength(5)
  })

  it('搜索无结果时给出明确状态', () => {
    const history = [
      event('turn/start', 1, 1_000, { turn: 1 }),
      event('user/message', 2, 1_100, { content: [{ type: 'text', text: '查看状态' }] }),
      event('turn/end', 3, 1_200, { turn: 1 }),
    ]
    render(<TrajectoryView history={history} />)

    fireEvent.change(screen.getByRole('searchbox', { name: '搜索轨迹' }), {
      target: { value: '不存在' },
    })
    expect(screen.getByText('没有匹配的轨迹')).toBeTruthy()
  })

  it('空会话轨迹视图不渲染顶部控制按钮、搜索框与空时间轴轨道', () => {
    render(<TrajectoryView history={[]} canExport />)

    expect(screen.getByText('这个对话还没有轨迹')).toBeTruthy()
    expect(screen.queryByRole('searchbox', { name: '搜索轨迹' })).toBeNull()
    expect(screen.queryByRole('toolbar', { name: '轨迹控制' })).toBeNull()
    expect(screen.queryByRole('button', { name: '按真实时长显示' })).toBeNull()
    expect(screen.queryByRole('button', { name: '导出日志' })).toBeNull()
    expect(screen.queryByLabelText('轨迹概览')).toBeNull()
  })
})

describe('会话搜索', () => {
  it('合并本地元数据与 Host 内容命中，并在关闭生命周期取消旧请求', async () => {
    const hostCall = vi.fn<DesktopBridge['host']['call']>(async (operation, payload) => {
      if (operation === 'listSessions') {
        return {
          items: [
            {
              sessionId: '本地标题',
              title: '数据库迁移计划',
              updatedAt: 200,
              running: false,
              blank: false,
              cwd: '/work/甲',
            },
            {
              sessionId: '内容命中',
              title: '服务排错',
              updatedAt: 100,
              running: false,
              blank: false,
              cwd: '/work/乙',
            },
          ],
        }
      }
      if (operation === 'loadSessionPage') return { records: [], sessionId: payload.sessionId }
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const searchSessions = vi.fn(async () => ({
      items: [{ sessionId: '内容命中', snippet: '聊天里记录了数据库迁移的失败原因' }],
      hasMore: false,
    }))
    const cancelSessionSearch = vi.fn(async () => undefined)
    const bridge = composerBridge(hostCall)
    bridge.host.searchSessions = searchSessions
    bridge.host.cancelSessionSearch = cancelSessionSearch
    window.dshDesktop = bridge
    const close = vi.fn()
    const view = render(
      <Provider models={{ workspace: useWorkspaceModel }}>
        <SessionSearch open onClose={close} />
      </Provider>,
    )

    await screen.findByRole('button', { name: /数据库迁移计划/u })
    fireEvent.change(screen.getByRole('searchbox', { name: '会话搜索词' }), {
      target: { value: '数据库迁移' },
    })

    await waitFor(() => {
      expect(searchSessions).toHaveBeenCalledWith('数据库迁移')
    })
    expect(await screen.findByText('聊天里记录了数据库迁移的失败原因')).toBeTruthy()
    expect(screen.getByRole('button', { name: /数据库迁移计划/u })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /服务排错/u }))
    expect(close).toHaveBeenCalledOnce()

    view.unmount()
    expect(cancelSessionSearch).toHaveBeenCalled()
  })
})

const composerSettings: DesktopSettings = {
  version: 7,
  revision: 0,
  colorScheme: 'system',
  canvasColorScheme: 'follow-interface',
  fontFamily: 'system',
  fontSize: 13,
  editorFontSize: 13,
  editorLineHeight: 'standard',
  editorLigatures: false,
  islandGap: 10,
  accentColor: '#5b6cff',
  canvasTransparency: 0,
  contentScrimOpacity: 0,
  backgrounds: { canvas: null, sidebar: null, content: null },
}

function composerBridge(hostCall: DesktopBridge['host']['call']): DesktopBridge {
  return {
    remote: {
      call: async () => {
        throw new Error('测试未声明扩展 Remote')
      },
      cancelCall: async () => {},
      follow: () => () => {},
    },
    setPluginBusyReasons: async () => {},
    getFrontendPlugins: async () => [],
    onFrontendPluginsChanged: () => () => undefined,
    version: 12,
    host: {
      status: async () => ({
        kind: 'ready',
        ownership: 'external',
        identity: { reportedVersion: '测试版本' },
      }),
      call: hostCall,
      onStatusChanged: () => () => undefined,
      onSessionFrame: () => () => undefined,
    },
    settings: {
      read: async () => composerSettings,
      update: async patch => ({ ...composerSettings, ...patch }),
      chooseBackground: async () => null,
      applyBackground: async () => composerSettings,
      cancelBackground: async () => undefined,
      clearBackground: async () => composerSettings,
      onChanged: () => () => undefined,
      onOpenRequested: () => () => undefined,
    },
  }
}
