/**
 * 主进程运行核心状态到启动页/工作台窗口的串行状态编排器。
 *
 * 将运行核心生命周期事件串行投影到启动屏阶段文案、首次工作台展开与故障恢复流程，
 * 保证快速状态切换不并发触发重复页面加载，并在后台重启时保留已打开的工作台缓冲。
 */

import type { BrowserWindow } from 'electron'
import type { installApplicationMenu } from '../app-menu.ts'
import type {
  MydshRuntimeSupervisor,
  RuntimeState as DshHostState,
} from '../runtime/runtime-supervisor.ts'
import type { DesktopSettingsStore } from '../settings/desktop-settings.ts'
import {
  createStartupScreenSnapshot,
  createStartupScreenUpdateScript,
} from '../startup/startup-screen.ts'
import type { VerifyReport, VerifyStage } from '../verification/desktop-verifier.ts'
import {
  createStartupFailedVerifyReport,
  redactHostDiagnostic,
  seedVerifySession,
  type VerifyEnvironment,
} from '../verification/verify-environment.ts'
import type { installProjectIpcController } from '../workspace/project-ipc-controller.ts'
import {
  HOST_CHANNELS,
  publicHostState,
  type LiveStreamsCoordinator,
} from './live-streams-coordinator.ts'

/** 创建运行核心状态编排器的输入依赖。 */
export interface HostStateOrchestratorOptions {
  readonly win: BrowserWindow
  readonly targetUrl: URL
  readonly startupPath: string
  readonly startupUrl: string
  readonly rendererPath: string
  readonly verifyEnv: VerifyEnvironment
  readonly supervisor: MydshRuntimeSupervisor
  readonly settingsStore: DesktopSettingsStore
  readonly menu: ReturnType<typeof installApplicationMenu>
  readonly liveStreams: LiveStreamsCoordinator
  readonly projectController: ReturnType<typeof installProjectIpcController>
  readonly syncPluginBusy: () => Promise<void>
  readonly isQuitting: () => boolean
  readonly isWorkspaceOpened: () => boolean
  readonly isTrustedRendererPage: (url: string) => boolean
  readonly getVerificationStage: () => VerifyStage
  readonly setCurrentHost: (host: Extract<DshHostState, { kind: 'ready' }> | undefined) => void
  readonly reveal: () => void
  readonly finishVerify: (report: VerifyReport, code: number) => void
  readonly shutdown: (code: number) => Promise<void>
}

/** 运行核心状态窗口编排器实例。 */
export interface HostStateOrchestrator {
  loadStartup(phase: string): Promise<void>
  queueHostState(state: DshHostState): void
  getHostStateRender(): Promise<void>
}

function expandWindowForWorkspace(win: BrowserWindow, isVerifyBackground: boolean): void {
  // 工作台按正常窗口尺寸初始化，避免把启动小窗记为窄屏导航偏好。
  win.setResizable(true)
  // 去掉 Windows 厚边框后，启用缩放不会自动恢复启动小窗禁用的最大化能力。
  if (process.platform === 'win32') win.setMaximizable(true)
  win.setMinimumSize(900, 600)
  win.setSize(1280, 800)
  // 后台离屏验收维持 1280×800 标准画布，避免小屏幕 CI 显示器压窄窗口隐藏右栏。
  if (!isVerifyBackground) win.center()
}

async function waitTwoFramesOrTimeout(win: BrowserWindow): Promise<void> {
  await Promise.race([
    win.webContents.executeJavaScript(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
    ),
    new Promise(done => {
      setTimeout(done, 250)
    }),
  ])
}

async function handleReadyHostState(
  options: HostStateOrchestratorOptions,
  state: Extract<DshHostState, { kind: 'ready' }>,
  loadStartup: (phase: string) => Promise<void>,
  verifySessionSeededRef: { seeded: boolean },
): Promise<void> {
  const {
    win,
    targetUrl,
    rendererPath,
    verifyEnv,
    supervisor,
    liveStreams,
    syncPluginBusy,
    isQuitting,
    isWorkspaceOpened,
    isTrustedRendererPage,
    setCurrentHost,
  } = options
  setCurrentHost(state)
  if (!isWorkspaceOpened()) await loadStartup('workspace')
  await syncPluginBusy()
  if (verifyEnv.isVerifyMode && !verifyEnv.isVerifyInteractive && !verifySessionSeededRef.seeded) {
    await seedVerifySession({
      verifyProject: verifyEnv.verifyProject,
      targetUrl,
      fetchImpl: supervisor.fetch,
      sessionCookie: state.sessionCookie,
    })
    verifySessionSeededRef.seeded = true
  }
  if (!isTrustedRendererPage(win.webContents.getURL())) {
    if (isQuitting() || win.isDestroyed() || supervisor.getState().kind !== 'ready') return
    await loadStartup('ready')
    await waitTwoFramesOrTimeout(win)
    if (isQuitting() || win.isDestroyed()) return
    if (!isWorkspaceOpened()) expandWindowForWorkspace(win, verifyEnv.isVerifyBackground)
    await win.loadFile(rendererPath)
  } else {
    liveStreams.start(state)
  }
}

async function loadStartupDocument(
  options: HostStateOrchestratorOptions,
  phase: string,
): Promise<void> {
  const { win, startupPath, startupUrl, settingsStore, menu, isQuitting } = options
  if (isQuitting() || win.isDestroyed()) return
  menu.appearanceMenuItem.enabled = false
  if (win.webContents.getURL() !== startupUrl) {
    await win.loadFile(startupPath)
    if (isQuitting() || win.isDestroyed()) return
    const schemeJson = JSON.stringify(settingsStore.read().colorScheme)
    await win.webContents.executeJavaScript(
      `document.documentElement.dataset.colorScheme = ${schemeJson};
       Promise.all([...document.images].map(image => image.decode()))`,
    )
  }
  if (isQuitting() || win.isDestroyed()) return
  await win.webContents.executeJavaScript(
    createStartupScreenUpdateScript(createStartupScreenSnapshot(phase)),
  )
}

async function applyHostStateToWindow(
  options: HostStateOrchestratorOptions,
  state: DshHostState,
  loadStartup: (phase: string) => Promise<void>,
  verifySessionSeededRef: { seeded: boolean },
): Promise<void> {
  const {
    win,
    verifyEnv,
    liveStreams,
    projectController,
    isQuitting,
    isWorkspaceOpened,
    isTrustedRendererPage,
    getVerificationStage,
    setCurrentHost,
    reveal,
    finishVerify,
    shutdown,
  } = options
  if (isQuitting() || win.isDestroyed()) return
  if (isTrustedRendererPage(win.webContents.getURL())) {
    win.webContents.send(HOST_CHANNELS.changed, publicHostState(state))
  }
  if (state.kind === 'ready') {
    await handleReadyHostState(options, state, loadStartup, verifySessionSeededRef)
    return
  }
  void liveStreams.stop()
  setCurrentHost(undefined)
  // Host 恢复不能销毁 renderer 中的文件修改、会话草稿和终端。
  if (isWorkspaceOpened() && isTrustedRendererPage(win.webContents.getURL())) return
  projectController.clearCache()
  if (state.kind === 'unavailable') {
    console.error('MyDSH 启动失败：', redactHostDiagnostic(state.message))
    if (verifyEnv.isVerifyMode) {
      for (const log of state.diagnostics?.logs ?? []) {
        console.error('核心启动诊断：', redactHostDiagnostic(log.message))
      }
      finishVerify(createStartupFailedVerifyReport(getVerificationStage(), state.message, false), 1)
    } else {
      await shutdown(1)
    }
    return
  }
  await loadStartup(state.phase)
  reveal()
}

/** 创建主进程运行核心窗口状态编排器。 */
export function createHostStateOrchestrator(
  options: HostStateOrchestratorOptions,
): HostStateOrchestrator {
  const { verifyEnv, isWorkspaceOpened, getVerificationStage, finishVerify, shutdown } = options
  let hostStateRender = Promise.resolve()
  let pendingHostState: DshHostState | undefined
  const verifySessionSeededRef = { seeded: false }
  const loadStartup = (phase: string): Promise<void> => loadStartupDocument(options, phase)

  const queueHostState = (state: DshHostState): void => {
    pendingHostState = state
    hostStateRender = hostStateRender
      .then(async () => {
        const latest = pendingHostState
        pendingHostState = undefined
        if (latest !== undefined) {
          await applyHostStateToWindow(options, latest, loadStartup, verifySessionSeededRef)
        }
      })
      .catch((error: unknown) => {
        console.error('更新运行核心窗口状态失败：', error)
        if (verifyEnv.isVerifyMode) {
          finishVerify(createStartupFailedVerifyReport(getVerificationStage(), error, false), 1)
        } else if (!isWorkspaceOpened()) {
          void shutdown(1)
        }
      })
  }

  return { loadStartup, queueHostState, getHostStateRender: () => hostStateRender }
}
