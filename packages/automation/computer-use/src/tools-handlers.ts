/**
 * 系统级 Computer Use 8 个工具的执行处理器：串联主会话鉴权、串行排队、严格窗口/截图归属绑定、急停撤权与确认卡协商。
 * 运行在后台 Runtime，截图经 `ctx.attachments` 返回多模态图片块。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ensureComputerActionConsent } from './permission-negotiation.ts'
import {
  matchWindowStrict,
  sanitizeUntrustedText,
  type ComputerSessionGrantStore,
  type ComputerUseStatusPayload,
} from './policy.ts'
import {
  assertAttachmentsAvailableForComputerUse,
  assertVisionModelForComputerUse,
  saveComputerScreenshotAttachment,
  type ComputerScreenshotToolValue,
} from './screenshot-output.ts'

/** 匹配 `defineTool` 的 `type: 'json'` 输出约束的可序列化 JSON 值类型。 */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

function formatWindowLabel(win: { appName: string; title?: string }): string {
  const safeApp = sanitizeUntrustedText(win.appName, 80, true)
  const safeTitle = win.title ? sanitizeUntrustedText(win.title, 100, true) : ''
  return safeTitle ? `${safeApp}（${safeTitle}）` : safeApp
}

function isStoppedError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('AUTOMATION_STOPPED')
}

async function readComputerStatus(
  ctx: Context,
  signal?: AbortSignal,
): Promise<ComputerUseStatusPayload> {
  return ctx.mydshAutomationSystem.call<ComputerUseStatusPayload>(
    'automation.computer.status',
    {},
    signal,
  )
}

async function runSerializedComputerAction<T>(
  ctx: Context,
  exec: ToolRunContext,
  grants: ComputerSessionGrantStore,
  work: (sessionId: string, status: ComputerUseStatusPayload) => Promise<T>,
): Promise<T> {
  const agent = ctx.mydshConnectionAccess.assertMainAgent(exec.agent)
  return ctx.mydshConnectionAccess.serializeForConnection(
    agent.id,
    'computer-use',
    async () => {
      const status = await readComputerStatus(ctx, exec.signal)
      try {
        return await work(agent.id, status)
      } catch (error) {
        if (isStoppedError(error)) grants.revokeSession(agent.id)
        throw error
      }
    },
    exec.signal,
  )
}

function resolveDisplayScope(
  status: ComputerUseStatusPayload,
  displayId?: number,
): { scopeKey: string; targetLabel: string } {
  const matched =
    displayId !== undefined
      ? status.displays.find(item => item.id === displayId)
      : (status.displays.find(item => item.primary) ?? status.displays[0])
  const id = matched?.id ?? displayId ?? 'primary'
  const label = matched?.label
    ? `显示器：${sanitizeUntrustedText(matched.label, 80, true)}`
    : `显示器 #${String(id)}`
  return { scopeKey: `display:${String(id)}`, targetLabel: label }
}

/** 读取桌面操控平台支持、系统权限（辅助功能/屏幕录制）、显示器与过滤后可见窗口清单。 */
export async function executeComputerStatus(
  ctx: Context,
  exec: ToolRunContext,
): Promise<JsonValue> {
  ctx.mydshConnectionAccess.assertMainAgent(exec.agent)
  const status = await readComputerStatus(ctx, exec.signal)
  const sanitized = {
    ...status,
    displays: status.displays.map(item => ({
      ...item,
      label: sanitizeUntrustedText(item.label, 80, true),
    })),
    windows: status.windows.map(win => ({
      ...win,
      appName: sanitizeUntrustedText(win.appName, 80, true),
      title: sanitizeUntrustedText(win.title, 160, true),
    })),
  }
  return sanitized as unknown as JsonValue
}

/** 截取已授权桌面显示器或目标窗口画面，并绑定 `capture_id` 作用域归属防止跨应用复用。 */
export async function executeComputerScreenshot(
  ctx: Context,
  exec: ToolRunContext,
  grants: ComputerSessionGrantStore,
  args: { display_id?: number; window_id?: number; pid?: number },
): Promise<ComputerScreenshotToolValue> {
  ctx.mydshConnectionAccess.assertMainAgent(exec.agent)
  assertAttachmentsAvailableForComputerUse(ctx)
  await assertVisionModelForComputerUse(ctx, exec)
  return runSerializedComputerAction(ctx, exec, grants, async (sessionId, status) => {
    const matchedWindow = matchWindowStrict(status.windows, args.window_id, args.pid)
    if (!matchedWindow && status.scope === 'window') {
      throw new Error('当前桌面操控范围为「仅单窗口」，请先指定目标 window_id 或 pid 后再截图')
    }
    // 无 window_id/pid 的整屏截图必须按 display:* 作用域独立授权，绝不静默沿用单应用授权。
    const scope = matchedWindow
      ? { scopeKey: `app:${matchedWindow.appName}`, targetLabel: formatWindowLabel(matchedWindow) }
      : resolveDisplayScope(status, args.display_id)
    await ensureComputerActionConsent(ctx, exec, grants, {
      status,
      scopeKey: scope.scopeKey,
      targetLabel: scope.targetLabel,
      actionSummary: matchedWindow
        ? `截取窗口画面：${scope.targetLabel}`
        : `截取整屏画面（${scope.targetLabel}）`,
    })
    const shot = await ctx.mydshAutomationSystem.call<{
      captureId: string
      base64: string
      mediaType: 'image/png' | 'image/jpeg'
      width: number
      height: number
      displayId: number
      scope: 'window' | 'display'
      captureMethod?: string
      logicalOrigin: { x: number; y: number }
      logicalSize: { width: number; height: number }
      elementsCount?: number
      elementsSummary?: string
      window?: { windowId: number; pid: number; appName: string; title: string }
    }>(
      'automation.computer.screenshot',
      {
        sessionId,
        targetLabel: scope.targetLabel,
        ...(args.display_id !== undefined ? { displayId: args.display_id } : {}),
        ...(matchedWindow ? { windowId: matchedWindow.windowId, pid: matchedWindow.pid } : {}),
      },
      exec.signal,
    )
    const captureScopeKey = shot.window ? `app:${shot.window.appName}` : `display:${shot.displayId}`
    const captureLabel = shot.window ? formatWindowLabel(shot.window) : scope.targetLabel
    grants.recordCapture(sessionId, {
      captureId: shot.captureId,
      scopeKey: captureScopeKey,
      label: captureLabel,
      scope: shot.scope,
      ...(shot.window ? { windowId: shot.window.windowId, pid: shot.window.pid } : {}),
    })
    if (shot.window) {
      grants.setActiveTarget(sessionId, {
        scopeKey: captureScopeKey,
        label: captureLabel,
        windowId: shot.window.windowId,
        pid: shot.window.pid,
      })
    }
    const ext = shot.mediaType === 'image/jpeg' ? 'jpg' : 'png'
    const image = await saveComputerScreenshotAttachment(ctx, {
      base64: shot.base64,
      mediaType: shot.mediaType,
      name: `computer-${shot.captureId}.${ext}`,
    })
    return {
      capture_id: shot.captureId,
      scope: shot.scope,
      display_id: shot.displayId,
      logical_origin: shot.logicalOrigin,
      logical_size: shot.logicalSize,
      target_label: captureLabel,
      ...(shot.captureMethod ? { capture_method: shot.captureMethod } : {}),
      ...(shot.elementsCount !== undefined ? { elements_count: shot.elementsCount } : {}),
      ...(shot.elementsSummary ? { elements: shot.elementsSummary } : {}),
      image,
    }
  })
}

/** 将指定桌面应用窗口置前并设为当前操控目标，切换新应用时会触发确认卡授权。 */
export async function executeComputerFocusWindow(
  ctx: Context,
  exec: ToolRunContext,
  grants: ComputerSessionGrantStore,
  args: { window_id?: number; pid?: number },
): Promise<JsonValue> {
  if (args.window_id === undefined && args.pid === undefined) {
    throw new Error('切换焦点必须提供 window_id 或 pid 之一')
  }
  return runSerializedComputerAction(ctx, exec, grants, async (sessionId, status) => {
    const matched = matchWindowStrict(status.windows, args.window_id, args.pid)
    if (!matched) throw new Error('未找到指定的桌面窗口')
    const scopeKey = `app:${matched.appName}`
    const targetLabel = formatWindowLabel(matched)
    const authorization = await ensureComputerActionConsent(ctx, exec, grants, {
      status,
      scopeKey,
      targetLabel,
      actionSummary: `切换并聚焦窗口：${targetLabel}`,
    })
    const result = await ctx.mydshAutomationSystem.call<{
      ok: boolean
      window?: { windowId: number; pid: number; appName: string; title: string }
    }>(
      'automation.computer.focus_window',
      { sessionId, targetLabel, windowId: matched.windowId, pid: matched.pid },
      exec.signal,
    )
    if (result.window) {
      grants.setActiveTarget(sessionId, {
        scopeKey: `app:${result.window.appName}`,
        label: formatWindowLabel(result.window),
        windowId: result.window.windowId,
        pid: result.window.pid,
      })
    }
    return { ...result, authorization } as unknown as JsonValue
  })
}

function resolveInputScopeAndTarget(input: {
  action: 'click' | 'drag' | 'scroll' | 'type' | 'key'
  payload: Record<string, unknown>
  sessionId: string
  status: ComputerUseStatusPayload
  grants: ComputerSessionGrantStore
}): { scopeKey: string; targetLabel: string; forwardWindow: Record<string, unknown> } {
  const { action, payload, sessionId, status, grants } = input
  const captureId = typeof payload.captureId === 'string' ? payload.captureId : undefined
  if (action === 'click' || action === 'drag' || action === 'scroll') {
    if (!captureId) throw new Error('STALE_CAPTURE：指针操作必须提供有效的 capture_id')
    const capture = grants.getCapture(sessionId, captureId)
    if (!capture) {
      throw new Error('STALE_CAPTURE：找不到本会话对应的截图授权归属，请先调用 computer_screenshot')
    }
    return { scopeKey: capture.scopeKey, targetLabel: capture.label, forwardWindow: {} }
  }
  const reqWid = typeof payload.windowId === 'number' ? payload.windowId : undefined
  const reqPid = typeof payload.pid === 'number' ? payload.pid : undefined
  if (reqWid !== undefined || reqPid !== undefined) {
    const matched = matchWindowStrict(status.windows, reqWid, reqPid)!
    return {
      scopeKey: `app:${matched.appName}`,
      targetLabel: formatWindowLabel(matched),
      forwardWindow: { windowId: matched.windowId, pid: matched.pid },
    }
  }
  if (captureId) {
    const capture = grants.getCapture(sessionId, captureId)
    if (!capture) {
      throw new Error('STALE_CAPTURE：找不到本会话对应的截图授权归属，请先调用 computer_screenshot')
    }
    return {
      scopeKey: capture.scopeKey,
      targetLabel: capture.label,
      forwardWindow: {
        ...(capture.windowId !== undefined ? { windowId: capture.windowId } : {}),
        ...(capture.pid !== undefined ? { pid: capture.pid } : {}),
      },
    }
  }
  const active = grants.getActiveTarget(sessionId)
  if (active) {
    return {
      scopeKey: active.scopeKey,
      targetLabel: active.label,
      forwardWindow: {
        ...(active.windowId !== undefined ? { windowId: active.windowId } : {}),
        ...(active.pid !== undefined ? { pid: active.pid } : {}),
      },
    }
  }
  const front = status.windows.find(item => item.isFrontmost)
  if (front) {
    return {
      scopeKey: `app:${front.appName}`,
      targetLabel: formatWindowLabel(front),
      forwardWindow: { windowId: front.windowId, pid: front.pid },
    }
  }
  return { ...resolveDisplayScope(status), forwardWindow: {} }
}

/** 执行需要坐标或键盘注入的受控桌面动作（click / drag / scroll / type / key）。 */
export async function executeComputerInputAction(
  ctx: Context,
  exec: ToolRunContext,
  grants: ComputerSessionGrantStore,
  input: {
    action: 'click' | 'drag' | 'scroll' | 'type' | 'key'
    summary: string
    payload: Record<string, unknown>
    forcePerCall?: boolean
  },
): Promise<JsonValue> {
  return runSerializedComputerAction(ctx, exec, grants, async (sessionId, status) => {
    const resolved = resolveInputScopeAndTarget({
      action: input.action,
      payload: input.payload,
      sessionId,
      status,
      grants,
    })
    const authorization = await ensureComputerActionConsent(ctx, exec, grants, {
      status,
      scopeKey: resolved.scopeKey,
      targetLabel: resolved.targetLabel,
      actionSummary: input.summary,
      ...(input.forcePerCall ? { forcePerCall: true } : {}),
    })
    const { windowId: _w, pid: _p, ...cleanPayload } = input.payload
    const result = await ctx.mydshAutomationSystem.call<Record<string, JsonValue>>(
      `automation.computer.${input.action}`,
      {
        sessionId,
        targetLabel: resolved.targetLabel,
        ...cleanPayload,
        ...resolved.forwardWindow,
      },
      exec.signal,
    )
    return { ...result, authorization } as JsonValue
  })
}
