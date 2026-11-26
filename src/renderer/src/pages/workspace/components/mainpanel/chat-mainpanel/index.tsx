import { ChevronDown, ChevronUp } from 'lucide-react'
import { memo, useCallback, useRef } from 'react'
import type { WorkspaceSnapshot } from '../../../../../models/workspace/store.ts'
import { useWorkspaceSnapshot, useWorkspaceStore } from '../../../../../hooks/useWorkspace.ts'
import { useElementWidthAtLeast } from '../../../../../hooks/useElementWidth.ts'
import { useProjectWorkspace } from '../../../../../features/project-workspace/ProjectWorkspaceProvider.tsx'
import { ConversationView } from '../../../../../features/conversation/ConversationView.tsx'
import { EmptyConversation } from '../../../../../features/conversation/EmptyConversation.tsx'
import { Composer } from '../../../../../features/composer/Composer.tsx'
import { ComposerTodos } from '../../../../../features/composer/ComposerTodos.tsx'
import { parseHubTodos } from '../../../../../domain/session-hub.ts'
import { PendingInteractionPanel } from '../../../../../features/composer/PendingInteractionPanel.tsx'
import { ElasticPress } from '../../../../../shared/ui/ElasticPress.tsx'
import { ComposerDivider } from '../../PanelDividers.tsx'
import { SessionPresetPicker } from '../../rightpanel/chat-rightpanel/SessionPresetPicker.tsx'

/** 聊天主面板使用区域入口合并后的 Session 历史，选择和消息操作仍由原 Store 持有。 */
export const ChatMainPanel = memo(function ChatMainPanel({
  history,
  snapshot,
  liveSnapshot = snapshot,
}: {
  history: unknown
  snapshot: WorkspaceSnapshot
  liveSnapshot?: WorkspaceSnapshot
}) {
  const store = useWorkspaceStore()
  const projectWorkspace = useProjectWorkspace()
  const { openFileFromConversation } = projectWorkspace
  const openFileMain = useCallback(
    (relativePath: string, line?: number) => {
      void openFileFromConversation(relativePath, line)
    },
    [openFileFromConversation],
  )
  const session = snapshot.sessions.find(item => item.sessionId === snapshot.selectedSessionId)
  const project = snapshot.projects.find(item => item.id === snapshot.selectedProjectId)
  const newSessionDraftActive = project !== undefined && snapshot.newSessionProjectId === project.id
  if (session === undefined) {
    if (newSessionDraftActive && liveSnapshot.sendingNewSession)
      return <ConversationView history={[]} pendingSend />
    return (
      <EmptyConversation
        title={newSessionDraftActive ? `在 ${project.name} 中开始新会话` : '从一个项目聊天开始'}
        description={
          newSessionDraftActive
            ? '输入并发送第一条消息后才会创建会话。'
            : '选择左侧已有聊天，或在当前项目中新建聊天。'
        }
      />
    )
  }
  return (
    <ConversationView
      emptyState={
        <EmptyConversation
          title="这个对话还没有消息"
          description="在下方输入任务，开始这段对话。"
          preset={<SessionPresetPicker variant="pills" />}
        />
      }
      onOpenPlan={(id, text) => {
        store.openPlanPreview(session.sessionId, id, text)
      }}
      history={history}
      turnOutline={historyTurnOutline(snapshot.history) ?? session.projections?.values?.turnOutline}
      sessionId={session?.sessionId ?? null}
      scrollPositions={store.conversationScrollPositions}
      queue={snapshot.sessionQueue}
      running={
        liveSnapshot.sessions.find(item => item.sessionId === session.sessionId)?.running ===
          true ||
        liveSnapshot.awaitingResponseSessionIds.includes(session.sessionId) ||
        (liveSnapshot.selectedSessionId === session.sessionId && liveSnapshot.sendingMessage)
      }
      pendingSend={liveSnapshot.awaitingResponseSessionIds.includes(session.sessionId)}
      loading={snapshot.loadingHistory}
      loadingOlder={snapshot.loadingOlderHistory}
      hasMore={snapshot.historyHasMore}
      {...(snapshot.historyError === null ? {} : { error: snapshot.historyError })}
      onLoadOlder={() => store.loadOlderHistory(session.sessionId)}
      queueUpdatingIds={snapshot.queueUpdatingIds}
      onUpdateQueue={(itemId, action) =>
        store.updateSessionQueue(itemId, action, session.sessionId)
      }
      onListMessageFeedback={sessionId => store.listMessageFeedback(sessionId)}
      onPutMessageFeedback={(sessionId, messageId, rating, ifVersion) =>
        store.putMessageFeedback(sessionId, messageId, rating, ifVersion)
      }
      onDeleteMessageFeedback={(sessionId, messageId, ifVersion) =>
        store.deleteMessageFeedback(sessionId, messageId, ifVersion)
      }
      projectCwd={session.cwd}
      onOpenFile={openFileMain}
    />
  )
})

function historyTurnOutline(history: unknown): unknown {
  if (typeof history !== 'object' || history === null || !('projections' in history))
    return undefined
  const projections = history.projections
  if (typeof projections !== 'object' || projections === null || !('values' in projections))
    return undefined
  const values = projections.values
  return typeof values === 'object' && values !== null && 'turnOutline' in values
    ? values.turnOutline
    : undefined
}

/** 读数条整条保留所需的最小 dock 宽度：仅图标形态约 116px，180 留出居中余量；
 *  更早的文字降级由 ComposerStatus.module.css 的容器查询按同一 dock 宽度处理。 */
const READINGS_DOCK_MIN_WIDTH = 180

function ComposerCollapseToggle({
  collapsed,
  onToggle,
}: {
  readonly collapsed: boolean
  readonly onToggle: () => void
}) {
  const label = collapsed ? '展开输入框' : '收起输入框'
  return (
    <div className={`composer-dock__toggle-slot${collapsed ? ' is-collapsed' : ''}`}>
      <ElasticPress>
        <button
          type="button"
          className={`composer-dock__toggle${collapsed ? ' is-collapsed' : ''}`}
          aria-label={label}
          aria-expanded={!collapsed}
          title={label}
          onClick={onToggle}
        >
          {collapsed ? (
            <ChevronUp size={13} aria-hidden="true" />
          ) : (
            <ChevronDown size={13} aria-hidden="true" />
          )}
          <span>{label}</span>
        </button>
      </ElasticPress>
    </div>
  )
}

/**
 * 输入区与待响应交互共用位置，由对话或轨迹中央区域持有。
 *
 * 会话仪表盘在两种平台始终保留，按输入区宽度收起次要文字，不受右侧栏显隐影响。
 * 轨迹视图允许手动收起输入区，但收到待响应交互时必须重新呈现以免遗漏审批。
 */
export function ChatComposer({
  collapsible = false,
  collapsed = false,
  onCollapsedChange,
}: {
  readonly collapsible?: boolean
  readonly collapsed?: boolean
  readonly onCollapsedChange?: (collapsed: boolean) => void
} = {}) {
  const snapshot = useWorkspaceSnapshot()
  const dockRef = useRef<HTMLDivElement>(null)
  const dockFitsReadings = useElementWidthAtLeast(dockRef, READINGS_DOCK_MIN_WIDTH)
  const pendingInteraction = snapshot.pendingInteractions[0]
  const showReadings = dockFitsReadings
  const session = snapshot.sessions.find(item => item.sessionId === snapshot.selectedSessionId)
  const todos = parseHubTodos(session?.projections?.values?.todos)
  const effectiveCollapsed = collapsible && collapsed && pendingInteraction === undefined
  const toggle = () => {
    const next = !effectiveCollapsed
    onCollapsedChange?.(next)
    if (!next) {
      requestAnimationFrame(() => {
        dockRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus()
      })
    }
  }
  return (
    <div
      className={`composer-dock${effectiveCollapsed ? ' composer-dock--collapsed' : ''}`}
      data-composer-collapsed={effectiveCollapsed ? 'true' : undefined}
      ref={dockRef}
    >
      {collapsible && pendingInteraction === undefined && (
        <ComposerCollapseToggle collapsed={effectiveCollapsed} onToggle={toggle} />
      )}
      {!effectiveCollapsed && (
        <>
          {todos.length > 0 && <ComposerTodos key={session?.sessionId} todos={todos} />}
          {pendingInteraction === undefined ? (
            <Composer showReadings={showReadings} />
          ) : (
            <PendingInteractionPanel
              interaction={pendingInteraction}
              key={`${snapshot.selectedSessionId}:${pendingInteraction.key}`}
            />
          )}
          {pendingInteraction === undefined && <ComposerDivider />}
        </>
      )}
    </div>
  )
}
