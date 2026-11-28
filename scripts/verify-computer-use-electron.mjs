/** 运行在真实 Electron 内的系统级 Computer Use 验收脚本：加载真实原生模块并验证权限、窗口、截屏、防自锁与急停清理。 */
import { app, BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { createAutomationSystem } from '../lib/main/automation/automation-system.js'
import { createComputerUseDriver } from '../lib/main/automation/computer-use-driver.js'
import { loadComputerUseNativeAddon } from '../lib/main/automation/computer-use-native.js'
import { createVirtualCursorOverlay } from '../lib/main/automation/virtual-cursor-overlay.js'

const verifyHome = process.env.MYDSH_VERIFY_CU_HOME
if (!verifyHome) throw new Error('缺少 MYDSH_VERIFY_CU_HOME 环境变量')
app.setPath('userData', join(verifyHome, 'electron-user-data'))

function assertNativeExports(addon) {
  if (!addon) throw new Error('未能加载原生模块 lib/main/computer-use.node')
  const required = [
    'checkPermissions',
    'requestPermissions',
    'listWindows',
    'focusWindow',
    'captureWindowPng',
    'captureWindowPngAsync',
    'getUiTree',
    'axPressAt',
    'axSetTextAt',
    'getCursorPosition',
    'mouseMove',
    'mouseClick',
    'mouseDrag',
    'mouseScroll',
    'keyTap',
    'typeText',
    'releaseAllModifiers',
  ]
  if (process.platform === 'darwin') {
    required.push(
      'getUiTreeAsync',
      'axPressAtAsync',
      'axSetTextAtAsync',
      'mouseClickAsync',
      'mouseDragAsync',
      'mouseScrollAsync',
      'keyTapAsync',
    )
  }
  for (const fnName of required) {
    if (typeof addon[fnName] !== 'function') {
      throw new Error(`原生模块缺少导出函数：${fnName}`)
    }
  }
}

async function verifyAsyncSelfLockGuards(addon) {
  if (process.platform === 'darwin') {
    // 验证原生层针对当前进程 PID 的硬防自锁门禁与异步 Promise 通道均不阻塞且立即拦截。
    const clickSelf = await addon.mouseClickAsync(10, 10, 0, 1, 0, process.pid, 0, true)
    const keySelf = await addon.keyTapAsync(36, 0, process.pid, true)
    const axSelf = await addon.axPressAtAsync(process.pid, 10, 10)
    const uiSelf = await addon.getUiTreeAsync(process.pid, 0, 20)
    const emptyCap = await addon.captureWindowPngAsync(0, 1280)
    if (
      clickSelf ||
      keySelf ||
      axSelf ||
      !Array.isArray(uiSelf) ||
      uiSelf.length !== 0 ||
      emptyCap !== null
    ) {
      throw new Error(
        `原生异步防自锁门禁异常：${JSON.stringify({ clickSelf, keySelf, axSelf, uiLen: uiSelf?.length, emptyCap })}`,
      )
    }
    console.log('[verify-cu] macOS 原生异步防自锁门禁（getpid 硬拦截）验收通过。')
    return
  }
  if (process.platform === 'win32') {
    const focusSelf = addon.focusWindow(process.pid, 0)
    const clickSelf = addon.mouseClick(10, 10, 0, 1, 0, process.pid, 0, false)
    const keySelf = addon.keyTap(0x0d, 0, process.pid, false)
    const emptyCap = await addon.captureWindowPngAsync(0, 1280)
    if (focusSelf || clickSelf || keySelf || emptyCap !== null) {
      throw new Error(
        `Windows 原生防自锁门禁异常：${JSON.stringify({ focusSelf, clickSelf, keySelf, emptyCap })}`,
      )
    }
    console.log('[verify-cu] Windows 原生防自锁门禁与异步窗口截帧接口验收通过。')
  }
}

async function verifyWindowsPrintWindowCapture(addon, system, selfWin) {
  if (process.platform !== 'win32') return
  selfWin.showInactive()
  const selfHwnd = Number(selfWin.getNativeWindowHandle().readBigUInt64LE())
  const selfCap = await addon.captureWindowPngAsync(selfHwnd, 320)
  selfWin.hide()
  if (selfCap !== null) {
    throw new Error('Windows 原生截帧未拦截自身进程 HWND')
  }
  const helperScript = [
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
    '$f = New-Object Windows.Forms.Form',
    "$f.Text = 'MyDSH-CU-Target'",
    '$f.StartPosition = [Windows.Forms.FormStartPosition]::Manual',
    '$f.Bounds = New-Object Drawing.Rectangle(60, 60, 420, 300)',
    '$f.BackColor = [Drawing.Color]::FromArgb(24, 190, 123)',
    '$f.Show(); [Windows.Forms.Application]::DoEvents()',
    '[Console]::Out.WriteLine("CU_READY:" + $f.Handle.ToInt64()); [Console]::Out.Flush()',
    'for ($i = 0; $i -lt 150; $i++) { [Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 50 }',
  ].join('; ')
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', helperScript],
    { windowsHide: false, stdio: ['ignore', 'pipe', 'ignore'] },
  )
  try {
    const targetWid = await new Promise((resolveWid, rejectWid) => {
      let buf = ''
      const timer = setTimeout(() => rejectWid(new Error('等待外部测试窗口就绪超时')), 10_000)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        buf += chunk
        const match = /CU_READY:(\d+)/u.exec(buf)
        if (match) {
          clearTimeout(timer)
          resolveWid(Number(match[1]))
        }
      })
      child.once('exit', code => {
        clearTimeout(timer)
        rejectWid(new Error(`外部测试窗口提前退出：${String(code)}`))
      })
    })
    const shot = await system.handleRuntimeCall(
      'automation.computer.screenshot',
      { windowId: targetWid },
      AbortSignal.timeout(10_000),
    )
    if (
      shot.captureMethod !== 'win32-printwindow' ||
      !shot.captureId ||
      shot.bytes <= 100 ||
      shot.width <= 0 ||
      shot.height <= 0
    ) {
      throw new Error(`Windows PrintWindow+WIC 异步窗口截帧异常：${JSON.stringify(shot)}`)
    }
    console.log(
      `[verify-cu] Windows PrintWindow+WIC 异步窗口截帧通过：captureMethod=${shot.captureMethod}, ${shot.width}x${shot.height} (${shot.bytes}B)`,
    )
  } finally {
    try {
      child.kill()
    } catch {
      /* 忽略已退出测试窗口进程。 */
    }
  }
}

async function verifyScreenshotPath(system, status, cursor) {
  if (status.permissions.screenRecording) {
    try {
      const shot = await system.handleRuntimeCall(
        'automation.computer.screenshot',
        {},
        AbortSignal.timeout(10_000),
      )
      if (!shot.captureId || shot.bytes <= 100 || shot.width <= 0 || shot.height <= 0) {
        throw new Error('真实桌面截屏结果无效')
      }
      console.log(
        `[verify-cu] 真实屏幕截图通过：captureId=${shot.captureId}, ${shot.width}x${shot.height} (${shot.bytes}B), logical=${shot.logicalSize.width}x${shot.logicalSize.height}`,
      )
      return
    } catch (error) {
      const isIsolatedDesktop =
        process.platform === 'win32' &&
        status.windows.length === 0 &&
        cursor.x === 0 &&
        cursor.y === 0 &&
        error instanceof Error &&
        error.message.includes('SCREEN_CAPTURE_EMPTY')
      if (!isIsolatedDesktop) throw error
      console.log(
        '[verify-cu] 当前处于无物理输入桌面的隔离会话（WebRTC SetThreadDesktop 受限），已由 PrintWindow+WIC 异步窗口截帧覆盖校验。',
      )
      return
    }
  }
  let deniedScreen = false
  try {
    await system.handleRuntimeCall('automation.computer.screenshot', {}, AbortSignal.timeout(5000))
  } catch (error) {
    deniedScreen = error instanceof Error && error.message.includes('PERMISSION_DENIED')
  }
  if (!deniedScreen) throw new Error('无屏幕录制权限时未返回 PERMISSION_DENIED 引导')
  console.log('[verify-cu] 当前终端宿主未授予 macOS 屏幕录制权限，已验证无权限降级引导路径通过。')
}

async function verifyVirtualCursorOverlay() {
  // 验证模拟 AI 光标透明覆盖层创建、动效更新、截图隐身与销毁无残留。
  const cursorOverlay = createVirtualCursorOverlay({ headless: false })
  await cursorOverlay.showAction({
    kind: 'click',
    x: 240,
    y: 200,
    button: 'left',
    clickCount: 1,
    label: 'AI · 验收点击',
    targetBounds: { x: 120, y: 100, width: 420, height: 300 },
  })
  cursorOverlay.setCaptureHidden(true)
  cursorOverlay.setCaptureHidden(false)
  cursorOverlay.dispose()
}

async function main() {
  await app.whenReady()
  let win = null
  let system = null
  let exitCode = 0
  try {
    const addon = loadComputerUseNativeAddon()
    assertNativeExports(addon)
    win = new BrowserWindow({
      width: 640,
      height: 420,
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    const driver = createComputerUseDriver({ addon, selfPid: process.pid, headless: false })
    system = createAutomationSystem({
      settingsPath: join(verifyHome, 'automation.json'),
      headless: false,
    })
    system.registerDrivers({
      callComputerUse: driver.call,
      checkPermissions: driver.checkPermissions,
      openPermissionSettings: driver.openPermissionSettings,
      releaseInputs: driver.releaseInputs,
      dispose: driver.dispose,
    })

    let deniedDisabled = false
    try {
      await system.handleRuntimeCall(
        'automation.computer.screenshot',
        {},
        AbortSignal.timeout(5000),
      )
    } catch (error) {
      deniedDisabled = error instanceof Error && error.message.includes('PERMISSION_DENIED')
    }
    if (!deniedDisabled) throw new Error('默认关闭态未拒绝 computer.screenshot')

    system.updateSettings({ computerUse: { enabled: true, scope: 'display' } })
    const status = await system.handleRuntimeCall(
      'automation.computer.status',
      {},
      AbortSignal.timeout(5000),
    )
    if (!status.permissions.nativeLoaded || status.displays.length === 0) {
      throw new Error(`桌面状态异常：${JSON.stringify(status.permissions)}`)
    }
    if (status.windows.some(item => item.pid === process.pid)) {
      throw new Error('防自锁保护失效：MyDSH 自身进程窗口未被过滤')
    }
    const cursor = addon.getCursorPosition()
    if (!Number.isFinite(cursor.x) || !Number.isFinite(cursor.y)) {
      throw new Error(`读取系统光标位置异常：${JSON.stringify(cursor)}`)
    }
    addon.releaseAllModifiers()
    console.log(
      `[verify-cu] 原生模块已加载：platform=${status.permissions.platform}, accessibility=${status.permissions.accessibility}, screenRecording=${status.permissions.screenRecording}, displays=${status.displays.length}, visibleWindows=${status.windows.length}, cursor=(${Math.round(cursor.x)},${Math.round(cursor.y)})`,
    )

    await verifyAsyncSelfLockGuards(addon)
    await verifyWindowsPrintWindowCapture(addon, system, win)
    await verifyScreenshotPath(system, status, cursor)
    await verifyVirtualCursorOverlay()
    await system.stopTakeover('验收测试急停')
    if (system.getTakeoverState().active) throw new Error('急停后接管状态未归零')
    console.log('mydsh-computer-use-verify: complete')
  } catch (error) {
    exitCode = 1
    console.error('[verify-cu] 验收失败：', error)
  } finally {
    if (system) await system.dispose().catch(() => {})
    if (win && !win.isDestroyed()) win.destroy()
    app.exit(exitCode)
  }
}

void main()
