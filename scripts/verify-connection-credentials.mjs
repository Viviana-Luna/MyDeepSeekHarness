/** 验证专用入口：两次独立 Electron 启动，只读写临时假凭据和本次独占钥匙串条目。 */
import { transform } from 'esbuild'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  copyFileSync,
  readFileSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runRuntimeVerification } from './runtime-verification.mjs'

function security(args) {
  // 不使用 -g/-w，不读取钥匙串密码，元数据也不输出到普通日志。
  const result = spawnSync('/usr/bin/security', args, {
    stdio: 'ignore',
    timeout: 10_000,
    killSignal: 'SIGKILL',
  })
  if (result.error || result.signal || result.status === null)
    throw new Error('无法确认测试钥匙串条目状态。')
  return result.status
}

function itemArgs(name) {
  if (!/^mydsh-credentials-verify-[0-9a-f]{32}$/.test(name)) throw new Error('测试钥匙串名称无效。')
  // 随包 Electron 的实际账号字段带 Key 后缀；查询和清理必须匹配同一条测试记录。
  return ['-s', `${name} Safe Storage`, '-a', `${name} Key`]
}

export function testKeychainItemExists(name, run = security) {
  const status = run(['find-generic-password', ...itemArgs(name)])
  if (status === 0) return true
  if (status === 44) return false
  throw new Error('无法确认测试钥匙串条目状态。')
}

export function removeTestKeychainItem(owner, run = security) {
  if (owner.absentBefore !== true) throw new Error('没有测试条目独占依据，拒绝删除。')
  if (!testKeychainItemExists(owner.name, run)) return
  if (
    run(['delete-generic-password', ...itemArgs(owner.name)]) !== 0 ||
    testKeychainItemExists(owner.name, run)
  ) {
    throw new Error('本次测试钥匙串条目未能清理。')
  }
}

export async function verifyConnectionCredentials() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('本次凭据验收仅支持 macOS Apple Silicon。')
  try {
    execFileSync('/usr/bin/sandbox-exec', ['-p', '(version 1) (allow default)', '/usr/bin/true'], {
      stdio: 'ignore',
      timeout: 5000,
    })
  } catch {
    throw new Error(
      '当前进程不能应用 macOS 沙箱，请在系统终端运行本命令；不能用关闭 sandbox 替代验收。',
    )
  }
  const electron = createRequire(import.meta.url)('electron')
  const owner = {
    name: `mydsh-credentials-verify-${randomBytes(16).toString('hex')}`,
    absentBefore: false,
  }
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'mydsh-credentials-verify-')))
  const controller = new AbortController()
  const cancel = () => controller.abort()
  let failure
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  try {
    if (testKeychainItemExists(owner.name)) throw new Error('测试名称已有钥匙串条目，拒绝复用。')
    owner.absentBefore = true
    console.log(`测试应用身份：${owner.name}；系统可能询问钥匙串访问权限。`)
    console.log('仅验证加密封装和跨进程恢复，不使用真实凭据，不代表产品连接管理已接入。')
    const source = join(import.meta.dirname, 'connection-credentials-verification')
    copyFileSync(join(source, 'electron.cjs'), join(home, 'electron.cjs'))
    const envelope = await transform(
      readFileSync(
        new URL('../src/main/connections/credential-envelope.ts', import.meta.url),
        'utf8',
      ),
      { loader: 'ts', format: 'esm', target: 'es2024' },
    )
    writeFileSync(join(home, 'envelope.mjs'), envelope.code)
    writeFileSync(
      join(home, 'package.json'),
      JSON.stringify({
        name: owner.name,
        productName: owner.name,
        version: '0.0.0',
        private: true,
        main: 'electron.cjs',
      }) + '\n',
      { mode: 0o600 },
    )
    // 第二次启动不共享第一次的 userData 或内存，只共享密文快照和测试应用名称。
    for (const phase of ['seal', 'restore']) {
      // oxlint-disable-next-line no-await-in-loop -- 两个阶段必须等待上一 Electron 完全退出。
      const result = await runRuntimeVerification({
        command: electron,
        args: [home, phase, owner.name, home],
        cwd: home,
        label: phase === 'seal' ? '凭据加密' : '凭据重启恢复',
        timeoutMs: 60_000,
        useSystemKeychain: true,
        signal: controller.signal,
      })
      const prefix = 'MYDSH_CREDENTIALS_RESULT '
      const lines = result.stdout.split('\n').filter(line => line.startsWith(prefix))
      if (lines.length !== 1) throw new Error('凭据验收未返回唯一结果。')
      const report = JSON.parse(lines[0].slice(prefix.length))
      if (
        report.success !== true ||
        report.phase !== phase ||
        report.records !== 4 ||
        !report.electron
      ) {
        throw new Error('凭据验收结果不符合要求。')
      }
      if (!testKeychainItemExists(owner.name))
        throw new Error('未发现独立测试钥匙串条目，不能确认系统密钥隔离。')
      console.log(
        `通过：${phase === 'seal' ? '系统密钥保护与密文快照' : '独立 Electron 恢复、身份绑定与篡改拒绝'}。`,
      )
    }
  } catch (error) {
    failure = error
  } finally {
    try {
      if (owner.absentBefore) removeTestKeychainItem(owner)
    } catch (error) {
      console.error(
        `清理未完成；仅检查测试条目 ${owner.name} Safe Storage，账号 ${owner.name} Key。`,
      )
      failure ??= error
    } finally {
      process.removeListener('SIGINT', cancel)
      process.removeListener('SIGTERM', cancel)
      rmSync(home, { recursive: true, force: true })
    }
  }
  if (failure) throw failure
  console.log('已清理本次测试钥匙串条目、临时密文与隔离应用目录。')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--help') {
    console.log(
      '用法：node scripts/verify-connection-credentials.mjs\n使用两个真实 Electron 进程验证加密和恢复；创建并清理随机名称的测试钥匙串条目。\n可能出现系统访问提示；不锁定钥匙串，不使用已有 MyDSH/Electron 条目，不读取实际凭据。',
    )
  } else {
    try {
      if (args.length) throw new Error('参数无效，请使用 --help 查看用法。')
      await verifyConnectionCredentials()
    } catch (error) {
      console.error(error.message)
      process.exitCode = 1
    }
  }
}
