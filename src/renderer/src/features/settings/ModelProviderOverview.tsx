/**
 * 模型设置总览子组件：包含会话默认值卡片、提供商卡片与移除提供商确认弹窗。
 * 运行在 renderer；均为纯展示与交互回调组件，不包含持久化副作用。
 */
import { Button, Modal, Tooltip } from 'antd'
import { ChevronRight, Trash2 } from 'lucide-react'
import { Fragment } from 'react'
import type { ModelCatalogModel, ModelProviderGroup } from '../../domain/session-controls.ts'
import { modelDrafts } from './ModelCatalogEditor.tsx'
import {
  asRecordObject,
  decodeModelKey,
  describeCredentialBadge,
  encodeModelKey,
  resolveProviderBrand,
} from './model-provider-meta.ts'
import { ProviderBrandIcon } from './ProviderBrandIcon.tsx'
import { SettingsSection, SettingsSelect, StatusDot } from './SettingsPrimitives.tsx'
import {
  namespaceOf,
  parseModelSelection,
  type CredentialState,
  type HostModelProvider,
  type HostSettingsDocument,
  type HostSettingsPathOperation,
} from './settings-model.ts'

/** 提供商卡片模型信息条目。 */
export interface PreviewModelItem {
  readonly id: string
  readonly name: string
}

/** 根据运行时模型列表或用户配置提取提供商的模型条目，用于统计可用模型数。 */
export function previewModelsFor(
  catalogModels: readonly ModelCatalogModel[] | undefined,
  profileValue: unknown,
): PreviewModelItem[] {
  if (catalogModels !== undefined && catalogModels.length > 0) {
    return catalogModels.map(model => ({ id: model.id, name: model.name || model.id }))
  }
  const fallback = modelDrafts(asRecordObject(profileValue).models)
  return fallback.map(model => ({
    id: model.id,
    name: typeof model.name === 'string' && model.name.trim() ? model.name.trim() : model.id,
  }))
}

/** 渲染「会话默认值」设置卡片，包含默认模型与条件展示的默认推理强度。 */
export function SessionDefaultsSection({
  document,
  groups,
  providers,
  saving,
  mutate,
}: {
  readonly document: HostSettingsDocument | null
  readonly groups: readonly ModelProviderGroup[]
  readonly providers: readonly HostModelProvider[]
  readonly saving: string | null
  mutate(
    namespace: string,
    operations: readonly HostSettingsPathOperation[],
    label?: string,
  ): Promise<boolean>
}) {
  const defaultNamespace = namespaceOf(document, 'agent-default-model')
  const current = parseModelSelection(defaultNamespace?.value)
  const selectedKey = current === null ? '' : encodeModelKey(current)
  const currentGroup =
    current === null ? undefined : groups.find(group => group.id === current.provider)
  const selectedModel = currentGroup?.models.find(model => model.id === current?.model)
  const currentInCatalog = current === null || selectedModel !== undefined
  const providerName =
    current === null
      ? null
      : (currentGroup?.name ??
        providers.find(item => item.provider === current.provider)?.displayName ??
        current.provider)

  const modelOptions = [
    ...(current !== null && !currentInCatalog
      ? [
          {
            value: selectedKey,
            label: `${providerName ?? current.provider} / ${current.model}（未在列表）`,
          },
        ]
      : []),
    ...groups.flatMap(group =>
      group.models.map(model => ({
        value: encodeModelKey({ provider: group.id, model: model.id }),
        label: model.name,
        group: group.name,
      })),
    ),
  ]

  const disabledDefaultModel =
    defaultNamespace === undefined ||
    document?.writable !== true ||
    saving !== null ||
    groups.length === 0

  return (
    <SettingsSection title="会话默认值" description="仅影响随后新建的会话。">
      <div className="models-defaults-card">
        <div className="settings-row">
          <div className="settings-row__copy">
            <strong>默认模型</strong>
            {current === null ? (
              <small>尚未设置默认模型。</small>
            ) : (
              <small className="models-default-meta">
                <span>{providerName}</span>
                <span className="models-default-meta__sep" aria-hidden="true">
                  ·
                </span>
                <code className="models-code-pill">{current.model}</code>
              </small>
            )}
          </div>
          <div className="settings-row__control">
            <SettingsSelect
              label="新会话默认模型"
              value={selectedKey}
              disabled={disabledDefaultModel}
              placeholder="选择默认模型"
              options={modelOptions}
              onChange={value => {
                const next = decodeModelKey(value)
                if (next === null || defaultNamespace === undefined) return
                void mutate(
                  defaultNamespace.ns,
                  [
                    { op: 'set', path: ['provider'], value: next.provider },
                    { op: 'set', path: ['model'], value: next.model },
                    { op: 'unset', path: ['reasoningEffort'] },
                  ],
                  'default-model',
                )
              }}
            />
          </div>
        </div>

        {current !== null && selectedModel?.reasoning !== undefined && (
          <div className="settings-row">
            <div className="settings-row__copy">
              <strong>默认推理强度</strong>
              <small>仅适用于当前默认模型；留空时使用提供商默认值。</small>
            </div>
            <div className="settings-row__control">
              <SettingsSelect
                label="新会话默认推理强度"
                value={current.reasoningEffort ?? ''}
                disabled={
                  defaultNamespace === undefined || document?.writable !== true || saving !== null
                }
                options={[
                  {
                    value: '',
                    label:
                      selectedModel.reasoning.defaultEffort === undefined
                        ? '模型默认'
                        : `模型默认（${selectedModel.reasoning.defaultEffort}）`,
                  },
                  ...selectedModel.reasoning.efforts.map(effort => ({
                    value: effort.id,
                    label: effort.name,
                  })),
                ]}
                onChange={value => {
                  if (defaultNamespace === undefined) return
                  void mutate(
                    defaultNamespace.ns,
                    value === ''
                      ? [{ op: 'unset', path: ['reasoningEffort'] }]
                      : [{ op: 'set', path: ['reasoningEffort'], value }],
                    'default-reasoning',
                  )
                }}
              />
            </div>
          </div>
        )}
      </div>
    </SettingsSection>
  )
}

/** 渲染单个已配置提供商卡片，采用官方品牌标志与单行元信息，支持点击进入下属模型页与可选移除。 */
export function ProviderOverviewCard({
  provider,
  credential,
  endpointHost,
  models,
  removable,
  busy,
  blocked,
  onOpen,
  onRemove,
}: {
  readonly provider: HostModelProvider
  readonly credential: CredentialState | undefined
  readonly endpointHost: string | null
  readonly models: readonly PreviewModelItem[]
  readonly removable: boolean
  readonly busy: boolean
  readonly blocked: boolean
  onOpen(): void
  onRemove(): void
}) {
  const brand = resolveProviderBrand(provider.provider, provider.displayName, endpointHost)
  const credBadge = describeCredentialBadge(credential)
  const metaParts: readonly {
    readonly key: string
    readonly text: string
    readonly mono?: boolean
  }[] = [
    { key: 'id', text: provider.provider, mono: true },
    { key: 'count', text: `${models.length} 个模型` },
    ...(endpointHost === null ? [] : [{ key: 'host', text: endpointHost }]),
  ]
  const metaTitle = metaParts.map(item => item.text).join(' · ')

  return (
    <article className="models-provider-card" data-tone={brand.key}>
      <button
        type="button"
        className="models-provider-card__main settings-provider-summary"
        data-provider-id={provider.provider}
        aria-label={`编辑 ${provider.displayName}`}
        aria-expanded={false}
        disabled={busy}
        onClick={onOpen}
      >
        <ProviderBrandIcon
          providerId={provider.provider}
          displayName={provider.displayName}
          baseURL={endpointHost}
        />

        <div className="models-provider-card__body">
          <div className="models-provider-title-row">
            <strong>{provider.displayName}</strong>
            {provider.declared && <span className="models-badge models-badge--custom">自定义</span>}
            <span
              className="settings-state-label models-credential-pill"
              data-state={credBadge.state === 'positive' ? 'positive' : undefined}
            >
              <StatusDot state={credBadge.state} />
              {credBadge.label}
            </span>
          </div>

          <p className="models-provider-meta-line" title={metaTitle}>
            {metaParts.map((part, index) => (
              <Fragment key={part.key}>
                {index > 0 && (
                  <span className="models-meta-sep" aria-hidden="true">
                    ·
                  </span>
                )}
                {part.mono ? (
                  <span className="models-meta-mono">{part.text}</span>
                ) : (
                  <span>{part.text}</span>
                )}
              </Fragment>
            ))}
          </p>
        </div>

        <span className="models-provider-card__cta" aria-hidden="true">
          <span>配置</span>
          <ChevronRight size={15} />
        </span>
      </button>

      {removable && (
        <div className="models-provider-card__side">
          <Tooltip title="移除提供商">
            <Button
              size="small"
              type="text"
              danger
              className="models-card-delete-btn"
              aria-label={`删除 ${provider.displayName}`}
              disabled={blocked}
              icon={<Trash2 size={14} aria-hidden="true" />}
              onClick={onRemove}
            />
          </Tooltip>
        </div>
      )}
    </article>
  )
}

/** 渲染移除提供商的红色危险确认厚玻璃弹窗。 */
export function RemoveProviderModal({
  provider,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  readonly provider: HostModelProvider | null
  readonly busy: boolean
  readonly error: string | null
  onCancel(): void
  onConfirm(): void
}) {
  return (
    <Modal
      open={provider !== null}
      centered
      destroyOnHidden
      width={440}
      title={provider === null ? '移除提供商' : `移除“${provider.displayName}”？`}
      okText="确认移除提供商"
      cancelText="取消"
      okButtonProps={{ danger: true }}
      confirmLoading={busy}
      cancelButtonProps={{ disabled: busy }}
      closable={!busy}
      mask={{ closable: !busy }}
      classNames={{
        container: 'mydsh-glass-dialog models-glass-modal',
        mask: 'mydsh-glass-mask',
      }}
      onCancel={onCancel}
      onOk={onConfirm}
    >
      <div className="models-danger-modal-body">
        <p>
          将移除此提供商的配置和独占 API
          密钥，已有会话记录会保留。使用该提供商的会话需要重新选择模型。
        </p>
        {error !== null && (
          <p className="settings-inline-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}
