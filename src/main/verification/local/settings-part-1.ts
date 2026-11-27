/**
 * 设置中心全分页、归档恢复、无障碍降级、透明合成与多尺寸响应式验收套件（阶段分片 1）。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nativeTheme } from 'electron'
import {
  isTrafficLightAlignedForGap,
  settleElementAnimations,
  waitForColorScheme,
  waitForNativeTheme,
} from '../host-verify-context.ts'
import {
  captureVerifiedPage,
  clickTrustedElement,
  emulateVerificationMedia,
} from '../desktop-verifier.ts'
import { verifyEmptyConversationLayout } from '../empty-conversation-verifier.ts'
import type { LocalVerifyState } from './state.ts'
import {
  SETTINGS_SCRIPT_1,
  SETTINGS_SCRIPT_2,
  SETTINGS_SCRIPT_3,
  SETTINGS_SCRIPT_4,
  buildSettingsScript5,
  buildSettingsScript6,
  buildSettingsScript7,
  buildSettingsScript8,
  buildSettingsScript9,
  buildSettingsScript10,
  SETTINGS_SCRIPT_11,
  SETTINGS_SCRIPT_12,
  SETTINGS_SCRIPT_13,
  SETTINGS_SCRIPT_14,
  SETTINGS_SCRIPT_15,
  SETTINGS_SCRIPT_16,
  SETTINGS_SCRIPT_17,
  SETTINGS_SCRIPT_18,
  SETTINGS_SCRIPT_19,
  SETTINGS_SCRIPT_20,
  SETTINGS_SCRIPT_21,
  SETTINGS_SCRIPT_22,
  SETTINGS_SCRIPT_23,
} from './settings-scripts-1.ts'
import { SETTINGS_SCRIPT_24 } from './settings-scripts-2.ts'

/** 执行 settings 验收套件第 1 阶段。 */
export async function runSettingsStep1(bag: LocalVerifyState): Promise<void> {
  console.log('desktop-shell-verify-local: appearance-open')
  bag.verifySettingsHeader = async (): Promise<void> => {
    const aligned = (await bag.bridge.win.webContents.executeJavaScript(
      SETTINGS_SCRIPT_1,
    )) as boolean
    if (!aligned) throw new Error('设置顶栏的标题、配置入口和关闭按钮没有对齐或越出了安全边距')
  }
  await clickTrustedElement(bag.bridge.win, '#open-settings')
  await clickTrustedElement(bag.bridge.win, '.settings-nav__items > [role="menuitem"]:nth-child(2)')
  bag.settingsAudit = (await bag.bridge.win.webContents.executeJavaScript(SETTINGS_SCRIPT_2)) as {
    open: boolean
    focusInside: boolean
    panelFits: boolean
    layerCount: number
    navCount: number
    appearanceIndex: number
    modal: boolean
  }
  bag.settingsDialog = bag.settingsAudit.open
  await bag.verifySettingsHeader()
  bag.appearanceCapture = 'verify-appearance.png'
  writeFileSync(
    bag.bridge.artifactPath(bag.appearanceCapture),
    (await captureVerifiedPage(bag.bridge.win)).toPNG(),
  )
  bag.appearanceBackgroundsCapture = ''
  bag.appearanceBackgroundsReady = bag.settingsAudit.layerCount === 0
  await clickTrustedElement(bag.bridge.win, '.settings-nav__items > [role="menuitem"]:nth-child(3)')
  bag.modelsReady = (await bag.bridge.win.webContents.executeJavaScript(
    SETTINGS_SCRIPT_3,
  )) as boolean
  bag.modelsCapture = 'verify-models.png'
  writeFileSync(
    bag.bridge.artifactPath(bag.modelsCapture),
    (await captureVerifiedPage(bag.bridge.win)).toPNG(),
  )
  await clickTrustedElement(bag.bridge.win, '.settings-nav__items > [role="menuitem"]:nth-child(4)')
  bag.settingsPagesReady = (await bag.bridge.win.webContents.executeJavaScript(
    SETTINGS_SCRIPT_4,
  )) as boolean
  bag.presetsCapture = 'verify-presets.png'
  writeFileSync(
    bag.bridge.artifactPath(bag.presetsCapture),
    (await captureVerifiedPage(bag.bridge.win)).toPNG(),
  )
  // 复用隔离插件夹具写入并刷盘真实历史，不启动模型请求。
  writeFileSync(
    join(bag.extensionSource, 'mydsh.plugin.json'),
    JSON.stringify({
      id: 'verification.archive-seed',
      name: '归档验收数据',
      version: '1.0.0',
      apiVersion: 1,
      backend: 'archive-seed.mjs',
    }),
  )
  writeFileSync(
    join(bag.extensionSource, 'archive-seed.mjs'),
    buildSettingsScript5(JSON.stringify(bag.interactionSessionId)),
  )
}

/** 执行 settings 验收套件第 2 阶段。 */
export async function runSettingsStep2(bag: LocalVerifyState): Promise<void> {
  await bag.bridge.win.webContents.executeJavaScript(`(async () => {
      try { await window.dshDesktop.host.call('mydshPlugins.install', { path: ${JSON.stringify(bag.extensionSource)} }) }
      finally { await window.dshDesktop.host.call('mydshPlugins.uninstall', { id: 'verification.archive-seed' }) }
    })()`)
  bag.archiveFixture = (await bag.bridge.win.webContents.executeJavaScript(
    buildSettingsScript6(JSON.stringify(bag.interactionSessionId)),
  )) as {
    sessionId: string
    throughSeq: number
    history: unknown
    ownerId?: string
    ready: boolean
  }
  writeFileSync(
    bag.bridge.artifactPath('verify-archived-sessions.png'),
    (await captureVerifiedPage(bag.bridge.win)).toPNG(),
  )
  bag.archivedSessionsReady =
    bag.archiveFixture.ready &&
    ((await bag.bridge.win.webContents.executeJavaScript(
      buildSettingsScript7(JSON.stringify(bag.archiveFixture)),
    )) as boolean)
  // 真实运行中归档必须停止任务；旧归档中的内部通知也不能阻止后续永久删除。
  writeFileSync(
    join(bag.extensionSource, 'mydsh.plugin.json'),
    JSON.stringify({
      id: 'verification.archive-guard',
      name: '归档删除占用验收',
      version: '1.0.0',
      apiVersion: 1,
      backend: 'archive-guard.mjs',
    }),
  )
  writeFileSync(
    join(bag.extensionSource, 'archive-guard.mjs'),
    buildSettingsScript8(JSON.stringify(bag.archiveFixture.sessionId)),
  )
  await bag.bridge.win.webContents.executeJavaScript(`(async () => {
      await window.dshDesktop.host.call('mydshPlugins.install', { path: ${JSON.stringify(bag.extensionSource)} })
      await window.dshDesktop.host.call('mydshPlugins.uninstall', { id: 'verification.archive-guard' })
    })()`)
  bag.deletionConfirmationReady = (await bag.bridge.win.webContents.executeJavaScript(
    buildSettingsScript9(JSON.stringify(bag.archiveFixture)),
  )) as boolean
  bag.archiveColorScheme = bag.bridge.settingsStore.read().colorScheme
  /* oxlint-disable no-await-in-loop -- 明暗主题必须逐一渲染后截图，不能并行切换。 */
  for (const colorScheme of ['light', 'dark'] as const) {
    bag.bridge.settingsController.publish(bag.bridge.settingsStore.update({ colorScheme }))
    await waitForColorScheme(bag.bridge.win, colorScheme)
    writeFileSync(
      bag.bridge.artifactPath(`verify-delete-archive-${colorScheme}.png`),
      (await captureVerifiedPage(bag.bridge.win)).toPNG(),
    )
  }
  /* oxlint-enable no-await-in-loop */
  bag.bridge.settingsController.publish(
    bag.bridge.settingsStore.update({ colorScheme: bag.archiveColorScheme }),
  )
  await waitForColorScheme(bag.bridge.win, bag.archiveColorScheme)
  bag.permanentDeletionReady =
    bag.deletionConfirmationReady &&
    ((await bag.bridge.win.webContents.executeJavaScript(
      buildSettingsScript10(JSON.stringify(bag.archiveFixture)),
    )) as boolean)
  await clickTrustedElement(bag.bridge.win, '.settings-nav__items > [role="menuitem"]:nth-child(6)')
}

/** 执行 settings 验收套件第 3 阶段。 */
export async function runSettingsStep3(bag: LocalVerifyState): Promise<void> {
  bag.automationDefaultReady = (await bag.bridge.win.webContents.executeJavaScript(
    SETTINGS_SCRIPT_11,
  )) as boolean
  bag.automationExpandedReady = false
  bag.automationCapture = 'verify-automation.png'
  if (bag.automationDefaultReady) {
    await clickTrustedElement(
      bag.bridge.win,
      '.settings-dialog [data-automation-settings] button[role="switch"][aria-label="允许 Agent 操控内置浏览器"]',
    )
    bag.automationExpandedReady = (await bag.bridge.win.webContents.executeJavaScript(
      SETTINGS_SCRIPT_12,
    )) as boolean
    writeFileSync(
      bag.bridge.artifactPath(bag.automationCapture),
      (await captureVerifiedPage(bag.bridge.win)).toPNG(),
    )
    const shouldRestoreSwitch = (await bag.bridge.win.webContents.executeJavaScript(
      `document.querySelector('.settings-dialog [data-automation-settings] button[role="switch"][aria-label="允许 Agent 操控内置浏览器"]')?.getAttribute('aria-checked') === 'true'`,
    )) as boolean
    if (shouldRestoreSwitch) {
      await clickTrustedElement(
        bag.bridge.win,
        '.settings-dialog [data-automation-settings] button[role="switch"][aria-label="允许 Agent 操控内置浏览器"]',
      )
      await bag.bridge.win.webContents.executeJavaScript(SETTINGS_SCRIPT_13)
    }
  } else {
    writeFileSync(
      bag.bridge.artifactPath(bag.automationCapture),
      (await captureVerifiedPage(bag.bridge.win)).toPNG(),
    )
  }
  bag.automationSettingsReady = bag.automationDefaultReady && bag.automationExpandedReady
  bag.bridge.win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' })
  bag.bridge.win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' })
  bag.settingsFocusRestored = (await bag.bridge.win.webContents.executeJavaScript(
    SETTINGS_SCRIPT_14,
  )) as boolean
  // 设置中心已移除「内置插件」与「ChatGPT 订阅」分类，改为在独立插件管理页验证内置配置卡片与 Host 设置实时刷新事件。
  await clickTrustedElement(bag.bridge.win, '[data-view="plugins"]')
  bag.pluginsReady = (await bag.bridge.win.webContents.executeJavaScript(
    SETTINGS_SCRIPT_15,
  )) as boolean
  bag.pluginsCapture = 'verify-plugins.png'
  writeFileSync(
    bag.bridge.artifactPath(bag.pluginsCapture),
    (await captureVerifiedPage(bag.bridge.win)).toPNG(),
  )
  bag.hostSettingsEventsReady = (await bag.bridge.win.webContents.executeJavaScript(
    SETTINGS_SCRIPT_16,
  )) as boolean
  console.log('desktop-shell-verify-local: host-settings-events', {
    hostSettingsEventsReady: bag.hostSettingsEventsReady,
  })
  await clickTrustedElement(bag.bridge.win, '[data-view="conversation"]')
  await bag.bridge.win.webContents.executeJavaScript(`(async () => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (document.querySelector('[data-view="conversation"][aria-current="page"]') !== null
          && document.querySelector('.main-island .composer-card') instanceof HTMLElement) return
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    })()`)
}

/** 执行 settings 验收套件第 4 阶段。 */
export async function runSettingsStep4(bag: LocalVerifyState): Promise<void> {
  await settleElementAnimations(bag.bridge.win, '.app-shell')
  bag.allSettingsPagesReady =
    bag.appearanceBackgroundsReady &&
    bag.modelsReady &&
    bag.pluginsReady &&
    bag.settingsPagesReady &&
    bag.archivedSessionsReady &&
    bag.permanentDeletionReady &&
    bag.automationSettingsReady
  console.log('desktop-shell-verify-local: settings-pages', {
    appearanceBackgroundsReady: bag.appearanceBackgroundsReady,
    modelsReady: bag.modelsReady,
    pluginsReady: bag.pluginsReady,
    presetsReady: bag.settingsPagesReady,
    archivedSessionsReady: bag.archivedSessionsReady,
    permanentDeletionReady: bag.permanentDeletionReady,
    automationSettingsReady: bag.automationSettingsReady,
    allSettingsPagesReady: bag.allSettingsPagesReady,
  })
  // 旧版字段仍能读取，但不能覆盖代码区域的固定排版。
  bag.bridge.settingsController.publish(
    bag.bridge.settingsStore.update({
      editorFontSize: 18,
      editorLineHeight: 'relaxed',
      editorLigatures: true,
    }),
  )
  await new Promise(resolve => {
    setTimeout(resolve, 120)
  })
  bag.editorAppearanceApplied = (await bag.bridge.win.webContents.executeJavaScript(
    SETTINGS_SCRIPT_17,
  )) as boolean
  bag.bridge.settingsController.publish(
    bag.bridge.settingsStore.update({
      editorFontSize: 13,
      editorLineHeight: 'standard',
      editorLigatures: false,
    }),
  )
  await new Promise(resolve => {
    setTimeout(resolve, 120)
  })
  bag.editorAppearanceRestored = (await bag.bridge.win.webContents.executeJavaScript(
    SETTINGS_SCRIPT_18,
  )) as boolean
  bag.editorAppearanceReady = bag.editorAppearanceApplied && bag.editorAppearanceRestored
  // 已下线的浮岛间隙旧字段兼容读取，但界面与红绿灯均固定投影为官方 8px 默认值。
  bag.bridge.settingsController.publish(bag.bridge.settingsStore.update({ islandGap: 6 }))
  await settleElementAnimations(bag.bridge.win, '.app-shell')
  bag.compactGapIgnored =
    isTrafficLightAlignedForGap(bag.bridge.win, 8) &&
    ((await bag.bridge.win.webContents.executeJavaScript(SETTINGS_SCRIPT_19)) as boolean)
  bag.bridge.settingsController.publish(bag.bridge.settingsStore.update({ islandGap: 20 }))
  await settleElementAnimations(bag.bridge.win, '.app-shell')
}

/** 执行 settings 验收套件第 5 阶段。 */
export async function runSettingsStep5(bag: LocalVerifyState): Promise<void> {
  bag.wideGapIgnored =
    isTrafficLightAlignedForGap(bag.bridge.win, 8) &&
    ((await bag.bridge.win.webContents.executeJavaScript(`(() => {
      const sidebar = document.querySelector('.sidebar-island')
      if (!(sidebar instanceof HTMLElement)) return false
      const outer = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--window-outer-radius'))
      return document.documentElement.style.getPropertyValue('--window-gap').trim() === '8px'
        && document.documentElement.style.getPropertyValue('--window-edge').trim() === '8px'
        && Math.abs(Number.parseFloat(getComputedStyle(sidebar).borderBottomLeftRadius) - Math.max(0, outer - 8)) <= 0.1
    })()`)) as boolean)
  bag.bridge.settingsController.publish(bag.bridge.settingsStore.update({ islandGap: 8 }))
  await settleElementAnimations(bag.bridge.win, '.app-shell')
  bag.islandGapSettingReady =
    bag.compactGapIgnored &&
    bag.wideGapIgnored &&
    isTrafficLightAlignedForGap(bag.bridge.win, 8) &&
    ((await bag.bridge.win.webContents.executeJavaScript(`(() => {
        const sidebar = document.querySelector('.sidebar-island')
        if (!(sidebar instanceof HTMLElement)) return false
        const outer = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--window-outer-radius'))
        return document.documentElement.style.getPropertyValue('--window-gap').trim() === '8px'
          && Math.abs(Number.parseFloat(getComputedStyle(sidebar).borderBottomLeftRadius) - Math.max(0, outer - 8)) <= 0.1
      })()`)) as boolean)
  bag.reducedTransparencyReady = false
  bag.forcedColorsReady = false
  if (!bag.bridge.win.webContents.debugger.isAttached())
    bag.bridge.win.webContents.debugger.attach('1.3')
  try {
    await emulateVerificationMedia(bag.bridge.win, [
      { name: 'prefers-reduced-transparency', value: 'reduce' },
    ])
    bag.reducedTransparencyReady = (await bag.bridge.win.webContents.executeJavaScript(
      SETTINGS_SCRIPT_20,
    )) as boolean
    await emulateVerificationMedia(bag.bridge.win, [{ name: 'forced-colors', value: 'active' }])
    bag.forcedColorsReady = (await bag.bridge.win.webContents.executeJavaScript(
      SETTINGS_SCRIPT_21,
    )) as boolean
  } finally {
    await emulateVerificationMedia(bag.bridge.win)
  }
  console.log('desktop-shell-verify-local: accessibility', {
    reducedTransparencyReady: bag.reducedTransparencyReady,
    forcedColorsReady: bag.forcedColorsReady,
  })
  console.log('desktop-shell-verify-local: captures')
  // 媒体仿真恢复后等待实际绘制，防止默认主题截图保留上一帧的高对比配色。
  await bag.bridge.win.webContents.executeJavaScript(
    `Promise.race([new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))), new Promise(resolve => setTimeout(resolve, 200))])`,
  )
  await verifyEmptyConversationLayout(bag.bridge.win)
  bag.defaultCapture = 'verify.png'
  writeFileSync(
    bag.bridge.artifactPath(bag.defaultCapture),
    (await captureVerifiedPage(bag.bridge.win)).toPNG(),
  )
  bag.previousThemeSource = nativeTheme.themeSource
  nativeTheme.themeSource = 'dark'
}

/** 执行 settings 验收套件第 6 阶段。 */
export async function runSettingsStep6(bag: LocalVerifyState): Promise<void> {
  await waitForNativeTheme(bag.bridge.win, 'dark')
  await verifyEmptyConversationLayout(bag.bridge.win)
  bag.darkCapture = 'verify-dark.png'
  writeFileSync(
    bag.bridge.artifactPath(bag.darkCapture),
    (await captureVerifiedPage(bag.bridge.win)).toPNG(),
  )
  await clickTrustedElement(bag.bridge.win, '#open-settings')
  await clickTrustedElement(bag.bridge.win, '.settings-nav__items > [role="menuitem"]:nth-child(2)')
  bag.darkSettingsReadable = (await bag.bridge.win.webContents.executeJavaScript(
    SETTINGS_SCRIPT_22,
  )) as boolean
  writeFileSync(
    bag.bridge.artifactPath('verify-settings-dark.png'),
    (await captureVerifiedPage(bag.bridge.win)).toPNG(),
  )
  await bag.verifySettingsHeader()
  bag.waitForSettingsClosed = async (): Promise<void> => {
    await bag.bridge.win.webContents.executeJavaScript(`(async () => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const dialog = document.querySelector('.settings-dialog[role="dialog"]')
          const modalVisible = [...document.querySelectorAll('.ant-modal-wrap')].some(node => node.checkVisibility())
          if (dialog === null && !modalVisible) return
          await new Promise(resolve => setTimeout(resolve, 25))
        }
      })()`)
  }
  await clickTrustedElement(bag.bridge.win, '.settings-dialog button[aria-label="关闭设置"]')
  await bag.waitForSettingsClosed()
  nativeTheme.themeSource = 'light'
  await waitForNativeTheme(bag.bridge.win, 'light')
  // 已下线的画布配色旧字段不再覆盖固定投影（始终跟随界面配色）。
  bag.bridge.settingsController.publish(
    bag.bridge.settingsStore.update({ canvasColorScheme: 'dark' }),
  )
  bag.canvasColorSchemeReady = (await bag.bridge.win.webContents.executeJavaScript(
    SETTINGS_SCRIPT_23,
  )) as boolean
  bag.bridge.settingsController.publish(
    bag.bridge.settingsStore.update({ canvasColorScheme: 'follow-interface' }),
  )
  await settleElementAnimations(bag.bridge.win, '.app-shell')
  // 已下线的透明度、遮罩与背景图旧字段不再覆盖官方默认值：画布采用中心实色、边缘通透径向渐变，遮罩固定 0.84，无背景图。
  bag.bridge.settingsController.publish(
    bag.bridge.settingsStore.update({
      canvasTransparency: 0.42,
      contentScrimOpacity: 0.82,
    }),
  )
  bag.material = (await bag.bridge.win.webContents.executeJavaScript(
    SETTINGS_SCRIPT_24,
  )) as null | {
    backdrop: string
    opaquePoints: Array<{ x: number; y: number }>
    centerGapPoint: { x: number; y: number } | null
    edgePoints: Array<{ x: number; y: number }>
    viewport: { width: number; height: number }
    scrimAlpha: string
    canvasAlpha: string
    canvasOpacity: string
    canvasBackgroundImage: string
    canvasImage: string
    contentBackground: string
    topControlsReadable: boolean
  }
}

/** 执行 settings 验收套件第 7 阶段。 */
export async function runSettingsStep7(bag: LocalVerifyState): Promise<void> {
  bag.materialCapture = 'verify-material.png'
  bag.materialImage = await captureVerifiedPage(bag.bridge.win)
  writeFileSync(bag.bridge.artifactPath(bag.materialCapture), bag.materialImage.toPNG())
  bag.materialBitmap = bag.materialImage.toBitmap()
  bag.semiTransparentPixels = 0
  bag.materialMinimumAlpha = 255
  for (let offset = 3; offset < bag.materialBitmap.length; offset += 4) {
    const alpha = bag.materialBitmap[offset] ?? 255
    bag.materialMinimumAlpha = Math.min(bag.materialMinimumAlpha, alpha)
    if (alpha > 0 && alpha < 255) bag.semiTransparentPixels += 1
  }
  bag.semiTransparentPixelRatio =
    bag.materialBitmap.length === 0
      ? 0
      : bag.semiTransparentPixels / (bag.materialBitmap.length / 4)
  bag.captureSize = bag.materialImage.getSize()
  bag.sampleMaterialAlpha = (point: { x: number; y: number }): number => {
    const x = Math.min(
      bag.captureSize.width - 1,
      Math.max(
        0,
        Math.floor((point.x * bag.captureSize.width) / (bag.material?.viewport.width ?? 1)),
      ),
    )
    const y = Math.min(
      bag.captureSize.height - 1,
      Math.max(
        0,
        Math.floor((point.y * bag.captureSize.height) / (bag.material?.viewport.height ?? 1)),
      ),
    )
    return bag.materialBitmap[(y * bag.captureSize.width + x) * 4 + 3] ?? 255
  }
  bag.nativeIslandsOpaque =
    bag.material !== null &&
    bag.material.opaquePoints.every(point => bag.sampleMaterialAlpha(point) === 255)
  bag.edgeAlphas = bag.material === null ? [] : bag.material.edgePoints.map(bag.sampleMaterialAlpha)
  bag.minEdgeAlpha = bag.edgeAlphas.length === 0 ? 255 : Math.min(...bag.edgeAlphas)
  bag.centerGapAlpha =
    bag.material?.centerGapPoint === null || bag.material === null
      ? null
      : bag.sampleMaterialAlpha(bag.material.centerGapPoint)
  bag.radialTransparencyReady =
    bag.minEdgeAlpha > 0 &&
    bag.minEdgeAlpha < 232 &&
    bag.centerGapAlpha !== null &&
    bag.centerGapAlpha >= 245 &&
    bag.centerGapAlpha > bag.minEdgeAlpha + 25
  bag.mediumCanvasReady =
    bag.material !== null &&
    bag.nativeIslandsOpaque &&
    bag.material.canvasImage === 'none' &&
    bag.material.canvasOpacity === '1' &&
    bag.material.canvasBackgroundImage.includes('radial-gradient') &&
    (bag.bridge.nativeTransparency ||
    bag.bridge.windowController.read().canvasComposition === 'acrylic'
      ? bag.semiTransparentPixelRatio > 0 &&
        bag.semiTransparentPixelRatio < 0.25 &&
        bag.radialTransparencyReady
      : bag.materialBitmap.length > 0 && bag.materialMinimumAlpha === 255)
  bag.windowClipState = bag.bridge.windowController.read()
}

/** 执行 settings 验收套件第 8 阶段。 */
export async function runSettingsStep8(bag: LocalVerifyState): Promise<void> {
  bag.windowClipProjection = await bag.bridge.win.webContents.executeJavaScript(`(() => {
      const bounds = document.body.getBoundingClientRect()
      const style = document.documentElement.style
      return { width: bounds.width, height: bounds.height, scale: devicePixelRatio,
        radius: Number.parseFloat(style.getPropertyValue('--window-clip-radius')),
        right: Number.parseFloat(style.getPropertyValue('--window-clip-right')),
        bottom: Number.parseFloat(style.getPropertyValue('--window-clip-bottom')) }
    })()`)
  bag.nativeWindowClipReady =
    process.platform !== 'win32' ||
    bag.windowClipState.canvasComposition !== 'acrylic' ||
    (bag.windowClipState.canvasClip !== undefined &&
      Math.abs(
        bag.windowClipProjection.radius * bag.windowClipProjection.scale -
          bag.windowClipState.canvasClip.radius,
      ) < 0.1 &&
      // Windows 离屏页按 1 倍绘制，原生 HWND 仍按强制缩放；只核对该页能覆盖的投影。
      // 前台验收须严格对齐实际窗口像素，不能用离屏投影替代。
      Math.abs(
        (bag.windowClipProjection.width - bag.windowClipProjection.right) *
          bag.windowClipProjection.scale -
          (bag.bridge.verifyBackground
            ? Math.min(
                bag.windowClipProjection.width * bag.windowClipProjection.scale,
                bag.windowClipState.canvasClip.width,
              )
            : bag.windowClipState.canvasClip.width),
      ) < 0.1 &&
      Math.abs(
        (bag.windowClipProjection.height - bag.windowClipProjection.bottom) *
          bag.windowClipProjection.scale -
          (bag.bridge.verifyBackground
            ? Math.min(
                bag.windowClipProjection.height * bag.windowClipProjection.scale,
                bag.windowClipState.canvasClip.height,
              )
            : bag.windowClipState.canvasClip.height),
      ) < 0.1)
  console.log('desktop-shell-verify-local: medium-canvas', {
    canvasOpacity: bag.material?.canvasOpacity,
    semiTransparentPixelRatio: bag.semiTransparentPixelRatio,
    minEdgeAlpha: bag.minEdgeAlpha,
    centerGapAlpha: bag.centerGapAlpha,
    radialTransparencyReady: bag.radialTransparencyReady,
    nativeIslandsOpaque: bag.nativeIslandsOpaque,
    topControlsReadable: bag.material?.topControlsReadable,
    mediumCanvasReady: bag.mediumCanvasReady,
    nativeWindowClipReady: bag.nativeWindowClipReady,
    ...(bag.nativeWindowClipReady
      ? {}
      : {
          windowClipState: bag.windowClipState,
          windowClipProjection: bag.windowClipProjection,
          windowBounds: bag.bridge.win.getBounds(),
        }),
  })
  // 即使旧配置将 canvasTransparency 设为 1，画布仍保持中心实色、边缘通透的径向渐变与原透明窗口合成。
  bag.bridge.settingsController.publish(bag.bridge.settingsStore.update({ canvasTransparency: 1 }))
}
