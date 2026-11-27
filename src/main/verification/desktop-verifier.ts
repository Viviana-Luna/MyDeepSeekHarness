import type { BrowserWindow, NativeImage, Rectangle } from 'electron'
import { pollRenderer } from './verification-wait.ts'

export type VerifyStage = 'initializing' | 'startup' | 'host' | 'settings' | 'complete'

export interface VerifyReport {
  verificationStage: VerifyStage
  hostReady: boolean
  startupScreen?: boolean
  startupCapture?: string
  startupDarkCapture?: string
  appMounted: boolean
  uiActive: boolean
  frame: boolean
  islandCount: number
  canvasCount: number
  pageScrollable: boolean
  shellPinnedToViewport?: boolean
  transparentRoots: boolean
  settingsDialog: boolean
  settingsFocusInside: boolean
  settingsLayerCount: number
  settingsAccent: string
  settingsCanvasOpacity: string
  settingsCanvasAlpha: number
  settingsCanvasImageApplied: boolean
  canvasColorSchemeReady?: boolean
  mediumCanvasReady?: boolean
  topControlsReadable?: boolean
  clearCanvasReady?: boolean
  nativeWindowClipReady?: boolean
  settingsPanelFits: boolean
  settingsPagesReady?: boolean
  islandGapSettingReady?: boolean
  appearanceCapture?: string
  appearanceBackgroundsCapture?: string
  modelsCapture?: string
  modelMenuCapture?: string
  modelMenuReady?: boolean
  pluginsCapture?: string
  automationCapture?: string
  automationSettingsReady?: boolean
  sessionInfoReady?: boolean
  hostSettingsEventsReady?: boolean
  presetsCapture?: string
  frameOpacity: string
  islandsOpaque: boolean
  uiDensityReady?: boolean
  uiBodyFontSize?: string
  uiBodyFontWeight?: string
  uiProjectActionHeight?: number
  uiTabHeight?: number
  uiFontScaleReady?: boolean
  editorAppearanceReady?: boolean
  uiAccentContrastReady?: boolean
  trajectoryFocusReady?: boolean
  titlebarClearanceReady?: boolean
  windowControlsReady?: boolean
  islandTop?: number
  topToolbarReady?: boolean
  toolbarSidebarAligned?: boolean
  panelCapsulesReady?: boolean
  panelCollapseReady?: boolean
  panelResizeReady?: boolean
  panelDragLineReady?: boolean
  projectGroupingReady?: boolean
  sessionActionsReady?: boolean
  sessionActionsCapture?: string
  sessionSearchReady?: boolean
  sessionTabsReady?: boolean
  sessionStreamReady?: boolean
  hostEventStreamReady?: boolean
  sessionCostRemoved?: boolean
  fileReferenceReady?: boolean
  searchCapture?: string
  zoomFactor?: number
  nativeSettingsTrigger: boolean
  nativeSettingsDialog: boolean
  nativeSettingsSidebarRaised: boolean
  nativeSettingsTopmost: boolean
  nativeAppearanceEntry: boolean
  nativeAppearanceEntryPlaced: boolean
  productName?: string
  productVersion?: string
  singleInstanceLock?: boolean
  backgroundVerification?: boolean
  nativeFullscreenChecked?: boolean
  updateMenu?: boolean
  ownership?: 'external' | 'spawned-by-desktop'
  reportedVersion?: string
  settingsRevision?: number
  settingsPersisted?: boolean
  fileTreeReady?: boolean
  deepFileTreeReady?: boolean
  fileViewerReady?: boolean
  fileEditorReady?: boolean
  fileCursorReady?: boolean
  fileUnsavedGuardReady?: boolean
  contentSearchReady?: boolean
  projectTasksOnlyReady?: boolean
  imageViewerReady?: boolean
  syntaxHighlightingReady?: boolean
  quickOpenReady?: boolean
  taskSuggestionsReady?: boolean
  projectTasksReady?: boolean
  composerVisibilityReady?: boolean
  terminalReady?: boolean
  sourceControlReady?: boolean
  sourceControlWriteReady?: boolean
  sourceControlFailureReady?: boolean
  uncommittedChangesReady?: boolean
  contextualRightPanelReady?: boolean
  diffResponsiveReady?: boolean
  pendingInteractionsReady?: boolean
  fileCapture?: string
  diffCapture?: string
  appearanceMenu: boolean
  appearanceAccelerator: string
  capture: string
  darkCapture: string
  darkSettingsReadable: boolean
  largeCapture: string
  largeLayoutStable: boolean
  mediumToolbarStable?: boolean
  narrowCapture: string
  narrowSettingsFits: boolean
  narrowRightPanelHidden?: boolean
  nativeCapture: string
  clearCapture: string
  blank: boolean
  nativeWindow?: {
    platform: NodeJS.Platform
    transparent: boolean
    transparentPixelRatio: number
    canvasComposition?: import('../../shared/window.ts').DesktopCanvasComposition
  }
  error?: string
}

export function createFailedVerifyReport(
  verificationStage: VerifyStage,
  error: unknown,
  hostReady: boolean,
): VerifyReport {
  return {
    verificationStage,
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

function sendTrustedClick(win: BrowserWindow, point: { x: number; y: number }): void {
  win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
  win.webContents.sendInputEvent({
    type: 'mouseDown',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  })
  win.webContents.sendInputEvent({
    type: 'mouseUp',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  })
}

/** 隐藏窗口调整尺寸后 Viz 可能暂时没有可复制的帧；只重试这一瞬态错误。 */
export async function captureVerifiedPage(
  win: BrowserWindow,
  bounds?: Rectangle,
): Promise<NativeImage> {
  /* oxlint-disable no-await-in-loop -- 同一窗口截图必须串行，瞬态错误最多重试五次。 */
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await win.webContents.capturePage(bounds, {
        stayHidden: !win.isVisible(),
        stayAwake: true,
      })
    } catch (error) {
      if (attempt === 5 || !(error instanceof Error) || error.message !== 'UnknownVizError')
        throw error
      await new Promise(resolve => {
        setTimeout(resolve, 150)
      })
    }
  }
  /* oxlint-enable no-await-in-loop */
  throw new Error('无法取得真实窗口验收截图')
}

/** 普通视觉与无障碍降级分别验收，不继承 CI 桌面的减少透明度等系统偏好。 */
export async function emulateVerificationMedia(
  win: BrowserWindow,
  overrides: Array<{ name: string; value: string }> = [],
): Promise<void> {
  if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3')
  const baseline = [
    { name: 'prefers-reduced-motion', value: 'no-preference' },
    { name: 'prefers-reduced-transparency', value: 'no-preference' },
    { name: 'prefers-contrast', value: 'no-preference' },
    { name: 'forced-colors', value: 'none' },
  ]
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [
      ...baseline.filter(feature => !overrides.some(override => override.name === feature.name)),
      ...overrides,
    ],
  })
}

const POPUP_CONTAINER_SELECTOR =
  '[data-anchored-menu], .settings-dialog, .session-search-dialog, .ant-modal, .ant-select-dropdown, .ant-dropdown, .ant-picker-dropdown, .ant-popover'

/**
 * 构造在页面内解析并等待可点击目标的脚本。
 * 弹层（含 AntD @rc-component/motion 的 prepare -> start -> active 状态机）在离屏 Chromium 中
 * 可能晚数帧才启动入场动画，必须等入场类名移除、有限动画结束且不透明度落稳后再测量点击坐标。
 */
export function buildTrustedClickTargetScript(selector: string): string {
  return `(async () => {
    // 菜单挂载晚于触发点击；工作标签还会保留隐藏 DOM，必须等待可见目标出现。
    const element = await (async () => {
      for (let attempt = 0; attempt < 80; attempt++) {
        const candidate = [...document.querySelectorAll(${JSON.stringify(selector)})].find(node =>
          node instanceof HTMLElement && node.checkVisibility() && node.getClientRects().length > 0)
        if (candidate instanceof HTMLElement) return candidate
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      const menus = [...document.querySelectorAll('[role="menu"]')]
        .filter(node => node.checkVisibility()).map(node => node.getAttribute('aria-label'))
      throw new Error('找不到可点击的验收目标：' + ${JSON.stringify(selector)} + '；可见菜单：' + JSON.stringify(menus))
    })()
    if (element instanceof HTMLButtonElement && element.disabled) {
      throw new Error('验收目标处于禁用状态：' + ${JSON.stringify(selector)})
    }
    // 更改和提交各自滚动，点击列表动作前先把目标滚入所在视口。
    if (element.closest('.scm-pane-content'))
      element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
    // 原生点击使用窗口坐标；弹层缩放或入场尚未结束时，旧坐标会落到另一项菜单或被切帧吞掉。
    const popup = element.closest(${JSON.stringify(POPUP_CONTAINER_SELECTOR)})
    if (popup instanceof HTMLElement) {
      const hasMotionClass = () =>
        typeof popup.className === 'string' &&
        /(?:^|\\s)ant-[^\\s]+-(?:appear|enter|leave)(?:-(?:prepare|start|active))?(?:\\s|$)/.test(popup.className)
      await Promise.race([
        new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        new Promise(resolve => setTimeout(resolve, 200)),
      ])
      const deadline = Date.now() + 2500
      while (Date.now() < deadline) {
        const running = popup.getAnimations({ subtree: true })
          .filter(animation =>
            animation.playState !== 'finished' &&
            animation.effect?.getComputedTiming().iterations !== Infinity)
        if (running.length > 0) {
          await Promise.race([
            Promise.all(running.map(animation => animation.finished.catch(() => {}))),
            new Promise(resolve => setTimeout(resolve, 250)),
          ])
          continue
        }
        const opacity = Number.parseFloat(getComputedStyle(popup).opacity)
        // 液态形变菜单的 clip-path 动画（450ms）晚于透明代理动画（190ms）结束，必须等待形变落稳。
        const morphActive = popup.dataset.menuMorph === 'active'
        if (!hasMotionClass() && !morphActive && (Number.isNaN(opacity) || opacity >= 0.99)) break
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }
    // 弹层动画结束与命中区域更新可能不在同一帧；等待真实命中目标，不能穿透遮挡点击。
    let blockedBy
    let previousPoint
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const rect = element.getBoundingClientRect()
      const point = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
      const hit = document.elementFromPoint(point.x, point.y)
      // 所有目标都要复核实际命中；窗口改尺寸时还需确认坐标已经连续两次稳定。
      if (element.contains(hit) && previousPoint?.x === point.x && previousPoint?.y === point.y) return point
      blockedBy = { point, bounds: rect.toJSON(), hit: hit?.outerHTML.slice(0, 240) }
      previousPoint = point
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error('验收目标被其他元素遮挡：' + ${JSON.stringify(selector)} + '；' + JSON.stringify(blockedBy))
  })()`
}

export async function clickTrustedElement(win: BrowserWindow, selector: string): Promise<void> {
  // 分隔胶囊在悬停后才接收鼠标事件；先移入目标，再检查实际命中。
  const hoverPoint = (await win.webContents.executeJavaScript(`(() => {
    const element = [...document.querySelectorAll(${JSON.stringify(selector)})].find(node => node.checkVisibility())
    if (!element) return null
    const rect = element.getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  })()`)) as { x: number; y: number } | null
  if (hoverPoint !== null) win.webContents.sendInputEvent({ type: 'mouseMove', ...hoverPoint })
  const point = (await win.webContents.executeJavaScript(
    buildTrustedClickTargetScript(selector),
  )) as { x: number; y: number }
  sendTrustedClick(win, point)
  await new Promise(resolve => {
    setTimeout(resolve, 80)
  })
  if (selector.startsWith('.settings-nav__items')) {
    const selected = await pollRenderer<{
      ready: boolean
      requested?: string | null
      selected?: string | null
    }>(win, {
      probe: `(() => {
        const target = document.querySelector(${JSON.stringify(selector)})
        return {
          ready: target?.classList.contains('ant-menu-item-selected') === true,
          requested: target?.textContent ?? null,
          selected: document.querySelector('.settings-nav__items .ant-menu-item-selected')?.textContent ?? null,
        }
      })()`,
      condition: 'state.ready === true',
      timeoutMs: 1_500,
      intervalMs: 25,
    })
    if (!selected.ok) throw new Error('设置菜单原生点击未选中目标：' + JSON.stringify(selected))
  }
}

export async function dragTrustedElementHorizontally(
  win: BrowserWindow,
  selector: string,
  deltaX: number,
): Promise<void> {
  const point = (await win.webContents.executeJavaScript(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    if (!(element instanceof HTMLElement) || element.getClientRects().length === 0) {
      throw new Error('找不到可拖动的验收目标：' + ${JSON.stringify(selector)})
    }
    const rect = element.getBoundingClientRect()
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + Math.min(34, rect.height * 0.16)),
    }
  })()`)) as { x: number; y: number }
  win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
  win.webContents.sendInputEvent({
    type: 'mouseDown',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  })
  for (const progress of [0.25, 0.5, 0.75, 1]) {
    win.webContents.sendInputEvent({
      type: 'mouseMove',
      x: Math.round(point.x + deltaX * progress),
      y: point.y,
      movementX: Math.round(deltaX / 4),
      movementY: 0,
    })
  }
  win.webContents.sendInputEvent({
    type: 'mouseUp',
    x: point.x + deltaX,
    y: point.y,
    button: 'left',
    clickCount: 1,
  })
  await new Promise(resolve => {
    setTimeout(resolve, 100)
  })
}
