/** 同一份 Session 日志投影审核状态；人工结果与取消仍由审批服务拥有。 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type { Assessment, ReasonCode, ReviewDecision, ReviewPolicy } from './policy.ts'

interface ReviewStarted {
  version: 2
  requestId: string
  callId: string
  toolName: string
  inputHash: string
  policy: ReviewPolicy
}
interface ReviewAudit {
  callId: string
  toolName: string
  inputHash: string
  decision: ReviewDecision
  reason: string
  version?: 2
  requestId?: string
  policy?: ReviewPolicy
  contextVersion?: number
  reasonCode?: ReasonCode
  provider?: string
  model?: string
  risk?: Assessment['risk']
  authorization?: Assessment['authorization']
  evidence?: string[]
}
const statusSchema = z.enum([
  'reviewing',
  'allowed-once',
  'manual',
  'approved-manually',
  'rejected',
  'failed',
  'cancelled',
])
const itemSchema = z.object({
  requestId: z.string(),
  callId: z.string(),
  toolName: z.string(),
  status: statusSchema,
  policy: z.enum(['conservative', 'balanced']),
  reason: z.string(),
  risk: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  authorization: z.enum(['unknown', 'low', 'medium', 'high']).optional(),
})
export type ReviewDisplay = z.infer<typeof itemSchema>
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'approval/review-started': ReviewStarted
    'approval/reviewed': ReviewAudit
  }
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    approvalReviews: ReviewDisplay[]
  }
  interface SessionProjectionMap {
    approvalReviews: ReviewDisplay[]
  }
}

export function registerReviewAudit(ctx: Context): void {
  const schema = z.array(itemSchema).max(32)
  ctx.sessionProjections.register({
    key: 'approvalReviews',
    stateVersion: 1,
    stateSchema: schema,
    init: () => [],
    apply: (state, event) => {
      if (event.type === 'approval/review-started' || event.type === 'approval/reviewed') {
        const data = event.data
        const requestId = data.requestId ?? `legacy:${data.callId}`
        const item: ReviewDisplay = {
          requestId,
          callId: data.callId,
          toolName: data.toolName,
          policy: data.policy ?? 'conservative',
          status: event.type === 'approval/reviewed' ? event.data.decision : 'reviewing',
          reason:
            event.type === 'approval/reviewed' ? event.data.reason : '正在核对风险、授权与必要证据',
          ...(event.type === 'approval/reviewed' && event.data.risk
            ? { risk: event.data.risk }
            : {}),
          ...(event.type === 'approval/reviewed' && event.data.authorization
            ? { authorization: event.data.authorization }
            : {}),
        }
        return [...state.filter(prior => prior.requestId !== requestId), item].slice(-32)
      }
      if (event.type === 'approval/decided') {
        return state.map(item => {
          if (
            item.requestId !== event.data.id ||
            (item.status !== 'reviewing' && item.status !== 'manual')
          )
            return item
          const status: ReviewDisplay['status'] =
            event.data.outcome === 'allowed-once'
              ? 'approved-manually'
              : event.data.outcome === 'unavailable'
                ? 'failed'
                : event.data.outcome
          return { ...item, status }
        })
      }
      if (event.type === 'turn/end' || event.type === 'session/end-seed') {
        return state.map(item =>
          item.status === 'reviewing' || item.status === 'manual'
            ? { ...item, status: 'cancelled' as const }
            : item,
        )
      }
      return state
    },
    wire: { viewSchema: schema, view: state => state },
  })
}
