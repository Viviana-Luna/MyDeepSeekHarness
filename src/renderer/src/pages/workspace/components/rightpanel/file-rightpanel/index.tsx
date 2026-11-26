/** 文件视图右侧浮岛入口，透传可见状态给项目脚本面板。 */
import type { IslandPresentationProps } from '../../../../../plugins/registry.ts'
import { ProjectTasksPanel } from '../../../../../features/project-tasks/ProjectTasksPanel.tsx'

/** 渲染项目脚本面板，确保浮岛隐藏时不泄漏悬浮告警。 */
export function FileRightPanel({ visibility }: IslandPresentationProps) {
  return <ProjectTasksPanel visible={visibility === 'foreground'} />
}
