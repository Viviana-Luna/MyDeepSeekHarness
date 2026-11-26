/**
 * 项目工作区事件共享契约：定义后台运行时推送给桌面端的 Git 变更事件格式与边界校验。
 * 在后台运行时、主进程与渲染进程之间共用，不持有任何句柄或状态。
 */
import { isRecord } from './validation.ts'

/** 主进程向 renderer 推送项目工作区变更事件的 IPC 通道名。 */
export const DESKTOP_PROJECT_EVENT_CHANNEL = 'dsh-desktop:project:event'

/** Git 变更范围：refs 表示提交/分支/标签元数据变化，working 表示工作区或暂存区文件变化。 */
export type DesktopProjectGitChangeScope = 'working' | 'refs'

/** 触发项目 Git 变更事件的来源。 */
export type DesktopProjectGitChangeReason = 'watcher' | 'agent-turn' | 'editor-save'

/** 项目 Git 仓库发生外部或内部变更时的通知事件。 */
export interface DesktopProjectGitChangedEvent {
  readonly type: 'git-changed'
  readonly projectId: string
  readonly scope: DesktopProjectGitChangeScope
  readonly reason: DesktopProjectGitChangeReason
  readonly timestamp: number
}

/** 项目工作区事件联合类型。 */
export type DesktopProjectEvent = DesktopProjectGitChangedEvent

/**
 * 校验来自 IPC 桥的项目事件载荷；字段或类型不合法时返回 null，避免异常数据破坏前端状态。
 */
export function parseDesktopProjectEvent(value: unknown): DesktopProjectEvent | null {
  if (!isRecord(value) || value.type !== 'git-changed') return null
  const { projectId, scope, reason, timestamp } = value
  if (typeof projectId !== 'string' || projectId === '' || projectId.length > 512) return null
  if (scope !== 'working' && scope !== 'refs') return null
  if (reason !== 'watcher' && reason !== 'agent-turn' && reason !== 'editor-save') return null
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return null
  return {
    type: 'git-changed',
    projectId,
    scope,
    reason,
    timestamp,
  }
}
