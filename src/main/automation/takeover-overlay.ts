/**
 * 桌面接管全局急停控制器与悬浮状态胶囊：运行在 Electron 主进程。
 * 浮窗仅首次加载一次静态壳并通过脚本原地刷新步骤文案，步间延迟隐藏以复用窗口，杜绝每步销毁重建 Chromium 渲染进程导致的卡顿。
 */
import { BrowserWindow, globalShortcut, screen } from 'electron'
import {
  AUTOMATION_KILL_SWITCH_SHORTCUT,
  formatKillSwitchLabel,
  type AutomationTakeoverState,
} from '../../shared/automation.ts'

const TRANSIENT_HIDE_MS = 1_500
const IDLE_DESTROY_MS = 12_000

/** 全局急停与浮窗控制接口。 */
export interface TakeoverOverlayController {
  sync(state: AutomationTakeoverState): void
  dispose(): void
}

function shortcutHintLabel(shortcut: string): string {
  return formatKillSwitchLabel(shortcut)
}

const PILL_SHELL_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:transparent;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-user-select:none}
  .pill{display:flex;align-items:center;gap:10px;height:36px;padding:0 10px 0 14px;border-radius:999px;background:rgba(20,22,28,.92);border:1px solid rgba(255,255,255,.16);color:#f4f6fa;font-size:12px;box-sizing:border-box}
  .dot{width:8px;height:8px;border-radius:50%;background:#f59e0b;flex:none}
  .label{max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .hint{color:#9ca3af;font-size:11px;flex:none}
  .stop{display:inline-flex;align-items:center;height:24px;padding:0 10px;border-radius:999px;background:#ef4444;color:#fff;text-decoration:none;font-weight:600;font-size:11px;flex:none}
  .stop:hover{background:#dc2626}
</style></head><body>
  <div class="pill"><span class="dot"></span><span id="lbl" class="label">AI 自动化执行中</span><span id="hint" class="hint"></span><a class="stop" href="mydsh-stop://now">停止</a></div>
  <script>
    window.__setTakeover = function (text, hint) {
      document.getElementById('lbl').textContent = text;
      document.getElementById('hint').textContent = hint;
    };
  </script>
</body></html>`

interface TakeoverRuntime {
  headless: boolean
  onEmergencyStop(reason: string): void
  shortcutRegistered: boolean
  active: boolean
  generation: number
  win: BrowserWindow | null
  readyPromise: Promise<void> | null
  hideTimer: ReturnType<typeof setTimeout> | null
  destroyTimer: ReturnType<typeof setTimeout> | null
  disposed: boolean
}

function createOverlayWindow(onEmergencyStop: (reason: string) => void): BrowserWindow {
  const display = screen.getPrimaryDisplay()
  const width = 420
  const height = 42
  const x = Math.round(display.workArea.x + (display.workArea.width - width) / 2)
  const y = display.workArea.y + 10
  const win = new BrowserWindow({
    width,
    height,
    x,
    y,
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
  // 使用 pop-up-menu 层级，既保持置顶可见，也能被 macOS 原生防自锁 Z 序核验识别并防止 AI 误点自身停止按钮。
  win.setAlwaysOnTop(true, 'pop-up-menu')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    if (url === 'mydsh-stop://now') onEmergencyStop('用户点击悬浮停止按钮')
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  return win
}

function clearTimers(rt: TakeoverRuntime): void {
  if (rt.hideTimer) {
    clearTimeout(rt.hideTimer)
    rt.hideTimer = null
  }
  if (rt.destroyTimer) {
    clearTimeout(rt.destroyTimer)
    rt.destroyTimer = null
  }
}

function unregisterShortcut(rt: TakeoverRuntime): void {
  if (!rt.shortcutRegistered) return
  rt.shortcutRegistered = false
  try {
    globalShortcut.unregister(AUTOMATION_KILL_SWITCH_SHORTCUT)
  } catch {
    /* 退出阶段快捷键管理器可能已销毁，忽略清理异常。 */
  }
}

function destroyOverlay(rt: TakeoverRuntime): void {
  clearTimers(rt)
  const current = rt.win
  rt.win = null
  rt.readyPromise = null
  if (current && !current.isDestroyed()) current.destroy()
}

function showOrUpdatePill(rt: TakeoverRuntime, state: AutomationTakeoverState): void {
  if (rt.headless || state.kind !== 'computer-use') {
    destroyOverlay(rt)
    return
  }
  clearTimers(rt)
  const title = state.targetLabel ?? 'AI 自动化执行中'
  const label = state.stepCount > 0 ? `${title} · 第 ${state.stepCount} 步` : title
  const hint = shortcutHintLabel(state.killSwitchShortcut)
  const script = `window.__setTakeover?.(${JSON.stringify(label)}, ${JSON.stringify(hint)})`
  if (!rt.win || rt.win.isDestroyed()) {
    rt.win = createOverlayWindow(rt.onEmergencyStop)
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(PILL_SHELL_HTML)}`
    rt.readyPromise = rt.win.loadURL(url).catch(() => {})
  }
  const target = rt.win
  const generation = rt.generation
  const ready = rt.readyPromise ?? Promise.resolve()
  void ready.then(() => {
    if (
      rt.disposed ||
      !rt.active ||
      rt.generation !== generation ||
      rt.win !== target ||
      target.isDestroyed() ||
      target.webContents.isDestroyed()
    ) {
      return
    }
    void target.webContents.executeJavaScript(script, true).catch(() => {})
    if (!target.isVisible()) target.showInactive()
  })
}

/** 创建主进程急停控制器：桌面接管激活时注册急停快捷键，并在 Computer Use 时展示可复用的顶栏停止胶囊。 */
export function createTakeoverOverlay(options: {
  onEmergencyStop(reason: string): void
  headless?: boolean
}): TakeoverOverlayController {
  const rt: TakeoverRuntime = {
    headless: options.headless === true,
    onEmergencyStop: options.onEmergencyStop,
    shortcutRegistered: false,
    active: false,
    generation: 0,
    win: null,
    readyPromise: null,
    hideTimer: null,
    destroyTimer: null,
    disposed: false,
  }
  const ensureShortcut = (): void => {
    if (rt.shortcutRegistered || rt.headless) return
    try {
      rt.shortcutRegistered = globalShortcut.register(AUTOMATION_KILL_SWITCH_SHORTCUT, () => {
        rt.onEmergencyStop('用户触发全局急停快捷键')
      })
    } catch {
      rt.shortcutRegistered = false
    }
  }
  return {
    sync(state) {
      if (rt.disposed) return
      rt.generation += 1
      if (!state.active) {
        rt.active = false
        if (state.lastStoppedReason !== null || !rt.win || rt.win.isDestroyed()) {
          unregisterShortcut(rt)
          destroyOverlay(rt)
          return
        }
        // 连续步骤之间短暂保留复温浮窗与急停快捷键，待浮窗真正隐藏时再注销快捷键，确保界面提示与真实可用状态一致。
        clearTimers(rt)
        rt.hideTimer = setTimeout(() => {
          rt.hideTimer = null
          unregisterShortcut(rt)
          if (rt.win && !rt.win.isDestroyed()) rt.win.hide()
        }, TRANSIENT_HIDE_MS)
        rt.destroyTimer = setTimeout(() => {
          rt.destroyTimer = null
          unregisterShortcut(rt)
          destroyOverlay(rt)
        }, IDLE_DESTROY_MS)
        return
      }
      rt.active = true
      ensureShortcut()
      showOrUpdatePill(rt, state)
    },
    dispose() {
      if (rt.disposed) return
      rt.disposed = true
      rt.active = false
      rt.generation += 1
      unregisterShortcut(rt)
      destroyOverlay(rt)
    },
  }
}
