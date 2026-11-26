/**
 * 会话日志导出专用的流式 ZIP 写入器,主进程模块。
 * 只写 stored(不压缩)条目:日志本身已是 zstd,再压缩没有收益;
 * 使用后置数据描述符在写入后补 CRC 与长度,因此条目内容可以边读边写,不必整份驻留内存。
 * 不拥有目标文件:由调用方创建写入流并在失败时清理 .part;这里只负责顺序写入与格式正确。
 */
/* eslint-disable no-await-in-loop -- 条目按顺序写入,保证取消与大小上限在条目中途生效。 */
import { constants, type WriteStream } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { finished } from 'node:stream/promises'
import { crc32 } from 'node:zlib'

/** EOCD 的条目数是 16 位;真实会话数远达不到,达到即拒绝而不是生成坏档案。 */
const MAX_ENTRIES = 65535

interface CentralRecord {
  readonly name: Buffer
  readonly flags: number
  readonly dosTime: number
  readonly dosDate: number
  readonly crc: number
  readonly size: number
  readonly offset: number
}

/**
 * 校验并编码条目名称:zip 以 / 分隔目录,拒绝反斜杠、绝对路径与 .. 上跳段。
 * 非纯 ASCII 名称设置 UTF-8 标志位,与写入的字节保持一致。
 * @throws 名称为空、超长或含非法段时抛出。
 */
function encodeEntryName(archivePath: string): { name: Buffer; flags: number } {
  const name = Buffer.from(archivePath, 'utf8')
  const segments = archivePath.split('/')
  if (
    name.length > 65535 ||
    archivePath.includes('\\') ||
    archivePath.includes(':') ||
    Array.from(archivePath).some(character => {
      const code = character.codePointAt(0) ?? 0
      return code <= 0x1f || code === 0x7f
    }) ||
    segments.some(segment => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error('ZIP 条目名称无效')
  }
  return { name, flags: 0x0808 }
}

/**
 * 把源文件时间转成 ZIP 的 DOS 日期;DOS 时间以 2 秒为粒度,年份从 1980 起。
 */
function dosDateTime(timestamp: Date): { time: number; date: number } {
  const year = Math.min(Math.max(timestamp.getFullYear(), 1980), 2107)
  return {
    time:
      (timestamp.getHours() << 11) | (timestamp.getMinutes() << 5) | (timestamp.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((timestamp.getMonth() + 1) << 5) | timestamp.getDate(),
  }
}

/** 局部文件头:CRC 与尺寸置零,真实值由随后的数据描述符补齐。 */
function localFileHeader(record: CentralRecord): Buffer {
  const header = Buffer.alloc(30)
  header.writeUInt32LE(0x04034b50, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(record.flags, 6)
  header.writeUInt16LE(0, 8)
  header.writeUInt16LE(record.dosTime, 10)
  header.writeUInt16LE(record.dosDate, 12)
  header.writeUInt16LE(record.name.length, 26)
  return Buffer.concat([header, record.name])
}

/** 数据描述符:stored 条目下压缩尺寸与原始尺寸相同。 */
function dataDescriptor(crc: number, size: number): Buffer {
  const buffer = Buffer.alloc(16)
  buffer.writeUInt32LE(0x08074b50, 0)
  buffer.writeUInt32LE(crc, 4)
  buffer.writeUInt32LE(size, 8)
  buffer.writeUInt32LE(size, 12)
  return buffer
}

/** 中央目录记录:携带真实 CRC、尺寸与局部头偏移,供解压工具与导入预览核对。 */
function centralDirectoryEntry(record: CentralRecord): Buffer {
  const header = Buffer.alloc(46)
  header.writeUInt32LE(0x02014b50, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(20, 6)
  header.writeUInt16LE(record.flags, 8)
  header.writeUInt16LE(0, 10)
  header.writeUInt16LE(record.dosTime, 12)
  header.writeUInt16LE(record.dosDate, 14)
  header.writeUInt32LE(record.crc, 16)
  header.writeUInt32LE(record.size, 20)
  header.writeUInt32LE(record.size, 24)
  header.writeUInt16LE(record.name.length, 28)
  header.writeUInt32LE(record.offset, 42)
  return Buffer.concat([header, record.name])
}

function endOfCentralDirectory(count: number, size: number, offset: number): Buffer {
  const buffer = Buffer.alloc(22)
  buffer.writeUInt32LE(0x06054b50, 0)
  buffer.writeUInt16LE(count, 8)
  buffer.writeUInt16LE(count, 10)
  buffer.writeUInt32LE(size, 12)
  buffer.writeUInt32LE(offset, 16)
  return buffer
}

/**
 * 流式写入一个 stored ZIP 条目后收尾的写入器。
 * 调用方负责创建目标写入流并处理失败清理;写满 maxBytes 或条目数超限会抛出。
 */
export class SessionLogZipWriter {
  private readonly records: CentralRecord[] = []
  private offset = 0
  private ended = false
  private failure?: Error
  private readonly onError = (error: Error): void => {
    this.failure ??= error
  }

  /**
   * @param destination 调用方创建的目标写入流;写入器在 finish() 前不结束它。
   * @param options.maxBytes 整份档案(含头部)的字节上限,超过即抛出并停止写入。
   */
  constructor(
    private readonly destination: WriteStream,
    private readonly options: { maxBytes: number },
  ) {
    // 持久捕获目标流的错误,避免未处理的 error 事件使进程退出,并在下次写入时如实抛出。
    destination.on('error', this.onError)
  }

  /**
   * 追加一个条目:先写局部头,再流式复制源文件内容并计算 CRC,最后补数据描述符。
   * @throws 目标流已失败、内容超过上限或调用方信号中止时抛出;已写入部分由调用方清理。
   */
  async addEntry(archivePath: string, sourcePath: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (this.ended) throw new Error('ZIP 已收尾，不能再追加条目')
    if (this.records.length >= MAX_ENTRIES) throw new Error('ZIP 条目数超过上限')
    const { name, flags } = encodeEntryName(archivePath)
    const info = await lstat(sourcePath)
    if (!info.isFile()) throw new Error('会话日志不是普通文件')
    const { time, date } = dosDateTime(info.mtime)
    const offset = this.offset
    const record: CentralRecord = {
      name,
      flags,
      dosTime: time,
      dosDate: date,
      crc: 0,
      size: 0,
      offset,
    }
    await this.write(localFileHeader(record))
    let crc = 0
    let size = 0
    // 固定读取打开时的长度，不追逐持续追加的日志；不完整尾帧仍按原字节保留。
    const handle = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const source = handle.createReadStream({
      signal,
      ...(info.size > 0 ? { end: info.size - 1 } : {}),
    })
    try {
      for await (const chunk of source) {
        signal?.throwIfAborted()
        crc = crc32(chunk, crc)
        size += chunk.length
        await this.write(chunk)
      }
    } finally {
      source.destroy()
      await finished(source, { cleanup: true }).catch(() => {})
    }
    if (size !== info.size) throw new Error('会话日志在导出期间发生截断，请重试')
    signal?.throwIfAborted()
    await this.write(dataDescriptor(crc, size))
    this.records.push({ ...record, crc, size })
  }

  /**
   * 写入中央目录与 EOCD 并结束目标流,等待落盘完成。
   * @throws 目标流写入失败时抛出;此时调用方仍需清理 .part。
   */
  async finish(): Promise<void> {
    if (this.ended) throw new Error('ZIP 已收尾')
    this.throwIfFailed()
    const directoryOffset = this.offset
    const directory = this.records.map(centralDirectoryEntry)
    const directorySize = directory.reduce((total, entry) => total + entry.length, 0)
    for (const entry of directory) await this.write(entry)
    await this.write(endOfCentralDirectory(this.records.length, directorySize, directoryOffset))
    this.ended = true
    this.destination.end()
    await finished(this.destination, { cleanup: true })
    this.throwIfFailed()
  }

  /** 失败或取消后关闭目标流并等待文件句柄释放，调用方随后才能删除半成品。 */
  async dispose(): Promise<void> {
    this.ended = true
    this.destination.destroy()
    await finished(this.destination, { cleanup: true }).catch(() => {})
    this.destination.off('error', this.onError)
  }

  private async write(buffer: Buffer): Promise<void> {
    this.throwIfFailed()
    if (this.offset + buffer.length > this.options.maxBytes)
      throw new Error('会话日志导出超过 2 GB 桌面上限')
    // 等待本块的写入回调，既遵守背压，也捕获未触发 drain 的小块写入错误。
    await new Promise<void>((resolve, reject) => {
      this.destination.write(buffer, error => {
        if (error) reject(error)
        else resolve()
      })
    })
    this.offset += buffer.length
  }

  private throwIfFailed(): void {
    if (this.failure !== undefined) throw this.failure
  }
}
