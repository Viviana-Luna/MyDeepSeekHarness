// @vitest-environment jsdom
/** 验证 SSH 连接弹窗「Agent 权限」标签页校验、保存与主机卡片 AI 权限徽标展示。 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SshProfile, SshStatus } from '../packages/connections/ssh/types.d.ts'
import {
  ConnectionsProvider,
  ConnectionsSidebar,
} from '../src/renderer/src/features/connections/ConnectionsProvider.tsx'
import { ConnectionsWorkspace } from '../src/renderer/src/features/connections/ConnectionsWorkspace.tsx'
import { WorkspaceTabsProvider } from '../src/renderer/src/features/workspace-tabs/WorkspaceTabsProvider.tsx'

const bridge = vi.hoisted(() => ({
  call: vi.fn(),
  snapshot: {
    activeView: 'connections',
    projects: [],
    selectedProjectId: null,
    navigationCollapsed: false,
  },
  toggleNavigation: vi.fn(),
}))

vi.mock('../src/renderer/src/plugins/sdk.ts', () => ({
  callRemote: bridge.call,
  useWorkspaceSnapshot: () => bridge.snapshot,
  useWorkspaceStore: () => ({ toggleNavigation: bridge.toggleNavigation }),
}))
vi.mock('../src/renderer/src/features/connections/DatabaseWorkspace.tsx', () => ({
  DatabaseWorkspace: () => <div>数据库工作区</div>,
}))
vi.mock('../src/renderer/src/features/connections/SshTerminal.tsx', () => ({
  SshTerminal: () => <div>SSH 终端</div>,
}))

function createProfile(id: string, patch: Partial<SshProfile> = {}): SshProfile {
  return {
    id,
    revision: 1,
    name: `服务器 ${id}`,
    host: `${id}.example.test`,
    port: 22,
    username: 'ops',
    auth: 'password',
    environment: '测试',
    projectId: null,
    disabled: false,
    fingerprint: 'SHA256:已确认',
    credentialConfigured: true,
    agentAccess: {
      enabled: true,
      mode: 'standard',
      allowSudo: false,
      allowedPaths: ['/srv/app'],
    },
    ...patch,
  }
}

let status: SshStatus

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  status = { supported: true, connections: [createProfile('a')], terminals: [] }
  bridge.call.mockReset().mockImplementation(async (method: string) => {
    if (method === 'mydshSsh/status') return structuredClone(status)
    if (method === 'mydshSsh/save') return createProfile('new')
    return true
  })
})

afterEach(() => {
  cleanup()
})

it('支持在「Agent 权限」标签页配置档位、sudo 与允许路径并在主机卡片显示 AI 徽标', async () => {
  render(
    <WorkspaceTabsProvider>
      <ConnectionsProvider>
        <ConnectionsSidebar />
        <ConnectionsWorkspace />
      </ConnectionsProvider>
    </WorkspaceTabsProvider>,
  )
  await screen.findByRole('region', { name: '全部主机' })
  expect(screen.getByText('AI · 运维')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: '新增 SSH 连接' }))
  const dialog = within(await screen.findByRole('dialog'))
  fireEvent.change(dialog.getByLabelText('连接名称'), { target: { value: '运维新节点' } })
  fireEvent.change(dialog.getByLabelText('服务器地址'), { target: { value: '10.0.0.12' } })
  fireEvent.change(dialog.getByLabelText('用户名'), { target: { value: 'ops' } })
  fireEvent.change(dialog.getByLabelText('密码'), { target: { value: 'secret-pass' } })

  fireEvent.click(dialog.getByRole('tab', { name: 'Agent 权限' }))
  fireEvent.click(dialog.getByRole('switch', { name: '向模型开放此连接' }))
  fireEvent.click(dialog.getByRole('button', { name: /常规运维/u }))
  fireEvent.click(dialog.getByRole('switch', { name: '允许 sudo 提权命令' }))
  fireEvent.click(dialog.getByRole('button', { name: '添加路径' }))
  fireEvent.change(dialog.getByLabelText('允许访问路径 1'), { target: { value: 'relative/path' } })
  fireEvent.click(dialog.getByRole('button', { name: '保存连接' }))
  await dialog.findByText(/必须是以 \/ 开头的 POSIX 绝对路径/u)
  expect(bridge.call.mock.calls.some(([method]) => method === 'mydshSsh/save')).toBe(false)

  fireEvent.change(dialog.getByLabelText('允许访问路径 1'), { target: { value: '/srv/app/' } })
  fireEvent.click(dialog.getByRole('button', { name: '保存连接' }))
  await waitFor(() =>
    expect(bridge.call).toHaveBeenCalledWith(
      'mydshSsh/save',
      {
        request: expect.objectContaining({
          name: '运维新节点',
          agentAccess: {
            enabled: true,
            mode: 'standard',
            allowSudo: true,
            allowedPaths: ['/srv/app'],
          },
        }),
      },
      expect.any(AbortSignal),
    ),
  )
})
