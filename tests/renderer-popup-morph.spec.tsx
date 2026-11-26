// @vitest-environment jsdom

/**
 * 校验 FlClash 风格液态弹出菜单的轮廓数学、融合路径与组件集成（项目下拉与标签页新建菜单）。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CommandPalette,
  type CommandPaletteItem,
} from '../src/renderer/src/features/composer/CommandPalette.tsx'
import { NewTabMenu } from '../src/renderer/src/pages/workspace/components/topbar/NewTabMenu.tsx'
import { AnchoredMenu } from '../src/renderer/src/shared/ui/AnchoredMenu.tsx'
import { AnchoredPanel } from '../src/renderer/src/shared/ui/AnchoredPanel.tsx'
import {
  computeClosingMorphFrame,
  computeOpeningMorphFrame,
  gooPairSvgPath,
  POPUP_DISMISS_DURATION_S,
  POPUP_OPEN_DURATION_S,
} from '../src/renderer/src/shared/ui/popupMorphMath.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function nextFrame(): Promise<void> {
  await new Promise(resolve => window.requestAnimationFrame(() => resolve(undefined)))
}

async function waitUntilFrames(predicate: () => boolean, remaining = 60): Promise<void> {
  if (predicate() || remaining <= 0) return
  await nextFrame()
  await waitUntilFrames(predicate, remaining - 1)
}

function MorphCommandPaletteHarness({ items }: { items: readonly CommandPaletteItem[] }) {
  const [open, setOpen] = useState(false)
  const [exited, setExited] = useState(false)
  const anchorRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  return (
    <div ref={anchorRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          setExited(false)
          setOpen(current => !current)
        }}
      >
        命令按钮
      </button>
      <CommandPalette
        open={open}
        morphAnchor={triggerRef.current}
        anchor={anchorRef.current}
        items={items}
        query=""
        activeIndex={0}
        onSelect={() => setOpen(false)}
        onActiveIndexChange={vi.fn()}
        onDismiss={() => setOpen(false)}
        onExited={() => setExited(true)}
      />
      <span data-testid="palette-exited">{String(exited)}</span>
    </div>
  )
}

function MorphAnchoredPanelHarness() {
  const [open, setOpen] = useState(false)
  const [exited, setExited] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  return (
    <div>
      <style>{`.panel-morph-sample { z-index: 120; background: rgb(32, 33, 38); border-radius: 12px; }`}</style>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => {
          setExited(false)
          setOpen(current => !current)
        }}
      >
        读数面板按钮
      </button>
      <AnchoredPanel
        open={open}
        anchor={open ? anchorRef.current : null}
        side="top"
        align="end"
        motion="morph"
        focusOnOpen
        className="panel-morph-sample"
        label="上下文占用"
        onDismiss={() => setOpen(false)}
        onExited={() => setExited(true)}
      >
        {open ? <span>上下文已用 1%</span> : null}
      </AnchoredPanel>
      <div className="ant-select-dropdown">
        <div role="option">ChatGPT</div>
      </div>
      <span data-testid="panel-exited">{String(exited)}</span>
    </div>
  )
}

function MorphMenuHarness({ zIndex }: { zIndex?: string }) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  return (
    <div>
      {zIndex !== undefined && (
        <style>{`.z-layered-menu { z-index: ${zIndex}; border-radius: 15px; } .morph-anchor-btn { border-radius: 8px; }`}</style>
      )}
      <button
        ref={anchorRef}
        type="button"
        className="morph-anchor-btn"
        onClick={() => setOpen(current => !current)}
      >
        专注项目
      </button>
      <AnchoredMenu
        open={open}
        anchorRef={anchorRef}
        side="bottom"
        motion="morph"
        className={
          zIndex !== undefined ? 'project-focus-menu z-layered-menu' : 'project-focus-menu'
        }
        label="专注项目"
        onDismiss={() => setOpen(false)}
      >
        <button
          type="button"
          role="menuitemradio"
          aria-checked="true"
          onClick={() => setOpen(false)}
        >
          全部项目
        </button>
        <button
          type="button"
          role="menuitemradio"
          aria-checked="false"
          onClick={() => setOpen(false)}
        >
          测试项目
        </button>
      </AnchoredMenu>
    </div>
  )
}

describe('液态弹出菜单动效与组件交互', () => {
  it('展开帧从锚点胶囊平滑融出并在终点收敛，收回帧生成可闭合的液桥路径', () => {
    const anchor = { left: 0, top: -35, width: 32, height: 32 }
    const card = { left: 0, top: 0, width: 180, height: 140 }

    const early = computeOpeningMorphFrame({ timeSeconds: 0.04, anchor, card, cardRadius: 10 })
    const settled = computeOpeningMorphFrame({
      timeSeconds: POPUP_OPEN_DURATION_S,
      anchor,
      card,
      cardRadius: 10,
    })

    expect(early.platter.width).toBeLessThan(card.width)
    expect(early.contentBlur).toBeGreaterThan(1)
    expect(early.svgPath).toContain('M ')
    expect(early.svgPath).toContain('Z')

    expect(settled.progress).toBeGreaterThan(0.95)
    expect(settled.platter.width).toBeGreaterThan(card.width * 0.96)
    expect(settled.contentBlur).toBeLessThan(0.5)

    const closing = computeClosingMorphFrame({
      timeSeconds: 0.16,
      totalDurationSeconds: POPUP_DISMISS_DURATION_S,
      start: null,
      anchor,
      card,
      cardRadius: 10,
    })
    expect(closing.contentOpacity).toBe(0)
    expect(closing.platter.width).toBeLessThan(card.width)
    expect(closing.svgPath).toContain('M ')
    expect(closing.svgPath).toContain('Z')

    const bridged = gooPairSvgPath(
      { left: 0, top: 10, width: 120, height: 100 },
      18,
      { left: 40, top: -18, width: 32, height: 32 },
      28,
    )
    expect(bridged.startsWith('M ')).toBe(true)
    expect(bridged.endsWith('Z')).toBe(true)
  })

  it('开启 motion=morph 时渲染独立 SVG 轮廓层，并在收回结束或减少动态时完整卸载', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    const rectSpy = vi
      .spyOn(window.HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (this.tagName === 'BUTTON') {
          return {
            left: 20,
            top: 12,
            right: 200,
            bottom: 40,
            width: 180,
            height: 28,
            x: 20,
            y: 12,
            toJSON: () => ({}),
          }
        }
        return {
          left: 20,
          top: 47,
          right: 240,
          bottom: 187,
          width: 220,
          height: 140,
          x: 20,
          y: 47,
          toJSON: () => ({}),
        }
      })

    render(<MorphMenuHarness zIndex="120" />)
    const trigger = screen.getByRole('button', { name: '专注项目' })
    fireEvent.click(trigger)
    const menu = screen.getByRole('menu', { name: '专注项目' })
    expect(menu.dataset.menuMorph).toBe('active')
    const svgSurface = document.querySelector<SVGSVGElement>('.anchored-menu-morph-svg')!
    const svgPath = svgSurface.querySelector<SVGPathElement>('path')!
    const svgMask = svgSurface.querySelector<SVGMaskElement>('mask[data-morph-anchor-mask="true"]')!
    const maskBackdrop = svgMask.querySelector<SVGRectElement>(
      'rect[data-morph-mask-backdrop="true"]',
    )!
    const maskCutout = svgMask.querySelector<SVGRectElement>('rect[data-morph-mask-cutout="true"]')!
    expect(svgPath.getAttribute('d')).toContain('M ')
    expect(svgSurface.style.zIndex).toBe('120')
    expect(svgMask.getAttribute('maskUnits')).toBe('userSpaceOnUse')
    expect(svgPath.getAttribute('mask')).toBe(`url(#${svgMask.id})`)
    expect(Number(maskBackdrop.getAttribute('x'))).toBeLessThan(0)
    expect(Number(maskBackdrop.getAttribute('y'))).toBeLessThan(-35)
    expect(maskCutout.getAttribute('x')).toBe('0')
    expect(maskCutout.getAttribute('y')).toBe('-35')
    expect(maskCutout.getAttribute('width')).toBe('180')
    expect(maskCutout.getAttribute('height')).toBe('28')
    expect(maskCutout.getAttribute('rx')).toBe('8')
    expect(maskCutout.getAttribute('ry')).toBe('8')

    await waitUntilFrames(() => menu.dataset.menuMorph === 'settled', 45)
    expect(menu.dataset.menuMorph).toBe('settled')
    expect(svgSurface.style.display).toBe('none')
    expect(svgPath.getAttribute('mask')).toBeNull()
    expect(maskCutout.getAttribute('width')).toBeNull()

    fireEvent.click(screen.getByRole('menuitemradio', { name: '测试项目' }))
    expect(menu.hasAttribute('inert')).toBe(true)
    expect(menu.dataset.menuMotion).toBe('closing')
    expect(svgPath.getAttribute('mask')).toBe(`url(#${svgMask.id})`)
    expect(maskCutout.getAttribute('width')).toBe('180')
    await waitUntilFrames(() => document.querySelector('.project-focus-menu') === null, 60)
    expect(document.querySelector('.project-focus-menu')).toBeNull()
    expect(document.querySelector('.anchored-menu-morph-svg')).toBeNull()
    rectSpy.mockRestore()
  })

  it('开启减少动态时 motion=morph 立即落位且关闭后直接卸载', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    render(<MorphMenuHarness />)
    fireEvent.click(screen.getByRole('button', { name: '专注项目' }))
    const menu = screen.getByRole('menu', { name: '专注项目' })
    expect(menu.dataset.menuMorph).toBe('settled')

    fireEvent.click(screen.getByRole('menuitemradio', { name: '测试项目' }))
    await nextFrame()
    expect(screen.queryByRole('menu', { name: '专注项目' })).toBeNull()
  })

  it('顶部新建标签菜单仅通过点击或键盘展开、悬停不触发，连点两次按钮直接新建聊天且不抢占输入焦点', async () => {
    vi.useFakeTimers()
    const onSelect = vi.fn()
    const buttonRef = { current: null as HTMLButtonElement | null }
    const view = render(
      <>
        <input aria-label="输入框" />
        <NewTabMenu
          visible
          buttonRef={buttonRef}
          primaryKey="session"
          onSelect={onSelect}
          items={[
            { key: 'session', label: '新聊天', icon: null, disabled: false },
            { key: 'terminal', label: '新终端', icon: null, disabled: false },
            { key: 'browser', label: '新浏览器', icon: null, disabled: false },
          ]}
        />
      </>,
    )

    const input = screen.getByLabelText('输入框')
    input.focus()
    const trigger = screen.getByRole('button', { name: '新建工作标签' })
    fireEvent.pointerEnter(trigger)
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(screen.queryByRole('menu', { name: '新建工作标签' })).toBeNull()

    fireEvent.click(trigger, { detail: 1 })
    expect(screen.getByRole('menu', { name: '新建工作标签' })).toBeTruthy()
    expect(document.activeElement).toBe(input)

    fireEvent.click(screen.getByRole('menuitem', { name: '新终端' }))
    expect(onSelect).toHaveBeenCalledWith('terminal')

    fireEvent.click(trigger, { detail: 1 })
    expect(screen.getByRole('menu', { name: '新建工作标签' })).toBeTruthy()
    fireEvent.click(trigger, { detail: 2 })
    expect(onSelect).toHaveBeenCalledWith('session')
    expect(onSelect).toHaveBeenCalledTimes(2)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    view.rerender(
      <>
        <input aria-label="输入框" />
        <NewTabMenu
          visible
          buttonRef={buttonRef}
          primaryKey="session"
          onSelect={onSelect}
          items={[
            { key: 'session', label: '新聊天', icon: null, disabled: true },
            { key: 'terminal', label: '新终端', icon: null, disabled: false },
            { key: 'browser', label: '新浏览器', icon: null, disabled: false },
          ]}
        />
      </>,
    )
    fireEvent.click(trigger, { detail: 1 })
    expect(screen.getByRole('menu', { name: '新建工作标签' })).toBeTruthy()
    fireEvent.click(trigger, { detail: 2 })
    expect(onSelect).toHaveBeenCalledTimes(2)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    vi.useRealTimers()
    view.rerender(
      <>
        <input aria-label="输入框" />
        <NewTabMenu
          visible
          buttonRef={buttonRef}
          primaryKey="session"
          onSelect={onSelect}
          items={[
            { key: 'session', label: '新聊天', icon: null, disabled: false },
            { key: 'terminal', label: '新终端', icon: null, disabled: false },
            { key: 'browser', label: '新浏览器', icon: null, disabled: false },
          ]}
        />
      </>,
    )
    fireEvent.click(trigger, { detail: 0 })
    const menu = screen.getByRole('menu', { name: '新建工作标签' })
    await waitFor(() => {
      expect(menu.contains(document.activeElement)).toBe(true)
    })
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(onSelect).toHaveBeenCalledTimes(2)
  })

  it('命令面板绑定按钮锚点时展开绘制融合 SVG，收回结束后完整卸载并回调', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    const rectSpy = vi
      .spyOn(window.HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (this.tagName === 'BUTTON') {
          return {
            left: 110,
            top: 660,
            right: 136,
            bottom: 686,
            width: 26,
            height: 26,
            x: 110,
            y: 660,
            toJSON: () => ({}),
          }
        }
        if (this.dataset.composerPalette === 'true') {
          return {
            left: 40,
            top: 320,
            right: 460,
            bottom: 620,
            width: 420,
            height: 300,
            x: 40,
            y: 320,
            toJSON: () => ({}),
          }
        }
        return {
          left: 40,
          top: 628,
          right: 460,
          bottom: 700,
          width: 420,
          height: 72,
          x: 40,
          y: 628,
          toJSON: () => ({}),
        }
      })

    render(
      <MorphCommandPaletteHarness
        items={[{ id: 'category:skill', label: 'Skill', description: '选择技能', group: '类型' }]}
      />,
    )
    const trigger = screen.getByRole('button', { name: '命令按钮' })
    fireEvent.click(trigger)
    const palette = screen.getByRole('dialog', { name: '命令与 Skill' })
    expect(palette.dataset.menuMorph).toBe('active')
    expect(document.querySelector('.anchored-menu-morph-svg path')?.getAttribute('d')).toContain(
      'M ',
    )

    await waitUntilFrames(() => palette.dataset.menuMorph === 'settled', 45)
    expect(palette.dataset.menuMorph).toBe('settled')

    fireEvent.click(trigger)
    expect(palette.dataset.menuMotion).toBe('closing')
    expect(palette.hasAttribute('inert')).toBe(true)
    await waitUntilFrames(() => screen.getByTestId('palette-exited').textContent === 'true', 60)
    expect(document.querySelector('[data-composer-palette="true"]')).toBeNull()
    rectSpy.mockRestore()
  })

  it('AnchoredPanel 开启 motion=morph 时同步背景色、忽略下拉选择外部点击并在收回期保留内容', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    const rectSpy = vi
      .spyOn(window.HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (this.tagName === 'BUTTON') {
          return {
            left: 300,
            top: 720,
            right: 360,
            bottom: 744,
            width: 60,
            height: 24,
            x: 300,
            y: 720,
            toJSON: () => ({}),
          }
        }
        return {
          left: 160,
          top: 560,
          right: 360,
          bottom: 713,
          width: 200,
          height: 153,
          x: 160,
          y: 560,
          toJSON: () => ({}),
        }
      })

    render(<MorphAnchoredPanelHarness />)
    const trigger = screen.getByRole('button', { name: '读数面板按钮' })
    fireEvent.click(trigger)
    const panel = screen.getByRole('dialog', { name: '上下文占用' })
    expect(panel.dataset.menuMorph).toBe('active')
    const svgSurface = document.querySelector<SVGSVGElement>('.anchored-menu-morph-svg')!
    expect(svgSurface.style.zIndex).toBe('120')
    expect(svgSurface.style.getPropertyValue('--morph-fill')).toBe('rgb(32, 33, 38)')

    await waitUntilFrames(() => panel.dataset.menuMorph === 'settled', 45)
    const selectDropdown = document.querySelector('.ant-select-dropdown')!
    fireEvent.pointerDown(screen.getByRole('option', { name: 'ChatGPT' }))
    expect(screen.getByRole('dialog', { name: '上下文占用' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog', { name: '上下文占用' })).toBeTruthy()

    selectDropdown.classList.add('ant-select-dropdown-hidden')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(panel.dataset.menuMotion).toBe('closing')
    expect(panel.hasAttribute('inert')).toBe(true)
    expect(panel.textContent).toContain('上下文已用 1%')
    expect(document.activeElement).toBe(trigger)
    await waitUntilFrames(() => screen.getByTestId('panel-exited').textContent === 'true', 60)
    expect(document.querySelector('.panel-morph-sample')).toBeNull()
    rectSpy.mockRestore()
  })

  it('AnchoredMenu 移动锚点后二次打开会重新对齐 SVG 轮廓，命令面板切换为非按钮触发时清理形变样式', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    let anchorLeft = 20
    const rectSpy = vi
      .spyOn(window.HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (this.tagName === 'BUTTON') {
          return {
            left: anchorLeft,
            top: 12,
            right: anchorLeft + 120,
            bottom: 40,
            width: 120,
            height: 28,
            x: anchorLeft,
            y: 12,
            toJSON: () => ({}),
          }
        }
        return {
          left: anchorLeft,
          top: 47,
          right: anchorLeft + 200,
          bottom: 187,
          width: 200,
          height: 140,
          x: anchorLeft,
          y: 47,
          toJSON: () => ({}),
        }
      })

    render(<MorphMenuHarness zIndex="120" />)
    const trigger = screen.getByRole('button', { name: '专注项目' })
    fireEvent.click(trigger)
    await waitUntilFrames(
      () =>
        document.querySelector<HTMLElement>('.project-focus-menu')?.dataset.menuMorph === 'settled',
      45,
    )
    fireEvent.click(screen.getByRole('menuitemradio', { name: '全部项目' }))
    await waitUntilFrames(() => document.querySelector('.project-focus-menu') === null, 60)

    anchorLeft = 260
    fireEvent.click(trigger)
    const reopenedSurface = document.querySelector<SVGSVGElement>('.anchored-menu-morph-svg')!
    expect(reopenedSurface.style.left).toBe('260px')

    cleanup()
    const paletteAnchor = document.createElement('div')
    const buttonAnchor = document.createElement('button')
    document.body.append(paletteAnchor, buttonAnchor)
    const items: CommandPaletteItem[] = [
      { id: 'category:skill', label: 'Skill', description: '选择技能', group: '类型' },
    ]
    const paletteView = render(
      <CommandPalette
        open
        morphAnchor={buttonAnchor}
        anchor={paletteAnchor}
        items={items}
        query=""
        activeIndex={0}
        onSelect={vi.fn()}
        onActiveIndexChange={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    paletteView.rerender(
      <CommandPalette
        open={false}
        morphAnchor={buttonAnchor}
        anchor={paletteAnchor}
        items={items}
        query=""
        activeIndex={0}
        onSelect={vi.fn()}
        onActiveIndexChange={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    await nextFrame()
    paletteView.rerender(
      <CommandPalette
        open
        morphAnchor={null}
        anchor={paletteAnchor}
        items={items}
        query="/"
        activeIndex={0}
        onSelect={vi.fn()}
        onActiveIndexChange={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    const palette = document.querySelector<HTMLElement>('[data-composer-palette="true"]')!
    expect(palette.style.clipPath).toBe('')
    expect(palette.style.filter).toBe('')
    expect(palette.dataset.menuMorph).toBeUndefined()
    paletteAnchor.remove()
    buttonAnchor.remove()
    rectSpy.mockRestore()
  })
})
