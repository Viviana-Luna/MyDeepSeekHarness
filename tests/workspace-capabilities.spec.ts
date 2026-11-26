import { describe, expect, it } from 'vitest'

import {
  DESKTOP_ARCHIVED_SESSION_ID_MAX_LENGTH,
  DESKTOP_ARCHIVED_SESSION_MAX_ITEMS,
  DESKTOP_WORKSPACE_ID_MAX_LENGTH,
  DESKTOP_WORKSPACE_MAX_ITEMS,
  parseDesktopWorkspaceArchiveSnapshot,
  parseDesktopWorkspaceCreateResult,
  parseDesktopWorkspaceListResult,
  parseDesktopWorkspaceOrderResult,
  parseDesktopWorkspaceSessionCreateResult,
} from '../src/shared/workspace-capabilities.ts'

const workspace = {
  workspaceId: '工作区-1',
  path: '/Users/test-user/项目一',
  title: '项目一',
  sessionIds: ['会话-2', '会话-1'],
  createdAt: '2026-08-29T16:00:00.000Z',
  updatedAt: '2026-08-30T01:00:00.000Z',
}

describe('Workspace 归档会话集合安全解析', () => {
  it('只保留完整归档 ID 集合，不把 Workspace 路径带进 renderer', () => {
    expect(
      parseDesktopWorkspaceArchiveSnapshot({
        items: [{ workspaceId: '工作区-1', path: '/Users/test-user/不得外发' }],
        archivedSessionIds: ['会话-1', '会话-2'],
        internal: '不外发',
      }),
    ).toEqual({ archivedSessionIds: ['会话-1', '会话-2'] })
  })

  it('拒绝重复、空值、超长 ID 和超大集合', () => {
    const invalid = [
      { archivedSessionIds: ['会话-1', '会话-1'] },
      { archivedSessionIds: [''] },
      { archivedSessionIds: ['会'.repeat(DESKTOP_ARCHIVED_SESSION_ID_MAX_LENGTH + 1)] },
      {
        archivedSessionIds: Array.from(
          { length: DESKTOP_ARCHIVED_SESSION_MAX_ITEMS + 1 },
          (_, index) => `会话-${String(index)}`,
        ),
      },
    ]
    for (const value of invalid) {
      expect(() => parseDesktopWorkspaceArchiveSnapshot(value)).toThrow('无效的归档会话集合')
    }
  })
})

describe('Durable Workspace 结果安全解析', () => {
  it('保留 Host 的 Workspace 与 Session 持久化顺序并裁掉未知字段', () => {
    expect(
      parseDesktopWorkspaceListResult({
        items: [
          { ...workspace, internal: '不外发' },
          {
            ...workspace,
            workspaceId: '工作区-2',
            path: '/Users/test-user/项目二',
            title: '项目二',
            sessionIds: ['会话-3'],
          },
        ],
        archivedSessionIds: ['会话-1'],
        internal: '不外发',
      }),
    ).toEqual({
      items: [
        workspace,
        {
          ...workspace,
          workspaceId: '工作区-2',
          path: '/Users/test-user/项目二',
          title: '项目二',
          sessionIds: ['会话-3'],
        },
      ],
      archivedSessionIds: ['会话-1'],
    })
  })

  it('解析幂等创建、完整排序和按 Workspace 创建 Session 的结果', () => {
    expect(
      parseDesktopWorkspaceCreateResult({
        ['workspace']: { ...workspace, secret: '不外发' },
        created: false,
        internal: true,
      }),
    ).toEqual({ workspace, created: false })
    expect(
      parseDesktopWorkspaceOrderResult({
        workspaceIds: ['工作区-2', '工作区-1'],
        internal: true,
      }),
    ).toEqual({ workspaceIds: ['工作区-2', '工作区-1'] })
    expect(
      parseDesktopWorkspaceSessionCreateResult({
        sessionId: '会话-4',
        agentPreset: 'standard',
        cwd: '/不得外发',
      }),
    ).toEqual({ sessionId: '会话-4', agentPreset: 'standard' })
  })

  it('拒绝缺字段、重复身份、跨 Workspace 重复会话与无效路径或时间', () => {
    const invalidLists = [
      { items: [{ ...workspace, workspaceId: '' }], archivedSessionIds: [] },
      { items: [{ ...workspace, path: '相对路径' }], archivedSessionIds: [] },
      { items: [{ ...workspace, createdAt: '不是时间' }], archivedSessionIds: [] },
      { items: [workspace, workspace], archivedSessionIds: [] },
      {
        items: [
          workspace,
          {
            ...workspace,
            workspaceId: '工作区-2',
            path: '/Users/test-user/项目二',
            sessionIds: ['会话-1'],
          },
        ],
        archivedSessionIds: [],
      },
      {
        items: Array.from({ length: DESKTOP_WORKSPACE_MAX_ITEMS + 1 }, (_, index) => ({
          ...workspace,
          workspaceId: `工作区-${String(index)}`,
          path: `/Users/test-user/项目-${String(index)}`,
          sessionIds: [],
        })),
        archivedSessionIds: [],
      },
    ]
    for (const value of invalidLists) {
      expect(() => parseDesktopWorkspaceListResult(value)).toThrow('无效的 Workspace')
    }

    expect(() =>
      parseDesktopWorkspaceCreateResult({
        workspace,
        created: 'true',
      }),
    ).toThrow('无效的 Workspace 创建结果')
    expect(() =>
      parseDesktopWorkspaceOrderResult({
        workspaceIds: ['工作区-1', '工作区-1'],
      }),
    ).toThrow('无效的 Workspace 顺序')
    expect(() =>
      parseDesktopWorkspaceOrderResult({
        workspaceIds: ['工'.repeat(DESKTOP_WORKSPACE_ID_MAX_LENGTH + 1)],
      }),
    ).toThrow('无效的 Workspace ID')
    expect(() =>
      parseDesktopWorkspaceSessionCreateResult({
        sessionId: '',
      }),
    ).toThrow('无效的 Session 创建结果')
  })
})
