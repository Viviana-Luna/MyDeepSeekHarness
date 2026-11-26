import { ArrowLeft, FileText, X } from 'lucide-react'
import { useWorkspaceSnapshot, useWorkspaceStore } from '../../hooks/useWorkspace.ts'
import { MessageMarkdown } from '../conversation/MessageMarkdown.tsx'
import { planSummary } from './plan-review.ts'
import styles from './PlanReview.module.css'

export function PlanPreview({ compact = false }: { compact?: boolean }) {
  const store = useWorkspaceStore()
  const snapshot = useWorkspaceSnapshot()
  const preview = snapshot.planPreview
  if (preview === null || preview.sessionId !== snapshot.selectedSessionId) {
    return (
      <section className="workspace-view workspace-empty" aria-label="计划全文">
        <FileText size={24} />
        <p>从待审卡片或会话记录打开计划。</p>
      </section>
    )
  }
  return (
    <section className={styles.preview} aria-label="计划全文" data-plan-id={preview.id}>
      <header className={styles.previewHeader}>
        <FileText size={16} aria-hidden="true" />
        <strong title={planSummary(preview.text).title}>{planSummary(preview.text).title}</strong>
        <button
          type="button"
          aria-label={compact ? '返回对话' : '关闭计划全文'}
          onClick={() => {
            store.closePlanPreview()
          }}
        >
          {compact ? (
            <>
              <ArrowLeft size={16} />
              返回对话
            </>
          ) : (
            <X size={16} />
          )}
        </button>
      </header>
      <div
        className={styles.document}
        tabIndex={0}
        aria-label="计划正文"
        key={`${preview.sessionId}:${preview.id}`}
      >
        <MessageMarkdown text={preview.text} />
      </div>
    </section>
  )
}
