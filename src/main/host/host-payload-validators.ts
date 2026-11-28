/**
 * 主进程到运行核心 Remote RPC 的请求参数边界校验器。
 *
 * 将来自 renderer IPC 的不可信输入校验并收窄为各公开 endpoint 所需的请求载荷，
 * 拒绝未知字段、越界字符串、原型链污染路径与伪造图片数据。
 */

import { randomUUID } from 'node:crypto'
import { parseDesktopSlashCommandLine } from '../../shared/session-capabilities.js'
import { isRecord } from '../../shared/validation.ts'

export {
  parseCreateSessionForWorkspaceArgument,
  parseCreateWorkspaceArgument,
  parseGoalArgument,
  parsePluginInventoryArgument,
  parseRenameWorkspaceArgument,
  parseReorderWorkspaceArgument,
  parseReorderWorkspaceSessionArgument,
  parseSubagentArgument,
  parseWorkspaceArgument,
} from './host-plugin-validators.ts'

/** 单张会话图片允许的最大原始字节数（16 MiB）。 */
export const MAX_PROMPT_IMAGE_BYTES = 16 * 1024 * 1024

const MAX_PROMPT_IMAGE_COUNT = 16
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/u
const AGENT_PRESET_ID = /^[a-z0-9][a-z0-9-]*$/u
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u

/** 校验非空且不超过最大长度的字符串字段。 */
export function boundedString(value: unknown, field: string, maximum = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new Error(`MyDSH 运行核心 请求缺少有效的 ${field}`)
  }
  return value
}

/** 拒绝不在白名单内的对象属性，防止透传隐藏 RPC 字段。 */
export function rejectUnexpectedFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  subject: string,
): void {
  const unexpected = Object.keys(value).find(field => !allowed.includes(field))
  if (unexpected !== undefined) {
    throw new Error(`MyDSH 运行核心 ${subject}包含未知字段 ${unexpected}`)
  }
}

/** 原样透传已校验的顶层请求对象。 */
export function directPayload(value: Record<string, unknown>): Record<string, unknown> {
  return value
}

/** 包装为新版 Remote RPC `{ args: { request } }` 参数结构。 */
export function wrapRequestArgument(value: Record<string, unknown>): Record<string, unknown> {
  return { args: { request: value } }
}

/** 校验无参请求并生成 `{ args: {} }`。 */
export function parseEmptyArgument(value: Record<string, unknown>): Record<string, unknown> {
  rejectUnexpectedFields(value, [], '请求')
  return { args: {} }
}

/** 构造会话分页历史读取请求载荷。 */
export function parseModernPageArgument(value: Record<string, unknown>): Record<string, unknown> {
  const sessionId = value.sessionId
  if (typeof sessionId !== 'string' || sessionId === '') return wrapRequestArgument(value)
  const throughSeq = Number(value.throughSeq)
  return wrapRequestArgument({
    address: { kind: 'session', sessionId },
    throughSeq: Number.isSafeInteger(throughSeq) && throughSeq >= 0 ? throughSeq : 0,
    ...(typeof value.beforeSeq === 'number' ? { beforeSeq: value.beforeSeq } : {}),
    ...(typeof value.maxMessages === 'number' ? { maxMessages: value.maxMessages } : {}),
  })
}

/** 为会话消息请求补齐幂等 `requestId` 并包装为 `{ args: { request } }`。 */
export function parseModernPromptArgument(value: Record<string, unknown>): Record<string, unknown> {
  return wrapRequestArgument({
    ...value,
    requestId:
      typeof value.requestId === 'string' && value.requestId !== ''
        ? value.requestId
        : randomUUID(),
  })
}

function parsePromptImageBlock(
  candidate: Record<string, unknown>,
  totals: { count: number; bytes: number },
): Record<string, unknown> {
  rejectUnexpectedFields(candidate, ['type', 'mediaType', 'data', 'name'], '图片内容块')
  if (typeof candidate.mediaType !== 'string' || !IMAGE_MEDIA_TYPES.has(candidate.mediaType)) {
    throw new Error('MyDSH 运行核心 会话消息图片类型不受支持')
  }
  const data = boundedString(candidate.data, '图片数据', MAX_PROMPT_IMAGE_BYTES * 2)
  if (!BASE64_PATTERN.test(data)) {
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
  totals.count += 1
  totals.bytes += bytes.length
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
}

function parsePromptContentBlock(
  candidate: unknown,
  totals: { count: number; bytes: number },
): Record<string, unknown> {
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
  if (candidate.type === 'image') {
    return parsePromptImageBlock(candidate, totals)
  }
  throw new Error('MyDSH 运行核心 会话消息包含不支持的内容块')
}

/** 校验用户发送给会话的文本、文件回执和 Base64 图片块。 */
export function parsePromptSessionArgument(
  value: Record<string, unknown>,
): Record<string, unknown> {
  rejectUnexpectedFields(value, ['sessionId', 'mode', 'content', 'clientTimeZone'], '会话消息请求')
  if (value.mode !== 'queue' && value.mode !== 'steer') {
    throw new Error('MyDSH 运行核心 会话消息缺少有效的 mode')
  }
  if (!Array.isArray(value.content) || value.content.length === 0 || value.content.length > 64) {
    throw new Error('MyDSH 运行核心 会话消息必须包含 1 到 64 个内容块')
  }
  const imageTotals = { count: 0, bytes: 0 }
  const content = value.content.map(item => parsePromptContentBlock(item, imageTotals))
  if (
    imageTotals.count > MAX_PROMPT_IMAGE_COUNT ||
    imageTotals.bytes > MAX_PROMPT_IMAGE_BYTES * 2
  ) {
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

function parseSettingsNamespace(value: unknown): string {
  const namespace = boundedString(value, 'ns', 160)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(namespace)) {
    throw new Error('DSH 设置命名空间包含不支持的字符')
  }
  return namespace
}

function parseSettingsPath(value: unknown): string[] {
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

/** 校验设置中心路径级 `set` / `unset` 更新请求，阻断原型链字段与过深路径。 */
export function parseSettingsMutationArgument(
  value: Record<string, unknown>,
): Record<string, unknown> {
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
    const path = parseSettingsPath(candidate.path)
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
    ns: parseSettingsNamespace(value.ns),
    ops,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  }
}

function parseCredentialReference(value: unknown): string {
  const reference = boundedString(value, 'ref', 200)
  if (!CREDENTIAL_REF.test(reference)) {
    throw new Error('DSH 凭据引用必须是环境变量格式的标识符')
  }
  return reference
}

function parseApiSecret(value: unknown): string {
  const secret = boundedString(value, 'value', 16 * 1024)
  if (!/^[\x21-\x7E]+$/u.test(secret)) {
    throw new Error('DSH API 密钥只能包含可打印 ASCII 字符')
  }
  return secret
}

/** 校验凭据引用状态查询请求并去重。 */
export function parseCredentialDescribeArgument(
  value: Record<string, unknown>,
): Record<string, unknown> {
  rejectUnexpectedFields(value, ['refs'], '凭据查询')
  if (!Array.isArray(value.refs) || value.refs.length > 64) {
    throw new Error('DSH 凭据查询一次最多包含 64 个引用')
  }
  return { refs: [...new Set(value.refs.map(parseCredentialReference))] }
}

/** 校验凭据写入请求，不在错误消息中回显密钥。 */
export function parseCredentialSetArgument(
  value: Record<string, unknown>,
): Record<string, unknown> {
  rejectUnexpectedFields(value, ['ref', 'value'], '凭据写入')
  const secret = parseApiSecret(value.value)
  return { ref: parseCredentialReference(value.ref), value: secret }
}

/** 校验凭据删除请求。 */
export function parseCredentialUnsetArgument(
  value: Record<string, unknown>,
): Record<string, unknown> {
  rejectUnexpectedFields(value, ['ref'], '凭据删除')
  return { ref: parseCredentialReference(value.ref) }
}

/** 校验提供商模型发现请求并转换为 `llm/discoverModels` 载荷。 */
export function parseRemoteDiscoverModelsArgument(
  value: Record<string, unknown>,
): Record<string, unknown> {
  rejectUnexpectedFields(
    value,
    ['settingsNs', 'provider', 'baseURL', 'api', 'apiKey'],
    '模型发现请求',
  )
  const optional = (field: 'provider' | 'baseURL' | 'api' | 'apiKey', maximum: number) => {
    const candidate = value[field]
    if (candidate === undefined) return {}
    const parsed =
      field === 'apiKey' ? parseApiSecret(candidate) : boundedString(candidate, field, maximum)
    return { [field]: parsed }
  }
  const settingsNs = parseSettingsNamespace(value.settingsNs)
  const request = {
    ...optional('provider', 160),
    ...optional('baseURL', 2_048),
    ...optional('api', 160),
    ...optional('apiKey', 16 * 1024),
  }
  return { args: { settingsNs, request } }
}

/** 校验 Agent 预设机器标识符（仅小写字母、数字和连字符）。 */
export function parseAgentPresetId(value: unknown): string {
  const preset = boundedString(value, 'agentPreset', 160)
  if (!AGENT_PRESET_ID.test(preset)) {
    throw new Error('Agent 预设 ID 只能使用小写字母、数字和连字符')
  }
  return preset
}

/** 校验单个 Agent 预设标识请求。 */
export function parseAgentPresetArgument(value: Record<string, unknown>): Record<string, unknown> {
  rejectUnexpectedFields(value, ['agentPreset'], 'Agent 预设请求')
  return { agentPreset: parseAgentPresetId(value.agentPreset) }
}

/** 校验会话级 Agent 预设切换请求。 */
export function parseSelectSessionAgentPresetArgument(
  value: Record<string, unknown>,
): Record<string, unknown> {
  rejectUnexpectedFields(value, ['sessionId', 'agentPreset'], '会话预设选择请求')
  return {
    args: {
      agentId: boundedString(value.sessionId, 'sessionId', 512),
      agentPreset: parseAgentPresetId(value.agentPreset),
    },
  }
}

/** 校验 Agent 预设复制请求并映射为新版 `agentPresets/copy` 参数。 */
export function parseRemoteCopyAgentPresetArgument(
  value: Record<string, unknown>,
): Record<string, unknown> {
  rejectUnexpectedFields(value, ['from', 'agentPreset', 'name'], 'Agent 预设复制请求')
  const name = value.name === undefined ? undefined : boundedString(value.name, 'name', 160)
  return {
    args: {
      from: parseAgentPresetId(value.from),
      id: parseAgentPresetId(value.agentPreset),
      ...(name === undefined ? {} : { name }),
    },
  }
}

/** 校验会话图片附件读取请求。 */
export function parseSessionAttachmentArgument(
  value: Record<string, unknown>,
): Record<string, unknown> {
  rejectUnexpectedFields(value, ['sessionId', 'attachmentId'], '会话图片请求')
  return wrapRequestArgument({
    sessionId: boundedString(value.sessionId, 'sessionId', 512),
    attachmentId: boundedString(value.attachmentId, 'attachmentId', 512),
  })
}

/** 校验会话模型目录查询请求。 */
export function parseSessionModelCatalogArgument(
  value: Record<string, unknown>,
): Record<string, unknown> {
  boundedString(value.sessionId, 'sessionId')
  return { args: {} }
}

/** 校验会话当前模型与推理档位切换请求。 */
export function parseSelectModelArgument(value: Record<string, unknown>): Record<string, unknown> {
  const reasoningEffort = value.reasoningEffort
  return wrapRequestArgument({
    sessionId: boundedString(value.sessionId, 'sessionId'),
    provider: boundedString(value.provider, 'provider', 160),
    model: boundedString(value.model, 'model', 320),
    ...(reasoningEffort === undefined
      ? {}
      : { reasoningEffort: boundedString(reasoningEffort, 'reasoningEffort', 160) }),
  })
}

/** 校验会话访问权限预设并构造安全的 `/permission` 命令载荷。 */
export function parsePermissionCommandArgument(
  value: Record<string, unknown>,
): Record<string, unknown> {
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

/** 校验会话斜杠命令目录查询请求。 */
export function parseSessionCommandsArgument(
  value: Record<string, unknown>,
): Record<string, unknown> {
  rejectUnexpectedFields(value, ['sessionId'], '命令目录请求')
  return { args: { agentId: boundedString(value.sessionId, 'sessionId') } }
}

/** 校验会话 Skill 目录查询请求。 */
export function parseSessionSkillsArgument(
  value: Record<string, unknown>,
): Record<string, unknown> {
  rejectUnexpectedFields(value, ['sessionId'], 'Skill 目录请求')
  return wrapRequestArgument({ sessionId: boundedString(value.sessionId, 'sessionId') })
}

/** 校验会话斜杠命令执行请求。 */
export function parseExecuteSessionCommandArgument(
  value: Record<string, unknown>,
): Record<string, unknown> {
  rejectUnexpectedFields(value, ['sessionId', 'line'], '命令执行请求')
  const line = parseDesktopSlashCommandLine(value.line)
  if (line === null) {
    throw new Error('MyDSH 运行核心 命令行必须是有效且不超过 128 KiB 的 slash command')
  }
  return {
    args: {
      agentId: boundedString(value.sessionId, 'sessionId'),
      line,
      submittedAttachments: [],
    },
  }
}

/** 校验会话归档、恢复与永久删除请求。 */
export function parseArchiveSessionArgument(
  value: Record<string, unknown>,
): Record<string, unknown> {
  rejectUnexpectedFields(value, ['sessionId'], '会话归档请求')
  return { sessionId: boundedString(value.sessionId, 'sessionId') }
}

/** 校验会话重命名请求。 */
export function parseRenameSessionArgument(
  value: Record<string, unknown>,
): Record<string, unknown> {
  rejectUnexpectedFields(value, ['sessionId', 'title'], '会话重命名请求')
  return {
    sessionId: boundedString(value.sessionId, 'sessionId'),
    title: boundedString(value.title, 'title', 16 * 1024),
  }
}

/** 校验会话全文搜索请求。 */
export function parseSearchSessionsArgument(
  value: Record<string, unknown>,
): Record<string, unknown> {
  rejectUnexpectedFields(value, ['query'], '会话搜索请求')
  const query = boundedString(value.query, 'query', 500)
  if (query.includes('\0') || query.trim() === '') {
    throw new Error('MyDSH 运行核心 会话搜索词不能为空')
  }
  return { query }
}

/** 校验 `@` 文件引用补全查询请求。 */
export function parseFileReferencesArgument(
  value: Record<string, unknown>,
): Record<string, unknown> {
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

/** 校验会话历史分叉请求。 */
export function parseForkSessionArgument(value: Record<string, unknown>): Record<string, unknown> {
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

/** 校验消息反馈列表读取请求。 */
export function parseMessageFeedbackListArgument(
  value: Record<string, unknown>,
): Record<string, unknown> {
  rejectUnexpectedFields(value, ['sessionId'], '消息反馈读取请求')
  return wrapRequestArgument({ sessionId: boundedString(value.sessionId, 'sessionId') })
}

/** 校验消息反馈写入请求。 */
export function parseMessageFeedbackPutArgument(
  value: Record<string, unknown>,
): Record<string, unknown> {
  rejectUnexpectedFields(
    value,
    ['sessionId', 'messageId', 'rating', 'ifVersion'],
    '消息反馈更新请求',
  )
  if (value.rating !== 'positive' && value.rating !== 'negative') {
    throw new Error('MyDSH 运行核心 消息反馈评分无效')
  }
  const ifVersion = value.ifVersion === null ? null : boundedString(value.ifVersion, 'ifVersion')
  return wrapRequestArgument({
    sessionId: boundedString(value.sessionId, 'sessionId'),
    messageId: boundedString(value.messageId, 'messageId'),
    rating: value.rating,
    ifVersion,
  })
}

/** 校验消息反馈删除请求。 */
export function parseMessageFeedbackDeleteArgument(
  value: Record<string, unknown>,
): Record<string, unknown> {
  rejectUnexpectedFields(value, ['sessionId', 'messageId', 'ifVersion'], '消息反馈删除请求')
  return wrapRequestArgument({
    sessionId: boundedString(value.sessionId, 'sessionId'),
    messageId: boundedString(value.messageId, 'messageId'),
    ifVersion: boundedString(value.ifVersion, 'ifVersion'),
  })
}
