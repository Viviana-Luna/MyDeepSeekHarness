/**
 * 对话排版、思维链、文件链接、日志导出与插件管理验收套件。
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { focusPrimaryWindow } from '../../lifecycle/app-lifecycle.ts'
import {
  openRightVerificationPanel,
  waitForColorScheme,
  waitForWindowSize,
} from '../host-verify-context.ts'
import { captureVerifiedPage, clickTrustedElement } from '../desktop-verifier.ts'
import { verifyWorkspaceReview } from '../workspace-review-verifier.ts'
import { verifySessionLogExport } from '../session-export-verifier.ts'
import { verifyPluginManager } from '../plugin-manager-verifier.ts'
import { verifyMessageActionReveal } from '../interaction-polish-verifier.ts'
import { verifyConversationPolish } from '../conversation-polish-verifier.ts'
import { type LocalVerifyState, assertSuiteInvariants } from './state.ts'
import {
  CONVERSATION_SCRIPT_1,
  CONVERSATION_SCRIPT_2,
  CONVERSATION_SCRIPT_3,
  buildConversationScript4,
  CONVERSATION_SCRIPT_5,
  CONVERSATION_SCRIPT_6,
  CONVERSATION_SCRIPT_7,
  CONVERSATION_SCRIPT_8,
} from './conversation-scripts.ts'

/** 执行 conversation 验收套件第 1 阶段。 */
export async function runConversationStep1(bag: LocalVerifyState): Promise<void> {
  // 隔离验收会话中的排版样本；完成后恢复空历史，不写入 Host 日志。
  bag.presentationSession = (await bag.bridge.win.webContents.executeJavaScript(
    `document.querySelector('.composer-card')?.dataset.sessionId`,
  )) as string
}

/** 执行 conversation 验收套件第 2 阶段。 */
export async function runConversationStep2(bag: LocalVerifyState): Promise<void> {
  bag.presentationEvents = [
    {
      type: 'user/message',
      seq: 0,
      time: Date.now(),
      data: {
        turn: 1,
        source: { kind: 'plugin', plugin: 'AGENTS.md', form: 'instructions' },
        content: [{ type: 'text', text: '项目说明与工作约定' }],
      },
    },
    {
      type: 'deliverables/presented',
      seq: 1,
      time: Date.now(),
      data: { turn: 1, callId: '验收交付', files: [{ path: 'README.md' }] },
    },
    {
      type: 'assistant/message',
      seq: 2,
      time: Date.now(),
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
      time: Date.now(),
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
      time: Date.now(),
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
      time: Date.now(),
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

/** 执行 conversation 验收套件第 3 阶段。 */
export async function runConversationStep3(bag: LocalVerifyState): Promise<void> {
  bag.bridge.win.webContents.send(bag.bridge.hostChannels.sessionFrame, {
    type: 'session/snapshot',
    sessionId: bag.presentationSession,
    lastSeq: 5,
    hasMore: false,
    events: bag.presentationEvents,
  })
  bag.readPresentation = () =>
    bag.bridge.win.webContents.executeJavaScript(CONVERSATION_SCRIPT_1) as Promise<{
      width: number
      modelNameVisible: boolean
      aligned: boolean
      spacing: boolean
      processMetadataHidden: boolean
      height: number
      circularSend: boolean
      typography: boolean
      handleOpacity: string
    } | null>
  bag.defaultPresentation = await bag.readPresentation()
  bag.presentationScheme = bag.bridge.settingsStore.read().colorScheme
  bag.captureProjectSelector = async (scheme: 'light' | 'dark') => {
    await clickTrustedElement(bag.bridge.win, '.project-selector')
    await bag.bridge.win.webContents.executeJavaScript(CONVERSATION_SCRIPT_2)
    writeFileSync(
      bag.bridge.artifactPath('verify-project-selector-' + scheme + '.png'),
      (await captureVerifiedPage(bag.bridge.win)).toPNG(),
    )
    await clickTrustedElement(bag.bridge.win, '.project-selector')
    await bag.bridge.win.webContents.executeJavaScript(`(async () => {
        for (let attempt = 0; attempt < 80; attempt += 1) {
          if (document.querySelector('.project-focus-menu') === null) return
          await new Promise(resolve => setTimeout(resolve, 25))
        }
      })()`)
  }
  bag.bridge.settingsController.publish(bag.bridge.settingsStore.update({ colorScheme: 'light' }))
  await waitForColorScheme(bag.bridge.win, 'light')
  bag.lightPresentation = await bag.readPresentation()
  writeFileSync(
    bag.bridge.artifactPath('verify-body-alignment-light.png'),
    (await captureVerifiedPage(bag.bridge.win)).toPNG(),
  )
  await bag.captureProjectSelector('light')
  bag.bridge.settingsController.publish(bag.bridge.settingsStore.update({ colorScheme: 'dark' }))
  await waitForColorScheme(bag.bridge.win, 'dark')
  bag.darkPresentation = await bag.readPresentation()
}

/** 执行 conversation 验收套件第 4 阶段。 */
export async function runConversationStep4(bag: LocalVerifyState): Promise<void> {
  writeFileSync(
    bag.bridge.artifactPath('verify-body-alignment-dark.png'),
    (await captureVerifiedPage(bag.bridge.win)).toPNG(),
  )
  await bag.captureProjectSelector('dark')
  bag.bridge.settingsController.publish(
    bag.bridge.settingsStore.update({ colorScheme: bag.presentationScheme }),
  )
  await waitForColorScheme(bag.bridge.win, bag.presentationScheme)
  bag.bridge.win.setSize(1800, 1000)
  bag.bridge.win.webContents.sendInputEvent({ type: 'mouseMove', x: 2, y: 2 })
  await bag.bridge.win.webContents.executeJavaScript(
    `document.activeElement instanceof HTMLElement && document.activeElement.blur()`,
  )
  await waitForWindowSize(bag.bridge.win, 1800, 1000)
  bag.widePresentation = await bag.readPresentation()
  // macOS 调整窗口尺寸后，键盘验收需要重新取得窗口与 WebContents 焦点。
  if (!bag.bridge.verifyBackground) {
    app.focus({ steal: true })
    focusPrimaryWindow(bag.bridge.win)
  }
  bag.bridge.win.webContents.focus()
  // 上一步的 mouseMove 会将 Chromium 切回指针模式；先等待 Tab 真正落到页面再聚焦手柄，
  // 避免迟到的 Tab 在 handle.focus() 之后切走焦点而让随后的 Right 键失效。
  bag.bridge.win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
  bag.bridge.win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
  await bag.bridge.win.webContents.executeJavaScript(CONVERSATION_SCRIPT_3)
  bag.bridge.win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' })
  bag.bridge.win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' })
  // 手柄伪元素存在 180ms 透明度过渡；离屏或 CI 高负载下轮询等待宽度与显影稳定，避免固定 200ms 竞态。
  await bag.bridge.win.webContents.executeJavaScript(
    buildConversationScript4(JSON.stringify(bag.widePresentation?.width ?? 0)),
  )
  bag.resizedPresentation = await bag.readPresentation()
  console.log('desktop-shell-verify-local: conversation-presentation', {
    defaultPresentation: bag.defaultPresentation,
    lightPresentation: bag.lightPresentation,
    darkPresentation: bag.darkPresentation,
    widePresentation: bag.widePresentation,
    resizedPresentation: bag.resizedPresentation,
  })
}

/** 执行 conversation 验收套件第 5 阶段。 */
export async function runConversationStep5(bag: LocalVerifyState): Promise<void> {
  if (
    !bag.defaultPresentation?.aligned ||
    !bag.lightPresentation?.aligned ||
    !bag.darkPresentation?.aligned ||
    !bag.widePresentation?.aligned ||
    !bag.resizedPresentation?.aligned ||
    ![
      bag.defaultPresentation,
      bag.lightPresentation,
      bag.darkPresentation,
      bag.widePresentation,
      bag.resizedPresentation,
    ].every(
      value =>
        value.spacing &&
        value.processMetadataHidden &&
        value.circularSend &&
        value.modelNameVisible,
    ) ||
    !bag.defaultPresentation.typography ||
    bag.defaultPresentation.height !== 112 ||
    bag.widePresentation.handleOpacity !== '0' ||
    Number(bag.resizedPresentation.handleOpacity) === 0 ||
    bag.resizedPresentation.width <= bag.widePresentation.width
  )
    throw new Error('正文排版或输入区宽度联动验收失败')
  await bag.bridge.win.webContents.executeJavaScript(`(() => {
      const handle = document.querySelector('[aria-label="调整对话内容宽度（右侧）"]')
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
      handle.blur()
    })()`)
  bag.bridge.win.webContents.send(bag.bridge.hostChannels.sessionFrame, {
    type: 'session/snapshot',
    sessionId: bag.presentationSession,
    lastSeq: 6,
    hasMore: false,
    events: [
      ...bag.presentationEvents,
      {
        type: 'turn/end',
        seq: 6,
        time: Date.now(),
        data: { turn: 1, reason: { kind: 'completed' } },
      },
    ],
  })
  bag.processReady = await bag.bridge.win.webContents.executeJavaScript(CONVERSATION_SCRIPT_5)
  bag.expandedPresentation = await bag.readPresentation()
}

/** 执行 conversation 验收套件第 6 阶段。 */
export async function runConversationStep6(bag: LocalVerifyState): Promise<void> {
  writeFileSync(
    bag.bridge.artifactPath('verify-turn-process-expanded.png'),
    (await captureVerifiedPage(bag.bridge.win)).toPNG(),
  )
  if (
    !bag.processReady ||
    !bag.expandedPresentation?.aligned ||
    !bag.expandedPresentation.spacing ||
    !bag.expandedPresentation.processMetadataHidden
  )
    throw new Error('过程重新展开后的排版异常：' + JSON.stringify(bag.expandedPresentation))
  await bag.bridge.win.webContents.executeJavaScript(CONVERSATION_SCRIPT_6)
  writeFileSync(
    bag.bridge.artifactPath('verify-turn-process.png'),
    (await captureVerifiedPage(bag.bridge.win)).toPNG(),
  )
  console.log('desktop-shell-verify-local: turn-process', { ready: bag.processReady })
  bag.messageFilesCheck = (await bag.bridge.win.webContents.executeJavaScript(
    CONVERSATION_SCRIPT_7,
  )) as { ready: boolean; stage: string }
  console.log('desktop-shell-verify-local: message-file-links', bag.messageFilesCheck)
  if (!bag.messageFilesCheck.ready) {
    const listItems = async (operation: string, field: string): Promise<unknown> => {
      try {
        return (await bag.bridge.win.webContents.executeJavaScript(
          `globalThis.dshDesktop.host.call(${JSON.stringify(operation)}, {}).then(result => (result.items ?? []).map(item => item[${JSON.stringify(field)}] ?? null).slice(0, 4))`,
        )) as unknown
      } catch (error) {
        return String(error)
      }
    }
    console.log('desktop-shell-verify-local: file-link-cwds', {
      verifyProject: bag.bridge.verifyProject,
      sessionCwds: await listItems('listSessions', 'cwd'),
      workspacePaths: await listItems('listWorkspaces', 'path'),
    })
  }
  if (!bag.messageFilesCheck.ready)
    throw new Error(`对话文件链接与真实文件查看器验收失败：${bag.messageFilesCheck.stage}`)
  bag.queueSample = (count: number) => ({
    items: Array.from({ length: count }, (_, index) => ({
      id: `${bag.presentationSession}-队列-${String(index)}`,
      placement: 'queued' as const,
      preview:
        index === 0 ? '你应该查询线上数据库的' : '检查查询结果，并保留已有的项目配置与会话记录。',
      previewTruncated: false,
      edit: { kind: 'editable-text' as const, text: '你应该查询线上数据库的' },
    })),
    totalCount: count,
    omittedCount: 0,
    truncated: false,
  })
}

/** 执行 conversation 验收套件第 7 阶段。 */
export async function runConversationStep7(bag: LocalVerifyState): Promise<void> {
  bag.captureQueue = async (name: string) => {
    const bounds = await bag.bridge.win.webContents.executeJavaScript(CONVERSATION_SCRIPT_8)
    const path = bag.bridge.artifactPath(name)
    writeFileSync(path, (await captureVerifiedPage(bag.bridge.win, bounds)).toPNG())
    console.log('desktop-shell-verify-queue-capture:', path)
  }
  bag.bridge.win.webContents.send(bag.bridge.hostChannels.hostFrame, {
    type: 'host/session-status',
    sessionId: bag.presentationSession,
    running: true,
  })
}

/** 执行 conversation 验收套件第 8 阶段。 */
export async function runConversationStep8(bag: LocalVerifyState): Promise<void> {
  try {
    bag.bridge.win.setSize(1280, 800)
    bag.bridge.settingsController.publish(bag.bridge.settingsStore.update({ colorScheme: 'dark' }))
    await waitForWindowSize(bag.bridge.win, 1280, 800)
    await waitForColorScheme(bag.bridge.win, 'dark')
    bag.bridge.win.webContents.send(bag.bridge.hostChannels.sessionFrame, {
      type: 'session/queue',
      sessionId: bag.presentationSession,
      queue: bag.queueSample(1),
    })
    await bag.captureQueue('verify-queue-dark.png')
    await bag.bridge.win.webContents.executeJavaScript(
      `document.querySelector('[aria-label="消息队列"] button[aria-label="编辑"]').click()`,
    )
    await bag.captureQueue('verify-queue-edit.png')
    await bag.bridge.win.webContents.executeJavaScript(
      `document.querySelector('[aria-label="消息队列"] button[aria-label="取消"]').click()`,
    )
    bag.bridge.settingsController.publish(bag.bridge.settingsStore.update({ colorScheme: 'light' }))
    bag.bridge.win.setSize(1800, 1000)
    await waitForWindowSize(bag.bridge.win, 1800, 1000)
    await waitForColorScheme(bag.bridge.win, 'light')
    bag.bridge.win.webContents.send(bag.bridge.hostChannels.sessionFrame, {
      type: 'session/queue',
      sessionId: bag.presentationSession,
      queue: bag.queueSample(3),
    })
    await bag.captureQueue('verify-queue-light-collapsed.png')
    await bag.bridge.win.webContents.executeJavaScript(
      `document.querySelector('button[aria-label="展开待处理消息"]').click()`,
    )
    await bag.captureQueue('verify-queue-light-expanded.png')
    bag.bridge.win.setSize(900, 720)
    await waitForWindowSize(bag.bridge.win, 900, 720)
    await bag.captureQueue('verify-queue-narrow.png')
  } finally {
    bag.bridge.win.webContents.send(bag.bridge.hostChannels.sessionFrame, {
      type: 'session/queue',
      sessionId: bag.presentationSession,
      queue: bag.queueSample(0),
    })
    bag.bridge.win.webContents.send(bag.bridge.hostChannels.hostFrame, {
      type: 'host/session-status',
      sessionId: bag.presentationSession,
      running: false,
    })
    bag.bridge.settingsController.publish(
      bag.bridge.settingsStore.update({ colorScheme: bag.presentationScheme }),
    )
    await waitForColorScheme(bag.bridge.win, bag.presentationScheme)
  }
}

/** 执行 conversation 验收套件第 9 阶段。 */
export async function runConversationStep9(bag: LocalVerifyState): Promise<void> {
  bag.bridge.win.webContents.send(bag.bridge.hostChannels.sessionFrame, {
    type: 'session/snapshot',
    sessionId: bag.presentationSession,
    events: [],
    lastSeq: 2,
    hasMore: false,
  })
  await verifyMessageActionReveal(
    bag.bridge.win,
    bag.presentationSession,
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
  await verifyConversationPolish(bag.bridge.win, {
    sessionId: bag.presentationSession,
    emit: frame => {
      bag.bridge.win.webContents.send(bag.bridge.hostChannels.sessionFrame, frame)
    },
    setRunning: running => {
      bag.bridge.win.webContents.send(bag.bridge.hostChannels.hostFrame, {
        type: 'host/session-status',
        sessionId: bag.presentationSession,
        running,
      })
    },
    appearance: scheme => {
      bag.bridge.settingsController.publish(
        bag.bridge.settingsStore.update({ colorScheme: scheme }),
      )
    },
    restoreAppearance: () => {
      bag.bridge.settingsController.publish(
        bag.bridge.settingsStore.update({ colorScheme: bag.presentationScheme }),
      )
    },
    capture: async name => {
      writeFileSync(
        bag.bridge.artifactPath(name),
        (await captureVerifiedPage(bag.bridge.win)).toPNG(),
      )
    },
  })
  if (!bag.bridge.supervisor.installed) throw new Error('导出验收缺少已安装核心')
}

/** 执行 conversation 验收套件第 10 阶段。 */
export async function runConversationStep10(bag: LocalVerifyState): Promise<void> {
  if (!bag.bridge.supervisor.installed) throw new Error('导出验收缺少已安装核心')
  await verifySessionLogExport(bag.bridge.win, {
    installation: bag.bridge.supervisor.installed,
    sessionId: bag.presentationSession,
    emit: frame => {
      bag.bridge.win.webContents.send(bag.bridge.hostChannels.sessionFrame, frame)
    },
    cancelPending: () =>
      bag.bridge.getSessionExportController()?.abort(new Error('验收取消会话日志导出')),
  })
  await verifyWorkspaceReview(
    bag.bridge.win,
    bag.presentationSession,
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
    (id: string) => openRightVerificationPanel(bag.bridge.win, id),
  )
  await verifyPluginManager(
    bag.bridge.win,
    join(dirname(bag.bridge.artifactPath('verify-plugin-manager.png')), 'plugin-packages'),
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
  bag.bridge.win.setSize(1280, 800)
  await waitForWindowSize(bag.bridge.win, 1280, 800)
}

/** 运行 conversation 验收套件。 */
export async function runConversationSuite(bag: LocalVerifyState): Promise<void> {
  await runConversationStep1(bag)
  await runConversationStep2(bag)
  await runConversationStep3(bag)
  await runConversationStep4(bag)
  await runConversationStep5(bag)
  await runConversationStep6(bag)
  await runConversationStep7(bag)
  await runConversationStep8(bag)
  await runConversationStep9(bag)
  await runConversationStep10(bag)
  assertSuiteInvariants('conversation', bag)
}
