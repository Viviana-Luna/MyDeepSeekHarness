// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useCallback, type RefCallback } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import {
  useConversationScroll,
  type ConversationScrollPosition,
} from '../src/renderer/src/features/conversation/useConversationScroll.ts'

interface ScrollMetrics {
  scrollHeight: number
  clientHeight: number
  anchorTop: number
}

interface ScrollHarnessProps {
  readonly sessionKey: string
  readonly headVersion: number
  readonly tailVersion: number
  readonly metrics: ScrollMetrics
  readonly positions?: Map<string, ConversationScrollPosition>
}

function rectangle(top: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    right: 100,
    bottom: top + 20,
    left: 0,
    width: 100,
    height: 20,
    toJSON: () => ({}),
  }
}

function ScrollHarness({
  sessionKey,
  headVersion,
  tailVersion,
  metrics,
  positions,
}: ScrollHarnessProps) {
  const controller = useConversationScroll({
    sessionKey,
    headVersion,
    tailVersion,
    bottomThreshold: 24,
    ...(positions === undefined ? {} : { positions }),
  })

  const assignScrollRef = useCallback<RefCallback<HTMLElement>>(
    element => {
      if (element !== null) {
        Object.defineProperties(element, {
          scrollHeight: { configurable: true, get: () => metrics.scrollHeight },
          clientHeight: { configurable: true, get: () => metrics.clientHeight },
        })
        element.getBoundingClientRect = () => rectangle(0)
      }
      controller.scrollRef.current = element
    },
    [controller.scrollRef, metrics],
  )

  const assignAnchorRef = useCallback<RefCallback<HTMLDivElement>>(
    element => {
      if (element !== null) element.getBoundingClientRect = () => rectangle(metrics.anchorTop)
    },
    [metrics],
  )

  return (
    <div>
      <section
        ref={assignScrollRef}
        aria-label="会话滚动区"
        data-at-bottom={String(controller.isAtBottom)}
        data-has-unread={String(controller.hasUnread)}
        onScroll={controller.onScroll}
      >
        <div ref={assignAnchorRef} data-testid="阅读锚点" />
      </section>
      <button type="button" onClick={controller.scrollToBottom}>
        回到最新
      </button>
      <button
        type="button"
        onClick={() => {
          controller.capturePrependAnchor(screen.getByTestId('阅读锚点'))
        }}
      >
        记录节点锚点
      </button>
      <button
        type="button"
        onClick={() => {
          controller.capturePrependAnchor()
        }}
      >
        记录高度锚点
      </button>
      <button type="button" onClick={controller.cancelPrependAnchor}>
        取消锚点
      </button>
    </div>
  )
}

afterEach(cleanup)

describe('会话最新消息滚动控制', () => {
  it('首次进入定位最新，切回已打开会话恢复阅读位置', () => {
    const positions = new Map<string, ConversationScrollPosition>()
    const metrics: ScrollMetrics = { scrollHeight: 1_000, clientHeight: 300, anchorTop: 100 }
    const view = render(
      <ScrollHarness
        sessionKey="会话甲"
        headVersion={1}
        tailVersion={10}
        metrics={metrics}
        positions={positions}
      />,
    )
    const scrollport = screen.getByRole('region', { name: '会话滚动区' })

    expect(scrollport.scrollTop).toBe(700)
    expect(scrollport.dataset.atBottom).toBe('true')
    expect(scrollport.dataset.hasUnread).toBe('false')

    scrollport.scrollTop = 120
    fireEvent.scroll(scrollport)
    view.rerender(
      <ScrollHarness
        sessionKey="会话甲"
        headVersion={1}
        tailVersion={11}
        metrics={metrics}
        positions={positions}
      />,
    )
    expect(scrollport.dataset.hasUnread).toBe('true')

    metrics.scrollHeight = 1_400
    view.rerender(
      <ScrollHarness
        sessionKey="会话乙"
        headVersion={20}
        tailVersion={30}
        metrics={metrics}
        positions={positions}
      />,
    )

    expect(scrollport.scrollTop).toBe(1_100)
    expect(scrollport.dataset.atBottom).toBe('true')
    expect(scrollport.dataset.hasUnread).toBe('false')
    view.rerender(
      <ScrollHarness
        sessionKey="会话甲"
        headVersion={1}
        tailVersion={11}
        metrics={metrics}
        positions={positions}
      />,
    )
    expect(scrollport.scrollTop).toBe(120)
    expect(scrollport.dataset.atBottom).toBe('false')
  })

  it('位于底部时跟随尾部变化，离开底部后保持阅读位置并标记未读', () => {
    const metrics: ScrollMetrics = { scrollHeight: 1_000, clientHeight: 300, anchorTop: 100 }
    const view = render(
      <ScrollHarness sessionKey="会话甲" headVersion={1} tailVersion={10} metrics={metrics} />,
    )
    const scrollport = screen.getByRole('region', { name: '会话滚动区' })

    metrics.scrollHeight = 1_180
    view.rerender(
      <ScrollHarness sessionKey="会话甲" headVersion={1} tailVersion={11} metrics={metrics} />,
    )
    expect(scrollport.scrollTop).toBe(880)
    expect(scrollport.dataset.hasUnread).toBe('false')

    scrollport.scrollTop = 240
    fireEvent.scroll(scrollport)
    metrics.scrollHeight = 1_360
    view.rerender(
      <ScrollHarness sessionKey="会话甲" headVersion={1} tailVersion={12} metrics={metrics} />,
    )

    expect(scrollport.scrollTop).toBe(240)
    expect(scrollport.dataset.atBottom).toBe('false')
    expect(scrollport.dataset.hasUnread).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: '回到最新' }))
    expect(scrollport.scrollTop).toBe(1_060)
    expect(scrollport.dataset.atBottom).toBe('true')
    expect(scrollport.dataset.hasUnread).toBe('false')
  })

  it('前插更早历史后优先保持稳定消息节点的可视位置', () => {
    const metrics: ScrollMetrics = { scrollHeight: 1_000, clientHeight: 300, anchorTop: 90 }
    const view = render(
      <ScrollHarness sessionKey="会话甲" headVersion={10} tailVersion={40} metrics={metrics} />,
    )
    const scrollport = screen.getByRole('region', { name: '会话滚动区' })
    scrollport.scrollTop = 200
    fireEvent.scroll(scrollport)
    fireEvent.click(screen.getByRole('button', { name: '记录节点锚点' }))

    // 请求尚未返回时读者仍可继续滚动；锚点应跟随新的阅读位置。
    scrollport.scrollTop = 250
    metrics.anchorTop = 40
    fireEvent.scroll(scrollport)

    metrics.scrollHeight = 1_340
    metrics.anchorTop = 380
    view.rerender(
      <ScrollHarness sessionKey="会话甲" headVersion={1} tailVersion={40} metrics={metrics} />,
    )

    expect(scrollport.scrollTop).toBe(590)
    expect(scrollport.dataset.atBottom).toBe('false')
    expect(scrollport.dataset.hasUnread).toBe('false')
  })

  it('没有稳定消息节点时使用滚动高度差保持前插位置', () => {
    const metrics: ScrollMetrics = { scrollHeight: 900, clientHeight: 300, anchorTop: 80 }
    const view = render(
      <ScrollHarness sessionKey="会话甲" headVersion={10} tailVersion={40} metrics={metrics} />,
    )
    const scrollport = screen.getByRole('region', { name: '会话滚动区' })
    scrollport.scrollTop = 160
    fireEvent.scroll(scrollport)
    fireEvent.click(screen.getByRole('button', { name: '记录高度锚点' }))

    metrics.scrollHeight = 1_150
    view.rerender(
      <ScrollHarness sessionKey="会话甲" headVersion={2} tailVersion={40} metrics={metrics} />,
    )

    expect(scrollport.scrollTop).toBe(410)
    expect(scrollport.dataset.atBottom).toBe('false')
  })
})
