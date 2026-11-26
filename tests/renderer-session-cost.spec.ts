import { describe, expect, it } from 'vitest'

import { formatSessionCost, projectSessionCost } from '../src/renderer/src/domain/session-cost.ts'

describe('会话费用投影', () => {
  it('读取带币种的精确或估算累计值', () => {
    expect(
      projectSessionCost({
        cost: { amount: 0.86, currency: 'cny', estimated: true },
      }),
    ).toEqual({ amount: 0.86, unit: 'CNY', estimated: true })

    expect(
      projectSessionCost({
        tokenUsage: { costUsd: 0.42, exact: true },
      }),
    ).toEqual({ amount: 0.42, unit: 'USD', estimated: false })
  })

  it('读取 Credits，但拒绝没有单位的裸费用数字', () => {
    expect(projectSessionCost({ sessionCost: { credits: 12.5 } })).toEqual({
      amount: 12.5,
      unit: 'Credits',
      estimated: false,
    })
    expect(projectSessionCost({ cost: 0.86 })).toBeNull()
    expect(projectSessionCost({ cost: { amount: 0.86 } })).toBeNull()
  })

  it('格式化费用时保留明确单位', () => {
    expect(formatSessionCost({ amount: 12.5, unit: 'Credits', estimated: false })).toBe(
      '12.5 Credits',
    )
    expect(formatSessionCost({ amount: 0.42, unit: 'USD', estimated: false })).toContain('0.42')
  })
})
