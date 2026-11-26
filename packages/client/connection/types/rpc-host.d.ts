/** MyDSH 本地 Connection 注册与分发；浏览器授权及独立 HTTP 通道明确拒绝。 */
import { Context, Service } from '@deepseek-ai/cordis';
import type { ConnectionIndexRequest, ConnectionIndexResponse, ConnectionFetchHandler, HostConnectionFetch, ConnectionRequestRejection, ConnectionTrustRequest, HostConnectionHandle, HostConnectionRpc } from './rpc.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Host Connection transport and RPC registrations. */
        connection: HostConnectionHandle;
    }
}
/** Host Connection service whose channel registrations belong to the caller fiber. */
export declare class HostConnectionService extends Service implements HostConnectionHandle {
    private readonly interceptors;
    private readonly fetchRoutes;
    /** 注册到插件所属 Context，释放范围仍由 Cordis 管理。 */
    constructor(ctx: Context);
    /** Generic channel registry scoped to the Context reading this service. */
    get rpc(): HostConnectionRpc;
    /** Exact Fetch-route registry scoped to the Context reading this service. */
    get fetch(): HostConnectionFetch;
    /** MyDSH 不提供 HTTP 接入，任何浏览器请求均拒绝。 */
    requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection;
    /** 本地 IPC 没有首页授权或 Cookie 交换，始终拒绝。 */
    authorizeIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse): boolean;
    /** MyDSH 不提供浏览器授权地址，调用时抛出明确错误。 */
    authenticatedUrl(baseUrl: string): string;
    /**
     * Compose one shared-channel Fetch handler from exact routes and its interceptor.
     * @param channel - shared channel mounted by Connection.
     * @returns Fetch handler that selects one owner or returns 404.
     */
    createSharedFetchHandler(channel: '/api'): ConnectionFetchHandler;
    private registerFetchRoute;
    private register;
    private registerInterceptor;
}
