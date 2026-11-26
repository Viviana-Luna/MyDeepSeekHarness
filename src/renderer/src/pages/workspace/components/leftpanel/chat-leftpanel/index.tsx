import type {
  SessionArchiveCapability,
  WorkspaceCapability,
} from '../../../../../models/workspace/store.ts'
import { Tooltip } from 'antd'
import {
  Archive,
  ChevronRight,
  Ellipsis,
  Folder,
  FolderOpen,
  GitFork,
  ListCollapse,
  ListTree,
  LoaderCircle,
  MessageCircle,
  MessageSquarePlus,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { useWorkspaceSnapshot, useWorkspaceStore } from '../../../../../hooks/useWorkspace.ts'
import { sessionsForProject, type ProjectSummary } from '../../../../../domain/project.ts'
import { relativeTime, sessionTitle, type SessionSummary } from '../../../../../domain/session.ts'
import { useProjectWorkspace } from '../../../../../features/project-workspace/ProjectWorkspaceProvider.tsx'
import { AnchoredMenu } from '../../../../../shared/ui/AnchoredMenu.tsx'
import { ElasticPress } from '../../../../../shared/ui/ElasticPress.tsx'

interface ProjectSessionNavigationProps {
  readonly projects: readonly ProjectSummary[]
  readonly sessions: readonly SessionSummary[]
  readonly selectedProjectId: string | null
  readonly selectedSessionId: string | null
  readonly initialized: boolean
  readonly loadingSessions: boolean
  readonly onSelectSession: (sessionId: string) => void
  readonly pinnedSessionIds?: readonly string[]
  readonly onTogglePinnedSession?: (sessionId: string) => void
  readonly archiveCapability?: SessionArchiveCapability
  readonly archivingSessionIds?: readonly string[]
  readonly onArchiveSession?: (sessionId: string) => void
  readonly workspaceCapability?: WorkspaceCapability
  readonly onCreateWorkspace?: () => void
  readonly onCreateSessionForProject?: (projectId: string) => void
  readonly onRenameWorkspace?: (projectId: string, title: string) => Promise<boolean>
  readonly onRemoveWorkspace?: (projectId: string) => Promise<boolean>
  readonly onReorderWorkspace?: (projectId: string, beforeProjectId?: string) => void
  readonly onRevealProject?: (projectId: string) => void
  readonly onRenameSession?: (sessionId: string, title: string) => Promise<boolean>
  readonly onForkSession?: (sessionId: string) => Promise<boolean>
  readonly onReorderSession?: (
    projectId: string,
    sessionId: string,
    beforeSessionId?: string,
  ) => void
}

function projectForSession(
  projects: readonly ProjectSummary[],
  sessions: readonly SessionSummary[],
  sessionId: string | null,
): ProjectSummary | undefined {
  const session = sessions.find(item => item.sessionId === sessionId)
  if (session === undefined) return undefined
  return projects.find(project =>
    sessionsForProject(sessions, project).some(
      candidate => candidate.sessionId === session.sessionId,
    ),
  )
}

function listId(projectId: string): string {
  return `project-sessions-${encodeURIComponent(projectId).replaceAll('%', '-')}`
}

type ProjectDialogAction = 'rename' | 'remove'

function showModal(dialog: HTMLDialogElement): void {
  if (typeof dialog.showModal === 'function') dialog.showModal()
  else dialog.setAttribute('open', '')
}

function closeModal(dialog: HTMLDialogElement | null, onClose: () => void): void {
  if (dialog?.open !== true) {
    onClose()
    return
  }
  if (typeof dialog.close === 'function') dialog.close()
  else {
    dialog.removeAttribute('open')
    onClose()
  }
}

function ProjectActionDialog({
  action,
  project,
  onClose,
  onRename,
  onRemove,
}: {
  readonly action: ProjectDialogAction | null
  readonly project: ProjectSummary | undefined
  readonly onClose: () => void
  readonly onRename: (projectId: string, title: string) => Promise<boolean>
  readonly onRemove: (projectId: string) => Promise<boolean>
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [title, setTitle] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setTitle(project?.name ?? '')
    setSaving(false)
  }, [action, project?.id, project?.name])

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return
    if (action !== null && project !== undefined && !dialog.open) showModal(dialog)
    if ((action === null || project === undefined) && dialog.open) closeModal(dialog, onClose)
  }, [action, project])

  const close = () => {
    closeModal(dialogRef.current, onClose)
  }
  const submit = async () => {
    if (project === undefined || action === null || saving) return
    setSaving(true)
    const completed =
      action === 'rename' ? await onRename(project.id, title) : await onRemove(project.id)
    setSaving(false)
    if (completed) close()
  }

  return (
    <dialog
      ref={dialogRef}
      className="project-action-dialog"
      aria-labelledby="project-action-dialog-title"
      onCancel={event => {
        event.preventDefault()
        close()
      }}
      onClose={onClose}
      onClick={event => {
        if (event.target !== event.currentTarget) return
        const bounds = event.currentTarget.getBoundingClientRect()
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          close()
      }}
    >
      <div className="project-action-dialog__frame">
        <header>
          <div>
            <h2 id="project-action-dialog-title">
              {action === 'remove' ? '移除项目' : '编辑项目'}
            </h2>
          </div>
          <ElasticPress>
            <button className="icon-button" type="button" aria-label="关闭项目弹窗" onClick={close}>
              <X size={17} aria-hidden="true" />
            </button>
          </ElasticPress>
        </header>
        {action === 'remove' ? (
          <div className="project-action-dialog__content">
            <strong>要从 MyDSH 中移除“{project?.name ?? ''}”吗？</strong>
            <p>只移除 Workspace 注册。源文件夹、Git 仓库和已有会话日志都会保留。</p>
          </div>
        ) : (
          <div className="project-action-dialog__content">
            <label>
              <span>项目名称</span>
              <input
                value={title}
                autoFocus
                onChange={event => {
                  setTitle(event.currentTarget.value)
                }}
              />
            </label>
            <label>
              <span>源文件夹</span>
              <input value={project?.displayPath ?? ''} readOnly />
            </label>
            <p>项目创建后不能直接更换目录；使用其他目录请新建项目。</p>
          </div>
        )}
        <footer>
          <button type="button" disabled={saving} onClick={close}>
            取消
          </button>
          <button
            className={
              action === 'remove'
                ? 'project-action-dialog__danger'
                : 'project-action-dialog__primary'
            }
            type="button"
            disabled={saving || (action === 'rename' && title.trim() === '')}
            onClick={() => {
              void submit()
            }}
          >
            {saving && <LoaderCircle className="spin" size={14} aria-hidden="true" />}
            {action === 'remove' ? '移除项目' : '保存'}
          </button>
        </footer>
      </div>
    </dialog>
  )
}

function SessionRenameDialog({
  session,
  onClose,
  onRename,
}: {
  readonly session: SessionSummary | undefined
  readonly onClose: () => void
  readonly onRename: (sessionId: string, title: string) => Promise<boolean>
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [title, setTitle] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setTitle(session === undefined ? '' : sessionTitle(session))
    setSaving(false)
  }, [session])

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return
    if (session !== undefined && !dialog.open) showModal(dialog)
    if (session === undefined && dialog.open) closeModal(dialog, onClose)
  }, [session])

  const close = () => {
    closeModal(dialogRef.current, onClose)
  }
  const submit = async () => {
    if (session === undefined || saving) return
    setSaving(true)
    const completed = await onRename(session.sessionId, title)
    setSaving(false)
    if (completed) close()
  }

  return (
    <dialog
      ref={dialogRef}
      className="project-action-dialog"
      aria-labelledby="session-rename-dialog-title"
      onCancel={event => {
        event.preventDefault()
        close()
      }}
      onClose={onClose}
      onClick={event => {
        if (event.target !== event.currentTarget) return
        const bounds = event.currentTarget.getBoundingClientRect()
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          close()
      }}
    >
      <div className="project-action-dialog__frame">
        <header>
          <div>
            <h2 id="session-rename-dialog-title">重命名聊天</h2>
          </div>
          <ElasticPress>
            <button
              className="icon-button"
              type="button"
              aria-label="关闭聊天重命名弹窗"
              onClick={close}
            >
              <X size={17} aria-hidden="true" />
            </button>
          </ElasticPress>
        </header>
        <div className="project-action-dialog__content">
          <label>
            <span>聊天名称</span>
            <input
              value={title}
              autoFocus
              onChange={event => {
                setTitle(event.currentTarget.value)
              }}
            />
          </label>
          <p>保存后会固定当前名称，不再随会话内容自动变化。</p>
        </div>
        <footer>
          <button type="button" disabled={saving} onClick={close}>
            取消
          </button>
          <button
            className="project-action-dialog__primary"
            type="button"
            disabled={saving || title.trim() === ''}
            onClick={() => {
              void submit()
            }}
          >
            {saving && <LoaderCircle className="spin" size={14} aria-hidden="true" />}
            保存
          </button>
        </footer>
      </div>
    </dialog>
  )
}

interface SessionNavigationRowProps {
  readonly session: SessionSummary
  readonly projectId: string
  readonly selected: boolean
  readonly pinned: boolean
  readonly archiveCapability: SessionArchiveCapability
  readonly archiving: boolean
  readonly reorderable?: boolean
  readonly dragging?: boolean
  readonly dropPlacement?: 'before' | 'after' | undefined
  readonly onSelectSession: (sessionId: string) => void
  readonly onTogglePinnedSession: (sessionId: string) => void
  readonly onArchiveSession: (sessionId: string) => void
  readonly onRenameRequest: (sessionId: string) => void
  readonly onForkSession: (sessionId: string) => void
  readonly onDragSession?: (event: DragEvent<HTMLDivElement>, sessionId: string) => void
  readonly onDragSessionOver?: (event: DragEvent<HTMLDivElement>) => void
  readonly onDropSession?: (event: DragEvent<HTMLDivElement>, sessionId: string) => void
  readonly onDragSessionEnd?: () => void
}

function SessionNavigationRow({
  session,
  projectId,
  selected,
  pinned,
  archiveCapability,
  archiving,
  reorderable = false,
  dragging = false,
  dropPlacement,
  onSelectSession,
  onTogglePinnedSession,
  onArchiveSession,
  onRenameRequest,
  onForkSession,
  onDragSession,
  onDragSessionOver,
  onDropSession,
  onDragSessionEnd,
}: SessionNavigationRowProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [titleOpen, setTitleOpen] = useState(false)
  const menuAnchor = useRef<HTMLButtonElement>(null)
  const title = sessionTitle(session)
  const archiveTitle = archiving
    ? '正在归档聊天'
    : archiveCapability === 'available'
      ? '归档聊天'
      : archiveCapability === 'checking'
        ? '正在确认归档能力'
        : '会话归档暂不可用'
  const pinTitle = pinned ? '取消置顶' : '置顶聊天（仅在此设备显示）'

  return (
    <div
      className={`session-row-shell${pinned ? ' is-pinned' : ''}${dragging ? ' is-dragging' : ''}${dropPlacement === undefined ? '' : ` is-drop-${dropPlacement}`}`}
      data-project-id={projectId}
      data-session-id={session.sessionId}
      data-pinned={pinned ? 'true' : undefined}
      draggable={reorderable}
      onDragStart={event => {
        event.stopPropagation()
        if (
          !reorderable ||
          (event.target instanceof Element &&
            event.target.closest('.session-row__actions') !== null)
        ) {
          event.preventDefault()
          return
        }
        onDragSession?.(event, session.sessionId)
      }}
      onDragOver={event => {
        if (!reorderable) return
        event.stopPropagation()
        onDragSessionOver?.(event)
      }}
      onDrop={event => {
        if (!reorderable) return
        event.stopPropagation()
        onDropSession?.(event, session.sessionId)
      }}
      onDragEnd={event => {
        event.stopPropagation()
        onDragSessionEnd?.()
      }}
    >
      <Tooltip
        title={title}
        placement="right"
        trigger={['hover', 'focus']}
        open={titleOpen && !dragging && !menuOpen}
        onOpenChange={setTitleOpen}
        mouseEnterDelay={0.5}
        classNames={{ root: 'session-title-tooltip' }}
      >
        <button
          className={`session-row${selected ? ' is-active' : ''}${pinned ? ' session-row--pinned' : ''}`}
          type="button"
          data-project-id={projectId}
          data-session-id={session.sessionId}
          aria-current={selected ? 'page' : undefined}
          onClick={() => {
            onSelectSession(session.sessionId)
          }}
          onKeyDown={event => {
            if (event.key === 'Escape') setTitleOpen(false)
          }}
        >
          <span className="session-row__title">
            {pinned && (
              <MessageCircle className="session-row__leading-icon" size={14} aria-hidden="true" />
            )}
            {session.running && <i className="session-running-dot" aria-label="进行中" />}
            <strong>{title}</strong>
          </span>
          {!session.blank && (
            <time>{session.running ? '进行中' : relativeTime(session.updatedAt)}</time>
          )}
        </button>
      </Tooltip>
      <div className="session-row__actions" role="group" aria-label={`${title}的会话操作`}>
        <button
          className={`session-row__action${pinned ? ' is-active' : ''}`}
          type="button"
          aria-label={pinned ? '取消置顶聊天' : '置顶聊天'}
          title={pinTitle}
          onClick={event => {
            event.stopPropagation()
            onTogglePinnedSession(session.sessionId)
          }}
        >
          {pinned ? <PinOff size={14} aria-hidden="true" /> : <Pin size={14} aria-hidden="true" />}
        </button>
        <span className="session-row__action-tooltip" title={archiveTitle}>
          <button
            className="session-row__action"
            type="button"
            disabled={archiveCapability !== 'available' || archiving}
            aria-label={archiving ? '正在归档聊天' : '归档聊天'}
            onClick={event => {
              event.stopPropagation()
              onArchiveSession(session.sessionId)
            }}
          >
            {archiving ? (
              <LoaderCircle className="spin" size={14} aria-hidden="true" />
            ) : (
              <Archive size={14} aria-hidden="true" />
            )}
          </button>
        </span>
        {!session.blank && (
          <button
            ref={menuAnchor}
            className="session-row__action"
            type="button"
            aria-label="更多聊天操作"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={event => {
              event.stopPropagation()
              setMenuOpen(open => !open)
            }}
          >
            <Ellipsis size={14} aria-hidden="true" />
          </button>
        )}
      </div>
      <AnchoredMenu
        open={menuOpen}
        anchorRef={menuAnchor}
        align="end"
        className="project-menu"
        label={`${title}的更多聊天操作`}
        onDismiss={() => {
          setMenuOpen(false)
        }}
      >
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onRenameRequest(session.sessionId)
            setMenuOpen(false)
          }}
        >
          <Pencil size={15} aria-hidden="true" />
          重命名聊天
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onForkSession(session.sessionId)
            setMenuOpen(false)
          }}
        >
          <GitFork size={15} aria-hidden="true" />
          分叉聊天
        </button>
      </AnchoredMenu>
    </div>
  )
}

type DropPreview = {
  readonly kind: 'project' | 'session'
  readonly targetId: string
  readonly placement: 'before' | 'after'
}

function dropPlacementFor(event: DragEvent<HTMLElement>): DropPreview['placement'] {
  const bounds = event.currentTarget.getBoundingClientRect()
  return event.clientY >= bounds.top + bounds.height / 2 ? 'after' : 'before'
}

export function ProjectSessionNavigation({
  projects,
  sessions,
  selectedProjectId,
  selectedSessionId,
  initialized,
  loadingSessions,
  onSelectSession,
  pinnedSessionIds = [],
  onTogglePinnedSession = () => undefined,
  archiveCapability = 'unavailable',
  archivingSessionIds = [],
  onArchiveSession = () => undefined,
  workspaceCapability = 'legacy',
  onCreateWorkspace = () => undefined,
  onCreateSessionForProject = () => undefined,
  onRenameWorkspace = async () => false,
  onRemoveWorkspace = async () => false,
  onReorderWorkspace = () => undefined,
  onRevealProject = () => undefined,
  onRenameSession = async () => false,
  onForkSession = async () => false,
  onReorderSession = () => undefined,
}: ProjectSessionNavigationProps) {
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set())
  const [sectionMenuOpen, setSectionMenuOpen] = useState(false)
  const [projectMenuId, setProjectMenuId] = useState<string | null>(null)
  const [dialogAction, setDialogAction] = useState<ProjectDialogAction | null>(null)
  const [dialogProjectId, setDialogProjectId] = useState<string | null>(null)
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null)
  const [draggedSession, setDraggedSession] = useState<{
    projectId: string
    sessionId: string
  } | null>(null)
  const [dropPreview, setDropPreview] = useState<DropPreview | null>(null)
  const [renameSessionId, setRenameSessionId] = useState<string | null>(null)
  const sectionMenuAnchor = useRef<HTMLButtonElement>(null)
  const projectMenuAnchor = useRef<HTMLButtonElement>(null)
  const selectionBaselineReady = useRef(false)
  const previousSessionId = useRef<string | null>(selectedSessionId)
  const previousFocusedProjectId = useRef<string | null>(selectedProjectId)
  const selectedSessionProject = useMemo(
    () => projectForSession(projects, sessions, selectedSessionId),
    [projects, selectedSessionId, sessions],
  )
  const pinnedSessionIdSet = useMemo(() => new Set(pinnedSessionIds), [pinnedSessionIds])
  const pinnedSessions = useMemo(
    () =>
      pinnedSessionIds.flatMap(sessionId => {
        const session = sessions.find(item => item.sessionId === sessionId)
        if (
          session === undefined ||
          session.blank ||
          projectForSession(projects, sessions, sessionId) === undefined
        )
          return []
        return [session]
      }),
    [pinnedSessionIds, projects, sessions],
  )
  const activeMenuProject = projects.find(project => project.id === projectMenuId)
  const dialogProject = projects.find(project => project.id === dialogProjectId)
  const renameSession = sessions.find(session => session.sessionId === renameSessionId)
  const focusedProject =
    selectedProjectId === null
      ? undefined
      : projects.length === 1 && projects[0]?.id === selectedProjectId
        ? projects[0]
        : undefined

  useEffect(() => {
    const available = new Set(projects.map(project => project.id))
    setExpandedProjects(current => {
      const next = new Set([...current].filter(projectId => available.has(projectId)))
      return next.size === current.size ? current : next
    })
  }, [projects])

  useEffect(() => {
    if (!initialized || loadingSessions) return
    if (!selectionBaselineReady.current) {
      selectionBaselineReady.current = true
      previousSessionId.current = selectedSessionId
      previousFocusedProjectId.current = selectedProjectId
      const initialProjectId = selectedProjectId ?? selectedSessionProject?.id
      if (initialProjectId !== undefined) {
        setExpandedProjects(current => new Set(current).add(initialProjectId))
      }
      return
    }

    const projectToReveal =
      selectedProjectId !== null && selectedProjectId !== previousFocusedProjectId.current
        ? selectedProjectId
        : selectedSessionId !== null && selectedSessionId !== previousSessionId.current
          ? selectedSessionProject?.id
          : undefined
    previousSessionId.current = selectedSessionId
    previousFocusedProjectId.current = selectedProjectId
    if (projectToReveal !== undefined) {
      setExpandedProjects(current => new Set(current).add(projectToReveal))
    }
  }, [
    initialized,
    loadingSessions,
    selectedProjectId,
    selectedSessionId,
    selectedSessionProject?.id,
  ])

  const toggleProject = (projectId: string) => {
    setExpandedProjects(current => {
      const next = new Set(current)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      return next
    })
  }
  const durableProjects = projects.filter(project => project.source === 'workspace')
  const dropProject = (event: DragEvent<HTMLElement>, target: ProjectSummary) => {
    event.preventDefault()
    if (draggedProjectId === null || draggedProjectId === target.id) {
      setDropPreview(null)
      return
    }
    const targetIndex = durableProjects.findIndex(project => project.id === target.id)
    if (targetIndex === -1) {
      setDropPreview(null)
      return
    }
    const placement = dropPlacementFor(event)
    const beforeProjectId = placement === 'after' ? durableProjects[targetIndex + 1]?.id : target.id
    if (beforeProjectId !== draggedProjectId) {
      onReorderWorkspace(draggedProjectId, beforeProjectId)
    }
    setDraggedProjectId(null)
    setDropPreview(null)
  }
  const dropSession = (
    event: DragEvent<HTMLDivElement>,
    project: ProjectSummary,
    visibleSessions: readonly SessionSummary[],
    targetSessionId: string,
  ) => {
    event.preventDefault()
    if (
      project.source !== 'workspace' ||
      draggedSession?.projectId !== project.id ||
      draggedSession.sessionId === targetSessionId
    ) {
      setDropPreview(null)
      return
    }
    const targetIndex = visibleSessions.findIndex(session => session.sessionId === targetSessionId)
    if (targetIndex === -1) {
      setDropPreview(null)
      return
    }
    const placement = dropPlacementFor(event)
    const beforeSessionId =
      placement === 'after' ? visibleSessions[targetIndex + 1]?.sessionId : targetSessionId
    if (beforeSessionId !== draggedSession.sessionId) {
      onReorderSession(project.id, draggedSession.sessionId, beforeSessionId)
    }
    setDraggedSession(null)
    setDropPreview(null)
  }

  const previewDrop = (preview: DropPreview) => {
    setDropPreview(current =>
      current?.kind === preview.kind &&
      current.targetId === preview.targetId &&
      current.placement === preview.placement
        ? current
        : preview,
    )
  }

  return (
    <nav className="session-navigation" aria-label="按项目分组的聊天记录">
      {pinnedSessions.length > 0 && (
        <section className="pinned-session-group" aria-labelledby="pinned-session-heading">
          <h2 className="session-navigation__section-title" id="pinned-session-heading">
            置顶
          </h2>
          <div className="pinned-session-list" role="group" aria-label="置顶聊天">
            {pinnedSessions.map(session => {
              const project = projectForSession(projects, sessions, session.sessionId)
              return (
                <SessionNavigationRow
                  key={session.sessionId}
                  session={session}
                  projectId={project?.id ?? 'project:ungrouped'}
                  selected={session.sessionId === selectedSessionId}
                  pinned
                  archiveCapability={archiveCapability}
                  archiving={archivingSessionIds.includes(session.sessionId)}
                  onSelectSession={onSelectSession}
                  onTogglePinnedSession={onTogglePinnedSession}
                  onArchiveSession={onArchiveSession}
                  onRenameRequest={setRenameSessionId}
                  onForkSession={sessionId => {
                    void onForkSession(sessionId)
                  }}
                />
              )
            })}
          </div>
        </section>
      )}
      <header className="project-section-heading">
        <h2>{focusedProject === undefined ? '项目' : '会话'}</h2>
        <div>
          {focusedProject === undefined ? (
            <ElasticPress>
              <button
                ref={sectionMenuAnchor}
                className="icon-button"
                type="button"
                aria-label="项目列表更多操作"
                aria-haspopup="menu"
                aria-expanded={sectionMenuOpen}
                onClick={() => {
                  setSectionMenuOpen(open => !open)
                }}
              >
                <Ellipsis size={15} aria-hidden="true" />
              </button>
            </ElasticPress>
          ) : (
            <ElasticPress>
              <button
                ref={projectMenuAnchor}
                className="icon-button"
                type="button"
                aria-label={`${focusedProject.name}更多操作`}
                aria-haspopup="menu"
                aria-expanded={projectMenuId === focusedProject.id}
                onClick={() => {
                  setProjectMenuId(current =>
                    current === focusedProject.id ? null : focusedProject.id,
                  )
                }}
              >
                <Ellipsis size={15} aria-hidden="true" />
              </button>
            </ElasticPress>
          )}
          <ElasticPress>
            <button
              className="icon-button"
              type="button"
              aria-label={
                focusedProject === undefined ? '添加项目' : `在${focusedProject.name}中新建聊天`
              }
              disabled={focusedProject === undefined && workspaceCapability !== 'available'}
              title={
                focusedProject === undefined
                  ? workspaceCapability === 'available'
                    ? '添加项目'
                    : '项目创建暂不可用'
                  : '新建聊天'
              }
              onClick={
                focusedProject === undefined
                  ? onCreateWorkspace
                  : () => {
                      onCreateSessionForProject(focusedProject.id)
                    }
              }
            >
              {focusedProject === undefined ? (
                <Plus size={16} aria-hidden="true" />
              ) : (
                <MessageSquarePlus size={15} aria-hidden="true" />
              )}
            </button>
          </ElasticPress>
        </div>
      </header>
      <AnchoredMenu
        open={focusedProject === undefined && sectionMenuOpen}
        anchorRef={sectionMenuAnchor}
        side="bottom"
        align="end"
        className="project-menu"
        label="项目列表操作"
        onDismiss={() => {
          setSectionMenuOpen(false)
        }}
      >
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setExpandedProjects(new Set(projects.map(project => project.id)))
            setSectionMenuOpen(false)
          }}
        >
          <ListTree size={15} aria-hidden="true" />
          全部展开
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setExpandedProjects(new Set())
            setSectionMenuOpen(false)
          }}
        >
          <ListCollapse size={15} aria-hidden="true" />
          全部收起
        </button>
      </AnchoredMenu>
      {projects.map(project => {
        const allProjectSessions = sessionsForProject(sessions, project)
        const visibleProjectSessions = allProjectSessions.filter(session => !session.blank)
        const projectSessions = visibleProjectSessions.filter(
          session => !pinnedSessionIdSet.has(session.sessionId),
        )
        const expanded = expandedProjects.has(project.id)
        const containsSelectedSession = allProjectSessions.some(
          session => session.sessionId === selectedSessionId,
        )
        const sessionsId = listId(project.id)
        const projectDropPlacement =
          dropPreview?.kind === 'project' && dropPreview.targetId === project.id
            ? dropPreview.placement
            : undefined
        return (
          <section
            className={`project-session-group${expanded ? ' is-expanded' : ''}${draggedProjectId === project.id ? ' is-dragging' : ''}${projectDropPlacement === undefined ? '' : ` is-drop-${projectDropPlacement}`}`}
            key={project.id}
            data-project-group={project.id}
            onDragOver={event => {
              if (draggedProjectId === null || project.source !== 'workspace') {
                setDropPreview(null)
                return
              }
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              if (draggedProjectId !== project.id) {
                previewDrop({
                  kind: 'project',
                  targetId: project.id,
                  placement: dropPlacementFor(event),
                })
              } else setDropPreview(null)
            }}
            onDrop={event => {
              dropProject(event, project)
            }}
          >
            {focusedProject === undefined && (
              <div
                className={`project-group-heading${containsSelectedSession ? ' has-selected-session' : ''}`}
                draggable={project.source === 'workspace'}
                onDragStart={event => {
                  if (
                    event.target instanceof Element &&
                    event.target.closest('.project-group-actions') !== null
                  ) {
                    event.preventDefault()
                    return
                  }
                  if (project.source !== 'workspace') return
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', project.id)
                  setDraggedSession(null)
                  setDropPreview(null)
                  setDraggedProjectId(project.id)
                }}
                onDragEnd={() => {
                  setDraggedProjectId(null)
                  setDropPreview(null)
                }}
              >
                <button
                  className="project-group-toggle"
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={sessionsId}
                  data-project-toggle={project.id}
                  onClick={() => {
                    toggleProject(project.id)
                  }}
                >
                  {expanded ? (
                    <FolderOpen className="project-group-folder" size={15} aria-hidden="true" />
                  ) : (
                    <Folder className="project-group-folder" size={15} aria-hidden="true" />
                  )}
                  <strong>{project.name}</strong>
                  <span>{visibleProjectSessions.length}</span>
                  <ChevronRight className="project-group-chevron" size={13} aria-hidden="true" />
                </button>
                <div className="project-group-actions">
                  <ElasticPress>
                    <button
                      className="icon-button"
                      type="button"
                      aria-label={`${project.name}更多操作`}
                      aria-haspopup="menu"
                      aria-expanded={projectMenuId === project.id}
                      onClick={event => {
                        projectMenuAnchor.current = event.currentTarget
                        setProjectMenuId(current => (current === project.id ? null : project.id))
                      }}
                    >
                      <Ellipsis size={15} aria-hidden="true" />
                    </button>
                  </ElasticPress>
                  <ElasticPress>
                    <button
                      className="icon-button"
                      type="button"
                      aria-label={`在${project.name}中新建聊天`}
                      title="新建聊天"
                      onClick={() => {
                        onCreateSessionForProject(project.id)
                      }}
                    >
                      <MessageSquarePlus size={15} aria-hidden="true" />
                    </button>
                  </ElasticPress>
                </div>
              </div>
            )}
            <div
              className="project-session-list"
              id={sessionsId}
              role="group"
              aria-label={`${project.name}的会话`}
              hidden={focusedProject === undefined && !expanded}
            >
              {projectSessions.map(session => (
                <SessionNavigationRow
                  key={session.sessionId}
                  session={session}
                  projectId={project.id}
                  selected={session.sessionId === selectedSessionId}
                  pinned={false}
                  archiveCapability={archiveCapability}
                  archiving={archivingSessionIds.includes(session.sessionId)}
                  onSelectSession={onSelectSession}
                  onTogglePinnedSession={onTogglePinnedSession}
                  onArchiveSession={onArchiveSession}
                  reorderable={project.source === 'workspace'}
                  dragging={draggedSession?.sessionId === session.sessionId}
                  dropPlacement={
                    dropPreview?.kind === 'session' && dropPreview.targetId === session.sessionId
                      ? dropPreview.placement
                      : undefined
                  }
                  onRenameRequest={setRenameSessionId}
                  onForkSession={sessionId => {
                    void onForkSession(sessionId)
                  }}
                  onDragSession={(event, sessionId) => {
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', sessionId)
                    setDraggedProjectId(null)
                    setDropPreview(null)
                    setDraggedSession({ projectId: project.id, sessionId })
                  }}
                  onDragSessionOver={event => {
                    if (draggedSession?.projectId !== project.id) {
                      setDropPreview(null)
                      return
                    }
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                    if (draggedSession.sessionId !== session.sessionId) {
                      previewDrop({
                        kind: 'session',
                        targetId: session.sessionId,
                        placement: dropPlacementFor(event),
                      })
                    } else setDropPreview(null)
                  }}
                  onDropSession={(event, sessionId) => {
                    dropSession(event, project, projectSessions, sessionId)
                  }}
                  onDragSessionEnd={() => {
                    setDraggedSession(null)
                    setDropPreview(null)
                  }}
                />
              ))}
              {projectSessions.length === 0 && (
                <span className="session-list__empty">
                  {visibleProjectSessions.length === 0
                    ? '这个项目还没有聊天'
                    : '这个项目的聊天都已置顶'}
                </span>
              )}
            </div>
          </section>
        )
      })}
      <AnchoredMenu
        open={activeMenuProject !== undefined}
        anchorRef={projectMenuAnchor}
        side="bottom"
        align="end"
        className="project-menu"
        label={activeMenuProject === undefined ? '项目操作' : `${activeMenuProject.name}的项目操作`}
        onDismiss={() => {
          setProjectMenuId(null)
        }}
      >
        {activeMenuProject !== undefined && (
          <>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onCreateSessionForProject(activeMenuProject.id)
                setProjectMenuId(null)
              }}
            >
              <MessageSquarePlus size={15} aria-hidden="true" />
              新建聊天
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={activeMenuProject.source !== 'workspace'}
              aria-disabled={activeMenuProject.source !== 'workspace'}
              title={
                activeMenuProject.source === 'workspace'
                  ? '编辑项目'
                  : '此项目仅从会话目录读取，暂不支持编辑'
              }
              onClick={() => {
                setDialogProjectId(activeMenuProject.id)
                setDialogAction('rename')
                setProjectMenuId(null)
              }}
            >
              <Pencil size={15} aria-hidden="true" />
              编辑项目
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={activeMenuProject.projectAccessId === undefined}
              aria-disabled={activeMenuProject.projectAccessId === undefined}
              title={
                activeMenuProject.projectAccessId === undefined
                  ? '当前项目尚未进入受信任的本地访问范围'
                  : '在 Finder 中显示项目目录'
              }
              onClick={() => {
                onRevealProject(activeMenuProject.id)
                setProjectMenuId(null)
              }}
            >
              <FolderOpen size={15} aria-hidden="true" />在 Finder 中显示
            </button>
            <hr />
            <button
              className="project-menu__danger"
              type="button"
              role="menuitem"
              disabled={activeMenuProject.source !== 'workspace'}
              aria-disabled={activeMenuProject.source !== 'workspace'}
              title={
                activeMenuProject.source === 'workspace'
                  ? '移除项目注册'
                  : '此项目仅从会话目录读取，暂不支持编辑'
              }
              onClick={() => {
                setDialogProjectId(activeMenuProject.id)
                setDialogAction('remove')
                setProjectMenuId(null)
              }}
            >
              <Trash2 size={15} aria-hidden="true" />
              移除项目
            </button>
          </>
        )}
      </AnchoredMenu>
      <ProjectActionDialog
        action={dialogAction}
        project={dialogProject}
        onClose={() => {
          setDialogAction(null)
          setDialogProjectId(null)
        }}
        onRename={onRenameWorkspace}
        onRemove={onRemoveWorkspace}
      />
      <SessionRenameDialog
        session={renameSession}
        onClose={() => {
          setRenameSessionId(null)
        }}
        onRename={onRenameSession}
      />
      {projects.length === 0 && (
        <div className="navigation-empty">
          <strong>还没有项目</strong>
          <span>创建会话后，会按工作目录归入项目。</span>
        </div>
      )}
    </nav>
  )
}

/** 连接项目与会话状态，呈现当前专注范围内的聊天导航。 */
export function ChatLeftPanel() {
  const store = useWorkspaceStore()
  const workspace = useProjectWorkspace()
  const snapshot = useWorkspaceSnapshot()
  const focusedProject = snapshot.projects.find(
    project => project.id === snapshot.selectedProjectId,
  )
  const visibleProjects = focusedProject === undefined ? snapshot.projects : [focusedProject]
  return (
    <ProjectSessionNavigation
      projects={visibleProjects}
      sessions={snapshot.sessions}
      selectedProjectId={snapshot.selectedProjectId}
      selectedSessionId={snapshot.selectedSessionId}
      initialized={snapshot.initialized}
      loadingSessions={snapshot.loadingSessions}
      onSelectSession={sessionId => {
        workspace.selectSession(sessionId)
      }}
      pinnedSessionIds={snapshot.pinnedSessionIds}
      onTogglePinnedSession={sessionId => {
        store.togglePinnedSession(sessionId)
      }}
      archiveCapability={snapshot.sessionArchiveCapability}
      archivingSessionIds={snapshot.archivingSessionIds}
      onArchiveSession={sessionId => {
        void store.archiveSession(sessionId)
      }}
      workspaceCapability={snapshot.workspaceCapability}
      onCreateWorkspace={workspace.createWorkspace}
      onCreateSessionForProject={workspace.createSession}
      onRenameWorkspace={(projectId, title) => store.renameWorkspace(projectId, title)}
      onRemoveWorkspace={projectId => store.removeWorkspace(projectId)}
      onReorderWorkspace={(projectId, beforeProjectId) => {
        void store.reorderWorkspace(projectId, beforeProjectId)
      }}
      onRevealProject={projectId => {
        void store.revealProject(projectId)
      }}
      onRenameSession={(sessionId, title) => store.renameSession(sessionId, title)}
      onForkSession={sessionId => store.forkSession(sessionId)}
      onReorderSession={(projectId, sessionId, beforeSessionId) => {
        void store.reorderWorkspaceSession(projectId, sessionId, beforeSessionId)
      }}
    />
  )
}
