/**
 * 模型拉取结果选择弹窗：展示从服务端点发现的可用模型，支持搜索、全选/反选与去重导入。
 * 运行在 renderer；仅维护临时勾选集合，确认后将选中模型交回父组件草稿。
 */
import { Button, Checkbox, Input, Modal } from 'antd'
import { Cpu, Search } from 'lucide-react'
import { useState } from 'react'
import type { ModelDraft } from './ModelCatalogEditor.tsx'
import { formatTokenCount } from './model-provider-meta.ts'

/** 发现模型选择弹窗参数。 */
export interface ModelDiscoveryModalProps {
  readonly candidates: readonly ModelDraft[] | null
  readonly existingIds: ReadonlySet<string>
  readonly inputField: 'input' | 'inputModalities'
  readonly disabled: boolean
  onCancel(): void
  onConfirm(models: ModelDraft[]): void
}

function DiscoveryModelItem({
  model,
  exists,
  checked,
  inputField,
  disabled,
  onToggle,
}: {
  readonly model: ModelDraft
  readonly exists: boolean
  readonly checked: boolean
  readonly inputField: 'input' | 'inputModalities'
  readonly disabled: boolean
  onToggle(checked: boolean): void
}) {
  const contextChip = formatTokenCount(model.contextWindow)
  const outputChip = formatTokenCount(model.maxTokens)
  const modalities = model[inputField]
  const supportsImage = Array.isArray(modalities) && modalities.includes('image')
  const displayName = typeof model.name === 'string' && model.name ? model.name : model.id

  return (
    <li
      className="models-discovery-item"
      data-exists={exists || undefined}
      data-selected={!exists && checked ? 'true' : undefined}
    >
      <label className="models-discovery-item__label">
        <Checkbox
          disabled={disabled || exists}
          checked={checked}
          onChange={event => {
            onToggle(event.target.checked)
          }}
        />
        <div className="models-discovery-item__copy">
          <div className="models-discovery-item__head">
            <strong>{displayName}</strong>
            {exists && <span className="models-chip models-chip--muted">已添加</span>}
          </div>
          <code>{model.id}</code>
        </div>
        <div className="models-discovery-item__chips">
          {contextChip !== null && <span className="models-chip">{contextChip} 上下文</span>}
          {outputChip !== null && <span className="models-chip">{outputChip} 输出</span>}
          {supportsImage && <span className="models-chip">图片输入</span>}
        </div>
      </label>
    </li>
  )
}

function DiscoveryModalBody({
  candidates,
  existingIds,
  inputField,
  disabled,
  onCancel,
  onConfirm,
}: {
  readonly candidates: readonly ModelDraft[]
  readonly existingIds: ReadonlySet<string>
  readonly inputField: 'input' | 'inputModalities'
  readonly disabled: boolean
  onCancel(): void
  onConfirm(models: ModelDraft[]): void
}) {
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(candidates.filter(model => !existingIds.has(model.id)).map(model => model.id)),
  )

  const keyword = search.trim().toLowerCase()
  const filtered = candidates.filter(model =>
    `${model.id} ${String(model.name ?? '')}`.toLowerCase().includes(keyword),
  )
  const selectableFiltered = filtered.filter(model => !existingIds.has(model.id))

  const selectAllFiltered = () => {
    setSelected(current => {
      const next = new Set(current)
      for (const model of selectableFiltered) next.add(model.id)
      return next
    })
  }

  const invertFiltered = () => {
    setSelected(current => {
      const next = new Set(current)
      for (const model of selectableFiltered) {
        if (next.has(model.id)) next.delete(model.id)
        else next.add(model.id)
      }
      return next
    })
  }

  const toggleModel = (id: string, checked: boolean) => {
    setSelected(current => {
      const next = new Set(current)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const renderContent = () => {
    if (candidates.length === 0) {
      return (
        <div className="models-empty-box" role="status">
          <Cpu size={18} aria-hidden="true" />
          <strong>端点没有返回可用模型</strong>
          <small>你可以关闭弹窗后手动添加模型 ID 与能力参数。</small>
        </div>
      )
    }
    if (filtered.length === 0) {
      return (
        <div className="models-empty-box" role="status">
          <Search size={18} aria-hidden="true" />
          <strong>没有匹配的模型</strong>
          <small>请尝试更换关键词，或清空搜索查看全部结果。</small>
        </div>
      )
    }
    return (
      <ul className="models-discovery-list" aria-label="发现的模型列表">
        {filtered.map(model => {
          const exists = existingIds.has(model.id)
          return (
            <DiscoveryModelItem
              key={model.id}
              model={model}
              exists={exists}
              checked={exists || selected.has(model.id)}
              inputField={inputField}
              disabled={disabled}
              onToggle={checked => {
                toggleModel(model.id, checked)
              }}
            />
          )
        })}
      </ul>
    )
  }

  return (
    <div className="models-discovery-modal">
      <div className="models-discovery-toolbar">
        <Input
          allowClear
          prefix={<Search size={14} className="models-search-icon" aria-hidden="true" />}
          aria-label="搜索发现的模型"
          placeholder="搜索模型名称或 ID"
          value={search}
          onChange={event => {
            setSearch(event.target.value)
          }}
        />
        <div className="models-discovery-batch">
          <Button
            size="small"
            disabled={disabled || selectableFiltered.length === 0}
            onClick={selectAllFiltered}
          >
            全选
          </Button>
          <Button
            size="small"
            disabled={disabled || selectableFiltered.length === 0}
            onClick={invertFiltered}
          >
            反选
          </Button>
        </div>
      </div>

      {renderContent()}

      <div className="models-modal-footer models-modal-footer--split">
        <span className="models-selection-summary">
          已选 <strong>{selected.size}</strong> 个模型
        </span>
        <div className="models-modal-footer__actions">
          <Button onClick={onCancel}>取消</Button>
          <Button
            type="primary"
            disabled={disabled || selected.size === 0}
            onClick={() => {
              onConfirm(
                candidates.filter(model => selected.has(model.id) && !existingIds.has(model.id)),
              )
            }}
          >
            添加所选模型
          </Button>
        </div>
      </div>
    </div>
  )
}

/** 展示模型拉取结果的厚玻璃选择弹窗。 */
export function ModelDiscoveryModal({
  candidates,
  existingIds,
  inputField,
  disabled,
  onCancel,
  onConfirm,
}: ModelDiscoveryModalProps) {
  const open = candidates !== null
  const total = candidates?.length ?? 0

  return (
    <Modal
      open={open}
      centered
      destroyOnHidden
      width={560}
      footer={null}
      title={`选择要添加的模型（${total}）`}
      classNames={{
        container: 'mydsh-glass-dialog models-glass-modal',
        mask: 'mydsh-glass-mask',
      }}
      onCancel={onCancel}
    >
      {candidates !== null && (
        <DiscoveryModalBody
          candidates={candidates}
          existingIds={existingIds}
          inputField={inputField}
          disabled={disabled}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      )}
    </Modal>
  )
}
