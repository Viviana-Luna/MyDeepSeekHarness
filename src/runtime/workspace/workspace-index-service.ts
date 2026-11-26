import { spawn, type ChildProcess } from 'node:child_process'
import { basename, dirname, isAbsolute } from 'node:path'

const DEFAULT_MAX_FILES = 100_000
const DEFAULT_RESULT_LIMIT = 100
const MAX_QUERY_LENGTH = 256
const MAX_PATH_LENGTH = 4_096
const MAX_STDERR_BYTES = 64 * 1024
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024
const INDEX_TIMEOUT_MS = 30_000
const CONTENT_SEARCH_TIMEOUT_MS = 15_000
const DEFAULT_CONTENT_RESULT_LIMIT = 200
const MAX_CONTENT_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_CONTENT_PREVIEW_LENGTH = 600

export type WorkspaceIndexPhase = 'idle' | 'building' | 'ready' | 'partial' | 'error'

export interface WorkspaceIndexStatus {
  phase: WorkspaceIndexPhase
  fileCount: number
  message?: string
}

export interface WorkspaceFileMatch {
  relativePath: string
  name: string
  directory: string
}

export interface WorkspaceFileQueryResult {
  items: WorkspaceFileMatch[]
  hasMore: boolean
}

export interface WorkspaceContentMatch {
  relativePath: string
  line: number
  column: number
  preview: string
}

export interface WorkspaceContentSearchResult {
  items: WorkspaceContentMatch[]
  hasMore: boolean
}

interface IndexState {
  status: WorkspaceIndexStatus
  paths: string[]
  recent: Map<string, number>
  recentSequence: number
  generation: number
  child?: ChildProcess
  building?: Promise<WorkspaceIndexStatus>
}

interface WorkspaceIndexOptions {
  maxFiles?: number
  resultLimit?: number
  contentResultLimit?: number
}

interface ActiveContentSearch {
  readonly projectId: string
  readonly generation: number
  readonly child: ChildProcess
}

function emptyStatus(): WorkspaceIndexStatus {
  return { phase: 'idle', fileCount: 0 }
}

function safeRelativePath(value: string): string | null {
  const normalized = value.replaceAll('\\', '/')
  if (
    normalized === '' ||
    normalized.length > MAX_PATH_LENGTH ||
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    isAbsolute(normalized) ||
    normalized.split('/').includes('..')
  )
    return null
  return normalized.replace(/^\.\//u, '')
}

function normalizedQuery(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('文件搜索词无效')
  const query = value.trim().replace(/\s+/gu, ' ')
  if (query.length > MAX_QUERY_LENGTH) throw new Error('文件搜索词超过 256 个字符')
  return query
}

function sequentialScore(value: string, query: string): number | null {
  let queryIndex = 0
  let score = 0
  let previous = -2
  for (let index = 0; index < value.length && queryIndex < query.length; index += 1) {
    if (value[index] !== query[queryIndex]) continue
    score += index === previous + 1 ? 8 : 2
    if (
      index === 0 ||
      value[index - 1] === '/' ||
      value[index - 1] === '-' ||
      value[index - 1] === '_'
    ) {
      score += 5
    }
    previous = index
    queryIndex += 1
  }
  return queryIndex === query.length
    ? score - Math.max(0, value.length - query.length) * 0.02
    : null
}

function matchScore(path: string, query: string): number | null {
  if (query === '') return 0
  const lowerPath = path.toLocaleLowerCase()
  const lowerName = basename(path).toLocaleLowerCase()
  const terms = query.toLocaleLowerCase().split(' ')
  let total = 0
  for (const term of terms) {
    if (lowerName === term) {
      total += 12_000
      continue
    }
    if (lowerName.startsWith(term)) {
      total += 9_000 - lowerName.length
      continue
    }
    const nameIndex = lowerName.indexOf(term)
    if (nameIndex >= 0) {
      total += 7_000 - nameIndex * 12 - lowerName.length
      continue
    }
    const pathIndex = lowerPath.indexOf(term)
    if (pathIndex >= 0) {
      total += 4_000 - pathIndex * 3 - lowerPath.length * 0.02
      continue
    }
    const fuzzy = sequentialScore(lowerPath, term)
    if (fuzzy === null) return null
    total += 1_000 + fuzzy
  }
  return total
}

function resultMessage(error: unknown): string {
  console.warn('项目文件索引失败：', error)
  return '无法建立项目文件索引，请检查项目目录权限后重试。'
}

export class WorkspaceIndexService {
  private readonly indexes = new Map<string, IndexState>()
  private readonly maxFiles: number
  private readonly resultLimit: number
  private readonly contentResultLimit: number
  private contentSearchGeneration = 0
  private activeContentSearch?: ActiveContentSearch

  constructor(
    private readonly ripgrepPath: string,
    options: WorkspaceIndexOptions = {},
  ) {
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
    this.resultLimit = options.resultLimit ?? DEFAULT_RESULT_LIMIT
    this.contentResultLimit = options.contentResultLimit ?? DEFAULT_CONTENT_RESULT_LIMIT
  }

  retain(projectIds: readonly string[]): void {
    const retained = new Set(projectIds)
    for (const [projectId, state] of this.indexes) {
      if (retained.has(projectId)) continue
      state.generation += 1
      state.child?.kill('SIGTERM')
      this.indexes.delete(projectId)
    }
    if (
      this.activeContentSearch !== undefined &&
      !retained.has(this.activeContentSearch.projectId)
    ) {
      this.cancelContentSearch()
    }
  }

  clear(): void {
    this.cancelContentSearch()
    for (const state of this.indexes.values()) {
      state.generation += 1
      state.child?.kill('SIGTERM')
    }
    this.indexes.clear()
  }

  recordAccess(projectId: string, relativePath: string): void {
    const state = this.state(projectId)
    state.recentSequence += 1
    state.recent.set(relativePath, state.recentSequence)
    if (state.recent.size <= 200) return
    const oldest = [...state.recent.entries()]
      .toSorted((left, right) => left[1] - right[1])
      .slice(0, 50)
    for (const [path] of oldest) state.recent.delete(path)
  }

  async build(projectId: string, cwd: string, force = false): Promise<WorkspaceIndexStatus> {
    const state = this.state(projectId)
    if (!force && state.building !== undefined) return state.building
    if (!force && (state.status.phase === 'ready' || state.status.phase === 'partial')) {
      return { ...state.status }
    }

    state.generation += 1
    const generation = state.generation
    state.child?.kill('SIGTERM')
    state.status = {
      phase: 'building',
      fileCount: state.paths.length,
    }

    const building = this.runRipgrep(cwd, state)
      .then(result => {
        if (state.generation !== generation) return { ...state.status }
        state.paths = result.paths
        state.status = {
          phase: result.partial ? 'partial' : 'ready',
          fileCount: result.paths.length,
          ...(result.message === undefined ? {} : { message: result.message }),
        }
        return { ...state.status }
      })
      .catch((error: unknown) => {
        if (state.generation !== generation) return { ...state.status }
        state.paths = []
        state.status = {
          phase: 'error',
          fileCount: 0,
          message: resultMessage(error),
        }
        return { ...state.status }
      })
      .finally(() => {
        if (state.generation === generation) {
          delete state.child
          delete state.building
        }
      })
    state.building = building
    return building
  }

  async query(projectId: string, cwd: string, value: unknown): Promise<WorkspaceFileQueryResult> {
    const query = normalizedQuery(value)
    let state = this.state(projectId)
    if (state.status.phase === 'idle' || state.status.phase === 'error') {
      await this.build(projectId, cwd)
      state = this.state(projectId)
    } else if (state.building !== undefined && state.paths.length === 0) {
      await state.building
      state = this.state(projectId)
    }

    const matches = state.paths
      .flatMap(path => {
        const score = matchScore(path, query)
        if (score === null) return []
        return [{ path, score, recent: state.recent.get(path) ?? 0 }]
      })
      .toSorted(
        (left, right) =>
          right.score - left.score ||
          right.recent - left.recent ||
          left.path.localeCompare(right.path),
      )
    return {
      items: matches.slice(0, this.resultLimit).map(match => ({
        relativePath: match.path,
        name: basename(match.path),
        directory: dirname(match.path) === '.' ? '' : dirname(match.path),
      })),
      hasMore: matches.length > this.resultLimit,
    }
  }

  searchContent(
    projectId: string,
    cwd: string,
    value: unknown,
    caseSensitiveInput: unknown,
  ): Promise<WorkspaceContentSearchResult> {
    const query = normalizedQuery(value)
    if (query === '') throw new Error('请输入项目内容搜索词')
    if (typeof caseSensitiveInput !== 'boolean') throw new Error('项目内容搜索大小写选项无效')
    this.cancelContentSearch()
    const generation = ++this.contentSearchGeneration
    return this.runContentSearch(projectId, cwd, query, caseSensitiveInput, generation).finally(
      () => {
        if (this.activeContentSearch?.generation === generation) delete this.activeContentSearch
      },
    )
  }

  cancelContentSearch(projectId?: string): void {
    const active = this.activeContentSearch
    if (active === undefined || (projectId !== undefined && active.projectId !== projectId)) return
    this.contentSearchGeneration += 1
    if (active.child.exitCode === null && active.child.signalCode === null)
      active.child.kill('SIGTERM')
    delete this.activeContentSearch
  }

  private state(projectId: string): IndexState {
    let state = this.indexes.get(projectId)
    if (state !== undefined) return state
    state = {
      status: emptyStatus(),
      paths: [],
      recent: new Map(),
      recentSequence: 0,
      generation: 0,
    }
    this.indexes.set(projectId, state)
    return state
  }

  private runContentSearch(
    projectId: string,
    cwd: string,
    query: string,
    caseSensitive: boolean,
    generation: number,
  ): Promise<WorkspaceContentSearchResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.ripgrepPath,
        [
          '--json',
          '--line-number',
          '--column',
          '--hidden',
          '--no-require-git',
          '--fixed-strings',
          '--max-columns',
          '1000',
          '--max-columns-preview',
          '--glob',
          '!.git',
          '--glob',
          '!**/.git/**',
          '--glob',
          '!node_modules',
          '--glob',
          '!**/node_modules/**',
          ...(caseSensitive ? [] : ['--ignore-case']),
          '--',
          query,
          '.',
        ],
        {
          cwd,
          env: { ...process.env, LC_ALL: 'C' },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      )
      this.activeContentSearch = { projectId, generation, child }
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      const items: WorkspaceContentMatch[] = []
      let pending = ''
      let stderr = ''
      let outputBytes = 0
      let hasMore = false
      let timedOut = false
      let settled = false

      const terminate = (): void => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      }
      const parseLine = (line: string): void => {
        if (line === '' || items.length >= this.contentResultLimit) return
        let value: unknown
        try {
          value = JSON.parse(line)
        } catch {
          return
        }
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return
        const event = value as Record<string, unknown>
        if (event.type !== 'match' || typeof event.data !== 'object' || event.data === null) return
        const data = event.data as Record<string, unknown>
        const pathRecord =
          typeof data.path === 'object' && data.path !== null
            ? (data.path as Record<string, unknown>)
            : null
        const linesRecord =
          typeof data.lines === 'object' && data.lines !== null
            ? (data.lines as Record<string, unknown>)
            : null
        const submatches = Array.isArray(data.submatches) ? data.submatches : []
        const firstSubmatch =
          typeof submatches[0] === 'object' && submatches[0] !== null
            ? (submatches[0] as Record<string, unknown>)
            : null
        const relativePath =
          typeof pathRecord?.text === 'string' ? safeRelativePath(pathRecord.text) : null
        const lineNumber = Number(data.line_number)
        const start = Number(firstSubmatch?.start)
        if (
          relativePath === null ||
          !Number.isSafeInteger(lineNumber) ||
          lineNumber <= 0 ||
          !Number.isSafeInteger(start) ||
          start < 0 ||
          typeof linesRecord?.text !== 'string'
        )
          return
        const preview = linesRecord.text
          .replace(/[\r\n]+$/gu, '')
          .replaceAll('\0', '�')
          .slice(0, MAX_CONTENT_PREVIEW_LENGTH)
        items.push({ relativePath, line: lineNumber, column: start + 1, preview })
        if (items.length >= this.contentResultLimit) {
          hasMore = true
          terminate()
        }
      }
      const timeout = setTimeout(() => {
        timedOut = true
        terminate()
      }, CONTENT_SEARCH_TIMEOUT_MS)
      timeout.unref()

      child.stdout?.on('data', (chunk: string) => {
        outputBytes += Buffer.byteLength(chunk)
        if (outputBytes > MAX_CONTENT_OUTPUT_BYTES) {
          hasMore = true
          terminate()
          return
        }
        pending += chunk
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) {
          parseLine(line)
          if (hasMore) break
        }
      })
      child.stderr?.on('data', (chunk: string) => {
        if (Buffer.byteLength(stderr) >= MAX_STDERR_BYTES) return
        stderr += chunk
        if (Buffer.byteLength(stderr) > MAX_STDERR_BYTES) {
          stderr = Buffer.from(stderr).subarray(0, MAX_STDERR_BYTES).toString('utf8')
        }
      })
      child.once('error', error => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        console.warn('无法启动固定项目内容搜索程序：', error)
        reject(new Error('固定项目内容搜索程序不可用'))
      })
      child.once('close', code => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (this.contentSearchGeneration !== generation) {
          reject(new Error('项目内容搜索已取消'))
          return
        }
        if (pending !== '' && !hasMore) parseLine(pending)
        if (timedOut) {
          reject(new Error('项目内容搜索超过 15 秒，已停止搜索'))
          return
        }
        if (hasMore || code === 0 || code === 1) {
          resolve({ items, hasMore })
          return
        }
        if (stderr.trim() !== '') console.warn('项目内容搜索失败：', stderr.trim())
        reject(new Error('无法搜索项目内容，请检查项目目录权限后重试'))
      })
    })
  }

  private runRipgrep(
    cwd: string,
    state: IndexState,
  ): Promise<{
    paths: string[]
    partial: boolean
    message?: string
  }> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.ripgrepPath,
        [
          '--files',
          '--hidden',
          '--no-require-git',
          '--null',
          '--glob',
          '!.git',
          '--glob',
          '!**/.git/**',
          '--glob',
          '!node_modules',
          '--glob',
          '!**/node_modules/**',
        ],
        {
          cwd,
          env: { ...process.env, LC_ALL: 'C' },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      )
      state.child = child
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      const paths = new Set<string>()
      let pending = ''
      let stderr = ''
      let outputBytes = 0
      let limited = false
      let timedOut = false
      let settled = false

      const terminate = (): void => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      }
      const addPath = (raw: string): void => {
        if (paths.size >= this.maxFiles) {
          limited = true
          terminate()
          return
        }
        const path = safeRelativePath(raw)
        if (path !== null) paths.add(path)
      }
      const timeout = setTimeout(() => {
        timedOut = true
        terminate()
      }, INDEX_TIMEOUT_MS)
      timeout.unref()

      child.stdout?.on('data', (chunk: string) => {
        outputBytes += Buffer.byteLength(chunk)
        if (outputBytes > MAX_OUTPUT_BYTES) {
          limited = true
          terminate()
          return
        }
        pending += chunk
        const records = pending.split('\0')
        pending = records.pop() ?? ''
        for (const record of records) {
          addPath(record)
          if (limited) break
        }
      })
      child.stderr?.on('data', (chunk: string) => {
        if (Buffer.byteLength(stderr) >= MAX_STDERR_BYTES) return
        stderr += chunk
        if (Buffer.byteLength(stderr) > MAX_STDERR_BYTES) {
          stderr = Buffer.from(stderr).subarray(0, MAX_STDERR_BYTES).toString('utf8')
        }
      })
      child.once('error', error => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        console.warn('无法启动固定项目文件索引程序：', error)
        reject(new Error('固定项目文件索引程序不可用'))
      })
      child.once('close', code => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (pending !== '' && !limited) addPath(pending)
        const sorted = [...paths].toSorted((left, right) => left.localeCompare(right))
        const diagnostic = stderr.trim()
        if (timedOut) {
          resolve({
            paths: sorted,
            partial: true,
            message: '文件索引超过 30 秒，当前只显示已完成部分。',
          })
          return
        }
        if (limited) {
          resolve({
            paths: sorted,
            partial: true,
            message: `文件索引达到 ${String(this.maxFiles)} 条上限，请补充排除规则。`,
          })
          return
        }
        // ripgrep 找不到任何文件时会以退出码 1 且无 stderr 结束（退出码 2 才是真实权限或读取错误）。
        if ((code === 0 || (code === 1 && sorted.length === 0)) && diagnostic === '') {
          resolve({ paths: sorted, partial: false })
          return
        }
        if (sorted.length > 0) {
          if (diagnostic !== '') console.warn('项目文件索引只完成了一部分：', diagnostic)
          resolve({
            paths: sorted,
            partial: true,
            message:
              diagnostic === ''
                ? '文件索引只完成了一部分。'
                : '部分项目目录无法读取，当前显示可用文件。',
          })
          return
        }
        if (diagnostic !== '') console.warn('项目文件索引没有返回可用文件：', diagnostic)
        reject(
          new Error(
            code === null ? '文件索引进程被中断' : `文件索引进程异常退出（${String(code)}）`,
          ),
        )
      })
    })
  }
}
