/**
 * 主进程真实 Electron 验收的宿主桥接契约、套件解析器与公共窗口辅助工具。
 * 仅在 --verify 模式下由主进程按需动态加载，不参与正式生产启动。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow, Menu, MenuItem } from 'electron'
import type { DesktopProject } from '../../runtime/workspace/index.ts'
import type { DesktopSessionFrame } from '../../shared/session-live.ts'
import type { DshRemoteInteractionTarget } from '../host/host-event-stream.ts'
import type {
  MydshRuntimeSupervisor,
  RuntimeState as DshHostState,
} from '../runtime/runtime-supervisor.ts'
import type { DesktopSettingsController } from '../settings/controller.ts'
import type { DesktopSettingsStore } from '../settings/desktop-settings.ts'
import {
  TRAFFIC_LIGHT_GAP,
  readTrafficLightLayout,
  resolveTrafficLightMetrics,
} from '../window-controls.ts'
import type { installWindowController } from '../window-controller.ts'
import { clickTrustedElement, type VerifyReport, type VerifyStage } from './desktop-verifier.ts'

type DesktopWindowController = ReturnType<typeof installWindowController>

/** 支持通过 --suite=<名称> 独立或组合执行的桌面验收套件名。 */
export type LocalSuiteName =
  | 'smoke'
  | 'conversation'
  | 'composer'
  | 'sessions'
  | 'panels'
  | 'files-scm'
  | 'models'
  | 'settings'

/** 全部可识别的命令行验收套件标识。 */
export type VerificationSuiteSelection =
  | { kind: 'all' }
  | { kind: 'workbench' }
  | { kind: 'database' }
  | { kind: 'ssh' }
  | { kind: 'subsets'; suites: readonly LocalSuiteName[] }

/** 有序的默认本地工作台验收套件全集。 */
export const ALL_LOCAL_SUITES: readonly LocalSuiteName[] = [
  'smoke',
  'conversation',
  'composer',
  'sessions',
  'panels',
  'files-scm',
  'models',
  'settings',
]

const LOCAL_SUITE_SET = new Set<string>(ALL_LOCAL_SUITES)

/** 主进程向动态加载验收器提供的最小受控宿主桥接接口。 */
export interface HostVerificationBridge {
  readonly win: BrowserWindow
  readonly supervisor: MydshRuntimeSupervisor
  readonly fetch: typeof globalThis.fetch
  readonly targetUrl: URL
  readonly settingsStore: DesktopSettingsStore
  readonly settingsController: DesktopSettingsController
  readonly windowController: DesktopWindowController
  readonly applicationMenu: Menu
  readonly appearanceMenuItem: MenuItem
  readonly updateMenuItem: MenuItem
  readonly startupDocument: string
  readonly nativeTransparency: boolean
  readonly verifyBackground: boolean
  readonly verifyHome: string
  readonly verifyProject: string
  readonly hostChannels: {
    readonly status: string
    readonly call: string
    readonly searchSessions: string
    readonly cancelSessionSearch: string
    readonly changed: string
    readonly sessionFrame: string
    readonly hostFrame: string
  }
  readonly commandRunIdsObserved: Set<string>
  readonly commandDoneIdsObserved: Set<string>
  getStage(): VerifyStage
  setStage(stage: VerifyStage): void
  isStartupScreenVerified(): boolean
  setStartupScreenVerified(verified: boolean): void
  isVerifyReported(): boolean
  getCurrentHost(): Extract<DshHostState, { kind: 'ready' }> | undefined
  getHostStateRender(): Promise<void>
  getLiveStreamsController(): AbortController | undefined
  getProjects(): readonly DesktopProject[]
  getSessionExportController(): AbortController | undefined
  isSessionStreamFrameObserved(): boolean
  isHostEventStreamFrameObserved(): boolean
  loadStartup(phase: string): Promise<void>
  sameRendererPage(url: string): boolean
  runtimeCall(endpoint: string, args: Record<string, unknown>): Promise<unknown>
  observeInteractionFrame(frame: DesktopSessionFrame, remote?: DshRemoteInteractionTarget): void
  artifactPath(fileName: string): string
  finishVerify(report: VerifyReport, code: number): void
}

/** 构造验收失败或初始占位的基准报告对象（供主进程超时与异常回退使用）。 */
export function buildFallbackFailedReport(
  verificationStage: VerifyStage,
  error: unknown,
  hostReady: boolean,
): VerifyReport {
  return {
    verificationStage,
    hostReady,
    startupScreen: false,
    startupCapture: '',
    startupDarkCapture: '',
    appMounted: false,
    uiActive: false,
    frame: false,
    islandCount: 0,
    canvasCount: 0,
    pageScrollable: false,
    transparentRoots: false,
    settingsDialog: false,
    settingsFocusInside: false,
    settingsLayerCount: 0,
    settingsAccent: '',
    settingsCanvasOpacity: '',
    settingsCanvasAlpha: 0,
    settingsCanvasImageApplied: false,
    settingsPanelFits: false,
    frameOpacity: '',
    islandsOpaque: false,
    nativeSettingsTrigger: false,
    nativeSettingsDialog: false,
    nativeSettingsSidebarRaised: false,
    nativeSettingsTopmost: false,
    nativeAppearanceEntry: false,
    nativeAppearanceEntryPlaced: false,
    appearanceMenu: false,
    appearanceAccelerator: '',
    capture: '',
    darkCapture: '',
    darkSettingsReadable: false,
    largeCapture: '',
    largeLayoutStable: false,
    mediumToolbarStable: false,
    narrowCapture: '',
    narrowSettingsFits: false,
    nativeCapture: '',
    clearCapture: '',
    blank: true,
    error: error instanceof Error ? error.message : String(error),
  }
}

/** 解析命令行参数中的验收模式与 --verify-suite 选择。 */
export function parseVerificationSuites(argv: readonly string[]): VerificationSuiteSelection {
  if (argv.includes('--verify-workbench')) return { kind: 'workbench' }
  if (argv.includes('--verify-database')) return { kind: 'database' }
  if (argv.includes('--verify-ssh')) return { kind: 'ssh' }
  const flag = argv.find(item => item.startsWith('--verify-suite='))
  if (flag === undefined) return { kind: 'all' }
  const raw = flag.slice('--verify-suite='.length).trim()
  if (raw === '' || raw === 'all') return { kind: 'all' }
  if (raw === 'workbench') return { kind: 'workbench' }
  if (raw === 'database') return { kind: 'database' }
  if (raw === 'ssh') return { kind: 'ssh' }
  const parts = raw
    .split(',')
    .map(part => part.trim())
    .filter(part => part !== '')
  const invalid = parts.filter(part => !LOCAL_SUITE_SET.has(part))
  if (parts.length === 0 || invalid.length > 0) {
    throw new Error(
      `未知的验收套件 "${raw}"；可选值：all, workbench, database, ssh, ${ALL_LOCAL_SUITES.join(', ')}`,
    )
  }
  const ordered = ALL_LOCAL_SUITES.filter(suite => parts.includes(suite))
  return ordered.length === ALL_LOCAL_SUITES.length
    ? { kind: 'all' }
    : { kind: 'subsets', suites: ordered }
}

/** 判断面板几何尺寸是否落在 1px 容差内。 */
export function nearPanelValue(value: number, expected: number): boolean {
  return Math.abs(value - expected) <= 1
}

/** 判断红绿灯是否处于标准对齐布局：三个按钮同行、间距 8px 且位于左栏安全区内。 */
export function isCompactTrafficLightRow(
  buttons: readonly Electron.Rectangle[],
  islandGap = 8,
): boolean {
  if (buttons.length !== 3) return false
  const { left } = resolveTrafficLightMetrics(islandGap)
  return buttons.every((button, index) => {
    const previous = buttons[index - 1]
    const isSized = button.width > 0 && button.height > 0
    const isInsideSafeArea = button.x >= left - 1 && button.x + button.width <= left + 60
    const isEvenlySpaced =
      previous === undefined || button.x - previous.x - previous.width === TRAFFIC_LIGHT_GAP
    return isSized && isInsideSafeArea && isEvenlySpaced && button.y === buttons[0]!.y
  })
}

/** 校验 macOS 红绿灯已随指定浮岛间隙同步到 32px 顶行中轴线。 */
export function isTrafficLightAlignedForGap(win: BrowserWindow, islandGap: number): boolean {
  if (process.platform !== 'darwin') return true
  const buttons = readTrafficLightLayout(win)
  const { centerY } = resolveTrafficLightMetrics(islandGap)
  return (
    isCompactTrafficLightRow(buttons, islandGap) &&
    buttons.every(button => Math.abs(button.y + button.height / 2 - centerY) <= 1)
  )
}

/** 在指定超时内按间隔轮询同步谓词。 */
export function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 25,
): Promise<boolean> {
  return new Promise(resolve => {
    const deadline = Date.now() + timeoutMs
    const check = (): void => {
      if (predicate()) {
        resolve(true)
        return
      }
      if (Date.now() >= deadline) {
        resolve(false)
        return
      }
      setTimeout(check, intervalMs)
    }
    check()
  })
}

/** 等待窗口视口尺寸到达目标值（兼容 Windows 分数缩放的 2px 取整差）并完成两帧排版。 */
export async function waitForWindowSize(
  win: BrowserWindow,
  width: number,
  height: number,
  timeoutMs = 2_000,
): Promise<void> {
  await win.webContents.executeJavaScript(`(async () => {
    const deadline = performance.now() + ${String(timeoutMs)}
    while (performance.now() < deadline) {
      if (Math.abs(innerWidth - ${String(width)}) <= 2 && Math.abs(innerHeight - ${String(height)}) <= 2) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    await Promise.race([
      new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      new Promise(resolve => setTimeout(resolve, 200)),
    ])
  })()`)
}

/** 等待桌面设置里的主题偏好写入根节点属性并完成两帧重绘。 */
export async function waitForColorScheme(
  win: BrowserWindow,
  scheme: 'light' | 'dark' | 'system',
  timeoutMs = 2_000,
): Promise<void> {
  await win.webContents.executeJavaScript(`(async () => {
    const deadline = performance.now() + ${String(timeoutMs)}
    while (performance.now() < deadline) {
      if (document.documentElement.dataset.colorScheme === ${JSON.stringify(scheme)}) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    await Promise.race([
      new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      new Promise(resolve => setTimeout(resolve, 200)),
    ])
  })()`)
}

/** 等待 Electron nativeTheme 切换同步到页面 prefers-color-scheme 媒体查询并完成两帧重绘。 */
export async function waitForNativeTheme(
  win: BrowserWindow,
  expected: 'light' | 'dark',
  timeoutMs = 2_000,
): Promise<void> {
  await win.webContents.executeJavaScript(`(async () => {
    const query = ${JSON.stringify(`(prefers-color-scheme: ${expected})`)}
    const deadline = performance.now() + ${String(timeoutMs)}
    while (performance.now() < deadline) {
      if (matchMedia(query).matches) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    await Promise.race([
      new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      new Promise(resolve => setTimeout(resolve, 200)),
    ])
  })()`)
}

/** 等待指定容器内的有限时长动画结束或取消，防止取消动画抛出的 AbortError 中断验收。 */
export async function settleElementAnimations(win: BrowserWindow, selector: string): Promise<void> {
  await win.webContents.executeJavaScript(`(async () => {
    const target = document.querySelector(${JSON.stringify(selector)})
    if (!(target instanceof HTMLElement)) return
    await Promise.allSettled(
      target
        .getAnimations({ subtree: true })
        .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map(animation => animation.finished),
    )
    await Promise.race([
      new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      new Promise(resolve => setTimeout(resolve, 200)),
    ])
  })()`)
}

/** 确保右侧信息浮岛中指定 ID 的面板处于选中态（支持直接标签或溢出菜单项）。 */
export async function openRightVerificationPanel(win: BrowserWindow, id: string): Promise<void> {
  const selector = `[data-island-id=${JSON.stringify(id)}]`
  const alreadySelected = (await win.webContents.executeJavaScript(
    `document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-selected') === 'true'`,
  )) as boolean
  if (alreadySelected) return
  const existsInBar = (await win.webContents.executeJavaScript(
    `document.querySelector(${JSON.stringify(selector)}) !== null`,
  )) as boolean
  if (!existsInBar) {
    await clickTrustedElement(win, '[aria-label="更多右侧栏目"][aria-haspopup="menu"]')
  }
  await clickTrustedElement(win, selector)
}

/** 在隔离验收目录下准备前端扩展插件夹具并返回目录路径。 */
export function ensureFrontendPluginFixture(verifyHome: string | undefined): string {
  if (verifyHome === undefined) throw new Error('插件验收缺少隔离目录')
  const extensionSource = join(verifyHome, 'frontend-plugin')
  mkdirSync(extensionSource, { recursive: true })
  writeFileSync(
    join(extensionSource, 'mydsh.plugin.json'),
    JSON.stringify({
      id: 'verification.extension',
      name: '界面扩展验收',
      version: '1.0.0',
      apiVersion: 1,
      frontend: 'entry.js',
    }),
  )
  writeFileSync(
    join(extensionSource, 'entry.js'),
    `globalThis.__MYDSH_PLUGINS__.define('verification.extension', (require, module) => {
      const React = require('react'), sdk = require('@mydsh/ui');
      module.exports = { name: 'verification.extension', inject: ['mydshSlots'], apply(ctx) {
        function Probe() {
          const [result, setResult] = React.useState('loading');
          React.useEffect(() => { let active = true; sdk.callRemote('session/list', { _request: {} })
            .then(value => { if (active) setResult(Array.isArray(value.items) ? 'ready' : 'invalid') },
              () => { if (active) setResult('error') }); return () => { active = false }; }, []);
          return React.createElement('span', { 'data-plugin-probe': result }, '扩展验收');
        }
        function ProbeIcon() { return React.createElement('span', { 'aria-hidden': true }, '扩'); }
        function ProbeIsland({ placement, visibility }) {
          return React.createElement('section', {
            'data-plugin-island': placement + ':' + visibility,
          }, '动态浮岛验收');
        }
        ctx.mydshSlots.registerAction('workspace.toolbar', 'probe', Probe);
        ctx.mydshSlots.registerIsland({ id: 'verification.island', label: '动态验收', icon: ProbeIcon,
          component: ProbeIsland, placements: ['right'], scope: 'window', preserveWhenHidden: true, order: 100 });
      }};
    });`,
  )
  return extensionSource
}
