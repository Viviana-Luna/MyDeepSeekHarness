/**
 * 文件树、代码编辑器、全文搜索、项目任务、Git 与终端验收套件：在渲染进程上下文执行的页面探测脚本集合（分片 1）。
 */

/** 浏览器端验收探测脚本（files-scm #1）。 */
export const FILES_SCM_SCRIPT_1 = `(async () => {
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
        // 文件树选择会先更新，编辑器还可能短暂显示旧文档；等待目标语言与实际高亮渲染。
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
          // CodeMirror 先接收 DOM 焦点，再异步更新聚焦类与光标；存在节点不代表光标已绘制。
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

/** 浏览器端验收探测脚本（files-scm #2）。 */
export const FILES_SCM_SCRIPT_2 = `(async () => {
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

/** 浏览器端验收探测脚本（files-scm #3）。 */
export const FILES_SCM_SCRIPT_3 = `(async () => {
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

/** 浏览器端验收探测脚本（files-scm #4）。 */
export const FILES_SCM_SCRIPT_4 = `(async () => {
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

/** 浏览器端验收探测脚本（files-scm #5）。 */
export const FILES_SCM_SCRIPT_5 = `(async () => {
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

/** 浏览器端验收探测脚本（files-scm #6）。 */
export const FILES_SCM_SCRIPT_6 = `(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      // 文件标签保留各自草稿；关闭标签才可能丢弃内容，必须走未保存确认。
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

/** 浏览器端验收探测脚本（files-scm #7）。 */
export const FILES_SCM_SCRIPT_7 = `(async () => {
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

/** 浏览器端验收探测脚本（files-scm #8）。 */
export const FILES_SCM_SCRIPT_8 = `(async () => {
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

const FILES_SCM_PARTS_9 = [
  "(async () => {\n      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))\n      const waitFor = async predicate => {\n        for (let attempt = 0; attempt < 160; attempt += 1) {\n          const value = predicate()\n          if (value) return value\n          await sleep(25)\n        }\n        return null\n      }\n      const setControlValue = (control, value) => {\n        const prototype = control instanceof HTMLTextAreaElement\n          ? HTMLTextAreaElement.prototype\n          : HTMLInputElement.prototype\n        Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(control, value)\n        control.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))\n      }\n      const setField = (dialog, label, value) => {\n        const fieldLabel = [...dialog.querySelectorAll('label')]\n          .find(candidate => candidate.querySelector('span')?.textContent?.trim() === label)\n        const control = fieldLabel?.querySelector('input, textarea')\n        if (!(control instanceof HTMLInputElement) && !(control instanceof HTMLTextAreaElement)) return false\n        setControlValue(control, value)\n        return true\n      }\n      if (!document.querySelector('[data-island-id=\"file-outline-tasks\"]')) document.querySelector('[aria-label=\"更多右侧栏目\"][aria-haspopup=\"menu\"]')?.click()\n      const fileIsland = await waitFor(() => document.querySelector('[data-island-id=\"file-outline-tasks\"]'))\n      if (!(fileIsland instanceof HTMLButtonElement)) return { ready: false, stage: 'right-island-option' }\n      if (fileIsland.getAttribute('aria-selected') !== 'true') fileIsland.click()\n      const fileIslandReady = await waitFor(() => document.querySelector('.info-island.file-info-island [data-project-tasks=\"true\"]'))\n      if (!(fileIslandReady instanceof HTMLElement)) return { ready: false, stage: 'right-island-content' }\n      const taskSuggestionsRemoved = fileIslandReady.querySelector('[data-task-suggestion]') === null\n        && fileIslandReady.textContent?.includes('导入建议') !== true\n      if (!taskSuggestionsRemoved) return { ready: false, stage: 'task-suggestions', taskSuggestionsRemoved }\n      document.querySelector('[data-view=\"files\"]')?.click()\n      const create = await waitFor(() => document.querySelector('[data-project-tasks=\"true\"] button[aria-label=\"新建脚本\"]'))\n      if (!(create instanceof HTMLButtonElement)) return { ready: false, stage: 'create-button' }\n      create.click()\n      const dialog = await waitFor(() => {\n        const candidate = document.querySelector('dialog[aria-labelledby=\"project-task-editor-title\"]')\n        return candidate instanceof HTMLDialogElement && candidate.open ? candidate : null\n      })\n      if (!(dialog instanceof HTMLDialogElement)\n        || !setField(dialog, '名称', '验收交互任务')\n        || !setField(dialog, '可执行程序', ",
  ")\n        || !setField(dialog, '参数（每行一个）', ",
  ")) return { ready: false, stage: 'create-form' }\n      const save = await waitFor(() => [...dialog.querySelectorAll('button')]\n        .find(button => button.textContent?.trim() === '保存脚本' && !button.disabled))\n      if (!(save instanceof HTMLButtonElement)) return { ready: false, stage: 'create-save-enabled' }\n      save.click()\n      const row = await waitFor(() => document.querySelector('[data-task-name=\"验收交互任务\"]'))\n      if (!(row instanceof HTMLElement)) return {\n        ready: false,\n        stage: 'created-row',\n        detail: document.querySelector('[data-project-tasks=\"true\"] [role=\"alert\"]')?.textContent?.trim()\n          ?? document.querySelector('[data-project-tasks=\"true\"]')?.textContent?.trim()\n          ?? '项目任务面板不可用',\n        dialogOpen: document.querySelector('dialog[aria-labelledby=\"project-task-editor-title\"]')?.hasAttribute('open') === true,\n      }\n      const run = row.querySelector('button[aria-label=\"在终端运行 验收交互任务\"]')\n      if (!(run instanceof HTMLButtonElement)) return { ready: false, stage: 'run-button' }\n      run.click()\n      const terminal = await waitFor(() => {\n        const view = document.querySelector('.work-tab-panel:not([hidden])')\n        const host = view?.querySelector('[data-terminal-id]')\n        const tabs = document.querySelectorAll('[data-work-tab=\"terminal\"]')\n        const taskTab = document.querySelector('[data-work-tab=\"terminal\"]')\n        const tree = document.querySelector('[aria-label=\"项目文件树\"]')\n        const info = document.querySelector('.info-island')\n        const shell = document.querySelector('.app-shell')\n        return view instanceof HTMLElement\n          && host instanceof HTMLElement\n          && host.dataset.terminalId !== undefined\n          && tabs?.length === 1\n          && taskTab?.textContent?.includes('验收交互任务') === true\n          && tree instanceof HTMLElement\n          && info instanceof HTMLElement\n          && document.querySelector('.work-tab-panel:not([hidden])')?.contains(view)\n          && taskTab?.getAttribute('aria-selected') === 'true'\n          && shell?.getAttribute('data-information-collapsed') !== 'true'\n          ? { terminalId: host.dataset.terminalId }\n          : null\n      })\n      if (terminal === null) return { ready: false, stage: 'task-terminal-layout' }\n      const outputReady = await new Promise(resolve => {\n        const api = globalThis.dshDesktop?.terminal\n        if (api === undefined) {\n          resolve(false)\n          return\n        }\n        let output = ''\n        let settled = false\n        const finish = value => {\n          if (settled) return\n          settled = true\n          clearTimeout(timeout)\n          stop()\n          resolve(value)\n        }\n        const stop = api.onEvent(event => {\n          if (event.type !== 'data' || event.terminalId !== terminal.terminalId) return\n          output += event.data\n          if (output.includes('PROJECT_TASK_PTY_OK')) finish(true)\n        })\n        const timeout = setTimeout(() => { finish(false) }, 15_000)\n        api.write(terminal.terminalId, 'PROJECT_TASK_PTY_OK' + String.fromCharCode(13)).catch(() => { finish(false) })\n      })\n      if (!document.querySelector('[data-island-id=\"file-outline-tasks\"]')) document.querySelector('[aria-label=\"更多右侧栏目\"][aria-haspopup=\"menu\"]')?.click()\n      const taskIsland = await waitFor(() => document.querySelector('[data-island-id=\"file-outline-tasks\"]'))\n      if (!(taskIsland instanceof HTMLButtonElement)) return { ready: false, stage: 'rerun-island', outputReady }\n      if (taskIsland.getAttribute('aria-selected') !== 'true') taskIsland.click()\n      const rerun = await waitFor(() => document.querySelector('[data-task-name=\"验收交互任务\"] button[aria-label=\"在终端运行 验收交互任务\"]'))\n      if (!(rerun instanceof HTMLButtonElement)) return { ready: false, stage: 'rerun-button', outputReady }\n      rerun.click()\n      const reused = await waitFor(() => document.querySelectorAll('[data-work-tab=\"terminal\"]').length === 1\n        && document.querySelector('.work-tab-panel:not([hidden]) [data-terminal-id]')?.getAttribute('data-terminal-id') === terminal.terminalId)\n      const close = document.querySelector('.session-chrome button[aria-label=\"关闭终端 1\"]')\n      if (close instanceof HTMLButtonElement) close.click()\n      const closed = await waitFor(() => document.querySelectorAll('.work-tab-panel [data-terminal-id]').length === 0\n        && document.querySelectorAll('[data-work-tab=\"terminal\"]').length === 0)\n      document.querySelector('[data-view=\"files\"]')?.click()\n      const filesRestored = await waitFor(() => {\n        const tab = document.querySelector('[data-work-tab=\"file\"][aria-selected=\"true\"]')\n        const editor = document.querySelector('.work-tab-panel:not([hidden]) .code-editor')\n        return tab && editor?.checkVisibility() ? editor : null\n      })\n      return outputReady === true && reused && closed === true && filesRestored instanceof HTMLElement\n        ? { ready: true, stage: 'complete', taskSuggestionsRemoved }\n        : { ready: false, stage: 'task-terminal-lifecycle', taskSuggestionsRemoved, outputReady, reused, closed: closed === true }\n    })()",
] as const

/** 构造带参数的浏览器端验收探测脚本（files-scm #9）。 */
export function buildFilesScmScript9(p0: unknown, p1: unknown): string {
  return (
    FILES_SCM_PARTS_9[0]! + String(p0) + FILES_SCM_PARTS_9[1]! + String(p1) + FILES_SCM_PARTS_9[2]!
  )
}

/** 浏览器端验收探测脚本（files-scm #10）。 */
export const FILES_SCM_SCRIPT_10 = `(() => {
        const viewer = document.querySelector('.work-tab-panel:not([hidden]) [data-file-path]')
        const editor = viewer?.querySelector('.cm-scroller')
        const status = viewer?.querySelector('.file-statusbar')
        return { viewer: !!viewer, fontSize: editor ? getComputedStyle(editor).fontSize : null,
          lineHeight: editor ? getComputedStyle(editor).lineHeight : null,
          noLegacyHeader: document.querySelector('.viewer-header, .file-tab-bar') === null,
          // 工作标签的过渡会产生浮点尾差，边界应比较同一物理像素中的位置。
          statusFits: !!status && Math.round(status.getBoundingClientRect().bottom * devicePixelRatio)
            <= Math.round(viewer.getBoundingClientRect().bottom * devicePixelRatio),
          statusBottom: status?.getBoundingClientRect().bottom ?? null,
          viewerBottom: viewer?.getBoundingClientRect().bottom ?? null,
          selectedKind: document.querySelector('.session-tab[aria-selected="true"]')?.dataset.workTab,
          noOverflow: document.documentElement.scrollWidth === innerWidth }
      })()`

/** 浏览器端验收探测脚本（files-scm #11）。 */
export const FILES_SCM_SCRIPT_11 = `(async () => {
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

/** 浏览器端验收探测脚本（files-scm #12）。 */
export const FILES_SCM_SCRIPT_12 = `(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      document.querySelector('[data-view="changes"]')?.click()
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const navigation = document.querySelector('.source-control-navigation')
        const stage = document.querySelector('button[aria-label="暂存 scratch.md"]')
        if (navigation instanceof HTMLElement
          && navigation.getAttribute('aria-busy') === 'false'
          && stage instanceof HTMLButtonElement
          && !stage.disabled) return true
        await sleep(25)
      }
      return false
    })()`
