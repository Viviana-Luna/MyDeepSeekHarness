import { SessionFollowProjection } from '../../../../shared/session-follow.ts'
import {
  DESKTOP_QUEUE_EDIT_MAX_BYTES,
  DESKTOP_QUEUE_PREVIEW_LIMIT,
  EMPTY_DESKTOP_QUEUE_SNAPSHOT,
  parseDesktopSessionFrame,
  type DesktopInteractionReceipt,
  type DesktopInteractionSubmission,
  type DesktopPendingInteraction,
  type DesktopQueueSnapshot,
  type DesktopSessionFrame,
  type DesktopSessionQueueAction,
} from '../../../../shared/session-live.ts'
import {
  normalizeSessionEvents,
  type CanonicalSessionEvent,
} from '../../../../shared/session-projection.ts'
import {
  DESKTOP_IMAGE_ATTACHMENT_MAX_COUNT,
  DESKTOP_IMAGE_ATTACHMENT_MAX_TOTAL_BYTES,
  type DesktopDroppedImage,
  type DesktopImageAttachment,
} from '../../../../shared/image-attachments.ts'
import { parseDesktopHostFrame, type DesktopHostFrame } from '../../../../shared/host-live.ts'
import {
  isDedicatedProjection,
  PluginProjectionCache,
  parsePluginProjectionChange,
} from '../../../../shared/plugin-projections.ts'
import {
  parseDesktopFileReferenceCandidates,
  type DesktopFileReferenceCandidate,
} from '../../../../shared/file-references.ts'
import {
  parseDesktopMessageFeedbackList,
  parseDesktopMessageFeedbackMutationResult,
  type DesktopMessageFeedbackList,
  type DesktopMessageFeedbackMutationResult,
  type DesktopMessageFeedbackRating,
} from '../../../../shared/message-feedback.ts'
import {
  parseDesktopSlashCommandLine,
  parseDesktopSlashInvocation,
  parseDesktopSessionForkResult,
  parseDesktopSessionRenameResult,
  parseDesktopSessionSearchResult,
  sanitizeDesktopSessionSearchQuery,
  type DesktopCommandExecutionResult,
  type DesktopSessionCommandDirectory,
  type DesktopSessionSearchResult,
} from '../../../../shared/session-capabilities.ts'
import {
  parseDesktopWorkspaceArchiveSnapshot,
  parseDesktopWorkspaceChangeResult,
  parseDesktopWorkspaceCreateResult,
  parseDesktopWorkspaceDeleteResult,
  parseDesktopWorkspaceListResult,
  parseDesktopWorkspaceOrderResult,
  type DesktopWorkspaceView,
} from '../../../../shared/workspace-capabilities.ts'
import {
  deriveProjects,
  deriveWorkspaceProjects,
  parseDesktopProjects,
  projectIdForCwd,
  resolveDraftProject,
  sessionsForProject,
  type ProjectSummary,
} from '../../domain/project.ts'
import {
  COMPOSER_HEIGHT_RANGE,
  clampComposerHeight,
  clampPanelWidth,
  defaultPanelWidth,
  persistPanelCollapsed,
  persistComposerHeight,
  clampConversationWidth,
  persistConversationWidth,
  persistPanelCapsulesPersistent,
  persistPanelWidth,
  readPanelLayout,
  type PanelLayoutStorage,
  type PanelName,
} from '../../domain/panel-layout.ts'
import {
  persistPinnedSessionIds,
  readPinnedSessionIds,
  reconcilePinnedSessionIds,
  togglePinnedSessionId,
} from '../../domain/session-pins.ts'
import { parseSessionList, type SessionSummary } from '../../domain/session.ts'
import {
  parseModelSelectionProjection,
  parsePermissionCatalog,
  parsePermissionCurrent,
  parseSelectedModelResponse,
  parseSessionModels,
  permissionCommandError,
  permissionSelectionFrom,
  sessionModelsWithSelection,
  type BusyEnterBehavior,
  type ModelSelection,
  type PermissionPresetOption,
  type PermissionSelection,
  type SessionModels,
} from '../../domain/session-controls.ts'
import type {
  BackgroundLayer,
  DesktopBridge,
  DesktopSessionLogExportResult,
  DesktopProjectOperation,
  DesktopSettings,
  HostStatus,
} from '../../platform/contracts.ts'
import type { IslandContribution, ModeContribution } from '../../plugins/registry.ts'
import { transitionWorkspaceView, type WorkspaceView } from './view.ts'
import { isRecord } from '../../../../shared/validation.ts'

const PROJECT_STORAGE_KEY = 'mydsh:selected-project'
const SESSION_HISTORY_PAGE_SIZE = 25

export type SessionCommandDirectoryStatus = 'idle' | 'loading' | 'ready' | 'stale' | 'error'
export type SessionArchiveCapability = 'checking' | 'available' | 'unavailable'
export type WorkspaceCapability = 'checking' | 'available' | 'legacy'

export interface SessionCommandDirectoryState {
  readonly status: SessionCommandDirectoryStatus
  readonly value: DesktopSessionCommandDirectory | null
  readonly error: string | null
  readonly commandError: string | null
  readonly skillError: string | null
}

export type SessionCommandExecutionState = {
  readonly phase: 'submitting' | 'running' | 'success' | 'error'
  readonly name: string
  readonly submittedDraft?: string
  readonly commandId?: string
  readonly text?: string
}

const EMPTY_COMMAND_DIRECTORY_STATE: SessionCommandDirectoryState = Object.freeze({
  status: 'idle',
  value: null,
  error: null,
  commandError: null,
  skillError: null,
})

/**
 * 供界面订阅的完整快照，包含 Host 数据的本地展示状态与用户的工作台偏好。
 * 写入快照只更新界面；改变 Host 数据必须通过桌面桥，持久化偏好须显式调用存储方法。
 */
export interface SessionFileAttachment {
  readonly id: string
  readonly name: string
  readonly bytes: number
  readonly status: 'uploading' | 'ready' | 'error'
  readonly receiptId?: string
  readonly error?: string
}

export interface WorkspaceSnapshot {
  planPreview: {
    readonly sessionId: string
    readonly id: string
    readonly text: string
    readonly previousRightIslandId: string
    readonly previousInformationCollapsed: boolean
  } | null
  initialized: boolean
  hostStatus: HostStatus | null
  settings: DesktopSettings | null
  sessions: readonly SessionSummary[]
  projects: readonly ProjectSummary[]
  workspaces: readonly DesktopWorkspaceView[]
  workspaceCapability: WorkspaceCapability
  selectedProjectId: string | null
  selectedSessionId: string | null
  openedSessionIds: readonly string[]
  unreadSessionIds: readonly string[]
  newSessionProjectId: string | null
  newSessionDraft: string
  activeView: WorkspaceView
  navigationView: WorkspaceView
  activeRightIslandId: string | null
  rightIslandsInitialized: boolean
  rightIslandSelectionRequest: { readonly islandId: string; readonly revision: number } | null
  history: unknown
  liveEvents: readonly CanonicalSessionEvent[]
  sessionQueue: DesktopQueueSnapshot
  pendingInteractions: readonly DesktopPendingInteraction[]
  loadingSessions: boolean
  loadingHistory: boolean
  loadingOlderHistory: boolean
  historyHasMore: boolean
  creatingSession: boolean
  sendingNewSession: boolean
  sendingMessage: boolean
  awaitingResponseSessionIds: readonly string[]
  pinnedSessionIds: readonly string[]
  archivedSessionIds: readonly string[]
  archivedSessions: readonly SessionSummary[]
  archivingSessionIds: readonly string[]
  sessionArchiveCapability: SessionArchiveCapability
  sessionDrafts: Readonly<Record<string, string>>
  sessionFiles: Readonly<Record<string, readonly SessionFileAttachment[]>>
  sessionAttachments: Readonly<Record<string, readonly DesktopImageAttachment[]>>
  choosingAttachments: boolean
  sessionCommandDirectory: SessionCommandDirectoryState
  sessionCommandExecution: SessionCommandExecutionState | null
  sessionModels: SessionModels | null
  sessionPermission: PermissionSelection | null
  permissionCatalog: readonly PermissionPresetOption[] | null
  loadingPermissionCatalog: boolean
  permissionCatalogError: string | null
  loadingSessionModels: boolean
  selectingSessionModel: boolean
  switchingPermissionPreset: boolean
  sessionModelsError: string | null
  queueUpdatingIds: readonly string[]
  settingsOpen: boolean
  hostSettingsRevision: number
  hostModelsRevision: number
  hostCredentialsRevision: number
  pluginRevision: number
  busyEnter: BusyEnterBehavior
  navigationCollapsed: boolean
  informationCollapsed: boolean
  navigationWidth: number
  informationWidth: number
  composerHeight: number
  conversationWidth: number | null
  panelCapsulesPersistent: boolean
  historyError: string | null
  error: string | null
}

type Listener = () => void

export interface IslandCollaborationIntent {
  readonly sessionId: string
  readonly rightSelectionRevision: number
}

interface IslandCollaboration {
  readonly previousRightIslandId: string | null
  readonly rightSelectionRevision: number
  readonly companionIslandId: string
}

function errorMessage(error: unknown): string {
  const message = (
    error instanceof Error ? error.message : typeof error === 'string' ? error : '桌面操作失败'
  )
    .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/u, '')
    .replace(/^(?:gateway|session)\/[\w-]+:\s*/u, '')
  // 移植层的技术诊断保留在后台；界面把已知的凭据缺失指向 MyDSH 自己的设置入口。
  if (/no API key for provider route/iu.test(message))
    return '当前模型尚未配置 API Key，请在“设置 → 模型”中配置对应提供方的凭据后重试。'
  return message
}

function parseSessionLogExportResult(value: unknown): DesktopSessionLogExportResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('主进程返回了无效的会话日志导出结果')
  }
  const result = value as Record<string, unknown>
  if (result.status === 'cancelled') return { status: 'cancelled' }
  if (
    result.status === 'saved' &&
    typeof result.fileName === 'string' &&
    result.fileName.length > 0 &&
    result.fileName.length <= 255 &&
    !result.fileName.includes('/') &&
    !result.fileName.includes('\\') &&
    !result.fileName.includes(String.fromCharCode(0))
  ) {
    return { status: 'saved', fileName: result.fileName }
  }
  throw new Error('主进程返回了无效的会话日志导出结果')
}

function createdSessionId(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const sessionId = (value as Record<string, unknown>).sessionId
  return typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined
}

function rememberedProjectId(storage: PanelLayoutStorage): string | null {
  try {
    const projectId = storage.getItem(PROJECT_STORAGE_KEY)
    return projectId === null || projectId === '' ? null : projectId
  } catch {
    return null
  }
}

function persistProjectId(storage: PanelLayoutStorage, projectId: string | null): void {
  try {
    storage.setItem(PROJECT_STORAGE_KEY, projectId ?? '')
  } catch {
    // localStorage 不可用时保留当前窗口内的项目筛选状态。
  }
}

function historyHasMore(value: unknown): boolean {
  return isRecord(value) && value.hasMore === true
}

function projectionSeq(value: unknown): number {
  if (!isRecord(value)) return -1
  if (isRecord(value.projections)) return projectionSeq(value.projections)
  return typeof value.asOfSeq === 'number' &&
    Number.isSafeInteger(value.asOfSeq) &&
    value.asOfSeq >= -1
    ? value.asOfSeq
    : -1
}

function mergeHistoryPages(current: unknown, older: unknown): unknown {
  const events = normalizeSessionEvents([
    ...normalizeSessionEvents(older),
    ...normalizeSessionEvents(current),
  ])
  const currentRecord = isRecord(current) ? { ...current } : {}
  // 合并后只保留规范事件；否则新版 page 的 records 会遮住已经前插的 events。
  delete currentRecord.records
  return {
    ...currentRecord,
    events,
    hasMore: historyHasMore(older),
  }
}

function mergeHistoryTail(current: unknown, tail: unknown): unknown {
  const events = normalizeSessionEvents(tail)
  const firstSeq = events[0]?.seq
  const previous = normalizeSessionEvents(current)
  const older =
    firstSeq !== undefined && previous.some(event => event.seq >= firstSeq - 1)
      ? previous.filter(event => Number.isInteger(event.seq) && event.seq < firstSeq)
      : []
  const record = { ...(isRecord(current) ? current : {}), ...(isRecord(tail) ? tail : {}) }
  delete record.records
  return {
    ...record,
    events: [...older, ...events],
    hasMore: older.length > 0 ? historyHasMore(current) : historyHasMore(tail),
  }
}

function reachesCurrentHistoryHead(
  olderEvents: readonly CanonicalSessionEvent[],
  firstSeq: number,
): boolean {
  return (
    olderEvents
      .filter(event => event.seq < firstSeq)
      .reduce((maximum, event) => Math.max(maximum, event.seq), -1) ===
    firstSeq - 1
  )
}

interface HostSessionOverlay {
  readonly revision: number
  readonly added?: SessionSummary
  readonly running?: boolean
  readonly detached?: boolean
}

type DesktopWorkspaceFrame = Extract<
  DesktopHostFrame,
  {
    readonly type:
      'host/workspace-changed' | 'host/workspace-removed' | 'host/workspace-order-changed'
  }
>

/**
 * 工作台的应用状态与会话操作入口，通过 DesktopBridge 请求主进程能力。
 * Host 拥有会话、Workspace、运行状态和队列；此处合并列表与事件，保留草稿和导航偏好。
 * snapshot 是界面当前读取的一份状态，各 Session 的临时状态按 ID 分开保存。
 * 文件正文与未保存导航保护由 ProjectWorkspaceProvider 管理，终端进程由主进程管理。
 */
export class WorkspaceStore {
  private snapshot: WorkspaceSnapshot
  private readonly listeners = new Set<Listener>()
  private notificationFrame: number | undefined
  private readonly disposers: Array<() => void> = []
  // 每类异步读取各有版本号；切换会话、重连或销毁后，迟到响应不得覆盖新状态。
  private historyGeneration = 0
  private readonly sessionHistories = new Map<
    string,
    Pick<WorkspaceSnapshot, 'history' | 'liveEvents' | 'historyHasMore'>
  >()
  private readonly fileSources = new Map<string, File>()
  private readonly pagingSessions = new Set<string>()
  private readonly historyErrors = new Map<string, string>()
  private readonly sessionViews = new Map<
    string,
    Pick<WorkspaceSnapshot, 'activeView' | 'sessionModels'> &
      Partial<
        Pick<
          WorkspaceSnapshot,
          | 'sessionModelsError'
          | 'loadingSessionModels'
          | 'selectingSessionModel'
          | 'switchingPermissionPreset'
        >
      >
  >()
  private readonly sessionControlProjections = new Map<
    string,
    {
      model: ModelSelection | null
      modelSeq: number
      permission: string | null
      permissionSeq: number
    }
  >()
  private readonly scopedSnapshots = new Map<
    string,
    { root: WorkspaceSnapshot; value: WorkspaceSnapshot }
  >()

  /** 分屏中的非焦点会话复用公开 Remote 流，卸载或失去可见性时释放订阅。 */
  observeSession(sessionId: string): () => void {
    let alive = true
    let generation = 0
    let dispose: (() => void) | undefined
    const open = () => {
      const current = ++generation
      let pending = Promise.resolve()
      const active = () => alive && current === generation
      const fail = (message: string) => {
        if (active()) this.set({ error: `会话更新中断：${message}` })
      }
      const projection = new SessionFollowProjection(sessionId, frame => {
        if (!active()) return
        if (frame.type !== 'session/stream-reset') {
          this.acceptSessionFrame(frame)
          return
        }
        // 单会话生成流需要新基线，不得清空其他聊天的历史、队列和待审批。
        generation += 1
        dispose?.()
        queueMicrotask(() => {
          if (alive) open()
        })
      })
      dispose = this.bridge.remote.follow(
        'session/follow',
        {
          request: {
            address: { kind: 'session', sessionId },
            assistantStream: true,
            maxMessages: SESSION_HISTORY_PAGE_SIZE,
          },
        },
        value => {
          pending = pending
            .then(() => {
              if (active()) return projection.accept(value)
            })
            .catch(error => {
              fail(errorMessage(error))
            })
        },
        fail,
      )
    }
    open()
    return () => {
      alive = false
      generation += 1
      dispose?.()
    }
  }

  /** 标签读取自己的会话现场；导航焦点仍由窗口唯一 Store 管理。 */
  sessionSnapshot(sessionId: string): WorkspaceSnapshot {
    if (sessionId === this.snapshot.selectedSessionId) return this.snapshot
    const cached = this.scopedSnapshots.get(sessionId)
    if (cached?.root === this.snapshot) return cached.value
    const prior = this.sessionViews.get(sessionId)
    const controls = this.sessionControlProjections.get(sessionId)
    const history = this.sessionHistories.get(sessionId)
    const session = this.snapshot.sessions.find(item => item.sessionId === sessionId)
    const project = this.snapshot.projects.find(
      item => sessionsForProject(session ? [session] : [], item).length > 0,
    )
    const value: WorkspaceSnapshot = {
      ...this.snapshot,
      selectedSessionId: sessionId,
      selectedProjectId: project?.id ?? null,
      activeView: prior?.activeView === 'trajectory' ? 'trajectory' : 'conversation',
      history: history?.history ?? null,
      liveEvents: history?.liveEvents ?? [],
      historyHasMore: history?.historyHasMore ?? false,
      loadingHistory: history === undefined,
      loadingOlderHistory: this.pagingSessions.has(sessionId),
      historyError: this.historyErrors.get(sessionId) ?? null,
      sessionModels: prior?.sessionModels
        ? sessionModelsWithSelection(prior.sessionModels, controls?.model ?? null)
        : null,
      sessionModelsError: prior?.sessionModelsError ?? null,
      sessionPermission: permissionSelectionFrom(
        controls?.permission ?? null,
        this.snapshot.permissionCatalog,
      ),
      sendingMessage: this.promptSubmittingSessionIds.has(sessionId),
      loadingSessionModels: prior?.loadingSessionModels ?? false,
      selectingSessionModel: prior?.selectingSessionModel ?? false,
      switchingPermissionPreset: prior?.switchingPermissionPreset ?? false,
      sessionCommandDirectory: this.commandDirectoryState(sessionId),
      sessionCommandExecution: this.commandExecutionState(sessionId),
      sessionQueue: this.sessionQueues.get(sessionId) ?? EMPTY_DESKTOP_QUEUE_SNAPSHOT,
      pendingInteractions: this.pendingInteractionsFor(sessionId),
      newSessionProjectId: null,
      newSessionDraft: '',
    }
    this.scopedSnapshots.set(sessionId, { root: this.snapshot, value })
    return value
  }

  readonly conversationScrollPositions = new Map<
    string,
    { scrollTop: number; anchorSeq: string | undefined; anchorTop: number; atBottom: boolean }
  >()
  private sessionsGeneration = 0
  private sessionsRefresh: Promise<void> | undefined
  private sessionsRefreshRequested = false
  private readonly sessionModelsRequests = new Map<string, number>()
  private hostGeneration = 0
  private permissionCatalogGeneration = 0
  private hostFrameRevision = 0
  private latestArchivedSessionsFrame: {
    readonly revision: number
    readonly archivedSessionIds: readonly string[]
  } | null = null
  private readonly workspaceFrames: Array<{
    readonly revision: number
    readonly frame: DesktopWorkspaceFrame
  }> = []
  private projectSelectionRestored = false
  private sessionTabsInitialized = false
  private readonly sessionRightSelections = new Map<string, string | null>()
  private readonly sessionRightSelectionRevisions = new Map<string, number>()
  private readonly sessionIslandCollaborations = new Map<string, IslandCollaboration>()
  private temporaryPanelRestore: Pick<
    WorkspaceSnapshot,
    'navigationCollapsed' | 'informationCollapsed'
  > | null = null
  private sessionHomeModeId = 'conversation'
  private sessionHomeIslandId = 'conversation'
  private panelCollapseModes = new Map<string, boolean | 'right'>()
  private navigationModeIds: ReadonlySet<WorkspaceView> | null = null
  private modeMainIslandIds = new Map<string, string>()
  private islandPlacements = new Map<string, readonly ('main' | 'right')[]>()
  private readonly sessionQueues = new Map<string, DesktopQueueSnapshot>()
  private readonly sessionInteractions = new Map<string, Map<string, DesktopPendingInteraction>>()
  private readonly hostSessionOverlays = new Map<string, HostSessionOverlay>()
  private readonly sessionTitleProjections = new Map<
    string,
    { readonly seq: number; readonly title: string }
  >()
  private readonly pluginProjections = new PluginProjectionCache()
  private readonly commandDirectories = new Map<string, SessionCommandDirectoryState>()
  private readonly commandDirectoryRequests = new Map<string, Promise<boolean>>()
  private readonly commandDirectoryGenerations = new Map<string, number>()
  private readonly commandExecutions = new Map<string, SessionCommandExecutionState>()
  private readonly commandExecutionGenerations = new Map<string, number>()
  private readonly promptSubmissionGenerations = new Map<string, number>()
  private readonly promptSubmittingSessionIds = new Set<string>()
  private readonly pendingPromptTurns = new Map<string, { afterSeq: number; turn: number | null }>()
  private nextCommandDirectoryGeneration = 0
  private nextCommandExecutionGeneration = 0
  private nextPromptSubmissionGeneration = 0

  constructor(
    private readonly bridge: DesktopBridge,
    private readonly storage: PanelLayoutStorage,
  ) {
    const panelLayout = readPanelLayout(storage)
    this.snapshot = {
      initialized: false,
      hostStatus: null,
      settings: null,
      sessions: [],
      projects: [],
      workspaces: [],
      workspaceCapability: 'checking',
      selectedProjectId: null,
      selectedSessionId: null,
      openedSessionIds: [],
      unreadSessionIds: [],
      newSessionProjectId: null,
      newSessionDraft: '',
      activeView: 'conversation',
      navigationView: 'conversation',
      activeRightIslandId: null,
      planPreview: null,
      rightIslandsInitialized: false,
      rightIslandSelectionRequest: null,
      history: null,
      liveEvents: [],
      sessionQueue: EMPTY_DESKTOP_QUEUE_SNAPSHOT,
      pendingInteractions: [],
      loadingSessions: false,
      loadingHistory: false,
      loadingOlderHistory: false,
      historyHasMore: false,
      creatingSession: false,
      sendingNewSession: false,
      sendingMessage: false,
      awaitingResponseSessionIds: [],
      pinnedSessionIds: readPinnedSessionIds(storage),
      archivedSessionIds: [],
      archivedSessions: [],
      archivingSessionIds: [],
      sessionArchiveCapability: 'checking',
      sessionDrafts: {},
      sessionAttachments: {},
      sessionFiles: {},
      choosingAttachments: false,
      sessionCommandDirectory: EMPTY_COMMAND_DIRECTORY_STATE,
      sessionCommandExecution: null,
      sessionModels: null,
      sessionPermission: null,
      permissionCatalog: null,
      loadingPermissionCatalog: false,
      permissionCatalogError: null,
      loadingSessionModels: false,
      selectingSessionModel: false,
      switchingPermissionPreset: false,
      sessionModelsError: null,
      queueUpdatingIds: [],
      settingsOpen: false,
      hostSettingsRevision: 0,
      hostModelsRevision: 0,
      hostCredentialsRevision: 0,
      pluginRevision: 0,
      busyEnter: 'queue',
      navigationCollapsed: panelLayout.navigationCollapsed,
      informationCollapsed: panelLayout.informationCollapsed,
      navigationWidth: panelLayout.navigationWidth,
      informationWidth: panelLayout.informationWidth,
      composerHeight: panelLayout.composerHeight,
      conversationWidth: panelLayout.conversationWidth,
      panelCapsulesPersistent: panelLayout.panelCapsulesPersistent,
      historyError: null,
      error: null,
    }
  }

  getSnapshot = (): WorkspaceSnapshot => this.snapshot

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 统一发布快照，并同步会话标签；所有订阅者都会收到通知。 */
  private set(patch: Partial<WorkspaceSnapshot>, streaming = false): void {
    const previous = this.snapshot
    if (previous.selectedSessionId !== null)
      this.sessionViews.set(previous.selectedSessionId, {
        activeView: previous.activeView,
        sessionModels: previous.sessionModels,
        sessionModelsError: previous.sessionModelsError,
        loadingSessionModels: previous.loadingSessionModels,
        selectingSessionModel: previous.selectingSessionModel,
        switchingPermissionPreset: previous.switchingPermissionPreset,
      })
    const next = { ...previous, ...patch }
    if (next.selectedSessionId !== previous.selectedSessionId) {
      const cached =
        next.selectedSessionId === null
          ? undefined
          : this.sessionHistories.get(next.selectedSessionId)
      Object.assign(next, cached ?? { history: null, liveEvents: [], historyHasMore: false })
      next.loadingHistory = next.selectedSessionId !== null && cached === undefined
      next.loadingOlderHistory = false
      next.historyError = null
    }
    const validSessionIds = new Set(next.sessions.map(session => session.sessionId))
    const reconciledOpenedSessionIds = (patch.openedSessionIds ?? previous.openedSessionIds).filter(
      sessionId => validSessionIds.has(sessionId),
    )
    if (
      next.selectedSessionId !== null &&
      next.selectedSessionId !== previous.selectedSessionId &&
      validSessionIds.has(next.selectedSessionId)
    ) {
      this.sessionTabsInitialized = true
      if (!reconciledOpenedSessionIds.includes(next.selectedSessionId)) {
        reconciledOpenedSessionIds.push(next.selectedSessionId)
      }
    }
    const openedSessionIds =
      reconciledOpenedSessionIds.length === previous.openedSessionIds.length &&
      reconciledOpenedSessionIds.every(
        (sessionId, index) => sessionId === previous.openedSessionIds[index],
      )
        ? previous.openedSessionIds
        : reconciledOpenedSessionIds
    if (patch.sessions !== undefined) {
      for (const sessionId of this.sessionRightSelections.keys()) {
        if (!validSessionIds.has(sessionId)) this.sessionRightSelections.delete(sessionId)
      }
      for (const sessionId of this.sessionRightSelectionRevisions.keys()) {
        if (!validSessionIds.has(sessionId)) this.sessionRightSelectionRevisions.delete(sessionId)
      }
      for (const sessionId of this.sessionIslandCollaborations.keys()) {
        if (!validSessionIds.has(sessionId)) this.sessionIslandCollaborations.delete(sessionId)
      }
    }
    const unreadSessionIds = next.unreadSessionIds.filter(
      id => openedSessionIds.includes(id) && id !== next.selectedSessionId,
    )
    this.snapshot = { ...next, openedSessionIds, unreadSessionIds }
    if (next.selectedSessionId !== null && next.history !== null && !next.loadingHistory) {
      this.sessionHistories.set(next.selectedSessionId, {
        history: next.history,
        liveEvents: next.liveEvents,
        historyHasMore: next.historyHasMore,
      })
    }
    for (const id of this.sessionHistories.keys()) {
      if (!openedSessionIds.includes(id)) {
        this.sessionHistories.delete(id)
        this.sessionViews.delete(id)
        this.sessionModelsRequests.delete(id)
        this.scopedSnapshots.delete(id)
        this.conversationScrollPositions.delete(id)
      }
    }
    for (const id of this.sessionViews.keys()) {
      if (!openedSessionIds.includes(id)) {
        this.sessionViews.delete(id)
        this.sessionModelsRequests.delete(id)
        this.scopedSnapshots.delete(id)
      }
    }
    // 分片逐条写入快照，界面每帧至多通知一次；用户操作与最终消息立即发布最新状态。
    if (streaming && typeof requestAnimationFrame === 'function') {
      this.notificationFrame ??= requestAnimationFrame(() => {
        this.notificationFrame = undefined
        for (const listener of this.listeners) listener()
      })
    } else {
      if (this.notificationFrame !== undefined) cancelAnimationFrame(this.notificationFrame)
      this.notificationFrame = undefined
      for (const listener of this.listeners) listener()
    }
  }

  private awaitingResponseIds(sessionId: string, awaiting: boolean): string[] {
    const ids = new Set(this.snapshot.awaitingResponseSessionIds)
    if (awaiting) ids.add(sessionId)
    else ids.delete(sessionId)
    return [...ids]
  }

  private commandDirectoryState(sessionId: string | null): SessionCommandDirectoryState {
    if (sessionId === null) return EMPTY_COMMAND_DIRECTORY_STATE
    return this.commandDirectories.get(sessionId) ?? EMPTY_COMMAND_DIRECTORY_STATE
  }

  private commandExecutionState(sessionId: string | null): SessionCommandExecutionState | null {
    if (sessionId === null) return null
    return this.commandExecutions.get(sessionId) ?? null
  }

  private setCommandDirectoryState(sessionId: string, state: SessionCommandDirectoryState): void {
    this.commandDirectories.set(sessionId, state)
    if (this.snapshot.selectedSessionId === sessionId) {
      this.set({ sessionCommandDirectory: state })
    }
  }

  private setCommandExecutionState(
    sessionId: string,
    state: SessionCommandExecutionState | null,
  ): void {
    if (state === null) this.commandExecutions.delete(sessionId)
    else this.commandExecutions.set(sessionId, state)
    if (this.snapshot.selectedSessionId === sessionId) {
      this.set({ sessionCommandExecution: state })
    }
  }

  private invalidateCommandDirectory(sessionId: string): void {
    this.commandDirectoryRequests.delete(sessionId)
    this.commandDirectoryGenerations.set(sessionId, ++this.nextCommandDirectoryGeneration)
    const current = this.commandDirectories.get(sessionId)
    const next: SessionCommandDirectoryState =
      current?.value === null || current === undefined
        ? EMPTY_COMMAND_DIRECTORY_STATE
        : {
            status: 'stale',
            value: current.value,
            error: null,
            commandError: current.commandError,
            skillError: current.skillError,
          }
    this.setCommandDirectoryState(sessionId, next)
  }

  private invalidateAllCommandDirectories(): void {
    for (const sessionId of new Set([
      ...this.commandDirectories.keys(),
      ...this.commandDirectoryGenerations.keys(),
    ]))
      this.invalidateCommandDirectory(sessionId)
    if (
      this.snapshot.selectedSessionId !== null &&
      !this.commandDirectories.has(this.snapshot.selectedSessionId)
    ) {
      this.set({ sessionCommandDirectory: EMPTY_COMMAND_DIRECTORY_STATE })
    }
  }

  private resetHostCapabilities(): void {
    this.hostGeneration += 1
    this.sessionsGeneration += 1
    this.sessionControlProjections.clear()
    this.sessionModelsRequests.clear()
    for (const [id, view] of this.sessionViews)
      this.sessionViews.set(id, {
        ...view,
        sessionModels: null,
        sessionModelsError: null,
        loadingSessionModels: false,
        selectingSessionModel: false,
        switchingPermissionPreset: false,
      })
    this.permissionCatalogGeneration += 1
    this.latestArchivedSessionsFrame = null
    this.workspaceFrames.length = 0
    this.sessionQueues.clear()
    this.sessionInteractions.clear()
    this.sessionTitleProjections.clear()
    this.pluginProjections.clear()
    this.invalidateAllCommandDirectories()
    for (const sessionId of new Set([
      ...this.commandExecutions.keys(),
      ...this.commandExecutionGenerations.keys(),
    ])) {
      this.commandExecutionGenerations.set(sessionId, ++this.nextCommandExecutionGeneration)
      this.setCommandExecutionState(sessionId, null)
    }
    for (const sessionId of new Set([
      ...this.promptSubmittingSessionIds,
      ...this.promptSubmissionGenerations.keys(),
    ])) {
      this.promptSubmissionGenerations.set(sessionId, ++this.nextPromptSubmissionGeneration)
    }
    this.promptSubmittingSessionIds.clear()
    this.pendingPromptTurns.clear()
    this.set({
      sessionFiles: Object.fromEntries(
        Object.entries(this.snapshot.sessionFiles).map(([id, files]) => [
          id,
          files.map(file => ({
            ...file,
            status: 'error' as const,
            error: '运行核心已重连，请重试上传附件',
          })),
        ]),
      ),
      sendingMessage: false,
      sessions: this.snapshot.sessions.map(session => ({
        ...session,
        projections: {
          ...session.projections,
          values: Object.fromEntries(
            Object.entries(session.projections?.values ?? {}).filter(([key]) =>
              isDedicatedProjection(key),
            ),
          ),
          omitted: 0,
        },
      })),
      awaitingResponseSessionIds: [],
      sessionQueue: EMPTY_DESKTOP_QUEUE_SNAPSHOT,
      pendingInteractions: [],
      sessionPermission: null,
      permissionCatalog: null,
      loadingPermissionCatalog: false,
      permissionCatalogError: null,
      switchingPermissionPreset: false,
      sessionModels: null,
      sessionModelsError: null,
      loadingSessionModels: false,
      selectingSessionModel: false,
      queueUpdatingIds: [],
      loadingSessions: false,
      workspaces: [],
      workspaceCapability: 'checking',
      archivedSessionIds: [],
      archivedSessions: [],
      archivingSessionIds: [],
      sessionArchiveCapability: 'checking',
    })
  }

  private adoptModelSelectionProjection(sessionId: string, value: unknown, seq: number): boolean {
    const current = this.sessionControls(sessionId)
    const projection = parseModelSelectionProjection(value)
    if (projection === null || seq <= current.modelSeq) return false
    current.modelSeq = seq
    current.model = projection.next
    return true
  }

  private sessionControls(sessionId: string) {
    let current = this.sessionControlProjections.get(sessionId)
    if (current === undefined) {
      current = { model: null, modelSeq: -2, permission: null, permissionSeq: -1 }
      this.sessionControlProjections.set(sessionId, current)
    }
    return current
  }

  private pendingInteractionsFor(sessionId: string | null): DesktopPendingInteraction[] {
    if (sessionId === null) return []
    const interactions = [...(this.sessionInteractions.get(sessionId)?.values() ?? [])]
    return interactions.toSorted(
      (left, right) => Number(left.kind !== 'approval') - Number(right.kind !== 'approval'),
    )
  }

  private upsertPendingInteraction(
    sessionId: string,
    interaction: DesktopPendingInteraction,
  ): void {
    const current =
      this.sessionInteractions.get(sessionId) ?? new Map<string, DesktopPendingInteraction>()
    current.set(interaction.key, interaction)
    this.sessionInteractions.set(sessionId, current)
    if (this.snapshot.selectedSessionId === sessionId) {
      this.set({ pendingInteractions: this.pendingInteractionsFor(sessionId) })
    } else this.set({})
  }

  private resolvePendingInteraction(
    sessionId: string,
    resolution: Extract<
      DesktopSessionFrame,
      { type: 'session/interaction-resolved' }
    >['resolution'],
  ): void {
    const current = this.sessionInteractions.get(sessionId)
    if (current === undefined) return
    if (resolution.kind === 'question') current.delete(resolution.key)
    else {
      for (const [key, interaction] of current) {
        if (interaction.kind === 'approval' && interaction.approvalId === resolution.approvalId)
          current.delete(key)
      }
    }
    if (current.size === 0) this.sessionInteractions.delete(sessionId)
    if (this.snapshot.selectedSessionId === sessionId) {
      this.set({ pendingInteractions: this.pendingInteractionsFor(sessionId) })
    } else this.set({})
  }

  private setPromptSubmitting(sessionId: string, submitting: boolean): void {
    if (submitting) this.promptSubmittingSessionIds.add(sessionId)
    else this.promptSubmittingSessionIds.delete(sessionId)
    this.set({
      sendingMessage:
        this.snapshot.selectedSessionId !== null &&
        this.promptSubmittingSessionIds.has(this.snapshot.selectedSessionId),
    })
  }

  private deleteSessionTransientState(sessionId: string): Partial<WorkspaceSnapshot> {
    this.sessionControlProjections.delete(sessionId)
    this.sessionRightSelections.delete(sessionId)
    this.sessionRightSelectionRevisions.delete(sessionId)
    this.sessionIslandCollaborations.delete(sessionId)
    this.sessionQueues.delete(sessionId)
    this.sessionInteractions.delete(sessionId)
    this.commandDirectories.delete(sessionId)
    this.commandDirectoryRequests.delete(sessionId)
    this.commandDirectoryGenerations.delete(sessionId)
    this.commandExecutions.delete(sessionId)
    this.commandExecutionGenerations.delete(sessionId)
    this.promptSubmissionGenerations.delete(sessionId)
    this.promptSubmittingSessionIds.delete(sessionId)
    this.pendingPromptTurns.delete(sessionId)
    const sessionDrafts = { ...this.snapshot.sessionDrafts }
    delete sessionDrafts[sessionId]
    const sessionAttachments = { ...this.snapshot.sessionAttachments }
    delete sessionAttachments[sessionId]
    const sessionFiles = { ...this.snapshot.sessionFiles }
    for (const file of sessionFiles[sessionId] ?? []) this.fileSources.delete(file.id)
    delete sessionFiles[sessionId]
    const selected = this.snapshot.selectedSessionId === sessionId
    return {
      sessionFiles,
      sessionDrafts,
      sessionAttachments,
      sendingMessage:
        this.snapshot.selectedSessionId !== null &&
        this.promptSubmittingSessionIds.has(this.snapshot.selectedSessionId),
      awaitingResponseSessionIds: this.awaitingResponseIds(sessionId, false),
      archivingSessionIds: this.snapshot.archivingSessionIds.filter(id => id !== sessionId),
      ...(selected
        ? {
            sessionQueue: EMPTY_DESKTOP_QUEUE_SNAPSHOT,
            pendingInteractions: [],
            sessionCommandDirectory: EMPTY_COMMAND_DIRECTORY_STATE,
            sessionCommandExecution: null,
          }
        : {}),
    }
  }

  /** 先订阅桌面桥事件，再读取初始数据；取消订阅函数交由 dispose 在应用卸载时释放。 */
  async initialize(): Promise<void> {
    if (this.snapshot.initialized) return
    this.disposers.push(
      this.bridge.host.onStatusChanged(status => {
        if (status.kind !== 'ready') {
          this.resetHostCapabilities()
          this.set({
            hostStatus: status,
            sessionModels: null,
            loadingSessionModels: false,
            selectingSessionModel: false,
            sessionModelsError: null,
          })
          return
        }
        const reconnecting = this.snapshot.hostStatus?.kind !== 'ready'
        this.set({ hostStatus: status })
        if (reconnecting && this.snapshot.initialized) void this.refreshSessions()
      }),
      this.bridge.settings.onChanged(settings => {
        this.set({ settings })
      }),
      this.bridge.settings.onOpenRequested(() => {
        this.set({ settingsOpen: true })
      }),
    )
    if (this.bridge.host.onSessionFrame !== undefined) {
      this.disposers.push(
        this.bridge.host.onSessionFrame(frame => {
          this.acceptSessionFrame(frame)
        }),
      )
    }
    if (this.bridge.host.onHostFrame !== undefined) {
      this.disposers.push(
        this.bridge.host.onHostFrame(frame => {
          this.acceptHostFrame(frame)
        }),
      )
    }
    try {
      const [hostStatus, settings] = await Promise.all([
        this.bridge.host.status(),
        this.bridge.settings.read(),
      ])
      this.set({ initialized: true, hostStatus, settings })
      await this.refreshSessions()
    } catch (error) {
      this.set({ initialized: true, error: errorMessage(error) })
    }
  }

  dispose(): void {
    this.openedPlanReviews.clear()
    this.set({ planPreview: null })
    this.sessionsRefreshRequested = false
    this.historyGeneration += 1
    this.sessionsGeneration += 1
    this.resetHostCapabilities()
    this.temporaryPanelRestore = null
    this.sessionRightSelectionRevisions.clear()
    this.sessionIslandCollaborations.clear()
    this.sessionHistories.clear()
    this.fileSources.clear()
    this.pagingSessions.clear()
    this.historyErrors.clear()
    this.sessionViews.clear()
    this.sessionModelsRequests.clear()
    this.scopedSnapshots.clear()
    this.conversationScrollPositions.clear()
    for (const dispose of this.disposers.splice(0)) dispose()
  }

  /**
   * 分别读取 Session 与 Workspace 基线，再合并请求期间到达的较新事件。
   * 项目访问注册表须在 Session 列表完成后读取；Workspace ID 本身不代表本机目录权限。
   */
  refreshSessions(): Promise<void> {
    this.sessionsRefreshRequested = true
    if (this.sessionsRefresh !== undefined) return this.sessionsRefresh
    // 同一批事件共用列表读取；期间的新请求只要求在末尾再读取一次。
    const refresh = Promise.resolve().then(async () => {
      try {
        /* oxlint-disable no-await-in-loop -- 刷新必须串行，调用方等待最后一份有效列表。 */
        while (this.sessionsRefreshRequested) {
          this.sessionsRefreshRequested = false
          await this.readSessions()
        }
        /* oxlint-enable no-await-in-loop */
      } finally {
        if (this.sessionsRefresh === refresh) this.sessionsRefresh = undefined
      }
    })
    this.sessionsRefresh = refresh
    return refresh
  }

  private async readSessions(): Promise<void> {
    const generation = ++this.sessionsGeneration
    const baselineRevision = this.hostFrameRevision
    this.set({ loadingSessions: true, error: null })
    try {
      const [value, workspaceBaseline] = await Promise.all([
        this.bridge.host.call('listSessions', {}),
        this.bridge.host
          .call('listWorkspaces', {})
          .then(workspaceValue => ({
            kind: 'available' as const,
            value: parseDesktopWorkspaceListResult(workspaceValue),
          }))
          .catch(() => ({ kind: 'legacy' as const })),
      ])
      if (generation !== this.sessionsGeneration) return
      // 主进程在 listSessions 完成后才更新受信任项目注册表，项目列表必须随后读取。
      const registered =
        this.bridge.projects === undefined
          ? []
          : parseDesktopProjects(await this.bridge.projects.list().catch(() => []))
      if (generation !== this.sessionsGeneration) return
      const archiveFrame = this.latestArchivedSessionsFrame
      const archiveIds =
        archiveFrame !== null && archiveFrame.revision > baselineRevision
          ? archiveFrame.archivedSessionIds
          : workspaceBaseline.kind === 'available'
            ? workspaceBaseline.value.archivedSessionIds
            : this.snapshot.archivedSessionIds
      const archived = new Set(archiveIds)
      const allSessions = this.sessionsWithHostOverlays(
        parseSessionList(value).items,
        baselineRevision,
      )
      const sessions = allSessions.filter(session => !archived.has(session.sessionId))
      const archivedSessions = allSessions.filter(session => archived.has(session.sessionId))
      const workspaces =
        workspaceBaseline.kind === 'available'
          ? this.workspacesWithHostOverlays(workspaceBaseline.value.items, baselineRevision)
          : []
      const pinnedSessionIds = reconcilePinnedSessionIds(
        this.snapshot.pinnedSessionIds,
        sessions.map(session => session.sessionId),
      )
      if (pinnedSessionIds.length !== this.snapshot.pinnedSessionIds.length) {
        persistPinnedSessionIds(this.storage, pinnedSessionIds)
      }
      const projects =
        workspaceBaseline.kind === 'available'
          ? deriveWorkspaceProjects(sessions, workspaces, registered)
          : deriveProjects(sessions, registered)
      const remembered = this.projectSelectionRestored ? null : rememberedProjectId(this.storage)
      const selectedProjectId = projects.some(
        project => project.id === this.snapshot.selectedProjectId,
      )
        ? this.snapshot.selectedProjectId
        : !this.projectSelectionRestored && projects.some(project => project.id === remembered)
          ? remembered
          : null
      this.projectSelectionRestored = true
      const project = projects.find(item => item.id === selectedProjectId)
      const focusedSessions =
        selectedProjectId === null ? sessions : sessionsForProject(sessions, project)
      const newSessionProjectId =
        this.snapshot.newSessionProjectId !== null &&
        (selectedProjectId === null || this.snapshot.newSessionProjectId === selectedProjectId) &&
        projects.some(item => item.id === this.snapshot.newSessionProjectId)
          ? this.snapshot.newSessionProjectId
          : null
      const selectedSessionStillExists = focusedSessions.some(
        session => session.sessionId === this.snapshot.selectedSessionId,
      )
      const selectedSessionId =
        newSessionProjectId !== null
          ? null
          : selectedSessionStillExists
            ? this.snapshot.selectedSessionId
            : this.snapshot.selectedSessionId !== null || !this.sessionTabsInitialized
              ? (focusedSessions[0]?.sessionId ?? null)
              : null
      const sessionChanged = selectedSessionId !== this.snapshot.selectedSessionId
      this.set({
        sessions,
        projects,
        workspaces,
        workspaceCapability: workspaceBaseline.kind,
        pinnedSessionIds,
        archivedSessionIds: [...archiveIds],
        archivedSessions,
        sessionArchiveCapability:
          archiveFrame !== null && archiveFrame.revision > baselineRevision
            ? 'available'
            : workspaceBaseline.kind === 'available'
              ? 'available'
              : 'unavailable',
        selectedProjectId,
        selectedSessionId,
        newSessionProjectId,
        newSessionDraft: newSessionProjectId === null ? '' : this.snapshot.newSessionDraft,
        sendingMessage:
          selectedSessionId !== null && this.promptSubmittingSessionIds.has(selectedSessionId),
        sessionCommandDirectory: this.commandDirectoryState(selectedSessionId),
        sessionCommandExecution: this.commandExecutionState(selectedSessionId),
        ...(selectedSessionId !== this.snapshot.selectedSessionId
          ? {
              sessionModels: null,
              sessionPermission: this.projectedPermission(
                selectedSessionId,
                focusedSessions.find(item => item.sessionId === selectedSessionId)?.projections,
              ),
              loadingSessionModels: false,
              selectingSessionModel: false,
              switchingPermissionPreset: false,
              sessionModelsError: null,
            }
          : {}),
        sessionQueue:
          selectedSessionId === null
            ? EMPTY_DESKTOP_QUEUE_SNAPSHOT
            : (this.sessionQueues.get(selectedSessionId) ?? EMPTY_DESKTOP_QUEUE_SNAPSHOT),
        pendingInteractions: this.pendingInteractionsFor(selectedSessionId),
        loadingSessions: false,
        ...(sessionChanged
          ? {
              ...this.viewTransitionPatch(this.sessionHomeModeId),
              ...this.rightLayoutPatch(selectedSessionId),
            }
          : {}),
      })
      persistProjectId(this.storage, selectedProjectId)
      if (selectedSessionId !== null) {
        const session = focusedSessions.find(item => item.sessionId === selectedSessionId)
        if (session !== undefined) {
          void this.loadSessionCommandDirectory(session.sessionId)
          if (sessionChanged || this.snapshot.history === null) await this.loadSession(session)
        }
      } else {
        this.set({
          history: null,
          liveEvents: [],
          sessionModels: null,
          sessionPermission: null,
          loadingSessionModels: false,
          selectingSessionModel: false,
          switchingPermissionPreset: false,
          sessionModelsError: null,
          sessionQueue: EMPTY_DESKTOP_QUEUE_SNAPSHOT,
          pendingInteractions: [],
          loadingHistory: false,
          loadingOlderHistory: false,
          historyHasMore: false,
        })
      }
    } catch (error) {
      if (generation !== this.sessionsGeneration) return
      this.set({ loadingSessions: false, error: errorMessage(error) })
    }
  }

  private sessionsWithHostOverlays(
    listedSessions: readonly SessionSummary[],
    afterRevision: number,
  ): SessionSummary[] {
    const sessions = new Map(listedSessions.map(session => [session.sessionId, session]))
    for (const [sessionId, overlay] of this.hostSessionOverlays) {
      if (overlay.revision <= afterRevision) continue
      const current = sessions.get(sessionId) ?? overlay.added
      if (current === undefined) continue
      const running = overlay.detached === true ? false : (overlay.running ?? current.running)
      sessions.set(sessionId, {
        ...current,
        running,
        ...(running ? { blank: false } : {}),
      })
    }
    for (const session of sessions.values()) {
      this.adoptPluginProjectionBaseline(session.sessionId, session.projections)
      const projectedTitle = session.projections?.values?.title
      if (typeof projectedTitle === 'string' && projectedTitle !== '') {
        const seq = session.projections?.asOfSeq ?? -1
        const current = this.sessionTitleProjections.get(session.sessionId)
        if (current === undefined || seq >= current.seq) {
          this.sessionTitleProjections.set(session.sessionId, { seq, title: projectedTitle })
        }
      }
    }
    return [...sessions.values()]
      .map(session => this.sessionWithProjectedTitle(session))
      .toSorted((left, right) => right.updatedAt - left.updatedAt)
  }

  private sessionWithProjectedTitle(session: SessionSummary): SessionSummary {
    const projection = this.sessionTitleProjections.get(session.sessionId)
    const plugins = this.pluginProjections.read(session.sessionId)
    if (projection === undefined && plugins === undefined && session.projections === undefined)
      return session
    return {
      ...session,
      projections: {
        ...session.projections,
        asOfSeq: Math.max(
          session.projections?.asOfSeq ?? -1,
          projection?.seq ?? -1,
          plugins?.asOfSeq ?? -1,
        ),
        values: {
          ...Object.fromEntries(
            Object.entries(session.projections?.values ?? {}).filter(([key]) =>
              isDedicatedProjection(key),
            ),
          ),
          ...plugins?.values,
          ...(projection === undefined ? {} : { title: projection.title }),
        },
        omitted:
          plugins?.omitted ??
          (session.projections?.omitted ?? 0) +
            Object.keys(session.projections?.values ?? {}).filter(
              key => !isDedicatedProjection(key),
            ).length,
      },
    }
  }

  private adoptPluginProjectionBaseline(sessionId: string, value: unknown): void {
    if (!isRecord(value)) return
    const change = parsePluginProjectionChange({
      ...value,
      kind: 'snapshot',
      asOfSeq: projectionSeq(value),
    })
    if (change !== null) this.pluginProjections.apply(sessionId, change)
  }

  private applySessionTitle(sessionId: string, title: string, seq: number): void {
    const current = this.sessionTitleProjections.get(sessionId)
    if (current !== undefined && current.seq > seq) return
    this.sessionTitleProjections.set(sessionId, { seq, title })
    this.set({
      sessions: this.snapshot.sessions.map(session =>
        session.sessionId === sessionId ? this.sessionWithProjectedTitle(session) : session,
      ),
    })
  }

  private workspacesWithHostOverlays(
    listedWorkspaces: readonly DesktopWorkspaceView[],
    afterRevision: number,
  ): DesktopWorkspaceView[] {
    let workspaces = [...listedWorkspaces]
    for (const { revision, frame } of this.workspaceFrames) {
      if (revision <= afterRevision) continue
      if (frame.type === 'host/workspace-changed') {
        const index = workspaces.findIndex(item => item.workspaceId === frame.workspace.workspaceId)
        if (index === -1) workspaces.push(frame.workspace)
        else workspaces[index] = frame.workspace
        continue
      }
      if (frame.type === 'host/workspace-removed') {
        workspaces = workspaces.filter(item => item.workspaceId !== frame.workspaceId)
        continue
      }
      const byId = new Map(workspaces.map(item => [item.workspaceId, item]))
      workspaces = frame.workspaceIds.flatMap(workspaceId => {
        const workspace = byId.get(workspaceId)
        return workspace === undefined ? [] : [workspace]
      })
      for (const workspace of byId.values()) {
        if (!frame.workspaceIds.includes(workspace.workspaceId)) workspaces.push(workspace)
      }
    }
    return workspaces
  }

  selectProject(projectId: string | null, startNewSession = false): void {
    const project =
      projectId === null || projectId === ''
        ? undefined
        : this.snapshot.projects.find(item => item.id === projectId)
    const selectedProjectId = project?.id ?? null
    const startingNewSession = startNewSession && project?.source === 'workspace'
    this.projectSelectionRestored = true
    persistProjectId(this.storage, selectedProjectId)
    if (!startingNewSession && selectedProjectId === this.snapshot.selectedProjectId) return
    const availableSessions =
      project === undefined
        ? [...this.snapshot.sessions]
        : sessionsForProject(this.snapshot.sessions, project)
    const selectedSession = startingNewSession
      ? undefined
      : (availableSessions.find(session => session.sessionId === this.snapshot.selectedSessionId) ??
        availableSessions[0])
    const sessionChanged =
      startingNewSession || selectedSession?.sessionId !== this.snapshot.selectedSessionId
    this.set({
      selectedProjectId,
      selectedSessionId: selectedSession?.sessionId ?? null,
      newSessionProjectId: startingNewSession ? selectedProjectId : null,
      newSessionDraft: '',
      sendingMessage:
        selectedSession !== undefined &&
        this.promptSubmittingSessionIds.has(selectedSession.sessionId),
      sessionCommandDirectory: this.commandDirectoryState(selectedSession?.sessionId ?? null),
      sessionCommandExecution: this.commandExecutionState(selectedSession?.sessionId ?? null),
      sessionQueue:
        selectedSession === undefined
          ? EMPTY_DESKTOP_QUEUE_SNAPSHOT
          : (this.sessionQueues.get(selectedSession.sessionId) ?? EMPTY_DESKTOP_QUEUE_SNAPSHOT),
      pendingInteractions:
        selectedSession === undefined ? [] : this.pendingInteractionsFor(selectedSession.sessionId),
      ...(sessionChanged
        ? {
            history: null,
            liveEvents: [],
            sessionModels: null,
            sessionPermission: this.projectedPermission(
              selectedSession?.sessionId ?? null,
              selectedSession?.projections,
            ),
            loadingSessionModels: false,
            selectingSessionModel: false,
            switchingPermissionPreset: false,
            sessionModelsError: null,
            historyHasMore: false,
            loadingOlderHistory: false,
            historyError: null,
          }
        : {}),
      ...(selectedSession === undefined ? { loadingHistory: false } : {}),
      ...this.viewTransitionPatch(this.sessionHomeModeId),
      ...this.rightLayoutPatch(selectedSession?.sessionId ?? null),
      error: null,
    })
    if (sessionChanged && selectedSession !== undefined) {
      void this.loadSessionCommandDirectory(selectedSession.sessionId)
      void this.loadSession(selectedSession)
    }
  }

  selectSession(sessionId: string): void {
    if (sessionId === this.snapshot.selectedSessionId) {
      this.setView(this.sessionHomeModeId)
      return
    }
    const session = this.focusedSessions().find(item => item.sessionId === sessionId)
    if (session === undefined) return
    this.selectSessionWithConversation(session, this.snapshot.selectedProjectId)
  }

  selectSessionTab(sessionId: string): void {
    if (!this.snapshot.openedSessionIds.includes(sessionId)) return
    if (sessionId === this.snapshot.selectedSessionId) {
      this.setView(this.sessionHomeModeId)
      return
    }
    const session = this.snapshot.sessions.find(item => item.sessionId === sessionId)
    if (session === undefined) return
    const sessionProject = this.snapshot.projects.find(project =>
      sessionsForProject(this.snapshot.sessions, project).some(
        item => item.sessionId === sessionId,
      ),
    )
    const selectedProjectId =
      this.snapshot.selectedProjectId === null ? null : (sessionProject?.id ?? null)
    this.selectSessionWithConversation(session, selectedProjectId)
  }

  moveSessionTab(sessionId: string, targetIndex: number): void {
    const openedSessionIds = [...this.snapshot.openedSessionIds]
    const index = openedSessionIds.indexOf(sessionId)
    if (
      index < 0 ||
      !Number.isInteger(targetIndex) ||
      targetIndex < 0 ||
      targetIndex >= openedSessionIds.length ||
      targetIndex === index
    )
      return
    openedSessionIds.splice(index, 1)
    openedSessionIds.splice(targetIndex, 0, sessionId)
    this.set({ openedSessionIds })
  }

  closeSessionTab(sessionId: string, closeFocused = false): void {
    const index = this.snapshot.openedSessionIds.indexOf(sessionId)
    if (index < 0) return
    const openedSessionIds = this.snapshot.openedSessionIds.filter(id => id !== sessionId)
    if (
      this.snapshot.selectedSessionId !== sessionId ||
      (!closeFocused &&
        ['files', 'terminal', 'browser', 'changes'].includes(this.snapshot.activeView))
    ) {
      this.set({ openedSessionIds })
      return
    }
    const adjacentSessionId = openedSessionIds[Math.min(index, openedSessionIds.length - 1)]
    const adjacentSession =
      adjacentSessionId === undefined
        ? undefined
        : this.snapshot.sessions.find(session => session.sessionId === adjacentSessionId)
    if (adjacentSession !== undefined) {
      const sessionProject = this.snapshot.projects.find(project =>
        sessionsForProject(this.snapshot.sessions, project).some(
          item => item.sessionId === adjacentSession.sessionId,
        ),
      )
      const selectedProjectId =
        this.snapshot.selectedProjectId === null ? null : (sessionProject?.id ?? null)
      this.selectSessionWithConversation(adjacentSession, selectedProjectId, openedSessionIds)
      return
    }
    this.historyGeneration += 1
    this.set({
      openedSessionIds,
      selectedSessionId: null,
      sendingMessage: false,
      sessionCommandDirectory: EMPTY_COMMAND_DIRECTORY_STATE,
      sessionCommandExecution: null,
      sessionQueue: EMPTY_DESKTOP_QUEUE_SNAPSHOT,
      pendingInteractions: [],
      history: null,
      liveEvents: [],
      sessionModels: null,
      sessionPermission: null,
      loadingSessionModels: false,
      selectingSessionModel: false,
      switchingPermissionPreset: false,
      sessionModelsError: null,
      loadingHistory: false,
      loadingOlderHistory: false,
      historyHasMore: false,
      historyError: null,
      ...this.viewTransitionPatch(this.sessionHomeModeId),
      ...this.rightLayoutPatch(null),
      error: null,
    })
  }

  /**
   * 关闭最后一个浏览器或终端标签后返回欢迎新聊天界面，不向顶栏追加新的会话标签；
   * 若存在持久化工作区，则直接进入该工作区的新会话草稿态，方便用户立即输入并开启新会话。
   */
  enterNewSessionWelcome(preferredProjectId?: string | null): void {
    const preferred =
      preferredProjectId !== undefined && preferredProjectId !== null && preferredProjectId !== ''
        ? this.snapshot.projects.find(
            item => item.id === preferredProjectId && item.source === 'workspace',
          )
        : undefined
    const selected =
      this.snapshot.selectedProjectId === null
        ? undefined
        : this.snapshot.projects.find(
            item => item.id === this.snapshot.selectedProjectId && item.source === 'workspace',
          )
    const fallback = this.snapshot.projects.find(item => item.source === 'workspace')
    const targetProject = preferred ?? selected ?? fallback
    const newSessionProjectId = targetProject?.id ?? null
    const preservedDraft =
      newSessionProjectId !== null && newSessionProjectId === this.snapshot.newSessionProjectId
        ? this.snapshot.newSessionDraft
        : ''
    this.historyGeneration += 1
    this.set({
      selectedSessionId: null,
      newSessionProjectId,
      newSessionDraft: preservedDraft,
      sendingMessage: false,
      sessionCommandDirectory: EMPTY_COMMAND_DIRECTORY_STATE,
      sessionCommandExecution: null,
      sessionQueue: EMPTY_DESKTOP_QUEUE_SNAPSHOT,
      pendingInteractions: [],
      history: null,
      liveEvents: [],
      sessionModels: null,
      sessionPermission: null,
      loadingSessionModels: false,
      selectingSessionModel: false,
      switchingPermissionPreset: false,
      sessionModelsError: null,
      loadingHistory: false,
      loadingOlderHistory: false,
      historyHasMore: false,
      historyError: null,
      ...this.viewTransitionPatch(this.sessionHomeModeId),
      ...this.rightLayoutPatch(null),
      error: null,
    })
  }

  /** 切换当前会话并回到对话，恢复其右侧现场、队列和命令状态。 */
  private selectSessionWithConversation(
    session: SessionSummary,
    selectedProjectId: string | null,
    openedSessionIds?: readonly string[],
  ): void {
    this.projectSelectionRestored = true
    if (selectedProjectId !== this.snapshot.selectedProjectId) {
      persistProjectId(this.storage, selectedProjectId)
    }
    this.set({
      ...(openedSessionIds === undefined ? {} : { openedSessionIds }),
      selectedProjectId,
      selectedSessionId: session.sessionId,
      newSessionProjectId: null,
      newSessionDraft: '',
      sendingMessage: this.promptSubmittingSessionIds.has(session.sessionId),
      sessionCommandDirectory: this.commandDirectoryState(session.sessionId),
      sessionCommandExecution: this.commandExecutionState(session.sessionId),
      sessionQueue: this.sessionQueues.get(session.sessionId) ?? EMPTY_DESKTOP_QUEUE_SNAPSHOT,
      pendingInteractions: this.pendingInteractionsFor(session.sessionId),
      liveEvents: [],
      sessionModels: null,
      sessionPermission: this.projectedPermission(session.sessionId, session.projections),
      loadingSessionModels: false,
      selectingSessionModel: false,
      switchingPermissionPreset: false,
      sessionModelsError: null,
      historyHasMore: false,
      loadingOlderHistory: false,
      ...this.viewTransitionPatch(this.sessionHomeModeId),
      ...this.rightLayoutPatch(session.sessionId),
      error: null,
    })
    void this.loadSessionCommandDirectory(session.sessionId)
    void this.loadSession(session)
  }

  togglePinnedSession(sessionId: string): void {
    if (!this.snapshot.sessions.some(session => session.sessionId === sessionId)) return
    const pinnedSessionIds = persistPinnedSessionIds(
      this.storage,
      togglePinnedSessionId(this.snapshot.pinnedSessionIds, sessionId),
    )
    this.set({ pinnedSessionIds })
  }

  private async loadSession(session: SessionSummary, throughSeq?: number): Promise<void> {
    if (this.snapshot.selectedSessionId !== session.sessionId) return
    const generation = ++this.historyGeneration
    const baselineProjectionSeq = projectionSeq(session.projections)
    this.adoptModelSelectionProjection(
      session.sessionId,
      session.projections,
      baselineProjectionSeq,
    )
    const cached = this.sessionHistories.get(session.sessionId)
    this.set({
      loadingHistory: cached === undefined,
      loadingOlderHistory: false,
      historyHasMore: cached?.historyHasMore ?? false,
      history: cached?.history ?? null,
      liveEvents: cached?.liveEvents ?? [],
      sessionPermission: this.projectedPermission(session.sessionId, session.projections),
      historyError: null,
    })
    try {
      const page = await this.bridge.host.call('loadSessionPage', {
        sessionId: session.sessionId,
        throughSeq: throughSeq ?? session.projections?.asOfSeq ?? 0,
        maxMessages: SESSION_HISTORY_PAGE_SIZE,
      })
      if (
        generation !== this.historyGeneration ||
        this.snapshot.selectedSessionId !== session.sessionId
      )
        return
      const history = mergeHistoryTail(this.snapshot.history, page)
      const persisted = new Set(normalizeSessionEvents(history).map(event => event.seq))
      const nextProjectionSeq = projectionSeq(history)
      const historyRecord =
        isRecord(history) && isRecord(history.projections)
          ? history.projections
          : isRecord(history)
            ? history
            : null
      this.adoptPluginProjectionBaseline(session.sessionId, historyRecord)
      const historyTitle =
        historyRecord !== null &&
        isRecord(historyRecord.values) &&
        typeof historyRecord.values.title === 'string'
          ? historyRecord.values.title
          : null
      const applyModelSelection = this.adoptModelSelectionProjection(
        session.sessionId,
        history,
        nextProjectionSeq,
      )
      this.set({
        history,
        sessions: this.snapshot.sessions.map(item => this.sessionWithProjectedTitle(item)),
        liveEvents: this.snapshot.liveEvents.filter(event => !persisted.has(event.seq)),
        historyHasMore: historyHasMore(history),
        sessionModels:
          applyModelSelection && this.snapshot.sessionModels !== null
            ? sessionModelsWithSelection(
                this.snapshot.sessionModels,
                this.sessionControls(session.sessionId).model,
              )
            : this.snapshot.sessionModels,
        sessionPermission: this.projectedPermission(session.sessionId, history),
        loadingHistory: false,
      })
      if (historyTitle !== null && historyTitle !== '') {
        this.applySessionTitle(session.sessionId, historyTitle, nextProjectionSeq)
      }
    } catch (error) {
      if (
        generation !== this.historyGeneration ||
        this.snapshot.selectedSessionId !== session.sessionId
      )
        return
      this.set({ loadingHistory: false, historyError: errorMessage(error) })
    }
  }

  async loadOlderHistory(sessionId = this.snapshot.selectedSessionId): Promise<boolean> {
    if (sessionId === null || this.pagingSessions.has(sessionId)) return false
    const view = this.sessionSnapshot(sessionId)
    if (view.loadingHistory || !view.historyHasMore) return false
    const firstSeq = normalizeSessionEvents(view.history)[0]?.seq
    if (firstSeq === undefined || firstSeq <= 0) return false
    const hostGeneration = this.hostGeneration
    const generation = this.historyGeneration
    const wasFocused = sessionId === this.snapshot.selectedSessionId
    this.pagingSessions.add(sessionId)
    this.historyErrors.delete(sessionId)
    this.set(
      sessionId === this.snapshot.selectedSessionId
        ? { loadingOlderHistory: true, historyError: null }
        : {},
    )
    try {
      const older = await this.bridge.host.call('loadSessionPage', {
        sessionId,
        throughSeq: firstSeq - 1,
        beforeSeq: firstSeq,
        maxMessages: SESSION_HISTORY_PAGE_SIZE,
      })
      if (
        hostGeneration !== this.hostGeneration ||
        !this.snapshot.openedSessionIds.includes(sessionId) ||
        (wasFocused && generation !== this.historyGeneration)
      )
        return false
      const current = this.sessionSnapshot(sessionId)
      if (normalizeSessionEvents(current.history)[0]?.seq !== firstSeq) return false
      const events = normalizeSessionEvents(older)
      if (
        events.some(event => event.seq < firstSeq) &&
        !reachesCurrentHistoryHead(events, firstSeq)
      )
        throw new Error('更早历史页与当前会话窗口不连续，请重试加载。')
      const history = events.some(event => event.seq < firstSeq)
        ? mergeHistoryPages(current.history, older)
        : current.history
      const more = events.some(event => event.seq < firstSeq) && historyHasMore(older)
      this.sessionHistories.set(sessionId, {
        history,
        liveEvents: current.liveEvents,
        historyHasMore: more,
      })
      this.set(
        sessionId === this.snapshot.selectedSessionId ? { history, historyHasMore: more } : {},
      )
      return events.some(event => event.seq < firstSeq)
    } catch (error) {
      if (hostGeneration !== this.hostGeneration) return false
      const message = errorMessage(error)
      this.historyErrors.set(sessionId, message)
      this.set(sessionId === this.snapshot.selectedSessionId ? { historyError: message } : {})
      return false
    } finally {
      this.pagingSessions.delete(sessionId)
      this.set(sessionId === this.snapshot.selectedSessionId ? { loadingOlderHistory: false } : {})
    }
  }

  private acceptSessionCapabilityEvent(sessionId: string, event: CanonicalSessionEvent): void {
    if (event.type === 'agent-preset/selected') {
      this.invalidateCommandDirectory(sessionId)
      if (sessionId === this.snapshot.selectedSessionId) {
        void this.loadSessionCommandDirectory(sessionId, true)
      }
      return
    }
    if (event.type === 'command/run' && isRecord(event.data)) {
      const commandId = event.data.commandId
      const name = event.data.name
      const submitted = this.commandExecutions.get(sessionId)
      // 控件也会调用命令；输入区只跟踪用户从这里提交的命令。
      if (
        typeof commandId === 'string' &&
        typeof name === 'string' &&
        submitted?.name === name &&
        (submitted.phase === 'submitting' || submitted.commandId === commandId)
      ) {
        this.setCommandExecutionState(sessionId, {
          phase: 'running',
          commandId,
          name,
        })
        if (submitted.submittedDraft !== undefined)
          this.clearSessionDraft(sessionId, submitted.submittedDraft)
      }
      return
    }
    if (event.type !== 'command/done' || !isRecord(event.data)) return
    const commandId = event.data.commandId
    const kind = event.data.kind
    const text = event.data.text
    const running = this.commandExecutions.get(sessionId)
    if (
      typeof commandId !== 'string' ||
      (kind !== 'success' && kind !== 'error') ||
      running?.commandId !== commandId
    )
      return
    this.setCommandExecutionState(sessionId, {
      phase: kind,
      commandId,
      name: running.name,
      ...(typeof text === 'string' ? { text } : {}),
    })
  }

  /**
   * 接收经桌面桥转发的 Session 帧，更新实时内容、队列、模型选择与待用户交互。
   * 流重置后清除旧连接的瞬时状态并重新读取基线，用户草稿继续保留。
   */
  private acceptSessionFrame(input: DesktopSessionFrame): void {
    const frame = parseDesktopSessionFrame(input)
    if (frame === null) return

    if (frame.type === 'session/stream-reset') {
      this.historyGeneration += 1
      this.sessionQueues.clear()
      this.resetHostCapabilities()
      this.set({
        sessionQueue: EMPTY_DESKTOP_QUEUE_SNAPSHOT,
        pendingInteractions: [],
        awaitingResponseSessionIds: [],
        liveEvents: [],
      })
      this.sessionHistories.clear()
      void this.refreshSessions()
      if (this.snapshot.hostStatus?.kind === 'ready') void this.loadPermissionCatalog()
      return
    }

    if (frame.type === 'session/plugin-projections') {
      if (this.pluginProjections.apply(frame.sessionId, frame.change)) {
        this.set({
          sessions: this.snapshot.sessions.map(session => this.sessionWithProjectedTitle(session)),
        })
      }
      return
    }

    if (frame.type === 'session/interaction-requested') {
      this.upsertPendingInteraction(frame.sessionId, frame.interaction)
      return
    }

    if (frame.type === 'session/interaction-resolved') {
      this.resolvePendingInteraction(frame.sessionId, frame.resolution)
      return
    }

    if (frame.type === 'session/permissions') {
      const controls = this.sessionControls(frame.sessionId)
      if (frame.seq <= controls.permissionSeq) return
      const currentValue = parsePermissionCurrent(frame.value)
      if (currentValue === null) return
      controls.permissionSeq = frame.seq
      controls.permission = currentValue
      this.set(
        frame.sessionId === this.snapshot.selectedSessionId
          ? {
              sessionPermission: permissionSelectionFrom(
                currentValue,
                this.snapshot.permissionCatalog,
              ),
            }
          : {},
      )
      return
    }

    if (frame.type === 'session/model-selection') {
      if (!this.adoptModelSelectionProjection(frame.sessionId, frame.value, frame.seq)) return
      this.set(
        frame.sessionId === this.snapshot.selectedSessionId
          ? {
              sessionModels:
                this.snapshot.sessionModels === null
                  ? null
                  : sessionModelsWithSelection(this.snapshot.sessionModels, frame.value.next),
            }
          : {},
      )
      return
    }

    if (frame.type === 'session/title') {
      this.applySessionTitle(frame.sessionId, frame.title, frame.seq)
      return
    }

    if (frame.type === 'session/queue') {
      this.sessionQueues.set(frame.sessionId, frame.queue)
      this.set(
        frame.sessionId === this.snapshot.selectedSessionId ? { sessionQueue: frame.queue } : {},
      )
      return
    }

    if (frame.type === 'session/subscribed') {
      return
    }

    if (frame.type === 'session/snapshot') {
      if (frame.sessionId !== this.snapshot.selectedSessionId) {
        if (this.snapshot.openedSessionIds.includes(frame.sessionId)) {
          const history = mergeHistoryTail(this.sessionHistories.get(frame.sessionId)?.history, {
            events: frame.events,
            hasMore: frame.hasMore,
          })
          this.sessionHistories.set(frame.sessionId, {
            history,
            liveEvents: [],
            historyHasMore: historyHasMore(history),
          })
          this.set({})
        }
        return
      }
      // 首屏历史和正在生成的内容一次落地；迟到的分页响应不能覆盖更新的 follow 基线。
      this.historyGeneration += 1
      const history = mergeHistoryTail(this.snapshot.history, {
        events: frame.events,
        hasMore: frame.hasMore,
      })
      this.set({
        history,
        liveEvents: [],
        historyHasMore: historyHasMore(history),
        loadingHistory: false,
        loadingOlderHistory: false,
        historyError: null,
      })
      return
    }

    const sessions = this.snapshot.sessions.map(session =>
      session.sessionId !== frame.sessionId
        ? session
        : {
            ...session,
            updatedAt: Math.max(session.updatedAt, frame.event.time),
          },
    )
    const pendingTurn = this.pendingPromptTurns.get(frame.sessionId)
    const turn = isRecord(frame.event.data) ? frame.event.data.turn : null
    if (
      pendingTurn &&
      frame.event.seq > pendingTurn.afterSeq &&
      frame.event.type === 'turn/start' &&
      typeof turn === 'number'
    )
      pendingTurn.turn = turn
    const completedPendingTurn =
      pendingTurn &&
      frame.event.seq > pendingTurn.afterSeq &&
      frame.event.type === 'turn/end' &&
      typeof turn === 'number' &&
      turn === pendingTurn.turn
    if (completedPendingTurn) this.pendingPromptTurns.delete(frame.sessionId)
    const awaitingResponseSessionIds = completedPendingTurn
      ? this.awaitingResponseIds(frame.sessionId, false)
      : this.snapshot.awaitingResponseSessionIds
    const controls = this.sessionControls(frame.sessionId)
    const preset =
      frame.event.type === 'permission/preset' &&
      isRecord(frame.event.data) &&
      frame.event.seq > controls.permissionSeq
        ? parsePermissionCurrent({ currentValue: frame.event.data.preset })
        : null
    if (preset !== null) {
      controls.permission = preset
      controls.permissionSeq = frame.event.seq
    }
    if (frame.sessionId !== this.snapshot.selectedSessionId) {
      const cached = this.sessionHistories.get(frame.sessionId)
      if (
        cached &&
        !cached.liveEvents.some(event => event.seq === frame.event.seq) &&
        !normalizeSessionEvents(cached.history).some(event => event.seq === frame.event.seq)
      ) {
        const settled =
          frame.event.type === 'assistant/message' && isRecord(frame.event.data)
            ? frame.event.data
            : null
        const liveEvents = cached.liveEvents.filter(
          event =>
            !(
              settled &&
              event.type === 'assistant/chunk' &&
              isRecord(event.data) &&
              event.data.turn === settled.turn &&
              event.data.step === settled.step
            ),
        )
        this.sessionHistories.set(frame.sessionId, {
          ...cached,
          liveEvents: [...liveEvents, frame.event].toSorted((a, b) => a.seq - b.seq),
        })
      }
      this.acceptSessionCapabilityEvent(frame.sessionId, frame.event)
      this.set({ sessions, awaitingResponseSessionIds }, frame.event.type === 'assistant/chunk')
      return
    }

    const historyEvents =
      isRecord(this.snapshot.history) && Array.isArray(this.snapshot.history.events)
        ? (this.snapshot.history.events as CanonicalSessionEvent[])
        : []
    if (
      this.snapshot.liveEvents.some(event => event.seq === frame.event.seq) ||
      historyEvents.some(event => event.seq === frame.event.seq)
    ) {
      if (sessions !== this.snapshot.sessions)
        this.set({ sessions, awaitingResponseSessionIds }, frame.event.type === 'assistant/chunk')
      return
    }
    this.acceptSessionCapabilityEvent(frame.sessionId, frame.event)
    // 权限事件只改当前值；可选列表仍来自进程级目录。
    const sessionPermission =
      preset === null
        ? this.snapshot.sessionPermission
        : (permissionSelectionFrom(preset, this.snapshot.permissionCatalog) ??
          this.snapshot.sessionPermission)
    let liveEvents = this.snapshot.liveEvents
    let history = this.snapshot.history
    const settlement = frame.event.data
    if (
      frame.event.type === 'assistant/message' &&
      isRecord(settlement) &&
      typeof settlement.turn === 'number' &&
      typeof settlement.step === 'number'
    ) {
      const keep = (event: CanonicalSessionEvent): boolean =>
        event.type !== 'assistant/chunk' ||
        !isRecord(event.data) ||
        event.data.turn !== settlement.turn ||
        event.data.step !== settlement.step
      liveEvents = liveEvents.filter(keep)
      const retained = historyEvents.filter(keep)
      if (retained.length !== historyEvents.length)
        history = { ...(this.snapshot.history as object), events: retained }
    }
    const appended = [...liveEvents, frame.event]
    if ((liveEvents.at(-1)?.seq ?? -1) > frame.event.seq)
      appended.sort((left, right) => left.seq - right.seq)
    this.set(
      {
        sessions,
        awaitingResponseSessionIds,
        sessionPermission,
        history,
        liveEvents: appended,
      },
      frame.event.type === 'assistant/chunk',
    )
  }

  private acceptHostFrame(input: DesktopHostFrame): void {
    const frame = parseDesktopHostFrame(input)
    if (frame === null) return
    if (
      frame.type === 'host/settings-updated' ||
      frame.type === 'host/model-adapters-updated' ||
      frame.type === 'host/credential-updated'
    ) {
      if (frame.type === 'host/settings-updated')
        this.set({ hostSettingsRevision: this.snapshot.hostSettingsRevision + 1 })
      else if (frame.type === 'host/model-adapters-updated')
        this.set({ hostModelsRevision: this.snapshot.hostModelsRevision + 1 })
      else this.set({ hostCredentialsRevision: this.snapshot.hostCredentialsRevision + 1 })
      if (this.snapshot.hostStatus?.kind === 'ready') void this.loadSessionModels(true)
      return
    }
    if (frame.type === 'host/goal-activation-changed') {
      if (frame.sessionId === this.snapshot.selectedSessionId)
        this.set({ pluginRevision: this.snapshot.pluginRevision + 1 })
      return
    }
    if (frame.type === 'host/archived-sessions-changed') {
      const revision = ++this.hostFrameRevision
      this.latestArchivedSessionsFrame = {
        revision,
        archivedSessionIds: frame.archivedSessionIds,
      }
      this.set({
        archivedSessionIds: [...frame.archivedSessionIds],
        sessionArchiveCapability: 'available',
      })
      void this.refreshSessions()
      return
    }
    if (
      frame.type === 'host/workspace-changed' ||
      frame.type === 'host/workspace-removed' ||
      frame.type === 'host/workspace-order-changed'
    ) {
      this.workspaceFrames.push({ revision: ++this.hostFrameRevision, frame })
      void this.refreshSessions()
      return
    }
    if (frame.type === 'host/commands-changed') {
      this.invalidateAllCommandDirectories()
      if (this.snapshot.selectedSessionId !== null) {
        void this.loadSessionCommandDirectory(this.snapshot.selectedSessionId, true)
      }
      return
    }
    if (frame.type === 'host/agent-preset-selected') {
      this.invalidateCommandDirectory(frame.sessionId)
      if (frame.sessionId === this.snapshot.selectedSessionId) {
        void this.loadSessionCommandDirectory(frame.sessionId, true)
      }
      return
    }
    const revision = ++this.hostFrameRevision
    const previous = this.hostSessionOverlays.get(frame.sessionId)

    if (frame.type === 'host/session-added') {
      this.set({ pluginRevision: this.snapshot.pluginRevision + 1 })
      this.hostSessionOverlays.set(frame.sessionId, {
        revision,
        added: {
          sessionId: frame.sessionId,
          updatedAt: Date.now(),
          running: false,
          blank: frame.blank,
          ...(frame.cwd === undefined ? {} : { cwd: frame.cwd }),
          ...(frame.agentPreset === undefined ? {} : { agentPreset: frame.agentPreset }),
        },
        detached: false,
      })
      void this.refreshSessions()
      return
    }

    if (frame.type === 'host/session-status') {
      // 复用全局运行状态；后台标签完成一轮后提示更新，不额外订阅其输出流。
      const completed =
        !frame.running &&
        this.snapshot.sessions.some(
          session => session.sessionId === frame.sessionId && session.running,
        )
      this.set({ pluginRevision: this.snapshot.pluginRevision + 1 })
      this.hostSessionOverlays.set(frame.sessionId, {
        ...previous,
        revision,
        running: frame.running,
        detached: false,
      })
      const sessions = this.snapshot.sessions.map(session =>
        session.sessionId !== frame.sessionId
          ? session
          : {
              ...session,
              running: frame.running,
              ...(frame.running
                ? { blank: false, updatedAt: Math.max(session.updatedAt, Date.now()) }
                : {}),
            },
      )
      if (frame.running) this.pendingPromptTurns.delete(frame.sessionId)
      this.set({
        sessions,
        unreadSessionIds:
          completed && !this.snapshot.unreadSessionIds.includes(frame.sessionId)
            ? [...this.snapshot.unreadSessionIds, frame.sessionId]
            : this.snapshot.unreadSessionIds,
        awaitingResponseSessionIds: frame.running
          ? this.awaitingResponseIds(frame.sessionId, false)
          : this.snapshot.awaitingResponseSessionIds,
      })
      return
    }

    if (frame.type === 'host/session-removed') {
      this.set({ pluginRevision: this.snapshot.pluginRevision + 1 })
      this.sessionTitleProjections.delete(frame.sessionId)
      this.pluginProjections.delete(frame.sessionId)
      this.hostSessionOverlays.set(frame.sessionId, {
        ...previous,
        revision,
        running: false,
        detached: true,
      })
      const transientPatch = this.deleteSessionTransientState(frame.sessionId)
      const sessions = this.snapshot.sessions.map(session =>
        session.sessionId === frame.sessionId ? { ...session, running: false } : session,
      )
      this.set({
        sessions,
        ...transientPatch,
        // 写句柄释放早于日志删除完成，操作的加载状态由请求自身收口。
        archivingSessionIds: this.snapshot.archivingSessionIds,
      })
      void this.refreshSessions()
      return
    }

    this.pendingPromptTurns.delete(frame.sessionId)
    if (frame.sessionId === this.snapshot.selectedSessionId) {
      this.set({
        awaitingResponseSessionIds: this.awaitingResponseIds(frame.sessionId, false),
        error: `智能体运行失败：${errorMessage(frame.message)}`,
      })
    } else {
      this.set({ awaitingResponseSessionIds: this.awaitingResponseIds(frame.sessionId, false) })
    }
  }

  async respondPendingInteraction(
    submission: DesktopInteractionSubmission,
  ): Promise<DesktopInteractionReceipt> {
    const pending = this.sessionInteractions.get(submission.sessionId)?.get(submission.key)
    if (pending === undefined) return { accepted: false, reason: 'not-pending' }
    if (this.bridge.interactions === undefined) throw new Error('当前桌面桥不支持回答交互请求')
    const receipt = await this.bridge.interactions.respond(submission)
    if (!receipt.accepted && receipt.reason === 'not-pending') {
      const current = this.sessionInteractions.get(submission.sessionId)
      current?.delete(submission.key)
      if (current?.size === 0) this.sessionInteractions.delete(submission.sessionId)
      if (this.snapshot.selectedSessionId === submission.sessionId) {
        this.set({ pendingInteractions: this.pendingInteractionsFor(submission.sessionId) })
      }
    }
    return receipt
  }

  async updateSessionQueue(
    itemId: string,
    action: DesktopSessionQueueAction,
    sessionId = this.snapshot.selectedSessionId,
  ): Promise<boolean> {
    const item = (
      sessionId === null
        ? this.snapshot.sessionQueue
        : (this.sessionQueues.get(sessionId) ?? this.snapshot.sessionQueue)
    ).items.find(candidate => candidate.id === itemId)
    const editText = action.kind === 'edit' ? action.content[0].text : null
    if (
      sessionId === null ||
      itemId === '' ||
      this.snapshot.queueUpdatingIds.includes(itemId) ||
      item === undefined ||
      item.placement === 'context' ||
      (action.kind === 'edit' &&
        (item.edit.kind !== 'editable-text' ||
          editText === null ||
          editText.trim() === '' ||
          new TextEncoder().encode(editText).byteLength > DESKTOP_QUEUE_EDIT_MAX_BYTES))
    ) {
      return false
    }
    this.set({ queueUpdatingIds: [...this.snapshot.queueUpdatingIds, itemId], error: null })
    try {
      await this.bridge.host.call('updateSessionQueue', { sessionId, itemId, action })
      const current = this.sessionQueues.get(sessionId) ?? this.snapshot.sessionQueue
      const nextItems =
        action.kind === 'edit'
          ? current.items.map(queueItem =>
              queueItem.id === itemId
                ? {
                    ...queueItem,
                    preview: action.content[0].text.trim().slice(0, DESKTOP_QUEUE_PREVIEW_LIMIT),
                    previewTruncated:
                      action.content[0].text.trim().length > DESKTOP_QUEUE_PREVIEW_LIMIT,
                    edit: { kind: 'editable-text' as const, text: action.content[0].text },
                  }
                : queueItem,
            )
          : action.kind === 'steer'
            ? current.items.map(queueItem =>
                queueItem.id === itemId
                  ? { ...queueItem, placement: 'steering' as const }
                  : queueItem,
              )
            : current.items.filter(queueItem => queueItem.id !== itemId)
      const totalCount =
        action.kind === 'remove' ? Math.max(0, current.totalCount - 1) : current.totalCount
      const omittedCount = Math.max(0, totalCount - nextItems.length)
      const next: DesktopQueueSnapshot = {
        items: nextItems,
        totalCount,
        omittedCount,
        truncated: omittedCount > 0,
      }
      this.sessionQueues.set(sessionId, next)
      if (this.snapshot.selectedSessionId === sessionId) this.set({ sessionQueue: next })
      return true
    } catch (error) {
      this.set({ error: errorMessage(error) })
      return false
    } finally {
      this.set({
        queueUpdatingIds: this.snapshot.queueUpdatingIds.filter(id => id !== itemId),
      })
    }
  }

  async createSession(projectId?: string, agentPreset?: string): Promise<boolean> {
    if (this.snapshot.creatingSession) return false
    const selectedSessionId = this.snapshot.selectedSessionId
    const selectedProjectId = this.snapshot.selectedProjectId
    const project =
      projectId === undefined
        ? this.selectedProject()
        : this.snapshot.projects.find(item => item.id === projectId)
    const blankSession =
      agentPreset === undefined && project?.source === 'workspace'
        ? sessionsForProject(this.snapshot.sessions, project).find(session => session.blank)
        : undefined
    if (blankSession !== undefined) {
      this.selectSession(blankSession.sessionId)
      return true
    }
    this.set({ creatingSession: true, error: null })
    try {
      const value =
        project?.source === 'workspace'
          ? await this.bridge.host.call('createSessionForWorkspace', {
              workspaceId: project.workspaceId,
              ...(agentPreset ? { agentPreset } : {}),
            })
          : await this.bridge.host.call('createSession', {
              ...(project?.cwd ? { cwd: project.cwd } : {}),
              ...(agentPreset ? { agentPreset } : {}),
            })
      const sessionId = createdSessionId(value)
      if (sessionId === undefined) throw new Error('运行核心创建新会话后没有返回有效标识')
      await this.refreshSessions()
      if (
        this.snapshot.selectedProjectId === selectedProjectId &&
        (this.snapshot.selectedSessionId === selectedSessionId ||
          this.snapshot.selectedSessionId === sessionId)
      ) {
        this.selectSession(sessionId)
      }
      return true
    } catch (error) {
      this.set({ error: errorMessage(error) })
      return false
    } finally {
      this.set({ creatingSession: false })
    }
  }

  /**
   * 在空会话或新会话草稿态切换目标工作区：优先复用目标工作区的现有空会话，否则新建空会话，
   * 并将当前尚未发送的文字草稿与图片附件迁移到目标会话；「全部项目」视图下保持不收窄左侧筛选。
   */
  async switchDraftWorkspace(projectId: string, sourceSessionId?: string | null): Promise<boolean> {
    if (this.snapshot.creatingSession) return false
    const project = this.snapshot.projects.find(item => item.id === projectId)
    if (project === undefined) return false
    const currentSession =
      sourceSessionId === undefined
        ? this.selectedSession()
        : sourceSessionId === null
          ? undefined
          : this.snapshot.sessions.find(item => item.sessionId === sourceSessionId)
    if (typeof sourceSessionId === 'string' && currentSession === undefined) return false
    const currentSessionId = currentSession?.sessionId ?? null
    const currentIsBlank = currentSession?.blank === true
    if (currentSession !== undefined && !currentIsBlank) return false
    if (
      currentSessionId !== null &&
      (this.snapshot.sessionFiles[currentSessionId]?.length ?? 0) > 0
    ) {
      this.set({ error: '当前会话包含已关联的文件附件；请先移除文件附件后再切换工作区' })
      return false
    }
    const currentProject = resolveDraftProject({
      projects: this.snapshot.projects,
      sessions: this.snapshot.sessions,
      session: currentSession,
      newSessionProjectId: this.snapshot.newSessionProjectId,
      selectedProjectId: this.snapshot.selectedProjectId,
    })
    if (
      currentProject?.id === project.id &&
      (currentIsBlank || this.snapshot.newSessionProjectId === project.id)
    ) {
      return true
    }
    const carriedDraft =
      currentSessionId !== null
        ? (this.snapshot.sessionDrafts[currentSessionId] ?? '')
        : this.snapshot.newSessionDraft
    const carriedAttachments =
      currentSessionId !== null ? (this.snapshot.sessionAttachments[currentSessionId] ?? []) : []
    const hasCarriedContent = carriedDraft !== '' || carriedAttachments.length > 0
    const nextSelectedProjectId = this.snapshot.selectedProjectId === null ? null : project.id
    const applySwitchToTarget = (targetSession: SessionSummary): void => {
      const targetId = targetSession.sessionId
      let nextDrafts = this.snapshot.sessionDrafts
      let draftTransferred = carriedDraft === ''
      if (carriedDraft !== '' && (nextDrafts[targetId] ?? '') === '') {
        const updatedDrafts = { ...nextDrafts, [targetId]: carriedDraft }
        if (currentSessionId !== null && currentSessionId !== targetId) {
          delete updatedDrafts[currentSessionId]
        }
        nextDrafts = updatedDrafts
        draftTransferred = true
      }
      let nextAttachments = this.snapshot.sessionAttachments
      let attachmentsTransferred = carriedAttachments.length === 0
      if (carriedAttachments.length > 0 && (nextAttachments[targetId]?.length ?? 0) === 0) {
        const updatedAttachments = { ...nextAttachments, [targetId]: carriedAttachments }
        if (currentSessionId !== null && currentSessionId !== targetId) {
          delete updatedAttachments[currentSessionId]
        }
        nextAttachments = updatedAttachments
        attachmentsTransferred = true
      }
      if (
        nextDrafts !== this.snapshot.sessionDrafts ||
        nextAttachments !== this.snapshot.sessionAttachments
      ) {
        this.set({ sessionDrafts: nextDrafts, sessionAttachments: nextAttachments })
      }
      const canRetireCurrentTab =
        currentSessionId !== null &&
        currentSessionId !== targetId &&
        draftTransferred &&
        attachmentsTransferred
      const nextOpenedSessionIds = canRetireCurrentTab
        ? this.snapshot.openedSessionIds.includes(targetId)
          ? this.snapshot.openedSessionIds.filter(id => id !== currentSessionId)
          : this.snapshot.openedSessionIds.map(id => (id === currentSessionId ? targetId : id))
        : undefined
      this.selectSessionWithConversation(targetSession, nextSelectedProjectId, nextOpenedSessionIds)
    }
    const blankSession = sessionsForProject(this.snapshot.sessions, project).find(session => {
      if (!session.blank) return false
      if (!hasCarriedContent) return true
      return (
        (this.snapshot.sessionDrafts[session.sessionId] ?? '') === '' &&
        (this.snapshot.sessionAttachments[session.sessionId]?.length ?? 0) === 0 &&
        (this.snapshot.sessionFiles[session.sessionId]?.length ?? 0) === 0
      )
    })
    if (blankSession !== undefined) {
      applySwitchToTarget(blankSession)
      return true
    }
    const previousProjectId = this.snapshot.selectedProjectId
    const previousSelectedSessionId = this.snapshot.selectedSessionId
    const previousNewSessionProjectId = this.snapshot.newSessionProjectId
    this.set({ creatingSession: true, error: null })
    try {
      const value =
        project.source === 'workspace'
          ? await this.bridge.host.call('createSessionForWorkspace', {
              workspaceId: project.workspaceId,
            })
          : await this.bridge.host.call('createSession', project.cwd ? { cwd: project.cwd } : {})
      const sessionId = createdSessionId(value)
      if (sessionId === undefined) throw new Error('运行核心创建新会话后没有返回有效标识')
      await this.refreshSessions()
      const sourceStillValid =
        currentSessionId === null
          ? this.snapshot.selectedSessionId === null &&
            this.snapshot.newSessionProjectId === previousNewSessionProjectId
          : this.snapshot.sessions.some(
              item => item.sessionId === currentSessionId && item.blank === true,
            ) &&
            (sourceSessionId !== undefined ||
              this.snapshot.selectedSessionId === previousSelectedSessionId)
      if (this.snapshot.selectedProjectId !== previousProjectId || !sourceStillValid) return false
      const created = this.snapshot.sessions.find(session => session.sessionId === sessionId)
      if (created === undefined) throw new Error('新会话已创建，但尚未出现在会话列表中')
      applySwitchToTarget(created)
      return true
    } catch (error) {
      this.set({ error: errorMessage(error) })
      return false
    } finally {
      this.set({ creatingSession: false })
    }
  }

  /** 将当前输入草稿实体化为会话但不发送消息，供授权等首轮前操作使用。 */
  async ensureComposerSession(): Promise<string | null> {
    if (this.snapshot.selectedSessionId !== null) return this.snapshot.selectedSessionId
    const projectId = this.snapshot.newSessionProjectId
    const project = this.snapshot.projects.find(item => item.id === projectId)
    if (project?.source !== 'workspace' || this.snapshot.creatingSession) return null
    this.set({ creatingSession: true, error: null })
    try {
      const value = await this.bridge.host.call('createSessionForWorkspace', {
        workspaceId: project.workspaceId,
      })
      const sessionId = createdSessionId(value)
      if (sessionId === undefined) throw new Error('运行核心创建新会话后没有返回有效标识')
      await this.refreshSessions()
      if (
        this.snapshot.newSessionProjectId !== projectId ||
        (this.snapshot.selectedProjectId !== null &&
          this.snapshot.selectedProjectId !== projectId) ||
        this.snapshot.selectedSessionId !== null
      )
        return null
      if (!this.snapshot.sessions.some(session => session.sessionId === sessionId))
        throw new Error('新会话已创建，但尚未出现在会话列表中')
      // 采用等待期间的最新文字，不能用点击授权前的旧副本覆盖继续输入的草稿。
      const draft = this.snapshot.newSessionDraft
      this.set({ sessionDrafts: { ...this.snapshot.sessionDrafts, [sessionId]: draft } })
      this.selectSession(sessionId)
      return sessionId
    } catch (error) {
      this.set({ error: errorMessage(error) })
      return null
    } finally {
      this.set({ creatingSession: false })
    }
  }

  async createWorkspace(): Promise<boolean> {
    if (this.snapshot.workspaceCapability !== 'available') return false
    const path = await this.bridge.host.call('pickWorkspaceDirectory', {})
    if (path === null) return false
    if (typeof path !== 'string' || path === '') throw new Error('运行核心返回了无效的项目目录')
    const result = parseDesktopWorkspaceCreateResult(
      await this.bridge.host.call('createWorkspace', { path }),
    )
    await this.refreshSessions()
    this.selectProject(projectIdForCwd(result.workspace.path), true)
    return true
  }

  async renameWorkspace(projectId: string, title: string): Promise<boolean> {
    const project = this.snapshot.projects.find(item => item.id === projectId)
    if (project?.source !== 'workspace' || title.trim() === '') return false
    try {
      parseDesktopWorkspaceChangeResult(
        await this.bridge.host.call('renameWorkspace', {
          workspaceId: project.workspaceId,
          title: title.trim(),
        }),
      )
      await this.refreshSessions()
      return true
    } catch (error) {
      this.set({ error: errorMessage(error) })
      return false
    }
  }

  async removeWorkspace(projectId: string): Promise<boolean> {
    const project = this.snapshot.projects.find(item => item.id === projectId)
    if (project?.source !== 'workspace') return false
    try {
      parseDesktopWorkspaceDeleteResult(
        await this.bridge.host.call('removeWorkspace', {
          workspaceId: project.workspaceId,
        }),
      )
      await this.refreshSessions()
      return true
    } catch (error) {
      this.set({ error: errorMessage(error) })
      return false
    }
  }

  async reorderWorkspace(projectId: string, beforeProjectId?: string): Promise<boolean> {
    const project = this.snapshot.projects.find(item => item.id === projectId)
    const beforeProject =
      beforeProjectId === undefined
        ? undefined
        : this.snapshot.projects.find(item => item.id === beforeProjectId)
    if (
      project?.source !== 'workspace' ||
      (beforeProjectId !== undefined && beforeProject?.source !== 'workspace')
    )
      return false
    try {
      parseDesktopWorkspaceOrderResult(
        await this.bridge.host.call('reorderWorkspace', {
          workspaceId: project.workspaceId,
          ...(beforeProject?.source === 'workspace'
            ? { beforeWorkspaceId: beforeProject.workspaceId }
            : {}),
        }),
      )
      await this.refreshSessions()
      return true
    } catch (error) {
      this.set({ error: errorMessage(error) })
      return false
    }
  }

  archiveSession(sessionId: string): Promise<boolean> {
    return this.setSessionArchived(sessionId, true)
  }

  unarchiveSession(sessionId: string): Promise<boolean> {
    return this.setSessionArchived(sessionId, false)
  }

  async deleteArchivedSession(sessionId: string, refresh = true): Promise<boolean> {
    if (
      this.snapshot.sessionArchiveCapability !== 'available' ||
      !this.snapshot.archivedSessionIds.includes(sessionId) ||
      this.snapshot.archivingSessionIds.includes(sessionId)
    )
      return false
    const hostGeneration = this.hostGeneration
    this.set({
      archivingSessionIds: [...this.snapshot.archivingSessionIds, sessionId],
      error: null,
    })
    try {
      const value = await this.bridge.host.call('deleteArchivedSession', { sessionId })
      if (hostGeneration !== this.hostGeneration) return false
      const archive = parseDesktopWorkspaceArchiveSnapshot(value)
      this.set({
        ...this.deleteSessionTransientState(sessionId),
        archivedSessionIds: [...archive.archivedSessionIds],
      })
      if (refresh) await this.refreshSessions()
      return hostGeneration === this.hostGeneration
    } catch (error) {
      if (hostGeneration !== this.hostGeneration) return false
      throw new Error(errorMessage(error), { cause: error })
    } finally {
      if (hostGeneration === this.hostGeneration)
        this.set({
          archivingSessionIds: this.snapshot.archivingSessionIds.filter(id => id !== sessionId),
        })
    }
  }

  private async setSessionArchived(sessionId: string, archived: boolean): Promise<boolean> {
    if (
      this.snapshot.sessionArchiveCapability !== 'available' ||
      this.snapshot.archivedSessionIds.includes(sessionId) === archived ||
      this.snapshot.archivingSessionIds.includes(sessionId) ||
      !(archived ? this.snapshot.sessions : this.snapshot.archivedSessions).some(
        session => session.sessionId === sessionId,
      )
    ) {
      return false
    }
    const hostGeneration = this.hostGeneration
    this.set({
      archivingSessionIds: [...this.snapshot.archivingSessionIds, sessionId],
      error: null,
    })
    try {
      const value = await this.bridge.host.call(archived ? 'archiveSession' : 'unarchiveSession', {
        sessionId,
      })
      if (hostGeneration !== this.hostGeneration) return false
      const snapshot = parseDesktopWorkspaceArchiveSnapshot(value)
      this.set({
        archivedSessionIds: [...snapshot.archivedSessionIds],
        sessionArchiveCapability: 'available',
      })
      await this.refreshSessions()
      return hostGeneration === this.hostGeneration
    } catch (error) {
      if (hostGeneration === this.hostGeneration) this.set({ error: errorMessage(error) })
      return false
    } finally {
      if (hostGeneration === this.hostGeneration) {
        this.set({
          archivingSessionIds: this.snapshot.archivingSessionIds.filter(id => id !== sessionId),
        })
      }
    }
  }

  async renameSession(sessionId: string, title: string): Promise<boolean> {
    const session = this.snapshot.sessions.find(item => item.sessionId === sessionId)
    if (session === undefined || session.blank || title.trim() === '') return false
    try {
      const result = parseDesktopSessionRenameResult(
        await this.bridge.host.call('renameSession', {
          sessionId,
          title,
        }),
      )
      this.applySessionTitle(sessionId, result.title, result.seq)
      return true
    } catch (error) {
      this.set({ error: errorMessage(error) })
      return false
    }
  }

  async searchSessions(query: string): Promise<DesktopSessionSearchResult> {
    const normalized = sanitizeDesktopSessionSearchQuery(query).trim()
    if (normalized === '') return { items: [], hasMore: false }
    if (this.bridge.host.searchSessions === undefined) {
      throw new Error('当前桌面桥不支持会话内容搜索')
    }
    return parseDesktopSessionSearchResult(await this.bridge.host.searchSessions(normalized))
  }

  cancelSessionSearch(): void {
    const cancel = this.bridge.host.cancelSessionSearch
    if (cancel !== undefined) void cancel().catch(() => undefined)
  }

  async forkSession(sessionId: string): Promise<boolean> {
    const source = this.snapshot.sessions.find(item => item.sessionId === sessionId)
    if (source === undefined || source.blank) return false
    try {
      const result = parseDesktopSessionForkResult(
        await this.bridge.host.call('forkSession', { sessionId }),
      )
      await this.refreshSessions()
      if (this.snapshot.sessions.some(session => session.sessionId === result.sessionId)) {
        this.selectSession(result.sessionId)
      }
      if (result.workspaceAttachFailed) {
        this.set({
          error: '分叉会话已经创建，但未能附加回原项目；请在“无项目对话”中继续处理。',
        })
      }
      return true
    } catch (error) {
      this.set({ error: errorMessage(error) })
      return false
    }
  }

  async reorderWorkspaceSession(
    projectId: string,
    sessionId: string,
    beforeSessionId?: string,
  ): Promise<boolean> {
    const project = this.snapshot.projects.find(item => item.id === projectId)
    if (
      project?.source !== 'workspace' ||
      !project.sessionIds.includes(sessionId) ||
      (beforeSessionId !== undefined && !project.sessionIds.includes(beforeSessionId))
    )
      return false
    try {
      parseDesktopWorkspaceChangeResult(
        await this.bridge.host.call('reorderWorkspaceSession', {
          workspaceId: project.workspaceId,
          sessionId,
          ...(beforeSessionId === undefined ? {} : { beforeSessionId }),
        }),
      )
      await this.refreshSessions()
      return true
    } catch (error) {
      this.set({ error: errorMessage(error) })
      return false
    }
  }

  async loadSessionCommandDirectory(
    sessionIdInput: string | null = this.snapshot.selectedSessionId,
    force = false,
  ): Promise<boolean> {
    const sessionId = sessionIdInput
    if (sessionId === null) return false
    const current = this.commandDirectories.get(sessionId)
    if (!force && current?.status === 'ready') return true
    const inFlight = this.commandDirectoryRequests.get(sessionId)
    if (!force && inFlight !== undefined) return inFlight

    const api = this.bridge.commands
    if (api === undefined) {
      this.setCommandDirectoryState(sessionId, {
        status: 'error',
        value: null,
        error: '当前桌面桥版本不支持斜杠命令目录；请重新启动更新后的 MyDSH',
        commandError: '需要重新启动更新后的 MyDSH',
        skillError: '需要重新启动更新后的 MyDSH',
      })
      return false
    }

    const requestGeneration = ++this.nextCommandDirectoryGeneration
    this.commandDirectoryGenerations.set(sessionId, requestGeneration)
    const hostGeneration = this.hostGeneration
    this.setCommandDirectoryState(sessionId, {
      status: 'loading',
      value: current?.value ?? null,
      error: null,
      commandError: null,
      skillError: null,
    })

    const request = Promise.allSettled([
      Promise.resolve().then(() => api.list(sessionId)),
      Promise.resolve().then(() => api.listSkills(sessionId)),
    ])
      .then(([commandResult, skillResult]) => {
        if (
          hostGeneration !== this.hostGeneration ||
          requestGeneration !== this.commandDirectoryGenerations.get(sessionId)
        )
          return false

        const commandError =
          commandResult.status === 'rejected' ? errorMessage(commandResult.reason) : null
        const skillError =
          skillResult.status === 'rejected' ? errorMessage(skillResult.reason) : null
        if (commandResult.status === 'rejected' && skillResult.status === 'rejected') {
          const error = `命令目录读取失败：${commandError ?? '未知错误'}；Skill 目录读取失败：${skillError ?? '未知错误'}`
          this.setCommandDirectoryState(sessionId, {
            status: 'error',
            value: current?.value ?? null,
            error,
            commandError,
            skillError,
          })
          return false
        }

        this.setCommandDirectoryState(sessionId, {
          status: 'ready',
          value: {
            commands: commandResult.status === 'fulfilled' ? commandResult.value : [],
            skills: skillResult.status === 'fulfilled' ? skillResult.value : [],
          },
          error: null,
          commandError,
          skillError,
        })
        return true
      })
      .finally(() => {
        if (this.commandDirectoryRequests.get(sessionId) === request) {
          this.commandDirectoryRequests.delete(sessionId)
        }
      })
    this.commandDirectoryRequests.set(sessionId, request)
    return request
  }

  /**
   * 读取进程级权限预设目录。目录属于运行核心而不是 Session，因此按需加载一次，
   * 之后与每个会话的 `permissions` 当前值合成胶囊的可选列表。
   */
  async loadPermissionCatalog(force = false): Promise<boolean> {
    if (!force && this.snapshot.loadingPermissionCatalog) return false
    if (!force && this.snapshot.permissionCatalog !== null) return true
    const generation = ++this.permissionCatalogGeneration
    this.set({ loadingPermissionCatalog: true, permissionCatalogError: null })
    try {
      const value = await this.bridge.host.call('listPermissionPresets', {})
      const catalog = parsePermissionCatalog(value)
      if (catalog === null) throw new Error('运行核心返回了无效的权限预设目录')
      if (generation !== this.permissionCatalogGeneration) return false
      this.set({
        permissionCatalog: catalog,
        loadingPermissionCatalog: false,
        permissionCatalogError: null,
        sessionPermission: permissionSelectionFrom(
          this.snapshot.selectedSessionId === null
            ? null
            : this.sessionControls(this.snapshot.selectedSessionId).permission,
          catalog,
        ),
      })
      return true
    } catch (error) {
      if (generation !== this.permissionCatalogGeneration) return false
      this.set({ loadingPermissionCatalog: false, permissionCatalogError: errorMessage(error) })
      return false
    }
  }

  /** 权限投影只发布当前值；与进程级目录合成后才成为胶囊的可选列表。 */
  private projectedPermission(
    sessionId: string | null,
    source: unknown,
  ): PermissionSelection | null {
    if (sessionId === null) return null
    const controls = this.sessionControls(sessionId)
    const permission = parsePermissionCurrent(source)
    const seq = projectionSeq(source)
    if (permission !== null && seq >= controls.permissionSeq) {
      controls.permission = permission
      controls.permissionSeq = seq
    }
    return permissionSelectionFrom(controls.permission, this.snapshot.permissionCatalog)
  }

  private setSessionView(
    sessionId: string,
    patch: Partial<
      Pick<
        WorkspaceSnapshot,
        | 'sessionModels'
        | 'sessionModelsError'
        | 'loadingSessionModels'
        | 'selectingSessionModel'
        | 'switchingPermissionPreset'
      >
    >,
  ): void {
    if (this.snapshot.selectedSessionId === sessionId) {
      this.set(patch)
      return
    }
    const previous = this.sessionViews.get(sessionId)
    this.sessionViews.set(sessionId, {
      activeView: 'conversation',
      sessionModels: null,
      ...previous,
      ...patch,
    })
    this.set({})
  }

  async loadSessionModels(
    force = false,
    sessionId = this.snapshot.selectedSessionId,
  ): Promise<boolean> {
    if (sessionId === null) return false
    const current = this.sessionSnapshot(sessionId)
    if (!force && current.loadingSessionModels) return false
    if (!force && current.sessionModels !== null) return true
    const generation = (this.sessionModelsRequests.get(sessionId) ?? 0) + 1
    const hostGeneration = this.hostGeneration
    this.sessionModelsRequests.set(sessionId, generation)
    this.setSessionView(sessionId, { loadingSessionModels: true, sessionModelsError: null })
    try {
      const value = await this.bridge.host.call('getSessionModels', { sessionId })
      const projected = this.sessionControls(sessionId).model
      const sessionModels = parseSessionModels(value, projected)
      if (sessionModels === null) throw new Error('运行核心返回了无效的模型目录')
      if (
        generation !== this.sessionModelsRequests.get(sessionId) ||
        hostGeneration !== this.hostGeneration
      )
        return false
      this.setSessionView(sessionId, {
        sessionModels,
        loadingSessionModels: false,
        sessionModelsError: null,
      })
      return true
    } catch (error) {
      if (
        generation !== this.sessionModelsRequests.get(sessionId) ||
        hostGeneration !== this.hostGeneration
      )
        return false
      this.setSessionView(sessionId, {
        loadingSessionModels: false,
        sessionModelsError: errorMessage(error),
      })
      return false
    }
  }

  async selectSessionModel(
    selection: ModelSelection,
    sessionId = this.snapshot.selectedSessionId,
  ): Promise<boolean> {
    if (sessionId === null) return false
    const session = this.snapshot.sessions.find(item => item.sessionId === sessionId)
    const current = this.sessionSnapshot(sessionId)
    const directory = current.sessionModels
    if (session === undefined || directory === null || current.selectingSessionModel) return false
    const group = directory.groups.find(candidate => candidate.id === selection.provider)
    const model = group?.models.find(candidate => candidate.id === selection.model)
    const effortValid =
      selection.reasoningEffort === undefined ||
      model?.reasoning?.efforts.some(effort => effort.id === selection.reasoningEffort) === true
    if (model === undefined || !effortValid) return false

    const generation = this.hostGeneration
    this.setSessionView(sessionId, { selectingSessionModel: true, sessionModelsError: null })
    try {
      const value = await this.bridge.host.call('selectSessionModel', {
        sessionId,
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: selection.reasoningEffort }),
      })
      const selected = parseSelectedModelResponse(value)
      if (selected === null) throw new Error('运行核心返回了无效的模型选择结果')
      if (generation !== this.hostGeneration) return false
      this.sessionControls(sessionId).model = selected
      this.setSessionView(sessionId, {
        sessionModels: sessionModelsWithSelection(directory, selected),
        selectingSessionModel: false,
        sessionModelsError: null,
      })
      return true
    } catch (error) {
      if (generation !== this.hostGeneration) return false
      const message = errorMessage(error)
      this.setSessionView(sessionId, { selectingSessionModel: false, sessionModelsError: message })
      return false
    }
  }

  async selectPermissionPreset(
    preset: string,
    sessionId = this.snapshot.selectedSessionId,
  ): Promise<boolean> {
    if (sessionId === null) return false
    const session = this.snapshot.sessions.find(item => item.sessionId === sessionId)
    const current = this.sessionSnapshot(sessionId)
    const selection = current.sessionPermission
    const option = selection?.options.find(candidate => candidate.value === preset)
    if (
      session === undefined ||
      selection === null ||
      option?.selectable !== true ||
      current.switchingPermissionPreset
    )
      return false
    if (selection.currentValue === preset) return true

    // 不做乐观更新：权限的当前值只由运行核心的权限投影决定，命令返回只负责报错。
    const generation = this.hostGeneration
    this.setSessionView(sessionId, { switchingPermissionPreset: true })
    try {
      const value = await this.bridge.host.call('selectPermissionPreset', { sessionId, preset })
      const commandError = permissionCommandError(value)
      if (commandError !== null) throw new Error(commandError)
      if (generation !== this.hostGeneration) return false
      this.setSessionView(sessionId, { switchingPermissionPreset: false })
      return true
    } catch (error) {
      if (generation === this.hostGeneration) {
        this.setSessionView(sessionId, { switchingPermissionPreset: false })
        this.set({ error: errorMessage(error) })
      }
      return false
    }
  }

  setSessionDraft(sessionId: string, text: string): void {
    if (sessionId === '') return
    const sessionDrafts = { ...this.snapshot.sessionDrafts }
    if (text === '') delete sessionDrafts[sessionId]
    else sessionDrafts[sessionId] = text
    const execution = this.commandExecutions.get(sessionId)
    if (execution?.phase === 'success' || execution?.phase === 'error') {
      this.setCommandExecutionState(sessionId, null)
    }
    this.set({
      sessionDrafts,
      ...(this.snapshot.selectedSessionId === sessionId ? { error: null } : {}),
    })
  }

  setNewSessionDraft(text: string): void {
    if (this.snapshot.newSessionProjectId === null) return
    this.set({ newSessionDraft: text, error: null })
  }

  clearSessionDraft(sessionId: string, submittedText?: string): void {
    const current = this.snapshot.sessionDrafts[sessionId]
    if (current === undefined || (submittedText !== undefined && current !== submittedText)) return
    const sessionDrafts = { ...this.snapshot.sessionDrafts }
    delete sessionDrafts[sessionId]
    this.set({
      sessionDrafts,
      ...(this.snapshot.selectedSessionId === sessionId ? { error: null } : {}),
    })
  }

  private appendSessionAttachments(
    sessionId: string,
    selected: readonly DesktopImageAttachment[],
  ): boolean {
    if (
      selected.length === 0 ||
      !this.snapshot.sessions.some(session => session.sessionId === sessionId)
    ) {
      return false
    }
    const current = this.snapshot.sessionAttachments[sessionId] ?? []
    const combined = [...current, ...selected]
    if (combined.length > DESKTOP_IMAGE_ATTACHMENT_MAX_COUNT) {
      throw new Error(`每条消息最多附加 ${String(DESKTOP_IMAGE_ATTACHMENT_MAX_COUNT)} 张图片`)
    }
    const totalBytes = combined.reduce((total, attachment) => total + attachment.bytes, 0)
    if (totalBytes > DESKTOP_IMAGE_ATTACHMENT_MAX_TOTAL_BYTES) {
      throw new Error(
        `每条消息的图片总大小不能超过 ${String(DESKTOP_IMAGE_ATTACHMENT_MAX_TOTAL_BYTES / (1024 * 1024))} MB`,
      )
    }
    this.set({
      sessionAttachments: {
        ...this.snapshot.sessionAttachments,
        [sessionId]: combined,
      },
    })
    return true
  }

  async chooseSessionAttachments(sessionIdInput?: string): Promise<boolean> {
    const sessionId = sessionIdInput ?? this.snapshot.selectedSessionId
    const api = this.bridge.attachments
    if (sessionId === null || sessionId === undefined || api === undefined) {
      if (sessionId === this.snapshot.selectedSessionId) {
        this.set({ error: '当前桌面桥版本不支持图片附件；请重新启动更新后的 MyDSH' })
      }
      return false
    }
    this.set({ choosingAttachments: true, error: null })
    try {
      const selected = await api.chooseImages()
      return this.appendSessionAttachments(sessionId, selected)
    } catch (error) {
      if (this.snapshot.selectedSessionId === sessionId) this.set({ error: errorMessage(error) })
      return false
    } finally {
      this.set({ choosingAttachments: false })
    }
  }

  async importSessionImages(
    images: readonly DesktopDroppedImage[],
    sessionIdInput?: string,
  ): Promise<boolean> {
    const sessionId = sessionIdInput ?? this.snapshot.selectedSessionId
    const api = this.bridge.attachments
    if (sessionId === null || sessionId === undefined || api?.importImages === undefined) {
      if (sessionId === this.snapshot.selectedSessionId) {
        this.set({ error: '当前桌面桥版本不支持导入图片；请重新启动更新后的 MyDSH' })
      }
      return false
    }
    this.set({ choosingAttachments: true, error: null })
    try {
      const selected = await api.importImages(images)
      return this.appendSessionAttachments(sessionId, selected)
    } catch (error) {
      if (this.snapshot.selectedSessionId === sessionId) this.set({ error: errorMessage(error) })
      return false
    } finally {
      this.set({ choosingAttachments: false })
    }
  }

  /** 普通文件通过 DSH 文件上传服务取得会话专属回执，不转换为项目路径。 */
  async addSessionFiles(sessionId: string, files: readonly File[]): Promise<void> {
    if (!this.snapshot.sessions.some(session => session.sessionId === sessionId))
      throw new Error('会话已关闭，请重新选择')
    const current = this.snapshot.sessionFiles[sessionId] ?? []
    if (
      current.length + files.length + (this.snapshot.sessionAttachments[sessionId]?.length ?? 0) >
      16
    )
      throw new Error('一条消息最多附加 16 个文件或图片')
    // 编码后必须留在既有 64 MiB IPC 消息边界内。
    if (files.some(file => file.size > 47 * 1024 * 1024)) throw new Error('单个文件不能超过 47 MiB')
    const added = files.map(file => {
      const id = crypto.randomUUID()
      this.fileSources.set(id, file)
      return { id, name: file.name || '文件', bytes: file.size, status: 'uploading' as const }
    })
    this.set({
      sessionFiles: { ...this.snapshot.sessionFiles, [sessionId]: [...current, ...added] },
    })
    /* oxlint-disable no-await-in-loop -- 附件顺序传输，避免同时编码多个大文件。 */
    for (const file of added) await this.retrySessionFile(sessionId, file.id)
    /* oxlint-enable no-await-in-loop */
  }

  async retrySessionFile(sessionId: string, id: string): Promise<void> {
    const file = this.fileSources.get(id)
    const generation = this.hostGeneration
    if (!file) return
    const update = (patch: Partial<SessionFileAttachment>) => {
      if (!this.fileSources.has(id)) return
      this.set({
        sessionFiles: {
          ...this.snapshot.sessionFiles,
          [sessionId]: (this.snapshot.sessionFiles[sessionId] ?? []).map(item =>
            item.id === id ? { ...item, ...patch } : item,
          ),
        },
      })
    }
    update({ status: 'uploading' })
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (!this.fileSources.has(id)) return
      let binary = ''
      for (let offset = 0; offset < bytes.length; offset += 32768)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768))
      const value = await this.bridge.remote.call('fileUploads/upload', {
        agentId: sessionId,
        request: { data: btoa(binary), name: file.name },
      })
      if (generation !== this.hostGeneration) throw new Error('运行核心已重连，请重试上传附件')
      if (
        !isRecord(value) ||
        typeof value.receiptId !== 'string' ||
        !isRecord(value.file) ||
        typeof value.file.name !== 'string' ||
        value.file.bytes !== file.size
      )
        throw new Error('运行核心返回了无效的文件回执')
      update({ status: 'ready', receiptId: value.receiptId, name: value.file.name })
    } catch (error) {
      update({ status: 'error', error: errorMessage(error) })
    }
  }

  removeSessionFile(sessionId: string, id: string): void {
    this.fileSources.delete(id)
    this.set({
      sessionFiles: {
        ...this.snapshot.sessionFiles,
        [sessionId]: (this.snapshot.sessionFiles[sessionId] ?? []).filter(file => file.id !== id),
      },
    })
  }

  removeSessionAttachment(sessionId: string, index: number): void {
    const current = this.snapshot.sessionAttachments[sessionId]
    if (current === undefined || index < 0 || index >= current.length) return
    const next = current.filter((_, attachmentIndex) => attachmentIndex !== index)
    const sessionAttachments = { ...this.snapshot.sessionAttachments }
    if (next.length === 0) delete sessionAttachments[sessionId]
    else sessionAttachments[sessionId] = next
    this.set({ sessionAttachments, error: null })
  }

  clearSessionAttachments(
    sessionId: string,
    submittedAttachments?: readonly DesktopImageAttachment[],
  ): void {
    const current = this.snapshot.sessionAttachments[sessionId]
    if (
      current === undefined ||
      (submittedAttachments !== undefined && current !== submittedAttachments)
    )
      return
    const sessionAttachments = { ...this.snapshot.sessionAttachments }
    delete sessionAttachments[sessionId]
    this.set({ sessionAttachments, error: null })
  }

  private async sendPrompt(
    sessionId: string,
    text: string,
    mode: 'queue' | 'steer',
    attachments: readonly DesktopImageAttachment[],
  ): Promise<boolean> {
    const files = this.snapshot.sessionFiles[sessionId] ?? []
    if (files.some(file => file.status !== 'ready' || !file.receiptId)) {
      this.set({ error: '请等待文件上传完成，或重试失败的附件' })
      return false
    }
    if (
      this.promptSubmittingSessionIds.has(sessionId) ||
      this.sessionSnapshot(sessionId).sessionModels?.routable === false
    )
      return false
    const requestGeneration = ++this.nextPromptSubmissionGeneration
    this.promptSubmissionGenerations.set(sessionId, requestGeneration)
    const hostGeneration = this.hostGeneration
    const current = this.sessionSnapshot(sessionId)
    const afterSeq = [...normalizeSessionEvents(current.history), ...current.liveEvents].reduce(
      (latest, event) => Math.max(latest, event.seq),
      -1,
    )
    this.pendingPromptTurns.set(sessionId, { afterSeq, turn: null })
    this.setPromptSubmitting(sessionId, true)
    this.set({
      awaitingResponseSessionIds: this.awaitingResponseIds(sessionId, true),
      ...(this.snapshot.selectedSessionId === sessionId ? { error: null } : {}),
    })
    try {
      await this.bridge.host.call('promptSession', {
        sessionId,
        mode,
        content: [
          ...(text === '' ? [] : [{ type: 'text', text }]),
          ...files.map(file => ({ type: 'file', receiptId: file.receiptId })),
          ...attachments.map(attachment => ({
            type: 'image',
            mediaType: attachment.mediaType,
            data: attachment.base64,
            name: attachment.name,
          })),
        ],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
      const accepted =
        hostGeneration === this.hostGeneration &&
        requestGeneration === this.promptSubmissionGenerations.get(sessionId)
      if (accepted) for (const file of files) this.removeSessionFile(sessionId, file.id)
      return accepted
    } catch (error) {
      if (
        hostGeneration === this.hostGeneration &&
        requestGeneration === this.promptSubmissionGenerations.get(sessionId)
      ) {
        this.pendingPromptTurns.delete(sessionId)
        this.set({
          awaitingResponseSessionIds: this.awaitingResponseIds(sessionId, false),
          ...(this.snapshot.selectedSessionId === sessionId ? { error: errorMessage(error) } : {}),
        })
      }
      return false
    } finally {
      if (requestGeneration === this.promptSubmissionGenerations.get(sessionId)) {
        this.setPromptSubmitting(sessionId, false)
      }
    }
  }

  async executeSessionCommand(lineInput: string, sessionIdInput?: string): Promise<boolean> {
    const line = parseDesktopSlashCommandLine(lineInput)
    const sessionId = sessionIdInput ?? this.snapshot.selectedSessionId
    const name = line === null ? null : (parseDesktopSlashInvocation(line)?.name ?? null)
    const api = this.bridge.commands
    const currentExecution =
      sessionId === null || sessionId === undefined
        ? undefined
        : this.commandExecutions.get(sessionId)
    if (currentExecution?.phase === 'submitting' || currentExecution?.phase === 'running') {
      return false
    }
    if (
      sessionId === null ||
      sessionId === undefined ||
      sessionId !== this.snapshot.selectedSessionId ||
      line === null ||
      name === null ||
      api === undefined
    ) {
      if (sessionId === this.snapshot.selectedSessionId) {
        this.set({
          error:
            api === undefined
              ? '当前桌面桥版本不支持命令；请重新启动更新后的 MyDSH'
              : '请输入有效的斜杠命令',
        })
      }
      return false
    }
    const directory = this.commandDirectories.get(sessionId)
    if (
      directory?.status !== 'ready' ||
      directory.value?.commands.some(command => command.name === name) !== true
    ) {
      if (sessionId === this.snapshot.selectedSessionId) this.set({ error: `未知命令：/${name}` })
      return false
    }

    const requestGeneration = ++this.nextCommandExecutionGeneration
    this.commandExecutionGenerations.set(sessionId, requestGeneration)
    const hostGeneration = this.hostGeneration
    this.setCommandExecutionState(sessionId, {
      phase: 'submitting',
      name,
      submittedDraft: lineInput,
    })
    if (sessionId === this.snapshot.selectedSessionId) this.set({ error: null })
    try {
      const result: DesktopCommandExecutionResult | undefined = await api.execute({
        sessionId,
        line,
      })
      if (
        hostGeneration !== this.hostGeneration ||
        requestGeneration !== this.commandExecutionGenerations.get(sessionId)
      )
        return false
      if (result === undefined) {
        this.setCommandExecutionState(sessionId, {
          phase: 'error',
          name,
          text: '运行核心没有识别这个命令',
        })
        if (sessionId === this.snapshot.selectedSessionId)
          this.set({ error: `运行核心没有识别 /${name}` })
        return false
      }
      const phase = result.result.kind === 'success' ? 'success' : 'error'
      this.setCommandExecutionState(sessionId, {
        phase,
        name,
        commandId: result.commandId,
        ...(result.result.text === undefined ? {} : { text: result.result.text }),
      })
      return phase === 'success'
    } catch (error) {
      if (
        hostGeneration !== this.hostGeneration ||
        requestGeneration !== this.commandExecutionGenerations.get(sessionId)
      )
        return false
      const text = errorMessage(error)
      this.setCommandExecutionState(sessionId, { phase: 'error', name, text })
      if (sessionId === this.snapshot.selectedSessionId) this.set({ error: text })
      return false
    }
  }

  /**
   * 输入区的统一提交入口：普通文本和 Skill 进入 Session prompt，Host Command 单独执行。
   * 斜杠输入必须匹配当前会话的目录；目录缺失或名称有歧义时保留输入并返回失败。
   */
  async submitComposerInput(
    textInput: string,
    mode: 'queue' | 'steer' = 'queue',
    attachmentInput?: readonly DesktopImageAttachment[],
    sessionId = this.snapshot.selectedSessionId,
  ): Promise<boolean> {
    const text = textInput.trim()
    if (sessionId === null) return this.submitNewSessionInput(textInput, mode, attachmentInput)
    const attachments = attachmentInput ?? this.snapshot.sessionAttachments[sessionId] ?? []
    const files = this.snapshot.sessionFiles[sessionId] ?? []
    if (text === '' && attachments.length === 0 && files.length === 0) return false
    if (!textInput.startsWith('/')) return this.sendPrompt(sessionId, text, mode, attachments)

    const invocation = parseDesktopSlashInvocation(textInput)
    if (invocation === null) {
      this.set({ error: '斜杠命令格式无效；请从命令候选中选择后再发送' })
      return false
    }
    const { name } = invocation
    let state = this.commandDirectories.get(sessionId)
    if (state?.status !== 'ready') {
      await this.loadSessionCommandDirectory(sessionId, state?.status === 'error')
      state = this.commandDirectories.get(sessionId)
    }
    if (this.snapshot.selectedSessionId !== sessionId) return false
    if (state?.status !== 'ready' || state.value === null) {
      this.set({ error: state?.error ?? '斜杠命令目录尚未就绪' })
      return false
    }

    const commandMatches = state.value.commands.filter(command => command.name === name)
    const skillMatches = state.value.skills.filter(skill => skill.name === name)
    if (commandMatches.length + skillMatches.length === 0) {
      this.set({ error: `未知斜杠命令或 Skill：/${name}` })
      return false
    }
    if (commandMatches.length + skillMatches.length > 1) {
      this.set({
        error: `/${name} 同时匹配命令和 Skill；请切换 Agent 预设或等待命令列表更新，草稿已保留`,
      })
      return false
    }
    if (commandMatches.length === 1) {
      if (attachments.length > 0 || files.length > 0) {
        this.set({ error: '命令暂不支持附件；请移除附件后再执行，当前附件已保留' })
        return false
      }
      return this.executeSessionCommand(invocation.line, sessionId)
    }
    return this.sendPrompt(sessionId, invocation.line, mode, attachments)
  }

  private async submitNewSessionInput(
    textInput: string,
    mode: 'queue' | 'steer',
    attachmentInput?: readonly DesktopImageAttachment[],
  ): Promise<boolean> {
    const projectId = this.snapshot.newSessionProjectId
    if (
      projectId === null ||
      (this.snapshot.selectedProjectId !== null && projectId !== this.snapshot.selectedProjectId) ||
      this.snapshot.creatingSession ||
      textInput.trim() === ''
    )
      return false
    if ((attachmentInput?.length ?? 0) > 0) {
      this.set({ error: '请先发送第一条文字消息创建会话，再添加图片附件' })
      return false
    }
    const project = this.snapshot.projects.find(item => item.id === projectId)
    if (project?.source !== 'workspace') return false

    this.set({ creatingSession: true, sendingNewSession: true, error: null })
    try {
      const value = await this.bridge.host.call('createSessionForWorkspace', {
        workspaceId: project.workspaceId,
      })
      const sessionId = createdSessionId(value)
      if (sessionId === undefined) throw new Error('运行核心创建新会话后没有返回有效的会话标识')
      await this.refreshSessions()
      if (!this.snapshot.sessions.some(session => session.sessionId === sessionId)) {
        throw new Error('新会话已创建，但尚未出现在会话列表中')
      }
      if (
        (this.snapshot.selectedProjectId !== null &&
          this.snapshot.selectedProjectId !== projectId) ||
        this.snapshot.newSessionProjectId !== projectId
      )
        return false

      this.set({
        sessionDrafts: { ...this.snapshot.sessionDrafts, [sessionId]: textInput },
        newSessionProjectId: null,
        newSessionDraft: '',
      })
      this.selectSession(sessionId)
      const accepted = await this.submitComposerInput(textInput, mode, [])
      if (accepted) this.clearSessionDraft(sessionId, textInput)
      return accepted
    } catch (error) {
      this.set({ error: errorMessage(error) })
      return false
    } finally {
      this.set({ creatingSession: false, sendingNewSession: false })
    }
  }

  async sendMessage(textInput: string, mode: 'queue' | 'steer' = 'queue'): Promise<boolean> {
    return this.submitComposerInput(textInput, mode)
  }

  private readonly cancellingSessions = new Set<string>()

  async cancelSession(sessionId = this.snapshot.selectedSessionId): Promise<void> {
    if (sessionId === null || this.cancellingSessions.has(sessionId)) return
    this.cancellingSessions.add(sessionId)
    try {
      await this.bridge.host.call('cancelSession', { sessionId })
      this.pendingPromptTurns.delete(sessionId)
      this.set({ awaitingResponseSessionIds: this.awaitingResponseIds(sessionId, false) })
    } catch (error) {
      this.set({ error: errorMessage(error) })
    } finally {
      this.cancellingSessions.delete(sessionId)
    }
  }

  private rightLayoutPatch(
    sessionId: string | null,
  ): Pick<WorkspaceSnapshot, 'activeRightIslandId' | 'rightIslandsInitialized'> &
    Partial<Pick<WorkspaceSnapshot, 'planPreview' | 'informationCollapsed'>> {
    const preview = this.snapshot.planPreview
    const planPatch =
      preview === null
        ? {}
        : {
            planPreview: null,
            ...(this.snapshot.activeRightIslandId === 'plan-preview'
              ? { informationCollapsed: preview.previousInformationCollapsed }
              : {}),
          }
    if (sessionId !== null) this.restoreIslandCollaboration(sessionId)
    if (sessionId === null || !this.sessionRightSelections.has(sessionId)) {
      return { ...planPatch, activeRightIslandId: null, rightIslandsInitialized: false }
    }
    return {
      ...planPatch,
      activeRightIslandId: this.sessionRightSelections.get(sessionId) ?? null,
      rightIslandsInitialized: true,
    }
  }

  private readonly openedPlanReviews = new Set<string>()

  /** 审阅只自动展开一次；关闭文档不回答问题，也不改变工作模式。 */
  openPlanPreview(sessionId: string, id: string, text: string, requestKey?: string): void {
    if (sessionId !== this.snapshot.selectedSessionId || !text.trim() || text.length > 256 * 1024)
      return
    if (requestKey !== undefined) {
      const key = `${sessionId}:${requestKey}`
      if (this.openedPlanReviews.has(key)) return
      this.openedPlanReviews.add(key)
      if (this.openedPlanReviews.size > 128)
        this.openedPlanReviews.delete(this.openedPlanReviews.values().next().value!)
    }
    const previous = this.snapshot.planPreview
    const previousRightIslandId =
      this.snapshot.activeRightIslandId === 'plan-preview'
        ? previous?.sessionId === sessionId
          ? previous.previousRightIslandId
          : 'session-info'
        : (this.snapshot.activeRightIslandId ?? 'session-info')
    const previousInformationCollapsed =
      this.snapshot.activeRightIslandId === 'plan-preview' && previous?.sessionId === sessionId
        ? previous.previousInformationCollapsed
        : this.snapshot.informationCollapsed
    // 临时阅读不改写会话的栏目选择和持久折叠偏好。
    this.set({
      planPreview: { sessionId, id, text, previousRightIslandId, previousInformationCollapsed },
      activeRightIslandId: 'plan-preview',
      rightIslandsInitialized: true,
      informationCollapsed: false,
    })
  }

  closePlanPreview(expectedSessionId?: string, expectedDocumentId?: string): void {
    const preview = this.snapshot.planPreview
    if (preview?.sessionId !== this.snapshot.selectedSessionId) return
    if (
      (expectedSessionId !== undefined && preview.sessionId !== expectedSessionId) ||
      (expectedDocumentId !== undefined && preview.id !== expectedDocumentId)
    )
      return
    this.set({
      planPreview: null,
      ...(this.snapshot.activeRightIslandId === 'plan-preview'
        ? {
            activeRightIslandId: preview.previousRightIslandId,
            informationCollapsed: preview.previousInformationCollapsed,
          }
        : {}),
    })
  }

  private rightSelectionRevision(sessionId: string): number {
    return this.sessionRightSelectionRevisions.get(sessionId) ?? 0
  }

  private restoreIslandCollaboration(sessionId: string): void {
    const collaboration = this.sessionIslandCollaborations.get(sessionId)
    if (collaboration === undefined) return
    this.sessionIslandCollaborations.delete(sessionId)
    const current = this.sessionRightSelections.get(sessionId)
    const manuallyChanged =
      this.rightSelectionRevision(sessionId) !== collaboration.rightSelectionRevision
    const restored =
      manuallyChanged && current !== undefined && current !== collaboration.companionIslandId
        ? current
        : collaboration.previousRightIslandId
    this.sessionRightSelections.set(sessionId, restored ?? null)
  }

  /** 异步操作前记录来源会话与右侧手动选择代次，迟到结果只能提交到原现场。 */
  captureIslandCollaborationIntent(): IslandCollaborationIntent | null {
    const sessionId = this.snapshot.selectedSessionId
    return sessionId === null
      ? null
      : {
          sessionId,
          rightSelectionRevision: this.rightSelectionRevision(sessionId),
        }
  }

  /** 插件只指定模式和目标位置；外壳核对贡献、会话代次并负责换位与恢复。 */
  presentIslandCollaboration(
    intent: IslandCollaborationIntent,
    modeId: string,
    target: 'right' | 'main',
  ): boolean {
    if (
      this.snapshot.selectedSessionId !== intent.sessionId ||
      this.rightSelectionRevision(intent.sessionId) !== intent.rightSelectionRevision
    )
      return false
    const targetIslandId = this.modeMainIslandIds.get(modeId)
    if (
      targetIslandId === undefined ||
      !this.islandPlacements.get(targetIslandId)?.includes('main')
    )
      return false
    if (target === 'right' && !this.islandPlacements.get(targetIslandId)?.includes('right'))
      return false
    if (
      target === 'main' &&
      (targetIslandId === this.sessionHomeIslandId ||
        !this.islandPlacements.get(this.sessionHomeIslandId)?.includes('right'))
    )
      return false
    this.closePlanPreview()
    if (this.modeMainIslandIds.get(this.snapshot.activeView) === targetIslandId) return true
    const previousRightIslandId = this.snapshot.activeRightIslandId
    if (target === 'right') {
      this.sessionRightSelections.set(intent.sessionId, targetIslandId)
      this.set({
        activeRightIslandId: targetIslandId,
        rightIslandsInitialized: true,
        informationCollapsed: false,
      })
      persistPanelCollapsed(this.storage, 'information', false)
      return true
    }
    this.sessionRightSelections.set(intent.sessionId, this.sessionHomeIslandId)
    this.sessionIslandCollaborations.set(intent.sessionId, {
      previousRightIslandId,
      rightSelectionRevision: intent.rightSelectionRevision,
      companionIslandId: this.sessionHomeIslandId,
    })
    this.set({
      ...this.viewTransitionPatch(modeId),
      activeRightIslandId: this.sessionHomeIslandId,
      rightIslandsInitialized: true,
      informationCollapsed: false,
    })
    persistPanelCollapsed(this.storage, 'information', false)
    return true
  }

  /** 模式只为尚未建立现场的会话提供一次默认右侧浮岛。 */
  initializeRightIsland(defaultIslandId: string | null): void {
    if (this.snapshot.rightIslandsInitialized) return
    const id = defaultIslandId?.trim() || null
    if (this.snapshot.selectedSessionId !== null) {
      this.sessionRightSelections.set(this.snapshot.selectedSessionId, id)
    }
    this.set({
      activeRightIslandId: id,
      rightIslandsInitialized: true,
    })
  }

  /** 右侧一次只显示一个浮岛；用户选择会直接替换当前内容。 */
  selectRightIsland(islandId: string): void {
    const id = islandId.trim()
    if (id === '' || id.length > 200) return
    if (this.snapshot.selectedSessionId !== null) {
      this.sessionRightSelections.set(this.snapshot.selectedSessionId, id)
      this.sessionRightSelectionRevisions.set(
        this.snapshot.selectedSessionId,
        this.rightSelectionRevision(this.snapshot.selectedSessionId) + 1,
      )
    }
    if (this.temporaryPanelRestore !== null) {
      this.temporaryPanelRestore = { ...this.temporaryPanelRestore, informationCollapsed: false }
    }
    this.set({
      activeRightIslandId: id,
      rightIslandsInitialized: true,
      rightIslandSelectionRequest: {
        islandId: id,
        revision: (this.snapshot.rightIslandSelectionRequest?.revision ?? 0) + 1,
      },
      planPreview: null,
      informationCollapsed: false,
    })
    persistPanelCollapsed(this.storage, 'information', false)
  }

  private supportsNavigationView(view: WorkspaceView): boolean {
    if (this.navigationModeIds !== null) return this.navigationModeIds.has(view)
    return !['trajectory', 'terminal', 'browser', 'plugins'].includes(view)
  }

  /**
   * 切换中央工作区视图；默认不改变左侧导航模式，避免切换顶部标签时劫持侧栏。
   * 仅当显式传入 `syncNavigation: true` 且目标模式支持左侧导航时同步更新 `navigationView`。
   */
  setView(view: WorkspaceView, options?: { readonly syncNavigation?: boolean }): void {
    if (view !== this.sessionHomeModeId) this.closePlanPreview()
    const navigationPatch: Partial<WorkspaceSnapshot> =
      options?.syncNavigation === true && this.supportsNavigationView(view)
        ? { navigationView: view }
        : {}
    const sessionId = this.snapshot.selectedSessionId
    if (sessionId !== null) {
      if (view === this.sessionHomeModeId) {
        this.set({
          openedSessionIds: this.snapshot.openedSessionIds.includes(sessionId)
            ? this.snapshot.openedSessionIds
            : [...this.snapshot.openedSessionIds, sessionId],
          ...this.viewTransitionPatch(view),
          ...navigationPatch,
          ...this.rightLayoutPatch(sessionId),
        })
        return
      }
      this.sessionIslandCollaborations.delete(sessionId)
    }
    this.set({ ...this.viewTransitionPatch(view), ...navigationPatch })
  }

  /** 更新左侧导航视图，供已加载模式变更导致当前导航模式失效时回退。 */
  setNavigationView(view: WorkspaceView): void {
    if (this.snapshot.navigationView === view) return
    this.set({ navigationView: view })
  }

  /**
   * 计算工作模式切换后的布局状态。进入声明了临时收起的模式时保存两侧状态，离开时恢复。
   * 这份临时折叠状态不写入用户布局偏好；本方法只计算状态，不执行界面动效。
   */
  private viewTransitionPatch(view: WorkspaceView): Partial<WorkspaceSnapshot> {
    const transition = transitionWorkspaceView(
      this.snapshot,
      this.temporaryPanelRestore,
      view,
      this.panelCollapseModes.get(view) ?? false,
    )
    this.temporaryPanelRestore = transition.restore
    return transition.patch
  }

  /** 模式声明由插件目录提供；宿主只使用当前存在的模式与展示行为。 */
  configureModes(
    modes: readonly Pick<
      ModeContribution,
      'id' | 'mainIslandId' | 'sessionHome' | 'collapsePanelsOnEnter' | 'left'
    >[],
    islands: readonly Pick<IslandContribution, 'id' | 'placements'>[] = [],
  ): string | null {
    this.panelCollapseModes = new Map(
      modes.map(mode => [mode.id, mode.collapsePanelsOnEnter ?? false]),
    )
    this.navigationModeIds = new Set(
      modes
        .filter(
          mode =>
            mode.left !== undefined &&
            mode.collapsePanelsOnEnter !== true &&
            !['trajectory', 'terminal', 'browser'].includes(mode.id),
        )
        .map(mode => mode.id),
    )
    this.modeMainIslandIds = new Map(modes.map(mode => [mode.id, mode.mainIslandId]))
    this.islandPlacements = new Map(islands.map(island => [island.id, island.placements]))
    const homeMode = modes.find(mode => mode.sessionHome) ?? modes[0]
    if (homeMode !== undefined) {
      this.sessionHomeModeId = homeMode.id
      this.sessionHomeIslandId = homeMode.mainIslandId
    }
    return homeMode?.id ?? null
  }

  openSettings(): void {
    this.set({ settingsOpen: true })
  }

  closeSettings(): void {
    this.set({ settingsOpen: false })
  }

  setBusyEnter(behavior: BusyEnterBehavior): void {
    this.set({ busyEnter: behavior })
  }

  toggleNavigation(): void {
    const navigationCollapsed = !this.snapshot.navigationCollapsed
    this.set({ navigationCollapsed })
    if (
      this.temporaryPanelRestore === null ||
      this.panelCollapseModes.get(this.snapshot.activeView) !== true
    ) {
      if (this.temporaryPanelRestore !== null)
        this.temporaryPanelRestore = { ...this.temporaryPanelRestore, navigationCollapsed }
      persistPanelCollapsed(this.storage, 'navigation', navigationCollapsed)
    }
  }

  toggleInformation(): void {
    const informationCollapsed = !this.snapshot.informationCollapsed
    this.set({ informationCollapsed })
    if (this.temporaryPanelRestore !== null) {
      this.temporaryPanelRestore = { ...this.temporaryPanelRestore, informationCollapsed }
    }
    persistPanelCollapsed(this.storage, 'information', informationCollapsed)
  }

  resizeNavigation(width: number): void {
    const navigationWidth = clampPanelWidth('navigation', width)
    this.set({ navigationWidth, navigationCollapsed: false })
    persistPanelWidth(this.storage, 'navigation', navigationWidth)
    if (
      this.temporaryPanelRestore === null ||
      this.panelCollapseModes.get(this.snapshot.activeView) !== true
    ) {
      if (this.temporaryPanelRestore !== null)
        this.temporaryPanelRestore = { ...this.temporaryPanelRestore, navigationCollapsed: false }
      persistPanelCollapsed(this.storage, 'navigation', false)
    }
  }

  resizeInformation(width: number): void {
    const informationWidth = clampPanelWidth('information', width)
    this.set({ informationWidth, informationCollapsed: false })
    persistPanelWidth(this.storage, 'information', informationWidth)
    if (this.temporaryPanelRestore !== null) {
      this.temporaryPanelRestore = { ...this.temporaryPanelRestore, informationCollapsed: false }
    }
    persistPanelCollapsed(this.storage, 'information', false)
  }

  resizeComposer(height: number): void {
    const composerHeight = clampComposerHeight(height)
    this.set({ composerHeight })
    persistComposerHeight(this.storage, composerHeight)
  }

  resetComposerHeight(): void {
    this.resizeComposer(COMPOSER_HEIGHT_RANGE.defaultValue)
  }

  setConversationWidth(width: number | null): void {
    const conversationWidth = clampConversationWidth(width)
    this.set({ conversationWidth })
    persistConversationWidth(this.storage, conversationWidth)
  }

  setPanelCapsulesPersistent(persistent: boolean): void {
    this.set({ panelCapsulesPersistent: persistent })
    persistPanelCapsulesPersistent(this.storage, persistent)
  }

  resetPanelWidth(panel: PanelName): void {
    const width = defaultPanelWidth(panel)
    if (panel === 'navigation') {
      this.set({ navigationWidth: width })
    } else {
      this.set({ informationWidth: width })
    }
    persistPanelWidth(this.storage, panel, width)
  }

  async exportSelectedSessionLog(
    sessionId = this.snapshot.selectedSessionId,
  ): Promise<DesktopSessionLogExportResult> {
    if (sessionId === null) throw new Error('请先选择要导出的会话')
    if (this.bridge.sessionExports === undefined) {
      throw new Error('当前桌面桥不支持会话日志导出')
    }
    return parseSessionLogExportResult(await this.bridge.sessionExports.save(sessionId))
  }

  async updateSettings(patch: Parameters<DesktopBridge['settings']['update']>[0]): Promise<void> {
    try {
      this.set({ settings: await this.bridge.settings.update(patch), error: null })
    } catch (error) {
      this.set({ error: errorMessage(error) })
    }
  }

  async chooseBackground(layer: BackgroundLayer, targetAspectRatio: number): Promise<void> {
    try {
      const selection = await this.bridge.settings.chooseBackground({ layer, targetAspectRatio })
      if (selection === null) return
      const sourceAspectRatio = selection.sourceWidth / selection.sourceHeight
      let crop = { x: 0, y: 0, width: 1, height: 1 }
      if (sourceAspectRatio > selection.targetAspectRatio) {
        const width = selection.targetAspectRatio / sourceAspectRatio
        crop = { x: (1 - width) / 2, y: 0, width, height: 1 }
      } else if (sourceAspectRatio < selection.targetAspectRatio) {
        const height = sourceAspectRatio / selection.targetAspectRatio
        crop = { x: 0, y: (1 - height) / 2, width: 1, height }
      }
      this.set({
        settings: await this.bridge.settings.applyBackground({
          selectionId: selection.id,
          crop,
        }),
        error: null,
      })
    } catch (error) {
      this.set({ error: errorMessage(error) })
    }
  }

  async clearBackground(layer: BackgroundLayer): Promise<void> {
    try {
      this.set({ settings: await this.bridge.settings.clearBackground(layer), error: null })
    } catch (error) {
      this.set({ error: errorMessage(error) })
    }
  }

  async callHost(operation: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    return this.bridge.host.call(operation, payload)
  }

  async listMessageFeedback(sessionId: string): Promise<DesktopMessageFeedbackList> {
    return parseDesktopMessageFeedbackList(
      await this.bridge.host.call('listMessageFeedback', { sessionId }),
    )
  }

  async putMessageFeedback(
    sessionId: string,
    messageId: string,
    rating: DesktopMessageFeedbackRating,
    ifVersion: string | null,
  ): Promise<DesktopMessageFeedbackMutationResult> {
    return parseDesktopMessageFeedbackMutationResult(
      await this.bridge.host.call('putMessageFeedback', {
        sessionId,
        messageId,
        rating,
        ifVersion,
      }),
    )
  }

  async deleteMessageFeedback(
    sessionId: string,
    messageId: string,
    ifVersion: string,
  ): Promise<DesktopMessageFeedbackMutationResult> {
    return parseDesktopMessageFeedbackMutationResult(
      await this.bridge.host.call('deleteMessageFeedback', {
        sessionId,
        messageId,
        ifVersion,
      }),
    )
  }

  async listFileReferences(
    sessionId: string,
    query: string,
  ): Promise<readonly DesktopFileReferenceCandidate[]> {
    return parseDesktopFileReferenceCandidates(
      await this.bridge.host.call('listFileReferences', { sessionId, query }),
    )
  }

  async resolveDroppedProjectFiles(
    files: readonly File[],
    sessionId = this.snapshot.selectedSessionId,
  ): Promise<readonly DesktopFileReferenceCandidate[]> {
    const session = this.snapshot.sessions.find(item => item.sessionId === sessionId)
    const project =
      this.snapshot.projects.find(
        item => sessionsForProject(session ? [session] : [], item).length > 0,
      ) ?? this.selectedProject()
    const api = this.bridge.attachments
    if (api?.resolveDroppedFiles === undefined) {
      throw new Error('当前桌面桥版本不支持拖入项目文件；请重新启动更新后的 MyDSH')
    }
    if (project?.projectAccessId === undefined) {
      throw new Error('当前会话没有可验证的项目目录，无法创建文件引用')
    }
    return parseDesktopFileReferenceCandidates(
      await api.resolveDroppedFiles(project.projectAccessId, files),
    )
  }

  clearError(expected?: string | null): void {
    if (expected !== undefined && expected !== this.snapshot.error) return
    this.set({ error: null })
  }

  /** 使用主进程返回的项目访问 ID 发起操作；真实目录与路径边界仍由主进程复核。 */
  async callProject(
    operation: DesktopProjectOperation,
    payload: Record<string, unknown> = {},
  ): Promise<unknown> {
    const project = this.selectedProject()
    if (this.bridge.projects === undefined) throw new Error('当前桌面桥不支持项目能力')
    if (project === undefined || project.cwd === undefined)
      throw new Error('请先选择一个有工作目录的项目')
    if (project.projectAccessId === undefined)
      throw new Error('当前项目尚未进入受信任的项目访问范围')
    return this.bridge.projects.call(operation, { ...payload, projectId: project.projectAccessId })
  }

  async revealProject(projectId: string): Promise<boolean> {
    const project = this.snapshot.projects.find(item => item.id === projectId)
    if (this.bridge.projects === undefined || project?.projectAccessId === undefined) return false
    try {
      await this.bridge.projects.call('revealInFinder', { projectId: project.projectAccessId })
      return true
    } catch (error) {
      this.set({ error: errorMessage(error) })
      return false
    }
  }

  selectedProject(): ProjectSummary | undefined {
    const focusedProject = this.focusedProject()
    if (this.snapshot.selectedProjectId !== null) return focusedProject
    const session = this.selectedSession()
    if (session === undefined) {
      return this.snapshot.newSessionProjectId === null
        ? undefined
        : this.snapshot.projects.find(project => project.id === this.snapshot.newSessionProjectId)
    }
    return session.cwd === undefined
      ? undefined
      : this.snapshot.projects.find(project => project.cwd === session.cwd)
  }

  focusedProject(): ProjectSummary | undefined {
    return this.snapshot.selectedProjectId === null
      ? undefined
      : this.snapshot.projects.find(item => item.id === this.snapshot.selectedProjectId)
  }

  selectedSession(): SessionSummary | undefined {
    return this.snapshot.sessions.find(item => item.sessionId === this.snapshot.selectedSessionId)
  }

  focusedSessions(): SessionSummary[] {
    const project = this.focusedProject()
    return project === undefined
      ? [...this.snapshot.sessions]
      : sessionsForProject(this.snapshot.sessions, project)
  }
}
