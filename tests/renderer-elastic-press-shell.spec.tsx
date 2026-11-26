// @vitest-environment jsdom

/**
 * 校验弹性按压外壳与 IconButton 的交互接线：零多余 DOM 包装、安全捕获不破坏点击、
 * 轻点脉冲与回弹归零、大距离或越界拖动吞掉误触而不泄漏、异常中断不卡死，以及镜像滑块联动。
 */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { ElasticPress } from '../src/renderer/src/shared/ui/ElasticPress.tsx'
import { IconButton } from '../src/renderer/src/shared/ui/IconButton.tsx'

let captureLog: Array<{ element: Element; pointerId: number }> = []

beforeAll(() => {
  Object.defineProperties(window.HTMLElement.prototype, {
    setPointerCapture: {
      configurable: true,
      value(this: Element, pointerId: number) {
        captureLog.push({ element: this, pointerId })
      },
    },
    releasePointerCapture: { configurable: true, value: () => undefined },
    hasPointerCapture: { configurable: true, value: () => false },
  })
  Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 34,
  })
  Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 34,
  })
  Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left: 0,
      top: 0,
      right: 34,
      bottom: 34,
      width: 34,
      height: 34,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  })
})

afterEach(() => {
  cleanup()
  captureLog = []
})

/** 等一帧，让动画循环推进一次。 */
async function nextFrame(): Promise<void> {
  await new Promise(resolve => window.requestAnimationFrame(() => resolve(undefined)))
}

/** 等到动画完全收尾清除或达到上限帧数；超时未收敛交由后续断言报错。 */
async function waitUntilSettled(element: HTMLElement, remainingFrames = 150): Promise<void> {
  if (remainingFrames <= 0) return
  await nextFrame()
  if (element.dataset.press === undefined && element.style.transform === '') return
  await waitUntilSettled(element, remainingFrames - 1)
}

/** 连续推帧直到满足断言条件，避免测试中出现循环等待告警。 */
async function waitForCondition(predicate: () => boolean, remainingFrames = 60): Promise<boolean> {
  if (predicate()) return true
  if (remainingFrames <= 0) return false
  await nextFrame()
  return waitForCondition(predicate, remainingFrames - 1)
}

/** 在 jsdom 中构造携带完整 pointerId、pointerType 与坐标的指针事件并派发。 */
function dispatchPointer(
  target: Window | Document | Node | Element,
  type:
    'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel' | 'pointerover' | 'pointerout',
  options: {
    pointerId?: number
    pointerType?: string
    clientX?: number
    clientY?: number
    button?: number
    relatedTarget?: EventTarget | null
  } = {},
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: options.clientX ?? 16,
    clientY: options.clientY ?? 16,
    button: options.button ?? 0,
    relatedTarget: options.relatedTarget ?? null,
  })
  Object.defineProperties(event, {
    pointerId: { value: options.pointerId ?? 1 },
    pointerType: { value: options.pointerType ?? 'mouse' },
    isPrimary: { value: true },
  })
  fireEvent(target, event)
}

function MirrorHost({ onClick }: { onClick?: () => void }) {
  const mirrorRef = useRef<HTMLSpanElement>(null)
  return (
    <div>
      <span ref={mirrorRef} className="view-tabs__indicator" />
      <ElasticPress mirrorRef={mirrorRef}>
        <button type="button" onClick={onClick}>
          对话
        </button>
      </ElasticPress>
    </div>
  )
}

describe('弹性按压外壳与共享图标按钮', () => {
  it('单元素直出不插入多余 span，按下变形并在松手收敛后清空样式', async () => {
    const { container } = render(
      <ElasticPress>
        <button type="button" className="send-button">
          发送
        </button>
      </ElasticPress>,
    )
    expect(container.querySelector('span')).toBeNull()
    const button = container.querySelector<HTMLButtonElement>('button.send-button')!

    dispatchPointer(button, 'pointerdown', { pointerId: 1, clientX: 16, clientY: 16 })
    await nextFrame()
    expect(button.dataset.press).toBe('active')
    expect(button.style.transform).toMatch(/scale/)

    dispatchPointer(window, 'pointerup', { pointerId: 1, clientX: 16, clientY: 16 })
    await waitUntilSettled(button)
    expect(button.dataset.press).toBeUndefined()
    expect(button.style.transform).toBe('')
  })

  it('轻微滑动仍在阈值与控件范围内时照常触发点击，仅在明显拖动后请求捕获', async () => {
    const onClick = vi.fn()
    const { container } = render(
      <ElasticPress>
        <button type="button" onClick={onClick}>
          发送
        </button>
      </ElasticPress>,
    )
    const button = container.querySelector<HTMLButtonElement>('button')!

    dispatchPointer(button, 'pointerdown', { pointerId: 1, clientX: 16, clientY: 16 })
    expect(captureLog).toHaveLength(0)

    dispatchPointer(window, 'pointermove', { pointerId: 1, clientX: 25, clientY: 18 })
    expect(captureLog).toEqual([{ element: button, pointerId: 1 }])

    dispatchPointer(window, 'pointerup', { pointerId: 1, clientX: 25, clientY: 18 })
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('大幅拖动或松手越界时吞掉点击，且抑制标记会在下一轮任务过期不误伤后续点击', async () => {
    const onClick = vi.fn()
    const { container } = render(
      <ElasticPress>
        <button type="button" onClick={onClick}>
          发送
        </button>
      </ElasticPress>,
    )
    const button = container.querySelector<HTMLButtonElement>('button')!

    dispatchPointer(button, 'pointerdown', { pointerId: 1, clientX: 16, clientY: 16 })
    dispatchPointer(window, 'pointermove', { pointerId: 1, clientX: 44, clientY: 16 })
    dispatchPointer(window, 'pointerup', { pointerId: 1, clientX: 44, clientY: 16 })
    fireEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()

    // 模拟松手未紧跟 click（例如鼠标移到窗外松开）
    dispatchPointer(button, 'pointerdown', { pointerId: 2, clientX: 16, clientY: 16 })
    dispatchPointer(window, 'pointerup', { pointerId: 2, clientX: 60, clientY: 16 })
    await new Promise(resolve => window.setTimeout(resolve, 10))
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('Escape 或窗口失焦会立即结束拖动回弹且不吞掉下一次点击', async () => {
    const onClick = vi.fn()
    const { container } = render(
      <ElasticPress>
        <button type="button" onClick={onClick}>
          工具
        </button>
      </ElasticPress>,
    )
    const button = container.querySelector<HTMLButtonElement>('button')!

    dispatchPointer(button, 'pointerdown', { pointerId: 3, clientX: 16, clientY: 16 })
    dispatchPointer(window, 'pointermove', { pointerId: 3, clientX: 36, clientY: 16 })
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitUntilSettled(button)
    expect(button.dataset.press).toBeUndefined()
    expect(button.style.transform).toBe('')

    dispatchPointer(button, 'pointerdown', { pointerId: 4, clientX: 16, clientY: 16 })
    dispatchPointer(window, 'pointermove', { pointerId: 4, clientX: 30, clientY: 16 })
    fireEvent(window, new Event('blur'))
    await waitUntilSettled(button)
    expect(button.style.transform).toBe('')

    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('镜像节点与 IconButton 同样跟随形变、支持轻点脉冲并在停止后复位', async () => {
    const onClick = vi.fn()
    const { container } = render(
      <>
        <MirrorHost />
        <IconButton label="更多" onClick={onClick}>
          <span>+</span>
        </IconButton>
      </>,
    )
    const indicator = container.querySelector<HTMLSpanElement>('.view-tabs__indicator')!
    const tabButton = container.querySelectorAll<HTMLButtonElement>('button')[0]!
    const iconButton = container.querySelector<HTMLButtonElement>('button.icon-button')!

    dispatchPointer(tabButton, 'pointerdown', { pointerId: 5, clientX: 16, clientY: 16 })
    await nextFrame()
    expect(indicator.style.transform).toBe(tabButton.style.transform)
    dispatchPointer(window, 'pointerup', { pointerId: 5, clientX: 16, clientY: 16 })
    await waitUntilSettled(tabButton)
    expect(indicator.style.transform).toBe('')

    // 快速轻点依然继续推升至接近 0.975 峰值后再回弹，且不影响点击
    dispatchPointer(iconButton, 'pointerdown', { pointerId: 6, clientX: 16, clientY: 16 })
    dispatchPointer(window, 'pointerup', { pointerId: 6, clientX: 16, clientY: 16 })
    fireEvent.click(iconButton)
    expect(onClick).toHaveBeenCalledTimes(1)
    let peakScale = 1
    await waitForCondition(() => {
      const match = iconButton.style.transform.match(/scale\(([^,]+),/)
      if (match) peakScale = Math.max(peakScale, Number(match[1]))
      return iconButton.dataset.press === undefined && iconButton.style.transform === ''
    }, 150)
    expect(peakScale).toBeGreaterThan(1.2)
    expect(iconButton.style.transform).toBe('')
  })

  it('仅显式开启 hoverSwell 时鼠标悬停轻盈预抬升、触摸不触发悬停、默认按钮保持静态尺寸', async () => {
    const { container } = render(
      <div>
        <ElasticPress>
          <button type="button" className="compact-tool">
            紧凑工具
          </button>
        </ElasticPress>
        <ElasticPress hoverSwell>
          <button type="button" className="send-button">
            发送
          </button>
        </ElasticPress>
      </div>,
    )
    const compact = container.querySelector<HTMLButtonElement>('button.compact-tool')!
    const button = container.querySelector<HTMLButtonElement>('button.send-button')!

    dispatchPointer(compact, 'pointerover', { pointerId: 6, pointerType: 'mouse' })
    await nextFrame()
    expect(compact.dataset.press).toBeUndefined()
    expect(compact.style.transform).toBe('')

    dispatchPointer(button, 'pointerover', { pointerId: 7, pointerType: 'touch' })
    await nextFrame()
    expect(button.dataset.press).toBeUndefined()
    expect(button.style.transform).toBe('')

    dispatchPointer(button, 'pointerover', { pointerId: 8, pointerType: 'mouse' })
    const hovered = await waitForCondition(() => {
      const match = button.style.transform.match(/scale\(([^,]+),/)
      return match !== null && Number(match[1]) > 1.08
    })
    expect(hovered).toBe(true)
    expect(button.dataset.press).toBe('hover')

    dispatchPointer(button, 'pointerdown', { pointerId: 8, clientX: 16, clientY: 16 })
    await nextFrame()
    expect(button.dataset.press).toBe('active')
    dispatchPointer(window, 'pointerup', { pointerId: 8, clientX: 16, clientY: 16 })

    const settledToHover = await waitForCondition(() => {
      const match = button.style.transform.match(/scale\(([^,]+),/)
      return (
        button.dataset.press === 'hover' &&
        match !== null &&
        Math.abs(Number(match[1]) - 1.1) < 0.01 &&
        /scale\(1\.1/.test(button.style.transform)
      )
    }, 200)
    expect(settledToHover).toBe(true)
    expect(button.style.transform).toMatch(/scale\(1\.1/)

    dispatchPointer(button, 'pointerout', { pointerId: 8, relatedTarget: document.body })
    await waitUntilSettled(button)
    expect(button.dataset.press).toBeUndefined()
    expect(button.style.transform).toBe('')
  })

  it('镜像滑块从旧项切向新项时立即解除旧绑定，且稳定引用重渲染不反复解绑挂接', async () => {
    const outerRefSpy = vi.fn()
    function SwitchMirrorHost({ activeIndex, tick }: { activeIndex: number; tick: number }) {
      const mirrorRef = useRef<HTMLSpanElement>(null)
      return (
        <div data-tick={tick}>
          <span ref={mirrorRef} className="view-tabs__indicator" />
          {[0, 1].map(index => (
            <ElasticPress
              key={index}
              hoverSwell
              ref={index === 0 ? outerRefSpy : undefined}
              mirrorRef={activeIndex === index ? mirrorRef : undefined}
            >
              <button type="button" data-index={index}>
                项 {index}
              </button>
            </ElasticPress>
          ))}
        </div>
      )
    }

    const view = render(<SwitchMirrorHost activeIndex={1} tick={0} />)
    const indicator = view.container.querySelector<HTMLSpanElement>('.view-tabs__indicator')!
    const first = view.container.querySelector<HTMLButtonElement>('button[data-index="0"]')!
    const second = view.container.querySelector<HTMLButtonElement>('button[data-index="1"]')!
    const initialCalls = outerRefSpy.mock.calls.length

    view.rerender(<SwitchMirrorHost activeIndex={1} tick={1} />)
    expect(outerRefSpy).toHaveBeenCalledTimes(initialCalls)

    dispatchPointer(second, 'pointerover', { pointerId: 12, pointerType: 'mouse' })
    await nextFrame()
    expect(indicator.style.transform).toMatch(/scale/)

    dispatchPointer(second, 'pointerout', { pointerId: 12, relatedTarget: document.body })
    view.rerender(<SwitchMirrorHost activeIndex={0} tick={2} />)
    expect(indicator.style.transform).toBe('')

    dispatchPointer(first, 'pointerover', { pointerId: 12, pointerType: 'mouse' })
    await nextFrame()
    expect(indicator.style.transform).toMatch(/scale/)
    await waitUntilSettled(second)
    expect(indicator.style.transform).toMatch(/scale/)
  })
})
