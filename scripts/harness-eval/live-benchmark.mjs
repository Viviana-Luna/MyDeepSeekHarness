/**
 * 真实大模型端到端调度基准评测器：在隔离临时工作区中驱动指定模型与预设完成黄金评测任务集，并用确定性断言打分。
 * 仅在显式传入 `--live` 时运行；只读读取本地模型配置，所有临时会话与工作区在退出时清理。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { bootRealRosterForEval } from './offline-eval.mjs'
import { resolveWorkspaceModuleUrl } from './workspace-resolver.mjs'

/** 标准黄金评测任务集：覆盖多文件定位修复与二级 CLI 渐进披露探测。 */
export const GOLDEN_EVAL_TASKS = [
  {
    id: 'bugfix-pagination',
    title: '多文件分页边界缺陷定位与修复',
    prompt:
      '工作区 src/paginate.mjs 存在第 2 页偏移量计算错误，导致 npm test 失败。请修复源码并运行 node --test 验证通过，不要修改测试文件。',
    async setup(workspace) {
      await mkdir(join(workspace, 'src'), { recursive: true })
      await mkdir(join(workspace, 'test'), { recursive: true })
      await writeFile(
        join(workspace, 'package.json'),
        JSON.stringify({
          name: 'eval-pagination',
          type: 'module',
          scripts: { test: 'node --test' },
        }),
      )
      await writeFile(
        join(workspace, 'src/paginate.mjs'),
        'export function slicePage(items, page, pageSize) {\n  const start = page * pageSize\n  return items.slice(start, start + pageSize)\n}\n',
      )
      await writeFile(
        join(workspace, 'test/paginate.test.mjs'),
        "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { slicePage } from '../src/paginate.mjs'\ntest('1-based pages', () => {\n  assert.deepEqual(slicePage([1, 2, 3, 4, 5], 1, 2), [1, 2])\n  assert.deepEqual(slicePage([1, 2, 3, 4, 5], 2, 2), [3, 4])\n})\n",
      )
    },
    async verify(workspace) {
      const moduleUrl = `${pathToFileURL(join(workspace, 'src/paginate.mjs')).href}?t=${Date.now()}`
      const mod = await import(/* @vite-ignore */ moduleUrl)
      const first = mod.slicePage([10, 20, 30, 40], 1, 2)
      const second = mod.slicePage([10, 20, 30, 40], 2, 2)
      return JSON.stringify(first) === '[10,20]' && JSON.stringify(second) === '[30,40]'
    },
  },
  {
    id: 'cli-progressive-discovery',
    title: '二级 mydsh CLI 渐进式发现与宿主自省查询',
    presets: ['standard', 'gpt-coding'],
    prompt:
      '请通过 Shell 运行 `mydsh` 二级命令行工具，查看 plugin 领域的帮助说明，调用 `inspect-list` 查询当前宿主公开的 Cordis Inspect Provider ID 列表，并将全部 provider id 按字母排序后以 JSON 数组写入 providers.json 文件。',
    async setup() {},
    async verify(workspace, ctx) {
      const raw = await readFile(join(workspace, 'providers.json'), 'utf8').catch(() => '')
      if (!raw) return false
      const parsed = JSON.parse(raw)
      const expected = ctx.cordisInspect
        .list()
        .map(item => item.id)
        .toSorted()
      return Array.isArray(parsed) && JSON.stringify(parsed.toSorted()) === JSON.stringify(expected)
    },
  },
]

/**
 * 基于真实 `roster.json` 启动 `--live` 基准测试宿主，保留全部预设依赖服务并隔离会话数据到 `tempRoot`。
 */
export async function createLiveEvalHost(tempRoot, mydshHome) {
  const { ctx } = await bootRealRosterForEval(tempRoot, {
    settingsPath: join(mydshHome, 'config/settings.yaml'),
    credentialsPath: join(mydshHome, 'config/credentials.yaml'),
    includeUserRoot: false,
    mountFixtures: false,
  })
  return ctx
}

function summarizeSessionEvents(events) {
  let toolCalls = 0
  let toolErrors = 0
  let inputTokens = 0
  let outputTokens = 0
  for (const record of events) {
    if (record.type === 'tool/result') {
      toolCalls += 1
      if (record.data?.isError) toolErrors += 1
    }
    if (record.type === 'llm/usage' && record.data?.usage) {
      inputTokens += Number(record.data.usage.inputTokens ?? 0)
      outputTokens += Number(record.data.usage.outputTokens ?? 0)
    }
  }
  return { toolCalls, toolErrors, inputTokens, outputTokens }
}

async function runSingleLiveTask({ mydshHome, provider, model, presetId, task }) {
  const workspace = await mkdtemp(join(tmpdir(), `mydsh-live-${presetId}-`))
  let ctx
  const startedAt = Date.now()
  try {
    const { createUserMessage } = await import(
      /* @vite-ignore */ resolveWorkspaceModuleUrl('@deepseek-ai/dsh-llm')
    )
    await task.setup(workspace)
    ctx = await createLiveEvalHost(workspace, mydshHome)
    const handle = await ctx.agents.create({
      sessionId: `eval-${presetId}-${task.id}`,
      agentOptions: { provider, model },
      meta: { cwd: workspace, agentPreset: presetId },
      setup: async agentCtx => {
        await ctx.agentPresets.mount(agentCtx, presetId)
      },
    })
    try {
      await handle.agent.prompt(
        createUserMessage({
          content: [{ type: 'text', text: task.prompt }],
          source: { kind: 'user' },
        }),
        { signal: AbortSignal.timeout(180_000) },
      )
      const passed = await task.verify(workspace, ctx)
      const events =
        typeof handle.agent.session.snapshotEvents === 'function'
          ? handle.agent.session.snapshotEvents()
          : (handle.agent.session.events ?? [])
      const stats = summarizeSessionEvents(events)
      return {
        presetId,
        taskId: task.id,
        passed,
        durationMs: Date.now() - startedAt,
        ...stats,
      }
    } finally {
      await handle.dispose()
    }
  } catch (error) {
    return {
      presetId,
      taskId: task.id,
      passed: false,
      durationMs: Date.now() - startedAt,
      toolCalls: 0,
      toolErrors: 1,
      inputTokens: 0,
      outputTokens: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    if (ctx) await Promise.resolve(ctx.fiber.dispose()).catch(() => undefined)
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * 运行真实大模型端到端评测对比，按预设与任务返回通过率、工具步数、错误次数与 Token 消耗。
 */
export async function runLiveHarnessBenchmark(options) {
  const mydshHome = options.mydshHome ?? process.env.MYDSH_HOME ?? join(homedir(), '.mydsh')
  const presets = options.presets ?? ['standard', 'minimal', 'gpt-coding']
  const results = []
  for (const presetId of presets) {
    for (const task of GOLDEN_EVAL_TASKS) {
      if (task.presets && !task.presets.includes(presetId)) continue
      // oxlint-disable-next-line no-await-in-loop -- 避免并发压测同一模型账号触发速率限制。
      const outcome = await runSingleLiveTask({
        mydshHome,
        provider: options.provider,
        model: options.model,
        presetId,
        task,
      })
      results.push(outcome)
    }
  }
  return {
    provider: options.provider,
    model: options.model,
    results,
  }
}
