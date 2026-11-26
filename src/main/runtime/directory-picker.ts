import { dialog, type BrowserWindow } from 'electron'
import { cancelDirectorySheet } from '../window-controls.ts'

/**
 * 只打开当前 MyDSH 窗口的目录选择器，不允许 Runtime 指定系统对话框参数。
 * 用户取消返回 null；请求取消拒绝且关闭 sheet，迟到的选中结果不能创建项目。
 */
export async function pickWorkspaceDirectory(
  win: BrowserWindow | undefined,
  signal: AbortSignal,
): Promise<string | null> {
  signal.throwIfAborted()
  if (!win || win.isDestroyed()) throw new Error('MyDSH 窗口已经关闭，无法选择项目目录')
  const abort = (): void => {
    if (!win.isDestroyed()) cancelDirectorySheet(win)
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    // Electron 的 OpenDialog 没有 AbortSignal 参数；macOS sheet 由原生窗口桥关闭。
    const result = await dialog.showOpenDialog(win, {
      title: '选择项目目录',
      buttonLabel: '选择项目',
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
    })
    signal.throwIfAborted()
    return result.canceled ? null : (result.filePaths[0] ?? null)
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
