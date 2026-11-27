/**
 * 文件树、代码编辑器、全文搜索、项目任务、Git 与终端验收套件（阶段分片 1）。
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nativeTheme } from 'electron'
import {
  openRightVerificationPanel,
  waitForColorScheme,
  waitForCondition,
  waitForNativeTheme,
  waitForWindowSize,
} from '../host-verify-context.ts'
import {
  captureVerifiedPage,
  clickTrustedElement,
  emulateVerificationMedia,
} from '../desktop-verifier.ts'
import { verifyGitAiPreparation } from '../git-ai-verifier.ts'
import {
  verifyBulkUnstage,
  verifyGitRefresh,
  verifySourceControlSections,
} from '../source-control-sections-verifier.ts'
import type { LocalVerifyState } from './state.ts'
import {
  FILES_SCM_SCRIPT_1,
  FILES_SCM_SCRIPT_2,
  FILES_SCM_SCRIPT_3,
  FILES_SCM_SCRIPT_4,
  FILES_SCM_SCRIPT_5,
  FILES_SCM_SCRIPT_6,
  FILES_SCM_SCRIPT_7,
  FILES_SCM_SCRIPT_8,
  buildFilesScmScript9,
  FILES_SCM_SCRIPT_10,
  FILES_SCM_SCRIPT_11,
  FILES_SCM_SCRIPT_12,
} from './files-scm-scripts-1.ts'
import {
  FILES_SCM_SCRIPT_13,
  FILES_SCM_SCRIPT_14,
  FILES_SCM_SCRIPT_15,
  FILES_SCM_SCRIPT_16,
  buildFilesScmScript17,
  buildFilesScmScript18,
  FILES_SCM_SCRIPT_19,
  FILES_SCM_SCRIPT_20,
  FILES_SCM_SCRIPT_21,
} from './files-scm-scripts-2.ts'

/** 执行 files-scm 验收套件第 1 阶段。 */
export async function runFilesScmStep1(bag: LocalVerifyState): Promise<void> {
  bag.fileView = (await bag.bridge.win.webContents.executeJavaScript(FILES_SCM_SCRIPT_1)) as {
    fileTreeReady: boolean
    deepFileTreeReady: boolean
    fileViewerReady: boolean
    fileTabsReady: boolean
    fileWorkspacePersisted: boolean
    quickOpenReady: boolean
    syntaxHighlightingReady: boolean
    fileCursorReady: boolean
    fileCursorDetails: unknown
    imageViewerReady: boolean
  }
  console.log('desktop-shell-verify-local: file-view', bag.fileView)
  if (bag.bridge.verifyProject === undefined) throw new Error('缺少隔离验收项目')
  bag.verificationReadmePath = join(bag.bridge.verifyProject, 'README.md')
  bag.originalReadme = readFileSync(bag.verificationReadmePath, 'utf8')
  bag.savedReadme = '# MyDSH 编辑器保存验收\n'
  bag.localDraft = '# MyDSH 本地未保存草稿\n'
  bag.externalReadme = '# MyDSH 外部修改验收\n'
  // 全选的修饰键按平台选择；保存使用按钮，避免与工作标签总览的快捷键冲突。
  bag.editorShortcutModifier = process.platform === 'darwin' ? 'meta' : 'control'
  bag.fileEditorReady = false
  bag.replaceEditorContent = async (content: string): Promise<boolean> => {
    const focused = (await bag.bridge.win.webContents.executeJavaScript(
      FILES_SCM_SCRIPT_2,
    )) as boolean
    if (!focused) return false
    bag.bridge.win.webContents.sendInputEvent({
      type: 'keyDown',
      keyCode: 'A',
      modifiers: [bag.editorShortcutModifier],
    })
    bag.bridge.win.webContents.sendInputEvent({
      type: 'keyUp',
      keyCode: 'A',
      modifiers: [bag.editorShortcutModifier],
    })
    await bag.bridge.win.webContents.insertText(content)
    return (await bag.bridge.win.webContents.executeJavaScript(`(async () => {
        const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
        for (let attempt = 0; attempt < 80; attempt += 1) {
          if (document.querySelector('.file-dirty-status')?.textContent?.trim() === '未保存') return true
          await sleep(25)
        }
        return false
      })()`)) as boolean
  }
  bag.saveFromEditor = () => clickTrustedElement(bag.bridge.win, '.file-save-button')
}

/** 执行 files-scm 验收套件第 2 阶段。 */
export async function runFilesScmStep2(bag: LocalVerifyState): Promise<void> {
  try {
    const draftReady = await bag.replaceEditorContent(bag.savedReadme)
    if (draftReady) await bag.saveFromEditor()
    const diskSaved =
      draftReady &&
      (await waitForCondition(
        () => readFileSync(bag.verificationReadmePath, 'utf8') === bag.savedReadme,
        10_000,
      ))
    if (!diskSaved) {
      const view = await bag.bridge.win.webContents.executeJavaScript(`(() => ({
          focused: document.activeElement?.outerHTML.slice(0, 300),
          content: document.querySelector('.code-editor .cm-content')?.textContent,
          status: document.querySelector('.file-dirty-status')?.textContent,
          saving: document.querySelector('.file-save-button')?.textContent,
          error: document.querySelector('.project-workspace-alert')?.textContent,
        }))()`)
      console.log('desktop-shell-verify-local: file-save-failure', {
        view,
        disk: readFileSync(bag.verificationReadmePath, 'utf8'),
      })
    }
    const savedStateReady =
      diskSaved &&
      ((await bag.bridge.win.webContents.executeJavaScript(`(async () => {
        const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
        for (let attempt = 0; attempt < 80; attempt += 1) {
          if (document.querySelector('.file-dirty-status') === null
            && document.querySelector('.file-conflict-panel') === null) return true
          await sleep(25)
        }
        return false
      })()`)) as boolean)
    const conflictDraftReady = savedStateReady && (await bag.replaceEditorContent(bag.localDraft))
    if (conflictDraftReady) {
      writeFileSync(bag.verificationReadmePath, bag.externalReadme, { mode: 0o600 })
      await bag.saveFromEditor()
    }
    const conflictReady =
      conflictDraftReady &&
      ((await bag.bridge.win.webContents.executeJavaScript(FILES_SCM_SCRIPT_3)) as boolean)
    const externalPreserved =
      readFileSync(bag.verificationReadmePath, 'utf8') === bag.externalReadme
    const reloadClicked =
      conflictReady &&
      ((await bag.bridge.win.webContents.executeJavaScript(`(() => {
        const reload = [...document.querySelectorAll('.file-conflict-panel button')]
          .find(button => button.textContent?.trim() === '重新载入')
        if (!(reload instanceof HTMLButtonElement)) return false
        reload.click()
        return true
      })()`)) as boolean)
    const reloaded =
      reloadClicked &&
      ((await bag.bridge.win.webContents.executeJavaScript(FILES_SCM_SCRIPT_4)) as boolean)
    bag.fileEditorReady =
      draftReady &&
      diskSaved &&
      savedStateReady &&
      conflictDraftReady &&
      conflictReady &&
      externalPreserved &&
      reloaded
    console.log('desktop-shell-verify-local: file-editor-stages', {
      draftReady,
      diskSaved,
      savedStateReady,
      conflictDraftReady,
      conflictReady,
      externalPreserved,
      reloaded,
    })
  } finally {
    writeFileSync(bag.verificationReadmePath, bag.originalReadme, { mode: 0o600 })
  }
}

/** 执行 files-scm 验收套件第 3 阶段。 */
export async function runFilesScmStep3(bag: LocalVerifyState): Promise<void> {
  console.log('desktop-shell-verify-local: file-editor', bag.fileEditorReady)
  bag.guardedDraftReady = await bag.replaceEditorContent('# MyDSH 未保存离开保护验收\n')
  await bag.bridge.win.webContents.executeJavaScript(
    `document.documentElement.dataset.hostRecoveryAudit = 'pending'`,
  )
  bag.previousHostPid = bag.bridge.supervisor.getState().diagnostics.pid
  bag.recovery = bag.bridge.supervisor.retry()
  bag.disconnectedAlert = (await bag.bridge.win.webContents.executeJavaScript(`(async () => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (document.querySelector('.project-workspace-alert')?.textContent?.includes('MyDSH 运行时不可用')) return true
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return false
    })()`)) as boolean
  bag.recoveredHost = await bag.recovery
  await bag.bridge.getHostStateRender()
  bag.hostRecoveryRetainsEditor =
    bag.guardedDraftReady &&
    bag.disconnectedAlert &&
    bag.recoveredHost.kind === 'ready' &&
    bag.recoveredHost.diagnostics.pid !== bag.previousHostPid &&
    ((await bag.bridge.win.webContents.executeJavaScript(FILES_SCM_SCRIPT_5)) as boolean)
  console.log('desktop-shell-verify-local: host-recovery-retains-editor', {
    ready: bag.hostRecoveryRetainsEditor,
    guardedDraftReady: bag.guardedDraftReady,
    disconnectedAlert: bag.disconnectedAlert,
    runtimeState: bag.recoveredHost.kind,
    processChanged: bag.recoveredHost.diagnostics.pid !== bag.previousHostPid,
    view: await bag.bridge.win.webContents.executeJavaScript(`({
        alert: document.querySelector('.project-workspace-alert')?.textContent,
        dirty: document.querySelector('.file-dirty-status')?.textContent,
        editor: document.querySelector('.code-viewer[data-file-path="README.md"] .cm-content')?.textContent?.slice(0, 150),
      })`),
  })
  if (!bag.hostRecoveryRetainsEditor)
    throw new Error('运行核心重启后的工作台与未保存文件恢复验收失败')
  bag.navigationGuardReady =
    bag.guardedDraftReady &&
    ((await bag.bridge.win.webContents.executeJavaScript(FILES_SCM_SCRIPT_6)) as boolean)
  if (bag.navigationGuardReady) {
    await new Promise(resolve => {
      setTimeout(resolve, 100)
    })
    if (process.platform === 'win32')
      await clickTrustedElement(bag.bridge.win, '[data-window-action="close"]')
    else bag.bridge.win.close()
  }
  bag.closeGuardReady =
    bag.navigationGuardReady &&
    ((await bag.bridge.win.webContents.executeJavaScript(FILES_SCM_SCRIPT_7)) as boolean)
  bag.fileUnsavedGuardReady =
    bag.navigationGuardReady && bag.closeGuardReady && !bag.bridge.win.isDestroyed()
}

/** 执行 files-scm 验收套件第 4 阶段。 */
export async function runFilesScmStep4(bag: LocalVerifyState): Promise<void> {
  console.log('desktop-shell-verify-local: file-unsaved-guard', {
    ready: bag.fileUnsavedGuardReady,
    navigationGuardReady: bag.navigationGuardReady,
    closeGuardReady: bag.closeGuardReady,
    view: await bag.bridge.win.webContents.executeJavaScript(
      `document.querySelector('[data-view][aria-current="page"]')?.getAttribute('data-view') ?? null`,
    ),
    state: await bag.bridge.win.webContents.executeJavaScript(`({
        path: document.querySelector('[data-file-path]')?.getAttribute('data-file-path'),
        dialog: document.querySelector('.unsaved-dialog')?.textContent?.trim(),
        dialogOpen: document.querySelector('.unsaved-dialog')?.open,
        packageDisabled: [...document.querySelectorAll('[aria-label="项目文件树"] .tree-row')]
          .find(element => element.getAttribute('title') === 'package.json')?.disabled,
      })`),
  })
  if (!bag.fileUnsavedGuardReady) throw new Error('核心恢复后的未保存文件保护验收失败')
  // 右侧栏目按当前模式列出可用项；点击前先记录实际选项，缺失时能直接归因。
  console.log(
    'desktop-shell-verify-local: right-island-options',
    await bag.bridge.win.webContents.executeJavaScript(
      `[...document.querySelectorAll('[data-island-id]')].map(item => item.getAttribute('data-island-id'))`,
    ),
  )
  await openRightVerificationPanel(bag.bridge.win, 'file-outline-tasks')
  bag.projectSearchOpened = (await bag.bridge.win.webContents.executeJavaScript(`(() => {
      const trigger = document.querySelector('button[aria-label^="搜索项目内容"]')
      if (!(trigger instanceof HTMLButtonElement)) return false
      trigger.click()
      return true
    })()`)) as boolean
  bag.contentSearchState =
    bag.projectSearchOpened &&
    ((await bag.bridge.win.webContents.executeJavaScript(FILES_SCM_SCRIPT_8)) as
      false | { ready: boolean; resultPath: string; stage: string })
  bag.contentSearchReady = bag.contentSearchState !== false && bag.contentSearchState.ready
  bag.projectTasksOnlyReady = (await bag.bridge.win.webContents.executeJavaScript(`(() => {
      const panel = document.querySelector('.info-island.file-info-island')
      return panel?.querySelector('[data-project-tasks]') !== null
        && panel?.querySelector('.file-outline-panel') === null
        && document.querySelector('.right-island-tabs [aria-selected="true"]')?.getAttribute('aria-label') === '脚本'
    })()`)) as boolean
  console.log('desktop-shell-verify-local: content-search-tasks', {
    contentSearchReady: bag.contentSearchReady,
    projectTasksOnlyReady: bag.projectTasksOnlyReady,
    projectSearchOpened: bag.projectSearchOpened,
    contentSearchState: bag.contentSearchState,
  })
}

/** 执行 files-scm 验收套件第 5 阶段。 */
export async function runFilesScmStep5(bag: LocalVerifyState): Promise<void> {
  if (!bag.contentSearchReady) {
    writeFileSync(
      bag.bridge.artifactPath('verify-content-search-failed.png'),
      (await captureVerifiedPage(bag.bridge.win)).toPNG(),
    )
    console.log(
      'desktop-shell-verify-local: content-search-failure',
      await bag.bridge.win.webContents.executeJavaScript(`(() => ({
        view: document.querySelector('[data-view][aria-current="page"]')?.getAttribute('data-view'),
        projectSearch: document.querySelector('.project-search-backdrop')?.textContent,
        leftPanel: document.querySelector('.navigation-island')?.textContent,
        dialogs: [...document.querySelectorAll('dialog[open], [role="dialog"]')].map(dialog => dialog.textContent?.slice(0, 400)),
      }))()`),
    )
    throw new Error('项目内容搜索验收失败：' + JSON.stringify(bag.contentSearchState))
  }
  bag.projectTasksAudit = (await bag.bridge.win.webContents.executeJavaScript(
    buildFilesScmScript9(
      JSON.stringify(process.platform === 'win32' ? 'pwsh.exe' : 'cat'),
      JSON.stringify(
        process.platform === 'win32'
          ? [
              '-NoLogo',
              '-NoProfile',
              '-Command',
              'while ($null -ne ($line = [Console]::ReadLine())) { [Console]::WriteLine($line) }',
            ].join('\n')
          : '',
      ),
    ),
  )) as {
    ready: boolean
    stage: string
    taskSuggestionsRemoved?: boolean
    detail?: string
    dialogOpen?: boolean
  }
  bag.projectTasksReady = bag.projectTasksAudit.ready
  bag.taskSuggestionsRemoved = bag.projectTasksAudit.taskSuggestionsRemoved === true
  console.log('desktop-shell-verify-local: project-tasks', bag.projectTasksAudit)
  bag.fileCapture = 'verify-files.png'
  writeFileSync(
    bag.bridge.artifactPath(bag.fileCapture),
    (await captureVerifiedPage(bag.bridge.win)).toPNG(),
  )
  bag.editorSize = bag.bridge.win.getSize()
  bag.editorScheme = bag.bridge.settingsStore.read().colorScheme
}

/** 执行 files-scm 验收套件第 6 阶段。 */
export async function runFilesScmStep6(bag: LocalVerifyState): Promise<void> {
  try {
    bag.bridge.win.setSize(1800, 1000)
    bag.bridge.settingsController.publish(bag.bridge.settingsStore.update({ colorScheme: 'light' }))
    await waitForWindowSize(bag.bridge.win, 1800, 1000)
    await waitForColorScheme(bag.bridge.win, 'light')
    const editorLayout = (await bag.bridge.win.webContents.executeJavaScript(
      FILES_SCM_SCRIPT_10,
    )) as {
      viewer: boolean
      fontSize: string | null
      lineHeight: string | null
      noLegacyHeader: boolean
      statusFits: boolean
      statusBottom: number | null
      viewerBottom: number | null
      selectedKind?: string
      noOverflow: boolean
    }
    console.log('desktop-shell-verify-local: editor-layout', editorLayout)
    writeFileSync(
      bag.bridge.artifactPath('verify-editor-light-large.png'),
      (await captureVerifiedPage(bag.bridge.win)).toPNG(),
    )
    if (
      !editorLayout.viewer ||
      editorLayout.fontSize !== '14px' ||
      editorLayout.lineHeight !== '22px' ||
      !editorLayout.noLegacyHeader ||
      !editorLayout.statusFits ||
      editorLayout.selectedKind !== 'file' ||
      !editorLayout.noOverflow
    )
      throw new Error(
        '放大窗口的编辑器排版、统一标签或底部状态栏异常：' + JSON.stringify(editorLayout),
      )
    await emulateVerificationMedia(bag.bridge.win, [{ name: 'forced-colors', value: 'active' }])
    try {
      const forcedCursor = (await bag.bridge.win.webContents.executeJavaScript(
        FILES_SCM_SCRIPT_11,
      )) as boolean
      if (!forcedCursor) throw new Error('强制色彩模式下编辑器光标不可见')
    } finally {
      await emulateVerificationMedia(bag.bridge.win)
    }
  } finally {
    bag.bridge.win.setSize(bag.editorSize[0] ?? 1280, bag.editorSize[1] ?? 800)
    bag.bridge.settingsController.publish(
      bag.bridge.settingsStore.update({ colorScheme: bag.editorScheme }),
    )
    await waitForWindowSize(bag.bridge.win, bag.editorSize[0] ?? 1280, bag.editorSize[1] ?? 800)
    await waitForColorScheme(bag.bridge.win, bag.editorScheme)
  }
  await openRightVerificationPanel(bag.bridge.win, 'git-history')
  bag.sourceControlPrepared = (await bag.bridge.win.webContents.executeJavaScript(
    FILES_SCM_SCRIPT_12,
  )) as boolean
  if (!bag.sourceControlPrepared) throw new Error('隔离验收仓库没有出现可暂存的 scratch.md')
  await clickTrustedElement(bag.bridge.win, 'button[aria-label="暂存 scratch.md"]')
}

/** 执行 files-scm 验收套件第 7 阶段。 */
export async function runFilesScmStep7(bag: LocalVerifyState): Promise<void> {
  bag.sourceControlStaged = (await bag.bridge.win.webContents.executeJavaScript(
    FILES_SCM_SCRIPT_13,
  )) as boolean
  if (!bag.sourceControlStaged) throw new Error('单文件暂存没有进入暂存区')
  bag.gitGroupsReady = (await bag.bridge.win.webContents.executeJavaScript(
    FILES_SCM_SCRIPT_14,
  )) as boolean
  if (!bag.gitGroupsReady) throw new Error('Git 暂存与更改分组未能独立收起和恢复')
  console.log('desktop-shell-verify-local: git-groups', { gitGroupsReady: bag.gitGroupsReady })
  bag.gitListScrollable = (await bag.bridge.win.webContents.executeJavaScript(
    FILES_SCM_SCRIPT_15,
  )) as boolean
  if (!bag.gitListScrollable) throw new Error('Git 更改列表无法在内容超出时滚动')
  await verifySourceControlSections(bag.bridge.win, async name => {
    writeFileSync(
      bag.bridge.artifactPath(name),
      (await captureVerifiedPage(bag.bridge.win)).toPNG(),
    )
  })
  await verifyGitAiPreparation(bag.bridge.win)
  if (bag.bridge.verifyProject === undefined) throw new Error('缺少隔离验收项目')
  await verifyBulkUnstage(bag.bridge.win, async () => {
    const project = bag.bridge.getProjects().find(item => item.cwd === bag.bridge.verifyProject)
    if (!project) throw new Error('隔离验收项目尚未授权')
    writeFileSync(join(bag.bridge.verifyProject, 'scratch.md'), '确认期间更新暂存内容\n')
    await bag.bridge.runtimeCall('mydshWorkspace/call', {
      projectId: project.id,
      operation: 'gitStage',
      payload: { relativePaths: ['scratch.md'] },
    })
  })
  bag.sourceControlUnstaged = (await bag.bridge.win.webContents.executeJavaScript(
    FILES_SCM_SCRIPT_16,
  )) as boolean
  if (!bag.sourceControlUnstaged) throw new Error('确认取消全部暂存后未显示工作区更改和结果提示')
  await clickTrustedElement(bag.bridge.win, 'button[aria-label="暂存 scratch.md"]')
  bag.sourceControlRestaged = (await bag.bridge.win.webContents.executeJavaScript(`(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const unstage = document.querySelector('button[aria-label="取消暂存 scratch.md"]')
        if (unstage instanceof HTMLButtonElement && !unstage.disabled) return true
        await sleep(25)
      }
      return false
    })()`)) as boolean
  if (!bag.sourceControlRestaged) throw new Error('单文件重新暂存失败')
  bag.verificationCommitMessage = '验收 Source Control 写路径'
  bag.commitMessageReady = (await bag.bridge.win.webContents.executeJavaScript(
    buildFilesScmScript17(
      JSON.stringify(bag.verificationCommitMessage),
      JSON.stringify(bag.verificationCommitMessage),
    ),
  )) as boolean
  if (!bag.commitMessageReady) throw new Error('无法为隔离验收提交填写消息')
  bag.verificationIndexLock = join(bag.bridge.verifyProject, '.git', 'index.lock')
  bag.sourceControlFailureReady = false
  writeFileSync(bag.verificationIndexLock, 'MyDSH verifier\n', { mode: 0o600 })
  try {
    await clickTrustedElement(bag.bridge.win, '.scm-commit-button')
    bag.sourceControlFailureReady = (await bag.bridge.win.webContents.executeJavaScript(
      buildFilesScmScript18(JSON.stringify(bag.verificationCommitMessage)),
    )) as boolean
  } finally {
    rmSync(bag.verificationIndexLock, { force: true })
  }
  console.log('desktop-shell-verify-local: source-control-failure', bag.sourceControlFailureReady)
  await clickTrustedElement(bag.bridge.win, '.scm-commit-button')
  bag.sourceControlWriteReady = (await bag.bridge.win.webContents.executeJavaScript(
    FILES_SCM_SCRIPT_19,
  )) as boolean
}

/** 执行 files-scm 验收套件第 8 阶段。 */
export async function runFilesScmStep8(bag: LocalVerifyState): Promise<void> {
  console.log('desktop-shell-verify-local: source-control-write', bag.sourceControlWriteReady)
  bag.changedDirectory = join(
    bag.bridge.verifyProject,
    'src',
    ...Array.from({ length: 39 }, (_, index) => `level-${String(index + 1).padStart(2, '0')}`),
  )
  writeFileSync(
    join(bag.changedDirectory, 'ApplicationSecurityConfiguration.java'),
    'package verification;\npublic final class ApplicationSecurityConfiguration { private boolean enabled = true;\n' +
      Array.from({ length: 60 }, (_, index) => `  private int value${String(index)};`).join('\n') +
      '\n}\n',
  )
  writeFileSync(join(bag.changedDirectory, 'index.ts'), 'export const ready = false\n')
  await verifyGitRefresh(bag.bridge.win)
  bag.sourceControlView = (await bag.bridge.win.webContents.executeJavaScript(
    FILES_SCM_SCRIPT_20,
  )) as {
    sourceControlReady: boolean
    uncommittedChangesReady: boolean
    contextualRightPanelReady: boolean
    diffResponsiveReady: boolean
  }
  bag.fileListBoundsCheck = FILES_SCM_SCRIPT_21
  bag.changeFileListReadable = (await bag.bridge.win.webContents.executeJavaScript(
    bag.fileListBoundsCheck,
  )) as boolean
  bag.diffCapture = 'verify-diff.png'
  writeFileSync(
    bag.bridge.artifactPath(bag.diffCapture),
    (await captureVerifiedPage(bag.bridge.win)).toPNG(),
  )
  bag.gitViewBounds = bag.bridge.win.getBounds()
  bag.gitViewTheme = nativeTheme.themeSource
  try {
    bag.bridge.win.setSize(1_440, 900)
    nativeTheme.themeSource = 'dark'
    await waitForWindowSize(bag.bridge.win, 1_440, 900)
    await waitForNativeTheme(bag.bridge.win, 'dark')
    bag.changeFileListReadable &&= (await bag.bridge.win.webContents.executeJavaScript(
      bag.fileListBoundsCheck,
    )) as boolean
    writeFileSync(
      bag.bridge.artifactPath('verify-git-large-dark.png'),
      (await captureVerifiedPage(bag.bridge.win)).toPNG(),
    )
  } finally {
    nativeTheme.themeSource = bag.gitViewTheme
    bag.bridge.win.setBounds(bag.gitViewBounds)
    await waitForNativeTheme(bag.bridge.win, nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
    await waitForWindowSize(bag.bridge.win, bag.gitViewBounds.width, bag.gitViewBounds.height)
  }
  console.log('desktop-shell-verify-local: source-control-view', bag.sourceControlView)
  bag.diffToolsScheme = bag.bridge.settingsStore.read().colorScheme
}
