// @vitest-environment jsdom

/** 验证空会话预设按钮的真实清单、锁定规则，以及液态玻璃透镜的物理变形与无障碍降级。 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => ({
  snapshot: {
    selectedSessionId: '会话-1',
    sessions: [{ sessionId: '会话-1', blank: true, running: false, agentPreset: 'standard' }],
    hostStatus: { kind: 'ready' },
    awaitingResponseSessionIds: [] as string[],
    creatingSession: false,
    sendingMessage: false,
    pluginRevision: 0,
  },
  callHost: vi.fn(async (operation: string) => {
    if (operation === 'listAgentPresets')
      return {
        authorable: true,
        hasDocument: true,
        presets: [
          { id: 'standard', name: '标准模式', trust: 'system', isDefault: true },
          { id: 'coding', name: '编码', trust: 'system', isDefault: false },
          { id: 'broken', name: '不可用', trust: 'user', isDefault: false, broken: '配置错误' },
        ],
      }
    return {}
  }),
  refreshSessions: vi.fn(async () => undefined),
}))

vi.mock('../src/renderer/src/hooks/useWorkspace.ts', () => ({
  useWorkspaceSnapshot: () => mocked.snapshot,
  useWorkspaceStore: () => mocked,
}))

import { SessionPresetPicker } from '../src/renderer/src/pages/workspace/components/rightpanel/chat-rightpanel/SessionPresetPicker.tsx'
import { SessionPresetPills } from '../src/renderer/src/pages/workspace/components/rightpanel/chat-rightpanel/SessionPresetPills.tsx'
import { computePresetLensDeformation } from '../src/renderer/src/pages/workspace/components/rightpanel/chat-rightpanel/usePresetGlass.ts'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

function stubPresetGlassEnvironment(reducedMotion: boolean) {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reducedMotion && query === '(prefers-reduced-motion: reduce)',
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }))
}

function createDomRect(left: number, width: number, top = 10, height = 28): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect
}

function dispatchPointer(
  target: EventTarget,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  init: { readonly pointerId: number; readonly clientX: number; readonly button?: number },
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: init.button ?? 0,
    clientX: init.clientX,
  })
  Object.defineProperty(event, 'pointerId', { value: init.pointerId })
  Object.defineProperty(event, 'isPrimary', { value: true })
  target.dispatchEvent(event)
}

function mockPresetGeometry(group: HTMLElement) {
  const options = group.firstElementChild as HTMLElement
  const material = group.querySelector<HTMLElement>('[data-preset-material]')!
  const buttons = [...group.querySelectorAll<HTMLButtonElement>('button[data-preset-id]')]
  vi.spyOn(options, 'getBoundingClientRect').mockImplementation(() => createDomRect(0, 300))
  vi.spyOn(material, 'getBoundingClientRect').mockImplementation(() =>
    createDomRect(-4, 308, 0, 48),
  )
  buttons.forEach((button, index) => {
    vi.spyOn(button, 'getBoundingClientRect').mockImplementation(() =>
      createDomRect(index * 100, 98),
    )
  })
  return { options, buttons }
}

describe('空会话预设', () => {
  it('选择真实清单中的预设，损坏项和已开始的会话不可切换', async () => {
    const view = render(<SessionPresetPicker variant="pills" />)
    const standard = await screen.findByRole('button', { name: '标准模式' })
    expect(standard.getAttribute('aria-pressed')).toBe('true')
    expect((screen.getByRole('button', { name: '不可用' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    fireEvent.click(screen.getByRole('button', { name: '编码' }))
    await waitFor(() =>
      expect(mocked.callHost).toHaveBeenCalledWith('selectSessionAgentPreset', {
        sessionId: '会话-1',
        agentPreset: 'coding',
      }),
    )
    await waitFor(() => expect(mocked.refreshSessions).toHaveBeenCalled())
    mocked.snapshot.sessions[0]!.blank = false
    view.rerender(<SessionPresetPicker variant="pills" />)
    expect((screen.getByRole('button', { name: '编码' }) as HTMLButtonElement).disabled).toBe(true)
    mocked.snapshot.sessions[0]!.blank = true
  })

  it('超过五项时将余项放进更多，保存期间保留胶囊外观并拦截重复提交', async () => {
    mocked.callHost.mockResolvedValueOnce({
      authorable: true,
      hasDocument: true,
      presets: Array.from({ length: 7 }, (_, index) => ({
        id: `preset-${String(index + 1)}`,
        name: `预设 ${String(index + 1)}`,
        trust: 'system',
        isDefault: index === 0,
      })),
    })
    const session = mocked.snapshot.sessions[0]!
    session.agentPreset = 'preset-1'
    const view = render(<SessionPresetPicker variant="pills" />)
    const more = await screen.findByRole('button', { name: '更多预设' })
    const group = screen.getByRole('group', { name: 'Agent 预设' })
    expect(within(group).getAllByRole('button')).toHaveLength(5)
    fireEvent.click(more)
    const menu = screen.getByRole('menu', { name: '更多预设' })
    expect(menu.dataset.menuMorph).toBe('settled')
    expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(3)
    let finish!: (value: object) => void
    mocked.callHost.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        }),
    )
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: '预设 7' }))
    expect(group.getAttribute('aria-busy')).toBe('true')
    expect((more as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(within(group).getByRole('button', { name: '预设 2' }))
    expect(
      mocked.callHost.mock.calls.filter(([operation]) => operation === 'selectSessionAgentPreset'),
    ).toHaveLength(1)
    expect(mocked.callHost).toHaveBeenCalledWith('selectSessionAgentPreset', {
      sessionId: '会话-1',
      agentPreset: 'preset-7',
    })
    session.agentPreset = 'preset-7'
    finish({})
    await waitFor(() => expect(group.getAttribute('aria-busy')).toBe('false'))
    view.rerender(<SessionPresetPicker variant="pills" />)
    expect(more.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(more)
    expect(screen.getByRole('menuitemradio', { name: '预设 7' }).getAttribute('aria-checked')).toBe(
      'true',
    )
    session.agentPreset = 'standard'
  })

  it('透镜物理变形按按压、高速拉伸、过冲/越界挤压联动，并在减少动态时完全归零', () => {
    const rest = computePresetLensDeformation({
      center: 150,
      width: 100,
      targetWidth: 100,
      trackWidth: 300,
      velocity: 0,
      pressure: 0,
      bulge: 0,
      impact: 0,
      reducedMotion: false,
    })
    expect(rest.scaleX).toBe(1)
    expect(rest.scaleY).toBe(1)

    const pressed = computePresetLensDeformation({
      center: 150,
      width: 100,
      targetWidth: 100,
      trackWidth: 300,
      velocity: 0,
      pressure: 1,
      bulge: 0,
      impact: 0,
      reducedMotion: false,
    })
    expect(pressed.scaleX).toBeGreaterThan(1.03)
    expect(pressed.scaleY).toBeGreaterThan(1.08)
    expect(pressed.specular).toBeGreaterThan(rest.specular)
    expect(pressed.strengthBoost).toBeGreaterThan(0)

    const gliding = computePresetLensDeformation({
      center: 150,
      width: 100,
      targetWidth: 100,
      trackWidth: 300,
      velocity: 900,
      pressure: 0,
      bulge: 1,
      impact: 0,
      reducedMotion: false,
    })
    expect(gliding.scaleX).toBeGreaterThan(1.06)
    expect(gliding.scaleX).toBeLessThanOrEqual(1.1)
    expect(gliding.scaleY).toBeLessThan(1)
    expect(gliding.scaleY).toBeGreaterThanOrEqual(0.94)

    const landedImpact = computePresetLensDeformation({
      center: 150,
      width: 100,
      targetWidth: 100,
      trackWidth: 300,
      velocity: 180,
      pressure: 0,
      bulge: 0,
      impact: 1,
      reducedMotion: false,
    })
    expect(landedImpact.scaleX).toBeLessThan(0.96)
    expect(landedImpact.scaleY).toBeGreaterThan(1.06)

    const edgeSqueezed = computePresetLensDeformation({
      center: 20,
      width: 100,
      targetWidth: 100,
      trackWidth: 300,
      velocity: -400,
      pressure: 0,
      bulge: 0,
      impact: 0,
      reducedMotion: false,
    })
    expect(edgeSqueezed.squeeze).toBeGreaterThan(0.05)
    expect(edgeSqueezed.scaleX).toBeLessThan(0.95)
    expect(edgeSqueezed.scaleY).toBeGreaterThan(1.05)
    expect(edgeSqueezed.paintedCenter).toBeGreaterThanOrEqual(
      (100 * edgeSqueezed.scaleX) / 2 - 0.01,
    )

    const reduced = computePresetLensDeformation({
      center: 20,
      width: 100,
      targetWidth: 100,
      trackWidth: 300,
      velocity: 900,
      pressure: 1,
      bulge: 1,
      impact: 1,
      reducedMotion: true,
    })
    expect(reduced.scaleX).toBe(1)
    expect(reduced.scaleY).toBe(1)
    expect(reduced.squeeze).toBe(0)
    expect(reduced.strengthBoost).toBe(0)
  })

  it('按压蓄力与横向拖拽可切换预设，减少动态模式下不触发按压形变', () => {
    stubPresetGlassEnvironment(false)
    const onSelect = vi.fn()
    const roster = {
      authorable: true,
      hasDocument: true,
      presets: [
        { id: 'standard', name: '标准模式', trust: 'system' as const, isDefault: true },
        { id: 'minimal', name: '极简模式', trust: 'system' as const, isDefault: false },
        { id: 'gpt-coding', name: 'ChatGPT', trust: 'system' as const, isDefault: false },
      ],
    }
    const view = render(
      <SessionPresetPills
        roster={roster}
        selected="standard"
        disabled={false}
        saving={false}
        onSelect={onSelect}
      />,
    )
    const group = screen.getByRole('group', { name: 'Agent 预设' })
    const { options, buttons } = mockPresetGeometry(group)
    options.setPointerCapture = vi.fn()
    options.releasePointerCapture = vi.fn()
    options.hasPointerCapture = vi.fn(() => false)
    view.rerender(
      <SessionPresetPills
        roster={{ ...roster, presets: [...roster.presets] }}
        selected="standard"
        disabled={false}
        saving={false}
        onSelect={onSelect}
      />,
    )
    const lens = group.querySelector<HTMLElement>('[data-preset-lens]')!
    expect(options.dataset.glassReady).toBe('true')

    dispatchPointer(buttons[0]!, 'pointerdown', { pointerId: 1, clientX: 48 })
    expect(lens.dataset.pressed).toBe('true')
    dispatchPointer(window, 'pointermove', { pointerId: 1, clientX: 250 })
    expect(options.dataset.dragging).toBe('true')
    dispatchPointer(window, 'pointerup', { pointerId: 1, clientX: 250 })
    expect(lens.dataset.pressed).toBeUndefined()
    expect(options.dataset.dragging).toBeUndefined()
    expect(onSelect).toHaveBeenCalledWith('gpt-coding')

    cleanup()
    stubPresetGlassEnvironment(true)
    const reducedView = render(
      <SessionPresetPills
        roster={roster}
        selected="standard"
        disabled={false}
        saving={false}
        onSelect={vi.fn()}
      />,
    )
    const reducedGroup = screen.getByRole('group', { name: 'Agent 预设' })
    const { buttons: reducedButtons } = mockPresetGeometry(reducedGroup)
    reducedView.rerender(
      <SessionPresetPills
        roster={{ ...roster, presets: [...roster.presets] }}
        selected="standard"
        disabled={false}
        saving={false}
        onSelect={vi.fn()}
      />,
    )
    const reducedLens = reducedGroup.querySelector<HTMLElement>('[data-preset-lens]')!
    dispatchPointer(reducedButtons[0]!, 'pointerdown', { pointerId: 2, clientX: 48 })
    expect(reducedLens.dataset.pressed).toBeUndefined()
    expect(reducedLens.style.transform).toContain('scale(1, 1)')
  })
})
