/** Cordis 后台拥有 AI 请求、可信快照与本地提交任务；退出时中止并等待清理，不持久化差异。 */
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { GitAiAnalysis, GitAiExecution, GitAiPayload } from '../../../src/shared/git-ai.ts'
import { GIT_AI_EXECUTION_TIMEOUT_MS } from '../../../src/shared/git-ai.ts'
import { validateGitAiPayload } from '../../../src/shared/git-ai-validation.ts'
import { parseGitAiPlan } from '../../../src/runtime/workspace/git-ai-plan.ts'
import {
  verifyGitAiSnapshot,
  type GitAiSnapshot,
} from '../../../src/runtime/workspace/git-ai-snapshot.ts'
import { executeGitAiBatch } from '../../../src/runtime/workspace/git-ai-execute.ts'
import type { GitAiRunner } from '../../../src/runtime/workspace/git-ai-process.ts'
import type { ProjectAccessRegistry } from '../../../src/runtime/workspace/project-service.ts'
import { analyzeGitChanges } from './git-ai-model.ts'
import { GitAiError } from '../../../src/runtime/workspace/git-ai-errors.ts'

interface Entry {
  id: string
  projectId: string
  controller: AbortController
  snapshot?: GitAiSnapshot
  analysis?: GitAiAnalysis
  completed: GitAiExecution['completed']
  task?: Promise<unknown>
  expires: number
}

/** 每项目一份限时方案，所有操作再次核对项目授权与请求标识。 */
export class GitAiService {
  private readonly entries = new Map<string, Entry>()
  private readonly timer: ReturnType<typeof setInterval>
  private disposed = false

  constructor(
    private readonly options: {
      registry: ProjectAccessRegistry
      run: GitAiRunner
      llm(): Pick<LlmRuntime, 'stream'>
    },
  ) {
    this.timer = setInterval(() => {
      for (const [project, entry] of this.entries)
        if (!entry.task && entry.expires < Date.now()) this.entries.delete(project)
    }, 60_000)
    this.timer.unref()
  }

  /** 沿用项目操作调用；返回单份权威方案或完成记录。 */
  async call(
    projectId: string,
    operation: string,
    input: GitAiPayload,
    callerSignal?: AbortSignal,
  ) {
    if (this.disposed) throw new Error('AI 提交服务已停止，请重新打开项目')
    callerSignal?.throwIfAborted()
    const payload = validateGitAiPayload(operation, input)
    const entry = this.entries.get(projectId)
    if (operation === 'gitAiCancel' || operation === 'gitAiRelease') {
      if (entry && entry.id === payload.id) {
        entry.controller.abort()
        await entry.task?.catch(() => {})
        if (this.entries.get(projectId) === entry) this.entries.delete(projectId)
      }
      return { released: true }
    }
    this.options.registry.resolveProjectDirectory(projectId)
    if (operation === 'gitAiAnalyze') return this.analyze(projectId, payload)
    if (
      !entry ||
      entry.id !== payload.id ||
      entry.expires < Date.now() ||
      !entry.snapshot ||
      !entry.analysis
    )
      throw new Error('AI 提交方案已失效，请重新分析')
    if (operation === 'gitAiValidate') {
      if (entry.task) return { stale: false, running: true, completed: entry.completed }
      try {
        await verifyGitAiSnapshot(entry.snapshot, this.options.run, entry.controller.signal)
      } catch {
        return { stale: true, running: false, completed: entry.completed }
      }
      return { stale: false, running: false, completed: entry.completed }
    }
    if (entry.task) throw new Error('AI 提交正在执行，请等待本批完成')
    if (operation === 'gitAiDiff') {
      await verifyGitAiSnapshot(entry.snapshot, this.options.run, entry.controller.signal)
      const item = entry.snapshot.items.find(candidate => candidate.id === payload.itemId)
      if (!item) throw new Error('文件不属于此 AI 提交方案')
      return {
        kind: 'git-review-diff' as const,
        relativePath: item.relativePath,
        mode: 'review' as const,
        reviewTitle: 'AI 待提交',
        sources: ['HEAD', item.mode === 'staged' ? '待提交 · 已暂存版本' : '待提交 · 整文件版本'],
        patch: item.patch,
        truncated: false,
        presentation: 'text' as const,
      }
    }
    if (operation !== 'gitAiExecute') throw new Error('不支持的 AI 提交操作')
    const task = this.execute(entry, payload, callerSignal)
    entry.task = task
    try {
      return await task
    } finally {
      delete entry.task
    }
  }

  private async analyze(projectId: string, payload: GitAiPayload): Promise<GitAiAnalysis> {
    const prior = this.entries.get(projectId)
    if (prior?.task) throw new Error('此项目已有 AI 提交任务，请先取消')
    prior?.controller.abort()
    const entry: Entry = {
      id: payload.id!,
      projectId,
      controller: new AbortController(),
      completed: [],
      expires: Date.now() + 30 * 60_000,
    }
    this.entries.set(projectId, entry)
    const signal = AbortSignal.any([entry.controller.signal, AbortSignal.timeout(90_000)])
    try {
      const task = analyzeGitChanges(
        this.options.llm(),
        this.options.registry,
        { projectId, scope: payload.scope!, provider: payload.provider!, model: payload.model! },
        {
          signal,
          run: this.options.run,
          retain: snapshot => {
            entry.snapshot = snapshot
          },
        },
      )
      entry.task = task
      const result = await task
      signal.throwIfAborted()
      entry.analysis = { ...result, id: entry.id }
      return entry.analysis
    } catch (error) {
      this.entries.delete(projectId)
      // 只透传业务层已分类的固定文案；不展开模型或子进程的原始异常链。
      if (!signal.aborted && error instanceof GitAiError) throw error
      throw new GitAiError(
        signal.aborted
          ? 'AI 提交分析已取消或超时，请重试'
          : '无法启动 AI 提交分析，请检查模型服务与项目访问权限后重试',
      )
    } finally {
      delete entry.task
    }
  }

  private async execute(
    entry: Entry,
    payload: GitAiPayload,
    callerSignal: AbortSignal | undefined,
  ): Promise<GitAiExecution> {
    const snapshot = entry.snapshot!
    const plan = parseGitAiPlan(
      JSON.stringify(payload.plan),
      snapshot.items.map(item => item.id),
    )
    const approved = new Set(payload.wholeFileIds)
    if ([...approved].some(id => !snapshot.items.some(item => item.id === id)))
      throw new Error('整文件确认包含未知标识')
    for (const id of plan.batches.flatMap(batch => batch.itemIds)) {
      if (
        entry.analysis!.items.find(item => item.id === id)?.requiresWholeFile &&
        !approved.has(id)
      )
        throw new Error('需手动处理的文件尚未明确确认整文件提交')
    }
    const signal = AbortSignal.any([
      entry.controller.signal,
      AbortSignal.timeout(GIT_AI_EXECUTION_TIMEOUT_MS),
      ...(callerSignal ? [callerSignal] : []),
    ])
    for (const batch of plan.batches) {
      const previous = snapshot.head
      try {
        if (this.options.registry.resolveProjectDirectory(entry.projectId) !== snapshot.project)
          throw new GitAiError('项目授权已变化，请重新打开项目')
        // 每批完成才开始下一批，不自动重试 Git 写操作。
        // oxlint-disable-next-line no-await-in-loop
        const commitHash = await executeGitAiBatch(snapshot, batch, this.options.run, signal)
        entry.completed.push({ ...batch, commitHash })
      } catch (error) {
        const published = snapshot.head !== previous
        if (published) entry.completed.push({ ...batch, commitHash: snapshot.head })
        let stale = true
        try {
          // oxlint-disable-next-line no-await-in-loop
          await verifyGitAiSnapshot(snapshot, this.options.run, signal)
          stale = false
        } catch {
          /* 不把新的工作区内容悄悄纳入旧方案。 */
        }
        let failure = 'Git 提交失败，请检查工作区和 Git 配置后重试'
        if (published)
          failure = `已创建提交 ${snapshot.head}，后续处理失败。请检查仓库状态后重新分析`
        else if (signal.aborted) failure = 'AI 提交已取消或超时，请检查已完成的提交后重试'
        return {
          completed: entry.completed,
          error: error instanceof GitAiError ? error.message : failure,
          stale,
        }
      }
    }
    return { completed: entry.completed, error: null, stale: false }
  }

  /** 窗口或运行时停止后丢弃结果，等待任务释放锁与临时资源。 */
  async dispose(): Promise<void> {
    this.disposed = true
    clearInterval(this.timer)
    for (const entry of this.entries.values()) entry.controller.abort()
    await Promise.allSettled([...this.entries.values()].map(entry => entry.task))
    this.entries.clear()
  }
}
