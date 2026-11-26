import type { DesktopHostFrame } from '../../shared/host-live.js'
import { parseDesktopHostFrame } from '../../shared/host-live.js'
import type { DesktopSessionFrame } from '../../shared/session-live.js'
import { parseDesktopSessionFrame } from '../../shared/session-live.js'
import {
  parseDesktopWorkspaceListResult,
  type DesktopWorkspaceListResult,
} from '../../shared/workspace-capabilities.js'
import {
  followDshRemoteStreams,
  type DshRemoteStreamResult,
  type OpenRemoteStreamSocket,
  type RemoteStreamSocket,
  type RemoteStreamSocketOptions,
} from './remote-stream.js'
import { boundedString, isRecord } from '../../shared/validation.ts'

/** 事件帧中标识类字符串字段的长度上限；超出或为空时视为无效字段。 */
const MAX_FIELD_LENGTH = 512

export const HOST_EVENT_STREAM_MAX_FRAME_BYTES = 8 * 1024 * 1024

export type DshHostEventStreamResult = DshRemoteStreamResult
export type HostEventStreamSocketOptions = RemoteStreamSocketOptions
export type HostEventStreamSocket = RemoteStreamSocket
export type OpenHostEventStreamSocket = OpenRemoteStreamSocket

export interface DshRemoteInteractionTarget {
  readonly clientId: string
  readonly eventId: string
  readonly event: 'approval/request' | 'user-questions/request'
}

export interface FollowDshHostEventStreamOptions {
  readonly targetUrl: URL
  readonly cookie?: string
  readonly signal: AbortSignal
  readonly onFrame: (frame: DesktopHostFrame) => void | Promise<void>
  readonly onSessionFrame?: (
    frame: DesktopSessionFrame,
    target: DshRemoteInteractionTarget,
  ) => void | Promise<void>
  readonly openSocket?: OpenHostEventStreamSocket
}

export interface ReadDshWorkspaceBaselineOptions {
  readonly targetUrl: URL
  readonly cookie?: string
  readonly signal?: AbortSignal
  readonly openSocket?: OpenHostEventStreamSocket
}

interface PendingRemoteInteraction {
  readonly sessionId: string
  readonly kind: 'approval' | 'question'
}

function hostStreamProtocolError(message: string): Error {
  return new Error(`MyDSH 运行核心 事件流协议错误：${message}`)
}

async function emitParsedHostFrame(
  input: unknown,
  onFrame: FollowDshHostEventStreamOptions['onFrame'],
): Promise<void> {
  const frame = parseDesktopHostFrame(input)
  if (frame !== null) await onFrame(frame)
}

async function emitWorkspaceFrame(
  input: unknown,
  onFrame: FollowDshHostEventStreamOptions['onFrame'],
): Promise<void> {
  if (!isRecord(input) || typeof input.type !== 'string') {
    throw hostStreamProtocolError('收到无效的 workspace/follow 帧')
  }
  if (input.type === 'baseline') {
    const baseline = parseDesktopWorkspaceListResult(input.value)
    /* oxlint-disable no-await-in-loop -- Workspace 基线必须按 Host 顺序串行投影。 */
    for (const workspace of baseline.items) {
      await onFrame({ type: 'host/workspace-changed', workspace })
    }
    /* oxlint-enable no-await-in-loop */
    await onFrame({
      type: 'host/workspace-order-changed',
      workspaceIds: baseline.items.map(workspace => workspace.workspaceId),
    })
    await onFrame({
      type: 'host/archived-sessions-changed',
      archivedSessionIds: baseline.archivedSessionIds,
    })
    return
  }
  if (input.type === 'upsert') {
    const workspace = input.workspace
    await emitParsedHostFrame({ type: 'host/workspace-changed', workspace }, onFrame)
    return
  }
  if (input.type === 'remove') {
    await emitParsedHostFrame(
      { type: 'host/workspace-removed', workspaceId: input.workspaceId },
      onFrame,
    )
    return
  }
  if (input.type === 'order') {
    await emitParsedHostFrame(
      { type: 'host/workspace-order-changed', workspaceIds: input.workspaceIds },
      onFrame,
    )
    return
  }
  if (input.type === 'archived') {
    await emitParsedHostFrame(
      {
        type: 'host/archived-sessions-changed',
        archivedSessionIds: input.archivedSessionIds,
      },
      onFrame,
    )
  }
}

/**
 * 读取 `$events` 与 `workspace/follow` 两条固定逻辑流，并投影为桌面端已有的
 * Host/Session 帧。Remote waterfall 的关联标识只交给主进程应答表，不进入 renderer。
 */
export async function followDshHostEventStream(
  options: FollowDshHostEventStreamOptions,
): Promise<DshHostEventStreamResult> {
  let clientId: string | undefined
  const pendingInteractions = new Map<string, PendingRemoteInteraction>()

  const onRemoteEvent = async (value: unknown): Promise<void> => {
    if (!isRecord(value) || typeof value.type !== 'string') {
      throw hostStreamProtocolError('收到无效的 $events 帧')
    }
    if (value.type === 'ready') {
      const nextClientId = boundedString(value.clientId, MAX_FIELD_LENGTH)
      if (
        nextClientId === null ||
        clientId !== undefined ||
        !isRecord(value.host) ||
        boundedString(value.host.home, 16 * 1024) === null
      ) {
        throw hostStreamProtocolError('收到无效的 $events ready 帧')
      }
      clientId = nextClientId
      return
    }
    if (value.type === 'emit') {
      if (
        clientId === undefined ||
        boundedString(value.event, MAX_FIELD_LENGTH) === null ||
        !Array.isArray(value.args)
      ) {
        throw hostStreamProtocolError('收到无效的 $events emit 帧')
      }
      await emitParsedHostFrame(
        {
          type: 'host/remote-event',
          event: value.event,
          args: value.args,
        },
        options.onFrame,
      )
      return
    }
    if (value.type === 'waterfall') {
      const eventId = boundedString(value.eventId, MAX_FIELD_LENGTH)
      const sessionId = boundedString(value.agentId, MAX_FIELD_LENGTH)
      const event = value.event
      if (
        clientId === undefined ||
        eventId === null ||
        sessionId === null ||
        !isRecord(value.request) ||
        (event !== 'approval/request' && event !== 'user-questions/request')
      ) {
        throw hostStreamProtocolError('收到无效的 $events waterfall 帧')
      }
      const input =
        event === 'approval/request'
          ? {
              type: 'approval/requested',
              sessionId,
              approvalId: eventId,
              toolName: value.request.toolName,
              callId: value.request.callId,
              reason: value.request.reason,
            }
          : {
              type: 'question/requested',
              sessionId,
              questions: value.request.questions,
            }
      const frame = parseDesktopSessionFrame(input, eventId)
      if (frame === null || frame.type !== 'session/interaction-requested') {
        throw hostStreamProtocolError('收到无效的待用户交互请求')
      }
      pendingInteractions.set(eventId, {
        sessionId,
        kind: event === 'approval/request' ? 'approval' : 'question',
      })
      await options.onSessionFrame?.(frame, { clientId, eventId, event })
      return
    }
    if (value.type === 'cancel') {
      const eventId = boundedString(value.eventId, MAX_FIELD_LENGTH)
      if (clientId === undefined || eventId === null) {
        throw hostStreamProtocolError('收到无效的 $events cancel 帧')
      }
      const pending = pendingInteractions.get(eventId)
      if (pending === undefined) return
      pendingInteractions.delete(eventId)
      const input =
        pending.kind === 'approval'
          ? {
              type: 'approval/resolved',
              sessionId: pending.sessionId,
              approvalId: eventId,
              outcome: 'cancelled',
            }
          : {
              type: 'question/resolved',
              sessionId: pending.sessionId,
              questionRpcId: eventId,
              outcome: 'cancelled',
            }
      const frame = parseDesktopSessionFrame(input)
      if (frame !== null && frame.type === 'session/interaction-resolved') {
        await options.onSessionFrame?.(frame, {
          clientId,
          eventId,
          event: pending.kind === 'approval' ? 'approval/request' : 'user-questions/request',
        })
      }
      return
    }
    throw hostStreamProtocolError('收到未知的 $events 帧')
  }

  return followDshRemoteStreams({
    targetUrl: options.targetUrl,
    ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    signal: options.signal,
    maxFrameBytes: HOST_EVENT_STREAM_MAX_FRAME_BYTES,
    subject: 'Host 事件流',
    streams: [
      { endpoint: '$events', payload: { args: {} }, onItem: onRemoteEvent },
      {
        endpoint: 'workspace/follow',
        payload: { args: {} },
        onItem: value => emitWorkspaceFrame(value, options.onFrame),
      },
    ],
    ...(options.openSocket === undefined ? {} : { openSocket: options.openSocket }),
  })
}

/** 读取 `workspace/follow` 的首个 baseline，供现有一次性 Workspace 刷新动作使用。 */
export async function readDshWorkspaceBaseline(
  options: ReadDshWorkspaceBaselineOptions,
): Promise<DesktopWorkspaceListResult> {
  const completed = new AbortController()
  const timeout = AbortSignal.timeout(15_000)
  const signal =
    options.signal === undefined
      ? AbortSignal.any([completed.signal, timeout])
      : AbortSignal.any([completed.signal, timeout, options.signal])
  let baseline: DesktopWorkspaceListResult | undefined
  const result = await followDshRemoteStreams({
    targetUrl: options.targetUrl,
    ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    signal,
    maxFrameBytes: HOST_EVENT_STREAM_MAX_FRAME_BYTES,
    subject: 'Workspace 状态流',
    streams: [
      {
        endpoint: 'workspace/follow',
        payload: { args: {} },
        onItem: value => {
          if (!isRecord(value) || value.type !== 'baseline') {
            throw hostStreamProtocolError('workspace/follow 首帧不是 baseline')
          }
          baseline = parseDesktopWorkspaceListResult(value.value)
          completed.abort()
        },
      },
    ],
    ...(options.openSocket === undefined ? {} : { openSocket: options.openSocket }),
  })
  if (baseline !== undefined) return baseline
  if (result.kind === 'capability-unavailable')
    throw new Error('当前 MyDSH 运行核心 不支持 Workspace 状态流')
  if (options.signal?.aborted === true) throw new Error('Workspace 状态读取已取消')
  if (timeout.aborted) throw new Error('Workspace 状态读取超时')
  throw new Error('DSH Workspace 状态流在 baseline 前断开')
}
