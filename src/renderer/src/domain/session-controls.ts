import {
  parseDesktopModelSelection,
  parseDesktopModelSelectionProjection,
  type DesktopModelSelection,
  type DesktopModelSelectionProjection,
} from '../../../shared/session-live.ts'
import { isRecord } from '../../../shared/validation.ts'

export type ModelSelection = DesktopModelSelection

/** 智能体繁忙时，普通 Enter 键提交消息所采用的公开 DSH 语义。 */
export type BusyEnterBehavior = 'queue' | 'steer'

export interface ModelReasoningEffort {
  readonly id: string
  readonly name: string
  readonly description?: string
}

export interface ModelCatalogModel {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly reasoning?: {
    readonly efforts: readonly ModelReasoningEffort[]
    readonly defaultEffort?: string
  }
}

export interface ModelProviderGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly ModelCatalogModel[]
}

export interface SessionModels {
  readonly default: ModelSelection
  readonly routableProviders: readonly string[]
  readonly current: ModelSelection
  readonly routable: boolean
  readonly groups: readonly ModelProviderGroup[]
  readonly failures: readonly {
    readonly id: string
    readonly name: string
    readonly message: string
  }[]
}

export interface PermissionPresetOption {
  readonly value: string
  readonly name: string
  readonly description?: string
  readonly selectable: boolean
}

export interface PermissionSelection {
  readonly currentValue: string
  readonly options: readonly PermissionPresetOption[]
}

const MAX_GROUPS = 64
const MAX_MODELS_PER_GROUP = 256
const MAX_REASONING_EFFORTS = 32
const MAX_PERMISSION_PRESETS = 32

function boundedText(value: unknown, maximum: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : null
}

function optionalText(value: unknown, maximum: number): string | undefined {
  return value === undefined ? undefined : (boundedText(value, maximum) ?? undefined)
}

export function parseModelSelection(value: unknown): ModelSelection | null {
  return parseDesktopModelSelection(value)
}

export function parseModelSelectionProjection(
  value: unknown,
): DesktopModelSelectionProjection | null {
  if (!isRecord(value)) return null
  const direct = parseDesktopModelSelectionProjection(value)
  if (direct !== null) return direct
  if (isRecord(value.values) && Object.hasOwn(value.values, 'modelSelection')) {
    return parseDesktopModelSelectionProjection(value.values.modelSelection)
  }
  return isRecord(value.projections) ? parseModelSelectionProjection(value.projections) : null
}

function parseReasoning(value: unknown): ModelCatalogModel['reasoning'] | undefined {
  if (
    !isRecord(value) ||
    !Array.isArray(value.efforts) ||
    value.efforts.length > MAX_REASONING_EFFORTS
  )
    return undefined
  const efforts = value.efforts.flatMap(effort => {
    if (!isRecord(effort)) return []
    const id = boundedText(effort.id, 160)
    const name = boundedText(effort.name, 240)
    const description = optionalText(effort.description, 1_000)
    if (id === null || name === null) return []
    return [{ id, name, ...(description === undefined ? {} : { description }) }]
  })
  if (efforts.length !== value.efforts.length) return undefined
  const defaultEffort = optionalText(value.defaultEffort, 160)
  if (value.defaultEffort !== undefined && defaultEffort === undefined) return undefined
  return { efforts, ...(defaultEffort === undefined ? {} : { defaultEffort }) }
}

function parseModel(value: unknown): ModelCatalogModel | null {
  if (!isRecord(value)) return null
  const id = boundedText(value.id, 320)
  const name = boundedText(value.name, 320)
  const description = optionalText(value.description, 1_000)
  if (id === null || name === null) return null
  if (value.reasoning !== undefined) {
    const reasoning = parseReasoning(value.reasoning)
    if (reasoning === undefined) return null
    return { id, name, ...(description === undefined ? {} : { description }), reasoning }
  }
  return { id, name, ...(description === undefined ? {} : { description }) }
}

function parseGroup(value: unknown): ModelProviderGroup | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.models) ||
    value.models.length > MAX_MODELS_PER_GROUP
  )
    return null
  const id = boundedText(value.id, 160)
  const name = boundedText(value.name, 240)
  const models = value.models.map(parseModel)
  if (id === null || name === null || models.some(model => model === null)) return null
  return { id, name, models: models as ModelCatalogModel[] }
}

export function sessionModelsWithSelection(
  directory: SessionModels,
  selection: ModelSelection | null,
): SessionModels {
  const current = selection ?? directory.default
  return {
    ...directory,
    current,
    routable: directory.routableProviders.includes(current.provider),
  }
}

export function parseSessionModels(
  value: unknown,
  selection: ModelSelection | null = null,
): SessionModels | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.routableProviders) ||
    value.routableProviders.length > MAX_GROUPS ||
    !Array.isArray(value.groups) ||
    value.groups.length > MAX_GROUPS ||
    !Array.isArray(value.failures) ||
    value.failures.length > MAX_GROUPS
  )
    return null
  const defaultSelection = parseModelSelection(value.default)
  const routableProviders = value.routableProviders.map(provider => boundedText(provider, 160))
  const groups = value.groups.map(parseGroup)
  const failures = value.failures.flatMap(failure => {
    if (!isRecord(failure)) return []
    const id = boundedText(failure.id, 160)
    const name = boundedText(failure.name, 240)
    const message = boundedText(failure.message, 1_000)
    return id === null || name === null || message === null ? [] : [{ id, name, message }]
  })
  if (
    defaultSelection === null ||
    routableProviders.some(provider => provider === null) ||
    groups.some(group => group === null) ||
    failures.length !== value.failures.length
  )
    return null
  const current = selection ?? defaultSelection
  return {
    default: defaultSelection,
    routableProviders: routableProviders as string[],
    current,
    routable: routableProviders.includes(current.provider),
    groups: groups as ModelProviderGroup[],
    failures,
  }
}

export function parseSelectedModelResponse(value: unknown): ModelSelection | null {
  return isRecord(value) ? parseModelSelection(value.selected) : null
}

function permissionsValue(value: unknown): unknown {
  if (!isRecord(value)) return undefined
  if (typeof value.currentValue === 'string') return value
  if (isRecord(value.values) && value.values.permissions !== undefined)
    return value.values.permissions
  if (isRecord(value.projections)) return permissionsValue(value.projections)
  return undefined
}

/**
 * 读取权限投影里的当前值。运行核心只发布 `currentValue`：可选预设属于进程级
 * `permissionPresets` 目录，不在 Session 投影里，两者由 {@link permissionSelectionFrom} 合并。
 */
export function parsePermissionCurrent(value: unknown): string | null {
  const candidate = permissionsValue(value)
  return isRecord(candidate) ? boundedText(candidate.currentValue, 80) : null
}

/** 读取进程级权限目录；不接受空目录或越界项，避免把半份列表当成可选范围。 */
export function parsePermissionCatalog(value: unknown): readonly PermissionPresetOption[] | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.options) ||
    value.options.length === 0 ||
    value.options.length > MAX_PERMISSION_PRESETS
  )
    return null
  const options = value.options.flatMap((option): PermissionPresetOption[] => {
    if (!isRecord(option)) return []
    const presetValue = boundedText(option.value, 80)
    const name = boundedText(option.name, 240)
    const description = optionalText(option.description, 1_000)
    if (presetValue === null || name === null) return []
    return [
      {
        value: presetValue,
        name,
        ...(description === undefined ? {} : { description }),
        selectable: presetValue !== 'custom',
      },
    ]
  })
  return options.length === value.options.length ? options : null
}

/**
 * 合成权限胶囊的可选列表：当前值来自会话投影，选项来自进程级目录。
 *
 * 只发布目录里的选项，不额外造行：当前值不在目录里时（例如 `custom`，或目录已
 * 变化）只作为触发器上的当前值显示，没有可切换的目标。
 */
export function permissionSelectionFrom(
  currentValue: string | null,
  catalog: readonly PermissionPresetOption[] | null,
): PermissionSelection | null {
  return currentValue === null || catalog === null ? null : { currentValue, options: catalog }
}

/** 内置预设的产品文案：与运行核心配置的预设键一一对应。 */
const PRESET_LABELS = new Map<string, string>([
  ['read-only', '仅可查看'],
  ['workspace-write', '工作区内修改'],
  ['danger-full-access', '完全权限'],
  ['auto-review', '自动审核提权'],
])

/** 自动审核仍可能误判，和完全权限一样需要用户显式确认。 */
export const PERMISSION_RISK_PRESETS = new Set(['danger-full-access', 'auto', 'auto-review'])

/** 内置预设的产品说明；运行核心没有给说明时用作兜底。 */
export const PERMISSION_PRESET_DESCRIPTIONS = new Map<string, string>([
  ['read-only', '只能查看与读取，写入需要审批。'],
  ['workspace-write', '工作区内可写，扩大访问范围时需要审批。'],
  ['danger-full-access', '不限制文件访问，并且不再请求审批。'],
  ['auto-review', '保留工作区沙箱；低风险提权自动放行一次，其余转人工审批。'],
])

/** kebab-case 机器名转标题式显示；非 kebab 名称原样保留。 */
export function displayPresetName(name: string): string {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/u.test(name)) return name
  return name
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * 权限预设的显示名：内置键用产品文案，其余用运行核心给的名称。
 *
 * 与 DSH Web 的规则一致：只有当运行核心给的名字就是键本身时，才用产品文案覆盖，
 * 这样部署自定义的名称不会被内置文案顶掉。
 */
export function permissionPresetLabel(value: string, name: string): string {
  const builtIn = PRESET_LABELS.get(value)
  return builtIn !== undefined && name === value ? builtIn : displayPresetName(name)
}

/** 权限预设的说明：优先运行核心给的内容，其次内置兜底文案。 */
export function permissionPresetDescription(option: PermissionPresetOption): string | undefined {
  return option.description ?? PERMISSION_PRESET_DESCRIPTIONS.get(option.value)
}

export function permissionCommandError(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.result)) return '权限切换暂不可用'
  if (value.result.kind === 'success') return null
  return value.result.kind === 'error' && typeof value.result.text === 'string'
    ? value.result.text
    : '运行核心返回了无效的权限切换结果'
}
