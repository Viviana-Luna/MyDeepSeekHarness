/** AI 提交的窄数据契约；不传递凭据、可执行命令或可应用补丁。 */

/** 单次受管 Git 命令的执行期限。 */
export const GIT_AI_COMMAND_TIMEOUT_MS = 90_000

/** 整次 AI 批量提交的后台执行期限。 */
export const GIT_AI_EXECUTION_TIMEOUT_MS = 10 * 60_000

/** 发布开始后还可能需要更新引用、核对引用和刷新状态，再清理进程及锁。 */
export const GIT_AI_REPLY_TIMEOUT_MS =
  GIT_AI_EXECUTION_TIMEOUT_MS + 3 * GIT_AI_COMMAND_TIMEOUT_MS + 30_000

/** 用户确认允许发送的类别。 */
export interface GitAiScope {
  staged: boolean
  working: boolean
  untracked: boolean
}

/** 批次仅引用后台快照内的标识。 */
export interface GitAiPlanBatch {
  message: string
  itemIds: string[]
}

/** 完整分组，未提交项也必须登记。 */
export interface GitAiPlan {
  batches: GitAiPlanBatch[]
  deferred: string[]
}

/** 一个不可再自动拆分的文件版本。 */
export interface GitAiItem {
  id: string
  relativePath: string
  mode: 'staged' | 'working'
  requiresWholeFile: boolean
}

/** 明确展示被安全策略阻止的内容。 */
export interface GitAiExcludedChange {
  relativePath: string
  mode: 'staged' | 'working'
  reason: string
}

/** 返回 renderer 的可审阅方案，快照仅在后台保存。 */
export interface GitAiAnalysis {
  id: string
  plan: GitAiPlan
  items: GitAiItem[]
  excluded: GitAiExcludedChange[]
}

/** 单批结果；失败不会撤销已完成的批次。 */
export interface GitAiExecution {
  completed: Array<{ message: string; commitHash: string; itemIds: string[] }>
  error: string | null
  stale: boolean
}

/** 受限项目操作所需字段，主进程及后台仍逐操作校验。 */
export interface GitAiPayload {
  id?: string
  scope?: GitAiScope
  provider?: string
  model?: string
  plan?: GitAiPlan
  wholeFileIds?: string[]
  itemId?: string
  confirmed?: boolean
}

/** 复用项目调用通道，不另设业务协议。 */
export const GIT_AI_OPERATIONS = [
  'gitAiAnalyze',
  'gitAiCancel',
  'gitAiDiff',
  'gitAiValidate',
  'gitAiExecute',
  'gitAiRelease',
] as const
