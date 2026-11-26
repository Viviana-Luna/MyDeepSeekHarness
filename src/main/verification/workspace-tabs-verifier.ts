import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { session, WebContentsView, type BrowserWindow } from 'electron'
import type { DesktopSessionFrame } from '../../shared/session-live.ts'
import { clickTrustedElement, emulateVerificationMedia } from './desktop-verifier.ts'

const panel = (id: string) => `[data-work-panel=${JSON.stringify(id)}]`

/** 在隔离核心里运行真实聊天、终端和标签操作；只使用本次验收项目。 */
export async function verifyWorkspaceTabs(
  win: BrowserWindow,
  appearance: (scheme: 'light' | 'dark') => void,
  capture: (name: string) => Promise<string>,
  emit: (frame: DesktopSessionFrame) => void,
  running: (sessionId: string, active: boolean) => void,
): Promise<void> {
  const js = (source: string) => win.webContents.executeJavaScript(source)
  const wait = async (expression: string) => {
    if (
      !(await js(
        `(async()=>{for(let i=0;i<160;i++){if(${expression})return true;await new Promise(r=>setTimeout(r,50))}return false})()`,
      ))
    ) {
      throw new Error(
        `工作标签验收等待失败：${expression}；界面：${await js('document.body.innerText.slice(-1200)')}`,
      )
    }
  }
  const click = (selector: string) => clickTrustedElement(win, selector)
  const chooseMenu = async (label: string) => {
    await wait(
      `[...document.querySelectorAll('[role="menuitem"]')].some(node=>node.checkVisibility()&&node.textContent.includes(${JSON.stringify(label)}))`,
    )
    await js(
      `(()=>{const button=[...document.querySelectorAll('[role="menuitem"]')].find(node=>node.checkVisibility()&&node.textContent.includes(${JSON.stringify(label)}));button.click()})()`,
    )
  }
  const fill = (selector: string, value: string) =>
    js(
      `(()=>{const input=document.querySelector(${JSON.stringify(selector)});input.focus();Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}))})()`,
    )
  const split = async (id: string) => {
    await js(
      `(()=>{const tab=document.querySelector('[data-session-tab='+JSON.stringify(${JSON.stringify(id)})+']');tab.focus();tab.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}))})()`,
    )
    await wait(
      `document.querySelector('.workbench-surface[data-workbench-split]')&&document.querySelectorAll('.work-tab-panel:not([hidden])').length===2`,
    )
  }
  await emulateVerificationMedia(win)
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {
    enabled: true,
  })
  win.webContents.setBackgroundThrottling(false)
  await wait(`document.querySelector('[aria-label="新建工作标签"]')`)
  // 启动初始态仅有 0 或 1 个标签且侧栏展开：先验证自动隐藏顶栏、Liquid Glass 浮动胶囊与渐进模糊。
  await wait(
    `document.querySelector('.app-shell')?.dataset.sessionTabsVisible==='false'&&document.querySelector('.session-chrome')?.getAttribute('aria-hidden')==='true'&&document.querySelector('.session-chrome')?.inert===true&&document.querySelector('[data-floating-tab-actions="true"]')?.checkVisibility()===true&&document.querySelectorAll('[aria-label="平铺选择标签"]').length===1&&document.querySelectorAll('[aria-label="新建工作标签"]').length===1&&document.querySelector('.main-island [data-top-progressive-blur="true"]')!==null`,
  )
  const sessions = (await js(`(async()=>{
    const {workspace}=await window.dshDesktop.host.call('createWorkspace',{path:${JSON.stringify(process.env.MYDSH_VERIFY_PROJECT)}})
    const ids=[]
    for(const title of ['第一份独立草稿','第二份独立草稿','第三个独立标签']){
      const result=await window.dshDesktop.host.call('createSessionForWorkspace',{workspaceId:workspace.workspaceId})
      await window.dshDesktop.host.call('renameSession',{sessionId:result.sessionId,title});ids.push(result.sessionId)
    }
    return ids
  })()`)) as string[]
  /* oxlint-disable no-await-in-loop -- 同一窗口的焦点、资源状态与截图必须顺序验收。 */
  for (const [index, id] of sessions.entries()) {
    await click('.session-search-trigger')
    const title = ['第一份独立草稿', '第二份独立草稿', '第三个独立标签'][index]!
    await wait(
      `[...document.querySelectorAll('.session-search-result')].some(node=>node.textContent.includes(${JSON.stringify(title)}))`,
    )
    await js(
      `(()=>{const result=[...document.querySelectorAll('.session-search-result')].find(node=>node.textContent.includes(${JSON.stringify(title)}));result.id='verify-open-work-tab'})()`,
    )
    await click('#verify-open-work-tab')
    await wait(
      `document.querySelector('.session-tab[aria-selected="true"]')?.dataset.sessionTab===${JSON.stringify(id)}`,
    )
    if (index === 0) {
      // 打开第 2 个标签后顶栏平滑展开；macOS 回收浮动胶囊，Windows 继续保留在右侧悬浮胶囊内，且平铺与新建按钮全页唯一。
      await wait(
        `document.querySelectorAll('.session-tab').length>=2&&document.querySelector('.app-shell')?.dataset.sessionTabsVisible==='true'&&document.querySelector('.session-chrome')?.getAttribute('aria-hidden')==='false'&&document.querySelector('.session-chrome')?.inert===false&&(document.documentElement.dataset.platform==='win32'?document.querySelector('[data-floating-tab-actions="true"]')?.checkVisibility()===true:document.querySelector('[data-floating-tab-actions="true"]')===null)&&document.querySelectorAll('[aria-label="平铺选择标签"]').length===1&&document.querySelectorAll('[aria-label="新建工作标签"]').length===1`,
      )
    }
  }
  await click(`[data-session-tab=${JSON.stringify(sessions[1])}]`)
  await wait(`document.querySelector(${JSON.stringify(panel(sessions[1]!))})?.checkVisibility()`)
  await fill(`${panel(sessions[1]!)} textarea`, '乙会话：保留中文、多行与独立草稿\n第二行')
  const images: string[] = []
  const cancelledDrag = (await js(
    `(()=>{const tab=document.querySelector('[data-session-tab='+JSON.stringify(${JSON.stringify(sessions[1])})+']').getBoundingClientRect();return {x:Math.round(tab.left+40),y:Math.round(tab.top+tab.height/2)}})()`,
  )) as { x: number; y: number }
  win.webContents.sendInputEvent({
    type: 'mouseDown',
    ...cancelledDrag,
    button: 'left',
    clickCount: 1,
  })
  win.webContents.sendInputEvent({
    type: 'mouseMove',
    x: cancelledDrag.x + 3,
    y: cancelledDrag.y + 18,
  })
  await wait(`document.querySelector('.tab-drag-card[data-preview-kind="session"]')`)
  if (
    !(await js(`document.querySelector('.tab-drag-snapshot textarea')?.value.includes('乙会话')`))
  )
    throw new Error('拖出标签后没有保留当前草稿的内容预览')
  images.push(await capture('verify-workbench-drag-lift.png'))
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  win.webContents.sendInputEvent({
    type: 'mouseUp',
    ...cancelledDrag,
    button: 'left',
    clickCount: 1,
  })
  await wait(
    `!document.querySelector('.tab-drag-card')&&!document.body.hasAttribute('data-workbench-dragging')`,
  )
  if (await js(`document.querySelector('.workbench-surface').hasAttribute('data-workbench-split')`))
    throw new Error('取消拖拽改变了分屏布局')
  const drag = (await js(
    `(()=>{const a=document.querySelector('[data-session-tab='+JSON.stringify(${JSON.stringify(sessions[0])})+']').getBoundingClientRect(),b=document.querySelector('.workbench-surface').getBoundingClientRect();return {x:Math.round(a.left+a.width/2),y:Math.round(a.top+a.height/2),toX:Math.round(b.right-50),toY:Math.round(b.top+140)}})()`,
  )) as { x: number; y: number; toX: number; toY: number }
  win.webContents.sendInputEvent({ type: 'mouseMove', x: drag.x, y: drag.y })
  win.webContents.sendInputEvent({
    type: 'mouseDown',
    x: drag.x,
    y: drag.y,
    button: 'left',
    clickCount: 1,
  })
  win.webContents.sendInputEvent({ type: 'mouseMove', x: drag.x + 12, y: drag.y + 12 })
  win.webContents.sendInputEvent({ type: 'mouseMove', x: drag.toX, y: drag.toY })
  await wait(`document.querySelector('.tab-split-preview')`)
  await wait(
    `document.querySelectorAll('.tab-split-preview > div').length===2&&document.querySelector('.workbench-surface[data-drop-side="right"]')`,
  )
  images.push(await capture('verify-workbench-drag-placement.png'))
  win.webContents.sendInputEvent({
    type: 'mouseUp',
    x: drag.toX,
    y: drag.toY,
    button: 'left',
    clickCount: 1,
  })
  await wait(`document.querySelector('.workbench-surface[data-workbench-split]')`)
  await wait(`!document.querySelector('.tab-drag-card')`)
  const pair = [sessions[1]!, sessions[0]!]
  const pairSelector = `[data-split-group=${JSON.stringify(JSON.stringify(pair))}]`
  await wait(
    `document.querySelector(${JSON.stringify(pairSelector)})?.querySelectorAll('.session-tab').length===2`,
  )
  // 先把第三个标签拖到两成员之间，再拖组内右侧成员；两次都只能移动整个排序单元。
  for (const [id, target, expected] of [
    [sessions[2]!, pairSelector, [sessions[2]!, ...pair]],
    [sessions[0]!, `[data-session-tab=${JSON.stringify(sessions[2])}]`, [...pair, sessions[2]!]],
  ] as const) {
    const move = (await js(
      `(()=>{const a=document.querySelector('[data-session-tab='+JSON.stringify(${JSON.stringify(id)})+']').getBoundingClientRect(),b=document.querySelector(${JSON.stringify(target)}).getBoundingClientRect(),root=document.querySelector('.session-tab-glass').getBoundingClientRect();return {x:Math.round(a.left+a.width/2),y:Math.round(a.top+a.height/2),toX:Math.round(${id === sessions[0] ? 'root.left+1' : 'b.left+b.width/2'})}})()`,
    )) as { x: number; y: number; toX: number }
    win.webContents.sendInputEvent({
      type: 'mouseDown',
      x: move.x,
      y: move.y,
      button: 'left',
      clickCount: 1,
    })
    win.webContents.sendInputEvent({ type: 'mouseMove', x: move.toX, y: move.y })
    await wait(`document.querySelector('[data-tab-unit][data-dragging]')`)
    if (
      !(await js(
        `(()=>{const unit=document.querySelector('[data-tab-unit][data-dragging]').getBoundingClientRect(),root=document.querySelector('.session-tab-glass').getBoundingClientRect();return unit.left>=root.left-1&&unit.right<=root.right+1})()`,
      ))
    )
      throw new Error('宽标签组拖到边缘时越出标签轨道')
    win.webContents.sendInputEvent({
      type: 'mouseUp',
      x: move.toX,
      y: move.y,
      button: 'left',
      clickCount: 1,
    })
    await wait(
      `JSON.stringify([...document.querySelectorAll('.session-tab')].map(node=>node.dataset.sessionTab).filter(id=>${JSON.stringify(sessions)}.includes(id)))===${JSON.stringify(JSON.stringify(expected))}`,
    )
    if (
      !(await js(
        `document.querySelector(${JSON.stringify(pairSelector)})?.querySelectorAll('.session-tab').length===2`,
      ))
    )
      throw new Error('标签重排拆散了分屏组')
  }
  await wait(
    `(()=>{const units=[...document.querySelectorAll('[data-tab-unit]')].map(node=>node.getBoundingClientRect());return units.every((unit,index)=>index===0||unit.left>=units[index-1].right-1)})()`,
  )
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  images.push(await capture('verify-workbench-group-reorder.png'))

  await fill(`${panel(sessions[0]!)} textarea`, '甲会话：只发送到甲')
  const drafts = await js(
    `document.querySelector(${JSON.stringify(`${panel(sessions[0]!)} textarea`)})?.value==='甲会话：只发送到甲'&&document.querySelector(${JSON.stringify(`${panel(sessions[1]!)} textarea`)})?.value.includes('乙会话')`,
  )
  if (!drafts) throw new Error('分屏聊天草稿发生串用')
  // 长正文仅用于滚动与排版验收；不把投影夹具记为真实模型回复。
  const events = Array.from({ length: 35 }, (_, index) => ({
    type: 'assistant/message',
    seq: index + 1,
    time: 1_700_000_000_000 + index,
    data: {
      turn: index + 1,
      step: 1,
      message: {
        content: [
          {
            type: 'text',
            text:
              `第 ${index + 1} 段：检查实际阅读布局。\n\n` +
              '正文应保持可读，底部输入区不遮挡最后的消息。'.repeat(8),
          },
        ],
      },
    },
  }))
  emit({ type: 'session/snapshot', sessionId: sessions[0]!, events, lastSeq: 35, hasMore: false })
  await wait(
    `document.querySelector(${JSON.stringify(panel(sessions[0]!))})?.textContent.includes('第 35 段')`,
  )
  await wait(
    `(()=>{const pane=document.querySelector(${JSON.stringify(panel(sessions[0]!))}),view=pane.querySelector('[aria-label="会话对话"]');return view&&Math.abs(view.scrollHeight-view.clientHeight-view.scrollTop)<2&&Math.abs(view.getBoundingClientRect().bottom-pane.getBoundingClientRect().bottom)<3})()`,
  )
  // 在已有长对话和双窗格中检查恢复状态，后台恢复与取消由真实 Agent 测试覆盖。
  let recoverySeq = 36
  const recovery = (type: string, data: Record<string, unknown>) =>
    emit({
      type: 'session/event',
      sessionId: sessions[0]!,
      event: { type, seq: recoverySeq++, time: Date.now(), data },
    })
  running(sessions[0]!, true)
  recovery('turn/start', { turn: 36 })
  recovery('step/start', { turn: 36, step: 1 })
  recovery('user/message', {
    source: { kind: 'user' },
    content: [{ type: 'text', text: '断线后保留已有工具结果并继续' }],
  })
  recovery('llm/retry', {
    turn: 36,
    step: 1,
    retryId: 'verify-recovery',
    retry: 3,
    maxRetries: 5,
    delayMs: 30_000,
    failure: {
      code: 'NETWORK',
      message: 'ChatGPT 发送请求或等待响应失败：other side closed (UND_ERR_SOCKET)',
    },
  })
  await wait(`document.querySelector('[data-model-retry="waiting"]')`)
  await click('[data-model-retry] summary')
  for (const [width, scheme] of [
    [1280, 'dark'],
    [1280, 'light'],
    [1800, 'dark'],
    [1800, 'light'],
  ] as const) {
    win.setSize(width, width === 1280 ? 800 : 1000)
    appearance(scheme)
    await js('new Promise(r=>setTimeout(r,500))')
    await js(
      `(()=>{const view=document.querySelector(${JSON.stringify(panel(sessions[0]!))}).querySelector('[aria-label="会话对话"]');view.scrollTop=view.scrollHeight})()`,
    )
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    const layout = await js(
      `(()=>{const panes=[...document.querySelectorAll('.work-tab-panel:not([hidden])')].map(node=>node.getBoundingClientRect()).sort((a,b)=>a.left-b.left);const root=getComputedStyle(document.documentElement);return panes.length===2&&panes.every(r=>r.width>300&&r.height>450&&r.bottom<=innerHeight)&&panes[0].right<panes[1].left&&root.getPropertyValue('--window-edge')===root.getPropertyValue('--window-gap')&&document.documentElement.scrollWidth===innerWidth})()`,
    )
    if (!layout)
      throw new Error(
        '双窗格尺寸、间距或根滚动验收失败：' +
          JSON.stringify(
            await js(
              `({panes:[...document.querySelectorAll('.work-tab-panel:not([hidden])')].map(node=>node.getBoundingClientRect().toJSON()),width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth,edge:getComputedStyle(document.documentElement).getPropertyValue('--window-edge'),gap:getComputedStyle(document.documentElement).getPropertyValue('--window-gap')})`,
            ),
          ),
      )
    images.push(await capture(`verify-workbench-${width}-${scheme}.png`))
    const recoveryLayout = await js(
      `(()=>{const row=document.querySelector('[data-model-retry]'),s=row&&getComputedStyle(row),r=row?.getBoundingClientRect(),composer=row?.closest('.work-tab-panel')?.querySelector('.composer-card')?.getBoundingClientRect();return {visible:row?.checkVisibility(),count:row?.textContent.includes('3 / 5'),reason:row?.textContent.includes('UND_ERR_SOCKET'),fits:row&&row.scrollWidth<=row.clientWidth+1&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=composer.top,border:s&&['Top','Right','Bottom','Left'].every(side=>parseFloat(s['border'+side+'Width'])>0),background:s?.backgroundColor,stop:!!document.querySelector('button[aria-label="停止运行"]'),rect:r?.toJSON()}})()`,
    )
    if (
      !recoveryLayout.visible ||
      !recoveryLayout.count ||
      !recoveryLayout.reason ||
      !recoveryLayout.fits ||
      !recoveryLayout.border ||
      recoveryLayout.background === 'rgba(0, 0, 0, 0)' ||
      !recoveryLayout.stop
    )
      throw new Error('恢复提示布局验收失败：' + JSON.stringify(recoveryLayout))
  }
  await emulateVerificationMedia(win, [
    { name: 'forced-colors', value: 'active' },
    { name: 'prefers-reduced-motion', value: 'reduce' },
    { name: 'prefers-reduced-transparency', value: 'reduce' },
  ])
  await wait(`document.querySelector('[data-model-retry]')?.checkVisibility()`)
  images.push(await capture('verify-workbench-retry-accessible.png'))
  await emulateVerificationMedia(win)
  recovery('llm/retry-started', { turn: 36, step: 1, retryId: 'verify-recovery', retry: 3 })
  await wait(
    `document.querySelector('[data-model-retry="requesting"]')?.textContent.includes('正在等待响应')`,
  )
  recovery('assistant/chunk', {
    turn: 36,
    step: 1,
    chunk: { type: 'text-delta', index: 0, text: '连接已恢复' },
  })
  await wait(
    `!document.querySelector('[data-model-retry]')&&document.querySelector(${JSON.stringify(panel(sessions[0]!))})?.textContent.includes('连接已恢复')`,
  )
  recovery('turn/end', { turn: 36, reason: { kind: 'completed' } })
  running(sessions[0]!, false)
  console.log('desktop-shell-verify-local: request-recovery', {
    waiting: true,
    requesting: true,
    resumed: true,
    themes: 2,
    sizes: 2,
    accessible: true,
  })
  const divider = (await js(
    `(()=>{const bar=document.querySelector('[aria-label="调整分屏比例"]').getBoundingClientRect();return {x:Math.round(bar.left+bar.width/2),y:Math.round(bar.top+100)}})()`,
  )) as { x: number; y: number }
  win.webContents.sendInputEvent({ type: 'mouseDown', ...divider, button: 'left', clickCount: 1 })
  win.webContents.sendInputEvent({ type: 'mouseMove', x: divider.x + 130, y: divider.y })
  await wait(
    `Number(document.querySelector('[aria-label="调整分屏比例"]').getAttribute('aria-valuenow'))>55`,
  )
  win.webContents.sendInputEvent({
    type: 'mouseUp',
    x: divider.x + 130,
    y: divider.y,
    button: 'left',
    clickCount: 1,
  })
  images.push(await capture('verify-workbench-resized-split.png'))
  const groupedRatio = await js(
    `document.querySelector('[aria-label="调整分屏比例"]').getAttribute('aria-valuenow')`,
  )
  const rejectedDrag = (await js(
    `(()=>{const tab=document.querySelector('[data-session-tab='+JSON.stringify(${JSON.stringify(sessions[2])})+']').getBoundingClientRect(),surface=document.querySelector('.workbench-surface').getBoundingClientRect();return {x:Math.round(tab.left+40),y:Math.round(tab.top+tab.height/2),toX:Math.round(surface.right-60),toY:Math.round(surface.top+160)}})()`,
  )) as { x: number; y: number; toX: number; toY: number }
  win.webContents.sendInputEvent({
    type: 'mouseDown',
    x: rejectedDrag.x,
    y: rejectedDrag.y,
    button: 'left',
    clickCount: 1,
  })
  win.webContents.sendInputEvent({ type: 'mouseMove', x: rejectedDrag.toX, y: rejectedDrag.toY })
  await wait(`document.querySelector('.tab-drag-card[data-drop-invalid]')`)
  if (
    await js(`!!document.querySelector('.tab-split-preview, .workbench-surface[data-drop-side]')`)
  )
    throw new Error('满员分屏组仍显示可接纳第三标签的落点')
  images.push(await capture('verify-workbench-full-group-rejected.png'))
  win.webContents.sendInputEvent({
    type: 'mouseUp',
    x: rejectedDrag.toX,
    y: rejectedDrag.toY,
    button: 'left',
    clickCount: 1,
  })
  await wait(
    `!document.querySelector('.tab-drag-card')&&!document.body.hasAttribute('data-workbench-dragging')`,
  )
  if (
    !(await js(
      `document.querySelector(${JSON.stringify(pairSelector)})?.querySelectorAll('.session-tab').length===2&&document.querySelectorAll('.work-tab-panel:not([hidden])').length===2&&[...document.querySelectorAll('.work-tab-panel:not([hidden])')].every(node=>${JSON.stringify(pair)}.includes(node.dataset.workPanel))&&document.querySelector('[aria-label="调整分屏比例"]').getAttribute('aria-valuenow')===${JSON.stringify(groupedRatio)}`,
    ))
  )
    throw new Error('无效拖入改变了原分屏成员、焦点或比例')
  await click(`[data-session-tab=${JSON.stringify(sessions[2])}]`)
  await wait(
    `document.querySelectorAll('.work-tab-panel:not([hidden])').length===1&&document.querySelector('.work-tab-panel:not([hidden])')?.dataset.workPanel===${JSON.stringify(sessions[2])}&&!document.querySelector('.workbench-surface[data-workbench-split]')`,
  )
  await fill(`${panel(sessions[2]!)} textarea`, '丙会话：这是独立标签，不替换甲乙')
  images.push(await capture('verify-workbench-outside-group.png'))
  await click(`[data-session-tab=${JSON.stringify(sessions[0])}]`)
  await wait(
    `document.querySelectorAll('.work-tab-panel:not([hidden])').length===2&&[...document.querySelectorAll('.work-tab-panel:not([hidden])')].every(node=>${JSON.stringify(sessions.slice(0, 2))}.includes(node.dataset.workPanel))`,
  )
  if (
    !(await js(
      `document.querySelector('[aria-label="调整分屏比例"]').getAttribute('aria-valuenow')===${JSON.stringify(groupedRatio)}&&document.querySelector(${JSON.stringify(`${panel(sessions[1]!)} textarea`)})?.value.includes('乙会话')`,
    ))
  )
    throw new Error('返回分屏组后原成员、比例或草稿丢失')
  await click(`[data-session-tab=${JSON.stringify(sessions[2])}]`)
  await wait(
    `document.querySelector(${JSON.stringify(`${panel(sessions[2]!)} textarea`)})?.checkVisibility()`,
  )
  if (
    !(await js(
      `document.querySelector(${JSON.stringify(`${panel(sessions[2]!)} textarea`)})?.value.includes('丙会话')`,
    ))
  )
    throw new Error('独立标签草稿被分屏切换覆盖')
  await click(`[data-session-tab=${JSON.stringify(sessions[1])}]`)
  await wait(`document.querySelectorAll('.work-tab-panel:not([hidden])').length===2`)
  images.push(await capture('verify-workbench-restored-group.png'))
  await js(
    `document.querySelector('[aria-label="调整分屏比例"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`,
  )
  await wait(
    `document.querySelector('[aria-label="调整分屏比例"]').getAttribute('aria-valuenow')==='50'`,
  )
  await click('[aria-label="平铺选择标签"]')
  await wait(`document.querySelector('.tab-overview input')`)
  await fill('.tab-overview input', '第二份')
  await wait(`document.querySelectorAll('.tab-overview-card').length===1`)
  await click('.tab-overview-select')
  await wait(`!document.querySelector('.tab-overview')?.checkVisibility()`)
  await click('[aria-label="合并分屏"]')
  await wait(`document.querySelectorAll('.work-tab-panel:not([hidden])').length===1`)
  const conversationNavigation = (await js(
    `document.querySelector('.navigation-island')?.innerHTML ?? ''`,
  )) as string
  const assertConversationSidebarUnchanged = async (context: string) => {
    const ok = await js(
      `(()=>{const nav=document.querySelector('.navigation-island');const tab=document.querySelector('[data-view="conversation"]');return nav instanceof HTMLElement&&nav.innerHTML.length>0&&nav.innerHTML===${JSON.stringify(conversationNavigation)}&&nav.querySelector('.session-row')!==null&&nav.querySelector('[aria-label="项目文件树"]')===null&&tab?.getAttribute('aria-current')==='page'})()`,
    )
    if (!ok) throw new Error(`${context}改变了左侧导航栏或高亮模式`)
  }
  await assertConversationSidebarUnchanged('切换顶部标签前')
  await click('[aria-label="新建工作标签"]')
  await chooseMenu('新终端')
  await wait(`document.querySelector('[data-terminal-id]')`)
  await assertConversationSidebarUnchanged('新建并切换到终端标签')
  await click('[aria-label="新建工作标签"]')
  await chooseMenu('新终端')
  await wait(`document.querySelectorAll('[data-terminal-id]').length===2`)
  const terminalTabs = (await js(
    `[...document.querySelectorAll('[data-work-tab="terminal"]')].map(node=>node.dataset.sessionTab)`,
  )) as string[]
  await split(terminalTabs[0]!)
  const terminalIds = (await js(
    `[...document.querySelectorAll('[data-terminal-id]')].map(node=>node.dataset.terminalId)`,
  )) as string[]
  for (const [index, id] of terminalIds.entries()) {
    await js(
      `window.dshDesktop.terminal.write(${JSON.stringify(id)},${JSON.stringify(`printf '终端-${index + 1}\\n'; sleep 20\n`)})`,
    )
  }
  await wait(
    `[...document.querySelectorAll('[data-terminal-id]')].every(node=>node.checkVisibility()&&node.querySelector('.xterm-screen'))`,
  )
  await js('new Promise(r=>setTimeout(r,400))')
  await click('[aria-label="合并分屏"]')
  await split(terminalTabs[1]!)
  if (
    !(await js(
      `[...document.querySelectorAll('[data-terminal-id]')].every(node=>${JSON.stringify(terminalIds)}.includes(node.dataset.terminalId))`,
    ))
  )
    throw new Error('分屏或合并重建了终端 PTY')
  await wait(
    `[...document.querySelectorAll('[data-terminal-id]')].every(node=>node.checkVisibility())`,
  )
  await wait(`!document.querySelector('.workbench-surface[data-layout-moving]')`)
  const terminalsFit = await js(`(() => {
    const surface = document.querySelector('.workbench-surface[data-workbench-split]')
    const bounds = surface.getBoundingClientRect()
    const panes = [...surface.querySelectorAll(':scope > .work-tab-panel:not([hidden])')]
      .map(node => node.getBoundingClientRect()).sort((left, right) => left.left - right.left)
    return panes.length === 2 && panes[0].right <= panes[1].left
      && panes.every(pane => pane.left >= bounds.left - 1 && pane.right <= bounds.right + 1)
  })()`)
  if (!terminalsFit) throw new Error('终端分屏在动画结束后仍重叠或越出工作台')
  images.push(await capture('verify-workbench-terminals.png'))
  await js(
    `document.querySelector('[data-session-tab='+JSON.stringify(${JSON.stringify(terminalTabs[0])})+']').parentElement.querySelector('.session-tab-close').click()`,
  )
  await wait(`document.querySelectorAll('[data-terminal-id]').length===1`)
  await click(`[data-session-tab=${JSON.stringify(sessions[1])}]`)
  await split(terminalTabs[1]!)
  await wait(`!document.querySelector('.workbench-surface[data-layout-moving]')`)
  await js('new Promise(resolve=>setTimeout(resolve,350))')
  const navigation = await js(`document.querySelector('.navigation-island').innerHTML`)
  for (const id of [sessions[1]!, terminalTabs[1]!, sessions[1]!, terminalTabs[1]!]) {
    await click(`${panel(id)} ${id === sessions[1] ? 'textarea' : '.xterm-screen'}`)
    await wait(
      `document.querySelector('.session-tab[aria-selected="true"]')?.dataset.sessionTab===${JSON.stringify(id)}&&document.querySelector('.work-tab-panel[data-focused]')?.dataset.workPanel===${JSON.stringify(id)}`,
    )
    if (
      !(await js(
        `document.querySelector('.navigation-island').innerHTML===${JSON.stringify(navigation)}&&!document.getAnimations().some(animation=>animation.effect?.getKeyframes().some(frame=>String(frame.transform).includes('translateY')))`,
      ))
    )
      throw new Error('终端与聊天之间切换焦点仍触发全局模式动画或改变侧栏')
  }
  await fill(`${panel(sessions[1]!)} textarea`, '混合分屏：焦点、左右交换后保留草稿')
  await click(`[data-session-tab=${JSON.stringify(terminalTabs[1])}]`)
  await wait(
    `document.querySelector('.session-tab[aria-selected="true"]')?.dataset.sessionTab===${JSON.stringify(terminalTabs[1])}`,
  )
  await js(
    `document.querySelector('[aria-label="调整分屏比例"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`,
  )
  const mixedRatio = await js(
    `document.querySelector('[aria-label="调整分屏比例"]').getAttribute('aria-valuenow')`,
  )
  const swap = (await js(
    `(()=>{const a=document.querySelector('[data-session-tab='+JSON.stringify(${JSON.stringify(terminalTabs[1])})+']').getBoundingClientRect(),b=document.querySelector(${JSON.stringify(panel(sessions[1]!))}).getBoundingClientRect();return {x:Math.round(a.left+40),y:Math.round(a.top+a.height/2),toX:Math.round(b.left+b.width/2),toY:Math.round(b.top+120)}})()`,
  )) as { x: number; y: number; toX: number; toY: number }
  win.webContents.sendInputEvent({
    type: 'mouseDown',
    x: swap.x,
    y: swap.y,
    button: 'left',
    clickCount: 1,
  })
  win.webContents.sendInputEvent({ type: 'mouseMove', x: swap.toX, y: swap.toY })
  await wait(`document.querySelector('.tab-split-preview[data-drop-action="swap"]')`)
  images.push(await capture('verify-workbench-swap-preview.png'))
  win.webContents.sendInputEvent({
    type: 'mouseUp',
    x: swap.toX,
    y: swap.toY,
    button: 'left',
    clickCount: 1,
  })
  await wait(
    `!document.querySelector('.tab-drag-card')&&!document.querySelector('.workbench-surface[data-layout-moving]')`,
  )
  if (
    !(await js(
      `(()=>{const terminal=document.querySelector(${JSON.stringify(panel(terminalTabs[1]!))}),chat=document.querySelector(${JSON.stringify(panel(sessions[1]!))});return terminal.getBoundingClientRect().left<chat.getBoundingClientRect().left&&terminal.querySelector('[data-terminal-id]').dataset.terminalId===${JSON.stringify(terminalIds[1])}&&chat.querySelector('textarea').value.includes('混合分屏')&&document.querySelector('[aria-label="调整分屏比例"]').getAttribute('aria-valuenow')===${JSON.stringify(mixedRatio)}&&document.querySelector('.navigation-island').innerHTML===${JSON.stringify(navigation)}&&document.querySelector('[data-session-tab='+JSON.stringify(${JSON.stringify(terminalTabs[1])})+']').closest('[data-split-group]').dataset.splitGroup===${JSON.stringify(JSON.stringify([terminalTabs[1], sessions[1]]))}})()`,
    ))
  )
    throw new Error('左右交换没有同步顶部成员顺序，或改变了资源、比例与模式')
  images.push(await capture('verify-workbench-mixed-focus-swap.png'))
  await click('[aria-label="合并分屏"]')
  await wait(
    `document.querySelectorAll('.work-tab-panel:not([hidden])').length===1&&document.querySelector('.work-tab-panel:not([hidden])').dataset.workPanel===${JSON.stringify(terminalTabs[1])}`,
  )
  await click('[aria-label="新建工作标签"]')
  await chooseMenu('新浏览器')
  await wait(`document.querySelector('[data-work-tab="browser"]')`)
  await assertConversationSidebarUnchanged('新建并切换到浏览器标签')
  await click('[aria-label="新建工作标签"]')
  await chooseMenu('新浏览器')
  await wait(`document.querySelectorAll('[data-work-tab="browser"]').length===2`)
  const browsers = (await js(
    `[...document.querySelectorAll('[data-work-tab="browser"]')].map(node=>node.dataset.sessionTab)`,
  )) as string[]
  await split(browsers[0]!)
  await wait(
    `document.querySelectorAll('.work-tab-panel:not([hidden]) [aria-label="网页地址"]').length===2`,
  )
  const partition = session.fromPartition('persist:mydsh-browser-v1')
  await partition.protocol.handle(
    'https',
    request =>
      new Response(
        `<html><title>${request.url.endsWith('one') ? '独立网页甲' : '独立网页乙'}</title><body><h1>${request.url}</h1></body></html>`,
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      ),
  )
  try {
    for (const [index, id] of browsers.entries())
      await js(
        `window.dshDesktop.browser.request({action:'navigate',tabId:${JSON.stringify(id.slice(8))},url:${JSON.stringify('https://mydsh-tabs-verify.invalid/' + (index === 0 ? 'one' : 'two'))}})`,
      )
    await wait(
      `!document.querySelector('.workbench-surface[data-layout-moving]')&&[...document.querySelectorAll('.work-tab-panel:not([hidden]) .browser-caption')].map(node=>node.textContent??'').filter(text=>text.includes('独立网页甲')||text.includes('独立网页乙')).length===2`,
    )
    let guests: WebContentsView[] = []
    for (let attempt = 0; attempt < 80; attempt += 1) {
      guests = win.contentView.children.filter(
        (child): child is WebContentsView =>
          child instanceof WebContentsView && child.webContents !== win.webContents,
      )
      if (
        guests.length === 2 &&
        guests.every(guest => guest.getVisible()) &&
        new Set(guests.map(guest => guest.webContents.getURL())).size === 2
      )
        break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    if (
      guests.length !== 2 ||
      guests.some(guest => !guest.getVisible()) ||
      new Set(guests.map(guest => guest.webContents.getURL())).size !== 2
    ) {
      const diagnostics = {
        contentSize: win.getContentSize(),
        zoomFactor: win.webContents.getZoomFactor(),
        guests: guests.map(guest => ({
          visible: guest.getVisible(),
          url: guest.webContents.getURL(),
          bounds: guest.getBounds(),
        })),
        viewports: await js(
          `[...document.querySelectorAll('.work-tab-panel:not([hidden]) .browser-viewport')].map(node=>node.getBoundingClientRect().toJSON())`,
        ),
        layoutMoving: await js(`Boolean(document.querySelector('[data-layout-moving]'))`),
      }
      throw new Error(`两个浏览器没有呈现独立网页：${JSON.stringify(diagnostics)}`)
    }
    const browserDrag = (await js(
      `(()=>{const tab=document.querySelector('[data-session-tab='+JSON.stringify(${JSON.stringify(browsers[0])})+']').getBoundingClientRect();return {x:Math.round(tab.left+30),y:Math.round(tab.top+tab.height/2)}})()`,
    )) as { x: number; y: number }
    win.webContents.sendInputEvent({
      type: 'mouseDown',
      ...browserDrag,
      button: 'left',
      clickCount: 1,
    })
    win.webContents.sendInputEvent({
      type: 'mouseMove',
      x: browserDrag.x + 30,
      y: browserDrag.y + 120,
    })
    await wait(`document.querySelector('.tab-drag-card[data-preview-kind="browser"]')`)
    await js('new Promise(r=>setTimeout(r,150))')
    if (guests.some(guest => guest.getVisible())) throw new Error('原生网页遮挡拖拽预览')
    images.push(await capture('verify-workbench-browser-drag.png'))
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    win.webContents.sendInputEvent({
      type: 'mouseUp',
      ...browserDrag,
      button: 'left',
      clickCount: 1,
    })
    await wait(`!document.querySelector('.tab-drag-card')`)
    await js('new Promise(r=>setTimeout(r,300))')
    if (guests.some(guest => !guest.getVisible())) throw new Error('取消拖拽后原生网页没有恢复')
    await click('[aria-label="平铺选择标签"]')
    await wait(`document.querySelector('.tab-overview')?.checkVisibility()`)
    await js('new Promise(r=>setTimeout(r,250))')
    if (guests.some(guest => guest.getVisible())) throw new Error('原生网页遮挡平铺窗口')
    await click('.tab-overview .ant-modal-close')
    await wait(`!document.querySelector('.tab-overview')?.checkVisibility()`)
    await js('new Promise(r=>setTimeout(r,250))')
    images.push(await capture('verify-workbench-browsers.png'))
  } finally {
    partition.protocol.unhandle('https')
  }

  await click(`[data-session-tab=${JSON.stringify(sessions[1])}]`)
  await wait(`document.querySelector(${JSON.stringify(panel(sessions[1]!))})?.checkVisibility()`)
  const externalText = '来自项目目录外的附件，保留中文和原始字节。\n'
  const externalPath = join(process.env.MYDSH_VERIFY_HOME!, '外部资料.md')
  writeFileSync(externalPath, externalText, { mode: 0o600 })
  const externalBytes = readFileSync(externalPath)
  await js(
    `(()=>{const transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array(${JSON.stringify([...externalBytes])})],'外部资料.md',{type:'text/markdown'}));document.querySelector(${JSON.stringify(panel(sessions[1]!) + ' .composer-card')}).dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}))})()`,
  )
  await wait(
    `document.querySelector(${JSON.stringify(panel(sessions[1]!) + ' [data-upload-status="ready"]')})?.textContent.includes('外部资料.md')`,
  )
  const digest = createHash('sha256').update(externalBytes).digest('hex')
  const stored = join(
    process.env.MYDSH_HOME!,
    'data',
    'attachments',
    'v1',
    'files',
    digest.slice(0, 2),
    digest,
    '外部资料.md',
  )
  if (!readFileSync(stored).equals(externalBytes))
    throw new Error('普通附件没有按原始字节保存到会话附件存储')
  await fill(`${panel(sessions[1]!)} textarea`, '检查所附的项目外文件。')
  await click(`${panel(sessions[1]!)} [aria-label="发送"]`)
  await wait(
    `document.querySelector(${JSON.stringify(panel(sessions[1]!) + ' .message-file-attachment')})?.textContent.includes('外部资料.md')`,
  )
  await wait(
    `!document.querySelector(${JSON.stringify(panel(sessions[1]!) + ' .composer-file-attachments')})`,
  )
  console.log('mydsh-workbench-verify: file-attachment', {
    storedBytes: externalBytes.length,
    history: true,
    projectBoundary: '附件独立于项目目录',
    modelReply: '未使用外部模型凭据验收',
  })
  images.push(await capture('verify-workbench-file-attachment.png'))
  await emulateVerificationMedia(win, [
    { name: 'forced-colors', value: 'active' },
    { name: 'prefers-reduced-motion', value: 'reduce' },
    { name: 'prefers-reduced-transparency', value: 'reduce' },
  ])
  images.push(await capture('verify-workbench-accessible.png'))
  await emulateVerificationMedia(win)
  win.webContents.send('mydsh:workspace:tab-action', { action: 'overview' })
  await wait(`document.querySelector('.tab-overview')?.checkVisibility()`)
  await click('.tab-overview .ant-modal-close')
  await wait(`!document.querySelector('.tab-overview')?.checkVisibility()`)
  await click('[data-view="files"]')
  for (const path of ['README.md', 'package.json']) {
    await wait(
      `document.querySelector('.tree-row[title='+JSON.stringify(${JSON.stringify(path)})+']')`,
    )
    await click(`.tree-row[title=${JSON.stringify(path)}]`)
    await wait(
      `document.querySelector('[data-file-path='+JSON.stringify(${JSON.stringify(path)})+'] .cm-content')`,
    )
    await js(
      `document.querySelector('.tree-row[title='+JSON.stringify(${JSON.stringify(path)})+']').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`,
    )
  }
  const fileTabs = (await js(
    `[...document.querySelectorAll('[data-work-tab="file"]')].map(node=>node.dataset.sessionTab)`,
  )) as string[]
  if (fileTabs.length !== 2) throw new Error('两个文件没有保留独立标签')
  await split(fileTabs[0]!)
  await wait(
    `document.querySelectorAll('.work-tab-panel:not([hidden]) [data-file-path]').length===2`,
  )
  await js(`document.querySelector('[data-file-path="README.md"] .cm-content').focus()`)
  await win.webContents.insertText('未保存的双窗格正文\n')
  await wait(
    `document.querySelector('[data-session-tab='+JSON.stringify(${JSON.stringify(fileTabs[0])})+']')?.closest('.session-tab-shell')?.dataset.dirty==='true'`,
  )
  const beforeClose = (await js(`document.querySelectorAll('.session-tab').length`)) as number
  const navigationWasExpanded = await js(
    `document.querySelector('.app-shell').dataset.navigationCollapsed !== 'true'`,
  )
  if (navigationWasExpanded) await click('.panel-divider--navigation .panel-divider__capsule')
  await click('.session-group-switcher')
  await click('.session-group-close')
  await wait(`document.querySelector('.unsaved-dialog[open]')`)
  await click('[aria-label="取消离开文件"]')
  if (
    !(await js(
      `document.querySelectorAll('.session-tab').length===${beforeClose}&&document.querySelector('[data-file-path="README.md"] .cm-content')?.textContent.includes('未保存的双窗格正文')`,
    ))
  )
    throw new Error('取消整组关闭后标签或文件草稿丢失')
  images.push(await capture('verify-workbench-files.png'))
  await click('.session-group-switcher')
  await click('.session-group-close')
  await wait(`document.querySelector('.unsaved-dialog[open]')`)
  await click('.unsaved-dialog__discard')
  await wait(
    `document.querySelectorAll('.session-tab').length===0&&!document.querySelector('[data-terminal-id]')`,
  )
  if (navigationWasExpanded) await click('.panel-divider--navigation .panel-divider__capsule')
  await js(
    `window.dshDesktop.host.call('promptSession',{sessionId:${JSON.stringify(sessions[0])},mode:'queue',content:[{type:'text',text:'归档多选验收正文'}]})`,
  )
  await wait(
    `(await window.dshDesktop.host.call('listSessions',{})).items.some(item=>item.sessionId===${JSON.stringify(sessions[0])}&&!item.blank&&!item.running)`,
  )
  for (const id of sessions.slice(0, 2))
    await js(`window.dshDesktop.host.call('archiveSession',{sessionId:${JSON.stringify(id)}})`)
  await click('#open-settings')
  await wait(`document.querySelector('.settings-nav__items [data-menu-id*="archived-sessions"]')`)
  await click('.settings-nav__items [data-menu-id*="archived-sessions"]')
  await wait(`document.querySelectorAll('.settings-archive-list > li').length===2`)
  await fill('[aria-label="搜索已归档会话"]', '第二份')
  await wait(`document.querySelectorAll('.settings-archive-list > li').length===1`)
  await click('.settings-archive-selection input[type="checkbox"]')
  await wait(
    `document.querySelector('.settings-archive-selection')?.textContent.includes('已选 1 项')`,
  )
  await fill('[aria-label="搜索已归档会话"]', '')
  await wait(
    `document.querySelector('.settings-archive-selection')?.textContent.includes('已选 0 项')`,
  )
  await click('.settings-archive-selection input[type="checkbox"]')
  await js(
    `[...document.querySelectorAll('.settings-archive-selection button')].find(node=>node.textContent.includes('删除所选')).click()`,
  )
  await wait(
    `document.querySelector('.ant-modal:has(.settings-archive-delete-list)')?.textContent.includes('永久删除 2 个归档会话')`,
  )
  images.push(await capture('verify-workbench-archive-selection.png'))
  await click('.ant-modal:has(.settings-archive-delete-list) .ant-btn-dangerous')
  await wait(`document.querySelector('.settings-page')?.textContent.includes('暂无已归档会话')`)
  await click('[aria-label="关闭设置"]')
  console.log('MYDSH_WORKBENCH_VISUAL_READY ' + JSON.stringify(images))
  console.log('mydsh-workbench-verify: complete', {
    autoHideSingleTab: true,
    independentDrafts: true,
    fixedSplitGroup: true,
    atomicGroupReorder: true,
    fullGroupRejected: true,
    paneFocusStable: true,
    swapSplit: true,
    dragPreview: true,
    cancelledDrag: true,
    resizeSplit: true,
    twoPanes: true,
    terminalIdentity: true,
    terminalClosed: true,
    twoBrowsers: true,
    fileDraft: true,
    closeGroupCancelled: true,
    closeGroup: true,
    archivedMultiSelect: true,
    overview: true,
    themes: true,
    accessible: true,
  })
  /* oxlint-enable no-await-in-loop */
}
