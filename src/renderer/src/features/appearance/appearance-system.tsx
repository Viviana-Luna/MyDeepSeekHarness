/**
 * 桌面外观系统：将桌面设置同步投影为工作台 CSS 变量与 Ant Design 主题配置。
 * 运行在 renderer；持有系统配色与减少动态媒体查询监听，在组件卸载时移除。
 */
import { ConfigProvider, theme, type ThemeConfig } from 'antd'
import zhCN from 'antd/es/locale/zh_CN.js'
import { useEffect, useMemo, useState, type ReactNode } from 'react'

import { DESKTOP_FONT_SIZE_RANGE, DESKTOP_ISLAND_GAP_RANGE } from '../../../../shared/appearance.ts'
import { useWorkspaceSnapshot } from '../../hooks/useWorkspace.ts'
import type { DesktopFontFamily, DesktopSettings } from '../../platform/contracts.ts'

/** 固定默认画布不透明度（对应 32% 默认透明度），不再受旧版自定义滑块配置影响。 */
const FIXED_CANVAS_ALPHA = '0.68'

/** 固定默认内容区可读性遮罩不透明度，与 tokens.css 默认基线保持一致。 */
const FIXED_SCRIM_ALPHA = '0.84'

/** 固定官方浮岛间隙像素值，避免旧配置中的异常间隙导致布局失真。 */
const FIXED_ISLAND_GAP = `${String(DESKTOP_ISLAND_GAP_RANGE.default)}px`

/** 界面字体预设的展示文案与 CSS 字体族定义。 */
export interface FontPreset {
  readonly label: string
  readonly detail: string
  readonly cssValue: string
}

/** 内置可选界面字体预设表。 */
export const FONT_PRESETS: Readonly<Record<DesktopFontFamily, FontPreset>> = {
  system: {
    label: '系统字体',
    detail: '匹配系统原生界面',
    cssValue:
      '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", sans-serif',
  },
  humanist: {
    label: '人文无衬线',
    detail: '更适合长文本阅读',
    cssValue: '"Avenir Next", Avenir, "Segoe UI", "PingFang SC", sans-serif',
  },
  monospace: {
    label: '等宽字体',
    detail: '保持统一的编程节奏',
    cssValue:
      'ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, "PingFang SC", "Microsoft YaHei", monospace',
  },
}

/** 主题色快捷色板预设列表。 */
export const ACCENT_PRESETS = [
  { label: '深海蓝', value: '#4d6bfe' },
  { label: '湖蓝', value: '#2d8dbd' },
  { label: '松绿', value: '#2f9d77' },
  { label: '暖橙', value: '#d97745' },
  { label: '莓红', value: '#c45a84' },
  { label: '紫藤', value: '#8069d4' },
] as const

function fontSizeVariables(fontSize: number): Readonly<Record<string, number>> {
  return {
    '--text-caption': Math.max(11, fontSize - 3),
    '--text-meta': Math.max(12, fontSize - 2),
    '--text-control': Math.max(12, fontSize - 1),
    '--text-body': fontSize,
    '--text-title': fontSize + 1,
    '--text-brand': fontSize + 2,
  }
}

function linearChannel(value: number): number {
  const normalized = value / 255
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
}

function relativeLuminance(color: string): number {
  const red = Number.parseInt(color.slice(1, 3), 16)
  const green = Number.parseInt(color.slice(3, 5), 16)
  const blue = Number.parseInt(color.slice(5, 7), 16)
  return 0.2126 * linearChannel(red) + 0.7152 * linearChannel(green) + 0.722 * linearChannel(blue)
}

function contrastRatio(first: string, second: string): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second))
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second))
  return (lighter + 0.05) / (darker + 0.05)
}

/** 根据主题色亮度返回对比度更高的纯白或纯黑前景色，用于高对比度按钮与选中标记。 */
export function accentContrastColor(accentColor: string): '#ffffff' | '#000000' {
  const light = '#ffffff'
  const dark = '#000000'
  return contrastRatio(accentColor, light) >= contrastRatio(accentColor, dark) ? light : dark
}

/**
 * 将桌面外观设置写入目标根节点的数据属性与 CSS 变量。
 * 历史版本中已移除的画布配色、透明度、遮罩、浮岛间隙与背景图片字段会兼容接收但固定投影为官方默认值。
 */
export function applyAppearance(
  settings: DesktopSettings | null,
  root: HTMLElement = document.documentElement,
): void {
  if (settings === null) return
  root.dataset.colorScheme = settings.colorScheme
  root.dataset.canvasColorScheme = 'follow-interface'
  root.style.colorScheme = settings.colorScheme === 'system' ? 'dark light' : settings.colorScheme
  root.style.setProperty('--accent', settings.accentColor)
  root.style.setProperty('--accent-contrast', accentContrastColor(settings.accentColor))
  // 已下线的背景透明度、画布配色、遮罩与浮岛间隙固定采用官方基线，防止旧配置残留影响可读性。
  root.style.setProperty('--canvas-alpha', FIXED_CANVAS_ALPHA)
  root.style.setProperty('--canvas-layer-bg', 'var(--canvas-bg)')
  root.style.setProperty('--scrim-alpha', FIXED_SCRIM_ALPHA)
  root.style.setProperty('--font-ui', FONT_PRESETS[settings.fontFamily].cssValue)
  // 代码排版由内置样式统一决定；兼容读取的旧设置不再覆盖代码区域。
  root.style.removeProperty('--code-editor-font-size')
  root.style.removeProperty('--code-editor-line-height')
  root.style.removeProperty('--code-editor-font-ligatures')
  root.style.setProperty('--window-gap', FIXED_ISLAND_GAP)
  root.style.setProperty('--window-edge', FIXED_ISLAND_GAP)
  for (const [name, value] of Object.entries(fontSizeVariables(settings.fontSize))) {
    root.style.setProperty(name, `${String(value)}px`)
  }
  for (const layer of ['canvas', 'sidebar', 'content'] as const) {
    root.style.setProperty(`--${layer}-image`, 'none')
  }
}

/** 外观主题提供者：用唯一一份设置同时驱动工作台 CSS 变量与 Ant Design 弹层主题。 */
export function AppearanceSystem({ children }: { children: ReactNode }) {
  const settings = useWorkspaceSnapshot().settings
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  )
  // 首帧禁用动效，使 Ant Design 从首次挂载就保留 MotionProvider；偏好变化不再重建终端等工作区。
  const [reducedMotion, setReducedMotion] = useState(true)

  useEffect(() => {
    const dark = window.matchMedia('(prefers-color-scheme: dark)')
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => {
      setSystemDark(dark.matches)
      setReducedMotion(motion.matches)
    }
    update()
    dark.addEventListener('change', update)
    motion.addEventListener('change', update)
    return () => {
      dark.removeEventListener('change', update)
      motion.removeEventListener('change', update)
    }
  }, [])
  useEffect(() => {
    applyAppearance(settings)
  }, [settings])

  const antTheme = useMemo<ThemeConfig>(() => {
    const dark =
      settings?.colorScheme === 'dark' ||
      ((settings?.colorScheme ?? 'system') === 'system' && systemDark)
    const accentColor = settings?.accentColor ?? ACCENT_PRESETS[0].value
    const baseFontSize = settings?.fontSize ?? DESKTOP_FONT_SIZE_RANGE.default
    const smallFontSize = Math.max(11, baseFontSize - 1)
    return {
      algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
      token: {
        colorPrimary: accentColor,
        fontFamily: FONT_PRESETS[settings?.fontFamily ?? 'system'].cssValue,
        fontSize: baseFontSize,
        controlHeight: 34,
        borderRadius: 8,
        motion: !reducedMotion,
      },
      components: {
        Button: {
          borderRadius: 10,
          borderRadiusSM: 8,
          borderRadiusLG: 11,
          controlHeight: 32,
          controlHeightSM: 26,
          controlHeightLG: 36,
          paddingInline: 12,
          paddingInlineSM: 10,
          paddingInlineLG: 16,
          fontWeight: 500,
          iconGap: 6,
          contentFontSize: baseFontSize,
          contentFontSizeSM: smallFontSize,
          contentFontSizeLG: baseFontSize + 1,
          primaryColor: accentContrastColor(accentColor),
          defaultShadow: 'none',
          primaryShadow: 'none',
          dangerShadow: 'none',
        },
      },
    }
  }, [settings, systemDark, reducedMotion])

  return (
    <ConfigProvider locale={zhCN} theme={antTheme} button={{ autoInsertSpace: false }}>
      {children}
    </ConfigProvider>
  )
}
