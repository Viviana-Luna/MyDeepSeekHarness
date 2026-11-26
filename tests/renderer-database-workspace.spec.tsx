// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ConfigProvider } from 'antd'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseProfile, DatabaseResult } from '../packages/connections/database/types.d.ts'
import {
  ConnectionsProvider,
  ConnectionsSidebar,
} from '../src/renderer/src/features/connections/ConnectionsProvider.tsx'
import { DatabaseWorkspace } from '../src/renderer/src/features/connections/DatabaseWorkspace.tsx'

const bridge = vi.hoisted(() => ({
  call: vi.fn(),
  setView: vi.fn(),
  snapshot: { activeView: 'database', projects: [], selectedProjectId: null },
}))
vi.mock('../src/renderer/src/plugins/sdk.ts', () => ({
  callRemote: bridge.call,
  useWorkspaceSnapshot: () => bridge.snapshot,
  useWorkspaceStore: () => ({ setView: bridge.setView }),
}))

const profile = (id: string, overrides: Partial<DatabaseProfile> = {}): DatabaseProfile => ({
  id,
  revision: 1,
  engine: 'mysql',
  name: `连接 ${id}`,
  host: 'localhost',
  port: 3306,
  username: 'reader',
  database: 'app',
  filePath: null,
  tlsEnabled: false,
  tlsServerName: '',
  tlsCa: '',
  sshConnectionId: null,
  environment: '',
  projectId: null,
  disabled: false,
  credentialConfigured: true,
  agentAccess: {
    enabled: true,
    mode: 'full',
    tableRules: [],
  },
  ...overrides,
})
const result = (value: string): DatabaseResult => ({
  columns: [{ name: 'id', type: 'bigint' }],
  rows: [[value]],
  rowCount: 1,
  bytes: 10,
  truncated: false,
  elapsedMs: 2,
})
const defaultCall = async (method: string, args: Record<string, unknown>) => {
  if (method === 'mydshDatabase/status')
    return { supported: true, connections: [profile('a'), profile('b')], busyIds: [] }
  if (method === 'mydshDatabase/schemas') return ['app', 'empty']
  if (method === 'mydshDatabase/tables')
    return args.schema === 'empty'
      ? []
      : [
          { name: 'users', kind: 'table' },
          { name: 'audit', kind: 'view' },
        ]
  if (method === 'mydshDatabase/columns')
    return [{ name: 'id', type: 'bigint', nullable: false, key: 'PRI' }]
  if (method === 'mydshDatabase/preview' || method === 'mydshDatabase/query')
    return result(`${args.id} 的结果`)
  return undefined
}
const app = () => (
  <ConfigProvider theme={{ token: { motion: false } }}>
    <ConnectionsProvider>
      <ConnectionsSidebar />
      <DatabaseWorkspace />
    </ConnectionsProvider>
  </ConfigProvider>
)
const clickNode = async (selector: string) => {
  await waitFor(() => expect(document.querySelector(selector)).not.toBeNull())
  fireEvent.click(document.querySelector(selector)!)
}
const waitIdle = () =>
  waitFor(() =>
    expect(document.querySelector('.database-operation')?.hasAttribute('hidden')).toBe(true),
  )

beforeEach(() => {
  window.localStorage.clear()
  bridge.snapshot = { activeView: 'database', projects: [], selectedProjectId: null }
  bridge.call.mockReset().mockImplementation(defaultCall)
  bridge.setView.mockReset()
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
})

describe('数据库对象工作区', () => {
  it('侧栏顶部同一行提供搜索框与紧凑图标操作，不再显示底部搜索或地址状态栏', async () => {
    render(app())
    await screen.findByRole('button', { name: '打开连接 连接 a' })
    const toolbar = screen.getByRole('toolbar', { name: '数据库操作' })
    const search = within(toolbar).getByRole('search')
    expect(within(search).getByLabelText('搜索数据库对象')).toBeTruthy()
    expect(
      within(toolbar)
        .getAllByRole('button')
        .map(button => button.getAttribute('aria-label')),
    ).toEqual(['新增数据库连接', '新增数据库分组', '刷新数据库连接'])
    const list = document.querySelector('.database-navigation-list')!
    expect(list.querySelector('footer')).toBeNull()
    const tree = screen.getByLabelText('数据库对象')
    expect(toolbar.compareDocumentPosition(tree) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  })

  it('可创建分组和移动连接，折叠后从首页打开会展开归属分组，重新挂载保留分组', async () => {
    const mounted = render(app())
    await screen.findByRole('button', { name: '打开连接 连接 a' })
    fireEvent.click(screen.getByRole('button', { name: '新增数据库分组' }))
    fireEvent.change(screen.getByLabelText('数据库分组名称'), { target: { value: '生产' } })
    fireEvent.click(screen.getByRole('button', { name: '保存分组' }))
    await waitFor(() =>
      expect(document.querySelector('[data-database-group]')?.textContent).toContain('生产'),
    )
    fireEvent.click(screen.getByRole('button', { name: '连接 连接 a 操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '生产' }))
    const stored = JSON.parse(window.localStorage.getItem('mydsh.database.groups.v1')!)
    expect(stored.assignments.a).toBe(stored.groups[0].id)
    const row = document.querySelector('[data-database-group]')!.closest('.ant-tree-treenode')!
    fireEvent.click(row.querySelector('.ant-tree-switcher')!)
    await waitFor(() => expect(document.querySelector('[data-database-connection="a"]')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '打开连接 连接 a' }))
    await waitIdle()
    expect(document.querySelector('[data-database-connection="a"]')).not.toBeNull()
    mounted.unmount()
    render(app())
    await waitFor(() =>
      expect(document.querySelector('[data-database-group]')?.textContent).toContain('生产'),
    )
    expect(JSON.parse(window.localStorage.getItem('mydsh.database.groups.v1')!).assignments.a).toBe(
      stored.groups[0].id,
    )
    fireEvent.change(screen.getByLabelText('搜索数据库对象'), { target: { value: '生产' } })
    await waitFor(() => {
      expect(document.querySelector('[data-database-connection="a"]')).not.toBeNull()
      expect(document.querySelector('[data-database-connection="b"]')).toBeNull()
    })
  })

  it('重命名和删除分组不修改连接，跨窗口更新后同步导航', async () => {
    window.localStorage.setItem(
      'mydsh.database.groups.v1',
      JSON.stringify({
        groups: [{ id: 'production', name: '生产' }],
        assignments: { a: 'production' },
      }),
    )
    render(app())
    await screen.findByRole('button', { name: '打开连接 连接 a' })
    fireEvent.click(screen.getByRole('button', { name: '分组 生产 操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '重命名分组' }))
    fireEvent.change(screen.getByLabelText('数据库分组名称'), { target: { value: '测试' } })
    fireEvent.click(screen.getByRole('button', { name: '保存分组' }))
    expect(
      JSON.parse(window.localStorage.getItem('mydsh.database.groups.v1')!).groups[0].name,
    ).toBe('测试')
    await screen.findByRole('button', { name: '分组 测试 操作' })
    fireEvent.click(screen.getByRole('button', { name: '分组 测试 操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '删除分组' }))
    fireEvent.click(await screen.findByRole('button', { name: '删除分组' }))
    await waitFor(() => expect(document.querySelector('[data-database-group]')).toBeNull())
    expect(document.querySelector('[data-database-connection="a"]')).not.toBeNull()
    expect(document.querySelector('[data-database-connection="b"]')).not.toBeNull()
    expect(bridge.call.mock.calls.map(([method]) => method)).toEqual(['mydshDatabase/status'])
    window.localStorage.setItem(
      'mydsh.database.groups.v1',
      JSON.stringify({ groups: [{ id: 'development', name: '开发' }], assignments: {} }),
    )
    fireEvent(window, new StorageEvent('storage', { key: 'mydsh.database.groups.v1' }))
    expect(document.querySelector('[data-database-group]')?.textContent).toContain('开发')
  })

  it('分组写入失败时保留输入并显示错误，不创建空壳分组', async () => {
    render(app())
    await screen.findByRole('button', { name: '打开连接 连接 a' })
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('存储不可用')
    })
    try {
      fireEvent.click(screen.getByRole('button', { name: '新增数据库分组' }))
      fireEvent.change(screen.getByLabelText('数据库分组名称'), { target: { value: '生产' } })
      fireEvent.click(screen.getByRole('button', { name: '保存分组' }))
      expect(await screen.findByText('无法保存数据库分组，请检查本地存储后重试。')).toBeTruthy()
      expect((screen.getByLabelText('数据库分组名称') as HTMLInputElement).value).toBe('生产')
      expect(document.querySelector('[data-database-group]')).toBeNull()
    } finally {
      write.mockRestore()
    }
  })

  it('没有连接时显示空首页，已有停用连接不能从首页发起查询', async () => {
    bridge.call.mockResolvedValueOnce({ supported: true, connections: [], busyIds: [] })
    const mounted = render(app())
    await screen.findByText('还没有数据库连接，点击「新建连接」开始。')
    expect((screen.getByRole('button', { name: '新建查询' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect((screen.getByRole('button', { name: '新建连接' }) as HTMLButtonElement).disabled).toBe(
      false,
    )
    mounted.unmount()
    bridge.call.mockImplementation(defaultCall)
    bridge.call.mockResolvedValueOnce({
      supported: true,
      connections: [{ ...profile('a'), disabled: true }],
      busyIds: [],
    })
    render(app())
    await screen.findByRole('button', { name: '打开连接 连接 a' })
    expect(
      (screen.getByRole('button', { name: '打开连接 连接 a' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(
      (screen.getByRole('button', { name: '在 连接 a 新建查询' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect((screen.getByRole('button', { name: '新建查询' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect(screen.getByLabelText('快速开始').textContent).toContain('0 / 1 可用')
  })

  it('默认显示首页快速开始与历史查询，不自动选择连接或读取数据库', async () => {
    render(app())
    await screen.findByRole('button', { name: '打开连接 连接 a' })
    const shortcuts = screen.getByLabelText('快速开始')
    expect(shortcuts.textContent).toContain('2 个连接')
    expect(document.querySelector('.database-home__stats')).toBeNull()
    expect(screen.getByLabelText('历史查询').textContent).toContain('暂无查询记录')
    expect(document.querySelector('.database-heading')).toBeNull()
    expect(document.querySelector('.ant-tree-node-selected')).toBeNull()
    expect(bridge.call.mock.calls.map(([method]) => method)).toEqual(['mydshDatabase/status'])
    fireEvent.click(screen.getByRole('button', { name: '打开连接 连接 a' }))
    await waitIdle()
    expect(screen.getByLabelText('数据库表列表')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '返回数据库首页' }))
    expect(screen.getByLabelText('快速开始')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '刷新连接' }))
    await waitFor(() =>
      expect(
        bridge.call.mock.calls.filter(([method]) => method === 'mydshDatabase/status'),
      ).toHaveLength(2),
    )
    expect(document.querySelector('.database-heading')).toBeNull()
  })

  it('首页恢复成功查询的草稿，不重复执行，失败查询不进入历史', async () => {
    bridge.call.mockImplementation(async (method: string, args: Record<string, unknown>) => {
      if (method === 'mydshDatabase/query' && args.sql === 'DELETE FROM users')
        return Promise.reject(new Error('仅支持 SELECT'))
      return defaultCall(method, args)
    })
    render(app())
    fireEvent.click(await screen.findByRole('button', { name: '在 连接 b 新建查询' }))
    fireEvent.change(screen.getByLabelText('SQL 查询内容'), { target: { value: 'SELECT 42' } })
    fireEvent.click(screen.getByRole('button', { name: '运行查询' }))
    await waitIdle()
    fireEvent.change(screen.getByLabelText('SQL 查询内容'), {
      target: { value: 'DELETE FROM users' },
    })
    fireEvent.click(screen.getByRole('button', { name: '运行查询' }))
    await screen.findByText('仅支持 SELECT')
    fireEvent.click(screen.getByRole('button', { name: '返回数据库首页' }))
    const history = screen.getByLabelText('历史查询')
    expect(history.textContent).toContain('SELECT 42')
    expect(history.textContent).not.toContain('DELETE FROM users')
    const count = bridge.call.mock.calls.length
    fireEvent.click(within(history).getByRole('button', { name: '恢复查询 SELECT 42' }))
    expect((screen.getByLabelText('SQL 查询内容') as HTMLTextAreaElement).value).toBe('SELECT 42')
    expect(document.querySelector('.database-heading h2')?.textContent).toBe('连接 b')
    expect(bridge.call).toHaveBeenCalledTimes(count)
  })

  it('返回首页取消进行中的读取，迟到结果不进入首页或查询历史', async () => {
    let finish!: (value: DatabaseResult) => void
    let signal: AbortSignal | undefined
    bridge.call.mockImplementation(
      (method: string, args: Record<string, unknown>, requestSignal: AbortSignal) => {
        if (method === 'mydshDatabase/query') {
          signal = requestSignal
          return new Promise<DatabaseResult>(resolve => {
            finish = resolve
          })
        }
        return defaultCall(method, args)
      },
    )
    render(app())
    fireEvent.click(await screen.findByRole('button', { name: '在 连接 a 新建查询' }))
    fireEvent.change(screen.getByLabelText('SQL 查询内容'), { target: { value: 'SELECT 42' } })
    fireEvent.click(screen.getByRole('button', { name: '运行查询' }))
    await waitFor(() => expect(signal).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: '返回数据库首页' }))
    expect(signal!.aborted).toBe(true)
    await act(async () => finish(result('迟到结果')))
    expect(screen.getByLabelText('历史查询').textContent).toContain('暂无查询记录')
    fireEvent.click(screen.getByRole('button', { name: '在 连接 a 新建查询' }))
    expect((screen.getByLabelText('SQL 查询内容') as HTMLTextAreaElement).value).toBe('SELECT 42')
  })

  it('按需展开库表树，右侧从表列表进入数据，搜索不触发读取', async () => {
    render(app())
    await clickNode('[data-database-connection="a"]')
    expect(screen.getByLabelText('数据库只读说明').textContent).toContain('单条 SELECT')
    await waitFor(() =>
      expect(
        within(screen.getByLabelText('数据库表列表')).getByRole('button', { name: 'users' }),
      ).toBeTruthy(),
    )
    expect(
      bridge.call.mock.calls.filter(([method]) => method === 'mydshDatabase/preview'),
    ).toHaveLength(0)
    fireEvent.click(
      within(screen.getByLabelText('数据库表列表')).getByRole('button', { name: 'users' }),
    )
    await waitFor(() =>
      expect(screen.getByLabelText('数据库查询结果').textContent).toContain('a 的结果'),
    )
    expect(document.querySelector('[aria-label="选择数据库"]')).toBeNull()
    const count = bridge.call.mock.calls.length
    fireEvent.change(screen.getByLabelText('搜索数据库对象'), { target: { value: 'users' } })
    expect(document.querySelector('[data-database-table="audit"]')).toBeNull()
    expect(document.querySelector('[data-database-schema="app"]')).not.toBeNull()
    expect(bridge.call).toHaveBeenCalledTimes(count)
    fireEvent.change(screen.getByLabelText('搜索数据库对象'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '字段结构' }))
    expect(screen.getByLabelText('字段结构表').textContent).toContain('PRI')
    await clickNode('[data-database-schema="empty"]')
    await waitFor(() =>
      expect(screen.getByLabelText('数据库表列表').textContent).toContain('没有可见的表'),
    )
  })

  it('切换数据库对象会取消旧请求，迟到的表数据不能覆盖新连接', async () => {
    let finish!: (value: DatabaseResult) => void
    let signal: AbortSignal | undefined
    bridge.call.mockImplementation(
      (method: string, args: Record<string, unknown>, requestSignal: AbortSignal) => {
        if (method === 'mydshDatabase/preview' && args.id === 'a') {
          signal = requestSignal
          return new Promise<DatabaseResult>(resolve => {
            finish = resolve
          })
        }
        return defaultCall(method, args)
      },
    )
    render(app())
    await clickNode('[data-database-connection="a"]')
    await waitIdle()
    await clickNode('[data-database-table="users"]')
    await waitFor(() => expect(signal).toBeDefined())
    await clickNode('[data-database-connection="b"]')
    await waitIdle()
    expect(signal!.aborted).toBe(true)
    fireEvent.click(
      within(screen.getByLabelText('数据库表列表')).getByRole('button', { name: 'users' }),
    )
    await waitFor(() =>
      expect(screen.getByLabelText('数据库查询结果').textContent).toContain('b 的结果'),
    )
    await act(async () => finish(result('过期结果')))
    expect(screen.getByLabelText('数据库查询结果').textContent).not.toContain('过期结果')
  })

  it('结构读取失败后可重试，卸载会取消请求并关闭窗口拥有的连接', async () => {
    let failed = false
    bridge.call.mockImplementation(async (method: string, args: Record<string, unknown>) => {
      if (method === 'mydshDatabase/tables' && !failed) {
        failed = true
        return Promise.reject(new Error('读取结构失败'))
      }
      return defaultCall(method, args)
    })
    const mounted = render(app())
    await clickNode('[data-database-connection="a"]')
    await waitFor(() => expect(screen.getByText('读取结构失败')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '连接并加载结构' }))
    await waitFor(() =>
      expect(
        within(screen.getByLabelText('数据库表列表')).getByRole('button', { name: 'users' }),
      ).toBeTruthy(),
    )
    let signal: AbortSignal | undefined
    bridge.call.mockImplementation(
      (method: string, args: Record<string, unknown>, requestSignal: AbortSignal) => {
        if (method === 'mydshDatabase/preview') {
          signal = requestSignal
          return new Promise(() => {})
        }
        return defaultCall(method, args)
      },
    )
    await clickNode('[data-database-table="users"]')
    await waitFor(() => expect(signal).toBeDefined())
    mounted.unmount()
    expect(signal!.aborted).toBe(true)
    expect(bridge.call).toHaveBeenCalledWith('mydshDatabase/closeAll', {})
  })

  it('独立模式切换保留 SQL 草稿和展开状态，不关闭数据库连接', async () => {
    const mounted = render(app())
    await clickNode('[data-database-connection="a"]')
    await waitIdle()
    fireEvent.click(screen.getByRole('button', { name: 'SQL 查询' }))
    fireEvent.change(screen.getByLabelText('SQL 查询内容'), {
      target: { value: 'SELECT id FROM users' },
    })
    bridge.snapshot = { ...bridge.snapshot, activeView: 'connections' }
    mounted.rerender(app())
    expect(document.querySelector('[data-database-table="users"]')).toBeNull()
    bridge.snapshot = { ...bridge.snapshot, activeView: 'database' }
    mounted.rerender(app())
    expect(document.querySelector('[data-database-table="users"]')).not.toBeNull()
    expect((screen.getByLabelText('SQL 查询内容') as HTMLTextAreaElement).value).toBe(
      'SELECT id FROM users',
    )
    expect(bridge.call.mock.calls.some(([method]) => method === 'mydshDatabase/closeAll')).toBe(
      false,
    )
  })

  it('左侧列表三点菜单提供编辑、Agent 权限与删除入口，主区头部不显示冗余胶囊按钮', async () => {
    bridge.call.mockImplementation(async (method: string, args: Record<string, unknown>) => {
      if (method === 'mydshDatabase/save') {
        const req = args.request as Record<string, unknown>
        return {
          ...profile('a'),
          revision: 2,
          agentAccess: req.agentAccess,
        }
      }
      if (method === 'mydshSsh/status') return { supported: true, connections: [], busyIds: [] }
      return defaultCall(method, args)
    })
    render(app())
    await clickNode('[data-database-connection="a"]')
    await waitIdle()
    expect(document.querySelector('.database-readonly')).toBeNull()
    expect(document.querySelector('.database-agent-pill')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '连接 连接 a 操作' }))
    expect(await screen.findByRole('menuitem', { name: '编辑连接' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '删除连接' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Agent 权限配置' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /只读/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /只读/ }))
    fireEvent.click(screen.getByRole('button', { name: '添加表规则' }))
    const schemaInput = screen.getByLabelText('第 1 条规则数据库名')
    const tableInput = screen.getByLabelText('第 1 条规则表名')
    fireEvent.change(schemaInput, { target: { value: 'app' } })
    fireEvent.change(tableInput, { target: { value: 'orders' } })
    fireEvent.click(screen.getByRole('button', { name: '保存连接' }))
    await waitFor(() =>
      expect(bridge.call.mock.calls.some(([method]) => method === 'mydshDatabase/save')).toBe(true),
    )
    const savedCall = bridge.call.mock.calls.find(([method]) => method === 'mydshDatabase/save')
    expect(savedCall?.[1]).toMatchObject({
      request: {
        agentAccess: {
          enabled: true,
          mode: 'readonly',
          tableRules: [
            {
              schema: 'app',
              table: 'orders',
              select: true,
              insert: false,
              update: false,
              delete: false,
              ddl: false,
            },
          ],
        },
      },
    })
    await waitFor(() => {
      expect(document.querySelector('.ant-modal-wrap')).toBeNull()
      expect(
        (screen.getByRole('button', { name: '连接 连接 a 操作' }) as HTMLButtonElement).disabled,
      ).toBe(false)
    })
    fireEvent.click(screen.getByRole('button', { name: '连接 连接 a 操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '删除连接' }))
    expect(await screen.findByRole('button', { name: '删除连接' })).toBeTruthy()
  })

  it('新建连接支持 MySQL、MariaDB、PostgreSQL 与 SQLite 切换及本地文件选择', async () => {
    bridge.call.mockImplementation(async (method: string, args: Record<string, unknown>) => {
      if (method === 'mydshSsh/status') return { supported: true, connections: [], busyIds: [] }
      if (method === 'mydshDatabase/pickSqliteFile') return '/Users/tester/data/analytics.db'
      if (method === 'mydshDatabase/save') {
        const req = args.request as Record<string, unknown>
        return {
          ...profile('sqlite-1', {
            engine: 'sqlite',
            name: String(req.name),
            host: '',
            port: 0,
            username: '',
            database: null,
            filePath: String(req.filePath),
          }),
          revision: 1,
        }
      }
      return defaultCall(method, args)
    })
    render(app())
    await screen.findByRole('button', { name: '打开连接 连接 a' })
    fireEvent.click(screen.getByRole('button', { name: '新增数据库连接' }))
    expect(await screen.findByRole('group', { name: '数据库类型' })).toBeTruthy()
    expect((document.getElementById('port') as HTMLInputElement).value).toBe('3306')
    fireEvent.click(screen.getByRole('button', { name: /PostgreSQL/ }))
    await waitFor(() =>
      expect((document.getElementById('port') as HTMLInputElement).value).toBe('5432'),
    )
    expect(screen.getByText('TLS/SSL')).toBeTruthy()
    expect(screen.getByText('SSH 通道')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /SQLite/ }))
    await waitFor(() => expect(document.getElementById('filePath')).not.toBeNull())
    expect(document.getElementById('host')).toBeNull()
    expect(screen.queryByText('TLS/SSL')).toBeNull()
    expect(screen.queryByText('SSH 通道')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '选择文件' }))
    await waitFor(() =>
      expect((document.getElementById('filePath') as HTMLInputElement).value).toBe(
        '/Users/tester/data/analytics.db',
      ),
    )
    expect((document.getElementById('name') as HTMLInputElement).value).toBe('analytics.db')
    fireEvent.click(screen.getByRole('button', { name: '保存连接' }))
    await waitFor(() =>
      expect(bridge.call.mock.calls.some(([method]) => method === 'mydshDatabase/save')).toBe(true),
    )
    const savedCall = bridge.call.mock.calls.find(([method]) => method === 'mydshDatabase/save')
    expect(savedCall?.[1]).toMatchObject({
      request: {
        engine: 'sqlite',
        name: 'analytics.db',
        filePath: '/Users/tester/data/analytics.db',
        host: '',
        port: 0,
        username: '',
        database: null,
        tlsEnabled: false,
        sshConnectionId: null,
      },
    })
  })

  it('首页和导航栏按实际数据库引擎显示 PostgreSQL 与 SQLite 摘要', async () => {
    bridge.call.mockImplementation(async (method: string, args: Record<string, unknown>) => {
      if (method === 'mydshDatabase/status') {
        return {
          supported: true,
          connections: [
            profile('pg-1', {
              engine: 'postgresql',
              name: '生产库',
              host: 'pg.internal',
              port: 5432,
            }),
            profile('sq-1', {
              engine: 'sqlite',
              name: '本地样本库',
              host: '',
              port: 0,
              username: '',
              database: null,
              filePath: '/tmp/sample-inventory.sqlite',
            }),
          ],
          busyIds: [],
        }
      }
      return defaultCall(method, args)
    })
    render(app())
    const pgCard = await screen.findByRole('button', { name: '打开连接 生产库' })
    const sqCard = screen.getByRole('button', { name: '打开连接 本地样本库' })
    expect(pgCard.textContent).toContain('PostgreSQL · pg.internal:5432')
    expect(sqCard.textContent).toContain('SQLite · sample-inventory.sqlite')
  })
})
