/**
 * 弹性按压的数值换算：按 FlClash / prism_ui 的 iOS 液态交互物理模型计算鼓起、橡皮筋位移与阻尼弹簧，运行在 renderer。
 * 纯函数且无副作用，具体样式写入与事件处理由 ElasticPressMotion 与 useElasticPress 负责。
 */

/** FlClash 基准按压鼓起常数（1 / 8）。 */
export const PRESS_GROWTH_BASE = 1 / 8

/** 满压鼓起比例上限（基准常数的两倍 0.25），保证小图标同样灵动。 */
export const PRESS_MAX_GROWTH = PRESS_GROWTH_BASE * 2

/** 满压尺寸增量的绝对像素上限（16px），防止宽大按钮过度膨胀。 */
export const PRESS_GROWTH_CEILING = 16

/** 悬停预抬升比例：与按压组合时保持轻盈放大并在松手后落回悬停态。 */
export const HOVER_SWELL = 0.4

/** 快速轻触兜底阈值：松手时至少推进到 0.975 再回弹，保证短点击也有完整鼓起峰值。 */
export const LIFT_SNAP = 0.975

/** 拖动位移上限占短边的比例（7 / 32 = 0.21875）。 */
export const PULL_LIMIT_RATIO = 7 / 32

/** Apple UIScrollView 橡皮筋阻尼系数，起点斜率为 0.55。 */
export const RUBBER_BAND_COEFFICIENT = 0.55

/** 拖动轴向拉伸系数：按位移与对应轴向尺寸之比乘以 0.5 叠加缩放。 */
export const PULL_STRETCH = 0.5

const MIN_SCALE = 0.75
const CRITICAL_EPSILON = 1e-6

/** 定制弹簧参数：质量固定为 1 时的刚度与阻尼比。 */
export interface SpringConfig {
  /** 弹簧刚度 k，越大回弹越快。 */
  readonly stiffness: number
  /** 阻尼比 ζ，小于 1 产生过冲回弹，等于 1 为临界阻尼。 */
  readonly dampingRatio: number
}

/** 按苹果 duration / bounce 参数换算弹簧刚度与阻尼比，等效 Flutter Spring.withBounce。 */
export function springFromDurationBounce(durationSeconds: number, bounce: number): SpringConfig {
  if (!(durationSeconds > 0)) {
    return { stiffness: 311, dampingRatio: 1 }
  }
  const omega = (2 * Math.PI) / durationSeconds
  return {
    stiffness: omega * omega,
    dampingRatio: Math.max(0, 1 - bounce),
  }
}

/** 按压鼓起、松手回弹与位移复位的核心弹簧（stiffness: 311, dampingRatio: 0.593）。 */
export const PRESS_SPRING: SpringConfig = { stiffness: 311, dampingRatio: 0.593 }

/** 拖动跟手追随弹簧（duration: 120ms, bounce: 0，临界阻尼紧贴指针）。 */
export const TRACK_SPRING: SpringConfig = springFromDurationBounce(0.12, 0)

/** 悬停预抬升与离开落定弹簧（duration: 500ms, bounce: 0.32）。 */
export const SETTLE_SPRING: SpringConfig = springFromDurationBounce(0.5, 0.32)

/** 一次按压里随指针变化的全部数值。 */
export interface ElasticPressFrame {
  /** 控件宽度，用于计算最长边等比鼓起与横向拉伸。 */
  readonly width: number
  /** 控件高度，用于计算最长边等比鼓起与纵向拉伸。 */
  readonly height: number
  /** 组合抬升进度（0 为静止、0.4 为悬停、1 为满压，回弹阶段可达 >1）。 */
  readonly lift: number
  /** 经过橡皮筋阻尼与追随弹簧平滑后的横向位移。 */
  readonly pullX: number
  /** 经过橡皮筋阻尼与追随弹簧平滑后的纵向位移。 */
  readonly pullY: number
  /** 满压最大增量像素上限，默认 16px。 */
  readonly maxGrowth?: number
}

/** 弹簧一步积分的状态，交给下一帧继续。 */
export interface SpringStep {
  readonly value: number
  readonly velocity: number
}

/** 定制弹簧积分的步进参数。 */
export interface SpringStepConfig {
  readonly target: number
  readonly deltaSeconds: number
  readonly stiffness: number
  readonly dampingRatio: number
}

/**
 * 满压时的统一等比鼓起系数：按最长边计算，小控件封顶 25%，宽控件按 maxGrowth（默认 16px）封顶。
 * @param longestSide 控件较长边的像素尺寸。
 * @param maxGrowth 允许增加的最大像素尺寸，默认 16。
 */
export function pressGrowth(longestSide: number, maxGrowth = PRESS_GROWTH_CEILING): number {
  if (!(longestSide > 0) || !(maxGrowth > 0)) return 0
  return Math.min(PRESS_MAX_GROWTH, maxGrowth / longestSide)
}

/**
 * 拖动位移上限：短边的 7 / 32，让微小按钮不跑飞、标准胶囊跟手自然。
 * @param shortestSide 控件较短边的像素尺寸。
 */
export function pullLimit(shortestSide: number): number {
  if (!(shortestSide > 0)) return 0
  return shortestSide * PULL_LIMIT_RATIO
}

/**
 * Apple 0.55 橡皮筋阻尼映射：limit * (1 - 1 / (|offset| * 0.55 / limit + 1)) * sign(offset)。
 * @param offset 指针相对按下点的原始位移。
 * @param limit 该控件允许的最大拖动行程。
 */
export function rubberBand(offset: number, limit: number): number {
  if (!(limit > 0) || !Number.isFinite(offset) || offset === 0) return 0
  const distance = Math.abs(offset)
  const compressed = limit * (1 - 1 / ((distance * RUBBER_BAND_COEFFICIENT) / limit + 1))
  return Math.sign(offset) * compressed
}

/**
 * 合并按压与悬停进度：悬停处于 0.4 时按下继续推进到 1，松手后平滑落回悬停态 0.4。
 * @param press 当前按压弹簧值。
 * @param hover 当前悬停弹簧值。
 */
export function combineLift(press: number, hover: number): number {
  return clampRange(press + (1 - press) * hover, 0, 2)
}

/**
 * 根据当前帧状态生成 CSS transform 字符串。
 * 采用 FlClash 统一等比 swell 与纯粹 X/Y 轴向拉伸（无旋转斜切或反向压扁）。
 * @param frame 当前帧的尺寸、组合抬升进度和弹性位移。
 */
export function elasticTransform(frame: ElasticPressFrame): string {
  const { width, height, lift, pullX, pullY, maxGrowth = PRESS_GROWTH_CEILING } = frame
  if (width <= 0 || height <= 0) return 'none'
  const longestSide = Math.max(width, height)
  const swell = 1 + lift * pressGrowth(longestSide, maxGrowth)
  const stretchX = Math.abs(pullX) > 0.001 ? (Math.abs(pullX) / width) * PULL_STRETCH : 0
  const stretchY = Math.abs(pullY) > 0.001 ? (Math.abs(pullY) / height) * PULL_STRETCH : 0
  const scaleX = clampScale(swell * (1 + stretchX))
  const scaleY = clampScale(swell * (1 + stretchY))
  return `translate3d(${round(pullX)}px, ${round(pullY)}px, 0) scale(${round(scaleX)}, ${round(scaleY)})`
}

/**
 * 使用 FlClash 核心按压弹簧计算一步积分。
 */
export function springToward(
  current: number,
  velocity: number,
  target: number,
  deltaSeconds: number,
): SpringStep {
  return stepSpring(
    { value: current, velocity },
    {
      target,
      deltaSeconds,
      stiffness: PRESS_SPRING.stiffness,
      dampingRatio: PRESS_SPRING.dampingRatio,
    },
  )
}

/**
 * 闭式解析阻尼弹簧步进（精确匹配 Flutter SpringSimulation 的临界、欠阻尼与过阻尼解）。
 * @param state 当前值和速度。
 * @param config 目标值、时间增量及弹簧刚度/阻尼比。
 */
export function stepSpring(state: SpringStep, config: SpringStepConfig): SpringStep {
  const dt = Number.isFinite(config.deltaSeconds) ? Math.max(config.deltaSeconds, 0) : 0
  if (dt === 0) {
    return { value: state.value, velocity: state.velocity }
  }
  if (!(config.stiffness > 0)) {
    return { value: config.target, velocity: 0 }
  }

  const omega0 = Math.sqrt(config.stiffness)
  const zeta = Math.max(0, config.dampingRatio)
  const displacement = state.value - config.target

  if (Math.abs(zeta - 1) <= CRITICAL_EPSILON) {
    return stepCriticalSpring(displacement, state.velocity, config.target, { omega0, zeta, dt })
  }
  if (zeta < 1) {
    return stepUnderdampedSpring(displacement, state.velocity, config.target, { omega0, zeta, dt })
  }
  return stepOverdampedSpring(displacement, state.velocity, config.target, { omega0, zeta, dt })
}

interface SpringSolutionTiming {
  readonly omega0: number
  readonly zeta: number
  readonly dt: number
}

/** 临界阻尼解析解：快速逼近且零过冲，用于 TRACK_SPRING 拖动追随。 */
function stepCriticalSpring(
  displacement: number,
  velocity: number,
  target: number,
  timing: SpringSolutionTiming,
): SpringStep {
  const { omega0, dt } = timing
  const decay = Math.exp(-omega0 * dt)
  const slope = velocity + omega0 * displacement
  return {
    value: target + (displacement + slope * dt) * decay,
    velocity: (velocity - omega0 * slope * dt) * decay,
  }
}

/** 欠阻尼解析解：带自然弹性过冲与回弹，用于 PRESS_SPRING 与 SETTLE_SPRING。 */
function stepUnderdampedSpring(
  displacement: number,
  velocity: number,
  target: number,
  timing: SpringSolutionTiming,
): SpringStep {
  const { omega0, zeta, dt } = timing
  const omegaD = omega0 * Math.sqrt(1 - zeta * zeta)
  const decay = Math.exp(-zeta * omega0 * dt)
  const c1 = displacement
  const c2 = (velocity + zeta * omega0 * displacement) / omegaD
  const cos = Math.cos(omegaD * dt)
  const sin = Math.sin(omegaD * dt)
  const nextDisplacement = decay * (c1 * cos + c2 * sin)
  const nextVelocity =
    decay * ((c2 * omegaD - zeta * omega0 * c1) * cos - (c1 * omegaD + zeta * omega0 * c2) * sin)
  return {
    value: target + nextDisplacement,
    velocity: nextVelocity,
  }
}

/** 过阻尼解析解：应对自定义高阻尼场景，保证函数在全 ζ >= 0 区间连续。 */
function stepOverdampedSpring(
  displacement: number,
  velocity: number,
  target: number,
  timing: SpringSolutionTiming,
): SpringStep {
  const { omega0, zeta, dt } = timing
  const beta = omega0 * Math.sqrt(zeta * zeta - 1)
  const r1 = -omega0 * zeta + beta
  const r2 = -omega0 * zeta - beta
  const c1 = (velocity - r2 * displacement) / (2 * beta)
  const c2 = (r1 * displacement - velocity) / (2 * beta)
  const e1 = Math.exp(r1 * dt)
  const e2 = Math.exp(r2 * dt)
  return {
    value: target + c1 * e1 + c2 * e2,
    velocity: c1 * r1 * e1 + c2 * r2 * e2,
  }
}

/** 限制数值范围。 */
function clampRange(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 限制缩放下界，避免极端状态下元素塌陷。 */
function clampScale(value: number): number {
  return Math.max(MIN_SCALE, value)
}

/** 保留三位小数，避免每帧写入过长样式字符串。 */
function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
