/** 只读 SELECT 解析与安全子集校验：支持多引擎方言单表与 JOIN 读取，并提取目标库表用于权限控制。 */
import type { DatabaseEngine, DatabaseStatementTarget } from '../types.d.ts'
import { isSystemSchema, isSystemTable, quoteIdentifier } from './dialect.ts'
import { splitSqlStatements, unquoteIdentifier, type SqlToken } from './sql-tokens.ts'

export { quoteIdentifier }

/** 经过校验的只读 SELECT 语句及其涉及的目标库表集合。 */
export interface AdmittedReadQuery {
  readonly sql: string
  readonly targets: readonly DatabaseStatementTarget[]
}

const ALLOWED_FUNCTIONS = new Set([
  'COUNT',
  'SUM',
  'MIN',
  'MAX',
  'AVG',
  'ABS',
  'ROUND',
  'FLOOR',
  'CEIL',
  'CEILING',
  'LOWER',
  'UPPER',
  'LENGTH',
  'CHAR_LENGTH',
  'COALESCE',
  'IFNULL',
  'NULLIF',
  'IF',
  'CONCAT',
  'CONCAT_WS',
  'SUBSTRING',
  'SUBSTR',
  'TRIM',
  'LTRIM',
  'RTRIM',
  'REPLACE',
  'LEFT',
  'RIGHT',
  'DATE',
  'YEAR',
  'MONTH',
  'DAY',
  'HOUR',
  'MINUTE',
  'SECOND',
  'NOW',
  'CURDATE',
  'CURRENT_TIMESTAMP',
  'UNIX_TIMESTAMP',
  'FROM_UNIXTIME',
  'DATE_FORMAT',
  'DATEDIFF',
  'TIMESTAMPDIFF',
  'GREATEST',
  'LEAST',
  'HEX',
  'JSON_EXTRACT',
  'JSON_UNQUOTE',
  'JSON_LENGTH',
  'JSON_CONTAINS',
  'JSON_OBJECT',
  'JSON_ARRAY',
  'JSON_TYPE',
  'JSON_TYPEOF',
  'JSON_VALID',
  'JSON_ARRAY_LENGTH',
  'JSON_BUILD_OBJECT',
  'JSON_BUILD_ARRAY',
  'JSON_GROUP_ARRAY',
  'JSON_GROUP_OBJECT',
  'JSONB_TYPEOF',
  'JSONB_ARRAY_LENGTH',
  'JSONB_EXTRACT_PATH',
  'JSONB_EXTRACT_PATH_TEXT',
  'JSONB_BUILD_OBJECT',
  'JSONB_BUILD_ARRAY',
  'DATE_TRUNC',
  'DATE_PART',
  'TO_CHAR',
  'AGE',
  'STRING_AGG',
  'ARRAY_AGG',
  'SPLIT_PART',
  'BTRIM',
  'POSITION',
  'STRPOS',
  'FORMAT',
  'STRFTIME',
  'DATETIME',
  'TIME',
  'JULIANDAY',
  'UNIXEPOCH',
  'PRINTF',
  'GROUP_CONCAT',
  'TOTAL',
  'TYPEOF',
  'IIF',
  'INSTR',
  'UNICODE',
  'CHAR',
  'TRUNC',
  'POWER',
  'SQRT',
])

const DATABASE_SCHEMA_READ_HINT =
  '需要探活连接或读取结构时，请改用 database_schema：先执行 action="schemas" 列出数据库，再用 action="tables" 和 schema 读取表清单'

const RESERVED_CLAUSES = new Set([
  'FROM',
  'WHERE',
  'GROUP',
  'HAVING',
  'ORDER',
  'LIMIT',
  'OFFSET',
  'ASC',
  'DESC',
  'AND',
  'OR',
  'NOT',
  'IS',
  'IN',
  'LIKE',
  'ILIKE',
  'BETWEEN',
  'AS',
  'BY',
  'SELECT',
  'DISTINCT',
  'JOIN',
  'INNER',
  'LEFT',
  'RIGHT',
  'CROSS',
  'OUTER',
  'ON',
  'USING',
  'UNION',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'INTO',
  'OUTFILE',
  'DUMPFILE',
  'FOR',
  'LOCK',
  'RETURNING',
  'NULL',
  'TRUE',
  'FALSE',
])

/** 简单的顺序词法游标，供读取与变更语句共用表达式解析。 */
export class TokenCursor {
  index = 0
  private depth = 0

  /** @param tokens 词法切片；@param messagePrefix 解析出错时的统一提示前缀；@param engine 目标数据库引擎。 */
  constructor(
    readonly tokens: readonly SqlToken[],
    private readonly messagePrefix = 'SQL 不在支持范围内',
    readonly engine: DatabaseEngine = 'mysql',
  ) {}

  /** 当前位置的标准化文本。 */
  peek(offset = 0): string | undefined {
    return this.tokens[this.index + offset]?.text
  }

  /** 当前位置的原始词法单元。 */
  current(): SqlToken | undefined {
    return this.tokens[this.index]
  }

  /** 若当前词法匹配预期关键字/符号则消费并返回 true。 */
  take(text: string): boolean {
    if (this.peek() !== text) return false
    this.index++
    return true
  }

  /** 断言当前位置匹配指定关键字/符号。 */
  require(text: string): void {
    if (!this.take(text)) this.fail()
  }

  /** 在当前位置抛出带定位的语法拒绝错误。 */
  fail(reason?: string): never {
    const suffix = reason ? `：${reason}` : `（第 ${this.index + 1} 项附近）`
    throw new Error(`${this.messagePrefix}${suffix}`)
  }

  /** 读取一个合法标识符并返回其真实名称。 */
  readIdentifier(): string {
    const token = this.current()
    if (
      !token ||
      (token.kind !== 'quoted' && (token.kind !== 'word' || RESERVED_CLAUSES.has(token.text)))
    ) {
      this.fail()
    }
    this.index++
    return unquoteIdentifier(token)
  }

  /** 读取可选限定的列或通配符引用（如 `col`、`t.col`、`db.t.*`）。 */
  readQualifiedColumn(): void {
    this.readIdentifier()
    if (!this.take('.')) return
    if (this.take('*')) return
    this.readIdentifier()
    if (this.take('.')) {
      if (!this.take('*')) this.readIdentifier()
    }
  }

  /** 读取无符号安全整数。 */
  readInteger(): number {
    const token = this.tokens[this.index++]
    if (
      token?.kind !== 'number' ||
      !/^\d+$/u.test(token.text) ||
      !Number.isSafeInteger(Number(token.text))
    ) {
      this.fail()
    }
    return Number(token.text)
  }

  /** 解析安全表达式（字面量、函数、CASE、类型转换、算术、比较与逻辑组合）。 */
  parseExpression(minimum = 0): void {
    if (++this.depth > 32) this.fail('表达式嵌套过深')
    this.parsePrimary()
    while (this.engine === 'postgresql' && this.take('::')) {
      this.parseTypeCastSuffix()
    }
    this.parseBinaryTail(minimum)
    this.depth--
  }

  private parseTypeCastSuffix(): void {
    this.readIdentifier()
    if (this.take('.')) this.readIdentifier()
    if (this.take('(')) {
      this.readInteger()
      while (this.take(',')) this.readInteger()
      this.require(')')
    }
  }

  private parsePrimary(): void {
    if (this.take('+') || this.take('-') || this.take('NOT')) {
      this.parseExpression(7)
      return
    }
    if (this.take('(')) {
      this.parseExpression()
      this.require(')')
      return
    }
    if (this.take('CASE')) {
      this.parseCaseExpression()
      return
    }
    if (
      this.take('*') ||
      this.take('NULL') ||
      this.take('TRUE') ||
      this.take('FALSE') ||
      this.take('DEFAULT') ||
      this.take('CURRENT_DATE') ||
      this.take('CURRENT_TIME') ||
      this.take('CURRENT_TIMESTAMP')
    ) {
      return
    }
    const token = this.current()
    if (token?.kind === 'string' || token?.kind === 'number') {
      this.index++
      return
    }
    if (this.peek(1) === '(') {
      this.parseFunctionCall()
      return
    }
    this.readQualifiedColumn()
  }

  private parseCaseExpression(): void {
    if (this.peek() !== 'WHEN') this.parseExpression()
    let branches = 0
    while (this.take('WHEN')) {
      branches++
      this.parseExpression()
      this.require('THEN')
      this.parseExpression()
    }
    if (branches === 0) this.fail()
    if (this.take('ELSE')) this.parseExpression()
    this.require('END')
  }

  private parseFunctionCall(): void {
    const token = this.current()
    const name = this.peek()
    if (!token || token.kind !== 'word' || !name || !ALLOWED_FUNCTIONS.has(name)) {
      this.fail('包含不支持的函数或子查询')
    }
    this.index += 2
    if (this.take(')')) return
    this.take('DISTINCT')
    this.parseExpression()
    while (this.take(',')) this.parseExpression()
    this.require(')')
  }

  private parseBinaryTail(minimum: number): void {
    for (;;) {
      const op = this.peek()
      const priority = operatorPriority(op, this.engine)
      if (!priority || priority <= minimum) break
      this.index++
      let comparison = op
      if (op === 'NOT') {
        comparison = this.peek()
        const allowedNegated =
          this.engine === 'postgresql'
            ? ['IN', 'LIKE', 'ILIKE', 'BETWEEN']
            : ['IN', 'LIKE', 'BETWEEN']
        if (!allowedNegated.includes(comparison ?? '')) this.fail()
        this.index++
      }
      if (comparison === 'IS') {
        this.take('NOT')
        this.require('NULL')
      } else if (comparison === 'IN') {
        this.require('(')
        this.parseExpression()
        while (this.take(',')) this.parseExpression()
        this.require(')')
      } else if (comparison === 'BETWEEN') {
        this.parseExpression(priority)
        this.require('AND')
        this.parseExpression(priority)
      } else {
        this.parseExpression(priority)
      }
    }
  }
}

function operatorPriority(op: string | undefined, engine: DatabaseEngine): number {
  if (op === 'OR') return 1
  if (op === 'AND') return 2
  const comparisons = [
    '=',
    '!=',
    '<>',
    '<',
    '>',
    '<=',
    '>=',
    'IS',
    'IN',
    'LIKE',
    'BETWEEN',
    'NOT',
    ...(engine === 'postgresql' ? ['ILIKE'] : ['<=>']),
  ]
  if (comparisons.includes(op ?? '')) return 3
  if (op === '+' || op === '-' || (op === '||' && (engine === 'postgresql' || engine === 'sqlite')))
    return 4
  if (op === '*' || op === '/' || op === '%') return 5
  return 0
}

/**
 * 读取 `[db.]table` 表定位并校验数据库名称不为空且不属于系统库或系统保留表。
 * @param systemSchemaHint 模型读取系统库时追加的替代路径提示。
 */
export function readQualifiedTable(
  cursor: TokenCursor,
  defaultDatabase: string | null,
  systemSchemaHint?: string,
): { schema: string; table: string } {
  const first = cursor.readIdentifier()
  if (cursor.take('.')) {
    const second = cursor.readIdentifier()
    if (isSystemSchema(first, cursor.engine)) throw systemSchemaError(first, systemSchemaHint)
    if (cursor.engine === 'sqlite' && first !== 'main')
      throw new Error('SQLite 本地数据库仅支持 main 命名空间')
    if (isSystemTable(second, cursor.engine)) throw new Error(`不允许访问系统保留表 ${second}`)
    return { schema: first, table: second }
  }
  if (!defaultDatabase)
    throw new Error(`请使用 库名.表名 指定数据库，或在参数 database / 默认库中指定目标数据库`)
  if (isSystemSchema(defaultDatabase, cursor.engine))
    throw systemSchemaError(defaultDatabase, systemSchemaHint)
  if (isSystemTable(first, cursor.engine)) throw new Error(`不允许访问系统保留表 ${first}`)
  return { schema: defaultDatabase, table: first }
}

function systemSchemaError(schema: string, hint?: string): Error {
  return new Error(`不允许访问系统库 ${schema}${hint ? `；${hint}` : ''}`)
}

function parseOptionalAlias(cursor: TokenCursor): void {
  if (cursor.take('AS')) {
    cursor.readIdentifier()
    return
  }
  const next = cursor.current()
  if (
    next &&
    (next.kind === 'quoted' || (next.kind === 'word' && !RESERVED_CLAUSES.has(next.text)))
  ) {
    cursor.index++
  }
}

function takeJoinPrefix(cursor: TokenCursor): boolean {
  if (cursor.take('JOIN')) return true
  if (cursor.take('INNER') || cursor.take('CROSS')) {
    cursor.require('JOIN')
    return true
  }
  if (cursor.take('LEFT') || cursor.take('RIGHT')) {
    cursor.take('OUTER')
    cursor.require('JOIN')
    return true
  }
  return false
}

function parseSelectList(cursor: TokenCursor, aliases: boolean, ordering: boolean): void {
  do {
    cursor.parseExpression()
    if (aliases) parseOptionalAlias(cursor)
    if (ordering && !cursor.take('ASC')) cursor.take('DESC')
  } while (cursor.take(','))
}

function parseFromClause(
  cursor: TokenCursor,
  defaultDatabase: string | null,
  allowJoins: boolean,
  systemSchemaHint?: string,
): DatabaseStatementTarget[] {
  const targets: DatabaseStatementTarget[] = []
  if (!cursor.take('FROM')) return targets
  const primary = readQualifiedTable(cursor, defaultDatabase, systemSchemaHint)
  targets.push({ ...primary, operation: 'select' })
  parseOptionalAlias(cursor)
  while (takeJoinPrefix(cursor)) {
    if (!allowJoins) cursor.fail('手动单表查询编辑器暂不支持 JOIN')
    const joined = readQualifiedTable(cursor, defaultDatabase, systemSchemaHint)
    targets.push({ ...joined, operation: 'select' })
    parseOptionalAlias(cursor)
    if (cursor.take('ON')) {
      cursor.parseExpression()
    } else if (cursor.take('USING')) {
      cursor.require('(')
      cursor.readIdentifier()
      while (cursor.take(',')) cursor.readIdentifier()
      cursor.require(')')
    } else {
      cursor.fail('JOIN 必须带有 ON 或 USING 条件')
    }
  }
  return targets
}

/**
 * 从游标当前位置解析一条完整 SELECT 语句并提取引用到的目标表。
 * 供 `database_query` 与写工具中的 `INSERT ... SELECT` / `CREATE VIEW ... AS SELECT` 共用。
 */
export function parseSelectFromCursor(
  cursor: TokenCursor,
  defaultDatabase: string | null,
  options: {
    allowJoins: boolean
    requireTable: boolean
    missingTableHint?: string
    systemSchemaHint?: string
  },
): DatabaseStatementTarget[] {
  cursor.require('SELECT')
  cursor.take('DISTINCT')
  parseSelectList(cursor, true, false)
  const targets = parseFromClause(
    cursor,
    defaultDatabase,
    options.allowJoins,
    options.systemSchemaHint,
  )
  if (options.requireTable && targets.length === 0)
    cursor.fail(options.missingTableHint ?? '模型查询必须明确指定 FROM 目标表')
  if (cursor.take('WHERE')) cursor.parseExpression()
  if (cursor.take('GROUP')) {
    cursor.require('BY')
    parseSelectList(cursor, false, false)
  }
  if (cursor.take('HAVING')) cursor.parseExpression()
  if (cursor.take('ORDER')) {
    cursor.require('BY')
    parseSelectList(cursor, false, true)
  }
  if (cursor.take('LIMIT')) {
    cursor.readInteger()
    if (cursor.take(',') || cursor.take('OFFSET')) cursor.readInteger()
  }
  return targets
}

/** 手动工作区单表只读 SELECT 准入校验。 */
export function admitReadQuery(sql: string, engine: DatabaseEngine = 'mysql'): string {
  if (typeof sql !== 'string' || !sql.trim() || Buffer.byteLength(sql) > 65536)
    throw new Error('请输入不超过 64 KiB 的 SELECT')
  const statements = splitSqlStatements(sql, 20, engine)
  if (statements.length !== 1) throw new Error('SQL 不在当前只读子集内；只允许执行单条 SELECT 查询')
  const statement = statements[0]!
  const cursor = new TokenCursor(
    statement.tokens,
    'SQL 不在当前只读子集内；支持单表 SELECT、WHERE、GROUP BY、HAVING、ORDER BY 和 LIMIT',
    engine,
  )
  // 手动工作区未强制传入默认库时由已选 schema 或默认库承担；这里保留无库名前缀单表读取。
  parseSelectFromCursor(cursor, '__manual__', { allowJoins: false, requireTable: false })
  if (cursor.index !== statement.tokens.length) cursor.fail()
  return statement.raw
}

/** 模型只读查询批量准入校验：支持单条或分号分隔的多条 SELECT，并抽取每张引用表。 */
export function admitReadQueries(
  input: string | readonly string[],
  defaultDatabase: string | null,
  engine: DatabaseEngine = 'mysql',
): AdmittedReadQuery[] {
  const rawList = typeof input === 'string' ? [input] : input
  if (!Array.isArray(rawList) || rawList.length === 0)
    throw new Error('请提供至少一条 SELECT 查询语句')
  const slices = rawList.flatMap(item => splitSqlStatements(item, 20, engine))
  if (slices.length > 20) throw new Error('单次查询最多包含 20 条 SELECT 语句')
  return slices.map(slice => {
    const cursor = new TokenCursor(
      slice.tokens,
      '查询 SQL 不在只读支持范围内（支持单条或多条 SELECT、JOIN、WHERE、GROUP BY、HAVING、ORDER BY、LIMIT，暂不支持子查询与 UNION）',
      engine,
    )
    const targets = parseSelectFromCursor(cursor, defaultDatabase, {
      allowJoins: true,
      requireTable: true,
      missingTableHint: `模型查询必须明确指定 FROM 业务表；${DATABASE_SCHEMA_READ_HINT}`,
      systemSchemaHint: DATABASE_SCHEMA_READ_HINT,
    })
    if (cursor.index !== slice.tokens.length) cursor.fail()
    return { sql: slice.raw, targets }
  })
}
