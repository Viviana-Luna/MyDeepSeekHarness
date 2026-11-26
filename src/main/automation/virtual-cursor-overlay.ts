/**
 * 桌面 Computer Use 模拟 AI 光标覆盖层：使用紧凑型 `240×120` 透明鼠标穿透浮窗渲染发光 AI 箭头、点击波纹与动作胶囊。
 * 相比全屏透明窗像素量缩减 60+ 倍，大幅降低 macOS WindowServer 合成负载；支持步间复温复用，并在急停或退出时立即销毁。
 */
import { BrowserWindow } from 'electron'
import type { LogicalRect } from './computer-use-policy.ts'

const WINDOW_WIDTH = 240
const WINDOW_HEIGHT = 120
const TIP_OFFSET_X = 28
const TIP_OFFSET_Y = 28
const IDLE_HIDE_MS = 2_200
const IDLE_DESTROY_MS = 15_000

/** 模拟 AI 光标单次视觉提示载荷。 */
export interface VirtualCursorActionEvent {
  readonly kind: 'click' | 'drag' | 'scroll' | 'key'
  readonly x: number
  readonly y: number
  readonly toX?: number
  readonly toY?: number
  readonly deltaX?: number
  readonly deltaY?: number
  readonly clickCount?: number
  readonly button?: 'left' | 'right' | 'middle'
  readonly label: string
  readonly targetBounds?: LogicalRect
}

/** 主进程模拟 AI 光标控制器接口。 */
export interface VirtualCursorOverlayController {
  showAction(event: VirtualCursorActionEvent): Promise<void>
  setCaptureHidden(hidden: boolean): void
  hide(): void
  dispose(): void
}

const COMPACT_CURSOR_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;width:240px;height:120px;overflow:hidden;background:transparent;pointer-events:none;-webkit-user-select:none}
  #root{position:relative;width:240px;height:120px;opacity:0;transition:opacity 140ms ease}
  #root.on{opacity:1}
  #arrow{position:absolute;left:26px;top:26px;display:block;filter:drop-shadow(0 2px 5px rgba(15,23,42,.55)) drop-shadow(0 0 6px rgba(56,189,248,.48))}
  #badge{position:absolute;left:44px;top:44px;display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border-radius:999px;background:rgba(15,23,42,.9);border:1px solid rgba(56,189,248,.58);color:#f8fafc;font:600 11px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:nowrap;box-shadow:0 3px 10px rgba(15,23,42,.4)}
  .dot{width:6px;height:6px;border-radius:50%;background:#38bdf8;box-shadow:0 0 6px #38bdf8}
  .ring{position:absolute;left:28px;top:28px;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;border:2px solid #38bdf8;box-shadow:0 0 8px rgba(56,189,248,.7);animation:pop 460ms cubic-bezier(.16,1,.3,1) forwards}
  .ring.right{border-color:#f59e0b;box-shadow:0 0 8px rgba(245,158,11,.7)}
  @keyframes pop{0%{transform:scale(.55);opacity:.95}100%{transform:scale(3.1);opacity:0}}
</style></head><body>
  <div id="root">
    <div id="rings"></div>
    <svg id="arrow" width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M2.5 2.2L19.6 11.4L12.1 13.1L8.9 20.4L2.5 2.2Z" fill="#0f172a" stroke="#38bdf8" stroke-width="1.8" stroke-linejoin="round"/>
    </svg>
    <div id="badge"><span class="dot"></span><span id="label">AI</span></div>
  </div>
  <script>
    (function () {
      const root = document.getElementById('root');
      const label = document.getElementById('label');
      const rings = document.getElementById('rings');
      function spawn(rightBtn, delayMs) {
        setTimeout(() => {
          const el = document.createElement('div');
          el.className = 'ring' + (rightBtn ? ' right' : '');
          rings.appendChild(el);
          setTimeout(() => el.remove(), 480);
        }, delayMs);
      }
      window.__mydshCursor = {
        pulse(ev) {
          root.classList.add('on');
          label.textContent = ev.label || 'AI';
          const count = ev.kind === 'click' ? Math.max(1, Math.min(3, ev.clickCount || 1)) : 1;
          for (let i = 0; i < count; i++) spawn(ev.button === 'right', i * 95);
        },
        fade() {
          root.classList.remove('on');
        },
      };
    })();
  </script>
</body></html>`

interface OverlayState {
  headless: boolean
  win: BrowserWindow | null
  readyPromise: Promise<void> | null
  hideTimer: ReturnType<typeof setTimeout> | null
  fadeTimer: ReturnType<typeof setTimeout> | null
  dragTimer: ReturnType<typeof setTimeout> | null
  destroyTimer: ReturnType<typeof setTimeout> | null
  disposed: boolean
  captureHiddenCount: number
}

function createCompactCursorWindow(x: number, y: number): BrowserWindow {
  const win = new BrowserWindow({
    x: Math.round(x - TIP_OFFSET_X),
    y: Math.round(y - TIP_OFFSET_Y),
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.setIgnoreMouseEvents(true)
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  return win
}

function clearOverlayTimers(state: OverlayState): void {
  if (state.hideTimer) {
    clearTimeout(state.hideTimer)
    state.hideTimer = null
  }
  if (state.fadeTimer) {
    clearTimeout(state.fadeTimer)
    state.fadeTimer = null
  }
  if (state.dragTimer) {
    clearTimeout(state.dragTimer)
    state.dragTimer = null
  }
  if (state.destroyTimer) {
    clearTimeout(state.destroyTimer)
    state.destroyTimer = null
  }
}

function destroyOverlayWindow(state: OverlayState): void {
  clearOverlayTimers(state)
  const current = state.win
  state.win = null
  state.readyPromise = null
  if (current && !current.isDestroyed()) current.destroy()
}

function positionCompactCursorWindow(win: BrowserWindow, x: number, y: number): void {
  // 使用 setBounds 同步锁定宽高，规避 Windows 跨不同 DPI 显示器移动透明窗时的意外缩放。
  win.setBounds(
    {
      x: Math.round(x - TIP_OFFSET_X),
      y: Math.round(y - TIP_OFFSET_Y),
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
    },
    false,
  )
}

function scheduleOverlayCleanup(state: OverlayState): void {
  clearOverlayTimers(state)
  state.hideTimer = setTimeout(() => {
    const current = state.win
    if (!current || current.isDestroyed()) return
    if (!current.webContents.isDestroyed()) {
      void current.webContents
        .executeJavaScript('window.__mydshCursor?.fade()', true)
        .catch(() => {})
    }
    // 预留 150ms 让淡出过渡动画播放完毕后再隐藏窗口。
    state.fadeTimer = setTimeout(() => {
      if (state.win === current && !current.isDestroyed()) current.hide()
    }, 150)
  }, IDLE_HIDE_MS)
  state.destroyTimer = setTimeout(() => {
    destroyOverlayWindow(state)
  }, IDLE_DESTROY_MS)
}

async function ensureOverlayWindow(
  state: OverlayState,
  x: number,
  y: number,
): Promise<BrowserWindow | null> {
  if (state.disposed || state.headless) return null
  if (!state.win || state.win.isDestroyed()) {
    const created = createCompactCursorWindow(x, y)
    state.win = created
    const htmlUrl = `data:text/html;charset=utf-8,${encodeURIComponent(COMPACT_CURSOR_HTML)}`
    const ready = created.loadURL(htmlUrl).catch(() => {})
    state.readyPromise = ready
    await ready
    if (state.disposed || state.win !== created || created.isDestroyed()) return null
    created.setOpacity(state.captureHiddenCount > 0 ? 0 : 1)
    created.showInactive()
    return created
  }
  const current = state.win
  const ready = state.readyPromise
  if (ready) await ready
  if (state.disposed || state.win !== current || current.isDestroyed()) return null
  positionCompactCursorWindow(current, x, y)
  current.setOpacity(state.captureHiddenCount > 0 ? 0 : 1)
  if (!current.isVisible()) current.showInactive()
  return current
}

/** 创建轻量级 `240×120` 模拟 AI 光标控制器；在 headless 环境自动退化为空操作。 */
export function createVirtualCursorOverlay(options?: {
  headless?: boolean
}): VirtualCursorOverlayController {
  const state: OverlayState = {
    headless: options?.headless === true,
    win: null,
    readyPromise: null,
    hideTimer: null,
    fadeTimer: null,
    dragTimer: null,
    destroyTimer: null,
    disposed: false,
    captureHiddenCount: 0,
  }
  return {
    async showAction(event) {
      if (state.disposed || state.headless) return
      try {
        clearOverlayTimers(state)
        const destX = event.toX ?? event.x
        const destY = event.toY ?? event.y
        const active = await ensureOverlayWindow(state, event.x, event.y)
        if (!active || active.isDestroyed() || active.webContents.isDestroyed()) return
        const payload = {
          kind: event.kind,
          label: event.label,
          ...(event.clickCount !== undefined ? { clickCount: event.clickCount } : {}),
          ...(event.button !== undefined ? { button: event.button } : {}),
        }
        void active.webContents
          .executeJavaScript(`window.__mydshCursor?.pulse(${JSON.stringify(payload)})`, true)
          .catch(() => {})
        scheduleOverlayCleanup(state)
        if (event.kind === 'drag' && (destX !== event.x || destY !== event.y)) {
          state.dragTimer = setTimeout(() => {
            state.dragTimer = null
            if (!state.disposed && state.win === active && !active.isDestroyed()) {
              positionCompactCursorWindow(active, destX, destY)
            }
          }, 80)
        }
      } catch {
        /* 视觉光标仅作辅助指示，异常不阻塞真实桌面操作。 */
      }
    },
    setCaptureHidden(hidden) {
      state.captureHiddenCount = hidden
        ? state.captureHiddenCount + 1
        : Math.max(0, state.captureHiddenCount - 1)
      if (state.win && !state.win.isDestroyed()) {
        state.win.setOpacity(state.captureHiddenCount > 0 ? 0 : 1)
      }
    },
    hide() {
      destroyOverlayWindow(state)
    },
    dispose() {
      state.disposed = true
      destroyOverlayWindow(state)
    },
  }
}
