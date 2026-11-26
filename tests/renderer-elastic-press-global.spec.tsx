// @vitest-environment jsdom

/**
 * 校验全局弹性按压委托：自动覆盖应用内各类常规按钮、Ant Design 按钮及内嵌小图标，
 * 准确避让显式托管控件、窗口控制键、会话标签、面板分隔柄与列表/菜单行，并保留原有 CSS transform。
 */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { ElasticPress } from '../src/renderer/src/shared/ui/ElasticPress.tsx'
import {
  classifyGlobalPressTarget,
  findGlobalElasticTarget,
  installGlobalElasticPress,
} from '../src/renderer/src/shared/ui/elasticPressGlobal.ts'

beforeAll(() => {
  Object.defineProperties(window.HTMLElement.prototype, {
    setPointerCapture: { configurable: true, value: () => undefined },
    releasePointerCapture: { configurable: true, value: () => undefined },
    hasPointerCapture: { configurable: true, value: () => false },
  })
  Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() {
      return Number((this as HTMLElement).dataset.mockWidth ?? 36)
    },
  })
  Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return Number((this as HTMLElement).dataset.mockHeight ?? 32)
    },
  })
  Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left: 0,
      top: 0,
      right: 36,
      bottom: 32,
      width: 36,
      height: 32,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  })
})

let uninstall: (() => void) | null = null

afterEach(() => {
  uninstall?.()
  uninstall = null
  cleanup()
  vi.restoreAllMocks()
})

async function nextFrame(): Promise<void> {
  await new Promise(resolve => window.requestAnimationFrame(() => resolve(undefined)))
}

async function waitUntilSettled(element: HTMLElement, remainingFrames = 150): Promise<void> {
  if (remainingFrames <= 0) return
  await nextFrame()
  if (element.dataset.press === undefined && element.style.transform === '') return
  await waitUntilSettled(element, remainingFrames - 1)
}

function dispatchPointer(
  target: Window | Document | Node | Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointerover' | 'pointerout',
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

describe('全局两级按压委托', () => {
  it('圆形/图标按钮与胶囊悬停保持占位且按压弹性回弹，常规矩形表单按钮走 iOS 轻压着色而不形变', async () => {
    uninstall = installGlobalElasticPress()
    const onRefresh = vi.fn()
    const onSave = vi.fn()
    const onTabClose = vi.fn()
    const { container } = render(
      <div>
        <button type="button" className="ant-btn ant-btn-icon-only" onClick={onRefresh}>
          <span>↻</span>
        </button>
        <button type="button" className="settings-button" onClick={onSave}>
          <span>保存设置</span>
        </button>
        <div className="session-tab-shell">
          <button type="button" className="session-tab">
            会话一
          </button>
          <button type="button" className="session-tab-close" onClick={onTabClose}>
            ×
          </button>
        </div>
      </div>,
    )

    const iconBtn = container.querySelector<HTMLButtonElement>('.ant-btn-icon-only')!
    const iconSpan = iconBtn.querySelector('span')!
    const saveBtn = container.querySelector<HTMLButtonElement>('.settings-button')!
    const closeBtn = container.querySelector<HTMLButtonElement>('.session-tab-close')!

    // 全局紧凑弹性按钮悬停保持原始占位尺寸不互相挤占，按下即触发弹性缩放，松手干净回零
    dispatchPointer(iconSpan, 'pointerover', { pointerId: 1, relatedTarget: document.body })
    await nextFrame()
    expect(iconBtn.dataset.press).toBeUndefined()
    expect(iconBtn.style.transform).toBe('')

    dispatchPointer(iconSpan, 'pointerdown', { pointerId: 1, clientX: 16, clientY: 16 })
    await nextFrame()
    expect(iconBtn.dataset.press).toBe('active')
    expect(iconBtn.style.transform).toMatch(/scale/)

    dispatchPointer(window, 'pointermove', { pointerId: 1, clientX: 24, clientY: 18 })
    dispatchPointer(window, 'pointerup', { pointerId: 1, clientX: 24, clientY: 18 })
    fireEvent.click(iconBtn)
    expect(onRefresh).toHaveBeenCalledTimes(1)
    await waitUntilSettled(iconBtn)
    expect(iconBtn.dataset.press).toBeUndefined()
    expect(iconBtn.style.transform).toBe('')

    // 常规设置按钮走 PressLook.tint：按下仅加浅/淡出标记，绝不做弹性缩放
    dispatchPointer(saveBtn, 'pointerover', { pointerId: 2, relatedTarget: document.body })
    await nextFrame()
    expect(saveBtn.dataset.press).toBeUndefined()
    dispatchPointer(saveBtn, 'pointerdown', { pointerId: 2, clientX: 16, clientY: 16 })
    expect(saveBtn.dataset.pressTint).toBe('active')
    expect(saveBtn.style.transform).toBe('')
    dispatchPointer(window, 'pointerup', { pointerId: 2, clientX: 16, clientY: 16 })
    fireEvent.click(saveBtn)
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(saveBtn.dataset.pressTint).toBe('idle')
    await new Promise(resolve => window.setTimeout(resolve, 310))
    expect(saveBtn.dataset.pressTint).toBeUndefined()

    // 大幅拖动关闭按钮则屏蔽误触
    dispatchPointer(closeBtn, 'pointerdown', { pointerId: 3, clientX: 16, clientY: 16 })
    await nextFrame()
    expect(closeBtn.dataset.press).toBe('active')
    dispatchPointer(window, 'pointermove', { pointerId: 3, clientX: 48, clientY: 16 })
    dispatchPointer(window, 'pointerup', { pointerId: 3, clientX: 48, clientY: 16 })
    fireEvent.click(closeBtn)
    expect(onTabClose).not.toHaveBeenCalled()
    await waitUntilSettled(closeBtn)
    expect(closeBtn.style.transform).toBe('')
  })

  it('连续快切两个按钮时互不抢占，都能各自完整回弹归零', async () => {
    uninstall = installGlobalElasticPress()
    const { container } = render(
      <div>
        <button type="button" id="first">
          一
        </button>
        <button type="button" id="second">
          二
        </button>
      </div>,
    )
    const first = container.querySelector<HTMLButtonElement>('#first')!
    const second = container.querySelector<HTMLButtonElement>('#second')!

    dispatchPointer(first, 'pointerdown', { pointerId: 10, clientX: 16, clientY: 16 })
    await nextFrame()
    dispatchPointer(window, 'pointerup', { pointerId: 10, clientX: 16, clientY: 16 })

    dispatchPointer(second, 'pointerdown', { pointerId: 11, clientX: 16, clientY: 16 })
    await nextFrame()
    expect(first.dataset.press).toBe('active')
    expect(second.dataset.press).toBe('active')

    dispatchPointer(window, 'pointerup', { pointerId: 11, clientX: 16, clientY: 16 })
    await Promise.all([waitUntilSettled(first), waitUntilSettled(second)])
    expect(first.style.transform).toBe('')
    expect(second.style.transform).toBe('')
  })

  it('准确区分两级按钮，并避让显式托管控件、弹出菜单、窗口控制、会话 Tab、分隔柄、列表行及大块容器', () => {
    const { container } = render(
      <div>
        <ElasticPress>
          <button type="button" id="managed">
            已托管
          </button>
        </ElasticPress>
        <div className="window-controls">
          <button type="button" id="win-close">
            关闭
          </button>
        </div>
        <button type="button" className="session-tab" id="sess-tab">
          标签
        </button>
        <div className="panel-divider">
          <button type="button" className="panel-divider__capsule" id="divider-btn">
            折叠
          </button>
        </div>
        <div className="panel-resize-corner" role="button" id="resize-corner">
          缩放角
        </div>
        <div className="project-menu">
          <button type="button" id="popup-menu-item">
            重命名
          </button>
        </div>
        <div className="settings-dialog__actions">
          <button type="button" id="dialog-ok">
            确定
          </button>
        </div>
        <button type="button" className="ant-btn" id="rect-ant-btn">
          提交
        </button>
        <button type="button" className="ant-btn ant-btn-round" id="round-ant-btn">
          胶囊
        </button>
        <button type="button" role="menuitem" id="menu-item">
          菜单项
        </button>
        <button type="button" className="session-row" id="sess-row">
          会话行
        </button>
        <button type="button" className="session-row__action" id="row-action">
          置顶
        </button>
        <div data-no-elastic-press="">
          <button type="button" id="opted-out">
            跳过
          </button>
        </div>
        <div role="button" id="giant-card" data-mock-height="240">
          整卡
        </div>
      </div>,
    )

    expect(findGlobalElasticTarget(container.querySelector('#managed'))).toBeNull()
    expect(findGlobalElasticTarget(container.querySelector('#win-close'))).toBeNull()
    expect(findGlobalElasticTarget(container.querySelector('#sess-tab'))).toBeNull()
    expect(findGlobalElasticTarget(container.querySelector('#divider-btn'))).toBeNull()
    expect(classifyGlobalPressTarget(container.querySelector('#resize-corner'))).toBeNull()
    expect(findGlobalElasticTarget(container.querySelector('#popup-menu-item'))).toBeNull()
    expect(classifyGlobalPressTarget(container.querySelector('#popup-menu-item'))).toBeNull()
    expect(findGlobalElasticTarget(container.querySelector('#menu-item'))).toBeNull()
    expect(findGlobalElasticTarget(container.querySelector('#sess-row'))).toBeNull()
    expect(findGlobalElasticTarget(container.querySelector('#opted-out'))).toBeNull()
    expect(findGlobalElasticTarget(container.querySelector('#giant-card'))).toBeNull()
    expect(classifyGlobalPressTarget(container.querySelector('#dialog-ok'))?.kind).toBe('tint')
    expect(classifyGlobalPressTarget(container.querySelector('#rect-ant-btn'))?.kind).toBe('tint')
    expect(findGlobalElasticTarget(container.querySelector('#dialog-ok'))).toBeNull()
    expect(findGlobalElasticTarget(container.querySelector('#round-ant-btn'))).toBe(
      container.querySelector('#round-ant-btn'),
    )
    expect(findGlobalElasticTarget(container.querySelector('#row-action'))).toBe(
      container.querySelector('#row-action'),
    )
  })

  it('会保留节点原本的 CSS 居中 transform 并与弹性形变叠加', async () => {
    uninstall = installGlobalElasticPress()
    const { container } = render(
      <button type="button" id="centered">
        回到最新
      </button>,
    )
    const btn = container.querySelector<HTMLButtonElement>('#centered')!
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      transform: 'matrix(1, 0, 0, 1, -40, 0)',
    } as CSSStyleDeclaration)

    dispatchPointer(btn, 'pointerdown', { pointerId: 20, clientX: 16, clientY: 16 })
    await nextFrame()
    expect(btn.style.transform).toMatch(/^matrix\(1, 0, 0, 1, -40, 0\) translate3d\(/)

    dispatchPointer(window, 'pointerup', { pointerId: 20, clientX: 16, clientY: 16 })
    await waitUntilSettled(btn)
    expect(btn.style.transform).toBe('')
  })

  it('连续点击两个轻压着色按钮时立即清理前一个按钮的收尾标记', () => {
    uninstall = installGlobalElasticPress()
    const { container } = render(
      <div>
        <button type="button" className="settings-button" id="tint-a">
          按钮 A
        </button>
        <button type="button" className="settings-button" id="tint-b">
          按钮 B
        </button>
      </div>,
    )
    const buttonA = container.querySelector<HTMLButtonElement>('#tint-a')!
    const buttonB = container.querySelector<HTMLButtonElement>('#tint-b')!

    dispatchPointer(buttonA, 'pointerdown', { pointerId: 30, clientX: 16, clientY: 16 })
    dispatchPointer(window, 'pointerup', { pointerId: 30, clientX: 16, clientY: 16 })
    expect(buttonA.dataset.pressTint).toBe('idle')

    dispatchPointer(buttonB, 'pointerdown', { pointerId: 31, clientX: 16, clientY: 16 })
    expect(buttonA.dataset.pressTint).toBeUndefined()
    expect(buttonB.dataset.pressTint).toBe('active')

    dispatchPointer(window, 'pointerup', { pointerId: 31, clientX: 16, clientY: 16 })
    expect(buttonB.dataset.pressTint).toBe('idle')
    uninstall()
    uninstall = null
    expect(buttonB.dataset.pressTint).toBeUndefined()
  })
})
