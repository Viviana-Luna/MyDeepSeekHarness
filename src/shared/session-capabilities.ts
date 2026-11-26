import { isRecord } from './validation.ts'
export const DESKTOP_COMMAND_LINE_MAX_BYTES = 128 * 1024
export const DESKTOP_COMMAND_DIRECTORY_MAX_ITEMS = 1_024
export const DESKTOP_COMMAND_NAME_MAX_LENGTH = 160
export const DESKTOP_COMMAND_DESCRIPTION_MAX_LENGTH = 8 * 1024
export const DESKTOP_COMMAND_HINT_MAX_LENGTH = 2 * 1024
export const DESKTOP_COMMAND_RESULT_TEXT_MAX_LENGTH = 128 * 1024
export const DESKTOP_SKILL_WHEN_TO_USE_MAX_LENGTH = 16 * 1024
export const DESKTOP_SESSION_ID_MAX_LENGTH = 512
export const DESKTOP_SESSION_TITLE_MAX_LENGTH = 16 * 1024
export const DESKTOP_SESSION_SEARCH_QUERY_MAX_LENGTH = 500
export const DESKTOP_SESSION_SEARCH_RESULT_LIMIT = 20
export const DESKTOP_SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS = 240

const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

export interface DesktopCommandDescriptor {
  readonly name: string
  readonly description: string
  readonly input?: {
    readonly hint: string
    readonly images?: true
  }
}

export interface DesktopSkillDescriptor {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly modelInvocable: boolean
}

export interface DesktopSessionCommandDirectory {
  readonly commands: readonly DesktopCommandDescriptor[]
  readonly skills: readonly DesktopSkillDescriptor[]
}

export type DesktopCommandExecutionResult = {
  readonly commandId: string
  readonly result:
    | {
        readonly kind: 'success'
        readonly text?: string
        readonly sourceEventSeq?: number
      }
    | {
        readonly kind: 'error'
        readonly text: string
      }
}

export interface DesktopCommandRunEventData {
  readonly commandId: string
  readonly name: string
  readonly args?: string
  readonly source: { readonly kind: 'user' }
}

export interface DesktopSlashInvocation {
  readonly name: string
  readonly line: string
}

export type DesktopCommandDoneEventData =
  | {
      readonly commandId: string
      readonly kind: 'success'
      readonly text?: string
      readonly sourceEventSeq?: number
    }
  | {
      readonly commandId: string
      readonly kind: 'error'
      readonly text?: string
    }

export interface DesktopSessionRenameResult {
  readonly title: string
  readonly seq: number
}

export interface DesktopSessionForkResult {
  readonly sessionId: string
  readonly workspaceAttachFailed: boolean
}

export interface DesktopSessionSearchItem {
  readonly sessionId: string
  readonly snippet: string
}

export interface DesktopSessionSearchResult {
  readonly items: readonly DesktopSessionSearchItem[]
  readonly hasMore: boolean
}

function invalidCapability(subject: string): never {
  throw new Error(`DSH Host 返回了无效的${subject}`)
}

function boundedString(
  value: unknown,
  maximum: number,
  subject: string,
  options: { readonly allowEmpty?: boolean } = {},
): string {
  if (
    typeof value !== 'string' ||
    (!options.allowEmpty && value.trim().length === 0) ||
    value.length > maximum
  ) {
    return invalidCapability(subject)
  }
  return value
}

function boundedUtf8String(
  value: unknown,
  maximum: number,
  subject: string,
  options: { readonly allowEmpty?: boolean } = {},
): string {
  const text = boundedString(value, maximum, subject, options)
  return new TextEncoder().encode(text).byteLength <= maximum ? text : invalidCapability(subject)
}

function commandName(value: unknown, subject: string): string {
  const name = boundedString(value, DESKTOP_COMMAND_NAME_MAX_LENGTH, subject)
  return COMMAND_NAME.test(name) ? name : invalidCapability(subject)
}

function skillName(value: unknown): string {
  const name = boundedString(value, DESKTOP_COMMAND_NAME_MAX_LENGTH, ' Skill 名称')
  return SKILL_NAME.test(name) ? name : invalidCapability(' Skill 名称')
}

function sessionIdentifier(value: unknown, subject: string): string {
  const id = boundedString(value, DESKTOP_SESSION_ID_MAX_LENGTH, subject)
  return id.includes('\0') ? invalidCapability(subject) : id
}

/** 严格解析 session/rename 的规范化标题与对应事件序号。 */
export function parseDesktopSessionRenameResult(input: unknown): DesktopSessionRenameResult {
  if (!isRecord(input) || !Number.isSafeInteger(input.seq) || Number(input.seq) < 0)
    return invalidCapability(' Session 重命名结果')
  return {
    title: boundedString(input.title, DESKTOP_SESSION_TITLE_MAX_LENGTH, ' Session 标题'),
    seq: Number(input.seq),
  }
}

/** 严格解析 session/fork 的子会话身份，包括已创建但 Workspace 附加失败的结果。 */
export function parseDesktopSessionForkResult(input: unknown): DesktopSessionForkResult {
  if (
    !isRecord(input) ||
    (input.workspaceAttachFailed !== undefined && typeof input.workspaceAttachFailed !== 'boolean')
  ) {
    return invalidCapability(' Session 分叉结果')
  }
  return {
    sessionId: sessionIdentifier(input.sessionId, ' Session 分叉结果'),
    workspaceAttachFailed: input.workspaceAttachFailed === true,
  }
}

/** 保持输入法文本完整，只移除协议禁止的 NUL 并按 UTF-16 wire 上限截断。 */
export function sanitizeDesktopSessionSearchQuery(value: string): string {
  const withoutNul = value.replaceAll('\0', '')
  if (withoutNul.length <= DESKTOP_SESSION_SEARCH_QUERY_MAX_LENGTH) return withoutNul
  let end = DESKTOP_SESSION_SEARCH_QUERY_MAX_LENGTH
  const last = withoutNul.charCodeAt(end - 1)
  const next = withoutNul.charCodeAt(end)
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1
  return withoutNul.slice(0, end)
}

/** 严格解析 session/search 的有界内容命中，只保留 Session ID 与纯文本摘要。 */
export function parseDesktopSessionSearchResult(input: unknown): DesktopSessionSearchResult {
  if (
    !isRecord(input) ||
    !Array.isArray(input.items) ||
    input.items.length > DESKTOP_SESSION_SEARCH_RESULT_LIMIT ||
    typeof input.hasMore !== 'boolean'
  )
    return invalidCapability(' Session 搜索结果')
  const items = input.items.map(candidate => {
    if (!isRecord(candidate)) return invalidCapability(' Session 搜索项')
    const snippet = boundedString(
      candidate.snippet,
      DESKTOP_SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS * 2,
      ' Session 搜索摘要',
      { allowEmpty: true },
    )
    if (
      snippet.includes('\0') ||
      [...snippet].length > DESKTOP_SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS
    ) {
      return invalidCapability(' Session 搜索摘要')
    }
    return {
      sessionId: sessionIdentifier(candidate.sessionId, ' Session 搜索项'),
      snippet,
    }
  })
  if (new Set(items.map(item => item.sessionId)).size !== items.length) {
    return invalidCapability(' Session 搜索结果')
  }
  return { items, hasMore: input.hasMore }
}

function commandDescriptor(value: unknown): DesktopCommandDescriptor {
  if (!isRecord(value)) return invalidCapability('命令描述')
  const name = commandName(value.name, '命令名称')
  const description = boundedString(
    value.description,
    DESKTOP_COMMAND_DESCRIPTION_MAX_LENGTH,
    '命令描述',
  )
  if (value.input === undefined) return { name, description }
  if (!isRecord(value.input)) return invalidCapability('命令输入描述')
  const hint = boundedString(value.input.hint, DESKTOP_COMMAND_HINT_MAX_LENGTH, '命令输入提示')
  if (value.input.images !== undefined && typeof value.input.images !== 'boolean') {
    return invalidCapability('命令图片输入标记')
  }
  return {
    name,
    description,
    input: { hint, ...(value.input.images === true ? { images: true as const } : {}) },
  }
}

function skillDescriptor(value: unknown): DesktopSkillDescriptor {
  if (!isRecord(value)) return invalidCapability(' Skill 描述')
  const name = skillName(value.name)
  const description = boundedString(
    value.description,
    DESKTOP_COMMAND_DESCRIPTION_MAX_LENGTH,
    ' Skill 描述',
  )
  const whenToUse =
    value.whenToUse === undefined
      ? undefined
      : boundedString(value.whenToUse, DESKTOP_SKILL_WHEN_TO_USE_MAX_LENGTH, ' Skill 使用说明')
  if (typeof value.modelInvocable !== 'boolean') return invalidCapability(' Skill 调用标记')
  return {
    name,
    description,
    ...(whenToUse === undefined ? {} : { whenToUse }),
    modelInvocable: value.modelInvocable,
  }
}

function uniqueNames<T extends { readonly name: string }>(
  items: readonly T[],
  subject: string,
): void {
  if (new Set(items.map(item => item.name)).size !== items.length) invalidCapability(subject)
}

/** 严格解析 commands/list 的 value，只保留桌面命令目录需要的字段。 */
export function parseDesktopCommandList(input: unknown): readonly DesktopCommandDescriptor[] {
  if (!Array.isArray(input) || input.length > DESKTOP_COMMAND_DIRECTORY_MAX_ITEMS) {
    return invalidCapability('命令目录')
  }
  const commands = input.map(commandDescriptor)
  uniqueNames(commands, '命令目录')
  return commands
}

/** 严格解析 skills/list 的 value，只保留可展示的 Skill 元数据。 */
export function parseDesktopSkillList(input: unknown): readonly DesktopSkillDescriptor[] {
  if (
    !isRecord(input) ||
    !Array.isArray(input.skills) ||
    input.skills.length > DESKTOP_COMMAND_DIRECTORY_MAX_ITEMS
  ) {
    return invalidCapability(' Skill 目录')
  }
  const skills = input.skills.map(skillDescriptor)
  uniqueNames(skills, ' Skill 目录')
  return skills
}

/**
 * 严格解析 commands/execute 的 value。value 缺失表示命令语法或名称未匹配，
 * 其余结果只保留 lifecycle 关联和界面展示需要的字段。
 */
export function parseDesktopCommandExecutionResult(
  input: unknown,
): DesktopCommandExecutionResult | undefined {
  if (input === undefined) return undefined
  if (!isRecord(input) || !isRecord(input.result)) return invalidCapability('命令执行结果')
  const commandId = boundedString(input.commandId, 512, '命令执行 ID')
  const result = input.result
  if (result.kind === 'success') {
    const text =
      result.text === undefined
        ? undefined
        : boundedString(result.text, DESKTOP_COMMAND_RESULT_TEXT_MAX_LENGTH, '命令成功文本', {
            allowEmpty: true,
          })
    const sourceEventSeq = result.sourceEventSeq
    if (
      sourceEventSeq !== undefined &&
      (!Number.isSafeInteger(sourceEventSeq) || Number(sourceEventSeq) < 0)
    ) {
      return invalidCapability('命令源事件序号')
    }
    return {
      commandId,
      result: {
        kind: 'success',
        ...(text === undefined ? {} : { text }),
        ...(sourceEventSeq === undefined ? {} : { sourceEventSeq: Number(sourceEventSeq) }),
      },
    }
  }
  if (result.kind === 'error') {
    return {
      commandId,
      result: {
        kind: 'error',
        text: boundedString(result.text, DESKTOP_COMMAND_RESULT_TEXT_MAX_LENGTH, '命令错误文本'),
      },
    }
  }
  return invalidCapability('命令执行结果')
}

/** 校验并收窄 command/run 的 data；未知字段不会越过共享边界。 */
export function parseDesktopCommandRunEventData(input: unknown): DesktopCommandRunEventData | null {
  if (!isRecord(input) || !isRecord(input.source) || input.source.kind !== 'user') return null
  try {
    const args =
      input.args === undefined
        ? undefined
        : boundedUtf8String(input.args, DESKTOP_COMMAND_LINE_MAX_BYTES, '命令事件参数', {
            allowEmpty: true,
          })
    return {
      commandId: boundedString(input.commandId, 512, '命令事件 ID'),
      name: commandName(input.name, '命令事件名称'),
      ...(args === undefined ? {} : { args }),
      source: { kind: 'user' },
    }
  } catch {
    return null
  }
}

/** 校验并收窄 command/done 的 data；未知字段不会越过共享边界。 */
export function parseDesktopCommandDoneEventData(
  input: unknown,
  eventSeq: number,
): DesktopCommandDoneEventData | null {
  if (!isRecord(input)) return null
  try {
    const commandId = boundedString(input.commandId, 512, '命令事件 ID')
    const text =
      input.text === undefined
        ? undefined
        : boundedString(input.text, DESKTOP_COMMAND_RESULT_TEXT_MAX_LENGTH, '命令事件文本', {
            allowEmpty: true,
          })
    if (input.kind === 'error') {
      if (input.sourceEventSeq !== undefined) return null
      return { commandId, kind: 'error', ...(text === undefined ? {} : { text }) }
    }
    if (input.kind !== 'success') return null
    const sourceEventSeq = input.sourceEventSeq
    if (
      sourceEventSeq !== undefined &&
      (!Number.isSafeInteger(sourceEventSeq) ||
        Number(sourceEventSeq) < 0 ||
        Number(sourceEventSeq) >= eventSeq)
    )
      return null
    return {
      commandId,
      kind: 'success',
      ...(text === undefined ? {} : { text }),
      ...(sourceEventSeq === undefined ? {} : { sourceEventSeq: Number(sourceEventSeq) }),
    }
  } catch {
    return null
  }
}

/**
 * 解析已经提交的完整 slash invocation。候选面板可处理尚未输入完整的查询，
 * 但进入产品状态机后统一使用本函数提取名称，并保留参数区的原始空白。
 */
export function parseDesktopSlashInvocation(input: unknown): DesktopSlashInvocation | null {
  if (typeof input !== 'string') return null
  const match = /^\/([a-z0-9][a-z0-9_-]*)(?=$|\s)[\s\S]*$/u.exec(input)
  const name = match?.[1]
  return name !== undefined && name.length <= DESKTOP_COMMAND_NAME_MAX_LENGTH
    ? { name, line: input }
    : null
}

/** 校验完整 Host Command line，限制传输大小并保留输入原文。 */
export function parseDesktopSlashCommandLine(input: unknown): string | null {
  const invocation = parseDesktopSlashInvocation(input)
  if (
    invocation === null ||
    !COMMAND_NAME.test(invocation.name) ||
    new TextEncoder().encode(invocation.line).byteLength > DESKTOP_COMMAND_LINE_MAX_BYTES
  )
    return null
  return invocation.line
}
