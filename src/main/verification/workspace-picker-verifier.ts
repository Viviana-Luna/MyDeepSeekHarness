/** 在隔离的 Electron 工作台验收选择框过渡、关闭后的焦点与减少动态偏好。 */
import type { BrowserWindow, WebContentsView } from 'electron'
import { emulateVerificationMedia } from './desktop-verifier.ts'

/** 窗口在菜单收回期间重新布局时，检查原生网页的实际显隐。 */
export async function verifyBrowserMenuExit(win: BrowserWindow, guest: WebContentsView) {
  const [width = 1440, height = 900] = win.getSize()
  try {
    const opened = await win.webContents.executeJavaScript(`(async () => {
      const anchor = document.querySelector('.project-selector');
      const viewport = document.querySelector('.browser-viewport');
      if (!(anchor instanceof HTMLButtonElement) || !viewport) return false;
      anchor.click();
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const menu = document.querySelector('[role="menu"][aria-label="专注项目"]');
        if (!(menu instanceof HTMLElement) || getComputedStyle(menu).visibility !== 'visible') continue;
        // 验收将真实菜单移到网页上方，避免平台边距和项目数影响重叠。
        const source = menu.getBoundingClientRect();
        const target = viewport.getBoundingClientRect();
        menu.style.translate = (target.left + 12 - source.left) + 'px ' + (target.top + 12 - source.top) + 'px';
        menu.style.setProperty('--menu-exit', '400ms');
        await new Promise(resolve => setTimeout(resolve, 250));
        return true;
      }
      return false;
    })()`)
    if (!opened || guest.getVisible()) throw new Error('项目菜单展开时没有遮住原生网页')
    await win.webContents.executeJavaScript(`(async () => {
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise(resolve => requestAnimationFrame(resolve));
    })()`)
    win.setSize(width - 12, height)
    const closing = await win.webContents.executeJavaScript(`(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const menu = document.querySelector('.project-focus-menu[data-menu-motion="closing"]');
      return menu?.inert === true && Number(getComputedStyle(menu).opacity) > 0;
    })()`)
    if (!closing || guest.getVisible()) throw new Error('布局变化时网页盖住了仍在收回的菜单')
    await win.webContents.executeJavaScript(`(async () => {
      const menu = document.querySelector('.project-focus-menu[data-menu-motion="closing"]');
      await Promise.allSettled((menu?.getAnimations() ?? []).map(animation => animation.finished));
      await new Promise(resolve => setTimeout(resolve, 80));
    })()`)
    if (!guest.getVisible()) throw new Error('菜单收回后网页未恢复')
  } finally {
    win.setSize(width, height)
  }
}

async function verifyProjectPicker(win: BrowserWindow, capture: (name: string) => Promise<void>) {
  const opened = await win.webContents.executeJavaScript(`(async () => {
    const anchor = document.querySelector('.project-selector');
    if (!anchor?.checkVisibility()) return false;
    anchor.click();
    let animated = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const menu = document.querySelector('[role="menu"][aria-label="专注项目"]');
      if (menu instanceof HTMLElement) {
        const opacity = Number(getComputedStyle(menu).opacity);
        if (opacity > 0 && opacity < 1) animated = true;
        if (opacity === 1 && menu.contains(document.activeElement)) return animated;
      }
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    return false;
  })()`)
  if (!opened) throw new Error('项目选择菜单未沿触发位置展开或焦点未进入')
  await capture('verify-project-picker-open.png')
  const closed = await win.webContents.executeJavaScript(`(async () => {
    const menu = document.querySelector('[role="menu"][aria-label="专注项目"]');
    const anchor = document.querySelector('.project-selector');
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (document.activeElement !== anchor || !menu.isConnected || !menu.inert
      || menu.hasAttribute('role') || getComputedStyle(menu).pointerEvents !== 'none') return false;
    await Promise.allSettled(menu.getAnimations().map(animation => animation.finished));
    for (let attempt = 0; attempt < 30 && menu.isConnected; attempt += 1) {
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    return !menu.isConnected && anchor.getAttribute('aria-expanded') === 'false';
  })()`)
  if (!closed) throw new Error('项目选择菜单收回时未退出交互或归还焦点')
}

async function verifyGitPicker(win: BrowserWindow, capture: (name: string) => Promise<void>) {
  const opened = await win.webContents.executeJavaScript(
    `(async () => {
    const select = document.querySelector('.git-review-toolbar select');
    if (!(select instanceof HTMLSelectElement) || !select.checkVisibility()) return false;
    select.focus();
    select.showPicker();
    let animated = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const opacity = Number(getComputedStyle(select, '::picker(select)').opacity);
      if (opacity > 0 && opacity < 1) animated = true;
      if (select.matches(':open') && opacity === 1) return animated;
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    return false;
  })()`,
    true,
  )
  if (!opened) throw new Error('Git 比较范围的原生选项层未展开或没有过渡')
  await capture('verify-git-picker-open.png')
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' })
  const closed = await win.webContents.executeJavaScript(`(async () => {
    const select = document.querySelector('.git-review-toolbar select');
    let animated = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const opacity = Number(getComputedStyle(select, '::picker(select)').opacity);
      if (opacity > 0 && opacity < 1) animated = true;
      if (!select.matches(':open') && opacity === 0) return animated && document.activeElement === select;
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    return false;
  })()`)
  if (!closed) throw new Error('Git 比较范围未收回或键盘焦点未保留')
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
    const reduced = await win.webContents.executeJavaScript(`(async () => {
      const anchor = document.querySelector('.project-selector');
      const select = document.querySelector('.git-review-toolbar select');
      anchor.click();
      await new Promise(resolve => requestAnimationFrame(resolve));
      const menu = document.querySelector('[role="menu"][aria-label="专注项目"]');
      const staticMenu = menu && menu.getAnimations().length === 0;
      anchor.click();
      return staticMenu && getComputedStyle(select, '::picker(select)').transitionDuration === '0s';
    })()`)
    if (!reduced) throw new Error('选择框没有遵守减少动态设置')
  } finally {
    await emulateVerificationMedia(win)
  }
  console.log('desktop-shell-verify-local: workspace-picker-motion', {
    project: true,
    git: true,
    reducedMotion: true,
  })
}
