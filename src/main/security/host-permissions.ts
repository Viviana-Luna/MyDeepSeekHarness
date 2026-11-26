import type { Session, WebContents } from 'electron'

const HOST_CLIPBOARD_WRITE_PERMISSION = 'clipboard-sanitized-write'

export interface HostPermissionRequest {
  permission: string
  requestingUrl: string | undefined
  currentPageUrl: string | undefined
  isMainFrame: boolean
  trustedWebContents: boolean
}

function matchesTargetOrigin(raw: string | undefined, targetUrl: URL): boolean {
  if (raw === undefined) return false
  try {
    const candidate = new URL(raw)
    return (
      candidate.origin === targetUrl.origin &&
      candidate.username === '' &&
      candidate.password === ''
    )
  } catch {
    return false
  }
}

export function isAllowedHostPermission(request: HostPermissionRequest, targetUrl: URL): boolean {
  return (
    request.permission === HOST_CLIPBOARD_WRITE_PERMISSION &&
    request.trustedWebContents &&
    request.isMainFrame &&
    matchesTargetOrigin(request.requestingUrl, targetUrl) &&
    matchesTargetOrigin(request.currentPageUrl, targetUrl)
  )
}

function currentPageUrl(webContents: WebContents): string | undefined {
  if (webContents.isDestroyed()) return undefined
  try {
    return webContents.getURL()
  } catch {
    return undefined
  }
}

/**
 * 为当前桌面窗口安装最小系统权限白名单，并返回对应的清理函数。
 * 除已确认顶层页面的纯文本剪贴板写入外，其他权限继续全部拒绝。
 */
export function installHostPermissionHandlers(
  session: Session,
  trustedWebContents: WebContents,
  targetUrl: URL,
): () => void {
  session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    return isAllowedHostPermission(
      {
        permission,
        requestingUrl: details.requestingUrl ?? requestingOrigin,
        currentPageUrl: currentPageUrl(trustedWebContents),
        isMainFrame: details.isMainFrame,
        trustedWebContents: webContents === trustedWebContents,
      },
      targetUrl,
    )
  })
  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(
      isAllowedHostPermission(
        {
          permission,
          requestingUrl: details.requestingUrl,
          currentPageUrl: currentPageUrl(trustedWebContents),
          isMainFrame: details.isMainFrame,
          trustedWebContents: webContents === trustedWebContents,
        },
        targetUrl,
      ),
    )
  })

  return () => {
    session.setPermissionCheckHandler(null)
    session.setPermissionRequestHandler(null)
  }
}
