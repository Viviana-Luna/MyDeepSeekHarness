/** 原生圆角验收的 Node 入口，Electron 完成退出后清理本次拥有的浏览器数据。 */
import electron from 'electron'
import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

if (process.platform !== 'win32') throw new Error('原生圆角验收需要 Windows')
const home = await realpath(await mkdtemp(join(tmpdir(), 'mydsh-window-shape-')))
try {
  const env = { ...process.env, MYDSH_VERIFY_WINDOW_HOME: home }
  delete env.ELECTRON_RUN_AS_NODE
  const extraArgs = process.argv.slice(2).filter(arg => arg !== '--')
  const child = execFile(electron, ['scripts/verify-native-window-shape.mjs', ...extraArgs], {
    cwd: resolve(import.meta.dirname, '..'),
    env,
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 1024 * 1024,
  })
  child.stdout.pipe(process.stdout)
  child.stderr.pipe(process.stderr)
  await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) =>
      code === 0 ? resolveExit() : reject(new Error(`原生圆角验收失败：${code ?? signal}`)),
    )
  })
} finally {
  await rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}
