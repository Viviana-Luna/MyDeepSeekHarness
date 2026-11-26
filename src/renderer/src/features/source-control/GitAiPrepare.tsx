/** renderer 左栏发送准备卡；外发模型和范围只在用户进入流程后显示。 */
import { useEffect, useRef } from 'react'
import type { GitAiFlow } from './useGitAiFlow.ts'
import type { GitSummary } from './source-control-types.ts'

/** 准备与可取消分析共用原位卡片，不遮挡中央 Diff。 */
export function GitAiPrepare({
  ai,
  summary,
  onExit,
}: {
  ai: GitAiFlow
  summary: GitSummary
  onExit(): void
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    heading.current?.focus()
  }, [])
  const files = summary.files.filter(file => !file.conflict)
  const counts = {
    staged: files.filter(file => file.indexStatus !== '.' && file.indexStatus !== '?').length,
    working: files.filter(file => file.indexStatus !== '?' && file.workingTreeStatus !== '.')
      .length,
    untracked: files.filter(file => file.indexStatus === '?').length,
  }
  const categories = [
    ['staged', '暂存的更改'],
    ['working', '未暂存的更改'],
    ['untracked', '未跟踪的文件'],
  ] as const
  const total = categories.reduce((sum, [key]) => sum + (ai.scope[key] ? counts[key] : 0), 0)
  const conflicts = summary.files.length - files.length
  return (
    <section
      className="git-ai-prepare"
      aria-label="AI 提交准备"
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault()
          if (ai.analyzing) void ai.release(false)
          else onExit()
        }
      }}
    >
      <header>
        <h3 ref={heading} tabIndex={-1}>
          ✨ AI 提交
        </h3>
        <button type="button" aria-label="退出 AI 提交" onClick={onExit}>
          ×
        </button>
      </header>
      {ai.analyzing ? (
        <div role="status">
          <p>正在分析所选更改…</p>
          <button
            type="button"
            onClick={() => {
              void ai.release(false)
            }}
          >
            取消分析
          </button>
        </div>
      ) : (
        <>
          <label>
            模型
            <select
              aria-label="AI 提交模型"
              value={ai.model ? JSON.stringify([ai.model.provider, ai.model.model]) : ''}
              onChange={event => {
                const [provider, model] = JSON.parse(event.target.value) as [string, string]
                ai.setModel({ provider, model })
              }}
            >
              <option value="" disabled>
                选择模型
              </option>
              {ai.models?.groups.map(group => (
                <optgroup key={group.id} label={group.name}>
                  {group.models.map(model => (
                    <option key={model.id} value={JSON.stringify([group.id, model.id])}>
                      {group.name} / {model.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <fieldset>
            <legend>分析范围</legend>
            {categories.map(([key, label]) => (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={ai.scope[key] && counts[key] > 0}
                  disabled={!counts[key]}
                  onChange={event => ai.setScope({ ...ai.scope, [key]: event.target.checked })}
                />
                <span>{label}</span>
                <b>{counts[key]}</b>
              </label>
            ))}
          </fieldset>
          {conflicts > 0 && <p>已跳过 {conflicts} 个冲突文件，请先解决冲突。</p>}
          <p>所选变更内容将发送给上述模型。</p>
          <div className="git-ai-actions">
            <button type="button" onClick={onExit}>
              取消
            </button>
            <button
              className="scm-commit-button"
              type="button"
              disabled={!total || !ai.model}
              onClick={() => {
                // 空类别在界面上未勾选；不能因其默认值为 true 而发送随后新增的内容。
                ai.setScope({
                  staged: ai.scope.staged && counts.staged > 0,
                  working: ai.scope.working && counts.working > 0,
                  untracked: ai.scope.untracked && counts.untracked > 0,
                })
                void ai.analyze()
              }}
            >
              开始分析
            </button>
          </div>
        </>
      )}
      {ai.error && (
        <p role="alert" className="git-ai-error">
          {ai.error}
        </p>
      )}
    </section>
  )
}
