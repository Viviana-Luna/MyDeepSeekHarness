import type { SessionSummary } from './session.ts'
import type { DesktopProjectDescriptor } from '../platform/contracts.ts'
import type { DesktopWorkspaceView } from '../../../shared/workspace-capabilities.ts'

export const UNGROUPED_PROJECT_ID = 'project:ungrouped'

interface ProjectSummaryBase {
  id: string
  projectAccessId?: string
  name: string
  displayPath: string
  sessionCount: number
  lastActivity: number
}

export type ProjectSummary = ProjectSummaryBase &
  (
    | {
        source: 'workspace'
        workspaceId: string
        cwd: string
        sessionIds: readonly string[]
      }
    | {
        source: 'legacy'
        cwd?: string
        sessionIds?: readonly string[]
      }
  )

function projectName(cwd: string): string {
  return cwd.split('/').findLast(part => part !== '') ?? cwd
}

function displayPath(cwd: string): string {
  const home = /^\/Users\/[^/]+(?=\/|$)/u.exec(cwd)?.[0]
  return home === undefined ? cwd : `~${cwd.slice(home.length)}`
}

export function projectIdForCwd(cwd: string): string {
  return `project:${encodeURIComponent(cwd)}`
}

export function parseDesktopProjects(value: unknown): DesktopProjectDescriptor[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return []
    const record = item as Record<string, unknown>
    if (
      typeof record.id !== 'string' ||
      typeof record.name !== 'string' ||
      typeof record.cwd !== 'string' ||
      typeof record.displayPath !== 'string'
    )
      return []
    return [
      {
        id: record.id,
        name: record.name,
        cwd: record.cwd,
        displayPath: record.displayPath,
        sessionCount: Number(record.sessionCount) || 0,
        lastActivity: Number(record.lastActivity) || 0,
      },
    ]
  })
}

export function deriveProjects(
  sessions: readonly SessionSummary[],
  registeredProjects: readonly DesktopProjectDescriptor[] = [],
): ProjectSummary[] {
  if (registeredProjects.length > 0) {
    const result: ProjectSummary[] = registeredProjects.map(project => ({
      ...project,
      projectAccessId: project.id,
      source: 'legacy',
    }))
    const ungrouped = sessions.filter(session => session.cwd === undefined)
    if (ungrouped.length > 0) {
      result.push({
        source: 'legacy',
        id: UNGROUPED_PROJECT_ID,
        name: '无项目对话',
        displayPath: '未绑定工作目录',
        sessionCount: ungrouped.length,
        lastActivity: Math.max(...ungrouped.map(session => session.updatedAt)),
      })
    }
    return result.toSorted(
      (left, right) =>
        right.lastActivity - left.lastActivity || left.name.localeCompare(right.name),
    )
  }
  const projects = new Map<string, ProjectSummary>()
  let ungroupedCount = 0
  let ungroupedLastActivity = 0
  for (const session of sessions) {
    if (session.cwd === undefined) {
      ungroupedCount += 1
      ungroupedLastActivity = Math.max(ungroupedLastActivity, session.updatedAt)
      continue
    }
    const id = projectIdForCwd(session.cwd)
    const current = projects.get(id)
    if (current === undefined) {
      projects.set(id, {
        source: 'legacy',
        id,
        name: projectName(session.cwd),
        cwd: session.cwd,
        displayPath: displayPath(session.cwd),
        sessionCount: 1,
        lastActivity: session.updatedAt,
      })
    } else {
      current.sessionCount += 1
      current.lastActivity = Math.max(current.lastActivity, session.updatedAt)
    }
  }
  const result = [...projects.values()]
  if (ungroupedCount > 0) {
    result.push({
      source: 'legacy',
      id: UNGROUPED_PROJECT_ID,
      name: '无项目对话',
      displayPath: '未绑定工作目录',
      sessionCount: ungroupedCount,
      lastActivity: ungroupedLastActivity,
    })
  }
  return result.toSorted(
    (left, right) => right.lastActivity - left.lastActivity || left.name.localeCompare(right.name),
  )
}

export function deriveWorkspaceProjects(
  sessions: readonly SessionSummary[],
  workspaces: readonly DesktopWorkspaceView[],
  registeredProjects: readonly DesktopProjectDescriptor[] = [],
): ProjectSummary[] {
  const sessionsById = new Map(sessions.map(session => [session.sessionId, session]))
  const registeredByCwd = new Map(registeredProjects.map(project => [project.cwd, project]))
  const accountedSessionIds = new Set(workspaces.flatMap(workspace => [...workspace.sessionIds]))
  const projects: ProjectSummary[] = workspaces.map(workspace => {
    const registered = registeredByCwd.get(workspace.path)
    const visibleSessions = workspace.sessionIds.flatMap(sessionId => {
      const session = sessionsById.get(sessionId)
      return session === undefined ? [] : [session]
    })
    return {
      source: 'workspace',
      id: projectIdForCwd(workspace.path),
      ...(registered === undefined ? {} : { projectAccessId: registered.id }),
      workspaceId: workspace.workspaceId,
      name: workspace.title.trim() || projectName(workspace.path),
      cwd: workspace.path,
      displayPath: displayPath(workspace.path),
      sessionIds: [...workspace.sessionIds],
      sessionCount: visibleSessions.length,
      lastActivity: visibleSessions.reduce(
        (latest, session) => Math.max(latest, session.updatedAt),
        Date.parse(workspace.updatedAt),
      ),
    }
  })
  const ungrouped = sessions.filter(session => !accountedSessionIds.has(session.sessionId))
  if (ungrouped.length > 0) {
    projects.push({
      source: 'legacy',
      id: UNGROUPED_PROJECT_ID,
      name: '无项目对话',
      displayPath: '未绑定 Durable Workspace',
      sessionIds: ungrouped.map(session => session.sessionId),
      sessionCount: ungrouped.length,
      lastActivity: Math.max(...ungrouped.map(session => session.updatedAt)),
    })
  }
  return projects
}

export function sessionsForProject(
  sessions: readonly SessionSummary[],
  project: ProjectSummary | undefined,
): SessionSummary[] {
  if (project === undefined) return []
  if (project.source === 'workspace') {
    const sessionsById = new Map(sessions.map(session => [session.sessionId, session]))
    return project.sessionIds.flatMap(sessionId => {
      const session = sessionsById.get(sessionId)
      return session === undefined ? [] : [session]
    })
  }
  if (project.sessionIds !== undefined) {
    const sessionIds = new Set(project.sessionIds)
    return sessions.filter(session => sessionIds.has(session.sessionId))
  }
  return sessions.filter(session =>
    project.cwd === undefined ? session.cwd === undefined : session.cwd === project.cwd,
  )
}

/**
 * 解析空会话或新会话草稿当前归属的可切换工作区项目。
 * 若会话归属于「无项目对话」分组则返回 undefined，允许用户从菜单切换到同目录的持久化工作区。
 */
export function resolveDraftProject(options: {
  readonly projects: readonly ProjectSummary[]
  readonly sessions: readonly SessionSummary[]
  readonly session: SessionSummary | undefined
  readonly newSessionProjectId: string | null
  readonly selectedProjectId: string | null
}): ProjectSummary | undefined {
  const { projects, sessions, session, newSessionProjectId, selectedProjectId } = options
  if (session !== undefined) {
    const owner = projects.find(project =>
      sessionsForProject(sessions, project).some(item => item.sessionId === session.sessionId),
    )
    if (owner !== undefined) {
      return owner.id === UNGROUPED_PROJECT_ID ? undefined : owner
    }
    if (session.cwd !== undefined) {
      return projects.find(project => project.cwd === session.cwd)
    }
    return undefined
  }
  const preferredId = newSessionProjectId ?? selectedProjectId
  if (preferredId === null || preferredId === UNGROUPED_PROJECT_ID) return undefined
  return projects.find(project => project.id === preferredId)
}
