/** 模式标识由已加载界面插件注册；内置模式保留原标识，扩展使用自己的命名空间。 */
export type WorkspaceView = string

interface PanelVisibility {
  navigationCollapsed: boolean
  informationCollapsed: boolean
}

interface ViewState extends PanelVisibility {
  activeView: WorkspaceView
}

/**
 * 模式切换只改变当前展示状态：进入声明了临时收起的模式时暂存侧栏选择，离开时恢复。
 * 不写入布局偏好；持久化由用户主动调整侧栏的操作负责，动效由页面样式负责。
 */
export function transitionWorkspaceView(
  current: ViewState,
  restore: PanelVisibility | null,
  view: WorkspaceView,
  collapsePanelsOnEnter: boolean | 'right',
): { patch: Partial<ViewState>; restore: PanelVisibility | null } {
  if (current.activeView === view) return { patch: { activeView: view }, restore }

  const panels: PanelVisibility = restore ?? {
    navigationCollapsed: current.navigationCollapsed,
    informationCollapsed: current.informationCollapsed,
  }

  if (collapsePanelsOnEnter) {
    return {
      patch: {
        activeView: view,
        navigationCollapsed: collapsePanelsOnEnter === true ? true : panels.navigationCollapsed,
        informationCollapsed: true,
      },
      restore: panels,
    }
  }
  return { patch: { activeView: view, ...panels }, restore: null }
}
