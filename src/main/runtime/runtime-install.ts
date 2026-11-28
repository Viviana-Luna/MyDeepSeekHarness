/**
 * 离线核心就地准备与用户数据目录守卫：校验随应用交付的核心清单、核对数据格式版本、
 * 初始化 `~/.mydsh` 用户子目录，并在升级后清理历史遗留的 `~/.mydsh/runtime/<旧版本>` 副本。
 * 运行在 Electron 主进程；调用方须先取得单实例锁，并在本模块返回后启动 `utilityProcess`。
 */
/* eslint-disable no-await-in-loop -- 清理旧版残留目录按顺序执行，保证取消信号与原子重命名顺序。 */
import { createHash, randomUUID } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { renameWithRetry as rename } from '../../runtime/filesystem/file-operations.ts'
import type {
  RuntimeBundleFile,
  RuntimeBundleManifest,
  RuntimeInstallProgress,
} from '../../shared/runtime-install.ts'
import { isRecord } from '../../shared/validation.ts'

const requireModule = createRequire(import.meta.url)
// Electron 主进程的 node:fs 会把 .asar 映射为虚拟目录；校验物理归档文件需走 original-fs，纯 Node 测试回退到 node:fs。
const physicalFs: typeof nodeFs = process.versions.electron
  ? (requireModule('original-fs') as typeof nodeFs)
  : nodeFs
const {
  createReadStream: createPhysicalReadStream,
  promises: { lstat: lstatPhysical, readFile: readPhysicalFile, readdir: readdirPhysical },
} = physicalFs

const INSTALL_RECEIPT = '.mydsh-install.json'
const MANIFEST_FILENAME = 'manifest.json'
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const TRASH_PREFIX = '.trash-'

/** 就地准备运行核心的调用参数。 */
export interface RuntimeInstallOptions {
  /** 包含 `manifest.json` 与 `runtime.asar`（或测试夹具 `payload/`）的应用资源目录。 */
  bundleDirectory: string
  mydshHome?: string
  /** 显式启用时逐文件核对物理文件 SHA-256；常规桌面启动默认仅做快速结构与字节大小校验。 */
  verifyIntegrity?: boolean
  signal?: AbortSignal
  onProgress?: (progress: RuntimeInstallProgress) => void
}

/** 已通过校验、可直接由 `utilityProcess.fork` 就地加载的核心描述。 */
export interface InstalledRuntime {
  mydshHome: string
  runtimeDirectory: string
  entryPath: string
  manifest: RuntimeBundleManifest
  /** 就地运行模式下不再向用户目录复制核心文件，恒为 `false`。 */
  installed: boolean
}

function validRelativePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    value
      .split('/')
      .every(
        part =>
          part !== '' &&
          part !== '.' &&
          part !== '..' &&
          !/[<>:"|?*]/u.test(part) &&
          !/[. ]$/u.test(part) &&
          !/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu.test(part),
      ) &&
    !isAbsolute(value) &&
    value !== INSTALL_RECEIPT
  )
}

function parseManifestFiles(
  rawFiles: Record<string, unknown>,
  platform: unknown,
): Record<string, RuntimeBundleFile> {
  const files: Record<string, RuntimeBundleFile> = Object.create(null) as Record<
    string,
    RuntimeBundleFile
  >
  const portablePaths = new Set<string>()
  for (const [path, file] of Object.entries(rawFiles)) {
    const portable = path.toLowerCase()
    if (platform === 'win32' && portablePaths.has(portable)) {
      throw new Error(`Windows 核心路径存在大小写冲突：${path}`)
    }
    portablePaths.add(portable)
    if (
      !validRelativePath(path) ||
      !isRecord(file) ||
      typeof file.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(file.sha256) ||
      !Number.isSafeInteger(file.size) ||
      (file.size as number) < 0 ||
      (file.executable !== undefined && typeof file.executable !== 'boolean')
    ) {
      throw new Error(`核心安装清单包含无效文件：${path}`)
    }
    files[path] = {
      sha256: file.sha256,
      size: file.size as number,
      ...(file.executable === undefined ? {} : { executable: file.executable }),
    }
  }
  return files
}

/**
 * 解析并严格校验核心资源清单，拒绝路径穿越、Windows 设备名及大小写冲突。
 * @throws 清单版本、平台字段、入口或文件记录不合法时抛出中文错误。
 */
export function parseRuntimeBundleManifest(value: unknown): RuntimeBundleManifest {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.apiVersion !== 1 ||
    typeof value.version !== 'string' ||
    !VERSION_PATTERN.test(value.version) ||
    !validRelativePath(value.entry) ||
    (value.archive !== undefined && !validRelativePath(value.archive)) ||
    !Number.isSafeInteger(value.dataSchemaVersion) ||
    (value.dataSchemaVersion as number) < 1 ||
    !isRecord(value.files) ||
    (value.platform !== undefined &&
      !['darwin', 'win32', 'linux'].includes(String(value.platform))) ||
    (value.arch !== undefined && !['arm64', 'x64'].includes(String(value.arch))) ||
    (value.platform === undefined) !== (value.arch === undefined)
  ) {
    throw new Error('核心安装清单格式不正确或版本不受支持。')
  }
  const files = parseManifestFiles(value.files, value.platform)
  const archive = value.archive as string | undefined
  if (archive !== undefined) {
    if (!files[archive]) throw new Error('核心安装清单缺少归档文件记录。')
  } else if (!files[value.entry]) {
    throw new Error('核心安装清单缺少启动入口。')
  }
  return {
    schemaVersion: 1,
    ...(value.platform === undefined
      ? {}
      : { platform: value.platform as string, arch: value.arch as string }),
    version: value.version,
    apiVersion: 1,
    ...(archive === undefined ? {} : { archive }),
    entry: value.entry,
    dataSchemaVersion: value.dataSchemaVersion as number,
    files,
  }
}

/**
 * 解析 MyDSH 用户数据根目录，要求显式覆盖或环境变量必须是绝对路径。
 * @throws 当提供相对路径时抛出错误。
 */
export function resolveMydshHome(override?: string): string {
  const selected = override ?? process.env.MYDSH_HOME ?? join(homedir(), '.mydsh')
  if (!isAbsolute(selected)) throw new Error('MYDSH_HOME 必须是绝对路径。')
  return resolve(selected)
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('核心安装已取消。', { cause: signal.reason })
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`核心路径必须是实际目录：${path}`)
    }
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await directoryExists(path)
}

async function digestFile(path: string, size: number, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  if (size <= 4 * 1024 * 1024) {
    const bytes = await readPhysicalFile(path, signal ? { signal } : {})
    checkAbort(signal)
    return hash.update(bytes).digest('hex')
  }
  const stream = createPhysicalReadStream(path, signal ? { signal } : {})
  try {
    for await (const chunk of stream) {
      checkAbort(signal)
      hash.update(chunk)
    }
  } finally {
    stream.destroy()
  }
  return hash.digest('hex')
}

async function forEachBounded<T>(
  items: readonly T[],
  visit: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0
  let failed = false
  let failure: unknown
  const workers = Array.from({ length: Math.min(16, items.length) }, async () => {
    while (!failed && cursor < items.length) {
      const item = items[cursor++]!
      try {
        await visit(item)
      } catch (error) {
        failed = true
        failure ??= error
      }
    }
  })
  await Promise.all(workers)
  if (failed) throw failure
}

async function verifyPhysicalTree(options: {
  readonly rootDirectory: string
  readonly manifest: RuntimeBundleManifest
  readonly ignoreRootManifest: boolean
  readonly signal?: AbortSignal
  readonly onVerified?: (completed: number) => void
}): Promise<void> {
  const { rootDirectory, manifest, ignoreRootManifest, signal, onVerified } = options
  const remaining = new Set(Object.keys(manifest.files))
  const paths: string[] = []
  async function visit(relativePath: string): Promise<void> {
    checkAbort(signal)
    for (const entry of await readdirPhysical(join(rootDirectory, relativePath), {
      withFileTypes: true,
    })) {
      const path = relativePath ? `${relativePath}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) throw new Error(`核心文件不能使用符号链接：${path}`)
      if (entry.isDirectory()) {
        await visit(path)
      } else if (entry.isFile()) {
        if (ignoreRootManifest && path === MANIFEST_FILENAME) continue
        const expected = manifest.files[path]
        if (!expected) throw new Error(`核心目录存在清单外的文件：${path}`)
        paths.push(path)
        remaining.delete(path)
      } else {
        throw new Error(`核心目录包含不支持的文件类型：${path}`)
      }
    }
  }
  await visit('')
  if (remaining.size > 0) {
    throw new Error(`核心目录缺少文件：${String(remaining.values().next().value)}`)
  }
  let completed = 0
  await forEachBounded(paths, async path => {
    checkAbort(signal)
    const absolute = join(rootDirectory, path)
    const expected = manifest.files[path]!
    const info = await lstatPhysical(absolute)
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size !== expected.size ||
      (await digestFile(absolute, info.size, signal)) !== expected.sha256 ||
      (process.platform !== 'win32' && expected.executable === true && (info.mode & 0o111) === 0)
    ) {
      throw new Error(`核心文件完整性校验失败：${path}`)
    }
    onVerified?.(++completed)
  })
}

async function verifyQuickEntry(
  bundleDirectory: string,
  manifest: RuntimeBundleManifest,
): Promise<void> {
  await directoryExists(bundleDirectory)
  if (manifest.archive !== undefined) {
    const archivePath = join(bundleDirectory, manifest.archive)
    const expected = manifest.files[manifest.archive]!
    const info = await lstatPhysical(archivePath)
    if (!info.isFile() || info.isSymbolicLink() || info.size !== expected.size) {
      throw new Error(`核心文件完整性校验失败：${manifest.archive}`)
    }
    return
  }
  const payloadDir = join(bundleDirectory, 'payload')
  await directoryExists(payloadDir)
  const entryPath = join(payloadDir, manifest.entry)
  const expected = manifest.files[manifest.entry]!
  const info = await lstatPhysical(entryPath)
  if (!info.isFile() || info.isSymbolicLink() || info.size !== expected.size) {
    throw new Error(`核心文件完整性校验失败：${manifest.entry}`)
  }
}

async function checkDataVersion(mydshHome: string, expected: number): Promise<void> {
  try {
    const value: unknown = JSON.parse(
      await readFile(join(mydshHome, 'data', 'format.json'), 'utf8'),
    )
    if (!isRecord(value) || !Number.isSafeInteger(value.schemaVersion)) {
      throw new Error('MyDSH 数据格式标记无效。')
    }
    if (value.schemaVersion !== expected) {
      throw new Error(
        `MyDSH 数据格式为 ${String(value.schemaVersion)}，此核心仅支持 ${String(expected)}。请使用匹配的应用版本。`,
      )
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function prepareUserDirectories(mydshHome: string, schemaVersion: number): Promise<void> {
  await Promise.all(
    ['plugins', 'data', 'config', 'conversions', 'cache'].map(name =>
      ensureDirectory(join(mydshHome, name)),
    ),
  )
  const marker = join(mydshHome, 'data', 'format.json')
  try {
    await lstat(marker)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const temporaryMarker = join(mydshHome, 'data', `.format-${randomUUID()}`)
    try {
      await writeFile(temporaryMarker, `${JSON.stringify({ schemaVersion })}\n`, {
        flag: 'wx',
        mode: 0o600,
      })
      await rename(temporaryMarker, marker)
    } finally {
      await rm(temporaryMarker, { force: true })
    }
  }
  await checkDataVersion(mydshHome, schemaVersion)
}

/**
 * 清理旧版本安装器在 `~/.mydsh/runtime` 下遗留的带回执核心副本与待删暂存目录。
 * 无 `.mydsh-install.json` 回执的用户自建目录原样保留；若目录最终腾空则移除空壳 `runtime/`。
 */
export async function pruneStaleRuntimes(
  runtimeRoot: string,
  keepVersion = '',
  signal?: AbortSignal,
): Promise<readonly string[]> {
  if (!(await directoryExists(runtimeRoot))) return []
  const pruned: string[] = []
  for (const entry of await readdir(runtimeRoot, { withFileTypes: true })) {
    checkAbort(signal)
    if (!entry.isDirectory() || entry.name === keepVersion) continue
    const target = join(runtimeRoot, entry.name)
    if (entry.name.startsWith(TRASH_PREFIX) || entry.name.startsWith('.install-')) {
      await rm(target, { recursive: true, force: true }).catch(() => undefined)
      continue
    }
    if (entry.name.startsWith('.')) continue
    const hasReceipt = await lstat(join(target, INSTALL_RECEIPT)).then(
      info => info.isFile() && !info.isSymbolicLink(),
      () => false,
    )
    if (!hasReceipt) continue
    const trashed = join(runtimeRoot, `${TRASH_PREFIX}${entry.name}`)
    try {
      await rename(target, trashed)
      await rm(trashed, { recursive: true, force: true })
      pruned.push(entry.name)
    } catch {
      console.warn(`旧版本核心残留暂无法清理，下次启动继续收尾：${entry.name}`)
    }
  }
  const leftovers = await readdir(runtimeRoot).catch(() => ['keep'])
  if (leftovers.length === 0) {
    await rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined)
  }
  return pruned
}

/**
 * 校验随包核心与本机架构匹配、核对用户数据格式门禁并准备 `~/.mydsh` 用户目录，返回就地只读运行入口。
 * @throws 平台/架构不匹配、数据格式版本不兼容、核心损坏或收到取消信号时抛出中文错误。
 */
export async function ensureRuntimeInstalled(
  options: RuntimeInstallOptions,
): Promise<InstalledRuntime> {
  const { signal, onProgress } = options
  checkAbort(signal)
  const manifest = parseRuntimeBundleManifest(
    JSON.parse(await readFile(join(options.bundleDirectory, MANIFEST_FILENAME), 'utf8')),
  )
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) {
    throw new Error('核心安装包的平台或架构与此应用不匹配，请重新安装对应版本。')
  }
  const mydshHome = resolveMydshHome(options.mydshHome)
  const total = Object.keys(manifest.files).length
  onProgress?.({ phase: 'checking', completed: 0, total, message: '正在检查 MyDSH 核心…' })

  await checkDataVersion(mydshHome, manifest.dataSchemaVersion)
  if (options.verifyIntegrity === true) {
    const rootDirectory =
      manifest.archive === undefined
        ? join(options.bundleDirectory, 'payload')
        : options.bundleDirectory
    await verifyPhysicalTree({
      rootDirectory,
      manifest,
      ignoreRootManifest: manifest.archive !== undefined,
      ...(signal === undefined ? {} : { signal }),
      onVerified: completed => {
        onProgress?.({ phase: 'verifying', completed, total, message: '正在校验 MyDSH 核心…' })
      },
    })
  } else {
    await verifyQuickEntry(options.bundleDirectory, manifest)
  }

  checkAbort(signal)
  await ensureDirectory(mydshHome)
  await prepareUserDirectories(mydshHome, manifest.dataSchemaVersion)
  await pruneStaleRuntimes(join(mydshHome, 'runtime'), '', signal)

  const runtimeDirectory = join(options.bundleDirectory, manifest.archive ?? 'payload')
  onProgress?.({ phase: 'ready', completed: total, total, message: 'MyDSH 核心已就绪。' })
  return {
    mydshHome,
    runtimeDirectory,
    entryPath: join(runtimeDirectory, manifest.entry),
    manifest,
    installed: false,
  }
}
