import { zstdDecompressSync } from 'node:zlib'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuthorizationService } from '../packages/credentials/authorization/lib/index.js'
import { LocalCredentialProvider } from '../packages/credentials/credentials-local/lib/index.js'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import {
  LlmRuntime,
  BlockAssembler,
  createUserMessage,
  createAssistantMessage,
  ToolCallId,
  ReasoningEffortId,
} from '../packages/llm/llm/lib/index.js'
import * as chatgpt from '../packages/llm/llm-chatgpt/lib/index.js'
import { publicSessionHistory, parseDesktopSessionFrame } from '../src/shared/session-live.ts'

const model = {
  id: 'fixture-gpt',
  name: '隔离 GPT',
  contextWindow: 128000,
  reasoningEfforts: ['none', 'medium', 'high'],
}
const credential = { accountId: 'fixture-account', accessToken: 'fixture-token' }
const prompt = createUserMessage({
  content: [{ type: 'text', text: '读取文件后继续检查' }],
  source: { kind: 'user' },
})
const usage = {
  input_tokens: 100,
  input_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 },
  output_tokens: 20,
  output_tokens_details: { reasoning_tokens: 5 },
  total_tokens: 120,
}
function response(items, closed, output = items) {
  const events = items.flatMap((item, output_index) => [
    { type: 'response.output_item.added', output_index, item },
    ...(item.type === 'message'
      ? [{ type: 'response.output_text.delta', output_index, item_id: item.id, delta: '检查中文' }]
      : []),
    { type: 'response.output_item.done', output_index, item },
  ])
  events.push({ type: 'response.completed', response: { status: 'completed', output, usage } })
  const bytes = new TextEncoder().encode(
    events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''),
  )
  let offset = 0
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (offset < bytes.length) {
          controller.enqueue(bytes.slice(offset, offset + 7))
          offset += 7
        }
        // 完成事件后保持连接，确认消费者主动结束和清理。
      },
      cancel: closed,
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}
async function assembled(chunks) {
  const result = new BlockAssembler()
  for await (const chunk of chunks) result.push(chunk)
  return result
}
afterEach(() => {
  vi.unstubAllGlobals()
})

it('独立注册后完成分块流、推理与工具往返，并在桌面出口隔离私有回放', async () => {
  const context = new Context()
  const requests = []
  const closed = vi.fn()
  const items = [
    { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'fixture-ciphertext' },
    {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      phase: 'commentary',
      content: [{ type: 'output_text', text: '检查中文', annotations: [] }],
    },
    {
      type: 'function_call',
      namespace: 'mydsh',
      id: 'fc_1',
      call_id: 'call_1',
      name: 'read',
      arguments: '{"path":"README.md"}',
    },
  ]
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      expect(url).toBe('https://api.openai.com/v1/responses')
      const headers = new Headers(init.headers)
      expect(headers.get('originator')).toBe('mydsh')
      expect(headers.get('content-encoding')).toBe('zstd')
      expect(headers.get('user-agent')).toContain('mydsh-chatgpt/')
      expect(headers.get('authorization')).toBe('Bearer fixture-token')
      expect(headers.has('chatgpt-account-id')).toBe(false)
      requests.push(JSON.parse(zstdDecompressSync(init.body).toString()))
      const result = response(
        requests.length === 1
          ? items
          : [
              {
                type: 'message',
                id: 'msg_2',
                role: 'assistant',
                phase: 'final_answer',
                content: [{ type: 'output_text', text: '检查中文', annotations: [] }],
              },
            ],
        closed,
        requests.length === 1 ? [] : undefined,
      )
      // 真实订阅响应可能省略类型头，合法事件流仍须完成工具往返。
      if (requests.length === 2) result.headers.delete('content-type')
      return result
    }),
  )
  try {
    await context.plugin(LlmRuntime).await()
    const fork = context.plugin({
      name: '独立协议验收',
      inject: ['llm'],
      apply(ctx) {
        const adapter = new chatgpt.ChatGPTAdapter({
          models: () => [model],
          credential: async () => credential,
        })
        ctx.llm.registerAdapter([chatgpt.PROVIDER], adapter)
        ctx.effect(() => () => adapter.dispose())
      },
    })
    await fork.await()
    expect(context.llm.listProviders()).toEqual([{ id: chatgpt.PROVIDER, name: 'ChatGPT 订阅' }])
    const first = await assembled(
      context.llm.stream({
        provider: chatgpt.PROVIDER,
        model: model.id,
        messages: [prompt],
        reasoningEffort: ReasoningEffortId('high'),
        tools: [{ name: 'read', description: '读取文件', parameters: { type: 'object' } }],
      }),
    )
    expect(first.finish.kind).toBe('tool-calls')
    expect(first.usage).toEqual({
      inputTokens: 60,
      cacheReadTokens: 30,
      cacheWriteTokens: 10,
      outputTokens: 20,
      reasoningTokens: 5,
      totalTokens: 120,
    })
    const assistant = createAssistantMessage({
      content: first.blocks(),
      source: { provider: chatgpt.PROVIDER, model: model.id, replayState: first.replayState },
    })
    const restored = JSON.parse(JSON.stringify(assistant))
    const result = await assembled(
      context.llm.stream({
        provider: chatgpt.PROVIDER,
        model: model.id,
        messages: [
          prompt,
          restored,
          createUserMessage({
            content: [
              {
                type: 'tool-result',
                toolCallId: ToolCallId('call_1'),
                content: [{ type: 'text', text: '文件内容' }],
              },
            ],
            source: { kind: 'tool', callId: ToolCallId('call_1') },
          }),
        ],
      }),
    )
    expect(result.finish.kind).toBe('stop')
    expect(requests[0]).toMatchObject({ reasoning: { effort: 'high' }, store: false, stream: true })
    expect(requests[1]).not.toHaveProperty('reasoning')
    expect(requests[0].tools).toMatchObject([
      { type: 'namespace', name: 'mydsh', tools: [{ type: 'function', name: 'read' }] },
    ])
    expect(requests[1].input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'reasoning', encrypted_content: 'fixture-ciphertext' }),
        expect.objectContaining({ type: 'message', phase: 'commentary' }),
        expect.objectContaining({
          type: 'function_call',
          namespace: 'mydsh',
          id: 'fc_1',
          call_id: 'call_1',
        }),
        { type: 'function_call_output', call_id: 'call_1', output: '文件内容' },
      ]),
    )
    const event = { type: 'assistant/message', seq: 4, time: 1, data: { message: restored } }
    const page = publicSessionHistory({ records: [{ type: 'event', event }], hasMore: true })
    const frame = parseDesktopSessionFrame({ type: 'session/event', sessionId: 'fixture', event })
    expect(JSON.stringify([page, frame])).not.toContain('fixture-ciphertext')
    expect(JSON.stringify(event)).toContain('fixture-ciphertext')
    expect(frame).toMatchObject({
      event: { seq: 4, data: { message: { content: assistant.content } } },
    })
    expect(closed).toHaveBeenCalledTimes(2)
    await fork.dispose()
    expect(context.llm.listProviders()).toEqual([])
  } finally {
    await context.fiber.dispose()
  }
})

it('中断的工具响应不提交完成状态，卸载取消等待中的请求并释放 reader', async () => {
  const closed = vi.fn()
  let held = false,
    opened = false
  const adapter = new chatgpt.ChatGPTAdapter({
    models: () => [model],
    credential: async () => credential,
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            opened = true
            if (!held) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"read"}}\n\n',
                ),
              )
              controller.close()
            }
          },
          cancel: closed,
        }),
      ),
  })
  const options = { provider: chatgpt.PROVIDER, model: model.id, messages: [prompt] }
  try {
    const chunks = []
    await expect(
      (async () => {
        for await (const chunk of adapter.stream(options)) chunks.push(chunk)
      })(),
    ).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
    expect(chunks.some(chunk => chunk.type === 'finish' || chunk.type === 'block-end')).toBe(false)
    held = true
    opened = false
    const waiting = assembled(adapter.stream(options))
    await vi.waitFor(() => {
      expect(opened).toBe(true)
    })
    await new Promise(resolve => {
      setTimeout(resolve, 0)
    })
    adapter.dispose()
    await expect(waiting).rejects.toMatchObject({ code: 'ABORTED' })
    expect(closed).toHaveBeenCalledOnce()
  } finally {
    adapter.dispose()
  }
})

const catalog = {
  models: [
    {
      slug: model.id,
      display_name: model.name,
      context_window: model.contextWindow,
      visibility: 'list',
      supported_reasoning_levels: model.reasoningEfforts.map(effort => ({ effort })),
    },
  ],
}
async function accountContext(directory) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime).await()
  await ctx.plugin(LocalCredentialProvider, { path: join(directory, 'credentials.yaml') }).await()
  await ctx.plugin(AuthorizationService).await()
  await ctx.plugin(chatgpt).await()
  return ctx
}
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
function siwcFixture() {
  const originalFetch = globalThis.fetch,
    keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const fixture = {
    mode: 'valid',
    auth: null,
    refreshes: 0,
    responses: 0,
    revokes: 0,
    catalogReads: 0,
    heldSignal: null,
    release: null,
  }
  const idToken = () => {
    const body = `${encode({ alg: 'RS256', kid: 'fixture-key' })}.${encode({
      iss: 'https://auth.openai.com',
      aud: 'oaiapp_fixture',
      sub: 'fixture-subject',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      nonce: fixture.mode === 'bad-nonce' ? 'wrong-nonce' : fixture.auth.searchParams.get('nonce'),
    })}`
    return body + '.' + sign('RSA-SHA256', Buffer.from(body), keys.privateKey).toString('base64url')
  }
  fixture.callback = async (url, state = url.searchParams.get('state')) => {
    const callback = new URL(url.searchParams.get('redirect_uri'))
    callback.search = new URLSearchParams({
      code: 'fixture-code',
      state,
      client_id: 'oaiapp_fixture',
    }).toString()
    return originalFetch(callback)
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      const address = String(url)
      expect(new Headers(init.headers).get('originator')).toBe('mydsh')
      expect(address).not.toContain('backend-api')
      if (address.endsWith('/.well-known/openid-configuration'))
        return Response.json({
          issuer: 'https://auth.openai.com',
          jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
          revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke',
        })
      if (address.endsWith('/.well-known/jwks.json'))
        return Response.json({
          keys: [
            {
              ...keys.publicKey.export({ format: 'jwk' }),
              kid: 'fixture-key',
              alg: 'RS256',
              use: 'sig',
            },
          ],
        })
      if (address.endsWith('/oauth/revoke')) {
        fixture.revokes++
        expect(new URLSearchParams(init.body).get('client_id')).toBe('oaiapp_fixture')
        return new Response(null, { status: 200 })
      }
      if (address.endsWith('/oauth/token')) {
        const body = new URLSearchParams(init.body),
          refresh = body.get('grant_type') === 'refresh_token'
        expect(body.get('client_id')).toBe('oaiapp_fixture')
        expect(body.get('resource')).toBe('https://api.openai.com/v1')
        if (refresh) {
          fixture.refreshes++
          if (fixture.mode === 'transient')
            return Response.json({ error: 'temporarily_unavailable' }, { status: 503 })
          if (fixture.mode === 'permanent')
            return Response.json({ error: 'invalid_grant' }, { status: 400 })
          if (fixture.mode === 'held') {
            fixture.heldSignal = init.signal
            await new Promise(resolve => {
              fixture.release = resolve
            })
          }
        } else {
          expect(createHash('sha256').update(body.get('code_verifier')).digest('base64url')).toBe(
            fixture.auth.searchParams.get('code_challenge'),
          )
          expect(body.get('redirect_uri')).toBe(fixture.auth.searchParams.get('redirect_uri'))
          if (fixture.mode === 'exchange-failed')
            return Response.json({ error: 'temporarily_unavailable' }, { status: 503 })
        }
        return Response.json({
          access_token: 'fixture-private-access-' + fixture.refreshes,
          refresh_token: 'fixture-private-refresh-' + fixture.refreshes,
          token_type: 'Bearer',
          expires_in: 3600,
          ...(refresh
            ? {}
            : {
                id_token: idToken(),
                scope:
                  fixture.mode === 'identity-only'
                    ? 'openid profile email'
                    : 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
              }),
        })
      }
      if (address.endsWith('/responses')) {
        if (++fixture.responses === 1) return new Response(null, { status: 401 })
        return response(
          [
            {
              type: 'message',
              id: 'msg_recovered',
              role: 'assistant',
              phase: 'final_answer',
              content: [{ type: 'output_text', text: '检查中文', annotations: [] }],
            },
          ],
          () => {},
        )
      }
      expect(address).toBe('https://api.openai.com/v1/models')
      fixture.catalogReads++
      return Response.json(catalog)
    }),
  )
  return fixture
}
async function beginLogin(ctx, fixture) {
  const pending = ctx.chatgpt.connect(new AbortController().signal)
  await vi.waitFor(async () => expect((await ctx.chatgpt.status()).authorizationUrl).toBeTruthy())
  fixture.auth = new URL((await ctx.chatgpt.status()).authorizationUrl)
  return { pending, url: fixture.auth }
}

it('SIWC 注册经真实回调与签名校验后完成目录、刷新和调用，断开保留注册以便再次登录', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mydsh-siwc-test-')),
    fixture = siwcFixture()
  let ctx
  try {
    ctx = await accountContext(directory)
    fixture.mode = 'exchange-failed'
    const { pending, url } = await beginLogin(ctx, fixture)
    expect(url.searchParams.get('client_id')).toBe('dynamic_agent_client')
    expect(url.searchParams.get('agent_name_hint')).toBe('MyDSH')
    expect(url.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:/)
    expect(url.searchParams.get('redirect_uri')).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/,
    )
    await expect(ctx.chatgpt.connect(new AbortController().signal)).rejects.toMatchObject({
      code: 'ALREADY_IN_FLIGHT',
    })
    expect((await fixture.callback(url)).status).toBe(200)
    expect(await pending).toMatchObject({ connected: false, registered: true })
    expect((await ctx.credentials.readRecord(chatgpt.ACCOUNT_KEY)).payload).toEqual({
      kind: 'mydsh-siwc-pending',
      clientId: 'oaiapp_fixture',
    })
    fixture.mode = 'valid'
    const retry = await beginLogin(ctx, fixture)
    expect(retry.url.searchParams.get('client_id')).toBe('oaiapp_fixture')
    expect(retry.url.searchParams.has('agent_name_hint')).toBe(false)
    await fixture.callback(retry.url)
    const connected = await retry.pending
    expect(connected).toMatchObject({
      connected: true,
      registered: true,
      planEnabled: true,
      models: [{ id: model.id }],
    })
    expect(JSON.stringify(connected)).not.toContain('fixture-private')
    expect(connected.needsPlanNotice).toBe(true)
    expect((await ctx.chatgpt.acknowledgePlanUse()).needsPlanNotice).toBe(false)
    if (process.platform !== 'win32')
      expect((await stat(join(directory, 'credentials.yaml'))).mode & 0o777).toBe(0o600)
    await ctx.credentials.modifyRecord(chatgpt.ACCOUNT_KEY, async current => ({
      ...current,
      payload: { ...current.payload, tokens: { ...current.payload.tokens, expiresAt: 1 } },
    }))
    await Promise.all([
      ctx.chatgpt.credential(new AbortController().signal),
      ctx.chatgpt.credential(new AbortController().signal),
    ])
    expect(fixture.refreshes).toBe(1)
    expect(
      (
        await assembled(
          ctx.llm.stream({ provider: chatgpt.PROVIDER, model: model.id, messages: [prompt] }),
        )
      ).finish.kind,
    ).toBe('stop')
    expect(fixture.responses).toBe(2)
    expect(fixture.refreshes).toBe(2)
    expect((await ctx.chatgpt.status()).needsPlanNotice).toBe(false)
    await ctx.chatgpt.disconnect()
    expect(fixture.revokes).toBe(1)
    expect((await ctx.credentials.readRecord(chatgpt.ACCOUNT_KEY)).payload).not.toHaveProperty(
      'tokens',
    )
    expect(await ctx.llm.listModels(chatgpt.PROVIDER)).toEqual([])
    await ctx.fiber.dispose()
    ctx = await accountContext(directory)
    const again = await beginLogin(ctx, fixture)
    expect(again.url.searchParams.get('client_id')).toBe('oaiapp_fixture')
    expect(again.url.searchParams.get('ext_agent_host_id')).toBe(
      url.searchParams.get('ext_agent_host_id'),
    )
    expect(again.url.searchParams.has('agent_name_hint')).toBe(false)
    await fixture.callback(again.url)
    await again.pending
    await ctx.chatgpt.disconnect()
    await ctx.chatgpt.forget()
    expect(await ctx.credentials.readRecord(chatgpt.ACCOUNT_KEY)).toBeUndefined()
  } finally {
    await ctx?.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

it('SIWC 取消和身份校验失败不建立连接，未授予订阅权限不推理，断开阻止迟到刷新', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mydsh-siwc-test-')),
    fixture = siwcFixture()
  let ctx
  try {
    ctx = await accountContext(directory)
    let login = await beginLogin(ctx, fixture)
    ctx.chatgpt.cancel()
    await login.pending
    await expect(fixture.callback(login.url)).rejects.toThrow()
    login = await beginLogin(ctx, fixture)
    expect((await fixture.callback(login.url, 'wrong-state')).status).toBe(400)
    await login.pending
    expect(await ctx.credentials.readRecord(chatgpt.ACCOUNT_KEY)).toBeUndefined()
    fixture.mode = 'bad-nonce'
    login = await beginLogin(ctx, fixture)
    await fixture.callback(login.url)
    await login.pending
    expect((await ctx.credentials.readRecord(chatgpt.ACCOUNT_KEY)).payload).toEqual({
      kind: 'mydsh-siwc-pending',
      clientId: 'oaiapp_fixture',
    })
    fixture.mode = 'identity-only'
    login = await beginLogin(ctx, fixture)
    await fixture.callback(login.url)
    await login.pending
    expect(await ctx.chatgpt.status()).toMatchObject({
      registered: true,
      planEnabled: false,
      connected: false,
      models: [],
    })
    expect(fixture.catalogReads).toBe(0)
    expect(await ctx.chatgpt.credential(new AbortController().signal)).toBeUndefined()
    fixture.mode = 'valid'
    login = await beginLogin(ctx, fixture)
    expect(login.url.searchParams.get('prompt')).toBe('consent')
    await fixture.callback(login.url)
    await login.pending
    const saved = await ctx.credentials.modifyRecord(chatgpt.ACCOUNT_KEY, async current => ({
      ...current,
      payload: { ...current.payload, tokens: { ...current.payload.tokens, expiresAt: 1 } },
    }))
    fixture.mode = 'transient'
    await expect(ctx.chatgpt.credential(new AbortController().signal)).rejects.toMatchObject({
      code: 'NETWORK',
    })
    expect(await ctx.credentials.readRecord(chatgpt.ACCOUNT_KEY)).toEqual(saved)
    fixture.mode = 'permanent'
    await expect(ctx.chatgpt.credential(new AbortController().signal)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    })
    expect((await ctx.credentials.readRecord(chatgpt.ACCOUNT_KEY)).payload).not.toHaveProperty(
      'tokens',
    )
    await ctx.credentials.modifyRecord(chatgpt.ACCOUNT_KEY, async () => saved)
    fixture.mode = 'held'
    const refreshing = ctx.chatgpt.credential(new AbortController().signal).catch(error => error)
    await vi.waitFor(() => expect(fixture.heldSignal).toBeTruthy())
    const disconnected = ctx.chatgpt.disconnect()
    expect(fixture.heldSignal.aborted).toBe(true)
    fixture.release()
    await refreshing
    await disconnected
    expect((await ctx.credentials.readRecord(chatgpt.ACCOUNT_KEY)).payload).not.toHaveProperty(
      'tokens',
    )
    login = await beginLogin(ctx, fixture)
    await ctx.fiber.dispose()
    await login.pending
    await expect(fixture.callback(login.url)).rejects.toThrow()
  } finally {
    await ctx?.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

it('未说明原因的订阅限流也停止自动重试，并保留服务端等待时间', async () => {
  const send = vi.fn(async () =>
    Response.json({ detail: 'fixture-only' }, { status: 429, headers: { 'retry-after': '65' } }),
  )
  const adapter = new chatgpt.ChatGPTAdapter({
    models: () => [model],
    credential: async () => credential,
    fetch: send,
  })
  try {
    const failure = await assembled(
      adapter.stream({ provider: chatgpt.PROVIDER, model: model.id, messages: [prompt] }),
    ).catch(error => error)
    expect(failure).toMatchObject({
      code: 'RATE_LIMIT',
      failure: { status: 429, providerRetryAfterMs: 65000 },
    })
    expect(failure.message).toContain('65 秒')
    expect(adapter.providerRetryPolicy().retryableCodes).not.toContain(failure.code)
    expect(adapter.providerRetryPolicy().maxRetries).toBe(5)
    expect(send).toHaveBeenCalledOnce()
  } finally {
    adapter.dispose()
  }
})
