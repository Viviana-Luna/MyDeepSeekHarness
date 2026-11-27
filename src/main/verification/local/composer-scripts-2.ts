/**
 * 输入区命令面板、文件引用、附件拖拽、审批弹窗与字号对比度验收套件：在渲染进程上下文执行的页面探测脚本集合（分片 2）。
 */

/** 浏览器端验收探测脚本（composer #5）。 */
export const COMPOSER_SCRIPT_5 = `(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const wait = async (check, attempts = 120) => {
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          const value = check()
          if (value) return value
          await sleep(25)
        }
        return null
      }
      const waitStable = async (check, attempts = 200, stableCount = 2) => {
        let streak = 0
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          if (check()) {
            streak += 1
            if (streak >= stableCount) return true
          } else {
            streak = 0
          }
          await sleep(25)
        }
        return false
      }
      const motionClassPattern = /(?:^|\\s)ant-[^\\s]+-(?:appear|enter|leave)(?:-(?:prepare|start|active))?(?:\\s|$)/
      const leaveClassPattern = /(?:^|\\s)[^\\s]+-leave(?:-(?:prepare|start|active))?(?:\\s|$)/
      const inMotion = node =>
        typeof node.className === 'string' && motionClassPattern.test(node.className)
      const isLeaving = node => {
        for (let current = node; current instanceof Element; current = current.parentElement) {
          if (current.hasAttribute('inert')) return true
          if (current instanceof HTMLElement) {
            if (current.dataset.menuMotion === 'closing') return true
            if (typeof current.className === 'string' && leaveClassPattern.test(current.className)) {
              return true
            }
          }
        }
        return false
      }
      const isVisibleElement = node =>
        node instanceof HTMLElement
        && node.isConnected
        && node.checkVisibility()
        && node.getClientRects().length > 0
        && !isLeaving(node)
      const hasFiniteRunningAnimation = node =>
        typeof node.getAnimations === 'function'
        && node.getAnimations({ subtree: true }).some(
          animation =>
            animation.playState !== 'finished'
            && animation.effect?.getComputedTiming().iterations !== Infinity,
        )
      const permissionMenuButtons = () => [
        ...document.querySelectorAll('button[aria-label="工作区内修改"], button[aria-label="完全权限"]'),
      ]
      const findOpenPermissionMenu = () =>
        [...document.querySelectorAll('[role="menu"][aria-label="选择访问模式"]')].find(
          menu =>
            menu instanceof HTMLElement
            && menu.dataset.menuMotion === 'open'
            && isVisibleElement(menu),
        ) ?? null
      const hasAnyPermissionMenu = () =>
        document.querySelector('[role="menu"][aria-label="选择访问模式"]') !== null
        || document.querySelector('[aria-label="选择访问模式"]') !== null
        || permissionMenuButtons().length > 0
      const hasVisibleOrLeavingDialog = () =>
        document.querySelector('[role="dialog"]') !== null
        || [...document.querySelectorAll('.ant-modal, .ant-modal-mask')].some(
          node =>
            node instanceof HTMLElement
            && (
              node.checkVisibility()
              || inMotion(node)
              || (typeof node.className === 'string' && leaveClassPattern.test(node.className))
            ),
        )
      const findActiveDialog = () =>
        [...document.querySelectorAll('[role="dialog"]')].find(
          dialog =>
            dialog instanceof HTMLElement
            && isVisibleElement(dialog)
            && !inMotion(dialog)
            && !hasFiniteRunningAnimation(dialog),
        ) ?? null
      const composer = document.querySelector('#composer')
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      let trigger = null
      const diagnose = (stage, targetLabel) => {
        const currentTrigger =
          trigger instanceof HTMLButtonElement && trigger.isConnected
            ? trigger
            : document.querySelector('.composer-card button[aria-label^="访问模式"]')
        const openMenu = findOpenPermissionMenu()
        const anyMenu = document.querySelector('[role="menu"][aria-label="选择访问模式"]')
        const scopedItem =
          openMenu instanceof HTMLElement && targetLabel
            ? openMenu.querySelector('button[aria-label=' + JSON.stringify(targetLabel) + ']')
            : null
        const fallbackItem = targetLabel
          ? document.querySelector('button[aria-label=' + JSON.stringify(targetLabel) + ']')
          : null
        const item = scopedItem ?? fallbackItem
        const dialog = document.querySelector('[role="dialog"]')
        const alertText =
          document.querySelector('.app-alert--floating[role="alert"]')?.textContent?.trim() ?? null
        return {
          ok: false,
          stage,
          triggerFound: currentTrigger instanceof HTMLButtonElement,
          triggerConnected:
            currentTrigger instanceof HTMLButtonElement ? currentTrigger.isConnected : false,
          triggerDisabled:
            currentTrigger instanceof HTMLButtonElement ? currentTrigger.disabled : null,
          triggerLabel: currentTrigger?.getAttribute('aria-label') ?? null,
          menuExpanded: currentTrigger?.getAttribute('aria-expanded') ?? null,
          openMenuPresent: openMenu instanceof HTMLElement,
          anyMenuPresent: anyMenu instanceof HTMLElement,
          anyMenuMotion: anyMenu instanceof HTMLElement ? (anyMenu.dataset.menuMotion ?? null) : null,
          anyMenuInert: anyMenu instanceof HTMLElement ? anyMenu.hasAttribute('inert') : null,
          lingeringMenuButtons: permissionMenuButtons().length,
          itemFound: item instanceof HTMLButtonElement,
          itemInOpenMenu: scopedItem instanceof HTMLButtonElement,
          itemDisabled: item instanceof HTMLButtonElement ? item.disabled : null,
          itemVisible: item instanceof HTMLElement ? isVisibleElement(item) : false,
          itemLeaving: item instanceof HTMLElement ? isLeaving(item) : false,
          itemChecked: item instanceof HTMLButtonElement ? item.getAttribute('aria-checked') : null,
          dialogPresent: dialog instanceof HTMLElement,
          dialogVisibleOrLeaving: hasVisibleOrLeavingDialog(),
          dialogClass: dialog instanceof HTMLElement ? dialog.className : null,
          activeTag: document.activeElement?.tagName ?? null,
          alertText,
          commandStatePresent: document.querySelector('.composer-command-state') !== null,
          queuePresent: document.querySelector('[aria-label="消息队列"]') !== null,
          draftMatches:
            composer instanceof HTMLTextAreaElement
              ? composer.value === '权限切换时保留这条草稿'
              : false,
        }
      }
      const isTriggerReadyToOpen = expectedLabel =>
        trigger instanceof HTMLButtonElement
        && isVisibleElement(trigger)
        && !trigger.disabled
        && trigger.getAttribute('aria-expanded') !== 'true'
        && trigger.getAttribute('aria-label') === expectedLabel
        && !hasAnyPermissionMenu()
        && !hasVisibleOrLeavingDialog()
      const findReadyMenuItem = (label, expectedChecked) => {
        const menu = findOpenPermissionMenu()
        if (!(menu instanceof HTMLElement)) return null
        if (!(trigger instanceof HTMLButtonElement) || trigger.getAttribute('aria-expanded') !== 'true') {
          return null
        }
        const item = [...menu.querySelectorAll('button[role="menuitemradio"]')].find(
          button => button.getAttribute('aria-label') === label,
        )
        if (!(item instanceof HTMLButtonElement) || !isVisibleElement(item) || item.disabled) {
          return null
        }
        if (
          expectedChecked !== undefined
          && item.getAttribute('aria-checked') !== String(expectedChecked)
        ) {
          return null
        }
        return item
      }
      if (!(composer instanceof HTMLTextAreaElement)) return diagnose('composer')
      valueSetter?.call(composer, '权限切换时保留这条草稿')
      composer.dispatchEvent(new Event('input', { bubbles: true }))
      await sleep(40)
      trigger = await wait(() => {
        const button = document.querySelector('.composer-card button[aria-label="访问模式，当前：工作区内修改"]')
        return button instanceof HTMLButtonElement
          && isVisibleElement(button)
          && !button.disabled
          && button.getAttribute('aria-expanded') !== 'true'
          && !hasAnyPermissionMenu()
          && !hasVisibleOrLeavingDialog()
          ? button
          : null
      }, 120)
      if (!(trigger instanceof HTMLButtonElement)) return diagnose('trigger')
      trigger.click()
      const full = await wait(() => findReadyMenuItem('完全权限', false), 120)
      if (!(full instanceof HTMLButtonElement)) return diagnose('menu', '完全权限')
      full.click()
      const firstDialog = await wait(() => {
        const dialog = findActiveDialog()
        if (!(dialog instanceof HTMLElement)) return null
        const confirmation = [...dialog.querySelectorAll('button')].find(
          button => button.textContent?.includes('启用完全权限'),
        )
        const acknowledgement = dialog.querySelector('input[type="checkbox"]')
        const rect = dialog.getBoundingClientRect()
        const ready = confirmation instanceof HTMLButtonElement && confirmation.disabled
          && acknowledgement instanceof HTMLInputElement && !acknowledgement.checked
          && findOpenPermissionMenu() === null
          && document.querySelector('[aria-label="选择访问模式"]') === null
          && rect.top >= 8 && rect.bottom <= innerHeight - 8
          && Math.abs(rect.left + rect.width / 2 - innerWidth / 2) < 2
          && Math.abs(rect.top + rect.height / 2 - innerHeight / 2) < 20
          && dialog.contains(document.activeElement)
        return ready ? dialog : null
      }, 160)
      if (!(firstDialog instanceof HTMLElement)) return diagnose('open-dialog', '完全权限')
      firstDialog.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true, cancelable: true }),
      )
      const cancelled = await wait(
        () =>
          isTriggerReadyToOpen('访问模式，当前：工作区内修改')
          && document.activeElement === trigger,
        160,
      )
      if (!cancelled) return diagnose('cancel-dialog')
      trigger.click()
      const reopenFull = await wait(() => findReadyMenuItem('完全权限', false), 120)
      if (!(reopenFull instanceof HTMLButtonElement)) return diagnose('reopen-menu', '完全权限')
      reopenFull.click()
      const confirmedDialog = await wait(() => {
        const dialog = findActiveDialog()
        if (!(dialog instanceof HTMLElement)) return null
        const acknowledgement = dialog.querySelector('input[type="checkbox"]')
        return acknowledgement instanceof HTMLInputElement
          && !acknowledgement.disabled
          && isVisibleElement(acknowledgement)
          ? dialog
          : null
      }, 160)
      if (!(confirmedDialog instanceof HTMLElement)) return diagnose('reopen-dialog', '完全权限')
      const acknowledgement = confirmedDialog.querySelector('input[type="checkbox"]')
      if (!(acknowledgement instanceof HTMLInputElement)) return diagnose('reopen-dialog', '完全权限')
      acknowledgement.click()
      const confirmButton = await wait(() => {
        if (!isVisibleElement(confirmedDialog)) return null
        const button = [...confirmedDialog.querySelectorAll('button')].find(
          item => item.textContent?.includes('启用完全权限'),
        )
        return button instanceof HTMLButtonElement && isVisibleElement(button) && !button.disabled
          ? button
          : null
      }, 120)
      if (!(confirmButton instanceof HTMLButtonElement)) return diagnose('confirm-button')
      confirmButton.click()
      const switched = await waitStable(
        () =>
          isTriggerReadyToOpen('访问模式，当前：完全权限')
          && document.querySelector('.composer-command-state') === null
          && document.querySelector('[aria-label="消息队列"]') === null
          && !(document.querySelector('.composer-tools')?.textContent ?? '').includes('待处理')
          && composer.value === '权限切换时保留这条草稿',
        200,
      )
      if (!switched) return diagnose('switch-full', '完全权限')
      trigger.click()
      // 同步确认选项未禁用（pick/busy 已清零）且「完全权限」已由会话投影勾选，避免命中退场旧菜单或提前 no-op。
      const workspaceItem = await wait(() => {
        const item = findReadyMenuItem('工作区内修改', false)
        const activeFull = findReadyMenuItem('完全权限', true)
        return item instanceof HTMLButtonElement && activeFull instanceof HTMLButtonElement
          ? item
          : null
      }, 160)
      if (!(workspaceItem instanceof HTMLButtonElement)) {
        return diagnose('restore-menu', '工作区内修改')
      }
      workspaceItem.click()
      const restored = await waitStable(
        () => isTriggerReadyToOpen('访问模式，当前：工作区内修改'),
        200,
      )
      valueSetter?.call(composer, '')
      composer.dispatchEvent(new Event('input', { bubbles: true }))
      if (!restored) return diagnose('restore-mode', '工作区内修改')
      return {
        ok: true,
        stage: 'done',
        triggerLabel: trigger.getAttribute('aria-label'),
      }
    })()`

/** 浏览器端验收探测脚本（composer #6）。 */
export const COMPOSER_SCRIPT_6 = `(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const composer = document.querySelector('#composer')
      const beforeHeight = document.querySelector('.composer-card').getBoundingClientRect().height
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(composer, '/mydsh-invalid-verify')
      composer.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.race([
        new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        sleep(100),
      ])
      composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      for (let attempt = 0; attempt < 80; attempt += 1) {
        await sleep(25)
        const alert = document.querySelector('.app-alert--error.app-alert--floating')
        if (alert) {
          const rect = alert.getBoundingClientRect()
          return alert.parentElement === document.body && getComputedStyle(alert).position === 'fixed'
            && rect.top >= 10 && rect.left >= 10 && rect.right <= innerWidth - 10
            && alert.textContent.includes('未知斜杠命令') && composer.value === '/mydsh-invalid-verify'
            && document.querySelector('.composer-card').getBoundingClientRect().height === beforeHeight
        }
      }
      return false
    })()`

/** 浏览器端验收探测脚本（composer #7）。 */
export const COMPOSER_SCRIPT_7 = `(async () => {
      for (let attempt = 0; attempt < 80 && document.documentElement.dataset.colorScheme !== 'light'; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      await Promise.race([
        new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        new Promise(resolve => setTimeout(resolve, 200)),
      ])
      return document.documentElement.dataset.colorScheme === 'light'
        && getComputedStyle(document.documentElement).getPropertyValue('--surface-raised').trim() === '#eceef2'
        && document.querySelector('.app-alert--error.app-alert--floating') !== null
    })()`

/** 浏览器端验收探测脚本（composer #8）。 */
export const COMPOSER_SCRIPT_8 = `(async () => {
      document.querySelector('.app-alert--floating button[aria-label="关闭提示"]').click()
      const composer = document.querySelector('#composer')
      let closed = false
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (document.querySelector('.app-alert--floating') === null) {
          closed = composer.value === '/mydsh-invalid-verify'
          break
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(composer, '')
      composer.dispatchEvent(new Event('input', { bubbles: true }))
      return closed
    })()`

const COMPOSER_PARTS_9 = [
  '(async () => {\n        const expected = ',
  "\n        const root = document.documentElement\n        for (let attempt = 0; attempt < 80; attempt += 1) {\n          if (root.style.getPropertyValue('--text-body').trim() === String(expected) + 'px') break\n          await new Promise(resolve => setTimeout(resolve, 25))\n        }\n        await Promise.race([\n          new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),\n          new Promise(resolve => setTimeout(resolve, 200)),\n        ])\n        const tabs = [...document.querySelectorAll('.view-tabs button')]\n        const sessionRows = [...document.querySelectorAll('.session-row')]\n        const projectSelector = document.querySelector('.project-selector')\n        const searchTrigger = document.querySelector('.session-search-trigger')\n        const composer = document.querySelector('#composer')\n        const singleLine = elements => elements.every(element => element.scrollWidth <= element.clientWidth + 1\n          && element.scrollHeight <= element.clientHeight + 1)\n        return getComputedStyle(document.body).fontSize === String(expected) + 'px'\n          && root.style.getPropertyValue('--text-body').trim() === String(expected) + 'px'\n          && tabs.every(tab => {\n            const icon = tab.querySelector('svg')?.getBoundingClientRect()\n            return icon !== undefined && icon.width === 20 && icon.height === 20\n              && tab.getAttribute('aria-label') !== null\n          })\n          && singleLine(sessionRows)\n          && projectSelector instanceof HTMLElement\n          && searchTrigger instanceof HTMLElement\n          && searchTrigger.scrollHeight <= searchTrigger.clientHeight + 1\n          && composer instanceof HTMLTextAreaElement\n          && getComputedStyle(composer).fontSize === String(expected) + 'px'\n      })()",
] as const

/** 构造带参数的浏览器端验收探测脚本（composer #9）。 */
export function buildComposerScript9(p0: unknown): string {
  return COMPOSER_PARTS_9[0]! + String(p0) + COMPOSER_PARTS_9[1]!
}
