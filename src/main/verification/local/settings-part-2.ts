/**
 * 设置中心全分页、归档恢复、无障碍降级、透明合成与多尺寸响应式验收套件（阶段分片 2）。
 */
import { writeFileSync } from 'node:fs'
import { nativeTheme, screen } from 'electron'
import {
  openRightVerificationPanel,
  settleElementAnimations,
  waitForNativeTheme,
  waitForWindowSize,
} from '../host-verify-context.ts'
import {
  captureVerifiedPage,
  clickTrustedElement,
  dragTrustedElementHorizontally,
} from '../desktop-verifier.ts'
import { seedComposerReadings } from '../session-projection-fixture.ts'
import type { LocalVerifyState } from './state.ts'
import {
  SETTINGS_SCRIPT_25,
  SETTINGS_SCRIPT_26,
  SETTINGS_SCRIPT_27,
  SETTINGS_SCRIPT_28,
  SETTINGS_SCRIPT_29,
  SETTINGS_SCRIPT_30,
  SETTINGS_SCRIPT_31,
  SETTINGS_SCRIPT_32,
  SETTINGS_SCRIPT_33,
  SETTINGS_SCRIPT_34,
} from './settings-scripts-2.ts'

/** 执行 settings 验收套件第 9 阶段。 */
export async function runSettingsStep9(bag: LocalVerifyState): Promise<void> {
  bag.clearCanvas = (await bag.bridge.win.webContents.executeJavaScript(
    SETTINGS_SCRIPT_25,
  )) as null | {
    canvasAlpha: string
    canvasOpacity: string
    canvasBackgroundImage: string
    shellOpacity: string
    islandsKeepOwnOpacity: boolean
    transparentRoots: boolean
    canvasCoversWindow: boolean
  }
  bag.clearCapture = 'verify-clear.png'
  bag.clearImage = await captureVerifiedPage(bag.bridge.win)
  bag.clearBitmap = bag.clearImage.toBitmap()
  bag.transparentPixels = 0
  bag.minimumCanvasAlpha = 255
  for (let offset = 3; offset < bag.clearBitmap.length; offset += 4) {
    const alpha = bag.clearBitmap[offset] ?? 255
    bag.minimumCanvasAlpha = Math.min(bag.minimumCanvasAlpha, alpha)
    if (alpha > 0 && alpha < 255) bag.transparentPixels += 1
  }
  writeFileSync(bag.bridge.artifactPath(bag.clearCapture), bag.clearImage.toPNG())
  bag.transparentPixelRatio =
    bag.clearBitmap.length === 0 ? 0 : bag.transparentPixels / (bag.clearBitmap.length / 4)
  bag.clearCanvasReady =
    bag.clearCanvas !== null &&
    Math.abs(Number(bag.clearCanvas.canvasAlpha) - 0.68) <= 0.001 &&
    bag.clearCanvas.canvasOpacity === '1' &&
    bag.clearCanvas.canvasBackgroundImage.includes('radial-gradient') &&
    bag.clearCanvas.shellOpacity === '1' &&
    bag.clearCanvas.islandsKeepOwnOpacity &&
    bag.clearCanvas.canvasCoversWindow &&
    (bag.bridge.nativeTransparency ||
    bag.bridge.windowController.read().canvasComposition === 'acrylic'
      ? bag.clearCanvas.transparentRoots && bag.transparentPixelRatio > 0
      : !bag.clearCanvas.transparentRoots && bag.minimumCanvasAlpha === 255)
  console.log('desktop-shell-verify-local: clear-canvas', {
    ...bag.clearCanvas,
    minimumCanvasAlpha: bag.minimumCanvasAlpha,
    transparentPixelRatio: bag.transparentPixelRatio,
    clearCanvasReady: bag.clearCanvasReady,
  })
  bag.bridge.settingsController.publish(
    bag.bridge.settingsStore.update({ canvasTransparency: 0.42 }),
  )
  await settleElementAnimations(bag.bridge.win, '.app-shell')
}

/** 执行 settings 验收套件第 10 阶段。 */
export async function runSettingsStep10(bag: LocalVerifyState): Promise<void> {
  if (process.platform === 'darwin' && !bag.bridge.verifyBackground) {
    const paintedSize = { width: 0, height: 0 }
    bag.bridge.win.webContents.beginFrameSubscription(image => {
      Object.assign(paintedSize, image.getSize())
    })
    try {
      await new Promise<void>(resolve => {
        bag.bridge.win.once('enter-full-screen', () => resolve())
        bag.bridge.win.setFullScreen(true)
      })
      const fullscreenViewport = (await bag.bridge.win.webContents.executeJavaScript(
        `({ width: innerWidth, height: innerHeight, bottom: document.querySelector('.app-shell').getBoundingClientRect().bottom })`,
      )) as { width: number; height: number; bottom: number }
      const fullscreenBounds = bag.bridge.win.getContentBounds()
      const scale = screen.getDisplayMatching(fullscreenBounds).scaleFactor
      console.log('desktop-shell-verify-local: fullscreen', {
        fullscreenViewport,
        fullscreenBounds,
        paintedSize,
        scale,
      })
      if (
        Math.abs(fullscreenViewport.width - fullscreenBounds.width) > 1 ||
        Math.abs(fullscreenViewport.height - fullscreenBounds.height) > 1 ||
        Math.abs(fullscreenViewport.bottom - fullscreenViewport.height) > 1 ||
        Math.abs(paintedSize.width - fullscreenBounds.width * scale) > 1 ||
        Math.abs(paintedSize.height - fullscreenBounds.height * scale) > 1
      ) {
        throw new Error('全屏结束时页面或绘制帧未与原生窗口对齐。')
      }
      await new Promise<void>(resolve => {
        bag.bridge.win.once('leave-full-screen', () => resolve())
        bag.bridge.win.setFullScreen(false)
      })
    } finally {
      if (!bag.bridge.win.isDestroyed()) bag.bridge.win.webContents.endFrameSubscription()
    }
  }
  bag.bridge.win.setSize(1_440, 900)
  await waitForWindowSize(bag.bridge.win, 1_440, 900)
  bag.largeLayoutStable = (await bag.bridge.win.webContents.executeJavaScript(
    SETTINGS_SCRIPT_26,
  )) as boolean
  bag.largeCapture = 'verify-large.png'
  writeFileSync(
    bag.bridge.artifactPath(bag.largeCapture),
    (await captureVerifiedPage(bag.bridge.win)).toPNG(),
  )
  await clickTrustedElement(bag.bridge.win, '#open-settings')
  await bag.verifySettingsHeader()
  writeFileSync(
    bag.bridge.artifactPath('verify-settings-large.png'),
    (await captureVerifiedPage(bag.bridge.win)).toPNG(),
  )
  await clickTrustedElement(bag.bridge.win, '.settings-dialog button[aria-label="关闭设置"]')
}

/** 执行 settings 验收套件第 11 阶段。 */
export async function runSettingsStep11(bag: LocalVerifyState): Promise<void> {
  await bag.waitForSettingsClosed()
  await dragTrustedElementHorizontally(bag.bridge.win, '.panel-divider--information', -220)
  bag.wideInformationResizable = (await bag.bridge.win.webContents.executeJavaScript(
    SETTINGS_SCRIPT_27,
  )) as boolean
  bag.bridge.win.setSize(1_200, 760)
  await waitForWindowSize(bag.bridge.win, 1_200, 760)
  bag.mediumToolbarCompact = (await bag.bridge.win.webContents.executeJavaScript(
    SETTINGS_SCRIPT_28,
  )) as boolean
  bag.bridge.win.setSize(1_440, 900)
  await waitForWindowSize(bag.bridge.win, 1_440, 900)
  await bag.bridge.win.webContents.executeJavaScript(`(() => {
      const divider = document.querySelector('.panel-divider--information')
      if (!(divider instanceof HTMLElement)) return false
      divider.focus()
      return divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    })()`)
  bag.mediumToolbarReset = (await bag.bridge.win.webContents.executeJavaScript(
    SETTINGS_SCRIPT_29,
  )) as boolean
  bag.mediumToolbarStable =
    bag.wideInformationResizable && bag.mediumToolbarCompact && bag.mediumToolbarReset
  console.log('desktop-shell-verify-local: medium-toolbar', {
    wideInformationResizable: bag.wideInformationResizable,
    mediumToolbarCompact: bag.mediumToolbarCompact,
    mediumToolbarReset: bag.mediumToolbarReset,
  })
  // 归档验收可能换过当前会话：给当前会话补一份读数，窄窗口才有可验收的读数行。
  bag.readingsSessionId = (await bag.bridge.win.webContents.executeJavaScript(
    `document.querySelector('.work-tab-panel:not([hidden]) .composer-card')?.dataset.sessionId ?? null`,
  )) as string | null
  if (bag.readingsSessionId !== null)
    await seedComposerReadings(bag.bridge.win, bag.readingsSessionId, frame => {
      bag.bridge.win.webContents.send(bag.bridge.hostChannels.sessionFrame, frame)
    })
  bag.bridge.win.setSize(900, 600)
  await waitForWindowSize(bag.bridge.win, 900, 600)
  bag.narrowRightPanelHidden = (await bag.bridge.win.webContents.executeJavaScript(
    SETTINGS_SCRIPT_30,
  )) as boolean
  console.log('desktop-shell-verify-local: narrow-right-panel', {
    narrowRightPanelHidden: bag.narrowRightPanelHidden,
  })
  writeFileSync(
    bag.bridge.artifactPath('verify-narrow-right-hidden.png'),
    (await captureVerifiedPage(bag.bridge.win)).toPNG(),
  )
  await clickTrustedElement(bag.bridge.win, '[aria-label="打开命令与 Skill"]')
  await clickTrustedElement(bag.bridge.win, '[id="命令候选-category:skill"]')
  bag.narrowPickerReady = (await bag.bridge.win.webContents.executeJavaScript(
    SETTINGS_SCRIPT_31,
  )) as boolean
  if (!bag.narrowPickerReady) throw new Error('窄窗口 Skill 面板没有保持边界、搜索焦点和滚动区域')
  writeFileSync(
    bag.bridge.artifactPath('verify-skill-picker-light.png'),
    (await captureVerifiedPage(bag.bridge.win)).toPNG(),
  )
  bag.pickerTheme = nativeTheme.themeSource
}

/** 执行 settings 验收套件第 12 阶段。 */
export async function runSettingsStep12(bag: LocalVerifyState): Promise<void> {
  try {
    nativeTheme.themeSource = 'dark'
    await waitForNativeTheme(bag.bridge.win, 'dark')
    writeFileSync(
      bag.bridge.artifactPath('verify-skill-picker-dark.png'),
      (await captureVerifiedPage(bag.bridge.win)).toPNG(),
    )
  } finally {
    nativeTheme.themeSource = bag.pickerTheme
    await waitForNativeTheme(bag.bridge.win, nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
  }
  await clickTrustedElement(bag.bridge.win, '[aria-label="关闭候选面板"]')
  bag.narrowSettingsFits = (await bag.bridge.win.webContents.executeJavaScript(
    SETTINGS_SCRIPT_32,
  )) as boolean
  bag.narrowCapture = 'verify-narrow.png'
  await bag.verifySettingsHeader()
  writeFileSync(
    bag.bridge.artifactPath(bag.narrowCapture),
    (await captureVerifiedPage(bag.bridge.win)).toPNG(),
  )
  bag.narrowSettingsClosePresent = (await bag.bridge.win.webContents.executeJavaScript(
    `document.querySelector('.settings-dialog button[aria-label="关闭设置"]') instanceof HTMLButtonElement`,
  )) as boolean
  if (bag.narrowSettingsClosePresent) {
    await clickTrustedElement(bag.bridge.win, '.settings-dialog button[aria-label="关闭设置"]')
    await bag.waitForSettingsClosed()
  }
  bag.bridge.settingsController.publish(
    bag.bridge.settingsStore.update({ canvasTransparency: 0.32 }),
  )
  nativeTheme.themeSource = bag.previousThemeSource
  bag.bridge.win.setSize(1_280, 800)
  await waitForNativeTheme(bag.bridge.win, nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
  await waitForWindowSize(bag.bridge.win, 1_280, 800)
  // 越出视口的浮层会让根元素重新可滚动；外壳必须钉在视口上，且根偏移必须被复位。
  bag.shellPinnedToViewport = (await bag.bridge.win.webContents.executeJavaScript(
    SETTINGS_SCRIPT_33,
  )) as boolean
  console.log('desktop-shell-verify-local: shell-pinned', {
    shellPinnedToViewport: bag.shellPinnedToViewport,
  })
  await bag.bridge.win.webContents.executeJavaScript(`(async () => {
      const divider = document.querySelector('.panel-divider--information')
      divider?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const info = document.querySelector('.info-island')
        if (info instanceof HTMLElement && Math.abs(info.getBoundingClientRect().width - 260) <= 1) return
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    })()`)
  await settleElementAnimations(bag.bridge.win, '.app-shell')
  await openRightVerificationPanel(bag.bridge.win, 'file-outline-tasks')
  bag.rightTabsReady = (await bag.bridge.win.webContents.executeJavaScript(
    SETTINGS_SCRIPT_34,
  )) as boolean
  await openRightVerificationPanel(bag.bridge.win, 'git-history')
  console.log('desktop-shell-verify-local: right-tabs', { rightTabsReady: bag.rightTabsReady })
  if (!bag.rightTabsReady) throw new Error('右侧顶部标签切换、键盘导航或面板保留验收失败')
}
