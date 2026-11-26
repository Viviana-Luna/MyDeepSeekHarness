import {
  Check,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  MessageCircleQuestion,
  ShieldAlert,
  X,
} from 'lucide-react'
import { useState } from 'react'
import { useWorkspaceSnapshot, useWorkspaceStore } from '../../hooks/useWorkspace.ts'
import type { DesktopPendingInteraction, DesktopQuestionItem } from '../../platform/contracts.ts'
import styles from './PendingInteractionPanel.module.css'
import { planReviewOf } from '../plan/plan-review.ts'
import { PlanReviewPanel } from '../plan/PlanReviewPanel.tsx'
import {
  automationConsentOf,
  AutomationConsentPanel,
} from '../connections/AutomationConsentPanel.tsx'
import { databaseConsentOf, DatabaseConsentPanel } from '../connections/DatabaseConsentPanel.tsx'
import { sshConsentOf, SshConsentPanel } from '../connections/SshConsentPanel.tsx'

interface QuestionDraft {
  readonly selected: readonly string[]
  readonly custom: string
  readonly skipped: boolean
}

function recommendedLabel(label: string): { readonly text: string; readonly recommended: boolean } {
  const suffix = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/iu
  return suffix.test(label)
    ? { text: label.replace(suffix, ''), recommended: true }
    : { text: label, recommended: false }
}

function answered(draft: QuestionDraft): boolean {
  return draft.skipped || draft.selected.length > 0 || draft.custom.trim() !== ''
}

function QuestionPanel({
  sessionId,
  interaction,
}: {
  sessionId: string
  interaction: Extract<DesktopPendingInteraction, { kind: 'question' }>
}) {
  const store = useWorkspaceStore()
  const questions = interaction.questions
  const [index, setIndex] = useState(0)
  const [drafts, setDrafts] = useState<QuestionDraft[]>(() =>
    questions.map(() => ({
      selected: [],
      custom: '',
      skipped: false,
    })),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const question = questions[index] as DesktopQuestionItem
  const draft = drafts[index] as QuestionDraft

  const updateDraft = (update: (current: QuestionDraft) => QuestionDraft) => {
    setDrafts(current =>
      current.map((item, itemIndex) => (itemIndex === index ? update(item) : item)),
    )
    setError(null)
  }
  const choose = (label: string) => {
    updateDraft(current =>
      question.multiSelect === true
        ? {
            ...current,
            selected: current.selected.includes(label)
              ? current.selected.filter(item => item !== label)
              : [...current.selected, label],
            skipped: false,
          }
        : { selected: [label], custom: '', skipped: false },
    )
    if (question.multiSelect !== true && index < questions.length - 1)
      setIndex(current => current + 1)
  }
  const skip = () => {
    updateDraft(() => ({ selected: [], custom: '', skipped: true }))
    if (index < questions.length - 1) setIndex(current => current + 1)
  }
  const submit = async () => {
    const incomplete = drafts.findIndex(item => !answered(item))
    if (incomplete >= 0) {
      setIndex(incomplete)
      setError('请回答或跳过这个问题。')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const receipt = await store.respondPendingInteraction({
        kind: 'question',
        sessionId,
        key: interaction.key,
        answers: questions.map((item, itemIndex) => {
          const value = drafts[itemIndex] as QuestionDraft
          const custom = value.custom.trim()
          return {
            id: item.id,
            selected: value.skipped ? [] : value.selected,
            ...(value.skipped || custom === '' ? {} : { custom }),
          }
        }),
      })
      if (!receipt.accepted && receipt.reason === 'bad-response') {
        setBusy(false)
        setError('未能提交这份回答，请检查后重试。')
      }
    } catch (cause) {
      setBusy(false)
      setError(cause instanceof Error ? cause.message : '回答提交失败')
    }
  }
  const cancel = async () => {
    setBusy(true)
    setError(null)
    try {
      const receipt = await store.respondPendingInteraction({
        kind: 'question-cancel',
        sessionId,
        key: interaction.key,
      })
      if (!receipt.accepted && receipt.reason === 'bad-response') {
        setBusy(false)
        setError('未能取消请求，请稍后重试。')
      }
    } catch (cause) {
      setBusy(false)
      setError(cause instanceof Error ? cause.message : '取消问题失败')
    }
  }

  return (
    <section
      className={styles.card}
      aria-label={question.question}
      data-question-key={interaction.key}
    >
      <header className={styles.header}>
        <div>
          <h2>{question.question}</h2>
          {question.header && <p className={styles.questionContext}>{question.header}</p>}
        </div>
        <button
          aria-label="关闭问题"
          className={styles.iconButton}
          disabled={busy}
          type="button"
          onClick={() => {
            void cancel()
          }}
        >
          <X size={16} />
        </button>
      </header>
      <div className={styles.body}>
        {question.detail !== undefined && <p className={styles.detail}>{question.detail}</p>}
        {(question.options?.length ?? 0) > 0 && (
          <div
            className={styles.options}
            role={question.multiSelect === true ? 'group' : 'radiogroup'}
            aria-label="可选回答"
          >
            {question.options?.map((option, optionIndex) => {
              const selected = draft.selected.includes(option.label)
              const display = recommendedLabel(option.label)
              return (
                <button
                  aria-checked={selected}
                  className={`${styles.option}${selected ? ` ${styles.optionSelected}` : ''}`}
                  disabled={busy}
                  key={`${option.label}:${String(optionIndex)}`}
                  role={question.multiSelect === true ? 'checkbox' : 'radio'}
                  type="button"
                  onClick={() => {
                    choose(option.label)
                  }}
                >
                  <span className={styles.optionMarker}>
                    {question.multiSelect === true ? (
                      selected ? (
                        <Check size={13} />
                      ) : null
                    ) : (
                      String(optionIndex + 1)
                    )}
                  </span>
                  <span>
                    <strong>{display.text}</strong>
                    {display.recommended && <small className={styles.badge}>推荐</small>}
                    {option.description !== undefined && <em>{option.description}</em>}
                  </span>
                </button>
              )
            })}
          </div>
        )}
        <label className={styles.customAnswer}>
          <span>其他回答</span>
          <textarea
            autoFocus={(question.options?.length ?? 0) === 0}
            disabled={busy}
            maxLength={16_000}
            placeholder="输入你的回答"
            rows={2}
            value={draft.custom}
            onChange={event => {
              const custom = event.currentTarget.value
              updateDraft(current => ({
                selected: question.multiSelect === true ? current.selected : [],
                custom,
                skipped: false,
              }))
            }}
          />
        </label>
      </div>
      <footer className={styles.footer}>
        <div className={styles.pager}>
          <button
            aria-label="上一个问题"
            className={styles.iconButton}
            disabled={busy || index === 0}
            type="button"
            onClick={() => {
              setIndex(current => current - 1)
              setError(null)
            }}
          >
            <ChevronLeft size={16} />
          </button>
          <span>
            {index + 1} / {questions.length}
          </span>
          <button
            aria-label="下一个问题"
            className={styles.iconButton}
            disabled={busy || index === questions.length - 1}
            type="button"
            onClick={() => {
              setIndex(current => current + 1)
              setError(null)
            }}
          >
            <ChevronRight size={16} />
          </button>
        </div>
        <div className={styles.feedback} role="status">
          {error}
        </div>
        <div className={styles.actions}>
          <button className={styles.secondaryButton} disabled={busy} type="button" onClick={skip}>
            跳过此题
          </button>
          <button
            className={styles.primaryButton}
            disabled={busy}
            type="button"
            onClick={() => {
              void submit()
            }}
          >
            {busy && <LoaderCircle className="spin" size={14} />}
            提交回答
          </button>
        </div>
      </footer>
    </section>
  )
}

function ApprovalPanel({
  sessionId,
  interaction,
}: {
  sessionId: string
  interaction: Extract<DesktopPendingInteraction, { kind: 'approval' }>
}) {
  const store = useWorkspaceStore()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const answer = async (outcome: 'allowed-once' | 'rejected') => {
    setBusy(true)
    setError(null)
    try {
      const receipt = await store.respondPendingInteraction({
        kind: 'approval',
        sessionId,
        key: interaction.key,
        outcome,
      })
      if (!receipt.accepted && receipt.reason === 'bad-response') {
        setBusy(false)
        setError('未能提交这项审批决定，请稍后重试。')
      }
    } catch (cause) {
      setBusy(false)
      setError(cause instanceof Error ? cause.message : '审批提交失败')
    }
  }
  return (
    <section
      className={`${styles.card} ${styles.approvalCard}`}
      aria-label="权限审批"
      data-approval-key={interaction.key}
    >
      <div className={styles.approvalStrip}>
        <ShieldAlert size={15} />
        等待权限审批
      </div>
      <div className={styles.approvalBody}>
        <h2>{interaction.reason ?? `工具 ${interaction.toolName} 请求提权执行`}</h2>
        <p>
          <span>工具</span>
          <code>{interaction.toolName}</code>
        </p>
        <p className={styles.approvalNotice}>仅对当前这一次操作作出决定；不会永久放宽会话权限。</p>
      </div>
      <footer className={styles.footer}>
        <div className={styles.feedback} role="status">
          {error}
        </div>
        <div className={styles.actions}>
          <button
            className={styles.rejectButton}
            disabled={busy}
            type="button"
            onClick={() => {
              void answer('rejected')
            }}
          >
            拒绝
          </button>
          <button
            className={styles.primaryButton}
            disabled={busy}
            type="button"
            onClick={() => {
              void answer('allowed-once')
            }}
          >
            {busy && <LoaderCircle className="spin" size={14} />}
            允许一次
          </button>
        </div>
      </footer>
    </section>
  )
}

export function PendingInteractionPanel({
  interaction,
}: {
  interaction: DesktopPendingInteraction
}) {
  const snapshot = useWorkspaceSnapshot()
  const session = snapshot.sessions.find(item => item.sessionId === snapshot.selectedSessionId)
  if (session === undefined) return null
  const review = planReviewOf(interaction)
  if (review !== null)
    return (
      <PlanReviewPanel
        sessionId={session.sessionId}
        requestKey={interaction.key}
        review={review}
        key={`${session.sessionId}:${interaction.key}`}
      />
    )
  const databaseConsent = databaseConsentOf(interaction)
  if (databaseConsent !== null)
    return (
      <DatabaseConsentPanel
        sessionId={session.sessionId}
        requestKey={interaction.key}
        consent={databaseConsent}
        key={`${session.sessionId}:${interaction.key}`}
      />
    )
  const sshConsent = sshConsentOf(interaction)
  if (sshConsent !== null)
    return (
      <SshConsentPanel
        sessionId={session.sessionId}
        requestKey={interaction.key}
        consent={sshConsent}
        key={`${session.sessionId}:${interaction.key}`}
      />
    )
  const automationConsent = automationConsentOf(interaction)
  if (automationConsent !== null)
    return (
      <AutomationConsentPanel
        sessionId={session.sessionId}
        requestKey={interaction.key}
        consent={automationConsent}
        key={`${session.sessionId}:${interaction.key}`}
      />
    )
  return (
    <section
      className="composer-card pending-interaction-card"
      aria-label={interaction.kind === 'approval' ? '权限审批' : '问题回答'}
    >
      <div className={styles.kindLabel}>
        {interaction.kind === 'approval' ? (
          <ShieldAlert size={14} />
        ) : (
          <MessageCircleQuestion size={14} />
        )}
        {interaction.kind === 'approval' ? '智能体请求权限' : '智能体正在等待回答'}
      </div>
      {interaction.kind === 'approval' ? (
        <ApprovalPanel interaction={interaction} sessionId={session.sessionId} />
      ) : (
        <QuestionPanel interaction={interaction} sessionId={session.sessionId} />
      )}
    </section>
  )
}
