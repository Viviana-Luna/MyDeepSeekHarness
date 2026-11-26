/** 源代码管理的分区与拖动状态，左右面板各自持有。 */
import { ChevronRight, RefreshCw } from 'lucide-react'
import { useCallback, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { GitHistoryGraph } from './GitGraphPanel.tsx'
import { useSourceControl } from './SourceControlProvider.tsx'
import { AnchoredMenu } from '../../shared/ui/AnchoredMenu.tsx'
import { IconButton } from '../../shared/ui/IconButton.tsx'

const DEFAULT_SHARE = 0.55
const MIN_PANE_HEIGHT = 64
const KEYBOARD_STEP = 16

interface SectionProps {
  readonly title: string
  readonly className?: string
  readonly open: boolean
  readonly onToggle: () => void
  readonly onRefresh?: () => Promise<void>
  readonly refreshDisabled?: boolean
  readonly children: ReactNode
}

function SourceControlSection({
  title,
  className,
  open,
  onToggle,
  onRefresh,
  refreshDisabled,
  children,
}: SectionProps) {
  const contentId = useId()
  const heading = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const dismiss = useCallback(() => setMenuOpen(false), [])
  return (
    <section className={className === undefined ? 'scm-pane' : `scm-pane ${className}`}>
      <div className="scm-pane-header">
        <button
          ref={heading}
          className="scm-pane-toggle"
          type="button"
          aria-label={`${title}面板`}
          aria-controls={contentId}
          aria-expanded={open}
          aria-keyshortcuts={onRefresh ? 'Shift+F10' : undefined}
          title={onRefresh ? '右键或按 Shift+F10 打开更改操作' : undefined}
          onClick={onToggle}
          onContextMenu={event => {
            if (!onRefresh) return
            event.preventDefault()
            setMenuOpen(true)
          }}
          onKeyDown={event => {
            if (
              !onRefresh ||
              (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))
            )
              return
            event.preventDefault()
            setMenuOpen(true)
          }}
        >
          <ChevronRight size={14} aria-hidden="true" />
          {title}
        </button>
        {onRefresh && (
          <IconButton
            className="scm-pane-refresh"
            label="刷新 Git 状态"
            disabled={refreshDisabled}
            onClick={() => {
              void onRefresh()
            }}
          >
            <RefreshCw size={13} aria-hidden="true" />
          </IconButton>
        )}
      </div>
      {onRefresh && (
        <AnchoredMenu
          open={menuOpen}
          anchorRef={heading}
          className="scm-action-menu"
          label="更改操作"
          onDismiss={dismiss}
        >
          <button
            type="button"
            role="menuitem"
            disabled={refreshDisabled}
            aria-disabled={refreshDisabled}
            onClick={() => {
              dismiss()
              heading.current?.focus()
              void onRefresh()
            }}
          >
            刷新 Git 状态
          </button>
        </AnchoredMenu>
      )}
      <div id={contentId} className="scm-pane-content" hidden={!open}>
        {children}
      </div>
    </section>
  )
}

/** 更改和图表各自折叠、滚动，分隔线只在两个区域都展开时可调。 */
export function SourceControlSections({ children }: { children: ReactNode }) {
  const { refresh, loading, gitMutation } = useSourceControl()
  const [changesOpen, setChangesOpen] = useState(true)
  const [historyOpen, setHistoryOpen] = useState(true)
  const [changesShare, setChangesShare] = useState(DEFAULT_SHARE)
  const panesRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointer: number; offset: number; separator: HTMLDivElement } | null>(null)
  const finishDrag = (pointer?: number) => {
    const active = drag.current
    if (active === null || (pointer !== undefined && active.pointer !== pointer)) return
    drag.current = null
    if (active.separator.hasPointerCapture(active.pointer))
      active.separator.releasePointerCapture(active.pointer)
  }
  const resize = (height: number, separator: HTMLDivElement) => {
    const panes = panesRef.current
    if (panes === null) return
    const available = panes.clientHeight - separator.offsetHeight
    if (available <= 0) return
    const minimum = Math.min(MIN_PANE_HEIGHT, available / 2)
    setChangesShare(Math.max(minimum, Math.min(height, available - minimum)) / available)
  }
  const reset = () => setChangesShare(DEFAULT_SHARE)
  const style = {
    '--scm-changes-share': changesShare,
    '--scm-pane-min': `${String(MIN_PANE_HEIGHT)}px`,
  } as CSSProperties

  return (
    <div
      ref={panesRef}
      className="scm-panes"
      data-changes-open={changesOpen || undefined}
      data-history-open={historyOpen || undefined}
      style={style}
    >
      <SourceControlSection
        title="更改"
        open={changesOpen}
        onRefresh={refresh}
        refreshDisabled={loading || gitMutation !== null}
        onToggle={() => {
          // 分隔线卸载后不会收到自己的 lostpointercapture，折叠前结束拖动。
          finishDrag()
          setChangesOpen(open => !open)
        }}
      >
        {children}
      </SourceControlSection>
      {changesOpen && historyOpen && (
        <div
          className="scm-pane-divider"
          role="separator"
          aria-label="调整提交图高度"
          aria-orientation="horizontal"
          aria-valuenow={Math.round((1 - changesShare) * 100)}
          tabIndex={0}
          title="拖动或按上下方向键调整图表高度，双击或按 Home 恢复"
          onDoubleClick={reset}
          onKeyDown={event => {
            if (event.key === 'Home') {
              event.preventDefault()
              reset()
            } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
              const panes = panesRef.current
              if (panes === null) return
              event.preventDefault()
              const separator = event.currentTarget
              const height =
                separator.getBoundingClientRect().top - panes.getBoundingClientRect().top
              resize(height + (event.key === 'ArrowUp' ? -KEYBOARD_STEP : KEYBOARD_STEP), separator)
            }
          }}
          onPointerDown={event => {
            if (event.button !== 0 || drag.current !== null) return
            const separator = event.currentTarget
            separator.setPointerCapture(event.pointerId)
            drag.current = {
              pointer: event.pointerId,
              offset: event.clientY - separator.getBoundingClientRect().top,
              separator,
            }
            event.preventDefault()
          }}
          onPointerMove={event => {
            const panes = panesRef.current
            const active = drag.current
            if (panes === null || active?.pointer !== event.pointerId) return
            resize(
              event.clientY - panes.getBoundingClientRect().top - active.offset,
              event.currentTarget,
            )
          }}
          onPointerUp={event => finishDrag(event.pointerId)}
          onPointerCancel={event => finishDrag(event.pointerId)}
          onLostPointerCapture={event => finishDrag(event.pointerId)}
        />
      )}
      <SourceControlSection
        title="图表"
        className="scm-history"
        open={historyOpen}
        onToggle={() => {
          finishDrag()
          setHistoryOpen(open => !open)
        }}
      >
        <GitHistoryGraph />
      </SourceControlSection>
    </div>
  )
}
