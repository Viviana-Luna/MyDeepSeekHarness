/** 独立进程验证系统密钥；不启动 MyDSH Runtime，不接触实际 credentials.yaml。 */
const { app, safeStorage } = require('electron')
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const assert = require('node:assert/strict')

const [phase, name, directory] = process.argv.slice(2)
if (
  !['seal', 'restore'].includes(phase) ||
  !/^mydsh-credentials-verify-[0-9a-f]{32}$/.test(name) ||
  !directory ||
  !process.env.MYDSH_VERIFY_HOME ||
  process.platform !== 'darwin'
) {
  console.error('凭据验收启动参数无效。')
  app.exit(1)
} else {
  // 必须在 ready 前确定名称、ready 后首次调用 safeStorage，避免使用 Electron 或 MyDSH 的既有条目。
  app.setName(name)
  app.enableSandbox()
  for (const key of ['userData', 'sessionData']) {
    const path = join(process.env.MYDSH_VERIFY_HOME, key)
    mkdirSync(path, { recursive: true, mode: 0o700 })
    app.setPath(key, path)
  }
  app.setAppLogsPath(join(process.env.MYDSH_VERIFY_HOME, 'logs'))
  const cancel = () => app.exit(1)
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  app
    .whenReady()
    .then(async () => {
      const { sealCredential, openCredential } = await import('./envelope.mjs')
      const connectionId = '8ea2df7a-2b7d-4f2b-9b68-438443a89472'
      const cases = [
        ['ssh-password', '仅用于验收的密码：测试🔒'],
        ['ssh-private-key', '仅用于验收的多行假私钥\n不用于认证\n'],
        ['ssh-passphrase', '仅用于验收的私钥口令'],
        ['database-password', ''],
      ]
      const file = join(directory, 'envelopes.json')
      assert.ok(app.getName() === name, '测试应用身份必须匹配')
      if (phase === 'seal') {
        const records = cases.map(([purpose, secret]) => {
          const binding = { connectionId, purpose }
          const envelope = sealCredential(secret, binding, safeStorage)
          assert.ok(
            openCredential(envelope, binding, safeStorage) === secret,
            '写入前必须验证可恢复',
          )
          return envelope
        })
        writeFileSync(file, JSON.stringify(records) + '\n', { mode: 0o600, flag: 'wx' })
        const text = readFileSync(file, 'utf8')
        assert.ok(
          cases.every(([, secret]) => !secret || !text.includes(secret)),
          '快照不能包含凭据明文',
        )
      } else {
        const records = JSON.parse(readFileSync(file, 'utf8'))
        assert.ok(records.length === cases.length, '持久化记录数必须匹配')
        for (const [index, [purpose, secret]] of cases.entries()) {
          const binding = { connectionId, purpose }
          assert.ok(
            openCredential(records[index], binding, safeStorage) === secret,
            '独立进程必须恢复相同凭据',
          )
          assert.throws(
            () =>
              openCredential(
                records[index],
                { ...binding, connectionId: '2bfbfb67-d2f1-4ef9-bcd1-11cdc3ce8100' },
                safeStorage,
              ),
            /校验失败/,
          )
          const tag = Buffer.from(records[index].tag, 'base64')
          tag[0] ^= 1
          assert.throws(
            () =>
              openCredential(
                { ...records[index], tag: tag.toString('base64') },
                binding,
                safeStorage,
              ),
            /校验失败/,
          )
        }
      }
      console.log(
        'MYDSH_CREDENTIALS_RESULT ' +
          JSON.stringify({
            success: true,
            phase,
            records: cases.length,
            electron: process.versions.electron,
            node: process.versions.node,
          }),
      )
      app.exit(0)
    })
    .catch(() => {
      // 原始系统异常及断言差异可能带敏感数据；只输出阶段和固定诊断。
      console.error(
        `凭据 ${phase === 'seal' ? '加密' : '重启恢复'} 验收失败；请检查系统钥匙串可用性与访问提示。`,
      )
      app.exit(1)
    })
}
