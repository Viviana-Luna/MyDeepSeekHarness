/** renderer 对话侧边工具列；只拥有预设浮层的显隐，切换视图仍交给会话宿主。 */
import { ListTree, MessageSquare, SlidersHorizontal } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { SessionPresetPicker } from '../../pages/workspace/components/rightpanel/chat-rightpanel/SessionPresetPicker.tsx'
import { AnchoredPanel } from '../../shared/ui/AnchoredPanel.tsx'
import './conversation-tools.css'

type SessionView = 'conversation' | 'trajectory'
const views = [
  { id: 'conversation', label: '对话', icon: MessageSquare },
  { id: 'trajectory', label: '轨迹', icon: ListTree },
] as const

/** 在正文右侧提供紧凑视图切换与预设入口，隐藏会话时释放浮层及键盘监听。 */
export function ConversationTools({
  view,
  visible,
  onViewChange,
}: {
  view: SessionView
  visible: boolean
  onViewChange: (view: SessionView) => void
}) {
  const [open, setOpen] = useState(false)
  const presetButton = useRef<HTMLButtonElement>(null)
  const dismiss = useCallback(() => {
    setOpen(false)
  }, [])
  useEffect(() => {
    setOpen(false)
  }, [view, visible])
  return (
    <aside className="conversation-tools" data-view={view} aria-label="会话工具">
      <div
        className="conversation-view-tabs"
        role="tablist"
        aria-label="会话视图"
        aria-orientation="vertical"
      >
        {views.map(({ id, label, icon: Icon }, index) => (
          <button
            key={id}
            type="button"
            role="tab"
            className="view-tool-button"
            data-view={id}
            aria-label={label}
            title={label}
            aria-selected={view === id}
            tabIndex={view === id ? 0 : -1}
            onClick={() => {
              onViewChange(id)
            }}
            onKeyDown={event => {
              const keys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']
              if (!keys.includes(event.key)) return
              event.preventDefault()
              let nextIndex = 1 - index
              if (event.key === 'Home') nextIndex = 0
              else if (event.key === 'End') nextIndex = 1
              const next = views[nextIndex]!.id
              onViewChange(next)
              event.currentTarget.parentElement
                ?.querySelector<HTMLButtonElement>(`[data-view="${next}"]`)
                ?.focus()
            }}
          >
            <Icon size={14} aria-hidden="true" />
          </button>
        ))}
      </div>
      <button
        ref={presetButton}
        type="button"
        className="view-tool-button"
        aria-label="会话预设"
        aria-haspopup="dialog"
        aria-expanded={open && visible}
        title="会话预设"
        onClick={() => {
          if (visible) setOpen(value => !value)
        }}
      >
        <SlidersHorizontal size={14} aria-hidden="true" />
      </button>
      <AnchoredPanel
        open={open && visible}
        anchor={presetButton.current}
        side="bottom"
        align="end"
        motion="morph"
        focusOnOpen
        className="conversation-preset-panel"
        label="会话预设"
        onDismiss={dismiss}
      >
        <header className="conversation-preset-panel__header">
          <strong>会话预设</strong>
        </header>
        <SessionPresetPicker />
      </AnchoredPanel>
    </aside>
  )
}
