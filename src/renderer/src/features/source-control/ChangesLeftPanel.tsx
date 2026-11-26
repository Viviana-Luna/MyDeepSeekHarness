import { Modal, Tooltip } from 'antd'
import { Check, ChevronRight, Minus, Plus, Sparkles } from 'lucide-react'
import { useId, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useSourceControl } from './SourceControlProvider.tsx'
import type { ChangedFile, GitSummary } from './source-control-types.ts'
import { IconButton } from '../../shared/ui/IconButton.tsx'
import './source-control.css'
import { SourceControlSections } from './SourceControlSections.tsx'
import { GitAiPrepare } from './GitAiPrepare.tsx'
import { GitAiReview } from './GitAiReview.tsx'
import './git-ai.css'

type ChangeMode = 'working' | 'staged'

function statusLabel(file: ChangedFile, mode: ChangeMode): string {
  if (file.conflict) return '冲突'
  const status = mode === 'staged' ? file.indexStatus : file.workingTreeStatus
  return status === '?' ? 'U' : status === '.' ? 'M' : status
}

function filePresentation(file: ChangedFile): { name: string; directory: string } {
  const segments = file.relativePath.split('/')
  return {
    name: segments.at(-1) ?? file.relativePath,
    directory: segments.slice(0, -1).join('/'),
  }
}

function mutationPaths(file: ChangedFile): string[] {
  return file.originalPath === undefined
    ? [file.relativePath]
    : [file.originalPath, file.relativePath]
}

function modeCounts(
  file: ChangedFile,
  mode: ChangeMode,
): {
  additions: number
  deletions: number
  binary: boolean
} {
  return mode === 'staged'
    ? {
        additions: file.stagedAdditions,
        deletions: file.stagedDeletions,
        binary: file.stagedBinary,
      }
    : {
        additions: file.workingAdditions,
        deletions: file.workingDeletions,
        binary: file.workingBinary,
      }
}

function ChangeRow({
  file,
  mode,
  busy,
  selected,
  onOpen,
  onMutate,
}: {
  file: ChangedFile
  mode: ChangeMode
  busy: boolean
  selected: boolean
  onOpen(): void
  onMutate(): void
}) {
  const presentation = filePresentation(file)
  const pathDescription =
    file.originalPath === undefined
      ? file.relativePath
      : `${file.originalPath} → ${file.relativePath}`
  const count = modeCounts(file, mode)
  const category = mode === 'staged' ? 'staged' : 'working'
  const action = mode === 'staged' ? '取消暂存' : file.conflict ? '标记为已解决并暂存' : '暂存'
  return (
    <div
      className={`change-row${selected ? ' is-selected' : ''}`}
      title={pathDescription}
      data-category={file.indexStatus === '?' ? 'untracked' : category}
    >
      <button
        aria-label={`查看 ${pathDescription} 的${mode === 'staged' ? '暂存区' : '工作区'} Git Diff`}
        aria-current={selected ? 'true' : undefined}
        className="change-file-open"
        type="button"
        onClick={onOpen}
      >
        <span className="change-file-copy">
          <strong>{presentation.name}</strong>
          {presentation.directory !== '' && <small>{presentation.directory}</small>}
        </span>
        <span
          className={file.conflict ? 'change-file-status status-conflict' : 'change-file-status'}
        >
          {statusLabel(file, mode)}
        </span>
        <span className={`diff-count ${count.binary ? 'diff-count--binary' : ''}`}>
          {file.indexStatus === '?' ? (
            '新文件'
          ) : count.binary ? (
            '二进制'
          ) : (
            <>
              <b>+{count.additions}</b>
              <em>−{count.deletions}</em>
            </>
          )}
        </span>
      </button>
      <IconButton
        className="change-row-action"
        label={`${action} ${pathDescription}`}
        disabled={busy}
        onClick={onMutate}
      >
        {mode === 'staged' ? <Minus size={14} /> : <Plus size={14} />}
      </IconButton>
    </div>
  )
}

export function ChangesLeftPanel({ showCommitForm = true }: { showCommitForm?: boolean } = {}) {
  const workspace = useSourceControl()
  const summary = workspace.gitSummary
  const [commitMessage, setCommitMessage] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [stagedExpanded, setStagedExpanded] = useState(true)
  const [workingExpanded, setWorkingExpanded] = useState(true)
  const [unstageTarget, setUnstageTarget] = useState<{
    summary: GitSummary
    unstage: typeof workspace.unstageChanges
  } | null>(null)
  const groupId = useId()
  const busy = workspace.gitMutation !== null
  const stagedFiles = summary?.files.filter(file => file.staged && !file.conflict) ?? []
  const workingFiles =
    summary?.files.filter(
      file => file.conflict || file.workingTreeStatus !== '.' || file.indexStatus === '?',
    ) ?? []
  const statusRevision = summary?.statusRevision
  const unstageOpen =
    unstageTarget !== null &&
    unstageTarget.summary === summary &&
    unstageTarget.unstage === workspace.unstageChanges &&
    statusRevision !== undefined &&
    stagedFiles.length > 0
  const confirmUnstage = async () => {
    if (!unstageOpen || busy || workspace.loading) return
    setUnstageTarget(null)
    setNotice(null)
    if (await workspace.unstageChanges(undefined, statusRevision)) {
      setWorkingExpanded(true)
      setNotice('已取消全部暂存。工作区文件未改动。')
    }
  }
  const submitCommit = async () => {
    if (commitMessage.trim() === '' || stagedFiles.length === 0 || busy) return
    setNotice(null)
    if (await workspace.commitStaged(commitMessage)) {
      setCommitMessage('')
      setNotice('已创建本地 Git 提交。')
    }
  }
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    void submitCommit()
  }
  const handleCommitKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return
    event.preventDefault()
    void submitCommit()
  }
  const exitAi = () => {
    void workspace.ai
      .release(true)
      .then(() => document.querySelector<HTMLButtonElement>('.scm-ai-entry')?.focus())
  }
  if (showCommitForm && ['review', 'result'].includes(workspace.ai.phase))
    return <GitAiReview ai={workspace.ai} onExit={exitAi} openCommit={workspace.openCommit} />
  const commitButtonLabel =
    workspace.gitMutation === 'commit'
      ? '正在提交…'
      : `提交暂存的更改${stagedFiles.length > 0 ? ` (${String(stagedFiles.length)})` : ''}`
  const changes = (
    <>
      {summary?.available === false && (
        <p className="navigation-empty">{summary.message ?? '当前项目不是 Git 工作区。'}</p>
      )}
      {summary?.available && (
        <>
          {showCommitForm && workspace.ai.phase === 'prepare' && (
            <GitAiPrepare ai={workspace.ai} summary={summary} onExit={exitAi} />
          )}
          {showCommitForm && workspace.ai.phase === 'normal' && (
            <form className="scm-commit-form" onSubmit={handleSubmit}>
              <textarea
                id="scm-commit-message"
                aria-label="提交消息"
                maxLength={16_000}
                placeholder={
                  /Mac/u.test(navigator.platform)
                    ? '输入提交消息，⌘ Enter 提交'
                    : '输入提交消息，Ctrl+Enter 提交'
                }
                rows={1}
                value={commitMessage}
                onChange={event => {
                  setCommitMessage(event.target.value)
                  setNotice(null)
                }}
                onKeyDown={handleCommitKeyDown}
              />
              <div className="scm-commit-actions">
                <button
                  className="scm-commit-button"
                  disabled={busy || stagedFiles.length === 0 || commitMessage.trim() === ''}
                  title={commitButtonLabel}
                  type="submit"
                >
                  <Check size={14} aria-hidden="true" />
                  <span>{commitButtonLabel}</span>
                </button>
                <button
                  className="scm-ai-entry"
                  type="button"
                  disabled={busy || !summary.files.length}
                  onClick={() => {
                    void workspace.ai.enter()
                  }}
                >
                  <Sparkles size={12} aria-hidden="true" />
                  AI 提交
                </button>
              </div>
            </form>
          )}
          {notice !== null && (
            <p className="scm-operation-notice" role="status">
              {notice}
            </p>
          )}
          <div className="scm-changes-card">
            <div className="git-overview">
              <span>{summary.files.length} 个文件</span>
              <span title="已跟踪文件的增删行数；新文件暂未统计">
                <b>+{summary.additions.toLocaleString()}</b>{' '}
                <em>−{summary.deletions.toLocaleString()}</em>
                {summary.files.some(file => file.indexStatus === '?') && (
                  <small>（不含新文件）</small>
                )}
              </span>
            </div>
            <div className="scm-resource-heading">
              <button
                className="scm-resource-toggle"
                type="button"
                aria-label="暂存的更改"
                aria-expanded={stagedExpanded}
                aria-controls={`${groupId}-staged`}
                onClick={() => {
                  setStagedExpanded(expanded => !expanded)
                }}
              >
                <ChevronRight size={13} aria-hidden="true" />
                <span>
                  暂存的更改 <b>{stagedFiles.length}</b>
                </span>
              </button>
              <Tooltip title="取消暂存全部更改" trigger={['hover', 'focus']}>
                <IconButton
                  label="取消暂存全部更改"
                  title=""
                  disabled={
                    busy ||
                    workspace.loading ||
                    statusRevision === undefined ||
                    stagedFiles.length === 0
                  }
                  onClick={() => {
                    setUnstageTarget({ summary, unstage: workspace.unstageChanges })
                  }}
                >
                  <Minus size={14} />
                </IconButton>
              </Tooltip>
            </div>
            <div className="change-list" id={`${groupId}-staged`} hidden={!stagedExpanded}>
              {stagedFiles.map(file => (
                <ChangeRow
                  busy={busy}
                  file={file}
                  key={`staged-${file.relativePath}`}
                  mode="staged"
                  selected={
                    workspace.selectedDiff?.mode === 'staged' &&
                    workspace.selectedDiff.relativePath === file.relativePath
                  }
                  onMutate={() => {
                    void workspace.unstageChanges(mutationPaths(file))
                  }}
                  onOpen={() => {
                    void workspace.openDiff(file.relativePath, 'staged')
                  }}
                />
              ))}
              {stagedFiles.length === 0 && <p className="navigation-empty">暂存区为空。</p>}
            </div>
            <div className="scm-resource-heading">
              <button
                className="scm-resource-toggle"
                type="button"
                aria-label="更改"
                aria-expanded={workingExpanded}
                aria-controls={`${groupId}-working`}
                onClick={() => {
                  setWorkingExpanded(expanded => !expanded)
                }}
              >
                <ChevronRight size={13} aria-hidden="true" />
                <span>
                  更改 <b>{workingFiles.length}</b>
                </span>
              </button>
              <Tooltip title="按工作区现状暂存全部更改" trigger={['hover', 'focus']}>
                <IconButton
                  label="暂存全部更改"
                  title=""
                  disabled={busy || workingFiles.length === 0}
                  onClick={() => {
                    setNotice(null)
                    void workspace.stageChanges().then(staged => {
                      if (staged) setNotice('已按工作区现状暂存全部更改。')
                    })
                  }}
                >
                  <Plus size={14} />
                </IconButton>
              </Tooltip>
            </div>
            <div className="change-list" id={`${groupId}-working`} hidden={!workingExpanded}>
              {workingFiles.map(file => (
                <ChangeRow
                  busy={busy}
                  file={file}
                  key={`working-${file.relativePath}`}
                  mode="working"
                  selected={
                    workspace.selectedDiff?.mode === 'working' &&
                    workspace.selectedDiff.relativePath === file.relativePath
                  }
                  onMutate={() => {
                    void workspace.stageChanges(mutationPaths(file))
                  }}
                  onOpen={() => {
                    void workspace.openDiff(file.relativePath, 'working')
                  }}
                />
              ))}
              {workingFiles.length === 0 && (
                <p className="navigation-empty">工作区没有未暂存变更。</p>
              )}
            </div>
          </div>
        </>
      )}
    </>
  )
  return (
    <section
      className="navigation-mode source-control-navigation"
      aria-label="Git 变更文件"
      data-split-history={showCommitForm || undefined}
      aria-busy={workspace.loading}
      data-ai-staged={
        showCommitForm && workspace.ai.phase === 'prepare' ? workspace.ai.scope.staged : undefined
      }
      data-ai-working={
        showCommitForm && workspace.ai.phase === 'prepare' ? workspace.ai.scope.working : undefined
      }
      data-ai-untracked={
        showCommitForm && workspace.ai.phase === 'prepare'
          ? workspace.ai.scope.untracked
          : undefined
      }
    >
      {showCommitForm ? <SourceControlSections>{changes}</SourceControlSections> : changes}
      <Modal
        title="取消全部暂存？"
        open={unstageOpen}
        centered
        width="min(440px, calc(100vw - 32px))"
        destroyOnHidden
        classNames={{ container: 'mydsh-glass-dialog', mask: 'mydsh-glass-mask' }}
        focusable={{ trap: true, focusTriggerAfterClose: true }}
        cancelText="返回"
        okText="确认取消暂存"
        cancelButtonProps={{ 'aria-label': '返回', autoFocus: true }}
        okButtonProps={{ 'aria-label': '确认取消暂存', disabled: busy || workspace.loading }}
        onCancel={() => setUnstageTarget(null)}
        onOk={() => {
          void confirmUnstage()
        }}
      >
        <p>
          将取消暂存区中的 {stagedFiles.length} 项更改。工作区文件不会被删除或改写。
          部分暂存的文件需要重新选择要暂存的内容。
        </p>
        {workingFiles.some(file => file.conflict) && <p>未解决的冲突会保留。</p>}
      </Modal>
    </section>
  )
}
