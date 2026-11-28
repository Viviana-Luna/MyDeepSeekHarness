/**
 * 主进程访问运行核心 Remote RPC 的传输客户端。
 *
 * 负责将经过白名单与边界校验的产品动作发送到应用自有运行核心，
 * 施加字节数上限、有界超时与取消信号，并拒绝重定向或越权响应。
 */

import { randomUUID } from 'node:crypto'
import type { DesktopInteractionReceipt } from '../../shared/session-live.js'
import { isRecord } from '../../shared/validation.ts'
import {
  DSH_HOST_OPERATIONS,
  isPluginOperation,
  OPERATION_CANDIDATES,
  type DshHostOperation,
} from './host-operations.ts'
import { MAX_PROMPT_IMAGE_BYTES, parseEmptyArgument } from './host-payload-validators.ts'
import {
  OPERATION_RESULT_PARSERS,
  parseJoinedAgentPresetRoster,
  parseJoinedModelProviders,
  parseRpcResponse,
  parseSessionAttachmentDataUrl,
} from './host-result-parsers.ts'

export { DSH_HOST_OPERATIONS, type DshHostOperation } from './host-operations.ts'

const MAX_RPC_RESPONSE_BYTES = 8 * 1024 * 1024
const DEFAULT_RPC_TIMEOUT_MS = 15_000
const MAX_PROMPT_REQUEST_BYTES = 48 * 1024 * 1024
const MAX_INTERACTION_RESPONSE_BYTES = 512 * 1024

/** 斜杠命令执行（如上下文压缩）允许的最长超时毫秒数（10 分钟）。 */
export const SESSION_COMMAND_EXECUTION_TIMEOUT_MS = 10 * 60 * 1_000

/** 系统原生目录选择对话框允许的最长等待毫秒数（10 分钟）。 */
export const WORKSPACE_DIRECTORY_PICKER_TIMEOUT_MS = 10 * 60 * 1_000

/** 待响应交互提交给 `$events/result` 的结构化结果。 */
export type DshRemoteEventOutcome =
  | {
      readonly kind: 'result'
      readonly value?: unknown
    }
  | {
      readonly kind: 'rejected'
      readonly error: {
        readonly name: string
        readonly message: string
        readonly code?: string
      }
    }

/** `callDshHost` 可选的传输层参数元组（自定义 fetch、认证 Cookie 与取消信号）。 */
export type DshRpcTransportTuple = [fetchImpl?: typeof fetch, cookie?: string, signal?: AbortSignal]

/** `respondDshInteraction` 提交待用户交互回答的具名参数。 */
export interface RespondDshInteractionOptions {
  readonly targetUrl: URL
  readonly clientId: string
  readonly eventId: string
  readonly outcome: DshRemoteEventOutcome
  readonly fetchImpl?: typeof fetch
  readonly cookie?: string
  readonly signal?: AbortSignal
}

interface RpcInvocationOptions {
  readonly targetUrl: URL
  readonly endpoint: string
  readonly payload: Record<string, unknown>
  readonly operation: DshHostOperation
  readonly timeoutMs: number
  readonly fetchImpl: typeof fetch
  readonly cookie?: string
  readonly signal?: AbortSignal
}

function parseOperation(value: unknown): DshHostOperation {
  if (typeof value !== 'string' || !DSH_HOST_OPERATIONS.includes(value as DshHostOperation)) {
    throw new Error('不支持的 MyDSH 运行核心 操作')
  }
  return value as DshHostOperation
}

function parsePayload(value: unknown, maximumBytes = 256 * 1024): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('MyDSH 运行核心 请求参数必须是对象')
  const serialized = JSON.stringify(value)
  if (Buffer.byteLength(serialized, 'utf8') > maximumBytes) {
    throw new Error('MyDSH 运行核心 请求参数超过大小上限')
  }
  return value
}

function resolveOperationTimeoutMs(operation: DshHostOperation): number {
  if (operation === 'executeSessionCommand') return SESSION_COMMAND_EXECUTION_TIMEOUT_MS
  if (operation === 'pickWorkspaceDirectory') return WORKSPACE_DIRECTORY_PICKER_TIMEOUT_MS
  return DEFAULT_RPC_TIMEOUT_MS
}

function buildCombinedSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeoutSignal : AbortSignal.any([timeoutSignal, signal])
}

async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
  overflowMessage: string,
): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error(overflowMessage)
  }
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > maximumBytes) {
    throw new Error(overflowMessage)
  }
  return text
}

async function invokeDshRpc(options: RpcInvocationOptions): Promise<unknown> {
  const { targetUrl, endpoint, payload, operation, timeoutMs, fetchImpl, cookie, signal } = options
  const rpcId = randomUUID()
  const response = await fetchImpl(new URL(`/api/${endpoint}`, targetUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      method: endpoint,
      payload,
    }),
    redirect: 'error',
    signal: buildCombinedSignal(timeoutMs, signal),
  }).catch((error: unknown) => {
    if (!isPluginOperation(operation)) throw error
    const isAbortOrTimeout =
      error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
    throw new Error(
      isAbortOrTimeout
        ? '插件请求已取消或超时；写操作请先刷新状态再重试'
        : '无法访问插件服务，请检查运行核心状态',
    )
  })
  if (response.status === 401) throw new Error('MyDSH 运行核心拒绝未授权请求')
  if (response.status === 403) throw new Error('MyDSH 运行核心 拒绝了当前传输来源')
  if (!response.ok) {
    if (isPluginOperation(operation) && response.status === 404) {
      throw new Error('当前运行核心未提供此插件接口')
    }
    throw new Error(`MyDSH 运行核心 传输失败：HTTP ${String(response.status)}`)
  }
  const maximumBytes =
    operation === 'getSessionAttachment' ? MAX_PROMPT_IMAGE_BYTES * 2 : MAX_RPC_RESPONSE_BYTES
  const text = await readBoundedResponseText(
    response,
    maximumBytes,
    'MyDSH 运行核心 RPC 响应超过大小上限',
  )
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('MyDSH 运行核心 RPC 没有返回 JSON')
  }
  return parseRpcResponse(value, rpcId, operation)
}

/**
 * 通过固定运行核心传输通道执行一项白名单 Remote RPC。
 * renderer 只能选择产品动作，不能控制目标 URL、channel 或底层 endpoint。
 */
export async function callDshHost(
  targetUrl: URL,
  operationInput: unknown,
  payloadInput: unknown,
  ...transport: DshRpcTransportTuple
): Promise<unknown> {
  const [fetchImpl = fetch, cookie, signal] = transport
  const operation = parseOperation(operationInput)
  const payload = parsePayload(
    payloadInput,
    operation === 'promptSession' ? MAX_PROMPT_REQUEST_BYTES : undefined,
  )
  if (operation === 'listWorkspaces') {
    throw new Error('Workspace 列表必须从公开 workspace/follow 基线读取')
  }
  const timeoutMs = resolveOperationTimeoutMs(operation)
  const sharedRpcOptions = {
    targetUrl,
    operation,
    timeoutMs,
    fetchImpl,
    ...(cookie === undefined ? {} : { cookie }),
    ...(signal === undefined ? {} : { signal }),
  }
  if (operation === 'listModelProviders') {
    parseEmptyArgument(payload)
    const [configurable, active] = await Promise.all([
      invokeDshRpc({
        ...sharedRpcOptions,
        endpoint: 'llm/listConfigurableProviders',
        payload: { args: {} },
      }),
      invokeDshRpc({ ...sharedRpcOptions, endpoint: 'llm/listProviders', payload: { args: {} } }),
    ])
    return parseJoinedModelProviders(configurable, active)
  }
  if (operation === 'listAgentPresets') {
    parseEmptyArgument(payload)
    const [roster, hasDocument] = await Promise.all([
      invokeDshRpc({ ...sharedRpcOptions, endpoint: 'agentPresets/list', payload: { args: {} } }),
      invokeDshRpc({
        ...sharedRpcOptions,
        endpoint: 'settings/canOpenAgentPresetDirectory',
        payload: { args: {} },
      }),
    ])
    return parseJoinedAgentPresetRoster(roster, hasDocument)
  }
  const candidate = OPERATION_CANDIDATES[operation][0]
  if (candidate === undefined) throw new Error('当前 MyDSH 运行核心 不支持所需能力')
  const result = await invokeDshRpc({
    ...sharedRpcOptions,
    endpoint: candidate.endpoint,
    payload: candidate.payload(payload),
  })
  if (operation === 'getSessionAttachment') {
    return parseSessionAttachmentDataUrl(result, payload.attachmentId)
  }
  const parseResult = OPERATION_RESULT_PARSERS[operation]
  return parseResult === undefined ? result : parseResult(result)
}

/**
 * 回答一项由 `$events` 发起的待用户交互。关联值绑定当前事件流 generation，
 * 并且只进入固定的 `$events/result` Remote RPC。
 */
export async function respondDshInteraction(
  options: RespondDshInteractionOptions,
): Promise<DesktopInteractionReceipt> {
  const { targetUrl, clientId, eventId, outcome, fetchImpl = fetch, cookie, signal } = options
  if (
    clientId.length === 0 ||
    clientId.length > 512 ||
    eventId.length === 0 ||
    eventId.length > 512
  ) {
    throw new Error('待响应交互缺少有效的 Remote 关联标识')
  }
  const rpcId = randomUUID()
  const endpoint = '$events/result'
  const body = JSON.stringify({
    type: 'client-request',
    rpcId,
    method: endpoint,
    payload: { args: { clientId, eventId, outcome } },
  })
  if (Buffer.byteLength(body, 'utf8') > MAX_INTERACTION_RESPONSE_BYTES) {
    throw new Error('待响应交互的回答超过大小上限')
  }
  const response = await fetchImpl(new URL(`/api/${endpoint}`, targetUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
    },
    body,
    redirect: 'error',
    signal: buildCombinedSignal(DEFAULT_RPC_TIMEOUT_MS, signal),
  })
  if (response.status === 401) throw new Error('MyDSH 运行核心拒绝未授权请求')
  if (response.status === 403) throw new Error('MyDSH 运行核心 拒绝了当前传输来源')
  if (!response.ok) {
    throw new Error(`MyDSH 运行核心 交互应答失败：HTTP ${String(response.status)}`)
  }
  const text = await readBoundedResponseText(
    response,
    MAX_INTERACTION_RESPONSE_BYTES,
    'MyDSH 运行核心 交互应答回执超过大小上限',
  )
  try {
    parseRpcResponse(JSON.parse(text), rpcId, 'describe')
    return { accepted: true }
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('MyDSH 运行核心 交互应答没有返回 JSON', { cause: error })
    }
    throw error
  }
}
