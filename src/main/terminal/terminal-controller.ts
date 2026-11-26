import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { ProjectTaskLaunch } from '../../shared/project-tasks.ts'
import {
  DESKTOP_TERMINAL_CHANNELS,
  type DesktopTerminalCreateRequest,
} from '../../shared/terminal.ts'
import type { MydshRuntimeSupervisor } from '../runtime/runtime-supervisor.ts'

/** 桌面桥只校验窗口归属并转发；PTY、缓冲、输入限制及释放由 Runtime 拥有。 */
export function installTerminalController(options: {
  window: BrowserWindow
  runtime: MydshRuntimeSupervisor
  assertSender(event: IpcMainInvokeEvent): void
  resolveTaskLaunch(projectId: unknown, taskId: unknown): Promise<ProjectTaskLaunch>
}): { dispose(): void } {
  const { window: win, runtime, assertSender, resolveTaskLaunch } = options
  let disposed = false
  let stream: AbortController | undefined
  const call = async (method: string, args: Record<string, unknown>): Promise<unknown> => {
    const result = (await runtime.call(`mydshTerminal/${method}`, { args })) as {
      ok: boolean
      value?: unknown
      error?: { message: string }
    }
    if (!result.ok) throw new Error(result.error?.message ?? '终端操作失败')
    return result.value
  }
  const unsubscribe = runtime.subscribe(state => {
    stream?.abort()
    stream = undefined
    if (state.kind !== 'ready' || disposed) return
    const controller = new AbortController()
    stream = controller
    void runtime
      .follow('mydshTerminal/events', { args: {} }, controller.signal, async value => {
        if (!disposed && !win.isDestroyed())
          win.webContents.send(DESKTOP_TERMINAL_CHANNELS.event, value)
      })
      .catch(error => {
        if (!controller.signal.aborted) console.warn('终端事件流已断开：', error)
      })
  })
  ipcMain.handle(
    DESKTOP_TERMINAL_CHANNELS.create,
    async (event, input: DesktopTerminalCreateRequest) => {
      assertSender(event)
      if (!input || typeof input !== 'object') throw new Error('终端创建参数无效')
      const task =
        input.taskId === undefined ? null : await resolveTaskLaunch(input.projectId, input.taskId)
      assertSender(event)
      if (disposed) throw new Error('终端窗口已关闭')
      return call('create', { ownerId: event.sender.id, request: input, task })
    },
  )
  for (const method of ['ready', 'write', 'resize', 'close'] as const) {
    ipcMain.handle(
      DESKTOP_TERMINAL_CHANNELS[method],
      (event, id: unknown, input?: unknown, rows?: unknown) => {
        assertSender(event)
        if (disposed) throw new Error('终端窗口已关闭')
        return call(method, {
          ownerId: event.sender.id,
          id,
          ...(method === 'write' ? { input } : {}),
          ...(method === 'resize' ? { columns: input, rows } : {}),
        })
      },
    )
  }
  ipcMain.handle(DESKTOP_TERMINAL_CHANNELS.clipboard, (event, action: unknown) => {
    assertSender(event)
    if (disposed || win.isDestroyed()) throw new Error('终端窗口已关闭')
    if (action !== 'copy' && action !== 'paste') throw new Error('终端剪贴板操作无效')
    // 复用 Chromium 的原生 copy/paste 事件，让 xterm 处理选择与括号粘贴。
    // 不读取或返回系统剪贴板，也不放开页面的异步剪贴板权限。
    event.sender[action]()
  })
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    unsubscribe()
    stream?.abort()
    win.removeListener('closed', dispose)
    for (const method of ['create', 'ready', 'write', 'resize', 'close'] as const)
      ipcMain.removeHandler(DESKTOP_TERMINAL_CHANNELS[method])
    ipcMain.removeHandler(DESKTOP_TERMINAL_CHANNELS.clipboard)
  }
  win.once('closed', dispose)
  return { dispose }
}
