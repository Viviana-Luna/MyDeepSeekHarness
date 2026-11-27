import type { BrowserWindow } from 'electron'
import type { DesktopSessionFrame } from '../../shared/session-live.ts'
import { clickTrustedElement, emulateVerificationMedia } from './desktop-verifier.ts'
import { pollRenderer, waitForMediaFeature, waitForViewportSettled } from './verification-wait.ts'

/** 在隔离的真实窗口覆盖长计划、响应失败、阅读关闭和窄屏降级。 */
export async function verifyPlanReview(
  win: BrowserWindow,
  sessionId: string,
  emit: (frame: DesktopSessionFrame) => void,
  appearance: (scheme: 'light' | 'dark') => void,
  capture: (name: string) => Promise<void>,
): Promise<void> {
  const key = 'question:mydsh-plan-verifier'
  const text =
    '# 周末两日旅行计划\n\n先确认交通与住宿，再按天气调整路线。\n\n' +
    Array.from(
      { length: 60 },
      (_, index) =>
        `## 第 ${index + 1} 项安排\n\n- 保留自由活动时间\n- 核对当天开放时间\n\n| 时间 | 活动 |\n| --- | --- |\n| 上午 | 徒步游览 |\n| 下午 | 返回休息 |\n\n\`\`\`text\n预留交通时间\n\`\`\`\n\n`,
    ).join('')
  const size = win.getSize()
  emit({
    type: 'session/interaction-requested',
    sessionId,
    interaction: {
      kind: 'question',
      key,
      questions: [
        {
          id: 'plan-review',
          question: '是否批准计划？',
          detail: text,
          options: [{ label: 'Approve' }, { label: 'Keep planning' }],
          intent: { kind: 'plan-review', approve: 'Approve', callId: 'mydsh-plan-call' },
        },
      ],
    },
  })
  try {
    /* oxlint-disable no-await-in-loop */
    for (const sample of [
      { width: 1280, height: 800, scheme: 'dark' as const },
      { width: 1800, height: 1000, scheme: 'light' as const },
      { width: 1100, height: 800, scheme: 'dark' as const },
      { width: 900, height: 600, scheme: 'light' as const },
    ]) {
      win.setSize(sample.width, sample.height)
      appearance(sample.scheme)
      await waitForViewportSettled(win, { scheme: sample.scheme })
      const polled = await pollRenderer<Record<string, boolean | number>>(win, {
        probe: `(() => {
          const card = document.querySelector('[data-plan-review-key="${key}"]')
          const preview = [...document.querySelectorAll('section[data-plan-id]')].find(element => element.checkVisibility())
          const body = preview?.querySelector('[aria-label="计划正文"]')
          const approve = [...(card?.querySelectorAll('button') ?? [])].find(button => button.textContent.includes('同意执行'))
          if (!card || !preview || !body || !approve) return { missing: true }
          const rect = card.getBoundingClientRect()
          const documentRect = body.getBoundingClientRect()
          return { compact: matchMedia('(max-width: 1268px)').matches,
            cardHeight: rect.height, cardFits: rect.top >= 0 && rect.bottom <= innerHeight && rect.height <= 260,
            actionsFit: approve.getBoundingClientRect().bottom <= rect.bottom,
            markdown: body.querySelectorAll('table').length === 60 && body.querySelectorAll('pre').length === 60 && !!body.querySelector('ul'),
            documentScrolls: body.scrollHeight > body.clientHeight && body.clientHeight > 150,
            documentFits: documentRect.right <= innerWidth && body.scrollWidth <= body.clientWidth + 1,
            location: preview.closest(matchMedia('(max-width: 1268px)').matches ? '.main-island' : '.info-island') !== null,
            contextual: !document.querySelector('[data-tab-id="plan-preview"], [data-island-id="plan-preview"]')
              && !document.querySelector('.info-island .right-island-header'),
            noDialog: document.querySelector('[role="dialog"]') === null,
            noRawQuestion: !card.querySelector('textarea') && !card.querySelector('[role="radio"]') }
        })()`,
        condition: `['cardFits','actionsFit','markdown','documentScrolls','documentFits','location','contextual','noDialog','noRawQuestion'].every(name => state[name] === true)`,
        timeoutMs: 4_000,
      })
      const result = polled.value
      console.log('desktop-shell-verify-local: plan-review', sample, result)
      if (!polled.ok) {
        throw new Error(
          `计划审阅卡片、Markdown 或文档滚动布局验收失败：${JSON.stringify({ sample, polled })}`,
        )
      }
      await capture(`verify-plan-${sample.width}-${sample.scheme}.png`)
    }
    /* oxlint-enable no-await-in-loop */
    await clickTrustedElement(win, '[aria-label="返回对话"]')
    const closeReady = await pollRenderer<{ hasCard: boolean; hasConversation: boolean }>(win, {
      probe: `({
        hasCard: Boolean(document.querySelector('[data-plan-review-key="${key}"]')),
        hasConversation: Boolean(document.querySelector('#conversation-view')),
      })`,
      condition: 'state.hasCard && state.hasConversation',
      timeoutMs: 2_500,
    })
    if (!closeReady.ok) {
      throw new Error(`关闭计划全文误结束审阅或未返回对话：${JSON.stringify(closeReady)}`)
    }
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('[data-plan-review-key="${key}"] button')].find(button => button.textContent.includes('查看全文')).click()`,
    )
    await pollRenderer<boolean>(win, {
      probe: `[...document.querySelectorAll('section[data-plan-id]')].some(element => element.checkVisibility())`,
      condition: 'state === true',
      timeoutMs: 2_500,
    })
    await emulateVerificationMedia(win, [
      { name: 'forced-colors', value: 'active' },
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ])
    await waitForMediaFeature(win, '(forced-colors: active)')
    await capture('verify-plan-forced-colors.png')
    await emulateVerificationMedia(win, [{ name: 'prefers-reduced-transparency', value: 'reduce' }])
    await waitForMediaFeature(win, '(prefers-reduced-transparency: reduce)')
    await capture('verify-plan-solid.png')
    // 这个隔离请求没有后台 Remote，必须展示可恢复错误而不是卡死或误批准。
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('[data-plan-review-key="${key}"] button')].find(button => button.textContent.includes('同意执行')).click()`,
    )
    const retryReady = await pollRenderer<Record<string, unknown>>(win, {
      probe: `(() => {
        const card = document.querySelector('[data-plan-review-key="${key}"]')
        const busy = card?.getAttribute('aria-busy') ?? null
        const status = card?.querySelector('[role="status"]')?.textContent ?? ''
        const allEnabled = Boolean(card) && [...card.querySelectorAll('button')].every(button => !button.disabled)
        return { ok: busy === 'false' && status.includes('Remote') && allEnabled, busy, status, allEnabled }
      })()`,
      condition: 'state.ok === true',
      timeoutMs: 3_000,
    })
    if (!retryReady.ok) {
      throw new Error(`计划响应失败后的重试状态验收失败：${JSON.stringify(retryReady)}`)
    }
  } finally {
    emit({
      type: 'session/interaction-resolved',
      sessionId,
      resolution: { kind: 'question', key, outcome: 'cancelled' },
    })
    await win.webContents.executeJavaScript(
      `document.querySelector('[aria-label="返回对话"], [aria-label="关闭计划全文"]')?.click()`,
    )
    await emulateVerificationMedia(win)
    win.setSize(size[0]!, size[1]!)
    await waitForViewportSettled(win)
  }
  emit({
    type: 'session/event',
    sessionId,
    event: {
      type: 'tool/call',
      seq: 900_001,
      time: Date.now(),
      data: {
        turn: 1,
        callId: 'mydsh-plan-history',
        name: 'exit_plan_mode',
        arguments: JSON.stringify({ plan: text }),
      },
    },
  })
  await clickTrustedElement(win, '[data-plan-history="mydsh-plan-history"]')
  const historyReady = await pollRenderer<{ tables: number; hasReviewCard: boolean }>(win, {
    probe: `(() => {
      const preview = [...document.querySelectorAll('[data-plan-id="mydsh-plan-history"]')].find(element => element.checkVisibility())
      return {
        tables: preview?.querySelectorAll('table').length ?? 0,
        hasReviewCard: Boolean(document.querySelector('[data-plan-review-key="${key}"]')),
      }
    })()`,
    condition: 'state.tables === 60 && !state.hasReviewCard',
    timeoutMs: 3_000,
  })
  if (!historyReady.ok) {
    throw new Error(`长计划从会话历史重新打开验收失败：${JSON.stringify(historyReady)}`)
  }
  await capture('verify-plan-history.png')
  await win.webContents.executeJavaScript(
    `document.querySelector('[aria-label="返回对话"], [aria-label="关闭计划全文"]')?.click()`,
  )
  console.log('desktop-shell-verify-local: plan-history', historyReady.ok)
}

async function waitForPermissionDialogSettled(win: BrowserWindow) {
  return pollRenderer<Record<string, unknown>>(win, {
    probe: `(() => {
      const inMotion = node =>
        typeof node.className === 'string' &&
        /(?:^|\\s)ant-[^\\s]+-(?:appear|enter|leave)(?:-(?:prepare|start|active))?(?:\\s|$)/.test(node.className)
      const dialog = document.querySelector('[role="dialog"]')
      if (!(dialog instanceof HTMLElement)) return { ok: false, missing: true }
      const motion = inMotion(dialog)
      const running = dialog.getAnimations({ subtree: true })
        .some(animation => animation.playState !== 'finished' && animation.effect?.getComputedTiming().iterations !== Infinity)
      const rect = dialog.getBoundingClientRect()
      const surface = dialog.querySelector('.mydsh-glass-dialog')
      const blur = surface ? getComputedStyle(surface).backdropFilter : ''
      const menuClosed = !document.querySelector('[aria-label="选择访问模式"]')
      const focusInside = dialog.contains(document.activeElement)
      const centeredX = Math.abs(rect.left + rect.width / 2 - innerWidth / 2) < 2
      const centeredY = Math.abs(rect.top + rect.height / 2 - innerHeight / 2) < 20
      const inViewport = rect.width <= 441 && rect.top > 0 && rect.bottom < innerHeight
      return {
        ok: !motion && !running && inViewport && centeredX && centeredY && blur.includes('blur') && menuClosed && focusInside,
        motion, running, rect: rect.toJSON(), innerWidth, innerHeight, blur, menuClosed, focusInside,
      }
    })()`,
    condition: 'state.ok === true',
    timeoutMs: 3_000,
    intervalMs: 25,
  })
}

export async function verifyPermissionDialog(
  win: BrowserWindow,
  appearance: (scheme: 'light' | 'dark') => void,
  capture: (name: string) => Promise<void>,
): Promise<void> {
  const size = win.getSize()
  try {
    /* oxlint-disable no-await-in-loop */
    for (const sample of [
      { width: 1280, height: 800, scheme: 'dark' as const },
      { width: 1280, height: 800, scheme: 'light' as const },
      { width: 1800, height: 1000, scheme: 'light' as const },
      { width: 1800, height: 1000, scheme: 'dark' as const },
      { width: 900, height: 600, scheme: 'light' as const },
    ])
      // 截图文件名只允许小写字母、数字和连字符，菜单标签另配英文标识。
      for (const [mode, slug] of [
        ['完全权限', 'full-access'],
        ['自动审核提权', 'auto-review'],
      ] as const) {
        console.log('desktop-shell-verify-local: permission-dialog-sample', { ...sample, mode })
        win.setSize(sample.width, sample.height)
        appearance(sample.scheme)
        await waitForViewportSettled(win, { scheme: sample.scheme })
        await clickTrustedElement(win, 'button[aria-label="访问模式，当前：工作区内修改"]')
        await clickTrustedElement(win, `[role="menuitemradio"][aria-label="${mode}"]`)
        const settled = await waitForPermissionDialogSettled(win)
        if (!settled.ok) {
          throw new Error(`独立权限弹窗的居中、焦点或菜单关闭验收失败：${JSON.stringify(settled)}`)
        }
        await capture(`verify-permission-${slug}-${sample.width}-${sample.scheme}.png`)
        if (mode === '自动审核提权') {
          const safe = await win.webContents.executeJavaScript(`(() => {
            const dialog = document.querySelector('[role="dialog"]')
            const confirm = [...dialog.querySelectorAll('button')].find(button => button.textContent.includes('启用自动审核提权'))
            return dialog.textContent.includes('保留工作区沙箱') && confirm.disabled
          })()`)
          if (!safe) throw new Error('自动审核的沙箱说明或风险确认门禁缺失')
          await clickTrustedElement(win, '[role="dialog"] input[type="checkbox"]')
          const enabled = await pollRenderer<boolean>(win, {
            probe: `[...document.querySelectorAll('[role="dialog"] button')].some(button => button.textContent.includes('启用自动审核提权') && !button.disabled)`,
            condition: 'state === true',
            timeoutMs: 1_500,
          })
          if (!enabled.ok) throw new Error('自动审核风险勾选未启用确认按钮')
          if (sample.width === 1280 && sample.scheme === 'dark') {
            await emulateVerificationMedia(win, [
              { name: 'forced-colors', value: 'active' },
              { name: 'prefers-reduced-motion', value: 'reduce' },
            ])
            await waitForMediaFeature(win, '(forced-colors: active)')
            await capture('verify-auto-review-forced-colors.png')
            await emulateVerificationMedia(win, [
              { name: 'prefers-reduced-transparency', value: 'reduce' },
            ])
            await waitForMediaFeature(win, '(prefers-reduced-transparency: reduce)')
            const solid = await pollRenderer<{ hasSurface: boolean; backdropFilter: string }>(win, {
              probe: `(() => {
                const surface = document.querySelector('[role="dialog"] .mydsh-glass-dialog')
                return { hasSurface: Boolean(surface), backdropFilter: surface ? getComputedStyle(surface).backdropFilter : '' }
              })()`,
              condition: `state.hasSurface && state.backdropFilter === 'none'`,
              timeoutMs: 1_500,
            })
            if (!solid.ok) {
              throw new Error(`权限确认窗口在减少透明度时仍在模糊背景：${JSON.stringify(solid)}`)
            }
            await capture('verify-auto-review-solid.png')
            await emulateVerificationMedia(win)
          }
        }
        await clickTrustedElement(win, '[role="dialog"] button[aria-label="取消"]')
        const closed = await pollRenderer<boolean>(win, {
          probe: `document.querySelector('[role="dialog"]') === null`,
          condition: 'state === true',
          timeoutMs: 3_000,
          intervalMs: 25,
        })
        if (!closed.ok) throw new Error(`权限确认窗口取消后未关闭：${JSON.stringify(closed)}`)
      }
    /* oxlint-enable no-await-in-loop */
  } finally {
    await emulateVerificationMedia(win)
    win.setSize(size[0]!, size[1]!)
  }
}
