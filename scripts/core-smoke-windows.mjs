/* oxlint-disable no-await-in-loop -- 验收按依赖顺序执行，并有界等待进程就绪。 */
/** 仅由隔离验收安装的临时插件，覆盖 Windows 原生执行与清理。 */
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const home = process.env.MYDSH_HOME
const core = process.env.MYDSH_VERIFY_CORE
const quote = value => "'" + value.replaceAll("'", "''") + "'"
const alive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}
async function waitFile(path) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('验收进程没有写入就绪标记')
}
export const inject = [
  'subprocess',
  'sandbox',
  'shell',
  'ptcRuntime',
  'credentials',
  'sessionProjections',
  'agents',
  'agentPresets',
  'systemPrompt',
  'tools',
  'jobs',
]

/** 新模式通过实际作用域、完整工具管线与 Windows 权限执行，不调用模型。 */
async function verifyCodingModes(ctx, workspace) {
  for (const preset of ['minimal', 'standard', 'gpt-coding']) {
    const handle = await ctx.agents.create({
      sessionId: 'mydsh-mode-smoke-' + preset,
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash' },
      meta: { cwd: workspace, agentPreset: preset },
      setup: async agentCtx => {
        await ctx.agentPresets.mount(agentCtx, preset)
      },
    })
    try {
      const agent = handle.agent
      const prompt = await ctx.systemPrompt.assemble({ scope: agent, agent })
      const names = prompt.tools.map(tool => tool.name)
      if (
        preset === 'minimal' &&
        names.toSorted().join(',') !==
          ['read', 'powershell', 'edit', 'write', 'glob', 'grep'].toSorted().join(',')
      )
        throw new Error('极简模式在 Windows 下没有保持六项核心工具：' + names.join(','))
      if (
        preset === 'gpt-coding' &&
        (!['exec_command', 'apply_patch', 'update_plan'].every(name => names.includes(name)) ||
          names.includes('write') ||
          names.includes('edit'))
      )
        throw new Error('ChatGPT 模式工具暴露面不符合 Codex 契约：' + names.join(','))
      const call = async (name, args, errorExpected = false) => {
        const result = await ctx.tools.execute({
          callId: 'mode-' + preset + '-' + name,
          name,
          arguments: args,
          agent,
          signal: AbortSignal.timeout(20000),
        })
        if (Boolean(result.isError) !== errorExpected)
          throw new Error('模式工具验收失败：' + name + ':' + JSON.stringify(result))
        return result.value
      }
      if (preset !== 'gpt-coding') {
        const modeFile = `${preset}-mode.txt`
        await call('write', { path: modeFile, content: 'before\r\nsecond\r\n' })
        await call('read', { path: modeFile })
        await call('edit', {
          path: modeFile,
          edits: [
            { oldText: 'before', newText: 'after' },
            { oldText: 'second', newText: 'checked' },
          ],
        })
        if ((await readFile(join(workspace, modeFile), 'utf8')) !== 'after\r\nchecked\r\n')
          throw new Error('精确批量编辑丢失换行或内容')
        await call(
          'edit',
          { path: modeFile, edits: [{ oldText: 'missing', newText: 'unsafe' }] },
          true,
        )
        const command = await call('powershell', {
          command: "mydsh --help | Out-Null; Write-Output 'pi-mode-ok'",
          timeout: 10,
        })
        if (command.exitCode !== 0 || !command.stdout.text.includes('pi-mode-ok'))
          throw new Error('Shell 或二级 mydsh CLI 执行失败：' + JSON.stringify(command))
      } else {
        await call('apply_patch', {
          patch: '*** Begin Patch\n*** Add File: codex-mode.txt\n+before\n*** End Patch',
        })
        await call('apply_patch', {
          patch:
            '*** Begin Patch\n*** Update File: codex-mode.txt\n@@\n-before\n+after\n*** End Patch',
        })
        if ((await readFile(join(workspace, 'codex-mode.txt'), 'utf8')) !== 'after\n')
          throw new Error('ChatGPT 模式补丁执行失败')
        await call('update_plan', { plan: [{ step: '验证实际工具', status: 'completed' }] })
        const command = await call('exec_command', {
          cmd: "mydsh --help | Out-Null; Write-Output 'codex-mode-ok'",
          yield_time_ms: 10000,
        })
        const job = ctx.jobs.get(command.session_id, agent)
        if (
          command.status !== 'completed' ||
          job.detail !== 'exit code: 0' ||
          !command.output.includes('codex-mode-ok')
        )
          throw new Error('标准模式命令执行失败：' + JSON.stringify({ command, job }))
        const marker = join(workspace, 'codex-cancel.pid')
        const abort = new AbortController()
        const cancelled = ctx.tools.execute({
          callId: 'mode-standard-cancel',
          name: 'exec_command',
          arguments: {
            cmd: `[IO.File]::WriteAllText(${quote(marker)},[string]$PID); Start-Sleep -Seconds 30`,
            yield_time_ms: 20000,
          },
          agent,
          signal: abort.signal,
        })
        try {
          const pid = Number(await waitFile(marker))
          if (!Number.isSafeInteger(pid) || pid <= 1)
            throw new Error('取消验收没有取得所属命令进程')
          abort.abort()
          if (!(await cancelled).isError || alive(pid))
            throw new Error('标准模式命令取消没有等待受管进程退出')
        } finally {
          abort.abort()
          await cancelled
        }
      }
      console.log('编码模式实际验收', JSON.stringify({ preset, tools: names }))
    } finally {
      await handle.dispose()
    }
  }
}
export async function apply(ctx) {
  const pwsh = process.env.MYDSH_PWSH_EXECUTABLE
  const git = process.env.MYDSH_GIT_EXECUTABLE
  const coreBundle = core?.toLowerCase().endsWith('.asar') ? dirname(core) : core
  if (
    !pwsh?.startsWith(coreBundle) ||
    !git?.startsWith(coreBundle) ||
    process.env.ELECTRON_RUN_AS_NODE
  )
    throw new Error('工具入口或后台 Node 模式隔离无效')
  async function run(argv, env = {}, cwd = home) {
    const processHandle = ctx.subprocess.spawn({
      argv,
      cwd,
      env,
      signal: AbortSignal.timeout(20_000),
      graceMs: 500,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    })
    let output = ''
    processHandle.stdout.on('data', data => {
      output += data
    })
    processHandle.stderr.on('data', data => {
      output += data
    })
    try {
      return { ...(await processHandle.done), output }
    } finally {
      processHandle.terminate()
      await processHandle.waitForExit()
    }
  }
  const version = await run([
    pwsh,
    '-NoLogo',
    '-NoProfile',
    '-Command',
    '$PSVersionTable.PSVersion.ToString()',
  ])
  if (version.exitCode !== 0 || !version.output.includes('7.6.6'))
    throw new Error('随包 PowerShell 启动失败：' + version.output)
  if ((await run([git, '--version'])).exitCode !== 0) throw new Error('随包 Git 启动失败')
  const workspace = join(home, "中文 '引号 $ 空格 工作区")
  await mkdir(workspace)
  await verifyCodingModes(ctx, workspace)
  const outside = join(home, 'outside.txt')
  await writeFile(outside, '必须保留')
  async function confined(command, mode = 'workspace-write') {
    const wrapped = await ctx.sandbox.confine(
      [
        pwsh,
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$ErrorActionPreference='Stop';" + command,
      ],
      { mode, workspaceRoot: workspace },
    )
    if (wrapped.enforcement !== 'partial') throw new Error('Windows 不能把部分写限制报告为完整沙箱')
    return run(wrapped.argv, {}, workspace)
  }
  const allowed = await confined("[IO.File]::WriteAllText('成功.txt','中文正常')")
  if (
    allowed.exitCode !== 0 ||
    (await readFile(join(workspace, '成功.txt'), 'utf8')) !== '中文正常'
  )
    throw new Error('ACL runner 或合法工作区写入失败：' + allowed.output)
  for (const command of [
    '[IO.File]::WriteAllText(' + quote(outside) + ",'越界')",
    'Remove-Item -LiteralPath ' + quote(outside) + ' -Force',
    'Move-Item -LiteralPath ' + quote(outside) + " -Destination '越界.txt'",
  ]) {
    if (
      (await confined(command)).exitCode === 0 ||
      (await readFile(outside, 'utf8')) !== '必须保留'
    )
      throw new Error('ACL 没有阻止工作区外的写入、删除或移动')
  }
  if ((await confined("[IO.File]::WriteAllText('禁止.txt','禁止')", 'read-only')).exitCode === 0)
    throw new Error('只读沙箱没有阻止写入')
  const shell = await ctx.shell.run(
    ctx.shell.resolve({
      command: "[IO.File]::WriteAllText('shell.txt','正常')",
      workdir: workspace,
      timeoutMs: 10_000,
      sandboxPolicy: { mode: 'workspace-write', workspaceRoot: workspace },
    }),
  )
  if (shell.exitCode !== 0) throw new Error('Agent PowerShell 执行失败：' + JSON.stringify(shell))
  const ptc = await ctx.ptcRuntime.run(
    ctx.ptcRuntime.resolve({
      program: 'return 6 * 7',
      bindings: [],
      cwd: workspace,
      timeoutMs: 15_000,
      sandboxPolicy: { mode: 'workspace-write', workspaceRoot: workspace },
    }),
  )
  if (ptc.error || ptc.value !== 42)
    throw new Error('PTC 内部 Node 执行失败：' + JSON.stringify(ptc))
  await ctx.credentials.set('MYDSH_VERIFICATION_KEY', '仅供临时验收')
  await ctx.credentials.set('MYDSH_VERIFICATION_KEY', '原子替换验收')
  const credential = join(home, 'config/credentials.yaml')
  const acl = await run([
    pwsh,
    '-NoProfile',
    '-Command',
    '$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; foreach($p in @(' +
      quote(join(home, 'config')) +
      ',' +
      quote(credential) +
      ')){ $a=Get-Acl -LiteralPath $p; foreach($r in $a.Access){$s=$r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;if($s -ne $sid -and $s -ne "S-1-5-18"){throw "凭据存在额外授权"}} }; "private-acl-ok"',
  ])
  if (acl.exitCode !== 0 || !acl.output.includes('private-acl-ok'))
    throw new Error('凭据原子替换后的 ACL 不正确')
  await ctx.credentials.unset('MYDSH_VERIFICATION_KEY')
  const ordinaryPid = join(home, 'ordinary-child.pid')
  const program =
    "const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{env:process.env,stdio:'ignore',windowsHide:true});require('node:fs').writeFileSync(process.argv[1],String(c.pid));setInterval(()=>{},1000)"
  const job = ctx.subprocess.spawn({
    argv: [process.env.MYDSH_NODE_EXECUTABLE, '-e', program, ordinaryPid],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    cwd: home,
    graceMs: 500,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  })
  job.stdout.resume()
  job.stderr.resume()
  let ordinaryChild
  try {
    ordinaryChild = Number(await waitFile(ordinaryPid))
  } finally {
    job.terminate()
    await job.done
    await job.waitForExit()
  }
  if (alive(ordinaryChild)) throw new Error('Windows Job 未清理普通命令的后代')
  const finite = await ctx.subprocess.spawnTerminal({
    argv: [pwsh, '-NoLogo', '-NoProfile', '-Command', "Write-Output '有限任务正常'; exit 7"],
    cwd: workspace,
    rows: 24,
    cols: 80,
    terminalType: 'xterm-256color',
    graceMs: 500,
  })
  let finiteOutput = ''
  finite.output.on('data', data => {
    finiteOutput += data
  })
  try {
    if ((await finite.done).exitCode !== 7 || !finiteOutput.includes('有限任务正常'))
      throw new Error('有限终端丢失输出或退出状态')
  } finally {
    await finite.terminate()
  }
  // 直接使用随包后端和真实 ACL，仅以固定策略替代模型预设配置。
  const { BashTerminalBackend } = await import(
    pathToFileURL(join(core, 'node_modules/@deepseek-ai/dsh-terminal-bash/lib/index.js')).href
  )
  let persistentOutput = ''
  let persistentExit
  const persistentBackend = new BashTerminalBackend(
    {
      subprocess: ctx.subprocess,
      sandbox: ctx.sandbox,
      get: name => ctx.get(name),
      sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: workspace }) },
      terminals: { hasOwnerActivity: () => true },
      sessionProjections: ctx.sessionProjections,
    },
    {
      backendType: 'shell',
      shellDialect: 'pwsh',
      shellPath: pwsh,
      shellArgs: ['-NoLogo', '-NoProfile'],
      rows: 24,
      cols: 100,
      scrollbackLines: 100,
      scrollbackMaxBytes: 32_768,
      maxReadBytes: 16_384,
      pollIntervalMs: 50,
      exactProbeAfterMs: 150,
      idleSilenceMs: 500,
      handoffGraceMs: 500,
      timeoutMs: 15_000,
      disposeGraceMs: 1_000,
    },
    async spec => {
      const handle = await ctx.subprocess.spawnTerminal(spec)
      void handle.done.then(outcome => {
        persistentExit = outcome
      })
      handle.output.on('data', data => {
        persistentOutput = (persistentOutput + data).slice(-4000)
      })
      return handle
    },
  )
  const persistent = await persistentBackend
    .spawn({
      type: 'shell',
      sessionId: 'mydsh-native-smoke',
      owner: { id: 'mydsh-native-smoke', ctx, session: {} },
      cwd: workspace,
    })
    .catch(cause => {
      throw new Error(
        '持久终端启动失败：' + JSON.stringify(persistentExit) + ':' + persistentOutput,
        { cause },
      )
    })
  try {
    await persistent.startSend({ text: '$env:MYDSH_PERSISTENT_SMOKE="跨命令保留"', submit: true })
      .done
    const second = await persistent.startSend({
      text: 'Write-Output ("PERSISTENT:" + $env:MYDSH_PERSISTENT_SMOKE)',
      submit: true,
    }).done
    if (!second.viewport.includes('PERSISTENT:跨命令保留'))
      throw new Error('持久 PowerShell 没有保留变量：' + JSON.stringify(second))
  } finally {
    await persistent.close('验收结束')
  }
  const descendant = join(home, 'owned-descendant.pid')
  const command =
    '$child=Start-Process -FilePath ' +
    quote(pwsh) +
    ' -ArgumentList "-NoProfile","-Command","Start-Sleep 90" -WindowStyle Hidden -PassThru; [IO.File]::WriteAllText(' +
    quote(descendant) +
    ',[string]$child.Id); Start-Sleep 90'
  const terminal = await ctx.subprocess.spawnTerminal({
    argv: [pwsh, '-NoLogo', '-NoProfile', '-Command', command],
    cwd: home,
    rows: 24,
    cols: 80,
    terminalType: 'xterm-256color',
    graceMs: 1_000,
  })
  terminal.output.resume()
  await waitFile(descendant)
  await writeFile(join(home, 'owned.pid'), String(terminal.pid))
  await access(join(core, 'node_modules/koffi/src/koffi/index.cjs'))
  await writeFile(
    join(home, 'native-result.json'),
    JSON.stringify({
      powershell: version.output.trim(),
      acl: 'partial',
      ptc: ptc.value,
      credentials: 'private',
      persistentShell: 'passed',
      finiteTerminal: 'passed',
      ordinaryDescendants: 'stopped',
    }),
  )
}
