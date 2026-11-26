/** 模型 SQL 执行分类与硬边界校验：按引擎区分只读与变更语句，严禁系统库、文件读取及账号管理。 */
import type { DatabaseEngine, DatabaseMutationOperation } from '../types.d.ts'
import { isSystemSchema, isSystemTable } from './dialect.ts'
import { scanSqlTokens, usesStandardSqlQuotes, type ScannedSqlToken } from './sql-tokens.ts'

/** 一条由模型提交、按执行方式分类后的 SQL。 */
export interface ClassifiedDatabaseSql {
  readonly sql: string
  readonly mode: 'read' | 'mutation'
  readonly operation?: DatabaseMutationOperation
}

/** 一组只能同为读取或同为变更的模型 SQL。 */
export interface ClassifiedDatabaseSqlBatch {
  readonly mode: 'read' | 'mutation'
  readonly statements: readonly ClassifiedDatabaseSql[]
}

const READ_KEYWORDS = new Set(['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN'])
const MUTATION_KEYWORDS: Readonly<Record<string, DatabaseMutationOperation>> = {
  INSERT: 'insert',
  REPLACE: 'insert',
  UPDATE: 'update',
  DELETE: 'delete',
  CREATE: 'ddl',
  ALTER: 'ddl',
  DROP: 'ddl',
  TRUNCATE: 'ddl',
  RENAME: 'ddl',
}

const SYSTEM_LOOKUP_HEADS = new Set(['SHOW', 'DESCRIBE', 'DESC'])
const SYSTEM_SCHEMA_HINT = '系统库不开放给模型；请改用 database_schema 读取业务库、表和字段结构'
const CREATE_OBJECTS = new Set(['DATABASE', 'SCHEMA', 'TABLE', 'VIEW', 'INDEX'])
const ALTER_OBJECTS = new Set(['DATABASE', 'SCHEMA', 'TABLE'])
const DROP_OBJECTS = new Set(['DATABASE', 'SCHEMA', 'TABLE', 'VIEW', 'INDEX'])
const DDL_FORBIDDEN_PAIRS: readonly [string, string][] = [
  ['DATA', 'DIRECTORY'],
  ['INDEX', 'DIRECTORY'],
  ['DISCARD', 'TABLESPACE'],
  ['IMPORT', 'TABLESPACE'],
  ['FOREIGN', 'DATA'],
  ['FOREIGN', 'SERVER'],
  ['FOREIGN', 'TABLE'],
]
const FORBIDDEN_FUNCTIONS = new Set([
  'LOAD_FILE',
  'PG_READ_FILE',
  'PG_READ_BINARY_FILE',
  'PG_LS_DIR',
  'PG_STAT_FILE',
  'LO_IMPORT',
  'LO_EXPORT',
  'LO_GET',
  'LO_PUT',
  'DBLINK',
  'DBLINK_EXEC',
  'DBLINK_CONNECT',
  'DBLINK_SEND_QUERY',
  'PG_EXECUTE_SERVER_PROGRAM',
  'PG_TERMINATE_BACKEND',
  'PG_CANCEL_BACKEND',
  'PG_RELOAD_CONF',
  'PG_ROTATE_LOGFILE',
  'SET_CONFIG',
  'LOAD_EXTENSION',
  'READFILE',
  'WRITEFILE',
])
const FORBIDDEN_HEAD_OBJECTS = new Set([
  'USER',
  'ROLE',
  'EVENT',
  'TRIGGER',
  'PROCEDURE',
  'FUNCTION',
  'SERVER',
  'TABLESPACE',
  'EXTENSION',
  'POLICY',
  'SYSTEM',
  'PUBLICATION',
  'SUBSCRIPTION',
  'LANGUAGE',
  'FOREIGN',
])
const SHOW_DIRECT_TARGETS = new Set([
  'TABLES',
  'COLUMNS',
  'FIELDS',
  'INDEX',
  'INDEXES',
  'KEYS',
  'DATABASES',
  'SCHEMAS',
  'WARNINGS',
  'ERRORS',
  'CHARSET',
  'COLLATION',
])
const SHOW_CREATE_TARGETS = new Set(['TABLE', 'VIEW', 'DATABASE', 'SCHEMA'])
const SHOW_MODIFIERS = new Set(['EXTENDED', 'FULL'])
const CREATE_MODIFIERS = new Set([
  'OR',
  'REPLACE',
  'TEMPORARY',
  'UNIQUE',
  'FULLTEXT',
  'SPATIAL',
  'ALGORITHM',
  'UNDEFINED',
  'MERGE',
  'TEMPTABLE',
  'SQL',
  'SECURITY',
  'INVOKER',
])

function skipTrivia(sql: string, start: number, engine: DatabaseEngine = 'mysql'): number {
  let offset = start
  const standard = usesStandardSqlQuotes(engine)
  while (offset < sql.length) {
    const rest = sql.slice(offset)
    const whitespace = /^\s+/u.exec(rest)
    if (whitespace) {
      offset += whitespace[0].length
      continue
    }
    if (rest.startsWith('--') || (!standard && rest.startsWith('#'))) {
      const newline = sql.indexOf('\n', offset)
      offset = newline < 0 ? sql.length : newline + 1
      continue
    }
    if (rest.startsWith('/*')) {
      let depth = 1
      let pos = offset + 2
      while (pos < sql.length && depth > 0) {
        if (engine === 'postgresql' && sql[pos] === '/' && sql[pos + 1] === '*') {
          depth++
          pos += 2
          continue
        }
        if (sql[pos] === '*' && sql[pos + 1] === '/') {
          depth--
          pos += 2
          continue
        }
        pos++
      }
      if (depth !== 0) throw new Error('SQL 块注释未闭合')
      offset = pos
      continue
    }
    break
  }
  return offset
}

function readKeyword(
  sql: string,
  start: number,
  engine: DatabaseEngine = 'mysql',
): { keyword: string; end: number } | undefined {
  const offset = skipTrivia(sql, start, engine)
  const match = /^[A-Za-z_][A-Za-z0-9_$]*/u.exec(sql.slice(offset))
  return match ? { keyword: match[0].toUpperCase(), end: offset + match[0].length } : undefined
}

function skipLeadingOpenParens(
  sql: string,
  start: number,
  engine: DatabaseEngine = 'mysql',
): number {
  let offset = skipTrivia(sql, start, engine)
  while (offset < sql.length && sql[offset] === '(') {
    offset = skipTrivia(sql, offset + 1, engine)
  }
  return offset
}

function hasStatementHead(segment: string, engine: DatabaseEngine = 'mysql'): boolean {
  return readKeyword(segment, skipLeadingOpenParens(segment, 0, engine), engine) !== undefined
}

function skipBalancedParens(tokens: readonly ScannedSqlToken[], start: number): number {
  if (tokens[start]?.text !== '(') return -1
  let depth = 0
  for (let index = start; index < tokens.length; index++) {
    if (tokens[index]?.text === '(') depth++
    else if (tokens[index]?.text === ')') {
      depth--
      if (depth === 0) return index + 1
    }
  }
  return -1
}

function withMainStatementIndex(tokens: readonly ScannedSqlToken[]): number {
  let index = 1
  if (tokens[index]?.kind === 'word' && tokens[index]!.text === 'RECURSIVE') index++
  while (index < tokens.length) {
    if (identifierOf(tokens[index]) === null) break
    index++
    if (tokens[index]?.text === '(') {
      index = skipBalancedParens(tokens, index)
      if (index < 0) throw new Error('WITH 子句列定义括号未闭合')
    }
    if (tokens[index]?.kind !== 'word' || tokens[index]!.text !== 'AS') break
    index++
    index = skipBalancedParens(tokens, index)
    if (index < 0) throw new Error('WITH 子句括号未闭合')
    if (tokens[index]?.text !== ',') break
    index++
  }
  return index
}

function classifyWithStatement(
  sql: string,
  fullSql = sql,
  engine: DatabaseEngine = 'mysql',
): ClassifiedDatabaseSql {
  const tokens = scanSqlTokens(sql, undefined, engine)
  const index = withMainStatementIndex(tokens)
  const verb = tokens[index]?.kind === 'word' ? tokens[index]!.text : undefined
  if (verb === 'SELECT' || (verb === 'VALUES' && usesStandardSqlQuotes(engine)))
    return { sql: fullSql, mode: 'read' }
  if (verb === 'UPDATE') return { sql: fullSql, mode: 'mutation', operation: 'update' }
  if (verb === 'DELETE') return { sql: fullSql, mode: 'mutation', operation: 'delete' }
  if (verb === 'INSERT' && usesStandardSqlQuotes(engine))
    return { sql: fullSql, mode: 'mutation', operation: 'insert' }
  throw new Error(`暂不支持通过模型执行 WITH ${verb ?? ''} 语句`)
}

function hasTopLevelWhere(tokens: readonly ScannedSqlToken[], start: number): boolean {
  let depth = 0
  for (let index = start; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token.text === '(') depth++
    else if (token.text === ')') depth = Math.max(0, depth - 1)
    else if (depth === 0 && token.kind === 'word' && token.text === 'WHERE') return true
  }
  return false
}

/**
 * 识别不可逆或大范围破坏性变更（库级 DDL、DROP TABLE/VIEW、TRUNCATE、无 WHERE 删改）。
 * 这些语句必须每次单独由用户确认，绝不能沿用本会话自动放行或提权。
 */
export function destructiveMutationReasons(
  sql: string,
  engine: DatabaseEngine = 'mysql',
): string[] {
  const tokens = scanSqlTokens(sql, undefined, engine)
  const start = wordOf(tokens[0]) === 'WITH' ? withMainStatementIndex(tokens) : 0
  const verb = wordOf(tokens[start])
  if (verb === 'TRUNCATE') return ['TRUNCATE 会不可逆清空整张表，必须每次单独确认']
  if (verb === 'DELETE' && !hasTopLevelWhere(tokens, start + 1))
    return ['无 WHERE 条件的 DELETE 会删除整张表所有数据，必须每次单独确认']
  if (verb === 'UPDATE' && !hasTopLevelWhere(tokens, start + 1))
    return ['无 WHERE 条件的 UPDATE 会修改整张表所有数据，必须每次单独确认']
  if (verb === 'DROP') {
    let index = start + 1
    while (wordOf(tokens[index]) === 'TEMPORARY') index++
    const target = wordOf(tokens[index])
    if (target === 'DATABASE' || target === 'SCHEMA')
      return ['DROP DATABASE 会不可逆删除整个数据库，必须每次单独确认']
    if (target === 'TABLE') return ['DROP TABLE 会不可逆删除表及全部数据，必须每次单独确认']
    if (target === 'VIEW') return ['DROP VIEW 会删除视图定义，必须每次单独确认']
  }
  if (verb === 'CREATE' || verb === 'ALTER') {
    const modifiers =
      verb === 'CREATE' ? CREATE_MODIFIERS : new Set(['ONLINE', 'OFFLINE', 'IGNORE'])
    for (let index = start + 1; index < tokens.length; index++) {
      const word = wordOf(tokens[index])
      if (!word) continue
      if (word === 'DATABASE' || word === 'SCHEMA')
        return ['库级 DDL（CREATE/ALTER DATABASE）影响整个数据库，必须每次单独确认']
      if (!modifiers.has(word)) break
    }
  }
  return []
}

/**
 * 将单条 SQL 分类为只读或变更执行。
 * 完整开放连接不解析列和表级权限，因此这里只判断首个关键字（WITH 需识别主语句动词，支持括号包裹的 SELECT/UNION）；真正的只读保证仍来自数据库只读事务。
 * @throws SQL 为空、超过 64 KiB 或首关键字不属于支持的读写类别时抛出。
 */
export function classifyDatabaseSql(
  sql: string,
  engine: DatabaseEngine = 'mysql',
): ClassifiedDatabaseSql {
  if (typeof sql !== 'string' || !sql.trim() || Buffer.byteLength(sql, 'utf8') > 64 * 1024)
    throw new Error('请输入不超过 64 KiB 的单条 SQL')
  const first = readKeyword(sql, 0, engine)
  if (!first) {
    const innerOffset = skipLeadingOpenParens(sql, 0, engine)
    if (innerOffset > skipTrivia(sql, 0, engine)) {
      const inner = readKeyword(sql, innerOffset, engine)
      if (inner?.keyword === 'SELECT') return { sql, mode: 'read' }
      if (inner?.keyword === 'WITH') {
        const classified = classifyWithStatement(sql.slice(innerOffset), sql, engine)
        if (classified.mode === 'read') return classified
      }
    }
    throw new Error('SQL 必须从可识别的语句关键字开始')
  }
  if (first.keyword === 'WITH') return classifyWithStatement(sql, sql, engine)
  if (
    READ_KEYWORDS.has(first.keyword) ||
    (first.keyword === 'VALUES' && usesStandardSqlQuotes(engine))
  ) {
    return { sql, mode: 'read' }
  }
  const operation = MUTATION_KEYWORDS[first.keyword]
  if (operation) {
    if (engine === 'sqlite' && first.keyword === 'TRUNCATE')
      throw new Error('SQLite 不支持 TRUNCATE，请改用带确认的 DELETE FROM 语句')
    const second = readKeyword(sql, first.end, engine)
    if (
      ['CREATE', 'ALTER', 'DROP'].includes(first.keyword) &&
      FORBIDDEN_HEAD_OBJECTS.has(second?.keyword ?? '')
    )
      throw new Error(
        `不允许通过模型 SQL 管理数据库账号或服务器对象：${first.keyword} ${second!.keyword}`,
      )
    return { sql, mode: 'mutation', operation }
  }
  throw new Error(`暂不支持通过模型执行 ${first.keyword} 语句`)
}

function identifierOf(token: ScannedSqlToken | undefined): string | null {
  return token?.kind === 'word' || token?.kind === 'quoted' ? token.text : null
}

function wordOf(token: ScannedSqlToken | undefined): string | undefined {
  return token?.kind === 'word' ? token.text : undefined
}

function assertShowAllowed(tokens: readonly ScannedSqlToken[]): void {
  let index = 1
  while (SHOW_MODIFIERS.has(wordOf(tokens[index]) ?? '')) index++
  const target = wordOf(tokens[index])
  if (target && SHOW_DIRECT_TARGETS.has(target)) return
  const next = wordOf(tokens[index + 1])
  if (target === 'TABLE' && next === 'STATUS') return
  if (target === 'CHARACTER' && next === 'SET') return
  if (target === 'CREATE' && next && SHOW_CREATE_TARGETS.has(next)) return
  throw new Error(
    `不允许通过模型执行 SHOW ${target ?? ''}${target === 'CREATE' && next ? ` ${next}` : ''}，仅开放业务表和库结构读取`,
  )
}

function assertDatabaseSchemaTargetAllowed(
  tokens: readonly ScannedSqlToken[],
  index: number,
  engine: DatabaseEngine,
): void {
  const objectWord = wordOf(tokens[index])
  if (engine === 'sqlite') throw new Error('SQLite 本地数据库不支持 DATABASE 或 SCHEMA 管理语句')
  if (engine === 'postgresql' && objectWord === 'DATABASE')
    throw new Error('PostgreSQL 单连接仅绑定一个数据库，请勿通过模型创建、修改或删除数据库实例')
  let next = index + 1
  if (wordOf(tokens[next]) === 'IF') {
    next++
    if (wordOf(tokens[next]) === 'NOT') next++
    if (wordOf(tokens[next]) === 'EXISTS') next++
  }
  const schema = identifierOf(tokens[next])
  if (schema && isSystemSchema(schema, engine))
    throw new Error(`不允许访问系统库 ${schema}；${SYSTEM_SCHEMA_HINT}`)
}

function assertMutationObject(tokens: readonly ScannedSqlToken[], engine: DatabaseEngine): void {
  const head = identifierOf(tokens.find(token => identifierOf(token) !== null))
  if (!head || READ_KEYWORDS.has(head) || head === 'VALUES') return
  if (['INSERT', 'REPLACE', 'UPDATE', 'DELETE', 'TRUNCATE'].includes(head)) {
    if (engine === 'sqlite' && head === 'TRUNCATE')
      throw new Error('SQLite 不支持 TRUNCATE，请改用带确认的 DELETE FROM 语句')
    return
  }
  const allowed =
    head === 'CREATE'
      ? CREATE_OBJECTS
      : head === 'ALTER'
        ? ALTER_OBJECTS
        : head === 'DROP'
          ? DROP_OBJECTS
          : head === 'RENAME'
            ? new Set(['TABLE'])
            : undefined
  if (!allowed) throw new Error(`不允许通过模型执行 ${head} 语句，仅开放业务表数据与表结构操作`)
  const modifiers =
    head === 'CREATE'
      ? CREATE_MODIFIERS
      : new Set(head === 'DROP' ? ['TEMPORARY'] : ['ONLINE', 'OFFLINE', 'IGNORE'])
  let started = false
  for (const token of tokens) {
    const word = identifierOf(token)
    if (!word) continue
    if (!started) {
      started = true
      continue
    }
    if (allowed.has(word)) return
    if (!modifiers.has(word))
      throw new Error(`不允许通过模型管理数据库账号、服务器对象或${word}：${head} ${word}`)
  }
  throw new Error(`无法确认 ${head} 操作的业务表对象，请使用明确的表、库、索引或视图语句`)
}

function assertExplainReadOnly(tokens: readonly ScannedSqlToken[]): void {
  if (wordOf(tokens[1]) === 'FOR' && wordOf(tokens[2]) === 'CONNECTION')
    throw new Error('不允许通过模型检查其他数据库会话的执行计划')
  for (const token of tokens) {
    const word = wordOf(token)
    if (word && word in MUTATION_KEYWORDS) {
      throw new Error(`EXPLAIN 仅允许分析只读查询，不能包含变更动词：${word}`)
    }
  }
}

/**
 * 对完整 SQL 模式执行非表能力检查，不限制子查询、CTE、UNION 或窗口函数。
 * @throws 引用系统库、服务端文件、账号管理或其他非业务表对象时抛出。
 */
export function assertGeneralDatabaseSqlAllowed(
  sql: string,
  defaultDatabase: string | null,
  engine: DatabaseEngine = 'mysql',
): void {
  if (defaultDatabase !== null && isSystemSchema(defaultDatabase, engine))
    throw new Error(`不允许访问系统库 ${defaultDatabase}；${SYSTEM_SCHEMA_HINT}`)
  const tokens = scanSqlTokens(sql, undefined, engine)
  const head = identifierOf(tokens[0])
  if (head === 'SHOW') {
    if (usesStandardSqlQuotes(engine))
      throw new Error('当前数据库引擎请改用 database_schema 或 SELECT 查询元数据')
    assertShowAllowed(tokens)
  }
  if (head === 'EXPLAIN') assertExplainReadOnly(tokens)
  for (let index = 0; index < tokens.length; index++) {
    const current = tokens[index]!
    const next = tokens[index + 1]
    const identifier = identifierOf(current)
    if (identifier && isSystemTable(identifier, engine))
      throw new Error(`不允许访问系统保留表 ${identifier}；${SYSTEM_SCHEMA_HINT}`)
    if (
      identifier &&
      isSystemSchema(identifier, engine) &&
      (next?.text === '.' || SYSTEM_LOOKUP_HEADS.has(head ?? ''))
    )
      throw new Error(`不允许访问系统库 ${identifier}；${SYSTEM_SCHEMA_HINT}`)
    if (
      current.kind === 'word' &&
      (current.text === 'DATABASE' || current.text === 'SCHEMA') &&
      ['CREATE', 'ALTER', 'DROP'].includes(head ?? '')
    )
      assertDatabaseSchemaTargetAllowed(tokens, index, engine)
    if (
      current.kind === 'word' &&
      next?.kind === 'word' &&
      DDL_FORBIDDEN_PAIRS.some(([a, b]) => a === current.text && b === next.text)
    )
      throw new Error(
        `不允许通过模型使用磁盘路径、外部表或表空间导入导出选项：${current.raw} ${next.raw}`,
      )
    if (identifier && FORBIDDEN_FUNCTIONS.has(identifier.toUpperCase()) && next?.text === '(')
      throw new Error('不允许通过模型读取或修改服务端文件及运行环境')
    if (
      ['OUTFILE', 'DUMPFILE'].includes(identifier?.toUpperCase() ?? '') &&
      identifierOf(tokens[index - 1])?.toUpperCase() === 'INTO'
    )
      throw new Error('不允许通过模型写入服务端文件')
  }
  assertMutationObject(tokens, engine)
}

function splitGenericSql(sql: string, engine: DatabaseEngine = 'mysql'): string[] {
  const statements: string[] = []
  const standard = usesStandardSqlQuotes(engine)
  let start = 0
  let quote: "'" | '"' | '`' | undefined
  let lineComment = false
  let blockDepth = 0
  for (let index = 0; index < sql.length; index++) {
    const current = sql[index]!
    const next = sql[index + 1]
    if (lineComment) {
      if (current === '\n') lineComment = false
      continue
    }
    if (blockDepth > 0) {
      if (engine === 'postgresql' && current === '/' && next === '*') {
        blockDepth++
        index++
        continue
      }
      if (current === '*' && next === '/') {
        blockDepth--
        index++
      }
      continue
    }
    if (quote) {
      if (!standard && current === '\\' && quote !== '`') {
        index++
        continue
      }
      if (current === quote) {
        if (next === quote) {
          index++
          continue
        }
        quote = undefined
      }
      continue
    }
    if (standard && current === '`')
      throw new Error('当前数据库引擎请使用双引号 "..." 引用标识符，不要使用反引号')
    const prevWordChar = index > 0 && /[A-Za-z0-9_$]/u.test(sql[index - 1]!)
    if (
      standard &&
      !prevWordChar &&
      (((current === 'e' || current === 'E') && next === "'") ||
        ((current === 'u' || current === 'U') &&
          next === '&' &&
          (sql[index + 2] === "'" || sql[index + 2] === '"')))
    )
      throw new Error('暂不支持美元定界、Unicode 或扩展转义字符串/标识符')
    if (standard && current === '$' && /^\$[A-Za-z0-9_]*\$/u.test(sql.slice(index)))
      throw new Error('暂不支持美元定界或扩展转义字符串，请使用标准单引号字符串')
    if (current === "'" || current === '"' || current === '`') {
      quote = current
      continue
    }
    if ((!standard && current === '#') || (current === '-' && next === '-')) {
      lineComment = true
      if (next === '-') index++
      continue
    }
    if (current === '/' && next === '*') {
      if (!standard && sql[index + 2] === '!') throw new Error('SQL 不支持可执行注释（/*!）')
      blockDepth = 1
      index++
      continue
    }
    if (current !== ';') continue
    const segment = sql.slice(start, index).trim()
    if (hasStatementHead(segment, engine)) statements.push(segment)
    start = index + 1
  }
  if (quote) throw new Error('SQL 引号或标识符未闭合')
  if (blockDepth > 0) throw new Error('SQL 块注释未闭合')
  const tail = sql.slice(start).trim()
  if (hasStatementHead(tail, engine)) statements.push(tail)
  if (statements.length === 0) throw new Error('请输入至少一条有效 SQL 语句')
  return statements
}

/**
 * 将单条 SQL、分号脚本或 SQL 数组统一分类。
 * 同一批不能混用读取和变更语句，避免隐式改变事务语义；调用方应拆成独立调用。
 * @throws 批次超过上限、读取与变更混合或存在不支持的语句时抛出。
 */
export function classifyDatabaseSqlBatch(
  input: string | readonly string[],
  maxStatements = 20,
  engine: DatabaseEngine = 'mysql',
): ClassifiedDatabaseSqlBatch {
  const inputs = typeof input === 'string' ? [input] : input
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error('请提供至少一条 SQL 语句')
  const statements = inputs.flatMap(item => {
    if (typeof item !== 'string') throw new Error('SQL 列表中每一项都必须是字符串')
    return splitGenericSql(item, engine)
  })
  if (statements.length > maxStatements)
    throw new Error(`单次最多执行 ${maxStatements} 条 SQL 语句`)
  const classified = statements.map(item => classifyDatabaseSql(item, engine))
  const mode = classified[0]!.mode
  if (classified.some(item => item.mode !== mode))
    throw new Error('单次调用不能混合读取和变更 SQL，请拆分后分别执行')
  return { mode, statements: classified }
}
