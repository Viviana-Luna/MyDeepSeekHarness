import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { LocalCredentialProvider } from '../packages/credentials/credentials-local/lib/index.js'
import { connectionSystem } from '../src/main/connections/connection-system.ts'
import { sealCredential, openCredential } from '../src/main/connections/credential-envelope.ts'
import {
  createLocalKeyStorage,
  resolveLocalMasterKey,
} from '../src/main/connections/local-secret-key.ts'
import {
  removeTestKeychainItem,
  testKeychainItemExists,
} from '../scripts/verify-connection-credentials.mjs'

const mockElectron = vi.hoisted(() => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value, 'utf8'),
    decryptString: vi.fn(() => {
      throw new Error('不应再调用系统钥匙串')
    }),
  },
}))

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  dialog: { showOpenDialog: vi.fn() },
  default: {
    safeStorage: mockElectron.safeStorage,
    app: { getPath: () => tmpdir() },
    dialog: { showOpenDialog: vi.fn() },
  },
}))
vi.mock('../src/main/window-controls.ts', () => ({
  cancelDirectorySheet: vi.fn(),
  cancelFileSheet: vi.fn(),
}))

const binding = { connectionId: '8ea2df7a-2b7d-4f2b-9b68-438443a89472', purpose: 'ssh-password' }
const secret = '仅用于测试的密码🔒\n第二行'

// 不模拟系统加密强度：只把随机句柄映射到测试密钥，系统钥匙串另由真实 Electron 验证。
function fakeStorage() {
  const keys = new Map()
  return {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn(value => {
      const handle = randomBytes(32)
      keys.set(handle.toString('base64'), value)
      return handle
    }),
    decryptString: vi.fn(value => {
      const key = keys.get(value.toString('base64'))
      if (!key) throw new Error('测试系统密钥不存在')
      return key
    }),
  }
}

describe('连接凭据版本化密文候选', () => {
  it.each(['', secret, 'x'.repeat(65536)])(
    '可恢复允许范围内的内容，重复加密不复用密钥或 nonce（用例 %#）',
    value => {
      const storage = fakeStorage()
      const first = sealCredential(value, binding, storage),
        second = sealCredential(value, binding, storage)
      expect(openCredential(first, binding, storage)).toBe(value)
      expect(first).toMatchObject({
        format: 'mydsh-connection-secret',
        version: 1,
        algorithm: 'aes-256-gcm',
      })
      expect(first.wrappedKey).not.toBe(second.wrappedKey)
      expect(first.nonce).not.toBe(second.nonce)
      if (value) expect(JSON.stringify(first)).not.toContain(value)
    },
  )

  it('拒绝错误身份和用途，密文不能挪到另一条连接或另一个凭据字段', () => {
    const storage = fakeStorage(),
      envelope = sealCredential(secret, binding, storage)
    for (const other of [
      { ...binding, connectionId: '2bfbfb67-d2f1-4ef9-bcd1-11cdc3ce8100' },
      { ...binding, purpose: 'database-password' },
    ])
      expect(() => openCredential(envelope, other, storage)).toThrow('校验失败')
    expect(openCredential(envelope, binding, storage)).toBe(secret)
  })

  it.each(['wrappedKey', 'nonce', 'tag', 'ciphertext'])('拒绝 %s 的单字节篡改', field => {
    const storage = fakeStorage(),
      envelope = sealCredential(secret, binding, storage)
    const bytes = Buffer.from(envelope[field], 'base64')
    bytes[0] ^= 1
    expect(() =>
      openCredential({ ...envelope, [field]: bytes.toString('base64') }, binding, storage),
    ).toThrow('校验失败')
  })

  it('未知版本、算法、明文降级或额外字段在访问系统密钥前拒绝', () => {
    const storage = fakeStorage(),
      envelope = sealCredential(secret, binding, storage)
    for (const patch of [
      { version: 2 },
      { version: '1' },
      { format: 'unknown' },
      { algorithm: 'aes-256-cbc' },
      { protection: 'plaintext' },
      { plaintext: secret },
    ]) {
      expect(() => openCredential({ ...envelope, ...patch }, binding, storage)).toThrow('不受支持')
    }
    expect(storage.decryptString).not.toHaveBeenCalled()
  })

  it('拒绝非规范编码、截短字段及过大的密文，不提前解密', () => {
    const storage = fakeStorage(),
      envelope = sealCredential(secret, binding, storage)
    for (const patch of [
      { wrappedKey: '' },
      { nonce: envelope.nonce + '\n' },
      { tag: 'AAAA' },
      { ciphertext: '?' },
      { ciphertext: Buffer.alloc(65537).toString('base64') },
    ]) {
      expect(() => openCredential({ ...envelope, ...patch }, binding, storage)).toThrow('编码无效')
    }
    expect(storage.decryptString).not.toHaveBeenCalled()
  })

  it('拒绝无效身份、用途、非字符串、非法 Unicode 和过大明文', () => {
    const storage = fakeStorage()
    for (const value of [null, { password: secret }, '\ud800', '中'.repeat(22000)]) {
      expect(() => sealCredential(value, binding, storage)).toThrow('内容无效')
    }
    for (const value of [
      null,
      { ...binding, connectionId: '../other' },
      { ...binding, purpose: 'model-key' },
    ]) {
      expect(() => sealCredential(secret, value, storage)).toThrow('绑定信息无效')
    }
    expect(storage.encryptString).not.toHaveBeenCalled()
  })

  it('系统不可用或明文后端时拒绝加密和解密，不产生回退记录', () => {
    const storage = fakeStorage(),
      envelope = sealCredential(secret, binding, storage)
    for (const unavailable of [
      { ...storage, isEncryptionAvailable: () => false },
      { ...storage, getSelectedStorageBackend: () => 'basic_text' },
    ]) {
      expect(() => sealCredential(secret, binding, unavailable)).toThrow('未生成可保存记录')
      expect(() => openCredential(envelope, binding, unavailable)).toThrow('校验失败')
    }
    expect(storage.encryptString).toHaveBeenCalledTimes(1)
    expect(storage.decryptString).not.toHaveBeenCalled()
  })

  it('错误、丢失和异常密钥均拒绝；错误信息不带明文或原始异常', () => {
    const storage = fakeStorage(),
      envelope = sealCredential(secret, binding, storage)
    for (const decryptString of [
      () => randomBytes(32).toString('base64'),
      () => 'invalid',
      () => {
        throw new Error(secret)
      },
    ]) {
      let caught
      try {
        openCredential(envelope, binding, { ...storage, decryptString })
      } catch (error) {
        caught = error
      }
      expect(caught?.message).toContain('校验失败')
      expect(caught?.message).not.toContain(secret)
      expect(caught?.cause).toBeUndefined()
    }
    expect(() => openCredential(envelope, binding, fakeStorage())).toThrow('校验失败')
    const broken = {
      ...storage,
      encryptString: () => {
        throw new Error(secret)
      },
    }
    expect(() => sealCredential(secret, binding, broken)).toThrow(
      /^凭据加密失败，未生成可保存记录。$/,
    )
    expect(() =>
      sealCredential(secret, binding, { ...storage, encryptString: () => secret }),
    ).toThrow('加密失败')
  })
})

describe('复用真实文件凭据提供方', () => {
  it('密文与既有模型记录共存，失败不覆盖，重新装配后恢复，删除不影响旧记录', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mydsh-credentials-provider-'))
    const path = join(directory, 'credentials.yaml'),
      storage = fakeStorage()
    const key = 'mydsh-connections/test-password',
      oldKey = 'fixture-model/account'
    const previous = { kind: 'api-key', key: '仅用于测试的既有模型凭据' }
    let ctx = new Context()
    try {
      await ctx.plugin(LocalCredentialProvider, { path, watch: false }).await()
      await ctx.credentials.modifyRecord(oldKey, async () => previous)
      const record = { kind: 'grant', payload: sealCredential(secret, binding, storage) }
      await ctx.credentials.modifyRecord(key, async () => record)
      const before = await readFile(path, 'utf8')
      expect(before).not.toContain(secret)
      expect(before).toContain(previous.key)
      if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
      await expect(ctx.credentials.describeRecord(key)).resolves.toEqual({
        configured: true,
        writable: true,
        kind: 'grant',
      })
      await expect(
        ctx.credentials.modifyRecord(key, async () => ({
          kind: 'grant',
          payload: sealCredential('修改后的假密码', binding, {
            ...storage,
            isEncryptionAvailable: () => false,
          }),
        })),
      ).rejects.toThrow('加密失败')
      expect(await readFile(path, 'utf8')).toBe(before)
      await expect(ctx.credentials.readRecord(key)).resolves.toEqual(record)

      // POSIX 的真实写权限拒绝发生在取得锁之前；不把此项称作断电或 rename 故障验收。
      if (process.platform !== 'win32' && process.getuid() !== 0) {
        await chmod(directory, 0o500)
        try {
          await expect(ctx.credentials.modifyRecord(key, async () => record)).rejects.toMatchObject(
            { code: 'EACCES' },
          )
        } finally {
          await chmod(directory, 0o700)
        }
        expect(await readFile(path, 'utf8')).toBe(before)
        expect(await readdir(directory)).toEqual(['credentials.yaml'])
      }
      await ctx.fiber.dispose()
      ctx = new Context()
      await ctx.plugin(LocalCredentialProvider, { path, watch: false }).await()
      expect(
        openCredential((await ctx.credentials.readRecord(key)).payload, binding, storage),
      ).toBe(secret)
      await expect(ctx.credentials.readRecord(oldKey)).resolves.toEqual(previous)
      await ctx.credentials.deleteRecord(key)
      await expect(ctx.credentials.readRecord(key)).resolves.toBeUndefined()
      await expect(ctx.credentials.readRecord(oldKey)).resolves.toEqual(previous)
      expect(await readdir(directory)).toEqual(['credentials.yaml'])
    } finally {
      try {
        await ctx.fiber.dispose()
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  })
})

describe('测试钥匙串条目的所有权与清理', () => {
  const owner = { name: `mydsh-credentials-verify-${'a'.repeat(32)}`, absentBefore: true }

  it('拒绝非测试名称和没有事前独占依据的删除', () => {
    const run = vi.fn()
    expect(() => testKeychainItemExists('MyDSH', run)).toThrow('名称无效')
    expect(() => removeTestKeychainItem({ ...owner, absentBefore: false }, run)).toThrow('拒绝删除')
    expect(run).not.toHaveBeenCalled()
  })

  it('缺失时不删除，存在时精确匹配服务和账号并复核删除结果', () => {
    const absent = vi.fn(() => 44)
    removeTestKeychainItem(owner, absent)
    expect(absent).toHaveBeenCalledTimes(1)
    const run = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(44)
    removeTestKeychainItem(owner, run)
    expect(run).toHaveBeenNthCalledWith(2, [
      'delete-generic-password',
      '-s',
      `${owner.name} Safe Storage`,
      '-a',
      `${owner.name} Key`,
    ])
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('查询失败、删除失败或仍有残留时不伪报成功', () => {
    expect(() => testKeychainItemExists(owner.name, () => 1)).toThrow('无法确认')
    expect(() =>
      removeTestKeychainItem(owner, vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(1)),
    ).toThrow('未能清理')
    expect(() => removeTestKeychainItem(owner, () => 0)).toThrow('未能清理')
  })

  it('帮助入口不启动 Electron，说明钥匙串副作用和不读取实际凭据', () => {
    const output = execFileSync(
      process.execPath,
      ['scripts/verify-connection-credentials.mjs', '--help'],
      { encoding: 'utf8', timeout: 5000 },
    )
    expect(output).toContain('两个真实 Electron 进程')
    expect(output).toContain('创建并清理随机名称的测试钥匙串条目')
    expect(output).toContain('不读取实际凭据')
  })
})

describe('本地主密钥与免钥匙串信封封装', () => {
  it('按 0700/0600 首次生成并稳定复用 32 字节本地主密钥，allowCreate=false 时不自动创建', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mydsh-local-key-'))
    const keyDir = join(root, 'connection-secrets')
    try {
      await expect(resolveLocalMasterKey(keyDir, false)).rejects.toThrow('不存在')
      const created = await resolveLocalMasterKey(keyDir, true)
      expect(created.length).toBe(32)
      const keyPath = join(keyDir, 'secret.key')
      if (process.platform !== 'win32') {
        expect((await stat(keyDir)).mode & 0o777).toBe(0o700)
        expect((await stat(keyPath)).mode & 0o777).toBe(0o600)
      }
      const reloaded = await resolveLocalMasterKey(keyDir, false)
      expect(Buffer.compare(created, reloaded)).toBe(0)

      const storage = createLocalKeyStorage(reloaded)
      const envelope = sealCredential(secret, binding, storage)
      expect(envelope.protection).toBe('local-key-file')
      expect(openCredential(envelope, binding, storage)).toBe(secret)
      expect(() => openCredential(envelope, binding, fakeStorage())).toThrow('无法解密或校验失败')
      created.fill(0)
      reloaded.fill(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('拒绝符号链接目录与密钥文件，并在密钥文件损坏时保留原文件不覆盖', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mydsh-local-key-guard-'))
    const realKey = join(root, 'target.key')
    const linkDir = join(root, 'link-dir')
    const guardDir = join(root, 'guard-dir')
    try {
      await writeFile(realKey, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 })
      // Windows 普通用户无文件软链特权，目录与密钥路径均可通过 junction 验证符号链接拦截。
      await symlink(root, linkDir, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(resolveLocalMasterKey(linkDir, true)).rejects.toThrow('符号链接')

      await resolveLocalMasterKey(guardDir, true).then(buf => buf.fill(0))
      await writeFile(join(guardDir, 'secret.key'), 'corrupted-key-content\n', { mode: 0o600 })
      await expect(resolveLocalMasterKey(guardDir, true)).rejects.toThrow('已保留原文件')
      expect(await readFile(join(guardDir, 'secret.key'), 'utf8')).toBe('corrupted-key-content\n')

      await rm(join(guardDir, 'secret.key'))
      if (process.platform === 'win32') {
        await symlink(root, join(guardDir, 'secret.key'), 'junction')
      } else {
        await symlink(realKey, join(guardDir, 'secret.key'))
      }
      await expect(resolveLocalMasterKey(guardDir, true)).rejects.toThrow('符号链接')

      // 超过 256 字节的异常文件在读取前直接拒绝，避免内存滥用。
      await rm(join(guardDir, 'secret.key'))
      await writeFile(join(guardDir, 'secret.key'), 'a'.repeat(512), { mode: 0o600 })
      await expect(resolveLocalMasterKey(guardDir, false)).rejects.toThrow('已保留原文件')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('并发首次初始化本地主密钥时共享原子创建结果，各调用方拿到独立且一致的 32 字节密钥', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mydsh-local-key-concurrent-'))
    const keyDir = join(root, 'connection-secrets')
    try {
      const keys = await Promise.all(
        Array.from({ length: 6 }, () => resolveLocalMasterKey(keyDir, true)),
      )
      expect(keys).toHaveLength(6)
      const baseline = Buffer.from(keys[0])
      for (const key of keys) {
        expect(key.length).toBe(32)
        expect(Buffer.compare(key, baseline)).toBe(0)
      }
      // 抹零单个调用方的 Buffer 不应污染其他并发调用方的副本。
      keys[0].fill(0)
      expect(Buffer.compare(keys[1], baseline)).toBe(0)
      for (const key of keys) key.fill(0)
      baseline.fill(0)
      expect(await readdir(keyDir)).toEqual(['secret.key'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('connectionSystem 写入 local-key-file 且拒绝读取旧版钥匙串并彻底不调用 safeStorage', async () => {
    mockElectron.safeStorage.decryptString.mockClear()
    const root = await mkdtemp(join(tmpdir(), 'mydsh-conn-system-'))
    try {
      const signal = AbortSignal.timeout(5000)
      const envelope = await connectionSystem(
        'database.seal',
        { connectionId: binding.connectionId, purpose: 'database-password', secret: 'db-pass-123' },
        signal,
        { localKeyDirectory: root },
      )
      expect(envelope).toMatchObject({ protection: 'local-key-file' })
      await expect(
        connectionSystem(
          'database.open',
          { connectionId: binding.connectionId, purpose: 'database-password', envelope },
          signal,
          { localKeyDirectory: root },
        ),
      ).resolves.toBe('db-pass-123')

      const legacy = sealCredential(
        'legacy-secret',
        { connectionId: binding.connectionId, purpose: 'database-password' },
        {
          isEncryptionAvailable: () => true,
          encryptString: value => Buffer.from(value, 'utf8'),
          decryptString: value => value.toString('utf8'),
        },
      )
      expect(legacy.protection).toBe('electron-safe-storage')
      await expect(
        connectionSystem(
          'database.open',
          { connectionId: binding.connectionId, purpose: 'database-password', envelope: legacy },
          signal,
          { localKeyDirectory: root },
        ),
      ).rejects.toThrow('编辑连接')
      await expect(
        connectionSystem(
          'database.open',
          {
            connectionId: binding.connectionId,
            purpose: 'database-password',
            envelope: { ...legacy, protection: 'unknown-backend' },
          },
          signal,
          { localKeyDirectory: root },
        ),
      ).rejects.toThrow('凭据格式无效')
      expect(mockElectron.safeStorage.decryptString).toHaveBeenCalledTimes(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
