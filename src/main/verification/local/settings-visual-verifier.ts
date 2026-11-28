/**
 * 无障碍媒体降级、透明画布像素合成、原生圆角裁剪与多尺寸响应式布局验收器。
 */
import { writeFileSync } from 'node:fs'
import { nativeTheme, screen } from 'electron'
import {
  captureVerifiedPage,
  clickTrustedElement,
  dragTrustedElementHorizontally,
  emulateVerificationMedia,
} from '../desktop-verifier.ts'
import { verifyEmptyConversationLayout } from '../empty-conversation-verifier.ts'
import {
  openRightVerificationPanel,
  settleElementAnimations,
  waitForNativeTheme,
  waitForWindowSize,
} from '../host-verify-context.ts'
import { seedComposerReadings } from '../session-projection-fixture.ts'
import {
  assertSettingsDialogHeaderAligned,
  waitForSettingsDialogClosed,
} from './settings-pages-verifier.ts'
import {
  CANVAS_FOLLOW_INTERFACE_PROBE,
  CLEAR_CANVAS_TRANSPARENCY_PROBE,
  DARK_SETTINGS_CONTRAST_PROBE,
  FORCED_COLORS_BORDERS_PROBE,
  LARGE_WINDOW_LAYOUT_PROBE,
  MEDIUM_CANVAS_MATERIAL_PROBE,
  MEDIUM_COMPACT_TOOLBAR_PROBE,
  NARROW_RIGHT_PANEL_HIDDEN_PROBE,
  NARROW_SETTINGS_DIALOG_FITS_PROBE,
  NARROW_SKILL_PICKER_BOUNDS_PROBE,
  REDUCED_TRANSPARENCY_PROBE,
  RESET_INFORMATION_PANEL_WIDTH_PROBE,
  RIGHT_ISLAND_KEYBOARD_TABS_PROBE,
  SHELL_PINNED_TO_VIEWPORT_PROBE,
  WIDE_INFORMATION_PANEL_RESIZE_PROBE,
} from './settings-visual-probes.ts'
import type { LocalVerifyState, MaterialAuditSample } from './state.ts'

function computeExpectedAcrylicClipDimension(
  scale: number,
  clipSpanPx: number,
  isBackgroundVerify: boolean,
  fullSpanDip: number,
): number {
  if (!isBackgroundVerify) return clipSpanPx
  return Math.min(fullSpanDip * scale, clipSpanPx)
}

/** 验证无障碍媒体降级、明暗默认截图及设置对话框深色对比度。 */
export async function verifyAccessibilityAndThemeCaptures(state: LocalVerifyState): Promise<void> {
  state.reducedTransparencyReady = false
  state.forcedColorsReady = false
  if (!state.bridge.win.webContents.debugger.isAttached()) {
    state.bridge.win.webContents.debugger.attach('1.3')
  }
  try {
    await emulateVerificationMedia(state.bridge.win, [
      { name: 'prefers-reduced-transparency', value: 'reduce' },
    ])
    state.reducedTransparencyReady = (await state.bridge.win.webContents.executeJavaScript(
      REDUCED_TRANSPARENCY_PROBE,
    )) as boolean
    await emulateVerificationMedia(state.bridge.win, [{ name: 'forced-colors', value: 'active' }])
    state.forcedColorsReady = (await state.bridge.win.webContents.executeJavaScript(
      FORCED_COLORS_BORDERS_PROBE,
    )) as boolean
  } finally {
    await emulateVerificationMedia(state.bridge.win)
  }
  console.log('desktop-shell-verify-local: accessibility', {
    reducedTransparencyReady: state.reducedTransparencyReady,
    forcedColorsReady: state.forcedColorsReady,
  })
  console.log('desktop-shell-verify-local: captures')

  await state.bridge.win.webContents.executeJavaScript(
    `Promise.race([new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))), new Promise(resolve => setTimeout(resolve, 200))])`,
  )
  await verifyEmptyConversationLayout(state.bridge.win)
  state.defaultCapture = 'verify.png'
  writeFileSync(
    state.bridge.artifactPath(state.defaultCapture),
    (await captureVerifiedPage(state.bridge.win)).toPNG(),
  )

  state.previousThemeSource = nativeTheme.themeSource
  nativeTheme.themeSource = 'dark'
  await waitForNativeTheme(state.bridge.win, 'dark')
  await verifyEmptyConversationLayout(state.bridge.win)
  state.darkCapture = 'verify-dark.png'
  writeFileSync(
    state.bridge.artifactPath(state.darkCapture),
    (await captureVerifiedPage(state.bridge.win)).toPNG(),
  )

  await clickTrustedElement(state.bridge.win, '#open-settings')
  await clickTrustedElement(
    state.bridge.win,
    '.settings-nav__items > [role="menuitem"]:nth-child(2)',
  )
  state.darkSettingsReadable = (await state.bridge.win.webContents.executeJavaScript(
    DARK_SETTINGS_CONTRAST_PROBE,
  )) as boolean
  writeFileSync(
    state.bridge.artifactPath('verify-settings-dark.png'),
    (await captureVerifiedPage(state.bridge.win)).toPNG(),
  )
  await assertSettingsDialogHeaderAligned(state)
  await clickTrustedElement(state.bridge.win, '.settings-dialog button[aria-label="关闭设置"]')
  await waitForSettingsDialogClosed(state)

  nativeTheme.themeSource = 'light'
  await waitForNativeTheme(state.bridge.win, 'light')
  state.bridge.settingsController.publish(
    state.bridge.settingsStore.update({ canvasColorScheme: 'dark' }),
  )
  state.canvasColorSchemeReady = (await state.bridge.win.webContents.executeJavaScript(
    CANVAS_FOLLOW_INTERFACE_PROBE,
  )) as boolean
  state.bridge.settingsController.publish(
    state.bridge.settingsStore.update({ canvasColorScheme: 'follow-interface' }),
  )
  await settleElementAnimations(state.bridge.win, '.app-shell')
}

async function verifyAcrylicCanvasClipProjection(state: LocalVerifyState): Promise<void> {
  const windowClipState = state.bridge.windowController.read()
  const windowClipProjection = (await state.bridge.win.webContents.executeJavaScript(`(() => {
    const bounds = document.body.getBoundingClientRect()
    const style = document.documentElement.style
    return { width: bounds.width, height: bounds.height, scale: devicePixelRatio,
      radius: Number.parseFloat(style.getPropertyValue('--window-clip-radius')),
      right: Number.parseFloat(style.getPropertyValue('--window-clip-right')),
      bottom: Number.parseFloat(style.getPropertyValue('--window-clip-bottom')) }
  })()`)) as {
    width: number
    height: number
    scale: number
    radius: number
    right: number
    bottom: number
  }
  if (process.platform !== 'win32' || windowClipState.canvasComposition !== 'acrylic') {
    state.nativeWindowClipReady = true
    return
  }
  if (windowClipState.canvasClip === undefined) {
    state.nativeWindowClipReady = false
    return
  }
  const expectedWidth = computeExpectedAcrylicClipDimension(
    windowClipProjection.scale,
    windowClipState.canvasClip.width,
    state.bridge.verifyBackground,
    windowClipProjection.width,
  )
  const expectedHeight = computeExpectedAcrylicClipDimension(
    windowClipProjection.scale,
    windowClipState.canvasClip.height,
    state.bridge.verifyBackground,
    windowClipProjection.height,
  )
  state.nativeWindowClipReady =
    Math.abs(
      windowClipProjection.radius * windowClipProjection.scale - windowClipState.canvasClip.radius,
    ) < 0.1 &&
    Math.abs(
      (windowClipProjection.width - windowClipProjection.right) * windowClipProjection.scale -
        expectedWidth,
    ) < 0.1 &&
    Math.abs(
      (windowClipProjection.height - windowClipProjection.bottom) * windowClipProjection.scale -
        expectedHeight,
    ) < 0.1
}

async function verifyClearCanvasTransparency(
  state: LocalVerifyState,
  hasNativeMaterialBackdrop: boolean,
): Promise<void> {
  state.bridge.settingsController.publish(
    state.bridge.settingsStore.update({ canvasTransparency: 1 }),
  )
  state.clearCanvas = (await state.bridge.win.webContents.executeJavaScript(
    CLEAR_CANVAS_TRANSPARENCY_PROBE,
  )) as null | Record<string, any>
  state.clearCapture = 'verify-clear.png'
  const clearImage = await captureVerifiedPage(state.bridge.win)
  const clearBitmap = clearImage.toBitmap()
  let transparentPixels = 0
  let minimumCanvasAlpha = 255
  for (let offset = 3; offset < clearBitmap.length; offset += 4) {
    const alpha = clearBitmap[offset] ?? 255
    minimumCanvasAlpha = Math.min(minimumCanvasAlpha, alpha)
    if (alpha > 0 && alpha < 255) transparentPixels += 1
  }
  writeFileSync(state.bridge.artifactPath(state.clearCapture), clearImage.toPNG())
  state.transparentPixelRatio =
    clearBitmap.length === 0 ? 0 : transparentPixels / (clearBitmap.length / 4)
  const clearAlphaValid = hasNativeMaterialBackdrop
    ? Boolean(state.clearCanvas?.transparentRoots) && state.transparentPixelRatio > 0
    : !state.clearCanvas?.transparentRoots && minimumCanvasAlpha === 255
  state.clearCanvasReady =
    state.clearCanvas !== null &&
    Math.abs(Number(state.clearCanvas.canvasAlpha) - 0.68) <= 0.001 &&
    state.clearCanvas.canvasOpacity === '1' &&
    state.clearCanvas.canvasBackgroundImage.includes('radial-gradient') &&
    state.clearCanvas.shellOpacity === '1' &&
    Boolean(state.clearCanvas.islandsKeepOwnOpacity) &&
    Boolean(state.clearCanvas.canvasCoversWindow) &&
    clearAlphaValid
  console.log('desktop-shell-verify-local: clear-canvas', {
    ...state.clearCanvas,
    minimumCanvasAlpha,
    transparentPixelRatio: state.transparentPixelRatio,
    clearCanvasReady: state.clearCanvasReady,
  })
  state.bridge.settingsController.publish(
    state.bridge.settingsStore.update({ canvasTransparency: 0.42 }),
  )
  await settleElementAnimations(state.bridge.win, '.app-shell')
}

function computeBitmapAlphaSummary(bitmap: Buffer): {
  semiTransparentRatio: number
  minimumAlpha: number
} {
  let semiTransparentPixels = 0
  let minimumAlpha = 255
  for (let offset = 3; offset < bitmap.length; offset += 4) {
    const alpha = bitmap[offset] ?? 255
    minimumAlpha = Math.min(minimumAlpha, alpha)
    if (alpha > 0 && alpha < 255) semiTransparentPixels += 1
  }
  const semiTransparentRatio = bitmap.length === 0 ? 0 : semiTransparentPixels / (bitmap.length / 4)
  return { semiTransparentRatio, minimumAlpha }
}

/** 验证径向渐变画布 Alpha 分布、三浮岛实色像素与原生窗口圆角状态。 */
export async function verifyCanvasMaterialAndWindowComposition(
  state: LocalVerifyState,
): Promise<void> {
  state.bridge.settingsController.publish(
    state.bridge.settingsStore.update({
      canvasTransparency: 0.42,
      contentScrimOpacity: 0.82,
    }),
  )
  state.material = (await state.bridge.win.webContents.executeJavaScript(
    MEDIUM_CANVAS_MATERIAL_PROBE,
  )) as MaterialAuditSample | null

  state.materialCapture = 'verify-material.png'
  const materialImage = await captureVerifiedPage(state.bridge.win)
  writeFileSync(state.bridge.artifactPath(state.materialCapture), materialImage.toPNG())
  const materialBitmap = materialImage.toBitmap()
  const { semiTransparentRatio: semiTransparentPixelRatio, minimumAlpha: materialMinimumAlpha } =
    computeBitmapAlphaSummary(materialBitmap)
  const captureSize = materialImage.getSize()
  state.sampleMaterialAlpha = (point: { x: number; y: number }): number => {
    const viewport = state.material?.viewport ?? { width: 1, height: 1 }
    const x = Math.min(
      captureSize.width - 1,
      Math.max(0, Math.floor((point.x * captureSize.width) / viewport.width)),
    )
    const y = Math.min(
      captureSize.height - 1,
      Math.max(0, Math.floor((point.y * captureSize.height) / viewport.height)),
    )
    return materialBitmap[(y * captureSize.width + x) * 4 + 3] ?? 255
  }

  const nativeIslandsOpaque =
    state.material !== null &&
    state.material.opaquePoints.every(point => state.sampleMaterialAlpha(point) === 255)
  const edgeAlphas =
    state.material === null ? [] : state.material.edgePoints.map(state.sampleMaterialAlpha)
  const minEdgeAlpha = edgeAlphas.length === 0 ? 255 : Math.min(...edgeAlphas)
  const centerGapAlpha =
    state.material?.centerGapPoint === null || state.material === null
      ? null
      : state.sampleMaterialAlpha(state.material.centerGapPoint)
  const radialTransparencyReady =
    minEdgeAlpha > 0 &&
    minEdgeAlpha < 232 &&
    centerGapAlpha !== null &&
    centerGapAlpha >= 245 &&
    centerGapAlpha > minEdgeAlpha + 25
  const hasNativeMaterialBackdrop =
    state.bridge.nativeTransparency ||
    ['mica', 'acrylic'].includes(state.bridge.windowController.read().canvasComposition)
  const mediumAlphaValid = hasNativeMaterialBackdrop
    ? semiTransparentPixelRatio > 0 && semiTransparentPixelRatio < 0.25 && radialTransparencyReady
    : materialBitmap.length > 0 && materialMinimumAlpha === 255
  state.mediumCanvasReady =
    state.material !== null &&
    nativeIslandsOpaque &&
    state.material.canvasImage === 'none' &&
    state.material.canvasOpacity === '1' &&
    state.material.canvasBackgroundImage.includes('radial-gradient') &&
    mediumAlphaValid

  await verifyAcrylicCanvasClipProjection(state)
  console.log('desktop-shell-verify-local: medium-canvas', {
    canvasOpacity: state.material?.canvasOpacity,
    semiTransparentPixelRatio,
    minEdgeAlpha,
    centerGapAlpha,
    radialTransparencyReady,
    nativeIslandsOpaque,
    mediumCanvasReady: state.mediumCanvasReady,
    nativeWindowClipReady: state.nativeWindowClipReady,
  })
  await verifyClearCanvasTransparency(state, hasNativeMaterialBackdrop)
}

async function verifyMacFullscreenIfForeground(state: LocalVerifyState): Promise<void> {
  if (process.platform !== 'darwin' || state.bridge.verifyBackground) return
  const paintedSize = { width: 0, height: 0 }
  state.bridge.win.webContents.beginFrameSubscription(image => {
    Object.assign(paintedSize, image.getSize())
  })
  try {
    await new Promise<void>(resolve => {
      state.bridge.win.once('enter-full-screen', () => resolve())
      state.bridge.win.setFullScreen(true)
    })
    const fullscreenViewport = (await state.bridge.win.webContents.executeJavaScript(
      `({ width: innerWidth, height: innerHeight, bottom: document.querySelector('.app-shell').getBoundingClientRect().bottom })`,
    )) as { width: number; height: number; bottom: number }
    const fullscreenBounds = state.bridge.win.getContentBounds()
    const scale = screen.getDisplayMatching(fullscreenBounds).scaleFactor
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
      state.bridge.win.once('leave-full-screen', () => resolve())
      state.bridge.win.setFullScreen(false)
    })
  } finally {
    if (!state.bridge.win.isDestroyed()) state.bridge.win.webContents.endFrameSubscription()
  }
}

async function verifyLargeAndMediumResponsiveLayouts(state: LocalVerifyState): Promise<void> {
  await verifyMacFullscreenIfForeground(state)

  state.bridge.win.setSize(1_440, 900)
  await waitForWindowSize(state.bridge.win, 1_440, 900)
  state.largeLayoutStable = (await state.bridge.win.webContents.executeJavaScript(
    LARGE_WINDOW_LAYOUT_PROBE,
  )) as boolean
  state.largeCapture = 'verify-large.png'
  writeFileSync(
    state.bridge.artifactPath(state.largeCapture),
    (await captureVerifiedPage(state.bridge.win)).toPNG(),
  )
  await clickTrustedElement(state.bridge.win, '#open-settings')
  await assertSettingsDialogHeaderAligned(state)
  writeFileSync(
    state.bridge.artifactPath('verify-settings-large.png'),
    (await captureVerifiedPage(state.bridge.win)).toPNG(),
  )
  await clickTrustedElement(state.bridge.win, '.settings-dialog button[aria-label="关闭设置"]')
  await waitForSettingsDialogClosed(state)

  await dragTrustedElementHorizontally(state.bridge.win, '.panel-divider--information', -220)
  const wideInformationResizable = (await state.bridge.win.webContents.executeJavaScript(
    WIDE_INFORMATION_PANEL_RESIZE_PROBE,
  )) as boolean
  state.bridge.win.setSize(1_200, 760)
  await waitForWindowSize(state.bridge.win, 1_200, 760)
  const mediumToolbarCompact = (await state.bridge.win.webContents.executeJavaScript(
    MEDIUM_COMPACT_TOOLBAR_PROBE,
  )) as boolean
  state.bridge.win.setSize(1_440, 900)
  await waitForWindowSize(state.bridge.win, 1_440, 900)
  await state.bridge.win.webContents.executeJavaScript(`(() => {
    const divider = document.querySelector('.panel-divider--information')
    if (!(divider instanceof HTMLElement)) return false
    divider.focus()
    return divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
  })()`)
  const mediumToolbarReset = (await state.bridge.win.webContents.executeJavaScript(
    RESET_INFORMATION_PANEL_WIDTH_PROBE,
  )) as boolean
  state.mediumToolbarStable = wideInformationResizable && mediumToolbarCompact && mediumToolbarReset
  console.log('desktop-shell-verify-local: medium-toolbar', {
    wideInformationResizable,
    mediumToolbarCompact,
    mediumToolbarReset,
  })
}

async function verifyNarrowViewportAndRightIslandTabs(state: LocalVerifyState): Promise<void> {
  const readingsSessionId = (await state.bridge.win.webContents.executeJavaScript(
    `document.querySelector('.work-tab-panel:not([hidden]) .composer-card')?.dataset.sessionId ?? null`,
  )) as string | null
  if (readingsSessionId !== null) {
    await seedComposerReadings(state.bridge.win, readingsSessionId, frame => {
      state.bridge.win.webContents.send(state.bridge.hostChannels.sessionFrame, frame)
    })
  }
  state.bridge.win.setSize(900, 600)
  await waitForWindowSize(state.bridge.win, 900, 600)
  state.narrowRightPanelHidden = (await state.bridge.win.webContents.executeJavaScript(
    NARROW_RIGHT_PANEL_HIDDEN_PROBE,
  )) as boolean
  console.log('desktop-shell-verify-local: narrow-right-panel', {
    narrowRightPanelHidden: state.narrowRightPanelHidden,
  })
  writeFileSync(
    state.bridge.artifactPath('verify-narrow-right-hidden.png'),
    (await captureVerifiedPage(state.bridge.win)).toPNG(),
  )

  await clickTrustedElement(state.bridge.win, '[aria-label="打开命令与 Skill"]')
  await clickTrustedElement(state.bridge.win, '[id="命令候选-category:skill"]')
  const narrowPickerReady = (await state.bridge.win.webContents.executeJavaScript(
    NARROW_SKILL_PICKER_BOUNDS_PROBE,
  )) as boolean
  if (!narrowPickerReady) throw new Error('窄窗口 Skill 面板没有保持边界、搜索焦点和滚动区域')
  writeFileSync(
    state.bridge.artifactPath('verify-skill-picker-light.png'),
    (await captureVerifiedPage(state.bridge.win)).toPNG(),
  )
  const pickerTheme = nativeTheme.themeSource
  try {
    nativeTheme.themeSource = 'dark'
    await waitForNativeTheme(state.bridge.win, 'dark')
    writeFileSync(
      state.bridge.artifactPath('verify-skill-picker-dark.png'),
      (await captureVerifiedPage(state.bridge.win)).toPNG(),
    )
  } finally {
    nativeTheme.themeSource = pickerTheme
    await waitForNativeTheme(state.bridge.win, nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
  }
  await clickTrustedElement(state.bridge.win, '[aria-label="关闭候选面板"]')

  state.narrowSettingsFits = (await state.bridge.win.webContents.executeJavaScript(
    NARROW_SETTINGS_DIALOG_FITS_PROBE,
  )) as boolean
  state.narrowCapture = 'verify-narrow.png'
  await assertSettingsDialogHeaderAligned(state)
  writeFileSync(
    state.bridge.artifactPath(state.narrowCapture),
    (await captureVerifiedPage(state.bridge.win)).toPNG(),
  )
  const narrowSettingsClosePresent = (await state.bridge.win.webContents.executeJavaScript(
    `document.querySelector('.settings-dialog button[aria-label="关闭设置"]') instanceof HTMLButtonElement`,
  )) as boolean
  if (narrowSettingsClosePresent) {
    await clickTrustedElement(state.bridge.win, '.settings-dialog button[aria-label="关闭设置"]')
    await waitForSettingsDialogClosed(state)
  }
  await restoreStandardViewportAndVerifyRightTabs(state)
}

async function restoreStandardViewportAndVerifyRightTabs(state: LocalVerifyState): Promise<void> {
  state.bridge.settingsController.publish(
    state.bridge.settingsStore.update({ canvasTransparency: 0.32 }),
  )
  nativeTheme.themeSource = state.previousThemeSource
  state.bridge.win.setSize(1_280, 800)
  await waitForNativeTheme(state.bridge.win, nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
  await waitForWindowSize(state.bridge.win, 1_280, 800)
  state.shellPinnedToViewport = (await state.bridge.win.webContents.executeJavaScript(
    SHELL_PINNED_TO_VIEWPORT_PROBE,
  )) as boolean
  console.log('desktop-shell-verify-local: shell-pinned', {
    shellPinnedToViewport: state.shellPinnedToViewport,
  })

  await state.bridge.win.webContents.executeJavaScript(`(async () => {
    const divider = document.querySelector('.panel-divider--information')
    divider?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const info = document.querySelector('.info-island')
      if (info instanceof HTMLElement && Math.abs(info.getBoundingClientRect().width - 260) <= 1) return
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  })()`)
  await settleElementAnimations(state.bridge.win, '.app-shell')
  await openRightVerificationPanel(state.bridge.win, 'file-outline-tasks')
  state.rightTabsReady = (await state.bridge.win.webContents.executeJavaScript(
    RIGHT_ISLAND_KEYBOARD_TABS_PROBE,
  )) as boolean
  await openRightVerificationPanel(state.bridge.win, 'git-history')
  console.log('desktop-shell-verify-local: right-tabs', { rightTabsReady: state.rightTabsReady })
  if (!state.rightTabsReady) throw new Error('右侧顶部标签切换、键盘导航或面板保留验收失败')
}

/** 验证大窗口（1440×900）、中窗口（1200×760）、窄窗口（900×600）响应式收敛及右侧标签导航。 */
export async function verifyMultiSizeResponsiveAndRightTabs(
  state: LocalVerifyState,
): Promise<void> {
  await verifyLargeAndMediumResponsiveLayouts(state)
  await verifyNarrowViewportAndRightIslandTabs(state)
}
