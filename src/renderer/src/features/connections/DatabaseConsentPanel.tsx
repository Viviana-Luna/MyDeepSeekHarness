/** 模型请求数据库写入/DDL 变更时的单次交互授权卡片：一次点击批准整批语句或本会话放行。 */
import { Check, Database, LoaderCircle, ShieldCheck, X } from 'lucide-react'
import { useState } from 'react'
import type { DesktopPendingInteraction, DesktopQuestionItem } from '../../platform/contracts.ts'
import { useWorkspaceStore } from '../../hooks/useWorkspace.ts'
import styles from './DatabaseConsentPanel.module.css'

const CONSENT_ID_PREFIX = 'mydsh-database-consent:'
const SQL_PREVIEW_MARKER = 'MYDSH_DATABASE_SQL_PREVIEW_V1:'

/** 解析后的数据库变更确认请求结构。 */
export interface DatabaseConsentPrompt {
  readonly id: string
  readonly header: string
  readonly question: string
  readonly meta: readonly string[]
  readonly sql: string
  readonly options: NonNullable<DesktopQuestionItem['options']>
}

function decodeSqlPreview(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return ''
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

function splitDetailSections(detail: string): { meta: string[]; sql: string } {
  const markerOffset = detail.lastIndexOf(`\n${SQL_PREVIEW_MARKER}`)
  const markerStart = markerOffset < 0 ? -1 : markerOffset + 1
  let sql = ''
  let head = detail
  if (markerStart >= 0) {
    head = detail.slice(0, markerOffset)
    try {
      sql = decodeSqlPreview(detail.slice(markerStart + SQL_PREVIEW_MARKER.length).trim())
    } catch {
      sql = ''
    }
  }
  if (!sql) {
    const fenced = detail.match(/```sql\r?\n([\s\S]*)```\s*$/u)
    sql = fenced?.[1]?.trim() ?? ''
    if (fenced) head = detail.slice(0, fenced.index)
  }
  const meta = head
    .split(/\r?\n/u)
    .map(line => line.replace(/^\s*-\s+/u, '').trim())
    .filter(Boolean)
  return { meta, sql }
}

/** 识别数据库工具发起的同意请求；普通问题或格式不符仍交还通用问答组件处理。 */
export function databaseConsentOf(
  interaction: DesktopPendingInteraction,
): DatabaseConsentPrompt | null {
  if (interaction.kind !== 'question' || interaction.questions.length !== 1) return null
  const question = interaction.questions[0]
  if (
    !question ||
    !question.id.startsWith(CONSENT_ID_PREFIX) ||
    question.multiSelect === true ||
    !question.options?.length
  )
    return null
  const { meta, sql } = splitDetailSections(question.detail ?? '')
  return {
    id: question.id,
    header: question.header ?? '数据库变更确认',
    question: question.question,
    meta,
    sql,
    options: question.options,
  }
}

function optionStyleKind(label: string): 'deny' | 'session' | 'once' {
  if (label === '拒绝') return 'deny'
  if (label.includes('本次会话')) return 'session'
  return 'once'
}

const OPTION_CLASS: Record<'deny' | 'session' | 'once', string | undefined> = {
  deny: styles.rejectButton,
  session: styles.secondaryButton,
  once: styles.primaryButton,
}

function optionIcon(kind: 'deny' | 'session' | 'once', busy: boolean) {
  if (busy && kind === 'once') return <LoaderCircle className="spin" size={14} />
  if (kind === 'deny') return <X size={14} aria-hidden="true" />
  if (kind === 'session') return <ShieldCheck size={14} aria-hidden="true" />
  return <Check size={14} aria-hidden="true" />
}

/** 渲染数据库变更与 DDL 单次授权卡片，展示 SQL 预览与单次点击确认操作。 */
export function DatabaseConsentPanel({
  sessionId,
  requestKey,
  consent,
}: {
  sessionId: string
  requestKey: string
  consent: DatabaseConsentPrompt
}) {
  const store = useWorkspaceStore()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const decide = async (label: string) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const receipt = await store.respondPendingInteraction({
        kind: 'question',
        sessionId,
        key: requestKey,
        answers: [{ id: consent.id, selected: [label] }],
      })
      if (!receipt.accepted) {
        setBusy(false)
        setError(
          receipt.reason === 'bad-response'
            ? '未能提交这次数据库授权决定，请稍后重试。'
            : '这条数据库授权请求已失效。',
        )
      }
    } catch (cause) {
      setBusy(false)
      setError(cause instanceof Error ? cause.message : '授权提交失败')
    }
  }

  return (
    <section
      className={`composer-card pending-interaction-card ${styles.card}`}
      aria-label={consent.header}
      data-database-consent-key={requestKey}
      aria-busy={busy}
    >
      <div className={styles.strip}>
        <Database size={14} aria-hidden="true" />
        <span>{consent.header}</span>
      </div>
      <div className={styles.body}>
        <h2>{consent.question}</h2>
        {consent.meta.length > 0 && (
          <ul className={styles.meta}>
            {consent.meta.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        )}
        {consent.sql && (
          <pre className={styles.sql} aria-label="待执行 SQL 语句">
            <code>{consent.sql}</code>
          </pre>
        )}
      </div>
      <footer className={styles.footer}>
        <div className={styles.feedback} role="status">
          {error}
        </div>
        <div className={styles.actions}>
          {consent.options.map(option => {
            const kind = optionStyleKind(option.label)
            return (
              <button
                key={option.label}
                type="button"
                className={OPTION_CLASS[kind]}
                title={option.description}
                disabled={busy}
                onClick={() => {
                  void decide(option.label)
                }}
              >
                {optionIcon(kind, busy)}
                {option.label}
              </button>
            )
          })}
        </div>
      </footer>
    </section>
  )
}
