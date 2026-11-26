import type { CanonicalSessionEvent } from './session-projection.js'
import type { DesktopSessionFrame } from './session-live.js'
import { parseDesktopSessionFrame } from './session-live.js'
import { isDedicatedProjection, parsePluginProjectionChange } from './plugin-projections.js'
import { boundedString, isRecord, type UnknownRecord } from './validation.ts'

/** 会话帧中标识类字符串字段的长度上限；超出或为空时视为无效字段。 */
const MAX_FIELD_LENGTH = 512

type SessionFrameListener = (frame: DesktopSessionFrame) => void | Promise<void>

interface TimedAssistantChunk {
  readonly time: number
  readonly chunk: UnknownRecord
}

interface ActiveAssistantAttempt {
  readonly attemptId: string
  revision: number
  readonly startedAfterSeq: number
  readonly turn: number
  readonly step: number
  nextIndex: number
}

function safeInteger(value: unknown, minimum = 0): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum ? value : null
}

function streamProtocolError(message: string): Error {
  return new Error(`Session 事件流协议错误：${message}`)
}

function canonicalFrame(
  sessionId: string,
  event: unknown,
): Extract<DesktopSessionFrame, { readonly type: 'session/event' }> {
  const frame = parseDesktopSessionFrame({ type: 'session/event', sessionId, event })
  if (frame === null || frame.type !== 'session/event') {
    throw streamProtocolError('收到无效的 Session event')
  }
  return frame
}

async function emitParsedFrame(input: unknown, onFrame: SessionFrameListener): Promise<void> {
  // 当前核心的待处理输入来自持久化 inbox 投影，队列与对话共享同一份 Session 日志。
  if (isRecord(input) && input.type === 'session/projection' && input.key === 'inbox') {
    if (
      !isRecord(input.value) ||
      !Array.isArray(input.value['next-turn']) ||
      !Array.isArray(input.value['next-step'])
    ) {
      throw streamProtocolError('会话 inbox 投影无效')
    }
    input = {
      type: 'session/queue',
      sessionId: input.sessionId,
      items: [
        ...input.value['next-step'].map(message => ({
          id: isRecord(message) ? message.id : undefined,
          placement: 'steering',
          message,
        })),
        ...input.value['next-turn'].map(message => ({
          id: isRecord(message) ? message.id : undefined,
          placement: 'queued',
          message,
        })),
      ],
    }
  }
  const frame = parseDesktopSessionFrame(input)
  if (frame !== null) await onFrame(frame)
}

function assistantRunMembers(record: UnknownRecord): readonly unknown[] | null {
  if (record.type === 'text-chunks' || record.type === 'reasoning-chunks') {
    return Array.isArray(record.texts) ? record.texts : null
  }
  if (record.type === 'tool-call-chunks') return Array.isArray(record.args) ? record.args : null
  return null
}

function expandAssistantStream(value: unknown): readonly TimedAssistantChunk[] {
  if (!Array.isArray(value)) throw streamProtocolError('Assistant 基线 stream 无效')
  const chunks: TimedAssistantChunk[] = []
  for (const candidate of value) {
    if (!isRecord(candidate) || typeof candidate.type !== 'string') {
      throw streamProtocolError('Assistant 基线包含无效记录')
    }
    if (candidate.type === 'chunk') {
      const time = safeInteger(candidate.time, Number.MIN_SAFE_INTEGER)
      if (time === null || !isRecord(candidate.chunk)) {
        throw streamProtocolError('Assistant 基线包含无效原始 chunk')
      }
      chunks.push({ time, chunk: candidate.chunk })
      continue
    }
    const members = assistantRunMembers(candidate)
    const time0 = safeInteger(candidate.time0, Number.MIN_SAFE_INTEGER)
    const index = safeInteger(candidate.index)
    if (
      members === null ||
      members.length === 0 ||
      time0 === null ||
      index === null ||
      members.some(member => typeof member !== 'string') ||
      !Array.isArray(candidate.dt) ||
      candidate.dt.length !== members.length - 1 ||
      candidate.dt.some(gap => safeInteger(gap, Number.MIN_SAFE_INTEGER) === null)
    ) {
      throw streamProtocolError('Assistant 基线包含无效压缩 chunk')
    }
    const id =
      candidate.type === 'tool-call-chunks'
        ? boundedString(candidate.id, MAX_FIELD_LENGTH)
        : undefined
    const name =
      candidate.name === undefined ? undefined : boundedString(candidate.name, MAX_FIELD_LENGTH)
    if (candidate.type === 'tool-call-chunks' && (id === null || name === null)) {
      throw streamProtocolError('Assistant 基线包含无效工具 chunk')
    }
    let time = time0
    for (const [offset, member] of members.entries()) {
      if (offset > 0) time += candidate.dt[offset - 1] as number
      if (!Number.isSafeInteger(time)) throw streamProtocolError('Assistant chunk 时间越界')
      const chunk =
        candidate.type === 'text-chunks'
          ? { type: 'text-delta', index, text: member }
          : candidate.type === 'reasoning-chunks'
            ? { type: 'reasoning-delta', index, text: member }
            : {
                type: 'tool-call-delta',
                index,
                id,
                ...(name === undefined ? {} : { name }),
                argumentsDelta: member,
              }
      chunks.push({ time, chunk })
    }
  }
  return chunks
}

export class SessionFollowProjection {
  private snapshotEvents: CanonicalSessionEvent[] | undefined
  private activeAttempt: ActiveAssistantAttempt | undefined
  private durableCursor = -1
  private transientInGap = 0
  private readonly pendingSettlements = new Map<number, DesktopSessionFrame>()

  constructor(
    private readonly sessionId: string,
    private readonly onFrame: SessionFrameListener,
  ) {}

  async accept(value: unknown): Promise<void> {
    if (!isRecord(value) || typeof value.type !== 'string') {
      throw streamProtocolError('收到无效的 session/follow 帧')
    }
    if (value.type === 'snapshot') {
      await this.acceptSnapshot(value)
      return
    }
    if (value.type === 'event') {
      await this.acceptDurable(value)
      return
    }
    if (value.type === 'assistant-stream') {
      await this.acceptAssistantFrame(value.frame)
      return
    }
    throw streamProtocolError('收到未知的 session/follow 帧')
  }

  private async acceptSnapshot(value: UnknownRecord): Promise<void> {
    if (
      !isRecord(value.header) ||
      value.header.id !== this.sessionId ||
      !Array.isArray(value.records)
    ) {
      throw streamProtocolError('收到无效的 Session snapshot')
    }
    const cursor = safeInteger(value.cursor, -1)
    if (cursor === null) throw streamProtocolError('Session snapshot cursor 无效')
    this.activeAttempt = undefined
    this.pendingSettlements.clear()
    this.transientInGap = 0
    this.durableCursor = cursor
    if (typeof value.hasMore !== 'boolean')
      throw streamProtocolError('Session snapshot 分页标记无效')
    const events: CanonicalSessionEvent[] = []
    this.snapshotEvents = events
    try {
      /* oxlint-disable no-await-in-loop -- 在内存中保持历史和生成中内容的投影顺序，整批完成后才发布。 */
      for (const record of value.records) await this.acceptDurable(record)
      /* oxlint-enable no-await-in-loop */
      if (value.assistantStream !== undefined)
        await this.acceptAssistantBaseline(value.assistantStream)
    } finally {
      this.snapshotEvents = undefined
    }
    await this.onFrame({
      type: 'session/snapshot',
      sessionId: this.sessionId,
      events,
      lastSeq: cursor,
      hasMore: value.hasMore,
    })
    await emitProjectionBaseline(this.sessionId, value.projections, this.onFrame)
  }

  private async acceptDurable(value: unknown): Promise<void> {
    if (!isRecord(value) || value.type !== 'event' || !isRecord(value.event)) {
      throw streamProtocolError('收到无效的 Session durable event')
    }
    const frame = canonicalFrame(this.sessionId, value.event)
    const event = frame.event
    this.durableCursor = Math.max(this.durableCursor, event.seq)
    this.transientInGap = 0
    if (this.isActiveSettlement(event)) {
      if (this.pendingSettlements.has(event.seq)) {
        throw streamProtocolError('收到重复的 Assistant settlement')
      }
      this.pendingSettlements.set(event.seq, frame)
      return
    }
    if (this.snapshotEvents !== undefined) this.snapshotEvents.push(event)
    else await this.onFrame(frame)
  }

  private isActiveSettlement(event: CanonicalSessionEvent): boolean {
    const attempt = this.activeAttempt
    if (
      attempt === undefined ||
      (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') ||
      event.seq <= attempt.startedAfterSeq ||
      !isRecord(event.data)
    )
      return false
    return event.data.turn === attempt.turn && event.data.step === attempt.step
  }

  private async acceptAssistantBaseline(value: unknown): Promise<void> {
    if (!isRecord(value)) throw streamProtocolError('Assistant stream 基线无效')
    const revision = safeInteger(value.revision)
    if (revision === null) throw streamProtocolError('Assistant stream revision 无效')
    if (value.activeAttempt === undefined) return
    const candidate = value.activeAttempt
    if (!isRecord(candidate)) throw streamProtocolError('Assistant activeAttempt 无效')
    const attemptId = boundedString(candidate.attemptId, MAX_FIELD_LENGTH)
    const startedAfterSeq = safeInteger(candidate.startedAfterSeq, -1)
    const turn = safeInteger(candidate.turn)
    const step = safeInteger(candidate.step)
    const nextIndex = safeInteger(candidate.nextIndex)
    const chunks = expandAssistantStream(candidate.stream)
    if (
      attemptId === null ||
      startedAfterSeq === null ||
      turn === null ||
      step === null ||
      nextIndex === null ||
      nextIndex > chunks.length
    ) {
      throw streamProtocolError('Assistant activeAttempt 字段无效')
    }
    this.activeAttempt = { attemptId, revision, startedAfterSeq, turn, step, nextIndex }
    /* oxlint-disable no-await-in-loop -- Assistant 增量顺序属于 renderer 投影契约。 */
    for (const chunk of chunks.slice(0, nextIndex)) {
      await this.publishAssistantChunk(attemptId, turn, step, chunk)
    }
    /* oxlint-enable no-await-in-loop */
  }

  private async acceptAssistantFrame(value: unknown): Promise<void> {
    if (!isRecord(value) || typeof value.type !== 'string') {
      throw streamProtocolError('Assistant stream 帧无效')
    }
    if (value.type === 'start') {
      if (this.activeAttempt !== undefined || this.pendingSettlements.size > 0) {
        throw streamProtocolError('Assistant stream 重复开始')
      }
      const attemptId = boundedString(value.attemptId, MAX_FIELD_LENGTH)
      const revision = safeInteger(value.revision)
      const startedAfterSeq = safeInteger(value.startedAfterSeq, -1)
      const turn = safeInteger(value.turn)
      const step = safeInteger(value.step)
      if (
        attemptId === null ||
        revision === null ||
        startedAfterSeq === null ||
        turn === null ||
        step === null
      ) {
        throw streamProtocolError('Assistant start 帧字段无效')
      }
      this.activeAttempt = { attemptId, revision, startedAfterSeq, turn, step, nextIndex: 0 }
      return
    }
    const attempt = this.activeAttempt
    const attemptId = boundedString(value.attemptId, MAX_FIELD_LENGTH)
    const revision = safeInteger(value.revision)
    if (
      attempt === undefined ||
      attemptId !== attempt.attemptId ||
      revision !== attempt.revision + 1
    ) {
      throw streamProtocolError('Assistant stream attempt 不匹配')
    }
    attempt.revision = revision
    if (value.type === 'chunk') {
      const index = safeInteger(value.index)
      const time = safeInteger(value.time, Number.MIN_SAFE_INTEGER)
      if (index !== attempt.nextIndex || time === null || !isRecord(value.chunk)) {
        throw streamProtocolError('Assistant chunk 帧字段无效或失序')
      }
      attempt.nextIndex += 1
      await this.publishAssistantChunk(attemptId, attempt.turn, attempt.step, {
        time,
        chunk: value.chunk,
      })
      return
    }
    if (value.type !== 'end') throw streamProtocolError('收到未知的 Assistant stream 帧')
    const index = safeInteger(value.index)
    if (index !== attempt.nextIndex || !isRecord(value.outcome)) {
      throw streamProtocolError('Assistant end 帧字段无效或失序')
    }
    this.activeAttempt = undefined
    if (value.outcome.kind === 'abandoned') {
      this.pendingSettlements.clear()
      await this.onFrame({ type: 'session/stream-reset' })
      return
    }
    const seq = safeInteger(value.outcome.seq)
    if (
      value.outcome.kind !== 'committed' ||
      seq === null ||
      (value.outcome.eventType !== 'assistant/message' &&
        value.outcome.eventType !== 'assistant/attempt')
    ) {
      throw streamProtocolError('Assistant end outcome 无效')
    }
    const settlement = this.pendingSettlements.get(seq)
    if (
      settlement === undefined ||
      settlement.type !== 'session/event' ||
      settlement.event.type !== value.outcome.eventType
    ) {
      this.pendingSettlements.clear()
      await this.onFrame({ type: 'session/stream-reset' })
      return
    }
    this.pendingSettlements.delete(seq)
    await this.onFrame(settlement)
  }

  private async publishAssistantChunk(
    attemptId: string,
    turn: number,
    step: number,
    value: TimedAssistantChunk,
  ): Promise<void> {
    this.transientInGap += 1
    const base = Math.max(this.durableCursor, 0)
    const frame = canonicalFrame(this.sessionId, {
      type: 'assistant/chunk',
      seq: base + 1 - 1 / (this.transientInGap + 1),
      time: value.time,
      data: { attemptId, turn, step, chunk: value.chunk },
    })
    if (this.snapshotEvents !== undefined) this.snapshotEvents.push(frame.event)
    else await this.onFrame(frame)
  }
}

async function emitProjectionBaseline(
  sessionId: string,
  value: unknown,
  onFrame: SessionFrameListener,
): Promise<void> {
  if (!isRecord(value) || !isRecord(value.values)) {
    throw streamProtocolError('Session projection 基线无效')
  }
  const seq = safeInteger(value.asOfSeq, -1)
  if (seq === null) throw streamProtocolError('Session projection 水位无效')
  /* oxlint-disable no-await-in-loop -- projection 基线需要确定的交付顺序。 */
  for (const [key, projection] of Object.entries(value.values)) {
    if (!isDedicatedProjection(key)) continue
    await emitParsedFrame(
      {
        type: 'session/projection',
        sessionId,
        key,
        value: projection,
        seq,
      },
      onFrame,
    )
  }
  /* oxlint-enable no-await-in-loop */
  const change = parsePluginProjectionChange({
    kind: 'snapshot',
    asOfSeq: seq,
    values: value.values,
  })
  if (change !== null) await onFrame({ type: 'session/plugin-projections', sessionId, change })
}

export async function emitControlFrame(
  input: unknown,
  onFrame: SessionFrameListener,
): Promise<void> {
  if (!isRecord(input) || typeof input.type !== 'string') {
    throw streamProtocolError('收到无效的 session/control 帧')
  }
  if (input.type === 'baseline') {
    if (
      !isRecord(input.value) ||
      !isRecord(input.value.jobs) ||
      !isRecord(input.value.projections)
    ) {
      throw streamProtocolError('Session control 基线无效')
    }
    await onFrame({ type: 'session/stream-reset' })
    /* oxlint-disable no-await-in-loop -- reset 与 projection 基线必须顺序交付。 */
    for (const [sessionId, projection] of Object.entries(input.value.projections)) {
      await emitProjectionBaseline(sessionId, projection, onFrame)
    }
    /* oxlint-enable no-await-in-loop */
    return
  }
  if (input.type === 'projection') {
    await emitParsedFrame(
      {
        type: 'session/projection',
        sessionId: input.sessionId,
        key: input.key,
        value: input.value,
        seq: input.seq,
      },
      onFrame,
    )
    return
  }
  if (input.type !== 'jobs') throw streamProtocolError('收到未知的 session/control 帧')
}
