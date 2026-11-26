/** 真实 node:sqlite 与 Worker 隔离端到端测试：验证读写、精确类型、系统表拦截、取消中止、事务回滚及内部路径封禁。 */
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalCredentialProvider } from '../packages/credentials/credentials-local/lib/index.js'
import { ConnectionAccess } from '../packages/connections/access/lib/index.js'
import { SshConnections } from '../packages/connections/ssh/lib/index.js'
import { DatabaseConnections } from '../packages/connections/database/lib/index.js'
import { validateSqliteFilePath } from '../packages/connections/database/src/drivers/sqlite-path.ts'
import {
  executeSqliteDatabaseBatch,
  readSqliteDatabase,
} from '../packages/connections/database/src/drivers/sqlite-driver.ts'
import { admitMutateStatements } from '../packages/connections/database/src/write-query.ts'

const cleanups = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()()
  }
})

async function createTempSqliteDb() {
  const dir = await mkdtemp(join(tmpdir(), 'mydsh-sqlite-e2e-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'sample.db')
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(`
      CREATE TABLE items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        big_id INTEGER NOT NULL,
        raw_blob BLOB,
        note TEXT
      );
      CREATE INDEX idx_items_note ON items(note);
      CREATE VIEW item_notes AS SELECT id, note FROM items WHERE note IS NOT NULL;
      INSERT INTO items (big_id, raw_blob, note) VALUES
        (9007199254740993, X'DEADBEEF', 'alpha'),
        (42, NULL, NULL);
    `)
  } finally {
    db.close()
  }
  return { dir, dbPath }
}

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'win32')(
  'SQLite 真实驱动与服务全链路',
  () => {
    it('支持桌面连接测试、结构读取、精确 64 位整数/BLOB/NULL 与分页预览，且不留文件锁', async () => {
      const { dir, dbPath } = await createTempSqliteDb()
      const ctx = new Context()
      cleanups.push(() => ctx.fiber.dispose())
      ctx.provide('mydshConnectionSystem', {
        token: '桌面窗口凭证',
        call: async method => {
          if (method === 'database.pick-sqlite') return { path: dbPath }
          throw new Error(`不应请求凭据解密: ${method}`)
        },
      })
      await ctx
        .plugin(LocalCredentialProvider, { path: join(dir, 'credentials.yaml'), watch: false })
        .await()
      await ctx.plugin(ConnectionAccess).await()
      await ctx.plugin(SshConnections).await()
      await ctx.plugin(DatabaseConnections).await()

      expect(await ctx.mydshDatabase.pickSqliteFile('桌面窗口凭证')).toBe(dbPath)
      const saved = await ctx.mydshDatabase.save('桌面窗口凭证', {
        id: null,
        revision: null,
        engine: 'sqlite',
        name: '本地业务 SQLite',
        host: '',
        port: 0,
        username: '',
        database: null,
        filePath: dbPath,
        tlsEnabled: false,
        tlsServerName: '',
        tlsCa: '',
        sshConnectionId: null,
        environment: '测试',
        projectId: null,
        disabled: false,
        agentAccess: { enabled: true, mode: 'full', tableRules: [] },
      })
      expect(saved.engine).toBe('sqlite')
      expect(saved.credentialConfigured).toBe(true)

      const signal = AbortSignal.timeout(5000)
      const tested = await ctx.mydshDatabase.test('桌面窗口凭证', saved.id, signal)
      expect(tested.serverVersion).toMatch(/^SQLite \d+/u)
      expect(await ctx.mydshDatabase.databases('桌面窗口凭证', saved.id, signal)).toEqual(['main'])
      expect(await ctx.mydshDatabase.schemas('桌面窗口凭证', saved.id, null, signal)).toEqual([
        'main',
      ])
      expect(
        await ctx.mydshDatabase.tables('桌面窗口凭证', saved.id, null, 'main', signal),
      ).toEqual([
        { name: 'item_notes', kind: 'view' },
        { name: 'items', kind: 'table' },
      ])
      expect(
        await ctx.mydshDatabase.columns('桌面窗口凭证', saved.id, null, 'main', 'items', signal),
      ).toEqual([
        { name: 'id', type: 'INTEGER', nullable: false, key: 'PRI' },
        { name: 'big_id', type: 'INTEGER', nullable: false, key: '' },
        { name: 'raw_blob', type: 'BLOB', nullable: true, key: '' },
        { name: 'note', type: 'TEXT', nullable: true, key: '' },
      ])

      const preview = await ctx.mydshDatabase.preview(
        '桌面窗口凭证',
        saved.id,
        null,
        'main',
        'items',
        0,
        10,
        signal,
      )
      expect(preview.rows).toEqual([
        ['1', '9007199254740993', '0xdeadbeef', 'alpha'],
        ['2', '42', null, null],
      ])

      const structCols = await DatabaseConnections.readStructure(ctx.mydshDatabase, saved.id, {
        structure: { action: 'columns', schema: 'main', table: 'items', offset: 0, limit: 10 },
        signal,
      })
      expect(structCols.rows[0]).toEqual(['id', 'INTEGER', 'NO', 'PRI'])
      const structIdx = await DatabaseConnections.readStructure(ctx.mydshDatabase, saved.id, {
        structure: { action: 'indexes', schema: 'main', table: 'items', offset: 0, limit: 10 },
        signal,
      })
      expect(structIdx.rows).toEqual([['idx_items_note', 'note', '1', '1']])

      // 手动只读查询必须拦截写语句与 sqlite_* 系统表，同时允许删除临时文件证明无文件锁残留。
      await expect(
        ctx.mydshDatabase.query(
          '桌面窗口凭证',
          saved.id,
          null,
          'main',
          'DELETE FROM items',
          signal,
        ),
      ).rejects.toThrow('只读子集')
      await expect(
        ctx.mydshDatabase.query(
          '桌面窗口凭证',
          saved.id,
          null,
          'main',
          'SELECT * FROM sqlite_master',
          signal,
        ),
      ).rejects.toThrow('系统保留表')

      await expect(rm(dbPath)).resolves.toBeUndefined()
    })

    it('支持事务性 DDL 与失败整体回滚，并在取消长查询时立即终止 Worker', async () => {
      const { dbPath } = await createTempSqliteDb()
      const profile = {
        id: '00000000-0000-4000-8000-000000000001',
        revision: 1,
        engine: 'sqlite',
        name: 'SQLite Worker 验证',
        host: '',
        port: 0,
        username: '',
        database: null,
        filePath: dbPath,
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

      // 1. 第一条建表、第二条违背非空约束失败 -> 整个事务回滚，第一张表不存在。
      const failingStatements = admitMutateStatements(
        {
          statements: [
            'CREATE TABLE created_before_fail (id INTEGER PRIMARY KEY)',
            'INSERT INTO items (big_id) VALUES (NULL)',
          ],
        },
        'main',
        'sqlite',
      )
      await expect(
        executeSqliteDatabaseBatch({
          profile,
          statements: failingStatements,
          signal: AbortSignal.timeout(5000),
        }),
      ).rejects.toThrow('已自动回滚整个批次')

      const tablesAfterRollback = await readSqliteDatabase({
        profile,
        sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'created_before_fail'",
        values: [],
        limit: 10,
        signal: AbortSignal.timeout(5000),
      })
      expect(tablesAfterRollback.rows).toEqual([])

      // 2. 递归 CTE 长查询在 Worker 中被 AbortController 立即终止，不阻塞事件循环。
      const controller = new AbortController()
      setTimeout(() => controller.abort(new Error('用户主动中止')), 80)
      const startedAt = Date.now()
      await expect(
        readSqliteDatabase({
          profile,
          sql: 'WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < 100000000) SELECT SUM(x) FROM cnt',
          values: [],
          limit: 10,
          signal: controller.signal,
        }),
      ).rejects.toThrow('用户主动中止')
      expect(Date.now() - startedAt).toBeLessThan(3000)
    })

    it('拒绝 MYDSH_HOME 内部路径、符号链接逃逸、目录与 WAL/SHM 临时文件', async () => {
      const mydshHome = await mkdtemp(join(tmpdir(), 'mydsh-protected-home-'))
      const outside = await mkdtemp(join(tmpdir(), 'mydsh-outside-sqlite-'))
      cleanups.push(
        () => rm(mydshHome, { recursive: true, force: true }),
        () => rm(outside, { recursive: true, force: true }),
      )
      const internalDb = join(mydshHome, 'sessions.db')
      const validDb = join(outside, 'valid.db')
      const walFile = join(outside, 'valid.db-wal')
      const escapeLink =
        process.platform === 'win32'
          ? join(outside, 'escape-dir', 'sessions.db')
          : join(outside, 'escape.db')
      await writeFile(internalDb, '')
      await writeFile(validDb, '')
      await writeFile(walFile, '')
      // Windows 非开发者模式无法创建文件符号链接，使用指向 MYDSH_HOME 的目录联接验证同一逃逸边界。
      if (process.platform === 'win32') {
        await symlink(mydshHome, join(outside, 'escape-dir'), 'junction')
      } else {
        await symlink(internalDb, escapeLink)
      }

      const previousHome = process.env.MYDSH_HOME
      process.env.MYDSH_HOME = mydshHome
      cleanups.push(async () => {
        if (previousHome === undefined) delete process.env.MYDSH_HOME
        else process.env.MYDSH_HOME = previousHome
      })

      await expect(validateSqliteFilePath(internalDb)).rejects.toThrow('禁止访问 MyDSH 内部数据')
      if (process.platform === 'darwin' || process.platform === 'win32') {
        const upperHome = mydshHome.replace(/mydsh-protected-home-/u, 'MYDSH-PROTECTED-HOME-')
        await expect(validateSqliteFilePath(join(upperHome, 'nested/future.db'))).rejects.toThrow(
          '禁止访问 MyDSH 内部数据',
        )
      }
      await expect(validateSqliteFilePath(escapeLink)).rejects.toThrow('符号链接')
      await expect(validateSqliteFilePath(walFile)).rejects.toThrow('-wal')
      await expect(validateSqliteFilePath(outside)).rejects.toThrow('普通文件')
      await expect(validateSqliteFilePath('relative.db')).rejects.toThrow('绝对路径')
      await expect(validateSqliteFilePath(':memory:')).rejects.toThrow('本地磁盘文件路径')
    })
  },
)
