import type { BrowserWindow, WebContents } from 'electron'

const NAVIGATION_KEYS = [
  { key: 'BrowserBack', code: 'BrowserBack', windowsVirtualKeyCode: 166 },
  { key: 'BrowserForward', code: 'BrowserForward', windowsVirtualKeyCode: 167 },
  { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, modifiers: 1 },
  { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, modifiers: 1 },
] as const

async function dispatchNavigationProbes(
  contents: WebContents,
  startupUrl: string,
  assertStable: () => Promise<void>,
): Promise<void> {
  /* oxlint-disable no-await-in-loop -- 连续操作同一窗口并逐次确认页面未跳转。 */
  for (const button of ['back', 'forward']) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await contents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type,
        button,
        x: 600,
        y: 300,
        clickCount: 1,
      })
    }
    await assertStable()
  }
  for (const key of NAVIGATION_KEYS) {
    await contents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key })
    await contents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
    await assertStable()
  }
  await contents.executeJavaScript('history.back(); history.forward()')
  await assertStable()
  await contents.executeJavaScript(
    `setTimeout(()=>location.assign(${JSON.stringify(startupUrl)}),0)`,
  )
  await assertStable()
  /* oxlint-enable no-await-in-loop */
}

/** 使用真实 Chromium 侧键、浏览快捷键与页面导航验证，草稿和订阅必须保持原实例。 */
export async function verifyWorkspaceNavigation(
  win: BrowserWindow,
  startupUrl: string,
  streamsAlive: () => boolean,
): Promise<void> {
  const contents = win.webContents
  const rendererUrl = contents.getURL()
  const history = contents.navigationHistory
  if (history.canGoBack() || history.canGoForward() || history.getAllEntries().length !== 1) {
    throw new Error(
      '工作台历史仍包含启动页：' + JSON.stringify(history.getAllEntries().map(entry => entry.url)),
    )
  }
  const draft = '回退验收：保留未发送内容'
  const original = (await contents.executeJavaScript(`(() => {
    const input=document.querySelector('.main-island .composer-card textarea')
    if (!(input instanceof HTMLTextAreaElement)) throw new Error('工作台输入框未就绪')
    const value=input.value
    document.documentElement.dataset.navigationProbe='ready'
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(draft)})
    input.dispatchEvent(new Event('input',{bubbles:true}))
    return value
  })()`)) as string
  if (!contents.debugger.isAttached()) contents.debugger.attach('1.3')
  const assertStable = async () => {
    await contents.executeJavaScript('new Promise(resolve=>setTimeout(resolve,150))')
    const intact =
      await contents.executeJavaScript(`document.documentElement.dataset.navigationProbe==='ready'
      && document.querySelector('.main-island .composer-card textarea')?.value===${JSON.stringify(draft)}`)
    if (contents.getURL() !== rendererUrl || !intact || !streamsAlive()) {
      const detail = {
        url: contents.getURL(),
        expectedUrl: rendererUrl,
        intact,
        alive: streamsAlive(),
      }
      throw new Error(`回退操作破坏工作台、草稿或会话订阅：${JSON.stringify(detail)}`)
    }
  }
  try {
    await dispatchNavigationProbes(contents, startupUrl, assertStable)
    console.log('desktop-shell-verify-local: workspace-navigation', {
      startupHistoryRemoved: true,
      sideButtons: true,
      keyboard: true,
      blockedStartup: true,
      draftPreserved: true,
      streamsPreserved: true,
    })
  } finally {
    if (!contents.isDestroyed() && contents.getURL() === rendererUrl) {
      await contents.executeJavaScript(`(() => {
        delete document.documentElement.dataset.navigationProbe
        const input=document.querySelector('.main-island .composer-card textarea')
        if (input) { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(original)}); input.dispatchEvent(new Event('input',{bubbles:true})) }
      })()`)
    }
  }
}
