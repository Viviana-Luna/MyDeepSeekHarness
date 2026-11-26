import { zstdDecompressSync } from 'node:zlib'
/* oxlint-disable no-await-in-loop -- 隔离服务按依赖顺序装配，后续动作等待当前轮次结束。 */
import { Context, Service } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import {
  LlmRuntime,
  LlmAdapter,
  LlmError,
  createUserMessage,
} from '../packages/llm/llm/lib/index.js'
import SessionStore from '../packages/core/session/lib/index.js'
import Projections from '../packages/session/session-projection/lib/index.js'
import SystemPrompt from '../packages/core/system-prompt/lib/index.js'
import Tools, { defineTool } from '../packages/core/tools/lib/index.js'
import Agents, { installModelSelection } from '../packages/core/agent/lib/index.js'
import AgentLoop from '../packages/core/agent-loop/lib/index.js'
import TokenMeter from '../packages/llm/token-meter/lib/index.js'
import * as LlmRetry from '../packages/llm/llm-retry/lib/index.js'
import BasicCompaction from '../packages/compaction/compaction-basic/lib/index.js'
import NativeCompaction from '../packages/compaction/compaction-chatgpt/lib/index.js'
import { ChatGPTAdapter, PROVIDER } from '../packages/llm/llm-chatgpt/lib/index.js'

const user = text =>
  createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
const send = async (agent, text) => {
  agent.followup(user(text))
  await agent.whenIdle()
}
const events = agent => agent.session.snapshotEvents()
const ending = agent => events(agent).findLast(event => event.type === 'turn/end').data.reason
const seedLong = agent => {
  for (let index = 0; index < 32; index++)
    agent.session.append('user/message', user(`历史${index}：${'history-'.repeat(60)}`), {
      surfaceOp: 'append',
    })
}

async function harness(Engine, adapter, config = {}, seed, provider = 'fixture') {
  const ctx = new Context()
  for (const plugin of [
    LlmRuntime,
    SessionStore,
    Projections,
    SystemPrompt,
    Tools,
    Agents,
    TokenMeter,
  ])
    await ctx.plugin(plugin).await()
  await ctx.plugin(AgentLoop, { agents: [] }).await()
  if (Engine === NativeCompaction)
    await ctx
      .plugin(context => {
        const service = new Service(context, 'chatgpt')
        service.enableNativeCompaction = () => context.effect(() => () => {})
      })
      .await()
  ctx.llm.registerAdapter([provider], adapter)
  const engine = ctx.plugin(Engine, config)
  await engine.await()
  const handle = await ctx.agentLoop.createAgent(ctx, {
    sessionId: '隔离压缩验收',
    agentOptions: { provider, model: 'fixture-model' },
    ...(seed ? { seed } : {}),
  })
  return { ctx, agent: handle.agent, engine, dispose: () => ctx.fiber.dispose() }
}

class SummaryAdapter extends LlmAdapter {
  calls = []
  failure
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, context: { contextWindow: 1000 } }
  }
  async *stream(options) {
    this.calls.push(options)
    if (options.purpose === 'compaction' && this.failure) throw this.failure
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'text', text: options.purpose ? '保留约束，继续验证。' : '已完成' },
    }
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 10 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('确定性摘要错误停止普通请求，保留输入，恢复日志后不重复相同参数，配置修正后可恢复', async () => {
  const adapter = new SummaryAdapter()
  adapter.failure = new LlmError('不支持输出上限', 'UNSUPPORTED_OPTION')
  let h = await harness(BasicCompaction, adapter)
  try {
    seedLong(h.agent)
    await send(h.agent, '必须保留的新指令')
    expect(ending(h.agent)).toMatchObject({ kind: 'error', error: { code: 'UNSUPPORTED_OPTION' } })
    expect(adapter.calls).toHaveLength(1)
    expect(
      events(h.agent).findLast(event => event.type === 'user/message').data.content[0].text,
    ).toBe('必须保留的新指令')
    const seed = JSON.parse(JSON.stringify(events(h.agent)))
    await h.dispose()
    h = await harness(BasicCompaction, adapter, {}, seed)
    await send(h.agent, '恢复后继续')
    expect(adapter.calls).toHaveLength(1)
    expect(ending(h.agent).error.code).toBe('COMPACTION_BLOCKED')
    await h.engine.dispose()
    await h.ctx.plugin(BasicCompaction, { maxTokens: null }).await()
    adapter.failure = undefined
    await send(h.agent, '配置已修正')
    expect(ending(h.agent).kind).toBe('completed')
    expect(
      adapter.calls.some(call => call.purpose === 'compaction' && call.maxTokens === undefined),
    ).toBe(true)
  } finally {
    await h.dispose()
  }
})

it('临时摘要失败不是永久禁用，等待后可继续；其他提供方自动和手动摘要保留原参数', async () => {
  const adapter = new SummaryAdapter()
  adapter.failure = new LlmError('网络暂时不可用', 'NETWORK')
  const h = await harness(NativeCompaction, adapter)
  try {
    seedLong(h.agent)
    await send(h.agent, '继续')
    expect(adapter.calls).toHaveLength(1)
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 5000)
    adapter.failure = undefined
    await send(h.agent, '连接已恢复')
    expect(ending(h.agent).kind).toBe('completed')
    expect(
      adapter.calls
        .filter(call => call.purpose === 'compaction')
        .every(call => call.maxTokens === 8192),
    ).toBe(true)
    seedLong(h.agent)
    const result = await h.ctx.compaction.compactNow(h.agent, new AbortController().signal)
    expect(result.shadowedSeqs.length).toBeGreaterThan(0)
    expect(adapter.calls.at(-1).maxTokens).toBe(8192)
  } finally {
    vi.restoreAllMocks()
    await h.dispose()
  }
})

it('压缩期间取消仍保存已领取输入，不提交摘要，不继续普通请求', async () => {
  const entered = Promise.withResolvers()
  class Waiting extends BasicCompaction {
    async summarize(_input, _agent, signal) {
      entered.resolve()
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      throw new LlmError('压缩已取消', 'ABORTED')
    }
  }
  const adapter = new SummaryAdapter(),
    h = await harness(Waiting, adapter)
  try {
    seedLong(h.agent)
    h.agent.followup(user('取消后不能丢失'))
    await entered.promise
    h.agent.cancel({ kind: 'user' }, { keepInbox: true })
    await h.agent.whenIdle()
    expect(ending(h.agent).kind).toBe('aborted')
    expect(adapter.calls).toHaveLength(0)
    expect(events(h.agent).some(event => event.type === 'compaction/summary')).toBe(false)
    expect(
      events(h.agent).findLast(event => event.type === 'user/message').data.content[0].text,
    ).toBe('取消后不能丢失')
  } finally {
    await h.dispose()
  }
})

function nativeResponse(compact) {
  const items = [
    ...(compact ? [{ type: 'compaction', id: 'checkpoint', encrypted_content: '隔离密文' }] : []),
    {
      type: 'message',
      id: 'answer',
      role: 'assistant',
      content: [{ type: 'output_text', text: '继续' }],
    },
  ]
  return new Response(
    [
      ...items.flatMap((item, output_index) => [
        { type: 'response.output_item.added', output_index, item },
        { type: 'response.output_item.done', output_index, item },
      ]),
      {
        type: 'response.completed',
        response: {
          status: 'completed',
          output: items,
          usage: { input_tokens: compact ? 395000 : 200, output_tokens: 20 },
        },
      },
    ]
      .map(event => `data: ${JSON.stringify(event)}\n\n`)
      .join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}
function nativeAdapter(fetch) {
  return new ChatGPTAdapter({
    models: () => [
      { id: 'fixture-model', name: '隔离模型', contextWindow: 272000, reasoningEfforts: [] },
    ],
    credential: async () => ({ accountId: 'fixture-account', accessToken: 'fixture-token' }),
    compactionThreshold: () => 217600,
    fetch,
  })
}

it('原生压缩不发通用摘要，恢复后从检查点继续，读数等待新的有效用量', async () => {
  const requests = [],
    adapter = nativeAdapter(async (_url, init) => {
      requests.push(JSON.parse(zstdDecompressSync(init.body).toString()))
      return nativeResponse(requests.length === 1)
    })
  let h = await harness(NativeCompaction, adapter, {}, undefined, PROVIDER)
  try {
    await send(h.agent, 'x'.repeat(1_580_000))
    expect(requests).toHaveLength(1)
    expect(requests[0].context_management).toEqual([
      { type: 'compaction', compact_threshold: 217600 },
    ])
    expect(requests[0]).not.toHaveProperty('max_output_tokens')
    expect(events(h.agent).some(event => event.type === 'compaction/start')).toBe(false)
    expect(h.ctx.sessionProjections.snapshot(h.agent.session).values.contextPressure).toEqual({
      contextWindow: 272000,
      nativeCompaction: true,
      awaitingUsage: true,
    })
    const seed = JSON.parse(JSON.stringify(events(h.agent)))
    await h.dispose()
    h = await harness(NativeCompaction, adapter, {}, seed, PROVIDER)
    expect(
      h.ctx.sessionProjections.snapshot(h.agent.session).values.contextPressure.awaitingUsage,
    ).toBe(true)
    await send(h.agent, '继续核对')
    expect(requests[1].input[0].type).toBe('compaction')
    expect(JSON.stringify(requests[1]).length).toBeLessThan(10000)
    const pressure = h.ctx.sessionProjections.snapshot(h.agent.session).values.contextPressure
    expect(pressure.nativeCompaction).toBe(true)
    expect(pressure.awaitingUsage).toBeUndefined()
    expect(pressure.projectedTokens).toBeLessThan(1000)
    expect(JSON.stringify(events(h.agent))).toContain('x'.repeat(10000))
  } finally {
    await h.dispose()
    adapter.dispose()
  }
})

it('旧版原生检查点没有公开标记时仍隐藏旧读数，失败请求不能更新等待状态', async () => {
  const adapter = nativeAdapter(async () => nativeResponse(true))
  let h = await harness(NativeCompaction, adapter, {}, undefined, PROVIDER)
  try {
    await send(h.agent, '隔离旧日志')
    const seed = JSON.parse(JSON.stringify(events(h.agent)))
    for (const event of seed)
      if (event.type === 'assistant/message') {
        for (const chunk of event.data.stream)
          if (chunk.type === 'finish') delete chunk.contextCompaction
      }
    await h.dispose()
    const unavailable = nativeAdapter(
      async () =>
        new Response(
          'data: {"type":"response.failed","response":{"error":{"code":"server_is_overloaded"},"usage":{"input_tokens":395000,"output_tokens":0}}}\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    )
    h = await harness(NativeCompaction, unavailable, {}, seed, PROVIDER)
    try {
      expect(
        h.ctx.sessionProjections.snapshot(h.agent.session).values.contextPressure.awaitingUsage,
      ).toBe(true)
      await send(h.agent, '暂时不可用')
      const pressure = h.ctx.sessionProjections.snapshot(h.agent.session).values.contextPressure
      expect(pressure).toMatchObject({ awaitingUsage: true, nativeCompaction: true })
      expect(pressure).not.toHaveProperty('projectedTokens')
    } finally {
      unavailable.dispose()
    }
  } finally {
    await h.dispose()
    adapter.dispose()
  }
})

it('服务端过载采用有限重试，持续失败停止，稍后可恢复且不视为参数错误', async () => {
  let overloaded = true
  const fetch = vi.fn(async () =>
    overloaded
      ? new Response(
          'data: {"type":"response.failed","response":{"error":{"code":"server_is_overloaded"}}}\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        )
      : nativeResponse(false),
  )
  const adapter = nativeAdapter(fetch)
  const policy = adapter.providerRetryPolicy()
  expect(policy).toMatchObject({ maxRetries: 5 })
  expect(policy.retryableCodes).toContain('server_is_overloaded')
  // 保留真实分类和次数，只缩短隔离测试中的退避时间。
  adapter.providerRetryPolicy = () => ({
    ...policy,
    initialDelayMs: 1,
    maxDelayMs: 1,
    jitterRatio: 0,
  })
  const h = await harness(NativeCompaction, adapter, {}, undefined, PROVIDER)
  try {
    await h.ctx.plugin(LlmRetry, {}).await()
    await send(h.agent, '保留本轮输入')
    expect(fetch).toHaveBeenCalledTimes(6)
    expect(events(h.agent).filter(event => event.type === 'llm/retry')).toHaveLength(5)
    expect(ending(h.agent).error).toMatchObject({ code: 'server_is_overloaded' })
    expect(ending(h.agent).error.message).toContain('服务端暂时过载')
    overloaded = false
    await send(h.agent, '稍后继续')
    expect(ending(h.agent).kind).toBe('completed')
    expect(fetch).toHaveBeenCalledTimes(7)
  } finally {
    await h.dispose()
    adapter.dispose()
  }
})

it('较长任务在连续断线和未完成工具流后恢复，已完成的工具只执行一次', async () => {
  let calls = 0,
    writes = 0
  const call = {
    type: 'function_call',
    namespace: 'mydsh',
    id: 'fc_1',
    call_id: 'call_1',
    name: 'diagnostic_write',
    arguments: '{}',
  }
  const adapter = nativeAdapter(async (_url, init) => {
    const payload = JSON.parse(zstdDecompressSync(init.body).toString())
    expect(new Headers(init.headers).get('content-encoding')).toBe('zstd')
    calls++
    if (calls === 1)
      return new Response(
        [
          { type: 'response.output_item.added', output_index: 0, item: call },
          { type: 'response.output_item.done', output_index: 0, item: call },
          { type: 'response.completed', response: { status: 'completed', output: [call] } },
        ]
          .map(event => `data: ${JSON.stringify(event)}\n\n`)
          .join(''),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    expect(payload.input).toContainEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: '已完成',
    })
    if (calls === 3)
      return new Response(
        `data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { ...call, id: 'fc_incomplete' } })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      )
    if (calls < 5)
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
      })
    return nativeResponse(false)
  })
  const policy = adapter.providerRetryPolicy()
  adapter.providerRetryPolicy = () => ({
    ...policy,
    initialDelayMs: 1,
    maxDelayMs: 1,
    jitterRatio: 0,
  })
  const h = await harness(BasicCompaction, adapter, { maxTokens: null }, undefined, PROVIDER)
  try {
    await h.ctx.plugin(LlmRetry, {}).await()
    h.ctx.tools.register(
      defineTool({
        name: 'diagnostic_write',
        description: '仅增加隔离内存计数',
        parameters: {},
        output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: '已完成' }] },
        async execute() {
          writes++
          return { done: true }
        },
      }),
    )
    seedLong(h.agent)
    await send(h.agent, '执行一次计数，断线恢复后继续完成')
    expect(ending(h.agent).kind).toBe('completed')
    expect({ calls, writes }).toEqual({ calls: 5, writes: 1 })
    expect(
      events(h.agent)
        .filter(event => event.type === 'llm/retry')
        .map(event => event.data.failure.code),
    ).toEqual(['NETWORK', 'STREAM_CLOSED', 'NETWORK'])
  } finally {
    await h.dispose()
    adapter.dispose()
  }
})

it('恢复等待中停止会取消退避，不再发送请求，也不把取消显示为失败', async () => {
  const fetch = vi.fn(async () => {
    throw new TypeError('fetch failed', {
      cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
    })
  })
  const adapter = nativeAdapter(fetch)
  const policy = adapter.providerRetryPolicy()
  adapter.providerRetryPolicy = () => ({ ...policy, initialDelayMs: 30_000, maxDelayMs: 30_000 })
  const h = await harness(BasicCompaction, adapter, { maxTokens: null }, undefined, PROVIDER)
  try {
    await h.ctx.plugin(LlmRetry, {}).await()
    h.ctx.on('session/event', (_session, event) => {
      if (event.type === 'llm/retry')
        queueMicrotask(() => h.agent.cancel({ kind: 'user' }, { keepInbox: true }))
    })
    await send(h.agent, '停止恢复')
    expect(ending(h.agent).kind).toBe('aborted')
    expect(fetch).toHaveBeenCalledOnce()
    expect(events(h.agent).some(event => event.type === 'llm/retry-started')).toBe(false)
  } finally {
    await h.dispose()
    adapter.dispose()
  }
})

it('服务端压缩前拒绝约 395K 输入后安全停止，重开会话也不循环重发或删除历史', async () => {
  const fetch = vi.fn(async () =>
    Response.json({ error: { code: 'context_length_exceeded' } }, { status: 400 }),
  )
  const adapter = nativeAdapter(fetch)
  let h = await harness(NativeCompaction, adapter, {}, undefined, PROVIDER)
  try {
    await send(h.agent, 'x'.repeat(1_580_000))
    expect(ending(h.agent).error.code).toBe('NATIVE_COMPACTION_CONTEXT_EXCEEDED')
    const seed = JSON.parse(JSON.stringify(events(h.agent)))
    await h.dispose()
    h = await harness(NativeCompaction, adapter, {}, seed, PROVIDER)
    await send(h.agent, '不要丢弃结果')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(ending(h.agent).error.message).toContain('未重复发送')
    expect(JSON.stringify(events(h.agent))).toContain('x'.repeat(10000))
  } finally {
    await h.dispose()
    adapter.dispose()
  }
})

it('用户切换提供方后的首步按当前选择分流，切回通用提供方时摘要也使用新目标', async () => {
  const adapter = new SummaryAdapter()
  adapter.resolveModel = async (provider, model) => ({
    provider,
    id: model,
    name: model,
    context: { contextWindow: 10000 },
  })
  const h = await harness(NativeCompaction, adapter)
  const native = nativeAdapter(async () => nativeResponse(true))
  try {
    h.ctx.llm.registerAdapter([PROVIDER], native)
    await send(h.agent, '先使用其他提供方')
    seedLong(h.agent)
    const selection = {
      current: { provider: PROVIDER, model: 'fixture-model' },
      assembled: undefined,
    }
    const disposeSelection = installModelSelection(h.agent.ctx, selection)
    try {
      await send(h.agent, '切换后继续')
      expect(adapter.calls).toHaveLength(1)
      expect(ending(h.agent).kind).toBe('completed')
      selection.current = { provider: 'fixture', model: 'fixture-model' }
      seedLong(h.agent)
      await send(h.agent, '切回其他提供方继续')
      expect(ending(h.agent).kind).toBe('completed')
      expect(adapter.calls.filter(call => call.purpose === 'compaction')).toHaveLength(1)
      expect(adapter.calls.find(call => call.purpose === 'compaction').maxTokens).toBe(8192)
    } finally {
      disposeSelection()
    }
  } finally {
    await h.dispose()
    native.dispose()
  }
})
