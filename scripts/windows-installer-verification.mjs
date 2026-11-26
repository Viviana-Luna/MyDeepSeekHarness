/** 用制品内的 NSIS 解压插件解出应用，避免现代 7-Zip 掩盖安装器的解码兼容问题。 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const builder = createRequire(import.meta.resolve('electron-builder'))
const { getMakeNsisPath } = builder('app-builder-lib/out/toolsets/windows.js')
const nsisLiteral = value => value.replaceAll('$', () => '$$')

export async function withExtractedWindowsInstaller(installer, verify) {
  const temporary = realpathSync.native(mkdtempSync(join(tmpdir(), 'mydsh-installer-verify-')))
  try {
    const parts = join(temporary, 'parts')
    const application = join(temporary, 'application')
    mkdirSync(parts)
    mkdirSync(application)
    // 只用完整 7-Zip 取出内层归档和插件；实际应用必须由制品自己的 Nsis7z 解码。
    const sevenZip =
      [process.env.ProgramW6432, process.env.ProgramFiles]
        .filter(Boolean)
        .map(directory => join(directory, '7-Zip/7z.exe'))
        .find(path => existsSync(path)) ?? '7z.exe'
    try {
      execFileSync(sevenZip, ['i'], { stdio: 'ignore', windowsHide: true, timeout: 10_000 })
    } catch (cause) {
      throw new Error('Windows 安装包验收需要开发机安装完整 7-Zip（7z.exe），应用运行不依赖它。', {
        cause,
      })
    }
    execFileSync(
      sevenZip,
      [
        'x',
        '-y',
        '-bd',
        '-o' + parts,
        installer,
        '$PLUGINSDIR/app-64.7z',
        '$PLUGINSDIR/nsis7z.dll',
      ],
      {
        stdio: 'pipe',
        windowsHide: true,
        timeout: 60_000,
      },
    )
    const plugins = join(parts, '$PLUGINSDIR')
    const archive = join(plugins, 'app-64.7z')
    if (!existsSync(archive) || !existsSync(join(plugins, 'nsis7z.dll')))
      throw new Error('安装包缺少 x64 应用归档或 NSIS 解压插件')
    const extractor = join(temporary, 'extract.exe')
    const script = join(temporary, 'extract.nsi')
    // 这个临时程序只解压文件，不写注册表、快捷方式或用户的安装目录。
    const instructions = [
      'Unicode true',
      'SilentInstall silent',
      'RequestExecutionLevel user',
      'Name "MyDSH 安装包解码验收"',
      'OutFile "' + extractor + '"',
      '!addplugindir /x86-unicode "' + plugins + '"',
      'Section',
      'SetOutPath "' + nsisLiteral(application) + '"',
      'Nsis7z::Extract "' + nsisLiteral(archive) + '"',
      'SectionEnd',
      '',
    ]
    writeFileSync(script, '\ufeff' + instructions.join('\n'))
    const compiler = await getMakeNsisPath()
    execFileSync(compiler.path, ['/V2', script], {
      env: { ...process.env, ...compiler.env },
      stdio: 'pipe',
      windowsHide: true,
      timeout: 30_000,
    })
    execFileSync(extractor, ['/S'], { stdio: 'pipe', windowsHide: true, timeout: 180_000 })
    console.log('已使用安装包自带的 NSIS 插件解压，开始检查实际落盘文件。')
    // NSIS 解码失败可能仍返回 0；必须由逐文件摘要和真实启动决定是否通过。
    await verify(application)
  } finally {
    rmSync(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}
