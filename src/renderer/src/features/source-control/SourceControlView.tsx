import { Columns2, GitCompareArrows, Rows3 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSourceControl } from './SourceControlProvider.tsx'
import type { DiffToken } from './diff-highlight.ts'
import { pairDiffRows, parseUnifiedDiff, type DiffRow } from './diff-model.ts'
import './source-control.css'
import type { IslandPresentationProps } from '../../plugins/registry.ts'
import type { GitDiff } from './source-control-types.ts'

function DiffCode({
  row,
  tokens = [],
}: {
  row: DiffRow
  tokens?: readonly DiffToken[] | undefined
}) {
  const bounds = [
    ...new Set([
      0,
      row.text.length,
      ...tokens.flatMap(token => [token.from, token.to]),
      ...(row.changed ?? []),
    ]),
  ].toSorted((a, b) => a - b)
  return (
    <code>
      {row.text === ''
        ? ' '
        : bounds.slice(0, -1).map((from, index) => {
            const to = bounds[index + 1]!
            const token = tokens.find(item => item.from <= from && item.to >= to)
            const changed =
              row.changed !== undefined && from >= row.changed[0] && to <= row.changed[1]
            return (
              <span
                className={[token?.className, changed ? 'diff-text-change' : '']
                  .filter(Boolean)
                  .join(' ')}
                key={from}
              >
                {row.text.slice(from, to)}
              </span>
            )
          })}
      {row.noNewline && (
        <span className="diff-no-newline" title="文件末尾无换行" aria-label="文件末尾无换行">
          ↵
        </span>
      )}
    </code>
  )
}

function DiffSign({ row }: { row: DiffRow | null }) {
  return (
    <span
      className="diff-sign"
      aria-label={row?.kind === 'addition' ? '新增' : row?.kind === 'deletion' ? '删除' : undefined}
    >
      {row?.kind === 'addition' ? '+' : row?.kind === 'deletion' ? '−' : ''}
    </span>
  )
}

export function SourceControlView({
  document,
}: Partial<IslandPresentationProps> & { document?: GitDiff } = {}) {
  const workspace = useSourceControl()
  const [layout, setLayout] = useState<'split' | 'inline'>('split')
  const summary = workspace.gitSummary
  const diff = document ?? workspace.selectedDiff
  const commit =
    document && workspace.selectedCommit?.hash !== document.commitHash
      ? null
      : workspace.selectedCommit
  const patch = diff?.patch ?? ''
  const path = diff?.relativePath ?? ''
  const pairs = useMemo(
    // 先按分块配对再移除定位条，避免相隔很远的增删行被拼成同一组。
    () => pairDiffRows(parseUnifiedDiff(patch)).filter(pair => pair.info?.kind !== 'hunk'),
    [patch, path],
  )
  const [highlight, setHighlight] = useState<{
    pairs: typeof pairs
    tokens: Map<DiffRow, DiffToken[]>
  } | null>(null)
  useEffect(() => {
    let cancelled = false
    if (pairs.length > 0) {
      void import('./diff-highlight.ts')
        .then(module => module.highlightDiff(pairs, path))
        .then(tokens => {
          if (!cancelled) setHighlight({ pairs, tokens })
        })
        .catch(() => {
          /* 语言加载失败时仍显示完整代码和增删强调。 */
        })
    }
    return () => {
      cancelled = true
    }
  }, [pairs, path])
  const tokens = highlight?.pairs === pairs ? highlight.tokens : undefined
  const selectedCommitFile =
    diff?.mode === 'commit' && (document !== undefined || diff.commitHash === commit?.hash)
  const hasCode = pairs.some(pair => pair.info === undefined)
  const isNewFile = pairs.some(pair => pair.info?.text === '新文件')
  const isDeletedFile = pairs.some(pair => pair.info?.text === '文件已删除')
  const sources =
    diff?.mode === 'review'
      ? [...(diff.sources ?? ['比较起点', '比较终点'])]
      : diff?.mode === 'commit'
        ? [
            commit?.parents[0]?.slice(0, 7) ?? '空文件',
            commit?.shortHash ?? diff.commitHash?.slice(0, 7) ?? '当前提交',
          ]
        : diff?.mode === 'staged'
          ? ['HEAD', '暂存区']
          : ['暂存区', '工作区']
  if (isNewFile) sources[0] = '空文件'
  if (isDeletedFile) sources[1] = '文件已删除'

  if (summary?.available === false) {
    return (
      <section className="workspace-view viewer-state">
        <GitCompareArrows size={24} />
        <strong>当前项目不是 Git 工作区</strong>
        <span>{summary.message}</span>
      </section>
    )
  }
  if (diff === null && commit === null) {
    return (
      <section className="workspace-view scm-overview" aria-label="源代码管理">
        <div className="scm-overview__hero">
          <GitCompareArrows size={26} />
          <h2>{summary?.branch ?? 'Git 工作区'}</h2>
          <p>从变更列表选择工作区或暂存区文件，查看未提交的差异。</p>
          <dl>
            <div>
              <dt>变更文件</dt>
              <dd>{summary?.files.length ?? 0}</dd>
            </div>
            <div>
              <dt>已跟踪文件新增</dt>
              <dd className="positive">+{summary?.additions ?? 0}</dd>
            </div>
            <div>
              <dt>已跟踪文件删除</dt>
              <dd className="negative">−{summary?.deletions ?? 0}</dd>
            </div>
            <div>
              <dt>同步</dt>
              <dd>
                ↑ {summary?.ahead ?? 0} · ↓ {summary?.behind ?? 0}
              </dd>
            </div>
          </dl>
        </div>
      </section>
    )
  }
  if (diff !== null && diff.presentation !== 'text') {
    return (
      <section className="workspace-view viewer-state" aria-label="Git Diff">
        <GitCompareArrows size={24} />
        <strong>{diff.message ?? '这个文件没有可显示的文本 Diff'}</strong>
        <span>{diff.relativePath}</span>
      </section>
    )
  }
  return (
    <section className="workspace-view diff-viewer" aria-label="Git Diff">
      {path !== '' && (
        <header className="diff-path-bar" aria-label="差异文件路径" title={path}>
          <GitCompareArrows size={14} aria-hidden="true" />
          <span>{path}</span>
        </header>
      )}
      <div className="diff-content">
        {commit !== null && !selectedCommitFile ? (
          <div className="viewer-state commit-file-prompt">
            <GitCompareArrows size={24} />
            <strong>从右侧提交列表选择一个文件</strong>
            <span>查看这个文件在当前提交中的变更。</span>
          </div>
        ) : pairs.length === 0 ? (
          <div className="viewer-state">
            <strong>这个文件没有可显示的文本差异</strong>
          </div>
        ) : (
          <>
            <div className={layout === 'inline' ? 'diff-inline' : 'diff-split'}>
              {pairs.map((pair, index) =>
                pair.info !== undefined ? (
                  <div
                    className={`diff-row diff-row--${pair.info.kind} diff-row--wide`}
                    key={index}
                  >
                    {pair.info.text}
                  </div>
                ) : layout === 'inline' ? (
                  (pair.left === pair.right ? [pair.left] : [pair.left, pair.right]).map(
                    (row, side) =>
                      row === null ? null : (
                        <div
                          className={`diff-row diff-row--${row.kind}`}
                          key={`${String(index)}-${String(side)}`}
                        >
                          <span>{row.oldLine ?? ''}</span>
                          <span>{row.newLine ?? ''}</span>
                          <DiffSign row={row} />
                          <DiffCode row={row} tokens={tokens?.get(row)} />
                        </div>
                      ),
                  )
                ) : (
                  <div className="diff-pair" key={index}>
                    {[pair.left, pair.right].map((row, side) => (
                      <div
                        className={`diff-side ${row === null ? 'diff-side--empty' : `diff-row--${row.kind}`}`}
                        key={side}
                      >
                        <span>{(side === 0 ? row?.oldLine : row?.newLine) ?? ''}</span>
                        <DiffSign row={row} />
                        {row === null ? <code /> : <DiffCode row={row} tokens={tokens?.get(row)} />}
                      </div>
                    ))}
                  </div>
                ),
              )}
              {!hasCode && (
                <p className="diff-content-unchanged">
                  {isNewFile
                    ? '新文件为空。'
                    : isDeletedFile
                      ? '已删除空文件。'
                      : '文件内容未变化。'}
                </p>
              )}
            </div>
          </>
        )}
        {diff?.truncated === true && (
          <footer className="diff-warning">Diff 超过桌面查看器上限，当前只显示前 6000 行。</footer>
        )}
      </div>
      {hasCode && (
        <footer
          className="view-statusbar diff-toolbar"
          aria-label="差异视图操作"
          data-layout={layout}
        >
          <div className="diff-sources" role="group" aria-label="比较来源">
            <span title={`旧版 · ${sources[0]}`}>旧版 · {sources[0]}</span>
            <span title={`新版 · ${sources[1]}`}>新版 · {sources[1]}</span>
          </div>
          <div className="diff-layout-toggle" role="group" aria-label="Diff 布局">
            <button
              aria-pressed={layout === 'split'}
              className="view-tool-button"
              type="button"
              title="并排 Diff"
              onClick={() => {
                setLayout('split')
              }}
            >
              <Columns2 size={14} aria-hidden="true" />
              并排
            </button>
            <button
              aria-pressed={layout === 'inline'}
              className="view-tool-button"
              type="button"
              title="行内 Diff"
              onClick={() => {
                setLayout('inline')
              }}
            >
              <Rows3 size={14} aria-hidden="true" />
              行内
            </button>
          </div>
        </footer>
      )}
    </section>
  )
}
