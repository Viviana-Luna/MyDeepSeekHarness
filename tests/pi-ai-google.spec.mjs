/**
 * 验证 @deepseek-ai/dsh-llm-pi-ai 升级至 @earendil-works/pi-ai@1.6.0 后的
 * Google Gemini 4 目录、思考等级（含 xhigh 透传）及 Google AI Studio 在线模型发现。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LlmError } from '../packages/llm/llm/lib/index.js'
import { catalogModels, resolveRouteModels } from '../packages/llm/llm-pi-ai/lib/catalog.js'
import { resolveProfiles } from '../packages/llm/llm-pi-ai/lib/config.js'
import { discoverModels } from '../packages/llm/llm-pi-ai/lib/discovery.js'
import { getSupportedThinkingLevels } from '../packages/llm/llm-pi-ai/lib/models.js'
import { buildProvider, supportedProtocols } from '../packages/llm/llm-pi-ai/lib/provider.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('pi-ai 1.6.0 Google Gemini 4 与思考等级支持', () => {
  it('内置 google 目录包含 Gemini 4 系列并正确暴露可用思考等级', () => {
    const models = catalogModels('google')
    const neon = models.get('gemini-4-neon')
    const hydrogen = models.get('gemini-4-hydrogen')
    const carbon = models.get('gemini-4-carbon')
    const argon = models.get('gemini-4-argon')

    expect(neon).toBeDefined()
    expect(neon.reasoning).toBe(true)
    expect(neon.contextWindow).toBe(1_048_576)
    expect(neon.maxTokens).toBe(65_536)
    expect(neon.input).toEqual(['text', 'image'])
    expect(getSupportedThinkingLevels(neon)).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(getSupportedThinkingLevels(hydrogen)).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(getSupportedThinkingLevels(carbon)).toEqual(['low', 'medium', 'high'])
    expect(getSupportedThinkingLevels(argon)).toEqual(['low', 'medium', 'high'])
  })

  it('用户手动列出的 gemini-4-neon 自动继承内置思考等级与视觉输入能力', () => {
    const resolved = resolveRouteModels({
      provider: 'google',
      models: [{ id: 'gemini-4-neon', name: 'Gemini 4 Neon' }],
      defaultContextWindow: 262_144,
      defaultMaxTokens: 32_768,
      defaultInput: ['text'],
    })
    const neon = resolved.models[0]
    expect(neon.reasoning).toBe(true)
    expect(neon.input).toEqual(['text', 'image'])
    expect(neon.contextWindow).toBe(1_048_576)
    expect(getSupportedThinkingLevels(neon)).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  it('自定义提供方协议列表包含 google-generative-ai', () => {
    expect(supportedProtocols()).toContain('google-generative-ai')
  })

  it('gemini-4-neon 选择 xhigh 时通过 onPayload 发送 thinkingLevel=XHIGH 而不触发映射异常', async () => {
    const profiles = resolveProfiles({
      google: { apiKeyEnv: 'GOOGLE_API_KEY' },
    })
    const googleProfile = profiles.get('google')
    const neon = googleProfile.piProvider.getModels().find(model => model.id === 'gemini-4-neon')
    let capturedPayload
    let capturedUrl = ''
    const fetchMock = vi.fn(async (input, init) => {
      capturedUrl = String(input)
      capturedPayload = JSON.parse(String(init.body))
      const sse = [
        `data: ${JSON.stringify({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ thought: true, text: '先核对思路' }, { text: '完成' }],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 5,
            thoughtsTokenCount: 3,
            totalTokenCount: 18,
          },
        })}\n\n`,
      ].join('')
      return new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    let observedByCaller
    const stream = googleProfile.piProvider.streamSimple(
      neon,
      { messages: [{ role: 'user', content: '测试 xhigh', timestamp: 1 }] },
      {
        apiKey: 'AIza-test-only-key',
        reasoning: 'xhigh',
        fetch: fetchMock,
        onPayload: payload => {
          observedByCaller = payload
          return payload
        },
      },
    )
    const message = await stream.result()
    expect(message.stopReason).toBe('stop')
    expect(capturedUrl).toContain('models/gemini-4-neon:streamGenerateContent')
    expect(observedByCaller.config.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: 'XHIGH',
    })
    expect(capturedPayload.generationConfig.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: 'XHIGH',
    })
  })

  it('自定义 google-generative-ai 提供方同样支持 Gemini 4 xhigh 思考等级', async () => {
    const customCatalog = resolveRouteModels({
      provider: 'my-gemini-proxy',
      api: 'google-generative-ai',
      baseURL: 'https://gemini-proxy.example/v1beta',
      models: [
        {
          id: 'gemini-4-neon',
          name: 'Proxy Gemini 4 Neon',
          contextWindow: 1_048_576,
          maxTokens: 65_536,
          input: ['text', 'image'],
          reasoningEfforts: { low: 'low', high: 'high', xhigh: 'xhigh' },
        },
      ],
      defaultContextWindow: 262_144,
      defaultMaxTokens: 32_768,
      defaultInput: ['text'],
    })
    const provider = buildProvider({
      provider: 'my-gemini-proxy',
      displayName: 'My Gemini Proxy',
      api: 'google-generative-ai',
      baseURL: 'https://gemini-proxy.example/v1beta',
      models: customCatalog.models,
      namesCredential: true,
    })
    let capturedPayload
    const fetchMock = vi.fn(async (_input, init) => {
      capturedPayload = JSON.parse(String(init.body))
      return new Response(
        `data: ${JSON.stringify({
          candidates: [
            { content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' },
          ],
        })}\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const message = await provider
      .streamSimple(
        customCatalog.models[0],
        { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] },
        { apiKey: 'AIza-proxy-key', reasoning: 'xhigh', fetch: fetchMock },
      )
      .result()
    expect(message.stopReason).toBe('stop')
    expect(capturedPayload.generationConfig.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: 'XHIGH',
    })
  })
})

describe('Google AI Studio 在线模型发现', () => {
  it('携带密钥时查询 /v1beta/models，支持翻页、过滤 generateContent 并保留视觉能力', async () => {
    const calls = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input, init) => {
        const url = String(input)
        calls.push({ url, headers: new Headers(init?.headers) })
        if (!url.includes('pageToken=')) {
          return Response.json({
            models: [
              {
                name: 'models/gemini-4-neon',
                displayName: 'Gemini 4 Neon',
                inputTokenLimit: 1_048_576,
                outputTokenLimit: 65_536,
                supportedGenerationMethods: ['generateContent', 'countTokens'],
              },
              {
                name: 'models/text-embedding-004',
                displayName: 'Text Embedding 004',
                inputTokenLimit: 2048,
                supportedGenerationMethods: ['embedContent'],
              },
            ],
            nextPageToken: 'page-2',
          })
        }
        return Response.json({
          models: [
            {
              name: 'models/gemini-4.5-future-preview',
              displayName: 'Gemini 4.5 Future Preview',
              inputTokenLimit: 2_000_000,
              outputTokenLimit: 131_072,
              supportedGenerationMethods: ['generateContent'],
            },
          ],
        })
      }),
    )

    const result = await discoverModels({
      provider: 'google',
      apiKey: 'AIza-test-live-key',
    })

    expect(calls).toHaveLength(2)
    expect(calls[0].url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
    )
    expect(calls[0].url).not.toContain('AIza-test-live-key')
    expect(calls[0].headers.get('x-goog-api-key')).toBe('AIza-test-live-key')
    expect(calls[1].url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&pageToken=page-2',
    )
    expect(result).toEqual([
      {
        id: 'gemini-4-neon',
        name: 'Gemini 4 Neon',
        contextWindow: 1_048_576,
        maxTokens: 65_536,
        inputModalities: ['text', 'image'],
      },
      {
        id: 'gemini-4.5-future-preview',
        name: 'Gemini 4.5 Future Preview',
        contextWindow: 2_000_000,
        maxTokens: 131_072,
        inputModalities: ['text', 'image'],
      },
    ])
  })

  it('未配置密钥时回退到随包内置 Google 目录且不发网络请求', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const result = await discoverModels({ provider: 'google' }, () => ({
      headers: undefined,
      resolveApiKey: async () => {
        throw new LlmError('missing key', 'MISSING_CREDENTIAL')
      },
    }))
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result.some(model => model.id === 'gemini-4-neon')).toBe(true)
  })

  it('密钥无效收到 403 时抛出明确错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":{"code":403}}', { status: 403 })),
    )
    await expect(
      discoverModels({
        provider: 'google',
        apiKey: 'AIza-invalid',
      }),
    ).rejects.toThrow('answered 403; check the API key')
  })
})
