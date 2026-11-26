/**
 * 弹性按压的运动状态机：按 FlClash / prism_ui 物理模型逐帧推进按压、悬停预抬升与拖动追随，并写入 transform。
 * 支持快速轻触冲顶（至少推至 0.975 再回弹）、连按速度衔接、悬停落定停帧与可选镜像节点联动。
 */
import {
  combineLift,
  elasticTransform,
  HOVER_SWELL,
  LIFT_SNAP,
  PRESS_GROWTH_CEILING,
  PRESS_SPRING,
  pullLimit,
  rubberBand,
  SETTLE_SPRING,
  stepSpring,
  TRACK_SPRING,
  type SpringStep,
} from './elasticPressMath.ts'

/** 判定动画收敛到目标状态的位置与速度阈值。 */
const REST_LIFT = 0.003
const REST_LIFT_SPEED = 0.02
const REST_PULL = 0.08
const REST_PULL_SPEED = 1.5
const MAX_FRAME_DELTA = 1 / 30

type PressVisualState = 'hover' | 'active'
type AdvanceOutcome = 'running' | 'paused' | 'settled'

/** 创建运动状态机时的可选配置。 */
export interface ElasticPressMotionOptions {
  /** 完全回零静止后的清理回调，常用于全局管理器回收活跃记录。 */
  readonly onIdle?: () => void
  /** 满压鼓起的最大增量像素上限，默认 16px。 */
  readonly maxGrowth?: number
}

/** 按压期间记录的偏移快照。 */
export interface PressOffset {
  readonly x: number
  readonly y: number
}

/** 判定单个弹簧通道是否已在目标值处完全静止。 */
function isAtRest(
  step: SpringStep,
  target: number,
  positionThreshold: number,
  speedThreshold: number,
): boolean {
  return (
    Math.abs(step.value - target) < positionThreshold && Math.abs(step.velocity) < speedThreshold
  )
}

/** 清除单个元素上的按压内联变换与状态属性。 */
function clearElementPress(element: HTMLElement | null): void {
  if (element === null) return
  element.style.removeProperty('transform')
  delete element.dataset.press
}

/** 写入单个元素上的按压变换与当前交互阶段标记。 */
function applyElementPress(
  element: HTMLElement | null,
  transform: string,
  state: PressVisualState,
): void {
  if (element === null) return
  element.dataset.press = state
  element.style.transform = transform
}

/**
 * 单个交互控件上的 FlClash 风格弹性运动状态机；由 useElasticPress 或全局委托持有并管理。
 */
export class ElasticPressMotion {
  private readonly element: HTMLElement
  private readonly onIdle: (() => void) | undefined
  private readonly maxGrowth: number
  private mirror: HTMLElement | null = null
  private baseTransform = ''
  private size = { width: 0, height: 0 }
  private drag = { x: 0, y: 0 }
  private pressed = false
  private releasing = false
  private hovered = false
  private hasFirstTick = false
  private press: SpringStep = { value: 0, velocity: 0 }
  private hover: SpringStep = { value: 0, velocity: 0 }
  private pullX: SpringStep = { value: 0, velocity: 0 }
  private pullY: SpringStep = { value: 0, velocity: 0 }
  private lastFrame: number | null = null
  private frame: number | null = null

  constructor(element: HTMLElement, optionsOrOnIdle?: ElasticPressMotionOptions | (() => void)) {
    this.element = element
    if (typeof optionsOrOnIdle === 'function') {
      this.onIdle = optionsOrOnIdle
      this.maxGrowth = PRESS_GROWTH_CEILING
      return
    }
    this.onIdle = optionsOrOnIdle?.onIdle
    this.maxGrowth = optionsOrOnIdle?.maxGrowth ?? PRESS_GROWTH_CEILING
  }

  /** 读取当前已应用的弹性偏移像素，用于反算控件静态点击范围。 */
  getOffset(): PressOffset {
    return { x: this.pullX.value, y: this.pullY.value }
  }

  /** 判断当前控件是否处于任一非静止交互态（悬停、按压或回弹中）。 */
  isActive(): boolean {
    return this.pressed || this.releasing || this.hovered || this.frame !== null
  }

  /** 更新联动镜像节点（如模式栏激活滑块），并在切换归属时清理旧镜像样式。 */
  setMirror(mirror: HTMLElement | null): void {
    if (this.mirror === mirror) return
    this.syncMirror(mirror)
    if (this.mirror !== null && this.isActive()) {
      this.paint()
    }
  }

  /** 更新悬停状态：鼠标悬停时轻盈抬升至 0.4，离开后平滑回落并在静止时回收资源。 */
  setHovered(hovered: boolean, mirror: HTMLElement | null = this.mirror): void {
    if (this.hovered === hovered && this.mirror === mirror) return
    if (mirror !== null && this.mirror !== mirror) {
      this.syncMirror(mirror)
    }
    this.hovered = hovered
    if (
      !hovered &&
      !this.pressed &&
      !this.releasing &&
      this.hover.value === 0 &&
      this.frame === null
    ) {
      return
    }
    if (this.frame === null) {
      this.measureIfIdle()
      this.hasFirstTick = false
      this.lastFrame = performance.now()
    }
    if (hovered && !this.pressed && !this.releasing) {
      this.element.dataset.press ??= 'hover'
    }
    this.start()
  }

  /** 开始一次按压：量出控件尺寸并无缝衔接当前残留运动，可选同步驱动镜像元素。 */
  begin(mirror: HTMLElement | null = null): void {
    this.syncMirror(mirror)
    this.measureIfIdle()
    this.drag = { x: 0, y: 0 }
    this.pressed = true
    this.releasing = false
    this.hasFirstTick = false
    this.lastFrame ??= performance.now()
    this.element.dataset.press = 'active'
    if (this.mirror !== null) this.mirror.dataset.press = 'active'
    this.start()
  }

  /** 记录指针相对按下点的原始位移，由下一帧追随弹簧顺滑带入。 */
  pull(offsetX: number, offsetY: number): void {
    if (!this.pressed) return
    this.drag = { x: offsetX, y: offsetY }
  }

  /**
   * 结束按压：正常轻触若尚未达到 0.975 峰值，则继续推进至峰值再回弹；异常取消直接收回。
   * @param cancelled 是否由失焦、中断或脱离窗口等异常路径触发。
   */
  release(cancelled = false): void {
    if (!this.pressed) return
    this.pressed = false
    this.releasing = !cancelled && this.press.value < LIFT_SNAP
    this.lastFrame ??= performance.now()
    this.start()
  }

  /** 取消动画帧并清理所有样式；组件卸载或禁用时必须调用。 */
  dispose(): void {
    if (this.frame !== null) window.cancelAnimationFrame(this.frame)
    this.frame = null
    this.pressed = false
    this.releasing = false
    this.hovered = false
    this.lastFrame = null
    this.baseTransform = ''
    this.press = { value: 0, velocity: 0 }
    this.hover = { value: 0, velocity: 0 }
    this.pullX = { value: 0, velocity: 0 }
    this.pullY = { value: 0, velocity: 0 }
    clearElementPress(this.element)
    clearElementPress(this.mirror)
    this.mirror = null
    this.onIdle?.()
  }

  private syncMirror(mirror: HTMLElement | null): void {
    if (this.mirror !== null && this.mirror !== mirror) clearElementPress(this.mirror)
    this.mirror = mirror
  }

  private measureIfIdle(): void {
    if (
      this.frame === null &&
      !this.element.style.transform &&
      typeof window.getComputedStyle === 'function'
    ) {
      const computed = window.getComputedStyle(this.element).transform
      this.baseTransform = computed && computed !== 'none' ? computed : ''
    }
    this.size = { width: this.element.offsetWidth, height: this.element.offsetHeight }
  }

  private start(): void {
    if (this.frame !== null) return
    this.frame = window.requestAnimationFrame(this.tick)
  }

  private readonly tick = (now: number): void => {
    this.frame = null
    if (!this.element.isConnected) {
      this.dispose()
      return
    }
    const previous = this.lastFrame ?? now
    this.lastFrame = now
    const rawDelta = (now - previous) / 1000
    const clamped = Math.min(rawDelta, MAX_FRAME_DELTA)
    const delta = !this.hasFirstTick && rawDelta <= 0 ? 1 / 60 : Math.max(0, clamped)
    this.hasFirstTick = true

    const outcome = this.advance(delta)
    if (outcome === 'settled') {
      this.settle()
      return
    }
    this.paint()
    if (outcome === 'paused') {
      this.lastFrame = null
      return
    }
    this.start()
  }

  /** 推进一帧；悬停稳态后停帧省电，彻底回零后通知释放。 */
  private advance(delta: number): AdvanceOutcome {
    const pressTarget = this.pressed || this.releasing ? 1 : 0
    this.press = stepSpring(this.press, {
      ...PRESS_SPRING,
      target: pressTarget,
      deltaSeconds: delta,
    })
    if (this.releasing && this.press.value >= LIFT_SNAP) {
      this.releasing = false
    }

    const hoverTarget = this.hovered ? HOVER_SWELL : 0
    this.hover = stepSpring(this.hover, {
      ...SETTLE_SPRING,
      target: hoverTarget,
      deltaSeconds: delta,
    })

    this.advancePull(delta)

    if (this.pressed || this.releasing) return 'running'
    const pressAtRest = isAtRest(this.press, 0, REST_LIFT, REST_LIFT_SPEED)
    const pullAtRest =
      isAtRest(this.pullX, 0, REST_PULL, REST_PULL_SPEED) &&
      isAtRest(this.pullY, 0, REST_PULL, REST_PULL_SPEED)
    const hoverAtRest = isAtRest(this.hover, hoverTarget, REST_LIFT, REST_LIFT_SPEED)
    if (!pressAtRest || !pullAtRest || !hoverAtRest) return 'running'

    if (!this.hovered) return 'settled'
    this.press = { value: 0, velocity: 0 }
    this.hover = { value: HOVER_SWELL, velocity: 0 }
    this.pullX = { value: 0, velocity: 0 }
    this.pullY = { value: 0, velocity: 0 }
    return 'paused'
  }

  private advancePull(delta: number): void {
    if (this.pressed) {
      const limit = pullLimit(Math.min(this.size.width, this.size.height))
      const targetX = rubberBand(this.drag.x, limit)
      const targetY = rubberBand(this.drag.y, limit)
      this.pullX = stepSpring(this.pullX, { ...TRACK_SPRING, target: targetX, deltaSeconds: delta })
      this.pullY = stepSpring(this.pullY, { ...TRACK_SPRING, target: targetY, deltaSeconds: delta })
      return
    }
    this.pullX = stepSpring(this.pullX, { ...PRESS_SPRING, target: 0, deltaSeconds: delta })
    this.pullY = stepSpring(this.pullY, { ...PRESS_SPRING, target: 0, deltaSeconds: delta })
  }

  private paint(): void {
    const state: PressVisualState = this.pressed || this.releasing ? 'active' : 'hover'
    const lift = combineLift(this.press.value, this.hover.value)
    const transform = elasticTransform({
      width: this.size.width,
      height: this.size.height,
      lift,
      pullX: this.pullX.value,
      pullY: this.pullY.value,
      maxGrowth: this.maxGrowth,
    })
    const composed =
      this.baseTransform && transform !== 'none' ? `${this.baseTransform} ${transform}` : transform
    applyElementPress(this.element, composed, state)
    applyElementPress(this.mirror, transform, state)
  }

  private settle(): void {
    this.press = { value: 0, velocity: 0 }
    this.hover = { value: 0, velocity: 0 }
    this.pullX = { value: 0, velocity: 0 }
    this.pullY = { value: 0, velocity: 0 }
    this.releasing = false
    this.lastFrame = null
    this.baseTransform = ''
    clearElementPress(this.element)
    clearElementPress(this.mirror)
    this.mirror = null
    this.onIdle?.()
  }
}
