/**
 * 设置中心全分页、归档恢复、无障碍降级、透明合成与多尺寸响应式验收套件：在渲染进程上下文执行的页面探测脚本集合（分片 2）。
 */

/** 浏览器端验收探测脚本（settings #24）。 */
export const SETTINGS_SCRIPT_24 = `(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const island = document.querySelector('.sidebar-island')
        const mainIsland = document.querySelector('.main-island')
        const content = document.querySelector('.workspace-view')
        const background = document.querySelector('.background-layer')
        const search = document.querySelector('.session-search-trigger')
        const tabs = document.querySelector('.mode-rail .view-tabs')
        const canvasAlpha = document.documentElement.style.getPropertyValue('--canvas-alpha').trim()
        if (island instanceof HTMLElement
          && mainIsland instanceof HTMLElement
          && content instanceof HTMLElement
          && background instanceof HTMLElement
          && search instanceof HTMLElement
          && tabs instanceof HTMLElement
          && Math.abs(Number(canvasAlpha) - 0.68) <= 0.001) {
          const islandStyle = getComputedStyle(island)
          const backgroundStyle = getComputedStyle(background)
          const rail = tabs.closest('.mode-rail')
          const railStyle = getComputedStyle(rail)
          const sidebarRect = island.getBoundingClientRect()
          const mainRect = mainIsland.getBoundingClientRect()
          const transparent = value => value === 'rgba(0, 0, 0, 0)' || value === 'transparent'
          return {
            backdrop: islandStyle.backdropFilter,
            opaquePoints: [...document.querySelectorAll('.app-shell > .island:not([hidden])')].map(element => {
              const rect = element.getBoundingClientRect()
              return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
            }),
            // 采样左侧与主浮岛核心缝隙（避开垂直中点缩放胶囊），对比窗口四边避开圆角与阴影的外缘点。
            centerGapPoint: mainRect.left > sidebarRect.right + 1
              ? { x: (sidebarRect.right + mainRect.left) / 2, y: mainRect.top + mainRect.height * 0.35 }
              : null,
            edgePoints: [
              { x: 24, y: 3 },
              { x: 3, y: 24 },
              { x: 3, y: innerHeight - 24 },
              { x: 3, y: innerHeight / 2 },
            ],
            viewport: { width: innerWidth, height: innerHeight },
            scrimAlpha: document.documentElement.style.getPropertyValue('--scrim-alpha').trim(),
            canvasAlpha,
            canvasOpacity: backgroundStyle.opacity,
            canvasBackgroundImage: backgroundStyle.backgroundImage,
            canvasImage: document.documentElement.style.getPropertyValue('--canvas-image').trim(),
            contentBackground: getComputedStyle(content).backgroundImage,
            topControlsReadable: rail.contains(tabs)
              && !transparent(railStyle.backgroundColor)
              && railStyle.backdropFilter === 'none'
              && railStyle.opacity === '1',
          }
        }
        await sleep(25)
      }
      return null
    })()`

/** 浏览器端验收探测脚本（settings #25）。 */
export const SETTINGS_SCRIPT_25 = `(async () => {
      let latest = null
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const background = document.querySelector('.background-layer')
        const shell = document.querySelector('.app-shell')
        const root = document.querySelector('#root')
        const islands = [...document.querySelectorAll('.app-shell > .island:not([hidden])')]
        if (background instanceof HTMLElement
          && shell instanceof HTMLElement
          && root instanceof HTMLElement
          && islands.length === 3) {
          const backgroundRect = background.getBoundingClientRect()
          const backgroundStyle = getComputedStyle(background)
          const transparent = value => value === 'rgba(0, 0, 0, 0)' || value === 'transparent'
          latest = {
            canvasAlpha: document.documentElement.style.getPropertyValue('--canvas-alpha').trim(),
            canvasOpacity: backgroundStyle.opacity,
            canvasBackgroundImage: backgroundStyle.backgroundImage,
            shellOpacity: getComputedStyle(shell).opacity,
            islandsKeepOwnOpacity: islands.every(island => getComputedStyle(island).opacity === '1'),
            transparentRoots: [document.documentElement, document.body, root]
              .every(element => transparent(getComputedStyle(element).backgroundColor)),
            canvasCoversWindow: Math.abs(backgroundRect.left) <= 1
              && Math.abs(backgroundRect.top) <= 1
              && Math.abs(backgroundRect.right - innerWidth) <= 1
              && Math.abs(backgroundRect.bottom - innerHeight) <= 1,
          }
          if (Math.abs(Number(latest.canvasAlpha) - 0.68) <= 0.001
            && latest.canvasOpacity === '1'
            && latest.canvasBackgroundImage.includes('radial-gradient')
            && latest.canvasCoversWindow) return latest
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return latest
    })()`

/** 浏览器端验收探测脚本（settings #26）。 */
export const SETTINGS_SCRIPT_26 = `(async () => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const shell = document.querySelector('.app-shell')
        const topIslands = [...document.querySelectorAll('.app-shell > .island:not([hidden])')]
        const dragRegion = document.querySelector('.window-drag-region')
        const toolbar = document.querySelector('.mode-rail')
        const searchTrigger = document.querySelector('.session-search-trigger')
        const shellStyle = shell instanceof HTMLElement ? getComputedStyle(shell) : null
        const expectedTop = Number.parseFloat(shellStyle?.getPropertyValue('--window-edge') ?? '')
          + (shell?.getAttribute('data-session-tabs-visible') === 'true'
            ? Number.parseFloat(shellStyle?.getPropertyValue('--session-chrome-height') ?? '')
              + Number.parseFloat(shellStyle?.getPropertyValue('--window-gap') ?? '') : 0)
        if (shell instanceof HTMLElement
          && Math.abs(shell.getBoundingClientRect().width - innerWidth) <= 1
          && document.querySelectorAll('.app-shell > .island:not([hidden])').length === 3
          && topIslands.every(island => Math.abs(island.getBoundingClientRect().top
            - (island.classList.contains('sidebar-island') ? Number.parseFloat(shellStyle.getPropertyValue('--window-edge')) : expectedTop)) <= 1)
          && dragRegion instanceof HTMLElement
          && Math.abs(dragRegion.getBoundingClientRect().bottom - innerHeight) <= 1
          && toolbar instanceof HTMLElement
          && Math.abs(toolbar.getBoundingClientRect().left - Number.parseFloat(shellStyle.getPropertyValue('--window-edge'))) <= 1
          && Math.abs(toolbar.getBoundingClientRect().width - Number.parseFloat(shellStyle.getPropertyValue('--mode-rail-width'))) <= 1
          && toolbar.scrollWidth <= toolbar.clientWidth + 1
          && searchTrigger instanceof HTMLElement
          && searchTrigger.getBoundingClientRect().left >= document.querySelector('.project-selector').getBoundingClientRect().right
          && searchTrigger.textContent.trim() === '') return true
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return false
    })()`

/** 浏览器端验收探测脚本（settings #27）。 */
export const SETTINGS_SCRIPT_27 = `(async () => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const shell = document.querySelector('.app-shell')
        const main = document.querySelector('.main-island')
        const information = document.querySelector('.info-island')
        const divider = document.querySelector('.panel-divider--information')
        if (shell instanceof HTMLElement
          && main instanceof HTMLElement
          && information instanceof HTMLElement
          && divider instanceof HTMLElement) {
          const shellStyle = getComputedStyle(shell)
          const expandedWidth = Number.parseFloat(shellStyle.getPropertyValue('--information-expanded-width'))
          const windowGap = Number.parseFloat(shellStyle.getPropertyValue('--window-gap'))
          const mainRect = main.getBoundingClientRect()
          const informationRect = information.getBoundingClientRect()
          if (Math.abs(expandedWidth - 480) <= 1
            && informationRect.width > 420
            && Math.abs(informationRect.width - expandedWidth) <= 1
            && mainRect.width + windowGap >= 420
            && divider.getAttribute('aria-valuemax') === null
            && document.documentElement.scrollWidth === innerWidth) return true
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return false
    })()`

/** 浏览器端验收探测脚本（settings #28）。 */
export const SETTINGS_SCRIPT_28 = `(async () => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const shell = document.querySelector('.app-shell')
        const information = document.querySelector('.info-island')
        const main = document.querySelector('.main-island')
        const informationDivider = document.querySelector('.panel-divider--information')
        const searchTrigger = document.querySelector('.session-search-trigger')
        const viewTabs = document.querySelector('.view-tabs')
        if (shell instanceof HTMLElement
          && information instanceof HTMLElement
          && main instanceof HTMLElement
          && informationDivider instanceof HTMLElement
          && searchTrigger instanceof HTMLElement
          && viewTabs instanceof HTMLElement) {
          const shellStyle = getComputedStyle(shell)
          const expandedWidth = Number.parseFloat(shellStyle.getPropertyValue('--information-expanded-width'))
          const rail = document.querySelector('.mode-rail').getBoundingClientRect()
          const searchRect = searchTrigger.getBoundingClientRect()
          const tabsRect = viewTabs.getBoundingClientRect()
          if (Math.abs(expandedWidth - 480) <= 1
            && Math.abs(rail.width - Number.parseFloat(shellStyle.getPropertyValue('--mode-rail-width'))) <= 1
            && information.getClientRects().length === 0 && information.inert
            && getComputedStyle(main).paddingRight === '0px'
            && Math.abs(main.getBoundingClientRect().right - innerWidth + Number.parseFloat(shellStyle.getPropertyValue('--window-edge'))) <= 1
            && getComputedStyle(informationDivider).display === 'none'
            && Math.abs(searchRect.width - 28) <= 1
            && searchTrigger.textContent.trim() === ''
            && searchRect.left >= document.querySelector('.project-selector').getBoundingClientRect().right
            && tabsRect.left > rail.left && tabsRect.right < rail.right
            && searchRect.bottom < tabsRect.top
            && document.documentElement.scrollWidth === innerWidth) return true
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return false
    })()`

/** 浏览器端验收探测脚本（settings #29）。 */
export const SETTINGS_SCRIPT_29 = `(async () => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const shell = document.querySelector('.app-shell')
        const information = document.querySelector('.info-island')
        const viewTabs = document.querySelector('.view-tabs')
        if (shell instanceof HTMLElement
          && information instanceof HTMLElement
          && viewTabs instanceof HTMLElement) {
          const expandedWidth = Number.parseFloat(getComputedStyle(shell)
            .getPropertyValue('--information-expanded-width'))
          const tabsRect = viewTabs.getBoundingClientRect()
          if (Math.abs(expandedWidth - 260) <= 1
            && information.checkVisibility() && !information.inert
            && Math.abs(information.getBoundingClientRect().width - expandedWidth) <= 1
            && tabsRect.left >= 10 && tabsRect.right <= 86
            && tabsRect.width < expandedWidth) return true
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return false
    })()`

/** 浏览器端验收探测脚本（settings #30）。 */
export const SETTINGS_SCRIPT_30 = `(async () => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const shell = document.querySelector('.app-shell')
        const information = document.querySelector('.info-island')
        const main = document.querySelector('.main-island')
        if (shell instanceof HTMLElement
          && information instanceof HTMLElement
          && main instanceof HTMLElement) {
          const style = getComputedStyle(shell)
          const edge = Number.parseFloat(style.getPropertyValue('--window-edge'))
          const expectedTop = edge + (shell.dataset.sessionTabsVisible === 'true'
            ? Number.parseFloat(style.getPropertyValue('--session-chrome-height'))
              + Number.parseFloat(style.getPropertyValue('--window-gap')) : 0)
          const mainRect = main.getBoundingClientRect()
          const conversationRect = main.querySelector('.workspace-view:not([hidden])')?.getBoundingClientRect()
          const composerRect = document.querySelector('.composer-card')?.getBoundingClientRect()
          const footer = document.querySelector('.composer-card footer')
          const buttons = footer === null ? [] : [...footer.querySelectorAll('button')]
            .filter(button => button.checkVisibility()).map(button => button.getBoundingClientRect())
          const footerRect = footer?.getBoundingClientRect()
          const composerControlsFit = footerRect !== undefined && buttons.length >= 4
            && buttons.every((button, index) => button.width >= 24
              && button.left >= footerRect.left && button.right <= footerRect.right
              && (index === 0 || button.left >= buttons[index - 1].right))
          if (information.inert && information.hidden && information.getClientRects().length === 0
            && document.querySelector('[data-composer-readings]') !== null
            && getComputedStyle(main).paddingRight === '0px'
            && Math.abs(mainRect.top - expectedTop) <= 1
            && Math.abs(mainRect.right - (innerWidth - edge)) <= 1
            && conversationRect !== undefined && Math.abs(conversationRect.right - mainRect.right) <= 2
            && composerRect !== undefined && composerRect.width >= mainRect.width - 96
            && composerRect.left >= mainRect.left + 16 && composerRect.right <= mainRect.right - 16
            && composerControlsFit
            && document.querySelector('.info-capsule, .info-compact-backdrop') === null) return true
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return false
    })()`

/** 浏览器端验收探测脚本（settings #31）。 */
export const SETTINGS_SCRIPT_31 = `(async () => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const panel = document.querySelector('[role="dialog"][aria-label="命令与 Skill"]')
        const list = panel?.querySelector('[role="listbox"]')
        if (panel instanceof HTMLElement && list instanceof HTMLElement) {
          const bounds = panel.getBoundingClientRect()
          if (bounds.top >= 12 && bounds.left >= 12 && bounds.right <= innerWidth - 12
            && bounds.height <= 361 && panel.querySelector('input') === document.activeElement
            && getComputedStyle(list).overflowY === 'auto' && list.clientHeight > 0) return true
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return false
    })()`

/** 浏览器端验收探测脚本（settings #32）。 */
export const SETTINGS_SCRIPT_32 = `(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const inMotion = node =>
        typeof node.className === 'string'
        && /(?:^|\\s)ant-[^\\s]+-(?:appear|enter|leave)(?:-(?:prepare|start|active))?(?:\\s|$)/.test(node.className)
      const waitFor = async (predicate, attempts = 80) => {
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          const value = predicate()
          if (value) return value
          await sleep(25)
        }
        return null
      }
      const shell = document.querySelector('.app-shell')
      const navigation = document.querySelector('.navigation-island')
      const main = document.querySelector('.main-island')
      const dragRegion = document.querySelector('.window-drag-region')
      const information = document.querySelector('.info-island')
      const informationDivider = document.querySelector('.panel-divider--information')
      const searchTrigger = document.querySelector('.session-search-trigger')
      const shellStyle = shell instanceof HTMLElement ? getComputedStyle(shell) : null
      const expectedTop = Number.parseFloat(shellStyle?.getPropertyValue('--window-edge') ?? '')
        + (shell?.getAttribute('data-session-tabs-visible') === 'true'
          ? Number.parseFloat(shellStyle?.getPropertyValue('--session-chrome-height') ?? '')
            + Number.parseFloat(shellStyle?.getPropertyValue('--window-gap') ?? '') : 0)
      const shellFits = shell instanceof HTMLElement
        && document.documentElement.scrollWidth === innerWidth
        && document.documentElement.scrollHeight === innerHeight
        && navigation instanceof HTMLElement
        && main instanceof HTMLElement
        && Math.abs(document.querySelector('.sidebar-island').getBoundingClientRect().top - Number.parseFloat(shellStyle.getPropertyValue('--window-edge'))) <= 1
        && Math.abs(main.getBoundingClientRect().top - expectedTop) <= 1
        && dragRegion instanceof HTMLElement
        && Math.abs(dragRegion.getBoundingClientRect().bottom - innerHeight) <= 1
        && information instanceof HTMLElement
        && information.getClientRects().length === 0 && information.inert
        && informationDivider instanceof HTMLElement
        && getComputedStyle(informationDivider).display === 'none'
        && searchTrigger instanceof HTMLElement
        && Math.abs(searchTrigger.getBoundingClientRect().width - 28) <= 1
        && searchTrigger.getBoundingClientRect().left >= document.querySelector('.project-selector').getBoundingClientRect().right
        && searchTrigger.textContent.trim() === ''
      if (!shellFits) return false
      const trigger = document.querySelector('#open-settings')
      if (!(trigger instanceof HTMLButtonElement)) return false
      trigger.click()
      const settingsDialog = await waitFor(() => {
        const dialog = document.querySelector('.settings-dialog[role="dialog"]')
        const content = dialog?.querySelector('.settings-content')
        if (!(dialog instanceof HTMLElement) || !dialog.checkVisibility() || inMotion(dialog) || !(content instanceof HTMLElement)) return null
        const running = dialog.getAnimations({ subtree: true })
          .some(animation => animation.playState !== 'finished' && animation.effect?.getComputedTiming().iterations !== Infinity)
        return running ? null : dialog
      }, 100)
      if (!(settingsDialog instanceof HTMLElement)) return false
      const settingsContent = settingsDialog.querySelector('.settings-content')
      if (!(settingsContent instanceof HTMLElement)) return false
      let fontFamily = settingsDialog.querySelector('[role="combobox"][aria-label="界面字体"]')
      if (!(fontFamily instanceof HTMLInputElement)) {
        const appearance = [...settingsDialog.querySelectorAll('.settings-nav__items > [role="menuitem"]')]
          .find(button => button.textContent?.trim() === '外观')
        if (appearance instanceof HTMLElement) appearance.click()
        fontFamily = await waitFor(() => {
          const candidate = settingsDialog.querySelector('[role="combobox"][aria-label="界面字体"]')
          return candidate instanceof HTMLInputElement ? candidate : null
        })
      }
      if (!(fontFamily instanceof HTMLInputElement)) return false
      await Promise.allSettled(settingsDialog.getAnimations({ subtree: true })
        .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map(animation => animation.finished))
      fontFamily.focus()
      fontFamily.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      const popup = await waitFor(() => {
        const listbox = document.getElementById(fontFamily.getAttribute('aria-controls') ?? '')
        const candidate = listbox?.closest('.ant-select-dropdown')
        if (!(candidate instanceof HTMLElement) || !candidate.checkVisibility() || inMotion(candidate)) return null
        const running = candidate.getAnimations({ subtree: true })
          .some(animation => animation.playState !== 'finished' && animation.effect?.getComputedTiming().iterations !== Infinity)
        return running ? null : candidate
      }, 100)
      if (!(popup instanceof HTMLElement)) return false
      const listbox = document.getElementById(fontFamily.getAttribute('aria-controls') ?? '')
      const popupRect = popup.getBoundingClientRect()
      const triggerRect = fontFamily.closest('.settings-select').getBoundingClientRect()
      const rect = settingsDialog.getBoundingClientRect()
      const listboxRect = listbox instanceof HTMLElement ? listbox.getBoundingClientRect() : null
      const customSelectFits = listboxRect !== null
        && Math.abs(popupRect.width - triggerRect.width) <= 2
        && Math.abs(popupRect.left - triggerRect.left) <= 2
        && popupRect.top >= triggerRect.bottom
        && popupRect.top - triggerRect.bottom <= 8
        && listboxRect.left >= rect.left && listboxRect.top >= rect.top
        && listboxRect.right <= rect.right && listboxRect.bottom <= rect.bottom
        && settingsDialog.querySelector('select') === null
      return rect.left >= 0 && rect.top >= 0
        && rect.right <= innerWidth && rect.bottom <= innerHeight
        && settingsContent.scrollWidth <= settingsContent.clientWidth + 1
        && document.documentElement.scrollWidth === innerWidth
        && customSelectFits
    })()`

/** 浏览器端验收探测脚本（settings #33）。 */
export const SETTINGS_SCRIPT_33 = `(async () => {
      const shell = document.querySelector('.app-shell')
      const root = document.getElementById('root')
      if (!(shell instanceof HTMLElement) || !(root instanceof HTMLElement)) return false
      const before = shell.getBoundingClientRect()
      const probe = document.createElement('div')
      probe.dataset.verifyOverflowProbe = 'true'
      probe.style.cssText = 'position:absolute;left:0;top:820px;width:8px;height:8px'
      root.appendChild(probe)
      document.documentElement.scrollTop = 24
      document.body.scrollTop = 24
      root.scrollTop = 24
      const scrolled = shell.getBoundingClientRect()
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const restored = document.documentElement.scrollTop === 0 && document.body.scrollTop === 0 && root.scrollTop === 0
      probe.remove()
      return Math.abs(before.top) <= 1 && Math.abs(before.bottom - innerHeight) <= 1
        && Math.abs(scrolled.top - before.top) <= 1 && Math.abs(scrolled.bottom - before.bottom) <= 1
        && restored
    })()`

/** 浏览器端验收探测脚本（settings #34）。 */
export const SETTINGS_SCRIPT_34 = `(async () => {
      const wait = async predicate => {
        for (let attempt = 0; attempt < 80; attempt += 1) {
          if (predicate()) return true
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        return false
      }
      const selected = () => document.querySelector('.info-island [role="tab"][aria-selected="true"]')
      if (selected()?.dataset.islandId !== 'file-outline-tasks') return false
      if (document.querySelector('.right-island-tabs [data-tab-id="conversation"]')) return false
      const buttons = [...document.querySelectorAll('.right-island-tabs [role="tab"]:not([data-overflow])')]
      const allTabs = [...document.querySelectorAll('.right-island-tabs [role="tab"]')]
      const hiddenTabs = allTabs.filter(button => button.hasAttribute('data-overflow'))
      if (allTabs.length !== 2 || buttons.length === 0 || buttons.length + hiddenTabs.length !== allTabs.length
        || !['file-outline-tasks', 'git-history'].every(id => allTabs.some(button => button.dataset.tabId === id))
        || (hiddenTabs.length > 0 && !document.querySelector('.right-island-more'))
        || buttons.some(button => button.textContent.trim() !== ''
        || !button.getAttribute('aria-label') || !button.querySelector('svg'))
        || getComputedStyle(document.querySelector('.right-island-tabs')).overflowX !== 'clip') return false
      const nextTabId = allTabs[(allTabs.findIndex(button => button.dataset.tabId === 'file-outline-tasks') + 1) % allTabs.length].dataset.tabId
      selected().focus()
      selected().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      if (!await wait(() => selected()?.dataset.islandId === nextTabId)) return false
      if (!document.querySelector('[data-island-id="file-outline-tasks"]')) document.querySelector('[aria-label="更多右侧栏目"][aria-haspopup="menu"]')?.click()
      if (!await wait(() => document.querySelector('[data-island-id="file-outline-tasks"]'))) return false
      document.querySelector('[data-island-id="file-outline-tasks"]').click()
      if (!await wait(() => selected()?.dataset.islandId === 'file-outline-tasks')) return false
      // 普通右栏切走会卸载；重新选中后，收放侧栏应保留当前内容节点。
      const content = document.querySelector('.info-island .workspace-island-content')
      const strip = document.querySelector('.info-island .right-island-tabs').getBoundingClientRect()
      const tab = selected().getBoundingClientRect()
      if (tab.left < strip.left - 1 || tab.right > strip.right + 1) return false
      document.querySelector('[aria-label="收起右侧栏目"]').click()
      if (!await wait(() => document.querySelector('.app-shell').dataset.informationCollapsed === 'true')) return false
      document.querySelector('[aria-label="展开右侧浮岛"]').click()
      if (!await wait(() => document.querySelector('.app-shell').dataset.informationCollapsed !== 'true')) return false
      return document.querySelector('.info-island .workspace-island-content') === content
        && document.querySelector('.right-island-rail') === null
    })()`
