/** 从同一份 Session 日志保留授权与约束，不用最近几条消息替代完整权限依据。 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import { MAX_CONTEXT_BYTES } from './policy.ts'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
const entrySchema = z.object({
  id: z.string(),
  role: z.enum(['human', 'parent', 'constraint', 'checkpoint', 'fact']),
  text: z.string(),
  source: z.string(),
})
export const reviewContextSchema = z.object({
  revision: z.number(),
  turn: z.number(),
  open: z.boolean(),
  plan: z.boolean(),
  child: z.boolean(),
  entries: z.array(entrySchema),
  bytes: z.number(),
  incomplete: z.boolean(),
})
export type ReviewContext = z.infer<typeof reviewContextSchema>
export type ContextEntry = z.infer<typeof entrySchema>
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    autoReviewContext: ReviewContext
  }
}

/** 这些变化撤回自动与正在等待人工的授权；普通工具输出不改授权代次。 */
export function changesAuthority(event: { type: string; data: unknown }): boolean {
  if (
    [
      'permission/preset',
      'sandbox/mode',
      'approval/policy',
      'plan/mode',
      'model/selection',
      'turn/start',
      'turn/end',
      'session/end-seed',
    ].includes(event.type)
  )
    return true
  if (!isRecord(event.data)) return false
  if (event.type === 'command/run' && event.data.name === 'plan') return true
  if (event.type === 'agent/inbox/spliced' && Array.isArray(event.data.inserted)) {
    return event.data.inserted.some(
      message =>
        isRecord(message) &&
        isRecord(message.source) &&
        ['user', 'agent-instructions'].includes(String(message.source.kind)),
    )
  }
  return (
    event.type === 'user/message' &&
    isRecord(event.data.source) &&
    (['user', 'agent-instructions'].includes(String(event.data.source.kind)) ||
      (event.data.source.kind === 'plugin' && event.data.source.plugin === 'agent-instructions'))
  )
}

function appendEntry(
  state: ReviewContext,
  entry: ContextEntry,
  incomplete: boolean,
): ReviewContext {
  const bytes = state.bytes + Buffer.byteLength(JSON.stringify(entry))
  // 不丢掉前面的限制换取较新的授权；超预算后明确不再自动授权。
  if (bytes > MAX_CONTEXT_BYTES) return { ...state, incomplete: true }
  return {
    ...state,
    entries: [...state.entries, entry],
    bytes,
    incomplete: state.incomplete || incomplete,
  }
}

export function foldReviewContext(state: ReviewContext, event: SessionEvent): ReviewContext {
  let next = changesAuthority(event) ? { ...state, revision: event.seq } : state
  const data: unknown = event.data
  if (!isRecord(data)) return next
  if (event.type === 'turn/start') return { ...next, open: true, turn: Number(data.turn) }
  if (event.type === 'turn/end' || event.type === 'session/end-seed')
    return { ...next, open: false }
  // 命令与计划事件由可选插件扩展，按事件名和已检查的 payload 读取，不引入运行依赖。
  if (String(event.type) === 'plan/mode') return { ...next, plan: data.active === true }
  if (String(event.type) === 'command/run' && data.name === 'plan' && data.args !== 'off')
    return { ...next, plan: true }
  if (event.type !== 'user/message' || !isRecord(data.source) || !Array.isArray(data.content))
    return next
  const source = data.source
  let role: ContextEntry['role']
  if (source.kind === 'user')
    role = state.child && typeof source.rpcId !== 'string' ? 'parent' : 'human'
  else if (
    source.kind === 'agent-instructions' ||
    (source.kind === 'plugin' && source.plugin === 'agent-instructions')
  )
    role = 'constraint'
  else if (
    source.kind === 'compaction' ||
    (source.kind === 'plugin' && String(source.plugin).includes('compaction'))
  )
    role = 'checkpoint'
  else return next
  const text = data.content
    .filter(
      (block): block is { type: string; text: string } =>
        isRecord(block) && block.type === 'text' && typeof block.text === 'string',
    )
    .map(block => block.text)
    .join('\n')
  const incomplete = data.content.some(block => !isRecord(block) || block.type !== 'text')
  next = appendEntry(
    next,
    { id: `${role}:${event.seq}`, role, text, source: JSON.stringify(source) },
    incomplete,
  )
  return next
}

export function registerReviewContext(ctx: Context): void {
  ctx.sessionProjections.register({
    key: 'autoReviewContext',
    stateVersion: 2,
    stateSchema: reviewContextSchema,
    init: header => ({
      revision: -1,
      turn: 0,
      open: false,
      plan: false,
      child: header.origin === 'subagent',
      entries: [],
      bytes: 0,
      incomplete: false,
    }),
    apply: foldReviewContext,
  })
}
