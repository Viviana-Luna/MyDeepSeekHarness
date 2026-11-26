/** MyDSH 本地 IPC 的 Connection 注册入口，不装配 HTTP 或浏览器授权。 */
import type { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from './rpc-host.ts'

export type {
  ConnectionFetchMethod,
  ConnectionFetchHandler,
  ConnectionFetchRoute,
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionRpcEndpointMatcher,
  ConnectionRpcFailure,
  ConnectionRpcHandler,
  ConnectionRequestRejection,
  ConnectionRpcResult,
  ConnectionRequestBodyMode,
  ConnectionTrustRequest,
  ClientRequest,
  HostConnectionHandle,
  HostConnectionFetch,
  HostConnectionRpc,
  RpcMessage,
  ServerResponse,
} from './rpc.ts'
export { RpcId, transportError } from './rpc.ts'
export {
  clientRequestSchema,
  rpcErrorSchema,
  rpcIdSchema,
  rpcMessageSchema,
  rpcResultSchema,
  serverResponseSchema,
} from './rpc-schema.ts'
export { HostConnectionService } from './rpc-host.ts'

export { API_PATH } from './api-path.ts'

/** 固定服务名沿用上游，已有 Remote 插件继续注入同一个 Connection。 */
export const name = 'client-connection'
export const inject: string[] = []

/**
 * 只提供载体无关的 RPC 拦截与 Fetch 路由注册。
 * 请求身份由 Electron 主进程及受限 preload 校验，不创建 Cookie 密钥或 Web 监听。
 */
export function apply(ctx: Context): void {
  new HostConnectionService(ctx)
}
