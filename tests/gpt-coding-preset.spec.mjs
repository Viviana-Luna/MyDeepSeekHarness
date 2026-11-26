import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { zstdDecompressSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { LlmRuntime, createUserMessage } from '../packages/llm/llm/lib/index.js'
import { BasicCompactionEngine } from '../packages/compaction/compaction-basic/lib/index.js'
import {
  resolveConfig,
  resolveTargetPolicy,
} from '../packages/compaction/compaction-basic/lib/config.js'
import { summarizeWithLlm } from '../packages/compaction/compaction-basic/lib/summarizer.js'
import { ChatGPTAdapter, PROVIDER } from '../packages/llm/llm-chatgpt/lib/index.js'

const { load, DEFAULT_SCHEMA, Type } = createRequire(
  new URL('../packages/preset/agent-presets/package.json', import.meta.url),
)('js-yaml')
// 仅检查装配，不执行预设中的平台条件表达式。
const presetSchema = DEFAULT_SCHEMA.extend([new Type('tag:yaml.org,2002:js', { kind: 'scalar' })])
const model = {
  id: 'fixture-gpt',
  name: '隔离 GPT',
  contextWindow: 128000,
  reasoningEfforts: ['medium', 'high'],
}
const agent = {
  options: { provider: PROVIDER, model: model.id },
  session: { id: 'fixture-session', requestHeader: () => undefined },
}
const input = {
  messages: [
    createUserMessage({
      content: [{ type: 'text', text: '保留公共接口；当前文件已经修改，下一步运行相关检查。' }],
      source: { kind: 'user' },
    }),
  ],
}

it('所有已有压缩预设按提供方分流，其他提供方仍使用原摘要上限', async () => {
  for (const preset of ['standard', 'minimal']) {
    const presetFile = new URL(
      `../packages/preset/agent-presets/presets/${preset}/agent.cordis.yml`,
      import.meta.url,
    )
    // oxlint-disable-next-line no-await-in-loop -- 按预设逐个验证，失败时保留对应路径。
    const rows = load(await readFile(presetFile, 'utf8'), { schema: presetSchema })
    const plugin = rows
      .find(row => row.id === 'compaction')
      .config.find(row => row.id === 'compaction-chatgpt')
    expect(plugin.name).toBe('@mydsh/compaction-chatgpt')
    expect(resolveConfig(plugin.config).maxTokens).toBe(8192)
  }
})

function summaryResponse(text) {
  const item = {
    type: 'message',
    id: 'msg_summary',
    role: 'assistant',
    phase: 'final_answer',
    content: [{ type: 'output_text', text, annotations: [] }],
  }
  const events = [
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        status: 'completed',
        output: [item],
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      },
    },
  ]
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

it('GPT 预设装配独立原生压缩插件，通用摘要仍保留省略硬上限的能力', async () => {
  const rows = load(
    await readFile(
      new URL(
        '../packages/preset/agent-presets/presets/gpt-coding/agent.cordis.yml',
        import.meta.url,
      ),
      'utf8',
    ),
    { schema: presetSchema },
  )
  const plugin = rows
    .find(row => row.id === 'compaction')
    .config.find(row => row.id === 'compaction-chatgpt')
  expect(plugin.name).toBe('@mydsh/compaction-chatgpt')
  const settings = plugin.config
  const config = resolveConfig(BasicCompactionEngine.Config(settings))
  expect(config.maxTokens).toBeNull()
  expect(resolveConfig().maxTokens).toBe(8192)
  const target = { provider: PROVIDER, model: model.id }
  expect(
    resolveTargetPolicy(
      resolveConfig({ maxTokens: 1000, modelPolicies: [{ ...target, maxTokens: null }] }),
      target,
    ).maxTokens,
  ).toBeNull()
  expect(
    resolveTargetPolicy(
      resolveConfig({ maxTokens: null, modelPolicies: [{ ...target, maxTokens: 2048 }] }),
      target,
    ).maxTokens,
  ).toBe(2048)
  const context = new Context(),
    requests = []
  const adapter = new ChatGPTAdapter({
    models: () => [model],
    credential: async () => ({ accountId: 'fixture-account', accessToken: 'fixture-token' }),
    fetch: async (url, options) => {
      expect(url).toBe('https://api.openai.com/v1/responses')
      expect(options.headers['content-encoding']).toBe('zstd')
      requests.push(JSON.parse(zstdDecompressSync(options.body).toString('utf8')))
      return summaryResponse('目标：保留公共接口。现状：文件已修改。下一步：运行相关检查。')
    },
  })
  try {
    await context.plugin(LlmRuntime).await()
    context.llm.registerAdapter([PROVIDER], adapter)
    const result = await summarizeWithLlm(
      context,
      config,
      input,
      agent,
      new AbortController().signal,
    )
    expect(result.summary).toEqual([
      { type: 'text', text: '目标：保留公共接口。现状：文件已修改。下一步：运行相关检查。' },
    ])
    expect(result).not.toHaveProperty('maxTokens')
    expect(requests).toHaveLength(1)
    expect(requests[0]).not.toHaveProperty('max_output_tokens')
    expect(requests[0].input[0].content[0].text).toContain('保留公共接口')
    expect(result.usage.totalTokens).toBe(120)
  } finally {
    adapter.dispose()
    await context.fiber.dispose()
  }
})

it('省略硬上限仍拒绝无效配置和失败摘要，不把失败响应当作可提交的检查点', async () => {
  expect(() => resolveConfig({ maxTokens: 0 })).toThrow('maxTokens')
  const context = new Context()
  const adapter = new ChatGPTAdapter({
    models: () => [model],
    credential: async () => ({ accountId: 'fixture-account', accessToken: 'fixture-token' }),
    fetch: async () =>
      new Response(
        'data: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}}\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  })
  try {
    await context.plugin(LlmRuntime).await()
    context.llm.registerAdapter([PROVIDER], adapter)
    await expect(
      summarizeWithLlm(
        context,
        resolveConfig({ maxTokens: null }),
        input,
        agent,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'subscription_sharing_usage_limit_exceeded' })
  } finally {
    adapter.dispose()
    await context.fiber.dispose()
  }
})
