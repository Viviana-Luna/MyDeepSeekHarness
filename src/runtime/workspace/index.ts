import {
  ProjectAccessRegistry,
  callProjectService,
  type DesktopProject,
  type ProjectOperation,
} from './project-service.ts'
import { WorkspaceIndexService } from './workspace-index-service.ts'
import type {
  ProjectCallPayload,
  ProjectCallResult,
  WorkspaceSessionBaseline,
} from './contracts.ts'
import type { DesktopFileReferenceCandidate } from '../../shared/file-references.ts'
import type { DesktopProjectEvent } from '../../shared/project-events.ts'
import { GitReviewService } from './git-review-service.ts'
import { GitWatcherService } from './git-watcher-service.ts'
import { join } from 'node:path'
import { homedir } from 'node:os'

export { type DesktopProject, type ProjectOperation } from './project-service.ts'
export type { DesktopProjectEvent } from '../../shared/project-events.ts'

/**
 * 项目事实、路径授权与索引只在 Runtime 中保留一份。
 * sync 的目录来源由桌面主进程复核；普通前端调用只能使用已登记的项目标识。
 */
export class MydshWorkspace {
  readonly registry: ProjectAccessRegistry = new ProjectAccessRegistry()
  readonly index: WorkspaceIndexService
  readonly watcher: GitWatcherService = new GitWatcherService()
  readonly reviews = new GitReviewService(
    join(process.env.MYDSH_HOME ?? join(homedir(), '.mydsh'), 'cache', 'git-review'),
  )
  private synchronization: Promise<unknown> = Promise.resolve()
  private generation = 0

  constructor(ripgrepPath: string) {
    this.index = new WorkspaceIndexService(ripgrepPath)
  }

  /** 订阅项目工作区事件（例如外部 Git 提交或文件变更）。 */
  onEvent(listener: (event: DesktopProjectEvent) => void): () => void {
    return this.watcher.onEvent(listener)
  }

  /** Agent 轮次结束后通知对应项目刷新 Git 状态与提交图。 */
  notifyAgentTurn(cwd: string): void {
    this.watcher.notifyAgentTurn(cwd)
  }

  /** 串行接收会话基线，清理后到达的旧异步目录扫描不能恢复已移除的访问范围。 */
  sync(
    sessions: WorkspaceSessionBaseline,
    roots: readonly string[] = [],
  ): Promise<readonly DesktopProject[]> {
    const generation = this.generation
    const synchronize = async () => {
      if (generation !== this.generation) throw new Error('项目基线已失效，请重新读取')
      // 候选注册表只有完整扫描结束后才替换，失败保留上一份可用基线。
      const candidate = new ProjectAccessRegistry()
      const projects = await candidate.replaceFromSessionList(sessions, roots)
      if (generation !== this.generation) throw new Error('项目基线已失效，请重新读取')
      this.registry.replace(candidate)
      this.index.retain(projects.map(project => project.id))
      this.watcher.syncProjects(projects.map(project => ({ id: project.id, cwd: project.cwd })))
      return projects
    }
    const pending = this.synchronization.then(synchronize, synchronize)
    this.synchronization = pending.then(
      () => undefined,
      () => undefined,
    )
    return pending
  }

  /** 业务层原有逐操作校验与文件 revision 冲突保护保持不变。 */
  async call(
    projectId: string,
    operation: ProjectOperation,
    payload: ProjectCallPayload,
  ): Promise<ProjectCallResult> {
    await this.synchronization
    if (JSON.stringify(payload).length > 64 * 1024) throw new Error('项目操作参数超过大小上限')
    if (operation === 'gitBranches')
      return this.reviews.branches(this.registry.resolveProjectDirectory(projectId))
    if (operation === 'gitReview')
      return this.reviews.review(this.registry.resolveProjectDirectory(projectId), payload)
    const result = await callProjectService(
      this.registry,
      operation,
      { ...payload, projectId },
      { workspaceIndex: this.index },
    )
    if (
      operation === 'writeFile' &&
      result !== null &&
      typeof result === 'object' &&
      'status' in result &&
      result.status === 'saved'
    ) {
      this.watcher.notifyWorkingChange(projectId)
    }
    return result
  }

  async resolveDroppedFiles(
    projectId: string,
    paths: readonly string[],
  ): Promise<readonly DesktopFileReferenceCandidate[]> {
    await this.synchronization
    return this.registry.resolveDroppedFiles(projectId, paths)
  }

  /** 清空当前基线的搜索、文件监听与项目目录授权；保留事件订阅以便重新同步后继续推送。 */
  clear(): void {
    this.generation += 1
    this.index.clear()
    this.watcher.reset()
    this.reviews.dispose()
    this.registry.clear()
    this.synchronization = Promise.resolve()
  }

  /** Cordis 停止时永久释放工作区拥有的文件监听与全部后台资源。 */
  dispose(): void {
    this.clear()
    this.watcher.dispose()
  }
}
