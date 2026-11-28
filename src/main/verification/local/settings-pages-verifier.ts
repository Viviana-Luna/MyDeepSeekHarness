/**
 * 设置中心各分类页面、会话归档恢复与永久删除、自动化权限与旧字段兼容验收器。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { captureVerifiedPage, clickTrustedElement } from '../desktop-verifier.ts'
import {
  isTrafficLightAlignedForGap,
  settleElementAnimations,
  waitForColorScheme,
} from '../host-verify-context.ts'
import {
  AGENT_PRESETS_SETTINGS_PAGE_PROBE,
  APPEARANCE_SETTINGS_PAGE_PROBE,
  AUTOMATION_SETTINGS_DEFAULT_PROBE,
  AUTOMATION_SETTINGS_EXPANDED_PROBE,
  AUTOMATION_SETTINGS_RESTORED_PROBE,
  EDITOR_FIXED_TYPOGRAPHY_APPLIED_PROBE,
  EDITOR_FIXED_TYPOGRAPHY_RESTORED_PROBE,
  HOST_SETTINGS_LIVE_MUTATION_PROBE,
  MODELS_SETTINGS_PAGE_PROBE,
  SETTINGS_FOCUS_RESTORED_PROBE,
  SETTINGS_HEADER_ALIGNMENT_PROBE,
  STANDALONE_PLUGIN_MANAGER_PROBE,
  buildArchiveAndFilterSessionProbe,
  buildArchiveHistorySeedPluginSource,
  buildCancelAndReopenPermanentDeleteProbe,
  buildConfirmPermanentDeleteProbe,
  buildRestoreArchivedSessionProbe,
  buildRunningSessionArchiveGuardPluginSource,
} from './settings-pages-probes.ts'
import { FIXED_ISLAND_GAP_GEOMETRY_PROBE } from './settings-visual-probes.ts'
import type { LocalVerifyState } from './state.ts'

/** 校验当前打开的设置对话框顶栏对齐与实色表面。 */
export async function assertSettingsDialogHeaderAligned(state: LocalVerifyState): Promise<void> {
  const aligned = (await state.bridge.win.webContents.executeJavaScript(
    SETTINGS_HEADER_ALIGNMENT_PROBE,
  )) as boolean
  if (!aligned) throw new Error('设置顶栏的标题、配置入口和关闭按钮没有对齐或越出了安全边距')
}

/** 等待设置对话框及嵌套 AntD 模态层彻底退场卸载。 */
export async function waitForSettingsDialogClosed(state: LocalVerifyState): Promise<void> {
  await state.bridge.win.webContents.executeJavaScript(`(async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const dialog = document.querySelector('.settings-dialog[role="dialog"]')
      const modalVisible = [...document.querySelectorAll('.ant-modal-wrap')].some(node => node.checkVisibility())
      if (dialog === null && !modalVisible) return
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  })()`)
}

/** 验证外观、模型与 Agent 预设设置页。 */
export async function verifyAppearanceModelsAndPresetsPages(
  state: LocalVerifyState,
): Promise<void> {
  console.log('desktop-shell-verify-local: appearance-open')
  await clickTrustedElement(state.bridge.win, '#open-settings')
  await clickTrustedElement(
    state.bridge.win,
    '.settings-nav__items > [role="menuitem"]:nth-child(2)',
  )
  state.settingsAudit = (await state.bridge.win.webContents.executeJavaScript(
    APPEARANCE_SETTINGS_PAGE_PROBE,
  )) as {
    open: boolean
    focusInside: boolean
    panelFits: boolean
    layerCount: number
    navCount: number
    appearanceIndex: number
    modal: boolean
  }
  state.settingsDialog = state.settingsAudit.open
  await assertSettingsDialogHeaderAligned(state)
  state.appearanceCapture = 'verify-appearance.png'
  writeFileSync(
    state.bridge.artifactPath(state.appearanceCapture),
    (await captureVerifiedPage(state.bridge.win)).toPNG(),
  )
  state.appearanceBackgroundsCapture = ''
  state.appearanceBackgroundsReady = state.settingsAudit.layerCount === 0

  await clickTrustedElement(
    state.bridge.win,
    '.settings-nav__items > [role="menuitem"]:nth-child(3)',
  )
  state.modelsReady = (await state.bridge.win.webContents.executeJavaScript(
    MODELS_SETTINGS_PAGE_PROBE,
  )) as boolean
  state.modelsCapture = 'verify-models.png'
  writeFileSync(
    state.bridge.artifactPath(state.modelsCapture),
    (await captureVerifiedPage(state.bridge.win)).toPNG(),
  )

  await clickTrustedElement(
    state.bridge.win,
    '.settings-nav__items > [role="menuitem"]:nth-child(4)',
  )
  state.settingsPagesReady = (await state.bridge.win.webContents.executeJavaScript(
    AGENT_PRESETS_SETTINGS_PAGE_PROBE,
  )) as boolean
  state.presetsCapture = 'verify-presets.png'
  writeFileSync(
    state.bridge.artifactPath(state.presetsCapture),
    (await captureVerifiedPage(state.bridge.win)).toPNG(),
  )
}

async function installAndUninstallTemporaryBackendPlugin(
  state: LocalVerifyState,
  manifest: { id: string; name: string; backend: string },
  source: string,
): Promise<void> {
  writeFileSync(
    join(state.extensionSource, 'mydsh.plugin.json'),
    JSON.stringify({ ...manifest, version: '1.0.0', apiVersion: 1 }),
  )
  writeFileSync(join(state.extensionSource, manifest.backend), source)
  await state.bridge.win.webContents.executeJavaScript(`(async () => {
    try { await window.dshDesktop.host.call('mydshPlugins.install', { path: ${JSON.stringify(state.extensionSource)} }) }
    finally { await window.dshDesktop.host.call('mydshPlugins.uninstall', { id: ${JSON.stringify(manifest.id)} }) }
  })()`)
}

/** 验证会话归档筛选、无损恢复、运行中归档停止与永久删除闭环。 */
export async function verifyArchivedSessionsAndDeletion(state: LocalVerifyState): Promise<void> {
  await installAndUninstallTemporaryBackendPlugin(
    state,
    { id: 'verification.archive-seed', name: '归档验收数据', backend: 'archive-seed.mjs' },
    buildArchiveHistorySeedPluginSource(state.interactionSessionId),
  )

  const archiveFixture = (await state.bridge.win.webContents.executeJavaScript(
    buildArchiveAndFilterSessionProbe(state.interactionSessionId),
  )) as {
    sessionId: string
    throughSeq: number
    history: unknown
    ownerId?: string
    ready: boolean
  }
  state.archiveFixture = archiveFixture
  writeFileSync(
    state.bridge.artifactPath('verify-archived-sessions.png'),
    (await captureVerifiedPage(state.bridge.win)).toPNG(),
  )
  state.archivedSessionsReady =
    archiveFixture.ready &&
    ((await state.bridge.win.webContents.executeJavaScript(
      buildRestoreArchivedSessionProbe(archiveFixture),
    )) as boolean)

  await installAndUninstallTemporaryBackendPlugin(
    state,
    {
      id: 'verification.archive-guard',
      name: '归档删除占用验收',
      backend: 'archive-guard.mjs',
    },
    buildRunningSessionArchiveGuardPluginSource(archiveFixture.sessionId),
  )

  const deletionConfirmationReady = (await state.bridge.win.webContents.executeJavaScript(
    buildCancelAndReopenPermanentDeleteProbe(archiveFixture),
  )) as boolean
  const archiveColorScheme = state.bridge.settingsStore.read().colorScheme
  /* oxlint-disable no-await-in-loop -- 明暗主题必须逐一渲染后截图，不能并行切换。 */
  for (const colorScheme of ['light', 'dark'] as const) {
    state.bridge.settingsController.publish(state.bridge.settingsStore.update({ colorScheme }))
    await waitForColorScheme(state.bridge.win, colorScheme)
    writeFileSync(
      state.bridge.artifactPath(`verify-delete-archive-${colorScheme}.png`),
      (await captureVerifiedPage(state.bridge.win)).toPNG(),
    )
  }
  /* oxlint-enable no-await-in-loop */
  state.bridge.settingsController.publish(
    state.bridge.settingsStore.update({ colorScheme: archiveColorScheme }),
  )
  await waitForColorScheme(state.bridge.win, archiveColorScheme)

  state.permanentDeletionReady =
    deletionConfirmationReady &&
    ((await state.bridge.win.webContents.executeJavaScript(
      buildConfirmPermanentDeleteProbe(archiveFixture),
    )) as boolean)
  await clickTrustedElement(
    state.bridge.win,
    '.settings-nav__items > [role="menuitem"]:nth-child(6)',
  )
}

async function toggleAndVerifyAutomationSettings(state: LocalVerifyState): Promise<void> {
  const automationDefaultReady = (await state.bridge.win.webContents.executeJavaScript(
    AUTOMATION_SETTINGS_DEFAULT_PROBE,
  )) as boolean
  let automationExpandedReady = false
  state.automationCapture = 'verify-automation.png'
  if (automationDefaultReady) {
    const switchSelector =
      '.settings-dialog [data-automation-settings] button[role="switch"][aria-label="允许 Agent 操控内置浏览器"]'
    await clickTrustedElement(state.bridge.win, switchSelector)
    automationExpandedReady = (await state.bridge.win.webContents.executeJavaScript(
      AUTOMATION_SETTINGS_EXPANDED_PROBE,
    )) as boolean
    writeFileSync(
      state.bridge.artifactPath(state.automationCapture),
      (await captureVerifiedPage(state.bridge.win)).toPNG(),
    )
    const shouldRestoreSwitch = (await state.bridge.win.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(switchSelector)})?.getAttribute('aria-checked') === 'true'`,
    )) as boolean
    if (shouldRestoreSwitch) {
      await clickTrustedElement(state.bridge.win, switchSelector)
      await state.bridge.win.webContents.executeJavaScript(AUTOMATION_SETTINGS_RESTORED_PROBE)
    }
  } else {
    writeFileSync(
      state.bridge.artifactPath(state.automationCapture),
      (await captureVerifiedPage(state.bridge.win)).toPNG(),
    )
  }
  state.automationSettingsReady = automationDefaultReady && automationExpandedReady
}

/** 验证自动化权限页、独立插件管理页及 Host 设置实时更新事件。 */
export async function verifyAutomationAndBuiltinPluginSettings(
  state: LocalVerifyState,
): Promise<void> {
  await toggleAndVerifyAutomationSettings(state)

  state.bridge.win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' })
  state.bridge.win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' })
  state.settingsFocusRestored = (await state.bridge.win.webContents.executeJavaScript(
    SETTINGS_FOCUS_RESTORED_PROBE,
  )) as boolean

  await clickTrustedElement(state.bridge.win, '[data-view="plugins"]')
  state.pluginsReady = (await state.bridge.win.webContents.executeJavaScript(
    STANDALONE_PLUGIN_MANAGER_PROBE,
  )) as boolean
  state.pluginsCapture = 'verify-plugins.png'
  writeFileSync(
    state.bridge.artifactPath(state.pluginsCapture),
    (await captureVerifiedPage(state.bridge.win)).toPNG(),
  )
  state.hostSettingsEventsReady = (await state.bridge.win.webContents.executeJavaScript(
    HOST_SETTINGS_LIVE_MUTATION_PROBE,
  )) as boolean
  console.log('desktop-shell-verify-local: host-settings-events', {
    hostSettingsEventsReady: state.hostSettingsEventsReady,
  })

  await clickTrustedElement(state.bridge.win, '[data-view="conversation"]')
  await state.bridge.win.webContents.executeJavaScript(`(async () => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (document.querySelector('[data-view="conversation"][aria-current="page"]') !== null
        && document.querySelector('.main-island .composer-card') instanceof HTMLElement) return
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  })()`)
  await settleElementAnimations(state.bridge.win, '.app-shell')
  state.allSettingsPagesReady =
    state.appearanceBackgroundsReady &&
    state.modelsReady &&
    state.pluginsReady &&
    state.settingsPagesReady &&
    state.archivedSessionsReady &&
    state.permanentDeletionReady &&
    state.automationSettingsReady
  console.log('desktop-shell-verify-local: settings-pages', {
    appearanceBackgroundsReady: state.appearanceBackgroundsReady,
    modelsReady: state.modelsReady,
    pluginsReady: state.pluginsReady,
    presetsReady: state.settingsPagesReady,
    archivedSessionsReady: state.archivedSessionsReady,
    permanentDeletionReady: state.permanentDeletionReady,
    automationSettingsReady: state.automationSettingsReady,
    allSettingsPagesReady: state.allSettingsPagesReady,
  })
}

/** 验证编辑器与浮岛间隙旧版设置字段兼容读取但不破坏固定界面规范。 */
export async function verifyLegacyEditorAndIslandGapInvariants(
  state: LocalVerifyState,
): Promise<void> {
  state.bridge.settingsController.publish(
    state.bridge.settingsStore.update({
      editorFontSize: 18,
      editorLineHeight: 'relaxed',
      editorLigatures: true,
    }),
  )
  await new Promise(resolve => {
    setTimeout(resolve, 120)
  })
  const editorApplied = (await state.bridge.win.webContents.executeJavaScript(
    EDITOR_FIXED_TYPOGRAPHY_APPLIED_PROBE,
  )) as boolean
  state.bridge.settingsController.publish(
    state.bridge.settingsStore.update({
      editorFontSize: 13,
      editorLineHeight: 'standard',
      editorLigatures: false,
    }),
  )
  await new Promise(resolve => {
    setTimeout(resolve, 120)
  })
  const editorRestored = (await state.bridge.win.webContents.executeJavaScript(
    EDITOR_FIXED_TYPOGRAPHY_RESTORED_PROBE,
  )) as boolean
  state.editorAppearanceReady = editorApplied && editorRestored

  const checkFixedCornerAndGap = async (): Promise<boolean> =>
    (await state.bridge.win.webContents.executeJavaScript(`(() => {
      const sidebar = document.querySelector('.sidebar-island')
      if (!(sidebar instanceof HTMLElement)) return false
      const outer = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--window-outer-radius'))
      return document.documentElement.style.getPropertyValue('--window-gap').trim() === '8px'
        && document.documentElement.style.getPropertyValue('--window-edge').trim() === '8px'
        && Math.abs(Number.parseFloat(getComputedStyle(sidebar).borderBottomLeftRadius) - Math.max(0, outer - 8)) <= 0.1
    })()`)) as boolean

  state.bridge.settingsController.publish(state.bridge.settingsStore.update({ islandGap: 6 }))
  await settleElementAnimations(state.bridge.win, '.app-shell')
  const compactGapIgnored =
    isTrafficLightAlignedForGap(state.bridge.win, 8) &&
    ((await state.bridge.win.webContents.executeJavaScript(
      FIXED_ISLAND_GAP_GEOMETRY_PROBE,
    )) as boolean)

  state.bridge.settingsController.publish(state.bridge.settingsStore.update({ islandGap: 20 }))
  await settleElementAnimations(state.bridge.win, '.app-shell')
  const wideGapIgnored =
    isTrafficLightAlignedForGap(state.bridge.win, 8) && (await checkFixedCornerAndGap())

  state.bridge.settingsController.publish(state.bridge.settingsStore.update({ islandGap: 8 }))
  await settleElementAnimations(state.bridge.win, '.app-shell')
  state.islandGapSettingReady =
    compactGapIgnored &&
    wideGapIgnored &&
    isTrafficLightAlignedForGap(state.bridge.win, 8) &&
    (await checkFixedCornerAndGap())
}
