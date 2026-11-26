export const DESKTOP_PROJECT_TASK_CHANNELS = Object.freeze({
  list: 'dsh-desktop:project-tasks:list',
  save: 'dsh-desktop:project-tasks:save',
  remove: 'dsh-desktop:project-tasks:remove',
  reorder: 'dsh-desktop:project-tasks:reorder',
  event: 'dsh-desktop:project-tasks:event',
})

export const DESKTOP_PROJECT_TASK_LIMITS = Object.freeze({
  maxTasksPerProject: 50,
  maxNameLength: 80,
  maxExecutableLength: 512,
  maxArguments: 64,
  maxArgumentLength: 4_096,
  maxEnvironmentEntries: 32,
  maxEnvironmentValueLength: 4_096,
  maxRelativeCwdLength: 2_048,
})

export interface DesktopProjectTaskDefinition {
  id: string
  projectId: string
  name: string
  executable: string
  args: readonly string[]
  cwd: string
  env: Readonly<Record<string, string>>
  allowConcurrent: boolean
}

export interface DesktopProjectTaskSaveRequest {
  projectId: string
  taskId?: string
  name: string
  executable: string
  args: readonly string[]
  cwd: string
  env: Readonly<Record<string, string>>
  allowConcurrent: boolean
}

export type DesktopProjectTaskEvent =
  | {
      type: 'snapshot'
      projectId: string
      task: DesktopProjectTaskDefinition
    }
  | {
      type: 'removed'
      projectId: string
      taskId: string
    }
  | {
      type: 'reordered'
      projectId: string
      taskIds: readonly string[]
    }

export interface ProjectTaskLaunch {
  taskId: string
  name: string
  executable: string
  args: readonly string[]
  cwd: string
  env: Readonly<Record<string, string>>
  allowConcurrent: boolean
}
