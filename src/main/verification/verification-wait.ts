/**
 * 真实 Electron 验收的通用轮询与稳定等待工具：运行在主进程，不拥有持久资源。
 * 用有界状态轮询替代固定短延时，避免软件渲染低帧率或离屏调度波动引起竞态失败。
 */
import type { BrowserWindow } from 'electron'

/** 页面内条件轮询脚本的配置参数。 */
export interface PollRendererOptions {
  /** 在页面内求值并返回当前采样对象的 JavaScript 表达式。 */
  readonly probe: string
  /** 基于变量 `state` 判断采样是否满足条件的 JavaScript 布尔表达式。 */
  readonly condition: string
  /** 最长等待时长（毫秒），默认 2500。 */
  readonly timeoutMs?: number | undefined
  /** 两次轮询之间的间隔（毫秒），默认 25。 */
  readonly intervalMs?: number | undefined
}

/** 页面内条件轮询的结构化结果，便于失败时输出完整诊断上下文。 */
export interface PollRendererResult<T> {
  readonly ok: boolean
  readonly value: T
  readonly attempts: number
  readonly elapsedMs: number
}

/**
 * 构造在页面内有界轮询状态表达式的脚本，避免每次采样都产生跨进程 IPC 往返。
 * 脚本在条件满足时立即返回，超时则返回最后一次采样结果与尝试次数。
 */
export function buildRendererPollScript(options: PollRendererOptions): string {
  const timeoutMs = options.timeoutMs ?? 2_500
  const intervalMs = options.intervalMs ?? 25
  return `(async () => {
    const start = Date.now()
    const deadline = start + ${String(timeoutMs)}
    let attempts = 0
    let state
    while (true) {
      attempts += 1
      state = (${options.probe})
      if (${options.condition}) {
        return { ok: true, value: state, attempts, elapsedMs: Date.now() - start }
      }
      if (Date.now() >= deadline) {
        return { ok: false, value: state, attempts, elapsedMs: Date.now() - start }
      }
      await new Promise(resolve => setTimeout(resolve, ${String(intervalMs)}))
    }
  })()`
}

/**
 * 在目标窗口页面内有界轮询状态直至满足条件或超时。
 */
export async function pollRenderer<T>(
  win: BrowserWindow,
  options: PollRendererOptions,
): Promise<PollRendererResult<T>> {
  return (await win.webContents.executeJavaScript(
    buildRendererPollScript(options),
  )) as PollRendererResult<T>
}

/**
 * 在主进程侧有界轮询同步或异步状态，用于窗口最大化、视图销毁等主进程对象断言。
 */
export async function pollCondition(
  check: () => boolean | Promise<boolean>,
  options?: {
    readonly timeoutMs?: number | undefined
    readonly intervalMs?: number | undefined
  },
): Promise<boolean> {
  const timeoutMs = options?.timeoutMs ?? 2_500
  const intervalMs = options?.intervalMs ?? 25
  const deadline = Date.now() + timeoutMs
  /* oxlint-disable no-await-in-loop -- 串行轮询同一主进程状态直至满足或超时。 */
  while (true) {
    if (await check()) return true
    if (Date.now() >= deadline) return false
    await new Promise(resolve => {
      setTimeout(resolve, intervalMs)
    })
  }
  /* oxlint-enable no-await-in-loop */
}

/**
 * 等待 CDP 媒体仿真生效并完成至少一次样式与帧同步。
 */
export async function waitForMediaFeature(
  win: BrowserWindow,
  query: string,
  timeoutMs = 1_500,
): Promise<boolean> {
  const result = await pollRenderer<boolean>(win, {
    probe: `matchMedia(${JSON.stringify(query)}).matches`,
    condition: 'state === true',
    timeoutMs,
    intervalMs: 15,
  })
  if (result.ok) {
    await win.webContents.executeJavaScript(
      'Promise.race([new Promise(resolve => requestAnimationFrame(resolve)), new Promise(resolve => setTimeout(resolve, 80))])',
    )
  }
  return result.ok
}

/**
 * 等待窗口尺寸与可选明暗主题同步到 renderer 并完成两帧重排，替代固定延时等待。
 */
export async function waitForViewportSettled(
  win: BrowserWindow,
  options?: {
    readonly scheme?: 'light' | 'dark' | undefined
    readonly timeoutMs?: number | undefined
  },
): Promise<void> {
  const [contentWidth = 0, contentHeight = 0] = win.getContentSize()
  const zoom = win.webContents.getZoomFactor() || 1
  const expectedWidth = Math.round(contentWidth / zoom)
  const expectedHeight = Math.round(contentHeight / zoom)
  const scheme = options?.scheme
  const timeoutMs = options?.timeoutMs ?? 2_500
  await win.webContents.executeJavaScript(`(async () => {
    const expectedWidth = ${String(expectedWidth)}
    const expectedHeight = ${String(expectedHeight)}
    const expectedScheme = ${JSON.stringify(scheme ?? null)}
    const deadline = Date.now() + ${String(timeoutMs)}
    while (Date.now() < deadline) {
      const sizeReady = expectedWidth <= 0 || expectedHeight <= 0
        || (Math.abs(innerWidth - expectedWidth) <= 3 && Math.abs(innerHeight - expectedHeight) <= 3)
      const schemeReady = expectedScheme === null
        || document.documentElement.dataset.colorScheme === expectedScheme
      if (sizeReady && schemeReady) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    const tick = () => Promise.race([
      new Promise(resolve => requestAnimationFrame(resolve)),
      new Promise(resolve => setTimeout(resolve, 80)),
    ])
    await tick()
    await tick()
  })()`)
}
