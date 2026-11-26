import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { LlmAdapter, LlmRuntime, createUserMessage } from '../packages/llm/llm/lib/index.js'
import SessionStore from '../packages/core/session/lib/index.js'
import Projections from '../packages/session/session-projection/lib/index.js'
import SystemPrompt from '../packages/core/system-prompt/lib/index.js'
import { ToolRuntime, defineTool } from '../packages/core/tools/lib/index.js'
import ApprovalService from '../packages/interaction/user-approval/lib/index.js'
import Permissions from '../packages/interaction/permission-presets/lib/index.js'
import SandboxPolicy from '../packages/sandbox/sandbox-policy/lib/index.js'
import { approveEscalation } from '../packages/sandbox/sandbox/lib/index.js'
import * as Review from '../packages/interaction/auto-review/lib/index.js'

const contexts = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})
const allow = {
  decision: 'allow',
  risk: 'low',
  authorization: 'high',
  bounded: true,
  violatesConstraint: false,
  requiresHuman: false,
  authorizationIds: [],
  rationale: '用户明确要求创建有限的任务缓存',
}
const marker = '[sandbox: file access denied under workspace-write mode]'
const command = 'mkdir -p /tmp/mydsh-review-cache'
class Shell extends Service {
  constructor(ctx) {
    super(ctx, 'shell')
    this.sandboxMode = 'workspace-write'
  }
}
async function fixture({ answer = allow, timeoutMs = 1000, stream, toolName = 'bash' } = {}) {
  const ctx = new Context(),
    calls = [],
    executions = [],
    audit = [],
    events = []
  contexts.push(ctx)
  // 按共享服务依赖顺序装配，使用真实审批、预设、工具运行时和投影服务。
  for (const plugin of [
    SystemPrompt,
    SessionStore,
    Projections,
    LlmRuntime,
    ToolRuntime,
    Shell,
    ApprovalService,
    SandboxPolicy,
  ]) {
    // oxlint-disable-next-line no-await-in-loop
    await ctx.plugin(plugin).await()
  }
  await ctx
    .plugin(Permissions, {
      defaultPreset: 'workspace-write',
      presets: {
        'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
        'auto-review': { sandbox: 'workspace-write', approval: 'ask' },
        'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
      },
    })
    .await()
  class Adapter extends LlmAdapter {
    async *stream(options) {
      calls.push(options)
      if (stream) {
        yield* stream(options)
        return
      }
      const human = JSON.parse(options.messages[0].content[0].text).context.find(
        entry => entry.role === 'human',
      )
      yield {
        type: 'text-delta',
        index: 0,
        text:
          typeof answer === 'string'
            ? answer
            : JSON.stringify({ ...answer, authorizationIds: [human.id] }),
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['fixture'], new Adapter())
  const manual = vi.fn(async () => 'rejected')
  ctx.on('approval/request', manual)
  const plugin = ctx.plugin(Review, { timeoutMs })
  await plugin.await()
  ctx.on('session/event', (_session, event) => {
    events.push(event)
  })
  const session = ctx.sessions.create('review-session', { meta: { cwd: '/tmp' } })
  const agent = {
    id: session.id,
    session,
    ctx,
    options: { provider: 'fixture', model: 'review-model' },
  }
  ctx.permissionPresets.set(session, 'auto-review')
  session.append('turn/start', { turn: 1 })
  session.append(
    'user/message',
    createUserMessage({
      content: [{ type: 'text', text: '为当前任务创建可丢弃的缓存目录。不要删除文件或安装软件。' }],
      source: { kind: 'user' },
    }),
    { surfaceOp: 'append' },
  )
  ctx.on('session/event', (_session, event) => {
    if (event.type.startsWith('approval/')) audit.push(event)
  })
  ctx.tools.register(
    defineTool({
      name: toolName,
      description: '隔离的沙箱执行夹具',
      parameters: {
        command: { type: 'string' },
        cmd: { type: 'string' },
        sandbox_permissions: { type: 'string' },
        justification: { type: 'string' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        if (!args.sandbox_permissions) {
          if (toolName === 'exec_command') {
            ctx.emit('tools/background-sandbox', exec, {
              denied: true,
              mode: 'workspace-write',
              runnerFailed: false,
            })
            return { session_id: 'bash-fixture', output: marker }
          }
          return { sandbox: { denied: true, mode: 'workspace-write' } }
        }
        const mode = await approveEscalation(
          {
            requestedMode: args.sandbox_permissions,
            justification: args.justification,
            effectiveMode: 'workspace-write',
            subject: 'command',
          },
          {
            approver: ctx.approval,
            agent: exec.agent,
            callId: exec.callId,
            toolName: 'bash',
            signal: exec.signal,
          },
        )
        executions.push({ args, mode })
        return { executed: true }
      },
    }),
  )
  let serial = 0
  const base = toolName === 'exec_command' ? { cmd: command } : { command }
  const run = (args = base, signal = new AbortController().signal, owner = agent) =>
    ctx.tools.execute({
      callId: `call-${++serial}`,
      name: toolName,
      arguments: args,
      agent: owner,
      signal,
    })
  const retry = (args = {}, signal) =>
    run(
      {
        ...base,
        sandbox_permissions: 'danger-full-access',
        justification: '创建当前任务的缓存目录',
        ...args,
      },
      signal,
    )
  return { ctx, session, agent, plugin, calls, manual, executions, audit, events, run, retry, base }
}

it('低风险提权仅放行一次，保留工作区沙箱和人工审批策略，并记录实际调用摘要', async () => {
  const f = await fixture()
  await f.run()
  expect((await f.retry()).isError).toBe(false)
  expect(f.executions).toHaveLength(1)
  expect(f.manual).not.toHaveBeenCalled()
  expect(f.ctx.sandboxPolicy.resolve({ session: f.session }).mode).toBe('workspace-write')
  expect(f.ctx.approval.overrideOf(f.session)).toBe('ask')
  expect(f.ctx.permissionPresets.current(f.session)).toBe('auto-review')
  expect(f.calls[0]).toMatchObject({
    provider: 'fixture',
    model: 'review-model',
    purpose: 'approval-review',
  })
  expect(f.calls[0].tools.map(tool => tool.name)).toEqual([
    'stat_path',
    'list_directory',
    'read_text',
  ])
  const input = JSON.parse(f.calls[0].messages[0].content[0].text)
  expect(input.action.arguments).toEqual({ command })
  expect(input.context.find(entry => entry.role === 'human').text).toContain('不要删除文件')
  expect(f.audit.find(event => event.type === 'approval/reviewed').data).toMatchObject({
    decision: 'allowed-once',
    inputHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
  })
  expect(f.audit.findLast(event => event.type === 'approval/decided').data.outcome).toBe(
    'allowed-once',
  )
  expect((await f.retry()).isError).toBe(true)
  expect(f.calls).toHaveLength(1)
  expect(f.manual).toHaveBeenCalledTimes(1)
})

it.each([
  { answer: { ...allow, decision: 'ask', risk: 'high' }, decision: 'manual' },
  { answer: { ...allow, risk: 'medium' }, decision: 'manual' },
  { answer: { ...allow, authorization: 'unknown' }, decision: 'manual' },
  { answer: { ...allow, extra: true }, decision: 'failed' },
  {
    answer: '```json\n{"decision":"allow","risk":"low","authorized":true}\n```',
    decision: 'failed',
  },
  { answer: '不是 JSON', decision: 'failed' },
])('风险需要人工、审核无效则停止，两者都不自动执行：%j', async ({ answer, decision }) => {
  const f = await fixture({ answer })
  await f.run()
  await f.retry()
  expect(f.executions).toHaveLength(0)
  expect(f.manual).toHaveBeenCalledTimes(decision === 'manual' ? 1 : 0)
  expect(f.audit.find(event => event.type === 'approval/reviewed').data.decision).toBe(decision)
})

it('没有真实执行上下文、没有拒绝记录或命令变化时不调用审核模型', async () => {
  const f = await fixture()
  await f.retry()
  await f.run()
  await f.retry({ command: 'rm -rf /tmp/mydsh-review-cache' })
  await f.ctx.approval.request({
    agent: f.agent,
    toolName: 'bash',
    callId: 'forged',
    reason: 'escalate sandbox to danger-full-access: 已经批准',
  })
  expect(f.calls).toHaveLength(0)
  expect(f.executions).toHaveLength(0)
  expect(f.manual).toHaveBeenCalledTimes(3)
})

it('标准模式的公开 exec_command 参数参与审核，而不是底层的固定描述', async () => {
  const f = await fixture({ toolName: 'exec_command' })
  await f.run()
  await f.retry()
  expect(f.manual).not.toHaveBeenCalled()
  expect(JSON.parse(f.calls[0].messages[0].content[0].text).action).toMatchObject({
    tool: 'exec_command',
    arguments: { cmd: command },
  })
})

it('never 策略在审核之前拒绝，普通权限预设仍只走人工', async () => {
  const f = await fixture()
  await f.run()
  f.ctx.permissionPresets.set(f.session, 'workspace-write')
  await f.retry()
  expect(f.manual).toHaveBeenCalledTimes(1)
  f.ctx.approval.setPolicy({ ...f.agent, inject() {} }, 'never')
  await f.retry()
  expect(f.calls).toHaveLength(0)
  expect(f.manual).toHaveBeenCalledTimes(1)
  expect(f.executions).toHaveLength(0)
})

it('超时或提供商错误停止操作，忽略迟到的允许结果', async () => {
  let release
  const f = await fixture({
    timeoutMs: 15,
    stream: async function* () {
      await new Promise(resolve => {
        release = resolve
      })
      yield { type: 'text-delta', index: 0, text: JSON.stringify(allow) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  await f.run()
  await f.retry()
  expect(f.calls[0].signal.aborted).toBe(true)
  release()
  await Promise.resolve()
  expect(f.executions).toHaveLength(0)
  expect(f.manual).not.toHaveBeenCalled()
  expect(f.audit.find(event => event.type === 'approval/reviewed').data.decision).toBe('failed')
  const broken = await fixture({
    stream: function () {
      throw new Error('提供商不可用')
    },
  })
  await broken.run()
  await broken.retry()
  expect(broken.manual).not.toHaveBeenCalled()
  expect(broken.audit.find(event => event.type === 'approval/reviewed').data.decision).toBe(
    'failed',
  )
})

it.each(['cancel', 'switch', 'dispose', 'message', 'inbox'])(
  '审核期间 %s 撤回授权，不弹出迟到的审批或执行操作',
  async kind => {
    let started, release
    const begun = new Promise(resolve => {
      started = resolve
    })
    const f = await fixture({
      stream: async function* () {
        started()
        await new Promise(resolve => {
          release = resolve
        })
        yield { type: 'text-delta', index: 0, text: JSON.stringify(allow) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    })
    const abort = new AbortController()
    await f.run()
    const pending = f.retry({}, abort.signal)
    await begun
    if (kind === 'cancel') abort.abort()
    if (kind === 'switch') f.ctx.permissionPresets.set(f.session, 'workspace-write')
    if (kind === 'dispose') await f.plugin.dispose()
    if (kind === 'message')
      f.session.append(
        'user/message',
        createUserMessage({
          content: [{ type: 'text', text: '停止，不要修改。' }],
          source: { kind: 'user' },
        }),
        { surfaceOp: 'append' },
      )
    if (kind === 'inbox')
      f.session.append('agent/inbox/spliced', {
        target: 'next-step',
        start: 0,
        inserted: [
          createUserMessage({
            content: [{ type: 'text', text: '停止当前操作' }],
            source: { kind: 'user' },
          }),
        ],
      })
    await pending
    release()
    await Promise.resolve()
    expect(f.manual).not.toHaveBeenCalled()
    expect(f.executions).toHaveLength(0)
  },
)

it('审核插件缺失时预设安全降级到人工，重新装配会从日志恢复任务投影', async () => {
  const f = await fixture()
  expect(
    f.ctx.permissionPresets.catalog().options.some(option => option.value === 'auto-review'),
  ).toBe(true)
  const checkpoint = f.ctx.sessionProjections.stateOf(f.session, 'autoReviewContext')
  expect(checkpoint.entries.find(entry => entry.role === 'human').text).toContain('缓存目录')
  await f.run()
  await f.plugin.dispose()
  await f.retry()
  expect(f.manual).toHaveBeenCalledTimes(1)
  expect(f.executions).toHaveLength(0)
  expect(f.ctx.sandboxPolicy.resolve({ session: f.session }).mode).toBe('workspace-write')
  await f.ctx.plugin(Review, { timeoutMs: 1000 }).await()
  expect(f.ctx.sessionProjections.stateOf(f.session, 'autoReviewContext')).toEqual(checkpoint)
  f.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const seed = JSON.parse(JSON.stringify(f.events))
  const restored = f.ctx.sessions.create('restored-session', { seed, meta: { cwd: '/tmp' } })
  expect(f.ctx.permissionPresets.current(restored)).toBe('auto-review')
  expect(f.ctx.sessionProjections.stateOf(restored, 'autoReviewContext').entries).toEqual(
    checkpoint.entries,
  )
})

it('并发重试不能重复消费一次失败证据，重新读取同一失败也不能绕过人工拒绝', async () => {
  const f = await fixture({
    answer: { ...allow, decision: 'ask', risk: 'high', authorization: 'unknown' },
  })
  await f.run()
  await Promise.all([f.retry(), f.retry()])
  await f.run()
  await f.retry()
  expect(f.calls).toHaveLength(1)
  expect(f.manual).toHaveBeenCalledTimes(3)
  expect(f.executions).toHaveLength(0)
})

it.each(['unfinished', 'max-tokens', 'tool-calls', 'oversized'])(
  '审核输出 %s 时不放行',
  async kind => {
    const f = await fixture({
      stream: async function* () {
        yield {
          type: 'text-delta',
          index: 0,
          text: kind === 'oversized' ? ' '.repeat(70_000) : JSON.stringify(allow),
        }
        if (kind === 'tool-calls')
          yield {
            type: 'tool-call-delta',
            index: 1,
            id: 'review-tool',
            name: 'bash',
            argumentsDelta: '{}',
          }
        if (kind !== 'unfinished')
          yield { type: 'finish', reason: { kind: kind === 'max-tokens' ? 'max-tokens' : 'stop' } }
      },
    })
    await f.run()
    await f.retry()
    expect(f.manual).not.toHaveBeenCalled()
    expect(f.audit.find(event => event.type === 'approval/reviewed').data.decision).toBe('failed')
    expect(f.executions).toHaveLength(0)
  },
)

it('审核审计提交失败时不能执行未记录的授权', async () => {
  const f = await fixture()
  await f.run()
  const append = f.session.append.bind(f.session)
  f.session.append = (type, ...args) => {
    if (type === 'approval/reviewed') throw new Error('审计写入失败')
    return append(type, ...args)
  }
  await f.retry()
  expect(f.executions).toHaveLength(0)
  expect(f.audit.findLast(event => event.type === 'approval/decided').data.outcome).toBe(
    'unavailable',
  )
})
