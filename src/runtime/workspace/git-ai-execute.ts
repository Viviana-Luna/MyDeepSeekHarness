/** 后台创建隔离提交候选，核验后以引用事务发布，并在真实索引锁内只协调本批条目。 */
import { mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GitAiPlanBatch } from '../../shared/git-ai.ts'
import { GitAiError } from './git-ai-errors.ts'
import type { GitAiRunner } from './git-ai-process.ts'
import {
  verifyGitAiSnapshot,
  gitAiConfigFingerprint,
  type GitAiSnapshot,
  type GitAiSnapshotItem,
} from './git-ai-snapshot.ts'

class UncertainCommitError extends GitAiError {}

async function publishCandidate(options: {
  snapshot: GitAiSnapshot
  hash: string
  temporary: string
  run: GitAiRunner
}) {
  const { snapshot, hash, temporary, run } = options
  try {
    await run({
      cwd: snapshot.root,
      args: [
        'update-ref',
        '--no-deref',
        '-m',
        'MyDSH AI 本地提交',
        snapshot.branch,
        hash,
        snapshot.head,
      ],
      env: { GIT_DIR: temporary, GIT_WORK_TREE: snapshot.root },
    })
  } catch {
    // 引用事务可能已落盘而子进程回包失败，必须复核，不能清理掉唯一的协调索引。
    const actual = await run({ cwd: snapshot.root, args: ['rev-parse', snapshot.branch] }).then(
      value => value.trim(),
      () => null,
    )
    if (actual === hash) return
    if (actual === snapshot.head) throw new GitAiError('无法更新分支引用，请检查仓库状态后重试')
    throw new UncertainCommitError(
      `提交结果无法确认（候选 ${hash}）。已保留 ${snapshot.indexPath}.lock，请检查仓库后手动处理，不要重复提交`,
    )
  }
}

async function updateEntries(options: {
  run: GitAiRunner
  snapshot: GitAiSnapshot
  index: string
  items: GitAiSnapshotItem[]
  signal: AbortSignal
}) {
  const { run, snapshot, index, items, signal } = options
  const env = { GIT_INDEX_FILE: index }
  const selectedPaths = new Set(items.map(item => item.path))
  const readUnselectedEntries = async () => {
    const output = await run({
      cwd: snapshot.root,
      args: ['ls-files', '--stage', '-z'],
      env,
      signal,
    })
    return output
      .split('\0')
      .filter(entry => !selectedPaths.has(entry.slice(entry.indexOf('\t') + 1)))
      .join('\0')
  }
  const before = await readUnselectedEntries()
  const entries: string[] = []
  for (const item of items) {
    // 对象写入只发生在用户确认执行后；内容来自后台快照而非补丁。
    const hash =
      item.content === null
        ? '0'.repeat(snapshot.head.length)
        : (
            await run({
              cwd: snapshot.root,
              args: ['hash-object', '-w', '--stdin', '--no-filters'],
              input: item.content,
              signal,
            })
          ).trim()
    entries.push(`${item.fileMode} ${hash}\t${item.path}\0`)
  }
  await run({
    cwd: snapshot.root,
    args: ['update-index', '-z', '--index-info'],
    input: entries.join(''),
    env,
    signal,
  })
  // Git 会隐式移除与新增路径冲突的同名文件或目录子项，两份临时索引都要复核。
  if ((await readUnselectedEntries()) !== before)
    throw new GitAiError('此次提交会影响本批之外的 Git 索引条目，请手动处理文件与目录冲突')
}

async function candidate(options: {
  snapshot: GitAiSnapshot
  batch: GitAiPlanBatch
  temporary: string
  run: GitAiRunner
  signal: AbortSignal
}) {
  const { snapshot, batch, temporary, run, signal } = options
  const items = batch.itemIds.map(id => snapshot.items.find(item => item.id === id)!)
  const index = join(temporary, 'index')
  const env = { GIT_DIR: temporary, GIT_WORK_TREE: snapshot.root, GIT_INDEX_FILE: index }
  // 独立 HEAD 不移动用户分支；共享对象库、配置、hooks 与签名设置。
  await writeFile(join(temporary, 'commondir'), `${snapshot.commonDir}\n`)
  await writeFile(join(temporary, 'HEAD'), `${snapshot.head}\n`)
  if ((await gitAiConfigFingerprint(run, snapshot.root, { env, signal })) !== snapshot.config)
    throw new GitAiError('隔离提交会改变条件 Git 配置或签名设置，请手动提交')
  await run({ cwd: snapshot.root, args: ['read-tree', snapshot.head], env, signal })
  await updateEntries({ run, snapshot, index, items, signal })
  const coordinated = join(temporary, 'coordinated-index')
  await writeFile(coordinated, snapshot.index, { mode: 0o600 })
  await updateEntries({ run, snapshot, index: coordinated, items, signal })
  const coordinatedIndex = await readFile(coordinated)
  const expectedTree = (await run({ cwd: snapshot.root, args: ['write-tree'], env, signal })).trim()
  await run({
    cwd: snapshot.root,
    args: ['commit', '--message', batch.message],
    env,
    signal,
  }).catch(() => {
    signal.throwIfAborted()
    throw new GitAiError('Git 提交命令失败，请检查 Git hook、签名或仓库配置后重试')
  })
  const hash = (await run({ cwd: snapshot.root, args: ['rev-parse', 'HEAD'], env, signal })).trim()
  const actual = (
    await run({ cwd: snapshot.root, args: ['show', '-s', '--format=%T%n%P', hash], signal })
  ).trim()
  if (actual !== `${expectedTree}\n${snapshot.head}`)
    throw new GitAiError(
      `Git hook 改变了待提交内容，候选 ${hash} 未更新到分支。请重新审阅后手动处理`,
    )
  await verifyGitAiSnapshot(snapshot, run, signal)
  return { hash, index: coordinatedIndex, items }
}

/**
 * 执行一批已确认版本。保留未选索引条目，不修改工作区，不使用 reset/stash 或跳过 hooks。
 * 引用发布后不得取消索引协调；失败保留成功提交和必要的索引恢复文件。
 */
export async function executeGitAiBatch(
  snapshot: GitAiSnapshot,
  batch: GitAiPlanBatch,
  run: GitAiRunner,
  signal: AbortSignal,
): Promise<string> {
  await verifyGitAiSnapshot(snapshot, run, signal)
  const lockPath = `${snapshot.indexPath}.lock`
  const lock = await open(lockPath, 'wx', 0o600).catch(() => {
    throw new GitAiError('Git 索引正被其他进程占用，请稍后重试')
  })
  let temporary: string | undefined
  let headLock: Awaited<ReturnType<typeof open>> | undefined
  let published = false
  let coordinated = false
  let uncertain = false
  try {
    headLock = await open(join(snapshot.gitDir, 'HEAD.lock'), 'wx', 0o600)
    await verifyGitAiSnapshot(snapshot, run, signal)
    temporary = await mkdtemp(join(snapshot.gitDir, 'mydsh-ai-'))
    const result = await candidate({ snapshot, batch, temporary, run, signal })
    await lock.writeFile(result.index)
    await lock.sync()
    await verifyGitAiSnapshot(snapshot, run, signal)
    signal.throwIfAborted()
    // HEAD.lock 阻止切换分支；从候选的独立 HEAD 更新明确分支，避免 Git 隐式重复锁定真实 HEAD。
    await publishCandidate({ snapshot, hash: result.hash, temporary, run })
    published = true
    snapshot.head = result.hash
    await lock.close()
    await rename(lockPath, snapshot.indexPath)
    coordinated = true
    snapshot.index = result.index
    snapshot.items = snapshot.items.filter(item => !batch.itemIds.includes(item.id))
    snapshot.status = await run({
      cwd: snapshot.root,
      args: ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--renames'],
    })
    return result.hash
  } catch (error) {
    uncertain = error instanceof UncertainCommitError
    if (coordinated)
      throw new GitAiError(
        `已创建提交 ${snapshot.head} 并更新索引，但无法刷新 Git 状态。请检查工作区后重新分析`,
      )
    if (published)
      throw new GitAiError(
        `已创建提交 ${snapshot.head}，后续索引协调未完成。请检查 ${lockPath}，不要重复提交`,
      )
    throw error
  } finally {
    if (headLock) {
      await headLock.close()
      await rm(join(snapshot.gitDir, 'HEAD.lock'), { force: true })
    }
    await lock.close().catch(() => {})
    // 发布成功后，锁已安装为索引或留待恢复。同名路径可能已经由其他 Git 进程取得。
    if (!uncertain && !published) await rm(lockPath, { force: true })
    if (temporary) await rm(temporary, { recursive: true, force: true })
  }
}
