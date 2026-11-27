/** 使用 Windows SDK 和稳定 Node-API 构建背景裁剪与窗口缩放；不需要 Electron ABI 重建。 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import headers from 'node-api-headers'

const versions = directory =>
  readdirSync(directory).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))

if (process.platform === 'win32') {
  if (process.arch !== 'x64') throw new Error('原生 Windows 背景只支持 x64')
  const root = resolve(import.meta.dirname, '..')
  const output = join(root, 'lib', 'main', 'window-background.node')
  const cacheFile = join(root, '.build', 'native-window-background-cache.json')
  const hash = createHash('sha256')
  hash.update(readFileSync(join(root, 'native', 'window-background.cc')))
  hash.update(readFileSync(join(root, 'scripts', 'build-window-background.mjs')))
  hash.update(readFileSync(join(root, 'package.json')))
  const fingerprint = hash.digest('hex')
  if (!process.argv.includes('--force') && existsSync(output) && existsSync(cacheFile)) {
    try {
      if (JSON.parse(readFileSync(cacheFile, 'utf8')).fingerprint === fingerprint) {
        process.exit(0)
      }
    } catch {
      /* 缓存文件损坏时回退重新编译。 */
    }
  }
  const programs = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const locator = join(programs, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  if (!existsSync(locator))
    throw new Error('编译 Windows 背景需要 Visual Studio C++ Build Tools 与 Windows SDK')
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
    {
      encoding: 'utf8',
      windowsHide: true,
    },
  ).trim()
  if (!studio) throw new Error('没有找到已安装的 MSVC x64 编译工具')
  const toolsRoot = join(studio, 'VC', 'Tools', 'MSVC')
  const toolsVersion = versions(toolsRoot)[0]
  if (!toolsVersion) throw new Error('MSVC 编译工具目录为空')
  const tools = join(toolsRoot, toolsVersion)
  const sdk = join(programs, 'Windows Kits', '10')
  const sdkVersion = versions(join(sdk, 'Include')).find(
    version =>
      existsSync(join(sdk, 'Include', version, 'cppwinrt', 'winrt', 'Windows.UI.Composition.h')) &&
      existsSync(join(sdk, 'Lib', version, 'um', 'x64', 'windowsapp.lib')),
  )
  if (!sdkVersion) throw new Error('Windows SDK 缺少 WinRT 合成头文件或 x64 库')
  const temporary = mkdtempSync(join(tmpdir(), 'mydsh-window-background-build-'))
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
        ...['ucrt', 'shared', 'um', 'winrt', 'cppwinrt'].map(
          directory => '/I' + join(sdk, 'Include', sdkVersion, directory),
        ),
        join(root, 'native', 'window-background.cc'),
        '/Fo' + join(temporary, 'window-background.obj'),
        '/Fe' + output,
        '/link',
        '/IMPLIB:' + join(temporary, 'window-background.lib'),
        '/LIBPATH:' + join(tools, 'lib', 'x64'),
        '/LIBPATH:' + join(sdk, 'Lib', sdkVersion, 'um', 'x64'),
        '/LIBPATH:' + join(sdk, 'Lib', sdkVersion, 'ucrt', 'x64'),
        'windowsapp.lib',
        'user32.lib',
        'dwmapi.lib',
        'CoreMessaging.lib',
        'comctl32.lib',
      ],
      { stdio: 'inherit', windowsHide: true },
    )
    mkdirSync(join(root, '.build'), { recursive: true })
    writeFileSync(cacheFile, `${JSON.stringify({ fingerprint }, null, 2)}\n`)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}
