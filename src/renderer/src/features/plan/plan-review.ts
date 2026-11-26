import type { DesktopPendingInteraction } from '../../../../shared/session-live.ts'
import type { ConversationToolItem } from '../../../../shared/session-projection.ts'

/** 与核心的审阅意图对齐；普通问题和不完整协议仍走问答界面。 */
export function planReviewOf(interaction: DesktopPendingInteraction) {
  if (interaction.kind !== 'question' || interaction.questions.length !== 1) return null
  const question = interaction.questions[0]!
  const intent = question.intent
  if (
    intent?.kind !== 'plan-review' ||
    !question.detail?.trim() ||
    question.multiSelect ||
    !question.options?.length ||
    question.options.length > 2 ||
    !question.options.some(option => option.label === intent.approve)
  )
    return null
  return {
    id: question.id,
    text: question.detail,
    approve: intent.approve,
    documentId: intent.callId ?? interaction.key,
  }
}

export function planSummary(markdown: string) {
  const lines = markdown
    .replace(/```[\s\S]*?```/gu, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .split(/\r?\n/u)
    .map(line =>
      line
        .replace(/^\s*(?:#{1,6}\s+|[-*>]\s+|\d+\.\s+)/u, '')
        .replace(/[*_`~]/gu, '')
        .trim(),
    )
    .filter(Boolean)
  return { title: lines[0] || '执行计划', summary: lines.slice(1, 5).join(' ').slice(0, 600) }
}

/** 历史入口直接读取 Session 工具调用，刷新后也能重新打开同一份计划。 */
export function planFromTool(item: ConversationToolItem): string | null {
  if (item.name !== 'exit_plan_mode' || item.argumentsText === null) return null
  try {
    const args: unknown = JSON.parse(item.argumentsText)
    if (typeof args !== 'object' || args === null || !('plan' in args)) return null
    return typeof args.plan === 'string' && args.plan.trim() && args.plan.length <= 256 * 1024
      ? args.plan
      : null
  } catch {
    return null
  }
}
