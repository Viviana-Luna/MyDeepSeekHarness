import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitReviewService } from '../src/runtime/workspace/git-review-service.ts'
const roots: string[] = []
const services: GitReviewService[] = []
afterEach(() => {
  services.splice(0).forEach(service => {
    service.dispose()
  })
  roots.splice(0).forEach(path => {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mydsh-git-review-'))
  roots.push(root)
  const cwd = join(root, 'project')
  mkdirSync(cwd)
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', '验收')
  git('config', 'user.email', 'verify@example.invalid')
  writeFileSync(join(cwd, 'file.txt'), '初始内容\n')
  writeFileSync(join(cwd, '.gitignore'), 'ignored.txt\n')
  git('add', '.')
  git('commit', '-qm', '初始提交')
  const cache = join(root, 'cache')
  const service = new GitReviewService(cache)
  services.push(service)
  return { root, cwd, git, service, cache }
}
describe('Git 审阅范围', () => {
  it('轮次快照保留已有脏改动、识别本轮增删，重启后可读且不改变用户索引', async () => {
    const { cwd, git, service, cache } = fixture()
    writeFileSync(join(cwd, 'file.txt'), '开始前的修改\n')
    git('add', 'file.txt')
    writeFileSync(join(cwd, 'ignored.txt'), '不应进入快照')
    const index = readFileSync(join(cwd, '.git', 'index'))
    await service.begin(cwd, '会话', 3)
    writeFileSync(join(cwd, 'file.txt'), '本轮的新修改\n')
    writeFileSync(join(cwd, 'new.txt'), '新文件\n')
    await service.begin(cwd, '会话', 3)
    await service.end(cwd, '会话', 3)
    expect(readFileSync(join(cwd, '.git', 'index')).equals(index)).toBe(true)
    const restored = new GitReviewService(cache)
    services.push(restored)
    const result = await restored.review(cwd, { comparison: 'turn', sessionId: '会话' })
    expect(result.kind).toBe('git-review')
    if (result.kind !== 'git-review') throw new Error('未返回审阅列表')
    expect(result.files.map(file => file.relativePath)).toEqual(['file.txt', 'new.txt'])
    const diff = await restored.review(cwd, {
      comparison: 'turn',
      sessionId: '会话',
      reviewId: result.reviewId,
      relativePath: 'file.txt',
    })
    expect(diff).toMatchObject({ mode: 'review', patch: expect.stringContaining('-开始前的修改') })
    expect(diff).toMatchObject({ patch: expect.stringContaining('+本轮的新修改') })
    await expect(
      restored.review(cwd, {
        comparison: 'turn',
        sessionId: '会话',
        reviewId: '过期',
        relativePath: 'file.txt',
      }),
    ).rejects.toThrow('比较范围已更新')
  }, 30_000)
  it('分支对比使用共同祖先，隔离子项目路径并拒绝伪造引用与越界文件', async () => {
    const { cwd, git, service } = fixture()
    git('checkout', '-qb', 'feature')
    writeFileSync(join(cwd, 'file.txt'), '分支改动\n')
    git('commit', '-qam', '功能提交')
    writeFileSync(join(cwd, 'file.txt'), '未提交的改动\n')
    const branches = await service.branches(cwd)
    expect(branches.branches).toContain('main')
    const result = await service.review(cwd, { comparison: 'branch', baseRef: 'main' })
    if (result.kind !== 'git-review') throw new Error('未返回审阅列表')
    const diff = await service.review(cwd, {
      comparison: 'branch',
      baseRef: 'main',
      reviewId: result.reviewId,
      relativePath: 'file.txt',
    })
    expect(diff).toMatchObject({ patch: expect.stringContaining('+分支改动') })
    expect(JSON.stringify(diff)).not.toContain('+未提交的改动')
    await expect(
      service.review(cwd, { comparison: 'branch', baseRef: '--output=bad' }),
    ).rejects.toThrow('有效的比较分支')
    await expect(
      service.review(cwd, {
        comparison: 'branch',
        baseRef: 'main',
        reviewId: result.reviewId,
        relativePath: '../secret',
      }),
    ).rejects.toThrow('路径无效')
    expect(await service.review(cwd, { comparison: 'turn', sessionId: '旧会话' })).toMatchObject({
      available: false,
      files: [],
    })
  }, 30_000)
  it('快照失败与服务退出都明确不可用，不会阻断轮次结束', async () => {
    const { service, root, cwd } = fixture()
    const outside = join(root, '非仓库')
    mkdirSync(outside)
    await service.begin(outside, '会话', 1)
    await service.end(outside, '会话', 1)
    expect(await service.review(outside, { comparison: 'turn', sessionId: '会话' })).toMatchObject({
      available: false,
    })
    service.dispose()
    await expect(service.branches(cwd)).rejects.toThrow('已停止')
  })
})
