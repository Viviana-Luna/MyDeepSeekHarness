/** 在隔离的真实 Electron 窗口中验收数据库首页、草稿入口与响应式布局。 */
import type { BrowserWindow } from 'electron'
import { clickTrustedElement, emulateVerificationMedia } from './desktop-verifier.ts'
import { verifyDatabaseNavigation } from './database-navigation-verifier.ts'

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
  const images: string[] = []
  await click('[aria-label="返回数据库首页"]')
  const content = await js(`(()=>{
    const home=document.querySelector('[data-database-home]');
    return home?.checkVisibility()&&!document.querySelector('.database-heading')
      &&!home.querySelector('.database-home__stats')
      &&home.querySelector('[aria-label="快速开始"]')?.textContent.includes('1 个连接')
      &&home.querySelector('[aria-label="历史查询"] button')?.textContent.includes('SELECT')
      &&!document.querySelector('.ant-tree-node-selected');
  })()`)
  if (!content) throw new Error('数据库首页未展示实际连接与成功查询历史')
  await verifyDatabaseNavigation(win)
  /* oxlint-disable no-await-in-loop -- 同一窗口顺序检查尺寸与主题，避免相互覆盖。 */
  for (const [width, scheme] of [
    [1280, 'dark'],
    [1280, 'light'],
    [1800, 'dark'],
    [1800, 'light'],
  ] as const) {
    win.setSize(width, width === 1280 ? 800 : 1000)
    appearance(scheme)
    await js('new Promise(resolve=>setTimeout(resolve,350))')
    const fits = await js(`(()=>{
      const home=document.querySelector('[data-database-home]'),nav=document.querySelector('.navigation-island .connections-navigation');
      const a=home.getBoundingClientRect(),b=nav.getBoundingClientRect();
      const shortcuts=home.querySelector('[aria-label="快速开始"]'),row=shortcuts.querySelector('li');
      return nav.checkVisibility()&&b.right<a.left&&a.width>500&&home.scrollWidth===home.clientWidth
        &&shortcuts.getBoundingClientRect().height<160&&row.getBoundingClientRect().height<90
        &&document.documentElement.scrollWidth===innerWidth
        &&[...home.querySelectorAll('button')].filter(node=>node.checkVisibility()).every(node=>{const r=node.getBoundingClientRect();return r.left>=a.left&&r.right<=a.right});
    })()`)
    if (!fits) throw new Error(`数据库首页在 ${width} ${scheme} 下溢出或左栏丢失`)
    images.push(await capture(`verify-database-home-${width}-${scheme}.png`))
  }
  /* oxlint-enable no-await-in-loop */
  win.setSize(1280, 800)
  win.webContents.setZoomFactor(2)
  await js('new Promise(resolve=>setTimeout(resolve,350))')
  if (
    !(await js(
      `(()=>{const home=document.querySelector('[data-database-home]');return home.clientWidth>0&&home.scrollWidth===home.clientWidth})()`,
    ))
  )
    throw new Error('数据库首页在 200% 缩放下出现横向溢出')
  images.push(await capture('verify-database-home-zoom.png'))
  win.webContents.setZoomFactor(1)
  win.setSize(1800, 1000)
  await js('new Promise(resolve=>setTimeout(resolve,350))')
  await js("document.querySelector('[data-database-home]').dir='rtl'")
  images.push(await capture('verify-database-home-rtl.png'))
  await js("document.querySelector('[data-database-home]').removeAttribute('dir')")
  await emulateVerificationMedia(win, [
    { name: 'forced-colors', value: 'active' },
    { name: 'prefers-reduced-motion', value: 'reduce' },
    { name: 'prefers-reduced-transparency', value: 'reduce' },
  ])
  await js('new Promise(resolve=>setTimeout(resolve,350))')
  images.push(await capture('verify-database-home-accessible.png'))
  await emulateVerificationMedia(win)
  await click('[aria-label="历史查询"] button')
  if (
    !(await js(`document.querySelector('[aria-label="SQL 查询内容"]')?.value.startsWith('SELECT')
      &&!document.querySelector('[aria-label="数据库查询结果"] table')
      &&document.querySelector('.database-result-footer')?.textContent.includes('尚无结果')
      &&document.querySelector('.database-operation')?.hidden`))
  )
    throw new Error('恢复查询历史未恢复草稿或自动运行了 SQL')
  await click('[aria-label="返回数据库首页"]')
  await click('[aria-label="打开连接 真实 MySQL 验收"]')
  return images
}
