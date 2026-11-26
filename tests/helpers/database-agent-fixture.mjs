/** 构造真实 Cordis、Agent Loop、连接授权与隔离数据库传输的测试夹具。 */
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { vi } from 'vitest'
import { LlmRuntime } from '../../packages/llm/llm/lib/index.js'
import SessionStore from '../../packages/core/session/lib/index.js'
import Projections from '../../packages/session/session-projection/lib/index.js'
import SystemPrompt from '../../packages/core/system-prompt/lib/index.js'
import Tools from '../../packages/core/tools/lib/index.js'
import Agents from '../../packages/core/agent/lib/index.js'
import AgentLoop from '../../packages/core/agent-loop/lib/index.js'
import UserQuestions from '../../packages/interaction/user-questions/lib/index.js'
import * as Spill from '../../packages/spill/spill-policy/lib/index.js'
import { ConnectionAccess } from '../../packages/connections/access/lib/index.js'
import { SshConnections } from '../../packages/connections/ssh/lib/index.js'
import { DatabaseConnections } from '../../packages/connections/database/lib/index.js'
import * as DatabaseTools from '../../packages/connections/database/lib/tools.js'

const transportState = vi.hoisted(() => ({
  read: vi.fn(),
  readBatch: vi.fn(),
  mutateBatch: vi.fn(),
}))

/** 供测试断言数据库传输调用次数的受控替身。 */
export const transport = transportState

vi.mock('../../packages/connections/database/lib/transport.js', async original => ({
  ...(await original()),
  readDatabase: transportState.read,
  readDatabaseBatch: transportState.readBatch,
  executeDatabaseBatch: transportState.mutateBatch,
}))

const contexts = []

function tableResult(rows, columns = []) {
  return {
    rows,
    columns,
    truncated: false,
    rowCount: rows.length,
    bytes: 120,
    elapsedMs: 1,
  }
}

/** 生成已开启模型访问且指定档位与表规则的连接策略。 */
export function agentAccess(mode = 'full', tableRules = []) {
  return { enabled: true, mode, tableRules }
}

/** 释放本轮创建的所有 Cordis 上下文。 */
export async function disposeDatabaseFixtures() {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
}

/** 建立带真实插件依赖和可观测用户问题流的数据库工具夹具。 */
export async function createFixture(options = {}) {
  transport.read.mockReset().mockImplementation(async (...args) => {
    const [, , , sql] = args
    if (sql.includes('SCHEMATA')) return tableResult([['orders'], ['analytics']])
    if (sql.includes('STATISTICS')) return tableResult([['PRIMARY', 'id', '1', '0']])
    if (sql.includes('COLUMNS')) return tableResult([['id', 'bigint unsigned', 'NO', 'PRI']])
    return tableResult([
      ['order_records', 'BASE TABLE'],
      ['order_items', 'BASE TABLE'],
      ['audit_logs', 'BASE TABLE'],
    ])
  })
  transport.readBatch.mockReset().mockImplementation(async (_profile, _pw, _socket, queries) =>
    queries.map(() =>
      tableResult(
        [['1', 'ok']],
        [
          { name: 'id', type: 'LONG' },
          { name: 'status', type: 'VAR_STRING' },
        ],
      ),
    ),
  )
  transport.mutateBatch.mockReset().mockImplementation(async (_profile, _pw, _socket, stmts) => ({
    results: stmts.map((item, index) => ({
      index,
      operation: item.operation,
      schema: item.schema,
      table: item.table,
      sql: item.sql,
      affectedRows: item.operation === 'ddl' ? 0 : 1,
      changedRows: item.operation === 'update' ? 1 : 0,
      insertId: item.operation === 'insert' ? String(index + 10) : null,
    })),
    totalAffectedRows: stmts.filter(item => item.operation !== 'ddl').length,
    rolledBack: false,
    hasDdl: stmts.some(item => item.operation === 'ddl'),
    elapsedMs: 3,
    ...(stmts.some(item => item.operation === 'ddl')
      ? { warning: '本批次包含 DDL 结构变更；MySQL 会对 DDL 隐式提交。' }
      : {}),
  }))

  const ctx = new Context()
  contexts.push(ctx)
  for (const plugin of [
    LlmRuntime,
    SessionStore,
    Projections,
    SystemPrompt,
    Tools,
    Agents,
    UserQuestions,
  ])
    await ctx.plugin(plugin).await()
  await ctx.plugin(AgentLoop, { agents: [] }).await()

  const spillSave = vi.fn(async () => ({ id: 'spill-1', uri: 'spill://spill-1' }))
  ctx.provide('spillStore', { saveText: spillSave })
  await ctx.plugin(Spill, { maxInlineBytes: 50_000 }).await()
  const dbId = randomUUID()
  const sshId = randomUUID()
  const archived = []
  ctx.provide('workspaceRegistry', { archivedSessionIds: archived })
  ctx.provide('sessionController', {
    inspect: async id => {
      const meta = ctx.sessions.get(id)?.header
      if (!meta) throw new Error('会话不存在')
      return { meta, events: [], inheritedEventCount: 0 }
    },
  })

  const dbStored = {
    version: 1,
    profile: {
      id: dbId,
      revision: 1,
      name: options.ssh ? 'SSH 隧道业务库' : '直连业务库',
      host: '127.0.0.1',
      port: 3306,
      username: 'app_rw',
      database: 'orders',
      tlsEnabled: false,
      tlsServerName: '',
      tlsCa: '',
      sshConnectionId: options.ssh ? sshId : null,
      environment: '测试',
      projectId: null,
      disabled: false,
      agentAccess: options.agentAccess ?? agentAccess(),
    },
    secret: { sealed: '数据库隔离密文' },
  }

  const sshStored = {
    version: 1,
    profile: {
      id: sshId,
      revision: 1,
      name: '跳板机',
      host: '10.0.0.10',
      port: 22,
      username: 'ops',
      auth: 'password',
      environment: '测试',
      projectId: null,
      disabled: false,
      fingerprint: options.sshDisabled
        ? null
        : 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    },
    secrets: { 'ssh-password': { sealed: 'SSH 隔离密文' } },
  }

  // 凭据与连接系统按运行核心 roster 的布局由并列插件提供：放在 root 上会让祖先链遍历成功，
  // 掩盖工具插件未注入 credentials 时的静态调用回归。
  await ctx
    .plugin({
      name: 'fixture-credentials',
      apply(scope) {
        scope.provide('credentials', {
          listRecords: async () => [
            { key: `mydsh-database/connection-${dbId}` },
            { key: `mydsh-ssh/connection-${sshId}` },
          ],
          readRecord: async key => {
            if (key === `mydsh-ssh/connection-${sshId}`)
              return { kind: 'grant', payload: structuredClone(sshStored) }
            return { kind: 'grant', payload: structuredClone(dbStored) }
          },
          modifyRecord: async (_key, update) => {
            Object.assign(dbStored, (await update()).payload)
          },
        })
      },
    })
    .await()
  await ctx
    .plugin({
      name: 'fixture-connection-system',
      apply(scope) {
        scope.provide('mydshConnectionSystem', {
          token: '桌面测试凭证',
          call: async method => {
            if (method === 'ssh.open') throw new Error('SSH_OPEN_REACHED')
            return '绝不能泄漏的明文密码'
          },
        })
      },
    })
    .await()

  await ctx.plugin(SshConnections).await()
  await ctx.plugin(ConnectionAccess).await()
  await ctx.plugin(DatabaseConnections).await()

  const prompts = []
  let answerDecision = 'allow-once'
  let answerHook = null
  ctx.on('user-questions/request', async request => {
    prompts.push(request)
    if (answerHook) return answerHook(request)
    const item = request.questions[0]
    if (answerDecision === 'deny') return { answers: [{ id: item.id, selected: ['拒绝'] }] }
    if (answerDecision === 'session') {
      const sessionOption = item.options.find(option => option.label.includes('本次会话'))
      return {
        answers: [{ id: item.id, selected: [(sessionOption ?? item.options[0]).label] }],
      }
    }
    return { answers: [{ id: item.id, selected: [item.options[0].label] }] }
  })

  const createAgent = async (
    sessionId = `db-session-${randomUUID()}`,
    agentOptions = {},
    meta = {},
  ) =>
    ctx.agentLoop.createAgent(ctx, {
      sessionId,
      meta: { cwd: '/tmp', ...meta },
      agentOptions: { provider: 'fixture', model: 'synthetic', ...agentOptions },
      setup: async agentCtx => {
        await agentCtx.plugin(DatabaseTools).await()
      },
    })

  const handle = await createAgent()
  const runTool = (name, args = {}, agent = handle.agent, signal = AbortSignal.timeout(5000)) =>
    ctx.tools.execute({ name, callId: randomUUID(), agent, signal, arguments: args })

  return {
    ctx,
    dbId,
    sshId,
    dbStored,
    sshStored,
    handle,
    prompts,
    setDecision: mode => {
      answerDecision = mode
    },
    setAnswerHook: fn => {
      answerHook = fn
    },
    createAgent,
    runTool,
    spillSave,
  }
}
