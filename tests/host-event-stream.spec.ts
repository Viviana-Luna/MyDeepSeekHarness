import { describe, expect, it, vi } from 'vitest'

import {
  followDshHostEventStream,
  HOST_EVENT_STREAM_MAX_FRAME_BYTES,
  readDshWorkspaceBaseline,
} from '../src/main/host/host-event-stream.ts'
import type {
  HostEventStreamSocket,
  HostEventStreamSocketOptions,
  OpenHostEventStreamSocket,
} from '../src/main/host/host-event-stream.ts'
import type { DesktopHostFrame } from '../src/shared/host-live.ts'
import type { DesktopSessionFrame } from '../src/shared/session-live.ts'

type OpenSocketCall = {
  readonly url: URL
  readonly options: HostEventStreamSocketOptions
}

function textFrame(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8')
}

class FakeHostEventStreamSocket implements HostEventStreamSocket {
  readyState: HostEventStreamSocket['readyState'] = 'connecting'

  private openListener: (() => void) | undefined
  private messageListener: Parameters<HostEventStreamSocket['onMessage']>[0] | undefined
  private closeListener: Parameters<HostEventStreamSocket['onClose']>[0] | undefined
  private errorListener: Parameters<HostEventStreamSocket['onError']>[0] | undefined
  private unexpectedResponseListener:
    Parameters<HostEventStreamSocket['onUnexpectedResponse']>[0] | undefined

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
  onMessage(listener: Parameters<HostEventStreamSocket['onMessage']>[0]): void {
    this.messageListener = listener
  }
  onClose(listener: Parameters<HostEventStreamSocket['onClose']>[0]): void {
    this.closeListener = listener
  }
  onError(listener: Parameters<HostEventStreamSocket['onError']>[0]): void {
    this.errorListener = listener
  }
  onUnexpectedResponse(
    listener: Parameters<HostEventStreamSocket['onUnexpectedResponse']>[0],
  ): void {
    this.unexpectedResponseListener = listener
  }

  emitOpen(): void {
    this.readyState = 'open'
    this.openListener?.()
  }
  emitMessage(value: unknown, isBinary = false): void {
    this.messageListener?.(Buffer.isBuffer(value) ? value : textFrame(value), isBinary)
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
  readonly socket: FakeHostEventStreamSocket
  readonly calls: OpenSocketCall[]
  readonly openSocket: OpenHostEventStreamSocket
} {
  const socket = new FakeHostEventStreamSocket()
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

function openedStreams(socket: FakeHostEventStreamSocket): Record<string, unknown>[] {
  return socket.sent
    .map(value => JSON.parse(value) as Record<string, unknown>)
    .filter(value => value.type === 'open')
}

function startFollowing(
  harness: ReturnType<typeof socketHarness>,
  overrides: Partial<Parameters<typeof followDshHostEventStream>[0]> = {},
): ReturnType<typeof followDshHostEventStream> {
  return followDshHostEventStream({
    targetUrl: new URL('http://127.0.0.1:3080/旧路径?不应保留=1#片段'),
    signal: new AbortController().signal,
    onFrame: vi.fn(),
    openSocket: harness.openSocket,
    ...overrides,
  })
}

const workspace = {
  workspaceId: '工作区-1',
  path: '/Users/test-user/项目',
  title: '项目',
  sessionIds: ['会话-1'],
  createdAt: '2026-08-29T16:00:00.000Z',
  updatedAt: '2026-08-30T01:00:00.000Z',
}

describe('DSH Host Remote 事件流', () => {
  it('在固定 remote.mux 上打开 $events 与 Workspace 流，并发布生命周期和交互投影', async () => {
    const harness = socketHarness()
    const hostFrames: DesktopHostFrame[] = []
    const sessionFrames: DesktopSessionFrame[] = []
    const targets: unknown[] = []
    const cookie = 'dsh-auth=只允许进入握手头'
    const following = startFollowing(harness, {
      cookie,
      onFrame: frame => {
        hostFrames.push(frame)
      },
      onSessionFrame: (frame, target) => {
        sessionFrames.push(frame)
        targets.push(target)
      },
    })

    expect(harness.calls).toEqual([
      {
        url: new URL('ws://127.0.0.1:3080/api/remote.mux'),
        options: {
          cookie,
          handshakeTimeoutMs: 5_000,
          maxPayloadBytes: HOST_EVENT_STREAM_MAX_FRAME_BYTES,
        },
      },
    ])
    harness.socket.emitOpen()
    expect(openedStreams(harness.socket)).toEqual([
      { type: 'open', streamId: 'desktop-1', endpoint: '$events', payload: { args: {} } },
      { type: 'open', streamId: 'desktop-2', endpoint: 'workspace/follow', payload: { args: {} } },
    ])

    harness.socket.emitMessage({
      type: 'item',
      streamId: 'desktop-1',
      value: { type: 'ready', clientId: 'client-1', host: { home: '/Users/test-user' } },
    })
    harness.socket.emitMessage({
      type: 'item',
      streamId: 'desktop-1',
      value: {
        type: 'emit',
        event: 'api-session/added',
        args: [{ sessionId: '会话-1', updatedAt: 1, running: false, blank: true }],
      },
    })
    harness.socket.emitMessage({
      type: 'item',
      streamId: 'desktop-1',
      value: { type: 'emit', event: 'api-session/status', args: ['会话-1', true] },
    })
    harness.socket.emitMessage({
      type: 'item',
      streamId: 'desktop-2',
      value: { type: 'baseline', value: { items: [workspace], archivedSessionIds: ['旧会话'] } },
    })
    harness.socket.emitMessage({
      type: 'item',
      streamId: 'desktop-1',
      value: {
        type: 'waterfall',
        event: 'approval/request',
        eventId: 'event-approval',
        agentId: '会话-1',
        request: { toolName: 'Bash', callId: 'call-1', reason: '运行检查' },
      },
    })
    harness.socket.emitMessage({
      type: 'item',
      streamId: 'desktop-1',
      value: {
        type: 'waterfall',
        event: 'user-questions/request',
        eventId: 'event-question',
        agentId: '会话-1',
        request: { questions: [{ id: 'choice', question: '继续吗？' }] },
      },
    })
    harness.socket.emitMessage({
      type: 'item',
      streamId: 'desktop-1',
      value: { type: 'cancel', eventId: 'event-question' },
    })
    harness.socket.emitClose(1000)

    await expect(following).resolves.toEqual({ kind: 'disconnected', reason: 'eof' })
    expect(hostFrames).toEqual([
      { type: 'host/session-added', sessionId: '会话-1', blank: true },
      { type: 'host/session-status', sessionId: '会话-1', running: true },
      { type: 'host/workspace-changed', workspace },
      { type: 'host/workspace-order-changed', workspaceIds: ['工作区-1'] },
      { type: 'host/archived-sessions-changed', archivedSessionIds: ['旧会话'] },
    ])
    expect(sessionFrames).toEqual([
      {
        type: 'session/interaction-requested',
        sessionId: '会话-1',
        interaction: {
          kind: 'approval',
          key: 'approval:event-approval',
          approvalId: 'event-approval',
          toolName: 'Bash',
          callId: 'call-1',
          reason: '运行检查',
        },
      },
      {
        type: 'session/interaction-requested',
        sessionId: '会话-1',
        interaction: {
          kind: 'question',
          key: 'question:event-question',
          questions: [{ id: 'choice', question: '继续吗？' }],
        },
      },
      {
        type: 'session/interaction-resolved',
        sessionId: '会话-1',
        resolution: { kind: 'question', key: 'question:event-question', outcome: 'cancelled' },
      },
    ])
    expect(targets[0]).toEqual({
      clientId: 'client-1',
      eventId: 'event-approval',
      event: 'approval/request',
    })
    expect(JSON.stringify([...hostFrames, ...sessionFrames])).not.toContain(cookie)
  })

  it('从 workspace/follow 的首帧读取一次性基线', async () => {
    const harness = socketHarness()
    const reading = readDshWorkspaceBaseline({
      targetUrl: new URL('http://127.0.0.1:3080/'),
      openSocket: harness.openSocket,
    })
    harness.socket.emitOpen()
    expect(openedStreams(harness.socket)).toEqual([
      {
        type: 'open',
        streamId: 'desktop-1',
        endpoint: 'workspace/follow',
        payload: { args: {} },
      },
    ])
    harness.socket.emitMessage({
      type: 'item',
      streamId: 'desktop-1',
      value: { type: 'baseline', value: { items: [workspace], archivedSessionIds: [] } },
    })
    await expect(reading).resolves.toEqual({ items: [workspace], archivedSessionIds: [] })
    expect(harness.socket.close).toHaveBeenCalledOnce()
  })

  it('404 明确表示能力缺失，预先取消不会创建 socket', async () => {
    const harness = socketHarness()
    const following = startFollowing(harness)
    harness.socket.emitUnexpectedResponse(404)
    await expect(following).resolves.toEqual({ kind: 'capability-unavailable' })

    const aborted = new AbortController()
    aborted.abort()
    const openSocket = vi.fn<OpenHostEventStreamSocket>()
    await expect(
      followDshHostEventStream({
        targetUrl: new URL('http://127.0.0.1:3080/'),
        signal: aborted.signal,
        onFrame: vi.fn(),
        openSocket,
      }),
    ).resolves.toEqual({ kind: 'aborted' })
    expect(openSocket).not.toHaveBeenCalled()
  })

  it('拒绝未知逻辑流、无效 JSON、二进制和超限帧', async () => {
    const cases = [
      { value: { type: 'item', streamId: 'unknown', value: {} }, message: '未知逻辑流标识' },
      { value: Buffer.from('{坏掉}', 'utf8'), message: '不是有效 JSON' },
      {
        value: textFrame({ type: 'item', streamId: 'desktop-1', value: {} }),
        binary: true,
        message: '二进制',
      },
      { value: Buffer.alloc(HOST_EVENT_STREAM_MAX_FRAME_BYTES + 1, 0x61), message: '超过大小上限' },
    ]
    await Promise.all(
      cases.map(async candidate => {
        const harness = socketHarness()
        const following = startFollowing(harness)
        harness.socket.emitOpen()
        harness.socket.emitMessage(candidate.value, candidate.binary)
        await expect(following).rejects.toThrow(candidate.message)
        expect(harness.socket.terminate).toHaveBeenCalledOnce()
      }),
    )
  })

  it('等待异步投影完成后才处理正常关闭', async () => {
    const harness = socketHarness()
    let release: (() => void) | undefined
    const blocked = new Promise<void>(resolve => {
      release = resolve
    })
    const frames: DesktopHostFrame[] = []
    const following = startFollowing(harness, {
      onFrame: async frame => {
        await blocked
        frames.push(frame)
      },
    })
    harness.socket.emitOpen()
    harness.socket.emitMessage({
      type: 'item',
      streamId: 'desktop-1',
      value: { type: 'ready', clientId: 'client-1', host: { home: '/Users/test-user' } },
    })
    harness.socket.emitMessage({
      type: 'item',
      streamId: 'desktop-1',
      value: { type: 'emit', event: 'api-session/removed', args: ['会话-1'] },
    })
    harness.socket.emitClose(1000)
    let settled = false
    void following.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    release?.()
    await expect(following).resolves.toEqual({ kind: 'disconnected', reason: 'eof' })
    expect(frames).toEqual([{ type: 'host/session-removed', sessionId: '会话-1' }])
  })
})
