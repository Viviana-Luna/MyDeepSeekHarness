/**
 * 模型设置辅助工具：提供品牌识别元数据、API 协议友好文案、思考程度契约与容量格式化。
 * 运行在 renderer；仅包含无副作用的纯转换函数，不持有外部资源。
 */
import { isRecord } from '../../../../shared/validation.ts'
import type { ModelSelection } from '../../domain/session-controls.ts'
import {
  valueAtPath,
  type CredentialState,
  type HostModelProvider,
  type HostSettingsNamespace,
} from './settings-model.ts'

/** 受官方矢量标志支持的提供商标识。 */
export type ProviderBrandKey =
  | 'deepseek'
  | 'google'
  | 'gemini'
  | 'vertexai'
  | 'openai'
  | 'anthropic'
  | 'claude'
  | 'zhipu'
  | 'zai'
  | 'qwen'
  | 'moonshot'
  | 'kimi'
  | 'minimax'
  | 'xai'
  | 'mistral'
  | 'openrouter'
  | 'ollama'
  | 'volcengine'
  | 'azure'
  | 'bedrock'
  | 'cloudflare'
  | 'fireworks'
  | 'githubcopilot'
  | 'groq'
  | 'huggingface'
  | 'meta'
  | 'nvidia'
  | 'together'
  | 'vercel'
  | 'cerebras'
  | 'baseten'
  | 'xiaomi'
  | 'ling'
  | 'opencode'
  | 'typesafe'
  | 'siliconcloud'
  | 'perplexity'
  | 'cohere'
  | 'stepfun'
  | 'baichuan'
  | 'hunyuan'
  | 'spark'
  | 'wenxin'
  | 'yi'
  | 'custom'

/** 提供商视觉品牌元数据。 */
export interface ProviderBrandMeta {
  readonly key: ProviderBrandKey
  readonly label: string
}

/** 凭据状态胶囊的视觉语义与展示文案。 */
export interface CredentialBadgeMeta {
  readonly state: 'positive' | 'neutral'
  readonly label: string
  readonly storageLabel: string
  readonly helperText: string
}

/** `llm-pi-ai` 支持的思考档位枚举值，按由低到高顺序排列。 */
export type ThinkingLevelKey = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** 思考档位展示选项定义。 */
export interface ThinkingLevelOption {
  readonly key: ThinkingLevelKey
  readonly label: string
  readonly shortLabel: string
}

/** 思考档位有序清单，与 `packages/llm/llm-pi-ai/src/catalog.ts` 的 `THINKING_LEVELS` 保持一致。 */
export const THINKING_LEVEL_OPTIONS: readonly ThinkingLevelOption[] = [
  { key: 'off', label: '关闭', shortLabel: '关闭' },
  { key: 'minimal', label: '极低', shortLabel: '极低' },
  { key: 'low', label: '低', shortLabel: '低' },
  { key: 'medium', label: '中', shortLabel: '中' },
  { key: 'high', label: '高', shortLabel: '高' },
  { key: 'xhigh', label: '极高', shortLabel: '极高' },
  { key: 'max', label: '最高', shortLabel: '最高' },
]

/** 首次开启自定义思考档位时的默认预选档位。 */
export const DEFAULT_CUSTOM_THINKING_LEVELS: readonly ThinkingLevelKey[] = ['low', 'medium', 'high']

/** 思考参数格式选项，与 `packages/llm/llm-pi-ai/src/catalog.ts` 的 `SUPPORTED_THINKING_FORMATS` 对齐。 */
export const THINKING_FORMAT_OPTIONS: readonly {
  readonly value: string
  readonly label: string
}[] = [
  { value: 'openai', label: 'OpenAI（openai）' },
  { value: 'deepseek', label: 'DeepSeek（deepseek）' },
  { value: 'zai', label: '智谱 ZAI（zai）' },
  { value: 'qwen', label: '通义 Qwen（qwen）' },
  { value: 'openrouter', label: 'OpenRouter（openrouter）' },
  { value: 'together', label: 'Together（together）' },
  { value: 'baseten', label: 'Baseten（baseten）' },
  { value: 'chat-template', label: 'Chat Template（chat-template）' },
  { value: 'qwen-chat-template', label: 'Qwen Chat Template（qwen-chat-template）' },
  { value: 'string-thinking', label: 'String Thinking（string-thinking）' },
  { value: 'ant-ling', label: 'Ant Ling（ant-ling）' },
]

const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVEL_OPTIONS.map(item => item.key))
const THINKING_LEVEL_LABEL = new Map<string, string>(
  THINKING_LEVEL_OPTIONS.map(item => [item.key, item.shortLabel]),
)

const PROTOCOL_LABELS: Readonly<Record<string, string>> = {
  'openai-completions': 'OpenAI 兼容对话',
  'openai-responses': 'OpenAI Responses',
  'google-generative-ai': 'Google Gemini',
  'anthropic-messages': 'Anthropic Messages',
  'azure-openai-responses': 'Azure OpenAI Responses',
  'bedrock-converse-stream': 'AWS Bedrock Converse',
  'mistral-conversations': 'Mistral Conversations',
  'chat-completions': 'Chat Completions',
  messages: 'Anthropic Messages',
}

const BRAND_RULES: readonly {
  readonly pattern: RegExp
  readonly meta: ProviderBrandMeta
}[] = [
  { pattern: /deepseek/iu, meta: { key: 'deepseek', label: 'DeepSeek' } },
  {
    pattern: /azure|openai\.azure\.com/iu,
    meta: { key: 'azure', label: 'Azure' },
  },
  {
    pattern: /bedrock|amazonaws/iu,
    meta: { key: 'bedrock', label: 'AWS Bedrock' },
  },
  {
    pattern: /openrouter/iu,
    meta: { key: 'openrouter', label: 'OpenRouter' },
  },
  {
    pattern: /vertex/iu,
    meta: { key: 'vertexai', label: 'Google Vertex AI' },
  },
  {
    pattern: /google|googleapis\.com/iu,
    meta: { key: 'google', label: 'Google' },
  },
  {
    pattern: /gemini/iu,
    meta: { key: 'gemini', label: 'Gemini' },
  },
  {
    pattern: /github[-_\s]?copilot|\bcopilot\b/iu,
    meta: { key: 'githubcopilot', label: 'GitHub Copilot' },
  },
  {
    pattern: /anthropic/iu,
    meta: { key: 'anthropic', label: 'Anthropic' },
  },
  {
    pattern: /claude/iu,
    meta: { key: 'claude', label: 'Claude' },
  },
  {
    pattern: /openai|chatgpt|codex/iu,
    meta: { key: 'openai', label: 'OpenAI' },
  },
  {
    pattern: /\bzai\b|zai[-_]|z\.ai/iu,
    meta: { key: 'zai', label: 'Z.ai' },
  },
  {
    pattern: /zhipu|智谱|bigmodel\.cn|\bglm\b|glm[-_]/iu,
    meta: { key: 'zhipu', label: '智谱' },
  },
  {
    pattern: /qwen|通义|千问|dashscope|aliyuncs|alibaba/iu,
    meta: { key: 'qwen', label: '通义千问' },
  },
  {
    pattern: /kimi/iu,
    meta: { key: 'kimi', label: 'Kimi' },
  },
  {
    pattern: /moonshot/iu,
    meta: { key: 'moonshot', label: 'Moonshot' },
  },
  {
    pattern: /minimax|minimaxi|abab/iu,
    meta: { key: 'minimax', label: 'MiniMax' },
  },
  {
    pattern: /\bxai\b|grok|api\.x\.ai/iu,
    meta: { key: 'xai', label: 'xAI' },
  },
  {
    pattern: /mistral/iu,
    meta: { key: 'mistral', label: 'Mistral' },
  },
  {
    pattern: /ollama|:11434\b/iu,
    meta: { key: 'ollama', label: 'Ollama' },
  },
  {
    pattern: /volcengine|volces|火山|豆包|doubao|ark\.cn/iu,
    meta: { key: 'volcengine', label: '火山引擎' },
  },
  {
    pattern: /cloudflare/iu,
    meta: { key: 'cloudflare', label: 'Cloudflare' },
  },
  {
    pattern: /fireworks/iu,
    meta: { key: 'fireworks', label: 'Fireworks' },
  },
  {
    pattern: /\bgroq\b|api\.groq\.com/iu,
    meta: { key: 'groq', label: 'Groq' },
  },
  {
    pattern: /huggingface|hf\.co/iu,
    meta: { key: 'huggingface', label: 'Hugging Face' },
  },
  {
    pattern: /\bmeta\b|llama\.com/iu,
    meta: { key: 'meta', label: 'Meta' },
  },
  {
    pattern: /nvidia|integrate\.api\.nvidia/iu,
    meta: { key: 'nvidia', label: 'NVIDIA' },
  },
  {
    pattern: /together/iu,
    meta: { key: 'together', label: 'Together' },
  },
  {
    pattern: /vercel/iu,
    meta: { key: 'vercel', label: 'Vercel' },
  },
  {
    pattern: /cerebras/iu,
    meta: { key: 'cerebras', label: 'Cerebras' },
  },
  {
    pattern: /baseten/iu,
    meta: { key: 'baseten', label: 'Baseten' },
  },
  {
    pattern: /xiaomi|mimo/iu,
    meta: { key: 'xiaomi', label: '小米' },
  },
  {
    pattern: /ant[-_]?ling/iu,
    meta: { key: 'ling', label: 'Ant Ling' },
  },
  {
    pattern: /opencode/iu,
    meta: { key: 'opencode', label: 'OpenCode' },
  },
  {
    pattern: /typesafe/iu,
    meta: { key: 'typesafe', label: 'TypeSafe' },
  },
  {
    pattern: /siliconcloud|siliconflow|硅基流动/iu,
    meta: { key: 'siliconcloud', label: '硅基流动' },
  },
  {
    pattern: /perplexity/iu,
    meta: { key: 'perplexity', label: 'Perplexity' },
  },
  {
    pattern: /cohere/iu,
    meta: { key: 'cohere', label: 'Cohere' },
  },
  {
    pattern: /stepfun|阶跃/iu,
    meta: { key: 'stepfun', label: '阶跃星辰' },
  },
  {
    pattern: /baichuan|百川/iu,
    meta: { key: 'baichuan', label: '百川' },
  },
  {
    pattern: /hunyuan|混元|tencent/iu,
    meta: { key: 'hunyuan', label: '腾讯混元' },
  },
  {
    pattern: /\bspark\b|xfyun|星火/iu,
    meta: { key: 'spark', label: '讯飞星火' },
  },
  {
    pattern: /wenxin|qianfan|baidu|文心/iu,
    meta: { key: 'wenxin', label: '百度千帆' },
  },
  {
    pattern: /lingyiwanwu|\byi\b|零一万物/iu,
    meta: { key: 'yi', label: '零一万物' },
  },
]

/** 将不可信值收敛为键值对象，非对象时返回空对象。 */
export function asRecordObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

/** 将不可信值收敛为字符串，非字符串时返回空串。 */
export function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 综合 provider ID、显示名称与自定义端点域名识别提供商官方品牌标志键。 */
export function resolveProviderBrand(
  providerId: string,
  displayName: string,
  baseURL?: string | null,
): ProviderBrandMeta {
  const haystack = `${providerId} ${displayName} ${baseURL ?? ''}`
  for (const rule of BRAND_RULES) {
    if (rule.pattern.test(haystack)) return rule.meta
  }
  return { key: 'custom', label: displayName.trim() || providerId.trim() || '自定义提供商' }
}

/** 将 API 协议枚举转为「中文说明（协议代号）」，未知枚举回退原值。 */
export function formatApiProtocol(protocol: string): string {
  const friendly = PROTOCOL_LABELS[protocol]
  return friendly === undefined ? protocol : `${friendly}（${protocol}）`
}

/** 根据凭据快照生成状态胶囊与存储位置说明，避免仅用无文字色点表达状态。 */
export function describeCredentialBadge(credential?: CredentialState): CredentialBadgeMeta {
  if (credential?.configured) {
    const isEnv = credential.source === 'env' || credential.source === 'environment'
    if (isEnv) {
      return {
        state: 'positive',
        label: '环境变量',
        storageLabel: '启动环境变量',
        helperText: '由启动环境变量提供，请在启动环境中修改或移除。',
      }
    }
    return {
      state: 'positive',
      label: '已配置密钥',
      storageLabel: '本机私有凭据文件',
      helperText: '保存在本机 MyDSH 私有凭据文件中，不回显明文密钥。',
    }
  }
  return {
    state: 'neutral',
    label: '未配置密钥',
    storageLabel: '本机私有凭据文件',
    helperText: '保存在本机 MyDSH 私有凭据文件中；留空时将尝试使用环境认证。',
  }
}

/** 从自定义 API 地址中提取简洁的域名摘要用于卡片展示。 */
export function formatEndpointHost(baseURL: string): string | null {
  const trimmed = baseURL.trim()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    const pathname = url.pathname.replace(/\/+$/u, '')
    if (!pathname || pathname === '/v1') return url.host
    return `${url.host}${pathname}`
  } catch {
    return trimmed
  }
}

/** 将 Token 数量格式化为紧凑易读的芯片文本（如 128K、64K、1M）。 */
export function formatTokenCount(tokens: unknown): string | null {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return null
  if (tokens >= 1_000_000) {
    if (tokens % 1_048_576 === 0) return `${tokens / 1_048_576}M`
    if (tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`
    return `${Number((tokens / 1_000_000).toFixed(1))}M`
  }
  if (tokens >= 1_000) {
    if (tokens >= 1024 && tokens % 1024 === 0) return `${tokens / 1024}K`
    if (tokens % 1_000 === 0) return `${tokens / 1_000}K`
    return `${Number((tokens / 1_000).toFixed(1))}K`
  }
  return String(tokens)
}

/** 解析模型容量输入，支持正整数与 K / M 缩写，非法输入保留原文交由校验提示。 */
export function parseCapacityInput(raw: string): unknown {
  const text = raw.trim()
  if (!text) return undefined
  const match = /^(\d+(?:\.\d+)?)\s*([km])?$/iu.exec(text)
  if (!match) return text
  const unit = match[2]?.toLowerCase()
  let multiplier = 1
  if (unit === 'm') multiplier = 1_000_000
  else if (unit === 'k') multiplier = 1_000
  return Number(match[1]) * multiplier
}

/**
 * 校验单条模型的 `reasoningEfforts` 配置是否满足 `llm-pi-ai` 后端契约。
 * 允许 `undefined`、`false` 或至少包含一个非 `off` 档位的合法映射字典。
 */
export function validateReasoningEfforts(value: unknown, prefix = ''): string | null {
  if (value === undefined || value === false) return null
  if (!isRecord(value)) return `${prefix}思考程度配置格式无效。`
  const entries = Object.entries(value).filter(([, wire]) => wire !== undefined)
  if (entries.length === 0) {
    return `${prefix}开启自定义思考档位时，请至少勾选一个非关闭（off）的思考档位。`
  }
  let hasActiveLevel = false
  for (const [level, wire] of entries) {
    if (!THINKING_LEVEL_SET.has(level)) return `${prefix}包含不支持的思考档位：${level}`
    if (level !== 'off') hasActiveLevel = true
    if (wire === null) {
      if (level !== 'off') {
        const label = THINKING_LEVEL_LABEL.get(level) ?? level
        return `${prefix}思考档位「${label}（${level}）」的参数映射值不能为空。`
      }
      continue
    }
    if (typeof wire !== 'string' || wire.trim().length === 0) {
      const label = THINKING_LEVEL_LABEL.get(level) ?? level
      return `${prefix}思考档位「${label}（${level}）」的参数映射值不能为空。`
    }
  }
  if (!hasActiveLevel) {
    return `${prefix}开启自定义思考档位时，请至少勾选一个非关闭（off）的思考档位。`
  }
  return null
}

/** 思考程度编辑器的三态模式：沿用默认、明确不支持、自定义档位。 */
export type ReasoningMode = 'inherit' | 'disabled' | 'custom'

/** 单条模型草稿弹窗初始化时的思考配置快照。 */
export interface InitialReasoningState {
  readonly mode: ReasoningMode
  readonly levels: readonly ThinkingLevelKey[]
  readonly wireValues: Readonly<Partial<Record<ThinkingLevelKey, string>>>
  readonly thinkingFormat: string | null
}

/** 单条模型草稿表单校验与构建输入。 */
export interface BuildModelDraftInput {
  readonly baseModel: Record<string, unknown> & { id: string }
  readonly id: string
  readonly name: string
  readonly contextText: string
  readonly maxTokensText: string
  readonly modalities: readonly string[] | undefined
  readonly reasoningMode: ReasoningMode
  readonly reasoningLevels: readonly ThinkingLevelKey[]
  readonly wireValues: Readonly<Partial<Record<ThinkingLevelKey, string>>>
  readonly thinkingFormat: string | null
  readonly existingIds: readonly string[]
  readonly inputField: 'input' | 'inputModalities'
}

function validateCapacityValue(value: unknown, label: string): string | null {
  if (value === undefined) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    return `${label}必须是正整数，可使用 K 或 M（例如 128K、1M）。`
  }
  return null
}

/** 从现有模型草稿中提取思考模式、已选档位、参数映射值与 `compat.thinkingFormat`。 */
export function parseInitialReasoning(model: Record<string, unknown>): InitialReasoningState {
  const compat = asRecordObject(model.compat)
  const thinkingFormat =
    typeof compat.thinkingFormat === 'string' && compat.thinkingFormat.trim().length > 0
      ? compat.thinkingFormat
      : null
  const raw = model.reasoningEfforts
  if (raw === false) {
    return { mode: 'disabled', levels: [], wireValues: {}, thinkingFormat }
  }
  if (!isRecord(raw)) {
    return { mode: 'inherit', levels: [], wireValues: {}, thinkingFormat }
  }
  const levels: ThinkingLevelKey[] = []
  const wireValues: Partial<Record<ThinkingLevelKey, string>> = {}
  for (const option of THINKING_LEVEL_OPTIONS) {
    if (!Object.hasOwn(raw, option.key) || raw[option.key] === undefined) continue
    levels.push(option.key)
    const wire = raw[option.key]
    wireValues[option.key] = typeof wire === 'string' ? wire : ''
  }
  return { mode: 'custom', levels, wireValues, thinkingFormat }
}

/** 将表单中的思考模式与档位映射构建为符合 `llm-pi-ai` 契约的 `reasoningEfforts` 值。 */
export function buildReasoningPayload(options: {
  readonly mode: ReasoningMode
  readonly levels: readonly ThinkingLevelKey[]
  readonly wireValues: Readonly<Partial<Record<ThinkingLevelKey, string>>>
}): false | Record<string, string | null> | undefined {
  if (options.mode === 'inherit') return undefined
  if (options.mode === 'disabled') return false
  const selected = new Set(options.levels)
  const result: Record<string, string | null> = {}
  for (const option of THINKING_LEVEL_OPTIONS) {
    if (!selected.has(option.key)) continue
    const raw = (options.wireValues[option.key] ?? '').trim()
    result[option.key] = option.key === 'off' && raw.length === 0 ? null : raw
  }
  return result
}

/** 校验并生成完整的单条模型草稿，通过深拷贝保留未在弹窗编辑的扩展字段。 */
export function buildValidatedModelDraft(
  input: BuildModelDraftInput,
): { readonly draft: Record<string, unknown> & { id: string } } | { readonly error: string } {
  const trimmedId = input.id.trim()
  if (!trimmedId) return { error: '请填写模型 ID。' }
  if (input.existingIds.includes(trimmedId)) return { error: `模型 ID 重复：${trimmedId}` }
  const parsedContext = parseCapacityInput(input.contextText)
  const contextError = validateCapacityValue(parsedContext, '上下文窗口')
  if (contextError !== null) return { error: contextError }
  const parsedMaxTokens = parseCapacityInput(input.maxTokensText)
  const maxTokensError = validateCapacityValue(parsedMaxTokens, '最大输出')
  if (maxTokensError !== null) return { error: maxTokensError }

  // 克隆原始模型对象，保留 compat、图片限制、未知扩展字段等未在本弹窗暴露的配置。
  const next: Record<string, unknown> & { id: string } = {
    ...structuredClone(input.baseModel),
    id: trimmedId,
  }
  if (input.name.trim()) next.name = input.name.trim()
  else delete next.name
  if (parsedContext !== undefined) next.contextWindow = parsedContext
  else delete next.contextWindow
  if (parsedMaxTokens !== undefined) next.maxTokens = parsedMaxTokens
  else delete next.maxTokens
  if (input.modalities !== undefined) next[input.inputField] = [...input.modalities]
  else delete next[input.inputField]

  if (input.inputField === 'input') {
    const reasoningPayload = buildReasoningPayload({
      mode: input.reasoningMode,
      levels: input.reasoningLevels,
      wireValues: input.wireValues,
    })
    const reasoningError = validateReasoningEfforts(reasoningPayload)
    if (reasoningError !== null) return { error: reasoningError }
    if (reasoningPayload === undefined) delete next.reasoningEfforts
    else next.reasoningEfforts = reasoningPayload

    if (input.reasoningMode === 'custom') {
      const nextCompat = isRecord(next.compat) ? { ...next.compat } : {}
      if (input.thinkingFormat !== null && input.thinkingFormat.trim().length > 0) {
        nextCompat.thinkingFormat = input.thinkingFormat.trim()
      } else {
        delete nextCompat.thinkingFormat
      }
      if (Object.keys(nextCompat).length > 0) next.compat = nextCompat
      else delete next.compat
    }
  }
  return { draft: next }
}

/** 将 `reasoningEfforts` 格式化为模型行的简洁能力摘要，未显式配置时返回 null。 */
export function formatReasoningSummary(value: unknown): string | null {
  if (value === false) return '不启用思考'
  if (!isRecord(value)) return null
  const labels = THINKING_LEVEL_OPTIONS.filter(option => value[option.key] !== undefined).map(
    option => option.shortLabel,
  )
  return labels.length > 0 ? `思考：${labels.join(' / ')}` : null
}

/** 将默认模型二元组编码为稳定选项键。 */
export function encodeModelKey(selection: ModelSelection): string {
  return JSON.stringify([selection.provider, selection.model])
}

/** 从选项键反解析默认模型二元组，格式无效时返回 null。 */
export function decodeModelKey(value: string): ModelSelection | null {
  try {
    const pair: unknown = JSON.parse(value)
    if (Array.isArray(pair) && pair.length === 2 && pair.every(item => typeof item === 'string')) {
      return { provider: pair[0] as string, model: pair[1] as string }
    }
    return null
  } catch {
    return null
  }
}

/** 判断一个提供商是否由用户配置新增且不在只读基础层中，决定是否允许移除。 */
export function isProviderRemovable(
  provider: HostModelProvider,
  namespace?: HostSettingsNamespace,
): boolean {
  return (
    provider.settingsPath.length > 0 &&
    valueAtPath(namespace?.user, provider.settingsPath) !== undefined &&
    valueAtPath(namespace?.base, provider.settingsPath) === undefined
  )
}
