/** 用隔离仓库的长提交记录验证左右源代码管理的分区和输入事件。 */
import type { BrowserWindow } from 'electron'
import { clickTrustedElement } from './desktop-verifier.ts'
import { pollRenderer } from './verification-wait.ts'

const graphToggle = 'button[aria-label="图表面板"]'
const changesToggle = 'button[aria-label="更改面板"]'
const divider = '[role="separator"][aria-label="调整提交图高度"]'
const historyContent = '.scm-history > .scm-pane-content'

interface PaneHeights {
  changes: number
  history: number
}

function paneProbeScript(scope: string): string {
  return `(() => {
    const panes = document.querySelector(${JSON.stringify(`${scope} .scm-panes`)})
    const changes = panes?.querySelector('.scm-pane:first-child > .scm-pane-content')
    const history = panes?.querySelector(${JSON.stringify(historyContent)})
    if (!changes || !history) return null
    return { changes: changes.clientHeight, history: history.clientHeight }
  })()`
}

async function readPanes(win: BrowserWindow, scope: string): Promise<PaneHeights> {
  const result = await pollRenderer<PaneHeights | null>(win, {
    probe: paneProbeScript(scope),
    condition: 'state !== null',
    timeoutMs: 1_500,
  })
  if (!result.ok || result.value === null) throw new Error('源代码管理缺少更改或图表区域')
  return result.value
}

async function waitPanesMatch(
  win: BrowserWindow,
  scope: string,
  condition: string,
  failureMessage: string,
): Promise<PaneHeights> {
  const result = await pollRenderer<PaneHeights | null>(win, {
    probe: paneProbeScript(scope),
    condition: `state !== null && (${condition})`,
    timeoutMs: 2_000,
    intervalMs: 20,
  })
  if (!result.ok || result.value === null) {
    throw new Error(`${failureMessage}：${JSON.stringify({ scope, result })}`)
  }
  return result.value
}

async function growHistory(
  win: BrowserWindow,
  scope: string,
  distance = 128,
  foldBeforeRelease = false,
) {
  const point = (await win.webContents.executeJavaScript(`(() => {
    const bounds = document.querySelector(${JSON.stringify(`${scope} ${divider}`)})?.getBoundingClientRect()
    return bounds && { x: Math.round(bounds.left + bounds.width / 2), y: Math.round(bounds.top + bounds.height / 2) }
  })()`)) as { x: number; y: number } | undefined
  if (point === undefined) throw new Error('找不到提交图分隔线')
  win.webContents.sendInputEvent({ type: 'mouseMove', ...point })
  win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
  const moved = { x: point.x, y: point.y - distance }
  win.webContents.sendInputEvent({
    type: 'mouseMove',
    ...moved,
    movementX: 0,
    movementY: -distance,
  })
  try {
    // 软件渲染或离屏模式下等待一帧再抬起，避免同步连续事件把拖动增量合并丢失。
    await win.webContents.executeJavaScript(
      'Promise.race([new Promise(resolve => requestAnimationFrame(resolve)), new Promise(resolve => setTimeout(resolve, 60))])',
    )
    if (foldBeforeRelease) {
      await win.webContents.executeJavaScript(`(async () => {
        // 指针仍由分隔线捕获，通过按钮激活模拟键盘折叠。
        document.querySelector(${JSON.stringify(`${scope} ${graphToggle}`)}).click()
        await Promise.race([
          new Promise(resolve => requestAnimationFrame(resolve)),
          new Promise(resolve => setTimeout(resolve, 60)),
        ])
      })()`)
    }
  } finally {
    win.webContents.sendInputEvent({ type: 'mouseUp', ...moved, button: 'left', clickCount: 1 })
  }
  await win.webContents.executeJavaScript(
    'Promise.race([new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))), new Promise(resolve => setTimeout(resolve, 100))])',
  )
}

async function verifySectionToggles(
  win: BrowserWindow,
  scope: string,
  resized: PaneHeights,
): Promise<PaneHeights> {
  const scopedGraphToggle = `${scope} ${graphToggle}`
  const scopedChangesToggle = `${scope} ${changesToggle}`
  await clickTrustedElement(win, scopedGraphToggle)
  await waitPanesMatch(
    win,
    scope,
    `state.history === 0 && state.changes > ${String(resized.changes)}`,
    '收起图表后未能释放更改区高度',
  )
  await clickTrustedElement(win, scopedChangesToggle)
  await waitPanesMatch(
    win,
    scope,
    'state.changes === 0 && state.history === 0',
    '同时收起更改与图表失败',
  )
  await clickTrustedElement(win, scopedGraphToggle)
  await waitPanesMatch(
    win,
    scope,
    `state.changes === 0 && state.history > ${String(resized.history)}`,
    '仅展开图表时未能占满剩余空间',
  )
  await clickTrustedElement(win, scopedChangesToggle)
  return waitPanesMatch(
    win,
    scope,
    `Math.abs(state.history - ${String(resized.history)}) <= 1`,
    '更改与图表未能恢复拖动比例',
  )
}

async function verifyKeyboardAndInterruptedDrag(
  win: BrowserWindow,
  scope: string,
  initial: PaneHeights,
  restored: PaneHeights,
): Promise<void> {
  const scopedGraphToggle = `${scope} ${graphToggle}`
  const scopedDivider = JSON.stringify(`${scope} ${divider}`)
  const scopedHistory = JSON.stringify(`${scope} ${historyContent}`)
  await win.webContents.executeJavaScript(`(() => {
    const separator = document.querySelector(${scopedDivider})
    separator.focus()
    separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
  })()`)
  await waitPanesMatch(
    win,
    scope,
    `state.history > ${String(restored.history)}`,
    '键盘无法调高提交图',
  )
  await growHistory(win, scope, 32, true)
  await waitPanesMatch(win, scope, 'state.history === 0', '拖动期间未能折叠图表')
  await clickTrustedElement(win, scopedGraphToggle)
  const reopened = await waitPanesMatch(
    win,
    scope,
    'state.history > 0',
    '折叠中断拖动后未能重新展开图表',
  )
  await growHistory(win, scope, 32)
  await waitPanesMatch(
    win,
    scope,
    `state.history > ${String(reopened.history)}`,
    '折叠中断拖动后无法再次调整图表高度',
  )
  await win.webContents.executeJavaScript(`(() => {
    const separator = document.querySelector(${scopedDivider})
    separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    separator.blur()
    document.querySelector(${scopedHistory}).scrollTop = 0
  })()`)
  await waitPanesMatch(
    win,
    scope,
    `Math.abs(state.history - ${String(initial.history)}) <= 1`,
    '提交图未恢复默认高度',
  )
}

/** 检查真实拖动、滚到最早提交、两区独立收起和高度恢复。 */
export async function verifySourceControlSections(
  win: BrowserWindow,
  capture: (name: string) => Promise<void>,
  placement: 'left' | 'right' = 'left',
): Promise<void> {
  const scope = placement === 'left' ? '.navigation-island' : '.info-island'
  const scopedHistory = JSON.stringify(`${scope} ${historyContent}`)
  const initial = await readPanes(win, scope)
  await growHistory(win, scope)
  const resized = await waitPanesMatch(
    win,
    scope,
    `state.history > ${String(Math.max(320, initial.history + 64))} && state.changes < ${String(initial.changes)}`,
    '拖动分隔线没有扩大提交图并缩小更改区',
  )
  const scrollsToEnd = await pollRenderer<Record<string, unknown>>(win, {
    probe: `(() => {
      const history = document.querySelector(${scopedHistory})
      const rows = history?.querySelectorAll('.git-commit-row')
      if (!rows || rows.length < 12) return { ok: false, rows: rows?.length ?? 0 }
      history.scrollTop = history.scrollHeight
      const last = rows[rows.length - 1].getBoundingClientRect()
      const viewport = history.getBoundingClientRect()
      return {
        ok: history.scrollTop > 0 && last.top >= viewport.top && last.bottom <= viewport.bottom
          && history.scrollWidth <= history.clientWidth + 1,
        scrollTop: history.scrollTop, scrollWidth: history.scrollWidth, clientWidth: history.clientWidth,
        last: last.toJSON(), viewport: viewport.toJSON(),
      }
    })()`,
    condition: 'state.ok === true',
    timeoutMs: 1_500,
  })
  if (!scrollsToEnd.ok) {
    throw new Error(`图表无法滚到最早的一条提交或出现横向滚动条：${JSON.stringify(scrollsToEnd)}`)
  }
  await capture(`verify-scm-history-${placement}-resized.png`)
  const restored = await verifySectionToggles(win, scope, resized)
  await verifyKeyboardAndInterruptedDrag(win, scope, initial, restored)
  console.log('desktop-shell-verify-local: source-control-sections', {
    placement,
    initial,
    resized,
    restored,
    interruptedDrag: true,
  })
}

const bulkUnstageTrigger = '.navigation-island button[aria-label="取消暂存全部更改"]'
const bulkUnstageCancel = '.ant-modal-footer button[aria-label="返回"]'
const bulkUnstageConfirm = '.ant-modal-footer button[aria-label="确认取消暂存"]'

async function waitForBulkUnstageModalClosed(win: BrowserWindow, stage: string): Promise<void> {
  const closed = await pollRenderer<{
    openDialogs: number
    visibleWraps: number
    leavingModals: number
  }>(win, {
    probe: `(() => {
      const leavePattern = /(?:^|\\s)[^\\s]+-leave(?:-(?:prepare|start|active))?(?:\\s|$)/
      const visibleWraps = [...document.querySelectorAll('.ant-modal-wrap')].filter(node =>
        node instanceof HTMLElement && node.checkVisibility()
      ).length
      const openDialogs = [...document.querySelectorAll('.ant-modal, [role="dialog"]')].filter(node =>
        node instanceof HTMLElement && node.checkVisibility()
      ).length
      const leavingModals = [...document.querySelectorAll('.ant-modal, .ant-modal-wrap, .ant-modal-mask')].filter(node =>
        node instanceof HTMLElement && typeof node.className === 'string' && leavePattern.test(node.className)
      ).length
      return { openDialogs, visibleWraps, leavingModals }
    })()`,
    condition: 'state.openDialogs === 0 && state.visibleWraps === 0 && state.leavingModals === 0',
    timeoutMs: 3_000,
    intervalMs: 25,
  })
  if (!closed.ok) {
    throw new Error(`${stage}后确认弹窗未彻底关闭并退场：${JSON.stringify(closed)}`)
  }
}

async function waitForBulkUnstageModalReady(win: BrowserWindow): Promise<void> {
  const ready = await pollRenderer<{
    ready: boolean
    found: boolean
    disabled: boolean
    inMotion: boolean
    runningAnimations: number
    opacity: number | null
  }>(win, {
    probe: `(() => {
      const motionPattern = /(?:^|\\s)ant-[^\\s]+-(?:appear|enter|leave)(?:-(?:prepare|start|active))?(?:\\s|$)/
      const button = [...document.querySelectorAll(${JSON.stringify(bulkUnstageConfirm)})].find(node => {
        if (!(node instanceof HTMLButtonElement) || !node.checkVisibility()) return false
        const rect = node.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      })
      if (!(button instanceof HTMLButtonElement)) {
        return { ready: false, found: false, disabled: false, inMotion: false, runningAnimations: 0, opacity: null }
      }
      const modal = button.closest('.ant-modal')
      const inMotion = modal instanceof HTMLElement
        && typeof modal.className === 'string'
        && motionPattern.test(modal.className)
      const runningAnimations = modal instanceof HTMLElement && typeof modal.getAnimations === 'function'
        ? modal.getAnimations({ subtree: true }).filter(animation =>
            animation.playState !== 'finished' &&
            animation.effect?.getComputedTiming().iterations !== Infinity
          ).length
        : 0
      const parsedOpacity = modal instanceof HTMLElement ? Number.parseFloat(getComputedStyle(modal).opacity) : 1
      const opacity = Number.isNaN(parsedOpacity) ? null : parsedOpacity
      const settled = !button.disabled && !inMotion && runningAnimations === 0 && (opacity === null || opacity >= 0.99)
      return { ready: settled, found: true, disabled: button.disabled, inMotion, runningAnimations, opacity }
    })()`,
    condition: 'state.ready === true',
    timeoutMs: 3_000,
    intervalMs: 25,
  })
  if (!ready.ok) {
    throw new Error(`确认取消暂存弹窗未完成入场并就绪：${JSON.stringify(ready)}`)
  }
}

async function confirmStaleBulkUnstage(
  win: BrowserWindow,
): Promise<'remote-rejected' | 'watcher-auto-closed'> {
  let modalVanishedBeforeClick = false
  try {
    await clickTrustedElement(win, bulkUnstageConfirm)
  } catch (error) {
    // 慢速环境下 GitWatcherService 可能在 restage() 后抢先推送 git-changed，
    // 触发 ChangesLeftPanel 因 summary 变化而自动关闭过期的确认弹窗，属于预期防线。
    if (!(error instanceof Error) || !error.message.startsWith('找不到可点击的验收目标：')) {
      throw error
    }
    modalVanishedBeforeClick = true
  }
  const outcome = await pollRenderer<{
    busy: string | null
    alertText: string
    noticeText: string
    stillStaged: boolean
    workingDirty: boolean
    modalClosed: boolean
  }>(win, {
    probe: `(() => {
      const leavePattern = /(?:^|\\s)[^\\s]+-leave(?:-(?:prepare|start|active))?(?:\\s|$)/
      const panel = document.querySelector('.navigation-island .source-control-navigation')
      const alert = document.querySelector('.project-workspace-alert [role="alert"]')
      const notice = panel?.querySelector('.scm-operation-notice')
      const openDialogs = [...document.querySelectorAll('.ant-modal, .ant-modal-wrap, [role="dialog"]')].filter(node =>
        node instanceof HTMLElement && node.checkVisibility()
      ).length
      const leavingModals = [...document.querySelectorAll('.ant-modal, .ant-modal-wrap, .ant-modal-mask')].filter(node =>
        node instanceof HTMLElement && typeof node.className === 'string' && leavePattern.test(node.className)
      ).length
      return {
        busy: panel?.getAttribute('aria-busy') ?? null,
        alertText: alert?.textContent ?? '',
        noticeText: notice?.textContent ?? '',
        stillStaged: panel?.querySelector('[aria-label="取消暂存 scratch.md"]') !== null,
        workingDirty: panel?.querySelector('[aria-label="暂存 scratch.md"]') !== null,
        modalClosed: openDialogs === 0 && leavingModals === 0,
      }
    })()`,
    // Remote 拒绝或自动刷新关闭弹窗两条防线都必须确保弹窗彻底退场、暂存区未被误取消且无成功提示。
    condition: `state.busy === 'false' && state.modalClosed && state.stillStaged && !state.workingDirty && !state.noticeText.includes('已取消全部暂存') && (state.alertText.includes('Git 状态已变化') || state.alertText === '')`,
    timeoutMs: 3_000,
    intervalMs: 25,
  })
  if (!outcome.ok) {
    throw new Error(
      `过期的确认未按预期拦截或状态未收敛：${JSON.stringify({ modalVanishedBeforeClick, outcome })}`,
    )
  }
  return outcome.value.alertText.includes('Git 状态已变化')
    ? 'remote-rejected'
    : 'watcher-auto-closed'
}

/** 在隔离仓库确认取消暂存须经过确认，且索引变化后须重新确认。 */
export async function verifyBulkUnstage(
  win: BrowserWindow,
  restage: () => Promise<void>,
): Promise<void> {
  const staged = () =>
    win.webContents.executeJavaScript(
      `document.querySelector('.navigation-island button[aria-label="取消暂存 scratch.md"]') !== null`,
    )
  await clickTrustedElement(win, bulkUnstageTrigger)
  await waitForBulkUnstageModalReady(win)
  if (!(await staged())) throw new Error('确认前已取消暂存')
  await clickTrustedElement(win, bulkUnstageCancel)
  await waitForBulkUnstageModalClosed(win, '点击返回取消')
  if (!(await staged())) throw new Error('返回后暂存状态发生变化')
  await clickTrustedElement(win, bulkUnstageTrigger)
  // 先等第二个确认弹窗彻底落稳再触发 restage()，避免弹窗入场动画与 GitWatcherService 防抖重叠。
  await waitForBulkUnstageModalReady(win)
  await restage()
  const staleMode = await confirmStaleBulkUnstage(win)
  console.log('desktop-shell-verify-local: bulk-unstage-stale', { mode: staleMode })
  if (staleMode === 'remote-rejected') {
    await clickTrustedElement(win, '.project-workspace-alert button[aria-label="关闭提示"]')
  }
  await clickTrustedElement(win, bulkUnstageTrigger)
  await waitForBulkUnstageModalReady(win)
  await clickTrustedElement(win, bulkUnstageConfirm)
  await waitForBulkUnstageModalClosed(win, '最终确认取消暂存')
}

/** 通过更改标题的键盘菜单刷新 Git，验证无需切换右侧比较范围。 */
export async function verifyGitRefresh(win: BrowserWindow): Promise<void> {
  await win.webContents.executeJavaScript(`(() => {
    const heading = document.querySelector('.navigation-island ${changesToggle}')
    if (!(heading instanceof HTMLButtonElement)) throw new Error('找不到 Git 更改标题')
    heading.focus()
    heading.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }))
  })()`)
  await clickTrustedElement(win, '[role="menu"][aria-label="更改操作"] [role="menuitem"]')
}
