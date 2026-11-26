/**
 * Pure client-safe token-projection vocabulary.
 *
 * @module @deepseek-ai/dsh-token-meter/projection
 */

/**
 * Durable cumulative provider usage for a complete session log.
 *
 * The four buckets are disjoint. In particular, reasoning tokens are already
 * included in `outputTokens` and are not accumulated again.
 */
export interface TokenUsageProjection {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/**
 * 用于状态展示的近似请求占用，不参与计费或请求准入。
 * 成功请求的输入用量与此后的表层增量共同估算下一次请求；原生压缩提交或
 * 路由变化后，旧读数不再有效，等待后续成功请求重新报告用量。
 */
export interface ContextPressureProjection {
  /**
   * Provider-reported prompt size of the most recent request: uncached input
   * plus cache reads and writes. Response output is excluded, so this does not
   * grow as the current turn streams. Absent until a provider reports usage.
   */
  pressureTokens?: number
  /**
   * What the NEXT request's prompt would cost: {@link pressureTokens} plus the
   * heuristic repricing of everything the surface gained or lost since that
   * sample. Only the delta is estimated, so the figure stays anchored to the
   * provider while still reacting the moment a compaction shadows a span —
   * which `pressureTokens` alone cannot do, since compaction reports no usage
   * of its own. Absent until a provider reports usage.
   */
  projectedTokens?: number
  /** Newest recorded route capacity; absent when no adapter advertised one. */
  contextWindow?: number
  /** 原生检查点已提交或路由已变化，等待后续成功请求提供有效占用。 */
  awaitingUsage?: true
  /** 请求使用原生检查点；本地保留表层不等于实际发送历史。 */
  nativeCompaction?: true
}

/**
 * 本地保留表层及请求配置的构成估算，采用固定字符密度，不作为请求占用总量。
 * 原生压缩不删除本地表层，因此其中的历史可能已经由服务端检查点替代，
 * 不会全部随下一次请求发送；界面必须与提供方用量锚定的占用分开展示。
 */
export interface ContextBreakdownProjection {
  /** Heuristic tokens of the last nonempty surviving system prompt in surface order; 0 when none exists. */
  systemTokens: number
  /** Heuristic tokens of the newest request envelope's tool schemas; 0 before any request. */
  toolsTokens: number
  /** Heuristic tokens of every other visible surface node, including superseded system prompts. */
  messageTokens: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Provider-reported usage accumulated across the complete durable log. */
    tokenUsage: TokenUsageProjection
    /** Newest request pressure paired with the newest known route capacity. */
    contextPressure: ContextPressureProjection
    /** Heuristic system/tools/message composition of the next request. */
    contextBreakdown: ContextBreakdownProjection
  }
}
