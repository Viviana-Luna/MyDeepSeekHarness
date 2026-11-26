/** SQL 词法切分与标识符校验：按数据库引擎方言执行引号、注释和转义切分，拒绝危险字面量与未闭合结构。 */
import type { DatabaseEngine } from '../types.d.ts'
import { quoteIdentifier, validateIdentifierName } from './dialect.ts'

export { quoteIdentifier }

/** 单个 SQL 词法单元及其在原文本中的起止位置。 */
export interface SqlToken {
  readonly text: string
  readonly raw: string
  readonly kind: 'word' | 'quoted' | 'string' | 'number' | 'symbol'
  readonly start: number
  readonly end: number
}

/** 一条经过切分的独立 SQL 语句源码与词法列表。 */
export interface SqlStatementSlice {
  readonly raw: string
  readonly tokens: readonly SqlToken[]
}

/** 通用 SQL 扫描单元；保留字符串边界并跳过普通注释，供完整 SQL 的风险检查使用。 */
export interface ScannedSqlToken {
  readonly text: string
  readonly raw: string
  readonly kind: 'word' | 'quoted' | 'string' | 'number' | 'symbol'
  readonly start: number
  readonly end: number
}

const MAX_SQL_TOKENS = 16_384
const MAX_BATCH_STATEMENTS = 50
const MAX_TOTAL_SQL_BYTES = 256 * 1024

/** 判断引擎是否采用 ANSI 双引号标识符与无反斜杠转义的单引号字符串。 */
export function usesStandardSqlQuotes(engine: DatabaseEngine): boolean {
  return engine === 'postgresql' || engine === 'sqlite'
}

function readQuotedSegment(
  sql: string,
  start: number,
  quote: string,
  allowBackslashEscape: boolean,
): number {
  let index = start + 1
  while (index < sql.length) {
    const ch = sql[index]!
    if (allowBackslashEscape && ch === '\\') {
      if (index + 1 >= sql.length) throw new Error('SQL 字符串转义未闭合')
      index += 2
      continue
    }
    if (ch === quote) {
      if (sql[index + 1] === quote) {
        index += 2
        continue
      }
      return index + 1
    }
    index++
  }
  throw new Error('SQL 引号或标识符未闭合')
}

function assertNoNonStandardLiteral(rest: string, engine: DatabaseEngine): void {
  if (!usesStandardSqlQuotes(engine)) return
  if (/^(?:[Ee]'|[Uu]&['"])/u.test(rest) || /^\$[A-Za-z0-9_]*\$/u.test(rest)) {
    throw new Error('暂不支持美元定界、Unicode 或扩展转义字符串/标识符')
  }
}

function skipCommentIfPresent(sql: string, offset: number, engine: DatabaseEngine): number | null {
  const rest = sql.slice(offset)
  const hashComment = !usesStandardSqlQuotes(engine) && rest.startsWith('#')
  if (rest.startsWith('--') || hashComment) {
    const newline = sql.indexOf('\n', offset)
    return newline < 0 ? sql.length : newline + 1
  }
  if (!rest.startsWith('/*')) return null
  if (!usesStandardSqlQuotes(engine) && rest.startsWith('/*!'))
    throw new Error('SQL 不支持可执行注释（/*!）')
  let depth = 1
  let index = offset + 2
  while (index < sql.length && depth > 0) {
    if (engine === 'postgresql' && sql[index] === '/' && sql[index + 1] === '*') {
      depth++
      index += 2
      continue
    }
    if (sql[index] === '*' && sql[index + 1] === '/') {
      depth--
      index += 2
      continue
    }
    index++
  }
  if (depth !== 0) throw new Error('SQL 块注释未闭合')
  return index
}

function parseQuotedOrStringToken(
  sql: string,
  offset: number,
  engine: DatabaseEngine,
  preserveRawText: boolean,
): SqlToken {
  const head = sql[offset]!
  const standard = usesStandardSqlQuotes(engine)
  if (standard && head === '`') {
    throw new Error('当前数据库引擎请使用双引号 "..." 引用标识符，不要使用反引号')
  }
  const isIdentifier = standard ? head === '"' : head === '`'
  const allowBackslash = !standard && head !== '`'
  const end = readQuotedSegment(sql, offset, head, allowBackslash)
  const raw = sql.slice(offset, end)
  const unquoted =
    head === '`' ? raw.slice(1, -1).replaceAll('``', '`') : raw.slice(1, -1).replaceAll('""', '"')
  const text = preserveRawText ? raw : isIdentifier ? unquoted : ''
  return { raw, text, kind: isIdentifier ? 'quoted' : 'string', start: offset, end }
}

function matchSimpleToken(
  rest: string,
  engine: DatabaseEngine,
): { raw: string; kind: SqlToken['kind'] } | null {
  const numberMatch = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(rest)
  if (numberMatch) return { raw: numberMatch[0], kind: 'number' }
  const wordMatch = /^[A-Za-z_][A-Za-z0-9_$]*/u.exec(rest)
  if (wordMatch) return { raw: wordMatch[0], kind: 'word' }
  const symbolPattern = usesStandardSqlQuotes(engine)
    ? /^(?:::|\|\||<=|>=|<>|!=|[(),.*+\-/%=<>;:])/u
    : /^(?:<=>|<=|>=|<>|!=|[(),.*+\-/%=<>;:])/u
  const symbolMatch = symbolPattern.exec(rest)
  if (symbolMatch) return { raw: symbolMatch[0], kind: 'symbol' }
  return null
}

/**
 * 扫描可能包含子查询、CTE、窗口函数和普通注释的完整 SQL。
 * 字符串内容不会被当成关键字；按引擎方言跳过注释，可执行注释与非标准转义字符串直接拒绝。
 * @throws SQL 超长、可执行注释或注释/引号未闭合时抛出。
 */
export function scanSqlTokens(
  sql: string,
  maxTokens = MAX_SQL_TOKENS,
  engine: DatabaseEngine = 'mysql',
): ScannedSqlToken[] {
  if (typeof sql !== 'string' || Buffer.byteLength(sql, 'utf8') > MAX_TOTAL_SQL_BYTES)
    throw new Error('SQL 内容不能为空或超过 256 KiB 限制')
  const result: ScannedSqlToken[] = []
  let offset = 0
  while (offset < sql.length) {
    const rest = sql.slice(offset)
    const space = /^\s+/u.exec(rest)
    if (space) {
      offset += space[0].length
      continue
    }
    const afterComment = skipCommentIfPresent(sql, offset, engine)
    if (afterComment !== null) {
      offset = afterComment
      continue
    }
    assertNoNonStandardLiteral(rest, engine)
    const head = rest[0]!
    if (head === "'" || head === '"' || head === '`') {
      const token = parseQuotedOrStringToken(sql, offset, engine, false)
      result.push(token)
      offset = token.end
    } else {
      const word = /^[A-Za-z_][A-Za-z0-9_$]*/u.exec(rest)
      const number = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(rest)
      const multi =
        usesStandardSqlQuotes(engine) && (rest.startsWith('::') || rest.startsWith('||'))
          ? rest.slice(0, 2)
          : undefined
      const raw = word?.[0] ?? number?.[0] ?? multi ?? head
      result.push({
        raw,
        text: word ? raw.toUpperCase() : raw,
        kind: word ? 'word' : number ? 'number' : 'symbol',
        start: offset,
        end: offset + raw.length,
      })
      offset += raw.length
    }
    if (result.length > maxTokens) throw new Error('SQL 过于复杂，超过词法数量限制')
  }
  return result
}

/**
 * 将 SQL 字符串切分为词法单元列表；遇到注释、用户变量或不支持字符立即拒绝。
 * @throws SQL 超长、包含注释/变量或存在未闭合引号时抛出错误。
 */
export function tokenizeSql(
  sql: string,
  maxTokens = MAX_SQL_TOKENS,
  engine: DatabaseEngine = 'mysql',
): SqlToken[] {
  if (typeof sql !== 'string' || Buffer.byteLength(sql, 'utf8') > MAX_TOTAL_SQL_BYTES)
    throw new Error('SQL 内容不能为空或超过 256 KiB 限制')
  const result: SqlToken[] = []
  let offset = 0
  while (offset < sql.length) {
    const rest = sql.slice(offset)
    const space = /^\s+/u.exec(rest)
    if (space) {
      offset += space[0].length
      continue
    }
    if (
      rest.startsWith('--') ||
      rest.startsWith('/*') ||
      (!usesStandardSqlQuotes(engine) && rest.startsWith('#'))
    )
      throw new Error('SQL 不支持注释（--、/*、#）')
    assertNoNonStandardLiteral(rest, engine)
    const head = rest[0]!
    if (head === "'" || head === '"' || head === '`') {
      const token = parseQuotedOrStringToken(sql, offset, engine, true)
      result.push(token)
      offset = token.end
    } else {
      const matched = matchSimpleToken(rest, engine)
      if (!matched) throw new Error(`SQL 包含不支持的字符或变量（第 ${offset + 1} 字符附近）`)
      if (matched.raw === ':' && sql[offset + 1] === '=')
        throw new Error('SQL 不支持用户变量赋值（:=）')
      result.push({
        raw: matched.raw,
        text: matched.kind === 'word' ? matched.raw.toUpperCase() : matched.raw,
        kind: matched.kind,
        start: offset,
        end: offset + matched.raw.length,
      })
      offset += matched.raw.length
    }
    if (result.length > maxTokens) throw new Error('SQL 过于复杂，超过词法数量限制')
  }
  return result
}

/**
 * 按顶层分号拆分为多条独立 SQL 语句，保留每条语句原文供驱动逐条执行。
 * @throws 空输入、超过批量上限或存在空语句干扰时抛出错误。
 */
export function splitSqlStatements(
  sql: string,
  maxStatements = MAX_BATCH_STATEMENTS,
  engine: DatabaseEngine = 'mysql',
): SqlStatementSlice[] {
  const all = tokenizeSql(sql, MAX_SQL_TOKENS, engine)
  const slices: SqlStatementSlice[] = []
  let segment: SqlToken[] = []
  for (const token of all) {
    if (token.text === ';') {
      if (segment.length > 0) {
        slices.push({
          raw: sql.slice(segment[0]!.start, segment.at(-1)!.end),
          tokens: segment,
        })
        segment = []
      }
      continue
    }
    segment.push(token)
  }
  if (segment.length > 0) {
    slices.push({
      raw: sql.slice(segment[0]!.start, segment.at(-1)!.end),
      tokens: segment,
    })
  }
  if (slices.length === 0) throw new Error('请输入至少一条有效 SQL 语句')
  if (slices.length > maxStatements)
    throw new Error(`单次批量最多支持 ${maxStatements} 条 SQL 语句`)
  return slices
}

/** 将反引号、双引号或普通标识符还原为实际名称并校验长度与控制字符。 */
export function unquoteIdentifier(token: SqlToken): string {
  let name = ''
  if (token.kind === 'quoted') {
    if (token.raw.startsWith('`')) name = token.raw.slice(1, -1).replaceAll('``', '`')
    else if (token.raw.startsWith('"')) name = token.raw.slice(1, -1).replaceAll('""', '"')
  } else if (token.kind === 'word') {
    name = token.raw
  }
  validateIdentifierName(name, '数据库、表或列名称无效')
  return name
}
