/**
 * 输入区命令与 Skill 候选面板、文件引用、图片拖放粘贴及斜杠命令执行的渲染进程探测脚本。
 */

/** 验证命令与 Skill 面板搜索、Plan 模式切换及草稿保留。 */
export const COMMAND_AND_SKILL_PALETTE_PROBE = `(async () => {
  const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
  const wait = async predicate => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (predicate()) return true
      await sleep(25)
    }
    return false
  }
  await wait(() => document.querySelector('#composer') !== null)
  const composer = document.querySelector('#composer')
  if (!(composer instanceof HTMLTextAreaElement)) return { ready: false, reason: '缺少输入框' }
  const write = (element, value) => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value)
    element.setSelectionRange(value.length, value.length)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const palette = () => document.querySelector('[role="dialog"][aria-label="命令与 Skill"]')
  const list = () => document.querySelector('#composer-command-listbox')
  const search = () => palette()?.querySelector('input')
  composer.focus()
  write(composer, '/')
  await wait(() => list()?.querySelectorAll('[role="option"]').length === 2)
  const portal = palette()?.parentElement === document.body
  const ariaReady = composer.getAttribute('aria-controls') === 'composer-command-listbox'
    && composer.getAttribute('aria-activedescendant') !== null
  document.getElementById('命令候选-category:command')?.click()
  await wait(() => list()?.querySelectorAll('[role="option"]').length > 2)
  const optionCount = list()?.querySelectorAll('[role="option"]').length ?? 0
  const bounds = palette()?.getBoundingClientRect()
  const bounded = bounds !== undefined && bounds.top >= 12 && bounds.bottom < composer.getBoundingClientRect().top
    && bounds.width <= 421 && bounds.height <= 361
  write(search(), 'compact')
  await wait(() => list()?.querySelectorAll('[role="option"]').length === 1)
  const filtered = list()?.textContent.includes('compact') === true
  list()?.querySelector('[role="option"]')?.click()
  await wait(() => composer.value === '/compact ')
  const draft = '请先检查现有实现，再修复输入面板；保留这段尚未发送的正文。'
  write(composer, draft)
  await sleep(25)
  document.querySelector('[aria-label="打开命令与 Skill"]')?.click()
  await wait(() => document.getElementById('命令候选-category:skill') !== null)
  document.getElementById('命令候选-category:skill')?.click()
  await wait(() => list()?.querySelector('[id^="命令候选-skill:"]') instanceof HTMLElement)
  const skillCount = list()?.querySelectorAll('[role="option"]').length ?? 0
  list()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
  const scrollable = await wait(() => {
    const currentList = list()
    const selected = currentList?.querySelector('[aria-selected="true"]')?.getBoundingClientRect()
    const listBounds = currentList?.getBoundingClientRect()
    return currentList !== null
      && listBounds !== undefined
      && currentList.scrollHeight > currentList.clientHeight
      && currentList.scrollTop > 0
      && selected !== undefined
      && selected.bottom <= listBounds.bottom + 1
  })
  if (!list() || !list()?.getBoundingClientRect()) return { ready: false, reason: 'Skill 面板没有打开', skillCount, optionCount }
  const skill = list()?.querySelector('[id^="命令候选-skill:"]:not(:disabled)')
  const skillName = skill?.querySelector('strong')?.textContent
  if (!skillName) return { ready: false, reason: 'Skill 目录为空' }
  write(search(), skillName)
  await wait(() => list()?.querySelectorAll('[role="option"]').length === 1)
  search()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  const preserved = await wait(() => composer.value === skillName + ' ' + draft && palette() === null)
  const findOpenModeMenu = () => {
    const menu = document.querySelector('[role="menu"][aria-label="工作模式"]')
    return menu instanceof HTMLElement
      && !menu.hasAttribute('inert')
      && menu.dataset.menuMotion === 'open'
      && menu.checkVisibility()
      ? menu
      : null
  }
  const modeTrigger = document.querySelector('[aria-label="切换工作模式"]')
  if (modeTrigger instanceof HTMLButtonElement && !modeTrigger.disabled) modeTrigger.click()
  const planModeReady = await wait(() => {
    const menu = findOpenModeMenu()
    const button = [...(menu?.querySelectorAll('[role="menuitemradio"]') ?? [])]
      .find(item => item.textContent?.trim() === 'Plan 模式')
    return button instanceof HTMLButtonElement && !button.disabled && button.checkVisibility()
  })
  if (planModeReady) {
    const menu = findOpenModeMenu()
    ;[...(menu?.querySelectorAll('[role="menuitemradio"]') ?? [])]
      .find(
        button =>
          button instanceof HTMLButtonElement
          && !button.disabled
          && button.textContent?.trim() === 'Plan 模式',
      )
      ?.click()
  }
  const planOn = await wait(() => {
    const chip = document.querySelector('[aria-label="退出 Plan 模式"]')
    return document.querySelector('[data-plan-active="true"]') !== null
      && document.querySelector('[role="menu"][aria-label="工作模式"]') === null
      && chip instanceof HTMLButtonElement
      && !chip.disabled
      && chip.checkVisibility()
  })
  const planChip = document.querySelector('[aria-label="退出 Plan 模式"]')
  const planPlaceholder = composer.placeholder === '描述你的任务以生成计划…'
  if (planChip instanceof HTMLButtonElement && !planChip.disabled) planChip.click()
  const planOff = await wait(() => document.querySelector('[data-plan-active="false"]') !== null
    && document.querySelector('[role="menu"][aria-label="工作模式"]') === null)
  const modePreservedDraft = composer.value === skillName + ' ' + draft
  write(composer, '')
  const closedAfterClear = await wait(() => palette() === null)
  return {
    ready: portal && ariaReady && bounded && scrollable && filtered && preserved && planOn && planOff && planPlaceholder && modePreservedDraft,
    portal,
    ariaReady,
    optionCount: optionCount + skillCount,
    bounded,
    scrollable,
    filtered,
    preserved,
    planOn,
    planOff,
    modePreservedDraft,
    closedAfterClear,
    bridgeVersion: globalThis.dshDesktop?.version ?? 0,
  }
})()`

/** 验证 `@` 文件引用面板挂载在 body Portal、命中项目文件并在清空后收起。 */
export const FILE_REFERENCE_PALETTE_PROBE = `(async () => {
  const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
  const composer = document.querySelector('#composer')
  if (!(composer instanceof HTMLTextAreaElement)) return { ready: false, reason: '缺少输入框' }
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  composer.focus()
  valueSetter?.call(composer, '@README')
  composer.setSelectionRange(7, 7)
  composer.dispatchEvent(new Event('input', { bubbles: true }))
  composer.dispatchEvent(new Event('select', { bubbles: true }))
  let ready = false
  let optionCount = 0
  let error = ''
  for (let index = 0; index < 100; index += 1) {
    await sleep(25)
    const palette = document.querySelector('[aria-label="文件引用面板"]')
    const listbox = document.querySelector('#composer-file-reference-listbox')
    const options = listbox === null ? [] : [...listbox.querySelectorAll('[role="option"]')]
    error = palette?.querySelector('[role="alert"]')?.textContent?.trim() ?? ''
    optionCount = options.length
    ready = palette instanceof HTMLElement
      && palette.parentElement === document.body
      && getComputedStyle(palette).position === 'fixed'
      && composer.getAttribute('aria-expanded') === 'true'
      && composer.getAttribute('aria-controls') === 'composer-file-reference-listbox'
      && composer.getAttribute('aria-activedescendant') !== null
      && options.some(option => option.textContent?.includes('README.md') === true)
    if (ready || error !== '') break
  }
  valueSetter?.call(composer, '')
  composer.setSelectionRange(0, 0)
  composer.dispatchEvent(new Event('input', { bubbles: true }))
  let closedAfterClear = false
  for (let index = 0; index < 40; index += 1) {
    if (document.querySelector('[aria-label="文件引用面板"]') === null) {
      closedAfterClear = true
      break
    }
    await sleep(25)
  }
  return { ready, optionCount, error, closedAfterClear }
})()`

/** 验证输入区 PNG 图片拖拽遮罩、缩略图渲染、移除与剪贴板粘贴草稿保留。 */
export const IMAGE_DROP_AND_PASTE_PROBE = `(async () => {
  const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
  const composer = document.querySelector('.composer-card')
  if (!(composer instanceof HTMLElement)) return { ready: false, error: '缺少输入区' }
  const canvas = document.createElement('canvas')
  canvas.width = 2
  canvas.height = 2
  const context = canvas.getContext('2d')
  if (context === null) return { ready: false, error: '无法创建验收图片画布' }
  context.fillStyle = '#5b6cff'
  context.fillRect(0, 0, 2, 2)
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
  if (!(blob instanceof Blob)) return { ready: false, error: '无法编码验收 PNG' }
  const transfer = new DataTransfer()
  transfer.items.add(new File([blob], '拖放验收.png', { type: 'image/png' }))
  const waitFor = async (predicate, attempts = 60) => {
    for (let index = 0; index < attempts; index += 1) {
      if (predicate()) return true
      await sleep(25)
    }
    return false
  }
  const dragEnterPrevented = !composer.dispatchEvent(new DragEvent('dragenter', {
    bubbles: true,
    cancelable: true,
    dataTransfer: transfer,
  }))
  const overlayVisible = await waitFor(() =>
    document.querySelector('.composer-drop-target')?.textContent?.trim()
      === '松开以附加文件或图片')
  const dropPrevented = !composer.dispatchEvent(new DragEvent('drop', {
    bubbles: true,
    cancelable: true,
    dataTransfer: transfer,
  }))
  let attachmentVisible = false
  let error = ''
  for (let index = 0; index < 100; index += 1) {
    await sleep(25)
    attachmentVisible = [...document.querySelectorAll('.composer-attachments li')]
      .some(item => {
        const preview = item.querySelector('img')
        return preview?.alt === '拖放验收.png'
          && preview instanceof HTMLImageElement && preview.complete && preview.naturalWidth === 2
      })
    error = document.querySelector('.app-alert--floating[role="alert"]')?.textContent?.trim() ?? ''
    if (attachmentVisible || error !== '') break
  }
  const remove = document.querySelector('.composer-attachments button')
  if (remove instanceof HTMLButtonElement) remove.click()
  const removed = await waitFor(() => ![...document.querySelectorAll('.composer-attachments li')]
    .some(item => item.querySelector('img')?.alt === '拖放验收.png'))
  const input = document.querySelector('#composer')
  const draft = '粘贴图片时保留正在编辑的正文'
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, draft)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await waitFor(() => input.value === draft)
  const clipboard = new DataTransfer()
  clipboard.items.add(new File([blob], '粘贴验收.png', { type: 'image/png' }))
  const pastePrevented = !input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }))
  let pasted = false
  for (let index = 0; index < 100; index += 1) {
    await sleep(25)
    const preview = document.querySelector('.composer-attachments img[alt="粘贴验收.png"]')
    if (preview?.complete && preview.naturalWidth === 2) { pasted = true; break }
  }
  const draftPreserved = input.value === draft
  const icons = document.querySelector('[aria-label="附加图片"] .lucide-paperclip') !== null
    && document.querySelector('[aria-label="打开命令与 Skill"] .lucide-terminal') !== null
    && document.querySelector('[aria-label="选择 Skill"]') === null
  document.querySelector('[aria-label="移除附件 粘贴验收.png"]')?.click()
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, '')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  const pasteRemoved = await waitFor(() => document.querySelector('.composer-attachments') === null)
  return {
    ready: dragEnterPrevented && dropPrevented && overlayVisible && attachmentVisible && removed && error === ''
      && pastePrevented && pasted && draftPreserved && icons && pasteRemoved,
    dragEnterPrevented,
    dropPrevented,
    overlayVisible,
    attachmentVisible,
    removed,
    pastePrevented,
    pasted,
    draftPreserved,
    icons,
    pasteRemoved,
    error,
  }
})()`

/** 验证在输入框提交 `/permission workspace-write` 真实斜杠命令并完成闭环。 */
export const SLASH_COMMAND_EXECUTION_PROBE = `(async () => {
  const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
  const composer = document.querySelector('#composer')
  if (!(composer instanceof HTMLTextAreaElement)) return { ready: false, error: '缺少输入框' }
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  const line = '/permission workspace-write'
  const previousRows = document.querySelectorAll('[data-command-name="permission"]').length
  composer.focus()
  valueSetter?.call(composer, line)
  composer.setSelectionRange(line.length, line.length)
  composer.dispatchEvent(new Event('input', { bubbles: true }))
  await Promise.race([
    new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    sleep(120),
  ])
  composer.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
  }))
  let stateText = ''
  let error = ''
  let completed = false
  for (let index = 0; index < 200; index += 1) {
    await sleep(25)
    const rows = document.querySelectorAll('[data-command-name="permission"]')
    const row = rows[rows.length - 1]
    stateText = row?.textContent?.trim() ?? ''
    completed = rows.length > previousRows && row?.getAttribute('data-state') === 'success'
    error = document.querySelector('.app-alert--floating[role="alert"]')?.textContent?.trim() ?? ''
    if ((completed && composer.value === '' && !document.querySelector('.composer-command-state')) || error !== '') break
  }
  return {
    ready: completed && error === '' && document.querySelector('.composer-command-state') === null,
    stateText,
    error,
    draftCleared: composer.value === '',
    paletteClosed: document.querySelector('[role="dialog"][aria-label="命令与 Skill"]') === null,
  }
})()`
