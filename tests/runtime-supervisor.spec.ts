import { EventEmitter } from 'node:events'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MydshRuntimeSupervisor } from '../src/main/runtime/runtime-supervisor.ts'
import { createRuntimeStreamCarrier } from '../src/main/runtime/runtime-stream.ts'
import { followDshRemoteStreams } from '../src/main/host/remote-stream.ts'
import { GIT_AI_EXECUTION_TIMEOUT_MS, GIT_AI_REPLY_TIMEOUT_MS } from '../src/shared/git-ai.ts'

const mocks = vi.hoisted(() => ({
  fork: vi.fn(),
  install: vi.fn(),
  recover: vi.fn(),
  available: vi.fn(() => true),
  encrypt: vi.fn((text: string) => Buffer.from(text)),
}))
vi.mock('electron', () => ({
  utilityProcess: { fork: mocks.fork },
  safeStorage: {
    isEncryptionAvailable: mocks.available,
    encryptString: mocks.encrypt,
    decryptString: (bytes: Buffer) => bytes.toString('utf8'),
  },
}))
vi.mock('../src/main/runtime/runtime-install.ts', () => ({
  ensureRuntimeInstalled: mocks.install,
  resolveMydshHome: (home: string) => home,
}))
vi.mock('../src/runtime/import/dsh-import.ts', () => ({ recoverDshImport: mocks.recover }))

class Child extends EventEmitter {
  pid = 123456
  stdout = undefined
  stderr = undefined
  failPost = false
  ignoreStop = false
  sent: Array<Record<string, unknown>> = []
  postMessage(message: Record<string, unknown>): void {
    if (this.failPost) throw new Error('模拟消息通道已关闭')
    this.sent.push(message)
    if (message.type === 'stop' && !this.ignoreStop) queueMicrotask(() => this.emit('exit', 0))
  }
  kill = vi.fn(() => {
    this.emit('exit', 1)
    return true
  })
}

const directories: string[] = []
const flush = async (): Promise<void> => {
  await new Promise<void>(resolve => setImmediate(resolve))
}
afterEach(async () => {
  vi.useRealTimers()
  vi.clearAllMocks()
  mocks.install.mockReset()
  mocks.recover.mockReset()
  mocks.fork.mockReset()
  mocks.available.mockReset().mockReturnValue(true)
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture(pickDirectory?: (signal: AbortSignal) => Promise<string | null>) {
  const home = await mkdtemp(join(tmpdir(), 'mydsh-supervisor-'))
  directories.push(home)
  const child = new Child()
  const order: string[] = []
  mocks.recover.mockImplementation(async () => {
    order.push('recover')
  })
  mocks.install.mockImplementation(async () => {
    order.push('install')
    return {
      mydshHome: home,
      runtimeDirectory: join(home, 'runtime'),
      entryPath: join(home, 'runtime/entry.js'),
      manifest: { version: 'test' },
      installed: true,
    }
  })
  mocks.fork.mockImplementation(() => {
    queueMicrotask(() => {
      child.emit('spawn')
      child.emit('message', { type: 'ready', version: 'test' })
    })
    return child
  })
  return {
    home,
    child,
    order,
    runtime: new MydshRuntimeSupervisor({
      bundleDirectory: '/unused',
      mydshHome: home,
      ...(pickDirectory ? { pickDirectory } : {}),
    }),
  }
}

describe('MyDSH Runtime 通道与退出', () => {
  it('仅 AI 提交执行延长回包期限，给后台执行和索引协调留出时间', async () => {
    const { runtime, child } = await fixture()
    await runtime.ensureReady()
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    try {
      const execute = runtime.call('mydshWorkspace/call', { args: { operation: 'gitAiExecute' } })
      const ordinary = runtime.call('mydshWorkspace/call', { args: { operation: 'gitSummary' } })
      expect(timeout.mock.calls).toEqual([[GIT_AI_REPLY_TIMEOUT_MS], [300_000]])
      expect(GIT_AI_REPLY_TIMEOUT_MS).toBeGreaterThan(GIT_AI_EXECUTION_TIMEOUT_MS)
      const reply = { ok: true, value: '已完成' }
      for (const request of child.sent.filter(message => message.type === 'call'))
        child.emit('message', { type: 'result', id: request.id, result: reply })
      await expect(Promise.all([execute, ordinary])).resolves.toEqual([reply, reply])
    } finally {
      timeout.mockRestore()
      await runtime.shutdown()
    }
  })

  it('目录选择返回路径或用户取消，运行请求取消及退出均释放原生选择器', async () => {
    const pick = vi
      .fn<(signal: AbortSignal) => Promise<string | null>>()
      .mockResolvedValueOnce('/tmp/项目')
      .mockResolvedValueOnce(null)
      .mockImplementation(
        signal =>
          new Promise((_resolve, reject) => {
            signal.throwIfAborted()
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          }),
      )
    const { runtime, child } = await fixture(pick)
    await runtime.ensureReady()
    const request = (id: string) =>
      child.emit('message', { type: 'main-call', id, method: 'directory.pick', payload: {} })
    request('selected')
    await vi.waitFor(() =>
      expect(child.sent).toContainEqual({
        type: 'main-result',
        id: 'selected',
        value: '/tmp/项目',
      }),
    )
    request('cancelled')
    await vi.waitFor(() =>
      expect(child.sent).toContainEqual({ type: 'main-result', id: 'cancelled', value: null }),
    )
    request('aborted')
    await flush()
    request('duplicate')
    await vi.waitFor(() =>
      expect(child.sent).toContainEqual({
        type: 'main-result',
        id: 'duplicate',
        error: '请先完成当前目录选择',
      }),
    )
    child.emit('message', { type: 'cancel-main-call', id: 'aborted' })
    await vi.waitFor(() =>
      expect(child.sent).toContainEqual(
        expect.objectContaining({ type: 'main-result', id: 'aborted', error: expect.any(String) }),
      ),
    )
    expect(pick.mock.calls[2]![0].aborted).toBe(true)
    request('shutdown')
    await flush()
    await runtime.shutdown()
    expect(pick.mock.calls[3]![0].aborted).toBe(true)
    expect(mocks.available).not.toHaveBeenCalled()
  })
  it('先恢复再安装，拒绝旧凭据桥，消费结束才 ACK 并正常退出', async () => {
    const { runtime, child, order, home } = await fixture()
    await runtime.ensureReady()
    expect(order).toEqual(['recover', 'install'])
    // 凭据由运行核心的文件服务管理，主进程不再暴露旧的钥匙串桥。
    for (const method of ['keys', 'get', 'delete'])
      child.emit('message', {
        type: 'main-call',
        id: method,
        method: `credentials.${method}`,
        payload: { key: 'API_KEY' },
      })
    await vi.waitFor(() => {
      expect(child.sent.filter(message => message.type === 'main-result')).toHaveLength(3)
    })
    expect(child.sent.filter(message => message.type === 'main-result')).toEqual([
      { type: 'main-result', id: 'keys', error: '未知系统操作' },
      { type: 'main-result', id: 'get', error: '未知系统操作' },
      { type: 'main-result', id: 'delete', error: '未知系统操作' },
    ])
    expect(mocks.available).not.toHaveBeenCalled()
    expect(mocks.encrypt).not.toHaveBeenCalled()
    expect(await readdir(home)).toEqual([])
    const abort = new AbortController()
    let release!: () => void
    const consumed = new Promise<void>(resolve => {
      release = resolve
    })
    const onItem = vi.fn(async () => {
      await consumed
    })
    const stream = followDshRemoteStreams({
      targetUrl: new URL('http://mydsh.internal/'),
      signal: abort.signal,
      maxFrameBytes: 1024,
      subject: '验收',
      streams: [{ endpoint: 'test/follow', payload: {}, onItem }],
      openSocket: createRuntimeStreamCarrier(runtime),
    })
    await flush()
    const request = child.sent.find(message => message.type === 'open')!
    child.emit('message', { type: 'item', id: request.id, value: { message: '事件' } })
    await flush()
    expect(onItem).toHaveBeenCalledOnce()
    expect(child.sent.some(message => message.type === 'ack')).toBe(false)
    release()
    await flush()
    expect(child.sent.some(message => message.type === 'ack' && message.id === request.id)).toBe(
      true,
    )
    abort.abort()
    await stream
    await runtime.shutdown()
    expect(mocks.encrypt).not.toHaveBeenCalled()
    expect(mocks.available).not.toHaveBeenCalled()
    expect(await readdir(home)).toEqual([])
    await expect(runtime.ensureReady()).rejects.toThrow('正在退出')
  })

  it('安装取消收束后可以重试，消息发送失败仍拒绝请求，启动失败保留退出期限', async () => {
    const { runtime, child } = await fixture()
    mocks.install.mockImplementationOnce(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('安装已取消')), { once: true }),
        ),
    )
    const starting = runtime.ensureReady()
    await flush()
    await runtime.stop()
    await starting
    expect(mocks.fork).not.toHaveBeenCalled()
    expect((await runtime.retry()).kind).toBe('ready')
    const abort = new AbortController()
    const pending = runtime.call('test/call', {}, abort.signal)
    const rejected = expect(pending).rejects.toThrow()
    child.failPost = true
    abort.abort()
    await rejected
    child.failPost = false
    child.ignoreStop = true
    vi.useFakeTimers()
    child.emit('message', { type: 'failed', error: { message: '模拟核心加载失败' } })
    const stopping = runtime.stop()
    await vi.advanceTimersByTimeAsync(20_000)
    await stopping
    expect(child.kill).toHaveBeenCalledOnce()
    expect(runtime.getState().kind).toBe('unavailable')
  })
})
