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

const LEAVING_ANCESTOR_SELECTOR =
  '.ant-modal, .ant-modal-wrap, .ant-modal-mask, [role="dialog"], [data-anchored-menu], .settings-dialog, .session-search-dialog, .ant-select-dropdown, .ant-dropdown, .ant-picker-dropdown, .ant-popover'

function buildTargetCandidateHelperScript(selector: string): string {
  return `
    const selector = ${JSON.stringify(selector)}
    const leaveClassPattern = /(?:^|\\s)[^\\s]+-leave(?:-(?:prepare|start|active))?(?:\\s|$)/
    const enterClassPattern = /(?:^|\\s)ant-[^\\s]+-(?:appear|enter)(?:-(?:prepare|start|active))?(?:\\s|$)/
    const serializeRect = rect =>
      typeof rect.toJSON === 'function'
        ? rect.toJSON()
        : { x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left }
    const isLeaving = node => {
      for (let current = node; current instanceof Element; current = current.parentElement) {
        if (current.hasAttribute('inert')) return true
        if (current instanceof HTMLElement && current.matches(${JSON.stringify(LEAVING_ANCESTOR_SELECTOR)})) {
          if (typeof current.className === 'string' && leaveClassPattern.test(current.className)) return true
          if (current.dataset.menuMotion === 'closing') return true
        }
      }
      return false
    }
    const isElementAlive = node => {
      if (!(node instanceof HTMLElement) || !node.isConnected) return false
      if (!node.checkVisibility() || node.getClientRects().length === 0) return false
      if (isLeaving(node)) return false
      const rect = node.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }
    const findCandidate = () =>
      [...document.querySelectorAll(selector)].find(node => isElementAlive(node)) ?? null
  `
}

function buildPopupSettleHelperScript(): string {
  return `
    const waitForPopupSettled = async element => {
      const popup = element.closest(${JSON.stringify(POPUP_CONTAINER_SELECTOR)})
      if (!(popup instanceof HTMLElement)) return isElementAlive(element)
      const hasEnterMotion = () =>
        typeof popup.className === 'string' && enterClassPattern.test(popup.className)
      await Promise.race([
        new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        new Promise(resolve => setTimeout(resolve, 200)),
      ])
      if (!isElementAlive(element)) return false
      const deadline = Date.now() + 2500
      while (Date.now() < deadline) {
        if (!isElementAlive(element)) return false
        const animations = typeof popup.getAnimations === 'function' ? popup.getAnimations({ subtree: true }) : []
        const running = animations.filter(animation =>
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
        if (!hasEnterMotion() && !morphActive && (Number.isNaN(opacity) || opacity >= 0.99)) {
          return isElementAlive(element)
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return isElementAlive(element)
    }
  `
}

function buildStableHitHelperScript(): string {
  return `
    const waitForStableHit = async element => {
      let blockedBy
      let previousPoint
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (!isElementAlive(element)) {
          return {
            status: 'rebind',
            reason: {
              connected: element.isConnected,
              leaving: isLeaving(element),
              bounds: serializeRect(element.getBoundingClientRect()),
            },
          }
        }
        const rect = element.getBoundingClientRect()
        const point = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
        const hit = document.elementFromPoint(point.x, point.y)
        // 所有目标都要复核实际命中；窗口改尺寸时还需确认坐标已经连续两次稳定。
        if (element.contains(hit) && previousPoint?.x === point.x && previousPoint?.y === point.y) {
          return { status: 'hit', point }
        }
        blockedBy = { point, bounds: serializeRect(rect), hit: hit?.outerHTML.slice(0, 240) }
        previousPoint = point
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return { status: 'blocked', blockedBy }
    }
  `
}

/**
 * 构造在页面内解析并等待可点击目标的脚本。
 * 弹层（含 AntD @rc-component/motion 的 prepare -> start -> active 状态机）在离屏 Chromium 中
 * 可能晚数帧才启动入场动画；必须跳过处于退场动画的旧弹层，并在目标于等待期间断连、隐藏、
 * 宽高归零或转入退场态时重新绑定新节点，待入场落稳且连续命中后再返回点击坐标。
 */
export function buildTrustedClickTargetScript(selector: string): string {
  return `(async () => {
    ${buildTargetCandidateHelperScript(selector)}
    ${buildPopupSettleHelperScript()}
    ${buildStableHitHelperScript()}
    // 菜单挂载晚于触发点击；工作标签保留隐藏 DOM，连开弹层时还可能并存退场节点，须动态重绑有效目标。
    const overallDeadline = Date.now() + 6500
    let lastLostReason = null
    for (let rebind = 0; rebind < 6 && Date.now() < overallDeadline; rebind += 1) {
      const findDeadline = Math.min(overallDeadline, Date.now() + 2000)
      let element = null
      while (Date.now() < findDeadline) {
        element = findCandidate()
        if (element !== null) break
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      if (element === null) break
      if (element instanceof HTMLButtonElement && element.disabled) {
        throw new Error('验收目标处于禁用状态：' + selector)
      }
      // 更改和提交各自滚动，点击列表动作前先把目标滚入所在视口。
      if (element.closest('.scm-pane-content'))
        element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
      // 原生点击使用窗口坐标；弹层缩放或入场尚未结束时，旧坐标会落到另一项菜单或被切帧吞掉。
      if (!(await waitForPopupSettled(element))) {
        lastLostReason = {
          stage: 'popup-settle',
          connected: element.isConnected,
          leaving: isLeaving(element),
          bounds: serializeRect(element.getBoundingClientRect()),
        }
        await new Promise(resolve => setTimeout(resolve, 25))
        continue
      }
      // 弹层动画结束与命中区域更新可能不在同一帧；等待真实命中目标，不能穿透遮挡点击。
      const result = await waitForStableHit(element)
      if (result.status === 'hit') return result.point
      if (result.status === 'rebind') {
        lastLostReason = { stage: 'hit-test', ...result.reason }
        await new Promise(resolve => setTimeout(resolve, 25))
        continue
      }
      throw new Error('验收目标被其他元素遮挡：' + selector + '；' + JSON.stringify(result.blockedBy))
    }
    const menus = [...document.querySelectorAll('[role="menu"]')]
      .filter(node => node.checkVisibility()).map(node => node.getAttribute('aria-label'))
    const suffix = lastLostReason === null ? '' : '；目标失效详情：' + JSON.stringify(lastLostReason)
    throw new Error('找不到可点击的验收目标：' + selector + '；可见菜单：' + JSON.stringify(menus) + suffix)
  })()`
}

export async function clickTrustedElement(win: BrowserWindow, selector: string): Promise<void> {
  // 分隔胶囊在悬停后才接收鼠标事件；先移入未退场的有效目标，再检查实际命中。
  const hoverPoint = (await win.webContents.executeJavaScript(`(() => {
    ${buildTargetCandidateHelperScript(selector)}
    const element = findCandidate()
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
