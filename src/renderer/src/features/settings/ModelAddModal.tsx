/**
 * 添加提供商弹窗：统一承接「内置提供商」与「自定义提供商」接入流程。
 * 运行在 renderer；通过 useModelProviderForm 复用配置写入、模型拉取与凭据重试契约。
 */
import { Button, Input, Modal, Segmented, Select } from 'antd'
import { ChevronRight } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import type { ModelProviderGroup } from '../../domain/session-controls.ts'
import { ModelCatalogEditor, type ModelDraft } from './ModelCatalogEditor.tsx'
import { asString, describeCredentialBadge, formatApiProtocol } from './model-provider-meta.ts'
import { ProviderBrandIcon } from './ProviderBrandIcon.tsx'
import {
  namespaceOf,
  type CredentialState,
  type HostModelProvider,
  type HostSettingsDocument,
  type HostSettingsNamespace,
} from './settings-model.ts'
import { useModelProviderForm, type ModelProviderFormState } from './useModelProviderForm.ts'

/** 添加提供商弹窗属性。 */
export interface ModelAddModalProps {
  readonly open: boolean
  readonly available: readonly HostModelProvider[]
  readonly customNamespace: HostSettingsNamespace | undefined
  readonly document: HostSettingsDocument | null
  readonly taken: readonly string[]
  readonly credentials: Readonly<Record<string, CredentialState>>
  readonly groups: readonly ModelProviderGroup[]
  readonly readOnly: boolean
  reload(): Promise<void>
  setCredential(reference: string, secret: string): Promise<boolean>
  onCancel(): void
  onAdded(providerId: string): void
}

function CustomProviderFields({
  form,
  readOnly,
}: {
  readonly form: ModelProviderFormState
  readonly readOnly: boolean
}) {
  return (
    <>
      <div className="models-field-grid">
        <div className="models-field">
          <label className="models-field__label" htmlFor="custom-provider-id">
            <span>提供商 ID</span>
            <span className="models-field__required">必填</span>
          </label>
          <Input
            id="custom-provider-id"
            className="models-mono-input"
            autoFocus
            aria-label="提供商 ID"
            value={form.route}
            disabled={form.blocked}
            placeholder="例如 my-gateway"
            onChange={event => {
              form.setRoute(event.target.value)
            }}
          />
          <small className="models-field__hint">小写字母开头，创建后不可修改。</small>
        </div>

        <div className="models-field">
          <label className="models-field__label" htmlFor="custom-provider-name">
            <span>显示名称</span>
            <span className="models-field__optional">可选</span>
          </label>
          <Input
            id="custom-provider-name"
            aria-label="提供商显示名称"
            value={asString(form.draft.displayName)}
            disabled={form.blocked}
            placeholder="例如我的提供商"
            onChange={event => {
              form.setField('displayName', event.target.value)
            }}
          />
        </div>
      </div>

      <div className="models-field-grid">
        <div className="models-field">
          <label className="models-field__label" htmlFor="custom-provider-url">
            <span>API 地址</span>
            <span className="models-field__required">必填</span>
          </label>
          <Input
            id="custom-provider-url"
            aria-label="API 地址"
            value={asString(form.draft.baseURL)}
            disabled={form.blocked}
            placeholder="https://gateway.example/v1"
            onChange={event => {
              form.setField('baseURL', event.target.value)
            }}
          />
        </div>

        <div className="models-field">
          <label className="models-field__label" htmlFor="custom-provider-api">
            <span>API 协议</span>
          </label>
          <Select<string>
            id="custom-provider-api"
            aria-label="API 协议"
            placeholder="选择 API 协议"
            value={form.api || null}
            disabled={form.blocked || form.protocols.length === 0}
            options={form.protocols.map(value => ({
              value,
              label: formatApiProtocol(value),
            }))}
            onChange={value => {
              form.setField('api', value)
            }}
          />
        </div>
      </div>

      <div className="models-field">
        <div className="models-field__label">
          <label htmlFor="custom-provider-key">API 密钥</label>
          <span className="models-field__optional">保存在本机私有凭据文件</span>
        </div>
        <Input.Password
          id="custom-provider-key"
          aria-label="自定义提供商 API 密钥"
          autoComplete="off"
          spellCheck={false}
          value={form.key}
          disabled={readOnly || form.busy}
          placeholder="输入 API 密钥，或留空使用环境认证"
          onChange={event => {
            form.setKey(event.target.value)
          }}
        />
      </div>
    </>
  )
}

function PresetProviderAddForm({
  provider,
  namespace,
  taken,
  credentials,
  inheritedModels,
  readOnly,
  reload,
  setCredential,
  onLockChange,
  onCancel,
  onAdded,
}: {
  readonly provider: HostModelProvider
  readonly namespace: HostSettingsNamespace
  readonly taken: readonly string[]
  readonly credentials: Readonly<Record<string, CredentialState>>
  readonly inheritedModels: readonly ModelDraft[]
  readonly readOnly: boolean
  reload(): Promise<void>
  setCredential(reference: string, secret: string): Promise<boolean>
  onLockChange(locked: boolean): void
  onCancel(): void
  onAdded(providerId: string): void
}) {
  const [showEndpoint, setShowEndpoint] = useState(false)
  const form = useModelProviderForm({
    provider,
    namespace,
    taken,
    credentials,
    readOnly,
    inheritedModels,
    reload,
    setCredential,
    onSaved: () => {
      onAdded(provider.provider)
    },
  })
  const credBadge = describeCredentialBadge(form.credential)

  useEffect(() => {
    onLockChange(form.busy || form.committed)
  }, [form.busy, form.committed, onLockChange])

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    void form.submit()
  }

  return (
    <form
      className="models-modal-form"
      aria-label={`添加 ${provider.displayName}`}
      onSubmit={handleSubmit}
    >
      <div className="models-selected-preview">
        <ProviderBrandIcon
          providerId={provider.provider}
          displayName={provider.displayName}
          baseURL={form.baseURL}
        />
        <div className="models-selected-preview__copy">
          <strong>{provider.displayName}</strong>
          <code>{provider.provider}</code>
        </div>
        <span className="models-chip models-chip--muted">{form.keyRef}</span>
      </div>

      <div className="models-field">
        <div className="models-field__label">
          <label htmlFor="preset-add-api-key">API 密钥</label>
          <span className="models-field__optional">可选，可稍后配置</span>
        </div>
        <Input.Password
          id="preset-add-api-key"
          aria-label={`${provider.displayName} API 密钥`}
          autoComplete="off"
          spellCheck={false}
          value={form.key}
          disabled={readOnly || form.busy || form.credential?.writable === false}
          placeholder="输入 API 密钥，或先留空稍后在详情页填写"
          onChange={event => {
            form.setKey(event.target.value)
          }}
        />
        <small className="models-field__hint">{credBadge.helperText}</small>
      </div>

      <div className="models-collapse">
        <button
          type="button"
          className="models-collapse__trigger"
          aria-expanded={showEndpoint}
          onClick={() => {
            setShowEndpoint(current => !current)
          }}
        >
          <ChevronRight
            size={14}
            className={showEndpoint ? 'models-collapse__arrow is-open' : 'models-collapse__arrow'}
            aria-hidden="true"
          />
          <span>自定义 API 地址（可选）</span>
        </button>
        {showEndpoint && (
          <div className="models-collapse__panel">
            <Input
              aria-label="API 地址"
              value={asString(form.draft.baseURL)}
              disabled={form.blocked}
              placeholder={asString(form.effective.baseURL) || '使用提供商默认地址'}
              onChange={event => {
                form.setField('baseURL', event.target.value)
              }}
            />
          </div>
        )}
      </div>

      {form.error !== null && (
        <p className="settings-inline-error" role="alert">
          {form.error}
        </p>
      )}

      <div className="models-modal-footer">
        <Button
          disabled={form.busy}
          onClick={() => {
            if (form.committed) void reload()
            onCancel()
          }}
        >
          取消
        </Button>
        <Button type="primary" htmlType="submit" loading={form.busy} disabled={readOnly}>
          {form.committed ? '重试保存密钥' : '添加提供商'}
        </Button>
      </div>
    </form>
  )
}

function CustomProviderAddForm({
  namespace,
  taken,
  credentials,
  readOnly,
  reload,
  setCredential,
  onLockChange,
  onCancel,
  onAdded,
}: {
  readonly namespace: HostSettingsNamespace
  readonly taken: readonly string[]
  readonly credentials: Readonly<Record<string, CredentialState>>
  readonly readOnly: boolean
  reload(): Promise<void>
  setCredential(reference: string, secret: string): Promise<boolean>
  onLockChange(locked: boolean): void
  onCancel(): void
  onAdded(providerId: string): void
}) {
  const form = useModelProviderForm({
    provider: null,
    namespace,
    taken,
    credentials,
    readOnly,
    inheritedModels: [],
    reload,
    setCredential,
    onSaved: () => {
      onAdded(form.route)
    },
  })

  useEffect(() => {
    onLockChange(form.busy || form.committed)
  }, [form.busy, form.committed, onLockChange])

  return (
    <form
      className="models-modal-form"
      aria-label="添加自定义提供商"
      onSubmit={event => {
        event.preventDefault()
        void form.submit()
      }}
    >
      <CustomProviderFields form={form} readOnly={readOnly} />

      <ModelCatalogEditor
        compact
        models={form.models}
        inherited={false}
        canReset={false}
        inputField={form.inputField}
        providerApi={form.api}
        disabled={form.blocked}
        discover={form.discover}
        onChange={next => {
          form.setField('models', next)
        }}
        onReset={() => {
          form.setField('models', undefined)
        }}
      />

      {form.error !== null && (
        <p className="settings-inline-error" role="alert">
          {form.error}
        </p>
      )}

      <div className="models-modal-footer">
        <Button
          disabled={form.busy}
          onClick={() => {
            if (form.committed) void reload()
            onCancel()
          }}
        >
          取消
        </Button>
        <Button type="primary" htmlType="submit" loading={form.busy} disabled={readOnly}>
          {form.committed ? '重试保存密钥' : '创建提供商'}
        </Button>
      </div>
    </form>
  )
}

function ModelAddModalContent(
  props: Omit<ModelAddModalProps, 'open'> & { onLockChange(locked: boolean): void },
) {
  const { available, customNamespace, document, taken, credentials, groups, readOnly } = props
  const defaultMode: 'preset' | 'custom' = available.length > 0 ? 'preset' : 'custom'
  const [mode, setMode] = useState<'preset' | 'custom'>(defaultMode)
  const [selectedId, setSelectedId] = useState(() => available[0]?.provider ?? '')
  const [locked, setLocked] = useState(false)

  const syncLock = (next: boolean) => {
    setLocked(next)
    props.onLockChange(next)
  }

  const activePreset = available.find(item => item.provider === selectedId) ?? available[0] ?? null
  const presetNamespace =
    activePreset === null ? undefined : namespaceOf(document, activePreset.settingsNs)
  const presetInherited =
    activePreset === null
      ? []
      : (groups.find(group => group.id === activePreset.provider)?.models ?? []).map(model => ({
          id: model.id,
          name: model.name,
        }))

  return (
    <div className="models-add-modal">
      <Segmented<'preset' | 'custom'>
        block
        value={mode}
        disabled={locked}
        options={[
          { value: 'preset', label: '内置提供商', disabled: available.length === 0 },
          { value: 'custom', label: '自定义提供商', disabled: customNamespace === undefined },
        ]}
        onChange={next => {
          setMode(next)
        }}
      />

      {mode === 'preset' && activePreset !== null && presetNamespace !== undefined && (
        <>
          <div className="models-field">
            <label className="models-field__label" htmlFor="preset-provider-select">
              <span>选择提供商</span>
              <span className="models-field__optional">共 {available.length} 个可添加</span>
            </label>
            <Select<string>
              id="preset-provider-select"
              showSearch
              optionFilterProp="label"
              aria-label="选择提供商"
              value={activePreset.provider}
              disabled={locked}
              options={available.map(provider => ({
                value: provider.provider,
                label:
                  provider.displayName === provider.provider
                    ? provider.displayName
                    : `${provider.displayName} (${provider.provider})`,
                provider,
              }))}
              optionRender={option => {
                const item = option.data.provider
                return (
                  <span className="models-select-option">
                    <ProviderBrandIcon
                      providerId={item.provider}
                      displayName={item.displayName}
                      size="sm"
                    />
                    <span className="models-select-option__label">{option.data.label}</span>
                  </span>
                )
              }}
              onChange={setSelectedId}
            />
          </div>

          <PresetProviderAddForm
            key={activePreset.provider}
            provider={activePreset}
            namespace={presetNamespace}
            taken={taken}
            credentials={credentials}
            inheritedModels={presetInherited}
            readOnly={readOnly}
            reload={props.reload}
            setCredential={props.setCredential}
            onLockChange={syncLock}
            onCancel={props.onCancel}
            onAdded={props.onAdded}
          />
        </>
      )}

      {mode === 'custom' && customNamespace !== undefined && (
        <CustomProviderAddForm
          key="custom"
          namespace={customNamespace}
          taken={taken}
          credentials={credentials}
          readOnly={readOnly}
          reload={props.reload}
          setCredential={props.setCredential}
          onLockChange={syncLock}
          onCancel={props.onCancel}
          onAdded={props.onAdded}
        />
      )}
    </div>
  )
}

/** 统一添加内置与自定义提供商的厚玻璃弹窗。 */
export function ModelAddModal(props: ModelAddModalProps) {
  const [locked, setLocked] = useState(false)

  return (
    <Modal
      open={props.open}
      centered
      destroyOnHidden
      width={600}
      footer={null}
      closable={!locked}
      mask={{ closable: !locked }}
      title="添加提供商"
      classNames={{
        container: 'mydsh-glass-dialog models-glass-modal',
        mask: 'mydsh-glass-mask',
      }}
      onCancel={() => {
        if (!locked) props.onCancel()
      }}
    >
      {props.open && <ModelAddModalContent {...props} onLockChange={setLocked} />}
    </Modal>
  )
}
