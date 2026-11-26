/** 运行在真实 Electron 主进程内的浏览器自动化验收脚本：验证内置 WebContentsView 与外置 Chrome/Edge CDP。 */
import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { installBrowserController } from '../lib/main/browser/browser-controller.js'
import { createAutomationSystem } from '../lib/main/automation/automation-system.js'
import { createEmbeddedBrowserDriver } from '../lib/main/automation/embedded-browser-driver.js'
import { createExternalBrowserDriver } from '../lib/main/automation/external-browser-driver.js'
import { scaleImageWithNativeImage } from '../lib/main/automation/image-scaler.js'

const verifyHome = process.env.MYDSH_VERIFY_BROWSER_HOME
const testUrl = process.env.MYDSH_VERIFY_BROWSER_URL
const mode = process.env.MYDSH_VERIFY_BROWSER_MODE || 'all'
if (!verifyHome || !testUrl) throw new Error('缺少验收环境变量')

app.setPath('userData', join(verifyHome, 'electron-user-data'))

function findRefByName(tree, needle) {
  for (const line of tree.split('\n')) {
    if (line.includes(needle)) {
      const match = line.match(/^(@e\d+)\b/u)
      if (match?.[1]) return match[1]
    }
  }
  throw new Error(`未在快照中找到包含「${needle}」的元素：\n${tree}`)
}

async function runBrowserRoundtrip(system, target, label) {
  const signal = AbortSignal.timeout(25_000)
  const prefix = `automation.browser.${target}`
  console.log(`[verify-browser] ${label}: navigate -> ${testUrl}`)
  await system.handleRuntimeCall(`${prefix}.navigate`, { mode: 'url', url: testUrl }, signal)
  console.log(`[verify-browser] ${label}: wait text`)
  await system.handleRuntimeCall(
    `${prefix}.wait`,
    { text: 'MyDSH 自动化测试表单', timeoutMs: 10_000 },
    signal,
  )

  console.log(`[verify-browser] ${label}: snapshot`)
  const snap = await system.handleRuntimeCall(`${prefix}.snapshot`, {}, signal)
  const inputRef = findRefByName(snap.tree, '姓名')
  const selectRef = findRefByName(snap.tree, '语言')
  const submitRef = findRefByName(snap.tree, '提交测试')

  console.log(`[verify-browser] ${label}: type / select / click`)
  await system.handleRuntimeCall(
    `${prefix}.type`,
    { ref: inputRef, snapshotId: snap.snapshotId, text: '林测自动化', clear: true },
    signal,
  )
  await system.handleRuntimeCall(
    `${prefix}.select`,
    { ref: selectRef, snapshotId: snap.snapshotId, value: 'zh' },
    signal,
  )
  await system.handleRuntimeCall(
    `${prefix}.click`,
    { ref: submitRef, snapshotId: snap.snapshotId },
    signal,
  )
  try {
    await system.handleRuntimeCall(
      `${prefix}.wait`,
      { text: '已提交:林测自动化:zh', timeoutMs: 4000 },
      signal,
    )
  } catch (err) {
    const afterSnap = await system.handleRuntimeCall(`${prefix}.snapshot`, {}, signal)
    console.error(`[verify-browser] ${label} 点击后快照：\n${afterSnap.tree}`)
    throw err
  }

  console.log(`[verify-browser] ${label}: screenshot`)
  const shot = await system.handleRuntimeCall(`${prefix}.screenshot`, {}, signal)
  if (!shot.base64 || shot.bytes <= 100 || shot.width <= 0 || shot.height <= 0) {
    throw new Error(`${label} 截图结果无效`)
  }
  console.log(`[verify-browser] ${label}: fullPage screenshot`)
  const fullShot = await system.handleRuntimeCall(
    `${prefix}.screenshot`,
    { fullPage: true },
    signal,
  )
  if (!fullShot.base64 || fullShot.bytes <= 100 || fullShot.width <= 0 || fullShot.height <= 0) {
    throw new Error(`${label} 整页截图结果无效`)
  }
  console.log(`[verify-browser] ${label}: diagnostics`)
  const diag = await system.handleRuntimeCall(`${prefix}.diagnostics`, {}, signal)
  const hasSubmitLog = diag.console.some(entry => entry.text.includes('MYDSH_SUBMIT_TRIGGERED'))
  const echoNet = diag.network.find(entry => entry.url.includes('/api/echo'))
  if (!hasSubmitLog) throw new Error(`${label} 未捕获到页面 Console 日志`)
  if (!echoNet || !echoNet.url.includes('token=%5BREDACTED%5D')) {
    throw new Error(`${label} 未捕获或未脱敏网络请求：${JSON.stringify(echoNet)}`)
  }
  console.log(
    `[verify-browser] ${label} 通过：snapshot(${snap.elementsCount} 元素) + 中文表单提交 + screenshot(${shot.width}x${shot.height}, ${shot.bytes}B) + 脱敏诊断`,
  )
}

async function runModeChecks({ system, browserController, embeddedDriver, externalDriver }) {
  if (mode === 'all' || mode === 'embedded') {
    // 模拟用户已手动打开一个空白页签，验证 AI 自动复用该页签而不额外生成隐形 default 标签。
    browserController.ensureTab('user-blank-tab')
    await runBrowserRoundtrip(system, 'embedded', '内置 WebContentsView CDP')
    const embeddedTabs = browserController.listTabs()
    if (embeddedTabs.length !== 1 || embeddedTabs[0].tabId !== 'user-blank-tab') {
      throw new Error(
        `预期复用已有页签 user-blank-tab，实际页签列表：${JSON.stringify(embeddedTabs)}`,
      )
    }
    const wc = browserController.getWebContents('user-blank-tab')
    await embeddedDriver.dispose()
    if (wc && !wc.isDestroyed() && wc.debugger.isAttached()) {
      throw new Error('内置浏览器驱动释放后 debugger 未正确分离')
    }
  }
  if (mode === 'all' || mode === 'external') {
    const detected = await externalDriver.detect()
    if (detected.length === 0) {
      console.log(
        '[verify-browser] 本机未检测到 Chrome/Edge/Brave/Chromium，跳过真实外置实例拉起。',
      )
      return
    }
    console.log(`[verify-browser] 检测到本机浏览器：${detected.map(b => b.name).join(', ')}`)
    await runBrowserRoundtrip(system, 'external', `外置托管 ${detected[0].name} CDP`)
    await externalDriver.stop()
    if (externalDriver.status().connected) {
      throw new Error('外置浏览器停止后连接状态未归零')
    }
  }
}

async function main() {
  await app.whenReady()
  let win = null
  let browserController = null
  let system = null
  let exitCode = 0
  try {
    win = new BrowserWindow({
      width: 1280,
      height: 800,
      show: true,
      focusable: false,
      opacity: 0,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    browserController = installBrowserController({
      window: win,
      assertSender: () => {},
    })
    const embeddedDriver = createEmbeddedBrowserDriver(browserController)
    const externalDriver = createExternalBrowserDriver({
      profileDirectory: join(verifyHome, 'external-profile'),
      headless: true,
      scaler: scaleImageWithNativeImage,
    })
    system = createAutomationSystem({
      settingsPath: join(verifyHome, 'automation.json'),
      headless: true,
    })
    system.registerDrivers({
      callEmbeddedBrowser: embeddedDriver.call,
      dispose: embeddedDriver.dispose,
    })
    system.registerDrivers({
      callExternalBrowser: externalDriver.call,
      detectExternalBrowsers: externalDriver.detect,
      testExternalBrowser: externalDriver.testConnection,
      externalStatus: externalDriver.status,
      stopExternal: externalDriver.stop,
      dispose: externalDriver.dispose,
    })
    system.updateSettings({
      embeddedBrowser: { enabled: true },
      externalBrowser: { enabled: true, mode: 'managed' },
    })
    await runModeChecks({ system, browserController, embeddedDriver, externalDriver })
    console.log('mydsh-browser-automation-verify: complete')
  } catch (error) {
    exitCode = 1
    console.error('[verify-browser] 验收失败：', error)
  } finally {
    if (system) await system.dispose().catch(() => {})
    if (browserController) browserController.dispose()
    if (win && !win.isDestroyed()) win.destroy()
    app.exit(exitCode)
  }
}

void main()
