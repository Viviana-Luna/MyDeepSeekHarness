/**
 * 对话排版、思维链、文件链接、日志导出与插件管理验收套件：在渲染进程上下文执行的页面探测脚本集合。
 */

/** 浏览器端验收探测脚本（conversation #1）。 */
export const CONVERSATION_SCRIPT_1 = `(async () => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const view = document.querySelector('#conversation-view')
        const list = view?.querySelector('ol')
        const composer = document.querySelector('.composer-card')
        const sendButton = composer?.querySelector('.send-button, .stop-button')
        const modelLabel = composer?.querySelector('button[title^="模型："] > span')
        const heading = view?.querySelector('li > div > div > h1')
        const paragraph = heading?.parentElement?.querySelector('p')
        const think = view?.querySelector('[data-thinking-disclosure] summary')
        const rows = view?.querySelectorAll('[data-conversation-seq="0"] summary, [data-thinking-disclosure] summary, [data-tool-disclosure] summary')
        const intermediate = view?.querySelector('[data-conversation-seq="2"][data-message-status]')
        const intermediateText = intermediate?.querySelector('p')
        if (list && composer && sendButton && modelLabel instanceof HTMLElement && heading
          && paragraph && think && intermediateText && rows?.length === 4) {
          const body = parseFloat(getComputedStyle(paragraph).fontSize)
          const labelBounds = modelLabel.getBoundingClientRect()
          const textRange = document.createRange()
          textRange.selectNodeContents(modelLabel)
          const textBounds = textRange.getBoundingClientRect()
          return { width: list.getBoundingClientRect().width,
            modelNameVisible: modelLabel.checkVisibility() && labelBounds.width >= 60
              && textBounds.top >= labelBounds.top - 0.5 && textBounds.bottom <= labelBounds.bottom + 0.5,
            aligned: Math.abs(list.getBoundingClientRect().left - composer.getBoundingClientRect().left) < 1
              && Math.abs(list.getBoundingClientRect().right - composer.getBoundingClientRect().right) < 1
              && [heading, paragraph, intermediateText, ...rows].every(row => Math.abs(list.getBoundingClientRect().left - row.getBoundingClientRect().left) < 1)
              && getComputedStyle(paragraph).textAlign === 'left',
            spacing: getComputedStyle(list).rowGap === '16px' && !view.querySelector('li > header')
              && Math.abs(intermediateText.getBoundingClientRect().top - think.getBoundingClientRect().bottom - 16) < 1
              && [...view.querySelectorAll('time')].every(time => time.closest('[aria-label="消息操作"]')),
            processMetadataHidden: !intermediate.querySelector('[aria-label="消息操作"], time'),
            height: composer.getBoundingClientRect().height,
            circularSend: getComputedStyle(sendButton).borderRadius === '50%'
              && sendButton.getBoundingClientRect().width === sendButton.getBoundingClientRect().height,
            typography: parseFloat(getComputedStyle(heading).fontSize) === body + 3
              && parseFloat(getComputedStyle(think).fontSize) === body - 1,
            handleOpacity: getComputedStyle(document.querySelector('[aria-label="调整对话内容宽度（右侧）"]'), '::before').opacity }
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return null
    })()`

/** 浏览器端验收探测脚本（conversation #2）。 */
export const CONVERSATION_SCRIPT_2 = `(async () => {
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const menu = document.querySelector('.project-focus-menu')
          if (menu instanceof HTMLElement && menu.checkVisibility()) {
            await Promise.allSettled(
              menu.getAnimations({ subtree: true })
                .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
                .map(animation => animation.finished),
            )
            return
          }
          await new Promise(resolve => setTimeout(resolve, 25))
        }
      })()`

/** 浏览器端验收探测脚本（conversation #3）。 */
export const CONVERSATION_SCRIPT_3 = `(async () => {
      for (let attempt = 0; attempt < 40 && document.activeElement === document.body; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      const handle = document.querySelector('[aria-label="调整对话内容宽度（右侧）"]')
      if (handle instanceof HTMLElement) handle.focus()
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (handle instanceof HTMLElement && document.activeElement === handle) break
        if (handle instanceof HTMLElement) handle.focus()
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    })()`

const CONVERSATION_PARTS_4 = [
  '(async () => {\n      const targetWidth = ',
  "\n      for (let attempt = 0; attempt < 60; attempt += 1) {\n        const list = document.querySelector('#conversation-view ol')\n        const handle = document.querySelector('[aria-label=\"调整对话内容宽度（右侧）\"]')\n        if (\n          list &&\n          handle &&\n          list.getBoundingClientRect().width > targetWidth &&\n          Number(getComputedStyle(handle, '::before').opacity) > 0\n        ) {\n          return\n        }\n        await new Promise(resolve => setTimeout(resolve, 25))\n      }\n    })()",
] as const

/** 构造带参数的浏览器端验收探测脚本（conversation #4）。 */
export function buildConversationScript4(p0: unknown): string {
  return CONVERSATION_PARTS_4[0]! + String(p0) + CONVERSATION_PARTS_4[1]!
}

/** 浏览器端验收探测脚本（conversation #5）。 */
export const CONVERSATION_SCRIPT_5 = `(async () => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const view = document.querySelector('#conversation-view')
        const toggle = view?.querySelector('[data-turn-process="1"]')
        const answer = view?.querySelector('h1')
        if (toggle?.textContent === '1 次工具调用 · 1 条消息'
          && toggle.getAttribute('aria-expanded') === 'false'
          && !view.querySelector('[data-tool-disclosure], [data-thinking-disclosure]')
          && answer) {
          if (Math.abs(toggle.getBoundingClientRect().left - answer.getBoundingClientRect().left) >= 1) throw new Error('过程摘要与最终回答未对齐')
          if (view.querySelectorAll('[aria-label="消息操作"]').length !== 1) throw new Error('最终回答的消息操作数量异常')
          toggle.click()
          return true
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      const toggle = document.querySelector('#conversation-view [data-turn-process="1"]')
      throw new Error('过程摘要未收起：' + toggle?.textContent)
    })()`

/** 浏览器端验收探测脚本（conversation #6）。 */
export const CONVERSATION_SCRIPT_6 = `(async () => {
      const toggle = document.querySelector('[data-turn-process="1"]')
      toggle?.click()
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (document.querySelector('[data-turn-process="1"]')?.getAttribute('aria-expanded') === 'false') break
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      await Promise.race([
        new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        new Promise(resolve => setTimeout(resolve, 200)),
      ])
    })()`

/** 浏览器端验收探测脚本（conversation #7）。 */
export const CONVERSATION_SCRIPT_7 = `(async () => {
      const waitFor = async predicate => {
        for (let attempt = 0; attempt < 80; attempt += 1) {
          if (predicate()) return true
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        return false
      }
      // 文件与对话都以顶部工作标签呈现：链接打开的文件进入可见标签，对话保留在自己的标签里。
      const visiblePanel = () => document.querySelector('.work-tab-panel:not([hidden])')
      const button = name => [...document.querySelectorAll('#conversation-view button')].find(item => item.textContent === name)
      const openConversationTab = async () => {
        document.querySelector('[data-work-tab="session"]')?.click()
        return waitFor(() => visiblePanel()?.querySelector('#conversation-view'))
      }
      const visibleReadme = () => visiblePanel()?.querySelector('[data-file-path="README.md"] .cm-line')?.textContent.includes('MyDSH 验收项目')
      if (button('index.html') || !button('README.md') || !button('查看说明')) return { ready: false, stage: 'conversation-links' }
      button('查看说明').click()
      if (!await waitFor(() => visibleReadme() && document.querySelector('[data-work-tab="session"]'))) return { ready: false, stage: 'markdown-file-main' }
      if (document.querySelector('.right-island-tabs [data-tab-id="files"]')) return { ready: false, stage: 'obsolete-file-right-tab' }
      if (!await openConversationTab()) return { ready: false, stage: 'conversation-after-markdown' }
      button('查看图片').click()
      if (!await waitFor(() => visiblePanel()?.querySelector('.image-viewer img')?.complete)) return { ready: false, stage: 'image-file-main' }
      if (!await openConversationTab()) return { ready: false, stage: 'conversation-after-image' }
      button('不存在').click()
      if (!await waitFor(() => document.body.textContent.includes('missing.html') && document.body.textContent.includes('项目操作失败'))) return { ready: false, stage: 'missing-file-error' }
      if (!document.querySelector('[data-work-tab="file"]')) return { ready: false, stage: 'failure-kept-file' }
      button('README.md').click()
      if (!await waitFor(visibleReadme)) return { ready: false, stage: 'recover-after-error' }
      if (!await openConversationTab()) return { ready: false, stage: 'return-conversation' }
      document.querySelector('button[aria-label="关闭 README.md"]')?.click()
      document.querySelector('button[aria-label="关闭 assets/preview.png"]')?.click()
      return { ready: await waitFor(() => !document.querySelector('[data-work-tab="file"]')), stage: 'complete' }
    })()`

/** 浏览器端验收探测脚本（conversation #8）。 */
export const CONVERSATION_SCRIPT_8 = `(async () => {
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const dock = document.querySelector('[aria-label="消息队列"]')
          const view = document.querySelector('#conversation-view')
          const list = view?.querySelector(':scope > ol')
          if (dock && list) {
            view.scrollTop = view.scrollHeight
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
            const rect = dock.getBoundingClientRect()
            const body = list.getBoundingClientRect()
            const action = dock.querySelector('button[aria-label="编辑"]')
            if (Math.abs(rect.width - body.width) > 1 || rect.right > innerWidth
              || rect.left < 0 || dock.scrollWidth > dock.clientWidth) throw new Error('队列宽度或溢出验收失败')
            if (action && getComputedStyle(action).backgroundColor !== 'rgba(0, 0, 0, 0)') throw new Error('队列按钮仍有常驻底色')
            return { x: Math.floor(rect.x - 4), y: Math.floor(rect.y - 4), width: Math.ceil(rect.width + 8), height: Math.ceil(rect.height + 8) }
          }
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        throw new Error('队列未挂载')
      })()`
