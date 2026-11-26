// @vitest-environment jsdom
/** 验证数据库变更与 DDL 单次确认卡片交互：单次批量授权、会话级放行、拒绝及与普通问答路由隔离。 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PendingInteractionPanel } from '../src/renderer/src/features/composer/PendingInteractionPanel.tsx'
import type { DesktopPendingInteraction } from '../src/renderer/src/platform/contracts.ts'

const harness = vi.hoisted(() => ({
  respondPendingInteraction: vi.fn(),
  sessionId: 'session-db-consent',
}))

vi.mock('../src/renderer/src/hooks/useWorkspace.ts', () => ({
  useWorkspaceSnapshot: () => ({
    selectedSessionId: harness.sessionId,
    sessions: [{ sessionId: harness.sessionId }],
  }),
  useWorkspaceStore: () => ({
    respondPendingInteraction: harness.respondPendingInteraction,
  }),
}))

afterEach(() => {
  cleanup()
  harness.respondPendingInteraction.mockReset()
})

function consentInteraction(count: number): DesktopPendingInteraction {
  const allowOnce = count === 1 ? '允许本次操作' : `允许本次（全部 ${count} 条）`
  const sql = [
    '-- [1/2] INSERT orders.items',
    "INSERT INTO orders.items (name) VALUES ('```');",
    '-- [2/2] ALTER TABLE orders.audit_log',
    'ALTER TABLE orders.audit_log ADD COLUMN note VARCHAR(64);',
  ].join('\n')
  return {
    kind: 'question',
    key: 'q-db-1',
    questions: [
      {
        id: 'mydsh-database-consent:conn-1',
        header: '数据库变更确认',
        question: `允许对数据库连接「测试主库」执行以下 ${count} 条操作吗？`,
        detail: [
          '- 连接：测试主库 (127.0.0.1:3306)',
          '- 涉及对象：orders.items (INSERT)、orders.audit_log (DDL)',
          '',
          '```sql',
          sql,
          '```',
          '',
          `MYDSH_DATABASE_SQL_PREVIEW_V1:${Buffer.from(sql).toString('base64url')}`,
        ].join('\n'),
        options: [
          { label: allowOnce, description: '只授权本次调用中的全部语句执行一次。' },
          { label: '本次会话允许该连接变更', description: '当前会话内不再重复确认。' },
          { label: '拒绝', description: '拒绝本次请求。' },
        ],
      },
    ],
  }
}

it('批量操作与 DDL 在一张确认卡片中一次点击即可放行，不展示通用跳过与自由输入框', async () => {
  harness.respondPendingInteraction.mockResolvedValue({ accepted: true })
  render(<PendingInteractionPanel interaction={consentInteraction(2)} />)

  expect(screen.getByLabelText('数据库变更确认')).toBeTruthy()
  expect(screen.getByLabelText('待执行 SQL 语句').textContent).toContain(
    'ALTER TABLE orders.audit_log',
  )
  expect(screen.getByLabelText('待执行 SQL 语句').textContent).toContain("'```'")
  expect(screen.queryByRole('button', { name: '跳过此题' })).toBeNull()
  expect(screen.queryByPlaceholderText('输入你的回答')).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: '允许本次（全部 2 条）' }))
  await waitFor(() =>
    expect(harness.respondPendingInteraction).toHaveBeenCalledWith({
      kind: 'question',
      sessionId: harness.sessionId,
      key: 'q-db-1',
      answers: [
        {
          id: 'mydsh-database-consent:conn-1',
          selected: ['允许本次（全部 2 条）'],
        },
      ],
    }),
  )
})

it('支持一次点击记住本次会话授权或直接拒绝本次数据库变更', async () => {
  harness.respondPendingInteraction.mockResolvedValue({ accepted: true })
  const first = render(<PendingInteractionPanel interaction={consentInteraction(1)} />)
  fireEvent.click(screen.getByRole('button', { name: '本次会话允许该连接变更' }))
  await waitFor(() =>
    expect(harness.respondPendingInteraction).toHaveBeenLastCalledWith({
      kind: 'question',
      sessionId: harness.sessionId,
      key: 'q-db-1',
      answers: [
        {
          id: 'mydsh-database-consent:conn-1',
          selected: ['本次会话允许该连接变更'],
        },
      ],
    }),
  )
  first.unmount()

  render(<PendingInteractionPanel interaction={consentInteraction(1)} />)
  fireEvent.click(screen.getByRole('button', { name: '拒绝' }))
  await waitFor(() =>
    expect(harness.respondPendingInteraction).toHaveBeenLastCalledWith({
      kind: 'question',
      sessionId: harness.sessionId,
      key: 'q-db-1',
      answers: [
        {
          id: 'mydsh-database-consent:conn-1',
          selected: ['拒绝'],
        },
      ],
    }),
  )
})

it('提权确认卡片展示权限升级说明，并支持单次或会话级提权响应', async () => {
  harness.respondPendingInteraction.mockResolvedValue({ accepted: true })
  const sql = "INSERT INTO orders.items (name) VALUES ('elevated');"
  const interaction: DesktopPendingInteraction = {
    kind: 'question',
    key: 'q-db-elevate',
    questions: [
      {
        id: 'mydsh-database-consent:conn-1',
        header: '数据库权限提权',
        question: '当前权限不允许这次操作。是否临时提权并执行以下 1 条语句？',
        detail: [
          '- 连接：测试主库 (127.0.0.1:3306)',
          '- 权限：只读 → 数据读写',
          '',
          '```sql',
          sql,
          '```',
          '',
          `MYDSH_DATABASE_SQL_PREVIEW_V1:${Buffer.from(sql).toString('base64url')}`,
        ].join('\n'),
        options: [
          { label: '提权并允许本次操作', description: '只授权本次调用中的全部操作执行一次。' },
          { label: '本次会话允许该提权', description: '当前会话内记住这次提权。' },
          { label: '拒绝', description: '拒绝本次请求。' },
        ],
      },
    ],
  }

  render(<PendingInteractionPanel interaction={interaction} />)
  expect(screen.getByLabelText('数据库权限提权')).toBeTruthy()
  expect(screen.getByText('权限：只读 → 数据读写')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '本次会话允许该提权' }))
  await waitFor(() =>
    expect(harness.respondPendingInteraction).toHaveBeenLastCalledWith({
      kind: 'question',
      sessionId: harness.sessionId,
      key: 'q-db-elevate',
      answers: [
        {
          id: 'mydsh-database-consent:conn-1',
          selected: ['本次会话允许该提权'],
        },
      ],
    }),
  )
})
