/** 使用隔离 Git 仓库验证 AI 分析采样不会改变用户索引。 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { captureGitAiChanges } from '../src/runtime/workspace/git-ai-changes.ts'
import { captureGitAiSnapshot } from '../src/runtime/workspace/git-ai-snapshot.ts'
import { runGitAiTest } from './git-ai-fixture.ts'
import { ProjectAccessRegistry } from '../src/runtime/workspace/project-service.ts'

const roots: string[] = []
const all = { staged: true, working: true, untracked: true }
const capture = async (registry: ProjectAccessRegistry, id: string, scope = all) =>
  captureGitAiChanges(
    await captureGitAiSnapshot(
      registry.resolveProjectDirectory(id),
      scope,
      runGitAiTest,
      new AbortController().signal,
    ),
  )

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

async function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'mydsh-git-ai-'))
  roots.push(cwd)
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', '测试用户')
  git('config', 'user.email', 'test@example.invalid')
  writeFileSync(join(cwd, 'tracked.txt'), '初始\n')
  writeFileSync(join(cwd, '.gitignore'), 'ignored.txt\n')
  git('add', '.')
  git('commit', '-qm', '初始提交')
  const registry = new ProjectAccessRegistry()
  const project = (await registry.replaceFromSessionList({ items: [{ cwd }] }))[0]
  if (!project) throw new Error('测试项目没有注册')
  return { cwd, git, registry, project }
}

describe('AI 提交变更采样', () => {
  it('分别读取部分暂存、未暂存和新文件，不改变索引且不读取忽略文件', async () => {
    const { cwd, git, registry, project } = await fixture()
    writeFileSync(join(cwd, 'tracked.txt'), '已暂存\n')
    git('add', 'tracked.txt')
    writeFileSync(join(cwd, 'tracked.txt'), '未暂存\n')
    writeFileSync(join(cwd, 'new.txt'), '新文件\n')
    writeFileSync(join(cwd, 'ignored.txt'), '不应发送\n')
    const index = readFileSync(join(cwd, '.git', 'index'))
    const result = await capture(registry, project.id, all)
    expect(result.items.map(item => [item.relativePath, item.mode])).toEqual([
      ['tracked.txt', 'working'],
      ['new.txt', 'working'],
    ])
    expect(result.items[0]?.patch).toContain('+未暂存')
    expect(result.items[0]?.requiresWholeFile).toBe(true)
    expect(result.items[1]?.patch).toContain('+新文件')
    expect(new Set(result.items.map(item => item.id)).size).toBe(2)
    expect(JSON.stringify(result)).not.toContain('不应发送')
    expect(result.excluded).toEqual([])
    expect(readFileSync(join(cwd, '.git', 'index')).equals(index)).toBe(true)
  })

  it('只采集选中的类别并明确报告无法分析的二进制文件', async () => {
    const { cwd, git, registry, project } = await fixture()
    writeFileSync(join(cwd, 'tracked.txt'), '暂存内容\n')
    git('add', 'tracked.txt')
    writeFileSync(join(cwd, 'new.bin'), Buffer.from([0, 1, 2, 3]))
    const result = await capture(registry, project.id, {
      staged: false,
      working: false,
      untracked: true,
    })
    expect(result.items).toEqual([])
    expect(result.excluded).toEqual([
      expect.objectContaining({ relativePath: 'new.bin', mode: 'working' }),
    ])
  })

  it('子目录项目不读取项目外变更，并明确排除跨边界重命名', async () => {
    const { cwd, git, registry } = await fixture()
    mkdirSync(join(cwd, 'sub'))
    git('mv', 'tracked.txt', 'sub/renamed.txt')
    writeFileSync(join(cwd, 'outside.txt'), '项目外内容\n')
    writeFileSync(join(cwd, 'sub', 'inside.txt'), '项目内内容\n')
    const project = (
      await registry.replaceFromSessionList({ items: [{ cwd: join(cwd, 'sub') }] })
    )[0]
    if (!project) throw new Error('测试子项目没有注册')
    const result = await capture(registry, project.id, all)
    expect(result.items.map(item => item.relativePath)).toEqual(['inside.txt'])
    expect(result.excluded).toEqual([
      expect.objectContaining({
        relativePath: 'renamed.txt',
        reason: '重命名（含跨项目移动）需要手动处理',
      }),
    ])
    expect(JSON.stringify(result)).not.toContain('项目外内容')
  })

  it('拒绝超预算的差异和未授权项目', async () => {
    const { cwd, registry, project } = await fixture()
    writeFileSync(join(cwd, 'large.txt'), 'a'.repeat(280 * 1024))
    await expect(capture(registry, project.id, all)).rejects.toThrow('超过大小上限 256 KiB')
    await expect(capture(registry, '不属于项目的标识', all)).rejects.toThrow(
      '项目不在当前 MyDSH 工作区范围内',
    )
  })

  it('完整大文件的写入快照不占用模型差异预算，真实索引保持不变', async () => {
    const { cwd, git, registry, project } = await fixture()
    const original = '保留的原始行\n'.repeat(30_000)
    writeFileSync(join(cwd, 'tracked.txt'), original)
    git('add', 'tracked.txt')
    git('commit', '-qm', '较大的基线文件')
    writeFileSync(join(cwd, 'tracked.txt'), `${original}新增一行\n`)
    const index = readFileSync(join(cwd, '.git/index'))
    const result = await capture(registry, project.id)
    expect(result.items).toHaveLength(1)
    expect(Buffer.byteLength(JSON.stringify(result.items))).toBeLessThan(4096)
    expect(result.items[0]?.patch).toContain('+新增一行')
    expect(readFileSync(join(cwd, '.git/index')).equals(index)).toBe(true)
  })

  it('正常多文件规模的差异可超过旧 128 KiB 门槛，但不会截断内容', async () => {
    const { cwd, registry, project } = await fixture()
    const text = `${'a'.repeat(160 * 1024)}末尾标记\n`
    writeFileSync(join(cwd, 'new.txt'), text)
    const result = await capture(registry, project.id)
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.patch).toContain(`+${text}`)
    expect(result.excluded).toEqual([])
  })

  it('本地快照达到独立内存上限即停止采样，不继续读取剩余文件', async () => {
    const { cwd } = await fixture()
    for (let i = 0; i < 9; i++) writeFileSync(join(cwd, `large-${i}.txt`), 'a'.repeat(1024 * 1024))
    let diffs = 0
    await expect(
      captureGitAiSnapshot(
        cwd,
        all,
        async command => {
          if (command.args[0] === 'diff') diffs++
          return runGitAiTest(command)
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('本地提交快照超过 16 MiB')
    expect(diffs).toBeLessThan(9)
  })

  it('单文件读取失败也不把原始子进程错误放进排除原因', async () => {
    const { cwd } = await fixture()
    writeFileSync(join(cwd, 'tracked.txt'), '已修改\n')
    const snapshot = await captureGitAiSnapshot(
      cwd,
      all,
      async command => {
        if (command.args[0] === 'diff') throw new Error('原始异常带有私有配置')
        return runGitAiTest(command)
      },
      new AbortController().signal,
    )
    expect(snapshot.items).toHaveLength(0)
    expect(snapshot.excluded[0]?.reason).toBe(
      '无法读取此文件的 Git 差异，请检查访问权限与 Git 配置后手动处理',
    )
  })
})
