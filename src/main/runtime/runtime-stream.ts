import type { OpenRemoteStreamSocket, RemoteStreamSocket } from '../host/remote-stream.ts'
import type { MydshRuntimeSupervisor } from './runtime-supervisor.ts'

/** DSH 逻辑流封装沿用已验证的解析器，物理载体完全由本应用的消息通道提供。 */
export function createRuntimeStreamCarrier(
  runtime: MydshRuntimeSupervisor,
): OpenRemoteStreamSocket {
  return () => {
    let state: RemoteStreamSocket['readyState'] = 'connecting'
    const listeners = new Map<string, Set<(...args: never[]) => void | Promise<void>>>()
    const requests = new Map<string, AbortController>()
    const on = (name: string, listener: (...args: never[]) => void | Promise<void>): void => {
      const group = listeners.get(name) ?? new Set()
      group.add(listener)
      listeners.set(name, group)
    }
    const emit = async (name: string, ...args: unknown[]): Promise<void> => {
      await Promise.all(
        [...(listeners.get(name) ?? [])].map(listener => listener(...(args as never[]))),
      )
    }
    const close = (): void => {
      if (state === 'closed') return
      state = 'closed'
      for (const controller of requests.values()) controller.abort()
      requests.clear()
      void emit('close', 1000).catch(() => {})
    }
    queueMicrotask(() => {
      if (state === 'connecting') {
        state = 'open'
        void emit('open').catch(close)
      }
    })
    return {
      get readyState() {
        return state
      },
      onOpen: listener => on('open', listener),
      onMessage: listener => on('message', listener),
      onClose: listener => on('close', listener),
      onError: listener => on('error', listener),
      onUnexpectedResponse: listener => on('unexpected', listener),
      removeAllListeners: () => {
        listeners.clear()
      },
      close,
      terminate: close,
      send: text => {
        if (state !== 'open') throw new Error('运行流载体尚未打开')
        const frame = JSON.parse(text) as {
          type: string
          streamId: string
          endpoint: string
          payload: unknown
        }
        if (frame.type === 'cancel') {
          requests.get(frame.streamId)?.abort()
          requests.delete(frame.streamId)
          return
        }
        if (frame.type !== 'open') throw new Error('运行核心收到未知的流操作')
        if (requests.has(frame.streamId) || requests.size >= 64)
          throw new Error('运行流标识重复或超过并发上限')
        const abort = new AbortController()
        requests.set(frame.streamId, abort)
        // 等到 Remote 解析器完成异步投影后才返回，Supervisor 随后才向后台 ACK。
        const deliver = async (type: string, value?: unknown): Promise<void> => {
          if (state === 'open' && !abort.signal.aborted)
            await emit(
              'message',
              Buffer.from(
                JSON.stringify({
                  type,
                  streamId: frame.streamId,
                  ...(type === 'item'
                    ? { value }
                    : type === 'error'
                      ? { error: { code: 'mydsh/runtime', message: String(value), details: {} } }
                      : {}),
                }),
              ),
              false,
            )
        }
        void runtime
          .follow(frame.endpoint, frame.payload, abort.signal, value => deliver('item', value))
          .then(
            () => deliver('end'),
            error => deliver('error', error instanceof Error ? error.message : error),
          )
          .catch(close)
          .finally(() => {
            requests.delete(frame.streamId)
          })
      },
    }
  }
}
