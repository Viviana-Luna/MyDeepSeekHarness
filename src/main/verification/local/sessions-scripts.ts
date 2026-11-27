/**
 * 项目分组、会话操作、会话搜索与液态标签栏动效验收套件：在渲染进程上下文执行的页面探测脚本集合。
 */

/** 浏览器端验收探测脚本（sessions #1）。 */
export const SESSIONS_SCRIPT_1 = `(async () => {
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
        const restored = true
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
          && restored
          && collapsed
          && expandedAgain
          && [...document.querySelectorAll('.session-row')]
            .every(row => row.closest('.project-session-group') !== null)
      })()`

const SESSIONS_PARTS_2 = [
  '(async () => {\n        const sessionId = ',
  "\n        for (let attempt = 0; attempt < 80; attempt += 1) {\n          const pinnedGroup = document.querySelector('.pinned-session-group')\n          const pinnedRow = pinnedGroup?.querySelector('.session-row-shell[data-session-id=' + JSON.stringify(sessionId) + ']')\n          const projectDuplicate = document.querySelector('.project-session-group .session-row-shell[data-session-id=' + JSON.stringify(sessionId) + ']')\n          const unpin = pinnedRow?.querySelector('button[aria-label=\"取消置顶聊天\"]')\n          const archive = pinnedRow?.querySelector('button[aria-label=\"归档聊天\"]')\n          const stored = JSON.parse(localStorage.getItem('mydsh:pinned-session-ids') ?? '[]')\n          if (pinnedGroup instanceof HTMLElement\n            && pinnedRow instanceof HTMLElement\n            && unpin instanceof HTMLButtonElement\n            && archive instanceof HTMLButtonElement) {\n            const rowRect = pinnedRow.getBoundingClientRect()\n            const groupRect = pinnedGroup.getBoundingClientRect()\n            const ok = pinnedGroup.querySelector('h2')?.textContent?.trim() === '置顶'\n              && pinnedRow.getAttribute('data-pinned') === 'true'\n              && projectDuplicate === null\n              && Array.isArray(stored)\n              && stored[0] === sessionId\n              && rowRect.left >= groupRect.left - 1\n              && rowRect.right <= groupRect.right + 1\n              && rowRect.height >= 32\n            if (ok) return true\n          }\n          await new Promise(resolve => setTimeout(resolve, 25))\n        }\n        return false\n      })()",
] as const

/** 构造带参数的浏览器端验收探测脚本（sessions #2）。 */
export function buildSessionsScript2(p0: unknown): string {
  return SESSIONS_PARTS_2[0]! + String(p0) + SESSIONS_PARTS_2[1]!
}

const SESSIONS_PARTS_3 = [
  '(async () => {\n          const sessionId = ',
  "\n          for (let attempt = 0; attempt < 80; attempt += 1) {\n            const projectRow = document.querySelector('.project-session-group .session-row-shell[data-session-id=' + JSON.stringify(sessionId) + ']')\n            const stored = JSON.parse(localStorage.getItem('mydsh:pinned-session-ids') ?? '[]')\n            if (projectRow instanceof HTMLElement\n              && document.querySelector('.pinned-session-group') === null\n              && Array.isArray(stored)\n              && !stored.includes(sessionId)) return true\n            await new Promise(resolve => setTimeout(resolve, 25))\n          }\n          return false\n        })()",
] as const

/** 构造带参数的浏览器端验收探测脚本（sessions #3）。 */
export function buildSessionsScript3(p0: unknown): string {
  return SESSIONS_PARTS_3[0]! + String(p0) + SESSIONS_PARTS_3[1]!
}

/** 浏览器端验收探测脚本（sessions #4）。 */
export const SESSIONS_SCRIPT_4 = `(async () => {
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

/** 浏览器端验收探测脚本（sessions #5）。 */
export const SESSIONS_SCRIPT_5 = `(async () => {
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

const SESSIONS_PARTS_6 = [
  "(async () => {\n        for (let attempt = 0; attempt < 80; attempt += 1) {\n          const result = [...document.querySelectorAll('.session-search-result')]\n            .find(button => button.querySelector('small')?.textContent !== ",
  ")\n          if (result) {\n            result.id = 'verify-other-group'\n            return\n          }\n          await new Promise(resolve => setTimeout(resolve, 25))\n        }\n        throw new Error('缺少另一个项目的验收会话')\n      })()",
] as const

/** 构造带参数的浏览器端验收探测脚本（sessions #6）。 */
export function buildSessionsScript6(p0: unknown): string {
  return SESSIONS_PARTS_6[0]! + String(p0) + SESSIONS_PARTS_6[1]!
}

const SESSIONS_PARTS_7 = [
  "(async () => {\n        const { items } = await window.dshDesktop.host.call('listWorkspaces', {})\n        const project = items.find(item => item.sessionIds.includes(",
  "))\n        const { items: sessions } = await window.dshDesktop.host.call('listSessions', {})\n        const original = sessions.find(item => item.sessionId === ",
  ")\n        const result = project\n          ? await window.dshDesktop.host.call('createSessionForWorkspace', { workspaceId: project.workspaceId })\n          : await window.dshDesktop.host.call('createSession', { ...(original.cwd ? { cwd: original.cwd } : {}) })\n        await window.dshDesktop.host.call('renameSession', { sessionId: result.sessionId, title: '标签交互验收' })\n        return result.sessionId\n      })()",
] as const

/** 构造带参数的浏览器端验收探测脚本（sessions #7）。 */
export function buildSessionsScript7(p0: unknown, p1: unknown): string {
  return (
    SESSIONS_PARTS_7[0]! + String(p0) + SESSIONS_PARTS_7[1]! + String(p1) + SESSIONS_PARTS_7[2]!
  )
}

const SESSIONS_PARTS_8 = [
  '(async () => {\n          const tab = document.querySelector(',
  ")\n          const idle = tab.closest('.session-tab-shell')\n          const selected = document.querySelector('.session-tab-shell[data-selected]')\n          tab.focus()\n          let state\n          // 焦点与背景过渡随绘制帧更新，不能假定后台平台在固定 140ms 内完成。\n          for (let attempt = 0; attempt < 80; attempt += 1) {\n            const idleBackground = getComputedStyle(idle).backgroundColor\n            const selectedBackground = getComputedStyle(selected).backgroundColor\n            state = {\n              ready: !idle.hasAttribute('data-selected') && document.activeElement === tab\n                && idle.matches(':focus-within') && idleBackground !== 'rgba(0, 0, 0, 0)'\n                && selectedBackground === 'rgba(0, 0, 0, 0)',\n              focused: document.activeElement?.getAttribute('data-session-tab'),\n              documentFocused: document.hasFocus(), focusWithin: idle.matches(':focus-within'),\n              idleBackground, selectedBackground,\n            }\n            if (state.ready) return state\n            await new Promise(resolve => setTimeout(resolve, 25))\n          }\n          return state\n        })()",
] as const

/** 构造带参数的浏览器端验收探测脚本（sessions #8）。 */
export function buildSessionsScript8(p0: unknown): string {
  return SESSIONS_PARTS_8[0]! + String(p0) + SESSIONS_PARTS_8[1]!
}

/** 浏览器端验收探测脚本（sessions #9）。 */
export const SESSIONS_SCRIPT_9 = `(async () => {
          const lens = document.querySelector('.session-tab-lens')
          const active = document.querySelector('.session-tab-shell[data-selected="true"]')
          const root = document.querySelector('.session-tab-glass')
          const fromX = lens.getBoundingClientRect().left - root.getBoundingClientRect().left
          const region = document.querySelector('.session-glass-filter [data-lens]')
          const materialBounds = document.querySelector('.session-tab-material').getBoundingClientRect()
          const refractionCenter = materialBounds.left + (Number(region.getAttribute('x')) + Number(region.getAttribute('width')) / 2) * materialBounds.width
          const motionCenterOffset = Math.abs(lens.getBoundingClientRect().left + lens.getBoundingClientRect().width / 2 - refractionCenter)
          // 使用同一坐标系的浮点几何，避免 Windows 分数缩放被 offsetLeft 的取整误差影响。
          const targetX = active.getBoundingClientRect().left - root.getBoundingClientRect().left
          // 按压缩放会改变透镜外沿；是否跟随标签应比较中心，最终静止边界仍在下方单独校验。
          const lensBounds = lens.getBoundingClientRect()
          const activeBounds = active.getBoundingClientRect()
          const centerOffset = Math.abs((lensBounds.left + lensBounds.right - activeBounds.left - activeBounds.right) / 2)
          let continued = lens.dataset.moving === 'true' || centerOffset <= 1
          let maximumHeight = lens.getBoundingClientRect().height
          let minimumWidth = lens.getBoundingClientRect().width
          const deadline = performance.now() + 2000
          while (performance.now() < deadline) {
            await new Promise(resolve => requestAnimationFrame(resolve))
            // 按压回弹与移动标记在绘制帧更新；不能只用点击后的单次采样判定是否跟随。
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
          return { ready, labelsSharp, continued, maximumHeight, minimumWidth, motionCenterOffset, fromX, targetX, centerOffset,
            restingHeight: lens.getBoundingClientRect().height,
            alignment: lens.getBoundingClientRect().left - active.getBoundingClientRect().left }
        })()`

/** 浏览器端验收探测脚本（sessions #10）。 */
export const SESSIONS_SCRIPT_10 = `(async () => {
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

/** 浏览器端验收探测脚本（sessions #11）。 */
export const SESSIONS_SCRIPT_11 = `(() => {
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
            // 150% 缩放会将 1 CSS px 的描边取整为 1 物理像素，计算样式因此是 2/3 px。
            && ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'].every(side =>
              Math.abs(Number.parseFloat(border[side]) * devicePixelRatio - Math.max(1, Math.floor(devicePixelRatio))) < .1)
            && getComputedStyle(bar).getPropertyValue('-webkit-app-region') === 'drag'
            && getComputedStyle(items).getPropertyValue('-webkit-app-region') === 'no-drag'
            && items.offsetHeight === 26 && items.contains(active)
            && getComputedStyle(active).getPropertyValue('-webkit-app-region') !== 'drag'
        })()`

/** 浏览器端验收探测脚本（sessions #12）。 */
export const SESSIONS_SCRIPT_12 = `(async () => {
            const deadline = performance.now() + 2000
            let state
            do {
              await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
              const lens = document.querySelector('.session-tab-lens').getBoundingClientRect()
              const active = document.querySelector('.session-tab-shell[data-selected="true"]').getBoundingClientRect()
              state = { viewport: innerWidth, left: lens.left, width: lens.width, targetLeft: active.left, targetWidth: active.width,
                // Windows 在 150% 缩放下将原生尺寸取整，900 DIP 请求可能得到 901 DIP。
                ready: Math.abs(innerWidth - 900) <= 1 && Math.abs(lens.left - active.left) <= 1 && Math.abs(lens.width - active.width) <= 1 }
            } while (!state.ready && performance.now() < deadline)
            return state
          })()`

/** 浏览器端验收探测脚本（sessions #13）。 */
export const SESSIONS_SCRIPT_13 = `(async () => {
            // 原生窗口缩放异步抵达 renderer，等布局满足条件后再验收最终几何。
            const deadline = performance.now() + 2000
            let state
            do {
              await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
              const sidebar = document.querySelector('.sidebar-island').getBoundingClientRect()
              const project = document.querySelector('.project-selector')
              const search = document.querySelector('.sidebar-island .session-search-trigger').getBoundingClientRect()
              const railWidth = Number.parseFloat(getComputedStyle(document.querySelector('.app-shell')).getPropertyValue('--mode-rail-width'))
              state = { viewport: innerWidth, sidebarWidth: sidebar.width, projectDisplay: getComputedStyle(project).display,
                searchWidth: search.width, searchLeft: search.left, sidebarLeft: sidebar.left, searchRight: search.right, sidebarRight: sidebar.right,
                // 150% 缩放下窗口最小尺寸与客户区分别取整，725 DIP 请求实测可得到 727 DIP。
                ready: Math.abs(innerWidth - 725) <= 2 && sidebar.width <= railWidth + 3 && getComputedStyle(project).display === 'none'
                  && search.width >= 28 && search.left >= sidebar.left && search.right <= sidebar.right }
            } while (!state.ready && performance.now() < deadline)
            return state
          })()`

/** 浏览器端验收探测脚本（sessions #14）。 */
export const SESSIONS_SCRIPT_14 = `(async () => {
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

/** 浏览器端验收探测脚本（sessions #15）。 */
export const SESSIONS_SCRIPT_15 = `(async () => {
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

/** 浏览器端验收探测脚本（sessions #16）。 */
export const SESSIONS_SCRIPT_16 = `(async () => {
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

/** 浏览器端验收探测脚本（sessions #17）。 */
export const SESSIONS_SCRIPT_17 = `(async () => {
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

const SESSIONS_PARTS_18 = [
  "(async () => {\n          for (let attempt = 0; attempt < 80; attempt += 1) {\n            const active = document.querySelector('.session-tab[aria-selected=\"true\"]')\n            const chrome = document.querySelector('.session-chrome')\n            const shell = document.querySelector('.app-shell')\n            const main = document.querySelector('.main-island')\n            const floating = document.querySelector('[data-floating-tab-actions=\"true\"]')\n            const overviewButtons = document.querySelectorAll('[aria-label=\"平铺选择标签\"]')\n            const newTabButtons = document.querySelectorAll('[aria-label=\"新建工作标签\"]')\n            const tools = main?.querySelector('.conversation-tools')\n            const blur = main?.querySelector('[data-top-progressive-blur=\"true\"]')\n            const windowEdge = Number.parseFloat(getComputedStyle(shell).getPropertyValue('--window-edge'))\n            const floatingRect = floating instanceof HTMLElement ? floating.getBoundingClientRect() : null\n            const toolsRect = tools instanceof HTMLElement ? tools.getBoundingClientRect() : null\n            const ready = active?.getAttribute('data-session-tab') === ",
  '\n              && document.querySelector(',
  ") === null\n              && document.querySelectorAll('.session-tab').length === 1\n              && shell?.dataset.sessionTabsVisible === 'false'\n              && chrome instanceof HTMLElement && chrome.getAttribute('aria-hidden') === 'true' && chrome.inert\n              && getComputedStyle(chrome).visibility === 'hidden'\n              && document.querySelectorAll('.session-search-trigger').length === 1\n              && document.querySelector('.project-focus .session-search-trigger') instanceof HTMLButtonElement\n              && Math.abs(main.getBoundingClientRect().top - windowEdge) <= 1\n              && floating instanceof HTMLElement && floating.checkVisibility()\n              && overviewButtons.length === 1 && newTabButtons.length === 1\n              && floating.contains(overviewButtons[0]) && floating.contains(newTabButtons[0])\n              && (toolsRect === null || (floatingRect !== null\n                && toolsRect.top >= floatingRect.bottom\n                && Math.abs(toolsRect.right - (floatingRect.right - 4)) <= 1))\n              && blur instanceof HTMLElement && getComputedStyle(blur).pointerEvents === 'none'\n              && (document.activeElement === newTabButtons[0]\n                || document.activeElement === document.querySelector('.session-search-trigger'))\n              && document.querySelector('.main-island .composer-card') !== null\n            if (ready) return true\n            await new Promise(resolve => setTimeout(resolve, 25))\n          }\n          return false\n        })()",
] as const

/** 构造带参数的浏览器端验收探测脚本（sessions #18）。 */
export function buildSessionsScript18(p0: unknown, p1: unknown): string {
  return (
    SESSIONS_PARTS_18[0]! + String(p0) + SESSIONS_PARTS_18[1]! + String(p1) + SESSIONS_PARTS_18[2]!
  )
}
