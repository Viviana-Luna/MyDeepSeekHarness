import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { currentModelSelection } from '@deepseek-ai/dsh-agent'
import type { CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import { PROVIDER } from '@mydsh/llm-chatgpt'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'

/** GPT 使用服务端原生压缩；其他提供方沿用既有摘要策略和手动命令。 */
export default class ChatGPTCompactionEngine extends BasicCompactionEngine {
  static override inject = [...BasicCompactionEngine.inject, 'chatgpt']

  constructor(ctx: Context, config: BasicCompactionConfig = {}) {
    super(ctx, config)
    const registered = new Map<string, () => Promise<void>>()
    // 预设实例可以共享；用带会话作用域的事件登记，不能把全局模型调用当作会话归属。
    ctx.on(
      'agent/pre-step',
      ({ agent }, next) => {
        if (this.config.auto && !registered.has(agent.id)) {
          registered.set(
            agent.id,
            ctx.chatgpt.enableNativeCompaction(agent.id, this.config.thresholdRatio),
          )
        }
        return next()
      },
      { prepend: true },
    )
    ctx.on('agent/disposed', ({ agent }) => {
      void registered.get(agent.id)?.()
      registered.delete(agent.id)
    })
  }

  private isChatGPT(agent: Agent, assembled = false): boolean {
    return (
      (currentModelSelection(agent.ctx, assembled)?.provider ??
        agent.session.requestHeader()?.config.provider ??
        agent.options.provider) === PROVIDER
    )
  }

  override async compactIfNeeded(agent: Agent, trigger: CompactionTrigger, signal: AbortSignal) {
    // 原生压缩在 Responses 请求中完成，不在前一步抢先生成文本摘要。
    if (!this.isChatGPT(agent, true)) return super.compactIfNeeded(agent, trigger, signal)
    signal.throwIfAborted()
    const selected = currentModelSelection(agent.ctx, true) ?? agent.options
    const previous = agent.session.requestHeader()?.config
    if (
      previous?.provider === PROVIDER &&
      (selected.model === undefined || selected.model === previous.model)
    ) {
      // 服务端已拒绝原生压缩前的输入时，重新打开会话也不能反复发送同一超长历史。
      for (const event of agent.session.snapshotEvents().toReversed()) {
        if (
          event.type === 'assistant/message' ||
          (typeof event.surfaceOp === 'object' && event.surfaceOp.op === 'replace')
        )
          break
        if (
          event.type === 'turn/end' &&
          event.data.reason.kind === 'error' &&
          event.data.reason.error.code === 'NATIVE_COMPACTION_CONTEXT_EXCEEDED'
        ) {
          throw new Error(
            '服务端已拒绝原生压缩前的超长输入，未重复发送。原会话已保留；请新建会话并明确携带必要上下文，当前订阅不支持独立的手动压缩',
          )
        }
      }
    }
    return null
  }

  override compactNow(agent: Agent, signal: AbortSignal, sourceCommandId?: CommandId) {
    signal.throwIfAborted()
    if (this.isChatGPT(agent)) {
      throw new Error('当前订阅支持随对话自动原生压缩，尚未开放独立的手动压缩接口')
    }
    return super.compactNow(agent, signal, sourceCommandId)
  }
}
