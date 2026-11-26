/** 主进程与后台共用的 AI 提交参数校验；拒绝未知字段、任意路径和补丁。 */
import { isRecord } from './validation.ts'
import { GIT_AI_OPERATIONS, type GitAiPayload } from './git-ai.ts'

const fields: Record<string, string[]> = {
  gitAiAnalyze: ['id', 'scope', 'provider', 'model', 'confirmed'],
  gitAiCancel: ['id'],
  gitAiRelease: ['id'],
  gitAiValidate: ['id'],
  gitAiDiff: ['id', 'itemId'],
  gitAiExecute: ['id', 'plan', 'wholeFileIds', 'confirmed'],
}

/** 确认此操作属于 AI 提交白名单。 */
export function isGitAiOperation(
  operation: unknown,
): operation is (typeof GIT_AI_OPERATIONS)[number] {
  return (
    typeof operation === 'string' && (GIT_AI_OPERATIONS as readonly string[]).includes(operation)
  )
}

/** 验证消息大小、标识和确认字段；标识归属由后台快照复核。 */
export function validateGitAiPayload(operation: string, value: unknown): GitAiPayload {
  const allowed = fields[operation]
  if (
    !allowed ||
    !isRecord(value) ||
    Object.keys(value).length !== allowed.length ||
    allowed.some(key => !Object.hasOwn(value, key)) ||
    JSON.stringify(value).length > 64 * 1024
  )
    throw new Error('AI 提交方法或字段无效')
  if (typeof value.id !== 'string' || !/^[a-z0-9-]{1,128}$/u.test(value.id))
    throw new Error('AI 提交标识无效')
  if ('confirmed' in value && value.confirmed !== true) throw new Error('请明确确认 AI 提交操作')
  if (operation === 'gitAiAnalyze') {
    if (
      !isRecord(value.scope) ||
      Object.keys(value.scope).length !== 3 ||
      !['staged', 'working', 'untracked'].every(
        key => typeof (value.scope as Record<string, unknown>)[key] === 'boolean',
      )
    )
      throw new Error('AI 提交范围无效')
    for (const key of ['provider', 'model'])
      if (
        typeof value[key] !== 'string' ||
        !value[key] ||
        (value[key] as string).length > 256 ||
        (value[key] as string).includes('\0')
      )
        throw new Error('AI 提交模型无效')
  }
  if (
    operation === 'gitAiDiff' &&
    (typeof value.itemId !== 'string' || !/^[a-f0-9]{64}$/u.test(value.itemId))
  )
    throw new Error('AI 提交文件标识无效')
  if (operation === 'gitAiExecute') {
    if (
      !isRecord(value.plan) ||
      !Array.isArray(value.wholeFileIds) ||
      value.wholeFileIds.length > 200 ||
      value.wholeFileIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/u.test(id))
    )
      throw new Error('AI 提交确认方案无效')
  }
  return value as GitAiPayload
}
