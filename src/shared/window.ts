export const DESKTOP_WINDOW_CHANNELS = Object.freeze({
  read: 'dsh-desktop:window:read',
  act: 'dsh-desktop:window:act',
  changed: 'dsh-desktop:window:changed',
})

export type DesktopWindowAction = 'minimize' | 'toggle-maximize' | 'close'
export type DesktopCanvasComposition = 'transparent' | 'acrylic' | 'opaque'

/** Windows 原生窗口外角；macOS 使用此值近似计算浮岛曲率，由系统负责裁切。 */
export const DESKTOP_WINDOW_CORNER_RADIUS = 18

export interface DesktopCanvasClip {
  width: number
  height: number
  radius: number
}

export interface DesktopWindowState {
  platform: string
  maximized: boolean
  maximizable: boolean
  minimizable: boolean
  canvasComposition: DesktopCanvasComposition
  cornerRadius: number
  canvasClip?: DesktopCanvasClip | undefined
}

/** 原生像素是可见边界；Electron 的 DIP 视口在分数缩放时可能向上取整。 */
export function windowClipStyle(
  state: DesktopWindowState,
  viewport: { width: number; height: number; scale: number },
) {
  const clip = state.canvasComposition === 'acrylic' ? state.canvasClip : undefined
  const scale = viewport.scale > 0 ? viewport.scale : 1
  return {
    radius:
      clip === undefined
        ? state.canvasComposition === 'acrylic'
          ? state.cornerRadius
          : 0
        : clip.radius / scale,
    right: clip === undefined ? 0 : Math.max(0, viewport.width - clip.width / scale),
    bottom: clip === undefined ? 0 : Math.max(0, viewport.height - clip.height / scale),
  }
}
