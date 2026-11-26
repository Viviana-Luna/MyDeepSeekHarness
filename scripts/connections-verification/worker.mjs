/* oxlint-disable no-await-in-loop -- 服务就绪、查询取消及清理必须有界串行观察。 */
/* oxlint-disable unicorn/require-post-message-target-origin -- utilityProcess 使用父子进程消息，不接受浏览器 targetOrigin。 */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { isUntrustedCertificateError } from './tls-errors.mjs'

const require = createRequire(import.meta.url)
const mysql = require('mysql2')
const ssh2 = require('ssh2')
const config = JSON.parse(readFileSync(join(import.meta.dirname, 'connection.json'), 'utf8'))
assert.ok(
  Number.isInteger(config.port) && config.port > 0 && config.port < 65536,
  '测试数据库端口无效',
)
assert.equal(require('mysql2/package.json').version, '3.24.6')
assert.equal(require('ssh2/package.json').version, '1.17.0')
const databases = new Set(),
  clients = new Set(),
  peers = new Set(),
  sockets = new Set()
const events = new EventEmitter()
let server, primary
const result = {
  success: false,
  runtime: process.parentPort ? 'utilityProcess' : 'node',
  node: process.versions.node,
  checks: 0,
}

async function bounded(promise, label, ms = 5000) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + '超时')), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
async function check(label, task) {
  await task()
  result.checks++
  console.log('通过：' + label)
}
function socketToDb() {
  const socket = net.connect({ host: '127.0.0.1', port: config.port })
  sockets.add(socket)
  socket.on('error', () => {})
  socket.on('close', () => sockets.delete(socket))
  return socket
}
function database(options = {}) {
  const connection = mysql.createConnection({
    host: 'localhost',
    port: config.port,
    stream: socketToDb,
    user: 'mydsh_reader',
    password: config.password,
    database: 'mydsh_probe',
    connectTimeout: 1500,
    ssl: { ca: config.ca, rejectUnauthorized: true, verifyIdentity: true },
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
    multipleStatements: false,
    flags: ['-LOCAL_FILES'],
    ...options,
  })
  databases.add(connection)
  connection.on('error', () => {})
  return connection
}
function disposeDatabase(connection) {
  connection.destroy()
  connection.stream.destroy()
  databases.delete(connection)
}
const connect = connection =>
  bounded(
    new Promise((resolve, reject) =>
      connection.connect(error => (error ? reject(error) : resolve(connection))),
    ),
    '数据库连接',
  )
const query = (connection, sql, values = []) => connection.promise().query(sql, values)
async function observe(label, test) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await test()) return
    await delay(40)
  }
  throw new Error(label + '未在期限内得到确认')
}
async function waitForSlowQuery(id) {
  await observe('服务端慢查询', async () => {
    const [rows] = await query(
      primary,
      'SELECT INFO FROM information_schema.PROCESSLIST WHERE ID = ? AND COMMAND = ?',
      [id, 'Query'],
    )
    return rows.some(row => row.INFO?.includes('SLEEP'))
  })
}
const identityError = error =>
  error.code === 'HANDSHAKE_SSL_ERROR' && /Hostname\/IP does not match/.test(error.message)

try {
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    const candidate = database()
    try {
      primary = await connect(candidate)
      break
    } catch {
      disposeDatabase(candidate)
    }
    await delay(300)
  }
  assert.ok(primary, '隔离 MySQL 未在45秒内就绪')
  const [[version]] = await query(primary, 'SELECT VERSION() AS version')
  result.mysql = version.version
  await check('MySQL TLS 与证书身份拒绝', async () => {
    const [[cipher]] = await query(primary, "SHOW SESSION STATUS LIKE 'Ssl_cipher'")
    assert.ok(cipher.Value)
    const wrong = database({ host: 'wrong.invalid' })
    try {
      await assert.rejects(connect(wrong), identityError)
    } finally {
      disposeDatabase(wrong)
    }
    const untrusted = database({ ssl: { rejectUnauthorized: true, verifyIdentity: true } })
    try {
      await assert.rejects(connect(untrusted), isUntrustedCertificateError)
    } finally {
      disposeDatabase(untrusted)
    }
  })
  await check('MySQL 错误凭据拒绝', async () => {
    const wrong = database({ password: '错误的测试密码' })
    try {
      await assert.rejects(connect(wrong), error => error.code === 'ER_ACCESS_DENIED_ERROR')
    } finally {
      disposeDatabase(wrong)
    }
  })
  await check('MySQL 结构、参数和精确类型', async () => {
    const [columns] = await query(
      primary,
      'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      ['mydsh_probe', 'samples'],
    )
    assert.equal(columns.length, 4)
    const [[row]] = await primary
      .promise()
      .execute('SELECT *, NULL AS missing FROM samples WHERE id = ?', ['18446744073709551615'])
    assert.equal(row.id, '18446744073709551615')
    assert.equal(row.amount, '12345678901234567890.1234567890')
    assert.equal(row.note, '测试数据')
    assert.equal(row.missing, null)
    assert.deepEqual(row.payload, Buffer.from([0, 255]))
    const injection = "' OR 1=1; DROP TABLE samples; --"
    const [[literal]] = await primary.promise().execute('SELECT ? AS value', [injection])
    assert.equal(literal.value, injection)
    await assert.rejects(
      query(primary, 'SELECT 1; SELECT 2'),
      error => error.code === 'ER_PARSE_ERROR',
    )
  })
  await check('MySQL 最低权限和只读事务', async () => {
    await assert.rejects(
      query(primary, "UPDATE samples SET note='不应写入'"),
      error => error.code === 'ER_TABLEACCESS_DENIED_ERROR',
    )
    const writer = await connect(database({ user: 'mydsh_writer' }))
    try {
      await query(writer, 'START TRANSACTION READ ONLY')
      await assert.rejects(
        query(writer, "UPDATE samples SET note='不应写入'"),
        error => error.code === 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION',
      )
      await query(writer, 'ROLLBACK')
    } finally {
      disposeDatabase(writer)
    }
    const [[row]] = await query(primary, 'SELECT note FROM samples')
    assert.equal(row.note, '测试数据')
  })
  await check('MySQL 服务端执行时限', () =>
    assert.rejects(
      query(primary, 'SELECT /*+ MAX_EXECUTION_TIME(100) */ id FROM samples WHERE SLEEP(5) = 0'),
      error => error.errno === 3024,
    ),
  )
  await check('MySQL 同账号独立连接确认查询取消', async () => {
    const target = await connect(database())
    const pending = query(target, 'SELECT id FROM samples WHERE SLEEP(10) = 0').then(
      () => null,
      error => error,
    )
    await waitForSlowQuery(target.threadId)
    assert.ok(Number.isSafeInteger(target.threadId))
    await query(primary, `KILL QUERY ${target.threadId}`)
    assert.equal((await bounded(pending, '查询取消'))?.errno, 1317)
    const [[row]] = await query(target, 'SELECT 1 AS value')
    assert.equal(row.value, '1')
    disposeDatabase(target)
  })
  await check('MySQL 行数、字节限制和服务端连接释放', async () => {
    for (const limit of [
      { rows: 3, bytes: 8192 },
      { rows: 10, bytes: 3072 },
    ]) {
      const target = await connect(database()),
        id = target.threadId
      let rows = 0,
        bytes = 0
      const stream = target
        .query(
          "WITH RECURSIVE n AS (SELECT 1 AS i UNION ALL SELECT i+1 FROM n WHERE i<500) SELECT i, REPEAT('x',1024) AS body FROM n",
        )
        .stream({ highWaterMark: 1 })
      stream.on('error', () => {})
      await bounded(
        new Promise((resolve, reject) => {
          stream.on('error', reject)
          stream.on('data', row => {
            if (rows + 1 > limit.rows || bytes + Buffer.byteLength(row.body) > limit.bytes) {
              stream.destroy()
              disposeDatabase(target)
              resolve()
              return
            }
            rows++
            bytes += Buffer.byteLength(row.body)
          })
        }),
        '结果截断',
      )
      assert.equal(rows, 3)
      assert.equal(bytes, 3072)
      await observe('数据库连接释放', async () => {
        const [remaining] = await query(
          primary,
          'SELECT ID FROM information_schema.PROCESSLIST WHERE ID = ?',
          [id],
        )
        return remaining.length === 0
      })
    }
  })

  const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    type: 'pkcs1',
    format: 'pem',
  })
  const fingerprint = createHash('sha256')
    .update(ssh2.utils.parseKey(hostKey).getPublicSSH())
    .digest('hex')
  server = new ssh2.Server({ hostKeys: [hostKey] }, peer => {
    peers.add(peer)
    peer.on('error', () => {})
    peer.on('close', () => peers.delete(peer))
    peer.on('authentication', context => {
      if (
        context.method === 'password' &&
        context.username === 'mydsh_fixture' &&
        context.password === config.password
      )
        context.accept()
      else context.reject(['password'])
    })
    peer.on('ready', () => {
      peer.on('session', accept => {
        const session = accept()
        session.on('pty', (approve, _reject, info) => {
          events.emit('pty', info)
          approve?.()
        })
        session.on('window-change', (approve, _reject, info) => {
          events.emit('resize', info)
          approve?.()
        })
        session.on('shell', approve => {
          const channel = approve()
          channel.on('error', () => {})
          channel.on('data', data => channel.write(data))
          channel.on('end', () => channel.end())
        })
        session.on('exec', (approve, reject, info) => {
          if (!['fixture-status', 'fixture-wait'].includes(info.command)) {
            reject?.()
            return
          }
          const channel = approve()
          channel.on('error', () => {})
          channel.resume()
          if (info.command === 'fixture-status') {
            channel.write('夹具状态正常\n')
            channel.exit(0)
            channel.end()
          } else {
            channel.write('等待取消\n')
            channel.on('close', () => events.emit('cancelled'))
          }
        })
      })
      peer.on('tcpip', (accept, reject, info) => {
        if (info.destIP !== '127.0.0.1' || info.destPort !== config.port) {
          reject()
          return
        }
        const socket = socketToDb()
        const failed = () => reject()
        socket.once('error', failed)
        socket.once('connect', () => {
          socket.removeListener('error', failed)
          const channel = accept()
          channel.on('error', () => socket.destroy())
          channel.on('close', () => socket.destroy())
          socket.on('error', () => channel.close())
          socket.on('close', () => channel.close())
          socket.pipe(channel).pipe(socket)
        })
      })
    })
  })
  server.listen(0, '127.0.0.1')
  await bounded(once(server, 'listening'), 'SSH 服务启动')
  async function ssh(options = {}) {
    const client = new ssh2.Client()
    clients.add(client)
    client.on('error', () => {})
    client.on('close', () => clients.delete(client))
    const ready = once(client, 'ready')
    client.connect({
      host: '127.0.0.1',
      port: server.address().port,
      username: 'mydsh_fixture',
      password: config.password,
      hostHash: 'sha256',
      hostVerifier: hash => hash === fingerprint,
      readyTimeout: 3000,
      ...options,
    })
    try {
      await bounded(ready, 'SSH 连接')
      return client
    } catch (error) {
      client.destroy()
      throw error
    }
  }
  const client = await ssh()
  const open = (method, ...args) =>
    bounded(
      new Promise((resolve, reject) =>
        client[method](...args, (error, channel) => (error ? reject(error) : resolve(channel))),
      ),
      `SSH ${method}`,
    )
  await check('SSH 主机指纹和错误认证拒绝', async () => {
    await assert.rejects(ssh({ hostVerifier: () => false }), /Host denied/)
    await assert.rejects(ssh({ password: '错误的测试密码' }), /authentication methods failed/)
  })
  await check('SSH 终端回显、尺寸同步和独立诊断', async () => {
    const pty = once(events, 'pty'),
      shell = await open('shell', { rows: 24, cols: 80, term: 'xterm-256color' })
    shell.on('error', () => {})
    assert.equal((await bounded(pty, 'PTY 请求'))[0].cols, 80)
    const echoed = once(shell, 'data')
    shell.write('测试输入\n')
    assert.equal((await bounded(echoed, '终端回显'))[0].toString(), '测试输入\n')
    const resized = once(events, 'resize')
    shell.setWindow(40, 120, 0, 0)
    assert.equal((await bounded(resized, '终端尺寸'))[0].cols, 120)
    const diagnostic = await open('exec', 'fixture-status')
    let text = ''
    diagnostic.on('data', data => {
      text += data
    })
    diagnostic.stderr.resume()
    await bounded(once(diagnostic, 'close'), '独立诊断')
    assert.equal(text, '夹具状态正常\n')
    const closed = once(shell, 'close')
    shell.close()
    await bounded(closed, '终端关闭')
  })
  await check('SSH 取消收到服务端通道关闭事件', async () => {
    const channel = await open('exec', 'fixture-wait')
    channel.on('error', () => {})
    channel.stderr.resume()
    await bounded(once(channel, 'data'), '等待通道输出')
    const cancelled = once(events, 'cancelled')
    channel.close()
    await bounded(cancelled, '通道取消')
  })
  await check('SSH direct-tcpip 中的 MySQL TLS 身份校验', async () => {
    const stream = await open('forwardOut', '127.0.0.1', 0, '127.0.0.1', config.port)
    const tunneled = await connect(database({ stream }))
    const [[row]] = await query(tunneled, 'SELECT COUNT(*) AS count FROM samples')
    assert.equal(row.count, '1')
    disposeDatabase(tunneled)
    const wrongStream = await open('forwardOut', '127.0.0.1', 0, '127.0.0.1', config.port)
    const wrong = database({ stream: wrongStream, host: 'wrong.invalid' })
    try {
      await assert.rejects(connect(wrong), identityError)
    } finally {
      disposeDatabase(wrong)
    }
  })
  await check('SSH 中断时 MySQL 查询失败而非伪成功', async () => {
    const stream = await open('forwardOut', '127.0.0.1', 0, '127.0.0.1', config.port)
    const tunneled = await connect(database({ stream }))
    const pending = query(tunneled, 'SELECT id FROM samples WHERE SLEEP(10) = 0').then(
      () => null,
      error => error,
    )
    await waitForSlowQuery(tunneled.threadId)
    client.destroy()
    assert.ok(await bounded(pending, '隧道中断'))
    disposeDatabase(tunneled)
  })
  result.success = true
} catch (error) {
  console.error(
    '驱动验收失败：' + String(error.message).replaceAll(config.password, '[测试凭据已隐藏]'),
  )
  process.exitCode = 1
} finally {
  try {
    // 先监听关闭，再销毁资源；不能以退出进程代替连接清理的确认。
    const closed = [...clients, ...peers, ...sockets].map(
      resource => new Promise(resolve => resource.once('close', resolve)),
    )
    for (const connection of databases) disposeDatabase(connection)
    for (const client of clients) client.destroy()
    for (const peer of peers) peer.end()
    for (const socket of sockets) socket.destroy()
    if (server?.address())
      closed.push(
        new Promise((resolve, reject) =>
          server.close(error => (error ? reject(error) : resolve())),
        ),
      )
    await bounded(Promise.all(closed), '驱动资源关闭')
    assert.equal(clients.size + peers.size + sockets.size + databases.size, 0, '驱动连接未全部释放')
    assert.equal(server?.address() ?? null, null)
  } catch (error) {
    result.success = false
    process.exitCode = 1
    console.error('驱动资源清理失败：' + error.message)
  }
  if (process.parentPort) {
    process.parentPort.postMessage({ type: 'connections-result', result })
    // utilityProcess 的父端口仍保持活动；资源清理并报告后显式退出，与正式 Runtime 一致。
    process.exit(result.success ? 0 : 1)
  } else console.log('MYDSH_CONNECTIONS_RESULT ' + JSON.stringify(result))
}
