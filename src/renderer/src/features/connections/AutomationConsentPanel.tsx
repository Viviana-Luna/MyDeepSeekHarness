/**
 * 浏览器与桌面操控交互授权卡片：运行在 renderer，展示待执行动作、目标网址/窗口、风险提示与人工接管引导。
 * 通过 `useWorkspaceStore().respondPendingInteraction` 提交用户决定，不持有浏览器或原生句柄。
 */
import {
  AlertTriangle,
  Check,
  Globe,
  LoaderCircle,
  Monitor,
  ShieldAlert,
  ShieldCheck,
  X,
} from 'lucide-react'
import { useState } from 'react'
import { useWorkspaceStore } from '../../hooks/useWorkspace.ts'
import type { DesktopPendingInteraction, DesktopQuestionItem } from '../../platform/contracts.ts'
import styles from './AutomationConsentPanel.module.css'

const CONSENT_ID_PREFIX = 'mydsh-automation-consent:'
const PREVIEW_MARKER = 'MYDSH_AUTOMATION_PREVIEW_V1:'

/** 解析后的浏览器/桌面自动化确认请求结构。 */
export interface AutomationConsentPrompt {
  readonly id: string
  readonly kind: 'embedded-browser' | 'external-browser' | 'computer-use' | 'handoff'
  readonly header: string
  readonly question: string
  readonly meta: readonly string[]
  readonly previewTitle: string
  readonly previewContent: string
  readonly risks: readonly string[]
  readonly options: NonNullable<DesktopQuestionItem['options']>
}

interface EncodedAutomationPreview {
  kind?: unknown
  title?: unknown
  content?: unknown
  risks?: unknown
  meta?: unknown
}

function decodeBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return ''
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

function parseKind(raw: unknown): AutomationConsentPrompt['kind'] {
  if (raw === 'external-browser' || raw === 'computer-use' || raw === 'handoff') return raw
  return 'embedded-browser'
}

function parsePreview(raw: string): {
  kind: AutomationConsentPrompt['kind']
  title: string
  content: string
  risks: string[]
  meta: string[] | null
} | null {
  try {
    const parsed = JSON.parse(decodeBase64Url(raw)) as EncodedAutomationPreview
    const kind = parseKind(parsed.kind)
    const title = typeof parsed.title === 'string' && parsed.title ? parsed.title : '操作详情'
    const content = typeof parsed.content === 'string' ? parsed.content : ''
    const risks = Array.isArray(parsed.risks)
      ? parsed.risks.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : []
    const meta = Array.isArray(parsed.meta)
      ? parsed.meta.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : null
    return { kind, title, content, risks, meta }
  } catch {
    return null
  }
}

function parseDetail(detail: string) {
  const markerOffset = detail.lastIndexOf(`\n${PREVIEW_MARKER}`)
  if (markerOffset < 0) return null
  const decoded = parsePreview(detail.slice(markerOffset + 1 + PREVIEW_MARKER.length).trim())
  if (!decoded) return null
  let head = detail.slice(0, markerOffset)
  const fenced = head.match(/```[a-z]*\r?\n([\s\S]*)```\s*$/u)
  if (fenced && fenced.index !== undefined) head = head.slice(0, fenced.index)
  // 优先读取编码载荷里的结构化元信息，避免 Markdown 正文被外部页面或窗口标题伪造列表项。
  const meta =
    decoded.meta ??
    head
      .split(/\r?\n/u)
      .map(line => line.replace(/^\s*-\s+/u, '').trim())
      .filter(line => Boolean(line) && !line.startsWith('风险提示：'))
  return {
    meta,
    kind: decoded.kind,
    previewTitle: decoded.title,
    previewContent: decoded.content,
    risks: decoded.risks,
  }
}

/** 识别浏览器控制与桌面 Computer Use 发起的交互授权卡片。 */
export function automationConsentOf(
  interaction: DesktopPendingInteraction,
): AutomationConsentPrompt | null {
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
  if (!parsed) return null
  return {
    id: question.id,
    kind: parsed.kind,
    header: question.header ?? '自动化操作确认',
    question: question.question,
    meta: parsed.meta,
    previewTitle: parsed.previewTitle,
    previewContent: parsed.previewContent,
    risks: parsed.risks,
    options: question.options,
  }
}

function optionStyleKind(label: string): 'deny' | 'session' | 'once' {
  if (label === '拒绝' || label.includes('取消')) return 'deny'
  if (label.includes('本次会话')) return 'session'
  return 'once'
}

const OPTION_CLASS: Record<'deny' | 'session' | 'once', string | undefined> = {
  deny: styles.rejectButton,
  session: styles.secondaryButton,
  once: styles.primaryButton,
}

function optionIcon(kind: 'deny' | 'session' | 'once', pending: boolean) {
  if (pending) return <LoaderCircle className="spin" size={14} aria-hidden="true" />
  if (kind === 'deny') return <X size={14} aria-hidden="true" />
  if (kind === 'session') return <ShieldCheck size={14} aria-hidden="true" />
  return <Check size={14} aria-hidden="true" />
}

function stripIcon(kind: AutomationConsentPrompt['kind']) {
  if (kind === 'computer-use') return <Monitor size={14} aria-hidden="true" />
  if (kind === 'handoff') return <ShieldAlert size={14} aria-hidden="true" />
  return <Globe size={14} aria-hidden="true" />
}

/** 渲染浏览器与桌面操控确认卡片或人工接管继续卡片。 */
export function AutomationConsentPanel({
  sessionId,
  requestKey,
  consent,
}: {
  sessionId: string
  requestKey: string
  consent: AutomationConsentPrompt
}) {
  const store = useWorkspaceStore()
  const [pendingLabel, setPendingLabel] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const busy = pendingLabel !== null

  const decide = async (label: string) => {
    if (busy) return
    setPendingLabel(label)
    setError(null)
    try {
      const receipt = await store.respondPendingInteraction({
        kind: 'question',
        sessionId,
        key: requestKey,
        answers: [{ id: consent.id, selected: [label] }],
      })
      if (!receipt.accepted) {
        setPendingLabel(null)
        setError(
          receipt.reason === 'bad-response'
            ? '未能提交这次自动化授权决定，请稍后重试。'
            : '这条自动化授权请求已失效。',
        )
      }
    } catch (cause) {
      setPendingLabel(null)
      setError(cause instanceof Error ? cause.message : '授权提交失败')
    }
  }

  return (
    <section
      className={`composer-card pending-interaction-card ${styles.card}`}
      aria-label={consent.header}
      data-automation-consent-key={requestKey}
      data-automation-kind={consent.kind}
      aria-busy={busy}
    >
      <div className={styles.strip}>
        {stripIcon(consent.kind)}
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
          <div className={styles.risks} role="note" aria-label="安全提示">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>{consent.risks.join('；')}</span>
          </div>
        )}
        {consent.previewContent && (
          <pre className={styles.preview} aria-label={consent.previewTitle}>
            <code>{consent.previewContent}</code>
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
                {optionIcon(kind, pendingLabel === option.label)}
                {option.label}
              </button>
            )
          })}
        </div>
      </footer>
    </section>
  )
}
