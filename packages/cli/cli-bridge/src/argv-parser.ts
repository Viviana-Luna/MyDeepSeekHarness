/**
 * 二级 CLI 命令行参数解析器：将 argv 与标准输入转换为帮助请求或结构化工具调用载荷。
 * 支持 kebab-case / snake_case 参数名映射、按 Schema 类型安全转换、--json 与标准输入流式注入。
 */
import { findCliDomain, resolveCliToolName, type CliToolSchema } from './catalog.ts'

/** CLI 解析结果：查看帮助或发起具体工具调用。 */
export type ParsedCliCommand =
  | {
      readonly kind: 'help'
      readonly domain?: string
      readonly action?: string
      readonly toolName?: string
    }
  | {
      readonly kind: 'invoke'
      readonly invocationLabel: string
      readonly toolName: string
      readonly rawFlags: ReadonlyMap<string, readonly string[]>
      readonly booleanNegations: ReadonlySet<string>
      readonly stdinField?: string
      readonly jsonText?: string
      readonly jsonFromStdin: boolean
    }

const HELP_TOKENS = new Set(['--help', '-h', 'help'])

function normalizeFieldKey(flagName: string): string {
  return flagName.replaceAll('-', '_')
}

interface FlagScanResult {
  readonly helpRequested: boolean
  readonly rawFlags: Map<string, string[]>
  readonly booleanNegations: Set<string>
  readonly stdinField?: string
  readonly jsonText?: string
  readonly jsonFromStdin: boolean
}

function appendFlagValue(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

function scanOptionTokens(tokens: readonly string[]): FlagScanResult {
  const rawFlags = new Map<string, string[]>()
  const booleanNegations = new Set<string>()
  let helpRequested = false
  let stdinField: string | undefined
  let jsonText: string | undefined
  let jsonFromStdin = false

  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]!
    if (HELP_TOKENS.has(token)) {
      helpRequested = true
      index += 1
      continue
    }
    if (!token.startsWith('--')) {
      throw new Error(`无法识别的位置参数 "${token}"；请使用 --参数名 传值，或加 --help 查看说明`)
    }
    const body = token.slice(2)
    const eqIndex = body.indexOf('=')
    const rawName = eqIndex >= 0 ? body.slice(0, eqIndex) : body
    const inlineValue = eqIndex >= 0 ? body.slice(eqIndex + 1) : undefined
    if (!rawName) throw new Error('命令行包含空的 "--" 参数名')

    if (rawName === 'json-stdin') {
      if (stdinField !== undefined) {
        throw new Error('--json-stdin 不能与 --<字段名>-stdin 同时使用')
      }
      jsonFromStdin = true
      index += 1
      continue
    }
    if (rawName.endsWith('-stdin') && rawName.length > '-stdin'.length) {
      if (jsonFromStdin || stdinField !== undefined) {
        throw new Error(
          '同一次调用只能指定一个标准输入来源（--json-stdin 或单个 --<字段名>-stdin）',
        )
      }
      stdinField = normalizeFieldKey(rawName.slice(0, -'-stdin'.length))
      index += 1
      continue
    }
    if (rawName === 'json') {
      const next = inlineValue ?? tokens[index + 1]
      if (next === undefined) throw new Error('--json 需要紧跟 JSON 对象字符串')
      jsonText = next
      index += inlineValue === undefined ? 2 : 1
      continue
    }
    if (rawName.startsWith('no-') && inlineValue === undefined && rawName.length > 3) {
      booleanNegations.add(normalizeFieldKey(rawName.slice(3)))
      index += 1
      continue
    }
    const nextToken = inlineValue ?? tokens[index + 1]
    if (nextToken === undefined || (inlineValue === undefined && nextToken.startsWith('--'))) {
      appendFlagValue(rawFlags, normalizeFieldKey(rawName), 'true')
      index += 1
    } else {
      appendFlagValue(rawFlags, normalizeFieldKey(rawName), nextToken)
      index += inlineValue === undefined ? 2 : 1
    }
  }
  return {
    helpRequested,
    rawFlags,
    booleanNegations,
    ...(stdinField === undefined ? {} : { stdinField }),
    ...(jsonText === undefined ? {} : { jsonText }),
    jsonFromStdin,
  }
}

function parseHelpCommand(argv: readonly string[]): ParsedCliCommand {
  if (argv[0] !== 'help' || argv.length === 1) return { kind: 'help' }
  const target = argv[1]!
  if (target === 'call') {
    const toolName = argv[2]
    return toolName ? { kind: 'help', toolName } : { kind: 'help' }
  }
  if (!findCliDomain(target)) {
    throw new Error(`未知领域 "${target}"；请运行 mydsh --help 查看可用领域`)
  }
  const action = argv[2]
  if (!action) return { kind: 'help', domain: target }
  const toolName = resolveCliToolName(target, action)
  if (!toolName) {
    throw new Error(`领域 "${target}" 下不存在子命令 "${action}"；请运行 mydsh ${target} --help`)
  }
  return { kind: 'help', domain: target, action, toolName }
}

/**
 * 解析 CLI 原始参数数组（不含 node 与脚本路径），区分帮助指令与工具执行请求。
 * @throws 领域、子命令或选项语法非法时抛出中文错误。
 */
export function parseCliArgv(argv: readonly string[]): ParsedCliCommand {
  if (argv.length === 0 || HELP_TOKENS.has(argv[0]!)) {
    return parseHelpCommand(argv)
  }

  if (argv[0] === 'call') {
    const toolName = argv[1]
    if (!toolName || HELP_TOKENS.has(toolName)) return { kind: 'help' }
    const scanned = scanOptionTokens(argv.slice(2))
    if (scanned.helpRequested) return { kind: 'help', toolName }
    return {
      kind: 'invoke',
      invocationLabel: `mydsh call ${toolName}`,
      toolName,
      rawFlags: scanned.rawFlags,
      booleanNegations: scanned.booleanNegations,
      ...(scanned.stdinField === undefined ? {} : { stdinField: scanned.stdinField }),
      ...(scanned.jsonText === undefined ? {} : { jsonText: scanned.jsonText }),
      jsonFromStdin: scanned.jsonFromStdin,
    }
  }

  const domain = argv[0]!
  if (!findCliDomain(domain)) {
    throw new Error(`未知领域 "${domain}"；请运行 mydsh --help 查看可用领域`)
  }
  const action = argv[1]
  if (!action || HELP_TOKENS.has(action)) {
    return { kind: 'help', domain }
  }
  const toolName = resolveCliToolName(domain, action)
  if (!toolName) {
    throw new Error(`领域 "${domain}" 下不存在子命令 "${action}"；请运行 mydsh ${domain} --help`)
  }
  const scanned = scanOptionTokens(argv.slice(2))
  if (scanned.helpRequested) {
    return { kind: 'help', domain, action, toolName }
  }
  return {
    kind: 'invoke',
    invocationLabel: `mydsh ${domain} ${action}`,
    toolName,
    rawFlags: scanned.rawFlags,
    booleanNegations: scanned.booleanNegations,
    ...(scanned.stdinField === undefined ? {} : { stdinField: scanned.stdinField }),
    ...(scanned.jsonText === undefined ? {} : { jsonText: scanned.jsonText }),
    jsonFromStdin: scanned.jsonFromStdin,
  }
}

function coerceSingleValue(raw: string, propSchema: Record<string, unknown> | undefined): unknown {
  const declaredType = propSchema?.type
  if (declaredType === 'string') return raw
  if (declaredType === 'boolean') {
    if (raw === 'true' || raw === '1') return true
    if (raw === 'false' || raw === '0') return false
    throw new Error(`布尔参数值无效："${raw}"（应为 true 或 false）`)
  }
  if (declaredType === 'integer') {
    if (raw.trim() === '') throw new Error('整数参数值不能为空')
    const parsed = Number(raw)
    if (!Number.isInteger(parsed)) throw new Error(`整数参数值无效："${raw}"`)
    return parsed
  }
  if (declaredType === 'number') {
    if (raw.trim() === '') throw new Error('数值参数值不能为空')
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) throw new Error(`数值参数值无效："${raw}"`)
    return parsed
  }
  if (declaredType === 'array' || declaredType === 'object') {
    try {
      return JSON.parse(raw) as unknown
    } catch {
      if (declaredType === 'array') return [raw]
      throw new Error(`对象参数需要合法 JSON 字符串，收到："${raw.slice(0, 80)}"`)
    }
  }
  if (raw === 'null') return null
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (/^-?\d+(?:\.\d+)?$/u.test(raw) && Array.isArray(propSchema?.oneOf)) {
    const branches = propSchema.oneOf as { type?: string }[]
    if (branches.some(item => item.type === 'integer' || item.type === 'number')) return Number(raw)
  }
  try {
    if (raw.startsWith('{') || raw.startsWith('[')) return JSON.parse(raw) as unknown
  } catch {
    // 非 JSON 文本保留原始字符串交由下游工具 Schema 校验。
  }
  return raw
}

function resolveSchemaKey(
  normalizedKey: string,
  properties: Record<string, Record<string, unknown>>,
): string {
  if (normalizedKey in properties) return normalizedKey
  const camel = normalizedKey.replace(/_([a-z])/gu, (_m, letter: string) => letter.toUpperCase())
  if (camel in properties) return camel
  return normalizedKey
}

/**
 * 结合目标工具的参数 Schema，将已扫描的命令行选项与标准输入组装为工具入参对象。
 * @throws JSON 语法错误或基础类型转换失败时抛出中文错误。
 */
export function materializeToolArguments(
  command: Extract<ParsedCliCommand, { kind: 'invoke' }>,
  schema: CliToolSchema | undefined,
  stdinText: string,
): Record<string, unknown> {
  const rawParams = (schema?.parameters ?? {}) as {
    properties?: Record<string, Record<string, unknown>>
  }
  const properties = rawParams.properties ?? {}
  let result: Record<string, unknown> = {}

  const jsonSource = command.jsonFromStdin ? stdinText.trim() : command.jsonText
  if (jsonSource !== undefined) {
    let parsed: unknown
    try {
      parsed = JSON.parse(jsonSource)
    } catch (error) {
      throw new Error(
        `JSON 参数解析失败：${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('--json / --json-stdin 必须提供 JSON 对象（例如 {"key":"value"}）')
    }
    result = { ...(parsed as Record<string, unknown>) }
  }

  for (const [key, values] of command.rawFlags.entries()) {
    const propKey = resolveSchemaKey(key, properties)
    const propSchema = properties[propKey]
    if (propSchema?.type === 'array' && values.length > 1) {
      result[propKey] = values.map(v =>
        coerceSingleValue(v, propSchema.items as Record<string, unknown>),
      )
    } else {
      result[propKey] = coerceSingleValue(values[values.length - 1]!, propSchema)
    }
  }

  for (const negated of command.booleanNegations) {
    const propKey = resolveSchemaKey(negated, properties)
    result[propKey] = false
  }

  if (command.stdinField !== undefined) {
    const propKey = resolveSchemaKey(command.stdinField, properties)
    result[propKey] = stdinText
  }

  return result
}
