/** 验证会话连接队列在等待请求取消后仍保持严格串行。 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import { ConnectionAccess } from '../packages/connections/access/lib/index.js'

const contexts = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function deferred() {
  let resolve
  const promise = new Promise(done => {
    resolve = done
  })
  return { promise, resolve }
}

async function createAccess() {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('agents', {})
  ctx.provide('sessions', {})
  ctx.provide('workspaceRegistry', { archivedSessionIds: [] })
  await ctx.plugin(ConnectionAccess).await()
  return ctx.mydshConnectionAccess
}

it('等待中的请求取消后，后续请求不能越过仍在执行的前驱', async () => {
  const access = await createAccess()
  const events = []
  const firstGate = deferred()
  const firstStarted = deferred()
  const first = access.serializeForConnection('session', 'connection', async () => {
    events.push('first-start')
    firstStarted.resolve()
    await firstGate.promise
    events.push('first-end')
  })
  await firstStarted.promise

  const cancelled = new AbortController()
  const second = access.serializeForConnection(
    'session',
    'connection',
    async () => {
      events.push('second-start')
    },
    cancelled.signal,
  )
  await Promise.resolve()
  cancelled.abort(new Error('取消等待'))
  await expect(second).rejects.toThrow('取消等待')

  const thirdStarted = deferred()
  const third = access.serializeForConnection('session', 'connection', async () => {
    events.push('third-start')
    thirdStarted.resolve()
  })
  await Promise.race([
    thirdStarted.promise.then(() => 'started'),
    new Promise(resolve => setTimeout(() => resolve('waiting'), 20)),
  ]).then(result => expect(result).toBe('waiting'))
  expect(events).toEqual(['first-start'])

  firstGate.resolve()
  await Promise.all([first, third])
  expect(events).toEqual(['first-start', 'first-end', 'third-start'])
})

it('签发的连接执行租约会冻结连接身份与依赖列表，防止外部篡改', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  const agent = { id: 'session-freeze', session: { header: { origin: 'user' } } }
  ctx.provide('agents', {
    get: id => (id === agent.id ? agent : undefined),
    isOwnedBy: () => false,
  })
  ctx.provide('sessions', {})
  ctx.provide('workspaceRegistry', { archivedSessionIds: [] })
  await ctx.plugin(ConnectionAccess).await()

  const lease = ctx.mydshConnectionAccess.acquireLease(agent, {
    name: '测试连接',
    connection: { kind: 'database', id: 'db-1', revision: 1 },
    dependencies: [{ kind: 'ssh', id: 'ssh-1', revision: 1, fingerprint: 'SHA256:test' }],
    requireSessionConsent: false,
  })
  try {
    expect(Object.isFrozen(lease.view)).toBe(true)
    expect(Object.isFrozen(lease.view.connection)).toBe(true)
    expect(Object.isFrozen(lease.view.dependencies)).toBe(true)
    expect(Object.isFrozen(lease.view.dependencies[0])).toBe(true)
  } finally {
    ctx.mydshConnectionAccess.releaseLease(lease)
  }
})
