/** 主进程在隔离窗口验收 Git 底栏与正文滚动；恢复尺寸与媒体状态，主题偏好由调用方恢复。 */
import type { BrowserWindow } from 'electron'
import { clickTrustedElement, emulateVerificationMedia } from './desktop-verifier.ts'
import {
  pollRenderer,
  waitForMediaFeature,
  waitForViewportSettled,
} from './verification-wait.ts'

const toolbar = '.work-tab-panel:not([hidden]) .diff-toolbar'

function buildDiffToolsProbe(layout: 'split' | 'inline'): string {
  const selectedTitle = layout === 'split' ? '并排 Diff' : '行内 Diff'
  return `(() => {
    const footer=document.querySelector(${JSON.stringify(toolbar)}), viewer=footer?.parentElement
    const scroll=viewer?.querySelector('.diff-content')
    if(!footer||!viewer||!scroll) return {mounted:false}
    if(scroll.scrollHeight>scroll.clientHeight && scroll.scrollTop===0) {
      scroll.scrollTo({top:100000,behavior:'instant'})
    }
    const a=viewer.getBoundingClientRect(), b=footer.getBoundingClientRect(), c=scroll.getBoundingClientRect()
    const sources=footer.querySelector('.diff-sources'), toggle=footer.querySelector('.diff-layout-toggle')
    const path=viewer.querySelector('.diff-path-bar'), pathBounds=path?.getBoundingClientRect()
    const labels=[...(sources?.querySelectorAll('span')??[])], toggleBounds=toggle?.getBoundingClientRect()
    if(labels.length!==2||!toggleBounds) return {sourcesMounted:false}
    const labelBounds=labels.map(label=>label.getBoundingClientRect())
    const textLeft=labels.map((label,index)=>labelBounds[index].left+parseFloat(getComputedStyle(label).paddingLeft||'0'))
    const firstPair=scroll.querySelector('.diff-pair')
    const columns=[...(firstPair?.querySelectorAll('.diff-side')??[])].map(column=>column.getBoundingClientRect())
    const columnInsets=columns.map((column,index)=>textLeft[index]-column.left)
    return {mounted:true, bottom:Math.abs(a.bottom-b.bottom)<1, compact:b.height===32,
      path:!!pathBounds && path.getAttribute('title')===path.textContent.trim()
        && pathBounds.left>=a.left && pathBounds.right<=a.right && pathBounds.bottom<=c.top+1,
      sourcesInline:labelBounds.every(rect=>Math.abs(rect.top+rect.height/2-toggleBounds.top-toggleBounds.height/2)<1)&&labelBounds[1].right<=toggleBounds.left+1,
      sourceColumns:${JSON.stringify(layout)}!=='split'||(columns.length===2&&Math.abs(columnInsets[0]-columnInsets[1])<1),
      noSourceHeader:!scroll.querySelector('.diff-sources, .diff-row--hunk'),
      buttons:[...footer.querySelectorAll('button')].every(button=>button.getBoundingClientRect().height===28),
      separate:!scroll.contains(footer)&&c.bottom<=b.top+1&&getComputedStyle(scroll).overflowY==='auto',
      scrolls:scroll.scrollHeight>scroll.clientHeight&&scroll.scrollTop>0,
      border:parseFloat(getComputedStyle(footer).borderTopWidth)>0,
      selectedLayout:footer.dataset.layout===${JSON.stringify(layout)}&&toggle.querySelector('[aria-pressed="true"]')?.title===${JSON.stringify(selectedTitle)},
      contained:a.right<=innerWidth&&a.bottom<=innerHeight&&document.documentElement.scrollWidth===innerWidth}
  })()`
}

/** 验证两种窗口尺寸、明暗主题和高对比度下底栏固定、切换有效且描边连续。 */
export async function verifyDiffTools(
  win: BrowserWindow,
  appearance: (scheme: 'light' | 'dark') => void,
  capture: (name: string) => Promise<void>,
): Promise<void> {
  const bounds = win.getBounds()
  try {
    /* oxlint-disable no-await-in-loop -- 同一窗口的主题与尺寸必须串行采样。 */
    for (const sample of [
      { width: 1280, scheme: 'dark' as const },
      { width: 1280, scheme: 'light' as const },
      { width: 1800, scheme: 'dark' as const },
      { width: 1800, scheme: 'light' as const },
    ]) {
      const { width, scheme } = sample
      win.setSize(width, width === 1280 ? 800 : 1000)
      appearance(scheme)
      await waitForViewportSettled(win, { scheme })
      for (const layout of ['split', 'inline'] as const) {
        const title = layout === 'split' ? '并排 Diff' : '行内 Diff'
        await clickTrustedElement(win, `${toolbar} [title="${title}"]`)
        const polled = await pollRenderer<Record<string, boolean>>(win, {
          probe: buildDiffToolsProbe(layout),
          condition: 'Object.values(state).every(value => value === true)',
          timeoutMs: 2_500,
        })
        console.log('desktop-shell-verify-local: diff-tools', {
          width,
          scheme,
          layout,
          ...polled.value,
        })
        if (!polled.ok) throw new Error('Git 底部工具栏验收失败：' + JSON.stringify(polled))
        await capture(`verify-diff-tools-${String(width)}-${scheme}-${layout}.png`)
      }
    }
    /* oxlint-enable no-await-in-loop */
    await emulateVerificationMedia(win, [
      { name: 'forced-colors', value: 'active' },
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ])
    await waitForMediaFeature(win, '(forced-colors: active)')
    const accessible = await pollRenderer<{ ok: boolean; outlineWidth: string }>(win, {
      probe: `(() => {
        const button=document.querySelector(${JSON.stringify(toolbar)})?.querySelector('[aria-pressed="true"]')
        if (!button) return { ok: false, outlineWidth: '' }
        button.focus()
        const outlineWidth = getComputedStyle(button).outlineWidth
        return { ok: parseFloat(outlineWidth) > 0, outlineWidth }
      })()`,
      condition: 'state.ok === true',
      timeoutMs: 1_500,
    })
    if (!accessible.ok) {
      throw new Error(`高对比度模式缺少 Git 布局选中与焦点标记：${JSON.stringify(accessible)}`)
    }
    await capture('verify-diff-tools-accessible.png')
  } finally {
    await emulateVerificationMedia(win)
    win.setBounds(bounds)
    await clickTrustedElement(win, `${toolbar} [title="并排 Diff"]`)
  }
}
