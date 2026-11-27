import type { BrowserWindow } from 'electron'
import type { DesktopSessionFrame } from '../../shared/session-live.ts'
import { clickTrustedElement, emulateVerificationMedia } from './desktop-verifier.ts'
import { readVerificationProjection } from './session-projection-fixture.ts'
import {
  pollRenderer,
  waitForMediaFeature,
  waitForViewportSettled,
} from './verification-wait.ts'

/** 仅向隔离验收会话注入投影和失败事件，不读取或修改用户会话。 */
export async function verifyCompactionReadings(
  win: BrowserWindow,
  sessionId: string,
  emit: (frame: DesktopSessionFrame) => void,
  appearance: (scheme: 'light' | 'dark') => void,
  capture: (name: string) => Promise<void>,
): Promise<void> {
  const size = win.getSize()
  const baseline = await readVerificationProjection(win, sessionId)
  const pressure = (value: Record<string, number | boolean>) =>
    emit({
      type: 'session/plugin-projections',
      sessionId,
      change: {
        ...baseline,
        kind: 'snapshot',
        values: {
          ...baseline.values,
          contextPressure: value,
          contextBreakdown: { systemTokens: 700, toolsTokens: 800, messageTokens: 395_000 },
        },
        omitted: 0,
      },
    })
  const panel = '[role="dialog"][aria-label="上下文占用"]'
  try {
    /* oxlint-disable no-await-in-loop -- 同一个真实窗口依次覆盖尺寸、主题及状态转换。 */
    for (const sample of [
      { width: 1280, height: 800, scheme: 'light' as const },
      { width: 1280, height: 800, scheme: 'dark' as const },
      { width: 1800, height: 1000, scheme: 'light' as const },
      { width: 1800, height: 1000, scheme: 'dark' as const },
    ]) {
      win.setSize(sample.width, sample.height)
      appearance(sample.scheme)
      pressure({ projectedTokens: 395_000, contextWindow: 272_000 })
      await waitForViewportSettled(win, { scheme: sample.scheme })
      await clickTrustedElement(
        win,
        '[data-composer-readings] button[aria-label="上下文占用 145%"]',
      )
      const overflowPolled = await pollRenderer<{
        percent: boolean
        warning: boolean
        arc: number[] | null
        length: number | null
      }>(win, {
        probe: `(() => {
          const panel = document.querySelector('${panel}')
          const ring = document.querySelector('[data-composer-readings] button[aria-label="上下文占用 145%"] circle[stroke-dasharray]')
          const arc = ring?.getAttribute('stroke-dasharray')?.split(' ').map(Number)
          return {
            percent: panel?.textContent.includes('上下文已用 145%') === true,
            warning: panel?.textContent.includes('超过标称窗口') === true,
            // 圆环按 SVG 半径核对整圈，避免把路径近似长度当作占用环使用的圆周。
            arc: arc ?? null,
            length: ring instanceof SVGCircleElement ? 2 * Math.PI * ring.r.baseVal.value : null,
          }
        })()`,
        condition: `state.percent && state.warning && state.arc?.length === 2 && state.arc[0] === state.arc[1] && state.length !== null && Math.abs(state.arc[0] - state.length) < 0.1`,
      })
      const overflow = overflowPolled.value
      console.log('desktop-shell-verify-local: compaction-overflow', overflow)
      if (!overflowPolled.ok)
        throw new Error('超窗读数未显示 145% 或图形未封顶：' + JSON.stringify(overflowPolled))
      await capture(`verify-compaction-overflow-${sample.width}-${sample.scheme}.png`)
      pressure({
        projectedTokens: 395_000,
        contextWindow: 272_000,
        nativeCompaction: true,
        awaitingUsage: true,
      })
      const waiting = await pollRenderer<Record<string, unknown>>(win, {
        probe: `(() => {
          const panel = document.querySelector('${panel}')
          if (!panel) return { ok: false, missing: true }
          const rect = panel.getBoundingClientRect(), style = getComputedStyle(panel)
          const text = panel.textContent ?? ''
          const hasButton = Boolean(document.querySelector('[data-composer-readings] button[aria-label="请求占用等待更新"]'))
          const ok = text.includes('请求占用：等待更新') && !text.includes('145%')
            && text.includes('本地保留历史与配置（估算，非请求占用）') && text.includes('~395K')
            && hasButton && rect.top >= 0 && rect.right <= innerWidth && rect.bottom < innerHeight
            && panel.scrollWidth <= panel.clientWidth + 1 && parseFloat(style.borderTopWidth) > 0
            && style.borderTopStyle !== 'none' && style.backgroundColor !== 'rgba(0, 0, 0, 0)'
          return {
            ok, hasButton, rect: rect.toJSON(), innerWidth, innerHeight,
            scrollWidth: panel.scrollWidth, clientWidth: panel.clientWidth,
            borderTopWidth: style.borderTopWidth, borderTopStyle: style.borderTopStyle,
            backgroundColor: style.backgroundColor,
          }
        })()`,
        condition: 'state.ok === true',
      })
      if (!waiting.ok) {
        throw new Error(`原生压缩等待状态、历史区分、面板描边或布局验收失败：${JSON.stringify(waiting)}`)
      }
      await capture(`verify-compaction-waiting-${sample.width}-${sample.scheme}.png`)
      if (sample.width === 1280 && sample.scheme === 'dark') {
        for (const [name, features] of [
          [
            'accessible',
            [
              { name: 'forced-colors', value: 'active' },
              { name: 'prefers-reduced-motion', value: 'reduce' },
            ],
          ],
          ['solid', [{ name: 'prefers-reduced-transparency', value: 'reduce' }]],
        ] as const) {
          await emulateVerificationMedia(win, [...features])
          await waitForMediaFeature(
            win,
            name === 'accessible' ? '(forced-colors: active)' : '(prefers-reduced-transparency: reduce)',
          )
          const visible = await pollRenderer<{ visible: boolean; hasText: boolean }>(win, {
            probe: `(() => {
              const node = document.querySelector('${panel}')
              return { visible: node?.checkVisibility() === true, hasText: node?.textContent.includes('等待更新') === true }
            })()`,
            condition: 'state.visible && state.hasText',
            timeoutMs: 1_500,
          })
          if (!visible.ok) throw new Error(`压缩读数在无障碍降级下不可见：${JSON.stringify(visible)}`)
          await capture(`verify-compaction-${name}.png`)
        }
        await emulateVerificationMedia(win)
      }
      pressure({ projectedTokens: 2000, contextWindow: 272_000, nativeCompaction: true })
      const fresh = await pollRenderer<{ ok: boolean; text: string }>(win, {
        probe: `(() => {
          const text = document.querySelector('${panel}')?.textContent ?? ''
          return {
            ok: text.includes('上下文已用 1%') && !text.includes('等待更新')
              && text.includes('~395K') && text.includes('本地历史不会全部重发'),
            text: text.slice(0, 240),
          }
        })()`,
        condition: 'state.ok === true',
      })
      if (!fresh.ok) throw new Error(`原生压缩后的有效占用未替换等待状态：${JSON.stringify(fresh)}`)
      await clickTrustedElement(win, '[data-composer-readings] button[aria-label="上下文占用 1%"]')
    }
    /* oxlint-enable no-await-in-loop */
    emit({
      type: 'session/event',
      sessionId,
      event: {
        type: 'compaction/end',
        seq: 800_001,
        time: Date.now(),
        data: {
          turn: 1,
          error: '隔离验收：摘要参数不支持',
          failure: { code: 'UNSUPPORTED_OPTION', message: '摘要参数不支持' },
        },
      },
    })
    emit({
      type: 'session/event',
      sessionId,
      event: {
        type: 'turn/end',
        seq: 800_002,
        time: Date.now(),
        data: {
          turn: 1,
          reason: {
            kind: 'error',
            error: {
              code: 'COMPACTION_BLOCKED',
              message: '已停止本轮请求。会话和工具结果已保留，请修正压缩配置后继续。',
            },
          },
        },
      },
    })
    const failure = await pollRenderer<{ ok: boolean; snippet: string }>(win, {
      probe: `(() => {
        const text = document.querySelector('#conversation-view')?.textContent ?? ''
        return {
          ok: text.includes('上下文压缩失败：隔离验收：摘要参数不支持') && text.includes('会话和工具结果已保留'),
          snippet: text.slice(-240),
        }
      })()`,
      condition: 'state.ok === true',
    })
    if (!failure.ok) throw new Error(`压缩失败及恢复方式未进入真实对话视图：${JSON.stringify(failure)}`)
    await capture('verify-compaction-failure.png')
    console.log('desktop-shell-verify-local: compaction-readings', {
      overflow: true,
      waiting: true,
      fresh: true,
      failure: true,
    })
  } finally {
    await win.webContents.executeJavaScript(
      `document.querySelector('${panel}') && document.querySelector('[data-composer-readings] button[aria-expanded="true"]')?.click()`,
    )
    await emulateVerificationMedia(win)
    win.setSize(size[0]!, size[1]!)
    emit({
      type: 'session/plugin-projections',
      sessionId,
      change: {
        ...baseline,
        kind: 'snapshot',
        values: {
          ...baseline.values,
          contextPressure: { projectedTokens: 3900, contextWindow: 128_000 },
          contextBreakdown: { systemTokens: 700, toolsTokens: 800, messageTokens: 2100 },
        },
        omitted: 0,
      },
    })
    await waitForViewportSettled(win)
  }
}
