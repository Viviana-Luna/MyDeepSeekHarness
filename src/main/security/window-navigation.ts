/**
 * 主窗口导航安全守卫、WebContents 权限收口与开发态热刷新监听器。
 *
 * 阻止任意渲染器内页面跳转、新开窗口与 `<webview>` 挂载，将合法无凭据外部链接转交系统浏览器；
 * 拥有会话权限处理器与开发态文件监听器，退出或关窗时按生命周期分别释放。
 */

import { watch, type FSWatcher } from 'node:fs'
import { dirname } from 'node:path'
import { app, shell, type BrowserWindow } from 'electron'
import { installHostPermissionHandlers } from './host-permissions.ts'

/** 校验并提取不含内嵌用户名密码的外部 `http:` / `https:` 链接。 */
export function externalWebUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol)) return undefined
    if (url.username !== '' || url.password !== '') return undefined
    return url.href
  } catch {
    return undefined
  }
}

/** 安装主窗口导航与权限守卫的输入依赖。 */
export interface WindowNavigationOptions {
  readonly window: BrowserWindow
  readonly targetUrl: URL
  readonly rendererPath: string
  readonly isVerifyMode: boolean
  readonly isQuitting: () => boolean
  readonly isWorkspaceOpened: () => boolean
  readonly isDocumentEdited: () => boolean
  readonly isTrustedRendererPage: (url: string) => boolean
  readonly onDidNavigate: () => void
  readonly onFatalLoadFailure: () => void
}

/** 已安装的导航安全守卫与开发态热刷新句柄。 */
export interface WindowNavigationGuards {
  startDevReloadWatcherIfEnabled(): void
  disposeWatcher(): void
  disposePermissions(): void
}

function createDevReloadWatcher(options: WindowNavigationOptions): {
  startIfEnabled(): void
  dispose(): void
} {
  const {
    window,
    rendererPath,
    isVerifyMode,
    isQuitting,
    isDocumentEdited,
    isTrustedRendererPage,
  } = options
  let watcher: FSWatcher | undefined
  let timer: NodeJS.Timeout | undefined

  return {
    startIfEnabled() {
      if (
        watcher !== undefined ||
        process.env.MYDSH_DEV_WATCH !== '1' ||
        app.isPackaged ||
        isVerifyMode
      ) {
        return
      }
      try {
        watcher = watch(dirname(rendererPath), (_eventType, filename) => {
          if (filename !== null && filename !== 'index.html') return
          if (timer !== undefined) clearTimeout(timer)
          timer = setTimeout(() => {
            timer = undefined
            if (isQuitting() || window.isDestroyed() || isDocumentEdited()) return
            if (isTrustedRendererPage(window.webContents.getURL())) {
              console.info('检测到本地 renderer 产物更新，正在刷新工作台…')
              window.webContents.reloadIgnoringCache()
            }
          }, 250)
        })
      } catch (error) {
        console.warn('启动开发态本地页面监听失败：', error)
      }
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      watcher?.close()
      watcher = undefined
    },
  }
}

/** 为主窗口绑定导航拦截、权限策略、崩溃兜底与可选的开发态刷新监听。 */
export function installWindowNavigationGuards(
  options: WindowNavigationOptions,
): WindowNavigationGuards {
  const { window, targetUrl, isQuitting, isWorkspaceOpened, onDidNavigate, onFatalLoadFailure } =
    options
  const devWatcher = createDevReloadWatcher(options)

  window.webContents.setWindowOpenHandler(({ url }) => {
    const external = externalWebUrl(url)
    if (external !== undefined) void shell.openExternal(external)
    return { action: 'deny' }
  })

  // 导航尝试可能被取消；只有主文档真正切换后才释放旧页面的订阅。
  window.webContents.on('did-navigate', () => {
    onDidNavigate()
  })

  window.webContents.on('will-navigate', (event, url) => {
    // 启动页与工作台仅由主进程 loadFile 切换；用户回退不能重新进入启动页。
    // Electron 的主进程加载不触发此事件，外部链接仍交给系统浏览器。
    event.preventDefault()
    const external = externalWebUrl(url)
    if (external !== undefined) void shell.openExternal(external)
  })

  window.webContents.on('will-attach-webview', event => {
    event.preventDefault()
  })

  const disposeHostPermissions = installHostPermissionHandlers(
    window.webContents.session,
    window.webContents,
    targetUrl,
  )

  window.webContents.on('did-fail-load', (...args: [unknown, number, string, string, boolean]) => {
    const [, errorCode, errorDescription, , isMainFrame] = args
    if (errorCode === -3 || !isMainFrame || isQuitting()) return
    console.error('MyDSH 页面加载失败：', errorDescription)
    onFatalLoadFailure()
  })

  window.webContents.on('render-process-gone', () => {
    if (!isWorkspaceOpened() && !isQuitting()) onFatalLoadFailure()
  })

  return {
    startDevReloadWatcherIfEnabled: () => devWatcher.startIfEnabled(),
    disposeWatcher: () => devWatcher.dispose(),
    disposePermissions: () => disposeHostPermissions(),
  }
}
