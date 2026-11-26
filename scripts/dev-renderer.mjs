/**
 * 跨平台启动 Umi 前端开发服务器：固定监听 127.0.0.1:4175，避免 Windows cmd/PowerShell 无法解析 POSIX 环境变量前缀语法。
 * 运行在开发机 Node 进程；收到终止信号时透传关闭子进程。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const rendererDir = resolve(root, 'src', 'renderer')
const require = createRequire(import.meta.url)
const maxEntry = require.resolve('@umijs/max/bin/max.js')

const child = spawn(process.execPath, [maxEntry, 'dev'], {
  cwd: rendererDir,
  env: {
    ...process.env,
    PORT: '4175',
    HOST: '127.0.0.1',
  },
  stdio: 'inherit',
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (child.exitCode === null) child.kill(signal)
  })
}

child.once('exit', (code, signal) => {
  if (signal !== null) {
    process.exit(1)
  }
  process.exit(code ?? 0)
})
