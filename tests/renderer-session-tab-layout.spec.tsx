// @vitest-environment jsdom
/** 验证 renderer 标签宽度与标题居中；材质替身只隔离绘制，不替代真实视觉验收。 */
import { readFileSync } from 'node:fs'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionTabGlass } from '../src/renderer/src/pages/workspace/components/topbar/useSessionTabGlass.ts'

const mocks = vi.hoisted(() => ({
  stripWidth: 1006,
  frameWidth: 1006,
  resize: null as (() => void) | null,
  disconnect: vi.fn(),
  destroy: vi.fn(),
}))
vi.mock('liquid-glass-web-react', () => ({
  LiquidGlassEngine: class {
    setOptions() {}
    setPosition() {}
    destroy() {
      mocks.destroy()
    }
  },
}))

function TabLayout({ count }: { count: number }) {
  const glass = useSessionTabGlass(true, null, String(count), vi.fn())
  return (
    <div className="session-tabs-frame" data-overflow={glass.overflow || undefined}>
      <div
        className="session-tabs"
        ref={glass.stripRef}
        style={{ paddingLeft: 3, paddingRight: 3 }}
      >
        <div ref={glass.rootRef} data-testid="标签宽度">
          <div ref={glass.materialRef} />
          <div ref={glass.defsRef} />
          <div ref={glass.lensRef} />
          {Array.from({ length: count }, (_, index) => (
            <div data-tab-unit={String(index)} key={index}>
              <div className="session-tab-shell">
                <button className="session-tab" aria-selected="false" type="button">
                  标签 {index + 1}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function readTabWidth() {
  return Number.parseFloat(
    screen.getByTestId('标签宽度').style.getPropertyValue('--session-tab-width'),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.stripWidth = 1006
  mocks.frameWidth = 1006
  mocks.resize = null
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        mocks.resize = callback
      }
      observe() {}
      disconnect() {
        mocks.disconnect()
      }
    },
  )
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
    return this.classList.contains('session-tabs') ? mocks.stripWidth : 0
  })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const width = this.classList.contains('session-tabs-frame') ? mocks.frameWidth : 0
    return { width, left: 0, right: width, top: 0, bottom: 26, height: 26 } as DOMRect
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('标签轨道自适应铺满', () => {
  it('图标与标题整体居中，预览固定入口和未读状态不改变对称留白', () => {
    const style = document.createElement('style')
    style.textContent = readFileSync(
      'src/renderer/src/pages/workspace/components/topbar/session-tabs.css',
      'utf8',
    )
    document.head.append(style)
    try {
      render(<TabLayout count={2} />)
      const tab = screen.getAllByRole('button')[0]!
      const normal = getComputedStyle(tab)
      expect(normal.justifyContent).toBe('center')
      expect(normal.paddingLeft).toBe('28px')
      expect(normal.paddingRight).toBe('28px')
      tab.parentElement!.dataset.preview = 'true'
      const preview = getComputedStyle(tab)
      expect(preview.paddingLeft).toBe(preview.paddingRight)
      const unread = document.createElement('i')
      unread.className = 'session-tab-unread'
      tab.append(unread)
      const updated = getComputedStyle(tab)
      expect(updated.paddingLeft).toBe(updated.paddingRight)
      expect(updated.justifyContent).toBe('center')
    } finally {
      style.remove()
    }
  })

  it('少量标签铺满，多标签等比收窄，达到 96px 后才溢出', () => {
    const view = render(<TabLayout count={2} />)
    expect(readTabWidth()).toBe(500)
    view.rerender(<TabLayout count={5} />)
    expect(readTabWidth()).toBe(200)
    view.rerender(<TabLayout count={10} />)
    expect(readTabWidth()).toBe(100)
    expect(view.container.querySelector('[data-overflow]')).toBeNull()
    view.rerender(<TabLayout count={11} />)
    expect(readTabWidth()).toBe(96)
    expect(view.container.querySelector('[data-overflow]')).toBeTruthy()
  })

  it('窗口放大后收起多余滚动按钮并重新铺满，卸载时清理观察器和材质', () => {
    mocks.stripWidth = 646
    mocks.frameWidth = 706
    const view = render(<TabLayout count={8} />)
    expect(readTabWidth()).toBe(96)
    expect(view.container.querySelector('[data-overflow]')).toBeTruthy()
    mocks.frameWidth = 806
    mocks.stripWidth = 746
    act(() => {
      mocks.resize?.()
    })
    expect(view.container.querySelector('[data-overflow]')).toBeNull()
    mocks.stripWidth = 806
    act(() => {
      mocks.resize?.()
    })
    expect(readTabWidth()).toBe(100)
    view.unmount()
    expect(mocks.disconnect).toHaveBeenCalledOnce()
    expect(mocks.destroy).toHaveBeenCalledOnce()
  })
})
