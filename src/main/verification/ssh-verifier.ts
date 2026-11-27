import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { clickTrustedElement, emulateVerificationMedia } from './desktop-verifier.ts'
import { pollRenderer, waitForMediaFeature, waitForViewportSettled } from './verification-wait.ts'

const hostCard = (name: string) =>
  `[aria-label="全部主机"] [aria-label=${JSON.stringify(`连接 ${name}`)}]`
const shellTab = (name: string) =>
  `.session-chrome [data-work-tab="ssh"][aria-label=${JSON.stringify(name)}]`
const sshHome = '[data-view="connections"]'

async function verifySshDialogLayout(
  win: BrowserWindow,
  appearance: (scheme: 'light' | 'dark') => void,
  capture: (name: string) => Promise<string>,
): Promise<void> {
  await emulateVerificationMedia(win)
  /* oxlint-disable no-await-in-loop -- 同一窗口按尺寸和主题顺序检查弹窗。 */
  for (const [width, scheme] of [
    [1280, 'dark'],
    [1280, 'light'],
    [1800, 'dark'],
    [1800, 'light'],
  ] as const) {
    win.setSize(width, width === 1280 ? 800 : 1000)
    appearance(scheme)
    await waitForViewportSettled(win, { scheme })
    const valid = await pollRenderer<Record<string, unknown>>(win, {
      probe: `(() => {
        const modal=document.querySelector('.ssh-connection-modal__container')
        const body=document.querySelector('.ssh-connection-modal__body')
        const footer=document.querySelector('.ssh-connection-modal__footer')
        const name=document.getElementById('name'), environment=document.getElementById('environment')
        if(!modal||!body||!footer||!name||!environment) return { ok: false, missing: true }
        const box=modal.getBoundingClientRect(), end=footer.getBoundingClientRect()
        const style=getComputedStyle(modal)
        const ok = box.top>=0 && box.bottom<=innerHeight && end.bottom<=innerHeight
          && body.scrollHeight<=body.clientHeight+1 && body.scrollWidth<=body.clientWidth+1
          && Math.abs(name.getBoundingClientRect().top-environment.getBoundingClientRect().top)<1
          && style.borderTopStyle==='solid' && Number.parseFloat(style.borderTopLeftRadius)>0
        return {
          ok, box: box.toJSON(), footerBottom: end.bottom, innerHeight,
          bodyScroll: { sw: body.scrollWidth, cw: body.clientWidth, sh: body.scrollHeight, ch: body.clientHeight },
          borderTopStyle: style.borderTopStyle, radius: style.borderTopLeftRadius,
        }
      })()`,
      condition: 'state.ok === true',
    })
    if (!valid.ok) {
      throw new Error(`SSH 连接弹窗的尺寸、字段布局或描边验收失败：${JSON.stringify(valid)}`)
    }
    await capture(`verify-ssh-dialog-${width}-${scheme}.png`)
  }
  /* oxlint-enable no-await-in-loop */
  await emulateVerificationMedia(win, [
    { name: 'forced-colors', value: 'active' },
    { name: 'prefers-reduced-motion', value: 'reduce' },
    { name: 'prefers-reduced-transparency', value: 'reduce' },
  ])
  await waitForMediaFeature(win, '(forced-colors: active)')
  const accessible = await pollRenderer<Record<string, unknown>>(win, {
    probe: `(() => {
      const icon=document.querySelector('.ssh-dialog-title__icon')
      const forced = matchMedia('(forced-colors: active)').matches
      const border = icon ? getComputedStyle(icon).borderTopStyle : ''
      const buttonVisible = document.querySelector('.ssh-connection-modal__footer button')?.checkVisibility() === true
      return { ok: forced && Boolean(icon) && border === 'solid' && buttonVisible, forced, border, buttonVisible }
    })()`,
    condition: 'state.ok === true',
    timeoutMs: 1_500,
  })
  if (!accessible.ok) {
    throw new Error(`SSH 连接弹窗的无障碍降级验收失败：${JSON.stringify(accessible)}`)
  }
  await capture('verify-ssh-dialog-accessible.png')
  await emulateVerificationMedia(win)
  appearance('dark')
}

/** 真实表单、首次主机确认、错误认证后修复、终端输入和隐藏恢复。 */
export async function verifySshWorkspace(
  win: BrowserWindow,
  appearance: (scheme: 'light' | 'dark') => void,
  capture: (name: string) => Promise<string>,
): Promise<void> {
  const fixture = JSON.parse(readFileSync(process.env.MYDSH_SSH_FIXTURE!, 'utf8')) as {
    port: number
    password: string
  }
  const js = (source: string) => win.webContents.executeJavaScript(source)
  const wait = async (expression: string) => {
    const ready = await js(
      `(async () => { for(let i=0;i<160;i++){ if(${expression}) return true; await new Promise(r=>setTimeout(r,50)) } return false })()`,
    )
    if (!ready)
      throw new Error(
        `SSH 界面等待失败：${expression}；界面：${await js('document.body.innerText.slice(-1200)')}`,
      )
  }
  const click = (selector: string) => clickTrustedElement(win, selector)
  const button = async (text: string) => {
    await wait(
      `[...document.querySelectorAll('button')].some(el=>el.checkVisibility() && !el.disabled && el.textContent.replaceAll(' ','')===${JSON.stringify(text.replace(/\s/g, ''))})`,
    )
    await js(
      `(() => { const button=[...document.querySelectorAll('button')].find(el=>el.checkVisibility() && el.textContent.replaceAll(' ','')===${JSON.stringify(text.replace(/\s/g, ''))}); if(!button)throw Error('按钮不存在'); button.click() })()`,
    )
  }
  const fill = (name: string, value: string) =>
    js(
      `(() => { const input=document.querySelector(${JSON.stringify(`#${name}`)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true})); })()`,
    )
  const hostAction = async (name: string, action: string) => {
    await click(`[aria-label="全部主机"] [aria-label=${JSON.stringify(`${name} 的连接操作`)}]`)
    await wait(
      `[...document.querySelectorAll('[role="menuitem"]')].some(el=>el.checkVisibility() && el.textContent.trim()===${JSON.stringify(action)})`,
    )
    await js(
      `[...document.querySelectorAll('[role="menuitem"]')].find(el=>el.checkVisibility() && el.textContent.trim()===${JSON.stringify(action)}).click()`,
    )
  }
  const fingerprintFor = (name: string) =>
    `[...document.querySelectorAll('.connections-fingerprint')].some(node=>node.checkVisibility() && node.textContent.startsWith('SHA256:') && node.parentElement.textContent.includes(${JSON.stringify(`目标：${name} · 127.0.0.1:${fixture.port}`)}))`
  await wait(`document.querySelector('[data-view="connections"]')`)
  await click('[data-view="connections"]')
  await wait(`document.querySelector('[aria-label="新增 SSH 连接"]:not([disabled])')`)
  await click('[aria-label="新增 SSH 连接"]')
  await wait(`document.getElementById('name')`)
  await verifySshDialogLayout(win, appearance, capture)
  await fill('name', '集成验收服务器')
  await fill('host', '127.0.0.1')
  await fill('port', String(fixture.port))
  await fill('username', 'tester')
  await fill('password', '错误的测试密码')
  await fill('environment', '隔离测试')
  await button('保存连接')
  await wait(
    `document.querySelector(${JSON.stringify(hostCard('集成验收服务器'))}) && !document.querySelector('.ant-modal-wrap')?.checkVisibility()`,
  )
  const other = (await js(`window.dshDesktop.remote.call('mydshSsh/save', { request: {
    id: null, revision: null, name: '切换目标验收', host: '127.0.0.1', port: ${fixture.port}, username: 'tester',
    auth: 'password', environment: '隔离测试', projectId: null, disabled: false, password: ${JSON.stringify(fixture.password)}
  } })`)) as { id: string; revision: number }
  await click('[aria-label="刷新连接列表"]')
  await wait(`document.querySelectorAll('[aria-label="全部主机"] .ssh-host-card').length === 2`)
  await click(hostCard('切换目标验收'))
  await wait(fingerprintFor('切换目标验收'))
  await button('指纹一致，信任并继续')
  await wait(
    `document.querySelector('[data-ssh-terminal]:not([hidden]) .xterm-screen')?.textContent.includes('MyDSH SSH')`,
  )
  await click(sshHome)
  const recent = '[aria-label="最近连接"] [aria-label="连接 切换目标验收"]'
  await click(recent)
  await wait(
    `document.querySelector(${JSON.stringify(shellTab('切换目标验收'))})?.getAttribute('aria-selected')==='true'`,
  )
  await click(sshHome)
  await wait(`!document.querySelector('[aria-label="刷新连接列表"]').disabled`)
  // 先探测新目标，再切回已有终端；指纹确认仍须绑定发起请求的主机。
  await js(`(() => {
    document.querySelector(${JSON.stringify(hostCard('集成验收服务器'))}).click();
    document.querySelector(${JSON.stringify(shellTab('切换目标验收'))}).click();
  })()`)
  await wait(fingerprintFor('集成验收服务器'))
  const identity = await js(`({
    terminal: document.querySelector(${JSON.stringify(shellTab('切换目标验收'))})?.getAttribute('aria-selected')==='true',
    target: ${fingerprintFor('集成验收服务器')}
  })`)
  if (!identity.terminal || !identity.target)
    throw new Error('切换终端后，指纹确认目标未绑定发起连接：' + JSON.stringify(identity))
  await button('指纹一致，信任并继续')
  await wait(
    `document.querySelector('.app-alert--floating.app-alert--error')?.textContent.includes('authentication')`,
  )
  await click(sshHome)
  await wait(`!document.querySelector('[aria-label="刷新连接列表"]').disabled`)
  await hostAction('集成验收服务器', '编辑连接')
  await wait(`document.getElementById('password')`)
  await fill('password', fixture.password)
  await button('保存连接')
  await wait(`!document.querySelector('.ant-modal-wrap')?.checkVisibility()`)
  await wait(`!document.querySelector('[aria-label="刷新连接列表"]').disabled`)
  const images: string[] = []
  /* oxlint-disable no-await-in-loop -- 同一窗口依次验证左侧主机列表的尺寸与明暗主题。 */
  for (const [width, scheme] of [
    [1280, 'dark'],
    [1280, 'light'],
    [1800, 'dark'],
    [1800, 'light'],
  ] as const) {
    win.setSize(width, width === 1280 ? 800 : 1000)
    appearance(scheme)
    await waitForViewportSettled(win, { scheme })
    const polled = await pollRenderer<Record<string, unknown>>(win, {
      probe: `(() => {
        const panel=document.querySelector('[data-connections-workspace]'), home=document.querySelector('[aria-label="SSH 导航"] .ssh-home')
        const search=home?.querySelector('.ssh-home__search')?.getBoundingClientRect()
        const actions=home?.querySelector('.ssh-home__toolbar-actions')?.getBoundingClientRect()
        const cards=[...(home?.querySelectorAll('[aria-label="全部主机"] .ssh-host-card')??[])]
        return {
          visible: !!home?.checkVisibility(),
          toolbarInline: !!search && !!actions && Math.abs(search.top-actions.top)<6 && search.right<=actions.left,
          count: cards.length === 2,
          fits: !!home && home.scrollWidth<=home.clientWidth+1 && document.documentElement.scrollWidth===innerWidth,
          cards: cards.every(card=>getComputedStyle(card).borderTopStyle==='solid' && card.getBoundingClientRect().width>200),
          recentInMain: !!panel?.querySelector('[aria-label="最近连接"] [data-ssh-host]')
            && !home?.querySelector('[aria-label="最近连接"]'),
          navigationOpen: document.querySelector('.app-shell')?.dataset.navigationCollapsed!=='true',
          homeWidth: home?.clientWidth ?? 0,
          cardWidths: cards.map(card=>card.getBoundingClientRect().width),
        }
      })()`,
      condition: `state.visible && state.toolbarInline && state.count && state.fits && state.cards && state.recentInMain && state.navigationOpen`,
    })
    if (!polled.ok)
      throw new Error('SSH 主机列表的尺寸、卡片或描边验收失败：' + JSON.stringify(polled))
    images.push(await capture(`verify-ssh-hosts-${width}-${scheme}.png`))
  }
  /* oxlint-enable no-await-in-loop */
  await click(hostCard('集成验收服务器'))
  await wait(
    `document.querySelector('[data-ssh-terminal]:not([hidden]) .xterm-screen')?.textContent.includes('MyDSH SSH')`,
  )
  await js(`document.querySelector('[data-ssh-terminal]:not([hidden]) textarea').focus()`)
  await win.webContents.insertText('echo 确认真实终端输入')
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  await wait(
    `document.querySelector('[data-ssh-terminal]:not([hidden]) .xterm-screen')?.textContent.includes('确认真实终端输入')`,
  )
  const id = await js(
    `document.querySelector('[data-ssh-terminal]:not([hidden])').dataset.sshTerminal`,
  )
  await click('[data-view="database"]')
  await click(sshHome)
  await wait(
    `document.querySelector('[aria-label="最近连接"]')?.checkVisibility() && !document.querySelector('[data-ssh-terminal]:not([hidden])')`,
  )
  await click(shellTab('集成验收服务器'))
  await wait(
    `document.querySelector('[data-ssh-terminal]:not([hidden])')?.dataset.sshTerminal===${JSON.stringify(id)}`,
  )
  await click('[data-view="conversation"]')
  await click(shellTab('集成验收服务器'))
  await wait(
    `document.querySelector('[data-ssh-terminal]:not([hidden])')?.dataset.sshTerminal===${JSON.stringify(id)}`,
  )
  await js(
    `(() => { const link=document.createElement('a'); link.href='mailto:review@example.invalid'; document.body.append(link); link.click(); link.remove() })()`,
  )
  await js(`document.querySelector('[data-ssh-terminal]:not([hidden]) textarea').focus()`)
  await win.webContents.insertText('取消导航后仍有远程输出')
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  await wait(
    `document.querySelector('[data-ssh-terminal]:not([hidden]) .xterm-screen')?.textContent.includes('取消导航后仍有远程输出')`,
  )
  /* oxlint-disable no-await-in-loop -- 同一真实窗口按顺序验证尺寸、主题及无障碍状态。 */
  for (const [width, scheme] of [
    [1280, 'dark'],
    [1280, 'light'],
    [1800, 'dark'],
    [1800, 'light'],
  ] as const) {
    win.setSize(width, width === 1280 ? 800 : 1000)
    appearance(scheme)
    await waitForViewportSettled(win, { scheme })
    const layout = await pollRenderer<Record<string, unknown>>(win, {
      probe: `(() => {
        const terminal=document.querySelector('[data-ssh-terminal]:not([hidden])'), panel=terminal?.closest('.work-tab-panel'), tab=document.querySelector(${JSON.stringify(shellTab('集成验收服务器'))}), bounds=panel?.getBoundingClientRect()
        const ok = Boolean(bounds && panel && terminal && tab) && bounds.width>450 && bounds.height>500 && panel.scrollWidth<=panel.clientWidth+1 && terminal.clientHeight>300 && tab.checkVisibility() && tab.getAttribute('aria-selected')==='true' && document.querySelector('.app-shell')?.dataset.navigationCollapsed!=='true' && !panel.querySelector('[role="tablist"], .ssh-host-card') && document.documentElement.scrollWidth===innerWidth
        return { ok, bounds: bounds?.toJSON() ?? null, terminalHeight: terminal?.clientHeight ?? 0, innerWidth }
      })()`,
      condition: 'state.ok === true',
    })
    if (!layout.ok)
      throw new Error(`SSH 界面布局、描边或终端区域验收失败：${JSON.stringify(layout)}`)
    images.push(await capture(`verify-ssh-${width}-${scheme}.png`))
  }
  await wait(
    `document.querySelector('[data-ssh-terminal]:not([hidden]) .xterm-screen')?.textContent.includes('列')`,
  )
  await emulateVerificationMedia(win, [
    { name: 'forced-colors', value: 'active' },
    { name: 'prefers-reduced-motion', value: 'reduce' },
    { name: 'prefers-reduced-transparency', value: 'reduce' },
  ])
  await waitForMediaFeature(win, '(forced-colors: active)')
  await wait(
    `document.querySelector('[data-ssh-terminal]:not([hidden])')?.dataset.sshTerminal===${JSON.stringify(id)}`,
  )
  await capture('verify-ssh-accessible.png')
  await emulateVerificationMedia(win)
  console.log('MYDSH_SSH_VISUAL_READY ' + JSON.stringify(images))
  // 仅诊断运行可短暂停留供人工查看临时截图；目录由既有运行器 finally 清理。
  if (process.env.MYDSH_SSH_VISUAL_PAUSE === '1')
    await new Promise(resolve => setTimeout(resolve, 30_000))
  await click('[aria-label="关闭 SSH 终端 集成验收服务器"]')
  await wait(`!document.querySelector('[data-ssh-terminal=${JSON.stringify(id)}]')`)
  await wait(`!document.querySelector('[aria-label="关闭 SSH 终端 切换目标验收"]').disabled`)
  await click('[aria-label="关闭 SSH 终端 切换目标验收"]')
  await wait(`!document.querySelector('[data-ssh-terminal]')`)
  await wait(`!document.querySelector('[aria-label="刷新连接列表"]').disabled`)
  await hostAction('集成验收服务器', '删除连接')
  await wait(
    `[...document.querySelectorAll('.ant-modal-confirm-btns')].some(el=>el.checkVisibility())`,
  )
  await js(
    `[...document.querySelectorAll('.ant-modal-confirm-btns .ant-btn-primary')].find(el=>el.checkVisibility()).click()`,
  )
  await wait(`!document.querySelector(${JSON.stringify(hostCard('集成验收服务器'))})`)
  await wait(
    `[...document.querySelectorAll('.ant-modal-confirm')].every(el=>!el.checkVisibility()) && !document.querySelector('[aria-label="刷新连接列表"]').disabled`,
  )
  await hostAction('切换目标验收', '删除连接')
  await wait(
    `[...document.querySelectorAll('.ant-modal-confirm-btns')].some(el=>el.checkVisibility())`,
  )
  await js(
    `[...document.querySelectorAll('.ant-modal-confirm-btns .ant-btn-primary')].find(el=>el.checkVisibility()).click()`,
  )
  await wait(`!document.querySelector('[data-ssh-host=${JSON.stringify(other.id)}]')`)
  await wait(
    `[...document.querySelectorAll('.ant-modal-wrap')].every(element=>!element.checkVisibility()) && !document.querySelector('[aria-label="新增 SSH 连接"]').disabled`,
  )
  // 带着一个仍活动的通道退出，服务端在父验收脚本中确认连接归零。
  await click('[aria-label="新增 SSH 连接"]')
  await wait(`document.getElementById('name')`)
  await fill('name', '退出清理验收')
  await fill('host', '127.0.0.1')
  await fill('port', String(fixture.port))
  await fill('username', 'tester')
  await fill('password', fixture.password)
  await button('保存连接')
  await wait(
    `document.querySelector(${JSON.stringify(hostCard('退出清理验收'))}) && !document.querySelector('.ant-modal-wrap')?.checkVisibility()`,
  )
  await click(hostCard('退出清理验收'))
  await wait(fingerprintFor('退出清理验收'))
  await button('指纹一致，信任并继续')
  await wait(
    `document.querySelector('[data-ssh-terminal]:not([hidden]) .xterm-screen')?.textContent.includes('MyDSH SSH')`,
  )
  const keyPath = join(app.getPath('userData'), 'connection-secrets', 'secret.key')
  const keyStat = lstatSync(keyPath)
  const keyText = readFileSync(keyPath, 'utf8').trim()
  if (
    keyStat.isSymbolicLink() ||
    !keyStat.isFile() ||
    (process.platform !== 'win32' && (keyStat.mode & 0o777) !== 0o600) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(keyText)
  ) {
    throw new Error('SSH 本地主密钥文件缺失或权限无效')
  }
  console.log('mydsh-ssh-verify: complete', {
    form: true,
    hostConfirmation: true,
    hostTargetBound: true,
    cancelledNavigationPreserved: true,
    authenticationFailure: true,
    terminal: true,
    resize: true,
    hiddenPreserved: true,
    themes: true,
    accessible: true,
    deleted: true,
    localSecretKey: true,
  })
}
