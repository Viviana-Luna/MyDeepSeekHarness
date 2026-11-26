import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import '@deepseek-ai/dsh-authorization'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import { ChatGPTAdapter } from './adapter.ts'
import {
  authorize,
  json,
  MODELS_URL,
  pendingRegistration,
  planEnabled,
  refreshGrant,
  request,
  revokeGrant,
  storedGrant,
  withoutTokens,
} from './auth.ts'
import { PROVIDER, record } from './protocol.ts'
import type { ChatGPTCredential, ChatGPTModel } from './protocol.ts'
import type { ChatGPTStatus } from '../types.d.ts'

export const ACCOUNT_KEY = credentialKey('llm-chatgpt', 'account')
const HOST_KEY = credentialKey('llm-chatgpt', 'host')
declare module '@deepseek-ai/cordis' {
  interface Context {
    chatgpt: ChatGPTAccount
  }
}

/** 账号、目录和授权属于同一插件生命周期；Remote 只公开有限的连接操作。 */
export class ChatGPTAccount extends TypertRemoteService {
  static inject = ['credentials', 'authorization', 'llm']
  private lifetime = new AbortController()
  private accountLifetime = new AbortController()
  private connecting = false
  private notice: { url?: string } = {}
  private message: string | null = null
  private models: ChatGPTModel[] = []
  private readonly adapter: ChatGPTAdapter
  private readonly changed: () => void
  private readonly compactionPolicies = new Map<string, number>()

  constructor(ctx: Context) {
    super(ctx, 'chatgpt')
    this.adapter = new ChatGPTAdapter({
      models: () => this.models,
      attachments: () => ctx.get('attachments'),
      imageAccess: ref => {
        const store = ctx.get('attachments')
        const fs = ctx.get('fs') as
          { processPathFromHostPath(path: string): string | undefined } | undefined
        return store && fs
          ? resolveImageAttachmentAccess(store, path => fs.processPathFromHostPath(path), ref)
          : undefined
      },
      credential: (signal, rejected) => this.credential(signal, rejected),
      compactionThreshold: (options, model) => {
        const ratio =
          options.sessionId === undefined
            ? undefined
            : this.compactionPolicies.get(options.sessionId)
        return ratio === undefined ? undefined : Math.floor(model.contextWindow * ratio)
      },
      onAuthFailure: () =>
        this.fail(new LlmError('ChatGPT 授权已失效，请重新连接', 'AUTH_REQUIRED')),
      onReplayDegrade: () => {
        ctx.logger.warn('ChatGPT 账号或模型已变化，本次只回放兼容的可见历史与工具结果。')
      },
    })
    const registration = ctx.llm.registerAdapter([PROVIDER], this.adapter)
    this.changed = () => {
      if (!this.lifetime.signal.aborted) registration.replace([PROVIDER])
    }
    ctx.authorization.registerFlow({
      key: ACCOUNT_KEY,
      label: 'ChatGPT 订阅',
      methods: [{ id: 'siwc', label: '使用 ChatGPT 订阅登录' }],
      run: async session => {
        const host = await ctx.credentials.modifyRecord(HOST_KEY, async current => {
          session.signal.throwIfAborted()
          if (
            current?.kind === 'grant' &&
            record(current.payload) &&
            typeof current.payload.hostId === 'string' &&
            /^urn:uuid:[0-9a-f-]{36}$/u.test(current.payload.hostId)
          )
            return undefined
          return { kind: 'grant', payload: { hostId: `urn:uuid:${randomUUID()}` } }
        })
        if (
          host?.kind !== 'grant' ||
          !record(host.payload) ||
          typeof host.payload.hostId !== 'string'
        )
          throw new LlmError('无法保存本机授权标识', 'AUTH_REQUIRED')
        const saved = await ctx.credentials.readRecord(ACCOUNT_KEY)
        const previous = storedGrant(saved)
        const grant = await authorize(
          session,
          host.payload.hostId,
          previous,
          pendingRegistration(saved),
          async clientId => {
            await ctx.credentials.modifyRecord(ACCOUNT_KEY, async () => {
              session.signal.throwIfAborted()
              return { kind: 'grant', payload: { kind: 'mydsh-siwc-pending', clientId } }
            })
          },
        )
        await ctx.credentials.modifyRecord(ACCOUNT_KEY, async () => {
          session.signal.throwIfAborted()
          return { kind: 'grant', payload: grant }
        })
      },
    })
    ctx.effect(() => () => {
      this.lifetime.abort()
      this.accountLifetime.abort()
      ctx.authorization.cancel(ACCOUNT_KEY)
      this.adapter.dispose()
    })
    void this.refresh(this.lifetime.signal).catch(() => undefined)
  }
  /** 仅供后台压缩插件调用，策略随调用插件卸载，不向 Remote 暴露。 */
  enableNativeCompaction(sessionId: string, thresholdRatio: number): () => Promise<void> {
    if (
      !sessionId ||
      !Number.isFinite(thresholdRatio) ||
      thresholdRatio <= 0 ||
      thresholdRatio >= 1
    ) {
      throw new LlmError('ChatGPT 原生压缩策略无效', 'INVALID_CONFIG')
    }
    return this.ctx.effect(() => {
      if (this.compactionPolicies.has(sessionId))
        throw new LlmError('此会话已启用 ChatGPT 原生压缩', 'INVALID_CONFIG')
      this.compactionPolicies.set(sessionId, thresholdRatio)
      return () => {
        this.compactionPolicies.delete(sessionId)
      }
    })
  }
  private fail(error: unknown): void {
    this.message = error instanceof LlmError ? error.message : 'ChatGPT 操作未完成，请重试'
    if (error instanceof LlmError && error.code === 'AUTH_REQUIRED') {
      this.models = []
      this.changed()
    }
  }
  private resetAccount(): void {
    this.accountLifetime.abort()
    this.accountLifetime = new AbortController()
    this.adapter.cancelRequests()
    this.models = []
    this.changed()
  }
  /** 刷新在凭据提供方的同一把锁内读、决策和替换，取消后不能复活已断开的账号。 */
  private async credential(
    signal: AbortSignal,
    rejected?: ChatGPTCredential,
  ): Promise<ChatGPTCredential | undefined> {
    const scoped = AbortSignal.any([signal, this.lifetime.signal, this.accountLifetime.signal])
    try {
      let failure: unknown
      const stored = await this.ctx.credentials.modifyRecord(ACCOUNT_KEY, async current => {
        scoped.throwIfAborted()
        const grant = storedGrant(current)
        if (!grant?.tokens || !planEnabled(grant)) return undefined
        if (rejected && rejected.accountId !== grant.accountId)
          throw new LlmError('ChatGPT 账号已变化，请重新发送', 'ACCOUNT_CHANGED')
        if (
          grant.tokens.expiresAt > Date.now() + 60_000 &&
          (!rejected || rejected.accessToken !== grant.tokens.accessToken)
        )
          return undefined
        try {
          const updated = await refreshGrant(grant, scoped)
          scoped.throwIfAborted()
          return { kind: 'grant', payload: updated }
        } catch (error) {
          if (scoped.aborted || !(error instanceof LlmError) || error.code !== 'AUTH_REQUIRED')
            throw error
          failure = error
          return { kind: 'grant', payload: withoutTokens(grant) }
        }
      })
      scoped.throwIfAborted()
      if (failure) throw failure
      const grant = storedGrant(stored)
      if (grant && !planEnabled(grant)) {
        this.models = []
        this.message = '当前账号尚未授权使用 ChatGPT 订阅'
        this.changed()
      }
      return grant?.tokens && planEnabled(grant)
        ? { accountId: grant.accountId, accessToken: grant.tokens.accessToken }
        : undefined
    } catch (error) {
      if (!scoped.aborted) this.fail(error)
      throw error
    }
  }
  @Remote
  async status(): Promise<ChatGPTStatus> {
    const saved = this.lifetime.signal.aborted
      ? undefined
      : await this.ctx.credentials.readRecord(ACCOUNT_KEY)
    const grant = storedGrant(saved),
      pending = pendingRegistration(saved)
    const connected = grant?.tokens !== undefined && planEnabled(grant)
    return {
      connected,
      registered: grant !== undefined || pending !== undefined,
      planEnabled: grant !== undefined && planEnabled(grant),
      connecting: this.connecting,
      needsPlanNotice: connected && grant?.planNoticeAcknowledged !== true,
      account: grant ? `…${grant.accountId.slice(-6)}` : null,
      authorizationUrl: this.notice.url ?? null,
      message: this.message,
      models: this.models.map(model => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        reasoningEfforts: [...model.reasoningEfforts],
      })),
    }
  }
  @Remote
  async connect(signal: AbortSignal): Promise<ChatGPTStatus> {
    if (this.connecting) throw new LlmError('ChatGPT 授权已在进行中', 'ALREADY_IN_FLIGHT')
    const scoped = AbortSignal.any([signal, this.lifetime.signal])
    scoped.throwIfAborted()
    this.connecting = true
    this.message = null
    this.notice = {}
    try {
      const outcome = await this.ctx.authorization.begin({
        key: ACCOUNT_KEY,
        signal: scoped,
        interaction: {
          notify: notice => {
            this.notice = { ...notice }
          },
          prompt: async () => {
            throw new LlmError('浏览器授权不接受密码输入', 'INVALID_REQUEST')
          },
        },
      })
      if (outcome.status === 'authorized') {
        this.resetAccount()
        await this.refresh(scoped)
      }
    } catch (error) {
      if (!scoped.aborted)
        this.message = error instanceof LlmError ? error.message : 'ChatGPT 授权未完成，请重新连接'
    } finally {
      this.connecting = false
      this.notice = {}
    }
    return this.status()
  }
  @Remote
  cancel(): boolean {
    this.ctx.authorization.cancel(ACCOUNT_KEY)
    return true
  }
  @Remote
  async acknowledgePlanUse(): Promise<ChatGPTStatus> {
    await this.ctx.credentials.modifyRecord(ACCOUNT_KEY, async current => {
      const grant = storedGrant(current)
      return grant?.tokens && planEnabled(grant)
        ? { kind: 'grant', payload: { ...grant, planNoticeAcknowledged: true } }
        : undefined
    })
    return this.status()
  }
  @Remote
  async disconnect(): Promise<ChatGPTStatus> {
    this.cancel()
    this.resetAccount()
    this.message = null
    await this.ctx.credentials.modifyRecord(ACCOUNT_KEY, async current => {
      const grant = storedGrant(current)
      if (!grant) return undefined
      try {
        await revokeGrant(
          grant,
          AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(10_000)]),
        )
      } catch {
        this.message = '本机已断开，远端授权撤销尚未确认；请在 ChatGPT 设置中检查并断开 MyDSH。'
      }
      return { kind: 'grant', payload: withoutTokens(grant) }
    })
    return this.status()
  }
  @Remote
  async forget(): Promise<ChatGPTStatus> {
    const grant = storedGrant(await this.ctx.credentials.readRecord(ACCOUNT_KEY))
    if (this.connecting || grant?.tokens)
      throw new LlmError('请先断开 ChatGPT 连接，再移除本机注册信息', 'INVALID_REQUEST')
    await this.ctx.credentials.deleteRecord(ACCOUNT_KEY)
    this.message = null
    return this.status()
  }
  @Remote
  async refresh(signal: AbortSignal): Promise<ChatGPTStatus> {
    const scoped = AbortSignal.any([signal, this.lifetime.signal, this.accountLifetime.signal])
    try {
      let credential = await this.credential(scoped)
      if (!credential) {
        this.models = []
        this.changed()
        return this.status()
      }
      const load = (value: ChatGPTCredential) =>
        request(MODELS_URL, scoped, {
          headers: {
            authorization: `Bearer ${value.accessToken}`,
          },
        })
      let response = await load(credential)
      if (response.status === 401) {
        await response.body?.cancel()
        credential = await this.credential(scoped, credential)
        if (!credential) throw new LlmError('请重新连接 ChatGPT 订阅', 'AUTH_REQUIRED')
        response = await load(credential)
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new LlmError(
          `ChatGPT 模型目录读取失败（HTTP ${response.status}）`,
          response.status === 401 ? 'AUTH_REQUIRED' : 'NETWORK',
        )
      }
      const data = await json(response),
        models: ChatGPTModel[] = []
      if (!Array.isArray(data.models))
        throw new LlmError('ChatGPT 模型目录格式无效', 'INVALID_RESPONSE')
      for (const value of data.models) {
        if (!record(value) || value.visibility !== 'list') continue
        if (Array.isArray(value.input_modalities) && !value.input_modalities.includes('text'))
          continue
        const window = value.context_window ?? value.max_context_window
        if (
          typeof value.slug !== 'string' ||
          !value.slug ||
          value.slug.length > 160 ||
          typeof window !== 'number' ||
          !Number.isSafeInteger(window) ||
          window <= 0 ||
          !Array.isArray(value.supported_reasoning_levels)
        )
          continue
        const levels = value.supported_reasoning_levels.map(level =>
          record(level) ? level.effort : undefined,
        )
        if (
          levels.some(level => typeof level !== 'string' || !level || level.length > 160) ||
          models.some(model => model.id === value.slug)
        )
          continue
        models.push({
          id: value.slug,
          name:
            typeof value.display_name === 'string' && value.display_name
              ? value.display_name
              : value.slug,
          inputModalities:
            Array.isArray(value.input_modalities) && value.input_modalities.includes('image')
              ? ['text', 'image']
              : ['text'],
          contextWindow: window,
          reasoningEfforts: [...new Set(levels as string[])],
          accountId: credential.accountId,
        })
      }
      scoped.throwIfAborted()
      this.models = models
      this.message = models.length ? null : '账号目录没有返回可用的文本模型，请稍后刷新'
      this.changed()
    } catch (error) {
      if (!scoped.aborted) this.fail(error)
      throw error
    }
    return this.status()
  }
}
