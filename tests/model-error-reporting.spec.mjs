import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import {
  BlockAssembler,
  LlmAdapter,
  LlmError,
  LlmRuntime,
  createUserMessage,
} from '../packages/llm/llm/lib/index.js'
import { ChatGPTAdapter, PROVIDER } from '../packages/llm/llm-chatgpt/lib/index.js'
import { mapStopReason } from '../packages/llm/llm-pi-ai/lib/stream.js'
import { projectConversation } from '../src/shared/session-projection.ts'

const model = { id: '错误验收', name: '错误验收', contextWindow: 128000, reasoningEfforts: [] }
const messages = [
  createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '继续检查' }] }),
]
async function visibleFailure(ctx, provider) {
  const result = new BlockAssembler()
  for await (const chunk of ctx.llm.stream({ provider, model: model.id, messages }))
    result.push(chunk)
  expect(result.finish.kind).toBe('error')
  return projectConversation([
    {
      type: 'turn/end',
      seq: 1,
      time: 1,
      data: { turn: 1, reason: { kind: 'error', error: result.finish.failure } },
    },
  ])[0]
}
class OrdinaryAdapter extends LlmAdapter {
  error
  async resolveModel(provider, id) {
    return { provider, id, name: id, context: { contextWindow: 128000 } }
  }
  async *stream() {
    if (this.error) throw this.error
    yield {
      type: 'finish',
      reason: mapStopReason({
        stopReason: 'error',
        content: [],
        errorMessage: 'HTTP 502：上游模型暂不可用，api_key=ordinary-secret',
        usage: { input: 0, output: 0, totalTokens: 0 },
      }),
    }
  }
}

it('订阅与普通提供商的错误原文到达会话错误卡片，保留状态和请求标识并隐藏凭据', async () => {
  const ctx = new Context()
  const adapter = new ChatGPTAdapter({
    models: () => [model],
    credential: async () => ({ accountId: 'fixture', accessToken: 'subscription-secret' }),
    fetch: async () =>
      Response.json(
        {
          error: { code: 'server_is_overloaded', message: '所选模型暂时满载：subscription-secret' },
        },
        { status: 503, headers: { 'x-request-id': 'request-fixture' } },
      ),
  })
  try {
    await ctx.plugin(LlmRuntime).await()
    ctx.llm.registerAdapter([PROVIDER], adapter)
    ctx.llm.registerAdapter(['ordinary'], new OrdinaryAdapter())
    const subscription = await visibleFailure(ctx, PROVIDER)
    expect(subscription).toMatchObject({ type: 'error', code: 'server_is_overloaded' })
    expect(subscription.message).toContain('所选模型暂时满载')
    expect(subscription.message).toContain('HTTP 503')
    expect(subscription.message).toContain('request-fixture')
    expect(subscription.message).not.toContain('subscription-secret')
    const ordinary = await visibleFailure(ctx, 'ordinary')
    expect(ordinary).toMatchObject({ code: 'SERVER' })
    expect(ordinary.message).toContain('HTTP 502：上游模型暂不可用')
    expect(ordinary.message).not.toContain('ordinary-secret')
  } finally {
    adapter.dispose()
    await ctx.fiber.dispose()
  }
})

it('连接失败保留底层原因和错误码，普通提供商的包装异常也不丢失 cause', async () => {
  const ctx = new Context(),
    ordinary = new OrdinaryAdapter()
  const cause = Object.assign(new Error('连接被对端重置'), { code: 'ECONNRESET' })
  let transportCause = cause
  ordinary.error = new LlmError('模型请求失败', 'TRANSPORT', { cause })
  const adapter = new ChatGPTAdapter({
    models: () => [model],
    credential: async () => ({ accountId: 'fixture', accessToken: 'subscription-secret' }),
    fetch: async () => {
      throw new TypeError('fetch failed; Bearer subscription-secret', { cause: transportCause })
    },
  })
  try {
    await ctx.plugin(LlmRuntime).await()
    ctx.llm.registerAdapter([PROVIDER], adapter)
    ctx.llm.registerAdapter(['ordinary'], ordinary)
    const subscription = await visibleFailure(ctx, PROVIDER)
    expect(subscription.message).toContain('连接被对端重置 (ECONNRESET)')
    expect(subscription.message).not.toContain('subscription-secret')
    expect(subscription.message).toContain('发送请求或等待响应失败')
    expect(subscription.code).toBe('NETWORK')
    transportCause = Object.assign(new Error('证书主机名不匹配'), {
      code: 'ERR_TLS_CERT_ALTNAME_INVALID',
    })
    const certificate = await visibleFailure(ctx, PROVIDER)
    expect(certificate.code).toBe('REQUEST_FAILED')
    expect(adapter.providerRetryPolicy().retryableCodes).not.toContain(certificate.code)
    const result = await visibleFailure(ctx, 'ordinary')
    expect(result).toMatchObject({
      code: 'TRANSPORT',
      message: '模型请求失败: 连接被对端重置 (ECONNRESET)',
    })
  } finally {
    adapter.dispose()
    await ctx.fiber.dispose()
  }
})
