import { createServer } from 'node:http'
import { LlmError } from '@deepseek-ai/dsh-llm'

/** 单次 OAuth 回调：仅绑定 IPv4 回环地址，不承载桌面业务，也不接受其他路由。 */
export async function receiveAuthorization(
  signal: AbortSignal,
  state: string,
  clientId: string | undefined,
  ready: (redirectUri: string) => void,
): Promise<{ code: string; clientId: string; redirectUri: string }> {
  signal.throwIfAborted()
  let redirectUri = '',
    consumed = false
  let resolve!: (value: { code: string; clientId: string; redirectUri: string }) => void
  let reject!: (error: Error) => void
  const pending = new Promise<{ code: string; clientId: string; redirectUri: string }>(
    (yes, no) => {
      resolve = yes
      reject = no
    },
  )
  // bind 和通知期间也可能取消，立即消费拒绝，最终仍由下面的 await 报告。
  void pending.catch(() => undefined)
  const server = createServer(
    { maxHeaderSize: 16_384, requestTimeout: 5000, headersTimeout: 5000 },
    (request, response) => {
      response.setHeader('cache-control', 'no-store')
      response.setHeader('content-type', 'text/plain; charset=utf-8')
      response.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'")
      response.setHeader('referrer-policy', 'no-referrer')
      let url: URL
      try {
        url = new URL(request.url ?? '/', redirectUri)
      } catch {
        response.writeHead(400).end('回调地址无效')
        return
      }
      if (
        request.method !== 'GET' ||
        request.headers.host !== new URL(redirectUri).host ||
        url.origin !== new URL(redirectUri).origin ||
        url.pathname !== '/auth/callback' ||
        request.socket.remoteAddress !== '127.0.0.1'
      ) {
        response.writeHead(404).end('未找到授权回调')
        return
      }
      if (consumed) {
        response.writeHead(409).end('此授权回调已处理')
        return
      }
      consumed = true
      const fail = (message: string) => {
        response.writeHead(400).end(message)
        reject(new LlmError(message, 'AUTH_REQUIRED'))
      }
      const params = url.searchParams
      if (
        ['state', 'code', 'client_id', 'error'].some(key => params.getAll(key).length > 1) ||
        params.get('state') !== state
      ) {
        fail('无法核对授权回调，请返回 MyDSH 重新连接')
        return
      }
      if (params.has('error')) {
        fail('授权未获同意，请返回 MyDSH 重新连接')
        return
      }
      const issued = params.get('client_id') ?? clientId,
        code = params.get('code')
      if (
        !code ||
        code.length > 8192 ||
        !issued ||
        !/^[A-Za-z0-9._:-]+$/u.test(issued) ||
        issued === 'dynamic_agent_client' ||
        issued.length > 512 ||
        (clientId !== undefined && issued !== clientId)
      ) {
        fail('授权码或客户端注册信息不匹配，请重新连接')
        return
      }
      response.end('已收到授权回调，请返回 MyDSH 查看连接结果。', () => {
        resolve({ code, clientId: issued, redirectUri })
      })
    },
  )
  const abort = () => {
    reject(new LlmError('ChatGPT 授权已取消或超时', 'ABORTED'))
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    await new Promise<void>((yes, no) => {
      server.once('error', no)
      server.listen(0, '127.0.0.1', yes)
    })
    signal.throwIfAborted()
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new LlmError('无法建立本机授权回调', 'AUTH_REQUIRED')
    redirectUri = `http://127.0.0.1:${address.port}/auth/callback`
    ready(redirectUri)
    return await pending
  } finally {
    signal.removeEventListener('abort', abort)
    server.closeAllConnections()
    await new Promise<void>(done => {
      server.close(() => {
        done()
      })
    })
  }
}
