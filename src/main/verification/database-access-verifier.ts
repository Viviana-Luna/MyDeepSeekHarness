/** 主进程数据库模型权限配置验收；核实输入区无独立授权按钮，并验证「Agent 权限」弹窗与持久化。 */
/* oxlint-disable no-await-in-loop -- 同一窗口的尺寸、主题与截图必须顺序验收。 */
import type { BrowserWindow } from 'electron'
import { clickTrustedElement, emulateVerificationMedia } from './desktop-verifier.ts'
import { pollRenderer, waitForMediaFeature, waitForViewportSettled } from './verification-wait.ts'

interface AccessVerification {
  win: BrowserWindow
  appearance(scheme: 'light' | 'dark'): void
  capture(name: string): Promise<string>
}

function accessDriver(win: BrowserWindow) {
  const js = (source: string) => win.webContents.executeJavaScript(source)
  const wait = async (condition: string) => {
    const ready = await js(
      `(async()=>{for(let i=0;i<220;i++){if(${condition})return true;await new Promise(r=>setTimeout(r,50))}return false})()`,
    )
    if (!ready)
      throw new Error(
        `数据库模型权限界面等待失败：${condition}；${await js('document.body.innerText.slice(-1200)')}`,
      )
  }
  const click = (selector: string) => clickTrustedElement(win, selector)
  const fill = (selector: string, value: string) =>
    js(
      `(()=>{const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}))})()`,
    )
  return { js, wait, click, fill }
}

/** 验证会话区无数据库配置按钮，并在数据库模式验证表级权限配置的持久化与多尺寸主题布局。 */
export async function verifyDatabaseAccess({
  win,
  appearance,
  capture,
}: AccessVerification): Promise<string[]> {
  const { js, wait, click, fill } = accessDriver(win)
  await click('[data-view="conversation"]')
  await wait(`document.querySelector('[aria-label="消息输入"]')`)
  if (await js(`Boolean(document.querySelector('[aria-label="授权数据库连接"]'))`))
    throw new Error('聊天输入区仍残留旧的数据库授权按钮')

  await click('[data-view="database"]')
  await wait(`document.querySelector('[aria-label="刷新数据库连接"]:not([disabled])')`)
  await click('[aria-label="刷新数据库连接"]')
  await js('new Promise(resolve=>setTimeout(resolve,150))')
  await wait(`document.querySelector('[aria-label="连接 真实 MySQL 验收 操作"]')`)
  if (await js(`Boolean(document.querySelector('.database-readonly, .database-agent-pill'))`))
    throw new Error('数据库主区头部仍残留只读或模型开放胶囊按钮')
  const beforeStatus = (await js(`window.dshDesktop.remote.call('mydshDatabase/status',{})`)) as {
    connections: { agentAccess: unknown }[]
  }
  const initialAccess = beforeStatus.connections[0]?.agentAccess

  await openAgentAccessModal({ js, wait, click })
  if (
    await js(
      `document.querySelector('[aria-label="向模型开放此连接"]')?.getAttribute('aria-checked')!=='true'`,
    )
  )
    await click('[aria-label="向模型开放此连接"]')
  await wait(`document.querySelector('[data-mode="readwrite"]')`)
  await wait(`document.querySelector('[aria-label="表级细粒度规则"]')`)
  await click('[data-mode="readwrite"]')
  await js(
    `[...document.querySelectorAll('button')].find(item=>item.textContent.includes('添加表规则')).click()`,
  )
  await wait(`document.querySelector('[aria-label="第 1 条规则数据库名"]')`)
  await fill('[aria-label="第 1 条规则数据库名"]', 'mydsh_probe')
  await fill('[aria-label="第 1 条规则表名"]', 'samples')
  const images = await verifyModalLayout({ win, appearance, capture })

  await js(
    `[...document.querySelectorAll('.ant-modal button')].find(item=>item.textContent.includes('保存连接')).click()`,
  )
  await wait(`!document.querySelector('.ant-modal-wrap')?.checkVisibility()`)
  const afterSave = (await js(`window.dshDesktop.remote.call('mydshDatabase/status',{})`)) as {
    connections: {
      id: string
      revision: number
      agentAccess: {
        enabled: boolean
        mode: 'readonly' | 'readwrite' | 'full'
        tableRules: { schema: string; table: string }[]
      }
      credentialConfigured?: boolean
    }[]
  }
  const saved = afterSave.connections[0]
  if (
    !saved ||
    !saved.agentAccess.enabled ||
    saved.agentAccess.mode !== 'readwrite' ||
    saved.agentAccess.tableRules[0]?.schema !== 'mydsh_probe' ||
    saved.agentAccess.tableRules[0]?.table !== 'samples'
  )
    throw new Error('数据库模式保存的表级权限策略未生效')

  if (initialAccess) {
    await restoreInitialAccess({ js, click, saved, initialAccess })
  }
  await click('[data-database-connection]')
  await wait(`document.querySelector('[data-database-table="samples"]')?.checkVisibility()`)
  await js(
    `[...document.querySelectorAll('.database-view-tabs button')].find(item=>item.textContent.includes('SQL 查询'))?.click()`,
  )
  await wait(`document.querySelector('[aria-label="SQL 查询内容"]')`)
  console.log('mydsh-database-access-verify: complete')
  return images
}

async function openAgentAccessModal(input: {
  js: (source: string) => Promise<unknown>
  wait: (condition: string) => Promise<void>
  click: (selector: string) => Promise<void>
}): Promise<void> {
  const { js, wait, click } = input
  await click('[aria-label="连接 真实 MySQL 验收 操作"]')
  await wait(
    `[...document.querySelectorAll('[role="menuitem"]')].some(node=>node.textContent.includes('Agent 权限配置')&&node.checkVisibility())`,
  )
  await js(
    `[...document.querySelectorAll('[role="menuitem"]')].find(node=>node.textContent.includes('Agent 权限配置')&&node.checkVisibility()).click()`,
  )
  await wait(`document.querySelector('[aria-label="向模型开放此连接"]')?.checkVisibility()`)
}

async function restoreInitialAccess(input: {
  js: (source: string) => Promise<unknown>
  click: (selector: string) => Promise<void>
  saved: { credentialConfigured?: boolean }
  initialAccess: unknown
}): Promise<void> {
  const { js, click, saved, initialAccess } = input
  const restore = { ...saved, agentAccess: initialAccess }
  delete restore.credentialConfigured
  await js(
    `window.dshDesktop.remote.call('mydshDatabase/save',{request:${JSON.stringify(restore)}})`,
  )
  const restored = (await js(`window.dshDesktop.remote.call('mydshDatabase/status',{})`)) as {
    connections: { agentAccess: unknown }[]
  }
  if (JSON.stringify(restored.connections[0]?.agentAccess) !== JSON.stringify(initialAccess))
    throw new Error('数据库 Agent 权限验收后未恢复初始状态')
  await click('[aria-label="刷新数据库连接"]')
  await js('new Promise(resolve=>setTimeout(resolve,150))')
}

async function verifyModalLayout({
  win,
  appearance,
  capture,
}: AccessVerification): Promise<string[]> {
  const images: string[] = []
  for (const [width, scheme] of [
    [1280, 'dark'],
    [1280, 'light'],
    [1800, 'dark'],
    [1800, 'light'],
  ] as const) {
    win.setSize(width, width === 1280 ? 800 : 1000)
    appearance(scheme)
    await waitForViewportSettled(win, { scheme })
    const fits = await pollRenderer<Record<string, unknown>>(win, {
      probe: `(() => {
        const panel=document.querySelector('.database-connection-modal-container, .ant-modal-container, .ant-modal-content')
        if(!panel) return { ok: false, missing: true }
        const bounds=panel.getBoundingClientRect()
        return {
          ok: bounds.left>=0 && bounds.right<=innerWidth && bounds.bottom<=innerHeight && panel.scrollWidth<=panel.clientWidth+1,
          bounds: bounds.toJSON(), innerWidth, innerHeight,
          scrollWidth: panel.scrollWidth, clientWidth: panel.clientWidth,
        }
      })()`,
      condition: 'state.ok === true',
    })
    if (!fits.ok) {
      throw new Error(`数据库 Agent 权限弹窗超出窗口或发生横向溢出：${JSON.stringify(fits)}`)
    }
    images.push(await capture(`verify-database-access-${width}-${scheme}.png`))
  }
  await emulateVerificationMedia(win, [
    { name: 'forced-colors', value: 'active' },
    { name: 'prefers-reduced-motion', value: 'reduce' },
    { name: 'prefers-reduced-transparency', value: 'reduce' },
  ])
  await waitForMediaFeature(win, '(forced-colors: active)')
  images.push(await capture('verify-database-access-accessible.png'))
  await emulateVerificationMedia(win)
  win.setSize(1280, 800)
  appearance('dark')
  await waitForViewportSettled(win, { scheme: 'dark' })
  return images
}
