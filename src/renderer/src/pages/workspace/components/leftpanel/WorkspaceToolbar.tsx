/**
 * 左侧工作模式工具栏：渲染任务视图切换按钮、插件动作与设置入口。
 * 运行在 renderer；为模式按钮和设置按钮注入弹性按压，并在激活项按压时同步驱动滑块形变。
 */
import { Tooltip } from 'antd'
import { Settings } from 'lucide-react'
import { useRef, type CSSProperties } from 'react'

import { useWorkspaceTabs } from '../../../../features/workspace-tabs/WorkspaceTabsProvider.tsx'
import { useWorkspaceSnapshot, useWorkspaceStore } from '../../../../hooks/useWorkspace.ts'
import {
  PluginActions,
  PluginBoundary,
  PluginIconView,
  useModes,
} from '../../../../plugins/react.tsx'
import { ElasticPress } from '../../../../shared/ui/ElasticPress.tsx'
import { useSelectionWorm } from '../../../../shared/ui/useSelectionWorm.ts'

/** 左侧窄模式切换栏，包含视图页签、插件扩展操作及设置按钮。 */
export function WorkspaceToolbar() {
  const allModes = useModes()
  const tabs = allModes.filter(mode => !['trajectory', 'terminal', 'browser'].includes(mode.id))
  const store = useWorkspaceStore()
  const workTabs = useWorkspaceTabs()
  const snapshot = useWorkspaceSnapshot()
  const tabsRef = useRef<HTMLElement>(null)
  const indicatorRef = useRef<HTMLSpanElement>(null)
  const normalizedView = snapshot.activeView === 'trajectory' ? 'conversation' : snapshot.activeView
  const activeMode = allModes.find(mode => mode.id === snapshot.activeView)
  // 整页模式（如插件管理）在侧栏收起期间高亮自身；常规顶部标签切换始终保持左侧导航高亮不变。
  const highlightedView =
    activeMode?.collapsePanelsOnEnter === true && tabs.some(tab => tab.id === activeMode.id)
      ? activeMode.id
      : (snapshot.navigationView ?? normalizedView)
  const wormRef = useSelectionWorm({
    containerRef: tabsRef,
    activeSelector: 'button.is-active',
    activeKey: highlightedView,
  })

  return (
    <div className="workspace-toolbar-content">
      <nav
        ref={tabsRef}
        className="view-tabs"
        aria-label="任务视图切换"
        style={
          {
            '--active-view-index': tabs.findIndex(tab => tab.id === highlightedView),
          } as CSSProperties
        }
      >
        <span
          ref={indicatorRef}
          className="view-tabs__indicator"
          aria-hidden="true"
          hidden={!tabs.some(tab => tab.id === highlightedView)}
        />
        <span ref={wormRef} className="view-tabs__worm" aria-hidden="true" hidden />
        {tabs.map(tab => {
          const TooltipView = tab.tooltip
          const isActive = highlightedView === tab.id
          return (
            <Tooltip
              key={tab.id}
              title={
                TooltipView ? (
                  <PluginBoundary name={`${tab.label}提示`} fallback={tab.label}>
                    <TooltipView />
                  </PluginBoundary>
                ) : (
                  tab.label
                )
              }
              placement="right"
              trigger={['hover', 'focus']}
              mouseEnterDelay={0.3}
            >
              <ElasticPress hoverSwell mirrorRef={isActive ? indicatorRef : undefined}>
                <button
                  className={isActive ? 'is-active' : ''}
                  type="button"
                  data-view={tab.id}
                  aria-label={tab.label}
                  aria-current={isActive ? 'page' : undefined}
                  onClick={() => {
                    workTabs?.focus(null)
                    if (tab.id === 'connections') workTabs?.sshGroup?.select(null)
                    store.setView(tab.id, { syncNavigation: true })
                  }}
                >
                  <PluginIconView icon={tab.icon} name={tab.label} size={20} strokeWidth={1.8} />
                </button>
              </ElasticPress>
            </Tooltip>
          )
        })}
      </nav>
      <PluginActions
        name="workspace.toolbar"
        scopeKey={store.selectedProject()?.id ?? 'no-project'}
      />
      <Tooltip title="设置" placement="right" trigger={['hover', 'focus']} mouseEnterDelay={0.3}>
        <ElasticPress hoverSwell>
          <button
            className="mode-settings"
            id="open-settings"
            type="button"
            aria-label="设置"
            onClick={() => {
              store.openSettings()
            }}
          >
            <Settings size={20} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </ElasticPress>
      </Tooltip>
    </div>
  )
}
