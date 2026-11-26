/** 后台按实际文本计量模型方案；只保留文本组装状态，不保存推理正文或私有回放。 */
import { BlockAssembler, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { GitAiError } from '../../../src/runtime/workspace/git-ai-errors.ts'
import { MAX_GIT_AI_PLAN_BYTES } from '../../../src/runtime/workspace/git-ai-plan.ts'

// 容纳逐字符输出与推理事件，但不给空分片和大量索引无限增长的空间。
const MAX_CHUNKS = 128 * 1024
const MAX_BLOCKS = 4096
const INVALID_OUTPUT = 'AI 提交模型没有返回唯一文本方案，请重新分析'
type ContentChunk = Exclude<StreamChunk, { type: 'finish' | 'usage' }>

function blockType(chunk: ContentChunk): string {
  if (chunk.type === 'block-start') return chunk.blockType
  if (chunk.type === 'block-end') return chunk.block.type
  if (chunk.type === 'text-delta') return 'text'
  if (chunk.type === 'reasoning-delta') return 'reasoning'
  return 'tool-call'
}

function checkSize(bytes: number) {
  if (bytes > MAX_GIT_AI_PLAN_BYTES)
    throw new GitAiError('AI 提交方案文本超过大小上限（64 KiB），请缩小分析范围')
}

/** 复用通用组装器接收唯一文本块；调用方须另行验证结束标记、取消和超时。 */
export class GitAiPlanOutput {
  private readonly assembler = new BlockAssembler()
  private readonly blocks = new Map<number, string>()
  private textIndex: number | undefined
  private chunks = 0
  private bytes = 0
  private lastCode = NaN
  private isClosed = false

  private registerBlock(index: number, type: string) {
    if (!Number.isSafeInteger(index) || index < 0 || !['text', 'reasoning'].includes(type))
      throw new GitAiError(INVALID_OUTPUT)
    const existing = this.blocks.get(index)
    if (existing !== undefined) {
      if (existing !== type) throw new GitAiError(INVALID_OUTPUT)
      return
    }
    if (this.blocks.size >= MAX_BLOCKS)
      throw new GitAiError('AI 提交模型返回过多内容块，请重新分析')
    // 唯一方案必须是最后一个内容块；前面的推理只登记索引，不保留正文。
    if (this.textIndex !== undefined) throw new GitAiError(INVALID_OUTPUT)
    if (type === 'text') this.textIndex = index
    this.blocks.set(index, type)
  }

  private countDelta(text: string) {
    if (!text.length) return
    const firstCode = text.charCodeAt(0)
    const joinsSurrogate =
      this.lastCode >= 0xd800 &&
      this.lastCode <= 0xdbff &&
      firstCode >= 0xdc00 &&
      firstCode <= 0xdfff
    // 跨分片的 UTF-16 代理对编码为 4 字节，不能按两个孤立代理字符算成 6 字节。
    const bytes = this.bytes + Buffer.byteLength(text, 'utf8') - (joinsSurrogate ? 2 : 0)
    checkSize(bytes)
    this.bytes = bytes
    this.lastCode = text.charCodeAt(text.length - 1)
  }

  /** 计量实际文本后才交给组装器，超限时抛出安全错误，由调用方关闭模型流。 */
  push(chunk: Exclude<StreamChunk, { type: 'finish' }>): void {
    if (++this.chunks > MAX_CHUNKS) throw new GitAiError('AI 提交模型返回过多流式事件，请重新分析')
    if (chunk.type === 'usage') return
    const type = blockType(chunk)
    this.registerBlock(chunk.index, type)
    if (type === 'reasoning' || this.isClosed) return
    if (chunk.type === 'text-delta') this.countDelta(chunk.text)
    if (chunk.type === 'block-end' && chunk.block.type === 'text') {
      // block-end 是权威完整文本，替代增量而不是再次追加；后续重复块沿用组装器的忽略语义。
      checkSize(Buffer.byteLength(chunk.block.text, 'utf8'))
      this.isClosed = true
    }
    this.assembler.push(chunk)
  }

  /** 返回待校验的原始 JSON 文本；缺少文本时拒绝，不读取模型私有回放。 */
  text(): string {
    const block = this.assembler.blocks()[0]
    if (block?.type !== 'text') throw new GitAiError(INVALID_OUTPUT)
    return block.text
  }
}
