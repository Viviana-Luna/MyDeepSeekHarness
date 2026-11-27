/**
 * 源码态真实 Electron 验收入口：支持完整验收、--suite=<名称> 分套件快速验收，
 * 以及 --workbench / --directory-picker / --foreground / --cold-install 选项。
 */
import electronExecutable from 'electron'
import { resolve } from 'node:path'
import { runRuntimeVerification } from './runtime-verification.mjs'

const root = resolve(import.meta.dirname, '..')
const suiteArg = process.argv.find(arg => arg.startsWith('--suite='))
const suiteName = suiteArg === undefined ? undefined : suiteArg.slice('--suite='.length).trim()
const coldInstall =
  process.argv.includes('--cold-install') || process.env.MYDSH_VERIFY_COLD_INSTALL === '1'

const result = await runRuntimeVerification({
  command: electronExecutable,
  args: [
    '.',
    '--verify',
    ...(suiteName === undefined || suiteName === '' ? [] : [`--verify-suite=${suiteName}`]),
    ...(process.argv.includes('--workbench') ? ['--verify-workbench'] : []),
    ...(process.argv.includes('--directory-picker') ? ['--verify-directory-picker'] : []),
    ...(process.argv.includes('--foreground') ? ['--verify-foreground'] : []),
  ],
  cwd: root,
  label:
    suiteName === undefined || suiteName === '' ? '源码运行时验收' : `源码运行时验收[${suiteName}]`,
  requireRuntime: true,
  coldInstall,
})
if (!result.stdout.includes('desktop-shell-verify:')) {
  throw new Error('源码运行时没有输出验收报告。')
}
