import { renameWithRetry as rename } from '../filesystem/file-operations.ts'
import type { Context, Fiber, Plugin } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { realpath as fsRealpath } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import {
  requirePluginId,
  type MydshPluginInfo,
  type MydshPluginManifest,
  type MydshPluginServicesConfig,
} from './contracts.ts'
import { atomicJson, copyPlugin, pluginFile, readManifest } from './files.ts'

type PluginRecord = Omit<MydshPluginInfo, 'running'>
const realpath = promisify(fsRealpath.native)
const pathKey = (value: string): string =>
  process.platform === 'win32' ? value.toLowerCase() : value

/** 插件版本在暂存区准备，只有成功装配后才切换持久清单；所有写操作串行。 */
export class MydshPluginManager {
  private readonly records = new Map<string, PluginRecord>()
  private readonly fibers = new Map<string, Fiber>()
  /** 纯前端插件没有后台 fiber；此集合只标记已激活版本的资源可读状态。 */
  private readonly activeFrontend = new Set<string>()
  private queue: Promise<unknown> = Promise.resolve()
  private closing = false
  private releaseStatus: (() => void) | undefined

  constructor(
    private readonly ctx: Context,
    private readonly config: MydshPluginServicesConfig,
  ) {}

  private get indexFile(): string {
    return path.join(this.config.home, 'config', 'plugins.json')
  }
  private get pluginDirectory(): string {
    return path.join(this.config.home, 'plugins')
  }

  async initialize(): Promise<void> {
    await mkdir(this.pluginDirectory, { recursive: true })
    this.releaseStatus = this.ctx.on('internal/status', fiber => {
      for (const [id, owned] of this.fibers) {
        const item = this.records.get(id)
        if (owned.uid !== fiber.uid || !item) continue
        if (item.status !== 'pending')
          item.status = fiber.state === 2 ? 'active' : fiber.state === 3 ? 'error' : 'waiting'
        this.config.onChange?.()
      }
    })
    let state: { version: number; plugins: PluginRecord[] } = { version: 1, plugins: [] }
    try {
      state = JSON.parse(await readFile(this.indexFile, 'utf8')) as typeof state
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (state.version !== 1 || !Array.isArray(state.plugins))
      throw new Error('插件索引版本不受支持。')
    for (const saved of state.plugins) {
      try {
        requirePluginId(saved.id)
        // 不信任清单中的绝对路径，始终由标识和版本重新确定安装位置。
        const version = saved.pending?.action === 'update' ? saved.pending.version : saved.version
        if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
          throw new Error('插件索引包含无效版本。')
        const directory = path.join(this.pluginDirectory, saved.id, version)
        const manifest = await readManifest(directory)
        if (manifest.id !== saved.id || manifest.version !== version)
          throw new Error('插件清单与安装索引不一致。')
        const enabled =
          saved.pending?.action === 'enable'
            ? true
            : saved.pending?.action === 'disable'
              ? false
              : saved.enabled
        if (saved.pending?.action === 'uninstall') {
          await rm(path.join(this.pluginDirectory, saved.id), { recursive: true, force: true })
          continue
        }
        this.records.set(saved.id, {
          ...manifest,
          source: 'user',
          enabled,
          status: 'disabled',
          directory,
          ...(saved.previousVersion ? { previousVersion: saved.previousVersion } : {}),
          ...(saved.pending?.action === 'update' ? { previousVersion: saved.version } : {}),
        })
      } catch (error) {
        // 损坏的用户扩展留在管理列表，不让缺失入口中止整个核心启动。
        requirePluginId(saved.id)
        this.records.set(saved.id, {
          ...saved,
          source: 'user',
          status: 'error',
          error: errorMessage(error),
          directory: path.join(this.pluginDirectory, saved.id, saved.version),
        })
      }
    }
    // 依赖图先排序；一处扩展失败不阻止工作台启动和管理页修复。
    const pending = [...this.records.values()].filter(item => item.enabled)
    const attempted = new Set<string>()
    const start = async (item: PluginRecord): Promise<void> => {
      if (attempted.has(item.id)) return
      attempted.add(item.id)
      for (const id of Object.keys(item.dependencies ?? {})) {
        const dependency = this.records.get(id)
        if (dependency?.enabled) await start(dependency)
      }
      try {
        await this.activate(item)
      } catch (error) {
        item.status = 'error'
        item.error = errorMessage(error)
        if (
          item.previousVersion &&
          state.plugins.find(saved => saved.id === item.id)?.pending?.action === 'update'
        ) {
          try {
            const directory = path.join(this.pluginDirectory, item.id, item.previousVersion)
            const restored: PluginRecord = {
              ...(await readManifest(directory)),
              source: 'user',
              enabled: true,
              status: 'disabled',
              directory,
            }
            await this.activate(restored)
            restored.error = `升级未生效，已恢复上一版本：${errorMessage(error)}`
            this.records.set(restored.id, restored)
          } catch (restoreError) {
            item.error += `；恢复失败：${errorMessage(restoreError)}`
          }
        }
      }
    }
    for (const item of pending) await start(item)
    await this.persist()
  }

  list(): MydshPluginInfo[] {
    return [
      ...(this.config.builtin ?? []).map(item =>
        structuredClone({
          ...item,
          running: item.running ?? (item.enabled && item.status === 'active'),
        }),
      ),
      ...[...this.records.values()].map(item => this.snapshot(item)),
    ]
  }

  /** pending 只说明下一次操作；可读资源取决于当前版本实际拥有的生命周期。 */
  private snapshot(item: PluginRecord): MydshPluginInfo {
    return structuredClone({
      ...item,
      running: item.backend
        ? this.fibers.get(item.id)?.state === 2
        : this.activeFrontend.has(item.id),
    })
  }

  install(sourceDirectory: string): Promise<MydshPluginInfo> {
    return this.serial(async () => {
      const source = await realpath(sourceDirectory)
      const manifest = await readManifest(source)
      if ((this.config.builtin ?? []).some(item => item.id === manifest.id))
        throw new Error('不能用用户插件覆盖内置核心插件。')
      const previous = this.records.get(manifest.id)
      if (previous?.version === manifest.version)
        throw new Error('此版本已安装，请使用新版本号发布修改。')
      if (previous?.status === 'pending')
        throw new Error('此插件存在待重启操作，请先重新启动应用。')
      this.checkDependencies(manifest)
      const reason = previous?.enabled ? await this.busyReason(previous.id) : undefined
      const parent = path.join(this.pluginDirectory, manifest.id)
      if (pathKey(parent).startsWith(`${pathKey(source)}${path.sep}`))
        throw new Error('安装来源不能包含插件安装目录。')
      const temporary = path.join(parent, `.candidate-${randomUUID()}`)
      const destination = path.join(parent, manifest.version)
      await mkdir(parent, { recursive: true })
      try {
        await copyPlugin(source, temporary)
        await readManifest(temporary)
        await rename(temporary, destination)
      } finally {
        await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
      const candidate: PluginRecord = {
        ...manifest,
        source: 'user',
        enabled: previous?.enabled ?? true,
        status: 'disabled',
        directory: destination,
        ...(previous ? { previousVersion: previous.version } : {}),
      }
      if (previous && reason) {
        previous.pending = { action: 'update', version: manifest.version }
        previous.status = 'pending'
        previous.error = reason
        await this.persist()
        return this.snapshot(previous)
      }
      if (previous) {
        try {
          await this.deactivate(previous)
        } catch (error) {
          previous.pending = { action: 'update', version: manifest.version }
          previous.status = 'pending'
          previous.error = errorMessage(error)
          await this.persist()
          return this.snapshot(previous)
        }
      }
      try {
        if (candidate.enabled) await this.activate(candidate)
        this.records.set(candidate.id, candidate)
        await this.persist()
        return this.snapshot(candidate)
      } catch (error) {
        await this.deactivate(candidate).catch(() => {})
        await rm(destination, { recursive: true, force: true })
        if (previous) {
          this.records.set(previous.id, previous)
          if (previous.enabled)
            await this.activate(previous).catch(failure => {
              previous.status = 'error'
              previous.error = errorMessage(failure)
            })
        } else this.records.delete(candidate.id)
        await this.persist()
        throw new Error(`插件安装失败，已保留原版本：${errorMessage(error)}`, { cause: error })
      }
    })
  }

  update(sourceDirectory: string): Promise<MydshPluginInfo> {
    return this.install(sourceDirectory)
  }

  enable(id: string): Promise<MydshPluginInfo> {
    return this.serial(async () => {
      const item = this.requireUser(id)
      if (item.status === 'pending') throw new Error('此插件存在待重启操作，请先重新启动应用。')
      this.checkDependencies(item)
      try {
        await this.activate(item)
        item.enabled = true
        await this.persist()
        return this.snapshot(item)
      } catch (error) {
        item.status = 'error'
        item.error = errorMessage(error)
        await this.persist()
        throw error
      }
    })
  }

  disable(id: string): Promise<MydshPluginInfo> {
    return this.serial(async () => {
      const item = this.requireUser(id)
      const reason = await this.busyReason(id)
      if (reason) {
        item.pending = { action: 'disable' }
        item.status = 'pending'
        item.error = reason
      } else {
        try {
          await this.deactivate(item)
          item.enabled = false
          delete item.pending
          delete item.error
        } catch {
          item.pending = { action: 'disable' }
        }
      }
      await this.persist()
      return this.snapshot(item)
    })
  }

  uninstall(id: string): Promise<void> {
    return this.serial(async () => {
      const item = this.requireUser(id)
      const reason = await this.busyReason(id)
      if (reason) {
        item.pending = { action: 'uninstall' }
        item.status = 'pending'
        item.error = reason
        await this.persist()
        return
      }
      try {
        await this.deactivate(item)
      } catch {
        item.pending = { action: 'uninstall' }
        await this.persist()
        return
      }
      this.records.delete(id)
      await this.persist()
      await rm(path.join(this.pluginDirectory, id), { recursive: true, force: true })
    })
  }

  rollback(id: string): Promise<MydshPluginInfo> {
    return this.serial(async () => {
      const current = this.requireUser(id)
      if (!current.previousVersion) throw new Error('此插件没有可以恢复的上一版本。')
      const directory = path.join(this.pluginDirectory, id, current.previousVersion)
      const manifest = await readManifest(directory)
      this.checkDependencies(manifest)
      const reason = await this.busyReason(id)
      if (reason) {
        current.pending = { action: 'update', version: manifest.version }
        current.status = 'pending'
        current.error = reason
        await this.persist()
        return this.snapshot(current)
      }
      const replacement: PluginRecord = {
        ...manifest,
        source: 'user',
        enabled: current.enabled,
        status: 'disabled',
        directory,
        previousVersion: current.version,
      }
      await this.deactivate(current)
      try {
        if (replacement.enabled) await this.activate(replacement)
      } catch (error) {
        if (current.enabled) await this.activate(current)
        throw error
      }
      this.records.set(id, replacement)
      await this.persist()
      return this.snapshot(replacement)
    })
  }

  async dispose(): Promise<void> {
    this.closing = true
    this.releaseStatus?.()
    await this.queue.catch(() => {})
    const failures: unknown[] = []
    for (const item of [...this.records.values()].toReversed()) {
      try {
        await this.deactivate(item)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length) throw new AggregateError(failures, '部分插件未能完成资源清理。')
  }

  private async activate(item: PluginRecord): Promise<void> {
    if (this.fibers.has(item.id)) return
    this.checkDependencies(item)
    if (item.backend) {
      const module = (await import(
        pathToFileURL(await pluginFile(item.directory, item.backend)).href
      )) as { default?: Plugin; apply?: Plugin.Function; inject?: string[] }
      const plugin = module.default ?? (module as Plugin)
      // 数据目录由宿主确定，清单不能借初始配置把 home 指向核心或其他插件。
      const config = {
        ...item.config,
        home: path.join(this.config.home, 'data', 'plugins', item.id),
      }
      const reflection = await this.readReflection(item)
      // 生成契约与业务入口属于同一个父 fiber，停用或启动失败时一起释放。
      const fiber = reflection
        ? this.ctx.plugin({
            name: `mydsh-plugin-${item.id}`,
            inject: ['typert'],
            async apply(ctx: Context) {
              ctx.get('typert').register(reflection)
              await ctx.plugin(plugin, config)
            },
          })
        : this.ctx.plugin(plugin, config)
      this.fibers.set(item.id, fiber)
      try {
        await fiber.await()
      } catch (error) {
        await fiber.dispose()
        this.fibers.delete(item.id)
        throw error
      }
      item.status = fiber.state === 2 ? 'active' : 'waiting'
    } else {
      this.activeFrontend.add(item.id)
      item.status = 'active'
    }
    delete item.error
  }

  private async readReflection(item: PluginRecord): Promise<unknown | undefined> {
    let manifest: { name?: string; exports?: Record<string, { default?: string }> }
    try {
      manifest = JSON.parse(
        await readFile(path.join(item.directory, 'package.json'), 'utf8'),
      ) as typeof manifest
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const entry = manifest.exports?.['./typert']?.default
    if (!entry) return undefined
    if (!this.ctx.get('typert')) throw new Error('此插件需要 Typert 服务，当前运行核心尚未就绪。')
    const artifact = (await import(
      pathToFileURL(await pluginFile(item.directory, entry)).href
    )) as { TYPERT?: { package?: string; face?: string } }
    if (
      !artifact.TYPERT ||
      artifact.TYPERT.package !== manifest.name ||
      artifact.TYPERT.face !== 'host'
    )
      throw new Error('插件生成的 Typert 契约与包身份不一致。')
    return artifact.TYPERT
  }

  private async deactivate(item: PluginRecord): Promise<void> {
    const fiber = this.fibers.get(item.id)
    if (fiber) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          fiber.dispose(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('插件清理超过 5 秒，需要重启完成。')), 5000)
          }),
        ])
        this.fibers.delete(item.id)
      } catch (error) {
        item.status = 'pending'
        item.error = `资源释放失败，需要重启：${errorMessage(error)}`
        throw error
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
    this.activeFrontend.delete(item.id)
    item.status = 'disabled'
  }

  private checkDependencies(manifest: MydshPluginManifest): void {
    for (const [id, version] of Object.entries(manifest.dependencies ?? {})) {
      const item = this.records.get(id) ?? this.config.builtin?.find(plugin => plugin.id === id)
      if (!item || !item.enabled || !['active', 'waiting'].includes(item.status))
        throw new Error(`请先启用依赖插件：${id}`)
      if (version !== '*' && item.version !== version)
        throw new Error(`依赖插件 ${id} 需要版本 ${version}，当前是 ${item.version}。`)
    }
  }

  private async busyReason(id: string): Promise<string | undefined> {
    const dependents = [...this.records.values()].filter(
      item => item.id !== id && item.enabled && id in (item.dependencies ?? {}),
    )
    if (dependents.length)
      throw new Error(`请先停用依赖此插件的扩展：${dependents.map(item => item.name).join('、')}`)
    return this.config.isBusy?.(id)
  }

  private requireUser(id: string): PluginRecord {
    requirePluginId(id)
    if (this.config.builtin?.some(item => item.id === id))
      throw new Error('核心插件随运行核心管理，不能通过扩展操作修改。')
    const item = this.records.get(id)
    if (!item) throw new Error('找不到此插件。')
    return item
  }

  private persist(): Promise<void> {
    const plugins = [...this.records.values()].map(item => {
      const { running: _running, ...record } = item as MydshPluginInfo
      return record
    })
    return atomicJson(this.indexFile, { version: 1, plugins }).then(() => this.config.onChange?.())
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('运行时正在退出，不能更改插件。'))
    const pending = this.queue.then(operation)
    this.queue = pending.catch(() => {})
    return pending
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
