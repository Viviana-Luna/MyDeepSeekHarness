/**
 * 桌面外观共享契约：定义跨 Electron 主进程与 renderer 复用的纯值常量与联合类型。
 * 运行在主进程与 renderer；不依赖 UI 框架，也不持有任何运行时资源。
 */

/** 桌面界面配色模式列表。 */
export const DESKTOP_COLOR_SCHEMES = ['system', 'light', 'dark'] as const

/** 桌面界面配色模式类型。 */
export type DesktopColorScheme = (typeof DESKTOP_COLOR_SCHEMES)[number]

/** 历史画布配色选项列表，保留用于兼容读取旧版桌面设置文件。 */
export const DESKTOP_CANVAS_COLOR_SCHEMES = ['follow-interface', 'light', 'dark'] as const

/** 历史画布配色模式类型。 */
export type DesktopCanvasColorScheme = (typeof DESKTOP_CANVAS_COLOR_SCHEMES)[number]

/** 桌面界面字体预设列表。 */
export const DESKTOP_FONT_FAMILIES = ['system', 'humanist', 'monospace'] as const

/** 桌面界面字体预设类型。 */
export type DesktopFontFamily = (typeof DESKTOP_FONT_FAMILIES)[number]

/** 桌面界面字号的有效范围与默认值（单位：px）。 */
export const DESKTOP_FONT_SIZE_RANGE = Object.freeze({
  minimum: 11,
  maximum: 18,
  default: 12,
})

/** 历史代码编辑器字号范围，保留用于兼容读取旧版桌面设置文件。 */
export const DESKTOP_EDITOR_FONT_SIZE_RANGE = Object.freeze({
  minimum: 11,
  maximum: 18,
  default: 13,
})

/** 历史代码编辑器行高选项列表，保留用于兼容读取旧版桌面设置文件。 */
export const DESKTOP_EDITOR_LINE_HEIGHTS = ['compact', 'standard', 'relaxed'] as const

/** 历史代码编辑器行高选项类型。 */
export type DesktopEditorLineHeight = (typeof DESKTOP_EDITOR_LINE_HEIGHTS)[number]

/** 历史代码编辑器行高枚举到数值的映射表。 */
export const DESKTOP_EDITOR_LINE_HEIGHT_VALUES: Readonly<Record<DesktopEditorLineHeight, number>> =
  Object.freeze({
    compact: 1.4,
    standard: 1.55,
    relaxed: 1.7,
  })

/** 浮岛间隙的有效范围与官方默认值（单位：px），界面固定按默认值投影。 */
export const DESKTOP_ISLAND_GAP_RANGE = Object.freeze({
  minimum: 5,
  maximum: 20,
  default: 8,
})
