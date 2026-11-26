import { describe, expect, it, vi } from 'vitest'

import { WorkspaceStore } from '../src/renderer/src/models/workspace/store.ts'
import type {
  DesktopBridge,
  DesktopCommandsApi,
  DesktopSettings,
  HostStatus,
} from '../src/renderer/src/platform/contracts.ts'
import type { DesktopHostFrame } from '../src/shared/host-live.ts'
import type { DesktopSessionFrame } from '../src/shared/session-live.ts'

const settings: DesktopSettings = {
  version: 7,
  revision: 0,
  colorScheme: 'system',
  canvasColorScheme: 'follow-interface',
  fontFamily: 'system',
  fontSize: 13,
  editorFontSize: 13,
  editorLineHeight: 'standard',
  editorLigatures: false,
  islandGap: 10,
  accentColor: '#5b6cff',
  canvasTransparency: 0,
  contentScrimOpacity: 0,
  backgrounds: { canvas: null, sidebar: null, content: null },
}

const ready: HostStatus = {
  kind: 'ready',
  ownership: 'external',
  identity: { reportedVersion: '测试版本' },
}

const commands = [{ name: 'compact', description: '压缩当前上下文' }]
const skills = [
  {
    name: 'review-code',
    description: '审查当前代码',
    modelInvocable: true,
  },
]

interface Harness {
  readonly bridge: DesktopBridge
  readonly hostCall: ReturnType<typeof vi.fn<DesktopBridge['host']['call']>>
  readonly list: ReturnType<typeof vi.fn<DesktopCommandsApi['list']>>
  readonly listSkills: ReturnType<typeof vi.fn<DesktopCommandsApi['listSkills']>>
  readonly execute: ReturnType<typeof vi.fn<DesktopCommandsApi['execute']>>
  emitSessionFrame(frame: DesktopSessionFrame): void
  emitHostFrame(frame: DesktopHostFrame): void
  readonly storage: Pick<Storage, 'getItem' | 'setItem'>
}

function deferred<T>(): {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function createHarness(
  overrides: {
    readonly call?: DesktopBridge['host']['call']
    readonly list?: DesktopCommandsApi['list']
    readonly listSkills?: DesktopCommandsApi['listSkills']
    readonly execute?: DesktopCommandsApi['execute']
  } = {},
): Harness {
  let sessionFrameListener: ((frame: DesktopSessionFrame) => void) | undefined
  let hostFrameListener: ((frame: DesktopHostFrame) => void) | undefined
  const hostCall = vi.fn<DesktopBridge['host']['call']>(overrides.call ?? defaultHostCall)
  const list = vi.fn<DesktopCommandsApi['list']>(overrides.list ?? (async () => commands))
  const listSkills = vi.fn<DesktopCommandsApi['listSkills']>(
    overrides.listSkills ?? (async () => skills),
  )
  const execute = vi.fn<DesktopCommandsApi['execute']>(
    overrides.execute ??
      (async () => ({
        commandId: '命令-默认',
        result: { kind: 'success', text: '完成' },
      })),
  )
  const stored = new Map<string, string>()
  const storage: Pick<Storage, 'getItem' | 'setItem'> = {
    getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => {
      stored.set(key, value)
    },
  }
  const bridge: DesktopBridge = {
    remote: {
      call: async () => {
        throw new Error('测试未声明扩展 Remote')
      },
      cancelCall: async () => {},
      follow: () => () => {},
    },
    setPluginBusyReasons: async () => {},
    getFrontendPlugins: async () => [],
    onFrontendPluginsChanged: () => () => undefined,
    version: 11,
    host: {
      status: async () => ready,
      call: hostCall,
      onStatusChanged: () => () => undefined,
      onSessionFrame: listener => {
        sessionFrameListener = listener
        return () => {
          if (sessionFrameListener === listener) sessionFrameListener = undefined
        }
      },
      onHostFrame: listener => {
        hostFrameListener = listener
        return () => {
          if (hostFrameListener === listener) hostFrameListener = undefined
        }
      },
    },
    settings: {
      read: async () => settings,
      update: async patch => ({ ...settings, ...patch }),
      chooseBackground: async () => null,
      applyBackground: async () => settings,
      cancelBackground: async () => undefined,
      clearBackground: async () => settings,
      onChanged: () => () => undefined,
      onOpenRequested: () => () => undefined,
    },
    commands: { list, listSkills, execute },
  }
  return {
    bridge,
    hostCall,
    list,
    listSkills,
    execute,
    emitSessionFrame: frame => {
      sessionFrameListener?.(frame)
    },
    emitHostFrame: frame => {
      hostFrameListener?.(frame)
    },
    storage,
  }
}

function commandsChangedFrame(): DesktopHostFrame {
  return { type: 'host/commands-changed' }
}

function agentPresetSelectedFrame(sessionId: string): DesktopHostFrame {
  return {
    type: 'host/agent-preset-selected',
    sessionId,
    agentPreset: '测试预设',
  }
}

async function defaultHostCall(
  operation: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  if (operation === 'listSessions') return sessions()
  if (operation === 'loadSessionPage') return { sessionId: payload.sessionId, records: [] }
  if (operation === 'promptSession') return { accepted: true }
  throw new Error(`测试未处理 Host 操作：${operation}`)
}

function sessions(): Record<string, unknown> {
  return {
    items: [
      { sessionId: '会话-A', updatedAt: 200, running: false, blank: false, cwd: '/work/A' },
      { sessionId: '会话-B', updatedAt: 100, running: false, blank: false, cwd: '/work/B' },
    ],
  }
}

async function initialize(harness: Harness): Promise<WorkspaceStore> {
  const store = new WorkspaceStore(harness.bridge, harness.storage)
  await store.initialize()
  await vi.waitFor(() => {
    expect(store.getSnapshot().sessionCommandDirectory.status).toBe('ready')
  })
  return store
}

async function selectAndWaitForDirectory(store: WorkspaceStore, sessionId: string): Promise<void> {
  store.selectSession(sessionId)
  await vi.waitFor(() => {
    expect(store.getSnapshot()).toMatchObject({
      selectedSessionId: sessionId,
      sessionCommandDirectory: { status: 'ready' },
    })
  })
}

describe('renderer WorkspaceStore 命令与 Skill 目录', () => {
  it('成功组合同一会话的 Host Command 与 Skill 目录', async () => {
    const harness = createHarness()
    const store = await initialize(harness)

    expect(store.getSnapshot().sessionCommandDirectory).toEqual({
      status: 'ready',
      value: { commands, skills },
      error: null,
      commandError: null,
      skillError: null,
    })
    expect(harness.list).toHaveBeenCalledWith('会话-A')
    expect(harness.listSkills).toHaveBeenCalledWith('会话-A')
    store.dispose()
  })

  it('同一 Session 的非 force 目录加载复用当前 in-flight 请求', async () => {
    const pendingCommands = deferred<readonly (typeof commands)[number][]>()
    const pendingSkills = deferred<readonly (typeof skills)[number][]>()
    let pending = false
    const harness = createHarness({
      list: async () => (pending ? pendingCommands.promise : commands),
      listSkills: async () => (pending ? pendingSkills.promise : skills),
    })
    const store = await initialize(harness)
    pending = true
    harness.list.mockClear()
    harness.listSkills.mockClear()

    const forced = store.loadSessionCommandDirectory('会话-A', true)
    await vi.waitFor(() => expect(harness.list).toHaveBeenCalledOnce())
    const reusedOnce = store.loadSessionCommandDirectory('会话-A')
    const reusedTwice = store.loadSessionCommandDirectory('会话-A')
    expect(harness.list).toHaveBeenCalledOnce()
    expect(harness.listSkills).toHaveBeenCalledOnce()

    pendingCommands.resolve(commands)
    pendingSkills.resolve(skills)
    await expect(Promise.all([forced, reusedOnce, reusedTwice])).resolves.toEqual([
      true,
      true,
      true,
    ])
    expect(harness.list).toHaveBeenCalledOnce()
    expect(harness.listSkills).toHaveBeenCalledOnce()
    store.dispose()
  })

  it('单侧目录失败时保留另一侧目录并记录对应降级原因', async () => {
    const commandFailed = createHarness({
      list: async () => {
        throw new Error('命令目录不可用')
      },
    })
    const commandFailedStore = await initialize(commandFailed)
    expect(commandFailedStore.getSnapshot().sessionCommandDirectory).toMatchObject({
      status: 'ready',
      value: { commands: [], skills },
      commandError: '命令目录不可用',
      skillError: null,
    })

    const skillFailed = createHarness({
      listSkills: async () => {
        throw new Error('Skill 目录不可用')
      },
    })
    const skillFailedStore = await initialize(skillFailed)
    expect(skillFailedStore.getSnapshot().sessionCommandDirectory).toMatchObject({
      status: 'ready',
      value: { commands, skills: [] },
      commandError: null,
      skillError: 'Skill 目录不可用',
    })
    commandFailedStore.dispose()
    skillFailedStore.dispose()
  })

  it('两侧目录都失败时进入错误状态并保留两项错误', async () => {
    const harness = createHarness({
      list: async () => {
        throw new Error('命令服务断开')
      },
      listSkills: async () => {
        throw new Error('Skill 服务断开')
      },
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()
    await vi.waitFor(() => {
      expect(store.getSnapshot().sessionCommandDirectory.status).toBe('error')
    })

    expect(store.getSnapshot().sessionCommandDirectory).toMatchObject({
      value: null,
      error: '命令目录读取失败：命令服务断开；Skill 目录读取失败：Skill 服务断开',
      commandError: '命令服务断开',
      skillError: 'Skill 服务断开',
    })
    store.dispose()
  })

  it('A→B→A 后迟到的旧 A 目录响应不能覆盖新的 A 目录', async () => {
    const oldCommands = deferred<readonly (typeof commands)[number][]>()
    const oldSkills = deferred<readonly (typeof skills)[number][]>()
    const harness = createHarness({
      list: async sessionId => {
        if (
          sessionId === '会话-A' &&
          harness.list.mock.calls.filter(([id]) => id === '会话-A').length === 1
        ) {
          return oldCommands.promise
        }
        return [{ name: 'fresh-command', description: '新目录命令' }]
      },
      listSkills: async sessionId => {
        if (
          sessionId === '会话-A' &&
          harness.listSkills.mock.calls.filter(([id]) => id === '会话-A').length === 1
        ) {
          return oldSkills.promise
        }
        return [{ name: 'fresh-skill', description: '新目录 Skill', modelInvocable: true }]
      },
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    const starting = store.initialize()
    await vi.waitFor(() => expect(harness.list).toHaveBeenCalledWith('会话-A'))
    store.selectSession('会话-B')
    await vi.waitFor(() => expect(harness.list).toHaveBeenCalledWith('会话-B'))
    store.selectSession('会话-A')
    harness.emitHostFrame(commandsChangedFrame())
    await starting
    await vi.waitFor(() => {
      expect(store.getSnapshot().sessionCommandDirectory).toMatchObject({
        status: 'ready',
        value: { commands: [{ name: 'fresh-command' }], skills: [{ name: 'fresh-skill' }] },
      })
    })

    oldCommands.resolve(commands)
    oldSkills.resolve(skills)
    await Promise.resolve()
    await Promise.resolve()
    expect(store.getSnapshot().sessionCommandDirectory.value).toMatchObject({
      commands: [{ name: 'fresh-command' }],
      skills: [{ name: 'fresh-skill' }],
    })
    store.dispose()
  })

  it('stream-reset 后忽略旧目录响应，并为当前会话刷新目录', async () => {
    const oldCommands = deferred<readonly (typeof commands)[number][]>()
    const oldSkills = deferred<readonly (typeof skills)[number][]>()
    let listCount = 0
    let skillCount = 0
    const harness = createHarness({
      list: async () =>
        ++listCount === 1
          ? oldCommands.promise
          : [{ name: 'reset-command', description: '重连目录命令' }],
      listSkills: async () =>
        ++skillCount === 1
          ? oldSkills.promise
          : [{ name: 'reset-skill', description: '重连目录 Skill', modelInvocable: true }],
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    const starting = store.initialize()
    await vi.waitFor(() => expect(harness.list).toHaveBeenCalledTimes(1))

    harness.emitSessionFrame({ type: 'session/stream-reset' })
    await starting
    await vi.waitFor(() => expect(harness.list).toHaveBeenCalledTimes(2))
    await vi.waitFor(() =>
      expect(store.getSnapshot().sessionCommandDirectory.value).toMatchObject({
        commands: [{ name: 'reset-command' }],
        skills: [{ name: 'reset-skill' }],
      }),
    )

    oldCommands.resolve(commands)
    oldSkills.resolve(skills)
    await Promise.resolve()
    expect(store.getSnapshot().sessionCommandDirectory.value).toMatchObject({
      commands: [{ name: 'reset-command' }],
      skills: [{ name: 'reset-skill' }],
    })
    store.dispose()
  })

  it('host/commands-changed 使所有已读目录失效，并刷新当前会话', async () => {
    const harness = createHarness()
    const store = await initialize(harness)
    await selectAndWaitForDirectory(store, '会话-B')
    expect(harness.list).toHaveBeenCalledTimes(2)

    harness.emitHostFrame(commandsChangedFrame())
    await vi.waitFor(() => expect(harness.list).toHaveBeenCalledTimes(3))
    store.selectSession('会话-A')
    await vi.waitFor(() => expect(harness.list).toHaveBeenCalledTimes(4))
    store.dispose()
  })

  it('host/agent-preset-selected 只使对应会话的目录失效', async () => {
    const harness = createHarness()
    const store = await initialize(harness)
    await selectAndWaitForDirectory(store, '会话-B')
    expect(harness.list).toHaveBeenCalledTimes(2)

    harness.emitHostFrame(agentPresetSelectedFrame('会话-A'))
    await Promise.resolve()
    expect(harness.list).toHaveBeenCalledTimes(2)
    store.selectSession('会话-A')
    await vi.waitFor(() => expect(harness.list).toHaveBeenCalledTimes(3))
    store.dispose()
  })
})

describe('renderer WorkspaceStore 命令提交与执行状态', () => {
  it('Host Command 与 Skill 同名时阻止提交并保留草稿', async () => {
    const harness = createHarness({
      list: async () => [{ name: 'review-code', description: 'Host 审查命令' }],
      listSkills: async () => [
        {
          name: 'review-code',
          description: '代码审查 Skill',
          modelInvocable: true,
        },
      ],
    })
    const store = await initialize(harness)
    store.setSessionDraft('会话-A', '/review-code 当前变更')

    await expect(store.submitComposerInput('/review-code 当前变更')).resolves.toBe(false)
    expect(store.getSnapshot()).toMatchObject({
      sessionDrafts: { '会话-A': '/review-code 当前变更' },
      error: '/review-code 同时匹配命令和 Skill；请切换 Agent 预设或等待命令列表更新，草稿已保留',
    })
    expect(harness.execute).not.toHaveBeenCalled()
    expect(harness.hostCall).not.toHaveBeenCalledWith('promptSession', expect.anything())
    store.dispose()
  })

  it('旧桌面桥直接执行命令时提示重新启动更新后的应用', async () => {
    const harness = createHarness()
    delete harness.bridge.commands
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()

    expect(store.getSnapshot().sessionCommandDirectory).toMatchObject({
      status: 'error',
      error: '当前桌面桥版本不支持斜杠命令目录；请重新启动更新后的 MyDSH',
    })
    await expect(store.executeSessionCommand('/compact')).resolves.toBe(false)
    expect(store.getSnapshot().error).toBe('当前桌面桥版本不支持命令；请重新启动更新后的 MyDSH')
    store.dispose()
  })

  it('未知 slash 在本地阻止，既不 prompt 也不 execute', async () => {
    const harness = createHarness()
    const store = await initialize(harness)
    harness.hostCall.mockClear()
    harness.execute.mockClear()

    await expect(store.submitComposerInput('/missing 参数')).resolves.toBe(false)
    expect(harness.execute).not.toHaveBeenCalled()
    expect(harness.hostCall).not.toHaveBeenCalledWith('promptSession', expect.anything())
    expect(store.getSnapshot().error).toBe('未知斜杠命令或 Skill：/missing')
    store.dispose()
  })

  it('Host Command 走 execute 而不设置 awaitingResponse', async () => {
    const harness = createHarness({
      execute: async request => {
        expect(request).toEqual({ sessionId: '会话-A', line: '/compact  目标  ' })
        return { commandId: '命令-1', result: { kind: 'success', text: '已压缩' } }
      },
    })
    const store = await initialize(harness)

    await expect(store.submitComposerInput('/compact  目标  ')).resolves.toBe(true)
    expect(harness.execute).toHaveBeenCalledOnce()
    expect(harness.hostCall).not.toHaveBeenCalledWith('promptSession', expect.anything())
    expect(store.getSnapshot()).toMatchObject({
      awaitingResponseSessionIds: [],
      sessionCommandExecution: {
        phase: 'success',
        name: 'compact',
        commandId: '命令-1',
        text: '已压缩',
      },
    })
    store.dispose()
  })

  it('命令成功后清理匹配草稿但保留完成状态，后续编辑才清除状态', async () => {
    const harness = createHarness({
      execute: async () => ({
        commandId: '命令-完成状态',
        result: { kind: 'success', text: '压缩完成' },
      }),
    })
    const store = await initialize(harness)
    const submitted = '/compact 当前上下文'
    store.setSessionDraft('会话-A', submitted)

    await expect(store.submitComposerInput(submitted)).resolves.toBe(true)
    store.clearSessionDraft('会话-A', submitted)
    expect(store.getSnapshot()).toMatchObject({
      sessionDrafts: {},
      sessionCommandExecution: {
        phase: 'success',
        name: 'compact',
        commandId: '命令-完成状态',
        text: '压缩完成',
      },
    })

    store.setSessionDraft('会话-A', '下一条输入')
    expect(store.getSnapshot()).toMatchObject({
      sessionDrafts: { '会话-A': '下一条输入' },
      sessionCommandExecution: null,
    })
    store.dispose()
  })

  it('Skill 作为 prompt 提交，并在 Host 确认运行前保持 awaitingResponse', async () => {
    const harness = createHarness()
    const store = await initialize(harness)
    harness.hostCall.mockClear()

    await expect(store.submitComposerInput('/review-code  请检查  ')).resolves.toBe(true)
    expect(harness.hostCall).toHaveBeenCalledWith(
      'promptSession',
      expect.objectContaining({
        sessionId: '会话-A',
        content: [{ type: 'text', text: '/review-code  请检查  ' }],
      }),
    )
    expect(harness.execute).not.toHaveBeenCalled()
    expect(store.getSnapshot().awaitingResponseSessionIds).toEqual(['会话-A'])
    store.dispose()
  })

  it('输入区只跟踪主动提交的命令，权限控件的命令事件不占用状态', async () => {
    const result = deferred<Awaited<ReturnType<DesktopCommandsApi['execute']>>>()
    const harness = createHarness({ execute: () => result.promise })
    const store = await initialize(harness)

    harness.emitSessionFrame({
      type: 'session/event',
      sessionId: '会话-A',
      event: {
        type: 'command/run',
        seq: 1,
        time: 100,
        data: {
          commandId: '权限-1',
          name: 'permission',
          args: 'danger-full-access',
          source: { kind: 'user' },
        },
      },
    })
    harness.emitSessionFrame({
      type: 'session/event',
      sessionId: '会话-A',
      event: {
        type: 'command/done',
        seq: 2,
        time: 200,
        data: { commandId: '权限-1', kind: 'success', sourceEventSeq: 1 },
      },
    })
    expect(store.getSnapshot().sessionCommandExecution).toBeNull()

    store.setSessionDraft('会话-A', '/compact 目标')
    const executing = store.executeSessionCommand('/compact 目标')
    expect(store.getSnapshot().sessionDrafts['会话-A']).toBe('/compact 目标')
    harness.emitSessionFrame({
      type: 'session/event',
      sessionId: '会话-A',
      event: {
        type: 'command/run',
        seq: 3,
        time: 300,
        data: { commandId: '运行-1', name: 'compact', args: '目标', source: { kind: 'user' } },
      },
    })
    expect(store.getSnapshot().sessionCommandExecution).toEqual({
      phase: 'running',
      commandId: '运行-1',
      name: 'compact',
    })
    expect(store.getSnapshot().sessionDrafts['会话-A'] ?? '').toBe('')
    store.setSessionDraft('会话-A', '运行期间新写的内容')

    harness.emitSessionFrame({
      type: 'session/event',
      sessionId: '会话-A',
      event: {
        type: 'command/done',
        seq: 4,
        time: 400,
        data: { commandId: '运行-1', kind: 'success', text: '完成', sourceEventSeq: 3 },
      },
    })
    expect(store.getSnapshot().sessionCommandExecution).toEqual({
      phase: 'success',
      commandId: '运行-1',
      name: 'compact',
      text: '完成',
    })
    result.resolve({ commandId: '运行-1', result: { kind: 'success', text: '完成' } })
    await expect(executing).resolves.toBe(true)
    expect(store.getSnapshot().sessionDrafts['会话-A']).toBe('运行期间新写的内容')
    store.dispose()
  })

  it('命令结果交给对话记录呈现，未收到开始事件时保留草稿', async () => {
    const harness = createHarness({
      execute: async () => ({
        commandId: '命令-错误',
        result: { kind: 'error', text: '参数不正确' },
      }),
    })
    const store = await initialize(harness)
    store.setSessionDraft('会话-A', '/compact 错误参数')

    await expect(store.submitComposerInput('/compact 错误参数')).resolves.toBe(false)
    expect(store.getSnapshot()).toMatchObject({
      sessionDrafts: { '会话-A': '/compact 错误参数' },
      error: null,
      sessionCommandExecution: { phase: 'error', commandId: '命令-错误', text: '参数不正确' },
    })
    store.dispose()
  })

  it('切换会话时草稿按 Session 隔离', async () => {
    const harness = createHarness()
    const store = await initialize(harness)
    store.setSessionDraft('会话-A', 'A 的草稿')
    await selectAndWaitForDirectory(store, '会话-B')
    store.setSessionDraft('会话-B', 'B 的草稿')

    expect(store.getSnapshot().sessionDrafts).toEqual({
      '会话-A': 'A 的草稿',
      '会话-B': 'B 的草稿',
    })
    store.selectSession('会话-A')
    expect(store.getSnapshot().sessionDrafts['会话-A']).toBe('A 的草稿')
    expect(store.getSnapshot().sessionDrafts['会话-B']).toBe('B 的草稿')
    store.dispose()
  })

  it('Session 删除并重建同一 ID 时不继承旧瞬时状态或迟到响应', async () => {
    const oldCommands = deferred<readonly (typeof commands)[number][]>()
    const oldSkills = deferred<readonly (typeof skills)[number][]>()
    const oldExecution = deferred<Awaited<ReturnType<DesktopCommandsApi['execute']>>>()
    const oldPrompt = deferred<unknown>()
    let catalog: 'initial' | 'pending' | 'readded' = 'initial'
    let executeCount = 0
    let promptCount = 0
    let listedSessions = sessions()
    const harness = createHarness({
      call: async (operation, payload) => {
        if (operation === 'listSessions') return listedSessions
        if (operation === 'loadSessionPage') return { sessionId: payload.sessionId, records: [] }
        if (operation === 'promptSession') {
          promptCount += 1
          return promptCount === 1 ? oldPrompt.promise : { accepted: true }
        }
        throw new Error(`测试未处理 Host 操作：${operation}`)
      },
      list: async sessionId =>
        catalog === 'pending' && sessionId === '会话-A'
          ? oldCommands.promise
          : catalog === 'readded'
            ? [{ name: 'compact', description: '重建后的命令目录' }]
            : commands,
      listSkills: async sessionId =>
        catalog === 'pending' && sessionId === '会话-A'
          ? oldSkills.promise
          : catalog === 'readded'
            ? [{ name: 'readded-skill', description: '重建后的 Skill 目录', modelInvocable: true }]
            : skills,
      execute: async () => {
        executeCount += 1
        return executeCount === 1
          ? oldExecution.promise
          : { commandId: '命令-重建', result: { kind: 'success', text: '新命令完成' } }
      },
    })
    const store = await initialize(harness)
    store.setSessionDraft('会话-A', '删除前的草稿')
    harness.emitSessionFrame({
      type: 'session/queue',
      sessionId: '会话-A',
      queue: { items: [], totalCount: 1, omittedCount: 1, truncated: true },
    })
    const oldCommandRequest = store.submitComposerInput('/compact 删除前')
    const oldPromptRequest = store.sendMessage('删除前的 prompt')
    await vi.waitFor(() =>
      expect(store.getSnapshot()).toMatchObject({
        sendingMessage: true,
        sessionCommandExecution: { phase: 'submitting', name: 'compact' },
        sessionQueue: { totalCount: 1 },
      }),
    )
    catalog = 'pending'
    const oldDirectoryRequest = store.loadSessionCommandDirectory('会话-A', true)
    await vi.waitFor(() =>
      expect(store.getSnapshot().sessionCommandDirectory.status).toBe('loading'),
    )

    listedSessions = {
      items: [
        { sessionId: '会话-B', updatedAt: 100, running: false, blank: false, cwd: '/work/B' },
      ],
    }
    harness.emitHostFrame({ type: 'host/session-removed', sessionId: '会话-A' })
    await vi.waitFor(() =>
      expect(store.getSnapshot()).toMatchObject({
        selectedSessionId: '会话-B',
        sendingMessage: false,
        sessionCommandDirectory: { status: 'ready' },
        sessionCommandExecution: null,
        sessionQueue: { totalCount: 0 },
      }),
    )
    expect(store.getSnapshot().sessionDrafts['会话-A']).toBeUndefined()
    expect(store.getSnapshot().awaitingResponseSessionIds).not.toContain('会话-A')

    catalog = 'readded'
    listedSessions = sessions()
    harness.emitHostFrame({
      type: 'host/session-added',
      sessionId: '会话-A',
      blank: false,
      cwd: '/work/A',
    })
    await vi.waitFor(() =>
      expect(store.getSnapshot().sessions.some(session => session.sessionId === '会话-A')).toBe(
        true,
      ),
    )
    store.selectSession('会话-A')
    await vi.waitFor(() =>
      expect(store.getSnapshot().sessionCommandDirectory).toMatchObject({
        status: 'ready',
        value: {
          commands: [{ name: 'compact', description: '重建后的命令目录' }],
          skills: [{ name: 'readded-skill', description: '重建后的 Skill 目录' }],
        },
      }),
    )
    expect(store.getSnapshot()).toMatchObject({
      sendingMessage: false,
      sessionCommandExecution: null,
      sessionQueue: { totalCount: 0 },
    })
    expect(store.getSnapshot().sessionDrafts['会话-A']).toBeUndefined()

    await expect(store.submitComposerInput('/compact 重建后')).resolves.toBe(true)
    await expect(store.sendMessage('重建后的 prompt')).resolves.toBe(true)
    oldCommands.resolve([{ name: 'stale-command', description: '不应恢复的旧目录' }])
    oldSkills.resolve([
      { name: 'stale-skill', description: '不应恢复的旧 Skill', modelInvocable: true },
    ])
    oldExecution.resolve({ commandId: '命令-旧', result: { kind: 'error', text: '旧命令迟到' } })
    oldPrompt.resolve({ accepted: true })
    await expect(oldDirectoryRequest).resolves.toBe(false)
    await expect(oldCommandRequest).resolves.toBe(false)
    await expect(oldPromptRequest).resolves.toBe(false)
    expect(store.getSnapshot()).toMatchObject({
      sendingMessage: false,
      sessionCommandDirectory: {
        status: 'ready',
        value: { commands: [{ name: 'compact', description: '重建后的命令目录' }] },
      },
      sessionCommandExecution: {
        phase: 'success',
        commandId: '命令-重建',
        text: '新命令完成',
      },
    })
    expect(store.getSnapshot().error).not.toBe('旧命令迟到')
    store.dispose()
  })

  it('物理流 reset 使旧 prompt 失效，并允许同一 Session 立即重新提交', async () => {
    const firstPrompt = deferred<unknown>()
    let promptCount = 0
    const harness = createHarness({
      call: async (operation, payload) => {
        if (operation === 'listSessions') return sessions()
        if (operation === 'loadSessionPage') return { sessionId: payload.sessionId, records: [] }
        if (operation === 'promptSession') {
          promptCount += 1
          return promptCount === 1 ? firstPrompt.promise : { accepted: true }
        }
        throw new Error(`测试未处理 Host 操作：${operation}`)
      },
    })
    const store = await initialize(harness)

    const oldSubmission = store.sendMessage('旧连接上的消息')
    await vi.waitFor(() =>
      expect(store.getSnapshot()).toMatchObject({
        sendingMessage: true,
        awaitingResponseSessionIds: ['会话-A'],
      }),
    )
    harness.emitSessionFrame({ type: 'session/stream-reset' })
    expect(store.getSnapshot()).toMatchObject({
      sendingMessage: false,
      awaitingResponseSessionIds: [],
    })
    await expect(store.sendMessage('新连接上的消息')).resolves.toBe(true)
    expect(promptCount).toBe(2)

    firstPrompt.resolve({ accepted: true })
    await expect(oldSubmission).resolves.toBe(false)
    expect(store.getSnapshot().awaitingResponseSessionIds).toEqual(['会话-A'])
    store.dispose()
  })

  it('Host Command 提交或运行期间拒绝重复执行且不污染错误状态', async () => {
    const execution = deferred<Awaited<ReturnType<DesktopCommandsApi['execute']>>>()
    const harness = createHarness({ execute: async () => execution.promise })
    const store = await initialize(harness)

    const first = store.submitComposerInput('/compact 第一次')
    await vi.waitFor(() =>
      expect(store.getSnapshot().sessionCommandExecution).toMatchObject({
        phase: 'submitting',
        name: 'compact',
      }),
    )
    await expect(store.submitComposerInput('/compact 第二次')).resolves.toBe(false)
    expect(harness.execute).toHaveBeenCalledOnce()
    expect(store.getSnapshot().error).toBeNull()

    execution.resolve({ commandId: '命令-防重', result: { kind: 'success' } })
    await expect(first).resolves.toBe(true)
    store.dispose()
  })

  it('A 的 prompt 在途时切到 B 仍可独立提交 B 的 prompt', async () => {
    const promptA = deferred<unknown>()
    const harness = createHarness({
      call: async (operation, payload) => {
        if (operation === 'listSessions') return sessions()
        if (operation === 'loadSessionPage') return { sessionId: payload.sessionId, records: [] }
        if (operation === 'promptSession') {
          return payload.sessionId === '会话-A' ? promptA.promise : { accepted: true }
        }
        throw new Error(`测试未处理 Host 操作：${operation}`)
      },
    })
    const store = await initialize(harness)

    const sendingA = store.sendMessage('给 A 的消息')
    await vi.waitFor(() =>
      expect(harness.hostCall).toHaveBeenCalledWith(
        'promptSession',
        expect.objectContaining({ sessionId: '会话-A' }),
      ),
    )
    await selectAndWaitForDirectory(store, '会话-B')
    await expect(store.sendMessage('给 B 的消息')).resolves.toBe(true)
    expect(harness.hostCall).toHaveBeenCalledWith(
      'promptSession',
      expect.objectContaining({ sessionId: '会话-B' }),
    )

    promptA.resolve({ accepted: true })
    await expect(sendingA).resolves.toBe(true)
    store.dispose()
  })
})
