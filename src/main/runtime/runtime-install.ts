import { renameWithRetry as rename } from '../../runtime/filesystem/file-operations.ts'
/**
 * 将应用自带核心安装到 MyDSH 独立目录，不连接网络，也不调用系统包管理器。
 * 调用方须先取得应用单实例锁，并在本函数完成后才启动 Runtime。
 * 核心目录只放代码；配置和会话放在同级目录，修复核心不会覆盖用户数据。
 * 安装或复用成功后清理其他版本的核心目录；应用只加载清单指定的版本，旧目录无人引用。
 */
/* eslint-disable no-await-in-loop -- 顺序处理限制文件句柄数量，并保证取消、替换和恢复的先后关系。 */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type {
  RuntimeBundleFile,
  RuntimeBundleManifest,
  RuntimeInstallProgress,
} from '../../shared/runtime-install.ts'
import { isRecord } from '../../shared/validation.ts'

const INSTALL_RECEIPT = '.mydsh-install.json'
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const TRASH_PREFIX = '.trash-'

export interface RuntimeInstallOptions {
  /** 该目录包含 manifest.json 和已展开的 payload/，不能位于用户数据目录。 */
  bundleDirectory: string
  mydshHome?: string
  signal?: AbortSignal
  onProgress?: (progress: RuntimeInstallProgress) => void
}

export interface InstalledRuntime {
  mydshHome: string
  runtimeDirectory: string
  entryPath: string
  manifest: RuntimeBundleManifest
  /** false 表示复用了已通过完整性校验的相同版本。 */
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

/** 仅接受跨平台一致的相对路径，避免清单通过路径穿越写到安装目录之外。 */
export function parseRuntimeBundleManifest(value: unknown): RuntimeBundleManifest {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.apiVersion !== 1 ||
    typeof value.version !== 'string' ||
    !VERSION_PATTERN.test(value.version) ||
    !validRelativePath(value.entry) ||
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
  const files: Record<string, RuntimeBundleFile> = Object.create(null) as Record<
    string,
    RuntimeBundleFile
  >
  const portablePaths = new Set<string>()
  for (const [path, file] of Object.entries(value.files)) {
    const portable = path.toLowerCase()
    if (value.platform === 'win32' && portablePaths.has(portable))
      throw new Error('Windows 核心路径存在大小写冲突：' + path)
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
  if (!files[value.entry]) throw new Error('核心安装清单缺少启动入口。')
  return {
    schemaVersion: 1,
    ...(value.platform === undefined
      ? {}
      : { platform: value.platform as string, arch: value.arch as string }),
    version: value.version,
    apiVersion: 1,
    entry: value.entry,
    dataSchemaVersion: value.dataSchemaVersion as number,
    files,
  }
}

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
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(`核心安装路径必须是实际目录：${path}`)
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

async function digest(path: string, size: number, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  // 小文件直接读取，避免为近两万个模块分别建立异步流；并发数限制内存占用。
  if (size <= 1024 * 1024) {
    const bytes = await readFile(path, signal ? { signal } : {})
    checkAbort(signal)
    return hash.update(bytes).digest('hex')
  }
  const stream = createReadStream(path, signal ? { signal } : {})
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

/** 出错或取消后等待正在执行的工作结束，再交给调用方回滚与清理。 */
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

/** 禁止链接及清单外的文件，防止加载未校验的依赖或安装目录之外的代码。 */
async function verifyTree(
  directory: string,
  manifest: RuntimeBundleManifest,
  signal?: AbortSignal,
  onVerified?: (completed: number) => void,
): Promise<void> {
  const remaining = new Set(Object.keys(manifest.files))
  const paths: string[] = []
  async function visit(relative: string): Promise<void> {
    checkAbort(signal)
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) throw new Error(`核心文件不能使用符号链接：${path}`)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) {
        if (path === INSTALL_RECEIPT) continue
        const expected = manifest.files[path]
        if (!expected) throw new Error(`核心目录存在清单外的文件：${path}`)
        paths.push(path)
        remaining.delete(path)
      } else throw new Error(`核心目录包含不支持的文件类型：${path}`)
    }
  }
  await visit('')
  if (remaining.size) throw new Error(`核心目录缺少文件：${remaining.values().next().value}`)
  let completed = 0
  await forEachBounded(paths, async path => {
    checkAbort(signal)
    const absolute = join(directory, path)
    const expected = manifest.files[path]!
    const info = await lstat(absolute)
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size !== expected.size ||
      (await digest(absolute, info.size, signal)) !== expected.sha256 ||
      (process.platform !== 'win32' && expected.executable === true && (info.mode & 0o111) === 0)
    ) {
      throw new Error(`核心文件完整性校验失败：${path}`)
    }
    onVerified?.(++completed)
  })
}

/** 数据格式版本独立于应用版本，旧应用不能打开由新核心升级后的数据。 */
async function checkDataVersion(mydshHome: string, expected: number): Promise<void> {
  try {
    const value: unknown = JSON.parse(
      await readFile(join(mydshHome, 'data', 'format.json'), 'utf8'),
    )
    if (!isRecord(value) || !Number.isSafeInteger(value.schemaVersion))
      throw new Error('MyDSH 数据格式标记无效。')
    if (value.schemaVersion !== expected) {
      throw new Error(
        `MyDSH 数据格式为 ${String(value.schemaVersion)}，此核心仅支持 ${expected}。请使用匹配的应用版本。`,
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

/** 上次原子切换中断时先恢复旧核心，再清理暂存；不能把旧核心随临时文件一并删除。 */
async function recoverInterruptedInstalls(runtimeRoot: string): Promise<void> {
  for (const entry of await readdir(runtimeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('.')) continue
    const staging = join(runtimeRoot, entry.name)
    if (entry.name.startsWith(TRASH_PREFIX)) {
      // 上次清理中途退出留下的待删目录没有恢复价值，按本模块拥有的前缀直接收尾。
      await rm(staging, { recursive: true, force: true })
      continue
    }
    if (!entry.name.startsWith('.install-')) continue
    const previous = join(staging, 'previous')
    if (await directoryExists(previous)) {
      // 恢复信息在移动旧目录之前写入，不能依赖可能已经损坏的旧核心收据。
      const receipt = parseRuntimeBundleManifest(
        JSON.parse(await readFile(join(staging, 'manifest.json'), 'utf8')),
      )
      const original = join(runtimeRoot, receipt.version)
      if (!(await directoryExists(original))) await rename(previous, original)
    }
    await rm(staging, { recursive: true, force: true })
  }
}

/**
 * 应用只加载清单指定的版本；跨版本升级后旧核心目录已无人引用，不清除就只能累积磁盘占用。
 * 只清理带本模块安装回执的目录，探测不到回执的陌生内容一律保留。
 * 先原子改名为待删标记再递归删除：删除中途退出时残留不再顶着版本名，恢复逻辑按前缀收走。
 */
export async function pruneStaleRuntimes(
  runtimeRoot: string,
  currentVersion: string,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  const pruned: string[] = []
  for (const entry of await readdir(runtimeRoot, { withFileTypes: true })) {
    checkAbort(signal)
    // 版本目录以字母数字开头；点前缀目录属于本模块的暂存与待删标记，交给恢复逻辑处理。
    if (!entry.isDirectory() || entry.name === currentVersion || entry.name.startsWith('.'))
      continue
    const directory = join(runtimeRoot, entry.name)
    try {
      // 只认安装回执的存在性：回执内容随清单演进，存在即证明由本安装器写入过完整核心。
      await lstat(join(directory, INSTALL_RECEIPT))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        console.warn('跳过无法确认来源的核心目录：' + entry.name)
      continue
    }
    try {
      await rename(directory, join(runtimeRoot, TRASH_PREFIX + entry.name))
    } catch {
      console.warn('旧版本核心目录暂时无法清理，下次启动重试：' + entry.name)
      continue
    }
    try {
      await rm(join(runtimeRoot, TRASH_PREFIX + entry.name), { recursive: true, force: true })
    } catch {
      console.warn('旧版本核心目录删除未完成，下次启动收尾：' + entry.name)
      continue
    }
    pruned.push(entry.name)
  }
  return pruned
}

/**
 * 只认应用附带清单指定的版本，不扫描并自动选择所谓最新版本。
 * 所有复制发生在临时目录，校验成功后原子切换；失败或取消保留原核心。
 */
export async function ensureRuntimeInstalled(
  options: RuntimeInstallOptions,
): Promise<InstalledRuntime> {
  const { signal, onProgress } = options
  checkAbort(signal)
  const manifest = parseRuntimeBundleManifest(
    JSON.parse(await readFile(join(options.bundleDirectory, 'manifest.json'), 'utf8')),
  )
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) {
    throw new Error('核心安装包的平台或架构与此应用不匹配，请重新安装对应版本。')
  }
  const mydshHome = resolveMydshHome(options.mydshHome)
  const runtimeRoot = join(mydshHome, 'runtime')
  const runtimeDirectory = join(runtimeRoot, manifest.version)
  const total = Object.keys(manifest.files).length
  let previousPhase: RuntimeInstallProgress['phase'] | undefined
  let previousNotification = -Infinity
  const notify = (
    phase: RuntimeInstallProgress['phase'],
    completed: number,
    message: string,
  ): void => {
    const now = performance.now()
    // 安装进度最多每 100ms 更新一次；仍然发送每个阶段的开始与完成。
    if (phase === previousPhase && completed !== total && now - previousNotification < 100) return
    previousPhase = phase
    previousNotification = now
    onProgress?.({ phase, completed, total, message })
  }
  const result = (installed: boolean): InstalledRuntime => ({
    mydshHome,
    runtimeDirectory,
    entryPath: join(runtimeDirectory, manifest.entry),
    manifest,
    installed,
  })
  notify('checking', 0, '正在检查 MyDSH 核心…')
  await checkDataVersion(mydshHome, manifest.dataSchemaVersion)
  await ensureDirectory(mydshHome)
  await ensureDirectory(runtimeRoot)

  // 单实例锁保证没有其他安装器使用这些暂存目录；只清理本模块拥有的名称。
  await recoverInterruptedInstalls(runtimeRoot)
  const existed = await directoryExists(runtimeDirectory)
  if (existed) {
    try {
      const receipt: unknown = JSON.parse(
        await readFile(join(runtimeDirectory, INSTALL_RECEIPT), 'utf8'),
      )
      if (JSON.stringify(parseRuntimeBundleManifest(receipt)) !== JSON.stringify(manifest))
        throw new Error('核心安装记录与应用清单不一致。')
      await verifyTree(runtimeDirectory, manifest, signal, completed =>
        notify('checking', completed, '正在检查 MyDSH 核心…'),
      )
      await prepareUserDirectories(mydshHome, manifest.dataSchemaVersion)
      await pruneStaleRuntimes(runtimeRoot, manifest.version, signal)
      notify('ready', total, 'MyDSH 核心已就绪。')
      return result(false)
    } catch {
      // 已安装代码损坏时，从应用自带的完整副本恢复；取消必须立即退出。
      checkAbort(signal)
    }
  }

  const staging = await mkdtemp(join(runtimeRoot, '.install-'))
  const candidate = join(staging, 'candidate')
  const previous = join(staging, 'previous')
  let movedPrevious = false
  let committed = false
  try {
    await mkdir(candidate, { mode: 0o700 })
    const source = join(options.bundleDirectory, 'payload')
    await directoryExists(source)
    // 先检查源目录，不能通过清单内路径的父目录链接越过 payload 边界。
    await verifyTree(source, manifest, signal, completed =>
      notify('checking', completed, '正在检查应用自带的 MyDSH 核心…'),
    )
    let completed = 0
    const parentDirectories = new Map<string, Promise<void>>()
    await forEachBounded(Object.entries(manifest.files), async ([path, file]) => {
      checkAbort(signal)
      const destination = join(candidate, path)
      const parent = dirname(destination)
      let created = parentDirectories.get(parent)
      if (!created) {
        created = mkdir(parent, { recursive: true, mode: 0o755 }).then(() => {})
        parentDirectories.set(parent, created)
      }
      await created
      checkAbort(signal)
      await copyFile(join(source, path), destination)
      if (process.platform !== 'win32') await chmod(destination, file.executable ? 0o755 : 0o644)
      notify('installing', ++completed, '正在安装应用自带的 MyDSH 核心…')
    })
    await verifyTree(candidate, manifest, signal, verified =>
      notify('verifying', verified, '正在校验已安装的 MyDSH 核心…'),
    )
    await writeFile(join(candidate, INSTALL_RECEIPT), `${JSON.stringify(manifest)}\n`, {
      mode: 0o644,
    })
    await prepareUserDirectories(mydshHome, manifest.dataSchemaVersion)
    checkAbort(signal)
    if (existed) {
      await writeFile(join(staging, 'manifest.json'), `${JSON.stringify(manifest)}\n`, {
        mode: 0o600,
      })
      await rename(runtimeDirectory, previous)
      movedPrevious = true
    }
    try {
      await rename(candidate, runtimeDirectory)
      committed = true
    } catch (error) {
      if (movedPrevious) await rename(previous, runtimeDirectory)
      throw error
    }
    await pruneStaleRuntimes(runtimeRoot, manifest.version, signal)
    notify('ready', total, 'MyDSH 核心已就绪。')
    return result(true)
  } finally {
    // 原子替换未完成且旧目录无法恢复时保留它，避免清理路径删除最后的可用版本。
    if (!movedPrevious || committed || (await directoryExists(runtimeDirectory))) {
      await rm(staging, { recursive: true, force: true })
    }
  }
}
