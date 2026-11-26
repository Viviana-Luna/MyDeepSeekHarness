/**
 * 单条模型草稿编辑弹窗：以厚玻璃弹窗形式新增或修改模型参数，并支持思考程度配置与扩展字段保留。
 * 运行在 renderer；仅维护临时表单草稿，不直接发起 Host 写入。
 */
import { Button, Checkbox, Input, Modal, Segmented, Select } from 'antd'
import { ChevronRight } from 'lucide-react'
import { useState } from 'react'
import type { ModelDraft } from './ModelCatalogEditor.tsx'
import {
  DEFAULT_CUSTOM_THINKING_LEVELS,
  THINKING_FORMAT_OPTIONS,
  THINKING_LEVEL_OPTIONS,
  buildValidatedModelDraft,
  parseInitialReasoning,
  type InitialReasoningState,
  type ReasoningMode,
  type ThinkingLevelKey,
} from './model-provider-meta.ts'

/** 单条模型编辑弹窗参数。 */
export interface ModelDraftModalProps {
  readonly open: boolean
  readonly mode: 'add' | 'edit'
  readonly initialModel: ModelDraft | null
  readonly existingIds: readonly string[]
  readonly inputField: 'input' | 'inputModalities'
  readonly providerApi?: string
  readonly disabled: boolean
  onCancel(): void
  onSave(model: ModelDraft): void
}

function initialCapacityText(value: unknown): string {
  return value === undefined ? '' : String(value)
}

function ModelModalityField({
  modalities,
  disabled,
  onToggle,
  onReset,
}: {
  readonly modalities: readonly string[] | undefined
  readonly disabled: boolean
  onToggle(modality: 'text' | 'image', checked: boolean): void
  onReset(): void
}) {
  const activeModalities = modalities ?? ['text']
  return (
    <div className="models-field">
      <div className="models-field__label">
        <span>输入能力</span>
        {modalities !== undefined && (
          <Button
            type="link"
            size="small"
            className="models-inline-reset"
            disabled={disabled}
            onClick={onReset}
          >
            恢复默认能力
          </Button>
        )}
      </div>
      <div className="models-modality-box">
        <div className="models-modality-checks">
          <Checkbox
            disabled={disabled}
            checked={activeModalities.includes('text')}
            onChange={event => {
              onToggle('text', event.target.checked)
            }}
          >
            文本
          </Checkbox>
          <Checkbox
            disabled={disabled}
            checked={activeModalities.includes('image')}
            onChange={event => {
              onToggle('image', event.target.checked)
            }}
          >
            图片
          </Checkbox>
        </div>
        <small className="models-field__hint">
          {modalities === undefined
            ? '当前继承提供方默认输入能力。'
            : '已自定义输入能力；至少保留一种输入类型。'}
        </small>
      </div>
    </div>
  )
}

function ReasoningWireMappings({
  selectedLevels,
  wireValues,
  disabled,
  onChangeWire,
}: {
  readonly selectedLevels: readonly ThinkingLevelKey[]
  readonly wireValues: Readonly<Partial<Record<ThinkingLevelKey, string>>>
  readonly disabled: boolean
  onChangeWire(level: ThinkingLevelKey, value: string): void
}) {
  const [open, setOpen] = useState(false)
  const ordered = THINKING_LEVEL_OPTIONS.filter(option => selectedLevels.includes(option.key))
  if (ordered.length === 0) return null

  return (
    <div className="models-collapse">
      <button
        type="button"
        className="models-collapse__trigger"
        aria-expanded={open}
        onClick={() => {
          setOpen(current => !current)
        }}
      >
        <ChevronRight
          size={14}
          className={open ? 'models-collapse__arrow is-open' : 'models-collapse__arrow'}
          aria-hidden="true"
        />
        <span>自定义参数映射值（高级）</span>
        <small className="models-collapse__summary">覆写各档位实际发送的参数值</small>
      </button>
      {open && (
        <div className="models-collapse__panel models-wire-grid">
          {ordered.map(option => (
            <label key={option.key} className="models-wire-row">
              <span className="models-wire-row__label">
                <span>{option.label}</span>
                <code>{option.key}</code>
              </span>
              <Input
                size="small"
                className="models-mono-input"
                aria-label={`${option.label}参数映射值`}
                disabled={disabled}
                value={wireValues[option.key] ?? ''}
                placeholder={option.key === 'off' ? '留空表示不传参数' : option.key}
                onChange={event => {
                  onChangeWire(option.key, event.target.value)
                }}
              />
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

function ModelReasoningField({
  mode,
  levels,
  wireValues,
  thinkingFormat,
  providerApi,
  disabled,
  onModeChange,
  onToggleLevel,
  onChangeWire,
  onChangeFormat,
}: {
  readonly mode: ReasoningMode
  readonly levels: readonly ThinkingLevelKey[]
  readonly wireValues: Readonly<Partial<Record<ThinkingLevelKey, string>>>
  readonly thinkingFormat: string | null
  readonly providerApi: string | undefined
  readonly disabled: boolean
  onModeChange(mode: ReasoningMode): void
  onToggleLevel(level: ThinkingLevelKey): void
  onChangeWire(level: ThinkingLevelKey, value: string): void
  onChangeFormat(value: string | null): void
}) {
  const formatUnsupported =
    providerApi !== undefined && providerApi !== '' && providerApi !== 'openai-completions'
  const formatOptions =
    thinkingFormat !== null && !THINKING_FORMAT_OPTIONS.some(item => item.value === thinkingFormat)
      ? [{ value: thinkingFormat, label: thinkingFormat }, ...THINKING_FORMAT_OPTIONS]
      : THINKING_FORMAT_OPTIONS

  return (
    <div className="models-field">
      <div className="models-field__label">
        <span>思考程度</span>
        <span className="models-field__optional">会话可选的推理档位</span>
      </div>
      <div className="models-reasoning-box">
        <Segmented<ReasoningMode>
          block
          size="small"
          aria-label="思考程度模式"
          value={mode}
          disabled={disabled}
          options={[
            { value: 'inherit', label: '默认' },
            { value: 'disabled', label: '不支持' },
            { value: 'custom', label: '自定义档位' },
          ]}
          onChange={onModeChange}
        />

        {mode === 'inherit' && (
          <small className="models-field__hint">沿用提供方内置目录或默认推理配置。</small>
        )}
        {mode === 'disabled' && (
          <small className="models-field__hint">明确关闭思考能力，会话中不展示推理强度切换。</small>
        )}
        {mode === 'custom' && (
          <div className="models-reasoning-custom">
            <div className="models-effort-chips" role="group" aria-label="可选思考档位">
              {THINKING_LEVEL_OPTIONS.map(option => {
                const active = levels.includes(option.key)
                return (
                  <button
                    key={option.key}
                    type="button"
                    className="models-effort-chip"
                    data-active={active || undefined}
                    aria-pressed={active}
                    disabled={disabled}
                    onClick={() => {
                      onToggleLevel(option.key)
                    }}
                  >
                    <span>{option.label}</span>
                    <code>{option.key}</code>
                  </button>
                )
              })}
            </div>

            <div className="models-field">
              <div className="models-field__label">
                <label htmlFor="model-draft-thinking-format">思考参数格式</label>
                <span className="models-field__optional">可选，留空自动识别</span>
              </div>
              <Select<string>
                id="model-draft-thinking-format"
                allowClear
                aria-label="思考参数格式"
                placeholder="自动识别（留空默认）"
                value={thinkingFormat}
                disabled={disabled || (formatUnsupported && thinkingFormat === null)}
                options={[...formatOptions]}
                onChange={value => {
                  onChangeFormat(value ?? null)
                }}
              />
              {formatUnsupported && (
                <small className="models-field__hint">
                  思考参数格式仅适用于 OpenAI 兼容对话协议（openai-completions）。
                </small>
              )}
            </div>

            <ReasoningWireMappings
              selectedLevels={levels}
              wireValues={wireValues}
              disabled={disabled}
              onChangeWire={onChangeWire}
            />
          </div>
        )}
      </div>
    </div>
  )
}

function ModelBasicFields({
  id,
  name,
  contextText,
  maxTokensText,
  disabled,
  onChangeId,
  onChangeName,
  onChangeContext,
  onChangeMaxTokens,
}: {
  readonly id: string
  readonly name: string
  readonly contextText: string
  readonly maxTokensText: string
  readonly disabled: boolean
  onChangeId(value: string): void
  onChangeName(value: string): void
  onChangeContext(value: string): void
  onChangeMaxTokens(value: string): void
}) {
  return (
    <>
      <div className="models-field-grid">
        <div className="models-field">
          <label className="models-field__label" htmlFor="model-draft-id">
            <span>模型 ID</span>
            <span className="models-field__required">必填</span>
          </label>
          <Input
            id="model-draft-id"
            className="models-mono-input"
            autoFocus
            aria-label="模型 ID"
            disabled={disabled}
            value={id}
            placeholder="例如 deepseek-chat 或 gpt-4.1"
            onChange={event => {
              onChangeId(event.target.value)
            }}
          />
        </div>
        <div className="models-field">
          <label className="models-field__label" htmlFor="model-draft-name">
            <span>显示名称</span>
            <span className="models-field__optional">可选</span>
          </label>
          <Input
            id="model-draft-name"
            aria-label="模型显示名称"
            disabled={disabled}
            value={name}
            placeholder="留空时默认使用模型 ID"
            onChange={event => {
              onChangeName(event.target.value)
            }}
          />
        </div>
      </div>

      <div className="models-field-grid">
        <div className="models-field">
          <label className="models-field__label" htmlFor="model-draft-context">
            <span>上下文窗口</span>
          </label>
          <Input
            id="model-draft-context"
            aria-label="上下文窗口"
            disabled={disabled}
            value={contextText}
            placeholder="默认，如 128K / 1M"
            onChange={event => {
              onChangeContext(event.target.value)
            }}
          />
        </div>
        <div className="models-field">
          <label className="models-field__label" htmlFor="model-draft-max-tokens">
            <span>最大输出</span>
          </label>
          <Input
            id="model-draft-max-tokens"
            aria-label="最大输出"
            disabled={disabled}
            value={maxTokensText}
            placeholder="默认，如 8K / 64K"
            onChange={event => {
              onChangeMaxTokens(event.target.value)
            }}
          />
        </div>
      </div>
    </>
  )
}

function ModelDraftFormBody({
  mode,
  initialModel,
  existingIds,
  inputField,
  providerApi,
  disabled,
  onCancel,
  onSave,
}: Omit<ModelDraftModalProps, 'open'>) {
  const [baseModel] = useState<ModelDraft>(() =>
    initialModel === null ? { id: '' } : structuredClone(initialModel),
  )
  const [initialReasoning] = useState<InitialReasoningState>(() => parseInitialReasoning(baseModel))
  const [id, setId] = useState(() => baseModel.id)
  const [name, setName] = useState(() => (typeof baseModel.name === 'string' ? baseModel.name : ''))
  const [contextText, setContextText] = useState(() => initialCapacityText(baseModel.contextWindow))
  const [maxTokensText, setMaxTokensText] = useState(() => initialCapacityText(baseModel.maxTokens))
  const [modalities, setModalities] = useState<readonly string[] | undefined>(() =>
    Array.isArray(baseModel[inputField]) ? [...(baseModel[inputField] as string[])] : undefined,
  )
  const [reasoningMode, setReasoningMode] = useState<ReasoningMode>(() => initialReasoning.mode)
  const [reasoningLevels, setReasoningLevels] = useState<readonly ThinkingLevelKey[]>(
    () => initialReasoning.levels,
  )
  const [wireValues, setWireValues] = useState<Partial<Record<ThinkingLevelKey, string>>>(() => ({
    ...initialReasoning.wireValues,
  }))
  const [thinkingFormat, setThinkingFormat] = useState<string | null>(
    () => initialReasoning.thinkingFormat,
  )
  const [error, setError] = useState<string | null>(null)

  const toggleModality = (modality: 'text' | 'image', checked: boolean) => {
    const active = modalities ?? ['text']
    const next = checked
      ? [...new Set([...active, modality])]
      : active.filter(item => item !== modality)
    if (next.length > 0) setModalities(next)
  }

  const handleReasoningModeChange = (nextMode: ReasoningMode) => {
    setReasoningMode(nextMode)
    if (nextMode === 'custom' && reasoningLevels.length === 0) {
      setReasoningLevels([...DEFAULT_CUSTOM_THINKING_LEVELS])
      setWireValues(current => {
        const next = { ...current }
        for (const level of DEFAULT_CUSTOM_THINKING_LEVELS) {
          if (next[level] === undefined) next[level] = level
        }
        return next
      })
    }
  }

  const handleToggleLevel = (level: ThinkingLevelKey) => {
    const exists = reasoningLevels.includes(level)
    if (exists) {
      setReasoningLevels(current => current.filter(item => item !== level))
      return
    }
    setReasoningLevels(current => [...current, level])
    setWireValues(current => {
      if (current[level] !== undefined) return current
      return { ...current, [level]: level === 'off' ? '' : level }
    })
  }

  const handleSubmit = () => {
    setError(null)
    const outcome = buildValidatedModelDraft({
      baseModel,
      id,
      name,
      contextText,
      maxTokensText,
      modalities,
      reasoningMode,
      reasoningLevels,
      wireValues,
      thinkingFormat,
      existingIds,
      inputField,
    })
    if ('error' in outcome) {
      setError(outcome.error)
      return
    }
    onSave(outcome.draft)
  }

  return (
    <div className="models-modal-form">
      <ModelBasicFields
        id={id}
        name={name}
        contextText={contextText}
        maxTokensText={maxTokensText}
        disabled={disabled}
        onChangeId={setId}
        onChangeName={setName}
        onChangeContext={setContextText}
        onChangeMaxTokens={setMaxTokensText}
      />

      <ModelModalityField
        modalities={modalities}
        disabled={disabled}
        onToggle={toggleModality}
        onReset={() => {
          setModalities(undefined)
        }}
      />

      {inputField === 'input' && (
        <ModelReasoningField
          mode={reasoningMode}
          levels={reasoningLevels}
          wireValues={wireValues}
          thinkingFormat={thinkingFormat}
          providerApi={providerApi}
          disabled={disabled}
          onModeChange={handleReasoningModeChange}
          onToggleLevel={handleToggleLevel}
          onChangeWire={(level, value) => {
            setWireValues(current => ({ ...current, [level]: value }))
          }}
          onChangeFormat={setThinkingFormat}
        />
      )}

      {error !== null && (
        <p className="settings-inline-error" role="alert">
          {error}
        </p>
      )}

      <div className="models-modal-footer">
        <Button onClick={onCancel}>取消</Button>
        <Button type="primary" disabled={disabled} onClick={handleSubmit}>
          {mode === 'add' ? '添加模型' : '保存修改'}
        </Button>
      </div>
    </div>
  )
}

/** 新增或编辑单个模型配置的厚玻璃弹窗。 */
export function ModelDraftModal(props: ModelDraftModalProps) {
  const { open, mode, initialModel, onCancel } = props
  const modalKey = `${mode}:${initialModel?.id ?? 'new'}`

  return (
    <Modal
      open={open}
      centered
      destroyOnHidden
      width={540}
      footer={null}
      title={mode === 'add' ? '手动添加模型' : '编辑模型配置'}
      classNames={{
        container: 'mydsh-glass-dialog models-glass-modal',
        mask: 'mydsh-glass-mask',
      }}
      onCancel={onCancel}
    >
      {open && <ModelDraftFormBody key={modalKey} {...props} />}
    </Modal>
  )
}
