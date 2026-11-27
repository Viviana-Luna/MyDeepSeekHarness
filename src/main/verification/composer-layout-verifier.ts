import type { BrowserWindow } from 'electron'
import { emulateVerificationMedia } from './desktop-verifier.ts'
import { pollRenderer, waitForMediaFeature, waitForViewportSettled } from './verification-wait.ts'

/** 用实际图片粘贴链路检查多图密度、输入空间和删除操作，不写入用户会话。 */
export async function verifyComposerLayout(
  win: BrowserWindow,
  appearance: (scheme: 'light' | 'dark') => void,
  capture: (name: string) => Promise<void>,
): Promise<void> {
  const originalBounds = win.getBounds()
  await win.webContents.executeJavaScript(`(async () => {
    const canvas=document.createElement('canvas'); canvas.width=128; canvas.height=128
    const ctx=canvas.getContext('2d'); ctx.fillStyle='#202229'; ctx.fillRect(0,0,128,128)
    ctx.fillStyle='#4d6bfe'; ctx.fillRect(10,12,108,20); ctx.fillStyle='#a8adbd'
    for (let row=0;row<5;row++) ctx.fillRect(10,45+row*13,90-row*8,4)
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'))
    const clipboard=new DataTransfer()
    for (let i=0;i<8;i++) clipboard.items.add(new File([blob], '缩略图验收-'+i+'.png',{type:'image/png'}))
    document.querySelector('#composer').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:clipboard}))
    for(let i=0;i<100;i++) { if(document.querySelectorAll('.composer-attachments img').length===8) return; await new Promise(resolve=>setTimeout(resolve,50)) }
    throw new Error('粘贴多张图片未完成')
  })()`)
  try {
    /* oxlint-disable no-await-in-loop -- 同一窗口按尺寸和主题依次验收。 */
    for (const width of [1280, 1800])
      for (const scheme of ['dark', 'light'] as const) {
        win.setSize(width, width === 1280 ? 800 : 1000)
        appearance(scheme)
        win.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 })
        await waitForViewportSettled(win, { scheme })
        const polled = await pollRenderer<Record<string, boolean>>(win, {
          probe: `(() => {
            const card=document.querySelector('.main-island .composer-card'), list=card?.querySelector('.composer-attachments')
            const input=card?.querySelector('textarea'), footer=card?.querySelector('footer'), items=[...(list?.children ?? [])]
            if (!card || !list || !input || !footer || items.length === 0) return { mounted: false }
            const a=list.getBoundingClientRect(), b=input.getBoundingClientRect(), c=footer.getBoundingClientRect()
            const icon=card.querySelector('.composer-picker-button'), tools=card.querySelector('.composer-tools')
            return { count:items.length===8, compact:items.every(item=>{const r=item.getBoundingClientRect();return r.width===64&&r.height===64&&Math.abs(r.top-items[0].getBoundingClientRect().top)<1}),
              aboveInput:a.bottom<=b.top+1, inputFits:b.height>=36&&b.bottom<=c.top+1,
              bounded:card.getBoundingClientRect().height<=176&&card.scrollHeight<=card.clientHeight+1&&list.scrollHeight<=list.clientHeight+1,
              noLabels:items.every(item=>!item.querySelector('span,small')&&item.title.includes('KB')),
              outlined:items.every(item=>getComputedStyle(item.querySelector('img')).outlineWidth==='1px'),
              tools:tools.lastElementChild===icon&&!!icon.querySelector('.lucide-terminal')&&!card.querySelector('[aria-label="选择 Skill"]'),
              footerFits:[...footer.querySelectorAll('button')].filter(button=>button.checkVisibility()).every(button=>{const r=button.getBoundingClientRect();return r.left>=c.left-1&&r.right<=c.right+1}),
              removeHidden:items.every(item=>getComputedStyle(item.querySelector('button')).opacity==='0'),
              rowScrollable:list.scrollWidth<=list.clientWidth||getComputedStyle(list).overflowX==='auto' }
          })()`,
          condition: 'Object.values(state).every(value => value === true)',
        })
        const result = polled.value
        console.log('desktop-shell-verify-local: composer-compact', { width, scheme, ...result })
        await capture(`verify-composer-compact-${width}-${scheme}.png`)
        if (!polled.ok) {
          const geometry = await win.webContents.executeJavaScript(
            `['.composer-card','.composer-attachments','#composer','.composer-card footer'].map(selector=>{const element=document.querySelector(selector);return {selector,bounds:element.getBoundingClientRect().toJSON(),scrollHeight:element.scrollHeight,clientHeight:element.clientHeight}})`,
          )
          throw new Error(
            '输入区工具与紧凑图片布局验收失败：' + JSON.stringify({ result, geometry }),
          )
        }
      }
    /* oxlint-enable no-await-in-loop */
    const point = (await win.webContents.executeJavaScript(
      `(() => { const r=document.querySelector('.composer-attachments li').getBoundingClientRect(); return {x:Math.round(r.left+32),y:Math.round(r.top+32)} })()`,
    )) as { x: number; y: number }
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point })
    const hovered = await pollRenderer<string>(win, {
      probe: `getComputedStyle(document.querySelector('.composer-attachments button')).opacity`,
      condition: `state === '1'`,
      timeoutMs: 2_000,
    })
    if (!hovered.ok) throw new Error(`鼠标悬浮时图片删除操作不可见：${JSON.stringify(hovered)}`)
    await win.webContents.executeJavaScript(
      `document.querySelector('.composer-attachments button').focus()`,
    )
    const keyboard = await pollRenderer<{ matched: boolean; opacity: string }>(win, {
      probe: `(() => {
        const active = document.activeElement
        return {
          matched: active?.matches('.composer-attachments button') === true,
          opacity: active ? getComputedStyle(active).opacity : '',
        }
      })()`,
      condition: `state.matched && state.opacity === '1'`,
      timeoutMs: 2_000,
    })
    if (!keyboard.ok) throw new Error(`键盘聚焦时图片删除操作不可见：${JSON.stringify(keyboard)}`)
    // Enter 的原生按钮激活由字符事件触发，完整模拟按下、字符与抬起。
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    const removed = await pollRenderer<number>(win, {
      probe: `document.querySelectorAll('.composer-attachments li').length`,
      condition: 'state === 7',
      timeoutMs: 2_000,
    })
    if (!removed.ok) throw new Error(`键盘无法移除图片：${JSON.stringify(removed)}`)
    await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 1,
    })
    const touch = await pollRenderer<string[]>(win, {
      probe: `[...document.querySelectorAll('.composer-attachments button')].map(button=>getComputedStyle(button).opacity)`,
      condition: `state.length === 7 && state.every(value => value === '1')`,
      timeoutMs: 2_000,
    })
    if (!touch.ok) throw new Error(`触屏模式无法访问图片删除操作：${JSON.stringify(touch)}`)
    await emulateVerificationMedia(win, [
      { name: 'forced-colors', value: 'active' },
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ])
    await waitForMediaFeature(win, '(forced-colors: active)')
    const accessible = await pollRenderer<Record<string, unknown>>(win, {
      probe: `(() => {
        const forced = matchMedia('(forced-colors: active)').matches
        const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
        const buttons = [...document.querySelectorAll('.composer-attachments button')].map(button => ({
          transitionDuration: getComputedStyle(button).transitionDuration,
          opacity: getComputedStyle(button).opacity,
        }))
        return {
          ok: forced && reduced && buttons.length > 0 && buttons.every(item => item.transitionDuration === '0s' && item.opacity === '1'),
          forced, reduced, buttons,
        }
      })()`,
      condition: 'state.ok === true',
      timeoutMs: 2_000,
    })
    if (!accessible.ok) {
      throw new Error(`图片操作的强制色彩或减少动态降级未生效：${JSON.stringify(accessible)}`)
    }
    await capture('verify-composer-compact-accessible.png')
    console.log('desktop-shell-verify-local: composer-compact-actions', {
      keyboard: true,
      touch: true,
      accessible: true,
    })
  } finally {
    await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', {
      enabled: false,
    })
    await emulateVerificationMedia(win)
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('.composer-attachments button')].reverse().forEach(button=>button.click())`,
    )
    win.setBounds(originalBounds)
    await waitForViewportSettled(win)
  }
}
