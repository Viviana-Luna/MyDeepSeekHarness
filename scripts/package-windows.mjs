/**
 * 生成 Windows 应用目录：Electron 运行时 + 自有主进程/渲染层 + 离线核心资源。
 *
 * 与 macOS 的差别只在平台参数与图标格式：Windows 使用 ICO，且不新增二进制资源，
 * 直接从已生成的 ICNS 取出各尺寸 PNG 重新封装成 ICO。
 */
import { packager } from '@electron/packager'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PRODUCT_BUNDLE_ID, PRODUCT_NAME, PRODUCT_SLUG } from '../lib/shared/product.js'

const root = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const electronManifest = JSON.parse(
  readFileSync(join(root, 'node_modules/electron/package.json'), 'utf8'),
)
const arch = process.env.MYDSH_ARCH ?? process.arch
const previewNumber = String(manifest.version).match(/-preview\.(\d+)$/u)?.[1]
const buildVersion = process.env.MYDSH_BUILD_VERSION ?? previewNumber ?? '1'
const desktopDependencies = {
  ws: manifest.dependencies?.ws,
  yaml: manifest.dependencies?.yaml,
}
const coreBundlePath = join(root, 'lib', 'mydsh-runtime')
const electronZipDir = process.env.MYDSH_ELECTRON_ZIP_DIR
if (electronZipDir) {
  const filename = `electron-v${electronManifest.version}-win32-${arch}.zip`
  const checksums = JSON.parse(
    readFileSync(join(dirname(require.resolve('electron/package.json')), 'checksums.json'), 'utf8'),
  )
  const digest = createHash('sha256')
    .update(readFileSync(join(electronZipDir, filename)))
    .digest('hex')
  if (digest !== checksums[filename]) throw new Error('离线 Electron ZIP 与官方摘要不一致')
}

if (process.platform !== 'win32') {
  throw new Error('MyDSH 的 Windows 应用只能在 Windows 上构建。')
}
if (arch !== process.arch) {
  throw new Error(`当前核心原生依赖未构建为 win32-${arch}，请在对应架构构建。`)
}
if (arch !== 'x64') throw new Error(`不支持的 Windows 架构：${arch}`)
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
for (const [name, version] of Object.entries(desktopDependencies)) {
  if (typeof version !== 'string' || version === '')
    throw new Error(`package.json 缺少桌面运行依赖 ${name}。`)
}
if (
  !existsSync(join(coreBundlePath, 'manifest.json')) ||
  !existsSync(join(coreBundlePath, 'runtime.asar'))
) {
  throw new Error('缺少离线核心安装包，请先完成 build:runtime。')
}
const coreManifest = JSON.parse(readFileSync(join(coreBundlePath, 'manifest.json'), 'utf8'))
if (coreManifest.platform !== 'win32' || coreManifest.arch !== arch)
  throw new Error('离线核心平台或架构不匹配。')
if (coreManifest.version !== manifest.version) throw new Error('离线核心版本与应用版本不一致。')

/** ICNS 使用的尺寸分块类型；ICO 只接受不超过 256px 的条目。 */
const ICNS_PNG_TYPES = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
]

/** 读取 ICNS 里指定类型的分块内容。 */
function readIcnsChunk(icns, type) {
  let offset = 8
  while (offset + 8 <= icns.length) {
    const chunkType = icns.toString('ascii', offset, offset + 4)
    const length = icns.readUInt32BE(offset + 4)
    if (length < 8 || offset + length > icns.length) throw new Error('应用图标 ICNS 结构无效。')
    if (chunkType === type) return icns.subarray(offset + 8, offset + length)
    offset += length
  }
  return undefined
}

/** 用已生成的 ICNS 各尺寸 PNG 封装 Windows ICO。 */
function writeIcoFile(destination) {
  const icns = readFileSync(join(root, 'assets', 'app-icon.icns'))
  const images = ICNS_PNG_TYPES.map(([type, size]) => {
    const png = readIcnsChunk(icns, type)
    if (png === undefined) throw new Error(`应用图标 ICNS 缺少 ${String(size)}px 分块。`)
    return { size, png }
  })
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = header.length + images.length * 16
  const entries = images.map(({ size, png }) => {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(size >= 256 ? 0 : size, 0)
    entry.writeUInt8(size >= 256 ? 0 : size, 1)
    entry.writeUInt8(0, 2)
    entry.writeUInt8(0, 3)
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(png.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += png.length
    return entry
  })
  writeFileSync(
    destination,
    Buffer.concat([header, ...entries, ...images.map(image => image.png)]),
    { mode: 0o644 },
  )
}

const temporaryRoot = mkdtempSync(join(tmpdir(), 'mydsh-package-win-'))
const applicationRoot = join(temporaryRoot, 'app')
const outputRoot = join(root, 'out')
mkdirSync(applicationRoot, { recursive: true, mode: 0o700 })

try {
  const iconPath = join(temporaryRoot, 'app-icon.ico')
  writeIcoFile(iconPath)
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
  // 核心含原生模块与工具链（node-pty、ripgrep 等），必须作为普通资源安装，不能封进 ASAR。
  cpSync(join(root, 'lib'), join(applicationRoot, 'lib'), {
    recursive: true,
    filter: path =>
      path !== coreBundlePath &&
      !path.startsWith(`${coreBundlePath}\\`) &&
      !path.startsWith(`${coreBundlePath}/`),
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

  const applicationPaths = await packager({
    dir: applicationRoot,
    out: outputRoot,
    platform: 'win32',
    arch,
    name: PRODUCT_NAME,
    executableName: PRODUCT_NAME,
    appBundleId: PRODUCT_BUNDLE_ID,
    appVersion: manifest.version,
    buildVersion,
    electronVersion: electronManifest.version,
    ...(electronZipDir ? { electronZipDir } : {}),
    icon: iconPath,
    asar: { unpack: '**/*.node' },
    extraResource: [coreBundlePath],
    overwrite: true,
    prune: true,
    junk: true,
    win32metadata: {
      CompanyName: 'MyDSH contributors',
      FileDescription: PRODUCT_NAME,
      ProductName: PRODUCT_NAME,
      InternalName: PRODUCT_NAME,
      OriginalFilename: `${PRODUCT_NAME}.exe`,
    },
  })
  if (applicationPaths.length !== 1) {
    throw new Error(`预期生成一个 Windows 应用，实际为 ${String(applicationPaths.length)} 个。`)
  }
  const packageDirectory = applicationPaths[0]
  if (packageDirectory === undefined) throw new Error('Electron Packager 没有返回应用路径。')
  const executablePath = join(packageDirectory, `${PRODUCT_NAME}.exe`)
  if (!existsSync(executablePath)) throw new Error(`Windows 应用缺少可执行文件：${executablePath}`)
  const packagedCore = join(packageDirectory, 'resources', 'mydsh-runtime')
  if (!existsSync(join(packagedCore, 'runtime.asar')))
    throw new Error('Windows 应用没有携带离线核心归档。')
  cpSync(iconPath, join(outputRoot, 'MyDSH.ico'))
  console.log(`package-windows: ${executablePath}`)
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
