/**
 * 设置中心各分类页面、会话归档恢复与永久删除、内置插件配置与编辑器旧字段兼容的探测脚本。
 */

/** 验证设置对话框顶栏标题与关闭按钮垂直居中对齐、无毛玻璃模糊且不溢出。 */
export const SETTINGS_HEADER_ALIGNMENT_PROBE = `(async () => {
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
        && surface && current
        && getComputedStyle(surface).backdropFilter === 'none'
        && getComputedStyle(surface).backgroundColor !== 'rgba(0, 0, 0, 0)'
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

/** 验证外观设置页左侧 6 项导航顺序、控件精简与焦点锁定。 */
export const APPEARANCE_SETTINGS_PAGE_PROBE = `(() => {
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
        && (focusInside || attempt >= 95)) {
        return {
          open: true,
          focusInside,
          panelFits,
          layerCount: dialog.querySelectorAll('.background-setting').length,
          navCount: navButtons.length,
          appearanceIndex,
          modal,
        }
      }
      await sleep(25)
    }
    return { open: false, focusInside: false, panelFits: false, layerCount: -1, navCount: 0, appearanceIndex: -1, modal: false }
  })()
})()`

/** 验证模型设置页提供商徽标、默认折叠摘要卡片与内容宽度。 */
export const MODELS_SETTINGS_PAGE_PROBE = `(async () => {
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

/** 验证 Agent 预设设置页双列网格布局。 */
export const AGENT_PRESETS_SETTINGS_PAGE_PROBE = `(async () => {
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

/** 构造为归档验收会话注入真实落盘历史的临时后端扩展源码。 */
export function buildArchiveHistorySeedPluginSource(sessionId: string): string {
  return `
    export const inject = ['sessions'];
    export async function apply(ctx) {
      const session = ctx.sessions.get(${JSON.stringify(sessionId)});
      if (!session) throw new Error('缺少隔离验收会话');
      session.append('turn/start', { turn: 0 });
      session.append('user/message', { id: 'archive-verification-message', role: 'user',
        content: [{ type: 'text', text: '归档恢复验收：保留这条历史消息。' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
      session.append('turn/end', { turn: 0, reason: { kind: 'completed' } });
      await ctx.sessions.flush(session);
    }
  `
}

/** 构造归档指定会话并在设置中心「已归档会话」页按所属项目筛选校验的探测脚本。 */
export function buildArchiveAndFilterSessionProbe(sessionId: string): string {
  return `(async () => {
    const host = window.dshDesktop.host
    const { items } = await host.call('listSessions', {})
    const workspaces = await host.call('listWorkspaces', {})
    const session = items.find(item => item.sessionId === ${JSON.stringify(sessionId)} && !item.blank && !item.running)
    if (!session) throw new Error('缺少可恢复的隔离验收会话')
    const sessionId = session.sessionId
    const owner = workspaces.items.find(item => item.sessionIds.includes(sessionId))
    const throughSeq = session.projections?.asOfSeq ?? 0
    const history = await host.call('loadSessionPage', { sessionId, throughSeq, maxMessages: 25 })
    if (!history.records?.some(record => record.event?.type === 'user/message')) throw new Error('归档验收会话缺少真实历史')
    await host.call('archiveSession', { sessionId })
    ;[...document.querySelectorAll('.settings-nav__items > [role="menuitem"]')]
      .find(item => item.textContent?.trim() === '已归档会话')?.click()
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const row = document.querySelector('.settings-archive-list [data-session-id=' + JSON.stringify(sessionId) + ']')
      const search = document.querySelector('input[aria-label="搜索已归档会话"]')
      if (row && search instanceof HTMLInputElement) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(search, owner?.title ?? '未分组')
        search.dispatchEvent(new Event('input', { bubbles: true }))
        let ready = false
        for (let filterAttempt = 0; filterAttempt < 40; filterAttempt += 1) {
          const content = document.querySelector('.settings-content')
          ready = row.isConnected
            && row.textContent.includes(owner?.title ?? '未分组')
            && content instanceof HTMLElement
            && content.scrollWidth <= content.clientWidth + 1
            && document.querySelector('.session-row-shell[data-session-id=' + JSON.stringify(sessionId) + ']') === null
          if (ready) break
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        return { sessionId, throughSeq, history, ownerId: owner?.workspaceId, ready }
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error('已归档会话未出现在设置页')
  })()`
}

/** 构造在已归档列表中点击恢复并验证历史无损归位的探测脚本。 */
export function buildRestoreArchivedSessionProbe(fixture: unknown): string {
  return `(async () => {
    const fixture = ${JSON.stringify(fixture)}
    const selector = '[data-session-id=' + JSON.stringify(fixture.sessionId) + ']'
    document.querySelector('.settings-archive-list ' + selector + ' button')?.click()
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (document.querySelector('.settings-archive-list ' + selector) === null
        && document.querySelector('.session-row-shell' + selector)) {
        const workspaces = await window.dshDesktop.host.call('listWorkspaces', {})
        const history = await window.dshDesktop.host.call('loadSessionPage', { sessionId: fixture.sessionId, throughSeq: fixture.throughSeq, maxMessages: 25 })
        return !workspaces.archivedSessionIds.includes(fixture.sessionId)
          && workspaces.items.find(item => item.workspaceId === fixture.ownerId)?.sessionIds.includes(fixture.sessionId)
          && JSON.stringify(history) === JSON.stringify(fixture.history)
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return false
  })()`
}

/** 构造验证运行中归档立即中止 Agent 并清空队列的临时后端扩展源码。 */
export function buildRunningSessionArchiveGuardPluginSource(sessionId: string): string {
  return `
    export const inject = ['agents', 'sessions', 'sessionController', 'workspaceRegistry'];
    export async function apply(ctx) {
      const message = (text, source = { kind: 'user' }) => ({ id: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text }], source });
      const id = ${JSON.stringify(sessionId)};
      const found = await ctx.sessionController.resolveAgent(id);
      if ('error' in found) throw found.error;
      const agent = found.agent;
      const entered = Promise.withResolvers();
      let aborted = false;
      const unhook = agent.ctx.on('agent/pre-step', ({ signal }) => new Promise(resolve => {
        entered.resolve();
        const stop = () => { aborted = true; resolve({ kind: 'reject' }) };
        if (signal.aborted) stop();
        else signal.addEventListener('abort', stop, { once: true });
      }));
      let timer;
      try {
        agent.followup(message('运行中的归档验收'));
        await Promise.race([entered.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('验收任务没有开始')), 5000) })]);
        if (agent.status !== 'running') throw new Error('验收任务未处于运行中');
        agent.followup(message('归档后不能继续的排队消息'));
        await ctx.sessionController.archiveSession(id);
        if (!aborted || ctx.agents.get(id) || ctx.sessions.get(id) || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) {
          throw new Error('归档未停止运行、清空队列或释放写句柄');
        }
        if (!('error' in await ctx.sessionController.resolveAgent(id))) throw new Error('归档会话被重新激活');
      } finally {
        clearTimeout(timer); unhook();
        if (ctx.agents.get(id) === agent) { agent.cancel({ kind: 'user' }); await agent.whenIdle() }
      }
      await ctx.workspaceRegistry.unarchiveSession(id);
      const restored = await ctx.sessionController.resolveAgent(id);
      if ('error' in restored) throw restored.error;
      if (restored.agent.inbox.nextTurn.length || restored.agent.inbox.nextStep.length) throw new Error('恢复后重新执行了归档前的队列');
      restored.agent.inject(message('旧归档中的权限变化通知', { kind: 'plugin', plugin: 'permissions' }));
      await ctx.workspaceRegistry.archiveSession(id);
    }
  `
}

/** 构造测试取消永久删除后再重新打开危险确认弹窗的探测脚本。 */
export function buildCancelAndReopenPermanentDeleteProbe(fixture: unknown): string {
  return `(async () => {
    const fixture = ${JSON.stringify(fixture)}
    const host = window.dshDesktop.host
    const selector = '.settings-archive-list [data-session-id=' + JSON.stringify(fixture.sessionId) + ']'
    const waitFor = async predicate => {
      for (let i = 0; i < 100; i += 1) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)) }
      throw new Error('永久删除界面没有到达预期状态')
    }
    const history = await host.call('loadSessionPage', { sessionId: fixture.sessionId, throughSeq: fixture.throughSeq, maxMessages: 25 })
    if (JSON.stringify(history) !== JSON.stringify(fixture.history)) throw new Error('归档恢复后历史改变')
    await waitFor(() => document.querySelector(selector + ' button[aria-label^="永久删除会话:"]'))
    document.querySelector(selector + ' button[aria-label^="永久删除会话:"]').click()
    const confirmation = () => [...document.querySelectorAll('[role="dialog"]')].find(dialog => dialog.checkVisibility() && dialog.textContent.includes('永久删除会话？'))
    await waitFor(confirmation)
    ;[...confirmation().querySelectorAll('button')].find(button => button.textContent.replaceAll(' ', '') === '取消').click()
    await waitFor(() => !confirmation())
    if (!(await host.call('listWorkspaces', {})).archivedSessionIds.includes(fixture.sessionId)) throw new Error('取消确认意外删除了会话')
    document.querySelector(selector + ' button[aria-label^="永久删除会话:"]').click()
    await waitFor(confirmation)
    const rect = confirmation().getBoundingClientRect()
    return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
      && confirmation().querySelector('.ant-btn-dangerous') !== null
  })()`
}

/** 构造确认永久删除归档会话并核对索引与文件彻底清理的探测脚本。 */
export function buildConfirmPermanentDeleteProbe(fixture: unknown): string {
  return `(async () => {
    const fixture = ${JSON.stringify(fixture)}
    const host = window.dshDesktop.host
    const selector = '.settings-archive-list [data-session-id=' + JSON.stringify(fixture.sessionId) + ']'
    const waitFor = async predicate => {
      for (let i = 0; i < 100; i += 1) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)) }
      throw new Error('永久删除没有完成')
    }
    const confirmation = () => [...document.querySelectorAll('[role="dialog"]')].find(dialog => dialog.checkVisibility() && dialog.textContent.includes('永久删除会话？'))
    ;[...confirmation().querySelectorAll('button')].find(button => button.textContent === '永久删除').click()
    await waitFor(() => !confirmation() && !document.querySelector(selector))
    document.querySelector('button[aria-label="刷新已归档会话"]').click()
    const workspaces = await host.call('listWorkspaces', {})
    const sessions = await host.call('listSessions', {})
    let missing = false
    try { await host.call('loadSessionPage', { sessionId: fixture.sessionId, throughSeq: fixture.throughSeq, maxMessages: 25 }) }
    catch { missing = true }
    return missing && !workspaces.archivedSessionIds.includes(fixture.sessionId)
      && workspaces.items.every(item => !item.sessionIds.includes(fixture.sessionId))
      && !sessions.items.some(item => item.sessionId === fixture.sessionId)
  })()`
}

/** 验证浏览器与桌面操控设置页默认状态及三项权限清单。 */
export const AUTOMATION_SETTINGS_DEFAULT_PROBE = `(async () => {
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

/** 验证开启内置浏览器操控开关后显示来源白名单输入框。 */
export const AUTOMATION_SETTINGS_EXPANDED_PROBE = `(async () => {
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

/** 验证关闭内置浏览器操控开关后收起白名单输入框。 */
export const AUTOMATION_SETTINGS_RESTORED_PROBE = `(async () => {
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

/** 验证按 Esc 关闭设置对话框后焦点准确归还侧栏设置按钮。 */
export const SETTINGS_FOCUS_RESTORED_PROBE = `(async () => {
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

/** 验证独立插件管理页展示 5 张内置插件配置卡片。 */
export const STANDALONE_PLUGIN_MANAGER_PROBE = `(async () => {
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

/** 验证修改 Host `shell.timeoutMs` 设置能够通过 `$events` 实时刷新到配置表单。 */
export const HOST_SETTINGS_LIVE_MUTATION_PROBE = `(async () => {
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

/** 验证旧版编辑器外观字段不会覆盖固定的 14px / 22px 代码区域排版。 */
export const EDITOR_FIXED_TYPOGRAPHY_APPLIED_PROBE = `(async () => {
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

/** 验证恢复编辑器旧字段后同一编辑器实例保持存活并切回对话视图。 */
export const EDITOR_FIXED_TYPOGRAPHY_RESTORED_PROBE = `(async () => {
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
