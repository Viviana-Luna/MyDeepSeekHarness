export interface PrimaryWindow {
  isDestroyed(): boolean
  isMinimized(): boolean
  isVisible(): boolean
  restore(): void
  show(): void
  focus(): void
}

export function focusPrimaryWindow(window: PrimaryWindow | undefined): boolean {
  if (window === undefined || window.isDestroyed()) return false
  if (window.isMinimized()) window.restore()
  if (!window.isVisible()) window.show()
  window.focus()
  return true
}
