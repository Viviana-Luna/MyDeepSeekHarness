/**
 * 本地工作台分套件验收的共享状态容器、前置自举辅助与套件级不变量断言。
 */
import { PRODUCT_NAME } from '../../../shared/product.ts'
import { parseDesktopWorkspaceCreateResult } from '../../../shared/workspace-capabilities.ts'
import { callDshHost } from '../../host/host-client.ts'
import { TRAFFIC_LIGHT_CENTER_Y } from '../../window-controls.ts'
import {
  ensureFrontendPluginFixture,
  type HostVerificationBridge,
  type LocalSuiteName,
} from '../host-verify-context.ts'
import { buildInitialWorkbenchProbe } from './smoke-probes.ts'

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
export async function ensureInitialShellSampled(state: LocalVerifyState): Promise<void> {
  if (state.initial !== undefined) return
  state.initial = await state.bridge.win.webContents.executeJavaScript(
    buildInitialWorkbenchProbe(TRAFFIC_LIGHT_CENTER_Y),
  )
  if (!state.initial || state.initial.verifyError !== undefined) {
    throw new Error(`采集工作台初始几何基线失败：${String(state.initial?.verifyError ?? 'null')}`)
  }
}

/** 当跳过 models 单独执行 settings 套件时，按需创建用于归档恢复校验的隔离会话。 */
export async function ensureArchivePrerequisiteSession(state: LocalVerifyState): Promise<void> {
  if (typeof state.interactionSessionId === 'string' && state.interactionSessionId !== '') return
  const host = state.bridge.getCurrentHost()
  if (host === undefined) throw new Error('准备归档验收会话时运行核心尚未就绪')
  const createdWorkspace = parseDesktopWorkspaceCreateResult(
    await callDshHost(
      state.bridge.targetUrl,
      'createWorkspace',
      { path: state.bridge.verifyProject },
      state.bridge.fetch,
      host.sessionCookie,
    ),
  )
  const createdSession = (await callDshHost(
    state.bridge.targetUrl,
    'createSessionForWorkspace',
    { workspaceId: createdWorkspace.workspace.workspaceId },
    state.bridge.fetch,
    host.sessionCookie,
  )) as { sessionId?: string }
  if (typeof createdSession?.sessionId !== 'string' || createdSession.sessionId === '') {
    throw new Error('无法创建归档验收所需的隔离工作区会话')
  }
  state.interactionSessionId = createdSession.sessionId
}

const SUITE_CHECKERS: Record<LocalSuiteName, (state: LocalVerifyState) => Record<string, boolean>> =
  {
    smoke: state => ({
      windowControlsReady: Boolean(state.windowControlsReady),
      titleMatches: state.initial?.title === PRODUCT_NAME,
      rendererMounted: Boolean(state.initial?.renderer),
      islandCountThree: state.initial?.islandCount === 3,
      pageNotScrollable: state.initial?.pageScrollable === false,
      islandsOpaque: Boolean(state.initial?.islandsOpaque),
      densityReady: Boolean(state.initial?.densityReady),
      titlebarClearanceReady: Boolean(state.initial?.titlebarClearanceReady),
      topToolbarReady: Boolean(state.initial?.topToolbarReady),
      toolbarLayoutIndependent: Boolean(state.initial?.toolbarLayoutIndependent),
      workspaceHeaderRemoved: Boolean(state.initial?.workspaceHeaderRemoved),
      panelCapsulesReady: Boolean(state.initial?.panelCapsulesReady),
      sessionCostRemoved: Boolean(state.initial?.sessionCostRemoved),
      trajectoryVisible: Boolean(state.initial?.trajectoryVisible),
      trajectoryFocusReady: Boolean(state.initial?.trajectoryFocusReady),
      composerCapped: Boolean(state.initial?.composerCapped),
    }),
    conversation: state => ({
      presentationSessionPresent:
        typeof state.presentationSession === 'string' && state.presentationSession.length > 0,
      processReady: Boolean(state.processReady),
    }),
    composer: state => ({
      commandPaletteReady: Boolean(state.commandPaletteAudit?.ready),
      commandPaletteClosedAfterClear: state.commandPaletteAudit?.closedAfterClear === true,
      bridgeVersion23: state.commandPaletteAudit?.bridgeVersion === 23,
      fileReferenceReady: Boolean(state.fileReferenceAudit?.ready),
      fileReferenceClosedAfterClear: state.fileReferenceAudit?.closedAfterClear === true,
      attachmentDropReady: Boolean(state.attachmentDropAudit?.ready),
      commandExecutionReady: Boolean(state.commandExecutionAudit?.ready),
      draftCleared: state.commandExecutionAudit?.draftCleared === true,
      paletteClosed: state.commandExecutionAudit?.paletteClosed === true,
      commandLifecycleReady: Boolean(state.commandLifecycleReady),
      fontScaleReady: Boolean(state.fontScaleReady),
      accentContrastReady: Boolean(state.accentContrastReady),
    }),
    sessions: state => ({
      projectGroupingReady: Boolean(state.projectGroupingReady),
      sessionActionsReady: Boolean(state.sessionActionsReady),
      sessionSearchReady: Boolean(state.sessionSearchReady),
      sessionTabsReady: Boolean(state.sessionTabsReady),
    }),
    panels: state => ({
      panelCollapseReady: Boolean(state.panelCollapseReady),
      panelResizeReady: Boolean(state.panelResizeReady),
      panelDragLineReady: Boolean(state.panelDragLineReady),
      composerVisibilityReady: Boolean(state.composerVisibilityReady),
    }),
    'files-scm': state => ({
      fileTreeReady: Boolean(state.fileView?.fileTreeReady),
      deepFileTreeReady: Boolean(state.fileView?.deepFileTreeReady),
      fileViewerReady: Boolean(state.fileView?.fileViewerReady),
      fileTabsReady: Boolean(state.fileView?.fileTabsReady),
      fileWorkspacePersisted: Boolean(state.fileView?.fileWorkspacePersisted),
      imageViewerReady: Boolean(state.fileView?.imageViewerReady),
      syntaxHighlightingReady: Boolean(state.fileView?.syntaxHighlightingReady),
      fileCursorReady: Boolean(state.fileView?.fileCursorReady),
      quickOpenReady: Boolean(state.fileView?.quickOpenReady),
      fileEditorReady: Boolean(state.fileEditorReady),
      hostRecoveryRetainsEditor: Boolean(state.hostRecoveryRetainsEditor),
      fileUnsavedGuardReady: Boolean(state.fileUnsavedGuardReady),
      contentSearchReady: Boolean(state.contentSearchReady),
      projectTasksOnlyReady: Boolean(state.projectTasksOnlyReady),
      projectTasksReady: Boolean(state.projectTasksReady),
      taskSuggestionsRemoved: Boolean(state.taskSuggestionsRemoved),
      sourceControlReady: Boolean(state.sourceControlView?.sourceControlReady),
      uncommittedChangesReady: Boolean(state.sourceControlView?.uncommittedChangesReady),
      contextualRightPanelReady: Boolean(state.sourceControlView?.contextualRightPanelReady),
      diffResponsiveReady: Boolean(state.sourceControlView?.diffResponsiveReady),
      sourceControlWriteReady: Boolean(state.sourceControlWriteReady),
      sourceControlFailureReady: Boolean(state.sourceControlFailureReady),
      changeFileListReadable: Boolean(state.changeFileListReadable),
      terminalReady: Boolean(state.terminalReady),
    }),
    models: state => ({
      modelMenuReady: Boolean(state.modelMenuReady),
      sessionInfoReady: Boolean(state.sessionInfoReady),
      pendingInteractionsReady: Boolean(state.pendingInteractionsReady),
    }),
    settings: state => ({
      editorAppearanceReady: Boolean(state.editorAppearanceReady),
      settingsDialog: Boolean(state.settingsDialog),
      settingsFocusInside: Boolean(state.settingsAudit?.focusInside),
      settingsFocusRestored: Boolean(state.settingsFocusRestored),
      settingsPanelFits: Boolean(state.settingsAudit?.panelFits),
      settingsLayerCountZero: state.settingsAudit?.layerCount === 0,
      settingsNavCountSix: state.settingsAudit?.navCount === 6,
      settingsAppearanceIndexOne: state.settingsAudit?.appearanceIndex === 1,
      settingsModal: Boolean(state.settingsAudit?.modal),
      darkSettingsReadable: Boolean(state.darkSettingsReadable),
      allSettingsPagesReady: Boolean(state.allSettingsPagesReady),
      hostSettingsEventsReady: Boolean(state.hostSettingsEventsReady),
      canvasColorSchemeReady: Boolean(state.canvasColorSchemeReady),
      islandGapSettingReady: Boolean(state.islandGapSettingReady),
      reducedTransparencyReady: Boolean(state.reducedTransparencyReady),
      forcedColorsReady: Boolean(state.forcedColorsReady),
      nativeWindowClipReady: Boolean(state.nativeWindowClipReady),
      mediumCanvasReady: Boolean(state.mediumCanvasReady),
      clearCanvasReady: Boolean(state.clearCanvasReady),
      largeLayoutStable: Boolean(state.largeLayoutStable),
      shellPinnedToViewport: Boolean(state.shellPinnedToViewport),
      mediumToolbarStable: Boolean(state.mediumToolbarStable),
      narrowSettingsFits: Boolean(state.narrowSettingsFits),
      narrowRightPanelHidden: Boolean(state.narrowRightPanelHidden),
      rightTabsReady: Boolean(state.rightTabsReady),
    }),
  }

/** 立即校验指定套件的不变量断言，发现未通过指标时直接抛出明确错误。 */
export function assertSuiteInvariants(suite: LocalSuiteName, state: LocalVerifyState): void {
  const checks = SUITE_CHECKERS[suite](state)
  const failed = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([key]) => key)
  if (failed.length > 0) {
    throw new Error(`验收套件 [${suite}] 断言未通过：${failed.join(', ')}`)
  }
}
