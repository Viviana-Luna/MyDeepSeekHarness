/**
 * 输入区上方的工作区指示与切换条：在空会话/待建会话下切换新对话工作区，
 * 在左侧栏收缩态下常驻承接当前工作区显示、跨工作区切换、后台未读提示与整组关闭。
 * 运行在 renderer；仅持有菜单展开状态，不创建额外订阅或后台资源。
 */
import { Check, ChevronDown, Folder, FolderPlus, GitBranch, LoaderCircle, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  resolveDraftProject,
  sessionsForProject,
  type ProjectSummary,
} from '../../domain/project.ts'
import { useWorkspaceSnapshot, useWorkspaceStore } from '../../hooks/useWorkspace.ts'
import type { WorkspaceSnapshot } from '../../models/workspace/store.ts'
import { AnchoredMenu } from '../../shared/ui/AnchoredMenu.tsx'
import { ElasticPress } from '../../shared/ui/ElasticPress.tsx'
import { useOptionalProjectWorkspace } from '../project-workspace/ProjectWorkspaceProvider.tsx'
import { useOptionalSourceControl } from '../source-control/SourceControlProvider.tsx'
import type { SourceControlState } from '../source-control/source-control-refresh.ts'
import type { GitSummary } from '../source-control/source-control-types.ts'
import { useWorkspaceTabs } from '../workspace-tabs/WorkspaceTabsProvider.tsx'
import { resolveWorkTabGroups, useOptionalWorkTabs } from '../workspace-tabs/useWorkTabs.ts'
import type { WorkTabGroup } from '../workspace-tabs/work-tab-groups.ts'
import { buildWorkspaceMenuSummary, type WorkspaceMenuEntry } from './workspace-bar-model.ts'
import styles from './ComposerWorkspaceBar.module.css'

function joinClasses(...names: readonly (string | undefined | false)[]): string {
  return names.filter(Boolean).join(' ')
}

function formatBranchTitle(branch: string, ahead: number, behind: number): string {
  const parts = [`当前 Git 分支：${branch}`]
  if (ahead > 0) parts.push(`领先 ${String(ahead)}`)
  if (behind > 0) parts.push(`落后 ${String(behind)}`)
  return parts.join(' · ')
}

function buildTriggerTitle(options: {
  readonly label: string
  readonly path: string | undefined
  readonly otherUnread: number
}): string {
  const { label, path, otherUnread } = options
  const base = path === undefined ? `当前工作区：${label}` : `当前工作区：${label}（${path}）`
  if (otherUnread > 0) {
    return `${base} · 其他工作区有 ${String(otherUnread)} 个会话更新`
  }
  return base
}

/** 仅当 SourceControlProvider 实际加载的 Git 摘要归属与本窗格工作区一致时返回分支，防止分屏或切项目残留串分支。 */
function resolveMatchedBranchSummary(options: {
  readonly activeProject: ProjectSummary | undefined
  readonly projects: readonly ProjectSummary[]
  readonly rootSnapshot: WorkspaceSnapshot
  readonly sourceControl: Pick<SourceControlState, 'gitSummary' | 'gitSummaryProjectId'> | null
}): GitSummary | null {
  const { activeProject, projects, rootSnapshot, sourceControl } = options
  if (activeProject === undefined || sourceControl === null) return null
  const rootSession = (rootSnapshot.sessions ?? []).find(
    item => item.sessionId === rootSnapshot.selectedSessionId,
  )
  const fallbackProjectId =
    rootSnapshot.selectedProjectId ??
    (rootSession === undefined ? rootSnapshot.newSessionProjectId : null) ??
    projects.find(project => project.cwd === rootSession?.cwd)?.id ??
    null
  const summaryProjectId =
    sourceControl.gitSummaryProjectId !== undefined
      ? sourceControl.gitSummaryProjectId
      : fallbackProjectId
  const gitSummary = sourceControl.gitSummary
  if (
    summaryProjectId !== activeProject.id ||
    gitSummary?.available !== true ||
    typeof gitSummary.branch !== 'string' ||
    gitSummary.branch === ''
  ) {
    return null
  }
  return gitSummary
}

function WorkspaceMenuContent({
  entries,
  canCreateWorkspace,
  showCloseGroup,
  onSelect,
  onCloseGroup,
  onCreate,
}: {
  readonly entries: readonly WorkspaceMenuEntry[]
  readonly canCreateWorkspace: boolean
  readonly showCloseGroup: boolean
  readonly onSelect: (entry: WorkspaceMenuEntry) => void
  readonly onCloseGroup: (group: WorkTabGroup) => void
  readonly onCreate: () => void
}) {
  return (
    <>
      {entries.length === 0 ? (
        <p className={styles.empty}>暂无可用工作区</p>
      ) : (
        entries.map(entry => (
          <div key={entry.id} className={styles.row}>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={entry.isSelected}
              className={styles.option}
              onClick={() => {
                onSelect(entry)
              }}
            >
              <span className={styles.mark}>
                {entry.isSelected && <Check size={14} aria-hidden="true" />}
              </span>
              <span className={styles.optionText}>
                <strong>{entry.name}</strong>
                <small>{entry.detail}</small>
              </span>
              {entry.running && <LoaderCircle className="spin" size={13} aria-label="进行中" />}
              {entry.unreadCount > 0 && (
                <span className={styles.unreadBadge} aria-label="有未读更新">
                  {entry.unreadCount}
                </span>
              )}
            </button>
            {showCloseGroup && entry.group !== undefined && entry.group.tabs.length > 0 && (
              <button
                type="button"
                role="menuitem"
                className={joinClasses('session-group-close', styles.closeGroup)}
                aria-label={`关闭 ${entry.name} 的全部标签`}
                title="关闭此工作区的全部标签"
                onClick={() => {
                  onCloseGroup(entry.group!)
                }}
              >
                <X size={14} aria-hidden="true" />
              </button>
            )}
          </div>
        ))
      )}
      {canCreateWorkspace && (
        <>
          {entries.length > 0 && <hr className={styles.divider} />}
          <button type="button" role="menuitem" className={styles.createAction} onClick={onCreate}>
            <FolderPlus size={14} aria-hidden="true" />
            <span>打开工作区目录…</span>
          </button>
        </>
      )}
    </>
  )
}

function switchActiveWorkspaceTarget(options: {
  readonly entry: WorkspaceMenuEntry
  readonly snapshot: WorkspaceSnapshot
  readonly projectWorkspace: ReturnType<typeof useOptionalProjectWorkspace>
  readonly store: ReturnType<typeof useWorkspaceStore>
}): void {
  const { entry, snapshot, projectWorkspace, store } = options
  if (entry.isSelected) return
  const groupTabs = entry.group?.tabs ?? []
  const targetTab = groupTabs.find(tab => tab.unread) ?? groupTabs[0]
  if (targetTab !== undefined) {
    targetTab.select()
    return
  }
  if (entry.project === undefined) return
  if (snapshot.selectedProjectId !== null) {
    if (projectWorkspace !== null) projectWorkspace.selectProject(entry.project.id)
    else store.selectProject(entry.project.id)
    return
  }
  const projectSessions = sessionsForProject(snapshot.sessions ?? [], entry.project)
  const targetSession = projectSessions.find(item => !item.blank) ?? projectSessions[0]
  if (targetSession !== undefined) {
    if (projectWorkspace !== null) projectWorkspace.selectSession(targetSession.sessionId)
    else store.selectSession(targetSession.sessionId)
    return
  }
  if (projectWorkspace !== null) projectWorkspace.createSession(entry.project.id)
  else store.enterNewSessionWelcome(entry.project.id)
}

function closeWorkspaceGroupTabs(options: {
  readonly group: WorkTabGroup
  readonly activeProjectId: string | undefined
  readonly projectWorkspace: ReturnType<typeof useOptionalProjectWorkspace>
  readonly sourceControl: ReturnType<typeof useOptionalSourceControl>
  readonly store: ReturnType<typeof useWorkspaceStore>
}): void {
  const { group, activeProjectId, projectWorkspace, sourceControl, store } = options
  const sessionIds = group.tabs.filter(tab => tab.kind === 'session').map(tab => tab.id)
  const closeNonSession = () => {
    for (const tab of group.tabs) {
      if (!['session', 'file', 'diff'].includes(tab.kind)) tab.close()
    }
    if (group.id === activeProjectId) sourceControl?.closeDiffs()
  }
  if (projectWorkspace !== null && group.id === activeProjectId) {
    projectWorkspace.closeProjectTabs(sessionIds, closeNonSession)
    return
  }
  closeNonSession()
  for (const id of sessionIds) {
    if (projectWorkspace !== null) projectWorkspace.closeSessionTab(id)
    else store.closeSessionTab(id)
  }
}

function hasPendingSessionDraft(
  snapshot: WorkspaceSnapshot,
  scopedSessionId: string | null,
): boolean {
  if (scopedSessionId === null) {
    return (snapshot.newSessionDraft ?? '').trim() !== ''
  }
  return (
    (snapshot.sessionDrafts?.[scopedSessionId] ?? '').trim() !== '' ||
    (snapshot.sessionAttachments?.[scopedSessionId]?.length ?? 0) > 0 ||
    (snapshot.sessionFiles?.[scopedSessionId]?.length ?? 0) > 0
  )
}

function switchDraftProjectTarget(options: {
  readonly projectId: string
  readonly scopedSessionId: string | null
  readonly projectWorkspace: ReturnType<typeof useOptionalProjectWorkspace>
  readonly store: ReturnType<typeof useWorkspaceStore>
  readonly workspaceTabs: ReturnType<typeof useWorkspaceTabs>
}): void {
  const { projectId, scopedSessionId, projectWorkspace, store, workspaceTabs } = options
  const syncSplitAfterSwitch = (nextSessionId: string) => {
    if (scopedSessionId !== null && scopedSessionId !== nextSessionId) {
      workspaceTabs?.replaceSplitTab(scopedSessionId, nextSessionId)
    }
  }
  if (projectWorkspace !== null) {
    projectWorkspace.switchDraftWorkspace(projectId, {
      sessionId: scopedSessionId,
      onSwitched: syncSplitAfterSwitch,
    })
    return
  }
  void store.switchDraftWorkspace(projectId, scopedSessionId).then(hasSwitched => {
    const nextSessionId = store.getSnapshot().selectedSessionId
    if (hasSwitched && nextSessionId !== null) syncSplitAfterSwitch(nextSessionId)
  })
}

function useWorkspaceBarState() {
  const store = useWorkspaceStore()
  const snapshot = useWorkspaceSnapshot()
  const projectWorkspace = useOptionalProjectWorkspace()
  const sourceControl = useOptionalSourceControl()
  const workspaceTabs = useWorkspaceTabs()
  const workTabs = useOptionalWorkTabs()
  const [isOpen, setIsOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dismiss = useCallback(() => {
    setIsOpen(false)
  }, [])

  const projects = snapshot.projects ?? []
  const sessions = snapshot.sessions ?? []
  const session = sessions.find(item => item.sessionId === snapshot.selectedSessionId)
  const scopedSessionId = session?.sessionId ?? null
  const isDraftSession = session === undefined || session.blank === true
  const isCollapsedNavigation = snapshot.navigationCollapsed === true
  const selectableProjects = useMemo(
    () => projects.filter(project => project.cwd !== undefined),
    [projects],
  )
  const activeProject = useMemo(
    () =>
      resolveDraftProject({
        projects,
        sessions,
        session,
        newSessionProjectId: snapshot.newSessionProjectId ?? null,
        selectedProjectId: snapshot.selectedProjectId ?? null,
      }),
    [projects, session, sessions, snapshot.newSessionProjectId, snapshot.selectedProjectId],
  )
  const { groups, activeGroup } = useMemo(
    () => resolveWorkTabGroups(workTabs, projects, activeProject?.id),
    [activeProject?.id, projects, workTabs],
  )
  const activeKey =
    activeProject?.id ?? activeGroup?.id ?? (!isDraftSession ? 'unassigned' : undefined)
  const menuSummary = useMemo(
    () =>
      buildWorkspaceMenuSummary({
        projects: selectableProjects,
        groups,
        activeKey,
        includeUnassignedGroup: isCollapsedNavigation,
        showTabStats: isCollapsedNavigation,
      }),
    [activeKey, groups, isCollapsedNavigation, selectableProjects],
  )

  useEffect(() => {
    setIsOpen(false)
  }, [
    snapshot.selectedSessionId,
    snapshot.selectedProjectId,
    snapshot.newSessionProjectId,
    isCollapsedNavigation,
  ])

  const canCreateWorkspace = snapshot.workspaceCapability === 'available'
  const canSwitch =
    snapshot.hostStatus?.kind === 'ready' &&
    !snapshot.creatingSession &&
    (menuSummary.entries.length > 0 || canCreateWorkspace)
  const workspaceLabel =
    activeProject?.name ??
    (isCollapsedNavigation ? activeGroup?.name : undefined) ??
    session?.cwd ??
    (isDraftSession ? '选择工作区' : '无项目对话')
  const otherUnread = isCollapsedNavigation ? menuSummary.otherUnread : 0
  const otherRunning = isCollapsedNavigation ? menuSummary.otherRunning : false
  const workspaceTitle = buildTriggerTitle({
    label: workspaceLabel,
    path: activeProject?.displayPath ?? session?.cwd,
    otherUnread,
  })
  const workspaceAriaLabel =
    otherUnread > 0
      ? `工作区：${workspaceLabel}，其他工作区有 ${String(otherUnread)} 个会话更新`
      : `工作区：${workspaceLabel}`
  const activeBranch = resolveMatchedBranchSummary({
    activeProject,
    projects,
    rootSnapshot: store.getSnapshot(),
    sourceControl,
  })

  const selectEntry = (entry: WorkspaceMenuEntry) => {
    setIsOpen(false)
    const shouldSwitchOpenedGroup =
      isCollapsedNavigation &&
      !entry.isSelected &&
      !hasPendingSessionDraft(snapshot, scopedSessionId) &&
      (entry.group?.tabs.length ?? 0) > 0
    if (isDraftSession && entry.project !== undefined && !shouldSwitchOpenedGroup) {
      switchDraftProjectTarget({
        projectId: entry.project.id,
        scopedSessionId,
        projectWorkspace,
        store,
        workspaceTabs,
      })
    } else {
      switchActiveWorkspaceTarget({ entry, snapshot, projectWorkspace, store })
    }
    triggerRef.current?.focus()
  }

  const closeWorkspaceGroup = (group: WorkTabGroup) => {
    setIsOpen(false)
    closeWorkspaceGroupTabs({
      group,
      activeProjectId: activeProject?.id,
      projectWorkspace,
      sourceControl,
      store,
    })
    triggerRef.current?.focus()
  }

  const openNewWorkspace = () => {
    setIsOpen(false)
    if (projectWorkspace !== null) projectWorkspace.createWorkspace()
    else void store.createWorkspace()
  }

  return {
    isOpen,
    setIsOpen,
    dismiss,
    triggerRef,
    isDraftSession,
    creatingSession: snapshot.creatingSession,
    canCreateWorkspace,
    canSwitch,
    workspaceLabel,
    workspaceTitle,
    workspaceAriaLabel,
    otherUnread,
    otherRunning,
    activeBranch,
    entries: menuSummary.entries,
    showCloseGroup: isCollapsedNavigation && projectWorkspace !== null,
    selectEntry,
    closeWorkspaceGroup,
    openNewWorkspace,
  }
}

/**
 * 在空会话/待建会话或左侧栏收缩态下于输入框正上方展示当前工作区切换胶囊与 Git 分支提示。
 * 空会话切换会迁移草稿并更新目标工作区；已有消息会话仅在左侧栏收缩时显示，用于跨工作区切换与查看后台更新。
 */
export function ComposerWorkspaceBar() {
  const state = useWorkspaceBarState()
  return (
    <div
      className={joinClasses('composer-workspace-bar', styles.bar)}
      data-composer-workspace-bar="true"
      data-workspace-bar-mode={state.isDraftSession ? 'draft' : 'switch'}
      role="group"
      aria-label="当前工作区"
    >
      <ElasticPress>
        <button
          ref={state.triggerRef}
          type="button"
          className={joinClasses('composer-workspace-trigger', styles.pill)}
          aria-label={state.workspaceAriaLabel}
          aria-haspopup="menu"
          aria-expanded={state.isOpen}
          title={state.workspaceTitle}
          disabled={!state.canSwitch}
          onClick={() => {
            state.setIsOpen(value => !value)
          }}
        >
          {state.creatingSession ? (
            <LoaderCircle className="spin" size={13} aria-hidden="true" />
          ) : (
            <Folder size={13} aria-hidden="true" />
          )}
          <span className={styles.label}>{state.workspaceLabel}</span>
          {state.otherRunning && (
            <LoaderCircle className="spin" size={12} aria-label="其他工作区进行中" />
          )}
          {state.otherUnread > 0 && (
            <span
              className={joinClasses('session-group-unread', styles.unreadBadge)}
              data-workspace-unread="true"
            >
              {state.otherUnread}
            </span>
          )}
          <ChevronDown
            size={12}
            className={joinClasses(styles.chevron, state.isOpen && styles.chevronOpen)}
            aria-hidden="true"
          />
        </button>
      </ElasticPress>
      {state.activeBranch !== null && state.activeBranch.branch !== null && (
        <span
          className={joinClasses(styles.pill, styles.branchPill)}
          data-composer-workspace-branch="true"
          title={formatBranchTitle(
            state.activeBranch.branch,
            state.activeBranch.ahead,
            state.activeBranch.behind,
          )}
        >
          <GitBranch size={13} aria-hidden="true" />
          <span className={styles.label}>{state.activeBranch.branch}</span>
        </span>
      )}
      <AnchoredMenu
        open={state.isOpen}
        anchorRef={state.triggerRef}
        side="top"
        align="start"
        motion="morph"
        className={joinClasses('composer-workspace-menu', styles.menu)}
        label="选择工作区"
        onDismiss={state.dismiss}
      >
        <WorkspaceMenuContent
          entries={state.entries}
          canCreateWorkspace={state.canCreateWorkspace}
          showCloseGroup={state.showCloseGroup}
          onSelect={state.selectEntry}
          onCloseGroup={state.closeWorkspaceGroup}
          onCreate={state.openNewWorkspace}
        />
      </AnchoredMenu>
    </div>
  )
}
