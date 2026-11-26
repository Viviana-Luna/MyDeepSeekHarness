/**
 * Windows 自定义窗口控制与窗口几何状态同步：提供常驻的窗口状态订阅组件及最小化、最大化/还原、关闭按钮。
 * 运行在 renderer；持有模块级受限 `window.dshDesktop.window` 监听，在所有订阅方卸载后自动释放。
 */
import { useEffect, useState } from 'react'
import {
  windowClipStyle,
  type DesktopWindowAction,
  type DesktopWindowState,
} from '../../../../shared/window.ts'
import '../../styles/window-controls.css'

interface SharedWindowSnapshot {
  readonly state: DesktopWindowState | null
  readonly readError: string
}

let sharedSnapshot: SharedWindowSnapshot = { state: null, readError: '' }
const snapshotListeners = new Set<(snapshot: SharedWindowSnapshot) => void>()
let subscriberCount = 0
let stopSharedSubscription: (() => void) | null = null

function notifySnapshotListeners(): void {
  for (const listener of snapshotListeners) listener(sharedSnapshot)
}

function applyWindowClipToRoot(value: DesktopWindowState | null): void {
  if (value === null) return
  const bounds = document.body.getBoundingClientRect()
  const clip = windowClipStyle(value, {
    width: bounds.width,
    height: bounds.height,
    scale: window.devicePixelRatio,
  })
  for (const [key, pixel] of Object.entries(clip)) {
    document.documentElement.style.setProperty(`--window-clip-${key}`, `${String(pixel)}px`)
  }
}

function startSharedWindowSubscription(): void {
  const api = window.dshDesktop?.window
  if (api === undefined || stopSharedSubscription !== null) return
  let active = true
  const refreshClip = () => {
    if (active) applyWindowClipToRoot(sharedSnapshot.state)
  }
  const update = (value: DesktopWindowState) => {
    if (!active) return
    sharedSnapshot = { state: value, readError: '' }
    document.documentElement.dataset.canvasComposition = value.canvasComposition
    document.documentElement.dataset.windowMaximized = String(value.maximized)
    applyWindowClipToRoot(value)
    notifySnapshotListeners()
  }
  const stopApi = api.onChanged(update)
  window.addEventListener('resize', refreshClip)
  void api.read().then(update, () => {
    if (!active) return
    sharedSnapshot = { ...sharedSnapshot, readError: '无法读取窗口状态' }
    notifySnapshotListeners()
  })
  stopSharedSubscription = () => {
    active = false
    stopApi()
    window.removeEventListener('resize', refreshClip)
    stopSharedSubscription = null
  }
}

function useSharedWindowState(): SharedWindowSnapshot {
  const [snapshot, setSnapshot] = useState<SharedWindowSnapshot>(sharedSnapshot)
  useEffect(() => {
    snapshotListeners.add(setSnapshot)
    subscriberCount += 1
    if (subscriberCount === 1) startSharedWindowSubscription()
    setSnapshot(sharedSnapshot)
    return () => {
      snapshotListeners.delete(setSnapshot)
      subscriberCount = Math.max(0, subscriberCount - 1)
      if (subscriberCount === 0) {
        stopSharedSubscription?.()
        sharedSnapshot = { state: null, readError: '' }
      }
    }
  }, [])
  return snapshot
}

/**
 * 常驻窗口状态同步器：挂载在工作台根部，保证窗口按钮随顶栏/侧栏切换挂载位置时不中断裁切变量与最大化状态同步。
 */
export function WindowStateSync(): null {
  useSharedWindowState()
  return null
}

/**
 * Windows 无边框窗口的自定义最小化、最大化/还原与关闭按钮组；非 Windows 平台返回 null。
 */
export function WindowControls() {
  const { state, readError } = useSharedWindowState()
  const [actionError, setActionError] = useState('')
  if (document.documentElement.dataset.platform !== 'win32') return null
  const error = actionError || readError
  const act = (action: DesktopWindowAction) => {
    setActionError('')
    void window.dshDesktop?.window?.act(action).catch(() => {
      setActionError('窗口操作失败，请重试')
    })
  }
  const maximizeLabel = state?.maximized === true ? '还原窗口' : '最大化窗口'
  return (
    <div className="windows-chrome">
      <div className="window-controls" role="group" aria-label="窗口控制">
        <button
          type="button"
          data-window-action="minimize"
          aria-label="最小化窗口"
          title="最小化窗口"
          disabled={state?.minimizable !== true}
          onClick={() => {
            act('minimize')
          }}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M1 6.5h10" />
          </svg>
        </button>
        <button
          type="button"
          data-window-action="toggle-maximize"
          aria-label={maximizeLabel}
          title={maximizeLabel}
          disabled={state?.maximizable !== true}
          onClick={() => {
            act('toggle-maximize')
          }}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            {state?.maximized === true ? (
              <path d="M3.5 3.5v-2h7v7h-2m-7-5h7v7h-7z" />
            ) : (
              <path d="M1.5 1.5h9v9h-9z" />
            )}
          </svg>
        </button>
        <button
          type="button"
          data-window-action="close"
          aria-label="关闭窗口"
          title="关闭窗口"
          onClick={() => {
            act('close')
          }}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="m1.5 1.5 9 9m0-9-9 9" />
          </svg>
        </button>
      </div>
      {error !== '' && (
        <span className="window-control-error" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}
