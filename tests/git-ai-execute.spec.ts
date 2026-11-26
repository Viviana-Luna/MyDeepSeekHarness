/** 在隔离仓库证明候选提交、部分暂存和真实索引协调；不接触开发仓库历史。 */
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  captureGitAiSnapshot,
  verifyGitAiSnapshot,
} from '../src/runtime/workspace/git-ai-snapshot.ts'
import { executeGitAiBatch } from '../src/runtime/workspace/git-ai-execute.ts'
import { runGitAiTest } from './git-ai-fixture.ts'
import type { GitAiRunner } from '../src/runtime/workspace/git-ai-process.ts'

const roots: string[] = []
const all = { staged: true, working: true, untracked: true }
const runWithLostAcknowledgment: GitAiRunner = async command => {
  const result = await runGitAiTest(command)
  if (command.args[0] === 'update-ref') throw new Error('模拟事务回包失败')
  return result
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mydsh-ai-execute-'))
  roots.push(root)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  git('init', '-qb', 'main')
  git('config', 'user.name', '测试')
  git('config', 'user.email', 'test@example.invalid')
  mkdirSync(join(root, 'sub'))
  const write = (path: string, text: string) => writeFileSync(join(root, path), text)
  write('sub/a.txt', '基线\n')
  write('sub/b.txt', '另一基线\n')
  write('outside.txt', '外部基线\n')
  write('.gitignore', 'ignored.txt\n')
  git('add', '.')
  git('commit', '-qm', '初始提交')
  const capture = (scope = all) =>
    captureGitAiSnapshot(join(root, 'sub'), scope, runGitAiTest, new AbortController().signal)
  const hook = (name: string, text: string) => {
    write(`.git/hooks/${name}`, `#!/bin/sh\n${text}\n`)
    chmodSync(join(root, '.git/hooks', name), 0o755)
  }
  return { root, git, write, capture, hook }
}

describe('AI 提交隔离执行', () => {
  it('只提交所选暂存版本，保留同文件未暂存内容和项目外暂存', async () => {
    const { root, git, write, capture } = fixture()
    write('sub/a.txt', '暂存版本\n')
    write('outside.txt', '外部暂存\n')
    git('add', 'sub/a.txt', 'outside.txt')
    write('sub/a.txt', '工作区版本\n')
    const beforeIndex = git('ls-files', '--stage')
    const snapshot = await capture({ staged: true, working: false, untracked: false })
    expect(snapshot.items[0]?.patch).toContain('+暂存版本')
    expect(snapshot.items[0]?.patch).not.toContain('工作区版本')
    await executeGitAiBatch(
      snapshot,
      { message: '提交暂存版本', itemIds: [snapshot.items[0]!.id] },
      runGitAiTest,
      new AbortController().signal,
    )
    expect(git('show', 'HEAD:sub/a.txt')).toBe('暂存版本\n')
    expect(git('show', 'HEAD:outside.txt')).toBe('外部基线\n')
    expect(git('ls-files', '--stage')).toBe(beforeIndex)
    expect(git('diff', '--', 'sub/a.txt')).toContain('+工作区版本')
    expect(readFileSync(join(root, 'sub/a.txt'), 'utf8')).toBe('工作区版本\n')
    expect(existsSync(join(root, '.git/index.lock'))).toBe(false)
  })

  it('提交整文件和未跟踪文件，不携带未选暂存且不反向暂存', async () => {
    const { root, git, write, capture } = fixture()
    write('sub/a.txt', '部分暂存\n')
    write('sub/b.txt', '暂不提交\n')
    git('add', 'sub')
    write('sub/a.txt', '最终版本\n')
    write('sub/new.txt', '新文件无尾换行')
    chmodSync(join(root, 'sub/new.txt'), 0o755)
    write('sub/ignored.txt', '不应采样')
    const snapshot = await capture()
    expect(snapshot.items.some(item => item.relativePath === 'ignored.txt')).toBe(false)
    const items = snapshot.items.filter(item => item.relativePath !== 'b.txt')
    const expectedMode = process.platform === 'win32' ? '100644' : '100755'
    expect(items.find(item => item.relativePath === 'new.txt')?.patch).toContain(
      `new file mode ${expectedMode}`,
    )
    expect(items.find(item => item.relativePath === 'a.txt')?.requiresWholeFile).toBe(true)
    for (const item of items)
      await executeGitAiBatch(
        snapshot,
        { message: `更新 ${item.relativePath}`, itemIds: [item.id] },
        runGitAiTest,
        new AbortController().signal,
      )
    expect(git('diff', '--cached', '--name-only').trim()).toBe('sub/b.txt')
    expect(git('diff', '--name-only')).toBe('')
    expect(git('show', 'HEAD:sub/new.txt')).toBe('新文件无尾换行')
    expect(git('ls-tree', 'HEAD', 'sub/new.txt').startsWith(`${expectedMode} `)).toBe(true)
  })

  it.each(['a.txt', 'added.txt'])('新增 %s 下的文件时保留未选的同名暂存文件', async name => {
    const { root, git, write, capture } = fixture()
    const stagedPath = `sub/${name}`
    const childPath = `${stagedPath}/new.txt`
    write(stagedPath, '必须保留的暂存版本\n')
    git('add', stagedPath)
    rmSync(join(root, stagedPath))
    mkdirSync(join(root, stagedPath))
    write(childPath, '待提交的新文件\n')
    const snapshot = await capture({ staged: false, working: false, untracked: true })
    expect(snapshot.items.map(item => item.path)).toEqual([childPath])
    const head = git('rev-parse', 'HEAD')
    const index = readFileSync(snapshot.indexPath)

    await expect(
      executeGitAiBatch(
        snapshot,
        { message: '提交新增文件', itemIds: [snapshot.items[0]!.id] },
        runGitAiTest,
        new AbortController().signal,
      ),
    ).rejects.toThrow('影响本批之外的 Git 索引条目')

    expect(git('rev-parse', 'HEAD')).toBe(head)
    expect(readFileSync(snapshot.indexPath)).toEqual(index)
    expect(git('show', `:${stagedPath}`)).toBe('必须保留的暂存版本\n')
    expect(readFileSync(join(root, childPath), 'utf8')).toBe('待提交的新文件\n')
    expect(readdirSync(snapshot.gitDir).filter(entry => entry.startsWith('mydsh-ai-'))).toEqual([])
    expect(existsSync(`${snapshot.indexPath}.lock`)).toBe(false)
    expect(existsSync(join(snapshot.gitDir, 'HEAD.lock'))).toBe(false)
  })

  it('允许普通暂存新增，拒绝跨项目重命名和仅工作区的混合文件', async () => {
    const { git, write, capture } = fixture()
    git('config', 'status.renames', 'false')
    write('sub/new.txt', '新增\n')
    git('add', 'sub/new.txt')
    git('mv', 'outside.txt', 'sub/moved.txt')
    write('sub/a.txt', '暂存\n')
    git('add', 'sub/a.txt')
    write('sub/a.txt', '工作区\n')
    const snapshot = await capture()
    expect(snapshot.items.map(item => item.relativePath)).toContain('new.txt')
    expect(snapshot.excluded.some(item => item.relativePath === 'moved.txt')).toBe(true)
    const working = await capture({ staged: false, working: true, untracked: true })
    expect(working.excluded.some(item => item.relativePath === 'a.txt')).toBe(true)
  })

  it('hook 失败不改 HEAD 或索引，前一成功批次保留并可重试', async () => {
    const { root, git, write, capture, hook } = fixture()
    write('sub/a.txt', '第一批\n')
    write('sub/b.txt', '第二批\n')
    const snapshot = await capture()
    const first = snapshot.items[0]!,
      second = snapshot.items[1]!
    const hash = await executeGitAiBatch(
      snapshot,
      { message: '第一批', itemIds: [first.id] },
      runGitAiTest,
      new AbortController().signal,
    )
    const index = readFileSync(join(root, '.git/index'))
    hook('commit-msg', 'echo "测试拒绝提交" >&2; exit 1')
    await expect(
      executeGitAiBatch(
        snapshot,
        { message: '第二批', itemIds: [second.id] },
        runGitAiTest,
        new AbortController().signal,
      ),
    ).rejects.toThrow('请检查 Git hook、签名或仓库配置')
    expect(git('rev-parse', 'HEAD').trim()).toBe(hash)
    expect(readFileSync(join(root, '.git/index')).equals(index)).toBe(true)
    expect(
      readdirSync(join(root, '.git')).some(
        name => name.startsWith('mydsh-ai-') || name === 'index.lock',
      ),
    ).toBe(false)
    rmSync(join(root, '.git/hooks/commit-msg'))
    await verifyGitAiSnapshot(snapshot, runGitAiTest, new AbortController().signal)
    await executeGitAiBatch(
      snapshot,
      { message: '第二批', itemIds: [second.id] },
      runGitAiTest,
      new AbortController().signal,
    )
    expect(git('status', '--porcelain')).toBe('')
  })

  it('重命名相似度不足和同路径删除后重建均明确留给手动处理', async () => {
    const { git, write, capture } = fixture()
    git('mv', 'outside.txt', 'sub/moved.txt')
    write('sub/moved.txt', '移动后完全不同的内容\n')
    git('add', 'sub/moved.txt')
    git('rm', 'sub/a.txt')
    write('sub/a.txt', '重新创建\n')
    const snapshot = await capture()
    expect(snapshot.items).toHaveLength(0)
    expect(snapshot.excluded).toHaveLength(2)
    expect(snapshot.excluded.find(item => item.relativePath === 'moved.txt')?.reason).toContain(
      '跨项目移动',
    )
    expect(snapshot.excluded.find(item => item.relativePath === 'a.txt')?.reason).toContain(
      '删除与重新创建',
    )
  })

  it('hook 增添未审阅内容时只生成候选，不更新真实分支', async () => {
    const { git, write, capture, hook } = fixture()
    write('sub/a.txt', '已审阅\n')
    write('outside.txt', '未审阅\n')
    const snapshot = await capture(),
      head = git('rev-parse', 'HEAD')
    hook('pre-commit', 'git add outside.txt')
    await expect(
      executeGitAiBatch(
        snapshot,
        { message: '更新', itemIds: [snapshot.items[0]!.id] },
        runGitAiTest,
        new AbortController().signal,
      ),
    ).rejects.toThrow('hook 改变')
    expect(git('rev-parse', 'HEAD')).toBe(head)
    expect(git('diff', '--cached')).toBe('')
  })

  it('并发文件或索引变化、预取消和已有锁均阻止写入', async () => {
    const { root, git, write, capture } = fixture()
    write('sub/a.txt', '审阅版本\n')
    const snapshot = await capture(),
      batch = { message: '更新', itemIds: [snapshot.items[0]!.id] }
    const head = git('rev-parse', 'HEAD')
    write('sub/a.txt', '另一个版本\n')
    await expect(
      executeGitAiBatch(snapshot, batch, runGitAiTest, new AbortController().signal),
    ).rejects.toThrow('更新')
    write('sub/a.txt', '审阅版本\n')
    git('add', 'sub/a.txt')
    await expect(
      executeGitAiBatch(snapshot, batch, runGitAiTest, new AbortController().signal),
    ).rejects.toThrow('变化')
    const fresh = await capture()
    const aborted = new AbortController()
    aborted.abort()
    await expect(executeGitAiBatch(fresh, batch, runGitAiTest, aborted.signal)).rejects.toThrow()
    write('.git/index.lock', '其他进程')
    await expect(
      executeGitAiBatch(fresh, batch, runGitAiTest, new AbortController().signal),
    ).rejects.toThrow('占用')
    expect(readFileSync(join(root, '.git/index.lock'), 'utf8')).toBe('其他进程')
    expect(git('rev-parse', 'HEAD')).toBe(head)
  })

  it('引用已发布但进程回包失败时仍完成协调，不反向暂存或重复提交', async () => {
    const { root, git, write, capture } = fixture()
    write('sub/a.txt', '已审阅\n')
    const snapshot = await capture()
    const hash = await executeGitAiBatch(
      snapshot,
      { message: '更新文件', itemIds: [snapshot.items[0]!.id] },
      runWithLostAcknowledgment,
      new AbortController().signal,
    )
    expect(git('rev-parse', 'HEAD').trim()).toBe(hash)
    expect(git('status', '--porcelain')).toBe('')
    expect(git('rev-list', '--count', 'HEAD').trim()).toBe('2')
    expect(existsSync(join(root, '.git/index.lock'))).toBe(false)
  })

  it.each([false, true])('安装索引后保留后续进程取得的锁（刷新失败 %s）', async failStatus => {
    const { root, git, write, capture } = fixture()
    write('sub/a.txt', '已审阅\n')
    const snapshot = await capture()
    const lockPath = join(root, '.git/index.lock')
    const run: GitAiRunner = async command => {
      // 只有安装索引后的状态刷新不携带取消信号，此时模拟下一个 Git 写入者取得锁。
      if (command.args[0] === 'status' && command.signal === undefined) {
        writeFileSync(lockPath, '其他进程的索引', { flag: 'wx' })
        if (failStatus) throw new Error('不可信的刷新诊断')
      }
      return runGitAiTest(command)
    }
    const executing = executeGitAiBatch(
      snapshot,
      { message: '更新文件', itemIds: [snapshot.items[0]!.id] },
      run,
      new AbortController().signal,
    )
    if (failStatus)
      await expect(executing).rejects.toThrow(
        /^已创建提交 [0-9a-f]+ 并更新索引，但无法刷新 Git 状态。请检查工作区后重新分析$/u,
      )
    else expect(await executing).toBe(git('rev-parse', 'HEAD').trim())
    expect(git('show', 'HEAD:sub/a.txt')).toBe('已审阅\n')
    expect(git('show', ':sub/a.txt')).toBe('已审阅\n')
    expect(readFileSync(lockPath, 'utf8')).toBe('其他进程的索引')
  })

  it('签名失败保留原索引，条件配置在隔离环境变化时明确阻止', async () => {
    const { root, git, write, capture } = fixture()
    write('sub/a.txt', '需要签名\n')
    git('config', 'commit.gpgsign', 'true')
    git('config', 'gpg.program', 'mydsh-test-nonexistent-gpg')
    const head = git('rev-parse', 'HEAD'),
      index = readFileSync(join(root, '.git/index'))
    const snapshot = await capture()
    await expect(
      executeGitAiBatch(
        snapshot,
        { message: '更新文件', itemIds: [snapshot.items[0]!.id] },
        runGitAiTest,
        new AbortController().signal,
      ),
    ).rejects.toThrow()
    expect(git('rev-parse', 'HEAD')).toBe(head)
    expect(readFileSync(join(root, '.git/index')).equals(index)).toBe(true)
    git('config', 'commit.gpgsign', 'false')
    write('.git/conditional', '[commit]\n gpgsign = true\n')
    git('config', 'includeIf.onbranch:main.path', join(root, '.git/conditional'))
    const conditional = await capture()
    await expect(
      executeGitAiBatch(
        conditional,
        { message: '更新文件', itemIds: [conditional.items[0]!.id] },
        runGitAiTest,
        new AbortController().signal,
      ),
    ).rejects.toThrow('签名设置')
    expect(git('rev-parse', 'HEAD')).toBe(head)
  })

  it('仓库进入合并过程或 HEAD 改变后必须重新审阅', async () => {
    const { git, write, capture } = fixture()
    write('sub/a.txt', '工作区版本\n')
    const snapshot = await capture()
    git('commit', '--allow-empty', '-qm', '外部提交')
    await expect(
      verifyGitAiSnapshot(snapshot, runGitAiTest, new AbortController().signal),
    ).rejects.toThrow('HEAD')
    write('.git/MERGE_HEAD', git('rev-parse', 'HEAD'))
    await expect(capture()).rejects.toThrow('合并')
  })
})
