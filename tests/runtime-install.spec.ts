/**
 * 离线核心就地准备、完整性校验与历史遗留目录清理测试。
 */
import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
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

async function createArchivedFixture(version = '0.1.0-test'): Promise<{
  bundleDirectory: string
  mydshHome: string
  asarPath: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'mydsh-runtime-install-'))
  temporaryDirectories.push(root)
  const bundleDirectory = join(root, 'bundle')
  const mydshHome = join(root, 'mydsh')
  await mkdir(bundleDirectory, { recursive: true })
  const asarContent = Buffer.from('mock-asar-archive-payload\n')
  const licenseContent = Buffer.from('MIT License\n')
  const files = {
    'runtime.asar': asarContent,
    'licenses/deepseek-harness/LICENSE': licenseContent,
  }
  const manifest: RuntimeBundleManifest = {
    schemaVersion: 1,
    platform: process.platform,
    arch: process.arch,
    version,
    apiVersion: 1,
    archive: 'runtime.asar',
    entry: 'entry.js',
    dataSchemaVersion: 1,
    files: Object.fromEntries(
      Object.entries(files).map(([path, bytes]) => [
        path,
        {
          sha256: createHash('sha256').update(bytes).digest('hex'),
          size: bytes.byteLength,
        },
      ]),
    ),
  }
  await mkdir(join(bundleDirectory, 'licenses/deepseek-harness'), { recursive: true })
  await writeFile(join(bundleDirectory, 'runtime.asar'), asarContent)
  await writeFile(join(bundleDirectory, 'licenses/deepseek-harness/LICENSE'), licenseContent)
  await writeFile(join(bundleDirectory, 'manifest.json'), JSON.stringify(manifest))
  return { bundleDirectory, mydshHome, asarPath: join(bundleDirectory, 'runtime.asar') }
}

async function createPayloadFixture(
  extraFiles = 0,
  version = '0.1.0-test',
): Promise<{ bundleDirectory: string; mydshHome: string }> {
  const root = await mkdtemp(join(tmpdir(), 'mydsh-runtime-payload-'))
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
        `part-${String(index)}.txt`,
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

describe('MyDSH 离线核心就地准备', () => {
  it('默认就地指向 runtime.asar 入口、初始化用户目录且不向 ~/.mydsh/runtime 复制核心文件', async () => {
    const options = await createArchivedFixture()
    const ready = await ensureRuntimeInstalled(options)
    expect(ready.installed).toBe(false)
    expect(ready.runtimeDirectory).toBe(join(options.bundleDirectory, 'runtime.asar'))
    expect(ready.entryPath).toBe(join(options.bundleDirectory, 'runtime.asar', 'entry.js'))
    const children = (await readdir(options.mydshHome)).toSorted()
    expect(children).toEqual(['cache', 'config', 'conversions', 'data', 'plugins'])
    expect(JSON.parse(await readFile(join(options.mydshHome, 'data/format.json'), 'utf8'))).toEqual(
      { schemaVersion: 1 },
    )
  })

  it('启用 verifyIntegrity 时发现同大小同时间戳篡改或清单外文件并拒绝启动', async () => {
    const options = await createArchivedFixture()
    const before = await readFile(options.asarPath, 'utf8')
    const timestamps = await stat(options.asarPath)
    await writeFile(options.asarPath, before.replace('payload', 'PAYLOAD'))
    await utimes(options.asarPath, timestamps.atime, timestamps.mtime)
    await expect(ensureRuntimeInstalled({ ...options, verifyIntegrity: true })).rejects.toThrow(
      '完整性校验失败',
    )
    await writeFile(options.asarPath, before)
    expect((await ensureRuntimeInstalled({ ...options, verifyIntegrity: true })).installed).toBe(
      false,
    )
    const unexpected = join(options.bundleDirectory, 'unexpected.txt')
    await writeFile(unexpected, 'stray')
    await expect(ensureRuntimeInstalled({ ...options, verifyIntegrity: true })).rejects.toThrow(
      '清单外的文件',
    )
  })

  it('校验途中收到取消信号立即中止，恢复后保留用户会话并拒绝更高数据格式版本', async () => {
    const options = await createPayloadFixture(48)
    const controller = new AbortController()
    await expect(
      ensureRuntimeInstalled({
        ...options,
        verifyIntegrity: true,
        signal: controller.signal,
        onProgress(progress) {
          if (progress.phase === 'verifying' && progress.completed > 0) controller.abort()
        },
      }),
    ).rejects.toThrow('安装已取消')

    const ready = await ensureRuntimeInstalled({ ...options, verifyIntegrity: true })
    expect(ready.installed).toBe(false)
    expect(ready.runtimeDirectory).toBe(join(options.bundleDirectory, 'payload'))
    await writeFile(join(options.mydshHome, 'data/session.jsonl'), '必须保留的用户会话\n')
    await ensureRuntimeInstalled(options)
    expect(await readFile(join(options.mydshHome, 'data/session.jsonl'), 'utf8')).toBe(
      '必须保留的用户会话\n',
    )

    await writeFile(join(options.mydshHome, 'data/format.json'), '{"schemaVersion":2}\n')
    await expect(ensureRuntimeInstalled(options)).rejects.toThrow('数据格式为 2')
    expect(await readFile(join(options.mydshHome, 'data/format.json'), 'utf8')).toBe(
      '{"schemaVersion":2}\n',
    )
  })
})

describe('历史遗留 ~/.mydsh/runtime 目录清理', () => {
  it('自动清理带安装回执的旧版核心副本与待删目录，无回执的用户自建目录原样保留', async () => {
    const options = await createArchivedFixture('0.2.0-test')
    const legacy = join(options.mydshHome, 'runtime', '0.1.0-test')
    const trash = join(options.mydshHome, 'runtime', '.trash-0.0.8-test')
    const interrupted = join(options.mydshHome, 'runtime', '.install-interrupted')
    const stranger = join(options.mydshHome, 'runtime', 'user-backup')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, '.mydsh-install.json'), '{"version":"0.1.0-test"}\n')
    await writeFile(join(legacy, 'entry.js'), 'legacy\n')
    await mkdir(trash, { recursive: true })
    await writeFile(join(trash, 'junk.js'), 'trash\n')
    await mkdir(interrupted, { recursive: true })
    await mkdir(stranger, { recursive: true })
    await writeFile(join(stranger, 'notes.txt'), '用户的目录\n')

    await ensureRuntimeInstalled(options)
    expect(await readdir(join(options.mydshHome, 'runtime'))).toEqual(['user-backup'])
    expect(await readFile(join(stranger, 'notes.txt'), 'utf8')).toBe('用户的目录\n')
  })

  it('全部旧版残留清空后一并移除空的 runtime 目录壳', async () => {
    const options = await createArchivedFixture('0.2.0-test')
    const legacy = join(options.mydshHome, 'runtime', '0.1.0-test')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, '.mydsh-install.json'), '{"version":"0.1.0-test"}\n')
    await ensureRuntimeInstalled(options)
    expect((await readdir(options.mydshHome)).includes('runtime')).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    '清理失败不阻断启动，待删标记留给下次启动收尾',
    async () => {
      const options = await createArchivedFixture('0.2.0-test')
      const staleDir = join(options.mydshHome, 'runtime', '0.1.0-test')
      const lockedSubdir = join(staleDir, 'locked')
      const trashedLockedSubdir = join(options.mydshHome, 'runtime', '.trash-0.1.0-test', 'locked')
      await mkdir(lockedSubdir, { recursive: true })
      await writeFile(join(staleDir, '.mydsh-install.json'), '{"version":"0.1.0-test"}\n')
      await writeFile(join(lockedSubdir, 'held.js'), 'held\n')
      await chmod(lockedSubdir, 0o555)
      try {
        const installed = await ensureRuntimeInstalled(options)
        expect(installed.manifest.version).toBe('0.2.0-test')
        expect(await readdir(join(options.mydshHome, 'runtime'))).toEqual(['.trash-0.1.0-test'])
        await chmod(trashedLockedSubdir, 0o755)
        await ensureRuntimeInstalled(options)
        expect((await readdir(options.mydshHome)).includes('runtime')).toBe(false)
      } finally {
        await chmod(lockedSubdir, 0o755).catch(() => undefined)
        await chmod(trashedLockedSubdir, 0o755).catch(() => undefined)
      }
    },
  )

  it('清理尊重取消信号，不改动已有旧目录', async () => {
    const options = await createArchivedFixture()
    const stale = join(options.mydshHome, 'runtime', '0.0.9-test')
    await mkdir(stale, { recursive: true })
    await writeFile(join(stale, '.mydsh-install.json'), '{"version":"0.0.9-test"}\n')
    await expect(
      pruneStaleRuntimes(join(options.mydshHome, 'runtime'), '', AbortSignal.abort()),
    ).rejects.toThrow('安装已取消')
    expect(await readdir(join(options.mydshHome, 'runtime'))).toEqual(['0.0.9-test'])
  })
})

describe('核心平台与路径校验', () => {
  it('拒绝其他平台或架构并保留用户数据原样', async () => {
    const options = await createArchivedFixture()
    await ensureRuntimeInstalled(options)
    const data = join(options.mydshHome, 'data/用户会话.jsonl')
    await writeFile(data, '保留会话')
    const manifestPath = join(options.bundleDirectory, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as RuntimeBundleManifest
    manifest.arch = process.arch === 'x64' ? 'arm64' : 'x64'
    await writeFile(manifestPath, JSON.stringify(manifest))
    await expect(ensureRuntimeInstalled(options)).rejects.toThrow('平台')
    expect(await readFile(data, 'utf8')).toBe('保留会话')
  })

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
