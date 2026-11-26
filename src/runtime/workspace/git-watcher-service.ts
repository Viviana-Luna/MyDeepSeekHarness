/**
 * 项目 Git 仓库与工作区文件监听器：运行在后台 Runtime 进程。
 * 借鉴 VS Code Git 扩展做法，监听 .git 元数据（HEAD/index/refs，兼容 worktree）与工作区变更，
 * 经防抖合并与 index.lock 避让后发出轻量通知；拥有全部 FSWatcher 与定时器，退出或切换基线时统一释放。
 */
import { execFile } from 'node:child_process'
import { realpath as fsRealpath, watch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type {
  DesktopProjectEvent,
  DesktopProjectGitChangeReason,
  DesktopProjectGitChangeScope,
} from '../../shared/project-events.ts'

const execFileAsync = promisify(execFile)
const realpath = promisify(fsRealpath.native)

function samePath(first: string, second: string): boolean {
  return process.platform === 'win32'
    ? first.toLowerCase() === second.toLowerCase()
    : first === second
}

const MAX_WATCHED_PROJECTS = 16
const DEFAULT_DEBOUNCE_MS = 400
const DEFAULT_LOCK_BACKOFF_MS = 350
const MAX_LOCK_RETRIES = 4

const IGNORED_DIRECTORY_SEGMENTS = new Set([
  '.git',
  'node_modules',
  '.pnpm-store',
  '.next',
  '.nuxt',
  '.umi',
  '.umi-production',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.tmp',
  '.cache',
])

const GIT_REFS_FILES = new Set([
  'HEAD',
  'packed-refs',
  'FETCH_HEAD',
  'ORIG_HEAD',
  'MERGE_HEAD',
  'REBASE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'rebase-merge',
  'rebase-apply',
  'refs',
])

/** 纳入监听的项目描述符。 */
export interface WatchedProjectDescriptor {
  readonly id: string
  readonly cwd: string
}

/** Git 监听器可选调优参数，便于单测缩短防抖与退避耗时。 */
export interface GitWatcherOptions {
  readonly debounceMs?: number
  readonly lockBackoffMs?: number
  readonly maxProjects?: number
}

interface GitDirectories {
  readonly gitDir: string
  readonly commonDir: string
}

interface ProjectWatchState {
  readonly projectId: string
  readonly cwd: string
  readonly abortController: AbortController
  gitDir: string | null
  commonDir: string | null
  watchers: FSWatcher[]
  pendingScope: DesktopProjectGitChangeScope | null
  pendingReason: DesktopProjectGitChangeReason
  debounceTimer: ReturnType<typeof setTimeout> | null
  lockRetries: number
  disposed: boolean
}

/** 合并两次 Git 变更范围：一旦包含 refs 级别变化，即升级为 refs，避免遗漏提交图刷新。 */
export function mergeGitChangeScope(
  current: DesktopProjectGitChangeScope | null,
  incoming: DesktopProjectGitChangeScope,
): DesktopProjectGitChangeScope {
  return current === 'refs' || incoming === 'refs' ? 'refs' : 'working'
}

/**
 * 分类 .git 根目录下的单层文件变化；忽略 *.lock 与无关对象日志，仅响应 HEAD/index/refs 等状态文件。
 */
export function classifyGitMetadataPath(
  filename: string | null,
): DesktopProjectGitChangeScope | null {
  if (!filename) return 'refs'
  const normalized = filename.replaceAll('\\', '/').replace(/^\.\//u, '')
  const top = normalized.split('/')[0] ?? ''
  if (top === '' || normalized.endsWith('.lock') || top === 'objects' || top === 'logs') return null
  if (top === 'index') return 'working'
  if (GIT_REFS_FILES.has(top)) return 'refs'
  return null
}

/**
 * 判断工作区相对路径是否应被忽略，避免构建产物、依赖目录与编辑器临时文件触发无效刷新风暴。
 */
export function shouldIgnoreWorkingTreePath(filename: string | null): boolean {
  if (!filename) return false
  const normalized = filename.replaceAll('\\', '/').replace(/^\.\//u, '')
  if (normalized === '') return false
  const segments = normalized.split('/').filter(Boolean)
  if (segments.some(segment => IGNORED_DIRECTORY_SEGMENTS.has(segment))) return true
  const base = segments.at(-1) ?? ''
  if (base === '.DS_Store' || base === 'Thumbs.db') return true
  if (base.endsWith('.swp') || base.endsWith('.swo') || base.endsWith('~')) return true
  // 忽略 MyDSH 自身原子写文件产生的临时文件，但保留 package-lock.json/pnpm-lock.yaml 等真实锁文件。
  return /\.mydsh-[0-9a-f-]+\.tmp$/iu.test(base)
}

async function resolveGitDirectories(
  cwd: string,
  signal: AbortSignal,
): Promise<GitDirectories | null> {
  try {
    const result = await execFileAsync(
      process.env.MYDSH_GIT_EXECUTABLE ?? 'git',
      ['rev-parse', '--git-dir', '--git-common-dir'],
      {
        cwd,
        encoding: 'utf8',
        timeout: 5_000,
        signal,
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      },
    )
    const lines = result.stdout
      .split(/\r?\n/u)
      .map(line => line.trim())
      .filter(Boolean)
    const rawGitDir = lines[0]
    if (!rawGitDir) return null
    const rawCommonDir = lines[1] ?? rawGitDir
    const gitDir = await realpath(resolve(cwd, rawGitDir)).catch(() => resolve(cwd, rawGitDir))
    const commonDir = await realpath(resolve(cwd, rawCommonDir)).catch(() =>
      resolve(cwd, rawCommonDir),
    )
    return { gitDir, commonDir }
  } catch {
    return null
  }
}

async function pathExists(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    () => false,
  )
}

function safeWatch(
  target: string,
  options: { recursive?: boolean },
  onEvent: (filename: string | null) => void,
): FSWatcher | null {
  try {
    const watcher = watch(target, options, (_eventType, rawName) => {
      onEvent(rawName === null || rawName === undefined ? null : String(rawName))
    })
    watcher.on('error', () => {
      watcher.close()
    })
    return watcher
  } catch {
    return null
  }
}

/**
 * 管理已授权项目的 Git 与工作区监听生命周期，并在事件合并后向订阅方广播变更通知。
 */
export class GitWatcherService {
  private readonly entries = new Map<string, ProjectWatchState>()
  private readonly listeners = new Set<(event: DesktopProjectEvent) => void>()
  private readonly debounceMs: number
  private readonly lockBackoffMs: number
  private readonly maxProjects: number
  private disposed = false

  constructor(options: GitWatcherOptions = {}) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.lockBackoffMs = options.lockBackoffMs ?? DEFAULT_LOCK_BACKOFF_MS
    this.maxProjects = options.maxProjects ?? MAX_WATCHED_PROJECTS
  }

  /** 注册项目变更事件监听器，返回对应的退订函数。 */
  onEvent(listener: (event: DesktopProjectEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 按最新的项目基线增删监听器，最多保持 maxProjects 个最近活跃项目的系统监听句柄。 */
  syncProjects(projects: readonly WatchedProjectDescriptor[]): void {
    if (this.disposed) return
    const target = projects.slice(0, this.maxProjects)
    const nextIds = new Set(target.map(project => project.id))
    for (const [id, entry] of this.entries) {
      if (!nextIds.has(id)) {
        this.disposeEntry(entry)
        this.entries.delete(id)
      }
    }
    for (const project of target) {
      const existing = this.entries.get(project.id)
      if (existing !== undefined && samePath(existing.cwd, project.cwd)) continue
      if (existing !== undefined) this.disposeEntry(existing)
      const entry = this.createEntry(project.id, project.cwd)
      this.entries.set(project.id, entry)
      void this.attachWatchers(entry)
    }
  }

  /** 内置编辑器保存成功后立即调度工作区 Git 刷新，作为文件监听不可用时的兜底。 */
  notifyWorkingChange(projectId: string): void {
    const entry = this.entries.get(projectId)
    if (entry !== undefined) this.schedule(entry, 'working', 'editor-save')
  }

  /** Agent 轮次结束后按工作目录匹配项目并调度含 refs 的刷新，及时反映 Agent 执行的提交或改文件。 */
  notifyAgentTurn(cwd: string): void {
    if (this.disposed) return
    const scheduleByPath = (target: string): boolean => {
      for (const entry of this.entries.values()) {
        if (samePath(entry.cwd, target)) {
          this.schedule(entry, 'refs', 'agent-turn')
          return true
        }
      }
      return false
    }
    if (scheduleByPath(resolve(cwd))) return
    // macOS 上会话 cwd 可能是 /var 符号链接，而项目注册表保存 realpath 规范路径。
    void realpath(cwd)
      .then(canonical => {
        if (!this.disposed) scheduleByPath(canonical)
      })
      .catch(() => undefined)
  }

  /** 清除全部项目的系统监听句柄和定时器，保留已注册的事件订阅以便后续重新同步基线。 */
  reset(): void {
    for (const entry of this.entries.values()) this.disposeEntry(entry)
    this.entries.clear()
  }

  /** 释放全部系统监听句柄和定时器；调用后不再发出任何事件。 */
  dispose(): void {
    this.disposed = true
    this.reset()
    this.listeners.clear()
  }

  private createEntry(projectId: string, cwd: string): ProjectWatchState {
    return {
      projectId,
      cwd,
      abortController: new AbortController(),
      gitDir: null,
      commonDir: null,
      watchers: [],
      pendingScope: null,
      pendingReason: 'watcher',
      debounceTimer: null,
      lockRetries: 0,
      disposed: false,
    }
  }

  private disposeEntry(entry: ProjectWatchState): void {
    entry.disposed = true
    // 立即中止在途 git rev-parse 探测子进程，避免 Windows 退出清理目录时撞上 EBUSY。
    entry.abortController.abort()
    if (entry.debounceTimer !== null) {
      clearTimeout(entry.debounceTimer)
      entry.debounceTimer = null
    }
    for (const watcher of entry.watchers) watcher.close()
    entry.watchers = []
  }

  private async attachWatchers(entry: ProjectWatchState): Promise<void> {
    const directories = await resolveGitDirectories(entry.cwd, entry.abortController.signal)
    if (entry.disposed || this.disposed) return
    if (directories === null) {
      this.attachUninitializedWatcher(entry)
      return
    }
    entry.gitDir = directories.gitDir
    entry.commonDir = directories.commonDir
    this.attachGitMetadataWatchers(entry, directories)
    this.attachWorkingTreeWatcher(entry)
  }

  private attachUninitializedWatcher(entry: ProjectWatchState): void {
    const rootWatcher = safeWatch(entry.cwd, {}, filename => {
      if (entry.disposed || filename !== '.git') return
      this.closeWatchersOnly(entry)
      void this.attachWatchers(entry).then(() => {
        if (!entry.disposed && entry.gitDir !== null) this.schedule(entry, 'refs', 'watcher')
      })
    })
    if (rootWatcher !== null) entry.watchers.push(rootWatcher)
  }

  private attachGitMetadataWatchers(entry: ProjectWatchState, dirs: GitDirectories): void {
    const gitWatcher = safeWatch(dirs.gitDir, {}, filename => {
      const scope = classifyGitMetadataPath(filename)
      if (scope !== null) this.schedule(entry, scope, 'watcher')
    })
    if (gitWatcher !== null) entry.watchers.push(gitWatcher)

    if (!samePath(dirs.commonDir, dirs.gitDir)) {
      const commonWatcher = safeWatch(dirs.commonDir, {}, filename => {
        if (filename === null || filename === 'packed-refs' || filename === 'refs') {
          this.schedule(entry, 'refs', 'watcher')
        }
      })
      if (commonWatcher !== null) entry.watchers.push(commonWatcher)
    }

    const refsDir = join(dirs.commonDir, 'refs')
    // macOS 与 Windows 原生支持递归目录监听，Linux 或降级环境回退到常见 refs 子目录。
    const recursive = process.platform === 'darwin' || process.platform === 'win32'
    const refsWatcher = safeWatch(refsDir, { recursive }, filename => {
      if (filename !== null && filename.endsWith('.lock')) return
      this.schedule(entry, 'refs', 'watcher')
    })
    if (refsWatcher !== null) {
      entry.watchers.push(refsWatcher)
      return
    }
    for (const sub of ['heads', 'remotes', 'tags']) {
      const subWatcher = safeWatch(join(refsDir, sub), {}, filename => {
        if (filename !== null && filename.endsWith('.lock')) return
        this.schedule(entry, 'refs', 'watcher')
      })
      if (subWatcher !== null) entry.watchers.push(subWatcher)
    }
  }

  private attachWorkingTreeWatcher(entry: ProjectWatchState): void {
    const recursive = process.platform === 'darwin' || process.platform === 'win32'
    const workWatcher = safeWatch(entry.cwd, { recursive }, filename => {
      if (shouldIgnoreWorkingTreePath(filename)) return
      this.schedule(entry, 'working', 'watcher')
    })
    if (workWatcher !== null) entry.watchers.push(workWatcher)
  }

  private closeWatchersOnly(entry: ProjectWatchState): void {
    for (const watcher of entry.watchers) watcher.close()
    entry.watchers = []
  }

  private schedule(
    entry: ProjectWatchState,
    scope: DesktopProjectGitChangeScope,
    reason: DesktopProjectGitChangeReason,
  ): void {
    if (entry.disposed || this.disposed) return
    entry.pendingScope = mergeGitChangeScope(entry.pendingScope, scope)
    if (reason !== 'watcher' || entry.pendingReason === 'watcher') entry.pendingReason = reason
    entry.lockRetries = 0
    if (entry.debounceTimer !== null) clearTimeout(entry.debounceTimer)
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null
      void this.flush(entry)
    }, this.debounceMs)
    entry.debounceTimer.unref()
  }

  private async flush(entry: ProjectWatchState): Promise<void> {
    if (entry.disposed || this.disposed || entry.pendingScope === null) return
    // 检测到外部 Git 进程正在持有 index.lock 时短暂退避，避免与外部提交或变基并发碰撞。
    if (entry.gitDir !== null && entry.lockRetries < MAX_LOCK_RETRIES) {
      const locked = await pathExists(join(entry.gitDir, 'index.lock'))
      if (entry.disposed || this.disposed) return
      if (locked) {
        entry.lockRetries += 1
        entry.debounceTimer = setTimeout(() => {
          entry.debounceTimer = null
          void this.flush(entry)
        }, this.lockBackoffMs)
        entry.debounceTimer.unref()
        return
      }
    }
    const scope = entry.pendingScope
    const reason = entry.pendingReason
    entry.pendingScope = null
    entry.pendingReason = 'watcher'
    entry.lockRetries = 0
    if (scope === null) return
    const event: DesktopProjectEvent = {
      type: 'git-changed',
      projectId: entry.projectId,
      scope,
      reason,
      timestamp: Date.now(),
    }
    for (const listener of this.listeners) listener(event)
  }
}
