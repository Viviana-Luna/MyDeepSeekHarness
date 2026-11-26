// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandPalette,
  type CommandPaletteItem,
} from '../src/renderer/src/features/composer/CommandPalette.tsx'
import {
  filterCommandPaletteItems,
  getCommandPaletteKeyAction,
  parseLeadingSlashCommand,
} from '../src/renderer/src/features/composer/command-palette.ts'

afterEach(cleanup)

function createAnchor(getRect: () => DOMRect): HTMLElement {
  const anchor = document.createElement('section')
  Object.defineProperty(anchor, 'getBoundingClientRect', { configurable: true, value: getRect })
  document.body.append(anchor)
  return anchor
}

const items: readonly CommandPaletteItem[] = [
  {
    id: '审阅',
    label: '审阅变更',
    description: '检查当前工作区的变更',
    group: '工作区',
    shortcut: '↵',
  },
  { id: '总结', label: '总结对话', description: '提炼当前会话的重点', group: '会话' },
  { id: '不可用', label: '暂不可用', group: '会话', disabled: true },
]

describe('命令面板工具', () => {
  it('只解析输入开头且光标仍在首个斜杠词中的命令', () => {
    expect(parseLeadingSlashCommand('/审阅', 2)).toEqual({ query: '审', start: 0, end: 3 })
    expect(parseLeadingSlashCommand('/审阅 这次变更', 3)).toEqual({
      query: '审阅',
      start: 0,
      end: 3,
    })
    expect(parseLeadingSlashCommand('/审阅 这次变更', 5)).toBeNull()
    expect(parseLeadingSlashCommand('请 /审阅', 5)).toBeNull()
  })

  it('按命令名、关键字和说明过滤排序，并跳过禁用项移动', () => {
    expect(
      filterCommandPaletteItems(
        [
          { label: '解释', keywords: ['说明'] },
          { label: '审阅变更', description: '检查差异' },
          { label: '查看状态', description: '审阅运行状态' },
        ],
        '审',
      ).map(item => item.label),
    ).toEqual(['审阅变更', '查看状态'])
    expect(getCommandPaletteKeyAction('ArrowDown', items, 1)).toEqual({ kind: 'active', index: 0 })
    expect(getCommandPaletteKeyAction('ArrowUp', items, 0)).toEqual({ kind: 'active', index: 1 })
    expect(getCommandPaletteKeyAction('Home', items, 1)).toEqual({ kind: 'active', index: 0 })
    expect(getCommandPaletteKeyAction('End', items, 0)).toEqual({ kind: 'active', index: 1 })
    const pageItems = Array.from({ length: 12 }, () => ({ disabled: false }))
    expect(getCommandPaletteKeyAction('PageDown', pageItems, 1)).toEqual({
      kind: 'active',
      index: 6,
    })
    expect(getCommandPaletteKeyAction('PageUp', pageItems, 8)).toEqual({ kind: 'active', index: 3 })
    expect(getCommandPaletteKeyAction('Tab', items, 2)).toEqual({ kind: 'select', index: 0 })
    expect(getCommandPaletteKeyAction('Enter', items, 2)).toEqual({ kind: 'select', index: 0 })
    expect(getCommandPaletteKeyAction('Escape', items, 0)).toEqual({ kind: 'dismiss' })
  })
})

describe('CommandPalette', () => {
  it('按分组呈现 listbox，键盘选择并保留 textarea 焦点', () => {
    const onSelect = vi.fn()
    const onActiveIndexChange = vi.fn()
    const onDismiss = vi.fn()
    const anchor = createAnchor(() => new DOMRect(40, 620, 420, 80))
    render(
      <>
        <textarea aria-label="消息输入" autoFocus />
        <CommandPalette
          anchor={anchor}
          items={items}
          query="审"
          activeIndex={0}
          onSelect={onSelect}
          onActiveIndexChange={onActiveIndexChange}
          onDismiss={onDismiss}
        />
      </>,
    )

    const textarea = screen.getByRole('textbox', { name: '消息输入' })
    expect(document.activeElement).toBe(textarea)
    const listbox = screen.getByRole('listbox', { name: '命令候选' })
    expect(screen.getByRole('group', { name: '工作区' })).toBeTruthy()
    expect(screen.getByRole('option', { name: /审阅变更/u }).getAttribute('aria-selected')).toBe(
      'true',
    )
    expect(screen.getByRole('option', { name: /暂不可用/u }).getAttribute('aria-disabled')).toBe(
      'true',
    )

    fireEvent.keyDown(listbox, { key: 'ArrowDown' })
    expect(onActiveIndexChange).toHaveBeenCalledWith(1)
    fireEvent.keyDown(listbox, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith(items[0])
    fireEvent.keyDown(listbox, { key: 'Escape' })
    expect(onDismiss).toHaveBeenCalledOnce()

    fireEvent.mouseDown(screen.getByRole('option', { name: /总结对话/u }))
    expect(document.activeElement).toBe(textarea)
    anchor.remove()
  })

  it('通过 Portal 放入 body，并根据锚点和视口夹紧固定位置', () => {
    let rect = new DOMRect(760, 680, 420, 80)
    const anchor = createAnchor(() => rect)
    render(
      <CommandPalette
        anchor={anchor}
        items={items}
        query="审"
        activeIndex={0}
        onSelect={vi.fn()}
        onActiveIndexChange={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )

    const palette = screen.getByRole('dialog', { name: '命令与 Skill' })
    expect(palette.parentElement).toBe(document.body)
    expect(palette.style.left).toBe('592px')
    expect(palette.style.bottom).toBe('96px')
    expect(palette.style.width).toBe('420px')
    expect(palette.style.maxHeight).toBe('360px')

    rect = new DOMRect(44, 540, 420, 80)
    fireEvent.resize(window)
    expect(palette.style.left).toBe('44px')
    expect(palette.style.bottom).toBe('236px')

    rect = new DOMRect(44, 260, 420, 80)
    const scrollContainer = document.createElement('div')
    document.body.append(scrollContainer)
    fireEvent.scroll(scrollContainer)
    expect(palette.style.bottom).toBe('516px')
    expect(palette.style.maxHeight).toBe('240px')

    const viewportWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 })
    rect = new DOMRect(300, 500, 420, 80)
    fireEvent.resize(window)
    expect(palette.style.left).toBe('12px')
    expect(palette.style.width).toBe('336px')
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: viewportWidth })
    scrollContainer.remove()
    anchor.remove()
  })

  it('显示加载、错误和空候选状态', () => {
    const actions = {
      onSelect: vi.fn(),
      onActiveIndexChange: vi.fn(),
      onDismiss: vi.fn(),
    }
    const anchor = createAnchor(() => new DOMRect(40, 620, 420, 80))
    const view = render(
      <CommandPalette anchor={anchor} items={[]} query="" activeIndex={-1} loading {...actions} />,
    )
    expect(screen.getByRole('status').textContent).toContain('正在加载命令')
    view.rerender(
      <CommandPalette
        anchor={anchor}
        items={[]}
        query=""
        activeIndex={-1}
        error="连接已断开"
        {...actions}
      />,
    )
    expect(screen.getByRole('alert').textContent).toContain('连接已断开')
    view.rerender(
      <CommandPalette anchor={anchor} items={[]} query="不存在" activeIndex={-1} {...actions} />,
    )
    expect(screen.getByText('没有匹配的命令')).toBeTruthy()
    anchor.remove()
  })
})
