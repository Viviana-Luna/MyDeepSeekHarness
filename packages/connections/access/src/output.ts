/** 后台连接工具的字节预算与分页；只返回有界值，不创建结果文件。 */
import { createHash } from 'node:crypto'

/** 低于当前 spill 的 50,000 字节门槛，计入完整 JSON 与分页元数据。 */
export const CONNECTION_TOOL_BYTES = 48 * 1024

/** 对分页游标绑定调用范围；游标只表达位置，不承担授权。 */
export function connectionPageKey(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)
}

/** 只接受当前查询范围签出的有界位置；修改游标不会扩大授权范围。 */
export function connectionPageOffset(cursor: string | null | undefined, key: string): number {
  if (cursor === undefined || cursor === null) return 0
  if (typeof cursor !== 'string' || cursor.length > 100)
    throw new Error('分页游标无效，请重新读取第一页')
  const [cursorKey, position, extra] = cursor.split(':')
  const offset = Number(position)
  if (
    cursorKey !== key ||
    !/^\d+$/u.test(position ?? '') ||
    extra !== undefined ||
    !Number.isSafeInteger(offset) ||
    offset > 1_000_000
  )
    throw new Error('分页范围已变化，请重新读取第一页')
  return offset
}

/** 返回可序列化且有界的完整项目；单项过大时拒绝，不截断类型或字段名。 */
export function connectionPage<T>(
  items: readonly T[],
  request: { cursor?: string | null; limit?: number },
  context: { key: string; defaultLimit: number; maxLimit: number; baseOffset?: number },
): { items: T[]; next_cursor: string | null; truncated: boolean } {
  const limit = request.limit ?? context.defaultLimit
  if (!Number.isInteger(limit) || limit < 1 || limit > context.maxLimit)
    throw new Error(`分页数量必须在 1 至 ${context.maxLimit} 之间`)
  const offset =
    context.baseOffset === undefined ? connectionPageOffset(request.cursor, context.key) : 0
  if (offset > items.length) throw new Error('分页范围已变化，请重新读取第一页')
  const result = {
    items: items.slice(offset, offset + limit),
    next_cursor: null as string | null,
    truncated: false,
  }
  const refresh = () => {
    result.truncated = offset + result.items.length < items.length
    result.next_cursor = result.truncated
      ? `${context.key}:${(context.baseOffset ?? offset) + result.items.length}`
      : null
  }
  refresh()
  while (Buffer.byteLength(JSON.stringify(result), 'utf8') > CONNECTION_TOOL_BYTES) {
    result.items.pop()
    if (result.items.length === 0) throw new Error('RESULT_TOO_LARGE：单个结构项目超过工具输出上限')
    refresh()
  }
  return result
}

/** 将表格行列表裁剪到工具字节预算以内，并标记是否发生截断。 */
export function boundTableRows<
  T extends { rows: unknown[][]; rowCount: number; truncated: boolean },
>(result: T, maxBytes = CONNECTION_TOOL_BYTES): T {
  const copy = { ...result, rows: [...result.rows] }
  while (copy.rows.length > 0 && Buffer.byteLength(JSON.stringify(copy), 'utf8') > maxBytes) {
    copy.rows.pop()
    copy.rowCount = copy.rows.length
    copy.truncated = true
  }
  if (Buffer.byteLength(JSON.stringify(copy), 'utf8') > maxBytes)
    throw new Error('RESULT_TOO_LARGE：单行结果超过工具输出上限，请缩小查询列或使用 LIMIT')
  return copy
}

/** 渲染与返回值使用同一份 JSON，避免展示截断却在结构化结果中保留完整副本。 */
export function renderConnectionOutput(value: unknown): { type: 'text'; text: string }[] {
  const text = JSON.stringify(value)
  if (Buffer.byteLength(text, 'utf8') > CONNECTION_TOOL_BYTES)
    throw new Error('RESULT_TOO_LARGE：工具结果超过输出上限')
  return [{ type: 'text', text }]
}

/** 限制异常文本后再交给工具管线，避免服务端超长错误触发额外 spill 副本。 */
export async function runConnectionTool<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    throw boundedConnectionError(error)
  }
}

function boundedConnectionError(error: unknown): Error {
  // 原始 cause 可能包含完整远端响应，安全边界不能把它作为另一份结果继续传播。
  const message =
    error instanceof Error ? error.message.slice(0, 1500) : '连接操作失败，请检查配置与权限后重试'
  return new Error(message)
}
