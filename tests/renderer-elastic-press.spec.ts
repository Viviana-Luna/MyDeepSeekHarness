/**
 * 校验 FlClash 风格弹性按压的数值换算：最长边封顶 25%/16px 统一鼓起、7/32 短边行程、
 * Apple 0.55 橡皮筋阻尼、无斜切纯粹轴向拉伸、以及解析弹簧的临界/欠阻尼精确解。
 */
import { describe, expect, it } from 'vitest'

import {
  combineLift,
  elasticTransform,
  HOVER_SWELL,
  PRESS_SPRING,
  pressGrowth,
  pullLimit,
  rubberBand,
  SETTLE_SPRING,
  springToward,
  stepSpring,
  TRACK_SPRING,
} from '../src/renderer/src/shared/ui/elasticPressMath.ts'

describe('FlClash 弹性按压数值', () => {
  it('鼓起比例按最长边计算，小控件封顶 25%、宽大控件按 16px 封顶', () => {
    expect(pressGrowth(32)).toBeCloseTo(0.25)
    expect(pressGrowth(64)).toBeCloseTo(0.25)
    expect(pressGrowth(128)).toBeCloseTo(16 / 128)
    expect(pressGrowth(320)).toBeCloseTo(16 / 320)
    expect(pressGrowth(0)).toBe(0)
  })

  it('拖动位移上限为短边的 7 / 32', () => {
    expect(pullLimit(16)).toBeCloseTo(3.5)
    expect(pullLimit(32)).toBeCloseTo(7)
    expect(pullLimit(64)).toBeCloseTo(14)
    expect(pullLimit(-4)).toBe(0)
  })

  it('Apple 0.55 橡皮筋起步斜率为 0.55、单调递增且永不越过上限', () => {
    const limit = pullLimit(32)
    expect(rubberBand(0, limit)).toBe(0)
    expect(rubberBand(0.001, limit) / 0.001).toBeCloseTo(0.55, 3)
    const samples = [1, 4, 12, 40, 400].map(distance => rubberBand(distance, limit))
    for (const [index, value] of samples.entries()) {
      expect(value).toBeGreaterThan(0)
      expect(value).toBeLessThan(limit)
      if (index > 0) expect(value).toBeGreaterThan(samples[index - 1]!)
    }
    expect(rubberBand(-12, limit)).toBeCloseTo(-rubberBand(12, limit))
    expect(rubberBand(12, 0)).toBe(0)
  })

  it('按压与悬停通过组合曲线衔接，松手落回悬停预抬升', () => {
    expect(combineLift(0, HOVER_SWELL)).toBeCloseTo(0.4)
    expect(combineLift(1, HOVER_SWELL)).toBeCloseTo(1)
    expect(combineLift(0.5, HOVER_SWELL)).toBeCloseTo(0.7)
    expect(combineLift(-0.2, 0)).toBe(0)
  })

  it('做统一等比膨胀与纯轴向位移拉伸，不施加旋转斜切或反向压扁', () => {
    const bar = { width: 128, height: 32, lift: 1, pullX: 0, pullY: 0 }
    expect(elasticTransform(bar)).toBe('translate3d(0px, 0px, 0) scale(1.125, 1.125)')

    const diagonal = elasticTransform({ width: 40, height: 40, lift: 0, pullX: 6, pullY: 8 })
    expect(diagonal).toBe('translate3d(6px, 8px, 0) scale(1.075, 1.1)')
    expect(diagonal).not.toContain('rotate')

    expect(elasticTransform({ ...bar, width: 0 })).toBe('none')
  })

  it('解析弹簧：PRESS_SPRING 与 SETTLE_SPRING 欠阻尼回弹，TRACK_SPRING 临界阻尼零过冲', () => {
    expect(PRESS_SPRING).toEqual({ stiffness: 311, dampingRatio: 0.593 })
    expect(SETTLE_SPRING.dampingRatio).toBeCloseTo(0.68)

    let value = 0
    let velocity = 0
    let peak = 0
    for (let frame = 0; frame < 60; frame += 1) {
      const next = springToward(value, velocity, 1, 1 / 60)
      value = next.value
      velocity = next.velocity
      peak = Math.max(peak, value)
    }
    expect(peak).toBeGreaterThan(1.04)
    expect(value).toBeCloseTo(1, 2)

    let trackValue = 0
    let trackVelocity = 0
    let trackPeak = 0
    for (let frame = 0; frame < 15; frame += 1) {
      const next = stepSpring(
        { value: trackValue, velocity: trackVelocity },
        { ...TRACK_SPRING, target: 10, deltaSeconds: 1 / 60 },
      )
      trackValue = next.value
      trackVelocity = next.velocity
      trackPeak = Math.max(trackPeak, trackValue)
    }
    expect(trackPeak).toBeLessThanOrEqual(10.001)
    expect(trackValue).toBeGreaterThan(9.8)
  })
})
