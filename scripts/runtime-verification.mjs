/**
 * 真实 Electron 运行时隔离验收驱动：创建自包含临时用户目录与验收仓库，
 * 支持同卷硬链接核心种子预热与 Git 夹具缓存，并在退出时强制回收子进程与临时目录。
 */
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// 预留宽于主进程 VERIFY_TOTAL_TIMEOUT_MS（480s）的 30s 收尾窗口，保证超时前先输出完整报告并清理子进程。
const DEFAULT_TIMEOUT_MS = 510_000
// 缓存目录不以 mydsh-verify- 开头，避免干扰验收目录泄漏检查，同时保持在同一临时磁盘卷上。
const VERIFY_CACHE_ROOT = join(tmpdir(), 'mydsh-cache-v1')
const PROJECT_TEMPLATE_VERSION = 'project-template-v2'

function assertHostGitAvailable() {
  const pathValue = process.env.PATH ?? process.env.Path ?? ''
  const candidates = process.platform === 'win32' ? ['git.exe', 'git.cmd', 'git'] : ['git']
  for (const segment of pathValue.split(delimiter)) {
    const trimmed = segment.trim()
    if (trimmed === '') continue
    for (const binary of candidates) {
      if (existsSync(join(trimmed, binary))) return
    }
  }
  throw new Error('当前环境 PATH 中未找到 git 可执行文件，无法准备验收项目。')
}

function populateProjectTemplate(targetRoot) {
  for (let index = 0; index < 24; index += 1) {
    const id = `verification-skill-${String(index + 1).padStart(2, '0')}`
    const directory = join(targetRoot, 'agents/skills', id)
    mkdirSync(directory, { recursive: true })
    writeFileSync(
      join(directory, 'SKILL.md'),
      `---\nname: ${id}\ndescription: 隔离验收技能，用于验证命令面板搜索和滚动。\n---\n\n仅用于 MyDSH 界面验收，不执行外部操作。\n`,
    )
  }
  const project = join(targetRoot, 'project')
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
}

function ensureCachedProjectTemplate() {
  assertHostGitAvailable()
  const templateDir = join(VERIFY_CACHE_ROOT, PROJECT_TEMPLATE_VERSION)
  const readyMarker = join(templateDir, '.ready')
  if (existsSync(readyMarker)) return templateDir
  mkdirSync(VERIFY_CACHE_ROOT, { recursive: true })
  const staging = mkdtempSync(join(VERIFY_CACHE_ROOT, 'staging-project-'))
  try {
    populateProjectTemplate(staging)
    writeFileSync(join(staging, '.ready'), '1\n')
    try {
      renameSync(staging, templateDir)
    } catch {
      if (!existsSync(readyMarker)) {
        rmSync(templateDir, { recursive: true, force: true })
        renameSync(staging, templateDir)
      }
    }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  return templateDir
}

function createVerificationProject(verifyHome) {
  const templateDir = ensureCachedProjectTemplate()
  cpSync(join(templateDir, 'agents'), join(verifyHome, 'agents'), { recursive: true })
  const project = join(verifyHome, 'project')
  cpSync(join(templateDir, 'project'), project, { recursive: true })
  return project
}

function hardlinkDirectoryTree(sourceDir, targetDir) {
  mkdirSync(targetDir, { recursive: true })
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const srcPath = join(sourceDir, entry.name)
    const dstPath = join(targetDir, entry.name)
    if (entry.isDirectory()) {
      hardlinkDirectoryTree(srcPath, dstPath)
    } else {
      linkSync(srcPath, dstPath)
    }
  }
}

async function materializeRuntimeSeed({
  bundleDirectory,
  installerPath,
  seedRoot,
  seedVersionDir,
}) {
  mkdirSync(join(VERIFY_CACHE_ROOT, 'runtime-seed'), { recursive: true })
  const staging = mkdtempSync(join(VERIFY_CACHE_ROOT, 'runtime-seed/staging-'))
  try {
    const { ensureRuntimeInstalled } = await import(pathToFileURL(installerPath).href)
    await ensureRuntimeInstalled({ bundleDirectory, mydshHome: staging })
    try {
      renameSync(staging, seedRoot)
    } catch {
      if (!existsSync(join(seedVersionDir, '.mydsh-install.json'))) {
        rmSync(seedRoot, { recursive: true, force: true })
        renameSync(staging, seedRoot)
      }
    }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

async function seedSourceRuntimeIfEligible({ cwd, args, mydshHome, coldInstall }) {
  if (coldInstall || args?.[0] !== '.') return
  const bundleDirectory = join(cwd, 'lib/mydsh-runtime')
  const manifestPath = join(bundleDirectory, 'manifest.json')
  const installerPath = join(cwd, 'lib/main/runtime/runtime-install.js')
  if (!existsSync(manifestPath) || !existsSync(installerPath)) return
  try {
    const manifestBytes = readFileSync(manifestPath)
    const manifest = JSON.parse(manifestBytes.toString('utf8'))
    const digest = createHash('sha256').update(manifestBytes).digest('hex').slice(0, 16)
    const seedRoot = join(VERIFY_CACHE_ROOT, 'runtime-seed', `${manifest.version}-${digest}`)
    const seedVersionDir = join(seedRoot, 'runtime', manifest.version)
    if (!existsSync(join(seedVersionDir, '.mydsh-install.json'))) {
      await materializeRuntimeSeed({ bundleDirectory, installerPath, seedRoot, seedVersionDir })
    }
    for (const sub of ['runtime', 'plugins', 'data', 'config', 'conversions', 'cache']) {
      mkdirSync(join(mydshHome, sub), { recursive: true })
    }
    hardlinkDirectoryTree(seedVersionDir, join(mydshHome, 'runtime', manifest.version))
  } catch {
    // 跨卷或权限不支持硬链接时清空半成品，回退到应用内完整离线冷安装路径。
    rmSync(mydshHome, { recursive: true, force: true })
  }
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

async function verifyBundledRuntimeTools({
  command,
  verifyHome,
  mydshHome,
  environment,
  systemPath,
}) {
  const runtimeRoot = join(mydshHome, 'runtime')
  if (!existsSync(runtimeRoot)) throw new Error('应用没有在隔离 MYDSH_HOME 中安装离线核心。')
  const versions = readdirSync(runtimeRoot).filter(name => !name.startsWith('.'))
  if (versions.length !== 1 || !existsSync(join(runtimeRoot, versions[0], '.mydsh-install.json'))) {
    throw new Error('离线核心没有留下唯一且完整的安装记录。')
  }
  const receipt = JSON.parse(
    readFileSync(join(runtimeRoot, versions[0], '.mydsh-install.json'), 'utf8'),
  )
  if (!existsSync(join(runtimeRoot, versions[0], receipt.entry))) {
    throw new Error('离线核心缺少已安装入口。')
  }
  for (const name of ['typescript', 'esbuild', 'npm']) {
    if (!existsSync(join(runtimeRoot, versions[0], 'node_modules', name, 'package.json'))) {
      throw new Error(`隔离核心缺少随包工具链 ${name}。`)
    }
  }
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
  const checkCliTool = async (name, entry) => {
    const packageRoot = join(installedRoot, 'node_modules', name)
    const version = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version
    const { stdout } = await execFileAsync(command, [join(packageRoot, entry), '--version'], {
      env: toolEnvironment,
      encoding: 'utf8',
      timeout: 10_000,
    })
    if (!stdout.includes(version)) {
      throw new Error(`随包 ${name} 没有通过应用自带 Node 的执行验收。`)
    }
  }
  const checkEsbuild = async () => {
    const esbuildRoot = join(installedRoot, 'node_modules/esbuild')
    const esbuildVersion = JSON.parse(
      readFileSync(join(esbuildRoot, 'package.json'), 'utf8'),
    ).version
    const esbuildProbe =
      "const esbuild = require(process.argv[1]); const result = esbuild.transformSync('const answer: number = 42', { loader: 'ts' }); if (!result.code.includes('42')) throw new Error('esbuild 编译结果无效'); console.log(esbuild.version)"
    const { stdout } = await execFileAsync(
      command,
      ['-e', esbuildProbe, join(esbuildRoot, 'lib/main.js')],
      { env: toolEnvironment, encoding: 'utf8', timeout: 10_000 },
    )
    if (stdout.trim() !== esbuildVersion) {
      throw new Error('随包 esbuild 未通过 API 版本与原生编译验收。')
    }
  }
  await Promise.all([
    checkCliTool('typescript', 'bin/tsc'),
    checkCliTool('npm', 'bin/npm-cli.js'),
    checkEsbuild(),
  ])
}

/**
 * 在隔离临时目录内启动目标命令进行真实运行时验收，并在退出后校验产物与回收资源。
 * @param {object} options 验收命令、参数、超时与隔离选项。
 */
export async function runRuntimeVerification({
  command,
  args,
  cwd,
  label,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  requireRuntime = false,
  useSystemKeychain = false,
  coldInstall = false,
  signal,
}) {
  if (signal?.aborted) throw new Error(`${label}已取消。`)
  // Windows 的临时目录可能带 8.3 短名；统一取规范长路径，避免与应用内 realpath 的结果不可比较。
  const verifyHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'mydsh-verify-')))
  console.log(`${label}隔离验收目录：${verifyHome}`)
  const mydshHome = join(verifyHome, 'mydsh')
  // Chromium 与 Electron 已知目录（含下载目录）在隔离 USERPROFILE 下必须存在。
  for (const directory of ['AppData/Roaming', 'AppData/Local', 'Downloads']) {
    mkdirSync(join(verifyHome, directory), { recursive: true })
  }
  let child
  let timedOut = false
  let stdout = ''
  let stderr = ''
  try {
    const verifyProject = realpathSync.native(createVerificationProject(verifyHome))
    if (requireRuntime) {
      await seedSourceRuntimeIfEligible({ cwd, args, mydshHome, coldInstall })
    }
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
    const result = await new Promise((resolveExit, rejectExit) => {
      child = spawn(command, args, {
        cwd,
        env: {
          ...environment,
          PATH: systemPath,
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
        rejectExit(error)
      })
      child.once('close', (code, exitSignal) => {
        signal?.removeEventListener('abort', stop)
        clearTimeout(deadline)
        if (forcedKill !== undefined) clearTimeout(forcedKill)
        resolveExit({ code, signal: exitSignal })
      })
    })
    if (signal?.aborted) throw new Error(`${label}已取消。`)
    if (timedOut) throw new Error(`${label}超过 ${String(timeoutMs)}ms 总时限。`)
    if (result.code !== 0) {
      throw new Error(
        `${label}失败，退出码 ${String(result.code)}，信号 ${String(result.signal)}。`,
      )
    }
    if (requireRuntime) {
      await verifyBundledRuntimeTools({ command, verifyHome, mydshHome, environment, systemPath })
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
