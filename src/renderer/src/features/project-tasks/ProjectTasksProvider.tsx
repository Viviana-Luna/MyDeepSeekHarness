import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type {
  DesktopProjectTaskDefinition,
  DesktopProjectTaskSaveRequest,
} from '../../../../shared/project-tasks.ts'
import { useWorkspaceSnapshot, useWorkspaceStore } from '../../hooks/useWorkspace.ts'
import { getDesktopBridge } from '../../services/desktop.ts'
import {
  parseProjectTaskDefinition,
  parseProjectTaskEvent,
  parseProjectTaskList,
} from './project-task-types.ts'

type TaskDraft = Omit<DesktopProjectTaskSaveRequest, 'projectId'>

export interface ProjectTaskLaunchRequest {
  key: number
  projectId: string
  projectName: string
  taskId: string
  name: string
  allowConcurrent: boolean
}

interface ProjectTasksState {
  projectId: string | null
  tasks: readonly DesktopProjectTaskDefinition[]
  launchRequest: ProjectTaskLaunchRequest | null
  loading: boolean
  mutation: string | null
  error: string | null
  clearError(): void
  saveTask(draft: TaskDraft): Promise<boolean>
  removeTask(taskId: string): Promise<boolean>
  reorderTasks(taskIds: readonly string[]): Promise<boolean>
  runTask(taskId: string): void
  consumeLaunchRequest(key: number): void
}

const ProjectTasksContext = createContext<ProjectTasksState | null>(null)

function message(error: unknown): string {
  const raw = error instanceof Error ? error.message : '项目任务操作失败'
  return raw
    .replace(/^Error invoking remote method '[^']+': Error:\s*/u, '')
    .replace(/^Error:\s*/u, '')
}

export function ProjectTasksProvider({ children }: { children: ReactNode }) {
  const store = useWorkspaceStore()
  const snapshot = useWorkspaceSnapshot()
  const api = getDesktopBridge().projectTasks
  const selectedSession = snapshot.sessions.find(
    session => session.sessionId === snapshot.selectedSessionId,
  )
  const selectedProjectId =
    snapshot.selectedProjectId ??
    snapshot.projects.find(project => project.cwd === selectedSession?.cwd)?.id ??
    null
  const project = snapshot.projects.find(candidate => candidate.id === selectedProjectId)
  const projectId = project?.projectAccessId ?? null
  const projectIdRef = useRef(projectId)
  projectIdRef.current = projectId
  const launchKey = useRef(0)
  const [tasks, setTasks] = useState<readonly DesktopProjectTaskDefinition[]>([])
  const [launchRequest, setLaunchRequest] = useState<ProjectTaskLaunchRequest | null>(null)
  const [loading, setLoading] = useState(false)
  const [mutation, setMutation] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const clearError = useCallback(() => {
    setError(null)
  }, [])

  useEffect(() => {
    if (api === undefined) return
    return api.onEvent(raw => {
      try {
        const event = parseProjectTaskEvent(raw)
        if (event.projectId !== projectIdRef.current) return
        if (event.type === 'snapshot') {
          setTasks(current => {
            const index = current.findIndex(task => task.id === event.task.id)
            return index === -1
              ? [...current, event.task]
              : current.map(task => (task.id === event.task.id ? event.task : task))
          })
          return
        }
        if (event.type === 'removed') {
          setTasks(current => current.filter(task => task.id !== event.taskId))
          return
        }
        setTasks(current => {
          const byId = new Map(current.map(task => [task.id, task]))
          return event.taskIds.flatMap(id => {
            const task = byId.get(id)
            return task === undefined ? [] : [task]
          })
        })
      } catch (caught) {
        setError(message(caught))
      }
    })
  }, [api])

  useEffect(() => {
    setTasks([])
    setMutation(null)
    setLoading(false)
    setError(null)
    if (api === undefined || projectId === null) return
    let active = true
    setLoading(true)
    void api
      .list(projectId)
      .then(value => {
        if (active && projectIdRef.current === projectId) setTasks(parseProjectTaskList(value))
      })
      .catch((caught: unknown) => {
        if (active && projectIdRef.current === projectId) setError(message(caught))
      })
      .finally(() => {
        if (active && projectIdRef.current === projectId) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [api, projectId])

  const saveTask = useCallback(
    async (draft: TaskDraft) => {
      if (api === undefined || projectId === null) return false
      setMutation('save')
      setError(null)
      try {
        const task = parseProjectTaskDefinition(await api.save({ ...draft, projectId }))
        if (projectIdRef.current !== projectId) return false
        setTasks(current =>
          current.some(candidate => candidate.id === task.id)
            ? current.map(candidate => (candidate.id === task.id ? task : candidate))
            : [...current, task],
        )
        return true
      } catch (caught) {
        if (projectIdRef.current === projectId) setError(message(caught))
        return false
      } finally {
        if (projectIdRef.current === projectId) setMutation(null)
      }
    },
    [api, projectId],
  )

  const removeTask = useCallback(
    async (taskId: string) => {
      if (api === undefined) return false
      setMutation(taskId)
      setError(null)
      try {
        await api.remove(taskId)
        if (projectIdRef.current !== projectId) return false
        setTasks(current => current.filter(task => task.id !== taskId))
        return true
      } catch (caught) {
        if (projectIdRef.current === projectId) setError(message(caught))
        return false
      } finally {
        if (projectIdRef.current === projectId) setMutation(null)
      }
    },
    [api, projectId],
  )

  const reorderTasks = useCallback(
    async (taskIds: readonly string[]) => {
      if (api === undefined || projectId === null) return false
      setMutation('reorder')
      setError(null)
      try {
        await api.reorder(projectId, taskIds)
        if (projectIdRef.current !== projectId) return false
        const byId = new Map(tasks.map(task => [task.id, task]))
        setTasks(
          taskIds.flatMap(id => {
            const task = byId.get(id)
            return task === undefined ? [] : [task]
          }),
        )
        return true
      } catch (caught) {
        if (projectIdRef.current === projectId) setError(message(caught))
        return false
      } finally {
        if (projectIdRef.current === projectId) setMutation(null)
      }
    },
    [api, projectId, tasks],
  )

  const runTask = useCallback(
    (taskId: string) => {
      const task = tasks.find(candidate => candidate.id === taskId)
      if (task === undefined || projectId === null) {
        setError('要运行的项目任务不存在')
        return
      }
      launchKey.current += 1
      setLaunchRequest({
        key: launchKey.current,
        projectId,
        projectName: project?.name ?? '当前项目',
        taskId: task.id,
        name: task.name,
        allowConcurrent: task.allowConcurrent,
      })
      if (snapshot.activeView !== 'terminal') store.setView('terminal')
    },
    [project?.name, projectId, snapshot.activeView, store, tasks],
  )

  const consumeLaunchRequest = useCallback((key: number) => {
    setLaunchRequest(current => (current?.key === key ? null : current))
  }, [])

  const value = useMemo<ProjectTasksState>(
    () => ({
      projectId,
      tasks,
      launchRequest,
      loading,
      mutation,
      error,
      clearError,
      saveTask,
      removeTask,
      reorderTasks,
      runTask,
      consumeLaunchRequest,
    }),
    [
      projectId,
      tasks,
      launchRequest,
      loading,
      mutation,
      error,
      clearError,
      saveTask,
      removeTask,
      reorderTasks,
      runTask,
      consumeLaunchRequest,
    ],
  )
  return <ProjectTasksContext.Provider value={value}>{children}</ProjectTasksContext.Provider>
}

export function useProjectTasks(): ProjectTasksState {
  const value = useContext(ProjectTasksContext)
  if (value === null) throw new Error('ProjectTasksProvider 尚未挂载')
  return value
}
