/** 隔离 MySQL 的 Agent 工具验收；只使用测试账号、表级权限策略和合成模型，不访问真实模型。 */
/* oxlint-disable no-await-in-loop -- Cordis 服务与同一轮工具验收按顺序执行。 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime, LlmAdapter, createUserMessage } from '../../packages/llm/llm/lib/index.js'
import Sessions from '../../packages/core/session/lib/index.js'
import Projections from '../../packages/session/session-projection/lib/index.js'
import SystemPrompt from '../../packages/core/system-prompt/lib/index.js'
import Tools from '../../packages/core/tools/lib/index.js'
import Agents from '../../packages/core/agent/lib/index.js'
import AgentLoop from '../../packages/core/agent-loop/lib/index.js'
import UserQuestions from '../../packages/interaction/user-questions/lib/index.js'
import { ConnectionAccess } from '../../packages/connections/access/lib/index.js'
import { SshConnections } from '../../packages/connections/ssh/lib/index.js'
import { DatabaseConnections } from '../../packages/connections/database/lib/index.js'
import * as DatabaseTools from '../../packages/connections/database/lib/tools.js'

function installTestBoundary(ctx, config, id) {
  const profile = {
    id,
    revision: 1,
    name: '隔离 MySQL 验收连接',
    host: '127.0.0.1',
    port: config.port,
    username: 'mydsh_reader',
    database: 'mydsh_probe',
    tlsEnabled: true,
    tlsServerName: 'localhost',
    tlsCa: config.ca,
    sshConnectionId: null,
    environment: '验收',
    projectId: null,
    disabled: false,
    agentAccess: {
      enabled: true,
      mode: 'readonly',
      tableRules: [
        {
          schema: 'mydsh_probe',
          table: 'samples',
          select: true,
          insert: false,
          update: false,
          delete: false,
          ddl: false,
        },
      ],
    },
  }
  ctx.provide('workspaceRegistry', { archivedSessionIds: [] })
  ctx.provide('sessionController', {
    inspect: async sessionId => {
      const meta = ctx.sessions.get(sessionId)?.header
      assert.ok(meta, '验收会话必须真实存在')
      return { meta, events: [], inheritedEventCount: 0 }
    },
  })
  ctx.provide('credentials', {
    listRecords: async () => [{ key: `mydsh-database/connection-${id}` }],
    readRecord: async key => {
      assert.equal(key, `mydsh-database/connection-${id}`)
      return { kind: 'grant', payload: { version: 1, profile, secret: { fixture: true } } }
    },
  })
  ctx.provide('mydshConnectionSystem', {
    token: '隔离验收窗口',
    call: async (method, value) => {
      assert.equal(method, 'database.open')
      assert.equal(value.connectionId, id)
      return config.password
    },
  })
}

function syntheticAdapter(id) {
  let step = 0
  return new (class extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model }
    }
    async *stream() {
      const action = ['tables', 'columns', 'indexes'][step++]
      if (action === undefined) {
        yield { type: 'text-delta', index: 0, text: '隔离数据库结构与查询验收完成' }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const args = { connection_id: id, action, schema: 'mydsh_probe' }
      if (action !== 'tables') args.table = 'samples'
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: `structure-${step}`,
          name: 'database_schema',
          arguments: JSON.stringify(args),
        },
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  })()
}

function installDeniedQuestionHandler(ctx) {
  let count = 0
  ctx.on('user-questions/request', async request => {
    count++
    return { answers: [{ id: request.questions[0].id, selected: ['拒绝'] }] }
  })
  return () => count
}

async function verifyToolBoundaries({ ctx, agent, id, signal, permissionPrompts }) {
  const exec = (name, callId, args) =>
    ctx.tools.execute({ name, callId, agent, signal, arguments: args })

  const listed = await exec('database_connections_list', 'list-check', {})
  assert.equal(listed.isError, false, JSON.stringify(listed.content))
  assert.equal(listed.value.items.length, 1)

  const queried = await exec('database_query', 'select-check', {
    connection_id: id,
    sql: 'SELECT id FROM mydsh_probe.samples LIMIT 5',
  })
  assert.equal(queried.isError, false, JSON.stringify(queried.content))

  const systemSchema = await exec('database_schema', 'hard-boundary-schema', {
    connection_id: id,
    action: 'tables',
    schema: 'mysql',
  })
  assert.equal(systemSchema.isError, true)
  assert.equal(permissionPrompts(), 0)

  const dropSystem = await exec('database_mutate', 'hard-boundary-drop', {
    connection_id: id,
    sql: 'DROP DATABASE mysql',
  })
  assert.equal(dropSystem.isError, true)
  assert.equal(permissionPrompts(), 0)

  const deniedMutate = await exec('database_mutate', 'policy-deny-check', {
    connection_id: id,
    sql: 'DELETE FROM mydsh_probe.samples WHERE id = 1',
  })
  assert.equal(deniedMutate.isError, true)
  assert.match(JSON.stringify(deniedMutate.content), /USER_REJECTED/)
  assert.equal(permissionPrompts(), 1)
}

/** 用正式数据库服务与真实 Agent Loop 读取临时 MySQL，验证表级策略过滤与安全边界。 */
export async function verifyDatabaseAgent(config, signal) {
  const ctx = new Context()
  const abort = () => {
    void ctx.fiber.dispose().catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    for (const plugin of [
      LlmRuntime,
      Sessions,
      Projections,
      SystemPrompt,
      Tools,
      Agents,
      UserQuestions,
    ])
      await ctx.plugin(plugin).await()
    await ctx.plugin(AgentLoop, { agents: [] }).await()
    const id = randomUUID()
    installTestBoundary(ctx, config, id)
    await ctx.plugin(SshConnections).await()
    await ctx.plugin(ConnectionAccess).await()
    await ctx.plugin(DatabaseConnections).await()
    ctx.llm.registerAdapter(['connection-fixture'], syntheticAdapter(id))
    const permissionPrompts = installDeniedQuestionHandler(ctx)
    const handle = await ctx.agentLoop.createAgent(ctx, {
      sessionId: `结构验收-${randomUUID()}`,
      meta: { cwd: '/tmp' },
      agentOptions: { provider: 'connection-fixture', model: 'synthetic' },
      setup: async agentCtx => {
        await agentCtx.plugin(DatabaseTools).await()
      },
    })

    await verifyToolBoundaries({ ctx, agent: handle.agent, id, signal, permissionPrompts })

    handle.agent.followup(
      createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: '读取授权表的结构，不读取表数据' }],
      }),
    )
    await handle.agent.whenIdle()
    signal.throwIfAborted()
    assertAgentResults(handle.agent.session.snapshotEvents(), config.password)
    console.log('真实 MySQL、合成 Agent 调度与表级策略验收通过。')
  } finally {
    signal.removeEventListener('abort', abort)
    await ctx.fiber.dispose()
  }
}

function assertAgentResults(events, password) {
  const results = events.filter(event => event.type === 'tool/result')
  assert.equal(results.length, 3, '结构动作必须经过真实 Agent 调度')
  for (const event of results) {
    assert.equal(
      event.data.message.content[0].isError,
      false,
      JSON.stringify(event.data.message.content),
    )
    assert.equal(JSON.stringify(event.data).includes(password), false, '工具结果包含数据库密码')
  }
  assert.ok(JSON.stringify(results[1]).includes('bigint'), '字段类型必须来自真实 MySQL')
  assert.equal(
    events.some(event => event.type.startsWith('approval/')),
    false,
    '结构读取触发了审批',
  )
}
