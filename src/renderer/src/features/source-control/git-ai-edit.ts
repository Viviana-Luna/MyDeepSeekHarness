/** renderer 纯分组编辑；不生成路径、补丁或提交命令。 */
import type { GitAiPlan } from '../../../../shared/git-ai.ts'

/** 将标识移动到某批、独立新批（-2）或暂不提交（-1），移除空批。 */
export function moveGitAiItems(plan: GitAiPlan, ids: string[], target: number): GitAiPlan {
  const selected = new Set(ids)
  const batches = plan.batches.map((batch, index) => ({
    ...batch,
    itemIds: [...batch.itemIds.filter(id => !selected.has(id)), ...(index === target ? ids : [])],
  }))
  if (target === -2) batches.push({ message: '', itemIds: ids })
  return {
    batches: batches.filter(batch => batch.itemIds.length),
    deferred: [...plan.deferred.filter(id => !selected.has(id)), ...(target === -1 ? ids : [])],
  }
}

/** 顺序调整只改变待提交批次，不改变文件版本。 */
export function reorderGitAiBatch(plan: GitAiPlan, index: number, offset: number): GitAiPlan {
  const batches = [...plan.batches]
  const target = index + offset
  if (target < 0 || target >= batches.length) return plan
  ;[batches[index], batches[target]] = [batches[target]!, batches[index]!]
  return { ...plan, batches }
}
