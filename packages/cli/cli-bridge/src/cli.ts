/**
 * 二级 CLI 客户端脚本：在模型启动的 Shell 子进程中运行，通过本地 Unix Socket / Named Pipe 请求后台桥接服务。
 * 不直接持有任何凭据或业务代码；离线执行 `--help` 时回退到静态领域目录说明。
 */
import { createConnection } from 'node:net'
import { parseCliArgv, type ParsedCliCommand } from './argv-parser.ts'
import { renderDomainHelp, renderRootHelp } from './catalog.ts'

/** CLI 客户端向后台桥发送的单次请求载荷。 */
export interface CliBridgeRequest {
  readonly lease: string
  readonly argv: readonly string[]
  readonly stdin: string
}

/** 后台桥返回给 CLI 客户端的响应载荷。 */
export interface CliBridgeResponse {
  readonly ok: boolean
  readonly output?: string
  readonly error?: string
}

const IPC_ENV = 'DSH_MYDSH_IPC'
const LEASE_ENV = 'DSH_MYDSH_LEASE'
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

async function readStdinIfNeeded(parsed: ParsedCliCommand): Promise<string> {
  if (parsed.kind !== 'invoke') return ''
  if (!parsed.jsonFromStdin && parsed.stdinField === undefined) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  return Buffer.concat(chunks).toString('utf8')
}

const PIPE_RETRY_DELAYS_MS = [20, 40, 80, 120, 160] as const

function isTransientPipeConnectError(error: unknown): boolean {
  if (process.platform !== 'win32' || !(error instanceof Error)) return false
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EBUSY' || code === 'ENOENT' || code === 'EAGAIN'
}

function sendIpcRequestOnce(
  endpoint: string,
  payload: CliBridgeRequest,
): Promise<CliBridgeResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint)
    let buffer = ''
    let settled = false
    let connected = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      socket.destroy()
      fn()
    }
    socket.setEncoding('utf8')
    socket.once('connect', () => {
      connected = true
      socket.write(`${JSON.stringify(payload)}\n`)
    })
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (Buffer.byteLength(buffer, 'utf8') > MAX_RESPONSE_BYTES) {
        finish(() => reject(new Error('二级工具返回内容超过本地 IPC 大小上限')))
        return
      }
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      const line = buffer.slice(0, newline)
      finish(() => {
        try {
          resolve(JSON.parse(line) as CliBridgeResponse)
        } catch {
          reject(new Error('无法解析后台 CLI 桥响应'))
        }
      })
    })
    socket.once('error', error => {
      finish(() => {
        if (!connected && isTransientPipeConnectError(error)) {
          reject(error)
          return
        }
        reject(new Error(`连接 MyDSH 后台 CLI 桥失败：${error.message}`))
      })
    })
    socket.once('end', () => {
      finish(() => reject(new Error('MyDSH 后台 CLI 桥提前关闭了连接')))
    })
  })
}

async function sendIpcRequest(
  endpoint: string,
  payload: CliBridgeRequest,
): Promise<CliBridgeResponse> {
  for (let attempt = 0; attempt <= PIPE_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- Windows 命名管道并发繁忙时需串行指数退避重试。
      return await sendIpcRequestOnce(endpoint, payload)
    } catch (error) {
      const delay = PIPE_RETRY_DELAYS_MS[attempt]
      if (delay === undefined || !isTransientPipeConnectError(error)) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.startsWith('连接 MyDSH 后台 CLI 桥失败：')) throw error
        throw new Error(`连接 MyDSH 后台 CLI 桥失败：${message}`, { cause: error })
      }
      // oxlint-disable-next-line no-await-in-loop -- 退避等待后重连同一管道实例。
      await new Promise(resolveDelay => setTimeout(resolveDelay, delay))
    }
  }
  throw new Error('连接 MyDSH 后台 CLI 桥失败：命名管道持续繁忙')
}

function tryRenderOfflineHelp(parsed: ParsedCliCommand): string | undefined {
  if (parsed.kind !== 'help') return undefined
  if (!parsed.domain && !parsed.toolName) return renderRootHelp()
  if (parsed.domain && !parsed.action) return renderDomainHelp(parsed.domain)
  return undefined
}

/** 运行 CLI 客户端主流程并返回进程退出码。 */
export async function runCliMain(argv = process.argv.slice(2)): Promise<number> {
  let parsed: ParsedCliCommand
  try {
    parsed = parseCliArgv(argv)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }

  const endpoint = process.env[IPC_ENV]
  const lease = process.env[LEASE_ENV]
  const offlineHelp = tryRenderOfflineHelp(parsed)
  if ((!endpoint || !lease) && offlineHelp !== undefined) {
    process.stdout.write(`${offlineHelp}\n`)
    return 0
  }
  if (!endpoint || !lease) {
    process.stderr.write(
      'mydsh 命令只能在 MyDSH 会话的受管 Shell 工具内运行（缺少活动会话 IPC 租约）。\n',
    )
    return 1
  }

  try {
    const stdin = await readStdinIfNeeded(parsed)
    const response = await sendIpcRequest(endpoint, { lease, argv, stdin })
    if (!response.ok) {
      process.stderr.write(`${response.error ?? '二级工具调用失败'}\n`)
      return 1
    }
    if (response.output) {
      process.stdout.write(
        response.output.endsWith('\n') ? response.output : `${response.output}\n`,
      )
    }
    return 0
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

if (import.meta.main) {
  const exitCode = await runCliMain()
  process.exitCode = exitCode
}
