/**
 * 工作台主页面：装配顶部工作标签、左侧导航、主/右侧浮岛、面板分隔条与全局业务 Provider。
 * 运行在 renderer；控制顶栏显隐条件、模式切换过渡与全局弹窗挂载。
 */
import { PluginLoader } from '../../plugins/PluginLoader.tsx'
import {
  PluginActions,
  PluginNotifications,
  PluginOverlays,
  useIslands,
  useModes,
} from '../../plugins/react.tsx'
import { Search } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react'
import { useWorkspaceSnapshot, useWorkspaceStore } from '../../hooks/useWorkspace.ts'
import { AppearanceSystem } from '../../features/appearance/appearance-system.tsx'
import { PanelDividers } from './components/PanelDividers.tsx'
import {
  ProjectWorkspaceProvider,
  useProjectWorkspace,
} from '../../features/project-workspace/ProjectWorkspaceProvider.tsx'
import { SettingsDialog } from '../../features/settings/SettingsDialog.tsx'
import { SessionSearch } from '../../features/search/SessionSearch.tsx'
import { AppAlert } from '../../shared/ui/AppAlert.tsx'
import { UnsavedChangesDialog } from '../../features/files/UnsavedChangesDialog.tsx'
import { ProjectTasksProvider } from '../../features/project-tasks/ProjectTasksProvider.tsx'
import { SourceControlProvider } from '../../features/source-control/SourceControlProvider.tsx'
import { MainPanel } from './components/mainpanel/index.tsx'
import { LeftPanel } from './components/leftpanel/index.tsx'
import {
  WorkspaceTabsProvider,
  useWorkspaceTabs,
} from '../../features/workspace-tabs/WorkspaceTabsProvider.tsx'
import { Topbar } from './components/topbar/index.tsx'
import {
  resolveWorkTabGroups,
  shouldShowSessionTabs,
  useWorkTabs,
} from '../../features/workspace-tabs/useWorkTabs.ts'
import { ConnectionsProvider } from '../../features/connections/ConnectionsProvider.tsx'
import { BrowserAutomationTabSync } from '../../features/browser/BrowserAutomationTabSync.tsx'
import { WindowStateSync } from '../../features/window/WindowControls.tsx'

/** 文件和项目操作共用页面级提示；其他领域通过提示插槽提供自己的错误内容。 */
function ProjectWorkspaceAlert() {
  const workspace = useProjectWorkspace()
  const { hostStatus } = useWorkspaceSnapshot()
  if (hostStatus !== null && hostStatus.kind !== 'ready') {
    return (
      <AppAlert tone="error" title="MyDSH 运行时不可用">
        {hostStatus.message}
      </AppAlert>
    )
  }
  if (workspace.error === null) return null
  return (
    <AppAlert
      tone="error"
      title="项目操作失败"
      dismissAfterMs={8_000}
      onClose={workspace.clearError}
    >
      {workspace.error}
    </AppAlert>
  )
}

/** 仅在对应视图键真正变化时播放竖向滑入动画，避免顶部标签切换牵动未变化的区域。 */
function useVerticalViewSlide(
  shellRef: RefObject<HTMLDivElement | null>,
  selector: string,
  view: string,
): void {
  const previousView = useRef(view)
  useLayoutEffect(() => {
    const shell = shellRef.current
    const from = previousView.current
    previousView.current = view
    if (shell === null || from === view) return
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (motion.matches) return
    const views = [...shell.querySelectorAll<HTMLButtonElement>('.view-tabs [data-view]')].map(
      button => button.dataset.view,
    )
    const direction = views.indexOf(view) > views.indexOf(from) ? 1 : -1
    const contents = shell.querySelectorAll<HTMLElement>(selector)
    const animations = [...contents]
      .filter(
        element => element.getClientRects().length > 0 && typeof element.animate === 'function',
      )
      .map(element =>
        element.animate(
          [
            { transform: `translateY(${String(direction * 24)}px)`, opacity: 0.4 },
            { transform: 'translateY(0)', opacity: 1 },
          ],
          { duration: 320, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
        ),
      )
    const cancel = () => {
      animations.forEach(animation => {
        animation.cancel()
      })
    }
    const onMotionChange = () => {
      if (motion.matches) cancel()
    }
    motion.addEventListener('change', onMotionChange)
    return () => {
      cancel()
      motion.removeEventListener('change', onMotionChange)
    }
  }, [selector, shellRef, view])
}

/**
 * 工作台总布局：顶部会话标签、左侧导航、中央内容、右侧信息和面板分隔条。
 * WorkspaceStore 提供显隐与尺寸状态，styles/layout.css 根据 data 属性和 CSS 变量安排布局。
 * 四个区域入口按当前模式组合业务面板，共享状态仍由页面级 Provider 持有。
 */
function DesktopWorkspace() {
  const snapshot = useWorkspaceSnapshot()
  const store = useWorkspaceStore()
  const modes = useModes()
  const islands = useIslands()
  useEffect(() => {
    const homeModeId = store.configureModes(modes, islands)
    if (homeModeId === null) return
    if (!modes.some(mode => mode.id === snapshot.activeView)) store.setView(homeModeId)
    const hasValidNavigation = modes.some(
      mode =>
        mode.id === snapshot.navigationView &&
        mode.left !== undefined &&
        mode.collapsePanelsOnEnter !== true &&
        !['trajectory', 'terminal', 'browser'].includes(mode.id),
    )
    if (!hasValidNavigation) store.setNavigationView(homeModeId)
  }, [islands, modes, snapshot.activeView, snapshot.navigationView, store])
  const workspace = useProjectWorkspace()
  const [searchOpen, setSearchOpen] = useState(false)
  const closeSearch = useCallback(() => {
    setSearchOpen(false)
  }, [])
  const shellRef = useRef<HTMLDivElement>(null)
  const composerVisible = modes.some(mode => mode.id === snapshot.activeView && mode.showComposer)
  const tabs = useWorkspaceTabs()
  const workTabs = useWorkTabs()
  const activeWorkTab = workTabs.find(tab => tab.active)
  const { groupTabs: activeGroupTabs } = resolveWorkTabGroups(
    workTabs,
    snapshot.projects,
    store.selectedProject()?.id,
  )
  const displayedSplit = tabs?.splitGroups.find(
    group => activeWorkTab !== undefined && group.tabs.includes(activeWorkTab.id),
  )
  const sessionTabsVisible = shouldShowSessionTabs(
    snapshot.navigationCollapsed,
    activeGroupTabs.length,
  )
  // Windows 顶栏右侧由自定义最小化/最大化/关闭按钮占据，单/多标签下均将「新建 / 平铺」留在主区右侧悬浮胶囊内避免误触。
  const floatingTabActions =
    !sessionTabsVisible || document.documentElement.dataset.platform === 'win32'

  const searchTrigger = (
    <button
      className="session-search-trigger"
      type="button"
      aria-label="搜索会话"
      title="搜索会话"
      aria-haspopup="dialog"
      aria-expanded={searchOpen}
      aria-controls="session-search-dialog"
      onClick={() => {
        setSearchOpen(true)
      }}
    >
      <Search size={18} aria-hidden="true" />
    </button>
  )
  const pendingInteraction = snapshot.pendingInteractions[0]
  const panelWidths = {
    '--navigation-expanded-width': `${String(snapshot.navigationWidth)}px`,
    '--information-expanded-width': `${String(snapshot.informationWidth)}px`,
    '--composer-height': `${String(snapshot.composerHeight)}px`,
  } as CSSProperties

  // 主区与左侧栏分开订阅各自视图键；切换顶部标签不改动 navigationView，不会引发侧栏晃动。
  useVerticalViewSlide(shellRef, '.main-island .workspace-island-content', snapshot.activeView)
  useVerticalViewSlide(
    shellRef,
    '.navigation-island > :not(.project-focus)',
    snapshot.navigationView,
  )

  return (
    <>
      {/* 画布与浮岛并列，调整画布透明度时不会让文字和浮岛一起变透明。 */}
      <div className="background-layer" data-floating-layer="canvas" aria-hidden="true" />
      <div
        ref={shellRef}
        className="app-shell"
        style={panelWidths}
        data-workspace-split={displayedSplit !== undefined || undefined}
        data-navigation-collapsed={snapshot.navigationCollapsed || undefined}
        data-information-collapsed={snapshot.informationCollapsed || undefined}
        data-composer-visible={composerVisible || undefined}
        data-session-tabs-visible={sessionTabsVisible}
        data-tab-actions-floating={floatingTabActions}
        data-pending-interaction={pendingInteraction !== undefined || undefined}
        data-panel-capsules-persistent={snapshot.panelCapsulesPersistent || undefined}
      >
        <div className="window-drag-region" aria-hidden="true" />
        <Topbar visible={sessionTabsVisible} floatingActions={floatingTabActions} />
        <LeftPanel searchTrigger={snapshot.navigationCollapsed ? null : searchTrigger} />
        <MainPanel windowControlsInTopbar={sessionTabsVisible} />
        <PanelDividers />
        <div className="project-workspace-alert">
          <ProjectWorkspaceAlert />
          <PluginActions
            name="workspace.alerts"
            scopeKey={store.selectedProject()?.id ?? 'no-project'}
          />
        </div>
        <PluginNotifications />
        <PluginOverlays />
      </div>
      <SessionSearch
        open={searchOpen}
        onClose={closeSearch}
        onSelectSession={sessionId => {
          workspace.selectSession(sessionId, true)
        }}
      />
    </>
  )
}

/**
 * 装配前端状态与界面。WorkspaceStore 管理项目和会话，ProjectWorkspaceProvider 管理
 * 文件编辑及未保存保护，SourceControlProvider 管理 Git 状态，ProjectTasksProvider 管理任务定义与运行请求。
 * 这些 Provider 和全局弹窗位于模式内容之外，切换视图不会重新创建它们。
 */
export default function WorkspacePage() {
  return (
    <AppearanceSystem>
      <ProjectWorkspaceProvider>
        <SourceControlProvider>
          <ProjectTasksProvider>
            <WorkspaceTabsProvider>
              <ConnectionsProvider>
                <WindowStateSync />
                <BrowserAutomationTabSync />
                <DesktopWorkspace />
                <PluginLoader />
                <SettingsDialog />
                <UnsavedChangesDialog />
              </ConnectionsProvider>
            </WorkspaceTabsProvider>
          </ProjectTasksProvider>
        </SourceControlProvider>
      </ProjectWorkspaceProvider>
    </AppearanceSystem>
  )
}
