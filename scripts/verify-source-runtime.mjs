import electronExecutable from 'electron'
import { resolve } from 'node:path'
import { runRuntimeVerification } from './runtime-verification.mjs'

const root = resolve(import.meta.dirname, '..')
const result = await runRuntimeVerification({
  command: electronExecutable,
  args: [
    '.',
    '--verify',
    ...(process.argv.includes('--workbench') ? ['--verify-workbench'] : []),
    ...(process.argv.includes('--directory-picker') ? ['--verify-directory-picker'] : []),
    ...(process.argv.includes('--foreground') ? ['--verify-foreground'] : []),
  ],
  cwd: root,
  label: '源码运行时验收',
  requireRuntime: true,
})
if (!result.stdout.includes('desktop-shell-verify:')) {
  throw new Error('源码运行时没有输出验收报告。')
}
