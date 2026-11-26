/** 用隔离仓库的长提交记录验证左右源代码管理的分区和输入事件。 */
import type { BrowserWindow } from 'electron'
import { clickTrustedElement } from './desktop-verifier.ts'

const graphToggle = 'button[aria-label="图表面板"]'
const changesToggle = 'button[aria-label="更改面板"]'
const divider = '[role="separator"][aria-label="调整提交图高度"]'
const historyContent = '.scm-history > .scm-pane-content'

async function readPanes(win: BrowserWindow, scope: string) {
  return (await win.webContents.executeJavaScript(`(() => {
    const panes = document.querySelector(${JSON.stringify(`${scope} .scm-panes`)});
    const changes = panes?.querySelector('.scm-pane:first-child > .scm-pane-content');
    const history = panes?.querySelector(${JSON.stringify(historyContent)});
    if (!changes || !history) throw new Error('源代码管理缺少更改或图表区域');
    return { changes: changes.clientHeight, history: history.clientHeight };
  })()`)) as { changes: number; history: number }
}

async function growHistory(
  win: BrowserWindow,
  scope: string,
  distance = 128,
  foldBeforeRelease = false,
) {
  const point = (await win.webContents.executeJavaScript(`(() => {
    const bounds = document.querySelector(${JSON.stringify(`${scope} ${divider}`)})?.getBoundingClientRect();
    return bounds && { x: Math.round(bounds.left + bounds.width / 2), y: Math.round(bounds.top + bounds.height / 2) };
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
    if (foldBeforeRelease)
      await win.webContents.executeJavaScript(`(async () => {
        await new Promise(resolve => requestAnimationFrame(resolve));
        // 指针仍由分隔线捕获，通过按钮激活模拟键盘折叠。
        document.querySelector(${JSON.stringify(`${scope} ${graphToggle}`)}).click();
        await new Promise(resolve => requestAnimationFrame(resolve));
      })()`)
  } finally {
    win.webContents.sendInputEvent({ type: 'mouseUp', ...moved, button: 'left', clickCount: 1 })
  }
  await win.webContents.executeJavaScript(
    'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  )
}

/** 检查真实拖动、滚到最早提交、两区独立收起和高度恢复。 */
export async function verifySourceControlSections(
  win: BrowserWindow,
  capture: (name: string) => Promise<void>,
  placement: 'left' | 'right' = 'left',
): Promise<void> {
  const scope = placement === 'left' ? '.navigation-island' : '.info-island'
  const scopedGraphToggle = `${scope} ${graphToggle}`
  const scopedChangesToggle = `${scope} ${changesToggle}`
  const scopedDivider = JSON.stringify(`${scope} ${divider}`)
  const scopedHistory = JSON.stringify(`${scope} ${historyContent}`)
  const initial = await readPanes(win, scope)
  await growHistory(win, scope)
  const resized = await readPanes(win, scope)
  if (resized.history <= Math.max(320, initial.history + 64) || resized.changes >= initial.changes)
    throw new Error('拖动分隔线没有扩大提交图并缩小更改区')
  const scrollsToEnd = await win.webContents.executeJavaScript(`(() => {
    const history = document.querySelector(${scopedHistory});
    const rows = history?.querySelectorAll('.git-commit-row');
    if (!rows || rows.length < 12) return false;
    history.scrollTop = history.scrollHeight;
    const last = rows[rows.length - 1].getBoundingClientRect();
    const viewport = history.getBoundingClientRect();
    return history.scrollTop > 0 && last.top >= viewport.top && last.bottom <= viewport.bottom
      && history.scrollWidth <= history.clientWidth + 1;
  })()`)
  if (!scrollsToEnd) throw new Error('图表无法滚到最早的一条提交或出现横向滚动条')
  await capture(`verify-scm-history-${placement}-resized.png`)
  await clickTrustedElement(win, scopedGraphToggle)
  const changesOnly = await readPanes(win, scope)
  await clickTrustedElement(win, scopedChangesToggle)
  const bothClosed = await readPanes(win, scope)
  await clickTrustedElement(win, scopedGraphToggle)
  const historyOnly = await readPanes(win, scope)
  await clickTrustedElement(win, scopedChangesToggle)
  const restored = await readPanes(win, scope)
  if (
    changesOnly.history !== 0 ||
    changesOnly.changes <= resized.changes ||
    bothClosed.changes !== 0 ||
    bothClosed.history !== 0 ||
    historyOnly.changes !== 0 ||
    historyOnly.history <= resized.history ||
    Math.abs(restored.history - resized.history) > 1
  )
    throw new Error('更改与图表未能独立收起、让出空间并恢复拖动比例')
  await win.webContents.executeJavaScript(`(() => {
    const separator = document.querySelector(${scopedDivider});
    separator.focus();
    separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  })()`)
  const nudged = await readPanes(win, scope)
  if (nudged.history <= restored.history) throw new Error('键盘无法调高提交图')
  await growHistory(win, scope, 32, true)
  if ((await readPanes(win, scope)).history !== 0) throw new Error('拖动期间未能折叠图表')
  await clickTrustedElement(win, scopedGraphToggle)
  const reopened = await readPanes(win, scope)
  await growHistory(win, scope, 32)
  if ((await readPanes(win, scope)).history <= reopened.history)
    throw new Error('折叠中断拖动后无法再次调整图表高度')
  await win.webContents.executeJavaScript(`(() => {
    const separator = document.querySelector(${scopedDivider});
    separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    separator.blur();
    document.querySelector(${scopedHistory}).scrollTop = 0;
  })()`)
  const reset = await readPanes(win, scope)
  if (Math.abs(reset.history - initial.history) > 1) throw new Error('提交图未恢复默认高度')
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
  const rejected = await win.webContents.executeJavaScript(`(async () => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const panel = document.querySelector('.navigation-island .source-control-navigation')
      const alert = document.querySelector('.project-workspace-alert [role="alert"]')
      if (panel?.getAttribute('aria-busy') === 'false' && alert?.textContent.includes('Git 状态已变化'))
        return panel.querySelector('[aria-label="取消暂存 scratch.md"]') !== null
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return false
  })()`)
  if (!rejected) throw new Error('过期的确认通过 Remote 取消了新暂存版本')
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
