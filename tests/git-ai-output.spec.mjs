/** 验证后台方案接收器只计量文本，保持权威块语义并限制异常流资源。 */
import { describe, expect, it } from 'vitest'
import { GitAiPlanOutput } from '../packages/desktop-services/src/git-ai-output.ts'
import { MAX_GIT_AI_PLAN_BYTES } from '../src/runtime/workspace/git-ai-plan.ts'

describe('AI 提交方案文本接收', () => {
  it('完整块替代增量，已关闭块的迟到增量与重复关闭不改变方案', () => {
    const output = new GitAiPlanOutput()
    output.push({ type: 'text-delta', index: 3, text: '未完成的增量' })
    output.push({ type: 'block-end', index: 3, block: { type: 'text', text: '完整方案' } })
    output.push({ type: 'text-delta', index: 3, text: '迟到'.repeat(MAX_GIT_AI_PLAN_BYTES) })
    output.push({ type: 'block-end', index: 3, block: { type: 'text', text: '重复关闭' } })
    expect(output.text()).toBe('完整方案')
  })

  it('兼容只有完整块的适配器，并按 UTF-8 而非字符数量计量', () => {
    const output = new GitAiPlanOutput()
    const text = '文'.repeat(Math.floor(MAX_GIT_AI_PLAN_BYTES / 3))
    output.push({ type: 'block-end', index: 0, block: { type: 'text', text } })
    expect(output.text()).toBe(text)
    const oversized = new GitAiPlanOutput()
    expect(() =>
      oversized.push({
        type: 'block-end',
        index: 0,
        block: { type: 'text', text: text + '文' },
      }),
    ).toThrow('方案文本超过大小上限（64 KiB）')
  })

  it('逐次检查增量，不因完整块稍后可能缩小就接受超限文本', () => {
    const output = new GitAiPlanOutput()
    const text = 'x'.repeat(MAX_GIT_AI_PLAN_BYTES)
    output.push({ type: 'text-delta', index: 0, text })
    expect(() => output.push({ type: 'text-delta', index: 0, text: '文' })).toThrow('大小上限')
    expect(output.text()).toBe(text)
  })

  it('跨分片和空分片的 UTF-16 代理对不会在预算边界被多算字节', () => {
    const output = new GitAiPlanOutput()
    const prefix = 'x'.repeat(MAX_GIT_AI_PLAN_BYTES - 4)
    output.push({ type: 'text-delta', index: 0, text: prefix + '\ud83d' })
    output.push({ type: 'text-delta', index: 0, text: '' })
    output.push({ type: 'text-delta', index: 0, text: '\ude00' })
    expect(output.text()).toBe(prefix + '😀')
    expect(Buffer.byteLength(output.text(), 'utf8')).toBe(MAX_GIT_AI_PLAN_BYTES)
    expect(() => output.push({ type: 'text-delta', index: 0, text: 'a' })).toThrow('大小上限')
  })

  it('推理只登记索引，不访问或保留推理正文', () => {
    const output = new GitAiPlanOutput()
    output.push({
      type: 'reasoning-delta',
      index: 0,
      get text() {
        throw new Error('不应读取推理增量')
      },
    })
    output.push({
      type: 'block-end',
      index: 0,
      block: {
        type: 'reasoning',
        get text() {
          throw new Error('不应读取推理正文')
        },
      },
    })
    output.push({ type: 'text-delta', index: 2, text: '方案' })
    expect(output.text()).toBe('方案')
  })

  it('不接受仅有推理而没有方案的响应', () => {
    const output = new GitAiPlanOutput()
    output.push({ type: 'reasoning-delta', index: 0, text: '推理' })
    expect(() => output.text()).toThrow('唯一文本方案')
  })

  it.each([-1, NaN, Infinity, 0.5])('拒绝非法块索引 %s', index => {
    const output = new GitAiPlanOutput()
    expect(() => output.push({ type: 'text-delta', index, text: '{}' })).toThrow('唯一文本方案')
  })

  it('拒绝工具、多个方案、类型混用和方案之后的新推理块', () => {
    const output = new GitAiPlanOutput()
    expect(() => output.push({ type: 'block-start', index: 0, blockType: 'tool-call' })).toThrow(
      '唯一文本方案',
    )
    output.push({ type: 'text-delta', index: 0, text: '{}' })
    expect(() => output.push({ type: 'text-delta', index: 1, text: '{}' })).toThrow('唯一文本方案')
    expect(() => output.push({ type: 'reasoning-delta', index: 0, text: '混用' })).toThrow(
      '唯一文本方案',
    )
    expect(() => output.push({ type: 'reasoning-delta', index: 1, text: '迟到' })).toThrow(
      '唯一文本方案',
    )
  })

  it('独立限制空分片总数，不用协议序列化大小代替文本预算', () => {
    const output = new GitAiPlanOutput()
    for (let index = 0; index < 128 * 1024; index++)
      output.push({ type: 'text-delta', index: 0, text: '' })
    expect(() => output.push({ type: 'text-delta', index: 0, text: '' })).toThrow('过多流式事件')
  })

  it('独立限制推理块索引数量，避免无限保留块状态', () => {
    const output = new GitAiPlanOutput()
    for (let index = 0; index < 4096; index++)
      output.push({ type: 'block-start', index, blockType: 'reasoning' })
    expect(() => output.push({ type: 'block-start', index: 4096, blockType: 'reasoning' })).toThrow(
      '过多内容块',
    )
  })
})
