/** 独立审核请求与有界只读取证循环，不调用主 Agent 的工具注册表。 */
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ReviewContext } from './context.ts'
import { EVIDENCE_TOOLS, ReviewBudgetError, type ReviewEvidence } from './evidence.ts'
import {
  assessmentSchema,
  MAX_INPUT_BYTES,
  MAX_OUTPUT_BYTES,
  parseObject,
  REVIEW_SYSTEM,
  type Assessment,
  type ReviewPolicy,
} from './policy.ts'

export interface ReviewInput {
  provider: string
  model: string
  session: Session
  context: ReviewContext
  action: unknown
  policy: ReviewPolicy
}

export async function reviewWithModel(
  ctx: Context,
  input: ReviewInput,
  evidence: ReviewEvidence,
  signal: AbortSignal,
): Promise<Assessment> {
  const { provider, model } = input
  const messages: Message[] = [
    createUserMessage({
      source: { kind: 'plugin', plugin: 'mydsh-auto-review' },
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            policy: input.policy,
            context: input.context.entries,
            action: input.action,
          }),
        },
      ],
    }),
  ]
  const toolIds = new Set<string>()
  for (let round = 0; round <= 3; round += 1) {
    signal.throwIfAborted()
    if (
      Buffer.byteLength(JSON.stringify(messages)) + Buffer.byteLength(REVIEW_SYSTEM) >
      MAX_INPUT_BYTES
    )
      throw new ReviewBudgetError()
    const assembler = new BlockAssembler()
    let finished = false,
      size = 0
    const stream = ctx.llm.stream({
      provider,
      model,
      system: REVIEW_SYSTEM,
      messages: [...messages],
      tools: round < 3 ? EVIDENCE_TOOLS : [],
      purpose: 'approval-review',
      sessionId: input.session.id,
      signal,
    })
    for await (const chunk of stream) {
      signal.throwIfAborted()
      if (finished) throw new Error('审核结束后继续返回数据')
      size += Buffer.byteLength(JSON.stringify(chunk))
      if (size > MAX_OUTPUT_BYTES) throw new Error('审核输出超过预算')
      assembler.push(chunk)
      if (chunk.type === 'finish') {
        finished = true
        if (!['stop', 'tool-calls'].includes(chunk.reason.kind))
          throw new Error('审核输出没有正常结束')
      }
    }
    signal.throwIfAborted()
    if (!finished) throw new Error('审核缺少结束标记')
    const blocks = assembler.blocks()
    if (assembler.finish.kind === 'stop') {
      const last = blocks.at(-1)
      if (last?.type !== 'text' || blocks.slice(0, -1).some(block => block.type !== 'reasoning'))
        throw new Error('审核必须返回唯一最终答复')
      return assessmentSchema.parse(parseObject(last.text))
    }
    const calls = blocks.filter(block => block.type === 'tool-call')
    if (
      !calls.length ||
      blocks.some(block => !['text', 'reasoning', 'tool-call'].includes(block.type))
    )
      throw new Error('审核工具调用结构无效')
    if (round === 3) throw new ReviewBudgetError()
    messages.push(
      createAssistantMessage({
        content: blocks,
        source: {
          provider,
          model,
          ...(assembler.replayState ? { replayState: assembler.replayState } : {}),
        },
      }),
    )
    for (const call of calls) {
      if (toolIds.has(call.id)) throw new Error('审核重复使用工具调用标识')
      toolIds.add(call.id)
      // 取证顺序执行，版本检查与预算不能被并行请求穿透。
      // oxlint-disable-next-line no-await-in-loop
      const result = await evidence.inspect(call.name, call.arguments, signal)
      messages.push(
        createUserMessage({
          source: { kind: 'tool', callId: call.id },
          content: [
            {
              type: 'tool-result',
              toolCallId: call.id,
              content: [{ type: 'text', text: JSON.stringify(result) }],
            },
          ],
        }),
      )
    }
  }
  throw new ReviewBudgetError()
}

/** 即使提供方没有及时响应取消，外层也不继续等待或接受迟到结果。 */
export async function withReviewCancellation<T>(
  signal: AbortSignal,
  task: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted()
  let onAbort: (() => void) | undefined
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error('自动审核已取消'))
      signal.addEventListener('abort', onAbort, { once: true })
    })
    return await Promise.race([task(), cancelled])
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}
