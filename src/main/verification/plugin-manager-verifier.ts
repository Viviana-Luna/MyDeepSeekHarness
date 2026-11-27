import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { clickTrustedElement, emulateVerificationMedia } from './desktop-verifier.ts'
import { pollRenderer, waitForMediaFeature, waitForViewportSettled } from './verification-wait.ts'

/** 通过真实 renderer 与安装服务验收，不读取或改动用户的插件目录。 */
export async function verifyPluginManager(
  win: BrowserWindow,
  directory: string,
  appearance: (scheme: 'light' | 'dark') => void,
  capture: (name: string) => Promise<void>,
): Promise<void> {
  const wait = async (expression: string) => {
    const ready = await win.webContents.executeJavaScript(
      `(async () => { for (let i=0;i<100;i++) { if (${expression}) return true; await new Promise(resolve=>setTimeout(resolve,50)) } return false })()`,
    )
    if (!ready) throw new Error(`插件管理验收超时：${expression}`)
  }
  const click = (selector: string) => clickTrustedElement(win, selector)
  const source = join(directory, 'sample')
  const navigationCollapsed = (await win.webContents.executeJavaScript(
    `document.querySelector('.app-shell').hasAttribute('data-navigation-collapsed')`,
  )) as boolean
  await mkdir(source, { recursive: true })
  await writeFile(
    join(source, 'mydsh.plugin.json'),
    JSON.stringify({
      id: 'verify-plugin-manager',
      name: '插件管理验收',
      version: '1.0.0',
      apiVersion: 1,
      frontend: 'index.js',
    }),
  )
  await writeFile(
    join(source, 'index.js'),
    `window.__MYDSH_PLUGINS__.define('verify-plugin-manager', (require, module) => { module.exports = { apply(ctx) { ctx.effect(() => { document.documentElement.dataset.pluginManagerFixture = 'active'; return () => { delete document.documentElement.dataset.pluginManagerFixture } }) } } })`,
  )
  const fill = async (value: string) =>
    win.webContents.executeJavaScript(
      `(() => { const input=document.getElementById('plugin-package-path'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true})) })()`,
    )
  try {
    await click('[data-view="plugins"]')
    await wait(
      `document.querySelector('[aria-label="配置 终端"]') && !document.querySelector('[aria-label="刷新插件"]').disabled`,
    )
    await click('.plugin-manager__actions .ant-btn:not([aria-label])')
    await wait(`document.querySelector('[role="dialog"] #plugin-package-path')`)
    await fill(join(directory, 'missing'))
    await wait(`!document.querySelector('.ant-modal-footer .ant-btn-primary').disabled`)
    await click('.ant-modal-footer .ant-btn-primary')
    await wait(`document.querySelector('.plugin-install [role="alert"]')`)
    await wait(`!document.querySelector('.ant-modal-footer .ant-btn-primary').disabled`)
    await fill(source)
    await click('.ant-modal-footer .ant-btn-primary')
    await wait(
      `document.documentElement.dataset.pluginManagerFixture === 'active' && document.querySelector('[aria-label="启用 插件管理验收"]')`,
    )
    /* oxlint-disable no-await-in-loop */
    for (const width of [1280, 1800])
      for (const scheme of ['dark', 'light'] as const) {
        win.setSize(width, width === 1280 ? 800 : 1000)
        appearance(scheme)
        await waitForViewportSettled(win, { scheme })
        const polled = await pollRenderer<Record<string, boolean>>(win, {
          probe: `(() => {
            const page=document.querySelector('.plugin-manager--standalone')
            if (!page) return { mounted: false }
            const bounds=page.getBoundingClientRect()
            const rows=[...page.querySelectorAll('.plugin-manager__row')], icons=rows.map(row=>row.querySelector('.plugin-manager__icon').getBoundingClientRect())
            // 内置 5 个（含 ChatGPT 订阅）加验收插件 1 个；“扩展配置”分组的行数取决于已启用插件，不计入。
            const builtin=page.querySelector('[aria-label="内置插件"]'), cards=[...(builtin?.querySelectorAll('.plugin-manager__row') ?? [])]
            if (cards.length < 2) return { cardsMounted: false }
            const first=cards[0].getBoundingClientRect(), second=cards[1].getBoundingClientRect()
            return { rows: rows.filter(row=>!row.closest('[aria-label="扩展配置"]')).length===6, grid: Math.abs(first.top-second.top)<1 && second.left>first.right && icons.every(icon=>Math.abs(icon.width-48)<1),
              visible: bounds.right<=innerWidth && bounds.bottom<=innerHeight && bounds.width>800,
              noOverflow: page.scrollWidth<=page.clientWidth+1 && document.documentElement.scrollWidth===innerWidth,
              navigation: document.querySelector('[data-view="plugins"]').getAttribute('aria-current')==='page',
              // 隐藏的会话工作标签仍保留输入区 DOM，只要求不可见。
              noComposer: ![...document.querySelectorAll('.main-island .composer-dock')].some(dock=>dock.checkVisibility()),
              noSelectedChat: !document.querySelector('.session-tab[aria-selected="true"]') }
          })()`,
          condition: 'Object.values(state).every(value => value === true)',
        })
        console.log('desktop-shell-verify-local: plugin-manager', {
          width,
          scheme,
          ...polled.value,
        })
        if (!polled.ok)
          throw new Error(
            '插件管理布局或导航验收失败：' + JSON.stringify({ width, scheme, polled }),
          )
        await capture(`verify-plugin-manager-${width}-${scheme}.png`)
      }
    /* oxlint-enable no-await-in-loop */
    await emulateVerificationMedia(win, [
      { name: 'forced-colors', value: 'active' },
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ])
    await waitForMediaFeature(win, '(forced-colors: active)')
    await capture('verify-plugin-manager-accessible.png')
    await emulateVerificationMedia(win, [])
    await click('.plugin-manager__filters button:nth-child(2)')
    await wait(
      `!document.querySelector('[aria-label="已安装插件"]') && document.querySelector('[aria-label="配置 终端"]')`,
    )
    await click('.plugin-manager__filters button:nth-child(3)')
    await wait(
      `!document.querySelector('[aria-label="内置插件"]') && document.querySelector('[aria-label="查看 插件管理验收"]')`,
    )
    await click('.plugin-manager__filters button:first-child')
    await click('[aria-label="配置 终端"]')
    await wait(
      `document.getElementById('plugin-shell-timeoutMs') && !document.getElementById('plugin-shell-timeoutMs').disabled`,
    )
    await capture('verify-plugin-configuration.png')
    await click('.plugin-manager__back')
    await wait(`!!document.querySelector('[aria-label="配置 ChatGPT 订阅"]')`)
    await click('[aria-label="配置 ChatGPT 订阅"]')
    await wait(
      `document.querySelector('.chatgpt-hero-card')?.checkVisibility() === true && !document.querySelector('.chatgpt-hero-card')?.textContent?.includes('读取中') && document.querySelectorAll('.plugin-manager h2').length === 1 && document.querySelector('.plugin-manager__header h2')?.textContent === 'ChatGPT 订阅'`,
    )
    await capture('verify-plugin-chatgpt.png')
    await click('.plugin-manager__back')
    await wait(`!!document.querySelector('[aria-label="配置 终端"]')`)
    await click('[aria-label="启用 插件管理验收"]')
    await wait(
      `!document.documentElement.dataset.pluginManagerFixture && document.querySelector('[aria-label="启用 插件管理验收"]').getAttribute('aria-checked')==='false'`,
    )
    await click('[aria-label="启用 插件管理验收"]')
    await wait(
      `document.documentElement.dataset.pluginManagerFixture==='active' && !document.querySelector('[aria-label="启用 插件管理验收"]').disabled`,
    )
    await click('[aria-label="查看 插件管理验收"]')
    await click('.plugin-manager__detail .ant-btn-dangerous')
    await wait(`document.querySelector('.ant-modal-footer .ant-btn-primary')`)
    await click('.ant-modal-footer .ant-btn:not(.ant-btn-primary)')
    await wait(`!document.querySelector('.ant-modal-wrap')?.checkVisibility()`)
    if (
      !(await win.webContents.executeJavaScript(
        `document.documentElement.dataset.pluginManagerFixture==='active'`,
      ))
    )
      throw new Error('取消卸载后插件被移除')
    await click('.plugin-manager__detail .ant-btn-dangerous')
    await click('.ant-modal-footer .ant-btn-primary')
    await wait(
      `!document.documentElement.dataset.pluginManagerFixture && !document.querySelector('[aria-label="查看 插件管理验收"]') && !!document.querySelector('[aria-label="配置 终端"]')`,
    )
    await wait(
      `[...document.querySelectorAll('.ant-modal-wrap')].every(element=>!element.checkVisibility())`,
    )
    console.log('desktop-shell-verify-local: plugin-manager-lifecycle', {
      failedInstallRetried: true,
      installed: true,
      disabled: true,
      enabled: true,
      canceledUninstall: true,
      uninstalled: true,
    })
    await click('[data-view="conversation"]')
    await wait(
      `document.querySelector('[data-view="conversation"]').getAttribute('aria-current')==='page' && document.querySelector('.app-shell').hasAttribute('data-navigation-collapsed')===${navigationCollapsed}`,
    )
  } catch (error) {
    console.log(
      'desktop-shell-verify-local: plugin-manager-failure',
      error,
      await win.webContents.executeJavaScript(
        `(() => {
          const okButton = document.querySelector('.ant-modal-footer .ant-btn-primary')
          const modal = okButton?.closest('.ant-modal')
          return {
            text: document.querySelector('.plugin-manager')?.textContent,
            dialogs: [...document.querySelectorAll('.ant-modal-wrap')].map(node => ({
              visible: node.checkVisibility(),
              text: node.textContent,
            })),
            inputValue: document.getElementById('plugin-package-path')?.value ?? null,
            okButton: okButton instanceof HTMLButtonElement ? {
              disabled: okButton.disabled,
              loading: okButton.classList.contains('ant-btn-loading'),
              modalClass: modal?.className ?? null,
              modalOpacity: modal instanceof HTMLElement ? getComputedStyle(modal).opacity : null,
            } : null,
            alert: document.querySelector('.plugin-install [role="alert"]')?.textContent ?? null,
            active: document.querySelector('[data-view][aria-current]')?.getAttribute('data-view'),
            nav: document.querySelector('.app-shell')?.getAttribute('data-navigation-collapsed'),
          }
        })()`,
      ),
    )
    await capture('verify-plugin-manager-failure.png')
    throw error
  } finally {
    await emulateVerificationMedia(win, [])
    await win.webContents.executeJavaScript(
      `(async () => { const plugins=await window.dshDesktop.host.call('mydshPlugins.list',{}); if(plugins.some(plugin=>plugin.id==='verify-plugin-manager')) await window.dshDesktop.host.call('mydshPlugins.uninstall',{id:'verify-plugin-manager'}) })()`,
    )
    win.setSize(1280, 800)
    await waitForViewportSettled(win)
  }
}
