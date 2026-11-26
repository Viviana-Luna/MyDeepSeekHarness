/**
 * 空会话预设液态玻璃透镜控制器：在 renderer 驱动单块选中透镜的弹簧运动、按压蓄力、
 * 高速拉伸、落位/边界挤压回弹与横向拖拽切换；卸载时释放 SVG 滤镜、观察器与事件监听。
 */
import { useLayoutEffect, useRef } from 'react'
import { createTabGlass, scaleTabGlass } from '../../../../../shared/ui/tab-glass.ts'

/** 预设透镜单帧形变计算所需的运动学与轨道状态输入。 */
export interface PresetLensPhysicsInput {
  readonly center: number
  readonly width: number
  readonly targetWidth: number
  readonly trackWidth: number
  readonly velocity: number
  readonly pressure: number
  readonly bulge: number
  readonly impact: number
  readonly reducedMotion: boolean
}

/** 预设透镜单帧计算出的缩放比例、约束后中心坐标及动态光学折射参数。 */
export interface PresetLensDeformation {
  readonly scaleX: number
  readonly scaleY: number
  readonly paintedCenter: number
  readonly squeeze: number
  readonly strengthBoost: number
  readonly chromaticAberration: number
  readonly specular: number
}

/** 启用预设透镜指针交互（按压蓄力与横向拖拽切换）的可选回调配置。 */
export interface PresetGlassOptions {
  readonly interactive?: boolean
  onSelect?: (id: string) => void
}

type LensElements = Record<'root' | 'material' | 'defs' | 'lens', HTMLDivElement>
type SpringAxis = { value: number; velocity: number }
type MotionState = {
  position: SpringAxis
  size: SpringAxis
  targetCenter: number
  targetWidth: number
  pressure: number
  pressureTarget: number
  bulge: number
  impact: number
  dragging: boolean
  dragVelocity: number
  reduced: boolean
  frame: number
  previous: number
}
type PointerState = {
  id: number
  startX: number
  lastX: number
  lastTime: number
  grabOffset: number
  dragging: boolean
  suppressClick: boolean
  velocity: number
  hovered: HTMLButtonElement | null
}
type PointerCallbacks = {
  readonly isInteractive: () => boolean
  readonly isReduced: () => boolean
  readonly onDragSelect: (id: string) => void
  readonly onSync: () => void
}
type LensRuntime = {
  readonly elements: LensElements
  readonly engine: ReturnType<typeof createTabGlass>
  readonly regions: readonly SVGElement[]
  readonly reduced: MediaQueryList
  targetWidth: number
  targetHeight: number
  active: HTMLButtonElement | null
}

const POSITION_SPRING = { stiffness: 300, damping: 21 } as const
const WIDTH_SPRING = { stiffness: 280, damping: 21 } as const
const BASE_STRENGTH = 0.018
const BASE_ABERRATION = 0.16
const BASE_SPECULAR = 0.7

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const ease = (value: number, target: number, rate: number, dt: number) =>
  value + (target - value) * (1 - Math.exp(-rate * dt))

function stepAxis(
  axis: SpringAxis,
  target: number,
  spring: { stiffness: number; damping: number },
  dt: number,
) {
  axis.velocity += (spring.stiffness * (target - axis.value) - spring.damping * axis.velocity) * dt
  axis.value += axis.velocity * dt
}

/**
 * 根据弹簧位置、水平速度、按压蓄力、落位过冲与轨道越界量，计算果冻挤压缩放与折射参数。
 * 在 `reducedMotion` 为真时返回零形变与静态光学参数，确保无障碍模式下无动画干扰。
 */
export function computePresetLensDeformation(input: PresetLensPhysicsInput): PresetLensDeformation {
  const safeTargetWidth = Math.max(1, input.targetWidth)
  const displayedWidth = Math.min(Math.max(1, input.trackWidth), Math.max(1, input.width))
  const widthRatio = displayedWidth / safeTargetWidth
  if (input.reducedMotion) {
    const half = displayedWidth / 2
    return {
      scaleX: widthRatio,
      scaleY: 1,
      paintedCenter: clamp(input.center, half, Math.max(half, input.trackWidth - half)),
      squeeze: 0,
      strengthBoost: 0,
      chromaticAberration: BASE_ABERRATION,
      specular: BASE_SPECULAR,
    }
  }
  const pressure = clamp(input.pressure, 0, 1)
  const bulge = clamp(input.bulge, 0, 1)
  const impact = clamp(input.impact, 0, 1)
  const edgeOverrun = Math.max(
    0,
    displayedWidth / 2 - input.center,
    input.center + displayedWidth / 2 - input.trackWidth,
  )
  // 越界挤压按指数饱和，防止快速拖拽或过冲撞边时圆头过度压扁。
  const edgeSqueeze = 0.095 * (1 - Math.exp(-edgeOverrun / Math.max(6, safeTargetWidth * 0.06)))
  const deformX = clamp(
    1 + pressure * 0.045 + bulge * 0.095 - impact * 0.065 - edgeSqueeze,
    0.92,
    1.1,
  )
  const scaleY = clamp(
    1 + pressure * 0.11 - bulge * 0.055 + impact * 0.1 + edgeSqueeze * 0.95,
    0.94,
    1.14,
  )
  const scaleX = widthRatio * deformX
  const half = Math.min(input.trackWidth / 2, (safeTargetWidth * scaleX) / 2)
  const energy = Math.min(1, bulge * 0.7 + impact * 0.8 + edgeSqueeze * 5)
  return {
    scaleX,
    scaleY,
    paintedCenter: clamp(input.center, half, Math.max(half, input.trackWidth - half)),
    squeeze: edgeSqueeze + impact * 0.065,
    strengthBoost: pressure * 0.008 + energy * 0.005,
    chromaticAberration: BASE_ABERRATION + pressure * 0.08 + energy * 0.05,
    specular: BASE_SPECULAR + pressure * 0.22 + energy * 0.12,
  }
}

function settleMotion(state: MotionState) {
  state.position.value = state.targetCenter
  state.position.velocity = 0
  state.size.value = state.targetWidth
  state.size.velocity = 0
  state.pressure = state.pressureTarget
  state.bulge = 0
  state.impact = 0
  state.dragVelocity = 0
  state.previous = 0
}

function stepMotionFrame(state: MotionState, time: number) {
  const dt = state.previous === 0 ? 1 / 60 : Math.min((time - state.previous) / 1000, 0.025)
  state.previous = time
  if (!state.dragging) stepAxis(state.position, state.targetCenter, POSITION_SPRING, dt)
  stepAxis(state.size, state.targetWidth, WIDTH_SPRING, dt)
  state.pressure = ease(state.pressure, state.pressureTarget, 26, dt)
  const speed = Math.abs(state.dragging ? state.dragVelocity : state.position.velocity)
  const speedNorm = Math.min(1, speed / Math.max(120, state.targetWidth * 4.5))
  state.bulge = ease(state.bulge, state.reduced ? 0 : speedNorm, 24, dt)
  if (state.dragging) state.dragVelocity *= Math.exp(-18 * dt)
  // 弹簧冲过目标点并开始减速回弹时触发短暂的落位挤压，使中间项切换也有果冻缓冲感。
  const overshooting =
    !state.dragging && (state.position.value - state.targetCenter) * state.position.velocity > 0
  const overshootNorm = Math.min(
    1,
    Math.abs(state.position.value - state.targetCenter) / Math.max(8, state.targetWidth * 0.12),
  )
  state.impact = ease(state.impact, state.reduced || !overshooting ? 0 : overshootNorm, 26, dt)
  const springMoving =
    !state.dragging &&
    (Math.abs(state.position.value - state.targetCenter) > 0.08 ||
      Math.abs(state.size.value - state.targetWidth) > 0.08 ||
      Math.abs(state.position.velocity) > 0.4 ||
      Math.abs(state.size.velocity) > 0.4)
  const morphMoving =
    Math.abs(state.pressure - state.pressureTarget) > 0.002 ||
    state.bulge > 0.003 ||
    state.impact > 0.003
  const active = state.dragging || springMoving || morphMoving
  if (!active) settleMotion(state)
  return { active, moving: springMoving || state.dragging }
}

function createPresetMotion(paint: (state: MotionState, moving: boolean) => void) {
  const state: MotionState = {
    position: { value: 0, velocity: 0 },
    size: { value: 100, velocity: 0 },
    targetCenter: 0,
    targetWidth: 100,
    pressure: 0,
    pressureTarget: 0,
    bulge: 0,
    impact: 0,
    dragging: false,
    dragVelocity: 0,
    reduced: false,
    frame: 0,
    previous: 0,
  }
  const stop = () => {
    cancelAnimationFrame(state.frame)
    state.frame = 0
    state.previous = 0
  }
  const draw = (time: number) => {
    const result = stepMotionFrame(state, time)
    paint(state, result.moving)
    state.frame = result.active ? requestAnimationFrame(draw) : 0
  }
  const wake = () => {
    if (state.reduced) {
      stop()
      settleMotion(state)
      paint(state, false)
    } else if (state.frame === 0) state.frame = requestAnimationFrame(draw)
  }
  return {
    move(center: number, width: number, immediate: boolean) {
      state.targetCenter = center
      state.targetWidth = width
      if (immediate || state.reduced) {
        stop()
        settleMotion(state)
        paint(state, false)
      } else wake()
    },
    setPressure(next: number) {
      state.pressureTarget = clamp(next, 0, 1)
      wake()
    },
    setDrag(center: number, width: number, velocity: number) {
      state.dragging = true
      state.position.value = center
      state.position.velocity = 0
      state.targetCenter = center
      state.targetWidth = width
      state.dragVelocity = velocity
      wake()
    },
    endDrag(center: number, width: number, velocity: number) {
      state.dragging = false
      state.position.velocity = velocity
      state.targetCenter = center
      state.targetWidth = width
      state.dragVelocity = 0
      wake()
    },
    setReduced(next: boolean) {
      state.reduced = next
      if (next) wake()
    },
    repaint: () => paint(state, state.frame !== 0 || state.dragging),
    getCenter: () => state.position.value,
    stop,
  }
}

type MotionController = ReturnType<typeof createPresetMotion>
type PointerContext = {
  readonly elements: LensElements
  readonly motion: MotionController
  readonly state: PointerState
  readonly callbacks: PointerCallbacks
}

function buttonMetrics(root: HTMLDivElement, button: HTMLButtonElement) {
  const rect = button.getBoundingClientRect()
  return {
    center: rect.left + rect.width / 2 - root.getBoundingClientRect().left,
    width: rect.width,
  }
}

function beginPointerGesture(context: PointerContext, event: PointerEvent) {
  const { elements, motion, state, callbacks } = context
  if (event.button !== 0 || !event.isPrimary || !callbacks.isInteractive()) return
  if (!(event.target instanceof Element)) return
  const button = event.target.closest<HTMLButtonElement>('button')
  if (button === null || button.disabled || button.getAttribute('aria-disabled') === 'true') return
  state.suppressClick = false
  state.id = event.pointerId
  state.startX = event.clientX
  state.lastX = event.clientX
  state.lastTime = event.timeStamp
  state.dragging = false
  state.hovered = button.dataset.presetId === undefined ? null : button
  const rootLeft = elements.root.getBoundingClientRect().left
  state.grabOffset =
    button.getAttribute('aria-pressed') === 'true'
      ? event.clientX - rootLeft - motion.getCenter()
      : 0
  if (!callbacks.isReduced()) {
    elements.lens.dataset.pressed = 'true'
    motion.setPressure(1)
  }
}

function updatePointerDrag(context: PointerContext, event: PointerEvent) {
  const { elements, motion, state } = context
  const buttons = [
    ...elements.root.querySelectorAll<HTMLButtonElement>('button[data-preset-id]:not(:disabled)'),
  ]
  if (buttons.length < 2) return
  if (!state.dragging) {
    if (Math.abs(event.clientX - state.startX) <= 5) return
    state.dragging = true
    elements.root.dataset.dragging = 'true'
    if (!elements.root.hasPointerCapture?.(state.id)) elements.root.setPointerCapture?.(state.id)
  }
  const first = buttonMetrics(elements.root, buttons[0]!)
  const last = buttonMetrics(elements.root, buttons.at(-1)!)
  const raw = event.clientX - elements.root.getBoundingClientRect().left - state.grabOffset
  let center = raw
  if (raw < first.center) center = first.center - Math.min(22, (first.center - raw) * 0.35)
  else if (raw > last.center) center = last.center + Math.min(22, (raw - last.center) * 0.35)
  const dt = Math.max(0.004, (event.timeStamp - state.lastTime) / 1000)
  state.velocity = clamp((event.clientX - state.lastX) / dt, -1800, 1800)
  state.lastX = event.clientX
  state.lastTime = event.timeStamp
  const nearest = buttons.reduce((best, item) =>
    Math.abs(buttonMetrics(elements.root, item).center - center) <
    Math.abs(buttonMetrics(elements.root, best).center - center)
      ? item
      : best,
  )
  state.hovered = nearest
  motion.setDrag(center, buttonMetrics(elements.root, nearest).width, state.velocity)
  event.preventDefault()
}

function finishPointerGesture(context: PointerContext, cancelled: boolean) {
  const { elements, motion, state, callbacks } = context
  if (state.id < 0) return
  const pointerId = state.id
  const wasDragging = state.dragging
  const targetButton = state.hovered
  const releaseVelocity = clamp(state.velocity, -900, 900)
  state.id = -1
  state.dragging = false
  state.hovered = null
  state.velocity = 0
  delete elements.lens.dataset.pressed
  delete elements.root.dataset.dragging
  if (elements.root.hasPointerCapture?.(pointerId)) elements.root.releasePointerCapture?.(pointerId)
  motion.setPressure(0)
  if (!wasDragging) return
  state.suppressClick = true
  if (!cancelled && targetButton !== null) {
    const target = buttonMetrics(elements.root, targetButton)
    motion.endDrag(target.center, target.width, releaseVelocity * 0.35)
    const targetId = targetButton.dataset.presetId
    if (targetId !== undefined && targetButton.getAttribute('aria-pressed') !== 'true') {
      callbacks.onDragSelect(targetId)
    }
    return
  }
  const active = elements.root.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')
  if (active !== null) {
    const origin = buttonMetrics(elements.root, active)
    motion.endDrag(origin.center, origin.width, 0)
  }
  callbacks.onSync()
}

function bindPointerInteraction(
  elements: LensElements,
  motion: MotionController,
  callbacks: PointerCallbacks,
) {
  const state: PointerState = {
    id: -1,
    startX: 0,
    lastX: 0,
    lastTime: 0,
    grabOffset: 0,
    dragging: false,
    suppressClick: false,
    velocity: 0,
    hovered: null,
  }
  const context: PointerContext = { elements, motion, state, callbacks }
  const onCancel = () => finishPointerGesture(context, true)
  const onEnd = (event: Event) => {
    const pointer = event as PointerEvent
    if (pointer.pointerId === state.id) finishPointerGesture(context, pointer.type !== 'pointerup')
  }
  const listeners: readonly [EventTarget, string, EventListener, boolean?][] = [
    [elements.root, 'pointerdown', event => beginPointerGesture(context, event as PointerEvent)],
    [
      window,
      'pointermove',
      event => {
        const pointer = event as PointerEvent
        if (pointer.pointerId === state.id && !callbacks.isReduced() && callbacks.isInteractive()) {
          updatePointerDrag(context, pointer)
        }
      },
    ],
    [window, 'pointerup', onEnd],
    [window, 'pointercancel', onEnd],
    [elements.root, 'lostpointercapture', onEnd],
    [
      elements.root,
      'click',
      event => {
        if (!state.suppressClick) return
        state.suppressClick = false
        event.preventDefault()
        event.stopPropagation()
      },
      true,
    ],
    [window, 'blur', onCancel],
    [
      window,
      'keydown',
      event => {
        if ((event as KeyboardEvent).key === 'Escape' && state.id >= 0) {
          event.preventDefault()
          finishPointerGesture(context, true)
        }
      },
    ],
  ]
  for (const [target, type, fn, capture] of listeners) target.addEventListener(type, fn, capture)
  return {
    cancel: onCancel,
    dispose() {
      finishPointerGesture(context, true)
      for (const [target, type, fn, capture] of listeners)
        target.removeEventListener(type, fn, capture)
    },
  }
}

function paintLensFrame(runtime: LensRuntime, state: MotionState, moving: boolean) {
  const { root, material, lens } = runtime.elements
  const rootBounds = root.getBoundingClientRect()
  const materialBounds = material.getBoundingClientRect()
  if (rootBounds.width <= 0 || materialBounds.width <= 0) return
  const deformation = computePresetLensDeformation({
    center: state.position.value,
    width: state.size.value,
    targetWidth: runtime.targetWidth,
    trackWidth: rootBounds.width,
    velocity: state.dragging ? state.dragVelocity : state.position.velocity,
    pressure: state.pressure,
    bulge: state.bulge,
    impact: state.impact,
    reducedMotion: runtime.reduced.matches,
  })
  const positionX =
    (deformation.paintedCenter + rootBounds.left - materialBounds.left) / materialBounds.width
  const widthScale = Math.min(1, 432 / Math.max(1, materialBounds.width))
  runtime.engine.setPosition(positionX, 0.5)
  runtime.engine.setOptions({
    strength: (BASE_STRENGTH + deformation.strengthBoost) * widthScale,
    chromaticAberration: deformation.chromaticAberration,
    specular: deformation.specular,
  })
  scaleTabGlass(lens, runtime.regions, deformation.scaleX, deformation.scaleY)
  if (moving && !runtime.reduced.matches) lens.dataset.moving = 'true'
  else delete lens.dataset.moving
}

function syncLensTarget(runtime: LensRuntime, motion: MotionController, observer: ResizeObserver) {
  const { root, lens } = runtime.elements
  motion.setReduced(runtime.reduced.matches)
  const next = root.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')
  const rect = next?.getBoundingClientRect()
  if (next === null || !rect || rect.width === 0) {
    lens.hidden = true
    delete root.dataset.glassReady
    delete lens.dataset.moving
    delete lens.dataset.pressed
    motion.stop()
    if (runtime.active !== null) observer.unobserve(runtime.active)
    runtime.active = null
    return
  }
  const first = runtime.active === null
  if (runtime.active !== next) {
    if (runtime.active !== null) observer.unobserve(runtime.active)
    observer.observe(next)
    runtime.active = next
  }
  const shapeChanged = runtime.targetWidth !== rect.width || runtime.targetHeight !== rect.height
  runtime.targetWidth = rect.width
  runtime.targetHeight = rect.height
  const targetCenter = rect.left + rect.width / 2 - root.getBoundingClientRect().left
  if (first || shapeChanged) {
    const quality = Math.max(
      512,
      Math.ceil((runtime.targetWidth * (window.devicePixelRatio || 1)) / 2) * 2,
    )
    runtime.engine.setOptions({ width: runtime.targetWidth, height: runtime.targetHeight, quality })
  }
  lens.hidden = false
  root.dataset.glassReady = 'true'
  motion.move(targetCenter, runtime.targetWidth, first || runtime.reduced.matches)
}

function bindLens(
  elements: LensElements,
  callbacks: { readonly isInteractive: () => boolean; readonly onDragSelect: (id: string) => void },
) {
  const { root, material, defs, lens } = elements
  const reduced = matchMedia('(prefers-reduced-motion: reduce)')
  const engine = createTabGlass(
    { container: root, filtered: material, defsHost: defs, shadow: lens },
    100,
    28,
  )
  const runtime: LensRuntime = {
    elements,
    engine,
    regions: [...defs.querySelectorAll<SVGElement>('[data-lens]')],
    reduced,
    targetWidth: 100,
    targetHeight: 28,
    active: null,
  }
  const motion = createPresetMotion((state, moving) => paintLensFrame(runtime, state, moving))
  motion.setReduced(reduced.matches)
  engine.onMap = () => {
    if (!lens.hidden) motion.repaint()
  }
  const sync = () => syncLensTarget(runtime, motion, observer)
  const observer = new ResizeObserver(sync)
  const pointer = bindPointerInteraction(elements, motion, {
    isInteractive: callbacks.isInteractive,
    isReduced: () => reduced.matches,
    onDragSelect: callbacks.onDragSelect,
    onSync: sync,
  })
  observer.observe(root)
  reduced.addEventListener('change', sync)
  sync()
  return {
    sync,
    cancelPointer: pointer.cancel,
    dispose() {
      pointer.dispose()
      motion.stop()
      observer.disconnect()
      reduced.removeEventListener('change', sync)
      engine.onMap = null
      engine.destroy()
      lens.style.transform = ''
      delete lens.dataset.moving
      delete lens.dataset.pressed
      delete root.dataset.glassReady
      delete root.dataset.dragging
    },
  }
}

/** 装配一块选中透镜，预设或布局变化时重算目标，卸载时释放滤镜与指针监听。 */
export function usePresetGlass(
  selected: string | undefined,
  layout: unknown,
  options: PresetGlassOptions = {},
) {
  const root = useRef<HTMLDivElement>(null)
  const material = useRef<HTMLDivElement>(null)
  const defs = useRef<HTMLDivElement>(null)
  const lens = useRef<HTMLDivElement>(null)
  const sync = useRef<(() => void) | null>(null)
  const cancelPointer = useRef<(() => void) | null>(null)
  const interactiveRef = useRef(options.interactive ?? true)
  const onSelectRef = useRef(options.onSelect)
  interactiveRef.current = options.interactive ?? true
  onSelectRef.current = options.onSelect
  useLayoutEffect(() => {
    if (typeof ResizeObserver !== 'function' || typeof matchMedia !== 'function') return
    if (!root.current || !material.current || !defs.current || !lens.current) return
    const binding = bindLens(
      { root: root.current, material: material.current, defs: defs.current, lens: lens.current },
      {
        isInteractive: () => interactiveRef.current,
        onDragSelect: id => onSelectRef.current?.(id),
      },
    )
    sync.current = binding.sync
    cancelPointer.current = binding.cancelPointer
    return () => {
      sync.current = null
      cancelPointer.current = null
      binding.dispose()
    }
  }, [])
  useLayoutEffect(() => {
    if (!interactiveRef.current) cancelPointer.current?.()
    sync.current?.()
  }, [selected, layout, options.interactive])
  return { root, material, defs, lens }
}
