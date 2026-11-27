import { ArrowDownToLine, ChevronRight, Clock3, Download, FoldVertical, Search } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DesktopSessionLogExportResult } from '../../platform/contracts.ts'
import { TraceInspector } from './TraceInspector.tsx'
import { TraceTimeline, type TraceRange } from './TraceTimeline.tsx'
import {
  formatTraceDuration,
  projectTrace,
  recordLabels,
  traceDuration,
  traceSummary,
  type TraceRecord,
} from './trajectory-model.ts'
import styles from './TrajectoryView.module.css'

export interface TrajectoryViewProps {
  readonly history: unknown
  readonly loading?: boolean
  readonly error?: string
  readonly running?: boolean
  readonly hasMore?: boolean
  readonly loadingOlder?: boolean
  readonly onLoadOlder?: () => Promise<boolean>
  readonly canExport?: boolean
  readonly onExport?: () => Promise<DesktopSessionLogExportResult>
}
type Row =
  | { kind: 'turn'; id: string; turn: number; duration: number | null; count: number }
  | { kind: 'record'; id: string; record: TraceRecord }
const ROW_HEIGHT = 30

export function TrajectoryView({
  history,
  loading = false,
  error,
  running = false,
  hasMore = false,
  loadingOlder = false,
  onLoadOlder,
  canExport = false,
  onExport,
}: TrajectoryViewProps) {
  const [query, setQuery] = useState('')
  const [actualDuration, setActualDuration] = useState(false)
  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<number>>(new Set())
  const [collapsedCalls, setCollapsedCalls] = useState<ReadonlySet<string>>(new Set())
  const [range, setRange] = useState<TraceRange | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [notice, setNotice] = useState('')
  const [follow, setFollow] = useState(true)
  const [viewport, setViewport] = useState({ top: 0, height: 600 })
  const scroll = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const revealRef = useRef<string | null>(null)
  const previous = useRef<{ first: string | undefined; length: number }>({
    first: undefined,
    length: 0,
  })
  const turns = useMemo(() => projectTrace(history, running), [history, running])
  const records = useMemo(() => turns.flatMap(turn => turn.records), [turns])
  const selected = records.find(record => record.id === selectedId) ?? null
  const groups = useMemo(
    () => [
      ...new Set(
        records
          .filter(record => record.kind === 'model')
          .map(record => `${record.turn}:${record.step}`),
      ),
    ],
    [records],
  )
  const rows = useMemo(() => {
    const result: Row[] = []
    const search = query.trim().toLocaleLowerCase()
    const indexes = new Map(records.map((record, index) => [record.id, index]))
    for (const turn of turns) {
      const matching = turn.records.filter(record => {
        const matches =
          search === '' ||
          `${recordLabels[record.kind]} ${record.text} ${record.thinking ?? ''} 第 ${turn.turn} 轮`
            .toLocaleLowerCase()
            .includes(search)
        if (!matches || range === null) return matches
        const start = actualDuration
          ? (record.startedAt ?? record.endedAt)
          : (indexes.get(record.id) ?? 0)
        const end = actualDuration ? (record.endedAt ?? start) : (start ?? 0) + 1
        return start !== null && end !== null && start <= range[1] && end >= range[0]
      })
      if (matching.length === 0) continue
      result.push({
        kind: 'turn',
        id: `turn-${turn.turn}`,
        turn: turn.turn,
        count: matching.length,
        duration:
          turn.startedAt === null || turn.endedAt === null
            ? null
            : Math.max(0, turn.endedAt - turn.startedAt),
      })
      if (search === '' && collapsedTurns.has(turn.turn)) continue
      for (const record of matching) {
        if (
          search === '' &&
          record.kind === 'tool' &&
          collapsedCalls.has(`${record.turn}:${record.step}`)
        )
          continue
        result.push({ kind: 'record', id: record.id, record })
      }
    }
    return result
  }, [turns, records, query, range, actualDuration, collapsedTurns, collapsedCalls])
  useEffect(() => {
    const element = scroll.current
    if (element === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      setViewport(value => ({ ...value, height: element.clientHeight }))
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [loading])
  useLayoutEffect(() => {
    const element = scroll.current
    if (element === null) return
    const old = previous.current
    const prefix = old.first === undefined ? -1 : rows.findIndex(row => row.id === old.first)
    const revealIndex =
      revealRef.current === null ? -1 : rows.findIndex(row => row.id === revealRef.current)
    if (revealIndex >= 0) {
      element.scrollTop = Math.max(0, revealIndex * ROW_HEIGHT - element.clientHeight / 2)
      revealRef.current = null
    } else if (prefix > 0 && rows.length > old.length) element.scrollTop += prefix * ROW_HEIGHT
    else if (followRef.current && query === '' && range === null)
      element.scrollTop = element.scrollHeight
    previous.current = { first: rows[0]?.id, length: rows.length }
    setViewport(value => ({
      ...value,
      top: element.scrollTop,
      height: element.clientHeight || value.height,
    }))
  }, [rows, query, range])
  const select = (record: TraceRecord, reveal = false) => {
    setSelectedId(record.id)
    followRef.current = false
    setFollow(false)
    if (reveal) {
      revealRef.current = record.id
      setCollapsedTurns(current => {
        const next = new Set(current)
        next.delete(record.turn)
        return next
      })
      setCollapsedCalls(current => {
        const next = new Set(current)
        next.delete(`${record.turn}:${record.step}`)
        return next
      })
    }
  }
  const exportLog = async () => {
    if (onExport === undefined || exporting) return
    setExporting(true)
    setNotice('')
    try {
      const result = await onExport()
      if (result.status === 'saved') setNotice(`已导出 ${result.fileName}`)
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : '会话日志导出失败')
    } finally {
      setExporting(false)
    }
  }
  const virtual = rows.length > 150
  const from = virtual ? Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - 12) : 0
  const to = virtual
    ? Math.min(rows.length, Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT) + 12)
    : rows.length
  if (loading && records.length === 0)
    return (
      <div className={`workspace-view ${styles.state}`} role="status">
        正在读取轨迹…
      </div>
    )
  const isEmptyTrace = records.length === 0 && !hasMore
  if (isEmptyTrace) {
    return (
      <section
        id="trajectory-view"
        className={`workspace-view ${styles.view} ${styles.emptyView}`}
        aria-label="会话轨迹"
      >
        {(notice || error) && (
          <p className={styles.notice} role={error ? 'alert' : 'status'}>
            {error ? `无法读取轨迹：${error}` : notice}
          </p>
        )}
        <div className={`${styles.state} ${styles.emptyStage}`} role="status">
          <strong>这个对话还没有轨迹</strong>
          <span>开始对话后，这里会按轮次记录输入、模型与工具。</span>
        </div>
      </section>
    )
  }
  return (
    <section id="trajectory-view" className={`workspace-view ${styles.view}`} aria-label="会话轨迹">
      <header className={styles.toolbar}>
        <label className={styles.search}>
          <Search size={13} />
          <input
            type="search"
            aria-label="搜索轨迹"
            placeholder="搜索轨迹"
            value={query}
            onChange={event => {
              setQuery(event.target.value)
              if (scroll.current) scroll.current.scrollTop = 0
            }}
          />
        </label>
        <div className={styles.toolbarActions} role="toolbar" aria-label="轨迹控制">
          <button
            type="button"
            aria-label="按真实时长显示"
            aria-pressed={actualDuration}
            onClick={() => {
              setActualDuration(value => !value)
            }}
          >
            <Clock3 size={13} />
            时长
          </button>
          <button
            type="button"
            aria-label={collapsedTurns.size === turns.length ? '展开全部轮次' : '折叠全部轮次'}
            aria-pressed={collapsedTurns.size === turns.length && turns.length > 0}
            onClick={() => {
              setCollapsedTurns(
                collapsedTurns.size === turns.length
                  ? new Set()
                  : new Set(turns.map(turn => turn.turn)),
              )
            }}
          >
            <FoldVertical size={13} />
            轮次
          </button>
          <button
            type="button"
            aria-label={collapsedCalls.size === groups.length ? '展开全部调用' : '折叠全部调用'}
            aria-pressed={collapsedCalls.size === groups.length && groups.length > 0}
            onClick={() => {
              setCollapsedCalls(collapsedCalls.size === groups.length ? new Set() : new Set(groups))
            }}
          >
            <FoldVertical size={13} />
            调用
          </button>
          <dl className={styles.metrics} aria-label="轨迹指标">
            <div>
              <dt>轮次</dt>
              <dd>{turns.filter(turn => turn.turn > 0).length}</dd>
            </div>
            <div>
              <dt>调用</dt>
              <dd>{records.filter(record => record.kind === 'tool').length}</dd>
            </div>
          </dl>
        </div>
        <button
          type="button"
          className={styles.exportButton}
          aria-label={exporting ? '正在导出日志' : '导出日志'}
          title="导出日志"
          disabled={!canExport || onExport === undefined || exporting}
          onClick={() => {
            void exportLog()
          }}
        >
          <Download size={14} />
        </button>
      </header>
      <TraceTimeline
        records={records}
        actualDuration={actualDuration}
        selected={selectedId}
        range={range}
        onRange={setRange}
        onSelect={record => {
          select(record, true)
        }}
      />
      {(notice || error) && (
        <p className={styles.notice} role={error ? 'alert' : 'status'}>
          {error ? `无法读取轨迹：${error}` : notice}
        </p>
      )}
      <div className={styles.workspace} data-inspector={selected !== null}>
        <div className={styles.ledger}>
          {hasMore && (
            <button
              className={styles.loadOlder}
              type="button"
              disabled={loadingOlder}
              onClick={() => {
                void onLoadOlder?.()
              }}
            >
              {loadingOlder ? '正在加载更早记录…' : '加载更早记录'}
            </button>
          )}
          <div
            className={styles.tableScroll}
            ref={scroll}
            role="grid"
            aria-label="轨迹记录表"
            aria-rowcount={rows.length}
            onScroll={event => {
              const element = event.currentTarget
              const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 8
              followRef.current = atBottom
              setFollow(atBottom)
              setViewport({ top: element.scrollTop, height: element.clientHeight })
            }}
          >
            {rows.length === 0 ? (
              <div className={styles.state} role="status">
                <strong>{records.length === 0 ? '这个对话还没有轨迹' : '没有匹配的轨迹'}</strong>
                <span>
                  {records.length === 0
                    ? '开始对话后，这里会按轮次记录输入、模型与工具。'
                    : '清空搜索或时间区间后查看全部记录。'}
                </span>
              </div>
            ) : (
              <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
                <div style={{ transform: `translateY(${from * ROW_HEIGHT}px)` }}>
                  {rows.slice(from, to).map((row, offset) =>
                    row.kind === 'turn' ? (
                      <div
                        className={styles.turnHeader}
                        role="row"
                        aria-rowindex={from + offset + 1}
                        key={row.id}
                      >
                        <h2>
                          <button
                            type="button"
                            aria-expanded={!collapsedTurns.has(row.turn)}
                            onClick={() => {
                              setCollapsedTurns(current => {
                                const next = new Set(current)
                                if (next.has(row.turn)) next.delete(row.turn)
                                else next.add(row.turn)
                                return next
                              })
                            }}
                          >
                            <ChevronRight size={12} />
                            {row.turn > 0 ? `第 ${row.turn} 轮` : '轮次之间'}
                          </button>
                        </h2>
                        <span>
                          {row.count} 条记录 · {formatTraceDuration(row.duration)}
                        </span>
                      </div>
                    ) : (
                      <div
                        className={styles.recordRow}
                        role="row"
                        aria-rowindex={from + offset + 1}
                        aria-selected={row.id === selectedId}
                        tabIndex={0}
                        key={row.id}
                        data-record-id={row.id}
                        data-kind={row.record.kind}
                        data-status={row.record.status}
                        data-nested={row.record.parentCallId !== null}
                        onClick={() => {
                          select(row.record)
                        }}
                        onKeyDown={event => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            select(row.record)
                          }
                          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                            event.preventDefault()
                            const direction = event.key === 'ArrowDown' ? 1 : -1
                            let index = from + offset + direction
                            while (rows[index]?.kind === 'turn') index += direction
                            const next = rows[index]
                            if (next?.kind === 'record') {
                              select(next.record, true)
                              requestAnimationFrame(() =>
                                document
                                  .querySelector<HTMLElement>(`[data-record-id="${next.id}"]`)
                                  ?.focus(),
                              )
                            }
                          }
                        }}
                      >
                        <span className={styles.step} role="gridcell">
                          {row.record.kind === 'model' && row.record.step !== null ? (
                            <button
                              type="button"
                              aria-label={`折叠或展开第 ${row.record.step} 步调用`}
                              aria-expanded={
                                !collapsedCalls.has(`${row.record.turn}:${row.record.step}`)
                              }
                              onClick={event => {
                                event.stopPropagation()
                                const group = `${row.record.turn}:${row.record.step}`
                                setCollapsedCalls(current => {
                                  const next = new Set(current)
                                  if (next.has(group)) next.delete(group)
                                  else next.add(group)
                                  return next
                                })
                              }}
                            >
                              <ChevronRight size={11} />
                            </button>
                          ) : (
                            <i />
                          )}
                        </span>
                        <span className={styles.kind} role="gridcell" data-kind={row.record.kind}>
                          {recordLabels[row.record.kind]}
                        </span>
                        <span
                          className={styles.recordText}
                          role="gridcell"
                          title={traceSummary(row.record)}
                        >
                          {traceSummary(row.record)}
                        </span>
                        <span
                          className={styles.rowTime}
                          role="gridcell"
                          title={
                            row.record.status === 'running'
                              ? '正在运行'
                              : `第 ${row.record.step ?? '—'} 步`
                          }
                        >
                          {row.record.status === 'running'
                            ? '进行中'
                            : formatTraceDuration(traceDuration(row.record))}
                        </span>
                      </div>
                    ),
                  )}
                </div>
              </div>
            )}
          </div>
          {!follow && records.length > 0 && (
            <button
              className={styles.follow}
              type="button"
              onClick={() => {
                followRef.current = true
                setFollow(true)
                if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
              }}
            >
              <ArrowDownToLine size={13} />
              回到最新
            </button>
          )}
        </div>
        {selected !== null && (
          <TraceInspector
            key={selected.id}
            record={selected}
            onClose={() => {
              setSelectedId(null)
              document.querySelector<HTMLElement>(`[data-record-id="${selected.id}"]`)?.focus()
            }}
          />
        )}
      </div>
    </section>
  )
}
export default TrajectoryView
