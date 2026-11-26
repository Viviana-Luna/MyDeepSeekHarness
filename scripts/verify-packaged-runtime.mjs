import { existsSync, readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { join, resolve } from 'node:path'
import { PRODUCT_NAME } from '../lib/shared/product.js'
import { runRuntimeVerification } from './runtime-verification.mjs'

const root = resolve(import.meta.dirname, '..')
const arch = process.env.MYDSH_ARCH ?? process.arch
const { values } = parseArgs({
  options: { executable: { type: 'string' }, foreground: { type: 'boolean' } },
})
const executable = values.executable
  ? resolve(values.executable)
  : process.platform === 'win32'
    ? join(root, 'out', `${PRODUCT_NAME}-win32-${arch}`, `${PRODUCT_NAME}.exe`)
    : join(
        root,
        'out',
        `${PRODUCT_NAME}-darwin-${arch}`,
        `${PRODUCT_NAME}.app`,
        'Contents',
        'MacOS',
        PRODUCT_NAME,
      )
if (!existsSync(executable))
  throw new Error('找不到打包后的 MyDSH，请先运行对应平台的 package 脚本。')

const result = await runRuntimeVerification({
  command: executable,
  // 源码验收保留系统缩放；Windows 制品额外覆盖 150% 分数缩放。
  args: [
    '--verify',
    ...(process.platform === 'win32' ? ['--force-device-scale-factor=1.5'] : []),
    ...(values.foreground ? ['--verify-foreground'] : []),
  ],
  cwd: root,
  label: '打包运行时验收',
  requireRuntime: true,
})
if (!result.stdout.includes('desktop-shell-verify:'))
  throw new Error('打包运行时没有输出验收报告。')

const reportLine = result.stdout.split('\n').find(line => line.startsWith('desktop-shell-verify:'))
if (reportLine === undefined) throw new Error('无法读取打包运行时验收报告。')
const report = JSON.parse(reportLine.slice('desktop-shell-verify:'.length).trim())
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (
  report.productName !== PRODUCT_NAME ||
  report.productVersion !== manifest.version ||
  report.singleInstanceLock !== true
) {
  throw new Error('打包运行时的产品身份或单实例锁不正确。')
}
console.log(`verify-packaged-runtime: ${PRODUCT_NAME} ${manifest.version} 真实运行验收通过。`)
