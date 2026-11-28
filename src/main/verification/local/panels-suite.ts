/**
 * 左右侧栏折叠、分隔条拖拽缩放与非对话视图输入区显隐验收套件。
 */
import { writeFileSync } from 'node:fs'
import { readTrafficLightLayout } from '../../window-controls.ts'
import {
  captureVerifiedPage,
  clickTrustedElement,
  dragTrustedElementHorizontally,
} from '../desktop-verifier.ts'
import { nearPanelValue } from '../host-verify-context.ts'
import { seedComposerReadings } from '../session-projection-fixture.ts'
import { verifyWindowControls } from '../window-verifier.ts'
import {
  COLLAPSED_SIDEBAR_BOUNDS_PROBE,
  DIVIDER_DRAG_LINE_ACTIVE_PROBE,
  DIVIDER_DRAG_LINE_CLEARED_PROBE,
  NON_CONVERSATION_COMPOSER_VISIBILITY_PROBE,
  PANEL_GEOMETRY_SAMPLE_PROBE,
} from './panels-probes.ts'
import {
  assertSuiteInvariants,
  ensureInitialShellSampled,
  type LocalVerifyState,
  type PanelGeometrySample,
} from './state.ts'

async function ensurePanelsComposerReadings(state: LocalVerifyState): Promise<void> {
  const existing = (await state.bridge.win.webContents.executeJavaScript(
    `document.querySelector('[data-composer-readings]') !== null`,
  )) as boolean
  if (existing) return
  const activeSessionId = (await state.bridge.win.webContents.executeJavaScript(
    `document.querySelector('.composer-card')?.getAttribute('data-session-id') ?? null`,
  )) as string | null
  if (activeSessionId === null || activeSessionId === '') return
  await seedComposerReadings(state.bridge.win, activeSessionId, frame => {
    state.bridge.win.webContents.send(state.bridge.hostChannels.sessionFrame, frame)
  })
}

async function verifyCollapsedSidebarClearance(state: LocalVerifyState): Promise<void> {
  state.readPanelGeometry = async () =>
    state.bridge.win.webContents.executeJavaScript(
      PANEL_GEOMETRY_SAMPLE_PROBE,
    ) as Promise<PanelGeometrySample | null>
  state.panelGeometryInitial = await state.readPanelGeometry()
  await clickTrustedElement(state.bridge.win, '.panel-divider--navigation .panel-divider__capsule')
  state.navigationCollapsed = await state.readPanelGeometry()

  const bounds = (await state.bridge.win.webContents.executeJavaScript(
    COLLAPSED_SIDEBAR_BOUNDS_PROBE,
  )) as Record<string, any>
  state.collapsedHeaderBounds = bounds
  const topClearanceValid =
    process.platform === 'win32' && !bounds.sessionTabsVisible
      ? nearPanelValue(bounds.sidebarTop, bounds.windowEdge) &&
        nearPanelValue(bounds.mainTop, bounds.windowEdge)
      : bounds.sidebarTop > bounds.chromeBottom
  const trafficLightsOutOfBounds = readTrafficLightLayout(state.bridge.win).some(
    button =>
      button.y < bounds.chromeTop ||
      button.y + button.height > bounds.chromeBottom ||
      Math.abs(button.y + button.height / 2 - (bounds.chromeTop + bounds.chromeBottom) / 2) > 1,
  )
  if (
    trafficLightsOutOfBounds ||
    !topClearanceValid ||
    !bounds.searchHidden ||
    !nearPanelValue(bounds.railTop, bounds.sidebarTop) ||
    !nearPanelValue(bounds.railBottom, bounds.sidebarBottom) ||
    !nearPanelValue(bounds.railWidth, bounds.modeRailWidth) ||
    bounds.railBackground === 'rgba(0, 0, 0, 0)' ||
    !nearPanelValue(bounds.settingsBottom, bounds.railBottom - 10) ||
    !nearPanelValue(bounds.settingsLeft + bounds.settingsRight, bounds.railLeft + bounds.railRight)
  ) {
    throw new Error('收起侧栏后红绿灯、顶栏收放、搜索隐藏状态、菜单宽度、设置位置或栏位材质不正确')
  }
  await verifyWindowControls(state.bridge.win, false)
  writeFileSync(
    state.bridge.artifactPath('verify-sidebar-collapsed.png'),
    (await captureVerifiedPage(state.bridge.win)).toPNG(),
  )

  if (process.platform === 'win32' && !bounds.sessionTabsVisible) {
    await clickTrustedElement(
      state.bridge.win,
      '.panel-divider--information .panel-divider__capsule',
    )
    await state.readPanelGeometry()
    await verifyWindowControls(state.bridge.win, false)
    writeFileSync(
      state.bridge.artifactPath('verify-both-collapsed.png'),
      (await captureVerifiedPage(state.bridge.win)).toPNG(),
    )
    await clickTrustedElement(
      state.bridge.win,
      '.panel-divider--information .panel-divider__capsule',
    )
    await state.readPanelGeometry()
  }
}

async function verifySidePanelCapsuleToggle(state: LocalVerifyState): Promise<void> {
  state.navigationCollapsedReady =
    state.navigationCollapsed !== null &&
    !state.navigationCollapsed.navigationVisible &&
    nearPanelValue(
      state.navigationCollapsed.mainLeft,
      state.initial.windowEdge + state.initial.modeRailWidth + 2 + state.initial.windowGap,
    ) &&
    state.navigationCollapsed.composerContained &&
    state.navigationCollapsed.navigationLabel === '展开项目面板'
  await clickTrustedElement(state.bridge.win, '.panel-divider--navigation .panel-divider__capsule')
  state.navigationExpanded = await state.readPanelGeometry()
  state.navigationExpandedReady =
    state.navigationExpanded !== null &&
    state.navigationExpanded.navigationVisible &&
    nearPanelValue(state.navigationExpanded.navigationWidth, 260) &&
    nearPanelValue(state.navigationExpanded.navigationGap, state.initial.windowGap) &&
    state.navigationExpanded.navigationLabel === '收起项目面板'

  await clickTrustedElement(state.bridge.win, '.panel-divider--information .panel-divider__capsule')
  state.informationCollapsed = await state.readPanelGeometry()
  state.informationCollapsedReady =
    state.informationCollapsed !== null &&
    !state.informationCollapsed.informationVisible &&
    nearPanelValue(
      state.informationCollapsed.mainRight,
      state.informationCollapsed.viewportWidth - state.initial.windowEdge,
    ) &&
    state.informationCollapsed.composerContained &&
    nearPanelValue(state.informationCollapsed.composerReadingsSpan, 26) &&
    state.informationCollapsed.informationLabel === '展开右侧浮岛'

  await clickTrustedElement(state.bridge.win, '.panel-divider--information .panel-divider__capsule')
  state.informationExpanded = await state.readPanelGeometry()
  state.informationExpandedReady =
    state.informationExpanded !== null &&
    state.informationExpanded.informationVisible &&
    nearPanelValue(state.informationExpanded.composerReadingsSpan, 26) &&
    nearPanelValue(state.informationExpanded.informationWidth, 260) &&
    nearPanelValue(state.informationExpanded.informationGap, state.initial.windowGap) &&
    state.informationExpanded.informationLabel === '收起右侧浮岛'

  state.panelCollapseReady =
    state.navigationCollapsedReady &&
    state.navigationExpandedReady &&
    state.informationCollapsedReady &&
    state.informationExpandedReady
}

async function resetDividerByHomeKey(state: LocalVerifyState, selector: string): Promise<void> {
  await state.bridge.win.webContents.executeJavaScript(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)})
    if (!(target instanceof HTMLElement)) return false
    target.focus()
    return target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
  })()`)
}

async function verifyNavigationDividerDrag(state: LocalVerifyState): Promise<void> {
  state.waitForPanelGeometry = async predicate => {
    let latest = await state.readPanelGeometry()
    /* oxlint-disable no-await-in-loop -- 串行轮询当前窗口的面板几何直到目标尺寸落稳。 */
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (latest !== null && predicate(latest)) return latest
      await new Promise(resolve => {
        setTimeout(resolve, 25)
      })
      latest = await state.readPanelGeometry()
    }
    /* oxlint-enable no-await-in-loop */
    return latest
  }

  const navigationDragPoint = (await state.bridge.win.webContents.executeJavaScript(`(() => {
    const divider = document.querySelector('.panel-divider--navigation')
    if (!(divider instanceof HTMLElement)) return null
    const rect = divider.getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + 28) }
  })()`)) as null | { x: number; y: number }
  if (navigationDragPoint === null) throw new Error('找不到导航面板拖动热区')

  state.bridge.win.webContents.sendInputEvent({ type: 'mouseMove', ...navigationDragPoint })
  state.bridge.win.webContents.sendInputEvent({
    type: 'mouseDown',
    ...navigationDragPoint,
    button: 'left',
    clickCount: 1,
  })
  state.bridge.win.webContents.sendInputEvent({
    type: 'mouseMove',
    x: navigationDragPoint.x + 36,
    y: navigationDragPoint.y,
    movementX: 36,
    movementY: 0,
  })
  state.dragLineActive = (await state.bridge.win.webContents.executeJavaScript(
    DIVIDER_DRAG_LINE_ACTIVE_PROBE,
  )) as boolean
  state.bridge.win.webContents.sendInputEvent({
    type: 'mouseUp',
    x: navigationDragPoint.x + 36,
    y: navigationDragPoint.y,
    button: 'left',
    clickCount: 1,
  })
  state.bridge.win.webContents.sendInputEvent({
    type: 'mouseMove',
    x: navigationDragPoint.x + 72,
    y: navigationDragPoint.y,
  })
  state.dragLineCleared = (await state.bridge.win.webContents.executeJavaScript(
    DIVIDER_DRAG_LINE_CLEARED_PROBE,
  )) as boolean
  state.panelDragLineReady = state.dragLineActive && state.dragLineCleared
  state.navigationResized = await state.waitForPanelGeometry(
    geometry => geometry.navigationWidth >= 295 && geometry.navigationWidth <= 297,
  )
  await resetDividerByHomeKey(state, '.panel-divider--navigation')
  state.navigationReset = await state.waitForPanelGeometry(geometry =>
    nearPanelValue(geometry.navigationWidth, 260),
  )
}

async function verifyInformationAndComposerDividerDrag(state: LocalVerifyState): Promise<void> {
  await dragTrustedElementHorizontally(state.bridge.win, '.panel-divider--information', -36)
  state.informationResized = await state.waitForPanelGeometry(
    geometry => geometry.informationWidth >= 295 && geometry.informationWidth <= 297,
  )
  await resetDividerByHomeKey(state, '.panel-divider--information')
  state.informationReset = await state.waitForPanelGeometry(geometry =>
    nearPanelValue(geometry.informationWidth, 260),
  )

  const composerDragPoint = (await state.bridge.win.webContents.executeJavaScript(`(() => {
    const divider = document.querySelector('.panel-divider--composer')
    if (!(divider instanceof HTMLElement)) return null
    const rect = divider.getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  })()`)) as null | { x: number; y: number }
  if (composerDragPoint === null) throw new Error('找不到输入区高度拖动热区')
  state.bridge.win.webContents.sendInputEvent({ type: 'mouseMove', ...composerDragPoint })
  state.bridge.win.webContents.sendInputEvent({
    type: 'mouseDown',
    ...composerDragPoint,
    button: 'left',
    clickCount: 1,
  })
  state.bridge.win.webContents.sendInputEvent({
    type: 'mouseMove',
    x: composerDragPoint.x,
    y: composerDragPoint.y - 36,
    movementX: 0,
    movementY: -36,
  })
  state.bridge.win.webContents.sendInputEvent({
    type: 'mouseUp',
    x: composerDragPoint.x,
    y: composerDragPoint.y - 36,
    button: 'left',
    clickCount: 1,
  })
  state.composerResized = await state.waitForPanelGeometry(
    geometry => geometry.composerHeight >= 147 && geometry.composerHeight <= 149,
  )
  await resetDividerByHomeKey(state, '.panel-divider--composer')
  state.composerReset = await state.waitForPanelGeometry(geometry =>
    nearPanelValue(geometry.composerHeight, 112),
  )
}

async function verifyCornerHandleResize(state: LocalVerifyState): Promise<void> {
  const cornerDragPoint = (await state.bridge.win.webContents.executeJavaScript(`(() => {
    const handle = document.querySelector('.panel-resize-corner')
    if (!(handle instanceof HTMLElement)) return null
    const rect = handle.getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  })()`)) as null | { x: number; y: number }
  if (cornerDragPoint === null) throw new Error('找不到二维布局拖动柄')
  state.bridge.win.webContents.sendInputEvent({ type: 'mouseMove', ...cornerDragPoint })
  state.bridge.win.webContents.sendInputEvent({
    type: 'mouseDown',
    ...cornerDragPoint,
    button: 'left',
    clickCount: 1,
  })
  state.bridge.win.webContents.sendInputEvent({
    type: 'mouseMove',
    x: cornerDragPoint.x - 30,
    y: cornerDragPoint.y - 30,
    movementX: -30,
    movementY: -30,
  })
  state.bridge.win.webContents.sendInputEvent({
    type: 'mouseUp',
    x: cornerDragPoint.x - 30,
    y: cornerDragPoint.y - 30,
    button: 'left',
    clickCount: 1,
  })
  state.cornerResized = await state.waitForPanelGeometry(
    geometry =>
      geometry.informationWidth >= 289 &&
      geometry.informationWidth <= 291 &&
      geometry.composerHeight >= 141 &&
      geometry.composerHeight <= 143,
  )
  await resetDividerByHomeKey(state, '.panel-resize-corner')
  state.cornerReset = await state.waitForPanelGeometry(
    geometry =>
      nearPanelValue(geometry.informationWidth, 260) &&
      nearPanelValue(geometry.composerHeight, 112),
  )
}

async function evaluatePanelResizeAndComposerVisibility(state: LocalVerifyState): Promise<void> {
  state.panelResizeReady =
    state.navigationResized !== null &&
    state.navigationResized.navigationWidth >= 295 &&
    state.navigationResized.navigationWidth <= 297 &&
    nearPanelValue(state.navigationResized.navigationGap, state.initial.windowGap) &&
    state.navigationReset !== null &&
    nearPanelValue(state.navigationReset.navigationWidth, 260) &&
    state.informationResized !== null &&
    state.informationResized.informationWidth >= 295 &&
    state.informationResized.informationWidth <= 297 &&
    nearPanelValue(state.informationResized.informationGap, state.initial.windowGap) &&
    state.panelGeometryInitial !== null &&
    state.panelGeometryInitial.resizeCornerOpacity === 0 &&
    nearPanelValue(
      state.informationResized.viewTabsLeft,
      state.panelGeometryInitial.viewTabsLeft,
    ) &&
    nearPanelValue(
      state.informationResized.viewTabsRight,
      state.panelGeometryInitial.viewTabsRight,
    ) &&
    nearPanelValue(
      state.informationResized.viewTabsWidth,
      state.panelGeometryInitial.viewTabsWidth,
    ) &&
    state.informationReset !== null &&
    nearPanelValue(state.informationReset.informationWidth, 260) &&
    nearPanelValue(
      state.informationReset.viewTabsWidth,
      state.panelGeometryInitial.viewTabsWidth,
    ) &&
    state.composerResized !== null &&
    state.composerResized.composerHeight >= 147 &&
    state.composerResized.composerHeight <= 149 &&
    state.composerResized.composerOverlayReady &&
    state.composerResized.composerContained &&
    nearPanelValue(state.composerResized.composerFooterBottomGap, 10) &&
    state.composerResized.mainHeight >= 220 &&
    state.composerReset !== null &&
    nearPanelValue(state.composerReset.composerHeight, 112) &&
    nearPanelValue(state.composerReset.composerDividerTop, state.composerReset.composerTop - 5) &&
    state.cornerResized !== null &&
    state.cornerResized.informationWidth >= 289 &&
    state.cornerResized.informationWidth <= 291 &&
    state.cornerResized.composerHeight >= 141 &&
    state.cornerResized.composerHeight <= 143 &&
    state.cornerResized.resizeCornerCenterX !== null &&
    state.cornerResized.resizeCornerCenterY !== null &&
    nearPanelValue(
      state.cornerResized.resizeCornerCenterX,
      state.cornerResized.mainRight + state.initial.windowGap / 2,
    ) &&
    nearPanelValue(
      state.cornerResized.resizeCornerCenterY,
      state.cornerResized.composerTop - 2.5,
    ) &&
    state.cornerReset !== null &&
    nearPanelValue(state.cornerReset.informationWidth, 260) &&
    nearPanelValue(state.cornerReset.composerHeight, 112)

  console.log('desktop-shell-verify-local: panel-geometry', {
    navigationCollapsedReady: state.navigationCollapsedReady,
    navigationExpandedReady: state.navigationExpandedReady,
    informationCollapsedReady: state.informationCollapsedReady,
    informationExpandedReady: state.informationExpandedReady,
    navigationResized: state.navigationResized,
    informationResized: state.informationResized,
    composerResized: state.composerResized,
    composerReset: state.composerReset,
    cornerResized: state.cornerResized,
    cornerReset: state.cornerReset,
  })
  state.composerVisibilityReady = (await state.bridge.win.webContents.executeJavaScript(
    NON_CONVERSATION_COMPOSER_VISIBILITY_PROBE,
  )) as boolean
}

/** 运行 panels 验收套件。 */
export async function runPanelsSuite(state: LocalVerifyState): Promise<void> {
  await ensureInitialShellSampled(state)
  await ensurePanelsComposerReadings(state)
  await verifyCollapsedSidebarClearance(state)
  await verifySidePanelCapsuleToggle(state)
  await verifyNavigationDividerDrag(state)
  await verifyInformationAndComposerDividerDrag(state)
  await verifyCornerHandleResize(state)
  await evaluatePanelResizeAndComposerVisibility(state)
  assertSuiteInvariants('panels', state)
}
