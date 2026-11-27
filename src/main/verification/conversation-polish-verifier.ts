/** 主进程使用隔离会话事件验收对话生成状态；结束时恢复窗口、媒体仿真与会话状态。 */
import type { BrowserWindow } from 'electron'
import type { DesktopSessionFrame } from '../../shared/session-live.ts'
import { emulateVerificationMedia } from './desktop-verifier.ts'
import {
  verifyFluidText,
  verifySummaryReveal,
  verifyToolOutputReveal,
} from './conversation-fluid-verifier.ts'

interface ConversationPolishOptions {
  sessionId: string
  emit: (frame: DesktopSessionFrame) => void
  setRunning: (running: boolean) => void
  appearance: (scheme: 'light' | 'dark') => void
  restoreAppearance: () => void
  capture: (name: string) => Promise<void>
}

const settle = (win: BrowserWindow) =>
  win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 220))')

function eventsFor(chunk: { type: string; index: number; text: string }) {
  return [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '检查生成状态' }] },
    },
    { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk } },
  ].map((event, seq) => ({
    type: event.type,
    data: event.data,
    seq,
    time: 1_700_000_000_000 + seq * 100,
  }))
}

async function verifyStreamingAppearance(win: BrowserWindow, options: ConversationPolishOptions) {
  /* oxlint-disable no-await-in-loop -- 同一窗口的尺寸和主题需要顺序变更与采样。 */
  for (const width of [1280, 1800]) {
    for (const scheme of ['dark', 'light'] as const) {
      win.setSize(width, width === 1280 ? 800 : 1000)
      options.appearance(scheme)
      await settle(win)
      const ready = await win.webContents.executeJavaScript(`(() => {
          const text = document.querySelector('[data-streaming-cursor="true"] > :last-child')
          const stop = document.querySelector('.stop-button')
          const input = document.querySelector('.composer-card textarea')
          const card = document.querySelector('.composer-card')
          if (!(text instanceof HTMLElement) || !(stop instanceof HTMLElement)
            || !(input instanceof HTMLTextAreaElement) || !(card instanceof HTMLElement)) return false
          input.focus()
          const controls = [...card.querySelectorAll('.composer-tools button, button[title^="模型："]'), stop]
          const recessed = controls.length >= 5 && controls.every(button =>
            getComputedStyle(button).boxShadow.split('inset').length === 3)
          return getComputedStyle(text, '::after').content !== 'none'
            && getComputedStyle(text, '::after').animationName !== 'none'
            && getComputedStyle(stop, '::before').content === 'none' && recessed
            && card.matches(':focus-within') && card.getBoundingClientRect().right <= innerWidth
        })()`)
      if (!ready) throw new Error(`对话流式状态验收失败：${String(width)} ${scheme}`)
      await options.capture(`verify-conversation-stream-${String(width)}-${scheme}.png`)
    }
  }
  /* oxlint-enable no-await-in-loop */
  await emulateVerificationMedia(win, [{ name: 'prefers-reduced-motion', value: 'reduce' }])
  const reduced = await win.webContents.executeJavaScript(`(() => {
      const text = document.querySelector('[data-streaming-cursor="true"] > :last-child')
      const stop = document.querySelector('.stop-button')
      return text && stop && getComputedStyle(text, '::after').animationName === 'none'
        && getComputedStyle(stop, '::before').content === 'none'
    })()`)
  if (!reduced) throw new Error('对话流式状态没有关闭减少动态模式下的动画')
  await emulateVerificationMedia(win)
}

async function verifyActivityMotion(win: BrowserWindow) {
  const moving = await win.webContents.executeJavaScript(`(async () => {
    const row = document.querySelector('[data-thinking-disclosure][data-active="true"]');
    const dots = [...(row?.querySelectorAll('[data-variant="star"] i') ?? [])];
    const summary = row?.querySelector('[data-thinking-preview]');
    const sweep = summary?.getAnimations().find(animation => animation.animationName?.includes('thinking-sweep'));
    if (!sweep || summary.childElementCount !== 0 || summary.textContent.length <= 120) return false;
    sweep.currentTime = 0;
    const sample = () => ({
      dots: dots.map(dot => getComputedStyle(dot).opacity),
      position: parseFloat(getComputedStyle(summary).backgroundPositionX),
    });
    const first = sample(); await new Promise(resolve => setTimeout(resolve, 180)); const second = sample();
    return dots.length === 9 && first.dots.some((value, index) => value !== second.dots[index])
      && first.position === 100 && second.position < first.position;
  })()`)
  if (!moving) throw new Error('思考摘要或点阵的运行指示没有产生实际视觉变化')

  try {
    await emulateVerificationMedia(win, [{ name: 'prefers-reduced-motion', value: 'reduce' }])
    const reduced = await win.webContents.executeJavaScript(`(() => {
      const summary = document.querySelector('[data-thinking-disclosure][data-active="true"] [data-thinking-preview]');
      if (!summary) return false;
      const style = getComputedStyle(summary);
      return style.animationName === 'none' && style.backgroundImage === 'none' && style.color !== 'rgba(0, 0, 0, 0)';
    })()`)
    if (!reduced) throw new Error('减少动态模式下思考摘要未恢复为静态文字')
  } finally {
    await emulateVerificationMedia(win)
  }
}

async function verifyToolEntrance(win: BrowserWindow) {
  const result = await win.webContents.executeJavaScript(`(async () => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const row = document.querySelector('[data-tool-disclosure][data-state="running"]')?.parentElement;
      const animation = row?.getAnimations().find(item => item.animationName?.includes('conversation-enter'));
      if (row && animation) {
        const first = Number(animation.currentTime);
        const before = getComputedStyle(row).transform;
        await new Promise(resolve => setTimeout(resolve, 40));
        return Number(animation.currentTime) > first && getComputedStyle(row).transform !== before;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return false;
  })()`)
  if (!result) throw new Error('工具调用出现时没有实际入场动画')
  await emulateVerificationMedia(win, [{ name: 'prefers-reduced-motion', value: 'reduce' }])
  const reduced = await win.webContents.executeJavaScript(`(() => {
    const row = document.querySelector('[data-tool-disclosure][data-state="running"]')?.parentElement;
    return row && getComputedStyle(row).animationName === 'none';
  })()`)
  await emulateVerificationMedia(win)
  if (!reduced) throw new Error('减少动态模式没有关闭工具入场动画')
}

async function verifyThinking(win: BrowserWindow, options: ConversationPolishOptions) {
  publishChunk(options, {
    type: 'reasoning-delta',
    index: 0,
    text: '正在检查调用边界。'.repeat(20),
  })
  await settle(win)
  const thinking = await win.webContents.executeJavaScript(`(() => {
      const row = document.querySelector('[data-thinking-disclosure][data-active="true"]')
      return row?.querySelectorAll('[data-variant="star"] i').length === 9
        && !document.querySelector('[data-streaming-cursor="true"]')
    })()`)
  if (!thinking) throw new Error('思考状态未显示运行指示或错误显示正文光标')
  await verifyActivityMotion(win)
  await options.capture('verify-thinking-sweep.png')
}

async function verifyRunningSteps(win: BrowserWindow, options: ConversationPolishOptions) {
  await verifyThinking(win, options)
  const toolEvents = [
    ...eventsFor({ type: 'reasoning-delta', index: 0, text: '正在检查调用边界。' }).slice(0, 3),
    {
      type: 'tool/call',
      seq: 3,
      time: 1_700_000_000_300,
      data: {
        turn: 1,
        step: 1,
        callId: '验收工具',
        name: 'apply_patch',
        arguments: JSON.stringify({
          patch:
            '*** Begin Patch\n*** Update File: README.md\n@@\n-原有说明\n+更新说明\n*** End Patch',
        }),
      },
    },
  ]
  options.emit({
    type: 'session/snapshot',
    sessionId: options.sessionId,
    events: toolEvents,
    lastSeq: toolEvents.length - 1,
    hasMore: false,
  })
  await verifyToolEntrance(win)
  await verifySummaryReveal(win)
  await settle(win)
  const tool = await win.webContents.executeJavaScript(
    `document.querySelectorAll('[data-tool-disclosure][data-state="running"] [data-variant="wave"] i').length === 9`,
  )
  if (!tool) throw new Error('工具运行时未显示脉冲指示')
  const patchReady = await win.webContents.executeJavaScript(`(() => {
    const row = document.querySelector('[data-tool-disclosure][data-state="running"]')
    row?.querySelector('summary')?.click()
    const preview = row?.querySelector('[aria-label="请求的文件补丁预览"]')
    const input = row?.querySelector('dl')
    const rowBounds = row?.getBoundingClientRect(), inputBounds = input?.getBoundingClientRect()
    return !!preview && preview.checkVisibility()
      && preview.textContent.includes('-原有说明') && preview.textContent.includes('+更新说明')
      && row.querySelector('summary')?.textContent.includes('README.md')
      && rowBounds && inputBounds && inputBounds.left > rowBounds.left && inputBounds.right < rowBounds.right
  })()`)
  if (!patchReady) throw new Error('文件补丁预览未展示实际请求内容')
  await options.capture('verify-conversation-patch.png')
  /* oxlint-disable no-await-in-loop -- 同一窗口依次检查补丁卡片在不同尺寸和主题下的边界。 */
  for (const width of [1280, 1800]) {
    for (const scheme of ['dark', 'light'] as const) {
      win.setSize(width, width === 1280 ? 800 : 1000)
      options.appearance(scheme)
      await settle(win)
      const contained = await win.webContents.executeJavaScript(`(() => {
        const row = document.querySelector('[data-tool-disclosure][data-state="running"]')
        const preview = row?.querySelector('[aria-label="请求的文件补丁预览"]')
        if (!row || !preview) return false
        const a = row.getBoundingClientRect(), b = preview.getBoundingClientRect()
        return b.left >= a.left && b.right <= a.right && a.left >= 0 && a.right <= innerWidth
      })()`)
      if (!contained) throw new Error(`文件补丁预览越界：${String(width)} ${scheme}`)
      await options.capture(`verify-conversation-patch-${String(width)}-${scheme}.png`)
    }
  }
  /* oxlint-enable no-await-in-loop */
  await verifyToolOutputReveal(win, options)
  console.log('desktop-shell-verify-local: conversation-polish', {
    streaming: true,
    thinking: true,
    tool: true,
    patchPreview: true,
    reducedMotion: true,
  })
}

function publishChunk(
  options: ConversationPolishOptions,
  chunk: { type: string; index: number; text: string },
) {
  const events = eventsFor(chunk)
  options.emit({
    type: 'session/snapshot',
    sessionId: options.sessionId,
    events,
    lastSeq: events.length - 1,
    hasMore: false,
  })
}

async function verifyPreStepWaiting(win: BrowserWindow, options: ConversationPolishOptions) {
  const sample = eventsFor({ type: 'text-delta', index: 0, text: '开始' })
  const events = [sample[0]!, { ...sample[2]!, seq: 1 }]
  options.emit({
    type: 'session/snapshot',
    sessionId: options.sessionId,
    events,
    lastSeq: 1,
    hasMore: false,
  })
  await settle(win)
  const waiting = await win.webContents.executeJavaScript(`(() => {
    const row = document.querySelector('[data-message-status="waiting"]');
    return !!row && row.textContent.includes('正在构思回复')
      && row.querySelectorAll('[data-variant="wave"] i').length === 9;
  })()`)
  if (!waiting) throw new Error('首个步骤开始前没有显示九点等待状态')
}

async function verifyPagedReplyStatus(win: BrowserWindow, options: ConversationPolishOptions) {
  // 尾页从用户消息开始，不提供 turn/start 和 step/start，模拟长会话重连后的历史窗口。
  const events = eventsFor({
    type: 'reasoning-delta',
    index: 0,
    text: '核对尾页中的运行状态',
  }).slice(2)
  options.emit({
    type: 'session/snapshot',
    sessionId: options.sessionId,
    events,
    lastSeq: 3,
    hasMore: true,
  })
  /* oxlint-disable no-await-in-loop -- 同一会话依次核对尺寸和主题，不创建额外窗口。 */
  for (const width of [1280, 1800]) {
    for (const scheme of ['dark', 'light'] as const) {
      win.setSize(width, width === 1280 ? 800 : 1000)
      options.appearance(scheme)
      await settle(win)
      const active = await win.webContents.executeJavaScript(`(() => {
        const row = document.querySelector('[data-message-status="streaming"]');
        const thinking = row?.querySelector('[data-thinking-disclosure][data-active="true"]');
        const stop = document.querySelector('.stop-button');
        return !!thinking && !!stop && stop.checkVisibility()
          && !document.querySelector('#conversation-view').textContent.includes('回复已停止')
          && thinking.getBoundingClientRect().right <= innerWidth;
      })()`)
      if (!active) throw new Error(`尾页回复被误判为停止：${String(width)} ${scheme}`)
      await options.capture(`verify-paged-reply-${String(width)}-${scheme}.png`)
    }
  }
  /* oxlint-enable no-await-in-loop */
  options.setRunning(false)
  await settle(win)
  const stopped = await win.webContents.executeJavaScript(`(() => {
    return document.querySelector('[data-message-status="interrupted"]')?.textContent.includes('回复已停止')
      && !document.querySelector('.stop-button');
  })()`)
  if (!stopped) throw new Error('权威运行状态停止后未保留回复中断提示')
  options.setRunning(true)
  options.emit({
    type: 'session/event',
    sessionId: options.sessionId,
    event: {
      type: 'turn/end',
      seq: 4,
      time: 1_700_000_000_400,
      data: { turn: 1, reason: { kind: 'aborted' } },
    },
  })
  await settle(win)
  const closed = await win.webContents.executeJavaScript(
    `!!document.querySelector('[data-message-status="interrupted"]') && !document.querySelector('[data-message-status="streaming"]')`,
  )
  if (!closed) throw new Error('运行状态迟到时重新打开了已经结束的回复')
  console.log('desktop-shell-verify-local: paged-reply-status', {
    streaming: true,
    stopped: true,
    closedTurn: true,
  })
}

async function verifyMarkdownTable(win: BrowserWindow) {
  const layout = await win.webContents.executeJavaScript(`(() => {
    const code = document.querySelector('[data-code-block]')
    const message = code?.parentElement
    const [table, wide] = message?.querySelectorAll('table') ?? []
    const quote = message?.querySelector('blockquote')
    if (!table || !wide || !quote) return null
    const shortCells = [...table.querySelectorAll('tr > :nth-child(-n+2)')]
    const shortCellDetails = shortCells.map(cell => {
      const range = document.createRange()
      range.selectNodeContents(cell)
      return {
        text: cell.textContent,
        rects: range.getClientRects().length,
        width: Math.round(cell.getBoundingClientRect().width * 10) / 10,
      }
    })
    const shortLabelsFit = shortCellDetails.length === 6 && shortCellDetails.every(item => item.rects === 1)
    const viewport = wide.parentElement
    viewport.scrollLeft = viewport.scrollWidth
    const scrolls = viewport.scrollLeft > 0 && viewport.scrollWidth > viewport.clientWidth
    viewport.scrollLeft = 0
    const localSurface = [table.parentElement, quote, code].every(block => {
      const style = getComputedStyle(block)
      return style.backgroundColor === 'rgba(0, 0, 0, 0)' && style.boxShadow.split('inset').length === 3
    })
    const userBubble = document.querySelector('#conversation-view [data-conversation-seq="2"] > div')
    const userShadow = userBubble && getComputedStyle(userBubble).boxShadow
    const userRaised = Boolean(userShadow && userShadow !== 'none' && !userShadow.includes('inset'))
    const send = document.querySelector('.send-button')
    const sendRecessed = Boolean(send && getComputedStyle(send).boxShadow.split('inset').length === 3)
    const quoteStyle = getComputedStyle(quote)
    const quoteBorder = quoteStyle.borderWidth === '1px' && quoteStyle.borderColor === quoteStyle.borderTopColor
    return { shortLabelsFit, scrolls, localSurface, userRaised, sendRecessed, quoteBorder,
      fitsWindow: document.documentElement.scrollWidth === innerWidth,
      ...(shortLabelsFit ? {} : { shortCellDetails }) }
  })()`)
  if (
    !layout ||
    Object.entries(layout).some(([key, value]) => key !== 'shortCellDetails' && value !== true)
  )
    throw new Error(`对话表格列宽、滚动或内容块层次异常：${JSON.stringify(layout)}`)
}

async function verifyMarkdownContrast(win: BrowserWindow) {
  await emulateVerificationMedia(win, [{ name: 'forced-colors', value: 'active' }])
  const ready = await win.webContents.executeJavaScript(`(() => {
    const code = document.querySelector('[data-code-block]')
    const table = code?.parentElement.querySelector('table')
    const quote = code?.parentElement.querySelector('blockquote')
    const send = document.querySelector('.send-button')
    return matchMedia('(forced-colors: active)').matches && [table?.parentElement, quote, code, send].every(block => {
      if (!block) return false
      const style = getComputedStyle(block)
      return style.borderTopWidth === '1px' && style.borderTopStyle === 'solid' && style.boxShadow === 'none'
    })
  })()`)
  if (!ready) throw new Error('强制色彩模式下对话内容块没有以描边区分')
}

function wideRow(value: string): string {
  return `| ${Array.from({ length: 24 }, () => value).join(' | ')} |`
}

async function verifyMarkdownBlocks(win: BrowserWindow, options: ConversationPolishOptions) {
  const text = [
    '# 对话排版示例',
    '',
    '正文用于比较字号。',
    '',
    '| 格子 | 状态 | 说明 |',
    '| --- | --- | --- |',
    '| 右上 | 已确认 | 简短说明与较长的描述放在同一张表里，观察窄栏中每一列如何分配宽度。 |',
    '| 左下 | 待核对 | 这是一段比较长的说明，用来检查连续的中文仍能在宽度有限时正常换行。 |',
    '',
    '> 引用块的内容与正文使用相同的背景。',
    '',
    '```sh',
    'echo ' + '长代码'.repeat(100),
    '```',
    '',
    wideRow('列名'),
    wideRow('---'),
    wideRow('样本'),
  ].join('\n')
  const sample = eventsFor({ type: 'text-delta', index: 0, text })
  const events = [
    ...sample.slice(0, 3),
    {
      type: 'assistant/message',
      seq: 3,
      time: 1_700_000_000_300,
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text }] } },
    },
  ]
  options.emit({
    type: 'session/snapshot',
    sessionId: options.sessionId,
    events,
    lastSeq: 3,
    hasMore: false,
  })
  options.setRunning(false)
  /* oxlint-disable no-await-in-loop -- 同一窗口依次切换主题和尺寸。 */
  for (const [width, height, scheme] of [
    [920, 800, 'dark'],
    [1280, 800, 'light'],
    [1800, 1000, 'dark'],
  ] as const) {
    win.setSize(width, height)
    options.appearance(scheme)
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-code-block] [aria-pressed="true"]')?.click()`,
    )
    await settle(win)
    const ready = await win.webContents.executeJavaScript(`(() => {
      const block = document.querySelector('[data-code-block]')
      const heading = block?.parentElement?.querySelector('h1')
      const paragraph = block?.parentElement?.querySelector('p')
      const pre = block?.querySelector('pre')
      const wrap = block?.querySelector('[aria-label="自动换行"]')
      const copy = block?.querySelector('[aria-label="复制代码"]')
      if (!pre || !wrap || !copy || !heading || !paragraph || !copy.checkVisibility()) return false
      const compact = parseFloat(getComputedStyle(heading).fontSize) - parseFloat(getComputedStyle(paragraph).fontSize) <= 3
      return compact && pre.scrollWidth > pre.clientWidth && block.getBoundingClientRect().right <= innerWidth
    })()`)
    if (!ready) throw new Error('回复标题或代码块工具栏布局异常')
    await verifyMarkdownTable(win)
    await options.capture(`verify-markdown-${String(width)}-${scheme}.png`)
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-code-block] [aria-label="自动换行"]').click()`,
    )
    const wrapped = await win.webContents.executeJavaScript(`(() => {
      const block = document.querySelector('[data-code-block]')
      const pre = block.querySelector('pre')
      return block.dataset.wrap === 'true' && pre.scrollWidth <= pre.clientWidth + 1
    })()`)
    if (!wrapped) throw new Error('代码块换行后仍然横向溢出')
  }
  /* oxlint-enable no-await-in-loop */
}

/** 检查流式正文、思考状态、输入区反馈及减少动态；样本不写入真实会话。 */
export async function verifyConversationPolish(
  win: BrowserWindow,
  options: ConversationPolishOptions,
): Promise<void> {
  const bounds = win.getBounds()
  options.setRunning(true)
  try {
    await verifyPagedReplyStatus(win, options)
    await verifyPreStepWaiting(win, options)
    await verifyFluidText(win, options)
    publishChunk(options, { type: 'text-delta', index: 0, text: '正在逐步生成的正文。' })
    await verifyStreamingAppearance(win, options)
    await verifyRunningSteps(win, options)
    await verifyMarkdownBlocks(win, options)
    await verifyMarkdownContrast(win)
  } finally {
    await emulateVerificationMedia(win)
    options.setRunning(false)
    options.restoreAppearance()
    options.emit({
      type: 'session/snapshot',
      sessionId: options.sessionId,
      events: [],
      lastSeq: 0,
      hasMore: false,
    })
    win.setBounds(bounds)
  }
}
