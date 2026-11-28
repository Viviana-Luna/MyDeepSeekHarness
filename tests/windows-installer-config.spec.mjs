/**
 * Windows NSIS 安装包配置与覆盖更新单元测试：验证按用户向导安装、允许自定义安装目录、
 * 禁止提权、跨盘符覆盖清理、旧目录进程检测、权限清单校验以及 Windows 更新文案。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  WINDOWS_INSTALLER_INCLUDE_FILE,
  createWindowsInstallerConfig,
} from '../scripts/windows-installer-config.mjs'

const root = resolve(import.meta.dirname, '..')

describe('Windows NSIS 安装包配置与覆盖更新', () => {
  it('启用可选安装路径向导并保持当前用户无提权边界', () => {
    const config = createWindowsInstallerConfig({
      root,
      version: '0.1.0-preview.6',
      electronVersion: '43.0.0',
    })

    expect(config.appId).toBe('io.github.viviana-luna.mydsh')
    expect(config.productName).toBe('MyDSH')
    expect(config.artifactName).toBe('mydsh-Windows-x64-0.1.0-preview.6.exe')
    expect(config.forceCodeSigning).toBe(false)
    expect(config.win).toEqual({
      icon: join(root, 'out/MyDSH.ico'),
      signAndEditExecutable: false,
      signExecutable: false,
      executableName: 'MyDSH',
    })
    expect(config.nsis).toEqual({
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
    })
  })

  it('自定义 NSIS 脚本覆盖跳过模式页、旧目录进程检测与跨盘符覆盖清理', () => {
    const includePath = join(root, WINDOWS_INSTALLER_INCLUDE_FILE)
    expect(existsSync(includePath)).toBe(true)

    const nsh = readFileSync(includePath, 'utf8')
    expect(nsh).toContain('!macro customInstallMode')
    expect(nsh).toContain('StrCpy $isForceCurrentInstall "1"')
    expect(nsh).toContain('!macro customCheckAppRunning')
    expect(nsh).toContain('$PerUserInstallationFolder != $INSTDIR')
    expect(nsh).toContain('!macro customRemoveFiles')
    expect(nsh).toContain('StrCpy $R1 $INSTDIR 2')
    expect(nsh).toContain('StrCpy $R2 $PLUGINSDIR 2')
    expect(nsh).toContain('RMDir /r "$INSTDIR"')
  })

  it('打包入口保持 BCJ 过滤器，制品验收校验按用户执行清单，更新提示区分 Windows 文案', () => {
    const makeScript = readFileSync(join(root, 'scripts/make-windows.mjs'), 'utf8')
    expect(makeScript).toContain("process.env.ELECTRON_BUILDER_7Z_FILTER = 'BCJ'")
    expect(makeScript).toContain('createWindowsInstallerConfig')

    const verifyScript = readFileSync(join(root, 'scripts/verify-windows-package.mjs'), 'utf8')
    expect(verifyScript).toContain('level="asInvoker"')
    expect(verifyScript).toContain('level="requireAdministrator"')

    const appMenu = readFileSync(join(root, 'src/main/app-menu.ts'), 'utf8')
    expect(appMenu).toContain('运行安装程序即可直接覆盖安装更新')
  })
})
