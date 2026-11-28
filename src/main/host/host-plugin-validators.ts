/**
 * 主进程到运行核心的 Workspace、插件清单、长期目标（Goal）与子智能体参数校验器。
 */

import { isAbsolute } from 'node:path'
import { parseDesktopGoalRef } from '../../shared/plugin-capabilities.js'
import { isRecord } from '../../shared/validation.ts'
import {
  DESKTOP_WORKSPACE_ID_MAX_LENGTH,
  DESKTOP_WORKSPACE_PATH_MAX_LENGTH,
} from '../../shared/workspace-capabilities.js'
import { boundedString, rejectUnexpectedFields } from './host-payload-validators.ts'

function parseWorkspaceIdentifier(value: unknown, field: string): string {
  const identifier = boundedString(value, field, DESKTOP_WORKSPACE_ID_MAX_LENGTH)
  if (identifier.includes('\0')) throw new Error(`MyDSH 运行核心 请求包含无效的 ${field}`)
  return identifier
}

/** 校验持久化 Workspace 创建请求，按当前操作系统核对绝对路径。 */
export function parseCreateWorkspaceArgument(
  value: Record<string, unknown>,
): Record<string, unknown> {
  rejectUnexpectedFields(value, ['path'], 'Workspace 创建请求')
  const path = boundedString(value.path, 'path', DESKTOP_WORKSPACE_PATH_MAX_LENGTH)
  // 绝对路径判定按平台进行：Windows 的项目目录是 C:\… 形式，不能只认前导斜杠。
  if (!isAbsolute(path) || path.includes('\0')) {
    throw new Error('MyDSH 运行核心 Workspace 创建请求必须包含绝对目录路径')
  }
  return { path }
}

/** 校验 Workspace 重命名请求并裁剪首尾空白。 */
export function parseRenameWorkspaceArgument(
  value: Record<string, unknown>,
): Record<string, unknown> {
  rejectUnexpectedFields(value, ['workspaceId', 'title'], 'Workspace 重命名请求')
  const title = boundedString(value.title, 'title', 1_024).trim()
  if (title === '') throw new Error('MyDSH 运行核心 Workspace 标题不能为空')
  return {
    workspaceId: parseWorkspaceIdentifier(value.workspaceId, 'workspaceId'),
    title,
  }
}

/** 校验单个 Workspace 标识请求。 */
export function parseWorkspaceArgument(value: Record<string, unknown>): Record<string, unknown> {
  rejectUnexpectedFields(value, ['workspaceId'], 'Workspace 请求')
  return { workspaceId: parseWorkspaceIdentifier(value.workspaceId, 'workspaceId') }
}

/** 校验 Workspace 顺序调整请求。 */
export function parseReorderWorkspaceArgument(
  value: Record<string, unknown>,
): Record<string, unknown> {
  rejectUnexpectedFields(value, ['workspaceId', 'beforeWorkspaceId'], 'Workspace 排序请求')
  const beforeWorkspaceId =
    value.beforeWorkspaceId === undefined
      ? undefined
      : parseWorkspaceIdentifier(value.beforeWorkspaceId, 'beforeWorkspaceId')
  return {
    workspaceId: parseWorkspaceIdentifier(value.workspaceId, 'workspaceId'),
    ...(beforeWorkspaceId === undefined ? {} : { beforeWorkspaceId }),
  }
}

/** 校验在指定 Workspace 下创建新会话的请求。 */
export function parseCreateSessionForWorkspaceArgument(
  value: Record<string, unknown>,
): Record<string, unknown> {
  rejectUnexpectedFields(value, ['workspaceId', 'agentPreset'], 'Workspace 会话创建请求')
  return {
    workspaceId: parseWorkspaceIdentifier(value.workspaceId, 'workspaceId'),
    ...(value.agentPreset === undefined
      ? {}
      : { agentPreset: boundedString(value.agentPreset, 'agentPreset') }),
  }
}

/** 校验 Workspace 内会话排序请求。 */
export function parseReorderWorkspaceSessionArgument(
  value: Record<string, unknown>,
): Record<string, unknown> {
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
    workspaceId: parseWorkspaceIdentifier(value.workspaceId, 'workspaceId'),
    sessionId: boundedString(value.sessionId, 'sessionId'),
    ...(beforeSessionId === undefined ? {} : { beforeSessionId }),
  }
}

/** 校验插件清单读取请求。 */
export function parsePluginInventoryArgument(
  value: Record<string, unknown>,
): Record<string, unknown> {
  rejectUnexpectedFields(value, [], '插件目录请求')
  return { args: {} }
}

function parsePluginSessionId(value: unknown): string {
  const id = boundedString(value, '会话标识')
  if ([...id].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new Error('会话标识包含控制字符')
  }
  return id
}

/** 校验会话长期目标（Goal）读取、创建、编辑与状态流转请求。 */
export function parseGoalArgument(
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
  const args: Record<string, unknown> = { agentId: parsePluginSessionId(value.sessionId) }
  if (action !== 'get' && action !== 'create') {
    if (!isRecord(value.ref)) throw new Error('目标操作缺少 revision')
    rejectUnexpectedFields(value.ref, ['id', 'revision'], '目标版本')
    args.ref = { ...parseDesktopGoalRef(value.ref), id: parsePluginSessionId(value.ref.id) }
  }
  if (action === 'create' || action === 'edit') {
    if (action === 'create' || value.objective !== undefined) {
      const objective = boundedString(value.objective, '目标内容', 16 * 1024)
      if (objective.trim() === '' || objective.includes('\0')) {
        throw new Error('目标内容不能为空或包含 NUL')
      }
    }
    if (
      value.maxGoalRounds !== undefined &&
      (!Number.isSafeInteger(value.maxGoalRounds) || (value.maxGoalRounds as number) < 1)
    ) {
      throw new Error('目标轮数必须是正整数')
    }
    if (action === 'edit' && value.objective === undefined && value.maxGoalRounds === undefined) {
      throw new Error('目标编辑缺少变更字段')
    }
    args.request = {
      ...(value.objective === undefined ? {} : { objective: value.objective }),
      ...(value.maxGoalRounds === undefined ? {} : { maxGoalRounds: value.maxGoalRounds }),
    }
  }
  return { args }
}

/** 校验子智能体目录读取、继续发送消息与父会话中断请求。 */
export function parseSubagentArgument(
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
  const parentSessionId = parsePluginSessionId(value.parentSessionId)
  if (action === 'list') return { args: { parentSessionId } }
  const childSessionId = parsePluginSessionId(value.childSessionId)
  if (childSessionId === parentSessionId) throw new Error('子智能体不能与父会话相同')
  const address = { parentSessionId, childSessionId, mode: 'continuable' }
  if (action === 'interrupt') return { args: address }
  if (value.delivery !== 'queue' && value.delivery !== 'steer') {
    throw new Error('子智能体消息发送方式无效')
  }
  const text = boundedString(value.text, '子智能体消息', 128 * 1024)
  if (text.trim() === '' || text.includes('\0')) {
    throw new Error('子智能体消息不能为空或包含 NUL')
  }
  const requestId = boundedString(value.requestId, '子智能体消息请求标识', 160)
  if (!/^[A-Za-z0-9_-]+$/u.test(requestId)) {
    throw new Error('子智能体消息请求标识无效')
  }
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
