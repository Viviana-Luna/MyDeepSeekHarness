/**
 * 主进程项目变更事件转发控制器：订阅后台 Runtime 的 mydshWorkspace/events 流，
 * 并将项目 Git 变更通知转发给受信任主窗口的 renderer；窗口关闭或应用退出时统一中止订阅。
 */
import type { BrowserWindow } from 'electron'
import { DESKTOP_PROJECT_EVENT_CHANNEL } from '../../shared/project-events.ts'
import type { MydshRuntimeSupervisor } from './runtime-supervisor.ts'

/**
 * 安装项目事件转发订阅；Runtime 重启进入 ready 时自动重建流，调用方应在退出时调用 dispose()。
 */
export function installProjectEventsController(options: {
  window: BrowserWindow
  runtime: MydshRuntimeSupervisor
}): { dispose(): void } {
  const { window: win, runtime } = options
  const contents = win.webContents
  let disposed = false
  let stream: AbortController | undefined

  const unsubscribe = runtime.subscribe(state => {
    stream?.abort()
    stream = undefined
    if (state.kind !== 'ready' || disposed) return
    const controller = new AbortController()
    stream = controller
    void runtime
      .follow('mydshWorkspace/events', { args: {} }, controller.signal, async value => {
        if (!disposed && !win.isDestroyed() && !contents.isDestroyed()) {
          contents.send(DESKTOP_PROJECT_EVENT_CHANNEL, value)
        }
      })
      .catch(error => {
        if (!controller.signal.aborted) console.warn('项目事件流已断开：', error)
      })
  })

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    unsubscribe()
    stream?.abort()
    stream = undefined
    win.removeListener('closed', dispose)
  }

  win.once('closed', dispose)
  return { dispose }
}
