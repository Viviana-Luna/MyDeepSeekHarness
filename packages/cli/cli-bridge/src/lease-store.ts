/**
 * 二级 CLI 会话租约存储：为每次模型 Shell 调用签发高熵临时凭证，将本地 IPC 请求映射回发起会话的 Agent。
 * 运行在后台 Runtime；租约仅驻留内存，随所属 Agent 释放、过期或插件卸载自动清除。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'

/** 单条有效的 CLI 调用租约记录。 */
export interface CliExecutionLease<TAgent extends object = object> {
  readonly id: string
  readonly secret: string
  readonly agent: TAgent | undefined
  readonly createdAt: number
  readonly expiresAt: number
}

/** 默认单次 Shell 租约最长存活 30 分钟，兼顾后台长作业与人工审批等待。 */
const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000
const MAX_ACTIVE_LEASES = 512

function safeEqualHex(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  return timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

/** 管理运行期内存中的 Shell 二级调用租约。 */
export class CliLeaseStore<TAgent extends object = object> {
  private readonly leases = new Map<string, CliExecutionLease<TAgent>>()
  private readonly agentDisposers = new WeakSet<object>()
  private readonly ttlMs: number

  constructor(ttlMs = DEFAULT_LEASE_TTL_MS) {
    this.ttlMs = ttlMs
  }

  private pruneExpired(now = Date.now()): void {
    for (const [id, lease] of this.leases.entries()) {
      if (lease.expiresAt <= now) this.leases.delete(id)
    }
    while (this.leases.size >= MAX_ACTIVE_LEASES) {
      const oldestKey = this.leases.keys().next().value
      if (oldestKey === undefined) break
      this.leases.delete(oldestKey)
    }
  }

  private bindAgentDisposal(agent: TAgent): void {
    const target = agent as { ctx?: { effect?: (fn: () => () => void) => void } }
    if (!target || typeof target !== 'object' || this.agentDisposers.has(target)) return
    if (typeof target.ctx?.effect !== 'function') return
    this.agentDisposers.add(target)
    target.ctx.effect(() => () => {
      this.revokeForAgent(agent)
    })
  }

  /**
   * 为一次 Shell 工具调用签发格式为 `<id>.<secret>` 的一次性会话租约。
   * 仅传递随机引用，不包含任何 API 密钥、数据库密码或 SSH 私钥。
   */
  issue(agent: TAgent | undefined): string {
    const now = Date.now()
    this.pruneExpired(now)
    const id = randomBytes(8).toString('hex')
    const secret = randomBytes(24).toString('hex')
    this.leases.set(id, {
      id,
      secret,
      agent,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    })
    if (agent !== undefined) this.bindAgentDisposal(agent)
    return `${id}.${secret}`
  }

  /**
   * 常量时间核验客户端提交的租约字符串并返回绑定的会话上下文。
   * 无效、格式损坏或已过期的租约返回 `null`。
   */
  verify(rawToken: unknown): CliExecutionLease<TAgent> | null {
    if (typeof rawToken !== 'string' || rawToken.length < 20 || rawToken.length > 128) return null
    const dot = rawToken.indexOf('.')
    if (dot <= 0 || dot >= rawToken.length - 1) return null
    const id = rawToken.slice(0, dot)
    const candidateSecret = rawToken.slice(dot + 1)
    const now = Date.now()
    const record = this.leases.get(id)
    if (!record) return null
    if (record.expiresAt <= now) {
      this.leases.delete(id)
      return null
    }
    return safeEqualHex(record.secret, candidateSecret) ? record : null
  }

  /** 立即吊销指定 Agent 名下的全部租约。 */
  revokeForAgent(agent: TAgent): void {
    for (const [id, lease] of this.leases.entries()) {
      if (lease.agent === agent) this.leases.delete(id)
    }
  }

  /** 清空全部活动租约。 */
  clear(): void {
    this.leases.clear()
  }
}
