import { asRecord, type UnknownRecord } from '../../../shared/validation.ts'

export interface SessionCostProjection {
  readonly amount: number
  readonly unit: string
  readonly estimated: boolean
}

function amount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function explicitUsd(source: UnknownRecord): SessionCostProjection | null {
  for (const key of ['costUsd', 'costUSD', 'totalUsd', 'amountUsd', 'usd']) {
    const value = amount(source[key])
    if (value !== null) {
      return {
        amount: value,
        unit: 'USD',
        estimated: source.estimated === true || source.exact === false,
      }
    }
  }
  return null
}

function explicitCredits(source: UnknownRecord): SessionCostProjection | null {
  for (const key of ['credits', 'creditCost', 'totalCredits']) {
    const value = amount(source[key])
    if (value !== null) {
      return {
        amount: value,
        unit: 'Credits',
        estimated: source.estimated === true || source.exact === false,
      }
    }
  }
  return null
}

function monetaryObject(source: UnknownRecord): SessionCostProjection | null {
  const usd = explicitUsd(source)
  if (usd !== null) return usd
  const credits = explicitCredits(source)
  if (credits !== null) return credits
  const value = amount(source.amount) ?? amount(source.total) ?? amount(source.value)
  const unit = typeof source.currency === 'string' ? source.currency.trim().toUpperCase() : ''
  if (value === null || !/^[A-Z]{3}$/u.test(unit)) return null
  return {
    amount: value,
    unit,
    estimated: source.estimated === true || source.exact === false,
  }
}

/**
 * 只接受明确携带币种或 Credits 单位的费用投影；没有单位的裸数字不作推断。
 */
export function projectSessionCost(values: UnknownRecord): SessionCostProjection | null {
  const directUsd = explicitUsd(values)
  if (directUsd !== null) return directUsd
  const directCredits = explicitCredits(values)
  if (directCredits !== null) return directCredits

  const tokenUsage = asRecord(values.tokenUsage)
  if (tokenUsage !== null) {
    const usageCost = monetaryObject(tokenUsage)
    if (usageCost !== null) return usageCost
  }

  for (const key of ['cost', 'sessionCost', 'usageCost']) {
    const source = asRecord(values[key])
    if (source === null) continue
    const projected = monetaryObject(source)
    if (projected !== null) return projected
  }
  return null
}

export function formatSessionCost(projection: SessionCostProjection): string {
  if (/^[A-Z]{3}$/u.test(projection.unit)) {
    try {
      return new Intl.NumberFormat('zh-CN', {
        style: 'currency',
        currency: projection.unit,
        maximumFractionDigits: 4,
      }).format(projection.amount)
    } catch {
      // Host 可能返回运行时尚不认识的 ISO 币种，保留明确单位即可。
    }
  }
  return `${projection.amount.toLocaleString('zh-CN', { maximumFractionDigits: 4 })} ${projection.unit}`
}
