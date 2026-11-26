// @vitest-environment jsdom

/** 验证 SSH 左侧主机列表、标签切换与连接失败时的 renderer 状态。 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  SshConnectResult,
  SshProfile,
  SshStatus,
  SshTerminal,
} from '../packages/connections/ssh/types.d.ts'
import {
  ConnectionsProvider,
  ConnectionsSidebar,
} from '../src/renderer/src/features/connections/ConnectionsProvider.tsx'
import { ConnectionsWorkspace } from '../src/renderer/src/features/connections/ConnectionsWorkspace.tsx'
import {
  WorkspaceTabsProvider,
  useWorkspaceTabs,
} from '../src/renderer/src/features/workspace-tabs/WorkspaceTabsProvider.tsx'

const bridge = vi.hoisted(() => ({
  call: vi.fn(),
  snapshot: {
    activeView: 'connections',
    projects: [],
    selectedProjectId: null,
    navigationCollapsed: false,
  },
  toggleNavigation: vi.fn(),
  setView: vi.fn(),
}))
vi.mock('../src/renderer/src/plugins/sdk.ts', () => ({
  callRemote: bridge.call,
  useWorkspaceSnapshot: () => bridge.snapshot,
  useWorkspaceStore: () => ({
    toggleNavigation: bridge.toggleNavigation,
    setView: bridge.setView,
  }),
}))
vi.mock('../src/renderer/src/features/connections/DatabaseWorkspace.tsx', () => ({
  DatabaseWorkspace: () => <div>数据库工作区</div>,
}))
vi.mock('../src/renderer/src/features/connections/SshTerminal.tsx', () => ({
  SshTerminal: ({
    terminal,
    active,
    focusOnActivate,
  }: {
    terminal: SshTerminal
    active: boolean
    focusOnActivate: boolean
  }) => (
    <div
      id={`ssh-terminal-panel-${terminal.id}`}
      role="tabpanel"
      aria-labelledby={`ssh-terminal-tab-${terminal.id}`}
      data-ssh-terminal={terminal.id}
      data-focus={String(focusOnActivate)}
      hidden={!active}
    >
      {terminal.name} 的终端
    </div>
  ),
}))

const profile = (id: string, patch: Partial<SshProfile> = {}): SshProfile => ({
  id,
  revision: 1,
  name: `服务器 ${id}`,
  host: `${id}.example.test`,
  port: 22,
  username: 'tester',
  auth: 'password',
  environment: '测试',
  projectId: null,
  disabled: false,
  fingerprint: 'SHA256:已确认',
  credentialConfigured: true,
  agentAccess: {
    enabled: false,
    mode: 'readonly',
    allowSudo: false,
    allowedPaths: [],
  },
  ...patch,
})
let status: SshStatus
let terminalSequence = 0
const defaultCall = async (method: string, args: Record<string, unknown>) => {
  if (method === 'mydshSsh/status') return structuredClone(status)
  if (method === 'mydshSsh/connect') {
    const target = status.connections.find(item => item.id === args.id)!
    if (!target.fingerprint)
      return {
        kind: 'confirm-host',
        connectionId: target.id,
        revision: target.revision,
        fingerprint: 'SHA256:待确认',
      }
    if (args.testOnly) return { kind: 'tested' }
    const terminal: SshTerminal = {
      id: `terminal-${++terminalSequence}`,
      connectionId: target.id,
      name: target.name,
      status: 'connected',
      message: null,
    }
    status.terminals.push(terminal)
    return { kind: 'terminal', terminal }
  }
  if (method === 'mydshSsh/trustHost') {
    status.connections = status.connections.map(item =>
      item.id === args.id
        ? { ...item, fingerprint: String(args.fingerprint), revision: item.revision + 1 }
        : item,
    )
    return status.connections.find(item => item.id === args.id)
  }
  if (method === 'mydshSsh/close') {
    status.terminals = status.terminals.filter(item => item.id !== args.id)
    return true
  }
  if (method === 'mydshSsh/remove') {
    status.connections = status.connections.filter(item => item.id !== args.id)
    status.terminals = status.terminals.filter(item => item.connectionId !== args.id)
    return true
  }
  return true
}
function SshTabFixture({ visible }: { visible: boolean }) {
  const group = useWorkspaceTabs()?.sshGroup
  const inSsh = visible && bridge.snapshot.activeView === 'connections'
  const active = inSsh ? group?.activeId : null
  return (
    <>
      <button type="button" aria-label="SSH" onClick={() => group?.select(null)}>
        SSH
      </button>
      <div role="tablist" aria-label="工作标签">
        {group?.tabs.map(tab => (
          <div key={tab.id}>
            <button
              id={`ssh-terminal-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={active === tab.id}
              onClick={() => group.select(tab.id)}
            >
              {tab.title}
            </button>
            <button
              type="button"
              aria-label={`关闭 SSH 终端 ${tab.title}`}
              disabled={group.busy}
              onClick={() => group.close(tab.id)}
            >
              关闭
            </button>
          </div>
        ))}
      </div>
      <div hidden={!!active || !visible}>
        <ConnectionsWorkspace />
      </div>
      {group?.tabs.map(tab => (
        <div key={tab.id} hidden={active !== tab.id}>
          {group.render(tab.id, active === tab.id, active === tab.id)}
        </div>
      ))}
    </>
  )
}

const app = (visibility: 'foreground' | 'hidden' = 'foreground') => (
  <WorkspaceTabsProvider>
    <ConnectionsProvider>
      <ConnectionsSidebar />
      <SshTabFixture visible={visibility === 'foreground'} />
    </ConnectionsProvider>
  </WorkspaceTabsProvider>
)
const hostCard = (name: string) =>
  within(screen.getByRole('region', { name: '全部主机' })).getByRole('button', {
    name: `连接 ${name}`,
  })
const openHost = async (name: string) => {
  fireEvent.click(hostCard(name))
  await waitFor(() =>
    expect(
      screen.getByRole('tab', { name: new RegExp(name, 'u') }).getAttribute('aria-selected'),
    ).toBe('true'),
  )
}
const openNewDialog = async () => {
  await screen.findByRole('region', { name: '全部主机' })
  fireEvent.click(screen.getByRole('button', { name: '新增 SSH 连接' }))
  return within(await screen.findByRole('dialog', { name: '新增 SSH 连接' }))
}
const fillNewDialog = (dialog: ReturnType<typeof within>) => {
  fireEvent.change(dialog.getByLabelText('连接名称'), { target: { value: '新服务器' } })
  fireEvent.change(dialog.getByLabelText('服务器地址'), {
    target: { value: 'server.example.test' },
  })
  fireEvent.change(dialog.getByLabelText('用户名'), { target: { value: 'tester' } })
  fireEvent.change(dialog.getByLabelText('密码'), { target: { value: '隔离测试密码' } })
}

beforeEach(() => {
  bridge.snapshot = {
    activeView: 'connections',
    projects: [],
    selectedProjectId: null,
    navigationCollapsed: false,
  }
  bridge.call.mockReset().mockImplementation(defaultCall)
  status = { supported: true, connections: [profile('a'), profile('b')], terminals: [] }
  terminalSequence = 0
  window.localStorage.clear()
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
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
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('SSH 主机与终端工作区', () => {
  it('左栏收起时，最近连接首页提供展开入口', async () => {
    bridge.snapshot.navigationCollapsed = true
    render(app())
    await screen.findByRole('region', { name: '全部主机' })
    expect(screen.getByRole('region', { name: '最近连接' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '展开主机列表' }))
    expect(bridge.toggleNavigation).toHaveBeenCalledOnce()
  })

  it('展示真实主机和最近连接，搜索只过滤本地列表', async () => {
    window.localStorage.setItem('mydsh.ssh.recent.v1', JSON.stringify(['b', 'missing']))
    render(app())
    await screen.findByRole('region', { name: '全部主机' })
    const navigation = screen.getByLabelText('SSH 导航')
    const toolbar = within(navigation).getByRole('toolbar', { name: 'SSH 主机操作' })
    expect(within(toolbar).getByRole('search')).toBeTruthy()
    expect(
      within(toolbar)
        .getAllByRole('button')
        .map(button => button.getAttribute('aria-label')),
    ).toEqual(['新增 SSH 连接', '刷新连接列表'])
    expect(navigation.querySelector('.ssh-host-card')).not.toBeNull()
    expect(within(navigation).queryByRole('region', { name: '最近连接' })).toBeNull()
    const recent = within(screen.getByRole('region', { name: '最近连接' }))
    expect(recent.getByRole('button', { name: '连接 服务器 b' })).toBeTruthy()
    const calls = bridge.call.mock.calls.length
    fireEvent.change(screen.getByLabelText('搜索 SSH 主机'), { target: { value: 'a.example' } })
    expect(hostCard('服务器 a')).toBeTruthy()
    expect(within(navigation).queryByRole('button', { name: '连接 服务器 b' })).toBeNull()
    expect(recent.getByRole('button', { name: '连接 服务器 b' })).toBeTruthy()
    expect(bridge.call).toHaveBeenCalledTimes(calls)
    fireEvent.change(screen.getByLabelText('搜索 SSH 主机'), { target: { value: '不存在' } })
    expect(screen.getByText('没有匹配的主机，请尝试其他名称或地址。')).toBeTruthy()
  })

  it('新增表单先验证必填字段，再保存完整连接信息', async () => {
    bridge.call.mockImplementation((method: string, args: Record<string, unknown>) =>
      method === 'mydshSsh/save' ? Promise.resolve(profile('new')) : defaultCall(method, args),
    )
    render(app())
    const dialog = await openNewDialog()
    expect(dialog.getByRole('group', { name: '连接信息' })).toBeTruthy()
    expect(dialog.getByRole('group', { name: '登录认证' })).toBeTruthy()
    expect(dialog.getByRole('group', { name: '其他设置' })).toBeTruthy()
    expect(screen.queryByText(/仅手动使用/u)).toBeNull()
    fireEvent.click(dialog.getByRole('button', { name: '保存连接' }))
    await dialog.findByText('请输入连接名称')
    expect(bridge.call.mock.calls.some(([method]) => method === 'mydshSsh/save')).toBe(false)
    expect(screen.queryByText('[object Object]')).toBeNull()
    fillNewDialog(dialog)
    fireEvent.change(dialog.getByLabelText('环境标签'), { target: { value: '测试' } })
    fireEvent.click(dialog.getByRole('switch', { name: '禁用连接' }))
    fireEvent.click(dialog.getByRole('button', { name: '保存连接' }))
    await waitFor(() =>
      expect(bridge.call).toHaveBeenCalledWith(
        'mydshSsh/save',
        {
          request: {
            id: null,
            revision: null,
            name: '新服务器',
            host: 'server.example.test',
            port: 22,
            username: 'tester',
            auth: 'password',
            environment: '测试',
            projectId: null,
            disabled: true,
            agentAccess: {
              enabled: false,
              mode: 'readonly',
              allowSudo: false,
              allowedPaths: [],
            },
            password: '隔离测试密码',
          },
        },
        expect.any(AbortSignal),
      ),
    )
  })

  it('保存失败时在弹窗内显示错误并保留表单内容', async () => {
    bridge.call.mockImplementation((method: string, args: Record<string, unknown>) =>
      method === 'mydshSsh/save'
        ? Promise.reject(new Error('隔离凭据保存失败'))
        : defaultCall(method, args),
    )
    render(app())
    const dialog = await openNewDialog()
    fillNewDialog(dialog)
    fireEvent.click(dialog.getByRole('button', { name: '保存连接' }))
    await dialog.findByText('隔离凭据保存失败')
    expect((dialog.getByLabelText('连接名称') as HTMLInputElement).value).toBe('新服务器')
  })

  it('点击主机打开终端，返回主机不关闭连接并能复用已有终端', async () => {
    const mounted = render(app())
    await screen.findByRole('region', { name: '全部主机' })
    await openHost('服务器 a')
    expect(hostCard('服务器 a').getAttribute('aria-current')).toBe('true')
    expect(document.querySelector('[data-ssh-terminal="terminal-1"]')?.hasAttribute('hidden')).toBe(
      false,
    )
    expect(screen.queryByText(/未授权 Agent/u)).toBeNull()
    expect(JSON.parse(window.localStorage.getItem('mydsh.ssh.recent.v1')!)).toEqual(['a'])
    fireEvent.click(screen.getByRole('button', { name: '返回最近连接' }))
    expect(document.querySelector('[data-ssh-terminal="terminal-1"]')?.hasAttribute('hidden')).toBe(
      true,
    )
    expect(bridge.call.mock.calls.some(([method]) => method === 'mydshSsh/close')).toBe(false)
    fireEvent.click(
      within(screen.getByRole('region', { name: '最近连接' })).getByRole('button', {
        name: '连接 服务器 a',
      }),
    )
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: '服务器 a' }).getAttribute('aria-selected')).toBe(
        'true',
      ),
    )
    expect(bridge.call.mock.calls.filter(([method]) => method === 'mydshSsh/connect')).toHaveLength(
      1,
    )
    mounted.rerender(app('hidden'))
    expect(document.querySelector('[data-ssh-terminal="terminal-1"]')?.hasAttribute('hidden')).toBe(
      true,
    )
    mounted.rerender(app())
    expect(document.querySelector('[data-ssh-terminal="terminal-1"]')?.hasAttribute('hidden')).toBe(
      false,
    )
    mounted.unmount()
    expect(bridge.call).toHaveBeenCalledWith('mydshSsh/closeAll', {})
  })

  it('跨主机保留多个顶部标签，关闭当前终端回到其他标签', async () => {
    render(app())
    await screen.findByRole('region', { name: '全部主机' })
    await openHost('服务器 a')
    fireEvent.click(screen.getByRole('button', { name: '返回最近连接' }))
    await openHost('服务器 b')
    const tabA = screen.getByRole('tab', { name: /服务器 a/u })
    const tabB = screen.getByRole('tab', { name: /服务器 b/u })
    fireEvent.click(tabA)
    expect(tabA.getAttribute('aria-selected')).toBe('true')
    expect(
      document.querySelector('[data-ssh-terminal="terminal-1"]')?.getAttribute('data-focus'),
    ).toBe('true')
    fireEvent.click(tabB)
    fireEvent.click(screen.getByRole('button', { name: '关闭 SSH 终端 服务器 b' }))
    await waitFor(() => expect(screen.queryByRole('tab', { name: /服务器 b/u })).toBeNull())
    expect(tabA.getAttribute('aria-selected')).toBe('true')
    expect(bridge.call).toHaveBeenCalledWith(
      'mydshSsh/close',
      { id: 'terminal-2' },
      expect.any(AbortSignal),
    )
  })

  it('同一主机可以新建多个终端，关闭一个不影响另一个', async () => {
    render(app())
    await screen.findByRole('region', { name: '全部主机' })
    await openHost('服务器 a')
    fireEvent.click(screen.getByRole('button', { name: '为当前主机新建终端' }))
    await waitFor(() => expect(screen.getAllByRole('tab', { name: /服务器 a/u })).toHaveLength(2))
    expect(document.querySelector('[data-ssh-terminal="terminal-2"]')?.hasAttribute('hidden')).toBe(
      false,
    )
    const closeButtons = screen.getAllByRole('button', { name: '关闭 SSH 终端 服务器 a' })
    expect(closeButtons).toHaveLength(2)
    fireEvent.click(closeButtons[1]!)
    await waitFor(() => expect(screen.getAllByRole('tab', { name: /服务器 a/u })).toHaveLength(1))
    expect(document.querySelector('[data-ssh-terminal="terminal-1"]')?.hasAttribute('hidden')).toBe(
      false,
    )
    expect(bridge.call.mock.calls.filter(([method]) => method === 'mydshSsh/connect')).toHaveLength(
      2,
    )
  })

  it.each(['最近连接', '服务器 b'])('关闭回包保留等待期间选择的 %s', async target => {
    status.connections.push(profile('c'))
    render(app())
    await screen.findByRole('region', { name: '全部主机' })
    await openHost('服务器 a')
    await openHost('服务器 b')
    await openHost('服务器 c')
    fireEvent.click(screen.getByRole('tab', { name: /服务器 a/u }))
    const closing = Promise.withResolvers<void>()
    bridge.call.mockImplementation(async (method, args) => {
      if (method === 'mydshSsh/close') await closing.promise
      return defaultCall(method, args)
    })
    fireEvent.click(screen.getByRole('button', { name: '关闭 SSH 终端 服务器 a' }))
    const select =
      target === '最近连接'
        ? screen.getByRole('button', { name: 'SSH' })
        : screen.getByRole('tab', { name: target })
    fireEvent.click(select)
    await act(async () => closing.resolve())
    await waitFor(() => expect(screen.queryByRole('tab', { name: /服务器 a/u })).toBeNull())
    if (target === '最近连接') expect(screen.getByRole('region', { name: target })).toBeTruthy()
    else expect(select.getAttribute('aria-selected')).toBe('true')
  })

  it('主机菜单保留编辑操作，编辑时不回填密码', async () => {
    render(app())
    await screen.findByRole('region', { name: '全部主机' })
    fireEvent.click(
      within(screen.getByRole('region', { name: '全部主机' })).getByRole('button', {
        name: '服务器 a 的连接操作',
      }),
    )
    fireEvent.click(await screen.findByRole('menuitem', { name: '编辑连接' }))
    const password = (await screen.findByLabelText('新密码（留空保留原密码）')) as HTMLInputElement
    expect(password.value).toBe('')
    fireEvent.click(screen.getByText('查看主机指纹与凭据状态'))
    expect(screen.getByText('SHA256:已确认')).toBeTruthy()
    expect(screen.getByText('密码已保存')).toBeTruthy()
  })

  it('通过主机菜单确认删除指定连接', async () => {
    render(app())
    await screen.findByRole('region', { name: '全部主机' })
    fireEvent.click(
      within(screen.getByRole('region', { name: '全部主机' })).getByRole('button', {
        name: '服务器 a 的连接操作',
      }),
    )
    fireEvent.click(await screen.findByRole('menuitem', { name: '删除连接' }))
    await screen.findAllByText('删除“服务器 a”？')
    fireEvent.click(screen.getByRole('button', { name: '删除连接' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: '连接 服务器 a' })).toBeNull())
    expect(bridge.call).toHaveBeenCalledWith(
      'mydshSsh/remove',
      { id: 'a', revision: 1 },
      expect.any(AbortSignal),
    )
  })

  it('切换到数据库后保留 SSH 终端，返回时恢复同一连接', async () => {
    const mounted = render(app())
    await screen.findByRole('region', { name: '全部主机' })
    await openHost('服务器 a')
    bridge.snapshot = { ...bridge.snapshot, activeView: 'database' }
    mounted.rerender(app())
    expect(document.querySelector('[data-ssh-terminal="terminal-1"]')?.hasAttribute('hidden')).toBe(
      true,
    )
    bridge.snapshot = { ...bridge.snapshot, activeView: 'connections' }
    mounted.rerender(app())
    expect(document.querySelector('[data-ssh-terminal="terminal-1"]')?.hasAttribute('hidden')).toBe(
      false,
    )
    expect(bridge.call.mock.calls.some(([method]) => method === 'mydshSsh/closeAll')).toBe(false)
  })

  it('主区停留在浏览器标签时点击左侧 SSH 主机会切回连接主区', async () => {
    bridge.snapshot = {
      activeView: 'browser',
      navigationView: 'connections',
      projects: [],
      selectedProjectId: null,
      navigationCollapsed: false,
    } as typeof bridge.snapshot
    bridge.setView.mockReset()
    render(app())
    await screen.findByRole('region', { name: '全部主机' })
    fireEvent.click(hostCard('服务器 a'))
    expect(bridge.setView).toHaveBeenCalledWith('connections')
  })

  it('取消连接和卸载会中止请求，不产生终端', async () => {
    let signal: AbortSignal | undefined
    bridge.call.mockImplementation(
      (method: string, args: Record<string, unknown>, requestSignal: AbortSignal) => {
        if (method !== 'mydshSsh/connect') return defaultCall(method, args)
        signal = requestSignal
        return new Promise((_resolve, reject) => {
          requestSignal.addEventListener('abort', () => reject(new Error('连接已取消')), {
            once: true,
          })
        })
      },
    )
    const mounted = render(app())
    await screen.findByRole('region', { name: '全部主机' })
    fireEvent.click(hostCard('服务器 a'))
    await screen.findByRole('button', { name: '取消连接' })
    expect(screen.getByText('正在连接 服务器 a')).toBeTruthy()
    expect(document.querySelector('.ssh-connecting-card__address')?.textContent).toBe(
      'tester@a.example.test:22',
    )
    expect(document.querySelector('[data-ssh-host="a"]')?.getAttribute('data-connecting')).toBe(
      'true',
    )
    fireEvent.click(screen.getByRole('button', { name: '取消连接' }))
    await waitFor(() => expect(signal?.aborted).toBe(true))
    expect(document.querySelector('[data-ssh-terminal]')).toBeNull()
    await screen.findByText('连接已取消')
    fireEvent.click(hostCard('服务器 b'))
    await waitFor(() => expect(signal?.aborted).toBe(false))
    mounted.unmount()
    expect(signal?.aborted).toBe(true)
    expect(bridge.call).toHaveBeenCalledWith('mydshSsh/closeAll', {})
  })

  it('首次连接先核对原目标指纹，确认后才打开终端', async () => {
    status.connections[0] = profile('a', { fingerprint: null })
    render(app())
    await screen.findByRole('region', { name: '全部主机' })
    fireEvent.click(hostCard('服务器 a'))
    await screen.findByText('确认 SSH 主机指纹')
    expect(screen.getByText(/目标：服务器 a · a\.example\.test:22/u)).toBeTruthy()
    expect(document.querySelector('[data-ssh-terminal]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '指纹一致，信任并继续' }))
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /服务器 a/u }).getAttribute('aria-selected')).toBe(
        'true',
      ),
    )
    expect(bridge.call).toHaveBeenCalledWith(
      'mydshSsh/trustHost',
      { id: 'a', revision: 1, fingerprint: 'SHA256:待确认' },
      expect.any(AbortSignal),
    )
  })

  it('连接失败保留主机列表；迟到的成功不会抢走用户切换后的视图', async () => {
    let finish!: (result: SshConnectResult) => void
    bridge.call.mockImplementation((method: string, args: Record<string, unknown>) => {
      if (method === 'mydshSsh/connect' && args.id === 'a')
        return Promise.reject(new Error('认证失败'))
      if (method === 'mydshSsh/connect' && args.id === 'b')
        return new Promise<SshConnectResult>(resolve => {
          finish = resolve
        })
      return defaultCall(method, args)
    })
    render(app())
    await screen.findByRole('region', { name: '全部主机' })
    fireEvent.click(hostCard('服务器 a'))
    await screen.findByText('认证失败')
    expect(hostCard('服务器 a')).toBeTruthy()
    fireEvent.click(hostCard('服务器 b'))
    await waitFor(() => expect(finish).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'SSH' }))
    const terminal: SshTerminal = {
      id: 'late',
      connectionId: 'b',
      name: '服务器 b',
      status: 'connected',
      message: null,
    }
    status.terminals.push(terminal)
    await act(async () => finish({ kind: 'terminal', terminal }))
    await waitFor(() => expect(screen.getByRole('tab', { name: /服务器 b/u })).toBeTruthy())
    expect(screen.getByRole('region', { name: '最近连接' })).toBeTruthy()
    expect(document.querySelector('[data-ssh-terminal="late"]')?.hasAttribute('hidden')).toBe(true)
  })
})
