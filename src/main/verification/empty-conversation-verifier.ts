/** 主进程检查隔离窗口中的空会话，避免预设栏撑破浮岛或遮挡输入区。 */
import type { BrowserWindow } from 'electron'
import { emulateVerificationMedia } from './desktop-verifier.ts'

async function verifyPresetMotion(win: BrowserWindow): Promise<void> {
  const result = await win.webContents.executeJavaScript(`(async () => {
    const group = [...document.querySelectorAll('[aria-label="Agent 预设"]')]
      .find(element => element.querySelector('[data-preset-lens]') && element.checkVisibility())
    const initial = group?.querySelector('button[aria-pressed="true"]')
    const unselected = [
      ...(group?.querySelectorAll(
        'button[aria-pressed="false"]:not(:disabled):not([aria-haspopup])',
      ) ?? []),
    ]
    const next = unselected[0]
    const third = unselected[1]
    const more = group?.querySelector('button[aria-haspopup="menu"]')
    const lens = group?.querySelector('[data-preset-lens]')
    const material = group?.querySelector('[data-preset-material]')
    const buttons = group?.querySelectorAll('button') ?? []
    const validButtons = more ? buttons.length === 5 : buttons.length === 3 && Boolean(third)
    if (
      !initial ||
      !next ||
      !lens ||
      !material ||
      lens.hidden ||
      !validButtons ||
      !getComputedStyle(material).filter.includes('liquid-glass-web-react')
    )
      return false
    const center = element => {
      const rect = element.getBoundingClientRect()
      return rect.left + rect.width / 2
    }
    const move = async (button, trigger = button) => {
      const start = center(lens)
      const available = [...group.querySelectorAll('button:not(:disabled)')]
      let intermediate = false
      trigger.click()
      const deadline = performance.now() + 5000
      while (performance.now() < deadline) {
        await new Promise(resolve => requestAnimationFrame(resolve))
        if (available.some(item => item.disabled || getComputedStyle(item).opacity !== '1')) return false
        const current = center(lens)
        if (button.getAttribute('aria-pressed') !== 'true') continue
        const end = center(button)
        intermediate ||= Math.abs(current - start) > 2 && Math.abs(current - end) > 2
        if (Math.abs(current - end) < 0.2 &&
            Math.abs(lens.getBoundingClientRect().width - button.getBoundingClientRect().width) < 0.2 &&
            group.getAttribute('aria-busy') === 'false') return intermediate
      }
      return false
    }
    const switched = await move(next)
    let secondSwitched = false
    if (more) {
      more.click()
      await new Promise(resolve => requestAnimationFrame(resolve))
      const menu = document.getElementById(more.getAttribute('aria-controls'))
      const hidden = menu?.querySelector('button:not(:disabled)')
      secondSwitched = hidden ? await move(more, hidden) : false
    } else if (third) {
      secondSwitched = await move(third)
    }
    const restored = await move(initial)
    return switched && secondSwitched && restored
  })()`)
  if (!result) throw new Error('预设透镜未随切换连续滑动，或未对齐选中项')
  await verifyPresetForcedColorsFallback(win)
}

async function verifyPresetForcedColorsFallback(win: BrowserWindow): Promise<void> {
  try {
    await emulateVerificationMedia(win, [
      { name: 'prefers-reduced-motion', value: 'reduce' },
      { name: 'prefers-reduced-transparency', value: 'reduce' },
      { name: 'forced-colors', value: 'active' },
    ])
    const fallback = await win.webContents.executeJavaScript(`(() => {
      const lens = [...document.querySelectorAll('[data-preset-lens]')]
        .find(element => element.closest('[aria-label="Agent 预设"]')?.checkVisibility())
      const group = lens?.closest('[aria-label="Agent 预设"]')
      const material = group?.querySelector('[data-preset-material]')
      const button = group?.querySelector('button[aria-pressed="true"]')
      const canvas = group?.closest('[aria-label="空会话"]')?.querySelector('canvas[data-pixel-workshop="true"]')
      return Boolean(lens && material && button && canvas && getComputedStyle(lens).display === 'none' &&
        getComputedStyle(material).filter === 'none' && getComputedStyle(button).outlineStyle === 'solid' &&
        getComputedStyle(canvas).display === 'none')
    })()`)
    if (!fallback) throw new Error('预设栏或像素工坊背景在强制色彩模式下未正确降级')
  } finally {
    await emulateVerificationMedia(win)
  }
}

/** 验证当前可见空会话的像素工坊背景、引导内容、预设栏和输入区的布局边界。 */
export async function verifyEmptyConversationLayout(win: BrowserWindow): Promise<void> {
  const script = `(async () => {
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
    try {
      for (const color of colors) {
        root.style.setProperty('--accent', color)
        await new Promise(resolve => requestAnimationFrame(resolve))
        accents.push(workshop.dataset.accent ?? '')
      }
    } finally {
      if (previousAccent) root.style.setProperty('--accent', previousAccent)
      else root.style.removeProperty('--accent')
      await new Promise(resolve => requestAnimationFrame(resolve))
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
  const bounds = win.getBounds()
  try {
    /* oxlint-disable no-await-in-loop -- 同一窗口按顺序检查默认与放大尺寸。 */
    for (const width of [1280, 1800]) {
      win.setSize(width, width === 1280 ? 800 : 1000)
      await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 250))')
      const result = (await win.webContents.executeJavaScript(script)) as Record<string, boolean>
      console.log('desktop-shell-verify-local: empty-conversation', { width, ...result })
      if (Object.values(result).some(value => !value))
        throw new Error('空会话布局验收失败：' + JSON.stringify({ width, ...result }))
    }
    /* oxlint-enable no-await-in-loop */
    await verifyPresetMotion(win)
  } finally {
    win.setBounds(bounds)
    await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 250))')
  }
}
