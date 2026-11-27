/**
 * 项目分组、会话操作、会话搜索与液态标签栏动效验收套件（阶段分片 1）。
 */
import { writeFileSync } from 'node:fs'
import { nativeTheme } from 'electron'
import {
  openRightVerificationPanel,
  settleElementAnimations,
  waitForNativeTheme,
  waitForWindowSize,
} from '../host-verify-context.ts'
import {
  captureVerifiedPage,
  clickTrustedElement,
  emulateVerificationMedia,
} from '../desktop-verifier.ts'
import { verifyWindowControls } from '../window-verifier.ts'
import { verifyTabEdgeMotion } from '../interaction-polish-verifier.ts'
import { seedComposerReadings } from '../session-projection-fixture.ts'
import type { LocalVerifyState } from './state.ts'
import {
  SESSIONS_SCRIPT_1,
  buildSessionsScript2,
  buildSessionsScript3,
  SESSIONS_SCRIPT_4,
  SESSIONS_SCRIPT_5,
  buildSessionsScript6,
  buildSessionsScript7,
  buildSessionsScript8,
  SESSIONS_SCRIPT_9,
  SESSIONS_SCRIPT_10,
  SESSIONS_SCRIPT_11,
  SESSIONS_SCRIPT_12,
  SESSIONS_SCRIPT_13,
  SESSIONS_SCRIPT_14,
} from './sessions-scripts.ts'

/** 执行 sessions 验收套件第 1 阶段。 */
export async function runSessionsStep1(bag: LocalVerifyState): Promise<void> {
  bag.projectGroupingReady =
    bag.initial.projectFocused &&
    ((await bag.bridge.win.webContents.executeJavaScript(SESSIONS_SCRIPT_1)) as boolean)
  bag.sessionActionTarget = (await bag.bridge.win.webContents.executeJavaScript(`(() => {
      const row = [...document.querySelectorAll('.project-session-group .session-row-shell')]
        .find(element => element instanceof HTMLElement && element.getClientRects().length > 0)
      return row?.getAttribute('data-session-id') ?? null
    })()`)) as string | null
  bag.sessionActionsReady = bag.sessionActionTarget === null
  bag.sessionActionsCapture = ''
  if (bag.sessionActionTarget !== null) {
    const escapedSessionActionTarget = JSON.stringify(bag.sessionActionTarget)
    await clickTrustedElement(
      bag.bridge.win,
      `.project-session-group .session-row-shell[data-session-id=${escapedSessionActionTarget}] button[aria-label="置顶聊天"]`,
    )
    bag.sessionActionsReady = (await bag.bridge.win.webContents.executeJavaScript(
      buildSessionsScript2(escapedSessionActionTarget),
    )) as boolean
    if (bag.sessionActionsReady) {
      const hoverPoint = (await bag.bridge.win.webContents.executeJavaScript(`(() => {
          const row = document.querySelector('.pinned-session-group .session-row-shell[data-session-id=' + JSON.stringify(${escapedSessionActionTarget}) + ']')
          if (!(row instanceof HTMLElement)) return null
          const rect = row.getBoundingClientRect()
          return { x: Math.round(rect.right - 32), y: Math.round(rect.top + rect.height / 2) }
        })()`)) as { x: number; y: number } | null
      if (hoverPoint !== null) {
        bag.bridge.win.webContents.sendInputEvent({ type: 'mouseMove', ...hoverPoint })
        await new Promise(resolve => {
          setTimeout(resolve, 100)
        })
      }
      bag.sessionActionsCapture = 'verify-session-actions.png'
      writeFileSync(
        bag.bridge.artifactPath(bag.sessionActionsCapture),
        (await captureVerifiedPage(bag.bridge.win)).toPNG(),
      )
    }
    await clickTrustedElement(
      bag.bridge.win,
      `.pinned-session-group .session-row-shell[data-session-id=${escapedSessionActionTarget}] button[aria-label="取消置顶聊天"]`,
    )
    bag.sessionActionsReady =
      bag.sessionActionsReady &&
      ((await bag.bridge.win.webContents.executeJavaScript(
        buildSessionsScript3(escapedSessionActionTarget),
      )) as boolean)
  }
  await clickTrustedElement(bag.bridge.win, '.session-search-trigger')
}

/** 执行 sessions 验收套件第 2 阶段。 */
export async function runSessionsStep2(bag: LocalVerifyState): Promise<void> {
  // SessionSearch 的输入框聚焦在 useEffect 后的下一帧 requestAnimationFrame 执行，且面板带有 360ms 滑入动画；
  // 离屏或高负载环境下必须轮询等待聚焦与动画收敛，避免固定 160ms 误判 inputFocused=false。
  bag.sessionSearchState = (await bag.bridge.win.webContents.executeJavaScript(
    SESSIONS_SCRIPT_4,
  )) as {
    ready: boolean
    expanded: string | null
    dialogPresent: boolean
    closePresent: boolean
    inputFocused: boolean
    resultCount: number
    activeTag?: string | null
    activeClass?: string | null
    documentHasFocus?: boolean
  }
  bag.sessionSearchReady = bag.sessionSearchState.ready
  console.log(
    `desktop-shell-verify-local: session-search ${JSON.stringify(bag.sessionSearchState)}`,
  )
  bag.searchCapture = 'verify-search.png'
  if (bag.sessionSearchState.dialogPresent) {
    writeFileSync(
      bag.bridge.artifactPath(bag.searchCapture),
      (await captureVerifiedPage(bag.bridge.win)).toPNG(),
    )
  }
  if (bag.sessionSearchState.closePresent)
    await clickTrustedElement(bag.bridge.win, '.session-search-close')
  bag.sessionSearchCloseState = (await bag.bridge.win.webContents.executeJavaScript(
    SESSIONS_SCRIPT_5,
  )) as {
    closed: boolean
    dialogAbsent: boolean
    expanded: string | null
    triggerFocused: boolean
    activeTag: string | null
  }
  if (!bag.sessionSearchCloseState.closed) {
    console.log(
      `desktop-shell-verify-local: session-search-close ${JSON.stringify(bag.sessionSearchCloseState)}`,
    )
  }
  bag.sessionSearchReady = bag.sessionSearchReady && bag.sessionSearchCloseState.closed
  bag.originalSessionTab = (await bag.bridge.win.webContents.executeJavaScript(
    `document.querySelector('.session-tab[aria-selected="true"]')?.getAttribute('data-session-tab') ?? null`,
  )) as string | null
  bag.sessionTabsReady = false
}

/** 执行 sessions 验收套件第 3 阶段。 */
export async function runSessionsStep3(bag: LocalVerifyState): Promise<void> {
  if (bag.originalSessionTab === null) return
  bag.originalGroup = (await bag.bridge.win.webContents.executeJavaScript(
    `document.querySelector('.session-tab-group').getAttribute('aria-label')`,
  )) as string
  bag.groupNavigationExpanded = (await bag.bridge.win.webContents.executeJavaScript(
    `document.querySelector('.app-shell').dataset.navigationCollapsed !== 'true'`,
  )) as boolean
  if (!bag.groupNavigationExpanded)
    await clickTrustedElement(bag.bridge.win, '.panel-divider--navigation .panel-divider__capsule')
  await clickTrustedElement(bag.bridge.win, '.session-search-trigger')
  await bag.bridge.win.webContents.executeJavaScript(
    buildSessionsScript6(JSON.stringify(bag.originalGroup)),
  )
  await clickTrustedElement(bag.bridge.win, '#verify-other-group')
  await clickTrustedElement(bag.bridge.win, '.panel-divider--navigation .panel-divider__capsule')
  bag.bridge.win.webContents.send(bag.bridge.hostChannels.hostFrame, {
    type: 'host/session-status',
    sessionId: bag.originalSessionTab,
    running: true,
  })
  bag.bridge.win.webContents.send(bag.bridge.hostChannels.hostFrame, {
    type: 'host/session-status',
    sessionId: bag.originalSessionTab,
    running: false,
  })
  bag.groupNotificationReady = (await bag.bridge.win.webContents.executeJavaScript(`(async () => {
        for (let attempt = 0; attempt < 80; attempt++) {
          if (document.querySelector('.session-group-switcher .session-group-unread')?.textContent === '1') {
            return document.querySelectorAll('.session-tab-group').length === 1
              && ![...document.querySelectorAll('.session-tab')].some(tab => tab.dataset.sessionTab === ${JSON.stringify(bag.originalSessionTab)})
          }
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        return false
      })()`)) as boolean
  bag.waitForOtherSessionGroup = async () =>
    (await bag.bridge.win.webContents.executeJavaScript(`(async () => {
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const option = document.querySelector('.session-group-menu [aria-checked="false"]')
          if (option instanceof HTMLButtonElement && option.getClientRects().length > 0) return true
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        return false
      })()`)) as boolean
  await bag.bridge.win.webContents
    .executeJavaScript(`Promise.all(document.querySelector('.app-shell').getAnimations({ subtree: true })
        .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))`)
  await clickTrustedElement(bag.bridge.win, '.session-group-switcher')
  if (!(await bag.waitForOtherSessionGroup())) throw new Error('标签组菜单没有显示其他项目')
  writeFileSync(
    bag.bridge.artifactPath('verify-session-group-menu.png'),
    (await captureVerifiedPage(bag.bridge.win)).toPNG(),
  )
}

/** 执行 sessions 验收套件第 4 阶段。 */
export async function runSessionsStep4(bag: LocalVerifyState): Promise<void> {
  if (bag.originalSessionTab === null) return
  await clickTrustedElement(bag.bridge.win, '.session-group-menu [aria-checked="false"]')
  bag.groupSwitchReady =
    bag.groupNotificationReady &&
    ((await bag.bridge.win.webContents.executeJavaScript(`(() => {
        return document.querySelector('.session-tab[aria-selected="true"]')?.dataset.sessionTab === ${JSON.stringify(bag.originalSessionTab)}
          && document.querySelector('.session-group-switcher .session-group-unread') === null
          && document.querySelectorAll('.session-tab-group').length === 1
      })()`)) as boolean)
  if (!bag.groupSwitchReady) throw new Error('标签组切换或后台更新提示验收失败')
  await clickTrustedElement(bag.bridge.win, '.session-group-switcher')
  if (!(await bag.waitForOtherSessionGroup())) throw new Error('标签组菜单没有恢复其他项目')
  await clickTrustedElement(bag.bridge.win, '.session-group-menu [aria-checked="false"]')
  await clickTrustedElement(
    bag.bridge.win,
    '.session-tab-shell[data-selected="true"] .session-tab-close',
  )
  if (bag.groupNavigationExpanded)
    await clickTrustedElement(bag.bridge.win, '.panel-divider--navigation .panel-divider__capsule')
  // 同一项目新增一个真实会话，继续验收组内玻璃运动、排序与关闭。
  bag.peerSession = (await bag.bridge.win.webContents.executeJavaScript(
    buildSessionsScript7(
      JSON.stringify(bag.originalSessionTab),
      JSON.stringify(bag.originalSessionTab),
    ),
  )) as string
  await clickTrustedElement(bag.bridge.win, '.session-search-trigger')
  await bag.bridge.win.webContents.executeJavaScript(`(async () => {
        for (let attempt = 0; attempt < 80; attempt++) {
          const result = [...document.querySelectorAll('.session-search-result')].find(button => button.querySelector('strong')?.textContent === '标签交互验收')
          if (result) { result.id = 'verify-peer-session'; return }
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        throw new Error('新建的同项目会话未出现在搜索结果中')
      })()`)
  await clickTrustedElement(bag.bridge.win, '#verify-peer-session')
  await settleElementAnimations(bag.bridge.win, '.app-shell')
  bag.otherSessionTab = (await bag.bridge.win.webContents.executeJavaScript(
    `document.querySelector('.session-tab[aria-selected="true"]')?.getAttribute('data-session-tab') ?? null`,
  )) as string | null
  if (bag.otherSessionTab !== bag.peerSession) throw new Error('没有打开同项目验收会话')
}

/** 执行 sessions 验收套件第 5 阶段。 */
export async function runSessionsStep5(bag: LocalVerifyState): Promise<void> {
  if (
    bag.originalSessionTab === null ||
    bag.otherSessionTab === null ||
    bag.otherSessionTab === bag.originalSessionTab
  )
    return
  bag.originalSelector = `.session-tab[data-session-tab=${JSON.stringify(bag.originalSessionTab)}]`
  bag.otherSelector = `.session-tab[data-session-tab=${JSON.stringify(bag.otherSessionTab)}]`
  bag.rightCollapsed = (await bag.bridge.win.webContents.executeJavaScript(
    `document.querySelector('.app-shell')?.dataset.informationCollapsed === 'true'`,
  )) as boolean
  if (bag.rightCollapsed) await clickTrustedElement(bag.bridge.win, '[aria-label="展开右侧浮岛"]')
  bag.rightSelectorReady = (await bag.bridge.win.webContents.executeJavaScript(`(async () => {
          for (let attempt = 0; attempt < 80; attempt += 1) {
            const selector = document.querySelector('.right-island-tabs')
            if (selector instanceof HTMLElement && selector.getClientRects().length > 0) return true
            await new Promise(resolve => setTimeout(resolve, 25))
          }
          return false
        })()`)) as boolean
  if (!bag.rightSelectorReady) {
    const state = await bag.bridge.win.webContents.executeJavaScript(`({
            view: document.querySelector('[data-view][aria-current="page"]')?.getAttribute('data-view'),
            informationCollapsed: document.querySelector('.app-shell')?.dataset.informationCollapsed ?? null,
            islands: [...document.querySelectorAll('.workspace-island')].map(island => ({
              placement: island.dataset.placement, hidden: island.hidden, label: island.getAttribute('aria-label'),
            })),
          })`)
    throw new Error(`会话切换后右侧栏目未就绪：${JSON.stringify(state)}`)
  }
  await openRightVerificationPanel(bag.bridge.win, 'file-outline-tasks')
  bag.hoverState = (await bag.bridge.win.webContents.executeJavaScript(
    buildSessionsScript8(JSON.stringify(bag.originalSelector)),
  )) as { ready: boolean }
  if (!bag.hoverState.ready)
    throw new Error('未选中标签缺少悬浮或焦点底色：' + JSON.stringify(bag.hoverState))
  await clickTrustedElement(bag.bridge.win, '.conversation-view-tabs [data-view="trajectory"]')
  await clickTrustedElement(bag.bridge.win, bag.originalSelector)
  bag.conversationRestored = (await bag.bridge.win.webContents.executeJavaScript(
    `document.querySelector('[data-view="conversation"]')?.getAttribute('aria-current') === 'page' && document.querySelector('.main-island .composer-card') !== null`,
  )) as boolean
  await clickTrustedElement(bag.bridge.win, bag.otherSelector)
  bag.otherSessionRightRestored = (await bag.bridge.win.webContents
    .executeJavaScript(`document.querySelector('[data-view="conversation"]')?.getAttribute('aria-current') === 'page'
          && document.querySelector('.right-island-tabs [aria-selected="true"]')?.getAttribute('aria-label') === '脚本'
          && document.querySelector('.info-island.file-info-island [data-project-tasks]') !== null`)) as boolean
  // 浮岛内的对话／轨迹选择属于各自实例，切换会话不会重置；后续验收需要对话视图。
  await clickTrustedElement(bag.bridge.win, '.conversation-view-tabs [data-view="conversation"]')
}

/** 执行 sessions 验收套件第 6 阶段。 */
export async function runSessionsStep6(bag: LocalVerifyState): Promise<void> {
  if (
    bag.originalSessionTab === null ||
    bag.otherSessionTab === null ||
    bag.otherSessionTab === bag.originalSessionTab
  )
    return
  bag.liquidMotionCheck = bag.bridge.win.webContents.executeJavaScript(
    SESSIONS_SCRIPT_9,
  ) as Promise<{
    ready: boolean
    labelsSharp: boolean
    continued: boolean
    maximumHeight: number
    minimumWidth: number
    motionCenterOffset: number
    fromX: number
    targetX: number
    restingHeight: number
    alignment: number
  }>
  writeFileSync(
    bag.bridge.artifactPath('verify-session-tabs-moving.png'),
    (await captureVerifiedPage(bag.bridge.win)).toPNG(),
  )
  bag.liquidMotionState = await bag.liquidMotionCheck
  await verifyTabEdgeMotion(bag.bridge.win)
  bag.pressPoint = (await bag.bridge.win.webContents.executeJavaScript(`(() => {
          const rect = document.querySelector('.session-tab[aria-selected="true"]').getBoundingClientRect()
          return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
        })()`)) as { x: number; y: number }
  bag.longPressReady = false
  bag.bridge.win.webContents.sendInputEvent({
    type: 'mouseDown',
    ...bag.pressPoint,
    button: 'left',
    clickCount: 1,
  })
  try {
    bag.longPressReady = (await bag.bridge.win.webContents.executeJavaScript(
      SESSIONS_SCRIPT_10,
    )) as boolean
    writeFileSync(
      bag.bridge.artifactPath('verify-session-tabs-pressed.png'),
      (await captureVerifiedPage(bag.bridge.win)).toPNG(),
    )
  } finally {
    bag.bridge.win.webContents.sendInputEvent({
      type: 'mouseUp',
      ...bag.pressPoint,
      button: 'left',
      clickCount: 1,
    })
  }
}

/** 执行 sessions 验收套件第 7 阶段。 */
export async function runSessionsStep7(bag: LocalVerifyState): Promise<void> {
  if (
    bag.originalSessionTab === null ||
    bag.otherSessionTab === null ||
    bag.otherSessionTab === bag.originalSessionTab
  )
    return
  await bag.bridge.win.webContents.executeJavaScript(`(async () => {
          for (let attempt = 0; attempt < 80; attempt += 1) {
            const lens = document.querySelector('.session-tab-lens')
            if (lens instanceof HTMLElement
              && lens.dataset.pressed === undefined
              && lens.dataset.moving === undefined
              && Math.abs(lens.getBoundingClientRect().height - 26) < 0.1) return
            await new Promise(resolve => setTimeout(resolve, 25))
          }
        })()`)
  bag.liquidMotionReady = bag.liquidMotionState.ready && bag.longPressReady
  console.log('desktop-shell-verify-local: liquid-motion-geometry', bag.liquidMotionState)
  bag.peerSessionConversationReady = (await bag.bridge.win.webContents.executeJavaScript(
    `document.querySelector('[data-view="conversation"]')?.getAttribute('aria-current') === 'page' && document.querySelector('.main-island .composer-card') !== null`,
  )) as boolean
  bag.expandedTabsReady = (await bag.bridge.win.webContents.executeJavaScript(
    SESSIONS_SCRIPT_11,
  )) as boolean
  await seedComposerReadings(bag.bridge.win, bag.peerSession, frame => {
    bag.bridge.win.webContents.send(bag.bridge.hostChannels.sessionFrame, frame)
  })
  if (
    !(await bag.bridge.win.webContents.executeJavaScript(
      'document.querySelector("[data-composer-readings]") !== null',
    ))
  ) {
    throw new Error('右栏展开时也应保留底部会话仪表盘')
  }
  writeFileSync(
    bag.bridge.artifactPath('verify-session-tabs.png'),
    (await captureVerifiedPage(bag.bridge.win)).toPNG(),
  )
  bag.tabTheme = nativeTheme.themeSource
  bag.tabSize = bag.bridge.win.getSize()
  bag.tabMinimumSize = bag.bridge.win.getMinimumSize()
}

/** 执行 sessions 验收套件第 8 阶段。 */
export async function runSessionsStep8(bag: LocalVerifyState): Promise<void> {
  if (
    bag.originalSessionTab === null ||
    bag.otherSessionTab === null ||
    bag.otherSessionTab === bag.originalSessionTab
  )
    return
  try {
    nativeTheme.themeSource = 'light'
    await waitForNativeTheme(bag.bridge.win, 'light')
    await verifyWindowControls(bag.bridge.win, false)
    writeFileSync(
      bag.bridge.artifactPath('verify-session-tabs-light.png'),
      (await captureVerifiedPage(bag.bridge.win)).toPNG(),
    )
    nativeTheme.themeSource = 'dark'
    bag.bridge.win.setSize(1_440, 900)
    await waitForNativeTheme(bag.bridge.win, 'dark')
    await waitForWindowSize(bag.bridge.win, 1_440, 900)
    await verifyWindowControls(bag.bridge.win, false)
    writeFileSync(
      bag.bridge.artifactPath('verify-session-tabs-dark-large.png'),
      (await captureVerifiedPage(bag.bridge.win)).toPNG(),
    )
    bag.bridge.win.setSize(900, 600)
    const resizedTab = (await bag.bridge.win.webContents.executeJavaScript(SESSIONS_SCRIPT_12)) as {
      ready: boolean
      viewport: number
      left: number
      width: number
      targetLeft: number
      targetWidth: number
    }
    console.log('desktop-shell-verify-local: liquid-resize', resizedTab)
    await new Promise(resolve => {
      setTimeout(resolve, 100)
    })
    // 读数条不再随窗口宽度消失：900px 下右栏被布局隐藏，读数条照常显示；
    // dock 宽于文字降级阈值，此时应保持图标加文字的完整形态。
    const narrowReadings = (await bag.bridge.win.webContents.executeJavaScript(`(() => {
            const hud = document.querySelector('[data-composer-readings]')
            if (!(hud instanceof HTMLElement)) return false
            const label = hud.querySelector('span')
            return label !== null && getComputedStyle(label).display !== 'none'
          })()`)) as boolean
    if (!narrowReadings) throw new Error('窄窗口应照常显示完整的底部会话读数')
    await verifyWindowControls(bag.bridge.win, false)
    writeFileSync(
      bag.bridge.artifactPath('verify-session-tabs-narrow.png'),
      (await captureVerifiedPage(bag.bridge.win)).toPNG(),
    )
    if (!resizedTab.ready) throw new Error('缩小窗口后会话透镜未对齐当前标签')
    // 停靠 DevTools 时页面可窄于应用最小窗口，复现 725px 下的项目与搜索挤压。
    bag.bridge.win.setMinimumSize(725, 600)
    bag.bridge.win.setSize(725, 800)
    const compactProject = (await bag.bridge.win.webContents.executeJavaScript(
      SESSIONS_SCRIPT_13,
    )) as {
      ready: boolean
      viewport: number
      sidebarWidth: number
      projectDisplay: string
      searchWidth: number
    }
    console.log('desktop-shell-verify-local: compact-project', compactProject)
    if (!compactProject.ready) throw new Error('725px 窄视口应隐藏项目选择器并完整保留搜索入口')
    writeFileSync(
      bag.bridge.artifactPath('verify-session-tabs-compact.png'),
      (await captureVerifiedPage(bag.bridge.win)).toPNG(),
    )
  } finally {
    nativeTheme.themeSource = bag.tabTheme
    bag.bridge.win.setMinimumSize(bag.tabMinimumSize[0] ?? 900, bag.tabMinimumSize[1] ?? 600)
    bag.bridge.win.setSize(bag.tabSize[0] ?? 1_280, bag.tabSize[1] ?? 800)
    await waitForNativeTheme(bag.bridge.win, nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
    await waitForWindowSize(bag.bridge.win, bag.tabSize[0] ?? 1_280, bag.tabSize[1] ?? 800)
  }
}

/** 执行 sessions 验收套件第 9 阶段。 */
export async function runSessionsStep9(bag: LocalVerifyState): Promise<void> {
  if (
    bag.originalSessionTab === null ||
    bag.otherSessionTab === null ||
    bag.otherSessionTab === bag.originalSessionTab
  )
    return
  bag.reducedMotionReady = false
  bag.accessibleMaterialReady = true
  if (!bag.bridge.win.webContents.debugger.isAttached())
    bag.bridge.win.webContents.debugger.attach('1.3')
  try {
    await emulateVerificationMedia(bag.bridge.win, [
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ])
    await clickTrustedElement(bag.bridge.win, bag.originalSelector)
    bag.reducedMotionReady = (await bag.bridge.win.webContents.executeJavaScript(`(() => {
            const lens = document.querySelector('.session-tab-lens')
            const active = document.querySelector('.session-tab-shell[data-selected="true"]')
            return matchMedia('(prefers-reduced-motion: reduce)').matches
              && lens.getAnimations().every(animation => animation.playState !== 'running')
              && lens.dataset.moving === undefined
              && Math.abs(lens.getBoundingClientRect().height - 26) < .1
              && Math.abs(lens.getBoundingClientRect().left - active.getBoundingClientRect().left) <= 1
          })()`)) as boolean
    // 对话与轨迹在聊天浮岛内切换，模式栏已不包含轨迹入口。
    const originalView = (await bag.bridge.win.webContents.executeJavaScript(
      `document.querySelector('.conversation-view-tabs [aria-selected="true"]').dataset.view`,
    )) as string
    await clickTrustedElement(
      bag.bridge.win,
      originalView === 'trajectory'
        ? '.conversation-view-tabs [data-view="conversation"]'
        : '.conversation-view-tabs [data-view="trajectory"]',
    )
    bag.reducedMotionReady =
      bag.reducedMotionReady &&
      ((await bag.bridge.win.webContents.executeJavaScript(`(() => {
            const targets = document.querySelectorAll('.app-shell, .session-chrome, .view-tabs__indicator, .main-island > :not([hidden])')
            return [...targets].every(element => element.getAnimations().every(animation => animation.playState !== 'running'))
              && getComputedStyle(document.querySelector('.app-shell')).transitionDuration === '0s'
          })()`)) as boolean)
    await clickTrustedElement(
      bag.bridge.win,
      `.conversation-view-tabs [data-view="${originalView}"]`,
    )
    /* oxlint-disable no-await-in-loop -- 媒体设置作用于同一渲染进程，必须串行验收。 */
    for (const [name, value] of [
      ['prefers-reduced-transparency', 'reduce'],
      ['prefers-contrast', 'more'],
      ['forced-colors', 'active'],
    ] as const) {
      await emulateVerificationMedia(bag.bridge.win, [{ name, value }])
      bag.accessibleMaterialReady =
        bag.accessibleMaterialReady &&
        ((await bag.bridge.win.webContents.executeJavaScript(SESSIONS_SCRIPT_14)) as boolean)
    }
    /* oxlint-enable no-await-in-loop */
  } finally {
    await emulateVerificationMedia(bag.bridge.win)
  }
  bag.sameTabGroup = (await bag.bridge.win.webContents
    .executeJavaScript(`document.querySelector(${JSON.stringify(bag.originalSelector)}).closest('.session-tab-group')
          === document.querySelector(${JSON.stringify(bag.otherSelector)}).closest('.session-tab-group')`)) as boolean
  bag.expectedFirst = bag.sameTabGroup ? bag.otherSessionTab : bag.originalSessionTab
  bag.expectedSecond = bag.sameTabGroup ? bag.originalSessionTab : bag.otherSessionTab
}
