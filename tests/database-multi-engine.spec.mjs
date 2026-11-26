/** 多数据库引擎方言、词法、安全硬边界、旧版兼容及 macOS/Windows 跨平台门禁测试。 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalCredentialProvider } from '../packages/credentials/credentials-local/lib/index.js'
import { SshConnections } from '../packages/connections/ssh/lib/index.js'
import { DatabaseConnections } from '../packages/connections/database/lib/index.js'
import {
  buildDesktopColumnsQuery,
  buildDesktopDatabasesQuery,
  buildDesktopSchemasQuery,
  buildDesktopTablesQuery,
  connectionDatabaseForRun,
  defaultDatabaseForEngine,
  defaultPortForEngine,
  formatVersionLabel,
  isSupportedConnectionPlatform,
  isSystemSchema,
  normalizeEngine,
  quoteIdentifier,
} from '../packages/connections/database/src/dialect.ts'
import {
  databaseStructureItems,
  databaseStructureQuery,
  filterStructureRows,
} from '../packages/connections/database/src/agent-structure.ts'
import { applyMysqlReadTimeout } from '../packages/connections/database/src/drivers/mysql-driver.ts'
import {
  assertPostgresTableRuleCatalogBoundary,
  resolveAgentSqlScope,
} from '../packages/connections/database/src/tools-format.ts'
import {
  scanSqlTokens,
  splitSqlStatements,
} from '../packages/connections/database/src/sql-tokens.ts'
import {
  admitReadQueries,
  admitReadQuery,
} from '../packages/connections/database/src/read-query.ts'
import { admitMutateStatements } from '../packages/connections/database/src/write-query.ts'
import {
  assertGeneralDatabaseSqlAllowed,
  classifyDatabaseSqlBatch,
} from '../packages/connections/database/src/query-execution.ts'
import { installRemoteController } from '../src/main/runtime/remote-controller.ts'

const { ipcHandlers } = vi.hoisted(() => ({
  ipcHandlers: new Map(),
}))

vi.mock('electron', () => ({
  default: {
    safeStorage: { isEncryptionAvailable: () => true },
  },
  ipcMain: {
    handle: (channel, handler) => {
      ipcHandlers.set(channel, handler)
    },
    removeHandler: channel => {
      ipcHandlers.delete(channel)
    },
  },
  dialog: { showOpenDialog: vi.fn() },
}))

afterEach(() => {
  vi.restoreAllMocks()
  ipcHandlers.clear()
})

describe('多数据库方言与词法安全边界', () => {
  it('规范化四引擎默认端口、标识符引号与版本号', () => {
    expect(normalizeEngine(undefined)).toBe('mysql')
    expect(defaultPortForEngine('postgresql')).toBe(5432)
    expect(defaultPortForEngine('mariadb')).toBe(3306)
    expect(defaultPortForEngine('sqlite')).toBe(0)
    expect(defaultDatabaseForEngine('postgresql')).toBe('postgres')
    expect(quoteIdentifier('order"items', 'postgresql')).toBe('"order""items"')
    expect(quoteIdentifier('order`items', 'mariadb')).toBe('`order``items`')
    expect(formatVersionLabel('postgresql', 'PostgreSQL 15.10 on aarch64-pc-linux-gnu')).toBe(
      'PostgreSQL 15.10',
    )
    expect(formatVersionLabel('sqlite', '3.50.4')).toBe('SQLite 3.50.4')
    expect(formatVersionLabel('mariadb', '11.4.2-MariaDB')).toBe('11.4.2-MariaDB')
  })

  it('PostgreSQL 与 SQLite 词法拒绝反斜杠逃逸、反引号、美元定界、E 转义和 # 伪注释', () => {
    // PostgreSQL 与 SQLite 中反斜杠不转义单引号，\' 会先闭合字面量而非吞掉后续语句。
    expect(
      splitSqlStatements("SELECT 'foo\\' ; DROP TABLE users", 10, 'postgresql').map(
        item => item.raw,
      ),
    ).toEqual(["SELECT 'foo\\'", 'DROP TABLE users'])
    expect(() => scanSqlTokens("SELECT 'foo\\' bar'", 100, 'postgresql')).toThrow('未闭合')
    expect(() => splitSqlStatements('SELECT `id` FROM users', 10, 'postgresql')).toThrow('反引号')
    expect(() => splitSqlStatements('SELECT $$hello$$', 10, 'postgresql')).toThrow('美元定界')
    expect(() => splitSqlStatements("SELECT E'\\x41'", 10, 'postgresql')).toThrow('扩展转义')
    for (const unicodeSql of [
      'SELECT * FROM U&"pg_c\\0061talog".pg_tables',
      "SELECT u&'\\0061bc'",
    ]) {
      expect(() => scanSqlTokens(unicodeSql, 100, 'postgresql')).toThrow('Unicode')
      expect(() => splitSqlStatements(unicodeSql, 10, 'postgresql')).toThrow('Unicode')
      expect(() => classifyDatabaseSqlBatch(unicodeSql, 10, 'postgresql')).toThrow('Unicode')
    }
    // # 在 PostgreSQL 不是注释，若将其误跳会放行注释后截断语句。
    expect(() => scanSqlTokens("SELECT 1 # 'unterminated", 100, 'postgresql')).toThrow('未闭合')

    // 支持嵌套 /* /* */ */ 注释中的语句切分。
    const pgBatch = classifyDatabaseSqlBatch(
      "/* outer /* inner */ */ SELECT id::text, name FROM public.users WHERE name ILIKE 'a%'",
      10,
      'postgresql',
    )
    expect(pgBatch.mode).toBe('read')
  })

  it('PostgreSQL 放行合法查询/ON CONFLICT/SCHEMA/DROP INDEX，严禁文件函数、EXPLAIN ANALYZE 变更和系统库', () => {
    expect(isSystemSchema('pg_catalog', 'postgresql')).toBe(true)
    expect(isSystemSchema('pg_temp_3', 'postgresql')).toBe(true)
    expect(isSystemSchema('public', 'postgresql')).toBe(false)

    expect(
      admitReadQuery(
        'SELECT id::bigint, amount::numeric(10,2) FROM "users" WHERE email ILIKE \'a%\' LIMIT 10',
        'postgresql',
      ),
    ).toContain('ILIKE')

    const pgMutate = admitMutateStatements(
      {
        statements: [
          'CREATE SCHEMA IF NOT EXISTS analytics',
          "INSERT INTO analytics.metrics (k, v) VALUES ('hits', 1) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v + 1 RETURNING k",
          'DROP INDEX IF EXISTS analytics.idx_metrics_k',
        ],
      },
      'public',
      'postgresql',
    )
    expect(pgMutate).toHaveLength(3)
    expect(pgMutate[0].risks[0]).toContain('事务中执行')

    expect(() =>
      assertGeneralDatabaseSqlAllowed("COPY users TO '/tmp/out.csv'", 'public', 'postgresql'),
    ).toThrow('不允许通过模型执行 COPY')
    expect(() =>
      assertGeneralDatabaseSqlAllowed("SELECT pg_read_file('/etc/passwd')", 'public', 'postgresql'),
    ).toThrow('服务端文件')
    expect(() =>
      assertGeneralDatabaseSqlAllowed('EXPLAIN ANALYZE DELETE FROM users', 'public', 'postgresql'),
    ).toThrow('只读查询')
    expect(() =>
      assertGeneralDatabaseSqlAllowed('CREATE DATABASE another_db', 'public', 'postgresql'),
    ).toThrow('单连接仅绑定一个数据库')
    expect(() =>
      admitReadQueries('SELECT * FROM pg_catalog.pg_tables', 'public', 'postgresql'),
    ).toThrow('系统库')
  })

  it('SQLite 拦截 PRAGMA、ATTACH、VACUUM 与 sqlite_* 系统表，支持 ON CONFLICT 与 DROP INDEX', () => {
    for (const forbidden of [
      "ATTACH DATABASE '/tmp/other.db' AS ext",
      'PRAGMA table_info(users)',
      "VACUUM INTO '/tmp/dump.db'",
      'TRUNCATE TABLE users',
    ]) {
      expect(() => classifyDatabaseSqlBatch(forbidden, 10, 'sqlite')).toThrow()
    }
    expect(() =>
      assertGeneralDatabaseSqlAllowed('SELECT name FROM "sqlite_master"', 'main', 'sqlite'),
    ).toThrow('系统保留表')
    expect(() =>
      admitMutateStatements(
        { statements: ['CREATE VIEW v AS SELECT "pg_read_file"(\'/etc/passwd\')'] },
        'public',
        'postgresql',
      ),
    ).toThrow('受限服务端函数')
    expect(() =>
      admitMutateStatements(
        { statements: ['CREATE TABLE t (x TEXT DEFAULT "load_extension"(\'ext\'))'] },
        'main',
        'sqlite',
      ),
    ).toThrow('受限服务端函数')

    const sqliteMutate = admitMutateStatements(
      {
        statements: [
          "INSERT OR REPLACE INTO kv (k, v) VALUES ('a', '1')",
          'DROP INDEX IF EXISTS main.idx_kv_v',
        ],
      },
      'main',
      'sqlite',
    )
    expect(sqliteMutate).toHaveLength(2)
  })
})

describe('跨平台解锁与历史连接兼容性', () => {
  it('平台白名单同时开放 macOS 与 Windows，拒绝 Linux', () => {
    expect(isSupportedConnectionPlatform('darwin')).toBe(true)
    expect(isSupportedConnectionPlatform('win32')).toBe(true)
    expect(isSupportedConnectionPlatform('linux')).toBe(false)
  })

  it('在模拟 win32 平台下 SSH 与数据库服务保持可用，旧版无 engine 记录自动兼容为 mysql', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mydsh-win32-compat-'))
    const sqliteFile = join(dir, 'local.db')
    await writeFile(sqliteFile, '')
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const ctx = new Context()
    try {
      ctx.provide('mydshConnectionSystem', {
        token: '窗口凭证',
        call: async () => ({ sealed: 'envelope' }),
      })
      await ctx
        .plugin(LocalCredentialProvider, { path: join(dir, 'credentials.yaml'), watch: false })
        .await()
      await ctx.plugin(SshConnections).await()
      await ctx.plugin(DatabaseConnections).await()

      expect((await ctx.mydshSsh.status('窗口凭证')).supported).toBe(true)
      const savedMysql = await ctx.mydshDatabase.save('窗口凭证', {
        id: null,
        revision: null,
        name: '遗留连接',
        host: '127.0.0.1',
        port: 3306,
        username: 'tester',
        database: null,
        tlsEnabled: false,
        tlsServerName: '',
        tlsCa: '',
        sshConnectionId: null,
        environment: '',
        projectId: null,
        disabled: false,
        password: 'pw',
      })
      // 模拟旧版持久化数据移除 engine 与 filePath 字段后读回仍应规范为 mysql / null。
      await ctx.credentials.modifyRecord(
        `mydsh-database/connection-${savedMysql.id}`,
        async cur => {
          const nextProfile = { ...cur.payload.profile }
          delete nextProfile.engine
          delete nextProfile.filePath
          return { ...cur, payload: { ...cur.payload, profile: nextProfile } }
        },
      )
      const status = await ctx.mydshDatabase.status('窗口凭证')
      expect(status.supported).toBe(true)
      expect(status.connections[0]).toMatchObject({ engine: 'mysql', filePath: null })

      // 编辑已有连接时禁止篡改引擎类型。
      await expect(
        ctx.mydshDatabase.save('窗口凭证', {
          id: savedMysql.id,
          revision: savedMysql.revision,
          engine: 'sqlite',
          name: '试图篡改',
          host: '',
          port: 0,
          username: '',
          database: null,
          filePath: sqliteFile,
          tlsEnabled: false,
          tlsServerName: '',
          tlsCa: '',
          sshConnectionId: null,
          environment: '',
          projectId: null,
          disabled: false,
        }),
      ).rejects.toThrow('不支持更改已有连接的数据库类型')
    } finally {
      await ctx.fiber.dispose()
      platformSpy.mockRestore()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('主进程 remote-controller 校验多引擎参数、SQLite 路径约束与 pickSqliteFile 方法白名单', async () => {
    const fakeWin = {
      isDestroyed: () => false,
      webContents: { send: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
    }
    const runtime = {
      getState: () => ({ kind: 'ready' }),
      subscribe: () => () => {},
      call: vi.fn(async () => ({ ok: true, value: { supported: true } })),
      follow: vi.fn(async () => {}),
    }
    const dispose = installRemoteController(fakeWin, runtime, () => {})
    try {
      const handler = ipcHandlers.get('mydsh:remote:call')
      await expect(handler({}, 'mydshDatabase/pickSqliteFile', {})).resolves.toEqual({
        supported: true,
      })
      await expect(
        handler({}, 'mydshDatabase/save', {
          request: {
            id: null,
            revision: null,
            engine: 'sqlite',
            name: 'local',
            host: '',
            port: 0,
            username: '',
            database: null,
            filePath: '/tmp/ok.db',
            tlsEnabled: false,
            tlsServerName: '',
            tlsCa: '',
            sshConnectionId: null,
            environment: '',
            projectId: null,
            disabled: false,
          },
        }),
      ).resolves.toEqual({ supported: true })

      // 非法引擎、SQLite 开启 TLS 或传相对路径均在主进程入口被拦截。
      await expect(
        handler({}, 'mydshDatabase/save', {
          request: {
            id: null,
            revision: null,
            engine: 'oracle',
            name: 'bad',
            host: '127.0.0.1',
            port: 1521,
            username: 'u',
            database: null,
            tlsEnabled: false,
            tlsServerName: '',
            tlsCa: '',
            sshConnectionId: null,
            environment: '',
            projectId: null,
            disabled: false,
          },
        }),
      ).rejects.toThrow('不支持的数据库类型')

      await expect(
        handler({}, 'mydshDatabase/save', {
          request: {
            id: null,
            revision: null,
            engine: 'sqlite',
            name: 'bad-tls',
            host: '',
            port: 0,
            username: '',
            database: null,
            filePath: '/tmp/ok.db',
            tlsEnabled: true,
            tlsServerName: '',
            tlsCa: '',
            sshConnectionId: null,
            environment: '',
            projectId: null,
            disabled: false,
          },
        }),
      ).rejects.toThrow('SQLite 本地数据库路径或附属参数无效')

      await expect(
        handler({}, 'mydshDatabase/save', {
          request: {
            id: null,
            revision: null,
            engine: 'sqlite',
            name: 'bad-password',
            host: '',
            port: 0,
            username: '',
            database: null,
            filePath: '/tmp/ok.db',
            tlsEnabled: false,
            tlsServerName: '',
            tlsCa: '',
            sshConnectionId: null,
            environment: '',
            projectId: null,
            disabled: false,
            password: 'secret',
          },
        }),
      ).rejects.toThrow('SQLite 本地数据库路径或附属参数无效')

      const validId = '00000000-0000-4000-8000-000000000001'
      await expect(handler({}, 'mydshDatabase/databases', { id: validId })).resolves.toEqual({
        supported: true,
      })
      await expect(
        handler({}, 'mydshDatabase/schemas', { id: validId, catalog: 'campus_meal' }),
      ).resolves.toEqual({ supported: true })
      await expect(
        handler({}, 'mydshDatabase/schemas', { id: validId, catalog: '' }),
      ).rejects.toThrow('数据库实例名称无效')
    } finally {
      dispose()
    }
  })

  it('PostgreSQL 四层实例/Schema/物化视图查询与 MySQL 业务库排序、超时变量回退一致', async () => {
    const pgDbSql = buildDesktopDatabasesQuery('postgresql').sql
    expect(pgDbSql).toContain('pg_database')
    expect(pgDbSql).toContain('WHERE datistemplate = false AND datallowconn = true ORDER BY')
    expect(pgDbSql).toContain(
      "ORDER BY CASE WHEN pg_catalog.has_database_privilege(oid, 'CONNECT') THEN 0 ELSE 1 END",
    )
    expect(pgDbSql).toContain("CASE WHEN datname = 'postgres' THEN 1 ELSE 0 END")

    expect(buildDesktopSchemasQuery('postgresql').sql).toContain(
      "WHEN schema_name = 'public' THEN 0",
    )
    expect(buildDesktopSchemasQuery('mysql').sql).toContain('information_schema.SCHEMATA')
    expect(buildDesktopTablesQuery('postgresql', 'app').sql).toContain('pg_catalog.pg_matviews')
    expect(buildDesktopColumnsQuery('postgresql', 'app', 'mv_daily').sql).toContain(
      'pg_catalog.pg_attribute',
    )

    const basePg = {
      id: 'pg-1',
      revision: 1,
      engine: 'postgresql',
      name: 'pg',
      host: '127.0.0.1',
      port: 5432,
      username: 'u',
      database: 'postgres',
      filePath: null,
      tlsEnabled: false,
      tlsServerName: '',
      tlsCa: '',
      sshConnectionId: null,
      environment: '',
      projectId: null,
      disabled: false,
      credentialConfigured: true,
      agentAccess: { enabled: true, mode: 'full', tableRules: [] },
    }
    expect(connectionDatabaseForRun(basePg, 'public', { catalog: 'campus_meal' })).toBe(
      'campus_meal',
    )
    expect(
      connectionDatabaseForRun({ ...basePg, engine: 'mysql', database: 'deleted_db' }, null, {
        omitDefaultDatabase: true,
      }),
    ).toBeNull()

    const access = basePg.agentAccess
    const dbPlan = databaseStructureQuery(
      access,
      { action: 'databases', offset: 0, limit: 20 },
      undefined,
      'postgresql',
    )
    expect(dbPlan.sql).toContain('pg_database')
    expect(dbPlan.sql).toContain("has_database_privilege(oid, 'CONNECT')")
    expect(
      filterStructureRows(
        access,
        { action: 'databases', offset: 0, limit: 20 },
        [['campus_meal'], ['template0']],
        { engine: 'postgresql' },
      ),
    ).toEqual([['campus_meal']])
    expect(
      databaseStructureItems('tables', [
        ['orders', 'BASE TABLE'],
        ['mv_daily', 'MATERIALIZED VIEW'],
      ]),
    ).toEqual([
      { name: 'orders', kind: 'table' },
      { name: 'mv_daily', kind: 'materialized_view' },
    ])
    expect(() =>
      databaseStructureQuery(
        access,
        { action: 'schemas', database: 'template1', offset: 0, limit: 20 },
        undefined,
        'postgresql',
      ),
    ).toThrow('系统模板库')
    expect(resolveAgentSqlScope(basePg, { database: 'campus_meal', schema: 'analytics' })).toEqual({
      catalog: 'campus_meal',
      defaultSchema: 'analytics',
    })

    // 模拟 MariaDB 连错选成 MySQL（或反之）遇到 ER_UNKNOWN_SYSTEM_VARIABLE (1193) 自动切换变量。
    const seenSql = []
    const fakeConn = {
      promise: () => ({
        query: async ({ sql }) => {
          seenSql.push(sql)
          if (seenSql.length === 1) {
            throw Object.assign(new Error('Unknown system variable'), { errno: 1193 })
          }
          return [[]]
        },
      }),
    }
    await applyMysqlReadTimeout(fakeConn, { ...basePg, engine: 'mysql' })
    expect(seenSql).toEqual([
      'SET SESSION max_execution_time = 20000',
      'SET SESSION max_statement_time = 20',
    ])
  })

  it('拦截首尾空白库名、系统 Schema、PostgreSQL 跨库表规则越界并按权限过滤物化视图与主键列', () => {
    const basePg = {
      id: 'pg-2',
      revision: 1,
      engine: 'postgresql',
      name: 'pg',
      host: '127.0.0.1',
      port: 5432,
      username: 'u',
      database: 'app_db',
      filePath: null,
      tlsEnabled: false,
      tlsServerName: '',
      tlsCa: '',
      sshConnectionId: null,
      environment: '',
      projectId: null,
      disabled: false,
      credentialConfigured: true,
      agentAccess: {
        enabled: true,
        mode: 'readonly',
        tableRules: [
          {
            schema: 'public',
            table: 'orders',
            select: true,
            insert: false,
            update: false,
            delete: false,
            ddl: false,
          },
        ],
      },
    }
    const access = basePg.agentAccess

    // 首尾空白绕过与系统 Schema 参数均直接拒绝。
    expect(() => resolveAgentSqlScope(basePg, { database: ' template1 ' })).toThrow('首尾空白')
    expect(() => resolveAgentSqlScope(basePg, { schema: 'pg_catalog' })).toThrow('系统库')
    expect(() =>
      databaseStructureQuery(
        access,
        { action: 'schemas', database: ' template1 ', offset: 0, limit: 20 },
        undefined,
        'postgresql',
      ),
    ).toThrow('首尾空白')
    expect(() =>
      databaseStructureQuery(
        access,
        { action: 'schemas', database: 'other_db', offset: 0, limit: 20 },
        undefined,
        'mysql',
      ),
    ).toThrow('不接受 database 参数')

    // 配置了表级规则的 PostgreSQL 连接禁止跨物理库访问。
    expect(() => assertPostgresTableRuleCatalogBoundary(basePg, 'other_db')).toThrow('表级规则')
    expect(() => assertPostgresTableRuleCatalogBoundary(basePg, 'app_db')).not.toThrow()
    expect(() => resolveAgentSqlScope(basePg, { database: 'other_db' })).toThrow('表级规则')

    // 物化视图与字段结构查询校验权限、表对象 relkind 且排除 INCLUDE 覆盖索引列。
    const tablesSql = databaseStructureQuery(
      access,
      { action: 'tables', schema: 'public', offset: 0, limit: 20 },
      undefined,
      'postgresql',
    ).sql
    expect(tablesSql).toContain("c.relkind = 'm'")
    expect(tablesSql).toContain('has_table_privilege')

    const columnsSql = databaseStructureQuery(
      access,
      { action: 'columns', schema: 'public', table: 'orders', offset: 0, limit: 20 },
      undefined,
      'postgresql',
    ).sql
    expect(columnsSql).toContain("c.relkind IN ('r', 'p', 'v', 'm', 'f')")
    expect(columnsSql).toContain('has_any_column_privilege')
    expect(columnsSql).toContain('(ix.indkey::int2[])[1:ix.indnkeyatts]')
    expect(buildDesktopColumnsQuery('postgresql', 'public', 'orders').sql).toContain(
      '(ix.indkey::int2[])[1:ix.indnkeyatts]',
    )
  })
})
