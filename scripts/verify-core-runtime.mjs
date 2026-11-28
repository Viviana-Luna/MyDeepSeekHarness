/* oxlint-disable unicorn/require-post-message-target-origin -- utilityProcess 使用父子进程消息，不接受浏览器 targetOrigin。 */
/** 真实核心与原生依赖验收；不调用模型、不联网，数据和插件全部位于临时目录。 */
import { app, utilityProcess } from 'electron'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** 用普通后台插件调用实际工具与服务，不向产品运行时新增验收专用 RPC。 */
async function createSmokePlugin(home, core) {
  const directory = join(home, 'native-smoke-source')
  await mkdir(directory)
  await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }))
  await writeFile(
    join(directory, 'mydsh.plugin.json'),
    JSON.stringify({
      id: 'verification.native-smoke',
      name: '隔离原生依赖验收',
      version: '1.0.0',
      apiVersion: 1,
      backend: 'index.js',
    }),
  )
  await writeFile(
    join(directory, 'index.js'),
    `
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const home = ${JSON.stringify(home)}, core = ${JSON.stringify(core)}
const run = promisify(execFile)
export const inject = ['tools', 'subprocess', 'connection', 'agents', 'agentPresets', 'jobs']
export async function apply(ctx) {
  // 本地 Connection 只保留共享分发；浏览器授权和独立 HTTP 通道必须明确拒绝。
  if (ctx.connection.requestRejection({ headers: { host: 'localhost' } }) !== 403 || ctx.connection.authorizeIndex({}, {}) !== false) throw new Error('本地 Connection 错误地接受了浏览器授权')
  for (const invoke of [() => ctx.connection.authenticatedUrl('http://localhost/'), () => ctx.connection.rpc.handle('/legacy', async () => ({ ok: true, value: null }))]) {
    let rejected = false
    try { invoke() } catch { rejected = true }
    if (!rejected) throw new Error('本地 Connection 没有拒绝 HTTP 专属方法')
  }
  const coreRequire = createRequire(join(core, 'node_modules/@deepseek-ai/dsh-subprocess-local/package.json'))
  const desktopRequire = createRequire(join(core, 'node_modules/@mydsh/desktop-services/package.json'))
  const versions = { abi: process.versions.modules, subprocessPty: coreRequire('node-pty/package.json').version, desktopPty: desktopRequire('node-pty/package.json').version }
  // 工具随真实 Agent 预设装配，不能把旧的全局 bash 注册当作核心就绪条件。
  for (const preset of ['standard', 'minimal', 'gpt-coding']) {
    const handle = await ctx.agents.create({
      sessionId: 'mydsh-native-smoke-' + preset,
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash' },
      meta: { cwd: home, agentPreset: preset },
      setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, preset) },
    })
    try {
      const codex = preset === 'gpt-coding'
      const command = "mydsh --help >/dev/null && printf 'mydsh-shell-ok' > shell-smoke.txt; printf 'mydsh-shell-ok'"
      const result = await ctx.tools.execute({ callId: 'mydsh-native-smoke-' + preset,
        name: codex ? 'exec_command' : 'bash', agent: handle.agent,
        arguments: codex ? { cmd: command, yield_time_ms: 10000 } : { command, timeout: 10 },
        signal: AbortSignal.timeout(20000),
      })
      const job = result.value?.session_id ? ctx.jobs.get(result.value.session_id, handle.agent) : undefined
      const ready = !result.isError && (codex
        ? result.value.status === 'completed' && job?.detail === 'exit code: 0' && result.value.output.includes('mydsh-shell-ok')
        : result.value.exitCode === 0 && result.value.stdout.text.includes('mydsh-shell-ok'))
      if (!ready || await readFile(join(home, 'shell-smoke.txt'), 'utf8') !== 'mydsh-shell-ok') throw new Error('实际模式命令失败：' + JSON.stringify({ preset, result, job }))
    } finally { await handle.dispose() }
  }
  const options = { cwd: home, rows: 24, cols: 80, terminalType: 'xterm-256color', graceMs: 200 }
  const terminal = await ctx.subprocess.spawnTerminal({ ...options, argv: ['/bin/sh', '-c', 'printf mydsh-dsh-pty'] })
  let output = ''
  terminal.output.on('data', data => { output += data })
  try {
    const outcome = await terminal.done
    if (outcome.exitCode !== 0 || !output.includes('mydsh-dsh-pty')) throw new Error('DSH PTY 输出或退出状态无效')
  } finally { await terminal.terminate() }
  const desktopPty = desktopRequire('node-pty').spawn('/bin/sh', ['-c', 'printf mydsh-desktop-pty'], { cwd: home, name: 'xterm-256color', cols: 80, rows: 24, env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' } })
  try {
    await new Promise((resolve, reject) => {
      let text = ''
      const timer = setTimeout(() => reject(new Error('桌面 PTY 未在期限内退出')), 5000)
      desktopPty.onData(data => { text += data })
      desktopPty.onExit(event => {
        clearTimeout(timer)
        if (event.exitCode !== 0 || !text.includes('mydsh-desktop-pty')) reject(new Error('桌面 PTY 输出或退出状态无效'))
        else resolve()
      })
    })
  } finally { try { desktopPty.kill() } catch {} }
  // 保留一个实际存活的受管进程，主进程停止 Runtime 后必须证明它已经消失。
  const owned = await ctx.subprocess.spawnTerminal({ ...options, argv: ['/bin/sleep', '30'] })
  owned.output.resume()
  await writeFile(join(home, 'owned.pid'), String(owned.pid))
  const launch = await import(pathToFileURL(join(core, 'node_modules/@deepseek-ai/dsh-subprocess-local/lib/runner-launch.js')).href)
  const invocation = launch.spawnRunnerInvocation()
  if (invocation[0] !== process.env.MYDSH_NODE_EXECUTABLE || !launch.runnerInvocationAvailable(invocation)) throw new Error('私有 runner 未定位到应用 Node 与随包入口')
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  delete env.DSH_SUBPROCESS_RUNNER
  let runnerExit = 0
  try { await run(invocation[0], invocation.slice(1), { cwd: home, env, timeout: 5000 }) } catch (error) { runnerExit = error.code }
  await writeFile(join(home, 'native-result.json'), JSON.stringify({ ...versions, runnerExit }))
  console.log('原生依赖验收', JSON.stringify({ ...versions, runnerExit }))
  if (runnerExit !== 127) throw new Error('私有 runner 未实际进入无 selector 的拒绝分支')
}
`,
  )
  if (process.platform === 'win32')
    await writeFile(
      join(directory, 'index.js'),
      await readFile(new URL('./core-smoke-windows.mjs', import.meta.url), 'utf8'),
    )
  await writeFile(
    join(directory, 'verify-queued-cancellation.mjs'),
    await readFile(new URL('./verify-queued-cancellation.mjs', import.meta.url), 'utf8'),
  )
  const nativeSource = await readFile(join(directory, 'index.js'), 'utf8')
  await writeFile(
    join(directory, 'index.js'),
    nativeSource.replace('export async function apply(ctx)', 'async function applyNative(ctx)') +
      `
import { verifyQueuedCancellation } from './verify-queued-cancellation.mjs'
export async function apply(ctx) {
  const cases = await verifyQueuedCancellation((name, file = 'index.js') => import(pathToFileURL(join(core, 'node_modules/@deepseek-ai', name, 'lib', file)).href))
  console.log('真实 Electron 队列停止与接续通过', cases)
  await applyNative(ctx)
}
`,
  )
  return directory
}

async function main() {
  const home = process.env.MYDSH_VERIFY_HOME ?? (await mkdtemp(join(tmpdir(), 'mydsh-core-check-')))
  const core = process.env.MYDSH_VERIFY_CORE_DIRECTORY ?? resolve('lib/mydsh-runtime/runtime.asar')
  app.setPath('userData', join(home, 'electron'))
  let child, exitCode, shutdown
  try {
    await app.whenReady()
    const plugin = await createSmokePlugin(home, core)
    // Electron 的 utilityProcess 环境值必须是字符串；macOS 没有 Windows 专属变量。
    const environment = Object.fromEntries(
      Object.entries({
        HOME: home,
        USERPROFILE: home,
        TMPDIR: home,
        TMP: home,
        TEMP: home,
        SystemRoot: process.env.SystemRoot,
        COMSPEC: process.env.COMSPEC,
        PATH:
          process.platform === 'win32'
            ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
            : '/usr/bin:/bin:/usr/sbin:/sbin',
        SHELL: '/bin/sh',
        MYDSH_VERIFY_CORE: core,
        MYDSH_HOME: home,
        MYDSH_NODE_EXECUTABLE: process.execPath,
      }).filter(([, value]) => typeof value === 'string'),
    )
    child = utilityProcess.fork(join(core, 'entry.js'), [], {
      cwd: home,
      env: environment,
      stdio: 'pipe',
      serviceName: 'MyDSH 核心验收',
    })
    const exited = new Promise(resolveExit => {
      child.once('exit', code => {
        exitCode = code
        resolveExit(code)
      })
    })
    shutdown = async () => {
      if (exitCode !== undefined) return
      const force = setTimeout(() => {
        child.kill()
      }, 20_000)
      const hard = setTimeout(() => {
        if (exitCode === undefined && child.pid) process.kill(child.pid, 'SIGKILL')
      }, 22_000)
      try {
        child.postMessage({ type: 'stop' })
        await exited
      } finally {
        clearTimeout(force)
        clearTimeout(hard)
      }
    }
    child.stdout.on('data', data => process.stdout.write(data))
    child.stderr.on('data', data => process.stderr.write(data))
    await new Promise((resolveReady, reject) => {
      let pickerCalls = 0,
        pendingPicker,
        pickerAborted = false
      const timer = setTimeout(
        () => reject(new Error('运行核心与原生依赖未在60秒内完成验收')),
        60000,
      )
      const fail = error => {
        clearTimeout(timer)
        reject(error)
      }
      child.once('exit', code => fail(new Error(`运行核心提前退出：${code}`)))
      child.on('message', message => {
        if (message.type === 'main-call') {
          if (message.method === 'directory.pick') {
            pickerCalls++
            // 只替换系统对话框的返回值，目录选择必须实际经过 Gateway、控制器和 Cordis 服务。
            if (pickerCalls <= 2)
              child.postMessage({
                type: 'main-result',
                id: message.id,
                value: pickerCalls === 1 ? home : null,
              })
            else if (pickerCalls === 3) {
              pendingPicker = message.id
              child.postMessage({ type: 'cancel', id: 'directory-abort' })
            } else fail(new Error('目录选择重复发起了系统调用'))
            return
          }
          if (message.method === 'ssh.window-token') {
            child.postMessage({ type: 'main-result', id: message.id, value: 'verify-window-token' })
            return
          }
          if (!['credentials.keys', 'credentials.get'].includes(message.method)) {
            child.postMessage({
              type: 'main-result',
              id: message.id,
              error: '无凭据的核心启动不得写入系统凭据',
            })
            fail(new Error(`无凭据核心启动触发了写入：${message.method}`))
            return
          }
          child.postMessage({
            type: 'main-result',
            id: message.id,
            value: message.method === 'credentials.keys' ? [] : undefined,
          })
          return
        }
        if (message.type === 'cancel-main-call' && message.id === pendingPicker) {
          pickerAborted = true
          return
        }
        if (message.type === 'log') {
          console.log(message.message)
          return
        }
        if (message.type === 'failed') {
          fail(new Error(message.error.message))
          return
        }
        if (message.type === 'ready') {
          console.log('核心已就绪', message.version)
          child.postMessage({
            type: 'call',
            id: 'directory-selected',
            endpoint: 'directoryPicker/pick',
            payload: { args: {} },
          })
        }
        if (message.type !== 'result') return
        if (message.id === 'directory-abort') {
          if (
            message.result.ok ||
            message.result.error.code !== 'gateway/cancelled' ||
            !pickerAborted
          ) {
            fail(new Error('目录请求取消没有释放主进程对话框调用'))
            return
          }
          console.log('真实目录选择 Remote 的选择、取消与请求释放已通过')
          child.postMessage({
            type: 'call',
            id: 'session-smoke',
            endpoint: 'session/list',
            payload: { args: { _request: {} } },
          })
          return
        }
        if (!message.result.ok) {
          fail(new Error(JSON.stringify(message.result.error)))
          return
        }
        if (message.id === 'directory-selected' || message.id === 'directory-cancelled') {
          const selected = message.id === 'directory-selected'
          if (message.result.value !== (selected ? home : null)) {
            fail(new Error('目录选择结果没有保持所选路径或 null 取消语义'))
            return
          }
          child.postMessage({
            type: 'call',
            id: selected ? 'directory-cancelled' : 'directory-abort',
            endpoint: 'directoryPicker/pick',
            payload: { args: {} },
          })
        } else if (message.id === 'session-smoke') {
          console.log('真实 Session Remote 已通过')
          child.postMessage({
            type: 'call',
            id: 'native-smoke',
            endpoint: 'mydshPlugins/install',
            payload: { path: plugin },
          })
        } else if (message.id === 'native-smoke') {
          clearTimeout(timer)
          resolveReady()
        }
      })
    })
    console.log(
      '实际命令工具与两套 PTY 已通过',
      await readFile(join(home, 'native-result.json'), 'utf8'),
    )
    await shutdown()
    const pid = Number(await readFile(join(home, 'owned.pid'), 'utf8'))
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('验收子进程 PID 无效')
    try {
      process.kill(pid, 0)
      throw new Error('停止 Runtime 后受管 PTY 仍然存在')
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
    if (process.platform === 'win32') {
      const descendant = Number(await readFile(join(home, 'owned-descendant.pid'), 'utf8'))
      try {
        process.kill(descendant, 0)
        throw new Error('停止 Runtime 后终端后代仍然存在')
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    console.log('运行核心、命令工具与受管 PTY 已完成退出清理')
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    try {
      await shutdown?.()
    } finally {
      if (!process.env.MYDSH_VERIFY_HOME)
        await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      app.exit(process.exitCode ?? 0)
    }
  }
}
void main().catch(error => {
  console.error(error)
  app.exit(1)
})
