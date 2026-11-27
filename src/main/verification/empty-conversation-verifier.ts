/** 主进程检查隔离窗口中的空会话，避免预设栏撑破浮岛或遮挡输入区。 */
import type { BrowserWindow } from 'electron'
import { emulateVerificationMedia } from './desktop-verifier.ts'
import {
  pollRenderer,
  waitForMediaFeature,
  waitForViewportSettled,
} from './verification-wait.ts'

const PRESET_MOTION_SCRIPT = `(async () => {
  const group = [...document.querySelectorAll('[aria-label="Agent 预设"]')]
    .find(element => element.querySelector('[data-preset-lens]') && element.checkVisibility())
  const initial = group?.querySelector('button[aria-pressed="true"]')
  const unselected = [
    ...(group?.querySelectorAll('button[aria-pressed="false"]:not(:disabled):not([aria-haspopup])') ?? []),
  ]
  const [next, third] = unselected
  const more = group?.querySelector('button[aria-haspopup="menu"]')
  const lens = group?.querySelector('[data-preset-lens]')
  const material = group?.querySelector('[data-preset-material]')
  const buttons = group?.querySelectorAll('button') ?? []
  const validButtons = more ? buttons.length === 5 : buttons.length === 3 && Boolean(third)
  const filter = material ? getComputedStyle(material).filter : ''
  if (!initial || !next || !lens || !material || lens.hidden || !validButtons || !filter.includes('liquid-glass-web-react')) {
    return {
      ok: false, stage: 'setup', hasGroup: Boolean(group), hasInitial: Boolean(initial),
      hasNext: Boolean(next), hasLens: Boolean(lens), lensHidden: lens?.hidden ?? null,
      validButtons, buttonCount: buttons.length, filter,
    }
  }
  const center = element => {
    const rect = element.getBoundingClientRect()
    return rect.left + rect.width / 2
  }
  const tick = () => Promise.race([
    new Promise(resolve => requestAnimationFrame(resolve)),
    new Promise(resolve => setTimeout(resolve, 20)),
  ])
  const move = async (stage, button, trigger = button) => {
    const start = center(lens)
    const available = [...group.querySelectorAll('button:not(:disabled)')]
    let intermediate = false
    let last = {}
    trigger.click()
    const deadline = performance.now() + 5000
    while (performance.now() < deadline) {
      await tick()
      if (available.some(item => item.disabled || getComputedStyle(item).opacity !== '1')) {
        return { ok: false, stage, reason: 'button-disabled-or-faded' }
      }
      const current = center(lens)
      if (button.getAttribute('aria-pressed') !== 'true') continue
      const end = center(button)
      const widthDiff = Math.abs(lens.getBoundingClientRect().width - button.getBoundingClientRect().width)
      const busy = group.getAttribute('aria-busy')
      intermediate ||= Math.abs(current - start) > 2 && Math.abs(current - end) > 2
      last = { start, current, end, widthDiff, busy, intermediate }
      if (Math.abs(current - end) < 0.2 && widthDiff < 0.2 && busy === 'false') {
        return { ok: intermediate, stage, ...last }
      }
    }
    return { ok: false, stage, reason: 'timeout', ...last }
  }
  const switched = await move('first', next)
  if (!switched.ok) return switched
  let secondSwitched = { ok: false, stage: 'second', reason: 'no-target' }
  if (more) {
    more.click()
    let hidden = null
    const menuDeadline = Date.now() + 1500
    while (Date.now() < menuDeadline && !hidden) {
      await tick()
      const menu = document.getElementById(more.getAttribute('aria-controls'))
      hidden = menu?.querySelector('button:not(:disabled)') ?? null
    }
    secondSwitched = hidden ? await move('more', more, hidden) : { ok: false, stage: 'more', reason: 'missing-hidden-item' }
  } else if (third) {
    secondSwitched = await move('third', third)
  }
  if (!secondSwitched.ok) return secondSwitched
  return await move('restore', initial)
})()`

const EMPTY_CONVERSATION_LAYOUT_SCRIPT = `(async () => {
  const stage = [...document.querySelectorAll('[aria-label="空会话"]')]
    .find(element => element instanceof HTMLElement && element.checkVisibility())
  const workshop = stage?.querySelector('canvas[data-pixel-workshop="true"]')
  const content = stage?.querySelector(':scope > div')
  const presets = stage?.querySelector('[aria-label="Agent 预设"]')
  const composer = stage?.closest('[data-conversation-frame]')?.querySelector('.composer-card')
  if (!(stage instanceof HTMLElement) || !(workshop instanceof HTMLCanvasElement)
    || !(content instanceof HTMLElement) || !(presets instanceof HTMLElement)
    || !(composer instanceof HTMLElement)) return { mounted: false }
  const bounds = stage.getBoundingClientRect()
  const workshopBounds = workshop.getBoundingClientRect()
  const workshopCtx = workshop.getContext('2d')
  let workshopPainted = false
  if (workshopCtx && workshop.width > 0 && workshop.height > 0) {
    const pixels = workshopCtx.getImageData(0, 0, workshop.width, workshop.height).data
    for (let offset = 3; offset < pixels.length; offset += 4) {
      if (pixels[offset] > 0) {
        workshopPainted = true
        break
      }
    }
  }
  const track = presets.getBoundingClientRect()
  const input = composer.getBoundingClientRect()
  const root = document.documentElement
  const previousAccent = root.style.getPropertyValue('--accent')
  const colors = ['#4d6bfe', '#2f9d77', '#d97745', '#c45a84', '#8069d4']
  const accents = []
  const tick = () => Promise.race([
    new Promise(resolve => requestAnimationFrame(resolve)),
    new Promise(resolve => setTimeout(resolve, 20)),
  ])
  try {
    for (const color of colors) {
      const before = workshop.dataset.accent ?? ''
      root.style.setProperty('--accent', color)
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await tick()
        if ((workshop.dataset.accent ?? '') && workshop.dataset.accent !== before) break
      }
      accents.push(workshop.dataset.accent ?? '')
    }
  } finally {
    if (previousAccent) root.style.setProperty('--accent', previousAccent)
    else root.style.removeProperty('--accent')
    await tick()
  }
  return {
    mounted: true,
    noHorizontalOverflow: stage.scrollWidth <= stage.clientWidth + 1,
    noSuggestions: stage.querySelector('[aria-label="起手建议"]') === null,
    noBeacon: content.querySelector(':scope > [aria-hidden="true"]') === null
      && content.firstElementChild?.tagName === 'H2',
    workshopMounted: workshop.width > 0 && workshop.height > 0
      && workshopBounds.width >= bounds.width - 2 && workshopBounds.height >= bounds.height - 2
      && getComputedStyle(workshop).pointerEvents === 'none'
      && workshopPainted,
    trackContained: track.left >= bounds.left && track.right <= bounds.right,
    composerClear: track.bottom <= input.top + 1,
    presetCount: presets.querySelectorAll('button').length > 0,
    accentFollows: accents.every(Boolean) && new Set(accents).size === colors.length,
  }
})()`

async function verifyPresetMotion(win: BrowserWindow): Promise<void> {
  const result = (await win.webContents.executeJavaScript(PRESET_MOTION_SCRIPT)) as { ok: boolean }
  if (!result.ok) {
    throw new Error(`预设透镜未随切换连续滑动，或未对齐选中项：${JSON.stringify(result)}`)
  }
  await verifyPresetForcedColorsFallback(win)
}

async function verifyPresetForcedColorsFallback(win: BrowserWindow): Promise<void> {
  try {
    await emulateVerificationMedia(win, [
      { name: 'prefers-reduced-motion', value: 'reduce' },
      { name: 'prefers-reduced-transparency', value: 'reduce' },
      { name: 'forced-colors', value: 'active' },
    ])
    await waitForMediaFeature(win, '(forced-colors: active)')
    const fallback = await pollRenderer<Record<string, unknown>>(win, {
      probe: `(() => {
        const lens = [...document.querySelectorAll('[data-preset-lens]')]
          .find(element => element.closest('[aria-label="Agent 预设"]')?.checkVisibility())
        const group = lens?.closest('[aria-label="Agent 预设"]')
        const material = group?.querySelector('[data-preset-material]')
        const button = group?.querySelector('button[aria-pressed="true"]')
        const canvas = group?.closest('[aria-label="空会话"]')?.querySelector('canvas[data-pixel-workshop="true"]')
        if (!lens || !material || !button || !canvas) return { ok: false, missing: true }
        const lensDisplay = getComputedStyle(lens).display
        const materialFilter = getComputedStyle(material).filter
        const outlineStyle = getComputedStyle(button).outlineStyle
        const canvasDisplay = getComputedStyle(canvas).display
        return {
          ok: lensDisplay === 'none' && materialFilter === 'none' && outlineStyle === 'solid' && canvasDisplay === 'none',
          lensDisplay, materialFilter, outlineStyle, canvasDisplay,
        }
      })()`,
      condition: 'state.ok === true',
      timeoutMs: 1_500,
    })
    if (!fallback.ok) {
      throw new Error(`预设栏或像素工坊背景在强制色彩模式下未正确降级：${JSON.stringify(fallback)}`)
    }
  } finally {
    await emulateVerificationMedia(win)
  }
}

/** 验证当前可见空会话的像素工坊背景、引导内容、预设栏和输入区的布局边界。 */
export async function verifyEmptyConversationLayout(win: BrowserWindow): Promise<void> {
  const bounds = win.getBounds()
  try {
    /* oxlint-disable no-await-in-loop -- 同一窗口按顺序检查默认与放大尺寸。 */
    for (const width of [1280, 1800]) {
      win.setSize(width, width === 1280 ? 800 : 1000)
      await waitForViewportSettled(win)
      await pollRenderer<boolean>(win, {
        probe: `(() => {
          const stage = [...document.querySelectorAll('[aria-label="空会话"]')].find(el => el instanceof HTMLElement && el.checkVisibility())
          const workshop = stage?.querySelector('canvas[data-pixel-workshop="true"]')
          return Boolean(stage && workshop instanceof HTMLCanvasElement && workshop.width > 0 && workshop.height > 0 && stage.querySelector('[aria-label="Agent 预设"] button'))
        })()`,
        condition: 'state === true',
      })
      const result = (await win.webContents.executeJavaScript(
        EMPTY_CONVERSATION_LAYOUT_SCRIPT,
      )) as Record<string, boolean>
      console.log('desktop-shell-verify-local: empty-conversation', { width, ...result })
      if (Object.values(result).some(value => !value))
        throw new Error('空会话布局验收失败：' + JSON.stringify({ width, ...result }))
    }
    /* oxlint-enable no-await-in-loop */
    await verifyPresetMotion(win)
  } finally {
    win.setBounds(bounds)
    await waitForViewportSettled(win)
  }
}
