/**
 * 左右侧栏折叠、分隔条拖拽缩放与非对话视图输入区显隐验收套件。
 */
import { writeFileSync } from 'node:fs'
import { readTrafficLightLayout } from '../../window-controls.ts'
import { nearPanelValue } from '../host-verify-context.ts'
import {
  captureVerifiedPage,
  clickTrustedElement,
  dragTrustedElementHorizontally,
} from '../desktop-verifier.ts'
import { seedComposerReadings } from '../session-projection-fixture.ts'
import { type LocalVerifyState, assertSuiteInvariants, ensureInitialShellSampled } from './state.ts'
import {
  PANELS_SCRIPT_1,
  PANELS_SCRIPT_2,
  PANELS_SCRIPT_3,
  PANELS_SCRIPT_4,
  PANELS_SCRIPT_5,
} from './panels-scripts.ts'

/** 执行 panels 验收套件第 1 阶段。 */
export async function runPanelsStep1(bag: LocalVerifyState): Promise<void> {
  bag.readPanelGeometry = async () =>
    bag.bridge.win.webContents.executeJavaScript(PANELS_SCRIPT_1) as Promise<null | {
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
  bag.panelGeometryInitial = await bag.readPanelGeometry()
  await clickTrustedElement(bag.bridge.win, '.panel-divider--navigation .panel-divider__capsule')
  bag.navigationCollapsed = await bag.readPanelGeometry()
}

/** 执行 panels 验收套件第 2 阶段。 */
export async function runPanelsStep2(bag: LocalVerifyState): Promise<void> {
  bag.collapsedHeaderBounds = (await bag.bridge.win.webContents.executeJavaScript(
    PANELS_SCRIPT_2,
  )) as {
    sidebarTop: number
    sidebarBottom: number
    chromeTop: number
    chromeBottom: number
    searchHidden: boolean
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
    readTrafficLightLayout(bag.bridge.win).some(
      button =>
        button.y < bag.collapsedHeaderBounds.chromeTop ||
        button.y + button.height > bag.collapsedHeaderBounds.chromeBottom ||
        Math.abs(
          button.y +
            button.height / 2 -
            (bag.collapsedHeaderBounds.chromeTop + bag.collapsedHeaderBounds.chromeBottom) / 2,
        ) > 1,
    ) ||
    bag.collapsedHeaderBounds.sidebarTop <= bag.collapsedHeaderBounds.chromeBottom ||
    !bag.collapsedHeaderBounds.searchHidden ||
    !nearPanelValue(bag.collapsedHeaderBounds.railTop, bag.collapsedHeaderBounds.sidebarTop) ||
    !nearPanelValue(
      bag.collapsedHeaderBounds.railBottom,
      bag.collapsedHeaderBounds.sidebarBottom,
    ) ||
    !nearPanelValue(bag.collapsedHeaderBounds.railWidth, bag.collapsedHeaderBounds.modeRailWidth) ||
    bag.collapsedHeaderBounds.railBackground === 'rgba(0, 0, 0, 0)' ||
    !nearPanelValue(
      bag.collapsedHeaderBounds.settingsBottom,
      bag.collapsedHeaderBounds.railBottom - 10,
    ) ||
    !nearPanelValue(
      bag.collapsedHeaderBounds.settingsLeft + bag.collapsedHeaderBounds.settingsRight,
      bag.collapsedHeaderBounds.railLeft + bag.collapsedHeaderBounds.railRight,
    )
  )
    throw new Error('收起侧栏后红绿灯、搜索隐藏状态、菜单宽度、设置位置或栏位材质不正确')
  writeFileSync(
    bag.bridge.artifactPath('verify-sidebar-collapsed.png'),
    (await captureVerifiedPage(bag.bridge.win)).toPNG(),
  )
}

/** 执行 panels 验收套件第 3 阶段。 */
export async function runPanelsStep3(bag: LocalVerifyState): Promise<void> {
  bag.navigationCollapsedReady =
    bag.navigationCollapsed !== null &&
    !bag.navigationCollapsed.navigationVisible &&
    nearPanelValue(
      bag.navigationCollapsed.mainLeft,
      bag.initial.windowEdge + bag.initial.modeRailWidth + 2 + bag.initial.windowGap,
    ) &&
    bag.navigationCollapsed.composerContained &&
    bag.navigationCollapsed.navigationLabel === '展开项目面板'
  await clickTrustedElement(bag.bridge.win, '.panel-divider--navigation .panel-divider__capsule')
  bag.navigationExpanded = await bag.readPanelGeometry()
  bag.navigationExpandedReady =
    bag.navigationExpanded !== null &&
    bag.navigationExpanded.navigationVisible &&
    nearPanelValue(bag.navigationExpanded.navigationWidth, 260) &&
    nearPanelValue(bag.navigationExpanded.navigationGap, bag.initial.windowGap) &&
    bag.navigationExpanded.navigationLabel === '收起项目面板'
  await clickTrustedElement(bag.bridge.win, '.panel-divider--information .panel-divider__capsule')
  bag.informationCollapsed = await bag.readPanelGeometry()
  bag.informationCollapsedReady =
    bag.informationCollapsed !== null &&
    !bag.informationCollapsed.informationVisible &&
    nearPanelValue(
      bag.informationCollapsed.mainRight,
      bag.informationCollapsed.viewportWidth - bag.initial.windowEdge,
    ) &&
    bag.informationCollapsed.composerContained &&
    nearPanelValue(bag.informationCollapsed.composerReadingsSpan, 26) &&
    bag.informationCollapsed.informationLabel === '展开右侧浮岛'
  await clickTrustedElement(bag.bridge.win, '.panel-divider--information .panel-divider__capsule')
  bag.informationExpanded = await bag.readPanelGeometry()
  bag.informationExpandedReady =
    bag.informationExpanded !== null &&
    bag.informationExpanded.informationVisible &&
    nearPanelValue(bag.informationExpanded.composerReadingsSpan, 26) &&
    nearPanelValue(bag.informationExpanded.informationWidth, 260) &&
    nearPanelValue(bag.informationExpanded.informationGap, bag.initial.windowGap) &&
    bag.informationExpanded.informationLabel === '收起右侧浮岛'
  bag.panelCollapseReady =
    bag.navigationCollapsedReady &&
    bag.navigationExpandedReady &&
    bag.informationCollapsedReady &&
    bag.informationExpandedReady
  bag.navigationDragPoint = (await bag.bridge.win.webContents.executeJavaScript(`(() => {
      const divider = document.querySelector('.panel-divider--navigation')
      if (!(divider instanceof HTMLElement)) return null
      const rect = divider.getBoundingClientRect()
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + 28) }
    })()`)) as null | { x: number; y: number }
  if (bag.navigationDragPoint === null) throw new Error('找不到导航面板拖动热区')
  bag.bridge.win.webContents.sendInputEvent({ type: 'mouseMove', ...bag.navigationDragPoint })
}

/** 执行 panels 验收套件第 4 阶段。 */
export async function runPanelsStep4(bag: LocalVerifyState): Promise<void> {
  bag.bridge.win.webContents.sendInputEvent({
    type: 'mouseDown',
    ...bag.navigationDragPoint,
    button: 'left',
    clickCount: 1,
  })
  bag.bridge.win.webContents.sendInputEvent({
    type: 'mouseMove',
    x: bag.navigationDragPoint.x + 36,
    y: bag.navigationDragPoint.y,
    movementX: 36,
    movementY: 0,
  })
  bag.waitForPanelGeometry = async (
    predicate: (
      geometry: NonNullable<Awaited<ReturnType<typeof bag.readPanelGeometry>>>,
    ) => boolean,
  ) => {
    let latest = await bag.readPanelGeometry()
    /* oxlint-disable no-await-in-loop -- 串行轮询当前窗口的面板几何直到目标尺寸落稳。 */
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (latest !== null && predicate(latest)) return latest
      await new Promise(resolve => {
        setTimeout(resolve, 25)
      })
      latest = await bag.readPanelGeometry()
    }
    /* oxlint-enable no-await-in-loop */
    return latest
  }
  bag.dragLineActive = (await bag.bridge.win.webContents.executeJavaScript(
    PANELS_SCRIPT_3,
  )) as boolean
  bag.bridge.win.webContents.sendInputEvent({
    type: 'mouseUp',
    x: bag.navigationDragPoint.x + 36,
    y: bag.navigationDragPoint.y,
    button: 'left',
    clickCount: 1,
  })
  bag.bridge.win.webContents.sendInputEvent({
    type: 'mouseMove',
    x: bag.navigationDragPoint.x + 72,
    y: bag.navigationDragPoint.y,
  })
  bag.dragLineCleared = (await bag.bridge.win.webContents.executeJavaScript(
    PANELS_SCRIPT_4,
  )) as boolean
  bag.panelDragLineReady = bag.dragLineActive && bag.dragLineCleared
  bag.navigationResized = await bag.waitForPanelGeometry(
    geometry => geometry.navigationWidth >= 295 && geometry.navigationWidth <= 297,
  )
  await bag.bridge.win.webContents.executeJavaScript(`(() => {
      const divider = document.querySelector('.panel-divider--navigation')
      if (!(divider instanceof HTMLElement)) return false
      divider.focus()
      return divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    })()`)
}

/** 执行 panels 验收套件第 5 阶段。 */
export async function runPanelsStep5(bag: LocalVerifyState): Promise<void> {
  bag.navigationReset = await bag.waitForPanelGeometry(geometry =>
    nearPanelValue(geometry.navigationWidth, 260),
  )
  await dragTrustedElementHorizontally(bag.bridge.win, '.panel-divider--information', -36)
  bag.informationResized = await bag.waitForPanelGeometry(
    geometry => geometry.informationWidth >= 295 && geometry.informationWidth <= 297,
  )
  await bag.bridge.win.webContents.executeJavaScript(`(() => {
      const divider = document.querySelector('.panel-divider--information')
      if (!(divider instanceof HTMLElement)) return false
      divider.focus()
      return divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    })()`)
  bag.informationReset = await bag.waitForPanelGeometry(geometry =>
    nearPanelValue(geometry.informationWidth, 260),
  )
  bag.composerDragPoint = (await bag.bridge.win.webContents.executeJavaScript(`(() => {
      const divider = document.querySelector('.panel-divider--composer')
      if (!(divider instanceof HTMLElement)) return null
      const rect = divider.getBoundingClientRect()
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
    })()`)) as null | { x: number; y: number }
  if (bag.composerDragPoint === null) throw new Error('找不到输入区高度拖动热区')
  bag.bridge.win.webContents.sendInputEvent({ type: 'mouseMove', ...bag.composerDragPoint })
  bag.bridge.win.webContents.sendInputEvent({
    type: 'mouseDown',
    ...bag.composerDragPoint,
    button: 'left',
    clickCount: 1,
  })
  bag.bridge.win.webContents.sendInputEvent({
    type: 'mouseMove',
    x: bag.composerDragPoint.x,
    y: bag.composerDragPoint.y - 36,
    movementX: 0,
    movementY: -36,
  })
  bag.bridge.win.webContents.sendInputEvent({
    type: 'mouseUp',
    x: bag.composerDragPoint.x,
    y: bag.composerDragPoint.y - 36,
    button: 'left',
    clickCount: 1,
  })
  bag.composerResized = await bag.waitForPanelGeometry(
    geometry => geometry.composerHeight >= 147 && geometry.composerHeight <= 149,
  )
}

/** 执行 panels 验收套件第 6 阶段。 */
export async function runPanelsStep6(bag: LocalVerifyState): Promise<void> {
  await bag.bridge.win.webContents.executeJavaScript(`(() => {
      const divider = document.querySelector('.panel-divider--composer')
      if (!(divider instanceof HTMLElement)) return false
      divider.focus()
      return divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    })()`)
  bag.composerReset = await bag.waitForPanelGeometry(geometry =>
    nearPanelValue(geometry.composerHeight, 112),
  )
  bag.cornerDragPoint = (await bag.bridge.win.webContents.executeJavaScript(`(() => {
      const handle = document.querySelector('.panel-resize-corner')
      if (!(handle instanceof HTMLElement)) return null
      const rect = handle.getBoundingClientRect()
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
    })()`)) as null | { x: number; y: number }
  if (bag.cornerDragPoint === null) throw new Error('找不到二维布局拖动柄')
  bag.bridge.win.webContents.sendInputEvent({ type: 'mouseMove', ...bag.cornerDragPoint })
  bag.bridge.win.webContents.sendInputEvent({
    type: 'mouseDown',
    ...bag.cornerDragPoint,
    button: 'left',
    clickCount: 1,
  })
  bag.bridge.win.webContents.sendInputEvent({
    type: 'mouseMove',
    x: bag.cornerDragPoint.x - 30,
    y: bag.cornerDragPoint.y - 30,
    movementX: -30,
    movementY: -30,
  })
  bag.bridge.win.webContents.sendInputEvent({
    type: 'mouseUp',
    x: bag.cornerDragPoint.x - 30,
    y: bag.cornerDragPoint.y - 30,
    button: 'left',
    clickCount: 1,
  })
  bag.cornerResized = await bag.waitForPanelGeometry(
    geometry =>
      geometry.informationWidth >= 289 &&
      geometry.informationWidth <= 291 &&
      geometry.composerHeight >= 141 &&
      geometry.composerHeight <= 143,
  )
  await bag.bridge.win.webContents.executeJavaScript(`(() => {
      const handle = document.querySelector('.panel-resize-corner')
      if (!(handle instanceof HTMLElement)) return false
      handle.focus()
      return handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    })()`)
}

/** 执行 panels 验收套件第 7 阶段。 */
export async function runPanelsStep7(bag: LocalVerifyState): Promise<void> {
  bag.cornerReset = await bag.waitForPanelGeometry(
    geometry =>
      nearPanelValue(geometry.informationWidth, 260) &&
      nearPanelValue(geometry.composerHeight, 112),
  )
  bag.panelResizeReady =
    bag.navigationResized !== null &&
    bag.navigationResized.navigationWidth >= 295 &&
    bag.navigationResized.navigationWidth <= 297 &&
    nearPanelValue(bag.navigationResized.navigationGap, bag.initial.windowGap) &&
    bag.navigationReset !== null &&
    nearPanelValue(bag.navigationReset.navigationWidth, 260) &&
    bag.informationResized !== null &&
    bag.informationResized.informationWidth >= 295 &&
    bag.informationResized.informationWidth <= 297 &&
    nearPanelValue(bag.informationResized.informationGap, bag.initial.windowGap) &&
    bag.panelGeometryInitial !== null &&
    bag.panelGeometryInitial.resizeCornerOpacity === 0 &&
    nearPanelValue(bag.informationResized.viewTabsLeft, bag.panelGeometryInitial.viewTabsLeft) &&
    nearPanelValue(bag.informationResized.viewTabsRight, bag.panelGeometryInitial.viewTabsRight) &&
    nearPanelValue(bag.informationResized.viewTabsWidth, bag.panelGeometryInitial.viewTabsWidth) &&
    bag.informationReset !== null &&
    nearPanelValue(bag.informationReset.informationWidth, 260) &&
    nearPanelValue(bag.informationReset.viewTabsWidth, bag.panelGeometryInitial.viewTabsWidth) &&
    bag.composerResized !== null &&
    bag.composerResized.composerHeight >= 147 &&
    bag.composerResized.composerHeight <= 149 &&
    bag.composerResized.composerOverlayReady &&
    bag.composerResized.composerContained &&
    nearPanelValue(bag.composerResized.composerFooterBottomGap, 10) &&
    bag.composerResized.mainHeight >= 220 &&
    bag.composerReset !== null &&
    nearPanelValue(bag.composerReset.composerHeight, 112) &&
    nearPanelValue(bag.composerReset.composerDividerTop, bag.composerReset.composerTop - 5) &&
    bag.cornerResized !== null &&
    bag.cornerResized.informationWidth >= 289 &&
    bag.cornerResized.informationWidth <= 291 &&
    bag.cornerResized.composerHeight >= 141 &&
    bag.cornerResized.composerHeight <= 143 &&
    bag.cornerResized.resizeCornerCenterX !== null &&
    bag.cornerResized.resizeCornerCenterY !== null &&
    nearPanelValue(
      bag.cornerResized.resizeCornerCenterX,
      bag.cornerResized.mainRight + bag.initial.windowGap / 2,
    ) &&
    nearPanelValue(bag.cornerResized.resizeCornerCenterY, bag.cornerResized.composerTop - 2.5) &&
    bag.cornerReset !== null &&
    nearPanelValue(bag.cornerReset.informationWidth, 260) &&
    nearPanelValue(bag.cornerReset.composerHeight, 112)
}

/** 执行 panels 验收套件第 8 阶段。 */
export async function runPanelsStep8(bag: LocalVerifyState): Promise<void> {
  console.log('desktop-shell-verify-local: panel-geometry', {
    navigationCollapsedReady: bag.navigationCollapsedReady,
    navigationExpandedReady: bag.navigationExpandedReady,
    informationCollapsedReady: bag.informationCollapsedReady,
    informationExpandedReady: bag.informationExpandedReady,
    navigationResized: bag.navigationResized,
    informationResized: bag.informationResized,
    composerResized: bag.composerResized,
    composerReset: bag.composerReset,
    cornerResized: bag.cornerResized,
    cornerReset: bag.cornerReset,
  })
  bag.composerVisibilityReady = (await bag.bridge.win.webContents.executeJavaScript(
    PANELS_SCRIPT_5,
  )) as boolean
}

async function ensurePanelsComposerReadings(bag: LocalVerifyState): Promise<void> {
  const existing = (await bag.bridge.win.webContents.executeJavaScript(
    `document.querySelector('[data-composer-readings]') !== null`,
  )) as boolean
  if (existing) return
  const activeSessionId = (await bag.bridge.win.webContents.executeJavaScript(
    `document.querySelector('.composer-card')?.getAttribute('data-session-id') ?? null`,
  )) as string | null
  if (activeSessionId === null || activeSessionId === '') return
  await seedComposerReadings(bag.bridge.win, activeSessionId, frame => {
    bag.bridge.win.webContents.send(bag.bridge.hostChannels.sessionFrame, frame)
  })
}

/** 运行 panels 验收套件。 */
export async function runPanelsSuite(bag: LocalVerifyState): Promise<void> {
  await ensureInitialShellSampled(bag)
  await ensurePanelsComposerReadings(bag)
  await runPanelsStep1(bag)
  await runPanelsStep2(bag)
  await runPanelsStep3(bag)
  await runPanelsStep4(bag)
  await runPanelsStep5(bag)
  await runPanelsStep6(bag)
  await runPanelsStep7(bag)
  await runPanelsStep8(bag)
  assertSuiteInvariants('panels', bag)
}
