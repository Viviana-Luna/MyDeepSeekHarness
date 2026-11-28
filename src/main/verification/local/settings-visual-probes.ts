/**
 * 浮岛固定间隙、无障碍降级、透明画布材质合成与多尺寸响应式布局的渲染进程探测脚本。
 */

/** 验证旧版浮岛间隙字段下界面始终保持官方 8px 间距与同心内圆角。 */
export const FIXED_ISLAND_GAP_GEOMETRY_PROBE = `(async () => {
  await Promise.allSettled(document.querySelector('.app-shell').getAnimations({ subtree: true })
    .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished))
  const navigation = document.querySelector('.sidebar-island')
  const main = document.querySelector('.main-island')
  const information = document.querySelector('.info-island')
  const composer = document.querySelector('.composer-card')
  const navigationDivider = document.querySelector('.panel-divider--navigation')
  const informationDivider = document.querySelector('.panel-divider--information')
  const gap = Number.parseFloat(document.documentElement.style.getPropertyValue('--window-gap'))
  if (!(navigation instanceof HTMLElement)
    || !(main instanceof HTMLElement)
    || !(information instanceof HTMLElement)
    || !(composer instanceof HTMLElement)
    || !(navigationDivider instanceof HTMLElement)
    || !(informationDivider instanceof HTMLElement)) return false
  const navigationRect = navigation.getBoundingClientRect()
  const mainRect = main.getBoundingClientRect()
  const informationRect = information.getBoundingClientRect()
  const composerRect = composer.getBoundingClientRect()
  const outerRadius = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--window-outer-radius'))
  const expectedRadius = Math.max(0, outerRadius - 8)
  const alignedCorners = [navigation, main, information].every(island =>
    Math.abs(Number.parseFloat(getComputedStyle(island).borderBottomLeftRadius) - expectedRadius) <= 0.1)
  return gap === 8
    && alignedCorners
    && Math.abs(navigationRect.left - 8) <= 1
    && Math.abs(mainRect.left - navigationRect.right - 8) <= 1
    && Math.abs(informationRect.left - mainRect.right - 8) <= 1
    && composerRect.top > mainRect.top
    && composerRect.left >= mainRect.left + 17
    && Math.abs(composerRect.left + composerRect.right - mainRect.left - mainRect.right) <= 1
    && Math.abs(informationRect.right - (innerWidth - 8)) <= 1
    && Math.abs(navigationRect.bottom - (innerHeight - 8)) <= 1
    && Math.abs(informationRect.bottom - (innerHeight - 8)) <= 1
    && Math.abs((document.querySelector('[data-composer-readings]')?.getBoundingClientRect().bottom ?? composerRect.bottom)
      - (mainRect.bottom - 1 - Number.parseFloat(getComputedStyle(document.querySelector('.app-shell')).getPropertyValue('--composer-bottom-inset')))) <= 1
    && Math.abs(navigationDivider.getBoundingClientRect().width - 8) <= 1
    && Math.abs(informationDivider.getBoundingClientRect().width - 8) <= 1
})()`

/** 验证 `prefers-reduced-transparency: reduce` 下画布降级为纯实色且无模糊滤镜。 */
export const REDUCED_TRANSPARENCY_PROBE = `(async () => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const canvas = document.querySelector('.background-layer')
    const islands = [...document.querySelectorAll('.app-shell > .island:not([hidden])')]
    const canvasStyle = canvas instanceof HTMLElement ? getComputedStyle(canvas) : null
    if (matchMedia('(prefers-reduced-transparency: reduce)').matches
      && canvasStyle !== null
      && canvasStyle.opacity === '1'
      && canvasStyle.backgroundImage === 'none'
      && canvasStyle.backgroundColor !== 'rgba(0, 0, 0, 0)'
      && canvasStyle.backgroundColor !== 'transparent'
      && islands.every(island => getComputedStyle(island).backdropFilter === 'none')) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return false
})()`

/** 验证 `forced-colors: active` 下所有浮岛与卡片均呈现 1 物理像素实线描边。 */
export const FORCED_COLORS_BORDERS_PROBE = `(async () => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const controls = [...document.querySelectorAll('.app-shell > .island:not([hidden]), .mode-rail, .composer-card')]
    if (matchMedia('(forced-colors: active)').matches
      && controls.length === 5
      && controls.every(control => getComputedStyle(control).borderTopStyle === 'solid'
        && Math.abs(Number.parseFloat(getComputedStyle(control).borderTopWidth) * devicePixelRatio - Math.max(1, Math.floor(devicePixelRatio))) < .1)) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return false
})()`

/** 验证深色主题下设置选择框为深底亮字、可读性达标。 */
export const DARK_SETTINGS_CONTRAST_PROBE = `(async () => {
  const dialog = document.querySelector('.settings-dialog[role="dialog"]')
  await Promise.allSettled(
    dialog
      .getAnimations({ subtree: true })
      .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map(animation => animation.finished),
  )
  const select = dialog.querySelector('.settings-select')
  if (!(select instanceof HTMLElement)) return false
  const style = getComputedStyle(select)
  const channels = color => (color.match(/[0-9.]+/g) ?? []).slice(0, 3).map(Number)
  return channels(style.backgroundColor).every(channel => channel < 100)
    && channels(style.color).every(channel => channel > 150)
})()`

/** 验证画布配色始终跟随界面浅色主题，不受已下线的独立画布配色字段影响。 */
export const CANVAS_FOLLOW_INTERFACE_PROBE = `(async () => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const root = document.documentElement
    const canvas = document.querySelector('.background-layer')
    const canvasStyle = canvas instanceof HTMLElement ? getComputedStyle(canvas) : null
    if (matchMedia('(prefers-color-scheme: light)').matches
      && root.dataset.canvasColorScheme === 'follow-interface'
      && root.style.getPropertyValue('--canvas-layer-bg').trim() === 'var(--canvas-bg)'
      && canvasStyle !== null
      && canvasStyle.backgroundImage.includes('radial-gradient')
      && !canvasStyle.backgroundImage.includes('rgb(16, 17, 19)')
      && canvasStyle.backgroundColor !== 'rgb(16, 17, 19)') return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return false
})()`

/** 采样中心实色、边缘通透的径向画布渐变与三浮岛实色采样坐标。 */
export const MEDIUM_CANVAS_MATERIAL_PROBE = `(async () => {
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

/** 采样旧字段设为全透明时根节点透明合成与浮岛独立不透明状态。 */
export const CLEAR_CANVAS_TRANSPARENCY_PROBE = `(async () => {
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

/** 验证 1440×900 放大窗口下三浮岛顶边与模式轨几何稳定。 */
export const LARGE_WINDOW_LAYOUT_PROBE = `(async () => {
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

/** 验证右侧信息栏在宽屏下拉宽至 480px 时主浮岛仍保持最小安全宽度。 */
export const WIDE_INFORMATION_PANEL_RESIZE_PROBE = `(async () => {
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

/** 验证 1200×760 中等窗口在右栏过宽时自动隐藏右栏并维持工具栏稳定。 */
export const MEDIUM_COMPACT_TOOLBAR_PROBE = `(async () => {
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

/** 验证按 Home 复位右栏宽度至 260px 默认值。 */
export const RESET_INFORMATION_PANEL_WIDTH_PROBE = `(async () => {
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

/** 验证 900×600 窄窗口隐藏右侧信息栏且主输入区按钮不重叠。 */
export const NARROW_RIGHT_PANEL_HIDDEN_PROBE = `(async () => {
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

/** 验证窄窗口下命令与 Skill 候选浮层完整落在视口安全边距内。 */
export const NARROW_SKILL_PICKER_BOUNDS_PROBE = `(async () => {
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

/** 验证 900×600 窄窗口打开设置弹窗及字体下拉列表时不超出窗口边界。 */
export const NARROW_SETTINGS_DIALOG_FITS_PROBE = `(async () => {
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

/** 验证绝对定位越界元素不会带动工作台外壳发生根级滚动偏移。 */
export const SHELL_PINNED_TO_VIEWPORT_PROBE = `(async () => {
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

/** 验证右侧信息栏顶部标签键盘方向键导航与折叠恢复时的实例保留。 */
export const RIGHT_ISLAND_KEYBOARD_TABS_PROBE = `(async () => {
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
