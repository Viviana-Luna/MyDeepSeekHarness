/**
 * Electron 主进程自有的桌面外观设置存储与输入校验。
 *
 * 持久化文件只保存经过校验的标量与背景层标记；背景图片由主进程规范化为 PNG 后
 * 写入固定层文件名，只向 renderer 返回 data URL，永不暴露本机文件系统路径。
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
  DESKTOP_CANVAS_COLOR_SCHEMES,
  DESKTOP_COLOR_SCHEMES,
  DESKTOP_EDITOR_FONT_SIZE_RANGE,
  DESKTOP_EDITOR_LINE_HEIGHTS,
  DESKTOP_FONT_FAMILIES,
  DESKTOP_FONT_SIZE_RANGE,
  DESKTOP_ISLAND_GAP_RANGE,
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

/** 当前桌面外观持久化文件格式版本号。 */
export const DESKTOP_SETTINGS_VERSION = 7 as const

/** 支持自定义背景图的桌面图层标识列表。 */
export const DESKTOP_BACKGROUND_LAYERS = ['canvas', 'sidebar', 'content'] as const

/** 桌面自定义背景图层标识。 */
export type DesktopBackgroundLayer = (typeof DESKTOP_BACKGROUND_LAYERS)[number]

/** 桌面外观设置 IPC 通道名清单。 */
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

/** 允许由 renderer 提交增量更新的桌面外观字段。 */
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

/** 主进程向 renderer 公开的只读桌面外观快照。 */
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

/** 发起背景图片系统文件选择与预览准备的请求载荷。 */
export interface DesktopBackgroundChooseRequest {
  layer: DesktopBackgroundLayer
  targetAspectRatio: number
}

/** 背景图片选择成功后返回给裁剪弹窗的会话预览描述。 */
export interface DesktopBackgroundSelection {
  id: string
  layer: DesktopBackgroundLayer
  previewDataUrl: string
  sourceWidth: number
  sourceHeight: number
  targetAspectRatio: number
}

/** 归一化到源图宽高比例（0–1）的裁剪矩形。 */
export interface DesktopBackgroundCropRect {
  x: number
  y: number
  width: number
  height: number
}

/** 提交背景图裁剪结果并写入指定层文件的请求载荷。 */
export interface DesktopBackgroundApplyRequest {
  selectionId: string
  crop: DesktopBackgroundCropRect
}

// 版本 1–7 的历史材质字段仅用于无损读取旧设置文件，当前公开快照与更新接口不再暴露它们。
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

type StoredFieldKey = Exclude<keyof StoredDesktopSettings, 'version'>
type SupportedSettingsVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7

interface StoredSettingsVersionSchema {
  readonly required: readonly StoredFieldKey[]
  readonly optional?: readonly StoredFieldKey[]
  readonly defaultThemeMode?: DesktopThemeMode
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

const PATCHABLE_FIELDS = [
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
] as const satisfies readonly (keyof DesktopSettingsPatch)[]

const V1_FIELDS: readonly StoredFieldKey[] = [
  'accentColor',
  'canvasTransparency',
  'backgroundLayers',
]
const V2_FIELDS: readonly StoredFieldKey[] = [
  ...V1_FIELDS,
  'islandChromeTransparency',
  'islandContentTransparency',
]
const V3_FIELDS: readonly StoredFieldKey[] = [...V2_FIELDS, 'themeMode', 'contentScrimOpacity']
const V4_FIELDS: readonly StoredFieldKey[] = [...V3_FIELDS, 'fontFamily', 'fontSize']
const V5_FIELDS: readonly StoredFieldKey[] = [...V4_FIELDS, 'islandGap']
const V6_FIELDS: readonly StoredFieldKey[] = [...V5_FIELDS, 'colorScheme']
const V7_FIELDS: readonly StoredFieldKey[] = [
  ...V6_FIELDS,
  'editorFontSize',
  'editorLineHeight',
  'editorLigatures',
]

const SETTINGS_VERSION_SCHEMAS: Record<SupportedSettingsVersion, StoredSettingsVersionSchema> = {
  1: { required: V1_FIELDS, defaultThemeMode: 'glass' },
  2: { required: V2_FIELDS, defaultThemeMode: 'glass' },
  3: { required: V3_FIELDS },
  4: { required: V4_FIELDS },
  5: { required: V5_FIELDS },
  6: { required: V6_FIELDS },
  7: { required: V7_FIELDS, optional: ['canvasColorScheme'] },
}

/** 桌面设置与背景裁剪请求的输入校验错误。 */
export class DesktopSettingsValidationError extends Error {}

function rejectUnexpectedObjectKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  prefix: string,
): void {
  const unknownKey = Object.keys(value).find(key => !allowed.has(key))
  if (unknownKey !== undefined) {
    throw new DesktopSettingsValidationError(`${prefix}：${unknownKey}`)
  }
}

function copyAtomicallyWithMode(source: string, target: string, temporaryPaths: string[]): void {
  const temporary = `${target}.migrate-${String(process.pid)}`
  temporaryPaths.push(temporary)
  copyFileSync(source, temporary)
  chmodSync(temporary, 0o600)
  renameSync(temporary, target)
}

/**
 * 在正式产品名首次启动时只迁移桌面外观白名单文件，不复制缓存、会话或运行核心数据。
 * 目标目录已有设置文件时保持现状；设置文件最后原子落盘，避免提前引用尚未复制完的背景图。
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
        copyAtomicallyWithMode(
          source,
          join(targetBackgroundDirectory, `${layer}.png`),
          temporaryPaths,
        )
      }
      copyAtomicallyWithMode(sourceSettings, targetSettings, temporaryPaths)
      return legacyRoot
    } finally {
      for (const temporary of temporaryPaths) rmSync(temporary, { force: true })
    }
  }
  return undefined
}

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

function normalizeEnumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  message: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new DesktopSettingsValidationError(message)
  }
  return value as T
}

function normalizeIntegerRange(
  value: unknown,
  range: { readonly minimum: number; readonly maximum: number },
  label: string,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < range.minimum ||
    value > range.maximum
  ) {
    throw new DesktopSettingsValidationError(
      `${label}必须是 ${String(range.minimum)} 到 ${String(range.maximum)} 之间的整数`,
    )
  }
  return value
}

function parseBackgroundLayers(value: unknown): DesktopBackgroundLayer[] {
  if (!Array.isArray(value)) throw new DesktopSettingsValidationError('背景层列表必须是数组')
  const backgroundLayers = value.map(parseDesktopBackgroundLayer)
  if (new Set(backgroundLayers).size !== backgroundLayers.length) {
    throw new DesktopSettingsValidationError('背景层列表不能包含重复项')
  }
  return backgroundLayers
}

/** 校验背景图文件选择请求，并将目标宽高比收敛到四位小数。 */
export function parseDesktopBackgroundChooseRequest(
  value: unknown,
): DesktopBackgroundChooseRequest {
  if (!isRecord(value)) throw new DesktopSettingsValidationError('背景图片选择请求必须是对象')
  rejectUnexpectedObjectKeys(
    value,
    new Set(['layer', 'targetAspectRatio']),
    '背景图片选择不支持字段',
  )
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

/** 校验一次性背景图片裁剪会话 UUID 标识。 */
export function parseDesktopBackgroundSelectionId(value: unknown): string {
  if (typeof value !== 'string' || !SELECTION_ID.test(value)) {
    throw new DesktopSettingsValidationError('背景图片选择标识无效或已经过期')
  }
  return value.toLowerCase()
}

function roundToSixDecimals(input: number): number {
  return Math.round(input * 1_000_000) / 1_000_000
}

function parseNormalizedCropRect(value: unknown): DesktopBackgroundCropRect {
  if (!isRecord(value)) throw new DesktopSettingsValidationError('背景图片裁剪区域必须是对象')
  rejectUnexpectedObjectKeys(
    value,
    new Set(['x', 'y', 'width', 'height']),
    '背景图片裁剪区域不支持字段',
  )
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    const coordinate = value[key]
    if (typeof coordinate !== 'number' || !Number.isFinite(coordinate)) {
      throw new DesktopSettingsValidationError('背景图片裁剪区域必须使用有限数值')
    }
  }
  const { x, y, width, height } = value as Record<'x' | 'y' | 'width' | 'height', number>
  if (
    x < 0 ||
    y < 0 ||
    width <= 0 ||
    height <= 0 ||
    width > 1 ||
    height > 1 ||
    x + width > 1.000_001 ||
    y + height > 1.000_001
  ) {
    throw new DesktopSettingsValidationError('背景图片裁剪区域必须完整位于源图范围内')
  }
  return {
    x: roundToSixDecimals(x),
    y: roundToSixDecimals(y),
    width: roundToSixDecimals(width),
    height: roundToSixDecimals(height),
  }
}

/** 校验背景图裁剪提交请求，确保裁剪框位于归一化源图范围内。 */
export function parseDesktopBackgroundApplyRequest(value: unknown): DesktopBackgroundApplyRequest {
  if (!isRecord(value)) throw new DesktopSettingsValidationError('背景图片裁剪请求必须是对象')
  rejectUnexpectedObjectKeys(value, new Set(['selectionId', 'crop']), '背景图片裁剪不支持字段')
  return {
    selectionId: parseDesktopBackgroundSelectionId(value.selectionId),
    crop: parseNormalizedCropRect(value.crop),
  }
}

/** 校验并返回受支持的背景图层名称。 */
export function parseDesktopBackgroundLayer(value: unknown): DesktopBackgroundLayer {
  return normalizeEnumValue(
    value,
    DESKTOP_BACKGROUND_LAYERS,
    '背景目标必须是 canvas、sidebar 或 content',
  )
}

const STORED_FIELD_APPLIERS: {
  readonly [K in StoredFieldKey]: (target: StoredDesktopSettings, raw: unknown) => void
} = {
  themeMode: (t, raw) => {
    t.themeMode = normalizeEnumValue(raw, DESKTOP_THEME_MODES, '主题模式必须是 classic 或 glass')
  },
  colorScheme: (t, raw) => {
    t.colorScheme = normalizeEnumValue(
      raw,
      DESKTOP_COLOR_SCHEMES,
      '配色模式必须是 system、light 或 dark',
    )
  },
  canvasColorScheme: (t, raw) => {
    t.canvasColorScheme = normalizeEnumValue(
      raw,
      DESKTOP_CANVAS_COLOR_SCHEMES,
      '画布配色必须是 follow-interface、light 或 dark',
    )
  },
  fontFamily: (t, raw) => {
    t.fontFamily = normalizeEnumValue(
      raw,
      DESKTOP_FONT_FAMILIES,
      '字体必须是 system、humanist 或 monospace',
    )
  },
  fontSize: (t, raw) => {
    t.fontSize = normalizeIntegerRange(raw, DESKTOP_FONT_SIZE_RANGE, '字号')
  },
  editorFontSize: (t, raw) => {
    t.editorFontSize = normalizeIntegerRange(raw, DESKTOP_EDITOR_FONT_SIZE_RANGE, '代码字号')
  },
  editorLineHeight: (t, raw) => {
    t.editorLineHeight = normalizeEnumValue(
      raw,
      DESKTOP_EDITOR_LINE_HEIGHTS,
      '代码行高必须是 compact、standard 或 relaxed',
    )
  },
  editorLigatures: (t, raw) => {
    if (typeof raw !== 'boolean')
      throw new DesktopSettingsValidationError('代码连字开关必须是布尔值')
    t.editorLigatures = raw
  },
  islandGap: (t, raw) => {
    t.islandGap = normalizeIntegerRange(raw, DESKTOP_ISLAND_GAP_RANGE, '浮岛间隙')
  },
  accentColor: (t, raw) => {
    t.accentColor = normalizeAccentColor(raw)
  },
  canvasTransparency: (t, raw) => {
    t.canvasTransparency = normalizeTransparency(raw)
  },
  islandChromeTransparency: (t, raw) => {
    t.islandChromeTransparency = normalizeTransparency(raw)
  },
  islandContentTransparency: (t, raw) => {
    t.islandContentTransparency = normalizeTransparency(raw)
  },
  contentScrimOpacity: (t, raw) => {
    t.contentScrimOpacity = normalizeTransparency(raw)
  },
  backgroundLayers: (t, raw) => {
    t.backgroundLayers = parseBackgroundLayers(raw)
  },
}

/** 校验来自 IPC 的桌面外观增量补丁，拒绝未知字段与越界值。 */
export function parseDesktopSettingsPatch(value: unknown): DesktopSettingsPatch {
  if (!isRecord(value)) throw new DesktopSettingsValidationError('桌面设置更新必须是对象')
  rejectUnexpectedObjectKeys(value, new Set<string>(PATCHABLE_FIELDS), '桌面设置不支持字段')
  const scratch = cloneSettings(DEFAULT_SETTINGS)
  const patch: DesktopSettingsPatch = {}
  for (const field of PATCHABLE_FIELDS) {
    const candidate = value[field]
    if (candidate === undefined) continue
    STORED_FIELD_APPLIERS[field](scratch, candidate)
    ;(patch as Record<string, unknown>)[field] = scratch[field]
  }
  return patch
}

function parseStoredSettings(value: unknown): StoredDesktopSettings {
  if (
    !isRecord(value) ||
    typeof value.version !== 'number' ||
    !Object.hasOwn(SETTINGS_VERSION_SCHEMAS, value.version)
  ) {
    throw new DesktopSettingsValidationError('桌面设置版本必须是 1、2、3、4、5、6 或 7')
  }
  const schema = SETTINGS_VERSION_SCHEMAS[value.version as SupportedSettingsVersion]
  const allowed = new Set<string>(['version', ...schema.required, ...(schema.optional ?? [])])
  rejectUnexpectedObjectKeys(value, allowed, '桌面设置文件不支持字段')
  const parsed = cloneSettings(DEFAULT_SETTINGS)
  if (schema.defaultThemeMode !== undefined) {
    parsed.themeMode = schema.defaultThemeMode
  }
  for (const field of schema.required) {
    STORED_FIELD_APPLIERS[field](parsed, value[field])
  }
  for (const field of schema.optional ?? []) {
    if (value[field] !== undefined) {
      STORED_FIELD_APPLIERS[field](parsed, value[field])
    }
  }
  return parsed
}

function cloneSettings(settings: StoredDesktopSettings): StoredDesktopSettings {
  return { ...settings, backgroundLayers: [...settings.backgroundLayers] }
}

/**
 * 桌面外观设置存储：管理 `desktop-settings.json` 与 `backgrounds/<layer>.png` 原子持久化。
 * 损坏文件在读取时回退内存默认值并携带告警，不会覆盖磁盘上的原文件。
 */
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
    const temporaryPath = `${this.#settingsPath}.tmp-${String(process.pid)}`
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
    const s = this.#settings
    const backgrounds = Object.fromEntries(
      DESKTOP_BACKGROUND_LAYERS.map(layer => [layer, this.#backgroundDataUrl(layer)]),
    ) as Record<DesktopBackgroundLayer, string | null>
    const snapshot: DesktopSettingsSnapshot = {
      version: DESKTOP_SETTINGS_VERSION,
      revision: this.#revision,
      colorScheme: s.colorScheme,
      canvasColorScheme: s.canvasColorScheme,
      fontFamily: s.fontFamily,
      fontSize: s.fontSize,
      editorFontSize: s.editorFontSize,
      editorLineHeight: s.editorLineHeight,
      editorLigatures: s.editorLigatures,
      islandGap: s.islandGap,
      accentColor: s.accentColor,
      canvasTransparency: s.canvasTransparency,
      contentScrimOpacity: s.contentScrimOpacity,
      backgrounds,
    }
    return this.#warning === undefined ? snapshot : { ...snapshot, warning: this.#warning }
  }

  update(value: unknown): DesktopSettingsSnapshot {
    const patch = parseDesktopSettingsPatch(value)
    const next: StoredDesktopSettings = {
      ...this.#settings,
      ...patch,
      backgroundLayers: [...this.#settings.backgroundLayers],
    }
    if (PATCHABLE_FIELDS.every(field => next[field] === this.#settings[field])) {
      return this.read()
    }
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
    ) {
      return this.read()
    }
    const temporaryPath = `${path}.tmp-${String(process.pid)}`
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
