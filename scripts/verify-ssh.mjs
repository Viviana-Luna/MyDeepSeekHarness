import { createRequire } from 'node:module'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { once } from 'node:events'
import { join, resolve as resolvePath } from 'node:path'
import { tmpdir } from 'node:os'
import electron from 'electron'
import { runRuntimeVerification } from './runtime-verification.mjs'
import { testKeychainItemExists, removeTestKeychainItem } from './verify-connection-credentials.mjs'

const root = resolvePath(import.meta.dirname, '..'),
  { Server } = createRequire(join(root, 'packages/connections/ssh/package.json'))('ssh2')
const directory = await mkdtemp(join(tmpdir(), 'mydsh-ssh-fixture-')),
  peers = new Set()
const password = randomBytes(24).toString('hex')
const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  type: 'pkcs1',
  format: 'pem',
})
const server = new Server({ hostKeys: [hostKey] }, peer => {
  peers.add(peer)
  peer.on('error', () => {})
  peer.once('close', () => peers.delete(peer))
  peer.on('authentication', auth =>
    auth.method === 'password' && auth.password === password ? auth.accept() : auth.reject(),
  )
  peer.on('ready', () =>
    peer.on('session', acceptSession => {
      const session = acceptSession()
      let channel
      session.on('pty', accept => accept())
      session.on('window-change', (accept, _reject, size) => {
        accept?.()
        channel?.write(`\r\n窗口 ${size.cols} 列 ${size.rows} 行\r\n`)
      })
      session.on('shell', accept => {
        channel = accept()
        channel.write('MyDSH SSH 隔离验收\r\n连接目标：临时服务，仅接收测试输入\r\n$ ')
        channel.on('data', data => channel.write(data))
      })
    }),
  )
})
const fixture = join(directory, 'fixture.json'),
  previous = process.env.MYDSH_SSH_FIXTURE
const previousAppName = process.env.MYDSH_SSH_VERIFY_APP_NAME
const owner = {
  name: `mydsh-credentials-verify-${randomBytes(16).toString('hex')}`,
  absentBefore: false,
}
const controller = new AbortController(),
  cancel = () => controller.abort()
process.once('SIGINT', cancel)
process.once('SIGTERM', cancel)
try {
  if (testKeychainItemExists(owner.name)) throw new Error('测试应用身份已有钥匙串条目，拒绝复用')
  owner.absentBefore = true
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  await writeFile(fixture, JSON.stringify({ port: server.address().port, password }), {
    mode: 0o600,
  })
  process.env.MYDSH_SSH_FIXTURE = fixture
  process.env.MYDSH_SSH_VERIFY_APP_NAME = owner.name
  console.log(
    `真实 Electron／utilityProcess／SSH／本地受保护密钥验收；仅使用随机测试身份 ${owner.name}。`,
  )
  const result = await runRuntimeVerification({
    command: electron,
    args: ['.', '--verify', '--verify-ssh'],
    cwd: root,
    label: 'SSH 工作区',
    requireRuntime: true,
    useSystemKeychain: true,
    signal: controller.signal,
  })
  if (!result.stdout.includes('mydsh-ssh-verify: complete'))
    throw new Error('SSH 工作区未返回完整验收结果')
  if (testKeychainItemExists(owner.name))
    throw new Error('SSH 业务不应继续依赖系统钥匙串存储新凭据')
  if (peers.size) await new Promise(resolve => setTimeout(resolve, 300))
  if (peers.size) throw new Error('应用退出后 SSH 服务端仍有连接')
  console.log('SSH 工作区验收通过，应用退出后连接已全部释放。')
} finally {
  process.removeListener('SIGINT', cancel)
  process.removeListener('SIGTERM', cancel)
  if (previous === undefined) delete process.env.MYDSH_SSH_FIXTURE
  else process.env.MYDSH_SSH_FIXTURE = previous
  if (previousAppName === undefined) delete process.env.MYDSH_SSH_VERIFY_APP_NAME
  else process.env.MYDSH_SSH_VERIFY_APP_NAME = previousAppName
  for (const peer of peers) peer.end()
  await new Promise(resolve => server.close(resolve))
  try {
    if (owner.absentBefore) removeTestKeychainItem(owner)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
console.log('已清理本次 SSH 测试钥匙串条目、临时凭据与夹具。')
