import { EventEmitter } from 'node:events'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { expect, it, vi } from 'vitest'
import { installRemoteController } from '../src/main/runtime/remote-controller.ts'
import type {
  RuntimeState,
  MydshRuntimeSupervisor,
} from '../src/main/runtime/runtime-supervisor.ts'

const handlers = vi.hoisted(
  () => new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>(),
)
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) =>
      handlers.set(name, handler),
    removeHandler: (name: string) => handlers.delete(name),
  },
}))
const flush = async (): Promise<void> => {
  await new Promise<void>(resolve => setImmediate(resolve))
}

it('扩展订阅在 Runtime 恢复后重新取基线，取消导航保留订阅，实际换页和崩溃释放资源', async () => {
  const diagnostics = { phase: 'test', attempt: 1, maxAttempts: 1, logs: [] }
  const ready: RuntimeState = {
    kind: 'ready',
    ownership: 'spawned-by-desktop',
    url: 'mydsh-runtime://local/',
    identity: { reportedVersion: 'test' },
    diagnostics,
  }
  const unavailable: RuntimeState = {
    kind: 'unavailable',
    reason: 'stopped',
    message: '验收断开',
    retryable: true,
    diagnostics,
  }
  let state: RuntimeState = ready
  const listeners = new Set<(state: RuntimeState) => void>()
  const frames: Array<{ id: string; type: string; value?: unknown }> = []
  const webContents = Object.assign(new EventEmitter(), {
    send: (_channel: string, frame: { id: string; type: string; value?: unknown }) => {
      frames.push(frame)
    },
  })
  let destroyed = false
  const window = {
    get webContents() {
      if (destroyed) throw new Error('Object has been destroyed')
      return webContents
    },
    isDestroyed: () => destroyed,
  } as unknown as BrowserWindow
  const attempts: Array<{
    signal: AbortSignal
    item(value: unknown): Promise<void>
    reject(error: Error): void
  }> = []
  const call = vi.fn(async (_endpoint: string, _payload: unknown, _signal?: AbortSignal) => ({
    ok: true,
    value: '一次性操作',
  }))
  const runtime = {
    getState: () => state,
    subscribe(listener: (state: RuntimeState) => void) {
      listeners.add(listener)
      listener(state)
      return () => {
        listeners.delete(listener)
      }
    },
    call,
    follow: async (
      _endpoint: string,
      _payload: unknown,
      signal: AbortSignal,
      item: (value: unknown) => Promise<void>,
    ) => {
      await new Promise<void>((_resolve, reject) => {
        attempts.push({ signal, item, reject })
        signal.addEventListener(
          'abort',
          () => {
            reject(new Error('本代连接取消'))
          },
          { once: true },
        )
      })
    },
  } as unknown as MydshRuntimeSupervisor
  const publish = (next: RuntimeState): void => {
    state = next
    for (const listener of listeners) listener(next)
  }
  const invoke = (method: string, ...args: unknown[]): unknown =>
    handlers.get(`mydsh:remote:${method}`)!({} as IpcMainInvokeEvent, ...args)
  const dispose = installRemoteController(window, runtime, () => {})
  try {
    await expect(
      invoke('call', 'mydshSsh/status', { windowToken: '伪造窗口身份' }),
    ).rejects.toThrow('不在允许范围')
    await expect(
      invoke('call', 'mydshSsh/input', { id: '../其他终端', data: '输入' }),
    ).rejects.toThrow('标识无效')
    await expect(
      invoke('call', 'mydshSsh/save', {
        request: {
          id: null,
          revision: null,
          name: '生产主机',
          host: '10.0.0.2',
          port: 22,
          username: 'ops',
          auth: 'password',
          environment: '生产',
          projectId: null,
          disabled: false,
          password: 'secret',
          agentAccess: {
            enabled: true,
            mode: 'standard',
            allowSudo: false,
            allowedPaths: ['relative/path'],
          },
        },
      }),
    ).rejects.toThrow('绝对 POSIX 路径')
    await expect(
      invoke('call', 'mydshSsh/save', {
        request: {
          id: null,
          revision: null,
          name: '生产主机',
          host: '10.0.0.2',
          port: 22,
          username: 'ops',
          auth: 'password',
          environment: '生产',
          projectId: null,
          disabled: false,
          password: 'secret',
          agentAccess: {
            enabled: true,
            mode: 'root-all',
            allowSudo: false,
            allowedPaths: [],
          },
        },
      }),
    ).rejects.toThrow('SSH 模型访问策略')
    await expect(
      invoke('call', 'mydshDatabase/save', {
        request: {
          id: null,
          revision: null,
          name: '生产只读',
          host: '127.0.0.1',
          port: 3306,
          username: 'reader',
          database: 'orders',
          tlsEnabled: false,
          tlsServerName: '',
          tlsCa: '',
          sshConnectionId: null,
          environment: '生产',
          projectId: null,
          disabled: false,
          password: 'secret',
          agentAccess: {
            enabled: true,
            mode: 'readonly',
            tableRules: [{ schema: 'mysql', table: '*', select: true }],
          },
        },
      }),
    ).rejects.toThrow('权限开关字段')
    await expect(
      invoke('call', 'mydshDatabase/grants', { sessionId: '测试会话', windowToken: '伪造身份' }),
    ).rejects.toThrow('不在允许范围')
    invoke('follow', '1', 'workspaceFiles/changes', {})
    await attempts[0]!.item('第一代基线')
    await invoke('call', 'workspaceFiles/list', {})
    publish(unavailable)
    expect(attempts[0]!.signal.aborted).toBe(true)
    await flush()
    expect(frames.map(frame => frame.type)).toEqual(['item'])
    publish(ready)
    await attempts[1]!.item('第二代基线')
    expect(frames.map(frame => frame.value)).toEqual(['第一代基线', '第二代基线'])
    expect(call).toHaveBeenCalledOnce()
    invoke('cancel', '1')
    publish(unavailable)
    publish(ready)
    expect(attempts).toHaveLength(2)
    invoke('follow', '1', 'workspaceFiles/changes', {})
    call.mockImplementationOnce(
      async (_endpoint, _payload, signal) =>
        new Promise((_resolve, reject) => {
          signal!.addEventListener(
            'abort',
            () => {
              reject(new Error('页面已换页'))
            },
            { once: true },
          )
        }),
    )
    const navigationCancelled = expect(invoke('call', 'workspaceFiles/list', {})).rejects.toThrow(
      '页面已换页',
    )
    webContents.emit('did-start-navigation', {}, 'mailto:review@example.invalid', false, true)
    expect(attempts[2]!.signal.aborted).toBe(false)
    expect(call.mock.calls.at(-1)?.[2]?.aborted).toBe(false)
    await attempts[2]!.item('取消导航后仍有输出')
    expect(frames.at(-1)?.value).toBe('取消导航后仍有输出')
    webContents.emit('did-navigate', {}, 'mydsh://page/')
    await navigationCancelled
    expect(attempts[2]!.signal.aborted).toBe(true)
    publish(unavailable)
    publish(ready)
    expect(attempts).toHaveLength(3)
    invoke('follow', '1', 'workspaceFiles/changes', {})
    attempts[3]!.reject(new Error('真正业务错误'))
    await flush()
    expect(frames.at(-1)?.type).toBe('error')
    publish(unavailable)
    publish(ready)
    expect(attempts).toHaveLength(4)
    call.mockImplementationOnce(
      async (_endpoint, _payload, signal) =>
        new Promise((_resolve, reject) => {
          signal!.addEventListener(
            'abort',
            () => {
              reject(signal!.reason)
            },
            { once: true },
          )
        }),
    )
    const cancelled = expect(invoke('call', 'workspaceFiles/list', {}, '1')).rejects.toThrow(
      '单次 Remote 调用已取消',
    )
    invoke('cancel-call', '1')
    await cancelled
    await expect(invoke('call', 'workspaceFiles/list', {}, '1')).rejects.toThrow('已经使用')
    call.mockImplementationOnce(
      async (_endpoint, _payload, signal) =>
        new Promise((_resolve, reject) => {
          signal!.addEventListener(
            'abort',
            () => {
              reject(new Error('页面已释放'))
            },
            { once: true },
          )
        }),
    )
    const pageCancelled = expect(invoke('call', 'workspaceFiles/list', {}, '2')).rejects.toThrow(
      '页面已释放',
    )
    invoke('cancel-call', '1')
    expect(call.mock.calls.at(-1)?.[2]?.aborted).toBe(false)
    webContents.emit('render-process-gone', {}, {})
    await pageCancelled
    await expect(invoke('call', 'workspaceFiles/list', {}, '1')).resolves.toBe('一次性操作')
  } finally {
    destroyed = true
    dispose()
  }
  expect(listeners.size).toBe(0)
  expect(webContents.listenerCount('did-navigate')).toBe(0)
  expect(webContents.listenerCount('render-process-gone')).toBe(0)
  expect(handlers.size).toBe(0)
})
