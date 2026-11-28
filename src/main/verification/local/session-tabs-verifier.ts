/**
 * 顶部会话液态标签运动、窄屏缩放、无障碍降级、拖拽重排与溢出滚动验收器。
 */
import { writeFileSync } from 'node:fs'
import { nativeTheme } from 'electron'
import {
  captureVerifiedPage,
  clickTrustedElement,
  dragTrustedElementHorizontally,
  emulateVerificationMedia,
} from '../desktop-verifier.ts'
import {
  settleElementAnimations,
  waitForNativeTheme,
  waitForWindowSize,
} from '../host-verify-context.ts'
import { verifyTabEdgeMotion } from '../interaction-polish-verifier.ts'
import { seedComposerReadings } from '../session-projection-fixture.ts'
import { verifyTabOverflow } from '../tab-overflow-verifier.ts'
import { verifyWindowControls } from '../window-verifier.ts'
import {
  ACCESSIBLE_TAB_MATERIAL_PROBE,
  COMPACT_SIDEBAR_SEARCH_PROBE,
  EXPANDED_SESSION_CHROME_PROBE,
  LIQUID_TAB_MOTION_PROBE,
  NARROW_TAB_LENS_ALIGNMENT_PROBE,
  RESET_TAB_STRIP_FLEX_PROBE,
  TAB_LENS_PRESS_PROBE,
  TAB_STRIP_OVERFLOW_END_PROBE,
  TAB_STRIP_OVERFLOW_START_PROBE,
  buildSingleTabImmersionProbe,
} from './session-probes.ts'
import type { LocalVerifyState } from './state.ts'

function hasTwoActivePeerTabs(state: LocalVerifyState): boolean {
  return (
    state.originalSessionTab !== null &&
    state.otherSessionTab !== null &&
    state.otherSessionTab !== state.originalSessionTab
  )
}

/** 验证液态玻璃透镜跟随、边缘碰撞与长按形变。 */
export async function verifyLiquidTabMotionAndPress(state: LocalVerifyState): Promise<void> {
  if (!hasTwoActivePeerTabs(state)) return
  const motionCheck = state.bridge.win.webContents.executeJavaScript(
    LIQUID_TAB_MOTION_PROBE,
  ) as Promise<{ ready: boolean }>
  writeFileSync(
    state.bridge.artifactPath('verify-session-tabs-moving.png'),
    (await captureVerifiedPage(state.bridge.win)).toPNG(),
  )
  state.liquidMotionState = await motionCheck
  await verifyTabEdgeMotion(state.bridge.win)

  state.pressPoint = (await state.bridge.win.webContents.executeJavaScript(`(() => {
    const rect = document.querySelector('.session-tab[aria-selected="true"]').getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  })()`)) as { x: number; y: number }
  state.longPressReady = false
  state.bridge.win.webContents.sendInputEvent({
    type: 'mouseDown',
    ...state.pressPoint,
    button: 'left',
    clickCount: 1,
  })
  try {
    state.longPressReady = (await state.bridge.win.webContents.executeJavaScript(
      TAB_LENS_PRESS_PROBE,
    )) as boolean
    writeFileSync(
      state.bridge.artifactPath('verify-session-tabs-pressed.png'),
      (await captureVerifiedPage(state.bridge.win)).toPNG(),
    )
  } finally {
    state.bridge.win.webContents.sendInputEvent({
      type: 'mouseUp',
      ...state.pressPoint,
      button: 'left',
      clickCount: 1,
    })
  }
  await state.bridge.win.webContents.executeJavaScript(`(async () => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const lens = document.querySelector('.session-tab-lens')
      if (lens instanceof HTMLElement
        && lens.dataset.pressed === undefined
        && lens.dataset.moving === undefined
        && Math.abs(lens.getBoundingClientRect().height - 26) < 0.1) return
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  })()`)
  state.liquidMotionReady = state.liquidMotionState.ready && state.longPressReady
  console.log('desktop-shell-verify-local: liquid-motion-geometry', state.liquidMotionState)

  state.peerSessionConversationReady = (await state.bridge.win.webContents.executeJavaScript(
    `document.querySelector('[data-view="conversation"]')?.getAttribute('aria-current') === 'page' && document.querySelector('.main-island .composer-card') !== null`,
  )) as boolean
  state.expandedTabsReady = (await state.bridge.win.webContents.executeJavaScript(
    EXPANDED_SESSION_CHROME_PROBE,
  )) as boolean
  await seedComposerReadings(state.bridge.win, state.peerSession, frame => {
    state.bridge.win.webContents.send(state.bridge.hostChannels.sessionFrame, frame)
  })
  const hasHud = await state.bridge.win.webContents.executeJavaScript(
    'document.querySelector("[data-composer-readings]") !== null',
  )
  if (!hasHud) throw new Error('右栏展开时也应保留底部会话仪表盘')
  writeFileSync(
    state.bridge.artifactPath('verify-session-tabs.png'),
    (await captureVerifiedPage(state.bridge.win)).toPNG(),
  )
}

/** 验证会话标签在明暗主题、1440px、900px 与 725px 超窄视口下的对齐与响应式收敛。 */
export async function verifySessionTabResponsiveSizes(state: LocalVerifyState): Promise<void> {
  if (!hasTwoActivePeerTabs(state)) return
  const tabTheme = nativeTheme.themeSource
  const tabSize = state.bridge.win.getSize()
  const tabMinimumSize = state.bridge.win.getMinimumSize()
  try {
    nativeTheme.themeSource = 'light'
    await waitForNativeTheme(state.bridge.win, 'light')
    await verifyWindowControls(state.bridge.win, false)
    writeFileSync(
      state.bridge.artifactPath('verify-session-tabs-light.png'),
      (await captureVerifiedPage(state.bridge.win)).toPNG(),
    )
    nativeTheme.themeSource = 'dark'
    state.bridge.win.setSize(1_440, 900)
    await waitForNativeTheme(state.bridge.win, 'dark')
    await waitForWindowSize(state.bridge.win, 1_440, 900)
    await verifyWindowControls(state.bridge.win, false)
    writeFileSync(
      state.bridge.artifactPath('verify-session-tabs-dark-large.png'),
      (await captureVerifiedPage(state.bridge.win)).toPNG(),
    )
    state.bridge.win.setSize(900, 600)
    const resizedTab = (await state.bridge.win.webContents.executeJavaScript(
      NARROW_TAB_LENS_ALIGNMENT_PROBE,
    )) as { ready: boolean }
    console.log('desktop-shell-verify-local: liquid-resize', resizedTab)
    await new Promise(resolve => {
      setTimeout(resolve, 100)
    })
    const narrowReadings = (await state.bridge.win.webContents.executeJavaScript(`(() => {
      const hud = document.querySelector('[data-composer-readings]')
      if (!(hud instanceof HTMLElement)) return false
      const label = hud.querySelector('span')
      return label !== null && getComputedStyle(label).display !== 'none'
    })()`)) as boolean
    if (!narrowReadings) throw new Error('窄窗口应照常显示完整的底部会话读数')
    await verifyWindowControls(state.bridge.win, false)
    writeFileSync(
      state.bridge.artifactPath('verify-session-tabs-narrow.png'),
      (await captureVerifiedPage(state.bridge.win)).toPNG(),
    )
    if (!resizedTab.ready) throw new Error('缩小窗口后会话透镜未对齐当前标签')

    state.bridge.win.setMinimumSize(725, 600)
    state.bridge.win.setSize(725, 800)
    const compactProject = (await state.bridge.win.webContents.executeJavaScript(
      COMPACT_SIDEBAR_SEARCH_PROBE,
    )) as { ready: boolean }
    console.log('desktop-shell-verify-local: compact-project', compactProject)
    if (!compactProject.ready) throw new Error('725px 窄视口应隐藏项目选择器并完整保留搜索入口')
    writeFileSync(
      state.bridge.artifactPath('verify-session-tabs-compact.png'),
      (await captureVerifiedPage(state.bridge.win)).toPNG(),
    )
  } finally {
    nativeTheme.themeSource = tabTheme
    state.bridge.win.setMinimumSize(tabMinimumSize[0] ?? 900, tabMinimumSize[1] ?? 600)
    state.bridge.win.setSize(tabSize[0] ?? 1_280, tabSize[1] ?? 800)
    await waitForNativeTheme(state.bridge.win, nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
    await waitForWindowSize(state.bridge.win, tabSize[0] ?? 1_280, tabSize[1] ?? 800)
  }
}

/** 验证减少动态效果、减少透明度、高对比度与强制色彩下的标签无障碍降级。 */
export async function verifySessionTabAccessibilityMedia(state: LocalVerifyState): Promise<void> {
  if (!hasTwoActivePeerTabs(state)) return
  state.reducedMotionReady = false
  state.accessibleMaterialReady = true
  if (!state.bridge.win.webContents.debugger.isAttached()) {
    state.bridge.win.webContents.debugger.attach('1.3')
  }
  try {
    await emulateVerificationMedia(state.bridge.win, [
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ])
    await clickTrustedElement(state.bridge.win, state.originalSelector)
    state.reducedMotionReady = (await state.bridge.win.webContents.executeJavaScript(`(() => {
      const lens = document.querySelector('.session-tab-lens')
      const active = document.querySelector('.session-tab-shell[data-selected="true"]')
      return matchMedia('(prefers-reduced-motion: reduce)').matches
        && lens.getAnimations().every(animation => animation.playState !== 'running')
        && lens.dataset.moving === undefined
        && Math.abs(lens.getBoundingClientRect().height - 26) < .1
        && Math.abs(lens.getBoundingClientRect().left - active.getBoundingClientRect().left) <= 1
    })()`)) as boolean
    const originalView = (await state.bridge.win.webContents.executeJavaScript(
      `document.querySelector('.conversation-view-tabs [aria-selected="true"]').dataset.view`,
    )) as string
    await clickTrustedElement(
      state.bridge.win,
      originalView === 'trajectory'
        ? '.conversation-view-tabs [data-view="conversation"]'
        : '.conversation-view-tabs [data-view="trajectory"]',
    )
    state.reducedMotionReady =
      state.reducedMotionReady &&
      ((await state.bridge.win.webContents.executeJavaScript(`(() => {
        const targets = document.querySelectorAll('.app-shell, .session-chrome, .view-tabs__indicator, .main-island > :not([hidden])')
        return [...targets].every(element => element.getAnimations().every(animation => animation.playState !== 'running'))
          && getComputedStyle(document.querySelector('.app-shell')).transitionDuration === '0s'
      })()`)) as boolean)
    await clickTrustedElement(
      state.bridge.win,
      `.conversation-view-tabs [data-view="${originalView}"]`,
    )
    /* oxlint-disable no-await-in-loop -- 媒体设置作用于同一渲染进程，必须串行验收。 */
    for (const [name, value] of [
      ['prefers-reduced-transparency', 'reduce'],
      ['prefers-contrast', 'more'],
      ['forced-colors', 'active'],
    ] as const) {
      await emulateVerificationMedia(state.bridge.win, [{ name, value }])
      state.accessibleMaterialReady =
        state.accessibleMaterialReady &&
        ((await state.bridge.win.webContents.executeJavaScript(
          ACCESSIBLE_TAB_MATERIAL_PROBE,
        )) as boolean)
    }
    /* oxlint-enable no-await-in-loop */
  } finally {
    await emulateVerificationMedia(state.bridge.win)
  }
  state.sameTabGroup = (await state.bridge.win.webContents
    .executeJavaScript(`document.querySelector(${JSON.stringify(state.originalSelector)}).closest('.session-tab-group')
      === document.querySelector(${JSON.stringify(state.otherSelector)}).closest('.session-tab-group')`)) as boolean
  state.expectedFirst = state.sameTabGroup ? state.otherSessionTab : state.originalSessionTab
  state.expectedSecond = state.sameTabGroup ? state.originalSessionTab : state.otherSessionTab
}

async function verifyTabDragCancelRestore(state: LocalVerifyState): Promise<void> {
  const cancelPoint = (await state.bridge.win.webContents.executeJavaScript(`(() => {
    const rect = document.querySelector(${JSON.stringify(state.originalSelector)}).getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  })()`)) as { x: number; y: number }
  const cancelTargetX = Math.round(
    cancelPoint.x + (state.sameTabGroup ? -state.dragDistance : state.dragDistance),
  )
  state.bridge.win.webContents.sendInputEvent({ type: 'mouseMove', ...cancelPoint })
  state.bridge.win.webContents.sendInputEvent({
    type: 'mouseDown',
    ...cancelPoint,
    button: 'left',
    clickCount: 1,
  })
  state.bridge.win.webContents.sendInputEvent({
    type: 'mouseMove',
    x: cancelTargetX,
    y: cancelPoint.y,
  })
  state.cancelStarted = (await state.bridge.win.webContents.executeJavaScript(`(async () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (document.querySelector('.session-tab-glass')?.dataset.reordering === 'true') return true
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return false
  })()`)) as boolean
  state.bridge.win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  state.bridge.win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  state.bridge.win.webContents.sendInputEvent({
    type: 'mouseUp',
    x: cancelTargetX,
    y: cancelPoint.y,
    button: 'left',
    clickCount: 1,
  })
  state.cancelRestored = (await state.bridge.win.webContents.executeJavaScript(`(async () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const tabs = [...document.querySelectorAll('.session-tab')]
      if (tabs[0]?.dataset.sessionTab === ${JSON.stringify(state.expectedFirst)}
        && tabs[1]?.dataset.sessionTab === ${JSON.stringify(state.expectedSecond)}
        && document.querySelector('[data-reordering], [data-dragging]') === null) return true
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return false
  })()`)) as boolean
  state.dragReady = state.reorderReady && state.cancelStarted && state.cancelRestored
}

/** 验证会话标签拖拽排序、Esc 取消复位与等分铺满。 */
export async function verifySessionTabReorderAndFill(state: LocalVerifyState): Promise<void> {
  if (!hasTwoActivePeerTabs(state)) return
  state.dragDistance = (await state.bridge.win.webContents.executeJavaScript(`(() => {
    const from = document.querySelector(${JSON.stringify(state.originalSelector)}).getBoundingClientRect()
    const to = document.querySelector(${JSON.stringify(state.otherSelector)}).getBoundingClientRect()
    return to.left - from.left
  })()`)) as number
  await dragTrustedElementHorizontally(state.bridge.win, state.originalSelector, state.dragDistance)
  state.reorderReady = (await state.bridge.win.webContents.executeJavaScript(`(() => {
    const tabs = [...document.querySelectorAll('.session-tab')]
    return tabs[0]?.dataset.sessionTab === ${JSON.stringify(state.expectedFirst)}
      && tabs[1]?.dataset.sessionTab === ${JSON.stringify(state.expectedSecond)}
      && document.querySelector(${JSON.stringify(state.originalSelector)}).getAttribute('aria-selected') === 'true'
      && document.querySelector('[data-reordering], [data-dragging]') === null
  })()`)) as boolean
  await verifyTabDragCancelRestore(state)

  const readTabsFill = async (): Promise<boolean> =>
    (await state.bridge.win.webContents.executeJavaScript(`(() => {
      const strip = document.querySelector('.session-tabs')
      const tabs = [...document.querySelectorAll('.session-tab-shell')]
      if (!(strip instanceof HTMLElement) || tabs.length !== 2) return false
      const style = getComputedStyle(strip)
      const contentWidth = strip.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight)
      return tabs.every(tab => Math.abs(tab.getBoundingClientRect().width - contentWidth / tabs.length) < 1)
        && Math.abs(tabs.reduce((total, tab) => total + tab.getBoundingClientRect().width, 0) - contentWidth) < 1
        && strip.scrollWidth <= strip.clientWidth + 1
    })()`)) as boolean
  state.expandedTabsFill = await readTabsFill()
  await clickTrustedElement(state.bridge.win, '.panel-divider--navigation .panel-divider__capsule')
  await settleElementAnimations(state.bridge.win, '.app-shell')
  state.collapsedTabsFill = await readTabsFill()
  await verifyWindowControls(state.bridge.win, false)
  await clickTrustedElement(state.bridge.win, '.panel-divider--navigation .panel-divider__capsule')
  await settleElementAnimations(state.bridge.win, '.app-shell')
  state.tabsFillReady = state.expandedTabsFill && state.collapsedTabsFill
}

async function verifyNarrowTabStripScrollButtons(state: LocalVerifyState): Promise<void> {
  state.tabOverflowReady = false
  await state.bridge.win.webContents.executeJavaScript(
    `document.querySelector('.session-tabs-frame').style.flex = '0 0 180px'`,
  )
  try {
    const overflowStartReady = (await state.bridge.win.webContents.executeJavaScript(
      TAB_STRIP_OVERFLOW_START_PROBE,
    )) as boolean
    if (!overflowStartReady) return
    await clickTrustedElement(state.bridge.win, '.session-tab-scroll--right')
    const overflowEndReady = (await state.bridge.win.webContents.executeJavaScript(
      TAB_STRIP_OVERFLOW_END_PROBE,
    )) as boolean
    if (!overflowEndReady) return
    await clickTrustedElement(state.bridge.win, '.session-tab-scroll--left')
    state.tabOverflowReady = (await state.bridge.win.webContents.executeJavaScript(`(async () => {
      const deadline = performance.now() + 1000
      while (performance.now() < deadline) {
        await new Promise(resolve => requestAnimationFrame(resolve))
        const strip = document.querySelector('.session-tabs')
        const left = document.querySelector('.session-tab-scroll--left')
        if (strip.scrollLeft <= 1 && left.disabled) return true
      }
      return false
    })()`)) as boolean
  } finally {
    await state.bridge.win.webContents.executeJavaScript(RESET_TAB_STRIP_FLEX_PROBE)
  }
}

/** 验证标签溢出左右翻页按钮、平铺总览与关闭第二个标签回到单标签沉浸态。 */
export async function verifySessionTabOverflowAndClose(state: LocalVerifyState): Promise<void> {
  if (hasTwoActivePeerTabs(state)) {
    await verifyNarrowTabStripScrollButtons(state)

    const overflowScheme = state.bridge.settingsStore.read().colorScheme
    try {
      await verifyTabOverflow(
        state.bridge.win,
        scheme => {
          state.bridge.settingsController.publish(
            state.bridge.settingsStore.update({ colorScheme: scheme }),
          )
        },
        async name => {
          writeFileSync(
            state.bridge.artifactPath(name),
            (await captureVerifiedPage(state.bridge.win)).toPNG(),
          )
        },
      )
    } finally {
      state.bridge.settingsController.publish(
        state.bridge.settingsStore.update({ colorScheme: overflowScheme }),
      )
    }

    await clickTrustedElement(state.bridge.win, state.otherSelector)
    await clickTrustedElement(
      state.bridge.win,
      '.session-tab-shell[data-selected="true"] .session-tab-close',
    )
    await settleElementAnimations(state.bridge.win, '.app-shell')
    state.sessionTabsReady =
      state.liquidMotionReady &&
      state.reducedMotionReady &&
      state.accessibleMaterialReady &&
      state.dragReady &&
      state.expandedTabsReady &&
      state.tabsFillReady &&
      state.tabOverflowReady &&
      state.conversationRestored &&
      state.otherSessionRightRestored &&
      state.peerSessionConversationReady &&
      ((await state.bridge.win.webContents.executeJavaScript(
        buildSingleTabImmersionProbe(state.originalSessionTab, state.otherSelector),
      )) as boolean)
  }

  console.log('desktop-shell-verify-local: session-tabs', state.sessionTabsReady)
  await verifyWindowControls(state.bridge.win, false)
  if (state.originalSessionTab !== null) {
    await seedComposerReadings(state.bridge.win, state.originalSessionTab, frame => {
      state.bridge.win.webContents.send(state.bridge.hostChannels.sessionFrame, frame)
    })
  }
}
