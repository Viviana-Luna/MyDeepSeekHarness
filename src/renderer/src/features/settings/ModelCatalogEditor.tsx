/**
 * 提供商下属模型编辑器：以只读列表展示可用模型及其能力芯片，并通过弹窗完成拉取、新增与编辑。
 * 运行在 renderer；仅维护当前模型列表的编辑与拉取弹窗状态，保存由外层提供商表单统一提交。
 */
import { Button, Tooltip } from 'antd'
import {
  Brain,
  Cpu,
  Image as ImageIcon,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import { useState } from 'react'
import { isRecord } from '../../../../shared/validation.ts'
import { ModelDiscoveryModal } from './ModelDiscoveryModal.tsx'
import { ModelDraftModal } from './ModelDraftModal.tsx'
import {
  formatReasoningSummary,
  formatTokenCount,
  validateReasoningEfforts,
} from './model-provider-meta.ts'

/** 保留未编辑的模型能力字段，例如 reasoningEfforts、compat 和图片限制。 */
export type ModelDraft = Record<string, unknown> & { id: string }

/** 模型列表编辑器属性。 */
export interface ModelCatalogEditorProps {
  readonly models: readonly ModelDraft[]
  readonly inherited: boolean
  readonly canReset: boolean
  readonly inputField: 'input' | 'inputModalities'
  readonly providerApi?: string
  readonly disabled: boolean
  readonly compact?: boolean
  discover(): Promise<readonly ModelDraft[]>
  onChange(models: ModelDraft[]): void
  onReset(): void
}

/** 将配置或探测结果中的模型数组深拷贝为可编辑草稿，过滤掉缺少字符串 ID 的无效条目。 */
export function modelDrafts(value: unknown): ModelDraft[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((model): model is ModelDraft => isRecord(model) && typeof model.id === 'string')
    .map(model => structuredClone(model))
}

/** 校验模型列表草稿中的必填 ID、重复 ID、正整数容量与思考程度字段，通过时返回 null。 */
export function modelDraftError(models: readonly ModelDraft[]): string | null {
  const ids = new Set<string>()
  for (const [index, model] of models.entries()) {
    const trimmed = model.id.trim()
    if (!trimmed) return `请填写第 ${index + 1} 个模型的 ID。`
    if (ids.has(trimmed)) return `模型 ID 重复：${trimmed}`
    ids.add(trimmed)
    for (const field of ['contextWindow', 'maxTokens']) {
      const value = model[field]
      if (
        value !== undefined &&
        (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
      ) {
        return `第 ${index + 1} 个模型的容量必须是正整数，可使用 K 或 M。`
      }
    }
    const reasoningError = validateReasoningEfforts(
      model.reasoningEfforts,
      `第 ${index + 1} 个模型：`,
    )
    if (reasoningError !== null) return reasoningError
  }
  return null
}

function ModelCatalogRow({
  model,
  inputField,
  disabled,
  onEdit,
  onRemove,
}: {
  readonly model: ModelDraft
  readonly inputField: 'input' | 'inputModalities'
  readonly disabled: boolean
  onEdit(): void
  onRemove(): void
}) {
  const displayName =
    typeof model.name === 'string' && model.name.trim().length > 0 ? model.name.trim() : model.id
  const contextChip = formatTokenCount(model.contextWindow)
  const outputChip = formatTokenCount(model.maxTokens)
  const modalities = model[inputField]
  const supportsImage = Array.isArray(modalities) && modalities.includes('image')
  const reasoningSummary =
    inputField === 'input' ? formatReasoningSummary(model.reasoningEfforts) : null
  const isReasoningDisabled = model.reasoningEfforts === false

  return (
    <li className="models-catalog-row">
      <div className="models-catalog-row__identity">
        <strong title={displayName}>{displayName}</strong>
        <code title={model.id}>{model.id}</code>
      </div>
      <div className="models-catalog-row__tail">
        <div className="models-catalog-row__chips">
          {contextChip !== null && <span className="models-chip">{contextChip} 上下文</span>}
          {outputChip !== null && <span className="models-chip">{outputChip} 输出</span>}
          {supportsImage && (
            <span className="models-chip models-chip--accent">
              <ImageIcon size={11} aria-hidden="true" />
              图片输入
            </span>
          )}
          {reasoningSummary !== null && (
            <span
              className={
                isReasoningDisabled
                  ? 'models-chip models-chip--muted'
                  : 'models-chip models-chip--reasoning'
              }
              title={reasoningSummary}
            >
              {!isReasoningDisabled && <Brain size={11} aria-hidden="true" />}
              {reasoningSummary}
            </span>
          )}
        </div>
        <div className="models-catalog-row__actions">
          <Tooltip title="编辑模型">
            <Button
              size="small"
              type="text"
              className="models-row-icon-btn"
              aria-label={`编辑模型 ${displayName}`}
              disabled={disabled}
              icon={<Pencil size={13} aria-hidden="true" />}
              onClick={onEdit}
            />
          </Tooltip>
          <Tooltip title="移除模型">
            <Button
              size="small"
              type="text"
              danger
              className="models-row-icon-btn"
              aria-label={`移除模型 ${displayName}`}
              disabled={disabled}
              icon={<Trash2 size={13} aria-hidden="true" />}
              onClick={onRemove}
            />
          </Tooltip>
        </div>
      </div>
    </li>
  )
}

function CatalogToolbarHeader({
  count,
  inherited,
  canReset,
  compact,
  busy,
  blocked,
  onReset,
  onDiscover,
  onAdd,
}: {
  readonly count: number
  readonly inherited: boolean
  readonly canReset: boolean
  readonly compact: boolean
  readonly busy: boolean
  readonly blocked: boolean
  onReset(): void
  onDiscover(): void
  onAdd(): void
}) {
  return (
    <header className="models-catalog__header">
      <div className="models-catalog__heading">
        <div className="models-catalog__title-row">
          <strong>模型</strong>
          <span className="settings-count-pill">{count} 个</span>
          <span className="models-source-tag">{inherited ? '提供商默认' : '自定义'}</span>
        </div>
        {!compact && <small>支持从端点拉取模型，或手动添加与调整模型能力参数。</small>}
      </div>
      <div className="models-catalog__toolbar">
        {canReset && !inherited && (
          <Button
            size="small"
            disabled={blocked}
            icon={<RotateCcw size={13} aria-hidden="true" />}
            onClick={onReset}
          >
            恢复默认
          </Button>
        )}
        <Button
          size="small"
          disabled={blocked}
          loading={busy}
          icon={<RefreshCw size={13} aria-hidden="true" />}
          onClick={onDiscover}
        >
          拉取模型
        </Button>
        <Button
          size="small"
          disabled={blocked}
          icon={<Plus size={13} aria-hidden="true" />}
          onClick={onAdd}
        >
          手动添加
        </Button>
      </div>
    </header>
  )
}

/** 展示并管理单个提供商下的模型列表，支持端点拉取、弹窗编辑与恢复默认。 */
export function ModelCatalogEditor({
  models,
  inherited,
  canReset,
  inputField,
  providerApi,
  disabled,
  compact = false,
  discover,
  onChange,
  onReset,
}: ModelCatalogEditorProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [discovered, setDiscovered] = useState<readonly ModelDraft[] | null>(null)
  const [draftTarget, setDraftTarget] = useState<
    { mode: 'add' } | { mode: 'edit'; index: number } | null
  >(null)

  const blocked = disabled || busy
  const existingIdSet = new Set(models.map(model => model.id))
  const editingModel =
    draftTarget !== null && draftTarget.mode === 'edit' ? (models[draftTarget.index] ?? null) : null
  const existingIdsForDraft =
    draftTarget !== null && draftTarget.mode === 'edit'
      ? models.filter((_, index) => index !== draftTarget.index).map(model => model.id)
      : models.map(model => model.id)

  const fetchModels = async () => {
    setBusy(true)
    setError(null)
    try {
      setDiscovered(await discover())
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : '拉取模型失败，请检查地址、协议和 API 密钥。',
      )
    } finally {
      setBusy(false)
    }
  }

  const handleSaveDraft = (saved: ModelDraft) => {
    if (draftTarget === null) return
    if (draftTarget.mode === 'add') onChange([...models, saved])
    else onChange(models.map((item, index) => (index === draftTarget.index ? saved : item)))
    setDraftTarget(null)
  }

  const handleAdoptDiscovered = (picked: ModelDraft[]) => {
    const known = new Set(models.map(model => model.id))
    const appended = picked.filter(model => !known.has(model.id))
    if (appended.length > 0) onChange([...models, ...appended])
    setDiscovered(null)
  }

  return (
    <section
      className={compact ? 'models-catalog models-catalog--compact' : 'models-card models-catalog'}
      aria-label="模型"
    >
      <CatalogToolbarHeader
        count={models.length}
        inherited={inherited}
        canReset={canReset}
        compact={compact}
        busy={busy}
        blocked={blocked}
        onReset={onReset}
        onDiscover={() => {
          void fetchModels()
        }}
        onAdd={() => {
          setDraftTarget({ mode: 'add' })
        }}
      />

      {error !== null && (
        <div className="models-catalog__error">
          <p className="settings-inline-error" role="alert">
            {error}
          </p>
        </div>
      )}

      {models.length === 0 ? (
        <div className="models-empty-box" role="status">
          <Cpu size={18} aria-hidden="true" />
          <strong>暂无模型</strong>
          <small>点击“拉取模型”自动同步，或点击“手动添加”录入模型 ID。</small>
        </div>
      ) : (
        <ul className="models-catalog__list" aria-label="模型列表">
          {models.map((model, index) => (
            <ModelCatalogRow
              key={`${model.id}:${index}`}
              model={model}
              inputField={inputField}
              disabled={blocked}
              onEdit={() => {
                setDraftTarget({ mode: 'edit', index })
              }}
              onRemove={() => {
                onChange(models.filter((_, at) => at !== index))
              }}
            />
          ))}
        </ul>
      )}

      <ModelDraftModal
        open={draftTarget !== null}
        mode={draftTarget?.mode ?? 'add'}
        initialModel={editingModel}
        existingIds={existingIdsForDraft}
        inputField={inputField}
        {...(providerApi === undefined ? {} : { providerApi })}
        disabled={blocked}
        onCancel={() => {
          setDraftTarget(null)
        }}
        onSave={handleSaveDraft}
      />

      <ModelDiscoveryModal
        candidates={discovered}
        existingIds={existingIdSet}
        inputField={inputField}
        disabled={blocked}
        onCancel={() => {
          setDiscovered(null)
        }}
        onConfirm={handleAdoptDiscovered}
      />
    </section>
  )
}
