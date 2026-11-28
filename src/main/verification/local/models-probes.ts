/**
 * 模型菜单、会话预设胶囊、待办清单、HUD 读数与待响应交互卡片的渲染进程探测脚本。
 */

/** 打开模型二级子菜单并测量 Portal 挂载位置与视口边界收敛。 */
export const MODEL_SUBMENU_GEOMETRY_PROBE = `(async () => {
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

/** 验证模型菜单关闭后焦点归还触发按钮。 */
export const MODEL_MENU_CLOSED_PROBE = `(async () => {
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

/** 解析当前可见对话标签或侧栏选中项所属的会话 ID。 */
export const RESOLVE_INTERACTION_SESSION_ID_PROBE = `(async () => {
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

/** 构造点击指定名称空会话 Agent 预设胶囊的探测脚本。 */
export function buildClickAgentPresetCapsuleProbe(presetLabel: string): string {
  return `(async () => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const group = [...document.querySelectorAll('[aria-label="Agent 预设"]')]
        .find(node => node instanceof HTMLElement && node.checkVisibility())
      const button = [...(group?.querySelectorAll('button') ?? [])]
        .find(item => item instanceof HTMLButtonElement && item.textContent?.trim() === ${JSON.stringify(presetLabel)})
      if (button && !button.disabled) {
        button.click()
        return true
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return false
  })()`
}

/** 构造等待指定 Agent 预设胶囊进入选中就绪态的探测脚本。 */
export function buildWaitAgentPresetSelectedProbe(presetLabel: string): string {
  return `(async () => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const group = [...document.querySelectorAll('[aria-label="Agent 预设"]')]
        .find(node => node instanceof HTMLElement && node.checkVisibility())
      const button = [...(group?.querySelectorAll('button') ?? [])]
        .find(item => item instanceof HTMLButtonElement && item.textContent?.trim() === ${JSON.stringify(presetLabel)})
      if (button?.getAttribute('aria-pressed') === 'true'
        && !button.disabled
        && group?.getAttribute('aria-busy') === 'false'
        && group.closest('[aria-label="会话预设"]')?.querySelector('[role="alert"]') === null) return true
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return false
  })()`
}

/** 构造验证会话激活后预设胶囊全部锁定且未产生多余会话的探测脚本。 */
export function buildVerifyAgentPresetLockedProbe(
  expectedSessionCount: number,
  sessionId: string,
): string {
  return `(async () => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const group = [...document.querySelectorAll('[aria-label="Agent 预设"]')]
        .find(node => node instanceof HTMLElement && node.checkVisibility())
      const buttons = [...(group?.querySelectorAll('button') ?? [])]
      if (buttons.length > 0 && buttons.every(button => button instanceof HTMLButtonElement && button.disabled)) {
        const { items } = await window.dshDesktop.host.call('listSessions', {})
        return items.length === ${String(expectedSessionCount)}
          && document.querySelector('.session-row[aria-current="page"]')?.dataset.sessionId === ${JSON.stringify(sessionId)}
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return false
  })()`
}

/** 验证待办清单默认以摘要折叠态呈现在输入框上方。 */
export const TODO_CARD_INITIAL_COLLAPSED_PROBE = `(async () => {
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

/** 验证待办清单展开后的内部滚动、悬浮提示与输入区对齐。 */
export const TODO_CARD_EXPANDED_LAYOUT_PROBE = `(async () => {
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

/** 验证重新收起待办卡片后居中对齐且翻转箭头方向。 */
export const TODO_CARD_CENTERED_COLLAPSED_PROBE = `(async () => {
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

/** 构造验证底部会话读数 HUD 行高、间距与留白的探测脚本。 */
export function buildComposerReadingsHudLayoutProbe(expectedCardHeight: number): string {
  return `(async () => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const hud = document.querySelector('[data-composer-readings]')
      const card = document.querySelector('.composer-card')?.getBoundingClientRect()
      const island = document.querySelector('.main-island')?.getBoundingClientRect()
      if (hud && card && island) {
        const row = hud.getBoundingClientRect()
        if (hud.querySelectorAll('button').length === 3 && hud.textContent.includes('121K tok')
          && Math.abs(card.height - ${String(expectedCardHeight)}) < 1 && row.height === 24
          && Math.abs(row.top - card.bottom - 2) < 1 && Math.abs(island.bottom - row.bottom - 7) < 1
          && Math.abs(row.left + row.right - card.left - card.right) < 1 && hud.scrollWidth <= hud.clientWidth) return true
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return false
  })()`
}

/** 验证 HUD Token 用量浮层在按钮正上方展开。 */
export const HUD_TOKEN_USAGE_POPOVER_PROBE = `(async () => {
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

/** 验证右侧信息栏仅保留纯净图标标签且清空待办后不残留节点。 */
export const RIGHT_ISLAND_TABS_CLEAN_PROBE = `(async () => {
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

/** 构造验证待回答问题交互卡片选项、自定义输入与操作按钮的探测脚本。 */
export function buildPendingQuestionCardProbe(questionKey: string): string {
  return `(async () => {
    const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const card = document.querySelector('[data-question-key=' + ${JSON.stringify(JSON.stringify(questionKey))} + ']')
      const options = card?.querySelectorAll('[role="radio"]')
      const custom = card?.querySelector('textarea[placeholder="输入你的回答"]')
      const submit = [...(card?.querySelectorAll('button') ?? [])]
        .find(button => button.textContent?.includes('提交回答'))
      const skip = [...(card?.querySelectorAll('button') ?? [])]
        .find(button => button.textContent?.includes('跳过此题'))
      const close = card?.querySelector('button[aria-label="关闭问题"]')
      if (card instanceof HTMLElement
        && options?.length === 2
        && custom instanceof HTMLTextAreaElement
        && submit instanceof HTMLButtonElement
        && skip instanceof HTMLButtonElement
        && close instanceof HTMLButtonElement
        && card.textContent?.includes('推荐') === true) return true
      await sleep(25)
    }
    return false
  })()`
}

/** 构造验证待审批权限卡片紧凑高度与超长原因内部滚动的探测脚本。 */
export function buildPendingApprovalCardProbe(approvalKey: string): string {
  return `(async () => {
    const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const card = document.querySelector('[data-approval-key=' + ${JSON.stringify(JSON.stringify(approvalKey))} + ']')
      const buttons = [...(card?.querySelectorAll('button') ?? [])]
      const reject = buttons.find(button => button.textContent?.trim() === '拒绝')
      const allowOnce = buttons.find(button => button.textContent?.includes('允许一次'))
      if (card instanceof HTMLElement
        && reject instanceof HTMLButtonElement
        && allowOnce instanceof HTMLButtonElement
        && card.textContent?.includes('不会永久放宽会话权限') === true
        && !card.textContent?.includes('始终允许')) {
        const panel = card.closest('.pending-interaction-card')
        const reason = card.querySelector('h2')
        const body = reason.parentElement
        const compact = panel.getBoundingClientRect().height < 260
        const original = reason.textContent
        try {
          reason.textContent = original.repeat(160)
          return compact && body.scrollHeight > body.clientHeight
            && body.scrollWidth <= body.clientWidth + 1
            && panel.getBoundingClientRect().height <= 420
            && allowOnce.getBoundingClientRect().bottom <= panel.getBoundingClientRect().bottom
        } finally {
          reason.textContent = original
        }
      }
      await sleep(25)
    }
    return false
  })()`
}
