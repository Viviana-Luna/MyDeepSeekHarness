/** stored ZIP 编码回归：独立读取 CRC、条目路径及失败后的流释放。 */
import { createWriteStream, mkdtempSync, rmSync } from 'node:fs'
import { stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionLogZipWriter } from '../src/main/session-exports/zip-writer.ts'
import { readStoredZip } from './helpers/session-logs.ts'

const directories: string[] = []
const writers: SessionLogZipWriter[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-zip-writer-test-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(writers.splice(0).map(writer => writer.dispose()))
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** 创建写入器与两份内容不同的源文件,供各用例复用。 */
async function fixture() {
  const directory = temporaryDirectory()
  const firstPath = join(directory, 'first.bin')
  const secondPath = join(directory, 'second.bin')
  const first = Buffer.from('第一个条目的内容\n包含换行与多字节字符')
  const second = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 1, 2, 3])
  await writeFile(firstPath, first)
  await writeFile(secondPath, second)
  return { directory, firstPath, secondPath, first, second }
}

describe('会话日志 ZIP 写入器', () => {
  it('按 stored 条目写入并通过 CRC 与数据描述符校验', async () => {
    const { directory, firstPath, secondPath, first, second } = await fixture()
    const destination = join(directory, '归档.zip')
    const writer = new SessionLogZipWriter(createWriteStream(destination), {
      maxBytes: 1024 * 1024,
    })
    writers.push(writer)
    await writer.addEntry('sessions/--项目--/session-a/session.v3.jsonl.zstd', firstPath)
    await writer.addEntry('sessions/--项目--/session-b/session.v3.jsonl', secondPath)
    await writer.finish()

    const entries = await readStoredZip(destination)
    expect(entries.map(entry => entry.name)).toEqual([
      'sessions/--项目--/session-a/session.v3.jsonl.zstd',
      'sessions/--项目--/session-b/session.v3.jsonl',
    ])
    expect(entries[0]!.content).toEqual(first)
    expect(entries[1]!.content).toEqual(second)
  })

  it('超过大小上限时中止写入', async () => {
    const { directory, firstPath } = await fixture()
    const destination = join(directory, '超限.zip')
    const writer = new SessionLogZipWriter(createWriteStream(destination), { maxBytes: 40 })
    writers.push(writer)
    await expect(writer.addEntry('too-large.bin', firstPath)).rejects.toThrow(
      '会话日志导出超过 2 GB 桌面上限',
    )
  })

  it('拒绝非法条目名称', async () => {
    const { directory, firstPath } = await fixture()
    const writer = new SessionLogZipWriter(createWriteStream(join(directory, 'names.zip')), {
      maxBytes: 1024,
    })
    writers.push(writer)
    const invalidNames = [
      '/绝对路径.bin',
      'C:/windows.bin',
      '反斜杠\\名称.bin',
      '上跳/../escape.bin',
      '空//段.bin',
      '空\u0000字节.bin',
      '长'.repeat(22000),
    ]
    // 名称校验在任何文件操作前拒绝，这些请求不会并发写入同一个 ZIP。
    await Promise.all(
      invalidNames.map(name =>
        expect(writer.addEntry(name, firstPath)).rejects.toThrow('ZIP 条目名称无效'),
      ),
    )
  })

  it('取消大文件复制时可关闭流，不在失败后继续写入', async () => {
    const { directory, firstPath } = await fixture()
    await writeFile(firstPath, Buffer.alloc(2 * 1024 * 1024, 1))
    const destination = createWriteStream(join(directory, '取消.zip'))
    const writer = new SessionLogZipWriter(destination, { maxBytes: 4 * 1024 * 1024 })
    writers.push(writer)
    const controller = new AbortController()
    const writing = writer.addEntry('large.bin', firstPath, controller.signal)
    destination.once('open', () => controller.abort(new Error('复制已取消')))
    await expect(writing).rejects.toThrow()
    await writer.dispose()
    expect(destination.closed).toBe(true)
    const info = await stat(join(directory, '取消.zip'))
    expect(info.size).toBeLessThan(2 * 1024 * 1024)
  })

  it('空文件同样写入合法条目', async () => {
    const { directory, firstPath } = await fixture()
    await writeFile(firstPath, '')
    const destination = join(directory, '空文件.zip')
    const writer = new SessionLogZipWriter(createWriteStream(destination), { maxBytes: 1024 })
    writers.push(writer)
    await writer.addEntry('empty.bin', firstPath)
    await writer.finish()
    expect(await readStoredZip(destination)).toEqual([
      { name: 'empty.bin', content: Buffer.alloc(0) },
    ])
  })

  it('收尾后不能再追加条目或重复收尾', async () => {
    const { directory, firstPath } = await fixture()
    const writer = new SessionLogZipWriter(createWriteStream(join(directory, 'closed.zip')), {
      maxBytes: 1024,
    })
    writers.push(writer)
    await writer.addEntry('entry.bin', firstPath)
    await writer.finish()
    await expect(writer.addEntry('another.bin', firstPath)).rejects.toThrow('不能再追加条目')
    await expect(writer.finish()).rejects.toThrow('ZIP 已收尾')
  })
})
