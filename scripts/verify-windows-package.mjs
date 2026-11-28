/** 检查 Windows 制品内容，再运行打包后应用的完整离线验收。 */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { listPackage, extractFile } from '@electron/asar'
import { withExtractedWindowsInstaller } from './windows-installer-verification.mjs'

if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('Windows 制品验收需要 Windows x64')
const root = resolve(import.meta.dirname, '..')
const packagedDirectory = join(root, 'out/MyDSH-win32-x64')
const source = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
function verifyContent(directory) {
  const executable = join(directory, 'MyDSH.exe')
  const pe = readFileSync(executable)
  const offset = pe.readUInt32LE(0x3c)
  if (
    pe.toString('ascii', offset, offset + 4) !== 'PE\0\0' ||
    pe.readUInt16LE(offset + 4) !== 0x8664
  )
    throw new Error('Windows 主程序不是 x64 PE')
  const asar = join(directory, 'resources/app.asar')
  const entries = listPackage(asar).map(entry => entry.replaceAll('\\', '/'))
  if (entries.some(entry => entry.includes('/mydsh-runtime/')))
    throw new Error('原生核心不能封入 ASAR')
  const app = JSON.parse(extractFile(asar, 'package.json').toString())
  if (
    app.name !== 'mydsh' ||
    app.version !== source.version ||
    app.dependencies?.ws !== source.dependencies?.ws ||
    app.dependencies?.yaml !== source.dependencies?.yaml
  )
    throw new Error('Windows 制品身份或 ASAR 运行时依赖版本不正确')
  const unpackedComputerUse = join(
    directory,
    'resources/app.asar.unpacked/lib/main/computer-use.node',
  )
  if (
    !entries.includes('/lib/main/window-background.node') ||
    !existsSync(join(directory, 'resources/app.asar.unpacked/lib/main/window-background.node'))
  ) {
    throw new Error('Windows 制品缺少自定义背景裁剪的原生模块')
  }
  if (!entries.includes('/lib/main/computer-use.node') || !existsSync(unpackedComputerUse)) {
    throw new Error('Windows 制品缺少桌面 Computer Use 原生模块')
  }
  const cuPe = readFileSync(unpackedComputerUse)
  const cuOff = cuPe.readUInt32LE(0x3c)
  if (
    cuPe.toString('ascii', cuOff, cuOff + 4) !== 'PE\0\0' ||
    cuPe.readUInt16LE(cuOff + 4) !== 0x8664
  ) {
    throw new Error('Windows 桌面 Computer Use 原生模块不是 x64 PE')
  }
  if (!entries.includes('/node_modules/ws/package.json')) {
    throw new Error('Windows 制品缺少外置浏览器 CDP 所需的 ws 依赖')
  }
  for (const file of [
    'runtime.asar',
    'tools/powershell/pwsh.exe',
    'tools/git/cmd/git.exe',
    'tools/powershell/LICENSE.txt',
    'tools/git/LICENSE.txt',
    'runtime.asar.unpacked/node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe',
  ]) {
    if (!existsSync(join(directory, 'resources/mydsh-runtime', file)))
      throw new Error('Windows 制品缺少必要文件：' + file)
  }
  const runtimeEntries = listPackage(join(directory, 'resources/mydsh-runtime/runtime.asar')).map(
    entry => entry.replaceAll('\\', '/'),
  )
  for (const entry of ['/entry.js', '/node_modules/koffi/src/koffi/index.cjs']) {
    if (!runtimeEntries.includes(entry)) {
      throw new Error('Windows 核心归档缺少必要文件：' + entry)
    }
  }
  execFileSync(
    process.execPath,
    ['scripts/verify-standalone.mjs', '--bundle', join(directory, 'resources/mydsh-runtime')],
    { cwd: root, stdio: 'inherit', windowsHide: true },
  )
}
function verifyRuntime(directory) {
  execFileSync(
    process.execPath,
    [
      'scripts/verify-packaged-runtime.mjs',
      '--executable',
      join(directory, 'MyDSH.exe'),
      ...(process.argv.includes('--foreground') ? ['--foreground'] : []),
    ],
    { cwd: root, stdio: 'inherit', windowsHide: true },
  )
}
verifyContent(packagedDirectory)
if (process.argv.includes('--made')) {
  const installer = join(root, 'out', 'mydsh-Windows-x64-' + source.version + '.exe')
  if (!existsSync(installer)) throw new Error('缺少按用户安装包')
  const installerBinary = readFileSync(installer)
  if (
    !installerBinary.includes(Buffer.from('level="asInvoker"')) ||
    installerBinary.includes(Buffer.from('level="requireAdministrator"'))
  ) {
    throw new Error('Windows 安装包清单必须声明按当前用户执行（asInvoker），不得要求管理员提权')
  }
  await withExtractedWindowsInstaller(installer, async installed => {
    verifyContent(installed)
    verifyRuntime(installed)
  })
} else verifyRuntime(packagedDirectory)
console.log('Windows x64 制品完整性与真实运行验收通过。')
