/** 主进程登记窗口内 AI 方案的生命周期；沿用项目 Remote，页面离开时释放后台请求。 */
import type { BrowserWindow } from 'electron'
import { validateGitAiPayload } from '../../shared/git-ai-validation.ts'
import { parseGitAiPlan } from '../../runtime/workspace/git-ai-plan.ts'

/** 仅在发送方与项目已复核后调用；不新建 IPC 通道，不保存代码或凭据。 */
export function createGitAiController(options: {
  window: BrowserWindow
  call(projectId: string, operation: string, payload: Record<string, unknown>): Promise<unknown>
}) {
  const requests = new Map<string, string>()
  let generation = 0
  const clear = () => {
    generation += 1
    for (const [projectId, id] of requests)
      void options.call(projectId, 'gitAiRelease', { id }).catch(() => {})
    requests.clear()
  }
  options.window.webContents.on('did-navigate', clear)
  options.window.webContents.on('render-process-gone', clear)
  options.window.once('closed', clear)
  return async (projectId: string, operation: string, value: Record<string, unknown>) => {
    const payload = validateGitAiPayload(operation, value)
    // 分析失败或页面清理已撤销所有权时，重复释放只是空操作，绝不转发去释放其他方案。
    if (
      (operation === 'gitAiRelease' || operation === 'gitAiCancel') &&
      requests.get(projectId) !== payload.id
    )
      return { released: true }
    if (operation === 'gitAiExecute') {
      const plan = payload.plan!
      if (!Array.isArray(plan.batches) || !Array.isArray(plan.deferred))
        throw new Error('AI 提交方案格式无效')
      const ids = [
        ...plan.batches.flatMap(batch => (Array.isArray(batch?.itemIds) ? batch.itemIds : [])),
        ...plan.deferred,
      ]
      if (ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/u.test(id)))
        throw new Error('AI 提交方案标识无效')
      parseGitAiPlan(JSON.stringify(plan), ids)
    }
    const started = generation
    if (operation === 'gitAiAnalyze') {
      if (requests.has(projectId)) throw new Error('此项目已有 AI 提交方案，请先退出或取消')
      requests.set(projectId, payload.id!)
    } else if (requests.get(projectId) !== payload.id) throw new Error('AI 提交方案不属于当前窗口')
    try {
      const result = await options.call(projectId, operation, value)
      if (started !== generation) {
        await options.call(projectId, 'gitAiRelease', { id: payload.id }).catch(() => {})
        throw new Error('AI 提交页面已关闭，结果已丢弃')
      }
      if (
        (operation === 'gitAiRelease' || operation === 'gitAiCancel') &&
        requests.get(projectId) === payload.id
      )
        requests.delete(projectId)
      return result
    } catch (error) {
      if (operation === 'gitAiAnalyze' && requests.get(projectId) === payload.id)
        requests.delete(projectId)
      throw error
    }
  }
}
