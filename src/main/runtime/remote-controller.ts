import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { isAbsolute } from 'node:path'
import type { MydshRuntimeSupervisor } from './runtime-supervisor.ts'
import { checkDatabaseAgentAccess, checkSshAgentAccess } from './connection-access-arguments.ts'

const sshFields: Record<string, readonly string[]> = {
  status: [],
  save: ['request'],
  importKey: ['id', 'revision'],
  remove: ['id', 'revision'],
  trustHost: ['id', 'revision', 'fingerprint'],
  resetHost: ['id', 'revision'],
  connect: ['id', 'testOnly', 'columns', 'rows'],
  input: ['id', 'data'],
  resize: ['id', 'columns', 'rows'],
  close: ['id'],
  closeAll: [],
  events: ['id'],
}
/** 桌面先复核字段和数值边界，后台 Typert 与业务服务继续校验契约和当前状态。 */
function checkSshArguments(method: string, args: Record<string, unknown>): void {
  const fields = Object.hasOwn(sshFields, method) ? sshFields[method] : undefined
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u
  if (
    !fields ||
    Object.keys(args).length !== fields.length ||
    fields.some(field => !Object.hasOwn(args, field))
  )
    throw new Error('SSH 桌面方法或参数不在允许范围内')
  if ('id' in args && (typeof args.id !== 'string' || !uuid.test(args.id)))
    throw new Error('SSH 连接或终端标识无效')
  if ('revision' in args && (!Number.isSafeInteger(args.revision) || Number(args.revision) < 1))
    throw new Error('SSH 配置版本无效')
  if (
    'fingerprint' in args &&
    (typeof args.fingerprint !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}$/u.test(args.fingerprint))
  )
    throw new Error('SSH 主机指纹无效')
  if ('testOnly' in args && typeof args.testOnly !== 'boolean') throw new Error('SSH 连接操作无效')
  if (
    'columns' in args &&
    (!Number.isInteger(args.columns) ||
      Number(args.columns) < 2 ||
      Number(args.columns) > 500 ||
      !Number.isInteger(args.rows) ||
      Number(args.rows) < 1 ||
      Number(args.rows) > 200)
  )
    throw new Error('SSH 终端尺寸无效')
  if ('data' in args && (typeof args.data !== 'string' || Buffer.byteLength(args.data) > 65536))
    throw new Error('SSH 终端输入无效或超过上限')
  if ('request' in args) {
    if (!args.request || typeof args.request !== 'object' || Array.isArray(args.request))
      throw new Error('SSH 配置必须是对象')
    const request = args.request as Record<string, unknown>
    const allowed = [
      'id',
      'revision',
      'name',
      'host',
      'port',
      'username',
      'auth',
      'environment',
      'projectId',
      'disabled',
      'password',
      'passphrase',
      'agentAccess',
    ]
    if ('agentAccess' in request) checkSshAgentAccess(request.agentAccess)
    if (
      Object.keys(request).some(field => !allowed.includes(field)) ||
      Buffer.byteLength(JSON.stringify(request)) > 256 * 1024 ||
      (request.id !== null && (typeof request.id !== 'string' || !uuid.test(request.id))) ||
      (request.revision !== null &&
        (!Number.isSafeInteger(request.revision) || Number(request.revision) < 1)) ||
      !['name', 'host', 'username', 'auth', 'environment'].every(
        field => typeof request[field] === 'string',
      ) ||
      !Number.isInteger(request.port) ||
      Number(request.port) < 1 ||
      Number(request.port) > 65535 ||
      typeof request.disabled !== 'boolean' ||
      (request.projectId !== null && typeof request.projectId !== 'string') ||
      ['password', 'passphrase'].some(
        field =>
          field in request &&
          (typeof request[field] !== 'string' || (request[field] as string).length > 65536),
      )
    )
      throw new Error('SSH 配置字段或数值无效')
  }
}

const databaseFields: Record<string, readonly string[]> = {
  status: [],
  pickSqliteFile: [],
  save: ['request'],
  remove: ['id', 'revision'],
  test: ['id'],
  databases: ['id'],
  schemas: ['id', 'catalog'],
  tables: ['id', 'catalog', 'schema'],
  columns: ['id', 'catalog', 'schema', 'table'],
  preview: ['id', 'catalog', 'schema', 'table', 'page', 'pageSize'],
  query: ['id', 'catalog', 'schema', 'sql'],
  close: ['id'],
  closeAll: [],
}

const DATABASE_ENGINES = new Set(['mysql', 'mariadb', 'postgresql', 'sqlite'])

function checkDatabaseSaveRequest(request: Record<string, unknown>, uuid: RegExp): void {
  const allowed = [
    'id',
    'revision',
    'engine',
    'name',
    'host',
    'port',
    'username',
    'database',
    'filePath',
    'tlsEnabled',
    'tlsServerName',
    'tlsCa',
    'sshConnectionId',
    'environment',
    'projectId',
    'disabled',
    'password',
    'agentAccess',
  ]
  if ('agentAccess' in request) checkDatabaseAgentAccess(request.agentAccess)
  const engine = request.engine === undefined ? 'mysql' : request.engine
  if (typeof engine !== 'string' || !DATABASE_ENGINES.has(engine))
    throw new Error('不支持的数据库类型')
  if (
    Object.keys(request).some(field => !allowed.includes(field)) ||
    Buffer.byteLength(JSON.stringify(request)) > 256 * 1024 ||
    (request.id !== null && (typeof request.id !== 'string' || !uuid.test(request.id))) ||
    (request.revision !== null &&
      (!Number.isSafeInteger(request.revision) || Number(request.revision) < 1)) ||
    typeof request.name !== 'string' ||
    typeof request.environment !== 'string' ||
    typeof request.disabled !== 'boolean' ||
    (request.projectId !== null && typeof request.projectId !== 'string') ||
    ('password' in request &&
      (typeof request.password !== 'string' || request.password.length > 65536))
  )
    throw new Error('数据库配置字段或数值无效')

  if (engine === 'sqlite') {
    if (
      'password' in request ||
      typeof request.filePath !== 'string' ||
      !request.filePath.trim() ||
      request.filePath.length > 4096 ||
      request.filePath.includes('\0') ||
      !isAbsolute(request.filePath) ||
      request.host !== '' ||
      request.username !== '' ||
      request.port !== 0 ||
      request.tlsEnabled !== false ||
      request.tlsServerName !== '' ||
      request.tlsCa !== '' ||
      request.sshConnectionId !== null ||
      request.database !== null
    )
      throw new Error('SQLite 本地数据库路径或附属参数无效')
    return
  }

  if (
    ('filePath' in request && request.filePath !== null) ||
    !['host', 'username', 'tlsServerName', 'tlsCa'].every(
      field => typeof request[field] === 'string',
    ) ||
    !Number.isInteger(request.port) ||
    Number(request.port) < 1 ||
    Number(request.port) > 65535 ||
    (request.sshConnectionId !== null &&
      (typeof request.sshConnectionId !== 'string' || !uuid.test(request.sshConnectionId))) ||
    (request.database !== null && typeof request.database !== 'string') ||
    typeof request.tlsEnabled !== 'boolean'
  )
    throw new Error('数据库配置字段或数值无效')
}

function checkDatabaseArguments(method: string, args: Record<string, unknown>): void {
  const fields = Object.hasOwn(databaseFields, method) ? databaseFields[method] : undefined
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u
  if (
    !fields ||
    Object.keys(args).length !== fields.length ||
    fields.some(field => !Object.hasOwn(args, field))
  )
    throw new Error('数据库桌面方法或参数不在允许范围内')
  if ('id' in args && (typeof args.id !== 'string' || !uuid.test(args.id)))
    throw new Error('数据库连接标识无效')
  if ('revision' in args && (!Number.isSafeInteger(args.revision) || Number(args.revision) < 1))
    throw new Error('数据库配置版本无效')
  if (
    'catalog' in args &&
    args.catalog !== null &&
    (typeof args.catalog !== 'string' ||
      !args.catalog ||
      args.catalog.length > 64 ||
      args.catalog.includes('\0'))
  )
    throw new Error('数据库实例名称无效')
  if (
    'schema' in args &&
    !(method === 'query' && args.schema === null) &&
    (typeof args.schema !== 'string' ||
      !args.schema ||
      args.schema.length > 64 ||
      args.schema.includes('\0'))
  )
    throw new Error('数据库名称无效')
  if (
    'table' in args &&
    (typeof args.table !== 'string' ||
      !args.table ||
      args.table.length > 64 ||
      args.table.includes('\0'))
  )
    throw new Error('数据表名称无效')
  if (
    'page' in args &&
    (!Number.isSafeInteger(args.page) ||
      Number(args.page) < 0 ||
      Number(args.page) > 1_000_000 ||
      !Number.isSafeInteger(args.pageSize) ||
      Number(args.pageSize) < 1 ||
      Number(args.pageSize) > 1000)
  )
    throw new Error('数据库分页参数无效')
  if ('sql' in args && (typeof args.sql !== 'string' || Buffer.byteLength(args.sql) > 64 * 1024))
    throw new Error('SQL 超过大小限制')
  if ('request' in args) {
    if (!args.request || typeof args.request !== 'object' || Array.isArray(args.request))
      throw new Error('数据库配置必须是对象')
    checkDatabaseSaveRequest(args.request as Record<string, unknown>, uuid)
  }
}

/** 扩展只能调用 Gateway 已登记的业务 Remote；桌面管理及系统能力另有窄接口。 */
function remoteRequest(
  endpoint: unknown,
  args: unknown,
): { endpoint: string; payload: { args: Record<string, unknown> } } {
  if (
    typeof endpoint !== 'string' ||
    endpoint.length > 256 ||
    !/^[A-Za-z][\w.-]*\/[A-Za-z][\w.-]*$/u.test(endpoint) ||
    /^mydsh(?:Runtime|Plugins|Converter|Workspace|Terminal)\//u.test(endpoint)
  )
    throw new Error('插件 Remote 方法不在公开业务范围内')
  if (!args || typeof args !== 'object' || Array.isArray(args))
    throw new Error('插件 Remote 参数必须是对象')
  if (endpoint.startsWith('mydshSsh/'))
    checkSshArguments(endpoint.slice('mydshSsh/'.length), args as Record<string, unknown>)
  if (endpoint.startsWith('mydshDatabase/'))
    checkDatabaseArguments(endpoint.slice('mydshDatabase/'.length), args as Record<string, unknown>)
  return { endpoint, payload: { args: args as Record<string, unknown> } }
}

interface Subscription {
  request: ReturnType<typeof remoteRequest>
  attempt?: AbortController
}

/** Runtime 代际只中止本次连接；页面意图仍保留，ready 时重新打开服务的基线流。 */
function stopAttempt(stream: Subscription): void {
  const attempt = stream.attempt
  delete stream.attempt
  attempt?.abort()
}

export function installRemoteController(
  win: BrowserWindow,
  runtime: MydshRuntimeSupervisor,
  assertSender: (event: IpcMainInvokeEvent, window: BrowserWindow) => void,
): () => void {
  // closed 触发时 BrowserWindow 的 webContents getter 已失效，清理必须使用安装时保存的引用。
  const contents = win.webContents
  const streams = new Map<string, Subscription>()
  const calls = new Map<string, AbortController>()
  let lastCallId = 0
  let ordinarySequence = 0
  let sshUsed = false
  let databaseUsed = false
  let pageLifetime = new AbortController()
  const startAttempt = (id: string, stream: Subscription): void => {
    if (stream.attempt || streams.get(id) !== stream || runtime.getState().kind !== 'ready') return
    const controller = new AbortController()
    stream.attempt = controller
    const current = (): boolean =>
      streams.get(id) === stream && stream.attempt === controller && !controller.signal.aborted
    const send = (frame: object): void => {
      if (!current() || win.isDestroyed()) return
      try {
        contents.send('mydsh:remote:frame', { id, ...frame })
      } catch {
        stopAttempt(stream)
        streams.delete(id)
      }
    }
    const finish = (frame: object): void => {
      if (!current()) return
      // 进程断开由状态订阅接管，不能向 preload 发终止帧使其丢弃恢复所需的意图。
      if (runtime.getState().kind === 'ready') {
        send(frame)
        streams.delete(id)
      }
      delete stream.attempt
    }
    void runtime
      .follow(stream.request.endpoint, stream.request.payload, controller.signal, async value => {
        send({ type: 'item', value })
      })
      .then(
        () => finish({ type: 'end' }),
        error =>
          finish({
            type: 'error',
            message: error instanceof Error ? error.message : String(error),
          }),
      )
  }
  const unsubscribe = runtime.subscribe(state => {
    for (const [id, stream] of streams) {
      if (state.kind === 'ready') startAttempt(id, stream)
      else stopAttempt(stream)
    }
  })
  /** 页面重新加载后 preload 会重新编号；旧页面的调用和订阅必须先释放。 */
  const clearPage = (): void => {
    pageLifetime.abort()
    pageLifetime = new AbortController()
    for (const call of calls.values()) call.abort()
    calls.clear()
    lastCallId = 0
    ordinarySequence = 0
    for (const stream of streams.values()) stopAttempt(stream)
    streams.clear()
  }
  // 外链导航可能在 will-navigate 被取消；只有主文档真正切换才释放当前页面。
  contents.on('did-navigate', clearPage)
  contents.on('render-process-gone', clearPage)
  const closeConnections = (): void => {
    if (sshUsed && runtime.getState().kind === 'ready')
      void runtime.call('mydshSsh/closeAll', { args: {} }).catch(() => {})
    if (databaseUsed && runtime.getState().kind === 'ready') {
      void runtime.call('mydshDatabase/closeAll', { args: {} }).catch(() => {})
    }
    sshUsed = false
    databaseUsed = false
  }
  contents.on('did-navigate', closeConnections)
  contents.on('render-process-gone', closeConnections)
  ipcMain.handle(
    'mydsh:remote:call',
    async (event, endpoint: unknown, args: unknown, id: unknown) => {
      assertSender(event, win)
      const request = remoteRequest(endpoint, args)
      if (request.endpoint.startsWith('mydshSsh/')) sshUsed = true
      if (request.endpoint.startsWith('mydshDatabase/')) databaseUsed = true
      if (calls.size >= 128) throw new Error('插件 Remote 调用超过并发上限')
      if (
        id !== undefined &&
        (typeof id !== 'string' || !/^[1-9][0-9]{0,11}$/u.test(id) || Number(id) <= lastCallId)
      )
        throw new Error('插件 Remote 调用标识无效或已经使用')
      // 同一页面只接受递增编号，迟到的取消消息不能作用于重复使用该编号的新调用。
      if (typeof id === 'string') lastCallId = Number(id)
      const key = typeof id === 'string' ? id : `ordinary-${++ordinarySequence}`
      const controller = new AbortController()
      calls.set(key, controller)
      try {
        const signal = AbortSignal.any([pageLifetime.signal, controller.signal])
        const result = (await runtime.call(request.endpoint, request.payload, signal)) as {
          ok: boolean
          value?: unknown
          error?: { message: string }
        }
        if (!result.ok) throw new Error(result.error?.message ?? '插件 Remote 调用失败')
        return result.value
      } finally {
        if (calls.get(key) === controller) calls.delete(key)
      }
    },
  )
  ipcMain.handle('mydsh:remote:cancel-call', (event, id: unknown) => {
    assertSender(event, win)
    if (typeof id !== 'string' || !/^[1-9][0-9]{0,11}$/u.test(id))
      throw new Error('插件 Remote 取消标识无效')
    calls.get(id)?.abort(new Error('单次 Remote 调用已取消'))
  })
  ipcMain.handle('mydsh:remote:follow', (event, id: unknown, endpoint: unknown, args: unknown) => {
    assertSender(event, win)
    if (
      typeof id !== 'string' ||
      !/^[0-9]{1,12}$/u.test(id) ||
      streams.has(id) ||
      streams.size >= 64
    )
      throw new Error('插件事件订阅无效或超过上限')
    const request = remoteRequest(endpoint, args)
    if (request.endpoint.startsWith('mydshSsh/')) sshUsed = true
    const stream = { request }
    streams.set(id, stream)
    startAttempt(id, stream)
  })
  ipcMain.handle('mydsh:remote:cancel', (event, id: unknown) => {
    assertSender(event, win)
    if (typeof id !== 'string') return
    const stream = streams.get(id)
    if (stream) stopAttempt(stream)
    streams.delete(id)
  })
  return () => {
    unsubscribe()
    clearPage()
    closeConnections()
    contents.removeListener('did-navigate', clearPage)
    contents.removeListener('render-process-gone', clearPage)
    contents.removeListener('did-navigate', closeConnections)
    contents.removeListener('render-process-gone', closeConnections)
    for (const method of ['call', 'cancel-call', 'follow', 'cancel'])
      ipcMain.removeHandler(`mydsh:remote:${method}`)
  }
}
