/**
 * 文件树、代码编辑器、全文搜索、项目任务、Git 与终端验收套件：在渲染进程上下文执行的页面探测脚本集合（分片 2）。
 */

/** 浏览器端验收探测脚本（files-scm #13）。 */
export const FILES_SCM_SCRIPT_13 = `(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const navigation = document.querySelector('.source-control-navigation')
        const unstage = document.querySelector('button[aria-label="取消暂存 scratch.md"]')
        if (navigation?.getAttribute('aria-busy') === 'false'
          && unstage instanceof HTMLButtonElement
          && !unstage.disabled) return true
        await sleep(25)
      }
      return false
    })()`

/** 浏览器端验收探测脚本（files-scm #14）。 */
export const FILES_SCM_SCRIPT_14 = `(async () => {
      const wait = async predicate => {
        for (let attempt = 0; attempt < 80; attempt += 1) {
          if (predicate()) return true
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        return false
      }
      const panel = document.querySelector('.info-island .source-control-navigation')
      const staged = panel?.querySelector('[aria-label="暂存的更改"][aria-controls]')
      const working = panel?.querySelector('[aria-label="更改"][aria-controls]')
      if (!staged || !working) return false
      const stagedList = document.getElementById(staged.getAttribute('aria-controls'))
      const workingList = document.getElementById(working.getAttribute('aria-controls'))
      if (!await wait(() => stagedList?.querySelector('.change-row'))) return false
      const row = stagedList.querySelector('.change-row')
      staged.click()
      if (!await wait(() => stagedList.hidden && !stagedList.checkVisibility())) return false
      if (workingList.hidden || !panel.querySelector('[aria-label="取消暂存全部更改"]')) return false
      working.click()
      if (!await wait(() => workingList.hidden && !workingList.checkVisibility())) return false
      staged.click()
      working.click()
      if (!await wait(() => !stagedList.hidden && !workingList.hidden)) return false
      return stagedList.querySelector('.change-row') === row
        && staged.getAttribute('aria-expanded') === 'true' && working.getAttribute('aria-expanded') === 'true'
    })()`

/** 浏览器端验收探测脚本（files-scm #15）。 */
export const FILES_SCM_SCRIPT_15 = `(() => {
      const panel = document.querySelector('.navigation-island .scm-pane:first-child > .scm-pane-content')
      const list = panel?.querySelector('.change-list:not([hidden])')
      const row = list?.querySelector('.change-row')
      if (!(panel instanceof HTMLElement) || !(list instanceof HTMLElement) || !row) return false
      const originalTop = panel.scrollTop
      const copies = Array.from({ length: 40 }, () => row.cloneNode(true))
      try {
        list.append(...copies)
        panel.scrollTop = panel.scrollHeight
        return getComputedStyle(panel).overflowY === 'auto'
          && panel.scrollHeight > panel.clientHeight && panel.scrollTop > 0
      } finally {
        for (const copy of copies) copy.remove()
        panel.scrollTop = originalTop
      }
    })()`

/** 浏览器端验收探测脚本（files-scm #16）。 */
export const FILES_SCM_SCRIPT_16 = `(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const navigation = document.querySelector('.source-control-navigation')
        const stage = document.querySelector('button[aria-label="暂存 scratch.md"]')
        if (navigation?.getAttribute('aria-busy') === 'false'
          && stage instanceof HTMLButtonElement
          && !stage.disabled
          && navigation.querySelector('.scm-operation-notice')?.textContent?.includes('已取消全部暂存')) return true
        await sleep(25)
      }
      return false
    })()`

const FILES_SCM_PARTS_17 = [
  "(async () => {\n      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))\n      const input = document.querySelector('#scm-commit-message')\n      if (!(input instanceof HTMLTextAreaElement)) return false\n      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set\n      if (setter === undefined) return false\n      setter.call(input, ",
  ")\n      input.dispatchEvent(new Event('input', { bubbles: true }))\n      for (let attempt = 0; attempt < 40; attempt += 1) {\n        const button = document.querySelector('.scm-commit-button')\n        if (button instanceof HTMLButtonElement && !button.disabled\n          && input.value === ",
  ') return true\n        await sleep(25)\n      }\n      return false\n    })()',
] as const

/** 构造带参数的浏览器端验收探测脚本（files-scm #17）。 */
export function buildFilesScmScript17(p0: unknown, p1: unknown): string {
  return (
    FILES_SCM_PARTS_17[0]! +
    String(p0) +
    FILES_SCM_PARTS_17[1]! +
    String(p1) +
    FILES_SCM_PARTS_17[2]!
  )
}

const FILES_SCM_PARTS_18 = [
  "(async () => {\n        const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))\n        for (let attempt = 0; attempt < 80; attempt += 1) {\n          const navigation = document.querySelector('.source-control-navigation')\n          const alerts = [...document.querySelectorAll('.project-workspace-alert [role=\"alert\"]')]\n          const error = alerts[0]\n          const input = document.querySelector('#scm-commit-message')\n          const button = document.querySelector('.scm-commit-button')\n          if (navigation?.getAttribute('aria-busy') === 'false'\n            && alerts.length === 1\n            && error?.textContent?.includes('Git 索引正被其他进程占用') === true\n            && error?.textContent?.includes('Error invoking remote method') !== true\n            && input instanceof HTMLTextAreaElement\n            && input.value === ",
  '\n            && button instanceof HTMLButtonElement\n            && !button.disabled) {\n            const close = error.querySelector(\'button[aria-label="关闭提示"]\')\n            if (!(close instanceof HTMLButtonElement)) return false\n            close.click()\n            for (let clearAttempt = 0; clearAttempt < 60; clearAttempt += 1) {\n              if (document.querySelector(\'.project-workspace-alert [role="alert"]\') === null) return true\n              await sleep(25)\n            }\n            return false\n          }\n          await sleep(25)\n        }\n        return false\n      })()',
] as const

/** 构造带参数的浏览器端验收探测脚本（files-scm #18）。 */
export function buildFilesScmScript18(p0: unknown): string {
  return FILES_SCM_PARTS_18[0]! + String(p0) + FILES_SCM_PARTS_18[1]!
}

/** 浏览器端验收探测脚本（files-scm #19）。 */
export const FILES_SCM_SCRIPT_19 = `(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const navigation = document.querySelector('.source-control-navigation')
        const notice = document.querySelector('.scm-operation-notice')
        const input = document.querySelector('#scm-commit-message')
        if (navigation?.getAttribute('aria-busy') === 'false'
          && notice?.textContent?.includes('已创建本地 Git 提交') === true
          && input instanceof HTMLTextAreaElement
          && input.value === ''
          && document.querySelector('.info-island .git-review-panel') instanceof HTMLElement
          && document.querySelector('button[aria-label="暂存 scratch.md"]') === null
          && document.querySelector('button[aria-label="取消暂存 scratch.md"]') === null) return true
        await sleep(25)
      }
      return false
    })()`

/** 浏览器端验收探测脚本（files-scm #20）。 */
export const FILES_SCM_SCRIPT_20 = `(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const waitFor = async predicate => {
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const value = predicate()
          if (value) return value
          await sleep(25)
        }
        return null
      }
      const panel = document.querySelector('.info-island .git-review-panel')
      const toolbar = panel?.querySelector('.git-review-toolbar')
      const scope = toolbar?.querySelector('select[aria-label="Git 比较范围"]')
      const selectScope = value => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(scope, value)
        scope.dispatchEvent(new Event('change', { bubbles: true }))
      }
      const returnToWorking = async () => {
        if (!(scope instanceof HTMLSelectElement)) return null
        selectScope('turn')
        if (!await waitFor(() => panel.querySelector('.git-review-files'))) return null
        selectScope('working')
        return waitFor(() => panel.querySelector('.source-control-navigation[aria-busy="false"]'))
      }
      const right = panel?.querySelector('.source-control-navigation')
      const file = await waitFor(() => [...(right?.querySelectorAll('.change-file-open') ?? [])]
        .find(button => button.textContent.includes('ApplicationSecurityConfiguration.java')))
      const card = right?.firstElementChild
      const changes = right?.closest('.scm-pane-content')
      const gap = card?.getBoundingClientRect().top - changes?.getBoundingClientRect().top
      const uncommittedChangesReady = file instanceof HTMLButtonElement
        && scope?.value === 'working'
        && !toolbar.querySelector('button')
        && Math.abs(scope.getBoundingClientRect().right - toolbar.getBoundingClientRect().right) <= 1
        && card?.classList.contains('scm-changes-card') && gap >= 0 && gap <= 8
        && right.querySelector('.navigation-mode__header, .scm-commit-form, .git-graph') === null
        && !right.textContent.includes('scratch.md')
      file?.click()
      const diff = await waitFor(() => {
        const view = document.querySelector('.diff-viewer')
        return view?.textContent.includes('private boolean enabled = true') ? view : null
      })
      const beforeRefresh = diff?.textContent
      const refreshed = await returnToWorking()
      const sourceControlReady = diff instanceof HTMLElement
        && refreshed instanceof HTMLElement
        && document.querySelector('.diff-viewer')?.textContent === beforeRefresh
      const contextualRightPanelReady = refreshed instanceof HTMLElement && refreshed.getClientRects().length > 0
      const split = document.querySelector('.diff-split')
      const diffResponsiveReady = split instanceof HTMLElement
        && split.scrollWidth <= split.clientWidth + 1
        && document.documentElement.scrollWidth === innerWidth
      return { sourceControlReady, uncommittedChangesReady, contextualRightPanelReady, diffResponsiveReady }
    })()`

/** 浏览器端验收探测脚本（files-scm #21）。 */
export const FILES_SCM_SCRIPT_21 = `(() => {
      const list = document.querySelector('.info-island .change-list:last-child')
      const panel = document.querySelector('.info-island .workspace-island-content')
      const rows = [...document.querySelectorAll('.info-island .change-file-open')]
      const shortName = rows.find(row => row.querySelector('strong')?.textContent === 'index.ts')?.querySelector('strong')
      return rows.length >= 2 && list instanceof HTMLElement
        && panel instanceof HTMLElement && panel.scrollWidth <= panel.clientWidth + 1
        && list.scrollWidth <= list.clientWidth + 1
        && shortName instanceof HTMLElement && shortName.scrollWidth <= shortName.clientWidth + 1
        && rows.every(row => {
          const copy = row.querySelector('.change-file-copy')
          const name = copy?.querySelector('strong')
          const status = row.querySelector('.change-file-status')
          return name instanceof HTMLElement && copy instanceof HTMLElement && status instanceof HTMLElement
            && name.clientWidth >= Math.min(name.scrollWidth, copy.clientWidth) - 1
            && name.getBoundingClientRect().right <= status.getBoundingClientRect().left
            && row.scrollWidth <= row.clientWidth + 1
        })
    })()`

/** 浏览器端验收探测脚本（files-scm #22）。 */
export const FILES_SCM_SCRIPT_22 = `(async () => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const item = [...document.querySelectorAll('[role="menuitem"]')]
          .find(node => node.checkVisibility() && node.textContent.includes('新终端'))
        if (item instanceof HTMLElement) {
          item.click()
          return
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      throw new Error('新建工作标签菜单缺少终端入口')
    })()`

/** 浏览器端验收探测脚本（files-scm #23）。 */
export const FILES_SCM_SCRIPT_23 = `(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      if (!document.querySelector('[data-island-id="file-outline-tasks"]')) document.querySelector('[aria-label="更多右侧栏目"][aria-haspopup="menu"]')?.click()
      let fileIsland = null
      for (let attempt = 0; attempt < 80; attempt += 1) {
        fileIsland = document.querySelector('[data-island-id="file-outline-tasks"]')
        if (fileIsland instanceof HTMLButtonElement) break
        await sleep(25)
      }
      if (!(fileIsland instanceof HTMLButtonElement)) return { ready: false, stage: 'file-island-option' }
      if (fileIsland.getAttribute('aria-selected') !== 'true') fileIsland.click()
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const view = document.querySelector('.work-tab-panel:not([hidden])')
        const host = view?.querySelector('[data-terminal-id]')
        const input = view?.querySelector('.xterm-helper-textarea')
        const shell = document.querySelector('.app-shell')
        const scmNav = document.querySelector('.navigation-island .source-control-navigation')
        const changesTab = document.querySelector('[data-view="changes"]')
        const info = document.querySelector('.info-island.file-info-island')
        if (view instanceof HTMLElement
          && host instanceof HTMLElement
          && host.dataset.terminalId !== undefined
          && input instanceof HTMLTextAreaElement
          && document.querySelector('[aria-label="终端项目"]') === null
          && shell instanceof HTMLElement
          && shell.dataset.informationCollapsed !== 'true'
          && scmNav instanceof HTMLElement
          && document.querySelector('[aria-label="项目文件树"]') === null
          && changesTab?.getAttribute('aria-current') === 'page'
          && info?.querySelector('.file-outline-panel') === null
          && info.querySelector('[data-project-tasks="true"]') instanceof HTMLElement
          && [...document.querySelectorAll('.composer-card')].every(composer => composer.getClientRects().length === 0)
          && document.querySelector('[data-work-tab="terminal"][aria-selected="true"]') instanceof HTMLButtonElement) {
          input.focus()
          return { ready: true, terminalId: host.dataset.terminalId }
        }
        const add = view?.querySelector('button[aria-label="新建终端"]')
        if (view instanceof HTMLElement
          && document.querySelectorAll('[data-work-tab="terminal"]').length === 0
          && add instanceof HTMLButtonElement) add.click()
        await sleep(25)
      }
      const workspace = document.querySelector('[aria-label="当前项目终端"]')
      const view = document.querySelector('.work-tab-panel:not([hidden])')
      const add = view?.querySelector('button[aria-label="新建终端"]')
      return {
        ready: false,
        stage: 'terminal-ready',
        activeView: document.querySelector('[data-view][aria-current="page"]')?.getAttribute('data-view') ?? null,
        workspaceHidden: workspace instanceof HTMLElement ? workspace.hidden : null,
        projectTabs: [...(workspace?.querySelectorAll('[role="tab"]') ?? [])].map(item => ({
          text: item.textContent?.trim(), selected: item.getAttribute('aria-selected'),
        })),
        viewPresent: view instanceof HTMLElement,
        addDisabled: add instanceof HTMLButtonElement ? add.disabled : null,
        terminalTabs: document.querySelectorAll('[data-work-tab="terminal"]').length ?? null,
        terminalError: view?.querySelector('[role="alert"]')?.textContent?.trim() ?? null,
        fileTree: document.querySelector('[aria-label="项目文件树"]') instanceof HTMLElement,
        rightLabel: document.querySelector('.right-island-tabs [aria-selected="true"]')?.getAttribute('aria-label') ?? null,
        visibleComposer: [...document.querySelectorAll('.composer-card')]
          .some(composer => composer.getClientRects().length > 0),
      }
    })()`

const FILES_SCM_PARTS_24 = [
  "new Promise(resolve => {\n      const api = globalThis.dshDesktop?.terminal\n      if (api === undefined) {\n        resolve(false)\n        return\n      }\n      let output = ''\n      let settled = false\n      const finish = value => {\n        if (settled) return\n        settled = true\n        clearTimeout(timeout)\n        stop()\n        resolve(value)\n      }\n      const stop = api.onEvent(event => {\n        if (event.type !== 'data' || event.terminalId !== ",
  ") return\n        output += event.data\n        if (output.includes('DSH_TERMINAL_ANSI_OK') && output.includes('\\u001b[31m')\n          && (",
  ')) finish(true)\n      })\n      // Windows CI 上 PowerShell 冷启动耗时较长，给足 15s 输出等待并在命中后立即返回。\n      const timeout = setTimeout(() => { finish(false) }, 15_000)\n      Promise.all([\n        api.resize(',
  ', 100, 30),\n        api.write(',
  ', ',
  ')\n      ]).catch(() => { finish(false) })\n    })',
] as const

/** 构造多参数浏览器端验收探测脚本（files-scm #24）。 */
export function buildFilesScmScript24(values: readonly unknown[]): string {
  return values.reduce<string>(
    (acc, val, idx) => acc + String(val) + (FILES_SCM_PARTS_24[idx + 1] ?? ''),
    FILES_SCM_PARTS_24[0],
  )
}

const FILES_SCM_PARTS_25 = [
  "(async () => {\n      const waitFor = async predicate => {\n        for (let attempt = 0; attempt < 160; attempt++) {\n          const result = predicate()\n          if (result) return result\n          await new Promise(resolve => setTimeout(resolve, 25))\n        }\n        return null\n      }\n      const fail = stage => ({ ready: false, stage,\n        tabs: [...document.querySelectorAll('[data-work-tab=\"terminal\"]')].map(tab => ({ id: tab.dataset.sessionTab, selected: tab.getAttribute('aria-selected') })),\n        terminals: [...document.querySelectorAll('.work-tab-panel [data-terminal-id]')].map(host => host.dataset.terminalId) })\n      const view = await waitFor(() => {\n        const pane = document.querySelector('.work-tab-panel:not([hidden])')\n        return pane?.querySelector('.xterm-screen') ? pane : null\n      })\n      const add = view?.querySelector('button[aria-label=\"新建终端\"]')\n      if (!(add instanceof HTMLButtonElement)) return fail('create-entry')\n      add.click()\n      const close = await waitFor(() => {\n        const tabs = document.querySelectorAll('[data-work-tab=\"terminal\"]')\n        const terminals = document.querySelectorAll('.work-tab-panel [data-terminal-id]')\n        return tabs.length === 2 && terminals.length === 2\n          ? [...document.querySelectorAll('.session-chrome button[aria-label^=\"关闭终端 \"]')].at(-1) : null\n      })\n      if (!(close instanceof HTMLButtonElement)) return fail('second-terminal')\n      close.click()\n      // 关闭会等待后台进程退出，不能用固定的 80ms 代替资源清理完成。\n      if (!await waitFor(() => document.querySelectorAll('[data-work-tab=\"terminal\"]').length === 1\n        && document.querySelectorAll('.work-tab-panel [data-terminal-id]').length === 1\n        && document.querySelector('[data-work-tab=\"terminal\"][aria-selected=\"true\"]')\n        && [...document.querySelectorAll('.composer-card')].every(composer => !composer.checkVisibility()))) return fail('close-second')\n      document.querySelector('[data-work-tab=\"file\"]')?.click()\n      if (!await waitFor(() => view.hidden\n        && document.querySelector('.work-tab-panel:not([hidden]) .code-editor'))) return fail('hide-preserved')\n      document.querySelector('[data-work-tab=\"terminal\"]')?.click()\n      if (!await waitFor(() => !view.hidden\n        && view.querySelector('[data-terminal-id]')?.dataset.terminalId === ",
  "\n        && document.querySelector('.navigation-island .source-control-navigation')\n        && !document.querySelector('[aria-label=\"项目文件树\"]')\n        && document.querySelector('[data-view=\"changes\"]')?.getAttribute('aria-current') === 'page'\n        && document.querySelector('.info-island.file-info-island [data-project-tasks=\"true\"]')\n        && !document.querySelector('.info-island .file-outline-panel'))) return fail('restore-preserved')\n      return { ready: true, stage: 'complete' }\n    })()",
] as const

/** 构造带参数的浏览器端验收探测脚本（files-scm #25）。 */
export function buildFilesScmScript25(p0: unknown): string {
  return FILES_SCM_PARTS_25[0]! + String(p0) + FILES_SCM_PARTS_25[1]!
}

/** 浏览器端验收探测脚本（files-scm #26）。 */
export const FILES_SCM_SCRIPT_26 = `(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const conversation = document.querySelector('[data-view="conversation"]')
      if (!(conversation instanceof HTMLButtonElement)) return false
      conversation.click()
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const currentConversation = document.querySelector('[data-view="conversation"]')
        const shell = document.querySelector('.app-shell')
        if (currentConversation instanceof HTMLButtonElement
          && currentConversation.classList.contains('is-active')
          && shell instanceof HTMLElement
          && shell.dataset.informationCollapsed !== 'true'
          && document.querySelector('.workspace-view') instanceof HTMLElement) return true
        if (currentConversation instanceof HTMLButtonElement) currentConversation.click()
        await sleep(25)
      }
      return false
    })()`
