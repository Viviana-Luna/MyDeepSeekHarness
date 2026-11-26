/**
 * SSH 插件的 Agent 工具入口：运行在后台 Runtime，提供连接发现、SFTP 文件读写与受控命令执行。
 * 复用 `mydshSsh` 的独立连接池与 `mydshConnectionAccess` 的会话授权、串行队列与撤销机制。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  connectionPage,
  connectionPageKey,
  renderConnectionOutput,
  runConnectionTool,
} from '@mydsh/connection-access/output'
import {
  assertRemotePathAllowed,
  isSupportedSshPlatform,
  normalizeRemotePosixPath,
  summarizeSshAgentAccess,
  summarizeSshElevation,
} from './agent-policy.ts'
import { classifySshCommand } from './command-classifier.ts'
import { runRemoteExec } from './exec.ts'
import { SshConnections } from './index.ts'
import {
  acquireSshExecLease,
  acquireSshWriteLease,
  type SshElevationStore,
} from './permission-negotiation.ts'
import {
  commitRemoteWrite,
  listRemoteDir,
  prepareRemoteWrite,
  readRemoteFile,
  resolveRemoteRealPath,
} from './sftp.ts'

const PAGE_PARAMETERS = {
  cursor: {
    oneOf: [{ type: 'string' as const }, { type: 'null' as const }],
    description: '上次返回的 next_cursor；首次读取时省略或传 null。',
  },
  limit: {
    type: 'integer' as const,
    description: '本页项目数；连接默认 20（上限 50），目录默认 50（上限 200）。',
  },
} as const

const PAGE_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    items: { type: 'array' as const, items: { type: 'json' as const }, required: true },
    next_cursor: {
      oneOf: [{ type: 'string' as const }, { type: 'null' as const }],
      required: true,
    },
    truncated: { type: 'boolean' as const, required: true },
  },
} as const

const LIST_DIR_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    connection_id: { type: 'string' as const, required: true },
    directory: { type: 'string' as const, required: true },
    items: { type: 'array' as const, items: { type: 'json' as const }, required: true },
    next_cursor: {
      oneOf: [{ type: 'string' as const }, { type: 'null' as const }],
      required: true,
    },
    truncated: { type: 'boolean' as const, required: true },
  },
} as const

const READ_FILE_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    connection_id: { type: 'string' as const, required: true },
    path: { type: 'string' as const, required: true },
    total_lines: { type: 'integer' as const, required: true },
    start_line: { type: 'integer' as const, required: true },
    end_line: { type: 'integer' as const, required: true },
    truncated: { type: 'boolean' as const, required: true },
    byte_size: { type: 'integer' as const, required: true },
    content: { type: 'string' as const, required: true },
  },
} as const

const WRITE_FILE_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    connection_id: { type: 'string' as const, required: true },
    path: { type: 'string' as const, required: true },
    mode: { type: 'string' as const, enum: ['replace', 'overwrite'], required: true },
    created: { type: 'boolean' as const, required: true },
    atomic: { type: 'boolean' as const, required: true },
    bytes: { type: 'integer' as const, required: true },
    added_lines: { type: 'integer' as const, required: true },
    removed_lines: { type: 'integer' as const, required: true },
    authorization: { type: 'string' as const, required: true },
  },
} as const

const EXEC_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    connection_id: { type: 'string' as const, required: true },
    cwd: { oneOf: [{ type: 'string' as const }, { type: 'null' as const }], required: true },
    category: {
      type: 'string' as const,
      enum: ['readonly', 'mutation', 'high-risk'],
      required: true,
    },
    authorization: { type: 'string' as const, required: true },
    exit_code: { oneOf: [{ type: 'integer' as const }, { type: 'null' as const }], required: true },
    signal: { oneOf: [{ type: 'string' as const }, { type: 'null' as const }], required: true },
    timed_out: { type: 'boolean' as const, required: true },
    duration_ms: { type: 'integer' as const, required: true },
    stdout: { type: 'string' as const, required: true },
    stderr: { type: 'string' as const, required: true },
    stdout_truncated: { type: 'boolean' as const, required: true },
    stderr_truncated: { type: 'boolean' as const, required: true },
  },
} as const

function checkFields(args: object, fields: readonly string[]): void {
  if (Object.keys(args).some(field => !fields.includes(field)))
    throw new Error('SSH 工具包含未知参数')
}

function elevationStoreFor(ctx: Context): SshElevationStore {
  return {
    getElevation: (agent, target) => SshConnections.agentElevation(ctx.mydshSsh, agent, target),
    grantElevation: (agent, target, elevation) =>
      SshConnections.grantAgentElevation(ctx.mydshSsh, agent, target, elevation),
  }
}

function registerList(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'ssh_connections_list',
      description:
        '列出已在「SSH」模式开启模型访问、凭据完整且已确认主机指纹的远程服务器摘要与权限策略，不返回任何密码、私钥或口令。',
      parameters: PAGE_PARAMETERS,
      output: { schema: PAGE_SCHEMA, render: (_args, value) => renderConnectionOutput(value) },
      execute(args, exec) {
        return runConnectionTool(async () => {
          checkFields(args, ['cursor', 'limit'])
          ctx.mydshConnectionAccess.assertMainAgent(exec.agent)
          const targets = await SshConnections.agentCatalog(ctx.mydshSsh)
          exec.signal.throwIfAborted()
          const items = targets.map(target => ({
            connection_id: target.profile.id,
            name: target.profile.name,
            host: target.profile.host,
            port: target.profile.port,
            username: target.profile.username,
            environment: target.profile.environment,
            capabilities: ['list_dir', 'read_file', 'write_file', 'exec'],
            agent_access: summarizeSshAgentAccess(target.profile.agentAccess),
            session_operation_consented: ctx.mydshConnectionAccess.hasSessionConsent(
              exec.agent,
              target.connection,
              [],
            ),
            session_elevation: summarizeSshElevation(
              SshConnections.agentElevation(ctx.mydshSsh, exec.agent, target),
            ),
          }))
          const key = connectionPageKey(
            targets.map(item => `${item.connection.id}:${item.connection.revision}`),
          )
          return connectionPage(items, args, { key, defaultLimit: 20, maxLimit: 50 })
        })
      },
    }),
  )
}

function registerListDir(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'ssh_list_dir',
      description:
        '通过 SFTP 列出远端服务器目录内容（名称、类型、大小、权限和修改时间）。省略 path 时列出允许路径首项或远端用户主目录。',
      parameters: {
        connection_id: {
          type: 'string',
          required: true,
          description: 'ssh_connections_list 返回的连接标识。',
        },
        path: {
          type: 'string',
          description: '远端 POSIX 绝对路径（例如 /srv/app）；省略时读取默认允许目录或用户主目录。',
        },
        ...PAGE_PARAMETERS,
      },
      output: { schema: LIST_DIR_SCHEMA, render: (_args, value) => renderConnectionOutput(value) },
      execute(args, exec) {
        return runConnectionTool(async () => {
          checkFields(args, ['connection_id', 'path', 'cursor', 'limit'])
          ctx.mydshConnectionAccess.assertMainAgent(exec.agent)
          const target = await SshConnections.resolveAgentConnection(
            ctx.mydshSsh,
            args.connection_id,
          )
          const page = await SshConnections.runForAgent(
            ctx.mydshSsh,
            target,
            { signal: exec.signal, needsSftp: true },
            async ({ sftp }) =>
              listRemoteDir(sftp!, {
                connectionId: target.profile.id,
                revision: target.connection.revision,
                ...(args.path !== undefined ? { path: args.path } : {}),
                allowedPaths: target.profile.agentAccess.allowedPaths,
                ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
                ...(args.limit !== undefined ? { limit: args.limit } : {}),
              }),
          )
          return { connection_id: target.profile.id, ...page }
        })
      },
    }),
  )
}

function registerReadFile(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'ssh_read_file',
      description:
        '通过 SFTP 按行范围读取远端文本文件（默认第 1 行起最多 200 行，自动拦截二进制和超过 2 MiB 的大文件）。',
      parameters: {
        connection_id: {
          type: 'string',
          required: true,
          description: 'ssh_connections_list 返回的连接标识。',
        },
        path: {
          type: 'string',
          required: true,
          description: '远端文本文件的 POSIX 绝对路径。',
        },
        offset_line: {
          type: 'integer',
          description: '起始行号（从 1 开始，默认 1）。',
        },
        limit_lines: {
          type: 'integer',
          description: '最多读取行数（1 至 1000，默认 200）。',
        },
      },
      output: { schema: READ_FILE_SCHEMA, render: (_args, value) => renderConnectionOutput(value) },
      execute(args, exec) {
        return runConnectionTool(async () => {
          checkFields(args, ['connection_id', 'path', 'offset_line', 'limit_lines'])
          ctx.mydshConnectionAccess.assertMainAgent(exec.agent)
          const target = await SshConnections.resolveAgentConnection(
            ctx.mydshSsh,
            args.connection_id,
          )
          const result = await SshConnections.runForAgent(
            ctx.mydshSsh,
            target,
            { signal: exec.signal, needsSftp: true },
            async ({ sftp }) =>
              readRemoteFile(sftp!, {
                path: args.path,
                allowedPaths: target.profile.agentAccess.allowedPaths,
                ...(args.offset_line !== undefined ? { offsetLine: args.offset_line } : {}),
                ...(args.limit_lines !== undefined ? { limitLines: args.limit_lines } : {}),
              }),
          )
          return { connection_id: target.profile.id, ...result }
        })
      },
    }),
  )
}

interface WriteFileArgs {
  connection_id: string
  path: string
  mode: 'replace' | 'overwrite'
  old_text?: string
  new_text?: string
  content?: string
}

async function executeWriteFile(ctx: Context, args: WriteFileArgs, exec: ToolRunContext) {
  checkFields(args, ['connection_id', 'path', 'mode', 'old_text', 'new_text', 'content'])
  const agent = ctx.mydshConnectionAccess.assertMainAgent(exec.agent)
  if (args.mode !== 'replace' && args.mode !== 'overwrite')
    throw new Error('mode 必须是 replace 或 overwrite')
  const target = await SshConnections.resolveAgentConnection(ctx.mydshSsh, args.connection_id)
  return ctx.mydshConnectionAccess.serializeForConnection(
    agent.id,
    target.profile.id,
    async () => {
      const prepared = await SshConnections.runForAgent(
        ctx.mydshSsh,
        target,
        { signal: exec.signal, needsSftp: true },
        async ({ sftp }) =>
          prepareRemoteWrite(sftp!, {
            path: args.path,
            allowedPaths: target.profile.agentAccess.allowedPaths,
            mode: args.mode,
            ...(args.old_text !== undefined ? { oldText: args.old_text } : {}),
            ...(args.new_text !== undefined ? { newText: args.new_text } : {}),
            ...(args.content !== undefined ? { content: args.content } : {}),
          }),
      )
      const approved = await acquireSshWriteLease(ctx, exec, elevationStoreFor(ctx), {
        target,
        prepared,
        mode: args.mode,
      })
      try {
        const committed = await SshConnections.runForAgent(
          ctx.mydshSsh,
          target,
          { signal: exec.signal, lease: approved.lease, needsSftp: true },
          async ({ sftp }) => commitRemoteWrite(sftp!, prepared),
        )
        return {
          connection_id: target.profile.id,
          path: committed.path,
          mode: args.mode,
          created: committed.created,
          atomic: committed.atomic,
          bytes: committed.bytes,
          added_lines: prepared.addedLines,
          removed_lines: prepared.removedLines,
          authorization: approved.authorization,
        }
      } finally {
        ctx.mydshConnectionAccess.releaseLease(approved.lease)
      }
    },
    exec.signal,
  )
}

function registerWriteFile(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'ssh_write_file',
      description:
        '通过 SFTP 修改或新建远端文本文件（优先使用 replace 精确替换 old_text -> new_text，也支持 overwrite 整文件写入）。落盘前向用户展示 Unified Diff 确认并复核远端文件是否被并发修改。',
      parameters: {
        connection_id: {
          type: 'string',
          required: true,
          description: 'ssh_connections_list 返回的连接标识。',
        },
        path: {
          type: 'string',
          required: true,
          description: '远端文本文件的 POSIX 绝对路径。',
        },
        mode: {
          type: 'string',
          enum: ['replace', 'overwrite'],
          required: true,
          description: 'replace 执行唯一局部替换，overwrite 执行整文件新建或覆写。',
        },
        old_text: {
          type: 'string',
          description: 'replace 模式下待替换的精确原文片段（在文件中必须唯一出现）。',
        },
        new_text: {
          type: 'string',
          description: 'replace 模式下替换后的新文本（可为空字符串表示删除该片段）。',
        },
        content: {
          type: 'string',
          description: 'overwrite 模式下的完整文件文本内容（上限 1 MiB）。',
        },
      },
      output: {
        schema: WRITE_FILE_SCHEMA,
        render: (_args, value) => renderConnectionOutput(value),
      },
      execute(args, exec) {
        return runConnectionTool(() => executeWriteFile(ctx, args as WriteFileArgs, exec))
      },
    }),
  )
}

interface ExecArgs {
  connection_id: string
  command: string
  cwd?: string
  timeout_ms?: number
}

async function resolveExecCwd(
  ctx: Context,
  target: Awaited<ReturnType<typeof SshConnections.resolveAgentConnection>>,
  rawCwd: string | undefined,
  signal: AbortSignal,
): Promise<string | undefined> {
  const allowedPaths = target.profile.agentAccess.allowedPaths
  const requested = rawCwd ?? allowedPaths[0]
  if (requested === undefined) return undefined
  const normalized = normalizeRemotePosixPath(requested, '工作目录 cwd')
  if (allowedPaths.length === 0) return normalized
  // 当连接配置了目录白名单时，先通过远端 realpath 校验 cwd，防止软链绕过目录边界。
  const resolved = await SshConnections.runForAgent(
    ctx.mydshSsh,
    target,
    { signal, needsSftp: true },
    async ({ sftp }) => resolveRemoteRealPath(sftp!, normalized),
  )
  assertRemotePathAllowed(resolved, allowedPaths, '工作目录 cwd')
  return resolved
}

async function executeSshCommand(ctx: Context, args: ExecArgs, exec: ToolRunContext) {
  checkFields(args, ['connection_id', 'command', 'cwd', 'timeout_ms'])
  const agent = ctx.mydshConnectionAccess.assertMainAgent(exec.agent)
  const classified = classifySshCommand(args.command)
  if (classified.category === 'forbidden')
    throw new Error(`PERMISSION_DENIED：${classified.forbiddenReason}`)
  const target = await SshConnections.resolveAgentConnection(ctx.mydshSsh, args.connection_id)
  return ctx.mydshConnectionAccess.serializeForConnection(
    agent.id,
    target.profile.id,
    async () => {
      const cwd = await resolveExecCwd(ctx, target, args.cwd, exec.signal)
      if (classified.category === 'readonly') {
        const result = await SshConnections.runForAgent(
          ctx.mydshSsh,
          target,
          { signal: exec.signal },
          ({ client, safeMessage, signal }) =>
            runRemoteExec(client, safeMessage, {
              command: args.command,
              ...(cwd ? { cwd } : {}),
              ...(args.timeout_ms !== undefined ? { timeoutMs: args.timeout_ms } : {}),
              signal,
            }),
        )
        return {
          connection_id: target.profile.id,
          cwd: cwd ?? null,
          category: 'readonly' as const,
          authorization: 'readonly-allowed',
          ...result,
        }
      }
      const approved = await acquireSshExecLease(ctx, exec, elevationStoreFor(ctx), {
        target,
        command: args.command,
        ...(cwd ? { cwd } : {}),
        classified,
      })
      try {
        const result = await SshConnections.runForAgent(
          ctx.mydshSsh,
          target,
          { signal: exec.signal, lease: approved.lease },
          ({ client, safeMessage, signal }) =>
            runRemoteExec(client, safeMessage, {
              command: args.command,
              ...(cwd ? { cwd } : {}),
              ...(args.timeout_ms !== undefined ? { timeoutMs: args.timeout_ms } : {}),
              signal,
            }),
        )
        const category: 'mutation' | 'high-risk' =
          classified.category === 'high-risk' ? 'high-risk' : 'mutation'
        return {
          connection_id: target.profile.id,
          cwd: cwd ?? null,
          category,
          authorization: approved.authorization,
          ...result,
        }
      } finally {
        ctx.mydshConnectionAccess.releaseLease(approved.lease)
      }
    },
    exec.signal,
  )
}

function registerExec(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'ssh_exec',
      description:
        '通过非交互式 SSH exec 通道在远端主机执行命令，返回退出码、耗时及脱敏裁剪后的 stdout/stderr。纯只读白名单命令直接执行；其余变更命令会弹确认卡；sudo 与删除/服务启停等高危命令每次强制单次确认；毁灭性系统破坏命令直接拒绝。',
      parameters: {
        connection_id: {
          type: 'string',
          required: true,
          description: 'ssh_connections_list 返回的连接标识。',
        },
        command: {
          type: 'string',
          required: true,
          description:
            '待执行的 POSIX Shell 命令（上限 16 KiB，不要用于修改文件内容，改文件请优先使用 ssh_write_file）。',
        },
        cwd: {
          type: 'string',
          description: '可选远端工作目录（POSIX 绝对路径）；省略时使用允许路径首项或登录主目录。',
        },
        timeout_ms: {
          type: 'integer',
          description: '超时毫秒数（1000 至 120000，默认 30000）。',
        },
      },
      output: { schema: EXEC_SCHEMA, render: (_args, value) => renderConnectionOutput(value) },
      execute(args, exec) {
        return runConnectionTool(() => executeSshCommand(ctx, args as ExecArgs, exec))
      },
    }),
  )
}

/** 依赖由宿主共享：非只读命令与 SFTP 写入通过 userQuestions 显式向用户请求授权。 */
export const inject = ['tools', 'mydshSsh', 'mydshConnectionAccess', 'userQuestions']

/** 工具目录按预设稳定暴露；实际可发现与可执行范围由「SSH」模式配置及实时授权决定。 */
export function apply(ctx: Context): void {
  if (!isSupportedSshPlatform()) return
  registerList(ctx)
  registerListDir(ctx)
  registerReadFile(ctx)
  registerWriteFile(ctx)
  registerExec(ctx)
}
