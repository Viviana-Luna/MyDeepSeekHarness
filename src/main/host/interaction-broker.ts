/**
 * 主进程待用户响应交互（权限审批与多选题）状态代理。
 *
 * 跟踪当前实时事件流推送的未决交互条目，复核 renderer 回传的审批或问答载荷后
 * 提交至 `$events/result`，并在流断开或重置时统一清空内存表。
 */

import type {
  DesktopInteractionReceipt,
  DesktopPendingInteraction,
  DesktopQuestionAnswerItem,
  DesktopQuestionItem,
  DesktopSessionFrame,
} from '../../shared/session-live.ts'
import { asRecord } from '../../shared/validation.ts'
import type { MydshRuntimeSupervisor } from '../runtime/runtime-supervisor.ts'
import { respondDshInteraction, type DshRemoteEventOutcome } from './host-client.ts'
import type { DshRemoteInteractionTarget } from './host-event-stream.ts'

interface PendingInteractionEntry {
  readonly sessionId: string
  readonly interaction: DesktopPendingInteraction
  readonly remote?: DshRemoteInteractionTarget
  responded: boolean
}

/** 创建待用户响应交互代理的输入依赖。 */
export interface InteractionBrokerOptions {
  readonly targetUrl: URL
  readonly supervisor: MydshRuntimeSupervisor
  readonly sendSessionFrame: (frame: DesktopSessionFrame) => void
}

/** 待用户响应交互代理实例。 */
export interface InteractionBroker {
  observeFrame(frame: DesktopSessionFrame, remote?: DshRemoteInteractionTarget): void
  respond(submission: unknown): Promise<DesktopInteractionReceipt>
  clear(): void
}

function interactionEntryKey(sessionId: string, key: string): string {
  return `${sessionId}\u0000${key}`
}

function hasOnlyFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).every(field => fields.includes(field))
}

function parseOptionalCustomAnswer(raw: unknown): string | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 16 * 1024) {
    throw new Error('自定义回答无效或过长')
  }
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}

function parseQuestionAnswers(
  value: unknown,
  questions: readonly DesktopQuestionItem[],
): DesktopQuestionAnswerItem[] {
  if (!Array.isArray(value) || value.length !== questions.length) {
    throw new Error('问题回答必须完整覆盖当前问题')
  }
  return value.map((candidate, index) => {
    const answer = asRecord(candidate)
    const question = questions[index]
    if (
      answer === null ||
      question === undefined ||
      !hasOnlyFields(answer, ['id', 'selected', 'custom']) ||
      answer.id !== question.id ||
      !Array.isArray(answer.selected) ||
      answer.selected.length > 64 ||
      answer.selected.some(
        item => typeof item !== 'string' || item.length === 0 || item.length > 1_000,
      )
    ) {
      throw new Error('问题回答包含无效字段')
    }
    const selected = answer.selected as string[]
    if (new Set(selected).size !== selected.length) throw new Error('问题回答包含重复选项')
    const optionLabels = new Set((question.options ?? []).map(option => option.label))
    if (selected.some(label => !optionLabels.has(label))) throw new Error('问题回答包含未知选项')
    if (question.multiSelect !== true && selected.length > 1) {
      throw new Error('单选问题只能选择一个选项')
    }
    const custom = parseOptionalCustomAnswer(answer.custom)
    if (question.multiSelect !== true && custom !== undefined && selected.length > 0) {
      throw new Error('单选问题的自定义回答不能与选项同时提交')
    }
    return {
      id: question.id,
      selected,
      ...(custom === undefined ? {} : { custom }),
    }
  })
}

function parseInteractionSubmission(
  input: unknown,
  entry: PendingInteractionEntry,
): DshRemoteEventOutcome {
  const submission = asRecord(input)
  if (
    submission === null ||
    typeof submission.kind !== 'string' ||
    typeof submission.sessionId !== 'string' ||
    typeof submission.key !== 'string' ||
    submission.sessionId !== entry.sessionId ||
    submission.key !== entry.interaction.key
  ) {
    throw new Error('待响应交互请求无效或已经过期')
  }
  const interaction = entry.interaction
  if (interaction.kind === 'approval') {
    if (
      !hasOnlyFields(submission, ['kind', 'sessionId', 'key', 'outcome']) ||
      submission.kind !== 'approval' ||
      (submission.outcome !== 'allowed-once' && submission.outcome !== 'rejected')
    ) {
      throw new Error('审批决定无效')
    }
    return { kind: 'result', value: submission.outcome }
  }
  if (submission.kind === 'question-cancel') {
    if (!hasOnlyFields(submission, ['kind', 'sessionId', 'key'])) {
      throw new Error('问题取消请求无效')
    }
    return {
      kind: 'rejected',
      error: {
        name: 'Error',
        code: 'cancelled',
        message: '用户关闭了当前问题',
      },
    }
  }
  if (
    submission.kind !== 'question' ||
    !hasOnlyFields(submission, ['kind', 'sessionId', 'key', 'answers'])
  ) {
    throw new Error('问题回答无效')
  }
  return {
    kind: 'result',
    value: { answers: parseQuestionAnswers(submission.answers, interaction.questions) },
  }
}

function buildResolvedFrame(
  entry: PendingInteractionEntry,
  outcome: DshRemoteEventOutcome,
): DesktopSessionFrame {
  if (entry.interaction.kind === 'approval') {
    const approvalOutcome =
      outcome.kind === 'result' && outcome.value === 'allowed-once' ? 'allowed-once' : 'rejected'
    return {
      type: 'session/interaction-resolved',
      sessionId: entry.sessionId,
      resolution: {
        kind: 'approval',
        approvalId: entry.interaction.approvalId,
        outcome: approvalOutcome,
      },
    }
  }
  return {
    type: 'session/interaction-resolved',
    sessionId: entry.sessionId,
    resolution: {
      kind: 'question',
      key: entry.interaction.key,
      outcome: outcome.kind === 'result' ? 'answered' : 'cancelled',
    },
  }
}

function recordInteractionFrame(
  pendingInteractions: Map<string, PendingInteractionEntry>,
  frame: DesktopSessionFrame,
  remote?: DshRemoteInteractionTarget,
): void {
  if (frame.type === 'session/interaction-requested') {
    const key = interactionEntryKey(frame.sessionId, frame.interaction.key)
    const existing = pendingInteractions.get(key)
    const interactionRemote = remote ?? existing?.remote
    pendingInteractions.set(key, {
      sessionId: frame.sessionId,
      interaction: frame.interaction,
      ...(interactionRemote === undefined ? {} : { remote: interactionRemote }),
      responded: existing?.responded ?? false,
    })
    return
  }
  if (frame.type !== 'session/interaction-resolved') return
  if (frame.resolution.kind === 'question') {
    pendingInteractions.delete(interactionEntryKey(frame.sessionId, frame.resolution.key))
    return
  }
  for (const [key, entry] of pendingInteractions) {
    if (
      entry.sessionId === frame.sessionId &&
      entry.interaction.kind === 'approval' &&
      entry.interaction.approvalId === frame.resolution.approvalId
    ) {
      pendingInteractions.delete(key)
    }
  }
}

async function submitPendingInteraction(
  options: InteractionBrokerOptions,
  pendingInteractions: Map<string, PendingInteractionEntry>,
  submission: unknown,
): Promise<DesktopInteractionReceipt> {
  const { targetUrl, supervisor, sendSessionFrame } = options
  const state = supervisor.getState()
  if (state.kind !== 'ready') throw new Error('MyDSH 运行核心 当前不可用')
  const value = asRecord(submission)
  const sessionId = value?.sessionId
  const key = value?.key
  if (
    typeof sessionId !== 'string' ||
    sessionId.length === 0 ||
    sessionId.length > 512 ||
    typeof key !== 'string' ||
    key.length === 0 ||
    key.length > 1_024
  ) {
    throw new Error('待响应交互请求无效')
  }
  const entryKey = interactionEntryKey(sessionId, key)
  const entry = pendingInteractions.get(entryKey)
  if (entry === undefined) return { accepted: false, reason: 'not-pending' }
  if (entry.responded) return { accepted: false, reason: 'in-flight' }
  if (entry.remote === undefined) throw new Error('当前交互不属于可应答的 Remote 请求')
  const outcome = parseInteractionSubmission(submission, entry)
  entry.responded = true
  try {
    const receipt = await respondDshInteraction({
      targetUrl,
      clientId: entry.remote.clientId,
      eventId: entry.remote.eventId,
      outcome,
      fetchImpl: supervisor.fetch,
      ...(state.sessionCookie === undefined ? {} : { cookie: state.sessionCookie }),
    })
    if (!receipt.accepted) {
      if (receipt.reason === 'not-pending') pendingInteractions.delete(entryKey)
      else entry.responded = false
    } else {
      const resolution = buildResolvedFrame(entry, outcome)
      recordInteractionFrame(pendingInteractions, resolution)
      sendSessionFrame(resolution)
    }
    return receipt
  } catch (error) {
    entry.responded = false
    console.warn('DSH 待响应交互提交失败：', error)
    throw new Error(error instanceof Error ? error.message : 'DSH 待响应交互提交失败', {
      cause: error,
    })
  }
}

/** 创建主进程待用户响应交互状态代理。 */
export function createInteractionBroker(options: InteractionBrokerOptions): InteractionBroker {
  const pendingInteractions = new Map<string, PendingInteractionEntry>()
  return {
    observeFrame(frame, remote) {
      recordInteractionFrame(pendingInteractions, frame, remote)
    },
    respond(submission) {
      return submitPendingInteraction(options, pendingInteractions, submission)
    },
    clear() {
      pendingInteractions.clear()
    },
  }
}
