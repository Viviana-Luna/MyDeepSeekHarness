/**
 * 统一 CDP 传输层契约与共享数据结构：供内置浏览器驱动与外置浏览器驱动复用同一套 CDP 引擎。
 * 纯类型定义模块，不依赖 Electron 或网络库，方便在 Node 单元测试中直接模拟传输层。
 */

/** 统一 Chrome DevTools Protocol 传输通道抽象。 */
export interface CdpTransport {
  sendCommand<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T>
  onEvent(method: string, listener: (params: Record<string, unknown>) => void): () => void
  close(): Promise<void>
  isAlive(): boolean
}

/** 遇到人机验证、支付结算或密码登录等受保护场景时返回的人工接管提示。 */
export interface CdpHandoffInfo {
  readonly required: true
  readonly category: 'captcha' | 'payment' | 'auth'
  readonly reason: string
  readonly url: string
}

/** 快照中提取的可见交互元素记录。 */
export interface CdpSnapshotElement {
  readonly ref: string
  readonly role: string
  readonly tag: string
  readonly name: string
  readonly value?: string
  readonly placeholder?: string
  readonly href?: string
  readonly inputType?: string
  readonly disabled?: boolean
  readonly checked?: boolean
  readonly inViewport: boolean
  readonly rect: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }
  readonly center: { readonly x: number; readonly y: number }
  readonly axNodeId?: string
  readonly selectorHint?: string
}

/** 页面结构快照结果（`@eN` 交互编号树 + 视口摘要 + 敏感接管信号）。 */
export interface CdpSnapshotResult {
  readonly snapshotId: string
  readonly url: string
  readonly title: string
  readonly viewport: { readonly width: number; readonly height: number }
  readonly elementsCount: number
  readonly truncated: boolean
  readonly tree: string
  readonly handoff?: CdpHandoffInfo
}

/** 经主进程缩放后的截图载荷，后续由后台 Runtime 写入 `ctx.attachments`。 */
export interface CdpScreenshotResult {
  readonly base64: string
  readonly mediaType: 'image/png' | 'image/jpeg'
  readonly width: number
  readonly height: number
  readonly viewportWidth: number
  readonly viewportHeight: number
  readonly bytes: number
  readonly url: string
  readonly title: string
}

/** 脱敏后的页面 Console 日志记录。 */
export interface CdpDiagnosticConsoleEntry {
  readonly level: string
  readonly text: string
  readonly timestamp: number
  readonly url?: string
}

/** 脱敏后的页面网络请求摘要（不含 Cookie / Authorization 等敏感请求头）。 */
export interface CdpDiagnosticNetworkEntry {
  readonly requestId: string
  readonly method: string
  readonly url: string
  readonly resourceType?: string
  readonly status?: number
  readonly ok?: boolean
  readonly errorText?: string
  readonly timestamp: number
}

/** 图像缩放回调签名，默认在主进程使用 Electron `nativeImage`，单测可注入轻量实现。 */
export type ImageScaler = (
  input: Buffer,
  maxLongEdge: number,
) => {
  buffer: Buffer
  mediaType: 'image/png' | 'image/jpeg'
  width: number
  height: number
}

/** 共享 CDP 页面引擎公开接口。 */
export interface CdpPageEngine {
  init(signal?: AbortSignal): Promise<void>
  invalidateSnapshot(): void
  snapshot(options?: { maxBytes?: number; signal?: AbortSignal }): Promise<CdpSnapshotResult>
  screenshot(options?: {
    fullPage?: boolean
    maxLongEdge?: number
    signal?: AbortSignal
  }): Promise<CdpScreenshotResult>
  click(options: {
    ref?: string
    snapshotId?: string
    x?: number
    y?: number
    button?: 'left' | 'right' | 'middle'
    clickCount?: number
    signal?: AbortSignal
  }): Promise<{ ok: boolean; x: number; y: number; handoff?: CdpHandoffInfo }>
  type(options: {
    ref?: string
    snapshotId?: string
    text: string
    clear?: boolean
    submit?: boolean
    signal?: AbortSignal
  }): Promise<{ ok: boolean; typedLength: number; handoff?: CdpHandoffInfo }>
  pressKey(options: {
    key: string
    modifiers?: string[]
    signal?: AbortSignal
  }): Promise<{ ok: true; key: string }>
  scroll(options: {
    deltaX?: number
    deltaY?: number
    x?: number
    y?: number
    ref?: string
    snapshotId?: string
    signal?: AbortSignal
  }): Promise<{ ok: true }>
  select(options: {
    ref: string
    snapshotId?: string
    value?: string
    label?: string
    signal?: AbortSignal
  }): Promise<{ ok: true; selectedValue: string; selectedLabel: string }>
  wait(options: {
    timeoutMs?: number
    text?: string
    selector?: string
    networkIdle?: boolean
    signal?: AbortSignal
  }): Promise<{ ok: true; waitedMs: number; condition: string }>
  diagnostics(options?: { consoleLimit?: number; networkLimit?: number; clear?: boolean }): {
    console: CdpDiagnosticConsoleEntry[]
    network: CdpDiagnosticNetworkEntry[]
    url: string
  }
  dispose(): Promise<void>
}
