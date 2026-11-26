import type {
  DesktopCanvasColorScheme,
  DesktopColorScheme,
  DesktopEditorLineHeight,
  DesktopFontFamily,
} from '../../../shared/appearance.ts'
import type {
  DesktopDroppedImage,
  DesktopImageAttachment,
} from '../../../shared/image-attachments.ts'
import type { DesktopFileReferenceCandidate } from '../../../shared/file-references.ts'
import type { DesktopProjectEvent } from '../../../shared/project-events.ts'
import type {
  DesktopInteractionReceipt,
  DesktopInteractionSubmission,
  DesktopSessionFrame,
} from '../../../shared/session-live.ts'
import type { DesktopHostFrame } from '../../../shared/host-live.ts'
import type {
  DesktopCommandDescriptor,
  DesktopCommandExecutionResult,
  DesktopSkillDescriptor,
} from '../../../shared/session-capabilities.ts'
import type {
  DesktopTerminalCreateRequest,
  DesktopTerminalDescriptor,
  DesktopTerminalEvent,
} from '../../../shared/terminal.ts'
import type {
  DesktopProjectTaskDefinition,
  DesktopProjectTaskEvent,
  DesktopProjectTaskSaveRequest,
} from '../../../shared/project-tasks.ts'
import type { DesktopFileWorkspaceState } from '../../../shared/file-workspace-state.ts'
import type {
  AutomationDetectedBrowser,
  AutomationPermissionStatus,
  AutomationRuntimeStatus,
  AutomationSettings,
  AutomationSettingsPatch,
  AutomationTakeoverState,
} from '../../../shared/automation.ts'

export type BackgroundLayer = 'canvas' | 'sidebar' | 'content'
export type { DesktopEditorLineHeight, DesktopFontFamily } from '../../../shared/appearance.ts'
export type {
  DesktopDroppedImage,
  DesktopImageAttachment,
} from '../../../shared/image-attachments.ts'
export type {
  DesktopInteractionReceipt,
  DesktopInteractionSubmission,
  DesktopPendingInteraction,
  DesktopQuestionAnswerItem,
  DesktopQuestionItem,
} from '../../../shared/session-live.ts'

export interface DesktopSettings {
  version: number
  revision: number
  colorScheme: DesktopColorScheme
  canvasColorScheme: DesktopCanvasColorScheme
  fontFamily: DesktopFontFamily
  fontSize: number
  editorFontSize: number
  editorLineHeight: DesktopEditorLineHeight
  editorLigatures: boolean
  islandGap: number
  accentColor: string
  canvasTransparency: number
  contentScrimOpacity: number
  backgrounds: Record<BackgroundLayer, string | null>
  /** 读取损坏配置或缺失背景时，由主进程提供的非持久化降级说明。 */
  warning?: string
}

export interface BackgroundSelection {
  id: string
  layer: BackgroundLayer
  previewDataUrl: string
  sourceWidth: number
  sourceHeight: number
  targetAspectRatio: number
}

export type HostStatus =
  | {
      kind: 'ready'
      ownership: 'external' | 'spawned-by-desktop'
      identity: { reportedVersion?: string }
    }
  | {
      kind: 'connecting' | 'unavailable'
      message: string
    }

export interface DesktopSettingsApi {
  read(): Promise<DesktopSettings>
  update(
    patch: Partial<Omit<DesktopSettings, 'version' | 'revision' | 'backgrounds'>>,
  ): Promise<DesktopSettings>
  chooseBackground(request: {
    layer: BackgroundLayer
    targetAspectRatio: number
  }): Promise<BackgroundSelection | null>
  applyBackground(request: {
    selectionId: string
    crop: { x: number; y: number; width: number; height: number }
  }): Promise<DesktopSettings>
  cancelBackground(selectionId: string): Promise<void>
  clearBackground(layer: BackgroundLayer): Promise<DesktopSettings>
  onChanged(listener: (settings: DesktopSettings) => void): () => void
  onOpenRequested(listener: () => void): () => void
}

export interface DesktopHostApi {
  status(): Promise<HostStatus>
  call(operation: string, payload: Record<string, unknown>): Promise<unknown>
  searchSessions?(query: string): Promise<unknown>
  cancelSessionSearch?(): Promise<void>
  onStatusChanged(listener: (status: HostStatus) => void): () => void
  onSessionFrame?(listener: (frame: DesktopSessionFrame) => void): () => void
  onHostFrame?(listener: (frame: DesktopHostFrame) => void): () => void
}

export type DesktopSessionLogExportResult =
  { status: 'cancelled' } | { status: 'saved'; fileName: string }

export interface DesktopSessionExportsApi {
  save(sessionId: string): Promise<DesktopSessionLogExportResult>
}

export interface DesktopCommandsApi {
  list(sessionId: string): Promise<readonly DesktopCommandDescriptor[]>
  listSkills(sessionId: string): Promise<readonly DesktopSkillDescriptor[]>
  execute(request: {
    sessionId: string
    line: string
  }): Promise<DesktopCommandExecutionResult | undefined>
}

export interface DesktopAttachmentsApi {
  chooseImages(): Promise<readonly DesktopImageAttachment[]>
  importImages(images: readonly DesktopDroppedImage[]): Promise<readonly DesktopImageAttachment[]>
  resolveDroppedFiles?(
    projectId: string,
    files: readonly File[],
  ): Promise<readonly DesktopFileReferenceCandidate[]>
}

export interface DesktopInteractionsApi {
  respond(submission: DesktopInteractionSubmission): Promise<DesktopInteractionReceipt>
}

export interface DesktopProjectDescriptor {
  id: string
  name: string
  cwd: string
  displayPath: string
  sessionCount: number
  lastActivity: number
}

export type DesktopProjectOperation =
  | 'gitAiAnalyze'
  | 'gitAiCancel'
  | 'gitAiDiff'
  | 'gitAiValidate'
  | 'gitAiExecute'
  | 'gitAiRelease'
  | 'listDirectory'
  | 'readFile'
  | 'writeFile'
  | 'buildFileIndex'
  | 'queryFiles'
  | 'searchContent'
  | 'cancelContentSearch'
  | 'gitSummary'
  | 'gitDiff'
  | 'gitGraph'
  | 'gitCommit'
  | 'gitCommitFileDiff'
  | 'gitBranches'
  | 'gitReview'
  | 'gitStage'
  | 'gitUnstage'
  | 'gitCreateCommit'
  | 'revealInFinder'

export interface DesktopProjectsApi {
  list(): Promise<unknown>
  call(operation: DesktopProjectOperation, payload: Record<string, unknown>): Promise<unknown>
  onEvent?(listener: (event: DesktopProjectEvent) => void): () => void
}

export interface DesktopTerminalApi {
  create(request: DesktopTerminalCreateRequest): Promise<DesktopTerminalDescriptor>
  ready(terminalId: string): Promise<void>
  write(terminalId: string, data: string): Promise<void>
  resize(terminalId: string, columns: number, rows: number): Promise<void>
  close(terminalId: string): Promise<void>
  /** 触发当前窗口的原生编辑动作，剪贴板正文不经过 Remote 或返回给调用者。 */
  clipboard(action: 'copy' | 'paste'): Promise<void>
  onEvent(listener: (event: DesktopTerminalEvent) => void): () => void
}

export interface DesktopLifecycleApi {
  setDocumentEdited(edited: boolean): Promise<void>
  resolveClose(decision: 'proceed' | 'cancel'): Promise<void>
  onCloseRequested(listener: () => void): () => void
}

export interface DesktopWindowApi {
  read(): Promise<import('../../../shared/window.ts').DesktopWindowState>
  act(action: import('../../../shared/window.ts').DesktopWindowAction): Promise<void>
  onChanged(
    listener: (state: import('../../../shared/window.ts').DesktopWindowState) => void,
  ): () => void
}

export interface DesktopProjectTasksApi {
  list(projectId: string): Promise<readonly DesktopProjectTaskDefinition[]>
  save(request: DesktopProjectTaskSaveRequest): Promise<DesktopProjectTaskDefinition>
  remove(taskId: string): Promise<void>
  reorder(projectId: string, taskIds: readonly string[]): Promise<void>
  onEvent(listener: (event: DesktopProjectTaskEvent) => void): () => void
}

export interface DesktopFileWorkspaceApi {
  read(projectId: string): Promise<DesktopFileWorkspaceState | null>
  save(state: DesktopFileWorkspaceState): Promise<DesktopFileWorkspaceState>
}

export interface DesktopAutomationApi {
  readSettings(): Promise<AutomationSettings>
  updateSettings(patch: AutomationSettingsPatch): Promise<AutomationSettings>
  status(): Promise<AutomationRuntimeStatus>
  stopTakeover(): Promise<AutomationTakeoverState>
  checkPermissions(): Promise<AutomationPermissionStatus>
  openPermissionSettings(kind: 'accessibility' | 'screen-recording'): Promise<boolean>
  detectBrowsers(): Promise<readonly AutomationDetectedBrowser[]>
  testExternalBrowser(): Promise<{
    ok: boolean
    browser: string
    targetCount: number
    mode: 'managed' | 'attached'
  }>
  onStateChanged(listener: (state: AutomationTakeoverState) => void): () => void
  onSettingsChanged(listener: (settings: AutomationSettings) => void): () => void
}

/** 入口地址由主进程根据已验证的安装清单生成，前端不接受用户输入的脚本 URL。 */
export interface FrontendPluginDescriptor {
  id: string
  version: string
  entryUrl: string
  styleUrls?: readonly string[]
  previousVersion?: string
}

export interface DesktopBridge {
  browser?: {
    version: 1
    request(request: BrowserRequest): Promise<BrowserState>
    onChanged(listener: (state: BrowserState) => void): () => void
  }
  /** 已注册的公共业务 Remote；不暴露系统 IPC 或管理方法。 */
  remote: {
    call(endpoint: string, args: Record<string, unknown>, id?: string): Promise<unknown>
    cancelCall(id: string): Promise<void>
    follow(
      endpoint: string,
      args: Record<string, unknown>,
      onItem: (value: unknown) => void,
      onError: (message: string) => void,
    ): () => void
  }
  setPluginBusyReasons(reasons: string[]): Promise<void>
  getFrontendPlugins(): Promise<readonly FrontendPluginDescriptor[]>
  onFrontendPluginsChanged(listener: () => void): () => void
  version: number
  settings: DesktopSettingsApi
  host: DesktopHostApi
  sessionExports?: DesktopSessionExportsApi
  attachments?: DesktopAttachmentsApi
  interactions?: DesktopInteractionsApi
  commands?: DesktopCommandsApi
  projects?: DesktopProjectsApi
  terminal?: DesktopTerminalApi
  onTabAction?: (
    listener: (event: { action: 'close' | 'overview'; browserId?: string }) => void,
  ) => () => void
  lifecycle?: DesktopLifecycleApi
  window?: DesktopWindowApi
  projectTasks?: DesktopProjectTasksApi
  fileWorkspace?: DesktopFileWorkspaceApi
  automation?: DesktopAutomationApi
}

declare global {
  interface Window {
    dshDesktop?: DesktopBridge
  }
}
import type { BrowserRequest, BrowserState } from '../../../shared/browser.ts'
