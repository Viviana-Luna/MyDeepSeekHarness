/**
 * 模型菜单、会话预设、压缩读数、计划评审与待响应交互验收套件。
 */
import { writeFileSync } from 'node:fs'
import {
  openRightVerificationPanel,
  settleElementAnimations,
  waitForColorScheme,
  waitForWindowSize,
} from '../host-verify-context.ts'
import { captureVerifiedPage, clickTrustedElement } from '../desktop-verifier.ts'
import { verifyPlanReview } from '../plan-review-verifier.ts'
import { readVerificationProjection } from '../session-projection-fixture.ts'
import { verifyCompactionReadings } from '../compaction-verifier.ts'
import { type LocalVerifyState, assertSuiteInvariants } from './state.ts'
import {
  MODELS_SCRIPT_1,
  MODELS_SCRIPT_2,
  MODELS_SCRIPT_3,
  buildModelsScript4,
  buildModelsScript5,
  buildModelsScript6,
  MODELS_SCRIPT_7,
  MODELS_SCRIPT_8,
  MODELS_SCRIPT_9,
  buildModelsScript10,
  MODELS_SCRIPT_11,
  MODELS_SCRIPT_12,
  buildModelsScript13,
  buildModelsScript14,
} from './models-scripts.ts'

function resolveSampleTodoStatus(index: number): 'completed' | 'in_progress' | 'pending' {
  if (index === 0) return 'completed'
  return index < 3 ? 'in_progress' : 'pending'
}

/** 执行 models 验收套件第 1 阶段。 */
export async function runModelsStep1(bag: LocalVerifyState): Promise<void> {
  await clickTrustedElement(bag.bridge.win, 'button[title^="模型："]')
  bag.modelMenuAudit = (await bag.bridge.win.webContents.executeJavaScript(MODELS_SCRIPT_1)) as {
    open: boolean
    selectedCount: number
    portal: boolean
    fixed: boolean
    fits: boolean
    width: number
    adjacent: boolean
    choices: number
  }
  bag.modelMenuCapture = 'verify-model-menu.png'
  writeFileSync(
    bag.bridge.artifactPath(bag.modelMenuCapture),
    (await captureVerifiedPage(bag.bridge.win)).toPNG(),
  )
  bag.bridge.win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' })
  bag.bridge.win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' })
  bag.modelMenuReturned = (await bag.bridge.win.webContents.executeJavaScript(`(async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const menu = document.querySelector('[role="menu"][aria-label="选择模型"]')
        if (menu !== null && menu.querySelector('[role="menuitemradio"]') !== null
          && menu.querySelector('[aria-expanded="true"]') === null
          && menu.contains(document.activeElement)) return true
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return false
    })()`)) as boolean
  bag.bridge.win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' })
  bag.bridge.win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' })
  bag.modelMenuClosed = (await bag.bridge.win.webContents.executeJavaScript(
    MODELS_SCRIPT_2,
  )) as boolean
  bag.modelMenuReady =
    bag.modelMenuAudit.open &&
    bag.modelMenuAudit.portal &&
    bag.modelMenuAudit.fixed &&
    bag.modelMenuAudit.fits &&
    bag.modelMenuAudit.width >= 260 &&
    bag.modelMenuAudit.width <= 420 &&
    bag.modelMenuAudit.selectedCount === 1 &&
    bag.modelMenuAudit.adjacent &&
    bag.modelMenuAudit.choices > 0 &&
    bag.modelMenuReturned &&
    bag.modelMenuClosed
  console.log('desktop-shell-verify-local: model-menu', {
    ...bag.modelMenuAudit,
    returned: bag.modelMenuReturned,
    closed: bag.modelMenuClosed,
    ready: bag.modelMenuReady,
  })
  bag.interactionSessionId = (await bag.bridge.win.webContents.executeJavaScript(
    MODELS_SCRIPT_3,
  )) as string | null
  if (bag.interactionSessionId === null) throw new Error('无法确认待响应交互的验收会话')
}

/** 执行 models 验收套件第 2 阶段。 */
export async function runModelsStep2(bag: LocalVerifyState): Promise<void> {
  // 通过空会话预设胶囊切换再恢复标准预设；请求走同一个公开 Remote 接口，并确认右侧工具列不再保留冗余预设按钮。
  // 前序 Host Command 验收会在会话视图留下命令结果条目，先清空界面快照以恢复真实空会话引导态。
  bag.bridge.win.webContents.send(bag.bridge.hostChannels.sessionFrame, {
    type: 'session/snapshot',
    sessionId: bag.interactionSessionId,
    events: [],
    lastSeq: 0,
    hasMore: false,
  })
  await openRightVerificationPanel(bag.bridge.win, 'git-history')
  bag.noSidebarPresetButton = (await bag.bridge.win.webContents.executeJavaScript(
    `document.querySelector('.conversation-tools [aria-label="会话预设"]') === null`,
  )) as boolean
  if (!bag.noSidebarPresetButton) throw new Error('右侧会话工具列不应再渲染会话预设按钮')
  bag.sessionPresetReady = true
  /* oxlint-disable no-await-in-loop -- 依次切换空会话预设再恢复标准预设。 */
  for (const label of ['极简模式', 'ChatGPT', '标准模式']) {
    const clicked = (await bag.bridge.win.webContents.executeJavaScript(
      buildModelsScript4(JSON.stringify(label)),
    )) as boolean
    if (!clicked) throw new Error(`空会话预设胶囊未显示或不可点击：${label}`)
    const selected = (await bag.bridge.win.webContents.executeJavaScript(
      buildModelsScript5(JSON.stringify(label)),
    )) as boolean
    bag.sessionPresetReady = bag.sessionPresetReady && selected
    if (!selected) {
      const state = await bag.bridge.win.webContents.executeJavaScript(
        `document.querySelector('[aria-label="会话预设"]')?.textContent`,
      )
      throw new Error(`预设切换未生效：${label}；${String(state)}`)
    }
  }
  /* oxlint-enable no-await-in-loop */
  bag.presetSessionCount = (await bag.bridge.win.webContents.executeJavaScript(
    `window.dshDesktop.host.call('listSessions', {}).then(result => result.items.length)`,
  )) as number
  bag.bridge.win.webContents.send(bag.bridge.hostChannels.hostFrame, {
    type: 'host/session-status',
    sessionId: bag.interactionSessionId,
    running: true,
  })
  bag.bridge.win.webContents.send(bag.bridge.hostChannels.hostFrame, {
    type: 'host/session-status',
    sessionId: bag.interactionSessionId,
    running: false,
  })
  bag.presetLocked = (await bag.bridge.win.webContents.executeJavaScript(
    buildModelsScript6(String(bag.presetSessionCount), JSON.stringify(bag.interactionSessionId)),
  )) as boolean
  if (!bag.presetLocked) throw new Error('已有对话的 Agent 预设未锁定或意外创建了会话')
  bag.sessionPresetReady &&= bag.presetLocked
  console.log('desktop-shell-verify-local: session-preset', {
    sessionPresetReady: bag.sessionPresetReady,
    presetLocked: bag.presetLocked,
  })
  bag.sessionInfoReady =
    ((await bag.bridge.win.webContents.executeJavaScript(`(() => {
      const content = document.querySelector('.info-island .git-review-panel')
      return document.querySelector('.session-plugins-entry') === null && content instanceof HTMLElement
        && content.scrollWidth <= content.clientWidth + 1
        && document.querySelector('.info-island .todo-card, .info-island .session-preset-card') === null
    })()`)) as boolean) && bag.sessionPresetReady
}

/** 执行 models 验收套件第 3 阶段。 */
export async function runModelsStep3(bag: LocalVerifyState): Promise<void> {
  bag.todoSample = [
    '梳理现有界面',
    '调整会话信息布局',
    '同步优化菜单状态',
    '处理长任务标题在窄面板中的显示与全文提示',
    '检查任务状态图标',
    '验证清单内部滚动',
    '检查浅色主题',
    '检查深色主题',
    '复核面板底部留白',
  ].map((content, index) => ({
    content,
    status: resolveSampleTodoStatus(index),
  }))
  bag.sessionInfoProjection = await readVerificationProjection(
    bag.bridge.win,
    bag.interactionSessionId,
  )
  bag.bridge.win.webContents.send(bag.bridge.hostChannels.sessionFrame, {
    type: 'session/plugin-projections',
    sessionId: bag.interactionSessionId,
    change: {
      ...bag.sessionInfoProjection,
      kind: 'snapshot',
      values: {
        ...bag.sessionInfoProjection.values,
        todos: bag.todoSample,
        tokenUsage: {
          uncachedInputTokens: 12_000,
          cacheReadTokens: 96_000,
          cacheWriteTokens: 0,
          outputTokens: 13_000,
        },
        contextPressure: { projectedTokens: 3_900, contextWindow: 128_000 },
        contextBreakdown: { systemTokens: 700, toolsTokens: 800, messageTokens: 2100 },
        sessionStats: {
          turns: 1,
          steps: 9,
          llmMs: 55_000,
          toolMs: 3_000,
          ttftSteps: 9,
          ttftMs: 1_800,
          decodeMs: 54_000,
          decodeTokens: 12_800,
        },
      },
      omitted: 0,
    },
  })
  bag.todoCollapsed = (await bag.bridge.win.webContents.executeJavaScript(
    MODELS_SCRIPT_7,
  )) as boolean
  await clickTrustedElement(bag.bridge.win, '.todo-card__toggle')
  bag.infoSize = bag.bridge.win.getSize()
  bag.infoScheme = bag.bridge.settingsStore.read().colorScheme
}

async function verifyModelsHudSample(
  bag: LocalVerifyState,
  sample: {
    readonly width: number
    readonly height: number
    readonly colorScheme: 'light' | 'dark'
  },
): Promise<void> {
  bag.bridge.win.setSize(sample.width, sample.height)
  bag.bridge.settingsController.publish(
    bag.bridge.settingsStore.update({ colorScheme: sample.colorScheme }),
  )
  await waitForWindowSize(bag.bridge.win, sample.width, sample.height)
  await waitForColorScheme(bag.bridge.win, sample.colorScheme)
  await settleElementAnimations(bag.bridge.win, '.app-shell')
  const todoReady = (await bag.bridge.win.webContents.executeJavaScript(MODELS_SCRIPT_8)) as boolean
  bag.sessionInfoReady &&= todoReady
  writeFileSync(
    bag.bridge.artifactPath(`verify-session-info-${sample.colorScheme}.png`),
    (await captureVerifiedPage(bag.bridge.win)).toPNG(),
  )
  await clickTrustedElement(bag.bridge.win, '.todo-card__toggle')
  const centered = (await bag.bridge.win.webContents.executeJavaScript(MODELS_SCRIPT_9)) as boolean
  if (!centered) throw new Error('收起的待办没有居中或箭头方向错误')
  writeFileSync(
    bag.bridge.artifactPath(`verify-todo-centered-${sample.colorScheme}.png`),
    (await captureVerifiedPage(bag.bridge.win)).toPNG(),
  )
  await clickTrustedElement(bag.bridge.win, '.todo-card__toggle')
  const cardHeight = (await bag.bridge.win.webContents.executeJavaScript(
    `document.querySelector('.composer-card').getBoundingClientRect().height`,
  )) as number
  await clickTrustedElement(bag.bridge.win, '.panel-divider--information .panel-divider__capsule')
  await settleElementAnimations(bag.bridge.win, '.app-shell')
  const hudReady = (await bag.bridge.win.webContents.executeJavaScript(
    buildModelsScript10(String(cardHeight)),
  )) as boolean
  if (!hudReady) throw new Error('输入区 HUD 间距、底部留白或读数布局异常')
  await verifyModelsHudPopovers(bag, sample.colorScheme)
  await clickTrustedElement(bag.bridge.win, '.panel-divider--information .panel-divider__capsule')
  await settleElementAnimations(bag.bridge.win, '.app-shell')
}

async function verifyModelsHudPopovers(
  bag: LocalVerifyState,
  colorScheme: 'light' | 'dark',
): Promise<void> {
  await clickTrustedElement(
    bag.bridge.win,
    '[data-composer-readings] button[aria-label^="Token 用量"]',
  )
  const hudPanelReady = (await bag.bridge.win.webContents.executeJavaScript(
    MODELS_SCRIPT_11,
  )) as boolean
  if (!hudPanelReady) throw new Error('HUD 用量面板未向上展开或按钮状态异常')
  await clickTrustedElement(
    bag.bridge.win,
    '[data-composer-readings] button[aria-label^="Token 用量"]',
  )
  await clickTrustedElement(
    bag.bridge.win,
    '[data-composer-readings] button[aria-label^="上下文占用"]',
  )
  const contextPanelReady = (await bag.bridge.win.webContents.executeJavaScript(`(async () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const panel = document.querySelector('[role="dialog"][aria-label="上下文占用"]')
      if (panel?.textContent.includes('系统提示词~700') && panel.textContent.includes('工具定义~800')
        && panel.textContent.includes('对话消息~2.1K') && panel.querySelectorAll('i[data-kind]').length === 6
        && !panel.textContent.includes('缓存读取')) return true
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return false
  })()`)) as boolean
  if (!contextPanelReady) throw new Error('仪表盘上下文构成未读取核心投影或与累计用量混淆')
  writeFileSync(
    bag.bridge.artifactPath(`verify-hud-context-${colorScheme}.png`),
    (await captureVerifiedPage(bag.bridge.win)).toPNG(),
  )
  await clickTrustedElement(
    bag.bridge.win,
    '[data-composer-readings] button[aria-label^="上下文占用"]',
  )
  writeFileSync(
    bag.bridge.artifactPath(`verify-composer-hud-${colorScheme}.png`),
    (await captureVerifiedPage(bag.bridge.win)).toPNG(),
  )
}

async function runModelsTryBlock1(bag: LocalVerifyState): Promise<void> {
  /* oxlint-disable no-await-in-loop -- 同一个窗口按两种尺寸和主题依次验收。 */
  for (const sample of [
    { width: 1280, height: 800, colorScheme: 'light' },
    { width: 1800, height: 1000, colorScheme: 'dark' },
  ] as const) {
    await verifyModelsHudSample(bag, sample)
  }
  /* oxlint-enable no-await-in-loop */
  bag.bridge.win.setSize(1100, 800)
}

async function runModelsTryBlock2(bag: LocalVerifyState): Promise<void> {
  await waitForWindowSize(bag.bridge.win, 1100, 800)
  bag.narrowTodoReady = await bag.bridge.win.webContents.executeJavaScript(`(async () => {
        for (let attempt = 0; attempt < 60; attempt += 1) {
          const todo = document.querySelector('.composer-dock .todo-card')?.getBoundingClientRect()
          const input = document.querySelector('.composer-card')?.getBoundingClientRect()
          if (todo && input && todo.top >= 0 && todo.bottom < input.top && input.bottom < innerHeight
            && Math.abs(todo.width - input.width) < 1 && !!document.querySelector('[data-composer-readings]')) return true
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        return false
      })()`)
  if (!bag.narrowTodoReady) throw new Error('窄窗口待办未显示在输入框正上方')
  writeFileSync(
    bag.bridge.artifactPath('verify-composer-todos-narrow.png'),
    (await captureVerifiedPage(bag.bridge.win)).toPNG(),
  )
  await verifyCompactionReadings(
    bag.bridge.win,
    bag.interactionSessionId,
    frame => {
      bag.bridge.win.webContents.send(bag.bridge.hostChannels.sessionFrame, frame)
    },
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
}
/** 执行 models 验收套件第 4 阶段。 */
export async function runModelsStep4(bag: LocalVerifyState): Promise<void> {
  try {
    await runModelsTryBlock1(bag)
    await runModelsTryBlock2(bag)
  } finally {
    bag.bridge.win.setSize(bag.infoSize[0] ?? 1280, bag.infoSize[1] ?? 800)
    bag.bridge.settingsController.publish(
      bag.bridge.settingsStore.update({ colorScheme: bag.infoScheme }),
    )
    bag.bridge.win.webContents.send(bag.bridge.hostChannels.sessionFrame, {
      type: 'session/plugin-projections',
      sessionId: bag.interactionSessionId,
      change: {
        ...bag.sessionInfoProjection,
        kind: 'snapshot',
        values: { ...bag.sessionInfoProjection.values, todos: [] },
      },
    })
    await waitForWindowSize(bag.bridge.win, bag.infoSize[0] ?? 1280, bag.infoSize[1] ?? 800)
    await waitForColorScheme(bag.bridge.win, bag.infoScheme)
  }
}

/** 执行 models 验收套件第 5 阶段。 */
export async function runModelsStep5(bag: LocalVerifyState): Promise<void> {
  bag.infoMenuReady = (await bag.bridge.win.webContents.executeJavaScript(
    MODELS_SCRIPT_12,
  )) as boolean
  writeFileSync(
    bag.bridge.artifactPath('verify-right-island-tabs.png'),
    (await captureVerifiedPage(bag.bridge.win)).toPNG(),
  )
  bag.sessionInfoReady &&= bag.todoCollapsed && bag.infoMenuReady
  if (!bag.sessionInfoReady) throw new Error('会话信息的任务清单、栏目状态或末尾分隔线验收失败')
  console.log('desktop-shell-verify-local: session-info', {
    sessionInfoReady: bag.sessionInfoReady,
    todoCollapsed: bag.todoCollapsed,
    infoMenuReady: bag.infoMenuReady,
  })
  bag.questionKey = 'question:mydsh-verifier'
  bag.planScheme = bag.bridge.settingsStore.read().colorScheme
  try {
    await verifyPlanReview(
      bag.bridge.win,
      bag.interactionSessionId,
      frame => {
        bag.bridge.observeInteractionFrame(frame)
        bag.bridge.win.webContents.send(bag.bridge.hostChannels.sessionFrame, frame)
      },
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
    // 计划的明暗截图不能改变后续“跟随系统”主题验收的前提。
    bag.bridge.settingsController.publish(
      bag.bridge.settingsStore.update({ colorScheme: bag.planScheme }),
    )
  }
}

/** 执行 models 验收套件第 6 阶段。 */
export async function runModelsStep6(bag: LocalVerifyState): Promise<void> {
  bag.questionFrame = {
    type: 'session/interaction-requested',
    sessionId: bag.interactionSessionId,
    interaction: {
      kind: 'question',
      key: bag.questionKey,
      questions: [
        {
          id: 'verification-choice',
          header: '验收选择',
          question: '请选择验收方式',
          detail: '这个请求只用于验证桌面端待回答交互。',
          options: [
            { label: '继续（推荐）', description: '验证单选、推荐标识和提交入口。' },
            { label: '暂停', description: '验证第二个可选项。' },
          ],
        },
      ],
    },
  }
  bag.bridge.observeInteractionFrame(bag.questionFrame)
  bag.bridge.win.webContents.send(bag.bridge.hostChannels.sessionFrame, bag.questionFrame)
  bag.questionInteractionReady = (await bag.bridge.win.webContents.executeJavaScript(
    buildModelsScript13(bag.questionKey),
  )) as boolean
  bag.questionSelectionReady = false
  if (bag.questionInteractionReady) {
    await clickTrustedElement(
      bag.bridge.win,
      `[data-question-key="${bag.questionKey}"] [role="radio"]`,
    )
    bag.questionSelectionReady = (await bag.bridge.win.webContents.executeJavaScript(`(async () => {
        const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const selected = [...document.querySelectorAll('[data-question-key="${bag.questionKey}"] [role="radio"]')]
            .find(option => option.getAttribute('aria-checked') === 'true')
          if (selected instanceof HTMLButtonElement) return true
          await sleep(25)
        }
        return false
      })()`)) as boolean
  }
  bag.questionResolution = {
    type: 'session/interaction-resolved',
    sessionId: bag.interactionSessionId,
    resolution: { kind: 'question', key: bag.questionKey, outcome: 'cancelled' },
  }
  bag.bridge.observeInteractionFrame(bag.questionResolution)
  bag.bridge.win.webContents.send(bag.bridge.hostChannels.sessionFrame, bag.questionResolution)
}

/** 执行 models 验收套件第 7 阶段。 */
export async function runModelsStep7(bag: LocalVerifyState): Promise<void> {
  bag.questionResolved = (await bag.bridge.win.webContents.executeJavaScript(`(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (document.querySelector('[data-question-key="${bag.questionKey}"]') === null
          && document.querySelector('.main-island .composer-card') instanceof HTMLElement) return true
        await sleep(25)
      }
      return false
    })()`)) as boolean
  bag.approvalKey = 'approval:mydsh-verifier'
  bag.approvalFrame = {
    type: 'session/interaction-requested',
    sessionId: bag.interactionSessionId,
    interaction: {
      kind: 'approval',
      key: bag.approvalKey,
      approvalId: 'mydsh-verifier-approval',
      toolName: 'Bash',
      reason: '将验收文件复制到用户目录',
    },
  }
  bag.bridge.observeInteractionFrame(bag.approvalFrame)
  bag.bridge.win.webContents.send(bag.bridge.hostChannels.sessionFrame, bag.approvalFrame)
  bag.approvalInteractionReady = (await bag.bridge.win.webContents.executeJavaScript(
    buildModelsScript14(bag.approvalKey),
  )) as boolean
  writeFileSync(
    bag.bridge.artifactPath('verify-approval.png'),
    (await captureVerifiedPage(bag.bridge.win)).toPNG(),
  )
  bag.approvalResolution = {
    type: 'session/interaction-resolved',
    sessionId: bag.interactionSessionId,
    resolution: {
      kind: 'approval',
      approvalId: 'mydsh-verifier-approval',
      outcome: 'rejected',
    },
  }
  bag.bridge.observeInteractionFrame(bag.approvalResolution)
  bag.bridge.win.webContents.send(bag.bridge.hostChannels.sessionFrame, bag.approvalResolution)
  bag.approvalResolved = (await bag.bridge.win.webContents.executeJavaScript(`(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (document.querySelector('[data-approval-key="${bag.approvalKey}"]') === null
          && document.querySelector('.main-island .composer-card') instanceof HTMLElement) return true
        await sleep(25)
      }
      return false
    })()`)) as boolean
}

/** 执行 models 验收套件第 8 阶段。 */
export async function runModelsStep8(bag: LocalVerifyState): Promise<void> {
  bag.pendingInteractionsReady =
    bag.questionInteractionReady &&
    bag.questionSelectionReady &&
    bag.questionResolved &&
    bag.approvalInteractionReady &&
    bag.approvalResolved
  console.log('desktop-shell-verify-local: pending-interactions', {
    questionInteractionReady: bag.questionInteractionReady,
    questionSelectionReady: bag.questionSelectionReady,
    questionResolved: bag.questionResolved,
    approvalInteractionReady: bag.approvalInteractionReady,
    approvalResolved: bag.approvalResolved,
  })
  bag.projectViews = {
    ...bag.fileView,
    fileEditorReady: bag.fileEditorReady,
    fileUnsavedGuardReady: bag.fileUnsavedGuardReady,
    contentSearchReady: bag.contentSearchReady,
    projectTasksOnlyReady: bag.projectTasksOnlyReady,
    projectTasksReady: bag.projectTasksReady,
    taskSuggestionsRemoved: bag.taskSuggestionsRemoved,
    ...bag.sourceControlView,
    changeFileListReadable: bag.changeFileListReadable,
    composerVisibilityReady: bag.composerVisibilityReady,
    sourceControlWriteReady: bag.sourceControlWriteReady,
    sourceControlFailureReady: bag.sourceControlFailureReady,
    pendingInteractionsReady: bag.pendingInteractionsReady,
    fileCapture: bag.fileCapture,
    diffCapture: bag.diffCapture,
  }
}

/** 运行 models 验收套件。 */
export async function runModelsSuite(bag: LocalVerifyState): Promise<void> {
  await runModelsStep1(bag)
  await runModelsStep2(bag)
  await runModelsStep3(bag)
  await runModelsStep4(bag)
  await runModelsStep5(bag)
  await runModelsStep6(bag)
  await runModelsStep7(bag)
  await runModelsStep8(bag)
  assertSuiteInvariants('models', bag)
}
