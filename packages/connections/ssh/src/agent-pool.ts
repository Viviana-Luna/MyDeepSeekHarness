/**
 * SSH Agent 独立连接池：运行在后台 Runtime，按连接复用 ssh2 Client 与 SFTP 通道。
 * 与人工交互终端隔离；持有空闲定时器与底层 socket，配置变更、空闲超时或应用退出时统一释放。
 */
import type { Client, SFTPWrapper } from 'ssh2'
import { closeClient } from './transport.ts'

/** 池化连接身份标识，用于校验配置版本或主机指纹是否已变更。 */
export interface PooledSshIdentity {
  readonly id: string
  readonly revision: number
  readonly fingerprint: string
}

/** 建立单条 SSH 客户端的回调结果。 */
export interface AuthenticatedSshClient {
  readonly client: Client
  safeMessage(message: string): string
}

interface PoolEntry {
  readonly identity: PooledSshIdentity
  readonly client: Client
  readonly safeMessage: (message: string) => string
  sftpPromise?: Promise<SFTPWrapper>
  activeOps: number
  idleTimer?: ReturnType<typeof setTimeout>
  closed: boolean
}

const DEFAULT_IDLE_TIMEOUT_MS = 120_000
const MAX_POOLED_CONNECTIONS = 8

/** 管理仅供 Agent 工具复用的 SSH 连接池，不向人工交互终端或外部暴露。 */
export class SshAgentPool {
  private readonly entries = new Map<string, PoolEntry>()
  private readonly idleTimeoutMs: number

  constructor(idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS) {
    this.idleTimeoutMs = idleTimeoutMs
  }

  /**
   * 借用指定连接的复用客户端执行操作；必要时建立新连接并缓存 SFTP 会话。
   * 发生连接错误或版本变更时自动淘汰旧连接。
   */
  async withSession<T>(
    input: {
      identity: PooledSshIdentity
      signal: AbortSignal
      connect: (signal: AbortSignal) => Promise<AuthenticatedSshClient>
      needsSftp?: boolean
    },
    work: (session: {
      client: Client
      sftp?: SFTPWrapper
      safeMessage: (message: string) => string
    }) => Promise<T>,
  ): Promise<T> {
    input.signal.throwIfAborted()
    const entry = await this.acquireEntry(input.identity, input.signal, input.connect)
    entry.activeOps += 1
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer)
      delete entry.idleTimer
    }
    try {
      const sftp = input.needsSftp ? await this.openSftp(entry, input.signal) : undefined
      return await work({
        client: entry.client,
        ...(sftp ? { sftp } : {}),
        safeMessage: entry.safeMessage,
      })
    } finally {
      entry.activeOps = Math.max(0, entry.activeOps - 1)
      if (!entry.closed && entry.activeOps === 0 && this.entries.get(entry.identity.id) === entry) {
        this.scheduleIdleClose(entry)
      }
    }
  }

  /** 关闭指定连接的池化客户端，立即清理其空闲定时器。 */
  async closeConnection(connectionId: string): Promise<void> {
    const entry = this.entries.get(connectionId)
    if (!entry) return
    await this.disposeEntry(entry)
  }

  /** 关闭全部池化 SSH 客户端，供 Runtime 退出或重置时统一调用。 */
  async closeAll(): Promise<void> {
    const current = [...this.entries.values()]
    await Promise.all(current.map(entry => this.disposeEntry(entry)))
  }

  private async acquireEntry(
    identity: PooledSshIdentity,
    signal: AbortSignal,
    connect: (signal: AbortSignal) => Promise<AuthenticatedSshClient>,
  ): Promise<PoolEntry> {
    const existing = this.entries.get(identity.id)
    if (existing && !existing.closed) {
      if (
        existing.identity.revision === identity.revision &&
        existing.identity.fingerprint === identity.fingerprint
      ) {
        return existing
      }
      await this.disposeEntry(existing)
    }
    if (this.entries.size >= MAX_POOLED_CONNECTIONS) {
      await this.evictOneIdle()
    }
    if (this.entries.size >= MAX_POOLED_CONNECTIONS) {
      throw new Error('Agent SSH 连接池已达 8 台主机上限，请稍后重试')
    }
    const authenticated = await connect(signal)
    if (signal.aborted) {
      await closeClient(authenticated.client).catch(() => {})
      signal.throwIfAborted()
    }
    const entry: PoolEntry = {
      identity,
      client: authenticated.client,
      safeMessage: authenticated.safeMessage,
      activeOps: 0,
      closed: false,
    }
    const markClosed = () => {
      entry.closed = true
      delete entry.sftpPromise
      if (entry.idleTimer) {
        clearTimeout(entry.idleTimer)
        delete entry.idleTimer
      }
      if (this.entries.get(identity.id) === entry) this.entries.delete(identity.id)
    }
    entry.client.once('close', markClosed)
    entry.client.once('end', markClosed)
    entry.client.on('error', markClosed)
    this.entries.set(identity.id, entry)
    return entry
  }

  private async openSftp(entry: PoolEntry, signal: AbortSignal): Promise<SFTPWrapper> {
    signal.throwIfAborted()
    if (entry.closed) throw new Error('SSH 连接已断开，请重试')
    if (!entry.sftpPromise) {
      const created = new Promise<SFTPWrapper>((resolve, reject) => {
        entry.client.sftp((error, sftp) => {
          if (error) {
            if (entry.sftpPromise === created) delete entry.sftpPromise
            reject(new Error(entry.safeMessage(error.message)))
            return
          }
          const dropSftp = () => {
            if (entry.sftpPromise === created) delete entry.sftpPromise
          }
          sftp.once('close', dropSftp)
          sftp.once('end', dropSftp)
          sftp.on('error', dropSftp)
          resolve(sftp)
        })
      })
      entry.sftpPromise = created
    }
    return entry.sftpPromise
  }

  private scheduleIdleClose(entry: PoolEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.idleTimer = setTimeout(() => {
      if (entry.activeOps === 0) void this.disposeEntry(entry)
    }, this.idleTimeoutMs)
    entry.idleTimer.unref?.()
  }

  private async evictOneIdle(): Promise<void> {
    for (const entry of this.entries.values()) {
      if (entry.activeOps === 0) {
        await this.disposeEntry(entry)
        return
      }
    }
  }

  private async disposeEntry(entry: PoolEntry): Promise<void> {
    entry.closed = true
    delete entry.sftpPromise
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer)
      delete entry.idleTimer
    }
    if (this.entries.get(entry.identity.id) === entry) {
      this.entries.delete(entry.identity.id)
    }
    await closeClient(entry.client).catch(() => {})
  }
}
