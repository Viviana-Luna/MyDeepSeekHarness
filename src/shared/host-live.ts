import {
  parseDesktopWorkspaceArchiveSnapshot,
  parseDesktopWorkspaceOrderResult,
  parseDesktopWorkspaceView,
  type DesktopWorkspaceView,
} from './workspace-capabilities.js'
import { boundedString, isRecord, type UnknownRecord } from './validation.ts'

export const DESKTOP_HOST_ID_MAX_LENGTH = 512
export const DESKTOP_HOST_PATH_MAX_LENGTH = 8 * 1024
export const DESKTOP_HOST_PRESET_MAX_LENGTH = 512
export const DESKTOP_HOST_ERROR_MAX_LENGTH = 64 * 1024

export type DesktopHostFrame =
  | {
      readonly type: 'host/settings-updated'
      readonly namespace: string
      readonly revision: number
    }
  | {
      readonly type: 'host/model-adapters-updated'
    }
  | {
      readonly type: 'host/credential-updated'
      readonly reference: string
    }
  | {
      readonly type: 'host/goal-activation-changed'
      readonly sessionId: string
    }
  | {
      readonly type: 'host/session-status'
      readonly sessionId: string
      readonly running: boolean
    }
  | {
      readonly type: 'host/session-added'
      readonly sessionId: string
      readonly blank: boolean
      readonly parentSessionId?: string
      readonly origin?: 'subagent'
      readonly cwd?: string
      readonly agentPreset?: string
    }
  | {
      readonly type: 'host/session-removed'
      readonly sessionId: string
    }
  | {
      readonly type: 'host/agent-error'
      readonly sessionId: string
      readonly message: string
    }
  | {
      readonly type: 'host/commands-changed'
    }
  | {
      readonly type: 'host/agent-preset-selected'
      readonly sessionId: string
      readonly agentPreset: string
    }
  | {
      readonly type: 'host/archived-sessions-changed'
      readonly archivedSessionIds: readonly string[]
    }
  | {
      readonly type: 'host/workspace-changed'
      readonly ['workspace']: DesktopWorkspaceView
    }
  | {
      readonly type: 'host/workspace-removed'
      readonly workspaceId: string
    }
  | {
      readonly type: 'host/workspace-order-changed'
      readonly workspaceIds: readonly string[]
    }

function optionalBoundedString(
  input: UnknownRecord,
  key: string,
  maximum: number,
): string | null | undefined {
  if (!Object.hasOwn(input, key)) return undefined
  return boundedString(input[key], maximum)
}

/**
 * 把 Host 实时事件收窄成桌面端需要的状态投影；未知事件保留给 Host 演进并由调用方忽略。
 */
export function parseDesktopHostFrame(input: unknown): DesktopHostFrame | null {
  if (!isRecord(input) || typeof input.type !== 'string') return null

  if (input.type === 'host/settings-updated') {
    const namespace = boundedString(input.namespace, 160)
    return namespace === null ||
      !Number.isSafeInteger(input.revision) ||
      (input.revision as number) < 0 ||
      Object.keys(input).some(key => !['type', 'namespace', 'revision'].includes(key))
      ? null
      : { type: input.type, namespace, revision: input.revision as number }
  }
  if (input.type === 'host/model-adapters-updated') {
    return Object.keys(input).length === 1 ? { type: input.type } : null
  }
  if (input.type === 'host/credential-updated') {
    const reference = boundedString(input.reference, 160)
    return reference === null ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(reference) ||
      Object.keys(input).some(key => !['type', 'reference'].includes(key))
      ? null
      : { type: input.type, reference }
  }
  if (input.type === 'host/goal-activation-changed') {
    const sessionId = boundedString(input.sessionId, DESKTOP_HOST_ID_MAX_LENGTH)
    return sessionId === null ||
      Object.keys(input).some(key => !['type', 'sessionId'].includes(key))
      ? null
      : { type: input.type, sessionId }
  }

  if (input.type === 'host/commands-changed') {
    return Object.keys(input).length === 1 ? { type: 'host/commands-changed' } : null
  }

  if (input.type === 'host/archived-sessions-changed') {
    try {
      const snapshot = parseDesktopWorkspaceArchiveSnapshot(input)
      return { type: 'host/archived-sessions-changed', ...snapshot }
    } catch {
      return null
    }
  }

  if (input.type === 'host/workspace-changed') {
    if (Object.keys(input).some(key => !['type', 'workspace'].includes(key))) return null
    try {
      const workspace = parseDesktopWorkspaceView(input.workspace)
      return { type: 'host/workspace-changed', workspace }
    } catch {
      return null
    }
  }

  if (input.type === 'host/workspace-removed') {
    const workspaceId = boundedString(input.workspaceId, DESKTOP_HOST_ID_MAX_LENGTH)
    return workspaceId === null ||
      Object.keys(input).some(key => !['type', 'workspaceId'].includes(key))
      ? null
      : { type: 'host/workspace-removed', workspaceId }
  }

  if (input.type === 'host/workspace-order-changed') {
    if (Object.keys(input).some(key => !['type', 'workspaceIds'].includes(key))) return null
    try {
      const order = parseDesktopWorkspaceOrderResult({ workspaceIds: input.workspaceIds })
      return { type: 'host/workspace-order-changed', workspaceIds: order.workspaceIds }
    } catch {
      return null
    }
  }

  if (input.type === 'host/agent-preset-selected') {
    const selectedSessionId = boundedString(input.sessionId, DESKTOP_HOST_ID_MAX_LENGTH)
    const selectedAgentPreset = boundedString(input.agentPreset, DESKTOP_HOST_PRESET_MAX_LENGTH)
    return selectedSessionId === null ||
      selectedAgentPreset === null ||
      Object.keys(input).some(key => !['type', 'sessionId', 'agentPreset'].includes(key))
      ? null
      : {
          type: 'host/agent-preset-selected',
          sessionId: selectedSessionId,
          agentPreset: selectedAgentPreset,
        }
  }

  if (input.type === 'host/remote-event') {
    if (!Array.isArray(input.args)) return null
    if (input.event === 'settings/document-updated' && input.args.length === 2) {
      return parseDesktopHostFrame({
        type: 'host/settings-updated',
        namespace: input.args[0],
        revision: input.args[1],
      })
    }
    if (input.event === 'llm/adapters-updated' && input.args.length === 0) {
      return { type: 'host/model-adapters-updated' }
    }
    if (input.event === 'credentials/reference-updated' && input.args.length === 1) {
      return parseDesktopHostFrame({ type: 'host/credential-updated', reference: input.args[0] })
    }
    if (
      input.event === 'goal/activation-changed' &&
      input.args.length === 1 &&
      isRecord(input.args[0])
    ) {
      const payload = input.args[0]
      if (
        payload.goal !== undefined &&
        (!isRecord(payload.goal) ||
          boundedString(payload.goal.id, 512) === null ||
          !Number.isSafeInteger(payload.goal.revision) ||
          (payload.goal.revision as number) < 1 ||
          (payload.goal.activation !== 'armed' && payload.goal.activation !== 'disarmed'))
      )
        return null
      return parseDesktopHostFrame({
        type: 'host/goal-activation-changed',
        sessionId: payload.sessionId,
      })
    }
    if (input.event === 'commands/change') {
      return input.args.length === 0 ? { type: 'host/commands-changed' } : null
    }
    if (input.event === 'agent-preset/selected') {
      if (input.args.length !== 2) return null
      const selectedSessionId = boundedString(input.args[0], DESKTOP_HOST_ID_MAX_LENGTH)
      const selectedAgentPreset = boundedString(input.args[1], DESKTOP_HOST_PRESET_MAX_LENGTH)
      return selectedSessionId === null || selectedAgentPreset === null
        ? null
        : {
            type: 'host/agent-preset-selected',
            sessionId: selectedSessionId,
            agentPreset: selectedAgentPreset,
          }
    }
    if (input.event === 'api-session/added') {
      if (input.args.length !== 1 || !isRecord(input.args[0])) return null
      const summary = input.args[0]
      const addedSessionId = boundedString(summary.sessionId, DESKTOP_HOST_ID_MAX_LENGTH)
      if (addedSessionId === null || typeof summary.blank !== 'boolean') return null
      const parentSessionId = optionalBoundedString(
        summary,
        'parentSessionId',
        DESKTOP_HOST_ID_MAX_LENGTH,
      )
      const cwd = optionalBoundedString(summary, 'cwd', DESKTOP_HOST_PATH_MAX_LENGTH)
      if (parentSessionId === null || cwd === null) return null
      if (Object.hasOwn(summary, 'origin') && summary.origin !== 'subagent') return null
      return {
        type: 'host/session-added',
        sessionId: addedSessionId,
        blank: summary.blank,
        ...(parentSessionId === undefined ? {} : { parentSessionId }),
        ...(summary.origin === 'subagent' ? { origin: 'subagent' as const } : {}),
        ...(cwd === undefined ? {} : { cwd }),
      }
    }
    if (input.event === 'api-session/removed') {
      if (input.args.length !== 1) return null
      const removedSessionId = boundedString(input.args[0], DESKTOP_HOST_ID_MAX_LENGTH)
      return removedSessionId === null
        ? null
        : { type: 'host/session-removed', sessionId: removedSessionId }
    }
    if (input.event === 'api-session/status') {
      if (input.args.length !== 2 || typeof input.args[1] !== 'boolean') return null
      const statusSessionId = boundedString(input.args[0], DESKTOP_HOST_ID_MAX_LENGTH)
      return statusSessionId === null
        ? null
        : { type: 'host/session-status', sessionId: statusSessionId, running: input.args[1] }
    }
    if (input.event === 'api-session/error') {
      if (input.args.length !== 2) return null
      const failedSessionId = boundedString(input.args[0], DESKTOP_HOST_ID_MAX_LENGTH)
      const message = boundedString(input.args[1], DESKTOP_HOST_ERROR_MAX_LENGTH)
      return failedSessionId === null || message === null
        ? null
        : { type: 'host/agent-error', sessionId: failedSessionId, message }
    }
    return null
  }

  const sessionId = boundedString(input.sessionId, DESKTOP_HOST_ID_MAX_LENGTH)
  if (sessionId === null) return null

  if (input.type === 'host/session-status') {
    return typeof input.running === 'boolean'
      ? { type: 'host/session-status', sessionId, running: input.running }
      : null
  }

  if (input.type === 'host/session-added') {
    if (typeof input.blank !== 'boolean') return null
    const parentSessionId = optionalBoundedString(
      input,
      'parentSessionId',
      DESKTOP_HOST_ID_MAX_LENGTH,
    )
    const cwd = optionalBoundedString(input, 'cwd', DESKTOP_HOST_PATH_MAX_LENGTH)
    const agentPreset = optionalBoundedString(input, 'agentPreset', DESKTOP_HOST_PRESET_MAX_LENGTH)
    if (parentSessionId === null || cwd === null || agentPreset === null) return null
    if (Object.hasOwn(input, 'origin') && input.origin !== 'subagent') return null
    return {
      type: 'host/session-added',
      sessionId,
      blank: input.blank,
      ...(parentSessionId === undefined ? {} : { parentSessionId }),
      ...(input.origin === 'subagent' ? { origin: 'subagent' as const } : {}),
      ...(cwd === undefined ? {} : { cwd }),
      ...(agentPreset === undefined ? {} : { agentPreset }),
    }
  }

  if (input.type === 'host/session-removed') {
    return { type: 'host/session-removed', sessionId }
  }

  if (input.type === 'host/agent-error') {
    const message = boundedString(input.message, DESKTOP_HOST_ERROR_MAX_LENGTH)
    return message === null ? null : { type: 'host/agent-error', sessionId, message }
  }

  return null
}
