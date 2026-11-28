/**
 * 主进程原生应用菜单与版本更新检查控制器。
 *
 * 构建 macOS / Windows 应用菜单，将标签页快捷键转发给当前窗口，并管理可取消的
 * GitHub Release 更新查询；应用退出时由 `dispose()` 中止在途网络请求。
 */

import {
  app,
  dialog,
  Menu,
  shell,
  type BrowserWindow,
  type MenuItem,
  type MenuItemConstructorOptions,
} from 'electron'
import { checkForProjectUpdate } from './updates/github-updates.ts'

/** 安装原生应用菜单的输入参数。 */
export interface ApplicationMenuInstallOptions {
  readonly window: BrowserWindow
  readonly isQuitting: () => boolean
  readonly isVerifyMode: boolean
  readonly onOpenSettings: () => void
}

/** 已安装的应用菜单句柄与生命周期释放方法。 */
export interface InstalledApplicationMenu {
  readonly applicationMenu: Menu
  readonly appearanceMenuItem: MenuItem
  readonly updateMenuItem: MenuItem
  dispose(): void
}

async function promptForUpdateAction(
  window: BrowserWindow,
  signal: AbortSignal,
  isVerifyMode: boolean,
): Promise<void> {
  if (isVerifyMode) throw new Error('验收模式不会连接公开更新服务。')
  const update = await checkForProjectUpdate({
    currentVersion: app.getVersion(),
    signal,
  })
  if (signal.aborted || window.isDestroyed()) return
  if (update === undefined) {
    await dialog.showMessageBox(window, {
      type: 'info',
      title: 'MyDSH 更新',
      message: '已经是最新版本',
      detail: `当前版本为 ${app.getVersion()}。`,
      buttons: ['好'],
    })
    return
  }
  const installGuide =
    process.platform === 'win32'
      ? '下载完成后，运行安装程序即可直接覆盖安装更新（会保留已有数据与配置）。'
      : '下载完成后，请退出 MyDSH，打开安装包并将 MyDSH 拖入 Applications，替换旧版本。'
  const notesSuffix = update.releaseNotes === '' ? '' : `\n\n${update.releaseNotes}`
  const result = await dialog.showMessageBox(window, {
    type: 'info',
    title: 'MyDSH 更新',
    message: `发现新版本 ${update.version}`,
    detail: `当前版本为 ${app.getVersion()}。\n${installGuide}${notesSuffix}`,
    buttons: ['下载新版本', '稍后'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  if (result.response === 0 && !signal.aborted && !window.isDestroyed()) {
    await shell.openExternal(update.downloadUrl)
  }
}

function sendWorkspaceTabAction(window: BrowserWindow, action: 'close' | 'overview'): void {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return
  window.webContents.send('mydsh:workspace:tab-action', { action })
}

function buildMacMenuTemplate(
  window: BrowserWindow,
  settingsAccelerator: string,
  onCheckForUpdates: () => void,
  onOpenSettings: () => void,
): MenuItemConstructorOptions[] {
  return [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          id: 'check-for-updates',
          label: '检查更新…',
          click: onCheckForUpdates,
        },
        {
          id: 'desktop-appearance',
          label: '设置…',
          accelerator: settingsAccelerator,
          enabled: false,
          click: onOpenSettings,
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    // 标签快捷键统一路由到 renderer 的焦点窗格，窗口关闭继续走原生命周期。
    {
      label: '文件',
      submenu: [
        {
          label: '关闭当前标签',
          accelerator: 'CommandOrControl+W',
          click: () => sendWorkspaceTabAction(window, 'close'),
        },
        {
          label: '平铺选择标签',
          accelerator: 'CommandOrControl+S',
          click: () => sendWorkspaceTabAction(window, 'overview'),
        },
        { role: 'close', label: '关闭窗口', accelerator: 'CommandOrControl+Shift+W' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]
}

function buildWindowsMenuTemplate(
  window: BrowserWindow,
  settingsAccelerator: string,
  onCheckForUpdates: () => void,
  onOpenSettings: () => void,
): MenuItemConstructorOptions[] {
  return [
    {
      label: '文件',
      submenu: [
        {
          label: '关闭当前标签',
          accelerator: 'CommandOrControl+W',
          click: () => sendWorkspaceTabAction(window, 'close'),
        },
        {
          label: '平铺选择标签',
          accelerator: 'CommandOrControl+S',
          click: () => sendWorkspaceTabAction(window, 'overview'),
        },
        {
          id: 'check-for-updates',
          label: '检查更新…',
          click: onCheckForUpdates,
        },
        { type: 'separator' },
        {
          id: 'desktop-appearance',
          label: '设置…',
          accelerator: settingsAccelerator,
          enabled: false,
          click: onOpenSettings,
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]
}

/** 构建并挂载桌面应用菜单。 */
export function installApplicationMenu(
  options: ApplicationMenuInstallOptions,
): InstalledApplicationMenu {
  const { window, isQuitting, isVerifyMode, onOpenSettings } = options
  let updateCheckController: AbortController | undefined
  let updateMenuItem: MenuItem | null = null

  const requestUpdateCheck = (): void => {
    if (
      updateCheckController !== undefined ||
      isQuitting() ||
      window.isDestroyed() ||
      updateMenuItem === null
    ) {
      return
    }
    const controller = new AbortController()
    const item = updateMenuItem
    updateCheckController = controller
    item.label = '正在检查更新…'
    item.enabled = false
    void (async () => {
      try {
        await promptForUpdateAction(window, controller.signal, isVerifyMode)
      } catch (error) {
        if (controller.signal.aborted || window.isDestroyed()) return
        await dialog.showMessageBox(window, {
          type: 'warning',
          title: 'MyDSH 更新',
          message: '暂时无法检查或下载更新',
          detail: error instanceof Error ? error.message : '请稍后重试。',
          buttons: ['好'],
        })
      } finally {
        updateCheckController = undefined
        item.label = '检查更新…'
        item.enabled = true
      }
    })().catch((error: unknown) => {
      console.warn('显示 MyDSH 更新提示失败：', error)
    })
  }

  const settingsAccelerator = process.platform === 'darwin' ? 'Command+,' : 'Ctrl+,'
  const template =
    process.platform === 'darwin'
      ? buildMacMenuTemplate(window, settingsAccelerator, requestUpdateCheck, onOpenSettings)
      : buildWindowsMenuTemplate(window, settingsAccelerator, requestUpdateCheck, onOpenSettings)
  const applicationMenu = Menu.buildFromTemplate(template)
  const appearanceMenuItem = applicationMenu.getMenuItemById('desktop-appearance')
  updateMenuItem = applicationMenu.getMenuItemById('check-for-updates')
  if (appearanceMenuItem === null) throw new Error('无法创建设置菜单')
  if (updateMenuItem === null) throw new Error('无法创建检查更新菜单')
  Menu.setApplicationMenu(applicationMenu)

  return {
    applicationMenu,
    appearanceMenuItem,
    updateMenuItem,
    dispose() {
      updateCheckController?.abort()
    },
  }
}
