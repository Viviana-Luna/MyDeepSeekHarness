/** MyDSH 单次提权审核：复用审批瀑布，不改变会话沙箱或普通工具守卫。 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolDispatchExecution, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-fs'
import { changesAuthority, isRecord, registerReviewContext } from './context.ts'
import {
  ProtectedEvidenceError,
  ReviewBudgetError,
  ReviewEvidence,
  StaleEvidenceError,
} from './evidence.ts'
import {
  BALANCED_PRESET,
  CONSERVATIVE_PRESET,
  decideAssessment,
  MAX_ATTEMPTS_PER_TURN,
  MAX_INPUT_BYTES,
  REASONS,
  type Assessment,
  type ReasonCode,
  type ReviewDecision,
  type ReviewPolicy,
} from './policy.ts'
import { registerReviewAudit } from './audit.ts'
import { reviewWithModel, withReviewCancellation } from './reviewer.ts'

export const name = 'mydsh-auto-review'
export const PRESET = CONSERVATIVE_PRESET
export { BALANCED_PRESET }
export const inject = [
  'approval',
  'llm',
  'tools',
  'permissionPresets',
  'sandboxPolicy',
  'sessionProjections',
]
export interface Config {
  timeoutMs: number
}
export const Config: z<Config> = z.object({
  timeoutMs: z.number().step(1).min(1).max(120_000).default(60_000),
})
const SUPPORTED = new Set(['bash', 'pwsh', 'powershell', 'exec_command', 'write', 'edit'])

/** 展示文字不参与操作身份；权限目标另由结构化审批描述校验。 */
function actionOf(exec: ToolExecution | ToolDispatchExecution): string | undefined {
  if (!SUPPORTED.has(exec.name) || !isRecord(exec.arguments)) return undefined
  const args = Object.fromEntries(
    Object.entries(exec.arguments)
      .filter(([key]) => !['sandbox_permissions', 'justification', 'description'].includes(key))
      .sort(([a], [b]) => a.localeCompare(b)),
  )
  const text = JSON.stringify({
    tool: exec.name,
    cwd: exec.agent?.session.header.cwd,
    arguments: args,
  })
  return Buffer.byteLength(text) <= MAX_INPUT_BYTES ? text : undefined
}
function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function apply(ctx: Context, config: Config): void {
  const lifetime = new AbortController()
  const active = new AsyncLocalStorage<{ exec: ToolDispatchExecution; live: boolean }>()
  const versions = new WeakMap<object, number>()
  const denials = new WeakMap<Session, Map<string, number>>()
  const reviewed = new WeakMap<Session, { turn: number; actions: Set<string> }>()
  ctx.effect(() => () => {
    lifetime.abort()
    active.disable()
  })
  registerReviewContext(ctx)
  registerReviewAudit(ctx)
  const contextOf = (session: Session) =>
    ctx.sessionProjections.stateOf(session, 'autoReviewContext')
  const policyOf = (agent: Agent): ReviewPolicy | undefined => {
    if (
      ctx.sandboxPolicy.resolve({ session: agent.session }).mode !== 'workspace-write' ||
      (ctx.approval.overrideOf(agent.session) ?? ctx.approval.config.policy ?? 'ask') !== 'ask'
    )
      return undefined
    const value = ctx.permissionPresets.current(agent.session)
    return value === BALANCED_PRESET ? 'balanced' : value === PRESET ? 'conservative' : undefined
  }

  ctx.on(
    'tools/execute',
    async (exec, next) => {
      if (exec.agent) versions.set(exec, contextOf(exec.agent.session)?.revision ?? -1)
      const scope = { exec, live: true }
      try {
        return await active.run(scope, next)
      } finally {
        scope.live = false
      }
    },
    { prepend: true },
  )
  const rememberDenial = (exec: Readonly<ToolExecution>) => {
    if (lifetime.signal.aborted || !exec.agent || exec.signal.aborted || !policyOf(exec.agent))
      return
    if (!isRecord(exec.arguments) || exec.arguments.sandbox_permissions !== undefined) return
    const state = contextOf(exec.agent.session)
    const action = actionOf(exec)
    if (!state?.open || !action || versions.get(exec) !== state.revision) return
    const entries = denials.get(exec.agent.session) ?? new Map<string, number>()
    denials.set(exec.agent.session, entries)
    const key = hash(action)
    entries.delete(key)
    entries.set(key, state.revision)
    if (entries.size > MAX_ATTEMPTS_PER_TURN) entries.delete(entries.keys().next().value!)
  }
  ctx.on('tools/result', (exec, result) => {
    const value = !result.isError && isRecord(result.value) ? result.value : undefined
    if (
      (result.isError && result.error.info?.code === 'FS_SANDBOX_DENIED') ||
      (value &&
        isRecord(value.sandbox) &&
        value.sandbox.mode === 'workspace-write' &&
        value.sandbox.denied === true &&
        value.sandbox.runnerFailed !== true)
    )
      rememberDenial(exec)
  })
  ctx.on('tools/background-sandbox', (exec, facts) => {
    if (facts.mode === 'workspace-write' && facts.denied && !facts.runnerFailed)
      rememberDenial(exec)
  })

  ctx.on(
    'approval/request',
    async (req, next): Promise<ApprovalOutcome> => {
      const scope = active.getStore()
      const policy = policyOf(req.agent)
      if (!scope?.live || !policy || !req.requestId) return next()
      const { exec } = scope
      const args = isRecord(exec.arguments) ? exec.arguments : {}
      const action = actionOf(exec)
      const toolMatches =
        req.toolName === exec.name ||
        (exec.name === 'exec_command' && ['bash', 'pwsh'].includes(req.toolName)) ||
        (exec.name === 'powershell' && req.toolName === 'pwsh')
      if (
        exec.agent !== req.agent ||
        exec.callId !== req.callId ||
        !toolMatches ||
        req.escalation?.from !== 'workspace-write' ||
        req.escalation.to !== 'danger-full-access' ||
        args.sandbox_permissions !== req.escalation.to ||
        !action
      )
        return next()
      const session = req.agent.session
      const state = contextOf(session)
      if (!state?.open) return 'cancelled'
      const inputHash = hash(action)
      const invalidated = new AbortController()
      const cancelled = AbortSignal.any([
        lifetime.signal,
        invalidated.signal,
        exec.signal,
        ...(req.signal ? [req.signal] : []),
      ])
      const stop = ctx.on('session/event', (changed, event) => {
        if (changed === session && changesAuthority(event)) invalidated.abort()
      })
      const current = () =>
        !cancelled.aborted &&
        scope.live &&
        policyOf(req.agent) === policy &&
        contextOf(session)?.revision === state.revision &&
        contextOf(session)?.open === true
      const route = {
        provider: session.requestHeader()?.config.provider ?? req.agent.options.provider,
        model: session.requestHeader()?.config.model ?? req.agent.options.model,
      }
      const audit = (
        decision: ReviewDecision,
        code: ReasonCode,
        assessment?: Assessment,
        evidence?: ReviewEvidence,
      ) => {
        if (!current()) return
        session.append('approval/reviewed', {
          version: 2,
          requestId: req.requestId!,
          callId: exec.callId,
          toolName: exec.name,
          inputHash,
          policy,
          contextVersion: state.revision,
          decision,
          reason: REASONS[code],
          reasonCode: code,
          ...(route.provider && route.model
            ? { provider: route.provider, model: route.model }
            : {}),
          ...(assessment ? { risk: assessment.risk, authorization: assessment.authorization } : {}),
          ...(evidence ? { evidence: evidence.references } : {}),
        })
      }
      const extraPath = ['write', 'edit'].includes(exec.name)
        ? typeof args.file_path === 'string'
          ? args.file_path
          : typeof args.path === 'string'
            ? args.path
            : undefined
        : undefined
      const evidence = new ReviewEvidence(ctx.get('fs'), session.header.cwd ?? '', extraPath)
      const manual = async (
        code: ReasonCode,
        assessment?: Assessment,
      ): Promise<ApprovalOutcome> => {
        audit('manual', code, assessment, evidence)
        if (!current()) return 'cancelled'
        const outcome = await withReviewCancellation(cancelled, next).catch(
          () => 'cancelled' as const,
        )
        if (!current()) return 'cancelled'
        if (outcome === 'allowed-once') {
          try {
            await withReviewCancellation(cancelled, () => evidence.validate(cancelled))
          } catch {
            audit('cancelled', 'changed')
            return 'cancelled'
          }
        }
        return current() ? outcome : 'cancelled'
      }
      try {
        if (!current()) return 'cancelled'
        session.append('approval/review-started', {
          version: 2,
          requestId: req.requestId,
          callId: exec.callId,
          toolName: exec.name,
          inputHash,
          policy,
        })
        const prior = denials.get(session)
        const seen = prior?.get(inputHash) === state.revision
        prior?.delete(inputHash)
        let attempts = reviewed.get(session)
        if (attempts?.turn !== state.turn) {
          attempts = { turn: state.turn, actions: new Set() }
          reviewed.set(session, attempts)
        }
        const repeated =
          attempts.actions.has(inputHash) || attempts.actions.size >= MAX_ATTEMPTS_PER_TURN
        if (!repeated) attempts.actions.add(inputHash)
        if (state.plan) {
          audit('rejected', 'plan')
          return 'rejected'
        }
        if (repeated) return await manual('repeated')
        if (
          !seen ||
          state.incomplete ||
          !state.entries.some(entry => entry.role === 'human') ||
          !session.header.cwd
        )
          return await manual('missing')
        if (!route.provider || !route.model) {
          audit('failed', 'failed')
          return 'unavailable'
        }
        const deadline = new AbortController()
        const signal = AbortSignal.any([cancelled, deadline.signal])
        const timer = setTimeout(() => deadline.abort(), config.timeoutMs)
        let result: { assessment?: Assessment; decision: ReviewDecision; code: ReasonCode }
        try {
          result = await withReviewCancellation(signal, async () => {
            await evidence.prepare(signal)
            const assessment = await reviewWithModel(
              ctx,
              {
                provider: route.provider!,
                model: route.model!,
                session,
                context: state,
                action: JSON.parse(action),
                policy,
              },
              evidence,
              signal,
            )
            let decision = decideAssessment(
              assessment,
              policy,
              new Set(state.entries.filter(entry => entry.role === 'human').map(entry => entry.id)),
              evidence.count > 0,
            )
            if (decision === 'allowed-once' && evidence.incomplete) decision = 'manual'
            if (decision === 'allowed-once') await evidence.validate(signal)
            return {
              assessment,
              decision,
              code:
                decision === 'allowed-once'
                  ? 'allowed'
                  : decision === 'rejected'
                    ? 'denied'
                    : 'manual',
            }
          })
        } catch (error) {
          if (error instanceof ProtectedEvidenceError)
            result = { decision: 'rejected', code: 'protected' }
          else if (error instanceof ReviewBudgetError)
            result = { decision: 'manual', code: 'budget' }
          else if (error instanceof StaleEvidenceError)
            result = { decision: 'cancelled', code: 'changed' }
          else result = { decision: 'failed', code: 'failed' }
        } finally {
          clearTimeout(timer)
          deadline.abort()
        }
        const { decision, code, assessment } = result
        if (!current()) return 'cancelled'
        if (decision === 'manual') return await manual(code, assessment)
        audit(decision, code, assessment, evidence)
        if (!current()) return 'cancelled'
        return decision === 'allowed-once'
          ? 'allowed-once'
          : decision === 'rejected'
            ? 'rejected'
            : decision === 'cancelled'
              ? 'cancelled'
              : 'unavailable'
      } finally {
        stop()
        invalidated.abort()
      }
    },
    { prepend: true },
  )
}
