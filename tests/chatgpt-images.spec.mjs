import { zstdDecompressSync } from 'node:zlib'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { LocalAttachmentStore } from '../packages/attachment/attachment-local/lib/index.js'
import {
  createUserMessage,
  createAssistantMessage,
  ToolCallId,
} from '../packages/llm/llm/lib/index.js'
import { ChatGPTAdapter, PROVIDER } from '../packages/llm/llm-chatgpt/lib/index.js'

const sharp = createRequire(
  new URL('../packages/attachment/attachment-local/package.json', import.meta.url),
)('sharp')
const png = await sharp({
  create: { width: 3, height: 2, channels: 3, background: { r: 24, g: 120, b: 200 } },
})
  .png()
  .toBuffer()
const model = {
  id: 'fixture-vision',
  name: '隔离视觉模型',
  contextWindow: 128000,
  reasoningEfforts: [],
  inputModalities: ['text', 'image'],
}
const credential = async () => ({ accountId: 'fixture-account', accessToken: 'fixture-token' })
async function consume(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}
function completed() {
  const item = {
    type: 'message',
    id: 'msg_done',
    role: 'assistant',
    phase: 'final_answer',
    content: [{ type: 'output_text', text: '收到图片', annotations: [] }],
  }
  return new Response(
    [
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { status: 'completed', output: [item] } },
    ]
      .map(event => `data: ${JSON.stringify(event)}\n\n`)
      .join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

it('持久图片按用户与工具内容顺序进入 Responses，省略的图片只发送明确占位', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mydsh-chatgpt-image-')),
    context = new Context()
  let adapter
  try {
    await context.plugin(LocalAttachmentStore, { dshHome: directory }).await()
    const attachment = await context.attachments.saveImage({
      data: png,
      mediaType: 'image/png',
      name: 'fixture.png',
    })
    const verified = await context.attachments.readImage(attachment)
    const requests = []
    adapter = new ChatGPTAdapter({
      models: () => [model],
      credential,
      attachments: () => context.attachments,
      fetch: async (_url, options) => {
        requests.push(JSON.parse(zstdDecompressSync(options.body).toString()))
        return completed()
      },
    })
    const messages = [
      createUserMessage({
        source: { kind: 'user' },
        content: [
          { type: 'text', text: '前文' },
          { type: 'image', attachment },
          { type: 'text', text: '后文' },
        ],
      }),
      createAssistantMessage({
        source: { provider: PROVIDER, model: model.id },
        content: [
          { type: 'tool-call', id: ToolCallId('call_image'), name: 'view_image', arguments: '{}' },
        ],
      }),
      createUserMessage({
        source: { kind: 'tool', callId: ToolCallId('call_image') },
        content: [
          {
            type: 'tool-result',
            toolCallId: ToolCallId('call_image'),
            content: [
              { type: 'text', text: '工具结果' },
              { type: 'image', attachment },
              { type: 'image', attachment, offloaded: true },
            ],
          },
        ],
      }),
    ]
    const before = JSON.stringify(messages)
    await consume(adapter.stream({ provider: PROVIDER, model: model.id, messages }))
    const input = requests[0].input,
      url = `data:image/png;base64,${Buffer.from(verified.data).toString('base64')}`
    expect(input[0].content).toMatchObject([
      { type: 'input_text', text: '前文' },
      { type: 'input_text' },
      { type: 'input_image', image_url: url, detail: 'auto' },
      { type: 'input_text', text: '后文' },
    ])
    expect(input[2]).toMatchObject({
      type: 'function_call_output',
      call_id: 'call_image',
      output: [
        { type: 'input_text', text: '工具结果' },
        { type: 'input_text' },
        { type: 'input_image', image_url: url },
        { type: 'input_text' },
      ],
    })
    expect(input[2].output[3].text).toContain('image omitted')
    expect(JSON.stringify(messages)).toBe(before)
    expect(before).not.toContain('base64')
    expect((await adapter.resolveModel(PROVIDER, model.id)).inputModalities).toEqual([
      'text',
      'image',
    ])
  } finally {
    adapter?.dispose()
    await context.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

it('未声明视觉能力、附件缺失或已取消时拒绝发送图片请求', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mydsh-chatgpt-image-')),
    context = new Context(),
    send = vi.fn(completed)
  let adapter
  try {
    await context.plugin(LocalAttachmentStore, { dshHome: directory }).await()
    const attachment = await context.attachments.saveImage({ data: png, mediaType: 'image/png' })
    const messages = [
      createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image', attachment }] }),
    ]
    let selected = { ...model, inputModalities: ['text'] }
    adapter = new ChatGPTAdapter({
      models: () => [selected],
      credential,
      attachments: () => context.attachments,
      fetch: send,
    })
    await expect(
      consume(adapter.stream({ provider: PROVIDER, model: model.id, messages })),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    selected = model
    const mismatched = [
      createUserMessage({
        source: { kind: 'user' },
        content: [
          { type: 'image', attachment },
          { type: 'image', attachment: { ...attachment, width: attachment.width + 1 } },
        ],
      }),
    ]
    await expect(
      consume(adapter.stream({ provider: PROVIDER, model: model.id, messages: mismatched })),
    ).rejects.toMatchObject({ code: 'INVALID_ATTACHMENT' })
    await rm(context.attachments.imageHostPath(attachment))
    await expect(
      consume(adapter.stream({ provider: PROVIDER, model: model.id, messages })),
    ).rejects.toMatchObject({ code: 'INVALID_ATTACHMENT' })
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(
      consume(
        adapter.stream({ provider: PROVIDER, model: model.id, messages, signal: cancelled.signal }),
      ),
    ).rejects.toMatchObject({ code: 'ABORTED' })
    expect(send).not.toHaveBeenCalled()
  } finally {
    adapter?.dispose()
    await context.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
