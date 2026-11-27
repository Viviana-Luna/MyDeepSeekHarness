/** 在隔离的 Electron 工作台验收选择框过渡、关闭后的焦点与减少动态偏好。 */
import type { BrowserWindow, WebContentsView } from 'electron'
import { emulateVerificationMedia } from './desktop-verifier.ts'
import { pollRenderer, waitForMediaFeature } from './verification-wait.ts'

/** 在有界时限内等待原生网页视图显隐状态完成 IPC 同步。 */
export function waitForGuestVisibility(
  guest: WebContentsView,
  expected: boolean,
  timeoutMs = 2_000,
): Promise<boolean> {
  return new Promise(resolve => {
    const deadline = Date.now() + timeoutMs
    const poll = (): void => {
      if (!guest.webContents.isDestroyed() && guest.getVisible() === expected) {
        resolve(true)
        return
      }
      if (Date.now() >= deadline) {
        resolve(false)
        return
      }
      setTimeout(poll, 25)
    }
    poll()
  })
}

/** 窗口在菜单收回期间重新布局时，检查原生网页的实际显隐。 */
export async function verifyBrowserMenuExit(win: BrowserWindow, guest: WebContentsView) {
  const [width = 1440, height = 900] = win.getSize()
  try {
    const opened = await win.webContents.executeJavaScript(`(async () => {
      const anchor = document.querySelector('.project-selector')
      const viewport = document.querySelector('.browser-viewport')
      if (!(anchor instanceof HTMLButtonElement) || !viewport) return false
      anchor.click()
      const deadline = Date.now() + 2500
      while (Date.now() < deadline) {
        await Promise.race([
          new Promise(resolve => requestAnimationFrame(resolve)),
          new Promise(resolve => setTimeout(resolve, 20)),
        ])
        const menu = document.querySelector('[role="menu"][aria-label="专注项目"]')
        if (!(menu instanceof HTMLElement) || getComputedStyle(menu).visibility !== 'visible') continue
        // 验收将真实菜单移到网页上方，并延长退出时长以覆盖软件渲染下的窗口缩放帧。
        const source = menu.getBoundingClientRect()
        const target = viewport.getBoundingClientRect()
        menu.style.translate = (target.left + 12 - source.left) + 'px ' + (target.top + 12 - source.top) + 'px'
        menu.style.setProperty('--menu-exit', '900ms')
        await new Promise(resolve => setTimeout(resolve, 200))
        return true
      }
      return false
    })()`)
    if (!opened || !(await waitForGuestVisibility(guest, false, 1_500)))
      throw new Error('项目菜单展开时没有遮住原生网页')
    await win.webContents.executeJavaScript(`(async () => {
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await Promise.race([
        new Promise(resolve => requestAnimationFrame(resolve)),
        new Promise(resolve => setTimeout(resolve, 40)),
      ])
    })()`)
    win.setSize(width - 12, height)
    const closing = (await win.webContents.executeJavaScript(`(async () => {
      await Promise.race([
        new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        new Promise(resolve => setTimeout(resolve, 120)),
      ])
      const menu = document.querySelector('.project-focus-menu[data-menu-motion="closing"]')
      const opacity = menu ? Number(getComputedStyle(menu).opacity) : 0
      return { ok: menu?.inert === true && opacity > 0, hasMenu: Boolean(menu), inert: menu?.inert ?? false, opacity }
    })()`)) as { ok: boolean }
    if (!closing.ok || guest.getVisible()) {
      throw new Error(
        `布局变化时网页盖住了仍在收回的菜单：${JSON.stringify({ closing, guestVisible: guest.getVisible() })}`,
      )
    }
    await win.webContents.executeJavaScript(`(async () => {
      const menu = document.querySelector('.project-focus-menu[data-menu-motion="closing"]')
      await Promise.allSettled((menu?.getAnimations() ?? []).map(animation => animation.finished))
      const deadline = Date.now() + 2500
      while (Date.now() < deadline && document.querySelector('.project-focus-menu') !== null) {
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    })()`)
    // 菜单卸载后需经 MutationObserver、rAF 与主进程 IPC 才会重新显示 WebContentsView，避免固定延时竞态。
    if (!(await waitForGuestVisibility(guest, true, 2_000))) throw new Error('菜单收回后网页未恢复')
  } finally {
    win.setSize(width, height)
  }
}

async function verifyProjectPickerOpen(
  win: BrowserWindow,
  capture: (name: string) => Promise<void>,
) {
  const opened = (await win.webContents.executeJavaScript(`(async () => {
    const anchor = document.querySelector('.project-selector')
    if (!anchor?.checkVisibility()) return { ok: false, reason: 'missing-anchor' }
    anchor.click()
    let animated = false
    let hasRule = false
    let last = {}
    const deadline = Date.now() + 2500
    while (Date.now() < deadline) {
      const menu = document.querySelector('[role="menu"][aria-label="专注项目"]')
      if (menu instanceof HTMLElement) {
        const style = getComputedStyle(menu)
        const opacity = Number(style.opacity)
        const morphActive = menu.dataset.menuMorph === 'active'
        const animCount = menu.getAnimations().length
        const transitionDuration = Number.parseFloat(style.transitionDuration)
        if ((opacity > 0 && opacity < 1) || morphActive || animCount > 0) animated = true
        if (transitionDuration > 0 || menu.hasAttribute('data-menu-morph')) hasRule = true
        const focused = menu.contains(document.activeElement)
        last = { opacity, morph: menu.dataset.menuMorph ?? null, animCount, transitionDuration, focused, animated, hasRule }
        if (opacity === 1 && !morphActive && focused) return { ok: animated || hasRule, ...last }
      }
      await Promise.race([
        new Promise(resolve => requestAnimationFrame(resolve)),
        new Promise(resolve => setTimeout(resolve, 15)),
      ])
    }
    return { ok: false, reason: 'timeout', ...last }
  })()`)) as { ok: boolean }
  if (!opened.ok) {
    throw new Error(`项目选择菜单未沿触发位置展开或焦点未进入：${JSON.stringify(opened)}`)
  }
  await capture('verify-project-picker-open.png')
}

async function verifyProjectPickerClose(win: BrowserWindow) {
  // 用 MutationObserver 在 Escape 提交瞬间记录 inert/role/pointerEvents 与焦点归还，避免 130ms 退场在首帧前完成。
  const closed = (await win.webContents.executeJavaScript(`(async () => {
    const menu = document.querySelector('[role="menu"][aria-label="专注项目"]')
    const anchor = document.querySelector('.project-selector')
    if (!(menu instanceof HTMLElement) || !(anchor instanceof HTMLElement)) {
      return { ok: false, reason: 'missing-menu' }
    }
    let closingState = null
    const inspectClosing = () => {
      if (closingState !== null) return
      if (!menu.inert && menu.hasAttribute('role')) return
      closingState = {
        focusReturned: document.activeElement === anchor,
        connected: menu.isConnected,
        inert: menu.inert,
        roleRemoved: !menu.hasAttribute('role'),
        pointerEvents: getComputedStyle(menu).pointerEvents,
      }
    }
    const observer = new MutationObserver(inspectClosing)
    observer.observe(menu, { attributes: true })
    try {
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      const closeDeadline = Date.now() + 2500
      while (Date.now() < closeDeadline && closingState === null && menu.isConnected) {
        inspectClosing()
        await Promise.race([
          new Promise(resolve => requestAnimationFrame(resolve)),
          new Promise(resolve => setTimeout(resolve, 15)),
        ])
      }
      inspectClosing()
      await Promise.allSettled(menu.getAnimations().map(animation => animation.finished))
      const unmountDeadline = Date.now() + 2500
      while (Date.now() < unmountDeadline && menu.isConnected) {
        await Promise.race([
          new Promise(resolve => requestAnimationFrame(resolve)),
          new Promise(resolve => setTimeout(resolve, 20)),
        ])
      }
      const expanded = anchor.getAttribute('aria-expanded')
      const ok = Boolean(closingState?.focusReturned && closingState.connected && closingState.inert
        && closingState.roleRemoved && closingState.pointerEvents === 'none'
        && !menu.isConnected && expanded === 'false')
      return { ok, closingState, stillConnected: menu.isConnected, expanded }
    } finally {
      observer.disconnect()
    }
  })()`)) as { ok: boolean }
  if (!closed.ok) {
    throw new Error(`项目选择菜单收回时未退出交互或归还焦点：${JSON.stringify(closed)}`)
  }
}

async function verifyProjectPicker(win: BrowserWindow, capture: (name: string) => Promise<void>) {
  await verifyProjectPickerOpen(win, capture)
  await verifyProjectPickerClose(win)
}

async function verifyGitPicker(win: BrowserWindow, capture: (name: string) => Promise<void>) {
  const opened = (await win.webContents.executeJavaScript(
    `(async () => {
      const select = document.querySelector('.git-review-toolbar select')
      if (!(select instanceof HTMLSelectElement) || !select.checkVisibility()) {
        return { ok: false, reason: 'missing-select' }
      }
      select.focus()
      select.showPicker()
      let animated = false
      let last = {}
      const deadline = Date.now() + 2500
      while (Date.now() < deadline) {
        const style = getComputedStyle(select, '::picker(select)')
        const opacity = Number(style.opacity)
        const duration = Number.parseFloat(style.transitionDuration)
        const hasRule = duration > 0 && (style.transitionProperty.includes('opacity') || style.transitionProperty.includes('all'))
        if (opacity > 0 && opacity < 1) animated = true
        const open = select.matches(':open')
        last = { open, opacity, duration, property: style.transitionProperty, animated, hasRule }
        if (open && opacity === 1) return { ok: animated || hasRule, ...last }
        await Promise.race([
          new Promise(resolve => requestAnimationFrame(resolve)),
          new Promise(resolve => setTimeout(resolve, 15)),
        ])
      }
      return { ok: false, reason: 'timeout', ...last }
    })()`,
    true,
  )) as { ok: boolean }
  if (!opened.ok) {
    throw new Error(`Git 比较范围的原生选项层未展开或没有过渡：${JSON.stringify(opened)}`)
  }
  await capture('verify-git-picker-open.png')
  // 先在页面内启动收回观察再发出 ESC，避免 130ms 关闭过渡在跨进程往返期间已结束。
  const closeSampling = win.webContents.executeJavaScript(`(async () => {
    const select = document.querySelector('.git-review-toolbar select')
    if (!(select instanceof HTMLSelectElement)) return { ok: false, reason: 'missing-select' }
    let animated = false
    let last = {}
    const deadline = Date.now() + 2500
    while (Date.now() < deadline) {
      const style = getComputedStyle(select, '::picker(select)')
      const opacity = Number(style.opacity)
      const duration = Number.parseFloat(style.transitionDuration)
      const hasRule = duration > 0 && (style.transitionProperty.includes('opacity') || style.transitionProperty.includes('all'))
      if (opacity > 0 && opacity < 1) animated = true
      const open = select.matches(':open')
      const focused = document.activeElement === select
      last = { open, opacity, duration, property: style.transitionProperty, focused, animated, hasRule }
      if (!open && opacity === 0) return { ok: (animated || hasRule) && focused, ...last }
      await Promise.race([
        new Promise(resolve => requestAnimationFrame(resolve)),
        new Promise(resolve => setTimeout(resolve, 15)),
      ])
    }
    return { ok: false, reason: 'timeout', ...last }
  })()`)
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' })
  const closed = (await closeSampling) as { ok: boolean }
  if (!closed.ok) {
    throw new Error(`Git 比较范围未收回或键盘焦点未保留：${JSON.stringify(closed)}`)
  }
}

/** 使用真实菜单与 Chromium 原生选项层验证展开和收回，并恢复系统媒体偏好。 */
export async function verifyWorkspacePickers(
  win: BrowserWindow,
  capture: (name: string) => Promise<void>,
): Promise<void> {
  await verifyProjectPicker(win, capture)
  await verifyGitPicker(win, capture)
  try {
    await emulateVerificationMedia(win, [{ name: 'prefers-reduced-motion', value: 'reduce' }])
    await waitForMediaFeature(win, '(prefers-reduced-motion: reduce)')
    await win.webContents.executeJavaScript(`document.querySelector('.project-selector')?.click()`)
    const reduced = await pollRenderer<Record<string, unknown>>(win, {
      probe: `(() => {
        const menu = document.querySelector('[role="menu"][aria-label="专注项目"]')
        const select = document.querySelector('.git-review-toolbar select')
        const animCount = menu ? menu.getAnimations().length : -1
        const pickerDuration = select ? getComputedStyle(select, '::picker(select)').transitionDuration : ''
        return {
          ok: Boolean(menu) && animCount === 0 && pickerDuration === '0s',
          hasMenu: Boolean(menu), animCount, pickerDuration,
        }
      })()`,
      condition: 'state.ok === true',
      timeoutMs: 1_500,
    })
    await win.webContents.executeJavaScript(`document.querySelector('.project-selector')?.click()`)
    if (!reduced.ok) throw new Error(`选择框没有遵守减少动态设置：${JSON.stringify(reduced)}`)
  } finally {
    await emulateVerificationMedia(win)
  }
  console.log('desktop-shell-verify-local: workspace-picker-motion', {
    project: true,
    git: true,
    reducedMotion: true,
  })
}
