/**
 * SSH Agent 操作交互授权卡片：运行在 renderer，展示待执行 Shell 命令或 SFTP Unified Diff 与风险提示。
 * 通过 `useWorkspaceStore().respondPendingInteraction` 提交用户决定，不持有网络连接。
 */
import {
  AlertTriangle,
  Check,
  FileDiff,
  LoaderCircle,
  ShieldCheck,
  Terminal,
  X,
} from 'lucide-react'
import { useState } from 'react'
import { useWorkspaceStore } from '../../hooks/useWorkspace.ts'
import type { DesktopPendingInteraction, DesktopQuestionItem } from '../../platform/contracts.ts'
import styles from './SshConsentPanel.module.css'

const CONSENT_ID_PREFIX = 'mydsh-ssh-consent:'
const PREVIEW_MARKER = 'MYDSH_SSH_PREVIEW_V1:'

/** 解析后的 SSH 授权卡片结构。 */
export interface SshConsentPrompt {
  readonly id: string
  readonly header: string
  readonly question: string
  readonly meta: readonly string[]
  readonly previewKind: 'command' | 'diff'
  readonly previewTitle: string
  readonly previewContent: string
  readonly risks: readonly string[]
  readonly options: NonNullable<DesktopQuestionItem['options']>
}

interface EncodedPreview {
  kind?: unknown
  title?: unknown
  content?: unknown
  risks?: unknown
}

function decodeBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return ''
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

function parseEncodedPreview(raw: string): {
  kind: 'command' | 'diff'
  title: string
  content: string
  risks: string[]
} | null {
  try {
    const parsed = JSON.parse(decodeBase64Url(raw)) as EncodedPreview
    const kind = parsed.kind === 'diff' ? 'diff' : 'command'
    const fallbackTitle = kind === 'diff' ? '远程文件变更预览' : '待执行 SSH 命令'
    const title = typeof parsed.title === 'string' && parsed.title ? parsed.title : fallbackTitle
    const content = typeof parsed.content === 'string' ? parsed.content : ''
    const risks = Array.isArray(parsed.risks)
      ? parsed.risks.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : []
    return { kind, title, content, risks }
  } catch {
    return null
  }
}

function parseDetail(detail: string) {
  const markerOffset = detail.lastIndexOf(`\n${PREVIEW_MARKER}`)
  let head = detail
  let decoded: ReturnType<typeof parseEncodedPreview> = null
  if (markerOffset >= 0) {
    head = detail.slice(0, markerOffset)
    const encoded = detail.slice(markerOffset + 1 + PREVIEW_MARKER.length).trim()
    decoded = parseEncodedPreview(encoded)
  }
  const fenced = head.match(/```(diff|sh)\r?\n([\s\S]*)```\s*$/u)
  if (fenced && fenced.index !== undefined) head = head.slice(0, fenced.index)
  const meta = head
    .split(/\r?\n/u)
    .map(line => line.replace(/^\s*-\s+/u, '').trim())
    .filter(line => Boolean(line) && !line.startsWith('风险提示：'))
  const fallbackKind = fenced?.[1] === 'diff' ? 'diff' : 'command'
  return {
    meta,
    previewKind: decoded?.kind ?? fallbackKind,
    previewTitle:
      decoded?.title ?? (fallbackKind === 'diff' ? '远程文件变更预览' : '待执行 SSH 命令'),
    previewContent: decoded?.content ?? fenced?.[2]?.trim() ?? '',
    risks: decoded?.risks ?? [],
  }
}

/** 识别 SSH Agent 工具发起的交互确认请求；普通问答或数据库确认交由对应面板处理。 */
export function sshConsentOf(interaction: DesktopPendingInteraction): SshConsentPrompt | null {
  if (interaction.kind !== 'question' || interaction.questions.length !== 1) return null
  const question = interaction.questions[0]
  if (
    !question ||
    !question.id.startsWith(CONSENT_ID_PREFIX) ||
    question.multiSelect === true ||
    !question.options?.length
  )
    return null
  const parsed = parseDetail(question.detail ?? '')
  return {
    id: question.id,
    header: question.header ?? 'SSH 操作确认',
    question: question.question,
    meta: parsed.meta,
    previewKind: parsed.previewKind,
    previewTitle: parsed.previewTitle,
    previewContent: parsed.previewContent,
    risks: parsed.risks,
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

function diffLineClass(line: string): string | undefined {
  if (line.startsWith('+++') || line.startsWith('---')) return styles.diffFile
  if (line.startsWith('@@')) return styles.diffHunk
  if (line.startsWith('+')) return styles.diffAdd
  if (line.startsWith('-')) return styles.diffRemove
  return undefined
}

function SshPreviewBlock({
  kind,
  title,
  content,
}: {
  kind: 'command' | 'diff'
  title: string
  content: string
}) {
  if (!content) return null
  if (kind === 'diff') {
    const lines = content.split('\n')
    return (
      <pre className={styles.preview} aria-label={title}>
        <code className={styles.diffCode}>
          {lines.map((line, index) => (
            <span key={index} className={diffLineClass(line)}>
              {line}
              {index + 1 < lines.length ? '\n' : ''}
            </span>
          ))}
        </code>
      </pre>
    )
  }
  return (
    <pre className={styles.preview} aria-label={title}>
      <code>{content}</code>
    </pre>
  )
}

/** 渲染 SSH 命令与远程文件修改单次交互授权卡片。 */
export function SshConsentPanel({
  sessionId,
  requestKey,
  consent,
}: {
  sessionId: string
  requestKey: string
  consent: SshConsentPrompt
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
            ? '未能提交这次 SSH 授权决定，请稍后重试。'
            : '这条 SSH 授权请求已失效。',
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
      data-ssh-consent-key={requestKey}
      aria-busy={busy}
    >
      <div className={styles.strip}>
        {consent.previewKind === 'diff' ? (
          <FileDiff size={14} aria-hidden="true" />
        ) : (
          <Terminal size={14} aria-hidden="true" />
        )}
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
        {consent.risks.length > 0 && (
          <div className={styles.risks} role="note" aria-label="风险提示">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>{consent.risks.join('；')}</span>
          </div>
        )}
        <SshPreviewBlock
          kind={consent.previewKind}
          title={consent.previewTitle}
          content={consent.previewContent}
        />
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
