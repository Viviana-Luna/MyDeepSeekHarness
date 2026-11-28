/**
 * 统一工作标签聚合 Hook：汇总会话、文件、终端、SSH、浏览器与 Git 差异标签，并暴露共享分组计算函数。
 * 运行在 renderer；仅读取既有业务 Provider 快照，不持有额外副作用资源。
 */
import { useWorkspaceSnapshot, useWorkspaceStore } from '../../hooks/useWorkspace.ts'
import { sessionTitle } from '../../domain/session.ts'
import { sessionsForProject } from '../../domain/project.ts'
import {
  useOptionalProjectWorkspace,
  useProjectWorkspace,
} from '../project-workspace/ProjectWorkspaceProvider.tsx'
import { useWorkspaceTabs, type WorkTab } from './WorkspaceTabsProvider.tsx'
import { diffKey, useOptionalSourceControl } from '../source-control/SourceControlProvider.tsx'

export {
  resolveWorkTabGroups,
  shouldShowSessionTabs,
  type ResolvedWorkTabGroups,
  type WorkTabGroup,
} from './work-tab-groups.ts'

function useResolvedWorkTabs(workspace: ReturnType<typeof useOptionalProjectWorkspace>): WorkTab[] {
  const snapshot = useWorkspaceSnapshot()
  const store = useWorkspaceStore()
  const terminalTabs = useWorkspaceTabs()
  const source = useOptionalSourceControl()
  const project = store.selectedProject?.()
  const projects = snapshot.projects ?? []
  const sessions = snapshot.sessions ?? []
  const openedSessionIds = snapshot.openedSessionIds ?? []
  const unreadSessionIds = snapshot.unreadSessionIds ?? []
  const resources: WorkTab[] = openedSessionIds.flatMap(id => {
    const session = sessions.find(item => item.sessionId === id)
    if (session === undefined) return []
    const owner = projects.find(item => sessionsForProject([session], item).length > 0)
    return [
      {
        id,
        kind: 'session',
        projectId: owner?.id ?? 'unassigned',
        title: sessionTitle(session),
        description: sessionTitle(session),
        active:
          id === snapshot.selectedSessionId &&
          ['conversation', 'trajectory'].includes(snapshot.activeView),
        running: session.running,
        unread: unreadSessionIds.includes(id),
        select: () => {
          if (workspace !== null) workspace.selectSessionTab(id)
          else store.selectSessionTab?.(id)
        },
        close: () => {
          if (workspace !== null) workspace.closeSessionTab(id)
          else store.closeSessionTab?.(id)
        },
      },
    ]
  })
  if (project !== undefined && workspace !== null) {
    for (const file of workspace.openFiles) {
      const selected = workspace.selectedFile?.relativePath === file.relativePath
      resources.push({
        id: `file:${project.id}:${file.relativePath}`,
        kind: 'file',
        projectId: project.id,
        title: file.relativePath.split('/').at(-1) ?? file.relativePath,
        description: file.relativePath,
        active: selected && snapshot.activeView === 'files',
        preview: !file.pinned,
        dirty:
          workspace.documents?.[file.relativePath]?.selectedFile.kind === 'text'
            ? workspace.documents[file.relativePath]!.fileDraft !==
              (workspace.documents[file.relativePath]!.selectedFile as { content: string }).content
            : selected && workspace.fileDirty,
        select: () => {
          workspace.selectFileTab(file.relativePath)
        },
        close: () => {
          workspace.closeFileTab(file.relativePath)
        },
        pin: () => {
          workspace.pinFile(file.relativePath)
        },
      })
    }
  }
  const activeTerminalAccessId =
    project?.projectAccessId ??
    terminalTabs?.activeTerminalProjectAccessId ??
    terminalTabs?.terminalGroups?.findLast(item => item.tabs.length > 0)?.projectAccessId ??
    null
  for (const group of terminalTabs?.terminalGroups ?? []) {
    const owner = projects.find(item => item.projectAccessId === group.projectAccessId)
    if (owner === undefined) continue
    for (const tab of group.tabs)
      resources.push({
        id: `terminal:${group.projectAccessId}:${tab.key}`,
        kind: 'terminal',
        projectId: owner.id,
        closeLabel: `关闭终端 ${String(tab.number)}`,
        title: tab.title,
        description: `${tab.title} · ${tab.description}`,
        active:
          group.projectAccessId === activeTerminalAccessId &&
          snapshot.activeView === 'terminal' &&
          group.activeKey === tab.key,
        running: tab.status === 'starting',
        select: () => {
          const activate = () => {
            terminalTabs?.selectTerminalProject(group.projectAccessId)
            group.select(tab.key)
            store.setView('terminal')
          }
          if (workspace !== null) workspace.navigateProjectTab(owner.id, activate)
          else activate()
        },
        close: () => {
          group.close(tab.key)
        },
      })
  }
  const ssh = terminalTabs?.sshGroup
  if (ssh)
    for (const tab of ssh.tabs)
      resources.push({
        id: `ssh:${tab.id}`,
        kind: 'ssh',
        projectId: 'unassigned',
        title: tab.title,
        description: tab.description,
        active: snapshot.activeView === 'connections' && ssh.activeId === tab.id,
        closeLabel: `关闭 SSH 终端 ${tab.title}`,
        closeDisabled: ssh.busy,
        select: () => {
          ssh.select(tab.id)
          store.setView('connections')
        },
        close: () => ssh.close(tab.id),
      })
  for (const tab of terminalTabs?.browserTabs ?? [])
    resources.push({
      id: `browser:${tab.id}`,
      kind: 'browser',
      projectId: tab.projectId,
      title: tab.title,
      description: tab.title,
      active: snapshot.activeView === 'browser' && terminalTabs?.activeBrowserId === tab.id,
      select: () => {
        terminalTabs?.selectBrowser(tab.id)
        store.setView('browser')
      },
      close: () => {
        void terminalTabs?.closeBrowser(tab.id)
      },
    })
  if (project && source)
    for (const diff of source.openedDiffs)
      resources.push({
        id: `diff:${project.id}:${diffKey(diff)}`,
        kind: 'diff',
        projectId: project.id,
        title: `${diff.relativePath.split('/').at(-1)}（${diff.mode === 'working' ? '工作区' : diff.mode === 'staged' ? '暂存区' : diff.mode === 'commit' ? diff.commitHash?.slice(0, 7) : (diff.reviewTitle ?? '比较')}）`,
        description: diff.relativePath,
        active:
          snapshot.activeView === 'changes' &&
          source.selectedDiff !== null &&
          diffKey(source.selectedDiff) === diffKey(diff),
        select: () => {
          source.selectDiff(diffKey(diff))
        },
        close: () => {
          source.closeDiff(diffKey(diff))
        },
      })
  const rawActive = resources.find(tab => tab.active)
  const group = terminalTabs?.splitGroups?.find(
    item => rawActive !== undefined && item.tabs.includes(rawActive.id),
  )
  const focused = group?.tabs.includes(terminalTabs?.focusedTabId ?? '')
    ? terminalTabs?.focusedTabId
    : rawActive?.id
  return resources.map(tab => {
    const navigate = tab.select
    return Object.assign(tab, {
      rawActive: tab.active,
      navigate,
      active: group ? tab.id === focused : tab.active,
      select: () => {
        if (group?.tabs.includes(tab.id)) terminalTabs?.focus(tab.id)
        else navigate()
      },
    })
  })
}

/** 收集当前工作区全部已打开标签并附加分屏组焦点语义。 */
export function useWorkTabs(): WorkTab[] {
  return useResolvedWorkTabs(useProjectWorkspace())
}

/** 在可能脱离 ProjectWorkspaceProvider 的上下文（如输入框胶囊或单测）中安全收集工作标签。 */
export function useOptionalWorkTabs(): WorkTab[] {
  return useResolvedWorkTabs(useOptionalProjectWorkspace())
}
