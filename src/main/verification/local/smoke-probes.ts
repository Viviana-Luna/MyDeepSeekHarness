/**
 * 基础壳层、导航安全与前端扩展生命周期验收的渲染进程探测脚本。
 *
 * 所有探测脚本在受信任本地 renderer 上下文中执行，用于采样 DOM 布局几何与插件插槽状态。
 */

/** 用于真实前端扩展加载与卸载验收的插件入口源码。 */
export const FRONTEND_PLUGIN_ENTRY_SOURCE = `globalThis.__MYDSH_PLUGINS__.define('verification.extension', (require, module) => {
  const React = require('react'), sdk = require('@mydsh/ui');
  module.exports = { name: 'verification.extension', inject: ['mydshSlots'], apply(ctx) {
    function Probe() {
      const [result, setResult] = React.useState('loading');
      React.useEffect(() => { let active = true; sdk.callRemote('session/list', { _request: {} })
        .then(value => { if (active) setResult(Array.isArray(value.items) ? 'ready' : 'invalid') },
          () => { if (active) setResult('error') }); return () => { active = false }; }, []);
      return React.createElement('span', { 'data-plugin-probe': result }, '扩展验收');
    }
    function ProbeIcon() { return React.createElement('span', { 'aria-hidden': true }, '扩'); }
    function ProbeIsland({ placement, visibility }) {
      return React.createElement('section', {
        'data-plugin-island': placement + ':' + visibility,
      }, '动态浮岛验收');
    }
    ctx.mydshSlots.registerAction('workspace.toolbar', 'probe', Probe);
    ctx.mydshSlots.registerIsland({ id: 'verification.island', label: '动态验收', icon: ProbeIcon,
      component: ProbeIsland, placements: ['right'], scope: 'window', preserveWhenHidden: true, order: 100 });
  }};
});`

/** 构造前端扩展安装、切换浮岛、禁用、重新启用与卸载全生命周期探测脚本。 */
export function buildPluginLifecycleProbe(extensionSourcePath: string): string {
  return `(async () => {
    await window.dshDesktop.host.call('mydshPlugins.install', { path: ${JSON.stringify(extensionSourcePath)} });
    const wait = async check => {
      for (let i = 0; i < 200; i++) {
        if (check()) return true;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return false;
    };
    const fail = stage => ({
      ok: false,
      stage,
      viewport: { width: innerWidth, height: innerHeight },
      compact: window.matchMedia('(max-width: 1268px)').matches,
      probe: document.querySelector('[data-plugin-probe]')?.getAttribute('data-plugin-probe') ?? null,
      island: document.querySelector('[data-plugin-island]')?.getAttribute('data-plugin-island') ?? null,
      inspector: document.querySelector('#session-inspector') !== null,
    });
    const loaded = () => document.querySelector('[data-plugin-probe="ready"]') !== null
      && document.querySelector('[data-plugin-island]') !== null;
    const absent = () => document.querySelector('[data-plugin-probe]') === null
      && document.querySelector('[data-plugin-island]') === null;
    if (!await wait(loaded)) return fail('loaded');
    if (document.querySelector('.right-island-tabs [data-tab-id="conversation"]')) return fail('unexpected-conversation-tab');
    // 右侧栏目减少后扩展可能直接可见；按实际呈现入口验收，不假设一定溢出。
    const directTab = document.querySelector('.right-island-tabs [data-island-id="verification.island"]');
    if (directTab) directTab.click();
    else {
      const overflowTrigger = document.querySelector('[aria-label="更多右侧栏目"][aria-haspopup="menu"]');
      if (!overflowTrigger) return fail('missing-overflow-trigger');
      overflowTrigger.click();
      if (!await wait(() => document.querySelector('.right-island-overflow-menu button[data-island-id="verification.island"]') !== null)) return fail('missing-overflow-item');
      document.querySelector('.right-island-overflow-menu button[data-island-id="verification.island"]')?.click();
    }
    if (!await wait(() => document.querySelector('[data-plugin-island="right:foreground"]') !== null)) return fail('foreground');
    await window.dshDesktop.host.call('mydshPlugins.disable', { id: 'verification.extension' });
    if (!await wait(absent) || document.querySelector('#session-inspector') === null) return fail('disable');
    await window.dshDesktop.host.call('mydshPlugins.enable', { id: 'verification.extension' });
    if (!await wait(() => loaded() && document.querySelector('[data-plugin-island="right:foreground"]') !== null)) return fail('reenable');
    await window.dshDesktop.host.call('mydshPlugins.uninstall', { id: 'verification.extension' });
    if (!await wait(absent) || document.querySelector('#session-inspector') === null) return fail('uninstall');
    return { ok: true };
  })()`
}

const INITIAL_CONTROLS_AND_TRAJECTORY_SNIPPET = `
      let composer = document.querySelector('#composer')
      // 对话与轨迹切换位于聊天浮岛内；左侧模式栏同样有 data-view="conversation"，必须限定范围。
      const trajectory = document.querySelector('.conversation-view-tabs [data-view="trajectory"]')
      const projectSelector = document.querySelector('button[aria-label="专注项目"]')
      if (!(composer instanceof HTMLTextAreaElement)) {
        document.querySelector('[data-view="conversation"]')?.click()
        for (let attempt = 0; attempt < 80; attempt += 1) {
          composer = document.querySelector('#composer')
          if (composer instanceof HTMLTextAreaElement) break
          await new Promise(resolve => setTimeout(resolve, 25))
        }
      }
      if (!(composer instanceof HTMLTextAreaElement)
        || !(trajectory instanceof HTMLButtonElement)
        || !(projectSelector instanceof HTMLButtonElement)) {
        return { verifyError: '核心控件未就绪：'
          + JSON.stringify({ composer: composer?.constructor.name ?? null,
            trajectory: trajectory?.constructor.name ?? null,
            projectSelector: projectSelector?.constructor.name ?? null,
            view: document.querySelector('[data-view][aria-current="page"]')?.getAttribute('data-view') ?? null,
            body: document.body.textContent?.slice(0, 240) ?? '' }) }
      }
      const wait = async (check, attempts = 80) => {
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          const value = check()
          if (value) return value
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        return null
      }
      await wait(() => document.querySelector('.project-session-group .session-row') !== null)
      projectSelector.click()
      const projectFocusMenu = await wait(() => {
        const menu = document.querySelector('.project-focus-menu')
        return menu instanceof HTMLElement
          && menu.getAttribute('role') === 'menu'
          && menu.querySelector('[role="menuitemradio"][aria-checked="true"]') instanceof HTMLButtonElement
          ? menu
          : null
      })
      const ownProjectSelectorReady = projectFocusMenu instanceof HTMLElement
        && document.querySelector('.project-focus select') === null
      projectSelector.click()
      await wait(() => document.querySelector('.project-focus-menu') === null)
      const initialHeight = composer.getBoundingClientRect().height
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      valueSetter?.call(composer, Array.from({ length: 9 }, (_, index) => '第 ' + String(index + 1) + ' 行').join('\\n'))
      composer.dispatchEvent(new Event('input', { bubbles: true }))
      await wait(() => composer.getBoundingClientRect().height > initialHeight, 40)
      await new Promise(resolve => requestAnimationFrame(resolve))
      const grownHeight = composer.getBoundingClientRect().height
      valueSetter?.call(composer, '')
      composer.dispatchEvent(new Event('input', { bubbles: true }))
      trajectory.click()
      const trajectoryVisible = await wait(() => document.querySelector('#trajectory-view') instanceof HTMLElement) !== null
      // 轨迹在聊天浮岛内切换，不再自动收放两侧栏（见 docs/renderer.md）。
      const trajectoryShell = document.querySelector('.app-shell')
      const trajectoryKeepsPanels = trajectoryShell instanceof HTMLElement
        && trajectoryShell.dataset.navigationCollapsed !== 'true'
        && trajectoryShell.dataset.informationCollapsed !== 'true'
      document.querySelector('.conversation-view-tabs [data-view="conversation"]')?.click()
      await wait(() => document.querySelector('#conversation-view') instanceof HTMLElement)
      // 切换视图会正常取消旧动画；等它们完成或取消后，继续检查实际布局。
      await Promise.allSettled(document.querySelector('.app-shell').getAnimations({ subtree: true })
        .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished))
      const restoredShell = document.querySelector('.app-shell')
      const trajectoryFocusReady = trajectoryKeepsPanels
        && restoredShell instanceof HTMLElement
        && restoredShell.dataset.navigationCollapsed !== 'true'
        && restoredShell.dataset.informationCollapsed !== 'true'`

const ISLAND_GEOMETRY_AND_DENSITY_SNIPPET = `
      const currentIslands = [...document.querySelectorAll('.app-shell > .island:not([hidden])')]
      const styles = currentIslands.map(island => getComputedStyle(island))
      const bodyStyle = getComputedStyle(document.body)
      const tabs = [...document.querySelectorAll('.view-tabs button')]
      const projectCard = document.querySelector('.project-selector')
      const projectSectionHeading = document.querySelector('.project-section-heading')
      const projectAddButton = document.querySelector('button[aria-label="添加项目"]')
      const projectChatButtons = [...document.querySelectorAll('.project-group-actions button[aria-label*="新建聊天"]')]
      const costCard = document.querySelector('.info-island .cost-card')
      const projectGroups = [...document.querySelectorAll('.project-session-group')]
      const projectToggles = [...document.querySelectorAll('[data-project-toggle]')]
      const rows = [...document.querySelectorAll('.session-row')]
      const visibleRows = rows.filter(row => row instanceof HTMLElement && row.getClientRects().length > 0)
      const selectedRow = visibleRows.find(row => row.getAttribute('aria-current') === 'page')
      const composerIsland = composer.closest('.composer-card')
      const hiddenSelectedSession = selectedRow === undefined
        && composerIsland instanceof HTMLElement
        && composerIsland.dataset.sessionId !== undefined
      const selectedProjectGroup = selectedRow?.closest('.project-session-group')
        ?? document.querySelector('.project-group-heading.has-selected-session')?.closest('.project-session-group')
      const selectedProjectToggle = selectedProjectGroup?.querySelector('[data-project-toggle]')
      const selectedProjectName = selectedProjectToggle?.querySelector('strong')
      const selectedSessionTitle = selectedRow?.querySelector('.session-row__title')
      const searchTrigger = document.querySelector('.session-search-trigger')
      const navigationIsland = document.querySelector('.navigation-island')
      const sidebarIsland = document.querySelector('.sidebar-island')
      const mainIsland = document.querySelector('.main-island')
      const informationIsland = document.querySelector('.info-island')
      const dragRegion = document.querySelector('.window-drag-region')
      const toolbar = document.querySelector('.mode-rail')
      const navigationDivider = document.querySelector('.panel-divider--navigation')
      const informationDivider = document.querySelector('.panel-divider--information')
      const navigationCapsule = navigationDivider?.querySelector('.panel-divider__capsule')
      const informationCapsule = informationDivider?.querySelector('.panel-divider__capsule')
      const tabHeights = tabs.map(tab => tab.getBoundingClientRect().height)
      const shellStyle = getComputedStyle(document.querySelector('.app-shell'))
      const windowGap = Number.parseFloat(shellStyle.getPropertyValue('--window-gap'))
      const windowEdge = Number.parseFloat(shellStyle.getPropertyValue('--window-edge'))
      const modeRailWidth = Number.parseFloat(shellStyle.getPropertyValue('--mode-rail-width'))
      const composerInset = Number.parseFloat(shellStyle.getPropertyValue('--composer-inset'))
      const expectedIslandTop = windowEdge + (restoredShell.dataset.sessionTabsVisible === 'true'
        ? Number.parseFloat(shellStyle.getPropertyValue('--session-chrome-height')) + windowGap : 0)
      const expectedInformationTop = expectedIslandTop
      const topIslands = [sidebarIsland, mainIsland, informationIsland]
      const islandTops = topIslands.map(island => island instanceof HTMLElement
        ? island.getBoundingClientRect().top
        : 0)
      const dragRegionHeight = dragRegion instanceof HTMLElement
        ? dragRegion.getBoundingClientRect().height
        : 0
      const navigationRect = navigationIsland instanceof HTMLElement
        ? navigationIsland.getBoundingClientRect()
        : null
      const mainRect = mainIsland instanceof HTMLElement
        ? mainIsland.getBoundingClientRect()
        : null
      const informationRect = informationIsland instanceof HTMLElement
        ? informationIsland.getBoundingClientRect()
        : null
      const composerRect = document.querySelector('.composer-card')?.getBoundingClientRect() ?? null
      const composerReadingsRect = document.querySelector('[data-composer-readings="true"]')?.getBoundingClientRect() ?? null
      const composerRowSpan = composerReadingsRect === null || composerRect === null
        ? 0
        : composerReadingsRect.height + Math.max(0, composerReadingsRect.top - composerRect.bottom)
      const sidebarRect = sidebarIsland?.getBoundingClientRect()
      const projectHeader = document.querySelector('.sidebar-island > .project-focus')
      const projectHeaderRect = projectHeader?.getBoundingClientRect()
      const settingsTrigger = toolbar?.querySelector('#open-settings')
      const dragRect = dragRegion instanceof HTMLElement ? dragRegion.getBoundingClientRect() : null
      const toolbarRect = toolbar instanceof HTMLElement ? toolbar.getBoundingClientRect() : null
      const viewTabsRect = document.querySelector('.view-tabs')?.getBoundingClientRect() ?? null
      const searchTriggerRect = searchTrigger instanceof HTMLElement
        ? searchTrigger.getBoundingClientRect()
        : null
      const navigationDividerRect = navigationDivider instanceof HTMLElement
        ? navigationDivider.getBoundingClientRect()
        : null
      const informationDividerRect = informationDivider instanceof HTMLElement
        ? informationDivider.getBoundingClientRect()
        : null
      const navigationCapsuleRect = navigationCapsule instanceof HTMLElement
        ? navigationCapsule.getBoundingClientRect()
        : null
      const informationCapsuleRect = informationCapsule instanceof HTMLElement
        ? informationCapsule.getBoundingClientRect()
        : null
      const near = (value, expected) => Math.abs(value - expected) <= 1
      const titlebarClearanceReady = topIslands.every(island => island instanceof HTMLElement)
        && near(windowEdge, 8) && near(windowGap, windowEdge)
        && islandTops.every((top, index) => near(top, index === 0 ? windowEdge : index === 2 ? expectedInformationTop : expectedIslandTop))
        && near(dragRegionHeight, innerHeight)
        && dragRect !== null && near(dragRect.top, 0) && near(dragRect.bottom, innerHeight)
        && toolbarRect !== null && near(toolbarRect.left, windowEdge)
        && near(toolbarRect.width, modeRailWidth) && near(toolbarRect.bottom, innerHeight - windowEdge)
        && navigationRect !== null && near(navigationRect.left, toolbarRect.right)
        && near(navigationRect.bottom, innerHeight - windowEdge)
        && mainRect !== null && near(mainRect.left - sidebarRect.right, windowGap)
        && informationRect !== null && near(informationRect.left - mainRect.right, windowGap)
        && near(informationRect.right, innerWidth - windowEdge)
        && near(informationRect.bottom, innerHeight - windowEdge)
        && near(mainRect.bottom, innerHeight - windowEdge)
        && composerRect !== null && composerRect.top > mainRect.top
        && near(mainRect.bottom - composerRect.bottom - composerRowSpan, composerReadingsRect === null ? composerInset + 1 : 7)
        && composerRect.left - mainRect.left >= composerInset + 1
        && mainRect.right - composerRect.right >= composerInset + 1
        && near(composerRect.left + composerRect.right, mainRect.left + mainRect.right)
        && mainIsland.contains(document.querySelector('.composer-card'))
        && sidebarIsland.contains(toolbar) && sidebarIsland.contains(navigationIsland)
        && getComputedStyle(toolbar).backgroundColor !== getComputedStyle(sidebarIsland).backgroundColor
      const topToolbarReady = toolbarRect !== null
        && projectHeaderRect !== undefined && near(projectHeaderRect.top, windowEdge)
        && near(projectHeaderRect.left, sidebarRect.left) && near(projectHeaderRect.right, sidebarRect.right)
        && near(toolbarRect.top, projectHeaderRect.bottom) && near(navigationRect.top, projectHeaderRect.bottom)
        && projectSelector.getBoundingClientRect().left - projectHeaderRect.left
          >= (document.documentElement.dataset.platform === 'win32' ? 6 : 76)
        && near(projectSelector.getBoundingClientRect().top + projectSelector.getBoundingClientRect().height / 2, centerYLiteral)
        && projectSelector.getBoundingClientRect().top - projectHeaderRect.top >= 1
        && projectHeaderRect.bottom - projectSelector.getBoundingClientRect().bottom >= 1
        && getComputedStyle(projectSelector).getPropertyValue('-webkit-app-region') === 'no-drag'
        && getComputedStyle(projectHeader).getPropertyValue('-webkit-app-region') === 'drag'
        && near(toolbarRect.width, modeRailWidth)
        && getComputedStyle(toolbar).getPropertyValue('-webkit-app-region') === 'drag'
        && getComputedStyle(document.querySelector('.workspace-toolbar-content')).getPropertyValue('-webkit-app-region') === 'drag'
        && toolbar.scrollWidth <= toolbar.clientWidth + 1
        && tabs.length === 6 && ['conversation', 'changes', 'files', 'connections', 'database', 'plugins'].every(id => tabs.some(tab => tab.dataset.view === id))
        && tabs.every((tab, index) => {
          const rect = tab.getBoundingClientRect()
          return rect.left > toolbarRect.left && rect.right < toolbarRect.right
            && (index === 0 || rect.top >= tabs[index - 1].getBoundingClientRect().bottom)
        })
        && searchTrigger instanceof HTMLButtonElement
        && getComputedStyle(searchTrigger).getPropertyValue('-webkit-app-region') === 'no-drag'
        && getComputedStyle(document.querySelector('.view-tabs')).getPropertyValue('-webkit-app-region') === 'no-drag'
        && projectHeader.contains(searchTrigger)
        && searchTrigger.textContent.trim() === ''
        && searchTriggerRect.left >= projectSelector.getBoundingClientRect().right
        && searchTriggerRect.right <= projectHeaderRect.right
        && near(searchTriggerRect.top + searchTriggerRect.height / 2, centerYLiteral)
        && near(searchTriggerRect.top, projectSelector.getBoundingClientRect().top)
        && near(searchTriggerRect.bottom, projectSelector.getBoundingClientRect().bottom)
        && settingsTrigger instanceof HTMLButtonElement
        && getComputedStyle(settingsTrigger).getPropertyValue('-webkit-app-region') === 'no-drag'
        && settingsTrigger.getBoundingClientRect().top > viewTabsRect.bottom
        && near(toolbarRect.bottom - settingsTrigger.getBoundingClientRect().bottom, 10)
        && mainIsland instanceof HTMLElement
        && mainIsland.querySelector('.view-tabs') === null
      const toolbarLayoutIndependent = viewTabsRect !== null
        && searchTriggerRect !== null && toolbarRect !== null
        && viewTabsRect.left > toolbarRect.left && viewTabsRect.right < toolbarRect.right
        && searchTriggerRect.left >= projectSelector.getBoundingClientRect().right
        && searchTriggerRect.bottom < viewTabsRect.top
      const panelCapsulesReady = navigationDividerRect !== null
        && informationDividerRect !== null
        && navigationCapsuleRect !== null
        && informationCapsuleRect !== null
        && near(navigationDividerRect.width, windowGap)
        && near(informationDividerRect.width, windowGap)
        && near(navigationDividerRect.top, expectedIslandTop)
        && near(navigationDividerRect.bottom, innerHeight - windowEdge)
        && near(informationDividerRect.top, expectedInformationTop)
        && near(informationDividerRect.bottom, innerHeight - windowEdge)
        && near(navigationCapsuleRect.width, 22)
        && near(navigationCapsuleRect.height, 48)
        && near(informationCapsuleRect.width, 22)
        && near(informationCapsuleRect.height, 48)
        && navigationRect !== null
        && informationRect !== null
        && near((navigationCapsuleRect.left + navigationCapsuleRect.right) / 2 - sidebarRect.right, windowGap / 2)
        && near(informationRect.left - (informationCapsuleRect.left + informationCapsuleRect.right) / 2, windowGap / 2)
      const projectToggleTargetsReady = projectToggles.every(toggle => {
          if (!(toggle instanceof HTMLButtonElement)) return false
          const controlledId = toggle.getAttribute('aria-controls')
          const controlled = controlledId === null ? null : document.getElementById(controlledId)
          const expanded = toggle.getAttribute('aria-expanded') === 'true'
          return controlled instanceof HTMLElement
            && controlled.classList.contains('project-session-list')
            && controlled.hidden === !expanded
        })
      const otherProjectsCollapsed = projectGroups
          .filter(group => group !== selectedProjectGroup)
          .every(group => group.querySelector('[data-project-toggle]')?.getAttribute('aria-expanded') === 'false')
      const selectedSessionIndented = hiddenSelectedSession || (selectedSessionTitle instanceof HTMLElement
          && selectedSessionTitle.getBoundingClientRect().left
            >= selectedProjectToggle.getBoundingClientRect().left + 20)
      const projectGroupingAudit = {
        allProjectsSelected: projectSelector.textContent?.includes('全部项目') === true,
        ownProjectSelectorReady,
        projectSectionHeading: projectSectionHeading instanceof HTMLElement,
        projectAddButton: projectAddButton instanceof HTMLButtonElement,
        oneChatButtonPerProject: projectChatButtons.length === projectGroups.length,
        legacyActionsRemoved: document.querySelector('.project-actions') === null,
        legacySearchRemoved: document.querySelector('.search-box') === null,
        hasProjectGroups: projectGroups.length > 0,
        oneTogglePerProject: projectToggles.length === projectGroups.length,
        projectGroupIdsReady: projectGroups.every(group => group.getAttribute('data-project-group') !== null),
        projectToggleTargetsReady,
        hasVisibleOrHiddenSelectedSession: visibleRows.length > 0 || hiddenSelectedSession,
        selectedSessionReady: selectedRow instanceof HTMLButtonElement || hiddenSelectedSession,
        selectedProjectGroup: selectedProjectGroup instanceof HTMLElement,
        selectedProjectToggle: selectedProjectToggle instanceof HTMLButtonElement,
        selectedProjectExpanded: selectedProjectToggle?.getAttribute('aria-expanded') === 'true',
        otherProjectsCollapsed,
        selectedProjectName: selectedProjectName instanceof HTMLElement,
        selectedSessionIndented,
        allRowsGrouped: rows.every(row => projectGroups.some(group => group.contains(row))),
        visibleRows: visibleRows.length,
        projectGroups: projectGroups.length,
      }
      const projectGroupingReady = Object.values(projectGroupingAudit).every(value => value === true || typeof value === 'number')
      const densityReady = bodyStyle.fontSize === '12px'
        && (bodyStyle.fontWeight === '400' || bodyStyle.fontWeight === 'normal')
        && tabs.length === 6 && ['conversation', 'changes', 'files', 'connections', 'database', 'plugins'].every(id => tabs.some(tab => tab.dataset.view === id))
        && tabs.every(tab => tab.getAttribute('aria-label') && tab.querySelector('svg') !== null
          && tab.querySelector('span:not(.count-badge)') === null)
        && tabHeights.every(height => height >= 33.5 && height <= 34.5)
        && tabs.every(tab => Math.abs(tab.getBoundingClientRect().width - 34) <= 0.5)
        && projectSectionHeading instanceof HTMLElement
        && projectSectionHeading.getBoundingClientRect().height >= 33
        && projectSectionHeading.getBoundingClientRect().height <= 36
        && projectCard instanceof HTMLElement
        && projectCard.getBoundingClientRect().height >= 27
        && projectCard.getBoundingClientRect().height <= 29
        && searchTrigger instanceof HTMLElement
        && searchTrigger.getBoundingClientRect().height >= 27
        && searchTrigger.getBoundingClientRect().height <= 29
      const sessionCostRemoved = costCard === null
      const expectedToolsRightOffset = restoredShell.dataset.sessionTabsVisible === 'true' ? 9 : 13
      const workspaceHeaderRemoved = mainIsland instanceof HTMLElement
        && mainIsland.querySelector('.task-header') === null
        && mainIsland.querySelector('.workspace-view') instanceof HTMLElement
        && mainIsland.querySelector('.conversation-header') === null
        && mainIsland.querySelector('.conversation-tools') instanceof HTMLElement
        && near(
          mainIsland.querySelector('.conversation-tools').getBoundingClientRect().right,
          mainRect.right - expectedToolsRightOffset,
        )
        && near(mainIsland.querySelector('.workspace-view').getBoundingClientRect().top, mainRect.top + 1)
      return {
        title: document.title,
        renderer: location.protocol === 'file:',
        islandCount: currentIslands.length,
        pageScrollable: document.documentElement.scrollHeight > innerHeight
          || document.documentElement.scrollWidth > innerWidth,
        islandsOpaque: styles.every(style => !['rgba(0, 0, 0, 0)', 'transparent'].includes(style.backgroundColor)
          && !style.backgroundColor.includes(' / ') && !style.backgroundColor.startsWith('rgba('))
          && styles.every(style => style.backdropFilter === 'none'),
        trajectoryVisible,
        trajectoryFocusReady,
        initialHeight,
        grownHeight,
        composerCapped: grownHeight <= 180,
        projectFocused: projectGroupingReady,
        densityReady,
        sessionCostRemoved,
        workspaceHeaderRemoved,
        bodyFontSize: bodyStyle.fontSize,
        bodyFontWeight: bodyStyle.fontWeight,
        projectActionHeight: projectChatButtons[0] instanceof HTMLElement
          ? projectChatButtons[0].getBoundingClientRect().height
          : 0,
        tabHeight: tabHeights[0] ?? 0,
        titlebarClearanceReady,
        islandTop: islandTops[0] ?? 0,
        topToolbarReady,
        toolbarLayoutIndependent,
        panelCapsulesReady,
        windowGap,
        windowEdge,
        modeRailWidth,
      }`

/** 构造初始工作台三浮岛几何、顶栏净空、轨迹切换与密度指标采样脚本。 */
export function buildInitialWorkbenchProbe(trafficLightCenterY: number): string {
  return `(async () => {
    try {
      const centerYLiteral = ${String(trafficLightCenterY)}
      ${INITIAL_CONTROLS_AND_TRAJECTORY_SNIPPET}
      ${ISLAND_GEOMETRY_AND_DENSITY_SNIPPET}
    } catch (error) {
      return { verifyError: error instanceof Error ? error.stack ?? error.message : String(error) }
    }
  })()`
}
