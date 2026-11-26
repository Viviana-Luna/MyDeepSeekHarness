import { SessionFollowProjection, emitControlFrame } from '../../shared/session-follow.js'
import { boundedString } from '../../shared/validation.ts'
import type { DesktopSessionFrame } from '../../shared/session-live.js'
import { PluginProjectionCache } from '../../shared/plugin-projections.js'
import {
  followDshRemoteStreams,
  type DshRemoteStreamResult,
  type OpenRemoteStreamSocket,
  type RemoteStreamSocket,
  type RemoteStreamSocketOptions,
} from './remote-stream.js'

/** 会话标识的长度上限，与会话帧中标识类字段的上限一致。 */
const SESSION_ID_MAX_LENGTH = 512

export const SESSION_STREAM_MAX_FRAME_BYTES = 32 * 1024 * 1024

export type DshSessionStreamResult = DshRemoteStreamResult
export type SessionStreamSocketOptions = RemoteStreamSocketOptions
export type SessionStreamSocket = RemoteStreamSocket
export type OpenSessionStreamSocket = OpenRemoteStreamSocket

export interface FollowDshSessionStreamOptions {
  readonly targetUrl: URL
  readonly cookie?: string
  readonly signal: AbortSignal
  readonly sessionId?: string
  readonly onFrame: (frame: DesktopSessionFrame) => void | Promise<void>
  readonly subscribeSelection?: (select: (sessionId: string | undefined) => void) => () => void
  readonly openSocket?: OpenSessionStreamSocket
}

/**
 * 包装帧回调，让插件投影帧先经过缓存去重。
 * 插件投影帧只转交缓存实际接受的值，并按缓存结果重新计算省略数量；
 * 流重置时清空缓存；其他帧原样转交。
 */
function filterPluginProjections(
  projections: PluginProjectionCache,
  deliver: FollowDshSessionStreamOptions['onFrame'],
): FollowDshSessionStreamOptions['onFrame'] {
  return frame => {
    if (frame.type === 'session/stream-reset') projections.clear()
    if (frame.type !== 'session/plugin-projections') return deliver(frame)
    const omittedBefore = projections.read(frame.sessionId)?.omitted ?? 0
    if (!projections.apply(frame.sessionId, frame.change)) return
    const accepted = projections.read(frame.sessionId)!
    return deliver({
      ...frame,
      change: {
        ...frame.change,
        values: Object.fromEntries(
          Object.entries(frame.change.values).filter(
            ([key, value]) => accepted.values[key] === value,
          ),
        ),
        omitted:
          frame.change.kind === 'snapshot'
            ? accepted.omitted
            : Math.max(0, accepted.omitted - omittedBefore),
      },
    })
  }
}

/**
 * 读取运行核心共享的 `session/control`，并在选中会话存在时同时读取该会话的
 * `session/follow`。两条逻辑流复用固定 `/api/remote.mux` 物理连接。
 */
export async function followDshSessionStream(
  options: FollowDshSessionStreamOptions,
): Promise<DshSessionStreamResult> {
  const onFrame = filterPluginProjections(new PluginProjectionCache(), options.onFrame)
  const sessionId =
    options.sessionId === undefined
      ? undefined
      : boundedString(options.sessionId, SESSION_ID_MAX_LENGTH)
  if (sessionId === null) {
    throw new Error('Session 事件流缺少有效的会话标识')
  }
  let selectionGeneration = 0
  const followStream = (id: string | undefined) => {
    const generation = ++selectionGeneration
    if (id === undefined) return null
    if (boundedString(id, SESSION_ID_MAX_LENGTH) === null)
      throw new Error('Session 事件流协议错误：会话标识无效')
    const projection = new SessionFollowProjection(id, frame => {
      if (generation === selectionGeneration && !options.signal.aborted) return onFrame(frame)
    })
    return {
      endpoint: 'session/follow',
      payload: {
        args: {
          request: {
            address: { kind: 'session', sessionId: id },
            assistantStream: true,
            maxMessages: 25,
          },
        },
      },
      onItem: (value: unknown) => projection.accept(value),
    }
  }
  const initialFollow = followStream(sessionId)
  return followDshRemoteStreams({
    targetUrl: options.targetUrl,
    ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    signal: options.signal,
    maxFrameBytes: SESSION_STREAM_MAX_FRAME_BYTES,
    subject: 'Session 事件流',
    streams: [
      ...(initialFollow === null ? [] : [initialFollow]),
      {
        endpoint: 'session/control',
        payload: { args: {} },
        onItem: value => emitControlFrame(value, onFrame),
      },
    ],
    ...(options.subscribeSelection === undefined
      ? {}
      : {
          onReady: (replace: (endpoint: string, stream: ReturnType<typeof followStream>) => void) =>
            options.subscribeSelection!(id => {
              replace('session/follow', followStream(id))
            }),
        }),
    ...(options.openSocket === undefined ? {} : { openSocket: options.openSocket }),
  })
}
