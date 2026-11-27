/**
 * 输入区命令面板、文件引用、附件拖拽、审批弹窗与字号对比度验收套件。
 */
import { writeFileSync } from 'node:fs'
import { app } from 'electron'
import { focusPrimaryWindow } from '../../lifecycle/app-lifecycle.ts'
import { callDshHost } from '../../host/host-client.ts'
import { waitForColorScheme, waitForCondition } from '../host-verify-context.ts'
import { captureVerifiedPage } from '../desktop-verifier.ts'
import { verifyPermissionDialog } from '../plan-review-verifier.ts'
import { verifyComposerLayout } from '../composer-layout-verifier.ts'
import { type LocalVerifyState, assertSuiteInvariants } from './state.ts'
import {
  COMPOSER_SCRIPT_1,
  COMPOSER_SCRIPT_2,
  COMPOSER_SCRIPT_3,
  COMPOSER_SCRIPT_4,
} from './composer-scripts-1.ts'
import {
  COMPOSER_SCRIPT_5,
  COMPOSER_SCRIPT_6,
  COMPOSER_SCRIPT_7,
  COMPOSER_SCRIPT_8,
  buildComposerScript9,
} from './composer-scripts-2.ts'

/** 执行 composer 验收套件第 1 阶段。 */
export async function runComposerStep1(bag: LocalVerifyState): Promise<void> {
  // 打包窗口在系统指针位于外部时会清除合成 hover；用原生 Tab 验证提示与键盘可达性。
  if (!bag.bridge.verifyBackground) {
    app.focus({ steal: true })
    focusPrimaryWindow(bag.bridge.win)
    bag.bridge.win.webContents.focus()
    await waitForCondition(
      () => bag.bridge.win.isFocused() && bag.bridge.win.webContents.isFocused(),
      1_000,
    )
  }
  await bag.bridge.win.webContents.executeJavaScript(`(async () => {
      const trigger = document.querySelector('.session-search-trigger')
      if (!(trigger instanceof HTMLElement)) return
      trigger.focus()
      for (let attempt = 0; attempt < 40 && document.activeElement !== trigger; attempt += 1) {
        trigger.focus()
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    })()`)
  bag.bridge.win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
  bag.bridge.win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
  bag.modeTooltipReady = (await bag.bridge.win.webContents.executeJavaScript(`(async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const tooltip = [...document.querySelectorAll('[role="tooltip"]')].find(element => element.textContent === '对话')
        const rect = tooltip?.getBoundingClientRect()
        if (document.activeElement?.getAttribute('data-view') === 'conversation'
          && rect !== undefined && rect.width > 0 && rect.left >= 48 && rect.right <= innerWidth) return true
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return false
    })()`)) as boolean
  if (!bag.modeTooltipReady) {
    const tooltipState = await bag.bridge.win.webContents.executeJavaScript(`({
        focused: document.activeElement?.outerHTML?.slice(0, 240),
        tooltips: [...document.querySelectorAll('[role="tooltip"]')].map(element => ({ text: element.textContent, rect: element.getBoundingClientRect().toJSON() })),
      })`)
    throw new Error(`纯图标模式按钮未显示完整的焦点提示：${JSON.stringify(tooltipState)}`)
  }
  writeFileSync(
    bag.bridge.artifactPath('verify-mode-tooltip.png'),
    (await captureVerifiedPage(bag.bridge.win)).toPNG(),
  )
  await bag.bridge.win.webContents.executeJavaScript('document.activeElement?.blur()')
  console.log('desktop-shell-verify-local: mode-tooltip', bag.modeTooltipReady)
  if (bag.bridge.getCurrentHost() === undefined) throw new Error('Host 事件流验收时 Host 已离线')
  await callDshHost(
    bag.bridge.targetUrl,
    'createSession',
    { cwd: bag.bridge.verifyProject ?? process.cwd() },
    bag.bridge.fetch,
    bag.bridge.getCurrentHost()!.sessionCookie,
  )
}

/** 执行 composer 验收套件第 2 阶段。 */
export async function runComposerStep2(bag: LocalVerifyState): Promise<void> {
  if (!(await waitForCondition(() => bag.bridge.isHostEventStreamFrameObserved(), 2_000))) {
    throw new Error('没有观察到公开 $events 的 Session 生命周期帧')
  }
  await new Promise(resolve => {
    setTimeout(resolve, 100)
  })
  bag.commandPaletteAudit = (await bag.bridge.win.webContents.executeJavaScript(
    COMPOSER_SCRIPT_1,
  )) as {
    ready: boolean
    optionCount?: number
    portal?: boolean
    ariaReady?: boolean
    closedAfterClear?: boolean
    bridgeVersion?: number
    reason?: string
  }
  console.log('desktop-shell-verify-local: command-picker', bag.commandPaletteAudit)
  if (!bag.commandPaletteAudit.ready) {
    throw new Error(`命令与 Skill 面板验收失败：${JSON.stringify(bag.commandPaletteAudit)}`)
  }
  bag.fileReferenceAudit = (await bag.bridge.win.webContents.executeJavaScript(
    COMPOSER_SCRIPT_2,
  )) as {
    ready: boolean
    optionCount?: number
    error?: string
    closedAfterClear?: boolean
    reason?: string
  }
  if (!bag.fileReferenceAudit.ready || bag.fileReferenceAudit.closedAfterClear !== true) {
    throw new Error(
      `真实文件引用验收失败：${
        bag.fileReferenceAudit.error ??
        bag.fileReferenceAudit.reason ??
        'Host 候选或可访问性状态未就绪'
      }`,
    )
  }
  bag.attachmentDropAudit = (await bag.bridge.win.webContents.executeJavaScript(
    COMPOSER_SCRIPT_3,
  )) as {
    ready: boolean
    dragEnterPrevented?: boolean
    dropPrevented?: boolean
    overlayVisible?: boolean
    attachmentVisible?: boolean
    removed?: boolean
    error?: string
  }
  if (!bag.attachmentDropAudit.ready) {
    throw new Error(`真实图片拖放与粘贴验收失败：${JSON.stringify(bag.attachmentDropAudit)}`)
  }
  bag.composerScheme = bag.bridge.settingsStore.read().colorScheme
}

/** 执行 composer 验收套件第 3 阶段。 */
export async function runComposerStep3(bag: LocalVerifyState): Promise<void> {
  try {
    await verifyComposerLayout(
      bag.bridge.win,
      scheme => {
        bag.bridge.settingsController.publish(
          bag.bridge.settingsStore.update({ colorScheme: scheme }),
        )
      },
      async name => {
        writeFileSync(
          bag.bridge.artifactPath(name),
          (await captureVerifiedPage(bag.bridge.win)).toPNG(),
        )
      },
    )
  } finally {
    bag.bridge.settingsController.publish(
      bag.bridge.settingsStore.update({ colorScheme: bag.composerScheme }),
    )
  }
  bag.lifecycleIdsBeforeExecution = new Set([
    ...bag.bridge.commandRunIdsObserved,
    ...bag.bridge.commandDoneIdsObserved,
  ])
  bag.commandExecutionAudit = (await bag.bridge.win.webContents.executeJavaScript(
    COMPOSER_SCRIPT_4,
  )) as {
    ready: boolean
    stateText?: string
    error?: string
    draftCleared?: boolean
    paletteClosed?: boolean
  }
  if (!bag.commandExecutionAudit.ready) {
    throw new Error(
      `真实 Host Command 端到端验收失败：${
        bag.commandExecutionAudit.error || bag.commandExecutionAudit.stateText || '命令状态未就绪'
      }`,
    )
  }

  bag.commandLifecycleReady = await waitForCondition(() => {
    bag.observedCommandExecutionId = [...bag.bridge.commandRunIdsObserved].find(
      commandId =>
        !bag.lifecycleIdsBeforeExecution.has(commandId) &&
        bag.bridge.commandDoneIdsObserved.has(commandId),
    )
    return bag.observedCommandExecutionId !== undefined
  }, 2_000)
  if (!bag.commandLifecycleReady)
    throw new Error('没有观察到真实 command/run 与 command/done 生命周期')
  // 权限菜单退场会经液态形变驻留 inert 节点，且提交完成、pick 清理与权限投影推送异步解耦；
  // 必须等弹窗与退场菜单彻底卸载，再对可见、未禁用且投影已落位的目标项点击。
  bag.permissionMenuResult = (await bag.bridge.win.webContents.executeJavaScript(
    COMPOSER_SCRIPT_5,
  )) as { ok: boolean; stage?: string; [key: string]: unknown }
  bag.permissionMenuReady = bag.permissionMenuResult.ok
  if (!bag.permissionMenuReady)
    throw new Error(
      `权限投影、目录、风险确认或取消后的权限保持验收失败：${JSON.stringify(bag.permissionMenuResult)}`,
    )
  console.log('desktop-shell-verify-local: permission-menu', bag.permissionMenuReady)
}

/** 执行 composer 验收套件第 4 阶段。 */
export async function runComposerStep4(bag: LocalVerifyState): Promise<void> {
  await verifyPermissionDialog(
    bag.bridge.win,
    scheme => {
      bag.bridge.settingsController.publish(
        bag.bridge.settingsStore.update({ colorScheme: scheme }),
      )
    },
    async name => {
      writeFileSync(
        bag.bridge.artifactPath(name),
        (await captureVerifiedPage(bag.bridge.win)).toPNG(),
      )
    },
  )
  bag.bridge.settingsController.publish(bag.bridge.settingsStore.update({ colorScheme: 'dark' }))
  await waitForColorScheme(bag.bridge.win, 'dark')
  bag.actionErrorReady = (await bag.bridge.win.webContents.executeJavaScript(
    COMPOSER_SCRIPT_6,
  )) as boolean
  writeFileSync(
    bag.bridge.artifactPath('verify-action-error-dark.png'),
    (await captureVerifiedPage(bag.bridge.win)).toPNG(),
  )
  if (!bag.actionErrorReady) throw new Error('操作错误浮层、草稿保留或输入区高度验收失败')
  bag.bridge.settingsController.publish(bag.bridge.settingsStore.update({ colorScheme: 'light' }))
  bag.lightActionErrorReady = (await bag.bridge.win.webContents.executeJavaScript(
    COMPOSER_SCRIPT_7,
  )) as boolean
  if (!bag.lightActionErrorReady) throw new Error('浅色主题操作错误提示验收失败')
  writeFileSync(
    bag.bridge.artifactPath('verify-action-error-light.png'),
    (await captureVerifiedPage(bag.bridge.win)).toPNG(),
  )
  bag.actionErrorClosed = (await bag.bridge.win.webContents.executeJavaScript(
    COMPOSER_SCRIPT_8,
  )) as boolean
  if (!bag.actionErrorClosed) throw new Error('操作错误关闭后未正确保留草稿')
  bag.bridge.settingsController.publish(
    bag.bridge.settingsStore.update({ colorScheme: bag.presentationScheme }),
  )
  await waitForColorScheme(bag.bridge.win, bag.presentationScheme)
  console.log(
    'desktop-shell-verify-local: action-error-toast',
    bag.actionErrorReady && bag.actionErrorClosed,
  )
  // 会话信息已不再作为右栏入口，用量明细移到输入区底部的仪表盘（见 docs/renderer.md）。
  bag.verifyFontScale = async (fontSize: 11 | 18): Promise<boolean> => {
    bag.bridge.settingsController.publish(bag.bridge.settingsStore.update({ fontSize }))
    return bag.bridge.win.webContents.executeJavaScript(
      buildComposerScript9(String(fontSize)),
    ) as Promise<boolean>
  }
  bag.compactFontReady = await bag.verifyFontScale(11)
  bag.largeFontReady = await bag.verifyFontScale(18)
  bag.bridge.settingsController.publish(bag.bridge.settingsStore.update({ fontSize: 12 }))
  await bag.bridge.win.webContents.executeJavaScript(`(async () => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (document.documentElement.style.getPropertyValue('--text-body').trim() === '12px') break
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    })()`)
  bag.bridge.settingsController.publish(bag.bridge.settingsStore.update({ accentColor: '#ffffff' }))
}

/** 执行 composer 验收套件第 5 阶段。 */
export async function runComposerStep5(bag: LocalVerifyState): Promise<void> {
  bag.lightAccentReady = (await bag.bridge.win.webContents.executeJavaScript(`(async () => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (document.documentElement.style.getPropertyValue('--accent-contrast').trim() === '#000000') return true
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return false
    })()`)) as boolean
  bag.bridge.settingsController.publish(bag.bridge.settingsStore.update({ accentColor: '#000000' }))
  bag.darkAccentReady = (await bag.bridge.win.webContents.executeJavaScript(`(async () => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (document.documentElement.style.getPropertyValue('--accent-contrast').trim() === '#ffffff') return true
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return false
    })()`)) as boolean
  bag.bridge.settingsController.publish(bag.bridge.settingsStore.update({ accentColor: '#4d6bfe' }))
  await bag.bridge.win.webContents.executeJavaScript(`(async () => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (document.documentElement.style.getPropertyValue('--accent').trim().toLowerCase() === '#4d6bfe') break
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    })()`)
  bag.fontScaleReady = bag.compactFontReady && bag.largeFontReady
  bag.accentContrastReady = bag.lightAccentReady && bag.darkAccentReady
}

/** 运行 composer 验收套件。 */
export async function runComposerSuite(bag: LocalVerifyState): Promise<void> {
  await runComposerStep1(bag)
  await runComposerStep2(bag)
  await runComposerStep3(bag)
  await runComposerStep4(bag)
  await runComposerStep5(bag)
  assertSuiteInvariants('composer', bag)
}
