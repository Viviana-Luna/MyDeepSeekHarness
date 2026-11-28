/**
 * 项目分组、会话置顶、会话搜索与液态标签栏动效验收的渲染进程探测脚本。
 */

/** 验证专注单个项目筛选、恢复全部项目及分组折叠与重新展开。 */
export const PROJECT_FOCUS_FILTER_PROBE = `(async () => {
  const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
  const waitFor = async (predicate, attempts = 80) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const value = predicate()
      if (value) return value
      await sleep(25)
    }
    return null
  }
  const findOpenProjectMenu = () => {
    const node = document.querySelector('.project-focus-menu[role="menu"]')
    return node instanceof HTMLElement
      && !node.hasAttribute('inert')
      && node.dataset.menuMotion === 'open'
      && node.checkVisibility()
      ? node
      : null
  }
  const selector = document.querySelector('button[aria-label="专注项目"]')
  if (!(selector instanceof HTMLButtonElement)
    || selector.textContent?.includes('全部项目') !== true) return false
  await waitFor(
    () =>
      !selector.disabled
      && selector.getAttribute('aria-expanded') !== 'true'
      && document.querySelector('.project-focus-menu') === null,
  )
  selector.click()
  let menu = await waitFor(findOpenProjectMenu)
  const option = menu instanceof HTMLElement
    ? [...menu.querySelectorAll('[role="menuitemradio"]')]
        .find(
          item =>
            item instanceof HTMLButtonElement
            && !item.disabled
            && item.checkVisibility()
            && item.getAttribute('aria-checked') !== 'true',
        )
    : undefined
  if (!(option instanceof HTMLButtonElement)) {
    return document.querySelectorAll('.project-session-group').length === 0
  }
  option.click()
  const visible = element => element instanceof HTMLElement && element.getClientRects().length > 0
  const focused = (await waitFor(() => {
    const focusedGroup = document.querySelector('.project-session-group')
    const focusedRows = focusedGroup === null
      ? []
      : [...focusedGroup.querySelectorAll('.session-row')].filter(visible)
    const focusedToggle = focusedGroup?.querySelector('[data-project-toggle]')
    const focusedProjectId = focusedGroup?.getAttribute('data-project-group')
    const focusedList = focusedGroup?.querySelector('.project-session-list')
    const focusedBlankReady = focusedRows.length === 0
      && focusedList?.querySelector('.session-list__empty') instanceof HTMLElement
    return selector.textContent?.includes('全部项目') !== true
      && document.querySelectorAll('.project-session-group').length === 1
      && document.querySelector('.project-section-heading h2')?.textContent?.trim() === '会话'
      && (focusedRows.length > 0 || focusedBlankReady)
      && focusedProjectId !== null
      && focusedGroup?.querySelector('.project-group-heading') === null
      && focusedToggle === null
      && focusedList instanceof HTMLElement
      && !focusedList.hidden
      && focusedRows.every(row => row.getAttribute('data-project-id') === focusedProjectId)
  })) === true
  await waitFor(
    () =>
      !selector.disabled
      && selector.getAttribute('aria-expanded') !== 'true'
      && document.querySelector('.project-focus-menu') === null,
  )
  selector.click()
  menu = await waitFor(findOpenProjectMenu)
  const allProjects = menu instanceof HTMLElement
    ? [...menu.querySelectorAll('[role="menuitemradio"]')]
        .find(
          item =>
            item instanceof HTMLButtonElement
            && !item.disabled
            && item.checkVisibility()
            && item.textContent?.includes('全部项目') === true,
        )
    : undefined
  if (!(allProjects instanceof HTMLButtonElement)) return false
  allProjects.click()
  const restoredState = await waitFor(() => {
    const selectedRow = [...document.querySelectorAll('.session-row')]
      .find(row => row.getAttribute('aria-current') === 'page' && visible(row))
    const selectedGroup = selectedRow?.closest('.project-session-group')
      ?? document.querySelector('.project-group-heading.has-selected-session')?.closest('.project-session-group')
    const toggle = selectedGroup?.querySelector('[data-project-toggle]')
    if (!(selectedGroup instanceof HTMLElement) || !(toggle instanceof HTMLButtonElement)) return null
    const controlledId = toggle.getAttribute('aria-controls')
    const controlled = controlledId === null ? null : document.getElementById(controlledId)
    if (selector.textContent?.includes('全部项目') === true
      && toggle.getAttribute('aria-expanded') === 'true'
      && controlled instanceof HTMLElement
      && !controlled.hidden) {
      return {
        selectedGroup,
        toggle,
        controlled,
        selectedBlankHidden: !(selectedRow instanceof HTMLButtonElement),
      }
    }
    return null
  })
  if (restoredState === null) return false
  const { selectedGroup, toggle, controlled, selectedBlankHidden } = restoredState
  toggle.click()
  const collapsed = (await waitFor(() =>
    selector.textContent?.includes('全部项目') === true
      && toggle.getAttribute('aria-expanded') === 'false'
      && controlled.hidden
      && ![...selectedGroup.querySelectorAll('.session-row')].some(visible))) === true
  toggle.click()
  const expandedAgain = (await waitFor(() =>
    selector.textContent?.includes('全部项目') === true
      && toggle.getAttribute('aria-expanded') === 'true'
      && !controlled.hidden
      && (selectedBlankHidden || [...selectedGroup.querySelectorAll('.session-row')].some(visible)))) === true
  return focused
    && collapsed
    && expandedAgain
    && [...document.querySelectorAll('.session-row')]
      .every(row => row.closest('.project-session-group') !== null)
})()`

/** 构造校验指定会话已移入置顶分组且本地存储同步的探测脚本。 */
export function buildPinnedSessionProbe(sessionId: string): string {
  return `(async () => {
    const sessionId = ${JSON.stringify(sessionId)}
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const pinnedGroup = document.querySelector('.pinned-session-group')
      const pinnedRow = pinnedGroup?.querySelector('.session-row-shell[data-session-id=' + JSON.stringify(sessionId) + ']')
      const projectDuplicate = document.querySelector('.project-session-group .session-row-shell[data-session-id=' + JSON.stringify(sessionId) + ']')
      const unpin = pinnedRow?.querySelector('button[aria-label="取消置顶聊天"]')
      const archive = pinnedRow?.querySelector('button[aria-label="归档聊天"]')
      const stored = JSON.parse(localStorage.getItem('mydsh:pinned-session-ids') ?? '[]')
      if (pinnedGroup instanceof HTMLElement
        && pinnedRow instanceof HTMLElement
        && unpin instanceof HTMLButtonElement
        && archive instanceof HTMLButtonElement) {
        const rowRect = pinnedRow.getBoundingClientRect()
        const groupRect = pinnedGroup.getBoundingClientRect()
        const ok = pinnedGroup.querySelector('h2')?.textContent?.trim() === '置顶'
          && pinnedRow.getAttribute('data-pinned') === 'true'
          && projectDuplicate === null
          && Array.isArray(stored)
          && stored[0] === sessionId
          && rowRect.left >= groupRect.left - 1
          && rowRect.right <= groupRect.right + 1
          && rowRect.height >= 32
        if (ok) return true
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return false
  })()`
}

/** 构造校验指定会话已取消置顶并回到所属项目分组的探测脚本。 */
export function buildUnpinnedSessionProbe(sessionId: string): string {
  return `(async () => {
    const sessionId = ${JSON.stringify(sessionId)}
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const projectRow = document.querySelector('.project-session-group .session-row-shell[data-session-id=' + JSON.stringify(sessionId) + ']')
      const stored = JSON.parse(localStorage.getItem('mydsh:pinned-session-ids') ?? '[]')
      if (projectRow instanceof HTMLElement
        && document.querySelector('.pinned-session-group') === null
        && Array.isArray(stored)
        && !stored.includes(sessionId)) return true
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return false
  })()`
}

/** 等待会话搜索弹窗打开、自动聚焦搜索框并展示候选结果。 */
export const SESSION_SEARCH_OPEN_PROBE = `(async () => {
  let state
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const trigger = document.querySelector('.session-search-trigger')
    const dialog = document.querySelector('#session-search-dialog')
    const input = dialog?.querySelector('input[type="search"]')
    const results = [...document.querySelectorAll('.session-search-result')]
    const ready = trigger instanceof HTMLButtonElement
      && trigger.getAttribute('aria-expanded') === 'true'
      && dialog instanceof HTMLElement
      && dialog.getAttribute('role') === 'dialog'
      && input instanceof HTMLInputElement
      && document.activeElement === input
      && results.length > 0
      && results.every(result => result.querySelector('strong')?.textContent?.trim() !== '')
      && results.every(result => result.querySelector('small')?.textContent?.trim() !== '')
    state = {
      ready,
      expanded: trigger?.getAttribute('aria-expanded') ?? null,
      dialogPresent: dialog instanceof HTMLElement,
      closePresent: dialog?.querySelector('.session-search-close') instanceof HTMLButtonElement,
      inputFocused: document.activeElement === input,
      resultCount: results.length,
      ...(ready
        ? {}
        : {
            activeTag: document.activeElement?.tagName ?? null,
            activeClass: document.activeElement instanceof HTMLElement ? document.activeElement.className : null,
            documentHasFocus: document.hasFocus(),
          }),
    }
    if (ready) {
      await Promise.allSettled(
        dialog
          .getAnimations({ subtree: true })
          .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map(animation => animation.finished),
      )
      return state
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return state
})()`

/** 等待会话搜索弹窗关闭且焦点归还触发按钮。 */
export const SESSION_SEARCH_CLOSE_PROBE = `(async () => {
  let state
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const trigger = document.querySelector('.session-search-trigger')
    const closed = document.querySelector('#session-search-dialog') === null
      && trigger?.getAttribute('aria-expanded') === 'false'
      && document.activeElement === trigger
    state = {
      closed,
      dialogAbsent: document.querySelector('#session-search-dialog') === null,
      expanded: trigger?.getAttribute('aria-expanded') ?? null,
      triggerFocused: document.activeElement === trigger,
      activeTag: document.activeElement?.tagName ?? null,
    }
    if (closed) return state
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return state
})()`

/** 构造在搜索结果中标记另一个项目分组条目的探测脚本。 */
export function buildMarkOtherGroupSearchResultProbe(originalGroupLabel: string): string {
  return `(async () => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const result = [...document.querySelectorAll('.session-search-result')]
        .find(button => button.querySelector('small')?.textContent !== ${JSON.stringify(originalGroupLabel)})
      if (result) {
        result.id = 'verify-other-group'
        return
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error('缺少另一个项目的验收会话')
  })()`
}

/** 构造在同一项目下创建并重命名第二个验收会话的探测脚本。 */
export function buildCreatePeerSessionProbe(originalSessionId: string): string {
  const sessionIdLiteral = JSON.stringify(originalSessionId)
  return `(async () => {
    const { items } = await window.dshDesktop.host.call('listWorkspaces', {})
    const project = items.find(item => item.sessionIds.includes(${sessionIdLiteral}))
    const { items: sessions } = await window.dshDesktop.host.call('listSessions', {})
    const original = sessions.find(item => item.sessionId === ${sessionIdLiteral})
    const result = project
      ? await window.dshDesktop.host.call('createSessionForWorkspace', { workspaceId: project.workspaceId })
      : await window.dshDesktop.host.call('createSession', { ...(original.cwd ? { cwd: original.cwd } : {}) })
    await window.dshDesktop.host.call('renameSession', { sessionId: result.sessionId, title: '标签交互验收' })
    return result.sessionId
  })()`
}

/** 构造验证未选中会话标签聚焦态底色与已选中标签透明底色的探测脚本。 */
export function buildIdleTabFocusSurfaceProbe(tabSelector: string): string {
  return `(async () => {
    const tab = document.querySelector(${JSON.stringify(tabSelector)})
    const idle = tab.closest('.session-tab-shell')
    const selected = document.querySelector('.session-tab-shell[data-selected]')
    tab.focus()
    let state
    // 焦点与背景过渡随绘制帧更新，不能假定后台平台在固定 140ms 内完成。
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const idleBackground = getComputedStyle(idle).backgroundColor
      const selectedBackground = getComputedStyle(selected).backgroundColor
      state = {
        ready: !idle.hasAttribute('data-selected') && document.activeElement === tab
          && idle.matches(':focus-within') && idleBackground !== 'rgba(0, 0, 0, 0)'
          && selectedBackground === 'rgba(0, 0, 0, 0)',
        focused: document.activeElement?.getAttribute('data-session-tab'),
        documentFocused: document.hasFocus(),
        focusWithin: idle.matches(':focus-within'),
        idleBackground,
        selectedBackground,
      }
      if (state.ready) return state
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return state
  })()`
}

/** 采样液态玻璃标签切换过程中的折射中心对齐、形变幅度与文字清晰度。 */
export const LIQUID_TAB_MOTION_PROBE = `(async () => {
  const lens = document.querySelector('.session-tab-lens')
  const active = document.querySelector('.session-tab-shell[data-selected="true"]')
  const root = document.querySelector('.session-tab-glass')
  const fromX = lens.getBoundingClientRect().left - root.getBoundingClientRect().left
  const region = document.querySelector('.session-glass-filter [data-lens]')
  const materialBounds = document.querySelector('.session-tab-material').getBoundingClientRect()
  const refractionCenter = materialBounds.left + (Number(region.getAttribute('x')) + Number(region.getAttribute('width')) / 2) * materialBounds.width
  const motionCenterOffset = Math.abs(lens.getBoundingClientRect().left + lens.getBoundingClientRect().width / 2 - refractionCenter)
  const targetX = active.getBoundingClientRect().left - root.getBoundingClientRect().left
  const lensBounds = lens.getBoundingClientRect()
  const activeBounds = active.getBoundingClientRect()
  const centerOffset = Math.abs((lensBounds.left + lensBounds.right - activeBounds.left - activeBounds.right) / 2)
  let continued = lens.dataset.moving === 'true' || centerOffset <= 1
  let maximumHeight = lens.getBoundingClientRect().height
  let minimumWidth = lens.getBoundingClientRect().width
  const deadline = performance.now() + 2000
  while (performance.now() < deadline) {
    await new Promise(resolve => requestAnimationFrame(resolve))
    const currentLens = lens.getBoundingClientRect()
    const currentActive = active.getBoundingClientRect()
    continued ||= lens.dataset.moving === 'true'
      || Math.abs((currentLens.left + currentLens.right - currentActive.left - currentActive.right) / 2) <= 1
    maximumHeight = Math.max(maximumHeight, lens.getBoundingClientRect().height)
    minimumWidth = Math.min(minimumWidth, lens.getBoundingClientRect().width)
    if (lens.dataset.moving === undefined && Math.abs(lens.getBoundingClientRect().height - 26) < .1) break
  }
  const restrained = maximumHeight <= 29.2 && minimumWidth >= active.offsetWidth * .88
  const unscaledHitTarget = getComputedStyle(document.querySelector('.session-tab[aria-selected="true"]')).transform === 'none'
  const content = document.querySelector('.session-tab-content')
  const material = document.querySelector('.session-tab-material')
  const labelsSharp = getComputedStyle(content).filter === 'none'
    && Number(getComputedStyle(content).zIndex) > Number(getComputedStyle(lens).zIndex)
    && material.getAttribute('aria-hidden') === 'true' && !material.contains(active)
  const ready = continued && restrained && motionCenterOffset <= 1.5 && unscaledHitTarget && labelsSharp && lens.dataset.moving === undefined
    && document.querySelectorAll('.session-tab-lens').length === 1
    && document.querySelectorAll('.session-glass-filter feDisplacementMap').length === 3
    && getComputedStyle(material).filter !== 'none'
    && Math.abs(lens.getBoundingClientRect().height - 26) < .1
    && Math.abs(lens.getBoundingClientRect().width - active.offsetWidth) <= 1
    && Math.abs(lens.getBoundingClientRect().left - active.getBoundingClientRect().left) <= 1
  return {
    ready,
    labelsSharp,
    continued,
    maximumHeight,
    minimumWidth,
    motionCenterOffset,
    fromX,
    targetX,
    centerOffset,
    restingHeight: lens.getBoundingClientRect().height,
    alignment: lens.getBoundingClientRect().left - active.getBoundingClientRect().left,
  }
})()`

/** 验证按住当前会话标签触发透镜按压形变标记。 */
export const TAB_LENS_PRESS_PROBE = `(async () => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const lens = document.querySelector('.session-tab-lens')
    const height = lens?.getBoundingClientRect().height ?? 0
    if (lens instanceof HTMLElement
      && lens.dataset.pressed === 'true'
      && height >= 25
      && height <= 27
      && document.querySelectorAll('.session-tab-lens').length === 1
      && getComputedStyle(document.querySelector('.session-tab-shell[data-selected]')).backgroundColor === 'rgba(0, 0, 0, 0)') {
      return true
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return false
})()`

/** 校验多标签展开态下顶部会话栏几何、拖拽区与 1px 描边连续性。 */
export const EXPANDED_SESSION_CHROME_PROBE = `(() => {
  const chrome = document.querySelector('.session-chrome')
  const lens = document.querySelector('.session-tab-lens')
  const bar = document.querySelector('.session-tabs')
  const active = document.querySelector('.session-tab[aria-selected="true"]')
  const items = document.querySelector('.session-tab-items')
  const search = document.querySelector('.session-search-trigger')
  if (!(chrome instanceof HTMLElement) || !(lens instanceof HTMLElement) || !(bar instanceof HTMLElement) || !(items instanceof HTMLElement)) return false
  const rect = lens.getBoundingClientRect(), barRect = bar.getBoundingClientRect(), chromeRect = chrome.getBoundingClientRect()
  const border = getComputedStyle(lens)
  return chrome.getAttribute('aria-hidden') === 'false' && !chrome.inert && chrome.offsetHeight === 32
    && search instanceof HTMLButtonElement && document.querySelector('.project-focus').contains(search)
    && document.querySelectorAll('.session-search-trigger').length === 1
    && search.getBoundingClientRect().right < barRect.left
    && Math.abs(rect.top - chromeRect.top - 3) <= 1
    && Math.abs(chromeRect.bottom - rect.bottom - 3) <= 1
    && bar.querySelectorAll('.session-tab-group[aria-label]').length === 1
    && document.querySelector('.session-group-switcher') === null
    && [...bar.querySelectorAll('.session-tab-shell')].every(tab => tab.closest('.session-tab-group') !== null && tab.getBoundingClientRect().width >= 96)
    && ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'].every(side =>
      Math.abs(Number.parseFloat(border[side]) * devicePixelRatio - Math.max(1, Math.floor(devicePixelRatio))) < .1)
    && getComputedStyle(bar).getPropertyValue('-webkit-app-region') === 'drag'
    && getComputedStyle(items).getPropertyValue('-webkit-app-region') === 'no-drag'
    && items.offsetHeight === 26 && items.contains(active)
    && getComputedStyle(active).getPropertyValue('-webkit-app-region') !== 'drag'
})()`

/** 验证 900px 窄窗口下会话透镜仍准确对齐当前激活标签。 */
export const NARROW_TAB_LENS_ALIGNMENT_PROBE = `(async () => {
  const deadline = performance.now() + 2000
  let state
  do {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const lens = document.querySelector('.session-tab-lens').getBoundingClientRect()
    const active = document.querySelector('.session-tab-shell[data-selected="true"]').getBoundingClientRect()
    state = {
      viewport: innerWidth,
      left: lens.left,
      width: lens.width,
      targetLeft: active.left,
      targetWidth: active.width,
      ready: Math.abs(innerWidth - 900) <= 1 && Math.abs(lens.left - active.left) <= 1 && Math.abs(lens.width - active.width) <= 1,
    }
  } while (!state.ready && performance.now() < deadline)
  return state
})()`

/** 验证 725px 超窄视口隐藏项目选择器并完整保留侧栏搜索按钮。 */
export const COMPACT_SIDEBAR_SEARCH_PROBE = `(async () => {
  const deadline = performance.now() + 2000
  let state
  do {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const sidebar = document.querySelector('.sidebar-island').getBoundingClientRect()
    const project = document.querySelector('.project-selector')
    const search = document.querySelector('.sidebar-island .session-search-trigger').getBoundingClientRect()
    const railWidth = Number.parseFloat(getComputedStyle(document.querySelector('.app-shell')).getPropertyValue('--mode-rail-width'))
    state = {
      viewport: innerWidth,
      sidebarWidth: sidebar.width,
      projectDisplay: getComputedStyle(project).display,
      searchWidth: search.width,
      searchLeft: search.left,
      sidebarLeft: sidebar.left,
      searchRight: search.right,
      sidebarRight: sidebar.right,
      ready: Math.abs(innerWidth - 725) <= 2 && sidebar.width <= railWidth + 3 && getComputedStyle(project).display === 'none'
        && search.width >= 28 && search.left >= sidebar.left && search.right <= sidebar.right,
    }
  } while (!state.ready && performance.now() < deadline)
  return state
})()`

/** 验证减少透明度、高对比度与强制色彩下标签玻璃滤镜降级为高对比描边。 */
export const ACCESSIBLE_TAB_MATERIAL_PROBE = `(async () => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const active = document.querySelector('.session-tab-shell[data-selected="true"]')
    if (getComputedStyle(document.querySelector('.session-tab-content')).filter === 'none'
      && getComputedStyle(document.querySelector('.session-tab-material')).filter === 'none'
      && getComputedStyle(document.querySelector('.session-tab-lens')).display === 'none'
      && Number.parseFloat(getComputedStyle(active).outlineWidth) * devicePixelRatio >= .99) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return false
})()`

/** 验证标签栏水平溢出时显示右滚箭头且禁用左滚箭头。 */
export const TAB_STRIP_OVERFLOW_START_PROBE = `(async () => {
  const deadline = performance.now() + 2000
  while (performance.now() < deadline) {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const strip = document.querySelector('.session-tabs')
    const left = document.querySelector('.session-tab-scroll--left')
    const right = document.querySelector('.session-tab-scroll--right')
    const tabs = [...document.querySelectorAll('.session-tab-shell')]
    if (strip.scrollWidth > strip.clientWidth && !right.hidden) {
      strip.scrollLeft = 0
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      return left.disabled && !right.disabled && tabs.every(tab => tab.getBoundingClientRect().width >= 96)
        && getComputedStyle(strip).borderLeftWidth === '0px'
        && getComputedStyle(document.querySelector('.session-tabs-frame')).borderRadius === '16px'
    }
  }
  return false
})()`

/** 验证点击右滚箭头后滚动到末尾并切换左右箭头禁用状态。 */
export const TAB_STRIP_OVERFLOW_END_PROBE = `(async () => {
  const deadline = performance.now() + 1000
  while (performance.now() < deadline) {
    await new Promise(resolve => requestAnimationFrame(resolve))
    const strip = document.querySelector('.session-tabs')
    const left = document.querySelector('.session-tab-scroll--left')
    const right = document.querySelector('.session-tab-scroll--right')
    if (strip.scrollLeft > 1 && !left.disabled && right.disabled) return true
  }
  return false
})()`

/** 清除标签框临时窄宽限制并等待布局恢复。 */
export const RESET_TAB_STRIP_FLEX_PROBE = `(async () => {
  document.querySelector('.session-tabs-frame').style.removeProperty('flex')
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const strip = document.querySelector('.session-tabs')
    if (strip instanceof HTMLElement && strip.scrollWidth <= strip.clientWidth + 1) break
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  await Promise.race([
    new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    new Promise(resolve => setTimeout(resolve, 200)),
  ])
})()`

/** 构造关闭第二个标签后验证单标签沉浸态（顶栏隐藏、悬浮新建按钮就位）的探测脚本。 */
export function buildSingleTabImmersionProbe(
  originalSessionId: string,
  closedTabSelector: string,
): string {
  return `(async () => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const active = document.querySelector('.session-tab[aria-selected="true"]')
      const chrome = document.querySelector('.session-chrome')
      const shell = document.querySelector('.app-shell')
      const main = document.querySelector('.main-island')
      const floating = document.querySelector('[data-floating-tab-actions="true"]')
      const overviewButtons = document.querySelectorAll('[aria-label="平铺选择标签"]')
      const newTabButtons = document.querySelectorAll('[aria-label="新建工作标签"]')
      const tools = main?.querySelector('.conversation-tools')
      const blur = main?.querySelector('[data-top-progressive-blur="true"]')
      const windowEdge = Number.parseFloat(getComputedStyle(shell).getPropertyValue('--window-edge'))
      const floatingRect = floating instanceof HTMLElement ? floating.getBoundingClientRect() : null
      const toolsRect = tools instanceof HTMLElement ? tools.getBoundingClientRect() : null
      const ready = active?.getAttribute('data-session-tab') === ${JSON.stringify(originalSessionId)}
        && document.querySelector(${JSON.stringify(closedTabSelector)}) === null
        && document.querySelectorAll('.session-tab').length === 1
        && shell?.dataset.sessionTabsVisible === 'false'
        && chrome instanceof HTMLElement && chrome.getAttribute('aria-hidden') === 'true' && chrome.inert
        && getComputedStyle(chrome).visibility === 'hidden'
        && document.querySelectorAll('.session-search-trigger').length === 1
        && document.querySelector('.project-focus .session-search-trigger') instanceof HTMLButtonElement
        && Math.abs(main.getBoundingClientRect().top - windowEdge) <= 1
        && floating instanceof HTMLElement && floating.checkVisibility()
        && overviewButtons.length === 1 && newTabButtons.length === 1
        && floating.contains(overviewButtons[0]) && floating.contains(newTabButtons[0])
        && (toolsRect === null || (floatingRect !== null
          && toolsRect.top >= floatingRect.bottom
          && Math.abs(toolsRect.right - (floatingRect.right - 4)) <= 1))
        && blur instanceof HTMLElement && getComputedStyle(blur).pointerEvents === 'none'
        && (document.activeElement === newTabButtons[0]
          || document.activeElement === document.querySelector('.session-search-trigger'))
        && document.querySelector('.main-island .composer-card') !== null
      if (ready) return true
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return false
  })()`
}
