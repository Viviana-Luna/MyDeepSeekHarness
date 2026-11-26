import { zstdDecompressSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { LocalCredentialProvider } from '../packages/credentials/credentials-local/lib/index.js'
import { AuthorizationService } from '../packages/credentials/authorization/lib/index.js'
import {
  LlmRuntime,
  BlockAssembler,
  createAssistantMessage,
  createUserMessage,
  createSystemMessage,
} from '../packages/llm/llm/lib/index.js'
import {
  ChatGPTAccount,
  ChatGPTAdapter,
  ACCOUNT_KEY,
  PROVIDER,
} from '../packages/llm/llm-chatgpt/lib/index.js'
import NativeCompaction from '../packages/compaction/compaction-chatgpt/lib/index.js'
import SessionStore from '../packages/core/session/lib/index.js'
import Projections from '../packages/session/session-projection/lib/index.js'
import TokenMeter from '../packages/llm/token-meter/lib/index.js'
import { publicSessionHistory } from '../src/shared/session-live.ts'

const model = { id: 'fixture-gpt', name: '隔离 GPT', contextWindow: 128000, reasoningEfforts: [] }
const native = id => ({ type: 'compaction', id, encrypted_content: `私有压缩-${id}` })
const answer = {
  type: 'message',
  id: 'msg_answer',
  role: 'assistant',
  content: [{ type: 'output_text', text: '继续检查' }],
}
function response(items, failed = false) {
  return new Response(
    [
      ...items.flatMap((item, output_index) => [
        { type: 'response.output_item.added', output_index, item },
        { type: 'response.output_item.done', output_index, item },
      ]),
      failed
        ? {
            type: 'response.failed',
            response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } },
          }
        : { type: 'response.completed', response: { status: 'completed', output: items } },
    ]
      .map(event => `data: ${JSON.stringify(event)}\n\n`)
      .join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}
async function assemble(stream) {
  const result = new BlockAssembler()
  for await (const chunk of stream) result.push(chunk)
  return result
}
const user = text =>
  createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })

it('独立插件启用原生压缩，恢复后完整回放工具往返，桌面不暴露密文，卸载释放策略', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mydsh-native-compact-')),
    ctx = new Context(),
    requests = []
  const call = {
    type: 'function_call',
    id: 'fc_read',
    call_id: 'call_read',
    namespace: 'mydsh',
    name: 'read',
    arguments: '{}',
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      if (String(url).endsWith('/models'))
        return Response.json({
          models: [
            {
              slug: model.id,
              display_name: model.name,
              context_window: model.contextWindow,
              supported_reasoning_levels: [],
              visibility: 'list',
            },
          ],
        })
      expect(url).toBe('https://api.openai.com/v1/responses')
      requests.push(JSON.parse(zstdDecompressSync(init.body).toString()))
      return response(
        requests.length === 1 ? [native('old'), answer, native('latest'), call] : [answer],
      )
    }),
  )
  try {
    // 共享服务按依赖顺序注册，不能并行装配。
    for (const plugin of [
      LlmRuntime,
      SessionStore,
      Projections,
      TokenMeter,
      AuthorizationService,
    ]) {
      // oxlint-disable-next-line no-await-in-loop
      await ctx.plugin(plugin).await()
    }
    await ctx
      .plugin(LocalCredentialProvider, { path: join(directory, 'credentials.yaml'), watch: false })
      .await()
    const clientId = 'fixture-client',
      subject = 'fixture-subject'
    const accountId = createHash('sha256')
      .update(JSON.stringify(['https://auth.openai.com', clientId, subject]))
      .digest('hex')
    await ctx.credentials.modifyRecord(ACCOUNT_KEY, async () => ({
      kind: 'grant',
      payload: {
        kind: 'mydsh-siwc',
        clientId,
        subject,
        accountId,
        scopes: ['chatgpt.tokens.use.direct', 'resource.invoke'],
        tokens: {
          accessToken: 'fixture-token',
          refreshToken: 'fixture-refresh',
          idToken: 'fixture-id',
          expiresAt: Date.now() + 3600000,
        },
      },
    }))
    await ctx.plugin(ChatGPTAccount).await()
    await ctx.chatgpt.refresh(new AbortController().signal)
    const fork = ctx.plugin(NativeCompaction, { maxTokens: null })
    await fork.await()
    const options = {
      provider: PROVIDER,
      model: model.id,
      sessionId: 'fixture-session',
      messages: [createSystemMessage('保持公共接口', 'fixture'), user('需要保留的历史')],
    }
    const agent = { id: options.sessionId, options, session: { requestHeader: () => undefined } }
    await ctx.waterfall(
      'agent/pre-step',
      { agent, signal: new AbortController().signal },
      async () => undefined,
    )
    const first = await assemble(ctx.llm.stream(options))
    expect(first.finish.kind).toBe('tool-calls')
    expect(requests[0].context_management).toEqual([
      { type: 'compaction', compact_threshold: 102400 },
    ])
    const message = createAssistantMessage({
      content: first.blocks(),
      source: { provider: PROVIDER, model: model.id, replayState: first.replayState },
    })
    const event = {
      type: 'assistant/message',
      seq: 1,
      time: 1,
      data: {
        message,
        stream: [
          {
            type: 'chunk',
            time: 1,
            chunk: { type: 'finish', reason: first.finish, replayState: first.replayState },
          },
        ],
      },
    }
    await writeFile(join(directory, 'history.json'), JSON.stringify(event))
    const restored = JSON.parse(await readFile(join(directory, 'history.json'), 'utf8'))
    expect(JSON.stringify(publicSessionHistory({ records: [restored] }))).not.toContain('私有压缩')
    const result = createUserMessage({
      source: { kind: 'tool', callId: 'call_read' },
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call_read',
          content: [{ type: 'text', text: '文件已读取' }],
        },
      ],
    })
    await assemble(
      ctx.llm.stream({
        ...options,
        messages: [...options.messages, restored.data.message, result, user('继续')],
      }),
    )
    expect(requests[1].instructions).toBe('保持公共接口')
    expect(requests[1].input).toEqual([
      native('latest'),
      call,
      { type: 'function_call_output', call_id: 'call_read', output: '文件已读取' },
      { role: 'user', content: [{ type: 'input_text', text: '继续' }] },
    ])
    expect(JSON.stringify(options.messages)).toContain('需要保留的历史')
    expect(() => ctx.compaction.compactNow(agent, new AbortController().signal)).toThrow(
      '尚未开放独立的手动压缩接口',
    )
    ctx.emit('agent/disposed', { agent })
    await assemble(ctx.llm.stream(options))
    expect(requests[2]).not.toHaveProperty('context_management')
    await ctx.waterfall(
      'agent/pre-step',
      { agent, signal: new AbortController().signal },
      async () => undefined,
    )
    await fork.dispose()
    await assemble(ctx.llm.stream(options))
    expect(requests[3]).not.toHaveProperty('context_management')
  } finally {
    await ctx.fiber.dispose()
    vi.unstubAllGlobals()
    await rm(directory, { recursive: true, force: true })
  }
})

it('压缩流失败不提交私有检查点，账号变化后保留原始历史而不发送旧密文', async () => {
  let credential = { accountId: 'first', accessToken: 'fixture-token' },
    failed = true
  const requests = [],
    adapter = new ChatGPTAdapter({
      models: () => [model],
      credential: async () => credential,
      fetch: async (_url, init) => {
        requests.push(JSON.parse(zstdDecompressSync(init.body).toString()))
        return response([native('checkpoint'), answer], failed)
      },
    })
  const options = { provider: PROVIDER, model: model.id, messages: [user('原始约束')] }
  try {
    const partial = new BlockAssembler()
    await expect(
      (async () => {
        for await (const chunk of adapter.stream(options)) partial.push(chunk)
      })(),
    ).rejects.toMatchObject({ code: 'subscription_sharing_usage_limit_exceeded' })
    expect(partial.replayState).toBeUndefined()
    failed = false
    const completed = await assemble(adapter.stream(options))
    const message = createAssistantMessage({
      content: completed.blocks(),
      source: {
        provider: PROVIDER,
        model: model.id,
        replayState: completed.replayState,
      },
    })
    credential = { accountId: 'second', accessToken: 'fixture-other-token' }
    await assemble(
      adapter.stream({
        ...options,
        messages: [...options.messages, message, user('换账号后继续')],
      }),
    )
    expect(JSON.stringify(requests.at(-1).input)).toContain('原始约束')
    expect(JSON.stringify(requests.at(-1).input)).not.toContain('私有压缩')
  } finally {
    adapter.dispose()
  }
})
