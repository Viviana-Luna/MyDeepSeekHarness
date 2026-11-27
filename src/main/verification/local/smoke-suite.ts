/**
 * 基础壳层、导航安全、窗口控制与前端扩展生命周期验收套件。
 */
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { focusPrimaryWindow } from '../../lifecycle/app-lifecycle.ts'
import { parseDesktopWorkspaceCreateResult } from '../../../shared/workspace-capabilities.ts'
import {
  TRAFFIC_LIGHT_CENTER_Y,
  TRAFFIC_LIGHT_LEFT,
  readTrafficLightLayout,
} from '../../window-controls.ts'
import {
  ensureFrontendPluginFixture,
  isCompactTrafficLightRow,
  waitForCondition,
} from '../host-verify-context.ts'
import { verifyWindowControls } from '../window-verifier.ts'
import { verifyWorkspaceNavigation } from '../navigation-verifier.ts'
import { type LocalVerifyState, assertSuiteInvariants } from './state.ts'
import { SMOKE_SCRIPT_1, buildSmokeScript2, buildSmokeScript3 } from './smoke-scripts.ts'

/** 执行 smoke 验收套件第 1 阶段。 */
export async function runSmokeStep1(bag: LocalVerifyState): Promise<void> {
  bag.navigationStreams = bag.bridge.getLiveStreamsController()
  await verifyWorkspaceNavigation(
    bag.bridge.win,
    bag.bridge.startupDocument,
    () =>
      bag.navigationStreams !== undefined &&
      bag.bridge.getLiveStreamsController() === bag.navigationStreams &&
      !bag.navigationStreams.signal.aborted,
  )
}

/** 执行 smoke 验收套件第 2 阶段。 */
export async function runSmokeStep2(bag: LocalVerifyState): Promise<void> {
  if (process.argv.includes('--verify-directory-picker')) {
    // 真实系统对话框需要操作员或系统 UI 自动化选取；其余流程沿用同一隔离验收。
    const directory = join(bag.bridge.verifyHome!, 'picked-project')
    mkdirSync(directory, { mode: 0o700 })
    console.log('desktop-shell-verify-directory: 请先取消目录选择，再选择', directory)
    const cancelled = (await bag.bridge.win.webContents.executeJavaScript(
      "window.dshDesktop.host.call('pickWorkspaceDirectory', {})",
    )) as unknown
    if (cancelled !== null) throw new Error('取消目录选择没有返回 null')
    const selected = (await bag.bridge.win.webContents.executeJavaScript(
      "window.dshDesktop.host.call('pickWorkspaceDirectory', {})",
    )) as unknown
    if (typeof selected !== 'string' || realpathSync(selected) !== realpathSync(directory))
      throw new Error('原生目录选择结果不正确')
    const created = parseDesktopWorkspaceCreateResult(
      await bag.bridge.win.webContents.executeJavaScript(
        `window.dshDesktop.host.call('createWorkspace', { path: ${JSON.stringify(selected)} })`,
      ),
    )
    if (created.workspace.path !== realpathSync(directory))
      throw new Error('项目未绑定到实际选中的目录')
    await bag.bridge.win.webContents.executeJavaScript(
      `window.dshDesktop.host.call('removeWorkspace', { workspaceId: ${JSON.stringify(created.workspace.workspaceId)} })`,
    )
    const abort = new AbortController()
    const pending = bag.bridge.supervisor.call('directoryPicker/pick', { args: {} }, abort.signal)
    const timer = setTimeout(() => {
      abort.abort()
    }, 500)
    try {
      await pending
      throw new Error('目录选择未响应请求取消')
    } catch (error) {
      if (!abort.signal.aborted) throw error
    } finally {
      clearTimeout(timer)
    }
    await new Promise(resolve => {
      setTimeout(resolve, 250)
    })
    console.log('desktop-shell-verify-directory: 原生选择、项目创建、用户取消及请求取消通过')
    // 原生操作员或 UI 自动化可能切走焦点，后续键盘验收重新激活主窗口。
    app.focus({ steal: true })
    focusPrimaryWindow(bag.bridge.win)
  }
  if (!bag.bridge.verifyBackground) {
    if (!(await waitForCondition(() => bag.bridge.win.isFocused(), 12_000)))
      throw new Error('验收窗口未获得前台焦点')
    bag.bridge.win.webContents.focus()
  }
  bag.windowControlsReady = await verifyWindowControls(bag.bridge.win, !bag.bridge.verifyBackground)
}

/** 执行 smoke 验收套件第 3 阶段。 */
export async function runSmokeStep3(bag: LocalVerifyState): Promise<void> {
  console.log('desktop-shell-verify-local: window-controls', {
    windowControlsReady: bag.windowControlsReady,
    ...bag.bridge.windowController.read(),
  })
  // 使用真实安装目录、资源协议和共享 React 验证扩展链路；所有夹具随隔离目录清理。
  if (bag.bridge.verifyHome === undefined) throw new Error('插件验收缺少隔离目录')
  bag.extensionSource = join(bag.bridge.verifyHome, 'frontend-plugin')
  mkdirSync(bag.extensionSource, { recursive: true })
  writeFileSync(
    join(bag.extensionSource, 'mydsh.plugin.json'),
    JSON.stringify({
      id: 'verification.extension',
      name: '界面扩展验收',
      version: '1.0.0',
      apiVersion: 1,
      frontend: 'entry.js',
    }),
  )
  writeFileSync(join(bag.extensionSource, 'entry.js'), SMOKE_SCRIPT_1)
  bag.extensionResult = (await bag.bridge.win.webContents.executeJavaScript(
    buildSmokeScript2(JSON.stringify(bag.extensionSource)),
  )) as { ok: boolean; stage?: string; viewport?: { width: number; height: number } }
  if (!bag.extensionResult.ok)
    throw new Error(
      `真实插件安装、浮岛切换、共享依赖、Remote 或插槽释放验收失败：${JSON.stringify(bag.extensionResult)}`,
    )
  console.log('desktop-shell-verify-local: frontend-plugin lifecycle ready')
  console.log('desktop-shell-verify-local: renderer-initial')
}

/** 执行 smoke 验收套件第 4 阶段。 */
export async function runSmokeStep4(bag: LocalVerifyState): Promise<void> {
  bag.initial = (await bag.bridge.win.webContents.executeJavaScript(
    buildSmokeScript3(TRAFFIC_LIGHT_CENTER_Y, TRAFFIC_LIGHT_CENTER_Y),
  )) as null | {
    title: string
    renderer: boolean
    islandCount: number
    pageScrollable: boolean
    islandsOpaque: boolean
    trajectoryVisible: boolean
    trajectoryFocusReady: boolean
    initialHeight: number
    grownHeight: number
    composerCapped: boolean
    projectFocused: boolean
    densityReady: boolean
    sessionCostRemoved: boolean
    workspaceHeaderRemoved: boolean
    bodyFontSize: string
    bodyFontWeight: string
    projectActionHeight: number
    tabHeight: number
    titlebarClearanceReady: boolean
    islandTop: number
    topToolbarReady: boolean
    toolbarLayoutIndependent: boolean
    panelCapsulesReady: boolean
    windowGap: number
    windowEdge: number
    modeRailWidth: number
    verifyError?: string
  }
  if (bag.initial === null) throw new Error('自有 renderer 缺少核心工作台控件')
  // getWindowButtonPosition 只在 macOS 存在；非 macOS 上不会因此跳过红绿灯布局校验。
  if (process.platform === 'darwin') {
    // 按钮高度随 macOS 版本变化，纵向位置由下方的中心对齐检查负责，这里只核对左边距。
    if (bag.bridge.win.getWindowButtonPosition()?.x !== TRAFFIC_LIGHT_LEFT) {
      throw new Error('原生红绿灯没有定位到模式浮岛内部')
    }
    // AppKit 重建标题栏后，紧凑布局要等下一次窗口更新才把按钮放回锚点；
    // 先等布局稳定再读取，避免读到系统默认位置造成偶发失败。
    let buttons = readTrafficLightLayout(bag.bridge.win)
    await waitForCondition(() => {
      buttons = readTrafficLightLayout(bag.bridge.win)
      return isCompactTrafficLightRow(buttons)
    }, 2_000)
    if (!isCompactTrafficLightRow(buttons)) {
      throw new Error(`原生红绿灯间距或边界不正确：${JSON.stringify(buttons)}`)
    }
    const projectCenter = (await bag.bridge.win.webContents.executeJavaScript(`(() => {
        const rect = document.querySelector('.project-selector').getBoundingClientRect()
        return rect.top + rect.height / 2
      })()`)) as number
    if (buttons.some(button => Math.abs(button.y + button.height / 2 - projectCenter) > 1)) {
      throw new Error('项目名称没有与原生红绿灯垂直居中对齐')
    }
  }
}

/** 执行 smoke 验收套件第 5 阶段。 */
export async function runSmokeStep5(bag: LocalVerifyState): Promise<void> {
  if (bag.initial.verifyError !== undefined)
    throw new Error(`读取自有 renderer 状态失败：${bag.initial.verifyError}`)
  console.log(
    'desktop-shell-verify-local: renderer-flags',
    Object.fromEntries(Object.entries(bag.initial).filter(entry => typeof entry[1] === 'boolean')),
  )
}

/** 运行 smoke 验收套件。 */
export async function runSmokeSuite(bag: LocalVerifyState): Promise<void> {
  bag.extensionSource = ensureFrontendPluginFixture(bag.bridge.verifyHome)
  await runSmokeStep1(bag)
  await runSmokeStep2(bag)
  await runSmokeStep3(bag)
  await runSmokeStep4(bag)
  await runSmokeStep5(bag)
  assertSuiteInvariants('smoke', bag)
}
