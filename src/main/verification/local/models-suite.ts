/**
 * 模型菜单、会话预设、压缩读数、计划评审与待响应交互验收套件。
 */
import { writeFileSync } from 'node:fs'
import { verifyCompactionReadings } from '../compaction-verifier.ts'
import { captureVerifiedPage, clickTrustedElement } from '../desktop-verifier.ts'
import {
  openRightVerificationPanel,
  settleElementAnimations,
  waitForColorScheme,
  waitForWindowSize,
} from '../host-verify-context.ts'
import { verifyPlanReview } from '../plan-review-verifier.ts'
import { readVerificationProjection } from '../session-projection-fixture.ts'
import {
  HUD_TOKEN_USAGE_POPOVER_PROBE,
  MODEL_MENU_CLOSED_PROBE,
  MODEL_SUBMENU_GEOMETRY_PROBE,
  RESOLVE_INTERACTION_SESSION_ID_PROBE,
  RIGHT_ISLAND_TABS_CLEAN_PROBE,
  TODO_CARD_CENTERED_COLLAPSED_PROBE,
  TODO_CARD_EXPANDED_LAYOUT_PROBE,
  TODO_CARD_INITIAL_COLLAPSED_PROBE,
  buildClickAgentPresetCapsuleProbe,
  buildComposerReadingsHudLayoutProbe,
  buildPendingApprovalCardProbe,
  buildPendingQuestionCardProbe,
  buildVerifyAgentPresetLockedProbe,
  buildWaitAgentPresetSelectedProbe,
} from './models-probes.ts'
import { assertSuiteInvariants, type LocalVerifyState } from './state.ts'

function resolveSampleTodoStatus(index: number): 'completed' | 'in_progress' | 'pending' {
  if (index === 0) return 'completed'
  return index < 3 ? 'in_progress' : 'pending'
}

async function verifyModelMenuNavigation(state: LocalVerifyState): Promise<void> {
  await clickTrustedElement(state.bridge.win, 'button[title^="模型："]')
  state.modelMenuAudit = (await state.bridge.win.webContents.executeJavaScript(
    MODEL_SUBMENU_GEOMETRY_PROBE,
  )) as {
    open: boolean
    selectedCount: number
    portal: boolean
    fixed: boolean
    fits: boolean
    width: number
    adjacent: boolean
    choices: number
  }
  state.modelMenuCapture = 'verify-model-menu.png'
  writeFileSync(
    state.bridge.artifactPath(state.modelMenuCapture),
    (await captureVerifiedPage(state.bridge.win)).toPNG(),
  )
  state.bridge.win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' })
  state.bridge.win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' })
  state.modelMenuReturned = (await state.bridge.win.webContents.executeJavaScript(`(async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const menu = document.querySelector('[role="menu"][aria-label="选择模型"]')
      if (menu !== null && menu.querySelector('[role="menuitemradio"]') !== null
        && menu.querySelector('[aria-expanded="true"]') === null
        && menu.contains(document.activeElement)) return true
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return false
  })()`)) as boolean
  state.bridge.win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' })
  state.bridge.win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' })
  state.modelMenuClosed = (await state.bridge.win.webContents.executeJavaScript(
    MODEL_MENU_CLOSED_PROBE,
  )) as boolean
  state.modelMenuReady =
    state.modelMenuAudit.open &&
    state.modelMenuAudit.portal &&
    state.modelMenuAudit.fixed &&
    state.modelMenuAudit.fits &&
    state.modelMenuAudit.width >= 260 &&
    state.modelMenuAudit.width <= 420 &&
    state.modelMenuAudit.selectedCount === 1 &&
    state.modelMenuAudit.adjacent &&
    state.modelMenuAudit.choices > 0 &&
    state.modelMenuReturned &&
    state.modelMenuClosed
  console.log('desktop-shell-verify-local: model-menu', {
    ...state.modelMenuAudit,
    returned: state.modelMenuReturned,
    closed: state.modelMenuClosed,
    ready: state.modelMenuReady,
  })
  state.interactionSessionId = (await state.bridge.win.webContents.executeJavaScript(
    RESOLVE_INTERACTION_SESSION_ID_PROBE,
  )) as string | null
  if (state.interactionSessionId === null) throw new Error('无法确认待响应交互的验收会话')
}

async function verifyEmptySessionPresetCapsules(state: LocalVerifyState): Promise<void> {
  state.bridge.win.webContents.send(state.bridge.hostChannels.sessionFrame, {
    type: 'session/snapshot',
    sessionId: state.interactionSessionId,
    events: [],
    lastSeq: 0,
    hasMore: false,
  })
  await openRightVerificationPanel(state.bridge.win, 'git-history')
  state.noSidebarPresetButton = (await state.bridge.win.webContents.executeJavaScript(
    `document.querySelector('.conversation-tools [aria-label="会话预设"]') === null`,
  )) as boolean
  if (!state.noSidebarPresetButton) throw new Error('右侧会话工具列不应再渲染会话预设按钮')
  state.sessionPresetReady = true
  /* oxlint-disable no-await-in-loop -- 依次切换空会话预设再恢复标准预设。 */
  for (const label of ['极简模式', 'ChatGPT', '标准模式']) {
    const clicked = (await state.bridge.win.webContents.executeJavaScript(
      buildClickAgentPresetCapsuleProbe(label),
    )) as boolean
    if (!clicked) throw new Error(`空会话预设胶囊未显示或不可点击：${label}`)
    const selected = (await state.bridge.win.webContents.executeJavaScript(
      buildWaitAgentPresetSelectedProbe(label),
    )) as boolean
    state.sessionPresetReady = state.sessionPresetReady && selected
    if (!selected) {
      const currentText = await state.bridge.win.webContents.executeJavaScript(
        `document.querySelector('[aria-label="会话预设"]')?.textContent`,
      )
      throw new Error(`预设切换未生效：${label}；${String(currentText)}`)
    }
  }
  /* oxlint-enable no-await-in-loop */
  state.presetSessionCount = (await state.bridge.win.webContents.executeJavaScript(
    `window.dshDesktop.host.call('listSessions', {}).then(result => result.items.length)`,
  )) as number
  state.bridge.win.webContents.send(state.bridge.hostChannels.hostFrame, {
    type: 'host/session-status',
    sessionId: state.interactionSessionId,
    running: true,
  })
  state.bridge.win.webContents.send(state.bridge.hostChannels.hostFrame, {
    type: 'host/session-status',
    sessionId: state.interactionSessionId,
    running: false,
  })
  state.presetLocked = (await state.bridge.win.webContents.executeJavaScript(
    buildVerifyAgentPresetLockedProbe(state.presetSessionCount, state.interactionSessionId),
  )) as boolean
  if (!state.presetLocked) throw new Error('已有对话的 Agent 预设未锁定或意外创建了会话')
  state.sessionPresetReady &&= state.presetLocked
  console.log('desktop-shell-verify-local: session-preset', {
    sessionPresetReady: state.sessionPresetReady,
    presetLocked: state.presetLocked,
  })
  state.sessionInfoReady =
    ((await state.bridge.win.webContents.executeJavaScript(`(() => {
      const content = document.querySelector('.info-island .git-review-panel')
      return document.querySelector('.session-plugins-entry') === null && content instanceof HTMLElement
        && content.scrollWidth <= content.clientWidth + 1
        && document.querySelector('.info-island .todo-card, .info-island .session-preset-card') === null
    })()`)) as boolean) && state.sessionPresetReady
}

async function verifyHudPopoversForScheme(
  state: LocalVerifyState,
  colorScheme: 'light' | 'dark',
): Promise<void> {
  await clickTrustedElement(
    state.bridge.win,
    '[data-composer-readings] button[aria-label^="Token 用量"]',
  )
  const hudPanelReady = (await state.bridge.win.webContents.executeJavaScript(
    HUD_TOKEN_USAGE_POPOVER_PROBE,
  )) as boolean
  if (!hudPanelReady) throw new Error('HUD 用量面板未向上展开或按钮状态异常')
  await clickTrustedElement(
    state.bridge.win,
    '[data-composer-readings] button[aria-label^="Token 用量"]',
  )
  await clickTrustedElement(
    state.bridge.win,
    '[data-composer-readings] button[aria-label^="上下文占用"]',
  )
  const contextPanelReady = (await state.bridge.win.webContents.executeJavaScript(`(async () => {
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
    state.bridge.artifactPath(`verify-hud-context-${colorScheme}.png`),
    (await captureVerifiedPage(state.bridge.win)).toPNG(),
  )
  await clickTrustedElement(
    state.bridge.win,
    '[data-composer-readings] button[aria-label^="上下文占用"]',
  )
  writeFileSync(
    state.bridge.artifactPath(`verify-composer-hud-${colorScheme}.png`),
    (await captureVerifiedPage(state.bridge.win)).toPNG(),
  )
}

async function verifyHudSampleAtViewport(
  state: LocalVerifyState,
  sample: {
    readonly width: number
    readonly height: number
    readonly colorScheme: 'light' | 'dark'
  },
): Promise<void> {
  state.bridge.win.setSize(sample.width, sample.height)
  state.bridge.settingsController.publish(
    state.bridge.settingsStore.update({ colorScheme: sample.colorScheme }),
  )
  await waitForWindowSize(state.bridge.win, sample.width, sample.height)
  await waitForColorScheme(state.bridge.win, sample.colorScheme)
  await settleElementAnimations(state.bridge.win, '.app-shell')
  const todoReady = (await state.bridge.win.webContents.executeJavaScript(
    TODO_CARD_EXPANDED_LAYOUT_PROBE,
  )) as boolean
  state.sessionInfoReady &&= todoReady
  writeFileSync(
    state.bridge.artifactPath(`verify-session-info-${sample.colorScheme}.png`),
    (await captureVerifiedPage(state.bridge.win)).toPNG(),
  )
  await clickTrustedElement(state.bridge.win, '.todo-card__toggle')
  const centered = (await state.bridge.win.webContents.executeJavaScript(
    TODO_CARD_CENTERED_COLLAPSED_PROBE,
  )) as boolean
  if (!centered) throw new Error('收起的待办没有居中或箭头方向错误')
  writeFileSync(
    state.bridge.artifactPath(`verify-todo-centered-${sample.colorScheme}.png`),
    (await captureVerifiedPage(state.bridge.win)).toPNG(),
  )
  await clickTrustedElement(state.bridge.win, '.todo-card__toggle')
  const cardHeight = (await state.bridge.win.webContents.executeJavaScript(
    `document.querySelector('.composer-card').getBoundingClientRect().height`,
  )) as number
  await clickTrustedElement(state.bridge.win, '.panel-divider--information .panel-divider__capsule')
  await settleElementAnimations(state.bridge.win, '.app-shell')
  const hudReady = (await state.bridge.win.webContents.executeJavaScript(
    buildComposerReadingsHudLayoutProbe(cardHeight),
  )) as boolean
  if (!hudReady) throw new Error('输入区 HUD 间距、底部留白或读数布局异常')
  await verifyHudPopoversForScheme(state, sample.colorScheme)
  await clickTrustedElement(state.bridge.win, '.panel-divider--information .panel-divider__capsule')
  await settleElementAnimations(state.bridge.win, '.app-shell')
}

async function seedTodoProjectionSnapshot(state: LocalVerifyState): Promise<void> {
  const todoSample = [
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
  state.sessionInfoProjection = await readVerificationProjection(
    state.bridge.win,
    state.interactionSessionId,
  )
  state.bridge.win.webContents.send(state.bridge.hostChannels.sessionFrame, {
    type: 'session/plugin-projections',
    sessionId: state.interactionSessionId,
    change: {
      ...state.sessionInfoProjection,
      kind: 'snapshot',
      values: {
        ...state.sessionInfoProjection.values,
        todos: todoSample,
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
  state.todoCollapsed = (await state.bridge.win.webContents.executeJavaScript(
    TODO_CARD_INITIAL_COLLAPSED_PROBE,
  )) as boolean
  await clickTrustedElement(state.bridge.win, '.todo-card__toggle')
}

async function verifyTodoListAndComposerHud(state: LocalVerifyState): Promise<void> {
  await seedTodoProjectionSnapshot(state)
  const savedSize = state.bridge.win.getSize()
  const savedScheme = state.bridge.settingsStore.read().colorScheme
  try {
    /* oxlint-disable no-await-in-loop -- 同一个窗口按两种尺寸和主题依次验收。 */
    for (const sample of [
      { width: 1280, height: 800, colorScheme: 'light' },
      { width: 1800, height: 1000, colorScheme: 'dark' },
    ] as const) {
      await verifyHudSampleAtViewport(state, sample)
    }
    /* oxlint-enable no-await-in-loop */
    state.bridge.win.setSize(1100, 800)
    await waitForWindowSize(state.bridge.win, 1100, 800)
    state.narrowTodoReady = await state.bridge.win.webContents.executeJavaScript(`(async () => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const todo = document.querySelector('.composer-dock .todo-card')?.getBoundingClientRect()
        const input = document.querySelector('.composer-card')?.getBoundingClientRect()
        if (todo && input && todo.top >= 0 && todo.bottom < input.top && input.bottom < innerHeight
          && Math.abs(todo.width - input.width) < 1 && !!document.querySelector('[data-composer-readings]')) return true
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return false
    })()`)
    if (!state.narrowTodoReady) throw new Error('窄窗口待办未显示在输入框正上方')
    writeFileSync(
      state.bridge.artifactPath('verify-composer-todos-narrow.png'),
      (await captureVerifiedPage(state.bridge.win)).toPNG(),
    )
    await verifyCompactionReadings(
      state.bridge.win,
      state.interactionSessionId,
      frame => {
        state.bridge.win.webContents.send(state.bridge.hostChannels.sessionFrame, frame)
      },
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
    state.bridge.win.setSize(savedSize[0] ?? 1280, savedSize[1] ?? 800)
    state.bridge.settingsController.publish(
      state.bridge.settingsStore.update({ colorScheme: savedScheme }),
    )
    state.bridge.win.webContents.send(state.bridge.hostChannels.sessionFrame, {
      type: 'session/plugin-projections',
      sessionId: state.interactionSessionId,
      change: {
        ...state.sessionInfoProjection,
        kind: 'snapshot',
        values: { ...state.sessionInfoProjection.values, todos: [] },
      },
    })
    await waitForWindowSize(state.bridge.win, savedSize[0] ?? 1280, savedSize[1] ?? 800)
    await waitForColorScheme(state.bridge.win, savedScheme)
  }

  state.infoMenuReady = (await state.bridge.win.webContents.executeJavaScript(
    RIGHT_ISLAND_TABS_CLEAN_PROBE,
  )) as boolean
  writeFileSync(
    state.bridge.artifactPath('verify-right-island-tabs.png'),
    (await captureVerifiedPage(state.bridge.win)).toPNG(),
  )
  state.sessionInfoReady &&= state.todoCollapsed && state.infoMenuReady
  if (!state.sessionInfoReady) throw new Error('会话信息的任务清单、栏目状态或末尾分隔线验收失败')
  console.log('desktop-shell-verify-local: session-info', {
    sessionInfoReady: state.sessionInfoReady,
    todoCollapsed: state.todoCollapsed,
    infoMenuReady: state.infoMenuReady,
  })
}

async function verifyPlanReviewFlow(state: LocalVerifyState): Promise<void> {
  const planScheme = state.bridge.settingsStore.read().colorScheme
  try {
    await verifyPlanReview(
      state.bridge.win,
      state.interactionSessionId,
      frame => {
        state.bridge.observeInteractionFrame(frame)
        state.bridge.win.webContents.send(state.bridge.hostChannels.sessionFrame, frame)
      },
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
      state.bridge.settingsStore.update({ colorScheme: planScheme }),
    )
  }
}

async function verifyPendingQuestionInteraction(state: LocalVerifyState): Promise<void> {
  const questionKey = 'question:mydsh-verifier'
  const questionFrame = {
    type: 'session/interaction-requested' as const,
    sessionId: state.interactionSessionId,
    interaction: {
      kind: 'question' as const,
      key: questionKey,
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
  state.bridge.observeInteractionFrame(questionFrame)
  state.bridge.win.webContents.send(state.bridge.hostChannels.sessionFrame, questionFrame)
  state.questionInteractionReady = (await state.bridge.win.webContents.executeJavaScript(
    buildPendingQuestionCardProbe(questionKey),
  )) as boolean
  state.questionSelectionReady = false
  if (state.questionInteractionReady) {
    await clickTrustedElement(
      state.bridge.win,
      `[data-question-key="${questionKey}"] [role="radio"]`,
    )
    state.questionSelectionReady = (await state.bridge.win.webContents
      .executeJavaScript(`(async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const selected = [...document.querySelectorAll('[data-question-key="${questionKey}"] [role="radio"]')]
          .find(option => option.getAttribute('aria-checked') === 'true')
        if (selected instanceof HTMLButtonElement) return true
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return false
    })()`)) as boolean
  }
  const questionResolution = {
    type: 'session/interaction-resolved' as const,
    sessionId: state.interactionSessionId,
    resolution: { kind: 'question' as const, key: questionKey, outcome: 'cancelled' as const },
  }
  state.bridge.observeInteractionFrame(questionResolution)
  state.bridge.win.webContents.send(state.bridge.hostChannels.sessionFrame, questionResolution)
  state.questionResolved = (await state.bridge.win.webContents.executeJavaScript(`(async () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (document.querySelector('[data-question-key="${questionKey}"]') === null
        && document.querySelector('.main-island .composer-card') instanceof HTMLElement) return true
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return false
  })()`)) as boolean
}

async function verifyPendingApprovalAndSummarizeProjectViews(
  state: LocalVerifyState,
): Promise<void> {
  const approvalKey = 'approval:mydsh-verifier'
  const approvalFrame = {
    type: 'session/interaction-requested' as const,
    sessionId: state.interactionSessionId,
    interaction: {
      kind: 'approval' as const,
      key: approvalKey,
      approvalId: 'mydsh-verifier-approval',
      toolName: 'Bash',
      reason: '将验收文件复制到用户目录',
    },
  }
  state.bridge.observeInteractionFrame(approvalFrame)
  state.bridge.win.webContents.send(state.bridge.hostChannels.sessionFrame, approvalFrame)
  state.approvalInteractionReady = (await state.bridge.win.webContents.executeJavaScript(
    buildPendingApprovalCardProbe(approvalKey),
  )) as boolean
  writeFileSync(
    state.bridge.artifactPath('verify-approval.png'),
    (await captureVerifiedPage(state.bridge.win)).toPNG(),
  )
  const approvalResolution = {
    type: 'session/interaction-resolved' as const,
    sessionId: state.interactionSessionId,
    resolution: {
      kind: 'approval' as const,
      approvalId: 'mydsh-verifier-approval',
      outcome: 'rejected' as const,
    },
  }
  state.bridge.observeInteractionFrame(approvalResolution)
  state.bridge.win.webContents.send(state.bridge.hostChannels.sessionFrame, approvalResolution)
  state.approvalResolved = (await state.bridge.win.webContents.executeJavaScript(`(async () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (document.querySelector('[data-approval-key="${approvalKey}"]') === null
        && document.querySelector('.main-island .composer-card') instanceof HTMLElement) return true
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return false
  })()`)) as boolean

  state.pendingInteractionsReady =
    state.questionInteractionReady &&
    state.questionSelectionReady &&
    state.questionResolved &&
    state.approvalInteractionReady &&
    state.approvalResolved
  console.log('desktop-shell-verify-local: pending-interactions', {
    questionInteractionReady: state.questionInteractionReady,
    questionSelectionReady: state.questionSelectionReady,
    questionResolved: state.questionResolved,
    approvalInteractionReady: state.approvalInteractionReady,
    approvalResolved: state.approvalResolved,
  })
  state.projectViews = {
    ...state.fileView,
    fileEditorReady: state.fileEditorReady,
    fileUnsavedGuardReady: state.fileUnsavedGuardReady,
    contentSearchReady: state.contentSearchReady,
    projectTasksOnlyReady: state.projectTasksOnlyReady,
    projectTasksReady: state.projectTasksReady,
    taskSuggestionsRemoved: state.taskSuggestionsRemoved,
    ...state.sourceControlView,
    changeFileListReadable: state.changeFileListReadable,
    composerVisibilityReady: state.composerVisibilityReady,
    sourceControlWriteReady: state.sourceControlWriteReady,
    sourceControlFailureReady: state.sourceControlFailureReady,
    pendingInteractionsReady: state.pendingInteractionsReady,
    fileCapture: state.fileCapture,
    diffCapture: state.diffCapture,
  }
}

/** 运行 models 验收套件。 */
export async function runModelsSuite(state: LocalVerifyState): Promise<void> {
  await verifyModelMenuNavigation(state)
  await verifyEmptySessionPresetCapsules(state)
  await verifyTodoListAndComposerHud(state)
  await verifyPlanReviewFlow(state)
  await verifyPendingQuestionInteraction(state)
  await verifyPendingApprovalAndSummarizeProjectViews(state)
  assertSuiteInvariants('models', state)
}
