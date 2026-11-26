/** 验证 SSH Agent 工具在真实 ssh2 服务端（exec + SFTP）上的完整读写、确认卡、脱敏与退出释放链路。 */
/* oxlint-disable no-await-in-loop -- Cordis 插件注册与测试夹具销毁需按依赖顺序串行执行。 */
import { createRequire } from 'node:module'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { LlmRuntime } from '../packages/llm/llm/lib/index.js'
import SessionStore from '../packages/core/session/lib/index.js'
import Projections from '../packages/session/session-projection/lib/index.js'
import SystemPrompt from '../packages/core/system-prompt/lib/index.js'
import Tools from '../packages/core/tools/lib/index.js'
import Agents from '../packages/core/agent/lib/index.js'
import AgentLoop from '../packages/core/agent-loop/lib/index.js'
import UserQuestions from '../packages/interaction/user-questions/lib/index.js'
import * as Spill from '../packages/spill/spill-policy/lib/index.js'
import { LocalCredentialProvider } from '../packages/credentials/credentials-local/lib/index.js'
import { ConnectionAccess } from '../packages/connections/access/lib/index.js'
import { SshConnections } from '../packages/connections/ssh/lib/index.js'
import * as SshTools from '../packages/connections/ssh/lib/tools.js'
import { openCredential, sealCredential } from '../src/main/connections/credential-envelope.ts'
import { attachSftpSubsystem } from './ssh-sftp-stub.mjs'

const { Server, utils } = createRequire(
  new URL('../packages/connections/ssh/package.json', import.meta.url),
)('ssh2')

const TOKEN = 'ssh-agent-window-token'
const PASSWORD = 'SSH-Agent-Super-Secret-Password-999'

const cleanups = []
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()
    await fn()
  }
})

async function createSshAgentFixture() {
  const workDir = realpathSync(await mkdtemp(join(tmpdir(), 'mydsh-ssh-agent-')))
  const remoteRoot = join(workDir, 'remote')
  const allowedDir = join(remoteRoot, 'app')
  const outsideDir = join(remoteRoot, 'secret')
  mkdirSync(allowedDir, { recursive: true })
  mkdirSync(outsideDir, { recursive: true })
  writeFileSync(join(allowedDir, 'config.env'), 'PORT=3000\nMODE=dev\nHOST=127.0.0.1\n')
  writeFileSync(join(allowedDir, 'binary.bin'), Buffer.from([0x7f, 0x45, 0x00, 0x46]))
  writeFileSync(join(outsideDir, 'private.txt'), 'TOP-SECRET\n')
  // Windows 非开发者模式无法创建文件符号链接，使用目录联接同样验证 SFTP realpath 越权拦截。
  if (process.platform === 'win32') {
    symlinkSync(outsideDir, join(allowedDir, 'escape-dir'), 'junction')
  } else {
    symlinkSync(join(outsideDir, 'private.txt'), join(allowedDir, 'escape-link.txt'))
  }

  const peers = new Set()
  const executedCommands = []
  const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    type: 'pkcs1',
    format: 'pem',
  })
  const server = new Server({ hostKeys: [hostKey] }, peer => {
    peers.add(peer)
    peer.on('error', () => {})
    peer.once('close', () => peers.delete(peer))
    peer.on('authentication', auth =>
      auth.method === 'password' && auth.password === PASSWORD ? auth.accept() : auth.reject(),
    )
    peer.on('ready', () => {
      peer.on('session', acceptSession => {
        const session = acceptSession()
        attachSftpSubsystem(session, allowedDir, remoteRoot, utils.sftp)
        session.on('exec', (accept, _reject, info) => {
          const stream = accept()
          executedCommands.push(info.command)
          if (info.command.includes('sleep 5')) {
            stream.write('starting-slow-task\n')
            const timer = setTimeout(() => {
              stream.exit(0)
              stream.end()
            }, 5000)
            stream.once('close', () => clearTimeout(timer))
            return
          }
          if (info.command.includes('leak-secret')) {
            stream.write(`echoed:${PASSWORD}\n`)
            stream.stderr.write(`err:${PASSWORD}\n`)
            stream.exit(0)
            stream.end()
            return
          }
          stream.write(`RAN:${info.command}\n`)
          stream.exit(0)
          stream.end()
        })
      })
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port

  const ctx = new Context()
  const keyMap = new Map()
  const storage = {
    isEncryptionAvailable: () => true,
    encryptString: value => {
      const id = randomUUID()
      keyMap.set(id, value)
      return Buffer.from(id)
    },
    decryptString: value => {
      const plain = keyMap.get(value.toString())
      if (!plain) throw new Error('解密失败')
      return plain
    },
  }
  for (const plugin of [
    LlmRuntime,
    SessionStore,
    Projections,
    SystemPrompt,
    Tools,
    Agents,
    UserQuestions,
  ]) {
    await ctx.plugin(plugin).await()
  }
  await ctx.plugin(AgentLoop, { agents: [] }).await()
  ctx.provide('spillStore', { saveText: vi.fn(async () => ({ id: 's1', uri: 'spill://s1' })) })
  await ctx.plugin(Spill, { maxInlineBytes: 50_000 }).await()
  const archived = []
  ctx.provide('workspaceRegistry', { archivedSessionIds: archived })
  ctx.provide('sessionController', {
    inspect: async id => {
      const meta = ctx.sessions.get(id)?.header
      if (!meta) throw new Error('会话不存在')
      return { meta, events: [], inheritedEventCount: 0 }
    },
  })
  await ctx
    .plugin({
      name: 'fixture-connection-system',
      apply(scope) {
        scope.provide('mydshConnectionSystem', {
          token: TOKEN,
          call: async (method, payload) =>
            method === 'ssh.seal'
              ? sealCredential(payload.secret, payload, storage)
              : openCredential(payload.envelope, payload, storage),
        })
      },
    })
    .await()
  await ctx
    .plugin(LocalCredentialProvider, { path: join(workDir, 'credentials.yaml'), watch: false })
    .await()
  await ctx.plugin(SshConnections).await()
  await ctx.plugin(ConnectionAccess).await()

  const prompts = []
  let decision = 'allow-once'
  let promptHook = null
  ctx.on('user-questions/request', async request => {
    prompts.push(request)
    if (promptHook) return promptHook(request)
    const q = request.questions[0]
    if (decision === 'deny') return { answers: [{ id: q.id, selected: ['拒绝'] }] }
    if (decision === 'session') {
      const sessionOpt = q.options.find(item => item.label.includes('本次会话'))
      return { answers: [{ id: q.id, selected: [(sessionOpt ?? q.options[0]).label] }] }
    }
    return { answers: [{ id: q.id, selected: [q.options[0].label] }] }
  })

  const saveAndTrust = async (name, agentAccess) => {
    const saved = await ctx.mydshSsh.save(TOKEN, {
      id: null,
      revision: null,
      name,
      host: '127.0.0.1',
      port,
      username: 'ops',
      auth: 'password',
      environment: '测试',
      projectId: null,
      disabled: false,
      password: PASSWORD,
      agentAccess,
    })
    const probe = await ctx.mydshSsh.connect(
      TOKEN,
      saved.id,
      true,
      80,
      24,
      AbortSignal.timeout(5000),
    )
    return ctx.mydshSsh.trustHost(TOKEN, saved.id, probe.revision, probe.fingerprint)
  }

  const createAgent = async (sessionId = `ssh-session-${randomUUID()}`, meta = {}) =>
    ctx.agentLoop.createAgent(ctx, {
      sessionId,
      meta: { cwd: workDir, ...meta },
      agentOptions: { provider: 'fixture', model: 'synthetic' },
      setup: async agentCtx => {
        await agentCtx.plugin(SshTools).await()
      },
    })

  const handle = await createAgent()
  const runTool = (name, args = {}, agent = handle.agent, signal = AbortSignal.timeout(5000)) =>
    ctx.tools.execute({ name, callId: randomUUID(), agent, signal, arguments: args })

  cleanups.push(async () => {
    try {
      await ctx.fiber.dispose()
      await vi.waitFor(() => expect(peers.size).toBe(0))
    } finally {
      for (const peer of peers) peer.end()
      await new Promise(resolve => server.close(resolve))
      await rm(workDir, { recursive: true, force: true })
    }
  })

  return {
    ctx,
    allowedDir,
    outsideDir,
    remoteAllowedDir: '/app',
    remoteOutsideDir: '/secret',
    peers,
    executedCommands,
    prompts,
    archived,
    handle,
    saveAndTrust,
    createAgent,
    runTool,
    setDecision: next => {
      decision = next
    },
    setPromptHook: fn => {
      promptHook = fn
    },
  }
}

function expectToolError(result, pattern) {
  expect(result.isError).toBe(true)
  expect(result.error?.message ?? result.content?.[0]?.text ?? '').toMatch(pattern)
}

it('仅列出已开放且已确认指纹的 SSH 连接，未确认指纹或未开放时明确拒绝', async () => {
  const f = await createSshAgentFixture()
  const untrusted = await f.ctx.mydshSsh.save(TOKEN, {
    id: null,
    revision: null,
    name: '未确认指纹主机',
    host: '127.0.0.1',
    port: 22,
    username: 'ops',
    auth: 'password',
    environment: '测试',
    projectId: null,
    disabled: false,
    password: PASSWORD,
    agentAccess: { enabled: true, mode: 'readonly', allowSudo: false, allowedPaths: [] },
  })
  const closed = await f.saveAndTrust('关闭访问主机', {
    enabled: false,
    mode: 'readonly',
    allowSudo: false,
    allowedPaths: [],
  })
  const open = await f.saveAndTrust('可用巡检主机', {
    enabled: true,
    mode: 'standard',
    allowSudo: false,
    allowedPaths: [f.remoteAllowedDir],
  })

  const listed = await f.runTool('ssh_connections_list', {})
  expect(listed.isError, listed.error?.message).toBe(false)
  expect(listed.value.items).toHaveLength(1)
  expect(listed.value.items[0].connection_id).toBe(open.id)
  expect(JSON.stringify(listed.value)).not.toContain(PASSWORD)

  expectToolError(
    await f.runTool('ssh_list_dir', { connection_id: untrusted.id }),
    /HOST_UNTRUSTED/u,
  )
  expectToolError(
    await f.runTool('ssh_list_dir', { connection_id: closed.id }),
    /PERMISSION_DENIED/u,
  )
})

it('通过 SFTP 浏览与读取远端文件，拦截目录越权、软链逃逸和二进制文件', async () => {
  const f = await createSshAgentFixture()
  const host = await f.saveAndTrust('SFTP 主机', {
    enabled: true,
    mode: 'readonly',
    allowSudo: false,
    allowedPaths: [f.remoteAllowedDir],
  })

  const dir = await f.runTool('ssh_list_dir', { connection_id: host.id })
  expect(dir.isError, dir.error?.message).toBe(false)
  expect(dir.value.directory).toBe(f.remoteAllowedDir)
  expect(dir.value.items.map(item => item.name)).toContain('config.env')

  const file = await f.runTool('ssh_read_file', {
    connection_id: host.id,
    path: posix.join(f.remoteAllowedDir, 'config.env'),
    offset_line: 1,
    limit_lines: 2,
  })
  expect(file.isError, file.error?.message).toBe(false)
  expect(file.value.content).toBe('PORT=3000\nMODE=dev')
  expect(file.value.truncated).toBe(true)

  expectToolError(
    await f.runTool('ssh_read_file', {
      connection_id: host.id,
      path: posix.join(f.remoteAllowedDir, 'binary.bin'),
    }),
    /BINARY_FILE/u,
  )

  expectToolError(
    await f.runTool('ssh_read_file', {
      connection_id: host.id,
      path: posix.join(f.remoteOutsideDir, 'private.txt'),
    }),
    /PERMISSION_DENIED/u,
  )

  expectToolError(
    await f.runTool('ssh_read_file', {
      connection_id: host.id,
      path:
        process.platform === 'win32'
          ? posix.join(f.remoteAllowedDir, 'escape-dir', 'private.txt')
          : posix.join(f.remoteAllowedDir, 'escape-link.txt'),
    }),
    /PERMISSION_DENIED/u,
  )
})

it('SFTP 写入生成 Unified Diff 确认卡，支持拒绝、原子落盘与审批期间并发冲突检测', async () => {
  const f = await createSshAgentFixture()
  const host = await f.saveAndTrust('写入测试主机', {
    enabled: true,
    mode: 'standard',
    allowSudo: false,
    allowedPaths: [f.remoteAllowedDir],
  })
  const remoteEnvPath = posix.join(f.remoteAllowedDir, 'config.env')
  const localEnvPath = join(f.allowedDir, 'config.env')

  f.setDecision('deny')
  expectToolError(
    await f.runTool('ssh_write_file', {
      connection_id: host.id,
      path: remoteEnvPath,
      mode: 'replace',
      old_text: 'PORT=3000',
      new_text: 'PORT=8080',
    }),
    /USER_REJECTED/u,
  )
  expect(f.prompts[0].questions[0].id).toBe(`mydsh-ssh-consent:${host.id}`)
  expect(f.prompts[0].questions[0].detail).toContain('MYDSH_SSH_PREVIEW_V1:')
  expect(f.prompts[0].questions[0].detail).toContain('-PORT=3000')
  expect(f.prompts[0].questions[0].detail).toContain('+PORT=8080')
  expect(readFileSync(localEnvPath, 'utf8')).toContain('PORT=3000')

  f.setDecision('allow-once')
  const written = await f.runTool('ssh_write_file', {
    connection_id: host.id,
    path: remoteEnvPath,
    mode: 'replace',
    old_text: 'PORT=3000',
    new_text: 'PORT=8080',
  })
  expect(written.isError, written.error?.message).toBe(false)
  expect(written.value.authorization).toBe('approved-once')
  expect(written.value.added_lines).toBe(1)
  expect(written.value.removed_lines).toBe(1)
  expect(readFileSync(localEnvPath, 'utf8')).toContain('PORT=8080')

  // 模拟用户在确认卡停留期间外部进程修改了目标文件，落盘前必须检测 mtime 冲突。
  f.setPromptHook(async req => {
    writeFileSync(localEnvPath, 'PORT=9999\nMODE=external\n')
    const bumped = new Date(Date.now() + 10_000)
    utimesSync(localEnvPath, bumped, bumped)
    return { answers: [{ id: req.questions[0].id, selected: [req.questions[0].options[0].label] }] }
  })
  expectToolError(
    await f.runTool('ssh_write_file', {
      connection_id: host.id,
      path: remoteEnvPath,
      mode: 'replace',
      old_text: 'PORT=8080',
      new_text: 'PORT=7070',
    }),
    /FILE_CONFLICT/u,
  )
  expect(readFileSync(localEnvPath, 'utf8')).toContain('PORT=9999')
})

it('ssh_exec 自动放行只读、支持会话复用、强制单次确认高危与 sudo、硬拦截灾难命令并脱敏输出', async () => {
  const f = await createSshAgentFixture()
  const host = await f.saveAndTrust('运维主机', {
    enabled: true,
    mode: 'standard',
    allowSudo: false,
    allowedPaths: [f.remoteAllowedDir],
  })

  // 1. 只读命令免确认直接执行
  const readonly = await f.runTool('ssh_exec', {
    connection_id: host.id,
    command: 'ls -la',
  })
  expect(readonly.isError, readonly.error?.message).toBe(false)
  expect(readonly.value.authorization).toBe('readonly-allowed')
  expect(readonly.value.category).toBe('readonly')
  expect(f.prompts).toHaveLength(0)

  // 2. 灾难命令直接硬拦截且不发起远端执行
  expectToolError(
    await f.runTool('ssh_exec', { connection_id: host.id, command: 'rm -rf /' }),
    /PERMISSION_DENIED/u,
  )
  expect(f.prompts).toHaveLength(0)

  // 3. 常规变更命令请求会话授权并在第二次自动复用
  f.setDecision('session')
  const firstMutate = await f.runTool('ssh_exec', {
    connection_id: host.id,
    command: 'npm run build',
  })
  expect(firstMutate.isError, firstMutate.error?.message).toBe(false)
  expect(firstMutate.value.authorization).toBe('approved-session')
  expect(f.prompts).toHaveLength(1)

  const secondMutate = await f.runTool('ssh_exec', {
    connection_id: host.id,
    command: 'npm run lint',
  })
  expect(secondMutate.isError, secondMutate.error?.message).toBe(false)
  expect(secondMutate.value.authorization).toBe('session-reused')
  expect(f.prompts).toHaveLength(1)

  // 4. sudo 与高危命令即使已有会话授权，也强制单次确认且不提供会话复用按钮
  const sudoResult = await f.runTool('ssh_exec', {
    connection_id: host.id,
    command: 'sudo systemctl restart nginx',
  })
  expect(sudoResult.isError, sudoResult.error?.message).toBe(false)
  expect(sudoResult.value.authorization).toBe('elevated-once')
  expect(f.prompts).toHaveLength(2)
  const sudoOptions = f.prompts[1].questions[0].options.map(item => item.label)
  expect(sudoOptions.some(label => label.includes('本次会话'))).toBe(false)

  // 5. 输出脱敏与超时返回
  const leaked = await f.runTool('ssh_exec', {
    connection_id: host.id,
    command: 'echo leak-secret',
  })
  expect(leaked.isError, leaked.error?.message).toBe(false)
  expect(leaked.value.stdout).toContain('[已隐藏]')
  expect(leaked.value.stdout).not.toContain(PASSWORD)
  expect(leaked.value.stderr).not.toContain(PASSWORD)

  const timedOut = await f.runTool('ssh_exec', {
    connection_id: host.id,
    command: 'sleep 5',
    timeout_ms: 1000,
  })
  expect(timedOut.isError, timedOut.error?.message).toBe(false)
  expect(timedOut.value.timed_out).toBe(true)
  expect(timedOut.value.stdout).toContain('starting-slow-task')

  // 6. 子 Agent 与已归档会话被 ConnectionAccess 拒绝
  const subagent = await f.createAgent('sub-agent-1', { origin: 'subagent' })
  expectToolError(await f.runTool('ssh_connections_list', {}, subagent.agent), /NOT_AUTHORIZED/u)

  // 7. 重置主机指纹立即撤销会话授权并关闭池化连接
  await f.ctx.mydshSsh.resetHost(TOKEN, host.id, host.revision)
  await vi.waitFor(() => expect(f.peers.size).toBe(0))
  expectToolError(
    await f.runTool('ssh_exec', { connection_id: host.id, command: 'ls' }),
    /HOST_UNTRUSTED/u,
  )
})
