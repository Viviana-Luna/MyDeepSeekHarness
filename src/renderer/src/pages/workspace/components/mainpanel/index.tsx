import { useEffect } from 'react'
import { useWorkspaceSnapshot, useWorkspaceStore } from '../../../../hooks/useWorkspace.ts'
import { useCompactInformation } from '../../../../hooks/useCompactInformation.ts'
import {
  contributionKey,
  PluginBoundary,
  useIslands,
  useModes,
} from '../../../../plugins/react.tsx'
import type {
  IslandContribution,
  IslandPlacement,
  IslandVisibility,
} from '../../../../plugins/registry.ts'
import { useWorkTabs } from '../../../../features/workspace-tabs/useWorkTabs.ts'
import { WorkTabPanels } from '../../../../features/workspace-tabs/WorkTabPanels.tsx'
import { RightIslandTabs } from '../rightpanel/index.tsx'
import { WindowControls } from '../../../../features/window/WindowControls.tsx'

function scopeKey(
  island: IslandContribution,
  sessionId: string | null,
  projectId: string | null,
): string {
  if (island.scope === 'session') return sessionId ?? 'no-session'
  if (island.scope === 'project') return projectId ?? 'no-project'
  return 'window'
}

/**
 * 主区和右侧共用这一棵稳定实例树。位置变化只改外壳的网格位置与呈现属性，
 * 不把文件编辑器、对话或终端搬到另一个 React 父节点。
 */
export function MainPanel({
  windowControlsInTopbar = false,
}: {
  windowControlsInTopbar?: boolean
}) {
  const workTabs = useWorkTabs()
  const hasActiveTab = workTabs.some(tab => tab.active)
  const store = useWorkspaceStore()
  const snapshot = useWorkspaceSnapshot()
  const compact = useCompactInformation()
  const controlsInMain = !windowControlsInTopbar && (compact || snapshot.informationCollapsed)
  const controlsInRight = !windowControlsInTopbar && !controlsInMain
  const workTabsAvailable =
    [
      'conversation',
      'trajectory',
      'files',
      'terminal',
      'browser',
      'changes',
      'connections',
    ].includes(snapshot.activeView) && hasActiveTab
  const modes = useModes()
  const islands = useIslands()
  const mode = modes.find(item => item.id === snapshot.activeView)
  const islandById = new Map(islands.map(island => [island.id, island]))
  const mainCandidate = islandById.get(mode?.mainIslandId ?? '')
  const mainIsland = mainCandidate?.placements.includes('main') ? mainCandidate : undefined
  const rightIslands = islands.filter(
    island =>
      island.placements.includes('right') &&
      !island.contextual &&
      !['conversation', 'terminal', 'browser', 'session-info'].includes(island.id),
  )
  const defaultRightCandidate = islandById.get(mode?.defaultRightIslandId ?? '')
  const defaultRight =
    defaultRightCandidate?.placements.includes('right') && !defaultRightCandidate.contextual
      ? defaultRightCandidate
      : undefined
  const requestedRightCandidate = islandById.get(snapshot.activeRightIslandId ?? '')
  const requestedRight =
    requestedRightCandidate &&
    (rightIslands.includes(requestedRightCandidate) ||
      (requestedRightCandidate.contextual && requestedRightCandidate.id !== 'session-info'))
      ? requestedRightCandidate
      : undefined
  const activeRight =
    (requestedRight?.id === mainIsland?.id ? undefined : requestedRight) ??
    (defaultRight?.id === mainIsland?.id ? undefined : defaultRight) ??
    rightIslands.find(island => island.id !== mainIsland?.id)

  const firstRightIslandId = rightIslands[0]?.id
  useEffect(() => {
    if (!snapshot.rightIslandsInitialized) {
      store.initializeRightIsland(defaultRight?.id ?? firstRightIslandId ?? null)
    }
  }, [defaultRight?.id, firstRightIslandId, snapshot.rightIslandsInitialized, store])

  const instantiated = islands.filter(
    island =>
      island.id === mainIsland?.id ||
      island.id === activeRight?.id ||
      island.preserveWhenHidden === true,
  )

  return (
    <>
      <WorkTabPanels showWindowControls={controlsInMain && workTabsAvailable} />
      {instantiated
        .filter(
          island =>
            island.id !== 'browser' &&
            !(
              hasActiveTab &&
              ['conversation', 'trajectory', 'files', 'changes', 'browser'].includes(island.id)
            ),
        )
        .map(island => {
          const resourceHost = [
            'conversation',
            'trajectory',
            'files',
            'changes',
            'browser',
          ].includes(island.id)
          const showsSshTab =
            island.id === 'connections' && snapshot.activeView === 'connections' && hasActiveTab
          const main =
            island.id === mainIsland?.id && !(hasActiveTab && resourceHost) && !showsSshTab
          const right = !main && island.id === activeRight?.id
          const placement: IslandPlacement = main
            ? 'main'
            : island.placements.includes('right')
              ? 'right'
              : 'main'
          const visibility: IslandVisibility = main || (right && !compact) ? 'foreground' : 'hidden'
          const View = island.component
          const parked = !main && !right
          return (
            <section
              key={`${String(contributionKey(island))}:${scopeKey(island, snapshot.selectedSessionId, snapshot.selectedProjectId)}`}
              id={main ? 'session-workspace' : right ? 'session-inspector' : undefined}
              role={right && !island.contextual ? 'tabpanel' : undefined}
              className={`island workspace-island${main ? ' main-island' : right ? ` info-island${island.className ? ` ${island.className}` : ''}` : ' workspace-island--parked'}`}
              aria-label={
                main
                  ? (island.ariaLabel ?? island.label)
                  : right
                    ? (activeRight?.ariaLabel ?? activeRight?.label)
                    : undefined
              }
              hidden={parked || (right && compact) || (hasActiveTab && island.id === 'terminal')}
              inert={parked || (right && (compact || snapshot.informationCollapsed))}
              data-placement={main ? 'main' : right ? 'right' : 'parked'}
            >
              {((right && controlsInRight) || (main && !workTabsAvailable && controlsInMain)) && (
                <WindowControls />
              )}
              {right && !island.contextual && (
                <div className="workspace-island-toolbar">
                  <RightIslandTabs
                    islands={rightIslands}
                    activeIsland={activeRight}
                    mainIslandId={mainIsland?.id}
                  />
                </div>
              )}
              <div className="workspace-island-content" data-placement={placement}>
                <PluginBoundary name={island.label}>
                  <View
                    placement={placement}
                    visibility={visibility}
                    selectionRevision={
                      snapshot.rightIslandSelectionRequest?.islandId === island.id
                        ? snapshot.rightIslandSelectionRequest.revision
                        : 0
                    }
                  />
                </PluginBoundary>
              </div>
            </section>
          )
        })}
      {mainIsland?.id === 'browser' && !hasActiveTab && (
        <main className="island main-island">
          {controlsInMain && <WindowControls />}
          <section className="workspace-view workspace-empty">
            <strong>没有打开的网页</strong>
            <p>从顶部新建菜单打开浏览器标签。</p>
          </section>
        </main>
      )}
      {mainIsland === undefined && (
        <main className="island main-island">
          {controlsInMain && <WindowControls />}
          <section role="alert" className="workspace-empty">
            <strong>当前模式暂时不可用</strong>
            <p>它引用的中央浮岛尚未加载。</p>
          </section>
        </main>
      )}
      {activeRight === undefined && (
        <aside className="island info-island">
          {controlsInRight && <WindowControls />}
          <section role="status" className="workspace-empty">
            <strong>没有可用的右侧浮岛</strong>
          </section>
        </aside>
      )}
    </>
  )
}
