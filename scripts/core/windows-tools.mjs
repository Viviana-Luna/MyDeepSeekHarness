/* oxlint-disable no-await-in-loop -- 工具下载、校验与解压按顺序进行，限制内存和文件句柄占用。 */
/** 构建时下载固定工具链；离线核心只读取已校验、已解压的工具。 */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile, stat, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const lockUrl = new URL('../../packages/runtime/windows-tools.json', import.meta.url)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const extraction = String.raw`
$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($env:MYDSH_TOOL_ARCHIVE)
try {
  $root = [IO.Path]::GetFullPath($env:MYDSH_TOOL_DESTINATION).TrimEnd('\') + '\'
  foreach ($entry in $archive.Entries) {
    $name = $entry.FullName.Replace('/', '\')
    $target = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $name))
    if ([IO.Path]::IsPathRooted($name) -or $name.Contains(':') -or !$target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) {
      throw '工具压缩包包含越界路径或链接'
    }
  }
} finally { $archive.Dispose() }
[IO.Compression.ZipFile]::ExtractToDirectory($env:MYDSH_TOOL_ARCHIVE, $env:MYDSH_TOOL_DESTINATION)
`

export async function prepareWindowsTools(payload) {
  if (process.platform !== 'win32') return
  const lock = JSON.parse(await readFile(lockUrl, 'utf8'))
  if (process.arch !== lock.arch) throw new Error('Windows 首版仅支持 x64 构建')
  const cache = join(tmpdir(), 'mydsh-toolchain-cache')
  await mkdir(cache, { recursive: true })
  for (const tool of lock.tools) {
    const archive = join(cache, tool.sha256 + '.zip')
    let bytes = await readFile(archive).catch(() => undefined)
    if (!bytes || digest(bytes) !== tool.sha256) {
      console.log('正在下载随包工具：' + tool.id + ' ' + tool.version)
      const response = await fetch(tool.url, { signal: AbortSignal.timeout(300_000) })
      if (!response.ok) throw new Error('工具下载失败：' + tool.id + '（' + response.status + '）')
      bytes = Buffer.from(await response.arrayBuffer())
      if (digest(bytes) !== tool.sha256) throw new Error('工具下载摘要不匹配：' + tool.id)
      const pending = archive + '.' + process.pid + '.tmp'
      try {
        await writeFile(pending, bytes, { flag: 'wx' })
        await rename(pending, archive)
      } finally {
        await rm(pending, { force: true })
      }
    }
    const destination = join(payload, 'tools', tool.id)
    await mkdir(dirname(destination), { recursive: true })
    await execute(
      join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      ),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(extraction, 'utf16le').toString('base64'),
      ],
      {
        windowsHide: true,
        timeout: 120_000,
        env: { ...process.env, MYDSH_TOOL_ARCHIVE: archive, MYDSH_TOOL_DESTINATION: destination },
      },
    )
    for (const entry of [tool.executable, tool.license]) {
      if (!(await stat(join(destination, entry))).isFile())
        throw new Error('随包工具缺少入口或许可证：' + tool.id)
    }
  }
  await writeFile(join(payload, 'tools/manifest.json'), JSON.stringify(lock, null, 2) + '\n')
}
