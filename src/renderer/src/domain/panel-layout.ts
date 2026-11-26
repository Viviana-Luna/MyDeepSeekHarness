export type PanelName = 'navigation' | 'information'

interface PanelWidthRange {
  minimum: number
  maximum: number | null
  defaultValue: number
}

export interface PanelLayoutState {
  navigationWidth: number
  informationWidth: number
  composerHeight: number
  conversationWidth: number | null
  panelCapsulesPersistent: boolean
  navigationCollapsed: boolean
  informationCollapsed: boolean
}

export interface PanelLayoutStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const PANEL_WIDTH_RANGES = {
  navigation: {
    minimum: 190,
    maximum: 340,
    defaultValue: 260,
  },
  information: {
    minimum: 260,
    maximum: null,
    defaultValue: 260,
  },
} as const satisfies Record<PanelName, PanelWidthRange>

export const COMPOSER_HEIGHT_RANGE = {
  minimum: 104,
  maximum: 360,
  defaultValue: 112,
} as const

export const CONVERSATION_WIDTH_RANGE = { minimum: 640, maximum: 1600 } as const

export function clampConversationWidth(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null
  return Math.round(
    Math.min(CONVERSATION_WIDTH_RANGE.maximum, Math.max(CONVERSATION_WIDTH_RANGE.minimum, value)),
  )
}

export const PANEL_LAYOUT_STORAGE_KEYS = {
  navigationWidth: 'mydsh:panel-layout:navigation-width',
  informationWidth: 'mydsh:panel-layout:information-width',
  composerHeight: 'mydsh:panel-layout:composer-height',
  conversationWidth: 'mydsh:panel-layout:conversation-width',
  panelCapsulesPersistent: 'mydsh:panel-layout:capsules-persistent',
  navigationCollapsed: 'mydsh:panel-layout:navigation-collapsed',
  informationCollapsed: 'mydsh:panel-layout:information-collapsed',
} as const

export function clampPanelWidth(panel: PanelName, value: number): number {
  const range = PANEL_WIDTH_RANGES[panel]
  if (!Number.isFinite(value)) return range.defaultValue
  return Math.min(range.maximum ?? Number.POSITIVE_INFINITY, Math.max(range.minimum, value))
}

export function defaultPanelWidth(panel: PanelName): number {
  return PANEL_WIDTH_RANGES[panel].defaultValue
}

export function clampComposerHeight(value: number): number {
  if (!Number.isFinite(value)) return COMPOSER_HEIGHT_RANGE.defaultValue
  return Math.min(COMPOSER_HEIGHT_RANGE.maximum, Math.max(COMPOSER_HEIGHT_RANGE.minimum, value))
}

function readStorage(storage: PanelLayoutStorage, key: string): string | null {
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(storage: PanelLayoutStorage, key: string, value: string): void {
  try {
    storage.setItem(key, value)
  } catch {
    // localStorage 可能因隐私设置或容量限制拒绝写入，当前窗口状态仍然有效。
  }
}

function storedWidth(storage: PanelLayoutStorage, key: string, panel: PanelName): number {
  const stored = readStorage(storage, key)
  if (stored === null || stored.trim() === '') return defaultPanelWidth(panel)
  const value = Number(stored)
  return Number.isFinite(value) ? clampPanelWidth(panel, value) : defaultPanelWidth(panel)
}

function storedCollapsed(storage: PanelLayoutStorage, key: string): boolean {
  return readStorage(storage, key) === 'true'
}

export function readPanelLayout(storage: PanelLayoutStorage): PanelLayoutState {
  const storedComposerHeight = Number(
    readStorage(storage, PANEL_LAYOUT_STORAGE_KEYS.composerHeight),
  )
  const storedConversationWidth = readStorage(storage, PANEL_LAYOUT_STORAGE_KEYS.conversationWidth)
  return {
    conversationWidth:
      storedConversationWidth === null || storedConversationWidth.trim() === ''
        ? null
        : clampConversationWidth(Number(storedConversationWidth)),
    navigationWidth: storedWidth(storage, PANEL_LAYOUT_STORAGE_KEYS.navigationWidth, 'navigation'),
    informationWidth: storedWidth(
      storage,
      PANEL_LAYOUT_STORAGE_KEYS.informationWidth,
      'information',
    ),
    composerHeight:
      Number.isFinite(storedComposerHeight) && storedComposerHeight > 0
        ? clampComposerHeight(storedComposerHeight)
        : COMPOSER_HEIGHT_RANGE.defaultValue,
    panelCapsulesPersistent: storedCollapsed(
      storage,
      PANEL_LAYOUT_STORAGE_KEYS.panelCapsulesPersistent,
    ),
    navigationCollapsed: storedCollapsed(storage, PANEL_LAYOUT_STORAGE_KEYS.navigationCollapsed),
    informationCollapsed: storedCollapsed(storage, PANEL_LAYOUT_STORAGE_KEYS.informationCollapsed),
  }
}

export function persistConversationWidth(storage: PanelLayoutStorage, width: number | null): void {
  writeStorage(
    storage,
    PANEL_LAYOUT_STORAGE_KEYS.conversationWidth,
    String(clampConversationWidth(width) ?? ''),
  )
}

export function persistPanelCapsulesPersistent(
  storage: PanelLayoutStorage,
  persistent: boolean,
): void {
  writeStorage(storage, PANEL_LAYOUT_STORAGE_KEYS.panelCapsulesPersistent, String(persistent))
}

export function persistComposerHeight(storage: PanelLayoutStorage, height: number): void {
  writeStorage(
    storage,
    PANEL_LAYOUT_STORAGE_KEYS.composerHeight,
    String(clampComposerHeight(height)),
  )
}

export function persistPanelWidth(
  storage: PanelLayoutStorage,
  panel: PanelName,
  width: number,
): void {
  const key =
    panel === 'navigation'
      ? PANEL_LAYOUT_STORAGE_KEYS.navigationWidth
      : PANEL_LAYOUT_STORAGE_KEYS.informationWidth
  writeStorage(storage, key, String(clampPanelWidth(panel, width)))
}

export function persistPanelCollapsed(
  storage: PanelLayoutStorage,
  panel: PanelName,
  collapsed: boolean,
): void {
  const key =
    panel === 'navigation'
      ? PANEL_LAYOUT_STORAGE_KEYS.navigationCollapsed
      : PANEL_LAYOUT_STORAGE_KEYS.informationCollapsed
  writeStorage(storage, key, String(collapsed))
}
