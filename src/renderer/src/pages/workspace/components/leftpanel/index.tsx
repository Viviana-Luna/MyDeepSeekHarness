import { Check, ChevronDown, Folder } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { useWorkspaceSnapshot } from '../../../../hooks/useWorkspace.ts'
import { useProjectWorkspace } from '../../../../features/project-workspace/ProjectWorkspaceProvider.tsx'
import { AnchoredMenu } from '../../../../shared/ui/AnchoredMenu.tsx'
import { WorkspaceToolbar } from './WorkspaceToolbar.tsx'
import { contributionKey, PluginBoundary, useModes } from '../../../../plugins/react.tsx'

/** 左栏负责工作模式入口、项目筛选及当前模式的导航面板。 */
export function LeftPanel({ searchTrigger }: { searchTrigger: ReactNode }) {
  const workspace = useProjectWorkspace()
  const snapshot = useWorkspaceSnapshot()
  const modes = useModes()
  const navigationView = snapshot.navigationView ?? snapshot.activeView
  const mode =
    modes.find(item => item.id === navigationView && item.left !== undefined) ??
    modes.find(item => item.left !== undefined)
  const Content = mode?.left
  const [focusMenuOpen, setFocusMenuOpen] = useState(false)
  const focusMenuAnchor = useRef<HTMLButtonElement>(null)
  const focusedProject = snapshot.projects.find(
    project => project.id === snapshot.selectedProjectId,
  )
  return (
    <div className="island sidebar-island">
      <section className="project-focus" aria-label="项目与搜索">
        <button
          ref={focusMenuAnchor}
          className="project-selector"
          type="button"
          aria-label="专注项目"
          aria-haspopup="menu"
          aria-expanded={focusMenuOpen}
          onClick={() => {
            setFocusMenuOpen(open => !open)
          }}
        >
          <Folder size={15} aria-hidden="true" />
          <strong className="project-selector__title">{focusedProject?.name ?? '全部项目'}</strong>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
        {searchTrigger}
        <AnchoredMenu
          open={focusMenuOpen && !snapshot.navigationCollapsed}
          anchorRef={focusMenuAnchor}
          side="bottom"
          motion="morph"
          className="project-focus-menu"
          label="专注项目"
          onDismiss={() => {
            setFocusMenuOpen(false)
          }}
        >
          <button
            type="button"
            role="menuitemradio"
            aria-checked={snapshot.selectedProjectId === null}
            onClick={() => {
              workspace.selectProject(null)
              setFocusMenuOpen(false)
            }}
          >
            <span className="project-focus-menu__mark">
              {snapshot.selectedProjectId === null && <Check size={14} aria-hidden="true" />}
            </span>
            <span>
              <strong>全部项目</strong>
              <small>显示所有项目与聊天</small>
            </span>
          </button>
          {snapshot.projects.map(project => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={snapshot.selectedProjectId === project.id}
              key={project.id}
              onClick={() => {
                workspace.selectProject(project.id)
                setFocusMenuOpen(false)
              }}
            >
              <span className="project-focus-menu__mark">
                {snapshot.selectedProjectId === project.id && (
                  <Check size={14} aria-hidden="true" />
                )}
              </span>
              <span>
                <strong>{project.name}</strong>
                <small>{project.displayPath}</small>
              </span>
            </button>
          ))}
        </AnchoredMenu>
      </section>
      <aside className="mode-rail" aria-label="工作模式">
        <WorkspaceToolbar />
      </aside>
      <aside
        className="navigation-island"
        aria-label="项目与聊天"
        inert={snapshot.navigationCollapsed}
      >
        {Content && (
          <PluginBoundary key={contributionKey(mode)} name={mode.label}>
            <Content />
          </PluginBoundary>
        )}
      </aside>
    </div>
  )
}
