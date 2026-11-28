/**
 * 主窗口桌面控制器总装配与退出清理协调器。
 *
 * 将外观设置、终端、文件树状态、浏览器预览、桌面自动化驱动、主进程 IPC、
 * 实时事件流和退出收尾串联为单一窗口会话对象，保证所有子系统按声明顺序释放。
 */

import { join } from 'node:path'
import { app, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { installApplicationMenu } from '../app-menu.ts'
import { installAttachmentController } from '../attachments/attachment-controller.ts'
import type { createAutomationSystem } from '../automation/automation-system.ts'
import { createComputerUseDriver } from '../automation/computer-use-driver.ts'
import { createEmbeddedBrowserDriver } from '../automation/embedded-browser-driver.ts'
import { createExternalBrowserDriver } from '../automation/external-browser-driver.ts'
import { scaleImageWithNativeImage } from '../automation/image-scaler.ts'
import { installBrowserController } from '../browser/browser-controller.ts'
import { installFileWorkspaceStateController } from '../files/file-workspace-state-controller.ts'
import {
  HOST_CHANNELS,
  installHostIpcController,
  type HostIpcController,
} from '../host/host-ipc-controller.ts'
import type { HostStateOrchestrator } from '../host/host-state-orchestrator.ts'
import { createInteractionBroker } from '../host/interaction-broker.ts'
import {
  createLiveStreamsCoordinator,
  type LiveStreamsCoordinator,
} from '../host/live-streams-coordinator.ts'
import { focusPrimaryWindow } from '../lifecycle/app-lifecycle.ts'
import { startWindowsDevDesktopGuard } from '../lifecycle/desktop-session-guard.ts'
import { installWindowCloseGuard } from '../lifecycle/window-close-guard.ts'
import { shutdownImportController } from '../runtime/import-controller.ts'
import { installPluginController } from '../runtime/plugin-controller.ts'
import { installProjectEventsController } from '../runtime/project-events-controller.ts'
import { installRemoteController } from '../runtime/remote-controller.ts'
import type { createRuntimeStreamCarrier } from '../runtime/runtime-stream.ts'
import type {
  MydshRuntimeSupervisor,
  RuntimeState as DshHostState,
} from '../runtime/runtime-supervisor.ts'
import { installWindowNavigationGuards } from '../security/window-navigation.ts'
import { installDesktopSettingsController } from '../settings/controller.ts'
import type { DesktopSettingsStore } from '../settings/desktop-settings.ts'
import { installProjectTaskController } from '../tasks/project-task-controller.ts'
import { installTerminalController } from '../terminal/terminal-controller.ts'
import type { VerifyReport, VerifyStage } from '../verification/desktop-verifier.ts'
import type { HostVerificationBridge } from '../verification/host-verify-context.ts'
import type { VerifyEnvironment } from '../verification/verify-environment.ts'
import { installTrafficLights, syncTrafficLights } from '../window-controls.ts'
import { installWindowController } from '../window-controller.ts'
import { installProjectIpcController, type ProjectIpcController } from './project-ipc-controller.ts'

/** 主进程单实例窗口运行期共享状态。 */
export interface MainSessionState {
  quitting: boolean
  exitCode: number
  revealed: boolean
  workspaceOpened: boolean
  trafficLightsInstalled: boolean
  currentHost: Extract<DshHostState, { kind: 'ready' }> | undefined
  unsubscribeHostState: (() => void) | undefined
  verifyReported: boolean
  startupScreenVerified: boolean
  verifyDeadlineTimer: NodeJS.Timeout | undefined
  shutdownPreparation: Promise<void> | undefined
}

/** 装配主窗口控制器的输入参数。 */
export interface PrimarySessionOptions {
  readonly win: BrowserWindow
  readonly targetUrl: URL
  readonly startupUrl: string
  readonly rendererPath: string
  readonly verifyEnv: VerifyEnvironment
  readonly runtimeHome: string
  readonly automationSystem: ReturnType<typeof createAutomationSystem>
  readonly supervisor: MydshRuntimeSupervisor
  readonly runtimeStream: ReturnType<typeof createRuntimeStreamCarrier>
  readonly runtimeCall: (endpoint: string, args: Record<string, unknown>) => Promise<unknown>
  readonly settingsStore: DesktopSettingsStore
  readonly verifyBackgroundSource: string | undefined
  readonly state: MainSessionState
  readonly sameRendererPage: (url: string) => boolean
  readonly assertTrustedSender: (event: IpcMainInvokeEvent, win: BrowserWindow) => void
}

function registerAutomationDrivers(options: {
  readonly win: BrowserWindow
  readonly isVerifyMode: boolean
  readonly runtimeHome: string
  readonly automationSystem: ReturnType<typeof createAutomationSystem>
  readonly browserController: ReturnType<typeof installBrowserController>
  readonly assertSender: (event: IpcMainInvokeEvent) => void
}): () => void {
  const { win, isVerifyMode, runtimeHome, automationSystem, browserController, assertSender } =
    options
  const embeddedBrowserDriver = createEmbeddedBrowserDriver(browserController)
  const externalBrowserDriver = createExternalBrowserDriver({
    profileDirectory: join(runtimeHome, 'cache', 'external-browser-profile'),
    headless: isVerifyMode,
    scaler: scaleImageWithNativeImage,
  })
  const computerUseDriver = createComputerUseDriver({ headless: isVerifyMode })
  automationSystem.registerDrivers({
    callEmbeddedBrowser: embeddedBrowserDriver.call,
    stopEmbedded: embeddedBrowserDriver.stop,
    dispose: embeddedBrowserDriver.dispose,
  })
  automationSystem.registerDrivers({
    callExternalBrowser: externalBrowserDriver.call,
    detectExternalBrowsers: externalBrowserDriver.detect,
    testExternalBrowser: externalBrowserDriver.testConnection,
    externalStatus: externalBrowserDriver.status,
    stopExternal: externalBrowserDriver.stop,
    dispose: externalBrowserDriver.dispose,
  })
  automationSystem.registerDrivers({
    callComputerUse: computerUseDriver.call,
    checkPermissions: computerUseDriver.checkPermissions,
    openPermissionSettings: computerUseDriver.openPermissionSettings,
    releaseInputs: computerUseDriver.releaseInputs,
    dispose: computerUseDriver.dispose,
  })
  return automationSystem.attachWindow({ window: win, assertSender })
}

function installProjectDomainControllers(
  options: PrimarySessionOptions,
  resolveProjectDirectory: (id: unknown) => string,
  assertSender: (event: IpcMainInvokeEvent) => void,
) {
  const { win, supervisor } = options
  const userData = app.getPath('userData')
  const attachmentController = installAttachmentController({ window: win, assertSender })
  const projectTaskController = installProjectTaskController({
    window: win,
    storagePath: join(userData, 'project-tasks.json'),
    assertSender,
    resolveProjectDirectory,
  })
  const terminalController = installTerminalController({
    window: win,
    assertSender,
    runtime: supervisor,
    resolveTaskLaunch: (projectId, taskId) =>
      projectTaskController.resolveLaunch(projectId, taskId),
  })
  const projectEventsController = installProjectEventsController({
    window: win,
    runtime: supervisor,
  })
  const fileWorkspaceStateController = installFileWorkspaceStateController({
    storagePath: join(userData, 'file-workspace-state.json'),
    assertSender,
    resolveProjectDirectory,
  })
  return [
    attachmentController,
    terminalController,
    projectEventsController,
    projectTaskController,
    fileWorkspaceStateController,
  ]
}

function installWorkspaceControllers(
  options: PrimarySessionOptions,
  resolveProjectDirectory: (id: unknown) => string,
  assertSender: (event: IpcMainInvokeEvent) => void,
) {
  const { win, startupUrl, verifyEnv, runtimeHome, automationSystem, supervisor, settingsStore } =
    options
  const windowController = installWindowController({
    window: win,
    isTrustedPage: url => options.sameRendererPage(url) || url === startupUrl,
  })
  const settingsController = installDesktopSettingsController({
    window: win,
    store: settingsStore,
    assertSender,
    isTrustedRendererPage: options.sameRendererPage,
    onPublished: () => {
      if (options.state.trafficLightsInstalled) syncTrafficLights(win)
    },
    ...(options.verifyBackgroundSource === undefined
      ? {}
      : { verificationBackgroundPath: options.verifyBackgroundSource }),
  })
  const domainControllers = installProjectDomainControllers(
    options,
    resolveProjectDirectory,
    assertSender,
  )
  const browserController = installBrowserController({
    window: win,
    assertSender,
    resolveProjectDirectory,
  })
  const detachAutomation = registerAutomationDrivers({
    win,
    isVerifyMode: verifyEnv.isVerifyMode,
    runtimeHome,
    automationSystem,
    browserController,
    assertSender,
  })
  win.once('closed', installPluginController(win, supervisor, options.assertTrustedSender))
  win.once('closed', installRemoteController(win, supervisor, options.assertTrustedSender))

  return {
    windowController,
    settingsController,
    dispose(): Promise<void> {
      for (const item of [settingsController, windowController, ...domainControllers]) {
        item.dispose()
      }
      detachAutomation()
      const automationDisposed = automationSystem.dispose()
      browserController.dispose()
      return automationDisposed.catch(() => {})
    },
  }
}

function createShutdownController(options: {
  readonly isVerifyMode: boolean
  readonly state: MainSessionState
  readonly supervisor: MydshRuntimeSupervisor
  readonly menu: ReturnType<typeof installApplicationMenu>
  readonly navigationGuards: ReturnType<typeof installWindowNavigationGuards>
  readonly devDesktopGuard: ReturnType<typeof startWindowsDevDesktopGuard>
  readonly workspaceControllers: ReturnType<typeof installWorkspaceControllers>
  readonly projectController: ProjectIpcController
  readonly closeGuard: ReturnType<typeof installWindowCloseGuard>
  readonly hostIpc: HostIpcController
  readonly liveStreams: LiveStreamsCoordinator
}): (code: number) => Promise<void> {
  const { isVerifyMode, state } = options
  const prepareShutdown = (): Promise<void> => {
    if (state.shutdownPreparation !== undefined) return state.shutdownPreparation
    state.quitting = true
    options.menu.dispose()
    state.unsubscribeHostState?.()
    state.unsubscribeHostState = undefined
    if (state.verifyDeadlineTimer !== undefined) clearTimeout(state.verifyDeadlineTimer)
    options.navigationGuards.disposeWatcher()
    options.devDesktopGuard.dispose()
    const workspaceDisposed = options.workspaceControllers.dispose()
    options.projectController.dispose()
    options.closeGuard.dispose()
    const hostIpcDisposed = options.hostIpc.dispose()
    const streamStopped = options.liveStreams.stop()
    state.shutdownPreparation = Promise.all([
      hostIpcDisposed,
      workspaceDisposed,
      streamStopped.then(() => {
        if (isVerifyMode) console.log('desktop-shell-verify-cleanup: streams')
      }),
      shutdownImportController(options.supervisor)
        .then(() => options.supervisor.shutdown())
        .catch((error: unknown) => {
          console.warn('停止 MyDSH 运行核心失败，将继续退出：', error)
        })
        .then(() => {
          if (isVerifyMode) console.log('desktop-shell-verify-cleanup: runtime')
        }),
    ]).then(() => undefined)
    return state.shutdownPreparation
  }
  return async (code: number): Promise<void> => {
    state.exitCode = Math.max(state.exitCode, code)
    await prepareShutdown()
    app.exit(state.exitCode)
  }
}

function installSessionGuardsAndHostIpc(options: {
  readonly primary: PrimarySessionOptions
  readonly assertSender: (event: IpcMainInvokeEvent) => void
  readonly projectController: ProjectIpcController
  readonly interactionBroker: ReturnType<typeof createInteractionBroker>
  readonly liveStreams: LiveStreamsCoordinator
  readonly refs: { hostIpc?: HostIpcController; shutdown?: (code: number) => Promise<void> }
}) {
  const { primary, assertSender, projectController, interactionBroker, liveStreams, refs } = options
  const { win, targetUrl, verifyEnv, supervisor, runtimeStream, state } = primary
  const closeGuard = installWindowCloseGuard({
    window: win,
    assertSender,
    isTrustedRendererPage: primary.sameRendererPage,
    isQuitting: () => state.quitting,
    onDocumentEditedChanged: () => refs.hostIpc?.syncPluginBusy() ?? Promise.resolve(),
    onConfirmQuit: () => void refs.shutdown?.(state.exitCode),
  })
  const hostIpc = installHostIpcController({
    window: win,
    targetUrl,
    supervisor,
    runtimeStream,
    liveStreams,
    interactionBroker,
    projectController,
    assertSender,
    isQuitting: () => state.quitting,
    isDocumentEdited: closeGuard.isDocumentEdited,
  })
  refs.hostIpc = hostIpc
  const devDesktopGuard = startWindowsDevDesktopGuard({
    isPackaged: app.isPackaged,
    isVerifyMode: verifyEnv.isVerifyMode,
    onIsolatedDesktop: () => void refs.shutdown?.(1),
  })
  const navigationGuards = installWindowNavigationGuards({
    window: win,
    targetUrl,
    rendererPath: primary.rendererPath,
    isVerifyMode: verifyEnv.isVerifyMode,
    isQuitting: () => state.quitting,
    isWorkspaceOpened: () => state.workspaceOpened,
    isDocumentEdited: closeGuard.isDocumentEdited,
    isTrustedRendererPage: primary.sameRendererPage,
    onDidNavigate: () => void liveStreams.stop(),
    onFatalLoadFailure: () => void refs.shutdown?.(1),
  })
  return { closeGuard, hostIpc, devDesktopGuard, navigationGuards }
}

/** 装配主窗口全部 IPC 控制器、事件流协调器与退出释放函数。 */
export function assemblePrimarySession(options: PrimarySessionOptions) {
  const { win, targetUrl, verifyEnv, supervisor, runtimeStream, runtimeCall, state } = options
  const assertSender = (event: IpcMainInvokeEvent): void => options.assertTrustedSender(event, win)
  const projectController = installProjectIpcController({ window: win, assertSender, runtimeCall })
  const workspaceControllers = installWorkspaceControllers(
    options,
    projectController.resolveProjectDirectory,
    assertSender,
  )
  const menu = installApplicationMenu({
    window: win,
    isQuitting: () => state.quitting,
    isVerifyMode: verifyEnv.isVerifyMode,
    onOpenSettings: workspaceControllers.settingsController.requestOpen,
  })
  const interactionBroker = createInteractionBroker({
    targetUrl,
    supervisor,
    sendSessionFrame: frame => win.webContents.send(HOST_CHANNELS.sessionFrame, frame),
  })
  const liveStreams = createLiveStreamsCoordinator({
    window: win,
    targetUrl,
    runtimeStream,
    isQuitting: () => state.quitting,
    isTrustedRendererPage: options.sameRendererPage,
    getCurrentHost: () => state.currentHost,
    observeInteractionFrame: interactionBroker.observeFrame,
    clearPendingInteractions: interactionBroker.clear,
  })
  const refs: { hostIpc?: HostIpcController; shutdown?: (code: number) => Promise<void> } = {}
  const { closeGuard, hostIpc, devDesktopGuard, navigationGuards } = installSessionGuardsAndHostIpc(
    {
      primary: options,
      assertSender,
      projectController,
      interactionBroker,
      liveStreams,
      refs,
    },
  )
  const shutdown = createShutdownController({
    isVerifyMode: verifyEnv.isVerifyMode,
    state,
    supervisor,
    menu,
    navigationGuards,
    devDesktopGuard,
    workspaceControllers,
    projectController,
    closeGuard,
    hostIpc,
    liveStreams,
  })
  refs.shutdown = shutdown
  return {
    projectController,
    workspaceControllers,
    menu,
    interactionBroker,
    liveStreams,
    closeGuard,
    hostIpc,
    navigationGuards,
    shutdown,
  }
}

/** 组装隔离验收套件所需的主进程桥接上下文。 */
export function buildVerificationBridge(deps: {
  readonly win: BrowserWindow
  readonly targetUrl: URL
  readonly startupUrl: string
  readonly nativeTransparency: boolean
  readonly verifyEnv: VerifyEnvironment
  readonly supervisor: MydshRuntimeSupervisor
  readonly settingsStore: DesktopSettingsStore
  readonly session: ReturnType<typeof assemblePrimarySession>
  readonly hostOrchestrator: HostStateOrchestrator
  readonly runtimeCall: (endpoint: string, args: Record<string, unknown>) => Promise<unknown>
  readonly state: MainSessionState
  readonly sameRendererPage: (url: string) => boolean
  readonly getStage: () => VerifyStage
  readonly setStage: (stage: VerifyStage) => void
  readonly finishVerify: (report: VerifyReport, code: number) => void
}): HostVerificationBridge {
  const { win, verifyEnv, session, state } = deps
  return {
    win,
    supervisor: deps.supervisor,
    fetch: deps.supervisor.fetch,
    targetUrl: deps.targetUrl,
    settingsStore: deps.settingsStore,
    settingsController: session.workspaceControllers.settingsController,
    windowController: session.workspaceControllers.windowController,
    applicationMenu: session.menu.applicationMenu,
    appearanceMenuItem: session.menu.appearanceMenuItem,
    updateMenuItem: session.menu.updateMenuItem,
    startupDocument: deps.startupUrl,
    nativeTransparency: deps.nativeTransparency,
    verifyBackground: verifyEnv.isVerifyBackground,
    verifyHome: verifyEnv.verifyHome ?? '',
    verifyProject: verifyEnv.verifyProject ?? '',
    hostChannels: HOST_CHANNELS,
    commandRunIdsObserved: session.liveStreams.commandRunIdsObserved,
    commandDoneIdsObserved: session.liveStreams.commandDoneIdsObserved,
    getStage: deps.getStage,
    setStage: deps.setStage,
    isStartupScreenVerified: () => state.startupScreenVerified,
    setStartupScreenVerified: verified => {
      state.startupScreenVerified = verified
    },
    isVerifyReported: () => state.verifyReported,
    getCurrentHost: () => state.currentHost,
    getHostStateRender: deps.hostOrchestrator.getHostStateRender,
    getLiveStreamsController: session.liveStreams.getController,
    getProjects: session.projectController.getProjects,
    getSessionExportController: session.hostIpc.getSessionExportController,
    isSessionStreamFrameObserved: session.liveStreams.isSessionStreamFrameObserved,
    isHostEventStreamFrameObserved: session.liveStreams.isHostEventStreamFrameObserved,
    loadStartup: deps.hostOrchestrator.loadStartup,
    sameRendererPage: deps.sameRendererPage,
    runtimeCall: deps.runtimeCall,
    observeInteractionFrame: session.interactionBroker.observeFrame,
    artifactPath: verifyEnv.artifactPath,
    finishVerify: deps.finishVerify,
  }
}

/** 绑定本地工作台页面加载完成后的红绿灯、聚焦、热刷新与自动验收触发器。 */
export function bindDidFinishLoadHandler(options: {
  readonly win: BrowserWindow
  readonly verifyEnv: VerifyEnvironment
  readonly session: ReturnType<typeof assemblePrimarySession>
  readonly state: MainSessionState
  readonly sameRendererPage: (url: string) => boolean
  readonly reveal: () => void
  readonly createBridge: () => HostVerificationBridge
}): void {
  const { win, verifyEnv, session, state, reveal, createBridge } = options
  win.webContents.on('did-finish-load', () => {
    if (!options.sameRendererPage(win.webContents.getURL())) {
      session.menu.appearanceMenuItem.enabled = false
      return
    }
    win.webContents.navigationHistory.clear()
    if (process.platform === 'darwin') {
      win.setWindowButtonVisibility(true)
      if (!state.workspaceOpened) {
        installTrafficLights(win)
        state.trafficLightsInstalled = true
        win.on('leave-full-screen', () => {
          if (state.trafficLightsInstalled) syncTrafficLights(win)
        })
      }
    }
    const firstWorkspaceOpen = !state.workspaceOpened
    state.workspaceOpened = true
    session.menu.appearanceMenuItem.enabled = true
    reveal()
    if (firstWorkspaceOpen && !verifyEnv.isVerifyBackground) {
      app.focus({ steal: true })
      focusPrimaryWindow(win)
      if (!verifyEnv.isVerifyMode) console.info('MyDSH 桌面工作台已就绪。')
    }
    if (firstWorkspaceOpen) session.navigationGuards.startDevReloadWatcherIfEnabled()
    if (verifyEnv.isVerifyInteractive) {
      console.log('desktop-shell-interactive-ready')
    } else if (verifyEnv.isVerifyMode) {
      setTimeout(() => {
        if (
          verifyEnv.isVerifyInteractive ||
          state.currentHost === undefined ||
          state.verifyReported
        ) {
          return
        }
        void import('../verification/entry.ts').then(({ runDesktopVerification }) =>
          runDesktopVerification(createBridge()),
        )
      }, 1_500)
    }
  })
}
