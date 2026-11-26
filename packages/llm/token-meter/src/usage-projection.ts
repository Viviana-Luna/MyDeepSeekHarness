/**
 * Pure folds for durable provider-reported token usage and context occupancy.
 */

import { z } from 'zod'
import { lastAssistantStreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm-retry/types'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { ContextPressureProjection, TokenUsageProjection } from './projection.ts'
import { foldSurfaceProjection } from './surface-projection.ts'

const zeroBuckets = (): TokenUsageProjection => ({
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

const bucketsFrom = (usage: TokenUsage): TokenUsageProjection => ({
  uncachedInputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  cacheReadTokens: usage.cacheReadTokens ?? 0,
  cacheWriteTokens: usage.cacheWriteTokens ?? 0,
})

const bucketsEqual = (left: TokenUsageProjection, right: TokenUsageProjection): boolean =>
  left.uncachedInputTokens === right.uncachedInputTokens
  && left.outputTokens === right.outputTokens
  && left.cacheReadTokens === right.cacheReadTokens
  && left.cacheWriteTokens === right.cacheWriteTokens

const addReplacing = (
  totals: TokenUsageProjection,
  previous: TokenUsageProjection | undefined,
  next: TokenUsageProjection,
): TokenUsageProjection => ({
  uncachedInputTokens: totals.uncachedInputTokens - (previous?.uncachedInputTokens ?? 0) + next.uncachedInputTokens,
  outputTokens: totals.outputTokens - (previous?.outputTokens ?? 0) + next.outputTokens,
  cacheReadTokens: totals.cacheReadTokens - (previous?.cacheReadTokens ?? 0) + next.cacheReadTokens,
  cacheWriteTokens: totals.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0) + next.cacheWriteTokens,
})

const projectionSchema = z.object({
  uncachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
}).strict()

/**
 * The token-usage unit's state schema — the one definition of the state
 * shape; the state type is inferred from it.
 */
const tokenUsageStateSchema = z.object({
  totals: projectionSchema,
  last: z.object({
    turn: z.number().int().nonnegative(),
    step: z.number().int().nonnegative(),
    buckets: projectionSchema,
  }).nullable(),
}).strict()

type TokenUsageState = z.infer<typeof tokenUsageStateSchema>

const pressureSchema: z.ZodType<ContextPressureProjection> = z.object({
  pressureTokens: z.number().int().nonnegative().optional(),
  projectedTokens: z.number().int().nonnegative().optional(),
  contextWindow: z.number().int().positive().optional(),
  awaitingUsage: z.literal(true).optional(),
  nativeCompaction: z.literal(true).optional(),
}).strict().transform(({ pressureTokens, projectedTokens, contextWindow, awaitingUsage, nativeCompaction }) => ({
  ...pressureTokens === undefined ? {} : { pressureTokens },
  ...projectedTokens === undefined ? {} : { projectedTokens },
  ...contextWindow === undefined ? {} : { contextWindow },
  ...awaitingUsage === undefined ? {} : { awaitingUsage },
  ...nativeCompaction === undefined ? {} : { nativeCompaction },
}))

/** Prompt-side pressure of one request: input plus cache traffic, no output. */
const pressureFrom = (usage: TokenUsage): number =>
  usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)

/** The usage one durable Assistant settlement reports for its attempt, if any. */
function usageOf(event: SessionEvent): TokenUsage | undefined {
  if (event.type === 'assistant/message' && event.data.usage !== undefined) return event.data.usage
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  return lastAssistantStreamChunk(event.data.stream, 'usage')?.usage
}

/** 旧会话还没有公开标记，只读取其检查点存在性，不将密文加入投影。 */
function compactionOf(event: SessionEvent): 'created' | 'replayed' | 'none' | undefined {
  if (event.type !== 'assistant/message' || event.data.interrupted) return undefined
  const finish = lastAssistantStreamChunk(event.data.stream, 'finish')
  if (finish?.contextCompaction !== undefined) return finish.contextCompaction
  const source = event.data.message.source
  const replay = source.kind === 'model' ? source.replayState : undefined
  const response = typeof replay === 'object' && replay !== null && 'response' in replay ? replay.response : undefined
  if (typeof response !== 'object' || response === null) return undefined
  const metadata = response as Record<string, unknown>
  return metadata.kind === 'mydsh-chatgpt' && Array.isArray(metadata.compactions) && metadata.compactions.length > 0
    ? 'created' : undefined
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    tokenUsage: TokenUsageState
    contextPressure: ContextPressureState
  }
}

/** The context-pressure state schema and source of its inferred type. */
const contextPressureStateSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  awaitingUsage: z.boolean().optional(),
  nativeCompaction: z.boolean().optional(),
  contextWindow: z.number().int().positive().optional(),
  pressureTokens: z.number().int().nonnegative().optional(),
  surfaceTokens: z.number().int().nonnegative(),
  sampledSurfaceTokens: z.number().int().nonnegative().optional(),
  claim: z.object({
    start: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionSeq),
    end: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionSeq),
    tokens: z.number().int().nonnegative(),
  }).optional(),
}).strict()

type ContextPressureState = z.infer<typeof contextPressureStateSchema>

/**
 * Token-meter's session projection unit.
 *
 * Each v2 Assistant settlement contributes the last usage sample embedded in
 * its stream. `llm/retry-started` closes the replacement slot so the retried
 * attempt adds to the total.
 */
export const tokenUsageProjectionDefinition = {
  key: 'tokenUsage',
  stateVersion: 2,
  stateSchema: tokenUsageStateSchema,
  init: () => ({ totals: zeroBuckets(), last: null }),
  apply: (state, event) => {
    if (event.type === 'llm/retry-started') {
      return state.last?.turn === event.data.turn && state.last.step === event.data.step
        ? { ...state, last: null }
        : state
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') {
      return state
    }
    const sample = usageOf(event)
    if (sample === undefined) return state
    const { turn, step } = event.data
    const usage: TokenUsage = sample

    const buckets = bucketsFrom(usage)
    const previous = state.last !== null
      && state.last.turn === turn
      && state.last.step === step
      ? state.last.buckets
      : undefined
    if (previous !== undefined && bucketsEqual(previous, buckets)) return state

    return {
      totals: addReplacing(state.totals, previous, buckets),
      last: { turn, step, buckets },
    }
  },
  wire: { viewSchema: projectionSchema, view: state => state.totals },
} satisfies ProjectionDefinition<'tokenUsage', TokenUsageState>

/**
 * 请求占用以最近成功请求的输入用量为锚点，加上此后的本地表层增减估算。
 * 锚点记录在回复进入表层之前；普通摘要替换由 foldSurfaceProjection 计入减量。
 * 原生检查点不删除本地历史，因此不能从本地体积推断其占用：提交后隐藏旧样本，
 * 等待下一次成功请求重新建立锚点。切换提供方或模型同样使旧样本失效。
 */
export const contextPressureProjectionDefinition = {
  key: 'contextPressure',
  stateVersion: 6,
  stateSchema: contextPressureStateSchema,
  init: () => ({ surfaceTokens: 0 }),
  apply: (state, event) => {
    const fold = foldSurfaceProjection(state.claim, event)
    let next = state
    if (event.type === 'request/header') {
      const { provider, model } = event.data.header.config
      if (provider !== state.provider || model !== state.model) {
        next = { ...next, provider, model, awaitingUsage: true, nativeCompaction: false }
      }
    }
    if (event.type === 'request/context') {
      const contextWindow = event.data.contextWindow
      if (contextWindow !== state.contextWindow) {
        if (contextWindow !== undefined) {
          next = { ...next, contextWindow }
        } else {
          const { contextWindow: _removed, ...withoutContextWindow } = next
          next = withoutContextWindow
        }
      }
    }
    const usage = usageOf(event)
    const compaction = compactionOf(event)
    if (compaction === 'created') {
      // 本次 usage 计量的是创建检查点的输入，不能当作检查点之后的占用。
      next = { ...next, awaitingUsage: true, nativeCompaction: true }
    } else if (usage !== undefined && event.type === 'assistant/message' && !event.data.interrupted) {
      const pressureTokens = pressureFrom(usage)
      next = { ...next, pressureTokens, sampledSurfaceTokens: next.surfaceTokens, awaitingUsage: false,
        nativeCompaction: compaction === 'replayed' || compaction !== 'none' && next.nativeCompaction === true }
    }
    if (fold.deltaTokens !== 0) {
      next = { ...next, surfaceTokens: next.surfaceTokens + fold.deltaTokens }
    }
    // A defined fold.claim is always freshly built, so presence decides claim
    // bookkeeping: no claim before or after this event leaves `next` as is.
    if (state.claim === undefined && fold.claim === undefined) return next
    const { claim: _expired, ...withoutClaim } = next
    return fold.claim === undefined ? withoutClaim : { ...withoutClaim, claim: fold.claim }
  },
  wire: {
    viewSchema: pressureSchema,
    view: ({ contextWindow, pressureTokens, surfaceTokens, sampledSurfaceTokens, awaitingUsage, nativeCompaction }) => ({
      ...contextWindow === undefined ? {} : { contextWindow },
      ...awaitingUsage ? { awaitingUsage: true as const } : {},
      ...nativeCompaction ? { nativeCompaction: true as const } : {},
      ...awaitingUsage || pressureTokens === undefined ? {} : { pressureTokens },
      ...awaitingUsage || pressureTokens === undefined || sampledSurfaceTokens === undefined
        ? {}
        : { projectedTokens: Math.max(0, pressureTokens + surfaceTokens - sampledSurfaceTokens) },
    }),
  },
} satisfies ProjectionDefinition<'contextPressure', ContextPressureState>
