import { session, WebContentsView, type BrowserWindow } from 'electron'
import type { DesktopSessionFrame } from '../../shared/session-live.ts'
import { clickTrustedElement, emulateVerificationMedia } from './desktop-verifier.ts'
import { verifySourceControlSections } from './source-control-sections-verifier.ts'
import { verifyBrowserMenuExit, verifyWorkspacePickers } from './workspace-picker-verifier.ts'

const settle = (win: BrowserWindow) =>
  win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 250))')
/**
 * 通过“新建工作标签”菜单打开一个浏览器标签，返回浏览器请求使用的标签标识。
 * 顶部标签的 data-session-tab 形如 `browser:<标识>`，浏览器控制器只接收冒号后的部分。
 */
async function openBrowserTab(win: BrowserWindow): Promise<string> {
  await clickTrustedElement(win, '[aria-label="新建工作标签"]')
  const tabId = (await win.webContents.executeJavaScript(`(async () => {
    const wait = async predicate => { for (let i = 0; i < 80; i++) { const value = predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)) } return null }
    const item = await wait(() => [...document.querySelectorAll('[role="menuitem"]')].find(node => node.checkVisibility() && node.textContent.includes('新浏览器')))
    if (!item) return null
    item.click()
    const tab = await wait(() => document.querySelector('[data-work-tab="browser"]'))
    return tab?.dataset.sessionTab?.replace(/^browser:/, '') ?? null
  })()`)) as string | null
  if (tabId === null) throw new Error('无法通过新建工作标签菜单打开浏览器')
  return tabId
}

/** 使用实际 renderer、IPC 和独立网页进程验证；样本只存在隔离验收窗口。 */
export async function verifyWorkspaceReview(
  win: BrowserWindow,
  sessionId: string,
  emit: (frame: DesktopSessionFrame) => void,
  appearance: (scheme: 'light' | 'dark') => void,
  capture: (name: string) => Promise<void>,
  openRight: (id: string) => Promise<void>,
): Promise<void> {
  const events: Array<{ type: string; seq: number; time: number; data: unknown }> = []
  const add = (type: string, data: unknown) => {
    events.push({ type, seq: events.length, time: 1_700_000_000_000 + events.length * 100, data })
  }
  add('turn/start', { turn: 1 })
  add('step/start', { turn: 1, step: 1 })
  add('request/header', {
    header: {
      tools: [
        {
          name: 'exec_command',
          description: '运行命令',
          parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
        },
      ],
    },
  })
  add('user/message', {
    content: [{ type: 'text', text: '检查项目，保留全部改动' }],
    source: { kind: 'user' },
  })
  add('assistant/message', {
    turn: 1,
    step: 1,
    message: { content: [{ type: 'text', text: '先检查项目入口与构建配置。' }] },
  })
  for (let index = 0; index < 220; index++) {
    add('tool/call', {
      turn: 1,
      step: 1,
      callId: `verify-${index}`,
      name: 'exec_command',
      arguments: JSON.stringify({
        cmd: `读取项目文件 ${index}`,
        detail: '保留长参数原文。'.repeat(100),
      }),
    })
    add('tool/result', {
      turn: 1,
      step: 1,
      message: {
        source: { callId: `verify-${index}` },
        content: [
          {
            type: 'tool-result',
            isError: false,
            content: [
              {
                type: 'text',
                text: `文件 ${index} 读取完成\n` + '这是一行实际结果。\n'.repeat(80),
              },
            ],
          },
        ],
      },
    })
  }
  add('turn/end', { turn: 1 })
  emit({ type: 'session/snapshot', sessionId, events, lastSeq: events.length - 1, hasMore: false })
  await clickTrustedElement(win, '.conversation-view-tabs [data-view="trajectory"]')
  await settle(win)
  /* oxlint-disable no-await-in-loop */
  for (const sample of [
    { width: 1280, height: 800, scheme: 'dark' as const },
    { width: 1280, height: 800, scheme: 'light' as const },
    { width: 1800, height: 1000, scheme: 'dark' as const },
    { width: 1800, height: 1000, scheme: 'light' as const },
  ]) {
    win.setSize(sample.width, sample.height)
    appearance(sample.scheme)
    await settle(win)
    await win.webContents.executeJavaScript(
      `document.querySelector('[aria-label="轨迹记录表"] [data-kind="tool"]:last-child')?.click()`,
    )
    await settle(win)
    const result = (await win.webContents.executeJavaScript(`(() => {
      const table = document.querySelector('[aria-label="轨迹记录表"]')
      const inspector = document.querySelector('[aria-label="轨迹记录检查器"]')
      const rows = [...table.querySelectorAll('[data-record-id]')]
      const a = table.getBoundingClientRect(), b = inspector?.getBoundingClientRect()
      const tools = document.querySelector('.work-tab-panel:not([hidden]) .conversation-tools')
      const rail = tools?.getBoundingClientRect()
      const tabs = inspector?.querySelector('[role="tablist"]')
      return { dense: rows.length > 10 && rows.every(row => Math.abs(row.getBoundingClientRect().height - 30) < 1),
         sideTools: rail?.width === 28 && b.right <= rail.left && [...tools.querySelectorAll('button')].every(button => button.getBoundingClientRect().height === 28),
         noHeader: !document.querySelector('.conversation-header'),
        virtual: rows.length < 100 && Number(table.getAttribute('aria-rowcount')) > 220,
        separated: b && b.left >= a.right - 1 && b.right <= innerWidth && b.bottom <= innerHeight,
        noInlineJson: !table.querySelector('pre, .cm-editor, details'),
        composer: !!document.querySelector('.main-island .composer-dock')?.checkVisibility(),
        wrapped: [...inspector.querySelectorAll('.cm-scroller')].every(element => element.scrollWidth <= element.clientWidth + 1),
        tabs: ['概述','参数','结果','Schema','计时'].every(label => [...inspector.querySelectorAll('[role="tab"]')].some(tab => tab.textContent === label)),
        tabsFit: tabs && tabs.scrollWidth <= tabs.clientWidth + 1,
        scroll: inspector.querySelector('[role="tabpanel"]').scrollHeight > inspector.querySelector('[role="tabpanel"]').clientHeight,
        overflow: document.documentElement.scrollWidth === innerWidth }
    })()`)) as Record<string, boolean>
    console.log('desktop-shell-verify-local: trajectory-review', sample, result)
    if (Object.values(result).some(value => value !== true))
      throw new Error('轨迹记录表、虚拟列表或独立检查器验收失败')
    await capture(`verify-trajectory-${sample.width}-${sample.scheme}.png`)
  }
  /* oxlint-enable no-await-in-loop */
  await emulateVerificationMedia(win, [
    { name: 'forced-colors', value: 'active' },
    { name: 'prefers-reduced-motion', value: 'reduce' },
  ])
  const accessible = await win.webContents.executeJavaScript(`(() => {
    const overview = document.querySelector('[aria-label="轨迹概览"]')
    const input = document.querySelector('[aria-label="搜索轨迹"]')
    const selected = document.querySelector('[aria-label="轨迹记录表"] [aria-selected="true"]')
    if (!(overview instanceof HTMLElement) || !(input instanceof HTMLInputElement)
      || !(selected instanceof HTMLElement)) return false
    input.focus()
    return matchMedia('(forced-colors: active)').matches
      && matchMedia('(prefers-reduced-motion: reduce)').matches
      && parseFloat(getComputedStyle(overview).borderTopWidth) > 0
      && parseFloat(getComputedStyle(input.parentElement).outlineWidth) > 0
      && parseFloat(getComputedStyle(selected).outlineWidth) > 0
  })()`)
  if (!accessible) throw new Error('轨迹高对比度或键盘焦点降级未生效')
  await capture('verify-trajectory-accessible.png')
  await emulateVerificationMedia(win, [])
  await clickTrustedElement(win, '.conversation-view-tabs [data-view="conversation"]')
  emit({ type: 'session/snapshot', sessionId, events: [], lastSeq: 0, hasMore: false })
  win.setSize(1440, 900)
  await settle(win)
  // 浏览器以顶部工作标签打开（见 docs/renderer.md）；请求必须带上该标签的浏览器标识。
  const browserTabId = await openBrowserTab(win)
  const browserRequest = (fields: string) =>
    `window.dshDesktop.browser.request({tabId:${JSON.stringify(browserTabId)},${fields}})`
  const partition = session.fromPartition('persist:mydsh-browser-v1')
  await partition.protocol.handle(
    'https',
    request =>
      new Response(
        `<!doctype html><html lang="zh-CN"><title>${request.url.endsWith('/second') ? '第二页' : '浏览器验收'}</title><body style="font:16px system-ui;padding:24px;background:#f6f7f9"><h1>项目预览</h1><p>内置浏览器正在独立的沙箱中运行。</p><a href="https://mydsh-browser-verify.invalid/second">下一页</a></body></html>`,
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      ),
  )
  try {
    await win.webContents.executeJavaScript(
      browserRequest(`action:'navigate', url:'https://mydsh-browser-verify.invalid/'`),
    )
    await settle(win)
    await settle(win)
    const guest = win.contentView.children.find(
      child => child instanceof WebContentsView && child.webContents !== win.webContents,
    ) as WebContentsView | undefined
    if (!guest || !guest.getVisible()) {
      const diagnostic = await win.webContents.executeJavaScript(
        `(async () => ({ state: await ${browserRequest(`action:'read'`)}, viewport: document.querySelector('.browser-viewport')?.getBoundingClientRect().toJSON(), visible: document.querySelector('.browser-panel')?.checkVisibility(), text: document.querySelector('.browser-panel')?.textContent, overlays: [...document.querySelectorAll('[role="dialog"],[role="menu"],.ant-tooltip')].filter(node => node.checkVisibility()).map(node=>node.outerHTML.slice(0,200)) }))()`,
      )
      throw new Error(
        '浏览器网页没有出现在工作标签中：' +
          JSON.stringify({ diagnostic, bounds: guest?.getBounds() }),
      )
    }
    const isolated = (await guest.webContents.executeJavaScript(
      `typeof window.dshDesktop === 'undefined' && typeof require === 'undefined' && document.querySelector('h1')?.textContent === '项目预览'`,
    )) as boolean
    if (!isolated) throw new Error('远程网页拥有桌面桥或页面未加载')
    const hostUrl = win.webContents.getURL()
    await win.webContents.executeJavaScript(
      `setTimeout(()=>location.assign(${JSON.stringify(new URL('../startup.html', hostUrl).href)}),0)`,
    )
    await settle(win)
    if (
      win.webContents.getURL() !== hostUrl ||
      guest.webContents.isDestroyed() ||
      !guest.getVisible()
    )
      throw new Error('主页面拒绝回退时错误地释放了内置网页')
    await capture('verify-browser-tab.png')
    // 后台验收窗口不接收网页鼠标事件；显式保留用户手势，避免 Chromium 跳过历史项。
    await guest.webContents.executeJavaScript(`document.querySelector('a').click()`, true)
    const historyReady = await win.webContents.executeJavaScript(`(async () => {
      for (let attempt = 0; attempt < 40; attempt++) {
        if (!document.querySelector('[aria-label="网页后退"]')?.disabled) return true
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      return false
    })()`)
    if (!historyReady)
      throw new Error(
        '网页导航后历史未更新：' +
          JSON.stringify({
            url: guest.webContents.getURL(),
            entries: guest.webContents.navigationHistory.getAllEntries().map(entry => entry.url),
            state: await win.webContents.executeJavaScript(browserRequest(`action:'read'`)),
          }),
      )
    await win.webContents.executeJavaScript(
      `document.querySelector('[aria-label="网页后退"]').click()`,
      true,
    )
    const returned = await win.webContents.executeJavaScript(`(async () => {
      for(let attempt=0;attempt<80;attempt++) {
        const state=await ${browserRequest(`action:'read'`)}
        if(state.url==='https://mydsh-browser-verify.invalid/' && !state.loading) return true
        await new Promise(resolve=>setTimeout(resolve,50))
      }
      return false
    })()`)
    if (!returned || !guest.webContents.getURL().endsWith('/')) throw new Error('浏览器后退失败')
    await win.webContents.executeJavaScript(
      `(() => { const dialog=document.createElement('div'); dialog.id='verify-browser-overlay'; dialog.setAttribute('role','dialog'); dialog.style.cssText='position:fixed;inset:0;z-index:999;background:#222'; dialog.textContent='验收遮挡层'; document.body.append(dialog) })()`,
    )
    await settle(win)
    if (guest.getVisible()) throw new Error('浏览器遮挡了页面弹层')
    await win.webContents.executeJavaScript(
      `document.getElementById('verify-browser-overlay').remove()`,
    )
    await settle(win)
    if (!guest.getVisible()) throw new Error('关闭弹层后浏览器未恢复')
    await verifyBrowserMenuExit(win, guest)
    await settle(win)
    await clickTrustedElement(win, '[data-work-tab="session"]')
    await settle(win)
    if (guest.getVisible() || guest.webContents.isDestroyed())
      throw new Error('切换工作标签未正确隐藏并保留网页')
    await clickTrustedElement(win, '[data-work-tab="browser"]')
    await settle(win)
    const guestContents = guest.webContents
    await clickTrustedElement(win, '[aria-label="关闭网页"]')
    await settle(win)
    if (!guestContents.isDestroyed()) throw new Error('关闭网页未释放网页进程')
    console.log('desktop-shell-verify-local: browser-review', {
      isolated,
      history: true,
      overlay: true,
      menuExit: true,
      hiddenPreserved: true,
      closed: true,
    })
  } finally {
    partition.protocol.unhandle('https')
    // 关闭网页只释放网页进程；工作标签也要关闭，避免改变后续标签排序与等宽验收的样本数量。
    await win.webContents.executeJavaScript(`(() => {
      const tab = document.querySelector('[data-session-tab=' + JSON.stringify(${JSON.stringify(`browser:${browserTabId}`)}) + ']')
      tab?.closest('.session-tab-shell')?.querySelector('.session-tab-close')?.click()
    })()`)
    await settle(win)
  }
  await openRight('git-history')
  const gitReady = await win.webContents.executeJavaScript(`(async () => {
    const select = document.querySelector('[aria-label="Git 比较范围"]')
    const set = value => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select,value); select.dispatchEvent(new Event('change',{bubbles:true})) }
    const wait = async predicate => { for(let i=0;i<80;i++){if(predicate())return true; await new Promise(resolve=>setTimeout(resolve,50))}return false }
    if (!select || select.options.length !== 3) return false
    set('turn')
    if (!await wait(()=>document.querySelector('.git-review-files')?.textContent.includes('尚无完整文件快照'))) return false
    set('branch')
    if (!await wait(()=>document.querySelector('.git-review-caption')?.textContent.includes('分支对比'))) return false
    const ready = !document.querySelector('.git-review-files [role="alert"]') && !!document.querySelector('[aria-label="比较基准分支"] option')
    set('working'); return ready
  })()`)
  if (!gitReady) throw new Error('Git 比较范围、旧轮次缺失说明或分支 Remote 契约验收失败')
  await settle(win)
  await verifySourceControlSections(win, capture, 'right')
  await verifyWorkspacePickers(win, capture)
  console.log('desktop-shell-verify-local: git-review', {
    ranges: true,
    branch: true,
    missingSnapshot: true,
    fullHistory: true,
  })
  win.setSize(1280, 800)
  appearance('dark')
  await settle(win)
}
