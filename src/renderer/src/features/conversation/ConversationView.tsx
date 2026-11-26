import {
  ArrowDown,
  AlertCircle,
  BookOpen,
  Check,
  ChevronRight,
  Copy,
  FileCode2,
  FileText,
  Globe,
  Search,
  Sparkles,
  TerminalSquare,
  ThumbsDown,
  ThumbsUp,
  Wrench,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type UIEventHandler,
} from 'react'
import { PluginToolResult } from '../../plugins/react.tsx'
import { MessageMarkdown, type MessageMarkdownProps } from './MessageMarkdown.tsx'
import { writeClipboard } from './clipboard.ts'

import {
  normalizeSessionEvents,
  projectConversation,
} from '../../../../shared/session-projection.js'
import type {
  DesktopMessageFeedbackItem,
  DesktopMessageFeedbackList,
  DesktopMessageFeedbackMutationResult,
  DesktopMessageFeedbackRating,
} from '../../../../shared/message-feedback.js'
import type {
  ConversationAssistantContentBlock,
  ConversationContextItem,
  ConversationCommandItem,
  ConversationProjectionItem,
  ConversationRetryState,
  ConversationToolItem,
} from '../../../../shared/session-projection.js'
import type {
  DesktopQueueSnapshot,
  DesktopSessionQueueAction,
} from '../../../../shared/session-live.ts'
import { EMPTY_DESKTOP_QUEUE_SNAPSHOT } from '../../../../shared/session-live.ts'
import { QueueDock } from './QueueDock.tsx'
import { SessionImage } from './SessionImage.tsx'
import { PixelMatrix } from './PixelMatrix.tsx'
import { useRotatingLoadingQuip } from './loading-quips.ts'
import { AnimatedSummary } from './AnimatedSummary.tsx'
import { formatToolSummary, stripMarkdownInline } from './tool-summary.ts'
import { describeToolPatch, ToolPatchPreview } from './ToolPatchPreview.tsx'
import { useConversationScroll, type ConversationScrollPosition } from './useConversationScroll.ts'
import { ConversationNavigator } from './ConversationNavigator.tsx'
import styles from './ConversationView.module.css'
import { planFromTool, planSummary } from '../plan/plan-review.ts'
import planStyles from '../plan/PlanReview.module.css'

export interface ConversationViewProps {
  readonly pendingSend?: boolean
  readonly emptyState?: ReactNode
  readonly onOpenPlan?: (id: string, text: string) => void
  readonly history: unknown
  readonly turnOutline?: unknown
  readonly sessionId?: string | null
  readonly scrollPositions?: Map<string, ConversationScrollPosition>
  readonly queue?: DesktopQueueSnapshot
  readonly running?: boolean
  readonly loading?: boolean
  readonly loadingOlder?: boolean
  readonly hasMore?: boolean
  readonly error?: string
  readonly onLoadOlder?: () => Promise<boolean>
  readonly queueUpdatingIds?: readonly string[]
  readonly onUpdateQueue?: (itemId: string, action: DesktopSessionQueueAction) => Promise<boolean>
  readonly onListMessageFeedback?: (sessionId: string) => Promise<DesktopMessageFeedbackList>
  readonly onPutMessageFeedback?: (
    sessionId: string,
    messageId: string,
    rating: DesktopMessageFeedbackRating,
    ifVersion: string | null,
  ) => Promise<DesktopMessageFeedbackMutationResult>
  readonly onDeleteMessageFeedback?: (
    sessionId: string,
    messageId: string,
    ifVersion: string,
  ) => Promise<DesktopMessageFeedbackMutationResult>
  readonly projectCwd?: string | undefined
  readonly onOpenFile?: (relativePath: string, line?: number) => void | Promise<void>
  readonly onOpenFileInMain?: (relativePath: string, line?: number) => void | Promise<void>
}

const OLDER_HISTORY_PRELOAD_THRESHOLD = 160

type MessageFeedbackStatus = 'cold' | 'loading' | 'ready' | 'unavailable'

interface MessageActionNotice {
  readonly messageKey: string
  readonly text: string
}

function formatTime(time: number): string {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(time)
  } catch {
    return '时间未知'
  }
}

function isoTime(time: number): string | undefined {
  try {
    return new Date(time).toISOString()
  } catch {
    return undefined
  }
}

function itemKey(item: ConversationProjectionItem): string {
  if (item.type === 'assistant' && item.turn !== null && item.step !== null) {
    return `assistant-${String(item.turn)}-${String(item.step)}`
  }
  if (item.type === 'tool' && item.callId !== null) return `tool-${item.callId}`
  if (item.type === 'command') return `command-${item.commandId}`
  return `${item.type}-${String(item.seq)}`
}

function itemRevision(item: ConversationProjectionItem): number {
  return item.type === 'assistant' || item.type === 'tool' || item.type === 'command'
    ? item.latestSeq
    : item.seq
}

function ReplyActivity({ waiting, retry }: { waiting: boolean; retry?: ConversationRetryState }) {
  const quip = useRotatingLoadingQuip(retry === undefined)
  if (retry)
    return (
      <div
        className={styles.retryStatus}
        data-model-retry={retry.started ? 'requesting' : 'waiting'}
      >
        <span role="status" aria-live="polite">
          <PixelMatrix />
          正在重试请求（{retry.attempt}
          {retry.maxAttempts === undefined ? '' : ` / ${retry.maxAttempts}`}）
        </span>
        <span>
          {retry.started ? '已重新发送，正在等待响应。' : `将在 ${formatTime(retry.nextAt)} 重试。`}
          可使用停止按钮取消。
        </span>
        <details>
          <summary>查看上次失败原因</summary>
          <p>{retry.message}</p>
        </details>
      </div>
    )
  return (
    <span className={styles.replyActivity} role="status" aria-live="polite">
      <PixelMatrix />
      <span className="visually-hidden">{waiting ? '正在构思回复…' : '生成中'}</span>
      <span key={quip} className={styles.replyText} data-loading-quip="true" aria-hidden="true">
        {quip}
      </span>
    </span>
  )
}

function ThinkingDisclosure({
  text,
  active,
  ...markdown
}: { active: boolean } & MessageMarkdownProps) {
  const [open, setOpen] = useState(false)
  const lines = text
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(Boolean)
  const preview = stripMarkdownInline((active ? lines.at(-1) : lines[0]) ?? text.trim())

  return (
    <details
      className={styles.thinking}
      data-active={String(active)}
      data-thinking-disclosure="true"
      onToggle={event => {
        setOpen(event.currentTarget.open)
      }}
    >
      <summary title={preview}>
        <span className={styles.disclosureLeading} aria-hidden="true">
          {active ? <PixelMatrix variant="star" /> : <Sparkles size={14} />}
        </span>
        <span className={styles.thinkingLabel}>Think</span>
        <span className={styles.disclosureSeparator} aria-hidden="true" />
        <span className={styles.thinkingPreview} data-thinking-preview="">
          {preview}
        </span>
        <ChevronRight className={styles.trailingChevron} size={13} aria-hidden="true" />
        {active ? (
          <span className="visually-hidden" role="status" aria-live="polite">
            正在思考…
          </span>
        ) : (
          <span className="visually-hidden">思考完成</span>
        )}
      </summary>
      {open && (
        <div className={styles.thinkingBody}>
          <MessageMarkdown text={text} {...markdown} streaming={active} />
        </div>
      )}
    </details>
  )
}

const CONTEXT_TEXT_LIMIT = 20_000
const CONTEXT_ENTRY_LIMIT = 200

function boundedContextText(text: string): string {
  return text.length <= CONTEXT_TEXT_LIMIT
    ? text
    : `${text.slice(0, CONTEXT_TEXT_LIMIT)}\n内容过长，已显示前 ${String(CONTEXT_TEXT_LIMIT)} 个字符。`
}

function ContextBody({ item }: { item: ConversationContextItem }) {
  if (item.form === 'snapshot' && item.sections !== undefined) {
    return (
      <div className={styles.contextBody}>
        <p className={styles.contextCaption}>这份完整快照取代此前的运行时上下文。</p>
        <dl className={styles.contextSections}>
          {item.sections.map((section, index) => (
            <div key={`${section.name}-${String(index)}`}>
              <dt>{section.name}</dt>
              <dd>{boundedContextText(section.text)}</dd>
            </div>
          ))}
        </dl>
      </div>
    )
  }

  if (item.form === 'catalog' && item.entries !== undefined) {
    const shown = item.entries.slice(0, CONTEXT_ENTRY_LIMIT)
    return (
      <div className={styles.contextBody}>
        <ul className={styles.contextEntries}>
          {shown.map((entry, index) => (
            <li key={`${entry.name}-${String(index)}`}>
              <code>{entry.name}</code>
              <span>{entry.description}</span>
            </li>
          ))}
        </ul>
        {shown.length < item.entries.length && (
          <p className={styles.contextCaption}>
            另有 {String(item.entries.length - shown.length)} 项未展开显示。
          </p>
        )}
      </div>
    )
  }

  return (
    <div className={styles.contextBody}>
      {item.paths !== undefined && item.paths.length > 0 && (
        <p className={styles.contextCaption}>{item.paths.join('、')}</p>
      )}
      <pre>{boundedContextText(item.text)}</pre>
    </div>
  )
}

function ContextDisclosure({ item }: { item: ConversationContextItem }) {
  const title = item.role === 'recall' ? '上下文回忆' : '上下文注入'
  return (
    <details
      className={`${styles.eventDisclosure} ${styles.contextDisclosure}`}
      data-context-disclosure="true"
    >
      <summary title={item.sourceLabel ?? title}>
        <span className={styles.disclosureLeading} aria-hidden="true">
          <BookOpen className={styles.disclosureIcon} size={14} />
          <ChevronRight className={styles.disclosureChevron} size={14} />
        </span>
        <span className={styles.disclosureTitle}>{title}</span>
        {item.sourceLabel !== null && (
          <>
            <span className={styles.disclosureSeparator} aria-hidden="true" />
            <span className={styles.disclosureSummary}>{item.sourceLabel}</span>
          </>
        )}
        {item.summary !== null && (
          <>
            <span className={styles.disclosureSeparator} aria-hidden="true" />
            <span className={styles.disclosureSummary}>{item.summary}</span>
          </>
        )}
      </summary>
      <ContextBody item={item} />
    </details>
  )
}

function toolTitle(name: string | null): string {
  if (name === null) return '工具'
  const normalized = name.toLowerCase()
  if (normalized.includes('bash') || normalized.includes('shell')) return 'Bash'
  if (normalized === 'read' || normalized.includes('read_file')) return 'Read'
  if (normalized === 'write' || normalized.includes('write_file')) return 'Write'
  if (normalized.includes('edit') || normalized.includes('replace')) return 'Edit'
  if (normalized.includes('grep') || normalized.includes('glob') || normalized.includes('search'))
    return 'Search'
  if (normalized.includes('web') || normalized.includes('fetch')) return 'Web'
  return name
}

function toolFallbackSummary(item: ConversationToolItem): string {
  if (item.summary.length > 0) return item.summary
  if (item.status === 'running') return '正在运行…'
  if (item.status === 'interrupted') return '已中断'
  if (item.status === 'error') return '调用失败'
  return '已完成'
}

function ToolIcon({ item }: { item: ConversationToolItem }) {
  const title = toolTitle(item.name)
  if (item.status === 'running')
    return <PixelMatrix variant={title === 'Search' || title === 'Web' ? 'scan' : 'wave'} />
  const Icon =
    item.status === 'error' || item.status === 'interrupted'
      ? AlertCircle
      : title === 'Search'
        ? Search
        : title === 'Web'
          ? Globe
          : title === 'Read'
            ? FileText
            : title === 'Write' || title === 'Edit' || /patch/iu.test(title)
              ? FileCode2
              : title === 'Bash'
                ? TerminalSquare
                : Wrench
  return <Icon size={14} />
}

function ToolDisclosure({
  item,
  sessionId,
  onOpenPlan,
}: {
  item: ConversationToolItem
  sessionId: string | null
  onOpenPlan?: ConversationViewProps['onOpenPlan']
}) {
  const plan = planFromTool(item)
  if (plan !== null && onOpenPlan !== undefined)
    return (
      <button
        className={planStyles.history}
        type="button"
        data-plan-history={item.callId ?? String(item.seq)}
        aria-label={`查看计划：${planSummary(plan).title}`}
        onClick={() => {
          onOpenPlan(item.callId ?? String(item.seq), plan)
        }}
      >
        <BookOpen size={16} aria-hidden="true" />
        <span>{planSummary(plan).title}</span>
        <ChevronRight size={14} aria-hidden="true" />
      </button>
    )
  const summary =
    describeToolPatch(item.name, item.argumentsText) ??
    formatToolSummary(item.name, item.argumentsText, toolFallbackSummary(item))
  const hasDetails = item.argumentsText !== null || item.resultText !== null
  return (
    <details
      className={`${styles.eventDisclosure} ${styles.toolDisclosure}`}
      data-state={item.status}
      data-error={item.isError || undefined}
      data-tool-disclosure="true"
    >
      <summary title={summary}>
        <span className={styles.disclosureLeading} aria-hidden="true">
          <ToolIcon item={item} />
        </span>
        <span className={styles.disclosureTitle}>{toolTitle(item.name)}</span>
        <span className={styles.disclosureSeparator} aria-hidden="true" />
        <span className={styles.disclosureSummary}>
          <AnimatedSummary text={summary} active={item.status === 'running'} />
        </span>
        <ChevronRight className={styles.trailingChevron} size={13} aria-hidden="true" />
        {item.status === 'running' && (
          <span className="visually-hidden" role="status" aria-live="polite">
            工具正在运行
          </span>
        )}
      </summary>
      <ToolPatchPreview toolName={item.name} argumentsText={item.argumentsText} />
      {hasDetails ? (
        <dl className={styles.toolBody}>
          {item.argumentsText !== null && (
            <div>
              <dt>输入</dt>
              <dd>{item.argumentsText}</dd>
            </div>
          )}
          {item.resultText !== null && (
            <div>
              <dt>输出</dt>
              <dd
                className={styles.toolResult}
                data-tool-result="true"
                data-error={item.isError || undefined}
              >
                <PluginToolResult
                  item={item}
                  scopeKey={`${sessionId ?? 'no-session'}:${item.callId ?? String(item.seq)}`}
                  fallback={item.resultText}
                />
              </dd>
            </div>
          )}
        </dl>
      ) : (
        <p className={styles.toolEmpty}>这个调用没有可展开的输入或输出。</p>
      )}
    </details>
  )
}

function CommandDisclosure({ item }: { item: ConversationCommandItem }) {
  const [open, setOpen] = useState(false)
  const summary =
    item.summary ??
    (item.status === 'running'
      ? item.name === 'compact'
        ? '正在压缩…'
        : '执行中…'
      : item.status === 'error'
        ? '执行失败'
        : '已完成')
  return (
    <div
      className={styles.commandDisclosure}
      data-command-id={item.commandId}
      data-command-name={item.name}
      data-state={item.status}
      data-error={item.status === 'error' || undefined}
    >
      <button
        type="button"
        className={styles.commandRow}
        aria-expanded={item.details === null ? undefined : open}
        aria-disabled={item.details === null}
        title={summary}
        onClick={() => {
          if (item.details !== null) setOpen(value => !value)
        }}
      >
        <span className={styles.disclosureLeading} aria-hidden="true">
          {item.status === 'error' ? <AlertCircle size={14} /> : <TerminalSquare size={14} />}
        </span>
        <span className={styles.disclosureTitle}>{item.name ?? '命令'}</span>
        <span className={styles.disclosureSeparator} aria-hidden="true" />
        <span className={styles.disclosureSummary}>{summary.split(/\r?\n/u)[0]}</span>
        {item.details !== null && (
          <ChevronRight
            size={14}
            className={open ? styles.commandChevronOpen : undefined}
            aria-hidden="true"
          />
        )}
      </button>
      {open && item.details !== null && <pre className={styles.commandBody}>{item.details}</pre>}
    </div>
  )
}

function assistantBlocks(
  item: Extract<ConversationProjectionItem, { readonly type: 'assistant' }>,
): readonly ConversationAssistantContentBlock[] {
  return (
    item.blocks ??
    (item.text.length === 0
      ? []
      : [{ type: 'text', index: 0, text: item.text, complete: item.status !== 'streaming' }])
  )
}

/** 正常结束后确定最终回答；中间回复没有消息操作，有过程内容时才提供折叠入口。 */
function completedTurns(history: unknown, items: readonly ConversationProjectionItem[]) {
  const completed = new Set<number>()
  for (const event of normalizeSessionEvents(history)) {
    const data = event.data as { turn?: number; reason?: { kind?: string } } | null
    if (
      event.type === 'turn/end' &&
      typeof data?.turn === 'number' &&
      data.reason?.kind === 'completed'
    ) {
      completed.add(data.turn)
    }
  }
  const turns = new Map<
    number,
    (ConversationToolItem | Extract<ConversationProjectionItem, { type: 'assistant' }>)[]
  >()
  for (const item of items) {
    if (
      item.turn === null ||
      !completed.has(item.turn) ||
      (item.type !== 'tool' && item.type !== 'assistant')
    )
      continue
    const members = turns.get(item.turn) ?? []
    members.push(item)
    turns.set(item.turn, members)
  }
  const result = new Map<number, { firstSeq: number; answerSeq: number; label: string | null }>()
  for (const [turn, members] of turns) {
    const last = members.at(-1)
    const answer =
      last?.type === 'assistant' && last.status === 'settled' && last.text.trim() !== ''
        ? last
        : null
    if (answer === null) continue
    const tools = members.filter(item => item.type === 'tool').length
    const messages = members.filter(item => item.type === 'assistant' && item !== answer).length
    const label =
      [
        tools > 0 ? `${String(tools)} 次工具调用` : '',
        messages > 0 ? `${String(messages)} 条消息` : '',
      ]
        .filter(Boolean)
        .join(' · ') ||
      (answer.blocks?.some(block => block.type === 'reasoning') ? '思考过程' : null)
    result.set(turn, { firstSeq: members[0]!.seq, answerSeq: answer.seq, label })
  }
  return result
}

function MessageActions({
  messageKey,
  text,
  time,
  copied,
  notice,
  feedback,
  feedbackStatus,
  feedbackItem,
  feedbackUpdating,
  onCopy,
  onEnsureFeedback,
  onToggleFeedback,
}: {
  messageKey: string
  text: string
  time: number
  copied: boolean
  notice: string | null
  feedback?: { readonly messageId: string }
  feedbackStatus: MessageFeedbackStatus
  feedbackItem: DesktopMessageFeedbackItem | undefined
  feedbackUpdating: boolean
  onCopy(messageKey: string, text: string): Promise<void>
  onEnsureFeedback(): Promise<boolean>
  onToggleFeedback(
    messageKey: string,
    messageId: string,
    rating: DesktopMessageFeedbackRating,
  ): void
}) {
  const feedbackReady = feedback !== undefined && feedbackStatus === 'ready'
  const likeLabel = feedbackItem?.rating === 'positive' ? '取消标记' : '好的回答'
  const dislikeLabel = feedbackItem?.rating === 'negative' ? '取消标记' : '有问题的回答'
  const ensureFeedback =
    feedback === undefined
      ? undefined
      : () => {
          void onEnsureFeedback()
        }
  return (
    <div
      className={styles.messageActions}
      aria-label="消息操作"
      {...(ensureFeedback === undefined
        ? {}
        : { onMouseEnter: ensureFeedback, onFocusCapture: ensureFeedback })}
    >
      <button
        className={styles.messageAction}
        type="button"
        aria-label={copied ? '已复制' : '复制'}
        title={copied ? '已复制' : '复制'}
        onClick={() => {
          void onCopy(messageKey, text)
        }}
      >
        {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
      </button>
      {feedbackReady && feedback !== undefined && (
        <>
          <button
            className={styles.messageAction}
            type="button"
            aria-label={likeLabel}
            title={likeLabel}
            aria-pressed={feedbackItem?.rating === 'positive'}
            disabled={feedbackUpdating}
            onClick={() => {
              onToggleFeedback(messageKey, feedback.messageId, 'positive')
            }}
          >
            <ThumbsUp size={16} aria-hidden="true" />
          </button>
          <button
            className={styles.messageAction}
            type="button"
            aria-label={dislikeLabel}
            title={dislikeLabel}
            aria-pressed={feedbackItem?.rating === 'negative'}
            disabled={feedbackUpdating}
            onClick={() => {
              onToggleFeedback(messageKey, feedback.messageId, 'negative')
            }}
          >
            <ThumbsDown size={16} aria-hidden="true" />
          </button>
        </>
      )}
      {notice !== null && (
        <span className={styles.messageActionNotice} role="status">
          {notice}
        </span>
      )}
      <time className={styles.messageTime} dateTime={isoTime(time)}>
        {formatTime(time)}
      </time>
    </div>
  )
}

export function ConversationView({
  emptyState,
  pendingSend = false,
  onOpenPlan,
  history,
  turnOutline,
  sessionId = null,
  scrollPositions,
  queue = EMPTY_DESKTOP_QUEUE_SNAPSHOT,
  running = false,
  loading = false,
  loadingOlder = false,
  hasMore = false,
  error,
  onLoadOlder,
  queueUpdatingIds = [],
  onUpdateQueue = async () => false,
  onListMessageFeedback,
  onPutMessageFeedback,
  onDeleteMessageFeedback,
  projectCwd,
  onOpenFile,
  onOpenFileInMain,
}: ConversationViewProps) {
  const items = useMemo(() => projectConversation(history, { running }), [history, running])
  const completed = useMemo(() => completedTurns(history, items), [history, items])
  const [expandedProcesses, setExpandedProcesses] = useState<ReadonlySet<number>>(() => new Set())
  const visibleQueue = queue.items.filter(item => item.placement !== 'context')
  const headVersion = useMemo(() => normalizeSessionEvents(history)[0]?.seq ?? null, [history])
  const latestRevision = items.reduce((latest, item) => Math.max(latest, itemRevision(item)), -1)
  const lastItem = items.at(-1)
  const latestUserSeq = items.findLast(item => item.type === 'user')?.seq ?? null
  const pendingBridge = useRef<{
    sessionId: string | null
    armed: boolean
    waiting: boolean
    userSeq: number | null
  }>({ sessionId, armed: false, waiting: false, userSeq: latestUserSeq })
  if (pendingBridge.current.sessionId !== sessionId)
    pendingBridge.current = { sessionId, armed: false, waiting: false, userSeq: latestUserSeq }
  if (pendingSend && !pendingBridge.current.armed) {
    pendingBridge.current.armed = true
    pendingBridge.current.waiting = true
    pendingBridge.current.userSeq = latestUserSeq
  }
  if (pendingBridge.current.waiting && pendingBridge.current.userSeq !== latestUserSeq)
    pendingBridge.current.waiting = false
  if (!pendingSend) {
    pendingBridge.current.armed = false
    if (!running) pendingBridge.current.waiting = false
  }
  const showPending =
    pendingBridge.current.waiting &&
    !items.some(
      item =>
        (item.type === 'assistant' && (item.status === 'waiting' || item.status === 'streaming')) ||
        ((item.type === 'tool' || item.type === 'command') && item.status === 'running'),
    )
  const tailVersion = `${String(latestRevision)}:${lastItem === undefined ? 'none' : itemKey(lastItem)}:${
    lastItem?.type === 'assistant' || lastItem?.type === 'tool' ? lastItem.status : 'settled'
  }:${String(showPending)}:${visibleQueue.map(item => `${item.id}:${item.placement}:${item.preview}`).join('|')}`
  const scroll = useConversationScroll({
    sessionKey: sessionId,
    headVersion,
    tailVersion,
    ...(scrollPositions === undefined ? {} : { positions: scrollPositions }),
  })
  const loadingOlderRef = useRef(false)
  const paginationGenerationRef = useRef(0)
  const copiedTimeoutRef = useRef<number | null>(null)
  const messageNoticeTimeoutRef = useRef<number | null>(null)
  const copyEpochRef = useRef(0)
  const copyPendingRef = useRef<Set<string>>(new Set())
  const feedbackLoadRef = useRef<Promise<boolean> | null>(null)
  const feedbackLoadedRef = useRef(false)
  const feedbackUnavailableRef = useRef(false)
  const feedbackSessionRef = useRef<string | null>(sessionId)
  const feedbackGenerationRef = useRef(0)
  const feedbackOperationTailRef = useRef<Promise<void>>(Promise.resolve())
  const feedbackItemsRef = useRef<ReadonlyMap<string, DesktopMessageFeedbackItem>>(new Map())
  const [copiedMessageKey, setCopiedMessageKey] = useState<string | null>(null)
  const [messageActionNotice, setMessageActionNotice] = useState<MessageActionNotice | null>(null)
  const [feedbackStatus, setFeedbackStatus] = useState<MessageFeedbackStatus>('cold')
  const [feedbackItems, setFeedbackItems] = useState<
    ReadonlyMap<string, DesktopMessageFeedbackItem>
  >(() => new Map())
  const [feedbackUpdating, setFeedbackUpdating] = useState(false)
  const feedbackConfigured =
    onListMessageFeedback !== undefined &&
    onPutMessageFeedback !== undefined &&
    onDeleteMessageFeedback !== undefined
  const feedbackBelongsToCurrentSession = feedbackSessionRef.current === sessionId

  const replaceFeedbackItems = useCallback(
    (feedbackList: readonly DesktopMessageFeedbackItem[]) => {
      const next = new Map(feedbackList.map(item => [item.messageId, item]))
      feedbackItemsRef.current = next
      setFeedbackItems(next)
    },
    [],
  )

  const replaceFeedbackItem = useCallback(
    (messageId: string, item: DesktopMessageFeedbackItem | null): boolean => {
      if (item !== null && item.messageId !== messageId) return false
      const next = new Map(feedbackItemsRef.current)
      if (item === null) next.delete(messageId)
      else next.set(messageId, item)
      feedbackItemsRef.current = next
      setFeedbackItems(next)
      return true
    },
    [],
  )

  const showMessageActionNotice = useCallback((messageKey: string, text: string) => {
    if (messageNoticeTimeoutRef.current !== null)
      window.clearTimeout(messageNoticeTimeoutRef.current)
    setMessageActionNotice({ messageKey, text })
    messageNoticeTimeoutRef.current = window.setTimeout(() => {
      setMessageActionNotice(current => (current?.messageKey === messageKey ? null : current))
      messageNoticeTimeoutRef.current = null
    }, 2_400)
  }, [])

  const copyMessage = useCallback(async (messageKey: string, text: string): Promise<void> => {
    if (copyPendingRef.current.has(messageKey)) return
    const epoch = copyEpochRef.current
    copyPendingRef.current.add(messageKey)
    let copied = false
    try {
      copied = await writeClipboard(text)
    } catch {
      copied = false
    } finally {
      copyPendingRef.current.delete(messageKey)
    }
    if (!copied || epoch !== copyEpochRef.current) return
    if (copiedTimeoutRef.current !== null) window.clearTimeout(copiedTimeoutRef.current)
    setCopiedMessageKey(messageKey)
    copiedTimeoutRef.current = window.setTimeout(() => {
      setCopiedMessageKey(current => (current === messageKey ? null : current))
      copiedTimeoutRef.current = null
    }, 1_000)
  }, [])

  const ensureFeedback = useCallback(async (): Promise<boolean> => {
    if (sessionId === null || !feedbackConfigured || onListMessageFeedback === undefined)
      return false
    if (feedbackSessionRef.current !== sessionId) {
      feedbackSessionRef.current = sessionId
      feedbackGenerationRef.current += 1
      feedbackLoadRef.current = null
      feedbackLoadedRef.current = false
      feedbackUnavailableRef.current = false
      feedbackOperationTailRef.current = Promise.resolve()
      replaceFeedbackItems([])
      setFeedbackStatus('cold')
      setFeedbackUpdating(false)
    }
    if (feedbackLoadedRef.current) return true
    if (feedbackUnavailableRef.current) return false
    if (feedbackLoadRef.current !== null) return feedbackLoadRef.current

    const generation = feedbackGenerationRef.current
    setFeedbackStatus('loading')
    const request = onListMessageFeedback(sessionId)
      .then(result => {
        if (
          generation !== feedbackGenerationRef.current ||
          feedbackSessionRef.current !== sessionId
        )
          return false
        replaceFeedbackItems(result.items)
        feedbackLoadedRef.current = true
        setFeedbackStatus('ready')
        return true
      })
      .catch(() => {
        if (
          generation !== feedbackGenerationRef.current ||
          feedbackSessionRef.current !== sessionId
        )
          return false
        feedbackUnavailableRef.current = true
        setFeedbackStatus('unavailable')
        return false
      })
      .finally(() => {
        if (
          generation === feedbackGenerationRef.current &&
          feedbackSessionRef.current === sessionId
        ) {
          feedbackLoadRef.current = null
        }
      })
    feedbackLoadRef.current = request
    return request
  }, [feedbackConfigured, onListMessageFeedback, replaceFeedbackItems, sessionId])

  const toggleFeedback = useCallback(
    (messageKey: string, messageId: string, rating: DesktopMessageFeedbackRating) => {
      const requestedSessionId = sessionId
      if (
        requestedSessionId === null ||
        !feedbackConfigured ||
        onPutMessageFeedback === undefined ||
        onDeleteMessageFeedback === undefined
      )
        return
      const generation = feedbackGenerationRef.current
      const operation = async (): Promise<void> => {
        const available = await ensureFeedback()
        if (
          !available ||
          generation !== feedbackGenerationRef.current ||
          feedbackSessionRef.current !== requestedSessionId
        )
          return
        setFeedbackUpdating(true)
        try {
          const observed = feedbackItemsRef.current.get(messageId)
          const result =
            observed?.rating === rating
              ? await onDeleteMessageFeedback(requestedSessionId, messageId, observed.version)
              : await onPutMessageFeedback(
                  requestedSessionId,
                  messageId,
                  rating,
                  observed?.version ?? null,
                )
          if (
            generation !== feedbackGenerationRef.current ||
            feedbackSessionRef.current !== requestedSessionId
          )
            return
          if (result.kind === 'committed') {
            if (!replaceFeedbackItem(messageId, result.item)) {
              showMessageActionNotice(messageKey, '反馈未保存，请重试')
              return
            }
            showMessageActionNotice(
              messageKey,
              result.item === null
                ? '已取消反馈'
                : result.item.rating === 'positive'
                  ? '已标记为好的回答'
                  : '已标记为有问题的回答',
            )
            return
          }
          if (!replaceFeedbackItem(messageId, result.current)) {
            showMessageActionNotice(messageKey, '反馈状态已更新，请重试')
            return
          }
          showMessageActionNotice(messageKey, '反馈状态已更新，请再次选择')
        } catch {
          if (
            generation === feedbackGenerationRef.current &&
            feedbackSessionRef.current === requestedSessionId
          ) {
            showMessageActionNotice(messageKey, '反馈未保存，请重试')
          }
        } finally {
          if (
            generation === feedbackGenerationRef.current &&
            feedbackSessionRef.current === requestedSessionId
          ) {
            setFeedbackUpdating(false)
          }
        }
      }
      const scheduled = feedbackOperationTailRef.current.then(operation, operation)
      feedbackOperationTailRef.current = scheduled.then(
        () => undefined,
        () => undefined,
      )
    },
    [
      ensureFeedback,
      feedbackConfigured,
      onDeleteMessageFeedback,
      onPutMessageFeedback,
      replaceFeedbackItem,
      sessionId,
      showMessageActionNotice,
    ],
  )

  useEffect(() => {
    feedbackGenerationRef.current += 1
    feedbackSessionRef.current = sessionId
    feedbackLoadRef.current = null
    feedbackLoadedRef.current = false
    feedbackUnavailableRef.current = false
    feedbackOperationTailRef.current = Promise.resolve()
    replaceFeedbackItems([])
    copyEpochRef.current += 1
    copyPendingRef.current.clear()
    if (copiedTimeoutRef.current !== null) window.clearTimeout(copiedTimeoutRef.current)
    if (messageNoticeTimeoutRef.current !== null)
      window.clearTimeout(messageNoticeTimeoutRef.current)
    copiedTimeoutRef.current = null
    messageNoticeTimeoutRef.current = null
    setCopiedMessageKey(null)
    setMessageActionNotice(null)
    setExpandedProcesses(new Set())
    setFeedbackStatus('cold')
    setFeedbackUpdating(false)
  }, [replaceFeedbackItems, sessionId])

  useEffect(
    () => () => {
      copyEpochRef.current += 1
      copyPendingRef.current.clear()
      if (copiedTimeoutRef.current !== null) window.clearTimeout(copiedTimeoutRef.current)
      if (messageNoticeTimeoutRef.current !== null)
        window.clearTimeout(messageNoticeTimeoutRef.current)
    },
    [],
  )

  useLayoutEffect(() => {
    paginationGenerationRef.current += 1
    loadingOlderRef.current = false
    scroll.cancelPrependAnchor()
  }, [loading, scroll.cancelPrependAnchor, sessionId])

  const loadOlder = useCallback(async () => {
    if (onLoadOlder === undefined || loading || loadingOlder || !hasMore || loadingOlderRef.current)
      return false
    const generation = paginationGenerationRef.current
    loadingOlderRef.current = true
    const scrollport = scroll.scrollRef.current
    const scrollRect = scrollport?.getBoundingClientRect()
    const anchor =
      scrollport === null || scrollport === undefined || scrollRect === undefined
        ? null
        : ([...scrollport.querySelectorAll<HTMLElement>('[data-conversation-seq]')].find(
            element => element.getBoundingClientRect().bottom >= scrollRect.top + 1,
          ) ?? null)
    scroll.capturePrependAnchor(anchor)
    try {
      const loaded = await onLoadOlder()
      if (generation !== paginationGenerationRef.current) return false
      if (!loaded) scroll.cancelPrependAnchor()
      return loaded
    } finally {
      if (generation === paginationGenerationRef.current) loadingOlderRef.current = false
    }
  }, [
    hasMore,
    loading,
    loadingOlder,
    onLoadOlder,
    scroll.cancelPrependAnchor,
    scroll.capturePrependAnchor,
    scroll.scrollRef,
  ])

  const onScroll = useCallback<UIEventHandler<HTMLElement>>(
    event => {
      scroll.onScroll(event)
      if (error === undefined && event.currentTarget.scrollTop <= OLDER_HISTORY_PRELOAD_THRESHOLD) {
        void loadOlder()
      }
    },
    [error, loadOlder, scroll.onScroll],
  )

  useEffect(() => {
    const scrollport = scroll.scrollRef.current
    if (
      scrollport === null ||
      scrollport.clientHeight <= 0 ||
      scrollport.scrollHeight > scrollport.clientHeight + OLDER_HISTORY_PRELOAD_THRESHOLD ||
      error !== undefined
    )
      return
    void loadOlder()
  }, [error, headVersion, loadOlder, scroll.scrollRef])

  if (loading && items.length === 0 && !showPending) {
    return (
      <div className={`workspace-view ${styles.state}`} role="status" aria-busy="true">
        <PixelMatrix /> 正在读取对话…
      </div>
    )
  }

  if (error !== undefined && items.length === 0 && visibleQueue.length === 0) {
    return (
      <div className={`workspace-view ${styles.state} ${styles.error}`} role="alert">
        无法读取对话：{error}
      </div>
    )
  }

  if (items.length === 0 && visibleQueue.length === 0 && !showPending) {
    if (emptyState !== undefined) return emptyState
    return (
      <div className={`workspace-view ${styles.state}`} role="status">
        <strong>这个对话还没有消息</strong>
        <span>发送第一条消息后，内容会显示在这里。</span>
      </div>
    )
  }

  return (
    <div className={styles.content}>
      {!scroll.isAtBottom && (
        <button className={styles.latestButton} type="button" onClick={scroll.scrollToBottom}>
          <ArrowDown size={14} aria-hidden="true" />
          {scroll.hasUnread ? '有新内容，回到最新' : '回到最新'}
        </button>
      )}
      <section
        id="conversation-view"
        ref={scroll.scrollRef}
        className={`workspace-view ${styles.view}`}
        aria-label="会话对话"
        data-following-latest={String(scroll.isAtBottom)}
        onScroll={onScroll}
      >
        {loadingOlder && (
          <div className={styles.loadingOlder} role="status">
            正在加载更早消息…
          </div>
        )}
        {error !== undefined && (
          <div className={styles.paginationError} role="alert">
            <span>无法加载更早消息：{error}</span>
            {hasMore && onLoadOlder !== undefined && (
              <button
                className={styles.retryOlder}
                type="button"
                onClick={() => {
                  void loadOlder()
                }}
              >
                重试加载
              </button>
            )}
          </div>
        )}
        {(items.length > 0 || showPending) && (
          <ol className={styles.list}>
            {items.flatMap(item => {
              const completedTurn = item.turn === null ? undefined : completed.get(item.turn)
              const process = completedTurn?.label ? completedTurn : undefined
              const expanded = item.turn !== null && expandedProcesses.has(item.turn)
              const prefix: ReactNode[] = []
              if (process?.firstSeq === item.seq) {
                prefix.push(
                  <li
                    key={`process-${String(item.turn)}`}
                    className={styles.eventRow}
                    data-conversation-turn={item.turn ?? undefined}
                    data-conversation-seq={item.seq}
                  >
                    <button
                      type="button"
                      className={styles.processToggle}
                      aria-expanded={expanded}
                      data-turn-process={item.turn}
                      onClick={() => {
                        setExpandedProcesses(current => {
                          const next = new Set(current)
                          if (next.has(item.turn!)) next.delete(item.turn!)
                          else next.add(item.turn!)
                          return next
                        })
                      }}
                    >
                      {process.label}
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                  </li>,
                )
              }
              if (
                process !== undefined &&
                !expanded &&
                (item.type === 'tool' || item.type === 'assistant') &&
                item.seq !== process.answerSeq
              )
                return prefix
              if (item.type === 'context') {
                return [
                  ...prefix,
                  <li
                    className={styles.eventRow}
                    key={itemKey(item)}
                    data-conversation-seq={item.seq}
                    data-conversation-turn={item.turn ?? undefined}
                  >
                    <ContextDisclosure item={item} />
                  </li>,
                ]
              }

              if (item.type === 'user' || item.type === 'assistant') {
                const waiting = item.type === 'assistant' && item.status === 'waiting'
                const streaming = item.type === 'assistant' && item.status === 'streaming'
                const interrupted = item.type === 'assistant' && item.status === 'interrupted'
                const allBlocks: readonly ConversationAssistantContentBlock[] =
                  item.type === 'assistant'
                    ? assistantBlocks(item)
                    : [{ type: 'text', index: 0, text: item.text, complete: true }]
                const blocks =
                  process !== undefined && !expanded
                    ? allBlocks.filter(block => block.type !== 'reasoning')
                    : allBlocks
                const lastBlock = blocks.at(-1)
                const hasStreamingText =
                  streaming && lastBlock?.type === 'text' && lastBlock.text.length > 0
                const activeThinkingIndex =
                  streaming && lastBlock?.type === 'reasoning' && !lastBlock.complete
                    ? lastBlock.index
                    : null
                const messageKey = itemKey(item)
                const showActions =
                  item.type === 'user' ||
                  (item.status === 'settled' &&
                    (item.turn === null ? !running : item.seq === completedTurn?.answerSeq))
                const feedback =
                  item.type === 'assistant' &&
                  item.status === 'settled' &&
                  item.messageId !== undefined &&
                  feedbackConfigured
                    ? { messageId: item.messageId }
                    : undefined
                return [
                  ...prefix,
                  <li
                    className={`${styles.message} ${styles[item.type]}`}
                    key={itemKey(item)}
                    data-conversation-seq={item.seq}
                    data-conversation-turn={item.turn ?? undefined}
                    data-message-status={item.status}
                    aria-busy={
                      (waiting || streaming) && !(item.type === 'assistant' && item.retry)
                        ? 'true'
                        : undefined
                    }
                  >
                    {waiting ? (
                      <ReplyActivity
                        waiting
                        {...(item.type === 'assistant' && item.retry ? { retry: item.retry } : {})}
                      />
                    ) : (
                      <div className={styles.messageBody}>
                        {item.type === 'user' &&
                          sessionId &&
                          item.images?.map(image => (
                            <SessionImage
                              key={image.attachmentId}
                              sessionId={sessionId}
                              {...image}
                            />
                          ))}
                        {item.type === 'user' &&
                          item.fileAttachments?.map(file => (
                            <div className="message-file-attachment" key={file.attachmentId}>
                              <FileText size={16} />
                              <span>{file.name}</span>
                              <small>{Math.max(1, Math.ceil(file.bytes / 1024))} KB</small>
                            </div>
                          ))}
                        {blocks.map((block, blockPosition) =>
                          block.text.length === 0 ? null : block.type === 'reasoning' ? (
                            <ThinkingDisclosure
                              key={`reasoning-${String(block.index)}-${String(blockPosition)}`}
                              text={block.text}
                              active={activeThinkingIndex === block.index}
                              projectCwd={projectCwd}
                              onOpenFile={onOpenFile}
                              onOpenFileInMain={onOpenFileInMain}
                            />
                          ) : (
                            <MessageMarkdown
                              key={`text-${String(block.index)}-${String(blockPosition)}`}
                              text={block.text}
                              projectCwd={projectCwd}
                              streaming={streaming}
                              showCursor={hasStreamingText && blockPosition === blocks.length - 1}
                              files={item.type === 'assistant' ? item.files : undefined}
                              onOpenFile={onOpenFile}
                              onOpenFileInMain={onOpenFileInMain}
                            />
                          ),
                        )}
                        {streaming &&
                          activeThinkingIndex === null &&
                          (hasStreamingText ? (
                            <span className="visually-hidden" role="status" aria-live="polite">
                              生成中
                            </span>
                          ) : (
                            <ReplyActivity waiting={false} />
                          ))}
                        {interrupted && <span className={styles.interrupted}>回复已停止</span>}
                      </div>
                    )}
                    {showActions && item.text.length > 0 && (
                      <MessageActions
                        messageKey={messageKey}
                        text={item.text}
                        time={item.time}
                        copied={copiedMessageKey === messageKey}
                        notice={
                          messageActionNotice?.messageKey === messageKey
                            ? messageActionNotice.text
                            : null
                        }
                        {...(feedback === undefined ? {} : { feedback })}
                        feedbackStatus={feedbackBelongsToCurrentSession ? feedbackStatus : 'cold'}
                        feedbackItem={
                          feedbackBelongsToCurrentSession &&
                          item.type === 'assistant' &&
                          item.messageId !== undefined
                            ? feedbackItems.get(item.messageId)
                            : undefined
                        }
                        feedbackUpdating={feedbackUpdating}
                        onCopy={copyMessage}
                        onEnsureFeedback={ensureFeedback}
                        onToggleFeedback={toggleFeedback}
                      />
                    )}
                  </li>,
                ]
              }

              if (item.type === 'command')
                return [
                  ...prefix,
                  <li
                    className={styles.eventRow}
                    key={itemKey(item)}
                    data-conversation-seq={item.seq}
                    data-conversation-turn={item.turn ?? undefined}
                  >
                    <CommandDisclosure item={item} />
                  </li>,
                ]

              // 运行失败与输出截断留在对应轮次，避免被后续操作的瞬时提示覆盖。
              if (item.type !== 'tool') {
                return [
                  ...prefix,
                  <li
                    className={styles.errorRow}
                    key={itemKey(item)}
                    data-conversation-seq={item.seq}
                    data-conversation-turn={item.turn ?? undefined}
                    data-severity={item.type}
                    role="status"
                  >
                    <span className={styles.errorDot} aria-hidden="true" />
                    <span className={styles.errorCopy}>
                      <strong>
                        {item.type === 'warning' ? '回复达到输出上限' : '本轮运行失败'}
                      </strong>
                      <span>{item.message}</span>
                    </span>
                    {item.code !== undefined && (
                      <code className={styles.errorCode}>{item.code}</code>
                    )}
                  </li>,
                ]
              }

              return [
                ...prefix,
                <li
                  className={styles.eventRow}
                  key={itemKey(item)}
                  data-conversation-seq={item.seq}
                  data-conversation-turn={item.turn ?? undefined}
                >
                  <ToolDisclosure item={item} sessionId={sessionId} onOpenPlan={onOpenPlan} />
                </li>,
              ]
            })}
            {showPending && (
              <li className={`${styles.message} ${styles.assistant}`}>
                <ReplyActivity waiting />
              </li>
            )}
          </ol>
        )}
        <QueueDock
          queue={queue}
          running={running}
          updatingIds={queueUpdatingIds}
          onUpdate={onUpdateQueue}
        />
      </section>
      <ConversationNavigator
        key={sessionId}
        history={history}
        items={items}
        outline={turnOutline}
        scrollRef={scroll.scrollRef}
        isAtBottom={scroll.isAtBottom}
        hasMore={hasMore}
        loadingOlder={loadingOlder}
        onLoadOlder={loadOlder}
        onJump={scroll.scrollToElement}
      />
    </div>
  )
}

export default ConversationView
