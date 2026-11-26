/**
 * 弹性按压的指针会话内核：封装安全延迟捕获、全局中断清理、越界点击拦截与静止反算。
 * 被 useElasticPress 与全局委托共同复用，避免交互状态机在两处重复实现。
 */
import { type ElasticPressMotion } from './elasticPressMotion.ts'

/** 移动超过该像素才请求指针捕获，避免短按抢占目标而破坏原生 click。 */
const CAPTURE_THRESHOLD = 4

/** 本次按压最大拖动超过该像素或松手离开控件区域时，吞掉误触点击。 */
const CANCEL_CLICK_DISTANCE = 16
const HIT_SLOP = 2

const INTERACTIVE_TAG_SELECTOR = 'button, a, input, summary, [role="button"]'

interface PressRect {
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
}

/** 一次指针按下的最小输入载体，兼容 React 合成事件与原生 DOM PointerEvent。 */
export interface PointerDownPayload {
  readonly isPrimary: boolean
  readonly button: number
  readonly defaultPrevented: boolean
  readonly pointerId: number
  readonly clientX: number
  readonly clientY: number
  readonly target: EventTarget | null
}

/** 启动一次按压会话时的附加选项。 */
export interface PressBeginOptions {
  readonly disabled?: boolean | undefined
  readonly mirror?: HTMLElement | null | undefined
}

/** 拦截误触点击时所需的最小事件接口。 */
export interface ClickInterceptEvent {
  readonly target: EventTarget | null
  preventDefault(): void
  stopPropagation(): void
}

/** 系统是否要求减少动态效果；无法查询时按允许处理。 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/** 检查元素自身或其内部主控件是否处于禁用状态。 */
export function isPressDisabled(element: HTMLElement, disabledProp?: boolean): boolean {
  if (disabledProp) return true
  if (element.matches(':disabled, [aria-disabled="true"]')) return true
  return element.querySelector('button:disabled, [aria-disabled="true"]') !== null
}

/**
 * 选出安全接收指针捕获的节点：绝不在包裹按钮的外壳上捕获，防止 Chromium 重定向
 * pointerup 后将 click 派发到外壳而使内部按钮收不到点击。
 */
function resolveCaptureTarget(element: HTMLElement, eventTarget: EventTarget | null): Element {
  if (element.matches(INTERACTIVE_TAG_SELECTOR)) return element
  if (element.querySelector(INTERACTIVE_TAG_SELECTOR) === null) return element
  if (eventTarget instanceof Element) {
    const inner = eventTarget.closest(INTERACTIVE_TAG_SELECTOR)
    if (inner !== null && element.contains(inner)) return inner
    if (element.contains(eventTarget)) return eventTarget
  }
  return element.querySelector(INTERACTIVE_TAG_SELECTOR) ?? element
}

/** 扣掉当前尚未归零的弹性偏移，还原控件静态布局范围。无布局尺寸时返回 null。 */
function computeBaseRect(element: HTMLElement, motion: ElasticPressMotion): PressRect | null {
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  const offset = motion.getOffset()
  const width = element.offsetWidth > 0 ? element.offsetWidth : rect.width
  const height = element.offsetHeight > 0 ? element.offsetHeight : rect.height
  const centerX = rect.left + rect.width / 2 - offset.x
  const centerY = rect.top + rect.height / 2 - offset.y
  return {
    left: centerX - width / 2,
    right: centerX + width / 2,
    top: centerY - height / 2,
    bottom: centerY + height / 2,
  }
}

/** 判定坐标是否落在包含轻微容差的控件区域内。 */
function isWithinRect(clientX: number, clientY: number, rect: PressRect): boolean {
  return (
    clientX >= rect.left - HIT_SLOP &&
    clientX <= rect.right + HIT_SLOP &&
    clientY >= rect.top - HIT_SLOP &&
    clientY <= rect.bottom + HIT_SLOP
  )
}

function isMatchingPointerInterrupt(
  event: Event | undefined,
  activePointerId: number | null,
): boolean {
  return (
    typeof PointerEvent !== 'undefined' &&
    event instanceof PointerEvent &&
    event.pointerId !== activePointerId
  )
}

/** 管理单次按压的全局监听、安全捕获与防残留点击抑制，保证跟手拖动且永不卡死。 */
export class PressSession {
  private element: HTMLElement | null = null
  private motion: ElasticPressMotion | null = null
  private disabled = false
  private pointerId: number | null = null
  private captureTarget: Element | null = null
  private origin = { x: 0, y: 0 }
  private baseRect: PressRect | null = null
  private maxDistance = 0
  private suppressTarget: HTMLElement | null = null
  private suppressTimer: number | null = null
  private unbindListeners: (() => void) | null = null

  /** 更新当前会话关联控件的禁用态；若在按压中变禁用则立刻收回。 */
  setDisabled(disabled: boolean): void {
    this.disabled = disabled
    if (disabled) this.cancel()
  }

  /** 启动一次指针按压并挂载全局中断保护。 */
  begin(
    event: PointerDownPayload,
    element: HTMLElement,
    motion: ElasticPressMotion,
    options: PressBeginOptions = {},
  ): void {
    if (event.defaultPrevented || event.isPrimary === false || event.button !== 0) return
    if (prefersReducedMotion() || this.pointerId !== null || !element.isConnected) return
    if (isPressDisabled(element, options.disabled ?? this.disabled)) return

    this.clearSuppress()
    this.element = element
    this.motion = motion
    this.disabled = options.disabled ?? false
    this.pointerId = event.pointerId
    this.origin = { x: event.clientX, y: event.clientY }
    this.baseRect = computeBaseRect(element, motion)
    this.maxDistance = 0
    this.captureTarget = resolveCaptureTarget(element, event.target)
    this.bindListeners(this.captureTarget)
    motion.begin(options.mirror ?? null)
  }

  /** 在捕获阶段按目标匹配并吞掉大幅拖动或越界松手后的误触发点击。 */
  interceptClick(event: ClickInterceptEvent): boolean {
    if (this.suppressTarget === null) return false
    const matchesTarget =
      event.target instanceof Node &&
      (event.target === this.suppressTarget || this.suppressTarget.contains(event.target))
    if (!matchesTarget) return false
    this.clearSuppress()
    event.preventDefault()
    event.stopPropagation()
    return true
  }

  /** 异常打断或控件变禁用时立即结束当前按压并收回弹簧。 */
  cancel(): void {
    if (this.pointerId === null) return
    this.endPress(true, null)
  }

  /** 清理当前会话监听、捕获与定时器（同时释放可选持有的运动实例）。 */
  dispose(disposeMotion = true): void {
    this.releaseCapture()
    this.unbindListeners?.()
    this.unbindListeners = null
    this.pointerId = null
    this.captureTarget = null
    this.element = null
    this.clearSuppress()
    if (disposeMotion) this.motion?.dispose()
    this.motion = null
  }

  private clearSuppress(): void {
    this.suppressTarget = null
    if (this.suppressTimer !== null) {
      window.clearTimeout(this.suppressTimer)
      this.suppressTimer = null
    }
  }

  private armSuppressReset(target: HTMLElement): void {
    this.clearSuppress()
    this.suppressTarget = target
    // 若浏览器未跟随本次释放派发 click（例如移出或取消），下一轮任务自动清理，避免误伤后续点击。
    this.suppressTimer = window.setTimeout(() => {
      this.suppressTarget = null
      this.suppressTimer = null
    }, 0)
  }

  private releaseCapture(): void {
    if (this.pointerId === null || this.captureTarget === null) return
    try {
      if (this.captureTarget.hasPointerCapture?.(this.pointerId)) {
        this.captureTarget.releasePointerCapture(this.pointerId)
      }
    } catch {
      // 目标节点已被移除时浏览器可能抛错，安全忽略。
    }
  }

  private endPress(cancelled: boolean, releaseEvent: PointerEvent | null): void {
    if (this.pointerId === null) return
    const target = this.element
    if (!cancelled && releaseEvent !== null && target !== null) {
      const outside =
        this.baseRect !== null &&
        !isWithinRect(releaseEvent.clientX, releaseEvent.clientY, this.baseRect)
      if (outside || this.maxDistance > CANCEL_CLICK_DISTANCE) {
        this.armSuppressReset(target)
      }
    }
    this.releaseCapture()
    this.unbindListeners?.()
    this.unbindListeners = null
    this.pointerId = null
    this.captureTarget = null
    this.element = null
    this.motion?.release(cancelled)
  }

  private handleMove(event: PointerEvent): void {
    if (event.pointerId !== this.pointerId) return
    if (
      this.element === null ||
      !this.element.isConnected ||
      isPressDisabled(this.element, this.disabled)
    ) {
      this.endPress(true, null)
      return
    }
    const offsetX = event.clientX - this.origin.x
    const offsetY = event.clientY - this.origin.y
    const distance = Math.hypot(offsetX, offsetY)
    this.maxDistance = Math.max(this.maxDistance, distance)
    if (distance > CAPTURE_THRESHOLD && this.captureTarget !== null) {
      try {
        if (!this.captureTarget.hasPointerCapture?.(event.pointerId)) {
          this.captureTarget.setPointerCapture(event.pointerId)
        }
      } catch {
        // 非标准环境或节点脱离时退回 window 监听即可。
      }
    }
    this.motion?.pull(offsetX, offsetY)
  }

  private handleUp(event: PointerEvent): void {
    if (event.pointerId !== this.pointerId) return
    const invalid =
      this.element === null ||
      !this.element.isConnected ||
      isPressDisabled(this.element, this.disabled)
    this.endPress(invalid, invalid ? null : event)
  }

  private bindListeners(captureTarget: Element): void {
    this.unbindListeners?.()
    const onMove = (event: PointerEvent) => this.handleMove(event)
    const onUp = (event: PointerEvent) => this.handleUp(event)
    const onInterrupt = (event?: Event) => {
      if (isMatchingPointerInterrupt(event, this.pointerId)) return
      this.endPress(true, null)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') this.endPress(true, null)
    }

    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onInterrupt, true)
    window.addEventListener('blur', onInterrupt, true)
    window.addEventListener('contextmenu', onInterrupt, true)
    window.addEventListener('keydown', onKeyDown, true)
    captureTarget.addEventListener('lostpointercapture', onInterrupt)

    this.unbindListeners = () => {
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onInterrupt, true)
      window.removeEventListener('blur', onInterrupt, true)
      window.removeEventListener('contextmenu', onInterrupt, true)
      window.removeEventListener('keydown', onKeyDown, true)
      captureTarget.removeEventListener('lostpointercapture', onInterrupt)
    }
  }
}
