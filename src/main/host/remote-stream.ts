import { TextDecoder } from 'node:util'
import type { RawData } from 'ws'
import { boundedString, isRecord, type UnknownRecord } from '../../shared/validation.ts'

const REMOTE_STREAM_HANDSHAKE_TIMEOUT_MS = 5_000
const REMOTE_STREAM_IDENTIFIER_MAX_LENGTH = 512
const REMOTE_STREAM_ERROR_MAX_LENGTH = 64 * 1024

export type DshRemoteStreamResult =
  | {
      readonly kind: 'aborted'
    }
  | {
      readonly kind: 'capability-unavailable'
    }
  | {
      readonly kind: 'disconnected'
      readonly reason: 'eof' | 'transport'
    }

export interface RemoteStreamSocketOptions {
  readonly cookie?: string
  readonly handshakeTimeoutMs: number
  readonly maxPayloadBytes: number
}

export interface RemoteStreamSocket {
  readonly readyState: 'connecting' | 'open' | 'closing' | 'closed'
  onOpen(listener: () => void): void
  onMessage(listener: (data: RawData, isBinary: boolean) => void | Promise<void>): void
  onClose(listener: (code: number) => void): void
  onError(listener: (error?: Error) => void): void
  onUnexpectedResponse(listener: (statusCode: number) => void): void
  removeAllListeners(): void
  send(text: string): void
  close(): void
  terminate(): void
}

export type OpenRemoteStreamSocket = (
  url: URL,
  options: RemoteStreamSocketOptions,
) => RemoteStreamSocket

export interface DshRemoteLogicalStream {
  readonly endpoint: string
  readonly payload: unknown
  readonly onItem: (value: unknown) => void | Promise<void>
}

export interface FollowDshRemoteStreamsOptions {
  readonly targetUrl: URL
  readonly cookie?: string
  readonly signal: AbortSignal
  readonly maxFrameBytes: number
  readonly subject: string
  readonly streams: readonly DshRemoteLogicalStream[]
  /** 在同一物理连接中替换指定逻辑流；返回取消选择订阅的函数。 */
  readonly onReady?: (
    replace: (endpoint: string, stream: DshRemoteLogicalStream | null) => void,
  ) => () => void
  readonly openSocket?: OpenRemoteStreamSocket
}

interface ActiveLogicalStream extends DshRemoteLogicalStream {
  readonly streamId: string
}

function protocolError(subject: string, message: string): Error {
  return new Error(`运行核心 ${subject}协议错误：${message}`)
}

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  return Buffer.concat(data)
}

function parseServerMessage(
  data: RawData,
  isBinary: boolean,
  maximumBytes: number,
  subject: string,
): UnknownRecord {
  if (isBinary) throw protocolError(subject, '收到二进制 WebSocket 帧')
  const bytes = rawDataBuffer(data)
  if (bytes.byteLength > maximumBytes) throw protocolError(subject, '单帧超过大小上限')

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw protocolError(subject, 'WebSocket 帧不是有效 UTF-8')
  }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw protocolError(subject, 'WebSocket 帧不是有效 JSON')
  }
  if (
    !isRecord(value) ||
    (value.type !== 'item' && value.type !== 'error' && value.type !== 'end') ||
    boundedString(value.streamId, REMOTE_STREAM_IDENTIFIER_MAX_LENGTH) === null
  ) {
    throw protocolError(subject, '收到无效的 Remote stream envelope')
  }
  return value
}

function remoteStreamUrl(targetUrl: URL): URL {
  const url = new URL(targetUrl.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.username = ''
  url.password = ''
  url.pathname = '/api/remote.mux'
  url.search = ''
  url.hash = ''
  return url
}

function isPayloadTooLargeError(error: Error | undefined): boolean {
  if (error === undefined) return false
  const code = (error as Error & { readonly code?: unknown }).code
  return (
    code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' ||
    error.message.toLowerCase().includes('max payload size exceeded')
  )
}

function validateLogicalStreams(
  streams: readonly DshRemoteLogicalStream[],
  subject: string,
): readonly ActiveLogicalStream[] {
  if (streams.length === 0) throw protocolError(subject, '没有声明逻辑流')
  const endpoints = new Set<string>()
  return streams.map((stream, index) => {
    const endpoint = boundedString(stream.endpoint, REMOTE_STREAM_IDENTIFIER_MAX_LENGTH)
    if (endpoint === null) throw protocolError(subject, '逻辑流 endpoint 无效')
    if (endpoints.has(endpoint)) throw protocolError(subject, `逻辑流 ${endpoint} 重复`)
    endpoints.add(endpoint)
    return { ...stream, endpoint, streamId: `desktop-${String(index + 1)}` }
  })
}

/**
 * 通过调用方注入的运行时载体承载一组白名单 Remote 逻辑流。
 * 逻辑流 endpoint 和 payload 均由主进程调用方固定，实际传输不建立网络连接。
 */
export async function followDshRemoteStreams(
  options: FollowDshRemoteStreamsOptions,
): Promise<DshRemoteStreamResult> {
  if (options.signal.aborted) return { kind: 'aborted' }
  const streams = validateLogicalStreams(options.streams, options.subject)
  const streamsById = new Map(streams.map(stream => [stream.streamId, stream]))
  const cancelledStreams = new Set<string>()
  let nextStreamId = streams.length
  const openSocket = options.openSocket
  if (!openSocket) throw new Error('运行事件流必须由 MyDSH 消息载体提供')
  const socket = openSocket(remoteStreamUrl(options.targetUrl), {
    ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    handshakeTimeoutMs: REMOTE_STREAM_HANDSHAKE_TIMEOUT_MS,
    maxPayloadBytes: options.maxFrameBytes,
  })

  return new Promise<DshRemoteStreamResult>((resolve, reject) => {
    let settled = false
    let opened = false
    let deliveryStopped = false
    let delivery = Promise.resolve()
    let stopUpdates: (() => void) | undefined

    const cleanup = (): void => {
      stopUpdates?.()
      options.signal.removeEventListener('abort', abort)
      socket.removeAllListeners()
    }
    const stopSocket = (): void => {
      if (socket.readyState === 'open') {
        for (const stream of streamsById.values()) {
          try {
            socket.send(JSON.stringify({ type: 'cancel', streamId: stream.streamId }))
          } catch {
            break
          }
        }
        socket.close()
      } else if (socket.readyState === 'connecting') {
        socket.terminate()
      }
    }
    const settle = (result: DshRemoteStreamResult): void => {
      if (settled) return
      settled = true
      cleanup()
      stopSocket()
      resolve(result)
    }
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      socket.terminate()
      reject(error)
    }
    const abort = (): void => {
      settle({ kind: 'aborted' })
    }

    socket.onOpen(() => {
      opened = true
      try {
        for (const stream of streams) {
          socket.send(
            JSON.stringify({
              type: 'open',
              streamId: stream.streamId,
              endpoint: stream.endpoint,
              payload: stream.payload,
            }),
          )
        }
        stopUpdates = options.onReady?.((endpoint, replacement) => {
          if (settled) return
          try {
            if (replacement !== null && replacement.endpoint !== endpoint) {
              throw protocolError(options.subject, '替换逻辑流的 endpoint 不一致')
            }
            for (const [id, stream] of streamsById) {
              if (stream.endpoint !== endpoint) continue
              streamsById.delete(id)
              cancelledStreams.add(id)
              socket.send(JSON.stringify({ type: 'cancel', streamId: id }))
            }
            if (replacement === null) return
            const [validated] = validateLogicalStreams([replacement], options.subject)
            const streamId = `desktop-${String(++nextStreamId)}`
            streamsById.set(streamId, { ...validated!, streamId })
            socket.send(
              JSON.stringify({ type: 'open', streamId, endpoint, payload: replacement.payload }),
            )
          } catch (error) {
            fail(error)
          }
        })
      } catch (error) {
        fail(error)
      }
    })
    socket.onMessage((data, isBinary) => {
      delivery = delivery.then(async () => {
        if (settled || deliveryStopped) return
        try {
          const message = parseServerMessage(data, isBinary, options.maxFrameBytes, options.subject)
          const streamId = message.streamId as string
          if (cancelledStreams.has(streamId)) {
            if (message.type === 'end' || message.type === 'error')
              cancelledStreams.delete(streamId)
            return
          }
          const stream = streamsById.get(streamId)
          if (stream === undefined) throw protocolError(options.subject, '收到未知逻辑流标识')
          if (message.type === 'item') {
            await stream.onItem(message.value)
            return
          }
          if (message.type === 'end') {
            deliveryStopped = true
            settle({ kind: 'disconnected', reason: 'eof' })
            return
          }
          const error = message.error
          if (
            !isRecord(error) ||
            boundedString(error.code, 120) === null ||
            boundedString(error.message, REMOTE_STREAM_ERROR_MAX_LENGTH) === null ||
            !isRecord(error.details)
          ) {
            throw protocolError(options.subject, '收到无效的 Remote stream error')
          }
          throw new Error(`运行核心 ${stream.endpoint} 流失败：${error.code}: ${error.message}`)
        } catch (error) {
          deliveryStopped = true
          fail(error)
        }
      })
      return delivery
    })
    socket.onClose(code => {
      void delivery
        .then(() => {
          if (options.signal.aborted) {
            settle({ kind: 'aborted' })
            return
          }
          if (code === 1009) {
            fail(protocolError(options.subject, '单帧超过大小上限'))
            return
          }
          settle({
            kind: 'disconnected',
            reason: opened && (code === 1000 || code === 1005) ? 'eof' : 'transport',
          })
        })
        .catch(fail)
    })
    socket.onError(error => {
      if (options.signal.aborted) settle({ kind: 'aborted' })
      else if (isPayloadTooLargeError(error))
        fail(protocolError(options.subject, '单帧超过大小上限'))
      else settle({ kind: 'disconnected', reason: 'transport' })
    })
    socket.onUnexpectedResponse(statusCode => {
      if (statusCode === 404) {
        settle({ kind: 'capability-unavailable' })
        return
      }
      fail(new Error(`运行核心 ${options.subject}连接失败：HTTP ${String(statusCode)}`))
    })
    options.signal.addEventListener('abort', abort, { once: true })
    if (options.signal.aborted) abort()
  })
}
