/**
 * 共享 CDP 动作分发器：将 `snapshot`/`screenshot`/`click`/`type` 等主进程载荷统一映射到 `CdpPageEngine`。
 * 供内置浏览器驱动与外置浏览器驱动共同调用，避免维护两套参数解析逻辑。
 */
import { resolveCdpKey } from './cdp-diagnostics.ts'
import type { CdpPageEngine } from './cdp-engine.ts'
import type { CdpTransport } from './cdp-transport.ts'

/** 通过 CDP `Input.dispatchMouseEvent` 发送移动、按下与抬起完整点击序列。 */
export async function dispatchCdpMouseClick(
  transport: CdpTransport,
  input: {
    x: number
    y: number
    button: 'left' | 'right' | 'middle'
    clickCount: number
    signal?: AbortSignal
  },
): Promise<void> {
  let buttons = 1
  if (input.button === 'right') buttons = 2
  else if (input.button === 'middle') buttons = 4
  await transport.sendCommand(
    'Input.dispatchMouseEvent',
    { type: 'mouseMoved', x: input.x, y: input.y, button: 'none', buttons: 0 },
    input.signal,
  )
  for (let click = 1; click <= input.clickCount; click += 1) {
    await transport.sendCommand(
      'Input.dispatchMouseEvent',
      {
        type: 'mousePressed',
        x: input.x,
        y: input.y,
        button: input.button,
        buttons,
        clickCount: click,
      },
      input.signal,
    )
    await transport.sendCommand(
      'Input.dispatchMouseEvent',
      {
        type: 'mouseReleased',
        x: input.x,
        y: input.y,
        button: input.button,
        buttons: 0,
        clickCount: click,
      },
      input.signal,
    )
  }
}

/** 通过 CDP `Input.dispatchKeyEvent` 发送单次按键与修饰键组合。 */
export async function dispatchCdpKeyPress(
  transport: CdpTransport,
  key: string,
  modifiers: readonly string[] = [],
  signal?: AbortSignal,
): Promise<void> {
  const { descriptor, modifierMask } = resolveCdpKey(key, modifiers)
  await transport.sendCommand(
    'Input.dispatchKeyEvent',
    {
      type: descriptor.text ? 'keyDown' : 'rawKeyDown',
      key: descriptor.key,
      code: descriptor.code,
      windowsVirtualKeyCode: descriptor.keyCode,
      nativeVirtualKeyCode: descriptor.keyCode,
      modifiers: modifierMask,
      ...(descriptor.text ? { text: descriptor.text, unmodifiedText: descriptor.text } : {}),
    },
    signal,
  )
  await transport.sendCommand(
    'Input.dispatchKeyEvent',
    {
      type: 'keyUp',
      key: descriptor.key,
      code: descriptor.code,
      windowsVirtualKeyCode: descriptor.keyCode,
      nativeVirtualKeyCode: descriptor.keyCode,
      modifiers: modifierMask,
    },
    signal,
  )
}

/** 从动作载荷中读取可选非空字符串。 */
export function readOptionalString(
  payload: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = payload[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 从动作载荷中读取可选有限数字。 */
export function readOptionalNumber(
  payload: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = payload[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

async function runInputAction(
  engine: CdpPageEngine,
  action: string,
  payload: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const ref = readOptionalString(payload, 'ref')
  const snapshotId = readOptionalString(payload, 'snapshotId')
  const x = readOptionalNumber(payload, 'x')
  const y = readOptionalNumber(payload, 'y')
  if (action === 'click') {
    const button =
      payload.button === 'right' || payload.button === 'middle' ? payload.button : 'left'
    const clickCount = readOptionalNumber(payload, 'clickCount')
    return engine.click({
      ...(ref ? { ref } : {}),
      ...(snapshotId ? { snapshotId } : {}),
      ...(x !== undefined ? { x } : {}),
      ...(y !== undefined ? { y } : {}),
      button,
      ...(clickCount !== undefined ? { clickCount } : {}),
      signal,
    })
  }
  if (action === 'type') {
    return engine.type({
      ...(ref ? { ref } : {}),
      ...(snapshotId ? { snapshotId } : {}),
      text: typeof payload.text === 'string' ? payload.text : '',
      clear: payload.clear === true,
      submit: payload.submit === true,
      signal,
    })
  }
  if (action === 'pressKey') {
    return engine.pressKey({
      key: typeof payload.key === 'string' ? payload.key : '',
      modifiers: Array.isArray(payload.modifiers)
        ? payload.modifiers.filter((item): item is string => typeof item === 'string')
        : [],
      signal,
    })
  }
  if (action === 'scroll') {
    const deltaX = readOptionalNumber(payload, 'deltaX')
    const deltaY = readOptionalNumber(payload, 'deltaY')
    return engine.scroll({
      ...(ref ? { ref } : {}),
      ...(snapshotId ? { snapshotId } : {}),
      ...(x !== undefined ? { x } : {}),
      ...(y !== undefined ? { y } : {}),
      ...(deltaX !== undefined ? { deltaX } : {}),
      ...(deltaY !== undefined ? { deltaY } : {}),
      signal,
    })
  }
  const value = readOptionalString(payload, 'value')
  const label = readOptionalString(payload, 'label')
  return engine.select({
    ref: ref ?? '',
    ...(snapshotId ? { snapshotId } : {}),
    ...(value !== undefined ? { value } : {}),
    ...(label !== undefined ? { label } : {}),
    signal,
  })
}

/** 分发单个页面上的统一 CDP 操控动作，并附加当前 `tabId`。 */
export async function dispatchCdpEngineAction(input: {
  engine: CdpPageEngine
  tabId: string
  action: string
  payload: Record<string, unknown>
  signal: AbortSignal
}): Promise<unknown> {
  const { engine, tabId, action, payload, signal } = input
  if (action === 'snapshot') {
    const rawMaxBytes = readOptionalNumber(payload, 'maxBytes')
    const maxBytes =
      rawMaxBytes !== undefined
        ? Math.max(1024, Math.min(65_536, Math.round(rawMaxBytes)))
        : undefined
    return {
      tabId,
      ...(await engine.snapshot({ ...(maxBytes !== undefined ? { maxBytes } : {}), signal })),
    }
  }
  if (action === 'screenshot') {
    const maxLongEdge = readOptionalNumber(payload, 'maxLongEdge')
    return {
      tabId,
      ...(await engine.screenshot({
        fullPage: payload.fullPage === true,
        ...(maxLongEdge ? { maxLongEdge } : {}),
        signal,
      })),
    }
  }
  if (
    action === 'click' ||
    action === 'type' ||
    action === 'pressKey' ||
    action === 'scroll' ||
    action === 'select'
  ) {
    return { tabId, ...(await runInputAction(engine, action, payload, signal)) }
  }
  if (action === 'wait') {
    const timeoutMs = readOptionalNumber(payload, 'timeoutMs')
    const text = readOptionalString(payload, 'text')
    const selector = readOptionalString(payload, 'selector')
    return {
      tabId,
      ...(await engine.wait({
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(text ? { text } : {}),
        ...(selector ? { selector } : {}),
        networkIdle: payload.networkIdle === true,
        signal,
      })),
    }
  }
  if (action === 'diagnostics') {
    const consoleLimit = readOptionalNumber(payload, 'consoleLimit')
    const networkLimit = readOptionalNumber(payload, 'networkLimit')
    return {
      tabId,
      ...engine.diagnostics({
        ...(consoleLimit !== undefined ? { consoleLimit } : {}),
        ...(networkLimit !== undefined ? { networkLimit } : {}),
        clear: payload.clear === true,
      }),
    }
  }
  throw new Error(`不支持的浏览器自动化动作：${action}`)
}
