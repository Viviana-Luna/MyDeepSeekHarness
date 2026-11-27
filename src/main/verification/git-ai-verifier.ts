/** 在隔离 Electron 工作区验证 AI 准备卡原位布局与草稿恢复；不向真实模型发送代码。 */
import type { BrowserWindow } from 'electron'
import { clickTrustedElement } from './desktop-verifier.ts'
import { pollRenderer } from './verification-wait.ts'

/** 使用真实 renderer 的点击和键盘事件，不把 DOM 桩当作模型执行验收。 */
export async function verifyGitAiPreparation(win: BrowserWindow): Promise<void> {
  const prior = (await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#scm-commit-message')
    if (!(input instanceof HTMLTextAreaElement)) throw new Error('缺少手动提交输入框')
    return input.value
  })()`)) as string
  await clickTrustedElement(win, '.scm-ai-entry')
  const ready = await pollRenderer<Record<string, unknown>>(win, {
    probe: `(() => {
      const card = document.querySelector('.git-ai-prepare')
      if (!card || !card.querySelector('select')) return { ok: false, mounted: false }
      const controls = [...card.querySelectorAll('button, select, input')]
      const bounds = card.getBoundingClientRect()
      const noDialog = !document.querySelector('[role="dialog"]')
      const hasChanges = document.querySelector('.change-list') !== null
      const controlsFit = controls.every(node => node.getBoundingClientRect().right <= bounds.right + 1)
      const hasNotice = card.textContent.includes('所选变更内容将发送给上述模型')
      return {
        ok: noDialog && hasChanges && controlsFit && hasNotice,
        noDialog, hasChanges, controlsFit, hasNotice, bounds: bounds.toJSON(),
      }
    })()`,
    condition: 'state.ok === true',
    timeoutMs: 4_000,
    intervalMs: 40,
  })
  if (!ready.ok) {
    throw new Error(`AI 提交准备卡没有原位展开或控件超出左栏：${JSON.stringify(ready)}`)
  }
  await clickTrustedElement(win, '[aria-label="退出 AI 提交"]')
  const restored = await pollRenderer<{
    ok: boolean
    hasInput: boolean
    value: string | null
    hasCard: boolean
  }>(win, {
    probe: `(() => {
      const input = document.querySelector('#scm-commit-message')
      const hasCard = document.querySelector('.git-ai-prepare') !== null
      return {
        ok: Boolean(input) && input.value === ${JSON.stringify(prior)} && !hasCard,
        hasInput: Boolean(input),
        value: input?.value ?? null,
        hasCard,
      }
    })()`,
    condition: 'state.ok === true',
    timeoutMs: 4_000,
    intervalMs: 40,
  })
  if (!restored.ok) {
    throw new Error(`退出 AI 提交没有恢复手动提交草稿：${JSON.stringify(restored)}`)
  }
}
