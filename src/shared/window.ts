/**
 * 桌面窗口状态、背景合成模式与圆角几何共享契约。
 * 供主进程窗口控制器、preload 与 renderer 状态栏共享，保持平台与框架无关。
 */

/** 桌面窗口控制与状态广播 IPC 通道定义。 */
export const DESKTOP_WINDOW_CHANNELS = Object.freeze({
  read: 'dsh-desktop:window:read',
  act: 'dsh-desktop:window:act',
  changed: 'dsh-desktop:window:changed',
})

/** 允许本地受信任 renderer 请求的窗口控制动作。 */
export type DesktopWindowAction = 'minimize' | 'toggle-maximize' | 'close'

/** 窗口画布底层的系统合成材质类别。 */
export type DesktopCanvasComposition = 'transparent' | 'mica' | 'acrylic' | 'opaque'

/** macOS 窗口外角近似半径（DIP），工作台据此推导内部浮岛 10px 圆角曲率。 */
export const DESKTOP_WINDOW_CORNER_RADIUS = 18

/** Windows 11 原生 DWM `DWMWCP_ROUND` 硬件圆角标准半径（DIP）。 */
export const WINDOWS_NATIVE_CORNER_RADIUS = 8

/** 旧式自绘裁剪的原生像素矩形描述（原生 DWM 圆角与 Mica 模式下为空）。 */
export interface DesktopCanvasClip {
  width: number
  height: number
  radius: number
}

/** 主进程向受信任本地页面同步的窗口状态快照。 */
export interface DesktopWindowState {
  platform: string
  maximized: boolean
  maximizable: boolean
  minimizable: boolean
  canvasComposition: DesktopCanvasComposition
  cornerRadius: number
  canvasClip?: DesktopCanvasClip | undefined
}

/**
 * 计算前端根文档所需的附加裁剪样式。
 * Windows 11 原生 DWM 圆角与 macOS 系统窗口均由操作系统合成器硬件裁切，返回零裁剪以避免整页离屏 RenderPass。
 */
export function windowClipStyle(
  state: DesktopWindowState,
  viewport: { width: number; height: number; scale: number },
): { radius: number; right: number; bottom: number } {
  if (state.canvasComposition !== 'acrylic') {
    return { radius: 0, right: 0, bottom: 0 }
  }
  const clip = state.canvasClip
  if (clip === undefined) {
    return { radius: state.cornerRadius, right: 0, bottom: 0 }
  }
  const scale = viewport.scale > 0 ? viewport.scale : 1
  return {
    radius: clip.radius / scale,
    right: Math.max(0, viewport.width - clip.width / scale),
    bottom: Math.max(0, viewport.height - clip.height / scale),
  }
}
