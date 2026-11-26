/** Electron 退出后由父进程删除隔离数据，避开 Windows userData 的文件占用。 */
import electron from 'electron'
import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ensureRuntimeInstalled } from '../lib/main/runtime/runtime-install.js'
const home = await realpath(await mkdtemp(join(tmpdir(), 'mydsh-core-check-')))
try {
  const installed = await ensureRuntimeInstalled({
    bundleDirectory: resolve('lib/mydsh-runtime'),
    mydshHome: home,
  })
  console.log('原生验收核心已安装')
  const env = {
    ...process.env,
    MYDSH_VERIFY_HOME: home,
    MYDSH_VERIFY_CORE_DIRECTORY: installed.runtimeDirectory,
  }
  delete env.ELECTRON_RUN_AS_NODE
  const child = execFile(electron, ['scripts/verify-core-runtime.mjs'], {
    cwd: resolve(import.meta.dirname, '..'),
    env,
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  child.stdout.pipe(process.stdout)
  child.stderr.pipe(process.stderr)
  await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', code =>
      code === 0 ? resolveExit() : reject(new Error('原生核心验收失败：' + code)),
    )
  })
} finally {
  await rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}
