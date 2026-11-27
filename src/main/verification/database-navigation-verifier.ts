/** 在真实 renderer 中检查数据库侧栏顶部的同行搜索、紧凑操作按钮和分组。 */
import type { BrowserWindow } from 'electron'
import { clickTrustedElement } from './desktop-verifier.ts'
import { pollRenderer } from './verification-wait.ts'

/** 使用当前隔离窗口中的连接创建分组；数据随验收用户目录一起清理。 */
export async function verifyDatabaseNavigation(win: BrowserWindow): Promise<void> {
  const js = (source: string) => win.webContents.executeJavaScript(source)
  const click = (selector: string) => clickTrustedElement(win, selector)
  const wait = async (expression: string) => {
    if (
      !(await js(
        `(async()=>{for(let i=0;i<80;i++){if(${expression})return true;await new Promise(resolve=>setTimeout(resolve,50))}return false})()`,
      ))
    )
      throw new Error(`数据库侧栏等待失败：${expression}`)
  }
  const fill = (selector: string, value: string) =>
    js(`(()=>{
    const input=document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});
    input.dispatchEvent(new Event('input',{bubbles:true}));
  })()`)
  const layout = await pollRenderer<Record<string, unknown>>(win, {
    probe: `(()=>{
      const nav=document.querySelector('.database-navigation-list'),toolbar=nav?.querySelector('[role="toolbar"]'),search=toolbar?.querySelector('[role="search"]'),actions=toolbar?.querySelector('.database-navigation-toolbar__actions'),list=nav?.querySelector('.database-tree-scroll')
      if (!nav || !toolbar || !search || !actions || !list) return { ok: false, missing: true }
      const b=search.getBoundingClientRect(),c=list.getBoundingClientRect(),d=actions.getBoundingClientRect()
      const labels=[...actions.querySelectorAll('button')].map(node=>node.getAttribute('aria-label')).join('|')
      return {
        ok: !nav.querySelector('h2, footer') && labels==='新增数据库连接|新增数据库分组|刷新数据库连接'
          && Math.abs(b.top-d.top)<6 && b.right<=d.left && b.bottom<=c.top+4,
        labels, search: b.toJSON(), actions: d.toJSON(), listTop: c.top,
      }
    })()`,
    condition: 'state.ok === true',
    timeoutMs: 2_000,
  })
  if (!layout.ok)
    throw new Error(`数据库侧栏的顶部操作或底部搜索位置不正确：${JSON.stringify(layout)}`)
  await click('[aria-label="新增数据库分组"]')
  await wait(`document.querySelector('[aria-label="数据库分组名称"]')?.checkVisibility()`)
  await fill('[aria-label="数据库分组名称"]', '验收分组')
  await js(
    `[...document.querySelectorAll('.ant-modal button')].find(node=>node.textContent.replaceAll(' ','')==='保存分组').click()`,
  )
  await wait(`document.querySelector('[data-database-group]')?.textContent.includes('验收分组')`)
  await click('[aria-label="连接 真实 MySQL 验收 操作"]')
  await wait(
    `[...document.querySelectorAll('[role="menuitem"]')].some(node=>node.textContent==='验收分组'&&node.checkVisibility())`,
  )
  await js(
    `[...document.querySelectorAll('[role="menuitem"]')].find(node=>node.textContent==='验收分组'&&node.checkVisibility()).click()`,
  )
  await wait(
    `document.querySelector('[data-database-connection]')?.closest('.ant-tree-treenode').querySelectorAll('.ant-tree-indent-unit').length===1`,
  )
  const stored = await js(`(()=>{
    const value=JSON.parse(localStorage.getItem('mydsh.database.groups.v1'));
    return value.groups.length===1&&value.groups[0].name==='验收分组'&&Object.values(value.assignments).includes(value.groups[0].id);
  })()`)
  if (!stored) throw new Error('数据库分组没有保存连接归属')
  await fill('[aria-label="搜索数据库对象"]', '验收分组')
  await wait(`document.querySelector('[data-database-connection]')?.checkVisibility()`)
  await fill('[aria-label="搜索数据库对象"]', '')
}
