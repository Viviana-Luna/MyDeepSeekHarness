/**
 * 渲染进程 Git 自动刷新调度 Hook：汇集 Runtime 推送事件、窗口聚焦/可见切换以及切入变更模式三路信号，
 * 参照 VS Code 机制执行单飞行静默刷新、写操作期间自动延后与状态无变化去重。
 */
import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { parseDesktopProjectEvent } from '../../../../shared/project-events.ts'
import {
  hasMatchingFileChange,
  isSameGitDiff,
  isSameGitGraph,
  isSameGitSummary,
  isTrackableGitDiff,
  resolveRefreshedDiff,
} from './source-control-refresh.ts'
import {
  parseGitGraph,
  parseGitSummary,
  type GitCommit,
  type GitDiff,
  type GitSummary,
} from './source-control-types.ts'

const FOCUS_REFRESH_THROTTLE_MS = 1_000

/** 自动刷新单次静默拉取后需要合并到 Provider 的增量结果。 */
export interface SilentGitRefreshPatch {
  readonly summary?: GitSummary
  readonly graph?: GitCommit[]
  readonly summaryForDiffs: GitSummary
  readonly previousDiff: GitDiff | null
  readonly nextDiff: GitDiff | null
  readonly diffChanged: boolean
  readonly changed: boolean
}

/** 自动刷新 Hook 输入参数。 */
export interface SourceControlAutoRefreshOptions {
  readonly projectId: string | null
  readonly projectAccessId: string | null
  readonly activeView: string
  readonly gitMutation: 'stage' | 'unstage' | 'commit' | null
  readonly aiRunning: boolean
  readonly requestGenerationRef: RefObject<number>
  readonly projectIdRef: RefObject<string | null>
  readonly gitSummaryRef: RefObject<GitSummary | null>
  readonly gitGraphRef: RefObject<readonly GitCommit[]>
  readonly selectedDiffRef: RefObject<GitDiff | null>
  readonly callProject: (
    operation: 'gitSummary' | 'gitGraph' | 'gitDiff',
    payload?: Record<string, unknown>,
  ) => Promise<unknown>
  readonly onApply: (patch: SilentGitRefreshPatch) => void
}

async function fetchSilentPatch(
  options: SourceControlAutoRefreshOptions,
  includeGraph: boolean,
  requestGeneration: number,
  requestProjectId: string,
): Promise<SilentGitRefreshPatch | null> {
  const isStale = () =>
    options.requestGenerationRef.current !== requestGeneration ||
    options.projectIdRef.current !== requestProjectId
  const summary = parseGitSummary(await options.callProject('gitSummary'))
  if (isStale()) return null
  const previousSummary = options.gitSummaryRef.current
  if (!summary.available && previousSummary?.available === true) return null
  const shouldFetchGraph =
    includeGraph ||
    summary.branch !== previousSummary?.branch ||
    summary.ahead !== previousSummary?.ahead ||
    summary.behind !== previousSummary?.behind ||
    options.gitGraphRef.current.length === 0
  const currentDiff = options.selectedDiffRef.current
  const trackable = isTrackableGitDiff(currentDiff)
  const [graph, nextDiff] = await Promise.all([
    shouldFetchGraph ? options.callProject('gitGraph').then(parseGitGraph) : Promise.resolve(null),
    trackable && hasMatchingFileChange(summary, currentDiff)
      ? resolveRefreshedDiff({
          summary,
          currentDiff,
          loadDiff: (relativePath, mode) => options.callProject('gitDiff', { relativePath, mode }),
          silent: true,
        })
      : Promise.resolve(trackable ? null : currentDiff),
  ])
  if (isStale()) return null
  const summaryChanged = !isSameGitSummary(previousSummary, summary)
  const graphChanged = graph !== null && !isSameGitGraph(options.gitGraphRef.current, graph)
  const diffChanged = trackable && !isSameGitDiff(currentDiff, nextDiff)
  return {
    ...(summaryChanged ? { summary } : {}),
    ...(graphChanged && graph !== null ? { graph } : {}),
    summaryForDiffs: summary,
    previousDiff: currentDiff,
    nextDiff,
    diffChanged,
    changed: summaryChanged || graphChanged || diffChanged,
  }
}

function useProjectGitEventSubscription(
  projectAccessId: string | null,
  onTrigger: (includeGraph: boolean) => void,
): void {
  useEffect(() => {
    if (projectAccessId === null) return
    const listen = window.dshDesktop?.projects?.onEvent
    if (typeof listen !== 'function') return
    return listen(raw => {
      const event = parseDesktopProjectEvent(raw)
      if (event === null || event.projectId !== projectAccessId) return
      onTrigger(event.scope === 'refs')
    })
  }, [onTrigger, projectAccessId])
}

function useWindowFocusRefresh(
  projectAccessId: string | null,
  onTrigger: (includeGraph: boolean) => void,
): void {
  const lastFocusRefreshAt = useRef(0)
  useEffect(() => {
    if (projectAccessId === null) return
    const triggerFromFocus = () => {
      if (document.visibilityState === 'hidden') return
      const now = Date.now()
      if (now - lastFocusRefreshAt.current < FOCUS_REFRESH_THROTTLE_MS) return
      lastFocusRefreshAt.current = now
      onTrigger(true)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') triggerFromFocus()
    }
    window.addEventListener('focus', triggerFromFocus)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('focus', triggerFromFocus)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [onTrigger, projectAccessId])
}

/**
 * 订阅当前项目的 Git 外部变更事件、窗口重新聚焦与进入变更视图事件，
 * 执行无感后台刷新并在有写操作或 AI 提交时自动延后，返回取消排队刷新的回调。
 */
export function useSourceControlAutoRefresh(options: SourceControlAutoRefreshOptions): {
  cancelQueued(): void
} {
  const { projectId, projectAccessId, activeView, gitMutation, aiRunning } = options
  const optionsRef = useRef(options)
  optionsRef.current = options
  const inFlightRef = useRef(false)
  const queuedRef = useRef<{ includeGraph: boolean } | null>(null)
  const previousViewRef = useRef(activeView)

  const cancelQueued = useCallback(() => {
    queuedRef.current = null
  }, [])

  const runSilent = useCallback(async (includeGraph: boolean) => {
    const current = optionsRef.current
    const requestProjectId = current.projectId
    if (current.projectAccessId === null || requestProjectId === null) return
    if (current.gitMutation !== null || current.aiRunning || inFlightRef.current) {
      queuedRef.current = {
        includeGraph: Boolean(queuedRef.current?.includeGraph || includeGraph),
      }
      return
    }
    const requestGeneration = current.requestGenerationRef.current
    inFlightRef.current = true
    try {
      const patch = await fetchSilentPatch(
        current,
        includeGraph,
        requestGeneration,
        requestProjectId,
      )
      if (patch !== null) optionsRef.current.onApply(patch)
    } catch {
      // 静默后台刷新遇到短暂锁冲突或中断时不覆盖用户可见状态与错误提示。
    } finally {
      inFlightRef.current = false
      const latest = optionsRef.current
      const queued = queuedRef.current
      if (
        queued !== null &&
        latest.projectIdRef.current === requestProjectId &&
        latest.gitMutation === null &&
        !latest.aiRunning
      ) {
        queuedRef.current = null
        void runSilent(queued.includeGraph)
      }
    }
  }, [])

  useEffect(() => {
    inFlightRef.current = false
    queuedRef.current = null
  }, [projectAccessId, projectId])

  useProjectGitEventSubscription(projectAccessId, runSilent)
  useWindowFocusRefresh(projectAccessId, runSilent)

  useEffect(() => {
    const previous = previousViewRef.current
    previousViewRef.current = activeView
    if (projectAccessId !== null && activeView === 'changes' && previous !== 'changes') {
      void runSilent(true)
    }
  }, [activeView, projectAccessId, runSilent])

  useEffect(() => {
    const queued = queuedRef.current
    if (gitMutation === null && !aiRunning && queued !== null) {
      queuedRef.current = null
      void runSilent(queued.includeGraph)
    }
  }, [aiRunning, gitMutation, runSilent])

  return { cancelQueued }
}
