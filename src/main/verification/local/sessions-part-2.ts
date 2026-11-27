/**
 * 项目分组、会话操作、会话搜索与液态标签栏动效验收套件（阶段分片 2）。
 */
import { writeFileSync } from 'node:fs'
import { settleElementAnimations } from '../host-verify-context.ts'
import {
  captureVerifiedPage,
  clickTrustedElement,
  dragTrustedElementHorizontally,
} from '../desktop-verifier.ts'
import { verifyWindowControls } from '../window-verifier.ts'
import { seedComposerReadings } from '../session-projection-fixture.ts'
import { verifyTabOverflow } from '../tab-overflow-verifier.ts'
import type { LocalVerifyState } from './state.ts'
import {
  SESSIONS_SCRIPT_15,
  SESSIONS_SCRIPT_16,
  SESSIONS_SCRIPT_17,
  buildSessionsScript18,
} from './sessions-scripts.ts'

/** 执行 sessions 验收套件第 10 阶段。 */
export async function runSessionsStep10(bag: LocalVerifyState): Promise<void> {
  if (
    bag.originalSessionTab === null ||
    bag.otherSessionTab === null ||
    bag.otherSessionTab === bag.originalSessionTab
  )
    return
  bag.dragDistance = (await bag.bridge.win.webContents.executeJavaScript(`(() => {
          const from = document.querySelector(${JSON.stringify(bag.originalSelector)}).getBoundingClientRect()
          const to = document.querySelector(${JSON.stringify(bag.otherSelector)}).getBoundingClientRect()
          return to.left - from.left
        })()`)) as number
  await dragTrustedElementHorizontally(bag.bridge.win, bag.originalSelector, bag.dragDistance)
  bag.reorderReady = (await bag.bridge.win.webContents.executeJavaScript(`(() => {
          const tabs = [...document.querySelectorAll('.session-tab')]
          return tabs[0]?.dataset.sessionTab === ${JSON.stringify(bag.expectedFirst)}
            && tabs[1]?.dataset.sessionTab === ${JSON.stringify(bag.expectedSecond)}
            && document.querySelector(${JSON.stringify(bag.originalSelector)}).getAttribute('aria-selected') === 'true'
            && document.querySelector('[data-reordering], [data-dragging]') === null
        })()`)) as boolean
  bag.cancelPoint = (await bag.bridge.win.webContents.executeJavaScript(`(() => {
          const rect = document.querySelector(${JSON.stringify(bag.originalSelector)}).getBoundingClientRect()
          return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
        })()`)) as { x: number; y: number }
  bag.cancelTargetX = Math.round(
    bag.cancelPoint.x + (bag.sameTabGroup ? -bag.dragDistance : bag.dragDistance),
  )
  bag.bridge.win.webContents.sendInputEvent({ type: 'mouseMove', ...bag.cancelPoint })
  bag.bridge.win.webContents.sendInputEvent({
    type: 'mouseDown',
    ...bag.cancelPoint,
    button: 'left',
    clickCount: 1,
  })
  bag.bridge.win.webContents.sendInputEvent({
    type: 'mouseMove',
    x: bag.cancelTargetX,
    y: bag.cancelPoint.y,
  })
  bag.cancelStarted = (await bag.bridge.win.webContents.executeJavaScript(`(async () => {
          for (let attempt = 0; attempt < 60; attempt += 1) {
            if (document.querySelector('.session-tab-glass')?.dataset.reordering === 'true') return true
            await new Promise(resolve => setTimeout(resolve, 25))
          }
          return false
        })()`)) as boolean
  bag.bridge.win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  bag.bridge.win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  bag.bridge.win.webContents.sendInputEvent({
    type: 'mouseUp',
    x: bag.cancelTargetX,
    y: bag.cancelPoint.y,
    button: 'left',
    clickCount: 1,
  })
}

/** 执行 sessions 验收套件第 11 阶段。 */
export async function runSessionsStep11(bag: LocalVerifyState): Promise<void> {
  if (
    bag.originalSessionTab === null ||
    bag.otherSessionTab === null ||
    bag.otherSessionTab === bag.originalSessionTab
  )
    return
  bag.cancelRestored = (await bag.bridge.win.webContents.executeJavaScript(`(async () => {
          for (let attempt = 0; attempt < 60; attempt += 1) {
            const tabs = [...document.querySelectorAll('.session-tab')]
            if (tabs[0]?.dataset.sessionTab === ${JSON.stringify(bag.expectedFirst)}
              && tabs[1]?.dataset.sessionTab === ${JSON.stringify(bag.expectedSecond)}
              && document.querySelector('[data-reordering], [data-dragging]') === null) return true
            await new Promise(resolve => setTimeout(resolve, 25))
          }
          return false
        })()`)) as boolean
  bag.dragReady = bag.reorderReady && bag.cancelStarted && bag.cancelRestored
  bag.readTabsFill = async () =>
    (await bag.bridge.win.webContents.executeJavaScript(`(() => {
          const strip = document.querySelector('.session-tabs')
          const tabs = [...document.querySelectorAll('.session-tab-shell')]
          if (!(strip instanceof HTMLElement) || tabs.length !== 2) return false
          const style = getComputedStyle(strip)
          const contentWidth = strip.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight)
          return tabs.every(tab => Math.abs(tab.getBoundingClientRect().width - contentWidth / tabs.length) < 1)
            && Math.abs(tabs.reduce((total, tab) => total + tab.getBoundingClientRect().width, 0) - contentWidth) < 1
            && strip.scrollWidth <= strip.clientWidth + 1
        })()`)) as boolean
  bag.expandedTabsFill = await bag.readTabsFill()
  await clickTrustedElement(bag.bridge.win, '.panel-divider--navigation .panel-divider__capsule')
  // 布局切换会取消旧动画，验收只等待仍在完成的动画。
  await bag.bridge.win.webContents
    .executeJavaScript(`Promise.all(document.querySelector('.app-shell').getAnimations({ subtree: true })
          .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))`)
  bag.collapsedTabsFill = await bag.readTabsFill()
  await verifyWindowControls(bag.bridge.win, false)
  await clickTrustedElement(bag.bridge.win, '.panel-divider--navigation .panel-divider__capsule')
  await bag.bridge.win.webContents
    .executeJavaScript(`Promise.all(document.querySelector('.app-shell').getAnimations({ subtree: true })
          .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))`)
  bag.tabsFillReady = bag.expandedTabsFill && bag.collapsedTabsFill
  bag.tabOverflowReady = false
  await bag.bridge.win.webContents.executeJavaScript(
    `document.querySelector('.session-tabs-frame').style.flex = '0 0 180px'`,
  )
}

/** 执行 sessions 验收套件第 12 阶段。 */
export async function runSessionsStep12(bag: LocalVerifyState): Promise<void> {
  if (
    bag.originalSessionTab === null ||
    bag.otherSessionTab === null ||
    bag.otherSessionTab === bag.originalSessionTab
  )
    return
  try {
    const overflowStartReady = (await bag.bridge.win.webContents.executeJavaScript(
      SESSIONS_SCRIPT_15,
    )) as boolean
    if (overflowStartReady) {
      await clickTrustedElement(bag.bridge.win, '.session-tab-scroll--right')
      const overflowEndReady = (await bag.bridge.win.webContents.executeJavaScript(
        SESSIONS_SCRIPT_16,
      )) as boolean
      if (overflowEndReady) {
        await clickTrustedElement(bag.bridge.win, '.session-tab-scroll--left')
        bag.tabOverflowReady = (await bag.bridge.win.webContents.executeJavaScript(`(async () => {
                const deadline = performance.now() + 1000
                while (performance.now() < deadline) {
                  await new Promise(resolve => requestAnimationFrame(resolve))
                  const strip = document.querySelector('.session-tabs')
                  const left = document.querySelector('.session-tab-scroll--left')
                  if (strip.scrollLeft <= 1 && left.disabled) return true
                }
                return false
              })()`)) as boolean
      }
    }
  } finally {
    await bag.bridge.win.webContents.executeJavaScript(SESSIONS_SCRIPT_17)
  }
  bag.overflowScheme = bag.bridge.settingsStore.read().colorScheme
  try {
    await verifyTabOverflow(
      bag.bridge.win,
      scheme => {
        bag.bridge.settingsController.publish(
          bag.bridge.settingsStore.update({ colorScheme: scheme }),
        )
      },
      async name => {
        writeFileSync(
          bag.bridge.artifactPath(name),
          (await captureVerifiedPage(bag.bridge.win)).toPNG(),
        )
      },
    )
  } finally {
    bag.bridge.settingsController.publish(
      bag.bridge.settingsStore.update({ colorScheme: bag.overflowScheme }),
    )
  }
}

/** 执行 sessions 验收套件第 13 阶段。 */
export async function runSessionsStep13(bag: LocalVerifyState): Promise<void> {
  if (
    bag.originalSessionTab === null ||
    bag.otherSessionTab === null ||
    bag.otherSessionTab === bag.originalSessionTab
  )
    return
  console.log('desktop-shell-verify-local: liquid-motion', {
    liquidMotionReady: bag.liquidMotionReady,
    reducedMotionReady: bag.reducedMotionReady,
    accessibleMaterialReady: bag.accessibleMaterialReady,
    expandedTabsReady: bag.expandedTabsReady,
    tabsFillReady: bag.tabsFillReady,
    tabOverflowReady: bag.tabOverflowReady,
    expandedTabsFill: bag.expandedTabsFill,
    collapsedTabsFill: bag.collapsedTabsFill,
    conversationRestored: bag.conversationRestored,
    otherSessionRightRestored: bag.otherSessionRightRestored,
    peerSessionConversationReady: bag.peerSessionConversationReady,
    reorderReady: bag.reorderReady,
    cancelStarted: bag.cancelStarted,
    cancelRestored: bag.cancelRestored,
  })
  await clickTrustedElement(bag.bridge.win, bag.otherSelector)
  await clickTrustedElement(
    bag.bridge.win,
    '.session-tab-shell[data-selected="true"] .session-tab-close',
  )
  await settleElementAnimations(bag.bridge.win, '.app-shell')
  bag.sessionTabsReady =
    bag.liquidMotionReady &&
    bag.reducedMotionReady &&
    bag.accessibleMaterialReady &&
    bag.dragReady &&
    bag.expandedTabsReady &&
    bag.tabsFillReady &&
    bag.tabOverflowReady &&
    bag.conversationRestored &&
    bag.otherSessionRightRestored &&
    bag.peerSessionConversationReady &&
    ((await bag.bridge.win.webContents.executeJavaScript(
      buildSessionsScript18(
        JSON.stringify(bag.originalSessionTab),
        JSON.stringify(bag.otherSelector),
      ),
    )) as boolean)
}

/** 执行 sessions 验收套件第 14 阶段。 */
export async function runSessionsStep14(bag: LocalVerifyState): Promise<void> {
  console.log('desktop-shell-verify-local: session-tabs', bag.sessionTabsReady)
  await verifyWindowControls(bag.bridge.win, false)
  if (bag.originalSessionTab !== null)
    await seedComposerReadings(bag.bridge.win, bag.originalSessionTab, frame => {
      bag.bridge.win.webContents.send(bag.bridge.hostChannels.sessionFrame, frame)
    })
}
