/**
 * Source Control 暂存、错误恢复、本地提交、Diff 审阅与用户终端 PTY 验收器。
 */
import { realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nativeTheme } from 'electron'
import { captureVerifiedPage, clickTrustedElement } from '../desktop-verifier.ts'
import { verifyGitAiPreparation } from '../git-ai-verifier.ts'
import {
  openRightVerificationPanel,
  waitForColorScheme,
  waitForNativeTheme,
  waitForWindowSize,
} from '../host-verify-context.ts'
import {
  verifyBulkUnstage,
  verifyGitRefresh,
  verifySourceControlSections,
} from '../source-control-sections-verifier.ts'
import { verifyDiffTools } from '../view-tools-verifier.ts'
import {
  BULK_UNSTAGE_NOTICE_PROBE,
  CHANGE_FILE_LIST_BOUNDS_PROBE,
  CLICK_NEW_TERMINAL_MENU_ITEM_PROBE,
  GIT_CHANGE_GROUPS_COLLAPSE_PROBE,
  GIT_CHANGE_LIST_SCROLL_PROBE,
  GIT_COMMIT_SUCCESS_PROBE,
  GIT_REVIEW_WORKING_DIFF_PROBE,
  PREPARE_STAGEABLE_SCRATCH_PROBE,
  RESTORE_CONVERSATION_VIEW_PROBE,
  TERMINAL_TAB_READY_PROBE,
  VERIFY_SCRATCH_STAGED_PROBE,
  buildFillCommitMessageProbe,
  buildIndexLockCommitErrorProbe,
  buildTerminalAnsiAndCwdProbe,
  buildTerminalMultiTabLifecycleProbe,
} from './scm-terminal-probes.ts'
import type { LocalVerifyState } from './state.ts'

/** 验证 Git 暂存分组、批量取消暂存、`index.lock` 错误兜底与本地提交成功闭环。 */
export async function verifySourceControlStagingAndCommit(state: LocalVerifyState): Promise<void> {
  await openRightVerificationPanel(state.bridge.win, 'git-history')
  const prepared = (await state.bridge.win.webContents.executeJavaScript(
    PREPARE_STAGEABLE_SCRATCH_PROBE,
  )) as boolean
  if (!prepared) throw new Error('隔离验收仓库没有出现可暂存的 scratch.md')
  await clickTrustedElement(state.bridge.win, 'button[aria-label="暂存 scratch.md"]')

  const staged = (await state.bridge.win.webContents.executeJavaScript(
    VERIFY_SCRATCH_STAGED_PROBE,
  )) as boolean
  if (!staged) throw new Error('单文件暂存没有进入暂存区')

  const gitGroupsReady = (await state.bridge.win.webContents.executeJavaScript(
    GIT_CHANGE_GROUPS_COLLAPSE_PROBE,
  )) as boolean
  if (!gitGroupsReady) throw new Error('Git 暂存与更改分组未能独立收起和恢复')
  console.log('desktop-shell-verify-local: git-groups', { gitGroupsReady })

  const gitListScrollable = (await state.bridge.win.webContents.executeJavaScript(
    GIT_CHANGE_LIST_SCROLL_PROBE,
  )) as boolean
  if (!gitListScrollable) throw new Error('Git 更改列表无法在内容超出时滚动')

  await verifySourceControlSections(state.bridge.win, async name => {
    writeFileSync(
      state.bridge.artifactPath(name),
      (await captureVerifiedPage(state.bridge.win)).toPNG(),
    )
  })
  await verifyGitAiPreparation(state.bridge.win)
  if (state.bridge.verifyProject === undefined) throw new Error('缺少隔离验收项目')

  await verifyBulkUnstage(state.bridge.win, async () => {
    const project = state.bridge.getProjects().find(item => item.cwd === state.bridge.verifyProject)
    if (!project) throw new Error('隔离验收项目尚未授权')
    writeFileSync(join(state.bridge.verifyProject, 'scratch.md'), '确认期间更新暂存内容\n')
    await state.bridge.runtimeCall('mydshWorkspace/call', {
      projectId: project.id,
      operation: 'gitStage',
      payload: { relativePaths: ['scratch.md'] },
    })
  })
  const unstaged = (await state.bridge.win.webContents.executeJavaScript(
    BULK_UNSTAGE_NOTICE_PROBE,
  )) as boolean
  if (!unstaged) throw new Error('确认取消全部暂存后未显示工作区更改和结果提示')

  await clickTrustedElement(state.bridge.win, 'button[aria-label="暂存 scratch.md"]')
  const restaged = (await state.bridge.win.webContents.executeJavaScript(`(async () => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const unstage = document.querySelector('button[aria-label="取消暂存 scratch.md"]')
      if (unstage instanceof HTMLButtonElement && !unstage.disabled) return true
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return false
  })()`)) as boolean
  if (!restaged) throw new Error('单文件重新暂存失败')

  const commitMessage = '验收 Source Control 写路径'
  const commitMessageReady = (await state.bridge.win.webContents.executeJavaScript(
    buildFillCommitMessageProbe(commitMessage),
  )) as boolean
  if (!commitMessageReady) throw new Error('无法为隔离验收提交填写消息')

  const indexLockPath = join(state.bridge.verifyProject, '.git', 'index.lock')
  state.sourceControlFailureReady = false
  writeFileSync(indexLockPath, 'MyDSH verifier\n', { mode: 0o600 })
  try {
    await clickTrustedElement(state.bridge.win, '.scm-commit-button')
    state.sourceControlFailureReady = (await state.bridge.win.webContents.executeJavaScript(
      buildIndexLockCommitErrorProbe(commitMessage),
    )) as boolean
  } finally {
    rmSync(indexLockPath, { force: true })
  }
  console.log('desktop-shell-verify-local: source-control-failure', state.sourceControlFailureReady)

  await clickTrustedElement(state.bridge.win, '.scm-commit-button')
  state.sourceControlWriteReady = (await state.bridge.win.webContents.executeJavaScript(
    GIT_COMMIT_SUCCESS_PROBE,
  )) as boolean
  console.log('desktop-shell-verify-local: source-control-write', state.sourceControlWriteReady)
}

/** 验证深层目录更改的 Diff 视图、文件列表边界与工具栏。 */
export async function verifyDiffReviewAndBounds(state: LocalVerifyState): Promise<void> {
  const changedDirectory = join(
    state.bridge.verifyProject,
    'src',
    ...Array.from({ length: 39 }, (_, index) => `level-${String(index + 1).padStart(2, '0')}`),
  )
  writeFileSync(
    join(changedDirectory, 'ApplicationSecurityConfiguration.java'),
    'package verification;\npublic final class ApplicationSecurityConfiguration { private boolean enabled = true;\n' +
      Array.from({ length: 60 }, (_, index) => `  private int value${String(index)};`).join('\n') +
      '\n}\n',
  )
  writeFileSync(join(changedDirectory, 'index.ts'), 'export const ready = false\n')
  await verifyGitRefresh(state.bridge.win)

  state.sourceControlView = (await state.bridge.win.webContents.executeJavaScript(
    GIT_REVIEW_WORKING_DIFF_PROBE,
  )) as {
    sourceControlReady: boolean
    uncommittedChangesReady: boolean
    contextualRightPanelReady: boolean
    diffResponsiveReady: boolean
  }
  state.changeFileListReadable = (await state.bridge.win.webContents.executeJavaScript(
    CHANGE_FILE_LIST_BOUNDS_PROBE,
  )) as boolean
  state.diffCapture = 'verify-diff.png'
  writeFileSync(
    state.bridge.artifactPath(state.diffCapture),
    (await captureVerifiedPage(state.bridge.win)).toPNG(),
  )

  const gitViewBounds = state.bridge.win.getBounds()
  const gitViewTheme = nativeTheme.themeSource
  try {
    state.bridge.win.setSize(1_440, 900)
    nativeTheme.themeSource = 'dark'
    await waitForWindowSize(state.bridge.win, 1_440, 900)
    await waitForNativeTheme(state.bridge.win, 'dark')
    state.changeFileListReadable &&= (await state.bridge.win.webContents.executeJavaScript(
      CHANGE_FILE_LIST_BOUNDS_PROBE,
    )) as boolean
    writeFileSync(
      state.bridge.artifactPath('verify-git-large-dark.png'),
      (await captureVerifiedPage(state.bridge.win)).toPNG(),
    )
  } finally {
    nativeTheme.themeSource = gitViewTheme
    state.bridge.win.setBounds(gitViewBounds)
    await waitForNativeTheme(state.bridge.win, nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
    await waitForWindowSize(state.bridge.win, gitViewBounds.width, gitViewBounds.height)
  }
  console.log('desktop-shell-verify-local: source-control-view', state.sourceControlView)

  const diffToolsScheme = state.bridge.settingsStore.read().colorScheme
  try {
    await verifyDiffTools(
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
      state.bridge.settingsStore.update({ colorScheme: diffToolsScheme }),
    )
    await waitForColorScheme(state.bridge.win, diffToolsScheme)
  }
}

/** 验证真实用户终端工作标签创建、ANSI 转义、工作目录与多标签生命周期。 */
export async function verifyUserTerminalWorkspace(state: LocalVerifyState): Promise<void> {
  await clickTrustedElement(state.bridge.win, '[aria-label="新建工作标签"]')
  await state.bridge.win.webContents.executeJavaScript(CLICK_NEW_TERMINAL_MENU_ITEM_PROBE)
  const terminalAudit = (await state.bridge.win.webContents.executeJavaScript(
    TERMINAL_TAB_READY_PROBE,
  )) as { ready: true; terminalId: string } | { ready: false; stage: string }
  if (!terminalAudit.ready) {
    throw new Error(
      `用户终端没有创建真实 PTY 或错误显示了 Composer：${JSON.stringify(terminalAudit)}`,
    )
  }

  const isWin32 = process.platform === 'win32'
  const command = isWin32
    ? "[Console]::WriteLine([char]27 + '[31mDSH_TERMINAL_ANSI_OK' + [char]27 + '[0m'); (Get-Location).Path\r"
    : "printf '\\033[31mDSH_TERMINAL_ANSI_OK\\033[0m\\n'; pwd -P\r"
  const rawProjectPath = realpathSync(state.bridge.verifyProject)
  const expectedProjectPath = isWin32 ? rawProjectPath.toLowerCase() : rawProjectPath
  const terminalOutputReady = (await state.bridge.win.webContents.executeJavaScript(
    buildTerminalAnsiAndCwdProbe({
      terminalId: terminalAudit.terminalId,
      command,
      expectedProjectPath,
      caseInsensitivePath: isWin32,
    }),
  )) as boolean

  const terminalInteraction = (await state.bridge.win.webContents.executeJavaScript(
    buildTerminalMultiTabLifecycleProbe(terminalAudit.terminalId),
  )) as { ready: boolean; stage: string }
  state.terminalReady = terminalOutputReady && terminalInteraction.ready
  console.log('desktop-shell-verify-local: terminal', {
    terminalOutputReady,
    terminalInteraction,
    terminalReady: state.terminalReady,
  })
  if (!state.terminalReady) throw new Error('用户终端的 ANSI 输出、多标签或关闭流程验收失败')

  const conversationRestored = (await state.bridge.win.webContents.executeJavaScript(
    RESTORE_CONVERSATION_VIEW_PROBE,
  )) as boolean
  console.log('desktop-shell-verify-local: conversation-restored', conversationRestored)
  if (!conversationRestored) throw new Error('无法在项目视图验收后恢复对话视图')
}
