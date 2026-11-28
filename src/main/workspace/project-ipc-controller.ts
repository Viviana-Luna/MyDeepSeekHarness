/**
 * 主进程已授权项目缓存与项目工作区 IPC 控制器。
 *
 * 主进程仅维护已授权项目的只读目录快照供系统动作（如在文件管理器中定位）与拖入文件校验使用；
 * 真实文件读写与 Git 状态全部委托给后台 Runtime，窗口退出时由 `dispose()` 移除全部 IPC 处理器。
 */

import { ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { PROJECT_OPERATIONS, type DesktopProject } from '../../runtime/workspace/project-service.ts'
import { DESKTOP_FILE_REFERENCE_CHANNELS } from '../../shared/file-references.ts'
import { isGitAiOperation } from '../../shared/git-ai-validation.ts'
import { asRecord } from '../../shared/validation.ts'
import { createGitAiController } from '../runtime/git-ai-controller.ts'

/** 项目工作区 IPC 通道名。 */
export const PROJECT_CHANNELS = Object.freeze({
  list: 'dsh-desktop:project:list',
  call: 'dsh-desktop:project:call',
})

/** 安装项目工作区 IPC 控制器的输入依赖。 */
export interface ProjectIpcControllerOptions {
  readonly window: BrowserWindow
  readonly assertSender: (event: IpcMainInvokeEvent) => void
  readonly runtimeCall: (endpoint: string, args: Record<string, unknown>) => Promise<unknown>
}

/** 已安装的项目工作区 IPC 控制器实例。 */
export interface ProjectIpcController {
  getProjects(): readonly DesktopProject[]
  resolveProjectDirectory(id: unknown): string
  syncFromWorkspaceBaseline(value: unknown): Promise<void>
  syncFromSessionsList(value: unknown): Promise<void>
  clearCache(): void
  dispose(): void
}

function extractSessionSyncItems(
  projectSessions: unknown,
): Array<{ cwd?: string; updatedAt?: number }> {
  const baseline = asRecord(projectSessions)
  if (!Array.isArray(baseline?.items)) return []
  return baseline.items.map(raw => {
    const item = asRecord(raw)
    const entry: { cwd?: string; updatedAt?: number } = {}
    if (typeof item?.cwd === 'string') entry.cwd = item.cwd
    if (typeof item?.updatedAt === 'number') entry.updatedAt = item.updatedAt
    return entry
  })
}

async function executeProjectOperation(options: {
  readonly operation: unknown
  readonly payload: unknown
  readonly resolveProjectDirectory: (id: unknown) => string
  readonly callGitAi: ReturnType<typeof createGitAiController>
  readonly runtimeCall: ProjectIpcControllerOptions['runtimeCall']
}): Promise<unknown> {
  const { operation, payload, resolveProjectDirectory, callGitAi, runtimeCall } = options
  try {
    const request = asRecord(payload)
    if (!request || typeof request.projectId !== 'string') throw new Error('项目操作参数无效')
    if (operation !== 'gitAiRelease' && operation !== 'gitAiCancel') {
      resolveProjectDirectory(request.projectId)
    }
    if (
      typeof operation !== 'string' ||
      !(PROJECT_OPERATIONS as readonly string[]).includes(operation)
    ) {
      throw new Error('不支持的项目操作')
    }
    if (operation === 'revealInFinder') {
      shell.showItemInFolder(resolveProjectDirectory(request.projectId))
      return { revealed: true }
    }
    const { projectId, ...argumentsOnly } = request
    if (isGitAiOperation(operation)) return await callGitAi(projectId, operation, argumentsOnly)
    return await runtimeCall('mydshWorkspace/call', {
      projectId,
      operation,
      payload: argumentsOnly,
    })
  } catch (error) {
    if (!isGitAiOperation(operation)) console.warn('项目桌面操作失败：', error)
    throw new Error(error instanceof Error ? error.message : '项目桌面操作失败', { cause: error })
  }
}

/** 安装项目目录缓存与工作区 IPC 处理器。 */
export function installProjectIpcController(
  options: ProjectIpcControllerOptions,
): ProjectIpcController {
  const { window, assertSender, runtimeCall } = options
  let projects: readonly DesktopProject[] = []
  let projectSessions: unknown = { items: [] }
  let projectRoots: string[] = []

  const resolveProjectDirectory = (id: unknown): string => {
    const project = projects.find(item => item.id === id)
    if (!project) throw new Error('项目不存在或尚未取得访问授权')
    return project.cwd
  }

  const synchronizeProjects = async (): Promise<void> => {
    projects = (await runtimeCall('mydshWorkspace/sync', {
      sessions: { items: extractSessionSyncItems(projectSessions) },
      roots: projectRoots,
    })) as DesktopProject[]
  }

  const callGitAi = createGitAiController({
    window,
    call: (projectId, operation, payload) =>
      runtimeCall('mydshWorkspace/call', { projectId, operation, payload }),
  })

  ipcMain.handle(PROJECT_CHANNELS.list, event => {
    assertSender(event)
    return projects
  })

  ipcMain.handle(PROJECT_CHANNELS.call, async (event, operation: unknown, payload: unknown) => {
    assertSender(event)
    return executeProjectOperation({
      operation,
      payload,
      resolveProjectDirectory,
      callGitAi,
      runtimeCall,
    })
  })

  ipcMain.handle(
    DESKTOP_FILE_REFERENCE_CHANNELS.resolveDroppedFiles,
    async (event, request: unknown) => {
      assertSender(event)
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        throw new Error('拖入文件引用请求无效')
      }
      const value = request as Record<string, unknown>
      return runtimeCall('mydshWorkspace/resolveDroppedFiles', {
        projectId: value.projectId,
        paths: value.absolutePaths,
      })
    },
  )

  return {
    getProjects: () => projects,
    resolveProjectDirectory,
    async syncFromWorkspaceBaseline(value: unknown) {
      const baseline = asRecord(value)
      if (Array.isArray(baseline?.items)) {
        projectRoots = baseline.items
          .map(asRecord)
          .flatMap(item => (typeof item?.path === 'string' ? [item.path] : []))
      }
      await synchronizeProjects()
    },
    async syncFromSessionsList(value: unknown) {
      projectSessions = value
      await synchronizeProjects()
    },
    clearCache() {
      projects = []
      projectSessions = { items: [] }
      projectRoots = []
    },
    dispose() {
      ipcMain.removeHandler(PROJECT_CHANNELS.list)
      ipcMain.removeHandler(PROJECT_CHANNELS.call)
      ipcMain.removeHandler(DESKTOP_FILE_REFERENCE_CHANNELS.resolveDroppedFiles)
    },
  }
}
