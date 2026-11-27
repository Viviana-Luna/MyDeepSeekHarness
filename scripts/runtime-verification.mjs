import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_TIMEOUT_MS = 240_000

function createVerificationProject(verifyHome) {
  // 验收 Skill 目录自给，不能借用开发者的全局 Skill 或个人配置。
  for (let index = 0; index < 24; index += 1) {
    const id = 'verification-skill-' + String(index + 1).padStart(2, '0')
    const directory = join(verifyHome, 'agents/skills', id)
    mkdirSync(directory, { recursive: true })
    writeFileSync(
      join(directory, 'SKILL.md'),
      '---\nname: ' +
        id +
        '\ndescription: 隔离验收技能，用于验证命令面板搜索和滚动。\n---\n\n仅用于 MyDSH 界面验收，不执行外部操作。\n',
    )
  }
  const project = join(verifyHome, 'project')
  mkdirSync(project, { recursive: true, mode: 0o700 })
  writeFileSync(join(project, 'README.md'), '# MyDSH 验收项目\n', { mode: 0o600 })
  writeFileSync(
    join(project, 'package.json'),
    `${JSON.stringify(
      {
        name: 'mydsh-verification-project',
        private: true,
        scripts: { dev: 'vite --host 127.0.0.1' },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  )
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5+kL8AAAAASUVORK5CYII=',
    'base64',
  )
  writeFileSync(
    join(project, 'large-preview.png'),
    Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]),
    { mode: 0o600 },
  )
  const deepSegments = [
    'src',
    ...Array.from({ length: 39 }, (_, index) => `level-${String(index + 1).padStart(2, '0')}`),
  ]
  let deepDirectory = project
  for (const segment of deepSegments) {
    deepDirectory = join(deepDirectory, segment)
    mkdirSync(deepDirectory, { recursive: true, mode: 0o700 })
  }
  const deepClassName =
    'DeepWorkspaceControllerWithAnIntentionallyLongNameForHorizontalTreeVerification'
  const deepSource = [
    'package verification;',
    '',
    '// 中文注释用于验证语义高亮',
    `public final class ${deepClassName} {`,
    '  private final String state = "ready";',
    ...Array.from(
      { length: 50_000 },
      (_, index) => `  private int value${String(index + 1).padStart(5, '0')};`,
    ),
    '}',
    '',
  ].join('\n')
  writeFileSync(join(deepDirectory, `${deepClassName}.java`), deepSource, { mode: 0o600 })
  writeFileSync(
    join(deepDirectory, 'ApplicationSecurityConfiguration.java'),
    'package verification;\npublic final class ApplicationSecurityConfiguration {}\n',
    { mode: 0o600 },
  )
  writeFileSync(join(deepDirectory, 'index.ts'), 'export const ready = true\n', { mode: 0o600 })
  const git = (...args) => {
    execFileSync('git', args, { cwd: project, stdio: 'ignore', windowsHide: true })
  }
  git('init')
  git('config', 'core.longpaths', 'true')
  git('config', 'user.name', 'MyDSH Verifier')
  git('config', 'user.email', 'verifier@mydsh.invalid')
  git('add', '--', 'README.md', 'package.json', 'large-preview.png', 'src')
  git('commit', '-m', '初始化验收项目')
  // 提交列表须超出一个视口，才能检验右侧栏能否滚到最早的记录。
  for (let index = 1; index <= 18; index += 1) {
    git('commit', '--allow-empty', '-m', `检查长提交列表的滚动与显示 ${String(index)}`)
  }
  git('branch', '-M', 'dev')
  writeFileSync(join(project, 'scratch.md'), 'Source Control 写路径验收\n', { mode: 0o600 })
  return project
}

function processTargetExists(target) {
  try {
    process.kill(target, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

async function stopRecordedRuntime(verifyHome) {
  const pidPath = join(verifyHome, 'runtime.pid')
  if (!existsSync(pidPath)) return
  const pid = Number(readFileSync(pidPath, 'utf8').trim())
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error('验收 Runtime PID 记录无效，拒绝执行清理。')
  }
  // utilityProcess 没有承诺创建独立进程组；负 PID 可能命中无关进程，必须只操作登记进程。
  const target = pid
  if (!processTargetExists(target)) return
  try {
    process.kill(target, 'SIGTERM')
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
    return
  }
  /* oxlint-disable no-await-in-loop -- 进程退出检查必须按固定间隔串行等待，并受次数上限约束。 */
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise(resolve => {
      setTimeout(resolve, 100)
    })
    if (!processTargetExists(target)) return
  }
  /* oxlint-enable no-await-in-loop */
  try {
    process.kill(target, 'SIGKILL')
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
    return
  }
  /* oxlint-disable no-await-in-loop -- 强制终止后仍需有界等待登记进程退出。 */
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise(resolve => {
      setTimeout(resolve, 100)
    })
    if (!processTargetExists(target)) return
  }
  /* oxlint-enable no-await-in-loop */
  throw new Error('无法清理验收创建的 MyDSH Runtime 进程。')
}

export async function runRuntimeVerification({
  command,
  args,
  cwd,
  label,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  requireRuntime = false,
  useSystemKeychain = false,
  signal,
}) {
  if (signal?.aborted) throw new Error(`${label}已取消。`)
  // Windows 的临时目录可能带 8.3 短名；统一取规范长路径，避免与应用内 realpath 的结果不可比较。
  const verifyHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'mydsh-verify-')))
  console.log(label + '隔离验收目录：' + verifyHome)
  const mydshHome = join(verifyHome, 'mydsh')
  // Chromium 与 Electron 已知目录（含下载目录）在隔离 USERPROFILE 下必须存在。
  for (const directory of ['AppData/Roaming', 'AppData/Local', 'Downloads'])
    mkdirSync(join(verifyHome, directory), { recursive: true })
  let child
  let timedOut = false
  let stdout = ''
  let stderr = ''
  try {
    const verifyProject = realpathSync.native(createVerificationProject(verifyHome))
    if (signal?.aborted) throw new Error(`${label}已取消。`)
    // 去除调用环境的外部 Host 和 Node 模式，并且不让全局包管理器参与独立性验收。
    const environment = { ...process.env }
    const stripKeys = new Set([
      'DSH_HOME',
      'DSH_CLI',
      'MYDSH_DSH_CLI',
      'DSH_DESKTOP_DSH_COMMAND',
      'ELECTRON_RUN_AS_NODE',
      'NODE_PATH',
      'NODE_OPTIONS',
      'PATH',
      'HOME',
      'USERPROFILE',
      'APPDATA',
      'LOCALAPPDATA',
      'DSH_AGENTS_HOME',
      'MYDSH_HOME',
      'MYDSH_VERIFY_HOME',
      'MYDSH_VERIFY_PROJECT',
    ])
    // Windows 展开普通对象后环境键区分大小写，必须按大写统一剔除，避免出现 APPDATA/AppData 双键污染。
    for (const key of Object.keys(environment)) {
      if (process.platform === 'win32' ? stripKeys.has(key.toUpperCase()) : stripKeys.has(key)) {
        delete environment[key]
      }
    }
    const systemPath =
      process.platform === 'win32'
        ? [
            join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
            process.env.SystemRoot ?? 'C:\\Windows',
          ].join(';')
        : '/usr/bin:/bin:/usr/sbin:/sbin'
    const result = await new Promise((resolve, reject) => {
      child = spawn(command, args, {
        cwd,
        env: {
          ...environment,
          // 应用只能访问系统命令；PowerShell、Git、Node 与包管理器必须来自随包核心。
          PATH: systemPath,
          // macOS 的默认钥匙串查找依赖真实用户目录；应用数据仍由下列专用路径隔离。
          HOME: useSystemKeychain ? homedir() : verifyHome,
          USERPROFILE: verifyHome,
          APPDATA: join(verifyHome, 'AppData/Roaming'),
          LOCALAPPDATA: join(verifyHome, 'AppData/Local'),
          DSH_AGENTS_HOME: join(verifyHome, 'agents'),
          MYDSH_HOME: mydshHome,
          MYDSH_VERIFY_HOME: verifyHome,
          MYDSH_VERIFY_PROJECT: verifyProject,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        stdout += chunk
        process.stdout.write(chunk)
      })
      child.stderr.on('data', chunk => {
        stderr += chunk
        process.stderr.write(chunk)
      })
      let forcedKill
      const stop = () => {
        child.kill('SIGTERM')
        forcedKill ??= setTimeout(() => {
          child.kill('SIGKILL')
        }, 5_000)
      }
      const deadline = setTimeout(() => {
        timedOut = true
        stop()
      }, timeoutMs)
      signal?.addEventListener('abort', stop, { once: true })
      if (signal?.aborted) stop()
      child.once('error', error => {
        signal?.removeEventListener('abort', stop)
        clearTimeout(deadline)
        if (forcedKill !== undefined) clearTimeout(forcedKill)
        reject(error)
      })
      child.once('close', (code, exitSignal) => {
        signal?.removeEventListener('abort', stop)
        clearTimeout(deadline)
        if (forcedKill !== undefined) clearTimeout(forcedKill)
        resolve({ code, signal: exitSignal })
      })
    })
    if (signal?.aborted) throw new Error(`${label}已取消。`)
    if (timedOut) {
      throw new Error(`${label}超过 ${String(timeoutMs)}ms 总时限。`)
    }
    if (result.code !== 0) {
      throw new Error(
        `${label}失败，退出码 ${String(result.code)}，信号 ${String(result.signal)}。`,
      )
    }
    if (requireRuntime) {
      const runtimeRoot = join(mydshHome, 'runtime')
      if (!existsSync(runtimeRoot)) throw new Error('应用没有在隔离 MYDSH_HOME 中安装离线核心。')
      const versions = readdirSync(runtimeRoot).filter(name => !name.startsWith('.'))
      if (
        versions.length !== 1 ||
        !existsSync(join(runtimeRoot, versions[0], '.mydsh-install.json'))
      )
        throw new Error('离线核心没有留下唯一且完整的安装记录。')
      const receipt = JSON.parse(
        readFileSync(join(runtimeRoot, versions[0], '.mydsh-install.json'), 'utf8'),
      )
      if (!existsSync(join(runtimeRoot, versions[0], receipt.entry)))
        throw new Error('离线核心缺少已安装入口。')
      for (const name of ['typescript', 'esbuild', 'npm'])
        if (!existsSync(join(runtimeRoot, versions[0], 'node_modules', name, 'package.json')))
          throw new Error(`隔离核心缺少随包工具链 ${name}。`)
      const toolEnvironment = {
        ...environment,
        PATH: systemPath,
        MYDSH_HOME: mydshHome,
        ELECTRON_RUN_AS_NODE: '1',
        NPM_CONFIG_USERCONFIG: join(verifyHome, 'empty.npmrc'),
        NPM_CONFIG_CACHE: join(verifyHome, 'npm-cache'),
      }
      writeFileSync(toolEnvironment.NPM_CONFIG_USERCONFIG, '', { mode: 0o600 })
      const installedRoot = join(runtimeRoot, versions[0])
      for (const [name, entry] of [
        ['typescript', 'bin/tsc'],
        ['npm', 'bin/npm-cli.js'],
      ]) {
        const packageRoot = join(installedRoot, 'node_modules', name)
        const version = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version
        const output = execFileSync(command, [join(packageRoot, entry), '--version'], {
          env: toolEnvironment,
          encoding: 'utf8',
          timeout: 10_000,
        })
        if (!output.includes(version))
          throw new Error(`随包 ${name} 没有通过应用自带 Node 的执行验收。`)
      }
      const esbuildRoot = join(installedRoot, 'node_modules/esbuild')
      const esbuildVersion = JSON.parse(
        readFileSync(join(esbuildRoot, 'package.json'), 'utf8'),
      ).version
      // npm 安装方式可能把 bin/esbuild 替换成原生二进制；通过固定 JS API 触发真实编译。
      const esbuildProbe =
        "const esbuild = require(process.argv[1]); const result = esbuild.transformSync('const answer: number = 42', { loader: 'ts' }); if (!result.code.includes('42')) throw new Error('esbuild 编译结果无效'); console.log(esbuild.version)"
      const esbuildOutput = execFileSync(
        command,
        ['-e', esbuildProbe, join(esbuildRoot, 'lib/main.js')],
        { env: toolEnvironment, encoding: 'utf8', timeout: 10_000 },
      )
      if (esbuildOutput.trim() !== esbuildVersion)
        throw new Error('随包 esbuild 未通过 API 版本与原生编译验收。')
    }
    return { stdout, stderr, verifyHome, mydshHome }
  } finally {
    try {
      if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
      }
      await stopRecordedRuntime(verifyHome)
    } finally {
      try {
        if (process.env.MYDSH_VERIFY_INSPECT === '1') {
          console.log(`${label}截图查看窗口：${join(verifyHome, 'artifacts')}；45 秒后自动清理。`)
          await new Promise(resolve => {
            setTimeout(resolve, 45_000)
          })
        }
      } finally {
        rmSync(verifyHome, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
      }
    }
  }
}
