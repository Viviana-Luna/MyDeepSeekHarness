import { ChevronLeft, Search, X } from 'lucide-react'
import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { usePopupMorph } from '../../shared/ui/usePopupMorph.ts'
import styles from './CommandPalette.module.css'
import { getCommandPaletteKeyAction } from './command-palette.ts'

export interface CommandPaletteItem {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly group?: string
  readonly keywords?: readonly string[]
  readonly shortcut?: string
  readonly disabled?: boolean
}

export interface CommandPaletteProps {
  /** 是否处于展开态；传入 `false` 时配合 `morphAnchor` 执行收回形变后卸载。 */
  readonly open?: boolean
  /** 触发面板的按钮引用；存在时启用 FlClash 液态展开与回吸动效。 */
  readonly morphAnchor?: HTMLElement | null
  /** 收回形变完全结束并准备卸载后的回调。 */
  readonly onExited?: () => void
  /** Composer 的实际锚点；为空时不渲染尚未定位的面板。 */
  readonly anchor: HTMLElement | null
  /** 已由外层根据输入内容筛选并排序的候选项。 */
  readonly items: readonly CommandPaletteItem[]
  /** 不包含开头斜杠的当前查询，用于展示输入上下文。 */
  readonly query: string
  readonly activeIndex: number
  readonly loading?: boolean
  readonly error?: string | null
  readonly emptyText?: string
  readonly ariaLabel?: string
  readonly mode?: 'command' | 'file-reference'
  readonly title?: string
  readonly focusSearch?: boolean
  readonly onQueryChange?: (query: string) => void
  readonly onBack?: () => void
  readonly onSelect: (item: CommandPaletteItem) => void
  readonly onActiveIndexChange: (index: number) => void
  readonly onDismiss: () => void
}

interface CommandGroup {
  readonly name: string
  readonly entries: ReadonlyArray<{ readonly item: CommandPaletteItem; readonly index: number }>
}

interface PalettePosition {
  readonly left: number
  readonly bottom: number
  readonly width: number
  readonly maxHeight: number
}

const viewportGutter = 12
const anchorGap = 8
const widestPalette = 420
const narrowestPalette = 320

function groupItems(items: readonly CommandPaletteItem[]): CommandGroup[] {
  const groups = new Map<
    string,
    Array<{ readonly item: CommandPaletteItem; readonly index: number }>
  >()
  for (const [index, item] of items.entries()) {
    const name = item.group?.trim() || '可用命令'
    const entries = groups.get(name) ?? []
    entries.push({ item, index })
    groups.set(name, entries)
  }
  return [...groups].map(([name, entries]) => ({ name, entries }))
}

export const COMMAND_PALETTE_LISTBOX_ID = 'composer-command-listbox'
export const FILE_REFERENCE_LISTBOX_ID = 'composer-file-reference-listbox'

export function commandPaletteOptionId(
  item: CommandPaletteItem,
  mode: 'command' | 'file-reference' = 'command',
): string {
  return `${mode === 'command' ? '命令' : '文件引用'}候选-${item.id}`
}

function getPalettePosition(anchor: HTMLElement): PalettePosition {
  const rect = anchor.getBoundingClientRect()
  const availableWidth = Math.max(0, window.innerWidth - viewportGutter * 2)
  const width = Math.min(
    availableWidth,
    Math.max(narrowestPalette, Math.min(widestPalette, rect.width)),
  )
  const left = Math.min(
    Math.max(viewportGutter, rect.left),
    Math.max(viewportGutter, window.innerWidth - viewportGutter - width),
  )

  return {
    left,
    bottom: Math.max(viewportGutter, window.innerHeight - rect.top + anchorGap),
    width,
    maxHeight: Math.max(0, Math.min(360, rect.top - anchorGap - viewportGutter)),
  }
}

export function CommandPalette({
  open = true,
  morphAnchor,
  onExited,
  anchor,
  items,
  query,
  activeIndex,
  loading = false,
  error = null,
  emptyText = '没有匹配的命令',
  ariaLabel = '命令候选',
  mode = 'command',
  title = '命令与 Skill',
  focusSearch = false,
  onQueryChange,
  onBack,
  onSelect,
  onActiveIndexChange,
  onDismiss,
}: CommandPaletteProps) {
  const morphEnabled = morphAnchor !== undefined && morphAnchor !== null
  const [morphPresent, setMorphPresent] = useState(open)
  const present = morphEnabled ? open || morphPresent : open
  const [position, setPosition] = useState<PalettePosition | null>(null)
  const [positionedForOpen, setPositionedForOpen] = useState(false)
  const positioned = position !== null
  const paletteRef = useRef<HTMLElement>(null)
  const surfaceRef = useRef<SVGSVGElement>(null)
  const pathRef = useRef<SVGPathElement>(null)
  const morphAnchorRef = useRef<HTMLElement | null>(null)
  morphAnchorRef.current = morphAnchor ?? null
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const activeItem = items[activeIndex]
  const activeDescendant =
    activeItem === undefined ? undefined : commandPaletteOptionId(activeItem, mode)
  const groups = groupItems(items)
  const fileReferenceMode = mode === 'file-reference'
  const finishDismiss = useCallback(() => {
    setMorphPresent(false)
    onExited?.()
  }, [onExited])

  useLayoutEffect(() => {
    if (!morphEnabled) {
      setMorphPresent(false)
      return
    }
    if (open) setMorphPresent(true)
  }, [morphEnabled, open])

  useLayoutEffect(() => {
    if (!present || anchor === null) {
      setPosition(null)
      setPositionedForOpen(false)
      return
    }
    if (!open) {
      setPositionedForOpen(false)
      return
    }

    const updatePosition = () => {
      const next = getPalettePosition(anchor)
      setPosition(previous =>
        previous?.left === next.left &&
        previous.bottom === next.bottom &&
        previous.width === next.width &&
        previous.maxHeight === next.maxHeight
          ? previous
          : next,
      )
      setPositionedForOpen(true)
    }
    updatePosition()
    const observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(updatePosition) : undefined
    observer?.observe(anchor)
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [anchor, open, present])

  usePopupMorph({
    enabled: morphEnabled,
    open,
    ready: open && present && positioned && positionedForOpen,
    anchorRef: morphAnchorRef,
    menuRef: paletteRef,
    surfaceRef,
    pathRef,
    onDismissComplete: finishDismiss,
  })

  useLayoutEffect(() => {
    if (open && focusSearch && positioned) searchRef.current?.focus()
  }, [focusSearch, open, positioned])

  useLayoutEffect(() => {
    const list = listRef.current
    const option = activeDescendant === undefined ? null : document.getElementById(activeDescendant)
    if (list === null || option === null) return
    const bounds = list.getBoundingClientRect()
    const row = option.getBoundingClientRect()
    if (row.top < bounds.top) list.scrollTop -= bounds.top - row.top
    else if (row.bottom > bounds.bottom) list.scrollTop += row.bottom - bounds.bottom
  }, [activeDescendant, position])

  const select = (index: number) => {
    const item = items[index]
    if (item === undefined || item.disabled) return
    onSelect(item)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.target === searchRef.current && ['Home', 'End', 'Tab'].includes(event.key)) return
    if (
      event.target instanceof HTMLButtonElement &&
      event.target.getAttribute('role') !== 'option' &&
      event.key !== 'Escape'
    )
      return
    const action = getCommandPaletteKeyAction(event.key, items, activeIndex)
    if (action === null) return
    event.preventDefault()
    if (action.kind === 'active') onActiveIndexChange(action.index)
    if (action.kind === 'select') select(action.index)
    if (action.kind === 'dismiss') onDismiss()
  }

  if (!present || anchor === null || typeof document === 'undefined') return null

  return createPortal(
    <>
      {morphEnabled && (
        <svg ref={surfaceRef} className="anchored-menu-morph-svg" aria-hidden="true">
          <path ref={pathRef} />
        </svg>
      )}
      <section
        ref={paletteRef}
        className={styles.palette}
        data-composer-palette="true"
        data-menu-motion={morphEnabled ? (open ? 'open' : 'closing') : undefined}
        inert={open ? undefined : true}
        role={open ? (fileReferenceMode ? undefined : 'dialog') : undefined}
        aria-label={open ? (fileReferenceMode ? '文件引用面板' : '命令与 Skill') : undefined}
        onKeyDown={onKeyDown}
        style={
          position === null
            ? { visibility: 'hidden' }
            : {
                left: position.left,
                bottom: position.bottom,
                width: position.width,
                maxHeight: position.maxHeight,
              }
        }
      >
        <header className={styles.header}>
          {onBack && (
            <button
              type="button"
              className={styles.iconButton}
              aria-label="返回分类"
              onClick={() => {
                onBack()
                searchRef.current?.focus()
              }}
            >
              <ChevronLeft size={16} />
            </button>
          )}
          <strong className={styles.query}>
            {fileReferenceMode ? `@${query || '查找文件'}` : title}
          </strong>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="关闭候选面板"
            onClick={onDismiss}
          >
            <X size={15} />
          </button>
        </header>
        {onQueryChange && (
          <label className={styles.search}>
            <Search size={15} aria-hidden="true" />
            <input
              ref={searchRef}
              type="text"
              role="combobox"
              aria-label="搜索命令与 Skill"
              aria-autocomplete="list"
              aria-expanded={!loading && error === null && items.length > 0}
              aria-controls={
                !loading && error === null && items.length > 0
                  ? COMMAND_PALETTE_LISTBOX_ID
                  : undefined
              }
              aria-activedescendant={!loading && error === null ? activeDescendant : undefined}
              placeholder={
                title === 'Skill'
                  ? '搜索 Skill 名称或用途'
                  : title === '命令'
                    ? '搜索命令'
                    : '搜索命令或 Skill'
              }
              value={query}
              onChange={event => {
                onQueryChange(event.currentTarget.value)
              }}
            />
          </label>
        )}
        {error !== null ? (
          <p className={styles.state} role="alert">
            {fileReferenceMode ? '文件候选暂时不可用：' : '命令列表暂时不可用：'}
            {error}
          </p>
        ) : loading ? (
          <p className={styles.state} role="status" aria-live="polite">
            {fileReferenceMode ? '正在查找工作区文件…' : '正在加载命令…'}
          </p>
        ) : items.length === 0 ? (
          <p className={styles.state}>{emptyText}</p>
        ) : (
          <div
            ref={listRef}
            className={styles.list}
            role="listbox"
            id={fileReferenceMode ? FILE_REFERENCE_LISTBOX_ID : COMMAND_PALETTE_LISTBOX_ID}
            aria-label={ariaLabel}
            aria-activedescendant={activeDescendant}
          >
            {groups.map(group => (
              <section
                className={styles.group}
                role="group"
                aria-label={group.name}
                key={group.name}
              >
                {groups.length > 1 && <h2>{group.name}</h2>}
                {group.entries.map(({ item, index }) => (
                  <button
                    className={styles.option}
                    data-kind={item.id.startsWith('command:') ? 'command' : undefined}
                    type="button"
                    role="option"
                    id={commandPaletteOptionId(item, mode)}
                    key={item.id}
                    aria-selected={index === activeIndex}
                    aria-disabled={item.disabled === true}
                    disabled={item.disabled}
                    onMouseDown={event => {
                      event.preventDefault()
                    }}
                    onPointerMove={() => {
                      if (!item.disabled) onActiveIndexChange(index)
                    }}
                    onClick={() => {
                      select(index)
                    }}
                  >
                    {!item.id.startsWith('command:') && (
                      <span className={styles.track} aria-hidden="true" />
                    )}
                    <span className={styles.optionCopy}>
                      <strong>{item.label}</strong>
                      {item.description !== undefined && <small>{item.description}</small>}
                    </span>
                    {item.shortcut !== undefined && <kbd>{item.shortcut}</kbd>}
                  </button>
                ))}
              </section>
            ))}
          </div>
        )}
      </section>
    </>,
    document.body,
  )
}
