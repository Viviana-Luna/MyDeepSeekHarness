import { createHash } from 'node:crypto'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ensureRuntimeInstalled,
  parseRuntimeBundleManifest,
  pruneStaleRuntimes,
} from '../src/main/runtime/runtime-install.ts'
import type { RuntimeBundleManifest } from '../src/shared/runtime-install.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })),
  )
})

async function fixture(
  extraFiles = 0,
  version = '0.1.0-test',
): Promise<{ bundleDirectory: string; mydshHome: string }> {
  const root = await mkdtemp(join(tmpdir(), 'mydsh-runtime-install-'))
  temporaryDirectories.push(root)
  const bundleDirectory = join(root, 'bundle')
  const mydshHome = join(root, 'mydsh')
  const entry = 'process.parentPort.postMessage({ type: "ready" })\n'
  const dependency = '{"name":"mydsh-test-dependency","version":"1.0.0"}\n'
  const files = {
    'entry.js': entry,
    'node_modules/mydsh-test-dependency/package.json': dependency,
    ...Object.fromEntries(
      Array.from({ length: extraFiles }, (_value, index) => [
        `part-${index}.txt`,
        '核心文件\n'.repeat(1024),
      ]),
    ),
  }
  const manifest: RuntimeBundleManifest = {
    schemaVersion: 1,
    platform: process.platform,
    arch: process.arch,
    version,
    apiVersion: 1,
    entry: 'entry.js',
    dataSchemaVersion: 1,
    files: Object.fromEntries(
      Object.entries(files).map(([path, content]) => [
        path,
        {
          sha256: createHash('sha256').update(content).digest('hex'),
          size: Buffer.byteLength(content),
          ...(path === 'entry.js' ? { executable: true } : {}),
        },
      ]),
    ),
  }
  await mkdir(join(bundleDirectory, 'payload/node_modules/mydsh-test-dependency'), {
    recursive: true,
  })
  await Promise.all(
    Object.entries(files).map(([path, content]) =>
      writeFile(join(bundleDirectory, 'payload', path), content),
    ),
  )
  if (process.platform !== 'win32') await chmod(join(bundleDirectory, 'payload/entry.js'), 0o755)
  await writeFile(join(bundleDirectory, 'manifest.json'), JSON.stringify(manifest))
  return { bundleDirectory, mydshHome }
}

describe('MyDSH 核心离线安装', () => {
  it('相同大小和修改时间的篡改仍被摘要校验发现并修复', async () => {
    const options = await fixture()
    const installed = await ensureRuntimeInstalled(options)
    const before = await readFile(installed.entryPath, 'utf8')
    const timestamps = await stat(installed.entryPath)
    await writeFile(installed.entryPath, before.replace('process', 'PROCESS'))
    await utimes(installed.entryPath, timestamps.atime, timestamps.mtime)
    expect((await ensureRuntimeInstalled(options)).installed).toBe(true)
    expect(await readFile(installed.entryPath, 'utf8')).toBe(before)
  })

  it('复制途中取消等待并发工作结束，清理后不再写入且能够重新安装', async () => {
    const options = await fixture(48)
    const controller = new AbortController()
    await expect(
      ensureRuntimeInstalled({
        ...options,
        signal: controller.signal,
        onProgress(progress) {
          if (progress.phase === 'installing' && progress.completed > 0) controller.abort()
        },
      }),
    ).rejects.toThrow('安装已取消')
    expect(await readdir(join(options.mydshHome, 'runtime'))).toEqual([])
    // 让取消前已排队的文件回调获得一轮事件循环，不能重新创建已清理的暂存目录。
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(await readdir(join(options.mydshHome, 'runtime'))).toEqual([])
    const installed = await ensureRuntimeInstalled(options)
    expect(installed.installed).toBe(true)
    expect(await readdir(join(options.mydshHome, 'runtime'))).toEqual(['0.1.0-test'])
    expect(await readFile(join(installed.runtimeDirectory, 'part-47.txt'), 'utf8')).toBe(
      '核心文件\n'.repeat(1024),
    )
  })

  it('首次安装完整依赖、保留执行权限，并复用相同版本而不覆盖用户数据', async () => {
    const options = await fixture()
    const installed = await ensureRuntimeInstalled(options)
    expect(installed.installed).toBe(true)
    expect(installed.runtimeDirectory).toBe(join(options.mydshHome, 'runtime/0.1.0-test'))
    // Windows 没有 POSIX 执行位，只在 POSIX 上校验安装结果保留了执行权限。
    if (process.platform !== 'win32')
      expect((await stat(installed.entryPath)).mode & 0o111).toBe(0o111)
    expect(
      JSON.parse(
        await readFile(
          join(installed.runtimeDirectory, 'node_modules/mydsh-test-dependency/package.json'),
          'utf8',
        ),
      ).name,
    ).toBe('mydsh-test-dependency')
    await writeFile(join(options.mydshHome, 'data/session.jsonl'), '用户会话\n')
    const modified = (await stat(installed.entryPath)).mtimeMs

    expect((await ensureRuntimeInstalled(options)).installed).toBe(false)
    expect((await stat(installed.entryPath)).mtimeMs).toBe(modified)
    expect(await readFile(join(options.mydshHome, 'data/session.jsonl'), 'utf8')).toBe('用户会话\n')
    expect(await readdir(join(options.mydshHome, 'runtime'))).toEqual(['0.1.0-test'])
  })

  it('校验失败或取消清理暂存目录，修复不覆盖会话，并拒绝打开更高数据格式', async () => {
    const options = await fixture()
    const payloadEntry = join(options.bundleDirectory, 'payload/entry.js')
    const original = await readFile(payloadEntry)
    await writeFile(payloadEntry, '不完整的下载内容')
    await expect(ensureRuntimeInstalled(options)).rejects.toThrow('完整性校验失败')
    expect(await readdir(join(options.mydshHome, 'runtime'))).toEqual([])
    await writeFile(payloadEntry, original)
    const controller = new AbortController()
    await expect(
      ensureRuntimeInstalled({
        ...options,
        signal: controller.signal,
        onProgress(progress) {
          if (progress.phase === 'installing') controller.abort()
        },
      }),
    ).rejects.toThrow('安装已取消')
    expect(await readdir(join(options.mydshHome, 'runtime'))).toEqual([])

    const installed = await ensureRuntimeInstalled(options)
    await writeFile(join(options.mydshHome, 'data/session.jsonl'), '必须保留的用户会话\n')
    const interrupted = join(options.mydshHome, 'runtime/.install-interrupted')
    await mkdir(interrupted)
    await writeFile(join(interrupted, 'manifest.json'), JSON.stringify(installed.manifest))
    await rename(installed.runtimeDirectory, join(interrupted, 'previous'))
    expect((await ensureRuntimeInstalled(options)).installed).toBe(false)
    await writeFile(installed.entryPath, '损坏的已安装核心')
    expect((await ensureRuntimeInstalled(options)).installed).toBe(true)
    expect(await readFile(installed.entryPath)).toEqual(original)
    expect(await readFile(join(options.mydshHome, 'data/session.jsonl'), 'utf8')).toBe(
      '必须保留的用户会话\n',
    )
    await writeFile(join(options.mydshHome, 'data/format.json'), '{"schemaVersion":2}\n')
    await expect(ensureRuntimeInstalled(options)).rejects.toThrow('数据格式为 2')
    expect(await readFile(join(options.mydshHome, 'data/format.json'), 'utf8')).toBe(
      '{"schemaVersion":2}\n',
    )
    expect(await readdir(join(options.mydshHome, 'runtime'))).toEqual(['0.1.0-test'])
  })
})

describe('旧版本核心目录清理', () => {
  it('跨版本升级后自动清理旧版本，无安装回执的陌生目录不受影响', async () => {
    const older = await fixture()
    const newer = await fixture(0, '0.2.0-test')
    await ensureRuntimeInstalled({
      bundleDirectory: older.bundleDirectory,
      mydshHome: newer.mydshHome,
    })
    const stranger = join(newer.mydshHome, 'runtime', 'user-backup')
    await mkdir(stranger, { recursive: true })
    await writeFile(join(stranger, 'notes.txt'), '用户的目录\n')
    const installed = await ensureRuntimeInstalled({
      bundleDirectory: newer.bundleDirectory,
      mydshHome: newer.mydshHome,
    })
    expect(installed.installed).toBe(true)
    expect(installed.manifest.version).toBe('0.2.0-test')
    expect((await readdir(join(newer.mydshHome, 'runtime'))).toSorted()).toEqual([
      '0.2.0-test',
      'user-backup',
    ])
    expect(await readFile(join(stranger, 'notes.txt'), 'utf8')).toBe('用户的目录\n')
  })

  it('复用已就绪核心时收走历史升级残留，不留待删标记', async () => {
    const options = await fixture()
    const installed = await ensureRuntimeInstalled(options)
    const stale = join(options.mydshHome, 'runtime', '0.0.9-test')
    await mkdir(stale, { recursive: true })
    await copyFile(
      join(installed.runtimeDirectory, '.mydsh-install.json'),
      join(stale, '.mydsh-install.json'),
    )
    await writeFile(join(stale, 'entry.js'), '旧版本入口\n')
    expect((await ensureRuntimeInstalled(options)).installed).toBe(false)
    expect(await readdir(join(options.mydshHome, 'runtime'))).toEqual(['0.1.0-test'])
  })

  it('上次清理中断留下的待删目录在下次启动收尾', async () => {
    const options = await fixture()
    await ensureRuntimeInstalled(options)
    const trash = join(options.mydshHome, 'runtime', '.trash-0.0.8-test')
    await mkdir(join(trash, 'node_modules'), { recursive: true })
    await writeFile(join(trash, 'node_modules/junk.js'), '半删除残留\n')
    await ensureRuntimeInstalled(options)
    expect(await readdir(join(options.mydshHome, 'runtime'))).toEqual(['0.1.0-test'])
  })

  it.skipIf(process.platform === 'win32')(
    '清理失败不阻断启动，待删标记留给下次启动收尾',
    async () => {
      const older = await fixture()
      const newer = await fixture(0, '0.2.0-test')
      await ensureRuntimeInstalled({
        bundleDirectory: older.bundleDirectory,
        mydshHome: newer.mydshHome,
      })
      // 目录只读时无法删除其中文件；复现清理失败并确认不影响本次安装。Windows 无法这样注入，由安装包验收覆盖。
      await chmod(join(newer.mydshHome, 'runtime', '0.1.0-test'), 0o555)
      const installed = await ensureRuntimeInstalled({
        bundleDirectory: newer.bundleDirectory,
        mydshHome: newer.mydshHome,
      })
      expect(installed.installed).toBe(true)
      expect(installed.manifest.version).toBe('0.2.0-test')
      expect(await readFile(installed.entryPath, 'utf8')).toContain('ready')
      expect((await readdir(join(newer.mydshHome, 'runtime'))).toSorted()).toEqual([
        '.trash-0.1.0-test',
        '0.2.0-test',
      ])
      await chmod(join(newer.mydshHome, 'runtime', '.trash-0.1.0-test'), 0o755)
      expect(
        (
          await ensureRuntimeInstalled({
            bundleDirectory: newer.bundleDirectory,
            mydshHome: newer.mydshHome,
          })
        ).installed,
      ).toBe(false)
      expect(await readdir(join(newer.mydshHome, 'runtime'))).toEqual(['0.2.0-test'])
    },
  )

  it('清理尊重取消信号，不改动任何核心目录', async () => {
    const options = await fixture()
    const installed = await ensureRuntimeInstalled(options)
    const stale = join(options.mydshHome, 'runtime', '0.0.9-test')
    await mkdir(stale, { recursive: true })
    await copyFile(
      join(installed.runtimeDirectory, '.mydsh-install.json'),
      join(stale, '.mydsh-install.json'),
    )
    await expect(
      pruneStaleRuntimes(join(options.mydshHome, 'runtime'), '0.1.0-test', AbortSignal.abort()),
    ).rejects.toThrow('安装已取消')
    expect((await readdir(join(options.mydshHome, 'runtime'))).toSorted()).toEqual([
      '0.0.9-test',
      '0.1.0-test',
    ])
  })
})

describe('核心的平台迁移', () => {
  it('拒绝其他平台或架构，旧核心和用户数据保持原样', async () => {
    const options = await fixture()
    const installed = await ensureRuntimeInstalled(options)
    const data = join(options.mydshHome, 'data/用户会话.jsonl')
    await writeFile(data, '保留会话')
    const manifestPath = join(options.bundleDirectory, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as RuntimeBundleManifest
    manifest.arch = process.arch === 'x64' ? 'arm64' : 'x64'
    await writeFile(manifestPath, JSON.stringify(manifest))
    await expect(ensureRuntimeInstalled(options)).rejects.toThrow('平台')
    expect(await readFile(data, 'utf8')).toBe('保留会话')
    expect(await readFile(installed.entryPath, 'utf8')).toContain('ready')
  })
  it('补装没有平台字段的旧收据，并保留用户数据', async () => {
    const options = await fixture()
    const installed = await ensureRuntimeInstalled(options)
    const receiptPath = join(installed.runtimeDirectory, '.mydsh-install.json')
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as RuntimeBundleManifest
    delete receipt.platform
    delete receipt.arch
    await writeFile(receiptPath, JSON.stringify(receipt))
    await writeFile(join(options.mydshHome, 'data/会话.jsonl'), '旧会话')
    expect((await ensureRuntimeInstalled(options)).installed).toBe(true)
    expect(await readFile(join(options.mydshHome, 'data/会话.jsonl'), 'utf8')).toBe('旧会话')
  })
})

describe('Windows 核心清单路径', () => {
  const file = { sha256: '0'.repeat(64), size: 0 }
  const manifest = {
    schemaVersion: 1,
    apiVersion: 1,
    version: '0.1.0-test',
    dataSchemaVersion: 1,
    platform: 'win32',
    arch: 'x64',
    entry: 'entry.js',
    files: { 'entry.js': file },
  }

  it('拒绝设备名、备用数据流、尾部空白与路径穿越', () => {
    for (const path of [
      'tools/CON.txt',
      'tools/LPT1',
      'tools/COM¹.log',
      'entry.js:secret',
      'tools/name.',
      'tools/name ',
      '../outside.js',
      'tools\\outside.js',
    ]) {
      expect(() =>
        parseRuntimeBundleManifest({ ...manifest, files: { ...manifest.files, [path]: file } }),
      ).toThrow('无效文件')
    }
  })

  it('拒绝仅大小写不同的重复文件', () => {
    expect(() =>
      parseRuntimeBundleManifest({ ...manifest, files: { ...manifest.files, 'ENTRY.js': file } }),
    ).toThrow('大小写冲突')
  })
})
