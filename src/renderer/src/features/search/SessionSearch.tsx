import { LoaderCircle, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  DESKTOP_SESSION_SEARCH_RESULT_LIMIT,
  DESKTOP_SESSION_SEARCH_QUERY_MAX_LENGTH,
  sanitizeDesktopSessionSearchQuery,
  type DesktopSessionSearchResult,
} from '../../../../shared/session-capabilities.ts'
import { useWorkspaceSnapshot, useWorkspaceStore } from '../../hooks/useWorkspace.ts'
import { sessionsForProject } from '../../domain/project.ts'
import { relativeTime, sessionTitle } from '../../domain/session.ts'

interface SessionSearchProps {
  open: boolean
  onClose(): void
  onSelectSession?(sessionId: string): void
}

const focusableSelector = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

const SEARCH_DEBOUNCE_MS = 250

type RemoteSearchState = DesktopSessionSearchResult & {
  readonly query: string
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
}

const EMPTY_REMOTE_SEARCH: RemoteSearchState = Object.freeze({
  query: '',
  status: 'idle',
  items: Object.freeze([]),
  hasMore: false,
})

export function SessionSearch({ open, onClose, onSelectSession }: SessionSearchProps) {
  const store = useWorkspaceStore()
  const snapshot = useWorkspaceSnapshot()
  const [query, setQuery] = useState('')
  const [remoteSearch, setRemoteSearch] = useState<RemoteSearchState>(EMPTY_REMOTE_SEARCH)
  const dialogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const searchProjection = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    const projectBySession = new Map<string, string>()
    for (const project of snapshot.projects) {
      for (const session of sessionsForProject(snapshot.sessions, project)) {
        if (!projectBySession.has(session.sessionId))
          projectBySession.set(session.sessionId, project.name)
      }
    }
    const projectLabel = (sessionId: string) => projectBySession.get(sessionId) ?? '无项目对话'
    if (normalized === '') {
      return {
        items: snapshot.sessions.map(session => ({
          session,
          project: projectLabel(session.sessionId),
          snippet: undefined,
        })),
        hasMore: false,
      }
    }

    const remoteItems = remoteSearch.query === normalized ? remoteSearch.items : []
    const remoteBySession = new Map(remoteItems.map(item => [item.sessionId, item]))
    const localMatches = snapshot.sessions.filter(
      session =>
        !session.blank &&
        (sessionTitle(session).toLocaleLowerCase().includes(normalized) ||
          projectLabel(session.sessionId).toLocaleLowerCase().includes(normalized)),
    )
    const ordered = [...localMatches]
    const included = new Set(localMatches.map(session => session.sessionId))
    for (const item of remoteItems) {
      const session = snapshot.sessions.find(candidate => candidate.sessionId === item.sessionId)
      if (session === undefined || session.blank || included.has(session.sessionId)) continue
      included.add(session.sessionId)
      ordered.push(session)
    }
    return {
      items: ordered.slice(0, DESKTOP_SESSION_SEARCH_RESULT_LIMIT).map(session => ({
        session,
        project: projectLabel(session.sessionId),
        snippet: remoteBySession.get(session.sessionId)?.snippet,
      })),
      hasMore:
        remoteSearch.query === normalized &&
        (remoteSearch.hasMore || ordered.length > DESKTOP_SESSION_SEARCH_RESULT_LIMIT),
    }
  }, [query, remoteSearch, snapshot.projects, snapshot.sessions])

  useEffect(() => {
    if (!open) return
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    setQuery('')
    setRemoteSearch(EMPTY_REMOTE_SEARCH)
    const focusFrame = window.requestAnimationFrame(() => {
      inputRef.current?.focus()
    })

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return

      const dialog = dialogRef.current
      if (dialog === null) return
      const focusable = [...dialog.querySelectorAll<HTMLElement>(focusableSelector)]
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusable[0]
      const last = focusable.at(-1)
      if (first === undefined || last === undefined) return
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault()
        const destination = event.shiftKey ? last : first
        destination.focus()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.removeEventListener('keydown', handleKeyDown)
      // 搜索结果可能打开第二个标签，使入口从侧栏移至顶部。
      const returnTarget =
        previousFocusRef.current?.isConnected === true
          ? previousFocusRef.current
          : document.querySelector<HTMLButtonElement>(
              'button[aria-controls="session-search-dialog"]',
            )
      returnTarget?.focus()
      previousFocusRef.current = null
      store.cancelSessionSearch()
    }
  }, [onClose, open, store])

  useEffect(() => {
    if (!open) return
    const normalized = query.trim().toLocaleLowerCase()
    if (normalized === '') {
      store.cancelSessionSearch()
      setRemoteSearch(EMPTY_REMOTE_SEARCH)
      return
    }
    setRemoteSearch({ query: normalized, status: 'loading', items: [], hasMore: false })
    let active = true
    const timer = window.setTimeout(() => {
      void store
        .searchSessions(normalized)
        .then(result => {
          if (!active) return
          setRemoteSearch({ query: normalized, status: 'ready', ...result })
        })
        .catch(() => {
          if (!active) return
          setRemoteSearch({ query: normalized, status: 'error', items: [], hasMore: false })
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      active = false
      window.clearTimeout(timer)
      store.cancelSessionSearch()
    }
  }, [open, query, store])

  if (!open) return null

  const selectSession = (sessionId: string) => {
    if (onSelectSession === undefined) {
      store.selectProject(null)
      store.selectSession(sessionId)
    } else {
      onSelectSession(sessionId)
    }
    onClose()
  }

  return createPortal(
    <div
      className="session-search-backdrop"
      onClick={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        id="session-search-dialog"
        ref={dialogRef}
        className="session-search-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-search-title"
        aria-describedby="session-search-description"
      >
        <header>
          <div>
            <h2 id="session-search-title">搜索会话</h2>
            <p id="session-search-description">搜索全部会话的标题、所属项目和已保存的聊天内容。</p>
          </div>
          <button
            className="session-search-close"
            type="button"
            aria-label="关闭会话搜索"
            onClick={onClose}
          >
            <X size={17} aria-hidden="true" />
          </button>
        </header>

        <label className="session-search-input">
          <Search size={16} aria-hidden="true" />
          <span className="visually-hidden">会话搜索词</span>
          <input
            ref={inputRef}
            type="search"
            value={query}
            placeholder="搜索标题、项目或聊天内容"
            autoComplete="off"
            spellCheck="false"
            aria-controls="session-search-results"
            maxLength={DESKTOP_SESSION_SEARCH_QUERY_MAX_LENGTH}
            onChange={event => {
              setQuery(sanitizeDesktopSessionSearchQuery(event.currentTarget.value))
            }}
          />
        </label>

        <p className="session-search-count" aria-live="polite">
          {remoteSearch.status === 'loading' && query.trim() !== '' ? (
            <>
              <LoaderCircle className="spin" size={13} aria-hidden="true" />
              正在搜索已保存内容…
            </>
          ) : query.trim() === '' ? (
            `${String(searchProjection.items.length)} 个会话`
          ) : (
            `${String(searchProjection.items.length)} 个匹配结果`
          )}
        </p>
        <ul
          id="session-search-results"
          className="session-search-results"
          aria-label="会话搜索结果"
        >
          {searchProjection.items.map(({ session, project, snippet }) => (
            <li key={session.sessionId}>
              <button
                className={`session-search-result${session.sessionId === snapshot.selectedSessionId ? ' is-active' : ''}`}
                type="button"
                aria-current={session.sessionId === snapshot.selectedSessionId ? 'true' : undefined}
                onClick={() => {
                  selectSession(session.sessionId)
                }}
              >
                <span>
                  <strong>{sessionTitle(session)}</strong>
                  <small>{project}</small>
                  {snippet !== undefined && snippet !== '' && (
                    <span className="session-search-result__snippet">{snippet}</span>
                  )}
                </span>
                <time>{relativeTime(session.updatedAt)}</time>
              </button>
            </li>
          ))}
        </ul>
        {remoteSearch.status === 'error' && query.trim() !== '' && (
          <p className="session-search-notice" role="status">
            内容搜索暂不可用，当前仍显示标题和项目名称匹配。
          </p>
        )}
        {searchProjection.hasMore && (
          <p className="session-search-notice">结果超过 20 个，请缩小搜索范围。</p>
        )}
        {searchProjection.items.length === 0 && remoteSearch.status !== 'loading' && (
          <p className="session-search-empty" role="status">
            {query.trim() === '' ? '当前还没有会话。' : `没有找到与“${query.trim()}”相关的会话。`}
          </p>
        )}
      </div>
    </div>,
    document.body,
  )
}
