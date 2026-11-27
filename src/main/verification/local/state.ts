/**
 * 本地工作台分套件验收的共享状态容器、前置自举辅助与套件级不变量断言。
 */
import { callDshHost } from '../../host/host-client.ts'
import { PRODUCT_NAME } from '../../../shared/product.ts'
import { parseDesktopWorkspaceCreateResult } from '../../../shared/workspace-capabilities.ts'
import { TRAFFIC_LIGHT_CENTER_Y } from '../../window-controls.ts'
import {
  ensureFrontendPluginFixture,
  type HostVerificationBridge,
  type LocalSuiteName,
} from '../host-verify-context.ts'
import { buildSmokeScript3 } from './smoke-scripts.ts'

/** 面板几何采样快照结构。 */
export interface PanelGeometrySample {
  navigationWidth: number
  informationWidth: number
  composerHeight: number
  [key: string]: any
}

/** 画布材质采样快照结构。 */
export interface MaterialAuditSample {
  backdrop: string
  canvasImage: string
  canvasAlpha: string
  scrimAlpha: string
  contentBackground: string
  topControlsReadable: boolean
  viewport: { width: number; height: number }
  opaquePoints: Array<{ x: number; y: number }>
  edgePoints: Array<{ x: number; y: number }>
  centerGapPoint: { x: number; y: number } | null
  [key: string]: any
}

/** 跨验收阶段共享的状态字典，支持全量汇聚及单套件独立执行。 */
export interface LocalVerifyState {
  readonly bridge: HostVerificationBridge
  readPanelGeometry: () => Promise<PanelGeometrySample | null>
  waitForPanelGeometry: (
    predicate: (geometry: PanelGeometrySample) => boolean,
  ) => Promise<PanelGeometrySample | null>
  material: MaterialAuditSample | null
  sampleMaterialAlpha: (point: { x: number; y: number }) => number
  [key: string]: any
}

/** 创建带安全默认初值的本地验收状态对象。 */
export function createLocalVerifyState(bridge: HostVerificationBridge): LocalVerifyState {
  return {
    bridge,
    extensionSource: ensureFrontendPluginFixture(bridge.verifyHome),
    presentationScheme: 'system',
    interactionSessionId: '',
    originalSessionTab: null,
    otherSessionTab: null,
    sessionTabsReady: false,
    windowControlsReady: true,
    initial: undefined,
    readPanelGeometry: () => Promise.resolve(null),
    waitForPanelGeometry: () => Promise.resolve(null),
    material: null,
    sampleMaterialAlpha: () => 255,
    fileView: {},
    sourceControlView: {},
    projectViews: {},
  }
}

/** 当跳过 smoke 单独执行后续套件时，按需采集一次初始浮岛与侧栏几何基线。 */
export async function ensureInitialShellSampled(bag: LocalVerifyState): Promise<void> {
  if (bag.initial !== undefined) return
  bag.initial = await bag.bridge.win.webContents.executeJavaScript(
    buildSmokeScript3(TRAFFIC_LIGHT_CENTER_Y, TRAFFIC_LIGHT_CENTER_Y),
  )
  if (!bag.initial || bag.initial.verifyError !== undefined) {
    throw new Error(`采集工作台初始几何基线失败：${String(bag.initial?.verifyError ?? 'null')}`)
  }
}

/** 当跳过 models 单独执行 settings 套件时，按需创建用于归档恢复校验的隔离会话。 */
export async function ensureArchivePrerequisiteSession(bag: LocalVerifyState): Promise<void> {
  if (typeof bag.interactionSessionId === 'string' && bag.interactionSessionId !== '') return
  const host = bag.bridge.getCurrentHost()
  if (host === undefined) throw new Error('准备归档验收会话时运行核心尚未就绪')
  const createdWorkspace = parseDesktopWorkspaceCreateResult(
    await callDshHost(
      bag.bridge.targetUrl,
      'createWorkspace',
      { path: bag.bridge.verifyProject },
      bag.bridge.fetch,
      host.sessionCookie,
    ),
  )
  const createdSession = (await callDshHost(
    bag.bridge.targetUrl,
    'createSessionForWorkspace',
    { workspaceId: createdWorkspace.workspace.workspaceId },
    bag.bridge.fetch,
    host.sessionCookie,
  )) as { sessionId?: string }
  if (typeof createdSession?.sessionId !== 'string' || createdSession.sessionId === '') {
    throw new Error('无法创建归档验收所需的隔离工作区会话')
  }
  bag.interactionSessionId = createdSession.sessionId
}

const SUITE_CHECKERS: Record<LocalSuiteName, (bag: LocalVerifyState) => Record<string, boolean>> = {
  smoke: bag => ({
    windowControlsReady: Boolean(bag.windowControlsReady),
    titleMatches: bag.initial?.title === PRODUCT_NAME,
    rendererMounted: Boolean(bag.initial?.renderer),
    islandCountThree: bag.initial?.islandCount === 3,
    pageNotScrollable: bag.initial?.pageScrollable === false,
    islandsOpaque: Boolean(bag.initial?.islandsOpaque),
    densityReady: Boolean(bag.initial?.densityReady),
    titlebarClearanceReady: Boolean(bag.initial?.titlebarClearanceReady),
    topToolbarReady: Boolean(bag.initial?.topToolbarReady),
    toolbarLayoutIndependent: Boolean(bag.initial?.toolbarLayoutIndependent),
    workspaceHeaderRemoved: Boolean(bag.initial?.workspaceHeaderRemoved),
    panelCapsulesReady: Boolean(bag.initial?.panelCapsulesReady),
    sessionCostRemoved: Boolean(bag.initial?.sessionCostRemoved),
    trajectoryVisible: Boolean(bag.initial?.trajectoryVisible),
    trajectoryFocusReady: Boolean(bag.initial?.trajectoryFocusReady),
    composerCapped: Boolean(bag.initial?.composerCapped),
  }),
  conversation: bag => ({
    presentationSessionPresent:
      typeof bag.presentationSession === 'string' && bag.presentationSession.length > 0,
    processReady: Boolean(bag.processReady),
  }),
  composer: bag => ({
    commandPaletteReady: Boolean(bag.commandPaletteAudit?.ready),
    commandPaletteClosedAfterClear: bag.commandPaletteAudit?.closedAfterClear === true,
    bridgeVersion23: bag.commandPaletteAudit?.bridgeVersion === 23,
    fileReferenceReady: Boolean(bag.fileReferenceAudit?.ready),
    fileReferenceClosedAfterClear: bag.fileReferenceAudit?.closedAfterClear === true,
    attachmentDropReady: Boolean(bag.attachmentDropAudit?.ready),
    commandExecutionReady: Boolean(bag.commandExecutionAudit?.ready),
    draftCleared: bag.commandExecutionAudit?.draftCleared === true,
    paletteClosed: bag.commandExecutionAudit?.paletteClosed === true,
    commandLifecycleReady: Boolean(bag.commandLifecycleReady),
    fontScaleReady: Boolean(bag.fontScaleReady),
    accentContrastReady: Boolean(bag.accentContrastReady),
  }),
  sessions: bag => ({
    projectGroupingReady: Boolean(bag.projectGroupingReady),
    sessionActionsReady: Boolean(bag.sessionActionsReady),
    sessionSearchReady: Boolean(bag.sessionSearchReady),
    sessionTabsReady: Boolean(bag.sessionTabsReady),
  }),
  panels: bag => ({
    panelCollapseReady: Boolean(bag.panelCollapseReady),
    panelResizeReady: Boolean(bag.panelResizeReady),
    panelDragLineReady: Boolean(bag.panelDragLineReady),
    composerVisibilityReady: Boolean(bag.composerVisibilityReady),
  }),
  'files-scm': bag => ({
    fileTreeReady: Boolean(bag.fileView?.fileTreeReady),
    deepFileTreeReady: Boolean(bag.fileView?.deepFileTreeReady),
    fileViewerReady: Boolean(bag.fileView?.fileViewerReady),
    fileTabsReady: Boolean(bag.fileView?.fileTabsReady),
    fileWorkspacePersisted: Boolean(bag.fileView?.fileWorkspacePersisted),
    imageViewerReady: Boolean(bag.fileView?.imageViewerReady),
    syntaxHighlightingReady: Boolean(bag.fileView?.syntaxHighlightingReady),
    fileCursorReady: Boolean(bag.fileView?.fileCursorReady),
    quickOpenReady: Boolean(bag.fileView?.quickOpenReady),
    fileEditorReady: Boolean(bag.fileEditorReady),
    hostRecoveryRetainsEditor: Boolean(bag.hostRecoveryRetainsEditor),
    fileUnsavedGuardReady: Boolean(bag.fileUnsavedGuardReady),
    contentSearchReady: Boolean(bag.contentSearchReady),
    projectTasksOnlyReady: Boolean(bag.projectTasksOnlyReady),
    projectTasksReady: Boolean(bag.projectTasksReady),
    taskSuggestionsRemoved: Boolean(bag.taskSuggestionsRemoved),
    sourceControlReady: Boolean(bag.sourceControlView?.sourceControlReady),
    uncommittedChangesReady: Boolean(bag.sourceControlView?.uncommittedChangesReady),
    contextualRightPanelReady: Boolean(bag.sourceControlView?.contextualRightPanelReady),
    diffResponsiveReady: Boolean(bag.sourceControlView?.diffResponsiveReady),
    sourceControlWriteReady: Boolean(bag.sourceControlWriteReady),
    sourceControlFailureReady: Boolean(bag.sourceControlFailureReady),
    changeFileListReadable: Boolean(bag.changeFileListReadable),
    terminalReady: Boolean(bag.terminalReady),
  }),
  models: bag => ({
    modelMenuReady: Boolean(bag.modelMenuReady),
    sessionInfoReady: Boolean(bag.sessionInfoReady),
    pendingInteractionsReady: Boolean(bag.pendingInteractionsReady),
  }),
  settings: bag => ({
    editorAppearanceReady: Boolean(bag.editorAppearanceReady),
    settingsDialog: Boolean(bag.settingsDialog),
    settingsFocusInside: Boolean(bag.settingsAudit?.focusInside),
    settingsFocusRestored: Boolean(bag.settingsFocusRestored),
    settingsPanelFits: Boolean(bag.settingsAudit?.panelFits),
    settingsLayerCountZero: bag.settingsAudit?.layerCount === 0,
    settingsNavCountSix: bag.settingsAudit?.navCount === 6,
    settingsAppearanceIndexOne: bag.settingsAudit?.appearanceIndex === 1,
    settingsModal: Boolean(bag.settingsAudit?.modal),
    darkSettingsReadable: Boolean(bag.darkSettingsReadable),
    allSettingsPagesReady: Boolean(bag.allSettingsPagesReady),
    hostSettingsEventsReady: Boolean(bag.hostSettingsEventsReady),
    canvasColorSchemeReady: Boolean(bag.canvasColorSchemeReady),
    islandGapSettingReady: Boolean(bag.islandGapSettingReady),
    reducedTransparencyReady: Boolean(bag.reducedTransparencyReady),
    forcedColorsReady: Boolean(bag.forcedColorsReady),
    nativeWindowClipReady: Boolean(bag.nativeWindowClipReady),
    mediumCanvasReady: Boolean(bag.mediumCanvasReady),
    clearCanvasReady: Boolean(bag.clearCanvasReady),
    largeLayoutStable: Boolean(bag.largeLayoutStable),
    shellPinnedToViewport: Boolean(bag.shellPinnedToViewport),
    mediumToolbarStable: Boolean(bag.mediumToolbarStable),
    narrowSettingsFits: Boolean(bag.narrowSettingsFits),
    narrowRightPanelHidden: Boolean(bag.narrowRightPanelHidden),
    rightTabsReady: Boolean(bag.rightTabsReady),
  }),
}

/** 立即校验指定套件的不变量断言，发现未通过指标时直接抛出明确错误。 */
export function assertSuiteInvariants(suite: LocalSuiteName, bag: LocalVerifyState): void {
  const checks = SUITE_CHECKERS[suite](bag)
  const failed = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([key]) => key)
  if (failed.length > 0) {
    throw new Error(`验收套件 [${suite}] 断言未通过：${failed.join(', ')}`)
  }
}
