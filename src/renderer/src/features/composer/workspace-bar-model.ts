/**
 * 输入区工作区胶囊纯数据模型：聚合可选工作区、已打开标签组未读/运行状态及菜单项描述。
 * 运行在 renderer；纯计算模块，不依赖 DOM 或组件副作用。
 */
import type { ProjectSummary } from '../../domain/project.ts'
import type { WorkTabGroup } from '../workspace-tabs/work-tab-groups.ts'

/** 输入区工作区菜单中的单个工作区条目。 */
export interface WorkspaceMenuEntry {
  readonly id: string
  readonly name: string
  readonly detail: string
  readonly isSelected: boolean
  readonly running: boolean
  readonly unreadCount: number
  readonly group: WorkTabGroup | undefined
  readonly project: ProjectSummary | undefined
}

/** 其他后台工作区的运行与未读汇总状态。 */
export interface WorkspaceGroupStatusSummary {
  readonly entries: readonly WorkspaceMenuEntry[]
  readonly otherUnread: number
  readonly otherRunning: boolean
}

function countUnreadTabs(group: WorkTabGroup | undefined): number {
  if (group === undefined) return 0
  return group.tabs.filter(tab => tab.unread === true).length
}

function formatEntryDetail(options: {
  readonly displayPath: string | undefined
  readonly group: WorkTabGroup | undefined
  readonly unread: number
  readonly showTabStats: boolean
}): string {
  const { displayPath, group, unread, showTabStats } = options
  if (showTabStats && group !== undefined && group.tabs.length > 0) {
    const base = `${String(group.tabs.length)} 个标签`
    if (unread > 0) return `${base} · ${String(unread)} 个会话有更新`
    return displayPath === undefined ? base : `${base} · ${displayPath}`
  }
  return displayPath ?? '未绑定工作目录'
}

/**
 * 组合可选工作区列表与当前已打开的标签组状态，生成输入区工作区菜单条目及后台未读统计。
 * 在左侧栏收缩态补充已打开的「无项目对话」标签组，确保切换与未读提醒不遗漏。
 */
export function buildWorkspaceMenuSummary(options: {
  readonly projects: readonly ProjectSummary[]
  readonly groups: readonly WorkTabGroup[]
  readonly activeKey: string | undefined
  readonly includeUnassignedGroup: boolean
  readonly showTabStats: boolean
}): WorkspaceGroupStatusSummary {
  const { projects, groups, activeKey, includeUnassignedGroup, showTabStats } = options
  const groupById = new Map(groups.map(group => [group.id, group]))
  const entries: WorkspaceMenuEntry[] = projects.map(project => {
    const group = groupById.get(project.id)
    const unread = countUnreadTabs(group)
    return {
      id: project.id,
      name: project.name,
      detail: formatEntryDetail({
        displayPath: project.displayPath,
        group,
        unread,
        showTabStats,
      }),
      isSelected: project.id === activeKey,
      running: group?.tabs.some(tab => tab.running === true) === true,
      unreadCount: unread,
      group,
      project,
    }
  })
  const seenIds = new Set(entries.map(entry => entry.id))
  if (includeUnassignedGroup) {
    for (const group of groups) {
      if (seenIds.has(group.id) || group.tabs.length === 0) continue
      const unread = countUnreadTabs(group)
      entries.push({
        id: group.id,
        name: group.name,
        detail: formatEntryDetail({
          displayPath: undefined,
          group,
          unread,
          showTabStats: true,
        }),
        isSelected: group.id === activeKey,
        running: group.tabs.some(tab => tab.running === true),
        unreadCount: unread,
        group,
        project: undefined,
      })
    }
  }
  const otherGroups = groups.filter(group => group.id !== activeKey)
  const otherUnread = otherGroups.reduce((total, group) => total + countUnreadTabs(group), 0)
  const otherRunning = otherGroups.some(group => group.tabs.some(tab => tab.running === true))
  return { entries, otherUnread, otherRunning }
}
