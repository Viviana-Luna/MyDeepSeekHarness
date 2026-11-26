/**
 * 系统级 Computer Use 动作执行器：实现 macOS/Windows 点击、拖拽、滚轮、键入与按键的三层确定性投递与模拟 AI 光标联动。
 * 运行在 Electron 主进程，供 `computer-use-driver.ts` 调用。
 */
import { readOptionalNumber, readOptionalString } from './cdp-dispatch.ts'
import {
  abortableSleep,
  pasteWithClipboardBackup,
  toNativePointForPlatform,
} from './computer-use-capture.ts'
import {
  encodeModifierMask,
  resolvePlatformKey,
  type ComputerUseNativeAddon,
} from './computer-use-native.ts'
import {
  assertPointInsideRect,
  assertSystemKeyComboAllowed,
  compensateWindowMovement,
  isPointOccludedByAnotherWindow,
  mapCapturePointToSystem,
  type CaptureCoordinateMapping,
  type CapturedUiElementRef,
  type ComputerUseWindowInfo,
} from './computer-use-policy.ts'
import type { VirtualCursorOverlayController } from './virtual-cursor-overlay.ts'

/** 动作执行所需的最小驱动运行态视图。 */
export interface ActionRuntimeContext {
  readonly headless: boolean
  readonly cursorOverlay: VirtualCursorOverlayController
  lastInjectedCursor: { x: number; y: number } | null
  lastVirtualPoint: { x: number; y: number } | null
  resolveMapping(captureId?: string): CaptureCoordinateMapping
  lookupRef(mapping: CaptureCoordinateMapping, rawRef: string): CapturedUiElementRef
}

async function animateCursorBeforeAction(
  ctx: ActionRuntimeContext,
  event: Parameters<VirtualCursorOverlayController['showAction']>[0],
  signal: AbortSignal,
): Promise<void> {
  ctx.lastVirtualPoint = { x: event.toX ?? event.x, y: event.toY ?? event.y }
  if (ctx.headless) return
  signal.throwIfAborted()
  // 异步更新紧凑悬浮光标，不阻塞主流程。
  await ctx.cursorOverlay.showAction(event)
}

function resolveClickLabel(button: 'left' | 'right' | 'middle', clickCount: number): string {
  if (button === 'right') return 'AI · 右键'
  if (button === 'middle') return 'AI · 中键'
  if (clickCount === 2) return 'AI · 双击'
  if (clickCount === 3) return 'AI · 三击'
  return 'AI · 点击'
}

function parseMouseButton(raw: unknown): {
  button: 'left' | 'right' | 'middle'
  buttonCode: number
} {
  if (raw === 'right') return { button: 'right', buttonCode: 1 }
  if (raw === 'middle') return { button: 'middle', buttonCode: 2 }
  return { button: 'left', buttonCode: 0 }
}

async function callAxPress(addon: ComputerUseNativeAddon, pid: number, x: number, y: number) {
  const fn = addon.axPressAtAsync ?? addon.axPressAt
  return typeof fn === 'function' ? fn(pid, x, y) : false
}

async function callAxSetText(
  addon: ComputerUseNativeAddon,
  args: { pid: number; x: number; y: number; text: string },
) {
  const fn = addon.axSetTextAtAsync ?? addon.axSetTextAt
  return typeof fn === 'function' ? fn(args.pid, args.x, args.y, args.text) : false
}

async function callMouseClick(
  addon: ComputerUseNativeAddon,
  args: {
    x: number
    y: number
    buttonCode: number
    clickCount: number
    modMask: number
    targetPid: number
    targetWindowId: number
    restoreFocus: boolean
  },
) {
  const nativePt = toNativePointForPlatform({ x: args.x, y: args.y })
  const fn = addon.mouseClickAsync ?? addon.mouseClick
  return fn(
    nativePt.x,
    nativePt.y,
    args.buttonCode,
    args.clickCount,
    args.modMask,
    args.targetPid,
    args.targetWindowId,
    args.restoreFocus,
  )
}

async function callMouseDrag(
  addon: ComputerUseNativeAddon,
  args: {
    fromX: number
    fromY: number
    toX: number
    toY: number
    steps: number
    targetPid: number
    targetWindowId: number
    restoreFocus: boolean
  },
) {
  const fromPt = toNativePointForPlatform({ x: args.fromX, y: args.fromY })
  const toPt = toNativePointForPlatform({ x: args.toX, y: args.toY })
  const fn = addon.mouseDragAsync ?? addon.mouseDrag
  return fn(
    fromPt.x,
    fromPt.y,
    toPt.x,
    toPt.y,
    args.steps,
    args.targetPid,
    args.targetWindowId,
    args.restoreFocus,
  )
}

async function callMouseScroll(
  addon: ComputerUseNativeAddon,
  args: {
    x: number
    y: number
    deltaX: number
    deltaY: number
    targetPid: number
    targetWindowId: number
    occluded: boolean
  },
) {
  const nativePt = toNativePointForPlatform({ x: args.x, y: args.y })
  const fn = addon.mouseScrollAsync ?? addon.mouseScroll
  return fn(
    nativePt.x,
    nativePt.y,
    args.deltaX,
    args.deltaY,
    args.targetPid,
    args.targetWindowId,
    args.occluded,
  )
}

async function callKeyTap(
  addon: ComputerUseNativeAddon,
  args: { keyCode: number; modMask: number; targetPid: number; restoreFocus: boolean },
) {
  const fn = addon.keyTapAsync ?? addon.keyTap
  return fn(args.keyCode, args.modMask, args.targetPid, args.restoreFocus)
}

async function tryAxBackgroundClick(
  ctx: ActionRuntimeContext,
  input: {
    addon: ComputerUseNativeAddon
    point: { x: number; y: number }
    targetWindow?: ComputerUseWindowInfo
    signal: AbortSignal
  },
) {
  const { addon, point, targetWindow, signal } = input
  if (process.platform !== 'darwin' || !targetWindow) return null
  if (!(await callAxPress(addon, targetWindow.pid, point.x, point.y))) return null
  signal.throwIfAborted()
  if (!ctx.headless) await abortableSleep(45, signal)
  return {
    ok: true,
    systemX: point.x,
    systemY: point.y,
    background: true,
    deliveryMethod: 'ax-background',
    targetApp: targetWindow.appName,
  }
}

/** 执行三层确定性鼠标点击：macOS 优先 AXPress 纯后台直达，否则走真实 HID + 光标还原 + 可选微激活复原焦点。 */
export async function executeClickAction(
  ctx: ActionRuntimeContext,
  input: {
    addon: ComputerUseNativeAddon
    point: { x: number; y: number }
    payload: Record<string, unknown>
    targetWindow?: ComputerUseWindowInfo
    background: boolean
    signal: AbortSignal
  },
) {
  const { addon, point, payload, targetWindow, background, signal } = input
  const { button, buttonCode } = parseMouseButton(payload.button)
  const rawCount = readOptionalNumber(payload, 'clickCount') ?? 1
  const clickCount = Math.max(1, Math.min(3, Math.round(rawCount)))
  const mods = Array.isArray(payload.modifiers)
    ? payload.modifiers.filter((item): item is string => typeof item === 'string')
    : []
  const modMask = mods.length > 0 ? encodeModifierMask(mods) : 0
  await animateCursorBeforeAction(
    ctx,
    {
      kind: 'click',
      x: point.x,
      y: point.y,
      button,
      clickCount,
      label: resolveClickLabel(button, clickCount),
      ...(targetWindow ? { targetBounds: targetWindow.bounds } : {}),
    },
    signal,
  )
  // 第 1 层：macOS 标准左键单击优先通过异步 AXPress 无焦点纯后台执行（零焦点闪烁、零光标移动）。
  if (button === 'left' && clickCount === 1 && modMask === 0) {
    const axResult = await tryAxBackgroundClick(ctx, {
      addon,
      point,
      ...(targetWindow ? { targetWindow } : {}),
      signal,
    })
    if (axResult) return axResult
  }
  // 只要已解析出目标窗口即传入 targetPid/windowId，让原生层在前后台均执行 TOCTOU 防自锁校验。
  const targetPid = targetWindow?.pid ?? 0
  const targetWindowId = targetWindow?.windowId ?? 0
  let clicked = false
  try {
    clicked = await callMouseClick(addon, {
      x: point.x,
      y: point.y,
      buttonCode,
      clickCount,
      modMask,
      targetPid,
      targetWindowId,
      restoreFocus: background,
    })
    if (clicked && !background) ctx.lastInjectedCursor = point
  } finally {
    if (modMask !== 0) addon.releaseAllModifiers()
  }
  if (!clicked) {
    throw new Error(
      'SELF_LOCK_GUARD：目标窗口未能置于最前或坐标仍位于 MyDSH 窗口之上，已拦截防自锁点击',
    )
  }
  signal.throwIfAborted()
  if (!ctx.headless) await abortableSleep(50, signal)
  return {
    ok: true,
    systemX: point.x,
    systemY: point.y,
    background,
    deliveryMethod: background ? 'hid-micro-activate' : 'hid-direct',
    ...(targetWindow ? { targetApp: targetWindow.appName } : {}),
  }
}

/** 执行平滑鼠标拖拽并按实时窗口位移补偿终点坐标，同时校验终点安全边界。 */
export async function executeDragAction(
  ctx: ActionRuntimeContext,
  input: {
    addon: ComputerUseNativeAddon
    mapping: CaptureCoordinateMapping
    point: { x: number; y: number }
    payload: Record<string, unknown>
    targetWindow?: ComputerUseWindowInfo
    background: boolean
    validateEndPoint(point: { x: number; y: number }): void
    signal: AbortSignal
  },
) {
  const { addon, mapping, point, payload, targetWindow, background, validateEndPoint, signal } =
    input
  const rawTo = mapCapturePointToSystem(
    mapping,
    Number(payload.toX ?? Number.NaN),
    Number(payload.toY ?? Number.NaN),
  )
  const to = compensateWindowMovement(
    rawTo,
    mapping.capturedWindowBounds ?? mapping.windowClipBounds,
    targetWindow?.bounds,
  )
  if (mapping.scope === 'window' && targetWindow) {
    assertPointInsideRect(to, targetWindow.bounds)
  }
  validateEndPoint(to)
  const rawSteps = readOptionalNumber(payload, 'steps') ?? 12
  const steps = Math.max(2, Math.min(30, Math.round(rawSteps)))
  const targetPid = targetWindow?.pid ?? 0
  const targetWindowId = targetWindow?.windowId ?? 0
  await animateCursorBeforeAction(
    ctx,
    {
      kind: 'drag',
      x: point.x,
      y: point.y,
      toX: to.x,
      toY: to.y,
      label: 'AI · 拖拽',
      ...(targetWindow ? { targetBounds: targetWindow.bounds } : {}),
    },
    signal,
  )
  const dragged = await callMouseDrag(addon, {
    fromX: point.x,
    fromY: point.y,
    toX: to.x,
    toY: to.y,
    steps,
    targetPid,
    targetWindowId,
    restoreFocus: background,
  })
  if (!dragged) {
    throw new Error(
      'SELF_LOCK_GUARD：目标窗口未能置于最前或拖拽起点位于 MyDSH 窗口之上，已拦截防自锁拖拽',
    )
  }
  if (!background) ctx.lastInjectedCursor = to
  signal.throwIfAborted()
  if (!ctx.headless) await abortableSleep(45, signal)
  return {
    ok: true,
    from: point,
    to,
    background,
    deliveryMethod: background ? 'hid-micro-activate' : 'hid-direct',
  }
}

/** 执行鼠标滚轮操作：未遮挡窗口直接零焦点滚动，被遮挡时微激活滚动并复原焦点。 */
export async function executeScrollAction(
  ctx: ActionRuntimeContext,
  input: {
    addon: ComputerUseNativeAddon
    windows: readonly ComputerUseWindowInfo[]
    point: { x: number; y: number }
    payload: Record<string, unknown>
    targetWindow?: ComputerUseWindowInfo
    background: boolean
    signal: AbortSignal
  },
) {
  const { addon, windows, point, payload, targetWindow, background, signal } = input
  const deltaX = Math.round(readOptionalNumber(payload, 'deltaX') ?? 0)
  const deltaY = Math.round(readOptionalNumber(payload, 'deltaY') ?? 240)
  const targetPid = targetWindow?.pid ?? 0
  const targetWindowId = targetWindow?.windowId ?? 0
  await animateCursorBeforeAction(
    ctx,
    {
      kind: 'scroll',
      x: point.x,
      y: point.y,
      deltaX,
      deltaY,
      label: 'AI · 滚动',
      ...(targetWindow ? { targetBounds: targetWindow.bounds } : {}),
    },
    signal,
  )
  const occluded =
    targetWindow !== undefined &&
    isPointOccludedByAnotherWindow(windows, targetWindow.windowId, point.x, point.y)
  const scrolled = await callMouseScroll(addon, {
    x: point.x,
    y: point.y,
    deltaX,
    deltaY,
    targetPid,
    targetWindowId,
    occluded,
  })
  if (!scrolled) {
    throw new Error('SELF_LOCK_GUARD：目标坐标仍位于 MyDSH 窗口之上，已拦截防自锁滚动')
  }
  if (!background && !occluded) ctx.lastInjectedCursor = point
  signal.throwIfAborted()
  if (!ctx.headless) await abortableSleep(40, signal)
  return {
    ok: true,
    systemX: point.x,
    systemY: point.y,
    deltaX,
    deltaY,
    background,
    deliveryMethod: occluded ? 'hid-micro-activate' : 'hid-direct',
  }
}

async function tryAxBackgroundType(
  ctx: ActionRuntimeContext,
  input: {
    addon: ComputerUseNativeAddon
    text: string
    submit: boolean
    targetWindow?: ComputerUseWindowInfo
    refPoint: { x: number; y: number } | null
    targetPid: number
    background: boolean
    signal: AbortSignal
  },
) {
  const { addon, text, submit, targetWindow, refPoint, targetPid, background, signal } = input
  if (process.platform !== 'darwin' || !targetWindow) return null
  // 无显式坐标时传入 NaN 而不是 -1，兼容副屏负坐标 (x < 0 或 y < 0)。
  const ok = await callAxSetText(addon, {
    pid: targetWindow.pid,
    x: refPoint ? refPoint.x : Number.NaN,
    y: refPoint ? refPoint.y : Number.NaN,
    text,
  })
  if (!ok) return null
  signal.throwIfAborted()
  if (submit) {
    const submitted = await callKeyTap(addon, {
      keyCode: resolvePlatformKey('Enter').keyCode,
      modMask: 0,
      targetPid,
      restoreFocus: background,
    })
    if (!submitted) {
      throw new Error('SELF_LOCK_GUARD：目标窗口未能取得前台焦点，已拦截提交回车')
    }
  }
  signal.throwIfAborted()
  if (!ctx.headless) await abortableSleep(45, signal)
  return { ok: true, typedLength: text.length, background: true, deliveryMethod: 'ax-background' }
}

function resolveTypeRefPoint(
  ctx: ActionRuntimeContext,
  payload: Record<string, unknown>,
  targetWindow?: ComputerUseWindowInfo,
): { rawRef: string | undefined; refPoint: { x: number; y: number } | null } {
  const rawRef = readOptionalString(payload, 'ref')
  if (!rawRef) return { rawRef, refPoint: null }
  const mapping = ctx.resolveMapping(readOptionalString(payload, 'captureId'))
  const found = ctx.lookupRef(mapping, rawRef)
  const point = compensateWindowMovement(
    found.systemCenter,
    mapping.capturedWindowBounds ?? mapping.windowClipBounds,
    targetWindow?.bounds,
  )
  if (mapping.scope === 'window' && targetWindow) {
    assertPointInsideRect(point, targetWindow.bounds)
  }
  return { rawRef, refPoint: point }
}

/** 执行文本输入：仅在 `clear: true` 时优先尝试 AXValue 全量替换，否则点击聚焦并通过安全剪贴板粘贴追加。 */
export async function executeTypeAction(
  ctx: ActionRuntimeContext,
  input: {
    addon: ComputerUseNativeAddon
    payload: Record<string, unknown>
    targetWindow?: ComputerUseWindowInfo
    background: boolean
    hintPoint: { x: number; y: number } | null
    signal: AbortSignal
  },
) {
  const { addon, payload, targetWindow, background, signal } = input
  const text = typeof payload.text === 'string' ? payload.text : ''
  if (!text) throw new Error('输入文本不能为空')
  if (text.length > 8192) throw new Error('单次桌面输入文本长度不能超过 8192 字符')
  const { refPoint } = resolveTypeRefPoint(ctx, payload, targetWindow)
  const visualPoint = refPoint ?? input.hintPoint
  if (visualPoint) {
    await animateCursorBeforeAction(
      ctx,
      {
        kind: 'key',
        x: visualPoint.x,
        y: visualPoint.y,
        label: 'AI · 输入文本',
        ...(targetWindow ? { targetBounds: targetWindow.bounds } : {}),
      },
      signal,
    )
  }
  const targetPid = targetWindow?.pid ?? 0
  const targetWindowId = targetWindow?.windowId ?? 0
  // 仅当调用方明确要求 clear=true 时才走 AXValue 全量替换，避免误覆写已有内容。
  if (payload.clear === true) {
    const axResult = await tryAxBackgroundType(ctx, {
      addon,
      text,
      submit: payload.submit === true,
      ...(targetWindow ? { targetWindow } : {}),
      refPoint,
      targetPid,
      background,
      signal,
    })
    if (axResult) return axResult
  }
  if (refPoint) {
    const clickedRef = await callMouseClick(addon, {
      x: refPoint.x,
      y: refPoint.y,
      buttonCode: 0,
      clickCount: 1,
      modMask: 0,
      targetPid,
      targetWindowId,
      restoreFocus: false,
    })
    if (!clickedRef) {
      throw new Error('SELF_LOCK_GUARD：未能聚焦目标输入框（坐标仍位于 MyDSH 之上），已取消输入')
    }
    if (!background) ctx.lastInjectedCursor = refPoint
    signal.throwIfAborted()
    if (!ctx.headless) await abortableSleep(35, signal)
  }
  await pasteWithClipboardBackup({
    addon,
    text,
    clear: payload.clear === true,
    submit: payload.submit === true,
    targetPid,
    restoreFocus: background,
    signal,
  })
  return {
    ok: true,
    typedLength: text.length,
    background,
    deliveryMethod: background ? 'hid-micro-activate' : 'hid-direct',
  }
}

/** 执行单个按键或组合键，自动校验禁键黑名单并在后台目标上微激活后复原焦点。 */
export async function executeKeyAction(
  ctx: ActionRuntimeContext,
  input: {
    addon: ComputerUseNativeAddon
    payload: Record<string, unknown>
    targetWindow?: ComputerUseWindowInfo
    background: boolean
    hintPoint: { x: number; y: number } | null
    signal: AbortSignal
  },
) {
  const { addon, payload, targetWindow, background, hintPoint, signal } = input
  const rawKey = typeof payload.key === 'string' ? payload.key : ''
  const modifiers = Array.isArray(payload.modifiers)
    ? payload.modifiers.filter((item): item is string => typeof item === 'string')
    : []
  assertSystemKeyComboAllowed(rawKey, modifiers)
  const resolved = resolvePlatformKey(rawKey, modifiers)
  if (hintPoint) {
    await animateCursorBeforeAction(
      ctx,
      {
        kind: 'key',
        x: hintPoint.x,
        y: hintPoint.y,
        label: `AI · 按键 ${rawKey.slice(0, 20)}`,
        ...(targetWindow ? { targetBounds: targetWindow.bounds } : {}),
      },
      signal,
    )
  }
  const targetPid = targetWindow?.pid ?? 0
  let tapped = false
  try {
    tapped = await callKeyTap(addon, {
      keyCode: resolved.keyCode,
      modMask: resolved.modifierMask,
      targetPid,
      restoreFocus: background,
    })
  } finally {
    if (resolved.modifierMask !== 0) addon.releaseAllModifiers()
  }
  if (!tapped) {
    throw new Error('SELF_LOCK_GUARD：目标窗口未能取得前台焦点（当前仍为 MyDSH），已拦截防自锁按键')
  }
  signal.throwIfAborted()
  if (!ctx.headless) await abortableSleep(45, signal)
  return {
    ok: true,
    key: rawKey,
    background,
    deliveryMethod: background ? 'hid-micro-activate' : 'hid-direct',
  }
}
