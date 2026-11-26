/** 从已验收的应用目录生成按用户安装的离线包；不执行签名或发布。 */
import { build, Platform, Arch } from 'electron-builder'
import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('Windows 安装包只能在 Windows x64 上生成')
const root = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const packaged = join(root, 'out/MyDSH-win32-x64')
const core = JSON.parse(
  await readFile(join(packaged, 'resources/mydsh-runtime/manifest.json'), 'utf8'),
)
if (core.platform !== 'win32' || core.arch !== 'x64' || core.version !== manifest.version)
  throw new Error('应用目录中的核心版本或平台不匹配')
// 新版 7-Zip 自动选择的 ARM64 / BCJ2 编码与随包 Nsis7z 不兼容，会静默漏文件。
// 固定其支持的 BCJ，不能让调用环境重新启用不兼容编码。上游记录：electron-builder#9983。
process.env.ELECTRON_BUILDER_7Z_FILTER = 'BCJ'
await build({
  prepackaged: packaged,
  targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
  publish: 'never',
  config: {
    appId: 'io.github.viviana-luna.mydsh',
    productName: 'MyDSH',
    directories: { output: 'out' },
    artifactName: 'mydsh-Windows-x64-' + manifest.version + '.exe',
    electronVersion: JSON.parse(
      await readFile(join(root, 'node_modules/electron/package.json'), 'utf8'),
    ).version,
    forceCodeSigning: false,
    win: {
      icon: join(root, 'out/MyDSH.ico'),
      signAndEditExecutable: false,
      signExecutable: false,
      executableName: 'MyDSH',
    },
    nsis: {
      oneClick: true,
      perMachine: false,
      allowElevation: false,
      deleteAppDataOnUninstall: false,
      runAfterFinish: false,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: 'MyDSH',
      installerLanguages: ['zh_CN', 'en_US'],
    },
  },
})
console.log('Windows 按用户安装包已生成，用户数据由卸载程序保留。')
