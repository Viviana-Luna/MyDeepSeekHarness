/**
 * 渲染进程 Git 状态无感刷新辅助逻辑：比较摘要、提交图与差异是否实质变化，
 * 避免后台自动刷新产生无意义重渲染、闪烁或意外关闭确认对话框。
 */
import {
  parseGitDiff,
  type GitCommit,
  type GitCommitDetail,
  type GitDiff,
  type GitSummary,
} from './source-control-types.ts'
import type { GitReviewRequest } from '../../../../shared/git-review.ts'
import type { GitAiFlow } from './useGitAiFlow.ts'

/** 源代码管理上下文状态契约。 */
export interface SourceControlState {
  ai: GitAiFlow
  openedDiffs: readonly GitDiff[]
  selectDiff(id: string): void
  closeDiff(id: string): void
  closeDiffs(): void
  gitSummary: GitSummary | null
  gitGraph: readonly GitCommit[]
  gitRevision: number
  selectedCommit: GitCommitDetail | null
  selectedDiff: GitDiff | null
  gitMutation: 'stage' | 'unstage' | 'commit' | null
  loading: boolean
  error: string | null
  clearError(): void
  refresh(): Promise<void>
  openDiff(relativePath: string, mode?: 'working' | 'staged'): Promise<void>
  openCommit(commitHash: string): Promise<void>
  openCommitFile(commitHash: string, relativePath: string): Promise<void>
  openReviewFile(request: GitReviewRequest): Promise<void>
  closeCommit(): void
  stageChanges(relativePaths?: readonly string[]): Promise<boolean>
  unstageChanges(
    relativePaths?: readonly string[],
    expectedStatusRevision?: string,
  ): Promise<boolean>
  commitStaged(message: string): Promise<boolean>
}

/** 判断 Diff 是否属于可随工作区/暂存区变化自动刷新的类型。 */
export function isTrackableGitDiff(diff: GitDiff | null): diff is GitDiff & {
  mode: 'working' | 'staged'
} {
  return diff !== null && (diff.mode === 'working' || diff.mode === 'staged')
}

/** 按最新 Git 摘要刷新或清理当前打开的工作区/暂存区 Diff。 */
export async function resolveRefreshedDiff(options: {
  summary: GitSummary
  currentDiff: GitDiff | null
  loadDiff: (relativePath: string, mode: 'working' | 'staged') => Promise<unknown>
  silent: boolean
}): Promise<GitDiff | null> {
  const { summary, currentDiff, loadDiff, silent } = options
  if (!isTrackableGitDiff(currentDiff)) return currentDiff
  if (!hasMatchingFileChange(summary, currentDiff)) return null
  try {
    return parseGitDiff(await loadDiff(currentDiff.relativePath, currentDiff.mode))
  } catch (error) {
    if (silent) return currentDiff
    throw error
  }
}

/** 判断两次 Git 摘要在界面可感知的字段上是否完全一致，用于保持旧对象引用避免抖动。 */
export function isSameGitSummary(previous: GitSummary | null, next: GitSummary): boolean {
  if (previous === null) return false
  if (
    previous.available !== next.available ||
    previous.branch !== next.branch ||
    previous.upstream !== next.upstream ||
    previous.ahead !== next.ahead ||
    previous.behind !== next.behind ||
    previous.additions !== next.additions ||
    previous.deletions !== next.deletions ||
    previous.message !== next.message ||
    previous.files.length !== next.files.length
  ) {
    return false
  }
  if (previous.statusRevision !== undefined && next.statusRevision !== undefined) {
    return previous.statusRevision === next.statusRevision
  }
  return previous.files.every((file, index) => {
    const other = next.files[index]
    return (
      other !== undefined &&
      file.relativePath === other.relativePath &&
      file.indexStatus === other.indexStatus &&
      file.workingTreeStatus === other.workingTreeStatus &&
      file.staged === other.staged &&
      file.conflict === other.conflict &&
      file.additions === other.additions &&
      file.deletions === other.deletions
    )
  })
}

/** 判断两次提交图快照是否实质一致（对比数量与每个节点的哈希及装饰标签）。 */
export function isSameGitGraph(
  previous: readonly GitCommit[],
  next: readonly GitCommit[],
): boolean {
  if (previous.length !== next.length) return false
  return previous.every((commit, index) => {
    const other = next[index]
    return (
      other !== undefined &&
      commit.hash === other.hash &&
      commit.decorations.length === other.decorations.length &&
      commit.decorations.every((item, itemIndex) => item === other.decorations[itemIndex])
    )
  })
}

/** 判断两次工作区或暂存区 Diff 内容是否实质一致。 */
export function isSameGitDiff(previous: GitDiff | null, next: GitDiff | null): boolean {
  if (previous === next) return true
  if (previous === null || next === null) return false
  return (
    previous.mode === next.mode &&
    previous.relativePath === next.relativePath &&
    previous.presentation === next.presentation &&
    previous.truncated === next.truncated &&
    previous.message === next.message &&
    previous.patch === next.patch
  )
}

/** 判断当前打开的工作区/暂存区 Diff 对应的文件在最新摘要中是否仍然存在对应模式的变更。 */
export function hasMatchingFileChange(summary: GitSummary, diff: GitDiff): boolean {
  if (!summary.available) return false
  const file = summary.files.find(item => item.relativePath === diff.relativePath)
  if (file === undefined) return false
  if (diff.mode === 'staged') return file.staged && !file.conflict
  if (diff.mode === 'working') {
    return file.conflict || file.workingTreeStatus !== '.' || file.indexStatus === '?'
  }
  return true
}

/**
 * 按最新摘要裁剪已消失的工作区/暂存区标签，并用新拉取的 Diff 更新对应条目；
 * 若列表无实质变化则返回原引用，避免触发无关重渲染。
 */
export function reconcileOpenedDiffs(
  opened: readonly GitDiff[],
  summary: GitSummary,
  updatedDiff: GitDiff | null,
  keyOf: (diff: GitDiff) => string,
): readonly GitDiff[] {
  const updatedKey = updatedDiff === null ? null : keyOf(updatedDiff)
  let changed = false
  const next: GitDiff[] = []
  for (const item of opened) {
    if (item.mode === 'working' || item.mode === 'staged') {
      if (!hasMatchingFileChange(summary, item)) {
        changed = true
        continue
      }
      if (updatedDiff !== null && updatedKey === keyOf(item) && !isSameGitDiff(item, updatedDiff)) {
        changed = true
        next.push(updatedDiff)
        continue
      }
    }
    next.push(item)
  }
  return changed ? next : opened
}
