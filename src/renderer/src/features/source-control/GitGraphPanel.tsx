import { GitBranch, RefreshCw } from 'lucide-react'
import { useMemo } from 'react'
import type { GitCommitDetail, GitSummary } from './source-control-types.ts'
import { IconButton } from '../../shared/ui/IconButton.tsx'
import {
  buildGitGraphRows,
  GIT_GRAPH_ROW_HEIGHT,
  gitGraphLaneX,
  gitGraphWidth,
  parseGitReferences,
  type GitGraphRowLayout,
} from './git-graph-layout.ts'
import { GitCommitFileList } from './GitCommitFileList.tsx'
import './source-control.css'
import { useSourceControl } from './SourceControlProvider.tsx'

interface GitGraphPanelProps {
  summary: GitSummary | null
  commits: readonly GitGraphRowLayout['commit'][]
  loading: boolean
  error: string | null
  selectedCommit: GitCommitDetail | null
  selectedCommitFile: { commitHash: string; relativePath: string } | null
  onRefresh(): void
  onSelectCommit(commitHash: string): void
  onCloseCommit(): void
  onOpenCommitFile(commitHash: string, relativePath: string): void
}

function edgePath(fromX: number, fromY: number, toX: number, toY: number): string {
  if (fromX === toX) return `M ${String(fromX)} ${String(fromY)} V ${String(toY)}`
  const middleY = (fromY + toY) / 2
  return `M ${String(fromX)} ${String(fromY)} C ${String(fromX)} ${String(middleY)} ${String(toX)} ${String(middleY)} ${String(toX)} ${String(toY)}`
}

function GraphRail({ row, width }: { row: GitGraphRowLayout; width: number }) {
  const nodeX = gitGraphLaneX(row.nodeLane)
  const middleY = GIT_GRAPH_ROW_HEIGHT / 2
  const currentInputLaneKeys = new Set(row.currentInputLaneKeys)
  const references = parseGitReferences(row.commit.decorations)
  const isHead = references.some(reference => reference.kind === 'head')
  return (
    <svg
      aria-hidden="true"
      className="git-graph-rail"
      data-lane-count={Math.max(row.inputLanes.length, row.outputLanes.length, row.nodeLane + 1)}
      data-parent-count={row.commit.parents.length}
      height={GIT_GRAPH_ROW_HEIGHT}
      viewBox={`0 0 ${String(width)} ${String(GIT_GRAPH_ROW_HEIGHT)}`}
      width={width}
    >
      {row.inputLanes.map((lane, inputIndex) => {
        const inputX = gitGraphLaneX(inputIndex)
        if (currentInputLaneKeys.has(lane.key)) {
          return (
            <path
              className={`git-graph-edge git-graph-lane--${String(lane.colorIndex)}`}
              d={edgePath(inputX, 0, nodeX, middleY)}
              data-edge-kind="commit"
              key={`commit-${lane.key}`}
            />
          )
        }
        const outputIndex = row.outputLanes.findIndex(outputLane => outputLane.key === lane.key)
        if (outputIndex === -1) return null
        return (
          <path
            className={`git-graph-edge git-graph-lane--${String(lane.colorIndex)}`}
            d={edgePath(inputX, 0, gitGraphLaneX(outputIndex), GIT_GRAPH_ROW_HEIGHT)}
            data-edge-kind="continuation"
            key={`continuation-${lane.key}`}
          />
        )
      })}
      {row.parentOutputLaneKeys.map((laneKey, parentIndex) => {
        const outputIndex = row.outputLanes.findIndex(lane => lane.key === laneKey)
        const lane = row.outputLanes[outputIndex]
        if (outputIndex === -1 || lane === undefined) return null
        return (
          <path
            className={`git-graph-edge git-graph-lane--${String(lane.colorIndex)}`}
            d={edgePath(nodeX, middleY, gitGraphLaneX(outputIndex), GIT_GRAPH_ROW_HEIGHT)}
            data-edge-kind="parent"
            data-parent-index={parentIndex}
            key={`parent-${laneKey}`}
          />
        )
      })}
      {isHead && (
        <circle
          className={`git-graph-head git-graph-lane--${String(row.nodeColorIndex)}`}
          cx={nodeX}
          cy={middleY}
          r="7"
        />
      )}
      <circle
        className={`git-graph-node git-graph-lane--${String(row.nodeColorIndex)}`}
        cx={nodeX}
        cy={middleY}
        r={row.commit.parents.length > 1 ? '5' : '4'}
      />
      {row.commit.parents.length > 1 && (
        <circle
          className={`git-graph-merge-mark git-graph-lane--${String(row.nodeColorIndex)}`}
          cx={nodeX}
          cy={middleY}
          r="1.5"
        />
      )}
    </svg>
  )
}

function formatCommitTime(time: number): string {
  if (!Number.isFinite(time) || time <= 0) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(time)
}

export function GitGraphPanel({
  summary,
  commits,
  loading,
  error,
  selectedCommit,
  selectedCommitFile,
  onRefresh,
  onSelectCommit,
  onCloseCommit,
  onOpenCommitFile,
}: GitGraphPanelProps) {
  const graphRows = useMemo(() => buildGitGraphRows(commits), [commits])
  const graphWidth = useMemo(() => gitGraphWidth(graphRows), [graphRows])
  return (
    <div className="contextual-inspector git-graph-panel">
      <header>
        <div>
          <h2>Git 图</h2>
        </div>
        <IconButton label="刷新 Git 图" disabled={loading} onClick={onRefresh}>
          <RefreshCw className={loading ? 'spin' : ''} size={15} />
        </IconButton>
      </header>
      {error !== null && (
        <p className="contextual-panel-error" role="alert">
          {error}
        </p>
      )}
      {summary?.available === false ? (
        <p className="contextual-panel-empty">{summary.message ?? '当前项目不是 Git 工作区。'}</p>
      ) : (
        <>
          <section className="git-branch-card">
            <div className="section-heading">
              <GitBranch size={14} />
              <strong>{summary?.branch ?? '未命名分支'}</strong>
            </div>
            <dl>
              <dt>远端</dt>
              <dd>{summary?.upstream ?? '未设置'}</dd>
              <dt>同步</dt>
              <dd>
                ↑ {summary?.ahead ?? 0} · ↓ {summary?.behind ?? 0}
              </dd>
              <dt>工作区</dt>
              <dd>{summary?.files.length ?? 0} 个变更文件</dd>
            </dl>
          </section>
          <section className="git-commit-section" aria-label="提交记录">
            {commits.length === 0 ? (
              <p className="contextual-panel-empty">没有可显示的提交记录。</p>
            ) : (
              <ol className="git-graph git-graph--inspector">
                {graphRows.map(row => {
                  const commit = row.commit
                  const references = parseGitReferences(commit.decorations)
                  const visibleReferences = references.slice(0, 3)
                  const hiddenReferenceCount = references.length - visibleReferences.length
                  const selected = selectedCommit?.hash === commit.hash
                  const description = [
                    commit.subject || '未命名提交',
                    commit.shortHash,
                    commit.author || '未知作者',
                    ...references.map(reference => reference.label),
                  ].join('，')
                  return (
                    <li className={selected ? 'is-selected' : undefined} key={commit.hash}>
                      <button
                        aria-expanded={selected}
                        aria-label={description}
                        aria-pressed={selected}
                        className="git-commit-row"
                        style={{ gridTemplateColumns: `${String(graphWidth)}px minmax(0, 1fr)` }}
                        type="button"
                        onClick={() => {
                          if (selected) onCloseCommit()
                          else onSelectCommit(commit.hash)
                        }}
                      >
                        <GraphRail row={row} width={graphWidth} />
                        <span className="git-commit-copy">
                          <span className="git-commit-primary">
                            {visibleReferences.length > 0 && (
                              <span className="git-reference-list">
                                {visibleReferences.map(reference => (
                                  <span
                                    className={`git-reference git-reference--${reference.kind}`}
                                    key={`${reference.kind}-${reference.label}`}
                                    title={reference.fullName}
                                  >
                                    {reference.label}
                                  </span>
                                ))}
                                {hiddenReferenceCount > 0 && (
                                  <span
                                    className="git-reference git-reference--more"
                                    title={references
                                      .slice(3)
                                      .map(reference => reference.fullName)
                                      .join('\n')}
                                  >
                                    +{hiddenReferenceCount}
                                  </span>
                                )}
                              </span>
                            )}
                            <strong>{commit.subject || '未命名提交'}</strong>
                          </span>
                          <span className="git-commit-meta">
                            <code>{commit.shortHash}</code>
                            <span>{commit.author || '未知作者'}</span>
                            <time
                              dateTime={
                                commit.time > 0 ? new Date(commit.time).toISOString() : undefined
                              }
                            >
                              {formatCommitTime(commit.time)}
                            </time>
                          </span>
                        </span>
                      </button>
                      {selected && selectedCommit !== null && (
                        <div
                          className="git-commit-files-shell"
                          style={{
                            gridTemplateColumns: `${String(gitGraphLaneX(Math.max(0, row.outputLanes.length - 1)) + 10)}px minmax(0, 1fr)`,
                          }}
                        >
                          <div aria-hidden="true" className="git-commit-files-rails">
                            {row.outputLanes.map((lane, laneIndex) => (
                              <span
                                className={`git-commit-files-rail git-graph-lane--${String(lane.colorIndex)}`}
                                key={lane.key}
                                style={{
                                  insetInlineStart: `${String(gitGraphLaneX(laneIndex))}px`,
                                }}
                              />
                            ))}
                          </div>
                          <div className="git-commit-files-content">
                            <div className="git-commit-files-heading">
                              <span>变更文件</span>
                              <b>{selectedCommit.files.length}</b>
                            </div>
                            <GitCommitFileList
                              disabled={loading}
                              files={selectedCommit.files}
                              key={selectedCommit.hash}
                              selectedPath={
                                selectedCommitFile?.commitHash === commit.hash
                                  ? selectedCommitFile.relativePath
                                  : null
                              }
                              onOpenFile={file => {
                                onOpenCommitFile(commit.hash, file.relativePath)
                              }}
                            />
                          </div>
                        </div>
                      )}
                    </li>
                  )
                })}
              </ol>
            )}
          </section>
        </>
      )}
    </div>
  )
}

/** 从当前工作区读取提交及选中状态，供左右栏各自装配。 */
export function GitHistoryGraph() {
  const source = useSourceControl()
  const diff = source.selectedDiff
  return (
    <GitGraphPanel
      summary={source.gitSummary}
      commits={source.gitGraph}
      loading={source.loading}
      error={source.error}
      selectedCommit={source.selectedCommit}
      selectedCommitFile={
        diff?.mode === 'commit' && diff.commitHash
          ? { commitHash: diff.commitHash, relativePath: diff.relativePath }
          : null
      }
      onRefresh={() => {
        void source.refresh()
      }}
      onSelectCommit={hash => {
        void source.openCommit(hash)
      }}
      onCloseCommit={source.closeCommit}
      onOpenCommitFile={(hash, path) => {
        void source.openCommitFile(hash, path)
      }}
    />
  )
}
