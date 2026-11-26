/**
 * 左侧导航面板与工作模式工具栏解耦测试：验证切换顶部终端/浏览器标签时不改变左侧栏内容与高亮，
 * 以及整页模式（plugins）离开后自动恢复先前的左侧导航视图。
 */
// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ConfigProvider } from 'antd'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkspaceStore } from '../src/renderer/src/models/workspace/store.ts'
import type {
  DesktopBridge,
  DesktopSettings,
  HostStatus,
} from '../src/renderer/src/platform/contracts.ts'
import { LeftPanel } from '../src/renderer/src/pages/workspace/components/leftpanel/index.tsx'
import { UiRuntimeContext } from '../src/renderer/src/plugins/react.tsx'
import { UiRuntime } from '../src/renderer/src/plugins/registry.ts'
import { useSyncExternalStore } from 'react'

const mockState = vi.hoisted(() => ({
  store: null as WorkspaceStore | null,
  focus: vi.fn(),
  selectSsh: vi.fn(),
  selectProject: vi.fn(),
}))

vi.mock('../src/renderer/src/hooks/useWorkspace.ts', () => ({
  useWorkspaceStore: () => {
    if (mockState.store === null) throw new Error('测试未初始化 WorkspaceStore')
    return mockState.store
  },
  useWorkspaceSnapshot: () => {
    const store = mockState.store
    if (store === null) throw new Error('测试未初始化 WorkspaceStore')
    return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  },
}))

vi.mock('../src/renderer/src/features/project-workspace/ProjectWorkspaceProvider.tsx', () => ({
  useProjectWorkspace: () => ({ selectProject: mockState.selectProject }),
}))

vi.mock('../src/renderer/src/features/workspace-tabs/WorkspaceTabsProvider.tsx', () => ({
  useWorkspaceTabs: () => ({
    focus: mockState.focus,
    sshGroup: { select: mockState.selectSsh },
  }),
}))

const defaultSettings: DesktopSettings = {
  version: 7,
  revision: 0,
  colorScheme: 'dark',
  canvasColorScheme: 'follow-interface',
  fontFamily: 'system',
  fontSize: 12,
  editorFontSize: 13,
  editorLineHeight: 'standard',
  editorLigatures: false,
  islandGap: 8,
  accentColor: '#5b6cff',
  canvasTransparency: 0.32,
  contentScrimOpacity: 0.16,
  backgrounds: { canvas: null, sidebar: null, content: null },
}

const readyHost: HostStatus = {
  kind: 'ready',
  ownership: 'external',
  identity: { reportedVersion: '测试版本' },
}

function createStore(): WorkspaceStore {
  const bridge: DesktopBridge = {
    version: 11,
    remote: {
      call: async () => ({}),
      cancelCall: async () => {},
      follow: () => () => {},
    },
    setPluginBusyReasons: async () => {},
    getFrontendPlugins: async () => [],
    onFrontendPluginsChanged: () => () => undefined,
    host: {
      status: async () => readyHost,
      call: async () => ({ items: [] }),
      onStatusChanged: () => () => undefined,
      onSessionFrame: () => () => undefined,
      onHostFrame: () => () => undefined,
    },
    settings: {
      read: async () => defaultSettings,
      update: async patch => ({ ...defaultSettings, ...patch }),
      chooseBackground: async () => null,
      applyBackground: async () => defaultSettings,
      cancelBackground: async () => undefined,
      clearBackground: async () => defaultSettings,
      onChanged: () => () => undefined,
      onOpenRequested: () => () => undefined,
    },
  }
  const storage = new Map<string, string>()
  return new WorkspaceStore(bridge, {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => {
      storage.set(key, value)
    },
  })
}

const StubIcon = () => <span aria-hidden="true">icon</span>
const ConversationSidebar = () => <div data-testid="sidebar-conversation">对话侧栏</div>
const FilesSidebar = () => <div data-testid="sidebar-files">文件侧栏</div>
const PluginsSidebar = () => <div data-testid="sidebar-plugins">插件侧栏</div>

async function createRuntime(): Promise<UiRuntime> {
  const runtime = new UiRuntime()
  await runtime.install('test.modes', {
    inject: ['mydshSlots'],
    apply(ctx) {
      ctx.mydshSlots.registerMode({
        id: 'conversation',
        label: '对话',
        icon: StubIcon,
        mainIslandId: 'conversation',
        left: ConversationSidebar,
        sessionHome: true,
        order: 1,
      })
      ctx.mydshSlots.registerMode({
        id: 'files',
        label: '项目文件',
        icon: StubIcon,
        mainIslandId: 'files',
        left: FilesSidebar,
        order: 2,
      })
      ctx.mydshSlots.registerMode({
        id: 'terminal',
        label: '终端',
        icon: StubIcon,
        mainIslandId: 'terminal',
        order: 3,
      })
      ctx.mydshSlots.registerMode({
        id: 'browser',
        label: '浏览器',
        icon: StubIcon,
        mainIslandId: 'browser',
        order: 4,
      })
      ctx.mydshSlots.registerMode({
        id: 'plugins',
        label: '插件',
        icon: StubIcon,
        mainIslandId: 'plugins',
        left: PluginsSidebar,
        collapsePanelsOnEnter: true,
        order: 5,
      })
    },
  })
  return runtime
}

beforeEach(() => {
  mockState.focus.mockReset()
  mockState.selectSsh.mockReset()
  mockState.selectProject.mockReset()
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    })),
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  cleanup()
  mockState.store?.dispose()
  mockState.store = null
  vi.unstubAllGlobals()
})

describe('左侧导航面板与模式栏解耦', () => {
  it('切到终端或浏览器工作标签时左侧保持原侧栏内容与高亮不为空', async () => {
    const store = createStore()
    const runtime = await createRuntime()
    mockState.store = store
    const modes = runtime.slots.core.winners('modes').map(entry => entry.component) as Parameters<
      WorkspaceStore['configureModes']
    >[0]
    store.configureModes(modes)

    try {
      render(
        <ConfigProvider theme={{ token: { motion: false } }}>
          <UiRuntimeContext.Provider value={runtime}>
            <LeftPanel searchTrigger={null} />
          </UiRuntimeContext.Provider>
        </ConfigProvider>,
      )

      expect(screen.getByTestId('sidebar-conversation')).toBeTruthy()
      expect(
        document.querySelector('[data-view="conversation"]')?.getAttribute('aria-current'),
      ).toBe('page')

      act(() => {
        store.setView('browser')
      })
      expect(screen.getByTestId('sidebar-conversation')).toBeTruthy()
      expect(screen.queryByTestId('sidebar-files')).toBeNull()
      expect(
        document.querySelector('[data-view="conversation"]')?.getAttribute('aria-current'),
      ).toBe('page')

      act(() => {
        store.setView('terminal')
      })
      expect(screen.getByTestId('sidebar-conversation')).toBeTruthy()
      expect(screen.queryByTestId('sidebar-files')).toBeNull()
      expect(
        document.querySelector('[data-view="conversation"]')?.getAttribute('aria-current'),
      ).toBe('page')

      // 点击左侧模式栏切换到文件视图，随后再切到浏览器标签仍留在文件侧栏。
      fireEvent.click(document.querySelector('[data-view="files"]')!)
      expect(screen.getByTestId('sidebar-files')).toBeTruthy()
      expect(document.querySelector('[data-view="files"]')?.getAttribute('aria-current')).toBe(
        'page',
      )

      act(() => {
        store.setView('browser')
      })
      expect(screen.getByTestId('sidebar-files')).toBeTruthy()
      expect(document.querySelector('[data-view="files"]')?.getAttribute('aria-current')).toBe(
        'page',
      )

      // 进入整页插件管理时高亮插件图标且不覆写 navigationView；离开切到浏览器时恢复文件高亮。
      fireEvent.click(document.querySelector('[data-view="plugins"]')!)
      expect(document.querySelector('[data-view="plugins"]')?.getAttribute('aria-current')).toBe(
        'page',
      )
      expect(store.getSnapshot().navigationView).toBe('files')

      act(() => {
        store.setView('browser')
      })
      expect(screen.getByTestId('sidebar-files')).toBeTruthy()
      expect(document.querySelector('[data-view="files"]')?.getAttribute('aria-current')).toBe(
        'page',
      )
    } finally {
      await runtime.dispose()
    }
  })
})
