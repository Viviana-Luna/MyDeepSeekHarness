/** 会话日志扫描回归：真实 JSONL/Zstandard 头行、目录校验和父子关系。 */
import { mkdtempSync, rmSync } from 'node:fs'
import { copyFile, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectSessionLogsForExport } from '../src/main/session-exports/session-log-discovery.ts'
import { writeSessionLog } from './helpers/session-logs.ts'

const directories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-session-discovery-test-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('会话日志定位', () => {
  it('按头行 parentSession 收集跨项目目录的子会话闭包', async () => {
    const dataRoot = join(temporaryDirectory(), 'data')
    const parent = await writeSessionLog(dataRoot, { id: 'session-parent', cwd: '/tmp/alpha' })
    const child = await writeSessionLog(dataRoot, {
      id: 'session-child',
      parentSession: 'session-parent',
      cwd: '/tmp/beta',
    })
    const grandchild = await writeSessionLog(dataRoot, {
      id: 'session-grandchild',
      parentSession: 'session-child',
    })
    await writeSessionLog(dataRoot, { id: 'session-unrelated', cwd: '/tmp/alpha' })

    const entries = await collectSessionLogsForExport(dataRoot, 'session-parent')

    // 目标在前,子会话按 ID 排序;无关会话不进入结果。
    expect(entries.map(entry => entry.sessionId)).toEqual([
      'session-parent',
      'session-child',
      'session-grandchild',
    ])
    expect(entries.map(entry => entry.sourcePath)).toEqual(
      [parent, child, grandchild].map(item => item.sourcePath),
    )
    expect(entries.map(entry => entry.archivePath)).toEqual([
      `sessions/${parent.projectDirectory}/${parent.sessionDirectory}/${parent.logFileName}`,
      `sessions/${child.projectDirectory}/${child.sessionDirectory}/${child.logFileName}`,
      `sessions/${grandchild.projectDirectory}/${grandchild.sessionDirectory}/${grandchild.logFileName}`,
    ])
  })

  it('选择最高版本的日志文件,忽略锁文件与旧代际', async () => {
    const dataRoot = join(temporaryDirectory(), 'data')
    await writeSessionLog(dataRoot, { id: 'session-alpha', cwd: '/tmp/alpha', version: 1 })
    const latest = await writeSessionLog(dataRoot, {
      id: 'session-alpha',
      cwd: '/tmp/alpha',
      version: 3,
    })
    const directory = join(dataRoot, 'sessions', latest.projectDirectory, latest.sessionDirectory)
    await writeFile(join(directory, 'session.lock'), '')

    const entries = await collectSessionLogsForExport(dataRoot, 'session-alpha')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.sourcePath).toBe(latest.sourcePath)
    expect(entries[0]!.archivePath).toBe(
      `sessions/${latest.projectDirectory}/${latest.sessionDirectory}/${latest.logFileName}`,
    )
  })

  it('未压缩的 jsonl 日志同样可以定位', async () => {
    const dataRoot = join(temporaryDirectory(), 'data')
    const session = await writeSessionLog(dataRoot, {
      id: 'session-plain',
      cwd: '/tmp/alpha',
      compressed: false,
    })
    const entries = await collectSessionLogsForExport(dataRoot, 'session-plain')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.archivePath).toBe(
      `sessions/${session.projectDirectory}/${session.sessionDirectory}/${session.logFileName}`,
    )
  })

  it('目标会话不存在、没有日志或损坏时给出面向用户的错误', async () => {
    const dataRoot = join(temporaryDirectory(), 'data')
    await writeSessionLog(dataRoot, { id: 'session-good', cwd: '/tmp/alpha' })

    await expect(collectSessionLogsForExport(dataRoot, 'session-gone')).rejects.toThrow(
      '要导出的会话已不存在',
    )

    // 只有 session.lock 的目录:会话已创建但还没有日志。
    const empty = await writeSessionLog(dataRoot, { id: 'session-empty', cwd: '/tmp/alpha' })
    await rm(empty.sourcePath)
    await expect(collectSessionLogsForExport(dataRoot, 'session-empty')).rejects.toThrow(
      '要导出的会话还没有可导出的日志',
    )

    // 头行损坏的目标会话。
    const corrupt = await writeSessionLog(dataRoot, { id: 'session-corrupt', cwd: '/tmp/alpha' })
    await writeFile(corrupt.sourcePath, Buffer.from('not-json'))
    await expect(collectSessionLogsForExport(dataRoot, 'session-corrupt')).rejects.toThrow(
      '要导出的会话日志已损坏',
    )
  })

  it('头行会话 ID 与物理目录不一致时拒绝导出', async () => {
    const dataRoot = join(temporaryDirectory(), 'data')
    await writeSessionLog(dataRoot, { id: 'session-honest', cwd: '/tmp/alpha' })
    // 手工把另一个会话的头行放进不匹配的目录,模拟被挪动的数据。
    const mismatched = join(
      dataRoot,
      'sessions',
      '--tmp-alpha--',
      'session-impostor',
      'session.v3.jsonl',
    )
    await mkdir(join(dataRoot, 'sessions', '--tmp-alpha--', 'session-impostor'), {
      recursive: true,
    })
    await writeFile(
      mismatched,
      `${JSON.stringify({ type: 'session', version: 3, id: 'session-honest', cwd: '/tmp/alpha' })}\n`,
    )

    await expect(collectSessionLogsForExport(dataRoot, 'session-impostor')).rejects.toThrow(
      '要导出的会话日志已损坏',
    )
  })

  it('项目路径仅大小写不同时能导出会话，归档路径沿用头行', async () => {
    const dataRoot = join(temporaryDirectory(), 'data')
    await writeSessionLog(dataRoot, { id: 'first', cwd: '/tmp/Project' })
    const second = await writeSessionLog(dataRoot, { id: 'second', cwd: '/tmp/project' })
    const [entry] = await collectSessionLogsForExport(dataRoot, 'second')

    expect(await realpath(entry!.sourcePath)).toBe(await realpath(second.sourcePath))
    expect(entry!.archivePath).toBe(
      `sessions/${second.projectDirectory}/${second.sessionDirectory}/${second.logFileName}`,
    )
  })

  it('重复 ID 的目标或子会话拒绝导出，不任意选取第一份', async () => {
    const dataRoot = join(temporaryDirectory(), 'data')
    await writeSessionLog(dataRoot, { id: 'parent' })
    await writeSessionLog(dataRoot, { id: 'child', parentSession: 'parent', cwd: '/tmp/alpha' })
    await writeSessionLog(dataRoot, { id: 'child', parentSession: 'parent', cwd: '/tmp/beta' })
    await expect(collectSessionLogsForExport(dataRoot, 'child')).rejects.toThrow('重复 ID')
    await expect(collectSessionLogsForExport(dataRoot, 'parent')).rejects.toThrow('重复 ID')
  })

  it.each(['空目录', '损坏日志'])('同名%s不能掩盖重复 ID 或另一份日志的父会话', async kind => {
    const dataRoot = join(temporaryDirectory(), 'data')
    await writeSessionLog(dataRoot, { id: 'parent-alpha' })
    await writeSessionLog(dataRoot, { id: 'parent-beta' })
    await writeSessionLog(dataRoot, {
      id: 'child',
      parentSession: 'parent-alpha',
      cwd: '/tmp/alpha',
    })
    await writeSessionLog(dataRoot, { id: 'child', parentSession: 'parent-beta', cwd: '/tmp/beta' })
    const invalid = await writeSessionLog(dataRoot, { id: 'child', cwd: '/tmp/gamma' })
    if (kind === '空目录') await rm(invalid.sourcePath)
    else await writeFile(invalid.sourcePath, '损坏的日志')

    await expect(collectSessionLogsForExport(dataRoot, 'child')).rejects.toThrow('重复 ID')
    await expect(collectSessionLogsForExport(dataRoot, 'parent-alpha')).rejects.toThrow('重复 ID')
    await expect(collectSessionLogsForExport(dataRoot, 'parent-beta')).rejects.toThrow('重复 ID')
  })

  it.skipIf(process.platform === 'win32')('不跟随项目、会话目录或日志文件的符号链接', async () => {
    const directory = temporaryDirectory()
    const outside = await writeSessionLog(join(directory, 'outside'), { id: 'outside' })
    const dataRoot = join(directory, 'data')
    const normal = await writeSessionLog(dataRoot, { id: 'normal' })
    await symlink(
      dirname(dirname(outside.sourcePath)),
      join(dataRoot, 'sessions', 'linked-project'),
    )
    await symlink(dirname(outside.sourcePath), join(dirname(dirname(normal.sourcePath)), 'outside'))
    await expect(collectSessionLogsForExport(dataRoot, 'outside')).rejects.toThrow('已不存在')
    await rm(normal.sourcePath)
    await symlink(outside.sourcePath, normal.sourcePath)
    await expect(collectSessionLogsForExport(dataRoot, 'normal')).rejects.toThrow('已损坏')
  })

  it('头行超限和物理版本不匹配时拒绝导出', async () => {
    const dataRoot = join(temporaryDirectory(), 'data')
    const session = await writeSessionLog(dataRoot, { id: 'large', compressed: false })
    await writeFile(session.sourcePath, ' '.repeat(1024 * 1024 + 1) + '\n')
    await expect(collectSessionLogsForExport(dataRoot, 'large')).rejects.toThrow('已损坏')
    const old = await writeSessionLog(dataRoot, { id: 'version', version: 1 })
    await copyFile(old.sourcePath, join(dirname(old.sourcePath), 'session.v3.jsonl.zstd'))
    await expect(collectSessionLogsForExport(dataRoot, 'version')).rejects.toThrow('已损坏')
  })

  it('完整头帧之后的记录尾部尚未写完时仍可定位会话', async () => {
    const dataRoot = join(temporaryDirectory(), 'data')
    const session = await writeSessionLog(dataRoot, { id: 'running' })
    await writeFile(session.sourcePath, session.content.subarray(0, session.content.length - 5))
    const entries = await collectSessionLogsForExport(dataRoot, 'running')
    expect(entries[0]?.sourcePath).toBe(session.sourcePath)
  })

  it('已取消的扫描不读取目录也不吞掉取消原因', async () => {
    const dataRoot = join(temporaryDirectory(), 'data')
    const signal = AbortSignal.abort(new Error('验收取消'))
    await expect(collectSessionLogsForExport(dataRoot, 'any', signal)).rejects.toThrow('验收取消')
  })

  it('数据目录尚不存在时报会话不存在而不是崩溃', async () => {
    const dataRoot = join(temporaryDirectory(), 'missing-data')
    await expect(collectSessionLogsForExport(dataRoot, 'session-any')).rejects.toThrow(
      '要导出的会话已不存在',
    )
  })
})
