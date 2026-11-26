/**
 * 内置浏览器 CDP 驱动：复用主进程受隔离的 `WebContentsView`，通过 `webContents.debugger` 对接统一 CDP 引擎。
 * 运行在 Electron 主进程；强制执行 `blockedOrigins` 与 `http(s)` 边界校验（拦截 `mydsh-preview://` 与黑名单域名），关闭或禁用时彻底分离调试器。
 */
import type { WebContents } from 'electron'
import type { AutomationSettings } from '../../shared/automation.ts'
import { browserUrl } from '../../shared/browser.ts'
import type { EmbeddedBrowserController } from '../browser/browser-controller.ts'
import { dispatchCdpEngineAction, readOptionalString } from './cdp-dispatch.ts'
import { createCdpPageEngine, type CdpPageEngine } from './cdp-engine.ts'
import type { CdpTransport } from './cdp-transport.ts'
import { scaleImageWithNativeImage } from './image-scaler.ts'

const ATTACH_CONFLICT_ERROR =
  'DEBUGGER_ATTACH_CONFLICT：当前标签已附加调试器（可能已打开 DevTools），请先关闭 DevTools 或新建标签页后重试'

function isBlankBrowserUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim().toLowerCase()
  return trimmed === '' || trimmed === 'about:blank'
}

/** 校验内置浏览器自动化目标地址：严禁访问 `mydsh-preview://` 本地文件及 `blockedOrigins` 黑名单域名。 */
export function assertEmbeddedAutomationUrlAllowed(
  rawUrl: string,
  settings: AutomationSettings,
  allowBlank = false,
): void {
  if (isBlankBrowserUrl(rawUrl)) {
    if (allowBlank) return
    throw new Error('导航需要提供有效的 http(s) 网址')
  }
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error(`SECURITY_BLOCK：内置浏览器自动化仅允许合法的 http(s) 网页，已拒绝 ${rawUrl}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `SECURITY_BLOCK：内置浏览器自动化禁止访问非网页协议（${parsed.protocol}），本地预览文件不开放给模型操控`,
    )
  }
  const origin = parsed.origin.toLowerCase()
  const blocked = settings.embeddedBrowser.blockedOrigins.some(
    rule => rule.toLowerCase() === origin,
  )
  if (blocked) {
    throw new Error(`SECURITY_BLOCK：目标站点 ${origin} 位于禁止自动化黑名单内，已拦截操作`)
  }
}

function attachWebContentsDebugger(webContents: WebContents): void {
  if (webContents.isDestroyed()) throw new Error('内置浏览器标签已销毁')
  const dbg = webContents.debugger
  if (dbg.isAttached()) throw new Error(ATTACH_CONFLICT_ERROR)
  try {
    dbg.attach('1.3')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (/already attached/iu.test(detail)) throw new Error(ATTACH_CONFLICT_ERROR, { cause: error })
    throw new Error(`无法附加内置浏览器调试通道：${detail}`, { cause: error })
  }
}

/** 封装 Electron `webContents.debugger` 的 CDP 传输实现。 */
export function createEmbeddedCdpTransport(webContents: WebContents): CdpTransport {
  attachWebContentsDebugger(webContents)
  const dbg = webContents.debugger
  let attached = true
  const listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>()
  const onMessage = (_event: Electron.Event, method: string, params: Record<string, unknown>) => {
    const bucket = listeners.get(method)
    if (!bucket) return
    for (const listener of bucket) listener(params ?? {})
  }
  const onDetach = () => {
    attached = false
  }
  dbg.on('message', onMessage)
  dbg.on('detach', onDetach)
  webContents.once('destroyed', onDetach)

  return {
    async sendCommand<T = Record<string, unknown>>(
      method: string,
      params?: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<T> {
      signal?.throwIfAborted()
      if (!attached || webContents.isDestroyed() || !dbg.isAttached()) {
        throw new Error('内置浏览器调试会话已断开，请重试操作')
      }
      const commandPromise = dbg.sendCommand(method, params ?? {}) as Promise<T>
      if (!signal) return commandPromise
      return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(signal.reason ?? new Error('浏览器操作已取消'))
        signal.addEventListener('abort', onAbort, { once: true })
        commandPromise.then(
          value => {
            signal.removeEventListener('abort', onAbort)
            resolve(value)
          },
          error => {
            signal.removeEventListener('abort', onAbort)
            reject(error)
          },
        )
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
      dbg.removeListener('message', onMessage)
      dbg.removeListener('detach', onDetach)
      if (!webContents.isDestroyed()) webContents.removeListener('destroyed', onDetach)
      listeners.clear()
      if (attached && !webContents.isDestroyed() && dbg.isAttached()) {
        attached = false
        try {
          dbg.detach()
        } catch {
          /* 视图销毁竞态下忽略分离异常。 */
        }
      }
    },
    isAlive: () => attached && !webContents.isDestroyed() && dbg.isAttached(),
  }
}

interface AttachedTab {
  tabId: string
  webContents: WebContents
  transport: CdpTransport
  engine: CdpPageEngine
  onDestroyed: () => void
}

interface EmbeddedDriverState {
  controller: EmbeddedBrowserController
  attached: Map<string, AttachedTab>
  ownedTabs: Set<string>
  activeTabId: string
  nextTabSequence: number
}

/** 内置浏览器自动化驱动实例，供 `automation-system.ts` 注册调用。 */
export interface EmbeddedBrowserDriver {
  call(
    action: string,
    payload: Record<string, unknown>,
    signal: AbortSignal,
    settings: AutomationSettings,
  ): Promise<unknown>
  stop(): Promise<void>
  dispose(): Promise<void>
}

async function detachEmbeddedTab(state: EmbeddedDriverState, tabId: string): Promise<void> {
  const entry = state.attached.get(tabId)
  if (!entry) return
  state.attached.delete(tabId)
  if (!entry.webContents.isDestroyed()) {
    entry.webContents.removeListener('destroyed', entry.onDestroyed)
    if (typeof entry.webContents.setBackgroundThrottling === 'function') {
      entry.webContents.setBackgroundThrottling(true)
    }
    if (entry.webContents.debugger.isAttached()) {
      await Promise.race([
        entry.webContents.debugger
          .sendCommand('Emulation.clearDeviceMetricsOverride')
          .catch(() => {}),
        new Promise<void>(resolve => setTimeout(resolve, 1_000)),
      ])
    }
  }
  await entry.engine.dispose().catch(() => {})
}

function resolveTargetTabId(state: EmbeddedDriverState, payload: Record<string, unknown>): string {
  const explicit = readOptionalString(payload, 'tabId')
  if (explicit) return explicit
  const existing = state.controller.listTabs()
  if (
    state.ownedTabs.has(state.activeTabId) &&
    existing.some(tab => tab.tabId === state.activeTabId)
  ) {
    return state.activeTabId
  }
  // 仅复用自动化已有标签或空白页签，不静默劫持用户手动打开的非空白登录页或本地预览页。
  const reusableBlank = existing.find(tab => isBlankBrowserUrl(tab.url))
  if (reusableBlank) {
    state.ownedTabs.add(reusableBlank.tabId)
    state.activeTabId = reusableBlank.tabId
    return reusableBlank.tabId
  }
  const existingOwned = existing.find(tab => state.ownedTabs.has(tab.tabId))
  if (existingOwned) {
    state.activeTabId = existingOwned.tabId
    return existingOwned.tabId
  }
  const freshId = existing.some(tab => tab.tabId === 'default')
    ? `agent-${state.nextTabSequence++}`
    : 'default'
  state.ownedTabs.add(freshId)
  state.activeTabId = freshId
  return freshId
}

async function ensureEmbeddedEngine(
  state: EmbeddedDriverState,
  tabId: string,
  signal?: AbortSignal,
): Promise<AttachedTab> {
  const { webContents } = state.controller.ensureTab(tabId)
  const existing = state.attached.get(tabId)
  if (
    existing &&
    existing.webContents === webContents &&
    !webContents.isDestroyed() &&
    existing.transport.isAlive()
  ) {
    return existing
  }
  if (existing) await detachEmbeddedTab(state, tabId)
  if (typeof webContents.setBackgroundThrottling === 'function') {
    webContents.setBackgroundThrottling(false)
  }
  const transport = createEmbeddedCdpTransport(webContents)
  const engine = createCdpPageEngine({
    transport,
    scaler: scaleImageWithNativeImage,
    capturePngOverride: opts => state.controller.captureTabPng(tabId, opts),
    getUrl: () => (webContents.isDestroyed() ? '' : webContents.getURL()),
    getTitle: () => (webContents.isDestroyed() ? '' : webContents.getTitle()),
  })
  const onDestroyed = () => {
    if (state.attached.get(tabId)?.engine === engine) {
      state.attached.delete(tabId)
      void engine.dispose().catch(() => {})
    }
  }
  const record: AttachedTab = { tabId, webContents, transport, engine, onDestroyed }
  state.attached.set(tabId, record)
  state.ownedTabs.add(tabId)
  webContents.once('destroyed', onDestroyed)
  try {
    state.controller.revealTab(tabId)
    await engine.init(signal)
    const size = await transport
      .sendCommand<{ result?: { value?: { w: number; h: number } } }>(
        'Runtime.evaluate',
        {
          expression: '({ w: window.innerWidth || 0, h: window.innerHeight || 0 })',
          returnByValue: true,
        },
        signal,
      )
      .catch(() => null)
    if ((size?.result?.value?.w ?? 0) < 32 || (size?.result?.value?.h ?? 0) < 32) {
      // 不可见 WebContentsView 在 Electron 下视口为 0x0，启用设备度量覆盖保证后台点击与截图坐标精确。
      await transport
        .sendCommand(
          'Emulation.setDeviceMetricsOverride',
          { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
          signal,
        )
        .catch(() => {})
    }
    return record
  } catch (error) {
    await detachEmbeddedTab(state, tabId)
    throw error
  }
}

async function handleEmbeddedTabs(
  state: EmbeddedDriverState,
  payload: Record<string, unknown>,
  signal: AbortSignal,
  settings: AutomationSettings,
): Promise<unknown> {
  const op = readOptionalString(payload, 'operation') ?? 'list'
  if (op === 'new') {
    const requestedId = readOptionalString(payload, 'tabId') ?? `agent-${state.nextTabSequence++}`
    const rawUrl = readOptionalString(payload, 'url')
    const safeUrl = rawUrl ? browserUrl(rawUrl) : undefined
    if (safeUrl) assertEmbeddedAutomationUrlAllowed(safeUrl, settings, false)
    if (safeUrl) await state.controller.navigateTab(requestedId, safeUrl, signal)
    else {
      state.controller.ensureTab(requestedId)
      state.controller.revealTab(requestedId)
    }
    await ensureEmbeddedEngine(state, requestedId, signal)
    state.ownedTabs.add(requestedId)
    state.activeTabId = requestedId
    return { activeTabId: state.activeTabId, tabs: state.controller.listTabs() }
  }
  if (op === 'switch') {
    const tabId = readOptionalString(payload, 'tabId')
    if (!tabId) throw new Error('切换标签页需要指定 tabId')
    const current = state.controller.listTabs().find(tab => tab.tabId === tabId)
    if (current) assertEmbeddedAutomationUrlAllowed(current.url, settings, true)
    state.controller.ensureTab(tabId)
    state.controller.revealTab(tabId)
    state.ownedTabs.add(tabId)
    state.activeTabId = tabId
    return { activeTabId: state.activeTabId, tabs: state.controller.listTabs() }
  }
  if (op === 'close') {
    const tabId = readOptionalString(payload, 'tabId') ?? resolveTargetTabId(state, payload)
    await detachEmbeddedTab(state, tabId)
    state.ownedTabs.delete(tabId)
    state.controller.tabAction(tabId, 'close')
    const remaining = state.controller.listTabs()
    state.activeTabId = remaining[0]?.tabId ?? 'default'
    return { activeTabId: state.activeTabId, tabs: remaining }
  }
  return { activeTabId: resolveTargetTabId(state, payload), tabs: state.controller.listTabs() }
}

async function handleEmbeddedNavigate(
  state: EmbeddedDriverState,
  input: {
    tabId: string
    payload: Record<string, unknown>
    signal: AbortSignal
    settings: AutomationSettings
  },
): Promise<unknown> {
  const { tabId, payload, signal, settings } = input
  const mode = readOptionalString(payload, 'mode') ?? 'url'
  const existing = state.attached.get(tabId)
  existing?.engine.invalidateSnapshot()
  if (mode === 'back' || mode === 'forward' || mode === 'reload') {
    const attached = await ensureEmbeddedEngine(state, tabId, signal)
    const beforeUrl = attached.webContents.isDestroyed() ? '' : attached.webContents.getURL()
    assertEmbeddedAutomationUrlAllowed(beforeUrl, settings, true)
    state.controller.revealTab(tabId)
    const nextState = state.controller.tabAction(tabId, mode)
    assertEmbeddedAutomationUrlAllowed(nextState.url, settings, true)
    return { tabId, ...nextState }
  }
  const rawUrl = readOptionalString(payload, 'url')
  if (!rawUrl) throw new Error('导航需要提供有效的 http(s) 网址')
  const normalized = browserUrl(rawUrl)
  assertEmbeddedAutomationUrlAllowed(normalized, settings, false)
  // 首次导航先让 WebContents 完成目标站点进程创建与加载，再附加调试器以防初始空文档进程切换导致 CDP 挂起。
  const navState = await state.controller.navigateTab(tabId, normalized, signal)
  const finalUrl = navState.url || normalized
  assertEmbeddedAutomationUrlAllowed(finalUrl, settings, false)
  const attached = await ensureEmbeddedEngine(state, tabId, signal)
  attached.engine.invalidateSnapshot()
  state.ownedTabs.add(tabId)
  state.activeTabId = tabId
  return { tabId, ...navState, url: finalUrl }
}

/** 创建主进程内置浏览器自动化驱动。 */
export function createEmbeddedBrowserDriver(
  controller: EmbeddedBrowserController,
): EmbeddedBrowserDriver {
  const state: EmbeddedDriverState = {
    controller,
    attached: new Map(),
    ownedTabs: new Set(),
    activeTabId: 'default',
    nextTabSequence: 1,
  }
  const detachAll = async () => {
    const ids = [...state.attached.keys()]
    await Promise.all(ids.map(id => detachEmbeddedTab(state, id)))
  }
  return {
    async call(action, payload, signal, settings) {
      signal.throwIfAborted()
      if (action === 'tabs') return handleEmbeddedTabs(state, payload, signal, settings)
      const tabId = resolveTargetTabId(state, payload)
      if (action === 'navigate') {
        return handleEmbeddedNavigate(state, { tabId, payload, signal, settings })
      }
      const existingTab = state.controller.listTabs().find(tab => tab.tabId === tabId)
      if (existingTab) assertEmbeddedAutomationUrlAllowed(existingTab.url, settings, true)
      const { engine, webContents } = await ensureEmbeddedEngine(state, tabId, signal)
      const liveUrl = webContents.isDestroyed() ? '' : webContents.getURL()
      assertEmbeddedAutomationUrlAllowed(liveUrl, settings, true)
      state.activeTabId = tabId
      return dispatchCdpEngineAction({ engine, tabId, action, payload, signal })
    },
    stop: detachAll,
    async dispose() {
      state.ownedTabs.clear()
      await detachAll()
    },
  }
}
