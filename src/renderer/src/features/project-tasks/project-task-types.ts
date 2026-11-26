import type {
  DesktopProjectTaskDefinition,
  DesktopProjectTaskEvent,
} from '../../../../shared/project-tasks.ts'
import { asRecord } from '../../../../shared/validation.ts'

export function parseProjectTaskDefinition(value: unknown): DesktopProjectTaskDefinition {
  const input = asRecord(value)
  if (
    input === null ||
    typeof input.id !== 'string' ||
    typeof input.projectId !== 'string' ||
    typeof input.name !== 'string' ||
    typeof input.executable !== 'string' ||
    !Array.isArray(input.args) ||
    input.args.some(item => typeof item !== 'string') ||
    typeof input.cwd !== 'string' ||
    asRecord(input.env) === null ||
    Object.values(input.env as Record<string, unknown>).some(item => typeof item !== 'string') ||
    typeof input.allowConcurrent !== 'boolean'
  )
    throw new Error('项目任务返回了无效定义')
  return input as unknown as DesktopProjectTaskDefinition
}

export function parseProjectTaskList(value: unknown): readonly DesktopProjectTaskDefinition[] {
  if (!Array.isArray(value)) throw new Error('项目任务列表无效')
  return value.map(parseProjectTaskDefinition)
}

export function parseProjectTaskEvent(value: unknown): DesktopProjectTaskEvent {
  const input = asRecord(value)
  if (input === null || typeof input.type !== 'string' || typeof input.projectId !== 'string') {
    throw new Error('项目任务事件无效')
  }
  if (input.type === 'snapshot') {
    return {
      type: 'snapshot',
      projectId: input.projectId,
      task: parseProjectTaskDefinition(input.task),
    }
  }
  if (input.type === 'removed' && typeof input.taskId === 'string') {
    return { type: 'removed', projectId: input.projectId, taskId: input.taskId }
  }
  if (
    input.type === 'reordered' &&
    Array.isArray(input.taskIds) &&
    input.taskIds.every(item => typeof item === 'string')
  ) {
    return { type: 'reordered', projectId: input.projectId, taskIds: input.taskIds as string[] }
  }
  throw new Error('项目任务事件无效')
}
