import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { constants, zstdCompress } from 'node:zlib'
import {
  attributionHeaders,
  errorChain,
  LlmAdapter,
  LlmError,
  redactErrorMessage,
  ReasoningEffortId,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {
  ContentBlock,
  GenerateOptions,
  ImageAttachmentAccessResolver,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  compactedMessages,
  MAX_RESPONSE_BYTES,
  PROVIDER,
  requestBody,
  responseFailure,
  RESPONSE_URL,
} from './protocol.ts'
import type { ChatGPTCredential, ChatGPTModel, RequestImages } from './protocol.ts'
import { json } from './auth.ts'
import { responseChunks } from './responses.ts'
const { version } = createRequire(import.meta.url)('../package.json') as { version: string }
const compress = promisify(zstdCompress)

/** 只把底层明确的临时传输错误交给重试层；证书、编码和程序错误不能反复重发。 */
function transientNetworkFailure(error: unknown): boolean {
  for (
    let cause = error, depth = 0;
    cause instanceof Error && depth < 4;
    cause = cause.cause, depth++
  ) {
    const code = (cause as NodeJS.ErrnoException).code
    if (
      code &&
      [
        'UND_ERR_SOCKET',
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_HEADERS_TIMEOUT',
        'UND_ERR_BODY_TIMEOUT',
        'ECONNRESET',
        'ECONNREFUSED',
        'EPIPE',
        'ETIMEDOUT',
        'EAI_AGAIN',
        'ENOTFOUND',
        'ENETUNREACH',
        'EHOSTUNREACH',
      ].includes(code)
    )
      return true
  }
  return false
}

export interface ChatGPTAdapterOptions {
  /** 由连接服务提供当前账号的模型能力快照。 */
  models: () => readonly ChatGPTModel[]
  credential: (
    signal: AbortSignal,
    rejected?: ChatGPTCredential,
  ) => Promise<ChatGPTCredential | undefined>
  /** 宿主可提供受控传输，隔离验收用它返回合成响应，不开放自定义端点。 */
  fetch?: typeof fetch
  attachments?: () => AttachmentStore | undefined
  imageAccess?: ImageAttachmentAccessResolver
  onReplayDegrade?: () => void
  onAuthFailure?: () => void
  /** 独立压缩插件按会话启用；辅助调用不使用自动原生压缩。 */
  compactionThreshold?: (options: GenerateOptions, model: ChatGPTModel) => number | undefined
}

export class ChatGPTAdapter extends LlmAdapter {
  private readonly requests = new Set<AbortController>()
  private disposed = false
  constructor(private readonly options: ChatGPTAdapterOptions) {
    super()
  }

  override providerInfo() {
    return { id: PROVIDER, name: 'ChatGPT 订阅' }
  }
  override providerRetryPolicy() {
    // 仅恢复临时服务／传输失败；限额、资格和权限拒绝交还用户处理。
    return resolveRetryPolicy(
      {
        mode: 'normal',
        maxRetries: 5,
        retryableCodes: [
          'SERVER',
          'TRANSPORT',
          'NETWORK',
          'STREAM_CLOSED',
          'TIMEOUT',
          'server_is_overloaded',
          'server_error',
          'internal_error',
          'subscription_sharing_usage_unavailable',
          'subscription_sharing_user_unavailable',
        ],
        backoff: { initialDelayMs: 1000, maxDelayMs: 30_000 },
      },
      'chatgpt-subscription.retryPolicy',
    )
  }
  override async listModels() {
    return this.options.models().map(model => ({
      provider: PROVIDER,
      id: model.id,
      name: model.name,
      inputModalities: model.inputModalities ?? (['text'] as const),
    }))
  }
  private model(provider: string, id: string): ChatGPTModel {
    if (this.disposed) throw new LlmError('ChatGPT 提供商已停止', 'DISPOSED')
    if (provider !== PROVIDER) throw new LlmError('ChatGPT 提供方路由不匹配', 'NO_ADAPTER')
    const model = this.options.models().find(item => item.id === id)
    if (!model) throw new LlmError('ChatGPT 模型能力尚未加载', 'UNKNOWN_MODEL')
    if (
      !model.id ||
      !model.name ||
      !Number.isSafeInteger(model.contextWindow) ||
      model.contextWindow <= 0 ||
      !Array.isArray(model.reasoningEfforts) ||
      model.reasoningEfforts.some(
        level => typeof level !== 'string' || !level || level.length > 160,
      ) ||
      (model.inputModalities !== undefined &&
        (!Array.isArray(model.inputModalities) ||
          !model.inputModalities.includes('text') ||
          model.inputModalities.some(value => value !== 'text' && value !== 'image'))) ||
      new Set(model.reasoningEfforts).size !== model.reasoningEfforts.length
    )
      throw new LlmError('ChatGPT 模型能力无效', 'INVALID_CONFIG')
    return {
      ...model,
      reasoningEfforts: [...model.reasoningEfforts],
      inputModalities: [...(model.inputModalities ?? ['text'])],
    }
  }
  private info(model: ChatGPTModel): LlmResolvedModelInfo {
    return {
      provider: PROVIDER,
      id: model.id,
      name: model.name,
      inputModalities: [...(model.inputModalities ?? ['text'])],
      context: { contextWindow: model.contextWindow },
      ...(model.reasoningEfforts.length === 0
        ? {}
        : {
            reasoning: {
              efforts: model.reasoningEfforts.map(effort => ({
                id: ReasoningEffortId(effort),
                name: effort === 'none' ? '关闭推理' : effort,
              })),
            },
          }),
    }
  }
  override async resolveModel(provider: string, id: string) {
    return this.info(this.model(provider, id))
  }
  override async prepareCall(provider: string, id: string): Promise<PreparedAdapterCall> {
    const model = this.model(provider, id)
    return { model: this.info(model), stream: options => this.streamModel(options, model) }
  }
  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamModel(options, this.model(options.provider, options.model))
  }
  dispose(): void {
    this.disposed = true
    this.cancelRequests()
  }
  cancelRequests(): void {
    for (const request of this.requests) request.abort()
    this.requests.clear()
  }
  private async prepareImages(
    options: GenerateOptions,
    model: ChatGPTModel,
    signal: AbortSignal,
  ): Promise<RequestImages> {
    const refs: ImageAttachmentRef[] = []
    const visit = (blocks: readonly ContentBlock[]) => {
      for (const block of blocks) {
        if (block.type === 'image' && block.offloaded !== true) refs.push(block.attachment)
        else if (block.type === 'tool-result') visit(block.content)
      }
    }
    for (const message of options.messages) {
      const before = refs.length
      visit(message.content)
      if (refs.length !== before && message.role !== 'user')
        throw new LlmError('ChatGPT 图片只能出现在用户消息或工具返回中', 'UNSUPPORTED_CONTENT')
    }
    if (refs.length && !model.inputModalities?.includes('image'))
      throw new LlmError('当前 ChatGPT 模型未声明图片输入能力', 'UNSUPPORTED_CONTENT')
    // 按线上每次出现计算请求字节，避免历史中反复引用同一图片绕过大小限制。
    const bytes = refs.reduce((sum, ref) => sum + 4 * Math.ceil(ref.bytes / 3), 0)
    if (!Number.isSafeInteger(bytes) || bytes > MAX_RESPONSE_BYTES)
      throw new LlmError('图片总量超过单次请求限制，请缩小图片或压缩历史', 'REQUEST_TOO_LARGE')
    const verifiedRefs = new Map<string, ImageAttachmentRef>()
    const urls = new Map<string, string>(),
      store = this.options.attachments?.()
    if (refs.length && !store) throw new LlmError('图片附件服务不可用', 'INVALID_ATTACHMENT')
    for (const ref of refs) {
      signal.throwIfAborted()
      const verified = verifiedRefs.get(ref.attachmentId)
      if (verified) {
        if (
          verified.bytes !== ref.bytes ||
          verified.width !== ref.width ||
          verified.height !== ref.height ||
          verified.mediaType !== ref.mediaType
        ) {
          throw new LlmError('同一图片的附件元数据不一致，请重新添加图片', 'INVALID_ATTACHMENT')
        }
        continue
      }
      try {
        // 附件服务复核摘要和尺寸；顺序读取使当前请求的额外内存保持有界。
        // oxlint-disable-next-line no-await-in-loop
        const image = await store!.readImage(ref, signal)
        signal.throwIfAborted()
        verifiedRefs.set(ref.attachmentId, image.ref)
        urls.set(
          ref.attachmentId,
          `data:${image.ref.mediaType};base64,${Buffer.from(image.data).toString('base64')}`,
        )
      } catch {
        signal.throwIfAborted()
        throw new LlmError('图片附件缺失或校验失败，请重新添加图片', 'INVALID_ATTACHMENT')
      }
    }
    return {
      urls,
      ...(this.options.imageAccess === undefined ? {} : { access: this.options.imageAccess }),
    }
  }
  private async *streamModel(
    options: GenerateOptions,
    model: ChatGPTModel,
  ): AsyncGenerator<StreamChunk> {
    if (this.disposed) throw new LlmError('ChatGPT 提供商已停止', 'DISPOSED')
    if (options.provider !== PROVIDER || options.model !== model.id)
      throw new LlmError('ChatGPT 调用与能力快照不匹配', 'INVALID_CONFIG')
    const controller = new AbortController()
    this.requests.add(controller)
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal
    let timer: ReturnType<typeof setTimeout> | undefined
    let nativeCompaction = false
    let phase: 'prepare' | 'headers' | 'stream' = 'prepare'
    const requestTokens: string[] = []
    const activity = () => {
      clearTimeout(timer)
      timer = setTimeout(
        () =>
          controller.abort(
            new LlmError(
              phase === 'stream' ? 'ChatGPT 接收响应超时' : 'ChatGPT 发送请求或等待响应超时',
              'TIMEOUT',
            ),
          ),
        300_000,
      )
      timer.unref()
    }
    activity()
    try {
      signal.throwIfAborted()
      let credential = await this.options.credential(signal)
      signal.throwIfAborted()
      if (!credential) throw new LlmError('请先连接 ChatGPT 订阅', 'MISSING_CREDENTIAL')
      if (
        typeof credential.accountId !== 'string' ||
        !credential.accountId ||
        /[\r\n]/u.test(credential.accountId) ||
        typeof credential.accessToken !== 'string' ||
        !credential.accessToken ||
        /[\r\n]/u.test(credential.accessToken)
      ) {
        throw new LlmError('ChatGPT 授权记录无效，请重新连接', 'INVALID_CREDENTIAL')
      }
      requestTokens.push(credential.accessToken)
      if (model.accountId && credential.accountId !== model.accountId)
        throw new LlmError('ChatGPT 账号已变化，请重新选择模型', 'ACCOUNT_CHANGED')
      const prepared = {
        ...options,
        messages: compactedMessages(options.messages, model.id, credential.accountId),
      }
      const images = await this.prepareImages(prepared, model, signal)
      signal.throwIfAborted()
      let degraded = false
      const payload = requestBody(
        prepared,
        model,
        credential.accountId,
        () => {
          degraded = true
        },
        images,
      )
      const threshold =
        options.purpose === undefined
          ? this.options.compactionThreshold?.(options, model)
          : undefined
      if (threshold !== undefined) {
        if (
          !Number.isSafeInteger(threshold) ||
          threshold <= 0 ||
          threshold >= model.contextWindow
        ) {
          throw new LlmError('ChatGPT 原生压缩阈值无效', 'INVALID_CONFIG')
        }
        payload.context_management = [{ type: 'compaction', compact_threshold: threshold }]
        nativeCompaction = true
      }
      const jsonBody = JSON.stringify(payload)
      if (degraded) this.options.onReplayDegrade?.()
      if (Buffer.byteLength(jsonBody) > MAX_RESPONSE_BYTES)
        throw new LlmError('ChatGPT 请求超过大小限制', 'REQUEST_TOO_LARGE')
      // 先检查原始大小，再压缩传输；401 刷新沿用同一份字节，不改变模型输入和历史。
      const body = new Uint8Array(
        await compress(jsonBody, { params: { [constants.ZSTD_c_compressionLevel]: 3 } }),
      )
      signal.throwIfAborted()
      const send = (current: ChatGPTCredential) =>
        (this.options.fetch ?? fetch)(RESPONSE_URL, {
          method: 'POST',
          redirect: 'error',
          signal,
          body,
          headers: {
            ...attributionHeaders({
              product: 'mydsh-chatgpt',
              version,
              url: 'https://github.com/Viviana-Luna/MyDeepSeekHarness',
            }),
            authorization: `Bearer ${current.accessToken}`,
            originator: 'mydsh',
            'content-type': 'application/json',
            'content-encoding': 'zstd',
            accept: 'text/event-stream',
          },
        })
      phase = 'headers'
      let response = await send(credential)
      if (response.status === 401) {
        await response.body?.cancel()
        const refreshed = await this.options.credential(signal, credential)
        if (!refreshed || refreshed.accountId !== credential.accountId)
          throw new LlmError('ChatGPT 授权已失效或账号已变化，请重新连接', 'AUTH_REQUIRED')
        credential = refreshed
        requestTokens.push(credential.accessToken)
        response = await send(credential)
      }
      if (signal.aborted) {
        await response.body?.cancel()
        signal.throwIfAborted()
      }
      if (!response.ok) {
        if (response.status === 401) this.options.onAuthFailure?.()
        const data = await json(response).catch(() => ({}) as Record<string, unknown>)
        const after = response.headers.get('retry-after')
        const delay =
          after === null
            ? undefined
            : /^\d+(?:\.\d+)?$/u.test(after)
              ? Number(after) * 1000
              : Date.parse(after) - Date.now()
        throw responseFailure(
          data.error ?? data,
          response.status,
          response.headers.get('openai-request-id') ?? response.headers.get('x-request-id'),
          delay !== undefined && Number.isFinite(delay) && delay > 0 ? Math.ceil(delay) : undefined,
        )
      }
      const contentType = response.headers.get('content-type')
      // 实测订阅响应可能省略 Content-Type；仍由事件解析器校验内容及完成事件。
      if (!response.body || (contentType !== null && !contentType.includes('text/event-stream'))) {
        await response.body?.cancel()
        throw new LlmError('ChatGPT 未返回事件流', 'INVALID_RESPONSE')
      }
      phase = 'stream'
      yield* responseChunks(
        response.body,
        signal,
        activity,
        credential.accountId,
        model.id,
        Array.isArray(payload.input) && payload.input.some(item => item.type === 'compaction'),
      )
    } catch (error) {
      if (signal.aborted) {
        if (controller.signal.reason instanceof LlmError) throw controller.signal.reason
        throw new LlmError('ChatGPT 请求已取消', 'ABORTED')
      }
      if (error instanceof LlmError) {
        if (nativeCompaction && error.code === 'CONTEXT_WINDOW_EXCEEDED') {
          throw new LlmError(
            `服务端在原生压缩完成前拒绝了超长输入，已停止请求。原会话和工具结果已保留；请新建会话并明确携带必要上下文，当前订阅不支持独立的手动压缩\n${redactErrorMessage(errorChain(error), requestTokens)}`,
            'NATIVE_COMPACTION_CONTEXT_EXCEEDED',
            error.failure,
          )
        }
        throw new LlmError(
          redactErrorMessage(errorChain(error), requestTokens),
          error.code,
          error.failure,
        )
      }
      const stage =
        phase === 'stream'
          ? '接收响应中断'
          : phase === 'headers'
            ? '发送请求或等待响应失败'
            : '准备请求失败'
      throw new LlmError(
        `ChatGPT ${stage}：${redactErrorMessage(errorChain(error), requestTokens)}`,
        phase !== 'prepare' && transientNetworkFailure(error) ? 'NETWORK' : 'REQUEST_FAILED',
      )
    } finally {
      clearTimeout(timer)
      controller.abort()
      this.requests.delete(controller)
    }
  }
}
