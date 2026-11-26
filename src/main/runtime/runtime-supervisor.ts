/* oxlint-disable unicorn/require-post-message-target-origin -- Electron UtilityProcess 消息不是浏览器 Window.postMessage。 */
import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { recoverDshImport } from '../../runtime/import/dsh-import.ts'
import {
  ensureRuntimeInstalled,
  resolveMydshHome,
  type InstalledRuntime,
} from './runtime-install.ts'
import { isRecord } from '../../shared/validation.ts'
import { GIT_AI_REPLY_TIMEOUT_MS } from '../../shared/git-ai.ts'

const MAX_MESSAGE_BYTES = 64 * 1024 * 1024
const MAX_PENDING_REQUESTS = 256
const CONNECTION_SYSTEM_METHODS = new Set([
  'ssh.seal',
  'ssh.open',
  'ssh.import-key',
  'database.seal',
  'database.open',
  'database.pick-sqlite',
])

function isConnectionOrAutomationMethod(method: string): boolean {
  return CONNECTION_SYSTEM_METHODS.has(method) || method.startsWith('automation.')
}

function callSignal(endpoint: string, payload: unknown, signal?: AbortSignal): AbortSignal {
  const isGitAiExecution =
    endpoint === 'mydshWorkspace/call' &&
    isRecord(payload) &&
    isRecord(payload.args) &&
    payload.args.operation === 'gitAiExecute'
  const deadline = AbortSignal.timeout(isGitAiExecution ? GIT_AI_REPLY_TIMEOUT_MS : 300_000)
  return signal ? AbortSignal.any([signal, deadline]) : deadline
}

function boundedJson(value: unknown, limit: number): void {
  const text = JSON.stringify(value)
  if (text === undefined || Buffer.byteLength(text) > limit)
    throw new Error('运行消息超过允许的大小或不是可序列化数据')
}
/** 状态只描述应用自己拥有的运行进程；没有端口发现或外部 CLI 回退。 */
export interface RuntimeDiagnostics {
  phase: string
  attempt: number
  maxAttempts: number
  pid?: number
  lastError?: string
  logs: readonly { stream: 'stdout' | 'stderr'; message: string }[]
}
export type RuntimeState =
  | { kind: 'connecting'; phase: string; message: string; diagnostics: RuntimeDiagnostics }
  | {
      kind: 'ready'
      ownership: 'spawned-by-desktop'
      url: string
      identity: { reportedVersion: string }
      diagnostics: RuntimeDiagnostics
      sessionCookie?: never
    }
  | {
      kind: 'unavailable'
      reason: 'start-failed' | 'stopped'
      message: string
      retryable: boolean
      diagnostics: RuntimeDiagnostics
    }
interface Pending {
  resolve(value: unknown): void
  reject(reason: unknown): void
  item?: (value: unknown) => Promise<void>
}
export interface RuntimeSupervisorOptions {
  bundleDirectory: string
  mydshHome?: string
  onSpawned?: (child: { pid?: number }) => void
  /** 目录选择属于桌面系统能力；取消或 Runtime 退出时必须关闭其原生对话框。 */
  pickDirectory?: (signal: AbortSignal) => Promise<string | null>
  connectionSystem?: (
    method: string,
    payload: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<unknown>
  automationSystem?: (
    method: string,
    payload: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<unknown>
}
interface RuntimeMessage {
  type: string
  id?: string
  version?: string
  method?: string
  payload?: Record<string, unknown>
  value?: unknown
  result?: { ok: boolean; value?: unknown; error?: { message: string } }
  error?: { message: string }
  message?: string
}

/** 主进程唯一运行时载体：拥有请求、事件流、取消以及子进程生命周期。 */
export class MydshRuntimeSupervisor {
  private child: UtilityProcess | undefined
  private installation: InstalledRuntime | undefined
  private state: RuntimeState = {
    kind: 'connecting',
    phase: 'idle',
    message: '正在准备运行核心',
    diagnostics: { phase: 'idle', attempt: 0, maxAttempts: 1, logs: [] },
  }
  private readonly listeners = new Set<(state: RuntimeState) => void>()
  private readonly pending = new Map<string, Pending>()
  private readonly pluginListeners = new Set<() => void>()
  private starting: Promise<void> | undefined
  private stopTask: Promise<void> | undefined
  private readonly exits = new WeakSet<UtilityProcess>()
  private readonly terminations = new WeakMap<UtilityProcess, Promise<void>>()
  private stopping = false
  private closing = false
  private installationAbort: AbortController | undefined
  private directoryPick:
    | {
        child: UtilityProcess
        id: string
        controller: AbortController
        task: Promise<string | null>
      }
    | undefined
  private readonly connectionCalls = new Map<string, AbortController>()
  private readonly connectionToken = randomUUID() + randomUUID()
  constructor(private readonly options: RuntimeSupervisorOptions) {}
  getState(): RuntimeState {
    return this.state
  }
  get installed(): InstalledRuntime | undefined {
    return this.installation
  }
  subscribe(listener: (state: RuntimeState) => void): () => void {
    this.listeners.add(listener)
    listener(this.state)
    return () => {
      this.listeners.delete(listener)
    }
  }
  onPluginsChanged(listener: () => void): () => void {
    this.pluginListeners.add(listener)
    return () => {
      this.pluginListeners.delete(listener)
    }
  }
  private publish(state: RuntimeState): void {
    this.state = state
    for (const listener of this.listeners) listener(state)
  }
  async ensureReady(): Promise<void> {
    if (this.closing) throw new Error('MyDSH 正在退出')
    if (this.stopTask) await this.stopTask
    if (this.closing) throw new Error('MyDSH 正在退出')
    return (this.starting ??= this.start().finally(() => {
      this.starting = undefined
    }))
  }
  async retry(): Promise<RuntimeState> {
    await this.stop()
    if (!this.closing) await this.ensureReady()
    return this.state
  }
  recover(): Promise<RuntimeState> {
    return this.retry()
  }
  /** 永久退出与可重启的 stop 分开，异步导入 finally 不能把退出中的应用重新启动。 */
  async shutdown(): Promise<void> {
    this.closing = true
    await this.stop()
  }

  private safePost(child: UtilityProcess, message: unknown): boolean {
    if (child !== this.child || this.exits.has(child)) return false
    try {
      child.postMessage(message)
      return true
    } catch {
      return false
    }
  }

  /** 一个子进程只执行一次终止流程；超时也必须确认退出，不能伪报清理成功。 */
  private terminateChild(child: UtilityProcess): Promise<void> {
    const existing = this.terminations.get(child)
    if (existing) return existing
    if (this.exits.has(child)) return Promise.resolve()
    const task = new Promise<void>((resolve, reject) => {
      let forceTimer: ReturnType<typeof setTimeout> | undefined
      const cleanup = (): void => {
        clearTimeout(graceTimer)
        if (forceTimer) clearTimeout(forceTimer)
        child.removeListener('exit', exited)
      }
      const exited = (): void => {
        cleanup()
        resolve()
      }
      const graceTimer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* 退出事件仍可能正在传递。 */
        }
        if (this.exits.has(child)) return
        forceTimer = setTimeout(() => {
          if (this.exits.has(child)) {
            cleanup()
            resolve()
            return
          }
          const pid = child.pid
          if (pid !== undefined && child === this.child) {
            try {
              process.kill(pid, 'SIGKILL')
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
                cleanup()
                reject(new Error('无法终止 MyDSH 运行进程'))
                return
              }
            }
          }
          forceTimer = setTimeout(() => {
            cleanup()
            reject(new Error('MyDSH 运行进程未在停止期限内退出'))
          }, 2_000)
        }, 1_000)
      }, 20_000)
      child.once('exit', exited)
      this.safePost(child, { type: 'stop' })
    })
    this.terminations.set(child, task)
    return task
  }

  private async start(): Promise<void> {
    if (this.state.kind === 'ready') return
    const startedAt = performance.now()
    this.stopping = false
    this.installationAbort = new AbortController()
    try {
      // 恢复必须早于安装器创建 data，否则中断导入的旧数据会被误判成已提交副本。
      await recoverDshImport(resolveMydshHome(this.options.mydshHome))
      this.installation = await ensureRuntimeInstalled({
        ...this.options,
        signal: this.installationAbort.signal,
        onProgress: progress => {
          this.publish({
            kind: 'connecting',
            phase: progress.phase === 'ready' ? 'starting' : progress.phase,
            message: progress.phase === 'ready' ? '正在启动 MyDSH 运行核心…' : progress.message,
            diagnostics: {
              phase: progress.phase === 'ready' ? 'starting' : progress.phase,
              attempt: 1,
              maxAttempts: 1,
              logs: [],
            },
          })
        },
      })
      if (this.stopping) return
      const coreCheckedAt = performance.now()
      const child = utilityProcess.fork(this.installation.entryPath, [], {
        cwd: this.installation.mydshHome,
        env: {
          ...process.env,
          MYDSH_NODE_EXECUTABLE: process.execPath,
          MYDSH_HOME: this.installation.mydshHome,
          DSH_HOME: join(this.installation.mydshHome, 'data'),
          DSH_TELEMETRY_DISABLED: '1',
        },
        stdio: 'pipe',
        serviceName: 'MyDSH Runtime',
      })
      this.child = child
      const logs: { stream: 'stdout' | 'stderr'; message: string }[] = []
      const append = (stream: 'stdout' | 'stderr', message: string): void => {
        logs.push({ stream, message: message.slice(0, 1500) })
        if (logs.length > 50) logs.shift()
      }
      child.stdout?.on('data', data => append('stdout', String(data)))
      child.stderr?.on('data', data => append('stderr', String(data)))
      let startupFailure: Error | undefined
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('MyDSH 核心启动超时'))
        }, 60_000)
        child.on('spawn', () =>
          this.options.onSpawned?.(child.pid === undefined ? {} : { pid: child.pid }),
        )
        child.on('message', (message: RuntimeMessage) => {
          if (child !== this.child) return
          if (!isRecord(message) || typeof message.type !== 'string') {
            reject(new Error('运行核心发送了无效消息'))
            void this.terminateChild(child).catch(() => {})
            return
          }
          try {
            boundedJson(message, MAX_MESSAGE_BYTES)
          } catch (error) {
            reject(error)
            void this.terminateChild(child).catch(() => {})
            return
          }
          if (message.type === 'ready') {
            clearTimeout(timer)
            if (this.stopping || this.closing) {
              reject(new Error('运行核心启动已取消'))
              return
            }
            if (message.version !== this.installation?.manifest.version) {
              reject(new Error('运行核心报告的版本与安装清单不一致'))
              return
            }
            console.info('MyDSH 启动耗时（毫秒）：', {
              coreInstall: Math.round(coreCheckedAt - startedAt),
              coreLoad: Math.round(performance.now() - coreCheckedAt),
              total: Math.round(performance.now() - startedAt),
              installed: this.installation?.installed ?? false,
            })
            this.publish({
              kind: 'ready',
              ownership: 'spawned-by-desktop',
              url: 'mydsh-runtime://local/',
              identity: { reportedVersion: message.version ?? '' },
              diagnostics: {
                phase: 'ready',
                attempt: 1,
                maxAttempts: 1,
                ...(child.pid === undefined ? {} : { pid: child.pid }),
                logs,
              },
            })
            resolve()
            return
          }
          if (message.type === 'failed') {
            clearTimeout(timer)
            startupFailure = new Error(message.error?.message ?? 'MyDSH 核心加载失败')
            reject(startupFailure)
            void this.terminateChild(child).catch(() => {})
            return
          }
          if (message.type === 'log') {
            append('stderr', message.message ?? '')
            return
          }
          if (message.type === 'plugins-changed') {
            for (const listener of this.pluginListeners) listener()
            return
          }
          if (message.type === 'cancel-main-call') {
            if (this.directoryPick?.child === child && this.directoryPick.id === message.id)
              this.directoryPick.controller.abort()
            if (message.id) this.connectionCalls.get(message.id)?.abort()
            return
          }
          if (message.type === 'main-call') {
            void this.handleMainCall(child, message)
            return
          }
          if (!message.id) return
          const pending = this.pending.get(message.id)
          if (!pending) return
          if (message.type === 'item') {
            void Promise.resolve()
              .then(() => pending.item?.(message.value))
              .then(
                () => {
                  if (
                    this.pending.get(message.id!) === pending &&
                    !this.safePost(child, { type: 'ack', id: message.id })
                  )
                    pending.reject(new Error('运行事件流已断开'))
                },
                error => {
                  this.safePost(child, { type: 'cancel', id: message.id })
                  pending.reject(error)
                },
              )
            return
          }
          this.pending.delete(message.id)
          if (message.type === 'stream-error')
            pending.reject(new Error(message.error?.message ?? '运行事件流失败'))
          else pending.resolve(message.type === 'result' ? message.result : undefined)
        })
        child.once('exit', code => {
          if (this.directoryPick?.child === child) this.directoryPick.controller.abort()
          if (child === this.child)
            for (const controller of this.connectionCalls.values()) controller.abort()
          this.exits.add(child)
          clearTimeout(timer)
          const error = startupFailure ?? new Error(`MyDSH 运行进程已退出（${String(code)}）`)
          for (const pending of this.pending.values()) pending.reject(error)
          this.pending.clear()
          if (child === this.child) this.child = undefined
          if (!this.stopping)
            this.publish({
              kind: 'unavailable',
              reason: 'start-failed',
              message: error.message,
              retryable: true,
              diagnostics: { phase: 'failed', attempt: 1, maxAttempts: 1, logs },
            })
          reject(error)
        })
      })
    } catch (error) {
      let failure = error
      const failedChild = this.child
      if (failedChild) {
        try {
          await this.terminateChild(failedChild)
        } catch (cleanupError) {
          failure = new AggregateError([error, cleanupError], '运行核心启动失败，且退出清理未完成')
        }
      }
      if (!this.stopping)
        this.publish({
          kind: 'unavailable',
          reason: 'start-failed',
          message: failure instanceof Error ? failure.message : String(failure),
          retryable: true,
          diagnostics: { ...this.state.diagnostics, phase: 'failed' },
        })
    }
  }

  async call(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.request('call', endpoint, payload, signal)
  }
  async follow(
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
    onItem: (value: unknown) => void | Promise<void>,
  ): Promise<void> {
    await this.request('open', endpoint, payload, signal, async value => {
      await onItem(value)
    })
  }
  private async request(
    type: 'call' | 'open',
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
    item?: (value: unknown) => Promise<void>,
  ): Promise<unknown> {
    const child = this.child
    if (!child || this.state.kind !== 'ready' || this.stopping || this.closing)
      throw new Error('MyDSH 运行核心尚未就绪')
    if (this.pending.size >= MAX_PENDING_REQUESTS)
      throw new Error('运行请求过多，请等待已有请求完成')
    if (typeof endpoint !== 'string' || endpoint.length > 512) throw new Error('运行接口名称无效')
    // 只有主进程发出的桌面调用获得该代凭据；Agent 直接调用 Gateway 无法自报窗口身份。
    if (endpoint.startsWith('mydshSsh/') || endpoint.startsWith('mydshDatabase/')) {
      if (!isRecord(payload) || !isRecord(payload.args)) throw new Error('连接请求参数无效')
      payload = { ...payload, args: { ...payload.args, windowToken: this.connectionToken } }
    }
    boundedJson(payload, MAX_MESSAGE_BYTES - 4096)
    const requestSignal = type === 'call' ? callSignal(endpoint, payload, signal) : signal
    requestSignal?.throwIfAborted()
    const id = randomUUID()
    let abort: (() => void) | undefined
    try {
      return await new Promise((resolve, reject) => {
        abort = () => {
          this.pending.delete(id)
          this.safePost(child, { type: 'cancel', id })
          reject(requestSignal?.reason ?? new Error('请求已取消'))
        }
        this.pending.set(id, { resolve, reject, ...(item ? { item } : {}) })
        requestSignal?.addEventListener('abort', abort, { once: true })
        if (!this.safePost(child, { type, id, endpoint, payload }))
          reject(new Error('运行核心通信已关闭'))
      })
    } finally {
      if (abort) requestSignal?.removeEventListener('abort', abort)
      this.pending.delete(id)
    }
  }
  /** 保留 DSH Connection 的 Fetch-shaped 契约，实际消息只经 IPC，不建立 HTTP 连接。 */
  readonly fetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    const envelope = (await request.json()) as { rpcId: string; method: string; payload: unknown }
    const result = await this.call(envelope.method, envelope.payload, request.signal)
    return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result })
  }
  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask
    this.stopping = true
    this.installationAbort?.abort()
    this.directoryPick?.controller.abort()
    for (const controller of this.connectionCalls.values()) controller.abort()
    // 先通知消费者断开，避免它们在取消请求期间仍认为旧代进程可用。
    this.publish({
      kind: 'connecting',
      phase: 'stopping',
      message: '正在停止运行核心…',
      diagnostics: { ...this.state.diagnostics, phase: 'stopping' },
    })
    for (const [id, pending] of this.pending) {
      if (this.child) this.safePost(this.child, { type: 'cancel', id })
      pending.reject(new Error('运行核心正在停止'))
    }
    this.pending.clear()
    const task = async (): Promise<void> => {
      // 子进程终止异常也要等待启动取消和原生对话框清理。
      const cleanup = await Promise.allSettled([
        this.child ? this.terminateChild(this.child) : Promise.resolve(),
        this.starting,
        this.directoryPick?.task.catch(() => {}),
      ])
      const failures = cleanup.filter(result => result.status === 'rejected')
      if (failures.length)
        throw new AggregateError(
          failures.map(result => result.reason),
          'MyDSH 运行核心停止清理未完成',
        )
      this.publish({
        kind: 'unavailable',
        reason: 'stopped',
        message: '运行核心已停止',
        retryable: !this.closing,
        diagnostics: { ...this.state.diagnostics, phase: 'stopped' },
      })
    }
    this.stopTask = task().finally(() => {
      this.stopTask = undefined
    })
    return this.stopTask
  }
  private async handleMainCall(child: UtilityProcess, message: RuntimeMessage): Promise<void> {
    if (typeof message.id !== 'string' || message.id.length > 128) return
    const picking = message.method === 'directory.pick'
    try {
      if (this.stopping) throw new Error('运行核心正在停止，不能开始系统操作')
      let value: unknown
      if (picking) {
        if (!isRecord(message.payload) || Object.keys(message.payload).length !== 0)
          throw new Error('目录选择不接受自定义系统参数')
        if (!this.options.pickDirectory) throw new Error('桌面目录选择不可用')
        if (this.directoryPick) throw new Error('请先完成当前目录选择')
        const controller = new AbortController()
        const pick = this.options.pickDirectory
        const request = {
          child,
          id: message.id,
          controller,
          task: Promise.resolve().then(() => pick(controller.signal)),
        }
        this.directoryPick = request
        try {
          value = await request.task
          request.controller.signal.throwIfAborted()
        } finally {
          if (this.directoryPick === request) this.directoryPick = undefined
        }
      } else if (message.method === 'ssh.window-token') {
        if (!isRecord(message.payload) || Object.keys(message.payload).length)
          throw new Error('桌面连接身份请求无效')
        value = this.connectionToken
      } else if (message.method && isConnectionOrAutomationMethod(message.method)) {
        const isAutomation = message.method.startsWith('automation.')
        const handler = isAutomation ? this.options.automationSystem : this.options.connectionSystem
        const maxBytes = isAutomation ? 2 * 1024 * 1024 : 256 * 1024
        if (
          !isRecord(message.payload) ||
          !handler ||
          this.connectionCalls.size >= 8 ||
          this.connectionCalls.has(message.id)
        ) {
          throw new Error(
            isAutomation ? '桌面自动化服务不可用或并发请求过多' : '连接凭据服务不可用或请求过多',
          )
        }
        boundedJson(message.payload, maxBytes)
        const controller = new AbortController()
        this.connectionCalls.set(message.id, controller)
        try {
          value = await handler(message.method, message.payload, controller.signal)
          controller.signal.throwIfAborted()
        } finally {
          if (this.connectionCalls.get(message.id) === controller)
            this.connectionCalls.delete(message.id)
        }
      } else throw new Error('未知系统操作')
      this.safePost(child, { type: 'main-result', id: message.id, value })
    } catch (error) {
      this.safePost(child, {
        type: 'main-result',
        id: message.id,
        error: error instanceof Error ? error.message : '系统操作失败',
      })
    }
  }
}
