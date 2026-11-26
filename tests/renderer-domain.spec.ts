import { describe, expect, it } from 'vitest'

import {
  deriveProjects,
  deriveWorkspaceProjects,
  projectIdForCwd,
  sessionsForProject,
  UNGROUPED_PROJECT_ID,
} from '../src/renderer/src/domain/project.ts'
import {
  parseSessionList,
  sessionTitle,
  type SessionSummary,
} from '../src/renderer/src/domain/session.ts'

function session(sessionId: string, updatedAt: number, cwd?: string): SessionSummary {
  return {
    sessionId,
    updatedAt,
    running: false,
    blank: false,
    ...(cwd === undefined ? {} : { cwd }),
  }
}

describe('renderer Session 领域模型', () => {
  it('过滤无效项、规范状态并按最近活动排序', () => {
    expect(
      parseSessionList({
        items: [
          { sessionId: '较早', updatedAt: 10, status: 'running', blank: false, cwd: '/项目/甲' },
          { sessionId: '', updatedAt: 99 },
          null,
          { sessionId: '最近', updatedAt: 30, running: false, blank: true },
          { sessionId: '时间无效', updatedAt: '未知' },
        ],
      }),
    ).toEqual({
      items: [
        expect.objectContaining({ sessionId: '最近', updatedAt: 30, blank: true }),
        expect.objectContaining({
          sessionId: '较早',
          updatedAt: 10,
          running: true,
          cwd: '/项目/甲',
        }),
        expect.objectContaining({ sessionId: '时间无效', updatedAt: 0 }),
      ],
    })
    expect(parseSessionList(undefined)).toEqual({ items: [] })
  })

  it('按投影、显式标题、名称和空白状态依次选择标题', () => {
    const base = session('会话', 1)
    expect(
      sessionTitle({
        ...base,
        projections: { values: { title: '  投影标题  ' } },
        title: '显式标题',
        name: '名称',
      }),
    ).toBe('  投影标题  ')
    expect(sessionTitle({ ...base, title: '显式标题', name: '名称' })).toBe('显式标题')
    expect(sessionTitle({ ...base, name: '名称' })).toBe('名称')
    expect(sessionTitle({ ...base, blank: true })).toBe('新会话')
    expect(sessionTitle(base)).toBe('未命名会话')
  })
})

describe('renderer 项目领域模型', () => {
  it('按 cwd 聚合项目，并把缺少 cwd 的 Session 放入无项目对话', () => {
    const sessions = [
      session('甲一', 50, '/Users/luna/work/甲'),
      session('甲二', 80, '/Users/luna/work/甲'),
      session('乙一', 70, '/opt/work/乙'),
      session('散落一', 90),
      session('散落二', 40),
    ]

    const projects = deriveProjects(sessions)
    expect(projects).toEqual([
      expect.objectContaining({
        id: UNGROUPED_PROJECT_ID,
        name: '无项目对话',
        sessionCount: 2,
        lastActivity: 90,
      }),
      expect.objectContaining({
        id: projectIdForCwd('/Users/luna/work/甲'),
        name: '甲',
        displayPath: '~/work/甲',
        sessionCount: 2,
        lastActivity: 80,
      }),
      expect.objectContaining({
        id: projectIdForCwd('/opt/work/乙'),
        name: '乙',
        displayPath: '/opt/work/乙',
        sessionCount: 1,
        lastActivity: 70,
      }),
    ])
  })

  it('只返回所选项目内的 Session', () => {
    const sessions = [
      session('甲', 30, '/work/甲'),
      session('乙', 20, '/work/乙'),
      session('无项目', 10),
    ]
    const projects = deriveProjects(sessions)

    expect(
      sessionsForProject(
        sessions,
        projects.find(project => project.id === projectIdForCwd('/work/乙')),
      ).map(item => item.sessionId),
    ).toEqual(['乙'])
    expect(
      sessionsForProject(
        sessions,
        projects.find(project => project.id === UNGROUPED_PROJECT_ID),
      ).map(item => item.sessionId),
    ).toEqual(['无项目'])
    expect(sessionsForProject(sessions, undefined)).toEqual([])

    const durableSessions = [...sessions, session('散落工作目录', 5, '/work/散落')]
    const durable = deriveWorkspaceProjects(
      durableSessions,
      [
        {
          workspaceId: '工作区-甲',
          path: '/work/甲',
          title: '甲工作区',
          sessionIds: ['乙', '甲'],
          createdAt: '2026-08-29T16:00:00.000Z',
          updatedAt: '2026-08-30T01:00:00.000Z',
        },
      ],
      [
        {
          id: '受信任-甲',
          name: '甲',
          cwd: '/work/甲',
          displayPath: '/work/甲',
          sessionCount: 2,
          lastActivity: 30,
        },
      ],
    )
    expect(durable.map(project => project.id)).toEqual([
      projectIdForCwd('/work/甲'),
      UNGROUPED_PROJECT_ID,
    ])
    expect(durable[0]?.projectAccessId).toBe('受信任-甲')
    expect(sessionsForProject(durableSessions, durable[0]).map(item => item.sessionId)).toEqual([
      '乙',
      '甲',
    ])
    expect(sessionsForProject(durableSessions, durable[1]).map(item => item.sessionId)).toEqual([
      '无项目',
      '散落工作目录',
    ])
  })
})
