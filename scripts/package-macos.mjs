import { packager } from '@electron/packager'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PRODUCT_BUNDLE_ID, PRODUCT_NAME, PRODUCT_SLUG } from '../lib/shared/product.js'

const root = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const electronManifest = JSON.parse(
  readFileSync(join(root, 'node_modules/electron/package.json'), 'utf8'),
)
const arch = process.env.MYDSH_ARCH ?? process.arch
if (arch !== process.arch) {
  throw new Error(`当前核心原生依赖未构建为 darwin-${arch}，请在对应架构构建。`)
}
const previewNumber = String(manifest.version).match(/-preview\.(\d+)$/u)?.[1]
const buildVersion = process.env.MYDSH_BUILD_VERSION ?? previewNumber ?? '1'
const signingIdentity = process.env.MYDSH_SIGN_IDENTITY
const electronArchiveName = `electron-v${electronManifest.version}-darwin-${arch}.zip`
const desktopDependencies = {
  ws: manifest.dependencies?.ws,
  yaml: manifest.dependencies?.yaml,
}
const coreBundlePath = join(root, 'lib', 'mydsh-runtime')

function cachedElectronDirectory(rootDirectory) {
  if (!existsSync(rootDirectory)) return undefined
  if (existsSync(join(rootDirectory, electronArchiveName))) return rootDirectory
  for (const entry of readdirSync(rootDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const directory = join(rootDirectory, entry.name)
    if (existsSync(join(directory, electronArchiveName))) return directory
  }
  return undefined
}

const cachedElectron = [
  join(root, 'node_modules', '.cache', 'electron-packager'),
  join(homedir(), 'Library', 'Caches', 'electron'),
]
  .map(cachedElectronDirectory)
  .find(directory => directory !== undefined)

if (process.platform !== 'darwin') throw new Error('MyDSH 的 macOS 应用只能在 macOS 上构建。')
if (!['arm64', 'x64'].includes(arch)) throw new Error(`不支持的 macOS 架构：${arch}`)
if (manifest.productName !== PRODUCT_NAME || manifest.name !== PRODUCT_SLUG) {
  throw new Error('package.json 的产品身份与发行脚本不一致。')
}
if (
  typeof manifest.version !== 'string' ||
  !/^\d+\.\d+\.\d+(?:-[\da-z.-]+)?$/iu.test(manifest.version)
) {
  throw new Error('package.json 必须包含有效的语义化版本。')
}
if (!/^\d+$/u.test(buildVersion) || Number(buildVersion) < 1) {
  throw new Error('MYDSH_BUILD_VERSION 必须是正整数。')
}
for (const [name, version] of Object.entries(desktopDependencies))
  if (typeof version !== 'string' || version === '')
    throw new Error(`package.json 缺少桌面运行依赖 ${name}。`)
if (
  !existsSync(join(coreBundlePath, 'manifest.json')) ||
  !existsSync(join(coreBundlePath, 'runtime.asar'))
) {
  throw new Error('缺少离线核心安装包，请先完成 build:runtime。')
}
const coreManifest = JSON.parse(readFileSync(join(coreBundlePath, 'manifest.json'), 'utf8'))
if (coreManifest.version !== manifest.version) throw new Error('离线核心版本与应用版本不一致。')
const temporaryRoot = mkdtempSync(join(tmpdir(), 'mydsh-package-'))
const applicationRoot = join(temporaryRoot, 'app')
const outputRoot = join(root, 'out')
mkdirSync(applicationRoot, { recursive: true, mode: 0o700 })

try {
  const runtimeManifest = {
    name: manifest.name,
    productName: manifest.productName,
    version: manifest.version,
    description: manifest.description,
    repository: manifest.repository,
    private: true,
    type: 'module',
    main: 'lib/main/index.js',
    license: manifest.license,
    dependencies: desktopDependencies,
  }
  writeFileSync(
    join(applicationRoot, 'package.json'),
    `${JSON.stringify(runtimeManifest, null, 2)}\n`,
    { mode: 0o600 },
  )
  // 核心含原生模块和工具链，必须作为普通资源安装，不能封进 ASAR 或重复携带。
  cpSync(join(root, 'lib'), join(applicationRoot, 'lib'), {
    recursive: true,
    filter: path => path !== coreBundlePath && !path.startsWith(`${coreBundlePath}/`),
  })
  mkdirSync(join(applicationRoot, 'node_modules'), { recursive: true, mode: 0o700 })
  for (const depName of Object.keys(desktopDependencies)) {
    cpSync(
      dirname(require.resolve(`${depName}/package.json`)),
      join(applicationRoot, 'node_modules', depName),
      {
        recursive: true,
        dereference: true,
      },
    )
  }
  cpSync(join(root, 'LICENSE'), join(applicationRoot, 'LICENSE'))

  const entitlements = join(root, 'build', 'entitlements.mac.plist')
  const osxSign =
    signingIdentity === undefined
      ? undefined
      : {
          identity: signingIdentity,
          hardenedRuntime: true,
          entitlements,
          continueOnError: false,
        }
  const applicationPaths = await packager({
    dir: applicationRoot,
    out: outputRoot,
    platform: 'darwin',
    arch,
    name: PRODUCT_NAME,
    executableName: PRODUCT_NAME,
    appBundleId: PRODUCT_BUNDLE_ID,
    appCategoryType: 'public.app-category.developer-tools',
    appVersion: manifest.version,
    buildVersion,
    electronVersion: electronManifest.version,
    ...(cachedElectron === undefined
      ? { download: { cacheRoot: join(root, 'node_modules', '.cache', 'electron-packager') } }
      : { electronZipDir: cachedElectron }),
    icon: join(root, 'assets', 'app-icon.icns'),
    asar: {
      unpack: '**/lib/main/*.node',
    },
    extraResource: [coreBundlePath],
    overwrite: true,
    prune: true,
    junk: true,
    ...(osxSign === undefined ? {} : { osxSign }),
    extendInfo: {
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: false,
        NSAllowsLocalNetworking: true,
      },
      NSHumanReadableCopyright: 'Copyright © 2026 MyDSH contributors',
    },
  })
  if (applicationPaths.length !== 1) {
    throw new Error(`预期生成一个 macOS 应用，实际为 ${String(applicationPaths.length)} 个。`)
  }
  const packageDirectory = applicationPaths[0]
  if (packageDirectory === undefined) throw new Error('Electron Packager 没有返回应用路径。')
  const applicationPath = join(packageDirectory, `${PRODUCT_NAME}.app`)
  if (signingIdentity === undefined) {
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', applicationPath], {
      stdio: 'inherit',
    })
  }
  // 深度签名可能改写核心原生文件；先更新实际发行字节的摘要，再重封外层资源。
  const packagedCore = join(applicationPath, 'Contents', 'Resources', 'mydsh-runtime')
  const packagedManifest = JSON.parse(readFileSync(join(packagedCore, 'manifest.json'), 'utf8'))
  const physicalRoot =
    packagedManifest.archive === undefined ? join(packagedCore, 'payload') : packagedCore
  for (const [path, record] of Object.entries(packagedManifest.files)) {
    const absolute = join(physicalRoot, path)
    const bytes = readFileSync(absolute)
    record.sha256 = createHash('sha256').update(bytes).digest('hex')
    record.size = statSync(absolute).size
  }
  writeFileSync(
    join(packagedCore, 'manifest.json'),
    `${JSON.stringify(packagedManifest, null, 2)}\n`,
  )
  execFileSync(
    '/usr/bin/codesign',
    [
      '--force',
      '--sign',
      signingIdentity ?? '-',
      ...(signingIdentity === undefined
        ? []
        : ['--options', 'runtime', '--entitlements', entitlements]),
      applicationPath,
    ],
    { stdio: 'inherit' },
  )
  console.log(`package-macos: ${applicationPath}`)
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
