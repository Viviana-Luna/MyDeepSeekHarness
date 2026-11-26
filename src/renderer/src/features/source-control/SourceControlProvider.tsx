import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useWorkspaceSnapshot, useWorkspaceStore } from '../../hooks/useWorkspace.ts'
import type { GitReviewRequest } from '../../../../shared/git-review.ts'
import { useGitAiFlow } from './useGitAiFlow.ts'
import {
  useSourceControlAutoRefresh,
  type SilentGitRefreshPatch,
} from './useSourceControlAutoRefresh.ts'
import {
  reconcileOpenedDiffs,
  resolveRefreshedDiff,
  type SourceControlState,
} from './source-control-refresh.ts'
import {
  parseGitCommit,
  parseGitCommitCreation,
  parseGitDiff,
  parseGitGraph,
  parseGitSummary,
  type GitCommit,
  type GitCommitDetail,
  type GitDiff,
  type GitSummary,
} from './source-control-types.ts'

export function diffKey(diff: GitDiff): string {
  return JSON.stringify([
    diff.mode,
    diff.relativePath,
    diff.commitHash,
    diff.reviewTitle,
    diff.sources,
  ])
}

const SourceControlContext = createContext<SourceControlState | null>(null)

function message(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'Git 操作失败'
  return raw
    .replace(/^Error invoking remote method '[^']+': Error:\s*/u, '')
    .replace(/^Error:\s*/u, '')
}

/** Git 投影与写操作拥有独立的项目代次；文件读取和编辑不参与 Git 刷新。 */
export function SourceControlProvider({ children }: { children: ReactNode }) {
  const store = useWorkspaceStore()
  const snapshot = useWorkspaceSnapshot()
  const selectedSession = snapshot.sessions.find(
    session => session.sessionId === snapshot.selectedSessionId,
  )
  const projectId =
    snapshot.selectedProjectId ??
    snapshot.projects.find(project => project.cwd === selectedSession?.cwd)?.id ??
    null
  const projectAccessId =
    snapshot.projects.find(project => project.id === projectId)?.projectAccessId ?? null
  const projectIdRef = useRef(projectId)
  projectIdRef.current = projectId
  const sourceControlRequestGeneration = useRef(0)
  const [gitSummary, setGitSummary] = useState<GitSummary | null>(null)
  const [gitGraph, setGitGraph] = useState<GitCommit[]>([])
  const [gitRevision, setGitRevision] = useState(0)
  const [selectedCommit, setSelectedCommit] = useState<GitCommitDetail | null>(null)
  const [selectedDiff, setSelectedDiff] = useState<GitDiff | null>(null)
  const [openedDiffs, setOpenedDiffs] = useState<readonly GitDiff[]>([])
  const gitSummaryRef = useRef(gitSummary)
  gitSummaryRef.current = gitSummary
  const gitGraphRef = useRef(gitGraph)
  gitGraphRef.current = gitGraph
  const selectedDiffRef = useRef(selectedDiff)
  selectedDiffRef.current = selectedDiff
  const cancelAutoRefreshRef = useRef<() => void>(() => {})
  useEffect(() => {
    if (selectedDiff !== null)
      setOpenedDiffs(current => [
        ...current.filter(diff => diffKey(diff) !== diffKey(selectedDiff)),
        selectedDiff,
      ])
  }, [selectedDiff])
  const selectDiff = useCallback(
    (id: string) => {
      const diff = openedDiffs.find(item => diffKey(item) === id)
      if (diff) {
        setSelectedDiff(diff)
        store.setView('changes')
      }
    },
    [openedDiffs, store],
  )
  const closeDiff = useCallback(
    (id: string) => {
      const remaining = openedDiffs.filter(item => diffKey(item) !== id)
      setOpenedDiffs(remaining)
      if (selectedDiff && diffKey(selectedDiff) === id) setSelectedDiff(remaining.at(-1) ?? null)
    },
    [openedDiffs, selectedDiff],
  )
  const closeDiffs = useCallback(() => {
    sourceControlRequestGeneration.current += 1
    setOpenedDiffs([])
    setSelectedDiff(null)
    setSelectedCommit(null)
  }, [])
  const [gitMutation, setGitMutation] = useState<'stage' | 'unstage' | 'commit' | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const clearError = useCallback(() => {
    setError(null)
  }, [])

  useEffect(() => {
    const requestGeneration = ++sourceControlRequestGeneration.current
    cancelAutoRefreshRef.current()
    setGitSummary(null)
    setGitGraph([])
    setGitRevision(0)
    setOpenedDiffs([])
    setSelectedCommit(null)
    setSelectedDiff(null)
    setGitMutation(null)
    setError(null)
    if (projectAccessId === null) {
      setLoading(false)
      return
    }
    setLoading(true)
    void Promise.all([
      store.callProject('gitSummary').then(parseGitSummary),
      store.callProject('gitGraph').then(parseGitGraph),
    ])
      .then(([summary, graph]) => {
        if (
          sourceControlRequestGeneration.current !== requestGeneration ||
          projectIdRef.current !== projectId
        )
          return
        setGitSummary(summary)
        setGitGraph(graph)
      })
      .catch((caught: unknown) => {
        if (
          sourceControlRequestGeneration.current === requestGeneration &&
          projectIdRef.current === projectId
        )
          setError(message(caught))
      })
      .finally(() => {
        if (
          sourceControlRequestGeneration.current === requestGeneration &&
          projectIdRef.current === projectId
        )
          setLoading(false)
      })
    return () => {
      sourceControlRequestGeneration.current += 1
    }
  }, [projectAccessId, projectId, store])

  const refresh = useCallback(async () => {
    const requestGeneration = ++sourceControlRequestGeneration.current
    const requestProjectId = projectId
    cancelAutoRefreshRef.current()
    setLoading(true)
    try {
      const currentDiff = selectedDiffRef.current
      const [summary, graph] = await Promise.all([
        store.callProject('gitSummary').then(parseGitSummary),
        store.callProject('gitGraph').then(parseGitGraph),
      ])
      if (
        sourceControlRequestGeneration.current !== requestGeneration ||
        projectIdRef.current !== requestProjectId
      )
        return
      if (!summary.available && gitSummaryRef.current?.available === true) {
        throw new Error(summary.message ?? '刷新 Git 状态失败，请重试。')
      }
      const nextDiff = await resolveRefreshedDiff({
        summary,
        currentDiff,
        loadDiff: (relativePath, mode) => store.callProject('gitDiff', { relativePath, mode }),
        silent: false,
      })
      if (
        sourceControlRequestGeneration.current !== requestGeneration ||
        projectIdRef.current !== requestProjectId
      )
        return
      setGitSummary(summary)
      setGitGraph(graph)
      setOpenedDiffs(current => reconcileOpenedDiffs(current, summary, nextDiff, diffKey))
      setSelectedDiff(current => (current === currentDiff ? nextDiff : current))
      setGitRevision(revision => revision + 1)
      setError(null)
    } catch (caught) {
      if (
        sourceControlRequestGeneration.current === requestGeneration &&
        projectIdRef.current === requestProjectId
      )
        setError(message(caught))
    } finally {
      if (
        sourceControlRequestGeneration.current === requestGeneration &&
        projectIdRef.current === requestProjectId
      )
        setLoading(false)
    }
  }, [projectId, store])

  const ai = useGitAiFlow({
    projectId: projectAccessId,
    models: snapshot.sessionModels,
    refresh,
    openDiff: value => {
      setSelectedDiff(parseGitDiff(value))
      setSelectedCommit(null)
      store.setView('changes')
    },
  })

  const applySilentUpdate = useCallback((patch: SilentGitRefreshPatch) => {
    if (patch.summary !== undefined) setGitSummary(patch.summary)
    if (patch.graph !== undefined) setGitGraph(patch.graph)
    setOpenedDiffs(current =>
      reconcileOpenedDiffs(current, patch.summaryForDiffs, patch.nextDiff, diffKey),
    )
    if (patch.diffChanged) {
      setSelectedDiff(current => (current === patch.previousDiff ? patch.nextDiff : current))
    }
    if (patch.changed) setGitRevision(revision => revision + 1)
  }, [])

  const { cancelQueued } = useSourceControlAutoRefresh({
    projectId,
    projectAccessId,
    activeView:
      snapshot.activeView === 'changes' || snapshot.navigationView === 'changes'
        ? 'changes'
        : snapshot.activeView,
    gitMutation,
    aiRunning: ai.running,
    requestGenerationRef: sourceControlRequestGeneration,
    projectIdRef,
    gitSummaryRef,
    gitGraphRef,
    selectedDiffRef,
    callProject: (operation, payload) => store.callProject(operation, payload),
    onApply: applySilentUpdate,
  })
  cancelAutoRefreshRef.current = cancelQueued

  const openDiff = useCallback(
    async (relativePath: string, mode: 'working' | 'staged' = 'working') => {
      const requestGeneration = ++sourceControlRequestGeneration.current
      const requestProjectId = projectId
      setLoading(true)
      try {
        const diff = parseGitDiff(await store.callProject('gitDiff', { relativePath, mode }))
        if (
          sourceControlRequestGeneration.current !== requestGeneration ||
          projectIdRef.current !== requestProjectId
        )
          return
        setSelectedDiff(diff)
        setSelectedCommit(null)
        setError(null)
        store.setView('changes')
      } catch (caught) {
        if (
          sourceControlRequestGeneration.current === requestGeneration &&
          projectIdRef.current === requestProjectId
        )
          setError(message(caught))
      } finally {
        if (
          sourceControlRequestGeneration.current === requestGeneration &&
          projectIdRef.current === requestProjectId
        )
          setLoading(false)
      }
    },
    [projectId, store],
  )

  const openCommit = useCallback(
    async (commitHash: string) => {
      const requestGeneration = ++sourceControlRequestGeneration.current
      const requestProjectId = projectId
      setLoading(true)
      try {
        const commit = parseGitCommit(await store.callProject('gitCommit', { commitHash }))
        if (
          sourceControlRequestGeneration.current !== requestGeneration ||
          projectIdRef.current !== requestProjectId
        )
          return
        setSelectedCommit(commit)
        setSelectedDiff(null)
        setError(null)
        store.setView('changes')
      } catch (caught) {
        if (
          sourceControlRequestGeneration.current === requestGeneration &&
          projectIdRef.current === requestProjectId
        )
          setError(message(caught))
      } finally {
        if (
          sourceControlRequestGeneration.current === requestGeneration &&
          projectIdRef.current === requestProjectId
        )
          setLoading(false)
      }
    },
    [projectId, store],
  )

  const openCommitFile = useCallback(
    async (commitHash: string, relativePath: string) => {
      const requestGeneration = ++sourceControlRequestGeneration.current
      const requestProjectId = projectId
      setLoading(true)
      try {
        const diff = parseGitDiff(
          await store.callProject('gitCommitFileDiff', { commitHash, relativePath }),
        )
        if (
          sourceControlRequestGeneration.current !== requestGeneration ||
          projectIdRef.current !== requestProjectId
        )
          return
        setSelectedDiff(diff)
        setError(null)
        store.setView('changes')
      } catch (caught) {
        if (
          sourceControlRequestGeneration.current === requestGeneration &&
          projectIdRef.current === requestProjectId
        )
          setError(message(caught))
      } finally {
        if (
          sourceControlRequestGeneration.current === requestGeneration &&
          projectIdRef.current === requestProjectId
        )
          setLoading(false)
      }
    },
    [projectId, store],
  )

  const closeCommit = useCallback(() => {
    sourceControlRequestGeneration.current += 1
    setSelectedCommit(null)
    setSelectedDiff(current => (current?.mode === 'commit' ? null : current))
    setError(null)
  }, [])

  const openReviewFile = useCallback(
    async (request: GitReviewRequest) => {
      const generation = ++sourceControlRequestGeneration.current
      const requestedProject = projectId
      setLoading(true)
      try {
        const diff = parseGitDiff(await store.callProject('gitReview', { ...request }))
        if (
          generation !== sourceControlRequestGeneration.current ||
          projectIdRef.current !== requestedProject
        )
          return
        setSelectedDiff(diff)
        setSelectedCommit(null)
        setError(null)
        store.setView('changes')
      } catch (caught) {
        if (
          generation === sourceControlRequestGeneration.current &&
          projectIdRef.current === requestedProject
        )
          setError(message(caught))
      } finally {
        if (
          generation === sourceControlRequestGeneration.current &&
          projectIdRef.current === requestedProject
        )
          setLoading(false)
      }
    },
    [projectId, store],
  )

  const refreshGitAfterFailure = useCallback(
    async (requestGeneration: number, requestProjectId: string | null) => {
      try {
        const summary = parseGitSummary(await store.callProject('gitSummary'))
        if (
          sourceControlRequestGeneration.current === requestGeneration &&
          projectIdRef.current === requestProjectId
        )
          setGitSummary(summary)
      } catch {
        // 保留原始写操作错误；刷新失败不应覆盖更有用的原因。
      }
    },
    [store],
  )

  const stageChanges = useCallback(
    async (relativePaths?: readonly string[]) => {
      if (ai.running) return false
      const requestGeneration = ++sourceControlRequestGeneration.current
      const requestProjectId = projectId
      setGitMutation('stage')
      setLoading(true)
      try {
        const summary = parseGitSummary(
          await store.callProject(
            'gitStage',
            relativePaths === undefined ? { all: true } : { relativePaths: [...relativePaths] },
          ),
        )
        if (
          sourceControlRequestGeneration.current !== requestGeneration ||
          projectIdRef.current !== requestProjectId
        )
          return false
        setGitSummary(summary)
        setSelectedDiff(null)
        setError(null)
        return true
      } catch (caught) {
        if (
          sourceControlRequestGeneration.current === requestGeneration &&
          projectIdRef.current === requestProjectId
        ) {
          setError(message(caught))
          await refreshGitAfterFailure(requestGeneration, requestProjectId)
        }
        return false
      } finally {
        if (
          sourceControlRequestGeneration.current === requestGeneration &&
          projectIdRef.current === requestProjectId
        ) {
          setGitMutation(null)
          setLoading(false)
        }
      }
    },
    [ai.running, projectId, refreshGitAfterFailure, store],
  )

  const unstageChanges = useCallback(
    async (relativePaths?: readonly string[], expectedStatusRevision?: string) => {
      if (ai.running) return false
      const requestGeneration = ++sourceControlRequestGeneration.current
      const requestProjectId = projectId
      setGitMutation('unstage')
      setLoading(true)
      try {
        const summary = parseGitSummary(
          await store.callProject(
            'gitUnstage',
            relativePaths === undefined
              ? { all: true, expectedStatusRevision }
              : { relativePaths: [...relativePaths] },
          ),
        )
        if (
          sourceControlRequestGeneration.current !== requestGeneration ||
          projectIdRef.current !== requestProjectId
        )
          return false
        setGitSummary(summary)
        setSelectedDiff(null)
        setError(null)
        return true
      } catch (caught) {
        if (
          sourceControlRequestGeneration.current === requestGeneration &&
          projectIdRef.current === requestProjectId
        ) {
          setError(message(caught))
          await refreshGitAfterFailure(requestGeneration, requestProjectId)
        }
        return false
      } finally {
        if (
          sourceControlRequestGeneration.current === requestGeneration &&
          projectIdRef.current === requestProjectId
        ) {
          setGitMutation(null)
          setLoading(false)
        }
      }
    },
    [ai.running, projectId, refreshGitAfterFailure, store],
  )

  const commitStaged = useCallback(
    async (commitMessage: string) => {
      if (ai.running) return false
      const requestGeneration = ++sourceControlRequestGeneration.current
      const requestProjectId = projectId
      setGitMutation('commit')
      setLoading(true)
      try {
        const result = parseGitCommitCreation(
          await store.callProject('gitCreateCommit', { message: commitMessage }),
        )
        if (
          sourceControlRequestGeneration.current !== requestGeneration ||
          projectIdRef.current !== requestProjectId
        )
          return false
        setGitSummary(result.summary)
        setGitGraph(result.graph)
        setSelectedDiff(null)
        setSelectedCommit(null)
        setError(null)
        store.setView('changes')
        return true
      } catch (caught) {
        if (
          sourceControlRequestGeneration.current === requestGeneration &&
          projectIdRef.current === requestProjectId
        ) {
          setError(message(caught))
          await refreshGitAfterFailure(requestGeneration, requestProjectId)
        }
        return false
      } finally {
        if (
          sourceControlRequestGeneration.current === requestGeneration &&
          projectIdRef.current === requestProjectId
        ) {
          setGitMutation(null)
          setLoading(false)
        }
      }
    },
    [ai.running, projectId, refreshGitAfterFailure, store],
  )

  const value = useMemo<SourceControlState>(
    () => ({
      ai,
      openedDiffs,
      selectDiff,
      closeDiff,
      closeDiffs,
      gitSummary,
      gitGraph,
      gitRevision,
      selectedCommit,
      selectedDiff,
      gitMutation: ai.running ? 'commit' : gitMutation,
      loading,
      error,
      clearError,
      refresh,
      openDiff,
      openCommit,
      openCommitFile,
      openReviewFile,
      closeCommit,
      stageChanges,
      unstageChanges,
      commitStaged,
    }),
    [
      ai,
      openedDiffs,
      selectDiff,
      closeDiff,
      closeDiffs,
      gitSummary,
      gitGraph,
      gitRevision,
      selectedCommit,
      selectedDiff,
      gitMutation,
      loading,
      error,
      clearError,
      refresh,
      openDiff,
      openCommit,
      openCommitFile,
      openReviewFile,
      closeCommit,
      stageChanges,
      unstageChanges,
      commitStaged,
    ],
  )
  return <SourceControlContext.Provider value={value}>{children}</SourceControlContext.Provider>
}

export function useSourceControl(): SourceControlState {
  const value = useContext(SourceControlContext)
  if (value === null) throw new Error('SourceControlProvider 尚未挂载')
  return value
}

export function useOptionalSourceControl() {
  return useContext(SourceControlContext)
}
