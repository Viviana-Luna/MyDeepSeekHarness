import { describe, expect, it, vi } from 'vitest'

import {
  callDshHost,
  DSH_HOST_OPERATIONS,
  respondDshInteraction,
  SESSION_COMMAND_EXECUTION_TIMEOUT_MS,
} from '../src/main/host/host-client.ts'

function responseFetch(value: unknown) {
  return vi.fn<typeof fetch>(async (_input, init) => {
    if (typeof init?.body !== 'string') throw new Error('测试请求必须包含 JSON body')
    const request = JSON.parse(init.body) as { rpcId: string }
    return Response.json({
      type: 'server-response',
      rpcId: request.rpcId,
      result: { ok: true, value },
    })
  })
}

describe('目标和子智能体固定操作', () => {
  const target = new URL('http://127.0.0.1:3080/')
  const ref = { id: 'goal-1', revision: 2 }
  const goal = {
    ...ref,
    objective: '核对插件',
    phase: 'paused',
    activation: 'disarmed',
    maxGoalRounds: 4,
    roundsStarted: 1,
    createdAt: 1,
    updatedAt: 2,
  }

  it('目标携带版本，子智能体携带父子地址和稳定请求标识，仅访问固定接口', async () => {
    const fetchImpl = responsesByMethod({
      'goals/get': goal,
      'goals/create': { ref },
      'goals/edit': goal,
      'goals/pause': goal,
      'goals/resume': goal,
      'goals/complete': goal,
      'goals/clear': ref,
      'subagents/list': {
        entries: [
          {
            kind: 'child',
            id: '子会话',
            mode: 'continuable',
            label: '调查',
            activity: 'inactive',
            hasChildren: false,
          },
        ],
        parentAvailable: true,
      },
      'subagents/prompt': { messageId: '消息-1' },
      'subagents/interruptByParent': { accepted: true },
    })
    await callDshHost(target, 'getSessionGoal', { sessionId: '父会话' }, fetchImpl)
    await callDshHost(
      target,
      'createSessionGoal',
      { sessionId: '父会话', objective: '核对插件', maxGoalRounds: 4 },
      fetchImpl,
    )
    await callDshHost(
      target,
      'editSessionGoal',
      { sessionId: '父会话', ref, objective: '更新目标' },
      fetchImpl,
    )
    await Promise.all(
      ['pauseSessionGoal', 'resumeSessionGoal', 'completeSessionGoal', 'clearSessionGoal'].map(
        operation => callDshHost(target, operation, { sessionId: '父会话', ref }, fetchImpl),
      ),
    )
    expect(
      await callDshHost(target, 'listSessionSubagents', { parentSessionId: '父会话' }, fetchImpl),
    ).toMatchObject({ parentAvailable: true })
    await callDshHost(
      target,
      'promptSessionSubagent',
      {
        parentSessionId: '父会话',
        childSessionId: '子会话',
        text: '继续调查',
        delivery: 'queue',
        requestId: 'stable-request',
      },
      fetchImpl,
    )
    await callDshHost(
      target,
      'interruptSessionSubagent',
      { parentSessionId: '父会话', childSessionId: '子会话' },
      fetchImpl,
    )
    const requests = fetchImpl.mock.calls.map(
      ([, init]) => JSON.parse(init!.body as string) as { method: string; payload: unknown },
    )
    expect(requests[2]).toMatchObject({
      method: 'goals/edit',
      payload: { args: { agentId: '父会话', ref, request: { objective: '更新目标' } } },
    })
    expect(requests[8]).toMatchObject({
      method: 'subagents/prompt',
      payload: {
        args: {
          request: {
            parentSessionId: '父会话',
            childSessionId: '子会话',
            mode: 'continuable',
            requestId: 'stable-request',
            delivery: 'queue',
            content: [{ type: 'text', text: '继续调查' }],
          },
        },
      },
    })
  })

  it('拒绝 endpoint 注入、无效版本和非法结果，并翻译认证、权限、缺失能力与版本冲突', async () => {
    const fetchImpl = responseFetch(goal)
    await expect(
      callDshHost(
        target,
        'getSessionGoal',
        { sessionId: '父会话', endpoint: 'credentials/set' },
        fetchImpl,
      ),
    ).rejects.toThrow('未知字段')
    await expect(
      callDshHost(
        target,
        'pauseSessionGoal',
        { sessionId: '父会话', ref: { ...ref, revision: -1 } },
        fetchImpl,
      ),
    ).rejects.toThrow('数字')
    await expect(
      callDshHost(
        target,
        'promptSessionSubagent',
        { parentSessionId: '父会话', childSessionId: '父会话' },
        fetchImpl,
      ),
    ).rejects.toThrow('相同')
    expect(fetchImpl).not.toHaveBeenCalled()
    await expect(
      callDshHost(
        target,
        'getSessionGoal',
        { sessionId: '父会话' },
        responseFetch({ ...goal, activation: '伪造' }),
      ),
    ).rejects.toThrow('激活状态')
    await expect(
      callDshHost(
        target,
        'listSessionSubagents',
        { parentSessionId: '父会话' },
        responseFetch({ entries: [{ kind: 'child' }], parentAvailable: true }),
      ),
    ).rejects.toThrow('文本字段')
    await Promise.all(
      [
        [401, '未授权请求'],
        [403, '拒绝'],
        [404, '未提供'],
      ].map(async ([status, expected]) => {
        await expect(
          callDshHost(
            target,
            'getSessionGoal',
            { sessionId: '父会话' },
            async () => new Response(null, { status: status as number }),
          ),
        ).rejects.toThrow(expected as string)
      }),
    )
    await expect(
      callDshHost(target, 'pauseSessionGoal', { sessionId: '父会话', ref }, async (_input, init) =>
        Response.json({
          type: 'server-response',
          rpcId: JSON.parse(init!.body as string).rpcId,
          result: { ok: false, error: { code: 'GOAL_STALE_REVISION', message: 'stale' } },
        }),
      ),
    ).rejects.toThrow('目标已在其他位置更新')
    await expect(
      callDshHost(
        target,
        'interruptSessionSubagent',
        { parentSessionId: '父会话', childSessionId: '子会话' },
        async (_input, init) =>
          Response.json({
            type: 'server-response',
            rpcId: JSON.parse(init!.body as string).rpcId,
            result: { ok: false, error: { code: 'subagent/unauthorized' } },
          }),
      ),
    ).rejects.toThrow('不属于当前父会话')
    const controller = new AbortController()
    controller.abort()
    await expect(
      callDshHost(
        target,
        'getSessionGoal',
        { sessionId: '父会话' },
        async (_input, init) => {
          init?.signal?.throwIfAborted()
          return Response.json({})
        },
        undefined,
        controller.signal,
      ),
    ).rejects.toThrow('插件请求已取消或超时')
  })
})

function responsesByMethod(values: Readonly<Record<string, unknown>>) {
  return vi.fn<typeof fetch>(async (_input, init) => {
    if (typeof init?.body !== 'string') throw new Error('测试请求必须包含 JSON body')
    const request = JSON.parse(init.body) as { rpcId: string; method: string }
    if (!Object.hasOwn(values, request.method)) {
      throw new Error(`测试没有为 ${request.method} 配置响应`)
    }
    return Response.json({
      type: 'server-response',
      rpcId: request.rpcId,
      result: { ok: true, value: values[request.method] },
    })
  })
}

function requestOf(fetchImpl: ReturnType<typeof responseFetch>) {
  const [input, init] = fetchImpl.mock.calls[0] ?? []
  if (!(input instanceof URL) || typeof init?.body !== 'string')
    throw new Error('没有捕获到 Host 请求')
  return { url: input, body: JSON.parse(init.body) as Record<string, unknown> }
}

async function callAndReadRequest(
  operation: Parameters<typeof callDshHost>[1],
  payload: Parameters<typeof callDshHost>[2],
) {
  const fetchImpl = responseFetch({ accepted: true })
  await callDshHost(new URL('http://127.0.0.1:3080/'), operation, payload, fetchImpl)
  return requestOf(fetchImpl)
}

describe('DSH Host 会话控制白名单', () => {
  it('通过会话附件公开接口读取图片，并拒绝伪造的图片类型', async () => {
    const payload = { sessionId: '会话-1', attachmentId: '图片-1' }
    const value = {
      attachment: { attachmentId: '图片-1', mediaType: 'image/png' },
      data: 'iVBORw0KGgo=',
    }
    const fetchImpl = responseFetch(value)
    expect(
      await callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'getSessionAttachment',
        payload,
        fetchImpl,
      ),
    ).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(requestOf(fetchImpl).body.method).toBe('session/attachment')
    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'getSessionAttachment',
        payload,
        responseFetch({ ...value, data: 'PHNjcmlwdD4=' }),
      ),
    ).rejects.toThrow()
  })

  it('待用户响应只回填 Remote 关联值到固定 $events/result', async () => {
    const requests: Array<{ url: string; body: unknown; cookie: string | null }> = []
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (!(input instanceof URL) || typeof init?.body !== 'string')
        throw new Error('缺少交互应答请求')
      requests.push({
        url: input.href,
        body: JSON.parse(init.body),
        cookie: new Headers(init.headers).get('cookie'),
      })
      const request = JSON.parse(init.body) as { rpcId: string }
      return Response.json({
        type: 'server-response',
        rpcId: request.rpcId,
        result: { ok: true },
      })
    })

    await expect(
      respondDshInteraction(
        new URL('http://127.0.0.1:3080/'),
        'client-1',
        'event-approval',
        { kind: 'result', value: 'allowed-once' },
        fetchImpl,
        'dsh-auth=secret',
      ),
    ).resolves.toEqual({ accepted: true })
    await expect(
      respondDshInteraction(
        new URL('http://127.0.0.1:3080/'),
        'client-1',
        'event-question',
        { kind: 'result', value: { answers: [{ id: 'city', selected: ['北京'] }] } },
        fetchImpl,
        'dsh-auth=secret',
      ),
    ).resolves.toEqual({ accepted: true })

    expect(requests).toEqual([
      {
        url: 'http://127.0.0.1:3080/api/$events/result',
        cookie: 'dsh-auth=secret',
        body: expect.objectContaining({
          type: 'client-request',
          method: '$events/result',
          payload: {
            args: {
              clientId: 'client-1',
              eventId: 'event-approval',
              outcome: { kind: 'result', value: 'allowed-once' },
            },
          },
        }),
      },
      {
        url: 'http://127.0.0.1:3080/api/$events/result',
        cookie: 'dsh-auth=secret',
        body: expect.objectContaining({
          type: 'client-request',
          method: '$events/result',
          payload: {
            args: {
              clientId: 'client-1',
              eventId: 'event-question',
              outcome: {
                kind: 'result',
                value: { answers: [{ id: 'city', selected: ['北京'] }] },
              },
            },
          },
        }),
      },
    ])
  })

  it('归档经 MyDSH 停止会话，恢复和永久删除使用固定接口及严格载荷', async () => {
    const archiveFetch = responseFetch({ archivedSessionIds: ['旧会话', '会话-1'] })
    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'archiveSession',
        { sessionId: '会话-1' },
        archiveFetch,
      ),
    ).resolves.toEqual({ archivedSessionIds: ['旧会话', '会话-1'] })
    expect(requestOf(archiveFetch)).toMatchObject({
      url: new URL('http://127.0.0.1:3080/api/mydshSessions/archiveSession'),
      body: {
        method: 'mydshSessions/archiveSession',
        payload: { args: { sessionId: '会话-1' } },
      },
    })

    const rejectedFetch = responseFetch({ archivedSessionIds: [] })
    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'archiveSession',
        { sessionId: '会话-1', endpoint: 'workspace.delete' },
        rejectedFetch,
      ),
    ).rejects.toThrow('会话归档请求包含未知字段 endpoint')
    expect(rejectedFetch).not.toHaveBeenCalled()

    const restoreFetch = responseFetch({ archivedSessionIds: ['旧会话'] })
    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'unarchiveSession',
        { sessionId: '会话-1' },
        restoreFetch,
      ),
    ).resolves.toEqual({ archivedSessionIds: ['旧会话'] })
    expect(requestOf(restoreFetch)).toMatchObject({
      body: {
        method: 'workspace/unarchiveSession',
        payload: { args: { request: { sessionId: '会话-1' } } },
      },
    })
    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'unarchiveSession',
        { sessionId: '会话-1', path: '/不可访问' },
        rejectedFetch,
      ),
    ).rejects.toThrow('会话归档请求包含未知字段 path')
    const deleteFetch = responseFetch({ archivedSessionIds: [] })
    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'deleteArchivedSession',
        { sessionId: '会话-1' },
        deleteFetch,
      ),
    ).resolves.toEqual({ archivedSessionIds: [] })
    expect(requestOf(deleteFetch)).toMatchObject({
      body: {
        method: 'mydshSessions/deleteArchivedSession',
        payload: { args: { sessionId: '会话-1' } },
      },
    })
    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'deleteArchivedSession',
        { sessionId: '会话-1', path: '/不可访问' },
        rejectedFetch,
      ),
    ).rejects.toThrow('会话归档请求包含未知字段 path')
    expect(rejectedFetch).not.toHaveBeenCalled()
  })

  it('消息反馈只暴露官方 Remote 的读取、更新和删除，并保留版本冲突', async () => {
    const feedback = { messageId: 'assistant-message-1', rating: 'positive', version: 'v1' }
    const listFetch = responseFetch({
      ok: true,
      value: { items: [feedback], note: '不应进入桌面' },
    })
    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'listMessageFeedback',
        { sessionId: '会话-1' },
        listFetch,
      ),
    ).resolves.toEqual({ items: [feedback] })
    expect(requestOf(listFetch)).toMatchObject({
      url: new URL('http://127.0.0.1:3080/api/messageFeedback/list'),
      body: {
        method: 'messageFeedback/list',
        payload: { args: { request: { sessionId: '会话-1' } } },
      },
    })

    const putFetch = responseFetch({ ok: true, value: feedback })
    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'putMessageFeedback',
        {
          sessionId: '会话-1',
          messageId: 'assistant-message-1',
          rating: 'positive',
          ifVersion: null,
        },
        putFetch,
      ),
    ).resolves.toEqual({ kind: 'committed', item: feedback })
    expect(requestOf(putFetch)).toMatchObject({
      url: new URL('http://127.0.0.1:3080/api/messageFeedback/put'),
      body: {
        method: 'messageFeedback/put',
        payload: {
          args: {
            request: {
              sessionId: '会话-1',
              messageId: 'assistant-message-1',
              rating: 'positive',
              ifVersion: null,
            },
          },
        },
      },
    })

    const deleteFetch = responseFetch({
      ok: false,
      error: { code: 'version-conflict', current: feedback },
    })
    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'deleteMessageFeedback',
        { sessionId: '会话-1', messageId: 'assistant-message-1', ifVersion: 'v0' },
        deleteFetch,
      ),
    ).resolves.toEqual({ kind: 'version-conflict', current: feedback })
    expect(requestOf(deleteFetch)).toMatchObject({
      url: new URL('http://127.0.0.1:3080/api/messageFeedback/delete'),
      body: {
        method: 'messageFeedback/delete',
        payload: {
          args: {
            request: { sessionId: '会话-1', messageId: 'assistant-message-1', ifVersion: 'v0' },
          },
        },
      },
    })

    const rejectedFetch = responseFetch({ ok: true, value: feedback })
    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'putMessageFeedback',
        {
          sessionId: '会话-1',
          messageId: 'assistant-message-1',
          rating: 'positive',
          ifVersion: null,
          note: '不在桌面端提供备注输入',
        },
        rejectedFetch,
      ),
    ).rejects.toThrow('消息反馈更新请求包含未知字段 note')
    expect(rejectedFetch).not.toHaveBeenCalled()
  })

  it('Durable Workspace 写动作使用固定公开 API、严格载荷和收窄结果', async () => {
    const workspace = {
      workspaceId: '工作区-1',
      path: '/Users/test-user/项目一',
      title: '项目一',
      sessionIds: ['会话-1'],
      createdAt: '2026-08-29T16:00:00.000Z',
      updatedAt: '2026-08-30T01:00:00.000Z',
    }
    const createFetch = responseFetch({
      ['workspace']: { ...workspace, internal: '不外发' },
      created: true,
      internal: '不外发',
    })
    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'createWorkspace',
        { path: '/Users/test-user/项目一' },
        createFetch,
      ),
    ).resolves.toEqual({ workspace, created: true })
    expect(requestOf(createFetch)).toMatchObject({
      url: new URL('http://127.0.0.1:3080/api/workspace/create'),
      body: {
        method: 'workspace/create',
        payload: { args: { request: { path: '/Users/test-user/项目一' } } },
      },
    })

    const pickerFetch = responseFetch({ path: '/Users/test-user/项目一' })
    await expect(
      callDshHost(new URL('http://127.0.0.1:3080/'), 'pickWorkspaceDirectory', {}, pickerFetch),
    ).resolves.toBe('/Users/test-user/项目一')
    expect(requestOf(pickerFetch)).toMatchObject({
      url: new URL('http://127.0.0.1:3080/api/directoryPicker/pick'),
      body: { method: 'directoryPicker/pick', payload: { args: {} } },
    })

    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'pickWorkspaceDirectory',
        {},
        responseFetch({ path: null }),
      ),
    ).resolves.toBeNull()

    const renamedWorkspace = { ...workspace, title: '重命名项目' }
    const renameFetch = responseFetch({ ['workspace']: renamedWorkspace })
    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'renameWorkspace',
        { workspaceId: '工作区-1', title: '  重命名项目  ' },
        renameFetch,
      ),
    ).resolves.toEqual({ ['workspace']: renamedWorkspace })
    expect(requestOf(renameFetch)).toMatchObject({
      url: new URL('http://127.0.0.1:3080/api/workspace/rename'),
      body: {
        method: 'workspace/rename',
        payload: {
          args: { request: { workspaceId: '工作区-1', title: '重命名项目' } },
        },
      },
    })

    const removeFetch = responseFetch({ deleted: true })
    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'removeWorkspace',
        { workspaceId: '工作区-1' },
        removeFetch,
      ),
    ).resolves.toEqual({ deleted: true })
    expect(requestOf(removeFetch)).toMatchObject({
      url: new URL('http://127.0.0.1:3080/api/workspace/delete'),
      body: {
        method: 'workspace/delete',
        payload: { args: { request: { workspaceId: '工作区-1' } } },
      },
    })

    const reorderFetch = responseFetch({ workspaceIds: ['工作区-1', '工作区-2'] })
    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'reorderWorkspace',
        { workspaceId: '工作区-1', beforeWorkspaceId: '工作区-2' },
        reorderFetch,
      ),
    ).resolves.toEqual({ workspaceIds: ['工作区-1', '工作区-2'] })
    expect(requestOf(reorderFetch)).toMatchObject({
      url: new URL('http://127.0.0.1:3080/api/workspace/insertBefore'),
      body: {
        method: 'workspace/insertBefore',
        payload: {
          args: {
            request: { workspaceId: '工作区-1', beforeWorkspaceId: '工作区-2' },
          },
        },
      },
    })

    const appendFetch = responseFetch({ workspaceIds: ['工作区-2', '工作区-1'] })
    await callDshHost(
      new URL('http://127.0.0.1:3080/'),
      'reorderWorkspace',
      { workspaceId: '工作区-1' },
      appendFetch,
    )
    expect(requestOf(appendFetch)).toMatchObject({
      body: { payload: { args: { request: { workspaceId: '工作区-1' } } } },
    })

    const sessionFetch = responseFetch({
      sessionId: '会话-2',
      agentPreset: 'standard',
      cwd: '/不得外发',
    })
    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'createSessionForWorkspace',
        { workspaceId: '工作区-1' },
        sessionFetch,
      ),
    ).resolves.toEqual({ sessionId: '会话-2', agentPreset: 'standard' })
    expect(requestOf(sessionFetch)).toMatchObject({
      url: new URL('http://127.0.0.1:3080/api/session/create'),
      body: {
        method: 'session/create',
        payload: { args: { request: { workspaceId: '工作区-1' } } },
      },
    })

    const renameSessionFetch = responseFetch({ title: '规范标题', seq: 17, internal: '不外发' })
    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'renameSession',
        { sessionId: '会话-1', title: '  规范标题  ' },
        renameSessionFetch,
      ),
    ).resolves.toEqual({ title: '规范标题', seq: 17 })
    expect(requestOf(renameSessionFetch)).toMatchObject({
      url: new URL('http://127.0.0.1:3080/api/session/rename'),
      body: {
        method: 'session/rename',
        payload: {
          args: { request: { sessionId: '会话-1', title: '  规范标题  ' } },
        },
      },
    })

    const forkSessionFetch = responseFetch({ sessionId: '会话-分叉', internal: '不外发' })
    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'forkSession',
        { sessionId: '会话-1', atSeq: 16 },
        forkSessionFetch,
      ),
    ).resolves.toEqual({ sessionId: '会话-分叉', workspaceAttachFailed: false })
    expect(requestOf(forkSessionFetch)).toMatchObject({
      url: new URL('http://127.0.0.1:3080/api/session/fork'),
      body: {
        method: 'session/fork',
        payload: { args: { request: { sessionId: '会话-1', atSeq: 16 } } },
      },
    })

    const sessionOrderFetch = responseFetch({
      ['workspace']: { ...workspace, sessionIds: ['会话-2', '会话-1'] },
    })
    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'reorderWorkspaceSession',
        { workspaceId: '工作区-1', sessionId: '会话-2', beforeSessionId: '会话-1' },
        sessionOrderFetch,
      ),
    ).resolves.toEqual({
      ['workspace']: { ...workspace, sessionIds: ['会话-2', '会话-1'] },
    })
    expect(requestOf(sessionOrderFetch)).toMatchObject({
      url: new URL('http://127.0.0.1:3080/api/workspace/insertSessionBefore'),
      body: {
        method: 'workspace/insertSessionBefore',
        payload: {
          args: {
            request: {
              workspaceId: '工作区-1',
              sessionId: '会话-2',
              beforeSessionId: '会话-1',
            },
          },
        },
      },
    })

    const partialForkFetch = vi.fn<typeof fetch>(async (_input, init) => {
      if (typeof init?.body !== 'string') throw new Error('测试请求必须包含 JSON body')
      const request = JSON.parse(init.body) as { rpcId: string }
      return Response.json({
        type: 'server-response',
        rpcId: request.rpcId,
        result: {
          ok: false,
          error: {
            code: 'workspace-attach-failed',
            message: '子会话已创建，但附加项目失败',
            details: { sessionId: '会话-已创建', workspaceId: '工作区-1' },
          },
        },
      })
    })
    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'forkSession',
        { sessionId: '会话-1' },
        partialForkFetch,
      ),
    ).resolves.toEqual({ sessionId: '会话-已创建', workspaceAttachFailed: true })

    const searchFetch = responseFetch({
      items: [{ sessionId: '会话-1', snippet: '命中的聊天内容', internal: '不外发' }],
      hasMore: true,
      internal: '不外发',
    })
    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'searchSessions',
        { query: '聊天内容' },
        searchFetch,
      ),
    ).resolves.toEqual({
      items: [{ sessionId: '会话-1', snippet: '命中的聊天内容' }],
      hasMore: true,
    })
    expect(requestOf(searchFetch)).toMatchObject({
      url: new URL('http://127.0.0.1:3080/api/session/search'),
      body: {
        method: 'session/search',
        payload: { args: { request: { query: '聊天内容' } } },
      },
    })

    const fileReferenceFetch = responseFetch([
      { path: 'src/主程序.ts', kind: 'file' },
      { path: 'docs', kind: 'directory' },
    ])
    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'listFileReferences',
        { sessionId: '会话-1', query: 'src/' },
        fileReferenceFetch,
      ),
    ).resolves.toEqual([
      { path: 'src/主程序.ts', kind: 'file' },
      { path: 'docs', kind: 'directory' },
    ])
    expect(requestOf(fileReferenceFetch)).toMatchObject({
      url: new URL('http://127.0.0.1:3080/api/fileReferences/list'),
      body: {
        method: 'fileReferences/list',
        payload: { args: { agentId: '会话-1', query: 'src/' } },
      },
    })
  })

  it('Workspace 写操作拒绝额外字段、相对路径和越权 Session 参数', async () => {
    const cases = [
      {
        operation: 'createWorkspace' as const,
        payload: { path: '/Users/test-user/项目一', title: '越权标题' },
        message: '包含未知字段 title',
      },
      {
        operation: 'pickWorkspaceDirectory' as const,
        payload: { path: '/不得指定' },
        message: '包含未知字段 path',
      },
      {
        operation: 'renameWorkspace' as const,
        payload: { workspaceId: '工作区-1', title: '   ' },
        message: '标题不能为空',
      },
      {
        operation: 'removeWorkspace' as const,
        payload: { workspaceId: '工作区-1', deleteFiles: true },
        message: '包含未知字段 deleteFiles',
      },
      {
        operation: 'createWorkspace' as const,
        payload: { path: '../项目一' },
        message: '必须包含绝对目录路径',
      },
      {
        operation: 'reorderWorkspace' as const,
        payload: { workspaceId: '工作区-1', index: 3 },
        message: '包含未知字段 index',
      },
      {
        operation: 'createSessionForWorkspace' as const,
        payload: { workspaceId: '工作区-1', cwd: '/不得指定' },
        message: '包含未知字段 cwd',
      },
      {
        operation: 'createSessionForWorkspace' as const,
        payload: { workspaceId: '工作区-1', sessionId: '不得指定' },
        message: '包含未知字段 sessionId',
      },
      {
        operation: 'searchSessions' as const,
        payload: { query: '   ' },
        message: '搜索词不能为空',
      },
    ]
    await Promise.all(
      cases.map(async candidate => {
        const fetchImpl = responseFetch(undefined)
        await expect(
          callDshHost(
            new URL('http://127.0.0.1:3080/'),
            candidate.operation,
            candidate.payload,
            fetchImpl,
          ),
        ).rejects.toThrow(candidate.message)
        expect(fetchImpl).not.toHaveBeenCalled()
      }),
    )
  })

  it('Workspace 列表只允许从 workspace/follow 基线读取', async () => {
    const fetchImpl = responseFetch(undefined)
    await expect(
      callDshHost(new URL('http://127.0.0.1:3080/'), 'listWorkspaces', {}, fetchImpl),
    ).rejects.toThrow('Workspace 列表必须从公开 workspace/follow 基线读取')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('命令和 Skill 目录使用新版 plural slash endpoint', async () => {
    const commandsFetch = responseFetch([
      {
        name: 'compact',
        description: '压缩上下文',
        internal: '不外发',
      },
    ])
    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'listSessionCommands',
        { sessionId: '会话-1' },
        commandsFetch,
      ),
    ).resolves.toEqual([{ name: 'compact', description: '压缩上下文' }])
    expect(requestOf(commandsFetch)).toMatchObject({
      url: new URL('http://127.0.0.1:3080/api/commands/list'),
      body: {
        method: 'commands/list',
        payload: { args: { agentId: '会话-1' } },
      },
    })

    const skillsFetch = responseFetch({
      skills: [
        {
          name: 'review-code',
          description: '审查代码',
          modelInvocable: true,
          path: '/不得外发',
        },
      ],
    })
    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'listSessionSkills',
        { sessionId: '会话-1' },
        skillsFetch,
      ),
    ).resolves.toEqual([
      {
        name: 'review-code',
        description: '审查代码',
        modelInvocable: true,
      },
    ])
    expect(requestOf(skillsFetch)).toMatchObject({
      url: new URL('http://127.0.0.1:3080/api/skills/list'),
      body: {
        method: 'skills/list',
        payload: { args: { request: { sessionId: '会话-1' } } },
      },
    })

    const executeFetch = responseFetch({
      commandId: 'command-1',
      result: { kind: 'success', text: '完成', sourceEventSeq: 7, hidden: '不外发' },
    })
    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'executeSessionCommand',
        { sessionId: '会话-1', line: '/compact  当前会话' },
        executeFetch,
      ),
    ).resolves.toEqual({
      commandId: 'command-1',
      result: { kind: 'success', text: '完成', sourceEventSeq: 7 },
    })
    expect(requestOf(executeFetch)).toMatchObject({
      url: new URL('http://127.0.0.1:3080/api/commands/execute'),
      body: {
        method: 'commands/execute',
        payload: {
          args: {
            agentId: '会话-1',
            line: '/compact  当前会话',
            submittedAttachments: [],
          },
        },
      },
    })
  })

  it('命令未匹配保留 undefined，目录或执行返回无效时失败关闭', async () => {
    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'executeSessionCommand',
        { sessionId: '会话-1', line: '/unknown' },
        responseFetch(undefined),
      ),
    ).resolves.toBeUndefined()

    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'listSessionCommands',
        { sessionId: '会话-1' },
        responseFetch([{ name: '../escape', description: '非法' }]),
      ),
    ).rejects.toThrow('无效的命令名称')

    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'executeSessionCommand',
        { sessionId: '会话-1', line: '/compact' },
        responseFetch({ commandId: 'command-1', result: { kind: 'error' } }),
      ),
    ).rejects.toThrow('无效的命令错误文本')
  })

  it('命令产品动作拒绝未知字段、非法 line 和非空 images 输入', async () => {
    const cases = [
      {
        operation: 'listSessionCommands' as const,
        payload: { sessionId: '会话-1', endpoint: 'credentials.set' },
        message: '包含未知字段 endpoint',
      },
      {
        operation: 'listSessionSkills' as const,
        payload: { sessionId: '会话-1', cwd: '/不得指定' },
        message: '包含未知字段 cwd',
      },
      {
        operation: 'executeSessionCommand' as const,
        payload: { sessionId: '会话-1', line: '不是 slash command' },
        message: '必须是有效',
      },
      {
        operation: 'executeSessionCommand' as const,
        payload: { sessionId: '会话-1', line: '/compact', images: ['不得外发'] },
        message: '包含未知字段 images',
      },
    ]
    await Promise.all(
      cases.map(async candidate => {
        const fetchImpl = responseFetch(undefined)
        await expect(
          callDshHost(
            new URL('http://127.0.0.1:3080/'),
            candidate.operation,
            candidate.payload,
            fetchImpl,
          ),
        ).rejects.toThrow(candidate.message)
        expect(fetchImpl).not.toHaveBeenCalled()
      }),
    )
  })

  it('会话消息只接收有界文本和规范图片内容，不接受本机路径或伪 Base64', async () => {
    const promptFetch = responseFetch({ accepted: true })
    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'promptSession',
        {
          sessionId: '会话-1',
          mode: 'queue',
          content: [
            { type: 'text', text: '检查截图' },
            { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=', name: '截图.png' },
          ],
          clientTimeZone: 'Asia/Shanghai',
        },
        promptFetch,
      ),
    ).resolves.toEqual({ accepted: true })
    expect(requestOf(promptFetch)).toMatchObject({
      url: new URL('http://127.0.0.1:3080/api/session/prompt'),
      body: {
        method: 'session/prompt',
        payload: {
          args: {
            request: {
              sessionId: '会话-1',
              mode: 'queue',
              content: [
                { type: 'text', text: '检查截图' },
                { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=', name: '截图.png' },
              ],
              clientTimeZone: 'Asia/Shanghai',
              requestId: expect.any(String),
            },
          },
        },
      },
    })

    await Promise.all(
      [
        { type: 'image', mediaType: 'image/png', data: '不是Base64', name: '截图.png' },
        {
          type: 'image',
          mediaType: 'image/png',
          data: 'iVBORw0KGgo=',
          name: '/Users/test-user/截图.png',
        },
      ].map(async image => {
        const rejectedFetch = responseFetch({ accepted: true })
        await expect(
          callDshHost(
            new URL('http://127.0.0.1:3080/'),
            'promptSession',
            { sessionId: '会话-1', mode: 'queue', content: [image] },
            rejectedFetch,
          ),
        ).rejects.toThrow()
        expect(rejectedFetch).not.toHaveBeenCalled()
      }),
    )
  })

  it('只有命令执行使用十分钟有界 timeout', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    try {
      await callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'listSessionCommands',
        { sessionId: '会话-1' },
        responseFetch([]),
      )
      await callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'executeSessionCommand',
        { sessionId: '会话-1', line: '/compact' },
        responseFetch(undefined),
      )
      expect(timeout).toHaveBeenNthCalledWith(1, 15_000)
      expect(timeout).toHaveBeenNthCalledWith(2, SESSION_COMMAND_EXECUTION_TIMEOUT_MS)
      expect(SESSION_COMMAND_EXECUTION_TIMEOUT_MS).toBe(10 * 60 * 1_000)
    } finally {
      timeout.mockRestore()
    }
  })

  it('模型目录和模型切换使用新版 slash 公开 API 与生成参数结构', async () => {
    const modelsFetch = responseFetch({
      default: { provider: 'p', model: 'm' },
      routableProviders: ['p'],
      groups: [],
      failures: [],
    })
    await callDshHost(
      new URL('http://127.0.0.1:3080/'),
      'getSessionModels',
      { sessionId: '会话-1', ignored: '不得外发' },
      modelsFetch,
    )
    expect(requestOf(modelsFetch)).toMatchObject({
      url: new URL('http://127.0.0.1:3080/api/session/modelCatalog'),
      body: {
        method: 'session/modelCatalog',
        payload: { args: {} },
      },
    })

    const selectFetch = responseFetch({
      selected: { provider: 'p', model: 'm', reasoningEffort: 'max' },
    })
    await callDshHost(
      new URL('http://127.0.0.1:3080/'),
      'selectSessionModel',
      { sessionId: '会话-1', provider: 'p', model: 'm', reasoningEffort: 'max', ignored: true },
      selectFetch,
    )
    expect(requestOf(selectFetch)).toMatchObject({
      url: new URL('http://127.0.0.1:3080/api/session/selectModel'),
      body: {
        method: 'session/selectModel',
        payload: {
          args: {
            request: { sessionId: '会话-1', provider: 'p', model: 'm', reasoningEffort: 'max' },
          },
        },
      },
    })
  })

  it('图片被 Host 拒绝时按公开原因显示可操作的中文错误', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      if (typeof init?.body !== 'string') throw new Error('测试请求必须包含 JSON body')
      const request = JSON.parse(init.body) as { rpcId: string }
      return Response.json({
        type: 'server-response',
        rpcId: request.rpcId,
        result: {
          ok: false,
          error: {
            code: 'attachment-error',
            message: 'Model does not support image input.',
            details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
          },
        },
      })
    })

    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'promptSession',
        {
          sessionId: '会话-1',
          mode: 'queue',
          content: [{ type: 'image', mediaType: 'image/png', data: 'aW1hZ2U=', name: '界面.png' }],
        },
        fetchImpl,
      ),
    ).rejects.toThrow('当前模型不支持图片，请切换支持图片的模型')
  })

  it('权限预设只允许安全机器值，并生成 commands/execute 的严格 args', async () => {
    const fetchImpl = responseFetch({ commandId: '命令-1', result: { kind: 'success' } })
    await callDshHost(
      new URL('http://127.0.0.1:3080/'),
      'selectPermissionPreset',
      { sessionId: '会话-1', preset: 'danger-full-access', line: '/任意命令' },
      fetchImpl,
    )
    expect(requestOf(fetchImpl)).toMatchObject({
      url: new URL('http://127.0.0.1:3080/api/commands/execute'),
      body: {
        method: 'commands/execute',
        payload: {
          args: {
            agentId: '会话-1',
            line: '/permission danger-full-access',
            submittedAttachments: [],
          },
        },
      },
    })

    const rejectedFetch = responseFetch(undefined)
    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'selectPermissionPreset',
        { sessionId: '会话-1', preset: 'workspace-write /任意命令' },
        rejectedFetch,
      ),
    ).rejects.toThrow('包含不支持的字符')
    expect(rejectedFetch).not.toHaveBeenCalled()
  })

  it('只公开产品动作，不开放任意 endpoint', () => {
    expect(DSH_HOST_OPERATIONS).toEqual(
      expect.arrayContaining([
        'getSessionModels',
        'selectSessionModel',
        'selectPermissionPreset',
        'listSessionCommands',
        'listFileReferences',
        'listSessionSkills',
        'executeSessionCommand',
        'describeSettings',
        'mutateSettings',
        'setCredential',
        'listModelProviders',
        'listHostModels',
        'listAgentPresets',
        'listHostPlugins',
        'archiveSession',
        'listWorkspaces',
        'pickWorkspaceDirectory',
        'createWorkspace',
        'renameWorkspace',
        'removeWorkspace',
        'reorderWorkspace',
        'createSessionForWorkspace',
      ]),
    )
    expect(DSH_HOST_OPERATIONS).not.toContain('commands/execute')
    expect(DSH_HOST_OPERATIONS).not.toContain('command.list')
    expect(DSH_HOST_OPERATIONS).not.toContain('command.execute')
    expect(DSH_HOST_OPERATIONS).not.toContain('settings.replace')
    expect(DSH_HOST_OPERATIONS).not.toContain('credentials.set')
  })
})

describe('DSH Host 设置与目录操作白名单', () => {
  it.each([
    ['describeSettings', 'settings/describe'],
    ['openSettingsDocument', 'settings/openSettingsDocument'],
    ['listHostModels', 'session/modelCatalog'],
  ] as const)('%s 只转换为 %s 空请求', async (operation, endpoint) => {
    const request = await callAndReadRequest(operation, {})
    expect(request).toMatchObject({
      url: new URL(`http://127.0.0.1:3080/api/${endpoint}`),
      body: {
        method: endpoint,
        payload: { args: {} },
      },
    })
  })

  it('模型提供方目录合并可配置项和当前激活项', async () => {
    const fetchImpl = responsesByMethod({
      'llm/listConfigurableProviders': [
        {
          provider: 'deepseek',
          displayName: 'DeepSeek',
          settingsNs: 'llm-pi-ai',
          settingsPath: ['providers', 'deepseek'],
          declared: true,
        },
      ],
      'llm/listProviders': [{ id: 'deepseek' }],
    })
    await expect(
      callDshHost(new URL('http://127.0.0.1:3080/'), 'listModelProviders', {}, fetchImpl),
    ).resolves.toEqual({
      providers: [
        {
          provider: 'deepseek',
          displayName: 'DeepSeek',
          settingsNs: 'llm-pi-ai',
          settingsPath: ['providers', 'deepseek'],
          active: true,
          declared: true,
        },
      ],
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(
      fetchImpl.mock.calls.map(([input, init]) => ({
        url: input,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      })),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: new URL('http://127.0.0.1:3080/api/llm/listConfigurableProviders'),
          body: expect.objectContaining({
            method: 'llm/listConfigurableProviders',
            payload: { args: {} },
          }),
        }),
        expect.objectContaining({
          url: new URL('http://127.0.0.1:3080/api/llm/listProviders'),
          body: expect.objectContaining({
            method: 'llm/listProviders',
            payload: { args: {} },
          }),
        }),
      ]),
    )
  })

  it('Agent 预设目录合并 roster 和设置文档能力', async () => {
    const fetchImpl = responsesByMethod({
      'agentPresets/list': {
        presets: [{ id: 'standard', name: '标准' }],
        authorable: true,
      },
      'settings/canOpenAgentPresetDirectory': true,
    })
    await expect(
      callDshHost(new URL('http://127.0.0.1:3080/'), 'listAgentPresets', {}, fetchImpl),
    ).resolves.toEqual({
      presets: [{ id: 'standard', name: '标准' }],
      authorable: true,
      hasDocument: true,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('设置更新保留路径操作与并发 revision，不重建整个 namespace', async () => {
    const request = await callAndReadRequest('mutateSettings', {
      ns: 'agent-default-model',
      ops: [
        { op: 'set', path: ['provider'], value: 'deepseek' },
        { op: 'set', path: ['model'], value: 'deepseek-chat' },
        { op: 'unset', path: ['reasoningEffort'] },
      ],
      expectedRevision: 17,
    })
    expect(request).toMatchObject({
      url: new URL('http://127.0.0.1:3080/api/settings/mutate'),
      body: {
        method: 'settings/mutate',
        payload: {
          args: {
            ns: 'agent-default-model',
            ops: [
              { op: 'set', path: ['provider'], value: 'deepseek' },
              { op: 'set', path: ['model'], value: 'deepseek-chat' },
              { op: 'unset', path: ['reasoningEffort'] },
            ],
            expectedRevision: 17,
          },
        },
      },
    })
  })

  it('凭据接口只接受环境变量引用，查询不携带密钥值', async () => {
    const describeRequest = await callAndReadRequest('describeCredentials', {
      refs: ['DEEPSEEK_API_KEY', 'CUSTOM_API_KEY', 'DEEPSEEK_API_KEY'],
    })
    expect(describeRequest).toMatchObject({
      url: new URL('http://127.0.0.1:3080/api/credentials/describe'),
      body: {
        method: 'credentials/describe',
        payload: { args: { refs: ['DEEPSEEK_API_KEY', 'CUSTOM_API_KEY'] } },
      },
    })
    expect(JSON.stringify(describeRequest.body)).not.toContain('secret-value')

    const setRequest = await callAndReadRequest('setCredential', {
      ref: 'DEEPSEEK_API_KEY',
      value: 'sk-secret-value',
    })
    expect(setRequest).toMatchObject({
      url: new URL('http://127.0.0.1:3080/api/credentials/set'),
      body: {
        method: 'credentials/set',
        payload: { args: { ref: 'DEEPSEEK_API_KEY', value: 'sk-secret-value' } },
      },
    })

    const unsetRequest = await callAndReadRequest('unsetCredential', { ref: 'DEEPSEEK_API_KEY' })
    expect(unsetRequest).toMatchObject({
      url: new URL('http://127.0.0.1:3080/api/credentials/unset'),
      body: {
        method: 'credentials/unset',
        payload: { args: { ref: 'DEEPSEEK_API_KEY' } },
      },
    })
  })

  it('模型发现使用 llm/discoverModels 的有界输入并将数组结果包装为目录对象', async () => {
    const discovered = [
      { id: 'gemini-4-neon', name: 'Gemini 4 Neon', contextWindow: 1_048_576, maxTokens: 65_536 },
    ]
    const fetchImpl = responseFetch(discovered)
    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'discoverProviderModels',
        {
          settingsNs: 'llm-pi-ai',
          provider: 'openai-compatible',
          baseURL: 'https://example.test/v1',
          api: 'openai-completions',
          apiKey: 'sk-temporary',
        },
        fetchImpl,
      ),
    ).resolves.toEqual({ models: discovered })
    expect(requestOf(fetchImpl)).toMatchObject({
      url: new URL('http://127.0.0.1:3080/api/llm/discoverModels'),
      body: {
        method: 'llm/discoverModels',
        payload: {
          args: {
            settingsNs: 'llm-pi-ai',
            request: {
              provider: 'openai-compatible',
              baseURL: 'https://example.test/v1',
              api: 'openai-completions',
              apiKey: 'sk-temporary',
            },
          },
        },
      },
    })
    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'discoverProviderModels',
        { settingsNs: 'llm-pi-ai', provider: 'google' },
        responseFetch({ models: discovered }),
      ),
    ).rejects.toThrow('无效的模型发现目录')
  })

  it.each([
    ['readAgentPreset', 'agentPresets/read'],
    ['openAgentPreset', 'settings/openAgentPresetDirectory'],
  ] as const)('%s 只向 %s 发送预设 ID', async (operation, endpoint) => {
    const request = await callAndReadRequest(operation, { agentPreset: 'standard' })
    expect(request).toMatchObject({
      url: new URL(`http://127.0.0.1:3080/api/${endpoint}`),
      body: {
        method: endpoint,
        payload: { args: { agentPreset: 'standard' } },
      },
    })
  })

  it('会话预设选择使用公开接口并拒绝额外字段', async () => {
    const request = await callAndReadRequest('selectSessionAgentPreset', {
      sessionId: 'session-1',
      agentPreset: 'standard',
    })
    expect(request.body).toMatchObject({
      method: 'agentPresets/select',
      payload: { args: { agentId: 'session-1', agentPreset: 'standard' } },
    })
    const rejectedFetch = responseFetch(undefined)
    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'selectSessionAgentPreset',
        {
          sessionId: 'session-1',
          agentPreset: 'standard',
          endpoint: '不允许指定其他接口',
        },
        rejectedFetch,
      ),
    ).rejects.toThrow('包含未知字段 endpoint')
    expect(rejectedFetch).not.toHaveBeenCalled()
  })

  it('删除 Agent 预设只向新版 endpoint 发送 id', async () => {
    const request = await callAndReadRequest('removeAgentPreset', { agentPreset: 'standard' })
    expect(request).toMatchObject({
      url: new URL('http://127.0.0.1:3080/api/agentPresets/deletePreset'),
      body: {
        method: 'agentPresets/deletePreset',
        payload: { args: { id: 'standard' } },
      },
    })
  })

  it('Agent 预设复制不接受组合文本或 Host 路径', async () => {
    const request = await callAndReadRequest('copyAgentPreset', {
      from: 'standard',
      agentPreset: 'my-standard',
      name: '我的标准预设',
    })
    expect(request).toMatchObject({
      url: new URL('http://127.0.0.1:3080/api/agentPresets/copy'),
      body: {
        method: 'agentPresets/copy',
        payload: {
          args: {
            from: 'standard',
            id: 'my-standard',
            name: '我的标准预设',
          },
        },
      },
    })
  })

  it('插件目录保留 Typert Remote 的 args 请求和内层 RemoteResult', async () => {
    const remoteResult = {
      ok: true,
      value: {
        entries: [
          {
            entryId: 'shell',
            moduleName: '@deepseek-ai/dsh-plugin-shell',
            enabled: true,
            fiberPhase: 'active',
          },
        ],
      },
    }
    const fetchImpl = responseFetch(remoteResult)
    const result = await callDshHost(
      new URL('http://127.0.0.1:3080/'),
      'listHostPlugins',
      {},
      fetchImpl,
    )
    expect(result).toEqual(remoteResult)
    expect(requestOf(fetchImpl)).toMatchObject({
      url: new URL('http://127.0.0.1:3080/api/pluginInventory/list'),
      body: {
        method: 'pluginInventory/list',
        payload: { args: {} },
      },
    })
  })
})

describe('DSH Host 设置请求边界', () => {
  it('空请求和实体请求都拒绝未知字段', async () => {
    const emptyFetch = responseFetch(undefined)
    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'describeSettings',
        { endpoint: 'credentials.set' },
        emptyFetch,
      ),
    ).rejects.toThrow('包含未知字段 endpoint')
    expect(emptyFetch).not.toHaveBeenCalled()

    const mutationFetch = responseFetch(undefined)
    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'mutateSettings',
        {
          ns: 'locale',
          ops: [{ op: 'set', path: ['preference'], value: 'zh', secret: 'do-not-forward' }],
        },
        mutationFetch,
      ),
    ).rejects.toThrow('包含未知字段 secret')
    expect(mutationFetch).not.toHaveBeenCalled()

    const pluginFetch = responseFetch(undefined)
    await expect(
      callDshHost(new URL('http://127.0.0.1:3080/'), 'listHostPlugins', { args: {} }, pluginFetch),
    ).rejects.toThrow('包含未知字段 args')
    expect(pluginFetch).not.toHaveBeenCalled()
  })

  it('拒绝原型链路径、非法 namespace 和过期 revision', async () => {
    await Promise.all(
      [['__proto__'], ['prototype'], ['constructor']].map(async path => {
        const fetchImpl = responseFetch(undefined)
        await expect(
          callDshHost(
            new URL('http://127.0.0.1:3080/'),
            'mutateSettings',
            { ns: 'locale', ops: [{ op: 'set', path, value: 'zh' }] },
            fetchImpl,
          ),
        ).rejects.toThrow('包含保留字段')
        expect(fetchImpl).not.toHaveBeenCalled()
      }),
    )

    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'mutateSettings',
        { ns: '../credentials', ops: [{ op: 'unset', path: [] }] },
        responseFetch(undefined),
      ),
    ).rejects.toThrow('命名空间包含不支持的字符')

    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'mutateSettings',
        { ns: 'locale', ops: [{ op: 'unset', path: [] }], expectedRevision: -1 },
        responseFetch(undefined),
      ),
    ).rejects.toThrow('revision 必须是非负安全整数')
  })

  it('拒绝非法凭据引用和不可打印密钥，错误不回显密钥', async () => {
    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'describeCredentials',
        { refs: ['DEEPSEEK-API-KEY'] },
        responseFetch(undefined),
      ),
    ).rejects.toThrow('环境变量格式')

    const secret = 'sk-top-secret \u5bc6钥'
    let thrown: unknown
    try {
      await callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'setCredential',
        { ref: 'DEEPSEEK_API_KEY', value: secret },
        responseFetch(undefined),
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain('可打印 ASCII')
    expect((thrown as Error).message).not.toContain(secret)
  })

  it('拒绝不安全的 Agent 预设 ID 与所有额外作者输入', async () => {
    const invalidIdFetch = responseFetch(undefined)
    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'readAgentPreset',
        { agentPreset: '../standard' },
        invalidIdFetch,
      ),
    ).rejects.toThrow('预设 ID 只能使用')
    expect(invalidIdFetch).not.toHaveBeenCalled()

    const authoringFetch = responseFetch(undefined)
    await expect(
      callDshHost(
        new URL('http://127.0.0.1:3080/'),
        'copyAgentPreset',
        {
          from: 'standard',
          agentPreset: 'custom',
          content: '不应越过桌面边界',
        },
        authoringFetch,
      ),
    ).rejects.toThrow('包含未知字段 content')
    expect(authoringFetch).not.toHaveBeenCalled()
  })
})
