export const PINNED_SESSION_IDS_STORAGE_KEY = 'mydsh:pinned-session-ids'

export interface SessionPinStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const MAX_PINNED_SESSION_IDS = 200
const MAX_SESSION_ID_LENGTH = 512

function isValidSessionId(sessionId: unknown): sessionId is string {
  return (
    typeof sessionId === 'string' && sessionId !== '' && sessionId.length <= MAX_SESSION_ID_LENGTH
  )
}

function normalizeSessionIds(sessionIds: readonly string[]): string[] {
  const normalized: string[] = []
  const seen = new Set<string>()

  for (const sessionId of sessionIds) {
    if (!isValidSessionId(sessionId)) continue
    if (seen.has(sessionId)) continue
    seen.add(sessionId)
    normalized.push(sessionId)
    if (normalized.length >= MAX_PINNED_SESSION_IDS) break
  }

  return normalized
}

function readStoredSessionIds(raw: string): string[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (!Array.isArray(parsed)) return null

  const sessionIds: string[] = []
  for (const value of parsed) {
    if (!isValidSessionId(value)) return null
    sessionIds.push(value)
  }

  return sessionIds
}

export function readPinnedSessionIds(storage: SessionPinStorage): readonly string[] {
  try {
    const raw = storage.getItem(PINNED_SESSION_IDS_STORAGE_KEY)
    if (raw === null || raw.trim() === '') return []
    const sessionIds = readStoredSessionIds(raw)
    return sessionIds === null ? [] : normalizeSessionIds(sessionIds)
  } catch {
    return []
  }
}

export function persistPinnedSessionIds(
  storage: SessionPinStorage,
  sessionIds: readonly string[],
): readonly string[] {
  const normalized = normalizeSessionIds(sessionIds)
  try {
    storage.setItem(PINNED_SESSION_IDS_STORAGE_KEY, JSON.stringify(normalized))
  } catch {
    // 本地缓存不可写时保留调用方内存中的规范化结果。
  }
  return normalized
}

export function togglePinnedSessionId(
  sessionIds: readonly string[],
  sessionId: string,
): readonly string[] {
  const normalized = normalizeSessionIds(sessionIds)
  if (!isValidSessionId(sessionId)) return normalized

  const index = normalized.indexOf(sessionId)
  if (index >= 0) {
    return normalized.filter(existingSessionId => existingSessionId !== sessionId)
  }

  return normalizeSessionIds([sessionId, ...normalized])
}

export function reconcilePinnedSessionIds(
  sessionIds: readonly string[],
  currentSessionIds: readonly string[],
): readonly string[] {
  const currentSessionIdSet = new Set(currentSessionIds.filter(isValidSessionId))
  return normalizeSessionIds(sessionIds.filter(sessionId => currentSessionIdSet.has(sessionId)))
}
