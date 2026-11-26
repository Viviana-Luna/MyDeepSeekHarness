/**
 * 外置浏览器 WebSocket CDP 传输层：复用仓库根依赖 `ws` 直连本机 loopback DevTools 端点。
 * 严格校验 loopback 地址、维护请求 ID 匹配与 `AbortSignal` 取消，关闭时清理所有在途请求。
 */
import WebSocket, { type RawData } from 'ws'
import type { CdpTransport } from './cdp-transport.ts'
import { assertLoopbackDebugUrl } from './external-browser-discovery.ts'

interface PendingCommand {
  resolve(value: unknown): void
  reject(reason: unknown): void
  timer: NodeJS.Timeout
  cleanupAbort?: () => void
}

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

const noopErrorHandler = () => {}

function openLoopbackSocket(
  wsUrl: string,
  options?: { expectedPort?: number; requireDevToolsPath?: boolean },
  signal?: AbortSignal,
): Promise<WebSocket> {
  const safeUrl = assertLoopbackDebugUrl(wsUrl, options).href
  signal?.throwIfAborted()
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(safeUrl, { handshakeTimeout: 5000 })
    let settled = false
    const finish = (err?: unknown) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      socket.removeListener('open', onOpen)
      socket.removeListener('error', onError)
      // 始终先挂载兜底 error 监听再终止或移交，杜绝 ws 握手取消/微任务空窗触发未捕获 error 崩溃主进程。
      socket.on('error', noopErrorHandler)
      if (err) {
        try {
          socket.terminate()
        } catch {
          /* 忽略终止竞态。 */
        }
        reject(err)
      } else {
        resolve(socket)
      }
    }
    const onOpen = () => finish()
    const onError = (error: Error) =>
      finish(new Error(`连接外置浏览器 CDP 失败：${error.message}`, { cause: error }))
    const onAbort = () => finish(signal?.reason ?? new Error('外置浏览器连接已取消'))
    socket.once('open', onOpen)
    socket.once('error', onError)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function closeSocketGracefully(socket: WebSocket): Promise<void> {
  if (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING) {
    return Promise.resolve()
  }
  return new Promise<void>(resolve => {
    const fallback = setTimeout(() => {
      try {
        socket.terminate()
      } catch {
        /* 忽略终止竞态。 */
      }
      resolve()
    }, 800)
    socket.once('close', () => {
      clearTimeout(fallback)
      resolve()
    })
    try {
      socket.close()
    } catch {
      clearTimeout(fallback)
      resolve()
    }
  })
}

function dispatchIncomingFrame(
  raw: RawData,
  pending: Map<number, PendingCommand>,
  listeners: Map<string, Set<(params: Record<string, unknown>) => void>>,
): void {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(rawDataToString(raw)) as Record<string, unknown>
  } catch {
    return
  }
  if (typeof parsed.id === 'number') {
    const entry = pending.get(parsed.id)
    if (!entry) return
    pending.delete(parsed.id)
    clearTimeout(entry.timer)
    entry.cleanupAbort?.()
    const errObj = parsed.error as { message?: unknown } | undefined
    if (errObj) {
      const msg = typeof errObj.message === 'string' ? errObj.message : 'CDP 命令执行失败'
      entry.reject(new Error(`CDP 错误：${msg}`))
    } else {
      entry.resolve(parsed.result ?? {})
    }
    return
  }
  if (typeof parsed.method === 'string') {
    const bucket = listeners.get(parsed.method)
    if (!bucket) return
    const params =
      typeof parsed.params === 'object' && parsed.params !== null
        ? (parsed.params as Record<string, unknown>)
        : {}
    for (const listener of bucket) listener(params)
  }
}

function sendJsonRpcCommand<T>(input: {
  socket: WebSocket
  pending: Map<number, PendingCommand>
  id: number
  method: string
  params?: Record<string, unknown>
  signal?: AbortSignal
}): Promise<T> {
  const { socket, pending, id, method, params, signal } = input
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const entry = pending.get(id)
      if (!entry) return
      pending.delete(id)
      entry.cleanupAbort?.()
      reject(new Error(`CDP 命令超时：${method}`))
    }, 25_000)
    const onAbort = () => {
      const entry = pending.get(id)
      if (!entry) return
      pending.delete(id)
      clearTimeout(entry.timer)
      reject(signal?.reason ?? new Error('浏览器操作已取消'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    pending.set(id, {
      resolve: value => resolve(value as T),
      reject,
      timer,
      ...(signal ? { cleanupAbort: () => signal.removeEventListener('abort', onAbort) } : {}),
    })
    const cleanupAndReject = (error: unknown) => {
      const entry = pending.get(id)
      if (!entry) return
      pending.delete(id)
      clearTimeout(entry.timer)
      entry.cleanupAbort?.()
      reject(error)
    }
    try {
      const serialized = JSON.stringify({ id, method, params: params ?? {} })
      socket.send(serialized, sendErr => {
        if (!sendErr) return
        cleanupAndReject(new Error(`发送 CDP 命令失败：${sendErr.message}`, { cause: sendErr }))
      })
    } catch (syncErr) {
      const detail = syncErr instanceof Error ? syncErr.message : String(syncErr)
      cleanupAndReject(new Error(`发送 CDP 命令失败：${detail}`, { cause: syncErr }))
    }
  })
}

/** 连接本机 loopback CDP WebSocket 端点并返回统一 `CdpTransport`。 */
export async function connectExternalCdpTransport(
  wsUrl: string,
  signal?: AbortSignal,
  options?: { expectedPort?: number; requireDevToolsPath?: boolean },
): Promise<CdpTransport> {
  const socket = await openLoopbackSocket(wsUrl, options, signal)
  let nextId = 1
  let alive = true
  const pending = new Map<number, PendingCommand>()
  const listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>()

  const rejectAll = (reason: Error) => {
    alive = false
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer)
      entry.cleanupAbort?.()
      entry.reject(reason)
      pending.delete(id)
    }
  }

  socket.on('message', data => dispatchIncomingFrame(data, pending, listeners))
  socket.on('close', () => rejectAll(new Error('外置浏览器 CDP 连接已关闭')))
  socket.on('error', error =>
    rejectAll(new Error(`外置浏览器 CDP 通道异常：${error.message}`, { cause: error })),
  )
  socket.removeListener('error', noopErrorHandler)

  return {
    sendCommand<T = Record<string, unknown>>(
      method: string,
      params?: Record<string, unknown>,
      cmdSignal?: AbortSignal,
    ): Promise<T> {
      cmdSignal?.throwIfAborted()
      if (!alive || socket.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error('外置浏览器 CDP 连接未就绪或已断开'))
      }
      return sendJsonRpcCommand<T>({
        socket,
        pending,
        id: nextId++,
        method,
        ...(params ? { params } : {}),
        ...(cmdSignal ? { signal: cmdSignal } : {}),
      })
    },
    onEvent(method, listener) {
      let bucket = listeners.get(method)
      if (!bucket) {
        bucket = new Set()
        listeners.set(method, bucket)
      }
      bucket.add(listener)
      return () => {
        bucket?.delete(listener)
        if (bucket && bucket.size === 0) listeners.delete(method)
      }
    },
    async close() {
      listeners.clear()
      rejectAll(new Error('外置浏览器 CDP 连接已主动关闭'))
      await closeSocketGracefully(socket)
    },
    isAlive: () => alive && socket.readyState === WebSocket.OPEN,
  }
}
