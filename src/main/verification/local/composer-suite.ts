/**
 * 输入区命令面板、文件引用、附件拖拽、审批弹窗与字号对比度验收套件。
 */
import { writeFileSync } from 'node:fs'
import { app } from 'electron'
import { callDshHost } from '../../host/host-client.ts'
import { focusPrimaryWindow } from '../../lifecycle/app-lifecycle.ts'
import { verifyComposerLayout } from '../composer-layout-verifier.ts'
import { captureVerifiedPage } from '../desktop-verifier.ts'
import { waitForColorScheme, waitForCondition } from '../host-verify-context.ts'
import { verifyPermissionDialog } from '../plan-review-verifier.ts'
import {
  COMMAND_AND_SKILL_PALETTE_PROBE,
  FILE_REFERENCE_PALETTE_PROBE,
  IMAGE_DROP_AND_PASTE_PROBE,
  SLASH_COMMAND_EXECUTION_PROBE,
} from './composer-palettes-probes.ts'
import {
  DARK_ACTION_ERROR_TOAST_PROBE,
  DISMISS_ACTION_ERROR_TOAST_PROBE,
  LIGHT_ACTION_ERROR_SURFACE_PROBE,
  PERMISSION_MODE_MENU_PROBE,
  buildFontScaleProbe,
} from './composer-permissions-probes.ts'
import { assertSuiteInvariants, type LocalVerifyState } from './state.ts'

async function verifyModeRailFocusTooltipAndHostEvents(state: LocalVerifyState): Promise<void> {
  if (!state.bridge.verifyBackground) {
    app.focus({ steal: true })
    focusPrimaryWindow(state.bridge.win)
    state.bridge.win.webContents.focus()
    await waitForCondition(
      () => state.bridge.win.isFocused() && state.bridge.win.webContents.isFocused(),
      1_000,
    )
  }
  await state.bridge.win.webContents.executeJavaScript(`(async () => {
    const trigger = document.querySelector('.session-search-trigger')
    if (!(trigger instanceof HTMLElement)) return
    trigger.focus()
    for (let attempt = 0; attempt < 40 && document.activeElement !== trigger; attempt += 1) {
      trigger.focus()
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  })()`)
  state.bridge.win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
  state.bridge.win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
  state.modeTooltipReady = (await state.bridge.win.webContents.executeJavaScript(`(async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const tooltip = [...document.querySelectorAll('[role="tooltip"]')].find(element => element.textContent === '对话')
      const rect = tooltip?.getBoundingClientRect()
      if (document.activeElement?.getAttribute('data-view') === 'conversation'
        && rect !== undefined && rect.width > 0 && rect.left >= 48 && rect.right <= innerWidth) return true
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return false
  })()`)) as boolean
  if (!state.modeTooltipReady) {
    const tooltipState = await state.bridge.win.webContents.executeJavaScript(`({
      focused: document.activeElement?.outerHTML?.slice(0, 240),
      tooltips: [...document.querySelectorAll('[role="tooltip"]')].map(element => ({ text: element.textContent, rect: element.getBoundingClientRect().toJSON() })),
    })`)
    throw new Error(`纯图标模式按钮未显示完整的焦点提示：${JSON.stringify(tooltipState)}`)
  }
  writeFileSync(
    state.bridge.artifactPath('verify-mode-tooltip.png'),
    (await captureVerifiedPage(state.bridge.win)).toPNG(),
  )
  await state.bridge.win.webContents.executeJavaScript('document.activeElement?.blur()')
  console.log('desktop-shell-verify-local: mode-tooltip', state.modeTooltipReady)

  const currentHost = state.bridge.getCurrentHost()
  if (currentHost === undefined) throw new Error('Host 事件流验收时 Host 已离线')
  await callDshHost(
    state.bridge.targetUrl,
    'createSession',
    { cwd: state.bridge.verifyProject ?? process.cwd() },
    state.bridge.fetch,
    currentHost.sessionCookie,
  )
  if (!(await waitForCondition(() => state.bridge.isHostEventStreamFrameObserved(), 2_000))) {
    throw new Error('没有观察到公开 $events 的 Session 生命周期帧')
  }
  await new Promise(resolve => {
    setTimeout(resolve, 100)
  })
}

async function verifyComposerPalettesAndAttachments(state: LocalVerifyState): Promise<void> {
  state.commandPaletteAudit = (await state.bridge.win.webContents.executeJavaScript(
    COMMAND_AND_SKILL_PALETTE_PROBE,
  )) as {
    ready: boolean
    optionCount?: number
    portal?: boolean
    ariaReady?: boolean
    closedAfterClear?: boolean
    bridgeVersion?: number
    reason?: string
  }
  console.log('desktop-shell-verify-local: command-picker', state.commandPaletteAudit)
  if (!state.commandPaletteAudit.ready) {
    throw new Error(`命令与 Skill 面板验收失败：${JSON.stringify(state.commandPaletteAudit)}`)
  }

  state.fileReferenceAudit = (await state.bridge.win.webContents.executeJavaScript(
    FILE_REFERENCE_PALETTE_PROBE,
  )) as {
    ready: boolean
    optionCount?: number
    error?: string
    closedAfterClear?: boolean
    reason?: string
  }
  if (!state.fileReferenceAudit.ready || state.fileReferenceAudit.closedAfterClear !== true) {
    throw new Error(
      `真实文件引用验收失败：${
        state.fileReferenceAudit.error ??
        state.fileReferenceAudit.reason ??
        'Host 候选或可访问性状态未就绪'
      }`,
    )
  }

  state.attachmentDropAudit = (await state.bridge.win.webContents.executeJavaScript(
    IMAGE_DROP_AND_PASTE_PROBE,
  )) as {
    ready: boolean
    error?: string
  }
  if (!state.attachmentDropAudit.ready) {
    throw new Error(`真实图片拖放与粘贴验收失败：${JSON.stringify(state.attachmentDropAudit)}`)
  }
  state.composerScheme = state.bridge.settingsStore.read().colorScheme
}

async function verifySlashCommandAndPermissionMenu(state: LocalVerifyState): Promise<void> {
  try {
    await verifyComposerLayout(
      state.bridge.win,
      scheme => {
        state.bridge.settingsController.publish(
          state.bridge.settingsStore.update({ colorScheme: scheme }),
        )
      },
      async name => {
        writeFileSync(
          state.bridge.artifactPath(name),
          (await captureVerifiedPage(state.bridge.win)).toPNG(),
        )
      },
    )
  } finally {
    state.bridge.settingsController.publish(
      state.bridge.settingsStore.update({ colorScheme: state.composerScheme }),
    )
  }

  state.lifecycleIdsBeforeExecution = new Set([
    ...state.bridge.commandRunIdsObserved,
    ...state.bridge.commandDoneIdsObserved,
  ])
  state.commandExecutionAudit = (await state.bridge.win.webContents.executeJavaScript(
    SLASH_COMMAND_EXECUTION_PROBE,
  )) as {
    ready: boolean
    stateText?: string
    error?: string
    draftCleared?: boolean
    paletteClosed?: boolean
  }
  if (!state.commandExecutionAudit.ready) {
    throw new Error(
      `真实 Host Command 端到端验收失败：${
        state.commandExecutionAudit.error ||
        state.commandExecutionAudit.stateText ||
        '命令状态未就绪'
      }`,
    )
  }

  state.commandLifecycleReady = await waitForCondition(() => {
    state.observedCommandExecutionId = [...state.bridge.commandRunIdsObserved].find(
      commandId =>
        !state.lifecycleIdsBeforeExecution.has(commandId) &&
        state.bridge.commandDoneIdsObserved.has(commandId),
    )
    return state.observedCommandExecutionId !== undefined
  }, 2_000)
  if (!state.commandLifecycleReady) {
    throw new Error('没有观察到真实 command/run 与 command/done 生命周期')
  }

  state.permissionMenuResult = (await state.bridge.win.webContents.executeJavaScript(
    PERMISSION_MODE_MENU_PROBE,
  )) as { ok: boolean; stage?: string }
  state.permissionMenuReady = state.permissionMenuResult.ok
  if (!state.permissionMenuReady) {
    throw new Error(
      `权限投影、目录、风险确认或取消后的权限保持验收失败：${JSON.stringify(state.permissionMenuResult)}`,
    )
  }
  console.log('desktop-shell-verify-local: permission-menu', state.permissionMenuReady)
}

async function verifyPermissionAndActionErrorToast(state: LocalVerifyState): Promise<void> {
  await verifyPermissionDialog(
    state.bridge.win,
    scheme => {
      state.bridge.settingsController.publish(
        state.bridge.settingsStore.update({ colorScheme: scheme }),
      )
    },
    async name => {
      writeFileSync(
        state.bridge.artifactPath(name),
        (await captureVerifiedPage(state.bridge.win)).toPNG(),
      )
    },
  )

  state.bridge.settingsController.publish(
    state.bridge.settingsStore.update({ colorScheme: 'dark' }),
  )
  await waitForColorScheme(state.bridge.win, 'dark')
  state.actionErrorReady = (await state.bridge.win.webContents.executeJavaScript(
    DARK_ACTION_ERROR_TOAST_PROBE,
  )) as boolean
  writeFileSync(
    state.bridge.artifactPath('verify-action-error-dark.png'),
    (await captureVerifiedPage(state.bridge.win)).toPNG(),
  )
  if (!state.actionErrorReady) throw new Error('操作错误浮层、草稿保留或输入区高度验收失败')

  state.bridge.settingsController.publish(
    state.bridge.settingsStore.update({ colorScheme: 'light' }),
  )
  state.lightActionErrorReady = (await state.bridge.win.webContents.executeJavaScript(
    LIGHT_ACTION_ERROR_SURFACE_PROBE,
  )) as boolean
  if (!state.lightActionErrorReady) throw new Error('浅色主题操作错误提示验收失败')
  writeFileSync(
    state.bridge.artifactPath('verify-action-error-light.png'),
    (await captureVerifiedPage(state.bridge.win)).toPNG(),
  )

  state.actionErrorClosed = (await state.bridge.win.webContents.executeJavaScript(
    DISMISS_ACTION_ERROR_TOAST_PROBE,
  )) as boolean
  if (!state.actionErrorClosed) throw new Error('操作错误关闭后未正确保留草稿')
  state.bridge.settingsController.publish(
    state.bridge.settingsStore.update({ colorScheme: state.presentationScheme }),
  )
  await waitForColorScheme(state.bridge.win, state.presentationScheme)
  console.log(
    'desktop-shell-verify-local: action-error-toast',
    state.actionErrorReady && state.actionErrorClosed,
  )
}

async function verifyFontScaleAndAccentContrast(state: LocalVerifyState): Promise<void> {
  const verifyFontScale = async (fontSize: 11 | 18): Promise<boolean> => {
    state.bridge.settingsController.publish(state.bridge.settingsStore.update({ fontSize }))
    return state.bridge.win.webContents.executeJavaScript(
      buildFontScaleProbe(fontSize),
    ) as Promise<boolean>
  }
  state.compactFontReady = await verifyFontScale(11)
  state.largeFontReady = await verifyFontScale(18)
  state.bridge.settingsController.publish(state.bridge.settingsStore.update({ fontSize: 12 }))
  await state.bridge.win.webContents.executeJavaScript(`(async () => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (document.documentElement.style.getPropertyValue('--text-body').trim() === '12px') break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  })()`)

  state.bridge.settingsController.publish(
    state.bridge.settingsStore.update({ accentColor: '#ffffff' }),
  )
  state.lightAccentReady = (await state.bridge.win.webContents.executeJavaScript(`(async () => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (document.documentElement.style.getPropertyValue('--accent-contrast').trim() === '#000000') return true
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return false
  })()`)) as boolean

  state.bridge.settingsController.publish(
    state.bridge.settingsStore.update({ accentColor: '#000000' }),
  )
  state.darkAccentReady = (await state.bridge.win.webContents.executeJavaScript(`(async () => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (document.documentElement.style.getPropertyValue('--accent-contrast').trim() === '#ffffff') return true
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return false
  })()`)) as boolean

  state.bridge.settingsController.publish(
    state.bridge.settingsStore.update({ accentColor: '#4d6bfe' }),
  )
  await state.bridge.win.webContents.executeJavaScript(`(async () => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (document.documentElement.style.getPropertyValue('--accent').trim().toLowerCase() === '#4d6bfe') break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  })()`)
  state.fontScaleReady = state.compactFontReady && state.largeFontReady
  state.accentContrastReady = state.lightAccentReady && state.darkAccentReady
}

/** 运行 composer 验收套件。 */
export async function runComposerSuite(state: LocalVerifyState): Promise<void> {
  await verifyModeRailFocusTooltipAndHostEvents(state)
  await verifyComposerPalettesAndAttachments(state)
  await verifySlashCommandAndPermissionMenu(state)
  await verifyPermissionAndActionErrorToast(state)
  await verifyFontScaleAndAccentContrast(state)
  assertSuiteInvariants('composer', state)
}
