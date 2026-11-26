import { describe, expect, it, vi } from 'vitest'

import { WorkspaceStore } from '../src/renderer/src/models/workspace/store.ts'
import { PANEL_LAYOUT_STORAGE_KEYS } from '../src/renderer/src/domain/panel-layout.ts'
import { projectIdForCwd } from '../src/renderer/src/domain/project.ts'
import { PINNED_SESSION_IDS_STORAGE_KEY } from '../src/renderer/src/domain/session-pins.ts'
import type {
  DesktopBridge,
  DesktopSettings,
  HostStatus,
} from '../src/renderer/src/platform/contracts.ts'
import type {
  DesktopQueuedMessage,
  DesktopQueueSnapshot,
  DesktopSessionFrame,
} from '../src/shared/session-live.ts'
import type { DesktopHostFrame } from '../src/shared/host-live.ts'
import { parseDesktopHostFrame } from '../src/shared/host-live.ts'

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

interface Harness {
  bridge: DesktopBridge
  hostCall: ReturnType<typeof vi.fn<DesktopBridge['host']['call']>>
  emitHostStatus(status: HostStatus): void
  emitSessionFrame(frame: DesktopSessionFrame): void
  emitHostFrame(frame: DesktopHostFrame): void
  storage: Pick<Storage, 'getItem' | 'setItem'>
  stored: Map<string, string>
}

function createHarness(
  call: DesktopBridge['host']['call'],
  initialStorage: Readonly<Record<string, string>> = {},
): Harness {
  const hostCall = vi.fn<DesktopBridge['host']['call']>(call)
  let hostStatusListener: ((status: HostStatus) => void) | undefined
  let sessionFrameListener: ((frame: DesktopSessionFrame) => void) | undefined
  let hostFrameListener: ((frame: DesktopHostFrame) => void) | undefined
  const stored = new Map<string, string>(Object.entries(initialStorage))
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
      onStatusChanged: listener => {
        hostStatusListener = listener
        return () => {
          if (hostStatusListener === listener) hostStatusListener = undefined
        }
      },
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
  }
  return {
    bridge,
    hostCall,
    emitHostStatus: status => {
      hostStatusListener?.(status)
    },
    emitSessionFrame: frame => {
      sessionFrameListener?.(frame)
    },
    emitHostFrame: frame => {
      hostFrameListener?.(frame)
    },
    storage,
    stored,
  }
}

function queuedMessage(
  id: string,
  text: string,
  placement: DesktopQueuedMessage['placement'] = 'queued',
): DesktopQueuedMessage {
  return {
    id,
    placement,
    preview: text,
    previewTruncated: false,
    edit: { kind: 'editable-text', text },
  }
}

function queueSnapshot(
  items: readonly DesktopQueuedMessage[],
  totalCount = items.length,
): DesktopQueueSnapshot {
  const omittedCount = Math.max(0, totalCount - items.length)
  return { items, totalCount, omittedCount, truncated: omittedCount > 0 }
}

function configureCollaborationModes(store: WorkspaceStore): void {
  store.configureModes(
    [
      { id: 'conversation', mainIslandId: 'conversation', sessionHome: true },
      { id: 'files', mainIslandId: 'files' },
      { id: 'terminal', mainIslandId: 'terminal' },
    ],
    [
      { id: 'conversation', placements: ['main', 'right'] },
      { id: 'files', placements: ['main', 'right'] },
      { id: 'terminal', placements: ['main', 'right'] },
    ],
  )
}

describe('renderer WorkspaceStore 浮岛尺寸与折叠状态', () => {
  it('计划全文绑定会话，只自动打开一次，关闭恢复右侧现场且不提交审阅', async () => {
    const harness = createHarness(async operation =>
      operation === 'listSessions' ? initialSessions() : { events: [] },
    )
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()
    const sessionId = store.getSnapshot().selectedSessionId!
    store.selectRightIsland('files')
    store.openPlanPreview(sessionId, '调用-1', '# 计划', '请求-1')
    expect(store.getSnapshot()).toMatchObject({
      activeRightIslandId: 'plan-preview',
      planPreview: { sessionId, id: '调用-1' },
    })
    store.closePlanPreview()
    expect(store.getSnapshot()).toMatchObject({ activeRightIslandId: 'files', planPreview: null })
    store.openPlanPreview(sessionId, '调用-1', '# 计划', '请求-1')
    expect(store.getSnapshot().planPreview).toBeNull()
    store.openPlanPreview('过期会话', '调用-2', '# 错误计划')
    expect(store.getSnapshot().planPreview).toBeNull()
    store.openPlanPreview(sessionId, '调用-1', '# 计划')
    store.closePlanPreview(sessionId, '过期调用')
    expect(store.getSnapshot().planPreview?.id).toBe('调用-1')
    store.selectRightIsland('session-info')
    store.closePlanPreview()
    expect(store.getSnapshot().activeRightIslandId).toBe('session-info')
    store.dispose()
    expect(store.getSnapshot().planPreview).toBeNull()
  })
  it('计划阅读临时展开右栏，关闭或切换会话后恢复原栏目且不保存计划入口', async () => {
    const harness = createHarness(async operation =>
      operation === 'listSessions' ? initialSessions() : { events: [] },
    )
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()
    const sessionId = store.getSnapshot().selectedSessionId!
    store.selectRightIsland('files')
    store.toggleInformation()
    store.openPlanPreview(sessionId, '调用-1', '# 计划')
    expect(store.getSnapshot()).toMatchObject({
      activeRightIslandId: 'plan-preview',
      informationCollapsed: false,
    })
    expect(harness.stored.get(PANEL_LAYOUT_STORAGE_KEYS.informationCollapsed)).toBe('true')
    store.openPlanPreview(sessionId, '调用-2', '# 第二份计划')
    store.closePlanPreview()
    expect(store.getSnapshot()).toMatchObject({
      activeRightIslandId: 'files',
      informationCollapsed: true,
      planPreview: null,
    })
    store.openPlanPreview(sessionId, '调用-1', '# 计划')
    store.selectSession('乙-会话')
    expect(store.getSnapshot()).toMatchObject({ informationCollapsed: true, planPreview: null })
    store.selectSession(sessionId)
    expect(store.getSnapshot()).toMatchObject({ activeRightIslandId: 'files', planPreview: null })
    store.openPlanPreview(sessionId, '调用-1', '# 计划')
    store.setView('files')
    expect(store.getSnapshot()).toMatchObject({
      activeView: 'files',
      activeRightIslandId: 'files',
      planPreview: null,
    })
    store.dispose()
  })
  it('合并未知插件状态并在重连时清理，已转发事件刷新设置与当前模型目录', async () => {
    const harness = createHarness(async operation =>
      operation === 'listSessions' ? initialSessions() : { events: [] },
    )
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()
    const sessionId = store.getSnapshot().selectedSessionId!
    const emit = (seq: number, progress: number) =>
      harness.emitSessionFrame({
        type: 'session/plugin-projections',
        sessionId,
        change: {
          kind: 'patch',
          asOfSeq: seq,
          values: { 自定义插件: { progress } },
          omitted: 0,
        },
      })
    emit(20, 2)
    emit(19, 1)
    await store.refreshSessions()
    expect(store.selectedSession()?.projections?.values?.自定义插件).toEqual({ progress: 2 })
    const refreshModels = vi.spyOn(store, 'loadSessionModels').mockResolvedValue(true)
    for (const [event, args] of [
      ['settings/document-updated', ['shell', 3]],
      ['llm/adapters-updated', []],
      ['credentials/reference-updated', ['DSH_TEST_KEY']],
    ] as const)
      harness.emitHostFrame(parseDesktopHostFrame({ type: 'host/remote-event', event, args })!)
    expect(store.getSnapshot()).toMatchObject({
      hostSettingsRevision: 1,
      hostModelsRevision: 1,
      hostCredentialsRevision: 1,
    })
    expect(refreshModels).toHaveBeenCalledTimes(3)
    expect(
      parseDesktopHostFrame({ type: 'host/remote-event', event: '插件/未知', args: [] }),
    ).toBeNull()
    expect(
      parseDesktopHostFrame({
        type: 'host/remote-event',
        event: 'settings/document-updated',
        args: ['shell', -1],
      }),
    ).toBeNull()
    refreshModels.mockRestore()
    const slow = Promise.withResolvers<unknown>()
    harness.hostCall
      .mockImplementationOnce(() => slow.promise)
      .mockResolvedValueOnce(sessionModelCatalogFixture)
    const previousRead = store.loadSessionModels(true)
    harness.emitHostFrame({ type: 'host/model-adapters-updated' })
    await vi.waitFor(() => {
      expect(store.getSnapshot().sessionModels?.groups).toEqual(sessionModelCatalogFixture.groups)
    })
    slow.resolve({ ...sessionModelCatalogFixture, groups: [] })
    await previousRead
    expect(store.getSnapshot().sessionModels?.groups).toEqual(sessionModelCatalogFixture.groups)
    harness.emitHostStatus({ kind: 'connecting', message: '正在重连' })
    expect(store.selectedSession()?.projections?.values?.自定义插件).toBeUndefined()
    store.dispose()
  })
  it('轨迹临时收起两侧，但用户主动展开右侧后保留新选择', () => {
    const harness = createHarness(async () => initialSessions())
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    store.configureModes([
      { id: 'conversation', mainIslandId: 'conversation', sessionHome: true },
      { id: 'trajectory', mainIslandId: 'trajectory', collapsePanelsOnEnter: true },
      { id: 'connections', mainIslandId: 'connections', collapsePanelsOnEnter: 'right' },
    ])

    store.toggleInformation()
    expect(store.getSnapshot()).toMatchObject({
      navigationCollapsed: false,
      informationCollapsed: true,
    })
    expect(harness.stored.get(PANEL_LAYOUT_STORAGE_KEYS.navigationCollapsed)).toBeUndefined()
    expect(harness.stored.get(PANEL_LAYOUT_STORAGE_KEYS.informationCollapsed)).toBe('true')

    store.setView('trajectory')
    expect(store.getSnapshot()).toMatchObject({
      activeView: 'trajectory',
      navigationCollapsed: true,
      informationCollapsed: true,
    })
    expect(harness.stored.get(PANEL_LAYOUT_STORAGE_KEYS.navigationCollapsed)).toBeUndefined()
    expect(harness.stored.get(PANEL_LAYOUT_STORAGE_KEYS.informationCollapsed)).toBe('true')

    store.toggleNavigation()
    store.toggleInformation()
    expect(store.getSnapshot()).toMatchObject({
      navigationCollapsed: false,
      informationCollapsed: false,
    })
    expect(harness.stored.get(PANEL_LAYOUT_STORAGE_KEYS.navigationCollapsed)).toBeUndefined()
    expect(harness.stored.get(PANEL_LAYOUT_STORAGE_KEYS.informationCollapsed)).toBe('false')

    store.setView('files')
    expect(store.getSnapshot()).toMatchObject({
      activeView: 'files',
      navigationCollapsed: false,
      informationCollapsed: false,
    })
    expect(harness.stored.get(PANEL_LAYOUT_STORAGE_KEYS.navigationCollapsed)).toBeUndefined()
    expect(harness.stored.get(PANEL_LAYOUT_STORAGE_KEYS.informationCollapsed)).toBe('false')

    store.setView('connections')
    expect(store.getSnapshot()).toMatchObject({
      navigationCollapsed: false,
      informationCollapsed: true,
    })
    store.setView('files')
    expect(store.getSnapshot()).toMatchObject({
      navigationCollapsed: false,
      informationCollapsed: false,
    })
    store.setView('connections')
    store.toggleNavigation()
    store.toggleInformation()
    store.setView('files')
    expect(store.getSnapshot()).toMatchObject({
      navigationCollapsed: true,
      informationCollapsed: false,
    })
    expect(harness.stored.get(PANEL_LAYOUT_STORAGE_KEYS.navigationCollapsed)).toBe('true')
    store.setView('connections')
    store.resizeNavigation(320)
    store.setView('files')
    expect(store.getSnapshot()).toMatchObject({
      navigationCollapsed: false,
      informationCollapsed: false,
    })
  })

  it('从轨迹里选择会话时恢复进入轨迹前的两侧面板状态', async () => {
    const harness = createHarness(
      async (operation, payload) => {
        if (operation === 'listSessions') return initialSessions()
        if (operation === 'loadSessionPage') return history(payload.sessionId)
        throw new Error(`测试未处理 Host 操作：${operation}`)
      },
      {
        [PANEL_LAYOUT_STORAGE_KEYS.navigationCollapsed]: 'true',
        [PANEL_LAYOUT_STORAGE_KEYS.informationCollapsed]: 'false',
      },
    )
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    store.configureModes([
      { id: 'conversation', mainIslandId: 'conversation', sessionHome: true },
      { id: 'trajectory', mainIslandId: 'trajectory', collapsePanelsOnEnter: true },
    ])
    await store.initialize()

    store.setView('trajectory')
    store.toggleNavigation()
    store.toggleInformation()
    store.selectSession('乙-会话')

    expect(store.getSnapshot()).toMatchObject({
      activeView: 'conversation',
      navigationCollapsed: true,
      informationCollapsed: false,
      selectedSessionId: '乙-会话',
    })
    expect(harness.stored.get(PANEL_LAYOUT_STORAGE_KEYS.navigationCollapsed)).toBe('true')
    expect(harness.stored.get(PANEL_LAYOUT_STORAGE_KEYS.informationCollapsed)).toBe('false')
    store.dispose()
  })

  it('插件模式声明决定会话入口和临时收起行为，不依赖内置模式标识', async () => {
    const harness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions') return initialSessions()
      if (operation === 'loadSessionPage') return history(payload.sessionId)
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    store.configureModes(
      [
        { id: 'example.home', mainIslandId: 'example.conversation-island', sessionHome: true },
        { id: 'example.focus', mainIslandId: 'example.focus-island', collapsePanelsOnEnter: true },
      ],
      [
        { id: 'example.conversation-island', placements: ['main', 'right'] },
        { id: 'example.focus-island', placements: ['main'] },
      ],
    )
    await store.initialize()
    expect(store.getSnapshot().activeView).toBe('example.home')

    store.setView('example.focus')
    expect(store.getSnapshot()).toMatchObject({
      navigationCollapsed: true,
      informationCollapsed: true,
    })
    store.selectSession('乙-会话')
    expect(store.getSnapshot()).toMatchObject({
      activeView: 'example.home',
      selectedSessionId: '乙-会话',
      navigationCollapsed: false,
      informationCollapsed: false,
    })
    const intent = store.captureIslandCollaborationIntent()
    expect(store.presentIslandCollaboration(intent!, 'example.missing', 'main')).toBe(false)
    expect(store.getSnapshot().activeView).toBe('example.home')
    expect(store.presentIslandCollaboration(intent!, 'example.focus', 'main')).toBe(true)
    expect(store.getSnapshot().activeRightIslandId).toBe('example.conversation-island')
    store.dispose()
  })

  it('进入终端时保留左右栏偏好，并持久化用户在终端中的折叠操作', () => {
    const harness = createHarness(async () => initialSessions())
    const store = new WorkspaceStore(harness.bridge, harness.storage)

    store.setView('terminal')
    expect(store.getSnapshot()).toMatchObject({
      activeView: 'terminal',
      navigationCollapsed: false,
      informationCollapsed: false,
    })
    expect(harness.stored.get(PANEL_LAYOUT_STORAGE_KEYS.informationCollapsed)).toBeUndefined()

    store.toggleInformation()
    expect(store.getSnapshot()).toMatchObject({
      activeView: 'terminal',
      navigationCollapsed: false,
      informationCollapsed: true,
    })
    expect(harness.stored.get(PANEL_LAYOUT_STORAGE_KEYS.informationCollapsed)).toBe('true')

    store.setView('files')
    expect(store.getSnapshot()).toMatchObject({
      activeView: 'files',
      navigationCollapsed: false,
      informationCollapsed: true,
    })
    expect(harness.stored.get(PANEL_LAYOUT_STORAGE_KEYS.informationCollapsed)).toBe('true')
  })

  it('文件协同在成功后换位，返回对话只恢复本次操作占用前的右侧选择', async () => {
    const harness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions') return initialSessions()
      if (operation === 'loadSessionPage') return history(payload.sessionId)
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    configureCollaborationModes(store)
    await store.initialize()
    store.initializeRightIsland('session-info')
    store.selectRightIsland('git-history')
    expect(store.getSnapshot().rightIslandSelectionRequest).toEqual({
      islandId: 'git-history',
      revision: 1,
    })

    const sideIntent = store.captureIslandCollaborationIntent()
    expect(sideIntent).not.toBeNull()
    expect(store.presentIslandCollaboration(sideIntent!, 'files', 'right')).toBe(true)
    expect(store.getSnapshot()).toMatchObject({
      activeView: 'conversation',
      activeRightIslandId: 'files',
      rightIslandSelectionRequest: { islandId: 'git-history', revision: 1 },
    })

    const mainIntent = store.captureIslandCollaborationIntent()
    expect(store.presentIslandCollaboration(mainIntent!, 'files', 'main')).toBe(true)
    expect(store.getSnapshot()).toMatchObject({
      activeView: 'files',
      activeRightIslandId: 'conversation',
    })
    store.setView('conversation')
    expect(store.getSnapshot()).toMatchObject({
      activeView: 'conversation',
      activeRightIslandId: 'files',
    })
    expect(store.getSnapshot().activeRightIslandId).toBe('files')
    store.dispose()
  })

  it('文件读取期间手动切换右侧后，过期协同意图不再覆盖选择', async () => {
    const harness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions') return initialSessions()
      if (operation === 'loadSessionPage') return history(payload.sessionId)
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    configureCollaborationModes(store)
    await store.initialize()
    store.initializeRightIsland('session-info')
    const intent = store.captureIslandCollaborationIntent()
    store.selectRightIsland('terminal')

    expect(store.presentIslandCollaboration(intent!, 'files', 'right')).toBe(false)
    expect(store.getSnapshot()).toMatchObject({
      activeView: 'conversation',
      activeRightIslandId: 'terminal',
    })
    store.dispose()
  })

  it('右侧终端进入主区后可返回同一右侧现场', async () => {
    const harness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions') return initialSessions()
      if (operation === 'loadSessionPage') return history(payload.sessionId)
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    configureCollaborationModes(store)
    await store.initialize()
    store.initializeRightIsland('session-info')
    store.selectRightIsland('terminal')

    const intent = store.captureIslandCollaborationIntent()
    expect(store.presentIslandCollaboration(intent!, 'terminal', 'main')).toBe(true)
    expect(store.getSnapshot()).toMatchObject({
      activeView: 'terminal',
      activeRightIslandId: 'conversation',
    })
    store.setView('conversation')
    expect(store.getSnapshot()).toMatchObject({
      activeView: 'conversation',
      activeRightIslandId: 'terminal',
    })
    expect(store.getSnapshot().activeRightIslandId).toBe('terminal')
    store.dispose()
  })

  it('使用默认宽度，限制左栏边界并允许右侧浮岛超过旧上限', () => {
    const harness = createHarness(async () => initialSessions())
    const store = new WorkspaceStore(harness.bridge, harness.storage)

    expect(store.getSnapshot()).toMatchObject({
      navigationWidth: 260,
      informationWidth: 260,
      composerHeight: 112,
      panelCapsulesPersistent: false,
      navigationCollapsed: false,
      informationCollapsed: false,
    })

    store.resizeNavigation(120)
    store.resizeInformation(500)

    expect(store.getSnapshot()).toMatchObject({
      navigationWidth: 190,
      informationWidth: 500,
    })
    expect(harness.stored.get(PANEL_LAYOUT_STORAGE_KEYS.navigationWidth)).toBe('190')
    expect(harness.stored.get(PANEL_LAYOUT_STORAGE_KEYS.informationWidth)).toBe('500')

    store.resizeNavigation(500)
    store.resizeInformation(120)

    expect(store.getSnapshot()).toMatchObject({
      navigationWidth: 340,
      informationWidth: 260,
    })
    expect(harness.stored.get(PANEL_LAYOUT_STORAGE_KEYS.navigationWidth)).toBe('340')
    expect(harness.stored.get(PANEL_LAYOUT_STORAGE_KEYS.informationWidth)).toBe('260')
  })

  it('拖动已折叠浮岛时自动展开，并持久化宽度与展开状态', () => {
    const harness = createHarness(async () => initialSessions())
    const store = new WorkspaceStore(harness.bridge, harness.storage)

    store.toggleNavigation()
    store.toggleInformation()
    expect(store.getSnapshot()).toMatchObject({
      navigationCollapsed: true,
      informationCollapsed: true,
    })

    store.resizeNavigation(300.5)
    store.resizeInformation(360)

    expect(store.getSnapshot()).toMatchObject({
      navigationWidth: 300.5,
      informationWidth: 360,
      navigationCollapsed: false,
      informationCollapsed: false,
    })
    expect(harness.stored.get(PANEL_LAYOUT_STORAGE_KEYS.navigationCollapsed)).toBe('false')
    expect(harness.stored.get(PANEL_LAYOUT_STORAGE_KEYS.informationCollapsed)).toBe('false')
  })

  it('新实例恢复持久化的宽度与折叠状态', () => {
    const harness = createHarness(async () => initialSessions())
    const firstStore = new WorkspaceStore(harness.bridge, harness.storage)
    firstStore.resizeNavigation(288)
    firstStore.resizeInformation(396)
    firstStore.resizeComposer(244)
    firstStore.setConversationWidth(1040)
    firstStore.setPanelCapsulesPersistent(true)
    firstStore.toggleNavigation()
    firstStore.toggleInformation()

    const restoredStore = new WorkspaceStore(harness.bridge, harness.storage)

    expect(restoredStore.getSnapshot()).toMatchObject({
      navigationWidth: 288,
      informationWidth: 396,
      composerHeight: 244,
      conversationWidth: 1040,
      panelCapsulesPersistent: true,
      navigationCollapsed: true,
      informationCollapsed: true,
    })
    restoredStore.setConversationWidth(null)
    expect(
      new WorkspaceStore(harness.bridge, harness.storage).getSnapshot().conversationWidth,
    ).toBeNull()
  })

  it('读取持久化宽度时保留右侧宽度偏好，并忽略非法值与非法折叠标记', () => {
    const boundedHarness = createHarness(async () => initialSessions(), {
      [PANEL_LAYOUT_STORAGE_KEYS.navigationWidth]: '100',
      [PANEL_LAYOUT_STORAGE_KEYS.informationWidth]: '900',
      [PANEL_LAYOUT_STORAGE_KEYS.composerHeight]: '900',
      [PANEL_LAYOUT_STORAGE_KEYS.panelCapsulesPersistent]: 'yes',
      [PANEL_LAYOUT_STORAGE_KEYS.navigationCollapsed]: 'true',
      [PANEL_LAYOUT_STORAGE_KEYS.informationCollapsed]: 'yes',
    })
    const boundedStore = new WorkspaceStore(boundedHarness.bridge, boundedHarness.storage)
    expect(boundedStore.getSnapshot()).toMatchObject({
      navigationWidth: 190,
      informationWidth: 900,
      composerHeight: 360,
      navigationCollapsed: true,
      informationCollapsed: false,
    })

    const invalidHarness = createHarness(async () => initialSessions(), {
      [PANEL_LAYOUT_STORAGE_KEYS.navigationWidth]: 'NaN',
      [PANEL_LAYOUT_STORAGE_KEYS.informationWidth]: '   ',
    })
    const invalidStore = new WorkspaceStore(invalidHarness.bridge, invalidHarness.storage)
    expect(invalidStore.getSnapshot()).toMatchObject({
      navigationWidth: 260,
      informationWidth: 260,
      composerHeight: 112,
    })
  })

  it('localStorage 拒绝访问时仍可读取默认值并更新当前窗口状态', () => {
    const harness = createHarness(async () => initialSessions())
    const unavailableStorage: Pick<Storage, 'getItem' | 'setItem'> = {
      getItem: () => {
        throw new Error('禁止读取')
      },
      setItem: () => {
        throw new Error('禁止写入')
      },
    }
    const store = new WorkspaceStore(harness.bridge, unavailableStorage)

    expect(store.getSnapshot()).toMatchObject({
      navigationWidth: 260,
      informationWidth: 260,
      composerHeight: 112,
      navigationCollapsed: false,
      informationCollapsed: false,
    })
    expect(() => {
      store.toggleNavigation()
      store.resizeNavigation(280)
      store.resizeInformation(320)
      store.resizeComposer(220)
    }).not.toThrow()
    expect(store.getSnapshot()).toMatchObject({
      navigationWidth: 280,
      informationWidth: 320,
      composerHeight: 220,
      navigationCollapsed: false,
    })
  })

  it('可分别恢复默认宽度且不改变当前折叠状态', () => {
    const harness = createHarness(async () => initialSessions())
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    store.resizeNavigation(310)
    store.resizeInformation(400)
    store.resizeComposer(300)
    store.toggleNavigation()

    store.resetPanelWidth('navigation')
    store.resetPanelWidth('information')
    store.resetComposerHeight()

    expect(store.getSnapshot()).toMatchObject({
      navigationWidth: 260,
      informationWidth: 260,
      composerHeight: 112,
      navigationCollapsed: true,
    })
    expect(harness.stored.get(PANEL_LAYOUT_STORAGE_KEYS.navigationWidth)).toBe('260')
    expect(harness.stored.get(PANEL_LAYOUT_STORAGE_KEYS.informationWidth)).toBe('260')
    expect(harness.stored.get(PANEL_LAYOUT_STORAGE_KEYS.composerHeight)).toBe('112')
  })
})

function initialSessions(firstProjections?: Record<string, unknown>): Record<string, unknown> {
  return {
    items: [
      {
        sessionId: '甲-最近',
        updatedAt: 300,
        running: false,
        blank: false,
        cwd: '/work/甲',
        ...(firstProjections === undefined ? {} : { projections: firstProjections }),
      },
      { sessionId: '甲-较早', updatedAt: 250, running: false, blank: false, cwd: '/work/甲' },
      { sessionId: '乙-会话', updatedAt: 200, running: false, blank: false, cwd: '/work/乙' },
      { sessionId: '无项目', updatedAt: 100, running: false, blank: false },
    ],
  }
}

function workspaceBaseline(archivedSessionIds: readonly string[] = []): Record<string, unknown> {
  return {
    items: [
      {
        workspaceId: '工作区-甲',
        path: '/work/甲',
        title: '甲项目',
        sessionIds: ['甲-最近', '甲-较早'],
        createdAt: '2026-08-29T16:00:00.000Z',
        updatedAt: '2026-08-30T01:00:00.000Z',
      },
      {
        workspaceId: '工作区-乙',
        path: '/work/乙',
        title: '乙项目',
        sessionIds: ['乙-会话'],
        createdAt: '2026-08-29T16:00:00.000Z',
        updatedAt: '2026-08-30T01:00:00.000Z',
      },
    ],
    archivedSessionIds: [...archivedSessionIds],
  }
}

function history(sessionId: unknown): Record<string, unknown> {
  return { records: [], sessionId }
}

describe('renderer WorkspaceStore 项目与会话选择', () => {
  it.each(['成功', '失败', '切换项目'])(
    '授权前实体化草稿：%s 时保留最新输入且不发送模型消息',
    async mode => {
      let sessions = initialSessions()
      const barrier = Promise.withResolvers<void>()
      const harness = createHarness(async (operation, payload) => {
        if (operation === 'listSessions') return sessions
        if (operation === 'listWorkspaces') return workspaceBaseline()
        if (operation === 'loadSessionPage') return history(payload.sessionId)
        if (operation === 'createSessionForWorkspace') {
          await barrier.promise
          if (mode === '失败') throw new Error('会话创建失败')
          sessions = {
            items: [
              {
                sessionId: '授权新会话',
                updatedAt: 1000,
                running: false,
                blank: true,
                cwd: '/work/甲',
              },
              ...(sessions.items as unknown[]),
            ],
          }
          return { sessionId: '授权新会话' }
        }
        return { events: [] }
      })
      const store = new WorkspaceStore(harness.bridge, harness.storage)
      await store.initialize()
      store.selectProject(projectIdForCwd('/work/甲'), true)
      store.setNewSessionDraft('点击授权时的草稿')
      const pending = store.ensureComposerSession()
      store.setNewSessionDraft('等待期间继续输入的草稿')
      if (mode === '切换项目') store.selectProject(projectIdForCwd('/work/乙'))
      barrier.resolve()
      expect(await pending).toBe(mode === '成功' ? '授权新会话' : null)
      if (mode === '成功')
        expect(store.getSnapshot().sessionDrafts['授权新会话']).toBe('等待期间继续输入的草稿')
      if (mode === '失败')
        expect(store.getSnapshot().newSessionDraft).toBe('等待期间继续输入的草稿')
      if (mode === '切换项目')
        expect(store.getSnapshot().selectedProjectId).toBe(projectIdForCwd('/work/乙'))
      expect(harness.hostCall.mock.calls.some(([operation]) => operation === 'promptSession')).toBe(
        false,
      )
      store.dispose()
    },
  )

  it('整批应用会话快照，隔离迟到首屏并保留切回标签的已读历史', async () => {
    const events = [
      eventRecord('user/message', 1, 100, { content: [{ type: 'text', text: '历史问题' }] }),
      eventRecord('assistant/message', 2, 200, {
        message: { content: [{ type: 'text', text: '历史回答' }] },
      }),
    ]
    let resolvePage: ((page: unknown) => void) | undefined
    let firstPage = true
    const pendingPage = new Promise(resolve => {
      resolvePage = resolve
    })
    const harness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions') return initialSessions()
      if (operation === 'loadSessionPage' && payload.sessionId === '甲-最近') {
        if (firstPage) {
          firstPage = false
          return pendingPage
        }
        return { events: events.slice(1), hasMore: true }
      }
      if (operation === 'loadSessionPage') return history(payload.sessionId)
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    const initialized = store.initialize()
    await vi.waitFor(() => {
      expect(store.getSnapshot().loadingHistory).toBe(true)
    })
    const changed = vi.fn()
    const unsubscribe = store.subscribe(changed)
    harness.emitSessionFrame({
      type: 'session/snapshot',
      sessionId: '甲-最近',
      events,
      lastSeq: 2,
      hasMore: false,
    })
    expect(changed).toHaveBeenCalledOnce()
    expect(store.getSnapshot().loadingHistory).toBe(false)
    resolvePage?.({ events: [], hasMore: false })
    await initialized
    expect(eventSeqs(store.getSnapshot().history)).toEqual([1, 2])
    store.selectSession('乙-会话')
    await vi.waitFor(() => {
      expect(store.getSnapshot().loadingHistory).toBe(false)
    })
    store.selectSession('甲-最近')
    expect(store.getSnapshot().loadingHistory).toBe(false)
    expect(eventSeqs(store.getSnapshot().history)).toEqual([1, 2])
    await store.refreshSessions()
    expect(eventSeqs(store.getSnapshot().history)).toEqual([1, 2])
    expect(store.getSnapshot().historyHasMore).toBe(false)
    unsubscribe()
    store.dispose()
  })

  it('切换标签统一回到对话，并分别恢复右侧浮岛和草稿', async () => {
    const harness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions') return initialSessions()
      if (operation === 'loadSessionPage') return history(payload.sessionId)
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()

    expect(store.getSnapshot().openedSessionIds).toEqual(['甲-最近'])
    store.setSessionDraft('甲-最近', '保留的草稿')
    store.initializeRightIsland('session-info')
    store.selectRightIsland('git-history')
    store.setView('trajectory')
    store.selectSession('乙-会话')
    expect(store.getSnapshot()).toMatchObject({
      activeView: 'conversation',
      activeRightIslandId: null,
      rightIslandsInitialized: false,
    })
    store.initializeRightIsland('session-info')
    store.selectRightIsland('file-outline-tasks')
    store.setView('files')

    harness.emitHostFrame({ type: 'host/session-status', sessionId: '甲-最近', running: false })
    expect(store.getSnapshot().unreadSessionIds).toEqual([])
    harness.emitHostFrame({ type: 'host/session-status', sessionId: '甲-最近', running: true })
    harness.emitHostFrame({ type: 'host/session-status', sessionId: '甲-最近', running: false })
    harness.emitHostFrame({ type: 'host/session-status', sessionId: '甲-最近', running: false })
    expect(store.getSnapshot().unreadSessionIds).toEqual(['甲-最近'])

    expect(store.getSnapshot().openedSessionIds).toEqual(['甲-最近', '乙-会话'])
    store.moveSessionTab('甲-最近', 1)
    expect(store.getSnapshot()).toMatchObject({
      openedSessionIds: ['乙-会话', '甲-最近'],
      selectedSessionId: '乙-会话',
      activeView: 'files',
      activeRightIslandId: 'file-outline-tasks',
      sessionDrafts: { '甲-最近': '保留的草稿' },
    })
    store.selectSessionTab('甲-最近')
    expect(store.getSnapshot().unreadSessionIds).toEqual([])
    expect(store.getSnapshot()).toMatchObject({
      selectedSessionId: '甲-最近',
      activeView: 'conversation',
      activeRightIslandId: 'git-history',
    })

    store.closeSessionTab('甲-最近')
    expect(store.getSnapshot()).toMatchObject({
      openedSessionIds: ['乙-会话'],
      selectedSessionId: '乙-会话',
      activeView: 'conversation',
      activeRightIslandId: 'file-outline-tasks',
      sessionDrafts: { '甲-最近': '保留的草稿' },
    })

    store.closeSessionTab('乙-会话')
    await store.refreshSessions()
    expect(store.getSnapshot()).toMatchObject({
      openedSessionIds: [],
      selectedSessionId: null,
      activeView: 'conversation',
      activeRightIslandId: null,
      rightIslandsInitialized: false,
      sessionDrafts: { '甲-最近': '保留的草稿' },
    })

    store.selectSession('甲-最近')
    expect(store.getSnapshot()).toMatchObject({
      openedSessionIds: ['甲-最近'],
      selectedSessionId: '甲-最近',
      activeView: 'conversation',
      activeRightIslandId: 'git-history',
      sessionDrafts: { '甲-最近': '保留的草稿' },
    })
    store.dispose()
  })

  it('默认展示全部项目，专注项目后可恢复全部并保留当前会话', async () => {
    const harness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions') return initialSessions()
      if (operation === 'loadSessionPage') return history(payload.sessionId)
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()

    expect(store.getSnapshot()).toMatchObject({
      selectedProjectId: null,
      selectedSessionId: '甲-最近',
    })
    expect(store.focusedProject()).toBeUndefined()
    expect(store.selectedProject()?.id).toBe(projectIdForCwd('/work/甲'))
    expect(store.focusedSessions().map(item => item.sessionId)).toEqual([
      '甲-最近',
      '甲-较早',
      '乙-会话',
      '无项目',
    ])
    expect(harness.stored.get('mydsh:selected-project')).toBe('')

    store.selectProject(projectIdForCwd('/work/乙'))

    expect(store.getSnapshot()).toMatchObject({
      selectedProjectId: projectIdForCwd('/work/乙'),
      selectedSessionId: '乙-会话',
      activeView: 'conversation',
    })
    expect(store.focusedSessions().map(item => item.sessionId)).toEqual(['乙-会话'])
    expect(harness.stored.get('mydsh:selected-project')).toBe(projectIdForCwd('/work/乙'))
    await vi.waitFor(() => {
      expect(harness.hostCall).toHaveBeenCalledWith(
        'loadSessionPage',
        expect.objectContaining({ sessionId: '乙-会话' }),
      )
    })

    store.selectProject(null)

    expect(store.getSnapshot()).toMatchObject({
      selectedProjectId: null,
      selectedSessionId: '乙-会话',
    })
    expect(store.focusedProject()).toBeUndefined()
    expect(store.selectedProject()?.id).toBe(projectIdForCwd('/work/乙'))
    expect(store.focusedSessions()).toHaveLength(4)
    expect(harness.stored.get('mydsh:selected-project')).toBe('')
    store.dispose()
  })

  it('恢复有效的持久化专注项目，非法项目选择则安全恢复全部', async () => {
    const harness = createHarness(
      async (operation, payload) => {
        if (operation === 'listSessions') return initialSessions()
        if (operation === 'loadSessionPage') return history(payload.sessionId)
        throw new Error(`测试未处理 Host 操作：${operation}`)
      },
      {
        'mydsh:selected-project': projectIdForCwd('/work/乙'),
      },
    )
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()

    expect(store.getSnapshot()).toMatchObject({
      selectedProjectId: projectIdForCwd('/work/乙'),
      selectedSessionId: '乙-会话',
    })
    expect(store.focusedProject()?.id).toBe(projectIdForCwd('/work/乙'))
    expect(store.focusedSessions().map(session => session.sessionId)).toEqual(['乙-会话'])

    store.selectProject('project:不存在')

    expect(store.getSnapshot()).toMatchObject({
      selectedProjectId: null,
      selectedSessionId: '乙-会话',
    })
    expect(store.focusedSessions()).toHaveLength(4)
    expect(harness.stored.get('mydsh:selected-project')).toBe('')
    store.dispose()
  })

  it('非法持久化项目默认恢复全部，并把规范化结果写回存储', async () => {
    const harness = createHarness(
      async (operation, payload) => {
        if (operation === 'listSessions') return initialSessions()
        if (operation === 'loadSessionPage') return history(payload.sessionId)
        throw new Error(`测试未处理 Host 操作：${operation}`)
      },
      {
        'mydsh:selected-project': 'project:已经移除',
      },
    )
    const store = new WorkspaceStore(harness.bridge, harness.storage)

    await store.initialize()

    expect(store.getSnapshot().selectedProjectId).toBeNull()
    expect(store.focusedSessions()).toHaveLength(4)
    expect(harness.stored.get('mydsh:selected-project')).toBe('')
    store.dispose()
  })

  it('全部项目状态可跨项目选择任意会话并推断当前项目上下文', async () => {
    const harness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions') return initialSessions()
      if (operation === 'loadSessionPage') return history(payload.sessionId)
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()

    store.selectSession('乙-会话')

    expect(store.getSnapshot()).toMatchObject({
      selectedProjectId: null,
      selectedSessionId: '乙-会话',
    })
    expect(store.focusedProject()).toBeUndefined()
    expect(store.selectedProject()?.id).toBe(projectIdForCwd('/work/乙'))
    await vi.waitFor(() => {
      expect(harness.hostCall).toHaveBeenCalledWith(
        'loadSessionPage',
        expect.objectContaining({ sessionId: '乙-会话' }),
      )
    })
    store.dispose()
  })

  it('Durable Workspace 通过主进程注册表的 opaque id 调用项目服务', async () => {
    const harness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions') return initialSessions()
      if (operation === 'listWorkspaces') return workspaceBaseline()
      if (operation === 'loadSessionPage') return history(payload.sessionId)
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const projectCall = vi.fn(async () => ({ available: true }))
    harness.bridge.projects = {
      list: async () => [
        {
          id: '受信任-甲',
          name: '甲',
          cwd: '/work/甲',
          displayPath: '/work/甲',
          sessionCount: 2,
          lastActivity: 300,
        },
      ],
      call: projectCall,
    }
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()

    await store.callProject('gitSummary')
    await expect(store.revealProject(projectIdForCwd('/work/甲'))).resolves.toBe(true)

    expect(store.selectedProject()?.id).toBe(projectIdForCwd('/work/甲'))
    expect(store.selectedProject()?.projectAccessId).toBe('受信任-甲')
    expect(projectCall).toHaveBeenCalledWith('gitSummary', { projectId: '受信任-甲' })
    expect(projectCall).toHaveBeenCalledWith('revealInFinder', { projectId: '受信任-甲' })
    store.dispose()
  })

  it('项目创建错误交给项目工作区处理，不污染 Composer 全局错误', async () => {
    const harness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions') return initialSessions()
      if (operation === 'listWorkspaces') return workspaceBaseline()
      if (operation === 'loadSessionPage') return history(payload.sessionId)
      if (operation === 'pickWorkspaceDirectory') {
        throw new Error("Error invoking remote method 'dsh-desktop:host:call': Error: 目录选择失败")
      }
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()

    await expect(store.createWorkspace()).rejects.toThrow('目录选择失败')
    expect(store.getSnapshot().error).toBeNull()
    store.dispose()
  })

  it('新增项目先保留新会话草稿，首次发送失败可重试并只在成功时落下真实会话', async () => {
    let sessions = initialSessions()
    let workspaces = workspaceBaseline()
    let rejectSessionCreation = true
    const createdWorkspace = {
      workspaceId: '工作区-新项目',
      path: '/work/新项目',
      title: '新项目',
      sessionIds: [] as string[],
      createdAt: '2026-09-11T06:00:00.000Z',
      updatedAt: '2026-09-11T06:00:00.000Z',
    }
    const harness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions') return sessions
      if (operation === 'listWorkspaces') return workspaces
      if (operation === 'loadSessionPage') return history(payload.sessionId)
      if (operation === 'pickWorkspaceDirectory') return createdWorkspace.path
      if (operation === 'createWorkspace') {
        workspaces = {
          items: [...(workspaces.items as unknown[]), createdWorkspace],
          archivedSessionIds: [],
        }
        return { ['workspace']: createdWorkspace, created: true }
      }
      if (operation === 'createSessionForWorkspace') {
        if (rejectSessionCreation) throw new Error('会话创建失败')
        sessions = {
          items: [
            {
              sessionId: '新项目-会话',
              updatedAt: 500,
              running: false,
              blank: true,
              cwd: createdWorkspace.path,
            },
            ...(sessions.items as unknown[]),
          ],
        }
        const workspaceItems = [...(workspaces.items as Array<Record<string, unknown>>)]
        const workspaceIndex = workspaceItems.findIndex(
          workspace => workspace.workspaceId === createdWorkspace.workspaceId,
        )
        workspaceItems[workspaceIndex] = {
          ...workspaceItems[workspaceIndex],
          sessionIds: ['新项目-会话'],
        }
        workspaces = { ...workspaces, items: workspaceItems }
        return { sessionId: '新项目-会话' }
      }
      if (operation === 'promptSession') return { accepted: true }
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()

    await expect(store.createWorkspace()).resolves.toBe(true)

    const projectId = projectIdForCwd(createdWorkspace.path)
    expect(store.getSnapshot()).toMatchObject({
      selectedProjectId: projectId,
      selectedSessionId: null,
      newSessionProjectId: projectId,
      newSessionDraft: '',
    })
    expect(store.focusedSessions()).toHaveLength(0)
    expect(harness.hostCall).not.toHaveBeenCalledWith(
      'createSessionForWorkspace',
      expect.anything(),
    )

    store.setNewSessionDraft('第一条消息')
    await expect(store.sendMessage('第一条消息')).resolves.toBe(false)
    expect(store.getSnapshot()).toMatchObject({
      selectedSessionId: null,
      newSessionProjectId: projectId,
      newSessionDraft: '第一条消息',
      creatingSession: false,
      error: '会话创建失败',
    })
    expect(harness.hostCall).not.toHaveBeenCalledWith('promptSession', expect.anything())

    rejectSessionCreation = false
    store.setNewSessionDraft('第一条消息')
    harness.hostCall.mockClear()
    await expect(store.sendMessage('第一条消息')).resolves.toBe(true)

    const operations = harness.hostCall.mock.calls.map(([operation]) => operation)
    expect(operations.filter(operation => operation === 'createSessionForWorkspace')).toHaveLength(
      1,
    )
    expect(operations.filter(operation => operation === 'promptSession')).toHaveLength(1)
    expect(operations.indexOf('createSessionForWorkspace')).toBeLessThan(
      operations.indexOf('promptSession'),
    )
    expect(harness.hostCall).toHaveBeenCalledWith('createSessionForWorkspace', {
      workspaceId: createdWorkspace.workspaceId,
    })
    expect(harness.hostCall).toHaveBeenCalledWith(
      'promptSession',
      expect.objectContaining({
        sessionId: '新项目-会话',
        mode: 'queue',
        content: [{ type: 'text', text: '第一条消息' }],
      }),
    )
    expect(store.getSnapshot()).toMatchObject({
      selectedProjectId: projectId,
      selectedSessionId: '新项目-会话',
      newSessionProjectId: null,
      newSessionDraft: '',
      creatingSession: false,
      error: null,
    })
    expect(store.getSnapshot().sessionDrafts['新项目-会话']).toBeUndefined()
    store.dispose()
  })

  it('全部项目选择可跨实例持久化', async () => {
    const firstHarness = createHarness(
      async (operation, payload) => {
        if (operation === 'listSessions') return initialSessions()
        if (operation === 'loadSessionPage') return history(payload.sessionId)
        throw new Error(`测试未处理 Host 操作：${operation}`)
      },
      {
        'mydsh:selected-project': projectIdForCwd('/work/乙'),
      },
    )
    const firstStore = new WorkspaceStore(firstHarness.bridge, firstHarness.storage)
    await firstStore.initialize()
    firstStore.selectProject('')

    const secondStore = new WorkspaceStore(firstHarness.bridge, firstHarness.storage)
    await secondStore.initialize()

    expect(secondStore.getSnapshot()).toMatchObject({
      selectedProjectId: null,
      selectedSessionId: '甲-最近',
    })
    expect(secondStore.focusedSessions()).toHaveLength(4)
    expect(firstHarness.stored.get('mydsh:selected-project')).toBe('')
    firstStore.dispose()
    secondStore.dispose()
  })

  it('新建聊天时向 Host 传递当前选择项目的 cwd，并选中新会话', async () => {
    let sessions = initialSessions()
    let listReads = 0
    let resolveOlderList!: (value: unknown) => void
    const olderList = new Promise<unknown>(resolve => {
      resolveOlderList = resolve
    })
    const harness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions') {
        listReads += 1
        return listReads === 2 ? olderList : sessions
      }
      if (operation === 'loadSessionPage') return history(payload.sessionId)
      if (operation === 'createSession') {
        sessions = {
          items: [
            { sessionId: '甲-新建', updatedAt: 400, running: false, blank: true, cwd: '/work/甲' },
            ...(sessions.items as unknown[]),
          ],
        }
        return { sessionId: '甲-新建' }
      }
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()
    expect(harness.hostCall).toHaveBeenCalledWith('loadSessionPage', {
      sessionId: '甲-最近',
      throughSeq: 0,
      maxMessages: 25,
    })
    harness.hostCall.mockClear()

    const refreshing = store.refreshSessions()
    await vi.waitFor(() => {
      expect(listReads).toBe(2)
    })
    const creating = store.createSession()
    for (let index = 0; index < 20; index += 1) {
      harness.emitHostFrame({ type: 'host/workspace-order-changed', workspaceIds: [] })
    }
    resolveOlderList(initialSessions())
    await Promise.all([refreshing, creating])
    expect(listReads).toBe(3)

    expect(harness.hostCall).toHaveBeenCalledWith('createSession', { cwd: '/work/甲' })
    expect(store.getSnapshot()).toMatchObject({
      selectedProjectId: null,
      selectedSessionId: '甲-新建',
      creatingSession: false,
    })
    expect(store.focusedSessions().map(item => item.sessionId)).toContain('甲-新建')
    store.dispose()

    let durableSessions = initialSessions()
    let durableWorkspaces = workspaceBaseline()
    const durableHarness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions') return durableSessions
      if (operation === 'listWorkspaces') return durableWorkspaces
      if (operation === 'loadSessionPage') return history(payload.sessionId)
      if (operation === 'createSessionForWorkspace') {
        durableSessions = {
          items: [
            { sessionId: '乙-新建', updatedAt: 410, running: false, blank: true, cwd: '/work/乙' },
            ...(durableSessions.items as unknown[]),
          ],
        }
        const baseline = workspaceBaseline()
        for (const workspace of baseline.items as Array<Record<string, unknown>>) {
          if (workspace.workspaceId === '工作区-乙') {
            workspace.sessionIds = ['乙-新建', '乙-会话']
          }
        }
        durableWorkspaces = baseline
        return { sessionId: '乙-新建', agentPreset: 'standard' }
      }
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const durableStore = new WorkspaceStore(durableHarness.bridge, durableHarness.storage)
    await durableStore.initialize()
    durableHarness.hostCall.mockClear()

    await durableStore.createSession(projectIdForCwd('/work/乙'))

    expect(durableHarness.hostCall).toHaveBeenCalledWith('createSessionForWorkspace', {
      workspaceId: '工作区-乙',
    })
    expect(durableStore.getSnapshot().selectedSessionId).toBe('乙-新建')
    durableStore.dispose()
  })

  it('当前会话没有项目上下文时允许不带 cwd 新建聊天', async () => {
    let sessions = initialSessions()
    const harness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions') return sessions
      if (operation === 'loadSessionPage') return history(payload.sessionId)
      if (operation === 'createSession') {
        expect(payload).toEqual({})
        sessions = {
          items: [
            { sessionId: '无项目-新建', updatedAt: 500, running: false, blank: true },
            ...(sessions.items as unknown[]),
          ],
        }
        return { sessionId: '无项目-新建' }
      }
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()
    store.selectSession('无项目')
    expect(store.selectedProject()).toBeUndefined()
    harness.hostCall.mockClear()

    await store.createSession()

    expect(harness.hostCall).toHaveBeenCalledWith('createSession', {})
    expect(store.getSnapshot()).toMatchObject({
      selectedProjectId: null,
      selectedSessionId: '无项目-新建',
      creatingSession: false,
    })
    store.dispose()
  })

  it('会话重命名、分叉和 Durable Workspace 排序都由 Host 权威结果收口', async () => {
    let sessions = initialSessions()
    let workspaces = workspaceBaseline()
    const replaceWorkspaceSessions = (sessionIds: readonly string[]) => {
      const items = workspaces.items as Array<Record<string, unknown>>
      const index = items.findIndex(workspace => workspace.workspaceId === '工作区-甲')
      const workspace = { ...items[index], sessionIds: [...sessionIds] }
      const nextItems = [...items]
      nextItems[index] = workspace
      workspaces = {
        ...workspaces,
        items: nextItems,
      }
      return workspace
    }
    const harness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions') return sessions
      if (operation === 'listWorkspaces') return workspaces
      if (operation === 'loadSessionPage') return history(payload.sessionId)
      if (operation === 'renameSession') return { title: '固定标题', seq: 21 }
      if (operation === 'forkSession') {
        sessions = {
          items: [
            { sessionId: '甲-分叉', updatedAt: 410, running: false, blank: false, cwd: '/work/甲' },
            ...(sessions.items as unknown[]),
          ],
        }
        replaceWorkspaceSessions(['甲-分叉', '甲-最近', '甲-较早'])
        return { sessionId: '甲-分叉', workspaceAttachFailed: false }
      }
      if (operation === 'reorderWorkspaceSession') {
        return {
          ['workspace']: replaceWorkspaceSessions(['甲-较早', '甲-分叉', '甲-最近']),
        }
      }
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()

    await expect(store.renameSession('甲-最近', '  固定标题  ')).resolves.toBe(true)
    expect(store.selectedSession()).toMatchObject({
      sessionId: '甲-最近',
      projections: { values: { title: '固定标题' } },
    })
    expect(harness.hostCall).toHaveBeenCalledWith('renameSession', {
      sessionId: '甲-最近',
      title: '  固定标题  ',
    })

    await expect(store.forkSession('甲-最近')).resolves.toBe(true)
    expect(store.getSnapshot().selectedSessionId).toBe('甲-分叉')
    expect(store.getSnapshot().sessions.map(session => session.sessionId)).toContain('甲-分叉')

    await expect(
      store.reorderWorkspaceSession(projectIdForCwd('/work/甲'), '甲-较早', '甲-分叉'),
    ).resolves.toBe(true)
    expect(harness.hostCall).toHaveBeenCalledWith('reorderWorkspaceSession', {
      workspaceId: '工作区-甲',
      sessionId: '甲-较早',
      beforeSessionId: '甲-分叉',
    })
    expect(
      store.getSnapshot().projects.find(project => project.id === projectIdForCwd('/work/甲')),
    ).toMatchObject({ sessionIds: ['甲-较早', '甲-分叉', '甲-最近'] })
    store.dispose()
  })
})

describe('renderer WorkspaceStore 消息提交', () => {
  it('选择图片后只提交无路径的公开 prompt 字段，并可在成功后清理当前附件', async () => {
    const attachment = {
      name: '界面.png',
      mediaType: 'image/png' as const,
      base64: 'aW1hZ2U=',
      bytes: 5,
    }
    const harness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions') return initialSessions()
      if (operation === 'loadSessionPage') return history(payload.sessionId)
      if (operation === 'promptSession') return { accepted: true }
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    harness.bridge.attachments = {
      chooseImages: async () => [attachment],
      importImages: async () => [attachment],
    }
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()
    harness.hostCall.mockClear()

    await expect(store.chooseSessionAttachments()).resolves.toBe(true)
    const submittedAttachments = store.getSnapshot().sessionAttachments['甲-最近']
    await expect(store.sendMessage('  请检查项目  ')).resolves.toBe(true)

    expect(harness.hostCall).toHaveBeenCalledWith('promptSession', {
      sessionId: '甲-最近',
      mode: 'queue',
      content: [
        { type: 'text', text: '请检查项目' },
        { type: 'image', mediaType: 'image/png', data: 'aW1hZ2U=', name: '界面.png' },
      ],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
    expect(store.getSnapshot()).toMatchObject({
      sendingMessage: false,
      awaitingResponseSessionIds: ['甲-最近'],
      error: null,
    })
    expect(submittedAttachments).toEqual([attachment])
    store.clearSessionAttachments('甲-最近', submittedAttachments)
    expect(store.getSnapshot().sessionAttachments['甲-最近']).toBeUndefined()
    store.dispose()
  })

  it('Host 拒绝消息时把错误写入可见 state', async () => {
    const harness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions') return initialSessions()
      if (operation === 'loadSessionPage') return history(payload.sessionId)
      if (operation === 'promptSession') throw new Error('Host 暂时无法接收消息')
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()

    await expect(store.sendMessage('继续')).resolves.toBe(false)
    expect(store.getSnapshot()).toMatchObject({
      sendingMessage: false,
      error: 'Host 暂时无法接收消息',
    })
    store.dispose()
  })

  it('消息 RPC 在途时切换会话，不让旧会话成功响应清空新会话历史', async () => {
    let resolvePrompt: ((value: unknown) => void) | undefined
    const promptResponse = new Promise<unknown>(resolve => {
      resolvePrompt = resolve
    })
    const harness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions') return initialSessions()
      if (operation === 'loadSessionPage') return history(payload.sessionId)
      if (operation === 'promptSession') return promptResponse
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()

    const sending = store.sendMessage('给甲会话的消息')
    await vi.waitFor(() => {
      expect(harness.hostCall).toHaveBeenCalledWith(
        'promptSession',
        expect.objectContaining({
          sessionId: '甲-最近',
        }),
      )
    })
    store.selectSession('乙-会话')
    await vi.waitFor(() => {
      expect(store.getSnapshot().history).toMatchObject({ sessionId: '乙-会话' })
    })
    resolvePrompt?.({ accepted: true })

    await expect(sending).resolves.toBe(true)
    expect(store.getSnapshot()).toMatchObject({
      selectedSessionId: '乙-会话',
      loadingHistory: false,
      history: { sessionId: '乙-会话' },
    })
    store.dispose()
  })

  it('消息接纳后的等待状态持续到 Host 确认运行，并在运行结束后保持收敛', async () => {
    const harness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions') return initialSessions()
      if (operation === 'loadSessionPage') return history(payload.sessionId)
      if (operation === 'promptSession') return { accepted: true }
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()

    await expect(store.sendMessage('开始处理')).resolves.toBe(true)
    expect(store.getSnapshot().awaitingResponseSessionIds).toEqual(['甲-最近'])

    harness.emitSessionFrame({
      type: 'session/event',
      sessionId: '甲-最近',
      event: eventRecord('turn/start', 100, 100, { turn: 1 }),
    })
    expect(store.getSnapshot().awaitingResponseSessionIds).toEqual(['甲-最近'])
    harness.emitHostFrame({ type: 'host/session-status', sessionId: '甲-最近', running: false })
    expect(store.getSnapshot().awaitingResponseSessionIds).toEqual(['甲-最近'])

    harness.emitSessionFrame({
      type: 'session/event',
      sessionId: '甲-最近',
      event: eventRecord('turn/end', 101, 101, { turn: 0 }),
    })
    expect(store.getSnapshot().awaitingResponseSessionIds).toEqual(['甲-最近'])

    harness.emitHostFrame({ type: 'host/session-status', sessionId: '甲-最近', running: true })
    expect(store.getSnapshot().awaitingResponseSessionIds).toEqual([])
    expect(store.selectedSession()?.running).toBe(true)

    harness.emitHostFrame({ type: 'host/session-status', sessionId: '甲-最近', running: false })
    expect(store.getSnapshot().awaitingResponseSessionIds).toEqual([])
    expect(store.selectedSession()?.running).toBe(false)
    store.dispose()
  })

  it('Host 状态未到时仅以对应新轮次的结束事件收起等待', async () => {
    const harness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions') return initialSessions()
      if (operation === 'loadSessionPage') return history(payload.sessionId)
      if (operation === 'promptSession') return { accepted: true }
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()
    await store.sendMessage('开始处理')
    harness.emitSessionFrame({
      type: 'session/event',
      sessionId: '甲-最近',
      event: eventRecord('turn/end', 100, 100, { turn: 1 }),
    })
    expect(store.getSnapshot().awaitingResponseSessionIds).toEqual(['甲-最近'])
    harness.emitSessionFrame({
      type: 'session/event',
      sessionId: '甲-最近',
      event: eventRecord('turn/start', 101, 101, { turn: 2 }),
    })
    harness.emitSessionFrame({
      type: 'session/event',
      sessionId: '甲-最近',
      event: eventRecord('turn/end', 102, 102, { turn: 2 }),
    })
    expect(store.getSnapshot().awaitingResponseSessionIds).toEqual([])
    store.dispose()
  })
})

const sessionModelCatalogFixture = {
  default: { provider: '官方', model: 'flash', reasoningEffort: 'high' },
  routableProviders: ['官方'],
  groups: [
    {
      id: '官方',
      name: '官方模型',
      models: [
        {
          id: 'flash',
          name: 'Flash',
          reasoning: {
            efforts: [
              { id: 'high', name: '高' },
              { id: 'max', name: '最大' },
            ],
            defaultEffort: 'high',
          },
        },
      ],
    },
  ],
  failures: [],
}

// 会话投影只发布当前值；可选预设来自进程级权限目录（listPermissionPresets）。
const permissionFixture = { currentValue: 'workspace-write' }
const permissionCatalogFixture = {
  options: [
    { value: 'workspace-write', name: 'workspace-write', description: '工作区写入' },
    { value: 'danger-full-access', name: 'danger-full-access', description: '完整访问' },
  ],
}

describe('renderer WorkspaceStore 会话模型与权限控制', () => {
  it('组合模型目录与 Session 投影，并接受新序号投影和 Host 选择结果', async () => {
    const harness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions')
        return initialSessions({
          asOfSeq: 4,
          values: {
            modelSelection: {
              lastUsed: null,
              next: { provider: '官方', model: 'flash', reasoningEffort: 'high' },
            },
          },
        })
      if (operation === 'loadSessionPage') return history(payload.sessionId)
      if (operation === 'getSessionModels') return sessionModelCatalogFixture
      if (operation === 'selectSessionModel') {
        return {
          selected: {
            provider: payload.provider,
            model: payload.model,
            reasoningEffort: payload.reasoningEffort,
          },
        }
      }
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()

    await expect(store.loadSessionModels()).resolves.toBe(true)
    expect(store.getSnapshot().sessionModels).toEqual({
      ...sessionModelCatalogFixture,
      current: { provider: '官方', model: 'flash', reasoningEffort: 'high' },
      routable: true,
    })
    harness.emitSessionFrame({
      type: 'session/model-selection',
      sessionId: '甲-最近',
      seq: 6,
      value: { next: { provider: '官方', model: 'flash', reasoningEffort: 'max' } },
    })
    harness.emitSessionFrame({
      type: 'session/model-selection',
      sessionId: '甲-最近',
      seq: 5,
      value: { next: { provider: '官方', model: 'flash', reasoningEffort: 'high' } },
    })
    await store.refreshSessions()
    expect(store.getSnapshot().sessionModels?.current.reasoningEffort).toBe('max')
    harness.emitHostFrame({ type: 'host/session-status', sessionId: '甲-最近', running: true })
    await expect(
      store.selectSessionModel({
        provider: '官方',
        model: 'flash',
        reasoningEffort: 'high',
      }),
    ).resolves.toBe(true)

    expect(harness.hostCall).toHaveBeenCalledWith('selectSessionModel', {
      sessionId: '甲-最近',
      provider: '官方',
      model: 'flash',
      reasoningEffort: 'high',
    })
    expect(store.getSnapshot().sessionModels?.current).toEqual({
      provider: '官方',
      model: 'flash',
      reasoningEffort: 'high',
    })
    store.selectSession('乙-会话')
    harness.emitSessionFrame({
      type: 'session/model-selection',
      sessionId: '甲-最近',
      seq: 7,
      value: { next: { provider: '官方', model: 'flash', reasoningEffort: 'max' } },
    })
    expect(store.sessionSnapshot('甲-最近').sessionModels?.current.reasoningEffort).toBe('max')
    store.selectSessionTab('甲-最近')
    await store.loadSessionModels()
    expect(store.getSnapshot().sessionModels?.current.reasoningEffort).toBe('max')
    store.dispose()
  })

  it('仅以 routable 阻塞发送，不要求 current 必须仍在目录中', async () => {
    let promptCount = 0
    const harness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions')
        return initialSessions({
          asOfSeq: 3,
          values: {
            modelSelection: {
              lastUsed: null,
              next: { provider: '仍可路由', model: '目录外模型' },
            },
          },
        })
      if (operation === 'loadSessionPage') return history(payload.sessionId)
      if (operation === 'getSessionModels')
        return {
          ...sessionModelCatalogFixture,
          routableProviders: ['官方', '仍可路由'],
          groups: [],
        }
      if (operation === 'promptSession') {
        promptCount += 1
        return { accepted: true }
      }
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()
    await store.loadSessionModels()

    await expect(store.sendMessage('仍然允许发送')).resolves.toBe(true)
    expect(promptCount).toBe(1)

    const unavailableHarness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions')
        return initialSessions({
          asOfSeq: 3,
          values: {
            modelSelection: {
              lastUsed: null,
              next: { provider: '仍可路由', model: '目录外模型' },
            },
          },
        })
      if (operation === 'loadSessionPage') return history(payload.sessionId)
      if (operation === 'getSessionModels') return sessionModelCatalogFixture
      if (operation === 'promptSession') throw new Error('不可调用')
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const unavailableStore = new WorkspaceStore(
      unavailableHarness.bridge,
      unavailableHarness.storage,
    )
    await unavailableStore.initialize()
    await unavailableStore.loadSessionModels()

    await expect(unavailableStore.sendMessage('不应发送')).resolves.toBe(false)
    expect(unavailableHarness.hostCall).not.toHaveBeenCalledWith('promptSession', expect.anything())
    store.dispose()
    unavailableStore.dispose()
  })

  it('从尾页投影读取权限，通过公开命令切换，并接受更高序号的实时投影', async () => {
    const harness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions') return initialSessions()
      if (operation === 'loadSessionPage')
        return {
          ...history(payload.sessionId),
          projections: { asOfSeq: 2, values: { permissions: permissionFixture } },
        }
      if (operation === 'listPermissionPresets') return permissionCatalogFixture
      if (operation === 'selectPermissionPreset') {
        return {
          commandId: '命令-1',
          result: { kind: 'success', text: `preset ${String(payload.preset)}` },
        }
      }
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()

    // 目录未到之前不合成可选列表：只有当前值不足以显示可切换的权限。
    expect(store.getSnapshot().sessionPermission).toBeNull()
    await expect(store.loadPermissionCatalog()).resolves.toBe(true)
    expect(store.getSnapshot().sessionPermission).toMatchObject({
      currentValue: 'workspace-write',
      options: [
        { value: 'workspace-write', selectable: true },
        { value: 'danger-full-access', selectable: true },
      ],
    })
    harness.emitHostFrame({ type: 'host/session-status', sessionId: '甲-最近', running: true })
    await expect(store.selectPermissionPreset('danger-full-access')).resolves.toBe(true)
    expect(harness.hostCall).toHaveBeenCalledWith('selectPermissionPreset', {
      sessionId: '甲-最近',
      preset: 'danger-full-access',
    })
    expect(store.getSnapshot().sessionPermission?.currentValue).toBe('workspace-write')

    harness.emitSessionFrame({
      type: 'session/permissions',
      sessionId: '甲-最近',
      seq: 4,
      value: { ...permissionFixture, currentValue: 'danger-full-access' },
    })
    expect(store.getSnapshot().sessionPermission?.currentValue).toBe('danger-full-access')

    harness.emitSessionFrame({
      type: 'session/permissions',
      sessionId: '甲-最近',
      seq: 6,
      value: { ...permissionFixture, currentValue: 'workspace-write' },
    })
    expect(store.getSnapshot().sessionPermission?.currentValue).toBe('workspace-write')
    harness.emitSessionFrame({
      type: 'session/permissions',
      sessionId: '甲-最近',
      seq: 5,
      value: { ...permissionFixture, currentValue: 'danger-full-access' },
    })
    expect(store.getSnapshot().sessionPermission?.currentValue).toBe('workspace-write')
    harness.emitSessionFrame({
      type: 'session/event',
      sessionId: '甲-最近',
      event: { type: 'permission/preset', seq: 5, time: 5, data: { preset: 'danger-full-access' } },
    })
    expect(store.getSnapshot().sessionPermission?.currentValue).toBe('workspace-write')
    harness.emitSessionFrame({
      type: 'session/event',
      sessionId: '甲-最近',
      event: { type: 'permission/preset', seq: 7, time: 7, data: { preset: 'read-only' } },
    })
    expect(store.getSnapshot().sessionPermission?.currentValue).toBe('read-only')
    const pending = store.selectPermissionPreset('danger-full-access')
    store.selectSession('乙-会话')
    harness.emitSessionFrame({
      type: 'session/permissions',
      sessionId: '甲-最近',
      seq: 8,
      value: { currentValue: 'danger-full-access' },
    })
    await expect(pending).resolves.toBe(true)
    expect(store.getSnapshot().selectedSessionId).toBe('乙-会话')
    expect(store.sessionSnapshot('甲-最近').sessionPermission?.currentValue).toBe(
      'danger-full-access',
    )
    store.selectSessionTab('甲-最近')
    expect(store.getSnapshot().sessionPermission?.currentValue).toBe('danger-full-access')
    store.dispose()
  })

  it('权限目录在流重置后重新读取，旧请求与卸载后的结果不能回写', async () => {
    const catalogs: ((value: unknown) => void)[] = []
    const harness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions') return initialSessions()
      if (operation === 'loadSessionPage')
        return {
          ...history(payload.sessionId),
          projections: { asOfSeq: 2, values: { permissions: permissionFixture } },
        }
      if (operation === 'listPermissionPresets')
        return new Promise(resolve => {
          catalogs.push(resolve)
        })
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()
    const old = store.loadPermissionCatalog()
    harness.emitSessionFrame({ type: 'session/stream-reset' })
    await store.refreshSessions()
    harness.emitSessionFrame({
      type: 'session/permissions',
      sessionId: '甲-最近',
      seq: 10,
      value: { currentValue: 'read-only' },
    })
    expect(catalogs).toHaveLength(2)
    catalogs[1]?.({ options: [{ value: 'read-only', name: 'read-only' }] })
    await vi.waitFor(() => {
      expect(store.getSnapshot().sessionPermission?.currentValue).toBe('read-only')
    })
    catalogs[0]?.(permissionCatalogFixture)
    await expect(old).resolves.toBe(false)
    expect(store.getSnapshot().permissionCatalog?.map(option => option.value)).toEqual([
      'read-only',
    ])
    const late = store.loadPermissionCatalog(true)
    store.dispose()
    catalogs[2]?.(permissionCatalogFixture)
    await expect(late).resolves.toBe(false)
    expect(store.getSnapshot().permissionCatalog).toBeNull()
    expect(store.getSnapshot().sessionPermission).toBeNull()
  })

  it('权限命令业务错误不会伪造成功状态', async () => {
    const harness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions') return initialSessions()
      if (operation === 'loadSessionPage')
        return {
          ...history(payload.sessionId),
          projections: { asOfSeq: 2, values: { permissions: permissionFixture } },
        }
      if (operation === 'listPermissionPresets') return permissionCatalogFixture
      if (operation === 'selectPermissionPreset') {
        return { commandId: '命令-失败', result: { kind: 'error', text: '当前状态拒绝切换' } }
      }
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()
    await store.loadPermissionCatalog()

    await expect(store.selectPermissionPreset('danger-full-access')).resolves.toBe(false)
    expect(store.getSnapshot()).toMatchObject({
      error: '当前状态拒绝切换',
      switchingPermissionPreset: false,
      sessionPermission: { currentValue: 'workspace-write' },
    })
    store.dispose()
  })
})

describe('renderer WorkspaceStore 实时会话与队列', () => {
  it('背景生成流失去结算时仅重建该会话，保留另一聊天的历史、队列和审批', async () => {
    const harness = createHarness(async (operation, payload) =>
      operation === 'listSessions'
        ? initialSessions()
        : operation === 'loadSessionPage'
          ? history(payload.sessionId)
          : {},
    )
    const follows: Array<{ receive: (value: unknown) => void; dispose: ReturnType<typeof vi.fn> }> =
      []
    vi.spyOn(harness.bridge.remote, 'follow').mockImplementation((_endpoint, _args, receive) => {
      const dispose = vi.fn()
      follows.push({ receive, dispose })
      return dispose
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()
    store.selectSession('甲-较早')
    store.selectSession('甲-最近')
    harness.emitSessionFrame({
      type: 'session/queue',
      sessionId: '甲-最近',
      queue: queueSnapshot([queuedMessage('队列-1', '稍后处理')]),
    })
    harness.emitSessionFrame({
      type: 'session/interaction-requested',
      sessionId: '甲-最近',
      interaction: {
        kind: 'approval',
        key: 'approval:1',
        approvalId: '审批-1',
        toolName: 'Bash',
      },
    })
    const stop = store.observeSession('甲-较早')
    const baseline = (seq: number) => ({
      type: 'snapshot',
      header: { id: '甲-较早' },
      cursor: seq,
      records: [{ type: 'event', event: eventRecord('turn/start', seq, seq, { turn: 1 }) }],
      hasMore: false,
      projections: { asOfSeq: seq, values: {} },
    })
    follows[0]!.receive(baseline(1))
    await vi.waitFor(() => {
      expect(store.sessionSnapshot('甲-较早').loadingHistory).toBe(false)
    })
    const focusedHistory = store.getSnapshot().history
    follows[0]!.receive({
      type: 'assistant-stream',
      frame: {
        type: 'start',
        attemptId: '尝试-1',
        revision: 1,
        startedAfterSeq: 1,
        turn: 1,
        step: 0,
      },
    })
    follows[0]!.receive({
      type: 'assistant-stream',
      frame: {
        type: 'end',
        attemptId: '尝试-1',
        revision: 2,
        index: 0,
        outcome: { kind: 'abandoned' },
      },
    })
    await vi.waitFor(() => {
      expect(follows).toHaveLength(2)
    })
    expect(follows[0]!.dispose).toHaveBeenCalledOnce()
    follows[0]!.receive(baseline(99))
    follows[1]!.receive(baseline(2))
    await vi.waitFor(() => {
      expect(store.sessionSnapshot('甲-较早').history).toMatchObject({
        events: [{ seq: 1 }, { seq: 2 }],
      })
    })
    expect(store.getSnapshot().history).toBe(focusedHistory)
    expect(store.getSnapshot().sessionQueue.items.map(item => item.id)).toEqual(['队列-1'])
    expect(store.getSnapshot().pendingInteractions.map(item => item.key)).toEqual(['approval:1'])
    stop()
    expect(follows[1]!.dispose).toHaveBeenCalledOnce()
    store.dispose()
  })

  it('按会话保存待回答交互，重放去重，并等待 Host resolved 帧收口', async () => {
    const harness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions') return initialSessions()
      if (operation === 'loadSessionPage') return history(payload.sessionId)
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const respond = vi
      .fn()
      .mockResolvedValueOnce({ accepted: false as const, reason: 'in-flight' as const })
      .mockResolvedValueOnce({ accepted: true as const })
    harness.bridge.interactions = { respond }
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()

    const questionFrame: DesktopSessionFrame = {
      type: 'session/interaction-requested',
      sessionId: '甲-最近',
      interaction: {
        kind: 'question',
        key: 'question:rpc-1',
        questions: [{ id: 'city', question: '查询哪个城市？' }],
      },
    }
    harness.emitSessionFrame(questionFrame)
    harness.emitSessionFrame(questionFrame)
    harness.emitSessionFrame({
      type: 'session/interaction-requested',
      sessionId: '乙-会话',
      interaction: {
        kind: 'approval',
        key: 'approval:rpc-2',
        approvalId: '审批-2',
        toolName: 'Bash',
      },
    })
    expect(store.getSnapshot().pendingInteractions.map(item => item.key)).toEqual([
      'question:rpc-1',
    ])

    store.selectSession('乙-会话')
    expect(store.getSnapshot().pendingInteractions.map(item => item.key)).toEqual([
      'approval:rpc-2',
    ])
    store.selectSession('甲-最近')
    await expect(
      store.respondPendingInteraction({
        kind: 'question',
        sessionId: '甲-最近',
        key: 'question:rpc-1',
        answers: [{ id: 'city', selected: [], custom: '北京' }],
      }),
    ).resolves.toEqual({ accepted: false, reason: 'in-flight' })
    expect(store.getSnapshot().pendingInteractions.map(item => item.key)).toEqual([
      'question:rpc-1',
    ])
    await expect(
      store.respondPendingInteraction({
        kind: 'question',
        sessionId: '甲-最近',
        key: 'question:rpc-1',
        answers: [{ id: 'city', selected: [], custom: '北京' }],
      }),
    ).resolves.toEqual({ accepted: true })
    expect(store.getSnapshot().pendingInteractions).toHaveLength(1)

    harness.emitSessionFrame({
      type: 'session/interaction-resolved',
      sessionId: '甲-最近',
      resolution: { kind: 'question', key: 'question:rpc-1', outcome: 'answered' },
    })
    expect(store.getSnapshot().pendingInteractions).toEqual([])
    store.dispose()
  })

  it('用最新 session/queue 帧完整替换队列，并在断线或重新订阅时清空旧状态', async () => {
    const harness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions') return initialSessions()
      if (operation === 'loadSessionPage') return history(payload.sessionId)
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()

    harness.emitSessionFrame({
      type: 'session/queue',
      sessionId: '甲-最近',
      queue: queueSnapshot([queuedMessage('排队-1', '第一条')]),
    })
    expect(store.getSnapshot().sessionQueue.items.map(item => item.id)).toEqual(['排队-1'])

    harness.emitSessionFrame({
      type: 'session/queue',
      sessionId: '甲-最近',
      queue: queueSnapshot([queuedMessage('排队-2', '后来一条')]),
    })
    expect(store.getSnapshot().sessionQueue).toEqual(
      queueSnapshot([queuedMessage('排队-2', '后来一条')]),
    )

    harness.emitSessionFrame({ type: 'session/stream-reset' })
    expect(store.getSnapshot().sessionQueue).toEqual(queueSnapshot([]))

    harness.emitSessionFrame({
      type: 'session/queue',
      sessionId: '甲-最近',
      queue: queueSnapshot([queuedMessage('排队-3', '重连前')]),
    })

    harness.emitHostStatus({ kind: 'unavailable', message: 'Host 正在重启' })
    expect(store.getSnapshot().sessionQueue).toEqual(queueSnapshot([]))

    harness.emitSessionFrame({
      type: 'session/subscribed',
      sessionId: '甲-最近',
      lastSeq: 1,
    })
    expect(store.getSnapshot().sessionQueue).toEqual(queueSnapshot([]))
    store.dispose()
  })

  it('实时追加当前会话事件并按 seq 去重，不用 turn 事件猜测 Host 运行状态', async () => {
    const harness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions') return initialSessions()
      if (operation === 'loadSessionPage') {
        return {
          events: [
            eventRecord('user/message', 1, 100, { content: [{ type: 'text', text: '已有消息' }] }),
          ],
          sessionId: payload.sessionId,
        }
      }
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()

    harness.emitSessionFrame({
      type: 'session/event',
      sessionId: '甲-最近',
      event: eventRecord('turn/start', 2, 200, { turn: 1 }),
    })
    expect(store.selectedSession()?.running).toBe(false)
    expect(store.getSnapshot().liveEvents.map(item => item.seq)).toEqual([2])

    harness.emitSessionFrame({
      type: 'session/event',
      sessionId: '甲-最近',
      event: eventRecord('turn/start', 2, 200, { turn: 1 }),
    })
    harness.emitSessionFrame({
      type: 'session/event',
      sessionId: '甲-最近',
      event: eventRecord('assistant/chunk', 2.5, 225, {
        turn: 1,
        step: 0,
        chunk: { type: 'text-delta', index: 0, text: '实时' },
      }),
    })
    expect(store.getSnapshot().liveEvents.map(item => item.seq)).toEqual([2, 2.5])
    harness.emitSessionFrame({
      type: 'session/event',
      sessionId: '甲-最近',
      event: eventRecord('assistant/message', 3, 250, {
        turn: 1,
        step: 0,
        message: { content: [{ type: 'text', text: '实时回复' }] },
      }),
    })
    expect(store.getSnapshot().liveEvents.map(item => item.seq)).toEqual([2, 3])
    harness.hostCall.mockClear()
    store.selectSession('甲-最近')
    expect(harness.hostCall).not.toHaveBeenCalled()
    expect(store.getSnapshot().liveEvents.map(item => item.seq)).toEqual([2, 3])

    harness.emitSessionFrame({
      type: 'session/event',
      sessionId: '甲-最近',
      event: eventRecord('turn/end', 4, 300, { turn: 1 }),
    })
    expect(store.selectedSession()).toMatchObject({ running: false, updatedAt: 300 })
    expect(store.getSnapshot().liveEvents.map(item => item.seq)).toEqual([2, 3, 4])
    store.dispose()
  })

  it('分片合并到动画帧发布，输入和最终消息立即发布，销毁时取消待发布帧', async () => {
    const harness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions') return initialSessions()
      if (operation === 'loadSessionPage') return history(payload.sessionId)
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()
    let publish: FrameRequestCallback | undefined
    const request = vi.fn((callback: FrameRequestCallback) => {
      publish = callback
      return 1
    })
    const cancel = vi.fn(() => {
      publish = undefined
    })
    vi.stubGlobal('requestAnimationFrame', request)
    vi.stubGlobal('cancelAnimationFrame', cancel)
    const notified = vi.fn()
    store.subscribe(notified)
    const chunk = (seq: number) =>
      harness.emitSessionFrame({
        type: 'session/event',
        sessionId: '甲-最近',
        event: eventRecord('assistant/chunk', seq, seq * 100, {
          turn: 1,
          step: 0,
          chunk: { type: 'text-delta', index: 0, text: '实时' },
        }),
      })
    try {
      chunk(2)
      chunk(3)
      expect(request).toHaveBeenCalledTimes(1)
      expect(notified).not.toHaveBeenCalled()
      expect(store.getSnapshot().liveEvents.map(item => item.seq)).toEqual([2, 3])
      publish?.(0)
      expect(notified).toHaveBeenCalledTimes(1)
      chunk(4)
      store.setSessionDraft('甲-最近', '继续输入')
      expect(notified).toHaveBeenCalledTimes(2)
      expect(publish).toBeUndefined()
      chunk(5)
      harness.emitSessionFrame({
        type: 'session/event',
        sessionId: '甲-最近',
        event: eventRecord('assistant/message', 6, 600, {
          turn: 1,
          step: 0,
          message: { content: [{ type: 'text', text: '完整回复' }] },
        }),
      })
      expect(notified).toHaveBeenCalledTimes(3)
      expect(store.getSnapshot().liveEvents.map(item => item.seq)).toEqual([6])
      expect(publish).toBeUndefined()
      chunk(7)
    } finally {
      store.dispose()
      vi.unstubAllGlobals()
    }
    expect(cancel).toHaveBeenCalledTimes(3)
    expect(publish).toBeUndefined()
  })

  it('以 Host 状态流为运行中权威，并在 detach 时清理瞬态队列', async () => {
    const harness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions') return initialSessions()
      if (operation === 'loadSessionPage') return history(payload.sessionId)
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()
    harness.emitSessionFrame({
      type: 'session/queue',
      sessionId: '甲-最近',
      queue: queueSnapshot([queuedMessage('排队项', '继续处理')]),
    })

    harness.emitHostFrame({
      type: 'host/session-status',
      sessionId: '甲-最近',
      running: true,
    })
    expect(store.selectedSession()).toMatchObject({ running: true, blank: false })

    harness.emitHostFrame({
      type: 'host/session-status',
      sessionId: '甲-最近',
      running: false,
    })
    expect(store.selectedSession()?.running).toBe(false)
    expect(store.getSnapshot().sessionQueue.totalCount).toBe(1)

    harness.emitHostFrame({ type: 'host/session-removed', sessionId: '甲-最近' })
    expect(store.selectedSession()?.running).toBe(false)
    expect(store.getSnapshot().sessionQueue).toEqual(queueSnapshot([]))
    store.dispose()
  })

  it('编辑、移除和插入当前轮都调用 Host 的 updateSessionQueue，并传递真实会话与条目 ID', async () => {
    const harness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions') return initialSessions()
      if (operation === 'loadSessionPage') return history(payload.sessionId)
      if (operation === 'updateSessionQueue') return { accepted: true }
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()
    harness.emitSessionFrame({
      type: 'session/queue',
      sessionId: '甲-最近',
      queue: queueSnapshot([
        queuedMessage('待编辑', '旧内容'),
        queuedMessage('待移除', '移除我'),
        queuedMessage('待插入', '现在处理'),
      ]),
    })
    harness.hostCall.mockClear()

    await expect(
      store.updateSessionQueue('待编辑', {
        kind: 'edit',
        content: [{ type: 'text', text: '新内容' }],
      }),
    ).resolves.toBe(true)
    await expect(store.updateSessionQueue('待移除', { kind: 'remove' })).resolves.toBe(true)
    await expect(store.updateSessionQueue('待插入', { kind: 'steer' })).resolves.toBe(true)

    expect(harness.hostCall).toHaveBeenNthCalledWith(1, 'updateSessionQueue', {
      sessionId: '甲-最近',
      itemId: '待编辑',
      action: { kind: 'edit', content: [{ type: 'text', text: '新内容' }] },
    })
    expect(harness.hostCall).toHaveBeenNthCalledWith(2, 'updateSessionQueue', {
      sessionId: '甲-最近',
      itemId: '待移除',
      action: { kind: 'remove' },
    })
    expect(harness.hostCall).toHaveBeenNthCalledWith(3, 'updateSessionQueue', {
      sessionId: '甲-最近',
      itemId: '待插入',
      action: { kind: 'steer' },
    })
    expect(store.getSnapshot().sessionQueue).toEqual(
      queueSnapshot([
        queuedMessage('待编辑', '新内容'),
        queuedMessage('待插入', '现在处理', 'steering'),
      ]),
    )
    expect(store.getSnapshot().queueUpdatingIds).toEqual([])
    store.dispose()
  })

  it('拒绝编辑只读队列项，避免把裁剪预览提交回 Host', async () => {
    const harness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions') return initialSessions()
      if (operation === 'loadSessionPage') return history(payload.sessionId)
      if (operation === 'updateSessionQueue') return { accepted: true }
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()
    harness.emitSessionFrame({
      type: 'session/queue',
      sessionId: '甲-最近',
      queue: queueSnapshot([
        {
          id: '超长项',
          placement: 'queued',
          preview: '只读预览',
          previewTruncated: true,
          edit: { kind: 'read-only', reason: 'text-too-large' },
        },
      ]),
    })
    harness.hostCall.mockClear()

    await expect(
      store.updateSessionQueue('超长项', {
        kind: 'edit',
        content: [{ type: 'text', text: '错误覆盖' }],
      }),
    ).resolves.toBe(false)
    expect(harness.hostCall).not.toHaveBeenCalled()
    expect(store.getSnapshot().sessionQueue.items[0]?.edit).toEqual({
      kind: 'read-only',
      reason: 'text-too-large',
    })
    store.dispose()
  })
})

describe('renderer WorkspaceStore 会话归档基线与动作', () => {
  it('按 workspace/follow 隐藏归档会话，恢复后回到原项目且不抢当前选择', async () => {
    let archivedSessionIds = ['甲-较早']
    const harness = createHarness(
      async (operation, payload) => {
        if (operation === 'listSessions') return initialSessions()
        if (operation === 'listWorkspaces') return workspaceBaseline(archivedSessionIds)
        if (operation === 'archiveSession') {
          archivedSessionIds = [...new Set([...archivedSessionIds, String(payload.sessionId)])]
          return { archivedSessionIds }
        }
        if (operation === 'unarchiveSession') {
          archivedSessionIds = archivedSessionIds.filter(id => id !== payload.sessionId)
          return { archivedSessionIds }
        }
        if (operation === 'loadSessionPage') return history(payload.sessionId)
        throw new Error(`测试未处理 Host 操作：${operation}`)
      },
      {
        [PINNED_SESSION_IDS_STORAGE_KEY]: JSON.stringify(['甲-最近', '已经失效']),
      },
    )
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()

    expect(store.getSnapshot()).toMatchObject({
      sessionArchiveCapability: 'available',
      archivedSessionIds: ['甲-较早'],
      pinnedSessionIds: ['甲-最近'],
      selectedSessionId: '甲-最近',
    })
    expect(store.getSnapshot().sessions.map(session => session.sessionId)).toEqual([
      '甲-最近',
      '乙-会话',
      '无项目',
    ])

    await expect(store.archiveSession('甲-最近')).resolves.toBe(true)

    expect(harness.hostCall).toHaveBeenCalledWith('archiveSession', { sessionId: '甲-最近' })
    expect(store.getSnapshot()).toMatchObject({
      archivedSessionIds: ['甲-较早', '甲-最近'],
      pinnedSessionIds: [],
      archivingSessionIds: [],
      selectedSessionId: '乙-会话',
    })
    expect(store.getSnapshot().sessions.map(session => session.sessionId)).toEqual([
      '乙-会话',
      '无项目',
    ])
    expect(harness.stored.get(PINNED_SESSION_IDS_STORAGE_KEY)).toBe('[]')
    expect(store.getSnapshot().archivedSessions.map(session => session.sessionId)).toEqual([
      '甲-最近',
      '甲-较早',
    ])
    await expect(store.unarchiveSession('甲-最近')).resolves.toBe(true)
    expect(harness.hostCall).toHaveBeenCalledWith('unarchiveSession', { sessionId: '甲-最近' })
    expect(store.getSnapshot().archivedSessions.map(session => session.sessionId)).toEqual([
      '甲-较早',
    ])
    expect(store.getSnapshot().sessions.map(session => session.sessionId)).toContain('甲-最近')
    expect(
      store.getSnapshot().workspaces.find(workspace => workspace.workspaceId === '工作区-甲')
        ?.sessionIds,
    ).toContain('甲-最近')
    expect(store.getSnapshot()).toMatchObject({
      selectedSessionId: '乙-会话',
      archivingSessionIds: [],
    })
    store.dispose()
  })

  it('置顶是本机持久化视图偏好，不发送 Host 动作且重建 WorkspaceStore 后仍可恢复', async () => {
    const harness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions') return initialSessions()
      if (operation === 'listWorkspaces') return workspaceBaseline()
      if (operation === 'loadSessionPage') return history(payload.sessionId)
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()
    harness.hostCall.mockClear()

    store.togglePinnedSession('乙-会话')
    store.togglePinnedSession('甲-最近')

    expect(store.getSnapshot().pinnedSessionIds).toEqual(['甲-最近', '乙-会话'])
    expect(harness.stored.get(PINNED_SESSION_IDS_STORAGE_KEY)).toBe(
      JSON.stringify(['甲-最近', '乙-会话']),
    )
    expect(harness.hostCall).not.toHaveBeenCalled()
    store.dispose()

    const restoredStore = new WorkspaceStore(harness.bridge, harness.storage)
    await restoredStore.initialize()
    expect(restoredStore.getSnapshot().pinnedSessionIds).toEqual(['甲-最近', '乙-会话'])

    restoredStore.togglePinnedSession('甲-最近')
    expect(restoredStore.getSnapshot().pinnedSessionIds).toEqual(['乙-会话'])
    expect(harness.stored.get(PINNED_SESSION_IDS_STORAGE_KEY)).toBe(JSON.stringify(['乙-会话']))
    restoredStore.dispose()
  })

  it('以归档实时全集覆盖旧基线，能力不可用时不发送假动作', async () => {
    let archivedSessionIds: string[] = []
    const harness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions') return initialSessions()
      if (operation === 'listWorkspaces') return workspaceBaseline(archivedSessionIds)
      if (operation === 'loadSessionPage') return history(payload.sessionId)
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()

    archivedSessionIds = ['甲-最近', '甲-较早']
    harness.emitHostFrame({
      type: 'host/archived-sessions-changed',
      archivedSessionIds,
    })
    await vi.waitFor(() => {
      expect(store.getSnapshot().sessions.map(session => session.sessionId)).toEqual([
        '乙-会话',
        '无项目',
      ])
    })
    expect(store.getSnapshot()).toMatchObject({
      sessionArchiveCapability: 'available',
      archivedSessionIds,
      selectedSessionId: '乙-会话',
    })
    store.dispose()

    const unavailableHarness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions') return initialSessions()
      if (operation === 'listWorkspaces') throw new Error('当前 Host 不支持 Workspace')
      if (operation === 'loadSessionPage') return history(payload.sessionId)
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const unavailableStore = new WorkspaceStore(
      unavailableHarness.bridge,
      unavailableHarness.storage,
    )
    await unavailableStore.initialize()
    unavailableHarness.hostCall.mockClear()

    await expect(unavailableStore.archiveSession('甲-最近')).resolves.toBe(false)
    expect(unavailableStore.getSnapshot().sessionArchiveCapability).toBe('unavailable')
    expect(unavailableHarness.hostCall).not.toHaveBeenCalled()
    unavailableStore.dispose()
  })

  it('物理流重建后清除旧归档集合，并忽略旧 Host 迟到的归档响应', async () => {
    let resolveArchive!: (value: unknown) => void
    const pendingArchive = new Promise<unknown>(resolve => {
      resolveArchive = resolve
    })
    let workspaceAvailable = true
    const harness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions') return initialSessions()
      if (operation === 'listWorkspaces') {
        if (!workspaceAvailable) throw new Error('新 Host 未提供 Workspace 能力')
        return workspaceBaseline(['甲-较早'])
      }
      if (operation === 'archiveSession') return pendingArchive
      if (operation === 'loadSessionPage') return history(payload.sessionId)
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()

    const oldArchive = store.archiveSession('甲-最近')
    await vi.waitFor(() => {
      expect(store.getSnapshot().archivingSessionIds).toEqual(['甲-最近'])
    })

    workspaceAvailable = false
    harness.emitSessionFrame({ type: 'session/stream-reset' })
    await vi.waitFor(() => {
      expect(store.getSnapshot()).toMatchObject({
        sessionArchiveCapability: 'unavailable',
        archivedSessionIds: [],
        archivingSessionIds: [],
      })
    })
    expect(store.getSnapshot().sessions.map(session => session.sessionId)).toEqual([
      '甲-最近',
      '甲-较早',
      '乙-会话',
      '无项目',
    ])

    resolveArchive({ archivedSessionIds: ['甲-较早', '甲-最近'] })
    await expect(oldArchive).resolves.toBe(false)
    expect(store.getSnapshot()).toMatchObject({
      sessionArchiveCapability: 'unavailable',
      archivedSessionIds: [],
      archivingSessionIds: [],
    })
    expect(store.getSnapshot().sessions.map(session => session.sessionId)).toContain('甲-最近')
    store.dispose()
  })

  it('归档后的列表刷新仍在飞行时断线，不允许旧基线回填新连接状态', async () => {
    let resolveSessionList!: (value: unknown) => void
    const pendingSessionList = new Promise<unknown>(resolve => {
      resolveSessionList = resolve
    })
    let sessionListCalls = 0
    const harness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions') {
        sessionListCalls += 1
        return sessionListCalls === 1 ? initialSessions() : pendingSessionList
      }
      if (operation === 'listWorkspaces') {
        return workspaceBaseline(sessionListCalls === 1 ? [] : ['甲-最近'])
      }
      if (operation === 'archiveSession') return { archivedSessionIds: ['甲-最近'] }
      if (operation === 'loadSessionPage') return history(payload.sessionId)
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()

    const archive = store.archiveSession('甲-最近')
    await vi.waitFor(() => {
      expect(sessionListCalls).toBe(2)
      expect(store.getSnapshot().archivedSessionIds).toEqual(['甲-最近'])
    })

    harness.emitHostStatus({ kind: 'unavailable', message: 'Host 连接已中断' })
    expect(store.getSnapshot()).toMatchObject({
      hostStatus: { kind: 'unavailable' },
      sessionArchiveCapability: 'checking',
      archivedSessionIds: [],
      loadingSessions: false,
    })

    resolveSessionList(initialSessions())
    await expect(archive).resolves.toBe(false)
    expect(store.getSnapshot()).toMatchObject({
      sessionArchiveCapability: 'checking',
      archivedSessionIds: [],
      loadingSessions: false,
    })
    expect(store.getSnapshot().sessions.map(session => session.sessionId)).toContain('甲-最近')
    store.dispose()
  })
})

describe('renderer WorkspaceStore 会话历史分页', () => {
  it('向前加载更早历史时按 seq 合并去重，并沿用更早页的 hasMore', async () => {
    const harness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions') return initialSessions()
      if (operation === 'loadSessionPage' && payload.beforeSeq === 3) {
        return {
          records: [
            eventRecord('user/message', 1, 100, { content: [{ type: 'text', text: '最早' }] }),
            eventRecord('assistant/message', 2, 200, {
              message: { content: [{ type: 'text', text: '较早' }] },
            }),
            eventRecord('user/message', 3, 300, { content: [{ type: 'text', text: '重叠项' }] }),
          ],
          hasMore: false,
        }
      }
      if (operation === 'loadSessionPage') {
        return {
          records: [
            eventRecord('user/message', 3, 300, {
              content: [{ type: 'text', text: '当前页重叠项' }],
            }),
            eventRecord('assistant/message', 4, 400, {
              message: { content: [{ type: 'text', text: '最新' }] },
            }),
          ],
          hasMore: true,
          sessionId: payload.sessionId,
        }
      }
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()
    harness.hostCall.mockClear()

    await expect(store.loadOlderHistory()).resolves.toBe(true)

    expect(harness.hostCall).toHaveBeenCalledWith('loadSessionPage', {
      sessionId: '甲-最近',
      throughSeq: 2,
      beforeSeq: 3,
      maxMessages: 25,
    })
    expect(eventSeqs(store.getSnapshot().history)).toEqual([1, 2, 3, 4])
    expect(store.getSnapshot()).toMatchObject({
      historyHasMore: false,
      loadingOlderHistory: false,
    })
    store.dispose()
  })

  it('更早页没有前移序号时停止自动分页', async () => {
    const harness = createHarness(async operation => {
      if (operation === 'listSessions') return initialSessions()
      if (operation === 'loadSessionPage') {
        return {
          events: [
            eventRecord('user/message', 3, 300, {
              content: [{ type: 'text', text: '重叠项' }],
            }),
          ],
          hasMore: true,
        }
      }
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()
    const before = eventSeqs(store.getSnapshot().history)

    await expect(store.loadOlderHistory()).resolves.toBe(false)

    expect(eventSeqs(store.getSnapshot().history)).toEqual(before)
    expect(store.getSnapshot()).toMatchObject({
      historyHasMore: false,
      loadingOlderHistory: false,
    })
    store.dispose()
  })

  it('拒绝把不连续的更早历史页拼到当前窗口前面', async () => {
    const harness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions') return initialSessions()
      if (operation === 'loadSessionPage' && payload.beforeSeq === 3) {
        return {
          events: [
            eventRecord('user/message', 1, 100, {
              content: [{ type: 'text', text: '缺口之前的消息' }],
            }),
          ],
          hasMore: true,
        }
      }
      if (operation === 'loadSessionPage') {
        return {
          events: [
            eventRecord('user/message', 3, 300, {
              content: [{ type: 'text', text: '当前页开头' }],
            }),
            eventRecord('assistant/message', 4, 400, {
              message: { content: [{ type: 'text', text: '最新' }] },
            }),
          ],
          hasMore: true,
          sessionId: payload.sessionId,
        }
      }
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()
    const before = eventSeqs(store.getSnapshot().history)

    await expect(store.loadOlderHistory()).resolves.toBe(false)

    expect(eventSeqs(store.getSnapshot().history)).toEqual(before)
    expect(store.getSnapshot()).toMatchObject({
      historyHasMore: true,
      loadingOlderHistory: false,
      historyError: '更早历史页与当前会话窗口不连续，请重试加载。',
    })
    store.dispose()
  })

  it('切换会话后隔离尚未返回的旧会话分页响应', async () => {
    let resolveOlder: ((value: unknown) => void) | undefined
    const olderResponse = new Promise<unknown>(resolve => {
      resolveOlder = resolve
    })
    const harness = createHarness(async (operation, payload) => {
      if (operation === 'listSessions') return initialSessions()
      if (operation === 'loadSessionPage' && payload.beforeSeq === 3) return olderResponse
      if (operation === 'loadSessionPage' && payload.sessionId === '乙-会话') {
        return {
          events: [
            eventRecord('assistant/message', 20, 2_000, {
              message: { content: [{ type: 'text', text: '乙会话内容' }] },
            }),
          ],
          hasMore: false,
        }
      }
      if (operation === 'loadSessionPage') {
        return {
          events: [
            eventRecord('user/message', 3, 300, {
              content: [{ type: 'text', text: '甲会话内容' }],
            }),
          ],
          hasMore: true,
        }
      }
      throw new Error(`测试未处理 Host 操作：${operation}`)
    })
    const store = new WorkspaceStore(harness.bridge, harness.storage)
    await store.initialize()

    const loadingOlder = store.loadOlderHistory()
    store.selectSession('乙-会话')
    await vi.waitFor(() => {
      expect(eventSeqs(store.getSnapshot().history)).toEqual([20])
    })
    resolveOlder?.({
      events: [
        eventRecord('user/message', 1, 100, { content: [{ type: 'text', text: '过期内容' }] }),
      ],
      hasMore: false,
    })

    await expect(loadingOlder).resolves.toBe(false)
    expect(store.getSnapshot()).toMatchObject({
      selectedSessionId: '乙-会话',
      historyHasMore: false,
    })
    expect(eventSeqs(store.getSnapshot().history)).toEqual([20])
    store.dispose()
  })
})

it('文件或终端在前台时关闭后台聊天标签不会抢走内容，返回对话可重新打开', async () => {
  const harness = createHarness(async (operation, payload) => {
    if (operation === 'listSessions') return initialSessions()
    if (operation === 'loadSessionPage') return history(payload.sessionId)
    throw new Error(`测试未处理 Host 操作：${operation}`)
  })
  const store = new WorkspaceStore(harness.bridge, harness.storage)
  await store.initialize()
  const id = store.getSnapshot().selectedSessionId!
  store.setView('files')
  store.closeSessionTab(id)
  expect(store.getSnapshot().activeView).toBe('files')
  expect(store.getSnapshot().selectedSessionId).toBe(id)
  expect(store.getSnapshot().openedSessionIds).not.toContain(id)
  store.setView('conversation')
  expect(store.getSnapshot().openedSessionIds).toContain(id)
  store.setView('terminal')
  store.selectSessionTab(id)
  expect(store.getSnapshot().activeView).toBe('conversation')
  store.dispose()
})

const LeftStub = () => null

it('切换顶部工作标签保持左侧 navigationView 不变，仅侧栏切换更新且整页模式离开后自动恢复', async () => {
  const harness = createHarness(async (operation, payload) => {
    if (operation === 'listSessions') return initialSessions()
    if (operation === 'loadSessionPage') return history(payload.sessionId)
    throw new Error(`测试未处理 Host 操作：${operation}`)
  })
  const store = new WorkspaceStore(harness.bridge, harness.storage)
  await store.initialize()
  store.configureModes([
    { id: 'conversation', mainIslandId: 'conversation', sessionHome: true, left: LeftStub },
    { id: 'files', mainIslandId: 'files', left: LeftStub },
    { id: 'changes', mainIslandId: 'changes', left: LeftStub },
    {
      id: 'connections',
      mainIslandId: 'connections',
      left: LeftStub,
      collapsePanelsOnEnter: 'right',
    },
    { id: 'database', mainIslandId: 'connections', left: LeftStub, collapsePanelsOnEnter: 'right' },
    { id: 'terminal', mainIslandId: 'terminal' },
    { id: 'browser', mainIslandId: 'browser' },
    { id: 'plugins', mainIslandId: 'plugins', left: LeftStub, collapsePanelsOnEnter: true },
  ])
  const sessionId = store.getSnapshot().selectedSessionId!
  expect(store.getSnapshot().navigationView).toBe('conversation')

  // 顶部切换/打开终端、浏览器、文件、变更、SSH 与会话标签均不改变左侧导航视图。
  for (const view of ['browser', 'terminal', 'files', 'changes', 'connections'] as const) {
    store.setView(view)
    expect(store.getSnapshot().activeView).toBe(view)
    expect(store.getSnapshot().navigationView).toBe('conversation')
  }
  store.selectSessionTab(sessionId)
  expect(store.getSnapshot().activeView).toBe('conversation')
  expect(store.getSnapshot().navigationView).toBe('conversation')

  // 左侧模式栏显式传入 syncNavigation: true 才切换左侧导航视图。
  store.setView('files', { syncNavigation: true })
  expect(store.getSnapshot()).toMatchObject({ activeView: 'files', navigationView: 'files' })
  store.setView('browser')
  expect(store.getSnapshot()).toMatchObject({ activeView: 'browser', navigationView: 'files' })
  store.setView('terminal', { syncNavigation: true })
  expect(store.getSnapshot()).toMatchObject({ activeView: 'terminal', navigationView: 'files' })

  // 进入整页模式（plugins）不覆写 navigationView；离开切回顶部标签后保留原左侧导航。
  store.setView('plugins', { syncNavigation: true })
  expect(store.getSnapshot()).toMatchObject({
    activeView: 'plugins',
    navigationView: 'files',
    navigationCollapsed: true,
  })
  store.selectSessionTab(sessionId)
  expect(store.getSnapshot()).toMatchObject({
    activeView: 'conversation',
    navigationView: 'files',
    navigationCollapsed: false,
  })

  // 已加载模式变化导致原 navigationView 失效时，可通过 setNavigationView 回退。
  store.setNavigationView('conversation')
  expect(store.getSnapshot().navigationView).toBe('conversation')
  store.dispose()
})

it('停止请求去重，失败后允许重试且不移除排队消息', async () => {
  const first = Promise.withResolvers<unknown>()
  let attempts = 0
  const harness = createHarness(async (operation, payload) => {
    if (operation === 'listSessions') return initialSessions()
    if (operation === 'loadSessionPage') return history(payload.sessionId)
    if (operation === 'cancelSession') {
      attempts += 1
      return attempts === 1 ? first.promise : { accepted: true }
    }
    throw new Error(`测试未处理 Host 操作：${operation}`)
  })
  const store = new WorkspaceStore(harness.bridge, harness.storage)
  await store.initialize()
  const stopping = store.cancelSession()
  await store.cancelSession()
  expect(attempts).toBe(1)
  first.reject(new Error('停止请求未送达'))
  await stopping
  expect(store.getSnapshot().error).toBe('停止请求未送达')
  await store.cancelSession()
  expect(attempts).toBe(2)
  expect(
    harness.hostCall.mock.calls.some(([operation]) => operation === 'updateSessionQueue'),
  ).toBe(false)
  store.dispose()
})

function eventRecord(type: string, seq: number, time: number, data: unknown) {
  return { type, seq, time, data }
}

function eventSeqs(historyValue: unknown): number[] {
  if (typeof historyValue !== 'object' || historyValue === null || !('events' in historyValue))
    return []
  const events = (historyValue as { events?: unknown }).events
  return Array.isArray(events)
    ? events.flatMap(item =>
        typeof item === 'object' && item !== null && 'seq' in item && typeof item.seq === 'number'
          ? [item.seq]
          : [],
      )
    : []
}
