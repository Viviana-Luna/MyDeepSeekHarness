/**
 * 桌面端真实 Electron 验收统一按需入口：仅在 --verify 模式下由主进程动态导入，
 * 支持全量验收、专项验收（workbench / database / ssh）及按功能套件（--suite=<名称>）快速验收。
 */
import { writeFileSync } from 'node:fs'
import { app } from 'electron'
import { focusPrimaryWindow } from '../lifecycle/app-lifecycle.ts'
import { verifyDatabaseWorkspace } from './database-verifier.ts'
import {
  captureVerifiedPage,
  createFailedVerifyReport,
  emulateVerificationMedia,
} from './desktop-verifier.ts'
import {
  ALL_LOCAL_SUITES,
  parseVerificationSuites,
  type HostVerificationBridge,
  type LocalSuiteName,
} from './host-verify-context.ts'
import { runComposerSuite } from './local/composer-suite.ts'
import { runConversationSuite } from './local/conversation-suite.ts'
import { runFilesScmSuite } from './local/files-scm-suite.ts'
import { runModelsSuite } from './local/models-suite.ts'
import { runPanelsSuite } from './local/panels-suite.ts'
import {
  buildFullVerificationReport,
  buildSubsetVerificationReport,
} from './local/report-builder.ts'
import { runSessionsSuite } from './local/sessions-suite.ts'
import { runSettingsSuite } from './local/settings-suite.ts'
import { runSmokeSuite } from './local/smoke-suite.ts'
import { createLocalVerifyState, type LocalVerifyState } from './local/state.ts'
import { verifySshWorkspace } from './ssh-verifier.ts'
import { verifyWorkbenchAdjustments } from './workbench-adjustments-verifier.ts'
import { verifyWorkspaceTabs } from './workspace-tabs-verifier.ts'

const SUITE_RUNNERS: Record<LocalSuiteName, (state: LocalVerifyState) => Promise<void>> = {
  smoke: runSmokeSuite,
  conversation: runConversationSuite,
  composer: runComposerSuite,
  sessions: runSessionsSuite,
  panels: runPanelsSuite,
  'files-scm': runFilesScmSuite,
  models: runModelsSuite,
  settings: runSettingsSuite,
}

/** 判断当前命令行验收选择是否需要执行启动小窗完整验收。 */
export function shouldVerifyStartupScreen(argv: readonly string[]): boolean {
  const selection = parseVerificationSuites(argv)
  if (selection.kind === 'all') return true
  if (selection.kind === 'subsets') return selection.suites.includes('smoke')
  return false
}

async function prepareRendererEnvironment(bridge: HostVerificationBridge): Promise<void> {
  bridge.setStage('settings')
  bridge.win.webContents.setBackgroundThrottling(false)
  await emulateVerificationMedia(bridge.win)
  if (bridge.verifyBackground) {
    await bridge.win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {
      enabled: true,
    })
    console.log('desktop-shell-verify-local: background', {
      visible: bridge.win.isVisible(),
      focused: bridge.win.isFocused(),
    })
  } else {
    app.focus({ steal: true })
    focusPrimaryWindow(bridge.win)
  }
}

async function executeSelectedSuites(
  bridge: HostVerificationBridge,
  suites: readonly LocalSuiteName[],
  isFullRun: boolean,
): Promise<void> {
  await prepareRendererEnvironment(bridge)
  const state = createLocalVerifyState(bridge)
  /* oxlint-disable no-await-in-loop -- 同一窗口内的 UI 验收套件必须按确定顺序串行驱动。 */
  for (const suiteName of suites) {
    const startedAt = performance.now()
    console.log(`desktop-shell-verify-suite-start: ${suiteName}`)
    await SUITE_RUNNERS[suiteName](state)
    const elapsed = ((performance.now() - startedAt) / 1000).toFixed(2)
    console.log(`desktop-shell-verify-suite-done: ${suiteName} (${elapsed}s)`)
  }
  /* oxlint-enable no-await-in-loop */
  const { report, ok } = isFullRun
    ? buildFullVerificationReport(state)
    : buildSubsetVerificationReport(state, suites)
  bridge.finishVerify(report, ok ? 0 : 1)
}

function createSchemeAndCaptureHelpers(bridge: HostVerificationBridge) {
  const setScheme = (scheme: 'light' | 'dark'): void => {
    bridge.settingsController.publish(bridge.settingsStore.update({ colorScheme: scheme }))
  }
  const capturePng = async (name: string): Promise<string> => {
    const path = bridge.artifactPath(name)
    writeFileSync(path, (await captureVerifiedPage(bridge.win)).toPNG())
    return path
  }
  return { setScheme, capturePng }
}

function finishStandaloneSuite(bridge: HostVerificationBridge): void {
  const report = createFailedVerifyReport('complete', new Error(''), true)
  delete report.error
  Object.assign(report, { appMounted: true, uiActive: true, blank: false })
  bridge.finishVerify(report, 0)
}

async function runWorkbenchSelection(bridge: HostVerificationBridge): Promise<void> {
  const { setScheme, capturePng } = createSchemeAndCaptureHelpers(bridge)
  await verifyWorkspaceTabs(
    bridge.win,
    setScheme,
    capturePng,
    frame => {
      bridge.win.webContents.send(bridge.hostChannels.sessionFrame, frame)
    },
    (sessionId, running) => {
      bridge.win.webContents.send(bridge.hostChannels.hostFrame, {
        type: 'host/session-status',
        sessionId,
        running,
      })
    },
  )
  await verifyWorkbenchAdjustments({
    win: bridge.win,
    appearance: setScheme,
    capture: capturePng,
  })
  finishStandaloneSuite(bridge)
}

/** 根据命令行参数分发并执行真实 Electron 桌面验收。 */
export async function runDesktopVerification(bridge: HostVerificationBridge): Promise<void> {
  if (bridge.getCurrentHost() === undefined || bridge.isVerifyReported()) return
  const { win } = bridge
  try {
    if (!bridge.sameRendererPage(win.webContents.getURL())) {
      throw new Error('真实 Electron 验收必须位于受信任的本地 renderer')
    }
    const selection = parseVerificationSuites(process.argv)
    if (selection.kind === 'workbench') {
      await runWorkbenchSelection(bridge)
    } else if (selection.kind === 'database') {
      const { setScheme, capturePng } = createSchemeAndCaptureHelpers(bridge)
      await verifyDatabaseWorkspace(win, setScheme, capturePng)
      finishStandaloneSuite(bridge)
    } else if (selection.kind === 'ssh') {
      const { setScheme, capturePng } = createSchemeAndCaptureHelpers(bridge)
      await verifySshWorkspace(win, setScheme, capturePng)
      finishStandaloneSuite(bridge)
    } else if (selection.kind === 'subsets') {
      await executeSelectedSuites(bridge, selection.suites, false)
    } else {
      await executeSelectedSuites(bridge, ALL_LOCAL_SUITES, true)
    }
  } catch (error) {
    console.error('真实 Electron renderer 验收失败：', error)
    await captureVerifiedPage(win)
      .then(capture => {
        writeFileSync(bridge.artifactPath('verify-failure.png'), capture.toPNG())
      })
      .catch(() => {})
    bridge.finishVerify(createFailedVerifyReport(bridge.getStage(), error, true), 1)
  } finally {
    if (!win.webContents.isDestroyed() && win.webContents.debugger.isAttached()) {
      win.webContents.debugger.detach()
    }
  }
}
