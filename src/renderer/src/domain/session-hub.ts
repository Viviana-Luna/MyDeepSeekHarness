import { asRecord } from '../../../shared/validation.ts'

export interface HubTokenUsage {
  /** 未命中缓存的提示词输入。 */
  readonly uncachedInput: number
  /** 命中缓存的提示词输入。 */
  readonly cacheRead: number
  /** 写入缓存的提示词输入。 */
  readonly cacheWrite: number
  /** 提供方返回的输出（含推理）。 */
  readonly output: number
}

export interface HubContext {
  /** 下一次请求的预计占用；没有读数时为 null。 */
  readonly projectedTokens: number | null
  /** 路由容量；适配器未声明时为 null。 */
  readonly window: number | null
  /** 整数占用百分比，可以超过 100；缺少有效读数时为 null。 */
  readonly percent: number | null
  readonly awaitingUsage?: true
  readonly nativeCompaction?: true
}

/** 核心给出的上下文构成估算，不能替代提供方锚定的占用总量。 */
export interface HubContextBreakdown {
  readonly systemTokens: number
  readonly toolsTokens: number
  readonly messageTokens: number
}

export function parseHubContextBreakdown(value: unknown): HubContextBreakdown | null {
  const source = asRecord(value)
  const systemTokens = count(source?.systemTokens)
  const toolsTokens = count(source?.toolsTokens)
  const messageTokens = count(source?.messageTokens)
  return systemTokens === null || toolsTokens === null || messageTokens === null
    ? null
    : { systemTokens, toolsTokens, messageTokens }
}

export interface HubSpeed {
  /** 输出速度，单位 token/秒。 */
  readonly tokensPerSecond: number
  /** 参与平均的输出 token 数。 */
  readonly outputTokens: number
  /** 参与平均的解码时长（毫秒）。 */
  readonly decodeMs: number
}

export interface HubStats {
  readonly turns: number
  readonly steps: number
  readonly llmMs: number
  readonly toolMs: number
  /** 已记录首字延迟的步骤数；为 0 时平均首字没有意义。 */
  readonly ttftSteps: number
  readonly ttftMs: number
  readonly speed: HubSpeed | null
}

export type HubTodoStatus = 'pending' | 'in_progress' | 'completed'

export interface HubTodo {
  readonly content: string
  readonly status: HubTodoStatus
}

const MAX_TODOS = 200
const MAX_TODO_TEXT = 500
/** 计数字段的安全上界：越过它说明投影已经不可信，按缺失处理。 */
const MAX_COUNT = 1e15

function count(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_COUNT
    ? value
    : null
}

/** 时长字段按毫秒读数取整：上游允许非整数毫秒，越界或负数按缺失处理。 */
function millis(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_COUNT)
    return null
  return Math.round(value)
}

function string(value: unknown, limit: number): string | null {
  return typeof value === 'string' && value !== '' && value.length <= limit ? value : null
}

/** 提示词侧计费桶之和：未缓存输入、缓存读取与缓存写入。 */
export function hubBilledInput(usage: HubTokenUsage): number {
  return usage.uncachedInput + usage.cacheRead + usage.cacheWrite
}

/** 会话累计总量：提示词侧三个桶加输出。 */
export function hubTotalTokens(usage: HubTokenUsage): number {
  return hubBilledInput(usage) + usage.output
}

/** 四个桶全为零时没有可展示的用量，也不该出现点开即空的面板。 */
export function hubHasUsage(usage: HubTokenUsage): boolean {
  return hubTotalTokens(usage) > 0
}

/**
 * 读取会话累计用量。任一桶缺失即视为整份投影不可信：宁可整个不显示，
 * 也不把半份用量当成完整账单。
 */
export function parseHubTokenUsage(value: unknown): HubTokenUsage | null {
  const source = asRecord(value)
  if (source === null) return null
  const uncachedInput = count(source.uncachedInputTokens)
  const cacheRead = count(source.cacheReadTokens)
  const cacheWrite = count(source.cacheWriteTokens)
  const output = count(source.outputTokens)
  if (uncachedInput === null || cacheRead === null || cacheWrite === null || output === null)
    return null
  return { uncachedInput, cacheRead, cacheWrite, output }
}

/** 读取上下文占用；两个读数可以各自缺失，只有百分比需要成对存在。 */
export function parseHubContext(value: unknown): HubContext {
  const source = asRecord(value)
  const window = count(source?.contextWindow)
  const awaitingUsage = source?.awaitingUsage === true
  const projected = awaitingUsage ? null : count(source?.projectedTokens)
  return {
    projectedTokens: projected,
    window: window !== null && window > 0 ? window : null,
    percent:
      projected !== null && window !== null && window > 0
        ? Math.max(0, Math.round((projected / window) * 100))
        : null,
    ...(awaitingUsage ? { awaitingUsage: true as const } : {}),
    ...(source?.nativeCompaction === true ? { nativeCompaction: true as const } : {}),
  }
}

/** 读取耗时与速度统计；只有 `decodeMs` 与 `decodeTokens` 同时为正才有速度。 */
export function parseHubStats(value: unknown): HubStats | null {
  const source = asRecord(value)
  if (source === null) return null
  const turns = count(source.turns)
  const steps = count(source.steps)
  const llmMs = millis(source.llmMs)
  const toolMs = millis(source.toolMs)
  const ttftMs = millis(source.ttftMs)
  const ttftSteps = count(source.ttftSteps)
  const decodeMs = millis(source.decodeMs)
  const decodeTokens = count(source.decodeTokens)
  if (
    turns === null ||
    steps === null ||
    llmMs === null ||
    toolMs === null ||
    ttftMs === null ||
    ttftSteps === null ||
    decodeMs === null ||
    decodeTokens === null
  )
    return null
  return {
    turns,
    steps,
    llmMs,
    toolMs,
    ttftSteps,
    ttftMs,
    speed:
      decodeMs > 0 && decodeTokens > 0
        ? {
            tokensPerSecond: decodeTokens / (decodeMs / 1_000),
            outputTokens: decodeTokens,
            decodeMs,
          }
        : null,
  }
}

/** 读取待办清单；`todo_write` 每次写入完整清单，所以这里只做整表替换。 */
export function parseHubTodos(value: unknown): readonly HubTodo[] {
  if (!Array.isArray(value)) return []
  const todos: HubTodo[] = []
  for (const item of value.slice(0, MAX_TODOS)) {
    const source = asRecord(item)
    if (source === null) continue
    const content = string(source.content, MAX_TODO_TEXT)
    const status = source.status
    if (content === null) continue
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') continue
    todos.push({ content, status })
  }
  return todos
}

/**
 * 缓存命中率：命中读取占提示词侧三个桶的比例。三个桶全为零时没有可算的分母，
 * 此时不给读数，而不是把 0/0 显示成 0%。
 */
export function hubCacheHitPercent(usage: HubTokenUsage): number | null {
  const denominator = hubBilledInput(usage)
  if (denominator <= 0) return null
  return Math.round((usage.cacheRead / denominator) * 100)
}

/** 紧凑计数的一位/整数切换：达到 100 之后不再保留小数。 */
function scaleCompact(candidate: number): string {
  return candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10)
}

/** 紧凑 token 计数：517 / 12.2K / 1.2M。 */
export function formatHubTokens(value: number): string {
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${scaleCompact(value / 1_000)}K`
  return `${scaleCompact(value / 1_000_000)}M`
}

/** 精确 token 计数：按当前区域设置分组，不四舍五入。 */
export function formatHubExactTokens(value: number): string {
  return value.toLocaleString('zh-CN')
}

/** 速度读数：低于 10 保留一位小数，其余取整；没有读数时返回空占位。 */
export function formatHubSpeed(tokensPerSecond: number | null): string {
  if (tokensPerSecond === null) return '—'
  const rounded =
    tokensPerSecond >= 10
      ? String(Math.round(tokensPerSecond))
      : String(Math.round(tokensPerSecond * 10) / 10)
  return `${rounded} tok/s`
}

/** 紧凑时长：45.2s 以内用秒，之后用 2m42s。 */
export function formatHubDuration(ms: number): string {
  const seconds = ms / 1_000
  if (seconds < 60) return `${String(Math.round(seconds * 10) / 10)}s`
  const whole = Math.round(seconds)
  return `${String(Math.floor(whole / 60))}m${String(whole % 60)}s`
}

/** 待办进度摘要：只保留非零分段，避免空清单出现“0 已完成”。 */
export function hubTodoProgress(todos: readonly HubTodo[]): string {
  const completed = todos.filter(todo => todo.status === 'completed').length
  const active = todos.filter(todo => todo.status === 'in_progress').length
  const pending = todos.length - completed - active
  return [
    ...(completed > 0 ? [`已完成 ${String(completed)}`] : []),
    ...(active > 0 ? [`进行中 ${String(active)}`] : []),
    ...(pending > 0 ? [`待处理 ${String(pending)}`] : []),
  ].join(' · ')
}
