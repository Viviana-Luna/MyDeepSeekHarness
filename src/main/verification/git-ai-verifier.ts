/** 在隔离 Electron 工作区验证 AI 准备卡原位布局与草稿恢复；不向真实模型发送代码。 */
import type { BrowserWindow } from 'electron'
import { clickTrustedElement } from './desktop-verifier.ts'

/** 使用真实 renderer 的点击和键盘事件，不把 DOM 桩当作模型执行验收。 */
export async function verifyGitAiPreparation(win: BrowserWindow): Promise<void> {
  const prior = await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#scm-commit-message')
    if (!(input instanceof HTMLTextAreaElement)) throw new Error('缺少手动提交输入框')
    return input.value
  })()`)
  await clickTrustedElement(win, '.scm-ai-entry')
  const ready = await win.webContents.executeJavaScript(`(async () => {
    for (let i = 0; i < 80; i++) {
      const card = document.querySelector('.git-ai-prepare')
      if (card && card.querySelector('select')) {
        const controls = [...card.querySelectorAll('button, select, input')]
        const bounds = card.getBoundingClientRect()
        return !document.querySelector('[role="dialog"]') && document.querySelector('.change-list') !== null
          && controls.every(node => node.getBoundingClientRect().right <= bounds.right + 1)
          && card.textContent.includes('所选变更内容将发送给上述模型')
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    return false
  })()`)
  if (!ready) throw new Error('AI 提交准备卡没有原位展开或控件超出左栏')
  await clickTrustedElement(win, '[aria-label="退出 AI 提交"]')
  const restored = await win.webContents.executeJavaScript(`(async () => {
    for (let i = 0; i < 80; i++) {
      const input = document.querySelector('#scm-commit-message')
      if (input) return input.value === ${JSON.stringify(prior)} && !document.querySelector('.git-ai-prepare')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    return false
  })()`)
  if (!restored) throw new Error('退出 AI 提交没有恢复手动提交草稿')
}
