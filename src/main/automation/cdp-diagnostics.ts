/**
 * CDP 诊断环形缓冲与键码映射辅助：记录脱敏 Console/Network 日志，并提供跨平台 CDP 按键描述符。
 * 纯函数与轻量状态封装，不依赖 Electron，方便在主进程与单测中复用。
 */
import type {
  CdpDiagnosticConsoleEntry,
  CdpDiagnosticNetworkEntry,
  CdpTransport,
} from './cdp-transport.ts'

const MAX_CONSOLE_ENTRIES = 200
const MAX_NETWORK_ENTRIES = 200
const SENSITIVE_QUERY_KEYS =
  /(?:token|access_token|refresh_token|secret|password|passwd|api_key|apikey|key|auth|signature|sig|session|cookie)/iu

function sanitizeDiagnosticHash(hash: string): string {
  if (hash.length <= 1) return hash
  const hashBody = hash.slice(1)
  if (!SENSITIVE_QUERY_KEYS.test(hashBody)) return hash
  if (!hashBody.includes('=')) return '#[REDACTED]'
  const hashParams = new URLSearchParams(hashBody)
  for (const [key] of hashParams) {
    if (SENSITIVE_QUERY_KEYS.test(key)) hashParams.set(key, '[REDACTED]')
  }
  return `#${hashParams.toString()}`
}

/** 脱敏 URL 中的敏感查询参数、Hash 令牌与凭据，防止把密钥带入 Console/Network 诊断结果。 */
export function sanitizeDiagnosticUrl(rawUrl: string): string {
  if (!rawUrl) return ''
  try {
    const parsed = new URL(rawUrl)
    parsed.username = ''
    parsed.password = ''
    for (const [key] of parsed.searchParams) {
      if (SENSITIVE_QUERY_KEYS.test(key)) parsed.searchParams.set(key, '[REDACTED]')
    }
    parsed.hash = sanitizeDiagnosticHash(parsed.hash)
    return parsed.href.slice(0, 500)
  } catch {
    return sanitizeDiagnosticText(rawUrl).slice(0, 500)
  }
}

/** 脱敏 Console 文本中的 Bearer/Basic Token、Cookie/Authorization 头、JWT 及常见密钥片段。 */
export function sanitizeDiagnosticText(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/giu, '$1 [REDACTED]')
    .replace(/\b(Authorization|Cookie|Set-Cookie)\s*:\s*[^\r\n;]+/giu, '$1: [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, '[REDACTED_JWT]')
    .replace(/(?:sk|pk|ghp|gho|xoxb)-[A-Za-z0-9_-]{12,}/gu, '[REDACTED_TOKEN]')
    .replace(
      /\b(password|passwd|secret|token|access_token|refresh_token|api_key|apikey)\s*([=:])\s*([^\s&;,]+)/giu,
      '$1$2[REDACTED]',
    )
    .slice(0, 1000)
}

function formatRemoteArg(arg: unknown): string {
  if (typeof arg !== 'object' || arg === null) return ''
  const record = arg as Record<string, unknown>
  if (typeof record.value === 'string') return record.value
  if (typeof record.value === 'number' || typeof record.value === 'boolean') {
    return String(record.value)
  }
  if (typeof record.description === 'string') return record.description
  if (typeof record.unserializableValue === 'string') return record.unserializableValue
  return typeof record.type === 'string' ? `[${record.type}]` : ''
}

/** 诊断缓冲句柄：绑定 CDP 传输层事件并支持读取或清空。 */
export interface CdpDiagnosticsBuffer {
  read(options?: { consoleLimit?: number; networkLimit?: number; clear?: boolean }): {
    console: CdpDiagnosticConsoleEntry[]
    network: CdpDiagnosticNetworkEntry[]
    inFlightRequests: number
  }
  getInFlightCount(): number
  dispose(): void
}

function bindConsoleEvents(
  transport: CdpTransport,
  pushConsole: (entry: CdpDiagnosticConsoleEntry) => void,
): Array<() => void> {
  return [
    transport.onEvent('Runtime.consoleAPICalled', params => {
      const args = Array.isArray(params.args)
        ? params.args.map(formatRemoteArg).filter(Boolean)
        : []
      pushConsole({
        level: typeof params.type === 'string' ? params.type : 'log',
        text: sanitizeDiagnosticText(args.join(' ')),
        timestamp: Date.now(),
      })
    }),
    transport.onEvent('Log.entryAdded', params => {
      const entry = params.entry as Record<string, unknown> | undefined
      if (!entry) return
      pushConsole({
        level: typeof entry.level === 'string' ? entry.level : 'info',
        text: sanitizeDiagnosticText(typeof entry.text === 'string' ? entry.text : ''),
        timestamp: Date.now(),
        ...(typeof entry.url === 'string' ? { url: sanitizeDiagnosticUrl(entry.url) } : {}),
      })
    }),
    transport.onEvent('Runtime.exceptionThrown', params => {
      const details = params.exceptionDetails as Record<string, unknown> | undefined
      const exception = details?.exception as Record<string, unknown> | undefined
      const text =
        (typeof exception?.description === 'string' && exception.description) ||
        (typeof details?.text === 'string' && details.text) ||
        '未捕获页面异常'
      pushConsole({ level: 'error', text: sanitizeDiagnosticText(text), timestamp: Date.now() })
    }),
  ]
}

function bindNetworkEvents(
  transport: CdpTransport,
  input: {
    pushNetwork: (entry: CdpDiagnosticNetworkEntry) => void
    byRequestId: Map<string, CdpDiagnosticNetworkEntry>
    inFlight: Set<string>
  },
): Array<() => void> {
  return [
    transport.onEvent('Network.requestWillBeSent', params => {
      const requestId = typeof params.requestId === 'string' ? params.requestId : ''
      const request = params.request as Record<string, unknown> | undefined
      if (!requestId || !request) return
      const resType = typeof params.type === 'string' ? params.type : ''
      // 忽略长连接流式资源（SSE / WebSocket），避免 networkIdle 永远无法归零。
      if (resType !== 'EventSource' && resType !== 'WebSocket') {
        input.inFlight.add(requestId)
      }
      input.pushNetwork({
        requestId,
        method: typeof request.method === 'string' ? request.method : 'GET',
        url: sanitizeDiagnosticUrl(typeof request.url === 'string' ? request.url : ''),
        ...(resType ? { resourceType: resType } : {}),
        timestamp: Date.now(),
      })
    }),
    transport.onEvent('Page.frameNavigated', params => {
      const frame = params.frame as Record<string, unknown> | undefined
      if (frame && !frame.parentId) input.inFlight.clear()
    }),
    transport.onEvent('Network.responseReceived', params => {
      const requestId = typeof params.requestId === 'string' ? params.requestId : ''
      const response = params.response as Record<string, unknown> | undefined
      const existing = input.byRequestId.get(requestId)
      if (!existing || !response) return
      const status = typeof response.status === 'number' ? response.status : undefined
      if (status !== undefined) {
        Object.assign(existing, { status, ok: status >= 200 && status < 400 })
      }
    }),
    transport.onEvent('Network.loadingFinished', params => {
      if (typeof params.requestId === 'string') input.inFlight.delete(params.requestId)
    }),
    transport.onEvent('Network.loadingFailed', params => {
      const requestId = typeof params.requestId === 'string' ? params.requestId : ''
      input.inFlight.delete(requestId)
      const existing = input.byRequestId.get(requestId)
      if (!existing) return
      Object.assign(existing, {
        ok: false,
        errorText: typeof params.errorText === 'string' ? params.errorText : '加载失败',
      })
    }),
  ]
}

/** 监听 CDP Runtime/Log/Network 事件并维护有界脱敏环形缓冲区。 */
export function attachCdpDiagnostics(transport: CdpTransport): CdpDiagnosticsBuffer {
  const consoleEntries: CdpDiagnosticConsoleEntry[] = []
  const networkEntries: CdpDiagnosticNetworkEntry[] = []
  const byRequestId = new Map<string, CdpDiagnosticNetworkEntry>()
  const inFlight = new Set<string>()

  const pushConsole = (entry: CdpDiagnosticConsoleEntry) => {
    consoleEntries.push(entry)
    if (consoleEntries.length > MAX_CONSOLE_ENTRIES) consoleEntries.shift()
  }
  const pushNetwork = (entry: CdpDiagnosticNetworkEntry) => {
    networkEntries.push(entry)
    byRequestId.set(entry.requestId, entry)
    if (networkEntries.length > MAX_NETWORK_ENTRIES) {
      const removed = networkEntries.shift()
      if (removed && byRequestId.get(removed.requestId) === removed) {
        byRequestId.delete(removed.requestId)
      }
    }
  }
  const unsubscribers = [
    ...bindConsoleEvents(transport, pushConsole),
    ...bindNetworkEvents(transport, { pushNetwork, byRequestId, inFlight }),
  ]

  return {
    read(options) {
      const consoleLimit = Math.max(1, Math.min(200, options?.consoleLimit ?? 50))
      const networkLimit = Math.max(1, Math.min(200, options?.networkLimit ?? 50))
      const result = {
        console: consoleEntries.slice(-consoleLimit).map(item => Object.assign({}, item)),
        network: networkEntries.slice(-networkLimit).map(item => Object.assign({}, item)),
        inFlightRequests: inFlight.size,
      }
      if (options?.clear) {
        consoleEntries.length = 0
        networkEntries.length = 0
        byRequestId.clear()
      }
      return result
    },
    getInFlightCount: () => inFlight.size,
    dispose() {
      for (const off of unsubscribers) off()
      consoleEntries.length = 0
      networkEntries.length = 0
      byRequestId.clear()
      inFlight.clear()
    },
  }
}

/** CDP `Input.dispatchKeyEvent` 所需按键定义。 */
export interface CdpKeyDescriptor {
  readonly key: string
  readonly code: string
  readonly keyCode: number
  readonly text?: string
}

const NAMED_KEYS: Record<string, CdpKeyDescriptor> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
}

/** 解析按键名称与修饰键列表为 CDP `Input.dispatchKeyEvent` 载荷。 */
export function resolveCdpKey(
  rawKey: string,
  modifiers: readonly string[] = [],
): { descriptor: CdpKeyDescriptor; modifierMask: number } {
  const parts = rawKey
    .split('+')
    .map(item => item.trim())
    .filter(Boolean)
  const allModifiers = [...modifiers]
  let mainKey = rawKey.trim()
  if (parts.length > 1) {
    mainKey = parts.at(-1) ?? ''
    allModifiers.push(...parts.slice(0, -1))
  }
  let modifierMask = 0
  for (const mod of allModifiers) {
    const normalized = mod.toLowerCase()
    if (normalized === 'alt' || normalized === 'option') modifierMask |= 1
    else if (normalized === 'ctrl' || normalized === 'control') modifierMask |= 2
    else if (normalized === 'meta' || normalized === 'cmd' || normalized === 'command')
      modifierMask |= 4
    else if (normalized === 'shift') modifierMask |= 8
  }
  const lowered = mainKey.toLowerCase()
  const named = Object.hasOwn(NAMED_KEYS, lowered) ? NAMED_KEYS[lowered] : undefined
  if (named) return { descriptor: named, modifierMask }
  if (mainKey.length === 1) {
    const upper = mainKey.toUpperCase()
    let code = mainKey
    if (/[A-Z]/u.test(upper)) code = `Key${upper}`
    else if (/[0-9]/u.test(upper)) code = `Digit${upper}`
    return {
      descriptor: {
        key: mainKey,
        code,
        keyCode: upper.charCodeAt(0),
        ...(modifierMask === 0 || modifierMask === 8 ? { text: mainKey } : {}),
      },
      modifierMask,
    }
  }
  throw new Error(`不支持的按键名称：${rawKey}`)
}

/** 支持 `AbortSignal` 即时中断的延时等待辅助。 */
export async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return
  signal?.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('浏览器操作已取消'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 无 Electron `nativeImage` 时的默认透传缩放器（供单测与纯 Node 环境读取 PNG 尺寸）。 */
export function defaultPassthroughScaler(input: Buffer): {
  buffer: Buffer
  mediaType: 'image/png' | 'image/jpeg'
  width: number
  height: number
} {
  const isPng = input.byteLength >= 24 && input[0] === 137 && input[1] === 80
  const width = isPng ? input.readUInt32BE(16) : 1280
  const height = isPng ? input.readUInt32BE(20) : 800
  return { buffer: input, mediaType: 'image/png', width, height }
}
