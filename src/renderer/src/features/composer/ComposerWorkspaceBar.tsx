/**
 * 输入区上方的工作区指示与切换条：在空会话或新建会话草稿态明确展示当前消息所属的工作区目录与 Git 分支。
 * 运行在 renderer；仅持有菜单展开状态，不创建额外订阅或后台资源。
 */
import { Check, ChevronDown, Folder, FolderPlus, GitBranch, LoaderCircle } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { resolveDraftProject, type ProjectSummary } from '../../domain/project.ts'
import { useWorkspaceSnapshot, useWorkspaceStore } from '../../hooks/useWorkspace.ts'
import type { WorkspaceSnapshot } from '../../models/workspace/store.ts'
import { AnchoredMenu } from '../../shared/ui/AnchoredMenu.tsx'
import { ElasticPress } from '../../shared/ui/ElasticPress.tsx'
import { useOptionalProjectWorkspace } from '../project-workspace/ProjectWorkspaceProvider.tsx'
import { useOptionalSourceControl } from '../source-control/SourceControlProvider.tsx'
import type { SourceControlState } from '../source-control/source-control-refresh.ts'
import type { GitSummary } from '../source-control/source-control-types.ts'
import { useWorkspaceTabs } from '../workspace-tabs/WorkspaceTabsProvider.tsx'
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
  projects,
  activeProjectId,
  canCreateWorkspace,
  onSelect,
  onCreate,
}: {
  readonly projects: readonly ProjectSummary[]
  readonly activeProjectId: string | undefined
  readonly canCreateWorkspace: boolean
  readonly onSelect: (projectId: string) => void
  readonly onCreate: () => void
}) {
  return (
    <>
      {projects.length === 0 ? (
        <p className={styles.empty}>暂无可用工作区</p>
      ) : (
        projects.map(project => {
          const isSelected = project.id === activeProjectId
          return (
            <button
              key={project.id}
              type="button"
              role="menuitemradio"
              aria-checked={isSelected}
              className={styles.option}
              onClick={() => {
                onSelect(project.id)
              }}
            >
              <span className={styles.mark}>
                {isSelected && <Check size={14} aria-hidden="true" />}
              </span>
              <span className={styles.optionText}>
                <strong>{project.name}</strong>
                <small>{project.displayPath}</small>
              </span>
            </button>
          )
        })
      )}
      {canCreateWorkspace && (
        <>
          {projects.length > 0 && <hr className={styles.divider} />}
          <button type="button" role="menuitem" className={styles.createAction} onClick={onCreate}>
            <FolderPlus size={14} aria-hidden="true" />
            <span>打开工作区目录…</span>
          </button>
        </>
      )}
    </>
  )
}

/**
 * 在空会话或待建会话的输入框正上方显示当前工作区切换胶囊，以及已识别的 Git 分支提示。
 * 已有消息的会话与非空会话不会渲染本组件，以免与待办卡片重叠或误导用户修改已固定目录。
 */
export function ComposerWorkspaceBar() {
  const store = useWorkspaceStore()
  const snapshot = useWorkspaceSnapshot()
  const projectWorkspace = useOptionalProjectWorkspace()
  const sourceControl = useOptionalSourceControl()
  const workspaceTabs = useWorkspaceTabs()
  const [isOpen, setIsOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dismiss = useCallback(() => {
    setIsOpen(false)
  }, [])

  const projects = snapshot.projects ?? []
  const sessions = snapshot.sessions ?? []
  const session = sessions.find(item => item.sessionId === snapshot.selectedSessionId)
  const scopedSessionId = session?.sessionId ?? null
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

  useEffect(() => {
    setIsOpen(false)
  }, [snapshot.selectedSessionId, snapshot.selectedProjectId, snapshot.newSessionProjectId])

  const isHostReady = snapshot.hostStatus?.kind === 'ready'
  const canCreateWorkspace = snapshot.workspaceCapability === 'available'
  const canSwitch =
    isHostReady &&
    !snapshot.creatingSession &&
    (selectableProjects.length > 0 || canCreateWorkspace)
  const workspaceLabel = activeProject?.name ?? session?.cwd ?? '选择工作区'
  const workspacePath = activeProject?.displayPath ?? session?.cwd
  const workspaceTitle =
    workspacePath === undefined
      ? '选择用于本次对话的工作区'
      : `当前工作区：${workspaceLabel}（${workspacePath}）`
  const activeBranch = resolveMatchedBranchSummary({
    activeProject,
    projects,
    rootSnapshot: store.getSnapshot(),
    sourceControl,
  })

  const syncSplitAfterSwitch = (nextSessionId: string) => {
    if (scopedSessionId !== null && scopedSessionId !== nextSessionId) {
      workspaceTabs?.replaceSplitTab(scopedSessionId, nextSessionId)
    }
  }

  const switchTo = (projectId: string) => {
    setIsOpen(false)
    if (projectWorkspace !== null) {
      projectWorkspace.switchDraftWorkspace(projectId, {
        sessionId: scopedSessionId,
        onSwitched: syncSplitAfterSwitch,
      })
    } else {
      void store.switchDraftWorkspace(projectId, scopedSessionId).then(hasSwitched => {
        const nextSessionId = store.getSnapshot().selectedSessionId
        if (hasSwitched && nextSessionId !== null) syncSplitAfterSwitch(nextSessionId)
      })
    }
    triggerRef.current?.focus()
  }

  const openNewWorkspace = () => {
    setIsOpen(false)
    if (projectWorkspace !== null) projectWorkspace.createWorkspace()
    else void store.createWorkspace()
  }

  return (
    <div
      className={joinClasses('composer-workspace-bar', styles.bar)}
      data-composer-workspace-bar="true"
      role="group"
      aria-label="当前工作区"
    >
      <ElasticPress>
        <button
          ref={triggerRef}
          type="button"
          className={styles.pill}
          aria-label={`工作区：${workspaceLabel}`}
          aria-haspopup="menu"
          aria-expanded={isOpen}
          title={workspaceTitle}
          disabled={!canSwitch}
          onClick={() => {
            setIsOpen(value => !value)
          }}
        >
          {snapshot.creatingSession ? (
            <LoaderCircle className="spin" size={13} aria-hidden="true" />
          ) : (
            <Folder size={13} aria-hidden="true" />
          )}
          <span className={styles.label}>{workspaceLabel}</span>
          <ChevronDown
            size={12}
            className={joinClasses(styles.chevron, isOpen && styles.chevronOpen)}
            aria-hidden="true"
          />
        </button>
      </ElasticPress>
      {activeBranch !== null && activeBranch.branch !== null && (
        <span
          className={joinClasses(styles.pill, styles.branchPill)}
          data-composer-workspace-branch="true"
          title={formatBranchTitle(activeBranch.branch, activeBranch.ahead, activeBranch.behind)}
        >
          <GitBranch size={13} aria-hidden="true" />
          <span className={styles.label}>{activeBranch.branch}</span>
        </span>
      )}
      <AnchoredMenu
        open={isOpen}
        anchorRef={triggerRef}
        side="top"
        align="start"
        motion="morph"
        className={styles.menu ?? ''}
        label="选择工作区"
        onDismiss={dismiss}
      >
        <WorkspaceMenuContent
          projects={selectableProjects}
          activeProjectId={activeProject?.id}
          canCreateWorkspace={canCreateWorkspace}
          onSelect={switchTo}
          onCreate={openNewWorkspace}
        />
      </AnchoredMenu>
    </div>
  )
}
