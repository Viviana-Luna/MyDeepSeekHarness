/** 后台临时连接授权服务；拥有会话写入同意与撤销信号，不持久化授权，也不建立网络连接。 */
import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { ConnectionConsentView, ConnectionIdentity } from '../types.d.ts'

interface ConsentRecord {
  view: ConnectionConsentView
  agent: Agent
  controller: AbortController
}

interface TransientEntry {
  sessionId: string
  connection: ConnectionIdentity
  dependencies: ConnectionIdentity[]
  agent: Agent
  controller: AbortController
}

function freezeIdentity(identity: ConnectionIdentity): ConnectionIdentity {
  return Object.freeze({ ...identity })
}

function freezeConsent(view: ConnectionConsentView): ConnectionConsentView {
  view.connection = freezeIdentity(view.connection)
  for (let index = 0; index < view.dependencies.length; index++) {
    view.dependencies[index] = freezeIdentity(view.dependencies[index]!)
  }
  Object.freeze(view.dependencies)
  return Object.freeze(view)
}

function sameIdentity(left: ConnectionIdentity, right: ConnectionIdentity): boolean {
  return (
    left.kind === right.kind &&
    left.id === right.id &&
    left.revision === right.revision &&
    left.fingerprint === right.fingerprint
  )
}

function sameDependencies(
  left: readonly ConnectionIdentity[],
  right: readonly ConnectionIdentity[],
): boolean {
  return (
    left.length === right.length && left.every((item, index) => sameIdentity(item, right[index]!))
  )
}

function dependenciesMatchConnection(
  items: readonly ConnectionIdentity[],
  target: Pick<ConnectionIdentity, 'kind' | 'id'>,
): boolean {
  return items.some(item => item.kind === target.kind && item.id === target.id)
}

/** 由服务签发的进程内执行租约；普通对象或历史标识不能替代它。 */
export interface ConnectionLease {
  readonly view: ConnectionConsentView
  readonly agent: Agent
  readonly signal: AbortSignal
  readonly persistent: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mydshConnectionAccess: ConnectionAccess
  }
  interface Events {
    'api-session/removed'(sessionId: SessionId): void
  }
}

/** 会话同意与在途执行租约的内存所有者；连接或依赖变更时立即失效并取消执行。 */
export class ConnectionAccess extends Service {
  static inject = ['agents', 'sessions', 'workspaceRegistry']
  private readonly consents = new Map<string, ConsentRecord>()
  private readonly transient = new Set<TransientEntry>()
  private readonly leases = new WeakMap<ConnectionLease, ConsentRecord | TransientEntry>()
  private readonly queues = new Map<string, Promise<void>>()
  private readonly lifetime = new AbortController()
  private readonly workspaceRegistry: WorkspaceRegistry

  /** 监听真实生命周期；归档、释放或退出时立即清除会话写入同意与在途租约。 */
  constructor(ctx: Context) {
    super(ctx, 'mydshConnectionAccess')
    this.workspaceRegistry = ctx.workspaceRegistry
    ctx.on('agent/disposed', ({ agent }) => this.revokeSession(agent.id))
    ctx.on('session/disposed', session => this.revokeSession(session.id))
    ctx.on('api-session/removed', sessionId => this.revokeSession(sessionId))
    ctx.effect(() => () => {
      this.lifetime.abort(new Error('连接授权服务已关闭'))
      this.revokeAll()
    })
  }

  private assertSession(sessionId: string, agent: Agent | undefined): Agent {
    this.lifetime.signal.throwIfAborted()
    if (this.workspaceRegistry.archivedSessionIds.includes(SessionId(sessionId)))
      throw new Error('GRANT_EXPIRED：会话已归档，请恢复会话后再试')
    if (agent === undefined) throw new Error('NOT_AUTHORIZED：连接工具需要当前会话身份')
    const parentId = agent.session.header.parentSession
    const parent = parentId === undefined ? undefined : this.ctx.agents.get(parentId)
    if (
      this.ctx.agents.get(agent.id) !== agent ||
      agent.id !== sessionId ||
      agent.session.header.origin === 'subagent' ||
      (parent !== undefined && this.ctx.agents.isOwnedBy(agent.id, parent))
    )
      throw new Error('NOT_AUTHORIZED：连接工具仅供当前主会话 Agent 使用')
    return agent
  }

  /** 将同会话同连接的变更确认串行排队，避免并行工具调用同时弹出多个确认卡片。 */
  async serializeForConnection<T>(
    sessionId: string,
    connectionId: string,
    work: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted()
    const key = `${sessionId}:${connectionId}`
    const previous = this.queues.get(key) ?? Promise.resolve()
    const waitForPrevious = (): Promise<void> => {
      if (!signal) return previous
      return new Promise<void>((resolve, reject) => {
        let settled = false
        const finish = (error?: unknown): void => {
          if (settled) return
          settled = true
          signal.removeEventListener('abort', onAbort)
          if (error === undefined) resolve()
          else reject(error)
        }
        const onAbort = () => finish(signal.reason ?? new Error('连接操作已取消'))
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) {
          onAbort()
          return
        }
        previous.then(
          () => finish(),
          error => finish(error),
        )
      })
    }
    const waitPrevious = signal ? waitForPrevious() : previous
    let release!: () => void
    const current = new Promise<void>(resolve => {
      release = resolve
    })
    const tail = previous.then(
      () => current,
      () => current,
    )
    this.queues.set(key, tail)
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key)
    })
    try {
      await waitPrevious
      signal?.throwIfAborted()
      return await work()
    } finally {
      release()
    }
  }

  /** 校验当前调用属于活跃的主会话 Agent，排除子 Agent、已归档或已释放会话。 */
  assertMainAgent(agent: Agent | undefined): Agent {
    return this.assertSession(agent?.id ?? '', agent)
  }

  /** 判断当前会话是否已对指定版本连接及依赖授予过会话级写入同意。 */
  hasSessionConsent(
    agent: Agent | undefined,
    connection: ConnectionIdentity,
    dependencies: readonly ConnectionIdentity[] = [],
  ): boolean {
    if (agent === undefined) return false
    this.assertSession(agent.id, agent)
    return this.findMatchingConsent(agent, connection, dependencies) !== undefined
  }

  /** 登记当前会话对某连接的写入同意；修改配置、禁用、SSH 变更或会话结束时自动失效。 */
  grantSessionConsent(
    agent: Agent | undefined,
    input: {
      name: string
      connection: ConnectionIdentity
      dependencies: readonly ConnectionIdentity[]
    },
  ): ConnectionConsentView {
    const liveAgent = this.assertSession(agent?.id ?? '', agent)
    this.revokeConnection(liveAgent.id, input.connection.id)
    if (this.consents.size >= 1024)
      throw new Error('会话连接同意记录已达到上限，请重新开启会话后再试')
    const view = freezeConsent(
      structuredClone({
        id: randomUUID(),
        sessionId: liveAgent.id,
        name: input.name,
        connection: input.connection,
        dependencies: [...input.dependencies],
      }),
    )
    const record: ConsentRecord = { view, agent: liveAgent, controller: new AbortController() }
    this.consents.set(view.id, record)
    return structuredClone(view)
  }

  /** 列出当前会话的写入同意摘要。 */
  listSessionConsents(sessionId: string): ConnectionConsentView[] {
    this.lifetime.signal.throwIfAborted()
    return [...this.consents.values()]
      .filter(record => record.view.sessionId === sessionId)
      .map(record => structuredClone(record.view))
  }

  /** 为单次或会话级操作签发受撤销信号保护的执行租约；用毕应调用 releaseLease 释放。 */
  acquireLease(
    agent: Agent | undefined,
    input: {
      name: string
      connection: ConnectionIdentity
      dependencies: readonly ConnectionIdentity[]
      requireSessionConsent: boolean
    },
  ): ConnectionLease {
    const liveAgent = this.assertSession(agent?.id ?? '', agent)
    if (input.requireSessionConsent) {
      const record = this.findMatchingConsent(liveAgent, input.connection, input.dependencies)
      if (record === undefined) throw new Error('NOT_AUTHORIZED：当前会话尚未同意写入该连接')
      const lease: ConnectionLease = Object.freeze({
        view: record.view,
        agent: liveAgent,
        signal: record.controller.signal,
        persistent: true,
      })
      this.leases.set(lease, record)
      return lease
    }
    const view = freezeConsent(
      structuredClone({
        id: randomUUID(),
        sessionId: liveAgent.id,
        name: input.name,
        connection: input.connection,
        dependencies: [...input.dependencies],
      }),
    )
    const entry: TransientEntry = {
      sessionId: liveAgent.id,
      connection: view.connection,
      dependencies: view.dependencies,
      agent: liveAgent,
      controller: new AbortController(),
    }
    this.transient.add(entry)
    const lease: ConnectionLease = Object.freeze({
      view,
      agent: liveAgent,
      signal: entry.controller.signal,
      persistent: false,
    })
    this.leases.set(lease, entry)
    return lease
  }

  /** 释放一次性执行租约，避免瞬时信号长驻内存。 */
  releaseLease(lease: ConnectionLease): void {
    const entry = this.leases.get(lease)
    if (entry === undefined || 'view' in entry) return
    this.transient.delete(entry)
    this.leases.delete(lease)
  }

  /** 异步等待前后复核租约；撤销、连接改版或实例替换后立即终止操作。 */
  assertLease(lease: ConnectionLease): void {
    const entry = this.leases.get(lease)
    if (entry === undefined) throw new Error('GRANT_EXPIRED：连接访问租约已失效')
    if ('view' in entry && this.consents.get(entry.view.id) !== entry)
      throw new Error('GRANT_EXPIRED：连接写入同意已失效，请重新确认')
    if (!('view' in entry) && !this.transient.has(entry))
      throw new Error('GRANT_EXPIRED：连接操作已终止')
    entry.controller.signal.throwIfAborted()
    this.assertSession(lease.view.sessionId, lease.agent)
    if (entry.agent !== lease.agent) throw new Error('GRANT_EXPIRED：连接操作所属实例已变化')
  }

  /** 撤销当前会话中指定连接的写入同意，不影响其他会话。 */
  revokeConnection(sessionId: string, connectionId: string): void {
    this.revokeMatching((sid, connection) => sid === sessionId && connection.id === connectionId)
  }

  /** 连接或依赖配置变化时清理所有引用它的同意与在途操作。 */
  invalidate(connection: Pick<ConnectionIdentity, 'kind' | 'id'>): void {
    this.revokeMatching((_sid, item, dependencies) =>
      dependenciesMatchConnection([item, ...dependencies], connection),
    )
  }

  /** 清理指定会话的所有写入同意与在途操作。 */
  revokeSession(sessionId: string): void {
    this.revokeMatching(sid => sid === sessionId)
  }

  /** Runtime 退出时撤销本代所有同意与在途操作。 */
  revokeAll(): void {
    this.revokeMatching(() => true)
  }

  private findMatchingConsent(
    agent: Agent,
    connection: ConnectionIdentity,
    dependencies: readonly ConnectionIdentity[],
  ): ConsentRecord | undefined {
    for (const record of this.consents.values()) {
      if (
        record.view.sessionId === agent.id &&
        record.agent === agent &&
        sameIdentity(record.view.connection, connection) &&
        sameDependencies(record.view.dependencies, dependencies) &&
        !record.controller.signal.aborted
      )
        return record
    }
    return undefined
  }

  private revokeMatching(
    matches: (
      sessionId: string,
      connection: ConnectionIdentity,
      dependencies: readonly ConnectionIdentity[],
    ) => boolean,
  ): void {
    for (const [id, record] of this.consents) {
      if (!matches(record.view.sessionId, record.view.connection, record.view.dependencies))
        continue
      this.consents.delete(id)
      record.controller.abort(new Error('GRANT_EXPIRED：连接授权已失效'))
    }
    for (const entry of this.transient) {
      if (!matches(entry.sessionId, entry.connection, entry.dependencies)) continue
      this.transient.delete(entry)
      entry.controller.abort(new Error('GRANT_EXPIRED：连接配置或会话状态已变化'))
    }
  }
}

/** 装配进程级连接访问所有者；具体工具由各连接插件按预设注册。 */
export function apply(ctx: Context): void {
  ctx.plugin(ConnectionAccess)
}
