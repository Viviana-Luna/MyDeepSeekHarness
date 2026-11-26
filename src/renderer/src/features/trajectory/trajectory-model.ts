import { normalizeSessionEvents } from '../../../../shared/session-projection.ts'

export type RecordKind = 'input' | 'model' | 'tool' | 'context' | 'system' | 'compaction'
export interface TraceRecord {
  id: string
  seq: number
  turn: number
  step: number | null
  kind: RecordKind
  name: string
  text: string
  input: string | null
  output: string | null
  thinking: string | null
  schema: string | null
  raw: string
  startedAt: number | null
  endedAt: number | null
  firstTokenAt: number | null
  status: 'running' | 'complete' | 'error' | 'interrupted'
  callId: string | null
  parentCallId: string | null
  usage: { input: number | null; output: number | null; reasoning: number | null } | null
}
export interface TraceTurn {
  turn: number
  startedAt: number | null
  endedAt: number | null
  records: TraceRecord[]
}
export const recordLabels: Record<RecordKind, string> = {
  input: '用户',
  model: '助手',
  tool: '工具',
  context: '上下文',
  system: '系统',
  compaction: '压缩',
}
const object = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const number = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null
const string = (value: unknown): string => (typeof value === 'string' ? value : '')
export function traceJson(value: unknown): string {
  if (typeof value === 'string') return value
  return value === undefined ? '' : JSON.stringify(value, null, 2)
}
function content(value: unknown, kind = 'text'): string {
  if (typeof value === 'string') return kind === 'text' ? value : ''
  if (!Array.isArray(value)) return ''
  return value
    .flatMap(block =>
      object(block).type === kind
        ? [string(object(block).text)]
        : object(block).type === 'tool-result'
          ? [content(object(block).content, kind)]
          : [],
    )
    .filter(Boolean)
    .join('\n')
}
function attachmentSummary(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value
    .flatMap(block =>
      ['image', 'file'].includes(string(object(block).type))
        ? [
            string(object(object(block).attachment).name) ||
              (object(block).type === 'image' ? '图片附件' : '文件附件'),
          ]
        : [],
    )
    .join('、')
}
function usage(value: unknown): TraceRecord['usage'] {
  const data = object(value)
  return Object.keys(data).length === 0
    ? null
    : {
        input: number(data.inputTokens),
        output: number(data.outputTokens),
        reasoning: number(data.reasoningTokens),
      }
}

/** 轨迹直接消费原始事件；参数不经过对话摘要截断，缺失的时间与 Schema 保持未知。 */
export function projectTrace(history: unknown, running = false): TraceTurn[] {
  const turns = new Map<number, TraceTurn>()
  const models = new Map<string, TraceRecord>()
  const calls = new Map<string, TraceRecord>()
  const starts = new Map<string, number>()
  const chunks = new Map<string, Map<number, { type: string; text: string }>>()
  const attempts = new Map<string, number>()
  let tools: unknown[] = []
  let turn = 0
  let step: number | null = null
  const ensure = (id: number): TraceTurn => {
    let result = turns.get(id)
    if (result === undefined) {
      result = { turn: id, startedAt: null, endedAt: null, records: [] }
      turns.set(id, result)
    }
    return result
  }
  const create = (kind: RecordKind, seq: number, time: number, data: unknown): TraceRecord => ({
    id: `${kind}-${seq}`,
    seq,
    turn,
    step,
    kind,
    name: recordLabels[kind],
    text: '',
    input: null,
    output: null,
    thinking: null,
    schema: null,
    raw: traceJson(data),
    startedAt: time,
    endedAt: time,
    firstTokenAt: null,
    status: 'complete',
    callId: null,
    parentCallId: null,
    usage: null,
  })
  for (const event of normalizeSessionEvents(history)) {
    const data = object(event.data)
    turn = number(data.turn) ?? turn
    step = number(data.step) ?? step
    const owner = ensure(turn)
    const modelKey = `${turn}:${step ?? event.seq}`
    if (event.type === 'turn/start') {
      owner.startedAt = event.time
      step = null
      continue
    }
    if (event.type === 'turn/end') {
      owner.endedAt = event.time
      for (const record of owner.records)
        if (record.status === 'running') record.status = 'interrupted'
      turn = 0
      step = null
      continue
    }
    if (event.type === 'step/start') {
      starts.set(modelKey, event.time)
      continue
    }
    if (event.type === 'request/header') {
      const definitions = object(data.header).tools
      tools = Array.isArray(definitions) ? definitions : []
      continue
    }
    if (
      event.type === 'user/message' ||
      event.type === 'system/message' ||
      event.type === 'compaction/summary'
    ) {
      const kind =
        event.type === 'system/message'
          ? 'system'
          : event.type === 'compaction/summary'
            ? 'compaction'
            : object(data.source).kind !== undefined && object(data.source).kind !== 'user'
              ? 'context'
              : 'input'
      const record = create(kind, event.seq, event.time, event.data)
      const blocks =
        event.type === 'system/message'
          ? object(data.message).content
          : event.type === 'compaction/summary'
            ? data.summary
            : data.content
      record.text = content(blocks) || attachmentSummary(blocks)
      record.input = record.text
      if (record.text !== '') owner.records.push(record)
      continue
    }
    if (
      event.type === 'assistant/chunk' ||
      event.type === 'assistant/message' ||
      event.type === 'assistant/attempt'
    ) {
      let record = models.get(modelKey)
      if (record === undefined) {
        record = create('model', event.seq, event.time, event.data)
        record.id = `model-${modelKey}-${attempts.get(modelKey) ?? 0}`
        record.startedAt = starts.get(modelKey) ?? null
        record.endedAt = null
        record.status = 'running'
        owner.records.push(record)
        models.set(modelKey, record)
      }
      if (event.type === 'assistant/chunk') {
        const chunk = object(data.chunk)
        if (chunk.type === 'usage') record.usage = usage(chunk.usage)
        if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') continue
        record.firstTokenAt ??= event.time
        let blocks = chunks.get(modelKey)
        if (blocks === undefined) {
          blocks = new Map()
          chunks.set(modelKey, blocks)
        }
        const index = number(chunk.index) ?? 0
        const previous = blocks.get(index)
        blocks.set(index, {
          type: string(chunk.type),
          text: (previous?.text ?? '') + string(chunk.text),
        })
        const ordered = [...blocks.entries()]
          .toSorted((a, b) => a[0] - b[0])
          .map(([, block]) => block)
        record.output = ordered
          .filter(block => block.type === 'text-delta')
          .map(block => block.text)
          .join('\n')
        record.thinking = ordered
          .filter(block => block.type === 'reasoning-delta')
          .map(block => block.text)
          .join('\n')
        record.text = record.output || record.thinking || '正在生成…'
      } else {
        const blocks = object(data.message).content
        record.output = content(blocks)
        record.thinking = content(blocks, 'reasoning') || null
        const toolNames = Array.isArray(blocks)
          ? blocks.flatMap(block =>
              object(block).type === 'tool-call' ? [string(object(block).name)] : [],
            )
          : []
        record.text =
          record.output ||
          record.thinking ||
          (toolNames.length
            ? `调用 ${toolNames.join('、')}`
            : attachmentSummary(blocks) || '模型响应')
        record.raw = traceJson(event.data)
        record.usage = usage(data.usage) ?? record.usage
        record.endedAt = event.time
        record.status =
          data.interrupted === true || event.type === 'assistant/attempt'
            ? 'interrupted'
            : 'complete'
        if (Array.isArray(data.stream)) {
          for (const item of data.stream) {
            const timed = object(item)
            const chunk = object(timed.chunk)
            if (chunk.type === 'usage') record.usage = usage(chunk.usage) ?? record.usage
            if (
              event.type === 'assistant/attempt' &&
              (timed.type === 'text-chunks' || timed.type === 'reasoning-chunks')
            ) {
              const text = Array.isArray(timed.texts)
                ? timed.texts.filter(fragment => typeof fragment === 'string').join('')
                : ''
              if (timed.type === 'text-chunks') record.output = (record.output ?? '') + text
              else record.thinking = (record.thinking ?? '') + text
            }
            if (
              timed.type === 'text-chunks' ||
              timed.type === 'reasoning-chunks' ||
              timed.type === 'tool-call-chunks'
            ) {
              const members = timed.type === 'tool-call-chunks' ? timed.args : timed.texts
              if (
                Array.isArray(members) &&
                members.some(value => typeof value === 'string' && value.length > 0)
              )
                record.firstTokenAt ??= number(timed.time0)
            }
            if (
              chunk.type === 'text-delta' ||
              chunk.type === 'reasoning-delta' ||
              chunk.type === 'tool-call-delta'
            ) {
              record.firstTokenAt ??= number(timed.time)
            }
          }
        }
        if (event.type === 'assistant/attempt') {
          record.text = `未完成的模型尝试${record.output || record.thinking ? `：${record.output || record.thinking}` : ''}`
          models.delete(modelKey)
          chunks.delete(modelKey)
          starts.delete(modelKey)
          attempts.set(modelKey, (attempts.get(modelKey) ?? 0) + 1)
        }
      }
      continue
    }
    if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') {
      const callId = string(data.callId ?? data.subCallId)
      if (calls.has(callId)) continue
      const record = create('tool', event.seq, event.time, event.data)
      record.name = string(data.name) || '工具'
      record.callId = callId || null
      record.parentCallId = string(data.parentCallId) || null
      record.input = traceJson(data.arguments)
      record.text = `${record.name} ${record.input}`
      record.endedAt = null
      record.status = 'running'
      const definition = tools.find(
        tool =>
          object(tool).name === record.name || object(object(tool).function).name === record.name,
      )
      record.schema = definition === undefined ? null : traceJson(definition)
      owner.records.push(record)
      if (callId !== '') calls.set(callId, record)
      continue
    }
    if (event.type === 'tool/result' || event.type === 'tool/ptc-dispatch') {
      const message = object(data.message)
      const callId = string(data.callId ?? data.subCallId ?? object(message.source).callId)
      let record = calls.get(callId)
      if (record === undefined) {
        record = create('tool', event.seq, event.time, event.data)
        record.startedAt = null
        record.callId = callId || null
        record.name = string(data.name) || '工具结果'
        record.parentCallId = string(data.parentCallId) || null
        owner.records.push(record)
        if (callId !== '') calls.set(callId, record)
      }
      record.output =
        content(message.content ?? data.content) || traceJson(message.content ?? data.content)
      record.text = `${record.name} ${record.input ?? ''}${record.output ? ` → ${record.output}` : ''}`
      record.endedAt = event.time
      record.status =
        message.isError === true ||
        data.isError === true ||
        data.error !== undefined ||
        (Array.isArray(message.content) &&
          message.content.some(block => object(block).isError === true))
          ? 'error'
          : 'complete'
      record.raw = traceJson({ arguments: record.input, result: event.data })
    }
  }
  const result = [...turns.values()]
    .filter(item => item.records.length > 0)
    .toSorted((a, b) => a.records[0]!.seq - b.records[0]!.seq)
  for (const owner of result)
    for (const record of owner.records) {
      if (record.status === 'running' && (!running || owner.endedAt !== null))
        record.status = 'interrupted'
    }
  return result
}

export function traceDuration(record: TraceRecord): number | null {
  return record.startedAt === null || record.endedAt === null
    ? null
    : Math.max(0, record.endedAt - record.startedAt)
}
export function traceSummary(record: TraceRecord): string {
  return record.text.replace(/\s+/gu, ' ').slice(0, 500)
}
export function formatTraceDuration(value: number | null): string {
  return value === null
    ? '—'
    : value < 1000
      ? `${Math.round(value)} 毫秒`
      : `${(value / 1000).toFixed(value < 10000 ? 2 : 1)} 秒`
}
