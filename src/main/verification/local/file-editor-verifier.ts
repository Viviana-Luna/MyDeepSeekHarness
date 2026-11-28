/**
 * 文件树、代码编辑器保存冲突、Runtime 故障恢复、未保存保护与项目脚本验收器。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  captureVerifiedPage,
  clickTrustedElement,
  emulateVerificationMedia,
} from '../desktop-verifier.ts'
import {
  openRightVerificationPanel,
  waitForColorScheme,
  waitForCondition,
  waitForWindowSize,
} from '../host-verify-context.ts'
import {
  EXTERNAL_FILE_CONFLICT_PROBE,
  FILE_TREE_AND_VIEWER_PROBE,
  FOCUS_README_EDITOR_PROBE,
  FORCED_COLORS_EDITOR_CURSOR_PROBE,
  HOST_RECOVERY_RETAINS_DRAFT_PROBE,
  LARGE_LIGHT_EDITOR_LAYOUT_PROBE,
  PROJECT_CONTENT_SEARCH_PROBE,
  RELOADED_EXTERNAL_FILE_PROBE,
  UNSAVED_TAB_CLOSE_GUARD_PROBE,
  UNSAVED_WINDOW_CLOSE_GUARD_PROBE,
  buildProjectTaskTerminalLifecycleProbe,
} from './file-editor-probes.ts'
import type { LocalVerifyState } from './state.ts'

async function replaceReadmeEditorContent(
  state: LocalVerifyState,
  content: string,
): Promise<boolean> {
  const focused = (await state.bridge.win.webContents.executeJavaScript(
    FOCUS_README_EDITOR_PROBE,
  )) as boolean
  if (!focused) return false
  const modifier = process.platform === 'darwin' ? 'meta' : 'control'
  state.bridge.win.webContents.sendInputEvent({
    type: 'keyDown',
    keyCode: 'a',
    modifiers: [modifier],
  })
  state.bridge.win.webContents.sendInputEvent({
    type: 'keyUp',
    keyCode: 'a',
    modifiers: [modifier],
  })
  await state.bridge.win.webContents.executeJavaScript(`(async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((window.getSelection()?.toString().length ?? 0) > 0) return
      await new Promise(resolve => setTimeout(resolve, 15))
    }
    document.execCommand('selectAll')
  })()`)
  await state.bridge.win.webContents.insertText(content)
  return (await state.bridge.win.webContents.executeJavaScript(`(async () => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (document.querySelector('.file-dirty-status')?.textContent?.trim() === '未保存') return true
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return false
  })()`)) as boolean
}

/** 验证文件树浏览、编辑器磁盘保存与外部修改冲突重装。 */
export async function verifyFileTreeAndEditorConflict(state: LocalVerifyState): Promise<void> {
  state.fileView = (await state.bridge.win.webContents.executeJavaScript(
    FILE_TREE_AND_VIEWER_PROBE,
  )) as Record<string, unknown>
  console.log('desktop-shell-verify-local: file-view', state.fileView)
  if (state.bridge.verifyProject === undefined) throw new Error('缺少隔离验收项目')

  const readmePath = join(state.bridge.verifyProject, 'README.md')
  const originalReadme = readFileSync(readmePath, 'utf8')
  const savedReadme = '# MyDSH 编辑器保存验收\n'
  const localDraft = '# MyDSH 本地未保存草稿\n'
  const externalReadme = '# MyDSH 外部修改验收\n'
  state.fileEditorReady = false

  try {
    const draftReady = await replaceReadmeEditorContent(state, savedReadme)
    if (draftReady) await clickTrustedElement(state.bridge.win, '.file-save-button')
    const diskSaved =
      draftReady &&
      (await waitForCondition(() => readFileSync(readmePath, 'utf8') === savedReadme, 10_000))
    const savedStateReady =
      diskSaved &&
      ((await state.bridge.win.webContents.executeJavaScript(`(async () => {
        for (let attempt = 0; attempt < 80; attempt += 1) {
          if (document.querySelector('.file-dirty-status') === null
            && document.querySelector('.file-conflict-panel') === null) return true
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        return false
      })()`)) as boolean)

    const conflictDraftReady =
      savedStateReady && (await replaceReadmeEditorContent(state, localDraft))
    if (conflictDraftReady) {
      writeFileSync(readmePath, externalReadme, { mode: 0o600 })
      await clickTrustedElement(state.bridge.win, '.file-save-button')
    }
    const conflictReady =
      conflictDraftReady &&
      ((await state.bridge.win.webContents.executeJavaScript(
        EXTERNAL_FILE_CONFLICT_PROBE,
      )) as boolean)
    const externalPreserved = readFileSync(readmePath, 'utf8') === externalReadme
    const reloadClicked =
      conflictReady &&
      ((await state.bridge.win.webContents.executeJavaScript(`(() => {
        const reload = [...document.querySelectorAll('.file-conflict-panel button')]
          .find(button => button.textContent?.trim() === '重新载入')
        if (!(reload instanceof HTMLButtonElement)) return false
        reload.click()
        return true
      })()`)) as boolean)
    const reloaded =
      reloadClicked &&
      ((await state.bridge.win.webContents.executeJavaScript(
        RELOADED_EXTERNAL_FILE_PROBE,
      )) as boolean)
    state.fileEditorReady =
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
    writeFileSync(readmePath, originalReadme, { mode: 0o600 })
  }
  console.log('desktop-shell-verify-local: file-editor', state.fileEditorReady)
}

/** 验证后台 Runtime 进程重启恢复后保留编辑器草稿，并拦截标签关闭与窗口关闭。 */
export async function verifyHostRecoveryAndUnsavedGuards(state: LocalVerifyState): Promise<void> {
  const guardedDraftReady = await replaceReadmeEditorContent(state, '# MyDSH 未保存离开保护验收\n')
  await state.bridge.win.webContents.executeJavaScript(
    `document.documentElement.dataset.hostRecoveryAudit = 'pending'`,
  )
  const previousHostPid = state.bridge.supervisor.getState().diagnostics.pid
  const recovery = state.bridge.supervisor.retry()
  const disconnectedAlert = (await state.bridge.win.webContents.executeJavaScript(`(async () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (document.querySelector('.project-workspace-alert')?.textContent?.includes('MyDSH 运行时不可用')) return true
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return false
  })()`)) as boolean
  const recoveredHost = await recovery
  await state.bridge.getHostStateRender()

  state.hostRecoveryRetainsEditor =
    guardedDraftReady &&
    disconnectedAlert &&
    recoveredHost.kind === 'ready' &&
    recoveredHost.diagnostics.pid !== previousHostPid &&
    ((await state.bridge.win.webContents.executeJavaScript(
      HOST_RECOVERY_RETAINS_DRAFT_PROBE,
    )) as boolean)
  console.log('desktop-shell-verify-local: host-recovery-retains-editor', {
    ready: state.hostRecoveryRetainsEditor,
    guardedDraftReady,
    disconnectedAlert,
    runtimeState: recoveredHost.kind,
    processChanged: recoveredHost.diagnostics.pid !== previousHostPid,
  })
  if (!state.hostRecoveryRetainsEditor) {
    throw new Error('运行核心重启后的工作台与未保存文件恢复验收失败')
  }

  const navigationGuardReady =
    guardedDraftReady &&
    ((await state.bridge.win.webContents.executeJavaScript(
      UNSAVED_TAB_CLOSE_GUARD_PROBE,
    )) as boolean)
  if (navigationGuardReady) {
    await new Promise(resolve => {
      setTimeout(resolve, 100)
    })
    if (process.platform === 'win32') {
      await clickTrustedElement(state.bridge.win, '[data-window-action="close"]')
    } else {
      state.bridge.win.close()
    }
  }
  const closeGuardReady =
    navigationGuardReady &&
    ((await state.bridge.win.webContents.executeJavaScript(
      UNSAVED_WINDOW_CLOSE_GUARD_PROBE,
    )) as boolean)
  state.fileUnsavedGuardReady =
    navigationGuardReady && closeGuardReady && !state.bridge.win.isDestroyed()
  console.log('desktop-shell-verify-local: file-unsaved-guard', {
    ready: state.fileUnsavedGuardReady,
    navigationGuardReady,
    closeGuardReady,
  })
  if (!state.fileUnsavedGuardReady) throw new Error('核心恢复后的未保存文件保护验收失败')
}

async function verifyLargeLightEditorAndForcedColors(state: LocalVerifyState): Promise<void> {
  const editorSize = state.bridge.win.getSize()
  const editorScheme = state.bridge.settingsStore.read().colorScheme
  try {
    state.bridge.win.setSize(1800, 1000)
    state.bridge.settingsController.publish(
      state.bridge.settingsStore.update({ colorScheme: 'light' }),
    )
    await waitForWindowSize(state.bridge.win, 1800, 1000)
    await waitForColorScheme(state.bridge.win, 'light')
    const editorLayout = (await state.bridge.win.webContents.executeJavaScript(
      LARGE_LIGHT_EDITOR_LAYOUT_PROBE,
    )) as {
      viewer: boolean
      fontSize: string | null
      lineHeight: string | null
      noLegacyHeader: boolean
      statusFits: boolean
      selectedKind?: string
      noOverflow: boolean
    }
    console.log('desktop-shell-verify-local: editor-layout', editorLayout)
    writeFileSync(
      state.bridge.artifactPath('verify-editor-light-large.png'),
      (await captureVerifiedPage(state.bridge.win)).toPNG(),
    )
    if (
      !editorLayout.viewer ||
      editorLayout.fontSize !== '14px' ||
      editorLayout.lineHeight !== '22px' ||
      !editorLayout.noLegacyHeader ||
      !editorLayout.statusFits ||
      editorLayout.selectedKind !== 'file' ||
      !editorLayout.noOverflow
    ) {
      throw new Error(
        `放大窗口的编辑器排版、统一标签或底部状态栏异常：${JSON.stringify(editorLayout)}`,
      )
    }
    await emulateVerificationMedia(state.bridge.win, [{ name: 'forced-colors', value: 'active' }])
    try {
      const forcedCursor = (await state.bridge.win.webContents.executeJavaScript(
        FORCED_COLORS_EDITOR_CURSOR_PROBE,
      )) as boolean
      if (!forcedCursor) throw new Error('强制色彩模式下编辑器光标不可见')
    } finally {
      await emulateVerificationMedia(state.bridge.win)
    }
  } finally {
    state.bridge.win.setSize(editorSize[0] ?? 1280, editorSize[1] ?? 800)
    state.bridge.settingsController.publish(
      state.bridge.settingsStore.update({ colorScheme: editorScheme }),
    )
    await waitForWindowSize(state.bridge.win, editorSize[0] ?? 1280, editorSize[1] ?? 800)
    await waitForColorScheme(state.bridge.win, editorScheme)
  }
}

/** 验证全文内容搜索、项目脚本任务运行与放大窗口/高对比模式下的编辑器排版。 */
export async function verifyProjectSearchTasksAndEditorLayout(
  state: LocalVerifyState,
): Promise<void> {
  await openRightVerificationPanel(state.bridge.win, 'file-outline-tasks')
  const projectSearchOpened = (await state.bridge.win.webContents.executeJavaScript(`(() => {
    const trigger = document.querySelector('button[aria-label^="搜索项目内容"]')
    if (!(trigger instanceof HTMLButtonElement)) return false
    trigger.click()
    return true
  })()`)) as boolean
  const contentSearchState =
    projectSearchOpened &&
    ((await state.bridge.win.webContents.executeJavaScript(PROJECT_CONTENT_SEARCH_PROBE)) as
      false | { ready: boolean; resultPath: string; stage: string })
  state.contentSearchReady = contentSearchState !== false && contentSearchState.ready
  state.projectTasksOnlyReady = (await state.bridge.win.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector('.info-island.file-info-island')
    return panel?.querySelector('[data-project-tasks]') !== null
      && panel?.querySelector('.file-outline-panel') === null
      && document.querySelector('.right-island-tabs [aria-selected="true"]')?.getAttribute('aria-label') === '脚本'
  })()`)) as boolean
  console.log('desktop-shell-verify-local: content-search-tasks', {
    contentSearchReady: state.contentSearchReady,
    projectTasksOnlyReady: state.projectTasksOnlyReady,
    contentSearchState,
  })
  if (!state.contentSearchReady) {
    writeFileSync(
      state.bridge.artifactPath('verify-content-search-failed.png'),
      (await captureVerifiedPage(state.bridge.win)).toPNG(),
    )
    throw new Error(`项目内容搜索验收失败：${JSON.stringify(contentSearchState)}`)
  }

  const taskExecutable = process.platform === 'win32' ? 'pwsh.exe' : 'cat'
  const taskArguments =
    process.platform === 'win32'
      ? [
          '-NoLogo',
          '-NoProfile',
          '-Command',
          'while ($null -ne ($line = [Console]::ReadLine())) { [Console]::WriteLine($line) }',
        ].join('\n')
      : ''
  state.projectTasksAudit = (await state.bridge.win.webContents.executeJavaScript(
    buildProjectTaskTerminalLifecycleProbe(taskExecutable, taskArguments),
  )) as {
    ready: boolean
    stage: string
    taskSuggestionsRemoved?: boolean
  }
  state.projectTasksReady = state.projectTasksAudit.ready
  state.taskSuggestionsRemoved = state.projectTasksAudit.taskSuggestionsRemoved === true
  console.log('desktop-shell-verify-local: project-tasks', state.projectTasksAudit)

  state.fileCapture = 'verify-files.png'
  writeFileSync(
    state.bridge.artifactPath(state.fileCapture),
    (await captureVerifiedPage(state.bridge.win)).toPNG(),
  )
  await verifyLargeLightEditorAndForcedColors(state)
}
