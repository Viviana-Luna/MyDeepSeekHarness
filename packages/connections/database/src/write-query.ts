/** 模型数据变更与 DDL 结构变更准入解析：按引擎拆解批量 SQL，提取库表目标与风险提示。 */
import type {
  DatabaseEngine,
  DatabaseMutationOperation,
  DatabaseStatementTarget,
} from '../types.d.ts'
import { isSystemSchema, isSystemTable } from './dialect.ts'
import { parseSelectFromCursor, readQualifiedTable, TokenCursor } from './read-query.ts'
import {
  splitSqlStatements,
  unquoteIdentifier,
  type SqlStatementSlice,
  type SqlToken,
} from './sql-tokens.ts'

/** 经过准入校验的单条写或 DDL 语句描述。 */
export interface AdmittedMutationStatement {
  readonly sql: string
  readonly operation: DatabaseMutationOperation
  readonly schema: string
  readonly table: string
  readonly targets: readonly DatabaseStatementTarget[]
  readonly summary: string
  readonly risks: readonly string[]
}

const DDL_FORBIDDEN_WORDS = new Set([
  'OUTFILE',
  'DUMPFILE',
  'USER',
  'ROLE',
  'GRANT',
  'REVOKE',
  'PLUGIN',
  'PROCEDURE',
  'FUNCTION',
  'TRIGGER',
  'EVENT',
  'SERVER',
  'LOGFILE',
  'LOAD',
  'HANDLER',
  'PREPARE',
  'EXECUTE',
  'CALL',
  'FLUSH',
  'RESET',
  'PURGE',
  'KILL',
  'SHUTDOWN',
  'INSTALL',
  'UNINSTALL',
  'EXTENSION',
  'POLICY',
  'SYSTEM',
  'PUBLICATION',
  'SUBSCRIPTION',
  'LANGUAGE',
  'SECURITY',
  'ATTACH',
  'DETACH',
  'PRAGMA',
  'VACUUM',
  'REINDEX',
  'COPY',
  'LISTEN',
  'NOTIFY',
])

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

function ddlRollbackRisks(engine: DatabaseEngine): string[] {
  if (engine === 'postgresql')
    return ['DDL 结构变更在 PostgreSQL 事务中执行（失败自动回滚），但结构修改仍具有破坏性']
  if (engine === 'sqlite')
    return ['DDL 结构变更在 SQLite 事务中执行（失败自动回滚），但结构修改仍具有破坏性']
  if (engine === 'mariadb') return ['DDL 结构变更在 MariaDB 中会隐式提交，无法回滚']
  return ['DDL 结构变更在 MySQL 中会隐式提交，无法回滚']
}

function assertSafeDdlTokens(tokens: readonly SqlToken[], engine: DatabaseEngine): void {
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    const next = tokens[index + 1]
    if (token.kind === 'word' && DDL_FORBIDDEN_WORDS.has(token.text))
      throw new Error(`DDL 不支持权限、服务器管理、扩展或外部文件关键字：${token.raw}`)
    if (token.kind === 'quoted' || token.kind === 'word') {
      const name = token.kind === 'quoted' ? unquoteIdentifier(token) : token.raw
      if (FORBIDDEN_FUNCTIONS.has(name.toUpperCase()) && next?.text === '(')
        throw new Error(`不允许调用受限服务端函数：${token.raw}`)
      if (isSystemTable(name, engine)) throw new Error(`不允许修改系统保留表：${name}`)
    }
    if (
      token.kind === 'word' &&
      next?.kind === 'word' &&
      DDL_FORBIDDEN_PAIRS.some(([a, b]) => a === token.text && b === next.text)
    ) {
      throw new Error(`DDL 不支持磁盘路径、外部表或表空间导入导出选项：${token.raw} ${next.raw}`)
    }
  }
}

function consumeBalancedParens(cursor: TokenCursor): void {
  cursor.require('(')
  let depth = 1
  while (cursor.index < cursor.tokens.length && depth > 0) {
    if (cursor.take('(')) depth++
    else if (cursor.take(')')) depth--
    else cursor.index++
  }
  if (depth !== 0) cursor.fail('DDL 括号未闭合')
}

function alterTableTargets(
  tokens: readonly SqlToken[],
  defaultDatabase: string | null,
): { schema: string; table: string }[] {
  const targets: { schema: string; table: string }[] = []
  let depth = 0
  let atActionStart = true
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (atActionStart && token.text === 'RENAME') {
      const next = tokens[index + 1]?.text
      if (['COLUMN', 'INDEX', 'KEY', 'PARTITION'].includes(next ?? '')) continue
      let targetIndex = index + 1
      if (['TO', 'AS'].includes(tokens[targetIndex]?.text ?? '')) targetIndex++
      const cursor = new TokenCursor(tokens.slice(targetIndex), 'ALTER TABLE 的表重命名目标无效')
      targets.push(readQualifiedTable(cursor, defaultDatabase))
      atActionStart = false
      continue
    }
    if (atActionStart && token.text === 'EXCHANGE') {
      let withIndex = index + 1
      while (withIndex < tokens.length && tokens[withIndex]?.text !== 'WITH') withIndex++
      if (tokens[withIndex + 1]?.text === 'TABLE') {
        const cursor = new TokenCursor(
          tokens.slice(withIndex + 2),
          'ALTER TABLE EXCHANGE PARTITION 的目标表无效',
        )
        targets.push(readQualifiedTable(cursor, defaultDatabase))
      }
    }
    if (token.text === '(') depth++
    else if (token.text === ')') depth = Math.max(0, depth - 1)
    if (token.text === ',' && depth === 0) atActionStart = true
    else if (atActionStart) atActionStart = false
  }
  return targets
}

function parseAssignmentList(cursor: TokenCursor): void {
  do {
    cursor.readQualifiedColumn()
    cursor.require('=')
    cursor.parseExpression()
  } while (cursor.take(','))
}

function parseReturningClause(cursor: TokenCursor): void {
  if ((cursor.engine !== 'postgresql' && cursor.engine !== 'sqlite') || !cursor.take('RETURNING'))
    return
  do {
    cursor.parseExpression()
    if (cursor.take('AS')) cursor.readIdentifier()
  } while (cursor.take(','))
}

function parseInsert(
  cursor: TokenCursor,
  raw: string,
  defaultDatabase: string | null,
): AdmittedMutationStatement {
  cursor.require('INSERT')
  if (cursor.engine === 'sqlite' && cursor.take('OR')) {
    const action = cursor.peek()
    if (!['ABORT', 'FAIL', 'IGNORE', 'REPLACE', 'ROLLBACK'].includes(action ?? ''))
      cursor.fail('INSERT OR 冲突策略无效')
    cursor.index++
  } else {
    cursor.take('IGNORE')
  }
  cursor.take('INTO')
  const target = readQualifiedTable(cursor, defaultDatabase)
  const targets: DatabaseStatementTarget[] = [{ ...target, operation: 'insert' }]
  if ((cursor.engine === 'mysql' || cursor.engine === 'mariadb') && cursor.take('SET')) {
    parseAssignmentList(cursor)
    if (cursor.index !== cursor.tokens.length) cursor.fail('INSERT SET 包含不支持的后续子句')
    return {
      sql: raw,
      operation: 'insert',
      ...target,
      targets,
      summary: `INSERT ${target.schema}.${target.table}`,
      risks: [],
    }
  }
  if (cursor.take('(')) {
    cursor.readIdentifier()
    while (cursor.take(',')) cursor.readIdentifier()
    cursor.require(')')
  }
  if (cursor.take('VALUES') || cursor.take('VALUE')) {
    do {
      cursor.require('(')
      cursor.parseExpression()
      while (cursor.take(',')) cursor.parseExpression()
      cursor.require(')')
    } while (cursor.take(','))
  } else if (cursor.peek() === 'SELECT') {
    targets.push(
      ...parseSelectFromCursor(cursor, defaultDatabase, { allowJoins: true, requireTable: true }),
    )
  } else {
    cursor.fail('INSERT 仅支持 VALUES、SET 或 SELECT 写入')
  }
  if (cursor.take('ON')) {
    if ((cursor.engine === 'postgresql' || cursor.engine === 'sqlite') && cursor.take('CONFLICT')) {
      if (cursor.take('(')) {
        cursor.readIdentifier()
        while (cursor.take(',')) cursor.readIdentifier()
        cursor.require(')')
      }
      cursor.require('DO')
      if (!cursor.take('NOTHING')) {
        cursor.require('UPDATE')
        cursor.require('SET')
        parseAssignmentList(cursor)
        if (cursor.take('WHERE')) cursor.parseExpression()
      }
    } else {
      cursor.require('DUPLICATE')
      cursor.require('KEY')
      cursor.require('UPDATE')
      parseAssignmentList(cursor)
    }
  }
  parseReturningClause(cursor)
  if (cursor.index !== cursor.tokens.length) cursor.fail('INSERT 语句存在未识别的结尾内容')
  return {
    sql: raw,
    operation: 'insert',
    ...target,
    targets,
    summary: `INSERT ${target.schema}.${target.table}`,
    risks: [],
  }
}

function parseUpdate(
  cursor: TokenCursor,
  raw: string,
  defaultDatabase: string | null,
): AdmittedMutationStatement {
  cursor.require('UPDATE')
  cursor.take('IGNORE')
  const target = readQualifiedTable(cursor, defaultDatabase)
  if (cursor.take('AS')) cursor.readIdentifier()
  else if (cursor.peek() !== 'SET') cursor.readIdentifier()
  cursor.require('SET')
  parseAssignmentList(cursor)
  const hasWhere = cursor.take('WHERE')
  if (hasWhere) cursor.parseExpression()
  if (cursor.take('ORDER')) {
    cursor.require('BY')
    do {
      cursor.parseExpression()
      if (!cursor.take('ASC')) cursor.take('DESC')
    } while (cursor.take(','))
  }
  if (cursor.take('LIMIT')) cursor.readInteger()
  parseReturningClause(cursor)
  if (cursor.index !== cursor.tokens.length) cursor.fail('UPDATE 仅支持单表更新')
  return {
    sql: raw,
    operation: 'update',
    ...target,
    targets: [{ ...target, operation: 'update' }],
    summary: `UPDATE ${target.schema}.${target.table}`,
    risks: hasWhere ? [] : ['无 WHERE 条件（将更新整张表）'],
  }
}

function parseDelete(
  cursor: TokenCursor,
  raw: string,
  defaultDatabase: string | null,
): AdmittedMutationStatement {
  cursor.require('DELETE')
  cursor.require('FROM')
  const target = readQualifiedTable(cursor, defaultDatabase)
  if (cursor.take('AS')) cursor.readIdentifier()
  else if (
    cursor.peek() !== undefined &&
    !['WHERE', 'ORDER', 'LIMIT', 'RETURNING'].includes(cursor.peek()!)
  ) {
    cursor.readIdentifier()
  }
  const hasWhere = cursor.take('WHERE')
  if (hasWhere) cursor.parseExpression()
  if (cursor.take('ORDER')) {
    cursor.require('BY')
    do {
      cursor.parseExpression()
      if (!cursor.take('ASC')) cursor.take('DESC')
    } while (cursor.take(','))
  }
  if (cursor.take('LIMIT')) cursor.readInteger()
  parseReturningClause(cursor)
  if (cursor.index !== cursor.tokens.length) cursor.fail('DELETE 仅支持单表删除')
  return {
    sql: raw,
    operation: 'delete',
    ...target,
    targets: [{ ...target, operation: 'delete' }],
    summary: `DELETE ${target.schema}.${target.table}`,
    risks: hasWhere ? [] : ['无 WHERE 条件（将删除整张表所有数据）'],
  }
}

function parseCreateDdl(
  cursor: TokenCursor,
  raw: string,
  defaultDatabase: string | null,
): AdmittedMutationStatement {
  cursor.require('CREATE')
  const risks = ddlRollbackRisks(cursor.engine)
  const isDatabase = cursor.take('DATABASE')
  const isSchema = !isDatabase && cursor.take('SCHEMA')
  if (isDatabase || isSchema) {
    if (cursor.engine === 'sqlite')
      cursor.fail('SQLite 本地数据库不支持 CREATE DATABASE 或 CREATE SCHEMA')
    if (cursor.engine === 'postgresql' && isDatabase)
      cursor.fail('PostgreSQL 单连接仅绑定一个数据库，请使用 CREATE SCHEMA 管理命名空间')
    if (cursor.take('IF')) {
      cursor.require('NOT')
      cursor.require('EXISTS')
    }
    const schema = cursor.readIdentifier()
    if (isSystemSchema(schema, cursor.engine)) throw new Error(`不允许创建或修改系统库 ${schema}`)
    return {
      sql: raw,
      operation: 'ddl',
      schema,
      table: '*',
      targets: [{ schema, table: '*', operation: 'ddl' }],
      summary: `${isSchema ? 'CREATE SCHEMA' : 'CREATE DATABASE'} ${schema}`,
      risks,
    }
  }
  if (cursor.take('OR')) {
    cursor.require('REPLACE')
    cursor.require('VIEW')
    const view = readQualifiedTable(cursor, defaultDatabase)
    cursor.require('AS')
    const sourceTargets = parseSelectFromCursor(cursor, defaultDatabase, {
      allowJoins: true,
      requireTable: true,
    })
    if (cursor.index !== cursor.tokens.length) cursor.fail('CREATE VIEW 仅支持标准 SELECT 定义')
    return {
      sql: raw,
      operation: 'ddl',
      ...view,
      targets: [{ ...view, operation: 'ddl' }, ...sourceTargets],
      summary: `CREATE VIEW ${view.schema}.${view.table}`,
      risks,
    }
  }
  if (cursor.take('VIEW')) {
    if (cursor.take('IF')) {
      cursor.require('NOT')
      cursor.require('EXISTS')
    }
    const view = readQualifiedTable(cursor, defaultDatabase)
    cursor.require('AS')
    const sourceTargets = parseSelectFromCursor(cursor, defaultDatabase, {
      allowJoins: true,
      requireTable: true,
    })
    if (cursor.index !== cursor.tokens.length) cursor.fail('CREATE VIEW 仅支持标准 SELECT 定义')
    return {
      sql: raw,
      operation: 'ddl',
      ...view,
      targets: [{ ...view, operation: 'ddl' }, ...sourceTargets],
      summary: `CREATE VIEW ${view.schema}.${view.table}`,
      risks,
    }
  }
  if (cursor.take('UNIQUE') || cursor.take('FULLTEXT') || cursor.take('SPATIAL')) {
    cursor.require('INDEX')
    if (cursor.engine !== 'mysql' && cursor.take('IF')) {
      cursor.require('NOT')
      cursor.require('EXISTS')
    }
    cursor.readIdentifier()
    cursor.require('ON')
    const target = readQualifiedTable(cursor, defaultDatabase)
    if (cursor.engine === 'postgresql' && cursor.take('USING')) cursor.readIdentifier()
    consumeBalancedParens(cursor)
    return {
      sql: raw,
      operation: 'ddl',
      ...target,
      targets: [{ ...target, operation: 'ddl' }],
      summary: `CREATE INDEX ON ${target.schema}.${target.table}`,
      risks,
    }
  }
  if (cursor.take('INDEX')) {
    if (cursor.engine !== 'mysql' && cursor.take('IF')) {
      cursor.require('NOT')
      cursor.require('EXISTS')
    }
    cursor.readIdentifier()
    cursor.require('ON')
    const target = readQualifiedTable(cursor, defaultDatabase)
    if (cursor.engine === 'postgresql' && cursor.take('USING')) cursor.readIdentifier()
    consumeBalancedParens(cursor)
    return {
      sql: raw,
      operation: 'ddl',
      ...target,
      targets: [{ ...target, operation: 'ddl' }],
      summary: `CREATE INDEX ON ${target.schema}.${target.table}`,
      risks,
    }
  }
  cursor.take('TEMPORARY')
  cursor.require('TABLE')
  if (cursor.take('IF')) {
    cursor.require('NOT')
    cursor.require('EXISTS')
  }
  const target = readQualifiedTable(cursor, defaultDatabase)
  const targets: DatabaseStatementTarget[] = [{ ...target, operation: 'ddl' }]
  if (cursor.take('LIKE')) {
    const source = readQualifiedTable(cursor, defaultDatabase)
    targets.push({ ...source, operation: 'select' })
  } else if (cursor.peek() === '(') {
    consumeBalancedParens(cursor)
    if (cursor.peek() === 'AS' || cursor.peek() === 'SELECT')
      cursor.fail('请使用 CREATE TABLE (...) 建表后再执行 INSERT INTO ... SELECT')
  } else {
    cursor.fail('CREATE TABLE 必须提供列定义或 LIKE 源表')
  }
  return {
    sql: raw,
    operation: 'ddl',
    ...target,
    targets,
    summary: `CREATE TABLE ${target.schema}.${target.table}`,
    risks,
  }
}

function parseAlterOrRenameOrTruncate(
  cursor: TokenCursor,
  raw: string,
  defaultDatabase: string | null,
): AdmittedMutationStatement {
  const risks = ddlRollbackRisks(cursor.engine)
  if (cursor.take('ALTER')) {
    const isDatabase = cursor.take('DATABASE')
    const isSchema = !isDatabase && cursor.take('SCHEMA')
    if (isDatabase || isSchema) {
      if (cursor.engine === 'sqlite')
        cursor.fail('SQLite 本地数据库不支持 ALTER DATABASE 或 ALTER SCHEMA')
      if (cursor.engine === 'postgresql' && isDatabase)
        cursor.fail('PostgreSQL 单连接仅绑定一个数据库，请使用 ALTER SCHEMA 管理命名空间')
      const schema = cursor.readIdentifier()
      if (isSystemSchema(schema, cursor.engine)) throw new Error(`不允许修改系统库 ${schema}`)
      return {
        sql: raw,
        operation: 'ddl',
        schema,
        table: '*',
        targets: [{ schema, table: '*', operation: 'ddl' }],
        summary: `${isSchema ? 'ALTER SCHEMA' : 'ALTER DATABASE'} ${schema}`,
        risks,
      }
    }
    cursor.require('TABLE')
    const target = readQualifiedTable(cursor, defaultDatabase)
    if (cursor.index >= cursor.tokens.length) cursor.fail('ALTER TABLE 缺少变更内容')
    const targets: DatabaseStatementTarget[] = [{ ...target, operation: 'ddl' }]
    for (const extra of alterTableTargets(cursor.tokens.slice(cursor.index), defaultDatabase))
      targets.push({ ...extra, operation: 'ddl' })
    return {
      sql: raw,
      operation: 'ddl',
      ...target,
      targets,
      summary: `ALTER TABLE ${target.schema}.${target.table}`,
      risks,
    }
  }
  if (cursor.take('TRUNCATE')) {
    if (cursor.engine === 'sqlite')
      cursor.fail('SQLite 不支持 TRUNCATE，请改用 DELETE FROM 语句清空表数据')
    cursor.take('TABLE')
    const target = readQualifiedTable(cursor, defaultDatabase)
    if (cursor.engine === 'postgresql') {
      if (!cursor.take('CASCADE')) cursor.take('RESTRICT')
    }
    if (cursor.index !== cursor.tokens.length) cursor.fail()
    return {
      sql: raw,
      operation: 'ddl',
      ...target,
      targets: [{ ...target, operation: 'ddl' }],
      summary: `TRUNCATE ${target.schema}.${target.table}`,
      risks: ['不可逆清空整张表数据', ...risks],
    }
  }
  cursor.require('RENAME')
  if (cursor.engine === 'postgresql' || cursor.engine === 'sqlite')
    cursor.fail('当前数据库引擎请使用 ALTER TABLE ... RENAME TO 重命名表')
  cursor.require('TABLE')
  const targets: DatabaseStatementTarget[] = []
  let firstTarget: { schema: string; table: string } | undefined
  do {
    const source = readQualifiedTable(cursor, defaultDatabase)
    cursor.require('TO')
    const destination = readQualifiedTable(cursor, defaultDatabase)
    firstTarget ??= source
    targets.push({ ...source, operation: 'ddl' }, { ...destination, operation: 'ddl' })
  } while (cursor.take(','))
  if (cursor.index !== cursor.tokens.length) cursor.fail()
  return {
    sql: raw,
    operation: 'ddl',
    ...firstTarget!,
    targets,
    summary: `RENAME TABLE ${firstTarget!.schema}.${firstTarget!.table}`,
    risks,
  }
}

function parseDropDdl(
  cursor: TokenCursor,
  raw: string,
  defaultDatabase: string | null,
): AdmittedMutationStatement {
  cursor.require('DROP')
  const risks = ddlRollbackRisks(cursor.engine)
  const isDatabase = cursor.take('DATABASE')
  const isSchema = !isDatabase && cursor.take('SCHEMA')
  if (isDatabase || isSchema) {
    if (cursor.engine === 'sqlite')
      cursor.fail('SQLite 本地数据库不支持 DROP DATABASE 或 DROP SCHEMA')
    if (cursor.engine === 'postgresql' && isDatabase)
      cursor.fail('PostgreSQL 单连接仅绑定一个数据库，请勿删除整个数据库实例；可使用 DROP SCHEMA')
    if (cursor.take('IF')) cursor.require('EXISTS')
    const schema = cursor.readIdentifier()
    if (cursor.engine === 'postgresql') {
      if (!cursor.take('CASCADE')) cursor.take('RESTRICT')
    }
    if (isSystemSchema(schema, cursor.engine) || cursor.index !== cursor.tokens.length)
      cursor.fail('不允许删除系统库或包含多余参数')
    return {
      sql: raw,
      operation: 'ddl',
      schema,
      table: '*',
      targets: [{ schema, table: '*', operation: 'ddl' }],
      summary: `${isSchema ? 'DROP SCHEMA' : 'DROP DATABASE'} ${schema}`,
      risks: ['不可逆删除整个数据库或命名空间及其全部数据', ...risks],
    }
  }
  if (cursor.take('INDEX')) {
    if (cursor.engine === 'postgresql' || cursor.engine === 'sqlite') {
      if (cursor.take('IF')) cursor.require('EXISTS')
      const idx = readQualifiedTable(cursor, defaultDatabase)
      if (cursor.engine === 'postgresql' && !cursor.take('CASCADE')) cursor.take('RESTRICT')
      if (cursor.index !== cursor.tokens.length) cursor.fail('DROP INDEX 包含多余参数')
      return {
        sql: raw,
        operation: 'ddl',
        schema: idx.schema,
        table: '*',
        targets: [{ schema: idx.schema, table: '*', operation: 'ddl' }],
        summary: `DROP INDEX ${idx.schema}.${idx.table}`,
        risks,
      }
    }
    cursor.readIdentifier()
    cursor.require('ON')
    const target = readQualifiedTable(cursor, defaultDatabase)
    return {
      sql: raw,
      operation: 'ddl',
      ...target,
      targets: [{ ...target, operation: 'ddl' }],
      summary: `DROP INDEX ON ${target.schema}.${target.table}`,
      risks,
    }
  }
  const temporary = cursor.take('TEMPORARY')
  const isView = !temporary && cursor.take('VIEW')
  if (!isView) cursor.require('TABLE')
  if (cursor.take('IF')) cursor.require('EXISTS')
  const tables: { schema: string; table: string }[] = []
  do {
    tables.push(readQualifiedTable(cursor, defaultDatabase))
  } while (cursor.take(','))
  if (cursor.engine === 'postgresql' && !cursor.take('CASCADE')) cursor.take('RESTRICT')
  if (cursor.index !== cursor.tokens.length) cursor.fail()
  const primary = tables[0]!
  return {
    sql: raw,
    operation: 'ddl',
    ...primary,
    targets: tables.map(item => ({ ...item, operation: 'ddl' })),
    summary: `${isView ? 'DROP VIEW' : 'DROP TABLE'} ${tables.map(item => `${item.schema}.${item.table}`).join(', ')}`,
    risks: [isView ? '删除视图定义' : '不可逆删除表结构及全部数据', ...risks],
  }
}

function parseSingleMutation(
  slice: SqlStatementSlice,
  defaultDatabase: string | null,
  engine: DatabaseEngine,
): AdmittedMutationStatement {
  const cursor = new TokenCursor(
    slice.tokens,
    '仅支持单条或多条 INSERT、UPDATE、DELETE 与表/库/索引/视图 DDL',
    engine,
  )
  const head = cursor.peek()
  if (head === 'INSERT') return parseInsert(cursor, slice.raw, defaultDatabase)
  if (head === 'UPDATE') return parseUpdate(cursor, slice.raw, defaultDatabase)
  if (head === 'DELETE') return parseDelete(cursor, slice.raw, defaultDatabase)
  if (['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME'].includes(head ?? '')) {
    assertSafeDdlTokens(slice.tokens, engine)
    if (head === 'CREATE') return parseCreateDdl(cursor, slice.raw, defaultDatabase)
    if (head === 'DROP') return parseDropDdl(cursor, slice.raw, defaultDatabase)
    return parseAlterOrRenameOrTruncate(cursor, slice.raw, defaultDatabase)
  }
  throw new Error(
    `不支持的变更语句类型 ${head ?? ''}，仅支持 INSERT、UPDATE、DELETE 与表/库/索引/视图 DDL`,
  )
}

/**
 * 解析并校验批量变更与 DDL 语句；支持传入分号分隔 `sql` 或显式 `statements` 列表。
 * @throws 语句为空、超出 50 条上限、语法不在受支持范围内或引用系统库时抛出。
 */
export function admitMutateStatements(
  input: { sql?: string; statements?: readonly string[] },
  defaultDatabase: string | null,
  engine: DatabaseEngine = 'mysql',
): AdmittedMutationStatement[] {
  const rawInputs: string[] = []
  if (typeof input.sql === 'string' && input.sql.trim()) rawInputs.push(input.sql)
  if (Array.isArray(input.statements)) {
    for (const item of input.statements) {
      if (typeof item !== 'string') throw new Error('statements 列表中每一项必须是 SQL 字符串')
      if (item.trim()) rawInputs.push(item)
    }
  }
  if (rawInputs.length === 0) throw new Error('请通过 sql 或 statements 提供至少一条变更语句')
  const slices = rawInputs.flatMap(item => splitSqlStatements(item, 50, engine))
  if (slices.length > 50) throw new Error('单次批量最多支持 50 条变更语句')
  return slices.map(slice => parseSingleMutation(slice, defaultDatabase, engine))
}
