/**
 * 空会话像素工坊动态背景画布：在 renderer 以整数像素对齐渲染稀疏多帧像素网格，
 * 响应鼠标滑过点亮、空白轻点方形像素涟漪、窗口缩放与主题明暗/强调色切换；
 * 卸载或不可见时自动暂停动画并彻底清理观察器与事件监听。
 */
import { useEffect, useRef } from 'react'
import styles from './EmptyConversation.module.css'
import {
  buildPixelWorkshopGrid,
  resolveWorkshopPalette,
  type WorkshopCell,
  type WorkshopGridLayout,
  type WorkshopPalette,
} from './pixel-workshop-sprites.ts'

interface RippleWave {
  readonly x: number
  readonly y: number
  readonly startTime: number
}

interface WorkshopRenderState {
  layout: WorkshopGridLayout
  palette: WorkshopPalette
  hoveredKey: string | null
  hoveredSlot: { col: number; row: number } | null
  glowByKey: Map<string, number>
  ripples: RippleWave[]
  dpr: number
  lastFrameTime: number
}

const RIPPLE_DURATION_MS = 750
const INTERACTIVE_SELECTOR = 'button, a, input, textarea, select, [role="button"], [role="menu"]'

function readCurrentTheme(): { readonly accent: string; readonly isDark: boolean } {
  const root = document.documentElement
  const computed = getComputedStyle(root)
  const accent = computed.getPropertyValue('--accent').trim() || '#5e7cff'
  const explicit = root.dataset.colorScheme ?? root.dataset.theme
  if (explicit === 'light') return { accent, isDark: false }
  if (explicit === 'dark') return { accent, isDark: true }
  const prefersDark =
    typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)').matches : true
  return { accent, isDark: prefersDark }
}

function findHitCell(
  layout: WorkshopGridLayout,
  x: number,
  y: number,
): { readonly cell: WorkshopCell | null; readonly slot: { col: number; row: number } | null } {
  for (const cell of layout.cells) {
    if (x >= cell.x && x < cell.x + cell.size && y >= cell.y && y < cell.y + cell.size) {
      return { cell, slot: { col: cell.col, row: cell.row } }
    }
  }
  const col = Math.floor((x - layout.originX) / layout.cellSize)
  const row = Math.floor((y - layout.originY) / layout.cellSize)
  if (col >= 0 && col < layout.cols && row >= 0 && row < layout.rows) {
    return { cell: null, slot: { col, row } }
  }
  return { cell: null, slot: null }
}

function isOrthogonalNeighbor(
  cell: WorkshopCell,
  hovered: { readonly col: number; readonly row: number },
): boolean {
  const colMin = cell.col
  const colMax = cell.col + cell.span - 1
  const rowMin = cell.row
  const rowMax = cell.row + cell.span - 1
  const dc = Math.max(0, colMin - hovered.col, hovered.col - colMax)
  const dr = Math.max(0, rowMin - hovered.row, hovered.row - rowMax)
  return dc + dr === 1
}

function drawGridLines(
  ctx: CanvasRenderingContext2D,
  layout: WorkshopGridLayout,
  palette: WorkshopPalette,
): void {
  const { width, height, cellSize, originX, originY } = layout
  ctx.strokeStyle = palette.gridLine
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let x = originX % cellSize; x <= width; x += cellSize) {
    const crisp = Math.floor(x) + 0.5
    ctx.moveTo(crisp, 0)
    ctx.lineTo(crisp, height)
  }
  for (let y = originY % cellSize; y <= height; y += cellSize) {
    const crisp = Math.floor(y) + 0.5
    ctx.moveTo(0, crisp)
    ctx.lineTo(width, crisp)
  }
  ctx.stroke()
}

function drawHoverFrame(
  ctx: CanvasRenderingContext2D,
  rect: { readonly x: number; readonly y: number; readonly size: number },
  palette: WorkshopPalette,
  intensity: number,
): void {
  if (intensity <= 0.01) return
  ctx.save()
  ctx.globalAlpha = intensity
  ctx.fillStyle = palette.hoverFill
  ctx.fillRect(rect.x + 1, rect.y + 1, rect.size - 2, rect.size - 2)
  ctx.strokeStyle = palette.gridLineActive
  ctx.lineWidth = 1
  ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.size - 1, rect.size - 1)
  ctx.fillStyle = palette.hoverCorner
  const corner = 2
  const inset = 4
  ctx.fillRect(rect.x + inset, rect.y + inset, corner, corner)
  ctx.fillRect(rect.x + rect.size - inset - corner, rect.y + inset, corner, corner)
  ctx.fillRect(rect.x + inset, rect.y + rect.size - inset - corner, corner, corner)
  ctx.fillRect(
    rect.x + rect.size - inset - corner,
    rect.y + rect.size - inset - corner,
    corner,
    corner,
  )
  ctx.restore()
}

function resolveSpriteAlpha(palette: WorkshopPalette, multicolor: boolean, glow: number): number {
  let restAlpha = palette.restAlpha
  if (multicolor) {
    restAlpha = palette.isDark
      ? Math.min(0.54, palette.restAlpha * 1.28)
      : Math.min(0.64, palette.restAlpha * 1.24)
  }
  const hoverAlpha = multicolor ? 0.94 : palette.hoverAlpha
  return restAlpha + (hoverAlpha - restAlpha) * glow
}

function resolvePixelColor(
  code: string,
  colorTable: Readonly<Record<string, string>> | undefined,
  tone: { readonly primary: string; readonly secondary: string; readonly soft: string },
): string {
  const mapped = colorTable?.[code]
  if (mapped !== undefined) return mapped
  if (code === '1') return tone.primary
  if (code === '2') return tone.secondary
  return tone.soft
}

function drawSpriteCell(
  ctx: CanvasRenderingContext2D,
  cell: WorkshopCell,
  palette: WorkshopPalette,
  options: { readonly now: number; readonly glow: number; readonly reducedMotion: boolean },
): void {
  const { sprite, pixelSize } = cell
  const frameIndex = options.reducedMotion
    ? 0
    : Math.floor((options.now + cell.phaseOffsetMs) / cell.frameDurationMs) % sprite.frames.length
  const frame = sprite.frames[frameIndex]!
  const tone = palette.tones[cell.toneIndex % palette.tones.length]!
  const colorTable = sprite.colorMap?.[palette.isDark ? 'dark' : 'light']
  const multicolor = colorTable !== undefined
  const spriteW = sprite.width * pixelSize
  const spriteH = sprite.height * pixelSize
  const floatOffset = options.glow > 0.2 && !options.reducedMotion ? -Math.round(options.glow) : 0
  const startX = Math.round(cell.x + (cell.size - spriteW) / 2)
  const startY = Math.round(cell.y + (cell.size - spriteH) / 2) + floatOffset

  ctx.save()
  ctx.globalAlpha = resolveSpriteAlpha(palette, multicolor, options.glow)
  if (options.glow > 0.25 && !options.reducedMotion) {
    ctx.shadowColor = sprite.hoverGlow?.[palette.isDark ? 'dark' : 'light'] ?? tone.primary
    ctx.shadowBlur = Math.round((multicolor ? 10 : 8) * options.glow)
  }
  for (let row = 0; row < frame.length; row += 1) {
    const line = frame[row]!
    for (let col = 0; col < line.length; col += 1) {
      const code = line[col]
      if (code === '.' || code === undefined) continue
      ctx.fillStyle = resolvePixelColor(code, colorTable, tone)
      ctx.fillRect(startX + col * pixelSize, startY + row * pixelSize, pixelSize, pixelSize)
    }
  }
  ctx.restore()
}

function drawRipples(
  ctx: CanvasRenderingContext2D,
  ripples: RippleWave[],
  palette: WorkshopPalette,
  now: number,
): void {
  ctx.save()
  ctx.strokeStyle = palette.rippleStroke
  ctx.lineWidth = 1.5
  for (let index = ripples.length - 1; index >= 0; index -= 1) {
    const wave = ripples[index]!
    const progress = (now - wave.startTime) / RIPPLE_DURATION_MS
    if (progress >= 1) {
      ripples.splice(index, 1)
      continue
    }
    const eased = 1 - (1 - progress) ** 3
    const half = Math.round(14 + eased * 108)
    const size = half * 2
    ctx.globalAlpha = (1 - progress) * 0.85
    ctx.strokeRect(Math.round(wave.x) - half + 0.5, Math.round(wave.y) - half + 0.5, size, size)
  }
  ctx.restore()
}

function applySoftMask(ctx: CanvasRenderingContext2D, layout: WorkshopGridLayout): void {
  const { width, height, focalX, focalY, focalRx, focalRy } = layout
  ctx.save()
  ctx.globalCompositeOperation = 'destination-out'

  // 中央标题与预设滑块背后柔和淡出网格线，保障阅读清晰度。
  const maxRadius = Math.max(focalRx, focalRy) * 0.68
  const centerGrad = ctx.createRadialGradient(focalX, focalY, 8, focalX, focalY, maxRadius)
  centerGrad.addColorStop(0, 'rgb(0 0 0 / 0.86)')
  centerGrad.addColorStop(0.58, 'rgb(0 0 0 / 0.56)')
  centerGrad.addColorStop(1, 'rgb(0 0 0 / 0)')
  ctx.fillStyle = centerGrad
  ctx.fillRect(0, 0, width, height)

  // 底部输入框上方平滑渐隐，避免像素网格在底栏边缘生硬截断。
  const bottomFade = ctx.createLinearGradient(0, Math.max(0, height - 150), 0, height)
  bottomFade.addColorStop(0, 'rgb(0 0 0 / 0)')
  bottomFade.addColorStop(1, 'rgb(0 0 0 / 0.92)')
  ctx.fillStyle = bottomFade
  ctx.fillRect(0, Math.max(0, height - 150), width, 150)

  ctx.restore()
}

function renderWorkshopFrame(
  ctx: CanvasRenderingContext2D,
  state: WorkshopRenderState,
  now: number,
  reducedMotion: boolean,
): void {
  const { layout, palette } = state
  if (layout.width <= 0 || layout.height <= 0) return
  const dt =
    state.lastFrameTime === 0
      ? 1 / 60
      : Math.min(0.05, Math.max(0.001, (now - state.lastFrameTime) / 1000))
  state.lastFrameTime = now
  const easeStep = reducedMotion ? 1 : 1 - Math.exp(-14 * dt)
  const neighborTarget =
    (palette.neighborAlpha - palette.restAlpha) /
    Math.max(0.01, palette.hoverAlpha - palette.restAlpha)

  ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0)
  ctx.clearRect(0, 0, layout.width, layout.height)
  drawGridLines(ctx, layout, palette)

  let hoveredCellRect: { readonly x: number; readonly y: number; readonly size: number } | null =
    null
  let hoveredCellGlow = 0

  for (const cell of layout.cells) {
    let target = 0
    if (state.hoveredKey === cell.key) target = 1
    else if (state.hoveredSlot !== null && isOrthogonalNeighbor(cell, state.hoveredSlot)) {
      target = neighborTarget
    }
    const previous = state.glowByKey.get(cell.key) ?? 0
    const next = previous + (target - previous) * easeStep
    if (next > 0.004) state.glowByKey.set(cell.key, next)
    else state.glowByKey.delete(cell.key)
    if (state.hoveredKey === cell.key) {
      hoveredCellRect = { x: cell.x, y: cell.y, size: cell.size }
      hoveredCellGlow = next
    }
  }

  if (hoveredCellRect !== null) {
    drawHoverFrame(ctx, hoveredCellRect, palette, hoveredCellGlow)
  } else if (state.hoveredSlot !== null && state.hoveredKey === null) {
    drawHoverFrame(
      ctx,
      {
        x: layout.originX + state.hoveredSlot.col * layout.cellSize,
        y: layout.originY + state.hoveredSlot.row * layout.cellSize,
        size: layout.cellSize,
      },
      palette,
      0.55,
    )
  }

  for (const cell of layout.cells) {
    drawSpriteCell(ctx, cell, palette, {
      now,
      glow: state.glowByKey.get(cell.key) ?? 0,
      reducedMotion,
    })
  }
  if (!reducedMotion && state.ripples.length > 0) {
    drawRipples(ctx, state.ripples, palette, now)
  }
  applySoftMask(ctx, layout)
}

function observeThemeChanges(onChange: () => void): () => void {
  const darkQuery =
    typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null
  const mutationObserver = new MutationObserver(onChange)
  mutationObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style', 'class', 'data-theme', 'data-color-scheme'],
  })
  darkQuery?.addEventListener('change', onChange)
  return () => {
    mutationObserver.disconnect()
    darkQuery?.removeEventListener('change', onChange)
  }
}

/** 渲染铺满空会话容器底层的像素工坊微动背景画布。 */
export function PixelWorkshopBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const host = canvas?.parentElement
    if (!canvas || !host) return

    const initialTheme = readCurrentTheme()
    const initialPalette = resolveWorkshopPalette(initialTheme.accent, initialTheme.isDark)
    canvas.dataset.accent = initialPalette.accent

    const ctx = canvas.getContext('2d')
    if (ctx === null) {
      return observeThemeChanges(() => {
        const theme = readCurrentTheme()
        canvas.dataset.accent = resolveWorkshopPalette(theme.accent, theme.isDark).accent
      })
    }

    const reducedQuery =
      typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null
    const state: WorkshopRenderState = {
      layout: buildPixelWorkshopGrid(host.clientWidth, host.clientHeight),
      palette: initialPalette,
      hoveredKey: null,
      hoveredSlot: null,
      glowByKey: new Map(),
      ripples: [],
      dpr: Math.min(2, window.devicePixelRatio || 1),
      lastFrameTime: 0,
    }

    let rafId = 0
    let visible = true

    const syncCanvasSize = () => {
      const width = host.clientWidth
      const height = host.clientHeight
      state.dpr = Math.min(2, window.devicePixelRatio || 1)
      canvas.width = Math.max(1, Math.round(width * state.dpr))
      canvas.height = Math.max(1, Math.round(height * state.dpr))
      state.layout = buildPixelWorkshopGrid(width, height)
      state.glowByKey.clear()
    }

    const stopLoop = () => {
      if (rafId !== 0) {
        cancelAnimationFrame(rafId)
        rafId = 0
      }
      state.lastFrameTime = 0
    }

    const drawStatic = () => {
      renderWorkshopFrame(ctx, state, performance.now(), reducedQuery?.matches === true)
    }

    const tick = (now: number) => {
      rafId = 0
      if (!visible || document.hidden || reducedQuery?.matches === true) return
      renderWorkshopFrame(ctx, state, now, false)
      rafId = requestAnimationFrame(tick)
    }

    const refreshLoop = () => {
      if (!visible || document.hidden) {
        stopLoop()
        return
      }
      if (reducedQuery?.matches === true) {
        stopLoop()
        drawStatic()
        return
      }
      if (rafId === 0) rafId = requestAnimationFrame(tick)
    }

    const refreshTheme = () => {
      const theme = readCurrentTheme()
      state.palette = resolveWorkshopPalette(theme.accent, theme.isDark)
      canvas.dataset.accent = state.palette.accent
      if (reducedQuery?.matches === true) drawStatic()
      else if (visible && !document.hidden)
        renderWorkshopFrame(ctx, state, performance.now(), false)
    }

    const onPointerMove = (event: PointerEvent) => {
      const rect = host.getBoundingClientRect()
      const hit = findHitCell(state.layout, event.clientX - rect.left, event.clientY - rect.top)
      state.hoveredKey = hit.cell?.key ?? null
      state.hoveredSlot = hit.slot
      if (reducedQuery?.matches === true) drawStatic()
    }

    const onPointerLeave = () => {
      state.hoveredKey = null
      state.hoveredSlot = null
      if (reducedQuery?.matches === true) drawStatic()
    }

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || reducedQuery?.matches === true) return
      if (event.target instanceof Element && event.target.closest(INTERACTIVE_SELECTOR) !== null) {
        return
      }
      const rect = host.getBoundingClientRect()
      state.ripples.push({
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        startTime: performance.now(),
      })
      if (state.ripples.length > 4) state.ripples.shift()
    }

    const resizeObserver =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => {
            syncCanvasSize()
            if (reducedQuery?.matches === true) drawStatic()
            else refreshLoop()
          })
        : null
    resizeObserver?.observe(host)

    const intersectionObserver =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver(entries => {
            visible = entries.some(entry => entry.isIntersecting)
            refreshLoop()
          })
        : null
    intersectionObserver?.observe(canvas)

    const stopThemeObserver = observeThemeChanges(refreshTheme)

    host.addEventListener('pointermove', onPointerMove)
    host.addEventListener('pointerleave', onPointerLeave)
    host.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('visibilitychange', refreshLoop)
    reducedQuery?.addEventListener('change', refreshLoop)

    syncCanvasSize()
    refreshLoop()

    return () => {
      stopLoop()
      resizeObserver?.disconnect()
      intersectionObserver?.disconnect()
      stopThemeObserver()
      host.removeEventListener('pointermove', onPointerMove)
      host.removeEventListener('pointerleave', onPointerLeave)
      host.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('visibilitychange', refreshLoop)
      reducedQuery?.removeEventListener('change', refreshLoop)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className={styles.workshopCanvas}
      data-pixel-workshop="true"
      aria-hidden="true"
    />
  )
}
