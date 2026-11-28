/**
 * 提供商表单状态 Hook：统一承载内置/自定义提供商的草稿、校验、模型拉取与持久化提交。
 * 运行在 renderer；通过工作台 Store 调用 Host 接口，不直接触碰凭据明文日志或文件。
 */
import { useState } from 'react'
import { isRecord } from '../../../../shared/validation.ts'
import { useWorkspaceStore } from '../../hooks/useWorkspace.ts'
import { modelDraftError, modelDrafts, type ModelDraft } from './ModelCatalogEditor.tsx'
import { asRecordObject, asString } from './model-provider-meta.ts'
import {
  enumStringsAtField,
  parseHostSettingsNamespace,
  providerKeyRef,
  valueAtPath,
  type CredentialState,
  type HostModelProvider,
  type HostSettingsNamespace,
  type HostSettingsPathOperation,
} from './settings-model.ts'

/** 初始化提供商表单所需的上下文与回调契约。 */
export interface UseModelProviderFormOptions {
  readonly provider: HostModelProvider | null
  readonly namespace: HostSettingsNamespace
  readonly taken: readonly string[]
  readonly credentials: Readonly<Record<string, CredentialState>>
  readonly readOnly: boolean
  readonly inheritedModels: readonly ModelDraft[]
  reload(): Promise<void>
  setCredential(reference: string, secret: string): Promise<boolean>
  onSaved(): void
}

/** 提供商编辑与新增弹窗共用的派生状态与操作集合。 */
export interface ModelProviderFormState {
  readonly custom: boolean
  readonly declared: boolean
  readonly isDeepSeek: boolean
  readonly inputField: 'input' | 'inputModalities'
  readonly protocols: readonly string[]
  readonly route: string
  readonly draft: Record<string, unknown>
  readonly effective: Record<string, unknown>
  readonly api: string
  readonly baseURL: string
  readonly key: string
  readonly keyRef: string
  readonly credential: CredentialState | undefined
  readonly ownsModels: boolean
  readonly models: readonly ModelDraft[]
  readonly busy: boolean
  readonly committed: boolean
  readonly blocked: boolean
  readonly isDirty: boolean
  readonly error: string | null
  setRoute(value: string): void
  setKey(value: string): void
  setField(field: string, value: unknown): void
  clearError(): void
  discover(): Promise<ModelDraft[]>
  submit(): Promise<boolean>
}

interface ValidationContext {
  readonly custom: boolean
  readonly committed: boolean
  readonly route: string
  readonly taken: readonly string[]
  readonly baseURL: string
  readonly api: string
  readonly secret: string
  readonly ownsModels: boolean
  readonly models: readonly ModelDraft[]
}

interface DerivedProviderState {
  readonly custom: boolean
  readonly path: readonly string[]
  readonly effective: Record<string, unknown>
  readonly isDeepSeek: boolean
  readonly declared: boolean
  readonly inputField: 'input' | 'inputModalities'
  readonly protocols: readonly string[]
  readonly keyRef: string
  readonly credential: CredentialState | undefined
  readonly ownsModels: boolean
  readonly models: readonly ModelDraft[]
  readonly explicitApi: string
  readonly api: string
  readonly baseURL: string
}

type HostCaller = ReturnType<typeof useWorkspaceStore>

function resolveCurrentModels(options: {
  readonly ownsModels: boolean
  readonly draftModels: unknown
  readonly baseModels: unknown
  readonly inheritedModels: readonly ModelDraft[]
}): ModelDraft[] {
  if (options.ownsModels) return modelDrafts(options.draftModels)
  const inherited = modelDrafts(options.baseModels)
  return inherited.length > 0 ? inherited : [...options.inheritedModels]
}

function deriveProviderState(options: {
  readonly formOptions: UseModelProviderFormOptions
  readonly draft: Record<string, unknown>
  readonly route: string
}): DerivedProviderState {
  const { provider, namespace, credentials, inheritedModels } = options.formOptions
  const custom = provider === null
  const path = provider?.settingsPath ?? []
  const effective = custom ? {} : asRecordObject(valueAtPath(namespace.value, path))
  const base = custom ? {} : asRecordObject(valueAtPath(namespace.base, path))
  const isDeepSeek = namespace.ns === 'llm-deepseek'
  const declared = custom || provider?.declared === true
  const inputField: 'input' | 'inputModalities' = isDeepSeek ? 'inputModalities' : 'input'
  const protocols = enumStringsAtField(namespace.schema, 'api')
  const keyRef = providerKeyRef(options.route, effective)
  const ownsModels = Object.hasOwn(options.draft, 'models')
  const models = resolveCurrentModels({
    ownsModels,
    draftModels: options.draft.models,
    baseModels: base.models,
    inheritedModels,
  })
  const explicitApi = asString(options.draft.api ?? base.api)
  return {
    custom,
    path,
    effective,
    isDeepSeek,
    declared,
    inputField,
    protocols,
    keyRef,
    credential: credentials[keyRef],
    ownsModels,
    models,
    explicitApi,
    api: explicitApi || protocols[0] || '',
    baseURL: asString(options.draft.baseURL ?? base.baseURL),
  }
}

function validateProviderForm(input: ValidationContext): string | null {
  if (
    input.custom &&
    !input.committed &&
    (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(input.route) || input.taken.includes(input.route))
  ) {
    return '提供商 ID 必须以小写字母开头，只能包含小写字母、数字和连字符，且不能与现有提供商重复。'
  }
  if (input.baseURL) {
    try {
      if (!['http:', 'https:'].includes(new URL(input.baseURL.trim()).protocol)) {
        return '请填写有效的 HTTP 或 HTTPS API 地址。'
      }
    } catch {
      return '请填写有效的 HTTP 或 HTTPS API 地址。'
    }
  }
  if (input.custom && (!input.baseURL.trim() || !input.api || input.models.length === 0)) {
    return '请填写 API 地址、选择协议，并至少添加一个模型。'
  }
  if (/[^\x21-\x7e]/u.test(input.secret)) {
    return 'API 密钥不能包含空格、换行或非 ASCII 字符。'
  }
  if (input.ownsModels || input.custom) {
    return modelDraftError(input.models)
  }
  return null
}

function buildProviderOperations(options: {
  readonly custom: boolean
  readonly route: string
  readonly path: readonly string[]
  readonly namespaceValue: Record<string, unknown>
  readonly initial: Record<string, unknown>
  readonly next: Record<string, unknown>
}): HostSettingsPathOperation[] {
  if (options.custom) {
    return [{ op: 'set', path: ['providers', options.route], value: options.next }]
  }
  const fields = new Set([...Object.keys(options.initial), ...Object.keys(options.next)])
  const ops: HostSettingsPathOperation[] = []
  for (const field of fields) {
    if (JSON.stringify(options.initial[field]) === JSON.stringify(options.next[field])) continue
    if (Object.hasOwn(options.next, field)) {
      ops.push({ op: 'set', path: [...options.path, field], value: options.next[field] })
    } else {
      ops.push({ op: 'unset', path: [...options.path, field] })
    }
  }
  // 内置提供商没有额外设置时，也要创建配置条目来启用它。
  if (
    options.path.length > 0 &&
    valueAtPath(options.namespaceValue, options.path) === undefined &&
    ops.length === 0
  ) {
    ops.push({ op: 'set', path: options.path, value: {} })
  }
  return ops
}

async function discoverProviderCatalog(
  store: HostCaller,
  request: {
    readonly namespace: HostSettingsNamespace
    readonly derived: DerivedProviderState
    readonly route: string
    readonly key: string
  },
): Promise<ModelDraft[]> {
  const { derived, route, key, namespace } = request
  if (derived.custom && !derived.baseURL.trim()) throw new Error('请先填写 API 地址。')
  if (/[^\x21-\x7e]/u.test(key.trim())) {
    throw new Error('API 密钥不能包含空格、换行或非 ASCII 字符。')
  }
  const result = await store.callHost('discoverProviderModels', {
    settingsNs: namespace.ns,
    ...(derived.custom ? {} : { provider: route }),
    ...(derived.baseURL.trim() ? { baseURL: derived.baseURL.trim() } : {}),
    // 内置非 declared 且未显式指定协议时不能误传 api，交由后端按目录原生协议探测。
    ...(!derived.isDeepSeek &&
    (derived.custom || derived.declared || derived.explicitApi) &&
    derived.api
      ? { api: derived.api }
      : {}),
    ...(key.trim() ? { apiKey: key.trim() } : {}),
  })
  if (!isRecord(result) || !Array.isArray(result.models)) {
    throw new Error('提供商没有返回有效模型列表。')
  }
  const drafts = modelDrafts(result.models)
  for (const model of drafts) {
    const modalities = model.inputModalities
    delete model.inputModalities
    if (Array.isArray(modalities)) {
      model[derived.inputField] = modalities
    }
  }
  return drafts
}

async function commitProviderSettings(
  store: HostCaller,
  params: {
    readonly namespace: HostSettingsNamespace
    readonly revision: number
    readonly initial: Record<string, unknown>
    readonly draft: Record<string, unknown>
    readonly derived: DerivedProviderState
    readonly route: string
    readonly secret: string
  },
): Promise<void> {
  const { derived, draft, initial, namespace, revision, route, secret } = params
  const next: Record<string, unknown> = { ...draft }
  if (secret) next.apiKeyEnv = derived.keyRef
  if (derived.custom) {
    next.api = derived.api
    next.baseURL = derived.baseURL.trim()
  }
  if (derived.ownsModels || derived.custom) {
    next.models = derived.models.map(model => {
      const cloned = structuredClone(model)
      cloned.id = cloned.id.trim()
      return cloned
    })
  }
  if (derived.ownsModels && !derived.isDeepSeek) delete next.modelOverrides
  const ops = buildProviderOperations({
    custom: derived.custom,
    route,
    path: derived.path,
    namespaceValue: namespace.value,
    initial,
    next,
  })
  if (ops.length === 0) return
  const result = await store.callHost('mutateSettings', {
    ns: namespace.ns,
    ops,
    expectedRevision: revision,
  })
  if (!parseHostSettingsNamespace(result)) {
    throw new Error('提供商设置未能保存，请重试。')
  }
}

function formatSaveError(cause: unknown): string {
  if (cause instanceof Error) {
    if (/conflict|冲突/iu.test(cause.message)) {
      return '配置已在其他地方更新。请取消后重新打开编辑，避免覆盖新设置。'
    }
    return cause.message
  }
  return '保存失败，请重试。'
}

async function submitProviderChanges(params: {
  readonly store: HostCaller
  readonly options: UseModelProviderFormOptions
  readonly derived: DerivedProviderState
  readonly initial: Record<string, unknown>
  readonly draft: Record<string, unknown>
  readonly revision: number
  readonly route: string
  readonly key: string
  readonly committed: boolean
  setBusy(value: boolean): void
  setCommitted(value: boolean): void
  setKey(value: string): void
  setError(value: string | null): void
}): Promise<boolean> {
  const { store, options, derived, initial, draft, revision, route, key, committed } = params
  params.setError(null)
  const secret = key.trim()
  const validationError = validateProviderForm({
    custom: derived.custom,
    committed,
    route,
    taken: options.taken,
    baseURL: derived.baseURL,
    api: derived.api,
    secret,
    ownsModels: derived.ownsModels,
    models: derived.models,
  })
  if (validationError !== null) {
    params.setError(validationError)
    return false
  }
  params.setBusy(true)
  try {
    if (!committed) {
      await commitProviderSettings(store, {
        namespace: options.namespace,
        revision,
        initial,
        draft,
        derived,
        route,
        secret,
      })
      params.setCommitted(true)
    }
    if (secret && !(await options.setCredential(derived.keyRef, secret))) {
      params.setError('提供商设置已保存，API 密钥保存失败。请重试保存密钥。')
      return false
    }
    params.setKey('')
    await options.reload()
    options.onSaved()
    return true
  } catch (cause) {
    params.setError(formatSaveError(cause))
    return false
  } finally {
    params.setBusy(false)
  }
}

/**
 * 管理单个提供商的草稿编辑、远程模型拉取、配置差分写入与凭据重试状态。
 * 调用方在切换目标提供商时应通过 React key 重新挂载，确保 revision 与初始快照同步。
 */
export function useModelProviderForm(options: UseModelProviderFormOptions): ModelProviderFormState {
  const { provider, namespace, readOnly } = options
  const store = useWorkspaceStore()
  const [initial] = useState(() =>
    provider === null
      ? {}
      : structuredClone(asRecordObject(valueAtPath(namespace.user, provider.settingsPath))),
  )
  const [draft, setDraft] = useState<Record<string, unknown>>(() => structuredClone(initial))
  const [revision] = useState(namespace.revision)
  const [route, setRoute] = useState(provider?.provider ?? '')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [committed, setCommitted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const derived = deriveProviderState({ formOptions: options, draft, route })
  const blocked = readOnly || busy || committed
  const isDirty = key.trim().length > 0 || JSON.stringify(initial) !== JSON.stringify(draft)

  const setField = (field: string, value: unknown) => {
    setDraft(current => {
      const next = { ...current }
      if (value === undefined || value === '') delete next[field]
      else next[field] = value
      return next
    })
  }

  return {
    ...derived,
    route,
    draft,
    key,
    busy,
    committed,
    blocked,
    isDirty,
    error,
    setRoute,
    setKey,
    setField,
    clearError: () => setError(null),
    discover: () => discoverProviderCatalog(store, { namespace, derived, route, key }),
    submit: () =>
      submitProviderChanges({
        store,
        options,
        derived,
        initial,
        draft,
        revision,
        route,
        key,
        committed,
        setBusy,
        setCommitted,
        setKey,
        setError,
      }),
  }
}
