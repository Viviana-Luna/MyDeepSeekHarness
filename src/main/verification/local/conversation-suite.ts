/**
 * 对话排版、思维链、文件链接、日志导出与插件管理验收套件。
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { focusPrimaryWindow } from '../../lifecycle/app-lifecycle.ts'
import { verifyConversationPolish } from '../conversation-polish-verifier.ts'
import { captureVerifiedPage, clickTrustedElement } from '../desktop-verifier.ts'
import {
  openRightVerificationPanel,
  waitForColorScheme,
  waitForWindowSize,
} from '../host-verify-context.ts'
import { verifyMessageActionReveal } from '../interaction-polish-verifier.ts'
import { verifyPluginManager } from '../plugin-manager-verifier.ts'
import { verifySessionLogExport } from '../session-export-verifier.ts'
import { verifyWorkspaceReview } from '../workspace-review-verifier.ts'
import {
  COLLAPSE_TURN_PROCESS_SUMMARY_PROBE,
  CONVERSATION_FILE_LINKS_PROBE,
  CONVERSATION_PRESENTATION_PROBE,
  EXPAND_TURN_PROCESS_SUMMARY_PROBE,
  FOCUS_CONVERSATION_WIDTH_HANDLE_PROBE,
  QUEUE_DOCK_CAPTURE_BOUNDS_PROBE,
  WAIT_PROJECT_FOCUS_MENU_PROBE,
  buildWaitConversationWidthExpandedProbe,
} from './conversation-probes.ts'
import { assertSuiteInvariants, type LocalVerifyState } from './state.ts'

function createPresentationFixtureEvents(): unknown[] {
  const now = Date.now()
  return [
    {
      type: 'user/message',
      seq: 0,
      time: now,
      data: {
        turn: 1,
        source: { kind: 'plugin', plugin: 'AGENTS.md', form: 'instructions' },
        content: [{ type: 'text', text: '项目说明与工作约定' }],
      },
    },
    {
      type: 'deliverables/presented',
      seq: 1,
      time: now,
      data: { turn: 1, callId: '验收交付', files: [{ path: 'README.md' }] },
    },
    {
      type: 'assistant/message',
      seq: 2,
      time: now,
      data: {
        turn: 1,
        message: {
          content: [
            { type: 'reasoning', text: '先检查项目的入口和现有文档。' },
            { type: 'text', text: '先核对项目说明。' },
          ],
        },
      },
    },
    {
      type: 'tool/call',
      seq: 3,
      time: now,
      data: {
        turn: 1,
        callId: '排版读取',
        name: 'bash',
        arguments: '{"command":"cat README.md"}',
      },
    },
    {
      type: 'tool/result',
      seq: 4,
      time: now,
      data: {
        turn: 1,
        message: {
          source: { callId: '排版读取' },
          content: [{ type: 'tool-result', content: [{ type: 'text', text: '项目说明读取完成' }] }],
        },
      },
    },
    {
      type: 'assistant/message',
      seq: 5,
      time: now,
      data: {
        turn: 1,
        message: {
          content: [
            { type: 'reasoning', text: '# 思考标题\n\n检查内容层级。' },
            {
              type: 'text',
              text: '# 一级标题\n\n契约内容正确（`namespace: example`、`cancellation.signal`）。问题可能在服务键使用了点号。先核对服务命名约束。\n\n## 二级标题\n\n### 三级标题\n\napps/web/（`index.html`）\n\n`README.md` · [查看说明](README.md#L1) · [查看图片](large-preview.png) · [不存在](missing.html)',
            },
          ],
        },
      },
    },
  ]
}

async function seedAndCapturePresentationThemes(state: LocalVerifyState): Promise<void> {
  state.presentationSession = (await state.bridge.win.webContents.executeJavaScript(
    `document.querySelector('.composer-card')?.dataset.sessionId`,
  )) as string
  state.presentationEvents = createPresentationFixtureEvents()
  state.bridge.win.webContents.send(state.bridge.hostChannels.sessionFrame, {
    type: 'session/snapshot',
    sessionId: state.presentationSession,
    lastSeq: 5,
    hasMore: false,
    events: state.presentationEvents,
  })
  state.readPresentation = () =>
    state.bridge.win.webContents.executeJavaScript(CONVERSATION_PRESENTATION_PROBE)
  state.defaultPresentation = await state.readPresentation()
  state.presentationScheme = state.bridge.settingsStore.read().colorScheme

  const captureProjectSelector = async (scheme: 'light' | 'dark'): Promise<void> => {
    await clickTrustedElement(state.bridge.win, '.project-selector')
    await state.bridge.win.webContents.executeJavaScript(WAIT_PROJECT_FOCUS_MENU_PROBE)
    writeFileSync(
      state.bridge.artifactPath(`verify-project-selector-${scheme}.png`),
      (await captureVerifiedPage(state.bridge.win)).toPNG(),
    )
    await clickTrustedElement(state.bridge.win, '.project-selector')
    await state.bridge.win.webContents.executeJavaScript(`(async () => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (document.querySelector('.project-focus-menu') === null) return
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    })()`)
  }

  state.bridge.settingsController.publish(
    state.bridge.settingsStore.update({ colorScheme: 'light' }),
  )
  await waitForColorScheme(state.bridge.win, 'light')
  state.lightPresentation = await state.readPresentation()
  writeFileSync(
    state.bridge.artifactPath('verify-body-alignment-light.png'),
    (await captureVerifiedPage(state.bridge.win)).toPNG(),
  )
  await captureProjectSelector('light')

  state.bridge.settingsController.publish(
    state.bridge.settingsStore.update({ colorScheme: 'dark' }),
  )
  await waitForColorScheme(state.bridge.win, 'dark')
  state.darkPresentation = await state.readPresentation()
  writeFileSync(
    state.bridge.artifactPath('verify-body-alignment-dark.png'),
    (await captureVerifiedPage(state.bridge.win)).toPNG(),
  )
  await captureProjectSelector('dark')

  state.bridge.settingsController.publish(
    state.bridge.settingsStore.update({ colorScheme: state.presentationScheme }),
  )
  await waitForColorScheme(state.bridge.win, state.presentationScheme)
}

async function verifyConversationWidthHandleResize(state: LocalVerifyState): Promise<void> {
  state.bridge.win.setSize(1800, 1000)
  state.bridge.win.webContents.sendInputEvent({ type: 'mouseMove', x: 2, y: 2 })
  await state.bridge.win.webContents.executeJavaScript(
    `document.activeElement instanceof HTMLElement && document.activeElement.blur()`,
  )
  await waitForWindowSize(state.bridge.win, 1800, 1000)
  state.widePresentation = await state.readPresentation()
  if (!state.bridge.verifyBackground) {
    app.focus({ steal: true })
    focusPrimaryWindow(state.bridge.win)
  }
  state.bridge.win.webContents.focus()
  state.bridge.win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
  state.bridge.win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
  await state.bridge.win.webContents.executeJavaScript(FOCUS_CONVERSATION_WIDTH_HANDLE_PROBE)
  state.bridge.win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' })
  state.bridge.win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' })
  await state.bridge.win.webContents.executeJavaScript(
    buildWaitConversationWidthExpandedProbe(Number(state.widePresentation?.width ?? 0)),
  )
  state.resizedPresentation = await state.readPresentation()
  console.log('desktop-shell-verify-local: conversation-presentation', {
    defaultPresentation: state.defaultPresentation,
    lightPresentation: state.lightPresentation,
    darkPresentation: state.darkPresentation,
    widePresentation: state.widePresentation,
    resizedPresentation: state.resizedPresentation,
  })
  const samples = [
    state.defaultPresentation,
    state.lightPresentation,
    state.darkPresentation,
    state.widePresentation,
    state.resizedPresentation,
  ]
  const allSamplesValid = samples.every(
    sample =>
      Boolean(sample?.aligned) &&
      Boolean(sample?.spacing) &&
      Boolean(sample?.processMetadataHidden) &&
      Boolean(sample?.circularSend) &&
      Boolean(sample?.modelNameVisible),
  )
  if (
    !allSamplesValid ||
    !state.defaultPresentation.typography ||
    state.defaultPresentation.height !== 112 ||
    state.widePresentation.handleOpacity !== '0' ||
    Number(state.resizedPresentation.handleOpacity) === 0 ||
    state.resizedPresentation.width <= state.widePresentation.width
  ) {
    throw new Error('正文排版或输入区宽度联动验收失败')
  }
  await state.bridge.win.webContents.executeJavaScript(`(() => {
    const handle = document.querySelector('[aria-label="调整对话内容宽度（右侧）"]')
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    handle.blur()
  })()`)
}

async function verifyTurnProcessAndFileLinks(state: LocalVerifyState): Promise<void> {
  state.bridge.win.webContents.send(state.bridge.hostChannels.sessionFrame, {
    type: 'session/snapshot',
    sessionId: state.presentationSession,
    lastSeq: 6,
    hasMore: false,
    events: [
      ...state.presentationEvents,
      {
        type: 'turn/end',
        seq: 6,
        time: Date.now(),
        data: { turn: 1, reason: { kind: 'completed' } },
      },
    ],
  })
  state.processReady = await state.bridge.win.webContents.executeJavaScript(
    EXPAND_TURN_PROCESS_SUMMARY_PROBE,
  )
  state.expandedPresentation = await state.readPresentation()
  writeFileSync(
    state.bridge.artifactPath('verify-turn-process-expanded.png'),
    (await captureVerifiedPage(state.bridge.win)).toPNG(),
  )
  if (
    !state.processReady ||
    !state.expandedPresentation?.aligned ||
    !state.expandedPresentation.spacing ||
    !state.expandedPresentation.processMetadataHidden
  ) {
    throw new Error(`过程重新展开后的排版异常：${JSON.stringify(state.expandedPresentation)}`)
  }
  await state.bridge.win.webContents.executeJavaScript(COLLAPSE_TURN_PROCESS_SUMMARY_PROBE)
  writeFileSync(
    state.bridge.artifactPath('verify-turn-process.png'),
    (await captureVerifiedPage(state.bridge.win)).toPNG(),
  )
  console.log('desktop-shell-verify-local: turn-process', { ready: state.processReady })

  state.messageFilesCheck = (await state.bridge.win.webContents.executeJavaScript(
    CONVERSATION_FILE_LINKS_PROBE,
  )) as { ready: boolean; stage: string }
  console.log('desktop-shell-verify-local: message-file-links', state.messageFilesCheck)
  if (!state.messageFilesCheck.ready) {
    throw new Error(`对话文件链接与真实文件查看器验收失败：${state.messageFilesCheck.stage}`)
  }
}

function buildQueueSample(sessionId: string, count: number) {
  return {
    items: Array.from({ length: count }, (_, index) => ({
      id: `${sessionId}-队列-${String(index)}`,
      placement: 'queued' as const,
      preview:
        index === 0 ? '你应该查询线上数据库的' : '检查查询结果，并保留已有的项目配置与会话记录。',
      previewTruncated: false,
      edit: { kind: 'editable-text' as const, text: '你应该查询线上数据库的' },
    })),
    totalCount: count,
    omittedCount: 0,
    truncated: false,
  }
}

async function verifyMessageQueueDockLayouts(state: LocalVerifyState): Promise<void> {
  const captureQueue = async (name: string): Promise<void> => {
    const bounds = await state.bridge.win.webContents.executeJavaScript(
      QUEUE_DOCK_CAPTURE_BOUNDS_PROBE,
    )
    const path = state.bridge.artifactPath(name)
    writeFileSync(path, (await captureVerifiedPage(state.bridge.win, bounds)).toPNG())
    console.log('desktop-shell-verify-queue-capture:', path)
  }

  state.bridge.win.webContents.send(state.bridge.hostChannels.hostFrame, {
    type: 'host/session-status',
    sessionId: state.presentationSession,
    running: true,
  })
  try {
    state.bridge.win.setSize(1280, 800)
    state.bridge.settingsController.publish(
      state.bridge.settingsStore.update({ colorScheme: 'dark' }),
    )
    await waitForWindowSize(state.bridge.win, 1280, 800)
    await waitForColorScheme(state.bridge.win, 'dark')
    state.bridge.win.webContents.send(state.bridge.hostChannels.sessionFrame, {
      type: 'session/queue',
      sessionId: state.presentationSession,
      queue: buildQueueSample(state.presentationSession, 1),
    })
    await captureQueue('verify-queue-dark.png')
    await state.bridge.win.webContents.executeJavaScript(
      `document.querySelector('[aria-label="消息队列"] button[aria-label="编辑"]').click()`,
    )
    await captureQueue('verify-queue-edit.png')
    await state.bridge.win.webContents.executeJavaScript(
      `document.querySelector('[aria-label="消息队列"] button[aria-label="取消"]').click()`,
    )
    state.bridge.settingsController.publish(
      state.bridge.settingsStore.update({ colorScheme: 'light' }),
    )
    state.bridge.win.setSize(1800, 1000)
    await waitForWindowSize(state.bridge.win, 1800, 1000)
    await waitForColorScheme(state.bridge.win, 'light')
    state.bridge.win.webContents.send(state.bridge.hostChannels.sessionFrame, {
      type: 'session/queue',
      sessionId: state.presentationSession,
      queue: buildQueueSample(state.presentationSession, 3),
    })
    await captureQueue('verify-queue-light-collapsed.png')
    await state.bridge.win.webContents.executeJavaScript(
      `document.querySelector('button[aria-label="展开待处理消息"]').click()`,
    )
    await captureQueue('verify-queue-light-expanded.png')
    state.bridge.win.setSize(900, 720)
    await waitForWindowSize(state.bridge.win, 900, 720)
    await captureQueue('verify-queue-narrow.png')
  } finally {
    state.bridge.win.webContents.send(state.bridge.hostChannels.sessionFrame, {
      type: 'session/queue',
      sessionId: state.presentationSession,
      queue: buildQueueSample(state.presentationSession, 0),
    })
    state.bridge.win.webContents.send(state.bridge.hostChannels.hostFrame, {
      type: 'host/session-status',
      sessionId: state.presentationSession,
      running: false,
    })
    state.bridge.settingsController.publish(
      state.bridge.settingsStore.update({ colorScheme: state.presentationScheme }),
    )
    await waitForColorScheme(state.bridge.win, state.presentationScheme)
  }
}

async function verifyConversationPolishAndExports(state: LocalVerifyState): Promise<void> {
  const setScheme = (scheme: 'light' | 'dark'): void => {
    state.bridge.settingsController.publish(
      state.bridge.settingsStore.update({ colorScheme: scheme }),
    )
  }
  const saveCapture = async (name: string): Promise<void> => {
    writeFileSync(
      state.bridge.artifactPath(name),
      (await captureVerifiedPage(state.bridge.win)).toPNG(),
    )
  }
  const emitSessionFrame = (frame: unknown): void => {
    state.bridge.win.webContents.send(state.bridge.hostChannels.sessionFrame, frame)
  }

  emitSessionFrame({
    type: 'session/snapshot',
    sessionId: state.presentationSession,
    events: [],
    lastSeq: 2,
    hasMore: false,
  })
  await verifyMessageActionReveal(
    state.bridge.win,
    state.presentationSession,
    emitSessionFrame,
    setScheme,
    saveCapture,
  )
  await verifyConversationPolish(state.bridge.win, {
    sessionId: state.presentationSession,
    emit: emitSessionFrame,
    setRunning: running => {
      state.bridge.win.webContents.send(state.bridge.hostChannels.hostFrame, {
        type: 'host/session-status',
        sessionId: state.presentationSession,
        running,
      })
    },
    appearance: setScheme,
    restoreAppearance: () => {
      state.bridge.settingsController.publish(
        state.bridge.settingsStore.update({ colorScheme: state.presentationScheme }),
      )
    },
    capture: saveCapture,
  })
  if (!state.bridge.supervisor.installed) throw new Error('导出验收缺少已安装核心')
  await verifySessionLogExport(state.bridge.win, {
    installation: state.bridge.supervisor.installed,
    sessionId: state.presentationSession,
    emit: emitSessionFrame,
    cancelPending: () =>
      state.bridge.getSessionExportController()?.abort(new Error('验收取消会话日志导出')),
  })
  await verifyWorkspaceReview(
    state.bridge.win,
    state.presentationSession,
    emitSessionFrame,
    setScheme,
    saveCapture,
    (id: string) => openRightVerificationPanel(state.bridge.win, id),
  )
  await verifyPluginManager(
    state.bridge.win,
    join(dirname(state.bridge.artifactPath('verify-plugin-manager.png')), 'plugin-packages'),
    setScheme,
    saveCapture,
  )
  state.bridge.win.setSize(1280, 800)
  await waitForWindowSize(state.bridge.win, 1280, 800)
}

/** 运行 conversation 验收套件。 */
export async function runConversationSuite(state: LocalVerifyState): Promise<void> {
  await seedAndCapturePresentationThemes(state)
  await verifyConversationWidthHandleResize(state)
  await verifyTurnProcessAndFileLinks(state)
  await verifyMessageQueueDockLayouts(state)
  await verifyConversationPolishAndExports(state)
  assertSuiteInvariants('conversation', state)
}
