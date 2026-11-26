// @vitest-environment jsdom

/**
 * 校验侧栏弹性选择指示条：前缘先冲后缘滞后追赶的纯数学轨迹、DOM 集成切换与减弱动态降级。
 */
import { cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  computeSelectionWormSpan,
  SELECTION_WORM_REST_SIZE,
} from '../src/renderer/src/shared/ui/selectionWormMath.ts'
import { useSelectionWorm } from '../src/renderer/src/shared/ui/useSelectionWorm.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

async function nextFrame(): Promise<void> {
  await new Promise(resolve => window.requestAnimationFrame(() => resolve(undefined)))
}

async function sampleMaxWormHeight(
  worm: HTMLSpanElement,
  remaining: number,
  best: number,
): Promise<number> {
  if (remaining <= 0) return best
  await nextFrame()
  const nextBest = Math.max(best, Number.parseFloat(worm.style.height))
  if (worm.style.top === '98px' && worm.style.height === '16px') return nextBest
  return sampleMaxWormHeight(worm, remaining - 1, nextBest)
}

function WormHarness({ active }: { readonly active: number }) {
  const navRef = useRef<HTMLElement>(null)
  const wormRef = useSelectionWorm({
    containerRef: navRef,
    activeSelector: 'button.is-active',
    activeKey: active,
  })
  return (
    <nav ref={navRef} style={{ position: 'relative' }}>
      <span ref={wormRef} className="test-worm" />
      {[0, 1, 2].map(index => (
        <button
          key={index}
          type="button"
          className={active === index ? 'is-active' : ''}
          ref={node => {
            if (node === null) return
            const top = index * 44
            Object.defineProperty(node, 'offsetTop', { configurable: true, value: top })
            Object.defineProperty(node, 'offsetHeight', { configurable: true, value: 36 })
            Object.defineProperty(node, 'offsetParent', {
              configurable: true,
              value: node.parentElement,
            })
          }}
        >
          项 {index}
        </button>
      ))}
    </nav>
  )
}

describe('侧栏弹性选择指示条', () => {
  it('切换方向时前缘率先抵达、后缘延迟追赶，中段拉长并最终收缩回标准高度', () => {
    const startDown = computeSelectionWormSpan({
      fromStart: 10,
      fromEnd: 26,
      toStart: 98,
      toEnd: 114,
      progress: 0,
    })
    expect(startDown.start).toBe(10)
    expect(startDown.size).toBe(SELECTION_WORM_REST_SIZE)

    const midDown = computeSelectionWormSpan({
      fromStart: 10,
      fromEnd: 26,
      toStart: 98,
      toEnd: 114,
      progress: 0.45,
    })
    expect(midDown.start).toBeLessThan(30)
    expect(midDown.end).toBeGreaterThan(95)
    expect(midDown.size).toBeGreaterThan(SELECTION_WORM_REST_SIZE * 3)

    const endDown = computeSelectionWormSpan({
      fromStart: 10,
      fromEnd: 26,
      toStart: 98,
      toEnd: 114,
      progress: 1,
    })
    expect(endDown).toEqual({ start: 98, end: 114, size: SELECTION_WORM_REST_SIZE })

    const midUp = computeSelectionWormSpan({
      fromStart: 98,
      fromEnd: 114,
      toStart: 10,
      toEnd: 26,
      progress: 0.45,
    })
    expect(midUp.start).toBeLessThan(30)
    expect(midUp.end).toBeGreaterThan(90)
    expect(midUp.size).toBeGreaterThan(SELECTION_WORM_REST_SIZE * 3)
  })

  it('在真实组件中切换选中项时先伸展再收缩到目标位置，开启减少动态时直接落位', async () => {
    const view = render(<WormHarness active={0} />)
    const worm = view.container.querySelector<HTMLSpanElement>('.test-worm')!
    expect(worm.style.top).toBe('10px')
    expect(worm.style.height).toBe('16px')

    view.rerender(<WormHarness active={2} />)
    const maxHeight = await sampleMaxWormHeight(worm, 40, 16)
    expect(maxHeight).toBeGreaterThan(40)
    expect(worm.style.top).toBe('98px')
    expect(worm.style.height).toBe('16px')

    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    view.rerender(<WormHarness active={0} />)
    expect(worm.style.top).toBe('10px')
    expect(worm.style.height).toBe('16px')
  })
})
