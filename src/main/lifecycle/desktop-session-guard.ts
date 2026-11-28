/**
 * Windows 本地开发态桌面会话守卫：运行在 Electron 主进程，异步检查当前进程继承的 Win32 桌面名称。
 * 当误在无可见界面的沙箱隔离桌面（如 exebox-*）启动前台开发窗口时给出中文提示并触发干净退出，
 * 避免不可见后台实例长期占用单实例锁；拥有单次检测子进程的取消句柄，退出时由 dispose() 释放。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const DESKTOP_NAME_PROBE_SCRIPT = [
  "Add-Type -Namespace MydshGuard -Name Native -MemberDefinition '",
  '[DllImport("user32.dll")] public static extern System.IntPtr GetThreadDesktop(uint id);',
  '[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
  '[DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)]',
  'public static extern bool GetUserObjectInformationW(System.IntPtr h, int idx, System.Text.StringBuilder buf, int len, out int needed);',
  "'",
  '$sb = [System.Text.StringBuilder]::new(256)',
  '$needed = 0',
  '$desk = [MydshGuard.Native]::GetThreadDesktop([MydshGuard.Native]::GetCurrentThreadId())',
  'if ([MydshGuard.Native]::GetUserObjectInformationW($desk, 2, $sb, 512, [ref]$needed)) { [Console]::Out.Write($sb.ToString()) }',
].join('; ')

/** Windows 线程桌面环境分类结果。 */
export type WindowsDesktopKind = 'interactive' | 'isolated-sandbox' | 'custom-desktop'

/** Windows 开发态桌面守卫配置项。 */
export interface WindowsDevDesktopGuardOptions {
  readonly platform?: string
  readonly isPackaged: boolean
  readonly isVerifyMode: boolean
  readonly onIsolatedDesktop: (desktopName: string) => void
  readonly queryDesktopName?: (signal: AbortSignal) => Promise<string>
}

/** 可释放的桌面会话守卫句柄。 */
export interface DisposableDesktopGuard {
  dispose(): void
}

/**
 * 根据 Win32 线程桌面名称判定当前是否属于物理主桌面或无界面隔离沙箱桌面。
 * Windows 系统自带的 Win+Tab 多虚拟桌面仍共享 Default，仅沙箱或服务桌面会使用独立桌面内核对象。
 */
export function classifyWindowsDesktopEnvironment(desktopName: string): WindowsDesktopKind {
  const normalized = desktopName.trim().toLowerCase()
  if (normalized === '' || normalized === 'default') return 'interactive'
  if (normalized.startsWith('exebox-') || normalized.startsWith('service-')) {
    return 'isolated-sandbox'
  }
  return 'custom-desktop'
}

async function probeCurrentWindowsDesktopName(signal: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', DESKTOP_NAME_PROBE_SCRIPT],
    {
      windowsHide: true,
      timeout: 8_000,
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
      signal,
    },
  )
  return stdout.trim()
}

/**
 * 在未打包的 Windows 前台开发模式下异步检查当前桌面环境，不阻塞主窗口或运行核心启动。
 * 返回句柄供应用退出阶段中止在途探测进程。
 */
export function startWindowsDevDesktopGuard(
  options: WindowsDevDesktopGuardOptions,
): DisposableDesktopGuard {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32' || options.isPackaged || options.isVerifyMode) {
    return { dispose() {} }
  }
  const controller = new AbortController()
  const query = options.queryDesktopName ?? probeCurrentWindowsDesktopName
  void query(controller.signal)
    .then(rawName => {
      if (controller.signal.aborted) return
      const desktopName = rawName.trim()
      const kind = classifyWindowsDesktopEnvironment(desktopName)
      if (kind === 'isolated-sandbox') {
        console.error(
          `MyDSH 检测到当前终端运行在隔离桌面环境（WinSta0\\${desktopName}），窗口无法显示在系统主桌面或任务栏上；正在自动退出以释放单实例锁。请改用系统 Windows Terminal / PowerShell 启动。`,
        )
        options.onIsolatedDesktop(desktopName)
      } else if (kind === 'custom-desktop') {
        console.warn(
          `提示：当前终端运行在非默认桌面（WinSta0\\${desktopName}），若主屏幕未见窗口请检查桌面切换状态。`,
        )
      }
    })
    .catch(() => {
      /* PowerShell 受限或应用提前退出时静默跳过开发态桌面提示，不影响主流程。 */
    })
  return {
    dispose(): void {
      controller.abort()
    },
  }
}
