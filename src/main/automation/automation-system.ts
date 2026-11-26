/**
 * 主进程自动化总控中心：管理自动化设置、实时接管态、全局急停、renderer IPC 以及 Runtime `automation.*` 分发。
 * 运行在 Electron 主进程；拥有急停控制器、活动任务取消集合与各执行驱动的释放入口。
 */
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import {
  AUTOMATION_CHANNELS,
  createIdleTakeoverState,
  type AutomationDetectedBrowser,
  type AutomationPermissionStatus,
  type AutomationRuntimeStatus,
  type AutomationSettings,
  type AutomationSettingsPatch,
  type AutomationTakeoverState,
} from '../../shared/automation.ts'
import { isRecord } from '../../shared/validation.ts'
import {
  createAutomationSettingsStore,
  type AutomationSettingsStore,
} from './automation-settings.ts'
import { createTakeoverOverlay } from './takeover-overlay.ts'

/** 主进程自动化执行器插件契约，供内置浏览器、外置浏览器与桌面操控驱动挂载。 */
export interface AutomationDriverRegistry {
  callEmbeddedBrowser?(
    action: string,
    payload: Record<string, unknown>,
    signal: AbortSignal,
    settings: AutomationSettings,
  ): Promise<unknown>
  callExternalBrowser?(
    action: string,
    payload: Record<string, unknown>,
    signal: AbortSignal,
    settings: AutomationSettings,
  ): Promise<unknown>
  callComputerUse?(
    action: string,
    payload: Record<string, unknown>,
    signal: AbortSignal,
    settings: AutomationSettings,
  ): Promise<unknown>
  detectExternalBrowsers?(): Promise<AutomationDetectedBrowser[]>
  testExternalBrowser?(settings: AutomationSettings): Promise<{
    ok: boolean
    browser: string
    targetCount: number
    mode: 'managed' | 'attached'
  }>
  externalStatus?(): { connected: boolean; targetLabel: string | null }
  checkPermissions?(): Promise<AutomationPermissionStatus>
  openPermissionSettings?(kind: 'accessibility' | 'screen-recording'): Promise<boolean>
  stopEmbedded?(): Promise<void>
  stopExternal?(): Promise<void>
  releaseInputs?(): void
  dispose?(): Promise<void>
}

/** 自动化系统主进程实例接口。 */
export interface AutomationSystemController {
  readSettings(): AutomationSettings
  updateSettings(patch: AutomationSettingsPatch): AutomationSettings
  getTakeoverState(): AutomationTakeoverState
  stopTakeover(reason?: string): Promise<void>
  handleRuntimeCall(
    method: string,
    payload: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown>
  attachWindow(options: {
    window: BrowserWindow
    assertSender(event: IpcMainInvokeEvent): void
  }): () => void
  registerDrivers(drivers: Partial<AutomationDriverRegistry>): void
  dispose(): Promise<void>
}

const IPC_INVOKE_CHANNELS = [
  AUTOMATION_CHANNELS.readSettings,
  AUTOMATION_CHANNELS.updateSettings,
  AUTOMATION_CHANNELS.status,
  AUTOMATION_CHANNELS.stopTakeover,
  AUTOMATION_CHANNELS.checkPermissions,
  AUTOMATION_CHANNELS.openPermissionSettings,
  AUTOMATION_CHANNELS.detectBrowsers,
  AUTOMATION_CHANNELS.testExternalBrowser,
] as const

function defaultPermissionStatus(): AutomationPermissionStatus {
  const platform =
    process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'other'
  return {
    platform,
    supported: platform === 'darwin' || platform === 'win32',
    nativeLoaded: false,
    accessibility: false,
    screenRecording: false,
    note:
      platform === 'other' ? '桌面操控目前仅支持 macOS 与 Windows。' : '尚未加载桌面操控原生模块。',
  }
}

function parseTakeoverMeta(
  method: string,
  payload: Record<string, unknown>,
): { kind: AutomationTakeoverState['kind']; sessionId: string | null; targetLabel: string } {
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : null
  const label =
    typeof payload.targetLabel === 'string' && payload.targetLabel ? payload.targetLabel : null
  if (method.startsWith('automation.browser.embedded.')) {
    return { kind: 'embedded-browser', sessionId, targetLabel: label ?? '内置浏览器' }
  }
  if (method.startsWith('automation.browser.external.')) {
    return { kind: 'external-browser', sessionId, targetLabel: label ?? '外置浏览器' }
  }
  return { kind: 'computer-use', sessionId, targetLabel: label ?? '桌面操控' }
}

function removeAutomationIpcHandlers(): void {
  for (const channel of IPC_INVOKE_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
}

function registerAutomationIpcHandlers(input: {
  assertSender(event: IpcMainInvokeEvent): void
  store: AutomationSettingsStore
  drivers: AutomationDriverRegistry
  buildStatus(): Promise<AutomationRuntimeStatus>
  applySettingsUpdate(patch: AutomationSettingsPatch): AutomationSettings
  stopTakeover(reason: string): Promise<void>
  getTakeoverState(): AutomationTakeoverState
}): void {
  const { assertSender, store, drivers } = input
  ipcMain.handle(AUTOMATION_CHANNELS.readSettings, event => {
    assertSender(event)
    return store.read()
  })
  ipcMain.handle(AUTOMATION_CHANNELS.updateSettings, (event, patch: unknown) => {
    assertSender(event)
    if (!isRecord(patch)) throw new Error('自动化配置更新参数必须是对象')
    return input.applySettingsUpdate(patch as AutomationSettingsPatch)
  })
  ipcMain.handle(AUTOMATION_CHANNELS.status, event => {
    assertSender(event)
    return input.buildStatus()
  })
  ipcMain.handle(AUTOMATION_CHANNELS.stopTakeover, async event => {
    assertSender(event)
    await input.stopTakeover('用户在界面点击停止接管')
    return input.getTakeoverState()
  })
  ipcMain.handle(AUTOMATION_CHANNELS.checkPermissions, event => {
    assertSender(event)
    return drivers.checkPermissions ? drivers.checkPermissions() : defaultPermissionStatus()
  })
  ipcMain.handle(AUTOMATION_CHANNELS.openPermissionSettings, (event, kind: unknown) => {
    assertSender(event)
    if (kind !== 'accessibility' && kind !== 'screen-recording') {
      throw new Error('不支持的系统权限项')
    }
    return drivers.openPermissionSettings ? drivers.openPermissionSettings(kind) : false
  })
  ipcMain.handle(AUTOMATION_CHANNELS.detectBrowsers, event => {
    assertSender(event)
    return drivers.detectExternalBrowsers ? drivers.detectExternalBrowsers() : []
  })
  ipcMain.handle(AUTOMATION_CHANNELS.testExternalBrowser, event => {
    assertSender(event)
    if (!drivers.testExternalBrowser) throw new Error('外置浏览器驱动尚未就绪')
    return drivers.testExternalBrowser(store.read())
  })
}

async function dispatchDriverMethod(input: {
  method: string
  payload: Record<string, unknown>
  signal: AbortSignal
  settings: AutomationSettings
  drivers: AutomationDriverRegistry
  takeover: AutomationTakeoverState
  buildStatus(): Promise<AutomationRuntimeStatus>
  stopTakeover(reason: string): Promise<void>
  runTracked<T>(
    method: string,
    payload: Record<string, unknown>,
    signal: AbortSignal,
    work: (combinedSignal: AbortSignal) => Promise<T>,
  ): Promise<T>
}): Promise<unknown> {
  const { method, payload, signal, settings, drivers } = input
  if (method === 'automation.status') return input.buildStatus()
  if (method === 'automation.stop') {
    await input.stopTakeover(
      typeof payload.reason === 'string' ? payload.reason : '运行任务请求停止',
    )
    return { stopped: true }
  }
  if (method === 'automation.browser.status') {
    const ext = drivers.externalStatus?.() ?? { connected: false, targetLabel: null }
    return {
      embedded: settings.embeddedBrowser,
      external: {
        ...settings.externalBrowser,
        connected: ext.connected,
        targetLabel: ext.targetLabel,
      },
      takeover: { ...input.takeover },
    }
  }
  if (method.startsWith('automation.browser.embedded.')) {
    if (!settings.embeddedBrowser.enabled) {
      throw new Error(
        'PERMISSION_DENIED：内置浏览器控制已关闭，请在「设置 → 浏览器与桌面操控」中开启',
      )
    }
    if (!drivers.callEmbeddedBrowser) throw new Error('内置浏览器自动化驱动尚未就绪')
    const action = method.slice('automation.browser.embedded.'.length)
    return input.runTracked(method, payload, signal, combined =>
      drivers.callEmbeddedBrowser!(action, payload, combined, settings),
    )
  }
  if (method.startsWith('automation.browser.external.')) {
    if (!settings.externalBrowser.enabled) {
      throw new Error(
        'PERMISSION_DENIED：外置浏览器控制已关闭，请在「设置 → 浏览器与桌面操控」中开启',
      )
    }
    if (!drivers.callExternalBrowser) throw new Error('外置浏览器自动化驱动尚未就绪')
    const action = method.slice('automation.browser.external.'.length)
    return input.runTracked(method, payload, signal, combined =>
      drivers.callExternalBrowser!(action, payload, combined, settings),
    )
  }
  if (method.startsWith('automation.computer.')) {
    const action = method.slice('automation.computer.'.length)
    if (action !== 'status' && !settings.computerUse.enabled) {
      throw new Error(
        'PERMISSION_DENIED：桌面 Computer Use 已关闭，请在「设置 → 浏览器与桌面操控」中开启',
      )
    }
    if (!drivers.callComputerUse) throw new Error('桌面 Computer Use 驱动尚未就绪')
    return input.runTracked(method, payload, signal, combined =>
      drivers.callComputerUse!(action, payload, combined, settings),
    )
  }
  throw new Error(`未知的自动化操作：${method}`)
}

interface ActiveTaskMeta {
  kind: Exclude<AutomationTakeoverState['kind'], null>
  sessionId: string | null
  targetLabel: string
}

interface AutomationSystemState {
  store: ReturnType<typeof createAutomationSettingsStore>
  activeControllers: Map<AbortController, ActiveTaskMeta>
  drivers: AutomationDriverRegistry
  disposers: Array<() => Promise<void>>
  overlay: ReturnType<typeof createTakeoverOverlay>
  takeover: AutomationTakeoverState
  hostWindow: BrowserWindow | null
  ipcInstalled: boolean
  disposed: boolean
}

function broadcastTakeoverState(state: AutomationSystemState): void {
  state.overlay.sync(state.takeover)
  const win = state.hostWindow
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send(AUTOMATION_CHANNELS.stateChanged, { ...state.takeover })
  }
}

function syncTakeoverAfterTaskEnd(state: AutomationSystemState): void {
  const remaining = [...state.activeControllers.values()].at(-1)
  if (remaining) {
    state.takeover = {
      ...state.takeover,
      active: true,
      kind: remaining.kind,
      sessionId: remaining.sessionId,
      targetLabel: remaining.targetLabel,
    }
    broadcastTakeoverState(state)
    return
  }
  if (state.takeover.active) {
    state.takeover = { ...state.takeover, active: false }
    broadcastTakeoverState(state)
  }
}

async function stopActiveTakeover(
  state: AutomationSystemState,
  reason = '用户已停止自动化接管',
  onlyKind?: Exclude<AutomationTakeoverState['kind'], null>,
): Promise<void> {
  const abortError = new Error(`AUTOMATION_STOPPED：${reason}`)
  for (const [controller, meta] of state.activeControllers) {
    if (!onlyKind || meta.kind === onlyKind) {
      state.activeControllers.delete(controller)
      controller.abort(abortError)
    }
  }
  if (!onlyKind || onlyKind === 'computer-use') state.drivers.releaseInputs?.()
  if (!onlyKind) {
    state.takeover = { ...createIdleTakeoverState(), lastStoppedReason: reason }
    broadcastTakeoverState(state)
    return
  }
  if (state.activeControllers.size === 0) {
    state.takeover = { ...createIdleTakeoverState(), lastStoppedReason: reason }
    broadcastTakeoverState(state)
  } else {
    syncTakeoverAfterTaskEnd(state)
  }
}

async function buildRuntimeStatus(state: AutomationSystemState): Promise<AutomationRuntimeStatus> {
  const ext = state.drivers.externalStatus?.() ?? { connected: false, targetLabel: null }
  const permissions = state.drivers.checkPermissions
    ? await state.drivers.checkPermissions()
    : defaultPermissionStatus()
  return {
    settings: state.store.read(),
    takeover: { ...state.takeover },
    permissions,
    externalConnected: ext.connected,
    externalTargetLabel: ext.targetLabel,
  }
}

function updateAutomationSettingsState(
  state: AutomationSystemState,
  patch: AutomationSettingsPatch,
): AutomationSettings {
  const next = state.store.update(patch)
  if (!next.embeddedBrowser.enabled) {
    void stopActiveTakeover(state, '用户已关闭内置浏览器控制', 'embedded-browser')
    void state.drivers.stopEmbedded?.().catch(() => {})
  }
  if (!next.externalBrowser.enabled) {
    void stopActiveTakeover(state, '用户已关闭外置浏览器控制', 'external-browser')
    void state.drivers.stopExternal?.().catch(() => {})
  }
  if (!next.computerUse.enabled) {
    void stopActiveTakeover(state, '用户已关闭桌面操控', 'computer-use')
  }
  const win = state.hostWindow
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send(AUTOMATION_CHANNELS.settingsChanged, next)
  }
  return next
}

async function runTrackedAutomation<T>(
  state: AutomationSystemState,
  input: {
    method: string
    payload: Record<string, unknown>
    signal: AbortSignal
    work: (combinedSignal: AbortSignal) => Promise<T>
  },
): Promise<T> {
  if (state.disposed) throw new Error('自动化服务已关闭')
  input.signal.throwIfAborted()
  if (input.method === 'automation.computer.status') return input.work(input.signal)
  const meta = parseTakeoverMeta(input.method, input.payload)
  const kind = meta.kind ?? 'computer-use'
  const taskController = new AbortController()
  state.activeControllers.set(taskController, {
    kind,
    sessionId: meta.sessionId,
    targetLabel: meta.targetLabel,
  })
  const combined = AbortSignal.any([input.signal, taskController.signal])
  state.takeover = {
    active: true,
    kind,
    sessionId: meta.sessionId,
    targetLabel: meta.targetLabel,
    stepCount: state.takeover.kind === kind ? state.takeover.stepCount + 1 : 1,
    killSwitchShortcut: state.takeover.killSwitchShortcut,
    lastStoppedReason: null,
  }
  broadcastTakeoverState(state)
  try {
    return await input.work(combined)
  } finally {
    state.activeControllers.delete(taskController)
    syncTakeoverAfterTaskEnd(state)
  }
}

function attachAutomationWindow(
  state: AutomationSystemState,
  options: { window: BrowserWindow; assertSender(event: IpcMainInvokeEvent): void },
): () => void {
  state.hostWindow = options.window
  if (state.ipcInstalled) removeAutomationIpcHandlers()
  state.ipcInstalled = true
  registerAutomationIpcHandlers({
    assertSender: options.assertSender,
    store: state.store,
    drivers: state.drivers,
    buildStatus: () => buildRuntimeStatus(state),
    applySettingsUpdate: patch => updateAutomationSettingsState(state, patch),
    stopTakeover: reason => stopActiveTakeover(state, reason),
    getTakeoverState: () => ({ ...state.takeover }),
  })
  return () => {
    if (state.ipcInstalled) {
      state.ipcInstalled = false
      removeAutomationIpcHandlers()
    }
    if (state.hostWindow === options.window) state.hostWindow = null
  }
}

async function disposeAutomationSystem(state: AutomationSystemState): Promise<void> {
  if (state.disposed) return
  state.disposed = true
  await stopActiveTakeover(state, '应用正在退出')
  state.overlay.dispose()
  if (state.ipcInstalled) {
    state.ipcInstalled = false
    removeAutomationIpcHandlers()
  }
  state.hostWindow = null
  const tasks = state.disposers.splice(0).map(fn => fn().catch(() => {}))
  await Promise.all(tasks)
}

/** 创建主进程自动化总控实例；窗口就绪后调用 `attachWindow` 挂载 IPC 与状态推送。 */
export function createAutomationSystem(options: {
  settingsPath: string
  headless?: boolean
}): AutomationSystemController {
  const state: AutomationSystemState = {
    store: createAutomationSettingsStore(options.settingsPath),
    activeControllers: new Map<AbortController, ActiveTaskMeta>(),
    drivers: {},
    disposers: [],
    overlay: createTakeoverOverlay({
      headless: options.headless ?? false,
      onEmergencyStop: reason => {
        void stopActiveTakeover(state, reason)
      },
    }),
    takeover: createIdleTakeoverState(),
    hostWindow: null,
    ipcInstalled: false,
    disposed: false,
  }
  const stopTakeover = (reason?: string) => stopActiveTakeover(state, reason)
  const buildStatus = () => buildRuntimeStatus(state)
  const applySettingsUpdate = (patch: AutomationSettingsPatch) =>
    updateAutomationSettingsState(state, patch)

  return {
    readSettings: () => state.store.read(),
    updateSettings: applySettingsUpdate,
    getTakeoverState: () => ({ ...state.takeover }),
    stopTakeover,
    handleRuntimeCall: (method, payload, signal) => {
      if (state.disposed) return Promise.reject(new Error('自动化服务已关闭'))
      return dispatchDriverMethod({
        method,
        payload,
        signal,
        settings: state.store.read(),
        drivers: state.drivers,
        takeover: state.takeover,
        buildStatus,
        stopTakeover,
        runTracked: (trackedMethod, trackedPayload, trackedSignal, work) =>
          runTrackedAutomation(state, {
            method: trackedMethod,
            payload: trackedPayload,
            signal: trackedSignal,
            work,
          }),
      })
    },
    registerDrivers: partial => {
      const { dispose, ...rest } = partial
      Object.assign(state.drivers, rest)
      if (dispose) state.disposers.push(dispose)
    },
    attachWindow: opts => attachAutomationWindow(state, opts),
    dispose: () => disposeAutomationSystem(state),
  }
}
