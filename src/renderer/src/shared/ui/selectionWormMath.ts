/**
 * 侧栏弹性选择指示条的纯数学计算：复刻 FlClash / prism_ui 的前缘领先、后缘延迟追赶物理曲线。
 * 运行在 renderer；无副作用，负责把离散选区或当前运动边界插值为每帧的起止位置与拉伸长度。
 */

/** 一次选择切换动画的总时长（毫秒），对应 FlClash `_indicatorDuration`。 */
export const SELECTION_WORM_DURATION_MS = 320

/** 静止态指示条的标准长度（像素），对应 FlClash `_indicatorHeight`。 */
export const SELECTION_WORM_REST_SIZE = 16

/** 静止态指示条的标准厚度（像素），对应 FlClash `_indicatorWidth`。 */
export const SELECTION_WORM_THICKNESS = 3

/** 前缘率先抵达目标区间占总时长的比例。 */
const LEAD_FINISH_FRACTION = 0.6

/** 后缘开始启动追赶的延迟比例。 */
const TRAIL_DELAY_FRACTION = 0.35

/** 单次弹性指示条插值的输入边界与进度。 */
export interface SelectionWormInput {
  /** 起始位置上（左）边缘坐标。 */
  readonly fromStart: number
  /** 起始位置下（右）边缘坐标。 */
  readonly fromEnd: number
  /** 目标静止位置上（左）边缘坐标。 */
  readonly toStart: number
  /** 目标静止位置下（右）边缘坐标。 */
  readonly toEnd: number
  /** 归一化线性时间进度（0 到 1）。 */
  readonly progress: number
}

/** 插值后指示条的瞬时几何位置。 */
export interface SelectionWormSpan {
  /** 当前帧指示条上（左）边缘坐标。 */
  readonly start: number
  /** 当前帧指示条下（右）边缘坐标。 */
  readonly end: number
  /** 当前帧指示条长度（`end - start`）。 */
  readonly size: number
}

/** 标准三次缓出曲线，对应 Flutter `Curves.easeOutCubic`。 */
export function easeOutCubic(progress: number): number {
  const clamped = clampUnit(progress)
  const inverse = 1 - clamped
  return 1 - inverse * inverse * inverse
}

/** 标准三次先加速后减速曲线，对应 Flutter `Curves.easeInOutCubic`。 */
export function easeInOutCubic(progress: number): number {
  const clamped = clampUnit(progress)
  if (clamped < 0.5) return 4 * clamped * clamped * clamped
  const inverse = -2 * clamped + 2
  return 1 - (inverse * inverse * inverse) / 2
}

/**
 * 计算弹性指示条在给定时间进度下的起止坐标：
 * 前缘在 `0 -> 0.6` 内快速冲向目标，后缘延迟至 `0.35 -> 1.0` 再追赶，从而在途中自然拉长并收缩回位。
 */
export function computeSelectionWormSpan(input: SelectionWormInput): SelectionWormSpan {
  const t = clampUnit(input.progress)
  const lead = easeOutCubic(Math.min(1, t / LEAD_FINISH_FRACTION))
  const trail = easeInOutCubic(Math.max(0, (t - TRAIL_DELAY_FRACTION) / (1 - TRAIL_DELAY_FRACTION)))
  const movingForward = input.toStart >= input.fromStart
  const start = movingForward
    ? lerp(input.fromStart, input.toStart, trail)
    : lerp(input.fromStart, input.toStart, lead)
  const end = movingForward
    ? lerp(input.fromEnd, input.toEnd, lead)
    : lerp(input.fromEnd, input.toEnd, trail)
  const minSize = Math.max(0, input.toEnd - input.toStart)
  const safeEnd = Math.max(end, start + minSize)
  return { start, end: safeEnd, size: safeEnd - start }
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function lerp(from: number, to: number, factor: number): number {
  return from + (to - from) * factor
}
