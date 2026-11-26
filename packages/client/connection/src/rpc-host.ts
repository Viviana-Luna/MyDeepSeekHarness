/** MyDSH 本地 Connection 注册与分发；浏览器授权及独立 HTTP 通道明确拒绝。 */

import { Context, Service } from '@deepseek-ai/cordis'
import {
  RpcId,
  type ClientRequest,
  type RpcId as RpcIdType,
} from './rpc.ts'
import { clientRequestSchema } from './rpc-schema.ts'
import { API_PATH } from './api-path.ts'
import type {
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionFetchRoute,
  ConnectionFetchHandler,
  HostConnectionFetch,
  ConnectionRpcEndpointMatcher,
  ConnectionRpcFailure,
  ConnectionRpcHandler,
  ConnectionRpcResult,
  ConnectionRequestRejection,
  ConnectionTrustRequest,
  HostConnectionHandle,
  HostConnectionRpc,
} from './rpc.ts'

const INVALID_REQUEST_RPC_ID = RpcId('invalid-request')
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

interface ConnectionRpcInterceptor {
  readonly matches: ConnectionRpcEndpointMatcher
  readonly fetchHandler: ConnectionFetchHandler
}

interface RegisteredFetchRoute {
  readonly methods: ReadonlySet<string>
  readonly requestBody: ConnectionFetchRoute['requestBody']
  readonly fetch: ConnectionFetchRoute['fetch']
}

interface ConnectionServerResponse {
  readonly type: 'server-response'
  readonly rpcId: RpcIdType
  readonly result: ConnectionRpcResult<unknown>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Connection transport and RPC registrations. */
    connection: HostConnectionHandle
  }
}

/** Host Connection service whose channel registrations belong to the caller fiber. */
export class HostConnectionService extends Service implements HostConnectionHandle {
  private readonly interceptors = new Map<string, ConnectionRpcInterceptor>()
  private readonly fetchRoutes = new Map<string, RegisteredFetchRoute>()

  /** 注册到插件所属 Context，释放范围仍由 Cordis 管理。 */
  constructor(ctx: Context) {
    super(ctx, 'connection')
  }

  /** Generic channel registry scoped to the Context reading this service. */
  get rpc(): HostConnectionRpc {
    const owner = this.ctx
    return {
      handle: (channel, handler) => this.register(owner, channel, handler),
      intercept: (channel, matches, handler) =>
        this.registerInterceptor(owner, channel, matches, handler),
    }
  }

  /** Exact Fetch-route registry scoped to the Context reading this service. */
  get fetch(): HostConnectionFetch {
    const owner = this.ctx
    return {
      register: route => this.registerFetchRoute(owner, route),
    }
  }

  /** MyDSH 不提供 HTTP 接入；保留协议接口并默认拒绝任何浏览器请求。 */
  requestRejection(_request: ConnectionTrustRequest): ConnectionRequestRejection {
    return 403
  }

  /** 本地 IPC 没有首页授权或 Cookie 交换。 */
  authorizeIndex(_request: ConnectionIndexRequest, _response: ConnectionIndexResponse): boolean {
    return false
  }

  /** 防止调用方把本地核心误当成可登录的 Web Host。 */
  authenticatedUrl(_baseUrl: string): string {
    throw new Error('MyDSH 仅支持本地 IPC，不提供浏览器授权地址')
  }

  /**
   * Compose one shared-channel Fetch handler from exact routes and its interceptor.
   * @param channel - shared channel mounted by Connection.
   * @returns Fetch handler that selects one owner or returns 404.
   */
  createSharedFetchHandler(
    channel: '/api',
  ): ConnectionFetchHandler {
    return {
      requestBodyMode: ({ method, url }) => {
        const route = this.fetchRoutes.get(url.pathname)
        return route?.methods.has(method) === true ? route.requestBody : 'buffered'
      },
      fetch: (request) => {
        const pathname = new URL(request.url).pathname
        const route = this.fetchRoutes.get(pathname)
        if (route?.methods.has(request.method) === true) return route.fetch(request)
        const endpoint = endpointFromPath(channel, pathname)
        const interceptor = this.interceptors.get(channel)
        if (endpoint === undefined || interceptor === undefined || !interceptor.matches(endpoint)) {
          return Promise.resolve(new Response('not found', { status: 404 }))
        }
        return interceptor.fetchHandler.fetch(request)
      },
    }
  }

  private registerFetchRoute(
    owner: Context,
    route: ConnectionFetchRoute,
  ): () => Promise<void> {
    assertFetchRoute(route)
    const registered: RegisteredFetchRoute = {
      methods: new Set(route.methods),
      requestBody: route.requestBody,
      fetch: route.fetch,
    }
    return owner.effect(() => {
      if (this.fetchRoutes.has(route.path)) {
        throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} is already registered`)
      }
      this.fetchRoutes.set(route.path, registered)
      return () => { this.fetchRoutes.delete(route.path) }
    }, `client-connection: ${route.path} Fetch route`)
  }

  /** 非共享 RPC 通道在上游依赖 HTTP 监听，MyDSH 必须明确拒绝。 */
  private register(
    _owner: Context,
    _channel: string,
    _handler: ConnectionRpcHandler,
  ): () => Promise<void> {
    throw new Error('MyDSH 不提供独立 HTTP 通道，请使用共享 Remote 接口')
  }

  private registerInterceptor(
    owner: Context,
    channel: string,
    matches: ConnectionRpcEndpointMatcher,
    handler: ConnectionRpcHandler,
  ): () => Promise<void> {
    if (channel !== API_PATH) {
      throw new Error(`connection: invalid shared RPC channel ${JSON.stringify(channel)}`)
    }
    const interceptor: ConnectionRpcInterceptor = {
      matches,
      fetchHandler: rpcFetchHandler(channel, handler),
    }
    return owner.effect(() => {
      if (this.interceptors.has(channel)) {
        throw new Error(`connection: shared RPC channel ${JSON.stringify(channel)} already has an interceptor`)
      }
      this.interceptors.set(channel, interceptor)
      return () => {
        this.interceptors.delete(channel)
      }
    }, `client-connection: ${channel} rpc interceptor`)
  }
}

function rpcFetchHandler(
  channel: string,
  handler: ConnectionRpcHandler,
): ConnectionFetchHandler {
  return {
    requestBodyMode: () => 'buffered',
    async fetch(request: Request): Promise<Response> {
      const endpoint = endpointFromPath(channel, new URL(request.url).pathname)
      if (request.method !== 'POST' || endpoint === undefined) {
        return new Response('not found', { status: 404 })
      }

      const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }

      let body: unknown
      try {
        body = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }

      const envelope = clientRequestSchema.safeParse(body)
      if (!envelope.success) {
        return invalidEnvelopeResponse(body, envelope.error.issues)
      }
      const message: ClientRequest = envelope.data
      if (message.method !== endpoint) {
        return errorResponse(message.rpcId, {
          code: 'gateway/bad-request',
          message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
          details: { issues: [] },
        })
      }

      try {
        const result = await handler(endpoint, message.payload, request.signal)
        return fullResponse(message.rpcId, result)
      } catch (error) {
        return new Response(`handler failure: ${String(error)}`, { status: 500 })
      }
    },
  }
}

function invalidEnvelopeResponse(body: unknown, issues: readonly object[]): Response {
  const rawId = (body as { rpcId?: unknown } | null)?.rpcId
  const rpcId = typeof rawId === 'string' ? RpcId(rawId) : INVALID_REQUEST_RPC_ID
  return errorResponse(rpcId, {
    code: 'gateway/bad-request',
    message: 'invalid client-request message',
    details: { issues },
  })
}

function endpointFromPath(channel: string, pathname: string): string | undefined {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  const segments = endpoint.split('/')
  if (segments.some(segment =>
    segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    return undefined
  }
  return endpoint
}

function errorResponse(rpcId: RpcIdType, error: ConnectionRpcFailure): Response {
  return fullResponse(rpcId, { ok: false, error })
}

function fullResponse(rpcId: RpcIdType, result: ConnectionRpcResult<unknown>): Response {
  const body: ConnectionServerResponse = { type: 'server-response', rpcId, result }
  return Response.json(body)
}

function assertFetchRoute(route: ConnectionFetchRoute): void {
  if (endpointFromPath(API_PATH, route.path) === undefined) {
    throw new Error(`connection: invalid exact Fetch route ${JSON.stringify(route.path)}`)
  }
  if (route.methods.length === 0) {
    throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} declares no methods`)
  }
  const methods = new Set(route.methods)
  if (methods.size !== route.methods.length) {
    throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} repeats a method`)
  }
}
