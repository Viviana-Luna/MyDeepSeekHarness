/** 交互细节真实窗口验收：覆盖标签边缘挤压动画以及消息操作悬浮、键盘焦点与触屏降级。 */
import type { BrowserWindow } from 'electron'
import type { DesktopSessionFrame } from '../../shared/session-live.ts'
import { clickTrustedElement, emulateVerificationMedia } from './desktop-verifier.ts'

const settle = (win: BrowserWindow) =>
  win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 200))')

/** 在离屏或高负载 Chromium 中轮询等待 CSS 过渡收束，避免固定延时导致的伪失败。 */
async function waitForCondition<T>(
  win: BrowserWindow,
  expression: string,
  predicate: (value: T) => boolean,
): Promise<T> {
  let latest = (await win.webContents.executeJavaScript(expression)) as T
  /* oxlint-disable no-await-in-loop -- 串行轮询当前窗口的渲染计算样式。 */
  for (let attempt = 0; attempt < 60 && !predicate(latest); attempt += 1) {
    await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 25))')
    latest = (await win.webContents.executeJavaScript(expression)) as T
  }
  /* oxlint-enable no-await-in-loop */
  return latest
}

/** 逐帧检查边缘挤压和中途反向，避免仅检查最终位置掩盖被裁切的动画。 */
export async function verifyTabEdgeMotion(win: BrowserWindow): Promise<void> {
  // 标签按单元分组（分屏的两个标签同属一个单元）；每个外壳都是所在单元的首尾子元素，必须按单元定位。
  const first = '.session-tab-unit:first-child .session-tab-shell:first-child .session-tab'
  const last = '.session-tab-unit:last-child .session-tab-shell:last-child .session-tab'
  // 从明确的另一端开始，避免前一项验收或恢复的标签顺序使首次点击仍是当前标签。
  await clickTrustedElement(win, last)
  await win.webContents.executeJavaScript('new Promise(resolve=>setTimeout(resolve,1000))')
  /* oxlint-disable no-await-in-loop -- 同一透镜必须按顺序切换并采样。 */
  for (const selector of [first, last]) {
    await clickTrustedElement(win, selector)
    const result = (await win.webContents.executeJavaScript(`(async () => {
      const lens = document.querySelector('.session-tab-lens')
      const root = document.querySelector('.session-tab-glass')
      let contained = true, compressed = false, maximumHeight = 0
      for (let frame = 0; frame < 90; frame++) {
        await new Promise(resolve => requestAnimationFrame(resolve))
        const a = lens.getBoundingClientRect(), b = root.getBoundingClientRect()
        const active = document.querySelector('.session-tab-shell[data-selected]').getBoundingClientRect()
        contained &&= a.left >= b.left - .6 && a.right <= b.right + .6
        compressed ||= Math.min(Math.abs(a.left-b.left), Math.abs(a.right-b.right)) < .6 && a.width < active.width * .995
        maximumHeight = Math.max(maximumHeight, a.height)
      }
      const a = lens.getBoundingClientRect(), b = document.querySelector('.session-tab-shell[data-selected]').getBoundingClientRect()
      return { contained, compressed, maximumHeight, restored: Math.abs(a.left-b.left) < 1 && Math.abs(a.width-b.width) < 1 && Math.abs(a.height-26) < .1 }
    })()`)) as { contained: boolean; compressed: boolean; restored: boolean; maximumHeight: number }
    console.log('desktop-shell-verify-local: tab-edge-motion', result)
    if (!result.contained || !result.compressed || !result.restored || result.maximumHeight > 29.2)
      throw new Error('标签边缘挤压或圆弧完整性验收失败：' + JSON.stringify(result))
  }
  await clickTrustedElement(win, first)
  await clickTrustedElement(win, last)
  await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 1000))')
  const restored = await win.webContents.executeJavaScript(`(() => {
    const a=document.querySelector('.session-tab-lens').getBoundingClientRect(), b=document.querySelector('.session-tab-shell[data-selected]').getBoundingClientRect()
    return Math.abs(a.left-b.left)<1 && Math.abs(a.width-b.width)<1
  })()`)
  if (!restored) throw new Error('连续切换后的透镜未恢复')
  /* oxlint-enable no-await-in-loop */
}

/** 在真实 Chromium 中检查悬浮样式、键盘焦点与触屏降级，不改动用户会话。 */
export async function verifyMessageActionReveal(
  win: BrowserWindow,
  sessionId: string,
  emit: (frame: DesktopSessionFrame) => void,
  appearance: (scheme: 'light' | 'dark') => void,
  capture: (name: string) => Promise<void>,
): Promise<void> {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    {
      type: 'user/message',
      data: {
        source: { kind: 'user' },
        content: [{ type: 'text', text: '检查消息气泡下方的操作。' }],
      },
    },
    {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          content: [{ type: 'text', text: '时间和复制按钮在悬浮时显示，键盘聚焦也可以操作。' }],
        },
      },
    },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ].map((event, seq) => ({ ...event, seq, time: 1_700_000_000_000 + seq * 100 }))
  emit({ type: 'session/snapshot', sessionId, events, lastSeq: events.length - 1, hasMore: false })
  await settle(win)
  await emulateVerificationMedia(win)
  const debug = win.webContents.debugger
  await debug.sendCommand('DOM.enable')
  await debug.sendCommand('CSS.enable')
  try {
    /* oxlint-disable no-await-in-loop -- 逐个窗口尺寸与伪类状态检查实际布局。 */
    for (const width of [1280, 1800])
      for (const scheme of ['dark', 'light'] as const) {
        win.setSize(width, width === 1280 ? 800 : 1000)
        appearance(scheme)
        win.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 })
        await win.webContents.executeJavaScript('document.activeElement?.blur()')
        const initial = await waitForCondition<{
          count: number
          hidden: boolean
          heights: number[]
        }>(
          win,
          `(() => {
            const rows=[...document.querySelectorAll('.main-island [aria-label="消息操作"]')]
            return {
              count: rows.length,
              hidden: rows.every(row=>getComputedStyle(row).opacity==='0' && getComputedStyle(row).pointerEvents==='none'),
              heights: rows.map(row=>row.parentElement.getBoundingClientRect().height),
            }
          })()`,
          state => state.count === 2 && state.hidden,
        )
        // 会话信息已不再作为右栏入口（见 docs/renderer.md），这里只检查消息操作本身。
        if (initial.count !== 2 || !initial.hidden)
          throw new Error('消息操作排版验收失败：' + JSON.stringify(initial))
        if (width === 1280 && scheme === 'dark') await capture('verify-message-actions-idle.png')
        const { root } = (await debug.sendCommand('DOM.getDocument')) as {
          root: { nodeId: number }
        }
        const { nodeIds } = (await debug.sendCommand('DOM.querySelectorAll', {
          nodeId: root.nodeId,
          selector: '.main-island li:has(> [aria-label="消息操作"])',
        })) as { nodeIds: number[] }
        for (const nodeId of nodeIds)
          await debug.sendCommand('CSS.forcePseudoState', {
            nodeId,
            forcedPseudoClasses: ['hover'],
          })
        // 消息操作行存在 120ms 透明度过渡；离屏窗口按轮询等待过渡完成并复核行高不跳动。
        const hovered = await waitForCondition<{
          ok: boolean
          rows: Array<{ opacity: string; pointerEvents: string; height: number; expected: number }>
        }>(
          win,
          `(() => {
            const expected=${JSON.stringify(initial.heights)}
            const rows=[...document.querySelectorAll('.main-island [aria-label="消息操作"]')].map((row,index)=>({
              opacity: getComputedStyle(row).opacity,
              pointerEvents: getComputedStyle(row).pointerEvents,
              height: row.parentElement.getBoundingClientRect().height,
              expected: expected[index],
            }))
            return {
              ok: rows.length === expected.length && rows.every(item=>item.opacity==='1' && item.pointerEvents==='auto' && Math.abs(item.height-item.expected)<0.5),
              rows,
            }
          })()`,
          state => state.ok,
        )
        if (!hovered.ok)
          throw new Error('悬浮显示消息操作时发生布局跳动或按钮不可用：' + JSON.stringify(hovered))
        await capture(`verify-message-actions-${width}-${scheme}.png`)
        for (const nodeId of nodeIds)
          await debug.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] })
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
        await win.webContents.executeJavaScript(
          `document.querySelector('.main-island [aria-label="消息操作"] button').focus()`,
        )
        const focused = await waitForCondition<boolean>(
          win,
          `getComputedStyle(document.activeElement.parentElement).opacity==='1' && document.activeElement.matches(':focus-visible')`,
          Boolean,
        )
        if (!focused) throw new Error('键盘聚焦没有显示消息操作')
        await win.webContents.executeJavaScript('document.activeElement.blur()')
      }
    /* oxlint-enable no-await-in-loop */
    await debug.sendCommand('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 1,
    })
    const touchReady = await waitForCondition<boolean>(
      win,
      `!matchMedia('(hover: hover) and (pointer: fine)').matches && [...document.querySelectorAll('.main-island [aria-label="消息操作"]')].every(row=>getComputedStyle(row).opacity==='1')`,
      Boolean,
    )
    if (!touchReady) throw new Error('触屏模式无法访问消息操作')
    console.log('desktop-shell-verify-local: message-action-reveal', {
      hover: true,
      keyboard: true,
      stableLayout: true,
      touch: true,
    })
  } finally {
    await debug.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: false })
    await debug.sendCommand('CSS.disable')
    await debug.sendCommand('DOM.disable')
    await emulateVerificationMedia(win)
    emit({ type: 'session/snapshot', sessionId, events: [], lastSeq: 0, hasMore: false })
  }
}
