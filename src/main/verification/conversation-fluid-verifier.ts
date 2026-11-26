/** 使用隔离事件检查对话真实分片与工具数据的可见变化。 */
import type { BrowserWindow } from 'electron'
import type { DesktopSessionFrame } from '../../shared/session-live.ts'
import { emulateVerificationMedia } from './desktop-verifier.ts'

interface FluidOptions {
  readonly sessionId: string
  readonly emit: (frame: DesktopSessionFrame) => void
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
  options.emit({
    type: 'session/snapshot',
    sessionId: options.sessionId,
    events,
    lastSeq: 3,
    hasMore: false,
  })
  const progress = await win.webContents.executeJavaScript(`(async () => {
    const expected = ${JSON.stringify(text)};
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const element = document.querySelector('[data-streaming-cursor="true"]');
      const first = element?.textContent ?? '';
      if (first.length > 0 && first.length < expected.length && expected.startsWith(first)) {
        await new Promise(resolve => setTimeout(resolve, 45));
        const next = element.textContent;
        return next.length > first.length && expected.startsWith(next);
      }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    return false;
  })()`)
  if (!progress) throw new Error('收到的正文分片没有逐步显示')
  await emulateVerificationMedia(win, [{ name: 'prefers-reduced-motion', value: 'reduce' }])
  const immediate = await win.webContents.executeJavaScript(`(async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (document.querySelector('[data-streaming-cursor="true"]')?.textContent === ${JSON.stringify(text)}) return true;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return false;
  })()`)
  await emulateVerificationMedia(win)
  if (!immediate) throw new Error('减少动态模式没有立即显示已收到的正文')
}

/** 采样工具摘要中新字符的渐显状态。 */
export async function verifySummaryReveal(win: BrowserWindow): Promise<void> {
  const animated = await win.webContents.executeJavaScript(`(() => {
    const glyphs = [...document.querySelectorAll('[data-tool-disclosure][data-state="running"] [data-animated-summary] > span')];
    return glyphs.length > 2 && getComputedStyle(glyphs[0]).animationName !== 'none'
      && getComputedStyle(glyphs[1]).animationDelay !== getComputedStyle(glyphs[0]).animationDelay;
  })()`)
  if (!animated) throw new Error('工具摘要没有逐字显示')
}

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
  const revealed = await win.webContents.executeJavaScript(`(async () => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const output = document.querySelector('[data-tool-result]');
      const animation = output?.getAnimations().find(item => item.animationName?.includes('tool-result-reveal'));
      if (output && animation && output.textContent.includes('工具返回的真实内容')) {
        const first = getComputedStyle(output).clipPath;
        await new Promise(resolve => setTimeout(resolve, 45));
        return first !== getComputedStyle(output).clipPath;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return false;
  })()`)
  if (!revealed) throw new Error('工具返回数据没有逐步显现')
  await emulateVerificationMedia(win, [{ name: 'prefers-reduced-motion', value: 'reduce' }])
  const reduced = await win.webContents.executeJavaScript(`(() => {
    const output = document.querySelector('[data-tool-result]');
    return output && getComputedStyle(output).animationName === 'none';
  })()`)
  await emulateVerificationMedia(win)
  if (!reduced) throw new Error('减少动态模式没有关闭工具结果显现动画')
}
