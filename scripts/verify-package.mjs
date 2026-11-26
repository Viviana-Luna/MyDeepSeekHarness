import { extractFile, listPackage } from '@electron/asar'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { PRODUCT_BUNDLE_ID, PRODUCT_NAME, PRODUCT_SLUG } from '../lib/shared/product.js'
import { parseRuntimeBundleManifest } from '../lib/main/runtime/runtime-install.js'

/** 校验随包核心的完整闭包，不能只凭入口存在就宣称离线安装可用。 */
function verifyCoreBundle(bundlePath, applicationVersion, failures) {
  try {
    const manifest = parseRuntimeBundleManifest(
      JSON.parse(readFileSync(join(bundlePath, 'manifest.json'), 'utf8')),
    )
    if (manifest.version !== applicationVersion) throw new Error('核心版本与应用版本不匹配')
    const pending = [join(bundlePath, 'payload')]
    const remaining = new Set(Object.keys(manifest.files))
    while (pending.length) {
      const directory = pending.pop()
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isSymbolicLink()) throw new Error('核心安装包不得包含符号链接')
        if (entry.isDirectory()) {
          pending.push(path)
          continue
        }
        const name = relative(join(bundlePath, 'payload'), path)
        const expected = manifest.files[name]
        if (!entry.isFile() || !expected) throw new Error(`核心存在清单外内容：${name}`)
        const bytes = readFileSync(path)
        if (
          bytes.length !== expected.size ||
          createHash('sha256').update(bytes).digest('hex') !== expected.sha256
        )
          throw new Error(`核心文件校验失败：${name}`)
        if (expected.executable && (statSync(path).mode & 0o111) === 0)
          throw new Error(`核心工具缺少执行权限：${name}`)
        remaining.delete(name)
      }
    }
    if (remaining.size) throw new Error(`核心缺少文件：${remaining.values().next().value}`)
    for (const name of [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-agent-loop',
      'typescript',
      'esbuild',
      'npm',
      '@mydsh/sdk',
      '@mydsh/desktop-services',
      '@mydsh/browser-automation',
      '@mydsh/computer-use',
      '@vscode/ripgrep',
    ]) {
      if (!manifest.files[`node_modules/${name}/package.json`])
        throw new Error(`核心缺少必要模块 ${name}`)
    }
    for (const name of ['LICENSE', 'manifest.json', 'README.zh.md']) {
      if (!manifest.files[`licenses/deepseek-harness/${name}`])
        throw new Error(`核心缺少 DSH 来源或许可材料 ${name}`)
    }
  } catch (error) {
    failures.push(`离线核心安装包无效：${error.message}`)
  }
}

function findUnsafeSymlinks(rootPath) {
  const pending = [rootPath]
  const unsafeLinks = []

  while (pending.length > 0) {
    const currentPath = pending.pop()
    for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
      const entryPath = join(currentPath, entry.name)
      if (entry.isSymbolicLink()) {
        const target = readlinkSync(entryPath)
        const resolvedTarget = resolve(dirname(entryPath), target)
        const targetFromRoot = relative(rootPath, resolvedTarget)
        const escapesRoot =
          targetFromRoot === '..' ||
          targetFromRoot.startsWith(`..${sep}`) ||
          isAbsolute(targetFromRoot)
        if (isAbsolute(target) || escapesRoot) {
          unsafeLinks.push(`${relative(rootPath, entryPath)} -> ${target}`)
        }
      } else if (entry.isDirectory()) {
        pending.push(entryPath)
      }
    }
  }

  return unsafeLinks
}

function verifyDmgApplication(dmgPath, failures) {
  const mountPath = mkdtempSync(join(tmpdir(), 'mydsh-dmg-verify-'))
  let mounted = false

  try {
    try {
      execFileSync(
        '/usr/bin/hdiutil',
        ['attach', '-readonly', '-nobrowse', '-mountpoint', mountPath, dmgPath],
        { stdio: 'pipe' },
      )
    } catch {
      failures.push('无法以只读方式挂载 DMG 进行应用验收')
      return
    }
    mounted = true

    const mountedApplicationPath = join(mountPath, `${PRODUCT_NAME}.app`)
    if (!existsSync(mountedApplicationPath)) {
      failures.push(`DMG 内缺少 ${PRODUCT_NAME}.app`)
      return
    }

    let unsafeLinks
    try {
      unsafeLinks = findUnsafeSymlinks(mountedApplicationPath)
    } catch {
      failures.push('无法读取 DMG 内应用的符号链接结构')
      return
    }
    if (unsafeLinks.length > 0) {
      failures.push(`DMG 内应用包含越界或绝对符号链接：${unsafeLinks.slice(0, 5).join('；')}`)
    }

    try {
      execFileSync(
        '/usr/bin/codesign',
        ['--verify', '--deep', '--strict', mountedApplicationPath],
        { stdio: 'pipe' },
      )
    } catch {
      failures.push('DMG 内应用代码签名校验失败')
    }
  } finally {
    if (mounted) {
      try {
        execFileSync('/usr/bin/hdiutil', ['detach', mountPath], { stdio: 'pipe' })
        mounted = false
      } catch {
        failures.push('DMG 验收挂载点清理失败')
      }
    }
    if (!mounted) rmSync(mountPath, { recursive: true, force: true })
  }
}

const root = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const arch = process.env.MYDSH_ARCH ?? process.arch
const applicationPath = join(root, 'out', `${PRODUCT_NAME}-darwin-${arch}`, `${PRODUCT_NAME}.app`)
const plistPath = join(applicationPath, 'Contents', 'Info.plist')
const asarPath = join(applicationPath, 'Contents', 'Resources', 'app.asar')
const executablePath = join(applicationPath, 'Contents', 'MacOS', PRODUCT_NAME)
const coreBundlePath = join(applicationPath, 'Contents', 'Resources', 'mydsh-runtime')
const runtimeNodePtyPath = join(
  coreBundlePath,
  'payload/node_modules/@mydsh/desktop-services/node_modules/node-pty/build/Release',
)
const ripgrepPath = join(
  coreBundlePath,
  'payload/node_modules',
  `@vscode/ripgrep-darwin-${arch}`,
  'bin/rg',
)

function plistValue(key) {
  return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plistPath], {
    encoding: 'utf8',
  }).trim()
}

const failures = []
if (!existsSync(applicationPath)) failures.push('缺少 MyDSH.app')
if (!existsSync(executablePath)) failures.push('缺少已重命名的 MyDSH 主可执行文件')
if (!existsSync(asarPath)) failures.push('缺少 app.asar')
if (!existsSync(ripgrepPath)) failures.push('离线核心缺少项目文件索引所需的固定 Ripgrep 二进制')
if (existsSync(join(applicationPath, 'Contents/Resources/rg')))
  failures.push('桌面资源不应重复携带已迁入运行核心的 Ripgrep')
verifyCoreBundle(coreBundlePath, manifest.version, failures)
if (
  !existsSync(join(runtimeNodePtyPath, 'pty.node')) ||
  !existsSync(join(runtimeNodePtyPath, 'spawn-helper'))
) {
  failures.push('离线核心缺少用户终端所需的 node-pty 原生模块或启动助手')
}
if (failures.length === 0) {
  if (plistValue('CFBundleIdentifier') !== PRODUCT_BUNDLE_ID) failures.push('Bundle ID 不正确')
  if (plistValue('CFBundleName') !== PRODUCT_NAME) failures.push('CFBundleName 不正确')
  if (plistValue('CFBundleDisplayName') !== PRODUCT_NAME)
    failures.push('CFBundleDisplayName 不正确')
  if (plistValue('CFBundleExecutable') !== PRODUCT_NAME) failures.push('CFBundleExecutable 不正确')
  if (plistValue('CFBundleShortVersionString') !== manifest.version) failures.push('应用版本不正确')
  if (plistValue('NSAppTransportSecurity:NSAllowsArbitraryLoads') !== 'false') {
    failures.push('ATS 不得允许任意网络加载')
  }
  if (plistValue('NSAppTransportSecurity:NSAllowsLocalNetworking') !== 'true') {
    failures.push('ATS 本地网络配置不正确')
  }
  try {
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', applicationPath], {
      stdio: 'pipe',
    })
  } catch {
    failures.push('应用代码签名校验失败')
  }
  const entries = listPackage(asarPath)
  if (!entries.includes('/package.json') || !entries.includes('/lib/main/index.js')) {
    failures.push('ASAR 缺少运行时入口')
  }
  if (!existsSync(join(coreBundlePath, 'payload/node_modules/@vscode/ripgrep/LICENSE')))
    failures.push('离线核心缺少 Ripgrep 许可证')
  if (!entries.includes('/node_modules/yaml/package.json'))
    failures.push('ASAR 缺少数据导入所需的 YAML 解析依赖')
  if (!entries.includes('/node_modules/ws/package.json'))
    failures.push('ASAR 缺少外置浏览器 CDP 所需的 WebSocket（ws）依赖')
  const resourcesPath = join(applicationPath, 'Contents', 'Resources')
  const unpackedComputerUse = join(resourcesPath, 'app.asar.unpacked/lib/main/computer-use.node')
  if (!entries.includes('/lib/main/computer-use.node') || !existsSync(unpackedComputerUse)) {
    failures.push('ASAR 未携带或未解包桌面 Computer Use 原生模块 lib/main/computer-use.node')
  }
  if (entries.some(entry => entry.startsWith('/lib/mydsh-runtime/')))
    failures.push('核心安装包不应重复封入 ASAR')
  const allowedAsarModules = ['yaml', 'ws']
  if (
    entries.some(
      entry =>
        (entry.startsWith('/node_modules/') &&
          !allowedAsarModules.some(
            mod => entry === `/node_modules/${mod}` || entry.startsWith(`/node_modules/${mod}/`),
          )) ||
        entry.startsWith('/packages/') ||
        entry.startsWith('/apps/') ||
        entry.startsWith('/src/') ||
        entry.startsWith('/tests/'),
    )
  ) {
    failures.push('ASAR 携带了未批准依赖、DSH 源码或测试源码')
  }
  const runtimeManifest = JSON.parse(extractFile(asarPath, 'package.json').toString('utf8'))
  if (
    runtimeManifest.name !== PRODUCT_SLUG ||
    runtimeManifest.productName !== PRODUCT_NAME ||
    runtimeManifest.version !== manifest.version ||
    runtimeManifest.main !== 'lib/main/index.js' ||
    runtimeManifest.dependencies?.yaml !== manifest.dependencies?.yaml ||
    runtimeManifest.dependencies?.ws !== manifest.dependencies?.ws ||
    Object.keys(runtimeManifest.dependencies ?? {}).some(name => !allowedAsarModules.includes(name))
  ) {
    failures.push('ASAR 运行时 manifest 身份不正确')
  }
  try {
    const ripgrepVersion = execFileSync(ripgrepPath, ['--version'], { encoding: 'utf8' })
    if (!ripgrepVersion.startsWith('ripgrep ')) failures.push('固定 Ripgrep 二进制无法报告版本')
    const ripgrepArchitectures = execFileSync('/usr/bin/lipo', ['-archs', ripgrepPath], {
      encoding: 'utf8',
    })
      .trim()
      .split(/\s+/u)
    if (!ripgrepArchitectures.includes(arch)) failures.push(`Ripgrep 二进制不包含目标架构 ${arch}`)
  } catch {
    failures.push('固定 Ripgrep 二进制无法执行或检查架构')
  }
  try {
    for (const path of [
      join(runtimeNodePtyPath, 'pty.node'),
      join(runtimeNodePtyPath, 'spawn-helper'),
      join(resourcesPath, 'app.asar.unpacked/lib/main/computer-use.node'),
      join(resourcesPath, 'app.asar.unpacked/lib/main/window-controls.node'),
    ]) {
      const architectures = execFileSync('/usr/bin/lipo', ['-archs', path], { encoding: 'utf8' })
        .trim()
        .split(/\s+/u)
      if (!architectures.includes(arch))
        failures.push(`原生模块文件不包含目标架构 ${arch}：${path}`)
    }
  } catch (error) {
    failures.push(`无法检查原生模块架构：${error instanceof Error ? error.message : String(error)}`)
  }
}

if (process.argv.includes('--made')) {
  const baseName = `mydsh-macOS-${arch}-${manifest.version}`
  const dmgPath = join(root, 'out', 'make', `${baseName}.dmg`)
  if (!existsSync(dmgPath)) failures.push(`缺少发行产物：${baseName}.dmg`)
  if (existsSync(dmgPath)) {
    try {
      execFileSync('/usr/bin/hdiutil', ['verify', dmgPath], { stdio: 'pipe' })
    } catch {
      failures.push('DMG 镜像完整性校验失败')
    }
    verifyDmgApplication(dmgPath, failures)
  }
}

if (failures.length !== 0) {
  for (const failure of failures) console.error(`verify-package: ${failure}`)
  process.exitCode = 1
} else {
  console.log(
    `verify-package: ${PRODUCT_NAME} ${manifest.version} (${arch}) 身份、签名和内容有效。`,
  )
}
