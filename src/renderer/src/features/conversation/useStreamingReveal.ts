/** 平滑显示已收到的对话分片；不修改 Session 数据，卸载时取消动画帧。 */
import { useEffect, useRef, useState } from 'react'

const REVEAL_WINDOW_MS = 180
const FRAME_MS = 16
const REDUCED_EFFECTS = '(prefers-reduced-motion: reduce), (forced-colors: active)'
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function nextBoundary(text: string, desired: number): number {
  for (const part of segmenter.segment(text)) {
    const end = part.index + part.segment.length
    if (end >= desired) return end
  }
  return text.length
}

function canAnimate(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.requestAnimationFrame === 'function' &&
    typeof window.matchMedia === 'function' &&
    !window.matchMedia(REDUCED_EFFECTS).matches
  )
}

/** 对增量内容在短时间内平滑追赶；结束、替换或减少动态时立即显示完整内容。 */
export function useStreamingReveal(text: string, streaming: boolean): string {
  const [visible, setVisible] = useState(() => (streaming && canAnimate() ? '' : text))
  const shown = useRef(visible)
  const target = useRef(text)
  const frame = useRef<number | null>(null)
  const deadline = useRef<number | null>(null)
  const cancel = () => {
    if (frame.current !== null) window.cancelAnimationFrame(frame.current)
    frame.current = null
    deadline.current = null
  }

  useEffect(() => {
    const media =
      typeof window.matchMedia === 'function' ? window.matchMedia(REDUCED_EFFECTS) : null
    const onMotionChange = () => {
      if (!media?.matches) return
      cancel()
      shown.current = target.current
      setVisible(target.current)
    }
    media?.addEventListener?.('change', onMotionChange)
    return () => {
      media?.removeEventListener?.('change', onMotionChange)
      cancel()
    }
  }, [])

  useEffect(() => {
    target.current = text
    if (!streaming || !canAnimate() || !text.startsWith(shown.current)) {
      cancel()
      shown.current = text
      setVisible(text)
      return
    }
    if (shown.current === text || frame.current !== null) return
    const advance = (now: number) => {
      frame.current = null
      const remaining = target.current.slice(shown.current.length)
      if (!remaining) {
        deadline.current = null
        return
      }
      deadline.current ??= now + REVEAL_WINDOW_MS
      const remainingTime = Math.max(FRAME_MS, deadline.current - now)
      const desired = Math.max(1, Math.ceil((remaining.length * FRAME_MS) / remainingTime))
      shown.current += remaining.slice(0, nextBoundary(remaining, desired))
      setVisible(shown.current)
      if (shown.current !== target.current) frame.current = window.requestAnimationFrame(advance)
      else deadline.current = null
    }
    frame.current = window.requestAnimationFrame(advance)
  }, [text, streaming])

  return !streaming || !text.startsWith(visible) ? text : visible
}
