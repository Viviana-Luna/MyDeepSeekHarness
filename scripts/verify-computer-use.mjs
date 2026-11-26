/** macOS 真实 Electron 系统级 Computer Use 验收入口：启动隔离 Electron 并清理临时目录。 */
import electron from 'electron'
import { spawn } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

if (process.platform !== 'darwin' && process.platform !== 'win32') {
  throw new Error('Computer Use 真实验收仅支持 macOS 与 Windows')
}

const root = resolve(import.meta.dirname, '..')
const home = await realpath(await mkdtemp(join(tmpdir(), 'mydsh-computer-use-verify-')))
try {
  const env = { ...process.env, MYDSH_VERIFY_CU_HOME: home }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, ['scripts/verify-computer-use-electron.mjs'], {
    cwd: root,
    env,
    stdio: 'inherit',
  })
  await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch {
        /* 忽略已退出进程。 */
      }
      reject(new Error('Computer Use 真实 Electron 验收超时（45s）'))
    }, 45_000)
    child.once('error', err => {
      clearTimeout(timer)
      reject(err)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolveExit()
      else {
        reject(
          new Error(
            `Computer Use 真实 Electron 验收失败：退出码 ${code ?? 'null'}，信号 ${signal ?? 'none'}`,
          ),
        )
      }
    })
  })
} finally {
  await rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}
