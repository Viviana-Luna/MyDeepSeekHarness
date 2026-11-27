import type { BrowserWindow } from 'electron'
import { clickTrustedElement } from './desktop-verifier.ts'
import { pollCondition, pollRenderer } from './verification-wait.ts'

async function waitFor(test: () => boolean): Promise<void> {
  /* oxlint-disable no-await-in-loop -- 原生窗口变化需要有界串行轮询，不能并发读取同一状态。 */
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (test()) return
    await new Promise(resolve => {
      setTimeout(resolve, 25)
    })
  }
  /* oxlint-enable no-await-in-loop */
  throw new Error('自定义窗口按钮状态未及时更新')
}

/** 前台验收覆盖真正的系统窗口变化；后台验收只检查布局，避免抢占用户焦点。 */
export async function verifyWindowControls(
  win: BrowserWindow,
  foreground: boolean,
): Promise<boolean> {
  if (process.platform !== 'win32') return true
  const inspect = async () =>
    (await win.webContents.executeJavaScript(`(() => {
    const buttons = [...document.querySelectorAll('.window-controls button')]
    const group = document.querySelector('.window-controls')
    const chrome = document.querySelector('.windows-chrome')
    if (!(group instanceof HTMLElement) || !(chrome instanceof HTMLElement)) return { ready: false, reason: '窗口按钮尚未挂载' }
    const bounds = group.getBoundingClientRect()
    const parent = chrome.parentElement
    if (!(parent instanceof HTMLElement)) return { ready: false, reason: '窗口按钮缺少布局容器' }
    const inTopbar = parent.classList.contains('session-chrome')
    const tabsVisible = document.querySelector('.app-shell')?.getAttribute('data-session-tabs-visible') === 'true'
    if (inTopbar !== tabsVisible || (!inTopbar && !parent.classList.contains('island'))) return { ready: false, reason: '窗口按钮未跟随会话顶栏状态' }
    const parentBounds = parent.getBoundingClientRect()
    const style = getComputedStyle(chrome)
    const tabs = parent.querySelector('.session-tabs-frame')?.getBoundingClientRect()
    const floating = document.querySelector('[data-floating-tab-actions="true"]')?.getBoundingClientRect()
    const tools = document.querySelector('.main-island:not([hidden]) .work-tab-panel:not([hidden]) .conversation-tools, .main-island:not([hidden]):not(.workbench-surface) .conversation-tools')?.getBoundingClientRect()
    const splitActive = document.querySelector('.app-shell')?.hasAttribute('data-workspace-split') === true
    const capsuleAligned = floating !== undefined && floating.width > 0 && floating.height > 0
      && (inTopbar || !parent.classList.contains('main-island') || floating.top >= bounds.bottom + 8)
      && (splitActive || tools === undefined || (Math.abs(tools.top - (floating.bottom + 5)) <= 2 && Math.abs(tools.right - (floating.right - 4)) <= 2))
    const edge = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--window-edge')) || 8
    const layoutReady = inTopbar
      ? Math.abs(bounds.top - parentBounds.top) <= 1 && Math.abs(bounds.right - parentBounds.right) <= 1
        && bounds.bottom <= parentBounds.bottom + 1 && Math.abs(parentBounds.top - edge) <= 1
        && tabs !== undefined && tabs.right <= bounds.left && capsuleAligned
        && style.borderBottomWidth === '0px' && style.backgroundColor !== 'rgba(0, 0, 0, 0)'
      : Math.abs(bounds.top - parentBounds.top - 1) <= 1
        && bounds.right < parentBounds.right && parentBounds.right - bounds.right <= 10
        && bounds.bottom <= parentBounds.top + 34 && style.borderBottomWidth === '0px' && capsuleAligned
    const ready = layoutReady && document.querySelectorAll('.windows-chrome').length === 1 && buttons.length === 3
      && getComputedStyle(chrome).getPropertyValue('-webkit-app-region') === 'drag'
      && buttons.every(button => button instanceof HTMLButtonElement && !button.disabled
        && button.getAttribute('aria-label')?.endsWith('窗口')
        && getComputedStyle(button).getPropertyValue('-webkit-app-region') === 'no-drag')
    return { ready, inTopbar, capsuleAligned, floating: floating?.toJSON(), tools: tools?.toJSON(), bounds: bounds.toJSON(), parent: parentBounds.toJSON(), border: style.borderBottomStyle,
      region: getComputedStyle(chrome).getPropertyValue('-webkit-app-region'),
      buttons: buttons.map(button => ({ label: button.getAttribute('aria-label'), disabled: button.disabled, region: getComputedStyle(button).getPropertyValue('-webkit-app-region') })) }
  })()`)) as { ready: boolean }
  let layout = await inspect()
  // React 挂载后仍要等待受限 IPC 读取窗口能力；布局出现不能代表按钮已经可用。
  /* oxlint-disable no-await-in-loop -- 顺序等待异步窗口状态，失败时保留最后一次实际布局。 */
  for (let attempt = 0; !layout.ready && attempt < 50; attempt += 1) {
    await new Promise(resolve => {
      setTimeout(resolve, 50)
    })
    layout = await inspect()
  }
  /* oxlint-enable no-await-in-loop */
  if (!layout.ready) {
    console.error('窗口按钮布局诊断：', {
      layout,
      resizable: win.isResizable(),
      maximizable: win.isMaximizable(),
      minimizable: win.isMinimizable(),
    })
    throw new Error('三个自定义窗口按钮的位置、唯一性或交互区域无效')
  }
  if (!foreground) return true
  const normal = win.getBounds()
  await clickTrustedElement(win, '[data-window-action="toggle-maximize"]')
  await waitFor(() => win.isMaximized())
  const maximizeLabel = await pollRenderer<string | null>(win, {
    probe: `document.querySelector('[data-window-action="toggle-maximize"]')?.getAttribute('aria-label') ?? null`,
    condition: `state === '还原窗口'`,
    timeoutMs: 2_000,
  })
  if (!maximizeLabel.ok) {
    throw new Error(`最大化后未呈现还原按钮：${JSON.stringify(maximizeLabel)}`)
  }
  await clickTrustedElement(win, '[data-window-action="toggle-maximize"]')
  await waitFor(() => !win.isMaximized())
  await clickTrustedElement(win, '[data-window-action="minimize"]')
  await waitFor(() => win.isMinimized())
  win.restore()
  win.show()
  win.focus()
  await waitFor(() => !win.isMinimized() && win.isFocused())
  const boundsRestored = await pollCondition(
    () => {
      const current = win.getBounds()
      return (
        Math.abs(current.width - normal.width) <= 1 && Math.abs(current.height - normal.height) <= 1
      )
    },
    { timeoutMs: 1_500 },
  )
  const restored = win.getBounds()
  if (!boundsRestored) {
    throw new Error(`窗口还原后尺寸未恢复：${JSON.stringify({ normal, restored })}`)
  }
  return true
}
