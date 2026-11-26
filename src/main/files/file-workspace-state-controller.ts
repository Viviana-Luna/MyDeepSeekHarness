import { renameWithRetry as rename } from '../../runtime/filesystem/file-operations.ts'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  DESKTOP_FILE_WORKSPACE_CHANNELS,
  DESKTOP_FILE_WORKSPACE_LIMITS,
  type DesktopFileWorkspaceState,
} from '../../shared/file-workspace-state.ts'
import { asRecord } from '../../shared/validation.ts'

interface StoredFileWorkspaces {
  version: 1
  projects: Record<string, DesktopFileWorkspaceState>
}

export interface FileWorkspaceStateController {
  dispose(): void
}

function projectId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{24}$/u.test(value))
    throw new Error('文件工作区的项目标识无效')
  return value
}

function relativePath(value: unknown, allowRoot = false): string {
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    value.length > DESKTOP_FILE_WORKSPACE_LIMITS.maxRelativePathLength
  ) {
    throw new Error('文件工作区包含无效相对路径')
  }
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, '')
  if (
    (!allowRoot && normalized === '') ||
    isAbsolute(normalized) ||
    /^[a-z]:/iu.test(normalized) ||
    normalized.split('/').includes('..')
  )
    throw new Error('文件工作区路径必须位于项目内')
  return normalized
}

function uniquePaths(value: unknown, maximum: number, allowRoot = false): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error('文件工作区路径列表无效')
  const paths = value.map(item => relativePath(item, allowRoot))
  if (new Set(paths).size !== paths.length) throw new Error('文件工作区路径列表不能重复')
  return paths
}

function scrollOffset(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > DESKTOP_FILE_WORKSPACE_LIMITS.maxScrollOffset
  )
    throw new Error('文件树滚动位置无效')
  return Math.round(value)
}

function optionalPath(value: unknown): string | undefined {
  return value === undefined ? undefined : relativePath(value)
}

function optionalLine(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > 10_000_000) {
    throw new Error('文件工作区行号无效')
  }
  return Number(value)
}

function parseState(value: unknown, expectedProjectId?: string): DesktopFileWorkspaceState {
  const input = asRecord(value)
  if (input === null) throw new Error('文件工作区状态无效')
  const id = projectId(input.projectId)
  if (expectedProjectId !== undefined && id !== expectedProjectId)
    throw new Error('文件工作区项目标识不一致')
  const pinnedFiles = uniquePaths(input.pinnedFiles, DESKTOP_FILE_WORKSPACE_LIMITS.maxPinnedFiles)
  const previewFile = optionalPath(input.previewFile)
  const activeFile = optionalPath(input.activeFile)
  const activeLine = optionalLine(input.activeLine)
  if (previewFile !== undefined && pinnedFiles.includes(previewFile))
    throw new Error('预览文件不能同时作为固定标签')
  if (activeFile !== undefined && activeFile !== previewFile && !pinnedFiles.includes(activeFile))
    throw new Error('当前文件必须属于已保存标签')
  return {
    projectId: id,
    pinnedFiles,
    ...(previewFile === undefined ? {} : { previewFile }),
    ...(activeFile === undefined ? {} : { activeFile }),
    ...(activeLine === undefined ? {} : { activeLine }),
    expandedDirectories: uniquePaths(
      input.expandedDirectories,
      DESKTOP_FILE_WORKSPACE_LIMITS.maxExpandedDirectories,
      true,
    ),
    recentFiles: uniquePaths(input.recentFiles, DESKTOP_FILE_WORKSPACE_LIMITS.maxRecentFiles),
    treeScrollLeft: scrollOffset(input.treeScrollLeft),
    treeScrollTop: scrollOffset(input.treeScrollTop),
  }
}

export class FileWorkspaceStateStore {
  private loaded?: Promise<void>
  private writeQueue: Promise<void> = Promise.resolve()
  private readonly projects = new Map<string, DesktopFileWorkspaceState>()

  constructor(private readonly storagePath: string) {}

  async read(projectIdInput: unknown): Promise<DesktopFileWorkspaceState | null> {
    await this.ensureLoaded()
    const id = projectId(projectIdInput)
    const state = this.projects.get(id)
    return state === undefined ? null : structuredClone(state)
  }

  async save(value: unknown): Promise<DesktopFileWorkspaceState> {
    await this.ensureLoaded()
    const state = parseState(value)
    if (
      !this.projects.has(state.projectId) &&
      this.projects.size >= DESKTOP_FILE_WORKSPACE_LIMITS.maxProjects
    ) {
      const oldest = this.projects.keys().next().value as string | undefined
      if (oldest !== undefined) this.projects.delete(oldest)
    }
    this.projects.delete(state.projectId)
    this.projects.set(state.projectId, state)
    const write = this.writeQueue.then(() => this.persist())
    this.writeQueue = write.catch(() => undefined)
    await write
    return structuredClone(state)
  }

  private ensureLoaded(): Promise<void> {
    this.loaded ??= this.load()
    return this.loaded
  }

  private async load(): Promise<void> {
    let input: unknown
    try {
      const bytes = await readFile(this.storagePath)
      if (bytes.byteLength > 2 * 1024 * 1024) throw new Error('文件工作区配置超过 2 MiB 上限')
      input = JSON.parse(bytes.toString('utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        console.warn('无法读取文件工作区状态，将使用空状态：', error)
      return
    }
    const source = asRecord(input)
    const projects = asRecord(source?.projects)
    if (source?.version !== 1 || projects === null) return
    for (const [id, value] of Object.entries(projects).slice(
      -DESKTOP_FILE_WORKSPACE_LIMITS.maxProjects,
    )) {
      try {
        const state = parseState(value, id)
        this.projects.set(id, state)
      } catch {
        // 单个项目状态损坏时只丢弃该项目，不影响其他工作区恢复。
      }
    }
  }

  private async persist(): Promise<void> {
    const document: StoredFileWorkspaces = {
      version: 1,
      projects: Object.fromEntries(this.projects),
    }
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

export function installFileWorkspaceStateController(options: {
  storagePath: string
  assertSender: (event: IpcMainInvokeEvent) => void
  resolveProjectDirectory: (projectId: unknown) => string
}): FileWorkspaceStateController {
  const store = new FileWorkspaceStateStore(options.storagePath)
  ipcMain.handle(DESKTOP_FILE_WORKSPACE_CHANNELS.read, (event, id) => {
    options.assertSender(event)
    options.resolveProjectDirectory(id)
    return store.read(id)
  })
  ipcMain.handle(DESKTOP_FILE_WORKSPACE_CHANNELS.save, (event, value) => {
    options.assertSender(event)
    const input = asRecord(value)
    options.resolveProjectDirectory(input?.projectId)
    return store.save(value)
  })
  return {
    dispose() {
      ipcMain.removeHandler(DESKTOP_FILE_WORKSPACE_CHANNELS.read)
      ipcMain.removeHandler(DESKTOP_FILE_WORKSPACE_CHANNELS.save)
    },
  }
}
