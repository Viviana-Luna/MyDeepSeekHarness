import {
  LlmError,
  ToolCallId,
  ProviderRequestId,
  contentHasImage,
  offloadedImageText,
  requestImageHandleText,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  ImageAttachmentAccessResolver,
  Message,
  ReplayEnvelope,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'

export const PROVIDER = 'chatgpt-subscription'
export const RESPONSE_URL = 'https://api.openai.com/v1/responses'
export const TOOL_NAMESPACE = 'mydsh'
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024
export interface ChatGPTModel {
  accountId?: string
  id: string
  name: string
  contextWindow: number
  reasoningEfforts: readonly string[]
  inputModalities?: readonly ('text' | 'image')[]
}
export interface ChatGPTCredential {
  accountId: string
  accessToken: string
}
export type RecordValue = Record<string, unknown>
export function record(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
export function invalid(message: string): never {
  throw new LlmError(message, 'INVALID_RESPONSE')
}
export function text(value: unknown): string {
  return typeof value === 'string' ? value : invalid('ChatGPT 返回了无效的文本字段')
}
function identifier(value: unknown): string {
  const id = text(value)
  return id.length > 0 && id.length <= 512 ? id : invalid('ChatGPT 返回了无效的条目标识')
}

type ReplayBlock =
  | {
      type: 'message'
      id: string
      phase?: 'commentary' | 'final_answer'
      parts: { type: 'output_text' | 'refusal'; length: number }[]
    }
  | { type: 'reasoning'; id: string; encrypted_content?: string; lengths: number[] }
  | { type: 'function_call'; id: string }
interface NativeCompaction {
  type: 'compaction'
  id: string
  encrypted_content: string
}
interface ReplayCompaction {
  before: number
  item: NativeCompaction
}
interface ReplayResponse {
  kind: 'mydsh-chatgpt'
  version: 1
  accountId: string
  model: string
  compactions?: ReplayCompaction[]
}
export function replayEnvelope(
  accountId: string,
  model: string,
  items: ReturnType<typeof completedItem>[],
): ReplayEnvelope {
  const blocks: ReplayBlock[] = [],
    compactions: ReplayCompaction[] = []
  for (const item of items) {
    if (item.block === null) compactions.push({ before: blocks.length, item: item.replay })
    else blocks.push(item.replay)
  }
  return {
    response: {
      kind: 'mydsh-chatgpt',
      version: 1,
      accountId,
      model,
      ...(compactions.length ? { compactions } : {}),
    } satisfies ReplayResponse,
    blocks,
  }
}

/** 原生正文仅存于通用消息；私有元数据记录拆分位置、标识、阶段和密文。 */
export function completedItem(
  item: RecordValue,
): { block: ContentBlock; replay: ReplayBlock } | { block: null; replay: NativeCompaction } {
  const id = identifier(item.id)
  if (item.type === 'compaction') {
    const encrypted = text(item.encrypted_content)
    if (!encrypted) invalid('ChatGPT 原生压缩结果缺少加密内容')
    return { block: null, replay: { type: 'compaction', id, encrypted_content: encrypted } }
  }
  if (item.type === 'message') {
    if (item.role !== 'assistant' || !Array.isArray(item.content)) invalid('ChatGPT 消息结构无效')
    const parts = item.content.map(
      (part: unknown): { type: 'output_text' | 'refusal'; value: string } => {
        if (!record(part) || (part.type !== 'output_text' && part.type !== 'refusal'))
          invalid('ChatGPT 返回了尚未支持的消息内容')
        return { type: part.type, value: text(part.type === 'refusal' ? part.refusal : part.text) }
      },
    )
    if (item.phase !== undefined && item.phase !== 'commentary' && item.phase !== 'final_answer')
      invalid('ChatGPT 消息阶段无效')
    return {
      block: { type: 'text', text: parts.map(part => part.value).join('') },
      replay: {
        type: 'message',
        id,
        ...(item.phase === undefined ? {} : { phase: item.phase }),
        parts: parts.map(part => ({ type: part.type, length: part.value.length })),
      },
    }
  }
  if (item.type === 'reasoning') {
    if (!Array.isArray(item.summary)) invalid('ChatGPT 推理摘要结构无效')
    const summaries = item.summary.map((part: unknown) => {
      if (!record(part) || part.type !== 'summary_text') invalid('ChatGPT 推理摘要类型无效')
      return text(part.text)
    })
    return {
      block: { type: 'reasoning', text: summaries.join('') },
      replay: {
        type: 'reasoning',
        id,
        lengths: summaries.map(value => value.length),
        ...(item.encrypted_content == null
          ? {}
          : { encrypted_content: text(item.encrypted_content) }),
      },
    }
  }
  if (item.type === 'function_call') {
    if (item.namespace !== TOOL_NAMESPACE) invalid('ChatGPT 工具命名空间不匹配')
    const args = text(item.arguments)
    let parsed: unknown
    try {
      parsed = JSON.parse(args)
    } catch {
      invalid('ChatGPT 工具参数不是完整 JSON')
    }
    if (!record(parsed)) invalid('ChatGPT 工具参数必须是对象')
    return {
      block: {
        type: 'tool-call',
        id: ToolCallId(identifier(item.call_id)),
        name: identifier(item.name),
        arguments: args,
      },
      replay: { type: 'function_call', id },
    }
  }
  return invalid('ChatGPT 返回了尚未支持的输出条目')
}

function split(value: string, lengths: unknown): string[] {
  if (
    !Array.isArray(lengths) ||
    !lengths.every(size => Number.isSafeInteger(size) && size >= 0) ||
    lengths.reduce((sum: number, size: number) => sum + size, 0) !== value.length
  )
    invalid('ChatGPT 回放内容与元数据不匹配')
  let offset = 0
  return lengths.map((size: number) => {
    const part = value.slice(offset, offset + size)
    offset += size
    return part
  })
}
function replayItem(block: ContentBlock, metadata: unknown): RecordValue {
  if (!record(metadata)) invalid('ChatGPT 回放元数据无效')
  const id = identifier(metadata.id)
  if (block.type === 'text' && metadata.type === 'message') {
    if (!Array.isArray(metadata.parts)) invalid('ChatGPT 回放文本分段无效')
    const types = metadata.parts.map((part: unknown) => {
      if (!record(part) || !['output_text', 'refusal'].includes(String(part.type)))
        invalid('ChatGPT 回放文本类型无效')
      return part
    })
    const values = split(
      block.text,
      types.map(part => part.length),
    )
    if (
      metadata.phase !== undefined &&
      metadata.phase !== 'commentary' &&
      metadata.phase !== 'final_answer'
    )
      invalid('ChatGPT 回放阶段无效')
    return {
      type: 'message',
      id,
      role: 'assistant',
      status: 'completed',
      ...(metadata.phase === undefined ? {} : { phase: metadata.phase }),
      content: types.map((part, index) =>
        part.type === 'refusal'
          ? { type: 'refusal', refusal: values[index] }
          : { type: 'output_text', text: values[index], annotations: [] },
      ),
    }
  }
  if (block.type === 'reasoning' && metadata.type === 'reasoning')
    return {
      type: 'reasoning',
      id,
      summary: split(block.text, metadata.lengths).map(value => ({
        type: 'summary_text',
        text: value,
      })),
      ...(metadata.encrypted_content === undefined
        ? {}
        : { encrypted_content: text(metadata.encrypted_content) }),
    }
  if (block.type === 'tool-call' && metadata.type === 'function_call')
    return {
      type: 'function_call',
      namespace: TOOL_NAMESPACE,
      id,
      call_id: block.id,
      name: block.name,
      arguments: block.arguments,
    }
  return invalid('ChatGPT 回放块类型不匹配')
}

function plainText(blocks: readonly ContentBlock[]): string {
  return blocks
    .map(block => {
      if (block.type === 'text') return block.text
      throw new LlmError('ChatGPT 的系统指令只接收文本', 'UNSUPPORTED_CONTENT')
    })
    .join('')
}
/** 二进制只在当前请求中展开，持久消息仍只保存附件引用。 */
export interface RequestImages {
  urls: ReadonlyMap<string, string>
  access?: ImageAttachmentAccessResolver
}
function inputParts(blocks: readonly ContentBlock[], images?: RequestImages): RecordValue[] {
  return blocks.flatMap((block): RecordValue[] => {
    if (block.type === 'text') return [{ type: 'input_text', text: block.text }]
    if (block.type !== 'image')
      throw new LlmError('ChatGPT 不支持此输入内容', 'UNSUPPORTED_CONTENT')
    const ref = block.attachment,
      access = images?.access?.(ref)
    if (block.offloaded === true)
      return [{ type: 'input_text', text: offloadedImageText(ref, access) }]
    const url = images?.urls.get(ref.attachmentId)
    if (!url) throw new LlmError('ChatGPT 图片附件未准备完成，请重新添加图片', 'INVALID_ATTACHMENT')
    return [
      { type: 'input_text', text: requestImageHandleText(ref, ref, access) },
      { type: 'input_image', image_url: url, detail: 'auto' },
    ]
  })
}

function assistantItems(
  message: Message,
  model: string,
  accountId: string,
  onReplayDegrade?: () => void,
): RecordValue[] {
  const state = message.source.kind === 'model' ? message.source.replayState : undefined
  if (
    state !== undefined &&
    message.source.kind === 'model' &&
    message.source.provider === PROVIDER
  ) {
    if (
      !record(state) ||
      !record(state.response) ||
      state.response.kind !== 'mydsh-chatgpt' ||
      state.response.version !== 1 ||
      state.response.model !== message.source.model ||
      !Array.isArray(state.blocks) ||
      state.blocks.length !== message.content.length
    )
      invalid('ChatGPT 私有回放格式无效')
    if (state.response.accountId === accountId && state.response.model === model) {
      const items = message.content.map((block, index) =>
        replayItem(block, (state.blocks as unknown[])[index]),
      )
      if (state.response.compactions === undefined) return items
      if (!Array.isArray(state.response.compactions)) invalid('ChatGPT 原生压缩回放格式无效')
      let previous = -1,
        inserted = 0
      for (const entry of state.response.compactions) {
        if (
          !record(entry) ||
          typeof entry.before !== 'number' ||
          !Number.isSafeInteger(entry.before) ||
          entry.before < 0 ||
          entry.before < previous ||
          entry.before > message.content.length ||
          !record(entry.item) ||
          entry.item.type !== 'compaction'
        )
          invalid('ChatGPT 原生压缩回放位置无效')
        const item = completedItem(entry.item)
        if (item.block !== null) invalid('ChatGPT 原生压缩回放条目无效')
        items.splice(entry.before + inserted, 0, { ...item.replay })
        previous = entry.before
        inserted += 1
      }
      return items
    }
    // 账号或模型变化时仅保留可见内容与工具历史，不把旧密文发送给新目标。
    onReplayDegrade?.()
  }
  return message.content.flatMap((block): RecordValue[] => {
    if (block.type === 'reasoning') return []
    if (block.type === 'text')
      return [{ role: 'assistant', content: [{ type: 'output_text', text: block.text }] }]
    if (block.type === 'tool-call')
      return [
        {
          type: 'function_call',
          namespace: TOOL_NAMESPACE,
          call_id: block.id,
          name: block.name,
          arguments: block.arguments,
        },
      ]
    throw new LlmError('ChatGPT 不支持该历史消息类型', 'UNSUPPORTED_CONTENT')
  })
}

/** 旧日志完整保留；同账号同模型请求只准备最后一次原生压缩之后仍需发送的附件。 */
export function compactedMessages(
  messages: readonly Message[],
  model: string,
  accountId: string,
): Message[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!,
      source = message.source
    if (message.role !== 'assistant' || source.kind !== 'model' || source.provider !== PROVIDER)
      continue
    const state = source.replayState
    if (
      !record(state) ||
      !record(state.response) ||
      state.response.accountId !== accountId ||
      state.response.model !== model ||
      !Array.isArray(state.response.compactions) ||
      !state.response.compactions.length
    )
      continue
    // 在丢弃任何请求前缀前，完整核对该消息的正文与私有元数据。
    assistantItems(message, model, accountId)
    return [
      ...(index > 0 && messages[0]?.role === 'system' ? [messages[0]] : []),
      ...messages.slice(index),
    ]
  }
  return [...messages]
}

export function requestBody(
  options: GenerateOptions,
  model: ChatGPTModel,
  accountId: string,
  onReplayDegrade?: () => void,
  images?: RequestImages,
): RecordValue {
  if (
    options.stop !== undefined ||
    options.temperature !== undefined ||
    options.maxTokens !== undefined
  ) {
    throw new LlmError(
      '本阶段未开放订阅端点的 stop、temperature 或 maxTokens 参数',
      'UNSUPPORTED_OPTION',
    )
  }
  if (
    options.reasoningEffort !== undefined &&
    !model.reasoningEfforts.includes(options.reasoningEffort)
  ) {
    throw new LlmError('当前 ChatGPT 模型不支持所选推理档位', 'UNSUPPORTED_REASONING_EFFORT')
  }
  let instructions = options.system ?? ''
  const input: RecordValue[] = []
  for (const [index, message] of options.messages.entries()) {
    if (message.role === 'assistant') {
      input.push(...assistantItems(message, model.id, accountId, onReplayDegrade))
      continue
    }
    if (message.role === 'system') {
      const value = plainText(message.content)
      if (index === 0 && options.system === undefined) instructions = value
      else input.push({ role: 'developer', content: [{ type: 'input_text', text: value }] })
      continue
    }
    // 同一消息里的文字与图片保持相邻；工具返回保留原 call_id 与内容顺序。
    let parts: RecordValue[] = []
    const flush = () => {
      if (parts.length) {
        input.push({ role: 'user', content: parts })
        parts = []
      }
    }
    for (const block of message.content) {
      if (block.type === 'tool-result') {
        flush()
        input.push({
          type: 'function_call_output',
          call_id: block.toolCallId,
          output: contentHasImage(block.content)
            ? inputParts(block.content, images)
            : plainText(block.content),
        })
      } else parts.push(...inputParts([block], images))
    }
    flush()
  }
  // 服务端压缩条目携带此前状态，后续输入保留该条目及其后所有输出和新消息。
  const compactIndex = input.findLastIndex(item => item.type === 'compaction')
  if (compactIndex >= 0) input.splice(0, compactIndex)
  return {
    model: model.id,
    instructions,
    input,
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
    parallel_tool_calls: true,
    tool_choice: 'auto',
    ...(options.tools?.length
      ? {
          tools: [
            {
              type: 'namespace',
              name: TOOL_NAMESPACE,
              description: 'MyDSH 当前任务可用的工具',
              tools: options.tools.map(tool => ({ type: 'function', ...tool, strict: false })),
            },
          ],
        }
      : {}),
    ...(options.reasoningEffort === undefined
      ? {}
      : { reasoning: { effort: options.reasoningEffort, summary: 'auto' } }),
    ...(options.sessionId === undefined ? {} : { prompt_cache_key: String(options.sessionId) }),
  }
}

/** 服务用量中的缓存是输入子集，推理是输出子集；缺失细分保持缺失。 */
export function tokenUsage(value: unknown): TokenUsage | undefined {
  if (value == null) return undefined
  if (!record(value)) invalid('ChatGPT 用量结构无效')
  const count = (number: unknown): number =>
    typeof number === 'number' && Number.isSafeInteger(number) && number >= 0
      ? number
      : invalid('ChatGPT 用量计数无效')
  const input = count(value.input_tokens),
    output = count(value.output_tokens)
  const details = record(value.input_tokens_details) ? value.input_tokens_details : {}
  const read = details.cached_tokens === undefined ? undefined : count(details.cached_tokens)
  const write =
    details.cache_write_tokens === undefined ? undefined : count(details.cache_write_tokens)
  const reasoning =
    record(value.output_tokens_details) &&
    value.output_tokens_details.reasoning_tokens !== undefined
      ? count(value.output_tokens_details.reasoning_tokens)
      : undefined
  if ((read ?? 0) + (write ?? 0) > input || (reasoning ?? 0) > output)
    invalid('ChatGPT 用量细分超过总量')
  const total = value.total_tokens === undefined ? input + output : count(value.total_tokens)
  if (!Number.isSafeInteger(total) || total !== input + output) invalid('ChatGPT 用量总数不一致')
  return {
    inputTokens: input - (read ?? 0) - (write ?? 0),
    outputTokens: output,
    totalTokens: total,
    ...(read === undefined ? {} : { cacheReadTokens: read }),
    ...(write === undefined ? {} : { cacheWriteTokens: write }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  }
}

/** 保留提供商正文及机器错误码；凭据在适配器出口脱敏。 */
export function responseFailure(
  value: unknown,
  status?: number,
  requestId?: string | null,
  retryAfterMs?: number,
): LlmError {
  const detail = record(value) ? value : {}
  const code =
    typeof detail.code === 'string' && /^[a-zA-Z0-9_]{1,160}$/u.test(detail.code)
      ? detail.code
      : status === 401
        ? 'AUTH_REQUIRED'
        : status === 429
          ? 'RATE_LIMIT'
          : status !== undefined && status >= 500
            ? 'SERVER'
            : 'INVALID_RESPONSE'
  const messages: Record<string, string> = {
    server_is_overloaded: 'ChatGPT 服务端暂时过载，请稍后继续；这不是参数或上下文超限错误',
    subscription_sharing_usage_limit_exceeded:
      'ChatGPT 订阅用量达到限制，请到 ChatGPT 设置查看用量后再试',
    subscription_sharing_user_not_eligible: '当前账号或工作区不符合订阅接入条件',
    subscription_sharing_usage_unavailable: '暂时无法核对 ChatGPT 订阅用量，请稍后重试',
    subscription_sharing_user_unavailable: 'ChatGPT 账号或工作区暂不可用，请稍后重试',
    subscription_sharing_unsupported_capability: '当前订阅接入不支持请求中的某项能力',
    subscription_sharing_route_not_supported: '当前订阅授权不支持此调用端点',
    subscription_sharing_invalid_user: 'ChatGPT 订阅身份无法核对，请检查账号授权',
    chatpass_v2_scope_not_authorized: '当前 ChatGPT 授权未允许此操作',
    chatpass_v2_invalid_authorization_context: 'ChatGPT 授权上下文无效，请检查账号授权',
    AUTH_REQUIRED: 'ChatGPT 授权未被接受，请重新连接',
    RATE_LIMIT: 'ChatGPT 请求受到限流，请查看用量后再试',
  }
  const param =
    typeof detail.param === 'string' && /^[\w.[\]-]{1,160}$/u.test(detail.param)
      ? `；参数 ${detail.param}`
      : ''
  const wait =
    retryAfterMs === undefined ? '' : `；服务端要求至少等待 ${Math.ceil(retryAfterMs / 1000)} 秒`
  const message =
    typeof detail.message === 'string' ? detail.message : typeof value === 'string' ? value : ''
  return new LlmError(
    `${messages[code] ?? 'ChatGPT 请求未完成'}（${code}${status === undefined ? '' : `，HTTP ${status}`}${param}）${wait}${message.trim() ? `\n${message}` : ''}`,
    code === 'context_length_exceeded' ? 'CONTEXT_WINDOW_EXCEEDED' : code,
    {
      ...(status === undefined ? {} : { status }),
      ...(retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs }),
      ...(requestId && /^[\w-]{1,200}$/u.test(requestId)
        ? { requestId: ProviderRequestId(requestId) }
        : {}),
    },
  )
}
