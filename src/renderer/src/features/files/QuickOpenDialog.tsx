import { File, LoaderCircle, Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useProjectWorkspace } from '../project-workspace/ProjectWorkspaceProvider.tsx'
import type { FileIndexQueryResult } from '../project-workspace/project-types.ts'

interface QuickOpenDialogProps {
  open: boolean
  onClose(): void
}

const EMPTY_RESULT: FileIndexQueryResult = {
  items: [],
  hasMore: false,
}

const focusableSelector = [
  'button:not([disabled])',
  'input:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function QuickOpenDialog({ open, onClose }: QuickOpenDialogProps) {
  const workspace = useProjectWorkspace()
  const buildFileIndex = workspace.buildFileIndex
  const queryFiles = workspace.queryFiles
  const openFile = workspace.openFile
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<FileIndexQueryResult>(EMPTY_RESULT)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const dialogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const requestGeneration = useRef(0)

  useEffect(() => {
    if (!open) return
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    setQuery('')
    setResult(EMPTY_RESULT)
    setError(null)
    setActiveIndex(0)
    if (workspace.fileIndexStatus.phase === 'idle' || workspace.fileIndexStatus.phase === 'error') {
      void buildFileIndex()
    }
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
      const first = focusable[0]
      const last = focusable.at(-1)
      if (first === undefined || last === undefined) {
        event.preventDefault()
        return
      }
      if (event.shiftKey && document.activeElement === first) {
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
      requestGeneration.current += 1
      previousFocusRef.current?.focus()
      previousFocusRef.current = null
    }
  }, [buildFileIndex, onClose, open])

  useEffect(() => {
    if (!open) return
    const generation = ++requestGeneration.current
    setLoading(true)
    setError(null)
    const timer = window.setTimeout(
      () => {
        void queryFiles(query)
          .then(value => {
            if (requestGeneration.current !== generation) return
            setResult(value)
            setActiveIndex(0)
          })
          .catch((caught: unknown) => {
            if (requestGeneration.current !== generation) return
            setResult(EMPTY_RESULT)
            setError(caught instanceof Error ? caught.message : '无法搜索项目文件')
          })
          .finally(() => {
            if (requestGeneration.current === generation) setLoading(false)
          })
      },
      query.trim() === '' ? 0 : 100,
    )
    return () => {
      window.clearTimeout(timer)
    }
  }, [open, query, queryFiles])

  useEffect(() => {
    const element = document.getElementById(`quick-open-result-${String(activeIndex)}`)
    if (typeof element?.scrollIntoView === 'function') element.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  if (!open) return null

  const choose = (index: number) => {
    const item = result.items[index]
    if (item === undefined) return
    void openFile(item.relativePath)
    onClose()
  }

  return createPortal(
    <div
      className="quick-open-backdrop"
      onClick={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        className="quick-open-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="quick-open-title"
        aria-describedby="quick-open-description"
      >
        <header>
          <div>
            <h2 id="quick-open-title">快速打开文件</h2>
            <p id="quick-open-description">按文件名或相对路径查找当前项目中的文件。</p>
          </div>
          <button type="button" aria-label="关闭快速打开" onClick={onClose}>
            <X size={17} aria-hidden="true" />
          </button>
        </header>
        <label className="quick-open-input">
          <Search size={16} aria-hidden="true" />
          <span className="visually-hidden">文件名或相对路径</span>
          <input
            ref={inputRef}
            type="search"
            role="combobox"
            aria-expanded="true"
            aria-controls="quick-open-results"
            aria-activedescendant={
              result.items[activeIndex] === undefined
                ? undefined
                : `quick-open-result-${String(activeIndex)}`
            }
            value={query}
            placeholder="输入文件名或路径"
            autoComplete="off"
            spellCheck="false"
            maxLength={256}
            onChange={event => {
              setQuery(event.currentTarget.value)
            }}
            onKeyDown={event => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setActiveIndex(index => Math.min(index + 1, Math.max(0, result.items.length - 1)))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setActiveIndex(index => Math.max(0, index - 1))
              } else if (event.key === 'Enter') {
                event.preventDefault()
                choose(activeIndex)
              }
            }}
          />
          {loading && <LoaderCircle className="spin" size={14} aria-label="正在搜索" />}
        </label>
        <p className="quick-open-status" aria-live="polite">
          {workspace.fileIndexStatus.phase === 'building'
            ? '正在建立项目文件索引…'
            : error !== null
              ? error
              : query.trim() === ''
                ? `已索引 ${String(workspace.fileIndexStatus.fileCount)} 个文件，显示 ${String(result.items.length)} 个`
                : `${String(result.items.length)} 个匹配文件`}
        </p>
        <ul
          id="quick-open-results"
          className="quick-open-results"
          role="listbox"
          aria-label="文件搜索结果"
        >
          {result.items.map((item, index) => (
            <li key={item.relativePath}>
              <button
                id={`quick-open-result-${String(index)}`}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className={index === activeIndex ? 'is-active' : ''}
                onMouseEnter={() => {
                  setActiveIndex(index)
                }}
                onClick={() => {
                  choose(index)
                }}
              >
                <File size={15} aria-hidden="true" />
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.directory === '' ? '项目根目录' : item.directory}</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {!loading && error === null && result.items.length === 0 && (
          <p className="quick-open-empty" role="status">
            {query.trim() === ''
              ? '当前项目没有可索引的文件。'
              : `没有找到与“${query.trim()}”匹配的文件。`}
          </p>
        )}
        {result.hasMore && (
          <p className="quick-open-notice">结果超过 100 个，请继续输入以缩小范围。</p>
        )}
        {workspace.fileIndexStatus.phase === 'partial' && (
          <p className="quick-open-notice">
            {workspace.fileIndexStatus.message ?? '当前索引只完成了一部分。'}
          </p>
        )}
      </div>
    </div>,
    document.body,
  )
}
