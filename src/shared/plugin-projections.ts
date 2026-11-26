import { isRecord } from './validation.ts'
export type ProjectionJson =
  | null
  | boolean
  | number
  | string
  | readonly ProjectionJson[]
  | { readonly [key: string]: ProjectionJson }

export const PROJECTION_VALUE_MAX_BYTES = 128 * 1024
export const PROJECTION_SESSION_MAX_BYTES = 1024 * 1024
export const PROJECTION_MAX_KEYS = 128
const TOTAL_MAX_BYTES = 8 * 1024 * 1024
const MAX_SESSIONS = 256
const encoder = new TextEncoder()

export interface PluginProjectionChange {
  readonly kind: 'snapshot' | 'patch'
  readonly asOfSeq: number
  readonly values: Readonly<Record<string, ProjectionJson>>
  readonly omitted: number
}

export interface PluginProjectionSnapshot {
  readonly asOfSeq: number
  readonly values: Readonly<Record<string, ProjectionJson>>
  readonly omitted: number
}

export function isDedicatedProjection(key: string): boolean {
  return key === 'title' || key === 'modelSelection' || key === 'permissions' || key === 'inbox'
}

function jsonBytes(value: unknown): number | null {
  let nodes = 0
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > 8192 || depth > 24) return false
    if (item === null || typeof item === 'boolean') return true
    if (typeof item === 'number') return Number.isFinite(item)
    if (typeof item === 'string') return item.length <= PROJECTION_VALUE_MAX_BYTES
    if (Array.isArray(item))
      return item.length <= 8192 && item.every(child => visit(child, depth + 1))
    if (
      !isRecord(item) ||
      (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
    )
      return false
    return Object.entries(item).every(
      ([key, child]) => key.length <= PROJECTION_VALUE_MAX_BYTES && visit(child, depth + 1),
    )
  }
  try {
    if (!visit(value, 0)) return null
    const bytes = encoder.encode(JSON.stringify(value)).byteLength
    return bytes <= PROJECTION_VALUE_MAX_BYTES ? bytes : null
  } catch {
    return null
  }
}

/** 只接收有界 JSON；未知键作为数据保留，已知控制投影始终走各自的严格解析。 */
export function parsePluginProjectionChange(input: unknown): PluginProjectionChange | null {
  if (
    !isRecord(input) ||
    (input.kind !== 'snapshot' && input.kind !== 'patch') ||
    !Number.isSafeInteger(input.asOfSeq) ||
    (input.asOfSeq as number) < (input.kind === 'snapshot' ? -1 : 0) ||
    !isRecord(input.values)
  )
    return null
  const values: Record<string, ProjectionJson> = Object.create(null) as Record<
    string,
    ProjectionJson
  >
  let omitted =
    Number.isSafeInteger(input.omitted) && (input.omitted as number) >= 0
      ? Math.min(input.omitted as number, 1_000_000)
      : 0
  let bytes = 0
  let count = 0
  for (const [key, value] of Object.entries(input.values)) {
    if (isDedicatedProjection(key)) continue
    const valueSize = jsonBytes(value)
    const size = valueSize === null ? null : valueSize + encoder.encode(key).byteLength
    if (
      key.length === 0 ||
      key.length > 160 ||
      [...key].some(character => character.charCodeAt(0) < 32) ||
      size === null ||
      count >= PROJECTION_MAX_KEYS ||
      bytes + size > PROJECTION_SESSION_MAX_BYTES
    ) {
      omitted = Math.min(omitted + 1, 1_000_000)
      continue
    }
    values[key] = value as ProjectionJson
    bytes += size
    count += 1
  }
  return { kind: input.kind, asOfSeq: input.asOfSeq as number, values, omitted }
}

interface SessionProjectionState {
  baseline: number
  values: Map<string, { value: ProjectionJson; seq: number; bytes: number }>
  bytes: number
  omitted: number
}

/** 每个流或工作台实例独占一个缓存；基线可删除旧键，迟到基线保留更晚的逐键增量。 */
export class PluginProjectionCache {
  private readonly sessions = new Map<string, SessionProjectionState>()
  private bytes = 0

  clear(): void {
    this.sessions.clear()
    this.bytes = 0
  }

  delete(sessionId: string): void {
    this.bytes -= this.sessions.get(sessionId)?.bytes ?? 0
    this.sessions.delete(sessionId)
  }

  apply(sessionId: string, change: PluginProjectionChange): boolean {
    let state = this.sessions.get(sessionId)
    if (state === undefined) {
      if (this.sessions.size >= MAX_SESSIONS) return false
      state = { baseline: -2, values: new Map(), bytes: 0, omitted: 0 }
      this.sessions.set(sessionId, state)
    }
    if (
      change.asOfSeq < state.baseline ||
      (change.kind === 'patch' && change.asOfSeq <= state.baseline)
    )
      return false
    let changed = change.kind === 'snapshot' || change.omitted > 0
    if (change.kind === 'snapshot') {
      for (const [key, entry] of state.values) {
        if (entry.seq > change.asOfSeq) continue
        state.values.delete(key)
        state.bytes -= entry.bytes
        this.bytes -= entry.bytes
      }
      state.baseline = change.asOfSeq
      state.omitted = change.omitted
    } else state.omitted = Math.min(state.omitted + change.omitted, 1_000_000)
    for (const [key, value] of Object.entries(change.values)) {
      const previous = state.values.get(key)
      if (previous !== undefined && previous.seq >= change.asOfSeq) continue
      const valueSize = jsonBytes(value)
      const size = valueSize === null ? null : valueSize + encoder.encode(key).byteLength
      const delta = (size ?? 0) - (previous?.bytes ?? 0)
      if (
        size === null ||
        (previous === undefined && state.values.size >= PROJECTION_MAX_KEYS) ||
        state.bytes + delta > PROJECTION_SESSION_MAX_BYTES ||
        this.bytes + delta > TOTAL_MAX_BYTES
      ) {
        state.omitted = Math.min(state.omitted + 1, 1_000_000)
        changed = true
        continue
      }
      state.values.set(key, { value, seq: change.asOfSeq, bytes: size })
      state.bytes += delta
      this.bytes += delta
      changed = true
    }
    return changed
  }

  read(sessionId: string): PluginProjectionSnapshot | undefined {
    const state = this.sessions.get(sessionId)
    if (state === undefined) return undefined
    return {
      asOfSeq: Math.max(state.baseline, ...[...state.values.values()].map(entry => entry.seq)),
      values: Object.fromEntries([...state.values].map(([key, entry]) => [key, entry.value])),
      omitted: state.omitted,
    }
  }
}
