/**
 * SSH Agent 工具权限协商：运行在后台 Runtime，负责构造确认卡（命令/Diff 预览）并向用户申请单次或会话授权。
 * 不直接执行 SSH 操作；与 `mydshConnectionAccess` 共用会话同意、串行队列与租约撤销机制。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import type { ConnectionLease } from '@mydsh/connection-access'
import type { ConnectionIdentity } from '@mydsh/connection-access/types'
import type { SshAgentAccessMode, SshProfile } from '../types.d.ts'
import {
  effectiveAllowSudo,
  effectiveSshMode,
  mergeSshElevations,
  sshModeLabel,
  sshModeRank,
  type SshPermissionElevation,
} from './agent-policy.ts'
import type { ClassifiedSshCommand } from './command-classifier.ts'
import type { PreparedRemoteWrite } from './sftp.ts'

/** 与前端 `SshConsentPanel` 约定的问题标识前缀。 */
export const SSH_CONSENT_ID_PREFIX = 'mydsh-ssh-consent:'

/** 与前端 `SshConsentPanel` 约定的预览载荷标记，避免代码内容与 Markdown 围栏冲突。 */
export const SSH_PREVIEW_MARKER = 'MYDSH_SSH_PREVIEW_V1:'

/** 已解析并通过指纹校验的可执行 SSH Agent 目标。 */
export interface ResolvedAgentSshTarget {
  readonly profile: SshProfile
  readonly connection: ConnectionIdentity
}

/** SSH 操作本次放行来源，返回给工具结果供模型和轨迹审计区分。 */
export type SshOperationAuthorization =
  | 'readonly-allowed'
  | 'approved-once'
  | 'approved-session'
  | 'elevated-once'
  | 'elevated-session'
  | 'session-reused'

/** 提供给确认卡与授权流程的提权状态存取回调。 */
export interface SshElevationStore {
  getElevation(
    agent: ToolRunContext['agent'],
    target: ResolvedAgentSshTarget,
  ): SshPermissionElevation | undefined
  grantElevation(
    agent: NonNullable<ToolRunContext['agent']>,
    target: ResolvedAgentSshTarget,
    elevation: SshPermissionElevation,
  ): void
}

interface PreviewPayload {
  kind: 'command' | 'diff'
  title: string
  content: string
  risks: readonly string[]
}

function encodePreviewPayload(payload: PreviewPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function buildDetailWithPreview(metaLines: readonly string[], payload: PreviewPayload): string {
  const fenceLang = payload.kind === 'diff' ? 'diff' : 'sh'
  const lines = [
    ...metaLines.map(line => `- ${line}`),
    ...(payload.risks.length > 0 ? [`- 风险提示：${payload.risks.join('；')}`] : []),
    '',
    `\`\`\`${fenceLang}`,
    payload.content,
    '```',
    '',
    `${SSH_PREVIEW_MARKER}${encodePreviewPayload(payload)}`,
  ]
  return lines.join('\n')
}

function computeRequiredElevation(input: {
  profile: SshProfile
  existingElevation?: SshPermissionElevation
  requiredMode: SshAgentAccessMode
  usesSudo: boolean
}): SshPermissionElevation | undefined {
  const currentMode = effectiveSshMode(input.profile.agentAccess.mode, input.existingElevation)
  const currentSudo = effectiveAllowSudo(
    input.profile.agentAccess.allowSudo,
    input.existingElevation,
  )
  const needMode = sshModeRank(input.requiredMode) > sshModeRank(currentMode)
  const needSudo = input.usesSudo && !currentSudo
  if (!needMode && !needSudo) return undefined
  return {
    ...(needMode ? { mode: input.requiredMode } : {}),
    ...(needSudo ? { allowSudo: true } : {}),
  }
}

function describeElevation(profile: SshProfile, requested: SshPermissionElevation): string {
  const parts: string[] = []
  if (requested.mode) {
    parts.push(`${sshModeLabel(profile.agentAccess.mode)} → ${sshModeLabel(requested.mode)}`)
  }
  if (requested.allowSudo) parts.push('临时允许本次 sudo')
  return parts.join('，')
}

function parseDecision(
  answer: AskUserQuestionAnswer,
  questionId: string,
  allowOnceLabel: string,
  allowSessionLabel?: string,
): 'once' | 'session' | 'deny' {
  const selected = answer.answers.find(item => item.id === questionId)?.selected ?? []
  if (allowSessionLabel && selected.includes(allowSessionLabel)) return 'session'
  if (selected.includes(allowOnceLabel)) return 'once'
  return 'deny'
}

async function askSshApproval(
  ctx: Context,
  exec: ToolRunContext,
  input: {
    target: ResolvedAgentSshTarget
    header: string
    question: string
    detail: string
    allowOnceLabel: string
    allowSessionLabel?: string
  },
): Promise<'once' | 'session' | 'deny'> {
  const agent = ctx.mydshConnectionAccess.assertMainAgent(exec.agent)
  const questionId = `${SSH_CONSENT_ID_PREFIX}${input.target.profile.id}`
  const options = [
    { label: input.allowOnceLabel, description: '仅授权本次 SSH 操作执行一次。' },
    ...(input.allowSessionLabel
      ? [
          {
            label: input.allowSessionLabel,
            description: '当前会话内对该主机的同类常规操作免重复确认；高危与 sudo 仍会每次确认。',
          },
        ]
      : []),
    { label: '拒绝', description: '拒绝本次请求，不向远端主机发送变更。' },
  ]
  const response: AskUserQuestionAnswer = await ctx.userQuestions.ask({
    questions: [
      {
        id: questionId,
        header: input.header,
        question: input.question,
        detail: input.detail,
        options,
      },
    ],
    agent,
    signal: exec.signal,
  })
  return parseDecision(response, questionId, input.allowOnceLabel, input.allowSessionLabel)
}

async function negotiateLease(
  ctx: Context,
  exec: ToolRunContext,
  store: SshElevationStore,
  input: {
    target: ResolvedAgentSshTarget
    requiredMode: SshAgentAccessMode
    usesSudo: boolean
    requiresPerCallApproval: boolean
    header: string
    question: string
    metaLines: readonly string[]
    preview: PreviewPayload
    allowOnceBaseLabel: string
    allowSessionBaseLabel: string
  },
): Promise<{ lease: ConnectionLease; authorization: SshOperationAuthorization }> {
  const agent = ctx.mydshConnectionAccess.assertMainAgent(exec.agent)
  const existingElevation = store.getElevation(agent, input.target)
  const requestedElevation = computeRequiredElevation({
    profile: input.target.profile,
    ...(existingElevation ? { existingElevation } : {}),
    requiredMode: input.requiredMode,
    usesSudo: input.usesSudo,
  })
  const needsElevation = requestedElevation !== undefined
  const hasConsent = ctx.mydshConnectionAccess.hasSessionConsent(agent, input.target.connection, [])
  if (hasConsent && !needsElevation && !input.requiresPerCallApproval) {
    const lease = ctx.mydshConnectionAccess.acquireLease(agent, {
      name: input.target.profile.name,
      connection: input.target.connection,
      dependencies: [],
      requireSessionConsent: true,
    })
    return { lease, authorization: 'session-reused' }
  }
  const allowOnceLabel = needsElevation ? '提权并允许本次操作' : input.allowOnceBaseLabel
  let allowSessionLabel: string | undefined
  if (!input.requiresPerCallApproval) {
    allowSessionLabel = needsElevation ? '本次会话允许该提权' : input.allowSessionBaseLabel
  }
  const metaLines = [
    ...input.metaLines,
    ...(requestedElevation
      ? [`权限提升：${describeElevation(input.target.profile, requestedElevation)}`]
      : []),
  ]
  const decision = await askSshApproval(ctx, exec, {
    target: input.target,
    header: needsElevation ? 'SSH 权限提权' : input.header,
    question: input.question,
    detail: buildDetailWithPreview(metaLines, input.preview),
    allowOnceLabel,
    ...(allowSessionLabel ? { allowSessionLabel } : {}),
  })
  if (decision === 'deny') throw new Error('USER_REJECTED：用户拒绝了此次 SSH 操作')
  if (decision === 'session' && !input.requiresPerCallApproval) {
    const merged = mergeSshElevations(existingElevation, requestedElevation)
    if (needsElevation && merged) store.grantElevation(agent, input.target, merged)
    ctx.mydshConnectionAccess.grantSessionConsent(agent, {
      name: input.target.profile.name,
      connection: input.target.connection,
      dependencies: [],
    })
    const lease = ctx.mydshConnectionAccess.acquireLease(agent, {
      name: input.target.profile.name,
      connection: input.target.connection,
      dependencies: [],
      requireSessionConsent: true,
    })
    return { lease, authorization: needsElevation ? 'elevated-session' : 'approved-session' }
  }
  const lease = ctx.mydshConnectionAccess.acquireLease(agent, {
    name: input.target.profile.name,
    connection: input.target.connection,
    dependencies: [],
    requireSessionConsent: false,
  })
  return { lease, authorization: needsElevation ? 'elevated-once' : 'approved-once' }
}

/** 为非只读 SSH 命令协商授权并返回进程内执行租约。 */
export function acquireSshExecLease(
  ctx: Context,
  exec: ToolRunContext,
  store: SshElevationStore,
  input: {
    target: ResolvedAgentSshTarget
    command: string
    cwd?: string
    classified: ClassifiedSshCommand
  },
): Promise<{ lease: ConnectionLease; authorization: SshOperationAuthorization }> {
  const { profile } = input.target
  const hostSummary = `${profile.name} (${profile.username}@${profile.host}:${profile.port})`
  return negotiateLease(ctx, exec, store, {
    target: input.target,
    requiredMode: input.classified.requiredMode,
    usesSudo: input.classified.usesSudo,
    requiresPerCallApproval: input.classified.requiresPerCallApproval,
    header: 'SSH 命令执行确认',
    question: `允许在服务器「${profile.name}」执行以下 SSH 命令吗？`,
    metaLines: [
      `服务器：${hostSummary}`,
      ...(input.cwd ? [`工作目录：${input.cwd}`] : []),
      `当前档位：${sshModeLabel(profile.agentAccess.mode)}`,
    ],
    preview: {
      kind: 'command',
      title: '待执行 SSH 命令',
      content: input.command,
      risks: input.classified.risks,
    },
    allowOnceBaseLabel: '允许本次执行',
    allowSessionBaseLabel: '本次会话允许该主机常规操作',
  })
}

/** 为 SFTP 远程文件修改协商授权并返回进程内执行租约。 */
export function acquireSshWriteLease(
  ctx: Context,
  exec: ToolRunContext,
  store: SshElevationStore,
  input: {
    target: ResolvedAgentSshTarget
    prepared: PreparedRemoteWrite
    mode: 'replace' | 'overwrite'
  },
): Promise<{ lease: ConnectionLease; authorization: SshOperationAuthorization }> {
  const { profile } = input.target
  const hostSummary = `${profile.name} (${profile.username}@${profile.host}:${profile.port})`
  let actionLabel = '新建'
  if (input.prepared.existed) {
    actionLabel = input.mode === 'replace' ? '局部修改' : '覆写'
  }
  const requiresPerCallApproval = input.prepared.risks.some(risk => risk.includes('强制单次确认'))
  return negotiateLease(ctx, exec, store, {
    target: input.target,
    requiredMode: 'standard',
    usesSudo: false,
    requiresPerCallApproval,
    header: 'SSH 远程文件修改确认',
    question: `允许在服务器「${profile.name}」${actionLabel}文件 ${input.prepared.resolvedPath} 吗？`,
    metaLines: [
      `服务器：${hostSummary}`,
      `目标文件：${input.prepared.resolvedPath}`,
      `变更统计：+${input.prepared.addedLines} / -${input.prepared.removedLines} 行（写入后 ${input.prepared.nextBytes} 字节）`,
      `当前档位：${sshModeLabel(profile.agentAccess.mode)}`,
    ],
    preview: {
      kind: 'diff',
      title: `远程文件变更预览：${input.prepared.resolvedPath}`,
      content: input.prepared.diff,
      risks: input.prepared.risks,
    },
    allowOnceBaseLabel: '允许本次写入',
    allowSessionBaseLabel: '本次会话允许该主机常规操作',
  })
}
