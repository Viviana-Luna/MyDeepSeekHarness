// @vitest-environment jsdom

/** 验证真实分片的平滑显示、立即收口和无障碍降级。 */
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnimatedSummary } from '../src/renderer/src/features/conversation/AnimatedSummary.tsx'
import { useStreamingReveal } from '../src/renderer/src/features/conversation/useStreamingReveal.ts'

let callbacks: Map<number, FrameRequestCallback>
let nextId: number
let now: number
let reduced: boolean
let onChange: (() => void) | undefined

function nextFrame() {
  const pending = [...callbacks.values()]
  callbacks.clear()
  now += 16
  act(() => pending.forEach(callback => callback(now)))
}

beforeEach(() => {
  callbacks = new Map()
  nextId = 0
  now = 0
  reduced = false
  onChange = undefined
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++nextId
    callbacks.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id))
  vi.stubGlobal('matchMedia', () => ({
    get matches() {
      return reduced
    },
    addEventListener: (_: string, callback: () => void) => {
      onChange = callback
    },
    removeEventListener: () => {
      onChange = undefined
    },
  }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('对话数据显现', () => {
  it('逐帧追赶真实分片，不拆开 emoji，并在最终消息到达时立即显示全文', () => {
    const text = '👩‍💻正在读取真实文件并整理结果'
    const view = renderHook(({ value, streaming }) => useStreamingReveal(value, streaming), {
      initialProps: { value: text, streaming: true },
    })
    expect(view.result.current).toBe('')
    nextFrame()
    expect(view.result.current.startsWith('👩‍💻')).toBe(true)
    expect(view.result.current.length).toBeLessThan(text.length)
    view.rerender({ value: `${text}，继续处理`, streaming: true })
    for (let index = 0; index < 16; index += 1) nextFrame()
    expect(view.result.current).toBe(`${text}，继续处理`)
    view.rerender({ value: '最终回答', streaming: false })
    expect(view.result.current).toBe('最终回答')
    expect(callbacks.size).toBe(0)
  })

  it('内容被替换、动态效果被关闭或组件卸载时不保留旧帧', () => {
    const view = renderHook(({ value }) => useStreamingReveal(value, true), {
      initialProps: { value: '第一份内容正在输出' },
    })
    nextFrame()
    view.rerender({ value: '新的回答' })
    expect(view.result.current).toBe('新的回答')
    view.rerender({ value: '新的回答继续增长' })
    reduced = true
    act(() => onChange?.())
    expect(view.result.current).toBe('新的回答继续增长')
    expect(callbacks.size).toBe(0)
    view.unmount()
    expect(onChange).toBeUndefined()
  })

  it('减少动态时立即显示全文，卸载时取消尚未执行的帧', () => {
    reduced = true
    const accessible = renderHook(() => useStreamingReveal('完整内容', true))
    expect(accessible.result.current).toBe('完整内容')
    expect(callbacks.size).toBe(0)
    accessible.unmount()
    reduced = false
    const animated = renderHook(() => useStreamingReveal('尚未显示的较长内容', true))
    expect(callbacks.size).toBe(1)
    animated.unmount()
    expect(callbacks.size).toBe(0)
  })

  it('历史摘要直接呈现，实时摘要复用已有字符并只给新增字符添加动效', () => {
    const old = render(<AnimatedSummary text="旧摘要" active={false} />)
    expect(old.container.textContent).toBe('旧摘要')
    expect(old.container.querySelector('[aria-hidden="true"]')).toBeNull()
    old.unmount()

    const view = render(<AnimatedSummary text="读取" active />)
    const original = view.container.querySelector('[aria-hidden="true"] span')
    view.rerender(<AnimatedSummary text="读取文件" active />)
    const characters = view.container.querySelectorAll('[aria-hidden="true"] span')
    expect(characters).toHaveLength(4)
    expect(characters[0]).toBe(original)
    expect(view.container.querySelector('.visually-hidden')?.textContent).toBe('读取文件')
  })
})
