/**
 * 外置 Chromium 系浏览器发现与 loopback CDP 端点守卫：支持 macOS 与 Windows 自动探测并严格防御 SSRF。
 * 纯函数与轻量查询辅助，不持有子进程或 WebSocket 句柄。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { AutomationDetectedBrowser, AutomationSettings } from '../../shared/automation.ts'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

interface BrowserCandidate {
  id: AutomationDetectedBrowser['id']
  name: string
  paths: readonly string[]
}

function macCandidates(home: string): BrowserCandidate[] {
  return [
    {
      id: 'chrome',
      name: 'Google Chrome',
      paths: [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      ],
    },
    {
      id: 'edge',
      name: 'Microsoft Edge',
      paths: [
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        join(home, 'Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
      ],
    },
    {
      id: 'brave',
      name: 'Brave Browser',
      paths: [
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        join(home, 'Applications/Brave Browser.app/Contents/MacOS/Brave Browser'),
      ],
    },
    {
      id: 'chromium',
      name: 'Chromium',
      paths: [
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        join(home, 'Applications/Chromium.app/Contents/MacOS/Chromium'),
      ],
    },
  ]
}

function windowsCandidates(env: NodeJS.ProcessEnv): BrowserCandidate[] {
  const roots = [
    env.PROGRAMFILES ?? 'C:\\Program Files',
    env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)',
    env.LOCALAPPDATA ?? '',
  ].filter(Boolean)
  return [
    {
      id: 'chrome',
      name: 'Google Chrome',
      paths: roots.map(root => join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')),
    },
    {
      id: 'edge',
      name: 'Microsoft Edge',
      paths: roots.map(root => join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
    },
    {
      id: 'brave',
      name: 'Brave Browser',
      paths: roots.map(root =>
        join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      ),
    },
    {
      id: 'chromium',
      name: 'Chromium',
      paths: roots.map(root => join(root, 'Chromium', 'Application', 'chrome.exe')),
    },
  ]
}

/** 探测本机已安装的 Chromium 系浏览器（macOS 与 Windows 双端支持）。 */
export function detectInstalledBrowsers(options?: {
  platform?: NodeJS.Platform
  exists?: (filePath: string) => boolean
  env?: NodeJS.ProcessEnv
  home?: string
}): AutomationDetectedBrowser[] {
  const platform = options?.platform ?? process.platform
  const exists = options?.exists ?? existsSync
  const env = options?.env ?? process.env
  const home = options?.home ?? homedir()
  let candidates: BrowserCandidate[] = []
  if (platform === 'darwin') candidates = macCandidates(home)
  else if (platform === 'win32') candidates = windowsCandidates(env)
  const detected: AutomationDetectedBrowser[] = []
  for (const item of candidates) {
    const found = item.paths.find(candidate => exists(candidate))
    if (found) {
      detected.push({ id: item.id, name: item.name, executablePath: found })
    }
  }
  return detected
}

/** 严格校验 CDP 调试地址仅指向本机 loopback（127.0.0.1 / localhost / [::1]），可选钉住端口与 `/devtools/` 路径防御 SSRF。 */
export function assertLoopbackDebugUrl(
  rawUrl: string,
  options?: { expectedPort?: number; requireDevToolsPath?: boolean },
): URL {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch (error) {
    throw new Error(`CDP 调试地址格式无效：${rawUrl}`, { cause: error })
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'http:') {
    throw new Error(`SECURITY_BLOCK：仅允许本机明文 ws/http 调试协议，已拒绝 ${parsed.protocol}`)
  }
  if (parsed.username || parsed.password) {
    throw new Error('SECURITY_BLOCK：CDP 调试地址禁止包含认证信息')
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(
      `SECURITY_BLOCK：仅允许连接本机 loopback 调试端口，已拒绝主机 ${parsed.hostname}`,
    )
  }
  const port = Number(parsed.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('CDP 调试地址必须包含合法端口号')
  }
  if (options?.expectedPort !== undefined && port !== options.expectedPort) {
    throw new Error(
      `SECURITY_BLOCK：CDP WebSocket 端口（${port}）与预期调试端口（${options.expectedPort}）不一致`,
    )
  }
  if (options?.requireDevToolsPath && !parsed.pathname.startsWith('/devtools/')) {
    throw new Error(`SECURITY_BLOCK：CDP 调试路径必须以 /devtools/ 开头，已拒绝 ${parsed.pathname}`)
  }
  return parsed
}

/** 从浏览器 stderr 输出解析 `DevTools listening on ws://127.0.0.1:...` 地址并复核 loopback 约束。 */
export function parseDevToolsListeningUrl(output: string): string | null {
  const match = output.match(/DevTools listening on\s+(ws:\/\/[^\s]+)/iu)
  if (!match?.[1]) return null
  return assertLoopbackDebugUrl(match[1]).href
}

/** 查询本机 loopback DevTools JSON 端点（禁用重定向以防 SSRF）。 */
export async function queryLoopbackJson<T>(
  port: number,
  endpointPath: '/json/version' | '/json/list',
  signal?: AbortSignal,
): Promise<T> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('外置浏览器调试端口必须是 1024 至 65535 之间的整数')
  }
  const url = assertLoopbackDebugUrl(`http://127.0.0.1:${port}${endpointPath}`)
  const timeout = AbortSignal.timeout(4000)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  const response = await fetch(url.href, {
    method: 'GET',
    redirect: 'error',
    signal: combined,
  })
  if (!response.ok) {
    throw new Error(`无法读取本机浏览器调试端口（HTTP ${response.status}）`)
  }
  return (await response.json()) as T
}

/** 检查受管外置浏览器子进程是否仍在存活。 */
export function isExternalChildAlive(child: ChildProcess | null): boolean {
  return child !== null && child.exitCode === null && child.signalCode === null
}

/** 尽量温和终止外置浏览器子进程，忽略已退出导致的异常。 */
export function terminateExternalChildBestEffort(child: ChildProcess | null): void {
  if (!isExternalChildAlive(child) || child?.killed) return
  try {
    child?.kill('SIGTERM')
  } catch {
    /* 进程可能已结束。 */
  }
}

/** 校验外置浏览器目标网址仅限合法 http(s) 且不命中禁止黑名单。 */
export function assertExternalUrlAllowed(
  rawUrl: string,
  settings: AutomationSettings,
  allowBlank = false,
): void {
  const trimmed = rawUrl.trim()
  if (!trimmed || trimmed.toLowerCase() === 'about:blank') {
    if (allowBlank) return
    throw new Error('导航需要提供有效的 http(s) 网址')
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`SECURITY_BLOCK：外置浏览器自动化仅允许合法的 http(s) 网页，已拒绝 ${trimmed}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`SECURITY_BLOCK：外置浏览器自动化禁止操控非网页协议（${parsed.protocol}）`)
  }
  const origin = parsed.origin.toLowerCase()
  if (settings.embeddedBrowser.blockedOrigins.some(rule => rule.toLowerCase() === origin)) {
    throw new Error(`SECURITY_BLOCK：目标站点 ${origin} 位于禁止自动化黑名单内，已拦截操作`)
  }
}

/** 解析受管外置浏览器的可执行文件绝对路径，优先使用用户配置并校验目标文件存在。 */
export function resolveManagedBrowserExecutable(settings: AutomationSettings): {
  name: string
  executablePath: string
} {
  const custom = settings.externalBrowser.executablePath?.trim()
  if (custom) {
    if (!isAbsolute(custom) || !existsSync(custom) || !statSync(custom).isFile()) {
      throw new Error(`配置的外置浏览器可执行文件路径无效或不是文件：${custom}`)
    }
    return { name: '自定义浏览器', executablePath: custom }
  }
  const detected = detectInstalledBrowsers()
  const first = detected[0]
  if (!first) {
    throw new Error(
      '未检测到本机 Chrome / Edge / Brave / Chromium，请在「设置 → 浏览器与桌面操控」中指定可执行路径',
    )
  }
  return { name: first.name, executablePath: first.executablePath }
}

/** 以独立 Profile 与 loopback 随机调试端口拉起受管外置 Chromium 浏览器。 */
export function launchManagedBrowserProcess(
  executablePath: string,
  profileDirectory: string,
  headless: boolean,
  signal?: AbortSignal,
): Promise<{ child: ChildProcess; wsUrl: string; port: number }> {
  signal?.throwIfAborted()
  mkdirSync(profileDirectory, { recursive: true })
  const args = [
    `--user-data-dir=${profileDirectory}`,
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-default-apps',
    ...(headless ? ['--headless=new', '--window-size=1280,800'] : []),
    'about:blank',
  ]
  const child = spawn(executablePath, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: false,
  })
  return new Promise((resolve, reject) => {
    let buffer = ''
    let settled = false
    const timer = setTimeout(() => finish(new Error('等待外置浏览器开启 CDP 调试端口超时')), 15_000)
    const finish = (err?: unknown, wsUrl?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      child.stderr?.removeListener('data', onData)
      child.removeListener('exit', onExit)
      child.removeListener('error', onError)
      if (err || !wsUrl) {
        terminateExternalChildBestEffort(child)
        reject(err ?? new Error('外置浏览器启动失败'))
        return
      }
      // 持续排空 stderr 管道，避免 Chrome 写入超过 64KiB 日志后触发系统管道写阻塞。
      child.stderr?.resume()
      try {
        const parsed = assertLoopbackDebugUrl(wsUrl, { requireDevToolsPath: true })
        resolve({ child, wsUrl: parsed.href, port: Number(parsed.port) })
      } catch (parseErr) {
        terminateExternalChildBestEffort(child)
        reject(parseErr)
      }
    }
    const onData = (chunk: Buffer) => {
      buffer = (buffer + chunk.toString('utf8')).slice(-16_384)
      try {
        const wsUrl = parseDevToolsListeningUrl(buffer)
        if (wsUrl) finish(undefined, wsUrl)
      } catch (parseErr) {
        finish(parseErr)
      }
    }
    const onExit = (code: number | null, exitSignal: NodeJS.Signals | null) =>
      finish(
        new Error(
          `外置浏览器启动后异常退出（退出码 ${code ?? '未知'}，信号 ${exitSignal ?? '无'}）`,
        ),
      )
    const onError = (error: Error) =>
      finish(new Error(`启动外置浏览器失败：${error.message}`, { cause: error }))
    const onAbort = () => finish(signal?.reason ?? new Error('启动外置浏览器已取消'))
    child.stderr?.on('data', onData)
    child.once('exit', onExit)
    child.once('error', onError)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
