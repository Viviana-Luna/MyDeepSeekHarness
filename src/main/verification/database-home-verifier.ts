/** 在隔离的真实 Electron 窗口中验收数据库首页、草稿入口与响应式布局。 */
import type { BrowserWindow } from 'electron'
import { clickTrustedElement, emulateVerificationMedia } from './desktop-verifier.ts'
import { verifyDatabaseNavigation } from './database-navigation-verifier.ts'
import {
  pollRenderer,
  waitForMediaFeature,
  waitForViewportSettled,
} from './verification-wait.ts'

async function verifyDatabaseHomeViewports(
  win: BrowserWindow,
  appearance: (scheme: 'dark' | 'light') => void,
  capture: (name: string) => Promise<string>,
): Promise<string[]> {
  const images: string[] = []
  /* oxlint-disable no-await-in-loop -- 同一窗口顺序检查尺寸与主题，避免相互覆盖。 */
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
      probe: `(()=>{
        const home=document.querySelector('[data-database-home]'),nav=document.querySelector('.navigation-island .connections-navigation')
        if (!home || !nav) return { ok: false, missing: true }
        const a=home.getBoundingClientRect(),b=nav.getBoundingClientRect()
        const shortcuts=home.querySelector('[aria-label="快速开始"]'),row=shortcuts?.querySelector('li')
        const ok = Boolean(shortcuts && row) && nav.checkVisibility() && b.right<a.left && a.width>500
          && home.scrollWidth===home.clientWidth && shortcuts.getBoundingClientRect().height<160
          && row.getBoundingClientRect().height<90 && document.documentElement.scrollWidth===innerWidth
          && [...home.querySelectorAll('button')].filter(node=>node.checkVisibility()).every(node=>{const r=node.getBoundingClientRect();return r.left>=a.left&&r.right<=a.right})
        return {
          ok, navVisible: nav.checkVisibility(), homeBounds: a.toJSON(), navBounds: b.toJSON(),
          scrollWidth: home.scrollWidth, clientWidth: home.clientWidth, innerWidth,
        }
      })()`,
      condition: 'state.ok === true',
    })
    if (!fits.ok) throw new Error(`数据库首页在 ${width} ${scheme} 下溢出或左栏丢失：${JSON.stringify(fits)}`)
    images.push(await capture(`verify-database-home-${width}-${scheme}.png`))
  }
  /* oxlint-enable no-await-in-loop */
  return images
}

const DATABASE_HOME_CONTENT_PROBE = `(()=>{
  const home=document.querySelector('[data-database-home]')
  const ok = Boolean(home?.checkVisibility()) && !document.querySelector('.database-heading')
    && !home.querySelector('.database-home__stats')
    && home.querySelector('[aria-label="快速开始"]')?.textContent.includes('1 个连接') === true
    && home.querySelector('[aria-label="历史查询"] button')?.textContent.includes('SELECT') === true
    && !document.querySelector('.ant-tree-node-selected')
  return {
    ok, homeVisible: home?.checkVisibility() ?? false,
    quickStart: home?.querySelector('[aria-label="快速开始"]')?.textContent?.slice(0, 80) ?? null,
    history: home?.querySelector('[aria-label="历史查询"] button')?.textContent?.slice(0, 80) ?? null,
  }
})()`

const DATABASE_DRAFT_RESTORE_PROBE = `(()=>{
  const sql = document.querySelector('[aria-label="SQL 查询内容"]')?.value ?? ''
  const hasTable = Boolean(document.querySelector('[aria-label="数据库查询结果"] table'))
  const footer = document.querySelector('.database-result-footer')?.textContent ?? ''
  const operationHidden = document.querySelector('.database-operation')?.hidden === true
  return {
    ok: sql.startsWith('SELECT') && !hasTable && footer.includes('尚无结果') && operationHidden,
    sql: sql.slice(0, 60), hasTable, footer: footer.slice(0, 80), operationHidden,
  }
})()`

/** 已有一条夹具连接和成功查询后，检查首页并恢复连接，不执行历史 SQL。 */
export async function verifyDatabaseHome({
  win,
  appearance,
  capture,
}: {
  win: BrowserWindow
  appearance(scheme: 'dark' | 'light'): void
  capture(name: string): Promise<string>
}): Promise<string[]> {
  const js = (source: string) => win.webContents.executeJavaScript(source)
  const click = (selector: string) => clickTrustedElement(win, selector)
  await click('[aria-label="返回数据库首页"]')
  const content = await pollRenderer<Record<string, unknown>>(win, {
    probe: DATABASE_HOME_CONTENT_PROBE,
    condition: 'state.ok === true',
  })
  if (!content.ok) throw new Error(`数据库首页未展示实际连接与成功查询历史：${JSON.stringify(content)}`)
  await verifyDatabaseNavigation(win)
  const images = await verifyDatabaseHomeViewports(win, appearance, capture)
  win.setSize(1280, 800)
  win.webContents.setZoomFactor(2)
  await waitForViewportSettled(win)
  const zoomed = await pollRenderer<{ clientWidth: number; scrollWidth: number }>(win, {
    probe: `(()=>{const home=document.querySelector('[data-database-home]');return {clientWidth:home?.clientWidth??0,scrollWidth:home?.scrollWidth??0}})()`,
    condition: 'state.clientWidth > 0 && state.scrollWidth === state.clientWidth',
  })
  if (!zoomed.ok) throw new Error(`数据库首页在 200% 缩放下出现横向溢出：${JSON.stringify(zoomed)}`)
  images.push(await capture('verify-database-home-zoom.png'))
  win.webContents.setZoomFactor(1)
  win.setSize(1800, 1000)
  await waitForViewportSettled(win)
  await js("document.querySelector('[data-database-home]').dir='rtl'")
  images.push(await capture('verify-database-home-rtl.png'))
  await js("document.querySelector('[data-database-home]').removeAttribute('dir')")
  await emulateVerificationMedia(win, [
    { name: 'forced-colors', value: 'active' },
    { name: 'prefers-reduced-motion', value: 'reduce' },
    { name: 'prefers-reduced-transparency', value: 'reduce' },
  ])
  await waitForMediaFeature(win, '(forced-colors: active)')
  images.push(await capture('verify-database-home-accessible.png'))
  await emulateVerificationMedia(win)
  await click('[aria-label="历史查询"] button')
  const draftRestored = await pollRenderer<Record<string, unknown>>(win, {
    probe: DATABASE_DRAFT_RESTORE_PROBE,
    condition: 'state.ok === true',
  })
  if (!draftRestored.ok) {
    throw new Error(`恢复查询历史未恢复草稿或自动运行了 SQL：${JSON.stringify(draftRestored)}`)
  }
  await click('[aria-label="返回数据库首页"]')
  await click('[aria-label="打开连接 真实 MySQL 验收"]')
  return images
}
