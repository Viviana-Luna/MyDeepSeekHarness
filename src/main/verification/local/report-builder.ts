/**
 * 组装全量与按套件子集执行的最终桌面验收报告（VerifyReport）。
 */
import { app } from 'electron'
import { PRODUCT_NAME } from '../../../shared/product.ts'
import { createFailedVerifyReport, type VerifyReport } from '../desktop-verifier.ts'
import type { LocalSuiteName } from '../host-verify-context.ts'
import type { LocalVerifyState } from './state.ts'

function assertBackgroundWindowHidden(state: LocalVerifyState): void {
  const { win, verifyBackground } = state.bridge
  if (verifyBackground && (win.isVisible() || win.isFocused())) {
    throw new Error('后台验收意外显示了窗口或占用了系统焦点')
  }
}

/** 为按子集快速运行的验收套件生成通过报告。 */
export function buildSubsetVerificationReport(
  state: LocalVerifyState,
  suites: readonly LocalSuiteName[],
): { report: VerifyReport; ok: boolean } {
  state.bridge.setStage('complete')
  assertBackgroundWindowHidden(state)
  const report = createFailedVerifyReport('complete', new Error(''), true)
  delete report.error
  Object.assign(report, {
    backgroundVerification: state.bridge.verifyBackground,
    startupScreen: state.bridge.isStartupScreenVerified(),
    appMounted: true,
    uiActive: true,
    frame: true,
    blank: false,
    suites,
    productName: app.getName(),
    productVersion: app.getVersion(),
    singleInstanceLock: app.hasSingleInstanceLock(),
    ownership: state.bridge.getCurrentHost()?.ownership,
    reportedVersion: state.bridge.getCurrentHost()?.identity.reportedVersion,
  })
  return { report, ok: true }
}

function assignShellAndSettingsFields(report: VerifyReport, state: LocalVerifyState): void {
  const { bridge } = state
  Object.assign(report, {
    backgroundVerification: bridge.verifyBackground,
    nativeFullscreenChecked: process.platform === 'darwin' && !bridge.verifyBackground,
    startupScreen: bridge.isStartupScreenVerified(),
    startupCapture: 'verify-startup.png',
    startupDarkCapture: 'verify-startup-dark.png',
    appMounted: state.initial.renderer,
    sessionInfoReady: state.sessionInfoReady,
    hostSettingsEventsReady: state.hostSettingsEventsReady,
    uiActive: true,
    frame: true,
    islandCount: state.initial.islandCount,
    canvasCount: 1,
    pageScrollable: state.initial.pageScrollable,
    shellPinnedToViewport: state.shellPinnedToViewport,
    transparentRoots: state.clearCanvas?.transparentRoots ?? false,
    settingsDialog: state.settingsDialog,
    settingsFocusInside: state.settingsAudit.focusInside && state.settingsFocusRestored,
    settingsLayerCount: state.settingsAudit.layerCount,
    settingsAccent: bridge.settingsStore.read().accentColor,
    settingsCanvasOpacity: state.material?.canvasAlpha ?? '',
    settingsCanvasAlpha: Number(state.material?.canvasAlpha ?? 0),
    settingsCanvasImageApplied: state.material?.canvasImage === 'none',
    canvasColorSchemeReady: state.canvasColorSchemeReady,
    mediumCanvasReady: state.mediumCanvasReady,
    topControlsReadable: state.material?.topControlsReadable ?? false,
    clearCanvasReady: state.clearCanvasReady,
    settingsPanelFits: state.settingsAudit.panelFits,
    settingsPagesReady: state.allSettingsPagesReady,
    islandGapSettingReady: state.islandGapSettingReady,
    appearanceCapture: state.appearanceCapture,
    appearanceBackgroundsCapture: state.appearanceBackgroundsCapture,
    modelsCapture: state.modelsCapture,
    modelMenuCapture: state.modelMenuCapture,
    modelMenuReady: state.modelMenuReady,
    pluginsCapture: state.pluginsCapture,
    automationCapture: state.automationCapture,
    automationSettingsReady: state.automationSettingsReady,
    presetsCapture: state.presetsCapture,
    frameOpacity: state.clearCanvas?.shellOpacity ?? '',
    islandsOpaque: state.initial.islandsOpaque,
    uiDensityReady: state.initial.densityReady,
    uiBodyFontSize: state.initial.bodyFontSize,
    uiBodyFontWeight: state.initial.bodyFontWeight,
    uiProjectActionHeight: state.initial.projectActionHeight,
    uiTabHeight: state.initial.tabHeight,
    uiFontScaleReady: state.fontScaleReady,
    editorAppearanceReady: state.editorAppearanceReady,
    uiAccentContrastReady: state.accentContrastReady,
    titlebarClearanceReady: state.initial.titlebarClearanceReady,
    windowControlsReady: state.windowControlsReady,
    islandTop: state.initial.islandTop,
    topToolbarReady: state.initial.topToolbarReady,
    toolbarLayoutIndependent: state.initial.toolbarLayoutIndependent,
    workspaceHeaderRemoved: state.initial.workspaceHeaderRemoved,
    panelCapsulesReady: state.initial.panelCapsulesReady,
    panelCollapseReady: state.panelCollapseReady,
    panelResizeReady: state.panelResizeReady,
    panelDragLineReady: state.panelDragLineReady,
    trajectoryFocusReady: state.initial.trajectoryFocusReady,
  })
}

function assignWorkspaceAndWindowFields(report: VerifyReport, state: LocalVerifyState): void {
  const { bridge } = state
  Object.assign(report, {
    projectGroupingReady: state.projectGroupingReady,
    sessionActionsReady: state.sessionActionsReady,
    sessionActionsCapture: state.sessionActionsCapture,
    sessionSearchReady: state.sessionSearchReady,
    sessionTabsReady: state.sessionTabsReady,
    sessionStreamReady: bridge.isSessionStreamFrameObserved(),
    hostRecoveryRetainsEditor: state.hostRecoveryRetainsEditor,
    hostEventStreamReady: bridge.isHostEventStreamFrameObserved(),
    sessionCostRemoved: state.initial.sessionCostRemoved,
    commandPaletteReady: state.commandPaletteAudit.ready,
    commandPaletteOptionCount: state.commandPaletteAudit.optionCount ?? 0,
    commandPalettePortal: state.commandPaletteAudit.portal === true,
    commandPaletteAriaReady: state.commandPaletteAudit.ariaReady === true,
    desktopBridgeVersion: state.commandPaletteAudit.bridgeVersion ?? 0,
    fileReferenceReady: state.fileReferenceAudit.ready,
    commandExecutionReady: state.commandExecutionAudit.ready,
    attachmentDropReady: state.attachmentDropAudit.ready,
    commandLifecycleReady: state.commandLifecycleReady,
    searchCapture: state.sessionSearchState.dialogPresent ? state.searchCapture : '',
    zoomFactor: bridge.win.webContents.getZoomFactor(),
    nativeSettingsTrigger: state.settingsDialog,
    nativeSettingsDialog: state.settingsDialog,
    nativeSettingsSidebarRaised: state.settingsAudit.navCount === 6,
    nativeSettingsTopmost: state.settingsAudit.modal,
    nativeAppearanceEntry: state.settingsAudit.appearanceIndex >= 0,
    nativeAppearanceEntryPlaced: state.settingsAudit.appearanceIndex === 1,
    appearanceMenu: bridge.appearanceMenuItem.enabled,
    appearanceAccelerator: bridge.appearanceMenuItem.accelerator ?? '',
    capture: state.defaultCapture,
    darkCapture: state.darkCapture,
    darkSettingsReadable: state.darkSettingsReadable,
    largeCapture: state.largeCapture,
    largeLayoutStable: state.largeLayoutStable,
    mediumToolbarStable: state.mediumToolbarStable,
    narrowCapture: state.narrowCapture,
    narrowSettingsFits: state.narrowSettingsFits,
    narrowRightPanelHidden: state.narrowRightPanelHidden,
    nativeCapture: state.materialCapture,
    clearCapture: state.clearCapture,
    blank: false,
    productName: app.getName(),
    productVersion: app.getVersion(),
    singleInstanceLock: app.hasSingleInstanceLock(),
    updateMenu: bridge.updateMenuItem.label === '检查更新…' && bridge.updateMenuItem.enabled,
    ownership: bridge.getCurrentHost()?.ownership,
    reportedVersion: bridge.getCurrentHost()?.identity.reportedVersion,
    settingsRevision: bridge.settingsStore.read().revision,
    settingsPersisted: bridge.settingsStore.read().canvasTransparency === 0.32,
    terminalReady: state.terminalReady,
    ...state.projectViews,
    nativeWindow: {
      platform: process.platform,
      transparent: bridge.nativeTransparency,
      transparentPixelRatio: state.transparentPixelRatio,
      canvasComposition: bridge.windowController.read().canvasComposition,
    },
    nativeWindowClipReady: state.nativeWindowClipReady,
  })
}

function areCoreAndSessionChecksOk(state: LocalVerifyState): boolean {
  const { bridge } = state
  return Boolean(
    bridge.isStartupScreenVerified() &&
    state.nativeWindowClipReady &&
    state.initial.title === PRODUCT_NAME &&
    state.initial.renderer &&
    state.initial.islandCount === 3 &&
    !state.initial.pageScrollable &&
    state.initial.islandsOpaque &&
    state.initial.densityReady &&
    state.fontScaleReady &&
    state.editorAppearanceReady &&
    state.accentContrastReady &&
    state.initial.titlebarClearanceReady &&
    state.windowControlsReady &&
    state.initial.topToolbarReady &&
    state.initial.toolbarLayoutIndependent &&
    state.initial.workspaceHeaderRemoved &&
    state.initial.panelCapsulesReady &&
    state.panelCollapseReady &&
    state.panelResizeReady &&
    state.panelDragLineReady &&
    state.projectGroupingReady &&
    state.sessionActionsReady &&
    state.sessionSearchReady &&
    state.sessionTabsReady &&
    bridge.isSessionStreamFrameObserved() &&
    state.hostRecoveryRetainsEditor &&
    bridge.isHostEventStreamFrameObserved() &&
    state.initial.sessionCostRemoved &&
    state.modelMenuReady &&
    state.sessionInfoReady &&
    state.hostSettingsEventsReady &&
    state.commandPaletteAudit.ready &&
    state.commandPaletteAudit.closedAfterClear === true &&
    state.commandPaletteAudit.bridgeVersion === 23 &&
    state.fileReferenceAudit.ready &&
    state.fileReferenceAudit.closedAfterClear === true &&
    state.attachmentDropAudit.ready &&
    state.commandExecutionAudit.ready &&
    state.commandExecutionAudit.draftCleared === true &&
    state.commandExecutionAudit.paletteClosed === true &&
    state.commandLifecycleReady &&
    bridge.win.webContents.getZoomFactor() === 1 &&
    state.initial.trajectoryVisible &&
    state.initial.trajectoryFocusReady &&
    state.initial.composerCapped,
  )
}

function areProjectAndVisualChecksOk(state: LocalVerifyState): boolean {
  const pv = state.projectViews
  const mat = state.material
  return Boolean(
    pv.fileTreeReady &&
    pv.deepFileTreeReady &&
    pv.fileViewerReady &&
    pv.fileTabsReady &&
    pv.fileWorkspacePersisted &&
    pv.fileEditorReady &&
    pv.fileUnsavedGuardReady &&
    pv.contentSearchReady &&
    pv.projectTasksOnlyReady &&
    pv.imageViewerReady &&
    pv.syntaxHighlightingReady &&
    pv.fileCursorReady &&
    pv.quickOpenReady &&
    pv.taskSuggestionsRemoved &&
    pv.projectTasksReady &&
    pv.composerVisibilityReady &&
    state.terminalReady &&
    pv.sourceControlReady &&
    pv.sourceControlWriteReady &&
    pv.sourceControlFailureReady &&
    pv.uncommittedChangesReady &&
    pv.changeFileListReadable &&
    pv.contextualRightPanelReady &&
    pv.diffResponsiveReady &&
    pv.pendingInteractionsReady &&
    state.settingsDialog &&
    state.settingsAudit.focusInside &&
    state.settingsFocusRestored &&
    state.settingsAudit.panelFits &&
    state.settingsAudit.layerCount === 0 &&
    state.settingsAudit.navCount === 6 &&
    state.settingsAudit.appearanceIndex === 1 &&
    state.settingsAudit.modal &&
    state.darkSettingsReadable &&
    state.allSettingsPagesReady &&
    state.canvasColorSchemeReady &&
    state.islandGapSettingReady &&
    state.reducedTransparencyReady &&
    state.forcedColorsReady &&
    mat !== null &&
    mat.backdrop === 'none' &&
    mat.canvasImage === 'none' &&
    Math.abs(Number(mat.canvasAlpha) - 0.68) <= 0.001 &&
    Math.abs(Number(mat.scrimAlpha) - 0.84) <= 0.001 &&
    mat.contentBackground.includes('linear-gradient') &&
    state.mediumCanvasReady &&
    mat.topControlsReadable &&
    state.clearCanvasReady &&
    state.largeLayoutStable &&
    state.shellPinnedToViewport &&
    state.mediumToolbarStable &&
    state.narrowSettingsFits &&
    state.narrowRightPanelHidden &&
    state.bridge.appearanceMenuItem.enabled,
  )
}

/** 构造全量验收报告并判定全部指标是否通过。 */
export function buildFullVerificationReport(state: LocalVerifyState): {
  report: VerifyReport
  ok: boolean
} {
  state.bridge.setStage('complete')
  assertBackgroundWindowHidden(state)
  const report = createFailedVerifyReport('complete', new Error(''), true)
  delete report.error
  assignShellAndSettingsFields(report, state)
  assignWorkspaceAndWindowFields(report, state)
  return { report, ok: areCoreAndSessionChecksOk(state) && areProjectAndVisualChecksOk(state) }
}
