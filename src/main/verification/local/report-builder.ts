/**
 * 组装全量与按套件子集执行的最终桌面验收报告（VerifyReport）。
 */
import { app } from 'electron'
import { PRODUCT_NAME } from '../../../shared/product.ts'
import { createFailedVerifyReport, type VerifyReport } from '../desktop-verifier.ts'
import type { LocalSuiteName } from '../host-verify-context.ts'
import type { LocalVerifyState } from './state.ts'

function assertBackgroundWindowHidden(bag: LocalVerifyState): void {
  const { win, verifyBackground } = bag.bridge
  if (verifyBackground && (win.isVisible() || win.isFocused())) {
    throw new Error('后台验收意外显示了窗口或占用了系统焦点')
  }
}

/** 为按子集快速运行的验收套件生成通过报告。 */
export function buildSubsetVerificationReport(
  bag: LocalVerifyState,
  suites: readonly LocalSuiteName[],
): { report: VerifyReport; ok: boolean } {
  bag.bridge.setStage('complete')
  assertBackgroundWindowHidden(bag)
  const report = createFailedVerifyReport('complete', new Error(''), true)
  delete report.error
  Object.assign(report, {
    backgroundVerification: bag.bridge.verifyBackground,
    startupScreen: bag.bridge.isStartupScreenVerified(),
    appMounted: true,
    uiActive: true,
    frame: true,
    blank: false,
    suites,
    productName: app.getName(),
    productVersion: app.getVersion(),
    singleInstanceLock: app.hasSingleInstanceLock(),
    ownership: bag.bridge.getCurrentHost()?.ownership,
    reportedVersion: bag.bridge.getCurrentHost()?.identity.reportedVersion,
  })
  return { report, ok: true }
}

function assignShellAndSettingsFields(report: VerifyReport, bag: LocalVerifyState): void {
  const { bridge } = bag
  Object.assign(report, {
    backgroundVerification: bridge.verifyBackground,
    nativeFullscreenChecked: process.platform === 'darwin' && !bridge.verifyBackground,
    startupScreen: bridge.isStartupScreenVerified(),
    startupCapture: 'verify-startup.png',
    startupDarkCapture: 'verify-startup-dark.png',
    appMounted: bag.initial.renderer,
    sessionInfoReady: bag.sessionInfoReady,
    hostSettingsEventsReady: bag.hostSettingsEventsReady,
    uiActive: true,
    frame: true,
    islandCount: bag.initial.islandCount,
    canvasCount: 1,
    pageScrollable: bag.initial.pageScrollable,
    shellPinnedToViewport: bag.shellPinnedToViewport,
    transparentRoots: bag.clearCanvas?.transparentRoots ?? false,
    settingsDialog: bag.settingsDialog,
    settingsFocusInside: bag.settingsAudit.focusInside && bag.settingsFocusRestored,
    settingsLayerCount: bag.settingsAudit.layerCount,
    settingsAccent: bridge.settingsStore.read().accentColor,
    settingsCanvasOpacity: bag.material?.canvasAlpha ?? '',
    settingsCanvasAlpha: Number(bag.material?.canvasAlpha ?? 0),
    settingsCanvasImageApplied: bag.material?.canvasImage === 'none',
    canvasColorSchemeReady: bag.canvasColorSchemeReady,
    mediumCanvasReady: bag.mediumCanvasReady,
    topControlsReadable: bag.material?.topControlsReadable ?? false,
    clearCanvasReady: bag.clearCanvasReady,
    settingsPanelFits: bag.settingsAudit.panelFits,
    settingsPagesReady: bag.allSettingsPagesReady,
    islandGapSettingReady: bag.islandGapSettingReady,
    appearanceCapture: bag.appearanceCapture,
    appearanceBackgroundsCapture: bag.appearanceBackgroundsCapture,
    modelsCapture: bag.modelsCapture,
    modelMenuCapture: bag.modelMenuCapture,
    modelMenuReady: bag.modelMenuReady,
    pluginsCapture: bag.pluginsCapture,
    automationCapture: bag.automationCapture,
    automationSettingsReady: bag.automationSettingsReady,
    presetsCapture: bag.presetsCapture,
    frameOpacity: bag.clearCanvas?.shellOpacity ?? '',
    islandsOpaque: bag.initial.islandsOpaque,
    uiDensityReady: bag.initial.densityReady,
    uiBodyFontSize: bag.initial.bodyFontSize,
    uiBodyFontWeight: bag.initial.bodyFontWeight,
    uiProjectActionHeight: bag.initial.projectActionHeight,
    uiTabHeight: bag.initial.tabHeight,
    uiFontScaleReady: bag.fontScaleReady,
    editorAppearanceReady: bag.editorAppearanceReady,
    uiAccentContrastReady: bag.accentContrastReady,
    titlebarClearanceReady: bag.initial.titlebarClearanceReady,
    windowControlsReady: bag.windowControlsReady,
    islandTop: bag.initial.islandTop,
    topToolbarReady: bag.initial.topToolbarReady,
    toolbarLayoutIndependent: bag.initial.toolbarLayoutIndependent,
    workspaceHeaderRemoved: bag.initial.workspaceHeaderRemoved,
    panelCapsulesReady: bag.initial.panelCapsulesReady,
    panelCollapseReady: bag.panelCollapseReady,
    panelResizeReady: bag.panelResizeReady,
    panelDragLineReady: bag.panelDragLineReady,
    trajectoryFocusReady: bag.initial.trajectoryFocusReady,
  })
}

function assignWorkspaceAndWindowFields(report: VerifyReport, bag: LocalVerifyState): void {
  const { bridge } = bag
  Object.assign(report, {
    projectGroupingReady: bag.projectGroupingReady,
    sessionActionsReady: bag.sessionActionsReady,
    sessionActionsCapture: bag.sessionActionsCapture,
    sessionSearchReady: bag.sessionSearchReady,
    sessionTabsReady: bag.sessionTabsReady,
    sessionStreamReady: bridge.isSessionStreamFrameObserved(),
    hostRecoveryRetainsEditor: bag.hostRecoveryRetainsEditor,
    hostEventStreamReady: bridge.isHostEventStreamFrameObserved(),
    sessionCostRemoved: bag.initial.sessionCostRemoved,
    commandPaletteReady: bag.commandPaletteAudit.ready,
    commandPaletteOptionCount: bag.commandPaletteAudit.optionCount ?? 0,
    commandPalettePortal: bag.commandPaletteAudit.portal === true,
    commandPaletteAriaReady: bag.commandPaletteAudit.ariaReady === true,
    desktopBridgeVersion: bag.commandPaletteAudit.bridgeVersion ?? 0,
    fileReferenceReady: bag.fileReferenceAudit.ready,
    commandExecutionReady: bag.commandExecutionAudit.ready,
    attachmentDropReady: bag.attachmentDropAudit.ready,
    commandLifecycleReady: bag.commandLifecycleReady,
    searchCapture: bag.sessionSearchState.dialogPresent ? bag.searchCapture : '',
    zoomFactor: bridge.win.webContents.getZoomFactor(),
    nativeSettingsTrigger: bag.settingsDialog,
    nativeSettingsDialog: bag.settingsDialog,
    nativeSettingsSidebarRaised: bag.settingsAudit.navCount === 6,
    nativeSettingsTopmost: bag.settingsAudit.modal,
    nativeAppearanceEntry: bag.settingsAudit.appearanceIndex >= 0,
    nativeAppearanceEntryPlaced: bag.settingsAudit.appearanceIndex === 1,
    appearanceMenu: bridge.appearanceMenuItem.enabled,
    appearanceAccelerator: bridge.appearanceMenuItem.accelerator ?? '',
    capture: bag.defaultCapture,
    darkCapture: bag.darkCapture,
    darkSettingsReadable: bag.darkSettingsReadable,
    largeCapture: bag.largeCapture,
    largeLayoutStable: bag.largeLayoutStable,
    mediumToolbarStable: bag.mediumToolbarStable,
    narrowCapture: bag.narrowCapture,
    narrowSettingsFits: bag.narrowSettingsFits,
    narrowRightPanelHidden: bag.narrowRightPanelHidden,
    nativeCapture: bag.materialCapture,
    clearCapture: bag.clearCapture,
    blank: false,
    productName: app.getName(),
    productVersion: app.getVersion(),
    singleInstanceLock: app.hasSingleInstanceLock(),
    updateMenu: bridge.updateMenuItem.label === '检查更新…' && bridge.updateMenuItem.enabled,
    ownership: bridge.getCurrentHost()?.ownership,
    reportedVersion: bridge.getCurrentHost()?.identity.reportedVersion,
    settingsRevision: bridge.settingsStore.read().revision,
    settingsPersisted: bridge.settingsStore.read().canvasTransparency === 0.32,
    terminalReady: bag.terminalReady,
    ...bag.projectViews,
    nativeWindow: {
      platform: process.platform,
      transparent: bridge.nativeTransparency,
      transparentPixelRatio: bag.transparentPixelRatio,
      canvasComposition: bridge.windowController.read().canvasComposition,
    },
    nativeWindowClipReady: bag.nativeWindowClipReady,
  })
}

function areCoreAndSessionChecksOk(bag: LocalVerifyState): boolean {
  const { bridge } = bag
  return Boolean(
    bridge.isStartupScreenVerified() &&
    bag.nativeWindowClipReady &&
    bag.initial.title === PRODUCT_NAME &&
    bag.initial.renderer &&
    bag.initial.islandCount === 3 &&
    !bag.initial.pageScrollable &&
    bag.initial.islandsOpaque &&
    bag.initial.densityReady &&
    bag.fontScaleReady &&
    bag.editorAppearanceReady &&
    bag.accentContrastReady &&
    bag.initial.titlebarClearanceReady &&
    bag.windowControlsReady &&
    bag.initial.topToolbarReady &&
    bag.initial.toolbarLayoutIndependent &&
    bag.initial.workspaceHeaderRemoved &&
    bag.initial.panelCapsulesReady &&
    bag.panelCollapseReady &&
    bag.panelResizeReady &&
    bag.panelDragLineReady &&
    bag.projectGroupingReady &&
    bag.sessionActionsReady &&
    bag.sessionSearchReady &&
    bag.sessionTabsReady &&
    bridge.isSessionStreamFrameObserved() &&
    bag.hostRecoveryRetainsEditor &&
    bridge.isHostEventStreamFrameObserved() &&
    bag.initial.sessionCostRemoved &&
    bag.modelMenuReady &&
    bag.sessionInfoReady &&
    bag.hostSettingsEventsReady &&
    bag.commandPaletteAudit.ready &&
    bag.commandPaletteAudit.closedAfterClear === true &&
    bag.commandPaletteAudit.bridgeVersion === 23 &&
    bag.fileReferenceAudit.ready &&
    bag.fileReferenceAudit.closedAfterClear === true &&
    bag.attachmentDropAudit.ready &&
    bag.commandExecutionAudit.ready &&
    bag.commandExecutionAudit.draftCleared === true &&
    bag.commandExecutionAudit.paletteClosed === true &&
    bag.commandLifecycleReady &&
    bridge.win.webContents.getZoomFactor() === 1 &&
    bag.initial.trajectoryVisible &&
    bag.initial.trajectoryFocusReady &&
    bag.initial.composerCapped,
  )
}

function areProjectAndVisualChecksOk(bag: LocalVerifyState): boolean {
  const pv = bag.projectViews
  const mat = bag.material
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
    bag.terminalReady &&
    pv.sourceControlReady &&
    pv.sourceControlWriteReady &&
    pv.sourceControlFailureReady &&
    pv.uncommittedChangesReady &&
    pv.changeFileListReadable &&
    pv.contextualRightPanelReady &&
    pv.diffResponsiveReady &&
    pv.pendingInteractionsReady &&
    bag.settingsDialog &&
    bag.settingsAudit.focusInside &&
    bag.settingsFocusRestored &&
    bag.settingsAudit.panelFits &&
    bag.settingsAudit.layerCount === 0 &&
    bag.settingsAudit.navCount === 6 &&
    bag.settingsAudit.appearanceIndex === 1 &&
    bag.settingsAudit.modal &&
    bag.darkSettingsReadable &&
    bag.allSettingsPagesReady &&
    bag.canvasColorSchemeReady &&
    bag.islandGapSettingReady &&
    bag.reducedTransparencyReady &&
    bag.forcedColorsReady &&
    mat !== null &&
    mat.backdrop === 'none' &&
    mat.canvasImage === 'none' &&
    Math.abs(Number(mat.canvasAlpha) - 0.68) <= 0.001 &&
    Math.abs(Number(mat.scrimAlpha) - 0.84) <= 0.001 &&
    mat.contentBackground.includes('linear-gradient') &&
    bag.mediumCanvasReady &&
    mat.topControlsReadable &&
    bag.clearCanvasReady &&
    bag.largeLayoutStable &&
    bag.shellPinnedToViewport &&
    bag.mediumToolbarStable &&
    bag.narrowSettingsFits &&
    bag.narrowRightPanelHidden &&
    bag.bridge.appearanceMenuItem.enabled,
  )
}

/** 构造全量验收报告并判定全部指标是否通过。 */
export function buildFullVerificationReport(bag: LocalVerifyState): {
  report: VerifyReport
  ok: boolean
} {
  bag.bridge.setStage('complete')
  assertBackgroundWindowHidden(bag)
  const report = createFailedVerifyReport('complete', new Error(''), true)
  delete report.error
  assignShellAndSettingsFields(report, bag)
  assignWorkspaceAndWindowFields(report, bag)
  return { report, ok: areCoreAndSessionChecksOk(bag) && areProjectAndVisualChecksOk(bag) }
}
