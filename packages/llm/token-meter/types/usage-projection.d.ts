/**
 * Pure folds for durable provider-reported token usage and context occupancy.
 */
import { z } from 'zod';
import { SessionSeq } from '@deepseek-ai/dsh-session';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { ContextPressureProjection, TokenUsageProjection } from './projection.ts';
/**
 * The token-usage unit's state schema — the one definition of the state
 * shape; the state type is inferred from it.
 */
declare const tokenUsageStateSchema: z.ZodObject<{
    totals: z.ZodObject<{
        uncachedInputTokens: z.ZodNumber;
        outputTokens: z.ZodNumber;
        cacheReadTokens: z.ZodNumber;
        cacheWriteTokens: z.ZodNumber;
    }, z.core.$strict>;
    last: z.ZodNullable<z.ZodObject<{
        turn: z.ZodNumber;
        step: z.ZodNumber;
        buckets: z.ZodObject<{
            uncachedInputTokens: z.ZodNumber;
            outputTokens: z.ZodNumber;
            cacheReadTokens: z.ZodNumber;
            cacheWriteTokens: z.ZodNumber;
        }, z.core.$strict>;
    }, z.core.$strip>>;
}, z.core.$strict>;
type TokenUsageState = z.infer<typeof tokenUsageStateSchema>;
declare module '@deepseek-ai/dsh-session-projection/types' {
    interface SessionProjectionStateMap {
        tokenUsage: TokenUsageState;
        contextPressure: ContextPressureState;
    }
}
/** The context-pressure state schema and source of its inferred type. */
declare const contextPressureStateSchema: z.ZodObject<{
    provider: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    awaitingUsage: z.ZodOptional<z.ZodBoolean>;
    nativeCompaction: z.ZodOptional<z.ZodBoolean>;
    contextWindow: z.ZodOptional<z.ZodNumber>;
    pressureTokens: z.ZodOptional<z.ZodNumber>;
    surfaceTokens: z.ZodNumber;
    sampledSurfaceTokens: z.ZodOptional<z.ZodNumber>;
    claim: z.ZodOptional<z.ZodObject<{
        start: z.ZodPipe<z.ZodNumber, z.ZodTransform<SessionSeq, number>>;
        end: z.ZodPipe<z.ZodNumber, z.ZodTransform<SessionSeq, number>>;
        tokens: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strict>;
type ContextPressureState = z.infer<typeof contextPressureStateSchema>;
/**
 * Token-meter's session projection unit.
 *
 * Each v2 Assistant settlement contributes the last usage sample embedded in
 * its stream. `llm/retry-started` closes the replacement slot so the retried
 * attempt adds to the total.
 */
export declare const tokenUsageProjectionDefinition: {
    key: "tokenUsage";
    stateVersion: number;
    stateSchema: z.ZodObject<{
        totals: z.ZodObject<{
            uncachedInputTokens: z.ZodNumber;
            outputTokens: z.ZodNumber;
            cacheReadTokens: z.ZodNumber;
            cacheWriteTokens: z.ZodNumber;
        }, z.core.$strict>;
        last: z.ZodNullable<z.ZodObject<{
            turn: z.ZodNumber;
            step: z.ZodNumber;
            buckets: z.ZodObject<{
                uncachedInputTokens: z.ZodNumber;
                outputTokens: z.ZodNumber;
                cacheReadTokens: z.ZodNumber;
                cacheWriteTokens: z.ZodNumber;
            }, z.core.$strict>;
        }, z.core.$strip>>;
    }, z.core.$strict>;
    init: () => {
        totals: TokenUsageProjection;
        last: null;
    };
    apply: (state: NoInfer<{
        totals: {
            uncachedInputTokens: number;
            outputTokens: number;
            cacheReadTokens: number;
            cacheWriteTokens: number;
        };
        last: {
            turn: number;
            step: number;
            buckets: {
                uncachedInputTokens: number;
                outputTokens: number;
                cacheReadTokens: number;
                cacheWriteTokens: number;
            };
        } | null;
    }>, event: SessionEvent) => {
        totals: {
            uncachedInputTokens: number;
            outputTokens: number;
            cacheReadTokens: number;
            cacheWriteTokens: number;
        };
        last: {
            turn: number;
            step: number;
            buckets: {
                uncachedInputTokens: number;
                outputTokens: number;
                cacheReadTokens: number;
                cacheWriteTokens: number;
            };
        } | null;
    };
    wire: {
        viewSchema: z.ZodObject<{
            uncachedInputTokens: z.ZodNumber;
            outputTokens: z.ZodNumber;
            cacheReadTokens: z.ZodNumber;
            cacheWriteTokens: z.ZodNumber;
        }, z.core.$strict>;
        view: (state: NoInfer<{
            totals: {
                uncachedInputTokens: number;
                outputTokens: number;
                cacheReadTokens: number;
                cacheWriteTokens: number;
            };
            last: {
                turn: number;
                step: number;
                buckets: {
                    uncachedInputTokens: number;
                    outputTokens: number;
                    cacheReadTokens: number;
                    cacheWriteTokens: number;
                };
            } | null;
        }>) => {
            uncachedInputTokens: number;
            outputTokens: number;
            cacheReadTokens: number;
            cacheWriteTokens: number;
        };
    };
};
/**
 * 请求占用以最近成功请求的输入用量为锚点，加上此后的本地表层增减估算。
 * 锚点记录在回复进入表层之前；普通摘要替换由 foldSurfaceProjection 计入减量。
 * 原生检查点不删除本地历史，因此不能从本地体积推断其占用：提交后隐藏旧样本，
 * 等待下一次成功请求重新建立锚点。切换提供方或模型同样使旧样本失效。
 */
export declare const contextPressureProjectionDefinition: {
    key: "contextPressure";
    stateVersion: number;
    stateSchema: typeof contextPressureStateSchema;
    init: () => {
        surfaceTokens: number;
    };
    apply: (state: ContextPressureState, event: SessionEvent) => ContextPressureState;
    wire: {
        viewSchema: z.ZodType<ContextPressureProjection, unknown, z.core.$ZodTypeInternals<ContextPressureProjection, unknown>>;
        view: (state: ContextPressureState) => ContextPressureProjection;
    };
};
export {};
//# sourceMappingURL=usage-projection.d.ts.map