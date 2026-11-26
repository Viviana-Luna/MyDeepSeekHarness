import { isRecord } from './validation.ts'
export const DESKTOP_ARCHIVED_SESSION_MAX_ITEMS = 20_000
export const DESKTOP_ARCHIVED_SESSION_ID_MAX_LENGTH = 512
export const DESKTOP_WORKSPACE_MAX_ITEMS = 4_096
export const DESKTOP_WORKSPACE_ID_MAX_LENGTH = 512
export const DESKTOP_WORKSPACE_PATH_MAX_LENGTH = 16 * 1_024
export const DESKTOP_WORKSPACE_TITLE_MAX_LENGTH = 1_024
export const DESKTOP_WORKSPACE_SESSION_MAX_ITEMS = 20_000
export const DESKTOP_WORKSPACE_TIMESTAMP_MAX_LENGTH = 128

export interface DesktopWorkspaceArchiveSnapshot {
  readonly archivedSessionIds: readonly string[]
}

export interface DesktopWorkspaceView {
  readonly workspaceId: string
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
}

export interface DesktopWorkspaceListResult extends DesktopWorkspaceArchiveSnapshot {
  readonly items: readonly DesktopWorkspaceView[]
}

export interface DesktopWorkspaceCreateResult {
  readonly ['workspace']: DesktopWorkspaceView
  readonly created: boolean
}

export interface DesktopWorkspaceChangeResult {
  readonly ['workspace']: DesktopWorkspaceView
}

export interface DesktopWorkspaceDeleteResult {
  readonly deleted: true
}

export interface DesktopWorkspaceOrderResult {
  readonly workspaceIds: readonly string[]
}

export interface DesktopWorkspaceSessionCreateResult {
  readonly sessionId: string
  readonly agentPreset?: string
}

const ISO_8601_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u

function invalidArchiveSnapshot(): never {
  throw new Error('DSH Host 返回了无效的归档会话集合')
}

function invalidWorkspaceResult(subject: string): never {
  throw new Error(`DSH Host 返回了无效的${subject}`)
}

function boundedString(
  value: unknown,
  maximum: number,
  subject: string,
  options: { readonly allowEmpty?: boolean } = {},
): string {
  if (
    typeof value !== 'string' ||
    (!options.allowEmpty && value.length === 0) ||
    value.length > maximum ||
    value.includes('\0')
  ) {
    return invalidWorkspaceResult(subject)
  }
  return value
}

function workspaceId(value: unknown, subject = ' Workspace ID'): string {
  return boundedString(value, DESKTOP_WORKSPACE_ID_MAX_LENGTH, subject)
}

function sessionIds(value: unknown, subject: string): readonly string[] {
  if (!Array.isArray(value) || value.length > DESKTOP_WORKSPACE_SESSION_MAX_ITEMS) {
    return invalidWorkspaceResult(subject)
  }
  const ids = value.map(candidate =>
    boundedString(candidate, DESKTOP_ARCHIVED_SESSION_ID_MAX_LENGTH, subject),
  )
  if (new Set(ids).size !== ids.length) return invalidWorkspaceResult(subject)
  return ids
}

function workspaceTimestamp(value: unknown, subject: string): string {
  const timestamp = boundedString(value, DESKTOP_WORKSPACE_TIMESTAMP_MAX_LENGTH, subject)
  return ISO_8601_INSTANT.test(timestamp) && Number.isFinite(Date.parse(timestamp))
    ? timestamp
    : invalidWorkspaceResult(subject)
}

/**
 * 跨平台绝对路径判定。共享模块同时被渲染层打包，不能依赖 `node:path`；
 * Windows 的盘符路径（`C:\…`、`C:/…`）与 UNC 路径同样属于绝对路径。
 */
function absoluteWorkspacePath(path: string): boolean {
  return path.startsWith('/') || /^[a-z]:[\\/]/iu.test(path) || /^\\\\[^\\]/u.test(path)
}

export function parseDesktopWorkspaceView(value: unknown): DesktopWorkspaceView {
  if (!isRecord(value)) return invalidWorkspaceResult(' Workspace 记录')
  const path = boundedString(value.path, DESKTOP_WORKSPACE_PATH_MAX_LENGTH, ' Workspace 路径')
  if (!absoluteWorkspacePath(path)) return invalidWorkspaceResult(' Workspace 路径')
  return {
    workspaceId: workspaceId(value.workspaceId),
    path,
    title: boundedString(value.title, DESKTOP_WORKSPACE_TITLE_MAX_LENGTH, ' Workspace 标题', {
      allowEmpty: true,
    }),
    sessionIds: sessionIds(value.sessionIds, ' Workspace 会话顺序'),
    createdAt: workspaceTimestamp(value.createdAt, ' Workspace 创建时间'),
    updatedAt: workspaceTimestamp(value.updatedAt, ' Workspace 更新时间'),
  }
}

function archivedSessionIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > DESKTOP_ARCHIVED_SESSION_MAX_ITEMS) {
    return invalidArchiveSnapshot()
  }
  const ids = value.map(candidate => {
    if (
      typeof candidate !== 'string' ||
      candidate.length === 0 ||
      candidate.length > DESKTOP_ARCHIVED_SESSION_ID_MAX_LENGTH ||
      candidate.includes('\0')
    ) {
      return invalidArchiveSnapshot()
    }
    return candidate
  })
  if (new Set(ids).size !== ids.length) return invalidArchiveSnapshot()
  return ids
}

/** 严格解析 workspace/follow 与 workspace/archiveSession 共用的完整归档集合。 */
export function parseDesktopWorkspaceArchiveSnapshot(
  input: unknown,
): DesktopWorkspaceArchiveSnapshot {
  if (!isRecord(input)) return invalidArchiveSnapshot()
  return { archivedSessionIds: archivedSessionIds(input.archivedSessionIds) }
}

/** 严格解析 workspace/follow 的 Durable Workspace 与归档重连基线。 */
export function parseDesktopWorkspaceListResult(input: unknown): DesktopWorkspaceListResult {
  if (
    !isRecord(input) ||
    !Array.isArray(input.items) ||
    input.items.length > DESKTOP_WORKSPACE_MAX_ITEMS
  ) {
    return invalidWorkspaceResult(' Workspace 列表')
  }
  const items: DesktopWorkspaceView[] = []
  const workspaceIds = new Set<string>()
  const paths = new Set<string>()
  const allSessionIds = new Set<string>()
  for (const candidate of input.items) {
    const item = parseDesktopWorkspaceView(candidate)
    if (workspaceIds.has(item.workspaceId) || paths.has(item.path)) {
      return invalidWorkspaceResult(' Workspace 列表')
    }
    workspaceIds.add(item.workspaceId)
    paths.add(item.path)
    for (const sessionId of item.sessionIds) {
      if (
        allSessionIds.has(sessionId) ||
        allSessionIds.size >= DESKTOP_WORKSPACE_SESSION_MAX_ITEMS
      ) {
        return invalidWorkspaceResult(' Workspace 列表')
      }
      allSessionIds.add(sessionId)
    }
    items.push(item)
  }
  return {
    items,
    archivedSessionIds: archivedSessionIds(input.archivedSessionIds),
  }
}

/** 严格解析 workspace/create 的幂等创建结果。 */
export function parseDesktopWorkspaceCreateResult(input: unknown): DesktopWorkspaceCreateResult {
  if (!isRecord(input) || typeof input.created !== 'boolean') {
    return invalidWorkspaceResult(' Workspace 创建结果')
  }
  const workspace = parseDesktopWorkspaceView(input.workspace)
  return { workspace, created: input.created }
}

export function parseDesktopWorkspaceChangeResult(input: unknown): DesktopWorkspaceChangeResult {
  if (!isRecord(input)) return invalidWorkspaceResult(' Workspace 更新结果')
  const workspace = parseDesktopWorkspaceView(input.workspace)
  return { workspace }
}

export function parseDesktopWorkspaceDeleteResult(input: unknown): DesktopWorkspaceDeleteResult {
  if (!isRecord(input) || input.deleted !== true) {
    return invalidWorkspaceResult(' Workspace 移除结果')
  }
  return { deleted: true }
}

/** 严格解析 workspace/insertBefore 返回的完整持久化顺序。 */
export function parseDesktopWorkspaceOrderResult(input: unknown): DesktopWorkspaceOrderResult {
  if (
    !isRecord(input) ||
    !Array.isArray(input.workspaceIds) ||
    input.workspaceIds.length > DESKTOP_WORKSPACE_MAX_ITEMS
  ) {
    return invalidWorkspaceResult(' Workspace 顺序')
  }
  const workspaceIds = input.workspaceIds.map(candidate => workspaceId(candidate))
  if (new Set(workspaceIds).size !== workspaceIds.length) {
    return invalidWorkspaceResult(' Workspace 顺序')
  }
  return { workspaceIds }
}

/** 严格解析按 Workspace 创建 Session 的最小结果。 */
export function parseDesktopWorkspaceSessionCreateResult(
  input: unknown,
): DesktopWorkspaceSessionCreateResult {
  if (!isRecord(input)) return invalidWorkspaceResult(' Session 创建结果')
  const agentPreset =
    input.agentPreset === undefined
      ? undefined
      : boundedString(
          input.agentPreset,
          DESKTOP_WORKSPACE_TITLE_MAX_LENGTH,
          ' Session Agent 预设',
          { allowEmpty: true },
        )
  return {
    sessionId: boundedString(
      input.sessionId,
      DESKTOP_ARCHIVED_SESSION_ID_MAX_LENGTH,
      ' Session 创建结果',
    ),
    ...(agentPreset === undefined ? {} : { agentPreset }),
  }
}
