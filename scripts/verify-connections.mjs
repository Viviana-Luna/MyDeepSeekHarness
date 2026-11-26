/** M0 驱动验收：只使用临时账号、本机回环端口和已有镜像，不修改 MyDSH 用户数据。 */
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runRuntimeVerification } from './runtime-verification.mjs'
import { testKeychainItemExists, removeTestKeychainItem } from './verify-connection-credentials.mjs'
import { verifyDatabaseAgent } from './connections-verification/agent.mjs'

const root = resolve(import.meta.dirname, '..')
const image = 'mysql@sha256:d36d39a64cd12a5c1cc9e6aa2bfb5f8d4c81a2f6586e0a04a9ae13939db02209'
const resultPrefix = 'MYDSH_CONNECTIONS_RESULT '

function command(program, args, options = {}) {
  return execFileSync(program, args, {
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim()
}

/** 只删除本次随机名称且所有权标签匹配的容器；Docker 不可用时不伪报已清理。 */
export function removeFixtureContainer(name, owner, run = command) {
  const id = run('docker', ['ps', '-aq', '--filter', `name=^/${name}$`])
  if (!id) return
  const [record] = JSON.parse(run('docker', ['inspect', id]))
  if (
    record?.Name !== `/${name}` ||
    record.Config?.Labels?.['mydsh.connections-verification'] !== owner
  ) {
    throw new Error('容器所有权不匹配，拒绝删除。')
  }
  run('docker', ['rm', '-f', record.Id])
  if (run('docker', ['ps', '-aq', '--filter', `name=^/${name}$`]))
    throw new Error('本次数据库容器仍未删除。')
}

export async function verifyConnections(mode) {
  if (!['electron', 'node', 'workspace'].includes(mode)) throw new Error('验收模式无效。')
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('本次夹具仅支持 macOS Apple Silicon。')
  if (mode !== 'node') {
    try {
      command('/usr/bin/sandbox-exec', ['-p', '(version 1) (allow default)', '/usr/bin/true'])
    } catch {
      throw new Error(
        '当前进程不能应用 macOS 沙箱，请在系统终端运行本命令；不能用关闭 sandbox 替代验收。',
      )
    }
  }
  command('docker', ['image', 'inspect', image])
  const electron = createRequire(import.meta.url)('electron')
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'mydsh-connections-verify-')))
  const fixture = join(home, 'fixture')
  const owner = randomBytes(16).toString('hex')
  const name = `mydsh-connections-verify-${owner}`
  const password = randomBytes(24).toString('hex')
  const controller = new AbortController()
  let containerAttempted = false
  let cleaned = false
  const cancel = () => controller.abort()
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  const checkCancellation = () => {
    if (controller.signal.aborted) throw new Error('连接验收已取消。')
  }
  try {
    console.log(
      mode === 'node'
        ? '仅运行 Node 协议回归；此结果不能替代 Electron 验收。'
        : '开始真实 Electron utilityProcess 连接验收。',
    )
    writeFileSync(
      join(home, 'package.json'),
      JSON.stringify({
        name: 'mydsh-connections-verification',
        private: true,
        packageManager: 'pnpm@11.7.0',
        dependencies: { ssh2: '1.17.0', mysql2: '3.24.6' },
      }) + '\n',
      { mode: 0o600 },
    )
    console.log(
      mode === 'workspace'
        ? '使用正式应用随包交付的数据库驱动。'
        : '从本机缓存离线准备候选驱动，不执行依赖安装脚本。',
    )
    if (mode !== 'workspace')
      command('pnpm', ['install', '--offline', '--ignore-scripts', '--ignore-workspace'], {
        cwd: home,
        timeout: 60_000,
      })
    checkCancellation()
    mkdirSync(fixture, { mode: 0o755 })
    writeFileSync(join(fixture, 'root-password'), password, { mode: 0o444 })
    command(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        'ca-key.pem',
        '-out',
        'ca.pem',
        '-days',
        '1',
        '-subj',
        '/CN=MyDSH verification CA',
      ],
      { cwd: fixture },
    )
    command(
      'openssl',
      [
        'req',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        'server-key.pem',
        '-out',
        'server.csr',
        '-subj',
        '/CN=localhost',
      ],
      { cwd: fixture },
    )
    writeFileSync(
      join(fixture, 'server.ext'),
      'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n',
    )
    command(
      'openssl',
      [
        'x509',
        '-req',
        '-in',
        'server.csr',
        '-CA',
        'ca.pem',
        '-CAkey',
        'ca-key.pem',
        '-CAcreateserial',
        '-out',
        'server.pem',
        '-days',
        '1',
        '-extfile',
        'server.ext',
      ],
      { cwd: fixture },
    )
    // 容器内 mysql 用户只能读取这份临时假密钥；临时目录本身仍仅当前用户可访问。
    chmodSync(join(fixture, 'server-key.pem'), 0o444)
    writeFileSync(
      join(fixture, 'init.sql'),
      [
        'SET NAMES utf8mb4;',
        'CREATE DATABASE mydsh_probe;',
        'CREATE TABLE mydsh_probe.samples (id BIGINT UNSIGNED, amount DECIMAL(30,10), note VARCHAR(32), payload VARBINARY(4));',
        "INSERT INTO mydsh_probe.samples VALUES (18446744073709551615,12345678901234567890.1234567890,'测试数据',X'00FF');",
        'CREATE TABLE mydsh_probe.pages (id INT PRIMARY KEY, note VARCHAR(32));',
        `INSERT INTO mydsh_probe.pages VALUES ${Array.from({ length: 650 }, (_, index) => `(${index + 1},'分页数据${index + 1}')`).join(',')};`,
        'CREATE VIEW mydsh_probe.slow_view AS SELECT id FROM mydsh_probe.samples WHERE SLEEP(30) = 0;',
        `CREATE USER 'mydsh_reader'@'%' IDENTIFIED BY '${password}' REQUIRE SSL;`,
        "GRANT SELECT ON mydsh_probe.* TO 'mydsh_reader'@'%';",
        `CREATE USER 'mydsh_local'@'%' IDENTIFIED BY '${password}';`,
        "GRANT SELECT ON mydsh_probe.* TO 'mydsh_local'@'%';",
        `CREATE USER 'mydsh_writer'@'%' IDENTIFIED BY '${password}' REQUIRE SSL;`,
        "GRANT SELECT, UPDATE ON mydsh_probe.* TO 'mydsh_writer'@'%';",
      ].join('\n') + '\n',
      { mode: 0o444 },
    )
    checkCancellation()
    containerAttempted = true
    command('docker', [
      'create',
      '--name',
      name,
      '--label',
      `mydsh.connections-verification=${owner}`,
      '--pull=never',
      '--memory',
      '1g',
      '--cpus',
      '1',
      '--tmpfs',
      '/var/lib/mysql:rw,size=512m',
      '-p',
      '127.0.0.1::3306',
      '-e',
      'MYSQL_ROOT_PASSWORD_FILE=/probe/root-password',
      '-v',
      `${fixture}:/probe:ro`,
      '-v',
      `${fixture}/init.sql:/docker-entrypoint-initdb.d/init.sql:ro`,
      image,
      '--mysqlx=0',
      '--skip-log-bin',
      '--innodb-buffer-pool-size=64M',
      '--innodb-redo-log-capacity=64M',
      '--max-connections=20',
      '--ssl-ca=/probe/ca.pem',
      '--ssl-cert=/probe/server.pem',
      '--ssl-key=/probe/server-key.pem',
    ])
    command('docker', ['start', name])
    const ports = JSON.parse(
      command('docker', ['inspect', '--format', '{{json .NetworkSettings.Ports}}', name]),
    )['3306/tcp']
    if (ports?.length !== 1 || ports[0].HostIp !== '127.0.0.1')
      throw new Error('测试数据库没有仅绑定本机回环地址。')
    writeFileSync(
      join(home, 'connection.json'),
      JSON.stringify({
        port: Number(ports[0].HostPort),
        password,
        ca: readFileSync(join(fixture, 'ca.pem'), 'utf8'),
      }) + '\n',
      { mode: 0o600 },
    )
    if (mode === 'workspace') {
      await verifyDatabaseApplication(home, controller.signal)
      return
    }
    for (const file of ['electron.cjs', 'worker.mjs', 'tls-errors.mjs'])
      copyFileSync(join(root, 'scripts/connections-verification', file), join(home, file))
    checkCancellation()
    const result = await runRuntimeVerification({
      command: mode === 'electron' ? electron : process.execPath,
      args: [join(home, mode === 'electron' ? 'electron.cjs' : 'worker.mjs')],
      cwd: home,
      label: '服务器与数据库驱动',
      timeoutMs: 120_000,
      signal: controller.signal,
    })
    const reports = result.stdout.split('\n').filter(line => line.startsWith(resultPrefix))
    if (reports.length !== 1) throw new Error('驱动验收未返回唯一结果。')
    const report = JSON.parse(reports[0].slice(resultPrefix.length))
    if (
      report.success !== true ||
      report.runtime !== (mode === 'electron' ? 'utilityProcess' : 'node') ||
      report.checks !== 12
    ) {
      throw new Error('驱动验收结果或进程类型不符合要求。')
    }
    console.log(
      `通过：${report.runtime} 完成 ${report.checks} 项检查；Node ${report.node}，MySQL ${report.mysql}。`,
    )
  } finally {
    try {
      if (containerAttempted) removeFixtureContainer(name, owner)
      cleaned = true
    } finally {
      process.removeListener('SIGINT', cancel)
      process.removeListener('SIGTERM', cancel)
      if (cleaned) {
        rmSync(home, { recursive: true, force: true })
        console.log('已清理本次容器、临时依赖、假凭据和验收数据。')
      } else console.error(`清理未完成，保留夹具以便重试；仅处理容器 ${name}，临时目录 ${home}。`)
    }
  }
}

/** M2 使用正式应用、正式凭据服务和同一临时数据库；隧道仅转发到本次回环目标。 */
async function verifyDatabaseApplication(home, signal) {
  const configPath = join(home, 'connection.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  const mysql = createRequire(join(root, 'packages/connections/database/package.json'))('mysql2')
  const { Server, utils } = createRequire(join(root, 'packages/connections/ssh/package.json'))(
    'ssh2',
  )
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    type: 'pkcs1',
    format: 'pem',
  })
  const peers = new Set(),
    sockets = new Set()
  const server = new Server({ hostKeys: [key] }, peer => {
    peers.add(peer)
    peer.on('error', () => {})
    peer.once('close', () => peers.delete(peer))
    peer.on('authentication', auth =>
      auth.method === 'password' && auth.password === config.password
        ? auth.accept()
        : auth.reject(),
    )
    peer.on('ready', () =>
      peer.on('tcpip', (accept, reject, target) => {
        if (target.destIP !== '127.0.0.1' || target.destPort !== config.port) {
          reject()
          return
        }
        const socket = net.connect({ host: '127.0.0.1', port: config.port })
        sockets.add(socket)
        socket.on('error', () => {})
        socket.once('close', () => sockets.delete(socket))
        socket.once('connect', () => {
          const channel = accept()
          channel.on('error', () => {})
          channel.pipe(socket).pipe(channel)
          channel.once('close', () => socket.destroy())
          socket.once('close', () => channel.destroy())
        })
      }),
    )
  })
  const owner = {
    name: `mydsh-credentials-verify-${randomBytes(16).toString('hex')}`,
    absentBefore: false,
  }
  const previousFixture = process.env.MYDSH_DATABASE_FIXTURE,
    previousName = process.env.MYDSH_SSH_VERIFY_APP_NAME
  try {
    const deadline = Date.now() + 45_000
    let ready = false
    while (!ready && Date.now() < deadline) {
      signal.throwIfAborted()
      const connection = mysql.createConnection({
        host: 'localhost',
        port: config.port,
        stream: () => net.connect({ host: '127.0.0.1', port: config.port }),
        user: 'mydsh_reader',
        password: config.password,
        database: 'mydsh_probe',
        connectTimeout: 1500,
        ssl: { ca: config.ca, rejectUnauthorized: true, verifyIdentity: true },
      })
      try {
        await new Promise((done, reject) =>
          connection.connect(error => (error ? reject(error) : done())),
        )
        ready = true
      } catch {
        await delay(300, undefined, { signal })
      } finally {
        connection.destroy()
      }
    }
    if (!ready) throw new Error('临时数据库未就绪')
    await verifyDatabaseAgent(config, signal)
    if (testKeychainItemExists(owner.name)) throw new Error('数据库测试应用身份已存在，拒绝复用')
    owner.absentBefore = true
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    writeFileSync(
      configPath,
      JSON.stringify({
        ...config,
        sshPort: server.address().port,
        sshFingerprint: `SHA256:${createHash('sha256').update(utils.parseKey(key).getPublicSSH()).digest('base64').replace(/=+$/u, '')}`,
      }) + '\n',
      { mode: 0o600 },
    )
    process.env.MYDSH_DATABASE_FIXTURE = configPath
    process.env.MYDSH_SSH_VERIFY_APP_NAME = owner.name
    const result = await runRuntimeVerification({
      command: createRequire(import.meta.url)('electron'),
      args: ['.', '--verify', '--verify-database'],
      cwd: root,
      label: 'MySQL 工作区',
      requireRuntime: true,
      useSystemKeychain: true,
      signal,
      timeoutMs: 180_000,
    })
    if (!result.stdout.includes('mydsh-database-verify: complete'))
      throw new Error('数据库工作区未完成验收')
    if (testKeychainItemExists(owner.name))
      throw new Error('数据库业务不应继续依赖系统钥匙串存储新凭据')
    await delay(300)
    if (peers.size || sockets.size) throw new Error('数据库应用退出后仍有 SSH 通道未释放')
    console.log('MySQL 工作区、真实 TLS、SSH 通道及退出清理验收通过。')
  } finally {
    if (previousFixture === undefined) delete process.env.MYDSH_DATABASE_FIXTURE
    else process.env.MYDSH_DATABASE_FIXTURE = previousFixture
    if (previousName === undefined) delete process.env.MYDSH_SSH_VERIFY_APP_NAME
    else process.env.MYDSH_SSH_VERIFY_APP_NAME = previousName
    for (const socket of sockets) socket.destroy()
    for (const peer of peers) peer.end()
    await new Promise(done => server.close(done))
    if (owner.absentBefore) removeTestKeychainItem(owner)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--help') {
    console.log(
      '用法：node scripts/verify-connections.mjs [--node|--workspace]\n默认验证真实 Electron utilityProcess；--node 仅用于协议回归；--workspace 验证正式 MySQL 界面和 SSH 通道。\n需要本机已有固定 MySQL 镜像、Docker、OpenSSL 与 pnpm 缓存；不会下载镜像或使用真实账号。',
    )
  } else {
    const mode =
      args.length === 0
        ? 'electron'
        : args.length === 1 && args[0] === '--node'
          ? 'node'
          : args.length === 1 && args[0] === '--workspace'
            ? 'workspace'
            : undefined
    try {
      if (!mode) throw new Error('参数无效，请使用 --help 查看用法。')
      await verifyConnections(mode)
    } catch (error) {
      // 子命令完整异常可能包含环境或 SQL；仅给出命令失败摘要，不输出参数和配置。
      console.error(
        error?.status !== undefined
          ? `验收子命令失败，退出码 ${error.status}。请确认 Docker、本机固定镜像和 pnpm 离线缓存可用。`
          : error.message,
      )
      process.exitCode = 1
    }
  }
}
