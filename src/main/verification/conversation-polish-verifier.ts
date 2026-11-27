/** 主进程使用隔离会话事件验收对话生成状态；结束时恢复窗口、媒体仿真与会话状态。 */
import type { BrowserWindow } from 'electron'
import type { DesktopSessionFrame } from '../../shared/session-live.ts'
import { emulateVerificationMedia } from './desktop-verifier.ts'
import {
  verifyFluidText,
  verifySummaryReveal,
  verifyToolOutputReveal,
} from './conversation-fluid-verifier.ts'
import { verifyMarkdownBlocks, verifyMarkdownContrast } from './conversation-markdown-verifier.ts'
import { pollRenderer, waitForMediaFeature, waitForViewportSettled } from './verification-wait.ts'

interface ConversationPolishOptions {
  sessionId: string
  emit: (frame: DesktopSessionFrame) => void
  setRunning: (running: boolean) => void
  appearance: (scheme: 'light' | 'dark') => void
  restoreAppearance: () => void
  capture: (name: string) => Promise<void>
}

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
      await waitForViewportSettled(win, { scheme })
      const ready = await pollRenderer<Record<string, unknown>>(win, {
        probe: `(() => {
          const text = document.querySelector('[data-streaming-cursor="true"] > :last-child')
          const stop = document.querySelector('.stop-button')
          const input = document.querySelector('.composer-card textarea')
          const card = document.querySelector('.composer-card')
          if (!(text instanceof HTMLElement) || !(stop instanceof HTMLElement)
            || !(input instanceof HTMLTextAreaElement) || !(card instanceof HTMLElement)) {
            return { ready: false, missing: { text: Boolean(text), stop: Boolean(stop), input: Boolean(input), card: Boolean(card) } }
          }
          input.focus()
          const controls = [...card.querySelectorAll('.composer-tools button, button[title^="模型："]'), stop]
          const recessed = controls.length >= 5 && controls.every(button =>
            getComputedStyle(button).boxShadow.split('inset').length === 3)
          const cursorContent = getComputedStyle(text, '::after').content
          const cursorAnim = getComputedStyle(text, '::after').animationName
          const stopBefore = getComputedStyle(stop, '::before').content
          const focusWithin = card.matches(':focus-within')
          const cardRight = card.getBoundingClientRect().right
          return {
            ready: cursorContent !== 'none' && cursorAnim !== 'none' && stopBefore === 'none'
              && recessed && focusWithin && cardRight <= innerWidth,
            cursorContent, cursorAnim, stopBefore, recessed, controlCount: controls.length,
            focusWithin, cardRight, innerWidth,
          }
        })()`,
        condition: 'state.ready === true',
      })
      if (!ready.ok) {
        throw new Error(`对话流式状态验收失败：${String(width)} ${scheme} ${JSON.stringify(ready)}`)
      }
      await options.capture(`verify-conversation-stream-${String(width)}-${scheme}.png`)
    }
  }
  /* oxlint-enable no-await-in-loop */
  try {
    await emulateVerificationMedia(win, [{ name: 'prefers-reduced-motion', value: 'reduce' }])
    await waitForMediaFeature(win, '(prefers-reduced-motion: reduce)')
    const reduced = await pollRenderer<Record<string, unknown>>(win, {
      probe: `(() => {
        const text = document.querySelector('[data-streaming-cursor="true"] > :last-child')
        const stop = document.querySelector('.stop-button')
        const cursorAnim = text ? getComputedStyle(text, '::after').animationName : ''
        const stopBefore = stop ? getComputedStyle(stop, '::before').content : ''
        return { ready: Boolean(text && stop) && cursorAnim === 'none' && stopBefore === 'none', cursorAnim, stopBefore }
      })()`,
      condition: 'state.ready === true',
      timeoutMs: 1_500,
    })
    if (!reduced.ok) {
      throw new Error(`对话流式状态没有关闭减少动态模式下的动画：${JSON.stringify(reduced)}`)
    }
  } finally {
    await emulateVerificationMedia(win)
  }
}

async function verifyActivityMotion(win: BrowserWindow) {
  const moving = (await win.webContents.executeJavaScript(`(async () => {
    const row = document.querySelector('[data-thinking-disclosure][data-active="true"]')
    const dots = [...(row?.querySelectorAll('[data-variant="star"] i') ?? [])]
    const summary = row?.querySelector('[data-thinking-preview]')
    const sweep = summary?.getAnimations().find(animation => animation.animationName?.includes('thinking-sweep'))
    if (!sweep || !summary || summary.childElementCount !== 0 || summary.textContent.length <= 120) {
      return {
        ok: false, reason: 'missing-elements', hasRow: Boolean(row),
        dotsCount: dots.length, hasSweep: Boolean(sweep), textLength: summary?.textContent.length ?? 0,
      }
    }
    sweep.currentTime = 0
    sweep.play()
    const sample = () => ({
      dots: dots.map(dot => getComputedStyle(dot).opacity),
      position: parseFloat(getComputedStyle(summary).backgroundPositionX),
    })
    const first = sample()
    let dotsChanged = false
    let sweepMoved = false
    let last = first
    const deadline = performance.now() + 1200
    while (performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
      last = sample()
      dotsChanged ||= first.dots.some((value, index) => value !== last.dots[index])
      sweepMoved ||= Number.isFinite(last.position) && last.position < first.position
      if (dots.length === 9 && first.position >= 99 && dotsChanged && sweepMoved) return { ok: true }
    }
    return {
      ok: false, reason: 'no-motion', dotsCount: dots.length, dotsChanged, sweepMoved,
      firstPosition: first.position, lastPosition: last.position,
    }
  })()`)) as { ok: boolean }
  if (!moving.ok) {
    throw new Error(`思考摘要或点阵的运行指示没有产生实际视觉变化：${JSON.stringify(moving)}`)
  }
  try {
    await emulateVerificationMedia(win, [{ name: 'prefers-reduced-motion', value: 'reduce' }])
    await waitForMediaFeature(win, '(prefers-reduced-motion: reduce)')
    const reduced = await pollRenderer<Record<string, unknown>>(win, {
      probe: `(() => {
        const summary = document.querySelector('[data-thinking-disclosure][data-active="true"] [data-thinking-preview]')
        if (!summary) return { ready: false, missing: true }
        const style = getComputedStyle(summary)
        return {
          ready: style.animationName === 'none' && style.backgroundImage === 'none' && style.color !== 'rgba(0, 0, 0, 0)',
          animationName: style.animationName, backgroundImage: style.backgroundImage, color: style.color,
        }
      })()`,
      condition: 'state.ready === true',
      timeoutMs: 1_500,
    })
    if (!reduced.ok) {
      throw new Error(`减少动态模式下思考摘要未恢复为静态文字：${JSON.stringify(reduced)}`)
    }
  } finally {
    await emulateVerificationMedia(win)
  }
}

async function verifyToolEntrance(win: BrowserWindow) {
  const result = (await win.webContents.executeJavaScript(`(async () => {
    let row = null
    for (let attempt = 0; attempt < 160; attempt += 1) {
      row = document.querySelector('[data-tool-disclosure][data-state="running"]')?.parentElement ?? null
      if (row) break
      await new Promise(resolve => setTimeout(resolve, 15))
    }
    if (!(row instanceof HTMLElement)) return { ok: false, reason: 'missing-row' }
    const style = getComputedStyle(row)
    const duration = Number.parseFloat(style.animationDuration)
    if (!style.animationName.includes('conversation-enter') || !(duration > 0)) {
      return { ok: false, reason: 'missing-rule', animationName: style.animationName, duration }
    }
    const findAnimation = () =>
      row.getAnimations().find(item => item.animationName?.includes('conversation-enter'))
    // 220ms 一次性入场动画在 CI 调度或低帧率下可能已播完并移出 getAnimations()；
    // 确认真实 CSS 规则生效后按需重播一次，消除采样时序竞态。
    let animation = findAnimation()
    if (!animation) {
      row.style.animation = 'none'
      void row.offsetWidth
      row.style.animation = ''
      animation = findAnimation()
    }
    if (!animation) return { ok: false, reason: 'missing-animation' }
    animation.currentTime = 0
    animation.play()
    const before = getComputedStyle(row).transform
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 15))
      const current = Number(animation.currentTime)
      const after = getComputedStyle(row).transform
      if (current > 0 && after !== before) return { ok: true, attempts: attempt + 1 }
    }
    return {
      ok: false, reason: 'no-transform-change', playState: animation.playState,
      currentTime: animation.currentTime, before, after: getComputedStyle(row).transform,
    }
  })()`)) as { ok: boolean }
  if (!result.ok) throw new Error(`工具调用出现时没有实际入场动画：${JSON.stringify(result)}`)
  try {
    await emulateVerificationMedia(win, [{ name: 'prefers-reduced-motion', value: 'reduce' }])
    await waitForMediaFeature(win, '(prefers-reduced-motion: reduce)')
    const reduced = await pollRenderer<{ hasRow: boolean; animationName: string }>(win, {
      probe: `(() => {
        const row = document.querySelector('[data-tool-disclosure][data-state="running"]')?.parentElement
        return { hasRow: Boolean(row), animationName: row ? getComputedStyle(row).animationName : '' }
      })()`,
      condition: `state.hasRow && state.animationName === 'none'`,
      timeoutMs: 1_500,
    })
    if (!reduced.ok) throw new Error(`减少动态模式没有关闭工具入场动画：${JSON.stringify(reduced)}`)
  } finally {
    await emulateVerificationMedia(win)
  }
}

async function verifyThinking(win: BrowserWindow, options: ConversationPolishOptions) {
  publishChunk(options, {
    type: 'reasoning-delta',
    index: 0,
    text: '正在检查调用边界。'.repeat(20),
  })
  const thinking = await pollRenderer<{
    hasRow: boolean
    dots: number
    hasCursor: boolean
  }>(win, {
    probe: `(() => {
      const row = document.querySelector('[data-thinking-disclosure][data-active="true"]')
      return {
        hasRow: Boolean(row),
        dots: row?.querySelectorAll('[data-variant="star"] i').length ?? 0,
        hasCursor: Boolean(document.querySelector('[data-streaming-cursor="true"]')),
      }
    })()`,
    condition: 'state.hasRow && state.dots === 9 && !state.hasCursor',
  })
  if (!thinking.ok) {
    throw new Error(`思考状态未显示运行指示或错误显示正文光标：${JSON.stringify(thinking)}`)
  }
  await verifyActivityMotion(win)
  await options.capture('verify-thinking-sweep.png')
}

async function verifyPatchPreviewBounds(win: BrowserWindow, options: ConversationPolishOptions) {
  /* oxlint-disable no-await-in-loop -- 同一窗口依次检查补丁卡片在不同尺寸和主题下的边界。 */
  for (const width of [1280, 1800]) {
    for (const scheme of ['dark', 'light'] as const) {
      win.setSize(width, width === 1280 ? 800 : 1000)
      options.appearance(scheme)
      await waitForViewportSettled(win, { scheme })
      const contained = await pollRenderer<Record<string, unknown>>(win, {
        probe: `(() => {
          const row = document.querySelector('[data-tool-disclosure][data-state="running"]')
          const preview = row?.querySelector('[aria-label="请求的文件补丁预览"]')
          if (!row || !preview) return { ok: false, missing: true }
          const a = row.getBoundingClientRect(), b = preview.getBoundingClientRect()
          return {
            ok: b.left >= a.left && b.right <= a.right && a.left >= 0 && a.right <= innerWidth,
            row: a.toJSON(), preview: b.toJSON(), innerWidth,
          }
        })()`,
        condition: 'state.ok === true',
      })
      if (!contained.ok) {
        throw new Error(`文件补丁预览越界：${String(width)} ${scheme} ${JSON.stringify(contained)}`)
      }
      await options.capture(`verify-conversation-patch-${String(width)}-${scheme}.png`)
    }
  }
  /* oxlint-enable no-await-in-loop */
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
  const tool = await pollRenderer<number>(win, {
    probe: `document.querySelectorAll('[data-tool-disclosure][data-state="running"] [data-variant="wave"] i').length`,
    condition: 'state === 9',
  })
  if (!tool.ok) throw new Error(`工具运行时未显示脉冲指示：${JSON.stringify(tool)}`)
  await win.webContents.executeJavaScript(
    `document.querySelector('[data-tool-disclosure][data-state="running"] summary')?.click()`,
  )
  const patchReady = await pollRenderer<Record<string, unknown>>(win, {
    probe: `(() => {
      const row = document.querySelector('[data-tool-disclosure][data-state="running"]')
      const preview = row?.querySelector('[aria-label="请求的文件补丁预览"]')
      const input = row?.querySelector('dl')
      const rowBounds = row?.getBoundingClientRect(), inputBounds = input?.getBoundingClientRect()
      return {
        ok: Boolean(preview && preview.checkVisibility()
          && preview.textContent.includes('-原有说明') && preview.textContent.includes('+更新说明')
          && row?.querySelector('summary')?.textContent.includes('README.md')
          && rowBounds && inputBounds && inputBounds.left > rowBounds.left && inputBounds.right < rowBounds.right),
        hasPreview: Boolean(preview), visible: preview?.checkVisibility() ?? false,
        rowBounds: rowBounds?.toJSON() ?? null, inputBounds: inputBounds?.toJSON() ?? null,
      }
    })()`,
    condition: 'state.ok === true',
  })
  if (!patchReady.ok) {
    throw new Error(`文件补丁预览未展示实际请求内容：${JSON.stringify(patchReady)}`)
  }
  await options.capture('verify-conversation-patch.png')
  await verifyPatchPreviewBounds(win, options)
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
  const waiting = await pollRenderer<{ hasRow: boolean; hasText: boolean; dots: number }>(win, {
    probe: `(() => {
      const row = document.querySelector('[data-message-status="waiting"]')
      return {
        hasRow: Boolean(row),
        hasText: row?.textContent.includes('正在构思回复') === true,
        dots: row?.querySelectorAll('[data-variant="wave"] i').length ?? 0,
      }
    })()`,
    condition: 'state.hasRow && state.hasText && state.dots === 9',
  })
  if (!waiting.ok) {
    throw new Error(`首个步骤开始前没有显示九点等待状态：${JSON.stringify(waiting)}`)
  }
}

const PAGED_REPLY_ACTIVE_PROBE = `(() => {
  const row = document.querySelector('[data-message-status="streaming"]')
  const thinking = row?.querySelector('[data-thinking-disclosure][data-active="true"]')
  const stop = document.querySelector('.stop-button')
  const stoppedText = document.querySelector('#conversation-view')?.textContent.includes('回复已停止') ?? false
  const right = thinking?.getBoundingClientRect().right ?? Infinity
  return {
    ok: Boolean(thinking && stop && stop.checkVisibility() && !stoppedText && right <= innerWidth),
    hasThinking: Boolean(thinking), stopVisible: stop?.checkVisibility() ?? false,
    stoppedText, right, innerWidth,
  }
})()`

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
      await waitForViewportSettled(win, { scheme })
      const active = await pollRenderer<Record<string, unknown>>(win, {
        probe: PAGED_REPLY_ACTIVE_PROBE,
        condition: 'state.ok === true',
      })
      if (!active.ok) {
        throw new Error(
          `尾页回复被误判为停止：${String(width)} ${scheme} ${JSON.stringify(active)}`,
        )
      }
      await options.capture(`verify-paged-reply-${String(width)}-${scheme}.png`)
    }
  }
  /* oxlint-enable no-await-in-loop */
  options.setRunning(false)
  const stopped = await pollRenderer<{ interrupted: boolean; hasStop: boolean }>(win, {
    probe: `({
      interrupted: document.querySelector('[data-message-status="interrupted"]')?.textContent.includes('回复已停止') === true,
      hasStop: Boolean(document.querySelector('.stop-button')),
    })`,
    condition: 'state.interrupted && !state.hasStop',
  })
  if (!stopped.ok) {
    throw new Error(`权威运行状态停止后未保留回复中断提示：${JSON.stringify(stopped)}`)
  }
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
  const closed = await pollRenderer<{ interrupted: boolean; streaming: boolean }>(win, {
    probe: `({
      interrupted: Boolean(document.querySelector('[data-message-status="interrupted"]')),
      streaming: Boolean(document.querySelector('[data-message-status="streaming"]')),
    })`,
    condition: 'state.interrupted && !state.streaming',
  })
  if (!closed.ok) {
    throw new Error(`运行状态迟到时重新打开了已经结束的回复：${JSON.stringify(closed)}`)
  }
  console.log('desktop-shell-verify-local: paged-reply-status', {
    streaming: true,
    stopped: true,
    closedTurn: true,
  })
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
