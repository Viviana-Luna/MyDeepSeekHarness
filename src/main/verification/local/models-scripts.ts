/**
 * 模型菜单、会话预设、压缩读数、计划评审与待响应交互验收套件：在渲染进程上下文执行的页面探测脚本集合。
 */

/** 浏览器端验收探测脚本（models #1）。 */
export const MODELS_SCRIPT_1 = `(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const selector = '[role="menu"][aria-label="选择模型"]'
      const fits = rect => rect.left >= 8 && rect.top >= 8
        && rect.right <= innerWidth - 8 && rect.bottom <= innerHeight - 8
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const menu = document.querySelector(selector)
        const model = menu?.querySelector('[role="menuitemradio"][aria-haspopup="menu"]')
        if (menu instanceof HTMLElement && model instanceof HTMLButtonElement) {
          model.click()
          for (let check = 0; check < 60; check += 1) {
            const id = model.getAttribute('aria-controls')
            const submenu = id && document.getElementById(id)
            if (submenu && getComputedStyle(submenu).visibility === 'visible') {
              const rect = menu.getBoundingClientRect(), side = submenu.getBoundingClientRect()
              return {
                open: true,
                selectedCount: menu.querySelectorAll('[role="menuitemradio"][aria-checked="true"]').length,
                portal: menu.parentElement === document.body && submenu.parentElement === document.body,
                fixed: getComputedStyle(menu).position === 'fixed' && getComputedStyle(submenu).position === 'fixed',
                fits: fits(rect) && fits(side),
                width: rect.width,
                adjacent: side.right <= rect.left || side.left >= rect.right,
                choices: submenu.querySelectorAll('[role="menuitemradio"]').length,
              }
            }
            await sleep(25)
          }
        }
        await sleep(25)
      }
      return { open: false, selectedCount: 0, portal: false, fixed: false, fits: false,
        width: 0, adjacent: false, choices: 0 }
    })()`

/** 浏览器端验收探测脚本（models #2）。 */
export const MODELS_SCRIPT_2 = `(async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const trigger = document.querySelector('button[title^="模型："]')
        if (trigger instanceof HTMLButtonElement
          && trigger.getAttribute('aria-expanded') === 'false'
          && document.activeElement === trigger
          && document.querySelector('[role="menu"][aria-label="选择模型"]') === null) return true
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return false
    })()`

/** 浏览器端验收探测脚本（models #3）。 */
export const MODELS_SCRIPT_3 = `(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const composer = document.querySelector('.work-tab-panel:not([hidden]) .composer-card')
      if (composer instanceof HTMLElement && composer.dataset.sessionId !== undefined) {
        return composer.dataset.sessionId
      }
      let selected = document.querySelector('.session-row[aria-current="page"]')
      if (!(selected instanceof HTMLButtonElement)) {
        const projectSelector = document.querySelector('.project-selector')
        if (projectSelector instanceof HTMLButtonElement) {
          projectSelector.click()
          await sleep(50)
          const allProjects = [...document.querySelectorAll('.project-focus-menu button')]
            .find(button => button.textContent?.includes('全部项目') === true)
          if (allProjects instanceof HTMLButtonElement) allProjects.click()
        }
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const visible = [...document.querySelectorAll('.session-row')]
            .find(row => row instanceof HTMLButtonElement && row.getClientRects().length > 0)
          if (visible instanceof HTMLButtonElement) {
            visible.click()
            break
          }
          const collapsed = [...document.querySelectorAll('[data-project-toggle]')]
            .find(toggle => toggle.getAttribute('aria-expanded') === 'false')
          if (collapsed instanceof HTMLButtonElement) collapsed.click()
          await sleep(25)
        }
      }
      for (let attempt = 0; attempt < 40; attempt += 1) {
        selected = document.querySelector('.session-row[aria-current="page"]')
        if (selected instanceof HTMLElement) return selected.dataset.sessionId ?? null
        await sleep(25)
      }
      return null
    })()`

const MODELS_PARTS_4 = [
  "(async () => {\n        for (let attempt = 0; attempt < 80; attempt += 1) {\n          const group = [...document.querySelectorAll('[aria-label=\"Agent 预设\"]')]\n            .find(node => node instanceof HTMLElement && node.checkVisibility())\n          const button = [...(group?.querySelectorAll('button') ?? [])]\n            .find(item => item instanceof HTMLButtonElement && item.textContent?.trim() === ",
  ')\n          if (button && !button.disabled) {\n            button.click()\n            return true\n          }\n          await new Promise(resolve => setTimeout(resolve, 25))\n        }\n        return false\n      })()',
] as const

/** 构造带参数的浏览器端验收探测脚本（models #4）。 */
export function buildModelsScript4(p0: unknown): string {
  return MODELS_PARTS_4[0]! + String(p0) + MODELS_PARTS_4[1]!
}

const MODELS_PARTS_5 = [
  "(async () => {\n        for (let attempt = 0; attempt < 120; attempt += 1) {\n          const group = [...document.querySelectorAll('[aria-label=\"Agent 预设\"]')]\n            .find(node => node instanceof HTMLElement && node.checkVisibility())\n          const button = [...(group?.querySelectorAll('button') ?? [])]\n            .find(item => item instanceof HTMLButtonElement && item.textContent?.trim() === ",
  ")\n          if (button?.getAttribute('aria-pressed') === 'true'\n            && !button.disabled\n            && group?.getAttribute('aria-busy') === 'false'\n            && group.closest('[aria-label=\"会话预设\"]')?.querySelector('[role=\"alert\"]') === null) return true\n          await new Promise(resolve => setTimeout(resolve, 25))\n        }\n        return false\n      })()",
] as const

/** 构造带参数的浏览器端验收探测脚本（models #5）。 */
export function buildModelsScript5(p0: unknown): string {
  return MODELS_PARTS_5[0]! + String(p0) + MODELS_PARTS_5[1]!
}

const MODELS_PARTS_6 = [
  "(async () => {\n      for (let attempt = 0; attempt < 80; attempt += 1) {\n        const group = [...document.querySelectorAll('[aria-label=\"Agent 预设\"]')]\n          .find(node => node instanceof HTMLElement && node.checkVisibility())\n        const buttons = [...(group?.querySelectorAll('button') ?? [])]\n        if (buttons.length > 0 && buttons.every(button => button instanceof HTMLButtonElement && button.disabled)) {\n          const { items } = await window.dshDesktop.host.call('listSessions', {})\n          return items.length === ",
  '\n            && document.querySelector(\'.session-row[aria-current="page"]\')?.dataset.sessionId === ',
  '\n        }\n        await new Promise(resolve => setTimeout(resolve, 25))\n      }\n      return false\n    })()',
] as const

/** 构造带参数的浏览器端验收探测脚本（models #6）。 */
export function buildModelsScript6(p0: unknown, p1: unknown): string {
  return MODELS_PARTS_6[0]! + String(p0) + MODELS_PARTS_6[1]! + String(p1) + MODELS_PARTS_6[2]!
}

/** 浏览器端验收探测脚本（models #7）。 */
export const MODELS_SCRIPT_7 = `(async () => {
      for (let i = 0; i < 80; i += 1) {
        const toggle = document.querySelector('.todo-card__toggle')
        if (toggle) {
          toggle.scrollIntoView({ block: 'nearest' })
          return toggle.getAttribute('aria-expanded') === 'false'
            && toggle.textContent.includes('已完成 1 · 进行中 2 · 待处理 6') && !document.querySelector('.todo-card__list')
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return false
    })()`

/** 浏览器端验收探测脚本（models #8）。 */
export const MODELS_SCRIPT_8 = `(async () => {
          for (let attempt = 0; attempt < 80; attempt += 1) {
            const list = document.querySelector('.todo-card__list')
            const card = document.querySelector('.todo-card__body')
            if (list && card) {
              const todoRect = card.getBoundingClientRect()
              const inputRect = document.querySelector('.composer-card').getBoundingClientRect()
              const toggle = card.querySelector('.todo-card__toggle')
              const arrow = toggle?.querySelector('svg:last-child')
              list.scrollTop = list.scrollHeight
              card.scrollIntoView({ block: 'nearest' })
              const ok = list.children.length === 9 && list.querySelectorAll('[data-status="in_progress"]').length === 2
                && list.clientHeight <= 180 && list.scrollHeight > list.clientHeight && list.scrollTop > 0
                && card.scrollWidth <= card.clientWidth + 1 && list.querySelectorAll('input').length === 0
                && [...list.querySelectorAll('.todo-card__content')].every(item => item.title === item.textContent)
                && card.closest('.composer-dock') !== null && !document.querySelector('.info-island .todo-card')
                && todoRect.top > 0 && Math.abs(todoRect.left - inputRect.left) < 1
                && Math.abs(todoRect.right - inputRect.right) < 1 && inputRect.top - todoRect.bottom >= 4
                && inputRect.top - todoRect.bottom <= 10
                && toggle?.getAttribute('aria-expanded') === 'true'
                && arrow?.classList.contains('lucide-chevron-down') && getComputedStyle(arrow).transform === 'none'
                && document.querySelector('.info-island .git-review-panel') instanceof HTMLElement
              if (ok) return true
            }
            await new Promise(resolve => setTimeout(resolve, 25))
          }
          return false
        })()`

/** 浏览器端验收探测脚本（models #9）。 */
export const MODELS_SCRIPT_9 = `(async () => {
          for (let attempt = 0; attempt < 80; attempt += 1) {
            const card = document.querySelector('.todo-card__body')
            const input = document.querySelector('.composer-card')
            const toggle = card?.querySelector('.todo-card__toggle')
            const arrow = toggle?.querySelector('svg:last-child')
            if (card && input && arrow) {
              const a = card.getBoundingClientRect(), b = input.getBoundingClientRect()
              const transform = new DOMMatrixReadOnly(getComputedStyle(arrow).transform)
              if (toggle.getAttribute('aria-expanded') === 'false' && !card.querySelector('.todo-card__list')
                && Math.abs(a.left + a.right - b.left - b.right) < 1
                && arrow.classList.contains('lucide-chevron-down') && transform.d < -0.99) return true
            }
            await new Promise(resolve => setTimeout(resolve, 25))
          }
          return false
        })()`

const MODELS_PARTS_10 = [
  "(async () => {\n          for (let attempt = 0; attempt < 80; attempt += 1) {\n            const hud = document.querySelector('[data-composer-readings]')\n            const card = document.querySelector('.composer-card')?.getBoundingClientRect()\n            const island = document.querySelector('.main-island')?.getBoundingClientRect()\n            if (hud && card && island) {\n              const row = hud.getBoundingClientRect()\n              if (hud.querySelectorAll('button').length === 3 && hud.textContent.includes('121K tok')\n                && Math.abs(card.height - ",
  ') < 1 && row.height === 24\n                && Math.abs(row.top - card.bottom - 2) < 1 && Math.abs(island.bottom - row.bottom - 7) < 1\n                && Math.abs(row.left + row.right - card.left - card.right) < 1 && hud.scrollWidth <= hud.clientWidth) return true\n            }\n            await new Promise(resolve => setTimeout(resolve, 25))\n          }\n          return false\n        })()',
] as const

/** 构造带参数的浏览器端验收探测脚本（models #10）。 */
export function buildModelsScript10(p0: unknown): string {
  return MODELS_PARTS_10[0]! + String(p0) + MODELS_PARTS_10[1]!
}

/** 浏览器端验收探测脚本（models #11）。 */
export const MODELS_SCRIPT_11 = `(async () => {
          for (let attempt = 0; attempt < 60; attempt += 1) {
            const panel = document.querySelector('[role="dialog"][aria-label="Token 用量"]')
            const button = document.querySelector('[data-composer-readings] button[aria-label^="Token 用量"]')
            if (panel && button) {
              const rect = panel.getBoundingClientRect()
              if (button.getAttribute('aria-expanded') === 'true' && panel.textContent.includes('缓存读取')
                && rect.top >= 0 && rect.bottom <= button.getBoundingClientRect().top) return true
            }
            await new Promise(resolve => setTimeout(resolve, 25))
          }
          return false
        })()`

/** 浏览器端验收探测脚本（models #12）。 */
export const MODELS_SCRIPT_12 = `(async () => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const menu = document.querySelector('.right-island-tabs')
        if (menu && !menu.querySelector('small') && menu.querySelectorAll('[aria-selected="true"]').length === 1
          && menu.querySelector('[data-tab-id="conversation"]') === null
          && menu.querySelector('[data-island-id="git-history"]')?.getAttribute('aria-selected') === 'true'
          && !menu.querySelector('[data-tab-id="session-info"], [data-tab-id="plan-preview"]')
          && !document.querySelector('.todo-card')) return true
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return false
    })()`

const MODELS_PARTS_13 = [
  '(async () => {\n      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))\n      for (let attempt = 0; attempt < 80; attempt += 1) {\n        const card = document.querySelector(\'[data-question-key="',
  "\"]')\n        const options = card?.querySelectorAll('[role=\"radio\"]')\n        const custom = card?.querySelector('textarea[placeholder=\"输入你的回答\"]')\n        const submit = [...(card?.querySelectorAll('button') ?? [])]\n          .find(button => button.textContent?.includes('提交回答'))\n        const skip = [...(card?.querySelectorAll('button') ?? [])]\n          .find(button => button.textContent?.includes('跳过此题'))\n        const close = card?.querySelector('button[aria-label=\"关闭问题\"]')\n        if (card instanceof HTMLElement\n          && options?.length === 2\n          && custom instanceof HTMLTextAreaElement\n          && submit instanceof HTMLButtonElement\n          && skip instanceof HTMLButtonElement\n          && close instanceof HTMLButtonElement\n          && card.textContent?.includes('推荐') === true) return true\n        await sleep(25)\n      }\n      return false\n    })()",
] as const

/** 构造带参数的浏览器端验收探测脚本（models #13）。 */
export function buildModelsScript13(p0: unknown): string {
  return MODELS_PARTS_13[0]! + String(p0) + MODELS_PARTS_13[1]!
}

const MODELS_PARTS_14 = [
  '(async () => {\n      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))\n      for (let attempt = 0; attempt < 80; attempt += 1) {\n        const card = document.querySelector(\'[data-approval-key="',
  "\"]')\n        const buttons = [...(card?.querySelectorAll('button') ?? [])]\n        const reject = buttons.find(button => button.textContent?.trim() === '拒绝')\n        const allowOnce = buttons.find(button => button.textContent?.includes('允许一次'))\n        if (card instanceof HTMLElement\n          && reject instanceof HTMLButtonElement\n          && allowOnce instanceof HTMLButtonElement\n          && card.textContent?.includes('不会永久放宽会话权限') === true\n          && !card.textContent?.includes('始终允许')) {\n          const panel = card.closest('.pending-interaction-card')\n          const reason = card.querySelector('h2')\n          const body = reason.parentElement\n          const compact = panel.getBoundingClientRect().height < 260\n          const original = reason.textContent\n          try {\n            reason.textContent = original.repeat(160)\n            return compact && body.scrollHeight > body.clientHeight\n              && body.scrollWidth <= body.clientWidth + 1\n              && panel.getBoundingClientRect().height <= 420\n              && allowOnce.getBoundingClientRect().bottom <= panel.getBoundingClientRect().bottom\n          } finally { reason.textContent = original }\n        }\n        await sleep(25)\n      }\n      return false\n    })()",
] as const

/** 构造带参数的浏览器端验收探测脚本（models #14）。 */
export function buildModelsScript14(p0: unknown): string {
  return MODELS_PARTS_14[0]! + String(p0) + MODELS_PARTS_14[1]!
}
