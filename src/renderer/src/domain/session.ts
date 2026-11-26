import { isRecord } from '../../../shared/validation.ts'
export interface SessionProjectionSet {
  asOfSeq?: number
  values?: Record<string, unknown>
  omitted?: number
}

export interface SessionSummary {
  sessionId: string
  updatedAt: number
  running: boolean
  blank: boolean
  cwd?: string
  agentPreset?: string
  title?: string
  name?: string
  projections?: SessionProjectionSet
}

export interface SessionListResult {
  items: SessionSummary[]
}

export function parseSessionList(value: unknown): SessionListResult {
  if (!isRecord(value) || !Array.isArray(value.items)) return { items: [] }
  const items = value.items.flatMap(item => {
    if (!isRecord(item) || typeof item.sessionId !== 'string' || item.sessionId === '') return []
    const updatedAt = Number(item.updatedAt)
    const session: SessionSummary = {
      sessionId: item.sessionId,
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
      running: item.running === true || item.status === 'running',
      blank: item.blank === true,
    }
    if (typeof item.cwd === 'string' && item.cwd !== '') session.cwd = item.cwd
    if (typeof item.agentPreset === 'string' && item.agentPreset !== '')
      session.agentPreset = item.agentPreset
    if (typeof item.title === 'string') session.title = item.title
    if (typeof item.name === 'string') session.name = item.name
    if (isRecord(item.projections)) session.projections = item.projections
    return [session]
  })
  return { items: items.toSorted((left, right) => right.updatedAt - left.updatedAt) }
}

export function sessionTitle(session: SessionSummary): string {
  const projected = session.projections?.values?.title
  if (typeof projected === 'string' && projected.trim() !== '') return projected
  if (session.title?.trim()) return session.title
  if (session.name?.trim()) return session.name
  return session.blank ? '新会话' : '未命名会话'
}

export function relativeTime(value: number, now = Date.now()): string {
  if (!Number.isFinite(value) || value <= 0) return '最近'
  const seconds = Math.max(0, Math.round((now - value) / 1_000))
  if (seconds < 60) return '刚刚'
  if (seconds < 3_600) return `${String(Math.floor(seconds / 60))} 分钟前`
  if (seconds < 86_400) return `${String(Math.floor(seconds / 3_600))} 小时前`
  return `${String(Math.floor(seconds / 86_400))} 天前`
}
