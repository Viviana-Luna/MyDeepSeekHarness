import { ChevronRight, GitBranch, GitCompareArrows } from 'lucide-react'
import { useSourceControl } from './SourceControlProvider.tsx'
import { useWorkspaceStore } from '../../hooks/useWorkspace.ts'
import type { PluginIcon } from '../../plugins/registry.ts'
import { AppAlert } from '../../shared/ui/AppAlert.tsx'
import { ElasticPress } from '../../shared/ui/ElasticPress.tsx'

export const GitModeIcon: PluginIcon = ({
  size = 20,
  strokeWidth = 1.8,
  'aria-hidden': ariaHidden = true,
}) => {
  const changedFiles = useSourceControl().gitSummary?.files.length ?? 0
  return (
    <>
      <GitCompareArrows size={size} strokeWidth={strokeWidth} aria-hidden={ariaHidden} />
      {changedFiles > 0 && (
        <span className="count-badge" aria-hidden="true">
          {changedFiles > 99 ? '99+' : changedFiles}
        </span>
      )}
    </>
  )
}

export function GitModeTooltip() {
  const changedFiles = useSourceControl().gitSummary?.files.length ?? 0
  return <>{changedFiles > 0 ? `变更 · ${String(changedFiles)} 个文件` : '变更'}</>
}

export function GitSummaryCard() {
  const store = useWorkspaceStore()
  const { gitSummary } = useSourceControl()
  return (
    <section className="git-card">
      <div className="section-heading">
        <GitBranch size={14} />
        <strong>Git</strong>
        <ElasticPress>
          <button
            className="icon-button git-card__open"
            type="button"
            aria-label="打开 Git"
            title="打开 Git"
            onClick={() => {
              store.setView('changes', { syncNavigation: true })
            }}
          >
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </ElasticPress>
      </div>
      {gitSummary?.available ? (
        <dl>
          <dt>分支</dt>
          <dd title={gitSummary.branch ?? undefined}>{gitSummary.branch ?? '未命名分支'}</dd>
          <dt>变更</dt>
          <dd>{gitSummary.files.length} 个文件</dd>
          <dt>增删</dt>
          <dd>
            <b>+{gitSummary.additions}</b> <em>−{gitSummary.deletions}</em>
          </dd>
          <dt className="git-card__detail">远端</dt>
          <dd className="git-card__detail">{gitSummary.upstream ?? '未设置'}</dd>
          <dt className="git-card__detail">同步</dt>
          <dd className="git-card__detail">
            ↑ {gitSummary.ahead} · ↓ {gitSummary.behind}
          </dd>
        </dl>
      ) : (
        <p>{gitSummary?.message ?? '当前项目没有可用 Git 状态。'}</p>
      )}
    </section>
  )
}

export function SourceControlAlert() {
  const { error, clearError } = useSourceControl()
  return error === null ? null : (
    <AppAlert tone="error" title="Git 操作失败" dismissAfterMs={8_000} onClose={clearError}>
      {error}
    </AppAlert>
  )
}
