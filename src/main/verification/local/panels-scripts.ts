/**
 * 左右侧栏折叠、分隔条拖拽缩放与非对话视图输入区显隐验收套件：在渲染进程上下文执行的页面探测脚本集合。
 */

/** 浏览器端验收探测脚本（panels #1）。 */
export const PANELS_SCRIPT_1 = `(async () => {
      // 折叠现在会经过连续过渡，几何断言只读取过渡完成后的布局。
      await Promise.all(document.querySelector('.app-shell').getAnimations({ subtree: true })
        .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map(animation => animation.finished.catch(() => {})))
      const navigation = document.querySelector('.navigation-island')
      const main = document.querySelector('.main-island')
      const information = document.querySelector('.info-island')
      const composer = document.querySelector('.composer-card')
      const composerReadings = document.querySelector('[data-composer-readings="true"]')
      const composerFooter = composer?.querySelector('footer')
      const body = main?.querySelector('.workspace-view')
      const bodyRect = body?.getBoundingClientRect()
      const dock = composer?.closest('.composer-dock')
      const sidebarRect = document.querySelector('.sidebar-island')?.getBoundingClientRect()
      const navigationButton = document.querySelector('.panel-divider--navigation .panel-divider__capsule')
      const informationButton = document.querySelector('.panel-divider--information .panel-divider__capsule')
      const composerDivider = document.querySelector('.panel-divider--composer')
      const resizeCorner = document.querySelector('.panel-resize-corner')
      const viewTabs = document.querySelector('.view-tabs')
      if (!(navigation instanceof HTMLElement)
        || !(main instanceof HTMLElement)
        || !(information instanceof HTMLElement)
        || !(composer instanceof HTMLElement)
        || !(composerFooter instanceof HTMLElement)
        || !(composerDivider instanceof HTMLElement)
        || !(navigationButton instanceof HTMLButtonElement)
        || !(informationButton instanceof HTMLButtonElement)
        || !(viewTabs instanceof HTMLElement)) return null
      const navigationRect = navigation.getBoundingClientRect()
      const mainRect = main.getBoundingClientRect()
      const informationRect = information.getBoundingClientRect()
      const composerRect = composer.getBoundingClientRect()
      const composerFooterRect = composerFooter.getBoundingClientRect()
      const composerReadingsRect = composerReadings?.getBoundingClientRect() ?? null
      // 读数条可见时它才是输入区的底：卡片底边距浮岛底边多出读数条与它到卡片的间距。
      const composerRowSpan = composerReadingsRect === null
        ? 0
        : composerReadingsRect.height + Math.max(0, composerReadingsRect.top - composerRect.bottom)
      const viewTabsRect = viewTabs.getBoundingClientRect()
      const composerDividerRect = composerDivider.getBoundingClientRect()
      const resizeCornerRect = resizeCorner instanceof HTMLElement
        ? resizeCorner.getBoundingClientRect()
        : null
      return {
        viewportWidth: innerWidth,
        navigationVisible: getComputedStyle(navigation).display !== 'none' && getComputedStyle(navigation).visibility !== 'hidden',
        informationVisible: getComputedStyle(information).display !== 'none' && getComputedStyle(information).visibility !== 'hidden',
        navigationWidth: navigationRect.width,
        informationWidth: informationRect.width,
        mainHeight: mainRect.height,
        composerHeight: composerRect.height,
        mainLeft: mainRect.left,
        mainRight: mainRect.right,
        composerLeft: composerRect.left,
        composerRight: composerRect.right,
        navigationGap: mainRect.left - sidebarRect.right,
        informationGap: informationRect.left - mainRect.right,
        composerGap: composerRect.top - bodyRect.bottom,
        composerOverlayReady: body instanceof HTMLElement && dock instanceof HTMLElement
          && Math.abs(bodyRect.bottom - mainRect.bottom) <= 1
          && Number.parseFloat(getComputedStyle(body).paddingBottom)
            >= dock.getBoundingClientRect().height + Number.parseFloat(getComputedStyle(dock).marginBottom) + 23,
        composerTop: composerRect.top,
        composerContained: main.contains(composer)
          && composerRect.left >= mainRect.left + 17
          && composerRect.right <= mainRect.right - 17
          && Math.abs(mainRect.bottom - composerRect.bottom - composerRowSpan - (composerReadingsRect === null ? 17 : 7)) <= 1
          && Math.abs(composerRect.left + composerRect.right - mainRect.left - mainRect.right) <= 1
          && bodyRect.height >= 220,
        composerFooterBottomGap: composerRect.bottom - composerFooterRect.bottom,
        composerReadingsSpan: composerRowSpan,
        composerDividerTop: composerDividerRect.top,
        composerDividerBottom: composerDividerRect.bottom,
        resizeCornerCenterX: resizeCornerRect === null ? null : resizeCornerRect.left + resizeCornerRect.width / 2,
        resizeCornerCenterY: resizeCornerRect === null ? null : resizeCornerRect.top + resizeCornerRect.height / 2,
        resizeCornerOpacity: resizeCorner instanceof HTMLElement
          ? Number(getComputedStyle(resizeCorner).opacity)
          : null,
        viewTabsLeft: viewTabsRect.left,
        viewTabsRight: viewTabsRect.right,
        viewTabsWidth: viewTabsRect.width,
        navigationLabel: navigationButton.getAttribute('aria-label'),
        informationLabel: informationButton.getAttribute('aria-label'),
      }
    })()`

/** 浏览器端验收探测脚本（panels #2）。 */
export const PANELS_SCRIPT_2 = `(() => {
      const sidebar = document.querySelector('.sidebar-island').getBoundingClientRect()
      const chrome = document.querySelector('.session-chrome').getBoundingClientRect()
      const railElement = document.querySelector('.mode-rail')
      const rail = railElement.getBoundingClientRect()
      const settings = document.querySelector('#open-settings').getBoundingClientRect()
      const shellStyle = getComputedStyle(document.querySelector('.app-shell'))
      return {
        sidebarTop: sidebar.top,
        sidebarBottom: sidebar.bottom,
        chromeTop: chrome.top,
        chromeBottom: chrome.bottom,
        searchHidden: document.querySelector('.session-search-trigger') === null,
        chromeRight: chrome.right,
        railTop: rail.top,
        railBottom: rail.bottom,
        railLeft: rail.left,
        railRight: rail.right,
        railWidth: rail.width,
        modeRailWidth: Number.parseFloat(shellStyle.getPropertyValue('--mode-rail-width')),
        railBackground: getComputedStyle(railElement).backgroundColor,
        settingsLeft: settings.left,
        settingsRight: settings.right,
        settingsBottom: settings.bottom,
      }
    })()`

/** 浏览器端验收探测脚本（panels #3）。 */
export const PANELS_SCRIPT_3 = `(async () => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const divider = document.querySelector('.panel-divider--navigation')
        const sidebar = document.querySelector('.sidebar-island')
        if (divider instanceof HTMLElement && sidebar instanceof HTMLElement && divider.classList.contains('is-resizing')) {
          await Promise.allSettled(
            divider.getAnimations({ subtree: true })
              .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
              .map(animation => animation.finished),
          )
          const line = getComputedStyle(divider, '::before')
          const dividerRect = divider.getBoundingClientRect()
          const islandRadius = Number.parseFloat(getComputedStyle(sidebar).borderBottomLeftRadius)
          if (Number(line.opacity) === 1
            && new DOMMatrixReadOnly(line.transform).d === 1
            && Math.abs(Number.parseFloat(line.width) - dividerRect.width) <= 0.1
            && Number.parseFloat(line.top) >= islandRadius - 1
            && Number.parseFloat(line.bottom) >= islandRadius - 1) return true
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return false
    })()`

/** 浏览器端验收探测脚本（panels #4）。 */
export const PANELS_SCRIPT_4 = `(async () => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const divider = document.querySelector('.panel-divider--navigation')
        if (divider instanceof HTMLElement && !divider.classList.contains('is-resizing')) {
          await Promise.allSettled(
            divider.getAnimations({ subtree: true })
              .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
              .map(animation => animation.finished),
          )
          if (Number(getComputedStyle(divider, '::before').opacity) === 0
            && new DOMMatrixReadOnly(getComputedStyle(divider, '::before').transform).d === 0) return true
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return false
    })()`

/** 浏览器端验收探测脚本（panels #5）。 */
export const PANELS_SCRIPT_5 = `(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const near = (left, right) => Math.abs(left - right) <= 1
      const validateNonConversation = async view => {
        const tab = document.querySelector('[data-view="' + view + '"]')
        if (!(tab instanceof HTMLButtonElement)) return false
        tab.click()
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const shell = document.querySelector('.app-shell')
          const main = document.querySelector('.main-island:not([hidden])')
          const active = document.querySelector('[data-view="' + view + '"]')
          if (shell instanceof HTMLElement
            && main instanceof HTMLElement
            && active instanceof HTMLButtonElement
            && active.classList.contains('is-active')) {
            const edge = Number.parseFloat(getComputedStyle(shell).getPropertyValue('--window-edge'))
            const composers = [...document.querySelectorAll('.composer-card')]
            const ready = composers.length > 0
              && composers.every(composer => {
                const panel = composer.closest('.work-tab-panel, .workspace-island')
                return !composer.checkVisibility() && panel?.hidden === true && panel.inert === true
              })
              && ![...document.querySelectorAll('.panel-divider--composer, .panel-resize-corner')]
                .some(node => node.checkVisibility())
              && shell.dataset.composerVisible !== 'true'
              && Number.isFinite(edge)
              && near(main.getBoundingClientRect().bottom, innerHeight - edge)
            if (ready) return true
          }
          await sleep(25)
        }
        return false
      }
      const hidden = []
      for (const view of ['changes', 'files']) {
        hidden.push(await validateNonConversation(view))
      }
      const conversation = document.querySelector('[data-view="conversation"]')
      if (!(conversation instanceof HTMLButtonElement)) return false
      conversation.click()
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const shell = document.querySelector('.app-shell')
        const composer = document.querySelector('.main-island .composer-card')
        if (shell instanceof HTMLElement
          && composer instanceof HTMLElement
          && shell.dataset.composerVisible === 'true'
          && document.querySelector('.panel-divider--composer') instanceof HTMLElement
          && document.querySelector('.panel-resize-corner') instanceof HTMLElement) return hidden.every(Boolean)
        await sleep(25)
      }
      return false
    })()`
