import { projectSessionFileReferences } from './session-file-references.ts'
import {
  parseDesktopCommandDoneEventData,
  parseDesktopCommandRunEventData,
} from './session-capabilities.ts'
import { isRecord, type UnknownRecord } from './validation.ts'

export interface CanonicalSessionEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
  readonly surfaceOp?: unknown
}

interface ConversationMessageBase {
  readonly seq: number
  readonly time: number
  readonly turn: number | null
  readonly step: number | null
  readonly text: string
}

export interface ConversationUserMessageItem extends ConversationMessageBase {
  readonly type: 'user'
  readonly status: 'settled'
  readonly images?: readonly { readonly attachmentId: string; readonly name: string }[]
  readonly fileAttachments?: readonly {
    readonly attachmentId: string
    readonly name: string
    readonly bytes: number
  }[]
}

export type ConversationContextForm =
  'instructions' | 'catalog' | 'snapshot' | 'notice' | 'relay' | 'recall'

export interface ConversationContextCatalogEntry {
  readonly name: string
  readonly description: string
}

export interface ConversationContextSection {
  readonly name: string
  readonly text: string
}

export interface ConversationContextItem extends ConversationMessageBase {
  readonly type: 'context'
  readonly status: 'settled'
  readonly role: 'inject' | 'recall'
  readonly sourceLabel: string | null
  readonly form: ConversationContextForm | null
  readonly summary: string | null
  readonly paths?: readonly string[]
  readonly entries?: readonly ConversationContextCatalogEntry[]
  readonly sections?: readonly ConversationContextSection[]
}

export type ConversationAssistantStatus = 'waiting' | 'streaming' | 'settled' | 'interrupted'

export interface ConversationRetryState {
  readonly retryId: string
  readonly attempt: number
  readonly maxAttempts?: number
  readonly nextAt: number
  readonly started: boolean
  readonly message: string
}

export interface ConversationAssistantContentBlock {
  readonly type: 'text' | 'reasoning'
  readonly index: number
  readonly text: string
  readonly complete: boolean
}

export interface ConversationAssistantMessageItem extends ConversationMessageBase {
  readonly type: 'assistant'
  /** 同一临时回复最近消费的事件序号，用于刷新跟随滚动而不改变行身份。 */
  readonly latestSeq: number
  readonly status: ConversationAssistantStatus
  /** 当前步骤的恢复状态只从 llm/retry 事件派生，结束或收到新输出后移除。 */
  readonly retry?: ConversationRetryState
  /** 已落盘助手消息的稳定身份；仅用于 Host 公开的逐条反馈能力。 */
  readonly messageId?: string
  /** 出现 reasoning 时保留 DSH content block 的 index 与顺序，供对话分区展示。 */
  readonly blocks?: readonly ConversationAssistantContentBlock[]
  /** 当前回复之前，本轮已成功产出或明确交付的文件，不从正文猜测。 */
  readonly files?: readonly string[]
}

export type ConversationMessageItem = ConversationUserMessageItem | ConversationAssistantMessageItem

export type ConversationToolStatus = 'running' | 'settled' | 'error' | 'interrupted'

export interface ConversationToolItem {
  readonly type: 'tool'
  readonly seq: number
  readonly latestSeq: number
  readonly time: number
  readonly endTime: number | null
  readonly turn: number | null
  readonly callId: string | null
  readonly name: string | null
  readonly summary: string
  readonly argumentsText: string | null
  readonly resultText: string | null
  readonly status: ConversationToolStatus
  readonly isError: boolean
}

/** 同一命令的开始与结果共用一行；压缩统计只采用运行核心给出的结构化记录。 */
export interface ConversationCommandItem {
  readonly type: 'command'
  readonly commandId: string
  readonly name: string | null
  readonly seq: number
  readonly latestSeq: number
  readonly time: number
  readonly turn: number | null
  readonly status: 'running' | 'success' | 'error'
  readonly summary: string | null
  readonly details: string | null
}

/**
 * 一轮的结束提示：`turn/end` 记录运行失败或输出上限时的常驻行。
 *
 * 运行失败属于它失败的那一轮，因此它在会话里按事件顺序占一行，而不是被塞进
 * 输入区的瞬时提示；`code` 与 `message` 都来自日志本身，不从界面文案倒推。
 */
export interface ConversationNoticeItem {
  readonly type: 'error' | 'warning'
  readonly seq: number
  readonly time: number
  readonly turn: number | null
  readonly message: string
  readonly code?: string
}

export type ConversationProjectionItem =
  | ConversationMessageItem
  | ConversationContextItem
  | ConversationToolItem
  | ConversationCommandItem
  | ConversationNoticeItem

export interface ConversationProjectionOptions {
  /** Host 状态流提供的权威运行状态；用于等待项和当前临时回复的状态。 */
  readonly running?: boolean
}

export interface TrajectoryInputEntry {
  readonly kind: 'input'
  readonly seq: number
  readonly time: number
  readonly text: string
}

export interface TrajectoryModelEntry {
  readonly kind: 'model'
  readonly seq: number
  readonly time: number
  readonly text: string
}

export interface TrajectoryToolEntry {
  readonly kind: 'tool'
  readonly seq: number
  readonly time: number
  readonly callId: string | null
  readonly name: string | null
  readonly summary: string
  readonly argumentsText: string | null
  readonly resultSummary: string | null
  readonly resultText: string | null
  readonly endTime: number | null
  readonly duration: number | null
  readonly isError: boolean
}

export type TrajectoryEntry = TrajectoryInputEntry | TrajectoryModelEntry | TrajectoryToolEntry

export interface TrajectoryTurn {
  readonly turn: number
  readonly startTime: number | null
  readonly endTime: number | null
  readonly duration: number | null
  readonly calls: number
  readonly entries: readonly TrajectoryEntry[]
}

type MutableTrajectoryTurn = {
  turn: number
  startTime: number | null
  endTime: number | null
  duration: number | null
  calls: number
  entries: TrajectoryEntry[]
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

function nonNegativeInteger(value: unknown): number | null {
  const parsed = integer(value)
  return parsed !== null && parsed >= 0 ? parsed : null
}

function eventFrom(value: unknown): CanonicalSessionEvent | null {
  if (!isRecord(value)) return null

  const type = typeof value.type === 'string' ? value.type : null
  const seq = type === 'assistant/chunk' ? finiteNumber(value.seq) : nonNegativeInteger(value.seq)
  const time = finiteNumber(value.time)
  if (
    type === null ||
    type.length === 0 ||
    seq === null ||
    seq < 0 ||
    time === null ||
    !('data' in value)
  )
    return null

  return {
    type,
    seq,
    time,
    data: value.data,
    ...(value.surfaceOp === undefined ? {} : { surfaceOp: value.surfaceOp }),
  }
}

function packedMembers(value: UnknownRecord): readonly unknown[] | null {
  if (!isRecord(value.data)) return null
  if (value.type === 'tool-call-chunks')
    return Array.isArray(value.data.args) ? value.data.args : null
  if (value.type === 'text-chunks' || value.type === 'reasoning-chunks') {
    return Array.isArray(value.data.texts) ? value.data.texts : null
  }
  return null
}

/**
 * 展开 DSH 持久化层使用的连续 chunk 压缩行。校验失败时整行跳过，
 * 避免用部分数据制造看似完整的事件。
 */
function unpackChunkRow(value: unknown): CanonicalSessionEvent[] {
  if (!isRecord(value)) return []
  const members = packedMembers(value)
  const seq0 = nonNegativeInteger(value.seq0)
  const time0 = finiteNumber(value.time0)
  const data = isRecord(value.data) ? value.data : null
  if (members === null || members.length === 0 || seq0 === null || time0 === null || data === null)
    return []

  const turn = integer(data.turn)
  const step = integer(data.step)
  const index = nonNegativeInteger(data.index)
  const gaps = Array.isArray(data.dt) ? data.dt : null
  if (
    turn === null ||
    step === null ||
    index === null ||
    gaps === null ||
    gaps.length !== members.length - 1
  )
    return []
  if (
    !members.every(member => typeof member === 'string') ||
    !gaps.every(gap => finiteNumber(gap) !== null)
  )
    return []

  const id = value.type === 'tool-call-chunks' && typeof data.id === 'string' ? data.id : null
  if (value.type === 'tool-call-chunks' && id === null) return []

  const events: CanonicalSessionEvent[] = []
  let time = time0
  for (let offset = 0; offset < members.length; offset += 1) {
    if (offset > 0) time += gaps[offset - 1] as number
    const text = members[offset] as string
    let chunk: UnknownRecord
    if (value.type === 'text-chunks') {
      chunk = { type: 'text-delta', index, text }
    } else if (value.type === 'reasoning-chunks') {
      chunk = { type: 'reasoning-delta', index, text }
    } else {
      chunk = {
        type: 'tool-call-delta',
        index,
        id,
        ...(typeof data.name === 'string' ? { name: data.name } : {}),
        argumentsDelta: text,
      }
    }
    events.push({
      type: 'assistant/chunk',
      seq: seq0 + offset,
      time,
      data: { turn, step, chunk },
    })
  }
  return events
}

function eventsFromPageRecord(value: unknown): CanonicalSessionEvent[] {
  if (!isRecord(value)) return []

  if (value.type === 'event') {
    const nested = eventFrom(value.event)
    if (nested !== null) return [nested]
    if (typeof value.event === 'string') {
      const flattened = eventFrom({ ...value, type: value.event })
      return flattened === null ? [] : [flattened]
    }
    return []
  }

  if (value.type === 'chunks') {
    const candidates = Array.isArray(value.events)
      ? value.events
      : Array.isArray(value.chunks)
        ? value.chunks
        : Array.isArray(value.event)
          ? value.event
          : [value.event]
    return candidates.flatMap(candidate => {
      const unpacked = unpackChunkRow(candidate)
      if (unpacked.length > 0) return unpacked
      const event = eventFrom(candidate)
      return event === null ? [] : [event]
    })
  }

  const unpacked = unpackChunkRow(value)
  if (unpacked.length > 0) return unpacked
  const event = eventFrom(value)
  return event === null ? [] : [event]
}

function inputRecords(input: unknown): readonly unknown[] {
  if (Array.isArray(input)) return input
  if (!isRecord(input)) return []
  if (Array.isArray(input.records)) return input.records
  if (Array.isArray(input.events)) return input.events
  return []
}

/**
 * 把旧版 history、新版 page 或 canonical 数组统一成按 seq 升序的事件列表。
 * 重叠分页中同 seq 的第一条有效事件胜出；无效输入只会被忽略。
 */
export function normalizeSessionEvents(input: unknown): CanonicalSessionEvent[] {
  const bySeq = new Map<number, CanonicalSessionEvent>()
  for (const record of inputRecords(input)) {
    const candidates =
      isRecord(record) && 'event' in record && record.type !== 'event' && record.type !== 'chunks'
        ? eventsFromPageRecord(record.event)
        : eventsFromPageRecord(record)
    for (const event of candidates) {
      if (!bySeq.has(event.seq)) bySeq.set(event.seq, event)
    }
  }
  return [...bySeq.values()].toSorted((left, right) => left.seq - right.seq)
}

function contentBlockText(value: unknown, blockType: 'text' | 'reasoning'): string {
  if (typeof value === 'string') return blockType === 'text' ? value : ''
  if (Array.isArray(value)) {
    return value
      .map(item => contentBlockText(item, blockType))
      .filter(Boolean)
      .join('\n')
  }
  if (!isRecord(value)) return ''
  if (value.type === blockType && typeof value.text === 'string') return value.text
  if (Array.isArray(value.content)) return contentBlockText(value.content, blockType)
  return ''
}

function contentText(value: unknown): string {
  return contentBlockText(value, 'text')
}

function turnFromData(data: unknown): number | null {
  if (!isRecord(data)) return null
  const turn = integer(data.turn)
  return turn !== null && turn >= 0 ? turn : null
}

function stepFromData(data: unknown): number | null {
  if (!isRecord(data)) return null
  const step = integer(data.step)
  return step !== null && step >= 0 ? step : null
}

function indexFromChunk(chunk: UnknownRecord): number | null {
  return nonNegativeInteger(chunk.index)
}

function isSubmittedUserMessage(data: unknown): boolean {
  if (!isRecord(data)) return false
  if (!isRecord(data.source)) return true
  return data.source.kind === 'user'
}

const CONTEXT_FORMS = new Set<ConversationContextForm>([
  'instructions',
  'catalog',
  'snapshot',
  'notice',
  'relay',
  'recall',
])

function readableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function sourceValues(source: UnknownRecord, member: string, field: string): string[] {
  const values = source[member]
  if (!Array.isArray(values)) return []
  const collected: string[] = []
  for (const value of values) {
    if (!isRecord(value)) continue
    const text = readableString(value[field])
    if (text !== null && !collected.includes(text)) collected.push(text)
  }
  return collected
}

function contextLabel(source: UnknownRecord): { role: 'inject' | 'recall'; label: string | null } {
  const kind = readableString(source.kind)
  if (kind === null) return { role: 'inject', label: null }
  if (kind === 'session-reference') {
    const labels = sourceValues(source, 'references', 'label')
    return { role: 'recall', label: labels.length > 0 ? labels.join(', ') : kind }
  }
  if (kind === 'agent-instructions') {
    const paths = sourceValues(source, 'changes', 'path')
    return { role: 'inject', label: paths.length > 0 ? paths.join(', ') : kind }
  }
  if (kind === 'plugin') return { role: 'inject', label: readableString(source.plugin) ?? kind }
  if (kind === 'skill-invocation')
    return { role: 'inject', label: readableString(source.name) ?? kind }
  return { role: 'inject', label: kind }
}

function contextForm(source: UnknownRecord): ConversationContextForm | null {
  const form = readableString(source.form)
  return form !== null && CONTEXT_FORMS.has(form as ConversationContextForm)
    ? (form as ConversationContextForm)
    : null
}

function contextEntries(source: UnknownRecord): ConversationContextCatalogEntry[] | undefined {
  if (!Array.isArray(source.entries)) return undefined
  const entries: ConversationContextCatalogEntry[] = []
  for (const value of source.entries) {
    if (!isRecord(value)) return undefined
    const name = readableString(value.name)
    const description = typeof value.description === 'string' ? value.description : null
    if (name === null || description === null) return undefined
    entries.push({ name, description })
  }
  return entries
}

function contextSections(source: UnknownRecord): ConversationContextSection[] | undefined {
  if (!Array.isArray(source.sections)) return undefined
  const sections: ConversationContextSection[] = []
  for (const value of source.sections) {
    if (!isRecord(value)) return undefined
    const name = readableString(value.name)
    const text = typeof value.text === 'string' ? value.text : null
    if (name === null || text === null) return undefined
    sections.push({ name, text })
  }
  return sections.length > 0 ? sections : undefined
}

function contextItem(
  event: CanonicalSessionEvent,
  turn: number | null,
  step: number | null,
  text: string,
): ConversationContextItem | null {
  if (!isRecord(event.data) || !isRecord(event.data.source)) return null
  const source = event.data.source
  const provenance = contextLabel(source)
  const form = contextForm(source)
  const entries = form === 'catalog' ? contextEntries(source) : undefined
  const sections = form === 'snapshot' ? contextSections(source) : undefined
  const paths = form === 'instructions' ? sourceValues(source, 'changes', 'path') : []
  const summary = form === 'notice' ? readableString(source.summary) : null
  return {
    type: 'context',
    seq: event.seq,
    time: event.time,
    turn,
    step,
    text,
    status: 'settled',
    role: provenance.role,
    sourceLabel: provenance.label,
    form,
    summary,
    ...(paths.length > 0 ? { paths } : {}),
    ...(entries === undefined ? {} : { entries }),
    ...(sections === undefined ? {} : { sections }),
  }
}

function callIdFromData(data: unknown): string | null {
  if (!isRecord(data)) return null
  if (typeof data.callId === 'string') return data.callId
  if (
    isRecord(data.message) &&
    isRecord(data.message.source) &&
    typeof data.message.source.callId === 'string'
  ) {
    return data.message.source.callId
  }
  return null
}

function nameFromData(data: unknown): string | null {
  return isRecord(data) && typeof data.name === 'string' && data.name.length > 0 ? data.name : null
}

function compact(value: unknown, limit = 180): string {
  let text = ''
  if (typeof value === 'string') {
    text = value
    try {
      text = JSON.stringify(JSON.parse(value))
    } catch {
      // 工具参数允许是普通字符串，不把解析失败视为协议错误。
    }
  } else if (value !== undefined) {
    try {
      text = JSON.stringify(value)
    } catch {
      text = ''
    }
  }
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`
}

function detailText(value: unknown, limit = 8_000): string | null {
  let text = ''
  if (typeof value === 'string') {
    text = value
    try {
      text = JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      // 普通文本保持原样，只有合法 JSON 才格式化。
    }
  } else if (value !== undefined) {
    try {
      text = JSON.stringify(value, null, 2)
    } catch {
      text = ''
    }
  }
  const normalized = text.trim()
  if (normalized === '') return null
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`
}

function callSummary(data: unknown): string {
  if (!isRecord(data)) return '工具调用'
  const name = nameFromData(data) ?? '工具调用'
  const argumentsText = compact(data.arguments)
  return argumentsText.length > 0 ? `${name}：${argumentsText}` : name
}

function callArguments(data: unknown): { summary: string; text: string | null } {
  if (!isRecord(data)) return { summary: '', text: null }
  // 计划全文需要从同一份日志重开，不能沿用普通工具的 8 千字详情截断。
  // 上限容纳 256 KiB 计划的 JSON 转义，界面仍会单独校验计划长度。
  const text = detailText(
    data.arguments,
    nameFromData(data) === 'exit_plan_mode' ? 2 * 1024 * 1024 : 8_000,
  )
  if (text === null) return { summary: '', text: null }
  let candidate: unknown = data.arguments
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate)
    } catch {
      return { summary: compact(candidate), text }
    }
  }
  if (isRecord(candidate)) {
    for (const key of ['command', 'path', 'query', 'pattern', 'url', 'prompt']) {
      const value = readableString(candidate[key])
      if (value !== null) return { summary: compact(value), text }
    }
  }
  return { summary: compact(candidate), text }
}

function resultDetails(data: unknown): { text: string; isError: boolean } {
  if (!isRecord(data)) return { text: '', isError: false }
  const message = isRecord(data.message) ? data.message : null
  const text = contentText(message?.content ?? data.content).trim()
  const nestedError =
    message !== null && Array.isArray(message.content)
      ? message.content.some(block => isRecord(block) && block.isError === true)
      : false
  return { text, isError: data.error !== undefined || data.isError === true || nestedError }
}

function resultSummary(data: unknown, name: string | null): { summary: string; isError: boolean } {
  const details = resultDetails(data)
  const body = compact(details.text)
  if (details.isError)
    return { summary: body.length > 0 ? `失败：${body}` : '工具调用失败', isError: true }
  if (body.length > 0) return { summary: body, isError: false }
  return { summary: name === null ? '工具调用已完成' : `${name} 已完成`, isError: false }
}

function messageText(event: CanonicalSessionEvent): string {
  if (!isRecord(event.data)) return ''
  if (event.type === 'assistant/message' && isRecord(event.data.message)) {
    return contentText(event.data.message.content).trim()
  }
  return contentText(event.data.content).trim()
}

interface AssistantMessageContent {
  readonly text: string
  readonly blocks: readonly ConversationAssistantContentBlock[]
}

function assistantContentBlocks(value: unknown): ConversationAssistantContentBlock[] {
  const blocks: ConversationAssistantContentBlock[] = []
  let nextIndex = 0
  const visit = (candidate: unknown, suggestedIndex?: number): void => {
    if (typeof candidate === 'string') {
      const text = candidate.trim()
      const index = suggestedIndex ?? nextIndex++
      nextIndex = Math.max(nextIndex, index + 1)
      if (text.length > 0) blocks.push({ type: 'text', index, text, complete: true })
      return
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        const index = nextIndex++
        visit(item, index)
      }
      return
    }
    if (!isRecord(candidate)) return
    if (
      (candidate.type === 'text' || candidate.type === 'reasoning') &&
      typeof candidate.text === 'string'
    ) {
      const text = candidate.text.trim()
      const explicitIndex = nonNegativeInteger(candidate.index)
      const index = suggestedIndex ?? explicitIndex ?? nextIndex++
      nextIndex = Math.max(nextIndex, index + 1)
      if (text.length > 0) blocks.push({ type: candidate.type, index, text, complete: true })
      return
    }
    if (Array.isArray(candidate.content)) visit(candidate.content)
  }
  visit(value)
  return blocks
}

function assistantMessageContent(event: CanonicalSessionEvent): AssistantMessageContent {
  if (!isRecord(event.data)) return { text: '', blocks: [] }
  const content =
    event.type === 'assistant/message' && isRecord(event.data.message)
      ? event.data.message.content
      : event.data.content
  const blocks = assistantContentBlocks(content)
  return {
    text: blocks
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim(),
    blocks,
  }
}

function assistantMessageId(event: CanonicalSessionEvent): string | undefined {
  if (
    event.type !== 'assistant/message' ||
    !isRecord(event.data) ||
    !isRecord(event.data.message)
  ) {
    return undefined
  }
  const id = event.data.message.id
  return typeof id === 'string' && id.length > 0 && id.length <= 512 && !id.includes('\0')
    ? id
    : undefined
}

type StreamedAssistantBlock = {
  kind: 'text' | 'reasoning' | 'other'
  text: string
  complete: boolean
}

type MutableAssistantDraft = {
  turn: number
  step: number
  firstSeq: number
  firstTime: number
  latestSeq: number
  order: number[]
  blocks: Map<number, StreamedAssistantBlock>
  itemIndex: number | null
  final: boolean
}

type MutableConversationItem = ConversationProjectionItem | null

function assistantKey(turn: number, step: number): string {
  return `${String(turn)}:${String(step)}`
}

function streamedBlockText(
  draft: MutableAssistantDraft,
  kind: Extract<StreamedAssistantBlock['kind'], 'text' | 'reasoning'>,
): string {
  return draft.order
    .flatMap(index => {
      const block = draft.blocks.get(index)
      return block?.kind === kind && block.text.length > 0 ? [block.text] : []
    })
    .join('\n')
    .trim()
}

function streamedContent(draft: MutableAssistantDraft): AssistantMessageContent {
  const blocks = draft.order
    .toSorted((left, right) => left - right)
    .flatMap(index => {
      const block = draft.blocks.get(index)
      if (block === undefined || block.kind === 'other') return []
      return [
        {
          type: block.kind,
          index,
          text: block.text.trim(),
          complete: block.complete,
        } satisfies ConversationAssistantContentBlock,
      ]
    })
  return {
    text: streamedBlockText(draft, 'text'),
    blocks,
  }
}

function ensureStreamedBlock(
  draft: MutableAssistantDraft,
  index: number,
  kind: StreamedAssistantBlock['kind'],
): StreamedAssistantBlock {
  const existing = draft.blocks.get(index)
  if (existing !== undefined && existing.kind === kind) return existing
  if (existing === undefined) draft.order.push(index)
  const created = { kind, text: '', complete: false }
  draft.blocks.set(index, created)
  return created
}

function updateStreamedDraft(draft: MutableAssistantDraft, event: CanonicalSessionEvent): void {
  if (!isRecord(event.data) || !isRecord(event.data.chunk)) return
  const chunk = event.data.chunk
  draft.latestSeq = Math.max(draft.latestSeq, event.seq)
  const index = indexFromChunk(chunk)
  if (index === null) return

  if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
    const block = ensureStreamedBlock(draft, index, 'text')
    block.text += chunk.text
    block.complete = false
    return
  }
  if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
    const block = ensureStreamedBlock(draft, index, 'reasoning')
    block.text += chunk.text
    block.complete = false
    return
  }
  if (chunk.type === 'block-start') {
    const kind =
      chunk.blockType === 'text' ? 'text' : chunk.blockType === 'reasoning' ? 'reasoning' : 'other'
    ensureStreamedBlock(draft, index, kind)
    return
  }
  if (chunk.type === 'block-end' && isRecord(chunk.block)) {
    const kind =
      chunk.block.type === 'text'
        ? 'text'
        : chunk.block.type === 'reasoning'
          ? 'reasoning'
          : 'other'
    const block = ensureStreamedBlock(draft, index, kind)
    block.text = typeof chunk.block.text === 'string' ? chunk.block.text : ''
    block.complete = true
    return
  }
  if (chunk.type === 'tool-call-delta') ensureStreamedBlock(draft, index, 'other')
}

/** 只展示日志明确记录的失败与输出截断，正常结束和用户取消不报错。 */
function turnNotice(
  event: CanonicalSessionEvent,
): Pick<ConversationNoticeItem, 'type' | 'message' | 'code'> | null {
  if (event.type !== 'turn/end' || !isRecord(event.data) || !isRecord(event.data.reason))
    return null
  const reason = event.data.reason
  if (reason.kind === 'max-tokens') {
    return { type: 'warning', message: '模型达到本次输出上限，回复可能不完整。可以发送消息继续。' }
  }
  if (reason.kind !== 'error' || !isRecord(reason.error)) return null
  const message =
    typeof reason.error.message === 'string' && reason.error.message.trim() !== ''
      ? reason.error.message
      : '本轮运行失败'
  const code =
    typeof reason.error.code === 'string' && reason.error.code !== ''
      ? reason.error.code
      : undefined
  return {
    type: 'error',
    message: message.slice(0, 4_000),
    ...(code === undefined ? {} : { code: code.slice(0, 120) }),
  }
}

function assistantItem(
  draft: MutableAssistantDraft,
  content: AssistantMessageContent,
  status: ConversationAssistantStatus,
  event?: CanonicalSessionEvent,
): ConversationAssistantMessageItem {
  const existingSeq = draft.itemIndex === null ? null : draft.firstSeq
  const messageId =
    status === 'settled' && event !== undefined ? assistantMessageId(event) : undefined
  return {
    type: 'assistant',
    seq: existingSeq ?? event?.seq ?? draft.firstSeq,
    latestSeq: event?.seq ?? draft.latestSeq,
    time: event?.time ?? draft.firstTime,
    turn: draft.turn,
    step: draft.step,
    text: content.text,
    ...(messageId === undefined ? {} : { messageId }),
    ...(content.blocks.some(block => block.type === 'reasoning') ? { blocks: content.blocks } : {}),
    status,
  }
}

/** 从同一份 canonical Session 日志生成面向阅读的对话条目。 */
export function projectConversation(
  input: unknown,
  options: ConversationProjectionOptions = {},
): ConversationProjectionItem[] {
  const events = normalizeSessionEvents(input)
  const items: MutableConversationItem[] = []
  const toolNames = new Map<string, string>()
  const toolItemIndexes = new Map<string, number>()
  const commandItemIndexes = new Map<string, number>()
  const eventBySeq = new Map(events.map(event => [event.seq, event]))
  const assistantDrafts = new Map<string, MutableAssistantDraft>()
  const submittedUsers = new Map<number, CanonicalSessionEvent>()
  // 尾页可能缺少 turn/start 或 step/start；先恢复首个事件的坐标，后续显式边界仍会覆盖它。
  const opening = events.find(event => turnFromData(event.data) !== null)
  const openingTurn = turnFromData(opening?.data)
  const openingStep = stepFromData(opening?.data)
  let currentTurn = openingTurn
  let currentStep: { turn: number; step: number; seq: number; time: number } | null =
    opening !== undefined && openingTurn !== null && openingStep !== null
      ? { turn: openingTurn, step: openingStep, seq: opening.seq, time: opening.time }
      : null
  let pendingRetry:
    { turn: number; step: number; seq: number; state: ConversationRetryState } | undefined

  const draftFor = (
    turn: number,
    step: number,
    event: CanonicalSessionEvent,
  ): MutableAssistantDraft => {
    const key = assistantKey(turn, step)
    const existing = assistantDrafts.get(key)
    if (existing !== undefined) return existing
    const draft: MutableAssistantDraft = {
      turn,
      step,
      firstSeq: event.seq,
      firstTime: event.time,
      latestSeq: event.seq,
      order: [],
      blocks: new Map(),
      itemIndex: null,
      final: false,
    }
    assistantDrafts.set(key, draft)
    return draft
  }

  for (const event of events) {
    const explicitTurn = turnFromData(event.data)
    if (event.type === 'turn/start') {
      currentTurn = explicitTurn
      currentStep = null
      pendingRetry = undefined
      continue
    }
    if (event.type === 'turn/end') {
      const notice = turnNotice(event)
      if (notice !== null) {
        items.push({
          ...notice,
          seq: event.seq,
          time: event.time,
          turn: explicitTurn ?? currentTurn,
        })
      }
      if (explicitTurn === null || explicitTurn === currentTurn) {
        currentTurn = null
        currentStep = null
        pendingRetry = undefined
      }
      continue
    }
    if (event.type === 'step/start') {
      const step = stepFromData(event.data)
      if (explicitTurn !== null && step !== null) {
        currentStep = { turn: explicitTurn, step, seq: event.seq, time: event.time }
        pendingRetry = undefined
      }
      continue
    }
    if (event.type === 'step/end') {
      const step = stepFromData(event.data)
      if (
        currentStep !== null &&
        (explicitTurn === null || explicitTurn === currentStep.turn) &&
        (step === null || step === currentStep.step)
      )
        currentStep = null
      continue
    }
    const turn = explicitTurn ?? currentTurn
    const explicitStep = stepFromData(event.data)
    const step = explicitStep ?? (currentStep?.turn === turn ? currentStep.step : null)

    if (
      event.type === 'compaction/end' &&
      isRecord(event.data) &&
      typeof event.data.error === 'string' &&
      event.data.sourceCommandId === undefined
    ) {
      const failure = isRecord(event.data.failure) ? event.data.failure : null
      // 用户取消不报失败；手动命令已有 command/done 提示，自动压缩失败留在对应轮次。
      if (failure?.code !== 'ABORTED')
        items.push({
          type: 'warning',
          seq: event.seq,
          time: event.time,
          turn,
          message: `上下文压缩失败：${event.data.error.slice(0, 3_500)}`,
          ...(typeof failure?.code === 'string' ? { code: failure.code.slice(0, 120) } : {}),
        })
      continue
    }

    if (event.type === 'command/run') {
      const data = parseDesktopCommandRunEventData(event.data)
      if (data === null) continue
      commandItemIndexes.set(data.commandId, items.length)
      items.push({
        type: 'command',
        commandId: data.commandId,
        name: data.name,
        seq: event.seq,
        latestSeq: event.seq,
        time: event.time,
        turn,
        status: 'running',
        summary: null,
        details: null,
      })
      continue
    }
    if (event.type === 'command/done') {
      const data = parseDesktopCommandDoneEventData(event.data, event.seq)
      if (data === null) continue
      const index = commandItemIndexes.get(data.commandId)
      const previous = index === undefined ? undefined : items[index]
      const started = previous?.type === 'command' ? previous : undefined
      let name = started?.name ?? null
      let summary = data.text?.trim() || null
      let details = data.text?.includes('\n') ? data.text : null
      const source =
        data.kind === 'success' && data.sourceEventSeq !== undefined
          ? eventBySeq.get(data.sourceEventSeq)
          : undefined
      if (
        source?.type === 'compaction/summary' &&
        isRecord(source.data) &&
        source.data.sourceCommandId === data.commandId
      ) {
        name = 'compact'
        const count =
          Array.isArray(source.data.shadowedSeqs) &&
          source.data.shadowedSeqs.every(seq => nonNegativeInteger(seq) !== null)
            ? source.data.shadowedSeqs.length
            : null
        const tokens = nonNegativeInteger(source.data.shadowedTokenCount)
        if (count !== null && tokens !== null)
          summary = `已压缩 ${String(count)} 条历史记录（约 ${String(tokens)} tokens）`
        details = contentText(source.data.summary).trim() || details
      }
      const item: ConversationCommandItem = {
        type: 'command',
        commandId: data.commandId,
        name,
        seq: started?.seq ?? event.seq,
        latestSeq: event.seq,
        time: started?.time ?? event.time,
        turn: started?.turn ?? turn,
        status: data.kind,
        summary,
        details,
      }
      if (index === undefined) commandItemIndexes.set(data.commandId, items.push(item) - 1)
      else items[index] = item
      continue
    }

    if (event.type === 'user/message') {
      const text = messageText(event)
      const content = isRecord(event.data) ? event.data.content : undefined
      const images = Array.isArray(content)
        ? content.flatMap(block => {
            if (
              !isRecord(block) ||
              block.type !== 'image' ||
              !isRecord(block.attachment) ||
              typeof block.attachment.attachmentId !== 'string'
            )
              return []
            return [
              {
                attachmentId: block.attachment.attachmentId,
                name:
                  typeof block.attachment.name === 'string' ? block.attachment.name : '图片附件',
              },
            ]
          })
        : []
      const fileAttachments = Array.isArray(content)
        ? content.flatMap(block => {
            if (
              !isRecord(block) ||
              block.type !== 'file' ||
              !isRecord(block.attachment) ||
              typeof block.attachment.attachmentId !== 'string' ||
              typeof block.attachment.name !== 'string'
            )
              return []
            return [
              {
                attachmentId: block.attachment.attachmentId,
                name: block.attachment.name,
                bytes: typeof block.attachment.bytes === 'number' ? block.attachment.bytes : 0,
              },
            ]
          })
        : []
      if (text.length === 0 && images.length === 0 && fileAttachments.length === 0) continue
      if (isSubmittedUserMessage(event.data)) {
        if (turn !== null) submittedUsers.set(turn, event)
        items.push({
          type: 'user',
          seq: event.seq,
          time: event.time,
          turn,
          step,
          text,
          status: 'settled',
          ...(images.length === 0 ? {} : { images }),
          ...(fileAttachments.length === 0 ? {} : { fileAttachments }),
        })
      } else {
        const context = contextItem(event, turn, step, text)
        if (context !== null) items.push(context)
      }
      continue
    }

    if (event.type === 'llm/retry' && explicitTurn !== null && explicitStep !== null) {
      const key = assistantKey(explicitTurn, explicitStep)
      const previous = assistantDrafts.get(key)
      if (previous?.itemIndex !== null && previous?.itemIndex !== undefined)
        items[previous.itemIndex] = null
      assistantDrafts.delete(key)
      pendingRetry = undefined
      const data = event.data
      if (
        isRecord(data) &&
        typeof data.retryId === 'string' &&
        data.retryId.length > 0 &&
        typeof data.retry === 'number' &&
        Number.isSafeInteger(data.retry) &&
        data.retry > 0 &&
        typeof data.delayMs === 'number' &&
        Number.isFinite(data.delayMs) &&
        data.delayMs >= 0
      ) {
        const failure = isRecord(data.failure) ? data.failure : null
        pendingRetry = {
          turn: explicitTurn,
          step: explicitStep,
          seq: event.seq,
          state: {
            retryId: data.retryId,
            attempt: data.retry,
            nextAt: event.time + data.delayMs,
            started: false,
            ...(typeof data.maxRetries === 'number' &&
            Number.isSafeInteger(data.maxRetries) &&
            data.maxRetries >= data.retry
              ? { maxAttempts: data.maxRetries }
              : {}),
            message:
              typeof failure?.message === 'string'
                ? failure.message.slice(0, 4_000)
                : '模型请求暂时未完成',
          },
        }
      }
      continue
    }

    if (
      event.type === 'llm/retry-started' &&
      pendingRetry &&
      isRecord(event.data) &&
      event.data.retryId === pendingRetry.state.retryId &&
      event.data.retry === pendingRetry.state.attempt &&
      explicitTurn === pendingRetry.turn &&
      explicitStep === pendingRetry.step
    ) {
      pendingRetry = {
        ...pendingRetry,
        seq: event.seq,
        state: { ...pendingRetry.state, started: true },
      }
      continue
    }

    if (event.type === 'assistant/chunk' && explicitTurn !== null && explicitStep !== null) {
      if (pendingRetry?.turn === explicitTurn && pendingRetry.step === explicitStep)
        pendingRetry = undefined
      const draft = draftFor(explicitTurn, explicitStep, event)
      if (draft.final) continue
      updateStreamedDraft(draft, event)
      // 首个可见分片只占据消息位置；遍历结束后再组装正文，避免反复格式化所有前缀。
      if (
        draft.itemIndex === null &&
        [...draft.blocks.values()].some(
          block =>
            block.kind === 'reasoning' || (block.kind === 'text' && block.text.trim().length > 0),
        )
      ) {
        draft.itemIndex = items.length
        draft.firstSeq = event.seq
        draft.firstTime = event.time
        items.push(null)
      }
      continue
    }

    if (event.type === 'assistant/message') {
      const finalContent = assistantMessageContent(event)
      if (explicitTurn === null || explicitStep === null) {
        if (
          finalContent.text.length > 0 ||
          finalContent.blocks.some(block => block.type === 'reasoning')
        ) {
          const status =
            isRecord(event.data) && event.data.interrupted === true ? 'interrupted' : 'settled'
          const messageId = status === 'settled' ? assistantMessageId(event) : undefined
          items.push({
            type: 'assistant',
            seq: event.seq,
            latestSeq: event.seq,
            time: event.time,
            turn,
            step,
            text: finalContent.text,
            ...(finalContent.blocks.some(block => block.type === 'reasoning')
              ? { blocks: finalContent.blocks }
              : {}),
            ...(messageId === undefined ? {} : { messageId }),
            status,
          })
        }
        continue
      }

      const draft = draftFor(explicitTurn, explicitStep, event)
      draft.latestSeq = Math.max(draft.latestSeq, event.seq)
      draft.final = true
      if (
        finalContent.text.length === 0 &&
        !finalContent.blocks.some(block => block.type === 'reasoning')
      ) {
        if (draft.itemIndex !== null) items[draft.itemIndex] = null
        continue
      }
      const status =
        isRecord(event.data) && event.data.interrupted === true ? 'interrupted' : 'settled'
      if (draft.itemIndex === null) {
        draft.itemIndex = items.length
        draft.firstSeq = event.seq
        draft.firstTime = event.time
        items.push(assistantItem(draft, finalContent, status, event))
      } else {
        items[draft.itemIndex] = assistantItem(draft, finalContent, status, event)
      }
      continue
    }

    if (event.type === 'tool/call') {
      const callId = callIdFromData(event.data)
      const name = nameFromData(event.data)
      const argumentsView = callArguments(event.data)
      if (callId !== null && name !== null) toolNames.set(callId, name)
      const item: ConversationToolItem = {
        type: 'tool',
        seq: event.seq,
        latestSeq: event.seq,
        time: event.time,
        endTime: null,
        turn,
        callId,
        name,
        summary: argumentsView.summary,
        argumentsText: argumentsView.text,
        resultText: null,
        status: 'running',
        isError: false,
      }
      const itemIndex = items.push(item) - 1
      if (callId !== null) toolItemIndexes.set(callId, itemIndex)
      continue
    }

    if (event.type === 'tool/result') {
      const callId = callIdFromData(event.data)
      const name =
        callId === null
          ? nameFromData(event.data)
          : (toolNames.get(callId) ?? nameFromData(event.data))
      const result = resultSummary(event.data, name)
      const resultText = resultDetails(event.data).text.trim() || null
      const itemIndex = callId === null ? undefined : toolItemIndexes.get(callId)
      const previous = itemIndex === undefined ? undefined : items[itemIndex]
      if (itemIndex !== undefined && previous !== null && previous?.type === 'tool') {
        items[itemIndex] = {
          ...previous,
          latestSeq: event.seq,
          endTime: event.time,
          name: previous.name ?? name,
          summary: previous.summary.length > 0 ? previous.summary : result.summary,
          resultText,
          status: result.isError ? 'error' : 'settled',
          isError: result.isError,
        }
      } else {
        items.push({
          type: 'tool',
          seq: event.seq,
          latestSeq: event.seq,
          time: event.time,
          endTime: event.time,
          turn,
          callId,
          name,
          summary: result.summary,
          argumentsText: null,
          resultText,
          status: result.isError ? 'error' : 'settled',
          isError: result.isError,
        })
      }
    }
  }

  const running = options.running === true
  const activeKey =
    currentTurn !== null && currentStep?.turn === currentTurn
      ? assistantKey(currentStep.turn, currentStep.step)
      : null
  for (const [key, draft] of assistantDrafts) {
    if (draft.final || draft.itemIndex === null) continue
    items[draft.itemIndex] = assistantItem(
      draft,
      streamedContent(draft),
      running && key === activeKey ? 'streaming' : 'interrupted',
    )
  }

  if (running && currentTurn !== null) {
    const step = currentStep?.turn === currentTurn ? currentStep : null
    const draft =
      step === null ? undefined : assistantDrafts.get(assistantKey(step.turn, step.step))
    const submitted = submittedUsers.get(currentTurn)
    const last = items.findLast(item => item?.turn === currentTurn)
    const active = items.some(
      item =>
        item?.turn === currentTurn &&
        (item.type === 'tool' || item.type === 'command') &&
        item.status === 'running',
    )
    const hasFinalAnswer = last?.type === 'assistant' && last.text.trim() !== ''
    if (
      submitted !== undefined &&
      !active &&
      !hasFinalAnswer &&
      draft?.final !== true &&
      draft?.itemIndex == null
    ) {
      const retry =
        step !== null && pendingRetry?.turn === step.turn && pendingRetry.step === step.step
          ? pendingRetry
          : undefined
      const latestSeq = Math.max(
        submitted.seq,
        draft?.latestSeq ?? step?.seq ?? last?.seq ?? submitted.seq,
        retry?.seq ?? 0,
      )
      items.push({
        type: 'assistant',
        seq: step?.seq ?? submitted.seq,
        latestSeq,
        time: step?.time ?? submitted.time,
        turn: currentTurn,
        step: step?.step ?? null,
        text: '',
        status: 'waiting',
        ...(retry === undefined ? {} : { retry: retry.state }),
      })
    }
  }

  const fileReferences = projectSessionFileReferences(events)
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item?.type === 'context') {
      const data = eventBySeq.get(item.seq)?.data
      const source = isRecord(data) && isRecord(data.source) ? data.source : null
      const commandIndex =
        typeof source?.sourceCommandId === 'string'
          ? commandItemIndexes.get(source.sourceCommandId)
          : undefined
      const command = commandIndex === undefined ? undefined : items[commandIndex]
      if (
        source?.kind === 'plugin' &&
        source.plugin === 'compact' &&
        command?.type === 'command' &&
        command.status === 'success'
      ) {
        items[index] = null
      }
    }
    if (item?.type === 'assistant' && item.status === 'settled') {
      const files = fileReferences.get(item.latestSeq)
      if (files !== undefined) items[index] = { ...item, files }
    }
    if (item?.type !== 'tool' || item.status !== 'running') continue
    if (running && currentTurn !== null && item.turn === currentTurn) continue
    items[index] = { ...item, status: 'interrupted' }
  }

  return items.filter((item): item is ConversationProjectionItem => item !== null)
}

function newTurn(turn: number): MutableTrajectoryTurn {
  return { turn, startTime: null, endTime: null, duration: null, calls: 0, entries: [] }
}

/** 从同一份 canonical Session 日志生成按 turn 分组的输入、模型与工具轨迹。 */
export function projectTrajectory(input: unknown): TrajectoryTurn[] {
  const events = normalizeSessionEvents(input)
  const turns = new Map<number, MutableTrajectoryTurn>()
  const calls = new Map<string, { turn: number; entry: TrajectoryToolEntry }>()
  let currentTurn: number | null = null

  const getTurn = (turn: number): MutableTrajectoryTurn => {
    const existing = turns.get(turn)
    if (existing !== undefined) return existing
    const created = newTurn(turn)
    turns.set(turn, created)
    return created
  }

  for (const event of events) {
    const explicitTurn = turnFromData(event.data)
    if (event.type === 'turn/start') {
      if (explicitTurn === null) continue
      currentTurn = explicitTurn
      const turn = getTurn(explicitTurn)
      turn.startTime ??= event.time
      continue
    }

    if (event.type === 'turn/end') {
      const turnNumber: number | null = explicitTurn ?? currentTurn
      if (turnNumber === null) continue
      const turn = getTurn(turnNumber)
      turn.endTime = event.time
      turn.duration = turn.startTime === null ? null : Math.max(0, event.time - turn.startTime)
      if (currentTurn === turnNumber) currentTurn = null
      continue
    }

    const turnNumber: number | null = explicitTurn ?? currentTurn
    if (turnNumber === null) continue
    const turn = getTurn(turnNumber)

    if (event.type === 'user/message') {
      const text = messageText(event)
      if (text.length > 0)
        turn.entries.push({ kind: 'input', seq: event.seq, time: event.time, text })
      continue
    }

    if (event.type === 'assistant/message') {
      const text = messageText(event)
      if (text.length > 0)
        turn.entries.push({ kind: 'model', seq: event.seq, time: event.time, text })
      continue
    }

    if (event.type === 'tool/call') {
      const callId = callIdFromData(event.data)
      const entry: TrajectoryToolEntry = {
        kind: 'tool',
        seq: event.seq,
        time: event.time,
        callId,
        name: nameFromData(event.data),
        summary: callSummary(event.data),
        argumentsText: isRecord(event.data) ? detailText(event.data.arguments) : null,
        resultSummary: null,
        resultText: null,
        endTime: null,
        duration: null,
        isError: false,
      }
      turn.entries.push(entry)
      turn.calls += 1
      if (callId !== null) calls.set(callId, { turn: turnNumber, entry })
      continue
    }

    if (event.type === 'tool/result') {
      const callId = callIdFromData(event.data)
      const pending = callId === null ? undefined : calls.get(callId)
      if (pending === undefined) continue
      const result = resultSummary(event.data, pending.entry.name)
      const completed: TrajectoryToolEntry = {
        ...pending.entry,
        resultSummary: result.summary,
        resultText: detailText(resultDetails(event.data).text),
        endTime: event.time,
        duration: Math.max(0, event.time - pending.entry.time),
        isError: result.isError,
      }
      const owner = getTurn(pending.turn)
      const index = owner.entries.indexOf(pending.entry)
      if (index >= 0) owner.entries[index] = completed
      calls.delete(callId as string)
    }
  }

  const projection: TrajectoryTurn[] = []
  for (const turn of [...turns.values()].toSorted((left, right) => left.turn - right.turn)) {
    projection.push({
      turn: turn.turn,
      startTime: turn.startTime,
      endTime: turn.endTime,
      duration: turn.duration,
      calls: turn.calls,
      entries: turn.entries.toSorted((left, right) => left.seq - right.seq),
    })
  }
  return projection
}
