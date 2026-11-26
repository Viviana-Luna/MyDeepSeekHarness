/**
 * Normalization for values thrown by a final LLM adapter boundary.
 *
 * @module @deepseek-ai/dsh-llm/adapter-failure
 */
import type { LlmFailure } from './types.ts';
/**
 * Detach serializable provider facts from a value thrown by an adapter.
 * @param value - arbitrary value thrown during adapter dispatch or iteration.
 * @returns immutable provider-neutral facts suitable for a terminal finish chunk.
 * @internal
 */
export declare function normalizeLlmFailure(value: unknown): LlmFailure;
/** 抛出异常和流内失败共用显示处理，不改变各自的错误分类。 */
export declare function formatLlmFailure(failure: LlmFailure, message?: string): LlmFailure;
//# sourceMappingURL=adapter-failure.d.ts.map
