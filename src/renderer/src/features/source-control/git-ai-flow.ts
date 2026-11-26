/** renderer AI 提交流程状态机；拥有请求代次与校验定时器，销毁时释放后台请求。 */
import type {
  GitAiAnalysis,
  GitAiExecution,
  GitAiPlan,
  GitAiScope,
} from '../../../../shared/git-ai.ts'
import type { DesktopProjectOperation } from '../../platform/contracts.ts'
import { parseSessionModels, type SessionModels } from '../../domain/session-controls.ts'

/** 通过宿主窄接口传入调用，便于测试取消和迟到响应。 */
export interface GitAiFlowOptions {
  call(operation: DesktopProjectOperation, payload: Record<string, unknown>): Promise<unknown>
  catalog(): Promise<unknown>
  models: SessionModels | null
  openDiff(value: unknown): void
  refresh(): Promise<void>
}

interface State {
  phase: 'normal' | 'prepare' | 'review' | 'result'
  analyzing: boolean
  running: boolean
  analysis: GitAiAnalysis | null
  plan: GitAiPlan
  wholeFileIds: string[]
  scope: GitAiScope
  models: SessionModels | null
  model: { provider: string; model: string } | null
  error: string | null
  stale: boolean
  completed: GitAiExecution['completed']
}

/** 原位四态唯一所有者；已成功批次永不回滚。 */
export class GitAiFlowController {
  private state: State = {
    phase: 'normal',
    analyzing: false,
    running: false,
    analysis: null,
    plan: { batches: [], deferred: [] },
    wholeFileIds: [],
    scope: { staged: true, working: true, untracked: true },
    models: null,
    model: null,
    error: null,
    stale: false,
    completed: [],
  }
  private generation = 0
  private request: string | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly listeners = new Set<() => void>()
  constructor(public options: GitAiFlowOptions) {}

  /** 提供稳定快照供 React 订阅。 */
  snapshot = () => this.state
  /** 仅维护前端订阅；调用者卸载时取消。 */
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private set(patch: Partial<State>) {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  private fail(error: unknown) {
    this.set({
      error: (error instanceof Error ? error.message : 'AI 提交失败').replace(
        /^Error invoking remote method '[^']+': Error:\s*/u,
        '',
      ),
    })
  }
  /** 消息和归属编辑不触发写入。 */
  setPlan = (plan: GitAiPlan) => {
    this.set({ plan })
  }
  /** 范围选择不发送差异。 */
  setScope = (scope: GitAiScope) => {
    this.set({ scope })
  }
  /** 模型选择只影响此流程，不切换会话模型。 */
  setModel = (model: State['model']) => {
    this.set({ model })
  }
  /** 记录用户明确的整文件确认，后台还会复核。 */
  setWholeFileIds = (wholeFileIds: string[]) => {
    this.set({ wholeFileIds })
  }

  /** 进入准备态，仅读取模型目录。 */
  enter = async () => {
    this.set({ phase: 'prepare', error: null })
    const generation = this.generation
    try {
      const models = this.options.models ?? parseSessionModels(await this.options.catalog())
      if (generation !== this.generation) return
      if (!models) throw new Error('模型目录不可用，请检查模型设置')
      this.set({
        models,
        model: { provider: models.current.provider, model: models.current.model },
      })
    } catch (error) {
      if (generation === this.generation) this.fail(error)
    }
  }

  /** 取消分析或退出；保留用户选择及外部手动消息草稿。 */
  release = async (exit: boolean) => {
    this.generation += 1
    clearTimeout(this.timer)
    const id = this.request
    this.request = null
    this.set({
      analyzing: false,
      analysis: null,
      completed: [],
      stale: false,
      error: null,
      phase: exit ? 'normal' : 'prepare',
    })
    if (id) await this.options.call('gitAiRelease', { id }).catch(() => {})
  }

  /** 明确点击开始后发送当前选定模型和范围，迟到结果不恢复流程。 */
  analyze = async () => {
    if (!this.state.model || this.state.analyzing || this.state.running) return
    const expected = this.generation
    await this.release(false)
    if (this.generation !== expected + 1) return
    const generation = ++this.generation
    const id = crypto.randomUUID()
    this.request = id
    this.set({ analyzing: true })
    try {
      const analysis = (await this.options.call('gitAiAnalyze', {
        id,
        scope: this.state.scope,
        ...this.state.model,
        confirmed: true,
      })) as GitAiAnalysis
      if (generation !== this.generation) return
      this.set({ analysis, plan: analysis.plan, wholeFileIds: [], phase: 'review' })
      this.scheduleValidation()
    } catch (error) {
      if (generation === this.generation) {
        this.request = null
        this.fail(error)
      }
    } finally {
      if (generation === this.generation) this.set({ analyzing: false })
    }
  }

  private scheduleValidation() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      void this.validate()
    }, 2_000)
  }
  private async validate() {
    const analysis = this.state.analysis
    if (!analysis) return
    const generation = this.generation
    try {
      const result = (await this.options.call('gitAiValidate', { id: analysis.id })) as {
        stale: boolean
        completed: GitAiExecution['completed']
      }
      if (generation === this.generation)
        this.set({ stale: result.stale, completed: result.completed })
    } catch {
      if (generation === this.generation) this.set({ stale: true })
    }
    if (generation === this.generation) this.scheduleValidation()
  }

  /** 明确确认后执行；重试仅发送未完成批次，后台再次校验基线。 */
  execute = async () => {
    const { analysis, running, stale, plan, completed, wholeFileIds } = this.state
    if (!analysis || running || stale) return
    const generation = this.generation
    this.set({ running: true, phase: 'result', error: null })
    try {
      const done = new Set(completed.flatMap(batch => batch.itemIds))
      const remaining = {
        batches: plan.batches
          .map(batch => ({ ...batch, itemIds: batch.itemIds.filter(id => !done.has(id)) }))
          .filter(batch => batch.itemIds.length),
        deferred: plan.deferred.filter(id => !done.has(id)),
      }
      const result = (await this.options.call('gitAiExecute', {
        id: analysis.id,
        plan: remaining,
        wholeFileIds: wholeFileIds.filter(id => !done.has(id)),
        confirmed: true,
      })) as GitAiExecution
      if (generation === this.generation) this.set(result)
    } catch (error) {
      if (generation === this.generation) this.fail(error)
    } finally {
      if (generation === this.generation) {
        this.set({ running: false })
        await this.options.refresh()
      }
    }
  }

  /** 只打开后台快照的真实 Diff，不从模型或 renderer 拼接补丁。 */
  openFile = async (itemId: string) => {
    if (!this.state.analysis) return
    const generation = this.generation
    try {
      const value = await this.options.call('gitAiDiff', { id: this.state.analysis.id, itemId })
      if (generation === this.generation) this.options.openDiff(value)
    } catch (error) {
      if (generation === this.generation) this.fail(error)
    }
  }

  /** 项目切换或 Provider 卸载时停止校验并撤销后台请求。 */
  dispose() {
    void this.release(true)
    this.listeners.clear()
  }
}
