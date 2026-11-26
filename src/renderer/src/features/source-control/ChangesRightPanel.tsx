import { ChangesLeftPanel } from './ChangesLeftPanel.tsx'
import { SourceControlSections } from './SourceControlSections.tsx'
import { useEffect, useRef, useState } from 'react'
import { GitBranch } from 'lucide-react'
import { useWorkspaceSnapshot, useWorkspaceStore } from '../../hooks/useWorkspace.ts'
import { useSourceControl } from './SourceControlProvider.tsx'
import type { GitBranches, GitReview } from '../../../../shared/git-review.ts'

export function ChangesRightPanel() {
  const store = useWorkspaceStore()
  const snapshot = useWorkspaceSnapshot()
  const source = useSourceControl()
  const projectId = snapshot.selectedProjectId
  const sessionId = snapshot.selectedSessionId
  const running = snapshot.sessions.find(session => session.sessionId === sessionId)?.running
  const [mode, setMode] = useState<'working' | 'turn' | 'branch'>('working')
  const [branches, setBranches] = useState<GitBranches | null>(null)
  const [base, setBase] = useState('')
  const [review, setReview] = useState<GitReview | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const generation = useRef(0)
  const gitRevision = source.gitRevision
  useEffect(() => {
    setBranches(null)
    setBase('')
    setReview(null)
    setError('')
    setMode('working')
  }, [projectId])
  useEffect(() => {
    if (mode !== 'branch') return
    let disposed = false
    void store
      .callProject('gitBranches')
      .then(value => {
        if (disposed) return
        const result = value as GitBranches
        if (result.kind !== 'git-branches' || !Array.isArray(result.branches))
          throw new Error('Git 分支数据无效')
        setBranches(result)
        setBase(current => (result.branches.includes(current) ? current : result.defaultBase))
      })
      .catch(caught => {
        if (!disposed) setError(caught instanceof Error ? caught.message : '无法读取分支')
      })
    return () => {
      disposed = true
    }
  }, [gitRevision, mode, projectId, store])
  useEffect(() => {
    const current = ++generation.current
    setError('')
    if (mode === 'working' || (mode === 'branch' && !base) || (mode === 'turn' && !sessionId)) {
      setReview(null)
      setLoading(false)
      return
    }
    setLoading(true)
    void store
      .callProject('gitReview', {
        comparison: mode,
        ...(mode === 'branch' ? { baseRef: base } : { sessionId }),
      })
      .then(value => {
        if (current !== generation.current) return
        const result = value as GitReview
        if (result.kind !== 'git-review' || !Array.isArray(result.files))
          throw new Error('Git 审阅数据无效')
        setReview(result)
      })
      .catch(caught => {
        if (current === generation.current)
          setError(caught instanceof Error ? caught.message : '无法读取比较范围')
      })
      .finally(() => {
        if (current === generation.current) setLoading(false)
      })
    return () => {
      generation.current += 1
    }
  }, [base, gitRevision, mode, projectId, running, sessionId, store])
  return (
    <section className="git-review-panel" aria-label="Git 审阅">
      <div className="git-review-toolbar">
        <GitBranch size={14} />
        <select
          aria-label="Git 比较范围"
          value={mode}
          onChange={event => {
            const nextMode = event.target.value as typeof mode
            setMode(nextMode)
            if (
              nextMode === 'working' &&
              !source.loading &&
              source.gitMutation === null &&
              store.selectedProject()?.projectAccessId !== undefined
            )
              void source.refresh()
          }}
        >
          <option value="working">未提交的改动</option>
          <option value="turn">上轮改动</option>
          <option value="branch">分支对比</option>
        </select>
      </div>
      {mode === 'branch' && (
        <label className="git-review-base">
          比较基准
          <select
            aria-label="比较基准分支"
            value={base}
            onChange={event => {
              setBase(event.target.value)
            }}
          >
            {!branches?.branches.length && <option value="">暂无可比较分支</option>}
            {branches?.branches.map(ref => (
              <option key={ref} value={ref}>
                {ref}
              </option>
            ))}
          </select>
          <small>从共同祖先到当前分支 HEAD，包含已提交改动。</small>
        </label>
      )}
      <SourceControlSections>
        {mode === 'working' ? (
          <ChangesLeftPanel showCommitForm={false} />
        ) : (
          <div className="git-review-files">
            {loading && <p role="status">正在比较…</p>}
            {error && <p role="alert">{error}</p>}
            {mode === 'turn' && !sessionId && <p>选择一个会话以查看上轮改动。</p>}
            {review && (
              <>
                <p className="git-review-caption">
                  {review.title}
                  {review.available ? ` · ${review.files.length} 个文件` : ''}
                </p>
                {!review.available ? (
                  <p>{review.message}</p>
                ) : review.files.length === 0 ? (
                  <p>此范围内没有文件改动。</p>
                ) : (
                  review.files.map(file => (
                    <button
                      key={file.relativePath}
                      type="button"
                      className="git-review-file"
                      title={file.relativePath}
                      aria-label={`查看 ${file.relativePath} 的${mode === 'turn' ? '上轮改动' : '分支差异'}`}
                      onClick={() => {
                        void source.openReviewFile({
                          comparison: mode,
                          ...(mode === 'branch'
                            ? { baseRef: base }
                            : { sessionId: sessionId ?? '' }),
                          reviewId: review.reviewId,
                          relativePath: file.relativePath,
                        })
                      }}
                    >
                      <span>{file.relativePath}</span>
                      <small>{file.status}</small>
                      <span className="diff-count">
                        {file.binary ? (
                          '二进制'
                        ) : (
                          <>
                            <b>+{file.additions}</b>
                            <em>−{file.deletions}</em>
                          </>
                        )}
                      </span>
                    </button>
                  ))
                )}
              </>
            )}
          </div>
        )}
      </SourceControlSections>
    </section>
  )
}
