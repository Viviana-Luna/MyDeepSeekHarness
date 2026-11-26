import { isRecord } from '../../../../shared/validation.ts'
export interface ChangedFile {
  relativePath: string
  originalPath?: string
  indexStatus: string
  workingTreeStatus: string
  staged: boolean
  conflict: boolean
  additions: number
  deletions: number
  binary: boolean
  workingAdditions: number
  workingDeletions: number
  workingBinary: boolean
  stagedAdditions: number
  stagedDeletions: number
  stagedBinary: boolean
}

export interface GitSummary {
  available: boolean
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  files: ChangedFile[]
  additions: number
  deletions: number
  statusRevision?: string
  message?: string
}

export interface GitCommit {
  hash: string
  shortHash: string
  parents: string[]
  decorations: string[]
  author: string
  time: number
  subject: string
}

export interface GitCommitDetail extends GitCommit {
  files: Array<{
    relativePath: string
    originalPath?: string
    status: string
    additions: number
    deletions: number
    binary: boolean
  }>
}

export interface GitDiff {
  relativePath: string
  mode: 'working' | 'staged' | 'commit' | 'review'
  reviewTitle?: string
  sources?: string[]
  commitHash?: string
  patch: string
  truncated: boolean
  presentation: 'text' | 'binary' | 'unavailable'
  message?: string
}

function parseChangedFile(value: unknown): ChangedFile | undefined {
  if (!isRecord(value) || typeof value.relativePath !== 'string') return undefined
  return {
    relativePath: value.relativePath,
    ...(typeof value.originalPath === 'string' ? { originalPath: value.originalPath } : {}),
    indexStatus: typeof value.indexStatus === 'string' ? value.indexStatus : '.',
    workingTreeStatus: typeof value.workingTreeStatus === 'string' ? value.workingTreeStatus : '.',
    staged: value.staged === true,
    conflict: value.conflict === true,
    additions: Number(value.additions) || 0,
    deletions: Number(value.deletions) || 0,
    binary: value.binary === true,
    workingAdditions: Number(value.workingAdditions) || 0,
    workingDeletions: Number(value.workingDeletions) || 0,
    workingBinary: value.workingBinary === true,
    stagedAdditions: Number(value.stagedAdditions) || 0,
    stagedDeletions: Number(value.stagedDeletions) || 0,
    stagedBinary: value.stagedBinary === true,
  }
}

export function parseGitSummary(value: unknown): GitSummary {
  if (!isRecord(value)) throw new Error('项目服务返回了无效的 Git 状态')
  return {
    available: value.available === true,
    branch: typeof value.branch === 'string' ? value.branch : null,
    upstream: typeof value.upstream === 'string' ? value.upstream : null,
    ahead: Number(value.ahead) || 0,
    behind: Number(value.behind) || 0,
    files: Array.isArray(value.files)
      ? value.files.flatMap(item => parseChangedFile(item) ?? [])
      : [],
    additions: Number(value.additions) || 0,
    deletions: Number(value.deletions) || 0,
    ...(typeof value.statusRevision === 'string' ? { statusRevision: value.statusRevision } : {}),
    ...(typeof value.message === 'string' ? { message: value.message } : {}),
  }
}

export function parseGitGraph(value: unknown): GitCommit[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!isRecord(item) || typeof item.hash !== 'string' || typeof item.shortHash !== 'string')
      return []
    return [
      {
        hash: item.hash,
        shortHash: item.shortHash,
        parents: Array.isArray(item.parents)
          ? item.parents.filter(parent => typeof parent === 'string')
          : [],
        decorations: Array.isArray(item.decorations)
          ? item.decorations.filter(decoration => typeof decoration === 'string')
          : [],
        author: typeof item.author === 'string' ? item.author : '',
        time: Number(item.time) || 0,
        subject: typeof item.subject === 'string' ? item.subject : '',
      },
    ]
  })
}

export function parseGitCommit(value: unknown): GitCommitDetail {
  if (
    !isRecord(value) ||
    typeof value.hash !== 'string' ||
    typeof value.shortHash !== 'string' ||
    !Array.isArray(value.files)
  ) {
    throw new Error('项目服务返回了无效的 Git 提交详情')
  }
  return {
    hash: value.hash,
    shortHash: value.shortHash,
    parents: Array.isArray(value.parents)
      ? value.parents.filter(parent => typeof parent === 'string')
      : [],
    decorations: Array.isArray(value.decorations)
      ? value.decorations.filter(decoration => typeof decoration === 'string')
      : [],
    author: typeof value.author === 'string' ? value.author : '',
    time: Number(value.time) || 0,
    subject: typeof value.subject === 'string' ? value.subject : '',
    files: value.files.flatMap(file => {
      if (!isRecord(file) || typeof file.relativePath !== 'string') return []
      return [
        {
          relativePath: file.relativePath,
          ...(typeof file.originalPath === 'string' ? { originalPath: file.originalPath } : {}),
          status: typeof file.status === 'string' ? file.status : 'M',
          additions: Number(file.additions) || 0,
          deletions: Number(file.deletions) || 0,
          binary: file.binary === true,
        },
      ]
    }),
  }
}

export function parseGitDiff(value: unknown): GitDiff {
  if (
    !isRecord(value) ||
    typeof value.relativePath !== 'string' ||
    typeof value.patch !== 'string' ||
    !['working', 'staged', 'commit', 'review'].includes(String(value.mode))
  )
    throw new Error('项目服务返回了无效的 Git Diff')
  if (value.mode === 'commit' && typeof value.commitHash !== 'string') {
    throw new Error('项目服务返回了无效的提交文件 Diff')
  }
  return {
    relativePath: value.relativePath,
    mode: value.mode as GitDiff['mode'],
    ...(typeof value.reviewTitle === 'string' ? { reviewTitle: value.reviewTitle } : {}),
    ...(Array.isArray(value.sources)
      ? { sources: value.sources.filter((item): item is string => typeof item === 'string') }
      : {}),
    ...(typeof value.commitHash === 'string' ? { commitHash: value.commitHash } : {}),
    patch: value.patch,
    truncated: value.truncated === true,
    presentation:
      value.presentation === 'binary' || value.presentation === 'unavailable'
        ? value.presentation
        : 'text',
    ...(typeof value.message === 'string' ? { message: value.message } : {}),
  }
}

export function parseGitCommitCreation(value: unknown): {
  commitHash: string
  summary: GitSummary
  graph: GitCommit[]
} {
  if (!isRecord(value) || typeof value.commitHash !== 'string') {
    throw new Error('项目服务返回了无效的 Git 提交结果')
  }
  return {
    commitHash: value.commitHash,
    summary: parseGitSummary(value.summary),
    graph: parseGitGraph(value.graph),
  }
}
