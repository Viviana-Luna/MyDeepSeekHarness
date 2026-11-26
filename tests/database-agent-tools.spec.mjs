/** 验证「数据库模式配置 + 表级权限 + 批量读写/DDL + 单次同意弹窗」全链路，含 SSH 隧道依赖、并发串行与 Agent Loop 隔离验证。 */
/* oxlint-disable no-await-in-loop -- 同一会话与串行授权流程需要按顺序断言每一步状态。 */
import { afterEach, expect, it, vi } from 'vitest'
import { LlmAdapter, createUserMessage } from '../packages/llm/llm/lib/index.js'
import {
  normalizeAgentAccess,
  resolveTablePermissions,
} from '../packages/connections/database/src/agent-policy.ts'
import { admitReadQueries } from '../packages/connections/database/src/read-query.ts'
import { admitMutateStatements } from '../packages/connections/database/src/write-query.ts'
import {
  agentAccess,
  createFixture,
  disposeDatabaseFixtures,
  transport,
} from './helpers/database-agent-fixture.mjs'

afterEach(disposeDatabaseFixtures)

it('新连接默认关闭模型访问，开启后默认只读且表规则不能越过档位', () => {
  expect(normalizeAgentAccess()).toEqual({ enabled: false, mode: 'readonly', tableRules: [] })
  const access = normalizeAgentAccess({
    enabled: true,
    mode: 'readonly',
    tableRules: [
      {
        schema: 'orders',
        table: '*',
        select: true,
        insert: true,
        update: true,
        delete: true,
        ddl: true,
      },
    ],
  })
  expect(resolveTablePermissions(access, 'orders', 'items')).toEqual({
    select: true,
    insert: false,
    update: false,
    delete: false,
    ddl: false,
  })
})

it('完整访问档位支持业务表 SQL、SSH 隧道和表级规则，并在越权读取时申请提权', async () => {
  const f = await createFixture({ ssh: true })
  const listed = await f.runTool('database_connections_list', {})
  expect(listed.isError).toBe(false)
  expect(listed.value.items).toHaveLength(1)
  expect(listed.value.items[0].transport).toBe('ssh')
  expect(listed.value.items[0].agent_access.mode).toBe('full')

  f.dbStored.profile.agentAccess = {
    ...agentAccess('full'),
    tableRules: [
      {
        schema: 'orders',
        table: '*',
        select: true,
        insert: true,
        update: false,
        delete: false,
        ddl: false,
      },
      {
        schema: 'orders',
        table: 'audit_logs',
        select: false,
        insert: false,
        update: false,
        delete: false,
        ddl: false,
      },
    ],
  }
  const tables = await f.runTool('database_schema', {
    connection_id: f.dbId,
    action: 'tables',
    schema: 'orders',
  })
  expect(tables.isError).toBe(false)
  expect(tables.value.items.map(item => item.name)).toEqual(['order_records', 'order_items'])

  f.setDecision('deny')
  const denied = await f.runTool('database_query', {
    connection_id: f.dbId,
    sql: 'SELECT o.id FROM orders.order_records AS o JOIN orders.audit_logs AS a ON a.id = o.id',
  })
  expect(denied.isError).toBe(true)
  expect(JSON.stringify(denied.content)).toContain('USER_REJECTED')
  expect(f.prompts[0].questions[0].header).toBe('数据库读取提权')

  f.setDecision('allow-once')
  const elevated = await f.runTool('database_query', {
    connection_id: f.dbId,
    sql: 'SELECT o.id FROM orders.order_records AS o JOIN orders.audit_logs AS a ON a.id = o.id',
  })
  expect(elevated.isError).toBe(false)

  const ok = await f.runTool('database_query', {
    connection_id: f.dbId,
    sql: 'SELECT o.id uid FROM order_records o JOIN order_items i ON i.id = o.id LIMIT 10; SELECT COUNT(*) cnt FROM order_items',
  })
  expect(ok.isError).toBe(false)
  expect(ok.value.query_count).toBe(2)
  expect(f.prompts).toHaveLength(2)

  // 验证在并列插件隔离下，真实触发 SSH 隧道工厂时 DatabaseConnections -> SshConnections 的全部注入依赖可达。
  const sshSocket = transport.readBatch.mock.calls.at(-1)?.[2]
  expect(typeof sshSocket).toBe('function')
  await expect(sshSocket(AbortSignal.timeout(2000))).rejects.toThrow('SSH_OPEN_REACHED')

  f.dbStored.profile.agentAccess.enabled = false
  const closedList = await f.runTool('database_connections_list', {})
  expect(closedList.value.items).toEqual([])
  expect(
    (await f.runTool('database_schema', { connection_id: f.dbId, action: 'schemas' })).isError,
  ).toBe(true)
})

it('支持批量写入与 DDL 单卡一次同意、会话放行、关联 SSH 变更失效、与拒绝保护', async () => {
  const f = await createFixture({ ssh: true })

  // 1. 非表能力直接拒绝；表级删除越权进入提权确认。
  f.dbStored.profile.agentAccess = {
    ...agentAccess('full'),
    tableRules: [
      {
        schema: 'orders',
        table: '*',
        select: true,
        insert: true,
        update: true,
        delete: false,
        ddl: true,
      },
    ],
  }
  const forbiddenGrant = await f.runTool('database_mutate', {
    connection_id: f.dbId,
    sql: "GRANT ALL ON orders.* TO 'hacker'@'%'",
  })
  expect(forbiddenGrant.isError).toBe(true)
  expect(f.prompts).toHaveLength(0)
  f.setDecision('deny')
  const forbiddenDelete = await f.runTool('database_mutate', {
    connection_id: f.dbId,
    sql: 'DELETE FROM orders.order_records WHERE id = 1',
  })
  expect(forbiddenDelete.isError).toBe(true)
  expect(f.prompts).toHaveLength(1)
  expect(f.prompts[0].questions[0].header).toBe('数据库权限提权')

  // 2. 用户拒绝时不执行任何变更。
  f.setDecision('deny')
  const rejected = await f.runTool('database_mutate', {
    connection_id: f.dbId,
    sql: "INSERT INTO order_records (name) VALUES ('a'); ALTER TABLE order_records ADD COLUMN note VARCHAR(64)",
  })
  expect(rejected.isError).toBe(true)
  expect(f.prompts).toHaveLength(2)
  expect(transport.mutateBatch).not.toHaveBeenCalled()

  // 3. 单次确认整批 DML + DDL：只需点一次「允许本次（全部 2 条）」。
  f.setDecision('allow-once')
  const once = await f.runTool('database_mutate', {
    connection_id: f.dbId,
    statements: [
      "INSERT INTO order_records (name) VALUES ('b')",
      'CREATE INDEX idx_name ON order_records (name)',
    ],
  })
  expect(once.isError).toBe(false)
  expect(once.value.statement_count).toBe(2)
  expect(once.value.has_ddl).toBe(true)
  expect(f.prompts).toHaveLength(3)
  expect(f.prompts[2].questions[0].id).toMatch(/^mydsh-database-consent:/u)
  expect(f.prompts[2].questions[0].detail).toContain('隐式提交')

  // 4. 选择「本次会话允许该连接变更」后，同会话连续调用免除重复弹窗；关联 SSH 指纹改变后立即失效。
  f.setDecision('session')
  const firstSessionWrite = await f.runTool('database_mutate', {
    connection_id: f.dbId,
    sql: 'CREATE TABLE IF NOT EXISTS tmp_demo (id BIGINT PRIMARY KEY)',
  })
  expect(firstSessionWrite.isError).toBe(false)
  expect(firstSessionWrite.value.authorization).toBe('approved-session')
  expect(f.prompts).toHaveLength(4)
  const secondSessionWrite = await f.runTool('database_mutate', {
    connection_id: f.dbId,
    sql: "UPDATE order_records SET name = 'c' WHERE id = 1",
  })
  expect(secondSessionWrite.isError).toBe(false)
  expect(secondSessionWrite.value.authorization).toBe('session-reused')
  expect(f.prompts).toHaveLength(4)

  f.sshStored.profile.revision++
  f.ctx.mydshConnectionAccess.invalidate({ kind: 'ssh', id: f.sshId })
  await f.runTool('database_mutate', {
    connection_id: f.dbId,
    sql: 'CREATE TABLE IF NOT EXISTS tmp_demo (id BIGINT PRIMARY KEY)',
  })
  expect(f.prompts).toHaveLength(5)
})

it('只读档位越过权限墙时申请单次或本会话提权，而不是直接报错', async () => {
  const f = await createFixture({ agentAccess: agentAccess('readonly') })
  f.setDecision('allow-once')
  const once = await f.runTool('database_mutate', {
    connection_id: f.dbId,
    sql: "INSERT INTO order_records (name) VALUES ('elevated-once')",
  })
  expect(once.isError).toBe(false)
  expect(once.value.authorization).toBe('elevated-once')
  expect(f.prompts).toHaveLength(1)
  expect(f.prompts[0].questions[0].header).toBe('数据库权限提权')
  expect(f.prompts[0].questions[0].detail).toContain('数据读写')

  f.setDecision('session')
  const session = await f.runTool('database_mutate', {
    connection_id: f.dbId,
    sql: 'CREATE TABLE IF NOT EXISTS audit_demo (id BIGINT PRIMARY KEY)',
  })
  expect(session.isError).toBe(false)
  expect(session.value.authorization).toBe('elevated-session')
  expect(f.prompts).toHaveLength(2)
  expect(f.prompts[1].questions[0].detail).toContain('完整访问')

  const listedAfterElevate = await f.runTool('database_connections_list', {})
  expect(listedAfterElevate.value.items[0].session_elevation).toEqual({ mode: 'full' })

  const reused = await f.runTool('database_mutate', {
    connection_id: f.dbId,
    sql: 'ALTER TABLE audit_demo ADD COLUMN note VARCHAR(64)',
  })
  expect(reused.isError).toBe(false)
  expect(reused.value.authorization).toBe('session-reused')
  expect(f.prompts).toHaveLength(2)

  f.dbStored.profile.revision++
  f.ctx.mydshConnectionAccess.invalidate({ kind: 'database', id: f.dbId })
  const afterChange = await f.runTool('database_mutate', {
    connection_id: f.dbId,
    sql: 'ALTER TABLE audit_demo ADD COLUMN tag VARCHAR(32)',
  })
  expect(afterChange.isError).toBe(false)
  expect(f.prompts).toHaveLength(3)
})

it('表级规则拒绝结构读取时先申请提权再返回字段', async () => {
  const f = await createFixture({
    agentAccess: agentAccess('readonly', [
      {
        schema: 'orders',
        table: '*',
        select: false,
        insert: false,
        update: false,
        delete: false,
        ddl: false,
      },
    ]),
  })
  f.setDecision('allow-once')
  const result = await f.runTool('database_schema', {
    connection_id: f.dbId,
    action: 'columns',
    schema: 'orders',
    table: 'audit_logs',
  })
  expect(result.isError).toBe(false)
  expect(result.value.items[0]).toMatchObject({ name: 'id', type: 'bigint unsigned' })
  expect(f.prompts).toHaveLength(1)
  expect(f.prompts[0].questions[0].header).toBe('数据库结构读取提权')
})

it('即使预设开启 approval=never，database_mutate 仍必须向用户弹窗确认，且并行调用只弹一次', async () => {
  const f = await createFixture()
  const fullAccess = await f.createAgent(undefined, { approval: { policy: 'never' } })

  let releasePrompt
  const gate = new Promise(resolve => {
    releasePrompt = resolve
  })
  f.setAnswerHook(async request => {
    await gate
    return { answers: [{ id: request.questions[0].id, selected: ['本次会话允许该连接变更'] }] }
  })

  const first = f.runTool(
    'database_mutate',
    { connection_id: f.dbId, sql: "INSERT INTO order_records (name) VALUES ('p1')" },
    fullAccess.agent,
  )
  const second = f.runTool(
    'database_mutate',
    { connection_id: f.dbId, sql: "INSERT INTO order_records (name) VALUES ('p2')" },
    fullAccess.agent,
  )
  await vi.waitFor(() => expect(f.prompts).toHaveLength(1))
  releasePrompt()
  const [res1, res2] = await Promise.all([first, second])
  expect(res1.isError).toBe(false)
  expect(res2.isError).toBe(false)
  expect(f.prompts).toHaveLength(1)
  expect(transport.mutateBatch).toHaveBeenCalledTimes(2)
})

it('合成模型经真实 Agent Loop 调用查询与变更+DDL，日志无密码泄露、无通用审批且不触发 spill', async () => {
  const f = await createFixture()
  f.setDecision('allow-once')

  let calls = 0
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model }
    }
    async *stream() {
      calls++
      if (calls === 1) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'q1',
            name: 'database_query',
            arguments: JSON.stringify({
              connection_id: f.dbId,
              sql: 'SELECT COUNT(*) AS cnt FROM order_records',
            }),
          },
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else if (calls === 2) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'm1',
            name: 'database_mutate',
            arguments: JSON.stringify({
              connection_id: f.dbId,
              sql: "INSERT INTO order_records (name) VALUES ('from-loop'); ALTER TABLE order_records ADD COLUMN tag VARCHAR(32)",
            }),
          },
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'text-delta', index: 0, text: '数据库读写与结构变更已完成' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }

  f.ctx.llm.registerAdapter(['fixture'], new Adapter())
  f.handle.agent.followup(
    createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: '查询数量后新增记录并加一列' }],
    }),
  )
  await f.handle.agent.whenIdle()
  const events = f.handle.agent.session.snapshotEvents()
  expect(calls).toBe(3)
  expect(f.prompts).toHaveLength(1)
  expect(events.findLast(event => event.type === 'turn/end').data.reason.kind).toBe('completed')
  expect(JSON.stringify(events)).not.toContain('绝不能泄漏的明文密码')
  expect(events.some(event => event.type.startsWith('approval/'))).toBe(false)
  expect(f.spillSave).not.toHaveBeenCalled()
})

it('批量 SQL 与 DDL 解析覆盖常见结构/索引/视图语句，严格拒绝注释、系统库和权限提权关键字', () => {
  const reads = admitReadQueries(
    "SELECT a.id uid, COALESCE(b.note, '') note FROM `ruoyi-office`.orders a LEFT JOIN `ruoyi-office`.items b ON b.order_id = a.id WHERE a.id > 0 ORDER BY a.id DESC LIMIT 50; SELECT COUNT(*) cnt FROM `ruoyi-office`.orders",
    null,
  )
  expect(reads).toHaveLength(2)
  expect(reads[0].targets.map(item => `${item.schema}.${item.table}`)).toEqual([
    'ruoyi-office.orders',
    'ruoyi-office.items',
  ])

  const mutations = admitMutateStatements(
    {
      sql: [
        "INSERT INTO orders (name) VALUES ('x'), ('y')",
        "UPDATE app.orders SET status = 'paid' WHERE id = 1",
        'DELETE FROM orders WHERE id = 2',
        'CREATE TABLE IF NOT EXISTS audit_items (id BIGINT PRIMARY KEY, name VARCHAR(64))',
        'ALTER TABLE orders ADD COLUMN archived TINYINT DEFAULT 0',
        'CREATE INDEX idx_orders_status ON orders (status)',
        'DROP INDEX idx_orders_status ON orders',
        'TRUNCATE TABLE temp_orders',
        'RENAME TABLE old_orders TO orders_bak',
        'CREATE VIEW v_orders AS SELECT id FROM orders',
        'DROP VIEW IF EXISTS v_orders',
        'CREATE DATABASE IF NOT EXISTS sandbox_app',
      ].join('; '),
    },
    'app',
  )
  expect(mutations).toHaveLength(12)
  expect(mutations.filter(item => item.operation === 'ddl')).toHaveLength(9)
  expect(mutations.at(-1)?.schema).toBe('sandbox_app')

  const rename = admitMutateStatements(
    { sql: 'ALTER TABLE orders RENAME TO archived_orders' },
    'app',
  )[0]
  expect(rename?.targets.map(item => `${item.schema}.${item.table}`)).toEqual([
    'app.orders',
    'app.archived_orders',
  ])
  const exchange = admitMutateStatements(
    { sql: 'ALTER TABLE orders EXCHANGE PARTITION p0 WITH TABLE audit_items' },
    'app',
  )[0]
  expect(exchange?.targets.map(item => `${item.schema}.${item.table}`)).toEqual([
    'app.orders',
    'app.audit_items',
  ])
  const columnNamedRename = admitMutateStatements(
    { sql: 'ALTER TABLE orders ADD COLUMN rename VARCHAR(16)' },
    'app',
  )[0]
  expect(columnNamedRename?.targets.map(item => `${item.schema}.${item.table}`)).toEqual([
    'app.orders',
  ])

  for (const dangerous of [
    'SELECT * FROM mysql.user',
    'SELECT * FROM orders -- comment',
    "INSERT INTO orders VALUES (1) INTO OUTFILE '/tmp/x'",
    "GRANT SELECT ON *.* TO 'x'@'%'",
    'CREATE USER evil IDENTIFIED BY "123"',
    'DROP TABLE mysql.user',
    'CALL dangerous_proc()',
  ]) {
    expect(() =>
      dangerous.startsWith('SELECT')
        ? admitReadQueries(dangerous, 'app')
        : admitMutateStatements({ sql: dangerous }, 'app'),
    ).toThrow()
  }
})

it('系统库与无表查询被拒绝时引导模型改用 database_schema，且不放宽探活边界', async () => {
  const f = await createFixture()
  f.dbStored.profile.agentAccess = {
    ...agentAccess('readonly'),
    tableRules: [
      {
        schema: 'orders',
        table: '*',
        select: true,
        insert: false,
        update: false,
        delete: false,
        ddl: false,
      },
    ],
  }
  const schemas = f.ctx.tools.schemas(f.handle.agent)
  const queryTool = schemas.find(item => item.name === 'database_query')
  const structureTool = schemas.find(item => item.name === 'database_schema')
  expect(queryTool?.description).toContain('database_schema')
  expect(queryTool?.description).toContain('执行完整业务表 SQL')
  expect(structureTool?.description).toContain('确认连接是否可用')

  const systemQuery = await f.runTool('database_query', {
    connection_id: f.dbId,
    sql: "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'orders' LIMIT 3",
  })
  expect(systemQuery.isError).toBe(true)
  expect(JSON.stringify(systemQuery.content)).toContain('database_schema')

  const tablelessQuery = await f.runTool('database_query', {
    connection_id: f.dbId,
    sql: 'SELECT 1',
  })
  expect(tablelessQuery.isError).toBe(true)
  expect(JSON.stringify(tablelessQuery.content)).toContain('database_schema')

  const versionQuery = await f.runTool('database_query', {
    connection_id: f.dbId,
    sql: 'SELECT VERSION() AS v',
  })
  expect(versionQuery.isError).toBe(true)
  expect(JSON.stringify(versionQuery.content)).toContain('包含不支持的函数或子查询')
  expect(transport.readBatch).not.toHaveBeenCalled()
})

it('完整开放的连接通过 database_query 执行完整 SQL，并在变更前确认', async () => {
  const f = await createFixture()
  f.setDecision('allow-once')

  const readQueries = [
    'SELECT VERSION() AS v',
    'SELECT id FROM order_records WHERE id IN (SELECT id FROM order_items)',
    'SELECT id FROM order_records UNION SELECT id FROM order_items',
    'WITH ids AS (SELECT id FROM order_records) SELECT COUNT(*) FROM ids',
    'SELECT COUNT(*) OVER (PARTITION BY status) FROM order_records',
    'SELECT * FROM (SELECT id FROM order_records) AS derived',
  ]
  const readBatch = await f.runTool('database_query', {
    connection_id: f.dbId,
    queries: readQueries,
  })
  expect(readBatch.isError).toBe(false)
  expect(readBatch.value.mode).toBe('read')
  expect(readBatch.value.query_count).toBe(readQueries.length)

  const scriptedRead = await f.runTool('database_query', {
    connection_id: f.dbId,
    sql: 'SELECT VERSION() AS v;\n-- 注释也可以保留\nSELECT 1',
  })
  expect(scriptedRead.isError).toBe(false)
  expect(scriptedRead.value.query_count).toBe(2)
  expect(transport.readBatch.mock.calls.some(call => call[3]?.length === readQueries.length)).toBe(
    true,
  )

  for (const sql of [
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'orders'",
    'SELECT * FROM mysql.user',
    "SELECT * FROM order_records INTO OUTFILE '/tmp/mydsh.txt'",
    "SELECT LOAD_FILE('/etc/passwd') FROM order_records",
    "CREATE DEFINER='root'@'%' PROCEDURE p() SELECT 1",
  ]) {
    const blocked = await f.runTool('database_query', { connection_id: f.dbId, sql })
    expect(blocked.isError).toBe(true)
  }
  expect(f.prompts).toHaveLength(0)

  const mutationQueries = [
    "UPDATE order_records SET status = 'done' WHERE id = 1",
    "INSERT INTO order_records (name) VALUES ('new')",
    'DELETE FROM order_records WHERE id = 2',
    'ALTER TABLE order_records ADD COLUMN note VARCHAR(64)',
  ]
  const written = await f.runTool('database_query', {
    connection_id: f.dbId,
    queries: mutationQueries,
  })
  expect(written.isError).toBe(false)
  expect(written.value.mode).toBe('mutation')
  expect(written.value.statement_count).toBe(mutationQueries.length)
  expect(f.prompts).toHaveLength(1)
  expect(f.prompts[0].questions[0].detail).toContain('连接级通用 SQL')
  expect(f.prompts[0].questions[0].detail).toContain('MySQL 会隐式提交')
  expect(transport.mutateBatch).toHaveBeenCalledTimes(1)

  const mixed = await f.runTool('database_query', {
    connection_id: f.dbId,
    sql: "SELECT 1; UPDATE order_records SET status = 'done' WHERE id = 1",
  })
  expect(mixed.isError).toBe(true)
  expect(JSON.stringify(mixed.content)).toContain('不能混合读取和变更 SQL')
  expect(f.prompts).toHaveLength(1)
})
