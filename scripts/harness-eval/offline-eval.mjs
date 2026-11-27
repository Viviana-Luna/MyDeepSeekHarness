/**
 * Agent 调度评测离线套件：装载真实 `roster.json` 核心装配表，度量三套预设的一级工具 Schema 降幅，并在真实沙箱 Shell 中端到端验收 `mydsh` 二级 CLI。
 * 运行在 Node / Vitest 进程；所有临时目录与本地套接字均在 finally 中自动清理，不访问网络或真实用户配置。
 */
import { installWorkspacePresetResolver, resolveWorkspaceModuleUrl } from './workspace-resolver.mjs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)
const LEGACY_APP_PERIPHERAL_PREFIX = /^(?:database_|ssh_|browser_|computer_)/u

function estimateTokensFromBytes(bytes) {
  // JSON 工具定义平均约 3.6 UTF-8 字节折合 1 个 BPE Token，用于同口径横向对比。
  return Math.ceil(bytes / 3.6)
}

function registerDatabaseFixtures(scope, defineTool, queries) {
  const jsonOutput = {
    schema: { type: 'json' },
    render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
  }
  scope.tools.register(
    defineTool({
      name: 'database_connections_list',
      description: '列出测试数据库连接。',
      parameters: {},
      output: jsonOutput,
      async execute(_args, exec) {
        scope.mydshConnectionAccess.assertMainAgent(exec.agent)
        return {
          items: [{ connection_id: 'eval-pg', engine: 'postgresql', mode: 'readonly' }],
          truncated: false,
        }
      },
    }),
  )
  scope.tools.register(
    defineTool({
      name: 'database_query',
      description: '执行只读 SQL 查询。',
      parameters: {
        connection_id: { type: 'string', required: true, description: '连接标识。' },
        sql: { type: 'string', required: true, description: '单条或多条 SELECT 语句。' },
      },
      output: jsonOutput,
      async execute(args, exec) {
        scope.mydshConnectionAccess.assertMainAgent(exec.agent)
        queries.push({ connectionId: args.connection_id, sql: args.sql })
        return { rows: [{ ok: 1, echoedSql: args.sql.trim() }] }
      },
    }),
  )
}

function registerScreenshotFixtures(scope, deps) {
  const {
    defineTool,
    AttachmentId,
    renderBrowserScreenshotOutput,
    renderComputerScreenshotOutput,
  } = deps
  scope.tools.register(
    defineTool({
      name: 'browser_screenshot',
      description: '截取当前测试浏览器页面。',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_a, v) => renderBrowserScreenshotOutput(v),
      },
      async execute(_args, exec) {
        scope.mydshConnectionAccess.assertMainAgent(exec.agent)
        const saved = await scope.attachments.saveImage({
          data: ONE_PIXEL_PNG,
          mediaType: 'image/png',
          name: 'eval-shot.png',
        })
        return {
          target: 'embedded',
          tab_id: 'tab-1',
          url: 'https://example.com',
          title: 'Example',
          viewport_width: 1280,
          viewport_height: 800,
          image: {
            attachmentId: AttachmentId(String(saved.attachmentId)),
            mediaType: saved.mediaType,
            bytes: saved.bytes,
            width: saved.width,
            height: saved.height,
          },
        }
      },
    }),
  )
  scope.tools.register(
    defineTool({
      name: 'computer_screenshot',
      description: '截取当前测试桌面窗口。',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_a, v) => renderComputerScreenshotOutput(v),
      },
      async execute(_args, exec) {
        scope.mydshConnectionAccess.assertMainAgent(exec.agent)
        const saved = await scope.attachments.saveImage({
          data: ONE_PIXEL_PNG,
          mediaType: 'image/png',
          name: 'eval-desktop.png',
        })
        return {
          capture_id: 'cap-eval-1',
          scope: 'window',
          display_id: 1,
          logical_origin: { x: 0, y: 0 },
          logical_size: { width: 800, height: 600 },
          target_label: 'Demo App',
          elements_count: 1,
          elements: `@u1 button "Submit"\n${'X'.repeat(9000)}`,
          image: {
            attachmentId: AttachmentId(String(saved.attachmentId)),
            mediaType: saved.mediaType,
            bytes: saved.bytes,
            width: saved.width,
            height: saved.height,
          },
        }
      },
    }),
  )
}

async function mountExecutableCliFixtures(isolated, queries) {
  const [{ defineTool }, { AttachmentId }, browserShot, computerShot] = await Promise.all([
    import(/* @vite-ignore */ resolveWorkspaceModuleUrl('@deepseek-ai/dsh-tools')),
    import(/* @vite-ignore */ resolveWorkspaceModuleUrl('@deepseek-ai/dsh-attachment')),
    import('../../packages/automation/browser/lib/screenshot-output.js'),
    import('../../packages/automation/computer-use/lib/screenshot-output.js'),
  ])
  isolated.plugin({
    name: 'eval-cli-fixtures',
    inject: ['tools', 'mydshConnectionAccess', 'attachments'],
    apply(scope) {
      registerDatabaseFixtures(scope, defineTool, queries)
      registerScreenshotFixtures(scope, {
        defineTool,
        AttachmentId,
        renderBrowserScreenshotOutput: browserShot.renderBrowserScreenshotOutput,
        renderComputerScreenshotOutput: computerShot.renderComputerScreenshotOutput,
      })
    },
  })
}

async function configureEvalRoster(options) {
  const { tempHome, settingsPath, credentialsPath, includeUserRoot, mountExtraTools } = options
  const roster = JSON.parse(await readFile(join(REPO_ROOT, 'packages/runtime/roster.json'), 'utf8'))
  roster.find(row => row.id === 'subprocess').name = 'cordis:mydsh-subprocess'
  roster.find(row => row.name === '@deepseek-ai/dsh-fs-sandbox').name = 'cordis:mydsh-filesystem'
  roster.find(row => row.id === 'settings').config = {
    path: settingsPath ?? join(tempHome, 'config/settings.yaml'),
  }
  roster.find(row => row.id === 'credentials').config = {
    path: credentialsPath ?? join(tempHome, 'config/credentials.yaml'),
  }
  roster.find(row => row.id === 'agent-presets').config = {
    default: 'standard',
    includeShippedRoot: true,
    includeUserRoot: includeUserRoot ?? true,
  }
  roster.find(row => row.id === 'ptc-runtime').config = {
    nodeExecutable: process.execPath,
    bootstrapPath: join(REPO_ROOT, 'packages/ptc-runtime/ptc-runtime-node/lib/process-entry.js'),
  }
  roster.find(row => row.id === 'mydsh-cli-bridge').config = {
    nodeExecutable: process.execPath,
    mountExtraTools,
  }
  return roster
}

async function loadEvalRuntimeModules() {
  const [
    { Context },
    LoaderMod,
    IncludeMod,
    { MydshSubprocessRuntime },
    { privateFileSystem },
    { SandboxedFileSystem },
    { CordisInspectRegistryService },
    { installDirectoryPicker },
    { installPluginTools },
  ] = await Promise.all([
    import(/* @vite-ignore */ resolveWorkspaceModuleUrl('@deepseek-ai/cordis')),
    import(/* @vite-ignore */ resolveWorkspaceModuleUrl('@deepseek-ai/cordis-plugin-loader')),
    import(/* @vite-ignore */ resolveWorkspaceModuleUrl('@deepseek-ai/cordis-plugin-include')),
    import('../../packages/runtime/subprocess.mjs'),
    import('../../packages/runtime/private-files.mjs'),
    import(/* @vite-ignore */ resolveWorkspaceModuleUrl('@deepseek-ai/dsh-fs-sandbox')),
    import(/* @vite-ignore */ resolveWorkspaceModuleUrl('@deepseek-ai/dsh-cordis-host-runner')),
    import('../../packages/runtime/directory-picker.mjs'),
    import('../../packages/runtime/plugin-tools.mjs'),
  ])
  return {
    Context,
    LoaderMod,
    IncludeMod,
    MydshSubprocessRuntime,
    privateFileSystem,
    SandboxedFileSystem,
    CordisInspectRegistryService,
    installDirectoryPicker,
    installPluginTools,
  }
}

/**
 * 装载真实 `roster.json` 启动隔离评测 Runtime 上下文（供离线评测与 `--live` 端到端基准复用）。
 * 调用方必须在结束后调用 `ctx.fiber.dispose()` 释放所有服务与临时套接字。
 */
export async function bootRealRosterForEval(tempHome, options = {}) {
  const {
    settingsPath,
    credentialsPath,
    includeUserRoot = true,
    mountFixtures = true,
    onConverterInstall,
  } = options
  await mkdir(join(tempHome, 'data'), { recursive: true })
  await mkdir(join(tempHome, 'config'), { recursive: true })
  process.env.MYDSH_HOME = tempHome
  process.env.DSH_HOME = join(tempHome, 'data')
  process.env.DSH_TELEMETRY_DISABLED = '1'

  const mods = await loadEvalRuntimeModules()
  const ctx = new mods.Context()
  ctx.baseUrl = new URL('../../package.json', import.meta.url).href
  ctx.provide('dshHomePath', (...parts) => join(tempHome, 'data', ...parts))
  await ctx.plugin(mods.LoaderMod.Loader ?? mods.LoaderMod.default)
  ctx.loader.builtins.include = mods.IncludeMod.default ?? mods.IncludeMod.Include
  ctx.loader.builtins.group = mods.LoaderMod.Group ?? mods.IncludeMod.Group
  ctx.loader.builtins['mydsh-subprocess'] = mods.MydshSubprocessRuntime
  ctx.loader.builtins['mydsh-filesystem'] = mods.privateFileSystem(
    mods.SandboxedFileSystem,
    join(tempHome, 'config'),
  )
  installWorkspacePresetResolver(ctx)

  await ctx.plugin(mods.CordisInspectRegistryService).await()
  await mods.installDirectoryPicker(ctx, async () => null).await()
  ctx.provide('mydshConnectionSystem', {
    token: 'eval-window-token',
    call: async () => ({ connections: [] }),
  })
  ctx.provide('mydshAutomationSystem', {
    call: async () => ({
      embedded: { enabled: false, allowedOrigins: [], blockedOrigins: [] },
      external: { enabled: false, allowedOrigins: [], connected: false },
      takeover: { active: false, kind: null, stepCount: 0 },
    }),
  })

  const queries = []
  const installedIds = []
  const roster = await configureEvalRoster({
    tempHome,
    settingsPath,
    credentialsPath,
    includeUserRoot,
    mountExtraTools: async isolatedScope => {
      await mods
        .installPluginTools(isolatedScope, {
          manager: { list: () => [] },
          converter: {
            list: async () => [],
            install: async id => {
              installedIds.push(id)
              return onConverterInstall ? onConverterInstall(id) : { id, installed: true }
            },
          },
        })
        .await()
      if (mountFixtures) await mountExecutableCliFixtures(isolatedScope, queries)
    },
  })
  await ctx.loader.root.update(roster)
  await ctx.loader.await()
  return { ctx, queries, installedIds }
}

async function measurePresetMetrics(ctx, presetId, legacyAppPeripheralBytes) {
  const handle = await ctx.agents.create({
    sessionId: `eval-measure-${presetId}`,
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash' },
    meta: { cwd: process.env.MYDSH_HOME, agentPreset: presetId },
    setup: async agentCtx => {
      await ctx.agentPresets.mount(agentCtx, presetId)
    },
  })
  try {
    const prompt = await ctx.systemPrompt.assemble({
      scope: handle.agent,
      agent: handle.agent,
    })
    const schemas = prompt.tools
    const schemaBytes = Buffer.byteLength(JSON.stringify(schemas), 'utf8')
    const legacyBytes =
      presetId === 'minimal' ? schemaBytes : schemaBytes + legacyAppPeripheralBytes
    const reduction = legacyBytes > schemaBytes ? (legacyBytes - schemaBytes) / legacyBytes : 0
    return {
      presetId,
      toolCount: schemas.length,
      toolNames: schemas.map(item => item.name).toSorted(),
      schemaBytes,
      estimatedSchemaTokens: estimateTokensFromBytes(schemaBytes),
      legacySchemaBytesWithPeripherals: legacyBytes,
      schemaReductionRatio: Number(reduction.toFixed(4)),
    }
  } finally {
    await handle.dispose()
  }
}

async function assertCatalogParity(hiddenSchemas) {
  const { CLI_DOMAINS } = await import('../../packages/cli/cli-bridge/lib/catalog.js')
  const catalogNames = new Set(CLI_DOMAINS.flatMap(domain => domain.actions.map(a => a.toolName)))
  const registeredNames = new Set(hiddenSchemas.map(item => item.name))
  const ghosts = [...catalogNames].filter(name => !registeredNames.has(name))
  const unmapped = [...registeredNames].filter(name => !catalogNames.has(name))
  if (ghosts.length > 0 || unmapped.length > 0) {
    throw new Error(
      `二级 CLI 目录与隔离工具注册表不一致：幽灵命令=[${ghosts.join(',')}]，未映射工具=[${unmapped.join(',')}]`,
    )
  }
}

async function assertPresetRosterAndAliases(ctx) {
  const roster = await ctx.agentPresets.list()
  const shippedIds = roster.map(item => item.id).toSorted()
  if (shippedIds.join(',') !== 'gpt-coding,minimal,standard') {
    throw new Error(`内置预设清单不符合三预设预期：${shippedIds.join(',')}`)
  }
  for (const preset of roster) {
    if (preset.broken !== undefined) {
      throw new Error(`预设 ${preset.id} 健康检查失败：${preset.broken}`)
    }
  }
  const checks = await Promise.all([
    ctx.agentPresets.resolve('efficiency'),
    ctx.agentPresets.resolve('cordis'),
    ctx.agentPresets.resolve('ptc'),
    ctx.agentPresets.resolve('coding-focused'),
  ])
  const ok =
    checks[0].id === 'minimal' &&
    checks[1].id === 'standard' &&
    checks[2].id === 'standard' &&
    checks[3].id === 'standard'
  if (!ok) throw new Error('已下线预设 ID 未正确映射到现行三预设')
  return true
}

async function registerEvalVisionAdapter(ctx) {
  const { LlmAdapter } = await import(
    /* @vite-ignore */ resolveWorkspaceModuleUrl('@deepseek-ai/dsh-llm')
  )
  class EvalVisionAdapter extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, inputModalities: ['text', 'image'] }
    }
    async *stream() {
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['eval-vision'], new EvalVisionAdapter())
}

async function verifyScreenshotAndApprovalFlows(ctx, runShell, handle, installedIds) {
  const shotRun = await runShell('mydsh browser screenshot')
  if (shotRun.exitCode !== 0) {
    throw new Error(`mydsh browser screenshot 执行失败：${JSON.stringify(shotRun)}`)
  }
  const shotPayload = JSON.parse(shotRun.stdout.text)
  if (!shotPayload.image_path || 'image' in shotPayload) {
    throw new Error(`浏览器截图输出未正确走渲染裁剪或缺少 image_path：${shotRun.stdout.text}`)
  }
  const readImg = await ctx.tools.execute({
    callId: 'eval-read-screenshot',
    name: 'read',
    arguments: { path: shotPayload.image_path },
    agent: handle.agent,
    signal: AbortSignal.timeout(10_000),
  })
  if (readImg.isError || readImg.value?.kind !== 'image') {
    throw new Error(`Agent 通过 read 工具读取截图路径失败：${JSON.stringify(readImg)}`)
  }

  const cuShot = await runShell('mydsh computer screenshot')
  if (
    cuShot.exitCode !== 0 ||
    !cuShot.stdout.text.includes('<<<UNTRUSTED_DESKTOP_UI>>>') ||
    !cuShot.stdout.text.includes('coordinate_hint') ||
    !cuShot.stdout.text.includes('image_path') ||
    cuShot.stdout.text.includes('attachmentId')
  ) {
    throw new Error(`桌面截图输出丢失防注入边界或坐标提示：${JSON.stringify(cuShot)}`)
  }

  // 在真实打开的 turn 内验证插件安装审批：缺参数先被 Schema 拦截、拒绝拦截、同意放行。
  let approvalMode = 'rejected'
  let approvalCalls = 0
  const stopApproval = ctx.on(
    'approval/request',
    (request, next) => {
      if (request.toolName !== 'converter_install') return next()
      approvalCalls += 1
      return approvalMode
    },
    { prepend: true },
  )
  handle.agent.session.append('turn/start', { turn: 1 })
  try {
    const missingArgRun = await runShell('mydsh plugin install')
    if (missingArgRun.exitCode === 0 || approvalCalls !== 0) {
      throw new Error('缺必填参数调用未在审批前被 Schema 预校验拦截')
    }
    const deniedRun = await runShell('mydsh plugin install --id demo-denied')
    if (deniedRun.exitCode === 0 || approvalCalls !== 1 || installedIds.length !== 0) {
      throw new Error(`拒绝审批后仍执行了安装：${JSON.stringify(deniedRun)}`)
    }
    approvalMode = 'allowed-once'
    const allowedRun = await runShell('mydsh plugin install --id demo-ok')
    if (allowedRun.exitCode !== 0 || approvalCalls !== 2 || installedIds[0] !== 'demo-ok') {
      throw new Error(`批准审批后未完成插件安装：${JSON.stringify(allowedRun)}`)
    }
  } finally {
    handle.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    stopApproval()
  }
}

async function verifySandboxCliAndSecurity(ctx, tempHome, queries, installedIds) {
  await registerEvalVisionAdapter(ctx)
  const handle = await ctx.agents.create({
    sessionId: 'eval-cli-roundtrip',
    agentOptions: { provider: 'eval-vision', model: 'vision-probe' },
    meta: { cwd: tempHome, agentPreset: 'standard' },
    setup: async agentCtx => {
      await ctx.agentPresets.mount(agentCtx, 'standard')
    },
  })
  try {
    const shellName = process.platform === 'win32' ? 'powershell' : 'bash'
    const runShell = async (command, agentOverride = handle.agent) => {
      const res = await ctx.tools.execute({
        callId: `eval-call-${Math.random().toString(36).slice(2, 8)}`,
        name: shellName,
        arguments: { command, timeout: 20 },
        agent: agentOverride,
        signal: AbortSignal.timeout(20_000),
      })
      if (res.isError) throw new Error(`Shell 工具执行报错：${JSON.stringify(res)}`)
      return res.value
    }

    const helpRun = await runShell(
      'mydsh --help && mydsh help db query && mydsh browser diagnostics --help && mydsh plugin inspect-list',
    )
    if (
      helpRun.exitCode !== 0 ||
      !helpRun.stdout.text.includes('--connection-id') ||
      !helpRun.stdout.text.includes('browser_diagnostics')
    ) {
      throw new Error(`mydsh 帮助或自省执行失败：${JSON.stringify(helpRun)}`)
    }

    const sqlCmd =
      process.platform === 'win32'
        ? `'SELECT ''quote'', $1 FROM items;' | mydsh db query --connection-id eval-pg --sql-stdin`
        : `cat <<'SQL' | mydsh db query --connection-id eval-pg --sql-stdin\nSELECT 'quote', "$identifier", $1 FROM items;\nSQL`
    const queryRun = await runShell(sqlCmd)
    if (queryRun.exitCode !== 0 || queries.length !== 1 || !queries[0].sql.includes("'quote'")) {
      throw new Error(
        `mydsh --sql-stdin 多行查询失败：${JSON.stringify(queryRun)} | queries=${JSON.stringify(queries)}`,
      )
    }

    await verifyScreenshotAndApprovalFlows(ctx, runShell, handle, installedIds)

    // 安全边界 1：伪造租约必须被拒绝。
    const forgedCmd =
      process.platform === 'win32'
        ? `$env:DSH_MYDSH_LEASE='deadbeef.forged'; mydsh db list`
        : `DSH_MYDSH_LEASE=deadbeef.forged mydsh db list`
    const forgedRun = await runShell(forgedCmd)
    if (forgedRun.exitCode === 0) throw new Error('伪造二级 CLI 租约未被拦截')

    // 安全边界 2：派生子 Agent 会话调用外围受控工具必须被主会话守卫拦截。
    const subHandle = await ctx.agents.create({
      sessionId: 'eval-subagent-session',
      agentOptions: { provider: 'eval-vision', model: 'vision-probe' },
      meta: { cwd: tempHome, agentPreset: 'standard', origin: 'subagent' },
      setup: async agentCtx => {
        await ctx.agentPresets.mount(agentCtx, 'standard')
      },
    })
    try {
      const subRun = await runShell('mydsh db list', subHandle.agent)
      if (subRun.exitCode === 0) {
        throw new Error(`子 Agent 外围工具调用未被拦截：${JSON.stringify(subRun)}`)
      }
    } finally {
      await subHandle.dispose()
    }
  } finally {
    await handle.dispose()
  }
}

/**
 * 运行完整离线 Agent 调度评测：验证三大预设真实挂载、Schema 瘦身比例、沙箱二级 CLI 闭环与主会话安全边界。
 */
export async function runOfflineHarnessEvaluation() {
  const tempHome = await mkdtemp(join(tmpdir(), 'mydsh-eval-'))
  let runtimeCtx
  try {
    const { ctx, queries, installedIds } = await bootRealRosterForEval(tempHome)
    runtimeCtx = ctx
    const hiddenSchemas = ctx.mydshCliBridge.listHiddenSchemas()
    await assertCatalogParity(hiddenSchemas)
    const peripheralBytes = Buffer.byteLength(JSON.stringify(hiddenSchemas), 'utf8')
    const legacyAppSchemas = hiddenSchemas.filter(item =>
      LEGACY_APP_PERIPHERAL_PREFIX.test(item.name),
    )
    const legacyAppPeripheralBytes = Buffer.byteLength(JSON.stringify(legacyAppSchemas), 'utf8')
    const retiredAliasPassed = await assertPresetRosterAndAliases(ctx)

    const presets = []
    for (const presetId of ['standard', 'minimal', 'gpt-coding']) {
      // oxlint-disable-next-line no-await-in-loop -- 顺序挂载真实 Agent 并统计完整系统提示词工具表。
      presets.push(await measurePresetMetrics(ctx, presetId, legacyAppPeripheralBytes))
    }

    await verifySandboxCliAndSecurity(ctx, tempHome, queries, installedIds)
    return {
      platform: process.platform,
      isolatedPeripheralCount: hiddenSchemas.length,
      isolatedPeripheralBytes: peripheralBytes,
      presets,
      cliRoundtripPassed: true,
      securityBoundariesPassed: true,
      retiredAliasPassed,
    }
  } finally {
    if (runtimeCtx) await Promise.resolve(runtimeCtx.fiber.dispose()).catch(() => undefined)
    await rm(tempHome, { recursive: true, force: true }).catch(() => undefined)
  }
}
