/**
 * 输入卡片下方的会话读数组：上下文占用、输出速度与 Token 用量。
 *
 * 数据全部来自运行核心的会话投影（`tokenUsage`、`contextPressure`、
 * `sessionStats`），这里只做展示，不推断也不补算账单。读数按胶囊排布，
 * 点开各自的面板看明细。
 * 没有任何读数且不在产出时整条不渲染：新会话不显示占位胶囊，第一份投影到达后
 * 才出现这一行。
 * 组件自身不持有会话，外层用会话标识重新挂载，避免读数跨会话残留。
 */

import { Database, Gauge, LoaderCircle } from 'lucide-react'
import { useCallback, useState, type MouseEvent, type ReactNode } from 'react'
import { AnchoredPanel } from '../../shared/ui/AnchoredPanel.tsx'
import { PluginActions } from '../../plugins/react.tsx'
import {
  formatHubDuration,
  formatHubExactTokens,
  formatHubSpeed,
  formatHubTokens,
  hubCacheHitPercent,
  hubHasUsage,
  hubTotalTokens,
  type HubContext,
  type HubContextBreakdown,
  type HubStats,
  type HubTokenUsage,
} from '../../domain/session-hub.ts'
import styles from './ComposerStatus.module.css'

export interface ComposerStatusProps {
  readonly usage: HubTokenUsage | null
  readonly context: HubContext
  readonly breakdown?: HubContextBreakdown | null
  readonly stats: HubStats | null
  /** 会话是否正在产出，用于区分“还没有读数”和“正在统计”。 */
  readonly running: boolean
  /** 把焦点还给输入框：读数组不接管输入焦点。 */
  readonly onRestoreFocus: () => void
}

/** 同一时刻只允许一个读数面板展开。 */
type PanelKind = 'context' | 'stats' | 'usage'

/** 读数胶囊：静态读数用 span，可展开的读数用 button。 */
function Pill({
  icon,
  label,
  title,
  open,
  onClick,
  children,
}: {
  readonly icon: ReactNode
  readonly label: string
  readonly title: string
  readonly open?: boolean
  readonly onClick?: (event: MouseEvent<HTMLButtonElement>) => void
  readonly children: ReactNode
}) {
  const content = (
    <>
      {icon}
      <span className={styles.pillLabel}>{children}</span>
    </>
  )
  if (onClick === undefined) {
    return (
      <span className={styles.pill} title={title} aria-label={label}>
        {content}
      </span>
    )
  }
  return (
    <button
      type="button"
      className={styles.pill}
      title={title}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={open === true}
      onMouseDown={event => {
        event.preventDefault()
      }}
      onClick={onClick}
    >
      {content}
    </button>
  )
}

/** 上下文占用环：容量未知时只画底环。 */
function ContextRing({ percent }: { readonly percent: number | null }) {
  const radius = 5.5
  const circumference = 2 * Math.PI * radius
  const filled = percent === null ? 0 : (circumference * Math.min(100, Math.max(0, percent))) / 100
  return (
    <svg className={styles.ring} viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
      <circle
        cx="7"
        cy="7"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.24"
        strokeWidth="1.5"
      />
      {filled > 0 && (
        <circle
          cx="7"
          cy="7"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeDasharray={`${String(filled)} ${String(circumference)}`}
          transform="rotate(-90 7 7)"
        />
      )}
    </svg>
  )
}

/** 会话统计、累计用量与上下文构成分别展开，避免重复信息。 */
function StatsPanel({ stats }: { readonly stats: HubStats }) {
  return (
    <>
      <header className={styles.panelHead}>
        <Gauge size={14} aria-hidden="true" />
        <strong>会话统计</strong>
      </header>
      <div className={styles.panelRule} aria-hidden="true" />
      <dl className={styles.panelRows}>
        <dt>模型用时</dt>
        <dd>{formatHubDuration(stats.llmMs)}</dd>
        <dt>工具调用用时</dt>
        <dd>{formatHubDuration(stats.toolMs)}</dd>
        <dt>首 token 平均（TTFT）</dt>
        <dd>{stats.ttftSteps > 0 ? formatHubDuration(stats.ttftMs / stats.ttftSteps) : '—'}</dd>
        <dt>输出速度（TPS）</dt>
        <dd>{formatHubSpeed(stats.speed?.tokensPerSecond ?? null)}</dd>
      </dl>
    </>
  )
}

function UsagePanel({ usage }: { readonly usage: HubTokenUsage }) {
  const cacheHit = hubCacheHitPercent(usage)
  return (
    <>
      <header className={styles.panelHead}>
        <Database size={14} aria-hidden="true" />
        <strong>Token 用量</strong>
        <span>{formatHubExactTokens(hubTotalTokens(usage))} tok</span>
      </header>
      <div className={styles.panelRule} aria-hidden="true" />
      <dl className={styles.panelRows}>
        <dt>缓存命中</dt>
        <dd>{cacheHit === null ? '—' : `${String(cacheHit)}%`}</dd>
        <dt>未缓存输入</dt>
        <dd>{formatHubExactTokens(usage.uncachedInput)} tok</dd>
        <dt>缓存读取</dt>
        <dd>{formatHubExactTokens(usage.cacheRead)} tok</dd>
        {usage.cacheWrite > 0 && (
          <>
            <dt>缓存写入</dt>
            <dd>{formatHubExactTokens(usage.cacheWrite)} tok</dd>
          </>
        )}
        <dt>输出</dt>
        <dd>{formatHubExactTokens(usage.output)} tok</dd>
      </dl>
    </>
  )
}

function ContextPanel({
  context,
  breakdown,
}: {
  context: HubContext
  breakdown: HubContextBreakdown | null
}) {
  const parts =
    breakdown === null
      ? []
      : [
          { label: '系统提示词', value: breakdown.systemTokens, kind: 'system' },
          { label: '工具定义', value: breakdown.toolsTokens, kind: 'tools' },
          { label: '对话消息', value: breakdown.messageTokens, kind: 'messages' },
        ]
  const capacity = Math.max(
    context.window ?? 0,
    parts.reduce((total, part) => total + part.value, 0),
    1,
  )
  return (
    <>
      <header className={styles.panelHead}>
        <strong>
          {context.awaitingUsage
            ? '请求占用：等待更新'
            : `上下文已用 ${context.percent === null ? '—' : `${String(context.percent)}%`}`}
        </strong>
        <span>
          {context.projectedTokens === null ? '—' : `~${formatHubTokens(context.projectedTokens)}`}{' '}
          / {context.window === null ? '—' : formatHubTokens(context.window)}
        </span>
      </header>
      {(context.percent ?? 0) > 100 && <p className={styles.panelNote}>超过标称窗口</p>}
      {context.nativeCompaction && (
        <p className={styles.panelNote}>
          已使用原生压缩；后续请求从压缩结果继续，本地历史不会全部重发。
          {context.awaitingUsage && '等待后续成功请求更新占用。'}
        </p>
      )}
      {context.nativeCompaction && parts.length > 0 && (
        <p className={styles.panelNote}>本地保留历史与配置（估算，非请求占用）</p>
      )}
      <div className={styles.contextBar} aria-hidden="true" title="各部分为估算值">
        {parts.length === 0 ? (
          <i style={{ width: `${String(Math.min(100, context.percent ?? 0))}%` }} />
        ) : (
          parts.map(part => (
            <i
              key={part.kind}
              data-kind={part.kind}
              style={{ width: `${String((part.value / capacity) * 100)}%` }}
            />
          ))
        )}
      </div>
      {parts.length > 0 ? (
        <dl className={styles.panelRows}>
          {parts.map(part => (
            <div className={styles.contextRow} key={part.kind}>
              <dt>
                <i className={styles.contextSwatch} data-kind={part.kind} />
                {part.label}
              </dt>
              <dd>~{formatHubTokens(part.value)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className={styles.panelNote}>
          {context.percent === null ? '等待上下文用量。' : '暂无上下文构成明细。'}
        </p>
      )}
    </>
  )
}

export function ComposerStatus({
  usage,
  context,
  breakdown = null,
  stats,
  running,
  onRestoreFocus,
}: ComposerStatusProps) {
  const [opened, setOpened] = useState<{ kind: PanelKind; anchor: HTMLButtonElement } | null>(null)
  const [lastKind, setLastKind] = useState<PanelKind | null>(null)
  if (opened !== null && opened.kind !== lastKind) setLastKind(opened.kind)
  const panel = opened?.kind ?? null
  const panelKey = panel ?? lastKind ?? 'closed'
  const clearLastKind = useCallback(() => {
    setLastKind(null)
  }, [])
  const dismiss = useCallback(() => {
    setOpened(null)
    onRestoreFocus()
  }, [onRestoreFocus])
  const toggle = (kind: PanelKind, anchor: HTMLButtonElement) => {
    setOpened(value => (value?.anchor === anchor ? null : { kind, anchor }))
  }

  const hasUsage = usage !== null && hubHasUsage(usage)
  const statsVisible = stats !== null && stats.steps > 0
  const speed = stats?.speed?.tokensPerSecond ?? null
  const contextText = context.awaitingUsage
    ? '等待更新'
    : context.percent === null
      ? '上下文'
      : `${String(context.percent)}%`
  const hasContext =
    context.awaitingUsage ||
    context.percent !== null ||
    context.projectedTokens !== null ||
    context.window !== null

  // 首份投影到达前（新会话）不占位：没有读数时用户看不到可读的值，
  // 只留“统计中…”这一种过程状态。
  if (!hasUsage && !statsVisible && !hasContext && !running) return null

  return (
    <div className={styles.readings} data-composer-readings="true">
      {statsVisible && (
        <Pill
          icon={<Gauge size={14} aria-hidden="true" />}
          label={speed === null ? '耗时统计' : `输出速度 ${formatHubSpeed(speed)}`}
          title="点开查看模型与工具耗时、输出速度"
          open={panel === 'stats'}
          onClick={event => {
            toggle('stats', event.currentTarget)
          }}
        >
          <span className={styles.secondaryReading}>
            {stats.turns} 轮 {stats.steps} 步 ·{' '}
          </span>
          {speed === null ? '耗时统计' : formatHubSpeed(speed)}
        </Pill>
      )}
      {!statsVisible && running && (
        <Pill
          icon={<LoaderCircle className="spin" size={14} aria-hidden="true" />}
          label="输出速度正在统计"
          title="完成第一个步骤后开始统计"
        >
          统计中…
        </Pill>
      )}
      {hasUsage && usage !== null && (
        <Pill
          icon={<Database size={14} aria-hidden="true" />}
          label={`Token 用量：共 ${formatHubExactTokens(hubTotalTokens(usage))} tok`}
          title="点开查看未缓存输入、缓存读取、缓存写入与输出"
          open={panel === 'usage'}
          onClick={event => {
            toggle('usage', event.currentTarget)
          }}
        >
          {formatHubTokens(hubTotalTokens(usage))} tok
          {hubCacheHitPercent(usage) !== null && (
            <span className={styles.secondaryReading}>
              {' '}
              · 缓存命中 {hubCacheHitPercent(usage)}%
            </span>
          )}
        </Pill>
      )}
      <Pill
        icon={<ContextRing percent={context.percent} />}
        label={
          context.awaitingUsage
            ? '请求占用等待更新'
            : context.percent === null
              ? '上下文占用未知'
              : `上下文占用 ${String(context.percent)}%`
        }
        title={
          context.awaitingUsage
            ? '等待后续成功请求报告有效占用；旧读数不代表压缩后的请求'
            : context.percent === null
              ? '上下文占用：等待运行核心报告用量'
              : `上下文占用 ${String(context.percent)}%${context.percent > 100 ? '，超过标称窗口' : ''}${context.window === null ? '' : `，容量 ${formatHubTokens(context.window)} tok`}`
        }
        open={panel === 'context'}
        onClick={event => {
          toggle('context', event.currentTarget)
        }}
      >
        {contextText}
      </Pill>
      <PluginActions name="composer.readings" />
      <AnchoredPanel
        key={panelKey}
        open={panel !== null}
        anchor={opened?.anchor ?? null}
        side="top"
        align="end"
        motion="morph"
        onExited={clearLastKind}
        className={styles.panel}
        label={panel === 'stats' ? '会话统计' : panel === 'context' ? '上下文占用' : 'Token 用量'}
        onDismiss={dismiss}
      >
        {panel === 'stats' && statsVisible && <StatsPanel stats={stats} />}
        {panel === 'context' && <ContextPanel context={context} breakdown={breakdown} />}
        {panel === 'usage' && usage !== null && <UsagePanel usage={usage} />}
      </AnchoredPanel>
    </div>
  )
}
