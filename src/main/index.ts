/**
 * Electron 主进程入口与桌面生命周期总装配。
 *
 * 负责单实例锁、特权协议声明、主窗口构造以及运行时监督器、IPC 控制器、
 * 实时事件流和退出清理的生命周期编排。
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app, BrowserWindow, nativeImage, protocol, type IpcMainInvokeEvent } from 'electron'
import { LEGACY_USER_DATA_DIRECTORIES, PRODUCT_NAME } from '../shared/product.ts'
import { createAutomationSystem } from './automation/automation-system.ts'
import { BROWSER_PREVIEW_SCHEME } from './browser/browser-preview.ts'
import { connectionSystem } from './connections/connection-system.ts'
import type { HostIpcController } from './host/host-ipc-controller.ts'
import { createHostStateOrchestrator } from './host/host-state-orchestrator.ts'
import { focusPrimaryWindow } from './lifecycle/app-lifecycle.ts'
import type { installWindowCloseGuard } from './lifecycle/window-close-guard.ts'
import { pickWorkspaceDirectory } from './runtime/directory-picker.ts'
import { PLUGIN_CUSTOM_SCHEME } from './runtime/plugin-controller.ts'
import { resolveMydshHome } from './runtime/runtime-install.ts'
import { createRuntimeStreamCarrier } from './runtime/runtime-stream.ts'
import { MydshRuntimeSupervisor } from './runtime/runtime-supervisor.ts'
import type { installWindowNavigationGuards } from './security/window-navigation.ts'
import { DesktopSettingsStore, migrateLegacyDesktopSettings } from './settings/desktop-settings.ts'
import type { VerifyReport, VerifyStage } from './verification/desktop-verifier.ts'
import type { HostVerificationBridge } from './verification/host-verify-context.ts'
import {
  createStartupFailedVerifyReport,
  initializeProcessEnvironment,
  prepareVerifyBackgroundFixtures,
  VERIFY_TOTAL_TIMEOUT_MS,
} from './verification/verify-environment.ts'
import { INITIAL_TRAFFIC_LIGHT_POSITION } from './window-controls.ts'
import {
  assemblePrimarySession,
  bindDidFinishLoadHandler,
  buildVerificationBridge,
  type MainSessionState,
} from './workspace/primary-session-assembler.ts'

// Electron 规定特权协议必须在 app ready 之前通过单次调用统一注册。
protocol.registerSchemesAsPrivileged([PLUGIN_CUSTOM_SCHEME, BROWSER_PREVIEW_SCHEME])

const verifyEnv = initializeProcessEnvironment()

const PRELOAD_PATH = fileURLToPath(new URL('../preload/index.cjs', import.meta.url))
const RENDERER_PATH = fileURLToPath(new URL('../renderer/index.html', import.meta.url))
const STARTUP_PATH = fileURLToPath(new URL('../startup.html', import.meta.url))
const RENDERER_URL = pathToFileURL(RENDERER_PATH).href
const STARTUP_URL = pathToFileURL(STARTUP_PATH).href
const APP_ICON_PATH = fileURLToPath(new URL('../app-icon.png', import.meta.url))

let primaryWindow: BrowserWindow | undefined
let pendingSecondInstance = false
let verificationStage: VerifyStage = 'initializing'

function setVerificationStage(stage: VerifyStage): void {
  verificationStage = stage
  if (verifyEnv.isVerifyMode) console.log(`desktop-shell-verify-stage: ${stage}`)
}

if (verifyEnv.isVerifyMode) setVerificationStage('initializing')

function sameRendererPage(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.protocol === 'file:' && url.href === RENDERER_URL
  } catch {
    return false
  }
}

function assertTrustedRendererSender(event: IpcMainInvokeEvent, win: BrowserWindow): void {
  if (
    event.sender !== win.webContents ||
    event.senderFrame === null ||
    event.senderFrame !== win.webContents.mainFrame ||
    !sameRendererPage(event.senderFrame.url)
  ) {
    throw new Error('桌面请求不是来自受信任的本地 renderer')
  }
}

function createRuntimeInfrastructure() {
  const verifyHome = verifyEnv.verifyHome
  const runtimeHome =
    verifyHome === undefined
      ? resolveMydshHome()
      : (process.env.MYDSH_HOME ?? join(verifyHome, 'mydsh'))
  const automationSystem = createAutomationSystem({
    settingsPath: join(runtimeHome, 'config', 'automation.json'),
    headless: verifyEnv.isVerifyMode,
  })
  const supervisor = new MydshRuntimeSupervisor({
    bundleDirectory: app.isPackaged
      ? join(process.resourcesPath, 'mydsh-runtime')
      : fileURLToPath(new URL('../mydsh-runtime/', import.meta.url)),
    pickDirectory: signal => pickWorkspaceDirectory(primaryWindow, signal),
    connectionSystem: (method, payload, signal) =>
      connectionSystem(method, payload, signal, primaryWindow),
    automationSystem: (method, payload, signal) =>
      automationSystem.handleRuntimeCall(method, payload, signal),
    ...(verifyHome === undefined
      ? {}
      : {
          mydshHome: runtimeHome,
          onSpawned: (child: { pid?: number }) => {
            if (child.pid !== undefined) {
              writeFileSync(join(verifyHome, 'runtime.pid'), `${String(child.pid)}\n`, {
                mode: 0o600,
              })
            }
          },
        }),
  })
  const runtimeCall = async (endpoint: string, args: Record<string, unknown>): Promise<unknown> => {
    const result = (await supervisor.call(endpoint, { args })) as {
      ok: boolean
      value?: unknown
      error?: { message: string }
    }
    if (!result.ok) throw new Error(result.error?.message ?? '运行核心操作失败')
    return result.value
  }
  return {
    runtimeHome,
    automationSystem,
    supervisor,
    runtimeStream: createRuntimeStreamCarrier(supervisor),
    runtimeCall,
  }
}

function prepareAppReadyResources(): {
  readonly appIcon: Electron.NativeImage
  readonly settingsStore: DesktopSettingsStore
  readonly verifyBackgroundSource: string | undefined
} {
  app.setAboutPanelOptions({
    applicationName: PRODUCT_NAME,
    applicationVersion: app.getVersion(),
  })
  if (verifyEnv.verifyHome === undefined) {
    try {
      const migratedFrom = migrateLegacyDesktopSettings(
        app.getPath('userData'),
        LEGACY_USER_DATA_DIRECTORIES.map(directory => join(verifyEnv.appDataPath, directory)),
      )
      if (migratedFrom !== undefined) console.log('已迁移旧版桌面外观设置。')
    } catch (error) {
      console.warn('旧版桌面外观设置迁移失败，已保留原文件并使用当前设置：', error)
    }
  }
  const appIcon = nativeImage.createFromPath(APP_ICON_PATH)
  if (appIcon.isEmpty()) throw new Error('无法加载桌面应用图标')
  if (process.platform === 'darwin') {
    if (app.dock === undefined) throw new Error('无法访问 macOS Dock')
    app.dock.setIcon(appIcon)
  }
  const settingsStore = new DesktopSettingsStore(app.getPath('userData'))
  const verifyBackgroundSource = prepareVerifyBackgroundFixtures(verifyEnv, settingsStore)
  return { appIcon, settingsStore, verifyBackgroundSource }
}

function createPrimaryBrowserWindow(
  appIcon: Electron.NativeImage,
  nativeTransparency: boolean,
): BrowserWindow {
  const win = new BrowserWindow({
    icon: appIcon,
    width: 760,
    height: 480,
    minWidth: 760,
    minHeight: 480,
    // 离屏后台验收在 Windows 1024×720 工作区 + 1.5x 缩放下禁用居中，避免启动小窗被压窄。
    ...(verifyEnv.isVerifyBackground ? { x: 0, y: 0, center: false } : {}),
    show: false,
    resizable: false,
    title: PRODUCT_NAME,
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { ...INITIAL_TRAFFIC_LIGHT_POSITION },
        }
      : { frame: false, thickFrame: false, autoHideMenuBar: true }),
    roundedCorners: true,
    transparent: nativeTransparency,
    backgroundColor: nativeTransparency ? '#00000000' : '#151517',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: !verifyEnv.isVerifyBackground,
      offscreen: verifyEnv.isVerifyBackground,
      preload: PRELOAD_PATH,
    },
  })
  if (process.platform === 'darwin') win.setWindowButtonVisibility(false)
  if (verifyEnv.isVerifyMode) {
    win.webContents.on('console-message', event => {
      console.error(
        `renderer-console[${event.level}]: ${event.message} (${event.sourceId}:${String(event.lineNumber)})`,
      )
    })
    win.webContents.on('render-process-gone', (_event, details) => {
      console.error(`renderer-process-gone: ${details.reason} (${String(details.exitCode)})`)
    })
  }
  return win
}

function attachProcessAndWindowQuitSignals(options: {
  readonly win: BrowserWindow
  readonly closeGuard: ReturnType<typeof installWindowCloseGuard>
  readonly hostIpc: HostIpcController
  readonly navigationGuards: ReturnType<typeof installWindowNavigationGuards>
  readonly getExitCode: () => number
  readonly shutdown: (code: number) => Promise<void>
}): void {
  const { win, closeGuard, hostIpc, navigationGuards, getExitCode, shutdown } = options
  if (verifyEnv.isVerifyMode) {
    process.on('uncaughtException', error => {
      console.error('desktop-shell-verify-uncaught:', error)
      void shutdown(1)
    })
  }
  win.on('closed', () => {
    hostIpc.abortPendingSearch()
    navigationGuards.disposePermissions()
    primaryWindow = undefined
    void shutdown(getExitCode())
  })
  app.on('window-all-closed', () => void shutdown(getExitCode()))
  app.on('before-quit', event => {
    if (closeGuard.handleBeforeQuit(event)) return
    event.preventDefault()
    void shutdown(getExitCode())
  })
  process.once('SIGINT', () => void shutdown(130))
  process.once('SIGTERM', () => void shutdown(143))
}

async function runOptionalStartupScreenVerify(
  state: MainSessionState,
  createBridge: () => HostVerificationBridge,
): Promise<boolean> {
  if (!verifyEnv.isVerifyMode || verifyEnv.isVerifyInteractive) return true
  const { shouldVerifyStartupScreen } = await import('./verification/entry.ts')
  if (shouldVerifyStartupScreen(process.argv)) {
    const { verifyStartupScreen } = await import('./verification/startup-screen-verifier.ts')
    return verifyStartupScreen(createBridge())
  }
  state.startupScreenVerified = true
  setVerificationStage('host')
  return true
}

function createInitialSessionState(): MainSessionState {
  return {
    quitting: false,
    exitCode: 0,
    revealed: false,
    workspaceOpened: false,
    trafficLightsInstalled: false,
    currentHost: undefined,
    unsubscribeHostState: undefined,
    verifyReported: false,
    startupScreenVerified: false,
    verifyDeadlineTimer: undefined,
    shutdownPreparation: undefined,
  }
}

function createSessionVerifyLifecycle(
  win: BrowserWindow,
  state: MainSessionState,
  session: ReturnType<typeof assemblePrimarySession>,
) {
  const reveal = (): void => {
    if (state.revealed || win.isDestroyed()) return
    state.revealed = true
    if (!verifyEnv.isVerifyBackground) win.show()
  }
  const finishVerify = (report: VerifyReport, code: number): void => {
    if (state.verifyReported) return
    state.verifyReported = true
    if (state.verifyDeadlineTimer !== undefined) clearTimeout(state.verifyDeadlineTimer)
    session.hostIpc.abortPendingExport()
    console.log(`desktop-shell-verify: ${JSON.stringify(report)}`)
    state.exitCode = code
    if (code === 0) win.close()
    else void session.shutdown(code)
  }
  if (verifyEnv.isVerifyMode && verifyEnv.verifyDeadline !== undefined) {
    state.verifyDeadlineTimer = setTimeout(
      () => {
        finishVerify(
          createStartupFailedVerifyReport(
            verificationStage,
            new Error(`验收总时限超过 ${String(VERIFY_TOTAL_TIMEOUT_MS)}ms`),
            state.currentHost !== undefined,
          ),
          1,
        )
      },
      Math.max(1, verifyEnv.verifyDeadline - Date.now()),
    )
  }
  return { reveal, finishVerify }
}

function wireOrchestratorAndBridge(options: {
  readonly win: BrowserWindow
  readonly targetUrl: URL
  readonly nativeTransparency: boolean
  readonly infra: ReturnType<typeof createRuntimeInfrastructure>
  readonly settingsStore: DesktopSettingsStore
  readonly state: MainSessionState
  readonly session: ReturnType<typeof assemblePrimarySession>
}) {
  const { win, targetUrl, nativeTransparency, infra, settingsStore, state, session } = options
  const { reveal, finishVerify } = createSessionVerifyLifecycle(win, state, session)
  const hostOrchestrator = createHostStateOrchestrator({
    win,
    targetUrl,
    startupPath: STARTUP_PATH,
    startupUrl: STARTUP_URL,
    rendererPath: RENDERER_PATH,
    verifyEnv,
    supervisor: infra.supervisor,
    settingsStore,
    menu: session.menu,
    liveStreams: session.liveStreams,
    projectController: session.projectController,
    syncPluginBusy: session.hostIpc.syncPluginBusy,
    isQuitting: () => state.quitting,
    isWorkspaceOpened: () => state.workspaceOpened,
    isTrustedRendererPage: sameRendererPage,
    getVerificationStage: () => verificationStage,
    setCurrentHost: host => {
      state.currentHost = host
    },
    reveal,
    finishVerify,
    shutdown: session.shutdown,
  })
  const createBridge = (): HostVerificationBridge =>
    buildVerificationBridge({
      win,
      targetUrl,
      startupUrl: STARTUP_URL,
      nativeTransparency,
      verifyEnv,
      supervisor: infra.supervisor,
      settingsStore,
      session,
      hostOrchestrator,
      runtimeCall: infra.runtimeCall,
      state,
      sameRendererPage,
      getStage: () => verificationStage,
      setStage: setVerificationStage,
      finishVerify,
    })
  return { reveal, hostOrchestrator, createBridge }
}

async function main(): Promise<void> {
  const targetUrl = new URL('http://mydsh.internal/')
  setVerificationStage('host')
  const infra = createRuntimeInfrastructure()
  await app.whenReady()
  const { appIcon, settingsStore, verifyBackgroundSource } = prepareAppReadyResources()
  const nativeTransparency = process.platform === 'darwin'
  const win = createPrimaryBrowserWindow(appIcon, nativeTransparency)
  primaryWindow = win
  if (pendingSecondInstance && !verifyEnv.isVerifyBackground) {
    pendingSecondInstance = false
    focusPrimaryWindow(primaryWindow)
  }

  const state = createInitialSessionState()
  const session = assemblePrimarySession({
    win,
    targetUrl,
    startupUrl: STARTUP_URL,
    rendererPath: RENDERER_PATH,
    verifyEnv,
    ...infra,
    settingsStore,
    verifyBackgroundSource,
    state,
    sameRendererPage,
    assertTrustedSender: assertTrustedRendererSender,
  })
  const { reveal, hostOrchestrator, createBridge } = wireOrchestratorAndBridge({
    win,
    targetUrl,
    nativeTransparency,
    infra,
    settingsStore,
    state,
    session,
  })

  bindDidFinishLoadHandler({
    win,
    verifyEnv,
    session,
    state,
    sameRendererPage,
    reveal,
    createBridge,
  })
  attachProcessAndWindowQuitSignals({
    win,
    closeGuard: session.closeGuard,
    hostIpc: session.hostIpc,
    navigationGuards: session.navigationGuards,
    getExitCode: () => state.exitCode,
    shutdown: session.shutdown,
  })
  await hostOrchestrator.loadStartup('initializing')
  reveal()
  if (!(await runOptionalStartupScreenVerify(state, createBridge))) return
  state.unsubscribeHostState = infra.supervisor.subscribe(hostOrchestrator.queueHostState)
  void infra.supervisor.ensureReady().catch((error: unknown) => {
    if (state.quitting) return
    console.error('MyDSH 启动失败：', error)
    void session.shutdown(1)
  })
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  if (!verifyEnv.isVerifyMode) {
    console.warn(
      `检测到已有 ${PRODUCT_NAME} 实例正在运行，已请求聚焦现有窗口后退出。若屏幕上未显示窗口，旧实例可能仍在后台或隔离终端中运行，请先结束残留的 electron 进程后再试。`,
    )
  }
  app.quit()
} else {
  app.on('second-instance', () => {
    if (verifyEnv.isVerifyBackground) return
    if (!focusPrimaryWindow(primaryWindow)) pendingSecondInstance = true
  })
  void main().catch((error: unknown) => {
    console.error(`${PRODUCT_NAME} 启动失败：`, error)
    app.exit(1)
  })
}
