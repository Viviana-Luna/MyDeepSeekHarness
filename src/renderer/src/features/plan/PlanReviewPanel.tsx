import { Check, FileText, LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../../hooks/useWorkspace.ts'
import { planSummary, type planReviewOf } from './plan-review.ts'
import styles from './PlanReview.module.css'

export function PlanReviewPanel({
  sessionId,
  requestKey,
  review,
}: {
  sessionId: string
  requestKey: string
  review: NonNullable<ReturnType<typeof planReviewOf>>
}) {
  const store = useWorkspaceStore()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { title, summary } = planSummary(review.text)
  useEffect(() => {
    store.openPlanPreview(sessionId, review.documentId, review.text, requestKey)
  }, [store, sessionId, requestKey, review.documentId, review.text])
  const decide = async (approve: boolean) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const receipt = await store.respondPendingInteraction(
        approve
          ? {
              kind: 'question',
              sessionId,
              key: requestKey,
              answers: [{ id: review.id, selected: [review.approve] }],
            }
          : { kind: 'question-cancel', sessionId, key: requestKey },
      )
      if (!receipt.accepted) {
        setBusy(false)
        setError(
          receipt.reason === 'bad-response'
            ? '未能提交审阅决定，请重试。'
            : '这份计划已不再等待审阅。',
        )
      }
      // 取消审阅沿用核心的等待输入语义；只有明确批准才退出 Plan。
      if (receipt.accepted && !approve && store.selectedSession()?.sessionId === sessionId) {
        store.closePlanPreview(sessionId, review.documentId)
        requestAnimationFrame(() => {
          if (store.selectedSession()?.sessionId === sessionId)
            document.querySelector<HTMLTextAreaElement>('#composer')?.focus()
        })
      }
    } catch (cause) {
      setBusy(false)
      setError(cause instanceof Error ? cause.message : '审阅提交失败，请重试。')
    }
  }
  return (
    <section
      className={`composer-card pending-interaction-card ${styles.review}`}
      aria-label="计划待审"
      data-plan-review-key={requestKey}
      aria-busy={busy}
    >
      <header className={styles.reviewHeader}>
        <span>
          <FileText size={15} aria-hidden="true" />
          计划待审
        </span>
        <button
          type="button"
          onClick={() => {
            store.openPlanPreview(sessionId, review.documentId, review.text)
          }}
        >
          查看全文
        </button>
      </header>
      <div className={styles.summary}>
        <h2 title={title}>{title}</h2>
        {summary && <p>{summary}</p>}
      </div>
      <footer className={styles.footer}>
        <span role="status">{error ?? '审阅后选择执行，或继续提出修改意见。'}</span>
        <div>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void decide(false)
            }}
          >
            要求修改
          </button>
          <button
            className={styles.approve}
            type="button"
            disabled={busy}
            onClick={() => {
              void decide(true)
            }}
          >
            {busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}同意执行
          </button>
        </div>
      </footer>
    </section>
  )
}
