import { Gauge, WalletCards } from 'lucide-react'
import { PluginActions } from '../../../../../plugins/react.tsx'
import {
  formatHubExactTokens,
  formatHubDuration,
  formatHubSpeed,
  formatHubTokens,
  hubCacheHitPercent,
  hubHasUsage,
  hubTotalTokens,
  parseHubContext,
  parseHubStats,
  parseHubTokenUsage,
} from '../../../../../domain/session-hub.ts'

export function readChatContext(values: Record<string, unknown>) {
  const context = parseHubContext(values.contextPressure)
  return {
    projected: context.projectedTokens,
    windowSize: context.window,
    contextPercent: context.percent,
    ...(context.awaitingUsage ? { awaitingUsage: true as const } : {}),
    ...(context.nativeCompaction ? { nativeCompaction: true as const } : {}),
  }
}

export function ChatRightPanel({
  values,
  context,
  projectScopeKey,
  metadata,
}: {
  values: Record<string, unknown>
  context: ReturnType<typeof readChatContext>
  projectScopeKey: string
  metadata?: readonly { label: string; value: string }[]
}) {
  const { projected, windowSize, contextPercent } = context
  const usage = parseHubTokenUsage(values.tokenUsage)
  const cacheHit = usage === null ? null : hubCacheHitPercent(usage)
  const total = usage === null ? 0 : hubTotalTokens(usage)
  const stats = parseHubStats(values.sessionStats)
  return (
    <>
      {metadata !== undefined && (
        <section className="usage-card session-details">
          <div className="section-heading">
            <strong>当前会话</strong>
          </div>
          <dl>
            {metadata.map(item => (
              <div key={item.label}>
                <dt>{item.label}</dt>
                <dd title={item.value}>{item.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      <details className="session-usage-details">
        <summary>上下文与用量明细</summary>
        <section className="context-card">
          <div>
            <span>请求上下文</span>
            <strong>
              {context.awaitingUsage
                ? '等待更新'
                : contextPercent === null
                  ? '—'
                  : `${String(contextPercent)}%`}
            </strong>
          </div>
          <div className="meter">
            <i style={{ width: `${String(Math.min(100, contextPercent ?? 0))}%` }} />
          </div>
          {(contextPercent ?? 0) > 100 && <small>超过标称窗口</small>}
          {context.nativeCompaction && <small>已使用原生压缩，本地历史不等于请求占用。</small>}
          <small>
            {context.awaitingUsage
              ? '等待后续成功请求更新占用。'
              : projected !== null && windowSize !== null
                ? `${formatHubExactTokens(projected)} / ${formatHubExactTokens(windowSize)} tokens`
                : '暂无上下文使用信息'}
          </small>
        </section>
        <section className="usage-card">
          <div className="section-heading">
            <WalletCards size={14} />
            <strong>Token 使用</strong>
            {usage !== null && hubHasUsage(usage) && <span>{formatHubTokens(total)}</span>}
          </div>
          {/* 没有投影时保留基础读数占位；缓存写入只在运行核心报告非零用量时显示。 */}
          <dl>
            <dt>未缓存输入</dt>
            <dd>{usage === null ? '—' : formatHubExactTokens(usage.uncachedInput)}</dd>
            <dt>缓存读取</dt>
            <dd>{usage === null ? '—' : formatHubExactTokens(usage.cacheRead)}</dd>
            {usage !== null && usage.cacheWrite > 0 && (
              <>
                <dt>缓存写入</dt>
                <dd>{formatHubExactTokens(usage.cacheWrite)}</dd>
              </>
            )}
            <dt>输出</dt>
            <dd>{usage === null ? '—' : formatHubExactTokens(usage.output)}</dd>
            {cacheHit !== null && (
              <>
                <dt>缓存命中</dt>
                <dd>{cacheHit}%</dd>
              </>
            )}
          </dl>
        </section>
        <section className="usage-card">
          <div className="section-heading">
            <Gauge size={14} />
            <strong>耗时与速度</strong>
          </div>
          <dl>
            <dt>输出速度</dt>
            <dd>{formatHubSpeed(stats?.speed?.tokensPerSecond ?? null)}</dd>
            <dt>模型耗时</dt>
            <dd>{stats === null ? '—' : formatHubDuration(stats.llmMs)}</dd>
            <dt>工具耗时</dt>
            <dd>{stats === null ? '—' : formatHubDuration(stats.toolMs)}</dd>
            <dt>平均首字</dt>
            <dd>
              {stats === null || stats.ttftSteps === 0
                ? '—'
                : formatHubDuration(stats.ttftMs / stats.ttftSteps)}
            </dd>
          </dl>
        </section>
      </details>
      <PluginActions name="session.info" scopeKey={projectScopeKey} />
    </>
  )
}
