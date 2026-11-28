/* oxlint-disable unicorn/require-post-message-target-origin -- Electron ParentPort 不使用浏览器 targetOrigin。 */
/**
 * 真实模型只改写临时源码，通过实际 Agent 工具、编译器、插件管理器和 Renderer 插槽完成验收。
 * 显式传入 --use-dsh-model 才读取现有模型凭据；凭据仅在父进程和隔离 Runtime 的内存中传递。
 * 不运行生产数据目录、用户 Skills 或 shell 工具；全部日志、会话和产物随 finally 删除。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { lstatSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, realpath, cp } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { dirname, join, resolve, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const filename = fileURLToPath(import.meta.url)
const repository = resolve(dirname(filename), '..')
const payload =
  process.env.MYDSH_VERIFICATION_RUNTIME ?? join(repository, 'lib/mydsh-runtime/runtime.asar')
const localRequire = createRequire(join(repository, 'package.json'))
const budget = { requests: 6, tokens: 40_000, output: 6_000, milliseconds: 360_000 }
const approvedModelEndpoint = 'https://api.commandcode.ai/provider/v1'
const pluginId = 'converted-files'
const sessionId = 'mydsh-plugin-conversion-verification'
const allowedTools = [
  'read',
  'write',
  'edit',
  'converter_prepare',
  'converter_validate',
  'converter_install',
  'converter_list',
]

/** 来源目录包含原始文件；排除依赖和版本控制目录，与转换器的来源固定方式一致。 */
async function digest(directory) {
  const hash = createHash('sha256')
  async function walk(current) {
    for (const entry of (await readdir(current, { withFileTypes: true })).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const file = join(current, entry.name)
      if (entry.isDirectory()) await walk(file)
      else {
        assert(entry.isFile(), '原插件不能包含符号链接')
        hash.update(relative(directory, file))
        hash.update(await readFile(file))
      }
    }
  }
  await walk(directory)
  return hash.digest('hex')
}

async function main() {
  const { app, utilityProcess, BrowserWindow, ipcMain } = await import('electron')
  const setupOnly = process.argv.includes('--check-setup')
  if (!setupOnly && !process.argv.includes('--use-dsh-model'))
    throw new Error(
      '真实模型验收需要显式传入 --use-dsh-model，确认只为本次隔离验收读取已有 DSH 模型配置与凭据。',
    )
  const sourceArgument = process.argv.find(value => value.startsWith('--source='))?.slice(9)
  const source = await realpath(
    sourceArgument ?? join(repository, '../deepseek-harness/packages/client/ui-sidebar-files'),
  )
  const originalDigest = await digest(source)
  const { parse } = localRequire('yaml')
  const readYaml = async basename => {
    const text = await readFile(join(homedir(), '.dsh', basename), 'utf8')
    try {
      return parse(text)
    } catch {
      throw new Error('已有 DSH 配置格式无效；为保护凭据，不输出原始行。')
    }
  }
  const settings = setupOnly
    ? {
        'agent-default-model': { provider: 'mydsh-check-unused', model: 'unused' },
        'llm-pi-ai': {
          providers: {
            'mydsh-check-unused': {
              api: 'openai-completions',
              baseURL: 'https://example.invalid',
              apiKeyEnv: 'MYDSH_CHECK_UNUSED',
              models: [{ id: 'unused', contextWindow: 1_000_000 }],
            },
          },
        },
      }
    : await readYaml('settings.yaml')
  const selected = settings['agent-default-model']
  const configured = settings['llm-pi-ai']?.providers?.[selected?.provider]
  assert(configured && selected?.model, '已有默认模型不是本验收支持的 llm-pi-ai 路由')
  const model = configured.models?.find(value => value.id === selected.model)
  assert(model && typeof configured.apiKeyEnv === 'string', '默认模型或凭据引用缺失')
  // 已授权的目标按原字符串精确匹配；配置变化时停止，不能静默把源码发送到另一个地址。
  assert(
    setupOnly || configured.baseURL === approvedModelEndpoint,
    `真实模型验收仅允许 ${approvedModelEndpoint}`,
  )
  const credentials = setupOnly ? {} : await readYaml('.credentials.yaml')
  const secret = setupOnly
    ? undefined
    : process.env[configured.apiKeyEnv] || credentials.refs?.[configured.apiKeyEnv]
  assert(setupOnly || (typeof secret === 'string' && secret.length > 0), '指定模型的凭据不可用')
  // 仅复制当前模型的公开连接字段，其他设置、账户和凭据不进入隔离运行时。
  const provider = Object.fromEntries(
    ['displayName', 'api', 'baseURL', 'apiKeyEnv', 'compat']
      .filter(key => configured[key] !== undefined)
      .map(key => [key, configured[key]]),
  )
  const modelEndpoint = new URL(provider.baseURL)
  assert(
    modelEndpoint.protocol === 'https:' && !modelEndpoint.username && !modelEndpoint.password,
    '验收只支持不含内嵌凭据的 HTTPS 模型地址',
  )
  provider.models = [model]
  provider.defaultMaxTokens = budget.output
  provider.retryPolicy = { mode: 'normal', maxRetries: 0 }
  const redact = value =>
    secret ? String(value).replaceAll(secret, '[已隐藏凭据]') : String(value)
  const home = await mkdtemp(join(tmpdir(), 'mydsh-plugin-conversion-'))
  let child,
    window,
    serial = 0,
    exitCode = 0
  const remotePending = new Map()
  const rendererCalls = new Map()
  app.setPath('userData', join(home, 'electron'))
  // 隐藏验收窗口关闭后仍需完成 Runtime 和临时目录清理，最后由本脚本显式退出。
  app.on('window-all-closed', () => {})
  try {
    await app.whenReady()
    await mkdir(join(home, 'project'), { recursive: true })
    await writeFile(join(home, 'project/验收文件.txt'), 'MyDSH 文件侧栏真实服务验收\n')
    const { build } = localRequire('esbuild')
    const harness = join(home, 'harness.js')
    // 先证明界面验收器能构建，避免模型完成转换后才发现本地脚本装配错误。
    await build({
      stdin: { contents: rendererHarness({ id: pluginId }), resolveDir: repository, loader: 'ts' },
      bundle: true,
      platform: 'browser',
      format: 'iife',
      outfile: harness,
      jsx: 'automatic',
      alias: {
        '@umijs/max': join(repository, 'src/renderer/src/.umi-production/plugin-model/index.tsx'),
      },
      logLevel: 'silent',
    })
    const isAsarPayload = payload.toLowerCase().endsWith('.asar')
    const isolatedBundle = join(home, 'runtime')
    await cp(isAsarPayload ? dirname(payload) : payload, isolatedBundle, { recursive: true })
    const isolatedPayload = isAsarPayload ? join(isolatedBundle, 'runtime.asar') : isolatedBundle
    child = utilityProcess.fork(filename, [], {
      cwd: home,
      stdio: 'pipe',
      serviceName: 'MyDSH 插件真实转换验收',
      env: {
        PATH: '/usr/bin:/bin',
        HOME: home,
        TMPDIR: tmpdir(),
        MYDSH_HOME: home,
        MYDSH_VERIFICATION_RUNTIME: isolatedPayload,
        MYDSH_NODE_EXECUTABLE: process.execPath,
        DSH_TELEMETRY_DISABLED: '1',
        ...(secret ? { [configured.apiKeyEnv]: secret } : {}),
      },
    })
    // 不转发第三方任意日志或模型文本，防止网络库诊断意外带出认证头。
    child.stdout.on('data', () => {})
    child.stderr.on('data', () => {})
    const installed = await new Promise((done, fail) => {
      const timer = setTimeout(
        () => fail(new Error('真实模型转换超过六分钟预算')),
        budget.milliseconds,
      )
      child.once('exit', code => {
        clearTimeout(timer)
        fail(new Error(`验收运行时提前退出：${code}`))
      })
      child.on('message', message => {
        if (message.type === 'boot')
          child.postMessage({
            type: 'init',
            source,
            provider,
            providerId: selected.provider,
            model: selected.model,
            setupOnly,
            reasoningEffort: model.reasoningEfforts?.low !== undefined ? 'low' : undefined,
          })

        if (message.type === 'progress') console.log(redact(message.message))
        if (message.type === 'failed') {
          clearTimeout(timer)
          fail(new Error(redact(message.error)))
        }
        if (message.type === 'installed' || message.type === 'setup-ready') {
          clearTimeout(timer)
          done(message)
        }
        if (message.type === 'remote-result') {
          const pending = remotePending.get(message.id)
          remotePending.delete(message.id)
          if (message.error) pending?.reject(new Error(redact(message.error)))
          else pending?.resolve(message.value)
        }
      })
    })
    if (setupOnly) {
      const result = await new Promise((resolveCall, rejectCall) => {
        remotePending.set('setup-list', { resolve: resolveCall, reject: rejectCall })
        child.postMessage({
          type: 'remote',
          id: 'setup-list',
          endpoint: 'workspaceFiles/list',
          args: { workspaceFileScopeId: sessionId, path: '.' },
        })
      })
      assert(
        result.entries.some(entry => entry.name === '验收文件.txt'),
        '隔离会话的真实文件 Remote 未通过',
      )
      console.log(
        '转换验收器装配、核心服务、共享 SDK 构建及真实文件 Remote 通过；继续用明确的本地夹具检查 React 挂载。',
      )
    }
    if (!setupOnly)
      console.log(
        `真实 Agent 转换完成：${installed.requests} 次模型请求，${installed.tokens} token；审批已记录。`,
      )
    const preload = join(home, 'preload.cjs')
    await writeFile(
      preload,
      `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('dshDesktop',{version:12,remote:{call:(endpoint,args,id)=>ipcRenderer.invoke('mydsh-conversion-remote',endpoint,args,id),cancelCall:id=>ipcRenderer.invoke('mydsh-conversion-cancel',id)}});`,
    )
    const assertRenderer = event => {
      assert(
        event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame,
        '拒绝其他页面调用',
      )
    }
    ipcMain.handle('mydsh-conversion-remote', (event, endpoint, args, callId) => {
      assertRenderer(event)
      assert(
        endpoint === 'workspaceFiles/list' && args.workspaceFileScopeId === sessionId,
        '只允许验收会话的文件读取',
      )
      assert(
        callId === undefined ||
          (typeof callId === 'string' &&
            /^[1-9][0-9]{0,11}$/.test(callId) &&
            !rendererCalls.has(callId)),
        '调用标识无效',
      )
      const id = `remote-${++serial}`
      if (callId !== undefined) rendererCalls.set(callId, id)
      return new Promise((resolveCall, rejectCall) => {
        remotePending.set(id, { resolve: resolveCall, reject: rejectCall })
        child.postMessage({ type: 'remote', id, endpoint, args })
      }).finally(() => {
        if (callId !== undefined) rendererCalls.delete(callId)
      })
    })
    ipcMain.handle('mydsh-conversion-cancel', (event, callId) => {
      assertRenderer(event)
      const id = rendererCalls.get(callId)
      if (id) child.postMessage({ type: 'cancel-remote', id })
    })
    const html = join(home, 'harness.html')
    await writeFile(
      html,
      '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>MyDSH 插件隔离验收</title><body><script src="harness.js"></script></body></html>',
    )
    window = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload },
    })
    window.webContents.on('console-message', event => {
      if (event.level === 'error') console.error(redact(`Renderer：${event.message}`))
    })
    await window.loadFile(html)
    const frontend = setupOnly
      ? setupFrontendFixture()
      : await readFile(join(installed.plugin.directory, installed.plugin.frontend), 'utf8')
    await window.webContents.executeJavaScript(frontend)
    const result = await window.webContents.executeJavaScript(
      `Promise.resolve().then(()=>globalThis.verifyConvertedPlugin(${JSON.stringify(sessionId)})).catch(error=>({verificationError:error.stack||error.message}))`,
    )
    assert(!result.verificationError, result.verificationError)
    assert(
      result.mounted > 0 &&
        result.released === 0 &&
        result.fileFound &&
        result.rendered &&
        result.cleaned &&
        serial >= 2,
      '实际组件渲染、文件调用或插件卸载清理没有通过',
    )
    assert.equal(remotePending.size, 0, '卸载后仍有未结束的 Remote 调用')
    assert.equal(rendererCalls.size, 0, '卸载后仍有未释放的调用编号')
    assert.equal(await digest(source), originalDigest, '验收改变了官方插件原始源码')
    console.log(
      setupOnly
        ? '无模型装配检查通过：本地夹具实际挂载 React 模式、渲染真实文件名并卸载释放；未读取用户配置/凭据，未调用模型，不代表官方插件已由 AI 转换。'
        : '实际 Renderer 模式组件、共享 SDK、workspaceFiles Remote、文件名渲染及卸载清理通过；官方源码保持不变。',
    )
    await new Promise(resolveExit => {
      const timer = setTimeout(resolveExit, 10_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolveExit()
      })
      child.postMessage({ type: 'stop' })
    })
  } catch (error) {
    console.error(redact(error instanceof Error ? error.message : error))
    exitCode = 1
  } finally {
    ipcMain.removeHandler('mydsh-conversion-remote')
    ipcMain.removeHandler('mydsh-conversion-cancel')
    window?.destroy()
    // 先让转换器中止自有子进程组，再兜底终止 utilityProcess，避免编译器成为孤儿进程。
    if (child?.pid)
      await new Promise(resolveExit => {
        const timer = setTimeout(resolveExit, 5_000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolveExit()
        })
        child.postMessage({ type: 'stop' })
      })
    child?.kill()
    await rm(home, { recursive: true, force: true })
    app.exit(exitCode)
  }
}

function rendererHarness(plugin) {
  return `import * as React from 'react';import * as ReactDOM from 'react-dom';import {createRoot} from 'react-dom/client';import * as jsx from 'react/jsx-runtime';import * as jsxDev from 'react/jsx-dev-runtime';import * as Cordis from '@deepseek-ai/cordis';import {Provider} from '@umijs/max';import * as sdk from './src/renderer/src/plugins/sdk.ts';import {UiRuntime} from './src/renderer/src/plugins/registry.ts';import {UiRuntimeContext} from './src/renderer/src/plugins/react.tsx';
  const runtime=new UiRuntime();let factory;
  globalThis.__MYDSH_PLUGINS__={define(id,value){if(id!==${JSON.stringify(plugin.id)})throw Error('插件标识错误');factory=value}};
  globalThis.verifyConvertedPlugin=async function(sessionId){
    const module={exports:{}};const shared={'react':React,'react-dom':ReactDOM,'react/jsx-runtime':jsx,'react/jsx-dev-runtime':jsxDev,'@deepseek-ai/cordis':Cordis,'@mydsh/ui':sdk};
    const container=document.createElement('main');document.body.append(container);const root=createRoot(container);
    const snapshot=Object.freeze({selectedSessionId:sessionId}),subscriptions=new Set();let activeViews=0;
    // 会话选择是隔离验收输入；文件内容仍必须经真实 SDK 和 Runtime 获取。
    const store={getSnapshot:()=>snapshot,subscribe:listener=>{subscriptions.add(listener);return()=>subscriptions.delete(listener)}};
    const models={workspace:()=>({store})};const h=React.createElement;
    function Probe({View}){React.useEffect(()=>{activeViews++;return()=>{activeViews--}},[]);return h(View)}
    function Modes(){const islands=sdk.useIslands();return sdk.useModes().map(mode=>{const island=islands.find(item=>item.id===mode.mainIslandId);return island?h(Probe,{key:mode.id,View:island.component}):null})}
    async function until(predicate,message){const deadline=Date.now()+10_000;while(!predicate()){if(Date.now()>deadline)throw Error(message);await new Promise(resolve=>setTimeout(resolve,25))}}
    try{
      factory(name=>{if(!(name in shared))throw Error('非共享模块：'+name);return shared[name]},module,module.exports);
      const plugin=module.exports;await runtime.install(${JSON.stringify(plugin.id)},plugin);
      const mounted=runtime.slots.core.entries('modes').length;if(!mounted)throw Error('转换插件未注册模式');
      const listing=await plugin.loadDirectory(sessionId,'.');
      root.render(h(Provider,{models},h(UiRuntimeContext.Provider,{value:runtime},h(Modes))));
      await until(()=>activeViews>0&&container.innerText.includes('验收文件.txt'),'转换模式没有渲染真实文件名');
      const rendered=true;
      await runtime.uninstall(${JSON.stringify(plugin.id)});
      await until(()=>activeViews===0&&subscriptions.size===0&&container.childElementCount===0,'模式卸载后组件或订阅仍然存活');
      return {mounted,released:runtime.slots.core.entries('modes').length,fileFound:listing.entries.some(entry=>entry.name==='验收文件.txt'),rendered,cleaned:true};
    }finally{root.unmount();container.remove();await runtime.dispose()}
  };`
}

/** 此夹具只验收脚本装配，不作为 AI 重写官方源码的产物或成功证据。 */
function setupFrontendFixture() {
  return `globalThis.__MYDSH_PLUGINS__.define(${JSON.stringify(pluginId)},function(require,module,exports){
    const React=require('react'),sdk=require('@mydsh/ui');
    async function loadDirectory(sessionId,path,signal){return sdk.callRemote('workspaceFiles/list',{workspaceFileScopeId:sessionId,path},signal)}
    function Files(){
      const {selectedSessionId}=sdk.useWorkspaceSnapshot();const [entries,setEntries]=React.useState([]),[error,setError]=React.useState('');
      React.useEffect(()=>{const controller=new AbortController();loadDirectory(selectedSessionId,'.',controller.signal).then(value=>{if(!controller.signal.aborted)setEntries(value.entries)},error=>{if(!controller.signal.aborted)setError(error.message)});return()=>controller.abort()},[selectedSessionId]);
      return React.createElement('section',null,error||React.createElement('ul',null,...entries.map(entry=>React.createElement('li',{key:entry.name},entry.name))))
    }
    exports.loadDirectory=loadDirectory;exports.inject=['mydshSlots'];exports.apply=ctx=>{ctx.mydshSlots.registerIsland({id:'files',label:'本地装配夹具',icon:()=>null,component:Files,placements:['main'],scope:'session'});ctx.mydshSlots.registerMode({id:'files',label:'本地装配夹具',icon:()=>null,mainIslandId:'files'})};
  });`
}

async function worker() {
  const parent = process.parentPort
  const home = process.env.MYDSH_HOME
  const remoteRequests = new Map()
  let services,
    hooks,
    ctx,
    agent,
    stopping = false
  const send = message => parent.postMessage(message)
  const stop = async () => {
    if (stopping) return
    stopping = true
    for (const controller of remoteRequests.values()) controller.abort()
    await agent?.cancel()
    await services?.dispose()
    await ctx?.fiber.dispose()
    hooks?.deregister()
    process.exit(0)
  }
  const seed = await new Promise(resolveSeed => {
    parent.on('message', async ({ data: message }) => {
      if (message.type === 'init') resolveSeed(message)
      if (message.type === 'stop') void stop()
      if (message.type === 'cancel-remote') remoteRequests.get(message.id)?.abort()
      if (message.type === 'remote') {
        const controller = new AbortController()
        remoteRequests.set(message.id, controller)
        try {
          const response = await ctx.connection.createSharedFetchHandler('/api').fetch(
            new Request(`http://mydsh.internal/api/${message.endpoint}`, {
              method: 'POST',
              signal: controller.signal,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                type: 'client-request',
                rpcId: message.id,
                method: message.endpoint,
                payload: { args: message.args },
              }),
            }),
          )
          const envelope = await response.json()
          if (!envelope.result.ok) throw new Error(envelope.result.error.message)
          send({ type: 'remote-result', id: message.id, value: envelope.result.value })
        } catch (error) {
          send({ type: 'remote-result', id: message.id, error: error.message })
        } finally {
          remoteRequests.delete(message.id)
        }
      }
    })
    send({ type: 'boot' })
  })
  try {
    process.env.DSH_HOME = join(home, 'data')
    const requirePayload = createRequire(join(payload, 'package.json'))
    const load = name => import(pathToFileURL(requirePayload.resolve(name)).href)
    const [
      { Context, FiberState },
      { Loader, Group },
      { default: Include },
      { createUserMessage },
    ] = await Promise.all([
      load('@deepseek-ai/cordis'),
      load('@deepseek-ai/cordis-plugin-loader'),
      load('@deepseek-ai/cordis-plugin-include'),
      load('@deepseek-ai/dsh-llm'),
    ])
    const [{ installPluginResolution }, { installPluginTools }, { createMydshPluginServices }] =
      await Promise.all([
        import(pathToFileURL(join(payload, 'plugin-resolution.js'))),
        import(pathToFileURL(join(payload, 'plugin-tools.js'))),
        import(pathToFileURL(join(payload, 'services/plugins.js'))),
      ])
    await mkdir(join(home, 'data'), { recursive: true })
    ctx = new Context()
    ctx.baseUrl = pathToFileURL(payload + '/').href
    ctx.provide('dshHomePath', (...parts) => join(home, 'data', ...parts))
    hooks = installPluginResolution(payload, home)
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.builtins.group = Group
    // 保留真实核心装配；禁止读入个人 Skills/指令，关闭不属于这一次转换的附加模型调用。
    const exclude = new Set([
      'session-title-llm',
      'agent-instructions',
      'agent-presets',
      'skill-filesystem',
      'shell-env',
      'llm-retry',
    ])
    const roster = JSON.parse(await readFile(join(payload, 'roster.json'), 'utf8')).filter(
      row => !exclude.has(row.id),
    )
    roster.push({ id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' })
    roster.find(row => row.id === 'credentials').config = {
      path: join(home, 'config/credentials.yaml'),
    }
    roster.find(row => row.id === 'settings').config = { path: join(home, 'data/settings.yaml') }
    roster.find(row => row.id === 'llm-pi-ai').config = {
      providers: { [seed.providerId]: seed.provider },
    }
    await ctx.loader.root.update(roster)
    await ctx.loader.await()
    const failed = [...ctx.loader.entries()].filter(row => row.fiber?.state === FiberState.FAILED)
    assert.equal(failed.length, 0, `核心装配失败：${failed.map(row => row.options.id).join(',')}`)
    services = createMydshPluginServices(ctx, {
      home,
      nodeExecutable: process.env.MYDSH_NODE_EXECUTABLE,
      toolchainDirectory: payload,
    })
    await services.initialize()
    await installPluginTools(ctx, services).await()
    let requests = 0,
      tokens = 0
    const completedTools = []
    ctx.on('llm/stream', async function* (_options, next) {
      // 供应商用量在请求完成后才返回；发送前用现有计量器加余量预留本轮输入和最大输出。
      const reserved =
        Math.ceil(ctx.tokenMeter.measure(agent.session).totalTokens * 1.2) + budget.output
      if (requests >= budget.requests || tokens + reserved > budget.tokens)
        throw new Error('已达到本次真实模型验收预算')
      requests += 1
      send({ type: 'progress', message: `真实 Agent 模型请求 ${requests}/${budget.requests}` })
      let usage
      try {
        for await (const chunk of next()) {
          if (chunk.type === 'usage') usage = chunk.usage
          yield chunk
        }
      } finally {
        tokens += usage
          ? (usage.totalTokens ??
            usage.inputTokens +
              usage.outputTokens +
              (usage.cacheReadTokens ?? 0) +
              (usage.cacheWriteTokens ?? 0))
          : reserved
      }
    })
    ctx.tools.guard(exec => {
      if (!allowedTools.includes(exec.name)) return '本次验收只允许转换和文件编辑工具。'
      if (
        exec.name === 'converter_prepare' &&
        (exec.arguments.kind !== 'local' || exec.arguments.path !== seed.source)
      )
        return '只能准备已授权的官方文件侧栏源码。'
      if (['read', 'write', 'edit'].includes(exec.name)) {
        const target = resolve(exec.arguments.file_path)
        const scoped = relative(join(home, 'conversions'), target).split(sep)
        if (!/^[a-f0-9-]{36}$/.test(scoped[0]) || scoped[1] !== 'source' || scoped.length < 3)
          return '只允许访问转换源码副本。'
        const existing = lstatSync(target, { throwIfNoEntry: false })
        if (existing?.isSymbolicLink() || target.includes(`${sep}node_modules${sep}`))
          return '不能通过依赖链接访问其他目录。'
      }
      return undefined
    })
    ctx.on('approval/request', request =>
      request.toolName === 'converter_install' ? 'allowed-once' : 'rejected',
    )
    ctx.on('tools/post-execute', async (exec, result, next) => {
      completedTools.push({ name: exec.name, error: Boolean(result.isError) })
      send({
        type: 'progress',
        message: `工具 ${exec.name}：${result.isError ? '需要修复' : '完成'}`,
      })
      return next()
    })
    agent = await ctx.agentLoop.create(
      sessionId,
      {
        provider: seed.providerId,
        model: seed.model,
        maxTokens: budget.output,
        ...(seed.reasoningEffort ? { reasoningEffort: seed.reasoningEffort } : {}),
      },
      { cwd: join(home, 'project') },
    )
    agent.ctx.tools.restrict({ allow: allowedTools })
    if (seed.setupOnly) {
      send({ type: 'setup-ready' })
      return
    }
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: conversionPrompt(seed.source) }],
        source: { kind: 'user' },
      }),
    )
    await agent.whenIdle()
    for (const required of [
      'converter_prepare',
      'read',
      'write',
      'converter_validate',
      'converter_install',
    ])
      assert(
        completedTools.some(call => call.name === required && !call.error),
        `真实 Agent 未完成 ${required}`,
      )
    const plugin = services.manager.list().find(value => value.id === pluginId)
    assert(plugin?.enabled && plugin.frontend, 'Agent 没有安装目标前端插件')
    const events = agent.session.snapshotEvents()
    assert(
      events.some(
        event => event.type === 'approval/decided' && event.data.outcome === 'allowed-once',
      ),
      '插件安装没有经过正常审批记录',
    )
    send({ type: 'installed', plugin, requests, tokens })
  } catch (error) {
    send({ type: 'failed', error: error.message })
    await stop()
  }
}

function conversionPrompt(source) {
  return `执行一次已授权的真实插件转换。只有6次模型请求预算（含当前请求），尽量把独立工具调用并行。将官方 DSH 文件侧栏 ${source} 转换为 MyDSH 前端插件；你必须亲自读取和重写，不能仅提供说明。先 converter_prepare(kind=local,path=上述绝对路径)，只编辑返回源码副本。读取 src/client/index.ts、src/client/face.ts、package.json 了解原始文件浏览目的。
  已知宿主契约：@mydsh/ui 的 callRemote(endpoint,args):Promise<unknown>、useWorkspaceSnapshot().selectedSessionId:string|null；先用 ctx.mydshSlots.registerIsland({id,label,icon,component,placements:['main'],scope:'session',order?}) 注册中央浮岛，再用 ctx.mydshSlots.registerMode({id,label,icon,mainIslandId,order?}) 注册引用该浮岛的模式，icon/component 都是 React 组件，注册自带 Cordis 清理。共享 React 19 与 @deepseek-ai/cordis，入口 export const inject=['mydshSlots']; export function apply(ctx:Context)。
  请实现中文文件侧栏模式，允许浏览目录并显示加载和错误状态。通过真实 callRemote('workspaceFiles/list',{workspaceFileScopeId:sessionId,path}) 获取 {path:string,entries:{name:string,type:'file'|'directory'|'symlink'|'other'}[],truncated:boolean}。必须 export async function loadDirectory(sessionId:string,path:string)，由该函数实际调用该Remote，主组件复用此函数；不得假造文件或数据。useWorkspaceSnapshot提供当前会话，组件请求取消/过期状态要正确释放。无需后台入口，因为文件服务已有。可将旧UI重写为一个 src/mydsh-client.tsx，保留原始源码供对照。
  package.json 重写为简洁独立包（不能遗留workspace依赖），type:module、name:${pluginId}、version:1.0.0、mydshBuild:{frontend:'src/mydsh-client.tsx',tsconfigFrontend:'tsconfig.frontend.json'}，不需下载任何额外依赖；React/Cordis/@mydsh/ui及其类型由转换器提供。
  mydsh.plugin.json 必须含 id:'${pluginId}',name:'文件侧栏',version:'1.0.0',apiVersion:1,capabilities:['workspace:read']。frontend字段由构建器写入。
  tsconfig.frontend.json 使用 extends:'@mydsh/ui/tsconfig'，include仅新入口，compilerOptions可设skipLibCheck:true（第三方声明）。不得引入@mydsh/sdk后台增补。
  新增源码简体中文注释说明公开接口、异步失效和清理。修改后 converter_validate，失败则读错误修复再次验证。成功必须 converter_install，现有审批通道已授权本次临时安装，然后停止。全部操作只针对本次副本，不可读任何私人配置。总计最多6次模型请求，优先一次写完配置和源码。`
}

if (process.parentPort) await worker()
else
  void main().catch(async error => {
    console.error(error instanceof Error ? error.message : '插件转换验收启动失败')
    const { app } = await import('electron')
    app.exit(1)
  })
