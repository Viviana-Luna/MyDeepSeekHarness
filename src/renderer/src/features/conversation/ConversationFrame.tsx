/**
 * 对话内容框架：负责正文双侧宽度拖动、底栏输入区留白同步，以及对话顶部的单层平滑渐隐遮罩。
 * 运行在 renderer；持有 ResizeObserver 与 MutationObserver，在组件卸载时断开清理。
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react'
import { CONVERSATION_WIDTH_RANGE, clampConversationWidth } from '../../domain/panel-layout.ts'
import styles from './ConversationView.module.css'

function useComposerDock(frame: RefObject<HTMLDivElement | null>, overlayComposer: boolean) {
  useLayoutEffect(() => {
    const element = frame.current
    if (!overlayComposer || !element || typeof ResizeObserver === 'undefined') return
    let dock: HTMLElement | null = null
    const update = () => {
      if (dock === null) return
      const style = getComputedStyle(dock)
      element.style.setProperty(
        '--conversation-dock-space',
        `${dock.getBoundingClientRect().height + parseFloat(style.marginBottom || '0') + 24}px`,
      )
    }
    const observer = new ResizeObserver(update)
    const bindDock = () => {
      const current = element.querySelector<HTMLElement>(':scope > .composer-dock')
      if (current === dock) return
      observer.disconnect()
      dock = current
      if (dock !== null) {
        observer.observe(dock)
        update()
      } else element.style.removeProperty('--conversation-dock-space')
    }
    const childObserver = new MutationObserver(bindDock)
    childObserver.observe(element, { childList: true })
    bindDock()
    return () => {
      childObserver.disconnect()
      observer.disconnect()
      element.style.removeProperty('--conversation-dock-space')
    }
  }, [frame, overlayComposer])
}

/** 对话与空会话主区布局容器，支持自适应/手动调宽及悬浮输入区与顶部渐进模糊。 */
export function ConversationFrame({
  width,
  onWidthChange,
  children,
  overlayComposer = false,
}: {
  width: number | null
  onWidthChange: ((width: number | null) => void) | undefined
  children: ReactNode
  overlayComposer?: boolean
}) {
  const frame = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState<number | null>(null)
  const [available, setAvailable] = useState(0)
  const drag = useRef<{
    pointer: number
    x: number
    width: number
    direction: number
    value: number
  } | null>(null)
  useEffect(() => {
    if (frame.current === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setAvailable(entry.contentRect.width)
    })
    observer.observe(frame.current)
    return () => {
      observer.disconnect()
    }
  }, [])
  useComposerDock(frame, overlayComposer)
  const maximum = Math.min(CONVERSATION_WIDTH_RANGE.maximum, Math.max(640, available - 176))
  const effective = Math.min(
    width ?? Math.max(680, Math.min(available * 0.64, 920)),
    maximum,
    Math.max(0, available - 88),
  )
  const constrained = (value: number) => Math.min(maximum, clampConversationWidth(value) ?? 800)
  const preferred = draft ?? width
  return (
    <div
      ref={frame}
      className={styles.frame}
      data-conversation-frame="true"
      data-resizing-content={draft !== null}
      data-composer-overlay={overlayComposer || undefined}
      style={
        preferred === null
          ? undefined
          : ({ '--conversation-preferred-width': `${String(preferred)}px` } as CSSProperties)
      }
    >
      {children}
      {overlayComposer && (
        <div
          className={styles.topProgressiveBlur}
          data-top-progressive-blur="true"
          aria-hidden="true"
        />
      )}
      {onWidthChange &&
        (['left', 'right'] as const).map(side => (
          <div
            className={`${styles.widthHandle} ${styles[`${side}Handle`]}`}
            key={side}
            role="separator"
            tabIndex={0}
            aria-label={`调整对话内容宽度（${side === 'left' ? '左' : '右'}侧）`}
            aria-orientation="vertical"
            aria-valuemin={Math.min(640, effective)}
            aria-valuemax={maximum}
            aria-valuenow={Math.round(draft ?? effective)}
            aria-description="拖动调整正文宽度；双击或 Home 恢复自适应，方向键微调"
            onDoubleClick={() => {
              setDraft(null)
              onWidthChange(null)
            }}
            onPointerDown={event => {
              if (event.button !== 0) return
              event.preventDefault()
              event.currentTarget.focus()
              event.currentTarget.setPointerCapture(event.pointerId)
              drag.current = {
                pointer: event.pointerId,
                x: event.clientX,
                width: effective,
                direction: side === 'left' ? -1 : 1,
                value: effective,
              }
              setDraft(effective)
            }}
            onPointerMove={event => {
              const start = drag.current
              if (start === null || start.pointer !== event.pointerId) return
              start.value = constrained(
                start.width + (event.clientX - start.x) * start.direction * 2,
              )
              setDraft(start.value)
            }}
            onPointerUp={event => {
              if (drag.current?.pointer !== event.pointerId) return
              const value = drag.current.value
              drag.current = null
              onWidthChange(value)
              setDraft(null)
              event.currentTarget.releasePointerCapture(event.pointerId)
              event.currentTarget.blur()
            }}
            onLostPointerCapture={() => {
              drag.current = null
              setDraft(null)
            }}
            onPointerCancel={() => {
              drag.current = null
              setDraft(null)
            }}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                if (drag.current && event.currentTarget.hasPointerCapture(drag.current.pointer)) {
                  event.currentTarget.releasePointerCapture(drag.current.pointer)
                }
                drag.current = null
                setDraft(null)
              } else if (event.key === 'Home') {
                event.preventDefault()
                onWidthChange(null)
              } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                event.preventDefault()
                const direction = (event.key === 'ArrowRight' ? 1 : -1) * (side === 'left' ? -1 : 1)
                onWidthChange(constrained(effective + direction * (event.shiftKey ? 80 : 20)))
              }
            }}
          />
        ))}
    </div>
  )
}
