/**
 * 基础壳层、导航安全、窗口控制与前端扩展生命周期验收套件。
 */
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { parseDesktopWorkspaceCreateResult } from '../../../shared/workspace-capabilities.ts'
import { focusPrimaryWindow } from '../../lifecycle/app-lifecycle.ts'
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
import { verifyWorkspaceNavigation } from '../navigation-verifier.ts'
import { verifyWindowControls } from '../window-verifier.ts'
import {
  FRONTEND_PLUGIN_ENTRY_SOURCE,
  buildInitialWorkbenchProbe,
  buildPluginLifecycleProbe,
} from './smoke-probes.ts'
import { assertSuiteInvariants, type LocalVerifyState } from './state.ts'

async function verifyNavigationSecurity(state: LocalVerifyState): Promise<void> {
  state.navigationStreams = state.bridge.getLiveStreamsController()
  await verifyWorkspaceNavigation(
    state.bridge.win,
    state.bridge.startupDocument,
    () =>
      state.navigationStreams !== undefined &&
      state.bridge.getLiveStreamsController() === state.navigationStreams &&
      !state.navigationStreams.signal.aborted,
  )
}

async function verifyOptionalDirectoryPicker(state: LocalVerifyState): Promise<void> {
  if (!process.argv.includes('--verify-directory-picker')) return
  // 真实系统对话框需要操作员或系统 UI 自动化选取；其余流程沿用同一隔离验收。
  const directory = join(state.bridge.verifyHome!, 'picked-project')
  mkdirSync(directory, { mode: 0o700 })
  console.log('desktop-shell-verify-directory: 请先取消目录选择，再选择', directory)
  const cancelled = (await state.bridge.win.webContents.executeJavaScript(
    "window.dshDesktop.host.call('pickWorkspaceDirectory', {})",
  )) as unknown
  if (cancelled !== null) throw new Error('取消目录选择没有返回 null')
  const selected = (await state.bridge.win.webContents.executeJavaScript(
    "window.dshDesktop.host.call('pickWorkspaceDirectory', {})",
  )) as unknown
  if (typeof selected !== 'string' || realpathSync(selected) !== realpathSync(directory)) {
    throw new Error('原生目录选择结果不正确')
  }
  const created = parseDesktopWorkspaceCreateResult(
    await state.bridge.win.webContents.executeJavaScript(
      `window.dshDesktop.host.call('createWorkspace', { path: ${JSON.stringify(selected)} })`,
    ),
  )
  if (created.workspace.path !== realpathSync(directory)) {
    throw new Error('项目未绑定到实际选中的目录')
  }
  await state.bridge.win.webContents.executeJavaScript(
    `window.dshDesktop.host.call('removeWorkspace', { workspaceId: ${JSON.stringify(created.workspace.workspaceId)} })`,
  )
  const abort = new AbortController()
  const pending = state.bridge.supervisor.call('directoryPicker/pick', { args: {} }, abort.signal)
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
  app.focus({ steal: true })
  focusPrimaryWindow(state.bridge.win)
}

async function verifyPrimaryWindowControls(state: LocalVerifyState): Promise<void> {
  await verifyOptionalDirectoryPicker(state)
  if (!state.bridge.verifyBackground) {
    if (!(await waitForCondition(() => state.bridge.win.isFocused(), 12_000))) {
      throw new Error('验收窗口未获得前台焦点')
    }
    state.bridge.win.webContents.focus()
  }
  state.windowControlsReady = await verifyWindowControls(
    state.bridge.win,
    !state.bridge.verifyBackground,
  )
  console.log('desktop-shell-verify-local: window-controls', {
    windowControlsReady: state.windowControlsReady,
    ...state.bridge.windowController.read(),
  })
}

async function verifyFrontendPluginLifecycle(state: LocalVerifyState): Promise<void> {
  if (state.bridge.verifyHome === undefined) throw new Error('插件验收缺少隔离目录')
  state.extensionSource = join(state.bridge.verifyHome, 'frontend-plugin')
  mkdirSync(state.extensionSource, { recursive: true })
  writeFileSync(
    join(state.extensionSource, 'mydsh.plugin.json'),
    JSON.stringify({
      id: 'verification.extension',
      name: '界面扩展验收',
      version: '1.0.0',
      apiVersion: 1,
      frontend: 'entry.js',
    }),
  )
  writeFileSync(join(state.extensionSource, 'entry.js'), FRONTEND_PLUGIN_ENTRY_SOURCE)
  state.extensionResult = (await state.bridge.win.webContents.executeJavaScript(
    buildPluginLifecycleProbe(state.extensionSource),
  )) as { ok: boolean; stage?: string; viewport?: { width: number; height: number } }
  if (!state.extensionResult.ok) {
    throw new Error(
      `真实插件安装、浮岛切换、共享依赖、Remote 或插槽释放验收失败：${JSON.stringify(state.extensionResult)}`,
    )
  }
  console.log('desktop-shell-verify-local: frontend-plugin lifecycle ready')
  console.log('desktop-shell-verify-local: renderer-initial')
}

async function verifyInitialWorkbenchGeometry(state: LocalVerifyState): Promise<void> {
  state.initial = (await state.bridge.win.webContents.executeJavaScript(
    buildInitialWorkbenchProbe(TRAFFIC_LIGHT_CENTER_Y),
  )) as null | Record<string, unknown>
  if (state.initial === null) throw new Error('自有 renderer 缺少核心工作台控件')
  if (process.platform === 'darwin') {
    if (state.bridge.win.getWindowButtonPosition()?.x !== TRAFFIC_LIGHT_LEFT) {
      throw new Error('原生红绿灯没有定位到模式浮岛内部')
    }
    let buttons = readTrafficLightLayout(state.bridge.win)
    await waitForCondition(() => {
      buttons = readTrafficLightLayout(state.bridge.win)
      return isCompactTrafficLightRow(buttons)
    }, 2_000)
    if (!isCompactTrafficLightRow(buttons)) {
      throw new Error(`原生红绿灯间距或边界不正确：${JSON.stringify(buttons)}`)
    }
    const projectCenter = (await state.bridge.win.webContents.executeJavaScript(`(() => {
      const rect = document.querySelector('.project-selector').getBoundingClientRect()
      return rect.top + rect.height / 2
    })()`)) as number
    if (buttons.some(button => Math.abs(button.y + button.height / 2 - projectCenter) > 1)) {
      throw new Error('项目名称没有与原生红绿灯垂直居中对齐')
    }
  }
  if (state.initial.verifyError !== undefined) {
    throw new Error(`读取自有 renderer 状态失败：${String(state.initial.verifyError)}`)
  }
  console.log(
    'desktop-shell-verify-local: renderer-flags',
    Object.fromEntries(
      Object.entries(state.initial).filter(entry => typeof entry[1] === 'boolean'),
    ),
  )
}

/** 运行 smoke 验收套件。 */
export async function runSmokeSuite(state: LocalVerifyState): Promise<void> {
  state.extensionSource = ensureFrontendPluginFixture(state.bridge.verifyHome)
  await verifyNavigationSecurity(state)
  await verifyPrimaryWindowControls(state)
  await verifyFrontendPluginLifecycle(state)
  await verifyInitialWorkbenchGeometry(state)
  assertSuiteInvariants('smoke', state)
}
