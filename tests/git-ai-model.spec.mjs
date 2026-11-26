/** 使用隔离仓库和模型桩验证 AI 提交分析不会执行 Git 写操作。 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { analyzeGitChanges } from '../packages/desktop-services/src/git-ai-model.ts'
import { responseChunks } from '../packages/llm/llm-chatgpt/src/responses.ts'
import { ProjectAccessRegistry } from '../src/runtime/workspace/project-service.ts'
import { runGitAiTest } from './git-ai-fixture.ts'

const roots = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

async function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'mydsh-git-ai-model-'))
  roots.push(cwd)
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', '测试用户')
  git('config', 'user.email', 'test@example.invalid')
  writeFileSync(join(cwd, 'a.txt'), '初始\n')
  git('add', '.')
  git('commit', '-qm', '初始提交')
  writeFileSync(join(cwd, 'a.txt'), '已修改\n')
  const registry = new ProjectAccessRegistry()
  const project = (await registry.replaceFromSessionList({ items: [{ cwd }] }))[0]
  if (!project) throw new Error('测试项目没有注册')
  return {
    cwd,
    registry,
    request: {
      projectId: project.id,
      scope: { staged: true, working: true, untracked: true },
      provider: 'fixture',
      model: 'fixture-model',
    },
  }
}

function context(stream) {
  return { stream }
}
function analysisOptions(signal = new AbortController().signal) {
  return { signal, run: runGitAiTest, retain() {} }
}

async function* unfinishedStream() {
  yield { type: 'text-delta', index: 0, text: '{}' }
}

async function* authorizationFailureStream() {
  yield {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        code: 'AUTH',
        status: 401,
        message: '私有响应 Bearer fixture-token',
        requestId: '敏感标识',
      },
    },
  }
}

async function* invalidPlanStream() {
  yield { type: 'text-delta', index: 0, text: '不能公开的无效输出' }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function planText(options) {
  const input = JSON.parse(options.messages[0].content[0].text)
  return JSON.stringify({
    batches: [{ message: '更新文件', itemIds: [input.changes[0].id] }],
    deferred: [],
  })
}

function chatgptResponse(answer, reasoning, cancel) {
  const items = [
    { type: 'reasoning', id: 'reasoning-fixture', ...reasoning },
    {
      type: 'message',
      id: 'message-fixture',
      role: 'assistant',
      content: [{ type: 'output_text', text: answer }],
    },
  ]
  const events = items.flatMap((item, output_index) => [
    { type: 'response.output_item.added', output_index, item },
    {
      type:
        item.type === 'message'
          ? 'response.output_text.delta'
          : 'response.reasoning_summary_text.delta',
      output_index,
      item_id: item.id,
      delta: item.type === 'message' ? answer : (item.summary[0]?.text ?? ''),
    },
    { type: 'response.output_item.done', output_index, item },
  ])
  events.push({ type: 'response.completed', response: { status: 'completed', output: items } })
  const bytes = new TextEncoder().encode(
    events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
  )
  let offset = 0
  // 保持连接开启，验证成功和提前失败都会主动取消底层读取。
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return
      controller.enqueue(bytes.slice(offset, (offset += 4096)))
    },
    cancel,
  })
}

describe('AI 提交模型分析', () => {
  it('使用无工具请求读取变更，校验方案且不返回补丁', async () => {
    const { cwd, registry, request } = await fixture()
    const index = readFileSync(join(cwd, '.git', 'index'))
    const stream = vi.fn(async function* (options) {
      const content = options.messages[0]?.content[0]
      if (!content || content.type !== 'text') throw new Error('缺少模型输入')
      const input = JSON.parse(content.text)
      yield {
        type: 'text-delta',
        index: 0,
        text: JSON.stringify({
          batches: [{ message: '更新文件', itemIds: [input.changes[0]?.id] }],
          deferred: [],
        }),
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const result = await analyzeGitChanges(context(stream), registry, request, analysisOptions())
    expect(stream).toHaveBeenCalledOnce()
    expect(stream.mock.calls[0]?.[0].tools).toEqual([])
    expect(result.plan.batches[0]?.message).toBe('更新文件')
    expect(result.items[0]?.relativePath).toBe('a.txt')
    expect(JSON.stringify(result)).not.toContain('已修改')
    expect(readFileSync(join(cwd, '.git', 'index')).equals(index)).toBe(true)
  })

  it('模型调用期间文件变化时丢弃方案', async () => {
    const { cwd, registry, request } = await fixture()
    const stream = async function* (options) {
      const content = options.messages[0]?.content[0]
      if (!content || content.type !== 'text') throw new Error('缺少模型输入')
      const input = JSON.parse(content.text)
      writeFileSync(join(cwd, 'a.txt'), '新内容\n')
      yield {
        type: 'text-delta',
        index: 0,
        text: JSON.stringify({
          batches: [{ message: '更新', itemIds: [input.changes[0]?.id] }],
          deferred: [],
        }),
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    await expect(
      analyzeGitChanges(context(stream), registry, request, analysisOptions()),
    ).rejects.toThrow('工作区')
  })

  it('拒绝未正常结束的模型流', async () => {
    const { registry, request } = await fixture()
    await expect(
      analyzeGitChanges(context(unfinishedStream), registry, request, analysisOptions()),
    ).rejects.toThrow('缺少结束标记')
  })

  it('请求开始前取消时不调用模型', async () => {
    const { registry, request } = await fixture()
    const stream = vi.fn(unfinishedStream)
    const controller = new AbortController()
    controller.abort()
    await expect(
      analyzeGitChanges(context(stream), registry, request, analysisOptions(controller.signal)),
    ).rejects.toThrow()
    expect(stream).not.toHaveBeenCalled()
  })

  it('读取失败时不发送代码，原始 Git 异常不会进入公开错误', async () => {
    const { registry, request } = await fixture()
    const stream = vi.fn(unfinishedStream)
    const options = analysisOptions()
    options.run = async () => {
      throw new Error('原始 Git 输出中含私有配置')
    }
    await expect(analyzeGitChanges(context(stream), registry, request, options)).rejects.toThrow(
      '读取 Git 变更失败，请检查仓库状态和访问权限；本次未向模型发送内容',
    )
    expect(stream).not.toHaveBeenCalled()
  })

  it('流内授权错误只显示固定分类，不回显提供方正文和请求标识', async () => {
    const { registry, request } = await fixture()
    await expect(
      analyzeGitChanges(context(authorizationFailureStream), registry, request, analysisOptions()),
    ).rejects.toThrow('模型授权不可用，请在模型设置中检查登录或凭据后重试')
  })

  it('模型返回非法方案时提示校验失败，不回显原始方案正文', async () => {
    const { registry, request } = await fixture()
    await expect(
      analyzeGitChanges(context(invalidPlanStream), registry, request, analysisOptions()),
    ).rejects.toThrow('模型返回的提交方案校验失败，请重新分析；未创建任何提交')
  })

  it.each([
    ['私有回放密文', { summary: [], encrypted_content: 'x'.repeat(128 * 1024) }],
    ['推理摘要', { summary: [{ type: 'summary_text', text: '推理'.repeat(32 * 1024) }] }],
  ])('ChatGPT 的%s不计入提交方案预算，并释放响应读取', async (_label, reasoning) => {
    const { cwd, registry, request } = await fixture()
    const index = readFileSync(join(cwd, '.git', 'index'))
    const cancel = vi.fn()
    let body
    const stream = options => {
      body = chatgptResponse(planText(options), reasoning, cancel)
      return responseChunks(body, options.signal, () => {}, 'fixture-account', 'fixture-model')
    }
    const result = await analyzeGitChanges(context(stream), registry, request, analysisOptions())
    expect(result.plan.batches[0].message).toBe('更新文件')
    expect(JSON.stringify(result)).not.toMatch(/encrypted_content|推理|fixture-account/)
    expect(readFileSync(join(cwd, '.git', 'index')).equals(index)).toBe(true)
    expect(cancel).toHaveBeenCalledOnce()
    expect(body.locked).toBe(false)
  })

  it('细粒度分片的协议字段开销不计入方案预算', async () => {
    const { registry, request } = await fixture()
    const stream = async function* (options) {
      const answer = ' '.repeat(4096) + planText(options)
      for (const text of answer) yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const result = await analyzeGitChanges(context(stream), registry, request, analysisOptions())
    expect(result.plan.batches[0].message).toBe('更新文件')
  })

  it('完整文本块替代流式增量，不重复累计同一方案', async () => {
    const { registry, request } = await fixture()
    const stream = async function* (options) {
      const answer = ' '.repeat(40 * 1024) + planText(options)
      yield { type: 'text-delta', index: 0, text: answer }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const result = await analyzeGitChanges(context(stream), registry, request, analysisOptions())
    expect(result.plan.batches[0].message).toBe('更新文件')
  })

  it('结束事件的私有回放不被读取或序列化', async () => {
    const { registry, request } = await fixture()
    const readReplay = vi.fn(() => {
      throw new Error('不应访问私有回放')
    })
    const stream = async function* (options) {
      yield { type: 'text-delta', index: 0, text: planText(options) }
      yield {
        type: 'finish',
        reason: { kind: 'stop' },
        get replayState() {
          return readReplay()
        },
      }
    }
    const result = await analyzeGitChanges(context(stream), registry, request, analysisOptions())
    expect(result.plan.batches[0].message).toBe('更新文件')
    expect(readReplay).not.toHaveBeenCalled()
  })

  it('实际方案文本超限仍中止流、释放读取且不保留方案', async () => {
    const { registry, request } = await fixture()
    const cancel = vi.fn()
    const options = { ...analysisOptions(), retain: vi.fn() }
    let body
    const stream = requestOptions => {
      body = chatgptResponse(' '.repeat(64 * 1024 + 1), { summary: [] }, cancel)
      return responseChunks(
        body,
        requestOptions.signal,
        () => {},
        'fixture-account',
        'fixture-model',
      )
    }
    await expect(analyzeGitChanges(context(stream), registry, request, options)).rejects.toThrow(
      '超过大小上限',
    )
    expect(cancel).toHaveBeenCalledOnce()
    expect(body.locked).toBe(false)
    expect(options.retain).not.toHaveBeenCalled()
  })

  it.each([
    [
      '完整块超限',
      [{ type: 'block-end', index: 0, block: { type: 'text', text: 'x'.repeat(65537) } }],
      '大小上限',
    ],
    ['非法工具', [{ type: 'block-start', index: 0, blockType: 'tool-call' }], '唯一文本方案'],
    [
      '多个文本块',
      [
        { type: 'text-delta', index: 0, text: '{}' },
        { type: 'text-delta', index: 1, text: '{}' },
      ],
      '唯一文本方案',
    ],
    ['截断结束', [{ type: 'finish', reason: { kind: 'max-tokens' } }], '未正常结束'],
    [
      '结束后迟到',
      [
        { type: 'finish', reason: { kind: 'stop' } },
        { type: 'text-delta', index: 0, text: '{}' },
      ],
      '结束后继续',
    ],
  ])('%s时关闭模型迭代器，不保留方案', async (_label, chunks, message) => {
    const { registry, request } = await fixture()
    const cleanup = vi.fn()
    const options = { ...analysisOptions(), retain: vi.fn() }
    const stream = async function* () {
      try {
        yield* chunks
      } finally {
        cleanup()
      }
    }
    await expect(analyzeGitChanges(context(stream), registry, request, options)).rejects.toThrow(
      message,
    )
    expect(cleanup).toHaveBeenCalledOnce()
    expect(options.retain).not.toHaveBeenCalled()
  })

  it('接收推理期间取消时关闭迭代器并丢弃迟到文本', async () => {
    const { registry, request } = await fixture()
    const controller = new AbortController()
    const cleanup = vi.fn()
    const options = { ...analysisOptions(controller.signal), retain: vi.fn() }
    const stream = async function* (requestOptions) {
      try {
        yield { type: 'reasoning-delta', index: 0, text: '推理'.repeat(65536) }
        controller.abort()
        yield { type: 'text-delta', index: 1, text: planText(requestOptions) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } finally {
        cleanup()
      }
    }
    await expect(analyzeGitChanges(context(stream), registry, request, options)).rejects.toThrow()
    expect(cleanup).toHaveBeenCalledOnce()
    expect(options.retain).not.toHaveBeenCalled()
  })
})
