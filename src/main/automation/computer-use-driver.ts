/**
 * 主进程系统级 Computer Use 驱动：管理屏幕/去阴影窗口截帧、AX `@uN` 控件映射、目标窗口解析、防自锁与急停释放。
 * 运行在 Electron 主进程，通过 `automation-system.ts` 接受后台 Runtime 受控调用。
 */
import { randomUUID } from 'node:crypto'
import type { AutomationPermissionStatus, AutomationSettings } from '../../shared/automation.ts'
import { readOptionalNumber, readOptionalString } from './cdp-dispatch.ts'
import {
  executeClickAction,
  executeDragAction,
  executeKeyAction,
  executeScrollAction,
  executeTypeAction,
  type ActionRuntimeContext,
} from './computer-use-actions.ts'
import {
  assertAccessibilityReady,
  assertWindowAllowed,
  buildComputerPermissionStatus,
  captureTargetImage,
  listSystemDisplays,
  normalizeNativePointForPlatform,
  normalizeNativeWindowsForPlatform,
  pickTargetDisplay,
} from './computer-use-capture.ts'
import {
  loadComputerUseNativeAddon,
  openSystemPermissionSettings,
  type ComputerUseNativeAddon,
} from './computer-use-native.ts'
import {
  assertPointInsideRect,
  buildCaptureMapping,
  buildUiElementRefs,
  compensateWindowMovement,
  detectUserMouseOverride,
  findWindowAtPoint,
  formatUiElementSummary,
  isPointOccludedByAnotherWindow,
  isWindowBlocked,
  mapCapturePointToSystem,
  type CaptureCoordinateMapping,
  type CapturedUiElementRef,
  type ComputerUseWindowInfo,
} from './computer-use-policy.ts'
import { scaleImageWithNativeImage, scaleNativeImage } from './image-scaler.ts'
import {
  createVirtualCursorOverlay,
  type VirtualCursorOverlayController,
} from './virtual-cursor-overlay.ts'

const MAX_CAPTURE_HISTORY = 16

/** 桌面 Computer Use 主进程驱动接口。 */
export interface ComputerUseDriver {
  checkPermissions(): Promise<AutomationPermissionStatus>
  openPermissionSettings(kind: 'accessibility' | 'screen-recording'): Promise<boolean>
  releaseInputs(): void
  call(
    action: string,
    payload: Record<string, unknown>,
    signal: AbortSignal,
    settings: AutomationSettings,
  ): Promise<unknown>
  dispose(): Promise<void>
}

interface DriverState extends ActionRuntimeContext {
  addon: ComputerUseNativeAddon | null
  selfPid: number
  disposed: boolean
  queueTail: Promise<void>
  captures: Map<string, CaptureCoordinateMapping>
  activeTargetWindow: ComputerUseWindowInfo | null
}

function listNormalizedWindows(addon: ComputerUseNativeAddon | null): ComputerUseWindowInfo[] {
  if (!addon) return []
  return normalizeNativeWindowsForPlatform(addon.listWindows())
}

async function runSerialized<T>(
  state: DriverState,
  signal: AbortSignal,
  task: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted()
  const prev = state.queueTail
  let release!: () => void
  state.queueTail = new Promise<void>(resolve => {
    release = resolve
  })
  try {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason ?? new Error('桌面操作已取消'))
        return
      }
      const onAbort = () => reject(signal.reason ?? new Error('桌面操作已取消'))
      signal.addEventListener('abort', onAbort, { once: true })
      void prev.finally(() => {
        signal.removeEventListener('abort', onAbort)
        if (!signal.aborted) resolve()
      })
    })
    if (state.disposed) throw new Error('桌面操控驱动已释放')
    signal.throwIfAborted()
    return await task()
  } finally {
    release()
  }
}

function storeCapture(state: DriverState, mapping: CaptureCoordinateMapping): void {
  state.captures.set(mapping.captureId, mapping)
  while (state.captures.size > MAX_CAPTURE_HISTORY) {
    const oldest = state.captures.keys().next().value
    if (oldest) state.captures.delete(oldest)
  }
}

function findWindowByIdOrPid(
  windows: readonly ComputerUseWindowInfo[],
  windowId?: number,
  pid?: number,
): ComputerUseWindowInfo | undefined {
  if (windowId !== undefined) {
    const exact = windows.find(win => win.windowId === windowId)
    if (exact) return exact
  }
  if (pid !== undefined) return windows.find(win => win.pid === pid)
  return undefined
}

function resolveExplicitWindow(
  state: DriverState,
  payload: Record<string, unknown>,
  settings: AutomationSettings,
): ComputerUseWindowInfo | undefined {
  if (!state.addon) return undefined
  const reqWindowId = readOptionalNumber(payload, 'windowId')
  const reqPid = readOptionalNumber(payload, 'pid')
  if (reqWindowId === undefined && reqPid === undefined) return undefined
  const found = findWindowByIdOrPid(listNormalizedWindows(state.addon), reqWindowId, reqPid)
  if (!found) throw new Error('未找到指定的桌面窗口，可能已关闭或最小化')
  assertWindowAllowed(found, settings, state.selfPid)
  return found
}

function resolvePointerContext(
  state: DriverState,
  mapping: CaptureCoordinateMapping,
  rawPoint: { x: number; y: number },
  settings: AutomationSettings,
): {
  windows: ComputerUseWindowInfo[]
  targetWindow?: ComputerUseWindowInfo
  point: { x: number; y: number }
} {
  const windows = listNormalizedWindows(state.addon)
  if (mapping.windowId !== undefined || mapping.windowPid !== undefined) {
    const target = findWindowByIdOrPid(windows, mapping.windowId, mapping.windowPid)
    if (!target) throw new Error('目标窗口已关闭或不可见，请重新调用 computer_status 确认窗口状态')
    assertWindowAllowed(target, settings, state.selfPid)
    const point = compensateWindowMovement(
      rawPoint,
      mapping.capturedWindowBounds ?? mapping.windowClipBounds,
      target.bounds,
    )
    if (mapping.scope === 'window') assertPointInsideRect(point, target.bounds)
    return { windows, targetWindow: target, point }
  }
  const hit = findWindowAtPoint(windows, rawPoint.x, rawPoint.y)
  if (hit) assertWindowAllowed(hit, settings, state.selfPid)
  return { windows, ...(hit ? { targetWindow: hit } : {}), point: rawPoint }
}

function resolveKeyboardTargetWindow(
  state: DriverState,
  payload: Record<string, unknown>,
  settings: AutomationSettings,
): ComputerUseWindowInfo | undefined {
  if (!state.addon) return undefined
  const explicit = resolveExplicitWindow(state, payload, settings)
  if (explicit) return explicit
  const windows = listNormalizedWindows(state.addon)
  const latestMap = [...state.captures.values()].at(-1)
  const candidates = [
    state.activeTargetWindow
      ? { windowId: state.activeTargetWindow.windowId, pid: state.activeTargetWindow.pid }
      : null,
    latestMap
      ? {
          ...(latestMap.windowId !== undefined ? { windowId: latestMap.windowId } : {}),
          ...(latestMap.windowPid !== undefined ? { pid: latestMap.windowPid } : {}),
        }
      : null,
  ]
  for (const item of candidates) {
    if (!item) continue
    const live = findWindowByIdOrPid(windows, item.windowId, item.pid)
    if (live) {
      assertWindowAllowed(live, settings, state.selfPid)
      return live
    }
  }
  if (settings.computerUse.scope === 'window') {
    throw new Error('当前桌面操控范围为「仅单窗口」，请先针对目标窗口截图或显式指定 window_id/pid')
  }
  const front = windows.find(win => win.isFrontmost)
  if (front) assertWindowAllowed(front, settings, state.selfPid)
  return front
}

function canUseMacBackground(
  targetWindow: ComputerUseWindowInfo | undefined,
  occluded = false,
): boolean {
  if (process.platform !== 'darwin' || targetWindow === undefined) return false
  return !targetWindow.isFrontmost || occluded
}

async function handleStatus(state: DriverState, settings: AutomationSettings) {
  const permissions = buildComputerPermissionStatus(state.addon)
  const displays = listSystemDisplays()
  const rawWindows = listNormalizedWindows(state.addon)
  const visibleWindows = rawWindows
    .filter(
      win =>
        !isWindowBlocked({
          window: win,
          blockedApps: settings.computerUse.blockedApps,
          selfPid: state.selfPid,
        }).blocked,
    )
    .slice(0, 40)
  return {
    permissions,
    backgroundControlSupported: process.platform === 'darwin',
    uiTreeSupported: process.platform === 'darwin' && typeof state.addon?.getUiTree === 'function',
    scope: settings.computerUse.scope,
    confirmEveryAction: settings.computerUse.confirmEveryAction,
    maxImageLongEdge: settings.computerUse.maxImageLongEdge,
    displays,
    windows: visibleWindows,
  }
}

async function collectUiNodes(
  addon: ComputerUseNativeAddon | null,
  targetWindow?: ComputerUseWindowInfo,
) {
  if (!targetWindow) return []
  if (typeof addon?.getUiTreeAsync === 'function') {
    return addon.getUiTreeAsync(targetWindow.pid, targetWindow.windowId, 60)
  }
  if (typeof addon?.getUiTree === 'function') {
    return addon.getUiTree(targetWindow.pid, targetWindow.windowId, 60)
  }
  return []
}

function buildScreenshotResponse(input: {
  captureId: string
  displayId: number
  captureMethod: string
  scaled: ReturnType<typeof scaleImageWithNativeImage>
  mapping: CaptureCoordinateMapping
  elements: CapturedUiElementRef[]
  targetWindow?: ComputerUseWindowInfo
}) {
  const { captureId, displayId, captureMethod, scaled, mapping, elements, targetWindow } = input
  return {
    captureId,
    base64: scaled.buffer.toString('base64'),
    mediaType: scaled.mediaType,
    width: scaled.width,
    height: scaled.height,
    bytes: scaled.buffer.byteLength,
    displayId,
    scope: mapping.scope,
    captureMethod,
    logicalOrigin: mapping.logicalOrigin,
    logicalSize: mapping.logicalSize,
    elementsCount: elements.length,
    ...(elements.length > 0 ? { elementsSummary: formatUiElementSummary(elements) } : {}),
    ...(targetWindow
      ? {
          window: {
            windowId: targetWindow.windowId,
            pid: targetWindow.pid,
            appName: targetWindow.appName,
            title: targetWindow.title,
          },
        }
      : {}),
  }
}

function scaleCapturedTargetImage(
  captured: Awaited<ReturnType<typeof captureTargetImage>>,
  maxLongEdge: number,
): ReturnType<typeof scaleImageWithNativeImage> {
  if (captured.rawPng && captured.rawPng.byteLength > 0) {
    return scaleImageWithNativeImage(captured.rawPng, maxLongEdge)
  }
  if (captured.image && !captured.image.isEmpty()) {
    return scaleNativeImage(captured.image, maxLongEdge)
  }
  throw new Error('SCREEN_CAPTURE_EMPTY：截图缓冲为空，请重试')
}

async function handleScreenshot(
  state: DriverState,
  payload: Record<string, unknown>,
  signal: AbortSignal,
  settings: AutomationSettings,
) {
  signal.throwIfAborted()
  const perms = buildComputerPermissionStatus(state.addon)
  if (process.platform === 'darwin' && perms.nativeLoaded && !perms.screenRecording) {
    throw new Error(
      'PERMISSION_DENIED：缺少 macOS「屏幕录制」权限，请在「设置 → 浏览器与桌面操控」打开系统设置授权并重启 MyDSH',
    )
  }
  const targetWindow = resolveExplicitWindow(state, payload, settings)
  if (!targetWindow && settings.computerUse.scope === 'window') {
    throw new Error('当前桌面操控范围为「仅单窗口」，请先指定目标 window_id 或 pid 后再截图')
  }
  const display = pickTargetDisplay(
    listSystemDisplays(),
    readOptionalNumber(payload, 'displayId'),
    targetWindow?.bounds,
  )
  state.cursorOverlay.setCaptureHidden(true)
  let captured: Awaited<ReturnType<typeof captureTargetImage>>
  let rawNodes: Awaited<ReturnType<typeof collectUiNodes>>
  try {
    // 截帧与 AX 语义树在原生工作线程并行执行，零 Electron 主线程阻塞。
    ;[captured, rawNodes] = await Promise.all([
      captureTargetImage({
        addon: state.addon,
        display,
        ...(targetWindow ? { targetWindow } : {}),
        maxLongEdge: settings.computerUse.maxImageLongEdge,
        signal,
      }),
      collectUiNodes(state.addon, targetWindow),
    ])
  } finally {
    state.cursorOverlay.setCaptureHidden(false)
  }
  signal.throwIfAborted()
  const scaled = scaleCapturedTargetImage(captured, settings.computerUse.maxImageLongEdge)
  const captureId = `cap_${randomUUID().slice(0, 12)}`
  const baseMapping = buildCaptureMapping({
    captureId,
    displayId: display.id,
    scope: captured.windowClip ? 'window' : 'display',
    displayBounds: display.bounds,
    ...(captured.windowClip ? { windowClipBounds: captured.windowClip } : {}),
    ...(targetWindow
      ? {
          capturedWindowBounds: targetWindow.bounds,
          windowId: targetWindow.windowId,
          windowPid: targetWindow.pid,
          windowAppName: targetWindow.appName,
        }
      : {}),
    imageWidth: scaled.width,
    imageHeight: scaled.height,
  })
  const elements = rawNodes.length > 0 ? buildUiElementRefs(rawNodes, baseMapping) : []
  const mapping: CaptureCoordinateMapping =
    elements.length > 0 ? { ...baseMapping, elements } : baseMapping
  storeCapture(state, mapping)
  if (targetWindow) state.activeTargetWindow = targetWindow
  return buildScreenshotResponse({
    captureId,
    displayId: display.id,
    captureMethod: captured.captureMethod,
    scaled,
    mapping,
    elements,
    ...(targetWindow ? { targetWindow } : {}),
  })
}

function resolveRawPointerPoint(
  state: DriverState,
  action: 'click' | 'drag' | 'scroll',
  mapping: CaptureCoordinateMapping,
  payload: Record<string, unknown>,
): { x: number; y: number } {
  const rawRef = action === 'click' ? readOptionalString(payload, 'ref') : undefined
  if (rawRef) {
    const matched = state.lookupRef(mapping, rawRef)
    return { x: matched.systemCenter.x, y: matched.systemCenter.y }
  }
  if (action === 'drag') {
    return mapCapturePointToSystem(
      mapping,
      Number(payload.fromX ?? Number.NaN),
      Number(payload.fromY ?? Number.NaN),
    )
  }
  return mapCapturePointToSystem(
    mapping,
    Number(payload.x ?? Number.NaN),
    Number(payload.y ?? Number.NaN),
  )
}

async function handlePointerAction(
  state: DriverState,
  input: {
    action: 'click' | 'drag' | 'scroll'
    payload: Record<string, unknown>
    signal: AbortSignal
    settings: AutomationSettings
  },
) {
  const { action, payload, signal, settings } = input
  const addon = assertAccessibilityReady(state.addon)
  const mapping = state.resolveMapping(readOptionalString(payload, 'captureId'))
  const rawPoint = resolveRawPointerPoint(state, action, mapping, payload)
  const { windows, targetWindow, point } = resolvePointerContext(state, mapping, rawPoint, settings)
  const occluded =
    targetWindow !== undefined &&
    isPointOccludedByAnotherWindow(windows, targetWindow.windowId, point.x, point.y)
  const background = canUseMacBackground(targetWindow, occluded)
  if (!background) {
    const cursorNow = normalizeNativePointForPlatform(addon.getCursorPosition())
    if (
      payload.ignoreMouseDrift !== true &&
      detectUserMouseOverride(state.lastInjectedCursor, cursorNow)
    ) {
      state.lastInjectedCursor = null
      return {
        ok: false,
        userOverrideDetected: true,
        reason: '检测到您刚刚手动移动了鼠标，已自动暂停本次桌面点击以防抢夺控制权。',
      }
    }
  }
  let result: unknown
  if (action === 'click') {
    result = await executeClickAction(state, {
      addon,
      point,
      payload,
      ...(targetWindow ? { targetWindow } : {}),
      background,
      signal,
    })
  } else if (action === 'drag') {
    result = await executeDragAction(state, {
      addon,
      mapping,
      point,
      payload,
      ...(targetWindow ? { targetWindow } : {}),
      background,
      validateEndPoint: end => {
        const hitEnd = findWindowAtPoint(windows, end.x, end.y)
        if (hitEnd) assertWindowAllowed(hitEnd, settings, state.selfPid)
      },
      signal,
    })
  } else {
    result = await executeScrollAction(state, {
      addon,
      windows,
      point,
      payload,
      ...(targetWindow ? { targetWindow } : {}),
      background,
      signal,
    })
  }
  // 仅在校验与执行成功后更新活动目标窗口，避免被拦截的越界/屏蔽动作污染后续键盘路由。
  if (targetWindow) state.activeTargetWindow = targetWindow
  return result
}

async function handleKeyboardAction(
  state: DriverState,
  input: {
    action: 'type' | 'key'
    payload: Record<string, unknown>
    signal: AbortSignal
    settings: AutomationSettings
  },
) {
  const { action, payload, signal, settings } = input
  const addon = assertAccessibilityReady(state.addon)
  const targetWindow = resolveKeyboardTargetWindow(state, payload, settings)
  const background = canUseMacBackground(targetWindow)
  const hintPoint =
    state.lastVirtualPoint ??
    (targetWindow
      ? {
          x: Math.round(targetWindow.bounds.x + targetWindow.bounds.width / 2),
          y: Math.round(targetWindow.bounds.y + targetWindow.bounds.height / 2),
        }
      : null)
  const common = {
    addon,
    payload,
    ...(targetWindow ? { targetWindow } : {}),
    background,
    hintPoint,
    signal,
  }
  return action === 'type' ? executeTypeAction(state, common) : executeKeyAction(state, common)
}

function resolveMappingFromStore(
  captures: Map<string, CaptureCoordinateMapping>,
  captureId?: string,
): CaptureCoordinateMapping {
  if (captureId) {
    const found = captures.get(captureId)
    if (!found) {
      throw new Error('STALE_CAPTURE：找不到对应的截图映射标识，请先重新调用 computer_screenshot')
    }
    return found
  }
  const last = [...captures.values()].at(-1)
  if (!last) throw new Error('STALE_CAPTURE：尚未截取桌面画面，请先调用 computer_screenshot')
  return last
}

function lookupElementRef(mapping: CaptureCoordinateMapping, rawRef: string): CapturedUiElementRef {
  const normalized = rawRef.startsWith('@') ? rawRef : `@${rawRef}`
  const found = mapping.elements?.find(item => item.ref === normalized)
  if (!found) {
    throw new Error(
      `ELEMENT_NOT_FOUND：当前截图不存在控件编号 ${normalized}，请重新调用 computer_screenshot 或改用坐标`,
    )
  }
  return found
}

/** 创建系统级 Computer Use 主进程驱动。 */
export function createComputerUseDriver(options?: {
  addon?: ComputerUseNativeAddon | null
  selfPid?: number
  headless?: boolean
  cursorOverlay?: VirtualCursorOverlayController
}): ComputerUseDriver {
  const headless = options?.headless ?? options?.addon !== undefined
  const captures = new Map<string, CaptureCoordinateMapping>()
  const state: DriverState = {
    addon: options?.addon === undefined ? loadComputerUseNativeAddon() : options.addon,
    selfPid: options?.selfPid ?? process.pid,
    disposed: false,
    queueTail: Promise.resolve(),
    headless,
    cursorOverlay: options?.cursorOverlay ?? createVirtualCursorOverlay({ headless }),
    captures,
    activeTargetWindow: null,
    lastInjectedCursor: null,
    lastVirtualPoint: null,
    resolveMapping: captureId => resolveMappingFromStore(captures, captureId),
    lookupRef: lookupElementRef,
  }
  return {
    checkPermissions: async () => buildComputerPermissionStatus(state.addon),
    openPermissionSettings: kind => openSystemPermissionSettings(kind),
    releaseInputs() {
      state.cursorOverlay.hide()
      try {
        state.addon?.releaseAllModifiers()
      } catch {
        /* 急停释放修饰键时忽略原生异常。 */
      }
    },
    async call(action, payload, signal, settings) {
      if (state.disposed) throw new Error('桌面操控驱动已释放')
      signal.throwIfAborted()
      if (action === 'status') return handleStatus(state, settings)
      return runSerialized(state, signal, async () => {
        if (action === 'screenshot') return handleScreenshot(state, payload, signal, settings)
        if (action === 'focus_window') {
          const addon = assertAccessibilityReady(state.addon)
          const target = resolveExplicitWindow(state, payload, settings)
          if (!target) throw new Error('切换焦点需要提供有效的 windowId 或 pid')
          const focused = addon.focusWindow(target.pid, target.windowId)
          state.activeTargetWindow = target
          state.lastInjectedCursor = null
          return { ok: focused, window: target }
        }
        if (action === 'click' || action === 'drag' || action === 'scroll') {
          return handlePointerAction(state, { action, payload, signal, settings })
        }
        if (action === 'type' || action === 'key') {
          return handleKeyboardAction(state, { action, payload, signal, settings })
        }
        throw new Error(`不支持的桌面操控动作：${action}`)
      })
    },
    async dispose() {
      state.disposed = true
      state.captures.clear()
      state.activeTargetWindow = null
      state.lastInjectedCursor = null
      state.lastVirtualPoint = null
      state.cursorOverlay.dispose()
      try {
        state.addon?.releaseAllModifiers()
      } catch {
        /* 退出清理忽略异常。 */
      }
    },
  }
}
