import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  protocol,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from 'electron'
import { PROJECT_OPERATIONS } from '../runtime/workspace/project-service.ts'
import { DESKTOP_FILE_REFERENCE_CHANNELS } from '../shared/file-references.ts'
import { isGitAiOperation } from '../shared/git-ai-validation.ts'
import {
  LEGACY_USER_DATA_DIRECTORIES,
  PRODUCT_NAME,
  PRODUCT_USER_DATA_DIRECTORY,
} from '../shared/product.ts'
import type {
  DesktopPendingInteraction,
  DesktopQuestionAnswerItem,
  DesktopQuestionItem,
  DesktopSessionFrame,
} from '../shared/session-live.ts'
import { asRecord } from '../shared/validation.ts'
import { parseDesktopWorkspaceCreateResult } from '../shared/workspace-capabilities.ts'
import { installAttachmentController } from './attachments/attachment-controller.ts'
import { createAutomationSystem } from './automation/automation-system.ts'
import { createComputerUseDriver } from './automation/computer-use-driver.ts'
import { createEmbeddedBrowserDriver } from './automation/embedded-browser-driver.ts'
import { createExternalBrowserDriver } from './automation/external-browser-driver.ts'
import { scaleImageWithNativeImage } from './automation/image-scaler.ts'
import { installBrowserController } from './browser/browser-controller.ts'
import { BROWSER_PREVIEW_SCHEME } from './browser/browser-preview.ts'
import { connectionSystem } from './connections/connection-system.ts'
import { installFileWorkspaceStateController } from './files/file-workspace-state-controller.ts'
import {
  callDshHost,
  respondDshInteraction,
  type DshRemoteEventOutcome,
} from './host/host-client.ts'
import {
  followDshHostEventStream,
  readDshWorkspaceBaseline,
  type DshRemoteInteractionTarget,
} from './host/host-event-stream.ts'
import { followDshSessionStream } from './host/session-stream.ts'
import { focusPrimaryWindow } from './lifecycle/app-lifecycle.ts'
import { pickWorkspaceDirectory } from './runtime/directory-picker.ts'
import { createGitAiController } from './runtime/git-ai-controller.ts'
import { callImportController, shutdownImportController } from './runtime/import-controller.ts'
import {
  choosePluginDirectory,
  installPluginController,
  PLUGIN_CUSTOM_SCHEME,
  pluginOperationPayload,
} from './runtime/plugin-controller.ts'
import { installProjectEventsController } from './runtime/project-events-controller.ts'
import { installRemoteController } from './runtime/remote-controller.ts'
import { resolveMydshHome } from './runtime/runtime-install.ts'
import { createRuntimeStreamCarrier } from './runtime/runtime-stream.ts'
import {
  MydshRuntimeSupervisor,
  type RuntimeState as DshHostState,
} from './runtime/runtime-supervisor.ts'
import { installHostPermissionHandlers } from './security/host-permissions.ts'
import { saveSessionLog } from './session-exports/session-log-export.ts'
import { installDesktopSettingsController } from './settings/controller.ts'
import { DesktopSettingsStore, migrateLegacyDesktopSettings } from './settings/desktop-settings.ts'
import {
  createStartupScreenSnapshot,
  createStartupScreenUpdateScript,
} from './startup/startup-screen.ts'
import { installProjectTaskController } from './tasks/project-task-controller.ts'
import { installTerminalController } from './terminal/terminal-controller.ts'
import { checkForProjectUpdate } from './updates/github-updates.ts'
import type { VerifyReport, VerifyStage } from './verification/desktop-verifier.ts'
import type { HostVerificationBridge } from './verification/host-verify-context.ts'
import {
  INITIAL_TRAFFIC_LIGHT_POSITION,
  installTrafficLights,
  syncTrafficLights,
} from './window-controls.ts'
import { installWindowController } from './window-controller.ts'
import type { DesktopProject } from '../runtime/workspace/index.ts'

// Electron 规定特权协议必须在 app ready 之前通过单次调用统一注册。
protocol.registerSchemesAsPrivileged([PLUGIN_CUSTOM_SCHEME, BROWSER_PREVIEW_SCHEME])

const VERIFY_FLAG = '--verify'

function waitForAbortableDelay(signal: AbortSignal, delayMs: number): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) {
      resolve()
      return
    }
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, delayMs)
    timer.unref()
    signal.addEventListener('abort', done, { once: true })
  })
}

function resolveExportDirectory(): string {
  for (const name of ['downloads', 'documents', 'home', 'temp'] as const) {
    try {
      const directory = app.getPath(name)
      if (directory !== '') return directory
    } catch {
      /* 系统已知目录缺失或未在隔离配置下注册时顺序回退。 */
    }
  }
  return tmpdir()
}

function createFailedVerifyReport(
  stage: VerifyStage,
  error: unknown,
  hostReady: boolean,
): VerifyReport {
  return {
    verificationStage: stage,
    hostReady,
    startupScreen: false,
    startupCapture: '',
    startupDarkCapture: '',
    appMounted: false,
    uiActive: false,
    frame: false,
    islandCount: 0,
    canvasCount: 0,
    pageScrollable: false,
    transparentRoots: false,
    settingsDialog: false,
    settingsFocusInside: false,
    settingsLayerCount: 0,
    settingsAccent: '',
    settingsCanvasOpacity: '',
    settingsCanvasAlpha: 0,
    settingsCanvasImageApplied: false,
    settingsPanelFits: false,
    frameOpacity: '',
    islandsOpaque: false,
    nativeSettingsTrigger: false,
    nativeSettingsDialog: false,
    nativeSettingsSidebarRaised: false,
    nativeSettingsTopmost: false,
    nativeAppearanceEntry: false,
    nativeAppearanceEntryPlaced: false,
    appearanceMenu: false,
    appearanceAccelerator: '',
    capture: '',
    darkCapture: '',
    darkSettingsReadable: false,
    largeCapture: '',
    largeLayoutStable: false,
    mediumToolbarStable: false,
    narrowCapture: '',
    narrowSettingsFits: false,
    nativeCapture: '',
    clearCapture: '',
    blank: true,
    error: error instanceof Error ? error.message : String(error),
  }
}

const VERIFY_MODE = process.argv.includes(VERIFY_FLAG)
const VERIFY_SSH = VERIFY_MODE && process.argv.includes('--verify-ssh')
const VERIFY_DATABASE = VERIFY_MODE && process.argv.includes('--verify-database')
// 交互验收保留数据隔离，由操作员检查真实界面，不注入自动验收会话或接管页面。
const VERIFY_INTERACTIVE = VERIFY_MODE && process.argv.includes('--verify-interactive')
const VERIFY_BACKGROUND =
  VERIFY_MODE &&
  !VERIFY_INTERACTIVE &&
  !process.argv.includes('--verify-foreground') &&
  !process.argv.includes('--verify-directory-picker')
if (VERIFY_BACKGROUND && process.platform === 'darwin') app.setActivationPolicy('prohibited')
// Windows 后台离屏验收在无独立 GPU 的 CI 虚拟机上容易反复触发 Chromium GPU 进程崩溃直至中止；
// 按 Electron 离屏渲染要求关闭硬件加速改用软件合成，不影响主进程 DirectComposition 背景校验。
if (VERIFY_BACKGROUND && process.platform === 'win32') app.disableHardwareAcceleration()
// 覆盖首次离线安装两万余核心文件、运行时重启恢复及 macOS/Windows 离屏全量验收；
// 需低于 scripts/runtime-verification.mjs 的外部时限，确保超时时仍能先输出结构化报告。
const VERIFY_TOTAL_TIMEOUT_MS = 480_000
const VERIFY_DEADLINE =
  VERIFY_MODE && !VERIFY_INTERACTIVE ? Date.now() + VERIFY_TOTAL_TIMEOUT_MS : undefined
const VERIFY_HOME_INPUT = process.env.MYDSH_VERIFY_HOME
const VERIFY_HOME_FROM_RUNNER = VERIFY_MODE && VERIFY_HOME_INPUT !== undefined
const VERIFY_HOME = VERIFY_MODE
  ? VERIFY_HOME_INPUT === undefined
    ? mkdtempSync(join(tmpdir(), 'mydsh-verify-'))
    : isAbsolute(VERIFY_HOME_INPUT)
      ? VERIFY_HOME_INPUT
      : (() => {
          throw new Error('MYDSH_VERIFY_HOME 必须是绝对路径')
        })()
  : undefined
const VERIFY_PROJECT_INPUT = process.env.MYDSH_VERIFY_PROJECT
const VERIFY_PROJECT = VERIFY_MODE
  ? (() => {
      if (
        VERIFY_HOME === undefined ||
        VERIFY_PROJECT_INPUT === undefined ||
        !isAbsolute(VERIFY_PROJECT_INPUT)
      ) {
        throw new Error('MYDSH_VERIFY_PROJECT 必须由验收运行器提供绝对路径')
      }
      const project = resolvePath(VERIFY_PROJECT_INPUT)
      const fromHome = relative(VERIFY_HOME, project)
      if (
        fromHome === '' ||
        fromHome === '..' ||
        fromHome.startsWith(`..${sep}`) ||
        isAbsolute(fromHome)
      ) {
        throw new Error('MYDSH_VERIFY_PROJECT 必须位于隔离验收目录内')
      }
      return project
    })()
  : undefined
const VERIFY_ARTIFACT_DIRECTORY =
  VERIFY_HOME === undefined ? undefined : join(VERIFY_HOME, 'artifacts')
const PRELOAD_PATH = fileURLToPath(new URL('../preload/index.cjs', import.meta.url))
const RENDERER_PATH = fileURLToPath(new URL('../renderer/index.html', import.meta.url))
const STARTUP_PATH = fileURLToPath(new URL('../startup.html', import.meta.url))
const RENDERER_URL = pathToFileURL(RENDERER_PATH).href
const APP_ICON_PATH = fileURLToPath(new URL('../app-icon.png', import.meta.url))
const HOST_CHANNELS = Object.freeze({
  status: 'dsh-desktop:host:status',
  call: 'dsh-desktop:host:call',
  searchSessions: 'dsh-desktop:host:search-sessions',
  cancelSessionSearch: 'dsh-desktop:host:cancel-session-search',
  changed: 'dsh-desktop:host:status-changed',
  sessionFrame: 'dsh-desktop:host:session-frame',
  hostFrame: 'dsh-desktop:host:host-frame',
})
const COMMAND_CHANNELS = Object.freeze({
  list: 'dsh-desktop:commands:list',
  listSkills: 'dsh-desktop:commands:list-skills',
  execute: 'dsh-desktop:commands:execute',
})
const SESSION_EXPORT_CHANNELS = Object.freeze({
  save: 'dsh-desktop:session-exports:save',
})
const INTERACTION_CHANNELS = Object.freeze({
  respond: 'dsh-desktop:interactions:respond',
})
const PROJECT_CHANNELS = Object.freeze({
  list: 'dsh-desktop:project:list',
  call: 'dsh-desktop:project:call',
})
const LIFECYCLE_CHANNELS = Object.freeze({
  documentEdited: 'dsh-desktop:lifecycle:document-edited',
  closeRequested: 'dsh-desktop:lifecycle:close-requested',
  closeDecision: 'dsh-desktop:lifecycle:close-decision',
})

const sshVerificationAppName =
  VERIFY_SSH || VERIFY_DATABASE ? process.env.MYDSH_SSH_VERIFY_APP_NAME : undefined
if (
  (VERIFY_SSH || VERIFY_DATABASE) &&
  (!VERIFY_HOME_FROM_RUNNER ||
    !/^mydsh-credentials-verify-[0-9a-f]{32}$/u.test(sshVerificationAppName ?? ''))
) {
  throw new Error('SSH 凭据验收缺少隔离目录或独立测试应用身份')
}
app.setName(sshVerificationAppName ?? PRODUCT_NAME)
app.enableSandbox()

const APP_DATA_PATH = app.getPath('appData')

if (VERIFY_HOME !== undefined) {
  mkdirSync(VERIFY_HOME, { recursive: true, mode: 0o700 })
  if (VERIFY_ARTIFACT_DIRECTORY === undefined) throw new Error('无法初始化验收产物目录')
  mkdirSync(VERIFY_ARTIFACT_DIRECTORY, { recursive: true, mode: 0o700 })
  const electronUserData = join(VERIFY_HOME, 'electron-user-data')
  mkdirSync(electronUserData, { recursive: true, mode: 0o700 })
  app.setPath('userData', electronUserData)
  // Chromium 的存储目录可能已按系统已知目录初始化，不能只修改 userData。
  app.setPath('sessionData', electronUserData)
  if (!VERIFY_HOME_FROM_RUNNER) {
    process.once('exit', () => {
      rmSync(VERIFY_HOME, { recursive: true, force: true })
    })
  }
} else {
  app.setPath('userData', join(APP_DATA_PATH, PRODUCT_USER_DATA_DIRECTORY))
}

function verificationArtifactPath(fileName: string): string {
  if (VERIFY_ARTIFACT_DIRECTORY === undefined || !/^verify(?:-[a-z0-9]+)*\.png$/u.test(fileName)) {
    throw new Error('验收截图必须写入隔离产物目录')
  }
  return join(VERIFY_ARTIFACT_DIRECTORY, fileName)
}

interface PendingInteractionEntry {
  readonly sessionId: string
  readonly interaction: DesktopPendingInteraction
  readonly remote?: DshRemoteInteractionTarget
  responded: boolean
}

function interactionEntryKey(sessionId: string, key: string): string {
  return `${sessionId}\u0000${key}`
}

function hasOnlyFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).every(field => fields.includes(field))
}

function parsedQuestionAnswers(
  value: unknown,
  questions: readonly DesktopQuestionItem[],
): DesktopQuestionAnswerItem[] {
  if (!Array.isArray(value) || value.length !== questions.length) {
    throw new Error('问题回答必须完整覆盖当前问题')
  }
  return value.map((candidate, index) => {
    const answer = asRecord(candidate)
    const question = questions[index]
    if (
      answer === null ||
      question === undefined ||
      !hasOnlyFields(answer, ['id', 'selected', 'custom']) ||
      answer.id !== question.id ||
      !Array.isArray(answer.selected) ||
      answer.selected.length > 64 ||
      answer.selected.some(
        item => typeof item !== 'string' || item.length === 0 || item.length > 1_000,
      )
    ) {
      throw new Error('问题回答包含无效字段')
    }
    const selected = answer.selected as string[]
    if (new Set(selected).size !== selected.length) throw new Error('问题回答包含重复选项')
    const optionLabels = new Set((question.options ?? []).map(option => option.label))
    if (selected.some(label => !optionLabels.has(label))) throw new Error('问题回答包含未知选项')
    if (question.multiSelect !== true && selected.length > 1)
      throw new Error('单选问题只能选择一个选项')
    const custom =
      answer.custom === undefined
        ? undefined
        : typeof answer.custom === 'string' && Buffer.byteLength(answer.custom, 'utf8') <= 16 * 1024
          ? answer.custom.trim()
          : null
    if (custom === null) throw new Error('自定义回答无效或过长')
    if (
      question.multiSelect !== true &&
      custom !== undefined &&
      custom !== '' &&
      selected.length > 0
    ) {
      throw new Error('单选问题的自定义回答不能与选项同时提交')
    }
    return {
      id: question.id,
      selected,
      ...(custom === undefined || custom === '' ? {} : { custom }),
    }
  })
}

function interactionResponseResult(
  input: unknown,
  entry: PendingInteractionEntry,
): DshRemoteEventOutcome {
  const submission = asRecord(input)
  if (
    submission === null ||
    typeof submission.kind !== 'string' ||
    typeof submission.sessionId !== 'string' ||
    typeof submission.key !== 'string' ||
    submission.sessionId !== entry.sessionId ||
    submission.key !== entry.interaction.key
  ) {
    throw new Error('待响应交互请求无效或已经过期')
  }
  const interaction = entry.interaction
  if (interaction.kind === 'approval') {
    if (
      !hasOnlyFields(submission, ['kind', 'sessionId', 'key', 'outcome']) ||
      submission.kind !== 'approval' ||
      (submission.outcome !== 'allowed-once' && submission.outcome !== 'rejected')
    ) {
      throw new Error('审批决定无效')
    }
    return { kind: 'result', value: submission.outcome }
  }
  if (submission.kind === 'question-cancel') {
    if (!hasOnlyFields(submission, ['kind', 'sessionId', 'key']))
      throw new Error('问题取消请求无效')
    return {
      kind: 'rejected',
      error: {
        name: 'Error',
        code: 'cancelled',
        message: '用户关闭了当前问题',
      },
    }
  }
  if (
    submission.kind !== 'question' ||
    !hasOnlyFields(submission, ['kind', 'sessionId', 'key', 'answers'])
  ) {
    throw new Error('问题回答无效')
  }
  return {
    kind: 'result',
    value: { answers: parsedQuestionAnswers(submission.answers, interaction.questions) },
  }
}

let primaryWindow: BrowserWindow | undefined
let pendingSecondInstance = false
let verificationStage: VerifyStage = 'initializing'

function setVerificationStage(stage: VerifyStage): void {
  verificationStage = stage
  if (VERIFY_MODE) console.log(`desktop-shell-verify-stage: ${stage}`)
}

if (VERIFY_MODE) setVerificationStage('initializing')

function sameRendererPage(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.protocol === 'file:' && url.href === RENDERER_URL
  } catch {
    return false
  }
}

function publicHostState(state: DshHostState): Record<string, unknown> {
  return state.kind === 'ready'
    ? {
        kind: 'ready',
        ownership: state.ownership,
        identity: { reportedVersion: state.identity.reportedVersion },
      }
    : { kind: state.kind, message: state.message }
}

function externalWebUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol)) return undefined
    if (url.username !== '' || url.password !== '') return undefined
    return url.href
  } catch {
    return undefined
  }
}

function redactHostDiagnostic(message: string): string {
  return message
    .replace(/\b(?:sk|key)-[0-9A-Za-z_-]{12,}\b/gu, '[凭据已隐藏]')
    .replace(
      /\b(authorization|api[_-]?key|token|password)(\s*[:=]\s*)([^\s,;]+)/giu,
      '$1$2[已隐藏]',
    )
    .slice(0, 500)
}

function assertSettingsSender(event: IpcMainInvokeEvent, win: BrowserWindow): void {
  if (
    event.sender !== win.webContents ||
    event.senderFrame === null ||
    event.senderFrame !== win.webContents.mainFrame ||
    !sameRendererPage(event.senderFrame.url)
  ) {
    throw new Error('桌面请求不是来自受信任的本地 renderer')
  }
}

function removeHostIpcHandlers(): void {
  ipcMain.removeHandler(HOST_CHANNELS.status)
  ipcMain.removeHandler(HOST_CHANNELS.call)
  ipcMain.removeHandler(HOST_CHANNELS.searchSessions)
  ipcMain.removeHandler(HOST_CHANNELS.cancelSessionSearch)
  ipcMain.removeHandler(SESSION_EXPORT_CHANNELS.save)
  ipcMain.removeHandler(INTERACTION_CHANNELS.respond)
  ipcMain.removeHandler(COMMAND_CHANNELS.list)
  ipcMain.removeHandler(COMMAND_CHANNELS.listSkills)
  ipcMain.removeHandler(COMMAND_CHANNELS.execute)
}

function removeProjectIpcHandlers(): void {
  ipcMain.removeHandler(PROJECT_CHANNELS.list)
  ipcMain.removeHandler(PROJECT_CHANNELS.call)
  ipcMain.removeHandler(DESKTOP_FILE_REFERENCE_CHANNELS.resolveDroppedFiles)
}

function removeLifecycleIpcHandlers(): void {
  ipcMain.removeHandler(LIFECYCLE_CHANNELS.documentEdited)
  ipcMain.removeHandler(LIFECYCLE_CHANNELS.closeDecision)
}

async function main(): Promise<void> {
  const targetUrl = new URL('http://mydsh.internal/')
  setVerificationStage('host')
  const runtimeHome =
    VERIFY_HOME === undefined
      ? resolveMydshHome()
      : (process.env.MYDSH_HOME ?? join(VERIFY_HOME, 'mydsh'))
  const automationSystem = createAutomationSystem({
    settingsPath: join(runtimeHome, 'config', 'automation.json'),
    headless: VERIFY_MODE,
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
    ...(VERIFY_HOME === undefined ? {} : { mydshHome: runtimeHome }),
    ...(VERIFY_HOME === undefined
      ? {}
      : {
          onSpawned: (child: { pid?: number }) => {
            if (child.pid !== undefined)
              writeFileSync(join(VERIFY_HOME, 'runtime.pid'), `${String(child.pid)}\n`, {
                mode: 0o600,
              })
          },
        }),
  })
  const fetch = supervisor.fetch
  const runtimeStream = createRuntimeStreamCarrier(supervisor)

  await app.whenReady()
  app.setAboutPanelOptions({
    applicationName: PRODUCT_NAME,
    applicationVersion: app.getVersion(),
  })
  if (VERIFY_HOME === undefined) {
    try {
      const migratedFrom = migrateLegacyDesktopSettings(
        app.getPath('userData'),
        LEGACY_USER_DATA_DIRECTORIES.map(directory => join(APP_DATA_PATH, directory)),
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
  // 主进程仅保留已授权项目的只读目录缓存，文件与 Git 状态全部由 Runtime 管理。
  let projects: readonly DesktopProject[] = []
  let projectSessions: unknown = { items: [] }
  let projectRoots: string[] = []
  const runtimeCall = async (endpoint: string, args: Record<string, unknown>): Promise<unknown> => {
    const result = (await supervisor.call(endpoint, { args })) as {
      ok: boolean
      value?: unknown
      error?: { message: string }
    }
    if (!result.ok) throw new Error(result.error?.message ?? '运行核心操作失败')
    return result.value
  }
  const resolveProjectDirectory = (id: unknown): string => {
    const project = projects.find(item => item.id === id)
    if (!project) throw new Error('项目不存在或尚未取得访问授权')
    return project.cwd
  }
  const synchronizeProjects = async (): Promise<void> => {
    const baseline = asRecord(projectSessions)
    const items = Array.isArray(baseline?.items)
      ? baseline.items.map(asRecord).map(item => ({
          ...(typeof item?.cwd === 'string' ? { cwd: item.cwd } : {}),
          ...(typeof item?.updatedAt === 'number' ? { updatedAt: item.updatedAt } : {}),
        }))
      : []
    projects = (await runtimeCall('mydshWorkspace/sync', {
      sessions: { items },
      roots: projectRoots,
    })) as DesktopProject[]
  }
  let sessionSearchController: AbortController | undefined
  let sessionExportController: AbortController | undefined
  let sessionExportTask: Promise<unknown> | undefined
  let sessionExportPickerOpen = false
  let verifyBackgroundSource: string | undefined
  if (VERIFY_HOME !== undefined && !VERIFY_INTERACTIVE) {
    const transparentBitmap = Buffer.alloc(2 * 2 * 4)
    const transparentPng = nativeImage
      .createFromBitmap(transparentBitmap, {
        width: 2,
        height: 2,
        scaleFactor: 1,
      })
      .toPNG()
    settingsStore.setBackground('canvas', transparentPng)
    const sourceWidth = 320
    const sourceHeight = 240
    const sidebarBitmap = Buffer.alloc(sourceWidth * sourceHeight * 4)
    for (let y = 0; y < sourceHeight; y += 1) {
      for (let x = 0; x < sourceWidth; x += 1) {
        const offset = (y * sourceWidth + x) * 4
        const alternate = x < sourceWidth / 2 !== y < sourceHeight / 2
        sidebarBitmap[offset] = alternate ? 238 : 24
        sidebarBitmap[offset + 1] = alternate ? 72 : 212
        sidebarBitmap[offset + 2] = alternate ? 42 : 238
        sidebarBitmap[offset + 3] = 255
      }
    }
    verifyBackgroundSource = join(VERIFY_HOME, 'background-selection.png')
    writeFileSync(
      verifyBackgroundSource,
      nativeImage
        .createFromBitmap(sidebarBitmap, {
          width: sourceWidth,
          height: sourceHeight,
          scaleFactor: 1,
        })
        .toPNG(),
      { mode: 0o600 },
    )
  }
  const nativeTransparency = process.platform === 'darwin'
  const win = new BrowserWindow({
    icon: appIcon,
    width: 760,
    height: 480,
    minWidth: 760,
    minHeight: 480,
    // 离屏后台验收在 Windows 1024×720 工作区 + 1.5x 缩放下（逻辑工作区仅 683×480），
    // 禁用默认居中可避免构造期 AdjustToFit 将 760×480 启动小窗压窄至 683×480。
    ...(VERIFY_BACKGROUND ? { x: 0, y: 0, center: false } : {}),
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
      backgroundThrottling: !VERIFY_BACKGROUND,
      offscreen: VERIFY_BACKGROUND,
      preload: PRELOAD_PATH,
    },
  })
  const windowController = installWindowController({
    window: win,
    isTrustedPage: url => sameRendererPage(url) || url === pathToFileURL(STARTUP_PATH).href,
  })
  if (process.platform === 'darwin') win.setWindowButtonVisibility(false)
  if (VERIFY_MODE) {
    win.webContents.on('console-message', event => {
      console.error(
        `renderer-console[${event.level}]: ${event.message} (${event.sourceId}:${String(event.lineNumber)})`,
      )
    })
    win.webContents.on('render-process-gone', (_event, details) => {
      console.error(`renderer-process-gone: ${details.reason} (${String(details.exitCode)})`)
    })
  }
  primaryWindow = win
  if (pendingSecondInstance && !VERIFY_BACKGROUND) {
    pendingSecondInstance = false
    focusPrimaryWindow(primaryWindow)
  }

  let trafficLightsInstalled = false
  const settingsController = installDesktopSettingsController({
    window: win,
    store: settingsStore,
    assertSender: event => {
      assertSettingsSender(event, win)
    },
    isTrustedRendererPage: sameRendererPage,
    onPublished: () => {
      // 浮岛间隙已固定为官方 8px 默认值，红绿灯锚点不再随历史旧配置中的 islandGap 偏移。
      if (trafficLightsInstalled) syncTrafficLights(win)
    },
    ...(verifyBackgroundSource === undefined
      ? {}
      : { verificationBackgroundPath: verifyBackgroundSource }),
  })
  const attachmentController = installAttachmentController({
    window: win,
    assertSender: event => {
      assertSettingsSender(event, win)
    },
  })
  const projectTaskController = installProjectTaskController({
    window: win,
    storagePath: join(app.getPath('userData'), 'project-tasks.json'),
    assertSender: event => {
      assertSettingsSender(event, win)
    },
    resolveProjectDirectory: resolveProjectDirectory,
  })
  const terminalController = installTerminalController({
    window: win,
    assertSender: event => {
      assertSettingsSender(event, win)
    },
    runtime: supervisor,
    resolveTaskLaunch: (projectId, taskId) =>
      projectTaskController.resolveLaunch(projectId, taskId),
  })
  const projectEventsController = installProjectEventsController({
    window: win,
    runtime: supervisor,
  })
  const fileWorkspaceStateController = installFileWorkspaceStateController({
    storagePath: join(app.getPath('userData'), 'file-workspace-state.json'),
    assertSender: event => {
      assertSettingsSender(event, win)
    },
    resolveProjectDirectory: resolveProjectDirectory,
  })
  const requestDesktopSettings = settingsController.requestOpen
  const browserController = installBrowserController({
    window: win,
    assertSender: event => {
      assertSettingsSender(event, win)
    },
    resolveProjectDirectory,
  })
  const embeddedBrowserDriver = createEmbeddedBrowserDriver(browserController)
  const externalBrowserDriver = createExternalBrowserDriver({
    profileDirectory: join(runtimeHome, 'cache', 'external-browser-profile'),
    headless: VERIFY_MODE,
    scaler: scaleImageWithNativeImage,
  })
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
  const computerUseDriver = createComputerUseDriver({ headless: VERIFY_MODE })
  automationSystem.registerDrivers({
    callComputerUse: computerUseDriver.call,
    checkPermissions: computerUseDriver.checkPermissions,
    openPermissionSettings: computerUseDriver.openPermissionSettings,
    releaseInputs: computerUseDriver.releaseInputs,
    dispose: computerUseDriver.dispose,
  })
  const detachAutomationWindow = automationSystem.attachWindow({
    window: win,
    assertSender: event => {
      assertSettingsSender(event, win)
    },
  })
  let updateCheckController: AbortController | undefined
  const requestUpdateCheck = (): void => {
    if (
      updateCheckController !== undefined ||
      quitting ||
      win.isDestroyed() ||
      updateMenuItem === null
    )
      return
    const controller = new AbortController()
    updateCheckController = controller
    updateMenuItem.label = '正在检查更新…'
    updateMenuItem.enabled = false
    void (async () => {
      try {
        if (VERIFY_MODE) throw new Error('验收模式不会连接公开更新服务。')
        const update = await checkForProjectUpdate({
          currentVersion: app.getVersion(),
          signal: controller.signal,
        })
        if (controller.signal.aborted || win.isDestroyed()) return
        if (update === undefined) {
          await dialog.showMessageBox(win, {
            type: 'info',
            title: 'MyDSH 更新',
            message: '已经是最新版本',
            detail: `当前版本为 ${app.getVersion()}。`,
            buttons: ['好'],
          })
          return
        }
        const result = await dialog.showMessageBox(win, {
          type: 'info',
          title: 'MyDSH 更新',
          message: `发现新版本 ${update.version}`,
          detail: `当前版本为 ${app.getVersion()}。\n下载完成后，请退出 MyDSH，打开安装包并将 MyDSH 拖入 Applications，替换旧版本。${update.releaseNotes === '' ? '' : `\n\n${update.releaseNotes}`}`,
          buttons: ['下载新版本', '稍后'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        })
        if (result.response === 0 && !controller.signal.aborted && !win.isDestroyed()) {
          await shell.openExternal(update.downloadUrl)
        }
      } catch (error) {
        if (controller.signal.aborted || win.isDestroyed()) return
        await dialog.showMessageBox(win, {
          type: 'warning',
          title: 'MyDSH 更新',
          message: '暂时无法检查或下载更新',
          detail: error instanceof Error ? error.message : '请稍后重试。',
          buttons: ['好'],
        })
      } finally {
        updateCheckController = undefined
        updateMenuItem.label = '检查更新…'
        updateMenuItem.enabled = true
      }
    })().catch((error: unknown) => {
      console.warn('显示 MyDSH 更新提示失败：', error)
    })
  }
  const settingsAccelerator = process.platform === 'darwin' ? 'Command+,' : 'Ctrl+,'
  const menuTemplate: MenuItemConstructorOptions[] =
    process.platform === 'darwin'
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              {
                id: 'check-for-updates',
                label: '检查更新…',
                click: requestUpdateCheck,
              },
              {
                id: 'desktop-appearance',
                label: '设置…',
                accelerator: settingsAccelerator,
                enabled: false,
                click: requestDesktopSettings,
              },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
          // 标签快捷键统一路由到 renderer 的焦点窗格，窗口关闭继续走原生命周期。
          {
            label: '文件',
            submenu: [
              {
                label: '关闭当前标签',
                accelerator: 'CommandOrControl+W',
                click: () => {
                  win.webContents.send('mydsh:workspace:tab-action', { action: 'close' })
                },
              },
              {
                label: '平铺选择标签',
                accelerator: 'CommandOrControl+S',
                click: () => {
                  win.webContents.send('mydsh:workspace:tab-action', { action: 'overview' })
                },
              },
              { role: 'close', label: '关闭窗口', accelerator: 'CommandOrControl+Shift+W' },
            ],
          },
          { role: 'editMenu' },
          { role: 'viewMenu' },
          { role: 'windowMenu' },
        ]
      : [
          {
            label: '文件',
            submenu: [
              {
                label: '关闭当前标签',
                accelerator: 'CommandOrControl+W',
                click: () => {
                  win.webContents.send('mydsh:workspace:tab-action', { action: 'close' })
                },
              },
              {
                label: '平铺选择标签',
                accelerator: 'CommandOrControl+S',
                click: () => {
                  win.webContents.send('mydsh:workspace:tab-action', { action: 'overview' })
                },
              },
              {
                id: 'check-for-updates',
                label: '检查更新…',
                click: requestUpdateCheck,
              },
              { type: 'separator' },
              {
                id: 'desktop-appearance',
                label: '设置…',
                accelerator: settingsAccelerator,
                enabled: false,
                click: requestDesktopSettings,
              },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
          { role: 'editMenu' },
          { role: 'viewMenu' },
          { role: 'windowMenu' },
        ]
  const applicationMenu = Menu.buildFromTemplate(menuTemplate)
  const appearanceMenuItem = applicationMenu.getMenuItemById('desktop-appearance')
  const updateMenuItem = applicationMenu.getMenuItemById('check-for-updates')
  if (appearanceMenuItem === null) throw new Error('无法创建设置菜单')
  if (updateMenuItem === null) throw new Error('无法创建检查更新菜单')
  Menu.setApplicationMenu(applicationMenu)

  let quitting = false
  let exitCode = 0
  let revealed = false
  let workspaceOpened = false
  const startupDocument = pathToFileURL(STARTUP_PATH).href
  let currentHost: Extract<DshHostState, { kind: 'ready' }> | undefined
  let unsubscribeHostState: (() => void) | undefined
  let hostStateRender = Promise.resolve()
  let verifyReported = false
  let startupScreenVerified = false
  let verifySessionSeeded = false
  let verifyDeadlineTimer: NodeJS.Timeout | undefined
  let shutdownPreparation: Promise<void> | undefined
  let liveStreamsController: AbortController | undefined
  let liveStreamsHost: Extract<DshHostState, { kind: 'ready' }> | undefined
  let selectLiveSession: ((sessionId: string | undefined) => void) | undefined
  let followedSessionId: string | undefined
  let liveStreamsTask: Promise<void> | undefined
  let sessionStreamFrameObserved = false
  let hostEventStreamFrameObserved = false
  const commandRunIdsObserved = new Set<string>()
  const commandDoneIdsObserved = new Set<string>()
  const pendingInteractions = new Map<string, PendingInteractionEntry>()
  let rendererDocumentEdited = false
  let pluginBusyReasons: string[] = []
  const syncPluginBusy = async (): Promise<void> => {
    if (supervisor.getState().kind !== 'ready') return
    const reasons = [...(rendererDocumentEdited ? ['存在未保存的文件'] : []), ...pluginBusyReasons]
    try {
      await supervisor.call('mydshRuntime/uiBusy', { reason: reasons.join('；').slice(0, 4096) })
    } catch (error) {
      // 重启期间只保留桌面的最新事实；核心再次就绪时统一补发，不让编辑缓冲报错。
      if (supervisor.getState().kind === 'ready') throw error
    }
  }
  ipcMain.handle('mydsh:plugins:busy', async (event, reasons: unknown) => {
    assertSettingsSender(event, win)
    if (
      !Array.isArray(reasons) ||
      reasons.length > 32 ||
      reasons.some(
        reason => typeof reason !== 'string' || reason.length === 0 || reason.length > 512,
      )
    )
      throw new Error('插件占用原因无效')
    pluginBusyReasons = reasons as string[]
    await syncPluginBusy()
  })
  let closeRequestOutstanding = false
  let pendingQuit = false
  let allowWindowClose = false

  const requestRendererCloseDecision = (): void => {
    if (closeRequestOutstanding || win.isDestroyed() || win.webContents.isDestroyed()) return
    if (!sameRendererPage(win.webContents.getURL())) {
      rendererDocumentEdited = false
      return
    }
    closeRequestOutstanding = true
    win.webContents.send(LIFECYCLE_CHANNELS.closeRequested)
  }

  const observeInteractionFrame = (
    frame: DesktopSessionFrame,
    remote?: DshRemoteInteractionTarget,
  ): void => {
    if (frame.type === 'session/interaction-requested') {
      const key = interactionEntryKey(frame.sessionId, frame.interaction.key)
      const existing = pendingInteractions.get(key)
      const interactionRemote = remote ?? existing?.remote
      pendingInteractions.set(key, {
        sessionId: frame.sessionId,
        interaction: frame.interaction,
        ...(interactionRemote === undefined ? {} : { remote: interactionRemote }),
        responded: existing?.responded ?? false,
      })
      return
    }
    if (frame.type !== 'session/interaction-resolved') return
    if (frame.resolution.kind === 'question') {
      pendingInteractions.delete(interactionEntryKey(frame.sessionId, frame.resolution.key))
      return
    }
    for (const [key, entry] of pendingInteractions) {
      if (
        entry.sessionId === frame.sessionId &&
        entry.interaction.kind === 'approval' &&
        entry.interaction.approvalId === frame.resolution.approvalId
      )
        pendingInteractions.delete(key)
    }
  }

  const stopLiveStreams = (): Promise<void> => {
    const task = liveStreamsTask
    liveStreamsController?.abort()
    liveStreamsController = undefined
    liveStreamsHost = undefined
    selectLiveSession = undefined
    liveStreamsTask = undefined
    pendingInteractions.clear()
    return task ?? Promise.resolve()
  }

  const startLiveStreams = (state: Extract<DshHostState, { kind: 'ready' }>): void => {
    if (quitting || win.isDestroyed() || !sameRendererPage(win.webContents.getURL())) return
    if (liveStreamsHost === state) return
    void stopLiveStreams()
    const controller = new AbortController()
    const sessionId = followedSessionId
    liveStreamsController = controller
    liveStreamsHost = state
    let resetPublished = false
    let streamDisconnected = true
    const reportStreamState = (message?: string, exhausted = false): void => {
      if (
        controller.signal.aborted ||
        currentHost !== state ||
        win.isDestroyed() ||
        !sameRendererPage(win.webContents.getURL())
      )
        return
      if (message === undefined && !streamDisconnected) return
      streamDisconnected = message !== undefined
      win.webContents.send(
        HOST_CHANNELS.changed,
        message === undefined
          ? publicHostState(state)
          : { kind: exhausted ? 'unavailable' : 'connecting', message },
      )
    }
    const publishStreamReset = (): void => {
      if (resetPublished) return
      if (
        controller.signal.aborted ||
        currentHost !== state ||
        win.isDestroyed() ||
        !sameRendererPage(win.webContents.getURL())
      )
        return
      resetPublished = true
      pendingInteractions.clear()
      win.webContents.send(HOST_CHANNELS.sessionFrame, { type: 'session/stream-reset' })
    }
    const task = (async (): Promise<void> => {
      let retryDelayMs = 400
      let consecutiveErrors = 0
      /* oxlint-disable no-await-in-loop -- 两条长连接必须作为同一代重建，并按退避顺序重试。 */
      while (!controller.signal.aborted) {
        const generation = new AbortController()
        const startedAt = Date.now()
        let sessionReady = false
        let hostReady = false
        const abortGeneration = (): void => {
          generation.abort()
        }
        controller.signal.addEventListener('abort', abortGeneration, { once: true })
        try {
          sessionStreamFrameObserved = false
          const sessionTask = followDshSessionStream({
            openSocket: runtimeStream,
            targetUrl,
            ...(state.sessionCookie === undefined ? {} : { cookie: state.sessionCookie }),
            signal: generation.signal,
            ...(sessionId === undefined ? {} : { sessionId }),
            subscribeSelection: select => {
              selectLiveSession = select
              if (followedSessionId !== sessionId) select(followedSessionId)
              return () => {
                if (selectLiveSession === select) selectLiveSession = undefined
              }
            },
            onFrame: frame => {
              if (
                controller.signal.aborted ||
                generation.signal.aborted ||
                currentHost !== state ||
                win.isDestroyed() ||
                !sameRendererPage(win.webContents.getURL())
              )
                return
              resetPublished = false
              sessionReady = true
              if (hostReady) reportStreamState()
              sessionStreamFrameObserved = true
              if (
                frame.type === 'session/event' &&
                (frame.event.type === 'command/run' || frame.event.type === 'command/done') &&
                typeof frame.event.data === 'object' &&
                frame.event.data !== null &&
                'commandId' in frame.event.data &&
                typeof frame.event.data.commandId === 'string'
              ) {
                const target =
                  frame.event.type === 'command/run'
                    ? commandRunIdsObserved
                    : commandDoneIdsObserved
                target.add(frame.event.data.commandId)
              }
              observeInteractionFrame(frame)
              win.webContents.send(HOST_CHANNELS.sessionFrame, frame)
            },
          })
          const hostTask = followDshHostEventStream({
            openSocket: runtimeStream,
            targetUrl,
            ...(state.sessionCookie === undefined ? {} : { cookie: state.sessionCookie }),
            signal: generation.signal,
            onFrame: frame => {
              if (
                controller.signal.aborted ||
                generation.signal.aborted ||
                currentHost !== state ||
                win.isDestroyed() ||
                !sameRendererPage(win.webContents.getURL())
              )
                return
              resetPublished = false
              hostReady = true
              if (sessionReady) reportStreamState()
              hostEventStreamFrameObserved = true
              win.webContents.send(HOST_CHANNELS.hostFrame, frame)
            },
            onSessionFrame: (frame, remote) => {
              if (
                controller.signal.aborted ||
                generation.signal.aborted ||
                currentHost !== state ||
                win.isDestroyed() ||
                !sameRendererPage(win.webContents.getURL())
              )
                return
              resetPublished = false
              observeInteractionFrame(frame, remote)
              win.webContents.send(HOST_CHANNELS.sessionFrame, frame)
            },
          })
          const first = await Promise.race([
            sessionTask.then(
              result => ({ stream: 'session' as const, result }),
              error => ({ stream: 'session' as const, error }),
            ),
            hostTask.then(
              result => ({ stream: 'host' as const, result }),
              error => ({ stream: 'host' as const, error }),
            ),
          ])
          generation.abort()
          await Promise.allSettled([sessionTask, hostTask])
          if ('error' in first) throw first.error
          if (first.result.kind === 'aborted' || controller.signal.aborted) return
          if (first.result.kind === 'capability-unavailable') {
            publishStreamReset()
            reportStreamState('运行核心的事件接口不可用，请修复 MyDSH 安装后重试。', true)
            console.warn(
              `当前 MyDSH 运行核心 未提供公开 ${first.stream === 'session' ? 'Session' : 'Host'} 事件流，实时消息、运行状态与队列已降级。`,
            )
            return
          }
          publishStreamReset()
          reportStreamState('实时连接已断开，正在恢复…')
          await waitForAbortableDelay(controller.signal, retryDelayMs)
          retryDelayMs = Math.min(retryDelayMs * 2, 4_000)
        } catch (error) {
          generation.abort()
          if (controller.signal.aborted) return
          publishStreamReset()
          if (Date.now() - startedAt >= 10_000) consecutiveErrors = 0
          consecutiveErrors += 1
          console.warn('DSH 实时事件流失败：', error)
          if (consecutiveErrors >= 3) {
            reportStreamState('实时连接恢复失败，请切换会话重试；若仍失败，请重新打开应用。', true)
            return
          }
          reportStreamState('实时连接失败，正在重试…')
          await waitForAbortableDelay(controller.signal, retryDelayMs)
          retryDelayMs = Math.min(retryDelayMs * 2, 4_000)
        } finally {
          controller.signal.removeEventListener('abort', abortGeneration)
        }
      }
      /* oxlint-enable no-await-in-loop */
    })()
    liveStreamsTask = task
    void task.finally(() => {
      if (liveStreamsController === controller) {
        liveStreamsController = undefined
        liveStreamsTask = undefined
        liveStreamsHost = undefined
      }
    })
  }

  const disposePluginController = installPluginController(win, supervisor, assertSettingsSender)
  const disposeRemoteController = installRemoteController(win, supervisor, assertSettingsSender)
  win.once('closed', disposePluginController)
  win.once('closed', disposeRemoteController)

  ipcMain.handle(HOST_CHANNELS.status, event => {
    assertSettingsSender(event, win)
    const state = supervisor.getState()
    if (state.kind === 'ready') startLiveStreams(state)
    return publicHostState(state)
  })
  ipcMain.handle(HOST_CHANNELS.call, async (event, operation: unknown, payload: unknown) => {
    assertSettingsSender(event, win)
    const state = supervisor.getState()
    if (state.kind !== 'ready') throw new Error('MyDSH 运行核心 当前不可用')
    startLiveStreams(state)
    if (operation === 'mydshPlugins.chooseDirectory') {
      const request = asRecord(payload)
      if (!request || Object.keys(request).length !== 0)
        throw new Error('选择插件目录不接受额外参数')
      return choosePluginDirectory(win)
    }
    if (
      typeof operation === 'string' &&
      /^mydshImport\.(preview|commit|credentials)$/.test(operation)
    )
      return callImportController(
        supervisor,
        operation,
        asRecord(payload) ?? {},
        rendererDocumentEdited || pluginBusyReasons.length > 0,
      )
    if (
      typeof operation === 'string' &&
      /^mydshPlugins\.(list|install|update|enable|disable|uninstall|rollback)$/.test(operation)
    ) {
      const request = pluginOperationPayload(operation, payload)
      if (operation !== 'mydshPlugins.list') await syncPluginBusy()
      const result = (await supervisor.call(operation.replace('.', '/'), request)) as {
        ok: boolean
        value?: unknown
        error?: { message: string }
      }
      if (!result.ok) throw new Error(result.error?.message ?? '插件操作失败')
      return result.value
    }
    try {
      if (operation === 'loadSessionPage') {
        const request = asRecord(payload)
        const nextSessionId = request?.sessionId
        if (
          request?.beforeSeq === undefined &&
          typeof nextSessionId === 'string' &&
          nextSessionId.length > 0 &&
          nextSessionId.length <= 512 &&
          nextSessionId !== followedSessionId
        ) {
          followedSessionId = nextSessionId
          selectLiveSession?.(nextSessionId)
          startLiveStreams(state)
        }
      }
      const value =
        operation === 'listWorkspaces'
          ? await readDshWorkspaceBaseline({
              openSocket: runtimeStream,
              targetUrl,
              ...(state.sessionCookie === undefined ? {} : { cookie: state.sessionCookie }),
            })
          : await callDshHost(
              targetUrl,
              operation,
              payload,
              fetch,
              state.sessionCookie,
              liveStreamsController?.signal,
            )
      if (operation === 'listWorkspaces') {
        const baseline = asRecord(value)
        if (Array.isArray(baseline?.items))
          projectRoots = baseline.items
            .map(asRecord)
            .flatMap(item => (typeof item?.path === 'string' ? [item.path] : []))
        await synchronizeProjects()
      }
      if (operation === 'listSessions') {
        projectSessions = value
        await synchronizeProjects()
      }
      return value
    } catch (error) {
      console.warn('MyDSH 运行核心 RPC 调用失败：', error)
      throw new Error(error instanceof Error ? error.message : 'MyDSH 运行核心 RPC 调用失败', {
        cause: error,
      })
    }
  })
  ipcMain.handle(INTERACTION_CHANNELS.respond, async (event, submission: unknown) => {
    assertSettingsSender(event, win)
    const state = supervisor.getState()
    if (state.kind !== 'ready') throw new Error('MyDSH 运行核心 当前不可用')
    const value = asRecord(submission)
    const sessionId = value?.sessionId
    const key = value?.key
    if (
      typeof sessionId !== 'string' ||
      sessionId.length === 0 ||
      sessionId.length > 512 ||
      typeof key !== 'string' ||
      key.length === 0 ||
      key.length > 1_024
    ) {
      throw new Error('待响应交互请求无效')
    }
    const entryKey = interactionEntryKey(sessionId, key)
    const entry = pendingInteractions.get(entryKey)
    if (entry === undefined) return { accepted: false, reason: 'not-pending' }
    if (entry.responded) return { accepted: false, reason: 'in-flight' }
    if (entry.remote === undefined) throw new Error('当前交互不属于可应答的 Remote 请求')
    const result = interactionResponseResult(submission, entry)
    entry.responded = true
    try {
      const receipt = await respondDshInteraction(
        targetUrl,
        entry.remote.clientId,
        entry.remote.eventId,
        result,
        fetch,
        state.sessionCookie,
      )
      if (!receipt.accepted) {
        if (receipt.reason === 'not-pending') pendingInteractions.delete(entryKey)
        else entry.responded = false
      } else {
        const resolution: DesktopSessionFrame =
          entry.interaction.kind === 'approval'
            ? {
                type: 'session/interaction-resolved',
                sessionId: entry.sessionId,
                resolution: {
                  kind: 'approval',
                  approvalId: entry.interaction.approvalId,
                  outcome:
                    result.kind === 'result' && result.value === 'allowed-once'
                      ? 'allowed-once'
                      : 'rejected',
                },
              }
            : {
                type: 'session/interaction-resolved',
                sessionId: entry.sessionId,
                resolution: {
                  kind: 'question',
                  key: entry.interaction.key,
                  outcome: result.kind === 'result' ? 'answered' : 'cancelled',
                },
              }
        observeInteractionFrame(resolution)
        win.webContents.send(HOST_CHANNELS.sessionFrame, resolution)
      }
      return receipt
    } catch (error) {
      entry.responded = false
      console.warn('DSH 待响应交互提交失败：', error)
      throw new Error(error instanceof Error ? error.message : 'DSH 待响应交互提交失败', {
        cause: error,
      })
    }
  })
  ipcMain.handle(HOST_CHANNELS.searchSessions, async (event, query: unknown) => {
    assertSettingsSender(event, win)
    const state = supervisor.getState()
    if (state.kind !== 'ready') throw new Error('MyDSH 运行核心 当前不可用')
    sessionSearchController?.abort()
    const controller = new AbortController()
    sessionSearchController = controller
    try {
      return await callDshHost(
        targetUrl,
        'searchSessions',
        { query },
        fetch,
        state.sessionCookie,
        controller.signal,
      )
    } catch (error) {
      if (controller.signal.aborted) throw new Error('会话搜索已取消', { cause: error })
      console.warn('MyDSH 会话搜索失败：', error)
      throw new Error(error instanceof Error ? error.message : 'MyDSH 会话搜索失败', {
        cause: error,
      })
    } finally {
      if (sessionSearchController === controller) sessionSearchController = undefined
    }
  })
  ipcMain.handle(HOST_CHANNELS.cancelSessionSearch, event => {
    assertSettingsSender(event, win)
    sessionSearchController?.abort()
    sessionSearchController = undefined
  })
  ipcMain.handle(SESSION_EXPORT_CHANNELS.save, async (event, sessionId: unknown) => {
    assertSettingsSender(event, win)
    if (quitting) throw new Error('MyDSH 正在退出，不能导出会话日志')
    const state = supervisor.getState()
    if (state.kind !== 'ready') throw new Error('MyDSH 运行核心 当前不可用')
    // 仅使用已安装核心所属的数据根，不能接受 renderer 指定来源路径。
    const installation = supervisor.installed
    if (installation === undefined) throw new Error('MyDSH 运行核心 当前不可用')
    if (sessionExportController !== undefined || sessionExportPickerOpen)
      throw new Error('已有会话日志正在导出或等待选择保存位置')
    const controller = new AbortController()
    sessionExportController = controller
    try {
      const task = saveSessionLog({
        dataRoot: join(installation.mydshHome, 'data'),
        sessionId,
        signal: controller.signal,
        chooseDestination: async suggestedName => {
          assertSettingsSender(event, win)
          if (win.isDestroyed()) throw new Error('桌面窗口已关闭，无法导出会话日志')
          // 等待已取消的选路径对话框真正关闭，避免同一窗口叠加原生对话框。
          sessionExportPickerOpen = true
          try {
            const result = await dialog.showSaveDialog(win, {
              title: '导出会话日志',
              buttonLabel: '导出',
              defaultPath: join(resolveExportDirectory(), suggestedName),
              filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
            })
            if (controller.signal.aborted) return null
            assertSettingsSender(event, win)
            return result.canceled || result.filePath === undefined ? null : result.filePath
          } finally {
            sessionExportPickerOpen = false
          }
        },
      })
      sessionExportTask = task
      return await task
    } catch (error) {
      console.warn('MyDSH 会话日志导出失败：', error)
      throw new Error(error instanceof Error ? error.message : 'MyDSH 会话日志导出失败', {
        cause: error,
      })
    } finally {
      if (sessionExportController === controller) {
        sessionExportController = undefined
        sessionExportTask = undefined
      }
    }
  })
  const callCommandCapability = async (
    event: IpcMainInvokeEvent,
    operation: 'listSessionCommands' | 'listSessionSkills' | 'executeSessionCommand',
    payload: unknown,
  ): Promise<unknown> => {
    assertSettingsSender(event, win)
    const state = supervisor.getState()
    if (state.kind !== 'ready') throw new Error('MyDSH 运行核心 当前不可用')
    try {
      return await callDshHost(targetUrl, operation, payload, fetch, state.sessionCookie)
    } catch (error) {
      console.warn('DSH Command 能力调用失败：', error)
      throw new Error(error instanceof Error ? error.message : 'DSH Command 能力调用失败', {
        cause: error,
      })
    }
  }
  ipcMain.handle(COMMAND_CHANNELS.list, (event, sessionId: unknown) => {
    return callCommandCapability(event, 'listSessionCommands', { sessionId })
  })
  ipcMain.handle(COMMAND_CHANNELS.listSkills, (event, sessionId: unknown) => {
    return callCommandCapability(event, 'listSessionSkills', { sessionId })
  })
  ipcMain.handle(COMMAND_CHANNELS.execute, (event, request: unknown) => {
    return callCommandCapability(event, 'executeSessionCommand', request)
  })
  ipcMain.handle(PROJECT_CHANNELS.list, event => {
    assertSettingsSender(event, win)
    return projects
  })
  const callGitAi = createGitAiController({
    window: win,
    call: (projectId, operation, payload) =>
      runtimeCall('mydshWorkspace/call', { projectId, operation, payload }),
  })
  ipcMain.handle(PROJECT_CHANNELS.call, async (event, operation: unknown, payload: unknown) => {
    assertSettingsSender(event, win)
    try {
      const request = asRecord(payload)
      if (!request || typeof request.projectId !== 'string') throw new Error('项目操作参数无效')
      if (operation !== 'gitAiRelease' && operation !== 'gitAiCancel')
        resolveProjectDirectory(request.projectId)
      if (
        typeof operation !== 'string' ||
        !(PROJECT_OPERATIONS as readonly string[]).includes(operation)
      )
        throw new Error('不支持的项目操作')
      if (operation === 'revealInFinder') {
        shell.showItemInFolder(resolveProjectDirectory(request.projectId))
        return { revealed: true }
      }
      const { projectId, ...argumentsOnly } = request
      if (isGitAiOperation(operation)) return await callGitAi(projectId, operation, argumentsOnly)
      return await runtimeCall('mydshWorkspace/call', {
        projectId,
        operation,
        payload: argumentsOnly,
      })
    } catch (error) {
      if (!isGitAiOperation(operation)) console.warn('项目桌面操作失败：', error)
      throw new Error(error instanceof Error ? error.message : '项目桌面操作失败', { cause: error })
    }
  })
  ipcMain.handle(
    DESKTOP_FILE_REFERENCE_CHANNELS.resolveDroppedFiles,
    async (event, request: unknown) => {
      assertSettingsSender(event, win)
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        throw new Error('拖入文件引用请求无效')
      }
      const value = request as Record<string, unknown>
      return runtimeCall('mydshWorkspace/resolveDroppedFiles', {
        projectId: value.projectId,
        paths: value.absolutePaths,
      })
    },
  )

  const reveal = (): void => {
    if (revealed || win.isDestroyed()) return
    revealed = true
    if (!VERIFY_BACKGROUND) win.show()
  }

  const finishVerify = (report: VerifyReport, code: number): void => {
    if (verifyReported) return
    verifyReported = true
    if (verifyDeadlineTimer !== undefined) clearTimeout(verifyDeadlineTimer)
    sessionExportController?.abort()
    console.log(`desktop-shell-verify: ${JSON.stringify(report)}`)
    exitCode = code
    // 成功时走用户关闭窗口的路径，覆盖窗口销毁后的资源清理。
    if (code === 0) win.close()
    else void shutdown(code)
  }
  if (VERIFY_MODE && VERIFY_DEADLINE !== undefined) {
    verifyDeadlineTimer = setTimeout(
      () => {
        finishVerify(
          createFailedVerifyReport(
            verificationStage,
            new Error(`验收总时限超过 ${String(VERIFY_TOTAL_TIMEOUT_MS)}ms`),
            currentHost !== undefined,
          ),
          1,
        )
      },
      Math.max(1, VERIFY_DEADLINE - Date.now()),
    )
  }

  const loadStartup = async (phase: string): Promise<void> => {
    if (quitting || win.isDestroyed()) return
    appearanceMenuItem.enabled = false
    if (win.webContents.getURL() !== startupDocument) {
      await win.loadFile(STARTUP_PATH)
      if (quitting || win.isDestroyed()) return
      await win.webContents
        .executeJavaScript(`document.documentElement.dataset.colorScheme = ${JSON.stringify(settingsStore.read().colorScheme)};
        Promise.all([...document.images].map(image => image.decode()))`)
    }
    if (quitting || win.isDestroyed()) return
    await win.webContents.executeJavaScript(
      createStartupScreenUpdateScript(createStartupScreenSnapshot(phase)),
    )
  }

  const createVerificationBridge = (): HostVerificationBridge => ({
    win,
    supervisor,
    fetch,
    targetUrl,
    settingsStore,
    settingsController,
    windowController,
    applicationMenu,
    appearanceMenuItem,
    updateMenuItem,
    startupDocument,
    nativeTransparency,
    verifyBackground: VERIFY_BACKGROUND,
    verifyHome: VERIFY_HOME ?? '',
    verifyProject: VERIFY_PROJECT ?? '',
    hostChannels: HOST_CHANNELS,
    commandRunIdsObserved,
    commandDoneIdsObserved,
    getStage: () => verificationStage,
    setStage: setVerificationStage,
    isStartupScreenVerified: () => startupScreenVerified,
    setStartupScreenVerified: verified => {
      startupScreenVerified = verified
    },
    isVerifyReported: () => verifyReported,
    getCurrentHost: () => currentHost,
    getHostStateRender: () => hostStateRender,
    getLiveStreamsController: () => liveStreamsController,
    getProjects: () => projects,
    getSessionExportController: () => sessionExportController,
    isSessionStreamFrameObserved: () => sessionStreamFrameObserved,
    isHostEventStreamFrameObserved: () => hostEventStreamFrameObserved,
    loadStartup,
    sameRendererPage,
    runtimeCall,
    observeInteractionFrame,
    artifactPath: verificationArtifactPath,
    finishVerify,
  })

  const verify = async (): Promise<void> => {
    if (!VERIFY_MODE || VERIFY_INTERACTIVE || currentHost === undefined || verifyReported) return
    const { runDesktopVerification } = await import('./verification/entry.ts')
    await runDesktopVerification(createVerificationBridge())
  }

  const applyHostState = async (state: DshHostState): Promise<void> => {
    if (quitting || win.isDestroyed()) return
    if (sameRendererPage(win.webContents.getURL())) {
      win.webContents.send(HOST_CHANNELS.changed, publicHostState(state))
    }
    if (state.kind === 'ready') {
      currentHost = state
      if (!workspaceOpened) await loadStartup('workspace')
      await syncPluginBusy()
      if (VERIFY_MODE && !VERIFY_INTERACTIVE && !verifySessionSeeded) {
        try {
          const created = parseDesktopWorkspaceCreateResult(
            await callDshHost(
              targetUrl,
              'createWorkspace',
              { path: VERIFY_PROJECT ?? process.cwd() },
              fetch,
              state.sessionCookie,
            ),
          )
          await callDshHost(
            targetUrl,
            'createSessionForWorkspace',
            { workspaceId: created.workspace.workspaceId },
            fetch,
            state.sessionCookie,
          )
        } catch (error) {
          // 首选装配失败不能静默：退回普通会话会让项目相关阶段失去工作区，必须留下原因。
          console.warn('桌面验收创建隔离工作区失败，改用普通会话：', error)
          await callDshHost(
            targetUrl,
            'createSession',
            { cwd: VERIFY_PROJECT ?? process.cwd() },
            fetch,
            state.sessionCookie,
          )
        }
        verifySessionSeeded = true
      }
      if (!sameRendererPage(win.webContents.getURL())) {
        if (quitting || win.isDestroyed() || supervisor.getState().kind !== 'ready') return
        await loadStartup('ready')
        // 前台等待两帧绘制；窗口在后台时回退到短暂计时，避免动画帧暂停而卡住启动。
        await Promise.race([
          win.webContents.executeJavaScript(
            'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
          ),
          new Promise(resolve => {
            setTimeout(resolve, 250)
          }),
        ])
        if (quitting || win.isDestroyed()) return
        if (!workspaceOpened) {
          // 工作台按正常窗口尺寸初始化，避免把启动小窗记为窄屏导航偏好。
          win.setResizable(true)
          // 去掉 Windows 厚边框后，启用缩放不会自动恢复启动小窗禁用的最大化能力。
          if (process.platform === 'win32') win.setMaximizable(true)
          win.setMinimumSize(900, 600)
          win.setSize(1280, 800)
          // 后台离屏验收需维持 1280×800 标准画布；Windows 上 center() 会把窗口压到当前显示器工作区
          // （如 1024×768 CI 环境会被缩小到 1024×720，从而触发窄屏隐藏右侧浮岛）。
          if (!VERIFY_BACKGROUND) win.center()
        }
        await win.loadFile(RENDERER_PATH)
      } else {
        startLiveStreams(state)
      }
      return
    }

    void stopLiveStreams()
    currentHost = undefined
    // Host 恢复不能销毁 renderer 中的文件修改、会话草稿和终端。
    if (workspaceOpened && sameRendererPage(win.webContents.getURL())) return
    projects = []
    projectSessions = { items: [] }
    projectRoots = []
    if (state.kind === 'unavailable') {
      console.error('MyDSH 启动失败：', redactHostDiagnostic(state.message))
      if (VERIFY_MODE)
        for (const log of state.diagnostics?.logs ?? [])
          console.error('核心启动诊断：', redactHostDiagnostic(log.message))
      if (VERIFY_MODE)
        finishVerify(createFailedVerifyReport(verificationStage, state.message, false), 1)
      else await shutdown(1)
      return
    }
    await loadStartup(state.phase)
    reveal()
  }

  let pendingHostState: DshHostState | undefined
  const queueHostState = (state: DshHostState): void => {
    // 安装数万份文件时只呈现最新状态，不能让就绪通知等待每份文件的界面刷新。
    pendingHostState = state
    hostStateRender = hostStateRender
      .then(async () => {
        const latest = pendingHostState
        pendingHostState = undefined
        if (latest !== undefined) await applyHostState(latest)
      })
      .catch((error: unknown) => {
        console.error('更新运行核心窗口状态失败：', error)
        if (VERIFY_MODE) finishVerify(createFailedVerifyReport(verificationStage, error, false), 1)
        else if (!workspaceOpened) void shutdown(1)
      })
  }

  const prepareShutdown = (): Promise<void> => {
    if (shutdownPreparation !== undefined) return shutdownPreparation
    quitting = true
    updateCheckController?.abort()
    unsubscribeHostState?.()
    unsubscribeHostState = undefined
    if (verifyDeadlineTimer !== undefined) clearTimeout(verifyDeadlineTimer)
    sessionExportController?.abort()
    settingsController.dispose()
    windowController.dispose()
    attachmentController.dispose()
    terminalController.dispose()
    projectEventsController.dispose()
    projectTaskController.dispose()
    fileWorkspaceStateController.dispose()
    detachAutomationWindow()
    const automationDisposed = automationSystem.dispose()
    browserController.dispose()
    removeHostIpcHandlers()
    removeProjectIpcHandlers()
    ipcMain.removeHandler('mydsh:plugins:busy')
    removeLifecycleIpcHandlers()
    const streamStopped = stopLiveStreams()
    shutdownPreparation = Promise.all([
      // 等待导出关闭句柄并删除半成品，不能在异步清理前直接退出进程。
      sessionExportTask?.catch(() => {}),
      automationDisposed.catch(() => {}),
      streamStopped.then(() => {
        if (VERIFY_MODE) console.log('desktop-shell-verify-cleanup: streams')
      }),
      shutdownImportController(supervisor)
        .then(() => supervisor.shutdown())
        .catch((error: unknown) => {
          console.warn('停止 MyDSH 运行核心失败，将继续退出：', error)
        })
        .then(() => {
          if (VERIFY_MODE) console.log('desktop-shell-verify-cleanup: runtime')
        }),
    ]).then(() => undefined)
    return shutdownPreparation
  }

  const shutdown = async (code: number): Promise<void> => {
    exitCode = Math.max(exitCode, code)
    await prepareShutdown()
    app.exit(exitCode)
  }
  if (VERIFY_MODE) {
    // 自动验收将未捕获异常写入诊断流，避免 Electron 的系统弹窗阻塞退出。
    process.on('uncaughtException', error => {
      console.error('desktop-shell-verify-uncaught:', error)
      void shutdown(1)
    })
  }

  ipcMain.handle(LIFECYCLE_CHANNELS.documentEdited, async (event, edited: unknown) => {
    assertSettingsSender(event, win)
    if (typeof edited !== 'boolean') throw new Error('文档编辑状态无效')
    rendererDocumentEdited = edited
    await syncPluginBusy()
  })
  ipcMain.handle(LIFECYCLE_CHANNELS.closeDecision, (event, decision: unknown) => {
    assertSettingsSender(event, win)
    if (decision !== 'proceed' && decision !== 'cancel') throw new Error('关闭窗口决定无效')
    if (!closeRequestOutstanding) return
    closeRequestOutstanding = false
    if (decision === 'cancel') {
      pendingQuit = false
      return
    }
    rendererDocumentEdited = false
    if (pendingQuit) {
      pendingQuit = false
      void shutdown(exitCode)
      return
    }
    allowWindowClose = true
    win.close()
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    const external = externalWebUrl(url)
    if (external !== undefined) void shell.openExternal(external)
    return { action: 'deny' }
  })
  // 导航尝试可能被取消；只有主文档真正切换后才释放旧页面的订阅。
  win.webContents.on('did-navigate', () => {
    void stopLiveStreams()
  })
  win.webContents.on('will-navigate', (event, url) => {
    // 启动页与工作台仅由主进程 loadFile 切换；用户回退不能重新进入启动页。
    // Electron 的主进程加载不触发此事件，外部链接仍交给系统浏览器。
    event.preventDefault()
    const external = externalWebUrl(url)
    if (external !== undefined) void shell.openExternal(external)
  })
  win.webContents.on('will-attach-webview', event => {
    event.preventDefault()
  })
  const disposeHostPermissions = installHostPermissionHandlers(
    win.webContents.session,
    win.webContents,
    targetUrl,
  )
  win.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      if (errorCode === -3 || !isMainFrame || quitting) return
      console.error('MyDSH 页面加载失败：', errorDescription)
      void shutdown(1)
    },
  )
  win.webContents.on('render-process-gone', () => {
    if (!workspaceOpened && !quitting) void shutdown(1)
  })
  win.webContents.on('did-finish-load', () => {
    const loadedUrl = win.webContents.getURL()
    if (!sameRendererPage(loadedUrl)) {
      appearanceMenuItem.enabled = false
      return
    }
    // 启动页不是可返回的产品页面，避免鼠标侧键和系统浏览快捷键退回一次性启动流程。
    win.webContents.navigationHistory.clear()
    if (process.platform === 'darwin') {
      win.setWindowButtonVisibility(true)
      // 启动小窗恢复缩放时 AppKit 可能替换缩放按钮，需在工作台装载后定位实际按钮。
      if (!workspaceOpened) {
        installTrafficLights(win)
        trafficLightsInstalled = true
        win.on('leave-full-screen', () => {
          if (trafficLightsInstalled) syncTrafficLights(win)
        })
      }
    }
    workspaceOpened = true
    appearanceMenuItem.enabled = true
    reveal()
    if (VERIFY_INTERACTIVE) console.log('desktop-shell-interactive-ready')
    else if (VERIFY_MODE)
      setTimeout(() => {
        void verify()
      }, 1_500)
  })

  win.on('close', event => {
    if (quitting || allowWindowClose || win.webContents.isDestroyed()) return
    if (!rendererDocumentEdited) return
    event.preventDefault()
    requestRendererCloseDecision()
  })
  win.on('closed', () => {
    sessionSearchController?.abort()
    disposeHostPermissions()
    primaryWindow = undefined
    void shutdown(exitCode)
  })
  app.on('window-all-closed', () => {
    void shutdown(exitCode)
  })
  app.on('before-quit', event => {
    if (quitting) {
      event.preventDefault()
      return
    }
    if (rendererDocumentEdited) {
      event.preventDefault()
      pendingQuit = true
      requestRendererCloseDecision()
      return
    }
    event.preventDefault()
    void shutdown(exitCode)
  })
  process.once('SIGINT', () => {
    void shutdown(130)
  })
  process.once('SIGTERM', () => {
    void shutdown(143)
  })

  await loadStartup('initializing')
  reveal()
  if (VERIFY_MODE && !VERIFY_INTERACTIVE) {
    const { shouldVerifyStartupScreen } = await import('./verification/entry.ts')
    if (shouldVerifyStartupScreen(process.argv)) {
      const { verifyStartupScreen } = await import('./verification/startup-screen-verifier.ts')
      const ok = await verifyStartupScreen(createVerificationBridge())
      if (!ok) return
    } else {
      startupScreenVerified = true
      setVerificationStage('host')
    }
  }
  unsubscribeHostState = supervisor.subscribe(queueHostState)
  void supervisor.ensureReady().catch((error: unknown) => {
    if (quitting) return
    console.error('MyDSH 启动失败：', error)
    void shutdown(1)
  })
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (VERIFY_BACKGROUND) return
    if (!focusPrimaryWindow(primaryWindow)) pendingSecondInstance = true
  })
  void main().catch((error: unknown) => {
    console.error(`${PRODUCT_NAME} 启动失败：`, error)
    app.exit(1)
  })
}
