/**
 * 启动小窗验收器：校验浅色与深色主题、手动主题覆盖、四阶段状态文案、
 * 无障碍强制颜色与减少动态效果降级、760×480 尺寸及应用退出菜单项。
 */
import { writeFileSync } from 'node:fs'
import { nativeTheme, type BrowserWindow } from 'electron'
import { captureVerifiedPage, createFailedVerifyReport } from './desktop-verifier.ts'
import { waitForNativeTheme, type HostVerificationBridge } from './host-verify-context.ts'

interface StartupScreenAudit {
  theme: string
  label: string
  fits: boolean
  plain: boolean
}

const INSPECT_STARTUP_SCRIPT = `(() => {
  const panel = document.querySelector('.launch-window')
  const status = document.getElementById('startup-status')
  const dark = document.querySelector('.art-dark')
  if (!panel || !status || !dark) throw new Error('启动画面缺少主体')
  const bounds = status.getBoundingClientRect()
  return {
    theme: getComputedStyle(dark).display === 'none' ? 'light' : 'dark',
    label: status.textContent,
    fits: bounds.left > 0 && bounds.right < innerWidth && bounds.bottom < innerHeight,
    plain: document.querySelectorAll('[role="status"]').length === 1
      && !document.querySelector('a, button:not([data-window-action])')
      && document.querySelectorAll('[role="progressbar"]').length === 1
      && document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuetext') === status.textContent
      && document.querySelector('[role="progressbar"]')?.hidden === (document.documentElement.dataset.phase === 'ready')
      && (document.documentElement.dataset.platform === 'win32'
        ? document.querySelectorAll('.window-controls button').length === 3
          && document.querySelector('[data-window-action="toggle-maximize"]')?.disabled === true
        : document.querySelectorAll('button').length === 0)
      && !document.body.textContent.includes('本机启动')
      && !document.body.textContent.includes('让 DSH'),
  }
})()`

const ACCESSIBLE_STARTUP_SCRIPT = `(() => {
  const art = document.querySelector('.art-light')
  const status = document.getElementById('startup-status')
  return getComputedStyle(art).display === 'none' && status.checkVisibility()
    && getComputedStyle(status).color !== getComputedStyle(document.querySelector('.launch-window')).backgroundColor
    && document.getAnimations().length === 0
})()`

function inspectStartup(win: BrowserWindow): Promise<StartupScreenAudit> {
  return win.webContents.executeJavaScript(INSPECT_STARTUP_SCRIPT) as Promise<StartupScreenAudit>
}

async function verifyStartupPhaseLabels(bridge: HostVerificationBridge): Promise<void> {
  const phases = [
    ['initializing', '正在启动'],
    ['starting', '正在加载插件'],
    ['workspace', '正在准备工作空间'],
    ['ready', '启动成功'],
  ] as const
  /* oxlint-disable no-await-in-loop -- 同一启动页必须顺序切换阶段，不能并发覆盖状态。 */
  for (const [phase, label] of phases) {
    await bridge.loadStartup(phase)
    const current = await inspectStartup(bridge.win)
    if (current.label !== label || !current.fits || !current.plain) {
      throw new Error('启动状态文字或布局不正确')
    }
  }
  /* oxlint-enable no-await-in-loop */
}

async function verifyStartupAccessibility(win: BrowserWindow): Promise<void> {
  win.webContents.debugger.attach('1.3')
  try {
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [
        { name: 'forced-colors', value: 'active' },
        { name: 'prefers-reduced-motion', value: 'reduce' },
      ],
    })
    const accessible = (await win.webContents.executeJavaScript(
      ACCESSIBLE_STARTUP_SCRIPT,
    )) as boolean
    if (!accessible) throw new Error('启动页无障碍降级未生效')
  } finally {
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] })
    win.webContents.debugger.detach()
  }
}

async function auditStartupThemes(bridge: HostVerificationBridge): Promise<{
  light: StartupScreenAudit
  dark: StartupScreenAudit
  manualLight: StartupScreenAudit
  manualDark: StartupScreenAudit
}> {
  const { win } = bridge
  nativeTheme.themeSource = 'light'
  await win.webContents.executeJavaScript(
    'Promise.all([...document.images].map(image => image.decode()))',
  )
  const light = await inspectStartup(win)
  writeFileSync(bridge.artifactPath('verify-startup.png'), (await captureVerifiedPage(win)).toPNG())
  nativeTheme.themeSource = 'dark'
  await waitForNativeTheme(win, 'dark')
  const dark = await inspectStartup(win)
  writeFileSync(
    bridge.artifactPath('verify-startup-dark.png'),
    (await captureVerifiedPage(win)).toPNG(),
  )
  await win.webContents.executeJavaScript("document.documentElement.dataset.colorScheme = 'light'")
  const manualLight = await inspectStartup(win)
  await win.webContents.executeJavaScript("document.documentElement.dataset.colorScheme = 'dark'")
  nativeTheme.themeSource = 'light'
  await waitForNativeTheme(win, 'light')
  const manualDark = await inspectStartup(win)
  await win.webContents.executeJavaScript("document.documentElement.dataset.colorScheme = 'system'")
  return { light, dark, manualLight, manualDark }
}

/** 执行启动小窗全链路验收；失败时直接写入失败报告并终止验收。 */
export async function verifyStartupScreen(bridge: HostVerificationBridge): Promise<boolean> {
  bridge.setStage('startup')
  const previousThemeSource = nativeTheme.themeSource
  try {
    const { light, dark, manualLight, manualDark } = await auditStartupThemes(bridge)
    await verifyStartupPhaseLabels(bridge)
    await verifyStartupAccessibility(bridge.win)
    await bridge.loadStartup('initializing')
    const tolerance = process.platform === 'win32' ? 2 : 0
    const [startupWidth = 0, startupHeight = 0] = bridge.win.getSize()
    const hasQuitMenu = bridge.applicationMenu.items.some(item =>
      item.submenu?.items.some(child => child.role === 'quit'),
    )
    const verified =
      light.theme === 'light' &&
      dark.theme === 'dark' &&
      manualLight.theme === 'light' &&
      manualDark.theme === 'dark' &&
      light.fits &&
      dark.fits &&
      light.plain &&
      dark.plain &&
      Math.abs(startupWidth - 760) <= tolerance &&
      Math.abs(startupHeight - 480) <= tolerance &&
      !bridge.win.isResizable() &&
      hasQuitMenu
    if (!verified) {
      throw new Error(
        `启动画面主题、布局或菜单退出入口验收失败：${JSON.stringify({
          light,
          dark,
          manualLight,
          manualDark,
          size: bridge.win.getSize(),
          resizable: bridge.win.isResizable(),
          quit: hasQuitMenu,
        })}`,
      )
    }
    bridge.setStartupScreenVerified(true)
    bridge.setStage('host')
    return true
  } catch (error) {
    bridge.finishVerify(createFailedVerifyReport('startup', error, false), 1)
    return false
  } finally {
    nativeTheme.themeSource = previousThemeSource
  }
}
