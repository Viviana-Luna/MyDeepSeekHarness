import { useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react'
import {
  normalizeSessionEvents,
  type ConversationProjectionItem,
} from '../../../../shared/session-projection.ts'
import styles from './ConversationNavigator.module.css'
import { isRecord } from '../../../../shared/validation.ts'

interface TurnMark {
  turn: number
  seq: number
  prompt: string
  response: string
}

const preview = (text: string, limit: number) =>
  [...text.replace(/\s+/gu, ' ').trim()].slice(0, limit).join('')

/** 目录只补齐未加载轮次；正文和摘要仍优先来自同一份 Session 消息投影。 */
function turnMarks(
  history: unknown,
  items: readonly ConversationProjectionItem[],
  outline: unknown,
): TurnMark[] {
  const marks = new Map<number, TurnMark>()
  if (Array.isArray(outline)) {
    for (const entry of outline) {
      if (
        !isRecord(entry) ||
        !Number.isSafeInteger(entry.turn) ||
        Number(entry.turn) < 0 ||
        !Number.isSafeInteger(entry.seq) ||
        Number(entry.seq) < 0 ||
        typeof entry.prompt !== 'string' ||
        typeof entry.response !== 'string'
      )
        continue
      marks.set(Number(entry.turn), {
        turn: Number(entry.turn),
        seq: Number(entry.seq),
        prompt: preview(entry.prompt, 50),
        response: preview(entry.response, 120),
      })
    }
  }
  for (const event of normalizeSessionEvents(history)) {
    if (
      event.type !== 'turn/start' ||
      !isRecord(event.data) ||
      !Number.isSafeInteger(event.data.turn)
    )
      continue
    const turn = Number(event.data.turn)
    const mark = marks.get(turn)
    marks.set(turn, {
      turn,
      seq: event.seq,
      prompt: mark?.prompt ?? '',
      response: mark?.response ?? '',
    })
  }
  const prompted = new Set<number>()
  for (const item of items) {
    if (item.turn === null) continue
    const mark = marks.get(item.turn) ?? {
      turn: item.turn,
      seq: item.seq,
      prompt: '',
      response: '',
    }
    if (item.type === 'user' && !prompted.has(item.turn)) {
      mark.prompt = preview(item.text, 50) || mark.prompt
      prompted.add(item.turn)
    }
    if (item.type === 'assistant') {
      const text =
        item.blocks
          ?.filter(block => block.type === 'text')
          .map(block => block.text)
          .join('\n') ?? item.text
      if (text.trim()) mark.response = preview(text, 120)
    }
    marks.set(item.turn, mark)
  }
  return [...marks.values()].toSorted((a, b) => a.turn - b.turn)
}

export function ConversationNavigator({
  history,
  items,
  outline,
  scrollRef,
  isAtBottom,
  hasMore,
  loadingOlder,
  onLoadOlder,
  onJump,
}: {
  history: unknown
  items: readonly ConversationProjectionItem[]
  outline: unknown
  scrollRef: RefObject<HTMLElement | null>
  isAtBottom: boolean
  hasMore: boolean
  loadingOlder: boolean
  onLoadOlder: () => Promise<boolean>
  onJump: (element: HTMLElement) => void
}) {
  const marks = useMemo(() => turnMarks(history, items, outline), [history, items, outline])
  const [active, setActive] = useState<number | null>(null)
  const [hovered, setHovered] = useState<{ turn: number; top: number } | null>(null)
  const [pending, setPending] = useState<TurnMark | null>(null)
  const [notice, setNotice] = useState('')
  const [pageRevision, setPageRevision] = useState(0)
  const [fades, setFades] = useState({ top: false, bottom: false })
  const request = useRef(false)
  const pendingRef = useRef(pending)
  pendingRef.current = pending
  const alive = useRef(true)
  const rail = useRef<HTMLDivElement>(null)
  const previewId = useId()
  const firstSeq = normalizeSessionEvents(history)[0]?.seq ?? Infinity

  useEffect(() => {
    const container = rail.current
    if (container === null) return
    const update = () => {
      setFades({
        top: container.scrollTop > 1,
        bottom: container.scrollTop + container.clientHeight < container.scrollHeight - 1,
      })
    }
    update()
    container.addEventListener('scroll', update, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(container)
    return () => {
      container.removeEventListener('scroll', update)
      observer?.disconnect()
    }
  }, [marks.length])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    const port = scrollRef.current
    if (port === null) return
    let frame = 0
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const rows = [...port.querySelectorAll<HTMLElement>('[data-conversation-turn]')]
        if (isAtBottom) {
          setActive(Number(rows.at(-1)?.dataset.conversationTurn ?? marks.at(-1)?.turn))
          return
        }
        const line = port.getBoundingClientRect().top + 64
        let current = rows[0]
        for (const row of rows) {
          if (row.getBoundingClientRect().top > line) break
          current = row
        }
        setActive(current === undefined ? null : Number(current.dataset.conversationTurn))
      })
    }
    update()
    port.addEventListener('scroll', update, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(port)
    if (port.querySelector('ol') !== null) observer?.observe(port.querySelector('ol')!)
    return () => {
      cancelAnimationFrame(frame)
      port.removeEventListener('scroll', update)
      observer?.disconnect()
    }
  }, [isAtBottom, marks, scrollRef])

  useEffect(() => {
    const container = rail.current
    const mark = container?.querySelector<HTMLElement>('[aria-current="step"]')
    if (container === null || mark === undefined || mark === null) return
    if (mark.offsetTop < container.scrollTop) container.scrollTop = mark.offsetTop
    else if (mark.offsetTop + mark.offsetHeight > container.scrollTop + container.clientHeight) {
      container.scrollTop = mark.offsetTop + mark.offsetHeight - container.clientHeight
    }
  }, [active])

  useEffect(() => {
    if (pending === null || request.current || loadingOlder) return
    const target = scrollRef.current?.querySelector<HTMLElement>(
      `[data-conversation-turn="${String(pending.turn)}"]`,
    )
    if (target && firstSeq <= pending.seq) {
      onJump(target)
      setActive(pending.turn)
      setPending(null)
      return
    }
    if (!hasMore) {
      setNotice('这一轮暂无可显示的消息。')
      setPending(null)
      return
    }
    request.current = true
    void onLoadOlder().then(
      loaded => {
        if (!alive.current) return
        request.current = false
        if (!loaded && pendingRef.current === pending) {
          setNotice('未能加载这一轮，请重试。')
          setPending(null)
        }
        setPageRevision(value => value + 1)
      },
      () => {
        if (!alive.current) return
        request.current = false
        setNotice('未能加载这一轮，请重试。')
        setPending(null)
      },
    )
  }, [
    pending,
    pageRevision,
    firstSeq,
    items,
    loadingOlder,
    hasMore,
    onLoadOlder,
    onJump,
    scrollRef,
  ])

  if (marks.length === 0) return null
  const shown = marks.find(mark => mark.turn === hovered?.turn)
  return (
    <nav
      className={styles.navigator}
      aria-label="对话轮次导航"
      onMouseLeave={() => {
        setHovered(null)
      }}
    >
      <div
        className={styles.rail}
        ref={rail}
        data-fade-top={fades.top}
        data-fade-bottom={fades.bottom}
        onScroll={() => {
          setHovered(null)
        }}
      >
        {marks.map(mark => (
          <button
            className={styles.mark}
            key={mark.turn}
            type="button"
            aria-label={`跳转到第 ${String(mark.turn)} 轮${mark.prompt ? `：${mark.prompt}` : ''}`}
            aria-current={active === mark.turn ? 'step' : undefined}
            aria-describedby={shown?.turn === mark.turn ? previewId : undefined}
            aria-busy={pending?.turn === mark.turn}
            data-unloaded={mark.seq < firstSeq}
            onMouseEnter={event => {
              setHovered({
                turn: mark.turn,
                top: event.currentTarget.offsetTop - (rail.current?.scrollTop ?? 0),
              })
            }}
            onFocus={event => {
              setHovered({
                turn: mark.turn,
                top: event.currentTarget.offsetTop - (rail.current?.scrollTop ?? 0),
              })
            }}
            onBlur={() => {
              setHovered(null)
            }}
            onClick={() => {
              setNotice('')
              setPending(mark)
            }}
            onKeyDown={event => {
              const buttons = [...(rail.current?.querySelectorAll('button') ?? [])]
              const index = buttons.indexOf(event.currentTarget)
              const next =
                event.key === 'ArrowDown'
                  ? buttons[index + 1]
                  : event.key === 'ArrowUp'
                    ? buttons[index - 1]
                    : event.key === 'Home'
                      ? buttons[0]
                      : event.key === 'End'
                        ? buttons.at(-1)
                        : undefined
              if (next) {
                event.preventDefault()
                next.focus()
              }
              if (event.key === 'Escape') {
                setHovered(null)
                setPending(null)
              }
            }}
          />
        ))}
      </div>
      {shown && (
        <div
          id={previewId}
          className={styles.preview}
          role="tooltip"
          style={{
            top: `clamp(0px, ${String((hovered?.top ?? 0) - 36)}px, max(0px, 100% - 108px))`,
          }}
        >
          <span>
            第 {shown.turn} 轮{pending?.turn === shown.turn ? ' · 正在定位…' : ''}
          </span>
          <strong>{shown.prompt || '本轮没有文字提问'}</strong>
          <p>{shown.response || '暂无回复摘要'}</p>
        </div>
      )}
      {notice && (
        <span className={styles.notice} role="status">
          {notice}
        </span>
      )}
    </nav>
  )
}
