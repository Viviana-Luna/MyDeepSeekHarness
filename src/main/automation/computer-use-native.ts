/**
 * 桌面 Computer Use 原生模块加载与跨平台键码适配层。
 * 运行在 Electron 主进程：按平台安全加载 `lib/main/computer-use.node`，并提供 macOS/Windows 虚拟键码映射与系统权限设置跳转。
 */
import { createRequire } from 'node:module'
import { shell } from 'electron'
import type { ComputerUseWindowInfo, LogicalRect } from './computer-use-policy.ts'

/** 原生无障碍树返回的可交互控件节点。 */
export interface NativeUiElement {
  readonly role: string
  readonly title: string
  readonly value: string
  readonly editable: boolean
  readonly pressable: boolean
  readonly bounds: LogicalRect
}

/** ScreenCaptureKit 独立去阴影窗口截帧结果。 */
export interface NativeWindowCaptureResult {
  readonly png: Buffer
  readonly bounds: LogicalRect
}

/** 双端（macOS `.m` / Windows `.cc`）导出的统一原生 N-API 接口。 */
export interface ComputerUseNativeAddon {
  checkPermissions(): { accessibility: boolean; screenRecording: boolean; elevated?: boolean }
  requestPermissions(): { accessibility: boolean; screenRecording: boolean }
  listWindows(): ComputerUseWindowInfo[]
  focusWindow(pid: number, windowId?: number): boolean
  captureWindowPng?(windowId: number, maxLongEdge?: number): NativeWindowCaptureResult | null
  captureWindowPngAsync?(
    windowId: number,
    maxLongEdge?: number,
  ): Promise<NativeWindowCaptureResult | null>
  getUiTree?(pid: number, windowId?: number, maxNodes?: number): NativeUiElement[]
  getUiTreeAsync?(pid: number, windowId?: number, maxNodes?: number): Promise<NativeUiElement[]>
  axPressAt?(pid: number, x: number, y: number): boolean
  axPressAtAsync?(pid: number, x: number, y: number): Promise<boolean>
  axSetTextAt?(pid: number, x: number, y: number, text: string): boolean
  axSetTextAtAsync?(pid: number, x: number, y: number, text: string): Promise<boolean>
  getCursorPosition(): { x: number; y: number }
  mouseMove(x: number, y: number): boolean
  mouseClick(
    x: number,
    y: number,
    buttonCode: number,
    clickCount: number,
    modifierMask: number,
    targetPid?: number,
    targetWindowId?: number,
    restoreFocus?: boolean,
  ): boolean
  mouseClickAsync?(
    x: number,
    y: number,
    buttonCode: number,
    clickCount: number,
    modifierMask: number,
    targetPid?: number,
    targetWindowId?: number,
    restoreFocus?: boolean,
  ): Promise<boolean>
  mouseDrag(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    steps: number,
    targetPid?: number,
    targetWindowId?: number,
    restoreFocus?: boolean,
  ): boolean
  mouseDragAsync?(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    steps: number,
    targetPid?: number,
    targetWindowId?: number,
    restoreFocus?: boolean,
  ): Promise<boolean>
  mouseScroll(
    x: number,
    y: number,
    deltaX: number,
    deltaY: number,
    targetPid?: number,
    targetWindowId?: number,
    activateIfOccluded?: boolean,
  ): boolean
  mouseScrollAsync?(
    x: number,
    y: number,
    deltaX: number,
    deltaY: number,
    targetPid?: number,
    targetWindowId?: number,
    activateIfOccluded?: boolean,
  ): Promise<boolean>
  keyTap(keyCode: number, modifierMask: number, targetPid?: number, restoreFocus?: boolean): boolean
  keyTapAsync?(
    keyCode: number,
    modifierMask: number,
    targetPid?: number,
    restoreFocus?: boolean,
  ): Promise<boolean>
  typeText?(text: string, targetPid?: number, restoreFocus?: boolean): boolean
  releaseAllModifiers(): boolean
}

let cachedAddon: ComputerUseNativeAddon | null | undefined

/** 按需加载 `lib/main/computer-use.node`；在未构建原生模块或非 macOS/Windows 平台返回 null 而不崩溃。 */
export function loadComputerUseNativeAddon(): ComputerUseNativeAddon | null {
  if (cachedAddon !== undefined) return cachedAddon
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    cachedAddon = null
    return null
  }
  try {
    const req = createRequire(import.meta.url)
    cachedAddon = req('../computer-use.node') as ComputerUseNativeAddon
  } catch {
    cachedAddon = null
  }
  return cachedAddon
}

const MAC_KEY_CODES: Record<string, number> = {
  a: 0,
  s: 1,
  d: 2,
  f: 3,
  h: 4,
  g: 5,
  z: 6,
  x: 7,
  c: 8,
  v: 9,
  b: 11,
  q: 12,
  w: 13,
  e: 14,
  r: 15,
  y: 16,
  t: 17,
  '1': 18,
  '2': 19,
  '3': 20,
  '4': 21,
  '6': 22,
  '5': 23,
  '=': 24,
  '9': 25,
  '7': 26,
  '-': 27,
  '8': 28,
  '0': 29,
  ']': 30,
  o: 31,
  u: 32,
  '[': 33,
  i: 34,
  p: 35,
  enter: 36,
  return: 36,
  l: 37,
  j: 38,
  "'": 39,
  k: 40,
  ';': 41,
  '\\': 42,
  ',': 43,
  '/': 44,
  n: 45,
  m: 46,
  '.': 47,
  tab: 48,
  space: 49,
  '`': 50,
  backspace: 51,
  escape: 53,
  esc: 53,
  f5: 96,
  f6: 97,
  f7: 98,
  f3: 99,
  f8: 100,
  f9: 101,
  f11: 103,
  f10: 109,
  f12: 111,
  home: 115,
  pageup: 116,
  delete: 117,
  f4: 118,
  end: 119,
  f2: 120,
  pagedown: 121,
  f1: 122,
  arrowleft: 123,
  left: 123,
  arrowright: 124,
  right: 124,
  arrowdown: 125,
  down: 125,
  arrowup: 126,
  up: 126,
}

const WIN_KEY_CODES: Record<string, number> = {
  backspace: 0x08,
  tab: 0x09,
  enter: 0x0d,
  return: 0x0d,
  escape: 0x1b,
  esc: 0x1b,
  space: 0x20,
  pageup: 0x21,
  pagedown: 0x22,
  end: 0x23,
  home: 0x24,
  arrowleft: 0x25,
  left: 0x25,
  arrowup: 0x26,
  up: 0x26,
  arrowright: 0x27,
  right: 0x27,
  arrowdown: 0x28,
  down: 0x28,
  delete: 0x2e,
  f1: 0x70,
  f2: 0x71,
  f3: 0x72,
  f4: 0x73,
  f5: 0x74,
  f6: 0x75,
  f7: 0x76,
  f8: 0x77,
  f9: 0x78,
  f10: 0x79,
  f11: 0x7a,
  f12: 0x7b,
  ';': 0xba,
  '=': 0xbb,
  ',': 0xbc,
  '-': 0xbd,
  '.': 0xbe,
  '/': 0xbf,
  '`': 0xc0,
  '[': 0xdb,
  '\\': 0xdc,
  ']': 0xdd,
  "'": 0xde,
}

/** 将修饰键名称数组编码为跨平台位掩码（Alt=1, Control=2, Meta=4, Shift=8）。 */
export function encodeModifierMask(modifiers: readonly string[]): number {
  let mask = 0
  for (const mod of modifiers) {
    const normalized = mod.trim().toLowerCase()
    if (normalized === 'alt' || normalized === 'option') mask |= 1
    else if (normalized === 'ctrl' || normalized === 'control') mask |= 2
    else if (
      normalized === 'meta' ||
      normalized === 'cmd' ||
      normalized === 'command' ||
      normalized === 'win' ||
      normalized === 'super'
    )
      mask |= 4
    else if (normalized === 'shift') mask |= 8
  }
  return mask
}

function parseKeyExpression(rawKey: string): { mainKey: string; inlineModifiers: string[] } {
  const trimmed = rawKey.trim()
  if (!trimmed) throw new Error('按键表达式不能为空')
  if (trimmed === '+') return { mainKey: '+', inlineModifiers: [] }
  // 兼容 `Command++` / `Control++` 等以 `+` 为主键的写法，避免 split('+') 丢弃主键。
  if (trimmed.endsWith('++')) {
    const prefix = trimmed.slice(0, -2)
    const inlineModifiers = prefix
      .split('+')
      .map(item => item.trim())
      .filter(Boolean)
    return { mainKey: '+', inlineModifiers }
  }
  const parts = trimmed
    .split('+')
    .map(item => item.trim())
    .filter(Boolean)
  if (parts.length === 0) throw new Error('按键表达式不能为空')
  return {
    mainKey: (parts.at(-1) ?? '').toLowerCase(),
    inlineModifiers: parts.slice(0, -1),
  }
}

/** 解析按键表达式（如 `Command+V`、`Control+Shift+Z`、`Enter`）为当前平台的虚拟键码与修饰位掩码。 */
export function resolvePlatformKey(
  rawKey: string,
  extraModifiers: readonly string[] = [],
  platform: NodeJS.Platform = process.platform,
): { keyCode: number; modifierMask: number } {
  const { mainKey, inlineModifiers } = parseKeyExpression(rawKey)
  const normalizedMain = mainKey === 'plus' || mainKey === '+' ? '=' : mainKey
  const mods = [...extraModifiers, ...inlineModifiers]
  if (mainKey === '+' || mainKey === 'plus') mods.push('shift')
  const modifierMask = encodeModifierMask(mods)

  if (platform === 'darwin') {
    const code = Object.hasOwn(MAC_KEY_CODES, normalizedMain)
      ? MAC_KEY_CODES[normalizedMain]
      : undefined
    if (code === undefined) throw new Error(`macOS 暂不支持该按键名称：${rawKey}`)
    return { keyCode: code, modifierMask }
  }
  if (platform === 'win32') {
    if (normalizedMain.length === 1 && /^[a-z0-9]$/u.test(normalizedMain)) {
      return { keyCode: normalizedMain.toUpperCase().charCodeAt(0), modifierMask }
    }
    const code = Object.hasOwn(WIN_KEY_CODES, normalizedMain)
      ? WIN_KEY_CODES[normalizedMain]
      : undefined
    if (code === undefined) throw new Error(`Windows 暂不支持该按键名称：${rawKey}`)
    return { keyCode: code, modifierMask }
  }
  throw new Error('当前平台不支持系统级键盘模拟')
}

/** 打开系统权限设置页，引导用户授予 macOS 辅助功能或屏幕录制权限。 */
export async function openSystemPermissionSettings(
  kind: 'accessibility' | 'screen-recording',
): Promise<boolean> {
  if (process.platform === 'darwin') {
    const addon = loadComputerUseNativeAddon()
    if (addon) {
      try {
        addon.requestPermissions()
      } catch {
        /* 仅尽力触发系统弹窗，随后打开设置页。 */
      }
    }
    const uri =
      kind === 'accessibility'
        ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
        : 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    await shell.openExternal(uri)
    return true
  }
  if (process.platform === 'win32') {
    await shell.openExternal('ms-settings:privacy')
    return true
  }
  return false
}
