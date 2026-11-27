/**
 * 文件树、代码编辑器、全文搜索、项目任务、Git 与终端验收套件（阶段分片 2）。
 */
import { realpathSync, writeFileSync } from 'node:fs'
import { waitForColorScheme } from '../host-verify-context.ts'
import { captureVerifiedPage, clickTrustedElement } from '../desktop-verifier.ts'
import { verifyDiffTools } from '../view-tools-verifier.ts'
import type { LocalVerifyState } from './state.ts'
import {
  FILES_SCM_SCRIPT_22,
  FILES_SCM_SCRIPT_23,
  buildFilesScmScript24,
  buildFilesScmScript25,
  FILES_SCM_SCRIPT_26,
} from './files-scm-scripts-2.ts'

/** 执行 files-scm 验收套件第 9 阶段。 */
export async function runFilesScmStep9(bag: LocalVerifyState): Promise<void> {
  try {
    await verifyDiffTools(
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
      bag.bridge.settingsStore.update({ colorScheme: bag.diffToolsScheme }),
    )
    await waitForColorScheme(bag.bridge.win, bag.diffToolsScheme)
  }
  await clickTrustedElement(bag.bridge.win, '[aria-label="新建工作标签"]')
  await bag.bridge.win.webContents.executeJavaScript(FILES_SCM_SCRIPT_22)
  bag.terminalAudit = (await bag.bridge.win.webContents.executeJavaScript(FILES_SCM_SCRIPT_23)) as
    { ready: true; terminalId: string } | { ready: false; stage: string; [key: string]: unknown }
  if (!bag.terminalAudit.ready)
    throw new Error(
      `用户终端没有创建真实 PTY 或错误显示了 Composer：${JSON.stringify(bag.terminalAudit)}`,
    )
  bag.terminalId = bag.terminalAudit.terminalId
  // 终端的 ANSI 与工作目录探针按平台选择：Windows 的默认 Shell 是 PowerShell，
  // `printf` 与 `pwd -P` 在它下面不存在；`[char]27` 同时兼容 Windows PowerShell 5.1 与 7。
  bag.windowsTerminalCommand =
    "[Console]::WriteLine([char]27 + '[31mDSH_TERMINAL_ANSI_OK' + [char]27 + '[0m'); (Get-Location).Path\r"
  bag.terminalCommand =
    process.platform === 'win32'
      ? bag.windowsTerminalCommand
      : "printf '\\033[31mDSH_TERMINAL_ANSI_OK\\033[0m\\n'; pwd -P\r"
  // Windows 路径比较不区分大小写：PowerShell 报告的当前位置与 realpath 的大小写可能不同。
  bag.expectedProjectPath =
    process.platform === 'win32'
      ? realpathSync(bag.bridge.verifyProject).toLowerCase()
      : realpathSync(bag.bridge.verifyProject)
  bag.terminalPathCheck =
    process.platform === 'win32'
      ? `output.toLowerCase().includes(${JSON.stringify(bag.expectedProjectPath)})`
      : `output.includes(${JSON.stringify(bag.expectedProjectPath)})`
  bag.terminalOutputReady = (await bag.bridge.win.webContents.executeJavaScript(
    buildFilesScmScript24([
      JSON.stringify(bag.terminalId),
      bag.terminalPathCheck,
      JSON.stringify(bag.terminalId),
      JSON.stringify(bag.terminalId),
      JSON.stringify(bag.terminalCommand),
    ]),
  )) as boolean
  bag.terminalInteraction = (await bag.bridge.win.webContents.executeJavaScript(
    buildFilesScmScript25(JSON.stringify(bag.terminalId)),
  )) as { ready: boolean; stage: string }
  bag.terminalInteractionReady = bag.terminalInteraction.ready
  bag.terminalReady = bag.terminalOutputReady && bag.terminalInteractionReady
  console.log('desktop-shell-verify-local: terminal', {
    terminalOutputReady: bag.terminalOutputReady,
    terminalInteractionReady: bag.terminalInteractionReady,
    terminalInteraction: bag.terminalInteraction,
    terminalReady: bag.terminalReady,
  })
  if (!bag.terminalReady) throw new Error('用户终端的 ANSI 输出、多标签或关闭流程验收失败')
  bag.conversationRestored = (await bag.bridge.win.webContents.executeJavaScript(
    FILES_SCM_SCRIPT_26,
  )) as boolean
  console.log('desktop-shell-verify-local: conversation-restored', bag.conversationRestored)
  if (!bag.conversationRestored) throw new Error('无法在项目视图验收后恢复对话视图')
}
