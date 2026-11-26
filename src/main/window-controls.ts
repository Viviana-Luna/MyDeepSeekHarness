/**
 * macOS 原生窗口按钮（红绿灯）与目录 sheet 的主进程适配层。
 * 原生实现位于 native/window-controls.m，只在 macOS 加载；其他平台上这里的函数都不做任何事。
 * 紧凑布局的观察者挂在窗口对象上，随窗口销毁一起释放，调用方不需要额外清理。
 */
import { createRequire } from 'node:module'
import type { BrowserWindow, Rectangle } from 'electron'
import { DESKTOP_ISLAND_GAP_RANGE } from '../shared/appearance.ts'

interface NativeWindowControls {
  compact: (handle: Buffer, x?: number, y?: number) => void
  readLayout: (handle: Buffer) => Rectangle[]
  cancelDirectorySheet: (handle: Buffer) => void
  cancelFileSheet: (handle: Buffer) => void
}

/** 顶行标签栏与左栏项目头部共用的高度（DIP），与 tokens.css 中的 `--session-chrome-height` 一致。 */
const TOP_CHROME_HEIGHT = 32

/** 红绿灯左边缘相对浮岛左边界的最小水平内缩（DIP）。 */
const TRAFFIC_LIGHT_INSET_X = 8

/**
 * 默认浮岛间隙下红绿灯左边缘到窗口左边缘的距离（DIP）。
 * 展开态左栏顶行（`padding-left: 76px`）与收起态标签栏（`padding-left: 80px`）均按此安全区避让。
 */
export const TRAFFIC_LIGHT_LEFT = DESKTOP_ISLAND_GAP_RANGE.default + TRAFFIC_LIGHT_INSET_X

/**
 * 三个原生红绿灯按钮之间的标准间距（DIP），与 native/window-controls.m 中的 `kTrafficLightGap` 一致。
 */
export const TRAFFIC_LIGHT_GAP = 8

/**
 * 默认浮岛间隙（8px）下红绿灯纵向中心到窗口顶边的距离（DIP），
 * 与 32px 顶行中轴线对齐：窗口边距 8px + 顶行高度 32px 的一半 = 24px。
 * 展开态左栏项目行与收起态顶部标签栏共用这条中轴线，切换侧栏显隐时按钮无需上下跳动。
 */
export const TRAFFIC_LIGHT_CENTER_Y = DESKTOP_ISLAND_GAP_RANGE.default + TOP_CHROME_HEIGHT / 2

/**
 * 创建窗口时使用的初始按钮顶边位置，按旧版 macOS 的 12px 按钮换算。
 * 窗口创建后由 installTrafficLights 按实际按钮高度与当前浮岛间隙重新定位。
 */
export const INITIAL_TRAFFIC_LIGHT_POSITION = Object.freeze({
  x: TRAFFIC_LIGHT_LEFT,
  y: TRAFFIC_LIGHT_CENTER_Y - 6,
})

const native: NativeWindowControls | undefined =
  process.platform === 'darwin'
    ? (createRequire(import.meta.url)('./window-controls.node') as NativeWindowControls)
    : undefined

/**
 * 根据当前浮岛间隙计算红绿灯的左边距和纵向中心（DIP）。
 * 浮岛间隙收窄至 5..8px 时左边缘保持在 16px，避免紧贴窗口圆角；增大间隙时随浮岛内移。
 */
export function resolveTrafficLightMetrics(islandGap: number): { left: number; centerY: number } {
  const raw = Number.isFinite(islandGap) ? islandGap : DESKTOP_ISLAND_GAP_RANGE.default
  const gap = Math.min(
    DESKTOP_ISLAND_GAP_RANGE.maximum,
    Math.max(DESKTOP_ISLAND_GAP_RANGE.minimum, raw),
  )
  return {
    left: Math.max(TRAFFIC_LIGHT_LEFT, Math.round(gap + TRAFFIC_LIGHT_INSET_X)),
    centerY: Math.round(gap + TOP_CHROME_HEIGHT / 2),
  }
}

/**
 * 读取三个红绿灯按钮在窗口坐标中的实际位置和尺寸，顺序为关闭、最小化、缩放。
 * 坐标原点在窗口左上角，单位为 DIP；非 macOS、窗口已销毁或按钮未挂载时返回空数组。
 */
export function readTrafficLightLayout(win: BrowserWindow): Rectangle[] {
  if (native === undefined || win.isDestroyed()) return []
  return native.readLayout(win.getNativeWindowHandle())
}

/**
 * 按实际按钮高度和当前浮岛间隙同步红绿灯锚点，使三个按钮以 8px 间距居中对齐 32px 顶行。
 * 先更新原生观察者锚点再同步 Electron 窗口按钮位置，避免旧观察者回调把按钮拉回历史坐标。
 */
export function syncTrafficLights(
  win: BrowserWindow,
  islandGap: number = DESKTOP_ISLAND_GAP_RANGE.default,
): void {
  if (native === undefined || win.isDestroyed()) return
  const height = readTrafficLightLayout(win)[0]?.height
  if (height === undefined || height <= 0) return
  const handle = win.getNativeWindowHandle()
  const { left, centerY } = resolveTrafficLightMetrics(islandGap)
  const top = Math.round(centerY - height / 2)
  native.compact(handle, left, top)
  win.setWindowButtonPosition({ x: left, y: top })
}

/**
 * 工作台装载完成后首次定位红绿灯并挂载原生布局观察者。
 * 后续若用户在外观设置中调整浮岛间隙，由 syncTrafficLights 实时更新同一观察者的锚点。
 */
export function installTrafficLights(
  win: BrowserWindow,
  islandGap: number = DESKTOP_ISLAND_GAP_RANGE.default,
): void {
  syncTrafficLights(win, islandGap)
}

/** 仅取消指定窗口正在显示的目录 sheet，不操作其他窗口或文件选择器。 */
export function cancelDirectorySheet(win: BrowserWindow): void {
  if (native === undefined || win.isDestroyed()) return
  native.cancelDirectorySheet(win.getNativeWindowHandle())
}

/** 仅取消指定窗口正在显示的纯文件选择 sheet，用于中止私钥导入或 SQLite 文件选择。 */
export function cancelFileSheet(win: BrowserWindow): void {
  if (native === undefined || win.isDestroyed()) return
  native.cancelFileSheet(win.getNativeWindowHandle())
}
