// @vitest-environment jsdom

import { Provider } from '@umijs/max'
import useWorkspaceModel from '../src/renderer/src/models/workspace.ts'

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useWorkspaceSnapshot, useWorkspaceStore } from '../src/renderer/src/hooks/useWorkspace.ts'
import { AppearanceSystem } from '../src/renderer/src/features/appearance/appearance-system.tsx'
import { PluginManager } from '../src/renderer/src/features/plugins/PluginManager.tsx'
import { useSettingsCenter } from '../src/renderer/src/features/settings/useSettingsCenter.ts'
import { ChatGPTSettings } from '../src/renderer/src/features/settings/ChatGPTSettings.tsx'
import { SettingsDialog } from '../src/renderer/src/features/settings/SettingsDialog.tsx'
import type { DesktopHostFrame } from '../src/shared/host-live.ts'
import type {
  DesktopBridge,
  DesktopSettings,
  HostStatus,
} from '../src/renderer/src/platform/contracts.ts'

const desktopSettings: DesktopSettings = {
  version: 7,
  revision: 0,
  colorScheme: 'system',
  canvasColorScheme: 'follow-interface',
  fontFamily: 'system',
  fontSize: 12,
  editorFontSize: 13,
  editorLineHeight: 'standard',
  editorLigatures: false,
  islandGap: 8,
  accentColor: '#4d6bfe',
  canvasTransparency: 0.32,
  contentScrimOpacity: 0.82,
  backgrounds: { canvas: null, sidebar: null, content: null },
}

const ready: HostStatus = {
  kind: 'ready',
  ownership: 'external',
  identity: { reportedVersion: '测试版本' },
}

const unavailable: HostStatus = {
  kind: 'unavailable',
  message: '测试 Host 未启动',
}

function settingsNamespace(
  ns: string,
  value: Record<string, unknown>,
  options: {
    readonly schema?: unknown
    readonly user?: Record<string, unknown>
    readonly secrets?: readonly { readonly path: readonly string[]; readonly set: boolean }[]
  } = {},
) {
  return {
    ns,
    schema: options.schema ?? {},
    value,
    base: value,
    user: options.user ?? {},
    applies: 'live',
    secrets: options.secrets ?? [],
    revision: 1,
  }
}

function hostSettingsDocument(writable: boolean) {
  return {
    writable,
    hasDocument: true,
    namespaces: [
      settingsNamespace('agent-default-model', { provider: 'deepseek', model: 'deepseek-chat' }),
      settingsNamespace('agent-presets', { default: 'standard' }),
      settingsNamespace(
        'permission',
        { defaultPreset: 'workspace-write' },
        {
          schema: {
            properties: {
              defaultPreset: {
                enum: ['workspace-write', 'danger-full-access'],
              },
            },
          },
        },
      ),
      settingsNamespace('locale', { preference: 'zh' }),
      settingsNamespace('ui-conversation', { busyEnter: 'queue' }),
      settingsNamespace('llm-deepseek', {
        profiles: {
          default: {
            baseURL: 'https://api.deepseek.com',
            api: 'openai-completions',
            apiKeyEnv: 'DEEPSEEK_API_KEY',
          },
        },
      }),
      settingsNamespace('shell', { timeoutMs: 30_000, maxOutputBytes: 1_000_000 }),
    ],
  }
}

function settingsHostCall(writable: boolean): DesktopBridge['host']['call'] {
  return async operation => {
    if (operation === 'listSessions') return { items: [] }
    if (operation === 'describeSettings') return hostSettingsDocument(writable)
    if (operation === 'listHostModels') {
      return {
        groups: [
          {
            id: 'deepseek',
            name: 'DeepSeek',
            models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
          },
        ],
        failures: [],
      }
    }
    if (operation === 'listModelProviders') {
      return {
        providers: [
          {
            provider: 'deepseek',
            displayName: 'DeepSeek API',
            settingsNs: 'llm-deepseek',
            settingsPath: ['profiles', 'default'],
            active: true,
            declared: true,
          },
        ],
      }
    }
    if (operation === 'describeCredentials') {
      return {
        credentials: {
          DEEPSEEK_API_KEY: { configured: true, source: 'file', writable: true },
        },
      }
    }
    if (operation === 'listAgentPresets') {
      return {
        presets: [
          {
            id: 'standard',
            name: '标准模式',
            description: '适合日常开发任务',
            trust: 'system',
            isDefault: true,
          },
        ],
        authorable: true,
        hasDocument: true,
      }
    }
    if (operation === 'mydshPlugins.list') {
      return [
        {
          id: 'web-search',
          name: '联网搜索',
          version: '1.0.0',
          apiVersion: 1,
          source: 'user',
          enabled: true,
          status: 'active',
          directory: '/mydsh/plugins/web-search/1.0.0',
        },
      ]
    }
    throw new Error(`测试未处理 Host 操作：${operation}`)
  }
}

function createBridge(
  status: HostStatus,
  hostCall: DesktopBridge['host']['call'] = async operation => {
    if (operation === 'listSessions') return { items: [] }
    throw new Error(`测试未处理 Host 操作：${operation}`)
  },
): DesktopBridge {
  let currentSettings = desktopSettings
  return {
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
      status: async () => status,
      call: hostCall,
      onStatusChanged: () => () => undefined,
      onSessionFrame: () => () => undefined,
      onHostFrame: () => () => undefined,
    },
    settings: {
      read: async () => currentSettings,
      update: async patch => {
        currentSettings = { ...currentSettings, ...patch, revision: currentSettings.revision + 1 }
        return currentSettings
      },
      chooseBackground: async () => null,
      applyBackground: async () => currentSettings,
      cancelBackground: async () => undefined,
      clearBackground: async () => currentSettings,
      onChanged: () => () => undefined,
      onOpenRequested: () => () => undefined,
    },
  }
}

function PluginManagerHarness() {
  const settings = useSettingsCenter(true)
  return <PluginManager {...settings} standalone />
}

function SettingsHarness() {
  const store = useWorkspaceStore()
  const snapshot = useWorkspaceSnapshot()
  return (
    <>
      <output data-testid="desktop-ready">
        {snapshot.initialized ? (snapshot.hostStatus?.kind ?? 'unknown') : 'initializing'}
      </output>
      <button
        type="button"
        onClick={() => {
          store.openSettings()
        }}
      >
        打开设置测试
      </button>
      <SettingsDialog />
    </>
  )
}

async function renderAndOpen(bridge: DesktopBridge): Promise<HTMLButtonElement> {
  window.dshDesktop = bridge
  render(
    <Provider models={{ workspace: useWorkspaceModel }}>
      <AppearanceSystem>
        <SettingsHarness />
      </AppearanceSystem>
    </Provider>,
  )
  await waitFor(() => {
    expect(screen.getByTestId('desktop-ready').textContent).not.toBe('initializing')
  })
  const opener = screen.getByRole<HTMLButtonElement>('button', { name: '打开设置测试' })
  opener.focus()
  fireEvent.click(opener)
  await screen.findByRole('dialog', { name: '设置' })
  return opener
}

beforeEach(() => {
  window.localStorage.clear()
  // jsdom 不计算尺寸或伪元素；布局由真实 Electron 验收覆盖。
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  const getComputedStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => getComputedStyle(element))
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(prefers-reduced-motion: reduce)',
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }))
})

afterEach(() => {
  cleanup()
  delete window.dshDesktop
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('完整设置中心', () => {
  it('归档页支持搜索与恢复，永久删除必须确认，失败保留记录并允许重试', async () => {
    const baseCall = settingsHostCall(true)
    let archivedSessionIds = ['旧会话', '归档会话']
    let failRestore = true
    let failDelete = true
    let failedBatchId: string | null = null
    const hostCall = vi.fn<DesktopBridge['host']['call']>(async (operation, payload) => {
      if (operation === 'listSessions')
        return {
          items: [
            { sessionId: '旧会话', title: '较早的讨论', updatedAt: 100, blank: false },
            { sessionId: '归档会话', title: '待恢复的项目讨论', updatedAt: 200, blank: false },
          ],
        }
      if (operation === 'listWorkspaces')
        return {
          archivedSessionIds,
          items: [
            {
              workspaceId: '项目',
              path: '/work/project',
              title: '原项目',
              sessionIds: ['归档会话'],
              createdAt: '2026-09-24T00:00:00.000Z',
              updatedAt: '2026-09-24T00:00:00.000Z',
            },
          ],
        }
      if (operation === 'loadSessionPage') return { records: [] }
      if (operation === 'unarchiveSession') {
        if (failRestore) throw new Error('恢复失败，请重试')
        archivedSessionIds = archivedSessionIds.filter(id => id !== payload.sessionId)
        return { archivedSessionIds }
      }
      if (operation === 'deleteArchivedSession') {
        if (failDelete || payload.sessionId === failedBatchId)
          throw new Error(
            "Error invoking remote method 'dsh-desktop:host:call': Error: gateway/internal: 无法写入会话目录",
          )
        archivedSessionIds = archivedSessionIds.filter(id => id !== payload.sessionId)
        return { archivedSessionIds }
      }
      return baseCall(operation, payload)
    })
    await renderAndOpen(createBridge(ready, hostCall))
    fireEvent.click(screen.getByRole('menuitem', { name: '已归档会话' }))
    const list = await screen.findByRole('list', { name: '已归档会话列表' })
    expect(within(list).getAllByRole('listitem')[0]?.textContent).toContain('待恢复的项目讨论')
    const search = screen.getByRole('searchbox', { name: '搜索已归档会话' })
    fireEvent.change(search, { target: { value: '原项目' } })
    expect(within(list).getAllByRole('listitem')).toHaveLength(1)
    const restore = screen.getByRole('button', { name: '恢复会话: 待恢复的项目讨论' })
    fireEvent.click(restore)
    expect(await screen.findByText('恢复失败，请重试')).toBeTruthy()
    expect(screen.getByRole('button', { name: '恢复会话: 待恢复的项目讨论' })).toBeTruthy()
    failRestore = false
    fireEvent.click(restore)
    await screen.findByText('没有匹配的会话')
    expect(hostCall).toHaveBeenCalledWith('unarchiveSession', { sessionId: '归档会话' })
    expect(archivedSessionIds).toEqual(['旧会话'])
    fireEvent.change(search, { target: { value: '' } })
    expect(screen.getByRole('button', { name: '恢复会话: 较早的讨论' })).toBeTruthy()
    expect(screen.queryByText('恢复失败，请重试')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '永久删除会话: 较早的讨论' }))
    let confirmation = (await screen.findByText('永久删除会话？')).closest(
      '[role="dialog"]',
    ) as HTMLElement
    fireEvent.click(within(confirmation).getByRole('button', { name: /取\s*消/u }))
    await waitFor(() => expect(screen.queryByText('永久删除会话？')).toBeNull())
    expect(hostCall.mock.calls.some(([operation]) => operation === 'deleteArchivedSession')).toBe(
      false,
    )
    fireEvent.click(screen.getByRole('button', { name: '永久删除会话: 较早的讨论' }))
    confirmation = (await screen.findByText('永久删除会话？')).closest(
      '[role="dialog"]',
    ) as HTMLElement
    fireEvent.click(await within(confirmation).findByRole('button', { name: '永久删除' }))
    expect(await within(confirmation).findByText('无法写入会话目录')).toBeTruthy()
    expect(screen.getAllByText('无法写入会话目录')).toHaveLength(1)
    expect(screen.queryByText('归档会话操作未完成')).toBeNull()
    expect(screen.queryByText(/Error invoking remote method/u)).toBeNull()
    expect(archivedSessionIds).toEqual(['旧会话'])
    failDelete = false
    fireEvent.click(await within(confirmation).findByRole('button', { name: '永久删除' }))
    await screen.findByText('暂无已归档会话')
    await waitFor(() => expect(screen.queryByText('永久删除会话？')).toBeNull())
    expect(hostCall).toHaveBeenCalledWith('deleteArchivedSession', { sessionId: '旧会话' })
    archivedSessionIds = ['批量甲', '批量乙']
    failedBatchId = '批量乙'
    fireEvent.click(screen.getByRole('button', { name: '刷新已归档会话' }))
    await screen.findByRole('checkbox', { name: '全选' })
    fireEvent.click(screen.getByRole('checkbox', { name: '全选' }))
    expect(screen.getByText('已选 2 项')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '删除所选' }))
    const batch = (await screen.findByText('永久删除 2 个归档会话？')).closest(
      '[role="dialog"]',
    ) as HTMLElement
    fireEvent.click(within(batch).getByRole('button', { name: /取\s*消/u }))
    expect(archivedSessionIds).toEqual(['批量甲', '批量乙'])
    fireEvent.click(screen.getByRole('button', { name: '删除所选' }))
    const retry = (await screen.findByText('永久删除 2 个归档会话？')).closest(
      '[role="dialog"]',
    ) as HTMLElement
    fireEvent.click(await within(retry).findByRole('button', { name: '永久删除' }))
    await screen.findByText('已删除 1 项，1 项未完成：无法写入会话目录')
    expect(archivedSessionIds).toEqual(['批量乙'])
    expect(screen.getByText('已选 1 项')).toBeTruthy()
    failedBatchId = null
    fireEvent.click(await within(retry).findByRole('button', { name: '永久删除' }))
    await screen.findByText('暂无已归档会话')
  })

  it('Host 事件刷新插件管理页中的内置配置，同时保留尚未保存的插件字段', async () => {
    const baseCall = settingsHostCall(true)
    let eventListener: ((frame: DesktopHostFrame) => void) | undefined
    let timeout = 30_000
    const hostCall = vi.fn<DesktopBridge['host']['call']>(async (operation, payload) => {
      if (operation === 'describeSettings') {
        const document = hostSettingsDocument(true)
        return {
          ...document,
          namespaces: document.namespaces.map(item =>
            item.ns === 'shell'
              ? Object.assign({}, item, {
                  revision: timeout,
                  value: { timeoutMs: timeout, maxOutputBytes: 1_000_000 },
                })
              : item,
          ),
        }
      }
      return baseCall(operation, payload)
    })
    const bridge = createBridge(ready, hostCall)
    bridge.host.onHostFrame = listener => {
      eventListener = listener
      return () => {
        eventListener = undefined
      }
    }
    window.dshDesktop = bridge
    render(
      <Provider models={{ workspace: useWorkspaceModel }}>
        <AppearanceSystem>
          <PluginManagerHarness />
        </AppearanceSystem>
      </Provider>,
    )
    fireEvent.click(await screen.findByRole('button', { name: '配置 终端' }))
    const input = await screen.findByRole<HTMLInputElement>('spinbutton', { name: /命令超时/u })
    fireEvent.change(input, { target: { value: '45000' } })
    const reads = hostCall.mock.calls.filter(
      ([operation]) => operation === 'describeSettings',
    ).length
    timeout = 60_000
    eventListener?.({ type: 'host/settings-updated', namespace: 'shell', revision: 2 })
    await waitFor(() => {
      expect(
        hostCall.mock.calls.filter(([operation]) => operation === 'describeSettings').length,
      ).toBeGreaterThan(reads)
    })
    await waitFor(() => {
      expect(input.value).toBe('45000')
    })
  })

  it('使用组件库弹窗与分类导航，并允许在 Host 未连接时修改本地外观', async () => {
    await renderAndOpen(createBridge(unavailable))

    const dialog = screen.getByRole('dialog', { name: '设置' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(screen.getByRole('navigation', { name: '设置分类' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: '内置插件' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: '通用设置' }).getAttribute('aria-current')).toBe(
      'page',
    )
    expect(screen.getByText('运行时设置暂不可用')).toBeTruthy()

    fireEvent.click(screen.getByRole('menuitem', { name: '外观' }))

    expect(await screen.findByRole('heading', { name: '外观' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '外观' }).getAttribute('aria-current')).toBe('page')
    expect(screen.queryByRole('radiogroup', { name: '界面材质' })).toBeNull()
    expect(screen.queryByRole('slider', { name: '画布透明度' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: '画布配色' })).toBeNull()
    expect(screen.queryByRole('slider', { name: '内容浮岛透明度' })).toBeNull()
    expect(screen.queryByRole('slider', { name: '浮岛间隙' })).toBeNull()
    expect(dialog.querySelector('input[type="range"]')).toBeNull()
    const fontFamily = screen.getByRole<HTMLInputElement>('combobox', { name: '界面字体' })
    expect(fontFamily.disabled).toBe(false)
    fontFamily.focus()
    fireEvent.keyDown(fontFamily, { key: 'ArrowDown', keyCode: 40 })
    const fontListbox = await screen.findByRole('listbox')
    expect(
      within(fontListbox).getByRole('option', { name: '系统字体' }).getAttribute('aria-selected'),
    ).toBe('true')
    fireEvent.keyDown(fontFamily, { key: 'ArrowDown', keyCode: 40 })
    expect(fontFamily.getAttribute('aria-activedescendant')).toBe(
      within(fontListbox).getByRole('option', { name: '人文无衬线' }).id,
    )
    fireEvent.keyDown(fontFamily, { key: 'Escape', keyCode: 27 })
    await waitFor(() => {
      expect(fontFamily.getAttribute('aria-expanded')).toBe('false')
    })
    expect(screen.getByRole('dialog', { name: '设置' })).toBeTruthy()
    expect(fontFamily).toBe(document.activeElement)
    fireEvent.keyDown(fontFamily, { key: 'ArrowDown', keyCode: 40 })
    fireEvent.click(await screen.findByRole('option', { name: '等宽字体' }))
    await waitFor(() => {
      expect(fontFamily.closest('.settings-select')?.textContent).toContain('等宽字体')
      expect(document.documentElement.style.getPropertyValue('--font-ui')).toContain(
        'SFMono-Regular',
      )
    })

    const fontSize = screen.getByRole<HTMLInputElement>('spinbutton', { name: '界面字号' })
    expect(fontSize.value).toBe('12')
    fireEvent.click(screen.getByRole('button', { name: '增大界面字号' }))
    await waitFor(() => {
      expect(fontSize.value).toBe('13')
      expect(document.documentElement.style.getPropertyValue('--text-body')).toBe('13px')
    })

    expect(screen.getByRole('switch', { name: '缩放胶囊常驻' })).toBeTruthy()
    expect(
      within(screen.getByRole('radiogroup', { name: '主题色' })).getAllByRole('radio'),
    ).toHaveLength(6)
    expect(screen.queryByRole('slider', { name: '对话内容宽度' })).toBeNull()
    expect(screen.queryByRole('slider', { name: '代码字号' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: '代码行高' })).toBeNull()
    expect(screen.queryByRole('switch', { name: '代码连字' })).toBeNull()
    expect(screen.queryByRole('button', { name: '选择图片' })).toBeNull()
    expect(screen.queryByRole('button', { name: /移除.*背景图片/u })).toBeNull()
  })

  it('自定义提供方校验必填项，将配置和密钥分别保存', async () => {
    const namespace = settingsNamespace(
      'llm-pi-ai',
      { providers: { existing: { api: 'openai-completions' } } },
      {
        schema: { properties: { api: { enum: ['openai-completions', 'openai-responses'] } } },
        user: { providers: { existing: { api: 'openai-completions' } } },
      },
    )
    const fallback = settingsHostCall(true)
    const hostCall = vi.fn<DesktopBridge['host']['call']>(async (operation, payload) => {
      if (operation === 'describeSettings')
        return {
          ...hostSettingsDocument(true),
          namespaces: [...hostSettingsDocument(true).namespaces, namespace],
        }
      if (operation === 'mutateSettings') return { ...namespace, revision: 2 }
      if (operation === 'setCredential') return undefined
      return fallback(operation, payload)
    })
    await renderAndOpen(createBridge(ready, hostCall))
    fireEvent.click(screen.getByRole('menuitem', { name: '模型' }))
    fireEvent.click(await screen.findByRole('button', { name: '添加提供方' }))
    const addModal = (await screen.findByText('自定义服务')).closest(
      '[role="dialog"]',
    ) as HTMLElement
    fireEvent.click(within(addModal).getByText('自定义服务'))
    fireEvent.click(await within(addModal).findByRole('button', { name: '创建提供方' }))
    expect(await within(addModal).findByText(/Provider ID 必须/u)).toBeTruthy()
    expect(hostCall.mock.calls.some(([operation]) => operation === 'mutateSettings')).toBe(false)
    fireEvent.change(within(addModal).getByLabelText('Provider ID'), {
      target: { value: 'my-gateway' },
    })
    fireEvent.change(within(addModal).getByLabelText('提供方显示名称'), {
      target: { value: '我的服务' },
    })
    fireEvent.change(within(addModal).getByLabelText('API 地址'), {
      target: { value: 'https://example.invalid/v1' },
    })
    fireEvent.change(within(addModal).getByLabelText('自定义提供方 API 密钥'), {
      target: { value: 'test-only-key' },
    })
    fireEvent.click(within(addModal).getByRole('button', { name: '手动添加' }))
    const draftModal = (await screen.findByText('手动添加模型')).closest(
      '[role="dialog"]',
    ) as HTMLElement
    fireEvent.change(within(draftModal).getByLabelText('模型 ID'), {
      target: { value: 'my-model' },
    })
    fireEvent.click(within(draftModal).getByRole('button', { name: '添加模型' }))
    await waitFor(() => expect(screen.queryByText('手动添加模型')).toBeNull())
    fireEvent.click(within(addModal).getByRole('button', { name: '创建提供方' }))
    await waitFor(() =>
      expect(hostCall).toHaveBeenCalledWith('mutateSettings', {
        ns: 'llm-pi-ai',
        expectedRevision: 1,
        ops: [
          {
            op: 'set',
            path: ['providers', 'my-gateway'],
            value: {
              displayName: '我的服务',
              baseURL: 'https://example.invalid/v1',
              api: 'openai-completions',
              apiKeyEnv: 'MY_GATEWAY_API_KEY',
              models: [{ id: 'my-model' }],
            },
          },
        ],
      }),
    )
    await waitFor(() =>
      expect(hostCall).toHaveBeenCalledWith('setCredential', {
        ref: 'MY_GATEWAY_API_KEY',
        value: 'test-only-key',
      }),
    )
  })

  it('内置提供方获取可用模型时不附带误判协议，并展示返回的模型目录', async () => {
    const namespace = settingsNamespace(
      'llm-pi-ai',
      { providers: { google: { apiKeyEnv: 'GOOGLE_API_KEY' } } },
      {
        schema: {
          properties: {
            api: { enum: ['openai-completions', 'openai-responses', 'google-generative-ai'] },
          },
        },
        user: { providers: { google: { apiKeyEnv: 'GOOGLE_API_KEY' } } },
      },
    )
    const fallback = settingsHostCall(true)
    const hostCall = vi.fn<DesktopBridge['host']['call']>(async (operation, payload) => {
      if (operation === 'describeSettings')
        return {
          ...hostSettingsDocument(true),
          namespaces: [...hostSettingsDocument(true).namespaces, namespace],
        }
      if (operation === 'listModelProviders')
        return {
          providers: [
            {
              provider: 'google',
              displayName: 'google',
              settingsNs: 'llm-pi-ai',
              settingsPath: ['providers', 'google'],
              active: true,
              declared: false,
            },
          ],
        }
      if (operation === 'discoverProviderModels')
        return {
          models: [
            {
              id: 'gemini-4-neon',
              name: 'Gemini 4 Neon',
              contextWindow: 1_048_576,
              maxTokens: 65_536,
              inputModalities: ['text', 'image'],
            },
          ],
        }
      return fallback(operation, payload)
    })
    await renderAndOpen(createBridge(ready, hostCall))
    fireEvent.click(screen.getByRole('menuitem', { name: '模型' }))
    fireEvent.click(await screen.findByRole('button', { name: '编辑 google' }))
    fireEvent.click(await screen.findByRole('button', { name: '拉取可用模型' }))
    expect(await screen.findByText('选择要添加的模型（1）')).toBeTruthy()
    expect(screen.getByText('Gemini 4 Neon')).toBeTruthy()
    expect(hostCall).toHaveBeenCalledWith('discoverProviderModels', {
      settingsNs: 'llm-pi-ai',
      provider: 'google',
    })
  })

  it('设置呈现精简分类导航、模型与 Agent 预设，不再混入内置插件或扩展安装管理', async () => {
    const hostCall = vi.fn(settingsHostCall(true))
    await renderAndOpen(createBridge(ready, hostCall))

    await waitFor(() => {
      expect(hostCall).toHaveBeenCalledWith('describeSettings', {})
      expect(hostCall).toHaveBeenCalledWith('listHostModels', {})
      expect(hostCall).toHaveBeenCalledWith('listModelProviders', {})
      expect(hostCall).toHaveBeenCalledWith('listAgentPresets', {})
    })

    const navLabels = screen.getAllByRole('menuitem').map(item => item.textContent?.trim() ?? '')
    expect(navLabels).toEqual([
      '通用设置',
      '外观',
      '模型',
      'Agent 预设',
      '已归档会话',
      '浏览器与桌面操控',
    ])
    expect(screen.queryByRole('menuitem', { name: '内置插件' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'ChatGPT 订阅' })).toBeNull()

    fireEvent.click(screen.getByRole('menuitem', { name: '模型' }))
    expect(await screen.findByRole('heading', { name: '模型' })).toBeTruthy()
    expect(await screen.findByText('DeepSeek API')).toBeTruthy()
    expect(screen.getByRole('combobox', { name: '新会话默认模型' })).toBeTruthy()
    expect(
      screen.getByRole('button', { name: '编辑 DeepSeek API' }).getAttribute('aria-expanded'),
    ).toBe('false')
    expect(screen.queryByRole('button', { name: '添加插件' })).toBeNull()
    expect(screen.queryByRole('region', { name: '已安装插件' })).toBeNull()
    expect(hostCall.mock.calls.some(([operation]) => operation === 'listHostPlugins')).toBe(false)

    fireEvent.click(screen.getByRole('menuitem', { name: 'Agent 预设' }))
    expect(await screen.findByRole('heading', { name: 'Agent 预设' })).toBeTruthy()
    expect(screen.getAllByText('标准模式').length).toBeGreaterThan(0)

    expect(screen.queryByRole('button', { name: '订阅' })).toBeNull()
    expect(screen.queryByRole('heading', { name: '订阅' })).toBeNull()
    expect(
      hostCall.mock.calls.some(([operation]) => /subscription|billing|account/iu.test(operation)),
    ).toBe(false)
  })

  it('Host 设置文档只读时禁用所有 Host 写控件，但保留桌面外观设置', async () => {
    const bridge = createBridge(ready, settingsHostCall(false))
    await renderAndOpen(bridge)

    const permission = await screen.findByRole<HTMLInputElement>('combobox', { name: '默认权限' })
    expect(permission.disabled).toBe(true)
    expect(
      screen.getByRole<HTMLInputElement>('combobox', { name: '繁忙时 Enter 键行为' }).disabled,
    ).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('radio', { name: '浅色' }).disabled).toBe(false)

    fireEvent.click(screen.getByRole('menuitem', { name: '模型' }))
    expect(
      (await screen.findByRole<HTMLInputElement>('combobox', { name: '新会话默认模型' })).disabled,
    ).toBe(true)

    fireEvent.click(screen.getByRole('menuitem', { name: 'Agent 预设' }))
    expect(
      (await screen.findByRole<HTMLButtonElement>('button', { name: '当前使用: 标准模式' }))
        .disabled,
    ).toBe(true)

    cleanup()
    window.dshDesktop = bridge
    render(
      <Provider models={{ workspace: useWorkspaceModel }}>
        <AppearanceSystem>
          <PluginManagerHarness />
        </AppearanceSystem>
      </Provider>,
    )
    expect(screen.queryByRole('region', { name: '扩展配置' })).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: '配置 终端' }))
    const pluginNumberFields = await screen.findAllByRole<HTMLInputElement>('spinbutton')
    expect(pluginNumberFields.length).toBeGreaterThan(0)
    expect(pluginNumberFields.every(field => field.disabled)).toBe(true)
  })

  it('插件安装失败保留路径，停用失败保留开关，卸载必须确认且待重启显示真实状态', async () => {
    let installed = false
    let pending = false
    const fallback = settingsHostCall(true)
    const hostCall = vi.fn<DesktopBridge['host']['call']>(async (operation, payload) => {
      if (operation === 'mydshPlugins.list')
        return installed
          ? [
              {
                id: 'sample',
                name: '测试扩展',
                version: '1.0.0',
                source: 'user',
                enabled: true,
                status: pending ? 'pending' : 'active',
                ...(pending ? { pending: { action: 'uninstall' } } : {}),
              },
            ]
          : []
      if (operation === 'mydshPlugins.chooseDirectory') return 'C:/plugins/sample'
      if (operation === 'mydshPlugins.install') {
        if ((payload as { path: string }).path === 'bad') throw new Error('未找到插件清单')
        installed = true
        return {}
      }
      if (operation === 'mydshPlugins.disable') throw new Error('请先停用依赖此插件的扩展')
      if (operation === 'mydshPlugins.uninstall') {
        pending = true
        return {}
      }
      return fallback(operation, payload)
    })
    const bridge = createBridge(ready, hostCall)
    bridge.remote.call = vi.fn(async endpoint => {
      if (endpoint === 'chatgpt/status') {
        return {
          connected: false,
          registered: false,
          planEnabled: false,
          connecting: false,
          needsPlanNotice: false,
          account: null,
          authorizationUrl: null,
          message: null,
          models: [],
        }
      }
      throw new Error(`测试未声明扩展 Remote：${endpoint}`)
    })
    window.dshDesktop = bridge
    render(
      <Provider models={{ workspace: useWorkspaceModel }}>
        <AppearanceSystem>
          <PluginManagerHarness />
        </AppearanceSystem>
      </Provider>,
    )
    fireEvent.click(await screen.findByRole('button', { name: '添加插件' }))
    fireEvent.change(screen.getByLabelText('插件文件夹'), { target: { value: 'bad' } })
    fireEvent.click(screen.getByRole('button', { name: '安装并启用' }))
    expect(await screen.findByText('未找到插件清单')).toBeTruthy()
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '插件文件夹' }).value).toBe('bad')
    fireEvent.click(screen.getByRole('button', { name: '选择插件文件夹' }))
    await waitFor(() =>
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: '插件文件夹' }).value).toBe(
        'C:/plugins/sample',
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: '安装并启用' }))
    await screen.findByRole('switch', { name: '启用 测试扩展' })
    fireEvent.click(screen.getByRole('button', { name: '内置 (5)' }))
    expect(screen.queryByRole('switch', { name: '启用 测试扩展' })).toBeNull()
    expect(screen.getByRole('button', { name: '配置 ChatGPT 订阅' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '配置 ChatGPT 订阅' }))
    expect(await screen.findByText('尚未连接 ChatGPT 订阅')).toBeTruthy()
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 2, name: 'ChatGPT 订阅' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '所有插件' }))
    expect(await screen.findByRole('button', { name: '配置 ChatGPT 订阅' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '用户扩展 (1)' }))
    expect(screen.queryByRole('button', { name: '配置 终端' })).toBeNull()
    expect(screen.queryByRole('button', { name: '配置 ChatGPT 订阅' })).toBeNull()
    expect(screen.getByRole('switch', { name: '启用 测试扩展' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '全部 (6)' }))
    const toggle = screen.getByRole('switch', { name: '启用 测试扩展' })
    fireEvent.click(toggle)
    expect(await screen.findByText('请先停用依赖此插件的扩展')).toBeTruthy()
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '查看 测试扩展' }))
    fireEvent.click(screen.getByRole('button', { name: '卸载插件' }))
    // rc-dialog 在测试环境固定标题 ID；从可见标题寻找所属对话框。
    const confirmation = (await screen.findByText('卸载 测试扩展')).closest(
      '[role="dialog"]',
    ) as HTMLElement
    fireEvent.click(within(confirmation).getByRole('button', { name: /取\s*消/ }))
    expect(hostCall.mock.calls.some(([operation]) => operation === 'mydshPlugins.uninstall')).toBe(
      false,
    )
    fireEvent.click(screen.getByRole('button', { name: '卸载插件' }))
    fireEvent.click(
      within(
        (await screen.findByText('卸载 测试扩展')).closest('[role="dialog"]') as HTMLElement,
      ).getByRole('button', { name: /卸\s*载/ }),
    )
    expect(await screen.findByText('重启后卸载')).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('switch', { name: '启用 测试扩展' }).disabled).toBe(
      true,
    )
  })

  it('关闭设置后把键盘焦点还给打开设置的控件', async () => {
    const opener = await renderAndOpen(createBridge(ready, settingsHostCall(true)))

    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: '通用设置' })).toBe(document.activeElement)
    })
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '设置' })).toBeNull()
      expect(opener).toBe(document.activeElement)
    })
  })

  it('点击设置遮罩会关闭并把焦点还给打开控件', async () => {
    const opener = await renderAndOpen(createBridge(ready, settingsHostCall(true)))
    const dialog = screen.getByRole('dialog', { name: '设置' })
    const backdrop = dialog.closest('.ant-modal-wrap')
    if (backdrop === null) throw new Error('设置窗口缺少遮罩容器')
    fireEvent.mouseDown(backdrop)
    fireEvent.click(backdrop)

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '设置' })).toBeNull()
      expect(opener).toBe(document.activeElement)
    })
  })

  it('首次打开设置即挂载导航指示条并展示可见的通用设置页头', async () => {
    await renderAndOpen(createBridge(ready, settingsHostCall(true)))
    const dialog = screen.getByRole('dialog', { name: '设置' })
    expect(dialog.querySelector('.settings-nav__worm')).toBeTruthy()
    expect(
      screen.getByRole('heading', { name: '通用设置' }).classList.contains('visually-hidden'),
    ).toBe(false)
    const select = await screen.findByRole<HTMLInputElement>('combobox', { name: '默认权限' })
    expect(select.closest('.settings-select')?.textContent).toContain('工作区内修改')
  })

  it('ChatGPT 订阅页清晰呈现未连接、授权等待、已连接模型目录与连接错误状态', async () => {
    let statusPayload: Record<string, unknown> = {
      connected: false,
      registered: false,
      planEnabled: false,
      connecting: false,
      needsPlanNotice: false,
      account: null,
      authorizationUrl: null,
      message: null,
      models: [],
    }
    const bridge = createBridge(ready, settingsHostCall(true))
    bridge.remote.call = vi.fn(async endpoint => {
      if (endpoint === 'chatgpt/status') return statusPayload
      if (endpoint === 'chatgpt/connect') {
        statusPayload = {
          connected: false,
          registered: true,
          planEnabled: false,
          connecting: true,
          needsPlanNotice: false,
          account: null,
          authorizationUrl: 'https://auth.openai.com/api/accounts/authorize?client_id=test',
          message: null,
          models: [],
        }
        return statusPayload
      }
      if (endpoint === 'chatgpt/refresh') {
        return statusPayload
      }
      return statusPayload
    })
    window.dshDesktop = bridge
    const view = render(
      <Provider models={{ workspace: useWorkspaceModel }}>
        <AppearanceSystem>
          <ChatGPTSettings />
        </AppearanceSystem>
      </Provider>,
    )
    expect(await screen.findByText('尚未连接 ChatGPT 订阅')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'OpenAI 隐私政策' })).toBeTruthy()
    expect(screen.getByRole('link', { name: '管理 ChatGPT 用量与 MyDSH 访问权限' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '继续使用 ChatGPT' }))
    expect(await screen.findByText('在浏览器中完成授权')).toBeTruthy()
    expect(screen.getByRole('link', { name: '打开 ChatGPT 授权页面' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '取消授权' })).toBeTruthy()

    statusPayload = {
      connected: true,
      registered: true,
      planEnabled: true,
      connecting: false,
      needsPlanNotice: false,
      account: 'user@example.com',
      authorizationUrl: null,
      message: '令牌同步告警',
      models: [
        {
          id: 'gpt-5-codex',
          name: 'GPT-5 Codex',
          contextWindow: 192000,
          reasoningEfforts: ['low', 'medium', 'high'],
        },
      ],
    }
    view.unmount()
    render(
      <Provider models={{ workspace: useWorkspaceModel }}>
        <AppearanceSystem>
          <ChatGPTSettings />
        </AppearanceSystem>
      </Provider>,
    )
    expect(await screen.findByText('已连接 · user@example.com')).toBeTruthy()
    expect(screen.getByText('令牌同步告警')).toBeTruthy()
    expect(screen.getByRole('list', { name: 'ChatGPT 可用模型目录' })).toBeTruthy()
    expect(screen.getByText('GPT-5 Codex')).toBeTruthy()
    expect(screen.getByText('上下文 192,000 Token')).toBeTruthy()
    expect(screen.getByText('low / medium / high')).toBeTruthy()
    expect(screen.getByRole('button', { name: '刷新模型目录' })).toBeTruthy()
  })
})
