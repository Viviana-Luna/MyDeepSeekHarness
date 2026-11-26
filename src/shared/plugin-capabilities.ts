export interface DesktopGoalRef {
  readonly id: string
  readonly revision: number
}
export interface DesktopGoal extends DesktopGoalRef {
  readonly objective: string
  readonly phase: 'active' | 'paused' | 'blocked' | 'complete'
  readonly activation: 'armed' | 'disarmed'
  readonly maxGoalRounds: number
  readonly roundsStarted: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly blockedReason?: { readonly code: string; readonly message: string }
}

export type DesktopSubagent =
  | {
      readonly kind: 'child'
      readonly id: string
      readonly activity: 'running' | 'inactive'
      readonly hasChildren: boolean
      readonly mode: 'one-shot' | 'continuable'
      readonly label?: string
    }
  | {
      readonly kind: 'diagnostic'
      readonly id: string
      readonly reason: 'corrupt' | 'unsupported' | 'unavailable'
    }
export interface DesktopSubagentCatalog {
  readonly entries: readonly DesktopSubagent[]
  readonly parentAvailable: boolean
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('DSH 插件返回了无效的数据结构')
  return value as Record<string, unknown>
}
function text(value: unknown, maximum = 512): string {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.length > maximum ||
    value.includes('\0')
  ) {
    throw new Error('DSH 插件返回了无效的文本字段')
  }
  return value
}
function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
    throw new Error('DSH 插件返回了无效的数字字段')
  return value
}

export function parseDesktopGoalRef(value: unknown): DesktopGoalRef {
  const item = record(value)
  return { id: text(item.id), revision: integer(item.revision, 1) }
}

export function parseDesktopGoal(value: unknown): DesktopGoal | null {
  if (value === undefined || value === null) return null
  const item = record(value)
  if (
    item.phase !== 'active' &&
    item.phase !== 'paused' &&
    item.phase !== 'blocked' &&
    item.phase !== 'complete'
  )
    throw new Error('DSH 目标阶段无效')
  if (item.activation !== 'armed' && item.activation !== 'disarmed')
    throw new Error('DSH 目标激活状态无效')
  const blocked = item.blockedReason === undefined ? undefined : record(item.blockedReason)
  if ((item.phase === 'blocked') !== (blocked !== undefined))
    throw new Error('DSH 目标阻塞原因无效')
  return {
    ...parseDesktopGoalRef(item),
    objective: text(item.objective, 16 * 1024),
    phase: item.phase,
    activation: item.activation,
    maxGoalRounds: integer(item.maxGoalRounds, 1),
    roundsStarted: integer(item.roundsStarted),
    createdAt: integer(item.createdAt),
    updatedAt: integer(item.updatedAt),
    ...(blocked === undefined
      ? {}
      : { blockedReason: { code: text(blocked.code, 160), message: text(blocked.message, 4096) } }),
  }
}

export function parseDesktopSubagentCatalog(value: unknown): DesktopSubagentCatalog {
  const catalog = record(value)
  if (
    !Array.isArray(catalog.entries) ||
    catalog.entries.length > 256 ||
    typeof catalog.parentAvailable !== 'boolean'
  ) {
    throw new Error('DSH 子智能体目录无效或超过 256 项')
  }
  const entries = catalog.entries.map((entry): DesktopSubagent => {
    const item = record(entry)
    const id = text(item.id)
    if (
      item.kind === 'diagnostic' &&
      (item.reason === 'corrupt' || item.reason === 'unsupported' || item.reason === 'unavailable')
    ) {
      return { kind: 'diagnostic', id, reason: item.reason }
    }
    if (
      item.kind !== 'child' ||
      (item.activity !== 'running' && item.activity !== 'inactive') ||
      (item.mode !== 'one-shot' && item.mode !== 'continuable') ||
      typeof item.hasChildren !== 'boolean'
    ) {
      throw new Error('DSH 子智能体条目无效')
    }
    const label =
      item.label === undefined && item.mode === 'one-shot' ? undefined : text(item.label, 1024)
    return {
      kind: 'child',
      id,
      activity: item.activity,
      hasChildren: item.hasChildren,
      mode: item.mode,
      ...(label === undefined ? {} : { label }),
    }
  })
  if (new Set(entries.map(entry => entry.id)).size !== entries.length)
    throw new Error('DSH 子智能体目录包含重复会话')
  return { entries, parentAvailable: catalog.parentAvailable }
}

export function parseDesktopSubagentPromptReceipt(value: unknown): { messageId: string } {
  return { messageId: text(record(value).messageId) }
}

export function parseDesktopSubagentInterruptReceipt(value: unknown): { accepted: true } {
  if (record(value).accepted !== true) throw new Error('DSH 未接受子智能体中断请求')
  return { accepted: true }
}
