import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { connectionSystem } from './connections/connection-system.ts'
import { createGitAiController } from './runtime/git-ai-controller.ts'
import { verifyGitAiPreparation } from './verification/git-ai-verifier.ts'
import {
  verifyBulkUnstage,
  verifyGitRefresh,
  verifySourceControlSections,
} from './verification/source-control-sections-verifier.ts'
import { isGitAiOperation } from '../shared/git-ai-validation.ts'
import { PROJECT_OPERATIONS } from '../runtime/workspace/project-service.ts'
import { verifyWorkspaceTabs } from './verification/workspace-tabs-verifier.ts'
import { verifyWorkbenchAdjustments } from './verification/workbench-adjustments-verifier.ts'
import { verifySshWorkspace } from './verification/ssh-verifier.ts'
import { verifyDatabaseWorkspace } from './verification/database-verifier.ts'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  protocol,
  screen,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from 'electron'
import { focusPrimaryWindow } from './lifecycle/app-lifecycle.ts'
import {
  INITIAL_TRAFFIC_LIGHT_POSITION,
  TRAFFIC_LIGHT_CENTER_Y,
  TRAFFIC_LIGHT_GAP,
  TRAFFIC_LIGHT_LEFT,
  installTrafficLights,
  readTrafficLightLayout,
  resolveTrafficLightMetrics,
  syncTrafficLights,
} from './window-controls.ts'
import { installWindowController } from './window-controller.ts'
import { verifyWindowControls } from './verification/window-verifier.ts'
import { verifyPermissionDialog, verifyPlanReview } from './verification/plan-review-verifier.ts'
import { verifyWorkspaceReview } from './verification/workspace-review-verifier.ts'
import { verifySessionLogExport } from './verification/session-export-verifier.ts'
import { verifyPluginManager } from './verification/plugin-manager-verifier.ts'
import {
  verifyMessageActionReveal,
  verifyTabEdgeMotion,
} from './verification/interaction-polish-verifier.ts'
import { verifyWorkspaceNavigation } from './verification/navigation-verifier.ts'
import { verifyComposerLayout } from './verification/composer-layout-verifier.ts'
import {
  readVerificationProjection,
  seedComposerReadings,
} from './verification/session-projection-fixture.ts'
import { verifyTabOverflow } from './verification/tab-overflow-verifier.ts'
import { verifyDiffTools } from './verification/view-tools-verifier.ts'
import { verifyCompactionReadings } from './verification/compaction-verifier.ts'
import {
  captureVerifiedPage,
  emulateVerificationMedia,
  clickTrustedElement,
  createFailedVerifyReport,
  dragTrustedElementHorizontally,
  type VerifyReport,
  type VerifyStage,
} from './verification/desktop-verifier.ts'
import { DesktopSettingsStore, migrateLegacyDesktopSettings } from './settings/desktop-settings.ts'
import { installDesktopSettingsController } from './settings/controller.ts'
import { installAttachmentController } from './attachments/attachment-controller.ts'
import { installTerminalController } from './terminal/terminal-controller.ts'
import { installProjectEventsController } from './runtime/project-events-controller.ts'
import { installProjectTaskController } from './tasks/project-task-controller.ts'
import { installFileWorkspaceStateController } from './files/file-workspace-state-controller.ts'
import { installBrowserController } from './browser/browser-controller.ts'
import { BROWSER_PREVIEW_SCHEME } from './browser/browser-preview.ts'
import { createAutomationSystem } from './automation/automation-system.ts'
import { createComputerUseDriver } from './automation/computer-use-driver.ts'
import { createEmbeddedBrowserDriver } from './automation/embedded-browser-driver.ts'
import { createExternalBrowserDriver } from './automation/external-browser-driver.ts'
import { scaleImageWithNativeImage } from './automation/image-scaler.ts'
import { resolveMydshHome } from './runtime/runtime-install.ts'
import { saveSessionLog } from './session-exports/session-log-export.ts'
import { createRuntimeStreamCarrier } from './runtime/runtime-stream.ts'
import { pickWorkspaceDirectory } from './runtime/directory-picker.ts'
import { callImportController, shutdownImportController } from './runtime/import-controller.ts'
import { installRemoteController } from './runtime/remote-controller.ts'
import {
  choosePluginDirectory,
  installPluginController,
  PLUGIN_CUSTOM_SCHEME,
  pluginOperationPayload,
} from './runtime/plugin-controller.ts'
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
import type { DesktopProject } from '../runtime/workspace/index.ts'
import { installHostPermissionHandlers } from './security/host-permissions.ts'
import {
  MydshRuntimeSupervisor,
  type RuntimeState as DshHostState,
} from './runtime/runtime-supervisor.ts'
import {
  createStartupScreenSnapshot,
  createStartupScreenUpdateScript,
} from './startup/startup-screen.ts'
import {
  LEGACY_USER_DATA_DIRECTORIES,
  PRODUCT_NAME,
  PRODUCT_USER_DATA_DIRECTORY,
} from '../shared/product.ts'
import { parseDesktopWorkspaceCreateResult } from '../shared/workspace-capabilities.ts'
import { DESKTOP_FILE_REFERENCE_CHANNELS } from '../shared/file-references.ts'
import type {
  DesktopPendingInteraction,
  DesktopQuestionAnswerItem,
  DesktopQuestionItem,
  DesktopSessionFrame,
} from '../shared/session-live.ts'
import { checkForProjectUpdate } from './updates/github-updates.ts'
import { asRecord } from '../shared/validation.ts'
import { verifyEmptyConversationLayout } from './verification/empty-conversation-verifier.ts'
import { verifyConversationPolish } from './verification/conversation-polish-verifier.ts'

// Electron 规定特权协议必须在 app ready 之前通过单次调用统一注册。
protocol.registerSchemesAsPrivileged([PLUGIN_CUSTOM_SCHEME, BROWSER_PREVIEW_SCHEME])

const VERIFY_FLAG = '--verify'

function nearPanelValue(value: number, expected: number): boolean {
  return Math.abs(value - expected) <= 1
}

/**
 * 判断红绿灯是否处于标准对齐布局：三个按钮在同一行、彼此间隔 8px，
 * 且位于当前浮岛间隙对应的左栏安全区内。
 */
function isCompactTrafficLightRow(buttons: readonly Electron.Rectangle[], islandGap = 8): boolean {
  if (buttons.length !== 3) return false
  const { left } = resolveTrafficLightMetrics(islandGap)
  return buttons.every((button, index) => {
    const previous = buttons[index - 1]
    const isSized = button.width > 0 && button.height > 0
    const isInsideSafeArea = button.x >= left - 1 && button.x + button.width <= left + 60
    const isEvenlySpaced =
      previous === undefined || button.x - previous.x - previous.width === TRAFFIC_LIGHT_GAP
    return isSized && isInsideSafeArea && isEvenlySpaced && button.y === buttons[0]!.y
  })
}

/** 校验 macOS 红绿灯已随指定浮岛间隙同步到 32px 顶行中轴线。 */
function isTrafficLightAlignedForGap(win: BrowserWindow, islandGap: number): boolean {
  if (process.platform !== 'darwin') return true
  const buttons = readTrafficLightLayout(win)
  const { centerY } = resolveTrafficLightMetrics(islandGap)
  return (
    isCompactTrafficLightRow(buttons, islandGap) &&
    buttons.every(button => Math.abs(button.y + button.height / 2 - centerY) <= 1)
  )
}

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

function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 25,
): Promise<boolean> {
  return new Promise(resolve => {
    const deadline = Date.now() + timeoutMs
    const check = (): void => {
      if (predicate()) {
        resolve(true)
        return
      }
      if (Date.now() >= deadline) {
        resolve(false)
        return
      }
      setTimeout(check, intervalMs)
    }
    check()
  })
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
const VERIFY_TOTAL_TIMEOUT_MS = 230_000
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

  const verifyLocalRenderer = async (): Promise<void> => {
    setVerificationStage('settings')
    const openRightPanel = async (id: string): Promise<void> => {
      const selector = `[data-island-id=${JSON.stringify(id)}]`
      if (
        await win.webContents.executeJavaScript(
          `document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-selected') !== 'true'`,
        )
      ) {
        if (
          await win.webContents.executeJavaScript(
            `document.querySelector(${JSON.stringify(selector)}) === null`,
          )
        ) {
          await clickTrustedElement(win, '[aria-label="更多右侧栏目"][aria-haspopup="menu"]')
        }
        await clickTrustedElement(win, selector)
      }
    }
    // 验收期间持续绘制，避免其他窗口遮挡时暂停动画与焦点检查。
    win.webContents.setBackgroundThrottling(false)
    await emulateVerificationMedia(win)
    // 自动验收离屏绘制并模拟页面焦点，不显示系统窗口或抢占用户焦点。
    if (VERIFY_BACKGROUND) {
      await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {
        enabled: true,
      })
      console.log('desktop-shell-verify-local: background', {
        visible: win.isVisible(),
        focused: win.isFocused(),
      })
    } else {
      app.focus({ steal: true })
      focusPrimaryWindow(win)
    }
    const navigationStreams = liveStreamsController
    await verifyWorkspaceNavigation(
      win,
      startupDocument,
      () =>
        navigationStreams !== undefined &&
        liveStreamsController === navigationStreams &&
        !navigationStreams.signal.aborted,
    )
    if (process.argv.includes('--verify-directory-picker')) {
      // 真实系统对话框需要操作员或系统 UI 自动化选取；其余流程沿用同一隔离验收。
      const directory = join(VERIFY_HOME!, 'picked-project')
      mkdirSync(directory, { mode: 0o700 })
      console.log('desktop-shell-verify-directory: 请先取消目录选择，再选择', directory)
      const cancelled = (await win.webContents.executeJavaScript(
        "window.dshDesktop.host.call('pickWorkspaceDirectory', {})",
      )) as unknown
      if (cancelled !== null) throw new Error('取消目录选择没有返回 null')
      const selected = (await win.webContents.executeJavaScript(
        "window.dshDesktop.host.call('pickWorkspaceDirectory', {})",
      )) as unknown
      if (typeof selected !== 'string' || realpathSync(selected) !== realpathSync(directory))
        throw new Error('原生目录选择结果不正确')
      const created = parseDesktopWorkspaceCreateResult(
        await win.webContents.executeJavaScript(
          `window.dshDesktop.host.call('createWorkspace', { path: ${JSON.stringify(selected)} })`,
        ),
      )
      if (created.workspace.path !== realpathSync(directory))
        throw new Error('项目未绑定到实际选中的目录')
      await win.webContents.executeJavaScript(
        `window.dshDesktop.host.call('removeWorkspace', { workspaceId: ${JSON.stringify(created.workspace.workspaceId)} })`,
      )
      const abort = new AbortController()
      const pending = supervisor.call('directoryPicker/pick', { args: {} }, abort.signal)
      const timer = setTimeout(() => {
        abort.abort()
      }, 500)
      try {
        await pending
        throw new Error('目录选择未响应请求取消')
      } catch (error) {
        if (!abort.signal.aborted) throw error
      } finally {
        clearTimeout(timer)
      }
      await new Promise(resolve => {
        setTimeout(resolve, 250)
      })
      console.log('desktop-shell-verify-directory: 原生选择、项目创建、用户取消及请求取消通过')
      // 原生操作员或 UI 自动化可能切走焦点，后续键盘验收重新激活主窗口。
      app.focus({ steal: true })
      focusPrimaryWindow(win)
    }
    if (!VERIFY_BACKGROUND) {
      if (!(await waitForCondition(() => win.isFocused(), 12_000)))
        throw new Error('验收窗口未获得前台焦点')
      win.webContents.focus()
    }
    const windowControlsReady = await verifyWindowControls(win, !VERIFY_BACKGROUND)
    console.log('desktop-shell-verify-local: window-controls', {
      windowControlsReady,
      ...windowController.read(),
    })
    // 使用真实安装目录、资源协议和共享 React 验证扩展链路；所有夹具随隔离目录清理。
    if (VERIFY_HOME === undefined) throw new Error('插件验收缺少隔离目录')
    const extensionSource = join(VERIFY_HOME, 'frontend-plugin')
    mkdirSync(extensionSource, { recursive: true })
    writeFileSync(
      join(extensionSource, 'mydsh.plugin.json'),
      JSON.stringify({
        id: 'verification.extension',
        name: '界面扩展验收',
        version: '1.0.0',
        apiVersion: 1,
        frontend: 'entry.js',
      }),
    )
    writeFileSync(
      join(extensionSource, 'entry.js'),
      `globalThis.__MYDSH_PLUGINS__.define('verification.extension', (require, module) => {
      const React = require('react'), sdk = require('@mydsh/ui');
      module.exports = { name: 'verification.extension', inject: ['mydshSlots'], apply(ctx) {
        function Probe() {
          const [result, setResult] = React.useState('loading');
          React.useEffect(() => { let active = true; sdk.callRemote('session/list', { _request: {} })
            .then(value => { if (active) setResult(Array.isArray(value.items) ? 'ready' : 'invalid') },
              () => { if (active) setResult('error') }); return () => { active = false }; }, []);
          return React.createElement('span', { 'data-plugin-probe': result }, '扩展验收');
        }
        function ProbeIcon() { return React.createElement('span', { 'aria-hidden': true }, '扩'); }
        function ProbeIsland({ placement, visibility }) {
          return React.createElement('section', {
            'data-plugin-island': placement + ':' + visibility,
          }, '动态浮岛验收');
        }
        ctx.mydshSlots.registerAction('workspace.toolbar', 'probe', Probe);
        ctx.mydshSlots.registerIsland({ id: 'verification.island', label: '动态验收', icon: ProbeIcon,
          component: ProbeIsland, placements: ['right'], scope: 'window', preserveWhenHidden: true, order: 100 });
      }};
    });`,
    )
    const extensionResult = (await win.webContents.executeJavaScript(`(async () => {
      await window.dshDesktop.host.call('mydshPlugins.install', { path: ${JSON.stringify(extensionSource)} });
      const wait = async check => { for (let i = 0; i < 200; i++) {
        if (check()) return true;
        await new Promise(resolve => setTimeout(resolve, 25));
      } return false; };
      const fail = stage => ({
        ok: false,
        stage,
        viewport: { width: innerWidth, height: innerHeight },
        compact: window.matchMedia('(max-width: 1268px)').matches,
        probe: document.querySelector('[data-plugin-probe]')?.getAttribute('data-plugin-probe') ?? null,
        island: document.querySelector('[data-plugin-island]')?.getAttribute('data-plugin-island') ?? null,
        inspector: document.querySelector('#session-inspector') !== null,
      });
      const loaded = () => document.querySelector('[data-plugin-probe="ready"]') !== null
        && document.querySelector('[data-plugin-island]') !== null;
      const absent = () => document.querySelector('[data-plugin-probe]') === null
        && document.querySelector('[data-plugin-island]') === null;
      if (!await wait(loaded)) return fail('loaded');
      if (document.querySelector('.right-island-tabs [data-tab-id="conversation"]')) return fail('unexpected-conversation-tab');
      // 右侧栏目减少后扩展可能直接可见；按实际呈现入口验收，不假设一定溢出。
      const directTab = document.querySelector('.right-island-tabs [data-island-id="verification.island"]');
      if (directTab) directTab.click();
      else {
        const overflowTrigger = document.querySelector('[aria-label="更多右侧栏目"][aria-haspopup="menu"]');
        if (!overflowTrigger) return fail('missing-overflow-trigger');
        overflowTrigger.click();
        if (!await wait(() => document.querySelector('.right-island-overflow-menu button[data-island-id="verification.island"]') !== null)) return fail('missing-overflow-item');
        document.querySelector('.right-island-overflow-menu button[data-island-id="verification.island"]')?.click();
      }
      if (!await wait(() => document.querySelector('[data-plugin-island="right:foreground"]') !== null)) return fail('foreground');
      await window.dshDesktop.host.call('mydshPlugins.disable', { id: 'verification.extension' });
      if (!await wait(absent) || document.querySelector('#session-inspector') === null) return fail('disable');
      await window.dshDesktop.host.call('mydshPlugins.enable', { id: 'verification.extension' });
      if (!await wait(() => loaded() && document.querySelector('[data-plugin-island="right:foreground"]') !== null)) return fail('reenable');
      await window.dshDesktop.host.call('mydshPlugins.uninstall', { id: 'verification.extension' });
      if (!await wait(absent) || document.querySelector('#session-inspector') === null) return fail('uninstall');
      return { ok: true };
    })()`)) as { ok: boolean; stage?: string; viewport?: { width: number; height: number } }
    if (!extensionResult.ok)
      throw new Error(
        `真实插件安装、浮岛切换、共享依赖、Remote 或插槽释放验收失败：${JSON.stringify(extensionResult)}`,
      )
    console.log('desktop-shell-verify-local: frontend-plugin lifecycle ready')
    console.log('desktop-shell-verify-local: renderer-initial')
    const initial = (await win.webContents.executeJavaScript(`(async () => {
      try {
      const islands = [...document.querySelectorAll('.app-shell > .island:not([hidden])')]
      let composer = document.querySelector('#composer')
      // 对话与轨迹切换位于聊天浮岛内；左侧模式栏同样有 data-view="conversation"，必须限定范围。
      const trajectory = document.querySelector('.conversation-view-tabs [data-view="trajectory"]')
      const projectSelector = document.querySelector('button[aria-label="专注项目"]')
      if (!(composer instanceof HTMLTextAreaElement)) {
        document.querySelector('[data-view="conversation"]')?.click()
        for (let attempt = 0; attempt < 80; attempt += 1) {
          composer = document.querySelector('#composer')
          if (composer instanceof HTMLTextAreaElement) break
          await new Promise(resolve => setTimeout(resolve, 25))
        }
      }
      if (!(composer instanceof HTMLTextAreaElement)
        || !(trajectory instanceof HTMLButtonElement)
        || !(projectSelector instanceof HTMLButtonElement)) {
        return { verifyError: '核心控件未就绪：'
          + JSON.stringify({ composer: composer?.constructor.name ?? null,
            trajectory: trajectory?.constructor.name ?? null,
            projectSelector: projectSelector?.constructor.name ?? null,
            view: document.querySelector('[data-view][aria-current="page"]')?.getAttribute('data-view') ?? null,
            body: document.body.textContent?.slice(0, 240) ?? '' }) }
      }
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (document.querySelector('.project-session-group .session-row') !== null) break
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      projectSelector.click()
      await new Promise(resolve => setTimeout(resolve, 40))
      const projectFocusMenu = document.querySelector('.project-focus-menu')
      const ownProjectSelectorReady = projectFocusMenu instanceof HTMLElement
        && projectFocusMenu.getAttribute('role') === 'menu'
        && projectFocusMenu.querySelector('[role="menuitemradio"][aria-checked="true"]') instanceof HTMLButtonElement
        && document.querySelector('.project-focus select') === null
      projectSelector.click()
      await new Promise(resolve => setTimeout(resolve, 20))
      const initialHeight = composer.getBoundingClientRect().height
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      valueSetter?.call(composer, Array.from({ length: 9 }, (_, index) => '第 ' + String(index + 1) + ' 行').join('\\n'))
      composer.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 40))
      const grownHeight = composer.getBoundingClientRect().height
      valueSetter?.call(composer, '')
      composer.dispatchEvent(new Event('input', { bubbles: true }))
      trajectory.click()
      await new Promise(resolve => setTimeout(resolve, 40))
      const trajectoryVisible = document.querySelector('#trajectory-view') instanceof HTMLElement
      // 轨迹在聊天浮岛内切换，不再自动收放两侧栏（见 docs/renderer.md）。
      const trajectoryShell = document.querySelector('.app-shell')
      const trajectoryKeepsPanels = trajectoryShell instanceof HTMLElement
        && trajectoryShell.dataset.navigationCollapsed !== 'true'
        && trajectoryShell.dataset.informationCollapsed !== 'true'
      document.querySelector('.conversation-view-tabs [data-view="conversation"]')?.click()
      await new Promise(resolve => setTimeout(resolve, 40))
      // 切换视图会正常取消旧动画；等它们完成或取消后，继续检查实际布局。
      await Promise.allSettled(document.querySelector('.app-shell').getAnimations({ subtree: true })
        .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished))
      const restoredShell = document.querySelector('.app-shell')
      const trajectoryFocusReady = trajectoryKeepsPanels
        && restoredShell instanceof HTMLElement
        && restoredShell.dataset.navigationCollapsed !== 'true'
        && restoredShell.dataset.informationCollapsed !== 'true'
      const currentIslands = [...document.querySelectorAll('.app-shell > .island:not([hidden])')]
      const styles = currentIslands.map(island => getComputedStyle(island))
      const bodyStyle = getComputedStyle(document.body)
      const tabs = [...document.querySelectorAll('.view-tabs button')]
      const projectCard = document.querySelector('.project-selector')
      const projectSectionHeading = document.querySelector('.project-section-heading')
      const projectAddButton = document.querySelector('button[aria-label="添加项目"]')
      const projectChatButtons = [...document.querySelectorAll('.project-group-actions button[aria-label*="新建聊天"]')]
      const costCard = document.querySelector('.info-island .cost-card')
      const projectGroups = [...document.querySelectorAll('.project-session-group')]
      const projectToggles = [...document.querySelectorAll('[data-project-toggle]')]
      const rows = [...document.querySelectorAll('.session-row')]
      const visibleRows = rows.filter(row => row instanceof HTMLElement && row.getClientRects().length > 0)
      const selectedRow = visibleRows.find(row => row.getAttribute('aria-current') === 'page')
      const composerIsland = composer.closest('.composer-card')
      const hiddenSelectedSession = selectedRow === undefined
        && composerIsland instanceof HTMLElement
        && composerIsland.dataset.sessionId !== undefined
      const selectedProjectGroup = selectedRow?.closest('.project-session-group')
        ?? document.querySelector('.project-group-heading.has-selected-session')?.closest('.project-session-group')
      const selectedProjectToggle = selectedProjectGroup?.querySelector('[data-project-toggle]')
      const selectedProjectName = selectedProjectToggle?.querySelector('strong')
      const selectedSessionTitle = selectedRow?.querySelector('.session-row__title')
      const searchTrigger = document.querySelector('.session-search-trigger')
      const navigationIsland = document.querySelector('.navigation-island')
      const sidebarIsland = document.querySelector('.sidebar-island')
      const mainIsland = document.querySelector('.main-island')
      const informationIsland = document.querySelector('.info-island')
      const dragRegion = document.querySelector('.window-drag-region')
      const toolbar = document.querySelector('.mode-rail')
      const navigationDivider = document.querySelector('.panel-divider--navigation')
      const informationDivider = document.querySelector('.panel-divider--information')
      const navigationCapsule = navigationDivider?.querySelector('.panel-divider__capsule')
      const informationCapsule = informationDivider?.querySelector('.panel-divider__capsule')
      const tabHeights = tabs.map(tab => tab.getBoundingClientRect().height)
      const shellStyle = getComputedStyle(document.querySelector('.app-shell'))
      const windowGap = Number.parseFloat(shellStyle.getPropertyValue('--window-gap'))
      const windowEdge = Number.parseFloat(shellStyle.getPropertyValue('--window-edge'))
      const modeRailWidth = Number.parseFloat(shellStyle.getPropertyValue('--mode-rail-width'))
      const composerInset = Number.parseFloat(shellStyle.getPropertyValue('--composer-inset'))
      const expectedIslandTop = windowEdge + (restoredShell.dataset.sessionTabsVisible === 'true'
        ? Number.parseFloat(shellStyle.getPropertyValue('--session-chrome-height')) + windowGap : 0)
      const expectedInformationTop = expectedIslandTop
      const topIslands = [sidebarIsland, mainIsland, informationIsland]
      const islandTops = topIslands.map(island => island instanceof HTMLElement
        ? island.getBoundingClientRect().top
        : 0)
      const dragRegionHeight = dragRegion instanceof HTMLElement
        ? dragRegion.getBoundingClientRect().height
        : 0
      const navigationRect = navigationIsland instanceof HTMLElement
        ? navigationIsland.getBoundingClientRect()
        : null
      const mainRect = mainIsland instanceof HTMLElement
        ? mainIsland.getBoundingClientRect()
        : null
      const informationRect = informationIsland instanceof HTMLElement
        ? informationIsland.getBoundingClientRect()
        : null
      const composerRect = document.querySelector('.composer-card')?.getBoundingClientRect() ?? null
      // 会话读数条在输入卡片下方单独占一行；卡片底边距浮岛底边因此多出这一行。
      const composerReadingsRect = document.querySelector('[data-composer-readings="true"]')?.getBoundingClientRect() ?? null
      const composerRowSpan = composerReadingsRect === null || composerRect === null
        ? 0
        : composerReadingsRect.height + Math.max(0, composerReadingsRect.top - composerRect.bottom)
      const sidebarRect = sidebarIsland?.getBoundingClientRect()
      const projectHeader = document.querySelector('.sidebar-island > .project-focus')
      const projectHeaderRect = projectHeader?.getBoundingClientRect()
      const settingsTrigger = toolbar?.querySelector('#open-settings')
      const dragRect = dragRegion instanceof HTMLElement ? dragRegion.getBoundingClientRect() : null
      const toolbarRect = toolbar instanceof HTMLElement ? toolbar.getBoundingClientRect() : null
      const viewTabsRect = document.querySelector('.view-tabs')?.getBoundingClientRect() ?? null
      const searchTriggerRect = searchTrigger instanceof HTMLElement
        ? searchTrigger.getBoundingClientRect()
        : null
      const navigationDividerRect = navigationDivider instanceof HTMLElement
        ? navigationDivider.getBoundingClientRect()
        : null
      const informationDividerRect = informationDivider instanceof HTMLElement
        ? informationDivider.getBoundingClientRect()
        : null
      const navigationCapsuleRect = navigationCapsule instanceof HTMLElement
        ? navigationCapsule.getBoundingClientRect()
        : null
      const informationCapsuleRect = informationCapsule instanceof HTMLElement
        ? informationCapsule.getBoundingClientRect()
        : null
      const near = (value, expected) => Math.abs(value - expected) <= 1
      const titlebarClearanceReady = topIslands.every(island => island instanceof HTMLElement)
        && near(windowEdge, 8) && near(windowGap, windowEdge)
        && islandTops.every((top, index) => near(top, index === 0 ? windowEdge : index === 2 ? expectedInformationTop : expectedIslandTop))
        && near(dragRegionHeight, innerHeight)
        && dragRect !== null && near(dragRect.top, 0) && near(dragRect.bottom, innerHeight)
        && toolbarRect !== null && near(toolbarRect.left, windowEdge)
        && near(toolbarRect.width, modeRailWidth) && near(toolbarRect.bottom, innerHeight - windowEdge)
        && navigationRect !== null && near(navigationRect.left, toolbarRect.right)
        && near(navigationRect.bottom, innerHeight - windowEdge)
        && mainRect !== null && near(mainRect.left - sidebarRect.right, windowGap)
        && informationRect !== null && near(informationRect.left - mainRect.right, windowGap)
        && near(informationRect.right, innerWidth - windowEdge)
        && near(informationRect.bottom, innerHeight - windowEdge)
        && near(mainRect.bottom, innerHeight - windowEdge)
        && composerRect !== null && composerRect.top > mainRect.top
        && near(mainRect.bottom - composerRect.bottom - composerRowSpan, composerReadingsRect === null ? composerInset + 1 : 7)
        && composerRect.left - mainRect.left >= composerInset + 1
        && mainRect.right - composerRect.right >= composerInset + 1
        && near(composerRect.left + composerRect.right, mainRect.left + mainRect.right)
        && mainIsland.contains(document.querySelector('.composer-card'))
        && sidebarIsland.contains(toolbar) && sidebarIsland.contains(navigationIsland)
        && getComputedStyle(toolbar).backgroundColor !== getComputedStyle(sidebarIsland).backgroundColor
      const topToolbarReady = toolbarRect !== null
        && projectHeaderRect !== undefined && near(projectHeaderRect.top, windowEdge)
        && near(projectHeaderRect.left, sidebarRect.left) && near(projectHeaderRect.right, sidebarRect.right)
        && near(toolbarRect.top, projectHeaderRect.bottom) && near(navigationRect.top, projectHeaderRect.bottom)
        && projectSelector.getBoundingClientRect().left - projectHeaderRect.left
          >= (document.documentElement.dataset.platform === 'win32' ? 6 : 76)
        && near(projectSelector.getBoundingClientRect().top + projectSelector.getBoundingClientRect().height / 2, ${TRAFFIC_LIGHT_CENTER_Y})
        && projectSelector.getBoundingClientRect().top - projectHeaderRect.top >= 1
        && projectHeaderRect.bottom - projectSelector.getBoundingClientRect().bottom >= 1
        && getComputedStyle(projectSelector).getPropertyValue('-webkit-app-region') === 'no-drag'
        && getComputedStyle(projectHeader).getPropertyValue('-webkit-app-region') === 'drag'
        && near(toolbarRect.width, modeRailWidth)
        && getComputedStyle(toolbar).getPropertyValue('-webkit-app-region') === 'drag'
        && getComputedStyle(document.querySelector('.workspace-toolbar-content')).getPropertyValue('-webkit-app-region') === 'drag'
        && toolbar.scrollWidth <= toolbar.clientWidth + 1
        && tabs.length === 6 && ['conversation', 'changes', 'files', 'connections', 'database', 'plugins'].every(id => tabs.some(tab => tab.dataset.view === id))
        && tabs.every((tab, index) => {
          const rect = tab.getBoundingClientRect()
          return rect.left > toolbarRect.left && rect.right < toolbarRect.right
            && (index === 0 || rect.top >= tabs[index - 1].getBoundingClientRect().bottom)
        })
        && searchTrigger instanceof HTMLButtonElement
        && getComputedStyle(searchTrigger).getPropertyValue('-webkit-app-region') === 'no-drag'
        && getComputedStyle(document.querySelector('.view-tabs')).getPropertyValue('-webkit-app-region') === 'no-drag'
        && projectHeader.contains(searchTrigger)
        && searchTrigger.textContent.trim() === ''
        && searchTriggerRect.left >= projectSelector.getBoundingClientRect().right
        && searchTriggerRect.right <= projectHeaderRect.right
        && near(searchTriggerRect.top + searchTriggerRect.height / 2, ${TRAFFIC_LIGHT_CENTER_Y})
        && near(searchTriggerRect.top, projectSelector.getBoundingClientRect().top)
        && near(searchTriggerRect.bottom, projectSelector.getBoundingClientRect().bottom)
        && settingsTrigger instanceof HTMLButtonElement
        && getComputedStyle(settingsTrigger).getPropertyValue('-webkit-app-region') === 'no-drag'
        && settingsTrigger.getBoundingClientRect().top > viewTabsRect.bottom
        && near(toolbarRect.bottom - settingsTrigger.getBoundingClientRect().bottom, 10)
        && mainIsland instanceof HTMLElement
        && mainIsland.querySelector('.view-tabs') === null
      const toolbarLayoutIndependent = viewTabsRect !== null
        && searchTriggerRect !== null && toolbarRect !== null
        && viewTabsRect.left > toolbarRect.left && viewTabsRect.right < toolbarRect.right
        && searchTriggerRect.left >= projectSelector.getBoundingClientRect().right
        && searchTriggerRect.bottom < viewTabsRect.top
      const panelCapsulesReady = navigationDividerRect !== null
        && informationDividerRect !== null
        && navigationCapsuleRect !== null
        && informationCapsuleRect !== null
        && near(navigationDividerRect.width, windowGap)
        && near(informationDividerRect.width, windowGap)
        && near(navigationDividerRect.top, expectedIslandTop)
        && near(navigationDividerRect.bottom, innerHeight - windowEdge)
        && near(informationDividerRect.top, expectedInformationTop)
        && near(informationDividerRect.bottom, innerHeight - windowEdge)
        && near(navigationCapsuleRect.width, 22)
        && near(navigationCapsuleRect.height, 48)
        && near(informationCapsuleRect.width, 22)
        && near(informationCapsuleRect.height, 48)
        && navigationRect !== null
        && informationRect !== null
        && near((navigationCapsuleRect.left + navigationCapsuleRect.right) / 2 - sidebarRect.right, windowGap / 2)
        && near(informationRect.left - (informationCapsuleRect.left + informationCapsuleRect.right) / 2, windowGap / 2)
      const projectToggleTargetsReady = projectToggles.every(toggle => {
          if (!(toggle instanceof HTMLButtonElement)) return false
          const controlledId = toggle.getAttribute('aria-controls')
          const controlled = controlledId === null ? null : document.getElementById(controlledId)
          const expanded = toggle.getAttribute('aria-expanded') === 'true'
          return controlled instanceof HTMLElement
            && controlled.classList.contains('project-session-list')
            && controlled.hidden === !expanded
        })
      const otherProjectsCollapsed = projectGroups
          .filter(group => group !== selectedProjectGroup)
          .every(group => group.querySelector('[data-project-toggle]')?.getAttribute('aria-expanded') === 'false')
      const selectedSessionIndented = hiddenSelectedSession || (selectedSessionTitle instanceof HTMLElement
          && selectedSessionTitle.getBoundingClientRect().left
            >= selectedProjectToggle.getBoundingClientRect().left + 20)
      const projectGroupingAudit = {
        allProjectsSelected: projectSelector.textContent?.includes('全部项目') === true,
        ownProjectSelectorReady,
        projectSectionHeading: projectSectionHeading instanceof HTMLElement,
        projectAddButton: projectAddButton instanceof HTMLButtonElement,
        oneChatButtonPerProject: projectChatButtons.length === projectGroups.length,
        legacyActionsRemoved: document.querySelector('.project-actions') === null,
        legacySearchRemoved: document.querySelector('.search-box') === null,
        hasProjectGroups: projectGroups.length > 0,
        oneTogglePerProject: projectToggles.length === projectGroups.length,
        projectGroupIdsReady: projectGroups.every(group => group.getAttribute('data-project-group') !== null),
        projectToggleTargetsReady,
        hasVisibleOrHiddenSelectedSession: visibleRows.length > 0 || hiddenSelectedSession,
        selectedSessionReady: selectedRow instanceof HTMLButtonElement || hiddenSelectedSession,
        selectedProjectGroup: selectedProjectGroup instanceof HTMLElement,
        selectedProjectToggle: selectedProjectToggle instanceof HTMLButtonElement,
        selectedProjectExpanded: selectedProjectToggle?.getAttribute('aria-expanded') === 'true',
        otherProjectsCollapsed,
        selectedProjectName: selectedProjectName instanceof HTMLElement,
        selectedSessionIndented,
        allRowsGrouped: rows.every(row => projectGroups.some(group => group.contains(row))),
        visibleRows: visibleRows.length,
        projectGroups: projectGroups.length,
      }
      const projectGroupingReady = Object.values(projectGroupingAudit).every(value => value === true || typeof value === 'number')
      const densityReady = bodyStyle.fontSize === '12px'
        && (bodyStyle.fontWeight === '400' || bodyStyle.fontWeight === 'normal')
        && tabs.length === 6 && ['conversation', 'changes', 'files', 'connections', 'database', 'plugins'].every(id => tabs.some(tab => tab.dataset.view === id))
        && tabs.every(tab => tab.getAttribute('aria-label') && tab.querySelector('svg') !== null
          && tab.querySelector('span:not(.count-badge)') === null)
        && tabHeights.every(height => height >= 33.5 && height <= 34.5)
        && tabs.every(tab => Math.abs(tab.getBoundingClientRect().width - 34) <= 0.5)
        && projectSectionHeading instanceof HTMLElement
        && projectSectionHeading.getBoundingClientRect().height >= 33
        && projectSectionHeading.getBoundingClientRect().height <= 36
        && projectCard instanceof HTMLElement
        && projectCard.getBoundingClientRect().height >= 27
        && projectCard.getBoundingClientRect().height <= 29
        && searchTrigger instanceof HTMLElement
        && searchTrigger.getBoundingClientRect().height >= 27
        && searchTrigger.getBoundingClientRect().height <= 29
      const sessionCostRemoved = costCard === null
      const expectedToolsRightOffset = restoredShell.dataset.sessionTabsVisible === 'true' ? 9 : 13
      const workspaceHeaderRemoved = mainIsland instanceof HTMLElement
        && mainIsland.querySelector('.task-header') === null
        && mainIsland.querySelector('.workspace-view') instanceof HTMLElement
        && mainIsland.querySelector('.conversation-header') === null
        && mainIsland.querySelector('.conversation-tools') instanceof HTMLElement
        && near(
          mainIsland.querySelector('.conversation-tools').getBoundingClientRect().right,
          mainRect.right - expectedToolsRightOffset,
        )
        && near(mainIsland.querySelector('.workspace-view').getBoundingClientRect().top, mainRect.top + 1)
      return {
        title: document.title,
        renderer: location.protocol === 'file:',
        islandCount: currentIslands.length,
        pageScrollable: document.documentElement.scrollHeight > innerHeight
          || document.documentElement.scrollWidth > innerWidth,
        islandsOpaque: styles.every(style => !['rgba(0, 0, 0, 0)', 'transparent'].includes(style.backgroundColor)
          && !style.backgroundColor.includes(' / ') && !style.backgroundColor.startsWith('rgba('))
          && styles.every(style => style.backdropFilter === 'none'),
        trajectoryVisible,
        trajectoryFocusReady,
        initialHeight,
        grownHeight,
        composerCapped: grownHeight <= 180,
        projectFocused: projectGroupingReady,
        densityReady,
        sessionCostRemoved,
        workspaceHeaderRemoved,
        bodyFontSize: bodyStyle.fontSize,
        bodyFontWeight: bodyStyle.fontWeight,
        projectActionHeight: projectChatButtons[0] instanceof HTMLElement
          ? projectChatButtons[0].getBoundingClientRect().height
          : 0,
        tabHeight: tabHeights[0] ?? 0,
        titlebarClearanceReady,
        islandTop: islandTops[0] ?? 0,
        topToolbarReady,
        toolbarLayoutIndependent,
        panelCapsulesReady,
        windowGap,
        windowEdge,
        modeRailWidth,
      }
      } catch (error) {
        return { verifyError: error instanceof Error ? error.stack ?? error.message : String(error) }
      }
    })()`)) as null | {
      title: string
      renderer: boolean
      islandCount: number
      pageScrollable: boolean
      islandsOpaque: boolean
      trajectoryVisible: boolean
      trajectoryFocusReady: boolean
      initialHeight: number
      grownHeight: number
      composerCapped: boolean
      projectFocused: boolean
      densityReady: boolean
      sessionCostRemoved: boolean
      workspaceHeaderRemoved: boolean
      bodyFontSize: string
      bodyFontWeight: string
      projectActionHeight: number
      tabHeight: number
      titlebarClearanceReady: boolean
      islandTop: number
      topToolbarReady: boolean
      toolbarLayoutIndependent: boolean
      panelCapsulesReady: boolean
      windowGap: number
      windowEdge: number
      modeRailWidth: number
      verifyError?: string
    }
    if (initial === null) throw new Error('自有 renderer 缺少核心工作台控件')
    // getWindowButtonPosition 只在 macOS 存在；非 macOS 上不会因此跳过红绿灯布局校验。
    if (process.platform === 'darwin') {
      // 按钮高度随 macOS 版本变化，纵向位置由下方的中心对齐检查负责，这里只核对左边距。
      if (win.getWindowButtonPosition()?.x !== TRAFFIC_LIGHT_LEFT) {
        throw new Error('原生红绿灯没有定位到模式浮岛内部')
      }
      // AppKit 重建标题栏后，紧凑布局要等下一次窗口更新才把按钮放回锚点；
      // 先等布局稳定再读取，避免读到系统默认位置造成偶发失败。
      let buttons = readTrafficLightLayout(win)
      await waitForCondition(() => {
        buttons = readTrafficLightLayout(win)
        return isCompactTrafficLightRow(buttons)
      }, 2_000)
      if (!isCompactTrafficLightRow(buttons)) {
        throw new Error(`原生红绿灯间距或边界不正确：${JSON.stringify(buttons)}`)
      }
      const projectCenter = (await win.webContents.executeJavaScript(`(() => {
        const rect = document.querySelector('.project-selector').getBoundingClientRect()
        return rect.top + rect.height / 2
      })()`)) as number
      if (buttons.some(button => Math.abs(button.y + button.height / 2 - projectCenter) > 1)) {
        throw new Error('项目名称没有与原生红绿灯垂直居中对齐')
      }
    }
    if (initial.verifyError !== undefined)
      throw new Error(`读取自有 renderer 状态失败：${initial.verifyError}`)
    console.log(
      'desktop-shell-verify-local: renderer-flags',
      Object.fromEntries(Object.entries(initial).filter(entry => typeof entry[1] === 'boolean')),
    )

    // 隔离验收会话中的排版样本；完成后恢复空历史，不写入 Host 日志。
    const presentationSession = (await win.webContents.executeJavaScript(
      `document.querySelector('.composer-card')?.dataset.sessionId`,
    )) as string
    const presentationEvents = [
      {
        type: 'user/message',
        seq: 0,
        time: Date.now(),
        data: {
          turn: 1,
          source: { kind: 'plugin', plugin: 'AGENTS.md', form: 'instructions' },
          content: [{ type: 'text', text: '项目说明与工作约定' }],
        },
      },
      {
        type: 'deliverables/presented',
        seq: 1,
        time: Date.now(),
        data: { turn: 1, callId: '验收交付', files: [{ path: 'README.md' }] },
      },
      {
        type: 'assistant/message',
        seq: 2,
        time: Date.now(),
        data: {
          turn: 1,
          message: {
            content: [
              { type: 'reasoning', text: '先检查项目的入口和现有文档。' },
              { type: 'text', text: '先核对项目说明。' },
            ],
          },
        },
      },
      {
        type: 'tool/call',
        seq: 3,
        time: Date.now(),
        data: {
          turn: 1,
          callId: '排版读取',
          name: 'bash',
          arguments: '{"command":"cat README.md"}',
        },
      },
      {
        type: 'tool/result',
        seq: 4,
        time: Date.now(),
        data: {
          turn: 1,
          message: {
            source: { callId: '排版读取' },
            content: [
              { type: 'tool-result', content: [{ type: 'text', text: '项目说明读取完成' }] },
            ],
          },
        },
      },
      {
        type: 'assistant/message',
        seq: 5,
        time: Date.now(),
        data: {
          turn: 1,
          message: {
            content: [
              { type: 'reasoning', text: '# 思考标题\n\n检查内容层级。' },
              {
                type: 'text',
                text: '# 一级标题\n\n契约内容正确（`namespace: example`、`cancellation.signal`）。问题可能在服务键使用了点号。先核对服务命名约束。\n\n## 二级标题\n\n### 三级标题\n\napps/web/（`index.html`）\n\n`README.md` · [查看说明](README.md#L1) · [查看图片](large-preview.png) · [不存在](missing.html)',
              },
            ],
          },
        },
      },
    ]
    win.webContents.send(HOST_CHANNELS.sessionFrame, {
      type: 'session/snapshot',
      sessionId: presentationSession,
      lastSeq: 5,
      hasMore: false,
      events: presentationEvents,
    })
    const readPresentation = () =>
      win.webContents.executeJavaScript(`(async () => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const view = document.querySelector('#conversation-view')
        const list = view?.querySelector('ol')
        const composer = document.querySelector('.composer-card')
        const sendButton = composer?.querySelector('.send-button, .stop-button')
        const modelLabel = composer?.querySelector('button[title^="模型："] > span')
        const heading = view?.querySelector('li > div > div > h1')
        const paragraph = heading?.parentElement?.querySelector('p')
        const think = view?.querySelector('[data-thinking-disclosure] summary')
        const rows = view?.querySelectorAll('[data-conversation-seq="0"] summary, [data-thinking-disclosure] summary, [data-tool-disclosure] summary')
        const intermediate = view?.querySelector('[data-conversation-seq="2"][data-message-status]')
        const intermediateText = intermediate?.querySelector('p')
        if (list && composer && sendButton && modelLabel instanceof HTMLElement && heading
          && paragraph && think && intermediateText && rows?.length === 4) {
          const body = parseFloat(getComputedStyle(paragraph).fontSize)
          const labelBounds = modelLabel.getBoundingClientRect()
          const textRange = document.createRange()
          textRange.selectNodeContents(modelLabel)
          const textBounds = textRange.getBoundingClientRect()
          return { width: list.getBoundingClientRect().width,
            modelNameVisible: modelLabel.checkVisibility() && labelBounds.width >= 60
              && textBounds.top >= labelBounds.top - 0.5 && textBounds.bottom <= labelBounds.bottom + 0.5,
            aligned: Math.abs(list.getBoundingClientRect().left - composer.getBoundingClientRect().left) < 1
              && Math.abs(list.getBoundingClientRect().right - composer.getBoundingClientRect().right) < 1
              && [heading, paragraph, intermediateText, ...rows].every(row => Math.abs(list.getBoundingClientRect().left - row.getBoundingClientRect().left) < 1)
              && getComputedStyle(paragraph).textAlign === 'left',
            spacing: getComputedStyle(list).rowGap === '16px' && !view.querySelector('li > header')
              && Math.abs(intermediateText.getBoundingClientRect().top - think.getBoundingClientRect().bottom - 16) < 1
              && [...view.querySelectorAll('time')].every(time => time.closest('[aria-label="消息操作"]')),
            processMetadataHidden: !intermediate.querySelector('[aria-label="消息操作"], time'),
            height: composer.getBoundingClientRect().height,
            circularSend: getComputedStyle(sendButton).borderRadius === '50%'
              && sendButton.getBoundingClientRect().width === sendButton.getBoundingClientRect().height,
            typography: parseFloat(getComputedStyle(heading).fontSize) === body + 3
              && parseFloat(getComputedStyle(think).fontSize) === body - 1,
            handleOpacity: getComputedStyle(document.querySelector('[aria-label="调整对话内容宽度（右侧）"]'), '::before').opacity }
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return null
    })()`) as Promise<{
        width: number
        modelNameVisible: boolean
        aligned: boolean
        spacing: boolean
        processMetadataHidden: boolean
        height: number
        circularSend: boolean
        typography: boolean
        handleOpacity: string
      } | null>
    const defaultPresentation = await readPresentation()
    const presentationScheme = settingsStore.read().colorScheme
    const captureProjectSelector = async (scheme: 'light' | 'dark') => {
      await clickTrustedElement(win, '.project-selector')
      await new Promise(resolve => {
        setTimeout(resolve, 80)
      })
      writeFileSync(
        verificationArtifactPath('verify-project-selector-' + scheme + '.png'),
        (await captureVerifiedPage(win)).toPNG(),
      )
      await clickTrustedElement(win, '.project-selector')
    }
    settingsController.publish(settingsStore.update({ colorScheme: 'light' }))
    await new Promise(resolve => {
      setTimeout(resolve, 120)
    })
    const lightPresentation = await readPresentation()
    writeFileSync(
      verificationArtifactPath('verify-body-alignment-light.png'),
      (await captureVerifiedPage(win)).toPNG(),
    )
    await captureProjectSelector('light')
    settingsController.publish(settingsStore.update({ colorScheme: 'dark' }))
    await new Promise(resolve => {
      setTimeout(resolve, 120)
    })
    const darkPresentation = await readPresentation()
    writeFileSync(
      verificationArtifactPath('verify-body-alignment-dark.png'),
      (await captureVerifiedPage(win)).toPNG(),
    )
    await captureProjectSelector('dark')
    settingsController.publish(settingsStore.update({ colorScheme: presentationScheme }))
    win.setSize(1800, 1000)
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 2, y: 2 })
    await win.webContents.executeJavaScript(
      `document.activeElement instanceof HTMLElement && document.activeElement.blur()`,
    )
    await new Promise(resolve => {
      setTimeout(resolve, 300)
    })
    const widePresentation = await readPresentation()
    // macOS 调整窗口尺寸后，键盘验收需要重新取得窗口与 WebContents 焦点。
    if (!VERIFY_BACKGROUND) {
      app.focus({ steal: true })
      focusPrimaryWindow(win)
    }
    win.webContents.focus()
    // 上一步的 mouseMove 会将 Chromium 切回指针模式；先等待 Tab 真正落到页面再聚焦手柄，
    // 避免迟到的 Tab 在 handle.focus() 之后切走焦点而让随后的 Right 键失效。
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
    await win.webContents.executeJavaScript(`(async () => {
      for (let attempt = 0; attempt < 40 && document.activeElement === document.body; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      const handle = document.querySelector('[aria-label="调整对话内容宽度（右侧）"]')
      if (handle instanceof HTMLElement) handle.focus()
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (handle instanceof HTMLElement && document.activeElement === handle) break
        if (handle instanceof HTMLElement) handle.focus()
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    })()`)
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' })
    // 手柄伪元素存在 180ms 透明度过渡；离屏或 CI 高负载下轮询等待宽度与显影稳定，避免固定 200ms 竞态。
    await win.webContents.executeJavaScript(`(async () => {
      const targetWidth = ${JSON.stringify(widePresentation?.width ?? 0)}
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const list = document.querySelector('#conversation-view ol')
        const handle = document.querySelector('[aria-label="调整对话内容宽度（右侧）"]')
        if (
          list &&
          handle &&
          list.getBoundingClientRect().width > targetWidth &&
          Number(getComputedStyle(handle, '::before').opacity) > 0
        ) {
          return
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    })()`)
    const resizedPresentation = await readPresentation()
    console.log('desktop-shell-verify-local: conversation-presentation', {
      defaultPresentation,
      lightPresentation,
      darkPresentation,
      widePresentation,
      resizedPresentation,
    })
    if (
      !defaultPresentation?.aligned ||
      !lightPresentation?.aligned ||
      !darkPresentation?.aligned ||
      !widePresentation?.aligned ||
      !resizedPresentation?.aligned ||
      ![
        defaultPresentation,
        lightPresentation,
        darkPresentation,
        widePresentation,
        resizedPresentation,
      ].every(
        value =>
          value.spacing &&
          value.processMetadataHidden &&
          value.circularSend &&
          value.modelNameVisible,
      ) ||
      !defaultPresentation.typography ||
      defaultPresentation.height !== 112 ||
      widePresentation.handleOpacity !== '0' ||
      Number(resizedPresentation.handleOpacity) === 0 ||
      resizedPresentation.width <= widePresentation.width
    )
      throw new Error('正文排版或输入区宽度联动验收失败')
    await win.webContents.executeJavaScript(`(() => {
      const handle = document.querySelector('[aria-label="调整对话内容宽度（右侧）"]')
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
      handle.blur()
    })()`)
    win.webContents.send(HOST_CHANNELS.sessionFrame, {
      type: 'session/snapshot',
      sessionId: presentationSession,
      lastSeq: 6,
      hasMore: false,
      events: [
        ...presentationEvents,
        {
          type: 'turn/end',
          seq: 6,
          time: Date.now(),
          data: { turn: 1, reason: { kind: 'completed' } },
        },
      ],
    })
    await new Promise(resolve => {
      setTimeout(resolve, 150)
    })
    const processReady = await win.webContents.executeJavaScript(`(() => {
      const view = document.querySelector('#conversation-view')
      const toggle = view.querySelector('[data-turn-process="1"]')
      const answer = view.querySelector('h1')
      if (toggle?.textContent !== '1 次工具调用 · 1 条消息' || toggle.getAttribute('aria-expanded') !== 'false'
        || view.querySelector('[data-tool-disclosure], [data-thinking-disclosure]') || !answer) throw new Error('过程摘要未收起：' + toggle?.textContent)
      if (Math.abs(toggle.getBoundingClientRect().left - answer.getBoundingClientRect().left) >= 1) throw new Error('过程摘要与最终回答未对齐')
      if (view.querySelectorAll('[aria-label="消息操作"]').length !== 1) throw new Error('最终回答的消息操作数量异常')
      toggle.click()
      return true
    })()`)
    await new Promise(resolve => {
      setTimeout(resolve, 100)
    })
    const expandedPresentation = await readPresentation()
    writeFileSync(
      verificationArtifactPath('verify-turn-process-expanded.png'),
      (await captureVerifiedPage(win)).toPNG(),
    )
    if (
      !processReady ||
      !expandedPresentation?.aligned ||
      !expandedPresentation.spacing ||
      !expandedPresentation.processMetadataHidden
    )
      throw new Error('过程重新展开后的排版异常：' + JSON.stringify(expandedPresentation))
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-turn-process="1"]').click()`,
    )
    await new Promise(resolve => {
      setTimeout(resolve, 100)
    })
    writeFileSync(
      verificationArtifactPath('verify-turn-process.png'),
      (await captureVerifiedPage(win)).toPNG(),
    )
    console.log('desktop-shell-verify-local: turn-process', { ready: processReady })
    const messageFilesCheck = (await win.webContents.executeJavaScript(`(async () => {
      const waitFor = async predicate => {
        for (let attempt = 0; attempt < 80; attempt += 1) {
          if (predicate()) return true
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        return false
      }
      // 文件与对话都以顶部工作标签呈现：链接打开的文件进入可见标签，对话保留在自己的标签里。
      const visiblePanel = () => document.querySelector('.work-tab-panel:not([hidden])')
      const button = name => [...document.querySelectorAll('#conversation-view button')].find(item => item.textContent === name)
      const openConversationTab = async () => {
        document.querySelector('[data-work-tab="session"]')?.click()
        return waitFor(() => visiblePanel()?.querySelector('#conversation-view'))
      }
      const visibleReadme = () => visiblePanel()?.querySelector('[data-file-path="README.md"] .cm-line')?.textContent.includes('MyDSH 验收项目')
      if (button('index.html') || !button('README.md') || !button('查看说明')) return { ready: false, stage: 'conversation-links' }
      button('查看说明').click()
      if (!await waitFor(() => visibleReadme() && document.querySelector('[data-work-tab="session"]'))) return { ready: false, stage: 'markdown-file-main' }
      if (document.querySelector('.right-island-tabs [data-tab-id="files"]')) return { ready: false, stage: 'obsolete-file-right-tab' }
      if (!await openConversationTab()) return { ready: false, stage: 'conversation-after-markdown' }
      button('查看图片').click()
      if (!await waitFor(() => visiblePanel()?.querySelector('.image-viewer img')?.complete)) return { ready: false, stage: 'image-file-main' }
      if (!await openConversationTab()) return { ready: false, stage: 'conversation-after-image' }
      button('不存在').click()
      if (!await waitFor(() => document.body.textContent.includes('missing.html') && document.body.textContent.includes('项目操作失败'))) return { ready: false, stage: 'missing-file-error' }
      if (!document.querySelector('[data-work-tab="file"]')) return { ready: false, stage: 'failure-kept-file' }
      button('README.md').click()
      if (!await waitFor(visibleReadme)) return { ready: false, stage: 'recover-after-error' }
      if (!await openConversationTab()) return { ready: false, stage: 'return-conversation' }
      document.querySelector('button[aria-label="关闭 README.md"]')?.click()
      document.querySelector('button[aria-label="关闭 assets/preview.png"]')?.click()
      return { ready: await waitFor(() => !document.querySelector('[data-work-tab="file"]')), stage: 'complete' }
    })()`)) as { ready: boolean; stage: string }
    console.log('desktop-shell-verify-local: message-file-links', messageFilesCheck)
    if (!messageFilesCheck.ready) {
      const listItems = async (operation: string, field: string): Promise<unknown> => {
        try {
          return (await win.webContents.executeJavaScript(
            `globalThis.dshDesktop.host.call(${JSON.stringify(operation)}, {}).then(result => (result.items ?? []).map(item => item[${JSON.stringify(field)}] ?? null).slice(0, 4))`,
          )) as unknown
        } catch (error) {
          return String(error)
        }
      }
      console.log('desktop-shell-verify-local: file-link-cwds', {
        verifyProject: VERIFY_PROJECT,
        sessionCwds: await listItems('listSessions', 'cwd'),
        workspacePaths: await listItems('listWorkspaces', 'path'),
      })
    }
    if (!messageFilesCheck.ready)
      throw new Error(`对话文件链接与真实文件查看器验收失败：${messageFilesCheck.stage}`)
    const queueSample = (count: number) => ({
      items: Array.from({ length: count }, (_, index) => ({
        id: `${presentationSession}-队列-${String(index)}`,
        placement: 'queued' as const,
        preview:
          index === 0 ? '你应该查询线上数据库的' : '检查查询结果，并保留已有的项目配置与会话记录。',
        previewTruncated: false,
        edit: { kind: 'editable-text' as const, text: '你应该查询线上数据库的' },
      })),
      totalCount: count,
      omittedCount: 0,
      truncated: false,
    })
    const captureQueue = async (name: string) => {
      const bounds = await win.webContents.executeJavaScript(`(async () => {
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const dock = document.querySelector('[aria-label="消息队列"]')
          const view = document.querySelector('#conversation-view')
          const list = view?.querySelector(':scope > ol')
          if (dock && list) {
            view.scrollTop = view.scrollHeight
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
            const rect = dock.getBoundingClientRect()
            const body = list.getBoundingClientRect()
            const action = dock.querySelector('button[aria-label="编辑"]')
            if (Math.abs(rect.width - body.width) > 1 || rect.right > innerWidth
              || rect.left < 0 || dock.scrollWidth > dock.clientWidth) throw new Error('队列宽度或溢出验收失败')
            if (action && getComputedStyle(action).backgroundColor !== 'rgba(0, 0, 0, 0)') throw new Error('队列按钮仍有常驻底色')
            return { x: Math.floor(rect.x - 4), y: Math.floor(rect.y - 4), width: Math.ceil(rect.width + 8), height: Math.ceil(rect.height + 8) }
          }
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        throw new Error('队列未挂载')
      })()`)
      const path = verificationArtifactPath(name)
      writeFileSync(path, (await captureVerifiedPage(win, bounds)).toPNG())
      console.log('desktop-shell-verify-queue-capture:', path)
    }
    win.webContents.send(HOST_CHANNELS.hostFrame, {
      type: 'host/session-status',
      sessionId: presentationSession,
      running: true,
    })
    try {
      win.setSize(1280, 800)
      settingsController.publish(settingsStore.update({ colorScheme: 'dark' }))
      win.webContents.send(HOST_CHANNELS.sessionFrame, {
        type: 'session/queue',
        sessionId: presentationSession,
        queue: queueSample(1),
      })
      await captureQueue('verify-queue-dark.png')
      await win.webContents.executeJavaScript(
        `document.querySelector('[aria-label="消息队列"] button[aria-label="编辑"]').click()`,
      )
      await captureQueue('verify-queue-edit.png')
      await win.webContents.executeJavaScript(
        `document.querySelector('[aria-label="消息队列"] button[aria-label="取消"]').click()`,
      )
      settingsController.publish(settingsStore.update({ colorScheme: 'light' }))
      win.setSize(1800, 1000)
      win.webContents.send(HOST_CHANNELS.sessionFrame, {
        type: 'session/queue',
        sessionId: presentationSession,
        queue: queueSample(3),
      })
      await captureQueue('verify-queue-light-collapsed.png')
      await win.webContents.executeJavaScript(
        `document.querySelector('button[aria-label="展开待处理消息"]').click()`,
      )
      await captureQueue('verify-queue-light-expanded.png')
      win.setSize(900, 720)
      await captureQueue('verify-queue-narrow.png')
    } finally {
      win.webContents.send(HOST_CHANNELS.sessionFrame, {
        type: 'session/queue',
        sessionId: presentationSession,
        queue: queueSample(0),
      })
      win.webContents.send(HOST_CHANNELS.hostFrame, {
        type: 'host/session-status',
        sessionId: presentationSession,
        running: false,
      })
      settingsController.publish(settingsStore.update({ colorScheme: presentationScheme }))
    }
    win.webContents.send(HOST_CHANNELS.sessionFrame, {
      type: 'session/snapshot',
      sessionId: presentationSession,
      events: [],
      lastSeq: 2,
      hasMore: false,
    })
    await verifyMessageActionReveal(
      win,
      presentationSession,
      frame => {
        win.webContents.send(HOST_CHANNELS.sessionFrame, frame)
      },
      scheme => {
        settingsController.publish(settingsStore.update({ colorScheme: scheme }))
      },
      async name => {
        writeFileSync(verificationArtifactPath(name), (await captureVerifiedPage(win)).toPNG())
      },
    )
    await verifyConversationPolish(win, {
      sessionId: presentationSession,
      emit: frame => {
        win.webContents.send(HOST_CHANNELS.sessionFrame, frame)
      },
      setRunning: running => {
        win.webContents.send(HOST_CHANNELS.hostFrame, {
          type: 'host/session-status',
          sessionId: presentationSession,
          running,
        })
      },
      appearance: scheme => {
        settingsController.publish(settingsStore.update({ colorScheme: scheme }))
      },
      restoreAppearance: () => {
        settingsController.publish(settingsStore.update({ colorScheme: presentationScheme }))
      },
      capture: async name => {
        writeFileSync(verificationArtifactPath(name), (await captureVerifiedPage(win)).toPNG())
      },
    })
    if (!supervisor.installed) throw new Error('导出验收缺少已安装核心')
    await verifySessionLogExport(win, {
      installation: supervisor.installed,
      sessionId: presentationSession,
      cancelPending: () => sessionExportController?.abort(new Error('验收取消会话日志导出')),
    })
    await verifyWorkspaceReview(
      win,
      presentationSession,
      frame => {
        win.webContents.send(HOST_CHANNELS.sessionFrame, frame)
      },
      scheme => {
        settingsController.publish(settingsStore.update({ colorScheme: scheme }))
      },
      async name => {
        writeFileSync(verificationArtifactPath(name), (await captureVerifiedPage(win)).toPNG())
      },
      openRightPanel,
    )
    await verifyPluginManager(
      win,
      join(dirname(verificationArtifactPath('verify-plugin-manager.png')), 'plugin-packages'),
      scheme => {
        settingsController.publish(settingsStore.update({ colorScheme: scheme }))
      },
      async name => {
        writeFileSync(verificationArtifactPath(name), (await captureVerifiedPage(win)).toPNG())
      },
    )
    win.setSize(1280, 800)
    await new Promise(resolve => {
      setTimeout(resolve, 300)
    })

    // 打包窗口在系统指针位于外部时会清除合成 hover；用原生 Tab 验证提示与键盘可达性。
    if (!VERIFY_BACKGROUND) {
      app.focus({ steal: true })
      focusPrimaryWindow(win)
      win.webContents.focus()
      await waitForCondition(() => win.isFocused() && win.webContents.isFocused(), 1_000)
    }
    await win.webContents.executeJavaScript(
      `document.querySelector('.session-search-trigger').focus()`,
    )
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
    const modeTooltipReady = (await win.webContents.executeJavaScript(`(async () => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const tooltip = [...document.querySelectorAll('[role="tooltip"]')].find(element => element.textContent === '对话')
        const rect = tooltip?.getBoundingClientRect()
        if (document.activeElement?.getAttribute('data-view') === 'conversation'
          && rect !== undefined && rect.width > 0 && rect.left >= 48 && rect.right <= innerWidth) return true
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return false
    })()`)) as boolean
    if (!modeTooltipReady) {
      const tooltipState = await win.webContents.executeJavaScript(`({
        focused: document.activeElement?.outerHTML?.slice(0, 240),
        tooltips: [...document.querySelectorAll('[role="tooltip"]')].map(element => ({ text: element.textContent, rect: element.getBoundingClientRect().toJSON() })),
      })`)
      throw new Error(`纯图标模式按钮未显示完整的焦点提示：${JSON.stringify(tooltipState)}`)
    }
    writeFileSync(
      verificationArtifactPath('verify-mode-tooltip.png'),
      (await captureVerifiedPage(win)).toPNG(),
    )
    await win.webContents.executeJavaScript('document.activeElement?.blur()')
    console.log('desktop-shell-verify-local: mode-tooltip', modeTooltipReady)

    if (currentHost === undefined) throw new Error('Host 事件流验收时 Host 已离线')
    await callDshHost(
      targetUrl,
      'createSession',
      { cwd: VERIFY_PROJECT ?? process.cwd() },
      fetch,
      currentHost.sessionCookie,
    )
    if (!(await waitForCondition(() => hostEventStreamFrameObserved, 2_000))) {
      throw new Error('没有观察到公开 $events 的 Session 生命周期帧')
    }
    await new Promise(resolve => {
      setTimeout(resolve, 100)
    })

    const commandPaletteAudit = (await win.webContents.executeJavaScript(`(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const wait = async predicate => {
        for (let attempt = 0; attempt < 120; attempt += 1) {
          if (predicate()) return true
          await sleep(25)
        }
        return false
      }
      await wait(() => document.querySelector('#composer') !== null)
      const composer = document.querySelector('#composer')
      if (!(composer instanceof HTMLTextAreaElement)) return { ready: false, reason: '缺少输入框' }
      const write = (element, value) => {
        const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value)
        element.setSelectionRange(value.length, value.length)
        element.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const palette = () => document.querySelector('[role="dialog"][aria-label="命令与 Skill"]')
      const list = () => document.querySelector('#composer-command-listbox')
      const search = () => palette()?.querySelector('input')
      composer.focus()
      write(composer, '/')
      await wait(() => list()?.querySelectorAll('[role="option"]').length === 2)
      const portal = palette()?.parentElement === document.body
      const ariaReady = composer.getAttribute('aria-controls') === 'composer-command-listbox'
        && composer.getAttribute('aria-activedescendant') !== null
      document.getElementById('命令候选-category:command')?.click()
      await wait(() => list()?.querySelectorAll('[role="option"]').length > 2)
      const optionCount = list()?.querySelectorAll('[role="option"]').length ?? 0
      const bounds = palette()?.getBoundingClientRect()
      const bounded = bounds !== undefined && bounds.top >= 12 && bounds.bottom < composer.getBoundingClientRect().top
        && bounds.width <= 421 && bounds.height <= 361
      write(search(), 'compact')
      await wait(() => list()?.querySelectorAll('[role="option"]').length === 1)
      const filtered = list()?.textContent.includes('compact') === true
      list()?.querySelector('[role="option"]')?.click()
      await wait(() => composer.value === '/compact ')
      const draft = '请先检查现有实现，再修复输入面板；保留这段尚未发送的正文。'
      write(composer, draft)
      await sleep(25)
      document.querySelector('[aria-label="打开命令与 Skill"]')?.click()
      await wait(() => document.getElementById('命令候选-category:skill') !== null)
      document.getElementById('命令候选-category:skill')?.click()
      await wait(() => list()?.querySelector('[id^="命令候选-skill:"]') instanceof HTMLElement)
      const skillCount = list()?.querySelectorAll('[role="option"]').length ?? 0
      list()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
      await sleep(30)
      const selected = list()?.querySelector('[aria-selected="true"]')?.getBoundingClientRect()
      const listBounds = list()?.getBoundingClientRect()
      if (!list() || !listBounds) return { ready: false, reason: 'Skill 面板没有打开', skillCount, optionCount }
      const scrollable = list().scrollHeight > list().clientHeight && list().scrollTop > 0
        && selected !== undefined && selected.bottom <= listBounds.bottom + 1
      const skill = list()?.querySelector('[id^="命令候选-skill:"]:not(:disabled)')
      const skillName = skill?.querySelector('strong')?.textContent
      if (!skillName) return { ready: false, reason: 'Skill 目录为空' }
      write(search(), skillName)
      await wait(() => list()?.querySelectorAll('[role="option"]').length === 1)
      search()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      const preserved = await wait(() => composer.value === skillName + ' ' + draft && palette() === null)
      document.querySelector('[aria-label="切换工作模式"]')?.click()
      await wait(() => document.querySelector('[role="menuitemradio"]') !== null)
      const chooseMode = name => [...document.querySelectorAll('[role="menuitemradio"]')]
        .find(button => button.textContent.trim() === name)?.click()
      chooseMode('Plan 模式')
      const planOn = await wait(() => document.querySelector('[data-plan-active="true"]') !== null
        && document.querySelector('[role="menu"][aria-label="工作模式"]') === null)
      const planChip = document.querySelector('[aria-label="退出 Plan 模式"]')
      const planPlaceholder = composer.placeholder === '描述你的任务以生成计划…'
      planChip?.click()
      const planOff = await wait(() => document.querySelector('[data-plan-active="false"]') !== null
        && document.querySelector('[role="menu"][aria-label="工作模式"]') === null)
      const modePreservedDraft = composer.value === skillName + ' ' + draft
      write(composer, '')
      await sleep(40)
      return { ready: portal && ariaReady && bounded && scrollable && filtered && preserved && planOn && planOff && planPlaceholder && modePreservedDraft,
        portal, ariaReady, optionCount: optionCount + skillCount, bounded, scrollable, filtered, preserved, planOn, planOff, modePreservedDraft,
        closedAfterClear: palette() === null, bridgeVersion: globalThis.dshDesktop?.version ?? 0 }
    })()`)) as {
      ready: boolean
      optionCount?: number
      portal?: boolean
      ariaReady?: boolean
      closedAfterClear?: boolean
      bridgeVersion?: number
      reason?: string
    }
    console.log('desktop-shell-verify-local: command-picker', commandPaletteAudit)
    if (!commandPaletteAudit.ready) {
      throw new Error(`命令与 Skill 面板验收失败：${JSON.stringify(commandPaletteAudit)}`)
    }

    const fileReferenceAudit = (await win.webContents.executeJavaScript(`(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const composer = document.querySelector('#composer')
      if (!(composer instanceof HTMLTextAreaElement)) return { ready: false, reason: '缺少输入框' }
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      composer.focus()
      valueSetter?.call(composer, '@README')
      composer.setSelectionRange(7, 7)
      composer.dispatchEvent(new Event('input', { bubbles: true }))
      composer.dispatchEvent(new Event('select', { bubbles: true }))
      let ready = false
      let optionCount = 0
      let error = ''
      for (let index = 0; index < 100; index += 1) {
        await sleep(25)
        const palette = document.querySelector('[aria-label="文件引用面板"]')
        const listbox = document.querySelector('#composer-file-reference-listbox')
        const options = listbox === null ? [] : [...listbox.querySelectorAll('[role="option"]')]
        error = palette?.querySelector('[role="alert"]')?.textContent?.trim() ?? ''
        optionCount = options.length
        ready = palette instanceof HTMLElement
          && palette.parentElement === document.body
          && getComputedStyle(palette).position === 'fixed'
          && composer.getAttribute('aria-expanded') === 'true'
          && composer.getAttribute('aria-controls') === 'composer-file-reference-listbox'
          && composer.getAttribute('aria-activedescendant') !== null
          && options.some(option => option.textContent?.includes('README.md') === true)
        if (ready || error !== '') break
      }
      valueSetter?.call(composer, '')
      composer.setSelectionRange(0, 0)
      composer.dispatchEvent(new Event('input', { bubbles: true }))
      await sleep(40)
      return {
        ready,
        optionCount,
        error,
        closedAfterClear: document.querySelector('[aria-label="文件引用面板"]') === null,
      }
    })()`)) as {
      ready: boolean
      optionCount?: number
      error?: string
      closedAfterClear?: boolean
      reason?: string
    }
    if (!fileReferenceAudit.ready || fileReferenceAudit.closedAfterClear !== true) {
      throw new Error(
        `真实文件引用验收失败：${
          fileReferenceAudit.error ?? fileReferenceAudit.reason ?? 'Host 候选或可访问性状态未就绪'
        }`,
      )
    }

    const attachmentDropAudit = (await win.webContents.executeJavaScript(`(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const composer = document.querySelector('.composer-card')
      if (!(composer instanceof HTMLElement)) return { ready: false, error: '缺少输入区' }
      const canvas = document.createElement('canvas')
      canvas.width = 2
      canvas.height = 2
      const context = canvas.getContext('2d')
      if (context === null) return { ready: false, error: '无法创建验收图片画布' }
      context.fillStyle = '#5b6cff'
      context.fillRect(0, 0, 2, 2)
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
      if (!(blob instanceof Blob)) return { ready: false, error: '无法编码验收 PNG' }
      const transfer = new DataTransfer()
      transfer.items.add(new File([blob], '拖放验收.png', { type: 'image/png' }))
      const dragEnterPrevented = !composer.dispatchEvent(new DragEvent('dragenter', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }))
      await sleep(40)
      const overlayVisible = document.querySelector('.composer-drop-target')?.textContent?.trim()
        === '松开以附加文件或图片'
      const dropPrevented = !composer.dispatchEvent(new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }))
      let attachmentVisible = false
      let error = ''
      for (let index = 0; index < 100; index += 1) {
        await sleep(25)
        attachmentVisible = [...document.querySelectorAll('.composer-attachments li')]
          .some(item => {
            const preview = item.querySelector('img')
            return preview?.alt === '拖放验收.png'
              && preview instanceof HTMLImageElement && preview.complete && preview.naturalWidth === 2
          })
        error = document.querySelector('.app-alert--floating[role="alert"]')?.textContent?.trim() ?? ''
        if (attachmentVisible || error !== '') break
      }
      const remove = document.querySelector('.composer-attachments button')
      if (remove instanceof HTMLButtonElement) remove.click()
      await sleep(40)
      const removed = ![...document.querySelectorAll('.composer-attachments li')]
        .some(item => item.querySelector('img')?.alt === '拖放验收.png')
      const input = document.querySelector('#composer')
      const draft = '粘贴图片时保留正在编辑的正文'
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, draft)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await sleep(25)
      const clipboard = new DataTransfer()
      clipboard.items.add(new File([blob], '粘贴验收.png', { type: 'image/png' }))
      const pastePrevented = !input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }))
      let pasted = false
      for (let index = 0; index < 100; index += 1) {
        await sleep(25)
        const preview = document.querySelector('.composer-attachments img[alt="粘贴验收.png"]')
        if (preview?.complete && preview.naturalWidth === 2) { pasted = true; break }
      }
      const draftPreserved = input.value === draft
      const icons = document.querySelector('[aria-label="附加图片"] .lucide-paperclip') !== null
        && document.querySelector('[aria-label="打开命令与 Skill"] .lucide-terminal') !== null
        && document.querySelector('[aria-label="选择 Skill"]') === null
      document.querySelector('[aria-label="移除附件 粘贴验收.png"]')?.click()
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await sleep(40)
      const pasteRemoved = document.querySelector('.composer-attachments') === null
      return {
        ready: dragEnterPrevented && dropPrevented && overlayVisible && attachmentVisible && removed && error === ''
          && pastePrevented && pasted && draftPreserved && icons && pasteRemoved,
        dragEnterPrevented,
        dropPrevented,
        overlayVisible,
        attachmentVisible,
        removed,
        pastePrevented, pasted, draftPreserved, icons, pasteRemoved,
        error,
      }
    })()`)) as {
      ready: boolean
      dragEnterPrevented?: boolean
      dropPrevented?: boolean
      overlayVisible?: boolean
      attachmentVisible?: boolean
      removed?: boolean
      error?: string
    }
    if (!attachmentDropAudit.ready) {
      throw new Error(`真实图片拖放与粘贴验收失败：${JSON.stringify(attachmentDropAudit)}`)
    }
    const composerScheme = settingsStore.read().colorScheme
    try {
      await verifyComposerLayout(
        win,
        scheme => {
          settingsController.publish(settingsStore.update({ colorScheme: scheme }))
        },
        async name => {
          writeFileSync(verificationArtifactPath(name), (await captureVerifiedPage(win)).toPNG())
        },
      )
    } finally {
      settingsController.publish(settingsStore.update({ colorScheme: composerScheme }))
    }

    const lifecycleIdsBeforeExecution = new Set([
      ...commandRunIdsObserved,
      ...commandDoneIdsObserved,
    ])
    const commandExecutionAudit = (await win.webContents.executeJavaScript(`(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const composer = document.querySelector('#composer')
      if (!(composer instanceof HTMLTextAreaElement)) return { ready: false, error: '缺少输入框' }
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      const line = '/permission workspace-write'
      const previousRows = document.querySelectorAll('[data-command-name="permission"]').length
      composer.focus()
      valueSetter?.call(composer, line)
      composer.setSelectionRange(line.length, line.length)
      composer.dispatchEvent(new Event('input', { bubbles: true }))
      await sleep(60)
      composer.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }))
      let stateText = ''
      let error = ''
      let completed = false
      for (let index = 0; index < 200; index += 1) {
        await sleep(25)
        const rows = document.querySelectorAll('[data-command-name="permission"]')
        const row = rows[rows.length - 1]
        stateText = row?.textContent?.trim() ?? ''
        completed = rows.length > previousRows && row?.getAttribute('data-state') === 'success'
        error = document.querySelector('.app-alert--floating[role="alert"]')?.textContent?.trim() ?? ''
        if ((completed && composer.value === '' && !document.querySelector('.composer-command-state')) || error !== '') break
      }
      return {
        ready: completed && error === '' && document.querySelector('.composer-command-state') === null,
        stateText,
        error,
        draftCleared: composer.value === '',
        paletteClosed: document.querySelector('[role="dialog"][aria-label="命令与 Skill"]') === null,
      }
    })()`)) as {
      ready: boolean
      stateText?: string
      error?: string
      draftCleared?: boolean
      paletteClosed?: boolean
    }
    if (!commandExecutionAudit.ready) {
      throw new Error(
        `真实 Host Command 端到端验收失败：${
          commandExecutionAudit.error || commandExecutionAudit.stateText || '命令状态未就绪'
        }`,
      )
    }
    let observedCommandExecutionId: string | undefined
    const commandLifecycleReady = await waitForCondition(() => {
      observedCommandExecutionId = [...commandRunIdsObserved].find(
        commandId =>
          !lifecycleIdsBeforeExecution.has(commandId) && commandDoneIdsObserved.has(commandId),
      )
      return observedCommandExecutionId !== undefined
    }, 2_000)
    if (!commandLifecycleReady)
      throw new Error('没有观察到真实 command/run 与 command/done 生命周期')

    const permissionMenuResult = (await win.webContents.executeJavaScript(`(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const wait = async (check, attempts = 100) => {
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          const value = check()
          if (value) return value
          await sleep(25)
        }
        return null
      }
      const inMotion = node =>
        typeof node.className === 'string'
        && /(?:^|\\s)ant-[^\\s]+-(?:appear|enter|leave)(?:-(?:prepare|start|active))?(?:\\s|$)/.test(node.className)
      const composer = document.querySelector('#composer')
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      valueSetter?.call(composer, '权限切换时保留这条草稿')
      composer.dispatchEvent(new Event('input', { bubbles: true }))
      await sleep(40)
      const trigger = await wait(() => {
        const button = document.querySelector('.composer-card button[aria-label="访问模式，当前：工作区内修改"]')
        return button instanceof HTMLButtonElement && !button.disabled ? button : null
      }, 80)
      if (!(trigger instanceof HTMLButtonElement)) return { ok: false, stage: 'trigger' }
      trigger.click()
      const full = await wait(() => {
        const menu = document.querySelector('[role="menu"][aria-label="选择访问模式"]')
        const item = menu?.querySelector('button[aria-label="完全权限"]')
        return menu instanceof HTMLElement && item instanceof HTMLButtonElement ? item : null
      }, 60)
      if (!(full instanceof HTMLButtonElement)) return { ok: false, stage: 'menu' }
      full.click()
      const ready = await wait(() => {
        const dialog = document.querySelector('[role="dialog"]')
        if (!(dialog instanceof HTMLElement) || inMotion(dialog)) return false
        const running = dialog.getAnimations({ subtree: true })
          .some(animation => animation.playState !== 'finished' && animation.effect?.getComputedTiming().iterations !== Infinity)
        if (running) return false
        const confirmation = [...dialog.querySelectorAll('button')].find(button => button.textContent?.includes('启用完全权限'))
        const acknowledgement = dialog.querySelector('input[type="checkbox"]')
        const rect = dialog.getBoundingClientRect()
        return confirmation instanceof HTMLButtonElement && confirmation.disabled
          && acknowledgement instanceof HTMLInputElement && !acknowledgement.checked
          && document.querySelector('[aria-label="选择访问模式"]') === null
          && rect.top >= 8 && rect.bottom <= innerHeight - 8 && Math.abs(rect.left + rect.width / 2 - innerWidth / 2) < 2
          && Math.abs(rect.top + rect.height / 2 - innerHeight / 2) < 20
          && dialog.contains(document.activeElement)
      }, 100)
      if (!ready) {
        const dialog = document.querySelector('[role="dialog"]')
        return {
          ok: false,
          stage: 'open-dialog',
          hasDialog: dialog instanceof HTMLElement,
          dialogClass: dialog?.className ?? null,
          activeTag: document.activeElement?.tagName ?? null,
          menuOpen: document.querySelector('[aria-label="选择访问模式"]') !== null,
        }
      }
      document.querySelector('[role="dialog"]')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true, cancelable: true }),
      )
      const cancelled = await wait(() =>
        document.querySelector('[aria-label="选择访问模式"]') === null
        && document.querySelector('[role="dialog"]') === null
        && document.activeElement === trigger
        && trigger.getAttribute('aria-label') === '访问模式，当前：工作区内修改', 100)
      if (!cancelled) {
        return {
          ok: false,
          stage: 'cancel-dialog',
          hasDialog: document.querySelector('[role="dialog"]') !== null,
          activeTag: document.activeElement?.tagName ?? null,
          triggerLabel: trigger.getAttribute('aria-label'),
        }
      }
      trigger.click()
      const reopenFull = await wait(() => document.querySelector('button[aria-label="完全权限"]'), 60)
      if (!(reopenFull instanceof HTMLButtonElement)) return { ok: false, stage: 'reopen-menu' }
      reopenFull.click()
      const confirmedDialog = await wait(() => {
        const dialog = document.querySelector('.ant-modal[role="dialog"]')
        return dialog instanceof HTMLElement && !inMotion(dialog) && dialog.querySelector('input[type="checkbox"]')
          ? dialog
          : null
      }, 100)
      if (!(confirmedDialog instanceof HTMLElement)) return { ok: false, stage: 'reopen-dialog' }
      confirmedDialog.querySelector('input[type="checkbox"]').click()
      const confirmButton = await wait(() => {
        const button = [...confirmedDialog.querySelectorAll('button')].find(item => item.textContent?.includes('启用完全权限'))
        return button instanceof HTMLButtonElement && !button.disabled ? button : null
      }, 60)
      if (!(confirmButton instanceof HTMLButtonElement)) return { ok: false, stage: 'confirm-button' }
      confirmButton.click()
      await wait(
        () =>
          document.querySelector('[role="dialog"]') === null
          && trigger.getAttribute('aria-label') === '访问模式，当前：完全权限'
          && !trigger.disabled,
        120,
      )
      const switched = document.querySelector('[role="dialog"]') === null
        && trigger.getAttribute('aria-label') === '访问模式，当前：完全权限'
        && document.querySelector('.composer-command-state') === null
        && document.querySelector('[aria-label="消息队列"]') === null
        && !document.querySelector('.composer-tools').textContent.includes('待处理')
        && composer.value === '权限切换时保留这条草稿'
      trigger.click()
      const workspaceItem = await wait(() => document.querySelector('button[aria-label="工作区内修改"]'), 80)
      if (!(workspaceItem instanceof HTMLButtonElement)) {
        return {
          ok: false,
          stage: 'restore-menu',
          hasDialog: document.querySelector('[role="dialog"]') !== null,
          triggerLabel: trigger.getAttribute('aria-label'),
        }
      }
      workspaceItem.click()
      await wait(() => trigger.getAttribute('aria-label') === '访问模式，当前：工作区内修改', 80)
      valueSetter?.call(composer, '')
      composer.dispatchEvent(new Event('input', { bubbles: true }))
      return {
        ok: switched && trigger.getAttribute('aria-label') === '访问模式，当前：工作区内修改',
        stage: switched ? 'restore-mode' : 'switch-full',
        triggerLabel: trigger.getAttribute('aria-label'),
      }
    })()`)) as { ok: boolean; stage?: string }
    const permissionMenuReady = permissionMenuResult.ok
    if (!permissionMenuReady)
      throw new Error(
        `权限投影、目录、风险确认或取消后的权限保持验收失败：${JSON.stringify(permissionMenuResult)}`,
      )
    console.log('desktop-shell-verify-local: permission-menu', permissionMenuReady)
    await verifyPermissionDialog(
      win,
      scheme => {
        settingsController.publish(settingsStore.update({ colorScheme: scheme }))
      },
      async name => {
        writeFileSync(verificationArtifactPath(name), (await captureVerifiedPage(win)).toPNG())
      },
    )

    settingsController.publish(settingsStore.update({ colorScheme: 'dark' }))
    const actionErrorReady = (await win.webContents.executeJavaScript(`(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const composer = document.querySelector('#composer')
      const beforeHeight = document.querySelector('.composer-card').getBoundingClientRect().height
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(composer, '/mydsh-invalid-verify')
      composer.dispatchEvent(new Event('input', { bubbles: true }))
      await sleep(40)
      composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      for (let attempt = 0; attempt < 80; attempt += 1) {
        await sleep(25)
        const alert = document.querySelector('.app-alert--error.app-alert--floating')
        if (alert) {
          const rect = alert.getBoundingClientRect()
          return alert.parentElement === document.body && getComputedStyle(alert).position === 'fixed'
            && rect.top >= 10 && rect.left >= 10 && rect.right <= innerWidth - 10
            && alert.textContent.includes('未知斜杠命令') && composer.value === '/mydsh-invalid-verify'
            && document.querySelector('.composer-card').getBoundingClientRect().height === beforeHeight
        }
      }
      return false
    })()`)) as boolean
    writeFileSync(
      verificationArtifactPath('verify-action-error-dark.png'),
      (await captureVerifiedPage(win)).toPNG(),
    )
    if (!actionErrorReady) throw new Error('操作错误浮层、草稿保留或输入区高度验收失败')
    settingsController.publish(settingsStore.update({ colorScheme: 'light' }))
    const lightActionErrorReady = (await win.webContents.executeJavaScript(`(async () => {
      for (let attempt = 0; attempt < 40 && document.documentElement.dataset.colorScheme !== 'light'; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      return document.documentElement.dataset.colorScheme === 'light'
        && getComputedStyle(document.documentElement).getPropertyValue('--surface-raised').trim() === '#eceef2'
        && document.querySelector('.app-alert--error.app-alert--floating') !== null
    })()`)) as boolean
    if (!lightActionErrorReady) throw new Error('浅色主题操作错误提示验收失败')
    writeFileSync(
      verificationArtifactPath('verify-action-error-light.png'),
      (await captureVerifiedPage(win)).toPNG(),
    )
    const actionErrorClosed = (await win.webContents.executeJavaScript(`(async () => {
      document.querySelector('.app-alert--floating button[aria-label="关闭提示"]').click()
      await new Promise(resolve => setTimeout(resolve, 40))
      const composer = document.querySelector('#composer')
      const closed = document.querySelector('.app-alert--floating') === null && composer.value === '/mydsh-invalid-verify'
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(composer, '')
      composer.dispatchEvent(new Event('input', { bubbles: true }))
      return closed
    })()`)) as boolean
    if (!actionErrorClosed) throw new Error('操作错误关闭后未正确保留草稿')
    settingsController.publish(settingsStore.update({ colorScheme: presentationScheme }))
    console.log(
      'desktop-shell-verify-local: action-error-toast',
      actionErrorReady && actionErrorClosed,
    )

    // 会话信息已不再作为右栏入口，用量明细移到输入区底部的仪表盘（见 docs/renderer.md）。
    const verifyFontScale = async (fontSize: 11 | 18): Promise<boolean> => {
      settingsController.publish(settingsStore.update({ fontSize }))
      await new Promise(resolve => {
        setTimeout(resolve, 100)
      })
      return win.webContents.executeJavaScript(`(() => {
        const expected = ${String(fontSize)}
        const root = document.documentElement
        const tabs = [...document.querySelectorAll('.view-tabs button')]
        const sessionRows = [...document.querySelectorAll('.session-row')]
        const projectSelector = document.querySelector('.project-selector')
        const searchTrigger = document.querySelector('.session-search-trigger')
        const composer = document.querySelector('#composer')
        const singleLine = elements => elements.every(element => element.scrollWidth <= element.clientWidth + 1
          && element.scrollHeight <= element.clientHeight + 1)
        return getComputedStyle(document.body).fontSize === String(expected) + 'px'
          && root.style.getPropertyValue('--text-body').trim() === String(expected) + 'px'
          && tabs.every(tab => {
            const icon = tab.querySelector('svg')?.getBoundingClientRect()
            return icon !== undefined && icon.width === 20 && icon.height === 20
              && tab.getAttribute('aria-label') !== null
          })
          && singleLine(sessionRows)
          && projectSelector instanceof HTMLElement
          && searchTrigger instanceof HTMLElement
          && searchTrigger.scrollHeight <= searchTrigger.clientHeight + 1
          && composer instanceof HTMLTextAreaElement
          && getComputedStyle(composer).fontSize === String(expected) + 'px'
      })()`) as Promise<boolean>
    }
    const compactFontReady = await verifyFontScale(11)
    const largeFontReady = await verifyFontScale(18)
    settingsController.publish(settingsStore.update({ fontSize: 12 }))
    await new Promise(resolve => {
      setTimeout(resolve, 100)
    })
    settingsController.publish(settingsStore.update({ accentColor: '#ffffff' }))
    await new Promise(resolve => {
      setTimeout(resolve, 80)
    })
    const lightAccentReady = (await win.webContents
      .executeJavaScript(`document.documentElement.style
      .getPropertyValue('--accent-contrast').trim() === '#000000'`)) as boolean
    settingsController.publish(settingsStore.update({ accentColor: '#000000' }))
    await new Promise(resolve => {
      setTimeout(resolve, 80)
    })
    const darkAccentReady = (await win.webContents.executeJavaScript(`document.documentElement.style
      .getPropertyValue('--accent-contrast').trim() === '#ffffff'`)) as boolean
    settingsController.publish(settingsStore.update({ accentColor: '#4d6bfe' }))
    await new Promise(resolve => {
      setTimeout(resolve, 100)
    })
    const fontScaleReady = compactFontReady && largeFontReady
    const accentContrastReady = lightAccentReady && darkAccentReady

    const projectGroupingReady =
      initial.projectFocused &&
      ((await win.webContents.executeJavaScript(`(async () => {
        const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
        const selector = document.querySelector('button[aria-label="专注项目"]')
        if (!(selector instanceof HTMLButtonElement)
          || selector.textContent?.includes('全部项目') !== true) return false
        selector.click()
        await sleep(40)
        let menu = document.querySelector('.project-focus-menu')
        const option = menu instanceof HTMLElement
          ? [...menu.querySelectorAll('[role="menuitemradio"]')]
              .find(item => item.getAttribute('aria-checked') !== 'true')
          : undefined
        if (!(option instanceof HTMLButtonElement)) {
          return document.querySelectorAll('.project-session-group').length === 0
        }
        option.click()
        await sleep(140)
        const visible = element => element instanceof HTMLElement && element.getClientRects().length > 0
        const focusedGroup = document.querySelector('.project-session-group')
        const focusedRows = focusedGroup === null
          ? []
          : [...focusedGroup.querySelectorAll('.session-row')].filter(visible)
        const focusedToggle = focusedGroup?.querySelector('[data-project-toggle]')
        const focusedProjectId = focusedGroup?.getAttribute('data-project-group')
        const focusedList = focusedGroup?.querySelector('.project-session-list')
        const focusedBlankReady = focusedRows.length === 0
          && focusedList?.querySelector('.session-list__empty') instanceof HTMLElement
        const focused = selector.textContent?.includes('全部项目') !== true
          && document.querySelectorAll('.project-session-group').length === 1
          && document.querySelector('.project-section-heading h2')?.textContent?.trim() === '会话'
          && (focusedRows.length > 0 || focusedBlankReady)
          && focusedProjectId !== null
          && focusedGroup?.querySelector('.project-group-heading') === null
          && focusedToggle === null
          && focusedList instanceof HTMLElement
          && !focusedList.hidden
          && focusedRows.every(row => row.getAttribute('data-project-id') === focusedProjectId)
        selector.click()
        await sleep(40)
        menu = document.querySelector('.project-focus-menu')
        const allProjects = menu instanceof HTMLElement
          ? [...menu.querySelectorAll('[role="menuitemradio"]')]
              .find(item => item.textContent?.includes('全部项目') === true)
          : undefined
        if (!(allProjects instanceof HTMLButtonElement)) return false
        allProjects.click()
        await sleep(140)
        const selectedRow = [...document.querySelectorAll('.session-row')]
          .find(row => row.getAttribute('aria-current') === 'page' && visible(row))
        const selectedGroup = selectedRow?.closest('.project-session-group')
          ?? document.querySelector('.project-group-heading.has-selected-session')?.closest('.project-session-group')
        const toggle = selectedGroup?.querySelector('[data-project-toggle]')
        const selectedBlankHidden = !(selectedRow instanceof HTMLButtonElement)
          && selectedGroup instanceof HTMLElement
        if (!(selectedGroup instanceof HTMLElement)
          || !(toggle instanceof HTMLButtonElement)) return false
        const controlledId = toggle.getAttribute('aria-controls')
        const controlled = controlledId === null ? null : document.getElementById(controlledId)
        const restored = selector.textContent?.includes('全部项目') === true
          && toggle.getAttribute('aria-expanded') === 'true'
          && controlled instanceof HTMLElement
          && !controlled.hidden
        toggle.click()
        await sleep(80)
        const collapsed = selector.textContent?.includes('全部项目') === true
          && toggle.getAttribute('aria-expanded') === 'false'
          && controlled instanceof HTMLElement
          && controlled.hidden
          && ![...selectedGroup.querySelectorAll('.session-row')].some(visible)
        toggle.click()
        await sleep(80)
        const expandedAgain = selector.textContent?.includes('全部项目') === true
          && toggle.getAttribute('aria-expanded') === 'true'
          && controlled instanceof HTMLElement
          && !controlled.hidden
          && (selectedBlankHidden || [...selectedGroup.querySelectorAll('.session-row')].some(visible))
        return focused
          && restored
          && collapsed
          && expandedAgain
          && [...document.querySelectorAll('.session-row')]
            .every(row => row.closest('.project-session-group') !== null)
      })()`)) as boolean)

    const sessionActionTarget = (await win.webContents.executeJavaScript(`(() => {
      const row = [...document.querySelectorAll('.project-session-group .session-row-shell')]
        .find(element => element instanceof HTMLElement && element.getClientRects().length > 0)
      return row?.getAttribute('data-session-id') ?? null
    })()`)) as string | null
    let sessionActionsReady = sessionActionTarget === null
    let sessionActionsCapture = ''
    if (sessionActionTarget !== null) {
      const escapedSessionActionTarget = JSON.stringify(sessionActionTarget)
      await clickTrustedElement(
        win,
        `.project-session-group .session-row-shell[data-session-id=${escapedSessionActionTarget}] button[aria-label="置顶聊天"]`,
      )
      await new Promise(resolve => {
        setTimeout(resolve, 120)
      })
      sessionActionsReady = (await win.webContents.executeJavaScript(`(() => {
        const sessionId = ${escapedSessionActionTarget}
        const pinnedGroup = document.querySelector('.pinned-session-group')
        const pinnedRow = pinnedGroup?.querySelector('.session-row-shell[data-session-id=' + JSON.stringify(sessionId) + ']')
        const projectDuplicate = document.querySelector('.project-session-group .session-row-shell[data-session-id=' + JSON.stringify(sessionId) + ']')
        const unpin = pinnedRow?.querySelector('button[aria-label="取消置顶聊天"]')
        const archive = pinnedRow?.querySelector('button[aria-label="归档聊天"]')
        const stored = JSON.parse(localStorage.getItem('mydsh:pinned-session-ids') ?? '[]')
        if (!(pinnedGroup instanceof HTMLElement)
          || !(pinnedRow instanceof HTMLElement)
          || !(unpin instanceof HTMLButtonElement)
          || !(archive instanceof HTMLButtonElement)) return false
        const rowRect = pinnedRow.getBoundingClientRect()
        const groupRect = pinnedGroup.getBoundingClientRect()
        return pinnedGroup.querySelector('h2')?.textContent?.trim() === '置顶'
          && pinnedRow.getAttribute('data-pinned') === 'true'
          && projectDuplicate === null
          && Array.isArray(stored)
          && stored[0] === sessionId
          && rowRect.left >= groupRect.left - 1
          && rowRect.right <= groupRect.right + 1
          && rowRect.height >= 32
      })()`)) as boolean
      if (sessionActionsReady) {
        const hoverPoint = (await win.webContents.executeJavaScript(`(() => {
          const row = document.querySelector('.pinned-session-group .session-row-shell[data-session-id=' + JSON.stringify(${escapedSessionActionTarget}) + ']')
          if (!(row instanceof HTMLElement)) return null
          const rect = row.getBoundingClientRect()
          return { x: Math.round(rect.right - 32), y: Math.round(rect.top + rect.height / 2) }
        })()`)) as { x: number; y: number } | null
        if (hoverPoint !== null) {
          win.webContents.sendInputEvent({ type: 'mouseMove', ...hoverPoint })
          await new Promise(resolve => {
            setTimeout(resolve, 100)
          })
        }
        sessionActionsCapture = 'verify-session-actions.png'
        writeFileSync(
          verificationArtifactPath(sessionActionsCapture),
          (await captureVerifiedPage(win)).toPNG(),
        )
      }
      await clickTrustedElement(
        win,
        `.pinned-session-group .session-row-shell[data-session-id=${escapedSessionActionTarget}] button[aria-label="取消置顶聊天"]`,
      )
      await new Promise(resolve => {
        setTimeout(resolve, 100)
      })
      sessionActionsReady =
        sessionActionsReady &&
        ((await win.webContents.executeJavaScript(`(() => {
          const sessionId = ${escapedSessionActionTarget}
          const projectRow = document.querySelector('.project-session-group .session-row-shell[data-session-id=' + JSON.stringify(sessionId) + ']')
          const stored = JSON.parse(localStorage.getItem('mydsh:pinned-session-ids') ?? '[]')
          return projectRow instanceof HTMLElement
            && document.querySelector('.pinned-session-group') === null
            && Array.isArray(stored)
            && !stored.includes(sessionId)
        })()`)) as boolean)
    }

    await clickTrustedElement(win, '.session-search-trigger')
    await new Promise(resolve => {
      setTimeout(resolve, 160)
    })
    const sessionSearchState = (await win.webContents.executeJavaScript(`(() => {
      const trigger = document.querySelector('.session-search-trigger')
      const dialog = document.querySelector('#session-search-dialog')
      const input = dialog?.querySelector('input[type="search"]')
      const results = [...document.querySelectorAll('.session-search-result')]
      const ready = trigger instanceof HTMLButtonElement
        && trigger.getAttribute('aria-expanded') === 'true'
        && dialog instanceof HTMLElement
        && dialog.getAttribute('role') === 'dialog'
        && input instanceof HTMLInputElement
        && document.activeElement === input
        && results.length > 0
        && results.every(result => result.querySelector('strong')?.textContent?.trim() !== '')
        && results.every(result => result.querySelector('small')?.textContent?.trim() !== '')
      return {
        ready,
        expanded: trigger?.getAttribute('aria-expanded') ?? null,
        dialogPresent: dialog instanceof HTMLElement,
        closePresent: dialog?.querySelector('.session-search-close') instanceof HTMLButtonElement,
        inputFocused: document.activeElement === input,
        resultCount: results.length,
      }
    })()`)) as {
      ready: boolean
      expanded: string | null
      dialogPresent: boolean
      closePresent: boolean
      inputFocused: boolean
      resultCount: number
    }
    let sessionSearchReady = sessionSearchState.ready
    console.log(`desktop-shell-verify-local: session-search ${JSON.stringify(sessionSearchState)}`)
    const searchCapture = 'verify-search.png'
    if (sessionSearchState.dialogPresent) {
      writeFileSync(
        verificationArtifactPath(searchCapture),
        (await captureVerifiedPage(win)).toPNG(),
      )
    }
    if (sessionSearchState.closePresent) await clickTrustedElement(win, '.session-search-close')

    sessionSearchReady =
      sessionSearchReady &&
      ((await win.webContents.executeJavaScript(`(() => {
      const trigger = document.querySelector('.session-search-trigger')
      return document.querySelector('#session-search-dialog') === null
        && trigger?.getAttribute('aria-expanded') === 'false'
        && document.activeElement === trigger
    })()`)) as boolean)

    const originalSessionTab = (await win.webContents.executeJavaScript(
      `document.querySelector('.session-tab[aria-selected="true"]')?.getAttribute('data-session-tab') ?? null`,
    )) as string | null
    let sessionTabsReady = false
    if (originalSessionTab !== null) {
      const originalGroup = (await win.webContents.executeJavaScript(
        `document.querySelector('.session-tab-group').getAttribute('aria-label')`,
      )) as string
      const groupNavigationExpanded = (await win.webContents.executeJavaScript(
        `document.querySelector('.app-shell').dataset.navigationCollapsed !== 'true'`,
      )) as boolean
      if (groupNavigationExpanded)
        await clickTrustedElement(win, '.panel-divider--navigation .panel-divider__capsule')
      await clickTrustedElement(win, '.session-search-trigger')
      await new Promise(resolve => {
        setTimeout(resolve, 120)
      })
      await win.webContents.executeJavaScript(`(() => {
        const result = [...document.querySelectorAll('.session-search-result')]
          .find(button => button.querySelector('small')?.textContent !== ${JSON.stringify(originalGroup)})
        if (!result) throw new Error('缺少另一个项目的验收会话')
        result.id = 'verify-other-group'
      })()`)
      await clickTrustedElement(win, '#verify-other-group')
      win.webContents.send(HOST_CHANNELS.hostFrame, {
        type: 'host/session-status',
        sessionId: originalSessionTab,
        running: true,
      })
      win.webContents.send(HOST_CHANNELS.hostFrame, {
        type: 'host/session-status',
        sessionId: originalSessionTab,
        running: false,
      })
      const groupNotificationReady = (await win.webContents.executeJavaScript(`(async () => {
        for (let attempt = 0; attempt < 80; attempt++) {
          if (document.querySelector('.session-group-switcher .session-group-unread')?.textContent === '1') {
            return document.querySelectorAll('.session-tab-group').length === 1
              && ![...document.querySelectorAll('.session-tab')].some(tab => tab.dataset.sessionTab === ${JSON.stringify(originalSessionTab)})
          }
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        return false
      })()`)) as boolean
      const waitForOtherSessionGroup = async () =>
        (await win.webContents.executeJavaScript(`(async () => {
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const option = document.querySelector('.session-group-menu [aria-checked="false"]')
          if (option instanceof HTMLButtonElement && option.getClientRects().length > 0) return true
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        return false
      })()`)) as boolean
      await win.webContents
        .executeJavaScript(`Promise.all(document.querySelector('.app-shell').getAnimations({ subtree: true })
        .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))`)
      await clickTrustedElement(win, '.session-group-switcher')
      if (!(await waitForOtherSessionGroup())) throw new Error('标签组菜单没有显示其他项目')
      writeFileSync(
        verificationArtifactPath('verify-session-group-menu.png'),
        (await captureVerifiedPage(win)).toPNG(),
      )
      await clickTrustedElement(win, '.session-group-menu [aria-checked="false"]')
      const groupSwitchReady =
        groupNotificationReady &&
        ((await win.webContents.executeJavaScript(`(() => {
        return document.querySelector('.session-tab[aria-selected="true"]')?.dataset.sessionTab === ${JSON.stringify(originalSessionTab)}
          && document.querySelector('.session-group-switcher .session-group-unread') === null
          && document.querySelectorAll('.session-tab-group').length === 1
      })()`)) as boolean)
      if (!groupSwitchReady) throw new Error('标签组切换或后台更新提示验收失败')
      await clickTrustedElement(win, '.session-group-switcher')
      if (!(await waitForOtherSessionGroup())) throw new Error('标签组菜单没有恢复其他项目')
      await clickTrustedElement(win, '.session-group-menu [aria-checked="false"]')
      await clickTrustedElement(win, '.session-tab-shell[data-selected="true"] .session-tab-close')
      if (groupNavigationExpanded)
        await clickTrustedElement(win, '.panel-divider--navigation .panel-divider__capsule')

      // 同一项目新增一个真实会话，继续验收组内玻璃运动、排序与关闭。
      const peerSession = (await win.webContents.executeJavaScript(`(async () => {
        const { items } = await window.dshDesktop.host.call('listWorkspaces', {})
        const project = items.find(item => item.sessionIds.includes(${JSON.stringify(originalSessionTab)}))
        const { items: sessions } = await window.dshDesktop.host.call('listSessions', {})
        const original = sessions.find(item => item.sessionId === ${JSON.stringify(originalSessionTab)})
        const result = project
          ? await window.dshDesktop.host.call('createSessionForWorkspace', { workspaceId: project.workspaceId })
          : await window.dshDesktop.host.call('createSession', { ...(original.cwd ? { cwd: original.cwd } : {}) })
        await window.dshDesktop.host.call('renameSession', { sessionId: result.sessionId, title: '标签交互验收' })
        return result.sessionId
      })()`)) as string
      await clickTrustedElement(win, '.session-search-trigger')
      await win.webContents.executeJavaScript(`(async () => {
        for (let attempt = 0; attempt < 80; attempt++) {
          const result = [...document.querySelectorAll('.session-search-result')].find(button => button.querySelector('strong')?.textContent === '标签交互验收')
          if (result) { result.id = 'verify-peer-session'; return }
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        throw new Error('新建的同项目会话未出现在搜索结果中')
      })()`)
      await clickTrustedElement(win, '#verify-peer-session')
      await win.webContents
        .executeJavaScript(`Promise.all(document.querySelector('.app-shell').getAnimations({ subtree: true })
        .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished))`)
      const otherSessionTab = (await win.webContents.executeJavaScript(
        `document.querySelector('.session-tab[aria-selected="true"]')?.getAttribute('data-session-tab') ?? null`,
      )) as string | null
      if (otherSessionTab !== peerSession) throw new Error('没有打开同项目验收会话')
      if (otherSessionTab !== null && otherSessionTab !== originalSessionTab) {
        const originalSelector = `.session-tab[data-session-tab=${JSON.stringify(originalSessionTab)}]`
        const otherSelector = `.session-tab[data-session-tab=${JSON.stringify(otherSessionTab)}]`
        const rightCollapsed = (await win.webContents.executeJavaScript(
          `document.querySelector('.app-shell')?.dataset.informationCollapsed === 'true'`,
        )) as boolean
        if (rightCollapsed) await clickTrustedElement(win, '[aria-label="展开右侧浮岛"]')
        const rightSelectorReady = (await win.webContents.executeJavaScript(`(async () => {
          for (let attempt = 0; attempt < 80; attempt += 1) {
            const selector = document.querySelector('.right-island-tabs')
            if (selector instanceof HTMLElement && selector.getClientRects().length > 0) return true
            await new Promise(resolve => setTimeout(resolve, 25))
          }
          return false
        })()`)) as boolean
        if (!rightSelectorReady) {
          const state = await win.webContents.executeJavaScript(`({
            view: document.querySelector('[data-view][aria-current="page"]')?.getAttribute('data-view'),
            informationCollapsed: document.querySelector('.app-shell')?.dataset.informationCollapsed ?? null,
            islands: [...document.querySelectorAll('.workspace-island')].map(island => ({
              placement: island.dataset.placement, hidden: island.hidden, label: island.getAttribute('aria-label'),
            })),
          })`)
          throw new Error(`会话切换后右侧栏目未就绪：${JSON.stringify(state)}`)
        }
        await openRightPanel('file-outline-tasks')
        const hoverState = (await win.webContents.executeJavaScript(`(async () => {
          const tab = document.querySelector(${JSON.stringify(originalSelector)})
          const idle = tab.closest('.session-tab-shell')
          const selected = document.querySelector('.session-tab-shell[data-selected]')
          tab.focus()
          let state
          // 焦点与背景过渡随绘制帧更新，不能假定后台平台在固定 140ms 内完成。
          for (let attempt = 0; attempt < 80; attempt += 1) {
            const idleBackground = getComputedStyle(idle).backgroundColor
            const selectedBackground = getComputedStyle(selected).backgroundColor
            state = {
              ready: !idle.hasAttribute('data-selected') && document.activeElement === tab
                && idle.matches(':focus-within') && idleBackground !== 'rgba(0, 0, 0, 0)'
                && selectedBackground === 'rgba(0, 0, 0, 0)',
              focused: document.activeElement?.getAttribute('data-session-tab'),
              documentFocused: document.hasFocus(), focusWithin: idle.matches(':focus-within'),
              idleBackground, selectedBackground,
            }
            if (state.ready) return state
            await new Promise(resolve => setTimeout(resolve, 25))
          }
          return state
        })()`)) as { ready: boolean }
        if (!hoverState.ready)
          throw new Error('未选中标签缺少悬浮或焦点底色：' + JSON.stringify(hoverState))
        await clickTrustedElement(win, '.conversation-view-tabs [data-view="trajectory"]')
        await clickTrustedElement(win, originalSelector)
        const conversationRestored = (await win.webContents.executeJavaScript(
          `document.querySelector('[data-view="conversation"]')?.getAttribute('aria-current') === 'page' && document.querySelector('.main-island .composer-card') !== null`,
        )) as boolean
        await clickTrustedElement(win, otherSelector)
        const otherSessionRightRestored = (await win.webContents
          .executeJavaScript(`document.querySelector('[data-view="conversation"]')?.getAttribute('aria-current') === 'page'
          && document.querySelector('.right-island-tabs [aria-selected="true"]')?.getAttribute('aria-label') === '脚本'
          && document.querySelector('.info-island.file-info-island [data-project-tasks]') !== null`)) as boolean
        // 浮岛内的对话／轨迹选择属于各自实例，切换会话不会重置；后续验收需要对话视图。
        await clickTrustedElement(win, '.conversation-view-tabs [data-view="conversation"]')
        const liquidMotionCheck = win.webContents.executeJavaScript(`(async () => {
          const lens = document.querySelector('.session-tab-lens')
          const active = document.querySelector('.session-tab-shell[data-selected="true"]')
          const root = document.querySelector('.session-tab-glass')
          const fromX = lens.getBoundingClientRect().left - root.getBoundingClientRect().left
          const region = document.querySelector('.session-glass-filter [data-lens]')
          const materialBounds = document.querySelector('.session-tab-material').getBoundingClientRect()
          const refractionCenter = materialBounds.left + (Number(region.getAttribute('x')) + Number(region.getAttribute('width')) / 2) * materialBounds.width
          const motionCenterOffset = Math.abs(lens.getBoundingClientRect().left + lens.getBoundingClientRect().width / 2 - refractionCenter)
          // 使用同一坐标系的浮点几何，避免 Windows 分数缩放被 offsetLeft 的取整误差影响。
          const targetX = active.getBoundingClientRect().left - root.getBoundingClientRect().left
          // 按压缩放会改变透镜外沿；是否跟随标签应比较中心，最终静止边界仍在下方单独校验。
          const lensBounds = lens.getBoundingClientRect()
          const activeBounds = active.getBoundingClientRect()
          const centerOffset = Math.abs((lensBounds.left + lensBounds.right - activeBounds.left - activeBounds.right) / 2)
          let continued = lens.dataset.moving === 'true' || centerOffset <= 1
          let maximumHeight = lens.getBoundingClientRect().height
          let minimumWidth = lens.getBoundingClientRect().width
          const deadline = performance.now() + 2000
          while (performance.now() < deadline) {
            await new Promise(resolve => requestAnimationFrame(resolve))
            // 按压回弹与移动标记在绘制帧更新；不能只用点击后的单次采样判定是否跟随。
            const currentLens = lens.getBoundingClientRect()
            const currentActive = active.getBoundingClientRect()
            continued ||= lens.dataset.moving === 'true'
              || Math.abs((currentLens.left + currentLens.right - currentActive.left - currentActive.right) / 2) <= 1
            maximumHeight = Math.max(maximumHeight, lens.getBoundingClientRect().height)
            minimumWidth = Math.min(minimumWidth, lens.getBoundingClientRect().width)
            if (lens.dataset.moving === undefined && Math.abs(lens.getBoundingClientRect().height - 26) < .1) break
          }
          const restrained = maximumHeight <= 29.2 && minimumWidth >= active.offsetWidth * .88
          const unscaledHitTarget = getComputedStyle(document.querySelector('.session-tab[aria-selected="true"]')).transform === 'none'
          const content = document.querySelector('.session-tab-content')
          const material = document.querySelector('.session-tab-material')
          const labelsSharp = getComputedStyle(content).filter === 'none'
            && Number(getComputedStyle(content).zIndex) > Number(getComputedStyle(lens).zIndex)
            && material.getAttribute('aria-hidden') === 'true' && !material.contains(active)
          const ready = continued && restrained && motionCenterOffset <= 1.5 && unscaledHitTarget && labelsSharp && lens.dataset.moving === undefined
            && document.querySelectorAll('.session-tab-lens').length === 1
            && document.querySelectorAll('.session-glass-filter feDisplacementMap').length === 3
            && getComputedStyle(material).filter !== 'none'
            && Math.abs(lens.getBoundingClientRect().height - 26) < .1
            && Math.abs(lens.getBoundingClientRect().width - active.offsetWidth) <= 1
            && Math.abs(lens.getBoundingClientRect().left - active.getBoundingClientRect().left) <= 1
          return { ready, labelsSharp, continued, maximumHeight, minimumWidth, motionCenterOffset, fromX, targetX, centerOffset,
            restingHeight: lens.getBoundingClientRect().height,
            alignment: lens.getBoundingClientRect().left - active.getBoundingClientRect().left }
        })()`) as Promise<{
          ready: boolean
          labelsSharp: boolean
          continued: boolean
          maximumHeight: number
          minimumWidth: number
          motionCenterOffset: number
          fromX: number
          targetX: number
          restingHeight: number
          alignment: number
        }>
        writeFileSync(
          verificationArtifactPath('verify-session-tabs-moving.png'),
          (await captureVerifiedPage(win)).toPNG(),
        )
        const liquidMotionState = await liquidMotionCheck
        await verifyTabEdgeMotion(win)
        const pressPoint = (await win.webContents.executeJavaScript(`(() => {
          const rect = document.querySelector('.session-tab[aria-selected="true"]').getBoundingClientRect()
          return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
        })()`)) as { x: number; y: number }
        let longPressReady = false
        win.webContents.sendInputEvent({
          type: 'mouseDown',
          ...pressPoint,
          button: 'left',
          clickCount: 1,
        })
        try {
          await new Promise(resolve => {
            setTimeout(resolve, 400)
          })
          longPressReady = (await win.webContents.executeJavaScript(`(() => {
            const lens = document.querySelector('.session-tab-lens')
            const height = lens.getBoundingClientRect().height
            return lens.dataset.pressed === 'true' && height >= 25 && height <= 27
              && document.querySelectorAll('.session-tab-lens').length === 1
              && getComputedStyle(document.querySelector('.session-tab-shell[data-selected]')).backgroundColor === 'rgba(0, 0, 0, 0)'
          })()`)) as boolean
          writeFileSync(
            verificationArtifactPath('verify-session-tabs-pressed.png'),
            (await captureVerifiedPage(win)).toPNG(),
          )
        } finally {
          win.webContents.sendInputEvent({
            type: 'mouseUp',
            ...pressPoint,
            button: 'left',
            clickCount: 1,
          })
        }
        await new Promise(resolve => {
          setTimeout(resolve, 350)
        })
        const liquidMotionReady = liquidMotionState.ready && longPressReady
        console.log('desktop-shell-verify-local: liquid-motion-geometry', liquidMotionState)
        const peerSessionConversationReady = (await win.webContents.executeJavaScript(
          `document.querySelector('[data-view="conversation"]')?.getAttribute('aria-current') === 'page' && document.querySelector('.main-island .composer-card') !== null`,
        )) as boolean
        const expandedTabsReady = (await win.webContents.executeJavaScript(`(() => {
          const chrome = document.querySelector('.session-chrome')
          const lens = document.querySelector('.session-tab-lens')
          const bar = document.querySelector('.session-tabs')
          const active = document.querySelector('.session-tab[aria-selected="true"]')
          const items = document.querySelector('.session-tab-items')
          const search = document.querySelector('.session-search-trigger')
          if (!(chrome instanceof HTMLElement) || !(lens instanceof HTMLElement) || !(bar instanceof HTMLElement) || !(items instanceof HTMLElement)) return false
          const rect = lens.getBoundingClientRect(), barRect = bar.getBoundingClientRect(), chromeRect = chrome.getBoundingClientRect()
          const border = getComputedStyle(lens)
          return chrome.getAttribute('aria-hidden') === 'false' && !chrome.inert && chrome.offsetHeight === 32
            && search instanceof HTMLButtonElement && document.querySelector('.project-focus').contains(search)
            && document.querySelectorAll('.session-search-trigger').length === 1
            && search.getBoundingClientRect().right < barRect.left
            && Math.abs(rect.top - chromeRect.top - 3) <= 1
            && Math.abs(chromeRect.bottom - rect.bottom - 3) <= 1
            && bar.querySelectorAll('.session-tab-group[aria-label]').length === 1
            && document.querySelector('.session-group-switcher') === null
            && [...bar.querySelectorAll('.session-tab-shell')].every(tab => tab.closest('.session-tab-group') !== null && tab.getBoundingClientRect().width >= 96)
            // 150% 缩放会将 1 CSS px 的描边取整为 1 物理像素，计算样式因此是 2/3 px。
            && ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'].every(side =>
              Math.abs(Number.parseFloat(border[side]) * devicePixelRatio - Math.max(1, Math.floor(devicePixelRatio))) < .1)
            && getComputedStyle(bar).getPropertyValue('-webkit-app-region') === 'drag'
            && getComputedStyle(items).getPropertyValue('-webkit-app-region') === 'no-drag'
            && items.offsetHeight === 26 && items.contains(active)
            && getComputedStyle(active).getPropertyValue('-webkit-app-region') !== 'drag'
        })()`)) as boolean
        await seedComposerReadings(win, peerSession, frame => {
          win.webContents.send(HOST_CHANNELS.sessionFrame, frame)
        })
        if (
          !(await win.webContents.executeJavaScript(
            'document.querySelector("[data-composer-readings]") !== null',
          ))
        ) {
          throw new Error('右栏展开时也应保留底部会话仪表盘')
        }
        writeFileSync(
          verificationArtifactPath('verify-session-tabs.png'),
          (await captureVerifiedPage(win)).toPNG(),
        )
        const tabTheme = nativeTheme.themeSource
        const tabSize = win.getSize()
        const tabMinimumSize = win.getMinimumSize()
        try {
          nativeTheme.themeSource = 'light'
          await new Promise(resolve => {
            setTimeout(resolve, 100)
          })
          await verifyWindowControls(win, false)
          writeFileSync(
            verificationArtifactPath('verify-session-tabs-light.png'),
            (await captureVerifiedPage(win)).toPNG(),
          )
          nativeTheme.themeSource = 'dark'
          win.setSize(1_440, 900)
          await win.webContents.executeJavaScript(
            'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
          )
          await new Promise(resolve => {
            setTimeout(resolve, 100)
          })
          await verifyWindowControls(win, false)
          writeFileSync(
            verificationArtifactPath('verify-session-tabs-dark-large.png'),
            (await captureVerifiedPage(win)).toPNG(),
          )
          win.setSize(900, 600)
          const resizedTab = (await win.webContents.executeJavaScript(`(async () => {
            const deadline = performance.now() + 2000
            let state
            do {
              await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
              const lens = document.querySelector('.session-tab-lens').getBoundingClientRect()
              const active = document.querySelector('.session-tab-shell[data-selected="true"]').getBoundingClientRect()
              state = { viewport: innerWidth, left: lens.left, width: lens.width, targetLeft: active.left, targetWidth: active.width,
                // Windows 在 150% 缩放下将原生尺寸取整，900 DIP 请求可能得到 901 DIP。
                ready: Math.abs(innerWidth - 900) <= 1 && Math.abs(lens.left - active.left) <= 1 && Math.abs(lens.width - active.width) <= 1 }
            } while (!state.ready && performance.now() < deadline)
            return state
          })()`)) as {
            ready: boolean
            viewport: number
            left: number
            width: number
            targetLeft: number
            targetWidth: number
          }
          console.log('desktop-shell-verify-local: liquid-resize', resizedTab)
          await new Promise(resolve => {
            setTimeout(resolve, 100)
          })
          // 读数条不再随窗口宽度消失：900px 下右栏被布局隐藏，读数条照常显示；
          // dock 宽于文字降级阈值，此时应保持图标加文字的完整形态。
          const narrowReadings = (await win.webContents.executeJavaScript(`(() => {
            const hud = document.querySelector('[data-composer-readings]')
            if (!(hud instanceof HTMLElement)) return false
            const label = hud.querySelector('span')
            return label !== null && getComputedStyle(label).display !== 'none'
          })()`)) as boolean
          if (!narrowReadings) throw new Error('窄窗口应照常显示完整的底部会话读数')
          await verifyWindowControls(win, false)
          writeFileSync(
            verificationArtifactPath('verify-session-tabs-narrow.png'),
            (await captureVerifiedPage(win)).toPNG(),
          )
          if (!resizedTab.ready) throw new Error('缩小窗口后会话透镜未对齐当前标签')
          // 停靠 DevTools 时页面可窄于应用最小窗口，复现 725px 下的项目与搜索挤压。
          win.setMinimumSize(725, 600)
          win.setSize(725, 800)
          const compactProject = (await win.webContents.executeJavaScript(`(async () => {
            // 原生窗口缩放异步抵达 renderer，等布局满足条件后再验收最终几何。
            const deadline = performance.now() + 2000
            let state
            do {
              await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
              const sidebar = document.querySelector('.sidebar-island').getBoundingClientRect()
              const project = document.querySelector('.project-selector')
              const search = document.querySelector('.sidebar-island .session-search-trigger').getBoundingClientRect()
              const railWidth = Number.parseFloat(getComputedStyle(document.querySelector('.app-shell')).getPropertyValue('--mode-rail-width'))
              state = { viewport: innerWidth, sidebarWidth: sidebar.width, projectDisplay: getComputedStyle(project).display,
                searchWidth: search.width, searchLeft: search.left, sidebarLeft: sidebar.left, searchRight: search.right, sidebarRight: sidebar.right,
                // 150% 缩放下窗口最小尺寸与客户区分别取整，725 DIP 请求实测可得到 727 DIP。
                ready: Math.abs(innerWidth - 725) <= 2 && sidebar.width <= railWidth + 3 && getComputedStyle(project).display === 'none'
                  && search.width >= 28 && search.left >= sidebar.left && search.right <= sidebar.right }
            } while (!state.ready && performance.now() < deadline)
            return state
          })()`)) as {
            ready: boolean
            viewport: number
            sidebarWidth: number
            projectDisplay: string
            searchWidth: number
          }
          console.log('desktop-shell-verify-local: compact-project', compactProject)
          if (!compactProject.ready)
            throw new Error('725px 窄视口应隐藏项目选择器并完整保留搜索入口')
          writeFileSync(
            verificationArtifactPath('verify-session-tabs-compact.png'),
            (await captureVerifiedPage(win)).toPNG(),
          )
        } finally {
          nativeTheme.themeSource = tabTheme
          win.setMinimumSize(tabMinimumSize[0] ?? 900, tabMinimumSize[1] ?? 600)
          win.setSize(tabSize[0] ?? 1_280, tabSize[1] ?? 800)
          await new Promise(resolve => {
            setTimeout(resolve, 220)
          })
        }
        let reducedMotionReady = false
        let accessibleMaterialReady = true
        if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3')
        try {
          await emulateVerificationMedia(win, [{ name: 'prefers-reduced-motion', value: 'reduce' }])
          await clickTrustedElement(win, originalSelector)
          reducedMotionReady = (await win.webContents.executeJavaScript(`(() => {
            const lens = document.querySelector('.session-tab-lens')
            const active = document.querySelector('.session-tab-shell[data-selected="true"]')
            return matchMedia('(prefers-reduced-motion: reduce)').matches
              && lens.getAnimations().every(animation => animation.playState !== 'running')
              && lens.dataset.moving === undefined
              && Math.abs(lens.getBoundingClientRect().height - 26) < .1
              && Math.abs(lens.getBoundingClientRect().left - active.getBoundingClientRect().left) <= 1
          })()`)) as boolean
          // 对话与轨迹在聊天浮岛内切换，模式栏已不包含轨迹入口。
          const originalView = (await win.webContents.executeJavaScript(
            `document.querySelector('.conversation-view-tabs [aria-selected="true"]').dataset.view`,
          )) as string
          await clickTrustedElement(
            win,
            originalView === 'trajectory'
              ? '.conversation-view-tabs [data-view="conversation"]'
              : '.conversation-view-tabs [data-view="trajectory"]',
          )
          reducedMotionReady =
            reducedMotionReady &&
            ((await win.webContents.executeJavaScript(`(() => {
            const targets = document.querySelectorAll('.app-shell, .session-chrome, .view-tabs__indicator, .main-island > :not([hidden])')
            return [...targets].every(element => element.getAnimations().every(animation => animation.playState !== 'running'))
              && getComputedStyle(document.querySelector('.app-shell')).transitionDuration === '0s'
          })()`)) as boolean)
          await clickTrustedElement(win, `.conversation-view-tabs [data-view="${originalView}"]`)
          /* oxlint-disable no-await-in-loop -- 媒体设置作用于同一渲染进程，必须串行验收。 */
          for (const [name, value] of [
            ['prefers-reduced-transparency', 'reduce'],
            ['prefers-contrast', 'more'],
            ['forced-colors', 'active'],
          ] as const) {
            await emulateVerificationMedia(win, [{ name, value }])
            accessibleMaterialReady =
              accessibleMaterialReady &&
              ((await win.webContents.executeJavaScript(`(() => {
              const active = document.querySelector('.session-tab-shell[data-selected="true"]')
              return getComputedStyle(document.querySelector('.session-tab-content')).filter === 'none'
                && getComputedStyle(document.querySelector('.session-tab-material')).filter === 'none'
                && getComputedStyle(document.querySelector('.session-tab-lens')).display === 'none'
                && Number.parseFloat(getComputedStyle(active).outlineWidth) * devicePixelRatio >= .99
            })()`)) as boolean)
          }
          /* oxlint-enable no-await-in-loop */
        } finally {
          await emulateVerificationMedia(win)
        }
        const sameTabGroup = (await win.webContents
          .executeJavaScript(`document.querySelector(${JSON.stringify(originalSelector)}).closest('.session-tab-group')
          === document.querySelector(${JSON.stringify(otherSelector)}).closest('.session-tab-group')`)) as boolean
        const expectedFirst = sameTabGroup ? otherSessionTab : originalSessionTab
        const expectedSecond = sameTabGroup ? originalSessionTab : otherSessionTab
        const dragDistance = (await win.webContents.executeJavaScript(`(() => {
          const from = document.querySelector(${JSON.stringify(originalSelector)}).getBoundingClientRect()
          const to = document.querySelector(${JSON.stringify(otherSelector)}).getBoundingClientRect()
          return to.left - from.left
        })()`)) as number
        await dragTrustedElementHorizontally(win, originalSelector, dragDistance)
        const reorderReady = (await win.webContents.executeJavaScript(`(() => {
          const tabs = [...document.querySelectorAll('.session-tab')]
          return tabs[0]?.dataset.sessionTab === ${JSON.stringify(expectedFirst)}
            && tabs[1]?.dataset.sessionTab === ${JSON.stringify(expectedSecond)}
            && document.querySelector(${JSON.stringify(originalSelector)}).getAttribute('aria-selected') === 'true'
            && document.querySelector('[data-reordering], [data-dragging]') === null
        })()`)) as boolean
        const cancelPoint = (await win.webContents.executeJavaScript(`(() => {
          const rect = document.querySelector(${JSON.stringify(originalSelector)}).getBoundingClientRect()
          return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
        })()`)) as { x: number; y: number }
        const cancelTargetX = Math.round(
          cancelPoint.x + (sameTabGroup ? -dragDistance : dragDistance),
        )
        win.webContents.sendInputEvent({ type: 'mouseMove', ...cancelPoint })
        win.webContents.sendInputEvent({
          type: 'mouseDown',
          ...cancelPoint,
          button: 'left',
          clickCount: 1,
        })
        win.webContents.sendInputEvent({ type: 'mouseMove', x: cancelTargetX, y: cancelPoint.y })
        const cancelStarted = (await win.webContents.executeJavaScript(`(async () => {
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
          return document.querySelector('.session-tab-glass')?.dataset.reordering === 'true'
        })()`)) as boolean
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
        win.webContents.sendInputEvent({
          type: 'mouseUp',
          x: cancelTargetX,
          y: cancelPoint.y,
          button: 'left',
          clickCount: 1,
        })
        const cancelRestored = (await win.webContents.executeJavaScript(`(async () => {
          await new Promise(resolve => requestAnimationFrame(resolve))
          const tabs = [...document.querySelectorAll('.session-tab')]
          return tabs[0]?.dataset.sessionTab === ${JSON.stringify(expectedFirst)}
            && tabs[1]?.dataset.sessionTab === ${JSON.stringify(expectedSecond)}
            && document.querySelector('[data-reordering], [data-dragging]') === null
        })()`)) as boolean
        const dragReady = reorderReady && cancelStarted && cancelRestored
        const readTabsFill = async () =>
          (await win.webContents.executeJavaScript(`(() => {
          const strip = document.querySelector('.session-tabs')
          const tabs = [...document.querySelectorAll('.session-tab-shell')]
          if (!(strip instanceof HTMLElement) || tabs.length !== 2) return false
          const style = getComputedStyle(strip)
          const contentWidth = strip.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight)
          return tabs.every(tab => Math.abs(tab.getBoundingClientRect().width - contentWidth / tabs.length) < 1)
            && Math.abs(tabs.reduce((total, tab) => total + tab.getBoundingClientRect().width, 0) - contentWidth) < 1
            && strip.scrollWidth <= strip.clientWidth + 1
        })()`)) as boolean
        const expandedTabsFill = await readTabsFill()
        await clickTrustedElement(win, '.panel-divider--navigation .panel-divider__capsule')
        // 布局切换会取消旧动画，验收只等待仍在完成的动画。
        await win.webContents
          .executeJavaScript(`Promise.all(document.querySelector('.app-shell').getAnimations({ subtree: true })
          .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))`)
        const collapsedTabsFill = await readTabsFill()
        await verifyWindowControls(win, false)
        await clickTrustedElement(win, '.panel-divider--navigation .panel-divider__capsule')
        await win.webContents
          .executeJavaScript(`Promise.all(document.querySelector('.app-shell').getAnimations({ subtree: true })
          .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))`)
        const tabsFillReady = expandedTabsFill && collapsedTabsFill
        let tabOverflowReady = false
        await win.webContents.executeJavaScript(
          `document.querySelector('.session-tabs-frame').style.flex = '0 0 180px'`,
        )
        try {
          const overflowStartReady = (await win.webContents.executeJavaScript(`(async () => {
            const deadline = performance.now() + 2000
            while (performance.now() < deadline) {
              await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
              const strip = document.querySelector('.session-tabs')
              const left = document.querySelector('.session-tab-scroll--left')
              const right = document.querySelector('.session-tab-scroll--right')
              const tabs = [...document.querySelectorAll('.session-tab-shell')]
              if (strip.scrollWidth > strip.clientWidth && !right.hidden) {
                strip.scrollLeft = 0
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
                return left.disabled && !right.disabled && tabs.every(tab => tab.getBoundingClientRect().width >= 96)
                  && getComputedStyle(strip).borderLeftWidth === '0px'
                  && getComputedStyle(document.querySelector('.session-tabs-frame')).borderRadius === '16px'
              }
            }
            return false
          })()`)) as boolean
          if (overflowStartReady) {
            await clickTrustedElement(win, '.session-tab-scroll--right')
            const overflowEndReady = (await win.webContents.executeJavaScript(`(async () => {
              const deadline = performance.now() + 1000
              while (performance.now() < deadline) {
                await new Promise(resolve => requestAnimationFrame(resolve))
                const strip = document.querySelector('.session-tabs')
                const left = document.querySelector('.session-tab-scroll--left')
                const right = document.querySelector('.session-tab-scroll--right')
                if (strip.scrollLeft > 1 && !left.disabled && right.disabled) return true
              }
              return false
            })()`)) as boolean
            if (overflowEndReady) {
              await clickTrustedElement(win, '.session-tab-scroll--left')
              tabOverflowReady = (await win.webContents.executeJavaScript(`(async () => {
                const deadline = performance.now() + 1000
                while (performance.now() < deadline) {
                  await new Promise(resolve => requestAnimationFrame(resolve))
                  const strip = document.querySelector('.session-tabs')
                  const left = document.querySelector('.session-tab-scroll--left')
                  if (strip.scrollLeft <= 1 && left.disabled) return true
                }
                return false
              })()`)) as boolean
            }
          }
        } finally {
          await win.webContents.executeJavaScript(
            `document.querySelector('.session-tabs-frame').style.removeProperty('flex')`,
          )
          await new Promise(resolve => {
            setTimeout(resolve, 120)
          })
        }
        const overflowScheme = settingsStore.read().colorScheme
        try {
          await verifyTabOverflow(
            win,
            scheme => {
              settingsController.publish(settingsStore.update({ colorScheme: scheme }))
            },
            async name => {
              writeFileSync(
                verificationArtifactPath(name),
                (await captureVerifiedPage(win)).toPNG(),
              )
            },
          )
        } finally {
          settingsController.publish(settingsStore.update({ colorScheme: overflowScheme }))
        }
        console.log('desktop-shell-verify-local: liquid-motion', {
          liquidMotionReady,
          reducedMotionReady,
          accessibleMaterialReady,
          expandedTabsReady,
          tabsFillReady,
          tabOverflowReady,
          expandedTabsFill,
          collapsedTabsFill,
          conversationRestored,
          otherSessionRightRestored,
          peerSessionConversationReady,
          reorderReady,
          cancelStarted,
          cancelRestored,
        })
        await clickTrustedElement(win, otherSelector)
        await clickTrustedElement(
          win,
          '.session-tab-shell[data-selected="true"] .session-tab-close',
        )
        await win.webContents.executeJavaScript(`(async () => {
            await Promise.all(document.querySelector('.app-shell').getAnimations({ subtree: true })
              .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
              .map(animation => animation.finished.catch(() => {})))
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
          })()`)
        sessionTabsReady =
          liquidMotionReady &&
          reducedMotionReady &&
          accessibleMaterialReady &&
          dragReady &&
          expandedTabsReady &&
          tabsFillReady &&
          tabOverflowReady &&
          conversationRestored &&
          otherSessionRightRestored &&
          peerSessionConversationReady &&
          ((await win.webContents.executeJavaScript(`(() => {
          const active = document.querySelector('.session-tab[aria-selected="true"]')
          const chrome = document.querySelector('.session-chrome')
          const shell = document.querySelector('.app-shell')
          const main = document.querySelector('.main-island')
          const floating = document.querySelector('[data-floating-tab-actions="true"]')
          const overviewButtons = document.querySelectorAll('[aria-label="平铺选择标签"]')
          const newTabButtons = document.querySelectorAll('[aria-label="新建工作标签"]')
          const tools = main?.querySelector('.conversation-tools')
          const blur = main?.querySelector('[data-top-progressive-blur="true"]')
          const windowEdge = Number.parseFloat(getComputedStyle(shell).getPropertyValue('--window-edge'))
          const floatingRect = floating instanceof HTMLElement ? floating.getBoundingClientRect() : null
          const toolsRect = tools instanceof HTMLElement ? tools.getBoundingClientRect() : null
          return active?.getAttribute('data-session-tab') === ${JSON.stringify(originalSessionTab)}
            && document.querySelector(${JSON.stringify(otherSelector)}) === null
            && document.querySelectorAll('.session-tab').length === 1
            && shell?.dataset.sessionTabsVisible === 'false'
            && chrome instanceof HTMLElement && chrome.getAttribute('aria-hidden') === 'true' && chrome.inert
            && getComputedStyle(chrome).visibility === 'hidden'
            && document.querySelectorAll('.session-search-trigger').length === 1
            && document.querySelector('.project-focus .session-search-trigger') instanceof HTMLButtonElement
            && Math.abs(main.getBoundingClientRect().top - windowEdge) <= 1
            && floating instanceof HTMLElement && floating.checkVisibility()
            && overviewButtons.length === 1 && newTabButtons.length === 1
            && floating.contains(overviewButtons[0]) && floating.contains(newTabButtons[0])
            && (toolsRect === null || (floatingRect !== null
              && toolsRect.top >= floatingRect.bottom
              && Math.abs(toolsRect.right - (floatingRect.right - 4)) <= 1))
            && blur instanceof HTMLElement && getComputedStyle(blur).pointerEvents === 'none'
            && (document.activeElement === newTabButtons[0]
              || document.activeElement === document.querySelector('.session-search-trigger'))
            && document.querySelector('.main-island .composer-card') !== null
        })()`)) as boolean)
      }
    }
    console.log('desktop-shell-verify-local: session-tabs', sessionTabsReady)
    await verifyWindowControls(win, false)
    if (originalSessionTab !== null)
      await seedComposerReadings(win, originalSessionTab, frame => {
        win.webContents.send(HOST_CHANNELS.sessionFrame, frame)
      })

    const readPanelGeometry = async () =>
      win.webContents.executeJavaScript(`(async () => {
      // 折叠现在会经过连续过渡，几何断言只读取过渡完成后的布局。
      await Promise.all(document.querySelector('.app-shell').getAnimations({ subtree: true })
        .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map(animation => animation.finished.catch(() => {})))
      const navigation = document.querySelector('.navigation-island')
      const main = document.querySelector('.main-island')
      const information = document.querySelector('.info-island')
      const composer = document.querySelector('.composer-card')
      const composerReadings = document.querySelector('[data-composer-readings="true"]')
      const composerFooter = composer?.querySelector('footer')
      const body = main?.querySelector('.workspace-view')
      const bodyRect = body?.getBoundingClientRect()
      const dock = composer?.closest('.composer-dock')
      const sidebarRect = document.querySelector('.sidebar-island')?.getBoundingClientRect()
      const navigationButton = document.querySelector('.panel-divider--navigation .panel-divider__capsule')
      const informationButton = document.querySelector('.panel-divider--information .panel-divider__capsule')
      const composerDivider = document.querySelector('.panel-divider--composer')
      const resizeCorner = document.querySelector('.panel-resize-corner')
      const viewTabs = document.querySelector('.view-tabs')
      if (!(navigation instanceof HTMLElement)
        || !(main instanceof HTMLElement)
        || !(information instanceof HTMLElement)
        || !(composer instanceof HTMLElement)
        || !(composerFooter instanceof HTMLElement)
        || !(composerDivider instanceof HTMLElement)
        || !(navigationButton instanceof HTMLButtonElement)
        || !(informationButton instanceof HTMLButtonElement)
        || !(viewTabs instanceof HTMLElement)) return null
      const navigationRect = navigation.getBoundingClientRect()
      const mainRect = main.getBoundingClientRect()
      const informationRect = information.getBoundingClientRect()
      const composerRect = composer.getBoundingClientRect()
      const composerFooterRect = composerFooter.getBoundingClientRect()
      const composerReadingsRect = composerReadings?.getBoundingClientRect() ?? null
      // 读数条可见时它才是输入区的底：卡片底边距浮岛底边多出读数条与它到卡片的间距。
      const composerRowSpan = composerReadingsRect === null
        ? 0
        : composerReadingsRect.height + Math.max(0, composerReadingsRect.top - composerRect.bottom)
      const viewTabsRect = viewTabs.getBoundingClientRect()
      const composerDividerRect = composerDivider.getBoundingClientRect()
      const resizeCornerRect = resizeCorner instanceof HTMLElement
        ? resizeCorner.getBoundingClientRect()
        : null
      return {
        viewportWidth: innerWidth,
        navigationVisible: getComputedStyle(navigation).display !== 'none' && getComputedStyle(navigation).visibility !== 'hidden',
        informationVisible: getComputedStyle(information).display !== 'none' && getComputedStyle(information).visibility !== 'hidden',
        navigationWidth: navigationRect.width,
        informationWidth: informationRect.width,
        mainHeight: mainRect.height,
        composerHeight: composerRect.height,
        mainLeft: mainRect.left,
        mainRight: mainRect.right,
        composerLeft: composerRect.left,
        composerRight: composerRect.right,
        navigationGap: mainRect.left - sidebarRect.right,
        informationGap: informationRect.left - mainRect.right,
        composerGap: composerRect.top - bodyRect.bottom,
        composerOverlayReady: body instanceof HTMLElement && dock instanceof HTMLElement
          && Math.abs(bodyRect.bottom - mainRect.bottom) <= 1
          && Number.parseFloat(getComputedStyle(body).paddingBottom)
            >= dock.getBoundingClientRect().height + Number.parseFloat(getComputedStyle(dock).marginBottom) + 23,
        composerTop: composerRect.top,
        composerContained: main.contains(composer)
          && composerRect.left >= mainRect.left + 17
          && composerRect.right <= mainRect.right - 17
          && Math.abs(mainRect.bottom - composerRect.bottom - composerRowSpan - (composerReadingsRect === null ? 17 : 7)) <= 1
          && Math.abs(composerRect.left + composerRect.right - mainRect.left - mainRect.right) <= 1
          && bodyRect.height >= 220,
        composerFooterBottomGap: composerRect.bottom - composerFooterRect.bottom,
        composerReadingsSpan: composerRowSpan,
        composerDividerTop: composerDividerRect.top,
        composerDividerBottom: composerDividerRect.bottom,
        resizeCornerCenterX: resizeCornerRect === null ? null : resizeCornerRect.left + resizeCornerRect.width / 2,
        resizeCornerCenterY: resizeCornerRect === null ? null : resizeCornerRect.top + resizeCornerRect.height / 2,
        resizeCornerOpacity: resizeCorner instanceof HTMLElement
          ? Number(getComputedStyle(resizeCorner).opacity)
          : null,
        viewTabsLeft: viewTabsRect.left,
        viewTabsRight: viewTabsRect.right,
        viewTabsWidth: viewTabsRect.width,
        navigationLabel: navigationButton.getAttribute('aria-label'),
        informationLabel: informationButton.getAttribute('aria-label'),
      }
    })()`) as Promise<null | {
        viewportWidth: number
        navigationVisible: boolean
        informationVisible: boolean
        navigationWidth: number
        informationWidth: number
        mainHeight: number
        composerHeight: number
        mainLeft: number
        mainRight: number
        composerLeft: number
        composerRight: number
        navigationGap: number
        informationGap: number
        composerTop: number
        composerContained: boolean
        composerGap: number
        composerOverlayReady: boolean
        composerFooterBottomGap: number
        composerReadingsSpan: number
        composerDividerTop: number
        composerDividerBottom: number
        resizeCornerCenterX: number | null
        resizeCornerCenterY: number | null
        resizeCornerOpacity: number | null
        viewTabsLeft: number
        viewTabsRight: number
        viewTabsWidth: number
        navigationLabel: string | null
        informationLabel: string | null
      }>
    const panelGeometryInitial = await readPanelGeometry()
    await clickTrustedElement(win, '.panel-divider--navigation .panel-divider__capsule')
    const navigationCollapsed = await readPanelGeometry()
    const collapsedHeaderBounds = (await win.webContents.executeJavaScript(`(() => {
      const sidebar = document.querySelector('.sidebar-island').getBoundingClientRect()
      const chrome = document.querySelector('.session-chrome').getBoundingClientRect()
      const search = document.querySelector('.session-search-trigger').getBoundingClientRect()
      const railElement = document.querySelector('.mode-rail')
      const rail = railElement.getBoundingClientRect()
      const settings = document.querySelector('#open-settings').getBoundingClientRect()
      const shellStyle = getComputedStyle(document.querySelector('.app-shell'))
      return {
        sidebarTop: sidebar.top,
        sidebarBottom: sidebar.bottom,
        chromeTop: chrome.top,
        chromeBottom: chrome.bottom,
        searchTop: search.top,
        searchBottom: search.bottom,
        searchRight: search.right,
        chromeRight: chrome.right,
        railTop: rail.top,
        railBottom: rail.bottom,
        railLeft: rail.left,
        railRight: rail.right,
        railWidth: rail.width,
        modeRailWidth: Number.parseFloat(shellStyle.getPropertyValue('--mode-rail-width')),
        railBackground: getComputedStyle(railElement).backgroundColor,
        settingsLeft: settings.left,
        settingsRight: settings.right,
        settingsBottom: settings.bottom,
      }
    })()`)) as {
      sidebarTop: number
      sidebarBottom: number
      chromeTop: number
      chromeBottom: number
      searchTop: number
      searchBottom: number
      searchRight: number
      chromeRight: number
      railTop: number
      railBottom: number
      railLeft: number
      railRight: number
      railWidth: number
      modeRailWidth: number
      railBackground: string
      settingsLeft: number
      settingsRight: number
      settingsBottom: number
    }
    if (
      readTrafficLightLayout(win).some(
        button =>
          button.y < collapsedHeaderBounds.chromeTop ||
          button.y + button.height > collapsedHeaderBounds.chromeBottom ||
          Math.abs(
            button.y +
              button.height / 2 -
              (collapsedHeaderBounds.chromeTop + collapsedHeaderBounds.chromeBottom) / 2,
          ) > 1,
      ) ||
      collapsedHeaderBounds.sidebarTop <= collapsedHeaderBounds.chromeBottom ||
      collapsedHeaderBounds.searchTop < collapsedHeaderBounds.chromeTop ||
      collapsedHeaderBounds.searchBottom > collapsedHeaderBounds.chromeBottom ||
      collapsedHeaderBounds.searchRight > collapsedHeaderBounds.chromeRight ||
      !nearPanelValue(collapsedHeaderBounds.railTop, collapsedHeaderBounds.sidebarTop) ||
      !nearPanelValue(collapsedHeaderBounds.railBottom, collapsedHeaderBounds.sidebarBottom) ||
      !nearPanelValue(collapsedHeaderBounds.railWidth, collapsedHeaderBounds.modeRailWidth) ||
      collapsedHeaderBounds.railBackground === 'rgba(0, 0, 0, 0)' ||
      !nearPanelValue(
        collapsedHeaderBounds.settingsBottom,
        collapsedHeaderBounds.railBottom - 10,
      ) ||
      !nearPanelValue(
        collapsedHeaderBounds.settingsLeft + collapsedHeaderBounds.settingsRight,
        collapsedHeaderBounds.railLeft + collapsedHeaderBounds.railRight,
      )
    )
      throw new Error('收起侧栏后红绿灯、菜单宽度、设置位置或栏位材质不正确')
    writeFileSync(
      verificationArtifactPath('verify-sidebar-collapsed.png'),
      (await captureVerifiedPage(win)).toPNG(),
    )
    const navigationCollapsedReady =
      navigationCollapsed !== null &&
      !navigationCollapsed.navigationVisible &&
      nearPanelValue(
        navigationCollapsed.mainLeft,
        initial.windowEdge + initial.modeRailWidth + 2 + initial.windowGap,
      ) &&
      navigationCollapsed.composerContained &&
      navigationCollapsed.navigationLabel === '展开项目面板'
    await clickTrustedElement(win, '.panel-divider--navigation .panel-divider__capsule')
    const navigationExpanded = await readPanelGeometry()
    const navigationExpandedReady =
      navigationExpanded !== null &&
      navigationExpanded.navigationVisible &&
      nearPanelValue(navigationExpanded.navigationWidth, 260) &&
      nearPanelValue(navigationExpanded.navigationGap, initial.windowGap) &&
      navigationExpanded.navigationLabel === '收起项目面板'

    await clickTrustedElement(win, '.panel-divider--information .panel-divider__capsule')
    const informationCollapsed = await readPanelGeometry()
    const informationCollapsedReady =
      informationCollapsed !== null &&
      !informationCollapsed.informationVisible &&
      nearPanelValue(
        informationCollapsed.mainRight,
        informationCollapsed.viewportWidth - initial.windowEdge,
      ) &&
      informationCollapsed.composerContained &&
      nearPanelValue(informationCollapsed.composerReadingsSpan, 26) &&
      informationCollapsed.informationLabel === '展开右侧浮岛'
    await clickTrustedElement(win, '.panel-divider--information .panel-divider__capsule')
    const informationExpanded = await readPanelGeometry()
    const informationExpandedReady =
      informationExpanded !== null &&
      informationExpanded.informationVisible &&
      nearPanelValue(informationExpanded.composerReadingsSpan, 26) &&
      nearPanelValue(informationExpanded.informationWidth, 260) &&
      nearPanelValue(informationExpanded.informationGap, initial.windowGap) &&
      informationExpanded.informationLabel === '收起右侧浮岛'
    const panelCollapseReady =
      navigationCollapsedReady &&
      navigationExpandedReady &&
      informationCollapsedReady &&
      informationExpandedReady

    const navigationDragPoint = (await win.webContents.executeJavaScript(`(() => {
      const divider = document.querySelector('.panel-divider--navigation')
      if (!(divider instanceof HTMLElement)) return null
      const rect = divider.getBoundingClientRect()
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + 28) }
    })()`)) as null | { x: number; y: number }
    if (navigationDragPoint === null) throw new Error('找不到导航面板拖动热区')
    win.webContents.sendInputEvent({ type: 'mouseMove', ...navigationDragPoint })
    win.webContents.sendInputEvent({
      type: 'mouseDown',
      ...navigationDragPoint,
      button: 'left',
      clickCount: 1,
    })
    win.webContents.sendInputEvent({
      type: 'mouseMove',
      x: navigationDragPoint.x + 36,
      y: navigationDragPoint.y,
      movementX: 36,
      movementY: 0,
    })
    await new Promise(resolve => {
      setTimeout(resolve, 60)
    })
    const dragLineActive = (await win.webContents.executeJavaScript(`(async () => {
      const divider = document.querySelector('.panel-divider--navigation')
      const sidebar = document.querySelector('.sidebar-island')
      if (!(divider instanceof HTMLElement) || !(sidebar instanceof HTMLElement)) return false
      await Promise.all(divider.getAnimations({ subtree: true }).map(animation => animation.finished))
      const line = getComputedStyle(divider, '::before')
      const dividerRect = divider.getBoundingClientRect()
      const islandRadius = Number.parseFloat(getComputedStyle(sidebar).borderBottomLeftRadius)
      return divider.classList.contains('is-resizing')
        && Number(line.opacity) === 1
        && new DOMMatrixReadOnly(line.transform).d === 1
        && Math.abs(Number.parseFloat(line.width) - dividerRect.width) <= 0.1
        && Number.parseFloat(line.top) >= islandRadius - 1
        && Number.parseFloat(line.bottom) >= islandRadius - 1
    })()`)) as boolean
    win.webContents.sendInputEvent({
      type: 'mouseUp',
      x: navigationDragPoint.x + 36,
      y: navigationDragPoint.y,
      button: 'left',
      clickCount: 1,
    })
    win.webContents.sendInputEvent({
      type: 'mouseMove',
      x: navigationDragPoint.x + 72,
      y: navigationDragPoint.y,
    })
    await new Promise(resolve => {
      setTimeout(resolve, 100)
    })
    const dragLineCleared = (await win.webContents.executeJavaScript(`(async () => {
      const divider = document.querySelector('.panel-divider--navigation')
      if (!(divider instanceof HTMLElement)) return false
      await Promise.all(divider.getAnimations({ subtree: true }).map(animation => animation.finished))
      return !divider.classList.contains('is-resizing')
        && Number(getComputedStyle(divider, '::before').opacity) === 0
        && new DOMMatrixReadOnly(getComputedStyle(divider, '::before').transform).d === 0
    })()`)) as boolean
    const panelDragLineReady = dragLineActive && dragLineCleared
    const navigationResized = await readPanelGeometry()
    await win.webContents.executeJavaScript(`(() => {
      const divider = document.querySelector('.panel-divider--navigation')
      if (!(divider instanceof HTMLElement)) return false
      divider.focus()
      return divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    })()`)
    await new Promise(resolve => {
      setTimeout(resolve, 80)
    })
    const navigationReset = await readPanelGeometry()
    await dragTrustedElementHorizontally(win, '.panel-divider--information', -36)
    const informationResized = await readPanelGeometry()
    await win.webContents.executeJavaScript(`(() => {
      const divider = document.querySelector('.panel-divider--information')
      if (!(divider instanceof HTMLElement)) return false
      divider.focus()
      return divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    })()`)
    await new Promise(resolve => {
      setTimeout(resolve, 80)
    })
    const informationReset = await readPanelGeometry()
    const composerDragPoint = (await win.webContents.executeJavaScript(`(() => {
      const divider = document.querySelector('.panel-divider--composer')
      if (!(divider instanceof HTMLElement)) return null
      const rect = divider.getBoundingClientRect()
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
    })()`)) as null | { x: number; y: number }
    if (composerDragPoint === null) throw new Error('找不到输入区高度拖动热区')
    win.webContents.sendInputEvent({ type: 'mouseMove', ...composerDragPoint })
    win.webContents.sendInputEvent({
      type: 'mouseDown',
      ...composerDragPoint,
      button: 'left',
      clickCount: 1,
    })
    win.webContents.sendInputEvent({
      type: 'mouseMove',
      x: composerDragPoint.x,
      y: composerDragPoint.y - 36,
      movementX: 0,
      movementY: -36,
    })
    win.webContents.sendInputEvent({
      type: 'mouseUp',
      x: composerDragPoint.x,
      y: composerDragPoint.y - 36,
      button: 'left',
      clickCount: 1,
    })
    await new Promise(resolve => {
      setTimeout(resolve, 100)
    })
    const composerResized = await readPanelGeometry()
    await win.webContents.executeJavaScript(`(() => {
      const divider = document.querySelector('.panel-divider--composer')
      if (!(divider instanceof HTMLElement)) return false
      divider.focus()
      return divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    })()`)
    await new Promise(resolve => {
      setTimeout(resolve, 80)
    })
    const composerReset = await readPanelGeometry()

    const cornerDragPoint = (await win.webContents.executeJavaScript(`(() => {
      const handle = document.querySelector('.panel-resize-corner')
      if (!(handle instanceof HTMLElement)) return null
      const rect = handle.getBoundingClientRect()
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
    })()`)) as null | { x: number; y: number }
    if (cornerDragPoint === null) throw new Error('找不到二维布局拖动柄')
    win.webContents.sendInputEvent({ type: 'mouseMove', ...cornerDragPoint })
    win.webContents.sendInputEvent({
      type: 'mouseDown',
      ...cornerDragPoint,
      button: 'left',
      clickCount: 1,
    })
    win.webContents.sendInputEvent({
      type: 'mouseMove',
      x: cornerDragPoint.x - 30,
      y: cornerDragPoint.y - 30,
      movementX: -30,
      movementY: -30,
    })
    win.webContents.sendInputEvent({
      type: 'mouseUp',
      x: cornerDragPoint.x - 30,
      y: cornerDragPoint.y - 30,
      button: 'left',
      clickCount: 1,
    })
    await new Promise(resolve => {
      setTimeout(resolve, 100)
    })
    const cornerResized = await readPanelGeometry()
    await win.webContents.executeJavaScript(`(() => {
      const handle = document.querySelector('.panel-resize-corner')
      if (!(handle instanceof HTMLElement)) return false
      handle.focus()
      return handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    })()`)
    await new Promise(resolve => {
      setTimeout(resolve, 80)
    })
    const cornerReset = await readPanelGeometry()
    const panelResizeReady =
      navigationResized !== null &&
      navigationResized.navigationWidth >= 295 &&
      navigationResized.navigationWidth <= 297 &&
      nearPanelValue(navigationResized.navigationGap, initial.windowGap) &&
      navigationReset !== null &&
      nearPanelValue(navigationReset.navigationWidth, 260) &&
      informationResized !== null &&
      informationResized.informationWidth >= 295 &&
      informationResized.informationWidth <= 297 &&
      nearPanelValue(informationResized.informationGap, initial.windowGap) &&
      panelGeometryInitial !== null &&
      panelGeometryInitial.resizeCornerOpacity === 0 &&
      nearPanelValue(informationResized.viewTabsLeft, panelGeometryInitial.viewTabsLeft) &&
      nearPanelValue(informationResized.viewTabsRight, panelGeometryInitial.viewTabsRight) &&
      nearPanelValue(informationResized.viewTabsWidth, panelGeometryInitial.viewTabsWidth) &&
      informationReset !== null &&
      nearPanelValue(informationReset.informationWidth, 260) &&
      nearPanelValue(informationReset.viewTabsWidth, panelGeometryInitial.viewTabsWidth) &&
      composerResized !== null &&
      composerResized.composerHeight >= 147 &&
      composerResized.composerHeight <= 149 &&
      composerResized.composerOverlayReady &&
      composerResized.composerContained &&
      nearPanelValue(composerResized.composerFooterBottomGap, 10) &&
      composerResized.mainHeight >= 220 &&
      composerReset !== null &&
      nearPanelValue(composerReset.composerHeight, 112) &&
      nearPanelValue(composerReset.composerDividerTop, composerReset.composerTop - 5) &&
      cornerResized !== null &&
      cornerResized.informationWidth >= 289 &&
      cornerResized.informationWidth <= 291 &&
      cornerResized.composerHeight >= 141 &&
      cornerResized.composerHeight <= 143 &&
      cornerResized.resizeCornerCenterX !== null &&
      cornerResized.resizeCornerCenterY !== null &&
      nearPanelValue(
        cornerResized.resizeCornerCenterX,
        cornerResized.mainRight + initial.windowGap / 2,
      ) &&
      nearPanelValue(cornerResized.resizeCornerCenterY, cornerResized.composerTop - 2.5) &&
      cornerReset !== null &&
      nearPanelValue(cornerReset.informationWidth, 260) &&
      nearPanelValue(cornerReset.composerHeight, 112)

    console.log('desktop-shell-verify-local: panel-geometry', {
      navigationCollapsedReady,
      navigationExpandedReady,
      informationCollapsedReady,
      informationExpandedReady,
      navigationResized,
      informationResized,
      composerResized,
      composerReset,
      cornerResized,
      cornerReset,
    })
    const composerVisibilityReady = (await win.webContents.executeJavaScript(`(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const near = (left, right) => Math.abs(left - right) <= 1
      const validateNonConversation = async view => {
        const tab = document.querySelector('[data-view="' + view + '"]')
        if (!(tab instanceof HTMLButtonElement)) return false
        tab.click()
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const shell = document.querySelector('.app-shell')
          const main = document.querySelector('.main-island:not([hidden])')
          const active = document.querySelector('[data-view="' + view + '"]')
          if (shell instanceof HTMLElement
            && main instanceof HTMLElement
            && active instanceof HTMLButtonElement
            && active.classList.contains('is-active')) {
            const edge = Number.parseFloat(getComputedStyle(shell).getPropertyValue('--window-edge'))
            const composers = [...document.querySelectorAll('.composer-card')]
            const ready = composers.length > 0
              && composers.every(composer => {
                const panel = composer.closest('.work-tab-panel, .workspace-island')
                return !composer.checkVisibility() && panel?.hidden === true && panel.inert === true
              })
              && ![...document.querySelectorAll('.panel-divider--composer, .panel-resize-corner')]
                .some(node => node.checkVisibility())
              && shell.dataset.composerVisible !== 'true'
              && Number.isFinite(edge)
              && near(main.getBoundingClientRect().bottom, innerHeight - edge)
            if (ready) return true
          }
          await sleep(25)
        }
        return false
      }
      const hidden = []
      for (const view of ['changes', 'files']) {
        hidden.push(await validateNonConversation(view))
      }
      const conversation = document.querySelector('[data-view="conversation"]')
      if (!(conversation instanceof HTMLButtonElement)) return false
      conversation.click()
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const shell = document.querySelector('.app-shell')
        const composer = document.querySelector('.main-island .composer-card')
        if (shell instanceof HTMLElement
          && composer instanceof HTMLElement
          && shell.dataset.composerVisible === 'true'
          && document.querySelector('.panel-divider--composer') instanceof HTMLElement
          && document.querySelector('.panel-resize-corner') instanceof HTMLElement) return hidden.every(Boolean)
        await sleep(25)
      }
      return false
    })()`)) as boolean

    const fileView = (await win.webContents.executeJavaScript(`(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const waitFor = async predicate => {
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const value = predicate()
          if (value) return value
          await sleep(25)
        }
        return null
      }
      document.querySelector('[data-view="files"]')?.click()
      const readme = await waitFor(() => [...document.querySelectorAll('[aria-label="项目文件树"] .tree-row')]
        .find(element => element.getAttribute('title') === 'README.md'))
      const fileTreeReady = readme instanceof HTMLButtonElement
      if (readme instanceof HTMLButtonElement) readme.click()
      let fileViewer = await waitFor(() => document.querySelector('.code-editor[data-language-ready="true"] .cm-line'))
      if (!(fileViewer instanceof HTMLElement)) {
        const currentReadme = [...document.querySelectorAll('[aria-label="项目文件树"] .tree-row')]
          .find(element => element.getAttribute('title') === 'README.md')
        if (currentReadme instanceof HTMLButtonElement) currentReadme.click()
        fileViewer = await waitFor(() => document.querySelector('.code-editor[data-language-ready="true"] .cm-line'))
      }
      const fileViewerReady = fileViewer instanceof HTMLElement
      const quickOpenTrigger = document.querySelector('button[aria-label^="快速打开文件"]')
      if (quickOpenTrigger instanceof HTMLButtonElement) quickOpenTrigger.click()
      const quickOpenInput = await waitFor(() => document.querySelector('.quick-open-input input'))
      if (quickOpenInput instanceof HTMLInputElement) {
        const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        valueSetter?.call(quickOpenInput, 'README')
        quickOpenInput.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'README' }))
      }
      const quickOpenResult = await waitFor(() => document.querySelector('.quick-open-results button'))
      if (quickOpenResult instanceof HTMLButtonElement) quickOpenResult.click()
      const quickOpenClosed = await waitFor(() => document.querySelector('.quick-open-dialog') === null)
      const quickOpenReady = quickOpenTrigger instanceof HTMLButtonElement
        && quickOpenInput instanceof HTMLInputElement
        && quickOpenResult instanceof HTMLButtonElement
        && quickOpenClosed === true
      const deepSegments = [
        'src',
        ...Array.from({ length: 39 }, (_, index) => 'level-' + String(index + 1).padStart(2, '0')),
      ]
      let deepRelativePath = ''
      let deepestDirectory = null
      let deepDirectoriesReady = true
      for (const segment of deepSegments) {
        deepRelativePath = deepRelativePath === '' ? segment : deepRelativePath + '/' + segment
        const directoryPath = deepRelativePath
        const directory = await waitFor(() => [...document.querySelectorAll('[aria-label="项目文件树"] .tree-row')]
          .find(element => element.getAttribute('title') === directoryPath))
        if (!(directory instanceof HTMLButtonElement)) {
          deepDirectoriesReady = false
          break
        }
        directory.click()
        deepestDirectory = directory
      }
      const deepFilePath = deepRelativePath
        + '/DeepWorkspaceControllerWithAnIntentionallyLongNameForHorizontalTreeVerification.java'
      let deepFile = await waitFor(() => [...document.querySelectorAll('[aria-label="项目文件树"] .tree-row')]
        .find(element => element.getAttribute('title') === deepFilePath))
      const fileTree = document.querySelector('[aria-label="项目文件树"] .file-tree')
      let deepFileTreeReady = false
      let syntaxHighlightingReady = false
      let fileCursorReady = false
      let fileCursorDetails = null
      let fileTabsReady = false
      if (deepDirectoriesReady
        && deepestDirectory instanceof HTMLButtonElement
        && deepFile instanceof HTMLButtonElement
        && fileTree instanceof HTMLElement) {
        fileTree.scrollLeft = fileTree.scrollWidth
        const expandedScrollLeft = fileTree.scrollLeft
        deepestDirectory.click()
        const collapsed = await waitFor(() => deepestDirectory?.getAttribute('aria-expanded') === 'false')
        const collapsedScrollLeft = fileTree.scrollLeft
        deepestDirectory.click()
        deepFile = await waitFor(() => [...document.querySelectorAll('[aria-label="项目文件树"] .tree-row')]
          .find(element => element.getAttribute('title') === deepFilePath))
        if (deepFile instanceof HTMLButtonElement) deepFile.click()
        const selected = await waitFor(() => [...document.querySelectorAll('[aria-label="项目文件树"] .tree-row[aria-current="page"]')]
          .find(element => element.getAttribute('title') === deepFilePath))
        const selectedIcon = selected?.querySelector('[data-icon="code"]')
        const selectedName = selected?.querySelector('.tree-row__name')
        deepFileTreeReady = collapsed === true
          && fileTree.scrollWidth >= fileTree.clientWidth * 3
          && expandedScrollLeft > 0
          && collapsedScrollLeft > 0
          && selected instanceof HTMLButtonElement
          && selected.getBoundingClientRect().width >= fileTree.clientWidth
          && selectedIcon?.textContent === 'J'
          && selectedName instanceof HTMLElement
          && getComputedStyle(selectedName).textOverflow === 'clip'
        // 文件树选择会先更新，编辑器还可能短暂显示旧文档；等待目标语言与实际高亮渲染。
        const codeEditor = await waitFor(() => {
          const candidate = document.querySelector('.code-editor[data-language="java"][data-language-ready="true"]')
          return candidate instanceof HTMLElement && ['.tok-keyword', '.tok-type', '.tok-string', '.tok-comment']
            .every(selector => candidate.querySelector(selector) instanceof HTMLElement) ? candidate : null
        })
        const editor = codeEditor?.querySelector('.cm-editor')
        const content = codeEditor?.querySelector('.cm-content')
        const keyword = codeEditor?.querySelector('.tok-keyword')
        const type = codeEditor?.querySelector('.tok-type')
        const string = codeEditor?.querySelector('.tok-string')
        const comment = codeEditor?.querySelector('.tok-comment')
        if (codeEditor instanceof HTMLElement
          && editor instanceof HTMLElement
          && content instanceof HTMLElement
          && keyword instanceof HTMLElement
          && type instanceof HTMLElement
          && string instanceof HTMLElement
          && comment instanceof HTMLElement) {
          content.focus()
          // CodeMirror 先接收 DOM 焦点，再异步更新聚焦类与光标；存在节点不代表光标已绘制。
          const cursor = await waitFor(() => {
            const candidate = editor.querySelector('.cm-cursor-primary')
            return candidate instanceof HTMLElement && editor.classList.contains('cm-focused')
              && getComputedStyle(candidate).display === 'block'
              && candidate.getBoundingClientRect().height > 0 ? candidate : null
          }) ?? editor.querySelector('.cm-cursor-primary')
          const root = document.documentElement
          const originalScheme = root.getAttribute('data-color-scheme')
          root.setAttribute('data-color-scheme', 'dark')
          const darkKeyword = getComputedStyle(keyword).color
          const darkText = getComputedStyle(content).color
          const darkBackground = getComputedStyle(editor).backgroundColor
          const darkCursor = cursor instanceof HTMLElement ? getComputedStyle(cursor).borderLeftColor : ''
          root.setAttribute('data-color-scheme', 'light')
          const lightKeyword = getComputedStyle(keyword).color
          const lightText = getComputedStyle(content).color
          const lightBackground = getComputedStyle(editor).backgroundColor
          const lightCursor = cursor instanceof HTMLElement ? getComputedStyle(cursor).borderLeftColor : ''
          fileCursorDetails = cursor instanceof HTMLElement ? {
            focused: editor.classList.contains('cm-focused'),
            contentFocused: document.activeElement === content,
            display: getComputedStyle(cursor).display,
            height: cursor.getBoundingClientRect().height,
            borderWidth: getComputedStyle(cursor).borderLeftWidth,
            darkCursor,
            lightCursor,
          } : { missing: true }
          fileCursorReady = cursor instanceof HTMLElement
            && editor.classList.contains('cm-focused')
            && getComputedStyle(cursor).display === 'block'
            && cursor.getBoundingClientRect().height > 0
            && parseFloat(getComputedStyle(cursor).borderLeftWidth) >= 1.5
            && darkCursor === 'rgb(244, 246, 250)'
            && lightCursor === 'rgb(24, 26, 31)'
          if (originalScheme === null) root.removeAttribute('data-color-scheme')
          else root.setAttribute('data-color-scheme', originalScheme)
          syntaxHighlightingReady = darkKeyword !== darkText
            && lightKeyword !== lightText
            && darkKeyword !== lightKeyword
            && darkBackground === 'rgb(21, 23, 27)'
            && lightBackground === 'rgb(251, 251, 252)'
            && codeEditor.querySelectorAll('.cm-line').length < 500
            && document.querySelector('.code-lines') === null
        }
        const breadcrumbReady = document.querySelector('.viewer-header') === null
          && document.querySelector('.file-tab-bar') === null
          && document.querySelector('.work-tab-panel:not([hidden]) .code-viewer')?.getAttribute('data-file-path') === deepFilePath
          && document.querySelector('.work-tab-panel:not([hidden]) .file-breadcrumb')?.getAttribute('title') === deepFilePath
          && document.querySelector('.work-tab-panel:not([hidden]) .file-statusbar') !== null
        const pin = [...document.querySelectorAll('.session-tab-shell[data-kind="file"] [role="tab"]')]
          .find(button => button.getAttribute('title') === deepFilePath)
        if (pin instanceof HTMLButtonElement) pin.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
        const pinned = await waitFor(() => [...document.querySelectorAll('.session-tab-shell[data-kind="file"]')]
          .find(tab => tab.querySelector('[role="tab"]')?.getAttribute('title') === deepFilePath
            && tab.getAttribute('data-preview') !== 'true'))
        const currentReadme = [...document.querySelectorAll('[aria-label="项目文件树"] .tree-row')]
          .find(element => element.getAttribute('title') === 'README.md')
        if (currentReadme instanceof HTMLButtonElement) currentReadme.click()
        const preview = await waitFor(() => [...document.querySelectorAll('.session-tab-shell[data-kind="file"]')]
          .find(tab => tab.querySelector('[role="tab"]')?.getAttribute('title') === 'README.md'
            && tab.getAttribute('data-preview') === 'true'
            && tab.getAttribute('data-selected') === 'true'))
        const previewControlsTransparent = preview instanceof HTMLElement
          && [...preview.querySelectorAll('button')]
            .every(button => getComputedStyle(button).backgroundColor === 'rgba(0, 0, 0, 0)')
        const back = document.querySelector('.work-tab-panel:not([hidden]) button[aria-label="返回上一个文件"]')
        if (back instanceof HTMLButtonElement) back.click()
        const returned = await waitFor(() => [...document.querySelectorAll('.session-tab-shell[data-kind="file"]')]
          .find(tab => tab.querySelector('[role="tab"]')?.getAttribute('title') === deepFilePath
            && tab.getAttribute('data-selected') === 'true'))
        const forward = document.querySelector('.work-tab-panel:not([hidden]) button[aria-label="前进到下一个文件"]')
        const historyControlsTransparent = back instanceof HTMLButtonElement
          && forward instanceof HTMLButtonElement
          && [back, forward]
            .every(button => getComputedStyle(button).backgroundColor === 'rgba(0, 0, 0, 0)')
        if (forward instanceof HTMLButtonElement) forward.click()
        const forwarded = await waitFor(() => [...document.querySelectorAll('.session-tab-shell[data-kind="file"]')]
          .find(tab => tab.querySelector('[role="tab"]')?.getAttribute('title') === 'README.md'
            && tab.getAttribute('data-selected') === 'true'))
        const closePreview = document.querySelector('button[aria-label="关闭 README.md"]')
        if (closePreview instanceof HTMLButtonElement) closePreview.click()
        const closedToRecent = await waitFor(() => document.querySelectorAll('.session-tab-shell[data-kind="file"]').length === 1
          && document.querySelector('.session-tab-shell[data-kind="file"][data-selected="true"] [role="tab"]')?.getAttribute('title')
            === deepFilePath)
        fileTabsReady = breadcrumbReady
          && pinned instanceof HTMLElement
          && preview instanceof HTMLElement
          && previewControlsTransparent
          && back instanceof HTMLButtonElement
          && returned instanceof HTMLElement
          && forward instanceof HTMLButtonElement
          && historyControlsTransparent
          && forwarded instanceof HTMLElement
          && closePreview instanceof HTMLButtonElement
          && closedToRecent === true
      }
      const largeImage = [...document.querySelectorAll('[aria-label="项目文件树"] .tree-row')]
        .find(element => element.getAttribute('title') === 'large-preview.png')
      if (largeImage instanceof HTMLButtonElement) largeImage.click()
      const imageViewer = await waitFor(() => document.querySelector('.image-viewer img'))
      const imageViewerReady = largeImage instanceof HTMLButtonElement
        && imageViewer instanceof HTMLImageElement
        && imageViewer.src.startsWith('data:image/png;base64,')
        && imageViewer.closest('.image-viewer')?.textContent?.includes('2,097,') === true
        && document.querySelector('.project-workspace-alert [role="alert"]') === null
      let fileWorkspacePersisted = false
      if (fileTree instanceof HTMLElement && globalThis.dshDesktop?.fileWorkspace !== undefined) {
        fileTree.scrollLeft = Math.min(37, Math.max(0, fileTree.scrollWidth - fileTree.clientWidth))
        fileTree.scrollTop = Math.min(29, Math.max(0, fileTree.scrollHeight - fileTree.clientHeight))
        fileTree.dispatchEvent(new Event('scroll', { bubbles: true }))
        await sleep(420)
        const projects = await globalThis.dshDesktop.projects.list()
        const projectId = Array.isArray(projects) && typeof projects[0]?.id === 'string'
          ? projects[0].id
          : null
        const state = projectId === null ? null : await globalThis.dshDesktop.fileWorkspace.read(projectId)
        fileWorkspacePersisted = state !== null
          && state.pinnedFiles.includes(deepFilePath)
          && state.previewFile === 'large-preview.png'
          && state.activeFile === 'large-preview.png'
          && state.expandedDirectories.includes(deepRelativePath)
          && state.treeScrollLeft === Math.round(fileTree.scrollLeft)
          && state.treeScrollTop === Math.round(fileTree.scrollTop)
      }
      return {
        fileTreeReady,
        deepFileTreeReady,
        fileViewerReady,
        fileTabsReady,
        fileWorkspacePersisted,
        quickOpenReady,
        syntaxHighlightingReady,
        fileCursorReady,
        fileCursorDetails,
        imageViewerReady,
      }
    })()`)) as {
      fileTreeReady: boolean
      deepFileTreeReady: boolean
      fileViewerReady: boolean
      fileTabsReady: boolean
      fileWorkspacePersisted: boolean
      quickOpenReady: boolean
      syntaxHighlightingReady: boolean
      fileCursorReady: boolean
      fileCursorDetails: unknown
      imageViewerReady: boolean
    }
    console.log('desktop-shell-verify-local: file-view', fileView)
    if (VERIFY_PROJECT === undefined) throw new Error('缺少隔离验收项目')
    const verificationReadmePath = join(VERIFY_PROJECT, 'README.md')
    const originalReadme = readFileSync(verificationReadmePath, 'utf8')
    const savedReadme = '# MyDSH 编辑器保存验收\n'
    const localDraft = '# MyDSH 本地未保存草稿\n'
    const externalReadme = '# MyDSH 外部修改验收\n'
    // 全选的修饰键按平台选择；保存使用按钮，避免与工作标签总览的快捷键冲突。
    const editorShortcutModifier: 'meta' | 'control' =
      process.platform === 'darwin' ? 'meta' : 'control'
    let fileEditorReady = false
    const replaceEditorContent = async (content: string): Promise<boolean> => {
      const focused = (await win.webContents.executeJavaScript(`(async () => {
        const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
        document.querySelector('[data-view="files"]')?.click()
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const readme = [...document.querySelectorAll('[aria-label="项目文件树"] .tree-row')]
            .find(element => element.getAttribute('title') === 'README.md')
          if (readme instanceof HTMLButtonElement) {
            readme.click()
            break
          }
          await sleep(25)
        }
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const editor = document.querySelector('.code-viewer[data-file-path="README.md"] .code-editor[data-language-ready="true"] .cm-content')
          if (editor instanceof HTMLElement) {
            editor.focus()
            return document.activeElement === editor
          }
          await sleep(25)
        }
        return false
      })()`)) as boolean
      if (!focused) return false
      win.webContents.sendInputEvent({
        type: 'keyDown',
        keyCode: 'A',
        modifiers: [editorShortcutModifier],
      })
      win.webContents.sendInputEvent({
        type: 'keyUp',
        keyCode: 'A',
        modifiers: [editorShortcutModifier],
      })
      await win.webContents.insertText(content)
      return (await win.webContents.executeJavaScript(`(async () => {
        const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
        for (let attempt = 0; attempt < 80; attempt += 1) {
          if (document.querySelector('.file-dirty-status')?.textContent?.trim() === '未保存') return true
          await sleep(25)
        }
        return false
      })()`)) as boolean
    }
    const saveFromEditor = () => clickTrustedElement(win, '.file-save-button')
    try {
      const draftReady = await replaceEditorContent(savedReadme)
      if (draftReady) await saveFromEditor()
      const diskSaved =
        draftReady &&
        (await waitForCondition(
          () => readFileSync(verificationReadmePath, 'utf8') === savedReadme,
          10_000,
        ))
      if (!diskSaved) {
        const view = await win.webContents.executeJavaScript(`(() => ({
          focused: document.activeElement?.outerHTML.slice(0, 300),
          content: document.querySelector('.code-editor .cm-content')?.textContent,
          status: document.querySelector('.file-dirty-status')?.textContent,
          saving: document.querySelector('.file-save-button')?.textContent,
          error: document.querySelector('.project-workspace-alert')?.textContent,
        }))()`)
        console.log('desktop-shell-verify-local: file-save-failure', {
          view,
          disk: readFileSync(verificationReadmePath, 'utf8'),
        })
      }
      const savedStateReady =
        diskSaved &&
        ((await win.webContents.executeJavaScript(`(async () => {
        const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
        for (let attempt = 0; attempt < 80; attempt += 1) {
          if (document.querySelector('.file-dirty-status') === null
            && document.querySelector('.file-conflict-panel') === null) return true
          await sleep(25)
        }
        return false
      })()`)) as boolean)
      const conflictDraftReady = savedStateReady && (await replaceEditorContent(localDraft))
      if (conflictDraftReady) {
        writeFileSync(verificationReadmePath, externalReadme, { mode: 0o600 })
        await saveFromEditor()
      }
      const conflictReady =
        conflictDraftReady &&
        ((await win.webContents.executeJavaScript(`(async () => {
        const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const panel = document.querySelector('.file-conflict-panel')
          if (panel instanceof HTMLElement
            && panel.textContent?.includes('文件已在磁盘上发生变化') === true
            && panel.textContent?.includes('重新载入') === true
            && panel.textContent?.includes('仍然覆盖') === true) return true
          await sleep(25)
        }
        return false
      })()`)) as boolean)
      const externalPreserved = readFileSync(verificationReadmePath, 'utf8') === externalReadme
      const reloadClicked =
        conflictReady &&
        ((await win.webContents.executeJavaScript(`(() => {
        const reload = [...document.querySelectorAll('.file-conflict-panel button')]
          .find(button => button.textContent?.trim() === '重新载入')
        if (!(reload instanceof HTMLButtonElement)) return false
        reload.click()
        return true
      })()`)) as boolean)
      const reloaded =
        reloadClicked &&
        ((await win.webContents.executeJavaScript(`(async () => {
        const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const content = document.querySelector('.code-viewer[data-file-path="README.md"] .cm-content')
          if (content instanceof HTMLElement
            && content.textContent?.includes('外部修改验收') === true
            && document.querySelector('.file-dirty-status') === null
            && document.querySelector('.file-conflict-panel') === null) return true
          await sleep(25)
        }
        return false
      })()`)) as boolean)
      fileEditorReady =
        draftReady &&
        diskSaved &&
        savedStateReady &&
        conflictDraftReady &&
        conflictReady &&
        externalPreserved &&
        reloaded
      console.log('desktop-shell-verify-local: file-editor-stages', {
        draftReady,
        diskSaved,
        savedStateReady,
        conflictDraftReady,
        conflictReady,
        externalPreserved,
        reloaded,
      })
    } finally {
      writeFileSync(verificationReadmePath, originalReadme, { mode: 0o600 })
    }
    console.log('desktop-shell-verify-local: file-editor', fileEditorReady)
    const guardedDraftReady = await replaceEditorContent('# MyDSH 未保存离开保护验收\n')
    await win.webContents.executeJavaScript(
      `document.documentElement.dataset.hostRecoveryAudit = 'pending'`,
    )
    const previousHostPid = supervisor.getState().diagnostics.pid
    const recovery = supervisor.retry()
    const disconnectedAlert = (await win.webContents.executeJavaScript(`(async () => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (document.querySelector('.project-workspace-alert')?.textContent?.includes('MyDSH 运行时不可用')) return true
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return false
    })()`)) as boolean
    const recoveredHost = await recovery
    await hostStateRender
    const hostRecoveryRetainsEditor =
      guardedDraftReady &&
      disconnectedAlert &&
      recoveredHost.kind === 'ready' &&
      recoveredHost.diagnostics.pid !== previousHostPid &&
      ((await win.webContents.executeJavaScript(`(async () => {
        try {
          for (let attempt = 0; attempt < 200; attempt += 1) {
            if (document.querySelector('.project-workspace-alert [role="alert"]') === null) {
              return document.documentElement.dataset.hostRecoveryAudit === 'pending'
                && document.querySelector('.file-dirty-status')?.textContent?.trim() === '未保存'
                && document.querySelector('.code-viewer[data-file-path="README.md"] .cm-content')?.textContent?.includes('未保存离开保护验收') === true
            }
            await new Promise(resolve => setTimeout(resolve, 25))
          }
          return false
        } finally {
          delete document.documentElement.dataset.hostRecoveryAudit
        }
      })()`)) as boolean)
    console.log('desktop-shell-verify-local: host-recovery-retains-editor', {
      ready: hostRecoveryRetainsEditor,
      guardedDraftReady,
      disconnectedAlert,
      runtimeState: recoveredHost.kind,
      processChanged: recoveredHost.diagnostics.pid !== previousHostPid,
      view: await win.webContents.executeJavaScript(`({
        alert: document.querySelector('.project-workspace-alert')?.textContent,
        dirty: document.querySelector('.file-dirty-status')?.textContent,
        editor: document.querySelector('.code-viewer[data-file-path="README.md"] .cm-content')?.textContent?.slice(0, 150),
      })`),
    })
    if (!hostRecoveryRetainsEditor)
      throw new Error('运行核心重启后的工作台与未保存文件恢复验收失败')
    const navigationGuardReady =
      guardedDraftReady &&
      ((await win.webContents.executeJavaScript(`(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      // 文件标签保留各自草稿；关闭标签才可能丢弃内容，必须走未保存确认。
      const close = document.querySelector('button[aria-label="关闭 README.md"]')
      if (!(close instanceof HTMLButtonElement)) return false
      close.click()
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const dialog = document.querySelector('.unsaved-dialog')
        const currentPath = document.querySelector('.work-tab-panel:not([hidden]) [data-file-path]')?.getAttribute('data-file-path')
        if (dialog instanceof HTMLDialogElement
          && dialog.open
          && dialog.textContent?.includes('关闭 README.md') === true
          && currentPath === 'README.md') {
          const cancel = [...dialog.querySelectorAll('footer button')]
            .find(button => button.textContent?.trim() === '取消')
          if (!(cancel instanceof HTMLButtonElement)) return false
          cancel.click()
          break
        }
        await sleep(25)
      }
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const dialog = document.querySelector('.unsaved-dialog')
        if (dialog instanceof HTMLDialogElement
          && !dialog.open
          && document.querySelector('.file-dirty-status')?.textContent?.trim() === '未保存'
          && document.querySelector('.work-tab-panel:not([hidden]) [data-file-path]')?.getAttribute('data-file-path') === 'README.md') return true
        await sleep(25)
      }
      return false
    })()`)) as boolean)
    if (navigationGuardReady) {
      await new Promise(resolve => {
        setTimeout(resolve, 100)
      })
      if (process.platform === 'win32')
        await clickTrustedElement(win, '[data-window-action="close"]')
      else win.close()
    }
    const closeGuardReady =
      navigationGuardReady &&
      ((await win.webContents.executeJavaScript(`(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const dialog = document.querySelector('.unsaved-dialog')
        if (dialog instanceof HTMLDialogElement
          && dialog.open
          && dialog.textContent?.includes('关闭 MyDSH') === true) {
          const cancel = [...dialog.querySelectorAll('footer button')]
            .find(button => button.textContent?.trim() === '取消')
          if (!(cancel instanceof HTMLButtonElement)) return false
          cancel.click()
          break
        }
        await sleep(25)
      }
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const dialog = document.querySelector('.unsaved-dialog')
        if (dialog instanceof HTMLDialogElement
          && !dialog.open
          && document.querySelector('.file-dirty-status')?.textContent?.trim() === '未保存') {
          const discard = [...document.querySelectorAll('.file-statusbar__actions button')]
            .find(button => button.checkVisibility() && button.getAttribute('aria-label') === '放弃文件更改')
          if (!(discard instanceof HTMLButtonElement)) return false
          discard.click()
          await sleep(40)
          return document.querySelector('.file-dirty-status') === null
        }
        await sleep(25)
      }
      return false
    })()`)) as boolean)
    const fileUnsavedGuardReady = navigationGuardReady && closeGuardReady && !win.isDestroyed()
    console.log('desktop-shell-verify-local: file-unsaved-guard', {
      ready: fileUnsavedGuardReady,
      navigationGuardReady,
      closeGuardReady,
      view: await win.webContents.executeJavaScript(
        `document.querySelector('[data-view][aria-current="page"]')?.getAttribute('data-view') ?? null`,
      ),
      state: await win.webContents.executeJavaScript(`({
        path: document.querySelector('[data-file-path]')?.getAttribute('data-file-path'),
        dialog: document.querySelector('.unsaved-dialog')?.textContent?.trim(),
        dialogOpen: document.querySelector('.unsaved-dialog')?.open,
        packageDisabled: [...document.querySelectorAll('[aria-label="项目文件树"] .tree-row')]
          .find(element => element.getAttribute('title') === 'package.json')?.disabled,
      })`),
    })
    if (!fileUnsavedGuardReady) throw new Error('核心恢复后的未保存文件保护验收失败')
    // 右侧栏目按当前模式列出可用项；点击前先记录实际选项，缺失时能直接归因。
    console.log(
      'desktop-shell-verify-local: right-island-options',
      await win.webContents.executeJavaScript(
        `[...document.querySelectorAll('[data-island-id]')].map(item => item.getAttribute('data-island-id'))`,
      ),
    )
    await openRightPanel('file-outline-tasks')
    const projectSearchOpened = (await win.webContents.executeJavaScript(`(() => {
      const trigger = document.querySelector('button[aria-label^="搜索项目内容"]')
      if (!(trigger instanceof HTMLButtonElement)) return false
      trigger.click()
      return true
    })()`)) as boolean
    const contentSearchState =
      projectSearchOpened &&
      ((await win.webContents.executeJavaScript(`(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      let input = null
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const candidate = document.querySelector('.project-search-controls input')
        if (candidate instanceof HTMLInputElement) {
          input = candidate
          break
        }
        await sleep(25)
      }
      if (!(input instanceof HTMLInputElement)) return { ready: false, resultPath: '', stage: 'search-input' }
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, '中文注释')
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '中文注释' }))
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const group = document.querySelector('.project-search-group')
        const result = group?.querySelector('button')
        const path = group?.querySelector('h3')?.textContent ?? ''
        if (result instanceof HTMLButtonElement
          && path.includes('DeepWorkspaceControllerWithAnIntentionallyLongNameForHorizontalTreeVerification.java')
          && result.textContent?.includes('中文注释') === true) {
          result.click()
          return { ready: true, resultPath: path, stage: 'complete' }
        }
        await sleep(25)
      }
      return { ready: false, resultPath: '', stage: 'search-result' }
    })()`)) as false | { ready: boolean; resultPath: string; stage: string })
    const contentSearchReady = contentSearchState !== false && contentSearchState.ready
    const projectTasksOnlyReady = (await win.webContents.executeJavaScript(`(() => {
      const panel = document.querySelector('.info-island.file-info-island')
      return panel?.querySelector('[data-project-tasks]') !== null
        && panel?.querySelector('.file-outline-panel') === null
        && document.querySelector('.right-island-tabs [aria-selected="true"]')?.getAttribute('aria-label') === '脚本'
    })()`)) as boolean
    console.log('desktop-shell-verify-local: content-search-tasks', {
      contentSearchReady,
      projectTasksOnlyReady,
      projectSearchOpened,
      contentSearchState,
    })
    if (!contentSearchReady) {
      writeFileSync(
        verificationArtifactPath('verify-content-search-failed.png'),
        (await captureVerifiedPage(win)).toPNG(),
      )
      console.log(
        'desktop-shell-verify-local: content-search-failure',
        await win.webContents.executeJavaScript(`(() => ({
        view: document.querySelector('[data-view][aria-current="page"]')?.getAttribute('data-view'),
        projectSearch: document.querySelector('.project-search-backdrop')?.textContent,
        leftPanel: document.querySelector('.navigation-island')?.textContent,
        dialogs: [...document.querySelectorAll('dialog[open], [role="dialog"]')].map(dialog => dialog.textContent?.slice(0, 400)),
      }))()`),
      )
      throw new Error('项目内容搜索验收失败：' + JSON.stringify(contentSearchState))
    }
    const projectTasksAudit = (await win.webContents.executeJavaScript(`(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const waitFor = async predicate => {
        for (let attempt = 0; attempt < 160; attempt += 1) {
          const value = predicate()
          if (value) return value
          await sleep(25)
        }
        return null
      }
      const setControlValue = (control, value) => {
        const prototype = control instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(control, value)
        control.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
      }
      const setField = (dialog, label, value) => {
        const fieldLabel = [...dialog.querySelectorAll('label')]
          .find(candidate => candidate.querySelector('span')?.textContent?.trim() === label)
        const control = fieldLabel?.querySelector('input, textarea')
        if (!(control instanceof HTMLInputElement) && !(control instanceof HTMLTextAreaElement)) return false
        setControlValue(control, value)
        return true
      }
      if (!document.querySelector('[data-island-id="file-outline-tasks"]')) document.querySelector('[aria-label="更多右侧栏目"][aria-haspopup="menu"]')?.click()
      const fileIsland = await waitFor(() => document.querySelector('[data-island-id="file-outline-tasks"]'))
      if (!(fileIsland instanceof HTMLButtonElement)) return { ready: false, stage: 'right-island-option' }
      if (fileIsland.getAttribute('aria-selected') !== 'true') fileIsland.click()
      const fileIslandReady = await waitFor(() => document.querySelector('.info-island.file-info-island [data-project-tasks="true"]'))
      if (!(fileIslandReady instanceof HTMLElement)) return { ready: false, stage: 'right-island-content' }
      const taskSuggestionsRemoved = fileIslandReady.querySelector('[data-task-suggestion]') === null
        && fileIslandReady.textContent?.includes('导入建议') !== true
      if (!taskSuggestionsRemoved) return { ready: false, stage: 'task-suggestions', taskSuggestionsRemoved }
      document.querySelector('[data-view="files"]')?.click()
      const create = await waitFor(() => document.querySelector('[data-project-tasks="true"] button[aria-label="新建脚本"]'))
      if (!(create instanceof HTMLButtonElement)) return { ready: false, stage: 'create-button' }
      create.click()
      const dialog = await waitFor(() => {
        const candidate = document.querySelector('dialog[aria-labelledby="project-task-editor-title"]')
        return candidate instanceof HTMLDialogElement && candidate.open ? candidate : null
      })
      if (!(dialog instanceof HTMLDialogElement)
        || !setField(dialog, '名称', '验收交互任务')
        || !setField(dialog, '可执行程序', ${JSON.stringify(process.platform === 'win32' ? 'pwsh.exe' : 'cat')})
        || !setField(dialog, '参数（每行一个）', ${JSON.stringify(process.platform === 'win32' ? ['-NoLogo', '-NoProfile', '-Command', 'while ($null -ne ($line = [Console]::ReadLine())) { [Console]::WriteLine($line) }'].join('\n') : '')})) return { ready: false, stage: 'create-form' }
      const save = await waitFor(() => [...dialog.querySelectorAll('button')]
        .find(button => button.textContent?.trim() === '保存脚本' && !button.disabled))
      if (!(save instanceof HTMLButtonElement)) return { ready: false, stage: 'create-save-enabled' }
      save.click()
      const row = await waitFor(() => document.querySelector('[data-task-name="验收交互任务"]'))
      if (!(row instanceof HTMLElement)) return {
        ready: false,
        stage: 'created-row',
        detail: document.querySelector('[data-project-tasks="true"] [role="alert"]')?.textContent?.trim()
          ?? document.querySelector('[data-project-tasks="true"]')?.textContent?.trim()
          ?? '项目任务面板不可用',
        dialogOpen: document.querySelector('dialog[aria-labelledby="project-task-editor-title"]')?.hasAttribute('open') === true,
      }
      const run = row.querySelector('button[aria-label="在终端运行 验收交互任务"]')
      if (!(run instanceof HTMLButtonElement)) return { ready: false, stage: 'run-button' }
      run.click()
      const terminal = await waitFor(() => {
        const view = document.querySelector('.work-tab-panel:not([hidden])')
        const host = view?.querySelector('[data-terminal-id]')
        const tabs = document.querySelectorAll('[data-work-tab="terminal"]')
        const taskTab = document.querySelector('[data-work-tab="terminal"]')
        const tree = document.querySelector('[aria-label="项目文件树"]')
        const info = document.querySelector('.info-island')
        const shell = document.querySelector('.app-shell')
        return view instanceof HTMLElement
          && host instanceof HTMLElement
          && host.dataset.terminalId !== undefined
          && tabs?.length === 1
          && taskTab?.textContent?.includes('验收交互任务') === true
          && tree instanceof HTMLElement
          && info instanceof HTMLElement
          && document.querySelector('.work-tab-panel:not([hidden])')?.contains(view)
          && taskTab?.getAttribute('aria-selected') === 'true'
          && shell?.getAttribute('data-information-collapsed') !== 'true'
          ? { terminalId: host.dataset.terminalId }
          : null
      })
      if (terminal === null) return { ready: false, stage: 'task-terminal-layout' }
      const outputReady = await new Promise(resolve => {
        const api = globalThis.dshDesktop?.terminal
        if (api === undefined) {
          resolve(false)
          return
        }
        let output = ''
        let settled = false
        const finish = value => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          stop()
          resolve(value)
        }
        const stop = api.onEvent(event => {
          if (event.type !== 'data' || event.terminalId !== terminal.terminalId) return
          output += event.data
          if (output.includes('PROJECT_TASK_PTY_OK')) finish(true)
        })
        const timeout = setTimeout(() => { finish(false) }, 4_000)
        api.write(terminal.terminalId, 'PROJECT_TASK_PTY_OK' + String.fromCharCode(13)).catch(() => { finish(false) })
      })
      if (!document.querySelector('[data-island-id="file-outline-tasks"]')) document.querySelector('[aria-label="更多右侧栏目"][aria-haspopup="menu"]')?.click()
      const taskIsland = await waitFor(() => document.querySelector('[data-island-id="file-outline-tasks"]'))
      if (!(taskIsland instanceof HTMLButtonElement)) return { ready: false, stage: 'rerun-island', outputReady }
      if (taskIsland.getAttribute('aria-selected') !== 'true') taskIsland.click()
      const rerun = await waitFor(() => document.querySelector('[data-task-name="验收交互任务"] button[aria-label="在终端运行 验收交互任务"]'))
      if (!(rerun instanceof HTMLButtonElement)) return { ready: false, stage: 'rerun-button', outputReady }
      rerun.click()
      const reused = await waitFor(() => document.querySelectorAll('[data-work-tab="terminal"]').length === 1
        && document.querySelector('.work-tab-panel:not([hidden]) [data-terminal-id]')?.getAttribute('data-terminal-id') === terminal.terminalId)
      const close = document.querySelector('.session-chrome button[aria-label="关闭终端 1"]')
      if (close instanceof HTMLButtonElement) close.click()
      const closed = await waitFor(() => document.querySelectorAll('.work-tab-panel [data-terminal-id]').length === 0
        && document.querySelectorAll('[data-work-tab="terminal"]').length === 0)
      document.querySelector('[data-view="files"]')?.click()
      const filesRestored = await waitFor(() => {
        const tab = document.querySelector('[data-work-tab="file"][aria-selected="true"]')
        const editor = document.querySelector('.work-tab-panel:not([hidden]) .code-editor')
        return tab && editor?.checkVisibility() ? editor : null
      })
      return outputReady === true && reused && closed === true && filesRestored instanceof HTMLElement
        ? { ready: true, stage: 'complete', taskSuggestionsRemoved }
        : { ready: false, stage: 'task-terminal-lifecycle', taskSuggestionsRemoved, outputReady, reused, closed: closed === true }
    })()`)) as {
      ready: boolean
      stage: string
      taskSuggestionsRemoved?: boolean
      detail?: string
      dialogOpen?: boolean
    }
    const projectTasksReady = projectTasksAudit.ready
    const taskSuggestionsRemoved = projectTasksAudit.taskSuggestionsRemoved === true
    console.log('desktop-shell-verify-local: project-tasks', projectTasksAudit)
    const fileCapture = 'verify-files.png'
    writeFileSync(verificationArtifactPath(fileCapture), (await captureVerifiedPage(win)).toPNG())
    const editorSize = win.getSize()
    const editorScheme = settingsStore.read().colorScheme
    try {
      win.setSize(1800, 1000)
      settingsController.publish(settingsStore.update({ colorScheme: 'light' }))
      await new Promise(resolve => {
        setTimeout(resolve, 180)
      })
      const editorLayout = (await win.webContents.executeJavaScript(`(() => {
        const viewer = document.querySelector('.work-tab-panel:not([hidden]) [data-file-path]')
        const editor = viewer?.querySelector('.cm-scroller')
        const status = viewer?.querySelector('.file-statusbar')
        return { viewer: !!viewer, fontSize: editor ? getComputedStyle(editor).fontSize : null,
          lineHeight: editor ? getComputedStyle(editor).lineHeight : null,
          noLegacyHeader: document.querySelector('.viewer-header, .file-tab-bar') === null,
          // 工作标签的过渡会产生浮点尾差，边界应比较同一物理像素中的位置。
          statusFits: !!status && Math.round(status.getBoundingClientRect().bottom * devicePixelRatio)
            <= Math.round(viewer.getBoundingClientRect().bottom * devicePixelRatio),
          statusBottom: status?.getBoundingClientRect().bottom ?? null,
          viewerBottom: viewer?.getBoundingClientRect().bottom ?? null,
          selectedKind: document.querySelector('.session-tab[aria-selected="true"]')?.dataset.workTab,
          noOverflow: document.documentElement.scrollWidth === innerWidth }
      })()`)) as {
        viewer: boolean
        fontSize: string | null
        lineHeight: string | null
        noLegacyHeader: boolean
        statusFits: boolean
        statusBottom: number | null
        viewerBottom: number | null
        selectedKind?: string
        noOverflow: boolean
      }
      console.log('desktop-shell-verify-local: editor-layout', editorLayout)
      writeFileSync(
        verificationArtifactPath('verify-editor-light-large.png'),
        (await captureVerifiedPage(win)).toPNG(),
      )
      if (
        !editorLayout.viewer ||
        editorLayout.fontSize !== '14px' ||
        editorLayout.lineHeight !== '22px' ||
        !editorLayout.noLegacyHeader ||
        !editorLayout.statusFits ||
        editorLayout.selectedKind !== 'file' ||
        !editorLayout.noOverflow
      )
        throw new Error(
          '放大窗口的编辑器排版、统一标签或底部状态栏异常：' + JSON.stringify(editorLayout),
        )
      await emulateVerificationMedia(win, [{ name: 'forced-colors', value: 'active' }])
      try {
        const forcedCursor = (await win.webContents.executeJavaScript(`(async () => {
          const editor = document.querySelector('.work-tab-panel:not([hidden]) .code-editor .cm-editor')
          const content = editor?.querySelector('.cm-content')
          if (!(editor instanceof HTMLElement) || !(content instanceof HTMLElement)) return false
          content.focus()
          for (let attempt = 0; attempt < 80; attempt += 1) {
            const cursor = editor.querySelector('.cm-cursor-primary')
            if (cursor instanceof HTMLElement && getComputedStyle(cursor).display === 'block') {
              return getComputedStyle(cursor).borderLeftColor !== getComputedStyle(editor).backgroundColor
                && parseFloat(getComputedStyle(cursor).borderLeftWidth) > 0
            }
            await new Promise(resolve => setTimeout(resolve, 25))
          }
          return false
        })()`)) as boolean
        if (!forcedCursor) throw new Error('强制色彩模式下编辑器光标不可见')
      } finally {
        await emulateVerificationMedia(win)
      }
    } finally {
      win.setSize(editorSize[0] ?? 1280, editorSize[1] ?? 800)
      settingsController.publish(settingsStore.update({ colorScheme: editorScheme }))
    }
    await openRightPanel('git-history')
    const sourceControlPrepared = (await win.webContents.executeJavaScript(`(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      document.querySelector('[data-view="changes"]')?.click()
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const navigation = document.querySelector('.source-control-navigation')
        const stage = document.querySelector('button[aria-label="暂存 scratch.md"]')
        if (navigation instanceof HTMLElement
          && navigation.getAttribute('aria-busy') === 'false'
          && stage instanceof HTMLButtonElement
          && !stage.disabled) return true
        await sleep(25)
      }
      return false
    })()`)) as boolean
    if (!sourceControlPrepared) throw new Error('隔离验收仓库没有出现可暂存的 scratch.md')
    await clickTrustedElement(win, 'button[aria-label="暂存 scratch.md"]')
    const sourceControlStaged = (await win.webContents.executeJavaScript(`(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const navigation = document.querySelector('.source-control-navigation')
        const unstage = document.querySelector('button[aria-label="取消暂存 scratch.md"]')
        if (navigation?.getAttribute('aria-busy') === 'false'
          && unstage instanceof HTMLButtonElement
          && !unstage.disabled) return true
        await sleep(25)
      }
      return false
    })()`)) as boolean
    if (!sourceControlStaged) throw new Error('单文件暂存没有进入暂存区')
    const gitGroupsReady = (await win.webContents.executeJavaScript(`(async () => {
      const wait = async predicate => {
        for (let attempt = 0; attempt < 80; attempt += 1) {
          if (predicate()) return true
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        return false
      }
      const panel = document.querySelector('.info-island .source-control-navigation')
      const staged = panel?.querySelector('[aria-label="暂存的更改"][aria-controls]')
      const working = panel?.querySelector('[aria-label="更改"][aria-controls]')
      if (!staged || !working) return false
      const stagedList = document.getElementById(staged.getAttribute('aria-controls'))
      const workingList = document.getElementById(working.getAttribute('aria-controls'))
      if (!await wait(() => stagedList?.querySelector('.change-row'))) return false
      const row = stagedList.querySelector('.change-row')
      staged.click()
      if (!await wait(() => stagedList.hidden && !stagedList.checkVisibility())) return false
      if (workingList.hidden || !panel.querySelector('[aria-label="取消暂存全部更改"]')) return false
      working.click()
      if (!await wait(() => workingList.hidden && !workingList.checkVisibility())) return false
      staged.click()
      working.click()
      if (!await wait(() => !stagedList.hidden && !workingList.hidden)) return false
      return stagedList.querySelector('.change-row') === row
        && staged.getAttribute('aria-expanded') === 'true' && working.getAttribute('aria-expanded') === 'true'
    })()`)) as boolean
    if (!gitGroupsReady) throw new Error('Git 暂存与更改分组未能独立收起和恢复')
    console.log('desktop-shell-verify-local: git-groups', { gitGroupsReady })
    const gitListScrollable = (await win.webContents.executeJavaScript(`(() => {
      const panel = document.querySelector('.navigation-island .scm-pane:first-child > .scm-pane-content')
      const list = panel?.querySelector('.change-list:not([hidden])')
      const row = list?.querySelector('.change-row')
      if (!(panel instanceof HTMLElement) || !(list instanceof HTMLElement) || !row) return false
      const originalTop = panel.scrollTop
      const copies = Array.from({ length: 40 }, () => row.cloneNode(true))
      try {
        list.append(...copies)
        panel.scrollTop = panel.scrollHeight
        return getComputedStyle(panel).overflowY === 'auto'
          && panel.scrollHeight > panel.clientHeight && panel.scrollTop > 0
      } finally {
        for (const copy of copies) copy.remove()
        panel.scrollTop = originalTop
      }
    })()`)) as boolean
    if (!gitListScrollable) throw new Error('Git 更改列表无法在内容超出时滚动')
    await verifySourceControlSections(win, async name => {
      writeFileSync(verificationArtifactPath(name), (await captureVerifiedPage(win)).toPNG())
    })
    await verifyGitAiPreparation(win)
    if (VERIFY_PROJECT === undefined) throw new Error('缺少隔离验收项目')
    await verifyBulkUnstage(win, async () => {
      const project = projects.find(item => item.cwd === VERIFY_PROJECT)
      if (!project) throw new Error('隔离验收项目尚未授权')
      writeFileSync(join(VERIFY_PROJECT, 'scratch.md'), '确认期间更新暂存内容\n')
      await runtimeCall('mydshWorkspace/call', {
        projectId: project.id,
        operation: 'gitStage',
        payload: { relativePaths: ['scratch.md'] },
      })
    })
    const sourceControlUnstaged = (await win.webContents.executeJavaScript(`(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const navigation = document.querySelector('.source-control-navigation')
        const stage = document.querySelector('button[aria-label="暂存 scratch.md"]')
        if (navigation?.getAttribute('aria-busy') === 'false'
          && stage instanceof HTMLButtonElement
          && !stage.disabled
          && navigation.querySelector('.scm-operation-notice')?.textContent?.includes('已取消全部暂存')) return true
        await sleep(25)
      }
      return false
    })()`)) as boolean
    if (!sourceControlUnstaged) throw new Error('确认取消全部暂存后未显示工作区更改和结果提示')
    await clickTrustedElement(win, 'button[aria-label="暂存 scratch.md"]')
    const sourceControlRestaged = (await win.webContents.executeJavaScript(`(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const unstage = document.querySelector('button[aria-label="取消暂存 scratch.md"]')
        if (unstage instanceof HTMLButtonElement && !unstage.disabled) return true
        await sleep(25)
      }
      return false
    })()`)) as boolean
    if (!sourceControlRestaged) throw new Error('单文件重新暂存失败')
    const verificationCommitMessage = '验收 Source Control 写路径'
    const commitMessageReady = (await win.webContents.executeJavaScript(`(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const input = document.querySelector('#scm-commit-message')
      if (!(input instanceof HTMLTextAreaElement)) return false
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      if (setter === undefined) return false
      setter.call(input, ${JSON.stringify(verificationCommitMessage)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const button = document.querySelector('.scm-commit-button')
        if (button instanceof HTMLButtonElement && !button.disabled
          && input.value === ${JSON.stringify(verificationCommitMessage)}) return true
        await sleep(25)
      }
      return false
    })()`)) as boolean
    if (!commitMessageReady) throw new Error('无法为隔离验收提交填写消息')
    const verificationIndexLock = join(VERIFY_PROJECT, '.git', 'index.lock')
    let sourceControlFailureReady = false
    writeFileSync(verificationIndexLock, 'MyDSH verifier\n', { mode: 0o600 })
    try {
      await clickTrustedElement(win, '.scm-commit-button')
      sourceControlFailureReady = (await win.webContents.executeJavaScript(`(async () => {
        const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const navigation = document.querySelector('.source-control-navigation')
          const alerts = [...document.querySelectorAll('.project-workspace-alert [role="alert"]')]
          const error = alerts[0]
          const input = document.querySelector('#scm-commit-message')
          const button = document.querySelector('.scm-commit-button')
          if (navigation?.getAttribute('aria-busy') === 'false'
            && alerts.length === 1
            && error?.textContent?.includes('Git 索引正被其他进程占用') === true
            && error?.textContent?.includes('Error invoking remote method') !== true
            && input instanceof HTMLTextAreaElement
            && input.value === ${JSON.stringify(verificationCommitMessage)}
            && button instanceof HTMLButtonElement
            && !button.disabled) {
            const close = error.querySelector('button[aria-label="关闭提示"]')
            if (!(close instanceof HTMLButtonElement)) return false
            close.click()
            await sleep(30)
            return document.querySelector('.project-workspace-alert [role="alert"]') === null
          }
          await sleep(25)
        }
        return false
      })()`)) as boolean
    } finally {
      rmSync(verificationIndexLock, { force: true })
    }
    console.log('desktop-shell-verify-local: source-control-failure', sourceControlFailureReady)
    await clickTrustedElement(win, '.scm-commit-button')
    const sourceControlWriteReady = (await win.webContents.executeJavaScript(`(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const navigation = document.querySelector('.source-control-navigation')
        const notice = document.querySelector('.scm-operation-notice')
        const input = document.querySelector('#scm-commit-message')
        if (navigation?.getAttribute('aria-busy') === 'false'
          && notice?.textContent?.includes('已创建本地 Git 提交') === true
          && input instanceof HTMLTextAreaElement
          && input.value === ''
          && document.querySelector('.info-island .git-review-panel') instanceof HTMLElement
          && document.querySelector('button[aria-label="暂存 scratch.md"]') === null
          && document.querySelector('button[aria-label="取消暂存 scratch.md"]') === null) return true
        await sleep(25)
      }
      return false
    })()`)) as boolean
    console.log('desktop-shell-verify-local: source-control-write', sourceControlWriteReady)
    const changedDirectory = join(
      VERIFY_PROJECT,
      'src',
      ...Array.from({ length: 39 }, (_, index) => `level-${String(index + 1).padStart(2, '0')}`),
    )
    writeFileSync(
      join(changedDirectory, 'ApplicationSecurityConfiguration.java'),
      'package verification;\npublic final class ApplicationSecurityConfiguration { private boolean enabled = true;\n' +
        Array.from({ length: 60 }, (_, index) => `  private int value${String(index)};`).join(
          '\n',
        ) +
        '\n}\n',
    )
    writeFileSync(join(changedDirectory, 'index.ts'), 'export const ready = false\n')
    await verifyGitRefresh(win)
    const sourceControlView = (await win.webContents.executeJavaScript(`(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const waitFor = async predicate => {
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const value = predicate()
          if (value) return value
          await sleep(25)
        }
        return null
      }
      const panel = document.querySelector('.info-island .git-review-panel')
      const toolbar = panel?.querySelector('.git-review-toolbar')
      const scope = toolbar?.querySelector('select[aria-label="Git 比较范围"]')
      const selectScope = value => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(scope, value)
        scope.dispatchEvent(new Event('change', { bubbles: true }))
      }
      const returnToWorking = async () => {
        if (!(scope instanceof HTMLSelectElement)) return null
        selectScope('turn')
        if (!await waitFor(() => panel.querySelector('.git-review-files'))) return null
        selectScope('working')
        return waitFor(() => panel.querySelector('.source-control-navigation[aria-busy="false"]'))
      }
      const right = panel?.querySelector('.source-control-navigation')
      const file = await waitFor(() => [...(right?.querySelectorAll('.change-file-open') ?? [])]
        .find(button => button.textContent.includes('ApplicationSecurityConfiguration.java')))
      const card = right?.firstElementChild
      const changes = right?.closest('.scm-pane-content')
      const gap = card?.getBoundingClientRect().top - changes?.getBoundingClientRect().top
      const uncommittedChangesReady = file instanceof HTMLButtonElement
        && scope?.value === 'working'
        && !toolbar.querySelector('button')
        && Math.abs(scope.getBoundingClientRect().right - toolbar.getBoundingClientRect().right) <= 1
        && card?.classList.contains('scm-changes-card') && gap >= 0 && gap <= 8
        && right.querySelector('.navigation-mode__header, .scm-commit-form, .git-graph') === null
        && !right.textContent.includes('scratch.md')
      file?.click()
      const diff = await waitFor(() => {
        const view = document.querySelector('.diff-viewer')
        return view?.textContent.includes('private boolean enabled = true') ? view : null
      })
      const beforeRefresh = diff?.textContent
      const refreshed = await returnToWorking()
      const sourceControlReady = diff instanceof HTMLElement
        && refreshed instanceof HTMLElement
        && document.querySelector('.diff-viewer')?.textContent === beforeRefresh
      const contextualRightPanelReady = refreshed instanceof HTMLElement && refreshed.getClientRects().length > 0
      const split = document.querySelector('.diff-split')
      const diffResponsiveReady = split instanceof HTMLElement
        && split.scrollWidth <= split.clientWidth + 1
        && document.documentElement.scrollWidth === innerWidth
      return { sourceControlReady, uncommittedChangesReady, contextualRightPanelReady, diffResponsiveReady }
    })()`)) as {
      sourceControlReady: boolean
      uncommittedChangesReady: boolean
      contextualRightPanelReady: boolean
      diffResponsiveReady: boolean
    }
    const fileListBoundsCheck = `(() => {
      const list = document.querySelector('.info-island .change-list:last-child')
      const panel = document.querySelector('.info-island .workspace-island-content')
      const rows = [...document.querySelectorAll('.info-island .change-file-open')]
      const shortName = rows.find(row => row.querySelector('strong')?.textContent === 'index.ts')?.querySelector('strong')
      return rows.length >= 2 && list instanceof HTMLElement
        && panel instanceof HTMLElement && panel.scrollWidth <= panel.clientWidth + 1
        && list.scrollWidth <= list.clientWidth + 1
        && shortName instanceof HTMLElement && shortName.scrollWidth <= shortName.clientWidth + 1
        && rows.every(row => {
          const copy = row.querySelector('.change-file-copy')
          const name = copy?.querySelector('strong')
          const status = row.querySelector('.change-file-status')
          return name instanceof HTMLElement && copy instanceof HTMLElement && status instanceof HTMLElement
            && name.clientWidth >= Math.min(name.scrollWidth, copy.clientWidth) - 1
            && name.getBoundingClientRect().right <= status.getBoundingClientRect().left
            && row.scrollWidth <= row.clientWidth + 1
        })
    })()`
    let changeFileListReadable = (await win.webContents.executeJavaScript(
      fileListBoundsCheck,
    )) as boolean
    const diffCapture = 'verify-diff.png'
    writeFileSync(verificationArtifactPath(diffCapture), (await captureVerifiedPage(win)).toPNG())
    const gitViewBounds = win.getBounds()
    const gitViewTheme = nativeTheme.themeSource
    try {
      win.setSize(1_440, 900)
      nativeTheme.themeSource = 'dark'
      await new Promise(resolve => {
        setTimeout(resolve, 220)
      })
      changeFileListReadable &&= (await win.webContents.executeJavaScript(
        fileListBoundsCheck,
      )) as boolean
      writeFileSync(
        verificationArtifactPath('verify-git-large-dark.png'),
        (await captureVerifiedPage(win)).toPNG(),
      )
    } finally {
      nativeTheme.themeSource = gitViewTheme
      win.setBounds(gitViewBounds)
      await new Promise(resolve => {
        setTimeout(resolve, 160)
      })
    }
    console.log('desktop-shell-verify-local: source-control-view', sourceControlView)
    const diffToolsScheme = settingsStore.read().colorScheme
    try {
      await verifyDiffTools(
        win,
        scheme => {
          settingsController.publish(settingsStore.update({ colorScheme: scheme }))
        },
        async name => {
          writeFileSync(verificationArtifactPath(name), (await captureVerifiedPage(win)).toPNG())
        },
      )
    } finally {
      settingsController.publish(settingsStore.update({ colorScheme: diffToolsScheme }))
    }
    await clickTrustedElement(win, '[aria-label="新建工作标签"]')
    await win.webContents.executeJavaScript(`(() => {
      const item = [...document.querySelectorAll('[role="menuitem"]')]
        .find(node => node.checkVisibility() && node.textContent.includes('新终端'))
      if (!item) throw new Error('新建工作标签菜单缺少终端入口')
      item.click()
    })()`)
    const terminalAudit = (await win.webContents.executeJavaScript(`(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      if (!document.querySelector('[data-island-id="file-outline-tasks"]')) document.querySelector('[aria-label="更多右侧栏目"][aria-haspopup="menu"]')?.click()
      let fileIsland = null
      for (let attempt = 0; attempt < 80; attempt += 1) {
        fileIsland = document.querySelector('[data-island-id="file-outline-tasks"]')
        if (fileIsland instanceof HTMLButtonElement) break
        await sleep(25)
      }
      if (!(fileIsland instanceof HTMLButtonElement)) return { ready: false, stage: 'file-island-option' }
      if (fileIsland.getAttribute('aria-selected') !== 'true') fileIsland.click()
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const view = document.querySelector('.work-tab-panel:not([hidden])')
        const host = view?.querySelector('[data-terminal-id]')
        const input = view?.querySelector('.xterm-helper-textarea')
        const shell = document.querySelector('.app-shell')
        const scmNav = document.querySelector('.navigation-island .source-control-navigation')
        const changesTab = document.querySelector('[data-view="changes"]')
        const info = document.querySelector('.info-island.file-info-island')
        if (view instanceof HTMLElement
          && host instanceof HTMLElement
          && host.dataset.terminalId !== undefined
          && input instanceof HTMLTextAreaElement
          && document.querySelector('[aria-label="终端项目"]') === null
          && shell instanceof HTMLElement
          && shell.dataset.informationCollapsed !== 'true'
          && scmNav instanceof HTMLElement
          && document.querySelector('[aria-label="项目文件树"]') === null
          && changesTab?.getAttribute('aria-current') === 'page'
          && info?.querySelector('.file-outline-panel') === null
          && info.querySelector('[data-project-tasks="true"]') instanceof HTMLElement
          && [...document.querySelectorAll('.composer-card')].every(composer => composer.getClientRects().length === 0)
          && document.querySelector('[data-work-tab="terminal"][aria-selected="true"]') instanceof HTMLButtonElement) {
          input.focus()
          return { ready: true, terminalId: host.dataset.terminalId }
        }
        const add = view?.querySelector('button[aria-label="新建终端"]')
        if (view instanceof HTMLElement
          && document.querySelectorAll('[data-work-tab="terminal"]').length === 0
          && add instanceof HTMLButtonElement) add.click()
        await sleep(25)
      }
      const workspace = document.querySelector('[aria-label="当前项目终端"]')
      const view = document.querySelector('.work-tab-panel:not([hidden])')
      const add = view?.querySelector('button[aria-label="新建终端"]')
      return {
        ready: false,
        stage: 'terminal-ready',
        activeView: document.querySelector('[data-view][aria-current="page"]')?.getAttribute('data-view') ?? null,
        workspaceHidden: workspace instanceof HTMLElement ? workspace.hidden : null,
        projectTabs: [...(workspace?.querySelectorAll('[role="tab"]') ?? [])].map(item => ({
          text: item.textContent?.trim(), selected: item.getAttribute('aria-selected'),
        })),
        viewPresent: view instanceof HTMLElement,
        addDisabled: add instanceof HTMLButtonElement ? add.disabled : null,
        terminalTabs: document.querySelectorAll('[data-work-tab="terminal"]').length ?? null,
        terminalError: view?.querySelector('[role="alert"]')?.textContent?.trim() ?? null,
        fileTree: document.querySelector('[aria-label="项目文件树"]') instanceof HTMLElement,
        rightLabel: document.querySelector('.right-island-tabs [aria-selected="true"]')?.getAttribute('aria-label') ?? null,
        visibleComposer: [...document.querySelectorAll('.composer-card')]
          .some(composer => composer.getClientRects().length > 0),
      }
    })()`)) as
      { ready: true; terminalId: string } | { ready: false; stage: string; [key: string]: unknown }
    if (!terminalAudit.ready)
      throw new Error(
        `用户终端没有创建真实 PTY 或错误显示了 Composer：${JSON.stringify(terminalAudit)}`,
      )
    const terminalId = terminalAudit.terminalId
    // 终端的 ANSI 与工作目录探针按平台选择：Windows 的默认 Shell 是 PowerShell，
    // `printf` 与 `pwd -P` 在它下面不存在；`[char]27` 同时兼容 Windows PowerShell 5.1 与 7。
    const windowsTerminalCommand =
      "[Console]::WriteLine([char]27 + '[31mDSH_TERMINAL_ANSI_OK' + [char]27 + '[0m'); (Get-Location).Path\r"
    const terminalCommand =
      process.platform === 'win32'
        ? windowsTerminalCommand
        : "printf '\\033[31mDSH_TERMINAL_ANSI_OK\\033[0m\\n'; pwd -P\r"
    // Windows 路径比较不区分大小写：PowerShell 报告的当前位置与 realpath 的大小写可能不同。
    const expectedProjectPath =
      process.platform === 'win32'
        ? realpathSync(VERIFY_PROJECT).toLowerCase()
        : realpathSync(VERIFY_PROJECT)
    const terminalPathCheck =
      process.platform === 'win32'
        ? `output.toLowerCase().includes(${JSON.stringify(expectedProjectPath)})`
        : `output.includes(${JSON.stringify(expectedProjectPath)})`
    const terminalOutputReady = (await win.webContents.executeJavaScript(`new Promise(resolve => {
      const api = globalThis.dshDesktop?.terminal
      if (api === undefined) {
        resolve(false)
        return
      }
      let output = ''
      let settled = false
      const finish = value => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        stop()
        resolve(value)
      }
      const stop = api.onEvent(event => {
        if (event.type !== 'data' || event.terminalId !== ${JSON.stringify(terminalId)}) return
        output += event.data
        if (output.includes('DSH_TERMINAL_ANSI_OK') && output.includes('\\u001b[31m')
          && (${terminalPathCheck})) finish(true)
      })
      const timeout = setTimeout(() => { finish(false) }, 4_000)
      Promise.all([
        api.resize(${JSON.stringify(terminalId)}, 100, 30),
        api.write(${JSON.stringify(terminalId)}, ${JSON.stringify(terminalCommand)})
      ]).catch(() => { finish(false) })
    })`)) as boolean
    const terminalInteraction = (await win.webContents.executeJavaScript(`(async () => {
      const waitFor = async predicate => {
        for (let attempt = 0; attempt < 160; attempt++) {
          const result = predicate()
          if (result) return result
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        return null
      }
      const fail = stage => ({ ready: false, stage,
        tabs: [...document.querySelectorAll('[data-work-tab="terminal"]')].map(tab => ({ id: tab.dataset.sessionTab, selected: tab.getAttribute('aria-selected') })),
        terminals: [...document.querySelectorAll('.work-tab-panel [data-terminal-id]')].map(host => host.dataset.terminalId) })
      const view = await waitFor(() => {
        const pane = document.querySelector('.work-tab-panel:not([hidden])')
        return pane?.querySelector('.xterm-screen') ? pane : null
      })
      const add = view?.querySelector('button[aria-label="新建终端"]')
      if (!(add instanceof HTMLButtonElement)) return fail('create-entry')
      add.click()
      const close = await waitFor(() => {
        const tabs = document.querySelectorAll('[data-work-tab="terminal"]')
        const terminals = document.querySelectorAll('.work-tab-panel [data-terminal-id]')
        return tabs.length === 2 && terminals.length === 2
          ? [...document.querySelectorAll('.session-chrome button[aria-label^="关闭终端 "]')].at(-1) : null
      })
      if (!(close instanceof HTMLButtonElement)) return fail('second-terminal')
      close.click()
      // 关闭会等待后台进程退出，不能用固定的 80ms 代替资源清理完成。
      if (!await waitFor(() => document.querySelectorAll('[data-work-tab="terminal"]').length === 1
        && document.querySelectorAll('.work-tab-panel [data-terminal-id]').length === 1
        && document.querySelector('[data-work-tab="terminal"][aria-selected="true"]')
        && [...document.querySelectorAll('.composer-card')].every(composer => !composer.checkVisibility()))) return fail('close-second')
      document.querySelector('[data-work-tab="file"]')?.click()
      if (!await waitFor(() => view.hidden
        && document.querySelector('.work-tab-panel:not([hidden]) .code-editor'))) return fail('hide-preserved')
      document.querySelector('[data-work-tab="terminal"]')?.click()
      if (!await waitFor(() => !view.hidden
        && view.querySelector('[data-terminal-id]')?.dataset.terminalId === ${JSON.stringify(terminalId)}
        && document.querySelector('.navigation-island .source-control-navigation')
        && !document.querySelector('[aria-label="项目文件树"]')
        && document.querySelector('[data-view="changes"]')?.getAttribute('aria-current') === 'page'
        && document.querySelector('.info-island.file-info-island [data-project-tasks="true"]')
        && !document.querySelector('.info-island .file-outline-panel'))) return fail('restore-preserved')
      return { ready: true, stage: 'complete' }
    })()`)) as { ready: boolean; stage: string }
    const terminalInteractionReady = terminalInteraction.ready
    const terminalReady = terminalOutputReady && terminalInteractionReady
    console.log('desktop-shell-verify-local: terminal', {
      terminalOutputReady,
      terminalInteractionReady,
      terminalInteraction,
      terminalReady,
    })
    if (!terminalReady) throw new Error('用户终端的 ANSI 输出、多标签或关闭流程验收失败')
    const conversationRestored = (await win.webContents.executeJavaScript(`(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const conversation = document.querySelector('[data-view="conversation"]')
      if (!(conversation instanceof HTMLButtonElement)) return false
      conversation.click()
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const currentConversation = document.querySelector('[data-view="conversation"]')
        const shell = document.querySelector('.app-shell')
        if (currentConversation instanceof HTMLButtonElement
          && currentConversation.classList.contains('is-active')
          && shell instanceof HTMLElement
          && shell.dataset.informationCollapsed !== 'true'
          && document.querySelector('.workspace-view') instanceof HTMLElement) return true
        if (currentConversation instanceof HTMLButtonElement) currentConversation.click()
        await sleep(25)
      }
      return false
    })()`)) as boolean
    console.log('desktop-shell-verify-local: conversation-restored', conversationRestored)
    if (!conversationRestored) throw new Error('无法在项目视图验收后恢复对话视图')

    await clickTrustedElement(win, 'button[title^="模型："]')
    const modelMenuAudit = (await win.webContents.executeJavaScript(`(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const selector = '[role="menu"][aria-label="选择模型"]'
      const fits = rect => rect.left >= 8 && rect.top >= 8
        && rect.right <= innerWidth - 8 && rect.bottom <= innerHeight - 8
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const menu = document.querySelector(selector)
        const model = menu?.querySelector('[role="menuitemradio"][aria-haspopup="menu"]')
        if (menu instanceof HTMLElement && model instanceof HTMLButtonElement) {
          model.click()
          for (let check = 0; check < 60; check += 1) {
            const id = model.getAttribute('aria-controls')
            const submenu = id && document.getElementById(id)
            if (submenu && getComputedStyle(submenu).visibility === 'visible') {
              const rect = menu.getBoundingClientRect(), side = submenu.getBoundingClientRect()
              return {
                open: true,
                selectedCount: menu.querySelectorAll('[role="menuitemradio"][aria-checked="true"]').length,
                portal: menu.parentElement === document.body && submenu.parentElement === document.body,
                fixed: getComputedStyle(menu).position === 'fixed' && getComputedStyle(submenu).position === 'fixed',
                fits: fits(rect) && fits(side),
                width: rect.width,
                adjacent: side.right <= rect.left || side.left >= rect.right,
                choices: submenu.querySelectorAll('[role="menuitemradio"]').length,
              }
            }
            await sleep(25)
          }
        }
        await sleep(25)
      }
      return { open: false, selectedCount: 0, portal: false, fixed: false, fits: false,
        width: 0, adjacent: false, choices: 0 }
    })()`)) as {
      open: boolean
      selectedCount: number
      portal: boolean
      fixed: boolean
      fits: boolean
      width: number
      adjacent: boolean
      choices: number
    }
    const modelMenuCapture = 'verify-model-menu.png'
    writeFileSync(
      verificationArtifactPath(modelMenuCapture),
      (await captureVerifiedPage(win)).toPNG(),
    )
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' })
    await new Promise(resolve => {
      setTimeout(resolve, 120)
    })
    const modelMenuReturned = (await win.webContents.executeJavaScript(`(() => {
      const menu = document.querySelector('[role="menu"][aria-label="选择模型"]')
      return menu !== null && menu.querySelector('[role="menuitemradio"]') !== null
        && menu.querySelector('[aria-expanded="true"]') === null
        && menu.contains(document.activeElement)
    })()`)) as boolean
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' })
    await new Promise(resolve => {
      setTimeout(resolve, 120)
    })
    const modelMenuClosed = (await win.webContents.executeJavaScript(`(() => {
      const trigger = document.querySelector('button[title^="模型："]')
      return trigger instanceof HTMLButtonElement
        && trigger.getAttribute('aria-expanded') === 'false'
        && document.activeElement === trigger
        && document.querySelector('[role="menu"][aria-label="选择模型"]') === null
    })()`)) as boolean
    const modelMenuReady =
      modelMenuAudit.open &&
      modelMenuAudit.portal &&
      modelMenuAudit.fixed &&
      modelMenuAudit.fits &&
      modelMenuAudit.width >= 260 &&
      modelMenuAudit.width <= 420 &&
      modelMenuAudit.selectedCount === 1 &&
      modelMenuAudit.adjacent &&
      modelMenuAudit.choices > 0 &&
      modelMenuReturned &&
      modelMenuClosed
    console.log('desktop-shell-verify-local: model-menu', {
      ...modelMenuAudit,
      returned: modelMenuReturned,
      closed: modelMenuClosed,
      ready: modelMenuReady,
    })

    const interactionSessionId = (await win.webContents.executeJavaScript(`(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const composer = document.querySelector('.work-tab-panel:not([hidden]) .composer-card')
      if (composer instanceof HTMLElement && composer.dataset.sessionId !== undefined) {
        return composer.dataset.sessionId
      }
      let selected = document.querySelector('.session-row[aria-current="page"]')
      if (!(selected instanceof HTMLButtonElement)) {
        const projectSelector = document.querySelector('.project-selector')
        if (projectSelector instanceof HTMLButtonElement) {
          projectSelector.click()
          await sleep(50)
          const allProjects = [...document.querySelectorAll('.project-focus-menu button')]
            .find(button => button.textContent?.includes('全部项目') === true)
          if (allProjects instanceof HTMLButtonElement) allProjects.click()
        }
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const visible = [...document.querySelectorAll('.session-row')]
            .find(row => row instanceof HTMLButtonElement && row.getClientRects().length > 0)
          if (visible instanceof HTMLButtonElement) {
            visible.click()
            break
          }
          const collapsed = [...document.querySelectorAll('[data-project-toggle]')]
            .find(toggle => toggle.getAttribute('aria-expanded') === 'false')
          if (collapsed instanceof HTMLButtonElement) collapsed.click()
          await sleep(25)
        }
      }
      for (let attempt = 0; attempt < 40; attempt += 1) {
        selected = document.querySelector('.session-row[aria-current="page"]')
        if (selected instanceof HTMLElement) return selected.dataset.sessionId ?? null
        await sleep(25)
      }
      return null
    })()`)) as string | null
    if (interactionSessionId === null) throw new Error('无法确认待响应交互的验收会话')
    // 通过真实选择器切换空会话，再恢复标准预设；请求走同一个公开 Remote 接口。
    await openRightPanel('git-history')
    let sessionPresetReady = true
    /* oxlint-disable no-await-in-loop -- 依次切换空会话预设再恢复标准预设。 */
    for (const label of ['极简模式', 'ChatGPT', '标准模式']) {
      await clickTrustedElement(win, '.conversation-tools [aria-label="会话预设"]')
      await clickTrustedElement(win, '.session-preset-select')
      const optionId = (await win.webContents
        .executeJavaScript(`[...document.querySelectorAll('.ant-select-dropdown [role="option"]')]
        .find(option => option.checkVisibility() && option.textContent === ${JSON.stringify(label)})?.id`)) as
        string | undefined
      if (optionId === undefined) throw new Error(`预设选择器未显示选项：${label}`)
      await clickTrustedElement(win, `[role="option"][id=${JSON.stringify(optionId)}]`)
      const selected = (await win.webContents.executeJavaScript(`(async () => {
        for (let attempt = 0; attempt < 120; attempt += 1) {
          const input = document.querySelector('.session-preset-select [role="combobox"]')
          if (document.querySelector('.session-preset-select')?.textContent?.trim() === ${JSON.stringify(label)}
            && input instanceof HTMLInputElement && !input.disabled
            && document.querySelector('.session-preset-card [role="alert"]') === null
            && document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)') === null) return true
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        return false
      })()`)) as boolean
      sessionPresetReady = sessionPresetReady && selected
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      if (!selected) {
        const state = await win.webContents.executeJavaScript(
          `document.querySelector('.session-preset-card')?.textContent`,
        )
        throw new Error(`预设切换未生效：${label}；${String(state)}`)
      }
    }
    /* oxlint-enable no-await-in-loop */
    const presetSessionCount = (await win.webContents.executeJavaScript(
      `window.dshDesktop.host.call('listSessions', {}).then(result => result.items.length)`,
    )) as number
    win.webContents.send(HOST_CHANNELS.hostFrame, {
      type: 'host/session-status',
      sessionId: interactionSessionId,
      running: true,
    })
    win.webContents.send(HOST_CHANNELS.hostFrame, {
      type: 'host/session-status',
      sessionId: interactionSessionId,
      running: false,
    })
    await clickTrustedElement(win, '.conversation-tools [aria-label="会话预设"]')
    const presetLocked = (await win.webContents.executeJavaScript(`(async () => {
      let attempted = false
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const select = document.querySelector('.session-preset-select [role="combobox"]')
        const lockedHint = [...document.querySelectorAll('.session-preset-card [title]')]
          .some(node => node.title.startsWith('会话开始后无法更改'))
        if (select?.disabled && lockedHint) {
          if (!attempted) {
            select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
            select.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
            attempted = true
          } else if (document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)') === null) {
            const { items } = await window.dshDesktop.host.call('listSessions', {})
            return items.length === ${String(presetSessionCount)}
              && document.querySelector('.session-row[aria-current="page"]')?.dataset.sessionId === ${JSON.stringify(interactionSessionId)}
          }
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return false
    })()`)) as boolean
    if (!presetLocked) throw new Error('已有对话的 Agent 预设未锁定或意外创建了会话')
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    sessionPresetReady &&= presetLocked
    console.log('desktop-shell-verify-local: session-preset', { sessionPresetReady, presetLocked })
    let sessionInfoReady =
      ((await win.webContents.executeJavaScript(`(() => {
      const content = document.querySelector('.info-island .git-review-panel')
      return document.querySelector('.session-plugins-entry') === null && content instanceof HTMLElement
        && content.scrollWidth <= content.clientWidth + 1
        && document.querySelector('.info-island .todo-card, .info-island .session-preset-card') === null
    })()`)) as boolean) && sessionPresetReady
    const todoSample = [
      '梳理现有界面',
      '调整会话信息布局',
      '同步优化菜单状态',
      '处理长任务标题在窄面板中的显示与全文提示',
      '检查任务状态图标',
      '验证清单内部滚动',
      '检查浅色主题',
      '检查深色主题',
      '复核面板底部留白',
    ].map((content, index) => ({
      content,
      status: index === 0 ? 'completed' : index < 3 ? 'in_progress' : 'pending',
    }))
    const sessionInfoProjection = await readVerificationProjection(win, interactionSessionId)
    win.webContents.send(HOST_CHANNELS.sessionFrame, {
      type: 'session/plugin-projections',
      sessionId: interactionSessionId,
      change: {
        ...sessionInfoProjection,
        kind: 'snapshot',
        values: {
          ...sessionInfoProjection.values,
          todos: todoSample,
          tokenUsage: {
            uncachedInputTokens: 12_000,
            cacheReadTokens: 96_000,
            cacheWriteTokens: 0,
            outputTokens: 13_000,
          },
          contextPressure: { projectedTokens: 3_900, contextWindow: 128_000 },
          contextBreakdown: { systemTokens: 700, toolsTokens: 800, messageTokens: 2100 },
          sessionStats: {
            turns: 1,
            steps: 9,
            llmMs: 55_000,
            toolMs: 3_000,
            ttftSteps: 9,
            ttftMs: 1_800,
            decodeMs: 54_000,
            decodeTokens: 12_800,
          },
        },
        omitted: 0,
      },
    })
    const todoCollapsed = (await win.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 80; i += 1) {
        const toggle = document.querySelector('.todo-card__toggle')
        if (toggle) {
          toggle.scrollIntoView({ block: 'nearest' })
          return toggle.getAttribute('aria-expanded') === 'false'
            && toggle.textContent.includes('已完成 1 · 进行中 2 · 待处理 6') && !document.querySelector('.todo-card__list')
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return false
    })()`)) as boolean
    await clickTrustedElement(win, '.todo-card__toggle')
    const infoSize = win.getSize()
    const infoScheme = settingsStore.read().colorScheme
    try {
      /* oxlint-disable no-await-in-loop -- 同一个窗口按两种尺寸和主题依次验收。 */
      for (const sample of [
        { width: 1280, height: 800, colorScheme: 'light' },
        { width: 1800, height: 1000, colorScheme: 'dark' },
      ] as const) {
        win.setSize(sample.width, sample.height)
        settingsController.publish(settingsStore.update({ colorScheme: sample.colorScheme }))
        await new Promise(resolve => {
          setTimeout(resolve, 250)
        })
        const todoReady = (await win.webContents.executeJavaScript(`(() => {
          const list = document.querySelector('.todo-card__list')
          const card = document.querySelector('.todo-card__body')
          if (!list || !card) return false
          const todoRect = card.getBoundingClientRect()
          const inputRect = document.querySelector('.composer-card').getBoundingClientRect()
          const toggle = card.querySelector('.todo-card__toggle')
          const arrow = toggle?.querySelector('svg:last-child')
          list.scrollTop = list.scrollHeight
          card.scrollIntoView({ block: 'nearest' })
          return list.children.length === 9 && list.querySelectorAll('[data-status="in_progress"]').length === 2
            && list.clientHeight <= 180 && list.scrollHeight > list.clientHeight && list.scrollTop > 0
            && card.scrollWidth <= card.clientWidth + 1 && list.querySelectorAll('input').length === 0
            && [...list.querySelectorAll('.todo-card__content')].every(item => item.title === item.textContent)
            && card.closest('.composer-dock') !== null && !document.querySelector('.info-island .todo-card')
            && todoRect.top > 0 && Math.abs(todoRect.left - inputRect.left) < 1
            && Math.abs(todoRect.right - inputRect.right) < 1 && inputRect.top - todoRect.bottom >= 4
            && inputRect.top - todoRect.bottom <= 10
            && toggle?.getAttribute('aria-expanded') === 'true'
            && arrow?.classList.contains('lucide-chevron-down') && getComputedStyle(arrow).transform === 'none'
            && document.querySelector('.info-island .git-review-panel') instanceof HTMLElement
        })()`)) as boolean
        sessionInfoReady &&= todoReady
        writeFileSync(
          verificationArtifactPath(`verify-session-info-${sample.colorScheme}.png`),
          (await captureVerifiedPage(win)).toPNG(),
        )
        await clickTrustedElement(win, '.todo-card__toggle')
        const centered = (await win.webContents.executeJavaScript(`(() => {
          const card = document.querySelector('.todo-card__body')
          const input = document.querySelector('.composer-card')
          const toggle = card?.querySelector('.todo-card__toggle')
          const arrow = toggle?.querySelector('svg:last-child')
          if (!card || !input || !arrow) return false
          const a = card.getBoundingClientRect(), b = input.getBoundingClientRect()
          const transform = new DOMMatrixReadOnly(getComputedStyle(arrow).transform)
          return toggle.getAttribute('aria-expanded') === 'false' && !card.querySelector('.todo-card__list')
            && Math.abs(a.left + a.right - b.left - b.right) < 1
            && arrow.classList.contains('lucide-chevron-down') && transform.d < -0.99
        })()`)) as boolean
        if (!centered) throw new Error('收起的待办没有居中或箭头方向错误')
        writeFileSync(
          verificationArtifactPath(`verify-todo-centered-${sample.colorScheme}.png`),
          (await captureVerifiedPage(win)).toPNG(),
        )
        await clickTrustedElement(win, '.todo-card__toggle')
        const cardHeight = (await win.webContents.executeJavaScript(
          `document.querySelector('.composer-card').getBoundingClientRect().height`,
        )) as number
        await clickTrustedElement(win, '.panel-divider--information .panel-divider__capsule')
        const hudReady = (await win.webContents.executeJavaScript(`(() => {
          const hud = document.querySelector('[data-composer-readings]')
          const card = document.querySelector('.composer-card').getBoundingClientRect()
          const island = document.querySelector('.main-island').getBoundingClientRect()
          if (!hud) return false
          const row = hud.getBoundingClientRect()
          return hud.querySelectorAll('button').length === 3 && hud.textContent.includes('121K tok')
            && Math.abs(card.height - ${String(cardHeight)}) < 1 && row.height === 24
            && Math.abs(row.top - card.bottom - 2) < 1 && Math.abs(island.bottom - row.bottom - 7) < 1
            && Math.abs(row.left + row.right - card.left - card.right) < 1 && hud.scrollWidth <= hud.clientWidth
        })()`)) as boolean
        if (!hudReady) throw new Error('输入区 HUD 间距、底部留白或读数布局异常')
        await clickTrustedElement(win, '[data-composer-readings] button[aria-label^="Token 用量"]')
        const hudPanelReady = (await win.webContents.executeJavaScript(`(() => {
          const panel = document.querySelector('[role="dialog"][aria-label="Token 用量"]')
          const button = document.querySelector('[data-composer-readings] button[aria-label^="Token 用量"]')
          if (!panel || !button) return false
          const rect = panel.getBoundingClientRect()
          return button.getAttribute('aria-expanded') === 'true' && panel.textContent.includes('缓存读取')
            && rect.top >= 0 && rect.bottom <= button.getBoundingClientRect().top
        })()`)) as boolean
        if (!hudPanelReady) throw new Error('HUD 用量面板未向上展开或按钮状态异常')
        await clickTrustedElement(win, '[data-composer-readings] button[aria-label^="Token 用量"]')
        await clickTrustedElement(win, '[data-composer-readings] button[aria-label^="上下文占用"]')
        const contextPanelReady = (await win.webContents.executeJavaScript(`(() => {
          const panel = document.querySelector('[role="dialog"][aria-label="上下文占用"]')
          return panel?.textContent.includes('系统提示词~700') && panel.textContent.includes('工具定义~800')
            && panel.textContent.includes('对话消息~2.1K') && panel.querySelectorAll('i[data-kind]').length === 6
            && !panel.textContent.includes('缓存读取')
        })()`)) as boolean
        if (!contextPanelReady) throw new Error('仪表盘上下文构成未读取核心投影或与累计用量混淆')
        writeFileSync(
          verificationArtifactPath(`verify-hud-context-${sample.colorScheme}.png`),
          (await captureVerifiedPage(win)).toPNG(),
        )
        await clickTrustedElement(win, '[data-composer-readings] button[aria-label^="上下文占用"]')
        writeFileSync(
          verificationArtifactPath(`verify-composer-hud-${sample.colorScheme}.png`),
          (await captureVerifiedPage(win)).toPNG(),
        )
        await clickTrustedElement(win, '.panel-divider--information .panel-divider__capsule')
      }
      /* oxlint-enable no-await-in-loop */
      win.setSize(1100, 800)
      await new Promise(resolve => {
        setTimeout(resolve, 350)
      })
      const narrowTodoReady = await win.webContents.executeJavaScript(`(() => {
        const todo = document.querySelector('.composer-dock .todo-card')?.getBoundingClientRect()
        const input = document.querySelector('.composer-card')?.getBoundingClientRect()
        return todo && input && todo.top >= 0 && todo.bottom < input.top && input.bottom < innerHeight
          && Math.abs(todo.width - input.width) < 1 && !!document.querySelector('[data-composer-readings]')
      })()`)
      if (!narrowTodoReady) throw new Error('窄窗口待办未显示在输入框正上方')
      writeFileSync(
        verificationArtifactPath('verify-composer-todos-narrow.png'),
        (await captureVerifiedPage(win)).toPNG(),
      )
      await verifyCompactionReadings(
        win,
        interactionSessionId,
        frame => {
          win.webContents.send(HOST_CHANNELS.sessionFrame, frame)
        },
        scheme => {
          settingsController.publish(settingsStore.update({ colorScheme: scheme }))
        },
        async name => {
          writeFileSync(verificationArtifactPath(name), (await captureVerifiedPage(win)).toPNG())
        },
      )
    } finally {
      win.setSize(infoSize[0] ?? 1280, infoSize[1] ?? 800)
      settingsController.publish(settingsStore.update({ colorScheme: infoScheme }))
      win.webContents.send(HOST_CHANNELS.sessionFrame, {
        type: 'session/plugin-projections',
        sessionId: interactionSessionId,
        change: {
          ...sessionInfoProjection,
          kind: 'snapshot',
          values: { ...sessionInfoProjection.values, todos: [] },
        },
      })
    }
    const infoMenuReady = (await win.webContents.executeJavaScript(`(() => {
      const menu = document.querySelector('.right-island-tabs')
      return menu && !menu.querySelector('small') && menu.querySelectorAll('[aria-selected="true"]').length === 1
        && menu.querySelector('[data-tab-id="conversation"]') === null
        && menu.querySelector('[data-island-id="git-history"]')?.getAttribute('aria-selected') === 'true'
        && !menu.querySelector('[data-tab-id="session-info"], [data-tab-id="plan-preview"]')
        && !document.querySelector('.todo-card')
    })()`)) as boolean
    writeFileSync(
      verificationArtifactPath('verify-right-island-tabs.png'),
      (await captureVerifiedPage(win)).toPNG(),
    )
    sessionInfoReady &&= todoCollapsed && infoMenuReady
    if (!sessionInfoReady) throw new Error('会话信息的任务清单、栏目状态或末尾分隔线验收失败')
    console.log('desktop-shell-verify-local: session-info', {
      sessionInfoReady,
      todoCollapsed,
      infoMenuReady,
    })
    const questionKey = 'question:mydsh-verifier'
    const planScheme = settingsStore.read().colorScheme
    try {
      await verifyPlanReview(
        win,
        interactionSessionId,
        frame => {
          observeInteractionFrame(frame)
          win.webContents.send(HOST_CHANNELS.sessionFrame, frame)
        },
        scheme => {
          settingsController.publish(settingsStore.update({ colorScheme: scheme }))
        },
        async name => {
          writeFileSync(verificationArtifactPath(name), (await captureVerifiedPage(win)).toPNG())
        },
      )
    } finally {
      // 计划的明暗截图不能改变后续“跟随系统”主题验收的前提。
      settingsController.publish(settingsStore.update({ colorScheme: planScheme }))
    }
    const questionFrame: DesktopSessionFrame = {
      type: 'session/interaction-requested',
      sessionId: interactionSessionId,
      interaction: {
        kind: 'question',
        key: questionKey,
        questions: [
          {
            id: 'verification-choice',
            header: '验收选择',
            question: '请选择验收方式',
            detail: '这个请求只用于验证桌面端待回答交互。',
            options: [
              { label: '继续（推荐）', description: '验证单选、推荐标识和提交入口。' },
              { label: '暂停', description: '验证第二个可选项。' },
            ],
          },
        ],
      },
    }
    observeInteractionFrame(questionFrame)
    win.webContents.send(HOST_CHANNELS.sessionFrame, questionFrame)
    const questionInteractionReady = (await win.webContents.executeJavaScript(`(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const card = document.querySelector('[data-question-key="${questionKey}"]')
        const options = card?.querySelectorAll('[role="radio"]')
        const custom = card?.querySelector('textarea[placeholder="输入你的回答"]')
        const submit = [...(card?.querySelectorAll('button') ?? [])]
          .find(button => button.textContent?.includes('提交回答'))
        const skip = [...(card?.querySelectorAll('button') ?? [])]
          .find(button => button.textContent?.includes('跳过此题'))
        const close = card?.querySelector('button[aria-label="关闭问题"]')
        if (card instanceof HTMLElement
          && options?.length === 2
          && custom instanceof HTMLTextAreaElement
          && submit instanceof HTMLButtonElement
          && skip instanceof HTMLButtonElement
          && close instanceof HTMLButtonElement
          && card.textContent?.includes('推荐') === true) return true
        await sleep(25)
      }
      return false
    })()`)) as boolean
    let questionSelectionReady = false
    if (questionInteractionReady) {
      await clickTrustedElement(win, `[data-question-key="${questionKey}"] [role="radio"]`)
      questionSelectionReady = (await win.webContents.executeJavaScript(`(async () => {
        const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const selected = [...document.querySelectorAll('[data-question-key="${questionKey}"] [role="radio"]')]
            .find(option => option.getAttribute('aria-checked') === 'true')
          if (selected instanceof HTMLButtonElement) return true
          await sleep(25)
        }
        return false
      })()`)) as boolean
    }
    const questionResolution: DesktopSessionFrame = {
      type: 'session/interaction-resolved',
      sessionId: interactionSessionId,
      resolution: { kind: 'question', key: questionKey, outcome: 'cancelled' },
    }
    observeInteractionFrame(questionResolution)
    win.webContents.send(HOST_CHANNELS.sessionFrame, questionResolution)
    const questionResolved = (await win.webContents.executeJavaScript(`(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (document.querySelector('[data-question-key="${questionKey}"]') === null
          && document.querySelector('.main-island .composer-card') instanceof HTMLElement) return true
        await sleep(25)
      }
      return false
    })()`)) as boolean
    const approvalKey = 'approval:mydsh-verifier'
    const approvalFrame: DesktopSessionFrame = {
      type: 'session/interaction-requested',
      sessionId: interactionSessionId,
      interaction: {
        kind: 'approval',
        key: approvalKey,
        approvalId: 'mydsh-verifier-approval',
        toolName: 'Bash',
        reason: '将验收文件复制到用户目录',
      },
    }
    observeInteractionFrame(approvalFrame)
    win.webContents.send(HOST_CHANNELS.sessionFrame, approvalFrame)
    const approvalInteractionReady = (await win.webContents.executeJavaScript(`(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const card = document.querySelector('[data-approval-key="${approvalKey}"]')
        const buttons = [...(card?.querySelectorAll('button') ?? [])]
        const reject = buttons.find(button => button.textContent?.trim() === '拒绝')
        const allowOnce = buttons.find(button => button.textContent?.includes('允许一次'))
        if (card instanceof HTMLElement
          && reject instanceof HTMLButtonElement
          && allowOnce instanceof HTMLButtonElement
          && card.textContent?.includes('不会永久放宽会话权限') === true
          && !card.textContent?.includes('始终允许')) {
          const panel = card.closest('.pending-interaction-card')
          const reason = card.querySelector('h2')
          const body = reason.parentElement
          const compact = panel.getBoundingClientRect().height < 260
          const original = reason.textContent
          try {
            reason.textContent = original.repeat(160)
            return compact && body.scrollHeight > body.clientHeight
              && body.scrollWidth <= body.clientWidth + 1
              && panel.getBoundingClientRect().height <= 420
              && allowOnce.getBoundingClientRect().bottom <= panel.getBoundingClientRect().bottom
          } finally { reason.textContent = original }
        }
        await sleep(25)
      }
      return false
    })()`)) as boolean
    writeFileSync(
      verificationArtifactPath('verify-approval.png'),
      (await captureVerifiedPage(win)).toPNG(),
    )
    const approvalResolution: DesktopSessionFrame = {
      type: 'session/interaction-resolved',
      sessionId: interactionSessionId,
      resolution: {
        kind: 'approval',
        approvalId: 'mydsh-verifier-approval',
        outcome: 'rejected',
      },
    }
    observeInteractionFrame(approvalResolution)
    win.webContents.send(HOST_CHANNELS.sessionFrame, approvalResolution)
    const approvalResolved = (await win.webContents.executeJavaScript(`(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (document.querySelector('[data-approval-key="${approvalKey}"]') === null
          && document.querySelector('.main-island .composer-card') instanceof HTMLElement) return true
        await sleep(25)
      }
      return false
    })()`)) as boolean
    const pendingInteractionsReady =
      questionInteractionReady &&
      questionSelectionReady &&
      questionResolved &&
      approvalInteractionReady &&
      approvalResolved
    console.log('desktop-shell-verify-local: pending-interactions', {
      questionInteractionReady,
      questionSelectionReady,
      questionResolved,
      approvalInteractionReady,
      approvalResolved,
    })
    const projectViews = {
      ...fileView,
      fileEditorReady,
      fileUnsavedGuardReady,
      contentSearchReady,
      projectTasksOnlyReady,
      projectTasksReady,
      taskSuggestionsRemoved,
      ...sourceControlView,
      changeFileListReadable,
      composerVisibilityReady,
      sourceControlWriteReady,
      sourceControlFailureReady,
      pendingInteractionsReady,
      fileCapture,
      diffCapture,
    }

    console.log('desktop-shell-verify-local: appearance-open')
    const verifySettingsHeader = async (): Promise<void> => {
      const aligned = (await win.webContents.executeJavaScript(`(async () => {
        const dialog = document.querySelector('.settings-dialog[role="dialog"]')
        if (!(dialog instanceof HTMLElement)) return false
        await Promise.allSettled(
        dialog
          .getAnimations({ subtree: true })
          .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map(animation => animation.finished),
      )
        const header = dialog.querySelector('.settings-dialog__header')
        const title = header?.querySelector('h1')
        const close = header?.querySelector('button[aria-label="关闭设置"]')
        const content = dialog.querySelector('.settings-content')
        const surface = dialog.querySelector('.mydsh-glass-dialog')
        const current = dialog.querySelector('.settings-nav__items .ant-menu-item-selected')
        if (!(header instanceof HTMLElement) || !(title instanceof HTMLElement)
          || !(close instanceof HTMLButtonElement) || !(content instanceof HTMLElement)
          || !surface || !current || !getComputedStyle(surface).backdropFilter.includes('blur')
          || getComputedStyle(current).backgroundImage === 'none') return false
        const frame = header.getBoundingClientRect()
        const center = frame.top + frame.height / 2
        const controls = [title, ...header.querySelectorAll('button')]
        return controls.every(control => {
          const rect = control.getBoundingClientRect()
          return Math.abs(rect.top + rect.height / 2 - center) <= 1
            && rect.top >= frame.top + 11 && rect.bottom <= frame.bottom - 11
            && rect.left >= frame.left + 12 && rect.right <= frame.right - 12
        }) && content.getBoundingClientRect().top >= frame.bottom
          && frame.top >= 0 && frame.right <= innerWidth
      })()`)) as boolean
      if (!aligned) throw new Error('设置顶栏的标题、配置入口和关闭按钮没有对齐或越出了安全边距')
    }
    await clickTrustedElement(win, '#open-settings')
    await clickTrustedElement(win, '.settings-nav__items > [role="menuitem"]:nth-child(2)')
    const settingsAudit = (await win.webContents.executeJavaScript(`(() => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      return (async () => {
        const expectedNav = ['通用设置', '外观', '模型', 'Agent 预设', '已归档会话', '浏览器与桌面操控']
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const dialog = document.querySelector('.settings-dialog[role="dialog"]')
          const navigation = dialog?.querySelector('.settings-nav')
          const removedAppearanceControlsGone = dialog?.querySelector('.material-options') === null
            && dialog.querySelector('input[aria-label="侧栏浮岛透明度"]') === null
            && dialog.querySelector('input[aria-label="内容浮岛透明度"]') === null
            && dialog.querySelector('input[aria-label="画布透明度"]') === null
            && dialog.querySelector('[role="combobox"][aria-label="画布配色"]') === null
            && dialog.querySelector('input[aria-label="内容可读性遮罩"]') === null
            && dialog.querySelector('input[aria-label="浮岛间隙"]') === null
            && dialog.querySelector('.background-setting') === null
            && dialog.querySelector('input[type="range"]') === null
            && dialog.querySelector('.settings-switch') === null
          const navigationAutoHideRemoved = dialog?.querySelector('[role="switch"][aria-label="项目侧栏自动隐藏"]') === null
          const fontFamily = document.querySelector('[role="combobox"][aria-label="界面字体"]')
          const fontSize = document.querySelector('input[aria-label="界面字号"]')
          const fontSizeDec = document.querySelector('button[aria-label="减小界面字号"]')
          const fontSizeInc = document.querySelector('button[aria-label="增大界面字号"]')
          const capsulesSwitch = dialog?.querySelector('button[role="switch"][aria-label="缩放胶囊常驻"]')
          const automaticLayoutReady = document.querySelector('input[aria-label="对话内容宽度"]') === null
            && document.querySelector('input[aria-label="代码字号"]') === null
            && document.querySelector('[role="combobox"][aria-label="代码行高"]') === null
            && document.querySelector('[role="switch"][aria-label="代码连字"]') === null
          const accents = document.querySelectorAll('.accent-option')
          const accentValuePill = document.querySelector('.accent-value-pill')
          const accentShapesReady = [...accents].every(accent => {
            const rect = accent.getBoundingClientRect()
            const style = getComputedStyle(accent)
            return Math.abs(rect.width - 24) <= 0.5
              && Math.abs(rect.height - 24) <= 0.5
              && style.paddingLeft === '0px'
              && style.paddingRight === '0px'
              && style.borderRadius === '50%'
          })
          const rect = dialog instanceof HTMLElement ? dialog.getBoundingClientRect() : null
          const navButtons = [...(navigation?.querySelectorAll('.settings-nav__items > [role="menuitem"]') ?? [])]
          const navLabels = navButtons.map(button => button.textContent?.trim() ?? '')
          const navOrderReady = navLabels.length === expectedNav.length
            && expectedNav.every((label, index) => navLabels[index] === label)
            && !navLabels.includes('内置插件')
            && !navLabels.includes('ChatGPT 订阅')
          const content = dialog?.querySelector('.settings-content')
          const focusInside = dialog instanceof HTMLElement
            && document.activeElement instanceof HTMLElement
            && dialog.contains(document.activeElement)
          const panelFits = rect !== null
            && rect.left >= 0 && rect.top >= 0
            && rect.right <= innerWidth && rect.bottom <= innerHeight
            && content instanceof HTMLElement
            && content.scrollWidth <= content.clientWidth + 1
          const modal = dialog instanceof HTMLElement && dialog.getAttribute('aria-modal') === 'true'
          const appearanceIndex = navLabels.indexOf('外观')
          if (dialog instanceof HTMLElement && dialog.checkVisibility()
            && removedAppearanceControlsGone
            && navigationAutoHideRemoved
            && fontFamily instanceof HTMLInputElement && fontFamily.closest('.settings-select')?.textContent?.includes('系统字体') === true
            && dialog.querySelector('select') === null
            && fontSize instanceof HTMLInputElement && fontSize.getAttribute('role') === 'spinbutton' && fontSize.value === '12'
            && fontSizeDec instanceof HTMLButtonElement && fontSizeInc instanceof HTMLButtonElement
            && capsulesSwitch instanceof HTMLButtonElement && capsulesSwitch.classList.contains('ant-switch')
            && automaticLayoutReady
            && accents.length === 6 && accentShapesReady && accentValuePill instanceof HTMLElement
            && navOrderReady
            && (focusInside || attempt >= 75)) return {
              open: true,
              focusInside,
              panelFits,
              layerCount: dialog.querySelectorAll('.background-setting').length,
              navCount: navButtons.length,
              appearanceIndex,
              modal,
            }
          await sleep(25)
        }
        return { open: false, focusInside: false, panelFits: false, layerCount: -1, navCount: 0, appearanceIndex: -1, modal: false }
      })()
    })()`)) as {
      open: boolean
      focusInside: boolean
      panelFits: boolean
      layerCount: number
      navCount: number
      appearanceIndex: number
      modal: boolean
    }
    const settingsDialog = settingsAudit.open
    await verifySettingsHeader()
    await new Promise(resolve => {
      setTimeout(resolve, 180)
    })
    const appearanceCapture = 'verify-appearance.png'
    writeFileSync(
      verificationArtifactPath(appearanceCapture),
      (await captureVerifiedPage(win)).toPNG(),
    )
    const appearanceBackgroundsCapture = ''
    const appearanceBackgroundsReady = settingsAudit.layerCount === 0

    await clickTrustedElement(win, '.settings-nav__items > [role="menuitem"]:nth-child(3)')
    await new Promise(resolve => {
      setTimeout(resolve, 120)
    })
    const modelsCapture = 'verify-models.png'
    writeFileSync(verificationArtifactPath(modelsCapture), (await captureVerifiedPage(win)).toPNG())
    const modelsReady = (await win.webContents.executeJavaScript(`(() => {
      const dialog = document.querySelector('.settings-dialog[role="dialog"]')
      const content = dialog?.querySelector('.settings-content')
      const provider = dialog?.querySelector('.settings-provider-summary')
      return provider instanceof HTMLButtonElement
        && provider.getAttribute('aria-expanded') === 'false'
        && dialog?.querySelector('.models-detail-view') === null
        && content instanceof HTMLElement
        && content.scrollWidth <= content.clientWidth + 1
    })()`)) as boolean

    await clickTrustedElement(win, '.settings-nav__items > [role="menuitem"]:nth-child(4)')
    await new Promise(resolve => {
      setTimeout(resolve, 120)
    })
    const presetsCapture = 'verify-presets.png'
    writeFileSync(
      verificationArtifactPath(presetsCapture),
      (await captureVerifiedPage(win)).toPNG(),
    )
    const settingsPagesReady = (await win.webContents.executeJavaScript(`(() => {
      const dialog = document.querySelector('.settings-dialog[role="dialog"]')
      const presetList = dialog?.querySelector('.settings-preset-list')
      const selectedPreset = dialog?.querySelector('.settings-preset-card[data-selected="true"]')
      const presetColumns = presetList instanceof HTMLElement
        ? getComputedStyle(presetList).gridTemplateColumns.split(' ').filter(Boolean).length
        : 0
      const presetsReady = dialog instanceof HTMLElement
        && dialog.checkVisibility()
        && presetList instanceof HTMLElement
        && presetColumns === 2
        && selectedPreset instanceof HTMLElement
        && dialog.querySelector('[aria-label="新会话默认 Agent 预设"]') === null
      return presetsReady
    })()`)) as boolean
    // 复用隔离插件夹具写入并刷盘真实历史，不启动模型请求。
    writeFileSync(
      join(extensionSource, 'mydsh.plugin.json'),
      JSON.stringify({
        id: 'verification.archive-seed',
        name: '归档验收数据',
        version: '1.0.0',
        apiVersion: 1,
        backend: 'archive-seed.mjs',
      }),
    )
    writeFileSync(
      join(extensionSource, 'archive-seed.mjs'),
      `
      export const inject = ['sessions'];
      export async function apply(ctx) {
        const session = ctx.sessions.get(${JSON.stringify(interactionSessionId)});
        if (!session) throw new Error('缺少隔离验收会话');
        session.append('turn/start', { turn: 0 });
        session.append('user/message', { id: 'archive-verification-message', role: 'user',
          content: [{ type: 'text', text: '归档恢复验收：保留这条历史消息。' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
        session.append('turn/end', { turn: 0, reason: { kind: 'completed' } });
        await ctx.sessions.flush(session);
      }
    `,
    )
    await win.webContents.executeJavaScript(`(async () => {
      try { await window.dshDesktop.host.call('mydshPlugins.install', { path: ${JSON.stringify(extensionSource)} }) }
      finally { await window.dshDesktop.host.call('mydshPlugins.uninstall', { id: 'verification.archive-seed' }) }
    })()`)
    const archiveFixture = (await win.webContents.executeJavaScript(`(async () => {
      const host = window.dshDesktop.host
      const { items } = await host.call('listSessions', {})
      const workspaces = await host.call('listWorkspaces', {})
      const session = items.find(item => item.sessionId === ${JSON.stringify(interactionSessionId)} && !item.blank && !item.running)
      if (!session) throw new Error('缺少可恢复的隔离验收会话')
      const sessionId = session.sessionId
      const owner = workspaces.items.find(item => item.sessionIds.includes(sessionId))
      const throughSeq = session.projections?.asOfSeq ?? 0
      const history = await host.call('loadSessionPage', { sessionId, throughSeq, maxMessages: 25 })
      if (!history.records?.some(record => record.event?.type === 'user/message')) throw new Error('归档验收会话缺少真实历史')
      await host.call('archiveSession', { sessionId })
      ;[...document.querySelectorAll('.settings-nav__items > [role="menuitem"]')]
        .find(item => item.textContent?.trim() === '已归档会话')?.click()
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const row = document.querySelector('.settings-archive-list [data-session-id=' + JSON.stringify(sessionId) + ']')
        const search = document.querySelector('input[aria-label="搜索已归档会话"]')
        if (row && search instanceof HTMLInputElement) {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(search, owner?.title ?? '未分组')
          search.dispatchEvent(new Event('input', { bubbles: true }))
          await new Promise(resolve => setTimeout(resolve, 80))
          const content = document.querySelector('.settings-content')
          return { sessionId, throughSeq, history, ownerId: owner?.workspaceId, ready: row.isConnected
            && row.textContent.includes(owner?.title ?? '未分组')
            && content.scrollWidth <= content.clientWidth + 1
            && document.querySelector('.session-row-shell[data-session-id=' + JSON.stringify(sessionId) + ']') === null }
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      throw new Error('已归档会话未出现在设置页')
    })()`)) as {
      sessionId: string
      throughSeq: number
      history: unknown
      ownerId?: string
      ready: boolean
    }
    writeFileSync(
      verificationArtifactPath('verify-archived-sessions.png'),
      (await captureVerifiedPage(win)).toPNG(),
    )
    const archivedSessionsReady =
      archiveFixture.ready &&
      ((await win.webContents.executeJavaScript(`(async () => {
      const fixture = ${JSON.stringify(archiveFixture)}
      const selector = '[data-session-id=' + JSON.stringify(fixture.sessionId) + ']'
      document.querySelector('.settings-archive-list ' + selector + ' button')?.click()
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (document.querySelector('.settings-archive-list ' + selector) === null
          && document.querySelector('.session-row-shell' + selector)) {
          const workspaces = await window.dshDesktop.host.call('listWorkspaces', {})
          const history = await window.dshDesktop.host.call('loadSessionPage', { sessionId: fixture.sessionId, throughSeq: fixture.throughSeq, maxMessages: 25 })
          return !workspaces.archivedSessionIds.includes(fixture.sessionId)
            && workspaces.items.find(item => item.workspaceId === fixture.ownerId)?.sessionIds.includes(fixture.sessionId)
            && JSON.stringify(history) === JSON.stringify(fixture.history)
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return false
    })()`)) as boolean)
    // 真实运行中归档必须停止任务；旧归档中的内部通知也不能阻止后续永久删除。
    writeFileSync(
      join(extensionSource, 'mydsh.plugin.json'),
      JSON.stringify({
        id: 'verification.archive-guard',
        name: '归档删除占用验收',
        version: '1.0.0',
        apiVersion: 1,
        backend: 'archive-guard.mjs',
      }),
    )
    writeFileSync(
      join(extensionSource, 'archive-guard.mjs'),
      `
      export const inject = ['agents', 'sessions', 'sessionController', 'workspaceRegistry'];
      export async function apply(ctx) {
        const message = (text, source = { kind: 'user' }) => ({ id: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text }], source });
        const id = ${JSON.stringify(archiveFixture.sessionId)};
        const found = await ctx.sessionController.resolveAgent(id);
        if ('error' in found) throw found.error;
        const agent = found.agent;
        const entered = Promise.withResolvers();
        let aborted = false;
        const unhook = agent.ctx.on('agent/pre-step', ({ signal }) => new Promise(resolve => {
          entered.resolve();
          const stop = () => { aborted = true; resolve({ kind: 'reject' }) };
          if (signal.aborted) stop();
          else signal.addEventListener('abort', stop, { once: true });
        }));
        let timer;
        try {
          agent.followup(message('运行中的归档验收'));
          await Promise.race([entered.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('验收任务没有开始')), 5000) })]);
          if (agent.status !== 'running') throw new Error('验收任务未处于运行中');
          agent.followup(message('归档后不能继续的排队消息'));
          await ctx.sessionController.archiveSession(id);
          if (!aborted || ctx.agents.get(id) || ctx.sessions.get(id) || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) {
            throw new Error('归档未停止运行、清空队列或释放写句柄');
          }
          if (!('error' in await ctx.sessionController.resolveAgent(id))) throw new Error('归档会话被重新激活');
        } finally {
          clearTimeout(timer); unhook();
          if (ctx.agents.get(id) === agent) { agent.cancel({ kind: 'user' }); await agent.whenIdle() }
        }
        await ctx.workspaceRegistry.unarchiveSession(id);
        const restored = await ctx.sessionController.resolveAgent(id);
        if ('error' in restored) throw restored.error;
        if (restored.agent.inbox.nextTurn.length || restored.agent.inbox.nextStep.length) throw new Error('恢复后重新执行了归档前的队列');
        restored.agent.inject(message('旧归档中的权限变化通知', { kind: 'plugin', plugin: 'permissions' }));
        await ctx.workspaceRegistry.archiveSession(id);
      }
    `,
    )
    await win.webContents.executeJavaScript(`(async () => {
      await window.dshDesktop.host.call('mydshPlugins.install', { path: ${JSON.stringify(extensionSource)} })
      await window.dshDesktop.host.call('mydshPlugins.uninstall', { id: 'verification.archive-guard' })
    })()`)
    const deletionConfirmationReady = (await win.webContents.executeJavaScript(`(async () => {
      const fixture = ${JSON.stringify(archiveFixture)}
      const host = window.dshDesktop.host
      const selector = '.settings-archive-list [data-session-id=' + JSON.stringify(fixture.sessionId) + ']'
      const waitFor = async predicate => {
        for (let i = 0; i < 100; i += 1) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)) }
        throw new Error('永久删除界面没有到达预期状态')
      }
      const history = await host.call('loadSessionPage', { sessionId: fixture.sessionId, throughSeq: fixture.throughSeq, maxMessages: 25 })
      if (JSON.stringify(history) !== JSON.stringify(fixture.history)) throw new Error('归档恢复后历史改变')
      await waitFor(() => document.querySelector(selector + ' button[aria-label^="永久删除会话:"]'))
      document.querySelector(selector + ' button[aria-label^="永久删除会话:"]').click()
      const confirmation = () => [...document.querySelectorAll('[role="dialog"]')].find(dialog => dialog.checkVisibility() && dialog.textContent.includes('永久删除会话？'))
      await waitFor(confirmation)
      ;[...confirmation().querySelectorAll('button')].find(button => button.textContent.replaceAll(' ', '') === '取消').click()
      await waitFor(() => !confirmation())
      if (!(await host.call('listWorkspaces', {})).archivedSessionIds.includes(fixture.sessionId)) throw new Error('取消确认意外删除了会话')
      document.querySelector(selector + ' button[aria-label^="永久删除会话:"]').click()
      await waitFor(confirmation)
      const rect = confirmation().getBoundingClientRect()
      return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
        && confirmation().querySelector('.ant-btn-dangerous') !== null
    })()`)) as boolean
    const archiveColorScheme = settingsStore.read().colorScheme
    /* oxlint-disable no-await-in-loop -- 明暗主题必须逐一渲染后截图，不能并行切换。 */
    for (const colorScheme of ['light', 'dark'] as const) {
      settingsController.publish(settingsStore.update({ colorScheme }))
      await new Promise(resolve => {
        setTimeout(resolve, 180)
      })
      writeFileSync(
        verificationArtifactPath(`verify-delete-archive-${colorScheme}.png`),
        (await captureVerifiedPage(win)).toPNG(),
      )
    }
    /* oxlint-enable no-await-in-loop */
    settingsController.publish(settingsStore.update({ colorScheme: archiveColorScheme }))
    const permanentDeletionReady =
      deletionConfirmationReady &&
      ((await win.webContents.executeJavaScript(`(async () => {
      const fixture = ${JSON.stringify(archiveFixture)}
      const host = window.dshDesktop.host
      const selector = '.settings-archive-list [data-session-id=' + JSON.stringify(fixture.sessionId) + ']'
      const waitFor = async predicate => {
        for (let i = 0; i < 100; i += 1) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)) }
        throw new Error('永久删除没有完成')
      }
      const confirmation = () => [...document.querySelectorAll('[role="dialog"]')].find(dialog => dialog.checkVisibility() && dialog.textContent.includes('永久删除会话？'))
      ;[...confirmation().querySelectorAll('button')].find(button => button.textContent === '永久删除').click()
      await waitFor(() => !confirmation() && !document.querySelector(selector))
      document.querySelector('button[aria-label="刷新已归档会话"]').click()
      const workspaces = await host.call('listWorkspaces', {})
      const sessions = await host.call('listSessions', {})
      let missing = false
      try { await host.call('loadSessionPage', { sessionId: fixture.sessionId, throughSeq: fixture.throughSeq, maxMessages: 25 }) }
      catch { missing = true }
      return missing && !workspaces.archivedSessionIds.includes(fixture.sessionId)
        && workspaces.items.every(item => !item.sessionIds.includes(fixture.sessionId))
        && !sessions.items.some(item => item.sessionId === fixture.sessionId)
    })()`)) as boolean)
    await clickTrustedElement(win, '.settings-nav__items > [role="menuitem"]:nth-child(6)')
    const automationDefaultReady = (await win.webContents.executeJavaScript(`(async () => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const page = document.querySelector('.settings-dialog [data-automation-settings]')
        const content = document.querySelector('.settings-dialog .settings-content')
        const embeddedSwitch = page?.querySelector('button[role="switch"][aria-label="允许 Agent 操控内置浏览器"]')
        const permissionItems = page?.querySelectorAll('[aria-label="系统权限状态清单"] .automation-permission-item') ?? []
        if (page instanceof HTMLElement && page.checkVisibility()
          && content instanceof HTMLElement
          && embeddedSwitch instanceof HTMLButtonElement
          && !embeddedSwitch.disabled
          && permissionItems.length === 3) {
          return content.scrollWidth <= content.clientWidth + 1
            && page.scrollWidth <= page.clientWidth + 1
            && [...permissionItems].every(item => item instanceof HTMLElement && item.checkVisibility())
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return false
    })()`)) as boolean
    let automationExpandedReady = false
    const automationCapture = 'verify-automation.png'
    if (automationDefaultReady) {
      await clickTrustedElement(
        win,
        '.settings-dialog [data-automation-settings] button[role="switch"][aria-label="允许 Agent 操控内置浏览器"]',
      )
      automationExpandedReady = (await win.webContents.executeJavaScript(`(async () => {
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const page = document.querySelector('.settings-dialog [data-automation-settings]')
          const content = document.querySelector('.settings-dialog .settings-content')
          const embeddedSwitch = page?.querySelector('button[role="switch"][aria-label="允许 Agent 操控内置浏览器"]')
          const originInputs = page?.querySelectorAll('.automation-origin-input-row input') ?? []
          if (page instanceof HTMLElement && content instanceof HTMLElement
            && embeddedSwitch instanceof HTMLButtonElement
            && embeddedSwitch.getAttribute('aria-checked') === 'true'
            && !embeddedSwitch.disabled
            && originInputs.length >= 2) {
            return content.scrollWidth <= content.clientWidth + 1
              && page.scrollWidth <= page.clientWidth + 1
              && [...originInputs].every(input => input instanceof HTMLElement && input.checkVisibility())
          }
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        return false
      })()`)) as boolean
      writeFileSync(
        verificationArtifactPath(automationCapture),
        (await captureVerifiedPage(win)).toPNG(),
      )
      const shouldRestoreSwitch = (await win.webContents.executeJavaScript(
        `document.querySelector('.settings-dialog [data-automation-settings] button[role="switch"][aria-label="允许 Agent 操控内置浏览器"]')?.getAttribute('aria-checked') === 'true'`,
      )) as boolean
      if (shouldRestoreSwitch) {
        await clickTrustedElement(
          win,
          '.settings-dialog [data-automation-settings] button[role="switch"][aria-label="允许 Agent 操控内置浏览器"]',
        )
        await win.webContents.executeJavaScript(`(async () => {
          for (let attempt = 0; attempt < 80; attempt += 1) {
            const page = document.querySelector('.settings-dialog [data-automation-settings]')
            const embeddedSwitch = page?.querySelector('button[role="switch"][aria-label="允许 Agent 操控内置浏览器"]')
            if (embeddedSwitch instanceof HTMLButtonElement
              && embeddedSwitch.getAttribute('aria-checked') === 'false'
              && !embeddedSwitch.disabled
              && (page?.querySelectorAll('.automation-origin-input-row input').length ?? 0) === 0) {
              return true
            }
            await new Promise(resolve => setTimeout(resolve, 25))
          }
          return false
        })()`)
      }
    } else {
      writeFileSync(
        verificationArtifactPath(automationCapture),
        (await captureVerifiedPage(win)).toPNG(),
      )
    }
    const automationSettingsReady = automationDefaultReady && automationExpandedReady

    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' })
    const settingsFocusRestored = (await win.webContents.executeJavaScript(`(async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const dialog = document.querySelector('.settings-dialog[role="dialog"]')
        const closed = dialog === null || (dialog instanceof HTMLElement && !dialog.checkVisibility())
        if (closed && document.activeElement instanceof HTMLElement && document.activeElement.id === 'open-settings') {
          return true
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return false
    })()`)) as boolean

    // 设置中心已移除「内置插件」与「ChatGPT 订阅」分类，改为在独立插件管理页验证内置配置卡片与 Host 设置实时刷新事件。
    await clickTrustedElement(win, '[data-view="plugins"]')
    const pluginsReady = (await win.webContents.executeJavaScript(`(async () => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const page = document.querySelector('.plugin-manager--standalone')
        const builtinCards = page?.querySelectorAll('[aria-label="内置插件"] .plugin-manager__row') ?? []
        const terminalButton = page?.querySelector('[aria-label="配置 终端"]')
        const chatgptButton = page?.querySelector('[aria-label="配置 ChatGPT 订阅"]')
        const extraGroup = page?.querySelector('[aria-label="扩展配置"]')
        const extraText = extraGroup?.textContent ?? ''
        if (page instanceof HTMLElement && page.checkVisibility()
          && builtinCards.length === 5
          && terminalButton instanceof HTMLButtonElement
          && chatgptButton instanceof HTMLButtonElement) {
          return !extraText.includes('浏览器与桌面操控') && !extraText.includes('ChatGPT 订阅')
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return false
    })()`)) as boolean
    const pluginsCapture = 'verify-plugins.png'
    writeFileSync(
      verificationArtifactPath(pluginsCapture),
      (await captureVerifiedPage(win)).toPNG(),
    )
    const hostSettingsEventsReady = (await win.webContents.executeJavaScript(`(async () => {
      const host = window.dshDesktop.host
      const document = await host.call('describeSettings', {})
      const namespace = document.namespaces.find(item => item.ns === 'shell')
      if (!namespace || typeof namespace.value.timeoutMs !== 'number') return false
      const summary = window.document.querySelector('.plugin-manager--standalone [aria-label="配置 终端"]')
      if (!(summary instanceof HTMLButtonElement)) return false
      summary.click()
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (window.document.getElementById('plugin-shell-timeoutMs') instanceof HTMLInputElement) break
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      const next = namespace.value.timeoutMs + 1
      try {
        await host.call('mutateSettings', { ns: 'shell', expectedRevision: namespace.revision,
          ops: [{ op: 'set', path: ['timeoutMs'], value: next }] })
        for (let attempt = 0; attempt < 80; attempt += 1) {
          if (window.document.getElementById('plugin-shell-timeoutMs')?.value === String(next)) return true
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        return false
      } finally {
        await host.call('mutateSettings', { ns: 'shell', ops: [Object.hasOwn(namespace.user ?? {}, 'timeoutMs')
          ? { op: 'set', path: ['timeoutMs'], value: namespace.user.timeoutMs }
          : { op: 'unset', path: ['timeoutMs'] }] })
        window.document.querySelector('.plugin-manager__back')?.click()
      }
    })()`)) as boolean
    console.log('desktop-shell-verify-local: host-settings-events', { hostSettingsEventsReady })
    await clickTrustedElement(win, '[data-view="conversation"]')
    await new Promise(resolve => {
      setTimeout(resolve, 180)
    })

    const allSettingsPagesReady =
      appearanceBackgroundsReady &&
      modelsReady &&
      pluginsReady &&
      settingsPagesReady &&
      archivedSessionsReady &&
      permanentDeletionReady &&
      automationSettingsReady
    console.log('desktop-shell-verify-local: settings-pages', {
      appearanceBackgroundsReady,
      modelsReady,
      pluginsReady,
      presetsReady: settingsPagesReady,
      archivedSessionsReady,
      permanentDeletionReady,
      automationSettingsReady,
      allSettingsPagesReady,
    })

    // 旧版字段仍能读取，但不能覆盖代码区域的固定排版。
    settingsController.publish(
      settingsStore.update({
        editorFontSize: 18,
        editorLineHeight: 'relaxed',
        editorLigatures: true,
      }),
    )
    await new Promise(resolve => {
      setTimeout(resolve, 120)
    })
    const editorAppearanceApplied = (await win.webContents.executeJavaScript(`(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      document.querySelector('[data-view="files"]')?.click()
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const editor = document.querySelector('.code-editor .cm-editor')
        const scroller = editor?.querySelector('.cm-scroller')
        if (editor instanceof HTMLElement && scroller instanceof HTMLElement) {
          globalThis.__mydshVerifyEditor = editor
          const style = getComputedStyle(scroller)
          return document.documentElement.style.getPropertyValue('--code-editor-font-size') === ''
            && document.documentElement.style.getPropertyValue('--code-editor-line-height') === ''
            && document.documentElement.style.getPropertyValue('--code-editor-font-ligatures') === ''
            && style.fontSize === '14px'
            && Math.abs(Number.parseFloat(style.lineHeight) - 22) <= 0.5
            && style.fontVariantLigatures === 'normal'
        }
        await sleep(25)
      }
      return false
    })()`)) as boolean
    settingsController.publish(
      settingsStore.update({
        editorFontSize: 13,
        editorLineHeight: 'standard',
        editorLigatures: false,
      }),
    )
    await new Promise(resolve => {
      setTimeout(resolve, 120)
    })
    const editorAppearanceRestored = (await win.webContents.executeJavaScript(`(() => {
      const editor = document.querySelector('.code-editor .cm-editor')
      const scroller = editor?.querySelector('.cm-scroller')
      const sameEditor = globalThis.__mydshVerifyEditor === editor
      Reflect.deleteProperty(globalThis, '__mydshVerifyEditor')
      document.querySelector('[data-view="conversation"]')?.click()
      if (!(scroller instanceof HTMLElement)) return false
      const style = getComputedStyle(scroller)
      return sameEditor
        && document.documentElement.style.getPropertyValue('--code-editor-font-size') === ''
        && document.documentElement.style.getPropertyValue('--code-editor-line-height') === ''
        && document.documentElement.style.getPropertyValue('--code-editor-font-ligatures') === ''
        && style.fontSize === '14px'
        && Math.abs(Number.parseFloat(style.lineHeight) - 22) <= 0.5
        && style.fontVariantLigatures === 'normal'
    })()`)) as boolean
    const editorAppearanceReady = editorAppearanceApplied && editorAppearanceRestored

    // 已下线的浮岛间隙旧字段兼容读取，但界面与红绿灯均固定投影为官方 8px 默认值。
    settingsController.publish(settingsStore.update({ islandGap: 6 }))
    await new Promise(resolve => {
      setTimeout(resolve, 120)
    })
    const compactGapIgnored =
      isTrafficLightAlignedForGap(win, 8) &&
      ((await win.webContents.executeJavaScript(`(async () => {
      await Promise.all(document.querySelector('.app-shell').getAnimations({ subtree: true })
        .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished))
      const navigation = document.querySelector('.sidebar-island')
      const main = document.querySelector('.main-island')
      const information = document.querySelector('.info-island')
      const composer = document.querySelector('.composer-card')
      const navigationDivider = document.querySelector('.panel-divider--navigation')
      const informationDivider = document.querySelector('.panel-divider--information')
      const gap = Number.parseFloat(document.documentElement.style.getPropertyValue('--window-gap'))
      if (!(navigation instanceof HTMLElement)
        || !(main instanceof HTMLElement)
        || !(information instanceof HTMLElement)
        || !(composer instanceof HTMLElement)
        || !(navigationDivider instanceof HTMLElement)
        || !(informationDivider instanceof HTMLElement)) return false
      const navigationRect = navigation.getBoundingClientRect()
      const mainRect = main.getBoundingClientRect()
      const informationRect = information.getBoundingClientRect()
      const composerRect = composer.getBoundingClientRect()
      const outerRadius = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--window-outer-radius'))
      const expectedRadius = Math.max(0, outerRadius - 8)
      const alignedCorners = [navigation, main, information].every(island =>
        Math.abs(Number.parseFloat(getComputedStyle(island).borderBottomLeftRadius) - expectedRadius) <= 0.1)
      return gap === 8
        && alignedCorners
        && Math.abs(navigationRect.left - 8) <= 1
        && Math.abs(mainRect.left - navigationRect.right - 8) <= 1
        && Math.abs(informationRect.left - mainRect.right - 8) <= 1
        && composerRect.top > mainRect.top
        && composerRect.left >= mainRect.left + 17
        && Math.abs(composerRect.left + composerRect.right - mainRect.left - mainRect.right) <= 1
        && Math.abs(informationRect.right - (innerWidth - 8)) <= 1
        && Math.abs(navigationRect.bottom - (innerHeight - 8)) <= 1
        && Math.abs(informationRect.bottom - (innerHeight - 8)) <= 1
        && Math.abs((document.querySelector('[data-composer-readings]')?.getBoundingClientRect().bottom ?? composerRect.bottom)
          - (mainRect.bottom - 1 - Number.parseFloat(getComputedStyle(document.querySelector('.app-shell')).getPropertyValue('--composer-bottom-inset')))) <= 1
        && Math.abs(navigationDivider.getBoundingClientRect().width - 8) <= 1
        && Math.abs(informationDivider.getBoundingClientRect().width - 8) <= 1
    })()`)) as boolean)
    settingsController.publish(settingsStore.update({ islandGap: 20 }))
    await new Promise(resolve => {
      setTimeout(resolve, 120)
    })
    const wideGapIgnored =
      isTrafficLightAlignedForGap(win, 8) &&
      ((await win.webContents.executeJavaScript(`(() => {
      const sidebar = document.querySelector('.sidebar-island')
      if (!(sidebar instanceof HTMLElement)) return false
      const outer = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--window-outer-radius'))
      return document.documentElement.style.getPropertyValue('--window-gap').trim() === '8px'
        && document.documentElement.style.getPropertyValue('--window-edge').trim() === '8px'
        && Math.abs(Number.parseFloat(getComputedStyle(sidebar).borderBottomLeftRadius) - Math.max(0, outer - 8)) <= 0.1
    })()`)) as boolean)
    settingsController.publish(settingsStore.update({ islandGap: 8 }))
    await new Promise(resolve => {
      setTimeout(resolve, 120)
    })
    const islandGapSettingReady =
      compactGapIgnored &&
      wideGapIgnored &&
      isTrafficLightAlignedForGap(win, 8) &&
      ((await win.webContents.executeJavaScript(`(() => {
        const sidebar = document.querySelector('.sidebar-island')
        if (!(sidebar instanceof HTMLElement)) return false
        const outer = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--window-outer-radius'))
        return document.documentElement.style.getPropertyValue('--window-gap').trim() === '8px'
          && Math.abs(Number.parseFloat(getComputedStyle(sidebar).borderBottomLeftRadius) - Math.max(0, outer - 8)) <= 0.1
      })()`)) as boolean)

    let reducedTransparencyReady = false
    let forcedColorsReady = false
    if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3')
    try {
      await emulateVerificationMedia(win, [
        { name: 'prefers-reduced-transparency', value: 'reduce' },
      ])
      await new Promise(resolve => {
        setTimeout(resolve, 200)
      })
      reducedTransparencyReady = (await win.webContents.executeJavaScript(`(() => {
        const canvas = document.querySelector('.background-layer')
        const islands = [...document.querySelectorAll('.app-shell > .island:not([hidden])')]
        const canvasStyle = getComputedStyle(canvas)
        return matchMedia('(prefers-reduced-transparency: reduce)').matches
          && canvasStyle.opacity === '1'
          && canvasStyle.backgroundImage === 'none'
          && canvasStyle.backgroundColor !== 'rgba(0, 0, 0, 0)'
          && canvasStyle.backgroundColor !== 'transparent'
          && islands.every(island => getComputedStyle(island).backdropFilter === 'none')
      })()`)) as boolean
      await emulateVerificationMedia(win, [{ name: 'forced-colors', value: 'active' }])
      forcedColorsReady = (await win.webContents.executeJavaScript(`(() => {
        const controls = [...document.querySelectorAll('.app-shell > .island:not([hidden]), .mode-rail, .composer-card')]
        return matchMedia('(forced-colors: active)').matches
          && controls.length === 5
          && controls.every(control => getComputedStyle(control).borderTopStyle === 'solid'
            && Math.abs(Number.parseFloat(getComputedStyle(control).borderTopWidth) * devicePixelRatio - Math.max(1, Math.floor(devicePixelRatio))) < .1)
      })()`)) as boolean
    } finally {
      await emulateVerificationMedia(win)
    }
    console.log('desktop-shell-verify-local: accessibility', {
      reducedTransparencyReady,
      forcedColorsReady,
    })

    console.log('desktop-shell-verify-local: captures')
    // 媒体仿真恢复后等待实际绘制，防止默认主题截图保留上一帧的高对比配色。
    await win.webContents.executeJavaScript(
      `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
    )
    await verifyEmptyConversationLayout(win)
    const defaultCapture = 'verify.png'
    writeFileSync(
      verificationArtifactPath(defaultCapture),
      (await captureVerifiedPage(win)).toPNG(),
    )
    const previousThemeSource = nativeTheme.themeSource
    nativeTheme.themeSource = 'dark'
    await new Promise(resolve => {
      setTimeout(resolve, 220)
    })
    await verifyEmptyConversationLayout(win)
    const darkCapture = 'verify-dark.png'
    writeFileSync(verificationArtifactPath(darkCapture), (await captureVerifiedPage(win)).toPNG())
    await clickTrustedElement(win, '#open-settings')
    await clickTrustedElement(win, '.settings-nav__items > [role="menuitem"]:nth-child(2)')
    const darkSettingsReadable = (await win.webContents.executeJavaScript(`(async () => {
      const dialog = document.querySelector('.settings-dialog[role="dialog"]')
      await Promise.allSettled(
        dialog
          .getAnimations({ subtree: true })
          .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map(animation => animation.finished),
      )
      const select = dialog.querySelector('.settings-select')
      if (!(select instanceof HTMLElement)) return false
      const style = getComputedStyle(select)
      const channels = color => (color.match(/[0-9.]+/g) ?? []).slice(0, 3).map(Number)
      return channels(style.backgroundColor).every(channel => channel < 100)
        && channels(style.color).every(channel => channel > 150)
    })()`)) as boolean
    writeFileSync(
      verificationArtifactPath('verify-settings-dark.png'),
      (await captureVerifiedPage(win)).toPNG(),
    )
    await verifySettingsHeader()
    const waitForSettingsClosed = async (): Promise<void> => {
      await win.webContents.executeJavaScript(`(async () => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const dialog = document.querySelector('.settings-dialog[role="dialog"]')
          const modalVisible = [...document.querySelectorAll('.ant-modal-wrap')].some(node => node.checkVisibility())
          if (dialog === null && !modalVisible) return
          await new Promise(resolve => setTimeout(resolve, 25))
        }
      })()`)
    }
    await clickTrustedElement(win, '.settings-dialog button[aria-label="关闭设置"]')
    await waitForSettingsClosed()
    nativeTheme.themeSource = 'light'
    await new Promise(resolve => {
      setTimeout(resolve, 140)
    })

    // 已下线的画布配色旧字段不再覆盖固定投影（始终跟随界面配色）。
    settingsController.publish(settingsStore.update({ canvasColorScheme: 'dark' }))
    await new Promise(resolve => {
      setTimeout(resolve, 140)
    })
    const canvasColorSchemeReady = (await win.webContents.executeJavaScript(`(() => {
      const root = document.documentElement
      const canvas = document.querySelector('.background-layer')
      const canvasStyle = canvas instanceof HTMLElement ? getComputedStyle(canvas) : null
      return matchMedia('(prefers-color-scheme: light)').matches
        && root.dataset.canvasColorScheme === 'follow-interface'
        && root.style.getPropertyValue('--canvas-layer-bg').trim() === 'var(--canvas-bg)'
        && canvasStyle !== null
        && canvasStyle.backgroundImage.includes('radial-gradient')
        && !canvasStyle.backgroundImage.includes('rgb(16, 17, 19)')
        && canvasStyle.backgroundColor !== 'rgb(16, 17, 19)'
    })()`)) as boolean
    settingsController.publish(settingsStore.update({ canvasColorScheme: 'follow-interface' }))
    await new Promise(resolve => {
      setTimeout(resolve, 120)
    })

    // 已下线的透明度、遮罩与背景图旧字段不再覆盖官方默认值：画布采用中心实色、边缘通透径向渐变，遮罩固定 0.84，无背景图。
    settingsController.publish(
      settingsStore.update({
        canvasTransparency: 0.42,
        contentScrimOpacity: 0.82,
      }),
    )
    await new Promise(resolve => {
      setTimeout(resolve, 220)
    })
    const material = (await win.webContents.executeJavaScript(`(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const island = document.querySelector('.sidebar-island')
        const mainIsland = document.querySelector('.main-island')
        const content = document.querySelector('.workspace-view')
        const background = document.querySelector('.background-layer')
        const search = document.querySelector('.session-search-trigger')
        const tabs = document.querySelector('.mode-rail .view-tabs')
        const canvasAlpha = document.documentElement.style.getPropertyValue('--canvas-alpha').trim()
        if (island instanceof HTMLElement
          && mainIsland instanceof HTMLElement
          && content instanceof HTMLElement
          && background instanceof HTMLElement
          && search instanceof HTMLElement
          && tabs instanceof HTMLElement
          && Math.abs(Number(canvasAlpha) - 0.68) <= 0.001) {
          const islandStyle = getComputedStyle(island)
          const backgroundStyle = getComputedStyle(background)
          const rail = tabs.closest('.mode-rail')
          const railStyle = getComputedStyle(rail)
          const sidebarRect = island.getBoundingClientRect()
          const mainRect = mainIsland.getBoundingClientRect()
          const transparent = value => value === 'rgba(0, 0, 0, 0)' || value === 'transparent'
          return {
            backdrop: islandStyle.backdropFilter,
            opaquePoints: [...document.querySelectorAll('.app-shell > .island:not([hidden])')].map(element => {
              const rect = element.getBoundingClientRect()
              return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
            }),
            // 采样左侧与主浮岛核心缝隙（避开垂直中点缩放胶囊），对比窗口四边避开圆角与阴影的外缘点。
            centerGapPoint: mainRect.left > sidebarRect.right + 1
              ? { x: (sidebarRect.right + mainRect.left) / 2, y: mainRect.top + mainRect.height * 0.35 }
              : null,
            edgePoints: [
              { x: 24, y: 3 },
              { x: 3, y: 24 },
              { x: 3, y: innerHeight - 24 },
              { x: 3, y: innerHeight / 2 },
            ],
            viewport: { width: innerWidth, height: innerHeight },
            scrimAlpha: document.documentElement.style.getPropertyValue('--scrim-alpha').trim(),
            canvasAlpha,
            canvasOpacity: backgroundStyle.opacity,
            canvasBackgroundImage: backgroundStyle.backgroundImage,
            canvasImage: document.documentElement.style.getPropertyValue('--canvas-image').trim(),
            contentBackground: getComputedStyle(content).backgroundImage,
            topControlsReadable: rail.contains(tabs)
              && !transparent(railStyle.backgroundColor)
              && railStyle.backdropFilter === 'none'
              && railStyle.opacity === '1',
          }
        }
        await sleep(25)
      }
      return null
    })()`)) as null | {
      backdrop: string
      opaquePoints: Array<{ x: number; y: number }>
      centerGapPoint: { x: number; y: number } | null
      edgePoints: Array<{ x: number; y: number }>
      viewport: { width: number; height: number }
      scrimAlpha: string
      canvasAlpha: string
      canvasOpacity: string
      canvasBackgroundImage: string
      canvasImage: string
      contentBackground: string
      topControlsReadable: boolean
    }
    const materialCapture = 'verify-material.png'
    const materialImage = await captureVerifiedPage(win)
    writeFileSync(verificationArtifactPath(materialCapture), materialImage.toPNG())
    const materialBitmap = materialImage.toBitmap()
    let semiTransparentPixels = 0
    let materialMinimumAlpha = 255
    for (let offset = 3; offset < materialBitmap.length; offset += 4) {
      const alpha = materialBitmap[offset] ?? 255
      materialMinimumAlpha = Math.min(materialMinimumAlpha, alpha)
      if (alpha > 0 && alpha < 255) semiTransparentPixels += 1
    }
    const semiTransparentPixelRatio =
      materialBitmap.length === 0 ? 0 : semiTransparentPixels / (materialBitmap.length / 4)
    const captureSize = materialImage.getSize()
    const sampleMaterialAlpha = (point: { x: number; y: number }): number => {
      const x = Math.min(
        captureSize.width - 1,
        Math.max(0, Math.floor((point.x * captureSize.width) / (material?.viewport.width ?? 1))),
      )
      const y = Math.min(
        captureSize.height - 1,
        Math.max(0, Math.floor((point.y * captureSize.height) / (material?.viewport.height ?? 1))),
      )
      return materialBitmap[(y * captureSize.width + x) * 4 + 3] ?? 255
    }
    const nativeIslandsOpaque =
      material !== null && material.opaquePoints.every(point => sampleMaterialAlpha(point) === 255)
    const edgeAlphas = material === null ? [] : material.edgePoints.map(sampleMaterialAlpha)
    const minEdgeAlpha = edgeAlphas.length === 0 ? 255 : Math.min(...edgeAlphas)
    const centerGapAlpha =
      material?.centerGapPoint === null || material === null
        ? null
        : sampleMaterialAlpha(material.centerGapPoint)
    const radialTransparencyReady =
      minEdgeAlpha > 0 &&
      minEdgeAlpha < 232 &&
      centerGapAlpha !== null &&
      centerGapAlpha >= 245 &&
      centerGapAlpha > minEdgeAlpha + 25
    const mediumCanvasReady =
      material !== null &&
      nativeIslandsOpaque &&
      material.canvasImage === 'none' &&
      material.canvasOpacity === '1' &&
      material.canvasBackgroundImage.includes('radial-gradient') &&
      (nativeTransparency || windowController.read().canvasComposition === 'acrylic'
        ? semiTransparentPixelRatio > 0 &&
          semiTransparentPixelRatio < 0.25 &&
          radialTransparencyReady
        : materialBitmap.length > 0 && materialMinimumAlpha === 255)
    const windowClipState = windowController.read()
    const windowClipProjection = await win.webContents.executeJavaScript(`(() => {
      const bounds = document.body.getBoundingClientRect()
      const style = document.documentElement.style
      return { width: bounds.width, height: bounds.height, scale: devicePixelRatio,
        radius: Number.parseFloat(style.getPropertyValue('--window-clip-radius')),
        right: Number.parseFloat(style.getPropertyValue('--window-clip-right')),
        bottom: Number.parseFloat(style.getPropertyValue('--window-clip-bottom')) }
    })()`)
    const nativeWindowClipReady =
      process.platform !== 'win32' ||
      windowClipState.canvasComposition !== 'acrylic' ||
      (windowClipState.canvasClip !== undefined &&
        Math.abs(
          windowClipProjection.radius * windowClipProjection.scale -
            windowClipState.canvasClip.radius,
        ) < 0.1 &&
        // Windows 离屏页按 1 倍绘制，原生 HWND 仍按强制缩放；只核对该页能覆盖的投影。
        // 前台验收须严格对齐实际窗口像素，不能用离屏投影替代。
        Math.abs(
          (windowClipProjection.width - windowClipProjection.right) * windowClipProjection.scale -
            (VERIFY_BACKGROUND
              ? Math.min(
                  windowClipProjection.width * windowClipProjection.scale,
                  windowClipState.canvasClip.width,
                )
              : windowClipState.canvasClip.width),
        ) < 0.1 &&
        Math.abs(
          (windowClipProjection.height - windowClipProjection.bottom) * windowClipProjection.scale -
            (VERIFY_BACKGROUND
              ? Math.min(
                  windowClipProjection.height * windowClipProjection.scale,
                  windowClipState.canvasClip.height,
                )
              : windowClipState.canvasClip.height),
        ) < 0.1)
    console.log('desktop-shell-verify-local: medium-canvas', {
      canvasOpacity: material?.canvasOpacity,
      semiTransparentPixelRatio,
      minEdgeAlpha,
      centerGapAlpha,
      radialTransparencyReady,
      nativeIslandsOpaque,
      topControlsReadable: material?.topControlsReadable,
      mediumCanvasReady,
      nativeWindowClipReady,
      ...(nativeWindowClipReady
        ? {}
        : { windowClipState, windowClipProjection, windowBounds: win.getBounds() }),
    })

    // 即使旧配置将 canvasTransparency 设为 1，画布仍保持中心实色、边缘通透的径向渐变与原透明窗口合成。
    settingsController.publish(settingsStore.update({ canvasTransparency: 1 }))
    await new Promise(resolve => {
      setTimeout(resolve, 160)
    })
    const clearCanvas = (await win.webContents.executeJavaScript(`(() => {
      const background = document.querySelector('.background-layer')
      const shell = document.querySelector('.app-shell')
      const root = document.querySelector('#root')
      const islands = [...document.querySelectorAll('.app-shell > .island:not([hidden])')]
      if (!(background instanceof HTMLElement)
        || !(shell instanceof HTMLElement)
        || !(root instanceof HTMLElement)
        || islands.length !== 3) return null
      const backgroundRect = background.getBoundingClientRect()
      const backgroundStyle = getComputedStyle(background)
      const transparent = value => value === 'rgba(0, 0, 0, 0)' || value === 'transparent'
      return {
        canvasAlpha: document.documentElement.style.getPropertyValue('--canvas-alpha').trim(),
        canvasOpacity: backgroundStyle.opacity,
        canvasBackgroundImage: backgroundStyle.backgroundImage,
        shellOpacity: getComputedStyle(shell).opacity,
        islandsKeepOwnOpacity: islands.every(island => getComputedStyle(island).opacity === '1'),
        transparentRoots: [document.documentElement, document.body, root]
          .every(element => transparent(getComputedStyle(element).backgroundColor)),
        canvasCoversWindow: Math.abs(backgroundRect.left) <= 1
          && Math.abs(backgroundRect.top) <= 1
          && Math.abs(backgroundRect.right - innerWidth) <= 1
          && Math.abs(backgroundRect.bottom - innerHeight) <= 1,
      }
    })()`)) as null | {
      canvasAlpha: string
      canvasOpacity: string
      canvasBackgroundImage: string
      shellOpacity: string
      islandsKeepOwnOpacity: boolean
      transparentRoots: boolean
      canvasCoversWindow: boolean
    }
    const clearCapture = 'verify-clear.png'
    const clearImage = await captureVerifiedPage(win)
    const clearBitmap = clearImage.toBitmap()
    let transparentPixels = 0
    let minimumCanvasAlpha = 255
    for (let offset = 3; offset < clearBitmap.length; offset += 4) {
      const alpha = clearBitmap[offset] ?? 255
      minimumCanvasAlpha = Math.min(minimumCanvasAlpha, alpha)
      if (alpha > 0 && alpha < 255) transparentPixels += 1
    }
    writeFileSync(verificationArtifactPath(clearCapture), clearImage.toPNG())
    const transparentPixelRatio =
      clearBitmap.length === 0 ? 0 : transparentPixels / (clearBitmap.length / 4)
    const clearCanvasReady =
      clearCanvas !== null &&
      Math.abs(Number(clearCanvas.canvasAlpha) - 0.68) <= 0.001 &&
      clearCanvas.canvasOpacity === '1' &&
      clearCanvas.canvasBackgroundImage.includes('radial-gradient') &&
      clearCanvas.shellOpacity === '1' &&
      clearCanvas.islandsKeepOwnOpacity &&
      clearCanvas.canvasCoversWindow &&
      (nativeTransparency || windowController.read().canvasComposition === 'acrylic'
        ? clearCanvas.transparentRoots && transparentPixelRatio > 0
        : !clearCanvas.transparentRoots && minimumCanvasAlpha === 255)
    console.log('desktop-shell-verify-local: clear-canvas', {
      ...clearCanvas,
      minimumCanvasAlpha,
      transparentPixelRatio,
      clearCanvasReady,
    })
    settingsController.publish(settingsStore.update({ canvasTransparency: 0.42 }))
    await new Promise(resolve => {
      setTimeout(resolve, 120)
    })

    if (process.platform === 'darwin' && !VERIFY_BACKGROUND) {
      const paintedSize = { width: 0, height: 0 }
      win.webContents.beginFrameSubscription(image => {
        Object.assign(paintedSize, image.getSize())
      })
      try {
        await new Promise<void>(resolve => {
          win.once('enter-full-screen', () => resolve())
          win.setFullScreen(true)
        })
        const fullscreenViewport = (await win.webContents.executeJavaScript(
          `({ width: innerWidth, height: innerHeight, bottom: document.querySelector('.app-shell').getBoundingClientRect().bottom })`,
        )) as { width: number; height: number; bottom: number }
        const fullscreenBounds = win.getContentBounds()
        const scale = screen.getDisplayMatching(fullscreenBounds).scaleFactor
        console.log('desktop-shell-verify-local: fullscreen', {
          fullscreenViewport,
          fullscreenBounds,
          paintedSize,
          scale,
        })
        if (
          Math.abs(fullscreenViewport.width - fullscreenBounds.width) > 1 ||
          Math.abs(fullscreenViewport.height - fullscreenBounds.height) > 1 ||
          Math.abs(fullscreenViewport.bottom - fullscreenViewport.height) > 1 ||
          Math.abs(paintedSize.width - fullscreenBounds.width * scale) > 1 ||
          Math.abs(paintedSize.height - fullscreenBounds.height * scale) > 1
        ) {
          throw new Error('全屏结束时页面或绘制帧未与原生窗口对齐。')
        }
        await new Promise<void>(resolve => {
          win.once('leave-full-screen', () => resolve())
          win.setFullScreen(false)
        })
      } finally {
        if (!win.isDestroyed()) win.webContents.endFrameSubscription()
      }
    }
    win.setSize(1_440, 900)
    await new Promise(resolve => {
      setTimeout(resolve, 140)
    })
    const largeLayoutStable = (await win.webContents.executeJavaScript(`(() => {
      const shell = document.querySelector('.app-shell')
      const topIslands = [...document.querySelectorAll('.app-shell > .island:not([hidden])')]
      const dragRegion = document.querySelector('.window-drag-region')
      const toolbar = document.querySelector('.mode-rail')
      const searchTrigger = document.querySelector('.session-search-trigger')
      const shellStyle = shell instanceof HTMLElement ? getComputedStyle(shell) : null
      const expectedTop = Number.parseFloat(shellStyle?.getPropertyValue('--window-edge') ?? '')
        + (shell?.getAttribute('data-session-tabs-visible') === 'true'
          ? Number.parseFloat(shellStyle?.getPropertyValue('--session-chrome-height') ?? '')
            + Number.parseFloat(shellStyle?.getPropertyValue('--window-gap') ?? '') : 0)
      return shell instanceof HTMLElement
        && Math.abs(shell.getBoundingClientRect().width - innerWidth) <= 1
        && document.querySelectorAll('.app-shell > .island:not([hidden])').length === 3
        && topIslands.every(island => Math.abs(island.getBoundingClientRect().top
          - (island.classList.contains('sidebar-island') ? Number.parseFloat(shellStyle.getPropertyValue('--window-edge')) : expectedTop)) <= 1)
        && dragRegion instanceof HTMLElement
        && Math.abs(dragRegion.getBoundingClientRect().bottom - innerHeight) <= 1
        && toolbar instanceof HTMLElement
        && Math.abs(toolbar.getBoundingClientRect().left - Number.parseFloat(shellStyle.getPropertyValue('--window-edge'))) <= 1
        && Math.abs(toolbar.getBoundingClientRect().width - Number.parseFloat(shellStyle.getPropertyValue('--mode-rail-width'))) <= 1
        && toolbar.scrollWidth <= toolbar.clientWidth + 1
        && searchTrigger instanceof HTMLElement
        && searchTrigger.getBoundingClientRect().left >= document.querySelector('.project-selector').getBoundingClientRect().right
        && searchTrigger.textContent.trim() === ''
    })()`)) as boolean
    const largeCapture = 'verify-large.png'
    writeFileSync(verificationArtifactPath(largeCapture), (await captureVerifiedPage(win)).toPNG())
    await clickTrustedElement(win, '#open-settings')
    await verifySettingsHeader()
    writeFileSync(
      verificationArtifactPath('verify-settings-large.png'),
      (await captureVerifiedPage(win)).toPNG(),
    )
    await clickTrustedElement(win, '.settings-dialog button[aria-label="关闭设置"]')
    await waitForSettingsClosed()

    await dragTrustedElementHorizontally(win, '.panel-divider--information', -220)
    const wideInformationResizable = (await win.webContents.executeJavaScript(`(() => {
      const shell = document.querySelector('.app-shell')
      const main = document.querySelector('.main-island')
      const information = document.querySelector('.info-island')
      const divider = document.querySelector('.panel-divider--information')
      if (!(shell instanceof HTMLElement)
        || !(main instanceof HTMLElement)
        || !(information instanceof HTMLElement)
        || !(divider instanceof HTMLElement)) return false
      const shellStyle = getComputedStyle(shell)
      const expandedWidth = Number.parseFloat(shellStyle.getPropertyValue('--information-expanded-width'))
      const windowGap = Number.parseFloat(shellStyle.getPropertyValue('--window-gap'))
      const mainRect = main.getBoundingClientRect()
      const informationRect = information.getBoundingClientRect()
      return Math.abs(expandedWidth - 480) <= 1
        && informationRect.width > 420
        && Math.abs(informationRect.width - expandedWidth) <= 1
        && mainRect.width + windowGap >= 420
        && divider.getAttribute('aria-valuemax') === null
        && document.documentElement.scrollWidth === innerWidth
    })()`)) as boolean
    win.setSize(1_200, 760)
    await new Promise(resolve => {
      setTimeout(resolve, 140)
    })
    const mediumToolbarCompact = (await win.webContents.executeJavaScript(`(() => {
      const shell = document.querySelector('.app-shell')
      const information = document.querySelector('.info-island')
      const main = document.querySelector('.main-island')
      const informationDivider = document.querySelector('.panel-divider--information')
      const searchTrigger = document.querySelector('.session-search-trigger')
      const viewTabs = document.querySelector('.view-tabs')
      if (!(shell instanceof HTMLElement)
        || !(information instanceof HTMLElement)
        || !(main instanceof HTMLElement)
        || !(informationDivider instanceof HTMLElement)
        || !(searchTrigger instanceof HTMLElement)
        || !(viewTabs instanceof HTMLElement)) return false
      const shellStyle = getComputedStyle(shell)
      const expandedWidth = Number.parseFloat(shellStyle.getPropertyValue('--information-expanded-width'))
      const rail = document.querySelector('.mode-rail').getBoundingClientRect()
      const searchRect = searchTrigger.getBoundingClientRect()
      const tabsRect = viewTabs.getBoundingClientRect()
      return Math.abs(expandedWidth - 480) <= 1
        && Math.abs(rail.width - Number.parseFloat(shellStyle.getPropertyValue('--mode-rail-width'))) <= 1
        && information.getClientRects().length === 0 && information.inert
        && getComputedStyle(main).paddingRight === '0px'
        && Math.abs(main.getBoundingClientRect().right - innerWidth + Number.parseFloat(shellStyle.getPropertyValue('--window-edge'))) <= 1
        && getComputedStyle(informationDivider).display === 'none'
        && Math.abs(searchRect.width - 28) <= 1
        && searchTrigger.textContent.trim() === ''
        && searchRect.left >= document.querySelector('.project-selector').getBoundingClientRect().right
        && tabsRect.left > rail.left && tabsRect.right < rail.right
        && searchRect.bottom < tabsRect.top
        && document.documentElement.scrollWidth === innerWidth
    })()`)) as boolean
    win.setSize(1_440, 900)
    await new Promise(resolve => {
      setTimeout(resolve, 140)
    })
    await win.webContents.executeJavaScript(`(() => {
      const divider = document.querySelector('.panel-divider--information')
      if (!(divider instanceof HTMLElement)) return false
      divider.focus()
      return divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    })()`)
    await new Promise(resolve => {
      setTimeout(resolve, 100)
    })
    const mediumToolbarReset = (await win.webContents.executeJavaScript(`(() => {
      const shell = document.querySelector('.app-shell')
      const information = document.querySelector('.info-island')
      const viewTabs = document.querySelector('.view-tabs')
      if (!(shell instanceof HTMLElement)
        || !(information instanceof HTMLElement)
        || !(viewTabs instanceof HTMLElement)) return false
      const expandedWidth = Number.parseFloat(getComputedStyle(shell)
        .getPropertyValue('--information-expanded-width'))
      const tabsRect = viewTabs.getBoundingClientRect()
      return Math.abs(expandedWidth - 260) <= 1
        && information.checkVisibility() && !information.inert
        && Math.abs(information.getBoundingClientRect().width - expandedWidth) <= 1
        && tabsRect.left >= 10 && tabsRect.right <= 86
        && tabsRect.width < expandedWidth
    })()`)) as boolean
    const mediumToolbarStable =
      wideInformationResizable && mediumToolbarCompact && mediumToolbarReset
    console.log('desktop-shell-verify-local: medium-toolbar', {
      wideInformationResizable,
      mediumToolbarCompact,
      mediumToolbarReset,
    })

    // 归档验收可能换过当前会话：给当前会话补一份读数，窄窗口才有可验收的读数行。
    const readingsSessionId = (await win.webContents.executeJavaScript(
      `document.querySelector('.work-tab-panel:not([hidden]) .composer-card')?.dataset.sessionId ?? null`,
    )) as string | null
    if (readingsSessionId !== null)
      await seedComposerReadings(win, readingsSessionId, frame => {
        win.webContents.send(HOST_CHANNELS.sessionFrame, frame)
      })

    win.setSize(900, 600)
    await new Promise(resolve => {
      setTimeout(resolve, 140)
    })
    const narrowRightPanelHidden = (await win.webContents.executeJavaScript(`(() => {
      const shell = document.querySelector('.app-shell')
      const information = document.querySelector('.info-island')
      const main = document.querySelector('.main-island')
      if (!(shell instanceof HTMLElement)
        || !(information instanceof HTMLElement)
        || !(main instanceof HTMLElement)) return false
      const style = getComputedStyle(shell)
      const edge = Number.parseFloat(style.getPropertyValue('--window-edge'))
      const expectedTop = edge + (shell.dataset.sessionTabsVisible === 'true'
        ? Number.parseFloat(style.getPropertyValue('--session-chrome-height'))
          + Number.parseFloat(style.getPropertyValue('--window-gap')) : 0)
      const mainRect = main.getBoundingClientRect()
      const conversationRect = main.querySelector('.workspace-view:not([hidden])')?.getBoundingClientRect()
      const composerRect = document.querySelector('.composer-card')?.getBoundingClientRect()
      const footer = document.querySelector('.composer-card footer')
      const buttons = footer === null ? [] : [...footer.querySelectorAll('button')]
        .filter(button => button.checkVisibility()).map(button => button.getBoundingClientRect())
      const footerRect = footer?.getBoundingClientRect()
      const composerControlsFit = footerRect !== undefined && buttons.length >= 4
        && buttons.every((button, index) => button.width >= 24
          && button.left >= footerRect.left && button.right <= footerRect.right
          && (index === 0 || button.left >= buttons[index - 1].right))
      return information.inert && information.hidden && information.getClientRects().length === 0
        && document.querySelector('[data-composer-readings]') !== null
        && getComputedStyle(main).paddingRight === '0px'
        && Math.abs(mainRect.top - expectedTop) <= 1
        && Math.abs(mainRect.right - (innerWidth - edge)) <= 1
        && conversationRect !== undefined && Math.abs(conversationRect.right - mainRect.right) <= 2
        && composerRect !== undefined && composerRect.width >= mainRect.width - 96
        && composerRect.left >= mainRect.left + 16 && composerRect.right <= mainRect.right - 16
        && composerControlsFit
        && document.querySelector('.info-capsule, .info-compact-backdrop') === null
    })()`)) as boolean
    console.log('desktop-shell-verify-local: narrow-right-panel', { narrowRightPanelHidden })
    writeFileSync(
      verificationArtifactPath('verify-narrow-right-hidden.png'),
      (await captureVerifiedPage(win)).toPNG(),
    )
    await clickTrustedElement(win, '[aria-label="打开命令与 Skill"]')
    await clickTrustedElement(win, '[id="命令候选-category:skill"]')
    const narrowPickerReady = (await win.webContents.executeJavaScript(`(async () => {
      for (let attempt = 0; attempt < 80 && document.querySelector('#composer-command-listbox') === null; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      const panel = document.querySelector('[role="dialog"][aria-label="命令与 Skill"]')
      const list = panel?.querySelector('[role="listbox"]')
      if (!(panel instanceof HTMLElement) || !(list instanceof HTMLElement)) return false
      const bounds = panel.getBoundingClientRect()
      return bounds.top >= 12 && bounds.left >= 12 && bounds.right <= innerWidth - 12
        && bounds.height <= 361 && panel.querySelector('input') === document.activeElement
        && getComputedStyle(list).overflowY === 'auto' && list.clientHeight > 0
    })()`)) as boolean
    if (!narrowPickerReady) throw new Error('窄窗口 Skill 面板没有保持边界、搜索焦点和滚动区域')
    writeFileSync(
      verificationArtifactPath('verify-skill-picker-light.png'),
      (await captureVerifiedPage(win)).toPNG(),
    )
    const pickerTheme = nativeTheme.themeSource
    try {
      nativeTheme.themeSource = 'dark'
      await new Promise(resolve => {
        setTimeout(resolve, 150)
      })
      writeFileSync(
        verificationArtifactPath('verify-skill-picker-dark.png'),
        (await captureVerifiedPage(win)).toPNG(),
      )
    } finally {
      nativeTheme.themeSource = pickerTheme
    }
    await clickTrustedElement(win, '[aria-label="关闭候选面板"]')
    const narrowSettingsFits = (await win.webContents.executeJavaScript(`(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const shell = document.querySelector('.app-shell')
      const navigation = document.querySelector('.navigation-island')
      const main = document.querySelector('.main-island')
      const dragRegion = document.querySelector('.window-drag-region')
      const information = document.querySelector('.info-island')
      const informationDivider = document.querySelector('.panel-divider--information')
      const searchTrigger = document.querySelector('.session-search-trigger')
      const shellStyle = shell instanceof HTMLElement ? getComputedStyle(shell) : null
      const expectedTop = Number.parseFloat(shellStyle?.getPropertyValue('--window-edge') ?? '')
        + (shell?.getAttribute('data-session-tabs-visible') === 'true'
          ? Number.parseFloat(shellStyle?.getPropertyValue('--session-chrome-height') ?? '')
            + Number.parseFloat(shellStyle?.getPropertyValue('--window-gap') ?? '') : 0)
      const shellFits = shell instanceof HTMLElement
        && document.documentElement.scrollWidth === innerWidth
        && document.documentElement.scrollHeight === innerHeight
        && navigation instanceof HTMLElement
        && main instanceof HTMLElement
        && Math.abs(document.querySelector('.sidebar-island').getBoundingClientRect().top - Number.parseFloat(shellStyle.getPropertyValue('--window-edge'))) <= 1
        && Math.abs(main.getBoundingClientRect().top - expectedTop) <= 1
        && dragRegion instanceof HTMLElement
        && Math.abs(dragRegion.getBoundingClientRect().bottom - innerHeight) <= 1
        && information instanceof HTMLElement
        && information.getClientRects().length === 0 && information.inert
        && informationDivider instanceof HTMLElement
        && getComputedStyle(informationDivider).display === 'none'
        && searchTrigger instanceof HTMLElement
        && Math.abs(searchTrigger.getBoundingClientRect().width - 28) <= 1
        && searchTrigger.getBoundingClientRect().left >= document.querySelector('.project-selector').getBoundingClientRect().right
        && searchTrigger.textContent.trim() === ''
      if (!shellFits) return false
      const trigger = document.querySelector('#open-settings')
      if (!(trigger instanceof HTMLButtonElement)) return false
      trigger.click()
      // Modal 的动画在下一帧启动，等待入场完成后再测量弹层锚点。
      await sleep(350)
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const settingsDialog = document.querySelector('.settings-dialog[role="dialog"]')
        const settingsContent = settingsDialog?.querySelector('.settings-content')
        if (settingsDialog instanceof HTMLElement && settingsDialog.checkVisibility()
          && settingsContent instanceof HTMLElement) {
          let fontFamily = settingsDialog.querySelector('[role="combobox"][aria-label="界面字体"]')
          if (!(fontFamily instanceof HTMLInputElement)) {
            const appearance = [...settingsDialog.querySelectorAll('.settings-nav__items > [role="menuitem"]')]
              .find(button => button.textContent?.trim() === '外观')
            if (appearance instanceof HTMLElement) appearance.click()
            await sleep(25)
            fontFamily = settingsDialog.querySelector('[role="combobox"][aria-label="界面字体"]')
          }
          if (!(fontFamily instanceof HTMLInputElement)) return false
          await Promise.all(settingsDialog.getAnimations().map(animation => animation.finished))
          fontFamily.focus()
          fontFamily.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
          await sleep(150)
          const listbox = document.getElementById(fontFamily.getAttribute('aria-controls') ?? '')
          const popup = listbox?.closest('.ant-select-dropdown')
          if (!(popup instanceof HTMLElement)) return false
          await Promise.all(popup.getAnimations().map(animation => animation.finished))
          const popupRect = popup.getBoundingClientRect()
          const triggerRect = fontFamily.closest('.settings-select').getBoundingClientRect()
          const rect = settingsDialog.getBoundingClientRect()
          const listboxRect = listbox instanceof HTMLElement ? listbox.getBoundingClientRect() : null
          const customSelectFits = listboxRect !== null
            && Math.abs(popupRect.width - triggerRect.width) <= 2
            && Math.abs(popupRect.left - triggerRect.left) <= 2
            && popupRect.top >= triggerRect.bottom
            && popupRect.top - triggerRect.bottom <= 8
            && listboxRect.left >= rect.left && listboxRect.top >= rect.top
            && listboxRect.right <= rect.right && listboxRect.bottom <= rect.bottom
            && settingsDialog.querySelector('select') === null
          const fits = rect.left >= 0 && rect.top >= 0
            && rect.right <= innerWidth && rect.bottom <= innerHeight
            && settingsContent.scrollWidth <= settingsContent.clientWidth + 1
            && document.documentElement.scrollWidth === innerWidth
            && customSelectFits
          return fits
        }
        await sleep(25)
      }
      return false
    })()`)) as boolean
    const narrowCapture = 'verify-narrow.png'
    await verifySettingsHeader()
    writeFileSync(verificationArtifactPath(narrowCapture), (await captureVerifiedPage(win)).toPNG())
    const narrowSettingsClosePresent = (await win.webContents.executeJavaScript(
      `document.querySelector('.settings-dialog button[aria-label="关闭设置"]') instanceof HTMLButtonElement`,
    )) as boolean
    if (narrowSettingsClosePresent) {
      await clickTrustedElement(win, '.settings-dialog button[aria-label="关闭设置"]')
      await waitForSettingsClosed()
    }

    settingsController.publish(settingsStore.update({ canvasTransparency: 0.32 }))
    nativeTheme.themeSource = previousThemeSource
    win.setSize(1_280, 800)
    await new Promise(resolve => {
      setTimeout(resolve, 140)
    })

    // 越出视口的浮层会让根元素重新可滚动；外壳必须钉在视口上，且根偏移必须被复位。
    const shellPinnedToViewport = (await win.webContents.executeJavaScript(`(async () => {
      const shell = document.querySelector('.app-shell')
      const root = document.getElementById('root')
      if (!(shell instanceof HTMLElement) || !(root instanceof HTMLElement)) return false
      const before = shell.getBoundingClientRect()
      const probe = document.createElement('div')
      probe.dataset.verifyOverflowProbe = 'true'
      probe.style.cssText = 'position:absolute;left:0;top:820px;width:8px;height:8px'
      root.appendChild(probe)
      document.documentElement.scrollTop = 24
      document.body.scrollTop = 24
      root.scrollTop = 24
      const scrolled = shell.getBoundingClientRect()
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const restored = document.documentElement.scrollTop === 0 && document.body.scrollTop === 0 && root.scrollTop === 0
      probe.remove()
      return Math.abs(before.top) <= 1 && Math.abs(before.bottom - innerHeight) <= 1
        && Math.abs(scrolled.top - before.top) <= 1 && Math.abs(scrolled.bottom - before.bottom) <= 1
        && restored
    })()`)) as boolean
    console.log('desktop-shell-verify-local: shell-pinned', { shellPinnedToViewport })

    await win.webContents.executeJavaScript(`document.querySelector('.panel-divider--information')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))`)
    await new Promise(resolve => {
      setTimeout(resolve, 450)
    })
    await openRightPanel('file-outline-tasks')
    const rightTabsReady = (await win.webContents.executeJavaScript(`(async () => {
      const wait = async predicate => {
        for (let attempt = 0; attempt < 80; attempt += 1) {
          if (predicate()) return true
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        return false
      }
      const selected = () => document.querySelector('.info-island [role="tab"][aria-selected="true"]')
      if (selected()?.dataset.islandId !== 'file-outline-tasks') return false
      if (document.querySelector('.right-island-tabs [data-tab-id="conversation"]')) return false
      const buttons = [...document.querySelectorAll('.right-island-tabs [role="tab"]:not([data-overflow])')]
      const allTabs = [...document.querySelectorAll('.right-island-tabs [role="tab"]')]
      const hiddenTabs = allTabs.filter(button => button.hasAttribute('data-overflow'))
      if (allTabs.length !== 2 || buttons.length === 0 || buttons.length + hiddenTabs.length !== allTabs.length
        || !['file-outline-tasks', 'git-history'].every(id => allTabs.some(button => button.dataset.tabId === id))
        || (hiddenTabs.length > 0 && !document.querySelector('.right-island-more'))
        || buttons.some(button => button.textContent.trim() !== ''
        || !button.getAttribute('aria-label') || !button.querySelector('svg'))
        || getComputedStyle(document.querySelector('.right-island-tabs')).overflowX !== 'clip') return false
      const nextTabId = allTabs[(allTabs.findIndex(button => button.dataset.tabId === 'file-outline-tasks') + 1) % allTabs.length].dataset.tabId
      selected().focus()
      selected().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      if (!await wait(() => selected()?.dataset.islandId === nextTabId)) return false
      if (!document.querySelector('[data-island-id="file-outline-tasks"]')) document.querySelector('[aria-label="更多右侧栏目"][aria-haspopup="menu"]')?.click()
      if (!await wait(() => document.querySelector('[data-island-id="file-outline-tasks"]'))) return false
      document.querySelector('[data-island-id="file-outline-tasks"]').click()
      if (!await wait(() => selected()?.dataset.islandId === 'file-outline-tasks')) return false
      // 普通右栏切走会卸载；重新选中后，收放侧栏应保留当前内容节点。
      const content = document.querySelector('.info-island .workspace-island-content')
      const strip = document.querySelector('.info-island .right-island-tabs').getBoundingClientRect()
      const tab = selected().getBoundingClientRect()
      if (tab.left < strip.left - 1 || tab.right > strip.right + 1) return false
      document.querySelector('[aria-label="收起右侧栏目"]').click()
      if (!await wait(() => document.querySelector('.app-shell').dataset.informationCollapsed === 'true')) return false
      document.querySelector('[aria-label="展开右侧浮岛"]').click()
      if (!await wait(() => document.querySelector('.app-shell').dataset.informationCollapsed !== 'true')) return false
      return document.querySelector('.info-island .workspace-island-content') === content
        && document.querySelector('.right-island-rail') === null
    })()`)) as boolean
    await openRightPanel('git-history')
    console.log('desktop-shell-verify-local: right-tabs', { rightTabsReady })
    if (!rightTabsReady) throw new Error('右侧顶部标签切换、键盘导航或面板保留验收失败')

    setVerificationStage('complete')
    if (VERIFY_BACKGROUND && (win.isVisible() || win.isFocused()))
      throw new Error('后台验收意外显示了窗口或占用了系统焦点')

    const report = createFailedVerifyReport('complete', new Error(''), true)
    delete report.error
    Object.assign(report, {
      backgroundVerification: VERIFY_BACKGROUND,
      nativeFullscreenChecked: process.platform === 'darwin' && !VERIFY_BACKGROUND,
      startupScreen: startupScreenVerified,
      startupCapture: 'verify-startup.png',
      startupDarkCapture: 'verify-startup-dark.png',
      appMounted: initial.renderer,
      sessionInfoReady,
      hostSettingsEventsReady,
      uiActive: true,
      frame: true,
      islandCount: initial.islandCount,
      canvasCount: 1,
      pageScrollable: initial.pageScrollable,
      shellPinnedToViewport,
      transparentRoots: clearCanvas?.transparentRoots ?? false,
      settingsDialog,
      settingsFocusInside: settingsAudit.focusInside && settingsFocusRestored,
      settingsLayerCount: settingsAudit.layerCount,
      settingsAccent: settingsStore.read().accentColor,
      settingsCanvasOpacity: material?.canvasAlpha ?? '',
      settingsCanvasAlpha: Number(material?.canvasAlpha ?? 0),
      settingsCanvasImageApplied: material?.canvasImage === 'none',
      canvasColorSchemeReady,
      mediumCanvasReady,
      topControlsReadable: material?.topControlsReadable ?? false,
      clearCanvasReady,
      settingsPanelFits: settingsAudit.panelFits,
      settingsPagesReady: allSettingsPagesReady,
      islandGapSettingReady,
      appearanceCapture,
      appearanceBackgroundsCapture,
      modelsCapture,
      modelMenuCapture,
      modelMenuReady,
      pluginsCapture,
      automationCapture,
      automationSettingsReady,
      presetsCapture,
      frameOpacity: clearCanvas?.shellOpacity ?? '',
      islandsOpaque: initial.islandsOpaque,
      uiDensityReady: initial.densityReady,
      uiBodyFontSize: initial.bodyFontSize,
      uiBodyFontWeight: initial.bodyFontWeight,
      uiProjectActionHeight: initial.projectActionHeight,
      uiTabHeight: initial.tabHeight,
      uiFontScaleReady: fontScaleReady,
      editorAppearanceReady,
      uiAccentContrastReady: accentContrastReady,
      titlebarClearanceReady: initial.titlebarClearanceReady,
      windowControlsReady,
      islandTop: initial.islandTop,
      topToolbarReady: initial.topToolbarReady,
      toolbarLayoutIndependent: initial.toolbarLayoutIndependent,
      workspaceHeaderRemoved: initial.workspaceHeaderRemoved,
      panelCapsulesReady: initial.panelCapsulesReady,
      panelCollapseReady,
      panelResizeReady,
      panelDragLineReady,
      trajectoryFocusReady: initial.trajectoryFocusReady,
      projectGroupingReady,
      sessionActionsReady,
      sessionActionsCapture,
      sessionSearchReady,
      sessionTabsReady,
      sessionStreamReady: sessionStreamFrameObserved,
      hostRecoveryRetainsEditor,
      hostEventStreamReady: hostEventStreamFrameObserved,
      sessionCostRemoved: initial.sessionCostRemoved,
      commandPaletteReady: commandPaletteAudit.ready,
      commandPaletteOptionCount: commandPaletteAudit.optionCount ?? 0,
      commandPalettePortal: commandPaletteAudit.portal === true,
      commandPaletteAriaReady: commandPaletteAudit.ariaReady === true,
      desktopBridgeVersion: commandPaletteAudit.bridgeVersion ?? 0,
      fileReferenceReady: fileReferenceAudit.ready,
      commandExecutionReady: commandExecutionAudit.ready,
      attachmentDropReady: attachmentDropAudit.ready,
      commandLifecycleReady,
      searchCapture: sessionSearchState.dialogPresent ? searchCapture : '',
      zoomFactor: win.webContents.getZoomFactor(),
      nativeSettingsTrigger: settingsDialog,
      nativeSettingsDialog: settingsDialog,
      nativeSettingsSidebarRaised: settingsAudit.navCount === 6,
      nativeSettingsTopmost: settingsAudit.modal,
      nativeAppearanceEntry: settingsAudit.appearanceIndex >= 0,
      nativeAppearanceEntryPlaced: settingsAudit.appearanceIndex === 1,
      appearanceMenu: appearanceMenuItem.enabled,
      appearanceAccelerator: appearanceMenuItem.accelerator ?? '',
      capture: defaultCapture,
      darkCapture,
      darkSettingsReadable,
      largeCapture,
      largeLayoutStable,
      mediumToolbarStable,
      narrowCapture,
      narrowSettingsFits,
      narrowRightPanelHidden,
      nativeCapture: materialCapture,
      clearCapture,
      blank: false,
      productName: app.getName(),
      productVersion: app.getVersion(),
      singleInstanceLock: app.hasSingleInstanceLock(),
      updateMenu: updateMenuItem.label === '检查更新…' && updateMenuItem.enabled,
      ownership: currentHost?.ownership,
      reportedVersion: currentHost?.identity.reportedVersion,
      settingsRevision: settingsStore.read().revision,
      settingsPersisted: settingsStore.read().canvasTransparency === 0.32,
      terminalReady,
      ...projectViews,
      nativeWindow: {
        platform: process.platform,
        transparent: nativeTransparency,
        transparentPixelRatio,
        canvasComposition: windowController.read().canvasComposition,
      },
      nativeWindowClipReady,
    })
    const ok =
      startupScreenVerified &&
      nativeWindowClipReady &&
      initial.title === PRODUCT_NAME &&
      initial.renderer &&
      initial.islandCount === 3 &&
      !initial.pageScrollable &&
      initial.islandsOpaque &&
      initial.densityReady &&
      fontScaleReady &&
      editorAppearanceReady &&
      accentContrastReady &&
      initial.titlebarClearanceReady &&
      windowControlsReady &&
      initial.topToolbarReady &&
      initial.toolbarLayoutIndependent &&
      initial.workspaceHeaderRemoved &&
      initial.panelCapsulesReady &&
      panelCollapseReady &&
      panelResizeReady &&
      panelDragLineReady &&
      projectGroupingReady &&
      sessionActionsReady &&
      sessionSearchReady &&
      sessionTabsReady &&
      sessionStreamFrameObserved &&
      hostRecoveryRetainsEditor &&
      hostEventStreamFrameObserved &&
      initial.sessionCostRemoved &&
      modelMenuReady &&
      sessionInfoReady &&
      hostSettingsEventsReady &&
      commandPaletteAudit.ready &&
      commandPaletteAudit.closedAfterClear === true &&
      commandPaletteAudit.bridgeVersion === 23 &&
      fileReferenceAudit.ready &&
      fileReferenceAudit.closedAfterClear === true &&
      attachmentDropAudit.ready &&
      commandExecutionAudit.ready &&
      commandExecutionAudit.draftCleared === true &&
      commandExecutionAudit.paletteClosed === true &&
      commandLifecycleReady &&
      win.webContents.getZoomFactor() === 1 &&
      initial.trajectoryVisible &&
      initial.trajectoryFocusReady &&
      initial.composerCapped &&
      projectViews.fileTreeReady &&
      projectViews.deepFileTreeReady &&
      projectViews.fileViewerReady &&
      projectViews.fileTabsReady &&
      projectViews.fileWorkspacePersisted &&
      projectViews.fileEditorReady &&
      projectViews.fileUnsavedGuardReady &&
      projectViews.contentSearchReady &&
      projectViews.projectTasksOnlyReady &&
      projectViews.imageViewerReady &&
      projectViews.syntaxHighlightingReady &&
      projectViews.fileCursorReady &&
      projectViews.quickOpenReady &&
      projectViews.taskSuggestionsRemoved &&
      projectViews.projectTasksReady &&
      projectViews.composerVisibilityReady &&
      terminalReady &&
      projectViews.sourceControlReady &&
      projectViews.sourceControlWriteReady &&
      projectViews.sourceControlFailureReady &&
      projectViews.uncommittedChangesReady &&
      projectViews.changeFileListReadable &&
      projectViews.contextualRightPanelReady &&
      projectViews.diffResponsiveReady &&
      projectViews.pendingInteractionsReady &&
      settingsDialog &&
      settingsAudit.focusInside &&
      settingsFocusRestored &&
      settingsAudit.panelFits &&
      settingsAudit.layerCount === 0 &&
      settingsAudit.navCount === 6 &&
      settingsAudit.appearanceIndex === 1 &&
      settingsAudit.modal &&
      darkSettingsReadable &&
      allSettingsPagesReady &&
      canvasColorSchemeReady &&
      islandGapSettingReady &&
      reducedTransparencyReady &&
      forcedColorsReady &&
      material !== null &&
      material.backdrop === 'none' &&
      material.canvasImage === 'none' &&
      Math.abs(Number(material.canvasAlpha) - 0.68) <= 0.001 &&
      Math.abs(Number(material.scrimAlpha) - 0.84) <= 0.001 &&
      material.contentBackground.includes('linear-gradient') &&
      mediumCanvasReady &&
      material.topControlsReadable &&
      clearCanvasReady &&
      largeLayoutStable &&
      shellPinnedToViewport &&
      mediumToolbarStable &&
      narrowSettingsFits &&
      narrowRightPanelHidden &&
      appearanceMenuItem.enabled
    finishVerify(report, ok ? 0 : 1)
  }

  const verify = async (): Promise<void> => {
    if (!VERIFY_MODE || VERIFY_INTERACTIVE || currentHost === undefined || verifyReported) return
    try {
      if (!sameRendererPage(win.webContents.getURL())) {
        throw new Error('真实 Electron 验收必须位于受信任的本地 renderer')
      }
      if (process.argv.includes('--verify-workbench')) {
        const setVerificationScheme = (scheme: 'light' | 'dark') => {
          settingsController.publish(settingsStore.update({ colorScheme: scheme }))
        }
        const captureVerificationPng = async (name: string) => {
          const path = verificationArtifactPath(name)
          writeFileSync(path, (await captureVerifiedPage(win)).toPNG())
          return path
        }
        await verifyWorkspaceTabs(
          win,
          setVerificationScheme,
          captureVerificationPng,
          frame => {
            win.webContents.send(HOST_CHANNELS.sessionFrame, frame)
          },
          (sessionId, running) => {
            win.webContents.send(HOST_CHANNELS.hostFrame, {
              type: 'host/session-status',
              sessionId,
              running,
            })
          },
        )
        await verifyWorkbenchAdjustments({
          win,
          appearance: setVerificationScheme,
          capture: captureVerificationPng,
        })
        const report = createFailedVerifyReport('complete', new Error(''), true)
        delete report.error
        Object.assign(report, { appMounted: true, uiActive: true, blank: false })
        finishVerify(report, 0)
      } else if (VERIFY_DATABASE) {
        await verifyDatabaseWorkspace(
          win,
          scheme => {
            settingsController.publish(settingsStore.update({ colorScheme: scheme }))
          },
          async name => {
            const path = verificationArtifactPath(name)
            writeFileSync(path, (await captureVerifiedPage(win)).toPNG())
            return path
          },
        )
        const report = createFailedVerifyReport('complete', new Error(''), true)
        delete report.error
        Object.assign(report, { appMounted: true, uiActive: true, blank: false })
        finishVerify(report, 0)
      } else if (VERIFY_SSH) {
        await verifySshWorkspace(
          win,
          scheme => {
            settingsController.publish(settingsStore.update({ colorScheme: scheme }))
          },
          async name => {
            const path = verificationArtifactPath(name)
            writeFileSync(path, (await captureVerifiedPage(win)).toPNG())
            return path
          },
        )
        const report = createFailedVerifyReport('complete', new Error(''), true)
        delete report.error
        Object.assign(report, { appMounted: true, uiActive: true, blank: false })
        finishVerify(report, 0)
      } else await verifyLocalRenderer()
    } catch (error) {
      console.error('真实 Electron renderer 验收失败：', error)
      await captureVerifiedPage(win)
        .then(capture => {
          writeFileSync(verificationArtifactPath('verify-failure.png'), capture.toPNG())
        })
        .catch(() => {})
      finishVerify(createFailedVerifyReport(verificationStage, error, true), 1)
    } finally {
      if (!win.webContents.isDestroyed() && win.webContents.debugger.isAttached())
        win.webContents.debugger.detach()
    }
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
    setVerificationStage('startup')
    try {
      const previousThemeSource = nativeTheme.themeSource
      try {
        nativeTheme.themeSource = 'light'
        await win.webContents.executeJavaScript(
          `Promise.all([...document.images].map(image => image.decode()))`,
        )
        const inspectStartup = async (): Promise<{
          theme: string
          label: string
          fits: boolean
          plain: boolean
        }> => {
          return await win.webContents.executeJavaScript(`(() => {
            const panel = document.querySelector('.launch-window')
            const status = document.getElementById('startup-status')
            const dark = document.querySelector('.art-dark')
            if (!panel || !status || !dark) throw new Error('启动画面缺少主体')
            const bounds = status.getBoundingClientRect()
            return {
              theme: getComputedStyle(dark).display === 'none' ? 'light' : 'dark',
              label: status.textContent,
              fits: bounds.left > 0 && bounds.right < innerWidth && bounds.bottom < innerHeight,
              plain: document.querySelectorAll('[role="status"]').length === 1
                && !document.querySelector('a, button:not([data-window-action])')
                && document.querySelectorAll('[role="progressbar"]').length === 1
                && document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuetext') === status.textContent
                && document.querySelector('[role="progressbar"]')?.hidden === (document.documentElement.dataset.phase === 'ready')
                && (document.documentElement.dataset.platform === 'win32'
                  ? document.querySelectorAll('.window-controls button').length === 3
                    && document.querySelector('[data-window-action="toggle-maximize"]')?.disabled === true
                  : document.querySelectorAll('button').length === 0)
                && !document.body.textContent.includes('本机启动')
                && !document.body.textContent.includes('让 DSH'),
            }
          })()`)
        }
        const light = await inspectStartup()
        writeFileSync(
          verificationArtifactPath('verify-startup.png'),
          (await captureVerifiedPage(win)).toPNG(),
        )
        nativeTheme.themeSource = 'dark'
        await new Promise(resolve => {
          setTimeout(resolve, 120)
        })
        const dark = await inspectStartup()
        writeFileSync(
          verificationArtifactPath('verify-startup-dark.png'),
          (await captureVerifiedPage(win)).toPNG(),
        )
        // 系统仍为深色时，手动浅色必须优先；恢复为跟随系统后应回到深色。
        await win.webContents.executeJavaScript(
          `document.documentElement.dataset.colorScheme = 'light'`,
        )
        const manualLight = await inspectStartup()
        await win.webContents.executeJavaScript(
          `document.documentElement.dataset.colorScheme = 'dark'`,
        )
        nativeTheme.themeSource = 'light'
        const manualDark = await inspectStartup()
        await win.webContents.executeJavaScript(
          `document.documentElement.dataset.colorScheme = 'system'`,
        )
        /* oxlint-disable no-await-in-loop -- 同一启动页必须顺序切换阶段，不能并发覆盖状态。 */
        for (const [phase, label] of [
          ['initializing', '正在启动'],
          ['starting', '正在加载插件'],
          ['workspace', '正在准备工作空间'],
          ['ready', '启动成功'],
        ] as const) {
          await loadStartup(phase)
          const current = await inspectStartup()
          if (current.label !== label || !current.fits || !current.plain)
            throw new Error('启动状态文字或布局不正确')
        }
        /* oxlint-enable no-await-in-loop */
        win.webContents.debugger.attach('1.3')
        try {
          await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
            features: [
              { name: 'forced-colors', value: 'active' },
              { name: 'prefers-reduced-motion', value: 'reduce' },
            ],
          })
          const accessible = (await win.webContents.executeJavaScript(`(() => {
            const art = document.querySelector('.art-light')
            const status = document.getElementById('startup-status')
            return getComputedStyle(art).display === 'none' && status.checkVisibility()
              && getComputedStyle(status).color !== getComputedStyle(document.querySelector('.launch-window')).backgroundColor
              && document.getAnimations().length === 0
          })()`)) as boolean
          if (!accessible) throw new Error('启动页无障碍降级未生效')
        } finally {
          await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] })
          win.webContents.debugger.detach()
        }
        await loadStartup('initializing')
        // Windows 非整数缩放会将原生边框换算回 DIP，外框允许 2px 舍入差；内容仍严格检查是否溢出。
        const startupSizeTolerance = process.platform === 'win32' ? 2 : 0
        const [startupWidth = 0, startupHeight = 0] = win.getSize()
        startupScreenVerified =
          light.theme === 'light' &&
          dark.theme === 'dark' &&
          manualLight.theme === 'light' &&
          manualDark.theme === 'dark' &&
          light.fits &&
          dark.fits &&
          light.plain &&
          dark.plain &&
          Math.abs(startupWidth - 760) <= startupSizeTolerance &&
          Math.abs(startupHeight - 480) <= startupSizeTolerance &&
          !win.isResizable() &&
          applicationMenu.items.some(item =>
            item.submenu?.items.some(child => child.role === 'quit'),
          )
        if (!startupScreenVerified)
          throw new Error(
            '启动画面主题、布局或菜单退出入口验收失败：' +
              JSON.stringify({
                light,
                dark,
                manualLight,
                manualDark,
                size: win.getSize(),
                resizable: win.isResizable(),
                quit: applicationMenu.items.some(item =>
                  item.submenu?.items.some(child => child.role === 'quit'),
                ),
              }),
          )
      } finally {
        nativeTheme.themeSource = previousThemeSource
      }
    } catch (error) {
      finishVerify(createFailedVerifyReport('startup', error, false), 1)
      return
    }
    setVerificationStage('host')
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
