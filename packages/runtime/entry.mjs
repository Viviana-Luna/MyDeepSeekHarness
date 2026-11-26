/**
 * MyDSH 后台入口。仅接受父进程消息，Cordis 服务是业务事实的唯一拥有者。
 * 不启动 HTTP 服务，不发现外部 DSH，不执行用户旧 profile。
 */
/* oxlint-disable unicorn/require-post-message-target-origin -- Electron ParentPort 不是浏览器 Window。 */
import { readFile, mkdir } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { Context, FiberState } from '@deepseek-ai/cordis'
import { Loader, Group } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { MydshSubprocessRuntime } from './subprocess.js'
import { privateFileSystem } from './private-files.mjs'
import { protectPrivateDirectory } from './windows-private-directory.js'
import { installPluginResolution } from './plugin-resolution.js'
import { installPluginTools } from './plugin-tools.js'
import { installDirectoryPicker } from './directory-picker.js'
import { createMydshPluginServices } from './services/plugins.js'
import * as DesktopServices from '@mydsh/desktop-services'
import { TYPERT as desktopContract } from '@mydsh/desktop-services/typert'
import { rgPath } from '@vscode/ripgrep'
import { CordisInspectRegistryService } from '@deepseek-ai/dsh-cordis-host-runner'

const parent = process.parentPort
if (!parent) throw new Error('MyDSH Runtime 必须由桌面宿主启动')
const directory = dirname(fileURLToPath(import.meta.url)),
  home = process.env.MYDSH_HOME
if (!home) throw new Error('MyDSH Runtime 缺少应用数据目录')
process.env.DSH_HOME = join(home, 'data')
process.env.DSH_TELEMETRY_DISABLED = '1'
const ctx = new Context(),
  requests = new Map(),
  replies = new Map(),
  acknowledgements = new Map(),
  activeTasks = new Set()
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024
let serial = 0,
  services,
  hooks,
  stopping = false,
  ready = false,
  stopTask,
  uiBusyReason
const send = message => {
  const encoded = JSON.stringify(message)
  if (Buffer.byteLength(encoded) > MAX_MESSAGE_BYTES) throw new Error('运行消息超过允许的大小')
  try {
    parent.postMessage(message)
    return true
  } catch {
    return false
  }
}
/** 目录对话框由主进程持有，取消与退出沿用同一请求信号。 */
function mainCall(method, payload, signal) {
  if (stopping || replies.size >= 64)
    return Promise.reject(new Error('系统调用正在关闭或超过并发上限'))
  if (signal?.aborted) return Promise.reject(signal.reason)
  const id = `main-${++serial}`
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      signal?.removeEventListener('abort', abort)
      replies.delete(id)
    }
    const cancel = error => {
      cleanup()
      send({ type: 'cancel-main-call', id })
      reject(error)
    }
    const abort = () => cancel(signal.reason)
    replies.set(id, {
      resolve: value => {
        cleanup()
        resolve(value)
      },
      reject: error => {
        cleanup()
        reject(error)
      },
      cancel,
    })
    signal?.addEventListener('abort', abort, { once: true })
    try {
      if (!send({ type: 'main-call', id, method, payload })) throw new Error('桌面宿主通信已关闭')
    } catch (error) {
      cleanup()
      reject(error)
    }
  })
}
const failure = error => ({
  code: typeof error?.code === 'string' ? error.code.slice(0, 120) : 'mydsh/runtime',
  message: (error instanceof Error ? error.message : String(error)).slice(0, 64 * 1024),
  details: {},
})
parent.on('message', ({ data: message }) => {
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') return
  if (message.type === 'main-result') {
    const call = replies.get(message.id)
    if (message.error) call?.reject(new Error(message.error))
    else call?.resolve(message.value)
    return
  }
  if (message.type === 'ack') {
    acknowledgements.get(message.id)?.()
    return
  }
  if (message.type === 'cancel') {
    requests.get(message.id)?.abort()
    acknowledgements.get(message.id)?.()
    return
  }
  if (message.type === 'stop') {
    void stop()
    return
  }
  if (message.type !== 'call' && message.type !== 'open') return
  if (
    typeof message.id !== 'string' ||
    message.id.length > 128 ||
    typeof message.endpoint !== 'string' ||
    message.endpoint.length > 512
  )
    return
  if (stopping || !ready || requests.size >= 256 || requests.has(message.id)) {
    const error = failure(new Error('运行核心未就绪、请求重复或超过并发上限'))
    send({
      type: message.type === 'open' ? 'stream-error' : 'result',
      id: message.id,
      result: { ok: false, error },
      error,
    })
    return
  }
  try {
    if (Buffer.byteLength(JSON.stringify(message)) > MAX_MESSAGE_BYTES) throw new Error('请求过大')
  } catch {
    const error = failure(new Error('运行请求超过允许的大小'))
    send({ type: 'result', id: message.id, result: { ok: false, error } })
    return
  }
  const task = dispatch(message)
  activeTasks.add(task)
  void task.then(
    () => activeTasks.delete(task),
    () => activeTasks.delete(task),
  )
})
async function dispatch(message) {
  const abort = new AbortController()
  requests.set(message.id, abort)
  try {
    if (message.type === 'open') {
      const stream = await ctx.typertGateway.wireStream.open(
        message.endpoint,
        message.payload,
        abort.signal,
      )
      for await (const value of stream) {
        if (abort.signal.aborted) break
        await new Promise(resolve => {
          acknowledgements.set(message.id, resolve)
          if (!send({ type: 'item', id: message.id, value })) {
            abort.abort()
            resolve()
          }
        })
        acknowledgements.delete(message.id)
      }
      send({ type: 'end', id: message.id })
      return
    }
    let value
    if (message.endpoint === 'mydshRuntime/status')
      value = { busy: ctx.agents.list().some(agent => agent.status === 'running') }
    else if (message.endpoint === 'mydshRuntime/uiBusy') {
      if (typeof message.payload?.reason !== 'string' || message.payload.reason.length > 4096)
        throw new Error('界面资源占用信息无效')
      uiBusyReason = message.payload.reason || undefined
      value = true
    } else if (message.endpoint.startsWith('mydshPlugins/'))
      value = await pluginCall(message.endpoint.slice('mydshPlugins/'.length), message.payload)
    else if (message.endpoint.startsWith('mydshConverter/'))
      value = await converterCall(
        message.endpoint.slice('mydshConverter/'.length),
        message.payload,
        abort.signal,
      )
    else {
      const request = new Request(`http://mydsh.internal/api/${message.endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: message.id,
          method: message.endpoint,
          payload: message.payload,
        }),
        signal: abort.signal,
      })
      const response = await ctx.connection.createSharedFetchHandler('/api').fetch(request)
      if (!response.ok) throw new Error(`运行核心未提供接口：${message.endpoint}`)
      const envelope = await response.json()
      send({ type: 'result', id: message.id, result: envelope.result })
      return
    }
    send({ type: 'result', id: message.id, result: { ok: true, value } })
  } catch (error) {
    send({
      type: message.type === 'open' ? 'stream-error' : 'result',
      id: message.id,
      result: { ok: false, error: failure(error) },
      error: failure(error),
    })
  } finally {
    requests.delete(message.id)
    acknowledgements.delete(message.id)
  }
}
async function pluginCall(method, payload = {}) {
  if (method === 'list') return services.manager.list()
  if (method === 'install' || method === 'update') return services.manager[method](payload.path)
  if (['enable', 'disable', 'uninstall', 'rollback'].includes(method))
    return services.manager[method](payload.id)
  throw new Error('未知的插件管理操作')
}
async function converterCall(method, payload = {}, signal) {
  signal.throwIfAborted()
  if (method === 'prepare') return services.converter.prepare(payload, signal)
  if (method === 'validate') return services.converter.validate(payload.id, signal)
  if (['install', 'cancel'].includes(method)) return services.converter[method](payload.id)
  if (method === 'list') return services.converter.list()
  throw new Error('未知的插件转换操作')
}
/** 停止与启动共享同一收束点，清理一个子系统失败不会跳过其他子系统。 */
function stop(exitCode = 0) {
  if (stopTask) return stopTask
  stopping = true
  ready = false
  for (const request of requests.values()) request.abort()
  for (const ack of acknowledgements.values()) ack()
  for (const call of replies.values()) call.cancel(new Error('运行核心正在停止'))
  replies.clear()
  stopTask = (async () => {
    await startup.catch(() => {})
    const cleanup = await Promise.allSettled([
      Promise.resolve().then(() => services?.dispose()),
      Promise.resolve().then(() => ctx.fiber.dispose()),
      ...activeTasks,
    ])
    try {
      hooks?.deregister()
    } catch {
      exitCode = 1
    }
    if (cleanup.some(result => result.status === 'rejected')) exitCode = 1
    send({ type: 'stopped' })
    process.exit(exitCode)
  })()
  return stopTask
}
process.once('SIGTERM', () => {
  void stop()
})
process.once('SIGINT', () => {
  void stop()
})

async function initialize() {
  await mkdir(join(home, 'data'), { recursive: true })
  await protectPrivateDirectory(join(home, 'config'))
  if (process.platform === 'win32') {
    const tools = join(directory, 'tools')
    process.env.MYDSH_PWSH_EXECUTABLE = join(tools, 'powershell/pwsh.exe')
    // 清除宿主 PowerShell 版本留下的模块搜索路径，固定到随包模块。
    for (const key of Object.keys(process.env))
      if (key.toUpperCase() === 'PSMODULEPATH') delete process.env[key]
    process.env.PSModulePath = join(tools, 'powershell/Modules')
    process.env.MYDSH_GIT_EXECUTABLE = join(tools, 'git/cmd/git.exe')
    const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH')
    const inheritedPath = pathKey ? process.env[pathKey] : ''
    for (const key of Object.keys(process.env))
      if (key.toUpperCase() === 'PATH') delete process.env[key]
    process.env.PATH = [
      join(tools, 'powershell'),
      join(tools, 'git/cmd'),
      join(directory, 'node_modules/@vscode/ripgrep/bin'),
      inheritedPath,
    ]
      .filter(Boolean)
      .join(';')
  }
  hooks = installPluginResolution(directory, home)
  ctx.baseUrl = pathToFileURL(directory + '/').href
  ctx.provide('dshHomePath', (...parts) => join(home, 'data', ...parts))
  ctx.logger.exporter({
    levels: { default: 2 },
    export: entry =>
      send({
        type: 'log',
        level: entry.type,
        message: entry.args.map(String).join(' ').slice(0, 1500),
      }),
  })
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.group = Group
  ctx.loader.builtins['mydsh-subprocess'] = MydshSubprocessRuntime
  const { SandboxedFileSystem } = await import('@deepseek-ai/dsh-fs-sandbox')
  ctx.loader.builtins['mydsh-filesystem'] = privateFileSystem(
    SandboxedFileSystem,
    join(home, 'config'),
  )
  // 为历史复制或用户自定义预设保留内置别名；内置三预设统一经 mydsh-cli-bridge 的 `mydsh plugin` 调用。
  ctx.loader.builtins['mydsh-plugin-tools'] = {
    name: 'mydsh-plugin-tools',
    async apply(scope) {
      await installPluginTools(scope, services).await()
    },
  }
  await ctx.plugin(CordisInspectRegistryService).await()
  await installDirectoryPicker(ctx, mainCall).await()
  ctx.provide('mydshConnectionSystem', {
    token: await mainCall('ssh.window-token', {}),
    call: mainCall,
  })
  ctx.provide('mydshAutomationSystem', {
    call: (method, payload = {}, signal) => {
      if (typeof method !== 'string' || !method.startsWith('automation.')) {
        return Promise.reject(new Error('非法自动化系统调用'))
      }
      return mainCall(method, payload, signal)
    },
  })
  const roster = JSON.parse(await readFile(join(directory, 'roster.json'), 'utf8'))
  roster.find(row => row.id === 'subprocess').name = 'cordis:mydsh-subprocess'
  roster.find(row => row.name === '@deepseek-ai/dsh-fs-sandbox').name = 'cordis:mydsh-filesystem'
  const settings = roster.find(row => row.id === 'settings')
  settings.config = { path: join(home, 'config/settings.yaml') }
  // 与 DSH 使用同一个凭据提供方，配置仍只保存引用，密钥位于 MyDSH 私有目录。
  const credentials = roster.find(row => row.id === 'credentials')
  credentials.config = { path: join(home, 'config/credentials.yaml') }
  const presets = roster.find(row => row.id === 'agent-presets')
  presets.config = { default: 'standard', includeShippedRoot: true, includeUserRoot: true }
  const cliBridge = roster.find(row => row.id === 'mydsh-cli-bridge')
  if (cliBridge) {
    cliBridge.config = {
      nodeExecutable: process.env.MYDSH_NODE_EXECUTABLE ?? process.execPath,
      mountExtraTools: async isolatedScope => {
        await installPluginTools(isolatedScope, {
          get manager() {
            return services.manager
          },
          get converter() {
            return services.converter
          },
        }).await()
      },
    }
  }
  // 保留给用户自定义 PTC 预设；内置三预设已收敛至直接工具与二级 CLI。
  const ptc = roster.find(row => row.id === 'ptc-runtime')
  ptc.config = {
    nodeExecutable: process.env.MYDSH_NODE_EXECUTABLE ?? process.execPath,
    bootstrapPath: join(
      directory,
      'node_modules/@deepseek-ai/dsh-ptc-runtime-node/lib/process-entry.js',
    ),
  }
  await ctx.loader.root.update(roster)
  await ctx.loader.await()
  if (stopping) throw new Error('核心启动已取消')
  const failed = [...ctx.loader.entries()].filter(entry => entry.fiber?.state === FiberState.FAILED)
  if (failed.length)
    throw new Error(`核心插件加载失败：${failed.map(entry => entry.options.id).join('、')}`)
  const required = [
    'subprocess',
    'shell',
    'sandbox',
    'ptcRuntime',
    'agents',
    'agentLoop',
    'sessions',
    'llm',
    'tools',
    'typert',
    'typertGateway',
    'connection',
    'sessionController',
    'workspaceRegistry',
    'workspaceController',
    'directoryPickerController',
    'mydshCliBridge',
  ]
  const missing = required.filter(key => !ctx.get(key))
  if (missing.length) throw new Error(`运行核心未就绪：${missing.join('、')}`)
  // 自有服务同样先登记生成契约，再由 Cordis 装配；IPC 不承载业务实现。
  await ctx
    .plugin({
      name: 'mydsh-desktop',
      inject: ['typert'],
      apply(scope) {
        scope.typert.register(desktopContract)
        scope.plugin(DesktopServices, { ripgrepPath: rgPath })
      },
    })
    .await()
  const coreVersion = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')).version
  // 核心清单展示实际装配结果；禁用的可选项不能冒充正在提供服务。
  const entries = new Map([...ctx.loader.entries()].map(entry => [entry.options.id, entry]))
  const builtin = roster.map(row => {
    const entry = entries.get(row.id),
      enabled = Boolean(entry && !entry.disabled),
      running = entry?.fiber?.state === FiberState.ACTIVE
    return {
      id: `mydsh.${row.id}`,
      name: row.id,
      version: coreVersion,
      apiVersion: 1,
      source: 'builtin',
      enabled,
      running,
      status: !enabled ? 'disabled' : running ? 'active' : 'waiting',
      directory,
    }
  })
  services = createMydshPluginServices(ctx, {
    home,
    subprocess: ctx.subprocess,
    nodeExecutable: process.env.MYDSH_NODE_EXECUTABLE ?? process.execPath,
    toolchainDirectory: directory,
    onChange: () => send({ type: 'plugins-changed' }),
    isBusy: () =>
      ctx.agents.list().some(agent => agent.status === 'running') ? '有任务正在运行' : uiBusyReason,
    builtin,
  })
  await services.initialize()
  if (stopping) throw new Error('核心启动已取消')
  ready = true
  send({ type: 'ready', version: coreVersion })
}
const startup = initialize()
void startup.catch(error => {
  if (!stopping) send({ type: 'failed', error: failure(error) })
  void stop(1)
})
