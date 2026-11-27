/** 使用隔离事件检查对话真实分片与工具数据的可见变化；运行在主进程，结束时清理页面探针与媒体仿真。 */
import type { BrowserWindow } from 'electron'
import type { DesktopSessionFrame } from '../../shared/session-live.ts'
import { emulateVerificationMedia } from './desktop-verifier.ts'
import { pollRenderer, waitForMediaFeature } from './verification-wait.ts'

interface FluidOptions {
  readonly sessionId: string
  readonly emit: (frame: DesktopSessionFrame) => void
}

/** 流式正文探针的收集结果，用于确认真实分片逐步显现并在失败时提供诊断上下文。 */
export interface FluidTextProbeResult {
  readonly ok: boolean
  readonly firstLength: number
  readonly nextLength: number
  readonly expectedLength: number
  readonly attempts: number
  readonly samples: readonly number[]
  readonly reducedMotion: boolean
  readonly forcedColors: boolean
}

const FLUID_PROBE_KEY = '__mydshFluidTextProbe'

/**
 * 构造流式正文前置观察探针脚本。
 * 必须在发出 `session/snapshot` 之前安装，才能在低帧率或跨进程调度延迟下捕获首个部分显示帧。
 */
export function buildFluidTextProbeScript(expected: string): string {
  return `(() => {
    const key = ${JSON.stringify(FLUID_PROBE_KEY)}
    const previous = globalThis[key]
    if (previous && typeof previous.dispose === 'function') previous.dispose()
    const expected = ${JSON.stringify(expected)}
    const samples = []
    let firstLength = 0
    let nextLength = 0
    const sample = () => {
      const element = document.querySelector('[data-streaming-cursor="true"]')
      const current = element?.textContent ?? ''
      if (current.length === 0 || !expected.startsWith(current)) return
      if (samples[samples.length - 1] !== current.length) samples.push(current.length)
      if (firstLength === 0 && current.length < expected.length) {
        firstLength = current.length
      } else if (firstLength > 0 && current.length > firstLength && nextLength <= firstLength) {
        nextLength = current.length
      }
    }
    const observer = new MutationObserver(sample)
    if (document.body) {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['data-streaming-cursor'],
      })
    }
    sample()
    globalThis[key] = {
      expected,
      sample,
      snapshot: () => ({ firstLength, nextLength, samples: [...samples] }),
      dispose: () => {
        observer.disconnect()
        delete globalThis[key]
      },
    }
  })()`
}

/**
 * 构造等待并回收流式正文探针的脚本。
 * 使用动画帧与短定时竞速的有界轮询替代固定 45ms 等待，在软件渲染低帧率下仍严格校验递增前缀。
 */
export function buildFluidTextCollectScript(expected: string, timeoutMs = 2_500): string {
  return `(async () => {
    const key = ${JSON.stringify(FLUID_PROBE_KEY)}
    const expected = ${JSON.stringify(expected)}
    const probe = globalThis[key]
    const deadline = Date.now() + ${String(timeoutMs)}
    let attempts = 0
    try {
      while (true) {
        attempts += 1
        probe?.sample()
        const state = probe?.snapshot() ?? { firstLength: 0, nextLength: 0, samples: [] }
        if (state.firstLength > 0 && state.nextLength > state.firstLength) {
          return {
            ok: true,
            firstLength: state.firstLength,
            nextLength: state.nextLength,
            expectedLength: expected.length,
            attempts,
            samples: state.samples,
            reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
            forcedColors: matchMedia('(forced-colors: active)').matches,
          }
        }
        // 已完整渲染且未捕获任何部分前缀时提前失败，避免无效空等至超时。
        if (state.firstLength === 0 && state.samples.includes(expected.length) && attempts >= 5) {
          return {
            ok: false,
            firstLength: state.firstLength,
            nextLength: state.nextLength,
            expectedLength: expected.length,
            attempts,
            samples: state.samples,
            reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
            forcedColors: matchMedia('(forced-colors: active)').matches,
          }
        }
        if (Date.now() >= deadline) {
          return {
            ok: false,
            firstLength: state.firstLength,
            nextLength: state.nextLength,
            expectedLength: expected.length,
            attempts,
            samples: state.samples,
            reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
            forcedColors: matchMedia('(forced-colors: active)').matches,
          }
        }
        await Promise.race([
          new Promise(resolve => requestAnimationFrame(resolve)),
          new Promise(resolve => setTimeout(resolve, 20)),
        ])
      }
    } finally {
      probe?.dispose()
    }
  })()`
}

/** 检查实际收到的正文分片在短时间内逐步显示，并在减少动态时立即显示。 */
export async function verifyFluidText(win: BrowserWindow, options: FluidOptions): Promise<void> {
  const text = '正在读取真实内容并整理结果。'.repeat(12)
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '检查文字显示' }] },
    },
    {
      type: 'assistant/chunk',
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text } },
    },
  ].map((event, seq) => ({ ...event, seq, time: 1_700_000_000_000 + seq * 100 }))
  // 先挂载 DOM 观察探针再发出快照，防止低帧率或 IPC 调度延迟导致跳过首个增量帧。
  await win.webContents.executeJavaScript(buildFluidTextProbeScript(text))
  let progress: FluidTextProbeResult
  try {
    options.emit({
      type: 'session/snapshot',
      sessionId: options.sessionId,
      events,
      lastSeq: 3,
      hasMore: false,
    })
    progress = (await win.webContents.executeJavaScript(
      buildFluidTextCollectScript(text),
    )) as FluidTextProbeResult
  } finally {
    await win.webContents
      .executeJavaScript(`globalThis[${JSON.stringify(FLUID_PROBE_KEY)}]?.dispose()`)
      .catch(() => undefined)
  }
  if (!progress.ok) {
    throw new Error(`收到的正文分片没有逐步显示：${JSON.stringify(progress)}`)
  }
  try {
    await emulateVerificationMedia(win, [{ name: 'prefers-reduced-motion', value: 'reduce' }])
    await waitForMediaFeature(win, '(prefers-reduced-motion: reduce)')
    const immediate = await pollRenderer<{
      actualLength: number
      expectedLength: number
      matches: boolean
      reducedMotion: boolean
    }>(win, {
      probe: `(() => {
        const current = document.querySelector('[data-streaming-cursor="true"]')?.textContent ?? ''
        return {
          actualLength: current.length,
          expectedLength: ${String(text.length)},
          matches: current === ${JSON.stringify(text)},
          reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        }
      })()`,
      condition: 'state.matches === true',
      timeoutMs: 1_500,
      intervalMs: 15,
    })
    if (!immediate.ok) {
      throw new Error(`减少动态模式没有立即显示已收到的正文：${JSON.stringify(immediate)}`)
    }
  } finally {
    await emulateVerificationMedia(win)
  }
}

/** 采样工具摘要中新字符的渐显状态。 */
export async function verifySummaryReveal(win: BrowserWindow): Promise<void> {
  const animated = await pollRenderer<{
    count: number
    firstAnimation: string
    firstDelay: string
    secondDelay: string
  }>(win, {
    probe: `(() => {
      const glyphs = [...document.querySelectorAll('[data-tool-disclosure][data-state="running"] [data-animated-summary] > span')]
      return {
        count: glyphs.length,
        firstAnimation: glyphs[0] ? getComputedStyle(glyphs[0]).animationName : 'none',
        firstDelay: glyphs[0] ? getComputedStyle(glyphs[0]).animationDelay : '',
        secondDelay: glyphs[1] ? getComputedStyle(glyphs[1]).animationDelay : '',
      }
    })()`,
    condition: `state.count > 2 && state.firstAnimation !== 'none' && state.secondDelay !== state.firstDelay`,
    timeoutMs: 1_500,
    intervalMs: 20,
  })
  if (!animated.ok) {
    throw new Error(`工具摘要没有逐字显示：${JSON.stringify(animated)}`)
  }
}

const TOOL_OUTPUT_REVEAL_SCRIPT = `(async () => {
  let output = null
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const candidate = document.querySelector('[data-tool-result]')
    if (candidate instanceof HTMLElement && candidate.textContent.includes('工具返回的真实内容')) {
      output = candidate
      break
    }
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  if (!(output instanceof HTMLElement)) return { ok: false, reason: 'missing-output' }
  const style = getComputedStyle(output)
  const duration = Number.parseFloat(style.animationDuration)
  if (!style.animationName.includes('tool-result-reveal') || !(duration > 0)) {
    return { ok: false, reason: 'missing-rule', animationName: style.animationName, duration }
  }
  const findAnimation = () =>
    output.getAnimations().find(item => item.animationName?.includes('tool-result-reveal'))
  let animation = findAnimation()
  if (!animation) {
    output.style.animation = 'none'
    void output.offsetWidth
    output.style.animation = ''
    animation = findAnimation()
  }
  if (!animation) return { ok: false, reason: 'missing-animation' }
  animation.currentTime = 0
  animation.play()
  const first = getComputedStyle(output).clipPath
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 15))
    if (getComputedStyle(output).clipPath !== first) return { ok: true, attempts: attempt + 1 }
  }
  return {
    ok: false,
    reason: 'no-clip-change',
    playState: animation.playState,
    currentTime: animation.currentTime,
    first,
    after: getComputedStyle(output).clipPath,
  }
})()`

/** 验证工具完成时新增的真实输出由上至下显现。 */
export async function verifyToolOutputReveal(
  win: BrowserWindow,
  options: FluidOptions,
): Promise<void> {
  options.emit({
    type: 'session/event',
    sessionId: options.sessionId,
    event: {
      type: 'tool/result',
      seq: 4,
      time: 1_700_000_000_400,
      data: {
        turn: 1,
        step: 1,
        message: {
          source: { callId: '验收工具' },
          content: [
            { type: 'tool-result', content: [{ type: 'text', text: '工具返回的真实内容' }] },
          ],
        },
      },
    },
  })
  const revealed = (await win.webContents.executeJavaScript(TOOL_OUTPUT_REVEAL_SCRIPT)) as {
    ok: boolean
  }
  if (!revealed.ok) throw new Error(`工具返回数据没有逐步显现：${JSON.stringify(revealed)}`)
  try {
    await emulateVerificationMedia(win, [{ name: 'prefers-reduced-motion', value: 'reduce' }])
    await waitForMediaFeature(win, '(prefers-reduced-motion: reduce)')
    const reduced = await pollRenderer<{ hasOutput: boolean; animationName: string }>(win, {
      probe: `(() => {
        const output = document.querySelector('[data-tool-result]')
        return {
          hasOutput: Boolean(output),
          animationName: output ? getComputedStyle(output).animationName : '',
        }
      })()`,
      condition: `state.hasOutput && state.animationName === 'none'`,
      timeoutMs: 1_500,
      intervalMs: 15,
    })
    if (!reduced.ok) {
      throw new Error(`减少动态模式没有关闭工具结果显现动画：${JSON.stringify(reduced)}`)
    }
  } finally {
    await emulateVerificationMedia(win)
  }
}
