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

/** 在隔离仓库确认取消暂存须经过确认，且索引变化后须重新确认。 */
export async function verifyBulkUnstage(
  win: BrowserWindow,
  restage: () => Promise<void>,
): Promise<void> {
  const trigger = '.navigation-island button[aria-label="取消暂存全部更改"]'
  const staged = () =>
    win.webContents.executeJavaScript(
      `document.querySelector('.navigation-island button[aria-label="取消暂存 scratch.md"]') !== null`,
    )
  await clickTrustedElement(win, trigger)
  if (!(await staged())) throw new Error('确认前已取消暂存')
  await clickTrustedElement(win, '.ant-modal-footer button[aria-label="返回"]')
  if (!(await staged())) throw new Error('返回后暂存状态发生变化')
  await clickTrustedElement(win, trigger)
  await restage()
  await clickTrustedElement(win, '.ant-modal-footer button[aria-label="确认取消暂存"]')
  const rejected = await pollRenderer<{
    busy: string | null
    alertText: string
    stillStaged: boolean
  }>(win, {
    probe: `(() => {
      const panel = document.querySelector('.navigation-island .source-control-navigation')
      const alert = document.querySelector('.project-workspace-alert [role="alert"]')
      return {
        busy: panel?.getAttribute('aria-busy') ?? null,
        alertText: alert?.textContent ?? '',
        stillStaged: panel?.querySelector('[aria-label="取消暂存 scratch.md"]') !== null,
      }
    })()`,
    condition: `state.busy === 'false' && state.alertText.includes('Git 状态已变化') && state.stillStaged`,
    timeoutMs: 3_000,
    intervalMs: 25,
  })
  if (!rejected.ok) {
    throw new Error(`过期的确认通过 Remote 取消了新暂存版本：${JSON.stringify(rejected)}`)
  }
  await clickTrustedElement(win, '.project-workspace-alert button[aria-label="关闭提示"]')
  await clickTrustedElement(win, trigger)
  await clickTrustedElement(win, '.ant-modal-footer button[aria-label="确认取消暂存"]')
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
