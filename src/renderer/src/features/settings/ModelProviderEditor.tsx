/**
 * 提供商详情编辑页：采用返回式钻取布局，分卡片呈现连接凭据、下属模型与危险移除区。
 * 运行在 renderer；复用 useModelProviderForm 保持设置差分、凭据重试与模型拉取逻辑一致。
 */
import { Button, Input, Modal, Select } from 'antd'
import { ArrowLeft, ChevronRight, KeyRound, ShieldAlert, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { ModelCatalogEditor, type ModelDraft } from './ModelCatalogEditor.tsx'
import {
  asString,
  describeCredentialBadge,
  formatApiProtocol,
  formatEndpointHost,
} from './model-provider-meta.ts'
import { ProviderBrandIcon } from './ProviderBrandIcon.tsx'
import { StatusDot } from './SettingsPrimitives.tsx'
import type { CredentialState, HostModelProvider, HostSettingsNamespace } from './settings-model.ts'
import { useModelProviderForm, type ModelProviderFormState } from './useModelProviderForm.ts'

/** 提供商子详情页属性。 */
export interface ModelProviderEditorProps {
  readonly provider: HostModelProvider
  readonly namespace: HostSettingsNamespace
  readonly taken: readonly string[]
  readonly credentials: Readonly<Record<string, CredentialState>>
  readonly readOnly: boolean
  readonly removable: boolean
  readonly inheritedModels: readonly ModelDraft[]
  onClose(): void
  onRequestRemove(): void
  reload(): Promise<void>
  setCredential(reference: string, secret: string): Promise<boolean>
  unsetCredential(reference: string): Promise<boolean>
}

function resolveFeedbackPill(options: {
  readonly committed: boolean
  readonly busy: boolean
  readonly isDirty: boolean
  readonly readOnly: boolean
}): { readonly label: string; readonly tone: 'warning' | 'accent' | 'neutral' } | null {
  if (options.committed) return { label: '待保存密钥', tone: 'warning' }
  if (options.busy) return { label: '正在保存…', tone: 'neutral' }
  if (options.isDirty) return { label: '未保存更改', tone: 'accent' }
  if (options.readOnly) return { label: '只读模式', tone: 'neutral' }
  return null
}

function ProviderDetailHeader({
  provider,
  baseURL,
  credential,
  feedback,
  busy,
  onBack,
}: {
  readonly provider: HostModelProvider
  readonly baseURL: string
  readonly credential: CredentialState | undefined
  readonly feedback: {
    readonly label: string
    readonly tone: 'warning' | 'accent' | 'neutral'
  } | null
  readonly busy: boolean
  onBack(): void
}) {
  const credBadge = describeCredentialBadge(credential)

  return (
    <header className="models-detail-header">
      <button type="button" className="models-back-button" disabled={busy} onClick={onBack}>
        <ArrowLeft size={15} aria-hidden="true" />
        <span>返回提供商</span>
      </button>

      <div className="models-detail-header__row">
        <div className="models-detail-identity">
          <ProviderBrandIcon
            providerId={provider.provider}
            displayName={provider.displayName}
            baseURL={baseURL}
            size="lg"
          />
          <div className="models-detail-identity__copy">
            <div className="models-provider-title-row">
              <h2 id="settings-model-detail-title">{provider.displayName}</h2>
              {provider.declared && (
                <span className="models-badge models-badge--custom">自定义</span>
              )}
              <span
                className="settings-state-label models-credential-pill"
                data-state={credBadge.state === 'positive' ? 'positive' : undefined}
              >
                <StatusDot state={credBadge.state} />
                {credBadge.label}
              </span>
            </div>
            <code className="models-detail-id">{provider.provider}</code>
          </div>
        </div>

        {feedback !== null && (
          <span className="models-feedback-pill" data-tone={feedback.tone} role="status">
            {feedback.label}
          </span>
        )}
      </div>
    </header>
  )
}

function PresetEndpointCollapse({ form }: { readonly form: ModelProviderFormState }) {
  const [endpointOpen, setEndpointOpen] = useState(
    () => asString(form.draft.baseURL).trim().length > 0,
  )
  const currentEndpointHost = formatEndpointHost(asString(form.draft.baseURL))

  return (
    <div className="models-collapse">
      <button
        type="button"
        className="models-collapse__trigger"
        aria-expanded={endpointOpen}
        onClick={() => {
          setEndpointOpen(current => !current)
        }}
      >
        <ChevronRight
          size={14}
          className={endpointOpen ? 'models-collapse__arrow is-open' : 'models-collapse__arrow'}
          aria-hidden="true"
        />
        <span>自定义 API 地址（可选）</span>
        <small className="models-collapse__summary">
          {currentEndpointHost ?? '默认使用官方地址'}
        </small>
      </button>
      {endpointOpen && (
        <div className="models-collapse__panel">
          <div className="models-field">
            <label className="models-field__label" htmlFor="provider-preset-base-url">
              <span>API 地址</span>
              <span className="models-field__optional">留空恢复默认</span>
            </label>
            <Input
              id="provider-preset-base-url"
              allowClear
              aria-label="API 地址"
              value={asString(form.draft.baseURL)}
              disabled={form.blocked}
              placeholder={asString(form.effective.baseURL) || '使用提供商默认地址'}
              onChange={event => {
                form.setField('baseURL', event.target.value)
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function DeclaredEndpointFields({ form }: { readonly form: ModelProviderFormState }) {
  return (
    <>
      <div className="models-field-grid">
        <div className="models-field">
          <label className="models-field__label" htmlFor="provider-detail-display-name">
            <span>显示名称</span>
          </label>
          <Input
            id="provider-detail-display-name"
            aria-label="提供商显示名称"
            value={asString(form.draft.displayName)}
            disabled={form.blocked}
            placeholder="例如我的提供商"
            onChange={event => {
              form.setField('displayName', event.target.value)
            }}
          />
        </div>

        <div className="models-field">
          <label className="models-field__label" htmlFor="provider-detail-api-protocol">
            <span>API 协议</span>
          </label>
          <Select<string>
            id="provider-detail-api-protocol"
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
        <label className="models-field__label" htmlFor="provider-detail-base-url">
          <span>API 地址</span>
        </label>
        <Input
          id="provider-detail-base-url"
          aria-label="API 地址"
          value={asString(form.draft.baseURL)}
          disabled={form.blocked}
          placeholder={asString(form.effective.baseURL) || 'https://gateway.example/v1'}
          onChange={event => {
            form.setField('baseURL', event.target.value)
          }}
        />
      </div>
    </>
  )
}

function ConnectionCredentialsCard({
  provider,
  form,
  readOnly,
  onOpenRemoveKey,
}: {
  readonly provider: HostModelProvider
  readonly form: ModelProviderFormState
  readonly readOnly: boolean
  onOpenRemoveKey(): void
}) {
  const credBadge = describeCredentialBadge(form.credential)
  const canRemoveKey = form.credential?.configured === true && form.credential.writable

  return (
    <section className="models-card" aria-label="连接与凭据">
      <header className="models-card__header">
        <div>
          <strong>连接与凭据</strong>
          <small>管理此提供商的 API 密钥、请求端点与协议配置。</small>
        </div>
        <span className="models-chip models-chip--muted">
          <KeyRound size={11} aria-hidden="true" />
          {credBadge.storageLabel}
        </span>
      </header>

      <div className="models-card__body">
        <div className="models-field">
          <div className="models-field__label">
            <label htmlFor="provider-detail-api-key">API 密钥</label>
            <code className="models-code-pill">{form.keyRef}</code>
          </div>
          <div className="models-secret-row">
            <Input.Password
              id="provider-detail-api-key"
              aria-label={`${provider.displayName} API 密钥`}
              autoComplete="off"
              spellCheck={false}
              value={form.key}
              disabled={readOnly || form.busy || form.credential?.writable === false}
              placeholder={
                form.credential?.configured
                  ? '已配置，留空保留当前密钥；输入新值替换'
                  : '输入 API 密钥，或留空使用环境认证'
              }
              onChange={event => {
                form.setKey(event.target.value)
              }}
            />
            {canRemoveKey && (
              <Button
                danger
                disabled={form.busy || readOnly}
                icon={<Trash2 size={14} aria-hidden="true" />}
                onClick={onOpenRemoveKey}
              >
                移除密钥
              </Button>
            )}
          </div>
          <small className="models-field__hint">{credBadge.helperText}</small>
        </div>

        {form.declared ? (
          <DeclaredEndpointFields form={form} />
        ) : (
          <PresetEndpointCollapse form={form} />
        )}
      </div>
    </section>
  )
}

function ProviderDangerZone({
  providerName,
  disabled,
  onRequestRemove,
}: {
  readonly providerName: string
  readonly disabled: boolean
  onRequestRemove(): void
}) {
  return (
    <section className="models-card models-card--danger" aria-label="危险操作">
      <div className="models-danger-zone">
        <div className="models-danger-zone__copy">
          <div className="models-danger-zone__title">
            <ShieldAlert size={15} aria-hidden="true" />
            <strong>移除提供商</strong>
          </div>
          <small>
            将移除“{providerName}
            ”的配置与独占密钥，已有会话记录会保留，但使用它的会话需要重新选择模型。
          </small>
        </div>
        <Button
          danger
          disabled={disabled}
          icon={<Trash2 size={14} aria-hidden="true" />}
          onClick={onRequestRemove}
        >
          移除提供商
        </Button>
      </div>
    </section>
  )
}

function RemoveKeyConfirmModal({
  open,
  providerName,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  readonly open: boolean
  readonly providerName: string
  readonly busy: boolean
  readonly error: string | null
  onCancel(): void
  onConfirm(): void
}) {
  return (
    <Modal
      open={open}
      centered
      destroyOnHidden
      width={420}
      title="移除已保存的密钥？"
      okText="确认移除密钥"
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
          移除“{providerName}
          ”的本机密钥后，此提供商需要重新填写密钥或通过环境变量提供认证才能继续发起模型请求。
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

/** 渲染单个已配置提供商的子详情配置页。 */
export function ModelProviderEditor({
  provider,
  namespace,
  taken,
  credentials,
  readOnly,
  removable,
  inheritedModels,
  onClose,
  onRequestRemove,
  reload,
  setCredential,
  unsetCredential,
}: ModelProviderEditorProps) {
  const [confirmRemoveKey, setConfirmRemoveKey] = useState(false)
  const [removingKey, setRemovingKey] = useState(false)
  const [removeKeyError, setRemoveKeyError] = useState<string | null>(null)

  const form = useModelProviderForm({
    provider,
    namespace,
    taken,
    credentials,
    readOnly,
    inheritedModels,
    reload,
    setCredential,
    onSaved: onClose,
  })

  const feedback = resolveFeedbackPill({
    committed: form.committed,
    busy: form.busy,
    isDirty: form.isDirty,
    readOnly,
  })

  const handleBack = () => {
    if (form.committed) void reload()
    onClose()
  }

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    void form.submit()
  }

  const handleConfirmRemoveKey = async () => {
    setRemovingKey(true)
    setRemoveKeyError(null)
    try {
      const ok = await unsetCredential(form.keyRef)
      if (ok) setConfirmRemoveKey(false)
      else setRemoveKeyError('移除密钥未完成，请稍后重试。')
    } finally {
      setRemovingKey(false)
    }
  }

  return (
    <div className="models-detail-view">
      <ProviderDetailHeader
        provider={provider}
        baseURL={form.baseURL}
        credential={form.credential}
        feedback={feedback}
        busy={form.busy}
        onBack={handleBack}
      />

      <form
        className="models-detail-form"
        aria-label={`配置 ${provider.displayName}`}
        onSubmit={handleSubmit}
      >
        <ConnectionCredentialsCard
          provider={provider}
          form={form}
          readOnly={readOnly}
          onOpenRemoveKey={() => {
            setRemoveKeyError(null)
            setConfirmRemoveKey(true)
          }}
        />

        <ModelCatalogEditor
          models={form.models}
          inherited={!form.ownsModels && !form.custom}
          canReset={!form.declared}
          inputField={form.inputField}
          {...(form.declared ? { providerApi: form.api } : {})}
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

        <div className="models-detail-footer">
          <small className="models-detail-footer__hint">
            {form.committed
              ? '配置已写入，仅 API 密钥待重试保存。'
              : '连接设置与模型将在点击保存后统一生效。'}
          </small>
          <div className="models-detail-footer__actions">
            <Button disabled={form.busy} onClick={handleBack}>
              取消
            </Button>
            <Button type="primary" htmlType="submit" loading={form.busy} disabled={readOnly}>
              {form.committed ? '重试保存密钥' : '保存更改'}
            </Button>
          </div>
        </div>
      </form>

      {removable && (
        <ProviderDangerZone
          providerName={provider.displayName}
          disabled={readOnly || form.busy}
          onRequestRemove={onRequestRemove}
        />
      )}

      <RemoveKeyConfirmModal
        open={confirmRemoveKey}
        providerName={provider.displayName}
        busy={removingKey}
        error={removeKeyError}
        onCancel={() => {
          if (!removingKey) setConfirmRemoveKey(false)
        }}
        onConfirm={() => {
          void handleConfirmRemoveKey()
        }}
      />
    </div>
  )
}
