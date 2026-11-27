/** 通过真实受管 Git 子进程验证后台取消、整文件授权、方案归属与资源清理。 */
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { GitAiService } from '../packages/desktop-services/src/git-ai-service.ts'
import { createGitAiRunner } from '../src/runtime/workspace/git-ai-process.ts'
import { ProjectAccessRegistry } from '../src/runtime/workspace/project-service.ts'

let templateRepo = ''
let sharedContext

beforeAll(async () => {
  templateRepo = mkdtempSync(join(tmpdir(), 'mydsh-ai-template-'))
  const git = (...args) => execFileSync('git', args, { cwd: templateRepo, encoding: 'utf8' })
  git('init', '-qb', 'main')
  git('config', 'user.name', '测试')
  git('config', 'user.email', 'test@example.invalid')
  writeFileSync(join(templateRepo, 'a.txt'), '基线\n')
  git('add', '.')
  git('commit', '-qm', '初始提交')
  writeFileSync(join(templateRepo, 'a.txt'), '暂存\n')
  git('add', '.')
  writeFileSync(join(templateRepo, 'a.txt'), '未暂存\n')
  sharedContext = new Context()
  await sharedContext.plugin(LocalSubprocessRuntime).await()
})

afterAll(async () => {
  await sharedContext?.fiber.dispose()
  if (templateRepo !== '') {
    rmSync(templateRepo, { recursive: true, force: true })
  }
})

const cleanup = []
afterEach(async () => {
  /* oxlint-disable no-await-in-loop -- 清理栈按逆序释放各自工作区与服务。 */
  for (const dispose of cleanup.splice(0).toReversed()) await dispose()
  /* oxlint-enable no-await-in-loop */
})

async function waitForFile(filePath, signal) {
  /* oxlint-disable no-await-in-loop -- 轮询真实 hook 原子落盘文件，避免狂刷 git 子进程抢占句柄。 */
  while (!existsSync(filePath)) {
    signal.throwIfAborted()
    await new Promise(resolve => {
      setTimeout(resolve, 20)
    })
  }
  /* oxlint-enable no-await-in-loop */
}

async function fixture(wrapRun = run => run) {
  const root = mkdtempSync(join(tmpdir(), 'mydsh-ai-service-'))
  cpSync(templateRepo, root, { recursive: true })
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  const registry = new ProjectAccessRegistry()
  const project = (await registry.replaceFromSessionList({ items: [{ cwd: root }] }))[0]
  const llm = {
    async *stream(options) {
      const input = JSON.parse(options.messages[0].content[0].text)
      yield {
        type: 'text-delta',
        index: 0,
        text: JSON.stringify({
          batches: [{ message: '更新文件', itemIds: input.changes.map(item => item.id) }],
          deferred: [],
        }),
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const run = wrapRun(createGitAiRunner(sharedContext.subprocess))
  const service = new GitAiService({ registry, run, llm: () => llm })
  cleanup.push(() => service.dispose())
  const analyze = () =>
    service.call(project.id, 'gitAiAnalyze', {
      id: 'test',
      confirmed: true,
      provider: 'fixture',
      model: 'fixture',
      scope: { staged: true, working: true, untracked: true },
    })
  return { root, git, service, analyze, project, run, llm }
}

describe('AI 提交后台服务', () => {
  it('真实受管执行要求整文件明确确认，完成后丢弃快照', async () => {
    const { root, git, service, analyze, project } = await fixture()
    const result = await analyze()
    const payload = { id: result.id, plan: result.plan, confirmed: true, wholeFileIds: [] }
    await expect(service.call(project.id, 'gitAiExecute', payload)).rejects.toThrow('整文件')
    await expect(
      service.call(project.id, 'gitAiDiff', { id: 'other', itemId: result.items[0].id }),
    ).rejects.toThrow('失效')
    const done = await service.call(project.id, 'gitAiExecute', {
      ...payload,
      wholeFileIds: [result.items[0].id],
    })
    expect(done.error).toBeNull()
    expect(done.completed).toHaveLength(1)
    expect(git('show', 'HEAD:a.txt')).toBe('未暂存\n')
    expect(git('status', '--porcelain')).toBe('')
    await service.call(project.id, 'gitAiRelease', { id: result.id })
    await expect(service.call(project.id, 'gitAiValidate', { id: result.id })).rejects.toThrow(
      '失效',
    )
    expect(
      readdirSync(join(root, '.git')).some(
        name => name.startsWith('mydsh-ai-') || name.endsWith('.lock'),
      ),
    ).toBe(false)
  })

  it.each(['释放方案', '取消调用'])('%s 时等待运行中的 hook 退出并清理锁', async cancellation => {
    const { root, git, service, analyze, project } = await fixture()
    const result = await analyze(),
      head = git('rev-parse', 'HEAD')
    const hook = join(root, '.git/hooks/pre-commit')
    writeFileSync(
      hook,
      [
        '#!/bin/sh',
        // Windows Git Bash 的 $$ 为 MSYS2 虚拟 PID，须优先读取真实 Win32 PID，再经临时文件原子落盘。
        'PID=$$',
        'if [ -r "/proc/$$/winpid" ]; then',
        '  read WINPID < "/proc/$$/winpid"',
        '  if [ -n "$WINPID" ]; then PID=$WINPID; fi',
        'fi',
        'printf \'%s\\n\' "$PID" > "$GIT_WORK_TREE/.git/hook-pid.tmp"',
        'mv "$GIT_WORK_TREE/.git/hook-pid.tmp" "$GIT_WORK_TREE/.git/hook-pid"',
        'sleep 60',
        '',
      ].join('\n'),
    )
    chmodSync(hook, 0o755)
    const controller = new AbortController()
    const executing = service.call(
      project.id,
      'gitAiExecute',
      { id: result.id, plan: result.plan, confirmed: true, wholeFileIds: [result.items[0].id] },
      controller.signal,
    )
    const deadline = AbortSignal.timeout(10_000)
    await waitForFile(join(root, '.git/hook-pid'), deadline)
    const pid = Number(readFileSync(join(root, '.git/hook-pid'), 'utf8').trim())
    expect(Number.isInteger(pid) && pid > 0).toBe(true)
    // 取消前确认读取到的是当前仍在运行的真实 hook 进程，避免误测虚拟 PID 或空文件。
    expect(() => process.kill(pid, 0)).not.toThrow()
    if (cancellation === '释放方案')
      await service.call(project.id, 'gitAiRelease', { id: result.id })
    else controller.abort()
    await expect(executing).resolves.toMatchObject({
      completed: [],
      error: expect.stringContaining('已取消'),
    })
    expect(git('rev-parse', 'HEAD')).toBe(head)
    expect(() => process.kill(pid, 0)).toThrow()
    expect(existsSync(join(root, '.git/index.lock'))).toBe(false)
    expect(existsSync(join(root, '.git/HEAD.lock'))).toBe(false)
  })

  it('提交 hook 失败只返回阶段提示，保留索引和可重试的方案', async () => {
    const { root, git, service, analyze, project } = await fixture()
    const result = await analyze()
    const head = git('rev-parse', 'HEAD')
    const index = readFileSync(join(root, '.git/index'))
    const hook = join(root, '.git/hooks/pre-commit')
    writeFileSync(hook, '#!/bin/sh\necho "Bearer fixture-sensitive-value" >&2\nexit 1\n')
    chmodSync(hook, 0o755)
    const payload = {
      id: result.id,
      plan: result.plan,
      confirmed: true,
      wholeFileIds: [result.items[0].id],
    }
    await expect(service.call(project.id, 'gitAiExecute', payload)).resolves.toEqual({
      completed: [],
      error: 'Git 提交命令失败，请检查 Git hook、签名或仓库配置后重试',
      stale: false,
    })
    expect(git('rev-parse', 'HEAD')).toBe(head)
    expect(readFileSync(join(root, '.git/index'))).toEqual(index)
    expect(existsSync(join(root, '.git/index.lock'))).toBe(false)
    rmSync(hook)
    const retried = await service.call(project.id, 'gitAiExecute', payload)
    expect(retried.error).toBeNull()
    expect(retried.completed).toHaveLength(1)
  })

  it('引用发布期间取消会完成本批索引协调并返回已提交记录', async () => {
    const controller = new AbortController()
    const { root, git, service, analyze, project } = await fixture(run => async command => {
      const result = await run(command)
      if (command.args[0] === 'update-ref') controller.abort()
      return result
    })
    writeFileSync(join(root, 'b.txt'), '留给下一批\n')
    const result = await analyze()
    const first = result.items.find(item => item.relativePath === 'a.txt')
    const second = result.items.find(item => item.relativePath === 'b.txt')
    const completed = await service.call(
      project.id,
      'gitAiExecute',
      {
        id: result.id,
        plan: {
          batches: [
            { message: '第一批', itemIds: [first.id] },
            { message: '第二批', itemIds: [second.id] },
          ],
          deferred: [],
        },
        confirmed: true,
        wholeFileIds: [first.id],
      },
      controller.signal,
    )
    expect(completed.completed).toEqual([
      { message: '第一批', itemIds: [first.id], commitHash: git('rev-parse', 'HEAD').trim() },
    ])
    expect(completed.error).toContain('已取消')
    expect(git('status', '--porcelain')).toBe('?? b.txt\n')
    expect(existsSync(join(root, '.git/index.lock'))).toBe(false)
  })

  it('采样开始前超时不会启动 Git', async () => {
    const { root, run } = await fixture()
    await expect(
      run({ cwd: root, args: ['status'], signal: AbortSignal.abort(new Error('采样超时')) }),
    ).rejects.toThrow('采样超时')
  })

  it('运行时退出后拒绝新请求，不重新创建快照或子进程', async () => {
    const { service, analyze } = await fixture()
    await service.dispose()
    await expect(analyze()).rejects.toThrow('服务已停止')
  })

  it('输入超限显示真实预算且不调用模型，失败清理后可以缩小范围重试', async () => {
    const { root, service, analyze, project, llm } = await fixture()
    const stream = vi.spyOn(llm, 'stream')
    writeFileSync(join(root, 'large.txt'), 'a'.repeat(280 * 1024))
    await expect(analyze()).rejects.toThrow('超过大小上限 256 KiB')
    expect(stream).not.toHaveBeenCalled()
    await expect(service.call(project.id, 'gitAiValidate', { id: 'test' })).rejects.toThrow('失效')
    await expect(service.call(project.id, 'gitAiRelease', { id: 'test' })).resolves.toEqual({
      released: true,
    })
    rmSync(join(root, 'large.txt'))
    expect((await analyze()).items).toHaveLength(1)
    expect(stream).toHaveBeenCalledOnce()
  })

  it('模型异常正文和凭据不透传，安全提示仍明确指出模型调用阶段', async () => {
    const { analyze, llm } = await fixture()
    vi.spyOn(llm, 'stream').mockImplementation(() => {
      throw new Error('Bearer fixture-sensitive-value 代码正文', { cause: new Error('私有凭据') })
    })
    const error = await analyze().catch(value => value)
    expect(error.message).toBe('模型请求失败，请检查所选提供方的连接与授权后重试')
    expect(error.cause).toBeUndefined()
  })

  it('已知仓库状态错误不被改写成模型配置错误', async () => {
    const { root, git, analyze, llm } = await fixture()
    const stream = vi.spyOn(llm, 'stream')
    writeFileSync(join(root, '.git/MERGE_HEAD'), git('rev-parse', 'HEAD'))
    await expect(analyze()).rejects.toThrow('仓库正在合并、变基或拣选')
    expect(stream).not.toHaveBeenCalled()
  })

  it('方案归属于单个已授权项目，跨项目请求立即拒绝', async () => {
    const { analyze, service } = await fixture()
    const result = await analyze()
    await expect(service.call('other-project', 'gitAiValidate', { id: result.id })).rejects.toThrow(
      '项目不在当前 MyDSH 工作区范围内',
    )
  })
})
