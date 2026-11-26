/** 后台持有 AI 提交的仓库快照。只读取真实索引与文件，临时差异文件在 finally 中删除。 */
import { createHash } from 'node:crypto'
import { access, lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { GitAiExcludedChange, GitAiItem, GitAiScope } from '../../shared/git-ai.ts'
import type { GitAiRunner } from './git-ai-process.ts'
import { GitAiError } from './git-ai-errors.ts'

// 写入快照必须保留完整文件版本，不能沿用只发差异的模型预算；采样中累计限制内存。
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024

/** 可信条目同时持有目标内容与原工作区摘要，不能从 renderer 反序列化。 */
export interface GitAiSnapshotItem extends GitAiItem {
  path: string
  patch: string
  content: string | null
  fileMode: string
  fingerprint: string
}

/** 有生命周期的写操作基线；索引原字节用于检测外部变化，不用于强制恢复。 */
export interface GitAiSnapshot {
  root: string
  project: string
  gitDir: string
  commonDir: string
  head: string
  branch: string
  indexPath: string
  index: Buffer
  status: string
  config: string
  items: GitAiSnapshotItem[]
  excluded: GitAiExcludedChange[]
}

interface StatusFile {
  path: string
  original?: string
  index: string
  working: string
}

function inside(root: string, path: string): boolean {
  const part = relative(root, path)
  return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)
}

function parseStatus(text: string): StatusFile[] {
  const records = text.split('\0')
  const result: StatusFile[] = []
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    if (!record) continue
    const item: StatusFile = { path: record.slice(3), index: record[0]!, working: record[1]! }
    if (/[RC]/u.test(item.index + item.working)) item.original = records[++i] ?? ''
    result.push(item)
  }
  return result
}

function isAddedStatus(item: StatusFile) {
  return item.index === 'A' || item.index === '?'
}

function isDeletedStatus(item: StatusFile) {
  return item.index === 'D' || item.working === 'D'
}

function requireUnambiguousPath(snapshot: GitAiSnapshot, file: StatusFile) {
  const files = parseStatus(snapshot.status)
  if (files.filter(item => item.path === file.path).length > 1)
    throw new GitAiError('同路径存在删除与重新创建的混合状态，请手动处理')
  // 相似度不足的跨项目移动会退化为新增/删除；不能仅靠 Git 的重命名启发式放行。
  const ambiguous = files.some(
    other =>
      !inside(snapshot.project, resolve(snapshot.root, other.path)) &&
      ((isAddedStatus(file) && isDeletedStatus(other)) ||
        (isDeletedStatus(file) && isAddedStatus(other))),
  )
  if (ambiguous)
    throw new GitAiError('项目边界两侧同时存在新增与删除，可能是跨项目移动，请手动处理')
}

async function fileVersion(
  root: string,
  path: string,
): Promise<{ text: string | null; mode: string; fingerprint: string }> {
  const full = resolve(root, path)
  if (!inside(root, full) || /[\r\n\t\\]/u.test(path) || path.includes('\0'))
    throw new GitAiError('路径需要手动处理')
  let parent = dirname(full)
  while (parent !== root) {
    if (!(await lstat(parent)).isDirectory() || (await realpath(parent)) !== parent)
      throw new GitAiError('符号链接路径需要手动处理')
    parent = dirname(parent)
  }
  let stat
  try {
    stat = await lstat(full)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { text: null, mode: '0', fingerprint: 'deleted' }
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new GitAiError('符号链接或子模块需要手动处理')
  if (stat.size > 2 * 1024 * 1024) throw new GitAiError('文件过大，需要手动处理')
  const bytes = await readFile(full)
  const text = bytes.toString('utf8')
  if (bytes.includes(0) || !Buffer.from(text).equals(bytes))
    throw new GitAiError('二进制或非 UTF-8 文件需要手动处理')
  const mode = stat.mode & 0o111 ? '100755' : '100644'
  return { text, mode, fingerprint: createHash('sha256').update(mode).update(bytes).digest('hex') }
}

async function readEntry(options: {
  run: GitAiRunner
  root: string
  revision: string
  path: string
  signal: AbortSignal
}) {
  const { run, root, revision, path, signal } = options
  const output = await run({ cwd: root, args: ['ls-tree', '-z', revision, '--', path], signal })
  const match = /^(\d+) blob ([a-f0-9]+)\t/u.exec(output)
  if (!output) return { content: null, mode: '0' }
  if (!match || !['100644', '100755'].includes(match[1]!))
    throw new GitAiError('子模块或符号链接需要手动处理')
  const content = await run({ cwd: root, args: ['cat-file', 'blob', match[2]!], signal })
  if (content.includes('\0') || content.includes('\uFFFD'))
    throw new GitAiError('二进制或非 UTF-8 文件需要手动处理')
  return { content, mode: match[1]! }
}

async function checkContentConversion(
  run: GitAiRunner,
  root: string,
  path: string,
  signal: AbortSignal,
) {
  const attributes = await run({
    cwd: root,
    args: ['check-attr', '-z', 'filter', 'working-tree-encoding', 'ident', '--', path],
    signal,
  })
  const values = attributes.split('\0').filter((_, i) => i % 3 === 2)
  if (values.some(value => !['unspecified', 'unset'].includes(value)))
    throw new GitAiError('文件使用 Git 内容转换，请手动暂存后仅分析暂存区')
}

async function readStagedEntry(run: GitAiRunner, root: string, path: string, signal: AbortSignal) {
  const entry = await run({ cwd: root, args: ['ls-files', '--stage', '-z', '--', path], signal })
  const match = /^(100644|100755) ([a-f0-9]+) 0\t/u.exec(entry)
  if (entry && !match) throw new GitAiError('索引条目需要手动处理')
  const content = match
    ? await run({ cwd: root, args: ['cat-file', 'blob', match[2]!], signal })
    : null
  return { content, mode: match?.[1] ?? '0' }
}

async function makePatch(
  run: GitAiRunner,
  item: {
    path: string
    before: string | null
    after: string | null
    beforeMode: string
    afterMode: string
  },
  signal: AbortSignal,
): Promise<string> {
  const temporary = await mkdtemp(join(tmpdir(), 'mydsh-git-diff-'))
  try {
    await writeFile(join(temporary, 'before'), item.before ?? '', { mode: 0o600 })
    await writeFile(join(temporary, 'after'), item.after ?? '', { mode: 0o600 })
    const patch = await run({
      cwd: temporary,
      args: [
        'diff',
        '--no-index',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--unified=8',
        '--',
        'before',
        'after',
      ],
      accepted: [0, 1],
      signal,
    })
    const body = patch.slice(patch.indexOf('@@'))
    const header = [`diff --git a/${item.path} b/${item.path}`]
    if (item.before === null) header.push(`new file mode ${item.afterMode}`)
    if (item.after === null) header.push(`deleted file mode ${item.beforeMode}`)
    header.push(
      item.before === null ? '--- /dev/null' : `--- a/${item.path}`,
      item.after === null ? '+++ /dev/null' : `+++ b/${item.path}`,
    )
    return patch ? `${header.join('\n')}\n${body}` : ''
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function captureItem(options: {
  run: GitAiRunner
  snapshot: GitAiSnapshot
  file: StatusFile
  scope: GitAiScope
  signal: AbortSignal
}): Promise<GitAiSnapshotItem> {
  const { run, snapshot, file, scope, signal } = options
  requireUnambiguousPath(snapshot, file)
  if (file.original || /[RC]/u.test(file.index + file.working))
    throw new GitAiError('重命名（含跨项目移动）需要手动处理')
  if (
    file.index === 'U' ||
    file.working === 'U' ||
    ['AA', 'DD'].includes(file.index + file.working)
  )
    throw new GitAiError('存在未解决的冲突')
  const staged = file.index !== ' ' && file.index !== '?'
  const working = file.working !== ' '
  if (staged && working && !scope.staged && scope.working)
    throw new GitAiError('同文件已有暂存内容，请同时选择暂存范围或手动处理')
  const useWorking = file.index === '?' || (scope.working && working)
  const current = await fileVersion(snapshot.root, file.path)
  const before = await readEntry({
    run,
    root: snapshot.root,
    revision: snapshot.head,
    path: file.path,
    signal,
  })
  let content = current.text
  let fileMode = current.mode
  if (!useWorking) {
    const entry = await readStagedEntry(run, snapshot.root, file.path, signal)
    content = entry.content
    fileMode = entry.mode
  } else {
    await checkContentConversion(run, snapshot.root, file.path, signal)
    if (content?.includes('\r')) throw new GitAiError('文件包含 CR 换行，请手动暂存后仅分析暂存区')
  }
  if (content?.includes('\0') || content?.includes('\uFFFD'))
    throw new GitAiError('二进制或非 UTF-8 文件需要手动处理')
  const relativePath = relative(snapshot.project, join(snapshot.root, file.path))
    .split(sep)
    .join('/')
  const patch = await makePatch(
    run,
    {
      path: relativePath,
      before: before.content,
      after: content,
      beforeMode: before.mode,
      afterMode: fileMode,
    },
    signal,
  )
  if (!patch || (before.mode !== fileMode && before.mode !== '0' && fileMode !== '0'))
    throw new GitAiError('空文件或权限变化需要手动处理')
  const mode = useWorking ? 'working' : 'staged'
  const id = createHash('sha256')
    .update(JSON.stringify([file.path, mode, fileMode, content]))
    .digest('hex')
  return {
    id,
    relativePath,
    mode,
    requiresWholeFile: staged && working && useWorking,
    path: file.path,
    patch,
    content,
    fileMode,
    fingerprint: current.fingerprint,
  }
}

/** 复核完整真实索引、HEAD 与所涉工作区文件，任何变化都要求重新审阅。 */
export async function verifyGitAiSnapshot(
  snapshot: GitAiSnapshot,
  run: GitAiRunner,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  await requireOrdinaryRepository(snapshot.gitDir)
  const head = (await run({ cwd: snapshot.root, args: ['rev-parse', 'HEAD'], signal })).trim()
  const branch = (await run({ cwd: snapshot.root, args: ['symbolic-ref', 'HEAD'], signal })).trim()
  const index = await readFile(snapshot.indexPath)
  const config = await gitAiConfigFingerprint(run, snapshot.root, { signal })
  const status = await run({
    cwd: snapshot.root,
    args: ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--renames'],
    signal,
  })
  if (
    head !== snapshot.head ||
    branch !== snapshot.branch ||
    !index.equals(snapshot.index) ||
    status !== snapshot.status ||
    config !== snapshot.config
  )
    throw new GitAiError('工作区、HEAD 或暂存区已变化，请重新分析并审阅')
  for (const item of snapshot.items) {
    // 串行读取避免大量文件同时打开；不以 mtime 代替内容校验。
    // oxlint-disable-next-line no-await-in-loop
    if ((await fileVersion(snapshot.root, item.path)).fingerprint !== item.fingerprint)
      throw new GitAiError('工作区内容已更新，请重新分析并审阅')
  }
}

/** 只保留有效 Git 配置的摘要，条件包含或签名设置变化时拒绝沿用旧方案。 */
export async function gitAiConfigFingerprint(
  run: GitAiRunner,
  root: string,
  options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<string> {
  const config = await run({
    cwd: root,
    args: ['config', '--null', '--list', '--includes'],
    ...options,
  })
  return createHash('sha256').update(config).digest('hex')
}

async function requireOrdinaryRepository(gitDir: string) {
  const states = [
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'rebase-merge',
    'rebase-apply',
    'sequencer',
  ]
  const present = await Promise.all(
    states.map(name =>
      access(join(gitDir, name)).then(
        () => true,
        () => false,
      ),
    ),
  )
  if (present.some(Boolean)) throw new GitAiError('仓库正在合并、变基或拣选，请先完成当前 Git 操作')
  const index = await lstat(join(gitDir, 'index'))
  if (!index.isFile() || index.isSymbolicLink() || index.size > 16 * 1024 * 1024)
    throw new GitAiError('索引类型或大小需要手动处理')
}

/** 读取项目范围内版本并复核，仓库外暂存仅用于索引一致性检查，不发送模型。 */
export async function captureGitAiSnapshot(
  project: string,
  scope: GitAiScope,
  run: GitAiRunner,
  signal: AbortSignal,
): Promise<GitAiSnapshot> {
  signal.throwIfAborted()
  project = await realpath(project)
  const root = await realpath(
    (await run({ cwd: project, args: ['rev-parse', '--show-toplevel'], signal })).trim(),
  )
  const gitDir = (
    await run({ cwd: root, args: ['rev-parse', '--absolute-git-dir'], signal })
  ).trim()
  const commonDir = resolve(
    root,
    (await run({ cwd: root, args: ['rev-parse', '--git-common-dir'], signal })).trim(),
  )
  const indexPath = join(gitDir, 'index')
  await requireOrdinaryRepository(gitDir)
  const snapshot: GitAiSnapshot = {
    root,
    project,
    gitDir,
    commonDir,
    indexPath,
    head: (await run({ cwd: root, args: ['rev-parse', '--verify', 'HEAD'], signal })).trim(),
    branch: (await run({ cwd: root, args: ['symbolic-ref', 'HEAD'], signal })).trim(),
    index: await readFile(indexPath),
    status: await run({
      cwd: root,
      args: ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--renames'],
      signal,
    }),
    config: await gitAiConfigFingerprint(run, root, { signal }),
    items: [],
    excluded: [],
  }
  const flags = await run({ cwd: root, args: ['ls-files', '-v', '-z'], signal })
  const shared = await run({ cwd: root, args: ['rev-parse', '--shared-index-path'], signal })
  if (shared.trim() || flags.split('\0').some(line => line && !line.startsWith('H ')))
    throw new GitAiError('特殊索引、冲突或稀疏工作区需要手动处理')
  const files = parseStatus(snapshot.status).filter(
    file =>
      inside(project, resolve(root, file.path)) ||
      (file.original && inside(project, resolve(root, file.original))),
  )
  if (files.length > 200) throw new GitAiError('待分析的变更超过 200 项，请缩小项目范围')
  let snapshotBytes = 0
  for (const file of files) {
    const selected =
      file.index === '?'
        ? scope.untracked
        : (scope.staged && file.index !== ' ') || (scope.working && file.working !== ' ')
    if (!selected) continue
    signal.throwIfAborted()
    try {
      // oxlint-disable-next-line no-await-in-loop
      const item = await captureItem({ run, snapshot, file, scope, signal })
      snapshotBytes += Buffer.byteLength(JSON.stringify(item))
      snapshot.items.push(item)
    } catch (error) {
      signal.throwIfAborted()
      const path = inside(project, resolve(root, file.path)) ? file.path : file.original!
      const excluded: GitAiExcludedChange = {
        relativePath: relative(project, resolve(root, path)),
        mode: file.index === ' ' || file.index === '?' ? 'working' : 'staged',
        reason:
          error instanceof GitAiError
            ? error.message
            : '无法读取此文件的 Git 差异，请检查访问权限与 Git 配置后手动处理',
      }
      if (!snapshot.excluded.some(item => item.relativePath === excluded.relativePath))
        snapshot.excluded.push(excluded)
    }
    if (snapshotBytes > MAX_SNAPSHOT_BYTES)
      throw new GitAiError('本地提交快照超过 16 MiB，请缩小分析范围；本次未向模型发送内容')
  }
  await verifyGitAiSnapshot(snapshot, run, signal)
  return snapshot
}
