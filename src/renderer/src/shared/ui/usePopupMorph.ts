/**
 * 锚点菜单液态形变控制器：在真实 DOM / SVG 中驱动 FlClash 风格展开与液滴回吸动画。
 * 运行在 renderer；持有 requestAnimationFrame 与 Web Animation 句柄，并在关闭或卸载时清理。
 */
import { useLayoutEffect, useRef, type RefObject } from 'react'

import { prefersReducedMotion } from './elasticPressSession.ts'
import {
  computeClosingMorphFrame,
  computeOpeningMorphFrame,
  POPUP_DISMISS_DURATION_S,
  POPUP_OPEN_DURATION_S,
  roundedRectSvgPath,
  type MorphRect,
  type PopupMorphFrame,
  type PopupMorphSnapshot,
} from './popupMorphMath.ts'

/** 启用液态弹出形变所需的引用与生命周期回调。 */
export interface UsePopupMorphOptions {
  /** 是否启用液态形变（`false` 时保持原 CSS 折叠动画）。 */
  readonly enabled: boolean
  /** 菜单当前是否处于逻辑打开态。 */
  readonly open: boolean
  /** 菜单是否已完成锚点测距并进入可见状态。 */
  readonly ready: boolean
  /** 触发菜单的锚点按钮元素引用。 */
  readonly anchorRef: RefObject<HTMLElement | null>
  /** 菜单外层容器引用。 */
  readonly menuRef: RefObject<HTMLElement | null>
  /** 独立于菜单裁切范围之外的液态轮廓 SVG 容器引用。 */
  readonly surfaceRef: RefObject<SVGSVGElement | null>
  /** 绘制液态融合托盘与液滴轮廓的 SVG `<path>` 引用。 */
  readonly pathRef: RefObject<SVGPathElement | null>
  /** 抠空触发按钮区域的 SVG `<mask>` 唯一标识；未传入时由控制器按容器懒创建。 */
  readonly maskId?: string | undefined
  /** SVG `<mask>` 元素引用。 */
  readonly maskRef?: RefObject<SVGMaskElement | null> | undefined
  /** `<mask>` 内白色可见底板 `<rect>` 引用。 */
  readonly maskBackdropRef?: RefObject<SVGRectElement | null> | undefined
  /** `<mask>` 内黑色触发按钮抠空 `<rect>` 引用。 */
  readonly maskCutoutRef?: RefObject<SVGRectElement | null> | undefined
  /** 收回动画完全结束后的卸载回调。 */
  readonly onDismissComplete: () => void
}

interface MorphGeometry {
  readonly left: number
  readonly top: number
  readonly zIndex: string | null
  readonly fill: string | null
  readonly anchor: MorphRect
  readonly anchorRadius: number
  readonly card: MorphRect
  readonly cardRadius: number
}

interface MorphRuntime {
  frame: number | null
  animation: Animation | null
  phase: 'idle' | 'opening' | 'open' | 'closing'
  snapshot: PopupMorphSnapshot | null
  geometry: MorphGeometry | null
}

interface MorphMaskElements {
  readonly id: string
  readonly mask: SVGMaskElement
  readonly backdrop: SVGRectElement
  readonly cutout: SVGRectElement
}

interface MorphMaskRefs {
  readonly maskId?: string | undefined
  readonly maskRef?: RefObject<SVGMaskElement | null> | undefined
  readonly maskBackdropRef?: RefObject<SVGRectElement | null> | undefined
  readonly maskCutoutRef?: RefObject<SVGRectElement | null> | undefined
}

interface MorphNodes {
  readonly menu: HTMLElement
  readonly surface: SVGSVGElement
  readonly path: SVGPathElement
  readonly mask: MorphMaskElements | null
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const DEFAULT_CARD_RADIUS = 10
const OPEN_OPACITY_MS = 190
const MAX_FRAME_DELTA_S = 1 / 24
const FIRST_FRAME_DELTA_S = 1 / 60
const INITIAL_OPEN_TIME_S = 0.016
// 预留足以覆盖 32px drop-shadow 扩散、弹簧过冲与液桥的画布边界，防止 userSpaceOnUse 遮罩裁切投影。
const MASK_BLEED_PX = 160

let autoMaskCounter = 0

function fmtCoord(value: number): string {
  return String(Math.round(value * 100) / 100)
}

function parseCssDurationMs(raw: string): number | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (trimmed.endsWith('ms')) {
    const value = Number.parseFloat(trimmed.slice(0, -2))
    return Number.isFinite(value) && value > 0 ? value : null
  }
  if (trimmed.endsWith('s')) {
    const value = Number.parseFloat(trimmed.slice(0, -1))
    return Number.isFinite(value) && value > 0 ? value * 1000 : null
  }
  return null
}

function parseRadiusValue(raw: string | undefined, rect: MorphRect): number | null {
  const trimmed = raw?.trim() ?? ''
  if (!trimmed) return null
  const firstToken = trimmed.split(/[\s/]+/u)[0] ?? ''
  const parsed = firstToken.endsWith('%')
    ? Math.min(rect.width, rect.height) * (Number.parseFloat(firstToken) / 100)
    : Number.parseFloat(firstToken)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  const maxRadius = Math.max(0, Math.min(rect.width / 2, rect.height / 2))
  return Math.min(parsed, maxRadius)
}

function resolveBorderRadius(
  computed: CSSStyleDeclaration | null,
  rect: MorphRect,
  fallback: number,
): number {
  const maxRadius = Math.max(0, Math.min(rect.width / 2, rect.height / 2))
  // 真实浏览器会把 border-radius 展开到 borderTopLeftRadius；jsdom 可能仅填充 borderRadius 并将分项保留为 0px。
  const topLeft = parseRadiusValue(computed?.borderTopLeftRadius, rect)
  if (topLeft !== null && topLeft > 0) return topLeft
  const shorthand = parseRadiusValue(computed?.borderRadius, rect)
  if (shorthand !== null && shorthand > 0) return shorthand
  return topLeft ?? shorthand ?? Math.min(fallback, maxRadius)
}

function resolveMaskElements(
  surface: SVGSVGElement,
  refs: MorphMaskRefs,
): MorphMaskElements | null {
  const declarativeMask = refs.maskRef?.current ?? null
  const declarativeBackdrop = refs.maskBackdropRef?.current ?? null
  const declarativeCutout = refs.maskCutoutRef?.current ?? null
  if (
    refs.maskId &&
    declarativeMask !== null &&
    declarativeBackdrop !== null &&
    declarativeCutout !== null
  ) {
    return {
      id: refs.maskId,
      mask: declarativeMask,
      backdrop: declarativeBackdrop,
      cutout: declarativeCutout,
    }
  }
  const existingMask = surface.querySelector<SVGMaskElement>('mask[data-morph-anchor-mask="true"]')
  if (existingMask !== null) {
    const backdrop = existingMask.querySelector<SVGRectElement>(
      'rect[data-morph-mask-backdrop="true"]',
    )
    const cutout = existingMask.querySelector<SVGRectElement>('rect[data-morph-mask-cutout="true"]')
    if (existingMask.id && backdrop !== null && cutout !== null) {
      return { id: existingMask.id, mask: existingMask, backdrop, cutout }
    }
  }
  if (typeof document === 'undefined') return null
  autoMaskCounter += 1
  const id = `morph-anchor-mask-auto-${String(autoMaskCounter)}`
  const defs = document.createElementNS(SVG_NS, 'defs')
  const mask = document.createElementNS(SVG_NS, 'mask')
  mask.setAttribute('id', id)
  mask.setAttribute('data-morph-anchor-mask', 'true')
  mask.setAttribute('maskUnits', 'userSpaceOnUse')
  mask.setAttribute('maskContentUnits', 'userSpaceOnUse')
  const backdrop = document.createElementNS(SVG_NS, 'rect')
  backdrop.setAttribute('data-morph-mask-backdrop', 'true')
  backdrop.setAttribute('fill', 'white')
  const cutout = document.createElementNS(SVG_NS, 'rect')
  cutout.setAttribute('data-morph-mask-cutout', 'true')
  cutout.setAttribute('fill', 'black')
  mask.append(backdrop, cutout)
  defs.append(mask)
  surface.prepend(defs)
  return { id, mask, backdrop, cutout }
}

function syncAnchorMask(maskElements: MorphMaskElements, geometry: MorphGeometry): void {
  const { mask, backdrop, cutout } = maskElements
  const minX = Math.min(0, geometry.anchor.left) - MASK_BLEED_PX
  const minY = Math.min(0, geometry.anchor.top) - MASK_BLEED_PX
  const maxX =
    Math.max(geometry.card.width, geometry.anchor.left + geometry.anchor.width) + MASK_BLEED_PX
  const maxY =
    Math.max(geometry.card.height, geometry.anchor.top + geometry.anchor.height) + MASK_BLEED_PX
  const width = maxX - minX
  const height = maxY - minY

  mask.setAttribute('maskUnits', 'userSpaceOnUse')
  mask.setAttribute('maskContentUnits', 'userSpaceOnUse')
  mask.setAttribute('x', fmtCoord(minX))
  mask.setAttribute('y', fmtCoord(minY))
  mask.setAttribute('width', fmtCoord(width))
  mask.setAttribute('height', fmtCoord(height))

  backdrop.setAttribute('x', fmtCoord(minX))
  backdrop.setAttribute('y', fmtCoord(minY))
  backdrop.setAttribute('width', fmtCoord(width))
  backdrop.setAttribute('height', fmtCoord(height))

  cutout.setAttribute('x', fmtCoord(geometry.anchor.left))
  cutout.setAttribute('y', fmtCoord(geometry.anchor.top))
  cutout.setAttribute('width', fmtCoord(geometry.anchor.width))
  cutout.setAttribute('height', fmtCoord(geometry.anchor.height))
  cutout.setAttribute('rx', fmtCoord(geometry.anchorRadius))
  cutout.setAttribute('ry', fmtCoord(geometry.anchorRadius))
}

function clearAnchorMask(maskElements: MorphMaskElements | null): void {
  if (maskElements === null) return
  const { mask, backdrop, cutout } = maskElements
  for (const attr of ['x', 'y', 'width', 'height']) {
    mask.removeAttribute(attr)
    backdrop.removeAttribute(attr)
    cutout.removeAttribute(attr)
  }
  cutout.removeAttribute('rx')
  cutout.removeAttribute('ry')
}

function measureMorphGeometry(
  anchor: HTMLElement,
  menu: HTMLElement,
  previous: MorphGeometry | null = null,
): MorphGeometry | null {
  const menuRect = menu.getBoundingClientRect()
  const anchorRect = anchor.getBoundingClientRect()
  if (
    menuRect.width <= 0 ||
    menuRect.height <= 0 ||
    anchorRect.width <= 0 ||
    anchorRect.height <= 0
  )
    return null
  const width = anchor.offsetWidth > 0 ? anchor.offsetWidth : Math.max(16, anchorRect.width)
  const height = anchor.offsetHeight > 0 ? anchor.offsetHeight : Math.max(16, anchorRect.height)
  const centerX = anchorRect.left + anchorRect.width / 2 - menuRect.left
  const centerY = anchorRect.top + anchorRect.height / 2 - menuRect.top
  const anchorBox: MorphRect = {
    left: centerX - width / 2,
    top: centerY - height / 2,
    width,
    height,
  }
  const cardBox: MorphRect = { left: 0, top: 0, width: menuRect.width, height: menuRect.height }
  const canReadStyle = typeof window.getComputedStyle === 'function'
  const menuStyle = canReadStyle ? window.getComputedStyle(menu) : null
  const anchorStyle = canReadStyle ? window.getComputedStyle(anchor) : null
  const parsedCardRadius = menuStyle
    ? Number.parseFloat(menuStyle.borderTopLeftRadius)
    : DEFAULT_CARD_RADIUS
  const zIndex =
    menuStyle && menuStyle.zIndex !== '' && menuStyle.zIndex !== 'auto' ? menuStyle.zIndex : null
  const bg = menuStyle?.backgroundColor
  const fill =
    bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)' ? bg : (previous?.fill ?? null)
  return {
    left: menuRect.left,
    top: menuRect.top,
    zIndex,
    fill,
    anchor: anchorBox,
    anchorRadius: resolveBorderRadius(anchorStyle, anchorBox, 0),
    card: cardBox,
    cardRadius:
      Number.isFinite(parsedCardRadius) && parsedCardRadius > 0
        ? parsedCardRadius
        : DEFAULT_CARD_RADIUS,
  }
}

function syncSurfaceBox(surface: SVGSVGElement, geometry: MorphGeometry): void {
  surface.style.left = `${geometry.left}px`
  surface.style.top = `${geometry.top}px`
  surface.style.width = `${geometry.card.width}px`
  surface.style.height = `${geometry.card.height}px`
  // 让 SVG 融合层跟随弹层自身层级与背景色，保证多处弹层文字不被盖住且收尾无色差。
  if (geometry.zIndex !== null) surface.style.zIndex = geometry.zIndex
  else surface.style.removeProperty('z-index')
  if (geometry.fill !== null) surface.style.setProperty('--morph-fill', geometry.fill)
  else surface.style.removeProperty('--morph-fill')
}

function paintMorphFrame(nodes: MorphNodes, frame: PopupMorphFrame, geometry: MorphGeometry): void {
  const { menu, surface, path, mask } = nodes
  menu.dataset.menuMorph = 'active'
  surface.style.display = 'block'
  syncSurfaceBox(surface, geometry)
  if (mask !== null) {
    syncAnchorMask(mask, geometry)
    path.setAttribute('mask', `url(#${mask.id})`)
  }
  path.setAttribute('d', frame.svgPath)
  path.style.opacity = String(frame.surfaceOpacity)
  path.style.setProperty('--morph-stroke-opacity', String(frame.strokeOpacity))

  const clip = roundedRectSvgPath(frame.platter, frame.platterRadius)
  menu.style.clipPath = `path('${clip}')`
  menu.style.filter = frame.contentBlur > 0.15 ? `blur(${frame.contentBlur.toFixed(2)}px)` : 'none'
}

function clearMorphStyles(nodes: MorphNodes, settled: boolean): void {
  const { menu, surface, path, mask } = nodes
  menu.dataset.menuMorph = settled ? 'settled' : 'active'
  menu.style.removeProperty('clip-path')
  menu.style.removeProperty('filter')
  surface.style.display = 'none'
  path.removeAttribute('d')
  path.removeAttribute('mask')
  path.style.removeProperty('opacity')
  path.style.removeProperty('--morph-stroke-opacity')
  clearAnchorMask(mask)
}

function stopMorphMotion(runtime: MorphRuntime): void {
  if (runtime.frame !== null) {
    window.cancelAnimationFrame(runtime.frame)
    runtime.frame = null
  }
  runtime.animation?.cancel()
  runtime.animation = null
}

function startProxyAnimation(
  menu: HTMLElement,
  keyframes: Keyframe[],
  timing: KeyframeAnimationOptions,
): Animation | null {
  if (typeof menu.animate !== 'function') return null
  return menu.animate(keyframes, timing)
}

function runOpenMorph(nodes: MorphNodes, runtime: MorphRuntime, geometry: MorphGeometry): void {
  stopMorphMotion(runtime)
  runtime.geometry = geometry
  runtime.phase = 'opening'
  runtime.animation = startProxyAnimation(nodes.menu, [{ opacity: 0.05 }, { opacity: 1 }], {
    duration: OPEN_OPACITY_MS,
    easing: 'ease-out',
    fill: 'none',
  })
  // 首帧已在布局期同步绘制到 INITIAL_OPEN_TIME_S，后续 rAF 从此推进避免前两帧停滞。
  let elapsed = INITIAL_OPEN_TIME_S
  let previous: number | null = null
  const stepOpen = (now: number) => {
    runtime.frame = null
    if (!nodes.menu.isConnected) return
    const delta =
      previous === null
        ? FIRST_FRAME_DELTA_S
        : Math.min(MAX_FRAME_DELTA_S, Math.max(0, (now - previous) / 1000))
    previous = now
    elapsed += delta
    const frame = computeOpeningMorphFrame({
      timeSeconds: Math.min(elapsed, POPUP_OPEN_DURATION_S),
      anchor: geometry.anchor,
      card: geometry.card,
      cardRadius: geometry.cardRadius,
    })
    runtime.snapshot = {
      platter: frame.platter,
      platterRadius: frame.platterRadius,
      droplet: frame.droplet,
      progress: frame.progress,
    }
    paintMorphFrame(nodes, frame, geometry)
    if (elapsed < POPUP_OPEN_DURATION_S) {
      runtime.frame = window.requestAnimationFrame(stepOpen)
    } else {
      runtime.phase = 'open'
      runtime.snapshot = null
      clearMorphStyles(nodes, true)
    }
  }
  const initial = computeOpeningMorphFrame({
    timeSeconds: INITIAL_OPEN_TIME_S,
    anchor: geometry.anchor,
    card: geometry.card,
    cardRadius: geometry.cardRadius,
  })
  paintMorphFrame(nodes, initial, geometry)
  runtime.frame = window.requestAnimationFrame(stepOpen)
}

function runCloseMorph(
  nodes: MorphNodes,
  runtime: MorphRuntime,
  geometry: MorphGeometry,
  onComplete: () => void,
): void {
  stopMorphMotion(runtime)
  const customExitMs = parseCssDurationMs(nodes.menu.style.getPropertyValue('--menu-exit'))
  const dismissDurationS = customExitMs !== null ? customExitMs / 1000 : POPUP_DISMISS_DURATION_S
  const startSnapshot = runtime.snapshot
  runtime.phase = 'closing'
  runtime.animation = startProxyAnimation(
    nodes.menu,
    [
      { opacity: 1, offset: 0 },
      { opacity: 0.85, offset: 0.28 },
      { opacity: 0.2, offset: 0.72 },
      { opacity: 0, offset: 1 },
    ],
    {
      duration: dismissDurationS * 1000,
      easing: 'ease-in',
      fill: 'forwards',
    },
  )
  let elapsed = 0
  let previous: number | null = null
  const paintAt = (timeSeconds: number) =>
    paintMorphFrame(
      nodes,
      computeClosingMorphFrame({
        timeSeconds,
        totalDurationSeconds: dismissDurationS,
        start: startSnapshot,
        anchor: geometry.anchor,
        card: geometry.card,
        cardRadius: geometry.cardRadius,
      }),
      geometry,
    )
  const stepClose = (now: number) => {
    runtime.frame = null
    if (!nodes.menu.isConnected) return
    const delta =
      previous === null
        ? FIRST_FRAME_DELTA_S
        : Math.min(MAX_FRAME_DELTA_S, Math.max(0, (now - previous) / 1000))
    previous = now
    elapsed += delta
    paintAt(Math.min(elapsed, dismissDurationS))
    if (elapsed < dismissDurationS) {
      runtime.frame = window.requestAnimationFrame(stepClose)
    } else {
      runtime.phase = 'idle'
      runtime.snapshot = null
      clearMorphStyles(nodes, false)
      onComplete()
    }
  }
  // 布局期立即切换为激活态并套用触发按钮遮罩，避免收回首帧延迟闪动。
  paintAt(0)
  runtime.frame = window.requestAnimationFrame(stepClose)
}

function clearDisabledMorph(
  runtime: MorphRuntime,
  menu: HTMLElement | null,
  surface: SVGSVGElement | null,
  path: SVGPathElement | null,
): void {
  stopMorphMotion(runtime)
  runtime.phase = 'idle'
  runtime.snapshot = null
  runtime.geometry = null
  if (menu !== null) {
    menu.style.removeProperty('clip-path')
    menu.style.removeProperty('filter')
    delete menu.dataset.menuMorph
  }
  if (surface !== null) {
    surface.style.display = 'none'
    const mask = surface.querySelector<SVGMaskElement>('mask[data-morph-anchor-mask="true"]')
    const backdrop = mask?.querySelector<SVGRectElement>('rect[data-morph-mask-backdrop="true"]')
    const cutout = mask?.querySelector<SVGRectElement>('rect[data-morph-mask-cutout="true"]')
    if (mask && backdrop && cutout) {
      clearAnchorMask({ id: mask.id, mask, backdrop, cutout })
    }
  }
  if (path !== null) {
    path.removeAttribute('d')
    path.removeAttribute('mask')
    path.style.removeProperty('opacity')
    path.style.removeProperty('--morph-stroke-opacity')
  }
}

function syncPopupMorphTransition(
  runtime: MorphRuntime,
  options: UsePopupMorphOptions,
  dismissRef: RefObject<() => void>,
): (() => void) | undefined {
  const menu = options.menuRef.current
  const surface = options.surfaceRef.current
  const path = options.pathRef.current
  if (!options.enabled) {
    clearDisabledMorph(runtime, menu, surface, path)
    return undefined
  }
  if (menu === null || surface === null || path === null) return undefined
  const mask = resolveMaskElements(surface, options)
  const nodes: MorphNodes = { menu, surface, path, mask }
  const anchor = options.anchorRef.current
  const geometry =
    anchor !== null && anchor.isConnected
      ? measureMorphGeometry(anchor, menu, runtime.geometry)
      : null

  if (options.open) {
    if (!options.ready) return undefined
    if (prefersReducedMotion() || geometry === null) {
      stopMorphMotion(runtime)
      runtime.phase = 'open'
      runtime.snapshot = null
      clearMorphStyles(nodes, true)
      return undefined
    }
    runOpenMorph(nodes, runtime, geometry)
    return () => stopMorphMotion(runtime)
  }

  if (prefersReducedMotion() || geometry === null || runtime.phase === 'idle') {
    stopMorphMotion(runtime)
    runtime.phase = 'idle'
    runtime.snapshot = null
    clearMorphStyles(nodes, true)
    dismissRef.current()
    return undefined
  }
  runCloseMorph(nodes, runtime, geometry, () => dismissRef.current())
  return () => stopMorphMotion(runtime)
}

/**
 * 在启用 `motion="morph"` 时管理弹出菜单的液态展开、中途打断与液滴回吸动画。
 */
export function usePopupMorph(options: UsePopupMorphOptions): void {
  const {
    enabled,
    open,
    ready,
    anchorRef,
    menuRef,
    surfaceRef,
    pathRef,
    maskId,
    maskRef,
    maskBackdropRef,
    maskCutoutRef,
    onDismissComplete,
  } = options
  const runtimeRef = useRef<MorphRuntime>({
    frame: null,
    animation: null,
    phase: 'idle',
    snapshot: null,
    geometry: null,
  })
  const dismissRef = useRef(onDismissComplete)
  dismissRef.current = onDismissComplete

  useLayoutEffect(
    () =>
      syncPopupMorphTransition(
        runtimeRef.current,
        {
          enabled,
          open,
          ready,
          anchorRef,
          menuRef,
          surfaceRef,
          pathRef,
          maskId,
          maskRef,
          maskBackdropRef,
          maskCutoutRef,
          onDismissComplete: dismissRef.current,
        },
        dismissRef,
      ),
    [
      anchorRef,
      enabled,
      maskBackdropRef,
      maskCutoutRef,
      maskId,
      maskRef,
      menuRef,
      open,
      pathRef,
      ready,
      surfaceRef,
    ],
  )
}
