/**
 * 外置浏览器纯 CDP 驱动：支持「托管隔离 Profile 实例」与「附着本机 loopback 调试端口」两种模式。
 * 100% 复用 `cdp-engine.ts` 与 `cdp-dispatch.ts`，免装浏览器扩展；内置单飞连接锁、进程回收与主进程 Origin 黑名单守卫。
 */
import type { ChildProcess } from 'node:child_process'
import type { AutomationDetectedBrowser, AutomationSettings } from '../../shared/automation.ts'
import { browserUrl } from '../../shared/browser.ts'
import { dispatchCdpEngineAction, readOptionalString } from './cdp-dispatch.ts'
import { createCdpPageEngine, type CdpPageEngine } from './cdp-engine.ts'
import type { CdpTransport, ImageScaler } from './cdp-transport.ts'
import {
  assertExternalUrlAllowed,
  detectInstalledBrowsers,
  isExternalChildAlive,
  launchManagedBrowserProcess,
  queryLoopbackJson,
  resolveManagedBrowserExecutable,
  terminateExternalChildBestEffort,
} from './external-browser-discovery.ts'
import { connectExternalCdpTransport } from './external-cdp-transport.ts'

interface DevToolsPageTarget {
  id: string
  type: string
  title?: string
  url?: string
  webSocketDebuggerUrl?: string
}

interface DevToolsVersionInfo {
  Browser?: string
  webSocketDebuggerUrl?: string
}

interface PageSlot {
  engine: CdpPageEngine
  transport: CdpTransport
}

interface ExternalSessionState {
  mode: 'managed' | 'attached' | null
  port: number | null
  browserName: string | null
  executablePath: string | null
  child: ChildProcess | null
  browserTransport: CdpTransport | null
  pageEngines: Map<string, PageSlot>
  authorizedTabs: Set<string>
  activeTabId: string | null
  profileDirectory: string
  headless: boolean
  scaler?: ImageScaler
  connectingPromise: Promise<void> | null
  sessionAbort: AbortController
  disposed: boolean
}

/** 外置浏览器自动化驱动接口，供 `automation-system.ts` 注册调用。 */
export interface ExternalBrowserDriver {
  detect(): Promise<AutomationDetectedBrowser[]>
  testConnection(settings: AutomationSettings): Promise<{
    ok: boolean
    browser: string
    targetCount: number
    mode: 'managed' | 'attached'
  }>
  status(): { connected: boolean; targetLabel: string | null }
  stop(): Promise<void>
  call(
    action: string,
    payload: Record<string, unknown>,
    signal: AbortSignal,
    settings: AutomationSettings,
  ): Promise<unknown>
  dispose(): Promise<void>
}

async function waitAndKillChild(child: ChildProcess): Promise<void> {
  if (!isExternalChildAlive(child)) return
  await new Promise<void>(resolve => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(termTimer)
      clearTimeout(killTimer)
      child.removeListener('exit', finish)
      resolve()
    }
    child.once('exit', finish)
    const termTimer = setTimeout(() => terminateExternalChildBestEffort(child), 500)
    const killTimer = setTimeout(() => {
      if (isExternalChildAlive(child)) {
        try {
          child.kill('SIGKILL')
        } catch {
          /* 忽略已退出进程。 */
        }
      }
      finish()
    }, 2200)
  })
}

async function stopExternalSession(state: ExternalSessionState): Promise<void> {
  // 先中止所有在途启动/连接握手，防止停机期间新拉起的 Chrome 成为孤儿进程。
  state.sessionAbort.abort(new Error('外置浏览器会话已停止'))
  state.sessionAbort = new AbortController()
  const slots = [...state.pageEngines.values()]
  state.pageEngines.clear()
  state.authorizedTabs.clear()
  state.activeTabId = null
  await Promise.all(slots.map(slot => slot.engine.dispose().catch(() => {})))

  const browserTransport = state.browserTransport
  const child = state.child
  const wasManaged = state.mode === 'managed'
  state.browserTransport = null
  state.child = null
  state.mode = null
  state.port = null
  state.browserName = null
  state.executablePath = null

  if (wasManaged && browserTransport?.isAlive()) {
    await browserTransport
      .sendCommand('Browser.close', {}, AbortSignal.timeout(1500))
      .catch(() => {})
  }
  await browserTransport?.close().catch(() => {})

  // 附着模式绝不关闭用户的原始浏览器进程；仅托管模式强制回收子进程。
  if (wasManaged && child && isExternalChildAlive(child)) {
    await waitAndKillChild(child)
  }
}

async function connectFreshSession(
  state: ExternalSessionState,
  settings: AutomationSettings,
  signal: AbortSignal,
): Promise<void> {
  const desiredMode = settings.externalBrowser.mode
  if (desiredMode === 'managed') {
    const resolved = resolveManagedBrowserExecutable(settings)
    const launched = await launchManagedBrowserProcess(
      resolved.executablePath,
      state.profileDirectory,
      state.headless,
      signal,
    )
    if (state.disposed || signal.aborted) {
      terminateExternalChildBestEffort(launched.child)
      throw new Error('外置浏览器连接已取消')
    }
    let transport: CdpTransport | null = null
    try {
      transport = await connectExternalCdpTransport(launched.wsUrl, signal, {
        expectedPort: launched.port,
        requireDevToolsPath: true,
      })
      if (state.disposed || signal.aborted) {
        await transport.close().catch(() => {})
        terminateExternalChildBestEffort(launched.child)
        throw new Error('外置浏览器连接已取消')
      }
      // 托管隔离浏览器同样默认禁止自动下载，保持与内置浏览器一致的安全边界。
      await transport
        .sendCommand('Browser.setDownloadBehavior', { behavior: 'deny' }, signal)
        .catch(() => {})
      state.mode = 'managed'
      state.port = launched.port
      state.browserName = resolved.name
      state.executablePath = resolved.executablePath
      state.child = launched.child
      state.browserTransport = transport
      launched.child.once('exit', () => {
        if (state.child === launched.child) void stopExternalSession(state)
      })
    } catch (error) {
      await transport?.close().catch(() => {})
      terminateExternalChildBestEffort(launched.child)
      throw error
    }
    return
  }
  const attachPort = settings.externalBrowser.attachPort
  if (attachPort === null) {
    throw new Error('外置浏览器附着模式未配置本机调试端口（127.0.0.1），请先在设置中填写端口号')
  }
  const version = await queryLoopbackJson<DevToolsVersionInfo>(attachPort, '/json/version', signal)
  if (!version.webSocketDebuggerUrl) {
    throw new Error(`端口 127.0.0.1:${attachPort} 未返回合法的 DevTools WebSocket 地址`)
  }
  const transport = await connectExternalCdpTransport(version.webSocketDebuggerUrl, signal, {
    expectedPort: attachPort,
    requireDevToolsPath: true,
  })
  if (state.disposed || signal.aborted) {
    await transport.close().catch(() => {})
    throw new Error('外置浏览器连接已取消')
  }
  state.mode = 'attached'
  state.port = attachPort
  state.browserName = version.Browser ?? `Attached CDP (:${attachPort})`
  state.browserTransport = transport
}

async function ensureConnected(
  state: ExternalSessionState,
  settings: AutomationSettings,
  signal?: AbortSignal,
): Promise<void> {
  if (state.disposed) throw new Error('外置浏览器驱动已释放')
  signal?.throwIfAborted()
  if (state.connectingPromise) await state.connectingPromise
  if (state.disposed) throw new Error('外置浏览器驱动已释放')
  signal?.throwIfAborted()
  const desiredMode = settings.externalBrowser.mode
  const desiredCustomExe = settings.externalBrowser.executablePath?.trim() || null
  const managedExeMatches = desiredCustomExe === null || state.executablePath === desiredCustomExe
  if (
    state.mode === desiredMode &&
    state.browserTransport?.isAlive() &&
    (desiredMode === 'managed'
      ? isExternalChildAlive(state.child) && managedExeMatches
      : state.port === settings.externalBrowser.attachPort)
  ) {
    return
  }
  const run = (async () => {
    await stopExternalSession(state)
    const effective = signal
      ? AbortSignal.any([signal, state.sessionAbort.signal])
      : state.sessionAbort.signal
    await connectFreshSession(state, settings, effective)
  })()
  state.connectingPromise = run
  try {
    await run
  } finally {
    if (state.connectingPromise === run) state.connectingPromise = null
  }
}

async function listPageTargets(
  state: ExternalSessionState,
  signal?: AbortSignal,
): Promise<DevToolsPageTarget[]> {
  if (state.port === null) return []
  const list = await queryLoopbackJson<DevToolsPageTarget[]>(state.port, '/json/list', signal)
  return list.filter(item => item.type === 'page' && typeof item.id === 'string')
}

async function createPageTarget(
  state: ExternalSessionState,
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!state.browserTransport?.isAlive()) throw new Error('外置浏览器连接未就绪')
  const created = await state.browserTransport.sendCommand<{ targetId?: string }>(
    'Target.createTarget',
    { url },
    signal,
  )
  if (!created?.targetId) throw new Error('外置浏览器未能创建新标签页')
  state.authorizedTabs.add(created.targetId)
  state.activeTabId = created.targetId
  return created.targetId
}

async function ensurePageEngine(
  state: ExternalSessionState,
  requestedTabId: string | undefined,
  settings: AutomationSettings,
  signal?: AbortSignal,
): Promise<{ tabId: string; engine: CdpPageEngine; transport: CdpTransport }> {
  const pages = await listPageTargets(state, signal)
  let tabId = requestedTabId ?? state.activeTabId ?? undefined
  if (tabId && !pages.some(page => page.id === tabId)) tabId = undefined
  if (!tabId) {
    if (state.mode === 'managed' && pages[0]) {
      tabId = pages[0].id
      state.authorizedTabs.add(tabId)
    } else {
      // 附着模式下默认新建受管标签，不静默读取用户已打开的未授权标签页。
      tabId = await createPageTarget(state, 'about:blank', signal)
    }
  }
  if (state.mode === 'attached' && !state.authorizedTabs.has(tabId)) {
    throw new Error('PERMISSION_DENIED：附着模式仅允许操控由 AI 新建或已明确授权的标签页')
  }
  const targetMeta =
    pages.find(page => page.id === tabId) ??
    (await listPageTargets(state, signal)).find(page => page.id === tabId)
  if (targetMeta?.url) assertExternalUrlAllowed(targetMeta.url, settings, true)
  state.activeTabId = tabId
  const cached = state.pageEngines.get(tabId)
  if (cached && cached.transport.isAlive()) return { tabId, ...cached }
  if (cached) {
    state.pageEngines.delete(tabId)
    await cached.engine.dispose().catch(() => {})
  }
  const wsUrl =
    targetMeta?.webSocketDebuggerUrl ?? `ws://127.0.0.1:${state.port}/devtools/page/${tabId}`
  const transport = await connectExternalCdpTransport(wsUrl, signal, {
    ...(state.port !== null ? { expectedPort: state.port } : {}),
    requireDevToolsPath: true,
  })
  const engine = createCdpPageEngine({
    transport,
    ...(state.scaler ? { scaler: state.scaler } : {}),
  })
  try {
    await engine.init(signal)
  } catch (error) {
    await engine.dispose().catch(() => {})
    throw error
  }
  state.pageEngines.set(tabId, { engine, transport })
  return { tabId, engine, transport }
}

async function handleExternalTabs(
  state: ExternalSessionState,
  payload: Record<string, unknown>,
  signal: AbortSignal,
  settings: AutomationSettings,
): Promise<unknown> {
  const op = readOptionalString(payload, 'operation') ?? 'list'
  if (op === 'new') {
    const rawUrl = readOptionalString(payload, 'url')
    const url = rawUrl ? browserUrl(rawUrl) : 'about:blank'
    assertExternalUrlAllowed(url, settings, true)
    const createdId = await createPageTarget(state, url, signal)
    await ensurePageEngine(state, createdId, settings, signal)
  } else if (op === 'switch') {
    const tabId = readOptionalString(payload, 'tabId')
    if (!tabId) throw new Error('切换外置浏览器标签页需要指定 tabId')
    const pagesNow = await listPageTargets(state, signal)
    const matched = pagesNow.find(page => page.id === tabId)
    if (!matched) throw new Error(`未找到外置浏览器标签页：${tabId}`)
    if (state.mode === 'attached' && !state.authorizedTabs.has(tabId)) {
      throw new Error('PERMISSION_DENIED：附着模式禁止切换至未授权的用户私有标签页')
    }
    if (matched.url) assertExternalUrlAllowed(matched.url, settings, true)
    state.activeTabId = tabId
    await state.browserTransport
      ?.sendCommand('Target.activateTarget', { targetId: tabId }, signal)
      .catch(() => {})
  } else if (op === 'close') {
    const tabId = readOptionalString(payload, 'tabId') ?? state.activeTabId
    if (tabId) {
      if (state.mode === 'attached' && !state.authorizedTabs.has(tabId)) {
        throw new Error('PERMISSION_DENIED：附着模式禁止关闭未授权的用户私有标签页')
      }
      const existing = state.pageEngines.get(tabId)
      state.pageEngines.delete(tabId)
      state.authorizedTabs.delete(tabId)
      await existing?.engine.dispose().catch(() => {})
      await state.browserTransport
        ?.sendCommand('Target.closeTarget', { targetId: tabId }, signal)
        .catch(() => {})
      if (state.activeTabId === tabId) state.activeTabId = null
    }
  }
  const pages = await listPageTargets(state, signal)
  const visible =
    state.mode === 'attached' ? pages.filter(page => state.authorizedTabs.has(page.id)) : pages
  return {
    activeTabId: state.activeTabId ?? visible[0]?.id ?? '',
    tabs: visible.map(page => ({
      tabId: page.id,
      url: page.url ?? '',
      title: page.title ?? '',
      loading: false,
    })),
  }
}

function createLoadWaiter(
  transport: CdpTransport,
  signal: AbortSignal,
): { promise: Promise<void>; cancel(): void } {
  let cancelFn: (() => void) | null = null
  const promise = new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('外置浏览器导航已取消'))
      return
    }
    let settled = false
    const done = (err?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      offLoad()
      signal.removeEventListener('abort', onAbort)
      if (err) reject(err)
      else resolve()
    }
    const onAbort = () => done(signal.reason ?? new Error('外置浏览器导航已取消'))
    const offLoad = transport.onEvent('Page.loadEventFired', () => done())
    const timer = setTimeout(() => done(), 4000)
    signal.addEventListener('abort', onAbort, { once: true })
    cancelFn = () => done()
  })
  return {
    promise,
    cancel() {
      cancelFn?.()
    },
  }
}

async function handleExternalNavigate(
  state: ExternalSessionState,
  payload: Record<string, unknown>,
  signal: AbortSignal,
  settings: AutomationSettings,
): Promise<unknown> {
  const { tabId, engine, transport } = await ensurePageEngine(
    state,
    readOptionalString(payload, 'tabId'),
    settings,
    signal,
  )
  const mode = readOptionalString(payload, 'mode') ?? 'url'
  engine.invalidateSnapshot()
  const runNav = async (cmd: () => Promise<unknown>) => {
    const waiter = createLoadWaiter(transport, signal)
    try {
      await cmd()
      await waiter.promise
    } catch (error) {
      waiter.cancel()
      throw error
    }
  }
  if (mode === 'reload') {
    await runNav(() => transport.sendCommand('Page.reload', {}, signal))
  } else if (mode === 'back' || mode === 'forward') {
    const history = await transport.sendCommand<{
      currentIndex?: number
      entries?: Array<{ id: number; url?: string }>
    }>('Page.getNavigationHistory', {}, signal)
    const delta = mode === 'back' ? -1 : 1
    const targetEntry = history.entries?.[(history.currentIndex ?? 0) + delta]
    if (targetEntry) {
      if (targetEntry.url) assertExternalUrlAllowed(targetEntry.url, settings, true)
      await runNav(() =>
        transport.sendCommand('Page.navigateToHistoryEntry', { entryId: targetEntry.id }, signal),
      )
    }
  } else {
    const rawUrl = readOptionalString(payload, 'url')
    if (!rawUrl) throw new Error('导航需要提供有效的 http(s) 网址')
    const targetUrl = browserUrl(rawUrl)
    assertExternalUrlAllowed(targetUrl, settings, false)
    await runNav(() => transport.sendCommand('Page.navigate', { url: targetUrl }, signal))
  }
  const after = (await listPageTargets(state, signal)).find(page => page.id === tabId)
  if (after?.url) assertExternalUrlAllowed(after.url, settings, true)
  return { tabId, url: after?.url ?? '', title: after?.title ?? '', loading: false }
}

/** 创建主进程外置浏览器纯 CDP 自动化驱动。 */
export function createExternalBrowserDriver(options: {
  profileDirectory: string
  headless?: boolean
  scaler?: ImageScaler
}): ExternalBrowserDriver {
  const state: ExternalSessionState = {
    mode: null,
    port: null,
    browserName: null,
    executablePath: null,
    child: null,
    browserTransport: null,
    pageEngines: new Map(),
    authorizedTabs: new Set(),
    activeTabId: null,
    profileDirectory: options.profileDirectory,
    headless: options.headless ?? false,
    ...(options.scaler ? { scaler: options.scaler } : {}),
    connectingPromise: null,
    sessionAbort: new AbortController(),
    disposed: false,
  }

  return {
    detect: async () => detectInstalledBrowsers(),
    async testConnection(settings) {
      const wasConnected = Boolean(state.browserTransport?.isAlive())
      await ensureConnected(state, settings, AbortSignal.timeout(16_000))
      const pages = await listPageTargets(state, AbortSignal.timeout(5000))
      const result = {
        ok: true,
        browser: state.browserName ?? 'Chromium',
        targetCount: pages.length,
        mode: state.mode ?? settings.externalBrowser.mode,
      }
      // 未开启外置浏览器且仅用于连通性检测时，检测完成后自动清理临时拉起的托管进程。
      if (!settings.externalBrowser.enabled && !wasConnected && state.mode === 'managed') {
        await stopExternalSession(state)
      }
      return result
    },
    status: () => ({
      connected: Boolean(state.browserTransport?.isAlive()),
      targetLabel:
        state.browserTransport?.isAlive() && state.browserName
          ? `${state.browserName}${state.port ? ` (127.0.0.1:${state.port})` : ''}`
          : null,
    }),
    stop: () => stopExternalSession(state),
    async call(action, payload, signal, settings) {
      signal.throwIfAborted()
      await ensureConnected(state, settings, signal)
      if (action === 'tabs') return handleExternalTabs(state, payload, signal, settings)
      if (action === 'navigate') return handleExternalNavigate(state, payload, signal, settings)
      const { tabId, engine } = await ensurePageEngine(
        state,
        readOptionalString(payload, 'tabId'),
        settings,
        signal,
      )
      return dispatchCdpEngineAction({ engine, tabId, action, payload, signal })
    },
    async dispose() {
      state.disposed = true
      await stopExternalSession(state)
    },
  }
}
