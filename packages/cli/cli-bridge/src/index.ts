/**
 * `@mydsh/cli-bridge` 后台插件入口：将自研外围工具隔离在专用注册表中，并通过本地 IPC 向受管 Shell 暴露 `mydsh` CLI。
 * 运行在后台 Runtime；拥有本地 Unix Socket / Named Pipe 服务端、会话租约与临时垫片目录，停用时完整回收。
 */
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  AttachmentId,
  type AttachmentStore,
  type ImageAttachmentRef,
} from '@deepseek-ai/dsh-attachment'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { DSH_ENV_PREFIX } from '@deepseek-ai/dsh-shell'
import '@deepseek-ai/dsh-shell-env'
import * as CordisInspectTools from '@deepseek-ai/dsh-tool-cordis'
import {
  validateJsonSchemaValue,
  type JsonSchemaNode,
  type ToolDefinition,
  type ToolGuard,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import '@mydsh/browser-automation'
import * as BrowserTools from '@mydsh/browser-automation/tools'
import * as ComputerTools from '@mydsh/computer-use/tools'
import * as DatabaseTools from '@mydsh/database/tools'
import * as SshTools from '@mydsh/ssh/tools'
import { materializeToolArguments, parseCliArgv, type ParsedCliCommand } from './argv-parser.ts'
import {
  renderActionHelp,
  renderDomainHelp,
  renderRootHelp,
  type CliToolSchema,
} from './catalog.ts'
import type { CliBridgeRequest, CliBridgeResponse } from './cli.ts'
import { CliLeaseStore, type CliExecutionLease } from './lease-store.ts'
import { createCliWorkspace, type CliWorkspaceHandle } from './shims.ts'
import { hardenWindowsNamedPipe } from './windows-pipe-acl.ts'

/** CLI 桥插件的可选扩展配置。 */
export interface CliBridgeConfig {
  readonly nodeExecutable?: string
  readonly mountExtraTools?: (isolatedCtx: Context) => Promise<void> | void
}

/** 挂载在 Cordis Context 上的二级 CLI 桥服务接口（供测试与评测检查隔离工具目录）。 */
export interface MydshCliBridgeService {
  readonly endpoint: string
  readonly cliBinaryPath: string
  listHiddenSchemas(): CliToolSchema[]
  issueTestLease(agent?: CliExecutionLease['agent']): string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mydshCliBridge: MydshCliBridgeService
  }
}

const IPC_KEY = `${DSH_ENV_PREFIX}MYDSH_IPC` as const
const LEASE_KEY = `${DSH_ENV_PREFIX}MYDSH_LEASE` as const
const CLI_BIN_KEY = `${DSH_ENV_PREFIX}MYDSH_CLI` as const
const MAX_REQUEST_BYTES = 4 * 1024 * 1024
const SCREENSHOT_HINT = '截图已写入本地文件 image_path，可使用 read 或 view_image 查看画面内容。'

const EXT_BY_MIME: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/** 仅向二级 CLI 公开的工具注册表，避免将外围 Schema 暴露到模型的一级工具列表。 */
class IsolatedCliTools {
  private readonly definitions = new Map<string, ToolDefinition>()
  private readonly guards = new Set<ToolGuard>()

  register(definition: ToolDefinition): () => void {
    this.definitions.set(definition.name, definition)
    return () => {
      if (this.definitions.get(definition.name) === definition) {
        this.definitions.delete(definition.name)
      }
    }
  }

  guard(fn: ToolGuard): () => void {
    this.guards.add(fn)
    return () => {
      this.guards.delete(fn)
    }
  }

  get(toolName: string): ToolDefinition | undefined {
    return this.definitions.get(toolName)
  }

  schemas(): CliToolSchema[] {
    return [...this.definitions.values()].map(item => ({
      name: item.name,
      description: item.description,
      parameters: structuredClone(item.parameters),
    }))
  }

  checkGuards(execution: Parameters<ToolGuard>[0]): string | undefined {
    for (const check of this.guards) {
      const denied = check(execution)
      if (denied !== undefined) return denied
    }
    return undefined
  }
}

const silentSystemPrompt = {
  getSectionOrder: () => 0,
  section: () => () => undefined,
}

/** Cordis 插件名称。 */
export const name = 'mydsh-cli-bridge'

/** 依赖的宿主基础服务；外围业务服务存在时自动挂载。 */
export const inject = ['shellEnv']

async function writeScreenshotFileIfPresent(
  ctx: Context,
  capturesDir: string,
  value: unknown,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const image = (value as Record<string, unknown>).image
  if (!image || typeof image !== 'object' || Array.isArray(image)) return undefined
  const imageRecord = image as {
    attachmentId?: unknown
    mediaType?: unknown
    bytes?: unknown
    width?: unknown
    height?: unknown
  }
  if (typeof imageRecord.attachmentId !== 'string') return undefined
  const attachments = ctx.get('attachments') as AttachmentStore | undefined
  if (!attachments) return undefined
  const ref: ImageAttachmentRef = {
    attachmentId: AttachmentId(imageRecord.attachmentId),
    mediaType: (typeof imageRecord.mediaType === 'string'
      ? imageRecord.mediaType
      : 'image/png') as ImageAttachmentRef['mediaType'],
    bytes: typeof imageRecord.bytes === 'number' ? imageRecord.bytes : 0,
    width: typeof imageRecord.width === 'number' ? imageRecord.width : 1,
    height: typeof imageRecord.height === 'number' ? imageRecord.height : 1,
  }
  const stored = await attachments.readImage(ref, signal)
  const ext = EXT_BY_MIME[ref.mediaType] ?? 'png'
  const filePath = join(capturesDir, `capture-${randomUUID().slice(0, 8)}.${ext}`)
  await writeFile(filePath, stored.data, { mode: 0o600 })
  return filePath
}

function attachScreenshotPathToOutput(renderedText: string, imagePath: string): string {
  const firstBreak = renderedText.indexOf('\n')
  const head = firstBreak >= 0 ? renderedText.slice(0, firstBreak) : renderedText
  const tail = firstBreak >= 0 ? renderedText.slice(firstBreak) : ''
  try {
    const parsed = JSON.parse(head) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const merged = {
        ...(parsed as Record<string, unknown>),
        image_path: imagePath,
        hint: SCREENSHOT_HINT,
      }
      return `${JSON.stringify(merged, null, 2)}${tail}`
    }
  } catch {
    // 非 JSON 文本块保留原渲染安全输出并在末尾附加落盘路径。
  }
  const suffix = JSON.stringify({ image_path: imagePath, hint: SCREENSHOT_HINT }, null, 2)
  return renderedText ? `${renderedText}\n\n${suffix}` : suffix
}

async function confirmConverterInstallIfNeeded(options: {
  readonly ctx: Context
  readonly toolName: string
  readonly callId: string
  readonly lease: CliExecutionLease
  readonly signal: AbortSignal
}): Promise<void> {
  const { ctx, toolName, callId, lease, signal } = options
  if (toolName !== 'converter_install') return
  const approval = ctx.get('approval')
  if (!approval || typeof approval.request !== 'function' || !lease.agent) {
    throw new Error('当前环境缺少审批服务或活动会话，已拒绝安装受信任插件')
  }
  const outcome: ApprovalOutcome = await approval.request({
    agent: lease.agent as Agent,
    toolName,
    callId: callId as ToolCallId,
    reason: '安装此转换产物后，插件将作为受信任原生代码在 MyDSH 中运行。请确认安装。',
    signal,
  })
  if (outcome === 'allowed-once') return
  if (outcome === 'cancelled') throw new Error('插件安装审批已取消')
  if (outcome === 'unavailable') {
    throw new Error('当前没有可用的审批通道，已拒绝安装受信任插件')
  }
  throw new Error('用户拒绝了受信任插件安装审批')
}

function resolveHelpResponse(
  parsed: Extract<ParsedCliCommand, { kind: 'help' }>,
  schemas: readonly CliToolSchema[],
): CliBridgeResponse {
  if (!parsed.domain && !parsed.toolName) return { ok: true, output: renderRootHelp() }
  if (parsed.domain && !parsed.action) {
    const text = renderDomainHelp(parsed.domain)
    return text ? { ok: true, output: text } : { ok: false, error: `未知领域 "${parsed.domain}"` }
  }
  const targetName = parsed.toolName ?? ''
  const schema = schemas.find(item => item.name === targetName)
  if (!schema) return { ok: false, error: `未找到二级工具 "${targetName}"` }
  const label =
    parsed.domain && parsed.action
      ? `mydsh ${parsed.domain} ${parsed.action}`
      : `mydsh call ${targetName}`
  return { ok: true, output: renderActionHelp(label, schema) }
}

async function renderCliToolOutput(options: {
  readonly ctx: Context
  readonly capturesDir: string
  readonly definition: ToolDefinition
  readonly validatedArgs: Record<string, unknown>
  readonly rawResult: unknown
  readonly signal: AbortSignal
}): Promise<string> {
  const { ctx, capturesDir, definition, validatedArgs, rawResult, signal } = options
  // 始终先执行原工具 output.render，保留不可信文本清洗、截断与坐标校准提示。
  const blocks = definition.output.render(validatedArgs as never, rawResult as never)
  const textParts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') textParts.push(block.text)
  }
  const baseText = textParts.length > 0 ? textParts.join('\n') : JSON.stringify(rawResult, null, 2)
  const imagePath = await writeScreenshotFileIfPresent(ctx, capturesDir, rawResult, signal)
  return imagePath ? attachScreenshotPathToOutput(baseText, imagePath) : baseText
}

async function dispatchCliRequest(options: {
  readonly ctx: Context
  readonly registry: IsolatedCliTools
  readonly leases: CliLeaseStore
  readonly capturesDir: string
  readonly request: CliBridgeRequest
  readonly connectionSignal: AbortSignal
}): Promise<CliBridgeResponse> {
  const { ctx, registry, leases, capturesDir, request, connectionSignal } = options
  const lease = leases.verify(request.lease)
  if (!lease) {
    return { ok: false, error: '二级 CLI 会话租约无效或已过期，请从当前会话的 Shell 工具重试。' }
  }
  const parsed = parseCliArgv(Array.isArray(request.argv) ? request.argv : [])
  const schemas = registry.schemas()
  if (parsed.kind === 'help') return resolveHelpResponse(parsed, schemas)

  const definition = registry.get(parsed.toolName)
  if (!definition) {
    return {
      ok: false,
      error: `未注册的二级工具 "${parsed.toolName}"；请运行 mydsh --help 查看支持命令`,
    }
  }
  const schema = schemas.find(item => item.name === parsed.toolName)
  const rawArgs = materializeToolArguments(
    parsed,
    schema,
    typeof request.stdin === 'string' ? request.stdin : '',
  )
  const violations = validateJsonSchemaValue(
    definition.parameters as JsonSchemaNode,
    rawArgs,
    'arguments',
  )
  if (violations.length > 0) {
    return { ok: false, error: `参数校验失败：${violations.join('；')}` }
  }
  const callId = `cli-${randomUUID()}`
  const execContext = {
    callId: callId as never,
    rootCallId: callId as never,
    name: parsed.toolName,
    arguments: rawArgs as never,
    ...(lease.agent === undefined ? {} : { agent: lease.agent as never }),
    signal: connectionSignal,
    deferContext: () => undefined,
    concludeTurn: () => undefined,
  }
  const deniedReason = registry.checkGuards(execContext as unknown as Parameters<ToolGuard>[0])
  if (deniedReason !== undefined) return { ok: false, error: deniedReason }
  await confirmConverterInstallIfNeeded({
    ctx,
    toolName: parsed.toolName,
    callId,
    lease,
    signal: connectionSignal,
  })
  const rawResult = await definition.execute(
    rawArgs as never,
    execContext as unknown as ToolRunContext,
  )
  const output = await renderCliToolOutput({
    ctx,
    capturesDir,
    definition,
    validatedArgs: rawArgs,
    rawResult,
    signal: connectionSignal,
  })
  return { ok: true, output }
}

function attachSocketHandler(
  server: Server,
  onRequest: (req: CliBridgeRequest, signal: AbortSignal) => Promise<CliBridgeResponse>,
): Set<Socket> {
  const sockets = new Set<Socket>()
  server.on('connection', socket => {
    sockets.add(socket)
    const abortController = new AbortController()
    let buffer = ''
    let handled = false
    socket.setEncoding('utf8')
    socket.once('close', () => {
      sockets.delete(socket)
      abortController.abort(new Error('CLI 客户端连接已断开'))
    })
    socket.on('data', (chunk: string) => {
      if (handled) return
      buffer += chunk
      if (Buffer.byteLength(buffer, 'utf8') > MAX_REQUEST_BYTES) {
        handled = true
        socket.end(`${JSON.stringify({ ok: false, error: 'CLI 请求体积超过 4MiB 上限' })}\n`)
        return
      }
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      handled = true
      const rawLine = buffer.slice(0, newline)
      void (async () => {
        let response: CliBridgeResponse
        try {
          const parsed = JSON.parse(rawLine) as CliBridgeRequest
          response = await onRequest(parsed, abortController.signal)
        } catch (error) {
          response = {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }
        }
        if (!socket.destroyed) {
          socket.end(`${JSON.stringify(response)}\n`)
        }
      })()
    })
  })
  return sockets
}

function mountDomainPlugins(isolated: Context): void {
  isolated.plugin(DatabaseTools)
  isolated.plugin(SshTools)
  isolated.plugin(BrowserTools)
  isolated.plugin(ComputerTools)
  isolated.plugin(CordisInspectTools)
}

/**
 * 安装后台二级 CLI 桥插件：隔离挂载外围工具模块，启动本地 IPC 监听并向 `shellEnv` 注册租约注入器。
 */
export async function apply(ctx: Context, config: CliBridgeConfig = {}): Promise<void> {
  ctx.provide('mydshCliBridge')
  const registry = new IsolatedCliTools()
  const isolated = ctx.isolate('tools').isolate('systemPrompt')
  await isolated
    .plugin(async inner => {
      inner.provide('tools', registry as unknown as Context['tools'])
      inner.provide('systemPrompt', silentSystemPrompt as unknown as Context['systemPrompt'])
      mountDomainPlugins(inner)
      if (config.mountExtraTools) {
        await config.mountExtraTools(inner)
      }
    })
    .await()

  const cliEntryPath = fileURLToPath(new URL('./cli.js', import.meta.url))
  const nodeExecutable =
    config.nodeExecutable ?? process.env.MYDSH_NODE_EXECUTABLE ?? process.execPath
  const workspace: CliWorkspaceHandle = await createCliWorkspace({
    nodeExecutable,
    cliEntryPath,
  })

  const leases = new CliLeaseStore()
  const server = createServer()
  const sockets = attachSocketHandler(server, (request, connectionSignal) =>
    dispatchCliRequest({
      ctx,
      registry,
      leases,
      capturesDir: workspace.capturesDir,
      request,
      connectionSignal,
    }),
  )

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(workspace.ipcEndpoint, () => {
        server.off('error', rejectListen)
        resolveListen()
      })
    })
    hardenWindowsNamedPipe(workspace.ipcEndpoint)
  } catch (error) {
    server.close()
    await workspace.dispose()
    throw error
  }

  const disposeShellEnv = ctx.shellEnv.register({
    name: 'mydsh-cli-bridge',
    variables: {
      [IPC_KEY]: { description: 'MyDSH 本地二级 CLI 桥接端点（内部使用）' },
      [LEASE_KEY]: { description: '当前会话一次性二级 CLI 授权租约（内部使用）' },
      [CLI_BIN_KEY]: { description: 'MyDSH 受控二级命令行可执行文件路径（亦已加入 PATH）' },
    },
    resolve: execution => ({
      [IPC_KEY]: workspace.ipcEndpoint,
      [LEASE_KEY]: leases.issue(execution.agent),
      [CLI_BIN_KEY]: workspace.cliBinaryPath,
    }),
  })

  ctx.mydshCliBridge = {
    endpoint: workspace.ipcEndpoint,
    cliBinaryPath: workspace.cliBinaryPath,
    listHiddenSchemas: () => registry.schemas(),
    issueTestLease: agent => leases.issue(agent),
  }

  ctx.effect(() => async () => {
    disposeShellEnv()
    leases.clear()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolveClose => {
      server.close(() => resolveClose())
    })
    await workspace.dispose()
  })
}
