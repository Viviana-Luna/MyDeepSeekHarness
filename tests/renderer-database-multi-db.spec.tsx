/** 验证 PostgreSQL 四级多数据库切换（含物化视图标签）与 MySQL 业务库默认首选项。 */
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ConfigProvider } from 'antd'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseProfile, DatabaseResult } from '../packages/connections/database/types.d.ts'
import {
  ConnectionsProvider,
  ConnectionsSidebar,
} from '../src/renderer/src/features/connections/ConnectionsProvider.tsx'
import { DatabaseEngineIcon } from '../src/renderer/src/features/connections/DatabaseEngineIcon.tsx'
import { resolveConnectionState } from '../src/renderer/src/features/connections/database-workspace-helpers.ts'
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
  engine: 'postgresql',
  name: id === 'pg' ? 'pgtest' : 'mysqltest',
  host: '127.0.0.1',
  port: id === 'pg' ? 5432 : 3306,
  username: 'reader',
  database: id === 'pg' ? 'postgres' : 'deleted_default',
  filePath: null,
  tlsEnabled: false,
  tlsServerName: '',
  tlsCa: '',
  sshConnectionId: null,
  environment: '',
  projectId: null,
  disabled: false,
  credentialConfigured: true,
  agentAccess: { enabled: true, mode: 'full', tableRules: [] },
  ...overrides,
})

const result = (value: string): DatabaseResult => ({
  columns: [{ name: 'c', type: 'text' }],
  rows: [[value]],
  rowCount: 1,
  bytes: 12,
  truncated: false,
  elapsedMs: 1,
})

const app = () => (
  <ConfigProvider theme={{ token: { motion: false } }}>
    <ConnectionsProvider>
      <ConnectionsSidebar />
      <DatabaseWorkspace />
    </ConnectionsProvider>
  </ConfigProvider>
)

beforeEach(() => {
  window.localStorage.clear()
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: false,
      media: '',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
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
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('PostgreSQL 四级库导航与 MySQL 业务库默认选择', () => {
  it('PostgreSQL 列出全部物理库，跨库切换不串表并展示物化视图与查询 catalog', async () => {
    bridge.call.mockImplementation(async (method: string, args: Record<string, unknown>) => {
      if (method === 'mydshDatabase/status') {
        return { supported: true, connections: [profile('pg')], busyIds: [] }
      }
      if (method === 'mydshDatabase/databases') {
        return ['campus_meal', 'campus_meal_test', 'czxf', 'postgres']
      }
      if (method === 'mydshDatabase/schemas') {
        return args.catalog === 'campus_meal_test'
          ? ['public', 'analytics']
          : ['public', 'information_schema']
      }
      if (method === 'mydshDatabase/tables') {
        if (args.catalog === 'campus_meal' && args.schema === 'public') {
          return [{ name: 'meals', kind: 'table' }]
        }
        if (args.catalog === 'campus_meal_test' && args.schema === 'public') {
          return [{ name: 'mv_test_summary', kind: 'materialized_view' }]
        }
        return [{ name: 'pg_fallback', kind: 'table' }]
      }
      if (method === 'mydshDatabase/columns') {
        return [{ name: 'total', type: 'bigint', nullable: false, key: '' }]
      }
      if (method === 'mydshDatabase/preview' || method === 'mydshDatabase/query') {
        return result(`${args.catalog}.${args.schema}`)
      }
      return undefined
    })

    render(app())
    fireEvent.click(await screen.findByRole('button', { name: '打开连接 pgtest' }))

    await waitFor(() =>
      expect(document.querySelector('[data-database-catalog="campus_meal"]')).not.toBeNull(),
    )
    expect(document.querySelector('[data-database-catalog="campus_meal_test"]')).not.toBeNull()
    expect(document.querySelector('[data-database-catalog="czxf"]')).not.toBeNull()
    expect(document.querySelector('[data-database-catalog="postgres"]')).not.toBeNull()

    // 配置默认库为 postgres，因此初始加载 postgres，切到 campus_meal 后加载 meals，切到 campus_meal_test 后互不覆盖。
    fireEvent.click(document.querySelector('[data-database-catalog="campus_meal"]')!)
    await waitFor(() =>
      expect(document.querySelector('[data-database-table="meals"]')).not.toBeNull(),
    )

    fireEvent.click(document.querySelector('[data-database-catalog="campus_meal_test"]')!)
    await waitFor(() =>
      expect(document.querySelector('[data-database-table="mv_test_summary"]')).not.toBeNull(),
    )
    const tableList = screen.getByLabelText('数据库表列表')
    expect(tableList.textContent).toContain('物化视图')
    expect(screen.getByLabelText('当前数据库对象').textContent).toContain('campus_meal_test')

    fireEvent.click(screen.getByRole('button', { name: 'SQL 查询' }))
    fireEvent.change(screen.getByLabelText('SQL 查询内容'), { target: { value: 'SELECT 1' } })
    fireEvent.click(screen.getByRole('button', { name: '运行查询' }))
    await waitFor(() =>
      expect(bridge.call).toHaveBeenCalledWith(
        'mydshDatabase/query',
        { id: 'pg', catalog: 'campus_meal_test', schema: 'public', sql: 'SELECT 1' },
        expect.anything(),
      ),
    )
  })

  it('MySQL/MariaDB 默认库已失效时自动选中排在首位的业务数据库而非 information_schema', async () => {
    bridge.call.mockImplementation(async (method: string, args: Record<string, unknown>) => {
      if (method === 'mydshDatabase/status') {
        return {
          supported: true,
          connections: [profile('mysql', { engine: 'mysql', database: 'deleted_default' })],
          busyIds: [],
        }
      }
      if (method === 'mydshDatabase/schemas') {
        return ['orders_db', 'information_schema', 'mysql']
      }
      if (method === 'mydshDatabase/tables') {
        return args.schema === 'orders_db' ? [{ name: 'orders', kind: 'table' }] : []
      }
      return undefined
    })

    render(app())
    const openMysqlButton = await screen.findByRole('button', { name: '打开连接 mysqltest' })
    expect(document.querySelector('.database-tree-engine')).toBeNull()
    await waitFor(() =>
      expect(
        document.querySelector('.database-tree .database-engine-icon[data-engine="mysql"]'),
      ).not.toBeNull(),
    )

    fireEvent.click(openMysqlButton)
    await waitFor(() =>
      expect(document.querySelector('[data-database-table="orders"]')).not.toBeNull(),
    )
    expect(screen.getByLabelText('当前数据库对象').textContent).toContain('orders_db')
    expect(screen.getByLabelText('当前数据库对象').textContent).not.toContain('information_schema')
  })

  it('PostgreSQL 侧栏仅以引擎图标区分不显示文字标签，且遇无 CONNECT 权限库时自动回退可用库并保留库列表', async () => {
    bridge.call.mockImplementation(async (method: string, args: Record<string, unknown>) => {
      if (method === 'mydshDatabase/status') {
        return {
          supported: true,
          connections: [
            profile('pg', { database: null }),
            profile('mysql-disabled', {
              engine: 'mysql',
              name: '已停用库',
              disabled: true,
            }),
          ],
          busyIds: [],
        }
      }
      if (method === 'mydshDatabase/databases') {
        return ['campus_meal', 'campus_meal_test', 'postgres']
      }
      if (method === 'mydshDatabase/schemas') {
        if (args.catalog === 'campus_meal') {
          throw new Error('permission denied for database "campus_meal"')
        }
        return ['public']
      }
      if (method === 'mydshDatabase/tables') {
        return [{ name: 'smoke_table', kind: 'table' }]
      }
      return undefined
    })

    render(app())
    const pgRow = await waitFor(() => {
      const el = document.querySelector('[data-database-connection="pg"]')
      expect(el).not.toBeNull()
      return el!
    })
    expect(pgRow.textContent).toBe('pgtest')
    expect(
      document.querySelector('.database-tree .database-engine-icon[data-engine="postgresql"]'),
    ).not.toBeNull()
    expect(
      document.querySelector('[data-database-connection="mysql-disabled"]')?.textContent,
    ).toContain('已禁用')

    fireEvent.click(screen.getByRole('button', { name: '打开连接 pgtest' }))
    await waitFor(() =>
      expect(document.querySelector('[data-database-table="smoke_table"]')).not.toBeNull(),
    )
    expect(document.querySelector('[data-database-catalog="campus_meal"]')).not.toBeNull()
    expect(document.querySelector('[data-database-catalog="campus_meal_test"]')).not.toBeNull()
    expect(screen.getByLabelText('当前数据库对象').textContent).toContain('campus_meal_test')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('渲染四款官方数据库引擎 SVG 图标并为多个 SQLite 实例分配独立渐变 ID', () => {
    const { container } = render(
      <div>
        <DatabaseEngineIcon engine="mysql" />
        <DatabaseEngineIcon engine="postgresql" />
        <DatabaseEngineIcon engine="mariadb" />
        <DatabaseEngineIcon engine="sqlite" />
        <DatabaseEngineIcon engine="sqlite" />
      </div>,
    )
    const svgs = [...container.querySelectorAll('svg.database-engine-icon')]
    expect(svgs).toHaveLength(5)
    for (const svg of svgs) {
      expect(svg.getAttribute('viewBox')).toBe('0 0 128 128')
    }
    const gradients = [...container.querySelectorAll('linearGradient')]
    expect(gradients).toHaveLength(2)
    const ids = gradients.map(node => node.getAttribute('id'))
    expect(ids[0]).toBeTruthy()
    expect(ids[1]).toBeTruthy()
    expect(ids[0]).not.toBe(ids[1])
  })

  it('侧栏与顶栏实时呈现连接与库级状态，报错使用悬浮 AppAlert 且支持断开连接', async () => {
    bridge.call.mockImplementation(async (method: string, args: Record<string, unknown>) => {
      if (method === 'mydshDatabase/status') {
        return { supported: true, connections: [profile('pg', { database: null })], busyIds: [] }
      }
      if (method === 'mydshDatabase/databases') {
        return ['czxf', 'postgres', 'campus_meal_test']
      }
      if (method === 'mydshDatabase/schemas') {
        if (args.catalog === 'campus_meal_test') {
          throw new Error('permission denied for database "campus_meal_test"')
        }
        return ['public']
      }
      if (method === 'mydshDatabase/tables') {
        return [{ name: 'orders', kind: 'table' }]
      }
      return undefined
    })

    render(app())
    const openBtn = await screen.findByRole('button', { name: '打开连接 pgtest' })
    expect(document.querySelector('[data-connection-state="connected"]')).toBeNull()

    fireEvent.click(openBtn)
    await waitFor(() =>
      expect(document.querySelector('[data-database-table="orders"]')).not.toBeNull(),
    )
    expect(
      document.querySelector('[data-database-connection="pg"] [data-connection-state="connected"]'),
    ).not.toBeNull()
    expect(
      document.querySelector('[data-database-catalog="czxf"] [data-catalog-state="connected"]'),
    ).not.toBeNull()
    expect(
      document.querySelector('[data-database-catalog="postgres"] [data-catalog-state="connected"]'),
    ).toBeNull()
    expect(
      document.querySelector('.database-heading [data-connection-state="connected"]'),
    ).not.toBeNull()

    // 点击无权限库：以悬浮 AppAlert 提示而非内联 .ant-alert 占位，同时在该库节点标注异常。
    fireEvent.click(document.querySelector('[data-database-catalog="campus_meal_test"]')!)
    await waitFor(() =>
      expect(
        document.querySelector('.app-alert--floating.app-alert--error')?.textContent,
      ).toContain('permission denied for database "campus_meal_test"'),
    )
    expect(document.querySelector('.connections-content .ant-alert')).toBeNull()
    expect(
      document.querySelector(
        '[data-database-catalog="campus_meal_test"] [data-catalog-state="error"]',
      ),
    ).not.toBeNull()

    // 断开连接后清除绿色在线状态并调用 close。
    fireEvent.click(screen.getByRole('button', { name: '断开连接 pgtest' }))
    await waitFor(() =>
      expect(bridge.call).toHaveBeenCalledWith(
        'mydshDatabase/close',
        { id: 'pg' },
        expect.anything(),
      ),
    )
    expect(
      document.querySelector('[data-database-connection="pg"] [data-connection-state="connected"]'),
    ).toBeNull()
    expect(
      document.querySelector('.database-heading [data-connection-state="disconnected"]'),
    ).not.toBeNull()
    // 未连接时面包屑不渲染默认物理库按钮，避免误导用户以为已经连入该库。
    expect(screen.getByLabelText('当前数据库对象').textContent).toBe('pgtest')
  })

  it('已连接状态在查询或拉表期间不回退成连接中，断开入口保持稳定', () => {
    expect(
      resolveConnectionState({
        profile: profile('pg'),
        view: { catalogs: ['postgres'], schemas: ['public'], connectionError: null },
        connectingId: 'pg',
        busyIds: ['pg'],
      }),
    ).toBe('connected')
    expect(
      resolveConnectionState({
        profile: profile('pg'),
        view: { catalogs: null, schemas: null, connectionError: null },
        connectingId: 'pg',
        busyIds: [],
      }),
    ).toBe('connecting')
  })

  it('主区停留在浏览器标签时点击左侧数据库连接会切回数据库主区', async () => {
    const previous = bridge.snapshot
    bridge.setView.mockReset()
    bridge.snapshot = {
      activeView: 'browser',
      navigationView: 'database',
      projects: [],
      selectedProjectId: null,
    } as typeof bridge.snapshot
    try {
      render(app())
      await waitFor(() =>
        expect(document.querySelector('[data-database-connection="pg"]')).not.toBeNull(),
      )
      fireEvent.click(document.querySelector('[data-database-connection="pg"]')!)
      expect(bridge.setView).toHaveBeenCalledWith('database')
    } finally {
      bridge.snapshot = previous
    }
  })
})
