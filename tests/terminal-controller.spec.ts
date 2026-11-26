import { afterEach, describe, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
    mocked.handlers.set(channel, handler)
  }),
  removeHandler: vi.fn((channel: string) => {
    mocked.handlers.delete(channel)
  }),
}))

vi.mock('electron', () => ({
  ipcMain: { handle: mocked.handle, removeHandler: mocked.removeHandler },
}))
import { installTerminalController as installDesktopTerminalController } from '../src/main/terminal/terminal-controller.ts'

import {
  createTerminalService,
  resolveLoginShell,
  type TerminalProcess,
  type TerminalShellSpec,
} from '../src/runtime/terminal/terminal-service.ts'
import { DESKTOP_TERMINAL_CHANNELS } from '../src/shared/terminal.ts'

function installTerminalController(options: {
  window: ReturnType<typeof createWindow>['window']
  assertSender: (...args: unknown[]) => void
  resolveProjectDirectory: (projectId: unknown) => string
  processFactory: Parameters<typeof createTerminalService>[0]['processFactory']
  resolveShell: () => TerminalShellSpec
  resolveTaskLaunch?: (
    projectId: unknown,
    taskId: unknown,
  ) => Promise<import('../src/shared/project-tasks.ts').ProjectTaskLaunch>
}) {
  const { window, assertSender, resolveTaskLaunch, ...configuration } = options
  const service = createTerminalService({
    ...configuration,
    onEvent: event => window.webContents.send(DESKTOP_TERMINAL_CHANNELS.event, event),
  } as Parameters<typeof createTerminalService>[0])
  for (const method of ['create', 'ready', 'write', 'resize', 'close'] as const)
    mocked.handle(DESKTOP_TERMINAL_CHANNELS[method], async (...args: unknown[]) => {
      const [event, ...input] = args as [{ sender: { id: number } }, ...unknown[]]
      assertSender(event)
      if (method === 'create') {
        const request = input[0] as { projectId: string; taskId?: string }
        const task = request.taskId
          ? await resolveTaskLaunch?.(request.projectId, request.taskId)
          : undefined
        return service.create(event.sender.id, request, task)
      }
      if (method === 'ready' || method === 'close')
        return service[method](event.sender.id, input[0])
      if (method === 'write') return service.write(event.sender.id, input[0], input[1])
      return service.resize(event.sender.id, input[0], input[1], input[2])
    })
  return {
    async dispose() {
      await service.dispose()
      for (const method of ['create', 'ready', 'write', 'resize', 'close'] as const)
        mocked.removeHandler(DESKTOP_TERMINAL_CHANNELS[method])
    },
  }
}

function createProcess() {
  let dataListener: ((data: string) => void) | undefined
  let exitListener: ((event: { exitCode: number; signal?: number }) => void) | undefined
  const process: TerminalProcess = {
    pid: 42,
    onData: listener => {
      dataListener = listener
      return {
        dispose: () => {
          dataListener = undefined
        },
      }
    },
    onExit: listener => {
      exitListener = listener
      return {
        dispose: () => {
          exitListener = undefined
        },
      }
    },
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  }
  return {
    process,
    emitData: (data: string) => {
      dataListener?.(data)
    },
    emitExit: (event: { exitCode: number; signal?: number }) => {
      exitListener?.(event)
    },
  }
}

function createWindow() {
  const closedListeners = new Set<() => void>()
  const webContents = { id: 7, send: vi.fn() }
  return {
    window: {
      webContents,
      isDestroyed: () => false,
      once: (_event: string, listener: () => void) => {
        closedListeners.add(listener)
      },
      removeListener: (_event: string, listener: () => void) => {
        closedListeners.delete(listener)
      },
    },
    webContents,
  }
}

afterEach(() => {
  mocked.handlers.clear()
  vi.clearAllMocks()
})

describe('Runtime 用户终端服务', () => {
  it('通过真实桌面控制器触发原生复制粘贴，拒绝未知动作和未授权调用方并释放入口', async () => {
    const { window, webContents } = createWindow()
    const contents = Object.assign(webContents, { copy: vi.fn(), paste: vi.fn() })
    const assertSender = vi.fn((event: { sender: unknown }) => {
      if (event.sender !== contents) throw new Error('调用窗口不可信')
    })
    const controller = installDesktopTerminalController({
      window: window as never,
      runtime: { subscribe: () => () => {} } as never,
      assertSender,
      resolveTaskLaunch: vi.fn(),
    })
    const invoke = mocked.handlers.get(DESKTOP_TERMINAL_CHANNELS.clipboard)!
    expect(invoke({ sender: contents }, 'copy')).toBeUndefined()
    expect(invoke({ sender: contents }, 'paste')).toBeUndefined()
    expect(contents.copy).toHaveBeenCalledOnce()
    expect(contents.paste).toHaveBeenCalledOnce()
    expect(() => invoke({ sender: contents }, 'readText')).toThrow('终端剪贴板操作无效')
    expect(() => invoke({ sender: {} }, 'paste')).toThrow('调用窗口不可信')
    expect(contents.paste).toHaveBeenCalledOnce()
    await controller.dispose()
    expect(mocked.handlers.has(DESKTOP_TERMINAL_CHANNELS.clipboard)).toBe(false)
  })

  it('在受信任项目目录创建 PTY，并转发输入、缩放、输出与退出状态', async () => {
    const terminal = createProcess()
    const { window, webContents } = createWindow()
    const processFactory = vi.fn(async () => terminal.process)
    const assertSender = vi.fn()
    const controller = installTerminalController({
      window: window as never,
      assertSender,
      resolveProjectDirectory: projectId => (projectId === '项目-1' ? '/受信任/项目' : ''),
      processFactory,
      resolveShell: () => ({ executable: '/bin/zsh', args: ['-l'] }),
    })
    const event = { sender: webContents }
    const create = mocked.handlers.get(DESKTOP_TERMINAL_CHANNELS.create)
    const descriptor = (await create?.(event, { projectId: '项目-1', columns: 100, rows: 32 })) as {
      id: string
      pid: number
      kind: string
      title: string
    }

    expect(descriptor).toMatchObject({ pid: 42, kind: 'shell', title: 'zsh' })
    expect(processFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: '/bin/zsh',
        args: ['-l'],
        cwd: '/受信任/项目',
        columns: 100,
        rows: 32,
      }),
    )
    await mocked.handlers.get(DESKTOP_TERMINAL_CHANNELS.ready)?.(event, descriptor.id)
    await mocked.handlers.get(DESKTOP_TERMINAL_CHANNELS.write)?.(
      event,
      descriptor.id,
      'printf 你好\r',
    )
    await mocked.handlers.get(DESKTOP_TERMINAL_CHANNELS.resize)?.(event, descriptor.id, 120, 40)
    expect(terminal.process.write).toHaveBeenCalledWith('printf 你好\r')
    expect(terminal.process.resize).toHaveBeenCalledWith(120, 40)

    terminal.emitData('\u001b[32m完成\u001b[0m')
    expect(webContents.send).toHaveBeenCalledWith(DESKTOP_TERMINAL_CHANNELS.event, {
      type: 'data',
      terminalId: descriptor.id,
      data: '\u001b[32m完成\u001b[0m',
    })
    terminal.emitExit({ exitCode: 7, signal: 1 })
    expect(webContents.send).toHaveBeenLastCalledWith(DESKTOP_TERMINAL_CHANNELS.event, {
      type: 'exit',
      terminalId: descriptor.id,
      exitCode: 7,
      signal: 1,
    })

    await controller.dispose()
    expect(mocked.removeHandler).toHaveBeenCalledTimes(5)
  })

  it('只根据主进程解析的项目任务配置创建任务 PTY', async () => {
    const terminal = createProcess()
    const { window, webContents } = createWindow()
    let releaseProcess: (() => void) | undefined
    const processFactory = vi.fn(
      () =>
        new Promise<TerminalProcess>(resolve => {
          releaseProcess = () => {
            resolve(terminal.process)
          }
        }),
    )
    const resolveTaskLaunch = vi.fn(async () => ({
      taskId: '00000000-0000-0000-0000-000000000001',
      name: '启动开发服务',
      executable: 'pnpm',
      args: ['run', 'dev'],
      cwd: '/受信任/项目/service',
      env: { NODE_ENV: 'development', TERM: '不能覆盖终端类型' },
      allowConcurrent: false,
    }))
    const controller = installTerminalController({
      window: window as never,
      assertSender: vi.fn(),
      resolveProjectDirectory: vi.fn(() => '/不应由任务模式直接使用'),
      resolveTaskLaunch,
      processFactory,
      resolveShell: () => ({ executable: '/bin/zsh', args: ['-l'] }),
    })
    const create = mocked.handlers.get(DESKTOP_TERMINAL_CHANNELS.create)
    const firstCreate = create?.(
      { sender: webContents },
      {
        projectId: '项目-1',
        taskId: '00000000-0000-0000-0000-000000000001',
        columns: 90,
        rows: 28,
      },
    ) as Promise<{ id: string; kind: string; title: string; taskId: string }>

    await vi.waitFor(() => {
      expect(processFactory).toHaveBeenCalledOnce()
    })
    await expect(
      create?.(
        { sender: webContents },
        {
          projectId: '项目-1',
          taskId: '00000000-0000-0000-0000-000000000001',
          columns: 90,
          rows: 28,
        },
      ),
    ).rejects.toThrow('该项目任务已经在终端中运行')
    releaseProcess?.()
    const descriptor = await firstCreate

    expect(resolveTaskLaunch).toHaveBeenCalledWith('项目-1', '00000000-0000-0000-0000-000000000001')
    expect(descriptor).toMatchObject({
      kind: 'task',
      title: '启动开发服务',
      taskId: '00000000-0000-0000-0000-000000000001',
    })
    expect(processFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: 'pnpm',
        args: ['run', 'dev'],
        cwd: '/受信任/项目/service',
        columns: 90,
        rows: 28,
        env: expect.objectContaining({
          NODE_ENV: 'development',
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
        }),
      }),
    )
    expect(processFactory).toHaveBeenCalledOnce()

    await controller.dispose()
  })

  it('拒绝跨窗口终端访问和越界行列参数，并在释放时关闭仍存活的 PTY', async () => {
    const terminal = createProcess()
    const { window, webContents } = createWindow()
    const controller = installTerminalController({
      window: window as never,
      assertSender: vi.fn(),
      resolveProjectDirectory: () => '/受信任/项目',
      processFactory: async () => terminal.process,
      resolveShell: () => ({ executable: '/bin/zsh', args: ['-l'] }),
    })
    const create = mocked.handlers.get(DESKTOP_TERMINAL_CHANNELS.create)
    await expect(
      create?.({ sender: webContents }, { projectId: '项目-1', columns: 1, rows: 24 }),
    ).rejects.toThrow('终端列数必须是 2 到 500 之间的整数')
    const descriptor = (await create?.(
      { sender: webContents },
      { projectId: '项目-1', columns: 80, rows: 24 },
    )) as { id: string }
    await expect(
      mocked.handlers.get(DESKTOP_TERMINAL_CHANNELS.write)?.(
        { sender: { id: 8 } },
        descriptor.id,
        'whoami',
      ),
    ).rejects.toThrow('终端不存在或不属于当前窗口')

    await controller.dispose()
    expect(terminal.process.kill).toHaveBeenCalledWith()
  })
})

describe('交互终端默认 Shell 解析', () => {
  it('POSIX 沿用 $SHELL，缺失或不可执行时回退 /bin/zsh', () => {
    expect(resolveLoginShell({ SHELL: '/usr/local/bin/fish' }, 'darwin', () => true)).toEqual({
      executable: '/usr/local/bin/fish',
      args: ['-l'],
    })
    expect(resolveLoginShell({ SHELL: '/不存在/fish' }, 'linux', () => false)).toEqual({
      executable: '/bin/zsh',
      args: ['-l'],
    })
    expect(resolveLoginShell({}, 'darwin', () => false)).toEqual({
      executable: '/bin/zsh',
      args: ['-l'],
    })
  })

  it('Windows 依次探测 PowerShell 7、PATH 别名与系统 5.1，全部缺失时交给 PATH 解析 pwsh', () => {
    const env = {
      ProgramFiles: 'C:\\Program Files',
      PATH: '"C:\\商店别名";C:\\空目录',
      SystemRoot: 'C:\\Windows',
    }
    const seen: string[] = []
    const storeAlias = 'C:\\商店别名\\pwsh.exe'
    const expectedPwshArgs = ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass']
    expect(
      resolveLoginShell(env, 'win32', candidate => {
        seen.push(candidate)
        return candidate === storeAlias
      }),
    ).toEqual({ executable: storeAlias, args: expectedPwshArgs })
    // 候选按 PowerShell 7、PATH（引号已剥离）、系统 Windows PowerShell 的顺序探测，命中即停止。
    expect(seen).toEqual(['C:\\Program Files\\PowerShell\\7\\pwsh.exe', storeAlias])

    const legacy = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    expect(resolveLoginShell(env, 'win32', candidate => candidate === legacy)).toEqual({
      executable: legacy,
      args: expectedPwshArgs,
    })

    const probed: string[] = []
    expect(
      resolveLoginShell(env, 'win32', candidate => {
        probed.push(candidate)
        return false
      }),
    ).toEqual({ executable: 'pwsh', args: expectedPwshArgs })
    expect(probed).toEqual([
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      storeAlias,
      'C:\\空目录\\pwsh.exe',
      legacy,
    ])
  })
})

describe('终端分配和退出的竞争', () => {
  it('关闭等待进程树清理完成，分配中退出也不会遗留进程', async () => {
    const terminal = createProcess()
    let finishKill!: () => void
    terminal.process.kill = vi.fn(
      () =>
        new Promise<void>(resolve => {
          finishKill = resolve
        }),
    )
    const service = createTerminalService({
      onEvent: vi.fn(),
      resolveProjectDirectory: () => '/项目',
      processFactory: () => terminal.process,
      resolveShell: () => ({ executable: 'shell', args: [] }),
    })
    const descriptor = await service.create(7, { projectId: '项目', columns: 80, rows: 24 })
    let closed = false
    const closing = service.close(7, descriptor.id).then(() => {
      closed = true
    })
    await Promise.resolve()
    expect(closed).toBe(false)
    finishKill()
    await closing
    await service.dispose()

    let allocated!: (value: TerminalProcess) => void
    const delayed = createTerminalService({
      onEvent: vi.fn(),
      resolveProjectDirectory: () => '/项目',
      processFactory: () =>
        new Promise(resolve => {
          allocated = resolve
        }),
      resolveShell: () => ({ executable: 'shell', args: [] }),
    })
    const pending = delayed.create(7, { projectId: '项目', columns: 80, rows: 24 })
    const failed = expect(pending).rejects.toThrow('关闭')
    let disposed = false
    const stopping = delayed.dispose().then(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(false)
    terminal.process.kill = vi.fn(async () => {})
    allocated(terminal.process)
    await failed
    await stopping
    expect(terminal.process.kill).toHaveBeenCalledOnce()
  })
  it('关闭期间分配出的终端若清理失败，创建和释放都报告失败', async () => {
    const terminal = createProcess()
    terminal.process.kill = vi.fn(async () => {
      throw new Error('进程树仍存活')
    })
    let allocated!: (value: TerminalProcess) => void
    const service = createTerminalService({
      onEvent: vi.fn(),
      resolveProjectDirectory: () => '/项目',
      processFactory: () =>
        new Promise(resolve => {
          allocated = resolve
        }),
      resolveShell: () => ({ executable: 'shell', args: [] }),
    })
    const creating = expect(
      service.create(7, { projectId: '项目', columns: 80, rows: 24 }),
    ).rejects.toThrow('终端分配失败且清理未完成')
    const stopping = expect(service.dispose()).rejects.toThrow('终端进程清理失败')
    allocated(terminal.process)
    await Promise.all([creating, stopping])
  })
  it('清理失败向调用方返回错误，不提前报告成功', async () => {
    const terminal = createProcess()
    terminal.process.kill = vi.fn(async () => {
      throw new Error('进程树仍存活')
    })
    const service = createTerminalService({
      onEvent: vi.fn(),
      resolveProjectDirectory: () => '/项目',
      processFactory: () => terminal.process,
      resolveShell: () => ({ executable: 'shell', args: [] }),
    })
    await service.create(7, { projectId: '项目', columns: 80, rows: 24 })
    await expect(service.dispose()).rejects.toThrow('终端进程清理失败')
  })
})
