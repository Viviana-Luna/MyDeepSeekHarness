/**
 * 模型设置页：以「提供方卡片总览 + 返回式子详情页」管理默认模型、服务提供方与凭据。
 * 运行在 renderer；通过工作台 Store 与设置中心回调完成配置读写，不直接操作本地凭据文件。
 */
import { Button } from 'antd'
import { Plus, Server } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useWorkspaceStore } from '../../hooks/useWorkspace.ts'
import { ModelAddModal } from './ModelAddModal.tsx'
import { ModelProviderEditor } from './ModelProviderEditor.tsx'
import {
  ProviderOverviewCard,
  RemoveProviderModal,
  SessionDefaultsSection,
  previewModelsFor,
} from './ModelProviderOverview.tsx'
import {
  asRecordObject,
  asString,
  formatEndpointHost,
  isProviderRemovable,
} from './model-provider-meta.ts'
import { CapabilityNotice } from './SettingsPrimitives.tsx'
import {
  namespaceOf,
  providerKeyRef,
  valueAtPath,
  type CredentialState,
  type HostModelCatalog,
  type HostModelProvider,
  type HostSettingsDocument,
  type HostSettingsPathOperation,
} from './settings-model.ts'
import './models-settings.css'

/** 模型设置页组件属性。 */
export interface ModelsSettingsProps {
  readonly document: HostSettingsDocument | null
  readonly modelCatalog: HostModelCatalog | null
  readonly providers: readonly HostModelProvider[]
  readonly credentials: Readonly<Record<string, CredentialState>>
  readonly saving: string | null
  mutate(
    namespace: string,
    operations: readonly HostSettingsPathOperation[],
    label?: string,
  ): Promise<boolean>
  setCredential(reference: string, secret: string): Promise<boolean>
  unsetCredential(reference: string): Promise<boolean>
  reload(): Promise<void>
}

async function removeProviderWithCredentials(options: {
  readonly store: ReturnType<typeof useWorkspaceStore>
  readonly removing: HostModelProvider
  readonly document: HostSettingsDocument | null
  readonly configured: readonly HostModelProvider[]
  readonly credentials: Readonly<Record<string, CredentialState>>
}): Promise<void> {
  const { store, removing, document, configured, credentials } = options
  const namespace = namespaceOf(document, removing.settingsNs)
  if (namespace === undefined) return
  const ref = providerKeyRef(removing.provider, valueAtPath(namespace.value, removing.settingsPath))
  const shared = configured.some(
    provider =>
      provider.provider !== removing.provider &&
      providerKeyRef(
        provider.provider,
        valueAtPath(namespaceOf(document, provider.settingsNs)?.value, provider.settingsPath),
      ) === ref,
  )
  // 共用密钥仍有消费者时保留；独占密钥先删除，失败时保留提供方以便重试。
  if (!shared && credentials[ref]?.configured && credentials[ref]?.writable) {
    await store.callHost('unsetCredential', { ref })
  }
  await store.callHost('mutateSettings', {
    ns: namespace.ns,
    expectedRevision: namespace.revision,
    ops: [{ op: 'unset', path: removing.settingsPath }],
  })
}

function ConfiguredProvidersSection({
  document,
  configured,
  groupModelsByProvider,
  credentials,
  removeBusy,
  blocked,
  canAddAny,
  onAdd,
  onOpen,
  onRemove,
}: {
  readonly document: HostSettingsDocument | null
  readonly configured: readonly HostModelProvider[]
  readonly groupModelsByProvider: ReadonlyMap<
    string,
    NonNullable<HostModelCatalog>['groups'][number]['models']
  >
  readonly credentials: Readonly<Record<string, CredentialState>>
  readonly removeBusy: boolean
  readonly blocked: boolean
  readonly canAddAny: boolean
  onAdd(): void
  onOpen(providerId: string): void
  onRemove(provider: HostModelProvider): void
}) {
  return (
    <section className="settings-section">
      <header className="settings-section__header-row">
        <div className="settings-section__header">
          <div className="models-section-title-row">
            <h3>模型服务</h3>
            {configured.length > 0 && (
              <span className="settings-count-pill">共 {configured.length} 项</span>
            )}
          </div>
          <p>点击服务卡片管理 API 密钥、自定义端点与可用模型目录。</p>
        </div>
        <Button
          type="primary"
          icon={<Plus size={14} aria-hidden="true" />}
          disabled={blocked || !canAddAny}
          onClick={onAdd}
        >
          添加提供方
        </Button>
      </header>

      <div className="models-provider-list">
        {configured.map(provider => {
          const namespace = namespaceOf(document, provider.settingsNs)
          const profileValue = valueAtPath(namespace?.value, provider.settingsPath)
          const userProfile = asRecordObject(valueAtPath(namespace?.user, provider.settingsPath))
          const effectiveProfile = asRecordObject(profileValue)
          const ref = providerKeyRef(provider.provider, profileValue)
          const endpointHost = formatEndpointHost(
            provider.declared ? asString(effectiveProfile.baseURL) : asString(userProfile.baseURL),
          )
          const models = previewModelsFor(
            groupModelsByProvider.get(provider.provider),
            profileValue,
          )
          return (
            <ProviderOverviewCard
              key={provider.provider}
              provider={provider}
              credential={credentials[ref]}
              endpointHost={endpointHost}
              models={models}
              removable={isProviderRemovable(provider, namespace)}
              busy={removeBusy}
              blocked={blocked}
              onOpen={() => {
                onOpen(provider.provider)
              }}
              onRemove={() => {
                onRemove(provider)
              }}
            />
          )
        })}

        {configured.length === 0 && (
          <div className="models-empty-card" role="status">
            <span className="models-empty-card__badge" aria-hidden="true">
              <Server size={20} />
            </span>
            <strong>尚未配置模型服务</strong>
            <small>点击右上角“添加提供方”接入预置服务或自定义兼容端点。</small>
          </div>
        )}
      </div>
    </section>
  )
}

function useProviderDrilldownFocus(
  pageRef: RefObject<HTMLDivElement | null>,
  activeProviderId: string | null,
) {
  const previousActiveRef = useRef<string | null>(null)
  useEffect(() => {
    if (activeProviderId !== null) {
      pageRef.current?.closest('.settings-content')?.scrollTo?.(0, 0)
      pageRef.current?.querySelector<HTMLElement>('.models-back-button')?.focus()
    } else if (previousActiveRef.current !== null) {
      const targetId = previousActiveRef.current
      const trigger = Array.from(
        pageRef.current?.querySelectorAll<HTMLElement>('[data-provider-id]') ?? [],
      ).find(node => node.dataset.providerId === targetId)
      trigger?.focus()
    }
    previousActiveRef.current = activeProviderId
  }, [activeProviderId, pageRef])
}

function resolveConfiguredProviders(
  providers: readonly HostModelProvider[],
  document: HostSettingsDocument | null,
): HostModelProvider[] {
  return providers.filter(provider => {
    const namespace = namespaceOf(document, provider.settingsNs)
    if (!namespace) return provider.active
    return (
      provider.settingsPath.length === 0 ||
      valueAtPath(namespace.value, provider.settingsPath) !== undefined
    )
  })
}

function ModelsOverviewContent({
  pageRef,
  document,
  modelCatalog,
  groups,
  providers,
  configured,
  available,
  customNamespace,
  groupModelsByProvider,
  credentials,
  saving,
  readOnly,
  blocked,
  canAddAny,
  addOpen,
  removeBusy,
  mutate,
  setCredential,
  reload,
  onOpenAdd,
  onCloseAdd,
  onOpenProvider,
  onRemoveProvider,
  removeModal,
}: {
  readonly pageRef: RefObject<HTMLDivElement | null>
  readonly document: HostSettingsDocument | null
  readonly modelCatalog: HostModelCatalog | null
  readonly groups: NonNullable<HostModelCatalog>['groups']
  readonly providers: readonly HostModelProvider[]
  readonly configured: readonly HostModelProvider[]
  readonly available: readonly HostModelProvider[]
  readonly customNamespace: ReturnType<typeof namespaceOf>
  readonly groupModelsByProvider: ReadonlyMap<
    string,
    NonNullable<HostModelCatalog>['groups'][number]['models']
  >
  readonly credentials: Readonly<Record<string, CredentialState>>
  readonly saving: string | null
  readonly readOnly: boolean
  readonly blocked: boolean
  readonly canAddAny: boolean
  readonly addOpen: boolean
  readonly removeBusy: boolean
  mutate: ModelsSettingsProps['mutate']
  setCredential: ModelsSettingsProps['setCredential']
  reload: ModelsSettingsProps['reload']
  onOpenAdd(): void
  onCloseAdd(): void
  onOpenProvider(providerId: string): void
  onRemoveProvider(provider: HostModelProvider): void
  readonly removeModal: ReactNode
}) {
  return (
    <div
      ref={pageRef}
      className="settings-page models-page"
      aria-labelledby="settings-models-title"
    >
      <header className="settings-page__heading">
        <h2 id="settings-models-title">模型</h2>
        <p>配置默认对话模型、服务提供方与 API 密钥。</p>
      </header>
      {document === null && (
        <CapabilityNotice title="模型设置暂不可用" tone="warning">
          运行核心就绪后即可读取提供方和模型目录。
        </CapabilityNotice>
      )}
      <SessionDefaultsSection
        document={document}
        groups={groups}
        providers={providers}
        saving={saving}
        mutate={mutate}
      />
      {modelCatalog !== null && modelCatalog.failures.length > 0 && (
        <CapabilityNotice title="部分模型目录加载失败" tone="warning">
          {modelCatalog.failures.map(failure => `${failure.name}：${failure.message}`).join('；')}
        </CapabilityNotice>
      )}
      <ConfiguredProvidersSection
        document={document}
        configured={configured}
        groupModelsByProvider={groupModelsByProvider}
        credentials={credentials}
        removeBusy={removeBusy}
        blocked={blocked}
        canAddAny={canAddAny}
        onAdd={onOpenAdd}
        onOpen={onOpenProvider}
        onRemove={onRemoveProvider}
      />
      <ModelAddModal
        open={addOpen}
        available={available}
        customNamespace={customNamespace}
        document={document}
        taken={providers.map(item => item.provider)}
        credentials={credentials}
        groups={groups}
        readOnly={readOnly}
        reload={reload}
        setCredential={setCredential}
        onCancel={onCloseAdd}
        onAdded={onCloseAdd}
      />
      {removeModal}
    </div>
  )
}

/** 渲染「模型」设置页，支持提供方卡片总览、新增弹窗与点击进入子详情页编辑。 */
export function ModelsSettings({
  document,
  modelCatalog,
  providers,
  credentials,
  saving,
  mutate,
  setCredential,
  unsetCredential,
  reload,
}: ModelsSettingsProps) {
  const store = useWorkspaceStore()
  const [activeProviderId, setActiveProviderId] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [removing, setRemoving] = useState<HostModelProvider | null>(null)
  const [removeBusy, setRemoveBusy] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const pageRef = useRef<HTMLDivElement>(null)

  const groups = modelCatalog?.groups ?? []
  const groupModelsByProvider = useMemo(
    () => new Map(groups.map(group => [group.id, group.models] as const)),
    [groups],
  )
  const configured = resolveConfiguredProviders(providers, document)
  const available = providers.filter(
    provider =>
      !configured.includes(provider) && namespaceOf(document, provider.settingsNs) !== undefined,
  )
  const customNamespace = namespaceOf(document, 'llm-pi-ai')
  const readOnly = document?.writable !== true
  const blocked = readOnly || saving !== null || removeBusy
  const canAddAny = available.length > 0 || customNamespace !== undefined
  const activeProvider =
    activeProviderId === null
      ? null
      : (configured.find(item => item.provider === activeProviderId) ?? null)
  const activeNamespace =
    activeProvider === null ? undefined : namespaceOf(document, activeProvider.settingsNs)

  useProviderDrilldownFocus(pageRef, activeProvider?.provider ?? null)

  const confirmRemoveProvider = async () => {
    if (removing === null) return
    setRemoveBusy(true)
    setRemoveError(null)
    try {
      await removeProviderWithCredentials({ store, removing, document, configured, credentials })
      const removedId = removing.provider
      setRemoving(null)
      if (activeProviderId === removedId) setActiveProviderId(null)
      await reload()
    } catch (cause) {
      setRemoveError(cause instanceof Error ? cause.message : '移除提供方失败，请重试。')
    } finally {
      setRemoveBusy(false)
    }
  }

  const removeModal = (
    <RemoveProviderModal
      provider={removing}
      busy={removeBusy}
      error={removeError}
      onCancel={() => {
        if (!removeBusy) setRemoving(null)
      }}
      onConfirm={() => {
        void confirmRemoveProvider()
      }}
    />
  )

  if (activeProvider !== null && activeNamespace !== undefined) {
    const inheritedModels = (groupModelsByProvider.get(activeProvider.provider) ?? []).map(
      model => ({ id: model.id, name: model.name }),
    )
    return (
      <div
        ref={pageRef}
        className="settings-page models-page models-page--detail"
        aria-labelledby="settings-model-detail-title"
      >
        <ModelProviderEditor
          key={activeProvider.provider}
          provider={activeProvider}
          namespace={activeNamespace}
          taken={providers.map(item => item.provider)}
          credentials={credentials}
          readOnly={readOnly}
          removable={isProviderRemovable(activeProvider, activeNamespace)}
          inheritedModels={inheritedModels}
          onClose={() => {
            setActiveProviderId(null)
          }}
          onRequestRemove={() => {
            setRemoveError(null)
            setRemoving(activeProvider)
          }}
          reload={reload}
          setCredential={setCredential}
          unsetCredential={unsetCredential}
        />
        {removeModal}
      </div>
    )
  }

  return (
    <ModelsOverviewContent
      pageRef={pageRef}
      document={document}
      modelCatalog={modelCatalog}
      groups={groups}
      providers={providers}
      configured={configured}
      available={available}
      customNamespace={customNamespace}
      groupModelsByProvider={groupModelsByProvider}
      credentials={credentials}
      saving={saving}
      readOnly={readOnly}
      blocked={blocked}
      canAddAny={canAddAny}
      addOpen={addOpen}
      removeBusy={removeBusy}
      mutate={mutate}
      setCredential={setCredential}
      reload={reload}
      onOpenAdd={() => {
        setAddOpen(true)
      }}
      onCloseAdd={() => {
        setAddOpen(false)
      }}
      onOpenProvider={setActiveProviderId}
      onRemoveProvider={provider => {
        setRemoveError(null)
        setRemoving(provider)
      }}
      removeModal={removeModal}
    />
  )
}
