/** 数据库多引擎传输分发层：保持既有公开接口稳定，按连接引擎路由至 MySQL/MariaDB、PostgreSQL 或 SQLite 驱动。 */
import type { DatabaseBatchMutationResult, DatabaseProfile, DatabaseResult } from '../types.d.ts'
import {
  executeMysqlDatabaseBatch,
  openMysqlDatabase,
  readMysqlDatabase,
  readMysqlDatabaseBatch,
  type DatabaseConnection,
} from './drivers/mysql-driver.ts'
import {
  executePostgresDatabaseBatch,
  readPostgresDatabase,
  readPostgresDatabaseBatch,
} from './drivers/postgres-driver.ts'
import {
  DATABASE_LIMITS,
  directSocket,
  type DatabaseBatchMutationExecutionItem,
  type DatabaseReadTransportOptions,
  type DatabaseSocket,
  type OpenSocket,
} from './drivers/shared.ts'
import {
  executeSqliteDatabaseBatch,
  readSqliteDatabase,
  readSqliteDatabaseBatch,
} from './drivers/sqlite-driver.ts'

export {
  DATABASE_LIMITS,
  directSocket,
  openMysqlDatabase as openDatabase,
  type DatabaseBatchMutationExecutionItem,
  type DatabaseConnection,
  type DatabaseReadTransportOptions,
  type DatabaseSocket,
  type OpenSocket,
}

/** 按连接引擎执行单条有界只读查询。 */
export async function readDatabase(
  profile: DatabaseProfile,
  password: string,
  socket: OpenSocket,
  sql: string,
  values: unknown[],
  limit: number,
  signal: AbortSignal,
  options?: DatabaseReadTransportOptions,
): Promise<DatabaseResult> {
  if (profile.engine === 'sqlite') {
    return readSqliteDatabase({ profile, sql, values, limit, signal })
  }
  if (profile.engine === 'postgresql') {
    return readPostgresDatabase({
      profile,
      password,
      socket,
      sql,
      values,
      limit,
      signal,
      ...(options ? { options } : {}),
    })
  }
  return readMysqlDatabase({ profile, password, socket, sql, values, limit, signal })
}

/** 按连接引擎执行批量只读查询并共享整体结果字节预算。 */
export async function readDatabaseBatch(
  profile: DatabaseProfile,
  password: string,
  socket: OpenSocket,
  queries: readonly string[],
  limitPerQuery: number,
  signal: AbortSignal,
  options?: DatabaseReadTransportOptions,
): Promise<DatabaseResult[]> {
  if (profile.engine === 'sqlite') {
    return readSqliteDatabaseBatch({ profile, queries, limitPerQuery, signal })
  }
  if (profile.engine === 'postgresql') {
    return readPostgresDatabaseBatch({
      profile,
      password,
      socket,
      queries,
      limitPerQuery,
      signal,
      ...(options ? { options } : {}),
    })
  }
  return readMysqlDatabaseBatch({ profile, password, socket, queries, limitPerQuery, signal })
}

/** 按连接引擎顺序执行批量 DML 与 DDL 变更语句。 */
export async function executeDatabaseBatch(
  profile: DatabaseProfile,
  password: string,
  socket: OpenSocket,
  statements: readonly DatabaseBatchMutationExecutionItem[],
  signal: AbortSignal,
  options?: DatabaseReadTransportOptions,
): Promise<DatabaseBatchMutationResult> {
  if (profile.engine === 'sqlite') {
    return executeSqliteDatabaseBatch({ profile, statements, signal })
  }
  if (profile.engine === 'postgresql') {
    return executePostgresDatabaseBatch({
      profile,
      password,
      socket,
      statements,
      signal,
      ...(options ? { options } : {}),
    })
  }
  return executeMysqlDatabaseBatch({ profile, password, socket, statements, signal })
}
