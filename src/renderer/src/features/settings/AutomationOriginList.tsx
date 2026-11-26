/**
 * 浏览器网站规则管理块：运行在 renderer，提供整宽的网站来源输入、批量解析去重与圆角芯片列表。
 * 纯校验逻辑复用 `src/shared/automation.ts` 的 `normalizeOriginRule`，不直接读写主进程配置。
 */
import { Button, Input } from 'antd'
import { AlertCircle, Plus, ShieldBan, X } from 'lucide-react'
import { useState, type ClipboardEvent } from 'react'
import { normalizeOriginRule } from '../../../../shared/automation.ts'

const MAX_ORIGIN_COUNT = 100
const ORIGIN_SPLIT_PATTERN = /[\r\n,，;；\s]+/u

/** 网站规则批量解析结果。 */
export type ParseBatchOriginsResult =
  | { readonly ok: true; readonly nextOrigins: string[]; readonly addedCount: number }
  | { readonly ok: false; readonly error: string }

/**
 * 解析并规范化单条或批量粘贴的网站地址，按协议与源地址校验并自动去重。
 * 支持换行、中英文逗号、分号或空白分隔的多个地址。
 */
export function parseBatchOrigins(
  raw: string,
  existing: readonly string[],
): ParseBatchOriginsResult {
  const tokens = raw
    .split(ORIGIN_SPLIT_PATTERN)
    .map(item => item.trim())
    .filter(Boolean)

  if (tokens.length === 0) {
    return { ok: false, error: '请输入有效的网站地址，例如 https://docs.example.com' }
  }

  const seen = new Set(existing)
  const nextOrigins = [...existing]
  let addedCount = 0

  for (const token of tokens) {
    let normalized: string
    try {
      normalized = normalizeOriginRule(token)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `无法识别网站地址「${token}」，请包含协议头`
      return { ok: false, error: message }
    }
    if (!seen.has(normalized)) {
      seen.add(normalized)
      nextOrigins.push(normalized)
      addedCount += 1
    }
  }

  if (nextOrigins.length > MAX_ORIGIN_COUNT) {
    return { ok: false, error: `最多添加 ${String(MAX_ORIGIN_COUNT)} 条网站规则` }
  }

  if (addedCount === 0) {
    return { ok: false, error: '输入的网站已在当前列表中' }
  }

  return { ok: true, nextOrigins, addedCount }
}

/** 整宽网站白名单 / 黑名单配置块的属性。 */
export interface AutomationOriginListProps {
  readonly title: string
  readonly description: string
  readonly inputAriaLabel: string
  readonly addButtonAriaLabel: string
  readonly placeholder: string
  readonly emptyText: string
  readonly origins: readonly string[]
  readonly saving: boolean
  readonly tone?: 'default' | 'danger'
  readonly badge?: string
  onSave(nextOrigins: string[]): void
}

/**
 * 渲染整宽网站规则管理块：顶部标题说明、全宽输入栏与添加按钮、即时校验提示及可移除圆角芯片。
 */
export function AutomationOriginList({
  title,
  description,
  inputAriaLabel,
  addButtonAriaLabel,
  placeholder,
  emptyText,
  origins,
  saving,
  tone = 'default',
  badge,
  onSave,
}: AutomationOriginListProps) {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  const handleAdd = () => {
    if (saving || !draft.trim()) return
    const parsed = parseBatchOrigins(draft, origins)
    if (!parsed.ok) {
      setError(parsed.error)
      return
    }
    setError(null)
    setDraft('')
    onSave(parsed.nextOrigins)
  }

  const handlePaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData?.getData('text') ?? ''
    if (!/[\r\n]/u.test(pasted)) return
    // 单行输入框默认会直接吞掉换行符，导致多行粘贴的地址黏连；转为逗号分隔保留全部条目。
    event.preventDefault()
    const normalizedPaste = pasted
      .split(/\r?\n/u)
      .map(line => line.trim())
      .filter(Boolean)
      .join(', ')
    const nextDraft = draft.trim() ? `${draft.trim()}, ${normalizedPaste}` : normalizedPaste
    setDraft(nextDraft)
    setError(null)
  }

  const handleRemove = (targetOrigin: string) => {
    if (saving) return
    setError(null)
    onSave(origins.filter(item => item !== targetOrigin))
  }

  const isDanger = tone === 'danger'

  return (
    <div className="automation-block-row" data-tone={isDanger ? 'danger' : undefined}>
      <div className="automation-block-row__surface">
        <div className="automation-block-header">
          <div className="automation-block-header__copy">
            <div className="automation-block-header__title-row">
              {isDanger && (
                <ShieldBan size={15} className="automation-block-header__icon" aria-hidden="true" />
              )}
              <strong>{title}</strong>
              {badge !== undefined && (
                <span
                  className="automation-block-badge"
                  data-tone={isDanger ? 'danger' : undefined}
                >
                  {badge}
                </span>
              )}
              {origins.length > 0 && (
                <span className="automation-block-badge">{origins.length} 项</span>
              )}
            </div>
            <small>{description}</small>
          </div>
        </div>

        <div className="automation-origin-input-row">
          <Input
            allowClear
            aria-label={inputAriaLabel}
            placeholder={placeholder}
            status={error !== null ? 'error' : ''}
            value={draft}
            disabled={saving}
            onPaste={handlePaste}
            onChange={event => {
              setDraft(event.target.value)
              if (error !== null) setError(null)
            }}
            onPressEnter={handleAdd}
          />
          <Button
            aria-label={addButtonAriaLabel}
            icon={<Plus size={14} aria-hidden="true" />}
            disabled={saving || !draft.trim()}
            onClick={handleAdd}
          >
            添加
          </Button>
        </div>

        {error !== null && (
          <p className="automation-inline-error" role="alert">
            <AlertCircle size={13} aria-hidden="true" />
            <span>{error}</span>
          </p>
        )}

        {origins.length === 0 ? (
          <p className="automation-origin-empty">{emptyText}</p>
        ) : (
          <ul className="automation-origin-chips" aria-label={title}>
            {origins.map(origin => (
              <li
                key={origin}
                className="automation-origin-chip"
                data-tone={isDanger ? 'danger' : undefined}
              >
                <span className="automation-origin-chip__label" title={origin}>
                  {origin}
                </span>
                <button
                  type="button"
                  className="automation-origin-chip__remove"
                  aria-label={`移除 ${origin}`}
                  disabled={saving}
                  onClick={() => handleRemove(origin)}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
