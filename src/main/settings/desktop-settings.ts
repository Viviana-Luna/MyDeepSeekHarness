/**
 * Electron 自有的桌面外观设置。
 *
 * 持久化文件只保存经过校验的标量和背景层标记；图片由主进程规范化为
 * PNG 后写入固定文件名，renderer 永远不会获得本机路径。
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  DESKTOP_FONT_FAMILIES,
  DESKTOP_FONT_SIZE_RANGE,
  DESKTOP_EDITOR_FONT_SIZE_RANGE,
  DESKTOP_EDITOR_LINE_HEIGHTS,
  DESKTOP_ISLAND_GAP_RANGE,
  DESKTOP_CANVAS_COLOR_SCHEMES,
  DESKTOP_COLOR_SCHEMES,
  type DesktopCanvasColorScheme,
  type DesktopColorScheme,
  type DesktopEditorLineHeight,
  type DesktopFontFamily,
} from '../../shared/appearance.ts'
import { isRecord } from '../../shared/validation.ts'

export type {
  DesktopCanvasColorScheme,
  DesktopColorScheme,
  DesktopEditorLineHeight,
  DesktopFontFamily,
} from '../../shared/appearance.ts'

const DESKTOP_THEME_MODES = ['classic', 'glass'] as const
type DesktopThemeMode = (typeof DESKTOP_THEME_MODES)[number]

export const DESKTOP_SETTINGS_VERSION = 7 as const
export const DESKTOP_BACKGROUND_LAYERS = ['canvas', 'sidebar', 'content'] as const
export type DesktopBackgroundLayer = (typeof DESKTOP_BACKGROUND_LAYERS)[number]

export const DESKTOP_SETTINGS_CHANNELS = Object.freeze({
  read: 'dsh-desktop:settings:read',
  update: 'dsh-desktop:settings:update',
  chooseBackground: 'dsh-desktop:settings:choose-background',
  applyBackground: 'dsh-desktop:settings:apply-background',
  cancelBackground: 'dsh-desktop:settings:cancel-background',
  clearBackground: 'dsh-desktop:settings:clear-background',
  changed: 'dsh-desktop:settings:changed',
  openRequested: 'dsh-desktop:settings:open-requested',
})

export interface DesktopSettingsPatch {
  colorScheme?: DesktopColorScheme
  canvasColorScheme?: DesktopCanvasColorScheme
  fontFamily?: DesktopFontFamily
  fontSize?: number
  editorFontSize?: number
  editorLineHeight?: DesktopEditorLineHeight
  editorLigatures?: boolean
  islandGap?: number
  accentColor?: string
  canvasTransparency?: number
  contentScrimOpacity?: number
}

export interface DesktopSettingsSnapshot {
  version: typeof DESKTOP_SETTINGS_VERSION
  revision: number
  colorScheme: DesktopColorScheme
  canvasColorScheme: DesktopCanvasColorScheme
  fontFamily: DesktopFontFamily
  fontSize: number
  editorFontSize: number
  editorLineHeight: DesktopEditorLineHeight
  editorLigatures: boolean
  islandGap: number
  accentColor: string
  canvasTransparency: number
  contentScrimOpacity: number
  backgrounds: Record<DesktopBackgroundLayer, string | null>
  warning?: string
}

export interface DesktopBackgroundChooseRequest {
  layer: DesktopBackgroundLayer
  targetAspectRatio: number
}

export interface DesktopBackgroundSelection {
  id: string
  layer: DesktopBackgroundLayer
  previewDataUrl: string
  sourceWidth: number
  sourceHeight: number
  targetAspectRatio: number
}

export interface DesktopBackgroundCropRect {
  x: number
  y: number
  width: number
  height: number
}

export interface DesktopBackgroundApplyRequest {
  selectionId: string
  crop: DesktopBackgroundCropRect
}

// 版本 1–7 的材质字段仅用于读取旧设置，当前快照与更新接口不再暴露它们。
interface StoredDesktopSettings {
  version: typeof DESKTOP_SETTINGS_VERSION
  themeMode: DesktopThemeMode
  colorScheme: DesktopColorScheme
  canvasColorScheme: DesktopCanvasColorScheme
  fontFamily: DesktopFontFamily
  fontSize: number
  editorFontSize: number
  editorLineHeight: DesktopEditorLineHeight
  editorLigatures: boolean
  islandGap: number
  accentColor: string
  canvasTransparency: number
  islandChromeTransparency: number
  islandContentTransparency: number
  contentScrimOpacity: number
  backgroundLayers: DesktopBackgroundLayer[]
}

interface StoredDesktopSettingsV3 {
  version: 3
  themeMode: DesktopThemeMode
  accentColor: string
  canvasTransparency: number
  islandChromeTransparency: number
  islandContentTransparency: number
  contentScrimOpacity: number
  backgroundLayers: DesktopBackgroundLayer[]
}

interface StoredDesktopSettingsV4 {
  version: 4
  themeMode: DesktopThemeMode
  fontFamily: DesktopFontFamily
  fontSize: number
  accentColor: string
  canvasTransparency: number
  islandChromeTransparency: number
  islandContentTransparency: number
  contentScrimOpacity: number
  backgroundLayers: DesktopBackgroundLayer[]
}

interface StoredDesktopSettingsV5 {
  version: 5
  themeMode: DesktopThemeMode
  fontFamily: DesktopFontFamily
  fontSize: number
  islandGap: number
  accentColor: string
  canvasTransparency: number
  islandChromeTransparency: number
  islandContentTransparency: number
  contentScrimOpacity: number
  backgroundLayers: DesktopBackgroundLayer[]
}

interface StoredDesktopSettingsV6 {
  version: 6
  themeMode: DesktopThemeMode
  colorScheme: DesktopColorScheme
  fontFamily: DesktopFontFamily
  fontSize: number
  islandGap: number
  accentColor: string
  canvasTransparency: number
  islandChromeTransparency: number
  islandContentTransparency: number
  contentScrimOpacity: number
  backgroundLayers: DesktopBackgroundLayer[]
}

interface StoredDesktopSettingsV2 {
  version: 2
  accentColor: string
  canvasTransparency: number
  islandChromeTransparency: number
  islandContentTransparency: number
  backgroundLayers: DesktopBackgroundLayer[]
}

interface StoredDesktopSettingsV1 {
  version: 1
  accentColor: string
  canvasTransparency: number
  backgroundLayers: DesktopBackgroundLayer[]
}

const DEFAULT_SETTINGS: StoredDesktopSettings = {
  version: DESKTOP_SETTINGS_VERSION,
  themeMode: 'classic',
  colorScheme: 'system',
  canvasColorScheme: 'follow-interface',
  fontFamily: 'system',
  fontSize: DESKTOP_FONT_SIZE_RANGE.default,
  editorFontSize: DESKTOP_EDITOR_FONT_SIZE_RANGE.default,
  editorLineHeight: 'standard',
  editorLigatures: false,
  islandGap: DESKTOP_ISLAND_GAP_RANGE.default,
  accentColor: '#4d6bfe',
  canvasTransparency: 0.32,
  islandChromeTransparency: 0.18,
  islandContentTransparency: 0.1,
  contentScrimOpacity: 0.82,
  backgroundLayers: [],
}
const SETTINGS_FILE_NAME = 'desktop-settings.json'
const BACKGROUND_DIRECTORY_NAME = 'backgrounds'
const MAX_NORMALIZED_BACKGROUND_BYTES = 48 * 1024 * 1024
const HEX_COLOR = /^#[\da-f]{6}$/iu
const SELECTION_ID = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/iu

/**
 * 在正式产品名首次启动时只迁移桌面外观白名单，不复制缓存、会话或运行核心数据。
 * 目标已有设置时永远不覆盖；设置文件最后落盘，避免它提前引用尚未复制的背景。
 */
export function migrateLegacyDesktopSettings(
  targetRoot: string,
  legacyRoots: readonly string[],
): string | undefined {
  const targetSettings = join(targetRoot, SETTINGS_FILE_NAME)
  if (existsSync(targetSettings)) return undefined
  for (const legacyRoot of legacyRoots) {
    const sourceSettings = join(legacyRoot, SETTINGS_FILE_NAME)
    if (!existsSync(sourceSettings)) continue
    const targetBackgroundDirectory = join(targetRoot, BACKGROUND_DIRECTORY_NAME)
    const temporaryPaths: string[] = []
    try {
      mkdirSync(targetRoot, { recursive: true, mode: 0o700 })
      mkdirSync(targetBackgroundDirectory, { recursive: true, mode: 0o700 })
      for (const layer of DESKTOP_BACKGROUND_LAYERS) {
        const source = join(legacyRoot, BACKGROUND_DIRECTORY_NAME, `${layer}.png`)
        if (!existsSync(source)) continue
        const target = join(targetBackgroundDirectory, `${layer}.png`)
        const temporary = `${target}.migrate-${process.pid}`
        temporaryPaths.push(temporary)
        copyFileSync(source, temporary)
        chmodSync(temporary, 0o600)
        renameSync(temporary, target)
      }
      const temporarySettings = `${targetSettings}.migrate-${process.pid}`
      temporaryPaths.push(temporarySettings)
      copyFileSync(sourceSettings, temporarySettings)
      chmodSync(temporarySettings, 0o600)
      renameSync(temporarySettings, targetSettings)
      return legacyRoot
    } finally {
      for (const temporary of temporaryPaths) rmSync(temporary, { force: true })
    }
  }
  return undefined
}

export class DesktopSettingsValidationError extends Error {}

function normalizeAccentColor(value: unknown): string {
  if (typeof value !== 'string' || !HEX_COLOR.test(value)) {
    throw new DesktopSettingsValidationError('主题色必须是 #RRGGBB 格式')
  }
  return value.toLowerCase()
}

function normalizeTransparency(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new DesktopSettingsValidationError('透明度必须是 0 到 1 之间的有限数值')
  }
  return Math.round(value * 100) / 100
}

function normalizeThemeMode(value: unknown): DesktopThemeMode {
  if (typeof value !== 'string' || !DESKTOP_THEME_MODES.includes(value as DesktopThemeMode)) {
    throw new DesktopSettingsValidationError('主题模式必须是 classic 或 glass')
  }
  return value as DesktopThemeMode
}

function normalizeColorScheme(value: unknown): DesktopColorScheme {
  if (typeof value !== 'string' || !DESKTOP_COLOR_SCHEMES.includes(value as DesktopColorScheme)) {
    throw new DesktopSettingsValidationError('配色模式必须是 system、light 或 dark')
  }
  return value as DesktopColorScheme
}

function normalizeCanvasColorScheme(value: unknown): DesktopCanvasColorScheme {
  if (
    typeof value !== 'string' ||
    !DESKTOP_CANVAS_COLOR_SCHEMES.includes(value as DesktopCanvasColorScheme)
  ) {
    throw new DesktopSettingsValidationError('画布配色必须是 follow-interface、light 或 dark')
  }
  return value as DesktopCanvasColorScheme
}

function normalizeFontFamily(value: unknown): DesktopFontFamily {
  if (typeof value !== 'string' || !DESKTOP_FONT_FAMILIES.includes(value as DesktopFontFamily)) {
    throw new DesktopSettingsValidationError('字体必须是 system、humanist 或 monospace')
  }
  return value as DesktopFontFamily
}

function normalizeFontSize(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < DESKTOP_FONT_SIZE_RANGE.minimum ||
    value > DESKTOP_FONT_SIZE_RANGE.maximum
  ) {
    throw new DesktopSettingsValidationError(
      `字号必须是 ${String(DESKTOP_FONT_SIZE_RANGE.minimum)} 到 ${String(DESKTOP_FONT_SIZE_RANGE.maximum)} 之间的整数`,
    )
  }
  return value
}

function normalizeEditorFontSize(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < DESKTOP_EDITOR_FONT_SIZE_RANGE.minimum ||
    value > DESKTOP_EDITOR_FONT_SIZE_RANGE.maximum
  ) {
    throw new DesktopSettingsValidationError(
      `代码字号必须是 ${String(DESKTOP_EDITOR_FONT_SIZE_RANGE.minimum)} 到 ${String(DESKTOP_EDITOR_FONT_SIZE_RANGE.maximum)} 之间的整数`,
    )
  }
  return value
}

function normalizeEditorLineHeight(value: unknown): DesktopEditorLineHeight {
  if (
    typeof value !== 'string' ||
    !DESKTOP_EDITOR_LINE_HEIGHTS.includes(value as DesktopEditorLineHeight)
  ) {
    throw new DesktopSettingsValidationError('代码行高必须是 compact、standard 或 relaxed')
  }
  return value as DesktopEditorLineHeight
}

function normalizeEditorLigatures(value: unknown): boolean {
  if (typeof value !== 'boolean')
    throw new DesktopSettingsValidationError('代码连字开关必须是布尔值')
  return value
}

function normalizeIslandGap(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < DESKTOP_ISLAND_GAP_RANGE.minimum ||
    value > DESKTOP_ISLAND_GAP_RANGE.maximum
  ) {
    throw new DesktopSettingsValidationError(
      `浮岛间隙必须是 ${String(DESKTOP_ISLAND_GAP_RANGE.minimum)} 到 ${String(DESKTOP_ISLAND_GAP_RANGE.maximum)} 之间的整数`,
    )
  }
  return value
}

export function parseDesktopBackgroundLayer(value: unknown): DesktopBackgroundLayer {
  if (
    typeof value !== 'string' ||
    !DESKTOP_BACKGROUND_LAYERS.includes(value as DesktopBackgroundLayer)
  ) {
    throw new DesktopSettingsValidationError('背景目标必须是 canvas、sidebar 或 content')
  }
  return value as DesktopBackgroundLayer
}

export function parseDesktopBackgroundChooseRequest(
  value: unknown,
): DesktopBackgroundChooseRequest {
  if (!isRecord(value)) throw new DesktopSettingsValidationError('背景图片选择请求必须是对象')
  const allowed = new Set(['layer', 'targetAspectRatio'])
  const unknownKey = Object.keys(value).find(key => !allowed.has(key))
  if (unknownKey !== undefined) {
    throw new DesktopSettingsValidationError(`背景图片选择不支持字段：${unknownKey}`)
  }
  if (
    typeof value.targetAspectRatio !== 'number' ||
    !Number.isFinite(value.targetAspectRatio) ||
    value.targetAspectRatio < 0.1 ||
    value.targetAspectRatio > 6
  ) {
    throw new DesktopSettingsValidationError('背景裁剪比例必须是 0.1 到 6 之间的有限数值')
  }
  return {
    layer: parseDesktopBackgroundLayer(value.layer),
    targetAspectRatio: Math.round(value.targetAspectRatio * 10_000) / 10_000,
  }
}

export function parseDesktopBackgroundSelectionId(value: unknown): string {
  if (typeof value !== 'string' || !SELECTION_ID.test(value)) {
    throw new DesktopSettingsValidationError('背景图片选择标识无效或已经过期')
  }
  return value.toLowerCase()
}

export function parseDesktopBackgroundApplyRequest(value: unknown): DesktopBackgroundApplyRequest {
  if (!isRecord(value)) throw new DesktopSettingsValidationError('背景图片裁剪请求必须是对象')
  const allowed = new Set(['selectionId', 'crop'])
  const unknownKey = Object.keys(value).find(key => !allowed.has(key))
  if (unknownKey !== undefined) {
    throw new DesktopSettingsValidationError(`背景图片裁剪不支持字段：${unknownKey}`)
  }
  if (!isRecord(value.crop)) throw new DesktopSettingsValidationError('背景图片裁剪区域必须是对象')
  const cropAllowed = new Set(['x', 'y', 'width', 'height'])
  const unknownCropKey = Object.keys(value.crop).find(key => !cropAllowed.has(key))
  if (unknownCropKey !== undefined) {
    throw new DesktopSettingsValidationError(`背景图片裁剪区域不支持字段：${unknownCropKey}`)
  }
  const numbers = ['x', 'y', 'width', 'height'] as const
  for (const key of numbers) {
    const number = value.crop[key]
    if (typeof number !== 'number' || !Number.isFinite(number)) {
      throw new DesktopSettingsValidationError('背景图片裁剪区域必须使用有限数值')
    }
  }
  const crop = {
    x: value.crop.x as number,
    y: value.crop.y as number,
    width: value.crop.width as number,
    height: value.crop.height as number,
  }
  if (
    crop.x < 0 ||
    crop.y < 0 ||
    crop.width <= 0 ||
    crop.height <= 0 ||
    crop.width > 1 ||
    crop.height > 1 ||
    crop.x + crop.width > 1.000_001 ||
    crop.y + crop.height > 1.000_001
  ) {
    throw new DesktopSettingsValidationError('背景图片裁剪区域必须完整位于源图范围内')
  }
  return {
    selectionId: parseDesktopBackgroundSelectionId(value.selectionId),
    crop: {
      x: Math.round(crop.x * 1_000_000) / 1_000_000,
      y: Math.round(crop.y * 1_000_000) / 1_000_000,
      width: Math.round(crop.width * 1_000_000) / 1_000_000,
      height: Math.round(crop.height * 1_000_000) / 1_000_000,
    },
  }
}

export function parseDesktopSettingsPatch(value: unknown): DesktopSettingsPatch {
  if (!isRecord(value)) throw new DesktopSettingsValidationError('桌面设置更新必须是对象')
  const allowed = new Set([
    'colorScheme',
    'canvasColorScheme',
    'fontFamily',
    'fontSize',
    'editorFontSize',
    'editorLineHeight',
    'editorLigatures',
    'islandGap',
    'accentColor',
    'canvasTransparency',
    'contentScrimOpacity',
  ])
  const unknownKey = Object.keys(value).find(key => !allowed.has(key))
  if (unknownKey !== undefined) {
    throw new DesktopSettingsValidationError(`桌面设置不支持字段：${unknownKey}`)
  }
  return {
    ...(value.colorScheme === undefined
      ? {}
      : { colorScheme: normalizeColorScheme(value.colorScheme) }),
    ...(value.canvasColorScheme === undefined
      ? {}
      : { canvasColorScheme: normalizeCanvasColorScheme(value.canvasColorScheme) }),
    ...(value.fontFamily === undefined
      ? {}
      : { fontFamily: normalizeFontFamily(value.fontFamily) }),
    ...(value.fontSize === undefined ? {} : { fontSize: normalizeFontSize(value.fontSize) }),
    ...(value.editorFontSize === undefined
      ? {}
      : { editorFontSize: normalizeEditorFontSize(value.editorFontSize) }),
    ...(value.editorLineHeight === undefined
      ? {}
      : { editorLineHeight: normalizeEditorLineHeight(value.editorLineHeight) }),
    ...(value.editorLigatures === undefined
      ? {}
      : { editorLigatures: normalizeEditorLigatures(value.editorLigatures) }),
    ...(value.islandGap === undefined ? {} : { islandGap: normalizeIslandGap(value.islandGap) }),
    ...(value.accentColor === undefined
      ? {}
      : { accentColor: normalizeAccentColor(value.accentColor) }),
    ...(value.canvasTransparency === undefined
      ? {}
      : { canvasTransparency: normalizeTransparency(value.canvasTransparency) }),
    ...(value.contentScrimOpacity === undefined
      ? {}
      : { contentScrimOpacity: normalizeTransparency(value.contentScrimOpacity) }),
  }
}

function parseBackgroundLayers(value: unknown): DesktopBackgroundLayer[] {
  if (!Array.isArray(value)) {
    throw new DesktopSettingsValidationError('背景层列表必须是数组')
  }
  const backgroundLayers = value.map(parseDesktopBackgroundLayer)
  if (new Set(backgroundLayers).size !== backgroundLayers.length) {
    throw new DesktopSettingsValidationError('背景层列表不能包含重复项')
  }
  return backgroundLayers
}

function parseStoredSettingsV1(value: Record<string, unknown>): StoredDesktopSettingsV1 {
  const allowed = new Set(['version', 'accentColor', 'canvasTransparency', 'backgroundLayers'])
  const unknownKey = Object.keys(value).find(key => !allowed.has(key))
  if (unknownKey !== undefined) {
    throw new DesktopSettingsValidationError(`桌面设置文件不支持字段：${unknownKey}`)
  }
  return {
    version: 1,
    accentColor: normalizeAccentColor(value.accentColor),
    canvasTransparency: normalizeTransparency(value.canvasTransparency),
    backgroundLayers: parseBackgroundLayers(value.backgroundLayers),
  }
}

function parseStoredSettingsV2(value: Record<string, unknown>): StoredDesktopSettingsV2 {
  const allowed = new Set([
    'version',
    'accentColor',
    'canvasTransparency',
    'islandChromeTransparency',
    'islandContentTransparency',
    'backgroundLayers',
  ])
  const unknownKey = Object.keys(value).find(key => !allowed.has(key))
  if (unknownKey !== undefined) {
    throw new DesktopSettingsValidationError(`桌面设置文件不支持字段：${unknownKey}`)
  }
  return {
    version: 2,
    accentColor: normalizeAccentColor(value.accentColor),
    canvasTransparency: normalizeTransparency(value.canvasTransparency),
    islandChromeTransparency: normalizeTransparency(value.islandChromeTransparency),
    islandContentTransparency: normalizeTransparency(value.islandContentTransparency),
    backgroundLayers: parseBackgroundLayers(value.backgroundLayers),
  }
}

function parseStoredSettingsV3(value: Record<string, unknown>): StoredDesktopSettingsV3 {
  const allowed = new Set([
    'version',
    'themeMode',
    'accentColor',
    'canvasTransparency',
    'islandChromeTransparency',
    'islandContentTransparency',
    'contentScrimOpacity',
    'backgroundLayers',
  ])
  const unknownKey = Object.keys(value).find(key => !allowed.has(key))
  if (unknownKey !== undefined) {
    throw new DesktopSettingsValidationError(`桌面设置文件不支持字段：${unknownKey}`)
  }
  return {
    version: 3,
    themeMode: normalizeThemeMode(value.themeMode),
    accentColor: normalizeAccentColor(value.accentColor),
    canvasTransparency: normalizeTransparency(value.canvasTransparency),
    islandChromeTransparency: normalizeTransparency(value.islandChromeTransparency),
    islandContentTransparency: normalizeTransparency(value.islandContentTransparency),
    contentScrimOpacity: normalizeTransparency(value.contentScrimOpacity),
    backgroundLayers: parseBackgroundLayers(value.backgroundLayers),
  }
}

function parseStoredSettingsV4(value: Record<string, unknown>): StoredDesktopSettingsV4 {
  const allowed = new Set([
    'version',
    'themeMode',
    'fontFamily',
    'fontSize',
    'accentColor',
    'canvasTransparency',
    'islandChromeTransparency',
    'islandContentTransparency',
    'contentScrimOpacity',
    'backgroundLayers',
  ])
  const unknownKey = Object.keys(value).find(key => !allowed.has(key))
  if (unknownKey !== undefined) {
    throw new DesktopSettingsValidationError(`桌面设置文件不支持字段：${unknownKey}`)
  }
  return {
    version: 4,
    themeMode: normalizeThemeMode(value.themeMode),
    fontFamily: normalizeFontFamily(value.fontFamily),
    fontSize: normalizeFontSize(value.fontSize),
    accentColor: normalizeAccentColor(value.accentColor),
    canvasTransparency: normalizeTransparency(value.canvasTransparency),
    islandChromeTransparency: normalizeTransparency(value.islandChromeTransparency),
    islandContentTransparency: normalizeTransparency(value.islandContentTransparency),
    contentScrimOpacity: normalizeTransparency(value.contentScrimOpacity),
    backgroundLayers: parseBackgroundLayers(value.backgroundLayers),
  }
}

function parseStoredSettingsV5(value: Record<string, unknown>): StoredDesktopSettingsV5 {
  const allowed = new Set([
    'version',
    'themeMode',
    'fontFamily',
    'fontSize',
    'islandGap',
    'accentColor',
    'canvasTransparency',
    'islandChromeTransparency',
    'islandContentTransparency',
    'contentScrimOpacity',
    'backgroundLayers',
  ])
  const unknownKey = Object.keys(value).find(key => !allowed.has(key))
  if (unknownKey !== undefined) {
    throw new DesktopSettingsValidationError(`桌面设置文件不支持字段：${unknownKey}`)
  }
  return {
    version: 5,
    themeMode: normalizeThemeMode(value.themeMode),
    fontFamily: normalizeFontFamily(value.fontFamily),
    fontSize: normalizeFontSize(value.fontSize),
    islandGap: normalizeIslandGap(value.islandGap),
    accentColor: normalizeAccentColor(value.accentColor),
    canvasTransparency: normalizeTransparency(value.canvasTransparency),
    islandChromeTransparency: normalizeTransparency(value.islandChromeTransparency),
    islandContentTransparency: normalizeTransparency(value.islandContentTransparency),
    contentScrimOpacity: normalizeTransparency(value.contentScrimOpacity),
    backgroundLayers: parseBackgroundLayers(value.backgroundLayers),
  }
}

function parseStoredSettingsV6(value: Record<string, unknown>): StoredDesktopSettingsV6 {
  const allowed = new Set([
    'version',
    'themeMode',
    'colorScheme',
    'fontFamily',
    'fontSize',
    'islandGap',
    'accentColor',
    'canvasTransparency',
    'islandChromeTransparency',
    'islandContentTransparency',
    'contentScrimOpacity',
    'backgroundLayers',
  ])
  const unknownKey = Object.keys(value).find(key => !allowed.has(key))
  if (unknownKey !== undefined) {
    throw new DesktopSettingsValidationError(`桌面设置文件不支持字段：${unknownKey}`)
  }
  return {
    version: 6,
    themeMode: normalizeThemeMode(value.themeMode),
    colorScheme: normalizeColorScheme(value.colorScheme),
    fontFamily: normalizeFontFamily(value.fontFamily),
    fontSize: normalizeFontSize(value.fontSize),
    islandGap: normalizeIslandGap(value.islandGap),
    accentColor: normalizeAccentColor(value.accentColor),
    canvasTransparency: normalizeTransparency(value.canvasTransparency),
    islandChromeTransparency: normalizeTransparency(value.islandChromeTransparency),
    islandContentTransparency: normalizeTransparency(value.islandContentTransparency),
    contentScrimOpacity: normalizeTransparency(value.contentScrimOpacity),
    backgroundLayers: parseBackgroundLayers(value.backgroundLayers),
  }
}

function parseStoredSettings(value: unknown): StoredDesktopSettings {
  if (
    !isRecord(value) ||
    (value.version !== 1 &&
      value.version !== 2 &&
      value.version !== 3 &&
      value.version !== 4 &&
      value.version !== 5 &&
      value.version !== 6 &&
      value.version !== DESKTOP_SETTINGS_VERSION)
  ) {
    throw new DesktopSettingsValidationError('桌面设置版本必须是 1、2、3、4、5、6 或 7')
  }
  if (value.version === 1) {
    const legacy = parseStoredSettingsV1(value)
    return {
      version: DESKTOP_SETTINGS_VERSION,
      themeMode: 'glass',
      colorScheme: DEFAULT_SETTINGS.colorScheme,
      canvasColorScheme: DEFAULT_SETTINGS.canvasColorScheme,
      fontFamily: DEFAULT_SETTINGS.fontFamily,
      fontSize: DEFAULT_SETTINGS.fontSize,
      editorFontSize: DEFAULT_SETTINGS.editorFontSize,
      editorLineHeight: DEFAULT_SETTINGS.editorLineHeight,
      editorLigatures: DEFAULT_SETTINGS.editorLigatures,
      islandGap: DEFAULT_SETTINGS.islandGap,
      accentColor: legacy.accentColor,
      canvasTransparency: legacy.canvasTransparency,
      islandChromeTransparency: DEFAULT_SETTINGS.islandChromeTransparency,
      islandContentTransparency: DEFAULT_SETTINGS.islandContentTransparency,
      contentScrimOpacity: DEFAULT_SETTINGS.contentScrimOpacity,
      backgroundLayers: legacy.backgroundLayers,
    }
  }
  if (value.version === 2) {
    const legacy = parseStoredSettingsV2(value)
    return {
      ...legacy,
      version: DESKTOP_SETTINGS_VERSION,
      themeMode: 'glass',
      colorScheme: DEFAULT_SETTINGS.colorScheme,
      canvasColorScheme: DEFAULT_SETTINGS.canvasColorScheme,
      fontFamily: DEFAULT_SETTINGS.fontFamily,
      fontSize: DEFAULT_SETTINGS.fontSize,
      editorFontSize: DEFAULT_SETTINGS.editorFontSize,
      editorLineHeight: DEFAULT_SETTINGS.editorLineHeight,
      editorLigatures: DEFAULT_SETTINGS.editorLigatures,
      islandGap: DEFAULT_SETTINGS.islandGap,
      contentScrimOpacity: DEFAULT_SETTINGS.contentScrimOpacity,
    }
  }
  if (value.version === 3) {
    const legacy = parseStoredSettingsV3(value)
    return {
      ...legacy,
      version: DESKTOP_SETTINGS_VERSION,
      colorScheme: DEFAULT_SETTINGS.colorScheme,
      canvasColorScheme: DEFAULT_SETTINGS.canvasColorScheme,
      fontFamily: DEFAULT_SETTINGS.fontFamily,
      fontSize: DEFAULT_SETTINGS.fontSize,
      editorFontSize: DEFAULT_SETTINGS.editorFontSize,
      editorLineHeight: DEFAULT_SETTINGS.editorLineHeight,
      editorLigatures: DEFAULT_SETTINGS.editorLigatures,
      islandGap: DEFAULT_SETTINGS.islandGap,
    }
  }
  if (value.version === 4) {
    const legacy = parseStoredSettingsV4(value)
    return {
      ...legacy,
      version: DESKTOP_SETTINGS_VERSION,
      colorScheme: DEFAULT_SETTINGS.colorScheme,
      canvasColorScheme: DEFAULT_SETTINGS.canvasColorScheme,
      islandGap: DEFAULT_SETTINGS.islandGap,
      editorFontSize: DEFAULT_SETTINGS.editorFontSize,
      editorLineHeight: DEFAULT_SETTINGS.editorLineHeight,
      editorLigatures: DEFAULT_SETTINGS.editorLigatures,
    }
  }
  if (value.version === 5) {
    return {
      ...parseStoredSettingsV5(value),
      version: DESKTOP_SETTINGS_VERSION,
      colorScheme: DEFAULT_SETTINGS.colorScheme,
      canvasColorScheme: DEFAULT_SETTINGS.canvasColorScheme,
      editorFontSize: DEFAULT_SETTINGS.editorFontSize,
      editorLineHeight: DEFAULT_SETTINGS.editorLineHeight,
      editorLigatures: DEFAULT_SETTINGS.editorLigatures,
    }
  }
  if (value.version === 6) {
    return {
      ...parseStoredSettingsV6(value),
      version: DESKTOP_SETTINGS_VERSION,
      canvasColorScheme: DEFAULT_SETTINGS.canvasColorScheme,
      editorFontSize: DEFAULT_SETTINGS.editorFontSize,
      editorLineHeight: DEFAULT_SETTINGS.editorLineHeight,
      editorLigatures: DEFAULT_SETTINGS.editorLigatures,
    }
  }
  const allowed = new Set([
    'version',
    'themeMode',
    'colorScheme',
    'canvasColorScheme',
    'fontFamily',
    'fontSize',
    'editorFontSize',
    'editorLineHeight',
    'editorLigatures',
    'islandGap',
    'accentColor',
    'canvasTransparency',
    'islandChromeTransparency',
    'islandContentTransparency',
    'contentScrimOpacity',
    'backgroundLayers',
  ])
  const unknownKey = Object.keys(value).find(key => !allowed.has(key))
  if (unknownKey !== undefined) {
    throw new DesktopSettingsValidationError(`桌面设置文件不支持字段：${unknownKey}`)
  }
  return {
    version: DESKTOP_SETTINGS_VERSION,
    themeMode: normalizeThemeMode(value.themeMode),
    colorScheme: normalizeColorScheme(value.colorScheme),
    canvasColorScheme:
      value.canvasColorScheme === undefined
        ? DEFAULT_SETTINGS.canvasColorScheme
        : normalizeCanvasColorScheme(value.canvasColorScheme),
    fontFamily: normalizeFontFamily(value.fontFamily),
    fontSize: normalizeFontSize(value.fontSize),
    editorFontSize: normalizeEditorFontSize(value.editorFontSize),
    editorLineHeight: normalizeEditorLineHeight(value.editorLineHeight),
    editorLigatures: normalizeEditorLigatures(value.editorLigatures),
    islandGap: normalizeIslandGap(value.islandGap),
    accentColor: normalizeAccentColor(value.accentColor),
    canvasTransparency: normalizeTransparency(value.canvasTransparency),
    islandChromeTransparency: normalizeTransparency(value.islandChromeTransparency),
    islandContentTransparency: normalizeTransparency(value.islandContentTransparency),
    contentScrimOpacity: normalizeTransparency(value.contentScrimOpacity),
    backgroundLayers: parseBackgroundLayers(value.backgroundLayers),
  }
}

function cloneSettings(settings: StoredDesktopSettings): StoredDesktopSettings {
  return { ...settings, backgroundLayers: [...settings.backgroundLayers] }
}

export class DesktopSettingsStore {
  readonly #root: string
  readonly #settingsPath: string
  readonly #backgroundDirectory: string
  #settings = cloneSettings(DEFAULT_SETTINGS)
  #revision = 0
  #warning: string | undefined

  constructor(root: string) {
    this.#root = root
    this.#settingsPath = join(root, SETTINGS_FILE_NAME)
    this.#backgroundDirectory = join(root, BACKGROUND_DIRECTORY_NAME)
    this.#load()
  }

  #load(): void {
    if (!existsSync(this.#settingsPath)) return
    try {
      this.#settings = parseStoredSettings(JSON.parse(readFileSync(this.#settingsPath, 'utf8')))
    } catch {
      this.#settings = cloneSettings(DEFAULT_SETTINGS)
      this.#warning = '桌面设置文件无法读取，当前已使用默认值；原文件没有被覆盖。'
    }
  }

  #backgroundPath(layer: DesktopBackgroundLayer): string {
    return join(this.#backgroundDirectory, `${layer}.png`)
  }

  #persist(): void {
    mkdirSync(this.#root, { recursive: true, mode: 0o700 })
    const temporaryPath = `${this.#settingsPath}.tmp-${process.pid}`
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(this.#settings, null, 2)}\n`, { mode: 0o600 })
      renameSync(temporaryPath, this.#settingsPath)
      this.#warning = undefined
    } finally {
      rmSync(temporaryPath, { force: true })
    }
  }

  #backgroundDataUrl(layer: DesktopBackgroundLayer): string | null {
    if (!this.#settings.backgroundLayers.includes(layer)) return null
    try {
      return `data:image/png;base64,${readFileSync(this.#backgroundPath(layer)).toString('base64')}`
    } catch {
      this.#warning = `“${layer}”背景文件缺失，已保留设置供用户重新选择。`
      return null
    }
  }

  read(): DesktopSettingsSnapshot {
    const snapshot: DesktopSettingsSnapshot = {
      version: DESKTOP_SETTINGS_VERSION,
      revision: this.#revision,
      colorScheme: this.#settings.colorScheme,
      canvasColorScheme: this.#settings.canvasColorScheme,
      fontFamily: this.#settings.fontFamily,
      fontSize: this.#settings.fontSize,
      editorFontSize: this.#settings.editorFontSize,
      editorLineHeight: this.#settings.editorLineHeight,
      editorLigatures: this.#settings.editorLigatures,
      islandGap: this.#settings.islandGap,
      accentColor: this.#settings.accentColor,
      canvasTransparency: this.#settings.canvasTransparency,
      contentScrimOpacity: this.#settings.contentScrimOpacity,
      backgrounds: {
        canvas: this.#backgroundDataUrl('canvas'),
        sidebar: this.#backgroundDataUrl('sidebar'),
        content: this.#backgroundDataUrl('content'),
      },
    }
    return this.#warning === undefined ? snapshot : { ...snapshot, warning: this.#warning }
  }

  update(value: unknown): DesktopSettingsSnapshot {
    const patch = parseDesktopSettingsPatch(value)
    const next = {
      ...this.#settings,
      ...patch,
      backgroundLayers: [...this.#settings.backgroundLayers],
    }
    if (
      next.colorScheme === this.#settings.colorScheme &&
      next.canvasColorScheme === this.#settings.canvasColorScheme &&
      next.fontFamily === this.#settings.fontFamily &&
      next.fontSize === this.#settings.fontSize &&
      next.editorFontSize === this.#settings.editorFontSize &&
      next.editorLineHeight === this.#settings.editorLineHeight &&
      next.editorLigatures === this.#settings.editorLigatures &&
      next.islandGap === this.#settings.islandGap &&
      next.accentColor === this.#settings.accentColor &&
      next.canvasTransparency === this.#settings.canvasTransparency &&
      next.contentScrimOpacity === this.#settings.contentScrimOpacity
    )
      return this.read()
    this.#settings = next
    this.#persist()
    this.#revision += 1
    return this.read()
  }

  setBackground(value: unknown, png: Uint8Array): DesktopSettingsSnapshot {
    const layer = parseDesktopBackgroundLayer(value)
    if (png.byteLength === 0 || png.byteLength > MAX_NORMALIZED_BACKGROUND_BYTES) {
      throw new DesktopSettingsValidationError('规范化背景图必须大于 0 字节且不超过 48 MB')
    }
    mkdirSync(this.#backgroundDirectory, { recursive: true, mode: 0o700 })
    const path = this.#backgroundPath(layer)
    if (
      this.#settings.backgroundLayers.includes(layer) &&
      existsSync(path) &&
      Buffer.from(png).equals(readFileSync(path))
    )
      return this.read()
    const temporaryPath = `${path}.tmp-${process.pid}`
    try {
      writeFileSync(temporaryPath, png, { mode: 0o600 })
      renameSync(temporaryPath, path)
    } finally {
      rmSync(temporaryPath, { force: true })
    }
    if (!this.#settings.backgroundLayers.includes(layer)) {
      this.#settings.backgroundLayers.push(layer)
    }
    this.#persist()
    this.#revision += 1
    return this.read()
  }

  clearBackground(value: unknown): DesktopSettingsSnapshot {
    const layer = parseDesktopBackgroundLayer(value)
    if (!this.#settings.backgroundLayers.includes(layer)) return this.read()
    rmSync(this.#backgroundPath(layer), { force: true })
    this.#settings.backgroundLayers = this.#settings.backgroundLayers.filter(item => item !== layer)
    this.#persist()
    this.#revision += 1
    return this.read()
  }
}
