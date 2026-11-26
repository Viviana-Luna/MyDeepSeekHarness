// @vitest-environment jsdom

/** 验证等待模型回复时的中文加载小笑话清单、洗牌防撞车算法及 ConversationView 轮换与降级行为。 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationView } from '../src/renderer/src/features/conversation/ConversationView.tsx'
import {
  createQuipOrder,
  LOADING_QUIP_INTERVAL_MS,
  LOADING_QUIPS,
} from '../src/renderer/src/features/conversation/loading-quips.ts'

function createSessionEvent(
  type: string,
  seq: number,
  time: number,
  data: unknown,
): Record<string, unknown> {
  return { type, seq, time, data }
}

interface MockMediaQueryList extends MediaQueryList {
  setMatches(next: boolean): void
}

let originalMatchMediaDescriptor: PropertyDescriptor | undefined
let originalHiddenDescriptor: PropertyDescriptor | undefined

function mockReducedMotion(initialMatches: boolean): MockMediaQueryList {
  originalMatchMediaDescriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia')
  let matches = initialMatches
  const listeners = new Set<EventListenerOrEventListenerObject>()
  const list = {
    media: '(prefers-reduced-motion: reduce)',
    get matches() {
      return matches
    },
    onchange: null,
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.add(listener)
    },
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.delete(listener)
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
    setMatches(next: boolean) {
      matches = next
      const event = { matches: next, media: list.media } as MediaQueryListEvent
      for (const listener of listeners) {
        if (typeof listener === 'function') listener(event)
        else listener.handleEvent(event)
      }
    },
  } as unknown as MockMediaQueryList

  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => list),
  })
  return list
}

function setDocumentHidden(hidden: boolean): void {
  if (originalHiddenDescriptor === undefined) {
    originalHiddenDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden')
  }
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden,
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  if (originalMatchMediaDescriptor === undefined) {
    Reflect.deleteProperty(window, 'matchMedia')
  } else {
    Object.defineProperty(window, 'matchMedia', originalMatchMediaDescriptor)
  }
  originalMatchMediaDescriptor = undefined
  if (originalHiddenDescriptor !== undefined) {
    Object.defineProperty(document, 'hidden', originalHiddenDescriptor)
    originalHiddenDescriptor = undefined
  }
  vi.restoreAllMocks()
})

describe('对话加载小笑话', () => {
  it('全部 38 条加载小笑话非空、无重复且不含敏感状态词或旧品牌缩写', () => {
    expect(LOADING_QUIPS).toHaveLength(38)
    expect(LOADING_QUIPS.filter(quip => quip.includes('大白饭'))).toHaveLength(5)
    expect(LOADING_QUIPS).toContain('燃咖啡机，启动！')
    const unique = new Set(LOADING_QUIPS)
    expect(unique.size).toBe(LOADING_QUIPS.length)

    for (const quip of LOADING_QUIPS) {
      expect(quip.trim().length).toBeGreaterThan(0)
      expect(quip).not.toMatch(/正在思考|失败|错误|DSH/iu)
    }
  })

  it('createQuipOrder 覆盖全集且在跨轮边界绝不与上轮末项撞车', () => {
    expect(createQuipOrder(0)).toEqual([])
    expect(createQuipOrder(1, 0)).toEqual([0])

    const fullOrder = createQuipOrder(LOADING_QUIPS.length)
    expect(fullOrder).toHaveLength(LOADING_QUIPS.length)
    expect(fullOrder.toSorted((a, b) => a - b)).toEqual(
      Array.from({ length: LOADING_QUIPS.length }, (_, index) => index),
    )

    // 即使随机源始终返回极值，带 avoidFirst 的新一轮首项也必须避开上轮末项。
    for (const avoid of [0, 1, 15, LOADING_QUIPS.length - 1]) {
      for (const constantRandom of [() => 0, () => 0.999_999]) {
        const order = createQuipOrder(LOADING_QUIPS.length, avoid, constantRandom)
        expect(order).toHaveLength(LOADING_QUIPS.length)
        expect(order[0]).not.toBe(avoid)
        expect(new Set(order).size).toBe(LOADING_QUIPS.length)
      }
    }

    let previousLast: number | undefined
    for (let round = 0; round < 6; round += 1) {
      const order = createQuipOrder(8, previousLast)
      if (previousLast !== undefined) expect(order[0]).not.toBe(previousLast)
      previousLast = order.at(-1)
    }
  })

  it('在 pendingSend 与等待回复态展示加载小笑话，按间隔平滑换句并保留无障碍状态文案', () => {
    vi.useFakeTimers()
    mockReducedMotion(false)

    const view = render(<ConversationView pendingSend history={[]} />)
    const status = screen.getByRole('status')
    expect(status.textContent).toContain('正在构思回复…')

    const readQuip = () => {
      const node = view.container.querySelector<HTMLElement>('[data-loading-quip="true"]')
      expect(node).not.toBeNull()
      expect(node?.getAttribute('aria-hidden')).toBe('true')
      return node?.textContent ?? ''
    }

    const first = readQuip()
    expect(LOADING_QUIPS).toContain(first)

    act(() => {
      vi.advanceTimersByTime(LOADING_QUIP_INTERVAL_MS)
    })
    const second = readQuip()
    expect(LOADING_QUIPS).toContain(second)
    expect(second).not.toBe(first)

    // 页面隐藏时暂停轮换，恢复可见后继续按间隔换句。
    act(() => {
      setDocumentHidden(true)
      vi.advanceTimersByTime(LOADING_QUIP_INTERVAL_MS * 3)
    })
    expect(readQuip()).toBe(second)

    act(() => {
      setDocumentHidden(false)
      vi.advanceTimersByTime(LOADING_QUIP_INTERVAL_MS)
    })
    const third = readQuip()
    expect(LOADING_QUIPS).toContain(third)
    expect(third).not.toBe(second)

    // 思考块结束、正文未到前的生成态同样保留「生成中」无障碍文案并渲染加载笑话。
    const generatingHistory = [
      createSessionEvent('turn/start', 1, 100, { turn: 1 }),
      createSessionEvent('step/start', 2, 110, { turn: 1, step: 1 }),
      createSessionEvent('user/message', 3, 120, {
        source: { kind: 'user' },
        content: [{ type: 'text', text: '测试等待状态' }],
      }),
      createSessionEvent('assistant/chunk', 4, 130, {
        turn: 1,
        step: 1,
        chunk: { type: 'reasoning-delta', index: 0, text: '先核对' },
      }),
      createSessionEvent('assistant/chunk', 5, 140, {
        turn: 1,
        step: 1,
        chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: '先核对' } },
      }),
    ]
    view.rerender(<ConversationView history={generatingHistory} running />)
    expect(screen.getByRole('status').textContent).toContain('生成中')
    expect(LOADING_QUIPS).toContain(readQuip())
  })

  it('系统开启减少动态时固定首句不自动轮换，存在重试状态时回退真实重试提示', () => {
    vi.useFakeTimers()
    mockReducedMotion(true)

    const waitingHistory = [
      createSessionEvent('turn/start', 1, 1_700_000_000_000, { turn: 1 }),
      createSessionEvent('step/start', 2, 1_700_000_000_050, { turn: 1, step: 1 }),
      createSessionEvent('user/message', 3, 1_700_000_000_100, {
        source: { kind: 'user' },
        content: [{ type: 'text', text: '帮我查一下' }],
      }),
    ]
    const view = render(<ConversationView history={waitingHistory} running />)
    const initialQuip = view.container.querySelector('[data-loading-quip="true"]')?.textContent
    expect(LOADING_QUIPS).toContain(initialQuip)
    expect(screen.getByRole('status').textContent).toContain('正在构思回复…')

    act(() => {
      vi.advanceTimersByTime(LOADING_QUIP_INTERVAL_MS * 4)
    })
    expect(view.container.querySelector('[data-loading-quip="true"]')?.textContent).toBe(
      initialQuip,
    )

    const retryHistory = [
      ...waitingHistory,
      createSessionEvent('llm/retry', 4, 1_700_000_000_200, {
        turn: 1,
        step: 1,
        retryId: '重试-1',
        retry: 2,
        maxRetries: 4,
        delayMs: 3000,
        failure: { code: 'NETWORK', message: '连接短暂断开' },
      }),
    ]
    view.rerender(<ConversationView history={retryHistory} running />)
    expect(view.container.querySelector('[data-loading-quip="true"]')).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('正在重试请求（2 / 4）')
  })
})
