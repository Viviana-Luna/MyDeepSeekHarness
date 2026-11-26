import { useCallback, useEffect, useRef, useState } from 'react'

import { useWorkspaceSnapshot, useWorkspaceStore } from '../../hooks/useWorkspace.ts'
import {
  providerKeyRef,
  namespaceOf,
  parseAgentPresetRoster,
  parseCredentialStates,
  parseHostModelCatalog,
  parseHostModelProviders,
  parseHostSettingsDocument,
  parseHostSettingsNamespace,
  valueAtPath,
  type AgentPresetRoster,
  type CredentialState,
  type HostModelCatalog,
  type HostModelProvider,
  type HostSettingsDocument,
  type HostSettingsPathOperation,
} from './settings-model.ts'

export interface SettingsCenterState {
  readonly loading: boolean
  readonly saving: string | null
  readonly document: HostSettingsDocument | null
  readonly modelCatalog: HostModelCatalog | null
  readonly modelProviders: readonly HostModelProvider[]
  readonly credentials: Readonly<Record<string, CredentialState>>
  readonly presetRoster: AgentPresetRoster | null
  readonly error: string | null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'MyDSH 设置操作失败'
}

function providerCredentialRefs(
  document: HostSettingsDocument | null,
  providers: readonly HostModelProvider[],
): string[] {
  const refs = new Set<string>()
  for (const provider of providers) {
    const namespace = namespaceOf(document, provider.settingsNs)
    const profile = valueAtPath(namespace?.value, provider.settingsPath)
    if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) continue
    const reference = providerKeyRef(provider.provider, profile)
    if (/^[A-Za-z_][A-Za-z0-9_]*$/u.test(reference)) refs.add(reference)
  }
  const search = namespaceOf(document, 'web-search-deepseek')
  if (search)
    refs.add(
      typeof search.value.apiKeyEnv === 'string' ? search.value.apiKeyEnv : 'DEEPSEEK_API_KEY',
    )
  return [...refs]
}

const EMPTY_STATE: SettingsCenterState = {
  loading: false,
  saving: null,
  document: null,
  modelCatalog: null,
  modelProviders: [],
  credentials: {},
  presetRoster: null,
  error: null,
}

export function useSettingsCenter(active = false) {
  const store = useWorkspaceStore()
  const snapshot = useWorkspaceSnapshot()
  const [state, setState] = useState<SettingsCenterState>(EMPTY_STATE)
  const generation = useRef(0)

  const load = useCallback(async () => {
    const current = ++generation.current
    if (snapshot.hostStatus?.kind !== 'ready') {
      setState({ ...EMPTY_STATE, error: 'MyDSH 运行时尚未就绪；桌面外观仍可正常设置。' })
      return
    }
    setState(previous => ({ ...previous, loading: true, error: null }))
    const [settingsResult, catalogResult, providerResult, presetResult] = await Promise.allSettled([
      store.callHost('describeSettings'),
      store.callHost('listHostModels'),
      store.callHost('listModelProviders'),
      store.callHost('listAgentPresets'),
    ])
    if (current !== generation.current) return

    const document =
      settingsResult.status === 'fulfilled' ? parseHostSettingsDocument(settingsResult.value) : null
    const modelCatalog =
      catalogResult.status === 'fulfilled' ? parseHostModelCatalog(catalogResult.value) : null
    const modelProviders =
      providerResult.status === 'fulfilled'
        ? (parseHostModelProviders(providerResult.value) ?? [])
        : []
    const presetRoster =
      presetResult.status === 'fulfilled' ? parseAgentPresetRoster(presetResult.value) : null
    const refs = providerCredentialRefs(document, modelProviders)
    let credentials: Record<string, CredentialState> = {}
    if (refs.length > 0) {
      try {
        credentials =
          parseCredentialStates(await store.callHost('describeCredentials', { refs })) ?? {}
      } catch {
        // 凭据能力缺失只降级密钥状态，不抹掉模型目录和设置文档。
      }
    }
    if (current !== generation.current) return
    const conversation = namespaceOf(document, 'ui-conversation')?.value.busyEnter
    if (conversation === 'queue' || conversation === 'steer') store.setBusyEnter(conversation)
    setState({
      loading: false,
      saving: null,
      document,
      modelCatalog,
      modelProviders,
      credentials,
      presetRoster,
      error:
        document === null
          ? settingsResult.status === 'rejected'
            ? messageOf(settingsResult.reason)
            : 'MyDSH 运行时返回了无法识别的设置文档'
          : null,
    })
  }, [snapshot.hostStatus?.kind, store])

  useEffect(() => {
    if ((active || snapshot.settingsOpen) && state.saving === null) void load()
    return () => {
      generation.current += 1
    }
  }, [
    load,
    active,
    snapshot.settingsOpen,
    state.saving,
    snapshot.hostSettingsRevision,
    snapshot.hostModelsRevision,
    snapshot.hostCredentialsRevision,
  ])

  const mutate = useCallback(
    async (
      namespace: string,
      ops: readonly HostSettingsPathOperation[],
      label = namespace,
    ): Promise<boolean> => {
      const current = namespaceOf(state.document, namespace)
      if (current === undefined || state.document?.writable !== true) return false
      generation.current += 1
      setState(previous => ({ ...previous, saving: label, error: null }))
      try {
        const value = await store.callHost('mutateSettings', {
          ns: namespace,
          ops,
          expectedRevision: current.revision,
        })
        const accepted = parseHostSettingsNamespace(value)
        if (accepted === null || accepted.ns !== namespace)
          throw new Error('MyDSH 运行时返回了无效的设置更新结果')
        const nextDocument = {
          ...state.document,
          namespaces: state.document.namespaces.map(item =>
            item.ns === namespace ? accepted : item,
          ),
        }
        setState(previous => ({ ...previous, document: nextDocument, saving: null }))
        const busyEnter = accepted.ns === 'ui-conversation' ? accepted.value.busyEnter : undefined
        if (busyEnter === 'queue' || busyEnter === 'steer') store.setBusyEnter(busyEnter)
        return true
      } catch (error) {
        const message = messageOf(error)
        if (/settings-conflict|冲突/iu.test(message)) {
          await load()
          setState(previous => ({
            ...previous,
            saving: null,
            error: '设置已在其他窗口中改变，已重新载入最新值；请再次确认后保存。',
          }))
        } else {
          setState(previous => ({ ...previous, saving: null, error: message }))
        }
        return false
      }
    },
    [load, state.document, store],
  )

  const setCredential = useCallback(
    async (reference: string, secret: string): Promise<boolean> => {
      setState(previous => ({ ...previous, saving: `credential:${reference}`, error: null }))
      try {
        await store.callHost('setCredential', { ref: reference, value: secret })
        const value = await store.callHost('describeCredentials', { refs: [reference] })
        const accepted = parseCredentialStates(value)
        if (accepted === null) throw new Error('MyDSH 运行时返回了无效的凭据状态')
        setState(previous => ({
          ...previous,
          saving: null,
          credentials: { ...previous.credentials, ...accepted },
        }))
        return true
      } catch (error) {
        setState(previous => ({ ...previous, saving: null, error: messageOf(error) }))
        return false
      }
    },
    [store],
  )

  const unsetCredential = useCallback(
    async (reference: string): Promise<boolean> => {
      setState(previous => ({ ...previous, saving: `credential:${reference}`, error: null }))
      try {
        await store.callHost('unsetCredential', { ref: reference })
        const value = await store.callHost('describeCredentials', { refs: [reference] })
        const accepted = parseCredentialStates(value)
        if (accepted === null) throw new Error('MyDSH 运行时返回了无效的凭据状态')
        setState(previous => ({
          ...previous,
          saving: null,
          credentials: { ...previous.credentials, ...accepted },
        }))
        return true
      } catch (error) {
        setState(previous => ({ ...previous, saving: null, error: messageOf(error) }))
        return false
      }
    },
    [store],
  )

  const openDocument = useCallback(async (): Promise<void> => {
    setState(previous => ({ ...previous, saving: 'open-document', error: null }))
    try {
      await store.callHost('openSettingsDocument')
      setState(previous => ({ ...previous, saving: null }))
    } catch (error) {
      setState(previous => ({ ...previous, saving: null, error: messageOf(error) }))
    }
  }, [store])

  return {
    state,
    load,
    mutate,
    setCredential,
    unsetCredential,
    openDocument,
    setState,
  }
}
