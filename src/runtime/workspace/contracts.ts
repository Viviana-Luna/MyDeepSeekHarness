import type {
  ProjectDirectoryEntry,
  ProjectFile,
  ProjectFileWriteResult,
  GitProjectSummary,
  GitGraphCommit,
  GitCommitDetail,
  GitCommitFileDiff,
} from './project-service.ts'
import type {
  WorkspaceIndexStatus,
  WorkspaceFileQueryResult,
  WorkspaceContentSearchResult,
} from './workspace-index-service.ts'
import type {
  GitBranches,
  GitReview,
  GitReviewDiff,
  GitReviewRequest,
} from '../../shared/git-review.ts'
import type { GitAiAnalysis, GitAiExecution, GitAiPayload } from '../../shared/git-ai.ts'

/** 主进程只发送用于建立项目边界的会话字段，不复制完整会话日志。 */
export interface WorkspaceSessionBaseline {
  items: { cwd?: string; updatedAt?: number }[]
}

/** 各操作仍执行自己的必填、长度、路径和 revision 校验；此结构约束跨进程可用的字段。 */
export interface ProjectCallPayload extends GitReviewRequest, GitAiPayload {
  relativePath?: string
  trackRecent?: boolean
  content?: string
  expectedRevision?: string
  overwriteRevision?: string
  force?: boolean
  query?: string
  caseSensitive?: boolean
  mode?: 'working' | 'staged'
  commitHash?: string
  relativePaths?: string[]
  all?: boolean
  expectedStatusRevision?: string
  message?: string
}

export interface ProjectDirectoryListing {
  relativePath: string
  entries: ProjectDirectoryEntry[]
  truncated: boolean
}
export interface ProjectGitDiff {
  relativePath: string
  mode: 'working' | 'staged'
  patch: string
  truncated: boolean
  presentation: 'text' | 'binary' | 'unavailable'
  message?: string
}
export interface ProjectCommitResult {
  commitHash: string
  summary: GitProjectSummary
  graph: readonly GitGraphCommit[]
}

/** 沿用当前各业务方法的结果类型，生成器据此校验回包而非放行 unknown。 */
export type ProjectCallResult =
  | GitAiAnalysis
  | GitAiExecution
  | { released: boolean }
  | { stale: boolean; running: boolean; completed: GitAiExecution['completed'] }
  | ProjectDirectoryListing
  | ProjectFile
  | ProjectFileWriteResult
  | WorkspaceIndexStatus
  | WorkspaceFileQueryResult
  | WorkspaceContentSearchResult
  | GitProjectSummary
  | ProjectGitDiff
  | readonly GitGraphCommit[]
  | GitCommitDetail
  | GitCommitFileDiff
  | ProjectCommitResult
  | GitBranches
  | GitReview
  | GitReviewDiff
  | { revealed: true }
  | null
