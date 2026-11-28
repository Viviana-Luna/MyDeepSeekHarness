/**
 * 设置中心全分页、归档恢复、无障碍降级、透明合成与多尺寸响应式验收套件：在渲染进程上下文执行的页面探测脚本集合（分片 1）。
 */

/** 浏览器端验收探测脚本（settings #1）。 */
export const SETTINGS_SCRIPT_1 = `(async () => {
        const inMotion = node =>
          typeof node.className === 'string'
          && /(?:^|\\s)ant-[^\\s]+-(?:appear|enter|leave)(?:-(?:prepare|start|active))?(?:\\s|$)/.test(node.className)
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const dialog = document.querySelector('.settings-dialog[role="dialog"]')
          if (dialog instanceof HTMLElement && !inMotion(dialog)) {
            await Promise.allSettled(
              dialog
                .getAnimations({ subtree: true })
                .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
                .map(animation => animation.finished),
            )
            const header = dialog.querySelector('.settings-dialog__header')
            const title = header?.querySelector('h1')
            const close = header?.querySelector('button[aria-label="关闭设置"]')
            const content = dialog.querySelector('.settings-content')
            const surface = dialog.querySelector('.mydsh-glass-dialog')
            const current = dialog.querySelector('.settings-nav__items .ant-menu-item-selected')
            if (header instanceof HTMLElement && title instanceof HTMLElement
              && close instanceof HTMLButtonElement && content instanceof HTMLElement
              && surface && current && getComputedStyle(surface).backdropFilter.includes('blur')
              && getComputedStyle(current).backgroundImage !== 'none') {
              const frame = header.getBoundingClientRect()
              const center = frame.top + frame.height / 2
              const controls = [title, ...header.querySelectorAll('button')]
              const ok = controls.every(control => {
                const rect = control.getBoundingClientRect()
                return Math.abs(rect.top + rect.height / 2 - center) <= 1
                  && rect.top >= frame.top + 11 && rect.bottom <= frame.bottom - 11
                  && rect.left >= frame.left + 12 && rect.right <= frame.right - 12
              }) && content.getBoundingClientRect().top >= frame.bottom
                && frame.top >= 0 && frame.right <= innerWidth
              if (ok) return true
            }
          }
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        return false
      })()`

/** 浏览器端验收探测脚本（settings #2）。 */
export const SETTINGS_SCRIPT_2 = `(() => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      return (async () => {
        const expectedNav = ['通用设置', '外观', '模型', 'Agent 预设', '已归档会话', '浏览器与桌面操控']
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const dialog = document.querySelector('.settings-dialog[role="dialog"]')
          const navigation = dialog?.querySelector('.settings-nav')
          const removedAppearanceControlsGone = dialog?.querySelector('.material-options') === null
            && dialog.querySelector('input[aria-label="侧栏浮岛透明度"]') === null
            && dialog.querySelector('input[aria-label="内容浮岛透明度"]') === null
            && dialog.querySelector('input[aria-label="画布透明度"]') === null
            && dialog.querySelector('[role="combobox"][aria-label="画布配色"]') === null
            && dialog.querySelector('input[aria-label="内容可读性遮罩"]') === null
            && dialog.querySelector('input[aria-label="浮岛间隙"]') === null
            && dialog.querySelector('.background-setting') === null
            && dialog.querySelector('input[type="range"]') === null
            && dialog.querySelector('.settings-switch') === null
          const navigationAutoHideRemoved = dialog?.querySelector('[role="switch"][aria-label="项目侧栏自动隐藏"]') === null
          const fontFamily = document.querySelector('[role="combobox"][aria-label="界面字体"]')
          const fontSize = document.querySelector('input[aria-label="界面字号"]')
          const fontSizeDec = document.querySelector('button[aria-label="减小界面字号"]')
          const fontSizeInc = document.querySelector('button[aria-label="增大界面字号"]')
          const capsulesSwitch = dialog?.querySelector('button[role="switch"][aria-label="缩放胶囊常驻"]')
          const automaticLayoutReady = document.querySelector('input[aria-label="对话内容宽度"]') === null
            && document.querySelector('input[aria-label="代码字号"]') === null
            && document.querySelector('[role="combobox"][aria-label="代码行高"]') === null
            && document.querySelector('[role="switch"][aria-label="代码连字"]') === null
          const accents = document.querySelectorAll('.accent-option')
          const accentValuePill = document.querySelector('.accent-value-pill')
          const accentShapesReady = [...accents].every(accent => {
            const rect = accent.getBoundingClientRect()
            const style = getComputedStyle(accent)
            return Math.abs(rect.width - 24) <= 0.5
              && Math.abs(rect.height - 24) <= 0.5
              && style.paddingLeft === '0px'
              && style.paddingRight === '0px'
              && style.borderRadius === '50%'
          })
          const rect = dialog instanceof HTMLElement ? dialog.getBoundingClientRect() : null
          const navButtons = [...(navigation?.querySelectorAll('.settings-nav__items > [role="menuitem"]') ?? [])]
          const navLabels = navButtons.map(button => button.textContent?.trim() ?? '')
          const navOrderReady = navLabels.length === expectedNav.length
            && expectedNav.every((label, index) => navLabels[index] === label)
            && !navLabels.includes('内置插件')
            && !navLabels.includes('ChatGPT 订阅')
          const content = dialog?.querySelector('.settings-content')
          const focusInside = dialog instanceof HTMLElement
            && document.activeElement instanceof HTMLElement
            && dialog.contains(document.activeElement)
          const panelFits = rect !== null
            && rect.left >= 0 && rect.top >= 0
            && rect.right <= innerWidth && rect.bottom <= innerHeight
            && content instanceof HTMLElement
            && content.scrollWidth <= content.clientWidth + 1
          const modal = dialog instanceof HTMLElement && dialog.getAttribute('aria-modal') === 'true'
          const appearanceIndex = navLabels.indexOf('外观')
          if (dialog instanceof HTMLElement && dialog.checkVisibility()
            && removedAppearanceControlsGone
            && navigationAutoHideRemoved
            && fontFamily instanceof HTMLInputElement && fontFamily.closest('.settings-select')?.textContent?.includes('系统字体') === true
            && dialog.querySelector('select') === null
            && fontSize instanceof HTMLInputElement && fontSize.getAttribute('role') === 'spinbutton' && fontSize.value === '12'
            && fontSizeDec instanceof HTMLButtonElement && fontSizeInc instanceof HTMLButtonElement
            && capsulesSwitch instanceof HTMLButtonElement && capsulesSwitch.classList.contains('ant-switch')
            && automaticLayoutReady
            && accents.length === 6 && accentShapesReady && accentValuePill instanceof HTMLElement
            && navOrderReady
            && (focusInside || attempt >= 95)) return {
              open: true,
              focusInside,
              panelFits,
              layerCount: dialog.querySelectorAll('.background-setting').length,
              navCount: navButtons.length,
              appearanceIndex,
              modal,
            }
          await sleep(25)
        }
        return { open: false, focusInside: false, panelFits: false, layerCount: -1, navCount: 0, appearanceIndex: -1, modal: false }
      })()
    })()`

/** 浏览器端验收探测脚本（settings #3）。 */
export const SETTINGS_SCRIPT_3 = `(async () => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const dialog = document.querySelector('.settings-dialog[role="dialog"]')
        const content = dialog?.querySelector('.settings-content')
        const provider = dialog?.querySelector('.settings-provider-summary')
        const sectionHeading = [...(dialog?.querySelectorAll('h3') ?? [])]
          .find(node => node.textContent?.trim() === '提供商')
        const emblem = provider?.querySelector('.models-provider-emblem')
        const colorImg = emblem?.querySelector('img.models-provider-emblem__img')
        const monoMask = emblem?.querySelector('.models-provider-emblem__mask')
        const logoReady =
          (colorImg instanceof HTMLImageElement && colorImg.complete && colorImg.naturalWidth > 0)
          || (monoMask instanceof HTMLElement && getComputedStyle(monoMask).maskImage !== 'none')
        if (provider instanceof HTMLButtonElement
          && provider.getAttribute('aria-expanded') === 'false'
          && sectionHeading instanceof HTMLElement
          && logoReady
          && dialog?.querySelector('.models-detail-view') === null
          && content instanceof HTMLElement
          && content.scrollWidth <= content.clientWidth + 1) return true
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return false
    })()`

/** 浏览器端验收探测脚本（settings #4）。 */
export const SETTINGS_SCRIPT_4 = `(async () => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const dialog = document.querySelector('.settings-dialog[role="dialog"]')
        const presetList = dialog?.querySelector('.settings-preset-list')
        const selectedPreset = dialog?.querySelector('.settings-preset-card[data-selected="true"]')
        const presetColumns = presetList instanceof HTMLElement
          ? getComputedStyle(presetList).gridTemplateColumns.split(' ').filter(Boolean).length
          : 0
        if (dialog instanceof HTMLElement
          && dialog.checkVisibility()
          && presetList instanceof HTMLElement
          && presetColumns === 2
          && selectedPreset instanceof HTMLElement
          && dialog.querySelector('[aria-label="新会话默认 Agent 预设"]') === null) return true
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return false
    })()`

const SETTINGS_PARTS_5 = [
  "\n      export const inject = ['sessions'];\n      export async function apply(ctx) {\n        const session = ctx.sessions.get(",
  ");\n        if (!session) throw new Error('缺少隔离验收会话');\n        session.append('turn/start', { turn: 0 });\n        session.append('user/message', { id: 'archive-verification-message', role: 'user',\n          content: [{ type: 'text', text: '归档恢复验收：保留这条历史消息。' }], source: { kind: 'user' } }, { surfaceOp: 'append' });\n        session.append('turn/end', { turn: 0, reason: { kind: 'completed' } });\n        await ctx.sessions.flush(session);\n      }\n    ",
] as const

/** 构造带参数的浏览器端验收探测脚本（settings #5）。 */
export function buildSettingsScript5(p0: unknown): string {
  return SETTINGS_PARTS_5[0]! + String(p0) + SETTINGS_PARTS_5[1]!
}

const SETTINGS_PARTS_6 = [
  "(async () => {\n      const host = window.dshDesktop.host\n      const { items } = await host.call('listSessions', {})\n      const workspaces = await host.call('listWorkspaces', {})\n      const session = items.find(item => item.sessionId === ",
  " && !item.blank && !item.running)\n      if (!session) throw new Error('缺少可恢复的隔离验收会话')\n      const sessionId = session.sessionId\n      const owner = workspaces.items.find(item => item.sessionIds.includes(sessionId))\n      const throughSeq = session.projections?.asOfSeq ?? 0\n      const history = await host.call('loadSessionPage', { sessionId, throughSeq, maxMessages: 25 })\n      if (!history.records?.some(record => record.event?.type === 'user/message')) throw new Error('归档验收会话缺少真实历史')\n      await host.call('archiveSession', { sessionId })\n      ;[...document.querySelectorAll('.settings-nav__items > [role=\"menuitem\"]')]\n        .find(item => item.textContent?.trim() === '已归档会话')?.click()\n      for (let attempt = 0; attempt < 80; attempt += 1) {\n        const row = document.querySelector('.settings-archive-list [data-session-id=' + JSON.stringify(sessionId) + ']')\n        const search = document.querySelector('input[aria-label=\"搜索已归档会话\"]')\n        if (row && search instanceof HTMLInputElement) {\n          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(search, owner?.title ?? '未分组')\n          search.dispatchEvent(new Event('input', { bubbles: true }))\n          let ready = false\n          for (let filterAttempt = 0; filterAttempt < 40; filterAttempt += 1) {\n            const content = document.querySelector('.settings-content')\n            ready = row.isConnected\n              && row.textContent.includes(owner?.title ?? '未分组')\n              && content instanceof HTMLElement\n              && content.scrollWidth <= content.clientWidth + 1\n              && document.querySelector('.session-row-shell[data-session-id=' + JSON.stringify(sessionId) + ']') === null\n            if (ready) break\n            await new Promise(resolve => setTimeout(resolve, 25))\n          }\n          return { sessionId, throughSeq, history, ownerId: owner?.workspaceId, ready }\n        }\n        await new Promise(resolve => setTimeout(resolve, 25))\n      }\n      throw new Error('已归档会话未出现在设置页')\n    })()",
] as const

/** 构造带参数的浏览器端验收探测脚本（settings #6）。 */
export function buildSettingsScript6(p0: unknown): string {
  return SETTINGS_PARTS_6[0]! + String(p0) + SETTINGS_PARTS_6[1]!
}

const SETTINGS_PARTS_7 = [
  '(async () => {\n      const fixture = ',
  "\n      const selector = '[data-session-id=' + JSON.stringify(fixture.sessionId) + ']'\n      document.querySelector('.settings-archive-list ' + selector + ' button')?.click()\n      for (let attempt = 0; attempt < 80; attempt += 1) {\n        if (document.querySelector('.settings-archive-list ' + selector) === null\n          && document.querySelector('.session-row-shell' + selector)) {\n          const workspaces = await window.dshDesktop.host.call('listWorkspaces', {})\n          const history = await window.dshDesktop.host.call('loadSessionPage', { sessionId: fixture.sessionId, throughSeq: fixture.throughSeq, maxMessages: 25 })\n          return !workspaces.archivedSessionIds.includes(fixture.sessionId)\n            && workspaces.items.find(item => item.workspaceId === fixture.ownerId)?.sessionIds.includes(fixture.sessionId)\n            && JSON.stringify(history) === JSON.stringify(fixture.history)\n        }\n        await new Promise(resolve => setTimeout(resolve, 25))\n      }\n      return false\n    })()",
] as const

/** 构造带参数的浏览器端验收探测脚本（settings #7）。 */
export function buildSettingsScript7(p0: unknown): string {
  return SETTINGS_PARTS_7[0]! + String(p0) + SETTINGS_PARTS_7[1]!
}

const SETTINGS_PARTS_8 = [
  "\n      export const inject = ['agents', 'sessions', 'sessionController', 'workspaceRegistry'];\n      export async function apply(ctx) {\n        const message = (text, source = { kind: 'user' }) => ({ id: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text }], source });\n        const id = ",
  ";\n        const found = await ctx.sessionController.resolveAgent(id);\n        if ('error' in found) throw found.error;\n        const agent = found.agent;\n        const entered = Promise.withResolvers();\n        let aborted = false;\n        const unhook = agent.ctx.on('agent/pre-step', ({ signal }) => new Promise(resolve => {\n          entered.resolve();\n          const stop = () => { aborted = true; resolve({ kind: 'reject' }) };\n          if (signal.aborted) stop();\n          else signal.addEventListener('abort', stop, { once: true });\n        }));\n        let timer;\n        try {\n          agent.followup(message('运行中的归档验收'));\n          await Promise.race([entered.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('验收任务没有开始')), 5000) })]);\n          if (agent.status !== 'running') throw new Error('验收任务未处于运行中');\n          agent.followup(message('归档后不能继续的排队消息'));\n          await ctx.sessionController.archiveSession(id);\n          if (!aborted || ctx.agents.get(id) || ctx.sessions.get(id) || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) {\n            throw new Error('归档未停止运行、清空队列或释放写句柄');\n          }\n          if (!('error' in await ctx.sessionController.resolveAgent(id))) throw new Error('归档会话被重新激活');\n        } finally {\n          clearTimeout(timer); unhook();\n          if (ctx.agents.get(id) === agent) { agent.cancel({ kind: 'user' }); await agent.whenIdle() }\n        }\n        await ctx.workspaceRegistry.unarchiveSession(id);\n        const restored = await ctx.sessionController.resolveAgent(id);\n        if ('error' in restored) throw restored.error;\n        if (restored.agent.inbox.nextTurn.length || restored.agent.inbox.nextStep.length) throw new Error('恢复后重新执行了归档前的队列');\n        restored.agent.inject(message('旧归档中的权限变化通知', { kind: 'plugin', plugin: 'permissions' }));\n        await ctx.workspaceRegistry.archiveSession(id);\n      }\n    ",
] as const

/** 构造带参数的浏览器端验收探测脚本（settings #8）。 */
export function buildSettingsScript8(p0: unknown): string {
  return SETTINGS_PARTS_8[0]! + String(p0) + SETTINGS_PARTS_8[1]!
}

const SETTINGS_PARTS_9 = [
  '(async () => {\n      const fixture = ',
  "\n      const host = window.dshDesktop.host\n      const selector = '.settings-archive-list [data-session-id=' + JSON.stringify(fixture.sessionId) + ']'\n      const waitFor = async predicate => {\n        for (let i = 0; i < 100; i += 1) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)) }\n        throw new Error('永久删除界面没有到达预期状态')\n      }\n      const history = await host.call('loadSessionPage', { sessionId: fixture.sessionId, throughSeq: fixture.throughSeq, maxMessages: 25 })\n      if (JSON.stringify(history) !== JSON.stringify(fixture.history)) throw new Error('归档恢复后历史改变')\n      await waitFor(() => document.querySelector(selector + ' button[aria-label^=\"永久删除会话:\"]'))\n      document.querySelector(selector + ' button[aria-label^=\"永久删除会话:\"]').click()\n      const confirmation = () => [...document.querySelectorAll('[role=\"dialog\"]')].find(dialog => dialog.checkVisibility() && dialog.textContent.includes('永久删除会话？'))\n      await waitFor(confirmation)\n      ;[...confirmation().querySelectorAll('button')].find(button => button.textContent.replaceAll(' ', '') === '取消').click()\n      await waitFor(() => !confirmation())\n      if (!(await host.call('listWorkspaces', {})).archivedSessionIds.includes(fixture.sessionId)) throw new Error('取消确认意外删除了会话')\n      document.querySelector(selector + ' button[aria-label^=\"永久删除会话:\"]').click()\n      await waitFor(confirmation)\n      const rect = confirmation().getBoundingClientRect()\n      return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight\n        && confirmation().querySelector('.ant-btn-dangerous') !== null\n    })()",
] as const

/** 构造带参数的浏览器端验收探测脚本（settings #9）。 */
export function buildSettingsScript9(p0: unknown): string {
  return SETTINGS_PARTS_9[0]! + String(p0) + SETTINGS_PARTS_9[1]!
}

const SETTINGS_PARTS_10 = [
  '(async () => {\n      const fixture = ',
  "\n      const host = window.dshDesktop.host\n      const selector = '.settings-archive-list [data-session-id=' + JSON.stringify(fixture.sessionId) + ']'\n      const waitFor = async predicate => {\n        for (let i = 0; i < 100; i += 1) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)) }\n        throw new Error('永久删除没有完成')\n      }\n      const confirmation = () => [...document.querySelectorAll('[role=\"dialog\"]')].find(dialog => dialog.checkVisibility() && dialog.textContent.includes('永久删除会话？'))\n      ;[...confirmation().querySelectorAll('button')].find(button => button.textContent === '永久删除').click()\n      await waitFor(() => !confirmation() && !document.querySelector(selector))\n      document.querySelector('button[aria-label=\"刷新已归档会话\"]').click()\n      const workspaces = await host.call('listWorkspaces', {})\n      const sessions = await host.call('listSessions', {})\n      let missing = false\n      try { await host.call('loadSessionPage', { sessionId: fixture.sessionId, throughSeq: fixture.throughSeq, maxMessages: 25 }) }\n      catch { missing = true }\n      return missing && !workspaces.archivedSessionIds.includes(fixture.sessionId)\n        && workspaces.items.every(item => !item.sessionIds.includes(fixture.sessionId))\n        && !sessions.items.some(item => item.sessionId === fixture.sessionId)\n    })()",
] as const

/** 构造带参数的浏览器端验收探测脚本（settings #10）。 */
export function buildSettingsScript10(p0: unknown): string {
  return SETTINGS_PARTS_10[0]! + String(p0) + SETTINGS_PARTS_10[1]!
}

/** 浏览器端验收探测脚本（settings #11）。 */
export const SETTINGS_SCRIPT_11 = `(async () => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const page = document.querySelector('.settings-dialog [data-automation-settings]')
        const content = document.querySelector('.settings-dialog .settings-content')
        const embeddedSwitch = page?.querySelector('button[role="switch"][aria-label="允许 Agent 操控内置浏览器"]')
        const permissionItems = page?.querySelectorAll('[aria-label="系统权限状态清单"] .automation-permission-item') ?? []
        if (page instanceof HTMLElement && page.checkVisibility()
          && content instanceof HTMLElement
          && embeddedSwitch instanceof HTMLButtonElement
          && !embeddedSwitch.disabled
          && permissionItems.length === 3) {
          return content.scrollWidth <= content.clientWidth + 1
            && page.scrollWidth <= page.clientWidth + 1
            && [...permissionItems].every(item => item instanceof HTMLElement && item.checkVisibility())
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return false
    })()`

/** 浏览器端验收探测脚本（settings #12）。 */
export const SETTINGS_SCRIPT_12 = `(async () => {
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const page = document.querySelector('.settings-dialog [data-automation-settings]')
          const content = document.querySelector('.settings-dialog .settings-content')
          const embeddedSwitch = page?.querySelector('button[role="switch"][aria-label="允许 Agent 操控内置浏览器"]')
          const originInputs = page?.querySelectorAll('.automation-origin-input-row input') ?? []
          if (page instanceof HTMLElement && content instanceof HTMLElement
            && embeddedSwitch instanceof HTMLButtonElement
            && embeddedSwitch.getAttribute('aria-checked') === 'true'
            && !embeddedSwitch.disabled
            && originInputs.length >= 2) {
            return content.scrollWidth <= content.clientWidth + 1
              && page.scrollWidth <= page.clientWidth + 1
              && [...originInputs].every(input => input instanceof HTMLElement && input.checkVisibility())
          }
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        return false
      })()`

/** 浏览器端验收探测脚本（settings #13）。 */
export const SETTINGS_SCRIPT_13 = `(async () => {
          for (let attempt = 0; attempt < 80; attempt += 1) {
            const page = document.querySelector('.settings-dialog [data-automation-settings]')
            const embeddedSwitch = page?.querySelector('button[role="switch"][aria-label="允许 Agent 操控内置浏览器"]')
            if (embeddedSwitch instanceof HTMLButtonElement
              && embeddedSwitch.getAttribute('aria-checked') === 'false'
              && !embeddedSwitch.disabled
              && (page?.querySelectorAll('.automation-origin-input-row input').length ?? 0) === 0) {
              return true
            }
            await new Promise(resolve => setTimeout(resolve, 25))
          }
          return false
        })()`

/** 浏览器端验收探测脚本（settings #14）。 */
export const SETTINGS_SCRIPT_14 = `(async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const dialog = document.querySelector('.settings-dialog[role="dialog"]')
        const closed = dialog === null || (dialog instanceof HTMLElement && !dialog.checkVisibility())
        if (closed && document.activeElement instanceof HTMLElement && document.activeElement.id === 'open-settings') {
          return true
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return false
    })()`

/** 浏览器端验收探测脚本（settings #15）。 */
export const SETTINGS_SCRIPT_15 = `(async () => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const page = document.querySelector('.plugin-manager--standalone')
        const builtinCards = page?.querySelectorAll('[aria-label="内置插件"] .plugin-manager__row') ?? []
        const terminalButton = page?.querySelector('[aria-label="配置 终端"]')
        const chatgptButton = page?.querySelector('[aria-label="配置 ChatGPT 订阅"]')
        const extraGroup = page?.querySelector('[aria-label="扩展配置"]')
        const extraText = extraGroup?.textContent ?? ''
        if (page instanceof HTMLElement && page.checkVisibility()
          && builtinCards.length === 5
          && terminalButton instanceof HTMLButtonElement
          && chatgptButton instanceof HTMLButtonElement) {
          return !extraText.includes('浏览器与桌面操控') && !extraText.includes('ChatGPT 订阅')
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return false
    })()`

/** 浏览器端验收探测脚本（settings #16）。 */
export const SETTINGS_SCRIPT_16 = `(async () => {
      const host = window.dshDesktop.host
      const document = await host.call('describeSettings', {})
      const namespace = document.namespaces.find(item => item.ns === 'shell')
      if (!namespace || typeof namespace.value.timeoutMs !== 'number') return false
      const summary = window.document.querySelector('.plugin-manager--standalone [aria-label="配置 终端"]')
      if (!(summary instanceof HTMLButtonElement)) return false
      summary.click()
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (window.document.getElementById('plugin-shell-timeoutMs') instanceof HTMLInputElement) break
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      const next = namespace.value.timeoutMs + 1
      try {
        await host.call('mutateSettings', { ns: 'shell', expectedRevision: namespace.revision,
          ops: [{ op: 'set', path: ['timeoutMs'], value: next }] })
        for (let attempt = 0; attempt < 80; attempt += 1) {
          if (window.document.getElementById('plugin-shell-timeoutMs')?.value === String(next)) return true
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        return false
      } finally {
        await host.call('mutateSettings', { ns: 'shell', ops: [Object.hasOwn(namespace.user ?? {}, 'timeoutMs')
          ? { op: 'set', path: ['timeoutMs'], value: namespace.user.timeoutMs }
          : { op: 'unset', path: ['timeoutMs'] }] })
        window.document.querySelector('.plugin-manager__back')?.click()
      }
    })()`

/** 浏览器端验收探测脚本（settings #17）。 */
export const SETTINGS_SCRIPT_17 = `(async () => {
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      document.querySelector('[data-view="files"]')?.click()
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const editor = document.querySelector('.code-editor .cm-editor')
        const scroller = editor?.querySelector('.cm-scroller')
        if (editor instanceof HTMLElement && scroller instanceof HTMLElement) {
          globalThis.__mydshVerifyEditor = editor
          const style = getComputedStyle(scroller)
          return document.documentElement.style.getPropertyValue('--code-editor-font-size') === ''
            && document.documentElement.style.getPropertyValue('--code-editor-line-height') === ''
            && document.documentElement.style.getPropertyValue('--code-editor-font-ligatures') === ''
            && style.fontSize === '14px'
            && Math.abs(Number.parseFloat(style.lineHeight) - 22) <= 0.5
            && style.fontVariantLigatures === 'normal'
        }
        await sleep(25)
      }
      return false
    })()`

/** 浏览器端验收探测脚本（settings #18）。 */
export const SETTINGS_SCRIPT_18 = `(async () => {
      const editor = document.querySelector('.code-editor .cm-editor')
      const scroller = editor?.querySelector('.cm-scroller')
      const sameEditor = globalThis.__mydshVerifyEditor === editor
      Reflect.deleteProperty(globalThis, '__mydshVerifyEditor')
      document.querySelector('[data-view="conversation"]')?.click()
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (document.querySelector('[data-view="conversation"][aria-current="page"]') !== null
          && document.querySelector('.main-island .composer-card') instanceof HTMLElement) break
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      if (!(scroller instanceof HTMLElement)) return false
      const style = getComputedStyle(scroller)
      return sameEditor
        && document.documentElement.style.getPropertyValue('--code-editor-font-size') === ''
        && document.documentElement.style.getPropertyValue('--code-editor-line-height') === ''
        && document.documentElement.style.getPropertyValue('--code-editor-font-ligatures') === ''
        && style.fontSize === '14px'
        && Math.abs(Number.parseFloat(style.lineHeight) - 22) <= 0.5
        && style.fontVariantLigatures === 'normal'
    })()`

/** 浏览器端验收探测脚本（settings #19）。 */
export const SETTINGS_SCRIPT_19 = `(async () => {
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

/** 浏览器端验收探测脚本（settings #20）。 */
export const SETTINGS_SCRIPT_20 = `(async () => {
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

/** 浏览器端验收探测脚本（settings #21）。 */
export const SETTINGS_SCRIPT_21 = `(async () => {
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

/** 浏览器端验收探测脚本（settings #22）。 */
export const SETTINGS_SCRIPT_22 = `(async () => {
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

/** 浏览器端验收探测脚本（settings #23）。 */
export const SETTINGS_SCRIPT_23 = `(async () => {
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
