import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { renameWithRetry as rename } from '../filesystem/file-operations.ts'
import { join, resolve, isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import type {
  GitBranches,
  GitReview,
  GitReviewDiff,
  GitReviewRequest,
} from '../../shared/git-review.ts'

const exec = promisify(execFile)
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const treePattern = /^[0-9a-f]{40,64}$/u
interface TurnSnapshot {
  turn: number
  before: string
  after: string
  message?: string
}

/** 快照写入 MyDSH 私有对象库，不改变用户仓库的索引、分支、提交或 Git 对象。 */
export class GitReviewService {
  private pending = new Map<string, Promise<unknown>>()
  private turns = new Map<string, TurnSnapshot>()
  private stopped = false
  private readonly abort = new AbortController()
  constructor(private readonly cache: string) {}

  private async git(cwd: string, args: string[], gitDir?: string): Promise<string> {
    if (this.stopped) throw new Error('Git 审阅服务已停止')
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }
    for (const name of [
      'GIT_INDEX_FILE',
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
      'GIT_COMMON_DIR',
    ])
      delete (env as NodeJS.ProcessEnv)[name]
    const result = await exec(
      process.env.MYDSH_GIT_EXECUTABLE ?? 'git',
      [...(gitDir ? [`--git-dir=${gitDir}`, `--work-tree=${cwd}`] : []), ...args],
      {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 20_000,
        maxBuffer: 8 * 1024 * 1024,
        signal: this.abort.signal,
        env,
      },
    )
    return result.stdout.trimEnd()
  }
  private normalizeCwdKey(cwd: string) {
    const resolved = resolve(cwd)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  private directory(cwd: string) {
    return join(this.cache, hash(this.normalizeCwdKey(cwd)))
  }
  private key(cwd: string, sessionId: string) {
    return `${this.normalizeCwdKey(cwd)}:${sessionId}`
  }
  private serial<T>(cwd: string, run: () => Promise<T>): Promise<T> {
    const key = this.normalizeCwdKey(cwd)
    const next = (this.pending.get(key) ?? Promise.resolve()).catch(() => {}).then(run)
    this.pending.set(key, next)
    void next
      .finally(() => {
        if (this.pending.get(key) === next) this.pending.delete(key)
      })
      .catch(() => {})
    return next
  }

  private async snapshot(cwd: string, ref: string): Promise<string> {
    await this.git(cwd, ['rev-parse', '--show-toplevel'])
    const files = (
      await this.git(cwd, [
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
        '--',
        '.',
      ])
    )
      .split('\0')
      .filter(Boolean)
    if (files.length > 20_000) throw new Error('项目超过 20,000 个文件，未生成本轮快照')
    const paths: string[] = []
    let bytes = 0
    for (const path of new Set(files)) {
      if (isAbsolute(path) || path.split(/[\\/]/u).includes('..'))
        throw new Error('Git 返回了项目之外的路径')
      // 顺序检查限制内存占用；缺失的已跟踪文件由空索引表达为删除。
      // oxlint-disable-next-line no-await-in-loop
      const info = await lstat(join(cwd, path)).catch(error => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (info === null) continue
      if (info.isDirectory())
        throw new Error('项目含 Git 子模块，暂不生成可能遗漏子模块变更的轮次快照')
      bytes += info.size
      if (info.size > 32 * 1024 * 1024 || bytes > 256 * 1024 * 1024)
        throw new Error('项目文件超过快照容量上限，未生成本轮快照')
      paths.push(path)
    }
    const directory = this.directory(cwd)
    const objects = join(directory, 'objects.git')
    await mkdir(directory, { recursive: true })
    await this.git(cwd, ['init', '--bare', '--quiet', objects])
    await this.git(cwd, ['read-tree', '--empty'], objects)
    const pathFile = join(directory, `paths-${randomUUID()}`)
    try {
      if (paths.length > 0) {
        await writeFile(pathFile, paths.join('\0') + '\0')
        await this.git(
          cwd,
          [
            '--literal-pathspecs',
            '-c',
            'core.autocrlf=false',
            'add',
            '-f',
            `--pathspec-from-file=${pathFile}`,
            '--pathspec-file-nul',
          ],
          objects,
        )
      }
      const tree = await this.git(cwd, ['write-tree'], objects)
      if (!treePattern.test(tree)) throw new Error('快照树标识无效')
      await this.git(cwd, ['update-ref', ref, tree], objects)
      return tree
    } finally {
      await rm(pathFile, { force: true })
    }
  }

  async begin(cwd: string, sessionId: string, turn: number): Promise<void> {
    const key = this.key(cwd, sessionId)
    if (this.turns.get(key)?.turn === turn) return
    const state: TurnSnapshot = { turn, before: '', after: '' }
    this.turns.set(key, state)
    await this.serial(cwd, async () => {
      try {
        state.before = await this.snapshot(cwd, `refs/mydsh/${hash(sessionId)}/before`)
      } catch (error) {
        state.message =
          error instanceof Error ? `无法记录本轮文件快照：${error.message}` : '无法记录本轮文件快照'
      }
    })
  }
  async end(cwd: string, sessionId: string, turn: number): Promise<void> {
    const state = this.turns.get(this.key(cwd, sessionId))
    if (!state || state.turn !== turn) return
    await this.serial(cwd, async () => {
      try {
        if (state.before)
          state.after = await this.snapshot(cwd, `refs/mydsh/${hash(sessionId)}/after`)
      } catch (error) {
        state.message =
          error instanceof Error ? `无法完成本轮文件快照：${error.message}` : '无法完成本轮文件快照'
      }
      if (this.stopped) return
      const directory = this.directory(cwd)
      await mkdir(directory, { recursive: true })
      const destination = join(directory, `${hash(sessionId)}.json`)
      const temporary = `${destination}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify(state) + '\n')
        await rename(temporary, destination)
      } finally {
        await rm(temporary, { force: true })
      }
    }).catch(() => {
      /* 审阅缓存失败不能阻断智能体结束或下一轮。 */
    })
  }

  async branches(cwd: string): Promise<GitBranches> {
    const branches = (
      await this.git(cwd, [
        'for-each-ref',
        '--format=%(refname:short)',
        'refs/heads',
        'refs/remotes',
      ])
    )
      .split(/\r?\n/u)
      .filter(ref => ref && !ref.endsWith('/HEAD'))
    const current = await this.git(cwd, ['branch', '--show-current'])
    const defaultBase =
      ['origin/main', 'origin/master', 'main', 'master'].find(
        ref => branches.includes(ref) && ref !== current,
      ) ??
      branches.find(ref => ref !== current) ??
      current
    return { kind: 'git-branches', branches, current, defaultBase }
  }
  private async boundary(
    cwd: string,
    request: GitReviewRequest,
  ): Promise<{
    before: string
    after: string
    directory?: string
    title: string
    sources: string[]
    message?: string
  }> {
    if (request.comparison === 'branch') {
      if (
        typeof request.baseRef !== 'string' ||
        request.baseRef.length > 512 ||
        request.baseRef.startsWith('-')
      )
        throw new Error('请选择有效的比较分支')
      const { branches } = await this.branches(cwd)
      if (!branches.includes(request.baseRef)) throw new Error('比较分支已不存在，请刷新后重试')
      const base = await this.git(cwd, ['rev-parse', '--verify', `${request.baseRef}^{commit}`])
      const after = await this.git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'])
      const before = await this.git(cwd, ['merge-base', base, after])
      return {
        before,
        after,
        title: `分支对比 · ${request.baseRef}`,
        sources: [`${request.baseRef} 的共同祖先`, '当前分支 HEAD'],
      }
    }
    if (
      request.comparison !== 'turn' ||
      typeof request.sessionId !== 'string' ||
      request.sessionId.length > 512 ||
      !request.sessionId
    )
      throw new Error('会话审阅参数无效')
    let snapshot: TurnSnapshot | null = null
    try {
      const value: unknown = JSON.parse(
        await readFile(join(this.directory(cwd), `${hash(request.sessionId)}.json`), 'utf8'),
      )
      if (
        typeof value === 'object' &&
        value !== null &&
        'turn' in value &&
        Number.isSafeInteger(value.turn) &&
        'before' in value &&
        typeof value.before === 'string' &&
        'after' in value &&
        typeof value.after === 'string'
      )
        snapshot = value as TurnSnapshot
    } catch {
      /* 老会话没有快照，明确显示不可用。 */
    }
    const title = snapshot ? `上轮改动 · 第 ${snapshot.turn} 轮` : '上轮改动'
    if (!snapshot || !treePattern.test(snapshot.before) || !treePattern.test(snapshot.after))
      return {
        before: '',
        after: '',
        title,
        sources: [],
        message:
          snapshot?.message ?? '该会话尚无完整文件快照。下一轮结束后可查看期间发生的工作区改动。',
      }
    return {
      before: snapshot.before,
      after: snapshot.after,
      title,
      sources: ['本轮开始前', '本轮结束后'],
      directory: join(this.directory(cwd), 'objects.git'),
    }
  }
  async review(cwd: string, request: GitReviewRequest): Promise<GitReview | GitReviewDiff> {
    const boundary = await this.boundary(cwd, request)
    const { before, after, directory, title, sources } = boundary
    if (boundary.message)
      return {
        kind: 'git-review',
        available: false,
        reviewId: '',
        title,
        sources,
        files: [],
        message: boundary.message,
      }
    const reviewId = `${before}:${after}`
    if (request.relativePath !== undefined) {
      if (request.reviewId !== reviewId) throw new Error('比较范围已更新，请刷新文件列表后重试')
      const path = request.relativePath
      if (
        !path ||
        path.length > 4096 ||
        isAbsolute(path) ||
        path.split(/[\\/]/u).includes('..') ||
        path.includes('\0')
      )
        throw new Error('比较文件路径无效')
      const patch = await this.git(
        cwd,
        [
          '--literal-pathspecs',
          'diff',
          '--relative',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          '--unified=8',
          before,
          after,
          '--',
          path,
        ],
        directory,
      )
      const lines = patch.split('\n')
      return {
        kind: 'git-review-diff',
        mode: 'review',
        relativePath: path,
        reviewTitle: title,
        sources,
        patch: lines.slice(0, 6000).join('\n'),
        truncated: lines.length > 6000,
        presentation: patch.includes('Binary files ') ? 'binary' : 'text',
      }
    }
    const counts = await this.git(
      cwd,
      [
        'diff',
        '--relative',
        '--no-ext-diff',
        '--no-textconv',
        '--numstat',
        '-z',
        '--no-renames',
        before,
        after,
        '--',
        '.',
      ],
      directory,
    )
    const names = await this.git(
      cwd,
      ['diff', '--relative', '--name-status', '-z', '--no-renames', before, after, '--', '.'],
      directory,
    )
    const statuses = new Map<string, string>()
    const parts = names.split('\0')
    for (let index = 0; index + 1 < parts.length; index += 2)
      statuses.set(parts[index + 1]!, parts[index]!)
    const files = counts
      .split('\0')
      .filter(Boolean)
      .map(line => {
        const [added = '0', removed = '0', ...path] = line.split('\t')
        const relativePath = path.join('\t')
        return {
          relativePath,
          status: statuses.get(relativePath) ?? 'M',
          additions: Number(added) || 0,
          deletions: Number(removed) || 0,
          binary: added === '-' || removed === '-',
        }
      })
    return { kind: 'git-review', available: true, reviewId, title, sources, files }
  }
  dispose(): void {
    this.stopped = true
    this.abort.abort()
    this.turns.clear()
  }
}
