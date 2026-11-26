import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const preloadSource = readFileSync(new URL('../src/preload/index.cjs', import.meta.url), 'utf8')

describe('sandbox preload 能力白名单', () => {
  it('执行真实 preload，只向本地 renderer 暴露版本化设置与 Host 窄桥', async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>()
    const invoke = vi.fn(async (...args: unknown[]) => args)
    const on = vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      listeners.set(channel, listener)
    })
    const removeListener = vi.fn()
    const exposeInIsolatedWorld = vi.fn()
    const exposeInMainWorld = vi.fn()
    const getPathForFile = vi.fn((_file: unknown) => '/项目/README.md')
    const requireModule = vi.fn((moduleName: string) => {
      if (moduleName !== 'electron') throw new Error(`preload 不得加载 ${moduleName}`)
      return {
        contextBridge: { exposeInIsolatedWorld, exposeInMainWorld },
        ipcRenderer: { invoke, on, removeListener },
        webUtils: { getPathForFile },
      }
    })
    const preload = new Script(`(function (require) { ${preloadSource}\n})`).runInNewContext(
      {},
    ) as (require: (moduleName: string) => unknown) => void
    preload(requireModule)

    expect(requireModule).toHaveBeenCalledOnce()
    expect(exposeInIsolatedWorld).not.toHaveBeenCalled()
    expect(exposeInMainWorld).toHaveBeenCalledOnce()
    const [name, bridge] = exposeInMainWorld.mock.calls[0] as [
      string,
      {
        version: number
        onTabAction(listener: unknown): () => void
        remote: Record<string, (...args: unknown[]) => unknown>
        settings: Record<string, (...args: unknown[]) => unknown>
        attachments: Record<string, (...args: unknown[]) => unknown>
        host: Record<string, (...args: unknown[]) => unknown>
        sessionExports: Record<string, (...args: unknown[]) => unknown>
        interactions: Record<string, (...args: unknown[]) => unknown>
        commands: Record<string, (...args: unknown[]) => unknown>
        projects: Record<string, (...args: unknown[]) => unknown>
        terminal: Record<string, (...args: unknown[]) => unknown>
        lifecycle: Record<string, (...args: unknown[]) => unknown>
        window: Record<string, (...args: unknown[]) => unknown>
        projectTasks: Record<string, (...args: unknown[]) => unknown>
        fileWorkspace: Record<string, (...args: unknown[]) => unknown>
        automation: Record<string, (...args: unknown[]) => unknown>
      },
    ]
    expect(name).toBe('dshDesktop')
    expect(bridge.version).toBe(23)
    expect(Object.keys(bridge).toSorted()).toEqual([
      'attachments',
      'automation',
      'browser',
      'commands',
      'fileWorkspace',
      'getFrontendPlugins',
      'host',
      'interactions',
      'lifecycle',
      'onFrontendPluginsChanged',
      'onTabAction',
      'projectTasks',
      'projects',
      'remote',
      'sessionExports',
      'setPluginBusyReasons',
      'settings',
      'terminal',
      'version',
      'window',
    ])
    expect(Object.keys(bridge.window).toSorted()).toEqual(['act', 'onChanged', 'read'])
    expect(Object.isFrozen(bridge.window)).toBe(true)
    const api = bridge.settings
    expect(Object.keys(api).toSorted()).toEqual([
      'applyBackground',
      'cancelBackground',
      'chooseBackground',
      'clearBackground',
      'onChanged',
      'onOpenRequested',
      'read',
      'update',
    ])
    expect(Object.isFrozen(api)).toBe(true)
    expect(Object.keys(bridge.attachments).toSorted()).toEqual([
      'chooseImages',
      'importImages',
      'resolveDroppedFiles',
    ])
    expect(Object.isFrozen(bridge.attachments)).toBe(true)
    expect(Object.keys(bridge.host).toSorted()).toEqual([
      'call',
      'cancelSessionSearch',
      'onHostFrame',
      'onSessionFrame',
      'onStatusChanged',
      'searchSessions',
      'status',
    ])
    expect(Object.isFrozen(bridge.host)).toBe(true)
    expect(Object.keys(bridge.remote).toSorted()).toEqual(['call', 'cancelCall', 'follow'])
    expect(Object.isFrozen(bridge.remote)).toBe(true)
    expect(Object.keys(bridge.sessionExports).toSorted()).toEqual(['save'])
    expect(Object.isFrozen(bridge.sessionExports)).toBe(true)
    expect(Object.keys(bridge.interactions).toSorted()).toEqual(['respond'])
    expect(Object.isFrozen(bridge.interactions)).toBe(true)
    expect(Object.keys(bridge.commands).toSorted()).toEqual(['execute', 'list', 'listSkills'])
    expect(Object.isFrozen(bridge.commands)).toBe(true)
    expect(Object.keys(bridge.projects).toSorted()).toEqual(['call', 'list', 'onEvent'])
    expect(Object.isFrozen(bridge.projects)).toBe(true)
    expect(Object.keys(bridge.automation).toSorted()).toEqual([
      'checkPermissions',
      'detectBrowsers',
      'onSettingsChanged',
      'onStateChanged',
      'openPermissionSettings',
      'readSettings',
      'status',
      'stopTakeover',
      'testExternalBrowser',
      'updateSettings',
    ])
    expect(Object.isFrozen(bridge.automation)).toBe(true)
    expect(Object.keys(bridge.terminal).toSorted()).toEqual([
      'clipboard',
      'close',
      'create',
      'onEvent',
      'ready',
      'resize',
      'write',
    ])
    expect(Object.isFrozen(bridge.terminal)).toBe(true)
    expect(Object.keys(bridge.lifecycle).toSorted()).toEqual([
      'onCloseRequested',
      'resolveClose',
      'setDocumentEdited',
    ])
    expect(Object.isFrozen(bridge.lifecycle)).toBe(true)
    expect(Object.keys(bridge.projectTasks).toSorted()).toEqual([
      'list',
      'onEvent',
      'remove',
      'reorder',
      'save',
    ])
    expect(Object.isFrozen(bridge.projectTasks)).toBe(true)
    expect(Object.keys(bridge.fileWorkspace).toSorted()).toEqual(['read', 'save'])
    expect(Object.isFrozen(bridge.fileWorkspace)).toBe(true)
    expect(Object.isFrozen(bridge)).toBe(true)

    const patch = { islandGap: 10 }
    const choose = { layer: 'canvas', targetAspectRatio: 1.6 }
    const apply = { selectionId: 'selection', crop: { x: 0, y: 0, width: 1, height: 1 } }
    await api.read?.()
    await api.update?.(patch)
    await api.chooseBackground?.(choose)
    await api.applyBackground?.(apply)
    await api.cancelBackground?.('selection')
    await api.clearBackground?.('sidebar')
    await bridge.attachments.chooseImages?.()
    const droppedImages = [{ name: '界面.png', bytes: new Uint8Array([1, 2, 3]) }]
    await bridge.attachments.importImages?.(droppedImages)
    const droppedFiles = [{}]
    await bridge.attachments.resolveDroppedFiles?.('项目-1', droppedFiles)
    await bridge.host.status?.()
    await bridge.host.call?.('listSessions', {})
    await bridge.host.searchSessions?.('数据库迁移')
    await bridge.host.cancelSessionSearch?.()
    await bridge.sessionExports.save?.('会话-1')
    await bridge.interactions.respond?.({
      kind: 'approval',
      sessionId: '会话-1',
      key: 'approval:rpc-1',
      outcome: 'rejected',
    })
    await bridge.commands.list?.('会话-1')
    await bridge.commands.listSkills?.('会话-1')
    await bridge.commands.execute?.({ sessionId: '会话-1', line: '/compact' })
    await bridge.projects.list?.()
    await bridge.projects.call?.('readFile', { projectId: 'project', relativePath: 'README.md' })
    const terminalCreate = { projectId: 'project', columns: 80, rows: 24 }
    await bridge.terminal.create?.(terminalCreate)
    await bridge.terminal.ready?.('终端-1')
    await bridge.terminal.write?.('终端-1', 'printf 你好\r')
    await bridge.terminal.resize?.('终端-1', 100, 30)
    await bridge.terminal.close?.('终端-1')
    await bridge.terminal.clipboard?.('paste')
    await bridge.lifecycle.setDocumentEdited?.(true)
    await bridge.lifecycle.resolveClose?.('cancel')
    const task = {
      projectId: 'project',
      name: '开发',
      executable: 'npm',
      args: ['run', 'dev'],
      cwd: '',
      env: {},
      allowConcurrent: false,
    }
    await bridge.projectTasks.list?.('project')
    await bridge.projectTasks.save?.(task)
    await bridge.projectTasks.remove?.('task-1')
    await bridge.projectTasks.reorder?.('project', ['task-1'])
    const fileWorkspace = {
      projectId: '0123456789abcdef01234567',
      pinnedFiles: ['README.md'],
      activeFile: 'README.md',
      expandedDirectories: [''],
      recentFiles: ['README.md'],
      treeScrollLeft: 18,
      treeScrollTop: 36,
    }
    await bridge.fileWorkspace.read?.(fileWorkspace.projectId)
    await bridge.fileWorkspace.save?.(fileWorkspace)
    await bridge.remote.call?.('workspaceFiles/list', {}, '1')
    await bridge.remote.cancelCall?.('1')
    expect(invoke.mock.calls).toEqual([
      ['dsh-desktop:settings:read'],
      ['dsh-desktop:settings:update', patch],
      ['dsh-desktop:settings:choose-background', choose],
      ['dsh-desktop:settings:apply-background', apply],
      ['dsh-desktop:settings:cancel-background', 'selection'],
      ['dsh-desktop:settings:clear-background', 'sidebar'],
      ['dsh-desktop:attachments:choose-images'],
      ['dsh-desktop:attachments:import-images', droppedImages],
      [
        'dsh-desktop:file-references:resolve-dropped-files',
        {
          projectId: '项目-1',
          absolutePaths: ['/项目/README.md'],
        },
      ],
      ['dsh-desktop:host:status'],
      ['dsh-desktop:host:call', 'listSessions', {}],
      ['dsh-desktop:host:search-sessions', '数据库迁移'],
      ['dsh-desktop:host:cancel-session-search'],
      ['dsh-desktop:session-exports:save', '会话-1'],
      [
        'dsh-desktop:interactions:respond',
        { kind: 'approval', sessionId: '会话-1', key: 'approval:rpc-1', outcome: 'rejected' },
      ],
      ['dsh-desktop:commands:list', '会话-1'],
      ['dsh-desktop:commands:list-skills', '会话-1'],
      ['dsh-desktop:commands:execute', { sessionId: '会话-1', line: '/compact' }],
      ['dsh-desktop:project:list'],
      ['dsh-desktop:project:call', 'readFile', { projectId: 'project', relativePath: 'README.md' }],
      ['dsh-desktop:terminal:create', terminalCreate],
      ['dsh-desktop:terminal:ready', '终端-1'],
      ['dsh-desktop:terminal:write', '终端-1', 'printf 你好\r'],
      ['dsh-desktop:terminal:resize', '终端-1', 100, 30],
      ['dsh-desktop:terminal:close', '终端-1'],
      ['dsh-desktop:terminal:clipboard', 'paste'],
      ['dsh-desktop:lifecycle:document-edited', true],
      ['dsh-desktop:lifecycle:close-decision', 'cancel'],
      ['dsh-desktop:project-tasks:list', 'project'],
      ['dsh-desktop:project-tasks:save', task],
      ['dsh-desktop:project-tasks:remove', 'task-1'],
      ['dsh-desktop:project-tasks:reorder', 'project', ['task-1']],
      ['dsh-desktop:file-state:read', fileWorkspace.projectId],
      ['dsh-desktop:file-state:save', fileWorkspace],
      ['mydsh:remote:call', 'workspaceFiles/list', {}, '1'],
      ['mydsh:remote:cancel-call', '1'],
    ])

    const changed = vi.fn()
    const openRequested = vi.fn()
    const stopChanged = api.onChanged?.(changed) as () => void
    const stopOpenRequested = api.onOpenRequested?.(openRequested) as () => void
    const hostChanged = vi.fn()
    const stopHostChanged = bridge.host.onStatusChanged?.(hostChanged) as () => void
    const sessionFrameChanged = vi.fn()
    const stopSessionFrameChanged = bridge.host.onSessionFrame?.(sessionFrameChanged) as () => void
    const hostFrameChanged = vi.fn()
    const stopHostFrameChanged = bridge.host.onHostFrame?.(hostFrameChanged) as () => void
    const terminalChanged = vi.fn()
    const stopTerminalChanged = bridge.terminal.onEvent?.(terminalChanged) as () => void
    const closeRequested = vi.fn()
    const stopCloseRequested = bridge.lifecycle.onCloseRequested?.(closeRequested) as () => void
    const projectTaskEvent = vi.fn()
    const stopProjectTaskEvent = bridge.projectTasks.onEvent?.(projectTaskEvent) as () => void
    const snapshot = { revision: 3 }
    listeners.get('dsh-desktop:settings:changed')?.({}, snapshot)
    listeners.get('dsh-desktop:settings:open-requested')?.({})
    const hostState = { kind: 'ready' }
    listeners.get('dsh-desktop:host:status-changed')?.({}, hostState)
    const sessionFrame = { type: 'session/subscribed', sessionId: 'session-1', lastSeq: 12 }
    listeners.get('dsh-desktop:host:session-frame')?.({}, sessionFrame)
    const hostFrame = { type: 'host/session-status', sessionId: 'session-1', running: true }
    listeners.get('dsh-desktop:host:host-frame')?.({}, hostFrame)
    const terminalEvent = { type: 'data', terminalId: '终端-1', data: '完成' }
    listeners.get('dsh-desktop:terminal:event')?.({}, terminalEvent)
    listeners.get('dsh-desktop:lifecycle:close-requested')?.({})
    const taskEvent = { type: 'removed', projectId: 'project', taskId: 'task-1' }
    listeners.get('dsh-desktop:project-tasks:event')?.({}, taskEvent)
    expect(changed).toHaveBeenCalledWith(snapshot)
    expect(openRequested).toHaveBeenCalledOnce()
    expect(hostChanged).toHaveBeenCalledWith(hostState)
    expect(sessionFrameChanged).toHaveBeenCalledWith(sessionFrame)
    expect(hostFrameChanged).toHaveBeenCalledWith(hostFrame)
    expect(terminalChanged).toHaveBeenCalledWith(terminalEvent)
    expect(closeRequested).toHaveBeenCalledOnce()
    expect(projectTaskEvent).toHaveBeenCalledWith(taskEvent)
    stopChanged()
    stopOpenRequested()
    stopHostChanged()
    stopSessionFrameChanged()
    stopHostFrameChanged()
    stopTerminalChanged()
    stopCloseRequested()
    stopProjectTaskEvent()
    expect(removeListener).toHaveBeenCalledTimes(8)
    await bridge.window.read?.()
    await bridge.window.act?.('toggle-maximize')
    expect(invoke.mock.calls.slice(-2)).toEqual([
      ['dsh-desktop:window:read'],
      ['dsh-desktop:window:act', 'toggle-maximize'],
    ])
    const windowChanged = vi.fn()
    const stopWindow = bridge.window.onChanged?.(windowChanged) as () => void
    listeners.get('dsh-desktop:window:changed')?.({}, { maximized: true })
    expect(windowChanged).toHaveBeenCalledWith({ maximized: true })
    stopWindow()
    expect(removeListener).toHaveBeenCalledTimes(9)
    const projectEvent = vi.fn()
    const stopProjectEvent = bridge.projects.onEvent?.(projectEvent) as () => void
    const projectChangeEvent = {
      type: 'git-changed',
      projectId: 'project',
      scope: 'refs',
      reason: 'watcher',
      timestamp: 1,
    }
    listeners.get('dsh-desktop:project:event')?.({}, projectChangeEvent)
    expect(projectEvent).toHaveBeenCalledWith(projectChangeEvent)
    stopProjectEvent()
    expect(removeListener).toHaveBeenCalledTimes(10)
    expect(() => bridge.projects.onEvent?.('不是函数')).toThrow('项目事件监听器必须是函数')
    expect(() => bridge.window.onChanged?.('不是函数')).toThrow('窗口状态监听器必须是函数')
    expect(() => api.onChanged?.('不是函数')).toThrow('设置监听器必须是函数')
    expect(() => api.onOpenRequested?.('不是函数')).toThrow('打开设置监听器必须是函数')
    expect(() => bridge.host.onStatusChanged?.('不是函数')).toThrow('Host 状态监听器必须是函数')
    expect(() => bridge.host.onSessionFrame?.('不是函数')).toThrow('Session 实时帧监听器必须是函数')
    expect(() => bridge.host.onHostFrame?.('不是函数')).toThrow('Host 实时帧监听器必须是函数')
    expect(() => bridge.terminal.onEvent?.('不是函数')).toThrow('终端监听器必须是函数')
    expect(() => bridge.lifecycle.onCloseRequested?.('不是函数')).toThrow(
      '关闭窗口监听器必须是函数',
    )
    expect(() => bridge.projectTasks.onEvent?.('不是函数')).toThrow('项目任务监听器必须是函数')
    const tabAction = vi.fn()
    const stopTabAction = bridge.onTabAction(tabAction)
    listeners.get('mydsh:workspace:tab-action')?.({}, 'close')
    expect(tabAction).toHaveBeenCalledWith('close')
    stopTabAction()
    expect(removeListener).toHaveBeenLastCalledWith(
      'mydsh:workspace:tab-action',
      listeners.get('mydsh:workspace:tab-action'),
    )
    expect(() => bridge.onTabAction('不是函数')).toThrow('工作标签操作监听器必须是函数')
  })
})
