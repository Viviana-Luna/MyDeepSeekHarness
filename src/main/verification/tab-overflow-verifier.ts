import type { BrowserWindow } from 'electron'
import { clickTrustedElement, emulateVerificationMedia } from './desktop-verifier.ts'
import {
  pollRenderer,
  waitForMediaFeature,
  waitForViewportSettled,
} from './verification-wait.ts'

/** 打开真实会话标签，覆盖多标签边缘、Windows 滚轮和键盘；只操作隔离验收数据。 */
export async function verifyTabOverflow(
  win: BrowserWindow,
  appearance: (scheme: 'light' | 'dark') => void,
  capture: (name: string) => Promise<void>,
): Promise<void> {
  const bounds = win.getBounds()
  const original = (await win.webContents.executeJavaScript(
    `document.querySelector('.session-tab[aria-selected="true"]').dataset.sessionTab`,
  )) as string
  const added: string[] = []
  try {
    win.setSize(1280, 800)
    await waitForViewportSettled(win)
    /* oxlint-disable no-await-in-loop -- 创建、切换和清理同一窗口中的标签必须顺序执行。 */
    for (let index = 0; index < 16; index++) {
      const before = (await win.webContents.executeJavaScript(
        `document.querySelectorAll('.session-tab').length`,
      )) as number
      const title =
        index < 8 ? `标签 ${String(index + 1)}` : `连续打开的工作标签 ${String(index + 1)}`
      // 新建入口会复用空白会话；验收通过公开契约创建独立会话，再从真实搜索入口打开。
      const id = (await win.webContents.executeJavaScript(`(async()=>{
        const {items}=await window.dshDesktop.host.call('listWorkspaces',{})
        const project=items.find(item=>item.sessionIds.includes(${JSON.stringify(original)}))
        const {items:sessions}=await window.dshDesktop.host.call('listSessions',{})
        const session=sessions.find(item=>item.sessionId===${JSON.stringify(original)})
        const result=project
          ? await window.dshDesktop.host.call('createSessionForWorkspace',{workspaceId:project.workspaceId})
          : await window.dshDesktop.host.call('createSession',{...(session?.cwd?{cwd:session.cwd}:{})})
        await window.dshDesktop.host.call('renameSession',{sessionId:result.sessionId,title:${JSON.stringify(title)}})
        return result.sessionId
      })()`)) as string
      added.push(id)
      await clickTrustedElement(win, '.session-search-trigger')
      await win.webContents.executeJavaScript(`(async()=>{
        for(let attempt=0;attempt<120;attempt++) {
          const result=[...document.querySelectorAll('.session-search-result')].find(button=>button.querySelector('strong')?.textContent===${JSON.stringify(title)})
          if(result){result.id='verify-overflow-session';return}
          await new Promise(resolve=>setTimeout(resolve,25))
        }
        throw new Error('多标签验收会话未出现在搜索结果中')
      })()`)
      await clickTrustedElement(win, '#verify-overflow-session')
      await win.webContents.executeJavaScript(`(async()=>{
        for(let attempt=0;attempt<120;attempt++) {
          if(document.querySelectorAll('.session-tab').length===${String(before + 1)}&&document.querySelector('.session-tab[aria-selected="true"]').dataset.sessionTab===${JSON.stringify(id)}) return
          await new Promise(resolve=>setTimeout(resolve,25))
        }
        throw new Error('多标签验收会话未打开')
      })()`)
    }
    for (const width of [1280, 1800])
      for (const scheme of ['dark', 'light'] as const) {
        win.setSize(width, width === 1280 ? 800 : 1000)
        appearance(scheme)
        await waitForViewportSettled(win, { scheme })
        await win.webContents.executeJavaScript(
          `document.querySelector('.session-tabs').scrollTo({left:0,behavior:'instant'})`,
        )
        const polled = await pollRenderer<Record<string, boolean>>(win, {
          probe: `(()=>{
            const frame=document.querySelector('.session-tabs-frame'), strip=frame?.querySelector('.session-tabs')
            const left=frame?.querySelector('.session-tab-scroll--left'), right=frame?.querySelector('.session-tab-scroll--right')
            if (!frame || !strip || !left || !right) return { mounted: false }
            const a=frame.getBoundingClientRect(), b=strip.getBoundingClientRect(), l=left.getBoundingClientRect(), r=right.getBoundingClientRect()
            const shells=[...strip.querySelectorAll('.session-tab-shell')]
            const style=getComputedStyle(strip)
            const available=strip.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)
            const expectedWidth=Math.max(96,available/shells.length)
            return {many:shells.length>=18, overflow:strip.scrollWidth>strip.clientWidth,
              adaptive:shells.every(tab=>Math.abs(tab.getBoundingClientRect().width-expectedWidth)<1),
              density:shells.filter(tab=>{const rect=tab.getBoundingClientRect();return rect.left>=b.left&&rect.right<=b.right}).length>=6,
              rounded:parseFloat(getComputedStyle(frame).borderRadius)===16&&a.height===32,
              noCutLine:getComputedStyle(strip).borderLeftWidth==='0px'&&getComputedStyle(strip).borderRightWidth==='0px',
              controls:l.width===28&&r.width===28&&l.right<=b.left&&r.left>=b.right&&l.top>=a.top&&r.bottom<=a.bottom,
              start:left.disabled&&!right.disabled, fade:getComputedStyle(strip).maskImage!=='none',
              contained:a.left>=0&&a.right<=innerWidth&&document.documentElement.scrollWidth===innerWidth}
          })()`,
          condition: 'Object.values(state).every(value => value === true)',
        })
        const geometry = polled.value
        console.log('desktop-shell-verify-local: tab-overflow', { width, scheme, ...geometry })
        if (!polled.ok)
          throw new Error('多标签外框与滚动入口验收失败：' + JSON.stringify(polled))
        await capture(`verify-tab-overflow-${String(width)}-${scheme}.png`)
      }
    const point = (await win.webContents.executeJavaScript(
      `(()=>{const r=document.querySelector('.session-tabs').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`,
    )) as { x: number; y: number }
    win.webContents.sendInputEvent({ type: 'mouseWheel', ...point, deltaX: 0, deltaY: -120 })
    const wheel = await pollRenderer<{ scrollLeft: number; selected: string | null }>(win, {
      probe: `({
        scrollLeft: document.querySelector('.session-tabs')?.scrollLeft ?? 0,
        selected: document.querySelector('.session-tab[aria-selected="true"]')?.dataset.sessionTab ?? null,
      })`,
      condition: `state.scrollLeft > 1 && state.selected === ${JSON.stringify(added.at(-1))}`,
      timeoutMs: 2_000,
    })
    if (!wheel.ok) throw new Error(`Windows 普通滚轮未横向滚动标签，或误切换当前标签：${JSON.stringify(wheel)}`)
    await capture('verify-tab-overflow-middle.png')
    const variants = (await win.webContents.executeJavaScript(`(()=>{
      const strip=document.querySelector('.session-tabs')
      const check=(init,expected)=>{strip.scrollTo({left:0,behavior:'instant'});const event=new WheelEvent('wheel',{bubbles:true,cancelable:true,...init});strip.dispatchEvent(event);return expected?strip.scrollLeft>0&&event.defaultPrevented:strip.scrollLeft===0&&!event.defaultPrevented}
      return {horizontal:check({deltaX:60},true),lines:check({deltaY:3,deltaMode:1},true),pages:check({deltaY:1,deltaMode:2},true),zoom:check({deltaY:120,ctrlKey:true},false)}
    })()`)) as Record<string, boolean>
    if (Object.values(variants).some(value => !value))
      throw new Error('标签滚轮方向、单位或缩放手势验收失败：' + JSON.stringify(variants))
    await emulateVerificationMedia(win, [{ name: 'prefers-reduced-motion', value: 'reduce' }])
    await waitForMediaFeature(win, '(prefers-reduced-motion: reduce)')
    await clickTrustedElement(win, '.session-tab-scroll--right')
    const scrolledRight = await pollRenderer<number>(win, {
      probe: `document.querySelector('.session-tabs')?.scrollLeft ?? 0`,
      condition: 'state > 0',
      timeoutMs: 1_500,
    })
    if (!scrolledRight.ok) throw new Error(`减少动态模式下滚动按钮无效：${JSON.stringify(scrolledRight)}`)
    await win.webContents.executeJavaScript(
      `(()=>{const tab=document.querySelector('.session-tab-unit:last-child .session-tab-shell:last-child .session-tab');tab.focus();tab.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true,cancelable:true}))})()`,
    )
    const keyboard = await pollRenderer<{ focused: boolean; scrollLeft: number; selected: string | null }>(win, {
      probe: `(()=>{
        const strip=document.querySelector('.session-tabs'), tab=document.querySelector('.session-tab-unit:first-child .session-tab-shell:first-child .session-tab')
        return {
          focused: document.activeElement===tab,
          scrollLeft: strip?.scrollLeft ?? 999,
          selected: document.querySelector('.session-tab[aria-selected="true"]')?.dataset.sessionTab ?? null,
        }
      })()`,
      condition: `state.focused && state.scrollLeft <= 1 && state.selected === ${JSON.stringify(added.at(-1))}`,
      timeoutMs: 2_000,
    })
    if (!keyboard.ok) throw new Error(`键盘浏览没有显示完整标签，或提前切换了会话：${JSON.stringify(keyboard)}`)
    await win.webContents.executeJavaScript(
      `document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}))`,
    )
    const end = await pollRenderer<Record<string, unknown>>(win, {
      probe: `(()=>{
        const strip=document.querySelector('.session-tabs'), tab=document.activeElement?.getBoundingClientRect(), r=strip?.getBoundingClientRect()
        const rightDisabled = document.querySelector('.session-tab-scroll--right')?.disabled === true
        return {
          ok: Boolean(tab && r) && tab.left>=r.left && tab.right<=r.right+1 && rightDisabled,
          rightDisabled, tab: tab?.toJSON() ?? null, strip: r?.toJSON() ?? null,
        }
      })()`,
      condition: 'state.ok === true',
      timeoutMs: 2_000,
    })
    if (!end.ok) throw new Error(`末尾标签未完整显示或右侧边界状态错误：${JSON.stringify(end)}`)
    await capture('verify-tab-overflow-end.png')
    await emulateVerificationMedia(win, [
      { name: 'forced-colors', value: 'active' },
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ])
    await waitForMediaFeature(win, '(forced-colors: active)')
    const maskCleared = await pollRenderer<string>(win, {
      probe: `getComputedStyle(document.querySelector('.session-tabs')).maskImage`,
      condition: `state === 'none'`,
      timeoutMs: 1_500,
    })
    if (!maskCleared.ok) throw new Error(`高对比度模式不应淡出标签文字：${JSON.stringify(maskCleared)}`)
    await capture('verify-tab-overflow-accessible.png')
    console.log('desktop-shell-verify-local: tab-overflow-input', {
      wheel: wheel.ok,
      ...variants,
      keyboard: true,
      end: true,
      accessible: true,
    })
    /* oxlint-enable no-await-in-loop */
  } finally {
    await emulateVerificationMedia(win)
    await win.webContents.executeJavaScript(`(()=>{
      for(const id of ${JSON.stringify(added)}.reverse()) document.querySelector('.session-tab[data-session-tab='+JSON.stringify(id)+']')?.parentElement.querySelector('.session-tab-close').click()
    })()`)
    await pollRenderer<boolean>(win, {
      probe: `${JSON.stringify(added)}.every(id => !document.querySelector('.session-tab[data-session-tab=' + JSON.stringify(id) + ']'))`,
      condition: 'state === true',
      timeoutMs: 2_500,
    })
    await win.webContents.executeJavaScript(
      `document.querySelector('.session-tab[data-session-tab='+JSON.stringify(${JSON.stringify(original)})+']')?.click()`,
    )
    win.setBounds(bounds)
    await waitForViewportSettled(win)
  }
}
