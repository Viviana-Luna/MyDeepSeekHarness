/** 从已验收的应用目录生成支持自选路径的 Windows 按用户离线安装包；不执行签名或发布。 */
import { build, Platform, Arch } from 'electron-builder'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createWindowsInstallerConfig } from './windows-installer-config.mjs'

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
const electronVersion = JSON.parse(
  await readFile(join(root, 'node_modules/electron/package.json'), 'utf8'),
).version
const config = createWindowsInstallerConfig({
  root,
  version: manifest.version,
  electronVersion,
})
if (!existsSync(config.nsis.include))
  throw new Error(`缺少 Windows 安装向导脚本：${config.nsis.include}`)
// 新版 7-Zip 自动选择的 ARM64 / BCJ2 编码与随包 Nsis7z 不兼容，会静默漏文件。
// 固定其支持的 BCJ，不能让调用环境重新启用不兼容编码。上游记录：electron-builder#9983。
process.env.ELECTRON_BUILDER_7Z_FILTER = 'BCJ'
await build({
  prepackaged: packaged,
  targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
  publish: 'never',
  config,
})
console.log('Windows 按用户安装包已生成，支持自定义安装路径，用户数据由卸载程序保留。')
