/**
 * 安装后的原生模块准备。
 *
 * macOS 保持既有行为：为 Electron ABI 重建 node-pty。
 * Windows 跳过重建：node-pty 的预编译包是 Node-API 模块，ABI 稳定，
 * 已实测可在 Electron 运行时直接加载并启动 ConPTY，因此不需要 MSVC，
 * 也不需要 Spectre 缓解库。跳过前校验每一份已安装副本都带有本机平台的
 * 预编译包；缺失时直接失败，避免把注定加载不了的原生模块留在安装结果里。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const MODULE_NAME = 'node-pty'
const root = resolve(import.meta.dirname, '..')

/** 列出 pnpm 虚拟存储中该模块的全部副本；非 pnpm 布局时返回空数组。 */
function installedCopies(name) {
  const store = join(root, 'node_modules', '.pnpm')
  if (!existsSync(store)) return []
  return readdirSync(store)
    .filter(entry => entry === name || entry.startsWith(`${name}@`))
    .map(entry => join(store, entry, 'node_modules', name))
    .filter(directory => existsSync(join(directory, 'package.json')))
}

/** 该副本是否带有当前平台与架构的 Node-API 预编译包。 */
function hasPlatformPrebuild(directory) {
  const prebuilds = join(directory, 'prebuilds', `${process.platform}-${process.arch}`)
  return existsSync(prebuilds) && readdirSync(prebuilds).some(entry => entry.endsWith('.node'))
}

if (process.platform !== 'win32') {
  execFileSync('electron-rebuild', ['-f', '-w', MODULE_NAME], { cwd: root, stdio: 'inherit' })
} else {
  const copies = installedCopies(MODULE_NAME)
  const missing = copies.filter(directory => !hasPlatformPrebuild(directory))
  if (copies.length === 0 || missing.length > 0) {
    throw new Error(
      `缺少 ${MODULE_NAME} 的 ${process.platform}-${process.arch} 预编译包，不能跳过重建：` +
        (missing.length > 0 ? missing.join('、') : '未找到已安装副本'),
    )
  }
  console.log(
    `跳过 ${MODULE_NAME} 的 Electron ABI 重建：${copies.length} 份副本均带有 ${process.platform}-${process.arch} 的 Node-API 预编译包。`,
  )
}
