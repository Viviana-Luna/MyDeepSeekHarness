/** 双端构建系统级 Computer Use 原生模块：macOS 使用 xcrun clang，Windows 使用 MSVC + node-api-headers。 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import headers from 'node-api-headers'

const root = resolve(import.meta.dirname, '..')
const output = join(root, 'lib', 'main', 'computer-use.node')
const cacheFile = join(root, '.build', 'native-computer-use-cache.json')

function computeComputerUseFingerprint() {
  const hash = createHash('sha256')
  hash.update(`${process.platform}:${process.arch}\0`)
  hash.update(readFileSync(join(root, 'package.json')))
  hash.update(readFileSync(join(root, 'scripts', 'build-computer-use.mjs')))
  const sourceName = process.platform === 'darwin' ? 'computer-use-mac.m' : 'computer-use-win.cc'
  const sourcePath = join(root, 'native', sourceName)
  if (existsSync(sourcePath)) hash.update(readFileSync(sourcePath))
  return hash.digest('hex')
}

function versionsDesc(directory) {
  return readdirSync(directory).toSorted((a, b) => b.localeCompare(a, 'en', { numeric: true }))
}

function buildMac() {
  const { version } = JSON.parse(
    readFileSync(join(root, 'node_modules/electron/package.json'), 'utf8'),
  )
  const electronHeaders = join(homedir(), '.electron-gyp', version, 'include', 'node')
  const includeDir = existsSync(join(electronHeaders, 'node_api.h'))
    ? electronHeaders
    : headers.include_dir
  if (!existsSync(join(includeDir, 'node_api.h'))) {
    throw new Error('缺少 Node-API 头文件，请先完成 pnpm install 的原生依赖准备。')
  }
  mkdirSync(join(root, 'lib', 'main'), { recursive: true })
  execFileSync(
    '/usr/bin/xcrun',
    [
      'clang',
      '-bundle',
      '-fobjc-arc',
      '-O2',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-DNAPI_VERSION=8',
      '-arch',
      process.arch === 'x64' ? 'x86_64' : process.arch,
      '-mmacosx-version-min=12.0',
      '-undefined',
      'dynamic_lookup',
      '-framework',
      'AppKit',
      '-framework',
      'CoreGraphics',
      '-framework',
      'ApplicationServices',
      '-framework',
      'ImageIO',
      '-framework',
      'UniformTypeIdentifiers',
      '-weak_framework',
      'ScreenCaptureKit',
      '-I',
      includeDir,
      join(root, 'native', 'computer-use-mac.m'),
      '-o',
      output,
    ],
    { stdio: 'inherit' },
  )
}

function buildWindows() {
  if (process.arch !== 'x64') throw new Error('Windows Computer Use 原生模块仅支持 x64')
  const programs = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const locator = join(programs, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  if (!existsSync(locator)) {
    throw new Error(
      '编译 Windows Computer Use 模块需要 Visual Studio C++ Build Tools 与 Windows SDK',
    )
  }
  const studio = execFileSync(
    locator,
    [
      '-latest',
      '-products',
      '*',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property',
      'installationPath',
    ],
    { encoding: 'utf8', windowsHide: true },
  ).trim()
  if (!studio) throw new Error('未找到已安装的 MSVC x64 编译工具')
  const toolsRoot = join(studio, 'VC', 'Tools', 'MSVC')
  const toolsVersion = versionsDesc(toolsRoot)[0]
  if (!toolsVersion) throw new Error('MSVC 编译工具目录为空')
  const tools = join(toolsRoot, toolsVersion)
  const sdk = join(programs, 'Windows Kits', '10')
  const sdkVersion = versionsDesc(join(sdk, 'Include')).find(
    ver =>
      existsSync(join(sdk, 'Include', ver, 'um', 'windows.h')) &&
      existsSync(join(sdk, 'Lib', ver, 'um', 'x64', 'user32.lib')),
  )
  if (!sdkVersion) throw new Error('Windows SDK 缺少 x64 头文件或系统库')
  const temporary = mkdtempSync(join(tmpdir(), 'mydsh-computer-use-build-'))
  mkdirSync(join(root, 'lib', 'main'), { recursive: true })
  try {
    execFileSync(
      join(tools, 'bin', 'Hostx64', 'x64', 'cl.exe'),
      [
        '/nologo',
        '/LD',
        '/O2',
        '/std:c++20',
        '/EHsc',
        '/MT',
        '/utf-8',
        '/W4',
        '/WX',
        '/DNAPI_VERSION=8',
        '/I' + join(tools, 'include'),
        '/I' + headers.include_dir,
        ...['ucrt', 'shared', 'um'].map(dir => '/I' + join(sdk, 'Include', sdkVersion, dir)),
        join(root, 'native', 'computer-use-win.cc'),
        '/Fo' + join(temporary, 'computer-use.obj'),
        '/Fe' + output,
        '/link',
        '/IMPLIB:' + join(temporary, 'computer-use.lib'),
        '/LIBPATH:' + join(tools, 'lib', 'x64'),
        '/LIBPATH:' + join(sdk, 'Lib', sdkVersion, 'um', 'x64'),
        '/LIBPATH:' + join(sdk, 'Lib', sdkVersion, 'ucrt', 'x64'),
        'user32.lib',
        'dwmapi.lib',
        'advapi32.lib',
      ],
      { stdio: 'inherit', windowsHide: true },
    )
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

const fingerprint = computeComputerUseFingerprint()
const skipNativeBuild =
  !process.argv.includes('--force') &&
  existsSync(output) &&
  existsSync(cacheFile) &&
  (() => {
    try {
      return JSON.parse(readFileSync(cacheFile, 'utf8')).fingerprint === fingerprint
    } catch {
      return false
    }
  })()

if (!skipNativeBuild) {
  if (process.platform === 'darwin') buildMac()
  else if (process.platform === 'win32') buildWindows()
  if (process.platform === 'darwin' || process.platform === 'win32') {
    mkdirSync(join(root, '.build'), { recursive: true })
    writeFileSync(cacheFile, `${JSON.stringify({ fingerprint }, null, 2)}\n`)
  }
}
