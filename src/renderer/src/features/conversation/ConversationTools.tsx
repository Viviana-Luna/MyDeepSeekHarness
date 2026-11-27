/** renderer 对话侧边工具列；提供对话与轨迹视图的纵向切换，切换状态由会话宿主持有。 */
import { ListTree, MessageSquare } from 'lucide-react'
import './conversation-tools.css'

type SessionView = 'conversation' | 'trajectory'
const views = [
  { id: 'conversation', label: '对话', icon: MessageSquare },
  { id: 'trajectory', label: '轨迹', icon: ListTree },
] as const

/** 在正文右侧提供紧凑的对话／轨迹视图切换入口，支持方向键、Home 与 End 键盘导航。 */
export function ConversationTools({
  view,
  onViewChange,
}: {
  view: SessionView
  onViewChange: (view: SessionView) => void
}) {
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
    </aside>
  )
}
