import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { LocalCredentialProvider } from '../packages/credentials/credentials-local/lib/index.js'
import { DatabaseConnections } from '../packages/connections/database/lib/index.js'
import { removeFixtureContainer, verifyConnections } from '../scripts/verify-connections.mjs'
import { isUntrustedCertificateError } from '../scripts/connections-verification/tls-errors.mjs'
import { admitReadQuery } from '../packages/connections/database/src/read-query.ts'

it('数据库读取子集允许单表筛选，拒绝文件函数、导出和拼接写入', () => {
  expect(
    admitReadQuery(
      "SELECT id, COUNT(*) AS total FROM samples WHERE note = '中文' GROUP BY id ORDER BY id LIMIT 20;",
    ),
  ).toContain('GROUP BY id')
  expect(() => admitReadQuery("SELECT LOAD_FILE('/etc/passwd')")).toThrow('只读子集')
  expect(() => admitReadQuery("SELECT id FROM samples INTO OUTFILE '/tmp/data'")).toThrow(
    '只读子集',
  )
  expect(() => admitReadQuery('SELECT id FROM samples; DELETE FROM samples')).toThrow('只读子集')
})

it.skipIf(process.platform !== 'darwin')(
  '数据库保存显式 TLS 开关，旧记录缺失开关时仍保持严格 TLS',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mydsh-database-tls-')),
      ctx = new Context()
    try {
      ctx.provide('mydshConnectionSystem', {
        token: '测试窗口',
        call: async () => ({ sealed: true }),
      })
      ctx.provide('mydshSsh', {})
      await ctx
        .plugin(LocalCredentialProvider, {
          path: join(directory, 'credentials.yaml'),
          watch: false,
        })
        .await()
      await ctx.plugin(DatabaseConnections).await()
      const request = {
        id: null,
        revision: null,
        name: '普通连接',
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
        password: '测试密码',
      }
      const saved = await ctx.mydshDatabase.save('测试窗口', request)
      expect(saved.tlsEnabled).toBe(false)
      await ctx.credentials.modifyRecord(`mydsh-database/connection-${saved.id}`, async current => {
        const profile = { ...current.payload.profile, tlsServerName: 'localhost' }
        delete profile.tlsEnabled
        return { ...current, payload: { ...current.payload, profile } }
      })
      expect((await ctx.mydshDatabase.status('测试窗口')).connections[0].tlsEnabled).toBe(true)
      await expect(
        ctx.mydshDatabase.save('测试窗口', {
          ...request,
          id: saved.id,
          revision: saved.revision,
          tlsEnabled: undefined,
        }),
      ).rejects.toThrow('TLS 设置')
      expect((await ctx.mydshDatabase.status('测试窗口')).connections[0].tlsEnabled).toBe(true)
    } finally {
      await ctx.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  },
)

describe('MySQL 不受信任证书的拒绝断言', () => {
  it('识别不同 Node 版本的自签名证书和证书链拒绝，不要求固定连字符', () => {
    for (const message of [
      'self-signed certificate',
      'self signed certificate',
      'self-signed certificate in certificate chain',
      'self signed certificate in certificate chain',
      'unable to verify first certificate',
      'unable to verify the first certificate',
    ])
      expect(isUntrustedCertificateError({ code: 'HANDSHAKE_SSL_ERROR', message })).toBe(true)
  })

  it('不将连接、认证、身份或其他 TLS 错误当成证书链拒绝', () => {
    for (const error of [
      null,
      {},
      { code: 'HANDSHAKE_SSL_ERROR' },
      { code: 'ECONNRESET', message: 'self signed certificate' },
      { code: 'ER_ACCESS_DENIED_ERROR', message: 'Access denied' },
      { code: 'HANDSHAKE_SSL_ERROR', message: "Hostname/IP does not match certificate's altnames" },
      { code: 'HANDSHAKE_SSL_ERROR', message: 'unsupported protocol' },
      { code: 'HANDSHAKE_SSL_ERROR', message: 'unable to verify unrelated data' },
    ])
      expect(isUntrustedCertificateError(error)).toBe(false)
  })
})

describe('连接验收夹具所有权', () => {
  it('没有本次容器时不执行删除', () => {
    const run = vi.fn(() => '')
    removeFixtureContainer('mydsh-fixture-test', 'test-owner', run)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('名称或标签不匹配时保留容器', () => {
    for (const record of [
      {
        Id: 'owned-id',
        Name: '/another-container',
        Config: { Labels: { 'mydsh.connections-verification': 'test-owner' } },
      },
      {
        Id: 'owned-id',
        Name: '/mydsh-fixture-test',
        Config: { Labels: { 'mydsh.connections-verification': 'another-owner' } },
      },
    ]) {
      const run = vi
        .fn()
        .mockReturnValueOnce('owned-id')
        .mockReturnValueOnce(JSON.stringify([record]))
      expect(() => removeFixtureContainer('mydsh-fixture-test', 'test-owner', run)).toThrow(
        '所有权不匹配',
      )
      expect(run).toHaveBeenCalledTimes(2)
    }
  })

  it('匹配后按确认的容器 ID 删除，并确认没有残留', () => {
    const record = {
      Id: 'owned-id',
      Name: '/mydsh-fixture-test',
      Config: { Labels: { 'mydsh.connections-verification': 'test-owner' } },
    }
    const run = vi
      .fn()
      .mockReturnValueOnce('owned-id')
      .mockReturnValueOnce(JSON.stringify([record]))
      .mockReturnValueOnce('owned-id')
      .mockReturnValueOnce('')
    removeFixtureContainer('mydsh-fixture-test', 'test-owner', run)
    expect(run).toHaveBeenNthCalledWith(3, 'docker', ['rm', '-f', 'owned-id'])
    expect(run).toHaveBeenCalledTimes(4)
  })

  it('Docker 不可用或删除后仍有残留时不伪报清理成功', () => {
    expect(() =>
      removeFixtureContainer('mydsh-fixture-test', 'test-owner', () => {
        throw new Error('Docker 不可用')
      }),
    ).toThrow('Docker 不可用')
    const record = {
      Id: 'owned-id',
      Name: '/mydsh-fixture-test',
      Config: { Labels: { 'mydsh.connections-verification': 'test-owner' } },
    }
    const run = vi
      .fn()
      .mockReturnValueOnce('owned-id')
      .mockReturnValueOnce(JSON.stringify([record]))
      .mockReturnValueOnce('')
      .mockReturnValueOnce('owned-id')
    expect(() => removeFixtureContainer('mydsh-fixture-test', 'test-owner', run)).toThrow(
      '仍未删除',
    )
  })
})

describe('连接验收命令入口', () => {
  it('无效模式在准备夹具前被拒绝', async () => {
    await expect(verifyConnections('invalid')).rejects.toThrow('模式无效')
  })

  it('帮助说明真实 Electron 和 Node 回归的区别，不启动夹具', () => {
    const output = execFileSync(process.execPath, ['scripts/verify-connections.mjs', '--help'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 5000,
    })
    expect(output).toContain('默认验证真实 Electron utilityProcess')
    expect(output).toContain('--node 仅用于协议回归')
  })
})
