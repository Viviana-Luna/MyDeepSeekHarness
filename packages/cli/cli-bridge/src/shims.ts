/**
 * 二级 CLI 可执行垫片与截图落盘目录管理：在系统临时目录建立私有工作区并把 `mydsh` 注入 Runtime PATH。
 * 运行在后台 Runtime；在插件卸载和进程同步退出两个阶段双重清理临时目录，防止残留套接字或截图文件。
 */
import { rmSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

/** 已就绪的 CLI 运行期工作区路径与释放句柄。 */
export interface CliWorkspaceHandle {
  readonly rootDir: string
  readonly binDir: string
  readonly capturesDir: string
  readonly cliBinaryPath: string
  readonly ipcEndpoint: string
  dispose(): Promise<void>
}

function escapePosixSingleQuotes(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function escapePowerShellSingleQuotes(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function renderPosixShim(nodeExecutable: string, cliEntryPath: string): string {
  const node = escapePosixSingleQuotes(nodeExecutable)
  const entry = escapePosixSingleQuotes(cliEntryPath)
  return `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${node} ${entry} "$@"\n`
}

function renderWindowsCmdShim(nodeExecutable: string, cliEntryPath: string): string {
  const escapedNode = nodeExecutable.replaceAll('%', '%%').replaceAll('"', '""')
  const escapedEntry = cliEntryPath.replaceAll('%', '%%').replaceAll('"', '""')
  return `@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${escapedNode}" "${escapedEntry}" %*\r\nexit /b %ERRORLEVEL%\r\n`
}

function renderWindowsPs1Shim(nodeExecutable: string, cliEntryPath: string): string {
  const node = escapePowerShellSingleQuotes(nodeExecutable)
  const entry = escapePowerShellSingleQuotes(cliEntryPath)
  // UTF-8 BOM 保障 PowerShell 5.1 正确解析中文路径；显式转发 $input 避免管道丢 stdin，并在 finally 还原 ELECTRON_RUN_AS_NODE。
  return (
    '\uFEFF' +
    `$__mydshPrevRunAsNode = $env:ELECTRON_RUN_AS_NODE\r\n` +
    `$env:ELECTRON_RUN_AS_NODE = '1'\r\n` +
    `$__mydshExit = 0\r\n` +
    `try {\r\n` +
    `  if ($MyInvocation.ExpectingInput) {\r\n` +
    `    $input | & ${node} ${entry} @args\r\n` +
    `  } else {\r\n` +
    `    & ${node} ${entry} @args\r\n` +
    `  }\r\n` +
    `  $__mydshExit = $LASTEXITCODE\r\n` +
    `} finally {\r\n` +
    `  if ($null -eq $__mydshPrevRunAsNode) {\r\n` +
    `    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue\r\n` +
    `  } else {\r\n` +
    `    $env:ELECTRON_RUN_AS_NODE = $__mydshPrevRunAsNode\r\n` +
    `  }\r\n` +
    `}\r\n` +
    `exit $__mydshExit\r\n`
  )
}

function prependRuntimePath(binDir: string): () => void {
  const key =
    process.platform === 'win32'
      ? (Object.keys(process.env).find(name => name.toUpperCase() === 'PATH') ?? 'Path')
      : 'PATH'
  const previous = process.env[key] ?? ''
  const parts = previous.split(delimiter).filter(Boolean)
  if (!parts.includes(binDir)) {
    process.env[key] = [binDir, ...parts].join(delimiter)
  }
  return () => {
    const current = (process.env[key] ?? '').split(delimiter).filter(Boolean)
    process.env[key] = current.filter(item => item !== binDir).join(delimiter)
  }
}

/**
 * 创建隔离的 CLI 临时目录、写入平台对应的 `mydsh` 启动垫片并挂载到当前进程 PATH。
 * 调用方必须在停用时调用返回句柄的 `dispose()`。
 */
export async function createCliWorkspace(options: {
  readonly nodeExecutable: string
  readonly cliEntryPath: string
}): Promise<CliWorkspaceHandle> {
  // Unix Domain Socket 路径总长度在 macOS 上受 104 字节上限约束，因此使用短前缀。
  const rootDir = await mkdtemp(join(tmpdir(), 'mydsh-c-'))
  await chmod(rootDir, 0o700).catch(() => undefined)
  const binDir = join(rootDir, 'bin')
  const capturesDir = join(rootDir, 'captures')
  await mkdir(binDir, { mode: 0o700 })
  await mkdir(capturesDir, { mode: 0o700 })

  const isWin = process.platform === 'win32'
  let cliBinaryPath: string
  if (isWin) {
    // PowerShell 优先解析 ExternalScript（.ps1）并以 @args 原样传递参数，避开 cmd.exe 的 &/|/% 注入风险；
    // 同时保留 .cmd 垫片兼容非 PowerShell 调用方。
    cliBinaryPath = join(binDir, 'mydsh.cmd')
    await writeFile(
      cliBinaryPath,
      renderWindowsCmdShim(options.nodeExecutable, options.cliEntryPath),
      'utf8',
    )
    await writeFile(
      join(binDir, 'mydsh.ps1'),
      renderWindowsPs1Shim(options.nodeExecutable, options.cliEntryPath),
      'utf8',
    )
  } else {
    cliBinaryPath = join(binDir, 'mydsh')
    await writeFile(cliBinaryPath, renderPosixShim(options.nodeExecutable, options.cliEntryPath), {
      mode: 0o755,
    })
    await chmod(cliBinaryPath, 0o755)
  }

  const ipcEndpoint = isWin
    ? `\\\\.\\pipe\\mydsh-cli-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
    : join(rootDir, 's.sock')

  const restorePath = prependRuntimePath(binDir)
  let disposed = false
  const onExit = (): void => {
    if (disposed) return
    disposed = true
    try {
      rmSync(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch {
      // 同步退出兜底清理失败不再抛错干扰宿主退出码。
    }
  }
  process.prependListener('exit', onExit)

  return {
    rootDir,
    binDir,
    capturesDir,
    cliBinaryPath,
    ipcEndpoint,
    async dispose() {
      restorePath()
      process.off('exit', onExit)
      if (disposed) return
      disposed = true
      await rm(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
        () => undefined,
      )
    },
  }
}
