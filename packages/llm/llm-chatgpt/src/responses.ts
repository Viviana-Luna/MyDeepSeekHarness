import { createParser } from 'eventsource-parser'
import { LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  completedItem,
  responseFailure,
  invalid,
  MAX_RESPONSE_BYTES,
  record,
  replayEnvelope,
  text,
  tokenUsage,
} from './protocol.ts'
import type { RecordValue } from './protocol.ts'

/** 解析器负责 SSE 分帧；取消和退出始终释放 reader，不把未闭合尾帧当作成功。 */
async function* events(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  activity: () => void,
): AsyncGenerator<RecordValue> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let pending: string[] = [],
    received = 0
  const parser = createParser({
    maxBufferSize: MAX_RESPONSE_BYTES,
    onEvent: event => {
      pending.push(event.data)
    },
    onError: error => {
      if (error.type === 'max-buffer-size-exceeded') invalid('ChatGPT 事件超过大小限制')
    },
  })
  const abort = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) break
      activity()
      received += chunk.value.byteLength
      if (received > MAX_RESPONSE_BYTES) invalid('ChatGPT 响应超过大小限制')
      parser.feed(decoder.decode(chunk.value, { stream: true }))
      const batch = pending
      pending = []
      for (const data of batch) {
        if (data === '[DONE]') throw new LlmError('ChatGPT 响应缺少完成事件', 'STREAM_CLOSED')
        let value: unknown
        try {
          value = JSON.parse(data)
        } catch {
          invalid('ChatGPT 事件不是有效 JSON')
        }
        if (!record(value) || typeof value.type !== 'string') invalid('ChatGPT 事件结构无效')
        yield value
      }
    }
    throw new LlmError('ChatGPT 响应在完成前中断', 'STREAM_CLOSED')
  } finally {
    signal.removeEventListener('abort', abort)
    try {
      await reader.cancel()
    } catch {
      /* 网络中断时 reader 可能已关闭。 */
    }
    reader.releaseLock()
  }
}

interface ItemState {
  index: number
  item: RecordValue
  done: boolean
  value?: ReturnType<typeof completedItem>
}

/** 原生压缩仅进入私有回放；其他输出映射成可见块，完整响应结束后才提交回放状态。 */
export async function* responseChunks(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  activity: () => void,
  accountId: string,
  model: string,
  replayedCompaction = false,
): AsyncGenerator<StreamChunk> {
  const items = new Map<number, ItemState>()
  for await (const event of events(body, signal, activity)) {
    if (
      event.type === 'response.failed' ||
      event.type === 'error' ||
      event.type === 'response.incomplete'
    ) {
      const response = record(event.response) ? event.response : {}
      const usage = tokenUsage(response.usage)
      if (usage !== undefined) yield { type: 'usage', usage }
      if (
        event.type === 'response.incomplete' &&
        record(response.incomplete_details) &&
        response.incomplete_details.reason === 'max_output_tokens'
      ) {
        // 通用组装器会删除未能安全执行的工具调用，不提交私有回放。
        yield { type: 'finish', reason: { kind: 'max-tokens' } }
        return
      }
      const detail = record(response.error)
        ? response.error
        : record(event.error)
          ? event.error
          : event
      throw responseFailure(detail)
    }
    if (event.type === 'response.completed') {
      if (
        !record(event.response) ||
        event.response.status !== 'completed' ||
        items.size === 0 ||
        [...items.values()].some(item => !item.done)
      )
        invalid('ChatGPT 完成事件与输出条目不一致')
      const states = [...items.values()]
      // 实测终结事件可能省略输出或返回空数组，正文已由 output_item.done 完整提交。
      // 非空 output 仍须与完成条目一致，不能用终结事件掩盖缺失或未完成的条目。
      if (event.response.output !== undefined) {
        if (
          !Array.isArray(event.response.output) ||
          (event.response.output.length !== 0 && event.response.output.length !== states.length)
        )
          invalid('ChatGPT 完成事件缺少输出条目')
        for (const [index, raw] of event.response.output.entries()) {
          if (!record(raw)) invalid('ChatGPT 最终输出结构无效')
          const final = completedItem(raw),
            state = states[index]!
          if (JSON.stringify(final.block) !== JSON.stringify(state.value!.block))
            invalid('ChatGPT 最终输出与流内容不一致')
          // 完成事件可能补齐密文，但不能修改正文、调用或已知标识。
          if (final.replay.id !== state.value!.replay.id) invalid('ChatGPT 最终输出标识不一致')
          state.value = final
        }
      }
      if (
        !states.some(
          state =>
            state.value!.block?.type === 'tool-call' ||
            (state.value!.block?.type === 'text' && state.value!.block.text.trim().length > 0),
        )
      ) {
        throw new LlmError('ChatGPT 没有返回可用的回答或工具调用', 'EMPTY_RESPONSE')
      }
      const usage = tokenUsage(event.response.usage)
      if (usage !== undefined) yield { type: 'usage', usage }
      yield {
        type: 'finish',
        reason: {
          kind: states.some(item => item.item.type === 'function_call') ? 'tool-calls' : 'stop',
        },
        contextCompaction: states.some(item => item.item.type === 'compaction')
          ? 'created'
          : replayedCompaction
            ? 'replayed'
            : 'none',
        replayState: replayEnvelope(
          accountId,
          model,
          states.map(item => item.value!),
        ),
      }
      return
    }
    if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
      const position = event.output_index
      if (
        typeof position !== 'number' ||
        !Number.isSafeInteger(position) ||
        position < 0 ||
        !record(event.item)
      )
        invalid('ChatGPT 输出位置无效')
      const item = event.item
      if (
        !['message', 'reasoning', 'function_call', 'compaction'].includes(String(item.type)) ||
        typeof item.id !== 'string'
      )
        invalid('ChatGPT 输出类型无效')
      let state = items.get(position)
      if (state === undefined) {
        if (position !== items.size || items.size >= 4096) invalid('ChatGPT 输出条目不连续或过多')
        state = { index: position, item, done: false }
        items.set(position, state)
        if (item.type !== 'compaction')
          yield {
            type: 'block-start',
            index: position,
            blockType:
              item.type === 'message'
                ? 'text'
                : item.type === 'reasoning'
                  ? 'reasoning'
                  : 'tool-call',
          }
      } else if (
        state.done ||
        state.item.id !== item.id ||
        state.item.type !== item.type ||
        event.type === 'response.output_item.added'
      ) {
        invalid('ChatGPT 输出条目重复或不匹配')
      }
      if (event.type === 'response.output_item.done') {
        state.value = completedItem(item)
        state.done = true
        if (state.value.block !== null)
          yield { type: 'block-end', index: state.index, block: state.value.block }
      }
      continue
    }
    if (
      event.type === 'response.output_text.delta' ||
      event.type === 'response.refusal.delta' ||
      event.type === 'response.reasoning_summary_text.delta' ||
      event.type === 'response.function_call_arguments.delta'
    ) {
      const state =
        typeof event.output_index === 'number' ? items.get(event.output_index) : undefined
      if (!state || state.done || event.item_id !== state.item.id)
        invalid('ChatGPT 增量缺少对应的输出条目')
      const delta = text(event.delta)
      if (event.type === 'response.function_call_arguments.delta') {
        if (state.item.type !== 'function_call') invalid('ChatGPT 工具增量类型不匹配')
        yield {
          type: 'tool-call-delta',
          index: state.index,
          id: ToolCallId(text(state.item.call_id)),
          name: text(state.item.name),
          argumentsDelta: delta,
        }
      } else {
        const reasoning = event.type === 'response.reasoning_summary_text.delta'
        if (state.item.type !== (reasoning ? 'reasoning' : 'message'))
          invalid('ChatGPT 文本增量类型不匹配')
        yield {
          type: reasoning ? 'reasoning-delta' : 'text-delta',
          index: state.index,
          text: delta,
        }
      }
    }
  }
}
