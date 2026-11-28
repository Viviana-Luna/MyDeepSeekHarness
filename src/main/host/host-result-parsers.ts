/**
 * 主进程对运行核心 Remote RPC 返回值的归一化校验与业务错误翻译。
 *
 * 将底层 envelope、插件投影预算、模型目录和消息反馈结果收敛为可信桌面契约，
 * 并将结构化错误码翻译为用户可操作的中文提示。
 */

import { isAbsolute } from 'node:path'
import { parseDesktopFileReferenceCandidates } from '../../shared/file-references.js'
import { detectDesktopImageMediaType } from '../../shared/image-attachments.js'
import {
  parseDesktopMessageFeedbackItem,
  parseDesktopMessageFeedbackList,
  type DesktopMessageFeedbackList,
  type DesktopMessageFeedbackMutationResult,
} from '../../shared/message-feedback.js'
import {
  parseDesktopGoal,
  parseDesktopGoalRef,
  parseDesktopSubagentCatalog,
  parseDesktopSubagentInterruptReceipt,
  parseDesktopSubagentPromptReceipt,
} from '../../shared/plugin-capabilities.js'
import {
  isDedicatedProjection,
  PluginProjectionCache,
  parsePluginProjectionChange,
} from '../../shared/plugin-projections.js'
import {
  parseDesktopCommandExecutionResult,
  parseDesktopCommandList,
  parseDesktopSessionForkResult,
  parseDesktopSessionRenameResult,
  parseDesktopSessionSearchResult,
  parseDesktopSkillList,
} from '../../shared/session-capabilities.js'
import { publicSessionHistory } from '../../shared/session-live.js'
import { isRecord } from '../../shared/validation.ts'
import {
  DESKTOP_WORKSPACE_PATH_MAX_LENGTH,
  parseDesktopWorkspaceArchiveSnapshot,
  parseDesktopWorkspaceChangeResult,
  parseDesktopWorkspaceCreateResult,
  parseDesktopWorkspaceDeleteResult,
  parseDesktopWorkspaceListResult,
  parseDesktopWorkspaceOrderResult,
  parseDesktopWorkspaceSessionCreateResult,
} from '../../shared/workspace-capabilities.js'
import { isPluginOperation, type DshHostOperation } from './host-operations.ts'
import { boundedString, MAX_PROMPT_IMAGE_BYTES } from './host-payload-validators.ts'

const MESSAGE_FEEDBACK_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  'session-not-found': '当前会话不存在，无法使用消息反馈',
  'target-not-found': '这条回复尚未写入 DSH，无法使用消息反馈',
  'note-blank': '消息反馈备注不能为空',
  'note-too-large': '消息反馈备注超过 Host 限制',
})

const ATTACHMENT_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  MODEL_DOES_NOT_SUPPORT_IMAGES: '当前模型不支持图片，请切换支持图片的模型',
  SUBAGENT_IMAGE_UNSUPPORTED: '子智能体会话暂不支持图片',
  TOO_MANY_IMAGES: '图片数量超过 Host 限制，请移除部分图片后重试',
  IMAGES_TOO_LARGE: '图片总大小超过 Host 限制，请移除部分图片后重试',
  UNSUPPORTED_IMAGE_TYPE: '只支持 PNG、JPEG、WebP 或 GIF 图片',
  INVALID_IMAGE_BASE64: '图片数据无效，请重新选择图片',
  INVALID_IMAGE: '图片内容无效，请重新选择图片',
  IMAGE_TYPE_MISMATCH: '图片扩展名与实际格式不一致，请重新选择图片',
  IMAGE_TOO_LARGE: '单张图片超过 Host 限制，请压缩后重试',
  IMAGE_TOO_MANY_PIXELS: '图片分辨率过大，请压缩后重试',
  IMAGE_DIMENSION_TOO_LARGE: '图片宽高超过 Host 限制，请缩小后重试',
})

const PLUGIN_OPERATION_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  GOAL_STALE_REVISION: '目标已在其他位置更新，请刷新后重试',
  GOAL_ALREADY_EXISTS: '当前会话已有未完成目标，请编辑或清除后再创建',
  GOAL_NOT_FOUND: '当前目标已不存在，请刷新后重试',
  GOAL_AGENT_NOT_LIVE: '当前会话尚未激活，暂时不能操作目标',
  GOAL_INVALID_TRANSITION: '当前目标阶段或剩余轮数不允许此操作，请刷新检查',
  GOAL_INVALID_OBJECTIVE: '目标内容不能为空',
  GOAL_INVALID_MAX_ROUNDS: '目标轮数必须是正整数',
  'subagent/parent-unavailable': '父会话尚未激活，暂时不能控制子智能体',
  'subagent/unauthorized': '此子智能体不属于当前父会话，无法操作',
  'subagent/not-resumable': '此子智能体不支持继续发送消息',
  'subagent/delivery-unavailable': '子智能体暂时无法接收消息，请稍后重试',
  'subagent/projections-unavailable': '当前 Host 未加载子智能体状态能力',
  'gateway/not-found': '当前 Host 未提供此插件能力或会话已不存在',
  'gateway/cancelled': '插件操作已取消',
  'gateway/forbidden': 'Host 不允许当前插件操作',
})

function parsePickedWorkspaceDirectory(value: unknown): string | null {
  const path = isRecord(value) ? value.path : value
  if (path === null) return null
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.length > DESKTOP_WORKSPACE_PATH_MAX_LENGTH ||
    !isAbsolute(path) ||
    path.includes('\0')
  ) {
    throw new Error('MyDSH 运行核心 返回了无效的 Workspace 目录')
  }
  return path
}

function invalidMessageFeedbackResult(): never {
  throw new Error('MyDSH 运行核心 返回了无效的消息反馈结果')
}

function messageFeedbackFailure(error: unknown): never {
  if (!isRecord(error) || typeof error.code !== 'string') return invalidMessageFeedbackResult()
  const message = MESSAGE_FEEDBACK_ERROR_MESSAGES[error.code]
  if (message === undefined) return invalidMessageFeedbackResult()
  throw new Error(message)
}

function messageFeedbackConflict(
  error: Record<string, unknown>,
): DesktopMessageFeedbackMutationResult {
  if (!Object.hasOwn(error, 'current')) return invalidMessageFeedbackResult()
  return {
    kind: 'version-conflict',
    current: error.current === null ? null : parseDesktopMessageFeedbackItem(error.current),
  }
}

function parseMessageFeedbackListResult(value: unknown): DesktopMessageFeedbackList {
  if (!isRecord(value)) return invalidMessageFeedbackResult()
  if (value.ok === true) return parseDesktopMessageFeedbackList(value.value)
  if (value.ok === false) return messageFeedbackFailure(value.error)
  return invalidMessageFeedbackResult()
}

function parseMessageFeedbackPutResult(value: unknown): DesktopMessageFeedbackMutationResult {
  if (!isRecord(value)) return invalidMessageFeedbackResult()
  if (value.ok === true) {
    return { kind: 'committed', item: parseDesktopMessageFeedbackItem(value.value) }
  }
  if (value.ok === false && isRecord(value.error)) {
    return value.error.code === 'version-conflict'
      ? messageFeedbackConflict(value.error)
      : messageFeedbackFailure(value.error)
  }
  return invalidMessageFeedbackResult()
}

function parseMessageFeedbackDeleteResult(value: unknown): DesktopMessageFeedbackMutationResult {
  if (!isRecord(value)) return invalidMessageFeedbackResult()
  if (value.ok === true) {
    if (!isRecord(value.value) || value.value.absent !== true) return invalidMessageFeedbackResult()
    return { kind: 'committed', item: null }
  }
  if (value.ok === false && isRecord(value.error)) {
    return value.error.code === 'version-conflict'
      ? messageFeedbackConflict(value.error)
      : messageFeedbackFailure(value.error)
  }
  return invalidMessageFeedbackResult()
}

/** 一次性 RPC 与实时流采用同一投影预算，防止初始列表绕过累计限制。 */
function boundedSessionProjections(value: unknown): unknown {
  const cache = new PluginProjectionCache()
  const bound = (entry: unknown, id: string): unknown => {
    if (!isRecord(entry) || !isRecord(entry.projections)) return entry
    const raw = entry.projections
    const change = parsePluginProjectionChange({ ...raw, kind: 'snapshot' })
    if (change === null) return { ...entry, projections: undefined }
    cache.apply(id, change)
    const snapshot = cache.read(id)
    return {
      ...entry,
      projections: {
        asOfSeq: change.asOfSeq,
        values: {
          ...Object.fromEntries(
            Object.entries(raw.values as Record<string, unknown>).filter(([key]) =>
              isDedicatedProjection(key),
            ),
          ),
          ...snapshot?.values,
        },
        omitted: snapshot?.omitted ?? Object.keys(change.values).length + change.omitted,
      },
    }
  }
  if (isRecord(value) && Array.isArray(value.items)) {
    return {
      ...value,
      items: value.items.map((entry, index) => bound(entry, String(index))),
    }
  }
  return bound(value, 'page')
}

/** 权限预设目录：进程级 Remote 返回的可选列表，逐项校验后再交给 renderer。 */
function parsePermissionCatalog(value: unknown): {
  options: { value: string; name: string; description?: string }[]
} {
  if (
    !isRecord(value) ||
    !Array.isArray(value.options) ||
    value.options.length === 0 ||
    value.options.length > 32
  ) {
    throw new Error('MyDSH 运行核心 返回了无效的权限预设目录')
  }
  const options = value.options.map((option, index) => {
    if (!isRecord(option)) throw new Error(`权限预设第 ${String(index + 1)} 项无效`)
    const optionValue = boundedString(option.value, 'value', 80)
    const name = boundedString(option.name, 'name', 240)
    if (option.description !== undefined && typeof option.description !== 'string') {
      throw new Error(`权限预设 ${optionValue} 的说明无效`)
    }
    const description =
      typeof option.description === 'string' ? option.description.slice(0, 1_000) : undefined
    return { value: optionValue, name, ...(description === undefined ? {} : { description }) }
  })
  return { options }
}

function parseRequiredGoalResult(value: unknown): unknown {
  const goal = parseDesktopGoal(value)
  if (goal === null) throw new Error('DSH 目标操作未返回当前目标')
  return goal
}

/** 各产品动作对应的响应体收窄解析器映射表。 */
export const OPERATION_RESULT_PARSERS: Partial<
  Record<DshHostOperation, (value: unknown) => unknown>
> = {
  listPermissionPresets: parsePermissionCatalog,
  getSessionGoal: parseDesktopGoal,
  createSessionGoal: value => {
    if (!isRecord(value)) throw new Error('DSH 目标创建结果无效')
    return { ref: parseDesktopGoalRef(value.ref) }
  },
  editSessionGoal: parseRequiredGoalResult,
  pauseSessionGoal: parseRequiredGoalResult,
  resumeSessionGoal: parseRequiredGoalResult,
  completeSessionGoal: parseRequiredGoalResult,
  clearSessionGoal: parseDesktopGoalRef,
  listSessionSubagents: parseDesktopSubagentCatalog,
  promptSessionSubagent: parseDesktopSubagentPromptReceipt,
  interruptSessionSubagent: parseDesktopSubagentInterruptReceipt,
  listSessions: boundedSessionProjections,
  loadSessionPage: value => publicSessionHistory(boundedSessionProjections(value)),
  listSessionCommands: parseDesktopCommandList,
  listSessionSkills: parseDesktopSkillList,
  executeSessionCommand: parseDesktopCommandExecutionResult,
  searchSessions: parseDesktopSessionSearchResult,
  listFileReferences: parseDesktopFileReferenceCandidates,
  renameSession: parseDesktopSessionRenameResult,
  forkSession: parseDesktopSessionForkResult,
  listMessageFeedback: parseMessageFeedbackListResult,
  putMessageFeedback: parseMessageFeedbackPutResult,
  deleteMessageFeedback: parseMessageFeedbackDeleteResult,
  archiveSession: parseDesktopWorkspaceArchiveSnapshot,
  unarchiveSession: parseDesktopWorkspaceArchiveSnapshot,
  deleteArchivedSession: parseDesktopWorkspaceArchiveSnapshot,
  listWorkspaces: parseDesktopWorkspaceListResult,
  pickWorkspaceDirectory: parsePickedWorkspaceDirectory,
  createWorkspace: parseDesktopWorkspaceCreateResult,
  renameWorkspace: parseDesktopWorkspaceChangeResult,
  removeWorkspace: parseDesktopWorkspaceDeleteResult,
  reorderWorkspace: parseDesktopWorkspaceOrderResult,
  reorderWorkspaceSession: parseDesktopWorkspaceChangeResult,
  createSessionForWorkspace: parseDesktopWorkspaceSessionCreateResult,
  describeCredentials: value => ({ credentials: value }),
  discoverProviderModels: value => {
    if (!Array.isArray(value)) throw new Error('MyDSH 运行核心 返回了无效的模型发现目录')
    return { models: value }
  },
}

/** 合并可配置模型提供商列表与当前已激活提供商标识。 */
export function parseJoinedModelProviders(
  configurable: unknown,
  active: unknown,
): Record<string, unknown> {
  if (!Array.isArray(configurable) || !Array.isArray(active)) {
    throw new Error('MyDSH 运行核心 返回了无效的模型提供方目录')
  }
  const activeIds = new Set(
    active.map(candidate => {
      if (!isRecord(candidate)) throw new Error('MyDSH 运行核心 返回了无效的模型提供方目录')
      return boundedString(candidate.id, 'provider', 160)
    }),
  )
  const providers = configurable.map(candidate => {
    if (
      !isRecord(candidate) ||
      !Array.isArray(candidate.settingsPath) ||
      candidate.settingsPath.length > 24
    ) {
      throw new Error('MyDSH 运行核心 返回了无效的模型提供方目录')
    }
    const provider = boundedString(candidate.provider, 'provider', 160)
    const displayName = boundedString(candidate.displayName, 'displayName', 240)
    const settingsNs = candidate.settingsNs
    if (typeof settingsNs !== 'string' || settingsNs.length > 160) {
      throw new Error('MyDSH 运行核心 返回了无效的模型提供方目录')
    }
    const providerSettingsPath = candidate.settingsPath.map(segment =>
      boundedString(segment, 'settingsPath', 160),
    )
    return {
      provider,
      displayName,
      settingsNs,
      settingsPath: providerSettingsPath,
      active: activeIds.has(provider),
      ...(typeof candidate.declared === 'boolean' ? { declared: candidate.declared } : {}),
    }
  })
  return { providers }
}

/** 合并 Agent 预设列表与系统打开预设目录能力布尔值。 */
export function parseJoinedAgentPresetRoster(
  roster: unknown,
  hasDocument: unknown,
): Record<string, unknown> {
  if (
    !isRecord(roster) ||
    !Array.isArray(roster.presets) ||
    typeof roster.authorable !== 'boolean' ||
    typeof hasDocument !== 'boolean'
  ) {
    throw new Error('MyDSH 运行核心 返回了无效的 Agent 预设目录')
  }
  return { presets: roster.presets, authorable: roster.authorable, hasDocument }
}

/** 校验会话图片附件二进制头与声明 MIME 一致性，并构造安全 `data:` URL。 */
export function parseSessionAttachmentDataUrl(
  result: unknown,
  expectedAttachmentId: unknown,
): string {
  if (
    !isRecord(result) ||
    !isRecord(result.attachment) ||
    result.attachment.attachmentId !== expectedAttachmentId ||
    typeof result.data !== 'string'
  ) {
    throw new Error('MyDSH 运行核心 返回了无效的会话图片')
  }
  const bytes = Buffer.from(result.data, 'base64')
  const mediaType = detectDesktopImageMediaType(bytes)
  if (
    mediaType === null ||
    bytes.length > MAX_PROMPT_IMAGE_BYTES ||
    result.attachment.mediaType !== mediaType ||
    bytes.toString('base64') !== result.data
  ) {
    throw new Error('MyDSH 运行核心 返回了无效的会话图片内容')
  }
  return `data:${mediaType};base64,${result.data}`
}

function resolveAttachmentErrorMessage(error: Record<string, unknown>): string | null {
  if (error.code !== 'attachment-error' || !isRecord(error.details)) return null
  const reason = error.details.reason
  if (typeof reason !== 'string' || reason === '') return '图片发送失败，请检查附件后重试'
  return ATTACHMENT_ERROR_MESSAGES[reason] ?? `图片发送失败（${reason}），请检查附件后重试`
}

function resolvePluginOperationErrorMessage(code: string | undefined): string {
  if (code === undefined) return 'DSH 未接受插件操作，请刷新后重试'
  return PLUGIN_OPERATION_ERROR_MESSAGES[code] ?? `DSH 插件操作失败（${code}），请检查当前会话状态`
}

/** 校验底层 Remote RPC envelope，解包 `ok: true` 值或翻译业务错误。 */
export function parseRpcResponse(
  value: unknown,
  rpcId: string,
  operation: DshHostOperation,
): unknown {
  if (!isRecord(value) || value.type !== 'server-response' || value.rpcId !== rpcId) {
    throw new Error('MyDSH 运行核心 返回了无效的 RPC envelope')
  }
  const result = value.result
  if (!isRecord(result)) throw new Error('MyDSH 运行核心 返回了无效的 RPC result')
  if (result.ok === true) return result.value
  if (result.ok !== false || !isRecord(result.error)) {
    throw new Error('MyDSH 运行核心 返回了无法识别的业务结果')
  }
  const message =
    typeof result.error.message === 'string' ? result.error.message : 'MyDSH 运行核心 拒绝了请求'
  const code =
    typeof result.error.code === 'string' && /^[A-Za-z0-9._/-]{1,120}$/u.test(result.error.code)
      ? result.error.code
      : undefined
  const attachmentMessage = resolveAttachmentErrorMessage(result.error)
  if (attachmentMessage !== null) throw new Error(attachmentMessage)
  if (isPluginOperation(operation)) {
    throw new Error(resolvePluginOperationErrorMessage(code))
  }
  if (
    operation === 'forkSession' &&
    code === 'workspace-attach-failed' &&
    isRecord(result.error.details) &&
    typeof result.error.details.sessionId === 'string'
  ) {
    return {
      sessionId: result.error.details.sessionId,
      workspaceAttachFailed: true,
    }
  }
  throw new Error(code === undefined ? message : `${code}: ${message}`)
}
