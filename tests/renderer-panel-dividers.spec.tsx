// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => ({
  snapshot: {
    activeView: 'conversation',
    pendingInteractions: [],
    navigationWidth: 260,
    informationWidth: 260,
    composerHeight: 112,
    navigationCollapsed: false,
    informationCollapsed: false,
  },
  store: {
    resizeNavigation: vi.fn(),
    resizeInformation: vi.fn(),
    resizeComposer: vi.fn(),
    toggleNavigation: vi.fn(),
    toggleInformation: vi.fn(),
    resetPanelWidth: vi.fn(),
    resetComposerHeight: vi.fn(),
  },
}))

vi.mock('../src/renderer/src/hooks/useWorkspace.ts', () => ({
  useWorkspaceSnapshot: () => mocked.snapshot,
  useWorkspaceStore: () => mocked.store,
}))

// jsdom 不绘制 Canvas；玻璃材质由真实窗口验收，这里只验证点击与拖动。

import {
  ComposerDivider,
  PanelDividers,
} from '../src/renderer/src/pages/workspace/components/PanelDividers.tsx'

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: false,
      media: '',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  )
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    configurable: true,
    value: vi.fn(),
  })
  Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', {
    configurable: true,
    value: vi.fn(() => true),
  })
  Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', {
    configurable: true,
    value: vi.fn(),
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('浮岛面板分隔线', () => {
  it('允许从可见胶囊直接拖动，并且拖动结束不会误触收起', () => {
    render(<PanelDividers />)
    const divider = screen.getByRole('separator', { name: '调整项目面板宽度' })
    const capsule = screen.getByRole('button', { name: '收起项目面板' })

    fireEvent.pointerDown(capsule, { button: 0, pointerId: 7, clientX: 260 })
    expect(divider.classList.contains('is-resizing')).toBe(true)
    fireEvent.pointerMove(divider, { pointerId: 7, clientX: 296 })
    fireEvent.pointerUp(divider, { pointerId: 7, clientX: 296 })
    expect(divider.classList.contains('is-resizing')).toBe(false)
    fireEvent.click(capsule)

    expect(mocked.store.resizeNavigation).toHaveBeenCalledWith(296)
    expect(mocked.store.toggleNavigation).not.toHaveBeenCalled()
  })

  it('不发生拖动时仍把胶囊点击解释为收起或展开', () => {
    render(<PanelDividers />)
    const divider = screen.getByRole('separator', { name: '调整项目面板宽度' })
    const capsule = screen.getByRole('button', { name: '收起项目面板' })

    fireEvent.pointerDown(capsule, { button: 0, pointerId: 6, clientX: 260 })
    fireEvent.pointerUp(divider, { pointerId: 6, clientX: 260 })
    fireEvent.click(capsule)

    expect(mocked.store.toggleNavigation).toHaveBeenCalledTimes(1)
    expect(mocked.store.resizeNavigation).not.toHaveBeenCalled()
  })

  it('从分隔线空白区域拖动后不会吞掉下一次胶囊点击', () => {
    render(<PanelDividers />)
    const divider = screen.getByRole('separator', { name: '调整项目面板宽度' })
    const capsule = screen.getByRole('button', { name: '收起项目面板' })

    fireEvent.pointerDown(divider, { button: 0, pointerId: 8, clientX: 260 })
    fireEvent.pointerMove(divider, { pointerId: 8, clientX: 286 })
    fireEvent.pointerUp(divider, { pointerId: 8, clientX: 286 })
    fireEvent.click(capsule)

    expect(mocked.store.resizeNavigation).toHaveBeenCalledWith(286)
    expect(mocked.store.toggleNavigation).toHaveBeenCalledTimes(1)
  })

  it('支持调整输入区高度，并从交汇拖动柄同时调整右栏宽度和输入区高度', () => {
    render(
      <>
        <PanelDividers />
        <ComposerDivider />
      </>,
    )
    const composerDivider = screen.getByRole('separator', { name: '调整输入区高度' })
    const corner = screen.getByRole('button', { name: '同时调整右侧浮岛宽度和输入区高度' })

    fireEvent.pointerDown(composerDivider, { button: 0, pointerId: 9, clientY: 700 })
    fireEvent.pointerMove(composerDivider, { pointerId: 9, clientY: 660 })
    fireEvent.pointerUp(composerDivider, { pointerId: 9, clientY: 660 })

    fireEvent.pointerDown(corner, { button: 0, pointerId: 10, clientX: 900, clientY: 650 })
    fireEvent.pointerMove(corner, { pointerId: 10, clientX: 870, clientY: 620 })
    fireEvent.pointerUp(corner, { pointerId: 10, clientX: 870, clientY: 620 })

    expect(mocked.store.resizeComposer).toHaveBeenCalledWith(152)
    expect(mocked.store.resizeInformation).toHaveBeenCalledWith(290)
    expect(mocked.store.resizeComposer).toHaveBeenCalledWith(142)
  })
})
