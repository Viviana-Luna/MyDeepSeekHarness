/**
 * 项目会话分组、会话置顶、全局搜索弹窗与跨工作区后台通知验收器。
 */
import { writeFileSync } from 'node:fs'
import { captureVerifiedPage, clickTrustedElement } from '../desktop-verifier.ts'
import { openRightVerificationPanel, settleElementAnimations } from '../host-verify-context.ts'
import {
  PROJECT_FOCUS_FILTER_PROBE,
  SESSION_SEARCH_CLOSE_PROBE,
  SESSION_SEARCH_OPEN_PROBE,
  buildCreatePeerSessionProbe,
  buildIdleTabFocusSurfaceProbe,
  buildMarkOtherGroupSearchResultProbe,
  buildPinnedSessionProbe,
  buildUnpinnedSessionProbe,
} from './session-probes.ts'
import type { LocalVerifyState } from './state.ts'

/** 验证项目筛选切换、单条会话置顶与取消置顶。 */
export async function verifyProjectGroupingAndPinning(state: LocalVerifyState): Promise<void> {
  state.projectGroupingReady =
    state.initial.projectFocused &&
    ((await state.bridge.win.webContents.executeJavaScript(PROJECT_FOCUS_FILTER_PROBE)) as boolean)
  state.sessionActionTarget = (await state.bridge.win.webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('.project-session-group .session-row-shell')]
      .find(element => element instanceof HTMLElement && element.getClientRects().length > 0)
    return row?.getAttribute('data-session-id') ?? null
  })()`)) as string | null
  state.sessionActionsReady = state.sessionActionTarget === null
  state.sessionActionsCapture = ''
  if (state.sessionActionTarget !== null) {
    const escapedTarget = JSON.stringify(state.sessionActionTarget)
    await clickTrustedElement(
      state.bridge.win,
      `.project-session-group .session-row-shell[data-session-id=${escapedTarget}] button[aria-label="置顶聊天"]`,
    )
    state.sessionActionsReady = (await state.bridge.win.webContents.executeJavaScript(
      buildPinnedSessionProbe(state.sessionActionTarget),
    )) as boolean
    if (state.sessionActionsReady) {
      const hoverPoint = (await state.bridge.win.webContents.executeJavaScript(`(() => {
        const row = document.querySelector('.pinned-session-group .session-row-shell[data-session-id=' + JSON.stringify(${escapedTarget}) + ']')
        if (!(row instanceof HTMLElement)) return null
        const rect = row.getBoundingClientRect()
        return { x: Math.round(rect.right - 32), y: Math.round(rect.top + rect.height / 2) }
      })()`)) as { x: number; y: number } | null
      if (hoverPoint !== null) {
        state.bridge.win.webContents.sendInputEvent({ type: 'mouseMove', ...hoverPoint })
        await new Promise(resolve => {
          setTimeout(resolve, 100)
        })
      }
      state.sessionActionsCapture = 'verify-session-actions.png'
      writeFileSync(
        state.bridge.artifactPath(state.sessionActionsCapture),
        (await captureVerifiedPage(state.bridge.win)).toPNG(),
      )
    }
    await clickTrustedElement(
      state.bridge.win,
      `.pinned-session-group .session-row-shell[data-session-id=${escapedTarget}] button[aria-label="取消置顶聊天"]`,
    )
    state.sessionActionsReady =
      state.sessionActionsReady &&
      ((await state.bridge.win.webContents.executeJavaScript(
        buildUnpinnedSessionProbe(state.sessionActionTarget),
      )) as boolean)
  }
}

/** 验证会话搜索弹窗打开、自动聚焦、关闭归还焦点。 */
export async function verifySessionSearchDialog(state: LocalVerifyState): Promise<void> {
  await clickTrustedElement(state.bridge.win, '.session-search-trigger')
  state.sessionSearchState = (await state.bridge.win.webContents.executeJavaScript(
    SESSION_SEARCH_OPEN_PROBE,
  )) as {
    ready: boolean
    dialogPresent: boolean
    closePresent: boolean
  }
  state.sessionSearchReady = state.sessionSearchState.ready
  console.log(
    `desktop-shell-verify-local: session-search ${JSON.stringify(state.sessionSearchState)}`,
  )
  state.searchCapture = 'verify-search.png'
  if (state.sessionSearchState.dialogPresent) {
    writeFileSync(
      state.bridge.artifactPath(state.searchCapture),
      (await captureVerifiedPage(state.bridge.win)).toPNG(),
    )
  }
  if (state.sessionSearchState.closePresent) {
    await clickTrustedElement(state.bridge.win, '.session-search-close')
  }
  state.sessionSearchCloseState = (await state.bridge.win.webContents.executeJavaScript(
    SESSION_SEARCH_CLOSE_PROBE,
  )) as { closed: boolean }
  if (!state.sessionSearchCloseState.closed) {
    console.log(
      `desktop-shell-verify-local: session-search-close ${JSON.stringify(state.sessionSearchCloseState)}`,
    )
  }
  state.sessionSearchReady = state.sessionSearchReady && state.sessionSearchCloseState.closed
  state.originalSessionTab = (await state.bridge.win.webContents.executeJavaScript(
    `document.querySelector('.session-tab[aria-selected="true"]')?.getAttribute('data-session-tab') ?? null`,
  )) as string | null
  state.sessionTabsReady = false
}

async function waitForWorkspaceMenuOption(state: LocalVerifyState): Promise<boolean> {
  return (await state.bridge.win.webContents.executeJavaScript(`(async () => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const menu = document.querySelector('.composer-workspace-menu')
      const option = menu?.querySelector('[role="menuitemradio"][aria-checked="false"]')
      if (menu instanceof HTMLElement
        && menu.dataset.menuMotion === 'open'
        && option instanceof HTMLButtonElement
        && option.getClientRects().length > 0) {
        await Promise.allSettled(
          menu.getAnimations({ subtree: true })
            .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
            .map(animation => animation.finished),
        )
        return true
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return false
  })()`)) as boolean
}

async function createAndSelectPeerSessionTab(state: LocalVerifyState): Promise<void> {
  state.peerSession = (await state.bridge.win.webContents.executeJavaScript(
    buildCreatePeerSessionProbe(state.originalSessionTab!),
  )) as string
  await clickTrustedElement(state.bridge.win, '.session-search-trigger')
  await state.bridge.win.webContents.executeJavaScript(`(async () => {
    for (let attempt = 0; attempt < 80; attempt++) {
      const result = [...document.querySelectorAll('.session-search-result')].find(button => button.querySelector('strong')?.textContent === '标签交互验收')
      if (result) { result.id = 'verify-peer-session'; return }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error('新建的同项目会话未出现在搜索结果中')
  })()`)
  await clickTrustedElement(state.bridge.win, '#verify-peer-session')
  await settleElementAnimations(state.bridge.win, '.app-shell')
  state.otherSessionTab = (await state.bridge.win.webContents.executeJavaScript(
    `document.querySelector('.session-tab[aria-selected="true"]')?.getAttribute('data-session-tab') ?? null`,
  )) as string | null
  if (state.otherSessionTab !== state.peerSession) throw new Error('没有打开同项目验收会话')
}

/** 验证跨项目会话组未读角标、工作区菜单切换与同项目双标签准备。 */
export async function verifyWorkspaceGroupsAndPreparePeerTab(
  state: LocalVerifyState,
): Promise<void> {
  if (state.originalSessionTab === null) return
  state.originalGroup = (await state.bridge.win.webContents.executeJavaScript(
    `document.querySelector('.session-tab-group').getAttribute('aria-label')`,
  )) as string
  state.groupNavigationExpanded = (await state.bridge.win.webContents.executeJavaScript(
    `document.querySelector('.app-shell').dataset.navigationCollapsed !== 'true'`,
  )) as boolean
  if (!state.groupNavigationExpanded) {
    await clickTrustedElement(
      state.bridge.win,
      '.panel-divider--navigation .panel-divider__capsule',
    )
  }
  await clickTrustedElement(state.bridge.win, '.session-search-trigger')
  await state.bridge.win.webContents.executeJavaScript(
    buildMarkOtherGroupSearchResultProbe(state.originalGroup),
  )
  await clickTrustedElement(state.bridge.win, '#verify-other-group')
  await clickTrustedElement(state.bridge.win, '.panel-divider--navigation .panel-divider__capsule')
  state.bridge.win.webContents.send(state.bridge.hostChannels.hostFrame, {
    type: 'host/session-status',
    sessionId: state.originalSessionTab,
    running: true,
  })
  state.bridge.win.webContents.send(state.bridge.hostChannels.hostFrame, {
    type: 'host/session-status',
    sessionId: state.originalSessionTab,
    running: false,
  })
  state.groupNotificationReady = (await state.bridge.win.webContents
    .executeJavaScript(`(async () => {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (document.querySelector('.session-group-switcher') === null
        && document.querySelector('.app-shell')?.getAttribute('data-session-tabs-visible') === 'false'
        && document.querySelector('.composer-workspace-trigger .session-group-unread')?.textContent === '1') {
        return document.querySelectorAll('.session-tab-group').length === 1
          && ![...document.querySelectorAll('.session-tab')].some(tab => tab.dataset.sessionTab === ${JSON.stringify(state.originalSessionTab)})
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return false
  })()`)) as boolean

  await settleElementAnimations(state.bridge.win, '.app-shell')
  await clickTrustedElement(state.bridge.win, '.composer-workspace-trigger')
  if (!(await waitForWorkspaceMenuOption(state))) {
    throw new Error('输入区工作区菜单没有显示其他项目')
  }
  writeFileSync(
    state.bridge.artifactPath('verify-session-group-menu.png'),
    (await captureVerifiedPage(state.bridge.win)).toPNG(),
  )

  await clickTrustedElement(
    state.bridge.win,
    '.composer-workspace-menu [role="menuitemradio"][aria-checked="false"]',
  )
  state.groupSwitchReady =
    state.groupNotificationReady &&
    ((await state.bridge.win.webContents.executeJavaScript(`(async () => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const ready = document.querySelector('.session-tab[aria-selected="true"]')?.dataset.sessionTab === ${JSON.stringify(state.originalSessionTab)}
          && document.querySelector('.composer-workspace-trigger .session-group-unread') === null
          && document.querySelectorAll('.session-tab-group').length === 1
        if (ready) return true
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return false
    })()`)) as boolean)
  if (!state.groupSwitchReady) throw new Error('工作区切换或后台更新提示验收失败')

  await switchAndCloseOtherWorkspaceGroup(state)
  await createAndSelectPeerSessionTab(state)
}

async function switchAndCloseOtherWorkspaceGroup(state: LocalVerifyState): Promise<void> {
  await clickTrustedElement(state.bridge.win, '.composer-workspace-trigger')
  if (!(await waitForWorkspaceMenuOption(state)))
    throw new Error('输入区工作区菜单没有恢复其他项目')
  await clickTrustedElement(
    state.bridge.win,
    '.composer-workspace-menu [role="menuitemradio"][aria-checked="false"]',
  )
  await clickTrustedElement(state.bridge.win, '.composer-workspace-trigger')
  if (!(await waitForWorkspaceMenuOption(state))) throw new Error('输入区工作区菜单未能重新展开')
  await clickTrustedElement(
    state.bridge.win,
    '.composer-workspace-menu [role="menuitemradio"][aria-checked="true"] ~ .session-group-close',
  )
  if (state.groupNavigationExpanded) {
    await clickTrustedElement(
      state.bridge.win,
      '.panel-divider--navigation .panel-divider__capsule',
    )
  }
}

/** 验证双标签切换时右侧面板保留、轨迹/对话独立状态与悬浮底色。 */
export async function verifyPeerTabFocusAndViewIsolation(state: LocalVerifyState): Promise<void> {
  if (
    state.originalSessionTab === null ||
    state.otherSessionTab === null ||
    state.otherSessionTab === state.originalSessionTab
  ) {
    return
  }
  state.originalSelector = `.session-tab[data-session-tab=${JSON.stringify(state.originalSessionTab)}]`
  state.otherSelector = `.session-tab[data-session-tab=${JSON.stringify(state.otherSessionTab)}]`
  state.rightCollapsed = (await state.bridge.win.webContents.executeJavaScript(
    `document.querySelector('.app-shell')?.dataset.informationCollapsed === 'true'`,
  )) as boolean
  if (state.rightCollapsed)
    await clickTrustedElement(state.bridge.win, '[aria-label="展开右侧浮岛"]')
  state.rightSelectorReady = (await state.bridge.win.webContents.executeJavaScript(`(async () => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const selector = document.querySelector('.right-island-tabs')
      if (selector instanceof HTMLElement && selector.getClientRects().length > 0) return true
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return false
  })()`)) as boolean
  if (!state.rightSelectorReady) {
    throw new Error('会话切换后右侧栏目未就绪')
  }
  await openRightVerificationPanel(state.bridge.win, 'file-outline-tasks')
  state.hoverState = (await state.bridge.win.webContents.executeJavaScript(
    buildIdleTabFocusSurfaceProbe(state.originalSelector),
  )) as { ready: boolean }
  if (!state.hoverState.ready) {
    throw new Error(`未选中标签缺少悬浮或焦点底色：${JSON.stringify(state.hoverState)}`)
  }
  await clickTrustedElement(state.bridge.win, '.conversation-view-tabs [data-view="trajectory"]')
  await clickTrustedElement(state.bridge.win, state.originalSelector)
  state.conversationRestored = (await state.bridge.win.webContents.executeJavaScript(
    `document.querySelector('[data-view="conversation"]')?.getAttribute('aria-current') === 'page' && document.querySelector('.main-island .composer-card') !== null`,
  )) as boolean
  await clickTrustedElement(state.bridge.win, state.otherSelector)
  state.otherSessionRightRestored = (await state.bridge.win.webContents
    .executeJavaScript(`document.querySelector('[data-view="conversation"]')?.getAttribute('aria-current') === 'page'
      && document.querySelector('.right-island-tabs [aria-selected="true"]')?.getAttribute('aria-label') === '脚本'
      && document.querySelector('.info-island.file-info-island [data-project-tasks]') !== null`)) as boolean
  await clickTrustedElement(state.bridge.win, '.conversation-view-tabs [data-view="conversation"]')
}
