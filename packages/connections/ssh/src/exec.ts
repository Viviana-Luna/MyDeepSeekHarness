/**
 * SSH 非交互命令执行引擎：运行在后台 Runtime，负责安全 cwd 包装、超时/取消中断、头尾裁剪与敏感信息脱敏。
 * 每次执行创建独立的 exec 通道并在结束、超时或取消时立即关闭，不干扰人工交互式 PTY 终端。
 */
import type { Client, ClientChannel } from 'ssh2'

const DEFAULT_EXEC_TIMEOUT_MS = 30_000
const MAX_EXEC_TIMEOUT_MS = 120_000
const MIN_EXEC_TIMEOUT_MS = 1_000
const MAX_CAPTURE_BYTES_PER_STREAM = 512 * 1024
const DEFAULT_STDOUT_BUDGET = 26 * 1024
const DEFAULT_STDERR_BUDGET = 12 * 1024

/** 远端命令执行完成后的结构化结果（已脱敏并受总字节预算约束）。 */
export interface RemoteExecResult {
  readonly exit_code: number | null
  readonly signal: string | null
  readonly timed_out: boolean
  readonly duration_ms: number
  readonly stdout: string
  readonly stderr: string
  readonly stdout_truncated: boolean
  readonly stderr_truncated: boolean
}

function quotePosixSingle(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** 将可选工作目录与命令组合成保留退出码与注释安全性的 POSIX Shell 表达式。 */
export function buildRemoteExecCommand(command: string, cwd?: string): string {
  if (!cwd) return command
  return `cd -- ${quotePosixSingle(cwd)} && {\n${command}\n}`
}

/** 隐藏已解密的连接凭据及常见私钥 PEM 块，避免远端输出意外泄露敏感信息。 */
export function redactRemoteOutput(text: string, safeMessage: (message: string) => string): string {
  const scrubbed = safeMessage(text)
  return scrubbed.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu,
    '[已隐藏私钥内容]',
  )
}

/** 对超长命令输出执行 60% 头部 + 40% 尾部的双端保留裁剪，便于同时保留入口与末行报错。 */
export function boundStreamOutput(
  text: string,
  maxBytes: number,
  alreadyTruncated = false,
): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return { text, truncated: alreadyTruncated }
  const noticeTemplate = '\n... [输出已裁剪，省略约 000000 字节] ...\n'
  const usable = Math.max(256, maxBytes - Buffer.byteLength(noticeTemplate, 'utf8'))
  const headBytes = Math.floor(usable * 0.6)
  const tailBytes = usable - headBytes
  const head = buffer.subarray(0, headBytes).toString('utf8')
  const tail = buffer.subarray(buffer.length - tailBytes).toString('utf8')
  const omitted = buffer.length - headBytes - tailBytes
  return {
    text: `${head}\n... [输出已裁剪，省略约 ${omitted} 字节] ...\n${tail}`,
    truncated: true,
  }
}

class BoundedStreamCollector {
  private readonly chunks: Buffer[] = []
  private totalBytes = 0
  public truncated = false

  push(chunk: Buffer): void {
    if (this.totalBytes >= MAX_CAPTURE_BYTES_PER_STREAM) {
      this.truncated = true
      return
    }
    const remaining = MAX_CAPTURE_BYTES_PER_STREAM - this.totalBytes
    if (chunk.length > remaining) {
      this.chunks.push(chunk.subarray(0, remaining))
      this.totalBytes += remaining
      this.truncated = true
      return
    }
    this.chunks.push(chunk)
    this.totalBytes += chunk.length
  }

  toString(): string {
    return Buffer.concat(this.chunks, this.totalBytes).toString('utf8')
  }
}

/** 校验命令超时参数并返回合法毫秒值（1 秒至 120 秒，默认 30 秒）。 */
export function normalizeExecTimeoutMs(timeoutMs?: number): number {
  if (timeoutMs === undefined) return DEFAULT_EXEC_TIMEOUT_MS
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < MIN_EXEC_TIMEOUT_MS ||
    timeoutMs > MAX_EXEC_TIMEOUT_MS
  ) {
    throw new Error(`timeout_ms 必须是 ${MIN_EXEC_TIMEOUT_MS} 至 ${MAX_EXEC_TIMEOUT_MS} 之间的整数`)
  }
  return timeoutMs
}

/**
 * 在已认证的 SSH 客户端上通过非交互 exec 通道执行命令。
 * 超时时尝试发送 SIGINT 并返回 `timed_out: true` 及已捕获输出；外部取消时直接抛出中止错误。
 */
export function runRemoteExec(
  client: Client,
  safeMessage: (message: string) => string,
  input: {
    command: string
    cwd?: string
    timeoutMs?: number
    signal: AbortSignal
  },
): Promise<RemoteExecResult> {
  input.signal.throwIfAborted()
  const timeoutMs = normalizeExecTimeoutMs(input.timeoutMs)
  const wrapped = buildRemoteExecCommand(input.command, input.cwd)
  const startedAt = Date.now()
  return new Promise<RemoteExecResult>((resolve, reject) => {
    const stdout = new BoundedStreamCollector()
    const stderr = new BoundedStreamCollector()
    let channel: ClientChannel | undefined
    let settled = false
    let timedOut = false
    let exitCode: number | null = null
    let exitSignal: string | null = null

    const cleanup = () => {
      clearTimeout(timer)
      input.signal.removeEventListener('abort', onAbort)
    }
    const finalize = (error?: Error) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) {
        reject(new Error(safeMessage(error.message)))
        return
      }
      const boundedOut = boundStreamOutput(
        redactRemoteOutput(stdout.toString(), safeMessage),
        DEFAULT_STDOUT_BUDGET,
        stdout.truncated,
      )
      const boundedErr = boundStreamOutput(
        redactRemoteOutput(stderr.toString(), safeMessage),
        DEFAULT_STDERR_BUDGET,
        stderr.truncated,
      )
      resolve({
        exit_code: exitCode,
        signal: exitSignal,
        timed_out: timedOut,
        duration_ms: Math.max(0, Date.now() - startedAt),
        stdout: boundedOut.text,
        stderr: boundedErr.text,
        stdout_truncated: boundedOut.truncated,
        stderr_truncated: boundedErr.truncated,
      })
    }
    const terminateChannel = () => {
      if (!channel) return
      try {
        channel.signal('INT')
      } catch {
        // 部分服务端不支持远端信号投递，继续直接关闭通道。
      }
      channel.close()
      channel.destroy()
    }
    const onAbort = () => {
      terminateChannel()
      finalize(new Error('SSH 命令执行已取消'))
    }
    const timer = setTimeout(() => {
      timedOut = true
      terminateChannel()
      finalize()
    }, timeoutMs)
    timer.unref?.()
    input.signal.addEventListener('abort', onAbort, { once: true })

    client.exec(wrapped, (error, stream) => {
      if (error) {
        finalize(error)
        return
      }
      if (settled) {
        stream.destroy()
        return
      }
      channel = stream
      stream.on('data', (chunk: Buffer) => stdout.push(chunk))
      stream.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
      stream.on('exit', (code: number | null, signalName?: string) => {
        exitCode = typeof code === 'number' ? code : null
        exitSignal = typeof signalName === 'string' && signalName ? signalName : null
      })
      stream.on('error', (streamError: Error) => finalize(streamError))
      stream.once('close', (code?: number | null, signalName?: string) => {
        if (exitCode === null && typeof code === 'number') exitCode = code
        if (exitSignal === null && typeof signalName === 'string' && signalName)
          exitSignal = signalName
        finalize()
      })
    })
  })
}
