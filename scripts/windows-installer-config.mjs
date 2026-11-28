/**
 * Windows NSIS 安装包配置构造器：运行在 Windows 打包脚本与单元测试进程中。
 * 统一声明按用户安装、可选安装目录、跳过多用户模式页及保留用户数据等约束，
 * 不持有外部资源，也不执行打包或文件系统写入。
 */
import { join } from 'node:path'

/** 相对仓库根目录的自定义 NSIS 片段路径，用于固定当前用户安装并跳过安装模式选择页。 */
export const WINDOWS_INSTALLER_INCLUDE_FILE = 'scripts/windows-installer.nsh'

/**
 * 生成 Windows x64 按用户安装的 NSIS `electron-builder` 配置。
 * 启用向导式目录选择与覆盖升级支持，同时保持非管理员权限、不打包提权助手、
 * 完成页提供可选启动勾选框（静默安装不自启）且卸载保留 `~/.mydsh`。
 * @param {object} options 打包元数据。
 * @param {string} options.root 仓库根目录绝对路径。
 * @param {string} options.version `package.json` 中的应用语义化版本号。
 * @param {string} options.electronVersion 当前安装的 Electron 版本号。
 * @returns {object} 可直接传给 `electron-builder` 的 `config` 对象。
 */
export function createWindowsInstallerConfig({ root, version, electronVersion }) {
  return {
    appId: 'io.github.viviana-luna.mydsh',
    productName: 'MyDSH',
    directories: { output: 'out' },
    artifactName: `mydsh-Windows-x64-${version}.exe`,
    electronVersion,
    forceCodeSigning: false,
    win: {
      icon: join(root, 'out/MyDSH.ico'),
      signAndEditExecutable: false,
      signExecutable: false,
      executableName: 'MyDSH',
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      allowToChangeInstallationDirectory: true,
      packElevateHelper: false,
      deleteAppDataOnUninstall: false,
      runAfterFinish: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: 'MyDSH',
      installerLanguages: ['zh_CN', 'en_US'],
      include: join(root, WINDOWS_INSTALLER_INCLUDE_FILE),
    },
  }
}
