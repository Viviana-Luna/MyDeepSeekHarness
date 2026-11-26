/** 验证数据库提权不会绕过硬边界：系统库、服务端文件、账号与服务器对象、CTE 写入分类及配置变更失效。 */
/* oxlint-disable no-await-in-loop -- 同一会话与串行提权断言需要按步骤检查弹窗计数。 */
import { afterEach, expect, it } from 'vitest'
import {
  agentAccess,
  createFixture,
  disposeDatabaseFixtures,
  transport,
} from './helpers/database-agent-fixture.mjs'

afterEach(disposeDatabaseFixtures)

it('系统库结构、系统库 DDL、服务端文件、账号管理与服务器对象绝不进入提权流程，会话提权后同样如此', async () => {
  const f = await createFixture({ agentAccess: agentAccess('readonly') })

  for (const args of [
    { connection_id: f.dbId, action: 'tables', schema: 'mysql' },
    { connection_id: f.dbId, action: 'columns', schema: 'information_schema', table: 'TABLES' },
    { connection_id: f.dbId, action: 'indexes', schema: 'performance_schema', table: 'threads' },
  ]) {
    const blocked = await f.runTool('database_schema', args)
    expect(blocked.isError).toBe(true)
    expect(JSON.stringify(blocked.content)).toContain('PERMISSION_DENIED')
  }
  expect(f.prompts).toHaveLength(0)

  const hardBlockedSql = [
    'DROP DATABASE mysql',
    'DROP SCHEMA IF EXISTS sys',
    'ALTER DATABASE mysql CHARACTER SET utf8mb4',
    'CREATE DATABASE IF NOT EXISTS performance_schema',
    "CREATE TABLE orders.evil (id INT) DATA DIRECTORY = '/tmp'",
    "CREATE TABLE orders.evil (id INT) INDEX DIRECTORY = '/tmp'",
    'ALTER TABLE orders.order_records IMPORT TABLESPACE',
    'ALTER TABLE orders.order_records DISCARD TABLESPACE',
    "SHOW GRANTS FOR 'root'@'localhost'",
    "SHOW CREATE USER 'root'@'localhost'",
    'SHOW PRIVILEGES',
    'SHOW PLUGINS',
    'SHOW FULL PROCESSLIST',
    'SHOW VARIABLES',
    'SHOW CREATE PROCEDURE orders.demo',
    'EXPLAIN FOR CONNECTION 1',
    'SELECT /*!50000 1 */ FROM order_records',
    "SELECT LOAD_FILE('/etc/passwd')",
    "SELECT * FROM order_records INTO OUTFILE '/tmp/out.txt'",
  ]
  for (const sql of hardBlockedSql) {
    const res = await f.runTool('database_query', { connection_id: f.dbId, sql })
    expect(res.isError, sql).toBe(true)
  }
  for (const sql of [
    'DROP DATABASE mysql',
    'ALTER DATABASE sys CHARACTER SET utf8mb4',
    "CREATE TABLE orders.evil (id INT) DATA DIRECTORY = '/tmp'",
    'ALTER TABLE orders.order_records IMPORT TABLESPACE',
    "CREATE USER 'evil'@'%' IDENTIFIED BY '123'",
  ]) {
    const res = await f.runTool('database_mutate', { connection_id: f.dbId, sql })
    expect(res.isError, sql).toBe(true)
  }
  expect(f.prompts).toHaveLength(0)
  expect(transport.read).not.toHaveBeenCalled()
  expect(transport.readBatch).not.toHaveBeenCalled()
  expect(transport.mutateBatch).not.toHaveBeenCalled()

  // 即使会话已通过提权卡获得完整访问档位，硬边界仍保持直接拒绝且不再弹窗。
  f.setDecision('session')
  const elevatedDdl = await f.runTool('database_mutate', {
    connection_id: f.dbId,
    sql: 'CREATE TABLE IF NOT EXISTS orders.elevated_ok (id BIGINT PRIMARY KEY)',
  })
  expect(elevatedDdl.isError).toBe(false)
  expect(f.prompts).toHaveLength(1)

  for (const sql of [
    'DROP DATABASE mysql',
    "SHOW GRANTS FOR 'root'@'localhost'",
    'ALTER TABLE orders.elevated_ok IMPORT TABLESPACE',
  ]) {
    const stillBlocked = await f.runTool('database_query', { connection_id: f.dbId, sql })
    expect(stillBlocked.isError, sql).toBe(true)
  }
  expect(f.prompts).toHaveLength(1)
})

it('WITH 变更语句必须按变更分类进入确认流程，且无表规则的 database_mutate 支持最多 50 条批量语句', async () => {
  const f = await createFixture({ agentAccess: agentAccess('readonly') })
  f.setDecision('deny')

  const cteUpdate = await f.runTool('database_query', {
    connection_id: f.dbId,
    sql: "WITH cte AS (SELECT id FROM order_records) UPDATE order_records SET status = 'done' WHERE id IN (SELECT id FROM cte)",
  })
  expect(cteUpdate.isError).toBe(true)
  expect(JSON.stringify(cteUpdate.content)).toContain('USER_REJECTED')
  expect(f.prompts).toHaveLength(1)
  expect(f.prompts[0].questions[0].header).toBe('数据库权限提权')
  expect(transport.readBatch).not.toHaveBeenCalled()
  expect(transport.mutateBatch).not.toHaveBeenCalled()

  f.setDecision('allow-once')
  const batch = Array.from(
    { length: 25 },
    (_, index) => `INSERT INTO order_records (name) VALUES ('row-${index}')`,
  )
  const mutated = await f.runTool('database_mutate', {
    connection_id: f.dbId,
    statements: batch,
  })
  expect(mutated.isError).toBe(false)
  expect(mutated.value.statement_count).toBe(25)
  expect(transport.mutateBatch).toHaveBeenCalledTimes(1)
})

it('等待读取提权期间若连接版本改变则拒绝执行，子 Agent 不能申请数据库提权', async () => {
  const f = await createFixture({
    agentAccess: agentAccess('readonly', [
      {
        schema: 'orders',
        table: 'audit_logs',
        select: false,
        insert: false,
        update: false,
        delete: false,
        ddl: false,
      },
    ]),
  })

  f.setAnswerHook(async request => {
    f.dbStored.profile.revision++
    return {
      answers: [{ id: request.questions[0].id, selected: [request.questions[0].options[0].label] }],
    }
  })
  const changed = await f.runTool('database_query', {
    connection_id: f.dbId,
    sql: 'SELECT id FROM orders.audit_logs LIMIT 5',
  })
  expect(changed.isError).toBe(true)
  expect(JSON.stringify(changed.content)).toContain('CONNECTION_CHANGED')
  expect(transport.readBatch).not.toHaveBeenCalled()

  const subagent = await f.createAgent(
    undefined,
    {},
    {
      origin: 'subagent',
      parentSession: f.handle.agent.id,
    },
  )
  const promptCountBefore = f.prompts.length
  for (const [tool, args] of [
    ['database_connections_list', {}],
    ['database_schema', { connection_id: f.dbId, action: 'schemas' }],
    [
      'database_query',
      { connection_id: f.dbId, sql: 'SELECT id FROM orders.order_records LIMIT 5' },
    ],
    ['database_query', { connection_id: f.dbId, sql: 'SELECT id FROM orders.audit_logs LIMIT 5' }],
  ]) {
    const blockedSubagent = await f.runTool(tool, args, subagent.agent)
    expect(blockedSubagent.isError, tool).toBe(true)
    expect(JSON.stringify(blockedSubagent.content), tool).toContain('NOT_AUTHORIZED')
  }
  expect(f.prompts).toHaveLength(promptCountBefore)
  expect(transport.read).not.toHaveBeenCalled()
  expect(transport.readBatch).not.toHaveBeenCalled()
})

it('高危破坏性变更与库级 DDL 绝不沿用本会话自动放行，且括号包裹的 UNION 只读查询正常放行', async () => {
  const f = await createFixture({ agentAccess: agentAccess('readonly') })

  const parenUnion = await f.runTool('database_query', {
    connection_id: f.dbId,
    sql: '(SELECT id FROM order_records ORDER BY id LIMIT 2) UNION (SELECT id FROM order_items ORDER BY id LIMIT 2)',
  })
  expect(parenUnion.isError).toBe(false)
  expect(parenUnion.value.mode).toBe('read')
  expect(f.prompts).toHaveLength(0)

  for (const dangerousParen of [
    '(SELECT * FROM mysql.user LIMIT 1) UNION (SELECT 1)',
    "(SELECT * FROM order_records INTO OUTFILE '/tmp/out.txt')",
  ]) {
    const blocked = await f.runTool('database_query', {
      connection_id: f.dbId,
      sql: dangerousParen,
    })
    expect(blocked.isError, dangerousParen).toBe(true)
  }
  expect(f.prompts).toHaveLength(0)

  // 先在只读连接上对普通建表授予本会话完整访问提权。
  f.setDecision('session')
  const created = await f.runTool('database_mutate', {
    connection_id: f.dbId,
    sql: 'CREATE TABLE IF NOT EXISTS mydsh_elevate_demo (id BIGINT PRIMARY KEY)',
  })
  expect(created.isError).toBe(false)
  expect(created.value.authorization).toBe('elevated-session')
  expect(f.prompts).toHaveLength(1)

  const destructiveStatements = [
    'CREATE DATABASE mydsh_probe_tmp',
    'ALTER DATABASE mydsh_probe_tmp CHARACTER SET utf8mb4',
    'DROP DATABASE mydsh_probe_tmp',
    'DROP TABLE mydsh_elevate_demo',
    'DROP VIEW IF EXISTS v_orders',
    'TRUNCATE TABLE mydsh_elevate_demo',
    'DELETE FROM mydsh_elevate_demo',
    'UPDATE mydsh_elevate_demo SET id = 1',
    'WITH cte AS (SELECT id FROM mydsh_elevate_demo WHERE id = 1) UPDATE mydsh_elevate_demo SET id = 2',
  ]

  // 即使已获得会话级完整访问提权，上述每一条破坏性/库级语句都必须逐次单独确认，且不提供会话级按钮。
  f.setDecision('allow-once')
  let expectedPrompts = 1
  for (const sql of destructiveStatements) {
    const res = await f.runTool('database_mutate', { connection_id: f.dbId, sql })
    expectedPrompts++
    expect(res.isError, sql).toBe(false)
    expect(res.value.authorization, sql).toBe('approved-once')
    expect(f.prompts, sql).toHaveLength(expectedPrompts)
    const options = f.prompts.at(-1).questions[0].options
    expect(
      options.map(item => item.label),
      sql,
    ).not.toContain('本次会话允许该提权')
    expect(
      options.map(item => item.label),
      sql,
    ).not.toContain('本次会话允许该连接变更')
    expect(options, sql).toHaveLength(2)
  }
})
