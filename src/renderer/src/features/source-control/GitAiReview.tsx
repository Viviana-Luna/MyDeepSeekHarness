/** renderer 左栏方案编排与结果；中段独立滚动，确认与错误始终在原位可用。 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AnchoredMenu } from '../../shared/ui/AnchoredMenu.tsx'
import type { GitAiFlow } from './useGitAiFlow.ts'
import { moveGitAiItems, reorderGitAiBatch } from './git-ai-edit.ts'

function ActionsMenu({
  label,
  actions,
}: {
  label: string
  actions: Array<{ label: string; run(): void }>
}) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const dismiss = useCallback(() => {
    setOpen(false)
  }, [])
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        ⋯
      </button>
      <AnchoredMenu
        open={open}
        anchorRef={anchor}
        className="scm-action-menu"
        label={label}
        onDismiss={dismiss}
      >
        {actions.map(action => (
          <button
            key={action.label}
            role="menuitem"
            type="button"
            onClick={() => {
              action.run()
              dismiss()
              anchor.current?.focus()
            }}
          >
            {action.label}
          </button>
        ))}
      </AnchoredMenu>
    </>
  )
}

function FileRow({ ai, id, editable }: { ai: GitAiFlow; id: string; editable: boolean }) {
  const item = ai.analysis!.items.find(candidate => candidate.id === id)!
  const needsApproval = item.requiresWholeFile && !ai.wholeFileIds.includes(id)
  const version = item.mode === 'staged' ? '仅已暂存版本' : '整文件版本'
  const actions = ai.plan.batches.map((_, index) => ({
    label: `移至批次 ${index + 1}`,
    run: () => ai.setPlan(moveGitAiItems(ai.plan, [id], index)),
  }))
  actions.push(
    { label: '拆为独立新批次', run: () => ai.setPlan(moveGitAiItems(ai.plan, [id], -2)) },
    { label: '移入暂不提交', run: () => ai.setPlan(moveGitAiItems(ai.plan, [id], -1)) },
  )
  if (needsApproval)
    actions.push({
      label: '确认此整文件版本一并提交',
      run: () => ai.setWholeFileIds([...ai.wholeFileIds, id]),
    })
  return (
    <div className="git-ai-file">
      <div className="change-row" title={item.relativePath}>
        <button
          className="change-file-open"
          type="button"
          onClick={() => {
            void ai.openFile(id)
          }}
        >
          <span className="change-file-copy">
            <strong>{item.relativePath.split('/').at(-1)}</strong>
            <small>{item.relativePath}</small>
          </span>
        </button>
        {editable && <ActionsMenu label={`调整 ${item.relativePath}`} actions={actions} />}
      </div>
      <small>{needsApproval ? '⚠ 需手动处理：暂不提交或明确确认整文件' : version}</small>
    </div>
  )
}

function Batch({ ai, index }: { ai: GitAiFlow; index: number }) {
  const batch = ai.plan.batches[index]!
  const expanded = ai.analysis!.items.length <= 8 || index === 0
  const merge = (target: number) => {
    const plan = {
      ...ai.plan,
      batches: ai.plan.batches.map((item, i) =>
        i === target ? { ...item, message: `${item.message}\n\n${batch.message}` } : item,
      ),
    }
    ai.setPlan(moveGitAiItems(plan, batch.itemIds, target))
  }
  const actions = [
    {
      label: '整批移入暂不提交',
      run: () => ai.setPlan(moveGitAiItems(ai.plan, batch.itemIds, -1)),
    },
  ]
  if (index > 0) actions.push({ label: '合并到上一批', run: () => merge(index - 1) })
  if (index < ai.plan.batches.length - 1)
    actions.push({ label: '合并到下一批', run: () => merge(index + 1) })
  return (
    <article className="git-ai-batch">
      <header>
        <strong>
          {index + 1} · {batch.itemIds.length} 个文件
        </strong>
        <div>
          <button
            type="button"
            aria-label={`上移批次 ${index + 1}`}
            disabled={!index}
            onClick={() => ai.setPlan(reorderGitAiBatch(ai.plan, index, -1))}
          >
            ↑
          </button>
          <button
            type="button"
            aria-label={`下移批次 ${index + 1}`}
            disabled={index === ai.plan.batches.length - 1}
            onClick={() => ai.setPlan(reorderGitAiBatch(ai.plan, index, 1))}
          >
            ↓
          </button>
          <ActionsMenu label={`调整批次 ${index + 1}`} actions={actions} />
        </div>
      </header>
      <textarea
        aria-label={`批次 ${index + 1} 提交消息`}
        aria-invalid={!batch.message.trim()}
        rows={2}
        maxLength={16000}
        value={batch.message}
        onChange={event =>
          ai.setPlan({
            ...ai.plan,
            batches: ai.plan.batches.map((item, i) =>
              i === index ? { ...item, message: event.target.value } : item,
            ),
          })
        }
      />
      <details open={expanded}>
        <summary>查看 {batch.itemIds.length} 个文件</summary>
        {batch.itemIds.map(id => (
          <FileRow ai={ai} id={id} key={id} editable />
        ))}
      </details>
    </article>
  )
}

function PendingBatch({ ai, index, active }: { ai: GitAiFlow; index: number; active: boolean }) {
  const batch = ai.plan.batches[index]!
  return (
    <article className="git-ai-batch">
      <p>
        {index + 1} · {active ? '正在提交…' : '等待提交'}
      </p>
      <textarea
        aria-label={`批次 ${index + 1} 提交消息`}
        disabled={ai.running}
        value={batch.message}
        onChange={event =>
          ai.setPlan({
            ...ai.plan,
            batches: ai.plan.batches.map((item, i) =>
              i === index ? { ...item, message: event.target.value } : item,
            ),
          })
        }
      />
      {batch.itemIds.map(id => (
        <FileRow key={id} ai={ai} id={id} editable={false} />
      ))}
    </article>
  )
}

function executeLabel(ai: GitAiFlow, confirming: boolean, remaining: number): string {
  if (ai.running) return '正在提交…'
  if (confirming) return '确认创建本地提交'
  if (ai.completed.length) return '重试剩余批次'
  return `按序提交 ${remaining} 批`
}

/** 方案、执行与失败结果共享左栏，不创建遮罩或覆盖主 Diff。 */
export function GitAiReview({
  ai,
  onExit,
  openCommit,
}: {
  ai: GitAiFlow
  onExit(): void
  openCommit(hash: string): Promise<void>
}) {
  const [confirming, setConfirming] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    heading.current?.focus()
  }, [])
  useEffect(() => {
    setConfirming(false)
  }, [ai.plan, ai.stale])
  const done = new Set(ai.completed.flatMap(batch => batch.itemIds))
  const remaining = ai.plan.batches.filter(batch => batch.itemIds.some(id => !done.has(id)))
  const valid =
    remaining.length > 0 &&
    remaining.every(
      batch =>
        batch.message.trim() &&
        batch.itemIds.every(
          id =>
            !ai.analysis!.items.find(item => item.id === id)?.requiresWholeFile ||
            ai.wholeFileIds.includes(id),
        ),
    )
  const editing = !ai.running && ai.completed.length === 0
  return (
    <section
      className="navigation-mode git-ai-review"
      aria-label="AI 提交方案"
      aria-busy={ai.running}
    >
      <header className="git-ai-heading">
        <h3 ref={heading} tabIndex={-1}>
          ✨ AI 提交方案 · {ai.plan.batches.length} 批
        </h3>
        <button
          type="button"
          disabled={ai.running}
          onClick={() => {
            void ai.release(false)
          }}
        >
          重算
        </button>
        <button type="button" aria-label="退出 AI 提交" disabled={ai.running} onClick={onExit}>
          ×
        </button>
      </header>
      <div className="git-ai-batches">
        {ai.stale && (
          <p role="alert" className="git-ai-error">
            工作区内容已更新，请点击「重算」刷新方案后再提交。
          </p>
        )}
        {ai.completed.map(batch => (
          <article className="git-ai-batch" key={batch.commitHash}>
            <p>✓ {batch.message.split('\n')[0]}</p>
            <button
              type="button"
              onClick={() => {
                void openCommit(batch.commitHash)
              }}
            >
              {batch.commitHash.slice(0, 8)}
            </button>
          </article>
        ))}
        {ai.plan.batches.map((batch, index) => {
          if (done.has(batch.itemIds[0]!)) return null
          if (editing) return <Batch key={batch.itemIds.join(',')} ai={ai} index={index} />
          return (
            <PendingBatch
              key={index}
              ai={ai}
              index={index}
              active={ai.running && remaining[0] === batch}
            />
          )
        })}
        <details open={ai.plan.batches.length === 0}>
          <summary>
            暂不提交 · {ai.plan.deferred.length + (ai.analysis?.excluded.length ?? 0)} 个文件
          </summary>
          {ai.plan.deferred.map(id => (
            <FileRow ai={ai} id={id} key={id} editable={editing} />
          ))}
          {ai.analysis?.excluded.map((item, index) => (
            <p className="git-ai-excluded" key={index}>
              <strong>{item.relativePath}</strong>
              <br />⚠ {item.reason}
            </p>
          ))}
        </details>
        {ai.error && (
          <p role="alert" className="git-ai-error">
            {ai.error}
          </p>
        )}
      </div>
      <footer className="git-ai-footer">
        {confirming && (
          <p>将按所示顺序创建 {remaining.length} 个本地提交。不会 push；成功的提交不会自动撤销。</p>
        )}
        <div className="git-ai-actions">
          <button type="button" disabled={ai.running} onClick={onExit}>
            {remaining.length ? '退出' : '完成'}
          </button>
          {remaining.length > 0 && (
            <button
              className="scm-commit-button"
              type="button"
              disabled={ai.running || ai.stale || !valid}
              onClick={() => {
                if (confirming) {
                  setConfirming(false)
                  void ai.execute()
                } else setConfirming(true)
              }}
            >
              {executeLabel(ai, confirming, remaining.length)}
            </button>
          )}
        </div>
      </footer>
    </section>
  )
}
