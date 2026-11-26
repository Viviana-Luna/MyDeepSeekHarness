import { useWorkspaceTabs } from '../../features/workspace-tabs/WorkspaceTabsProvider.tsx'
import type { Context, Plugin } from '@deepseek-ai/cordis'
import { Info, ListTree, MessageSquare } from 'lucide-react'
import { memo, useCallback, useDeferredValue, useMemo, useState, useEffect } from 'react'
import { normalizeSessionEvents } from '../../../../shared/session-projection.ts'
import { ConversationFrame } from '../../features/conversation/ConversationFrame.tsx'
import { TrajectoryView } from '../../features/trajectory/TrajectoryView.tsx'
import { useWorkspaceSnapshot, useWorkspaceStore } from '../../hooks/useWorkspace.ts'
import { ChatLeftPanel } from '../../pages/workspace/components/leftpanel/chat-leftpanel/index.tsx'
import {
  ChatComposer,
  ChatMainPanel,
} from '../../pages/workspace/components/mainpanel/chat-mainpanel/index.tsx'
import {
  ChatRightPanel,
  readChatContext,
} from '../../pages/workspace/components/rightpanel/chat-rightpanel/index.tsx'
import type { IslandPresentationProps } from '../registry.ts'
import { PlanPreview } from '../../features/plan/PlanPreview.tsx'
import { useCompactInformation } from '../../hooks/useCompactInformation.ts'
import { permissionPresetLabel } from '../../domain/session-controls.ts'
import { ConversationTools } from '../../features/conversation/ConversationTools.tsx'

const DeferredTrajectoryView = memo(TrajectoryView)

/** 对话和轨迹共享同一份日志投影，导航更新优先于 Markdown 和历史解析。 */
function useSessionContent() {
  const snapshot = useWorkspaceSnapshot()
  const content = useDeferredValue(snapshot)
  const events = useMemo(() => normalizeSessionEvents(content.history), [content.history])
  const history = useMemo(
    () => (content.liveEvents.length === 0 ? content.history : [...events, ...content.liveEvents]),
    [content.history, content.liveEvents, events],
  )
  return {
    snapshot,
    content,
    history,
    switching: snapshot.selectedSessionId !== content.selectedSessionId,
  }
}
const loading = (
  <section className="workspace-view workspace-empty" role="status" aria-busy="true">
    正在读取会话…
  </section>
)

export function ConversationMain({ placement, visibility }: IslandPresentationProps) {
  const store = useWorkspaceStore()
  const compact = useCompactInformation()
  const { snapshot, content, history, switching } = useSessionContent()
  const focusedSessionId = store.getSnapshot().selectedSessionId
  useEffect(() => {
    if (
      visibility === 'foreground' &&
      snapshot.selectedSessionId !== null &&
      snapshot.selectedSessionId !== focusedSessionId
    )
      return store.observeSession(snapshot.selectedSessionId)
  }, [store, visibility, snapshot.selectedSessionId, focusedSessionId])
  const workTabs = useWorkspaceTabs()
  const grouped =
    snapshot.selectedSessionId !== null && workTabs?.split?.includes(snapshot.selectedSessionId)
  const [view, setView] = useState<'conversation' | 'trajectory'>(() =>
    snapshot.activeView === 'trajectory' ? 'trajectory' : 'conversation',
  )
  const [trajectoryComposerCollapsed, setTrajectoryComposerCollapsed] = useState(false)
  const exportLog = useCallback(
    () => store.exportSelectedSessionLog(snapshot.selectedSessionId),
    [store, snapshot.selectedSessionId],
  )
  const session = content.sessions.find(item => item.sessionId === content.selectedSessionId)
  return (
    <ConversationFrame
      width={view === 'conversation' && placement === 'main' ? snapshot.conversationWidth : null}
      onWidthChange={
        view === 'conversation' && placement === 'main'
          ? width => {
              store.setConversationWidth(width)
            }
          : undefined
      }
      overlayComposer={view === 'conversation'}
    >
      <ConversationTools
        view={view}
        visible={visibility === 'foreground'}
        onViewChange={id => {
          setView(id)
          if (!grouped) store.setView(id)
        }}
      />
      {switching ? (
        loading
      ) : view === 'trajectory' ? (
        <DeferredTrajectoryView
          key={session?.sessionId ?? 'no-session'}
          history={history}
          loading={content.loadingHistory}
          running={session?.running ?? false}
          hasMore={content.historyHasMore}
          loadingOlder={content.loadingOlderHistory}
          onLoadOlder={() => store.loadOlderHistory(snapshot.selectedSessionId)}
          canExport={session !== undefined && snapshot.hostStatus?.kind === 'ready'}
          onExport={exportLog}
          {...(content.historyError === null ? {} : { error: content.historyError })}
        />
      ) : compact &&
        snapshot.activeRightIslandId === 'plan-preview' &&
        snapshot.planPreview?.sessionId === snapshot.selectedSessionId &&
        !snapshot.informationCollapsed ? (
        <PlanPreview compact />
      ) : (
        <ChatMainPanel snapshot={content} liveSnapshot={snapshot} history={history} />
      )}
      <ChatComposer
        collapsible={view === 'trajectory'}
        collapsed={view === 'trajectory' && trajectoryComposerCollapsed}
        onCollapsedChange={setTrajectoryComposerCollapsed}
      />
    </ConversationFrame>
  )
}

function SessionRight() {
  const store = useWorkspaceStore()
  const snapshot = useWorkspaceSnapshot()
  const session = store.selectedSession()
  const project = store.selectedProject()
  const values = session?.projections?.values ?? {}
  const model = snapshot.sessionModels?.current
  const permission = snapshot.sessionPermission
  const metadata =
    session === undefined
      ? []
      : [
          { label: '名称', value: session.title ?? session.name ?? '未命名会话' },
          { label: '状态', value: session.running ? '运行中' : '已停止' },
          { label: '项目', value: project?.name ?? '未选择项目' },
          { label: '工作目录', value: session.cwd ?? project?.cwd ?? '未设置' },
          { label: '模型', value: model === undefined ? '未加载' : model.model },
          ...(model?.reasoningEffort ? [{ label: '推理强度', value: model.reasoningEffort }] : []),
          {
            label: '访问模式',
            value:
              permission === null
                ? '未加载'
                : permissionPresetLabel(
                    permission.currentValue,
                    permission.options.find(option => option.value === permission.currentValue)
                      ?.name ?? permission.currentValue,
                  ),
          },
          { label: '排队消息', value: String(snapshot.sessionQueue.totalCount) },
          {
            label: '更新时间',
            value: new Date(session.updatedAt).toLocaleString('zh-CN', { hour12: false }),
          },
          { label: '会话标识', value: session.sessionId },
        ]
  return (
    <ChatRightPanel
      values={values}
      context={readChatContext(values)}
      metadata={metadata}
      projectScopeKey={store.selectedProject()?.id ?? 'no-project'}
    />
  )
}

function PlanRight() {
  return <PlanPreview />
}

export const sessionUi: Plugin = {
  name: 'mydsh.session-ui',
  inject: ['mydshSlots'],
  apply(ctx: Context) {
    ctx.mydshSlots.registerIsland({
      id: 'plan-preview',
      label: '计划全文',
      icon: ListTree,
      component: PlanRight,
      placements: ['right'],
      scope: 'session',
      ariaLabel: '计划文档',
      contextual: true,
    })
    ctx.mydshSlots.registerIsland({
      id: 'conversation',
      label: '对话',
      icon: MessageSquare,
      component: ConversationMain,
      placements: ['main', 'right'],
      scope: 'session',
      preserveWhenHidden: true,
      order: 0,
    })
    ctx.mydshSlots.registerIsland({
      id: 'trajectory',
      label: '轨迹',
      icon: ListTree,
      component: ConversationMain,
      placements: ['main'],
      scope: 'session',
      order: 1,
    })
    ctx.mydshSlots.registerIsland({
      id: 'session-info',
      label: '会话信息',
      icon: Info,
      component: SessionRight,
      placements: ['right'],
      scope: 'session',
      ariaLabel: '会话信息',
      contextual: true,
      order: 5,
    })
    ctx.mydshSlots.registerMode({
      id: 'conversation',
      label: '对话',
      icon: MessageSquare,
      mainIslandId: 'conversation',
      left: ChatLeftPanel,
      defaultRightIslandId: 'git-history',
      sessionHome: true,
      showComposer: true,
      order: 0,
    })
    ctx.mydshSlots.registerMode({
      id: 'trajectory',
      label: '轨迹',
      icon: ListTree,
      mainIslandId: 'trajectory',
      left: ChatLeftPanel,
      defaultRightIslandId: 'git-history',
      showComposer: true,
      order: 1,
    })
  },
}
