import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { Duplex } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Client, ClientChannel, ConnectConfig, SFTPWrapper } from 'ssh2'
import type { ConnectionLease } from '@mydsh/connection-access'
import type {
  SaveSshProfile,
  SshAgentAccess,
  SshConnectResult,
  SshProfile,
  SshStatus,
  SshTerminal,
  SshTerminalEvent,
} from '../types.d.ts'
import {
  isSupportedSshPlatform,
  mergeSshElevations,
  normalizeSshAgentAccess,
  type SshPermissionElevation,
} from './agent-policy.ts'
import { SshAgentPool } from './agent-pool.ts'
import type { ResolvedAgentSshTarget } from './permission-negotiation.ts'
import { closeClient, connectSsh, fingerprintOf, probeHost } from './transport.ts'

type Secrets = Partial<Record<'ssh-password' | 'ssh-private-key' | 'ssh-passphrase', unknown>>
interface Stored {
  version: 1
  profile: Omit<SshProfile, 'credentialConfigured'>
  secrets: Secrets
}
interface LiveTerminal {
  descriptor: SshTerminal
  client: Client
  channel: ClientChannel
  history: string
  closed: boolean
  listeners: Set<(event: SshTerminalEvent) => void>
}
export interface ConnectionSystem {
  token: string
  call(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    mydshSsh: SshConnections
    mydshConnectionSystem: ConnectionSystem
  }
}
const prefix = 'mydsh-ssh/connection-'
const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u
const keyOf = (id: string) => {
  if (!idPattern.test(id)) throw new Error('连接标识无效')
  return credentialKey('mydsh-ssh', `connection-${id}`)
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function admitted(value: unknown): Stored {
  if (!record(value) || value.version !== 1 || !record(value.profile) || !record(value.secrets))
    throw new Error('SSH 连接记录格式无效')
  const rawProfile = value.profile as Record<string, unknown>
  const agentAccess = normalizeSshAgentAccess(rawProfile.agentAccess)
  const result: Stored = {
    version: 1,
    secrets: value.secrets as Secrets,
    profile: { ...(value.profile as unknown as Stored['profile']), agentAccess },
  }
  validate(result.profile)
  if (
    !idPattern.test(result.profile.id) ||
    !Number.isSafeInteger(result.profile.revision) ||
    result.profile.revision < 1 ||
    (result.profile.fingerprint !== null &&
      !/^SHA256:[A-Za-z0-9+/]{43}$/u.test(result.profile.fingerprint))
  )
    throw new Error('SSH 连接记录身份无效')
  return result
}
function validate(
  value: Pick<
    SaveSshProfile,
    'name' | 'host' | 'port' | 'username' | 'auth' | 'environment' | 'projectId' | 'disabled'
  >,
): void {
  if (
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    value.name.length > 100 ||
    typeof value.host !== 'string' ||
    !value.host ||
    value.host.length > 253 ||
    /[\s/@?#\u0000-\u001f]/u.test(value.host) ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535 ||
    typeof value.username !== 'string' ||
    !value.username ||
    value.username.length > 128 ||
    /[\u0000-\u001f]/u.test(value.username) ||
    !['password', 'key'].includes(value.auth) ||
    typeof value.disabled !== 'boolean' ||
    typeof value.environment !== 'string' ||
    value.environment.length > 40 ||
    (value.projectId !== null &&
      (typeof value.projectId !== 'string' || value.projectId.length > 512))
  )
    throw new Error('请检查连接名称、地址、端口和用户名')
}
const publicProfile = (value: Stored): SshProfile => ({
  id: value.profile.id,
  revision: value.profile.revision,
  name: value.profile.name,
  host: value.profile.host,
  port: value.profile.port,
  username: value.profile.username,
  auth: value.profile.auth,
  environment: value.profile.environment,
  projectId: value.profile.projectId,
  disabled: value.profile.disabled,
  fingerprint: value.profile.fingerprint,
  credentialConfigured:
    !!value.secrets[value.profile.auth === 'password' ? 'ssh-password' : 'ssh-private-key'],
  agentAccess: {
    ...value.profile.agentAccess,
    allowedPaths: [...value.profile.agentAccess.allowedPaths],
  },
})
function dimensions(columns: number, rows: number): void {
  if (
    !Number.isInteger(columns) ||
    columns < 2 ||
    columns > 500 ||
    !Number.isInteger(rows) ||
    rows < 1 ||
    rows > 200
  )
    throw new Error('终端尺寸无效')
}

/** 元信息与所属密文在同一凭据记录中原子保存，避免新增第二套文件和跨文件事务。 */
export class SshConnections extends TypertRemoteService {
  static inject = ['credentials', 'mydshConnectionSystem']
  private readonly lifetime = new AbortController()
  private mutations: Promise<unknown> = Promise.resolve()
  private readonly connecting = new Map<string, AbortController>()
  private readonly terminals = new Map<string, LiveTerminal>()
  private readonly tunnels = new Map<string, { connectionId: string; close(): Promise<void> }>()
  private readonly agentPool = new SshAgentPool()
  private readonly agentElevations = new Map<
    string,
    { sessionId: string; connectionId: string; elevation: SshPermissionElevation }
  >()
  private readonly challenges = new Map<
    string,
    { fingerprint: string; revision: number; expires: number }
  >()
  constructor(ctx: Context) {
    super(ctx, 'mydshSsh')
    const events = ctx as unknown as {
      on(event: string, listener: (...args: unknown[]) => void): () => void
    }
    events.on('agent/disposed', (payload: unknown) => {
      const id = (payload as { agent?: { id?: string } })?.agent?.id
      if (typeof id === 'string') this.clearSessionElevations(id)
    })
    events.on('session/disposed', (payload: unknown) => {
      const id = (payload as { id?: string })?.id
      if (typeof id === 'string') this.clearSessionElevations(id)
    })
    events.on('api-session/removed', (sessionId: unknown) => {
      if (typeof sessionId === 'string') this.clearSessionElevations(sessionId)
    })
    ctx.effect(() => async () => {
      this.lifetime.abort()
      await this.closeOwned()
      await this.mutations.catch(() => {})
    })
  }
  private clearSessionElevations(sessionId: string): void {
    for (const [key, entry] of this.agentElevations.entries()) {
      if (entry.sessionId === sessionId) this.agentElevations.delete(key)
    }
  }
  private clearConnectionElevations(connectionId: string): void {
    for (const [key, entry] of this.agentElevations.entries()) {
      if (entry.connectionId === connectionId) this.agentElevations.delete(key)
    }
  }
  private authorize(windowToken: string): void {
    if (process.platform !== 'darwin' && process.platform !== 'win32')
      throw new Error('SSH 连接目前仅支持 macOS 与 Windows')
    if (windowToken !== this.ctx.mydshConnectionSystem.token)
      throw new Error('该操作只允许当前桌面窗口使用，尚未向 Agent 开放')
    this.lifetime.signal.throwIfAborted()
  }
  private async read(id: string): Promise<Stored> {
    const entry = await this.ctx.credentials.readRecord(keyOf(id))
    if (entry?.kind !== 'grant') throw new Error('SSH 连接不存在')
    const value = admitted(entry.payload)
    if (value.profile.id !== id) throw new Error('SSH 连接记录不匹配')
    return value
  }
  private invalidateAccess(id: string): void {
    this.clearConnectionElevations(id)
    const access = (
      this.ctx.get as (
        name: string,
      ) => { invalidate(target: { kind: 'ssh'; id: string }): void } | undefined
    )('mydshConnectionAccess')
    access?.invalidate({ kind: 'ssh', id })
  }
  private mutate<T>(work: () => Promise<T>): Promise<T> {
    const task = this.mutations.then(() => {
      this.lifetime.signal.throwIfAborted()
      return work()
    })
    this.mutations = task.catch(() => {})
    return task
  }
  private async persist(value: Stored): Promise<SshProfile> {
    await this.ctx.credentials.modifyRecord(keyOf(value.profile.id), async () => {
      this.lifetime.signal.throwIfAborted()
      return { kind: 'grant', payload: value }
    })
    return publicProfile(value)
  }
  /** 数据库通道与终端共用同一认证来源，不复制凭据或继承用户 SSH Agent。 */
  private async authenticate(
    value: Stored,
    signal: AbortSignal,
  ): Promise<{ client: Client; safeMessage(message: string): string }> {
    const plaintext: string[] = []
    const safeMessage = (message: string) =>
      plaintext.reduce(
        (text, secret) => (secret ? text.replaceAll(secret, '[已隐藏]') : text),
        message,
      )
    try {
      const credential = async (purpose: keyof Secrets): Promise<string | undefined> => {
        const envelope = value.secrets[purpose]
        if (envelope === undefined) return undefined
        const secret = await this.ctx.mydshConnectionSystem.call(
          'ssh.open',
          { connectionId: value.profile.id, purpose, envelope },
          signal,
        )
        if (typeof secret !== 'string') throw new Error('系统未返回可用凭据')
        plaintext.push(secret)
        return secret
      }
      const auth: Pick<ConnectConfig, 'password' | 'privateKey' | 'passphrase'> = {}
      if (value.profile.auth === 'password') {
        const password = await credential('ssh-password')
        if (password !== undefined) auth.password = password
      } else {
        const privateKey = await credential('ssh-private-key'),
          passphrase = await credential('ssh-passphrase')
        if (privateKey !== undefined) auth.privateKey = privateKey
        if (passphrase !== undefined) auth.passphrase = passphrase
      }
      if (
        value.profile.auth === 'password'
          ? auth.password === undefined
          : auth.privateKey === undefined
      )
        throw new Error('请先保存密码或导入私钥')
      return {
        client: await connectSsh(
          value.profile,
          auth,
          signal,
          key => fingerprintOf(key) === value.profile.fingerprint,
        ),
        safeMessage,
      }
    } catch (error) {
      throw new Error(safeMessage(error instanceof Error ? error.message : 'SSH 认证失败'))
    }
  }
  /** 内部通道工厂显式接收资源所有者，不进入实例服务和 Remote 契约。 */
  static openTunnel(
    owner: SshConnections,
    windowToken: string,
    id: string,
    host: string,
    port: number,
    signal: AbortSignal,
  ): Promise<{ stream: Duplex; close(): Promise<void> }> {
    return owner.openTunnel(windowToken, id, host, port, signal)
  }
  /** 读取已信任 SSH 连接的身份与指纹摘要，供依赖连接校验版本与失效。 */
  static async trustedIdentity(
    owner: SshConnections,
    id: string,
  ): Promise<{ id: string; revision: number; fingerprint: string; name: string }> {
    const value = await owner.read(id)
    if (value.profile.disabled) throw new Error('关联的 SSH 连接已禁用')
    if (!value.profile.fingerprint) throw new Error('关联的 SSH 连接尚未核对并信任主机指纹')
    return {
      id: value.profile.id,
      revision: value.profile.revision,
      fingerprint: value.profile.fingerprint,
      name: value.profile.name,
    }
  }
  private buildAgentTarget(stored: Stored): ResolvedAgentSshTarget {
    const profile = publicProfile(stored)
    if (profile.disabled) throw new Error('PERMISSION_DENIED：该 SSH 连接已禁用')
    if (!profile.agentAccess.enabled) {
      throw new Error(
        'PERMISSION_DENIED：该 SSH 连接未向模型开放，请在「SSH」连接编辑弹窗的「Agent 权限」中开启',
      )
    }
    if (!profile.credentialConfigured)
      throw new Error(
        'CREDENTIAL_MISSING：该 SSH 连接尚未配置密码或私钥，请先在「SSH」面板保存凭据',
      )
    if (!profile.fingerprint) {
      throw new Error(
        'HOST_UNTRUSTED：该 SSH 连接尚未核对并信任主机指纹，请先在「SSH」面板手动连接并确认指纹',
      )
    }
    return {
      profile,
      connection: {
        kind: 'ssh',
        id: profile.id,
        revision: profile.revision,
        fingerprint: profile.fingerprint,
      },
    }
  }
  /** 列出 SSH 连接的凭据记录条目；必须作为实例方法执行，确保使用服务自身注入的 credentials 上下文。 */
  private async connectionRecords() {
    const entries = await this.ctx.credentials.listRecords()
    return entries.filter(entry => entry.key.startsWith(prefix))
  }
  /** 列出当前已启用、凭据完整、已确认指纹且开放给模型的 SSH 连接摘要。 */
  static async agentCatalog(owner: SshConnections): Promise<ResolvedAgentSshTarget[]> {
    if (!isSupportedSshPlatform()) return []
    owner.lifetime.signal.throwIfAborted()
    const entries = await owner.connectionRecords()
    const results: ResolvedAgentSshTarget[] = []
    for (const entry of entries) {
      owner.lifetime.signal.throwIfAborted()
      try {
        const stored = await owner.read(entry.key.slice(prefix.length))
        results.push(owner.buildAgentTarget(stored))
      } catch {
        // 跳过禁用、未确认指纹或未开放模型访问的连接，不影响其余可用主机发现。
      }
    }
    return results
  }
  /** 解析单个可供 Agent 调用的 SSH 目标；未开放、禁用或未确认指纹时明确拒绝。 */
  static async resolveAgentConnection(
    owner: SshConnections,
    connectionId: string,
  ): Promise<ResolvedAgentSshTarget> {
    if (!isSupportedSshPlatform()) throw new Error('SSH 连接目前仅支持 macOS 与 Windows')
    owner.lifetime.signal.throwIfAborted()
    return owner.buildAgentTarget(await owner.read(connectionId))
  }
  private elevationKey(sessionId: string, target: ResolvedAgentSshTarget): string {
    return `${sessionId}:${target.connection.id}:${target.connection.revision}:${target.connection.fingerprint ?? ''}`
  }
  /** 读取当前主会话对指定版本 SSH 连接的内存临时提权。 */
  static agentElevation(
    owner: SshConnections,
    agent: { id: string } | undefined,
    target: ResolvedAgentSshTarget,
  ): SshPermissionElevation | undefined {
    if (!agent) return undefined
    const entry = owner.agentElevations.get(owner.elevationKey(agent.id, target))
    return entry ? { ...entry.elevation } : undefined
  }
  /** 登记当前主会话对指定版本 SSH 连接的内存临时提权；配置或指纹变动时自动失效。 */
  static grantAgentElevation(
    owner: SshConnections,
    agent: { id: string },
    target: ResolvedAgentSshTarget,
    elevation: SshPermissionElevation,
  ): void {
    const key = owner.elevationKey(agent.id, target)
    const previous = owner.agentElevations.get(key)?.elevation
    const merged = mergeSshElevations(previous, elevation)
    if (!merged) return
    owner.agentElevations.set(key, {
      sessionId: agent.id,
      connectionId: target.profile.id,
      elevation: merged,
    })
  }
  /** 仅供同包 Agent 工具使用：校验配置版本与租约后，借用独立连接池执行远端操作。 */
  static async runForAgent<T>(
    owner: SshConnections,
    target: ResolvedAgentSshTarget,
    options: {
      signal: AbortSignal
      lease?: ConnectionLease
      needsSftp?: boolean
    },
    work: (session: {
      client: Client
      sftp?: SFTPWrapper
      safeMessage: (message: string) => string
      signal: AbortSignal
    }) => Promise<T>,
  ): Promise<T> {
    if (!isSupportedSshPlatform()) throw new Error('SSH 连接目前仅支持 macOS 与 Windows')
    const signals = [options.signal, owner.lifetime.signal]
    if (options.lease) signals.push(options.lease.signal)
    const combined = AbortSignal.any(signals)
    combined.throwIfAborted()
    const currentStored = await owner.read(target.profile.id)
    const latest = owner.buildAgentTarget(currentStored)
    if (
      latest.connection.revision !== target.connection.revision ||
      latest.connection.fingerprint !== target.connection.fingerprint
    ) {
      throw new Error('GRANT_EXPIRED：SSH 连接配置或主机指纹已变化，请重新读取连接状态后再试')
    }
    const fingerprint = latest.connection.fingerprint!
    return owner.agentPool.withSession(
      {
        identity: {
          id: latest.profile.id,
          revision: latest.connection.revision,
          fingerprint,
        },
        signal: combined,
        ...(options.needsSftp ? { needsSftp: true } : {}),
        connect: async connectSignal => {
          const fresh = await owner.read(target.profile.id)
          const verified = owner.buildAgentTarget(fresh)
          if (
            verified.connection.revision !== target.connection.revision ||
            verified.connection.fingerprint !== target.connection.fingerprint
          ) {
            throw new Error('GRANT_EXPIRED：SSH 连接配置或主机指纹已变化，本次连接已取消')
          }
          return owner.authenticate(fresh, connectSignal)
        },
      },
      session => work({ ...session, signal: combined }),
    )
  }
  /** 通道仍由现有 SSH 所有者释放，不监听本机端口。 */
  private async openTunnel(
    windowToken: string,
    id: string,
    host: string,
    port: number,
    signal: AbortSignal,
  ): Promise<{ stream: Duplex; close(): Promise<void> }> {
    this.authorize(windowToken)
    if (this.tunnels.size >= 16) throw new Error('SSH 数据库通道已达到上限')
    const controller = new AbortController(),
      combined = AbortSignal.any([signal, controller.signal, this.lifetime.signal])
    const key = randomUUID()
    let client: Client | undefined, closing: Promise<void> | undefined
    const close = () =>
      (closing ??= (async () => {
        controller.abort()
        this.tunnels.delete(key)
        if (client) await closeClient(client)
      })())
    this.tunnels.set(key, { connectionId: id, close })
    try {
      const value = await this.read(id)
      if (value.profile.disabled) throw new Error('SSH 连接已禁用')
      if (!value.profile.fingerprint) throw new Error('请先在服务器连接中核对并信任 SSH 主机指纹')
      const authenticated = await this.authenticate(value, combined)
      client = authenticated.client
      const abort = () => client?.destroy()
      combined.addEventListener('abort', abort, { once: true })
      client.once('close', () => {
        combined.removeEventListener('abort', abort)
        this.tunnels.delete(key)
      })
      combined.throwIfAborted()
      if ((await this.read(id)).profile.revision !== value.profile.revision)
        throw new Error('SSH 连接配置已变化')
      const stream = await new Promise<ClientChannel>((resolve, reject) => {
        client!.forwardOut('127.0.0.1', 0, host, port, (error, stream) =>
          error ? reject(new Error(authenticated.safeMessage(error.message))) : resolve(stream),
        )
      })
      combined.throwIfAborted()
      client.on('error', () => stream.destroy())
      return { stream, close }
    } catch (error) {
      await close()
      if (client) await closeClient(client)
      throw error
    }
  }
  @Remote
  async status(windowToken: string): Promise<SshStatus> {
    if (process.platform !== 'darwin' && process.platform !== 'win32')
      return { supported: false, connections: [], terminals: [] }
    this.authorize(windowToken)
    const entries = (await this.ctx.credentials.listRecords()).filter(entry =>
      entry.key.startsWith(prefix),
    )
    if (entries.length > 200) throw new Error('SSH 连接记录超过 200 条上限')
    const connections = await Promise.all(
      entries.map(async entry => publicProfile(await this.read(entry.key.slice(prefix.length)))),
    )
    return {
      supported: true,
      connections,
      terminals: [...this.terminals.values()].map(item => ({ ...item.descriptor })),
    }
  }
  @Remote
  async save(windowToken: string, request: SaveSshProfile): Promise<SshProfile> {
    this.authorize(windowToken)
    validate(request)
    return this.mutate(async () => {
      const previous = request.id === null ? undefined : await this.read(request.id)
      if (previous && previous.profile.revision !== request.revision)
        throw new Error('连接已被修改，请刷新后重试')
      if (!previous && (await this.status(windowToken)).connections.length >= 200)
        throw new Error('SSH 连接已达到上限')
      const id = previous?.profile.id ?? randomUUID()
      const secrets: Secrets =
        previous?.profile.auth === request.auth ? { ...previous.secrets } : {}
      for (const [field, purpose] of [
        ['password', 'ssh-password'],
        ['passphrase', 'ssh-passphrase'],
      ] as const) {
        const secret = request[field]
        if (secret === undefined) continue
        if (typeof secret !== 'string' || secret.length > 65536) throw new Error('凭据内容无效')
        secrets[purpose] = await this.ctx.mydshConnectionSystem.call(
          'ssh.seal',
          { connectionId: id, purpose, secret },
          this.lifetime.signal,
        )
      }
      const targetChanged =
        previous &&
        (previous.profile.host !== request.host || previous.profile.port !== request.port)
      const agentAccess: SshAgentAccess = normalizeSshAgentAccess(
        request.agentAccess,
        previous?.profile.agentAccess,
      )
      await this.closeConnection(id)
      this.invalidateAccess(id)
      this.challenges.delete(id)
      return this.persist({
        version: 1,
        secrets,
        profile: {
          id,
          revision: (previous?.profile.revision ?? 0) + 1,
          name: request.name.trim(),
          host: request.host,
          port: request.port,
          username: request.username,
          auth: request.auth,
          environment: request.environment.trim(),
          projectId: request.projectId,
          disabled: request.disabled,
          fingerprint: targetChanged ? null : (previous?.profile.fingerprint ?? null),
          agentAccess,
        },
      })
    })
  }
  @Remote
  async importKey(
    windowToken: string,
    id: string,
    revision: number,
    signal: AbortSignal,
  ): Promise<SshProfile> {
    this.authorize(windowToken)
    return this.mutate(async () => {
      const value = await this.read(id)
      if (value.profile.revision !== revision || value.profile.auth !== 'key')
        throw new Error('连接已改变或不使用私钥，请刷新后重试')
      const envelope = await this.ctx.mydshConnectionSystem.call(
        'ssh.import-key',
        { connectionId: id },
        AbortSignal.any([signal, this.lifetime.signal]),
      )
      signal.throwIfAborted()
      if (envelope === null) return publicProfile(value)
      await this.closeConnection(id)
      this.invalidateAccess(id)
      signal.throwIfAborted()
      return this.persist({
        ...value,
        profile: { ...value.profile, revision: revision + 1 },
        secrets: { ...value.secrets, 'ssh-private-key': envelope },
      })
    })
  }
  @Remote
  async remove(windowToken: string, id: string, revision: number): Promise<boolean> {
    this.authorize(windowToken)
    return this.mutate(async () => {
      if ((await this.read(id)).profile.revision !== revision)
        throw new Error('连接已改变，请刷新后重试')
      await this.closeConnection(id)
      this.invalidateAccess(id)
      await this.ctx.credentials.deleteRecord(keyOf(id))
      this.challenges.delete(id)
      return true
    })
  }
  @Remote
  async trustHost(
    windowToken: string,
    id: string,
    revision: number,
    fingerprint: string,
  ): Promise<SshProfile> {
    this.authorize(windowToken)
    return this.mutate(async () => {
      const value = await this.read(id),
        challenge = this.challenges.get(id)
      if (
        value.profile.fingerprint ||
        value.profile.revision !== revision ||
        !challenge ||
        challenge.revision !== revision ||
        challenge.fingerprint !== fingerprint ||
        challenge.expires < Date.now()
      )
        throw new Error('主机指纹确认已失效，请重新连接并核对')
      this.challenges.delete(id)
      this.invalidateAccess(id)
      return this.persist({
        ...value,
        profile: { ...value.profile, fingerprint, revision: revision + 1 },
      })
    })
  }
  @Remote
  async resetHost(windowToken: string, id: string, revision: number): Promise<SshProfile> {
    this.authorize(windowToken)
    return this.mutate(async () => {
      const value = await this.read(id)
      if (value.profile.revision !== revision) throw new Error('连接已改变，请刷新后重试')
      await this.closeConnection(id)
      this.invalidateAccess(id)
      this.challenges.delete(id)
      return this.persist({
        ...value,
        profile: { ...value.profile, fingerprint: null, revision: revision + 1 },
      })
    })
  }
  @Remote
  async connect(
    windowToken: string,
    id: string,
    testOnly: boolean,
    columns: number,
    rows: number,
    signal: AbortSignal,
  ): Promise<SshConnectResult> {
    this.authorize(windowToken)
    dimensions(columns, rows)
    if (this.connecting.has(id)) throw new Error('该连接正在建立，请等待或取消')
    if (this.connecting.size + this.terminals.size >= 12)
      throw new Error('SSH 终端已达到 12 个上限')
    const controller = new AbortController(),
      combined = AbortSignal.any([signal, controller.signal, this.lifetime.signal])
    this.connecting.set(id, controller)
    let client: Client | undefined,
      handedOff = false
    let safeMessage = (message: string) => message
    try {
      const value = await this.read(id),
        profile = value.profile
      if (profile.disabled) throw new Error('该连接已禁用')
      if (profile.fingerprint === null) {
        const fingerprint = await probeHost(profile, combined)
        combined.throwIfAborted()
        this.challenges.set(id, {
          fingerprint,
          revision: profile.revision,
          expires: Date.now() + 120_000,
        })
        return { kind: 'confirm-host', connectionId: id, revision: profile.revision, fingerprint }
      }
      const authenticated = await this.authenticate(value, combined)
      client = authenticated.client
      safeMessage = authenticated.safeMessage
      combined.throwIfAborted()
      if ((await this.read(id)).profile.revision !== profile.revision)
        throw new Error('连接配置已变化，本次连接已取消')
      combined.throwIfAborted()
      if (testOnly) return { kind: 'tested' }
      const channel = await new Promise<ClientChannel>((resolve, reject) => {
        const abort = () => {
          client?.destroy()
          reject(new Error('SSH 终端创建已取消'))
        }
        combined.addEventListener('abort', abort, { once: true })
        client!.shell({ cols: columns, rows, term: 'xterm-256color' }, (error, stream) => {
          combined.removeEventListener('abort', abort)
          if (error) reject(error)
          else if (combined.aborted) {
            stream.destroy()
            reject(new Error('SSH 终端创建已取消'))
          } else resolve(stream)
        })
      })
      combined.throwIfAborted()
      const terminal: LiveTerminal = {
        descriptor: {
          id: randomUUID(),
          connectionId: id,
          name: profile.name,
          status: 'connected',
          message: null,
        },
        client,
        channel,
        history: '',
        closed: false,
        listeners: new Set(),
      }
      const decoder = new StringDecoder('utf8')
      const data = (chunk: Buffer) => {
        const text = decoder.write(chunk)
        terminal.history = (terminal.history + text).slice(-1024 * 1024)
        this.publish(terminal, { type: 'data', data: text })
      }
      channel.on('data', data)
      channel.stderr.on('data', data)
      const end = (message: string | null) => {
        if (terminal.closed) return
        terminal.closed = true
        terminal.client.destroy()
        terminal.descriptor = {
          ...terminal.descriptor,
          status: 'disconnected',
          message: message === null ? null : safeMessage(message),
        }
        this.publish(terminal, { type: 'status', terminal: { ...terminal.descriptor } })
      }
      client.on('error', error => end(error.message))
      client.once('close', () => end('SSH 连接已断开'))
      channel.on('error', (error: Error) => end(error.message))
      channel.once('close', () => end(null))
      this.terminals.set(terminal.descriptor.id, terminal)
      handedOff = true
      return { kind: 'terminal', terminal: { ...terminal.descriptor } }
    } catch (error) {
      throw new Error(safeMessage(error instanceof Error ? error.message : 'SSH 连接失败'))
    } finally {
      this.connecting.delete(id)
      if (client && !handedOff) await closeClient(client)
    }
  }
  private publish(terminal: LiveTerminal, event: SshTerminalEvent): void {
    for (const listener of terminal.listeners) listener(event)
  }
  private terminal(id: string): LiveTerminal {
    const value = this.terminals.get(id)
    if (!value) throw new Error('SSH 终端已关闭')
    return value
  }
  @Remote
  async input(windowToken: string, id: string, data: string): Promise<boolean> {
    this.authorize(windowToken)
    if (typeof data !== 'string' || Buffer.byteLength(data) > 65536)
      throw new Error('终端输入超过上限')
    const terminal = this.terminal(id)
    if (terminal.closed) throw new Error('SSH 连接已断开')
    await new Promise<void>((resolve, reject) =>
      terminal.channel.write(data, (error?: Error | null) => (error ? reject(error) : resolve())),
    )
    return true
  }
  @Remote
  resize(windowToken: string, id: string, columns: number, rows: number): boolean {
    this.authorize(windowToken)
    dimensions(columns, rows)
    const terminal = this.terminal(id)
    if (!terminal.closed) terminal.channel.setWindow(rows, columns, 0, 0)
    return true
  }
  @Remote
  async close(windowToken: string, id: string): Promise<boolean> {
    this.authorize(windowToken)
    await this.closeTerminal(id)
    return true
  }
  private async closeTerminal(id: string): Promise<void> {
    const terminal = this.terminals.get(id)
    if (!terminal) return
    this.terminals.delete(id)
    terminal.closed = true
    terminal.descriptor = { ...terminal.descriptor, status: 'disconnected' }
    this.publish(terminal, { type: 'status', terminal: { ...terminal.descriptor } })
    terminal.listeners.clear()
    terminal.channel.destroy()
    await closeClient(terminal.client)
  }
  private async closeConnection(id: string): Promise<void> {
    this.connecting.get(id)?.abort(new Error('连接配置已改变或连接已关闭'))
    this.clearConnectionElevations(id)
    await Promise.all([
      this.agentPool.closeConnection(id),
      ...[...this.terminals.values()]
        .filter(item => item.descriptor.connectionId === id)
        .map(item => this.closeTerminal(item.descriptor.id)),
      ...[...this.tunnels.values()]
        .filter(item => item.connectionId === id)
        .map(item => item.close()),
    ])
  }
  private async closeOwned(): Promise<void> {
    for (const request of this.connecting.values()) request.abort(new Error('桌面连接已关闭'))
    this.agentElevations.clear()
    await Promise.all([
      this.agentPool.closeAll(),
      ...[...this.terminals.keys()].map(id => this.closeTerminal(id)),
      ...[...this.tunnels.values()].map(item => item.close()),
    ])
    this.challenges.clear()
  }
  @Remote
  async closeAll(windowToken: string): Promise<boolean> {
    this.authorize(windowToken)
    await this.closeOwned()
    return true
  }
  @Remote({ mode: 'stream' })
  async *events(
    windowToken: string,
    id: string,
    signal: AbortSignal,
  ): AsyncIterable<SshTerminalEvent> {
    this.authorize(windowToken)
    const terminal = this.terminal(id)
    if (terminal.listeners.size >= 2) throw new Error('SSH 终端订阅超过上限')
    const queue: SshTerminalEvent[] = []
    let bytes = 0,
      failure: Error | undefined,
      wake = () => {}
    const listener = (event: SshTerminalEvent) => {
      bytes += event.type === 'data' ? event.data.length : 0
      if (bytes > 1024 * 1024 || queue.length >= 1024)
        failure = new Error('终端输出积压，请关闭后重新连接')
      else queue.push(event)
      wake()
    }
    terminal.listeners.add(listener)
    const abort = () => wake()
    signal.addEventListener('abort', abort, { once: true })
    try {
      yield { type: 'snapshot', data: terminal.history, terminal: { ...terminal.descriptor } }
      while (!signal.aborted) {
        if (failure) throw failure
        const event = queue.shift()
        if (event) {
          if (event.type === 'data') bytes -= event.data.length
          yield event
        } else if (terminal.closed) return
        else
          await new Promise<void>(resolve => {
            wake = resolve
          })
      }
    } finally {
      signal.removeEventListener('abort', abort)
      terminal.listeners.delete(listener)
    }
  }
}
export const name = 'mydsh-ssh'
export const inject = ['credentials', 'mydshConnectionSystem']
export function apply(ctx: Context): void {
  ctx.plugin(SshConnections)
}
