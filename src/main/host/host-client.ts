import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { detectDesktopImageMediaType } from '../../shared/image-attachments.js'

import type { DesktopInteractionReceipt } from '../../shared/session-live.js'
import { publicSessionHistory } from '../../shared/session-live.js'
import {
  isDedicatedProjection,
  PluginProjectionCache,
  parsePluginProjectionChange,
} from '../../shared/plugin-projections.js'
import {
  parseDesktopGoal,
  parseDesktopGoalRef,
  parseDesktopSubagentCatalog,
  parseDesktopSubagentPromptReceipt,
  parseDesktopSubagentInterruptReceipt,
} from '../../shared/plugin-capabilities.js'
import { parseDesktopFileReferenceCandidates } from '../../shared/file-references.js'
import {
  parseDesktopMessageFeedbackItem,
  parseDesktopMessageFeedbackList,
  type DesktopMessageFeedbackList,
  type DesktopMessageFeedbackMutationResult,
} from '../../shared/message-feedback.js'

import {
  parseDesktopCommandExecutionResult,
  parseDesktopCommandList,
  parseDesktopSessionForkResult,
  parseDesktopSessionRenameResult,
  parseDesktopSessionSearchResult,
  parseDesktopSkillList,
  parseDesktopSlashCommandLine,
} from '../../shared/session-capabilities.js'
import {
  DESKTOP_WORKSPACE_ID_MAX_LENGTH,
  DESKTOP_WORKSPACE_PATH_MAX_LENGTH,
  parseDesktopWorkspaceArchiveSnapshot,
  parseDesktopWorkspaceChangeResult,
  parseDesktopWorkspaceCreateResult,
  parseDesktopWorkspaceDeleteResult,
  parseDesktopWorkspaceListResult,
  parseDesktopWorkspaceOrderResult,
  parseDesktopWorkspaceSessionCreateResult,
} from '../../shared/workspace-capabilities.js'
import { isRecord } from '../../shared/validation.ts'

const MAX_RPC_RESPONSE_BYTES = 8 * 1024 * 1024
const DEFAULT_RPC_TIMEOUT_MS = 15_000
const MAX_PROMPT_REQUEST_BYTES = 48 * 1024 * 1024
const MAX_PROMPT_IMAGE_BYTES = 16 * 1024 * 1024
const MAX_PROMPT_IMAGE_COUNT = 16
const MAX_INTERACTION_RESPONSE_BYTES = 512 * 1024
export const SESSION_COMMAND_EXECUTION_TIMEOUT_MS = 10 * 60 * 1_000
export const WORKSPACE_DIRECTORY_PICKER_TIMEOUT_MS = 10 * 60 * 1_000

export const DSH_HOST_OPERATIONS = [
  'describe',
  'listSessions',
  'searchSessions',
  'listFileReferences',
  'createSession',
  'renameSession',
  'forkSession',
  'listMessageFeedback',
  'putMessageFeedback',
  'deleteMessageFeedback',
  'loadSessionPage',
  'getSessionAttachment',
  'getSessionModels',
  'selectSessionModel',
  'selectPermissionPreset',
  'listPermissionPresets',
  'listSessionCommands',
  'listSessionSkills',
  'executeSessionCommand',
  'promptSession',
  'updateSessionQueue',
  'cancelSession',
  'describeSettings',
  'openSettingsDocument',
  'mutateSettings',
  'describeCredentials',
  'setCredential',
  'unsetCredential',
  'listModelProviders',
  'listHostModels',
  'discoverProviderModels',
  'listAgentPresets',
  'selectSessionAgentPreset',
  'readAgentPreset',
  'copyAgentPreset',
  'openAgentPreset',
  'removeAgentPreset',
  'listHostPlugins',
  'archiveSession',
  'unarchiveSession',
  'deleteArchivedSession',
  'listWorkspaces',
  'pickWorkspaceDirectory',
  'createWorkspace',
  'renameWorkspace',
  'removeWorkspace',
  'reorderWorkspace',
  'reorderWorkspaceSession',
  'createSessionForWorkspace',
  'getSessionGoal',
  'createSessionGoal',
  'editSessionGoal',
  'pauseSessionGoal',
  'resumeSessionGoal',
  'completeSessionGoal',
  'clearSessionGoal',
  'listSessionSubagents',
  'promptSessionSubagent',
  'interruptSessionSubagent',
] as const

export type DshHostOperation = (typeof DSH_HOST_OPERATIONS)[number]

interface RpcCandidate {
  endpoint: string
  payload: (value: Record<string, unknown>) => Record<string, unknown>
}

const direct = (value: Record<string, unknown>): Record<string, unknown> => value
const requestArgument = (value: Record<string, unknown>): Record<string, unknown> => ({
  args: { request: value },
})

function modernPageArgument(value: Record<string, unknown>): Record<string, unknown> {
  const sessionId = value.sessionId
  if (typeof sessionId !== 'string' || sessionId === '') return requestArgument(value)
  const throughSeq = Number(value.throughSeq)
  return requestArgument({
    address: { kind: 'session', sessionId },
    throughSeq: Number.isSafeInteger(throughSeq) && throughSeq >= 0 ? throughSeq : 0,
    ...(typeof value.beforeSeq === 'number' ? { beforeSeq: value.beforeSeq } : {}),
    ...(typeof value.maxMessages === 'number' ? { maxMessages: value.maxMessages } : {}),
  })
}

function modernPromptArgument(value: Record<string, unknown>): Record<string, unknown> {
  return requestArgument({
    ...value,
    requestId:
      typeof value.requestId === 'string' && value.requestId !== ''
        ? value.requestId
        : randomUUID(),
  })
}

const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function promptSessionArgument(value: Record<string, unknown>): Record<string, unknown> {
  rejectUnexpectedFields(value, ['sessionId', 'mode', 'content', 'clientTimeZone'], '会话消息请求')
  if (value.mode !== 'queue' && value.mode !== 'steer') {
    throw new Error('MyDSH 运行核心 会话消息缺少有效的 mode')
  }
  if (!Array.isArray(value.content) || value.content.length === 0 || value.content.length > 64) {
    throw new Error('MyDSH 运行核心 会话消息必须包含 1 到 64 个内容块')
  }
  let imageCount = 0
  let imageBytes = 0
  const content = value.content.map(candidate => {
    if (!isRecord(candidate)) throw new Error('MyDSH 运行核心 会话消息包含无效内容块')
    if (candidate.type === 'text') {
      rejectUnexpectedFields(candidate, ['type', 'text'], '文本内容块')
      return { type: 'text' as const, text: boundedString(candidate.text, '消息文本', 128 * 1024) }
    }
    if (candidate.type === 'file') {
      rejectUnexpectedFields(candidate, ['type', 'receiptId'], '文件附件')
      return {
        type: 'file' as const,
        receiptId: boundedString(candidate.receiptId, '文件回执', 512),
      }
    }
    if (candidate.type !== 'image') throw new Error('MyDSH 运行核心 会话消息包含不支持的内容块')
    rejectUnexpectedFields(candidate, ['type', 'mediaType', 'data', 'name'], '图片内容块')
    if (typeof candidate.mediaType !== 'string' || !IMAGE_MEDIA_TYPES.has(candidate.mediaType)) {
      throw new Error('MyDSH 运行核心 会话消息图片类型不受支持')
    }
    const data = boundedString(candidate.data, '图片数据', MAX_PROMPT_IMAGE_BYTES * 2)
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(data)) {
      throw new Error('MyDSH 运行核心 会话消息图片不是规范 Base64')
    }
    const bytes = Buffer.from(data, 'base64')
    if (
      bytes.length === 0 ||
      bytes.length > MAX_PROMPT_IMAGE_BYTES ||
      bytes.toString('base64') !== data
    ) {
      throw new Error('MyDSH 运行核心 会话消息图片数据无效或过大')
    }
    imageCount += 1
    imageBytes += bytes.length
    const name =
      candidate.name === undefined ? undefined : boundedString(candidate.name, '图片名称', 240)
    if (
      name?.includes('/') === true ||
      name?.includes('\\') === true ||
      name?.includes('\0') === true
    ) {
      throw new Error('MyDSH 运行核心 会话消息图片名称不能包含路径')
    }
    return {
      type: 'image' as const,
      mediaType: candidate.mediaType,
      data,
      ...(name === undefined ? {} : { name }),
    }
  })
  if (imageCount > MAX_PROMPT_IMAGE_COUNT || imageBytes > MAX_PROMPT_IMAGE_BYTES * 2) {
    throw new Error('MyDSH 运行核心 会话消息图片数量或总大小超过桌面上限')
  }
  const clientTimeZone =
    value.clientTimeZone === undefined
      ? undefined
      : boundedString(value.clientTimeZone, 'clientTimeZone', 160)
  return {
    sessionId: boundedString(value.sessionId, 'sessionId'),
    mode: value.mode,
    content,
    ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
  }
}

function boundedString(value: unknown, field: string, maximum = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new Error(`MyDSH 运行核心 请求缺少有效的 ${field}`)
  }
  return value
}

function rejectUnexpectedFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  subject: string,
): void {
  const unexpected = Object.keys(value).find(field => !allowed.includes(field))
  if (unexpected !== undefined) {
    throw new Error(`MyDSH 运行核心 ${subject}包含未知字段 ${unexpected}`)
  }
}

function emptyArgument(value: Record<string, unknown>): Record<string, unknown> {
  rejectUnexpectedFields(value, [], '请求')
  return { args: {} }
}

function settingsNamespace(value: unknown): string {
  const namespace = boundedString(value, 'ns', 160)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(namespace)) {
    throw new Error('DSH 设置命名空间包含不支持的字符')
  }
  return namespace
}

function settingsPath(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 24) {
    throw new Error('DSH 设置路径无效或过深')
  }
  return value.map(segment => {
    const normalized = boundedString(segment, '设置路径片段', 160)
    if (normalized === '__proto__' || normalized === 'prototype' || normalized === 'constructor') {
      throw new Error('DSH 设置路径包含保留字段')
    }
    return normalized
  })
}

function settingsMutationArgument(value: Record<string, unknown>): Record<string, unknown> {
  rejectUnexpectedFields(value, ['ns', 'ops', 'expectedRevision'], '设置更新')
  if (!Array.isArray(value.ops) || value.ops.length === 0 || value.ops.length > 64) {
    throw new Error('DSH 设置更新必须包含 1 到 64 个路径操作')
  }
  const ops = value.ops.map(candidate => {
    if (!isRecord(candidate) || (candidate.op !== 'set' && candidate.op !== 'unset')) {
      throw new Error('DSH 设置更新包含无效操作')
    }
    rejectUnexpectedFields(
      candidate,
      candidate.op === 'set' ? ['op', 'path', 'value'] : ['op', 'path'],
      '设置路径操作',
    )
    const path = settingsPath(candidate.path)
    if (candidate.op === 'unset') return { op: 'unset' as const, path }
    if (!Object.hasOwn(candidate, 'value') || candidate.value === undefined) {
      throw new Error('DSH 设置 set 操作缺少 value')
    }
    return { op: 'set' as const, path, value: candidate.value }
  })
  const expectedRevision = value.expectedRevision
  if (
    expectedRevision !== undefined &&
    (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0)
  ) {
    throw new Error('DSH 设置 revision 必须是非负安全整数')
  }
  return {
    ns: settingsNamespace(value.ns),
    ops,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  }
}

const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/u

function credentialReference(value: unknown): string {
  const reference = boundedString(value, 'ref', 200)
  if (!CREDENTIAL_REF.test(reference)) throw new Error('DSH 凭据引用必须是环境变量格式的标识符')
  return reference
}

function credentialDescribeArgument(value: Record<string, unknown>): Record<string, unknown> {
  rejectUnexpectedFields(value, ['refs'], '凭据查询')
  if (!Array.isArray(value.refs) || value.refs.length > 64) {
    throw new Error('DSH 凭据查询一次最多包含 64 个引用')
  }
  return { refs: [...new Set(value.refs.map(credentialReference))] }
}

function apiSecret(value: unknown): string {
  const secret = boundedString(value, 'value', 16 * 1024)
  if (!/^[\x21-\x7E]+$/u.test(secret)) throw new Error('DSH API 密钥只能包含可打印 ASCII 字符')
  return secret
}

function credentialSetArgument(value: Record<string, unknown>): Record<string, unknown> {
  rejectUnexpectedFields(value, ['ref', 'value'], '凭据写入')
  const secret = apiSecret(value.value)
  return { ref: credentialReference(value.ref), value: secret }
}

function credentialUnsetArgument(value: Record<string, unknown>): Record<string, unknown> {
  rejectUnexpectedFields(value, ['ref'], '凭据删除')
  return { ref: credentialReference(value.ref) }
}

function discoverModelsArgument(value: Record<string, unknown>): Record<string, unknown> {
  rejectUnexpectedFields(
    value,
    ['settingsNs', 'provider', 'baseURL', 'api', 'apiKey'],
    '模型发现请求',
  )
  const optional = (field: 'provider' | 'baseURL' | 'api' | 'apiKey', maximum: number) => {
    const candidate = value[field]
    if (candidate === undefined) return {}
    return {
      [field]: field === 'apiKey' ? apiSecret(candidate) : boundedString(candidate, field, maximum),
    }
  }
  return {
    settingsNs: settingsNamespace(value.settingsNs),
    ...optional('provider', 160),
    ...optional('baseURL', 2_048),
    ...optional('api', 160),
    ...optional('apiKey', 16 * 1024),
  }
}

function remoteDiscoverModelsArgument(value: Record<string, unknown>): Record<string, unknown> {
  const { settingsNs, ...request } = discoverModelsArgument(value)
  return { args: { settingsNs, request } }
}

const AGENT_PRESET_ID = /^[a-z0-9][a-z0-9-]*$/u

function agentPresetId(value: unknown): string {
  const preset = boundedString(value, 'agentPreset', 160)
  if (!AGENT_PRESET_ID.test(preset)) throw new Error('Agent 预设 ID 只能使用小写字母、数字和连字符')
  return preset
}

function agentPresetArgument(value: Record<string, unknown>): Record<string, unknown> {
  rejectUnexpectedFields(value, ['agentPreset'], 'Agent 预设请求')
  return { agentPreset: agentPresetId(value.agentPreset) }
}

function copyAgentPresetArgument(value: Record<string, unknown>): Record<string, unknown> {
  rejectUnexpectedFields(value, ['from', 'agentPreset', 'name'], 'Agent 预设复制请求')
  const name = value.name
  return {
    from: agentPresetId(value.from),
    agentPreset: agentPresetId(value.agentPreset),
    ...(name === undefined ? {} : { name: boundedString(name, 'name', 160) }),
  }
}

function remoteCopyAgentPresetArgument(value: Record<string, unknown>): Record<string, unknown> {
  const copy = copyAgentPresetArgument(value)
  return {
    args: {
      from: copy.from,
      id: copy.agentPreset,
      ...(copy.name === undefined ? {} : { name: copy.name }),
    },
  }
}

function sessionModelCatalogArgument(value: Record<string, unknown>): Record<string, unknown> {
  boundedString(value.sessionId, 'sessionId')
  return { args: {} }
}

function selectModelArgument(value: Record<string, unknown>): Record<string, unknown> {
  const reasoningEffort = value.reasoningEffort
  return requestArgument({
    sessionId: boundedString(value.sessionId, 'sessionId'),
    provider: boundedString(value.provider, 'provider', 160),
    model: boundedString(value.model, 'model', 320),
    ...(reasoningEffort === undefined
      ? {}
      : { reasoningEffort: boundedString(reasoningEffort, 'reasoningEffort', 160) }),
  })
}

function permissionCommandArgument(value: Record<string, unknown>): Record<string, unknown> {
  const preset = boundedString(value.preset, 'preset', 80)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(preset)) {
    throw new Error('DSH 权限预设名称包含不支持的字符')
  }
  return {
    args: {
      agentId: boundedString(value.sessionId, 'sessionId'),
      line: `/permission ${preset}`,
      submittedAttachments: [],
    },
  }
}

function sessionCommandsArgument(value: Record<string, unknown>): Record<string, unknown> {
  rejectUnexpectedFields(value, ['sessionId'], '命令目录请求')
  return { args: { agentId: boundedString(value.sessionId, 'sessionId') } }
}

function sessionSkillsArgument(value: Record<string, unknown>): Record<string, unknown> {
  rejectUnexpectedFields(value, ['sessionId'], 'Skill 目录请求')
  return requestArgument({ sessionId: boundedString(value.sessionId, 'sessionId') })
}

function executeSessionCommandArgument(value: Record<string, unknown>): Record<string, unknown> {
  rejectUnexpectedFields(value, ['sessionId', 'line'], '命令执行请求')
  const line = parseDesktopSlashCommandLine(value.line)
  if (line === null)
    throw new Error('MyDSH 运行核心 命令行必须是有效且不超过 128 KiB 的 slash command')
  return {
    args: {
      agentId: boundedString(value.sessionId, 'sessionId'),
      line,
      submittedAttachments: [],
    },
  }
}

function archiveSessionArgument(value: Record<string, unknown>): Record<string, unknown> {
  rejectUnexpectedFields(value, ['sessionId'], '会话归档请求')
  return { sessionId: boundedString(value.sessionId, 'sessionId') }
}

function renameSessionArgument(value: Record<string, unknown>): Record<string, unknown> {
  rejectUnexpectedFields(value, ['sessionId', 'title'], '会话重命名请求')
  return {
    sessionId: boundedString(value.sessionId, 'sessionId'),
    title: boundedString(value.title, 'title', 16 * 1024),
  }
}

function searchSessionsArgument(value: Record<string, unknown>): Record<string, unknown> {
  rejectUnexpectedFields(value, ['query'], '会话搜索请求')
  const query = boundedString(value.query, 'query', 500)
  if (query.includes('\0') || query.trim() === '')
    throw new Error('MyDSH 运行核心 会话搜索词不能为空')
  return { query }
}

function fileReferencesArgument(value: Record<string, unknown>): Record<string, unknown> {
  rejectUnexpectedFields(value, ['sessionId', 'query'], '文件引用目录请求')
  if (typeof value.query !== 'string' || value.query.length > 4_096 || value.query.includes('\0')) {
    throw new Error('MyDSH 运行核心 文件引用查询无效')
  }
  return {
    args: {
      agentId: boundedString(value.sessionId, 'sessionId'),
      query: value.query,
    },
  }
}

function forkSessionArgument(value: Record<string, unknown>): Record<string, unknown> {
  rejectUnexpectedFields(value, ['sessionId', 'atSeq'], '会话分叉请求')
  const atSeq = value.atSeq
  if (atSeq !== undefined && (!Number.isSafeInteger(atSeq) || Number(atSeq) < 0)) {
    throw new Error('MyDSH 运行核心 会话分叉序号无效')
  }
  return {
    sessionId: boundedString(value.sessionId, 'sessionId'),
    ...(atSeq === undefined ? {} : { atSeq: Number(atSeq) }),
  }
}

function messageFeedbackListArgument(value: Record<string, unknown>): Record<string, unknown> {
  rejectUnexpectedFields(value, ['sessionId'], '消息反馈读取请求')
  return requestArgument({ sessionId: boundedString(value.sessionId, 'sessionId') })
}

function messageFeedbackPutArgument(value: Record<string, unknown>): Record<string, unknown> {
  rejectUnexpectedFields(
    value,
    ['sessionId', 'messageId', 'rating', 'ifVersion'],
    '消息反馈更新请求',
  )
  if (value.rating !== 'positive' && value.rating !== 'negative') {
    throw new Error('MyDSH 运行核心 消息反馈评分无效')
  }
  const ifVersion = value.ifVersion === null ? null : boundedString(value.ifVersion, 'ifVersion')
  return requestArgument({
    sessionId: boundedString(value.sessionId, 'sessionId'),
    messageId: boundedString(value.messageId, 'messageId'),
    rating: value.rating,
    ifVersion,
  })
}

function messageFeedbackDeleteArgument(value: Record<string, unknown>): Record<string, unknown> {
  rejectUnexpectedFields(value, ['sessionId', 'messageId', 'ifVersion'], '消息反馈删除请求')
  return requestArgument({
    sessionId: boundedString(value.sessionId, 'sessionId'),
    messageId: boundedString(value.messageId, 'messageId'),
    ifVersion: boundedString(value.ifVersion, 'ifVersion'),
  })
}

function workspaceIdentifier(value: unknown, field: string): string {
  const identifier = boundedString(value, field, DESKTOP_WORKSPACE_ID_MAX_LENGTH)
  if (identifier.includes('\0')) throw new Error(`MyDSH 运行核心 请求包含无效的 ${field}`)
  return identifier
}

function createWorkspaceArgument(value: Record<string, unknown>): Record<string, unknown> {
  rejectUnexpectedFields(value, ['path'], 'Workspace 创建请求')
  const path = boundedString(value.path, 'path', DESKTOP_WORKSPACE_PATH_MAX_LENGTH)
  // 绝对路径判定按平台进行：Windows 的项目目录是 C:\… 形式，不能只认前导斜杠。
  if (!isAbsolute(path) || path.includes('\0')) {
    throw new Error('MyDSH 运行核心 Workspace 创建请求必须包含绝对目录路径')
  }
  return { path }
}

function renameWorkspaceArgument(value: Record<string, unknown>): Record<string, unknown> {
  rejectUnexpectedFields(value, ['workspaceId', 'title'], 'Workspace 重命名请求')
  const title = boundedString(value.title, 'title', 1_024).trim()
  if (title === '') throw new Error('MyDSH 运行核心 Workspace 标题不能为空')
  return {
    workspaceId: workspaceIdentifier(value.workspaceId, 'workspaceId'),
    title,
  }
}

function workspaceArgument(value: Record<string, unknown>): Record<string, unknown> {
  rejectUnexpectedFields(value, ['workspaceId'], 'Workspace 请求')
  return { workspaceId: workspaceIdentifier(value.workspaceId, 'workspaceId') }
}

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

function reorderWorkspaceArgument(value: Record<string, unknown>): Record<string, unknown> {
  rejectUnexpectedFields(value, ['workspaceId', 'beforeWorkspaceId'], 'Workspace 排序请求')
  const beforeWorkspaceId =
    value.beforeWorkspaceId === undefined
      ? undefined
      : workspaceIdentifier(value.beforeWorkspaceId, 'beforeWorkspaceId')
  return {
    workspaceId: workspaceIdentifier(value.workspaceId, 'workspaceId'),
    ...(beforeWorkspaceId === undefined ? {} : { beforeWorkspaceId }),
  }
}

function createSessionForWorkspaceArgument(
  value: Record<string, unknown>,
): Record<string, unknown> {
  rejectUnexpectedFields(value, ['workspaceId', 'agentPreset'], 'Workspace 会话创建请求')
  return {
    workspaceId: workspaceIdentifier(value.workspaceId, 'workspaceId'),
    ...(value.agentPreset === undefined
      ? {}
      : { agentPreset: boundedString(value.agentPreset, 'agentPreset') }),
  }
}

function reorderWorkspaceSessionArgument(value: Record<string, unknown>): Record<string, unknown> {
  rejectUnexpectedFields(
    value,
    ['workspaceId', 'sessionId', 'beforeSessionId'],
    'Workspace 会话排序请求',
  )
  const beforeSessionId =
    value.beforeSessionId === undefined
      ? undefined
      : boundedString(value.beforeSessionId, 'beforeSessionId')
  return {
    workspaceId: workspaceIdentifier(value.workspaceId, 'workspaceId'),
    sessionId: boundedString(value.sessionId, 'sessionId'),
    ...(beforeSessionId === undefined ? {} : { beforeSessionId }),
  }
}

function pluginSessionId(value: unknown): string {
  const id = boundedString(value, '会话标识')
  if ([...id].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
    throw new Error('会话标识包含控制字符')
  return id
}

function goalArgument(
  value: Record<string, unknown>,
  action: 'get' | 'create' | 'edit' | 'transition',
): Record<string, unknown> {
  rejectUnexpectedFields(
    value,
    [
      'sessionId',
      ...(action === 'get' || action === 'create' ? [] : ['ref']),
      ...(action === 'create' || action === 'edit' ? ['objective', 'maxGoalRounds'] : []),
    ],
    '目标操作',
  )
  const args: Record<string, unknown> = { agentId: pluginSessionId(value.sessionId) }
  if (action !== 'get' && action !== 'create') {
    if (!isRecord(value.ref)) throw new Error('目标操作缺少 revision')
    rejectUnexpectedFields(value.ref, ['id', 'revision'], '目标版本')
    args.ref = { ...parseDesktopGoalRef(value.ref), id: pluginSessionId(value.ref.id) }
  }
  if (action === 'create' || action === 'edit') {
    if (action === 'create' || value.objective !== undefined) {
      const objective = boundedString(value.objective, '目标内容', 16 * 1024)
      if (objective.trim() === '' || objective.includes('\0'))
        throw new Error('目标内容不能为空或包含 NUL')
    }
    if (
      value.maxGoalRounds !== undefined &&
      (!Number.isSafeInteger(value.maxGoalRounds) || (value.maxGoalRounds as number) < 1)
    ) {
      throw new Error('目标轮数必须是正整数')
    }
    if (action === 'edit' && value.objective === undefined && value.maxGoalRounds === undefined)
      throw new Error('目标编辑缺少变更字段')
    args.request = {
      ...(value.objective === undefined ? {} : { objective: value.objective }),
      ...(value.maxGoalRounds === undefined ? {} : { maxGoalRounds: value.maxGoalRounds }),
    }
  }
  return { args }
}

function subagentArgument(
  value: Record<string, unknown>,
  action: 'list' | 'prompt' | 'interrupt',
): Record<string, unknown> {
  rejectUnexpectedFields(
    value,
    [
      'parentSessionId',
      ...(action === 'list' ? [] : ['childSessionId']),
      ...(action === 'prompt' ? ['text', 'delivery', 'requestId'] : []),
    ],
    '子智能体操作',
  )
  const parentSessionId = pluginSessionId(value.parentSessionId)
  if (action === 'list') return { args: { parentSessionId } }
  const childSessionId = pluginSessionId(value.childSessionId)
  if (childSessionId === parentSessionId) throw new Error('子智能体不能与父会话相同')
  const address = { parentSessionId, childSessionId, mode: 'continuable' }
  if (action === 'interrupt') return { args: address }
  if (value.delivery !== 'queue' && value.delivery !== 'steer')
    throw new Error('子智能体消息发送方式无效')
  const text = boundedString(value.text, '子智能体消息', 128 * 1024)
  if (text.trim() === '' || text.includes('\0')) throw new Error('子智能体消息不能为空或包含 NUL')
  const requestId = boundedString(value.requestId, '子智能体消息请求标识', 160)
  if (!/^[A-Za-z0-9_-]+$/u.test(requestId)) throw new Error('子智能体消息请求标识无效')
  return {
    args: {
      request: {
        ...address,
        requestId,
        delivery: value.delivery,
        content: [{ type: 'text', text }],
      },
    },
  }
}

const OPERATION_CANDIDATES: Record<DshHostOperation, readonly RpcCandidate[]> = {
  getSessionGoal: [{ endpoint: 'goals/get', payload: value => goalArgument(value, 'get') }],
  createSessionGoal: [
    { endpoint: 'goals/create', payload: value => goalArgument(value, 'create') },
  ],
  editSessionGoal: [{ endpoint: 'goals/edit', payload: value => goalArgument(value, 'edit') }],
  pauseSessionGoal: [
    { endpoint: 'goals/pause', payload: value => goalArgument(value, 'transition') },
  ],
  resumeSessionGoal: [
    { endpoint: 'goals/resume', payload: value => goalArgument(value, 'transition') },
  ],
  completeSessionGoal: [
    { endpoint: 'goals/complete', payload: value => goalArgument(value, 'transition') },
  ],
  clearSessionGoal: [
    { endpoint: 'goals/clear', payload: value => goalArgument(value, 'transition') },
  ],
  listSessionSubagents: [
    { endpoint: 'subagents/list', payload: value => subagentArgument(value, 'list') },
  ],
  promptSessionSubagent: [
    { endpoint: 'subagents/prompt', payload: value => subagentArgument(value, 'prompt') },
  ],
  interruptSessionSubagent: [
    {
      endpoint: 'subagents/interruptByParent',
      payload: value => subagentArgument(value, 'interrupt'),
    },
  ],
  describe: [{ endpoint: 'host.describe', payload: direct }],
  listSessions: [{ endpoint: 'session/list', payload: () => ({ args: { _request: {} } }) }],
  searchSessions: [
    {
      endpoint: 'session/search',
      payload: value => requestArgument(searchSessionsArgument(value)),
    },
  ],
  listFileReferences: [{ endpoint: 'fileReferences/list', payload: fileReferencesArgument }],
  createSession: [{ endpoint: 'session/create', payload: requestArgument }],
  renameSession: [
    { endpoint: 'session/rename', payload: value => requestArgument(renameSessionArgument(value)) },
  ],
  forkSession: [
    { endpoint: 'session/fork', payload: value => requestArgument(forkSessionArgument(value)) },
  ],
  listMessageFeedback: [{ endpoint: 'messageFeedback/list', payload: messageFeedbackListArgument }],
  putMessageFeedback: [{ endpoint: 'messageFeedback/put', payload: messageFeedbackPutArgument }],
  deleteMessageFeedback: [
    { endpoint: 'messageFeedback/delete', payload: messageFeedbackDeleteArgument },
  ],
  loadSessionPage: [{ endpoint: 'session/page', payload: modernPageArgument }],
  getSessionAttachment: [
    {
      endpoint: 'session/attachment',
      payload: value => {
        rejectUnexpectedFields(value, ['sessionId', 'attachmentId'], '会话图片请求')
        return requestArgument({
          sessionId: boundedString(value.sessionId, 'sessionId', 512),
          attachmentId: boundedString(value.attachmentId, 'attachmentId', 512),
        })
      },
    },
  ],
  getSessionModels: [{ endpoint: 'session/modelCatalog', payload: sessionModelCatalogArgument }],
  selectSessionModel: [{ endpoint: 'session/selectModel', payload: selectModelArgument }],
  selectPermissionPreset: [{ endpoint: 'commands/execute', payload: permissionCommandArgument }],
  listSessionCommands: [{ endpoint: 'commands/list', payload: sessionCommandsArgument }],
  listSessionSkills: [{ endpoint: 'skills/list', payload: sessionSkillsArgument }],
  executeSessionCommand: [{ endpoint: 'commands/execute', payload: executeSessionCommandArgument }],
  promptSession: [
    {
      endpoint: 'session/prompt',
      payload: value => modernPromptArgument(promptSessionArgument(value)),
    },
  ],
  updateSessionQueue: [{ endpoint: 'session/updateQueue', payload: requestArgument }],
  cancelSession: [{ endpoint: 'session/cancel', payload: requestArgument }],
  describeSettings: [{ endpoint: 'settings/describe', payload: emptyArgument }],
  openSettingsDocument: [{ endpoint: 'settings/openSettingsDocument', payload: emptyArgument }],
  mutateSettings: [
    { endpoint: 'settings/mutate', payload: value => ({ args: settingsMutationArgument(value) }) },
  ],
  describeCredentials: [
    {
      endpoint: 'credentials/describe',
      payload: value => ({ args: credentialDescribeArgument(value) }),
    },
  ],
  setCredential: [
    { endpoint: 'credentials/set', payload: value => ({ args: credentialSetArgument(value) }) },
  ],
  unsetCredential: [
    { endpoint: 'credentials/unset', payload: value => ({ args: credentialUnsetArgument(value) }) },
  ],
  listModelProviders: [{ endpoint: 'llm/listConfigurableProviders', payload: emptyArgument }],
  listHostModels: [{ endpoint: 'session/modelCatalog', payload: emptyArgument }],
  discoverProviderModels: [
    { endpoint: 'llm/discoverModels', payload: remoteDiscoverModelsArgument },
  ],
  listAgentPresets: [{ endpoint: 'agentPresets/list', payload: emptyArgument }],
  listPermissionPresets: [{ endpoint: 'permissionPresets/catalog', payload: emptyArgument }],
  selectSessionAgentPreset: [
    {
      endpoint: 'agentPresets/select',
      payload: value => {
        rejectUnexpectedFields(value, ['sessionId', 'agentPreset'], '会话预设选择请求')
        return {
          args: {
            agentId: boundedString(value.sessionId, 'sessionId', 512),
            agentPreset: agentPresetId(value.agentPreset),
          },
        }
      },
    },
  ],
  readAgentPreset: [
    { endpoint: 'agentPresets/read', payload: value => ({ args: agentPresetArgument(value) }) },
  ],
  copyAgentPreset: [{ endpoint: 'agentPresets/copy', payload: remoteCopyAgentPresetArgument }],
  openAgentPreset: [
    {
      endpoint: 'settings/openAgentPresetDirectory',
      payload: value => ({ args: agentPresetArgument(value) }),
    },
  ],
  removeAgentPreset: [
    {
      endpoint: 'agentPresets/deletePreset',
      payload: value => ({ args: { id: agentPresetArgument(value).agentPreset } }),
    },
  ],
  listHostPlugins: [
    {
      endpoint: 'pluginInventory/list',
      payload: value => {
        rejectUnexpectedFields(value, [], '插件目录请求')
        return { args: {} }
      },
    },
  ],
  archiveSession: [
    {
      endpoint: 'mydshSessions/archiveSession',
      payload: value => ({ args: archiveSessionArgument(value) }),
    },
  ],
  unarchiveSession: [
    {
      endpoint: 'workspace/unarchiveSession',
      payload: value => requestArgument(archiveSessionArgument(value)),
    },
  ],
  deleteArchivedSession: [
    {
      endpoint: 'mydshSessions/deleteArchivedSession',
      payload: value => ({ args: archiveSessionArgument(value) }),
    },
  ],
  listWorkspaces: [],
  pickWorkspaceDirectory: [{ endpoint: 'directoryPicker/pick', payload: emptyArgument }],
  createWorkspace: [
    {
      endpoint: 'workspace/create',
      payload: value => requestArgument(createWorkspaceArgument(value)),
    },
  ],
  renameWorkspace: [
    {
      endpoint: 'workspace/rename',
      payload: value => requestArgument(renameWorkspaceArgument(value)),
    },
  ],
  removeWorkspace: [
    { endpoint: 'workspace/delete', payload: value => requestArgument(workspaceArgument(value)) },
  ],
  reorderWorkspace: [
    {
      endpoint: 'workspace/insertBefore',
      payload: value => requestArgument(reorderWorkspaceArgument(value)),
    },
  ],
  reorderWorkspaceSession: [
    {
      endpoint: 'workspace/insertSessionBefore',
      payload: value => requestArgument(reorderWorkspaceSessionArgument(value)),
    },
  ],
  createSessionForWorkspace: [
    {
      endpoint: 'session/create',
      payload: value => requestArgument(createSessionForWorkspaceArgument(value)),
    },
  ],
}

const MESSAGE_FEEDBACK_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  'session-not-found': '当前会话不存在，无法使用消息反馈',
  'target-not-found': '这条回复尚未写入 DSH，无法使用消息反馈',
  'note-blank': '消息反馈备注不能为空',
  'note-too-large': '消息反馈备注超过 Host 限制',
})

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
  if (isRecord(value) && Array.isArray(value.items))
    return {
      ...value,
      items: value.items.map((entry, index) => bound(entry, String(index))),
    }
  return bound(value, 'page')
}

const OPERATION_RESULT_PARSERS: Partial<Record<DshHostOperation, (value: unknown) => unknown>> = {
  listPermissionPresets: permissionCatalog,
  getSessionGoal: parseDesktopGoal,
  createSessionGoal: value => {
    if (!isRecord(value)) throw new Error('DSH 目标创建结果无效')
    return { ref: parseDesktopGoalRef(value.ref) }
  },
  editSessionGoal: requiredGoalResult,
  pauseSessionGoal: requiredGoalResult,
  resumeSessionGoal: requiredGoalResult,
  completeSessionGoal: requiredGoalResult,
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

function requiredGoalResult(value: unknown): unknown {
  const goal = parseDesktopGoal(value)
  if (goal === null) throw new Error('DSH 目标操作未返回当前目标')
  return goal
}

function isPluginOperation(operation: DshHostOperation): boolean {
  return (
    operation.endsWith('SessionGoal') ||
    operation.endsWith('SessionSubagent') ||
    operation === 'listSessionSubagents'
  )
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
  if (Buffer.byteLength(serialized, 'utf8') > maximumBytes)
    throw new Error('MyDSH 运行核心 请求参数超过大小上限')
  return value
}

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

function attachmentErrorMessage(error: Record<string, unknown>): string | null {
  if (error.code !== 'attachment-error' || !isRecord(error.details)) return null
  const reason = error.details.reason
  if (typeof reason !== 'string' || reason === '') return '图片发送失败，请检查附件后重试'
  return ATTACHMENT_ERROR_MESSAGES[reason] ?? `图片发送失败（${reason}），请检查附件后重试`
}

function parseRpcResponse(value: unknown, rpcId: string, operation: DshHostOperation): unknown {
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
  const attachmentMessage = attachmentErrorMessage(result.error)
  if (attachmentMessage !== null) throw new Error(attachmentMessage)
  if (isPluginOperation(operation)) {
    const messages: Readonly<Record<string, string>> = {
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
    }
    throw new Error(
      code === undefined
        ? 'DSH 未接受插件操作，请刷新后重试'
        : (messages[code] ?? `DSH 插件操作失败（${code}），请检查当前会话状态`),
    )
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

async function invokeDshRpc(
  targetUrl: URL,
  endpoint: string,
  payload: Record<string, unknown>,
  operation: DshHostOperation,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  cookie?: string,
  signal?: AbortSignal,
): Promise<unknown> {
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
    signal:
      signal === undefined
        ? AbortSignal.timeout(timeoutMs)
        : AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]),
  }).catch((error: unknown) => {
    if (!isPluginOperation(operation)) throw error
    throw new Error(
      error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
        ? '插件请求已取消或超时；写操作请先刷新状态再重试'
        : '无法访问插件服务，请检查运行核心状态',
    )
  })
  if (response.status === 401) throw new Error('MyDSH 运行核心拒绝未授权请求')
  if (response.status === 403) throw new Error('MyDSH 运行核心 拒绝了当前传输来源')
  if (!response.ok) {
    if (isPluginOperation(operation) && response.status === 404)
      throw new Error('当前运行核心未提供此插件接口')
    throw new Error(`MyDSH 运行核心 传输失败：HTTP ${String(response.status)}`)
  }
  const maximumBytes =
    operation === 'getSessionAttachment' ? MAX_PROMPT_IMAGE_BYTES * 2 : MAX_RPC_RESPONSE_BYTES
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error('MyDSH 运行核心 RPC 响应超过大小上限')
  }
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > maximumBytes) {
    throw new Error('MyDSH 运行核心 RPC 响应超过大小上限')
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('MyDSH 运行核心 RPC 没有返回 JSON')
  }
  return parseRpcResponse(value, rpcId, operation)
}

function joinedModelProviders(configurable: unknown, active: unknown): Record<string, unknown> {
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

/** 权限预设目录：进程级 Remote 返回的可选列表，逐项校验后再交给 renderer。 */
function permissionCatalog(value: unknown): {
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

function joinedAgentPresetRoster(roster: unknown, hasDocument: unknown): Record<string, unknown> {
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

/**
 * 通过固定 loopback Host 执行一项白名单 Remote RPC。
 * renderer 只能选择产品动作，不能控制 URL、channel 或 endpoint。
 */
export async function callDshHost(
  targetUrl: URL,
  operationInput: unknown,
  payloadInput: unknown,
  fetchImpl: typeof fetch = fetch,
  cookie?: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const operation = parseOperation(operationInput)
  const payload = parsePayload(
    payloadInput,
    operation === 'promptSession' ? MAX_PROMPT_REQUEST_BYTES : undefined,
  )
  const candidates = OPERATION_CANDIDATES[operation]
  const timeoutMs =
    operation === 'executeSessionCommand'
      ? SESSION_COMMAND_EXECUTION_TIMEOUT_MS
      : operation === 'pickWorkspaceDirectory'
        ? WORKSPACE_DIRECTORY_PICKER_TIMEOUT_MS
        : DEFAULT_RPC_TIMEOUT_MS
  if (operation === 'listWorkspaces') {
    throw new Error('Workspace 列表必须从公开 workspace/follow 基线读取')
  }
  if (operation === 'listModelProviders') {
    emptyArgument(payload)
    const [configurable, active] = await Promise.all([
      invokeDshRpc(
        targetUrl,
        'llm/listConfigurableProviders',
        { args: {} },
        operation,
        timeoutMs,
        fetchImpl,
        cookie,
        signal,
      ),
      invokeDshRpc(
        targetUrl,
        'llm/listProviders',
        { args: {} },
        operation,
        timeoutMs,
        fetchImpl,
        cookie,
        signal,
      ),
    ])
    return joinedModelProviders(configurable, active)
  }
  if (operation === 'listAgentPresets') {
    emptyArgument(payload)
    const [roster, hasDocument] = await Promise.all([
      invokeDshRpc(
        targetUrl,
        'agentPresets/list',
        { args: {} },
        operation,
        timeoutMs,
        fetchImpl,
        cookie,
        signal,
      ),
      invokeDshRpc(
        targetUrl,
        'settings/canOpenAgentPresetDirectory',
        { args: {} },
        operation,
        timeoutMs,
        fetchImpl,
        cookie,
        signal,
      ),
    ])
    return joinedAgentPresetRoster(roster, hasDocument)
  }
  const candidate = candidates[0]
  if (candidate === undefined) throw new Error('当前 MyDSH 运行核心 不支持所需能力')
  const result = await invokeDshRpc(
    targetUrl,
    candidate.endpoint,
    candidate.payload(payload),
    operation,
    timeoutMs,
    fetchImpl,
    cookie,
    signal,
  )
  const parseResult = OPERATION_RESULT_PARSERS[operation]
  if (operation === 'getSessionAttachment') {
    if (
      !isRecord(result) ||
      !isRecord(result.attachment) ||
      result.attachment.attachmentId !== payload.attachmentId ||
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
  return parseResult === undefined ? result : parseResult(result)
}

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

/**
 * 回答一项由 `$events` 发起的待用户交互。关联值绑定当前事件流 generation，
 * 并且只进入固定的 `$events/result` Remote RPC。
 */
export async function respondDshInteraction(
  targetUrl: URL,
  clientId: string,
  eventId: string,
  outcome: DshRemoteEventOutcome,
  fetchImpl: typeof fetch = fetch,
  cookie?: string,
  signal?: AbortSignal,
): Promise<DesktopInteractionReceipt> {
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
    signal:
      signal === undefined
        ? AbortSignal.timeout(DEFAULT_RPC_TIMEOUT_MS)
        : AbortSignal.any([AbortSignal.timeout(DEFAULT_RPC_TIMEOUT_MS), signal]),
  })
  if (response.status === 401) throw new Error('MyDSH 运行核心拒绝未授权请求')
  if (response.status === 403) throw new Error('MyDSH 运行核心 拒绝了当前传输来源')
  if (!response.ok) throw new Error(`MyDSH 运行核心 交互应答失败：HTTP ${String(response.status)}`)
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_INTERACTION_RESPONSE_BYTES) {
    throw new Error('MyDSH 运行核心 交互应答回执超过大小上限')
  }
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_INTERACTION_RESPONSE_BYTES) {
    throw new Error('MyDSH 运行核心 交互应答回执超过大小上限')
  }
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
