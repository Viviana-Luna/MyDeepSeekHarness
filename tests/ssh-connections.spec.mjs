import { createRequire } from 'node:module'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { LocalCredentialProvider } from '../packages/credentials/credentials-local/lib/index.js'
import { SshConnections } from '../packages/connections/ssh/lib/index.js'
import { sealCredential, openCredential } from '../src/main/connections/credential-envelope.ts'

const { Server, utils } = createRequire(
  new URL('../packages/connections/ssh/package.json', import.meta.url),
)('ssh2')
const token = '隔离窗口凭证',
  password = '仅用于SSH验收的密码'
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mydsh-ssh-test-')),
    ctx = new Context(),
    peers = new Set(),
    keys = new Map()
  const storage = {
    isEncryptionAvailable: () => true,
    encryptString: value => {
      const key = randomUUID()
      keys.set(key, value)
      return Buffer.from(key)
    },
    decryptString: value => {
      const key = keys.get(value.toString())
      if (!key) throw new Error('测试密钥不可用')
      return key
    },
  }
  let server,
    port = 0,
    clientKey
  const start = async () => {
    const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
      type: 'pkcs1',
      format: 'pem',
    })
    clientKey = hostKey
    const publicKey = utils.parseKey(clientKey)
    server = new Server({ hostKeys: [hostKey] }, peer => {
      peers.add(peer)
      peer.on('error', () => {})
      peer.once('close', () => peers.delete(peer))
      peer.on('authentication', auth => {
        const accepted =
          (auth.method === 'password' && auth.password === password) ||
          (auth.method === 'publickey' &&
            auth.key.data.equals(publicKey.getPublicSSH()) &&
            (!auth.signature ||
              publicKey.verify(auth.blob, auth.signature, auth.hashAlgo) === true))
        if (accepted) auth.accept()
        else auth.reject()
      })
      peer.on('ready', () =>
        peer.on('session', acceptSession => {
          const session = acceptSession()
          let stream
          session.on('pty', accept => accept())
          session.on('window-change', (accept, _reject, size) => {
            accept?.()
            stream?.write(`尺寸 ${size.cols}×${size.rows}\r\n`)
          })
          session.on('shell', accept => {
            stream = accept()
            stream.write('隔离 SSH 已连接\r\n')
            stream.on('data', data => stream.write(data))
          })
        }),
      )
    })
    server.listen(port, '127.0.0.1')
    await once(server, 'listening')
    port = server.address().port
  }
  await start()
  ctx.provide('mydshConnectionSystem', {
    token,
    call: async (method, value) =>
      method === 'ssh.import-key'
        ? sealCredential(
            clientKey,
            { connectionId: value.connectionId, purpose: 'ssh-private-key' },
            storage,
          )
        : method === 'ssh.seal'
          ? sealCredential(value.secret, value, storage)
          : openCredential(value.envelope, value, storage),
  })
  await ctx
    .plugin(LocalCredentialProvider, { path: join(directory, 'credentials.yaml'), watch: false })
    .await()
  await ctx.plugin(SshConnections).await()
  const request = {
    id: null,
    revision: null,
    name: '测试服务器',
    host: '127.0.0.1',
    port,
    username: 'tester',
    auth: 'password',
    environment: '测试',
    projectId: null,
    disabled: false,
    password,
  }
  return {
    ctx,
    directory,
    peers,
    request,
    service: ctx.mydshSsh,
    storage,
    rotate: async () => {
      await new Promise(resolve => server.close(resolve))
      await start()
    },
    dispose: async () => {
      try {
        await ctx.fiber.dispose()
        await vi.waitFor(() => expect(peers.size).toBe(0))
      } finally {
        for (const peer of peers) peer.end()
        await new Promise(resolve => server.close(resolve))
        await rm(directory, { recursive: true, force: true })
      }
    },
  }
}

it('导入私钥、确认指纹、认证、终端往返和尺寸同步复用真实 SSH，删除后释放资源及凭据', async () => {
  const f = await fixture(),
    signal = new AbortController()
  try {
    let saved = await f.service.save(token, { ...f.request, auth: 'key', password: undefined })
    saved = await f.service.importKey(token, saved.id, saved.revision, signal.signal)
    expect(await readFile(join(f.directory, 'credentials.yaml'), 'utf8')).not.toContain(password)
    expect(await readFile(join(f.directory, 'credentials.yaml'), 'utf8')).not.toContain(
      'BEGIN RSA PRIVATE KEY',
    )
    const probe = await f.service.connect(token, saved.id, false, 80, 24, signal.signal)
    expect(probe.kind).toBe('confirm-host')
    expect((await f.service.status(token)).terminals).toHaveLength(0)
    const trusted = await f.service.trustHost(token, saved.id, probe.revision, probe.fingerprint)
    const result = await f.service.connect(token, saved.id, false, 80, 24, signal.signal)
    expect(result.kind).toBe('terminal')
    const output = [],
      stream = new AbortController()
    const following = (async () => {
      for await (const event of f.service.events(token, result.terminal.id, stream.signal))
        output.push(event)
    })()
    await f.service.input(token, result.terminal.id, '中文终端输入\r\n')
    f.service.resize(token, result.terminal.id, 120, 40)
    await vi.waitFor(() => {
      const text = output.map(event => event.data ?? '').join('')
      expect(text).toContain('中文终端输入')
      expect(text).toContain('尺寸 120×40')
    })
    await f.service.remove(token, saved.id, trusted.revision)
    await following
    expect(await f.service.status(token)).toMatchObject({ connections: [], terminals: [] })
    expect(
      (await f.ctx.credentials.listRecords()).filter(item => item.key.startsWith('mydsh-ssh/')),
    ).toHaveLength(0)
  } finally {
    await f.dispose()
  }
})

it('拒绝非桌面调用、保存失败、错误认证和主机变化；取消握手不留下连接', async () => {
  const f = await fixture(),
    signal = new AbortController()
  let blocked, socket
  try {
    await expect(f.service.save('其他调用者', f.request)).rejects.toThrow('桌面窗口')
    const saved = await f.service.save(token, { ...f.request, password: '错误密码' })
    const before = await readFile(join(f.directory, 'credentials.yaml'), 'utf8')
    f.storage.isEncryptionAvailable = () => false
    await expect(
      f.service.save(token, { ...f.request, id: saved.id, revision: saved.revision }),
    ).rejects.toThrow('加密失败')
    expect(await readFile(join(f.directory, 'credentials.yaml'), 'utf8')).toBe(before)
    f.storage.isEncryptionAvailable = () => true
    const probe = await f.service.connect(token, saved.id, true, 80, 24, signal.signal)
    const trusted = await f.service.trustHost(token, saved.id, probe.revision, probe.fingerprint)
    await expect(f.service.connect(token, saved.id, true, 80, 24, signal.signal)).rejects.toThrow(
      'authentication',
    )
    await vi.waitFor(() => expect(f.peers.size).toBe(0))
    await f.rotate()
    await expect(f.service.connect(token, saved.id, true, 80, 24, signal.signal)).rejects.toThrow(
      '指纹不匹配',
    )
    blocked = createServer(value => {
      socket = value
      value.on('error', () => {})
    })
    blocked.listen(0, '127.0.0.1')
    await once(blocked, 'listening')
    const changed = await f.service.save(token, {
      ...f.request,
      id: saved.id,
      revision: trusted.revision,
      port: blocked.address().port,
    })
    const cancel = new AbortController()
    const pending = expect(
      f.service.connect(token, changed.id, false, 80, 24, cancel.signal),
    ).rejects.toThrow('取消')
    await vi.waitFor(() => expect(socket).toBeTruthy())
    cancel.abort(new Error('用户取消连接'))
    await pending
    socket.resume()
    await vi.waitFor(() => expect(socket.destroyed).toBe(true))
    expect((await f.service.status(token)).terminals).toHaveLength(0)
  } finally {
    socket?.destroy()
    if (blocked) await new Promise(resolve => blocked.close(resolve))
    await f.dispose()
  }
})
