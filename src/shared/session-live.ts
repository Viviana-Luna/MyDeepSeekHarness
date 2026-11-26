import type { CanonicalSessionEvent } from './session-projection.js'
import { parsePluginProjectionChange, type PluginProjectionChange } from './plugin-projections.js'
import {
  parseDesktopCommandDoneEventData,
  parseDesktopCommandRunEventData,
} from './session-capabilities.js'
import { boundedString, isRecord, type UnknownRecord } from './validation.ts'

export type SessionQueuePlacement = 'queued' | 'steering' | 'context'

export const DESKTOP_QUEUE_VISIBLE_LIMIT = 200
export const DESKTOP_QUEUE_PREVIEW_LIMIT = 500
export const DESKTOP_QUEUE_EDIT_MAX_BYTES = 128 * 1024

export type DesktopQueueEditCapability =
  | {
      readonly kind: 'editable-text'
      readonly text: string
    }
  | {
      readonly kind: 'read-only'
      readonly reason: 'non-text' | 'multiple-blocks' | 'text-too-large'
    }

export interface DesktopQueuedMessage {
  readonly id: string
  readonly placement: SessionQueuePlacement
  readonly preview: string
  readonly previewTruncated: boolean
  readonly edit: DesktopQueueEditCapability
}

export interface DesktopQueueSnapshot {
  readonly items: readonly DesktopQueuedMessage[]
  readonly totalCount: number
  readonly omittedCount: number
  readonly truncated: boolean
}

export const EMPTY_DESKTOP_QUEUE_SNAPSHOT: DesktopQueueSnapshot = Object.freeze({
  items: Object.freeze([]),
  totalCount: 0,
  omittedCount: 0,
  truncated: false,
})

export type DesktopSessionQueueAction =
  | {
      readonly kind: 'edit'
      readonly content: readonly [{ readonly type: 'text'; readonly text: string }]
    }
  | {
      readonly kind: 'remove' | 'steer'
    }

export interface DesktopPermissionProjection {
  readonly currentValue: string
  /**
   * 可选预设。运行核心的 `permissions` 投影只发布当前值，选项来自进程级
   * `permissionPresets` Remote 目录，因此这里允许缺省；两者由 renderer 合并成
   * 一份可选列表，不把进程目录塞进每个 Session 的投影。
   */
  readonly options?: readonly {
    readonly value: string
    readonly name: string
    readonly description?: string
  }[]
}

export interface DesktopModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export interface DesktopModelSelectionProjection {
  readonly next: DesktopModelSelection | null
}

export interface DesktopQuestionOption {
  readonly label: string
  readonly description?: string
}

export interface DesktopQuestionItem {
  readonly id: string
  readonly question: string
  readonly header?: string
  readonly detail?: string
  readonly options?: readonly DesktopQuestionOption[]
  readonly multiSelect?: boolean
  readonly intent?: {
    readonly kind: 'plan-review'
    readonly approve: string
    readonly callId?: string
  }
}

export type DesktopPendingInteraction =
  | {
      readonly kind: 'question'
      readonly key: string
      readonly questions: readonly DesktopQuestionItem[]
    }
  | {
      readonly kind: 'approval'
      readonly key: string
      readonly approvalId: string
      readonly toolName: string
      readonly callId?: string
      readonly reason?: string
    }

export type DesktopInteractionResolution =
  | {
      readonly kind: 'question'
      readonly key: string
      readonly outcome: 'answered' | 'cancelled'
    }
  | {
      readonly kind: 'approval'
      readonly approvalId: string
      readonly outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
    }

export interface DesktopQuestionAnswerItem {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

export type DesktopInteractionSubmission =
  | {
      readonly kind: 'question'
      readonly sessionId: string
      readonly key: string
      readonly answers: readonly DesktopQuestionAnswerItem[]
    }
  | {
      readonly kind: 'question-cancel'
      readonly sessionId: string
      readonly key: string
    }
  | {
      readonly kind: 'approval'
      readonly sessionId: string
      readonly key: string
      readonly outcome: 'allowed-once' | 'rejected'
    }

export type DesktopInteractionReceipt =
  | {
      readonly accepted: true
    }
  | {
      readonly accepted: false
      readonly reason: 'not-pending' | 'bad-response' | 'in-flight'
    }

export type DesktopSessionFrame =
  | {
      readonly type: 'session/stream-reset'
    }
  | {
      readonly type: 'session/plugin-projections'
      readonly sessionId: string
      readonly change: PluginProjectionChange
    }
  | {
      readonly type: 'session/snapshot'
      readonly sessionId: string
      readonly events: readonly CanonicalSessionEvent[]
      readonly lastSeq: number
      readonly hasMore: boolean
    }
  | {
      readonly type: 'session/event'
      readonly sessionId: string
      readonly event: CanonicalSessionEvent
    }
  | {
      readonly type: 'session/permissions'
      readonly sessionId: string
      readonly seq: number
      readonly value: DesktopPermissionProjection
    }
  | {
      readonly type: 'session/title'
      readonly sessionId: string
      readonly seq: number
      readonly title: string
    }
  | {
      readonly type: 'session/model-selection'
      readonly sessionId: string
      readonly seq: number
      readonly value: DesktopModelSelectionProjection
    }
  | {
      readonly type: 'session/queue'
      readonly sessionId: string
      readonly queue: DesktopQueueSnapshot
    }
  | {
      readonly type: 'session/subscribed'
      readonly sessionId: string
      readonly lastSeq: number
    }
  | {
      readonly type: 'session/interaction-requested'
      readonly sessionId: string
      readonly interaction: DesktopPendingInteraction
    }
  | {
      readonly type: 'session/interaction-resolved'
      readonly sessionId: string
      readonly resolution: DesktopInteractionResolution
    }

export function parseDesktopModelSelection(value: unknown): DesktopModelSelection | null {
  if (!isRecord(value)) return null
  const provider = boundedString(value.provider, 160)
  const model = boundedString(value.model, 320)
  const reasoningEffort =
    value.reasoningEffort === undefined ? undefined : boundedString(value.reasoningEffort, 160)
  if (provider === null || model === null || reasoningEffort === null) return null
  return { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
}

export function parseDesktopModelSelectionProjection(
  value: unknown,
): DesktopModelSelectionProjection | null {
  if (!isRecord(value) || !Object.hasOwn(value, 'next')) return null
  if (value.next === null) return { next: null }
  const next = parseDesktopModelSelection(value.next)
  return next === null ? null : { next }
}

function sessionId(value: unknown): string | null {
  return boundedString(value, 512)
}

function contentBlocks(value: unknown): readonly UnknownRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function previewFrom(value: string): Pick<DesktopQueuedMessage, 'preview' | 'previewTruncated'> {
  const normalized = value.trim()
  const preview = normalized.slice(0, DESKTOP_QUEUE_PREVIEW_LIMIT)
  return {
    preview,
    previewTruncated: normalized.length > preview.length,
  }
}

function editCapability(
  value: unknown,
  blocks: readonly UnknownRecord[],
): { readonly edit: DesktopQueueEditCapability; readonly previewSource: string } {
  if (blocks.length === 0 && typeof value === 'string') {
    return utf8Bytes(value) <= DESKTOP_QUEUE_EDIT_MAX_BYTES
      ? { edit: { kind: 'editable-text', text: value }, previewSource: value }
      : { edit: { kind: 'read-only', reason: 'text-too-large' }, previewSource: value }
  }
  if (blocks.length === 1 && blocks[0]?.type === 'text' && typeof blocks[0].text === 'string') {
    const text = blocks[0].text
    return utf8Bytes(text) <= DESKTOP_QUEUE_EDIT_MAX_BYTES
      ? { edit: { kind: 'editable-text', text }, previewSource: text }
      : { edit: { kind: 'read-only', reason: 'text-too-large' }, previewSource: text }
  }
  if (
    blocks.length > 1 &&
    blocks.every(block => block.type === 'text' && typeof block.text === 'string')
  ) {
    return {
      edit: { kind: 'read-only', reason: 'multiple-blocks' },
      previewSource: blocks.map(block => block.text as string).join('\n'),
    }
  }
  const textParts = blocks
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
  return {
    edit: { kind: 'read-only', reason: 'non-text' },
    previewSource: textParts.length > 0 ? textParts.join('\n') : '包含非文本内容的消息',
  }
}

function queueItem(value: unknown): DesktopQueuedMessage | null {
  if (!isRecord(value)) return null
  const id = boundedString(value.id, 512)
  const message = isRecord(value.message) ? value.message : null
  // next-step 同时承载用户插话与插件注入；只有用户输入属于待处理消息。
  const placement =
    isRecord(message?.source) && message.source.kind !== 'user' ? 'context' : value.placement
  if (
    id === null ||
    (placement !== 'queued' && placement !== 'steering' && placement !== 'context')
  ) {
    return null
  }

  const blocks = message === null ? [] : contentBlocks(message.content)
  const capability = editCapability(value.text, blocks)
  const suppliedPreview = typeof value.preview === 'string' ? value.preview.trim() : ''
  const projectedPreview = previewFrom(
    suppliedPreview !== '' ? suppliedPreview : capability.previewSource || '待处理消息',
  )
  return { id, placement, ...projectedPreview, edit: capability.edit }
}

function projectedQueueItem(value: unknown): DesktopQueuedMessage | null {
  if (!isRecord(value)) return null
  const id = boundedString(value.id, 512)
  const placement = value.placement
  const preview =
    typeof value.preview === 'string' && value.preview.length <= DESKTOP_QUEUE_PREVIEW_LIMIT
      ? value.preview
      : null
  const previewTruncated = value.previewTruncated
  const edit = value.edit
  if (
    id === null ||
    (placement !== 'queued' && placement !== 'steering' && placement !== 'context') ||
    preview === null ||
    typeof previewTruncated !== 'boolean' ||
    !isRecord(edit)
  )
    return null
  if (
    edit.kind === 'editable-text' &&
    typeof edit.text === 'string' &&
    utf8Bytes(edit.text) <= DESKTOP_QUEUE_EDIT_MAX_BYTES
  ) {
    return {
      id,
      placement,
      preview,
      previewTruncated,
      edit: { kind: 'editable-text', text: edit.text },
    }
  }
  if (
    edit.kind === 'read-only' &&
    (edit.reason === 'non-text' ||
      edit.reason === 'multiple-blocks' ||
      edit.reason === 'text-too-large')
  ) {
    return {
      id,
      placement,
      preview,
      previewTruncated,
      edit: { kind: 'read-only', reason: edit.reason },
    }
  }
  return null
}

function projectedQueueSnapshot(value: unknown): DesktopQueueSnapshot | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    typeof value.totalCount !== 'number' ||
    !Number.isSafeInteger(value.totalCount) ||
    value.totalCount < 0 ||
    typeof value.omittedCount !== 'number' ||
    !Number.isSafeInteger(value.omittedCount) ||
    value.omittedCount < 0 ||
    typeof value.truncated !== 'boolean'
  )
    return null
  const items: DesktopQueuedMessage[] = []
  for (const item of value.items) {
    const parsed = projectedQueueItem(item)
    if (parsed === null) return null
    items.push(parsed)
  }
  if (
    items.length > DESKTOP_QUEUE_VISIBLE_LIMIT ||
    value.totalCount !== items.length + value.omittedCount ||
    value.truncated !== value.omittedCount > 0
  )
    return null
  return {
    items,
    totalCount: value.totalCount,
    omittedCount: value.omittedCount,
    truncated: value.truncated,
  }
}

/** 私有回放只留在 Runtime；桌面出口复制需要修改的层，不改变原始日志。 */
export function publicSessionEventData(value: unknown): unknown {
  if (!isRecord(value)) return value
  let result = value
  if (
    isRecord(value.message) &&
    isRecord(value.message.source) &&
    Object.hasOwn(value.message.source, 'replayState')
  ) {
    const { replayState: _privateReplay, ...source } = value.message.source
    result = { ...result, message: { ...value.message, source } }
  }
  // 持久 Assistant 流的 finish 同样持有回放状态，分页与实时出口都必须去除。
  if (Array.isArray(value.stream)) {
    result = {
      ...result,
      stream: value.stream.map(entry => {
        if (
          !isRecord(entry) ||
          entry.type !== 'chunk' ||
          !isRecord(entry.chunk) ||
          !Object.hasOwn(entry.chunk, 'replayState')
        )
          return entry
        const { replayState: _privateReplay, ...chunk } = entry.chunk
        return { ...entry, chunk }
      }),
    }
  }
  return result
}

/** 分页和实时事件使用同一过滤规则，保留事件序号及所有可见内容。 */
export function publicSessionHistory(value: unknown): unknown {
  if (!isRecord(value)) return value
  const project = (entry: unknown): unknown => {
    if (!isRecord(entry)) return entry
    if (entry.type === 'event' && isRecord(entry.event))
      return { ...entry, event: project(entry.event) }
    return 'data' in entry ? { ...entry, data: publicSessionEventData(entry.data) } : entry
  }
  return {
    ...value,
    ...(Array.isArray(value.records) ? { records: value.records.map(project) } : {}),
    ...(Array.isArray(value.events) ? { events: value.events.map(project) } : {}),
  }
}

function sessionEvent(value: unknown): CanonicalSessionEvent | null {
  if (!isRecord(value)) return null
  const type = boundedString(value.type, 256)
  const seq = value.seq
  const time = value.time
  if (
    type === null ||
    typeof seq !== 'number' ||
    !Number.isFinite(seq) ||
    seq < 0 ||
    (type !== 'assistant/chunk' && !Number.isSafeInteger(seq)) ||
    typeof time !== 'number' ||
    !Number.isFinite(time) ||
    !('data' in value)
  )
    return null
  if (type === 'command/run') {
    const data = parseDesktopCommandRunEventData(value.data)
    return data === null ? null : { type, seq, time, data }
  }
  if (type === 'command/done') {
    const data = parseDesktopCommandDoneEventData(value.data, seq)
    return data === null ? null : { type, seq, time, data }
  }
  return {
    type,
    seq,
    time,
    data: publicSessionEventData(value.data),
    ...(value.surfaceOp === undefined ? {} : { surfaceOp: value.surfaceOp }),
  }
}

/**
 * 解析 `permissions` 投影帧。运行核心只发布当前值，选项属于进程级目录，
 * 因此缺省 `options` 是正常形态；带选项时必须逐项有效，否则整帧拒绝。
 */
function permissionProjection(value: unknown): DesktopPermissionProjection | null {
  if (!isRecord(value)) return null
  const currentValue = boundedString(value.currentValue, 80)
  if (currentValue === null) return null
  if (value.options === undefined) return { currentValue }
  if (!Array.isArray(value.options) || value.options.length === 0 || value.options.length > 32)
    return null
  const options = value.options.flatMap(option => {
    if (!isRecord(option)) return []
    const optionValue = boundedString(option.value, 80)
    const name = boundedString(option.name, 240)
    const description =
      option.description === undefined
        ? undefined
        : (boundedString(option.description, 1_000) ?? null)
    if (optionValue === null || name === null || description === null) return []
    return [{ value: optionValue, name, ...(description === undefined ? {} : { description }) }]
  })
  if (options.length !== value.options.length) return null
  return { currentValue, options }
}

function optionalBoundedString(value: unknown, maximum: number): string | null | undefined {
  return value === undefined ? undefined : boundedString(value, maximum)
}

function questionOption(value: unknown): DesktopQuestionOption | null {
  if (!isRecord(value)) return null
  const label = boundedString(value.label, 1_000)
  const description = optionalBoundedString(value.description, 4_000)
  if (label === null || description === null) return null
  return { label, ...(description === undefined ? {} : { description }) }
}

function questionItem(value: unknown): DesktopQuestionItem | null {
  if (!isRecord(value)) return null
  const id = boundedString(value.id, 512)
  const question = boundedString(value.question, 16 * 1024)
  const header = optionalBoundedString(value.header, 240)
  const detail = optionalBoundedString(value.detail, 256 * 1024)
  if (id === null || question === null || header === null || detail === null) return null
  const options =
    value.options === undefined
      ? undefined
      : Array.isArray(value.options) && value.options.length <= 64
        ? value.options.map(questionOption)
        : null
  if (options === null || options?.some(option => option === null)) return null
  const multiSelect = value.multiSelect
  if (multiSelect !== undefined && typeof multiSelect !== 'boolean') return null
  let intent: DesktopQuestionItem['intent']
  if (value.intent !== undefined) {
    if (!isRecord(value.intent) || value.intent.kind !== 'plan-review') return null
    const approve = boundedString(value.intent.approve, 1_000)
    const callId = optionalBoundedString(value.intent.callId, 512)
    if (approve === null || callId === null) return null
    intent = { kind: 'plan-review', approve, ...(callId === undefined ? {} : { callId }) }
  }
  return {
    id,
    question,
    ...(header === undefined ? {} : { header }),
    ...(detail === undefined ? {} : { detail }),
    ...(options === undefined ? {} : { options: options as DesktopQuestionOption[] }),
    ...(multiSelect === undefined ? {} : { multiSelect }),
    ...(intent === undefined ? {} : { intent }),
  }
}

function pendingInteraction(
  input: UnknownRecord,
  requestRpcId: unknown,
): DesktopPendingInteraction | null {
  const rpcId = boundedString(requestRpcId, 512)
  if (rpcId === null) return null
  if (input.type === 'question/requested') {
    if (
      !Array.isArray(input.questions) ||
      input.questions.length === 0 ||
      input.questions.length > 32
    )
      return null
    const questions = input.questions.map(questionItem)
    if (questions.some(question => question === null)) return null
    return {
      kind: 'question',
      key: `question:${rpcId}`,
      questions: questions as DesktopQuestionItem[],
    }
  }
  if (input.type !== 'approval/requested') return null
  const approvalId = boundedString(input.approvalId, 512)
  const toolName = boundedString(input.toolName, 512)
  const callId = optionalBoundedString(input.callId, 512)
  const reason = optionalBoundedString(input.reason, 16 * 1024)
  if (approvalId === null || toolName === null || callId === null || reason === null) return null
  return {
    kind: 'approval',
    key: `approval:${rpcId}`,
    approvalId,
    toolName,
    ...(callId === undefined ? {} : { callId }),
    ...(reason === undefined ? {} : { reason }),
  }
}

function interactionResolution(input: UnknownRecord): DesktopInteractionResolution | null {
  if (input.type === 'question/resolved') {
    const rpcId = boundedString(input.questionRpcId, 512)
    if (rpcId === null || (input.outcome !== 'answered' && input.outcome !== 'cancelled'))
      return null
    return { kind: 'question', key: `question:${rpcId}`, outcome: input.outcome }
  }
  if (input.type !== 'approval/resolved') return null
  const approvalId = boundedString(input.approvalId, 512)
  const outcome = input.outcome
  if (
    approvalId === null ||
    (outcome !== 'allowed-once' &&
      outcome !== 'rejected' &&
      outcome !== 'cancelled' &&
      outcome !== 'unavailable')
  )
    return null
  return { kind: 'approval', approvalId, outcome }
}

function projectedPendingInteraction(value: unknown): DesktopPendingInteraction | null {
  if (!isRecord(value) || typeof value.key !== 'string') return null
  if (value.kind === 'question' && value.key.startsWith('question:')) {
    return pendingInteraction(
      { type: 'question/requested', questions: value.questions },
      value.key.slice('question:'.length),
    )
  }
  if (value.kind === 'approval' && value.key.startsWith('approval:')) {
    return pendingInteraction(
      {
        type: 'approval/requested',
        approvalId: value.approvalId,
        toolName: value.toolName,
        callId: value.callId,
        reason: value.reason,
      },
      value.key.slice('approval:'.length),
    )
  }
  return null
}

function projectedInteractionResolution(value: unknown): DesktopInteractionResolution | null {
  if (!isRecord(value)) return null
  if (
    value.kind === 'question' &&
    typeof value.key === 'string' &&
    value.key.startsWith('question:')
  ) {
    return interactionResolution({
      type: 'question/resolved',
      questionRpcId: value.key.slice('question:'.length),
      outcome: value.outcome,
    })
  }
  if (value.kind === 'approval') {
    return interactionResolution({
      type: 'approval/resolved',
      approvalId: value.approvalId,
      outcome: value.outcome,
    })
  }
  return null
}

/**
 * 把 Host 的 Mux payload 收窄成 renderer 可以消费的 Session 事件、必要投影、
 * 队列和订阅基线。每种投影都只保留显示和受控变更所需字段，不把完整
 * Message 或传输 envelope 暴露给 renderer；插件投影只通过有界 JSON 通道交付。
 */
export function parseDesktopSessionFrame(
  input: unknown,
  requestRpcId?: unknown,
): DesktopSessionFrame | null {
  if (!isRecord(input)) return null
  if (input.type === 'session/stream-reset') return { type: 'session/stream-reset' }
  const id = sessionId(input.sessionId)
  if (id === null) return null

  if (input.type === 'session/plugin-projections') {
    const change = parsePluginProjectionChange(input.change)
    return change === null ? null : { type: input.type, sessionId: id, change }
  }

  if (input.type === 'session/title') {
    const title = boundedString(input.title, 16 * 1024)
    return title === null || !Number.isSafeInteger(input.seq) || (input.seq as number) < -1
      ? null
      : { type: input.type, sessionId: id, seq: input.seq as number, title }
  }

  if (input.type === 'session/snapshot') {
    if (
      !Array.isArray(input.events) ||
      typeof input.hasMore !== 'boolean' ||
      !Number.isSafeInteger(input.lastSeq) ||
      (input.lastSeq as number) < -1
    )
      return null
    const events = input.events.map(sessionEvent)
    if (events.some(event => event === null)) return null
    return {
      type: 'session/snapshot',
      sessionId: id,
      events: events as CanonicalSessionEvent[],
      lastSeq: input.lastSeq as number,
      hasMore: input.hasMore,
    }
  }

  if (input.type === 'session/event') {
    const event = sessionEvent(input.event)
    return event === null ? null : { type: 'session/event', sessionId: id, event }
  }

  if (input.type === 'session/interaction-requested') {
    const interaction = projectedPendingInteraction(input.interaction)
    return interaction === null ? null : { type: input.type, sessionId: id, interaction }
  }

  if (input.type === 'session/interaction-resolved') {
    const resolution = projectedInteractionResolution(input.resolution)
    return resolution === null ? null : { type: input.type, sessionId: id, resolution }
  }

  if (input.type === 'question/requested' || input.type === 'approval/requested') {
    const interaction = pendingInteraction(input, requestRpcId)
    return interaction === null
      ? null
      : {
          type: 'session/interaction-requested',
          sessionId: id,
          interaction,
        }
  }

  if (input.type === 'question/resolved' || input.type === 'approval/resolved') {
    const resolution = interactionResolution(input)
    return resolution === null
      ? null
      : {
          type: 'session/interaction-resolved',
          sessionId: id,
          resolution,
        }
  }

  if (input.type === 'session/permissions') {
    if (typeof input.seq !== 'number' || !Number.isSafeInteger(input.seq) || input.seq < -1)
      return null
    const value = permissionProjection(input.value)
    return value === null
      ? null
      : { type: 'session/permissions', sessionId: id, seq: input.seq, value }
  }

  if (input.type === 'session/model-selection') {
    if (typeof input.seq !== 'number' || !Number.isSafeInteger(input.seq) || input.seq < -1)
      return null
    const value = parseDesktopModelSelectionProjection(input.value)
    return value === null ? null : { type: input.type, sessionId: id, seq: input.seq, value }
  }

  if (input.type === 'session/projection') {
    if (typeof input.seq !== 'number' || !Number.isSafeInteger(input.seq) || input.seq < -1)
      return null
    if (input.key === 'title') {
      const title = boundedString(input.value, 16 * 1024)
      return title === null
        ? null
        : {
            type: 'session/title',
            sessionId: id,
            seq: input.seq,
            title,
          }
    }
    if (input.key === 'modelSelection') {
      const value = parseDesktopModelSelectionProjection(input.value)
      return value === null
        ? null
        : {
            type: 'session/model-selection',
            sessionId: id,
            seq: input.seq,
            value,
          }
    }
    if (input.key !== 'permissions') {
      if (typeof input.key !== 'string') return null
      const change = parsePluginProjectionChange({
        kind: 'patch',
        asOfSeq: input.seq,
        values: { [input.key]: input.value },
      })
      return change === null ? null : { type: 'session/plugin-projections', sessionId: id, change }
    }
    const value = permissionProjection(input.value)
    return value === null
      ? null
      : {
          type: 'session/permissions',
          sessionId: id,
          seq: input.seq,
          value,
        }
  }

  if (input.type === 'session/queue') {
    if ('queue' in input) {
      const queue = projectedQueueSnapshot(input.queue)
      return queue === null ? null : { type: 'session/queue', sessionId: id, queue }
    }
    if (!Array.isArray(input.items)) return null
    const actionableItems: DesktopQueuedMessage[] = []
    for (const item of input.items) {
      const parsed = queueItem(item)
      if (parsed === null) return null
      if (parsed.placement !== 'context') actionableItems.push(parsed)
    }
    const items = actionableItems.slice(0, DESKTOP_QUEUE_VISIBLE_LIMIT)
    const omittedCount = actionableItems.length - items.length
    return {
      type: 'session/queue',
      sessionId: id,
      queue: {
        items,
        totalCount: actionableItems.length,
        omittedCount,
        truncated: omittedCount > 0,
      },
    }
  }

  if (input.type === 'session/subscribed') {
    const lastSeq = input.lastSeq
    return typeof lastSeq === 'number' && Number.isSafeInteger(lastSeq) && lastSeq >= -1
      ? { type: 'session/subscribed', sessionId: id, lastSeq }
      : null
  }

  return null
}
