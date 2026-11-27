/** 主进程在隔离窗口验收对话 Markdown 排版、表格列宽、代码块换行与强制色彩降级。 */
import type { BrowserWindow } from 'electron'
import type { DesktopSessionFrame } from '../../shared/session-live.ts'
import { emulateVerificationMedia } from './desktop-verifier.ts'
import {
  pollRenderer,
  waitForMediaFeature,
  waitForViewportSettled,
} from './verification-wait.ts'

/** Markdown 排版验收所需的会话发布、主题切换与截图回调。 */
export interface MarkdownBlocksOptions {
  readonly sessionId: string
  readonly emit: (frame: DesktopSessionFrame) => void
  readonly setRunning: (running: boolean) => void
  readonly appearance: (scheme: 'light' | 'dark') => void
  readonly capture: (name: string) => Promise<void>
}

function wideRow(value: string): string {
  return `| ${Array.from({ length: 24 }, () => value).join(' | ')} |`
}

const MARKDOWN_SAMPLE_TEXT = [
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

const MARKDOWN_TABLE_SCRIPT = `(() => {
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
  return {
    shortLabelsFit, scrolls, localSurface, userRaised, sendRecessed, quoteBorder,
    fitsWindow: document.documentElement.scrollWidth === innerWidth,
    ...(shortLabelsFit ? {} : { shortCellDetails }),
  }
})()`

async function verifyMarkdownTable(win: BrowserWindow): Promise<void> {
  const layout = (await win.webContents.executeJavaScript(MARKDOWN_TABLE_SCRIPT)) as Record<
    string,
    unknown
  > | null
  if (
    !layout ||
    Object.entries(layout).some(([key, value]) => key !== 'shortCellDetails' && value !== true)
  ) {
    throw new Error(`对话表格列宽、滚动或内容块层次异常：${JSON.stringify(layout)}`)
  }
}

const MARKDOWN_BLOCK_PROBE = `(() => {
  const block = document.querySelector('[data-code-block]')
  const heading = block?.parentElement?.querySelector('h1')
  const paragraph = block?.parentElement?.querySelector('p')
  const pre = block?.querySelector('pre')
  const wrap = block?.querySelector('[aria-label="自动换行"]')
  const copy = block?.querySelector('[aria-label="复制代码"]')
  if (!pre || !wrap || !copy || !heading || !paragraph || !copy.checkVisibility()) {
    return { ok: false, missing: true }
  }
  const compact = parseFloat(getComputedStyle(heading).fontSize) - parseFloat(getComputedStyle(paragraph).fontSize) <= 3
  const right = block.getBoundingClientRect().right
  return {
    ok: compact && pre.scrollWidth > pre.clientWidth && right <= innerWidth,
    compact, scrollWidth: pre.scrollWidth, clientWidth: pre.clientWidth, right, innerWidth,
  }
})()`

const MARKDOWN_WRAP_PROBE = `(() => {
  const block = document.querySelector('[data-code-block]')
  const pre = block?.querySelector('pre')
  return {
    ok: block?.dataset.wrap === 'true' && Boolean(pre) && pre.scrollWidth <= pre.clientWidth + 1,
    wrap: block?.dataset.wrap ?? null,
    scrollWidth: pre?.scrollWidth ?? 0,
    clientWidth: pre?.clientWidth ?? 0,
  }
})()`

/** 验证多尺寸与明暗主题下的 Markdown 标题字号、表格列宽及代码块自动换行。 */
export async function verifyMarkdownBlocks(
  win: BrowserWindow,
  options: MarkdownBlocksOptions,
): Promise<void> {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '检查生成状态' }] },
    },
    {
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: MARKDOWN_SAMPLE_TEXT }] } },
    },
  ].map((event, seq) => ({ ...event, seq, time: 1_700_000_000_000 + seq * 100 }))
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
    await waitForViewportSettled(win, { scheme })
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-code-block] [aria-pressed="true"]')?.click()`,
    )
    const ready = await pollRenderer<Record<string, unknown>>(win, {
      probe: MARKDOWN_BLOCK_PROBE,
      condition: 'state.ok === true',
    })
    if (!ready.ok) {
      throw new Error(
        `回复标题或代码块工具栏布局异常：${String(width)} ${scheme} ${JSON.stringify(ready)}`,
      )
    }
    await verifyMarkdownTable(win)
    await options.capture(`verify-markdown-${String(width)}-${scheme}.png`)
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-code-block] [aria-label="自动换行"]')?.click()`,
    )
    const wrapped = await pollRenderer<Record<string, unknown>>(win, {
      probe: MARKDOWN_WRAP_PROBE,
      condition: 'state.ok === true',
      timeoutMs: 1_500,
    })
    if (!wrapped.ok) throw new Error(`代码块换行后仍然横向溢出：${JSON.stringify(wrapped)}`)
  }
  /* oxlint-enable no-await-in-loop */
}

/** 验证强制色彩模式下对话表格、引用块、代码块与发送按钮均以实线描边区分。 */
export async function verifyMarkdownContrast(win: BrowserWindow): Promise<void> {
  await emulateVerificationMedia(win, [{ name: 'forced-colors', value: 'active' }])
  await waitForMediaFeature(win, '(forced-colors: active)')
  const ready = await pollRenderer<{ forced: boolean; bordered: boolean }>(win, {
    probe: `(() => {
      const code = document.querySelector('[data-code-block]')
      const table = code?.parentElement?.querySelector('table')
      const quote = code?.parentElement?.querySelector('blockquote')
      const send = document.querySelector('.send-button')
      return {
        forced: matchMedia('(forced-colors: active)').matches,
        bordered: [table?.parentElement, quote, code, send].every(block => {
          if (!block) return false
          const style = getComputedStyle(block)
          return style.borderTopWidth === '1px' && style.borderTopStyle === 'solid' && style.boxShadow === 'none'
        }),
      }
    })()`,
    condition: 'state.forced && state.bordered',
    timeoutMs: 1_500,
  })
  if (!ready.ok) {
    throw new Error(`强制色彩模式下对话内容块没有以描边区分：${JSON.stringify(ready)}`)
  }
}
