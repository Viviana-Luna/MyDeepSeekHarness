/**
 * 工作区标签分组与顶栏显隐规则：供工作台外壳与顶部标签栏共用，确保分组归属与显隐条件完全一致。
 * 运行在 renderer；纯数据计算模块，不依赖 React 或 DOM 状态。
 */
import type { ProjectSummary } from '../../domain/project.ts'
import type { WorkTab } from './WorkspaceTabsProvider.tsx'

/** 单个项目或无项目对话的工作标签分组。 */
export interface WorkTabGroup {
  readonly id: string
  readonly name: string
  readonly tabs: readonly WorkTab[]
}

/** 当前工作区的标签分组与可见标签计算结果。 */
export interface ResolvedWorkTabGroups {
  readonly groups: readonly WorkTabGroup[]
  readonly activeGroup: WorkTabGroup | undefined
  readonly groupTabs: readonly WorkTab[]
  readonly sshTabs: readonly WorkTab[]
}

/**
 * 按项目与无项目归属整理工作标签，并计算当前可见分组及其包含的标签（含窗口级 SSH 标签）。
 * @param tabs 已按展示顺序排列的工作标签列表。
 * @param projects 当前工作区项目摘要列表。
 * @param selectedProjectId 当前选中的项目标识。
 */
export function resolveWorkTabGroups(
  tabs: readonly WorkTab[],
  projects: readonly Pick<ProjectSummary, 'id' | 'name'>[],
  selectedProjectId: string | undefined,
): ResolvedWorkTabGroups {
  const groups: WorkTabGroup[] = projects.flatMap(owner => {
    const owned = tabs.filter(tab => tab.projectId === owner.id)
    if (owned.length === 0 && owner.id !== selectedProjectId) return []
    return [{ id: owner.id, name: owner.name, tabs: owned }]
  })
  const remaining = tabs.filter(tab => tab.projectId === 'unassigned' && tab.kind !== 'ssh')
  if (remaining.length > 0) {
    groups.push({ id: 'unassigned', name: '无项目对话', tabs: remaining })
  }
  const activeGroup =
    groups.find(group => group.tabs.some(tab => tab.active)) ??
    groups.find(group => group.id === selectedProjectId) ??
    groups[0]
  // SSH 属于窗口，项目切换和整组关闭都不转移或关闭它的终端。
  const sshTabs = tabs.filter(tab => tab.kind === 'ssh')
  const groupTabs = tabs.filter(tab => tab.kind === 'ssh' || tab.projectId === activeGroup?.id)
  return { groups, activeGroup, groupTabs, sshTabs }
}

/**
 * 判断顶部工作标签栏是否需要展开：侧栏收起时常驻承接红绿灯安全区与搜索入口，
 * 侧栏展开且当前分组仅 0 或 1 个标签时自动收起顶栏，改由主浮岛右上角浮动胶囊承接操作。
 */
export function shouldShowSessionTabs(
  navigationCollapsed: boolean,
  activeGroupTabCount: number,
): boolean {
  return navigationCollapsed || activeGroupTabCount > 1
}
