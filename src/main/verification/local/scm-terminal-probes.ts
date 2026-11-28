/**
 * Source Control 暂存提交、Git 差异审阅与内置用户终端的渲染进程探测脚本。
 */

/** 切换到更改视图并等待 `scratch.md` 暂存按钮可用。 */
export const PREPARE_STAGEABLE_SCRATCH_PROBE = `(async () => {
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

/** 等待 `scratch.md` 完成暂存并显示取消暂存按钮。 */
export const VERIFY_SCRATCH_STAGED_PROBE = `(async () => {
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

/** 验证 Git 暂存分组与工作区更改分组可独立折叠与恢复。 */
export const GIT_CHANGE_GROUPS_COLLAPSE_PROBE = `(async () => {
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

/** 验证 Git 更改列表在条目超出一屏时支持内部纵向滚动。 */
export const GIT_CHANGE_LIST_SCROLL_PROBE = `(() => {
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

/** 验证批量取消全部暂存后显示操作反馈且恢复工作区文件。 */
export const BULK_UNSTAGE_NOTICE_PROBE = `(async () => {
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

/** 构造向提交消息输入框填写文本并等待提交按钮激活的探测脚本。 */
export function buildFillCommitMessageProbe(commitMessage: string): string {
  const messageLiteral = JSON.stringify(commitMessage)
  return `(async () => {
    const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
    const input = document.querySelector('#scm-commit-message')
    if (!(input instanceof HTMLTextAreaElement)) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    if (setter === undefined) return false
    setter.call(input, ${messageLiteral})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const button = document.querySelector('.scm-commit-button')
      if (button instanceof HTMLButtonElement && !button.disabled
        && input.value === ${messageLiteral}) return true
      await sleep(25)
    }
    return false
  })()`
}

/** 构造校验 `index.lock` 占用时展示友好错误提示且保留草稿提交消息的探测脚本。 */
export function buildIndexLockCommitErrorProbe(commitMessage: string): string {
  return `(async () => {
    const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const navigation = document.querySelector('.source-control-navigation')
      const alerts = [...document.querySelectorAll('.project-workspace-alert [role="alert"]')]
      const error = alerts[0]
      const input = document.querySelector('#scm-commit-message')
      const button = document.querySelector('.scm-commit-button')
      if (navigation?.getAttribute('aria-busy') === 'false'
        && alerts.length === 1
        && error?.textContent?.includes('Git 索引正被其他进程占用') === true
        && error?.textContent?.includes('Error invoking remote method') !== true
        && input instanceof HTMLTextAreaElement
        && input.value === ${JSON.stringify(commitMessage)}
        && button instanceof HTMLButtonElement
        && !button.disabled) {
        const close = error.querySelector('button[aria-label="关闭提示"]')
        if (!(close instanceof HTMLButtonElement)) return false
        close.click()
        for (let clearAttempt = 0; clearAttempt < 60; clearAttempt += 1) {
          if (document.querySelector('.project-workspace-alert [role="alert"]') === null) return true
          await sleep(25)
        }
        return false
      }
      await sleep(25)
    }
    return false
  })()`
}

/** 验证本地 Git 提交成功后清空输入框并展示通知。 */
export const GIT_COMMIT_SUCCESS_PROBE = `(async () => {
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

/** 验证右侧 Git 审阅面板工作区范围切换、Diff 渲染与响应式不溢出。 */
export const GIT_REVIEW_WORKING_DIFF_PROBE = `(async () => {
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

/** 验证右侧更改文件列表长短文件名的截断对齐与状态徽章不重叠。 */
export const CHANGE_FILE_LIST_BOUNDS_PROBE = `(() => {
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

/** 在新建工作标签下拉菜单中点击「新终端」。 */
export const CLICK_NEW_TERMINAL_MENU_ITEM_PROBE = `(async () => {
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

/** 验证新终端工作标签创建成功、隐藏 Composer 且联动更改与脚本侧栏。 */
export const TERMINAL_TAB_READY_PROBE = `(async () => {
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
  return { ready: false, stage: 'terminal-ready' }
})()`

/** 构造向终端 PTY 写入平台命令并验证 ANSI 色彩转义与项目工作目录输出的探测脚本。 */
export function buildTerminalAnsiAndCwdProbe(options: {
  readonly terminalId: string
  readonly command: string
  readonly expectedProjectPath: string
  readonly caseInsensitivePath: boolean
}): string {
  const idLiteral = JSON.stringify(options.terminalId)
  const expectedLiteral = JSON.stringify(options.expectedProjectPath)
  const pathCondition = options.caseInsensitivePath
    ? `output.toLowerCase().includes(${expectedLiteral})`
    : `output.includes(${expectedLiteral})`
  return `new Promise(resolve => {
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
      if (event.type !== 'data' || event.terminalId !== ${idLiteral}) return
      output += event.data
      if (output.includes('DSH_TERMINAL_ANSI_OK') && output.includes('\\u001b[31m')
        && (${pathCondition})) finish(true)
    })
    const timeout = setTimeout(() => { finish(false) }, 15_000)
    Promise.all([
      api.resize(${idLiteral}, 100, 30),
      api.write(${idLiteral}, ${JSON.stringify(options.command)})
    ]).catch(() => { finish(false) })
  })`
}

/** 构造验证新建第二个终端、关闭销毁及标签切换时保留首个终端实例的探测脚本。 */
export function buildTerminalMultiTabLifecycleProbe(terminalId: string): string {
  return `(async () => {
    const waitFor = async predicate => {
      for (let attempt = 0; attempt < 160; attempt++) {
        const result = predicate()
        if (result) return result
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return null
    }
    const fail = stage => ({
      ready: false,
      stage,
      tabs: [...document.querySelectorAll('[data-work-tab="terminal"]')].map(tab => ({ id: tab.dataset.sessionTab, selected: tab.getAttribute('aria-selected') })),
      terminals: [...document.querySelectorAll('.work-tab-panel [data-terminal-id]')].map(host => host.dataset.terminalId),
    })
    const view = await waitFor(() => {
      const pane = document.querySelector('.work-tab-panel:not([hidden])')
      return pane?.querySelector('.xterm-screen') ? pane : null
    })
    const add = view?.querySelector('button[aria-label="新建终端"]')
    if (!(add instanceof HTMLButtonElement)) return fail('create-entry')
    add.click()
    const close = await waitFor(() => {
      const tabs = document.querySelectorAll('[data-work-tab="terminal"]')
      const terminals = document.querySelectorAll('.work-tab-panel [data-terminal-id]')
      return tabs.length === 2 && terminals.length === 2
        ? [...document.querySelectorAll('.session-chrome button[aria-label^="关闭终端 "]')].at(-1) : null
    })
    if (!(close instanceof HTMLButtonElement)) return fail('second-terminal')
    close.click()
    if (!await waitFor(() => document.querySelectorAll('[data-work-tab="terminal"]').length === 1
      && document.querySelectorAll('.work-tab-panel [data-terminal-id]').length === 1
      && document.querySelector('[data-work-tab="terminal"][aria-selected="true"]')
      && [...document.querySelectorAll('.composer-card')].every(composer => !composer.checkVisibility()))) return fail('close-second')
    document.querySelector('[data-work-tab="file"]')?.click()
    if (!await waitFor(() => view.hidden
      && document.querySelector('.work-tab-panel:not([hidden]) .code-editor'))) return fail('hide-preserved')
    document.querySelector('[data-work-tab="terminal"]')?.click()
    if (!await waitFor(() => !view.hidden
      && view.querySelector('[data-terminal-id]')?.dataset.terminalId === ${JSON.stringify(terminalId)}
      && document.querySelector('.navigation-island .source-control-navigation')
      && !document.querySelector('[aria-label="项目文件树"]')
      && document.querySelector('[data-view="changes"]')?.getAttribute('aria-current') === 'page'
      && document.querySelector('.info-island.file-info-island [data-project-tasks="true"]')
      && !document.querySelector('.info-island .file-outline-panel'))) return fail('restore-preserved')
    return { ready: true, stage: 'complete' }
  })()`
}

/** 切回对话模式并等待工作台对话视图恢复。 */
export const RESTORE_CONVERSATION_VIEW_PROBE = `(async () => {
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
