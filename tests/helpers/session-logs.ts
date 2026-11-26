/**
 * 测试专用:构造 sessions/<项目>/<会话>/ 夹具并读取本仓库生成的 stored ZIP。
 * 不做产品级解析;只验证条目名、CRC、数据描述符与内容字节,供导出相关测试共用。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { crc32, zstdCompressSync } from 'node:zlib'
import {
  sessionDirectorySegment,
  sessionProjectDirectoryKey,
} from '../../src/shared/session-paths.ts'

/** 写入一个会话日志夹具;zstd 文件按每条记录一帧编码,头行独立成帧。 */
export interface SessionLogFixtureInput {
  readonly id: string
  readonly parentSession?: string
  readonly cwd?: string
  /** 日志物理版本号,默认 3;文件名随之生成为 session.vN.jsonl(.zstd)。 */
  readonly version?: number
  /** 是否压缩为 zstd,默认 true。 */
  readonly compressed?: boolean
}

/** 写入后的会话日志夹具:磁盘路径与原始内容一一对应。 */
export interface SessionLogFixture {
  readonly id: string
  readonly projectDirectory: string
  readonly sessionDirectory: string
  readonly logFileName: string
  readonly sourcePath: string
  readonly content: Buffer
}

/**
 * 在数据目录中写入一个会话日志夹具,目录名与文件名遵循真实布局规则。
 * @throws 目标已存在同名文件时抛出,避免夹具互相覆盖。
 */
export async function writeSessionLog(
  dataRoot: string,
  input: SessionLogFixtureInput,
): Promise<SessionLogFixture> {
  const version = input.version ?? 3
  const compressed = input.compressed ?? true
  const header = `${JSON.stringify({
    type: 'session',
    version,
    id: input.id,
    createdAt: 1,
    isSeeded: false,
    delegationDepth: input.parentSession === undefined ? 0 : 1,
    ...(input.parentSession === undefined
      ? {}
      : { parentSession: input.parentSession, origin: 'subagent' }),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
  })}\n`
  const row = `${JSON.stringify({
    type: 'session/title',
    seq: 0,
    time: 2,
    data: { title: '测试记录', messageSeqs: [], source: { kind: 'user' } },
  })}\n`
  const content = compressed
    ? Buffer.concat([zstdCompressSync(header), zstdCompressSync(row)])
    : Buffer.from(header + row, 'utf8')
  const projectDirectory = sessionProjectDirectoryKey(input.cwd)
  const sessionDirectory = sessionDirectorySegment(input.id)
  const logFileName = `session${version === 0 ? '' : `.v${version}`}.jsonl${compressed ? '.zstd' : ''}`
  const sourcePath = join(dataRoot, 'sessions', projectDirectory, sessionDirectory, logFileName)
  await mkdir(join(dataRoot, 'sessions', projectDirectory, sessionDirectory), { recursive: true })
  // 按生产布局逐记录成帧,验证读取端只解压头帧即可停止。
  await writeFile(sourcePath, content, { flag: 'wx' })
  return { id: input.id, projectDirectory, sessionDirectory, logFileName, sourcePath, content }
}

/** 读回的一个 stored ZIP 条目。 */
export interface ZipEntryRecord {
  readonly name: string
  readonly content: Buffer
}

/**
 * 读取本仓库生成的 stored ZIP 并逐条校验 CRC 与数据描述符。
 * @throws 文件不是合法的 stored ZIP、CRC 不符或数据描述符缺失时抛出。
 */
export async function readStoredZip(path: string): Promise<ZipEntryRecord[]> {
  const buffer = await readFile(path)
  if (buffer.length < 22) throw new Error('ZIP 文件太小')
  // 生成端不写注释,EOCD 恰为最后 22 字节。
  const eocd = buffer.length - 22
  if (buffer.readUInt32LE(eocd) !== 0x06054b50) throw new Error('未找到 EOCD')
  const count = buffer.readUInt16LE(eocd + 10)
  const directorySize = buffer.readUInt32LE(eocd + 12)
  const directoryOffset = buffer.readUInt32LE(eocd + 16)
  const entries: ZipEntryRecord[] = []
  let cursor = directoryOffset
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('中央目录记录签名无效')
    const method = buffer.readUInt16LE(cursor + 10)
    const crc = buffer.readUInt32LE(cursor + 16)
    const size = buffer.readUInt32LE(cursor + 20)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    if (method !== 0) throw new Error(`条目 ${name} 不是 stored 编码`)
    const content = buffer.subarray(
      localOffset + 30 + nameLength,
      localOffset + 30 + nameLength + size,
    )
    if (crc32(content) !== crc) throw new Error(`条目 ${name} CRC 不符`)
    // stored 条目紧跟数据描述符,核对其中的 CRC 与尺寸与中央目录一致。
    const descriptor = localOffset + 30 + nameLength + size
    if (buffer.readUInt32LE(descriptor) !== 0x08074b50)
      throw new Error(`条目 ${name} 缺少数据描述符`)
    if (buffer.readUInt32LE(descriptor + 4) !== crc) throw new Error(`条目 ${name} 描述符 CRC 不符`)
    if (buffer.readUInt32LE(descriptor + 8) !== size) throw new Error(`条目 ${name} 描述符尺寸不符`)
    entries.push({ name, content })
    cursor += 46 + nameLength
  }
  if (cursor !== directoryOffset + directorySize) throw new Error('中央目录长度与 EOCD 不符')
  return entries
}
