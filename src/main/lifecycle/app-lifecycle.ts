/**
 * 主窗口唤醒生命周期辅助：运行在 Electron 主进程，负责在二次启动或工作台首次就绪时恢复并聚焦主窗口。
 * 不持有系统资源。
 */

/** 支持恢复、显示与聚焦操作的主窗口最小契约。 */
export interface PrimaryWindow {
  isDestroyed(): boolean
  isMinimized(): boolean
  isVisible(): boolean
  restore(): void
  show(): void
  focus(): void
}

/**
 * 唤醒并聚焦当前主窗口；若窗口尚未创建或已销毁则返回 false，供调用方记录待处理唤醒标记。
 */
export function focusPrimaryWindow(window: PrimaryWindow | undefined): boolean {
  if (window === undefined || window.isDestroyed()) return false
  if (window.isMinimized()) window.restore()
  if (!window.isVisible()) window.show()
  window.focus()
  return true
}
