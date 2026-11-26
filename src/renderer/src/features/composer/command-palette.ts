export interface CommandPaletteNavigationItem {
  readonly disabled?: boolean
}

export interface SlashCommandToken {
  readonly query: string
  readonly start: 0
  readonly end: number
}

export type CommandPaletteKeyAction =
  | { readonly kind: 'active'; readonly index: number }
  | { readonly kind: 'select'; readonly index: number }
  | { readonly kind: 'dismiss' }

/**
 * 只识别输入开头、且光标仍位于首个斜杠词中的命令查询。
 * 这样普通消息里的“/”不会意外打开命令面板。
 */
export function parseLeadingSlashCommand(
  text: string,
  selectionStart: number,
): SlashCommandToken | null {
  if (!text.startsWith('/') || selectionStart < 1) return null

  const tokenEnd = text.search(/\s/u)
  const end = tokenEnd === -1 ? text.length : tokenEnd
  if (selectionStart > end) return null

  return {
    query: text.slice(1, selectionStart),
    start: 0,
    end,
  }
}

export interface CommandPaletteFilterItem {
  readonly label: string
  readonly description?: string
  readonly keywords?: readonly string[]
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase('zh-Hans-CN')
}

function matchScore(item: CommandPaletteFilterItem, query: string): number | null {
  const label = normalized(item.label)
  if (label.startsWith(query)) return 0
  if (label.includes(query)) return 1

  for (const keyword of item.keywords ?? []) {
    const candidate = normalized(keyword)
    if (candidate.startsWith(query)) return 2
    if (candidate.includes(query)) return 3
  }

  if (normalized(item.description ?? '').includes(query)) return 4
  return null
}

/** 按最接近的命令名、关键字和说明排序；相同相关性时保留原始候选顺序。 */
export function filterCommandPaletteItems<T extends CommandPaletteFilterItem>(
  items: readonly T[],
  query: string,
): T[] {
  const needle = normalized(query)
  if (needle === '') return [...items]

  return items
    .map((item, index) => ({ item, index, score: matchScore(item, needle) }))
    .filter(
      (entry): entry is { readonly item: T; readonly index: number; readonly score: number } =>
        entry.score !== null,
    )
    .toSorted((left, right) => left.score - right.score || left.index - right.index)
    .map(entry => entry.item)
}

function enabledIndexes(items: readonly CommandPaletteNavigationItem[]): number[] {
  return items.flatMap((item, index) => (item.disabled ? [] : [index]))
}

function nearestEnabledIndex(
  indexes: readonly number[],
  activeIndex: number,
  direction: 1 | -1,
): number {
  if (indexes.length === 0) return -1
  const activePosition = indexes.indexOf(activeIndex)
  if (activePosition === -1) return direction === 1 ? indexes[0]! : indexes[indexes.length - 1]!
  return indexes[(activePosition + direction + indexes.length) % indexes.length]!
}

function pagedEnabledIndex(
  indexes: readonly number[],
  activeIndex: number,
  direction: 1 | -1,
): number {
  if (indexes.length === 0) return -1
  const activePosition = indexes.indexOf(activeIndex)
  const start = activePosition === -1 ? (direction === 1 ? 0 : indexes.length - 1) : activePosition
  const position = Math.min(indexes.length - 1, Math.max(0, start + direction * 5))
  return indexes[position]!
}

/**
 * 把 textarea 外层已确认的非 IME 键盘输入转成纯 UI 行为。
 * 调用方应在 `event.nativeEvent.isComposing` 时跳过本函数。
 */
export function getCommandPaletteKeyAction(
  key: string,
  items: readonly CommandPaletteNavigationItem[],
  activeIndex: number,
): CommandPaletteKeyAction | null {
  const indexes = enabledIndexes(items)

  if (key === 'Escape') return { kind: 'dismiss' }
  if (indexes.length === 0) return null
  if (key === 'ArrowDown')
    return { kind: 'active', index: nearestEnabledIndex(indexes, activeIndex, 1) }
  if (key === 'ArrowUp')
    return { kind: 'active', index: nearestEnabledIndex(indexes, activeIndex, -1) }
  if (key === 'Home') return { kind: 'active', index: indexes[0]! }
  if (key === 'End') return { kind: 'active', index: indexes[indexes.length - 1]! }
  if (key === 'PageDown')
    return { kind: 'active', index: pagedEnabledIndex(indexes, activeIndex, 1) }
  if (key === 'PageUp')
    return { kind: 'active', index: pagedEnabledIndex(indexes, activeIndex, -1) }

  if (key === 'Tab' || key === 'Enter') {
    const index = indexes.includes(activeIndex) ? activeIndex : indexes[0]!
    return { kind: 'select', index }
  }

  return null
}
