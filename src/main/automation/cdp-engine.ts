/**
 * 统一 CDP 页面操控引擎：内置 `WebContentsView` 与外置 Chrome/Edge 100% 共享本引擎。
 * 负责 `@eN` 交互元素快照、过期 `snapshotId` 守卫、点击、中文输入、滚动、下拉选择、等待、截图与脱敏诊断。
 */
import { randomUUID } from 'node:crypto'
import {
  abortableDelay,
  attachCdpDiagnostics,
  defaultPassthroughScaler,
  sanitizeDiagnosticUrl,
} from './cdp-diagnostics.ts'
import { dispatchCdpKeyPress, dispatchCdpMouseClick } from './cdp-dispatch.ts'
import {
  buildFallbackInputScript,
  buildInspectPointElementScript,
  buildNumberedSnapshot,
  buildSelectOptionScript,
  CHECK_ACTIVE_ELEMENT_PASSWORD_SCRIPT,
  COLLECT_DOM_SNAPSHOT_SCRIPT,
  detectSensitiveHandoff,
  isSensitiveSubmitElement,
  summarizeAxTreeNodes,
  type RawDomSnapshot,
} from './cdp-snapshot.ts'
import type {
  CdpPageEngine,
  CdpScreenshotResult,
  CdpSnapshotElement,
  CdpSnapshotResult,
  CdpTransport,
  ImageScaler,
} from './cdp-transport.ts'

export type { CdpPageEngine } from './cdp-transport.ts'

interface StoredRef {
  element: CdpSnapshotElement
  pageCenter: { x: number; y: number }
}

interface EngineState {
  transport: CdpTransport
  diagnostics: ReturnType<typeof attachCdpDiagnostics>
  scaler: ImageScaler
  capturePngOverride?: (options?: { fullPage?: boolean; signal?: AbortSignal }) => Promise<Buffer>
  getUrl?: () => string
  getTitle?: () => string
  initialized: boolean
  initPromise: Promise<void> | null
  snapshotId: string | null
  lastUrl: string
  lastTitle: string
  viewport: { width: number; height: number }
  refs: Map<string, StoredRef>
  offNavigated?: () => void
}

async function evaluateJson<T>(
  transport: CdpTransport,
  expression: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await transport.sendCommand<{
    result?: { value?: T }
    exceptionDetails?: { text?: string; exception?: { description?: string } }
  }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false }, signal)
  if (response.exceptionDetails) {
    const detail =
      response.exceptionDetails.exception?.description ??
      response.exceptionDetails.text ??
      '页面脚本执行失败'
    throw new Error(`页面脚本评估失败：${detail.slice(0, 240)}`)
  }
  return response.result?.value as T
}

async function ensureInitialized(state: EngineState, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (!state.transport.isAlive()) throw new Error('浏览器 CDP 通道已断开')
  if (state.initialized) return
  if (!state.initPromise) {
    const domains = [
      'Page.enable',
      'Runtime.enable',
      'Network.enable',
      'Log.enable',
      'DOM.enable',
      'Accessibility.enable',
    ]
    state.initPromise = Promise.all(
      domains.map(method =>
        state.transport.sendCommand(method, {}, signal).catch(error => {
          if (signal?.aborted || !state.transport.isAlive()) throw error
        }),
      ),
    )
      .then(() => {
        signal?.throwIfAborted()
        if (!state.transport.isAlive()) throw new Error('浏览器 CDP 通道已断开')
        state.initialized = true
      })
      .finally(() => {
        state.initPromise = null
      })
  }
  await state.initPromise
}

function lookupRef(state: EngineState, ref: string, snapshotId?: string): StoredRef {
  if (state.snapshotId === null) {
    throw new Error('STALE_SNAPSHOT：当前页面尚未建立快照或页面已导航，请先调用 browser_snapshot')
  }
  if (snapshotId && snapshotId !== state.snapshotId) {
    throw new Error('STALE_SNAPSHOT：快照标识已过期，请重新调用 browser_snapshot 获取最新元素编号')
  }
  const normalized = ref.startsWith('@') ? ref : `@${ref}`
  const found = state.refs.get(normalized)
  if (!found) {
    throw new Error(`ELEMENT_NOT_FOUND：当前快照中不存在元素 ${normalized}，请重新检查快照`)
  }
  return found
}

async function resolveTargetPoint(
  state: EngineState,
  input: { ref?: string; snapshotId?: string; x?: number; y?: number; signal?: AbortSignal },
): Promise<{ x: number; y: number; element?: CdpSnapshotElement }> {
  if (input.ref) {
    const stored = lookupRef(state, input.ref, input.snapshotId)
    if (!stored.element.inViewport) {
      const targetScrollY = Math.max(0, Math.round(stored.pageCenter.y - state.viewport.height / 2))
      const targetScrollX = Math.max(0, Math.round(stored.pageCenter.x - state.viewport.width / 2))
      const scroll = await evaluateJson<{ x: number; y: number }>(
        state.transport,
        `(() => { window.scrollTo(${targetScrollX}, ${targetScrollY}); return { x: Math.round(window.scrollX || 0), y: Math.round(window.scrollY || 0) }; })()`,
        input.signal,
      )
      return {
        x: Math.max(1, Math.round(stored.pageCenter.x - (scroll?.x ?? 0))),
        y: Math.max(1, Math.round(stored.pageCenter.y - (scroll?.y ?? 0))),
        element: stored.element,
      }
    }
    return { x: stored.element.center.x, y: stored.element.center.y, element: stored.element }
  }
  if (typeof input.x === 'number' && typeof input.y === 'number') {
    if (!Number.isFinite(input.x) || !Number.isFinite(input.y) || input.x < 0 || input.y < 0) {
      throw new Error('点击坐标必须为非负有限数字')
    }
    return { x: Math.round(input.x), y: Math.round(input.y) }
  }
  throw new Error('必须提供元素编号 ref 或逻辑坐标 (x, y)')
}

async function capturePageSnapshot(
  state: EngineState,
  options?: { maxBytes?: number; signal?: AbortSignal },
): Promise<CdpSnapshotResult> {
  await ensureInitialized(state, options?.signal)
  const raw = await evaluateJson<RawDomSnapshot>(
    state.transport,
    COLLECT_DOM_SNAPSHOT_SCRIPT,
    options?.signal,
  )
  if (!raw || typeof raw !== 'object') {
    throw new Error('无法读取当前页面结构，页面可能正在加载或尚未打开网址')
  }
  let axLines: string[] = []
  try {
    const axTree = await state.transport.sendCommand<{ nodes?: unknown }>(
      'Accessibility.getFullAXTree',
      { depth: 6 },
      options?.signal,
    )
    axLines = summarizeAxTreeNodes(axTree?.nodes)
  } catch {
    /* 部分页面或轻量模拟传输未启用 Accessibility 域时平滑降级为 DOM 快照。 */
  }
  const built = buildNumberedSnapshot(raw, axLines, options?.maxBytes ?? 32 * 1024)
  const snapshotId = `snap_${randomUUID().slice(0, 12)}`
  const scrollX = raw.scroll?.x ?? 0
  const scrollY = raw.scroll?.y ?? 0
  state.snapshotId = snapshotId
  state.lastUrl = raw.url || state.getUrl?.() || ''
  state.lastTitle = raw.title || state.getTitle?.() || ''
  state.viewport = raw.viewport
  state.refs.clear()
  for (const element of built.elements) {
    state.refs.set(element.ref, {
      element,
      pageCenter: { x: element.center.x + scrollX, y: element.center.y + scrollY },
    })
  }
  const handoff = detectSensitiveHandoff({
    url: state.lastUrl,
    title: state.lastTitle,
    bodySnippet: raw.bodySnippet,
    hasCaptcha: raw.signals?.hasCaptcha,
    hasPasswordInput: raw.signals?.hasPasswordInput,
  })
  return {
    snapshotId,
    url: state.lastUrl,
    title: state.lastTitle,
    viewport: raw.viewport,
    elementsCount: built.elements.length,
    truncated: built.truncated,
    tree: built.tree,
    ...(handoff ? { handoff } : {}),
  }
}

async function capturePageScreenshot(
  state: EngineState,
  options?: { fullPage?: boolean; maxLongEdge?: number; signal?: AbortSignal },
): Promise<CdpScreenshotResult> {
  await ensureInitialized(state, options?.signal)
  const meta = await evaluateJson<{ url: string; title: string; width: number; height: number }>(
    state.transport,
    `({ url: location.href, title: document.title || '', width: Math.max(1, window.innerWidth || 1280), height: Math.max(1, window.innerHeight || 800) })`,
    options?.signal,
  ).catch(() => ({
    url: state.getUrl?.() ?? state.lastUrl,
    title: state.getTitle?.() ?? state.lastTitle,
    width: state.viewport.width,
    height: state.viewport.height,
  }))
  let rawPng: Buffer
  if (state.capturePngOverride) {
    rawPng = await state.capturePngOverride({
      ...(options?.fullPage ? { fullPage: true } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
    })
  } else {
    const shot = await state.transport.sendCommand<{ data?: string }>(
      'Page.captureScreenshot',
      {
        format: 'png',
        fromSurface: true,
        ...(options?.fullPage ? { captureBeyondViewport: true } : {}),
      },
      options?.signal,
    )
    if (typeof shot?.data !== 'string' || !shot.data) {
      throw new Error('浏览器未返回有效截图数据')
    }
    rawPng = Buffer.from(shot.data, 'base64')
  }
  const scaled = state.scaler(rawPng, options?.maxLongEdge ?? 1280)
  return {
    base64: scaled.buffer.toString('base64'),
    mediaType: scaled.mediaType,
    width: scaled.width,
    height: scaled.height,
    viewportWidth: meta.width,
    viewportHeight: meta.height,
    bytes: scaled.buffer.byteLength,
    url: meta.url || state.lastUrl,
    title: meta.title || state.lastTitle,
  }
}

async function waitForPageCondition(
  state: EngineState,
  options: {
    timeoutMs?: number
    text?: string
    selector?: string
    networkIdle?: boolean
    signal?: AbortSignal
  },
): Promise<{ ok: true; waitedMs: number; condition: string }> {
  await ensureInitialized(state, options.signal)
  const timeoutMs = Math.max(100, Math.min(30_000, Math.round(options.timeoutMs ?? 5000)))
  const start = Date.now()
  if (!options.text && !options.selector && !options.networkIdle) {
    await abortableDelay(timeoutMs, options.signal)
    return { ok: true, waitedMs: Date.now() - start, condition: `delay:${timeoutMs}ms` }
  }
  let idleSince = 0
  while (Date.now() - start <= timeoutMs) {
    options.signal?.throwIfAborted()
    if (options.text) {
      const matched = await evaluateJson<boolean>(
        state.transport,
        `Boolean(document.body && document.body.innerText && document.body.innerText.includes(${JSON.stringify(options.text)}))`,
        options.signal,
      )
      if (matched)
        return { ok: true, waitedMs: Date.now() - start, condition: `text:${options.text}` }
    } else if (options.selector) {
      const matched = await evaluateJson<boolean>(
        state.transport,
        `Boolean(document.querySelector(${JSON.stringify(options.selector)}))`,
        options.signal,
      )
      if (matched) {
        return { ok: true, waitedMs: Date.now() - start, condition: `selector:${options.selector}` }
      }
    } else if (options.networkIdle) {
      if (state.diagnostics.getInFlightCount() === 0) {
        if (idleSince === 0) idleSince = Date.now()
        if (Date.now() - idleSince >= 400) {
          return { ok: true, waitedMs: Date.now() - start, condition: 'networkidle' }
        }
      } else {
        idleSince = 0
      }
    }
    const remaining = timeoutMs - (Date.now() - start)
    if (remaining <= 0) break
    await abortableDelay(Math.min(150, remaining), options.signal)
  }
  throw new Error(`WAIT_TIMEOUT：在 ${timeoutMs}ms 内未满足等待条件`)
}

async function performClick(
  state: EngineState,
  opts: Parameters<CdpPageEngine['click']>[0],
): ReturnType<CdpPageEngine['click']> {
  await ensureInitialized(state, opts.signal)
  const target = await resolveTargetPoint(state, opts)
  const inspected =
    target.element ??
    (await evaluateJson<{
      tag: string
      role: string
      name: string
      inputType?: string
    } | null>(
      state.transport,
      buildInspectPointElementScript(target.x, target.y),
      opts.signal,
    ).catch(() => null))
  if (inspected && isSensitiveSubmitElement(inspected)) {
    return {
      ok: false,
      x: target.x,
      y: target.y,
      handoff: {
        required: true,
        category: inspected.inputType === 'password' ? 'auth' : 'payment',
        reason: `即将点击敏感控件「${inspected.name || inspected.tag}」，必须由用户手动确认与操作。`,
        url: state.getUrl?.() || state.lastUrl,
      },
    }
  }
  await dispatchCdpMouseClick(state.transport, {
    x: target.x,
    y: target.y,
    button: opts.button ?? 'left',
    clickCount: Math.max(1, Math.min(3, opts.clickCount ?? 1)),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
  return { ok: true, x: target.x, y: target.y }
}

async function prepareTypeFocusTarget(
  state: EngineState,
  opts: Parameters<CdpPageEngine['type']>[0],
): Promise<
  | { handoff: Awaited<ReturnType<CdpPageEngine['type']>> }
  | { focusHint: string | null; focusPoint: { x: number; y: number } | null }
> {
  if (!opts.ref) {
    // 无 ref 直接输入时同样核查当前页面焦点，阻断通过坐标点击或 Tab 切焦点绕过密码框交接。
    const activeIsPassword = await evaluateJson<boolean>(
      state.transport,
      CHECK_ACTIVE_ELEMENT_PASSWORD_SCRIPT,
      opts.signal,
    ).catch(() => false)
    if (activeIsPassword) {
      return {
        handoff: {
          ok: false,
          typedLength: 0,
          handoff: {
            required: true,
            category: 'auth',
            reason: '检测到当前焦点为密码输入框，禁止由模型自动填写密码，请由用户手动输入。',
            url: state.getUrl?.() || state.lastUrl,
          },
        },
      }
    }
    return { focusHint: null, focusPoint: null }
  }
  const target = await resolveTargetPoint(state, {
    ref: opts.ref,
    ...(opts.snapshotId ? { snapshotId: opts.snapshotId } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
  if (target.element?.inputType === 'password') {
    return {
      handoff: {
        ok: false,
        typedLength: 0,
        handoff: {
          required: true,
          category: 'auth',
          reason: '检测到目标为密码输入框，禁止由模型自动填写密码，请由用户手动输入。',
          url: state.getUrl?.() || state.lastUrl,
        },
      },
    }
  }
  const focusHint = target.element?.selectorHint ?? null
  await dispatchCdpMouseClick(state.transport, {
    x: target.x,
    y: target.y,
    button: 'left',
    clickCount: 1,
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
  await evaluateJson<boolean>(
    state.transport,
    `(() => {
      const hint = ${JSON.stringify(focusHint)};
      const el = (hint && document.querySelector(hint)) || document.elementFromPoint(${target.x}, ${target.y});
      if (el && typeof el.focus === 'function') { el.focus(); return true; }
      return false;
    })()`,
    opts.signal,
  ).catch(() => false)
  return { focusHint, focusPoint: { x: target.x, y: target.y } }
}

async function performType(
  state: EngineState,
  opts: Parameters<CdpPageEngine['type']>[0],
): ReturnType<CdpPageEngine['type']> {
  await ensureInitialized(state, opts.signal)
  const prepared = await prepareTypeFocusTarget(state, opts)
  if ('handoff' in prepared) return prepared.handoff
  if (opts.clear) {
    await dispatchCdpKeyPress(
      state.transport,
      'a',
      [process.platform === 'darwin' ? 'Meta' : 'Control'],
      opts.signal,
    )
    await dispatchCdpKeyPress(state.transport, 'Backspace', [], opts.signal)
  }
  if (opts.text.length > 0) {
    await state.transport.sendCommand('Input.insertText', { text: opts.text }, opts.signal)
    if (prepared.focusPoint) {
      // 后台未聚焦的 WebContentsView 下 Input.insertText 可能被忽略，核对并在未写入时使用原生 setter 补齐。
      await evaluateJson<void>(
        state.transport,
        buildFallbackInputScript({
          hint: prepared.focusHint,
          x: prepared.focusPoint.x,
          y: prepared.focusPoint.y,
          text: opts.text,
          clear: opts.clear === true,
        }),
        opts.signal,
      ).catch(() => {})
    }
  }
  if (opts.submit) {
    await dispatchCdpKeyPress(state.transport, 'Enter', [], opts.signal)
  }
  return { ok: true, typedLength: opts.text.length }
}

async function performScroll(
  state: EngineState,
  opts: Parameters<CdpPageEngine['scroll']>[0],
): ReturnType<CdpPageEngine['scroll']> {
  await ensureInitialized(state, opts.signal)
  let x = opts.x ?? Math.round(state.viewport.width / 2)
  let y = opts.y ?? Math.round(state.viewport.height / 2)
  if (opts.ref) {
    const target = await resolveTargetPoint(state, {
      ref: opts.ref,
      ...(opts.snapshotId ? { snapshotId: opts.snapshotId } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    x = target.x
    y = target.y
  }
  await state.transport.sendCommand(
    'Input.dispatchMouseEvent',
    {
      type: 'mouseWheel',
      x,
      y,
      deltaX: Math.round(opts.deltaX ?? 0),
      deltaY: Math.round(opts.deltaY ?? 360),
    },
    opts.signal,
  )
  return { ok: true }
}

async function performSelect(
  state: EngineState,
  opts: Parameters<CdpPageEngine['select']>[0],
): ReturnType<CdpPageEngine['select']> {
  await ensureInitialized(state, opts.signal)
  const target = await resolveTargetPoint(state, {
    ref: opts.ref,
    ...(opts.snapshotId ? { snapshotId: opts.snapshotId } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
  const result = await evaluateJson<{
    ok: boolean
    error?: string
    selectedValue?: string
    selectedLabel?: string
  }>(
    state.transport,
    buildSelectOptionScript({
      hint: target.element?.selectorHint ?? null,
      x: target.x,
      y: target.y,
      ...(opts.value !== undefined ? { value: opts.value } : {}),
      ...(opts.label !== undefined ? { label: opts.label } : {}),
    }),
    opts.signal,
  )
  if (!result?.ok) throw new Error(result?.error ?? '下拉框选项设置失败')
  return {
    ok: true,
    selectedValue: result.selectedValue ?? '',
    selectedLabel: result.selectedLabel ?? '',
  }
}

/** 创建统一 CDP 页面操控引擎实例，绑定指定 CDP 传输层。 */
export function createCdpPageEngine(options: {
  transport: CdpTransport
  scaler?: ImageScaler
  capturePngOverride?: (options?: { fullPage?: boolean; signal?: AbortSignal }) => Promise<Buffer>
  getUrl?: () => string
  getTitle?: () => string
}): CdpPageEngine {
  const state: EngineState = {
    transport: options.transport,
    diagnostics: attachCdpDiagnostics(options.transport),
    scaler: options.scaler ?? defaultPassthroughScaler,
    ...(options.capturePngOverride ? { capturePngOverride: options.capturePngOverride } : {}),
    ...(options.getUrl ? { getUrl: options.getUrl } : {}),
    ...(options.getTitle ? { getTitle: options.getTitle } : {}),
    initialized: false,
    initPromise: null,
    snapshotId: null,
    lastUrl: '',
    lastTitle: '',
    viewport: { width: 1280, height: 800 },
    refs: new Map(),
  }
  state.offNavigated = options.transport.onEvent('Page.frameNavigated', params => {
    const frame = params.frame as Record<string, unknown> | undefined
    if (frame && !frame.parentId) {
      state.snapshotId = null
      state.refs.clear()
      if (typeof frame.url === 'string') state.lastUrl = frame.url
    }
  })

  return {
    init: signal => ensureInitialized(state, signal),
    invalidateSnapshot() {
      state.snapshotId = null
      state.refs.clear()
    },
    snapshot: opts => capturePageSnapshot(state, opts),
    screenshot: opts => capturePageScreenshot(state, opts),
    click: opts => performClick(state, opts),
    type: opts => performType(state, opts),
    async pressKey(opts) {
      await ensureInitialized(state, opts.signal)
      await dispatchCdpKeyPress(state.transport, opts.key, opts.modifiers, opts.signal)
      return { ok: true, key: opts.key }
    },
    scroll: opts => performScroll(state, opts),
    select: opts => performSelect(state, opts),
    wait: opts => waitForPageCondition(state, opts),
    diagnostics(opts) {
      const read = state.diagnostics.read(opts)
      return {
        console: read.console,
        network: read.network,
        url: sanitizeDiagnosticUrl(state.getUrl?.() || state.lastUrl),
      }
    },
    async dispose() {
      state.offNavigated?.()
      state.diagnostics.dispose()
      state.refs.clear()
      await state.transport.close().catch(() => {})
    },
  }
}
