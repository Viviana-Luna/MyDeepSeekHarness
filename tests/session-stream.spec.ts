import { describe, expect, it, vi } from 'vitest'

import {
  followDshSessionStream,
  SESSION_STREAM_MAX_FRAME_BYTES,
} from '../src/main/host/session-stream.ts'
import type {
  OpenSessionStreamSocket,
  SessionStreamSocket,
  SessionStreamSocketOptions,
} from '../src/main/host/session-stream.ts'
import type { DesktopSessionFrame } from '../src/shared/session-live.ts'

type OpenSocketCall = {
  readonly url: URL
  readonly options: SessionStreamSocketOptions
}

class FakeSessionStreamSocket implements SessionStreamSocket {
  readyState: SessionStreamSocket['readyState'] = 'connecting'

  private openListener: (() => void) | undefined
  private messageListener: Parameters<SessionStreamSocket['onMessage']>[0] | undefined
  private closeListener: Parameters<SessionStreamSocket['onClose']>[0] | undefined
  private errorListener: Parameters<SessionStreamSocket['onError']>[0] | undefined
  private unexpectedResponseListener:
    Parameters<SessionStreamSocket['onUnexpectedResponse']>[0] | undefined

  readonly sent: string[] = []
  readonly send = vi.fn((value: string) => {
    this.sent.push(value)
  })
  readonly close = vi.fn(() => {
    this.readyState = 'closing'
  })
  readonly terminate = vi.fn(() => {
    this.readyState = 'closed'
  })
  readonly removeAllListeners = vi.fn(() => {
    this.openListener = undefined
    this.messageListener = undefined
    this.closeListener = undefined
    this.errorListener = undefined
    this.unexpectedResponseListener = undefined
  })

  onOpen(listener: () => void): void {
    this.openListener = listener
  }
  onMessage(listener: Parameters<SessionStreamSocket['onMessage']>[0]): void {
    this.messageListener = listener
  }
  onClose(listener: Parameters<SessionStreamSocket['onClose']>[0]): void {
    this.closeListener = listener
  }
  onError(listener: Parameters<SessionStreamSocket['onError']>[0]): void {
    this.errorListener = listener
  }
  onUnexpectedResponse(listener: Parameters<SessionStreamSocket['onUnexpectedResponse']>[0]): void {
    this.unexpectedResponseListener = listener
  }

  emitOpen(): void {
    this.readyState = 'open'
    this.openListener?.()
  }
  emitMessage(value: unknown): void {
    this.messageListener?.(Buffer.from(JSON.stringify(value), 'utf8'), false)
  }
  emitClose(code: number): void {
    this.readyState = 'closed'
    this.closeListener?.(code)
  }
  emitError(error?: Error): void {
    this.errorListener?.(error)
  }
  emitUnexpectedResponse(statusCode: number): void {
    this.unexpectedResponseListener?.(statusCode)
  }
}

function socketHarness(): {
  readonly socket: FakeSessionStreamSocket
  readonly calls: OpenSocketCall[]
  readonly openSocket: OpenSessionStreamSocket
} {
  const socket = new FakeSessionStreamSocket()
  const calls: OpenSocketCall[] = []
  return {
    socket,
    calls,
    openSocket(url, options) {
      calls.push({ url, options })
      return socket
    },
  }
}

function openedStreams(socket: FakeSessionStreamSocket): Record<string, unknown>[] {
  return socket.sent
    .map(value => JSON.parse(value) as Record<string, unknown>)
    .filter(value => value.type === 'open')
}

function startFollowing(
  harness: ReturnType<typeof socketHarness>,
  overrides: Partial<Parameters<typeof followDshSessionStream>[0]> = {},
): ReturnType<typeof followDshSessionStream> {
  return followDshSessionStream({
    targetUrl: new URL('http://127.0.0.1:3080/旧路径?不应保留=1#片段'),
    signal: new AbortController().signal,
    sessionId: '会话-1',
    onFrame: vi.fn(),
    openSocket: harness.openSocket,
    ...overrides,
  })
}

describe('DSH Session Remote 事件流', () => {
  it('复用 remote.mux 投影控制基线、会话快照与 Assistant 临时流', async () => {
    const harness = socketHarness()
    const frames: DesktopSessionFrame[] = []
    const cookie = 'dsh-auth=只允许进入握手头'
    const following = startFollowing(harness, {
      cookie,
      onFrame: frame => {
        frames.push(frame)
      },
    })

    expect(harness.calls).toEqual([
      {
        url: new URL('ws://127.0.0.1:3080/api/remote.mux'),
        options: {
          cookie,
          handshakeTimeoutMs: 5_000,
          maxPayloadBytes: SESSION_STREAM_MAX_FRAME_BYTES,
        },
      },
    ])
    harness.socket.emitOpen()
    expect(openedStreams(harness.socket)).toEqual([
      {
        type: 'open',
        streamId: 'desktop-1',
        endpoint: 'session/follow',
        payload: {
          args: {
            request: {
              address: { kind: 'session', sessionId: '会话-1' },
              assistantStream: true,
              maxMessages: 25,
            },
          },
        },
      },
      { type: 'open', streamId: 'desktop-2', endpoint: 'session/control', payload: { args: {} } },
    ])

    harness.socket.emitMessage({
      type: 'item',
      streamId: 'desktop-2',
      value: {
        type: 'baseline',
        value: {
          jobs: {},
          projections: {
            '会话-1': {
              asOfSeq: 2,
              values: {
                inbox: {
                  'next-turn': [{ id: '队列-1', content: [{ type: 'text', text: '稍后处理' }] }],
                  'next-step': [
                    {
                      id: '权限通知',
                      source: { kind: 'plugin', plugin: 'user-approval' },
                      content: [{ type: 'text', text: '权限策略已改变' }],
                    },
                    {
                      id: '用户插话',
                      source: { kind: 'user' },
                      content: [{ type: 'text', text: '补充要求' }],
                    },
                  ],
                },
                自定义插件: { progress: 1 },
                permissions: {
                  currentValue: 'workspace-write',
                  options: [{ value: 'workspace-write', name: '工作区写入' }],
                },
                modelSelection: {
                  next: { provider: 'deepseek', model: 'deepseek-chat' },
                },
              },
            },
          },
        },
      },
    })
    harness.socket.emitMessage({
      type: 'item',
      streamId: 'desktop-1',
      value: {
        type: 'snapshot',
        header: { id: '会话-1' },
        cursor: 3,
        records: [
          {
            type: 'event',
            event: { type: 'turn/start', seq: 3, time: 1_000, data: { turn: 1 } },
          },
        ],
        hasMore: false,
        projections: { asOfSeq: 3, values: { title: '真实标题', 自定义插件: { progress: 2 } } },
        assistantStream: {
          revision: 7,
          activeAttempt: {
            attemptId: 'attempt-1',
            startedAfterSeq: 3,
            turn: 1,
            step: 1,
            nextIndex: 2,
            stream: [
              {
                type: 'text-chunks',
                time0: 1_010,
                index: 0,
                dt: [2],
                texts: ['你', '好'],
              },
            ],
          },
        },
      },
    })
    harness.socket.emitMessage({
      type: 'item',
      streamId: 'desktop-1',
      value: {
        type: 'assistant-stream',
        frame: {
          type: 'chunk',
          attemptId: 'attempt-1',
          revision: 8,
          index: 2,
          time: 1_014,
          chunk: { type: 'text-delta', index: 0, text: '！' },
        },
      },
    })
    harness.socket.emitMessage({
      type: 'item',
      streamId: 'desktop-1',
      value: {
        type: 'event',
        event: {
          type: 'assistant/message',
          seq: 4,
          time: 1_020,
          data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '你好！' }] } },
        },
      },
    })
    harness.socket.emitMessage({
      type: 'item',
      streamId: 'desktop-1',
      value: {
        type: 'assistant-stream',
        frame: {
          type: 'end',
          attemptId: 'attempt-1',
          revision: 9,
          index: 3,
          outcome: { kind: 'committed', eventType: 'assistant/message', seq: 4 },
        },
      },
    })
    harness.socket.emitClose(1000)

    await expect(following).resolves.toEqual({ kind: 'disconnected', reason: 'eof' })
    expect(frames[0]).toEqual({ type: 'session/stream-reset' })
    expect(frames).toContainEqual({
      type: 'session/queue',
      sessionId: '会话-1',
      queue: {
        items: [
          {
            id: '用户插话',
            placement: 'steering',
            preview: '补充要求',
            previewTruncated: false,
            edit: { kind: 'editable-text', text: '补充要求' },
          },
          {
            id: '队列-1',
            placement: 'queued',
            preview: '稍后处理',
            previewTruncated: false,
            edit: { kind: 'editable-text', text: '稍后处理' },
          },
        ],
        totalCount: 2,
        omittedCount: 0,
        truncated: false,
      },
    })
    expect(frames).toContainEqual({
      type: 'session/permissions',
      sessionId: '会话-1',
      seq: 2,
      value: {
        currentValue: 'workspace-write',
        options: [{ value: 'workspace-write', name: '工作区写入' }],
      },
    })
    expect(frames).toContainEqual({
      type: 'session/model-selection',
      sessionId: '会话-1',
      seq: 2,
      value: { next: { provider: 'deepseek', model: 'deepseek-chat' } },
    })
    expect(frames).toContainEqual({
      type: 'session/title',
      sessionId: '会话-1',
      seq: 3,
      title: '真实标题',
    })
    expect(frames.filter(frame => frame.type === 'session/plugin-projections')).toEqual([
      {
        type: 'session/plugin-projections',
        sessionId: '会话-1',
        change: {
          kind: 'snapshot',
          asOfSeq: 2,
          values: { 自定义插件: { progress: 1 } },
          omitted: 0,
        },
      },
      {
        type: 'session/plugin-projections',
        sessionId: '会话-1',
        change: {
          kind: 'snapshot',
          asOfSeq: 3,
          values: { 自定义插件: { progress: 2 } },
          omitted: 0,
        },
      },
    ])
    const snapshots = frames.filter(frame => frame.type === 'session/snapshot')
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatchObject({ sessionId: '会话-1', lastSeq: 3, hasMore: false })
    expect(snapshots[0]?.events.map(event => event.type)).toEqual([
      'turn/start',
      'assistant/chunk',
      'assistant/chunk',
    ])
    expect(
      snapshots[0]?.events
        .slice(1)
        .map(event => (event.data as { chunk: { text: string } }).chunk.text),
    ).toEqual(['你', '好'])
    const chunks = frames.filter(
      (
        frame,
      ): frame is Extract<
        DesktopSessionFrame,
        {
          readonly type: 'session/event'
        }
      > => frame.type === 'session/event' && frame.event.type === 'assistant/chunk',
    )
    expect(
      chunks.map(frame => (frame.event.data as { chunk: { text: string } }).chunk.text),
    ).toEqual(['！'])
    expect(chunks.every(frame => !Number.isInteger(frame.event.seq))).toBe(true)
    expect(frames.at(-1)).toEqual({
      type: 'session/event',
      sessionId: '会话-1',
      event: {
        type: 'assistant/message',
        seq: 4,
        time: 1_020,
        data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '你好！' }] } },
      },
    })
    expect(JSON.stringify(frames)).not.toContain(cookie)
  })

  it('快速切换只替换会话逻辑流，忽略旧快照并在退出时清理订阅', async () => {
    const harness = socketHarness()
    const frames: DesktopSessionFrame[] = []
    const controller = new AbortController()
    const stopSelection = vi.fn()
    let select: ((id: string | undefined) => void) | undefined
    const following = startFollowing(harness, {
      signal: controller.signal,
      onFrame: frame => {
        frames.push(frame)
      },
      subscribeSelection: listener => {
        select = listener
        return stopSelection
      },
    })
    harness.socket.emitOpen()
    expect(select).toBeDefined()
    select?.('会话-2')
    const snapshot = {
      type: 'snapshot',
      cursor: -1,
      records: [],
      hasMore: false,
      projections: { asOfSeq: -1, values: {} },
    }
    harness.socket.emitMessage({
      type: 'item',
      streamId: 'desktop-1',
      value: { ...snapshot, header: { id: '会话-1' } },
    })
    harness.socket.emitMessage({ type: 'end', streamId: 'desktop-1' })
    harness.socket.emitMessage({
      type: 'item',
      streamId: 'desktop-3',
      value: { ...snapshot, header: { id: '会话-2' } },
    })
    await vi.waitFor(() => {
      expect(frames).toHaveLength(2)
    })
    expect(frames[0]).toMatchObject({ type: 'session/snapshot', sessionId: '会话-2' })
    expect(harness.calls).toHaveLength(1)
    expect(
      openedStreams(harness.socket).filter(stream => stream.endpoint === 'session/control'),
    ).toHaveLength(1)
    expect(harness.socket.sent).toContain(JSON.stringify({ type: 'cancel', streamId: 'desktop-1' }))
    controller.abort()
    await expect(following).resolves.toEqual({ kind: 'aborted' })
    expect(stopSelection).toHaveBeenCalledOnce()
    expect(harness.socket.sent).toContain(JSON.stringify({ type: 'cancel', streamId: 'desktop-3' }))
  })

  it('尚未选择会话时只订阅 Host-wide control', async () => {
    const harness = socketHarness()
    const frames: DesktopSessionFrame[] = []
    const following = followDshSessionStream({
      targetUrl: new URL('http://127.0.0.1:3080/'),
      signal: new AbortController().signal,
      onFrame: frame => {
        frames.push(frame)
      },
      openSocket: harness.openSocket,
    })
    harness.socket.emitOpen()
    expect(openedStreams(harness.socket)).toEqual([
      {
        type: 'open',
        streamId: 'desktop-1',
        endpoint: 'session/control',
        payload: { args: {} },
      },
    ])
    harness.socket.emitMessage({
      type: 'item',
      streamId: 'desktop-1',
      value: { type: 'baseline', value: { jobs: {}, projections: {} } },
    })
    harness.socket.emitClose(1000)
    await expect(following).resolves.toEqual({ kind: 'disconnected', reason: 'eof' })
    expect(frames).toEqual([{ type: 'session/stream-reset' }])
  })

  it('Assistant 帧失序时失败关闭，流错误不泄露 Cookie', async () => {
    const harness = socketHarness()
    const cookie = 'dsh-auth=secret'
    const following = startFollowing(harness, { cookie })
    harness.socket.emitOpen()
    harness.socket.emitMessage({
      type: 'item',
      streamId: 'desktop-1',
      value: {
        type: 'snapshot',
        header: { id: '会话-1' },
        cursor: 0,
        records: [],
        hasMore: false,
        projections: { asOfSeq: -1, values: {} },
        assistantStream: { revision: 1 },
      },
    })
    harness.socket.emitMessage({
      type: 'item',
      streamId: 'desktop-1',
      value: {
        type: 'assistant-stream',
        frame: {
          type: 'chunk',
          attemptId: 'missing',
          revision: 1,
          index: 2,
          time: 1_000,
          chunk: { type: 'text-delta', index: 0, text: cookie },
        },
      },
    })
    await expect(following).rejects.toThrow('attempt 不匹配')
    await expect(following).rejects.not.toThrow(cookie)
    expect(harness.socket.terminate).toHaveBeenCalledOnce()
  })

  it('支持 404 能力降级和调用方取消', async () => {
    const missingHarness = socketHarness()
    const missing = startFollowing(missingHarness)
    missingHarness.socket.emitUnexpectedResponse(404)
    await expect(missing).resolves.toEqual({ kind: 'capability-unavailable' })

    const cancelHarness = socketHarness()
    const controller = new AbortController()
    const cancelled = startFollowing(cancelHarness, { signal: controller.signal })
    cancelHarness.socket.emitOpen()
    controller.abort()
    await expect(cancelled).resolves.toEqual({ kind: 'aborted' })
    expect(cancelHarness.socket.close).toHaveBeenCalledOnce()
  })
})
