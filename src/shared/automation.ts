/**
 * 浏览器控制与系统级 Computer Use 跨进程共享契约。
 * 运行在主进程、preload 与 renderer 共享边界，不依赖 Node、Electron 或 React。
 */

/** 桌面自动化 IPC 通道白名单。 */
export const AUTOMATION_CHANNELS = Object.freeze({
  readSettings: 'dsh-desktop:automation:read-settings',
  updateSettings: 'dsh-desktop:automation:update-settings',
  status: 'dsh-desktop:automation:status',
  stopTakeover: 'dsh-desktop:automation:stop-takeover',
  checkPermissions: 'dsh-desktop:automation:check-permissions',
  openPermissionSettings: 'dsh-desktop:automation:open-permission-settings',
  detectBrowsers: 'dsh-desktop:automation:detect-browsers',
  testExternalBrowser: 'dsh-desktop:automation:test-external-browser',
  stateChanged: 'dsh-desktop:automation:state-changed',
  settingsChanged: 'dsh-desktop:automation:settings-changed',
})

/**
 * 返回当前平台的全局急停快捷键（Electron globalShortcut 语法）。
 * Windows 上避开系统任务管理器占用的 `Ctrl+Shift+Esc`，改用 `Control+Shift+F12`。
 */
export function resolveKillSwitchShortcut(
  platform: string = typeof process !== 'undefined' ? process.platform : 'darwin',
): string {
  return platform === 'darwin' ? 'Command+Shift+Escape' : 'Control+Shift+F12'
}

/** 将全局急停快捷键格式化为界面提示文案。 */
export function formatKillSwitchLabel(shortcut: string): string {
  if (shortcut === 'Command+Shift+Escape') return '⌘⇧Esc'
  if (shortcut === 'Control+Shift+F12') return 'Ctrl+Shift+F12'
  return shortcut
}

/** 全局急停加速器字符串（默认按当前运行平台解析，避免 Windows 冲突）。 */
export const AUTOMATION_KILL_SWITCH_SHORTCUT = resolveKillSwitchShortcut()

/** 默认保护的敏感桌面应用列表，防止自动输入误操作凭据管理器或系统授权弹窗。 */
export const DEFAULT_BLOCKED_APPS: readonly string[] = Object.freeze([
  'Keychain Access',
  '钥匙串访问',
  'SecurityAgent',
  'CoreServicesUIAgent',
  '1Password',
  'Bitwarden',
  'KeePassXC',
  'LastPass',
  'Dashlane',
  'CredentialUIBroker',
])

/** 自动化设置模式版本号。 */
export const AUTOMATION_SETTINGS_VERSION = 1 as const

/** 内置浏览器自动化配置。 */
export interface EmbeddedBrowserAutomationSettings {
  enabled: boolean
  allowLocalhostWithoutConfirm: boolean
  allowedOrigins: string[]
  blockedOrigins: string[]
}

/** 外置浏览器（纯 CDP）自动化配置。 */
export interface ExternalBrowserAutomationSettings {
  enabled: boolean
  mode: 'managed' | 'attached'
  executablePath: string | null
  attachPort: number | null
  allowedOrigins: string[]
}

/** 系统级桌面 Computer Use 配置。 */
export interface ComputerUseSettings {
  enabled: boolean
  scope: 'window' | 'display'
  maxImageLongEdge: number
  confirmEveryAction: boolean
  blockedApps: string[]
}

/** 持久化在 `~/.mydsh/config/automation.json` 的完整策略快照。 */
export interface AutomationSettings {
  version: typeof AUTOMATION_SETTINGS_VERSION
  embeddedBrowser: EmbeddedBrowserAutomationSettings
  externalBrowser: ExternalBrowserAutomationSettings
  computerUse: ComputerUseSettings
  warning?: string
}

/** 允许局部更新的自动化设置补丁结构。 */
export interface AutomationSettingsPatch {
  embeddedBrowser?: Partial<EmbeddedBrowserAutomationSettings>
  externalBrowser?: Partial<ExternalBrowserAutomationSettings>
  computerUse?: Partial<ComputerUseSettings>
}

/** 当前系统级桌面操控权限检测结果。 */
export interface AutomationPermissionStatus {
  platform: 'darwin' | 'win32' | 'other'
  supported: boolean
  nativeLoaded: boolean
  accessibility: boolean
  screenRecording: boolean
  elevated?: boolean
  note?: string
}

/** 本机自动探测到的 Chromium 系外置浏览器信息。 */
export interface AutomationDetectedBrowser {
  id: string
  name: string
  executablePath: string
}

/** 实时接管状态快照，供顶部状态条、内置浏览器徽标与悬浮急停胶囊同步展示。 */
export interface AutomationTakeoverState {
  active: boolean
  kind: 'embedded-browser' | 'external-browser' | 'computer-use' | null
  sessionId: string | null
  targetLabel: string | null
  stepCount: number
  killSwitchShortcut: string
  lastStoppedReason: string | null
}

/** 渲染器查询自动化总状态的返回结构。 */
export interface AutomationRuntimeStatus {
  settings: AutomationSettings
  takeover: AutomationTakeoverState
  permissions: AutomationPermissionStatus
  externalConnected: boolean
  externalTargetLabel: string | null
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasControlChars(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 32 || code === 127) return true
  }
  return false
}

/** 返回默认处于全部关闭状态的自动化策略模板。 */
export function createDefaultAutomationSettings(): AutomationSettings {
  return {
    version: AUTOMATION_SETTINGS_VERSION,
    embeddedBrowser: {
      enabled: false,
      allowLocalhostWithoutConfirm: true,
      allowedOrigins: [],
      blockedOrigins: [],
    },
    externalBrowser: {
      enabled: false,
      mode: 'managed',
      executablePath: null,
      attachPort: 9222,
      allowedOrigins: [],
    },
    computerUse: {
      enabled: false,
      scope: 'window',
      maxImageLongEdge: 1280,
      confirmEveryAction: false,
      blockedApps: [...DEFAULT_BLOCKED_APPS],
    },
  }
}

/** 返回初始空闲接管状态快照。 */
export function createIdleTakeoverState(): AutomationTakeoverState {
  return {
    active: false,
    kind: null,
    sessionId: null,
    targetLabel: null,
    stepCount: 0,
    killSwitchShortcut: AUTOMATION_KILL_SWITCH_SHORTCUT,
    lastStoppedReason: null,
  }
}

/** 深拷贝自动化配置，避免调用方修改共享引用。 */
export function cloneAutomationSettings(settings: AutomationSettings): AutomationSettings {
  return {
    version: AUTOMATION_SETTINGS_VERSION,
    embeddedBrowser: {
      ...settings.embeddedBrowser,
      allowedOrigins: [...settings.embeddedBrowser.allowedOrigins],
      blockedOrigins: [...settings.embeddedBrowser.blockedOrigins],
    },
    externalBrowser: {
      ...settings.externalBrowser,
      allowedOrigins: [...settings.externalBrowser.allowedOrigins],
    },
    computerUse: {
      ...settings.computerUse,
      blockedApps: [...settings.computerUse.blockedApps],
    },
    ...(settings.warning !== undefined ? { warning: settings.warning } : {}),
  }
}

/**
 * 校验并规范化单条 Origin 规则（仅支持 `http://` 或 `https://` 源，去除路径与凭据）。
 * @throws 输入不是有效 HTTP(S) Origin 时抛出。
 */
export function normalizeOriginRule(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 256 || hasControlChars(raw)) {
    throw new Error('域名规则格式无效，请填写如 https://example.com 或 http://localhost:3000')
  }
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    throw new Error(`无法解析域名规则「${raw.trim()}」，请包含 http:// 或 https:// 协议头`)
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error('域名规则仅支持不含账号密码的 http:// 或 https:// 地址')
  }
  return parsed.origin.toLowerCase()
}

function normalizeOriginList(raw: unknown, label: string): string[] {
  if (!Array.isArray(raw) || raw.length > 100) {
    throw new Error(`${label}必须是列表且最多 100 条`)
  }
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const normalized = normalizeOriginRule(item)
    if (!seen.has(normalized)) {
      seen.add(normalized)
      result.push(normalized)
    }
  }
  return result
}

function normalizeAppList(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > 100) {
    throw new Error('屏蔽应用列表必须是数组且最多 100 条')
  }
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string' || !item.trim() || item.length > 128 || hasControlChars(item)) {
      throw new Error('屏蔽应用名称无效或包含控制字符')
    }
    const trimmed = item.trim()
    const key = trimmed.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      result.push(trimmed)
    }
  }
  return result
}

function normalizeEmbedded(
  raw: unknown,
  fallback: EmbeddedBrowserAutomationSettings,
): EmbeddedBrowserAutomationSettings {
  if (raw === undefined) {
    return {
      ...fallback,
      allowedOrigins: [...fallback.allowedOrigins],
      blockedOrigins: [...fallback.blockedOrigins],
    }
  }
  if (!isPlainRecord(raw)) throw new Error('内置浏览器配置必须是对象')
  const keys = new Set([
    'enabled',
    'allowLocalhostWithoutConfirm',
    'allowedOrigins',
    'blockedOrigins',
  ])
  if (Object.keys(raw).some(key => !keys.has(key))) throw new Error('内置浏览器配置包含未知字段')
  const enabled = raw.enabled === undefined ? fallback.enabled : raw.enabled
  const allowLocal =
    raw.allowLocalhostWithoutConfirm === undefined
      ? fallback.allowLocalhostWithoutConfirm
      : raw.allowLocalhostWithoutConfirm
  if (typeof enabled !== 'boolean' || typeof allowLocal !== 'boolean') {
    throw new Error('内置浏览器开关必须是布尔值')
  }
  return {
    enabled,
    allowLocalhostWithoutConfirm: allowLocal,
    allowedOrigins:
      raw.allowedOrigins === undefined
        ? [...fallback.allowedOrigins]
        : normalizeOriginList(raw.allowedOrigins, '内置浏览器允许域名'),
    blockedOrigins:
      raw.blockedOrigins === undefined
        ? [...fallback.blockedOrigins]
        : normalizeOriginList(raw.blockedOrigins, '内置浏览器禁止域名'),
  }
}

function normalizeExternal(
  raw: unknown,
  fallback: ExternalBrowserAutomationSettings,
): ExternalBrowserAutomationSettings {
  if (raw === undefined) {
    return { ...fallback, allowedOrigins: [...fallback.allowedOrigins] }
  }
  if (!isPlainRecord(raw)) throw new Error('外置浏览器配置必须是对象')
  const keys = new Set(['enabled', 'mode', 'executablePath', 'attachPort', 'allowedOrigins'])
  if (Object.keys(raw).some(key => !keys.has(key))) throw new Error('外置浏览器配置包含未知字段')
  const enabled = raw.enabled === undefined ? fallback.enabled : raw.enabled
  const mode = raw.mode === undefined ? fallback.mode : raw.mode
  if (typeof enabled !== 'boolean') throw new Error('外置浏览器开关必须是布尔值')
  if (mode !== 'managed' && mode !== 'attached') throw new Error('外置浏览器模式无效')
  const executablePath =
    raw.executablePath === undefined ? fallback.executablePath : raw.executablePath
  if (
    executablePath !== null &&
    (typeof executablePath !== 'string' ||
      !executablePath.trim() ||
      executablePath.length > 1024 ||
      hasControlChars(executablePath))
  ) {
    throw new Error('外置浏览器可执行路径无效')
  }
  const attachPort = raw.attachPort === undefined ? fallback.attachPort : raw.attachPort
  if (
    attachPort !== null &&
    (!Number.isInteger(attachPort) || Number(attachPort) < 1024 || Number(attachPort) > 65535)
  ) {
    throw new Error('外置浏览器调试端口必须是 1024 至 65535 之间的整数')
  }
  return {
    enabled,
    mode,
    executablePath: executablePath === null ? null : executablePath.trim(),
    attachPort: attachPort === null ? null : Number(attachPort),
    allowedOrigins:
      raw.allowedOrigins === undefined
        ? [...fallback.allowedOrigins]
        : normalizeOriginList(raw.allowedOrigins, '外置浏览器允许域名'),
  }
}

function normalizeComputerUse(raw: unknown, fallback: ComputerUseSettings): ComputerUseSettings {
  if (raw === undefined) {
    return { ...fallback, blockedApps: [...fallback.blockedApps] }
  }
  if (!isPlainRecord(raw)) throw new Error('桌面操控配置必须是对象')
  const keys = new Set([
    'enabled',
    'scope',
    'maxImageLongEdge',
    'confirmEveryAction',
    'blockedApps',
  ])
  if (Object.keys(raw).some(key => !keys.has(key))) throw new Error('桌面操控配置包含未知字段')
  const enabled = raw.enabled === undefined ? fallback.enabled : raw.enabled
  const scope = raw.scope === undefined ? fallback.scope : raw.scope
  const maxEdge =
    raw.maxImageLongEdge === undefined ? fallback.maxImageLongEdge : raw.maxImageLongEdge
  const confirmEvery =
    raw.confirmEveryAction === undefined ? fallback.confirmEveryAction : raw.confirmEveryAction
  if (typeof enabled !== 'boolean' || typeof confirmEvery !== 'boolean') {
    throw new Error('桌面操控开关必须是布尔值')
  }
  if (scope !== 'window' && scope !== 'display') throw new Error('桌面操控作用域无效')
  if (!Number.isInteger(maxEdge) || Number(maxEdge) < 640 || Number(maxEdge) > 2048) {
    throw new Error('截图最大长边必须是 640 至 2048 之间的整数')
  }
  return {
    enabled,
    scope,
    maxImageLongEdge: Number(maxEdge),
    confirmEveryAction: confirmEvery,
    blockedApps:
      raw.blockedApps === undefined ? [...fallback.blockedApps] : normalizeAppList(raw.blockedApps),
  }
}

/**
 * 校验并合并自动化策略配置；可同时用于磁盘配置读取与渲染器补丁提交。
 * @throws 任何字段名或值越界时抛出中文错误。
 */
export function normalizeAutomationSettings(
  input: unknown,
  base: AutomationSettings = createDefaultAutomationSettings(),
): AutomationSettings {
  if (!isPlainRecord(input)) throw new Error('自动化配置必须是对象')
  const allowedTop = new Set(['version', 'embeddedBrowser', 'externalBrowser', 'computerUse'])
  if (Object.keys(input).some(key => !allowedTop.has(key))) {
    throw new Error('自动化配置包含未知顶级字段')
  }
  if (input.version !== undefined && input.version !== AUTOMATION_SETTINGS_VERSION) {
    throw new Error('不支持的自动化配置版本')
  }
  return {
    version: AUTOMATION_SETTINGS_VERSION,
    embeddedBrowser: normalizeEmbedded(input.embeddedBrowser, base.embeddedBrowser),
    externalBrowser: normalizeExternal(input.externalBrowser, base.externalBrowser),
    computerUse: normalizeComputerUse(input.computerUse, base.computerUse),
  }
}

/** 判断 URL 是否属于本机环回地址（localhost / 127.0.0.1 / [::1]）。 */
export function isLocalhostOrigin(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    const host = parsed.hostname.toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
  } catch {
    return false
  }
}
