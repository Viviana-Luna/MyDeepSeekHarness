/**
 * 主进程未保存文档编辑态与窗口关闭确认协调器。
 *
 * 跟踪 renderer 上报的未保存文件状态，在用户点击关闭按钮或触发应用退出时拦截并请求
 * renderer 确认；应用销毁时由 `dispose()` 注销生命周期 IPC 处理器。
 */

import { ipcMain, type BrowserWindow, type Event, type IpcMainInvokeEvent } from 'electron'

/** 窗口关闭保护 IPC 通道名。 */
export const LIFECYCLE_CHANNELS = Object.freeze({
  documentEdited: 'dsh-desktop:lifecycle:document-edited',
  closeRequested: 'dsh-desktop:lifecycle:close-requested',
  closeDecision: 'dsh-desktop:lifecycle:close-decision',
})

/** 安装窗口关闭保护协调器的输入依赖。 */
export interface WindowCloseGuardOptions {
  readonly window: BrowserWindow
  readonly assertSender: (event: IpcMainInvokeEvent) => void
  readonly isTrustedRendererPage: (url: string) => boolean
  readonly isQuitting: () => boolean
  readonly onDocumentEditedChanged: () => Promise<void>
  readonly onConfirmQuit: () => void
}

/** 已安装的窗口关闭保护协调器实例。 */
export interface WindowCloseGuard {
  isDocumentEdited(): boolean
  handleBeforeQuit(event: Event): boolean
  dispose(): void
}

/** 安装窗口未保存更改拦截与关闭确认握手。 */
export function installWindowCloseGuard(options: WindowCloseGuardOptions): WindowCloseGuard {
  const {
    window,
    assertSender,
    isTrustedRendererPage,
    isQuitting,
    onDocumentEditedChanged,
    onConfirmQuit,
  } = options

  let rendererDocumentEdited = false
  let closeRequestOutstanding = false
  let pendingQuit = false
  let allowWindowClose = false

  const requestRendererCloseDecision = (): void => {
    if (closeRequestOutstanding || window.isDestroyed() || window.webContents.isDestroyed()) return
    if (!isTrustedRendererPage(window.webContents.getURL())) {
      rendererDocumentEdited = false
      return
    }
    closeRequestOutstanding = true
    window.webContents.send(LIFECYCLE_CHANNELS.closeRequested)
  }

  ipcMain.handle(LIFECYCLE_CHANNELS.documentEdited, async (event, edited: unknown) => {
    assertSender(event)
    if (typeof edited !== 'boolean') throw new Error('文档编辑状态无效')
    rendererDocumentEdited = edited
    await onDocumentEditedChanged()
  })

  ipcMain.handle(LIFECYCLE_CHANNELS.closeDecision, (event, decision: unknown) => {
    assertSender(event)
    if (decision !== 'proceed' && decision !== 'cancel') throw new Error('关闭窗口决定无效')
    if (!closeRequestOutstanding) return
    closeRequestOutstanding = false
    if (decision === 'cancel') {
      pendingQuit = false
      return
    }
    rendererDocumentEdited = false
    if (pendingQuit) {
      pendingQuit = false
      onConfirmQuit()
      return
    }
    allowWindowClose = true
    window.close()
  })

  window.on('close', event => {
    if (isQuitting() || allowWindowClose || window.webContents.isDestroyed()) return
    if (!rendererDocumentEdited) return
    event.preventDefault()
    requestRendererCloseDecision()
  })

  return {
    isDocumentEdited: () => rendererDocumentEdited,
    handleBeforeQuit(event: Event): boolean {
      if (isQuitting()) {
        event.preventDefault()
        return true
      }
      if (rendererDocumentEdited) {
        event.preventDefault()
        pendingQuit = true
        requestRendererCloseDecision()
        return true
      }
      return false
    },
    dispose() {
      ipcMain.removeHandler(LIFECYCLE_CHANNELS.documentEdited)
      ipcMain.removeHandler(LIFECYCLE_CHANNELS.closeDecision)
    },
  }
}
