/** 后台校验模型建议的 Git 分组；本模块不读取仓库、不执行 Git，也不保存模型输入。 */
import { isRecord } from '../../shared/validation.ts'
import type { GitAiPlan, GitAiPlanBatch } from '../../shared/git-ai.ts'
/** 模型与桌面使用相同的分组契约。 */
export type { GitAiPlan, GitAiPlanBatch } from '../../shared/git-ai.ts'

/** 实际提交方案的 UTF-8 文本上限，流式接收和最终校验共用此预算。 */
export const MAX_GIT_AI_PLAN_BYTES = 64 * 1024
const MAX_MESSAGE_BYTES = 16 * 1024
const MAX_ITEMS = 200
const MAX_BATCHES = 50

function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function parseIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS || value.some(id => typeof id !== 'string'))
    throw new Error('AI 提交方案的变更标识无效')
  return [...value]
}

function parseBatch(value: unknown): GitAiPlanBatch {
  if (!isRecord(value) || !hasKeys(value, ['message', 'itemIds']))
    throw new Error('AI 提交批次格式无效')
  const message = value.message
  if (
    typeof message !== 'string' ||
    message.trim() === '' ||
    message.includes('\0') ||
    Buffer.byteLength(message, 'utf8') > MAX_MESSAGE_BYTES
  )
    throw new Error('AI 提交消息无效')
  const itemIds = parseIds(value.itemIds)
  if (itemIds.length === 0) throw new Error('AI 提交批次不能没有变更')
  return { message, itemIds }
}

/**
 * 校验模型的 JSON 分组建议，要求每个可信变更标识恰好出现一次。
 * @param text 模型返回的 JSON 文本，包含 batches 和 deferred，不能包含补丁或命令。
 * @param expectedItemIds 后台从待分析快照生成的唯一标识，不能来自模型。
 * @throws 输出格式、大小、标识归属或覆盖范围无效时抛出，不执行 Git 操作。
 */
export function parseGitAiPlan(text: string, expectedItemIds: readonly string[]): GitAiPlan {
  if (Buffer.byteLength(text, 'utf8') > MAX_GIT_AI_PLAN_BYTES)
    throw new Error('AI 提交方案超过大小上限')
  const expected = new Set(expectedItemIds)
  if (
    expected.size !== expectedItemIds.length ||
    expected.size === 0 ||
    expected.size > MAX_ITEMS ||
    expectedItemIds.some(id => typeof id !== 'string' || id.length === 0)
  )
    throw new Error('待分析变更标识无效')
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('AI 提交方案不是有效的 JSON')
  }
  if (!isRecord(value) || !hasKeys(value, ['batches', 'deferred']) || !Array.isArray(value.batches))
    throw new Error('AI 提交方案格式无效')
  if (value.batches.length > MAX_BATCHES) throw new Error('AI 提交批次数量超过上限')
  const batches = value.batches.map(parseBatch)
  const deferred = parseIds(value.deferred)
  const seen = new Set<string>()
  for (const id of [...batches.flatMap(batch => batch.itemIds), ...deferred]) {
    if (!expected.has(id) || seen.has(id)) throw new Error('AI 提交方案引用未知或重复的变更')
    seen.add(id)
  }
  if (seen.size !== expected.size) throw new Error('AI 提交方案遗漏了待分析变更')
  return { batches, deferred }
}
