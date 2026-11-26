/** 数据库多引擎传输共享基础设施：限额常量、TCP 直连、8 MiB 入站流限流与单元编码。 */
import { connect as connectSocket } from 'node:net'
import { Duplex, Transform } from 'node:stream'
import type { DatabaseMutationOperation } from '../../types.d.ts'

/** 数据库传输与结果体积硬上限配置。 */
export const DATABASE_LIMITS = {
  rows: 500,
  previewRows: 200,
  resultBytes: 2 * 1024 * 1024,
  cellBytes: 256 * 1024,
  wireBytes: 8 * 1024 * 1024,
  timeoutMs: 20_000,
  cancelMs: 5_000,
} as const

/** 底层可读写的 TCP 或 SSH 隧道流包装。 */
export interface DatabaseSocket {
  stream: Duplex
  close(): Promise<void>
}

/** 按需创建并受取消信号控制的底层流工厂。 */
export type OpenSocket = (signal: AbortSignal) => Promise<DatabaseSocket>

/** 批量变更执行清单中的单条已准入语句描述。 */
export interface DatabaseBatchMutationExecutionItem {
  readonly sql: string
  readonly operation: DatabaseMutationOperation
  readonly schema: string
  readonly table: string
}

/** 单次读查询传输可选控制项（如 PostgreSQL 会话级 search_path）。 */
export interface DatabaseReadTransportOptions {
  readonly searchSchema?: string | null
}

/** 建立直连数据库的 TCP 流并在关闭时销毁底层套接字。 */
export async function directSocket(host: string, port: number): Promise<DatabaseSocket> {
  const stream = connectSocket({ host, port })
  return {
    stream,
    close: async () => {
      if (stream.closed) return
      await new Promise<void>(resolve => {
        stream.once('close', () => resolve())
        stream.destroy()
      })
    },
  }
}

/** 将底层底层值统一编码为表格单元格文本或 0x 十六进制串，NULL 保持 null。 */
export function encodeCell(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (Buffer.isBuffer(value)) return `0x${value.toString('hex')}`
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`
  return String(value)
}

/** 在 TLS 解密与协议解码之前包装入站流，超过 8 MiB 网络上限时立即中断并清理底层句柄。 */
export function wrapLimitedWireStream(owned: DatabaseSocket): {
  stream: Duplex
  destroyAll(): Promise<void>
} {
  let received = 0
  const incoming = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length
      callback(
        received > DATABASE_LIMITS.wireBytes ? new Error('数据库响应超过 8 MiB 网络上限') : null,
        chunk,
      )
    },
  })
  const stream = Duplex.from({ readable: owned.stream.pipe(incoming), writable: owned.stream })
  owned.stream.on('error', error => stream.destroy(error))
  let closed: Promise<void> | undefined
  const destroyAll = () =>
    (closed ??= (async () => {
      stream.destroy()
      incoming.destroy()
      await owned.close()
    })())
  return { stream, destroyAll }
}
