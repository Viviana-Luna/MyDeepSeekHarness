import { renameWithRetry as rename } from '../../runtime/filesystem/file-operations.ts'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import {
  DESKTOP_PROJECT_TASK_CHANNELS,
  DESKTOP_PROJECT_TASK_LIMITS,
  type DesktopProjectTaskDefinition,
  type DesktopProjectTaskEvent,
  type DesktopProjectTaskSaveRequest,
} from '../../shared/project-tasks.ts'

interface StoredProjectTasks {
  version: 1
  projects: Record<string, DesktopProjectTaskDefinition[]>
}

import type { ProjectTaskLaunch } from '../../shared/project-tasks.ts'
import { asRecord } from '../../shared/validation.ts'
export type { ProjectTaskLaunch } from '../../shared/project-tasks.ts'

export interface ProjectTaskController {
  resolveLaunch(projectId: unknown, taskId: unknown): Promise<ProjectTaskLaunch>
  dispose(): void
}

function taskId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/u.test(value))
    throw new Error('项目任务标识无效')
  return value
}

function projectId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512)
    throw new Error('项目任务的项目标识无效')
  return value
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error(`${label}无效`)
  const normalized = value.trim()
  if (normalized === '' || normalized.length > maximum) throw new Error(`${label}无效`)
  return normalized
}

function relativeCwd(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    value.length > DESKTOP_PROJECT_TASK_LIMITS.maxRelativeCwdLength
  ) {
    throw new Error('项目任务工作目录无效')
  }
  const normalized = value.trim().replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, '')
  if (normalized === '' || normalized === '.') return ''
  if (
    normalized.startsWith('/') ||
    isAbsolute(normalized) ||
    normalized.split('/').includes('..')
  ) {
    throw new Error('项目任务工作目录必须位于项目根目录内')
  }
  return normalized
}

function environment(value: unknown): Record<string, string> {
  const input = asRecord(value)
  if (
    input === null ||
    Object.keys(input).length > DESKTOP_PROJECT_TASK_LIMITS.maxEnvironmentEntries
  ) {
    throw new Error('项目任务环境变量无效')
  }
  let totalBytes = 0
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(input)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) ||
      typeof item !== 'string' ||
      item.includes('\0') ||
      item.length > DESKTOP_PROJECT_TASK_LIMITS.maxEnvironmentValueLength
    ) {
      throw new Error('项目任务环境变量无效')
    }
    totalBytes += Buffer.byteLength(key) + Buffer.byteLength(item)
    if (totalBytes > 32 * 1024) throw new Error('项目任务环境变量超过 32 KiB 上限')
    result[key] = item
  }
  return result
}

function saveRequest(value: unknown): DesktopProjectTaskSaveRequest {
  const input = asRecord(value)
  if (
    input === null ||
    !Array.isArray(input.args) ||
    input.args.length > DESKTOP_PROJECT_TASK_LIMITS.maxArguments
  ) {
    throw new Error('项目任务定义无效')
  }
  const args = input.args.map(argument => {
    if (
      typeof argument !== 'string' ||
      argument.includes('\0') ||
      argument.length > DESKTOP_PROJECT_TASK_LIMITS.maxArgumentLength
    ) {
      throw new Error('项目任务参数无效')
    }
    return argument
  })
  if (args.reduce((total, argument) => total + Buffer.byteLength(argument), 0) > 32 * 1024) {
    throw new Error('项目任务参数超过 32 KiB 上限')
  }
  if (typeof input.allowConcurrent !== 'boolean') throw new Error('项目任务并发选项无效')
  return {
    projectId: projectId(input.projectId),
    ...(input.taskId === undefined ? {} : { taskId: taskId(input.taskId) }),
    name: text(input.name, '项目任务名称', DESKTOP_PROJECT_TASK_LIMITS.maxNameLength),
    executable: text(
      input.executable,
      '项目任务可执行程序',
      DESKTOP_PROJECT_TASK_LIMITS.maxExecutableLength,
    ),
    args,
    cwd: relativeCwd(input.cwd),
    env: environment(input.env),
    allowConcurrent: input.allowConcurrent,
  }
}

function inside(root: string, target: string): boolean {
  const fromRoot = relative(root, target)
  return (
    fromRoot === '' ||
    (!fromRoot.startsWith(`..${sep}`) && fromRoot !== '..' && !isAbsolute(fromRoot))
  )
}

function cloneDefinition(definition: DesktopProjectTaskDefinition): DesktopProjectTaskDefinition {
  return {
    ...definition,
    args: [...definition.args],
    env: { ...definition.env },
  }
}

export class ProjectTaskService {
  private readonly definitions = new Map<string, DesktopProjectTaskDefinition[]>()
  private loaded?: Promise<void>

  constructor(
    private readonly storagePath: string,
    private readonly resolveProjectDirectory: (projectId: unknown) => string,
    private readonly publish: (event: DesktopProjectTaskEvent) => void,
  ) {}

  async list(projectIdInput: unknown): Promise<readonly DesktopProjectTaskDefinition[]> {
    await this.ensureLoaded()
    const id = projectId(projectIdInput)
    this.resolveProjectDirectory(id)
    return (this.definitions.get(id) ?? []).map(cloneDefinition)
  }

  async save(value: unknown): Promise<DesktopProjectTaskDefinition> {
    await this.ensureLoaded()
    const request = saveRequest(value)
    this.resolveProjectDirectory(request.projectId)
    const tasks = [...(this.definitions.get(request.projectId) ?? [])]
    const index =
      request.taskId === undefined ? -1 : tasks.findIndex(task => task.id === request.taskId)
    if (request.taskId !== undefined && index === -1) throw new Error('要编辑的项目任务不存在')
    if (
      request.taskId === undefined &&
      tasks.length >= DESKTOP_PROJECT_TASK_LIMITS.maxTasksPerProject
    ) {
      throw new Error(
        `每个项目最多保存 ${String(DESKTOP_PROJECT_TASK_LIMITS.maxTasksPerProject)} 个任务`,
      )
    }
    const definition: DesktopProjectTaskDefinition = {
      id: request.taskId ?? randomUUID(),
      projectId: request.projectId,
      name: request.name,
      executable: request.executable,
      args: [...request.args],
      cwd: request.cwd,
      env: { ...request.env },
      allowConcurrent: request.allowConcurrent,
    }
    if (index === -1) tasks.push(definition)
    else tasks[index] = definition
    this.definitions.set(request.projectId, tasks)
    await this.persist()
    const snapshot = cloneDefinition(definition)
    this.publish({ type: 'snapshot', projectId: request.projectId, task: snapshot })
    return snapshot
  }

  async remove(taskIdInput: unknown): Promise<void> {
    await this.ensureLoaded()
    const id = taskId(taskIdInput)
    const found = this.find(id)
    this.definitions.set(
      found.definition.projectId,
      found.tasks.filter(task => task.id !== id),
    )
    await this.persist()
    this.publish({ type: 'removed', projectId: found.definition.projectId, taskId: id })
  }

  async reorder(projectIdInput: unknown, taskIdsInput: unknown): Promise<void> {
    await this.ensureLoaded()
    const id = projectId(projectIdInput)
    this.resolveProjectDirectory(id)
    if (!Array.isArray(taskIdsInput) || taskIdsInput.some(value => typeof value !== 'string')) {
      throw new Error('项目任务顺序无效')
    }
    const tasks = this.definitions.get(id) ?? []
    const ids = taskIdsInput.map(taskId)
    if (
      ids.length !== tasks.length ||
      new Set(ids).size !== ids.length ||
      tasks.some(task => !ids.includes(task.id))
    )
      throw new Error('项目任务顺序必须完整包含当前项目的全部任务')
    const byId = new Map(tasks.map(task => [task.id, task]))
    this.definitions.set(
      id,
      ids.map(candidateTaskId => byId.get(candidateTaskId) as DesktopProjectTaskDefinition),
    )
    await this.persist()
    this.publish({ type: 'reordered', projectId: id, taskIds: ids })
  }

  async resolveLaunch(projectIdInput: unknown, taskIdInput: unknown): Promise<ProjectTaskLaunch> {
    await this.ensureLoaded()
    const requestedProjectId = projectId(projectIdInput)
    const requestedTaskId = taskId(taskIdInput)
    const definition = (this.definitions.get(requestedProjectId) ?? []).find(
      task => task.id === requestedTaskId,
    )
    if (definition === undefined) throw new Error('项目任务不存在或不属于当前项目')

    const root = await realpath(this.resolveProjectDirectory(requestedProjectId)).catch(() => {
      throw new Error('项目任务所属项目目录不存在')
    })
    const requestedCwd = definition.cwd === '' ? root : resolve(root, definition.cwd)
    const cwd = await realpath(requestedCwd).catch(() => {
      throw new Error('项目任务工作目录不存在')
    })
    if (!inside(root, cwd) || !(await stat(cwd)).isDirectory()) {
      throw new Error('项目任务工作目录越过了项目根目录')
    }
    return {
      taskId: definition.id,
      name: definition.name,
      executable: definition.executable,
      args: [...definition.args],
      cwd,
      env: { ...definition.env },
      allowConcurrent: definition.allowConcurrent,
    }
  }

  private find(id: string): {
    definition: DesktopProjectTaskDefinition
    tasks: DesktopProjectTaskDefinition[]
  } {
    for (const tasks of this.definitions.values()) {
      const definition = tasks.find(task => task.id === id)
      if (definition !== undefined) return { definition, tasks }
    }
    throw new Error('项目任务不存在')
  }

  private ensureLoaded(): Promise<void> {
    this.loaded ??= this.load()
    return this.loaded
  }

  private async load(): Promise<void> {
    let input: unknown
    try {
      const bytes = await readFile(this.storagePath)
      if (bytes.byteLength > 2 * 1024 * 1024) throw new Error('项目任务配置超过 2 MiB 上限')
      input = JSON.parse(bytes.toString('utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      console.warn('无法读取项目任务配置，将使用空配置：', error)
      return
    }
    const source = asRecord(input)
    const projects = asRecord(source?.projects)
    if (source?.version !== 1 || projects === null) return
    for (const [storedProjectId, values] of Object.entries(projects)) {
      if (!Array.isArray(values) || values.length > DESKTOP_PROJECT_TASK_LIMITS.maxTasksPerProject)
        continue
      const definitions = values.flatMap(value => {
        try {
          const parsed = saveRequest({
            ...asRecord(value),
            projectId: storedProjectId,
            taskId: asRecord(value)?.id,
          })
          return [
            {
              id: parsed.taskId as string,
              projectId: parsed.projectId,
              name: parsed.name,
              executable: parsed.executable,
              args: [...parsed.args],
              cwd: parsed.cwd,
              env: { ...parsed.env },
              allowConcurrent: parsed.allowConcurrent,
            },
          ]
        } catch {
          return []
        }
      })
      if (definitions.length > 0) this.definitions.set(storedProjectId, definitions)
    }
  }

  private async persist(): Promise<void> {
    const projects = Object.fromEntries(
      [...this.definitions.entries()].filter(([, tasks]) => tasks.length > 0),
    )
    const document: StoredProjectTasks = { version: 1, projects }
    const temporaryPath = `${this.storagePath}.${randomUUID()}.tmp`
    await mkdir(dirname(this.storagePath), { recursive: true, mode: 0o700 })
    try {
      await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
        mode: 0o600,
        flag: 'wx',
      })
      await rename(temporaryPath, this.storagePath)
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }
}

export function installProjectTaskController(options: {
  window: BrowserWindow
  storagePath: string
  assertSender: (event: IpcMainInvokeEvent) => void
  resolveProjectDirectory: (projectId: unknown) => string
}): ProjectTaskController {
  let disposed = false
  const service = new ProjectTaskService(
    options.storagePath,
    options.resolveProjectDirectory,
    event => {
      if (!disposed && !options.window.isDestroyed()) {
        options.window.webContents.send(DESKTOP_PROJECT_TASK_CHANNELS.event, event)
      }
    },
  )
  ipcMain.handle(DESKTOP_PROJECT_TASK_CHANNELS.list, (event, requestedProjectId) => {
    options.assertSender(event)
    return service.list(requestedProjectId)
  })
  ipcMain.handle(DESKTOP_PROJECT_TASK_CHANNELS.save, (event, request) => {
    options.assertSender(event)
    return service.save(request)
  })
  ipcMain.handle(DESKTOP_PROJECT_TASK_CHANNELS.remove, (event, id) => {
    options.assertSender(event)
    return service.remove(id)
  })
  ipcMain.handle(DESKTOP_PROJECT_TASK_CHANNELS.reorder, (event, requestedProjectId, taskIds) => {
    options.assertSender(event)
    return service.reorder(requestedProjectId, taskIds)
  })
  return {
    resolveLaunch: (requestedProjectId, requestedTaskId) =>
      service.resolveLaunch(requestedProjectId, requestedTaskId),
    dispose() {
      if (disposed) return
      disposed = true
      ipcMain.removeHandler(DESKTOP_PROJECT_TASK_CHANNELS.list)
      ipcMain.removeHandler(DESKTOP_PROJECT_TASK_CHANNELS.save)
      ipcMain.removeHandler(DESKTOP_PROJECT_TASK_CHANNELS.remove)
      ipcMain.removeHandler(DESKTOP_PROJECT_TASK_CHANNELS.reorder)
    },
  }
}
