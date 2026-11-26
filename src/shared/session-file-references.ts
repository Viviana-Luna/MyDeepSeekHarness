import type { CanonicalSessionEvent } from './session-projection.ts'
import { isRecord } from './validation.ts'

function mutationPath(name: unknown, argumentsText: unknown): string | undefined {
  if (typeof argumentsText !== 'string') return undefined
  let args: unknown
  try {
    args = JSON.parse(argumentsText)
  } catch {
    return undefined
  }
  if (!isRecord(args)) return undefined
  let path: unknown
  if (name === 'write' && typeof args.content === 'string') path = args.file_path
  if (
    name === 'edit' &&
    typeof args.old_string === 'string' &&
    args.old_string.length > 0 &&
    typeof args.new_string === 'string' &&
    args.old_string !== args.new_string &&
    (args.replace_all === undefined || typeof args.replace_all === 'boolean')
  )
    path = args.file_path
  if (
    name === 'str_replace_editor' &&
    ((args.command === 'create' && typeof args.file_text === 'string') ||
      (args.command === 'str_replace' &&
        typeof args.old_str === 'string' &&
        args.old_str.length > 0 &&
        (args.new_str === undefined || typeof args.new_str === 'string')) ||
      (args.command === 'insert' &&
        Number.isSafeInteger(args.insert_line) &&
        Number(args.insert_line) >= 0 &&
        typeof args.new_str === 'string'))
  )
    path = args.path
  return typeof path === 'string' && path.trim().length > 0 ? path : undefined
}

/** 只把本轮已成功修改或明确交付的文件交给后续回复；正文、读取和失败调用不提供依据。 */
export function projectSessionFileReferences(
  events: readonly CanonicalSessionEvent[],
): ReadonlyMap<number, readonly string[]> {
  const replies = new Map<number, readonly string[]>()
  const turns = new Map<number, Set<string>>()
  const calls = new Map<string, { turn: number; path: string }>()
  let activeTurn: number | undefined
  for (const event of events) {
    if (!isRecord(event.data)) continue
    const data = event.data
    const turn =
      typeof data.turn === 'number' && Number.isSafeInteger(data.turn) && data.turn >= 0
        ? data.turn
        : activeTurn
    if (event.type === 'turn/start') activeTurn = turn
    if (event.type === 'turn/end') activeTurn = undefined
    if (turn === undefined || (event.surfaceOp !== undefined && event.surfaceOp !== 'append'))
      continue
    const paths = turns.get(turn) ?? new Set<string>()
    turns.set(turn, paths)
    if (event.type === 'tool/call' && typeof data.callId === 'string') {
      const path = mutationPath(data.name, data.arguments)
      if (path !== undefined) calls.set(data.callId, { turn, path })
      else calls.delete(data.callId)
    }
    if (event.type === 'tool/result' && event.surfaceOp === 'append' && isRecord(data.message)) {
      const source = data.message.source
      const result: unknown = Array.isArray(data.message.content)
        ? data.message.content[0]
        : undefined
      if (isRecord(source) && source.kind === 'tool' && typeof source.callId === 'string') {
        const call = calls.get(source.callId)
        calls.delete(source.callId)
        if (
          call?.turn === turn &&
          isRecord(result) &&
          result.type === 'tool-result' &&
          (result.isError === undefined || result.isError === false)
        )
          paths.add(call.path)
      }
    }
    if (
      event.type === 'deliverables/presented' &&
      typeof data.callId === 'string' &&
      data.callId.length > 0 &&
      Array.isArray(data.files)
    ) {
      for (const file of data.files) {
        if (
          isRecord(file) &&
          typeof file.path === 'string' &&
          file.path.trim().length > 0 &&
          (file.description === undefined || typeof file.description === 'string')
        )
          paths.add(file.path)
      }
    }
    if (event.type === 'assistant/message' && data.interrupted !== true && paths.size > 0) {
      replies.set(event.seq, [...paths])
    }
  }
  return replies
}
