/**
 * 桌面 Computer Use 显示器与窗口截屏辅助：支持独立窗口缓冲抓取（即使窗口位于后台被遮挡也能清晰截取）与整屏裁剪回退。
 * 运行在 Electron 主进程，供 `computer-use-driver.ts` 复用。
 */
import { clipboard, desktopCapturer, screen, type Display } from 'electron'
import type { AutomationPermissionStatus, AutomationSettings } from '../../shared/automation.ts'
import { resolvePlatformKey, type ComputerUseNativeAddon } from './computer-use-native.ts'
import {
  intersectRect,
  isWindowBlocked,
  type ComputerUseDisplayInfo,
  type ComputerUseWindowInfo,
  type LogicalRect,
} from './computer-use-policy.ts'

/** 聚合平台支持、原生模块与 macOS/Windows 权限状态。 */
export function buildComputerPermissionStatus(
  addon: ComputerUseNativeAddon | null,
): AutomationPermissionStatus {
  let platform: AutomationPermissionStatus['platform'] = 'other'
  if (process.platform === 'darwin') platform = 'darwin'
  else if (process.platform === 'win32') platform = 'win32'
  if (platform === 'other') {
    return {
      platform,
      supported: false,
      nativeLoaded: false,
      accessibility: false,
      screenRecording: false,
      note: '系统级桌面操控仅支持 macOS 与 Windows。',
    }
  }
  if (!addon) {
    return {
      platform,
      supported: true,
      nativeLoaded: false,
      accessibility: false,
      screenRecording: false,
      note: '未加载 lib/main/computer-use.node 原生模块，请重新构建应用。',
    }
  }
  const perms = addon.checkPermissions()
  let note: string | undefined
  if (platform === 'darwin' && (!perms.accessibility || !perms.screenRecording)) {
    note =
      '在 macOS「系统设置 → 隐私与安全性」授予辅助功能与屏幕录制权限后，通常需要重启 MyDSH 才能完全生效。'
  } else if (platform === 'win32' && perms.elevated === false) {
    note = '当前为标准用户权限运行，无法操控以管理员身份提权的窗口。'
  }
  return {
    platform,
    supported: true,
    nativeLoaded: true,
    accessibility: Boolean(perms.accessibility),
    screenRecording: Boolean(perms.screenRecording),
    ...(perms.elevated === undefined ? {} : { elevated: Boolean(perms.elevated) }),
    ...(note ? { note } : {}),
  }
}

function toDisplayInfo(display: Display, primaryId: number): ComputerUseDisplayInfo {
  return {
    id: display.id,
    label: display.label || `显示器 ${display.id}`,
    bounds: {
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
    },
    scaleFactor: display.scaleFactor || 1,
    primary: display.id === primaryId,
  }
}

/** 枚举当前系统全部逻辑显示器及其缩放系数。 */
export function listSystemDisplays(): ComputerUseDisplayInfo[] {
  const primaryId = screen.getPrimaryDisplay().id
  return screen.getAllDisplays().map(display => toDisplayInfo(display, primaryId))
}

/** 根据显式显示器 ID 或目标窗口中心点挑选最匹配的逻辑显示器。 */
export function pickTargetDisplay(
  displays: readonly ComputerUseDisplayInfo[],
  displayId: number | undefined,
  windowRect?: LogicalRect,
): ComputerUseDisplayInfo {
  if (displayId !== undefined) {
    const exact = displays.find(item => item.id === displayId)
    if (exact) return exact
  }
  if (windowRect) {
    const centerX = windowRect.x + windowRect.width / 2
    const centerY = windowRect.y + windowRect.height / 2
    const containing = displays.find(
      item =>
        centerX >= item.bounds.x &&
        centerX <= item.bounds.x + item.bounds.width &&
        centerY >= item.bounds.y &&
        centerY <= item.bounds.y + item.bounds.height,
    )
    if (containing) return containing
  }
  const primary = displays.find(item => item.primary) ?? displays[0]
  if (!primary) throw new Error('未检测到可用显示器')
  return primary
}

/** Windows 平台将原生物理像素坐标矩形统一换算为 Electron 逻辑 DIP，macOS 与无 DPI 换算环境保持原值。 */
export function normalizeNativeWindowsForPlatform(
  windows: readonly ComputerUseWindowInfo[],
): ComputerUseWindowInfo[] {
  if (process.platform !== 'win32' || typeof screen.screenToDipRect !== 'function') {
    return [...windows]
  }
  return windows.map(win => {
    const dip = screen.screenToDipRect(null, {
      x: Math.round(win.bounds.x),
      y: Math.round(win.bounds.y),
      width: Math.max(1, Math.round(win.bounds.width)),
      height: Math.max(1, Math.round(win.bounds.height)),
    })
    return {
      ...win,
      bounds: { x: dip.x, y: dip.y, width: dip.width, height: dip.height },
    }
  })
}

/** Windows 平台将原生 `GetCursorPos` 物理坐标换算为逻辑 DIP 坐标。 */
export function normalizeNativePointForPlatform(point: { x: number; y: number }): {
  x: number
  y: number
} {
  if (process.platform !== 'win32' || typeof screen.screenToDipPoint !== 'function') {
    return point
  }
  const dip = screen.screenToDipPoint({ x: Math.round(point.x), y: Math.round(point.y) })
  return { x: dip.x, y: dip.y }
}

/** Windows 平台将逻辑 DIP 坐标换算回原生 `SendInput` 物理像素坐标。 */
export function toNativePointForPlatform(point: { x: number; y: number }): {
  x: number
  y: number
} {
  if (process.platform !== 'win32' || typeof screen.dipToScreenPoint !== 'function') {
    return point
  }
  const phys = screen.dipToScreenPoint({ x: Math.round(point.x), y: Math.round(point.y) })
  return { x: phys.x, y: phys.y }
}

/** 优先通过 `desktopCapturer` 独立窗口通道抓取后台非焦点窗口本体画面，不被前方 MyDSH 遮挡。 */
export async function captureIndependentWindowThumbnail(
  targetWindow: ComputerUseWindowInfo,
  scaleFactor: number,
  signal: AbortSignal,
): Promise<Electron.NativeImage | null> {
  if (targetWindow.windowId <= 0) return null
  const factor = Math.min(2, Math.max(1, scaleFactor))
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: {
        width: Math.max(320, Math.round(targetWindow.bounds.width * factor)),
        height: Math.max(240, Math.round(targetWindow.bounds.height * factor)),
      },
    })
    signal.throwIfAborted()
    const prefix = `window:${targetWindow.windowId}:`
    const matched = sources.find(item => item.id.startsWith(prefix))
    if (!matched || matched.thumbnail.isEmpty()) return null
    return matched.thumbnail
  } catch (error) {
    if (signal.aborted) throw error
    return null
  }
}

/** 截取指定逻辑显示器的完整屏幕画面。 */
export async function captureDisplayThumbnail(
  display: ComputerUseDisplayInfo,
  signal: AbortSignal,
): Promise<Electron.NativeImage> {
  const factor = Math.min(2, display.scaleFactor)
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.max(320, Math.round(display.bounds.width * factor)),
      height: Math.max(240, Math.round(display.bounds.height * factor)),
    },
  })
  signal.throwIfAborted()
  const exact = sources.find(item => item.display_id === String(display.id))
  const source = exact ?? (sources.length === 1 ? sources[0] : undefined)
  if (!source || source.thumbnail.isEmpty()) {
    throw new Error('SCREEN_CAPTURE_EMPTY：系统未能返回所选显示器画面，请确认屏幕录制权限已生效')
  }
  return source.thumbnail
}

/** 从整屏截图中按窗口与显示器的可见交集裁剪出窗口画面（独立窗口抓取不可用时的回退路径）。 */
export function cropWindowFromThumbnail(
  thumbnail: Electron.NativeImage,
  displayBounds: LogicalRect,
  windowBounds: LogicalRect,
): { image: Electron.NativeImage; clip: LogicalRect } {
  const clip = intersectRect(displayBounds, windowBounds)
  if (!clip) throw new Error('目标窗口不在所选显示器可见范围内')
  const rawSize = thumbnail.getSize()
  const rx = rawSize.width / displayBounds.width
  const ry = rawSize.height / displayBounds.height
  const cropX = Math.max(
    0,
    Math.min(rawSize.width - 1, Math.floor((clip.x - displayBounds.x) * rx)),
  )
  const cropY = Math.max(
    0,
    Math.min(rawSize.height - 1, Math.floor((clip.y - displayBounds.y) * ry)),
  )
  const cropWidth = Math.max(1, Math.min(rawSize.width - cropX, Math.ceil(clip.width * rx)))
  const cropHeight = Math.max(1, Math.min(rawSize.height - cropY, Math.ceil(clip.height * ry)))
  const cropped = thumbnail.crop({ x: cropX, y: cropY, width: cropWidth, height: cropHeight })
  return { image: cropped, clip }
}

async function callNativeWindowCapture(
  addon: ComputerUseNativeAddon | null,
  windowId: number,
  maxLongEdge: number,
) {
  if (typeof addon?.captureWindowPngAsync === 'function') {
    return addon.captureWindowPngAsync(windowId, maxLongEdge)
  }
  if (typeof addon?.captureWindowPng === 'function') {
    return addon.captureWindowPng(windowId, maxLongEdge)
  }
  return null
}

/** 抓取目标窗口或显示器原图：macOS 优先使用全异步 ScreenCaptureKit 去阴影截帧，其次回退到桌面裁剪。 */
export async function captureTargetImage(input: {
  addon: ComputerUseNativeAddon | null
  display: ComputerUseDisplayInfo
  targetWindow?: ComputerUseWindowInfo
  maxLongEdge?: number
  signal: AbortSignal
}): Promise<{
  image?: Electron.NativeImage
  rawPng?: Buffer
  windowClip?: LogicalRect
  captureMethod: string
}> {
  const { addon, display, targetWindow, maxLongEdge = 1280, signal } = input
  if (targetWindow) {
    const sck = await callNativeWindowCapture(addon, targetWindow.windowId, maxLongEdge)
    signal.throwIfAborted()
    if (sck && sck.png.byteLength > 0 && sck.bounds.width >= 8 && sck.bounds.height >= 8) {
      return { rawPng: sck.png, windowClip: sck.bounds, captureMethod: 'screencapturekit' }
    }
  }
  if (targetWindow) {
    const independent = await captureIndependentWindowThumbnail(
      targetWindow,
      display.scaleFactor,
      signal,
    )
    if (independent) {
      return {
        image: independent,
        windowClip: targetWindow.bounds,
        captureMethod: 'desktop-capturer-window',
      }
    }
  }
  const screenImg = await captureDisplayThumbnail(display, signal)
  if (!targetWindow) return { image: screenImg, captureMethod: 'desktop-capturer-screen' }
  const cropped = cropWindowFromThumbnail(screenImg, display.bounds, targetWindow.bounds)
  return { image: cropped.image, windowClip: cropped.clip, captureMethod: 'screen-crop' }
}

/** 校验原生模块与 macOS 辅助功能权限是否就绪。 */
export function assertAccessibilityReady(
  addon: ComputerUseNativeAddon | null,
): ComputerUseNativeAddon {
  if (!addon) {
    throw new Error('NATIVE_UNAVAILABLE：桌面操控原生模块未加载，当前环境不支持键鼠控制')
  }
  const perms = addon.checkPermissions()
  if (process.platform === 'darwin' && !perms.accessibility) {
    throw new Error(
      'PERMISSION_DENIED：缺少 macOS「辅助功能」权限，请在「设置 → 浏览器与桌面操控」打开系统设置授权并重启 MyDSH',
    )
  }
  return addon
}

/** 校验目标窗口不在防自锁与敏感应用黑名单内。 */
export function assertWindowAllowed(
  window: ComputerUseWindowInfo,
  settings: AutomationSettings,
  selfPid: number,
): void {
  const check = isWindowBlocked({
    window,
    blockedApps: settings.computerUse.blockedApps,
    selfPid,
  })
  if (check.blocked) throw new Error(check.reason ?? 'SECURITY_BLOCK：目标窗口受保护，禁止操控')
}

/** 支持 AbortSignal 取消的轻量异步等待。 */
export async function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('桌面操作已取消'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function runNativeKeyTap(
  addon: ComputerUseNativeAddon,
  args: { keyCode: number; modifierMask: number; targetPid: number; restoreFocus: boolean },
): Promise<boolean> {
  if (typeof addon.keyTapAsync === 'function') {
    return addon.keyTapAsync(args.keyCode, args.modifierMask, args.targetPid, args.restoreFocus)
  }
  return addon.keyTap(args.keyCode, args.modifierMask, args.targetPid, args.restoreFocus)
}

async function tapResolvedKey(
  addon: ComputerUseNativeAddon,
  keySpec: string,
  opts: {
    targetPid: number
    restoreFocus: boolean
    delayMs: number
    actionLabel: string
    signal: AbortSignal
  },
): Promise<void> {
  const key = resolvePlatformKey(keySpec)
  const ok = await runNativeKeyTap(addon, {
    keyCode: key.keyCode,
    modifierMask: key.modifierMask,
    targetPid: opts.targetPid,
    restoreFocus: opts.restoreFocus,
  })
  if (!ok) throw new Error(`SELF_LOCK_GUARD：目标窗口未能取得前台焦点，已拦截${opts.actionLabel}`)
  await abortableSleep(opts.delayMs, opts.signal)
}

function restoreAfterClipboardPaste(
  addon: ComputerUseNativeAddon,
  previousClipboard: string,
  wroteClipboard: boolean,
): void {
  try {
    addon.releaseAllModifiers()
  } catch {
    /* 释放修饰键异常不影响后续剪贴板还原。 */
  }
  if (!wroteClipboard) return
  try {
    clipboard.writeText(previousClipboard)
  } catch {
    /* 剪贴板还原失败不阻塞调用结束。 */
  }
}

/** 通过临时备份/还原系统剪贴板向目标窗口粘贴 UTF-8 文本，兼容中文、多行、清空与可选微激活恢复焦点。 */
export async function pasteWithClipboardBackup(input: {
  addon: ComputerUseNativeAddon
  text: string
  clear?: boolean
  submit?: boolean
  targetPid?: number
  restoreFocus?: boolean
  signal: AbortSignal
}): Promise<void> {
  const {
    addon,
    text,
    clear = false,
    submit = false,
    targetPid = 0,
    restoreFocus = false,
    signal,
  } = input
  signal.throwIfAborted()
  const previousClipboard = clipboard.readText()
  const mod = process.platform === 'darwin' ? 'Command' : 'Control'
  let wroteClipboard = false
  try {
    clipboard.writeText(text)
    wroteClipboard = true
    await abortableSleep(25, signal)
    if (clear) {
      await tapResolvedKey(addon, `${mod}+A`, {
        targetPid,
        restoreFocus: false,
        delayMs: 25,
        actionLabel: '全选清空操作',
        signal,
      })
      await tapResolvedKey(addon, 'Backspace', {
        targetPid,
        restoreFocus: false,
        delayMs: 25,
        actionLabel: '清空按键',
        signal,
      })
    }
    await tapResolvedKey(addon, `${mod}+V`, {
      targetPid,
      restoreFocus: submit ? false : restoreFocus,
      delayMs: 80,
      actionLabel: '粘贴（当前仍为 MyDSH）',
      signal,
    })
    if (submit) {
      await tapResolvedKey(addon, 'Enter', {
        targetPid,
        restoreFocus,
        delayMs: 45,
        actionLabel: '提交回车',
        signal,
      })
    }
  } finally {
    restoreAfterClipboardPaste(addon, previousClipboard, wroteClipboard)
  }
}
