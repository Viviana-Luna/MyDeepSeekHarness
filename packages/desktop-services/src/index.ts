import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { SessionId } from '@deepseek-ai/dsh-session'
import '@deepseek-ai/dsh-api-session-controller'
import '@deepseek-ai/dsh-workspace'
import type {
  ProjectCallPayload,
  ProjectCallResult,
  WorkspaceSessionBaseline,
} from '../../../src/runtime/workspace/contracts.ts'
import type { ProjectAccessRegistry } from '../../../src/runtime/workspace/project-service.ts'
import {
  MydshWorkspace,
  type DesktopProject,
  type ProjectOperation,
} from '../../../src/runtime/workspace/index.ts'
import { managedTerminalFactory } from '../../../src/runtime/terminal/managed-terminal.ts'
import { GitAiService } from './git-ai-service.ts'
import { createGitAiRunner } from '../../../src/runtime/workspace/git-ai-process.ts'
import { isGitAiOperation } from '../../../src/shared/git-ai-validation.ts'
import '@deepseek-ai/dsh-subprocess'
import {
  createTerminalService,
  type TerminalService,
} from '../../../src/runtime/terminal/terminal-service.ts'
import type { DesktopFileReferenceCandidate } from '../../../src/shared/file-references.ts'
import type { DesktopProjectEvent } from '../../../src/shared/project-events.ts'
import type {
  DesktopTerminalCreateRequest,
  DesktopTerminalDescriptor,
  DesktopTerminalEvent,
} from '../../../src/shared/terminal.ts'
import type { ProjectTaskLaunch } from '../../../src/shared/project-tasks.ts'

export type {
  ProjectCallPayload,
  ProjectCallResult,
  WorkspaceSessionBaseline,
  DesktopProject,
  ProjectOperation,
  DesktopFileReferenceCandidate,
  DesktopProjectEvent,
  DesktopTerminalCreateRequest,
  DesktopTerminalDescriptor,
  DesktopTerminalEvent,
  ProjectTaskLaunch,
}

export interface Config {
  ripgrepPath: string
}

/** 归档会话的破坏性操作仅经主进程白名单进入，不直接访问运行时内部索引。 */
export class MydshSessionsRemote extends TypertRemoteService {
  static inject = ['typert', 'sessionController', 'workspaceRegistry']
  constructor(ctx: Context) {
    super(ctx, 'mydshSessions')
  }
  @Remote
  async archiveSession(sessionId: string): Promise<{ archivedSessionIds: string[] }> {
    if (!sessionId || sessionId.length > 512) throw new Error('会话标识无效')
    await this.ctx.sessionController.archiveSession(SessionId(sessionId))
    return { archivedSessionIds: [...this.ctx.workspaceRegistry.archivedSessionIds] }
  }
  @Remote
  async deleteArchivedSession(sessionId: string): Promise<{ archivedSessionIds: string[] }> {
    if (!sessionId || sessionId.length > 512) throw new Error('会话标识无效')
    await this.ctx.sessionController.deleteArchivedSession(SessionId(sessionId))
    return { archivedSessionIds: [...this.ctx.workspaceRegistry.archivedSessionIds] }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mydshWorkspace: MydshWorkspaceRemote
    mydshTerminal: MydshTerminalRemote
    mydshSessions: MydshSessionsRemote
  }
}

interface ProjectEventSubscription {
  pending: Map<string, DesktopProjectEvent>
  closed: boolean
  wake: () => void
}

/**
 * 既有桌面文件与 Git 行为由同一个 Runtime 服务实现。
 * sync/clear 只供可信主进程协调，公开 renderer Remote 桥不得放行这两个管理方法。
 */
export class MydshWorkspaceRemote extends TypertRemoteService {
  static inject = ['typert', 'subprocess']
  private readonly workspace: MydshWorkspace
  private readonly gitAi: GitAiService
  private readonly eventSubscriptions = new Set<ProjectEventSubscription>()
  private stopped = false
  get registry(): ProjectAccessRegistry {
    return this.workspace.registry
  }
  constructor(ctx: Context, config: Config) {
    super(ctx, 'mydshWorkspace')
    this.workspace = new MydshWorkspace(config.ripgrepPath)
    const unsubscribeEvents = this.workspace.onEvent(event => this.publishProjectEvent(event))
    this.gitAi = new GitAiService({
      registry: this.registry,
      run: createGitAiRunner(ctx.subprocess),
      llm: () => {
        const llm = ctx.get('llm')
        if (!llm) throw new Error('模型服务不可用')
        return llm
      },
    })
    ctx.on('agent/pre-step', async ({ agent, turn }, next) => {
      const cwd = agent.session.header.cwd
      if (cwd) await this.workspace.reviews.begin(cwd, agent.session.id, turn)
      return next()
    })
    ctx.on('agent/turn-settled', async ({ agent, turn }) => {
      const cwd = agent.session.header.cwd
      if (cwd) {
        await this.workspace.reviews.end(cwd, agent.session.id, turn)
        this.workspace.notifyAgentTurn(cwd)
      }
    })
    ctx.effect(() => async () => {
      this.stopped = true
      unsubscribeEvents()
      for (const subscription of this.eventSubscriptions) {
        subscription.closed = true
        subscription.pending.clear()
        subscription.wake()
      }
      this.eventSubscriptions.clear()
      await this.gitAi.dispose()
      this.workspace.dispose()
    })
  }
  private publishProjectEvent(event: DesktopProjectEvent): void {
    for (const subscription of this.eventSubscriptions) {
      const existing = subscription.pending.get(event.projectId)
      const scope = existing?.scope === 'refs' || event.scope === 'refs' ? 'refs' : event.scope
      subscription.pending.set(event.projectId, { ...event, scope })
      subscription.wake()
    }
  }
  @Remote
  sync(
    sessions: WorkspaceSessionBaseline,
    roots: readonly string[],
  ): Promise<readonly DesktopProject[]> {
    return this.workspace.sync(sessions, roots)
  }
  @Remote
  call(
    projectId: string,
    operation: ProjectOperation,
    payload: ProjectCallPayload,
    signal: AbortSignal,
  ): Promise<ProjectCallResult> {
    if (isGitAiOperation(operation)) return this.gitAi.call(projectId, operation, payload, signal)
    return this.workspace.call(projectId, operation, payload)
  }
  @Remote
  resolveDroppedFiles(
    projectId: string,
    paths: readonly string[],
  ): Promise<readonly DesktopFileReferenceCandidate[]> {
    return this.workspace.resolveDroppedFiles(projectId, paths)
  }
  @Remote
  async clear(): Promise<boolean> {
    await this.gitAi.dispose()
    this.workspace.clear()
    return true
  }

  /** 订阅项目 Git 变更流；按 projectId 合并高频事件，避免构建风暴导致队列积压或断流。 */
  @Remote({ mode: 'stream' })
  async *events(signal: AbortSignal): AsyncIterable<DesktopProjectEvent> {
    signal.throwIfAborted()
    if (this.stopped || this.eventSubscriptions.size >= 8)
      throw new Error('项目事件服务已停止或订阅数超过上限')
    const subscription: ProjectEventSubscription = {
      pending: new Map(),
      closed: false,
      wake: () => {},
    }
    const abort = () => {
      subscription.closed = true
      subscription.wake()
    }
    this.eventSubscriptions.add(subscription)
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (!signal.aborted && !subscription.closed) {
        const next = subscription.pending.entries().next()
        if (!next.done) {
          const [projectId, event] = next.value
          subscription.pending.delete(projectId)
          yield event
        } else {
          // 同一订阅逐项消费，队列为空时等待下次项目变更或取消信号。
          // oxlint-disable-next-line no-await-in-loop
          await new Promise<void>(resolve => {
            subscription.wake = resolve
          })
        }
      }
    } finally {
      signal.removeEventListener('abort', abort)
      this.eventSubscriptions.delete(subscription)
      subscription.pending.clear()
    }
  }
}

interface EventSubscription {
  queue: DesktopTerminalEvent[]
  characters: number
  failure?: Error
  closed: boolean
  wake: () => void
}

/** PTY 输出按订阅分别排队；超过积压上限明确终止流，避免无声截断终端内容。 */
export class MydshTerminalRemote extends TypertRemoteService {
  static inject = ['typert', 'mydshWorkspace', 'subprocess']
  private readonly service: TerminalService
  private readonly subscriptions = new Set<EventSubscription>()
  private stopped = false
  constructor(ctx: Context) {
    super(ctx, 'mydshTerminal')
    this.service = createTerminalService({
      processFactory: managedTerminalFactory(ctx.subprocess),
      resolveProjectDirectory: projectId =>
        ctx.mydshWorkspace.registry.resolveProjectDirectory(projectId),
      onEvent: event => this.publish(event),
    })
    ctx.effect(() => async () => {
      this.stopped = true
      for (const subscription of this.subscriptions) {
        subscription.closed = true
        subscription.wake()
      }
      this.subscriptions.clear()
      await this.service.dispose()
    })
  }
  private requireOwner(ownerId: number): void {
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0) throw new Error('终端窗口标识无效')
    if (this.stopped) throw new Error('终端服务已经停止')
  }
  private publish(event: DesktopTerminalEvent): void {
    for (const subscription of this.subscriptions) {
      const characters = event.type === 'data' ? event.data.length : 0
      if (
        subscription.queue.length >= 1024 ||
        subscription.characters + characters > 2 * 1024 * 1024
      ) {
        subscription.failure = new Error('终端输出积压超过上限，请重新连接终端视图')
        subscription.queue.length = 0
        subscription.closed = true
        this.subscriptions.delete(subscription)
      } else {
        subscription.queue.push(event)
        subscription.characters += characters
      }
      subscription.wake()
    }
  }
  @Remote
  create(
    ownerId: number,
    request: DesktopTerminalCreateRequest,
    task: ProjectTaskLaunch | null,
  ): Promise<DesktopTerminalDescriptor> {
    this.requireOwner(ownerId)
    return this.service.create(ownerId, request, task ?? undefined)
  }
  @Remote
  ready(ownerId: number, id: string): boolean {
    this.requireOwner(ownerId)
    this.service.ready(ownerId, id)
    return true
  }
  @Remote
  async write(ownerId: number, id: string, input: string): Promise<boolean> {
    this.requireOwner(ownerId)
    await this.service.write(ownerId, id, input)
    return true
  }
  @Remote
  async resize(ownerId: number, id: string, columns: number, rows: number): Promise<boolean> {
    this.requireOwner(ownerId)
    await this.service.resize(ownerId, id, columns, rows)
    return true
  }
  @Remote
  async close(ownerId: number, id: string): Promise<boolean> {
    this.requireOwner(ownerId)
    await this.service.close(ownerId, id)
    return true
  }

  /** 取消只释放本次订阅；PTY 的创建与关闭仍由明确操作控制。 */
  @Remote({ mode: 'stream' })
  async *events(signal: AbortSignal): AsyncIterable<DesktopTerminalEvent> {
    signal.throwIfAborted()
    if (this.stopped || this.subscriptions.size >= 8)
      throw new Error('终端事件服务已停止或订阅数超过上限')
    const subscription: EventSubscription = {
      queue: [],
      characters: 0,
      closed: false,
      wake: () => {},
    }
    const abort = () => {
      subscription.closed = true
      subscription.wake()
    }
    this.subscriptions.add(subscription)
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (!signal.aborted && !subscription.closed) {
        const event = subscription.queue.shift()
        if (event !== undefined) {
          if (event.type === 'data') subscription.characters -= event.data.length
          yield event
        } else {
          // 同一订阅逐项消费，空队列需要等待下一次输出或取消。
          // oxlint-disable-next-line no-await-in-loop
          await new Promise<void>(resolve => {
            subscription.wake = resolve
          })
        }
      }
      if (subscription.failure) throw subscription.failure
    } finally {
      signal.removeEventListener('abort', abort)
      this.subscriptions.delete(subscription)
      subscription.queue.length = 0
    }
  }
}

export const name = 'mydsh-desktop-services'
export const inject = ['typert']
/** 外层注册生成的 TYPERT 后装配；子服务与插件的 Cordis 生命周期一致。 */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(MydshWorkspaceRemote, config)
  ctx.plugin(MydshTerminalRemote)
  ctx.plugin(MydshSessionsRemote)
}
