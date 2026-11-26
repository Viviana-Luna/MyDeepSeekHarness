import { useEffect, useRef, useState } from 'react'
import {
  formatTraceDuration,
  recordLabels,
  traceDuration,
  traceSummary,
  type TraceRecord,
} from './trajectory-model.ts'
import styles from './TrajectoryView.module.css'

export type TraceRange = readonly [number, number]
export function TraceTimeline({
  records,
  actualDuration,
  selected,
  range,
  onRange,
  onSelect,
}: {
  records: readonly TraceRecord[]
  actualDuration: boolean
  selected: string | null
  range: TraceRange | null
  onRange(value: TraceRange | null): void
  onSelect(record: TraceRecord): void
}) {
  const canvas = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState<TraceRange | null>(null)
  const [drag, setDrag] = useState<TraceRange | null>(null)
  const pending = useRef<{ x: number; value: number } | null>(null)
  const times = records.flatMap(record =>
    [record.startedAt, record.endedAt].filter((value): value is number => value !== null),
  )
  const start = times.reduce((left, right) => Math.min(left, right), times[0] ?? 0)
  const lastTime = times.reduce((left, right) => Math.max(left, right), start)
  const end = Math.max(start + 1, lastTime)
  const domain: TraceRange = actualDuration ? [start, end] : [0, Math.max(1, records.length)]
  const from = zoom === null ? domain[0] : Math.max(domain[0], zoom[0])
  const to = zoom === null ? domain[1] : Math.min(domain[1], Math.max(from + 1, zoom[1]))
  const width = Math.max(0.001, to - from)
  useEffect(() => {
    setZoom(null)
    onRange(null)
  }, [actualDuration, onRange])
  const state = useRef({ from, width, domain })
  state.current = { from, width, domain }
  useEffect(() => {
    const element = canvas.current
    if (element === null) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const { from: left, width: span, domain: extent } = state.current
      const bounds = element.getBoundingClientRect()
      const ratio = Math.max(
        0,
        Math.min(1, (event.clientX - bounds.left) / Math.max(1, bounds.width)),
      )
      const nextWidth = Math.min(
        extent[1] - extent[0],
        Math.max((extent[1] - extent[0]) / 100, span * (event.deltaY > 0 ? 1.25 : 0.8)),
      )
      const nextLeft = Math.max(
        extent[0],
        Math.min(extent[1] - nextWidth, left + span * ratio - nextWidth * ratio),
      )
      setZoom(nextWidth >= extent[1] - extent[0] ? null : [nextLeft, nextLeft + nextWidth])
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => {
      element.removeEventListener('wheel', wheel)
    }
  }, [])
  const valueAt = (x: number) => {
    const rect = canvas.current?.getBoundingClientRect()
    return rect === undefined
      ? from
      : from + Math.max(0, Math.min(1, (x - rect.left) / Math.max(1, rect.width))) * width
  }
  const selection = drag ?? range
  return (
    <section className={styles.overview} aria-label="轨迹概览">
      <div className={styles.overviewLabels}>
        <span>输入</span>
        <span>模型</span>
        <span>工具</span>
      </div>
      <div
        ref={canvas}
        className={styles.overviewCanvas}
        title="点击查看记录；拖动选择区间；滚轮缩放；右键清除区间"
        onContextMenu={event => {
          event.preventDefault()
          onRange(null)
          setZoom(null)
        }}
        onPointerDown={event => {
          if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return
          pending.current = { x: event.clientX, value: valueAt(event.clientX) }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={event => {
          if (pending.current === null || Math.abs(event.clientX - pending.current.x) < 3) return
          const value = valueAt(event.clientX)
          setDrag([Math.min(value, pending.current.value), Math.max(value, pending.current.value)])
        }}
        onPointerUp={event => {
          if (pending.current !== null && Math.abs(event.clientX - pending.current.x) >= 3) {
            const value = valueAt(event.clientX)
            onRange([
              Math.min(value, pending.current.value),
              Math.max(value, pending.current.value),
            ])
          }
          pending.current = null
          setDrag(null)
        }}
        onPointerCancel={() => {
          pending.current = null
          setDrag(null)
        }}
      >
        {(['input', 'model', 'tool'] as const).map(kind => (
          <div
            className={styles.overviewTrack}
            key={kind}
            role="group"
            aria-label={`${kind === 'input' ? '输入' : kind === 'model' ? '模型' : '工具'}，${records.filter(record => (record.kind === 'model' || record.kind === 'tool' ? record.kind : 'input') === kind).length} 个事件`}
          >
            {records.map((record, index) => {
              if (
                (record.kind === 'model' || record.kind === 'tool' ? record.kind : 'input') !== kind
              )
                return null
              const left = actualDuration ? (record.startedAt ?? record.endedAt ?? start) : index
              const right = actualDuration ? (record.endedAt ?? left) : index + 1
              if (right < from || left > to) return null
              return (
                <button
                  key={record.id}
                  type="button"
                  className={styles.overviewSegment}
                  data-kind={record.kind}
                  data-trajectory-kind={kind}
                  data-sequence={record.seq}
                  data-selected={selected === record.id}
                  data-status={record.status}
                  aria-label={`${recordLabels[record.kind]}：${traceSummary(record)}`}
                  aria-pressed={selected === record.id}
                  title={`${recordLabels[record.kind]} · ${traceSummary(record).slice(0, 160)}\n${formatTraceDuration(traceDuration(record))}`}
                  style={{
                    left: `${Math.max(0, ((left - from) / width) * 100)}%`,
                    width: `max(2px, ${((Math.min(to, right) - Math.max(left, from)) / width) * 100}%)`,
                  }}
                  onClick={() => {
                    onSelect(record)
                  }}
                />
              )
            })}
          </div>
        ))}
        <div className={styles.overviewRuler} aria-hidden="true">
          {actualDuration && lastTime > start ? (
            <>
              <span>{formatTraceDuration(Math.max(0, from - start))}</span>
              <span>{formatTraceDuration(Math.max(0, (from + to) / 2 - start))}</span>
              <span>{formatTraceDuration(Math.max(0, to - start))}</span>
            </>
          ) : (
            <span>记录顺序</span>
          )}
        </div>
        {selection !== null && (
          <div
            className={styles.timelineRange}
            style={{
              left: `${Math.max(0, ((selection[0] - from) / width) * 100)}%`,
              width: `${Math.max(0, ((Math.min(selection[1], to) - Math.max(selection[0], from)) / width) * 100)}%`,
            }}
          />
        )}
      </div>
      {(zoom !== null || range !== null) && (
        <button
          className={styles.timelineReset}
          type="button"
          onClick={() => {
            setZoom(null)
            onRange(null)
          }}
        >
          显示全部
        </button>
      )}
    </section>
  )
}
