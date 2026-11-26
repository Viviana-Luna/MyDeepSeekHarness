/** Git 审阅范围与不可变比较标识；前端不能自行指定工作目录。 */
export interface GitReviewFile {
  relativePath: string
  status: string
  additions: number
  deletions: number
  binary: boolean
}
export interface GitReview {
  kind: 'git-review'
  available: boolean
  reviewId: string
  title: string
  sources: string[]
  files: GitReviewFile[]
  message?: string
}
export interface GitBranches {
  kind: 'git-branches'
  branches: string[]
  current: string
  defaultBase: string
}
export interface GitReviewDiff {
  kind: 'git-review-diff'
  mode: 'review'
  relativePath: string
  reviewTitle: string
  sources: string[]
  patch: string
  truncated: boolean
  presentation: 'text' | 'binary' | 'unavailable'
  message?: string
}
export interface GitReviewRequest {
  comparison?: 'branch' | 'turn'
  baseRef?: string
  sessionId?: string
  reviewId?: string
  relativePath?: string
}
