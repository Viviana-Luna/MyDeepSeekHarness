/** PostgreSQL 纯 JS 驱动 `pg` 在 `@mydsh/database` 内使用的最小类型声明。 */
declare module 'pg' {
  import type { EventEmitter } from 'node:events'
  import type { Duplex } from 'node:stream'
  import type { ConnectionOptions } from 'node:tls'

  export interface FieldDef {
    name: string
    dataTypeID: number
    format?: string
  }

  export interface TypeOverridesLike {
    getTypeParser(oid: number, format?: string): (value: unknown) => unknown
  }

  export interface ClientConfig {
    host?: string
    port?: number
    user?: string
    password?: string
    database?: string
    stream?: Duplex
    ssl?: boolean | ConnectionOptions
    connectionTimeoutMillis?: number
    types?: TypeOverridesLike
  }

  export interface QueryArrayConfig {
    text: string
    values?: unknown[]
    rowMode?: 'array'
    types?: TypeOverridesLike
  }

  export interface QueryArrayResult {
    command: string
    rowCount: number | null
    rows: unknown[][]
    fields: FieldDef[]
  }

  export class Query extends EventEmitter {
    readonly callback?: ((error?: Error, result?: QueryArrayResult) => void) | null
    constructor(config: QueryArrayConfig | string, values?: unknown[])
  }

  export class Client extends EventEmitter {
    readonly processID: number | null
    readonly secretKey: number | null
    constructor(config?: ClientConfig)
    connect(): Promise<void>
    end(): Promise<void>
    query(query: Query): Query
    query(config: QueryArrayConfig | string, values?: unknown[]): Promise<QueryArrayResult>
  }

  const pgNamespace: {
    Client: typeof Client
    Query: typeof Query
  }
  export default pgNamespace
}
