/**
 * Git 监听器单元测试：覆盖路径分类、工作区过滤、真实仓库外部提交、Git worktree、
 * index.lock 退避与资源释放。
 */
import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  classifyGitMetadataPath,
  GitWatcherService,
  mergeGitChangeScope,
  shouldIgnoreWorkingTreePath,
} from '../src/runtime/workspace/git-watcher-service.ts'
import { parseDesktopProjectEvent, type DesktopProjectEvent } from '../src/shared/project-events.ts'

function runGit(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Tester',
      GIT_AUTHOR_EMAIL: 'tester@example.com',
      GIT_COMMITTER_NAME: 'Tester',
      GIT_COMMITTER_EMAIL: 'tester@example.com',
      GIT_TERMINAL_PROMPT: '0',
    },
  }).trim()
}

async function waitForEvent(
  events: DesktopProjectEvent[],
  predicate: (event: DesktopProjectEvent) => boolean,
  timeoutMs = 5_000,
): Promise<DesktopProjectEvent> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = events.find(predicate)
    if (found !== undefined) return found
    // 顺序轮询测试缓冲队列，避免引入外部事件等待依赖。
    // oxlint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`在 ${String(timeoutMs)}ms 内未收到预期 Git 变更事件`)
}

describe('Git 监听器路径分类与事件契约校验', () => {
  it('准确区分 .git 元数据级别并忽略锁文件与无关构建目录', () => {
    expect(mergeGitChangeScope(null, 'working')).toBe('working')
    expect(mergeGitChangeScope('working', 'refs')).toBe('refs')
    expect(mergeGitChangeScope('refs', 'working')).toBe('refs')

    expect(classifyGitMetadataPath('HEAD')).toBe('refs')
    expect(classifyGitMetadataPath('packed-refs')).toBe('refs')
    expect(classifyGitMetadataPath('MERGE_HEAD')).toBe('refs')
    expect(classifyGitMetadataPath('index')).toBe('working')
    expect(classifyGitMetadataPath('index.lock')).toBeNull()
    expect(classifyGitMetadataPath('HEAD.lock')).toBeNull()
    expect(classifyGitMetadataPath('objects/ab/1234')).toBeNull()
    expect(classifyGitMetadataPath('logs/HEAD')).toBeNull()

    expect(shouldIgnoreWorkingTreePath('.git/index')).toBe(true)
    expect(shouldIgnoreWorkingTreePath('node_modules/antd/index.js')).toBe(true)
    expect(shouldIgnoreWorkingTreePath('src/.README.md.mydsh-1234abcd.tmp')).toBe(true)
    expect(shouldIgnoreWorkingTreePath('.DS_Store')).toBe(true)
    expect(shouldIgnoreWorkingTreePath('src/index.ts')).toBe(false)
    expect(shouldIgnoreWorkingTreePath('pnpm-lock.yaml')).toBe(false)
    expect(shouldIgnoreWorkingTreePath('package-lock.json')).toBe(false)

    expect(
      parseDesktopProjectEvent({
        type: 'git-changed',
        projectId: 'proj-1',
        scope: 'refs',
        reason: 'watcher',
        timestamp: 123,
      }),
    ).toEqual({
      type: 'git-changed',
      projectId: 'proj-1',
      scope: 'refs',
      reason: 'watcher',
      timestamp: 123,
    })
    expect(parseDesktopProjectEvent({ type: 'unknown' })).toBeNull()
    expect(parseDesktopProjectEvent({ type: 'git-changed', projectId: '' })).toBeNull()
  })
})

describe('GitWatcherService 真实仓库监听', () => {
  it('捕获外部提交与文件改动，遇 index.lock 时自动退避并在 worktree 与符号链接下正常工作', async () => {
    const rawRoot = await mkdtemp(join(tmpdir(), 'mydsh-git-watcher-'))
    const root = await realpath(rawRoot)
    const repo = join(root, 'repo')
    const worktree = join(root, 'wt')
    const symlinkRepo = join(root, 'repo-link')
    const watcher = new GitWatcherService({ debounceMs: 60, lockBackoffMs: 80 })
    const events: DesktopProjectEvent[] = []
    watcher.onEvent(event => {
      events.push(event)
    })

    try {
      runGit(root, ['init', 'repo'])
      await writeFile(join(repo, 'README.md'), 'initial\n')
      runGit(repo, ['add', 'README.md'])
      runGit(repo, ['commit', '-m', 'init'])
      runGit(repo, ['worktree', 'add', '-b', 'wt-branch', worktree])
      await symlink(repo, symlinkRepo, process.platform === 'win32' ? 'junction' : 'dir')

      watcher.syncProjects([
        { id: 'proj-main', cwd: repo },
        { id: 'proj-wt', cwd: worktree },
      ])
      // 等待异步 git rev-parse 与 FSWatcher 挂接完成。
      await new Promise(resolve => setTimeout(resolve, 200))

      // 1. 工作区外部写文件应发出 working 事件。
      await writeFile(join(repo, 'README.md'), 'edited-externally\n')
      const workingEvent = await waitForEvent(
        events,
        event => event.projectId === 'proj-main' && event.reason === 'watcher',
      )
      expect(['working', 'refs']).toContain(workingEvent.scope)

      // 2. 外部软件执行 git commit 应发出 refs 事件，触发提交图与摘要更新。
      events.length = 0
      runGit(repo, ['add', 'README.md'])
      runGit(repo, ['commit', '-m', 'external commit'])
      const commitEvent = await waitForEvent(
        events,
        event => event.projectId === 'proj-main' && event.scope === 'refs',
      )
      expect(commitEvent.reason).toBe('watcher')

      // 3. Git worktree 中发生外部提交同样能收到 refs 事件。
      events.length = 0
      await writeFile(join(worktree, 'wt.txt'), 'from-worktree\n')
      runGit(worktree, ['add', 'wt.txt'])
      runGit(worktree, ['commit', '-m', 'worktree commit'])
      const wtEvent = await waitForEvent(
        events,
        event => event.projectId === 'proj-wt' && event.scope === 'refs',
      )
      expect(wtEvent.scope).toBe('refs')

      // 4. index.lock 存在期间推迟广播，释放后立刻送达。
      events.length = 0
      const lockPath = join(repo, '.git', 'index.lock')
      await writeFile(lockPath, 'locked\n')
      watcher.notifyWorkingChange('proj-main')
      await new Promise(resolve => setTimeout(resolve, 140))
      expect(events).toHaveLength(0)
      await rm(lockPath, { force: true })
      const afterUnlock = await waitForEvent(
        events,
        event => event.projectId === 'proj-main' && event.reason === 'editor-save',
      )
      expect(afterUnlock.scope).toBe('working')

      // 5. notifyAgentTurn 传入符号链接目录也能匹配真实规范项目并触发 refs 刷新。
      events.length = 0
      watcher.notifyAgentTurn(symlinkRepo)
      const turnEvent = await waitForEvent(
        events,
        event => event.projectId === 'proj-main' && event.reason === 'agent-turn',
      )
      expect(turnEvent.scope).toBe('refs')

      // 6. dispose 后不再发出任何事件。
      watcher.dispose()
      events.length = 0
      watcher.notifyWorkingChange('proj-main')
      await new Promise(resolve => setTimeout(resolve, 120))
      expect(events).toHaveLength(0)
    } finally {
      watcher.dispose()
      await rm(rawRoot, { recursive: true, force: true })
    }
  })
})
