/** 主进程补充验收四项工作台调整：空目录索引、本地 HTML/PDF 预览、+ 纯点击建窗及设置重设计视觉。 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { WebContentsView, type BrowserWindow } from 'electron'
import { clickTrustedElement, emulateVerificationMedia } from './desktop-verifier.ts'

/** 补充工作台调整验收所需的窗口控制、主题切换与截图回调。 */
export interface WorkbenchAdjustmentsContext {
  win: BrowserWindow
  appearance: (scheme: 'light' | 'dark') => void
  capture: (name: string) => Promise<string>
}

interface SettingsViewportSpec {
  width: number
  height: number
  scheme: 'light' | 'dark'
  accessibleShot: boolean
}

const MINIMAL_PDF_BYTES = [
  '%PDF-1.4',
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
  '2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj',
  '3 0 obj<</Type/Page/MediaBox[0 0 420 260]/Parent 2 0 R/Resources<<>>>>endobj',
  'xref',
  '0 4',
  '0000000000 65535 f ',
  '0000000009 00000 n ',
  '0000000052 00000 n ',
  '0000000101 00000 n ',
  'trailer<</Size 4/Root 1 0 R>>',
  'startxref',
  '176',
  '%%EOF',
  '',
].join('\n')

function createDriver(win: BrowserWindow) {
  const js = <Result = unknown>(source: string) =>
    win.webContents.executeJavaScript(source) as Promise<Result>
  const wait = async (expression: string, description: string) => {
    const ready = await js<boolean>(
      `(async()=>{for(let i=0;i<160;i++){if(${expression})return true;await new Promise(r=>setTimeout(r,50))}return false})()`,
    )
    if (!ready) {
      throw new Error(
        `调整项验收等待超时（${description}）：${await js<string>('document.body.innerText.slice(-900)')}`,
      )
    }
  }
  const click = (selector: string) => clickTrustedElement(win, selector)
  return { js, wait, click }
}

function guestViews(win: BrowserWindow): WebContentsView[] {
  return win.contentView.children.filter(
    (child): child is WebContentsView =>
      child instanceof WebContentsView && child.webContents !== win.webContents,
  )
}

async function pollUntil(
  check: () => Promise<boolean>,
  description: string,
  attemptsRemaining = 120,
): Promise<void> {
  if (await check()) return
  if (attemptsRemaining <= 1) {
    throw new Error(`主进程轮询超时（${description}）`)
  }
  await new Promise(resolve => {
    setTimeout(resolve, 50)
  })
  return pollUntil(check, description, attemptsRemaining - 1)
}

function writePreviewFixtureFiles(projectDirectory: string): void {
  const demoDirectory = join(projectDirectory, 'preview-demo')
  mkdirSync(demoDirectory, { recursive: true, mode: 0o700 })
  writeFileSync(
    join(demoDirectory, 'style.css'),
    [
      'body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: rgb(18, 42, 74); color: rgb(245, 248, 255); }',
      '.card { margin: 28px; padding: 20px 24px; border-radius: 14px; background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.22); }',
      '.badge { display: inline-block; padding: 4px 10px; border-radius: 999px; background: rgba(96, 165, 250, 0.22); color: #93c5fd; font-size: 12px; }',
      'a { color: #7dd3fc; text-decoration: none; font-weight: 600; }',
    ].join('\n'),
    { mode: 0o600 },
  )
  writeFileSync(
    join(demoDirectory, 'app.js'),
    "document.getElementById('js-output').textContent = 'JS_EXECUTED_OK';\n",
    { mode: 0o600 },
  )
  writeFileSync(
    join(demoDirectory, 'about.html'),
    '<!doctype html><html><head><meta charset="utf-8"><title>关于本地预览</title><link rel="stylesheet" href="./style.css"></head><body><main class="card"><span class="badge">子页面导航</span><h1>ABOUT_PAGE_OK</h1></main></body></html>\n',
    { mode: 0o600 },
  )
  writeFileSync(
    join(demoDirectory, 'index.html'),
    [
      '<!doctype html><html><head><meta charset="utf-8"><title>本地预览示例</title><link rel="stylesheet" href="./style.css"></head>',
      '<body><main class="card"><span class="badge">MyDSH 内置预览</span><h1>本地 HTML / CSS / JS 渲染</h1>',
      '<p id="js-output">pending</p>',
      '<p><a id="sub-link" href="./about.html">打开关于页面</a></p>',
      '</main><script src="./app.js"></script></body></html>',
      '',
    ].join('\n'),
    { mode: 0o600 },
  )
  writeFileSync(join(demoDirectory, 'sample.pdf'), MINIMAL_PDF_BYTES, { mode: 0o600 })
}

async function captureGuestPng(
  win: BrowserWindow,
  guest: WebContentsView,
  attemptsRemaining = 4,
): Promise<Buffer | null> {
  try {
    const image = await guest.webContents.capturePage(undefined, {
      stayHidden: !win.isVisible(),
      stayAwake: true,
    })
    return image.toPNG()
  } catch (error) {
    if (
      attemptsRemaining <= 1 ||
      !(error instanceof Error) ||
      error.message !== 'UnknownVizError'
    ) {
      return null
    }
    await new Promise(resolve => {
      setTimeout(resolve, 180)
    })
    return captureGuestPng(win, guest, attemptsRemaining - 1)
  }
}

async function selectProjectByName(
  win: BrowserWindow,
  projectName: string,
  targetId: string,
): Promise<void> {
  const { js, wait, click } = createDriver(win)
  await click('.project-selector')
  await wait(
    `[...document.querySelectorAll('[role="menu"][aria-label="专注项目"] [role="menuitemradio"]')].some(item=>item.querySelector('strong')?.textContent?.trim()===${JSON.stringify(projectName)})`,
    `项目菜单出现 ${projectName}`,
  )
  await js(
    `(()=>{const item=[...document.querySelectorAll('[role="menu"][aria-label="专注项目"] [role="menuitemradio"]')].find(node=>node.querySelector('strong')?.textContent?.trim()===${JSON.stringify(projectName)});item.id=${JSON.stringify(targetId)}})()`,
  )
  await click(`#${targetId}`)
  await wait(
    `document.querySelector('.project-selector__title')?.textContent?.trim()===${JSON.stringify(projectName)} && !document.querySelector('.project-focus-menu[data-menu-motion="closing"]')`,
    `切换到项目 ${projectName}`,
  )
}

async function verifyEmptyDirectoryIndex(
  win: BrowserWindow,
  verifyHome: string,
  mainProjectName: string,
  capture: (name: string) => Promise<string>,
): Promise<void> {
  const { js, wait, click } = createDriver(win)
  const emptyDirectory = join(verifyHome, 'empty-project')
  mkdirSync(emptyDirectory, { recursive: true, mode: 0o700 })
  await js(
    `window.dshDesktop.host.call('createWorkspace',{path:${JSON.stringify(emptyDirectory)}})`,
  )
  await selectProjectByName(win, 'empty-project', 'verify-pick-empty-project')
  await click('[data-view="files"]')
  await wait(
    `document.querySelector('.navigation-empty')?.textContent?.includes('当前项目目录为空。')===true`,
    '空目录提示文案',
  )
  const hasPermissionError = await js<boolean>(
    `document.body.innerText.includes('无法建立项目文件索引')`,
  )
  if (hasPermissionError) {
    throw new Error('空目录错误地显示了无法建立项目文件索引')
  }
  await capture('verify-adjustments-empty-files.png')
  await selectProjectByName(win, mainProjectName, 'verify-pick-main-project')
}

async function expandPreviewDirectory(
  win: BrowserWindow,
  shouldRefresh: boolean,
  targetPath: string,
): Promise<void> {
  const { js, wait, click } = createDriver(win)
  await click('[data-view="files"]')
  if (shouldRefresh) {
    await wait(
      `document.querySelector('button[aria-label="刷新项目文件"]:not([disabled])') !== null`,
      '刷新项目文件按钮可用',
    )
    await click('button[aria-label="刷新项目文件"]')
    await wait(
      `document.querySelector('button.tree-row[title="preview-demo"]') !== null && document.querySelector('button[aria-label="刷新项目文件"]:not([disabled])') !== null`,
      '刷新后出现 preview-demo 目录',
    )
  } else {
    await wait(
      `document.querySelector('button.tree-row[title="preview-demo"]') !== null`,
      'preview-demo 目录',
    )
  }
  const expanded = await js<boolean>(
    `document.querySelector('button.tree-row[title="preview-demo"]')?.getAttribute('aria-expanded') === 'true'`,
  )
  if (!expanded) {
    await click('button.tree-row[title="preview-demo"]')
  }
  await wait(
    `document.querySelector('button.tree-row[title=' + JSON.stringify(${JSON.stringify(targetPath)}) + ']') !== null`,
    `文件行 ${targetPath}`,
  )
}

async function verifyHtmlAndPdfPreview(
  win: BrowserWindow,
  verifyProject: string,
  capture: (name: string) => Promise<string>,
): Promise<void> {
  const { js, wait, click } = createDriver(win)
  writePreviewFixtureFiles(verifyProject)
  await expandPreviewDirectory(win, true, 'preview-demo/index.html')
  await click('button.tree-row[title="preview-demo/index.html"]')
  await wait(
    `document.querySelector('[data-file-path="preview-demo/index.html"] .file-preview-browser-button') !== null`,
    'FileViewer 浏览器打开按钮',
  )
  await click('[data-file-path="preview-demo/index.html"] .file-preview-browser-button')
  await wait(
    `document.querySelector('.work-tab-panel:not([hidden]) .browser-preview-badge')?.textContent?.includes('本地预览')===true && document.querySelector('.work-tab-panel:not([hidden]) [aria-label="网页地址"]')?.value === 'preview-demo/index.html'`,
    'HTML 本地预览标签与地址栏',
  )
  let htmlGuest: WebContentsView | undefined
  await pollUntil(async () => {
    const visible = guestViews(win).filter(view => view.getVisible())
    if (visible.length !== 1) return false
    const view = visible[0]!
    if (!view.webContents.getURL().startsWith('mydsh-preview://')) return false
    const rendered = (await view.webContents
      .executeJavaScript(
        `getComputedStyle(document.body).backgroundColor === 'rgb(18, 42, 74)' && document.getElementById('js-output')?.textContent === 'JS_EXECUTED_OK'`,
      )
      .catch(() => false)) as boolean
    if (!rendered) return false
    htmlGuest = view
    return true
  }, '等待内置浏览器渲染本地 HTML 与样式脚本')
  await js('new Promise(resolve => setTimeout(resolve, 150))')
  const hostPath = await capture('verify-adjustments-html-preview-dark.png')
  if (htmlGuest !== undefined) {
    const guestPng = await captureGuestPng(win, htmlGuest)
    if (guestPng !== null) {
      writeFileSync(join(dirname(hostPath), 'verify-adjustments-html-guest.png'), guestPng)
    }
    await htmlGuest.webContents.executeJavaScript(`document.getElementById('sub-link')?.click()`)
  }
  await wait(
    `document.querySelector('.work-tab-panel:not([hidden]) [aria-label="网页地址"]')?.value === 'preview-demo/about.html'`,
    '子页面跳转地址栏更新为 preview-demo/about.html',
  )
  await pollUntil(async () => {
    if (htmlGuest === undefined) return false
    return (await htmlGuest.webContents
      .executeJavaScript(`document.body?.textContent?.includes('ABOUT_PAGE_OK') === true`)
      .catch(() => false)) as boolean
  }, '子页面正文 ABOUT_PAGE_OK')
  await expandPreviewDirectory(win, false, 'preview-demo/sample.pdf')
  await click('button.tree-row[title="preview-demo/sample.pdf"]')
  await wait(
    `document.querySelectorAll('[data-work-tab="browser"]').length === 2 && document.querySelector('.work-tab-panel:not([hidden]) [aria-label="网页地址"]')?.value === 'preview-demo/sample.pdf'`,
    'PDF 单击直开浏览器标签',
  )
  await pollUntil(
    async () =>
      guestViews(win).some(
        view => view.getVisible() && view.webContents.getURL().endsWith('/preview-demo/sample.pdf'),
      ),
    '等待 PDF 预览 URL 生效',
  )
  await click('.session-tab-shell:has([data-work-tab="browser"]) .session-tab-close')
  await wait(
    `document.querySelectorAll('[data-work-tab="browser"]').length === 1`,
    '关闭首个浏览器标签',
  )
  await click('.session-tab-shell:has([data-work-tab="browser"]) .session-tab-close')
  await wait(
    `document.querySelectorAll('[data-work-tab="browser"]').length === 0`,
    '关闭全部浏览器标签',
  )
  await pollUntil(async () => guestViews(win).length === 0, '关闭浏览标签后清理 WebContentsView')
}

async function verifyNewTabMenuBehavior(
  win: BrowserWindow,
  capture: (name: string) => Promise<string>,
): Promise<void> {
  const { js, wait, click } = createDriver(win)
  const closeSessionTab = async (selector: string, description: string, expectedCount?: number) => {
    const tabsVisible = await js<boolean>(
      `document.querySelector('.app-shell')?.dataset.sessionTabsVisible === 'true'`,
    )
    if (tabsVisible) {
      await click(selector)
    } else {
      win.webContents.send('mydsh:workspace:tab-action', { action: 'close' })
    }
    await wait(
      expectedCount === undefined
        ? `document.querySelector('.session-tab-shell:has([data-work-tab="session"])') === null`
        : `document.querySelectorAll('.session-tab').length === ${String(expectedCount)}`,
      description,
    )
  }
  const hadSessionTab = await js<boolean>(
    `document.querySelector('.session-tab-shell:has([data-work-tab="session"])') !== null`,
  )
  if (hadSessionTab) {
    await closeSessionTab(
      '.session-tab-shell:has([data-work-tab="session"]) .session-tab-close',
      '前置清理已有会话标签以验证新建标签',
    )
  }
  await js(
    `Promise.allSettled((document.querySelector('.app-shell')?.getAnimations({subtree:true}) ?? []).filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished))`,
  )
  const triggerCenter = await js<{ x: number; y: number }>(
    `(()=>{const rect=document.querySelector('[aria-label="新建工作标签"]').getBoundingClientRect();return {x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2)}})()`,
  )
  win.webContents.sendInputEvent({ type: 'mouseMove', ...triggerCenter })
  await js('new Promise(resolve => setTimeout(resolve, 350))')
  const openedOnHover = await js<boolean>(
    `document.querySelector('[role="menu"][aria-label="新建工作标签"]')?.checkVisibility() === true`,
  )
  if (openedOnHover) {
    throw new Error('悬浮顶栏 + 按钮时错误展开了新建标签菜单')
  }
  const beforeTabs = await js<number>(`document.querySelectorAll('.session-tab').length`)
  await click('[aria-label="新建工作标签"]')
  await wait(
    `document.querySelector('[role="menu"][aria-label="新建工作标签"]')?.checkVisibility() === true`,
    '首次点击 + 展开新建标签菜单',
  )
  await js(
    `Promise.allSettled((document.querySelector('[role="menu"][aria-label="新建工作标签"]')?.getAnimations({subtree:true}) ?? []).filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished))`,
  )
  await js('new Promise(resolve => setTimeout(resolve, 60))')
  const menuText = await js<string>(
    `document.querySelector('[role="menu"][aria-label="新建工作标签"]')?.innerText ?? ''`,
  )
  for (const expectedItem of ['新聊天', '新终端', '新浏览器']) {
    if (!menuText.includes(expectedItem)) {
      throw new Error(`新建标签菜单缺少入口：${expectedItem}`)
    }
  }
  await capture('verify-adjustments-new-tab-menu.png')
  await click('[aria-label="新建工作标签"]')
  await wait(
    `document.querySelector('[role="menu"][aria-label="新建工作标签"]')?.checkVisibility() !== true`,
    '再次点击 + 关闭菜单',
  )
  await wait(
    `document.querySelectorAll('.session-tab').length === ${String(beforeTabs + 1)} && document.querySelector('[data-work-tab="session"][aria-selected="true"]') !== null`,
    '再次点击 + 立即打开会话标签',
  )
  await closeSessionTab(
    '.session-tab-shell:has([data-work-tab="session"][aria-selected="true"]) .session-tab-close',
    '清理验证新建的会话标签',
    beforeTabs,
  )
}

async function seedArchivedSessionsForSettings(
  win: BrowserWindow,
  projectDirectory: string,
): Promise<void> {
  const { js } = createDriver(win)
  const seeded = await js<boolean>(`(async()=>{
    const {workspace} = await window.dshDesktop.host.call('createWorkspace',{path:${JSON.stringify(projectDirectory)}})
    for (const title of ['设置弹窗视觉与对齐重构', 'ChatGPT 订阅卡片与模型目录']) {
      const created = await window.dshDesktop.host.call('createSessionForWorkspace',{workspaceId:workspace.workspaceId})
      await window.dshDesktop.host.call('renameSession',{sessionId:created.sessionId,title})
      await window.dshDesktop.host.call('archiveSession',{sessionId:created.sessionId})
    }
    return true
  })()`)
  if (!seeded) {
    throw new Error('未能播种已归档会话夹具')
  }
}

async function assertSettingsGeneralInvariants(win: BrowserWindow): Promise<void> {
  const { js } = createDriver(win)
  const audit = await js<{
    hasWorm: boolean
    hasHeading: boolean
    hasRawPermission: boolean
    noChatgptInSettings: boolean
    noOverflow: boolean
  }>(`(()=>{
    const dialog = document.querySelector('.settings-dialog[role="dialog"]')
    const content = dialog?.querySelector('.settings-content')
    const worm = dialog?.querySelector('.settings-nav__worm')
    const heading = dialog?.querySelector('#settings-general-title')
    const wormRect = worm?.getBoundingClientRect()
    return {
      hasWorm: worm instanceof HTMLElement && !worm.hidden && (wormRect?.height ?? 0) > 10,
      hasHeading: heading instanceof HTMLElement && heading.checkVisibility() && heading.textContent.trim() === '通用设置',
      hasRawPermission: (content?.textContent ?? '').includes('Workspace Write'),
      noChatgptInSettings: dialog?.querySelector('.settings-nav__items [data-menu-id*="chatgpt"]') === null,
      noOverflow: Boolean(dialog && content && dialog.scrollWidth <= dialog.clientWidth + 1 && content.scrollWidth <= content.clientWidth + 1),
    }
  })()`)
  if (
    !audit.hasWorm ||
    !audit.hasHeading ||
    audit.hasRawPermission ||
    !audit.noChatgptInSettings ||
    !audit.noOverflow
  ) {
    throw new Error(`通用设置首次展开视觉断言失败：${JSON.stringify(audit)}`)
  }
}

async function waitSettingsDialogAnimations(win: BrowserWindow): Promise<void> {
  const { js } = createDriver(win)
  await js(
    `Promise.allSettled((document.querySelector('.settings-dialog')?.getAnimations({subtree:true}) ?? []).filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished))`,
  )
}

async function assertSettingsWormVisible(win: BrowserWindow): Promise<void> {
  const { wait } = createDriver(win)
  await wait(
    `(()=>{const worm=document.querySelector('.settings-dialog .settings-nav__worm');const h=worm?.getBoundingClientRect().height??0;return worm instanceof HTMLElement&&!worm.hidden&&h>=12&&h<=22})()`,
    '设置侧栏蓝色选中指示条停稳',
  )
}

async function verifySettingsChatgptPage(
  context: WorkbenchAdjustmentsContext,
  spec: SettingsViewportSpec,
): Promise<void> {
  const { win, capture } = context
  const { js, wait, click } = createDriver(win)
  await click('[data-view="plugins"]')
  await wait(
    `document.querySelector('.plugin-manager--standalone [aria-label="配置 ChatGPT 订阅"]')?.checkVisibility() === true`,
    '插件管理页内置 ChatGPT 卡片',
  )
  await click('.plugin-manager--standalone [aria-label="配置 ChatGPT 订阅"]')
  await wait(
    `document.querySelector('.chatgpt-hero-card')?.checkVisibility() === true && !document.querySelector('.chatgpt-hero-card')?.textContent?.includes('读取中')`,
    'ChatGPT 订阅详情页',
  )
  const chatgptAudit = await js<{ overflow: boolean; wrappedPill: boolean }>(
    `(()=>{const page=document.querySelector('.plugin-manager--standalone');const c=document.querySelector('[data-chatgpt-settings]');const pills=[...document.querySelectorAll('.chatgpt-link-pill')];return {overflow:Boolean((page&&page.scrollWidth>page.clientWidth+1)||(c&&c.scrollWidth>c.clientWidth+1)),wrappedPill:pills.some(p=>p.getBoundingClientRect().height>38||p.scrollHeight>p.clientHeight+1)}})()`,
  )
  if (chatgptAudit.overflow || chatgptAudit.wrappedPill) {
    throw new Error(
      `ChatGPT 订阅页排版异常（${String(spec.width)} ${spec.scheme}）：${JSON.stringify(chatgptAudit)}`,
    )
  }
  await capture(`verify-adjustments-settings-chatgpt-${String(spec.width)}-${spec.scheme}.png`)
  await click('.plugin-manager__back')
  await click('[data-view="conversation"]')
  await wait(
    `document.querySelector('[data-view="conversation"]')?.getAttribute('aria-current') === 'page'`,
    '返回对话视图',
  )
}

async function verifySettingsArchivedPage(
  context: WorkbenchAdjustmentsContext,
  spec: SettingsViewportSpec,
): Promise<void> {
  const { win, capture } = context
  const { js, wait, click } = createDriver(win)
  await click('.settings-nav__items [data-menu-id*="archived-sessions"]')
  await wait(
    `document.querySelectorAll('.settings-archive-list > li').length >= 2`,
    '已归档会话列表',
  )
  const checkedAlready = await js<boolean>(
    `document.querySelector('.settings-archive-list input[type="checkbox"]')?.checked === true`,
  )
  if (!checkedAlready) {
    await click('.settings-archive-list input[type="checkbox"]')
  }
  await wait(
    `document.querySelector('.settings-archive-selection')?.textContent?.includes('已选 1 项') === true`,
    '已归档勾选计数',
  )
  const archiveOverflow = await js<boolean>(
    `(()=>{const c=document.querySelector('.settings-content');return Boolean(c&&c.scrollWidth>c.clientWidth+1)})()`,
  )
  if (archiveOverflow) {
    throw new Error(`已归档会话页存在水平溢出（${String(spec.width)} ${spec.scheme}）`)
  }
  await capture(`verify-adjustments-settings-archived-${String(spec.width)}-${spec.scheme}.png`)
}

async function verifySettingsViewport(
  context: WorkbenchAdjustmentsContext,
  spec: SettingsViewportSpec,
): Promise<void> {
  const { win, appearance, capture } = context
  const { js, wait, click } = createDriver(win)
  win.setSize(spec.width, spec.height)
  appearance(spec.scheme)
  await js('new Promise(resolve => setTimeout(resolve, 240))')
  await click('#open-settings')
  await wait(
    `document.querySelector('.settings-dialog[role="dialog"]')?.checkVisibility() === true && document.querySelector('.settings-nav__items [data-menu-id*="general"]') !== null`,
    `打开设置 ${String(spec.width)} ${spec.scheme}`,
  )
  await waitSettingsDialogAnimations(win)
  const onGeneral = await js<boolean>(
    `document.querySelector('#settings-general-title')?.checkVisibility() === true`,
  )
  if (!onGeneral) {
    await click('.settings-nav__items [data-menu-id*="general"]')
    await wait(
      `document.querySelector('#settings-general-title')?.checkVisibility() === true`,
      '切换通用设置',
    )
  }
  await assertSettingsWormVisible(win)
  await assertSettingsGeneralInvariants(win)
  await capture(`verify-adjustments-settings-general-${String(spec.width)}-${spec.scheme}.png`)

  await verifySettingsArchivedPage(context, spec)

  if (spec.accessibleShot) {
    await emulateVerificationMedia(win, [
      { name: 'forced-colors', value: 'active' },
      { name: 'prefers-reduced-motion', value: 'reduce' },
      { name: 'prefers-reduced-transparency', value: 'reduce' },
    ])
    await js('new Promise(resolve => setTimeout(resolve, 120))')
    await capture('verify-adjustments-settings-accessible.png')
    await emulateVerificationMedia(win)
  }

  await click('.settings-dialog button[aria-label="关闭设置"]')
  await wait(
    `document.querySelector('.settings-dialog[role="dialog"]')?.checkVisibility() !== true`,
    '关闭设置弹窗',
  )
  await verifySettingsChatgptPage(context, spec)
}

/** 顺序验证四项新增工作台调整的真实 Electron 交互与设置界面多主题多尺寸视觉效果。 */
export async function verifyWorkbenchAdjustments(
  context: WorkbenchAdjustmentsContext,
): Promise<void> {
  const { win, appearance, capture } = context
  const verifyHome = process.env.MYDSH_VERIFY_HOME
  const verifyProject = process.env.MYDSH_VERIFY_PROJECT
  if (!verifyHome || !verifyProject) {
    throw new Error('缺少隔离验收环境变量 MYDSH_VERIFY_HOME 或 MYDSH_VERIFY_PROJECT')
  }
  win.setSize(1280, 800)
  appearance('dark')
  await createDriver(win).js('new Promise(resolve => setTimeout(resolve, 180))')

  await verifyEmptyDirectoryIndex(win, verifyHome, basename(verifyProject), capture)
  await verifyHtmlAndPdfPreview(win, verifyProject, capture)
  await verifyNewTabMenuBehavior(win, capture)

  // 打开设置时先验证蓝色选中指示条即刻挂载，再进入空态已归档会话截图，随后播种真实会话。
  const { js, wait, click } = createDriver(win)
  await click('#open-settings')
  await wait(
    `document.querySelector('.settings-dialog[role="dialog"]')?.checkVisibility() === true && document.querySelector('.settings-nav__items [data-menu-id*="archived-sessions"]') !== null`,
    '设置导航',
  )
  await waitSettingsDialogAnimations(win)
  await js('new Promise(resolve => setTimeout(resolve, 100))')
  await assertSettingsWormVisible(win)
  await click('.settings-nav__items [data-menu-id*="archived-sessions"]')
  await wait(
    `document.querySelector('.settings-page')?.textContent?.includes('暂无已归档会话') === true`,
    '归档空态',
  )
  await capture('verify-adjustments-settings-archived-empty.png')
  await click('.settings-dialog button[aria-label="关闭设置"]')
  await wait(
    `document.querySelector('.settings-dialog[role="dialog"]')?.checkVisibility() !== true`,
    '关闭归档空态设置',
  )

  await seedArchivedSessionsForSettings(win, verifyProject)
  await verifySettingsViewport(context, {
    width: 1280,
    height: 800,
    scheme: 'dark',
    accessibleShot: true,
  })
  await verifySettingsViewport(context, {
    width: 1280,
    height: 800,
    scheme: 'light',
    accessibleShot: false,
  })
  await verifySettingsViewport(context, {
    width: 1440,
    height: 900,
    scheme: 'dark',
    accessibleShot: false,
  })

  win.setSize(1280, 800)
  appearance('dark')
  console.log('mydsh-adjustments-verify: complete', {
    emptyDirectoryIndex: true,
    htmlAndPdfPreview: true,
    newTabClickOnly: true,
    settingsVisuals: true,
  })
}
