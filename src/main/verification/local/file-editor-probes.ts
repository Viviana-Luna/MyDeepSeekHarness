/**
 * 文件树、代码编辑器、外部冲突保护、全文搜索与项目脚本终端的渲染进程探测脚本。
 */

/** 验证文件树深层展开、语法高亮、光标色彩、标签固定与大图查看器。 */
export const FILE_TREE_AND_VIEWER_PROBE = `(async () => {
  const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
  const waitFor = async predicate => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const value = predicate()
      if (value) return value
      await sleep(25)
    }
    return null
  }
  document.querySelector('[data-view="files"]')?.click()
  const readme = await waitFor(() => [...document.querySelectorAll('[aria-label="项目文件树"] .tree-row')]
    .find(element => element.getAttribute('title') === 'README.md'))
  const fileTreeReady = readme instanceof HTMLButtonElement
  if (readme instanceof HTMLButtonElement) readme.click()
  let fileViewer = await waitFor(() => document.querySelector('.code-editor[data-language-ready="true"] .cm-line'))
  if (!(fileViewer instanceof HTMLElement)) {
    const currentReadme = [...document.querySelectorAll('[aria-label="项目文件树"] .tree-row')]
      .find(element => element.getAttribute('title') === 'README.md')
    if (currentReadme instanceof HTMLButtonElement) currentReadme.click()
    fileViewer = await waitFor(() => document.querySelector('.code-editor[data-language-ready="true"] .cm-line'))
  }
  const fileViewerReady = fileViewer instanceof HTMLElement
  const quickOpenTrigger = document.querySelector('button[aria-label^="快速打开文件"]')
  if (quickOpenTrigger instanceof HTMLButtonElement) quickOpenTrigger.click()
  const quickOpenInput = await waitFor(() => document.querySelector('.quick-open-input input'))
  if (quickOpenInput instanceof HTMLInputElement) {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    valueSetter?.call(quickOpenInput, 'README')
    quickOpenInput.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'README' }))
  }
  const quickOpenResult = await waitFor(() => document.querySelector('.quick-open-results button'))
  if (quickOpenResult instanceof HTMLButtonElement) quickOpenResult.click()
  const quickOpenClosed = await waitFor(() => document.querySelector('.quick-open-dialog') === null)
  const quickOpenReady = quickOpenTrigger instanceof HTMLButtonElement
    && quickOpenInput instanceof HTMLInputElement
    && quickOpenResult instanceof HTMLButtonElement
    && quickOpenClosed === true
  const deepSegments = [
    'src',
    ...Array.from({ length: 39 }, (_, index) => 'level-' + String(index + 1).padStart(2, '0')),
  ]
  let deepRelativePath = ''
  let deepestDirectory = null
  let deepDirectoriesReady = true
  for (const segment of deepSegments) {
    deepRelativePath = deepRelativePath === '' ? segment : deepRelativePath + '/' + segment
    const directoryPath = deepRelativePath
    const directory = await waitFor(() => [...document.querySelectorAll('[aria-label="项目文件树"] .tree-row')]
      .find(element => element.getAttribute('title') === directoryPath))
    if (!(directory instanceof HTMLButtonElement)) {
      deepDirectoriesReady = false
      break
    }
    directory.click()
    deepestDirectory = directory
  }
  const deepFilePath = deepRelativePath
    + '/DeepWorkspaceControllerWithAnIntentionallyLongNameForHorizontalTreeVerification.java'
  let deepFile = await waitFor(() => [...document.querySelectorAll('[aria-label="项目文件树"] .tree-row')]
    .find(element => element.getAttribute('title') === deepFilePath))
  const fileTree = document.querySelector('[aria-label="项目文件树"] .file-tree')
  let deepFileTreeReady = false
  let syntaxHighlightingReady = false
  let fileCursorReady = false
  let fileCursorDetails = null
  let fileTabsReady = false
  if (deepDirectoriesReady
    && deepestDirectory instanceof HTMLButtonElement
    && deepFile instanceof HTMLButtonElement
    && fileTree instanceof HTMLElement) {
    fileTree.scrollLeft = fileTree.scrollWidth
    const expandedScrollLeft = fileTree.scrollLeft
    deepestDirectory.click()
    const collapsed = await waitFor(() => deepestDirectory?.getAttribute('aria-expanded') === 'false')
    const collapsedScrollLeft = fileTree.scrollLeft
    deepestDirectory.click()
    deepFile = await waitFor(() => [...document.querySelectorAll('[aria-label="项目文件树"] .tree-row')]
      .find(element => element.getAttribute('title') === deepFilePath))
    if (deepFile instanceof HTMLButtonElement) deepFile.click()
    const selected = await waitFor(() => [...document.querySelectorAll('[aria-label="项目文件树"] .tree-row[aria-current="page"]')]
      .find(element => element.getAttribute('title') === deepFilePath))
    const selectedIcon = selected?.querySelector('[data-icon="code"]')
    const selectedName = selected?.querySelector('.tree-row__name')
    deepFileTreeReady = collapsed === true
      && fileTree.scrollWidth >= fileTree.clientWidth * 3
      && expandedScrollLeft > 0
      && collapsedScrollLeft > 0
      && selected instanceof HTMLButtonElement
      && selected.getBoundingClientRect().width >= fileTree.clientWidth
      && selectedIcon?.textContent === 'J'
      && selectedName instanceof HTMLElement
      && getComputedStyle(selectedName).textOverflow === 'clip'
    const codeEditor = await waitFor(() => {
      const candidate = document.querySelector('.code-editor[data-language="java"][data-language-ready="true"]')
      return candidate instanceof HTMLElement && ['.tok-keyword', '.tok-type', '.tok-string', '.tok-comment']
        .every(selector => candidate.querySelector(selector) instanceof HTMLElement) ? candidate : null
    })
    const editor = codeEditor?.querySelector('.cm-editor')
    const content = codeEditor?.querySelector('.cm-content')
    const keyword = codeEditor?.querySelector('.tok-keyword')
    const type = codeEditor?.querySelector('.tok-type')
    const string = codeEditor?.querySelector('.tok-string')
    const comment = codeEditor?.querySelector('.tok-comment')
    if (codeEditor instanceof HTMLElement
      && editor instanceof HTMLElement
      && content instanceof HTMLElement
      && keyword instanceof HTMLElement
      && type instanceof HTMLElement
      && string instanceof HTMLElement
      && comment instanceof HTMLElement) {
      content.focus()
      const cursor = await waitFor(() => {
        const candidate = editor.querySelector('.cm-cursor-primary')
        return candidate instanceof HTMLElement && editor.classList.contains('cm-focused')
          && getComputedStyle(candidate).display === 'block'
          && candidate.getBoundingClientRect().height > 0 ? candidate : null
      }) ?? editor.querySelector('.cm-cursor-primary')
      const root = document.documentElement
      const originalScheme = root.getAttribute('data-color-scheme')
      root.setAttribute('data-color-scheme', 'dark')
      const darkKeyword = getComputedStyle(keyword).color
      const darkText = getComputedStyle(content).color
      const darkBackground = getComputedStyle(editor).backgroundColor
      const darkCursor = cursor instanceof HTMLElement ? getComputedStyle(cursor).borderLeftColor : ''
      root.setAttribute('data-color-scheme', 'light')
      const lightKeyword = getComputedStyle(keyword).color
      const lightText = getComputedStyle(content).color
      const lightBackground = getComputedStyle(editor).backgroundColor
      const lightCursor = cursor instanceof HTMLElement ? getComputedStyle(cursor).borderLeftColor : ''
      fileCursorDetails = cursor instanceof HTMLElement ? {
        focused: editor.classList.contains('cm-focused'),
        contentFocused: document.activeElement === content,
        display: getComputedStyle(cursor).display,
        height: cursor.getBoundingClientRect().height,
        borderWidth: getComputedStyle(cursor).borderLeftWidth,
        darkCursor,
        lightCursor,
      } : { missing: true }
      fileCursorReady = cursor instanceof HTMLElement
        && editor.classList.contains('cm-focused')
        && getComputedStyle(cursor).display === 'block'
        && cursor.getBoundingClientRect().height > 0
        && parseFloat(getComputedStyle(cursor).borderLeftWidth) >= 1.5
        && darkCursor === 'rgb(244, 246, 250)'
        && lightCursor === 'rgb(24, 26, 31)'
      if (originalScheme === null) root.removeAttribute('data-color-scheme')
      else root.setAttribute('data-color-scheme', originalScheme)
      syntaxHighlightingReady = darkKeyword !== darkText
        && lightKeyword !== lightText
        && darkKeyword !== lightKeyword
        && darkBackground === 'rgb(21, 23, 27)'
        && lightBackground === 'rgb(251, 251, 252)'
        && codeEditor.querySelectorAll('.cm-line').length < 500
        && document.querySelector('.code-lines') === null
    }
    const breadcrumbReady = document.querySelector('.viewer-header') === null
      && document.querySelector('.file-tab-bar') === null
      && document.querySelector('.work-tab-panel:not([hidden]) .code-viewer')?.getAttribute('data-file-path') === deepFilePath
      && document.querySelector('.work-tab-panel:not([hidden]) .file-breadcrumb')?.getAttribute('title') === deepFilePath
      && document.querySelector('.work-tab-panel:not([hidden]) .file-statusbar') !== null
    const pin = [...document.querySelectorAll('.session-tab-shell[data-kind="file"] [role="tab"]')]
      .find(button => button.getAttribute('title') === deepFilePath)
    if (pin instanceof HTMLButtonElement) pin.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    const pinned = await waitFor(() => [...document.querySelectorAll('.session-tab-shell[data-kind="file"]')]
      .find(tab => tab.querySelector('[role="tab"]')?.getAttribute('title') === deepFilePath
        && tab.getAttribute('data-preview') !== 'true'))
    const currentReadme = [...document.querySelectorAll('[aria-label="项目文件树"] .tree-row')]
      .find(element => element.getAttribute('title') === 'README.md')
    if (currentReadme instanceof HTMLButtonElement) currentReadme.click()
    const preview = await waitFor(() => [...document.querySelectorAll('.session-tab-shell[data-kind="file"]')]
      .find(tab => tab.querySelector('[role="tab"]')?.getAttribute('title') === 'README.md'
        && tab.getAttribute('data-preview') === 'true'
        && tab.getAttribute('data-selected') === 'true'))
    const previewControlsTransparent = preview instanceof HTMLElement
      && [...preview.querySelectorAll('button')]
        .every(button => getComputedStyle(button).backgroundColor === 'rgba(0, 0, 0, 0)')
    const back = document.querySelector('.work-tab-panel:not([hidden]) button[aria-label="返回上一个文件"]')
    if (back instanceof HTMLButtonElement) back.click()
    const returned = await waitFor(() => [...document.querySelectorAll('.session-tab-shell[data-kind="file"]')]
      .find(tab => tab.querySelector('[role="tab"]')?.getAttribute('title') === deepFilePath
        && tab.getAttribute('data-selected') === 'true'))
    const forward = document.querySelector('.work-tab-panel:not([hidden]) button[aria-label="前进到下一个文件"]')
    const historyControlsTransparent = back instanceof HTMLButtonElement
      && forward instanceof HTMLButtonElement
      && [back, forward]
        .every(button => getComputedStyle(button).backgroundColor === 'rgba(0, 0, 0, 0)')
    if (forward instanceof HTMLButtonElement) forward.click()
    const forwarded = await waitFor(() => [...document.querySelectorAll('.session-tab-shell[data-kind="file"]')]
      .find(tab => tab.querySelector('[role="tab"]')?.getAttribute('title') === 'README.md'
        && tab.getAttribute('data-selected') === 'true'))
    const closePreview = document.querySelector('button[aria-label="关闭 README.md"]')
    if (closePreview instanceof HTMLButtonElement) closePreview.click()
    const closedToRecent = await waitFor(() => document.querySelectorAll('.session-tab-shell[data-kind="file"]').length === 1
      && document.querySelector('.session-tab-shell[data-kind="file"][data-selected="true"] [role="tab"]')?.getAttribute('title')
        === deepFilePath)
    fileTabsReady = breadcrumbReady
      && pinned instanceof HTMLElement
      && preview instanceof HTMLElement
      && previewControlsTransparent
      && back instanceof HTMLButtonElement
      && returned instanceof HTMLElement
      && forward instanceof HTMLButtonElement
      && historyControlsTransparent
      && forwarded instanceof HTMLElement
      && closePreview instanceof HTMLButtonElement
      && closedToRecent === true
  }
  const largeImage = [...document.querySelectorAll('[aria-label="项目文件树"] .tree-row')]
    .find(element => element.getAttribute('title') === 'large-preview.png')
  if (largeImage instanceof HTMLButtonElement) largeImage.click()
  const imageViewer = await waitFor(() => document.querySelector('.image-viewer img'))
  const imageViewerReady = largeImage instanceof HTMLButtonElement
    && imageViewer instanceof HTMLImageElement
    && imageViewer.src.startsWith('data:image/png;base64,')
    && imageViewer.closest('.image-viewer')?.textContent?.includes('2,097,') === true
    && document.querySelector('.project-workspace-alert [role="alert"]') === null
  let fileWorkspacePersisted = false
  if (fileTree instanceof HTMLElement && globalThis.dshDesktop?.fileWorkspace !== undefined) {
    fileTree.scrollLeft = Math.min(37, Math.max(0, fileTree.scrollWidth - fileTree.clientWidth))
    fileTree.scrollTop = Math.min(29, Math.max(0, fileTree.scrollHeight - fileTree.clientHeight))
    fileTree.dispatchEvent(new Event('scroll', { bubbles: true }))
    const projects = await globalThis.dshDesktop.projects.list()
    const projectId = Array.isArray(projects) && typeof projects[0]?.id === 'string'
      ? projects[0].id
      : null
    for (let attempt = 0; attempt < 60 && projectId !== null; attempt += 1) {
      const state = await globalThis.dshDesktop.fileWorkspace.read(projectId)
      fileWorkspacePersisted = state !== null
        && state.pinnedFiles.includes(deepFilePath)
        && state.previewFile === 'large-preview.png'
        && state.activeFile === 'large-preview.png'
        && state.expandedDirectories.includes(deepRelativePath)
        && state.treeScrollLeft === Math.round(fileTree.scrollLeft)
        && state.treeScrollTop === Math.round(fileTree.scrollTop)
      if (fileWorkspacePersisted) break
      await sleep(50)
    }
  }
  return {
    fileTreeReady,
    deepFileTreeReady,
    fileViewerReady,
    fileTabsReady,
    fileWorkspacePersisted,
    quickOpenReady,
    syntaxHighlightingReady,
    fileCursorReady,
    fileCursorDetails,
    imageViewerReady,
  }
})()`

/** 打开 `README.md` 并将焦点移入 CodeMirror 内容编辑区。 */
export const FOCUS_README_EDITOR_PROBE = `(async () => {
  const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
  document.querySelector('[data-view="files"]')?.click()
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const readme = [...document.querySelectorAll('[aria-label="项目文件树"] .tree-row')]
      .find(element => element.getAttribute('title') === 'README.md')
    if (readme instanceof HTMLButtonElement) {
      readme.click()
      break
    }
    await sleep(25)
  }
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const editor = document.querySelector('.code-viewer[data-file-path="README.md"] .code-editor[data-language-ready="true"] .cm-content')
    if (editor instanceof HTMLElement) {
      editor.focus()
      return document.activeElement === editor
    }
    await sleep(25)
  }
  return false
})()`

/** 验证磁盘外部修改触发冲突提示条且阻止静默覆盖。 */
export const EXTERNAL_FILE_CONFLICT_PROBE = `(async () => {
  const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const panel = document.querySelector('.file-conflict-panel')
    if (panel instanceof HTMLElement
      && panel.textContent?.includes('文件已在磁盘上发生变化') === true
      && panel.textContent?.includes('重新载入') === true
      && panel.textContent?.includes('仍然覆盖') === true) return true
    await sleep(25)
  }
  return false
})()`

/** 验证点击重新载入后编辑器内容与外部文件同步且清除冲突态。 */
export const RELOADED_EXTERNAL_FILE_PROBE = `(async () => {
  const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const content = document.querySelector('.code-viewer[data-file-path="README.md"] .cm-content')
    if (content instanceof HTMLElement
      && content.textContent?.includes('外部修改验收') === true
      && document.querySelector('.file-dirty-status') === null
      && document.querySelector('.file-conflict-panel') === null) return true
    await sleep(25)
  }
  return false
})()`

/** 验证后台 Runtime 重启恢复后页面未整页刷新且未保存草稿保留。 */
export const HOST_RECOVERY_RETAINS_DRAFT_PROBE = `(async () => {
  try {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (document.querySelector('.project-workspace-alert [role="alert"]') === null) {
        return document.documentElement.dataset.hostRecoveryAudit === 'pending'
          && document.querySelector('.file-dirty-status')?.textContent?.trim() === '未保存'
          && document.querySelector('.code-viewer[data-file-path="README.md"] .cm-content')?.textContent?.includes('未保存离开保护验收') === true
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return false
  } finally {
    delete document.documentElement.dataset.hostRecoveryAudit
  }
})()`

/** 验证关闭含未保存修改的文件标签时弹出确认框并支持取消保留。 */
export const UNSAVED_TAB_CLOSE_GUARD_PROBE = `(async () => {
  const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
  const close = document.querySelector('button[aria-label="关闭 README.md"]')
  if (!(close instanceof HTMLButtonElement)) return false
  close.click()
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const dialog = document.querySelector('.unsaved-dialog')
    const currentPath = document.querySelector('.work-tab-panel:not([hidden]) [data-file-path]')?.getAttribute('data-file-path')
    if (dialog instanceof HTMLDialogElement
      && dialog.open
      && dialog.textContent?.includes('关闭 README.md') === true
      && currentPath === 'README.md') {
      const cancel = [...dialog.querySelectorAll('footer button')]
        .find(button => button.textContent?.trim() === '取消')
      if (!(cancel instanceof HTMLButtonElement)) return false
      cancel.click()
      break
    }
    await sleep(25)
  }
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const dialog = document.querySelector('.unsaved-dialog')
    if (dialog instanceof HTMLDialogElement
      && !dialog.open
      && document.querySelector('.file-dirty-status')?.textContent?.trim() === '未保存'
      && document.querySelector('.work-tab-panel:not([hidden]) [data-file-path]')?.getAttribute('data-file-path') === 'README.md') return true
    await sleep(25)
  }
  return false
})()`

/** 验证关闭主窗口时拦截未保存更改并在取消后允许放弃更改。 */
export const UNSAVED_WINDOW_CLOSE_GUARD_PROBE = `(async () => {
  const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const dialog = document.querySelector('.unsaved-dialog')
    if (dialog instanceof HTMLDialogElement
      && dialog.open
      && dialog.textContent?.includes('关闭 MyDSH') === true) {
      const cancel = [...dialog.querySelectorAll('footer button')]
        .find(button => button.textContent?.trim() === '取消')
      if (!(cancel instanceof HTMLButtonElement)) return false
      cancel.click()
      break
    }
    await sleep(25)
  }
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const dialog = document.querySelector('.unsaved-dialog')
    if (dialog instanceof HTMLDialogElement
      && !dialog.open
      && document.querySelector('.file-dirty-status')?.textContent?.trim() === '未保存') {
      const discard = [...document.querySelectorAll('.file-statusbar__actions button')]
        .find(button => button.checkVisibility() && button.getAttribute('aria-label') === '放弃文件更改')
      if (!(discard instanceof HTMLButtonElement)) return false
      discard.click()
      for (let clearAttempt = 0; clearAttempt < 80; clearAttempt += 1) {
        if (document.querySelector('.file-dirty-status') === null) return true
        await sleep(25)
      }
      return false
    }
    await sleep(25)
  }
  return false
})()`

/** 验证项目全文搜索命中深层 Java 源码中文注释并支持点击跳转。 */
export const PROJECT_CONTENT_SEARCH_PROBE = `(async () => {
  const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
  let input = null
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const candidate = document.querySelector('.project-search-controls input')
    if (candidate instanceof HTMLInputElement) {
      input = candidate
      break
    }
    await sleep(25)
  }
  if (!(input instanceof HTMLInputElement)) return { ready: false, resultPath: '', stage: 'search-input' }
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, '中文注释')
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '中文注释' }))
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const group = document.querySelector('.project-search-group')
    const result = group?.querySelector('button')
    const path = group?.querySelector('h3')?.textContent ?? ''
    if (result instanceof HTMLButtonElement
      && path.includes('DeepWorkspaceControllerWithAnIntentionallyLongNameForHorizontalTreeVerification.java')
      && result.textContent?.includes('中文注释') === true) {
      result.click()
      return { ready: true, resultPath: path, stage: 'complete' }
    }
    await sleep(25)
  }
  return { ready: false, resultPath: '', stage: 'search-result' }
})()`

const PROJECT_TASK_LIFECYCLE_HELPERS_SNIPPET = `
    const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
    const waitFor = async predicate => {
      for (let attempt = 0; attempt < 160; attempt += 1) {
        const value = predicate()
        if (value) return value
        await sleep(25)
      }
      return null
    }
    const setControlValue = (control, value) => {
      const prototype = control instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(control, value)
      control.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
    }
    const setField = (dialog, label, value) => {
      const fieldLabel = [...dialog.querySelectorAll('label')]
        .find(candidate => candidate.querySelector('span')?.textContent?.trim() === label)
      const control = fieldLabel?.querySelector('input, textarea')
      if (!(control instanceof HTMLInputElement) && !(control instanceof HTMLTextAreaElement)) return false
      setControlValue(control, value)
      return true
    }
    if (!document.querySelector('[data-island-id="file-outline-tasks"]')) document.querySelector('[aria-label="更多右侧栏目"][aria-haspopup="menu"]')?.click()
    const fileIsland = await waitFor(() => document.querySelector('[data-island-id="file-outline-tasks"]'))
    if (!(fileIsland instanceof HTMLButtonElement)) return { ready: false, stage: 'right-island-option' }
    if (fileIsland.getAttribute('aria-selected') !== 'true') fileIsland.click()
    const fileIslandReady = await waitFor(() => document.querySelector('.info-island.file-info-island [data-project-tasks="true"]'))
    if (!(fileIslandReady instanceof HTMLElement)) return { ready: false, stage: 'right-island-content' }
    const taskSuggestionsRemoved = fileIslandReady.querySelector('[data-task-suggestion]') === null
      && fileIslandReady.textContent?.includes('导入建议') !== true
    if (!taskSuggestionsRemoved) return { ready: false, stage: 'task-suggestions', taskSuggestionsRemoved }
    document.querySelector('[data-view="files"]')?.click()
    const create = await waitFor(() => document.querySelector('[data-project-tasks="true"] button[aria-label="新建脚本"]'))
    if (!(create instanceof HTMLButtonElement)) return { ready: false, stage: 'create-button' }
    create.click()
    const dialog = await waitFor(() => {
      const candidate = document.querySelector('dialog[aria-labelledby="project-task-editor-title"]')
      return candidate instanceof HTMLDialogElement && candidate.open ? candidate : null
    })
    if (!(dialog instanceof HTMLDialogElement)
      || !setField(dialog, '名称', '验收交互任务')
      || !setField(dialog, '可执行程序', taskExecutable)
      || !setField(dialog, '参数（每行一个）', taskArgumentsText)) return { ready: false, stage: 'create-form' }`

const PROJECT_TASK_TERMINAL_EXECUTION_SNIPPET = `
    const save = await waitFor(() => [...dialog.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '保存脚本' && !button.disabled))
    if (!(save instanceof HTMLButtonElement)) return { ready: false, stage: 'create-save-enabled' }
    save.click()
    const row = await waitFor(() => document.querySelector('[data-task-name="验收交互任务"]'))
    if (!(row instanceof HTMLElement)) return {
      ready: false,
      stage: 'created-row',
      detail: document.querySelector('[data-project-tasks="true"] [role="alert"]')?.textContent?.trim()
        ?? document.querySelector('[data-project-tasks="true"]')?.textContent?.trim()
        ?? '项目任务面板不可用',
      dialogOpen: document.querySelector('dialog[aria-labelledby="project-task-editor-title"]')?.hasAttribute('open') === true,
    }
    const run = row.querySelector('button[aria-label="在终端运行 验收交互任务"]')
    if (!(run instanceof HTMLButtonElement)) return { ready: false, stage: 'run-button' }
    run.click()
    const terminal = await waitFor(() => {
      const view = document.querySelector('.work-tab-panel:not([hidden])')
      const host = view?.querySelector('[data-terminal-id]')
      const tabs = document.querySelectorAll('[data-work-tab="terminal"]')
      const taskTab = document.querySelector('[data-work-tab="terminal"]')
      const tree = document.querySelector('[aria-label="项目文件树"]')
      const info = document.querySelector('.info-island')
      const shell = document.querySelector('.app-shell')
      return view instanceof HTMLElement
        && host instanceof HTMLElement
        && host.dataset.terminalId !== undefined
        && tabs?.length === 1
        && taskTab?.textContent?.includes('验收交互任务') === true
        && tree instanceof HTMLElement
        && info instanceof HTMLElement
        && document.querySelector('.work-tab-panel:not([hidden])')?.contains(view)
        && taskTab?.getAttribute('aria-selected') === 'true'
        && shell?.getAttribute('data-information-collapsed') !== 'true'
        ? { terminalId: host.dataset.terminalId }
        : null
    })
    if (terminal === null) return { ready: false, stage: 'task-terminal-layout' }
    const outputReady = await new Promise(resolve => {
      const api = globalThis.dshDesktop?.terminal
      if (api === undefined) {
        resolve(false)
        return
      }
      let output = ''
      let settled = false
      const finish = value => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        stop()
        resolve(value)
      }
      const stop = api.onEvent(event => {
        if (event.type !== 'data' || event.terminalId !== terminal.terminalId) return
        output += event.data
        if (output.includes('PROJECT_TASK_PTY_OK')) finish(true)
      })
      const timeout = setTimeout(() => { finish(false) }, 15_000)
      api.write(terminal.terminalId, 'PROJECT_TASK_PTY_OK' + String.fromCharCode(13)).catch(() => { finish(false) })
    })
    if (!document.querySelector('[data-island-id="file-outline-tasks"]')) document.querySelector('[aria-label="更多右侧栏目"][aria-haspopup="menu"]')?.click()
    const taskIsland = await waitFor(() => document.querySelector('[data-island-id="file-outline-tasks"]'))
    if (!(taskIsland instanceof HTMLButtonElement)) return { ready: false, stage: 'rerun-island', outputReady }
    if (taskIsland.getAttribute('aria-selected') !== 'true') taskIsland.click()
    const rerun = await waitFor(() => document.querySelector('[data-task-name="验收交互任务"] button[aria-label="在终端运行 验收交互任务"]'))
    if (!(rerun instanceof HTMLButtonElement)) return { ready: false, stage: 'rerun-button', outputReady }
    rerun.click()
    const reused = await waitFor(() => document.querySelectorAll('[data-work-tab="terminal"]').length === 1
      && document.querySelector('.work-tab-panel:not([hidden]) [data-terminal-id]')?.getAttribute('data-terminal-id') === terminal.terminalId)
    const close = document.querySelector('.session-chrome button[aria-label="关闭终端 1"]')
    if (close instanceof HTMLButtonElement) close.click()
    const closed = await waitFor(() => document.querySelectorAll('.work-tab-panel [data-terminal-id]').length === 0
      && document.querySelectorAll('[data-work-tab="terminal"]').length === 0)
    document.querySelector('[data-view="files"]')?.click()
    const filesRestored = await waitFor(() => {
      const tab = document.querySelector('[data-work-tab="file"][aria-selected="true"]')
      const editor = document.querySelector('.work-tab-panel:not([hidden]) .code-editor')
      return tab && editor?.checkVisibility() ? editor : null
    })
    return outputReady === true && reused && closed === true && filesRestored instanceof HTMLElement
      ? { ready: true, stage: 'complete', taskSuggestionsRemoved }
      : { ready: false, stage: 'task-terminal-lifecycle', taskSuggestionsRemoved, outputReady, reused, closed: closed === true }`

/** 构造新建项目脚本任务、在终端 PTY 中执行、复用标签并关闭销毁的探测脚本。 */
export function buildProjectTaskTerminalLifecycleProbe(
  executable: string,
  argumentsText: string,
): string {
  return `(async () => {
    const taskExecutable = ${JSON.stringify(executable)}
    const taskArgumentsText = ${JSON.stringify(argumentsText)}
    ${PROJECT_TASK_LIFECYCLE_HELPERS_SNIPPET}
    ${PROJECT_TASK_TERMINAL_EXECUTION_SNIPPET}
  })()`
}

/** 采样 1800×1000 浅色放大窗口下代码编辑器的字号、行高与底部状态栏边界。 */
export const LARGE_LIGHT_EDITOR_LAYOUT_PROBE = `(() => {
  const viewer = document.querySelector('.work-tab-panel:not([hidden]) [data-file-path]')
  const editor = viewer?.querySelector('.cm-scroller')
  const status = viewer?.querySelector('.file-statusbar')
  return {
    viewer: !!viewer,
    fontSize: editor ? getComputedStyle(editor).fontSize : null,
    lineHeight: editor ? getComputedStyle(editor).lineHeight : null,
    noLegacyHeader: document.querySelector('.viewer-header, .file-tab-bar') === null,
    statusFits: !!status && Math.round(status.getBoundingClientRect().bottom * devicePixelRatio)
      <= Math.round(viewer.getBoundingClientRect().bottom * devicePixelRatio),
    statusBottom: status?.getBoundingClientRect().bottom ?? null,
    viewerBottom: viewer?.getBoundingClientRect().bottom ?? null,
    selectedKind: document.querySelector('.session-tab[aria-selected="true"]')?.dataset.workTab,
    noOverflow: document.documentElement.scrollWidth === innerWidth,
  }
})()`

/** 验证强制高对比色彩模式下编辑器主光标与背景具有对比度。 */
export const FORCED_COLORS_EDITOR_CURSOR_PROBE = `(async () => {
  const editor = document.querySelector('.work-tab-panel:not([hidden]) .code-editor .cm-editor')
  const content = editor?.querySelector('.cm-content')
  if (!(editor instanceof HTMLElement) || !(content instanceof HTMLElement)) return false
  content.focus()
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const cursor = editor.querySelector('.cm-cursor-primary')
    if (cursor instanceof HTMLElement && getComputedStyle(cursor).display === 'block') {
      return getComputedStyle(cursor).borderLeftColor !== getComputedStyle(editor).backgroundColor
        && parseFloat(getComputedStyle(cursor).borderLeftWidth) > 0
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return false
})()`
