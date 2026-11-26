import type {
  ModelCatalogModel,
  ModelProviderGroup,
  ModelSelection,
} from '../../domain/session-controls.ts'
import { isRecord } from '../../../../shared/validation.ts'

export type { BusyEnterBehavior } from '../../domain/session-controls.ts'

export type HostSettingsPathOperation =
  | {
      readonly op: 'set'
      readonly path: readonly string[]
      readonly value: unknown
    }
  | {
      readonly op: 'unset'
      readonly path: readonly string[]
    }

export interface HostSettingsSecret {
  readonly path: readonly string[]
  readonly set: boolean
}

export interface HostSettingsNamespace {
  readonly ns: string
  readonly schema: unknown
  readonly value: Record<string, unknown>
  readonly base?: Record<string, unknown>
  readonly user?: Record<string, unknown>
  readonly applies: 'live' | 'restart'
  readonly secrets: readonly HostSettingsSecret[]
  readonly revision: number
}

export interface HostSettingsDocument {
  readonly writable: boolean
  readonly hasDocument: boolean
  readonly namespaces: readonly HostSettingsNamespace[]
}

export interface HostModelCatalog {
  readonly groups: readonly ModelProviderGroup[]
  readonly failures: readonly { id: string; name: string; message: string }[]
}

export interface HostModelProvider {
  readonly provider: string
  readonly displayName: string
  readonly settingsNs: string
  readonly settingsPath: readonly string[]
  readonly active: boolean
  readonly declared?: boolean
}

export interface AgentPresetEntry {
  readonly id: string
  readonly trust: 'system' | 'user'
  readonly isDefault: boolean
  readonly name?: string
  readonly description?: string
  readonly broken?: string
}

export interface AgentPresetRoster {
  readonly presets: readonly AgentPresetEntry[]
  readonly authorable: boolean
  readonly hasDocument: boolean
}

export interface CredentialState {
  readonly configured: boolean
  readonly source?: string
  readonly writable: boolean
}

const MAX_NAMESPACES = 256
const MAX_MODELS_PER_PROVIDER = 512
const MAX_PROVIDERS = 128
const MAX_PRESETS = 128

function boundedText(value: unknown, maximum = 1_024): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : null
}

function optionalText(value: unknown, maximum = 1_024): string | undefined {
  return value === undefined ? undefined : (boundedText(value, maximum) ?? undefined)
}

function safeObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function parseSettingsSecret(value: unknown): HostSettingsSecret | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.path) ||
    value.path.length > 24 ||
    typeof value.set !== 'boolean'
  ) {
    return null
  }
  const path = value.path.map(segment => boundedText(segment, 160))
  return path.some(segment => segment === null) ? null : { path: path as string[], set: value.set }
}

export function parseHostSettingsNamespace(value: unknown): HostSettingsNamespace | null {
  if (
    !isRecord(value) ||
    (value.applies !== 'live' && value.applies !== 'restart') ||
    !Array.isArray(value.secrets) ||
    value.secrets.length > 128 ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0
  )
    return null
  const ns = boundedText(value.ns, 160)
  const secrets = value.secrets.map(parseSettingsSecret)
  if (ns === null || secrets.some(secret => secret === null)) return null
  return {
    ns,
    schema: value.schema,
    value: safeObject(value.value),
    ...(isRecord(value.base) ? { base: value.base } : {}),
    ...(isRecord(value.user) ? { user: value.user } : {}),
    applies: value.applies,
    secrets: secrets as HostSettingsSecret[],
    revision: Number(value.revision),
  }
}

export function parseHostSettingsDocument(value: unknown): HostSettingsDocument | null {
  if (
    !isRecord(value) ||
    typeof value.writable !== 'boolean' ||
    typeof value.hasDocument !== 'boolean' ||
    !Array.isArray(value.namespaces) ||
    value.namespaces.length > MAX_NAMESPACES
  )
    return null
  const namespaces = value.namespaces.map(parseHostSettingsNamespace)
  if (namespaces.some(namespace => namespace === null)) return null
  return {
    writable: value.writable,
    hasDocument: value.hasDocument,
    namespaces: namespaces as HostSettingsNamespace[],
  }
}

export function namespaceOf(
  document: HostSettingsDocument | null,
  ...names: readonly string[]
): HostSettingsNamespace | undefined {
  return document?.namespaces.find(namespace => names.includes(namespace.ns))
}

export function valueAtPath(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const segment of path) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return undefined
    current = current[segment]
  }
  return current
}

function parseReasoning(value: unknown): ModelCatalogModel['reasoning'] | undefined {
  if (!isRecord(value) || !Array.isArray(value.efforts) || value.efforts.length > 64)
    return undefined
  const efforts = value.efforts.flatMap(effort => {
    if (!isRecord(effort)) return []
    const id = boundedText(effort.id, 160)
    const name = boundedText(effort.name, 240)
    const description = optionalText(effort.description, 1_000)
    return id === null || name === null
      ? []
      : [{ id, name, ...(description === undefined ? {} : { description }) }]
  })
  if (efforts.length !== value.efforts.length) return undefined
  const defaultEffort = optionalText(value.defaultEffort, 160)
  return { efforts, ...(defaultEffort === undefined ? {} : { defaultEffort }) }
}

function parseModel(value: unknown): ModelCatalogModel | null {
  if (!isRecord(value)) return null
  const id = boundedText(value.id, 320)
  const name = boundedText(value.name, 320)
  const description = optionalText(value.description, 1_000)
  if (id === null || name === null) return null
  const reasoning = value.reasoning === undefined ? undefined : parseReasoning(value.reasoning)
  if (value.reasoning !== undefined && reasoning === undefined) return null
  return {
    id,
    name,
    ...(description === undefined ? {} : { description }),
    ...(reasoning === undefined ? {} : { reasoning }),
  }
}

function parseModelGroup(value: unknown): ModelProviderGroup | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.models) ||
    value.models.length > MAX_MODELS_PER_PROVIDER
  )
    return null
  const id = boundedText(value.id, 160)
  const name = boundedText(value.name, 240)
  const models = value.models.map(parseModel)
  if (id === null || name === null || models.some(model => model === null)) return null
  return { id, name, models: models as ModelCatalogModel[] }
}

export function parseHostModelCatalog(value: unknown): HostModelCatalog | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.groups) ||
    value.groups.length > MAX_PROVIDERS ||
    !Array.isArray(value.failures) ||
    value.failures.length > MAX_PROVIDERS
  )
    return null
  const groups = value.groups.map(parseModelGroup)
  const failures = value.failures.flatMap(failure => {
    if (!isRecord(failure)) return []
    const id = boundedText(failure.id, 160)
    const name = boundedText(failure.name, 240)
    const message = boundedText(failure.message, 2_000)
    return id === null || name === null || message === null ? [] : [{ id, name, message }]
  })
  if (groups.some(group => group === null) || failures.length !== value.failures.length) return null
  return { groups: groups as ModelProviderGroup[], failures }
}

function parseProvider(value: unknown): HostModelProvider | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.settingsPath) ||
    value.settingsPath.length > 24 ||
    typeof value.active !== 'boolean'
  )
    return null
  const provider = boundedText(value.provider, 160)
  const displayName = boundedText(value.displayName, 240)
  const settingsNs =
    typeof value.settingsNs === 'string' && value.settingsNs.length <= 160 ? value.settingsNs : null
  const settingsPath = value.settingsPath.map(segment => boundedText(segment, 160))
  if (
    provider === null ||
    displayName === null ||
    settingsNs === null ||
    settingsPath.some(segment => segment === null)
  ) {
    return null
  }
  return {
    provider,
    displayName,
    settingsNs,
    settingsPath: settingsPath as string[],
    active: value.active,
    ...(typeof value.declared === 'boolean' ? { declared: value.declared } : {}),
  }
}

export function parseHostModelProviders(value: unknown): HostModelProvider[] | null {
  if (!isRecord(value) || !Array.isArray(value.providers) || value.providers.length > MAX_PROVIDERS)
    return null
  const providers = value.providers.map(parseProvider)
  return providers.some(provider => provider === null) ? null : (providers as HostModelProvider[])
}

export function parseModelSelection(value: unknown): ModelSelection | null {
  if (!isRecord(value)) return null
  const provider = boundedText(value.provider, 160)
  const model = boundedText(value.model, 320)
  const reasoningEffort = optionalText(value.reasoningEffort, 160)
  if (provider === null || model === null) return null
  return { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
}

function parsePreset(value: unknown): AgentPresetEntry | null {
  if (
    !isRecord(value) ||
    (value.trust !== 'system' && value.trust !== 'user') ||
    typeof value.isDefault !== 'boolean'
  )
    return null
  const id = boundedText(value.id, 160)
  const name = optionalText(value.name, 240)
  const description = optionalText(value.description, 4_000)
  const broken = optionalText(value.broken, 4_000)
  if (id === null) return null
  return {
    id,
    trust: value.trust,
    isDefault: value.isDefault,
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(broken === undefined ? {} : { broken }),
  }
}

export function parseAgentPresetRoster(value: unknown): AgentPresetRoster | null {
  if (
    !isRecord(value) ||
    typeof value.authorable !== 'boolean' ||
    typeof value.hasDocument !== 'boolean' ||
    !Array.isArray(value.presets) ||
    value.presets.length > MAX_PRESETS
  )
    return null
  const presets = value.presets.map(parsePreset)
  if (presets.some(preset => preset === null)) return null
  return {
    presets: presets as AgentPresetEntry[],
    authorable: value.authorable,
    hasDocument: value.hasDocument,
  }
}

export function parseCredentialStates(value: unknown): Record<string, CredentialState> | null {
  if (!isRecord(value) || !isRecord(value.credentials)) return null
  const entries = Object.entries(value.credentials)
  if (entries.length > 128) return null
  const result: Record<string, CredentialState> = {}
  for (const [reference, state] of entries) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(reference) ||
      !isRecord(state) ||
      typeof state.configured !== 'boolean' ||
      typeof state.writable !== 'boolean'
    )
      return null
    const source = optionalText(state.source, 120)
    result[reference] = {
      configured: state.configured,
      writable: state.writable,
      ...(source === undefined ? {} : { source }),
    }
  }
  return result
}

function resolveSchemaRef(candidate: unknown, refs: Record<string, unknown> | null): unknown {
  if (refs === null || (typeof candidate !== 'number' && typeof candidate !== 'string')) {
    return candidate
  }
  const key = String(candidate)
  return Object.hasOwn(refs, key) ? refs[key] : candidate
}

function collectEnumLiterals(node: Record<string, unknown>, literals: Set<string>): void {
  for (const key of ['value', 'const', 'literal'] as const) {
    if (typeof node[key] === 'string') literals.add(node[key])
  }
  for (const key of ['values', 'enum'] as const) {
    const list = node[key]
    if (!Array.isArray(list)) continue
    for (const candidate of list) {
      if (typeof candidate === 'string') literals.add(candidate)
    }
  }
}

/**
 * 从 Schemastery 的序列化信封中读取一个字段的字符串枚举。
 * 支持顶层 `{ uid, refs }` 引用图与内联对象结构；Host 仍会在写入时重新校验，这里仅用于把动态选项呈现成选择器。
 */
export function enumStringsAtField(schema: unknown, field: string): string[] {
  const refs = isRecord(schema) && isRecord(schema.refs) ? schema.refs : null
  const root = refs !== null && isRecord(schema) ? resolveSchemaRef(schema.uid, refs) : schema
  const visitedOutside = new Set<unknown>()
  const visitedInside = new Set<unknown>()
  const literals = new Set<string>()

  const visit = (raw: unknown, insideField: boolean, deref: boolean): void => {
    const value = deref ? resolveSchemaRef(raw, refs) : raw
    if (value === null || typeof value !== 'object') return
    const seen = insideField ? visitedInside : visitedOutside
    if (seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) {
      for (const item of value) visit(item, insideField, deref)
      return
    }
    const record = value as Record<string, unknown>
    if (insideField) collectEnumLiterals(record, literals)
    for (const [key, child] of Object.entries(record)) {
      if (refs !== null && key === 'meta') continue
      if (key === 'dict' || key === 'properties') {
        if (!isRecord(child)) continue
        for (const [prop, propSchema] of Object.entries(child)) {
          visit(propSchema, insideField || prop === field, refs !== null)
        }
        continue
      }
      const nextInside = insideField || key === field
      const nextDeref =
        refs !== null && (key === 'sKey' || key === 'inner' || key === 'list' || key === field)
      visit(child, nextInside, nextDeref)
    }
  }

  visit(root, false, false)
  return [...literals]
}

export function preferenceOf(
  document: HostSettingsDocument | null,
  namespace: string,
  field: string,
): string | undefined {
  const value = namespaceOf(document, namespace)?.value[field]
  return typeof value === 'string' ? value : undefined
}

export const CORE_SETTINGS_NAMESPACES = new Set([
  'agent-default-model',
  'agent-presets',
  'locale',
  'permission',
  'permissionPresets',
  'ui-conversation',
  'ui-onboarding',
  'ui-theme',
])

export function providerKeyRef(provider: string, profile: unknown): string {
  if (isRecord(profile) && typeof profile.apiKeyEnv === 'string' && profile.apiKeyEnv)
    return profile.apiKeyEnv
  return provider === 'deepseek-official'
    ? 'DEEPSEEK_API_KEY'
    : `${provider.toUpperCase().replace(/[^A-Z0-9]+/gu, '_')}_API_KEY`
}
