/**
 * 侧栏弹性选择指示条控制器：追踪容器内当前激活项并在切换时驱动前缘先冲、后缘收缩动画。
 * 运行在 renderer；持有 ResizeObserver 与 requestAnimationFrame 句柄，在卸载时统一清理。
 */
import { useLayoutEffect, useRef, type RefObject } from 'react'

import { prefersReducedMotion } from './elasticPressSession.ts'
import {
  computeSelectionWormSpan,
  SELECTION_WORM_DURATION_MS,
  SELECTION_WORM_REST_SIZE,
  type SelectionWormSpan,
} from './selectionWormMath.ts'

/** 启用弹性选择指示条所需的容器、选择器与变更键。 */
export interface UseSelectionWormOptions {
  /** 指示条绝对定位所参照的容器引用（需具备非 static 定位）。 */
  readonly containerRef: RefObject<HTMLElement | null>
  /** 容器内唯一代表当前选中项的 CSS 选择器。 */
  readonly activeSelector: string
  /** 当前选中标识，仅在其发生变化时触发拉伸动画，避免普通重排抖动。 */
  readonly activeKey: string | number | null | undefined
  /** 静止状态下指示条长度（像素），默认 16。 */
  readonly restingSize?: number | undefined
}

interface WormRuntimeState {
  currentSpan: SelectionWormSpan | null
  fromSpan: SelectionWormSpan | null
  targetSpan: SelectionWormSpan | null
  lastKey: string | number | null | undefined
  elapsedMs: number
  lastFrameAt: number | null
  hasFirstTick: boolean
  frame: number | null
}

const MAX_FRAME_DELTA_MS = 100
const FIRST_FRAME_STEP_MS = 1000 / 60

/** 沿着 offsetParent 累加纵向偏移，完全忽略父/子元素上的 CSS transform 弹性形变。 */
function measureOffsetTopWithin(element: HTMLElement, container: HTMLElement): number {
  let top = 0
  let cursor: HTMLElement | null = element
  let guard = 0
  while (cursor !== null && cursor !== container && guard < 16) {
    top += cursor.offsetTop
    const parent: Element | null = cursor.offsetParent
    cursor = parent instanceof HTMLElement && container.contains(parent) ? parent : null
    guard += 1
  }
  return top
}

/** 测量当前激活项对应的静止指示条起止边界；无有效激活项或未布局时返回 null。 */
function measureTargetSpan(
  container: HTMLElement,
  selector: string,
  restingSize: number,
): SelectionWormSpan | null {
  const active = container.querySelector<HTMLElement>(selector)
  if (active === null) return null
  if (active.offsetHeight > 0 && active.offsetParent !== null) {
    const start =
      measureOffsetTopWithin(active, container) + (active.offsetHeight - restingSize) / 2
    return { start, end: start + restingSize, size: restingSize }
  }
  const activeRect = active.getBoundingClientRect()
  const containerRect = container.getBoundingClientRect()
  if (activeRect.height <= 0 || containerRect.height <= 0) return null
  const top = activeRect.top - containerRect.top - container.clientTop
  const start = top + (activeRect.height - restingSize) / 2
  return { start, end: start + restingSize, size: restingSize }
}

/** 直接把位置与长度写入指示条 DOM，避免动画期间触发 React 重渲染。 */
function paintWorm(worm: HTMLSpanElement, span: SelectionWormSpan | null): void {
  if (span === null) {
    worm.hidden = true
    return
  }
  worm.hidden = false
  worm.style.top = `${Math.round(span.start * 100) / 100}px`
  worm.style.height = `${Math.round(span.size * 100) / 100}px`
}

function advanceWormFrame(state: WormRuntimeState, now: number): SelectionWormSpan | null {
  if (state.fromSpan === null || state.targetSpan === null) return null
  const delta = state.hasFirstTick
    ? Math.min(MAX_FRAME_DELTA_MS, Math.max(0, now - (state.lastFrameAt ?? now)))
    : FIRST_FRAME_STEP_MS
  state.hasFirstTick = true
  state.lastFrameAt = now
  state.elapsedMs = Math.min(SELECTION_WORM_DURATION_MS, state.elapsedMs + delta)
  const progress = state.elapsedMs / SELECTION_WORM_DURATION_MS
  const span = computeSelectionWormSpan({
    fromStart: state.fromSpan.start,
    fromEnd: state.fromSpan.end,
    toStart: state.targetSpan.start,
    toEnd: state.targetSpan.end,
    progress,
  })
  state.currentSpan = span
  return span
}

function attachWormObserver(
  nodes: { readonly container: HTMLElement; readonly worm: HTMLSpanElement },
  state: WormRuntimeState,
  config: {
    readonly activeSelector: string
    readonly activeKey: string | number | null | undefined
    readonly restingSize: number
  },
): () => void {
  const { container, worm } = nodes
  const cancelFrame = () => {
    if (state.frame !== null) {
      window.cancelAnimationFrame(state.frame)
      state.frame = null
    }
  }
  const snapTo = (span: SelectionWormSpan | null) => {
    cancelFrame()
    state.fromSpan = null
    state.targetSpan = span
    state.elapsedMs = 0
    state.lastFrameAt = null
    state.hasFirstTick = false
    state.currentSpan = span
    paintWorm(worm, span)
  }
  const tick = (now: number) => {
    state.frame = null
    if (!worm.isConnected) return
    const span = advanceWormFrame(state, now)
    if (span === null) return
    paintWorm(worm, span)
    if (state.elapsedMs < SELECTION_WORM_DURATION_MS)
      state.frame = window.requestAnimationFrame(tick)
    else state.fromSpan = null
  }
  const sync = (animateOnChange: boolean) => {
    const next =
      config.activeKey === null || config.activeKey === undefined
        ? null
        : measureTargetSpan(container, config.activeSelector, config.restingSize)
    if (next === null) {
      state.lastKey = config.activeKey
      snapTo(null)
      return
    }
    if (!animateOnChange && state.frame !== null) {
      state.targetSpan = next
      return
    }
    const keyChanged = state.lastKey !== config.activeKey
    state.lastKey = config.activeKey
    const origin = state.currentSpan
    if (!animateOnChange || !keyChanged || origin === null || prefersReducedMotion()) {
      snapTo(next)
      return
    }
    if (Math.abs(origin.start - next.start) < 0.5 && Math.abs(origin.end - next.end) < 0.5) {
      snapTo(next)
      return
    }
    cancelFrame()
    state.fromSpan = origin
    state.targetSpan = next
    state.elapsedMs = 0
    state.lastFrameAt = null
    state.hasFirstTick = false
    state.frame = window.requestAnimationFrame(tick)
  }

  sync(true)
  const observer =
    typeof ResizeObserver === 'function' ? new ResizeObserver(() => sync(false)) : undefined
  observer?.observe(container)
  return () => {
    observer?.disconnect()
    cancelFrame()
    if (!container.isConnected) state.currentSpan = null
  }
}

/**
 * 为侧栏导航容器提供 FlClash 风格「前缘先冲、后缘收缩」指示条控制器。
 * @returns 绑定在绝对定位指示条 `<span>` 上的 ref。
 */
export function useSelectionWorm(
  options: UseSelectionWormOptions,
): RefObject<HTMLSpanElement | null> {
  const {
    containerRef,
    activeSelector,
    activeKey,
    restingSize = SELECTION_WORM_REST_SIZE,
  } = options
  const wormRef = useRef<HTMLSpanElement>(null)
  const stateRef = useRef<WormRuntimeState>({
    currentSpan: null,
    fromSpan: null,
    targetSpan: null,
    lastKey: activeKey,
    elapsedMs: 0,
    lastFrameAt: null,
    hasFirstTick: false,
    frame: null,
  })

  useLayoutEffect(() => {
    const container = containerRef.current
    const worm = wormRef.current
    if (container === null || worm === null) return
    return attachWormObserver({ container, worm }, stateRef.current, {
      activeSelector,
      activeKey,
      restingSize,
    })
  }, [activeKey, activeSelector, containerRef, restingSize])

  return wormRef
}
