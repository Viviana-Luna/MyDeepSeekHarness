import { CaseSensitive, FileSearch, LoaderCircle, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useProjectWorkspace } from '../project-workspace/ProjectWorkspaceProvider.tsx'
import type { ContentSearchResult } from '../project-workspace/project-types.ts'
import { AppAlert } from '../../shared/ui/AppAlert.tsx'

interface ProjectSearchDialogProps {
  open: boolean
  onClose(): void
}

const EMPTY_RESULT: ContentSearchResult = Object.freeze({
  items: Object.freeze([]),
  hasMore: false,
})

export function ProjectSearchDialog({ open, onClose }: ProjectSearchDialogProps) {
  const workspace = useProjectWorkspace()
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [result, setResult] = useState<ContentSearchResult>(EMPTY_RESULT)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const requestGeneration = useRef(0)
  const groups = useMemo(() => {
    const byPath = new Map<string, ContentSearchResult['items'][number][]>()
    for (const item of result.items) {
      const current = byPath.get(item.relativePath)
      if (current === undefined) byPath.set(item.relativePath, [item])
      else current.push(item)
    }
    return [...byPath.entries()]
  }, [result.items])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setCaseSensitive(false)
    setResult(EMPTY_RESULT)
    setError(null)
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus()
    })
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKeyDown)
      requestGeneration.current += 1
      workspace.cancelContentSearch()
    }
  }, [onClose, open])

  useEffect(() => {
    if (!open) return
    const normalized = query.trim()
    if (normalized === '') {
      requestGeneration.current += 1
      workspace.cancelContentSearch()
      setResult(EMPTY_RESULT)
      setLoading(false)
      setError(null)
      return
    }
    const generation = ++requestGeneration.current
    setLoading(true)
    setError(null)
    const timer = window.setTimeout(() => {
      void workspace
        .searchContent(normalized, caseSensitive)
        .then(value => {
          if (requestGeneration.current === generation) setResult(value)
        })
        .catch((caught: unknown) => {
          if (requestGeneration.current !== generation) return
          const message = caught instanceof Error ? caught.message : '无法搜索项目内容'
          if (!message.includes('已取消')) setError(message)
          setResult(EMPTY_RESULT)
        })
        .finally(() => {
          if (requestGeneration.current === generation) setLoading(false)
        })
    }, 180)
    return () => {
      window.clearTimeout(timer)
    }
  }, [caseSensitive, open, query, workspace])

  if (!open) return null

  const choose = (relativePath: string, line: number) => {
    void workspace.openFile(relativePath, line)
    onClose()
  }

  return createPortal(
    <div
      className="project-search-backdrop"
      onClick={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        className="project-search-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-search-title"
        aria-describedby="project-search-description"
      >
        <header>
          <div>
            <h2 id="project-search-title">搜索项目内容</h2>
            <p id="project-search-description">在当前项目的可见文本文件中查找普通文本。</p>
          </div>
          <button type="button" aria-label="关闭项目内容搜索" onClick={onClose}>
            <X size={17} aria-hidden="true" />
          </button>
        </header>
        <div className="project-search-controls">
          <label>
            <Search size={16} aria-hidden="true" />
            <span className="visually-hidden">项目内容搜索词</span>
            <input
              ref={inputRef}
              type="search"
              value={query}
              maxLength={256}
              placeholder="输入要查找的文本"
              autoComplete="off"
              spellCheck="false"
              onChange={event => {
                setQuery(event.currentTarget.value)
              }}
            />
            {loading && <LoaderCircle className="spin" size={14} aria-label="正在搜索项目内容" />}
          </label>
          <button
            type="button"
            aria-label="区分大小写"
            aria-pressed={caseSensitive}
            title="区分大小写"
            onClick={() => {
              setCaseSensitive(value => !value)
            }}
          >
            <CaseSensitive size={17} aria-hidden="true" />
          </button>
        </div>
        <p className="project-search-status" aria-live="polite">
          {query.trim() === ''
            ? '输入文本后开始搜索；新查询会停止上一轮搜索。'
            : loading
              ? '正在搜索当前项目…'
              : `找到 ${String(result.items.length)} 处匹配，分布于 ${String(groups.length)} 个文件`}
        </p>
        {error !== null && (
          <div className="project-search-alert">
            <AppAlert
              tone="error"
              title="项目内容搜索失败"
              onClose={() => {
                setError(null)
              }}
            >
              {error}
            </AppAlert>
          </div>
        )}
        <div className="project-search-results" aria-label="项目内容搜索结果">
          {groups.map(([relativePath, items]) => (
            <section key={relativePath} className="project-search-group">
              <h3>
                <FileSearch size={14} aria-hidden="true" />
                {relativePath}
                <span>{items.length}</span>
              </h3>
              <ul>
                {items.map(item => (
                  <li key={`${item.relativePath}:${String(item.line)}:${String(item.column)}`}>
                    <button
                      type="button"
                      onClick={() => {
                        choose(item.relativePath, item.line)
                      }}
                    >
                      <span>
                        {item.line}:{item.column}
                      </span>
                      <code>{item.preview === '' ? '空行' : item.preview}</code>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {!loading && error === null && query.trim() !== '' && result.items.length === 0 && (
            <p className="project-search-empty">当前项目没有匹配内容。</p>
          )}
        </div>
        {result.hasMore && <footer>结果超过 200 处；请缩小搜索词以查看更精确的匹配。</footer>}
      </section>
    </div>,
    document.body,
  )
}
