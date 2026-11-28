import { randomUUID } from 'node:crypto'
import {
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import {
  MYDSH_PLUGIN_VERSION,
  requirePluginId,
  type ConversionRecord,
  type ConversionSource,
  type MydshPluginServicesConfig,
} from './contracts.ts'
import { atomicJson, directoryDigest, pluginFile, readManifest } from './files.ts'
import type { MydshPluginManager } from './manager.ts'

const SHARED_MODULES = [
  'react',
  'react-dom',
  '@types/react',
  '@types/react-dom',
  '@deepseek-ai/cordis',
  '@mydsh/ui',
  '@mydsh/sdk',
]
const EXTERNAL_MODULES = [
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@mydsh/ui',
  '@mydsh/sdk',
]
/** Windows 普通账户没有符号链接特权，目录链接改用 junction；lstat 仍把它报告为符号链接。 */
const DIRECTORY_LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir'

/** 转换器提供材料、工具链和验证；源码重写由当前 Agent 的正常编辑工具完成。 */
export class MydshPluginConverter {
  private readonly running = new Map<string, AbortController>()
  private readonly idleWaiters = new Set<() => void>()
  private closing = false

  constructor(
    private readonly manager: MydshPluginManager,
    private readonly config: MydshPluginServicesConfig,
  ) {}

  async list(): Promise<ConversionRecord[]> {
    const root = path.join(this.config.home, 'conversions')
    await mkdir(root, { recursive: true })
    const records: ConversionRecord[] = []
    for (const id of await readdir(root)) {
      if (!/^[a-f0-9-]{36}$/.test(id)) continue
      try {
        records.push(await this.read(id))
      } catch {
        /* 未完成准备的目录不构成可继续的转换任务。 */
      }
    }
    return records.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async prepare(source: ConversionSource, signal?: AbortSignal): Promise<ConversionRecord> {
    if (this.closing) throw new Error('运行时正在退出，不能创建转换任务。')
    const id = randomUUID()
    const root = this.root(id)
    const directory = path.join(root, 'source')
    const controller = new AbortController()
    const releaseSignal = forwardAbort(signal, controller)
    this.running.set(id, controller)
    try {
      controller.signal.throwIfAborted()
      await mkdir(root, { recursive: true })
      let revision: string
      if (source.kind === 'local') {
        const origin = await realpath(source.path)
        if (!(await lstat(origin)).isDirectory()) throw new Error('转换来源必须是源码目录。')
        const conversionRoot = path.resolve(this.config.home, 'conversions')
        if (conversionRoot === origin || conversionRoot.startsWith(`${origin}${path.sep}`))
          throw new Error('源码目录不能包含 MyDSH 转换工作区。')
        await cp(origin, directory, {
          recursive: true,
          filter: async item => {
            controller.signal.throwIfAborted()
            const parts = path.relative(origin, item).split(path.sep)
            if (parts.some(part => part === '.git' || part === 'node_modules')) return false
            if ((await lstat(item)).isSymbolicLink())
              throw new Error('转换来源包含符号链接，请先准备独立源码副本。')
            return true
          },
        })
        revision = await directoryDigest(directory)
      } else if (source.kind === 'git') {
        const url = new URL(source.url)
        if (
          url.protocol !== 'https:' ||
          url.username ||
          url.password ||
          !source.ref ||
          source.ref.startsWith('-')
        )
          throw new Error('Git 来源需要无内嵌凭据的 HTTPS 地址和明确分支、标签或提交。')
        await mkdir(directory, { recursive: true })
        await this.run(
          process.env.MYDSH_GIT_EXECUTABLE ?? 'git',
          ['init', '--quiet', directory],
          root,
          controller.signal,
        )
        await this.run(
          process.env.MYDSH_GIT_EXECUTABLE ?? 'git',
          ['fetch', '--depth=1', '--', source.url, source.ref],
          directory,
          controller.signal,
        )
        revision = (
          await this.run(
            process.env.MYDSH_GIT_EXECUTABLE ?? 'git',
            ['rev-parse', 'FETCH_HEAD'],
            directory,
            controller.signal,
          )
        ).trim()
        if (!/^[a-f0-9]{40,64}$/.test(revision)) throw new Error('无法固定 Git 来源提交。')
        await this.run(
          process.env.MYDSH_GIT_EXECUTABLE ?? 'git',
          ['-c', 'advice.detachedHead=false', 'checkout', '--detach', revision],
          directory,
          controller.signal,
        )
      } else if (source.kind === 'npm') {
        if (
          !/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(source.name) ||
          !MYDSH_PLUGIN_VERSION.test(source.version)
        )
          throw new Error('npm 来源必须提供有效包名和明确版本，不能使用 latest 等标签。')
        const acquisition = path.join(root, 'acquisition')
        await mkdir(acquisition, { recursive: true })
        await atomicJson(path.join(acquisition, 'package.json'), {
          private: true,
          dependencies: { [source.name]: source.version },
        })
        await this.npm(
          ['install', '--ignore-scripts', '--no-audit', '--no-fund'],
          acquisition,
          controller.signal,
        )
        const packageDirectory = path.join(acquisition, 'node_modules', source.name)
        await cp(packageDirectory, directory, {
          recursive: true,
          filter: item =>
            !path.relative(packageDirectory, item).split(path.sep).includes('node_modules'),
        })
        const lock = JSON.parse(
          await readFile(path.join(acquisition, 'package-lock.json'), 'utf8'),
        ) as { packages?: Record<string, { integrity?: string }> }
        revision = `${source.name}@${source.version}:${lock.packages?.[`node_modules/${source.name}`]?.integrity ?? (await directoryDigest(directory))}`
        await rm(acquisition, { recursive: true, force: true })
      } else throw new Error('不支持的转换来源。')
      const record: ConversionRecord = {
        id,
        source,
        revision,
        directory,
        status: 'prepared',
        createdAt: new Date().toISOString(),
      }
      await atomicJson(path.join(root, 'task.json'), record)
      return record
    } catch (error) {
      await rm(root, { recursive: true, force: true })
      throw error
    } finally {
      releaseSignal()
      this.finish(id)
    }
  }

  async validate(id: string, signal?: AbortSignal): Promise<ConversionRecord> {
    if (this.closing || this.running.has(id))
      throw new Error('此转换任务正在执行，或运行时正在退出。')
    const record = await this.read(id)
    const controller = new AbortController()
    const releaseSignal = forwardAbort(signal, controller)
    this.running.set(id, controller)
    record.status = 'validating'
    delete record.error
    delete record.digest
    delete record.artifact
    const artifact = path.join(this.root(id), 'artifact')
    try {
      controller.signal.throwIfAborted()
      await this.save(record)
      const packageFile = await pluginFile(record.directory, 'package.json')
      const pkg = JSON.parse(await readFile(packageFile, 'utf8')) as {
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
        mydshBuild?: {
          backend?: string
          frontend?: string
          tsconfig?: string
          tsconfigBackend?: string
          tsconfigFrontend?: string
        }
      }
      if (!pkg.mydshBuild || (!pkg.mydshBuild.backend && !pkg.mydshBuild.frontend))
        throw new Error('请先重写插件，并在 package.json 的 mydshBuild 中声明后台或前端源码入口。')
      const manifestRaw = JSON.parse(
        await readFile(await pluginFile(record.directory, 'mydsh.plugin.json'), 'utf8'),
      ) as Record<string, unknown>
      if (typeof manifestRaw.id !== 'string') throw new Error('请先提供有效的 MyDSH 插件清单。')
      requirePluginId(manifestRaw.id)
      const inputs = { ...pkg.mydshBuild }
      const backend = inputs.backend
        ? await pluginFile(record.directory, inputs.backend)
        : undefined
      const frontend = inputs.frontend
        ? await pluginFile(record.directory, inputs.frontend)
        : undefined
      const backendConfig = inputs.tsconfigBackend ?? inputs.tsconfig ?? 'tsconfig.json'
      const frontendConfig = inputs.tsconfigFrontend ?? inputs.tsconfig ?? 'tsconfig.json'
      const configs = await Promise.all(
        [
          ...new Set([...(backend ? [backendConfig] : []), ...(frontend ? [frontendConfig] : [])]),
        ].map(file => pluginFile(record.directory, file)),
      )
      await this.prepareDependencies(
        record,
        { ...pkg.dependencies, ...pkg.devDependencies },
        controller.signal,
      )
      const unpackedToolchain = this.unpackedToolchainDirectory()
      for (const tsconfig of configs)
        await this.node(
          path.join(unpackedToolchain, 'node_modules/typescript/bin/tsc'),
          ['--project', tsconfig, '--noEmit'],
          record.directory,
          controller.signal,
        )
      await rm(artifact, { recursive: true, force: true })
      await mkdir(path.join(artifact, 'dist'), { recursive: true })
      if (backend)
        await this.build(
          {
            entryPoints: [backend],
            bundle: true,
            platform: 'node',
            format: 'esm',
            target: 'node24',
            outfile: path.join(artifact, 'dist/backend.js'),
            external: EXTERNAL_MODULES,
            banner: {
              js: 'import { createRequire as __mydshCreateRequire } from "node:module"; const require = __mydshCreateRequire(import.meta.url);',
            },
          },
          record.directory,
          controller.signal,
        )
      if (frontend) {
        const output = path.join(artifact, 'dist/frontend.js')
        await this.build(
          {
            entryPoints: [frontend],
            bundle: true,
            platform: 'browser',
            format: 'cjs',
            target: 'es2022',
            outfile: output,
            external: EXTERNAL_MODULES,
          },
          record.directory,
          controller.signal,
        )
        const compiled = await readFile(output, 'utf8')
        // 同一个宿主提供共享实例，扩展脚本只登记工厂，不在注册时执行业务代码。
        await writeFile(
          output,
          `globalThis.__MYDSH_PLUGINS__.define(${JSON.stringify(manifestRaw.id)}, function(require, module, exports) {\n${compiled}\n});\n`,
        )
      }
      const generatedManifest = { ...manifestRaw }
      delete generatedManifest.backend
      delete generatedManifest.frontend
      delete generatedManifest.styles
      if (backend) generatedManifest.backend = 'dist/backend.js'
      if (frontend) generatedManifest.frontend = 'dist/frontend.js'
      try {
        if ((await lstat(path.join(artifact, 'dist/frontend.css'))).isFile())
          generatedManifest.styles = ['dist/frontend.css']
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await atomicJson(path.join(artifact, 'mydsh.plugin.json'), generatedManifest)
      let reflection: { generated: boolean; package?: string; exports?: Record<string, unknown> } =
        { generated: false }
      if (backend) {
        const unpackedRoot = this.unpackedToolchainDirectory()
        const candidates = [
          path.join(unpackedRoot, 'plugin-typert.js'),
          path.join(this.config.toolchainDirectory, 'plugin-typert.js'),
          path.join(this.config.toolchainDirectory, 'packages/runtime/plugin-typert.mjs'),
        ]
        let generator = candidates[candidates.length - 1]!
        for (const candidate of candidates) {
          const found = await lstat(candidate).then(
            () => true,
            () => false,
          )
          if (found) {
            generator = candidate
            break
          }
        }
        const result = await this.node(
          generator,
          [record.directory, artifact, this.config.toolchainDirectory, backendConfig],
          record.directory,
          controller.signal,
        )
        reflection = JSON.parse(result.trim()) as typeof reflection
      }
      await atomicJson(path.join(artifact, 'package.json'), {
        name: reflection.package ?? manifestRaw.id,
        version: manifestRaw.version,
        type: 'module',
        private: true,
        ...(reflection.generated
          ? {
              exports: {
                '.': { types: './lib/index.d.ts', default: './dist/backend.js' },
                ...reflection.exports,
              },
              files: ['dist', 'lib'],
            }
          : {}),
      })
      await readManifest(artifact)
      // 只做语法检查，不在验证阶段执行待安装的插件及其副作用。
      for (const entry of [
        backend ? 'backend.js' : undefined,
        frontend ? 'frontend.js' : undefined,
      ].filter(Boolean)) {
        await this.run(
          this.config.nodeExecutable,
          ['--check', path.join(artifact, 'dist', entry!)],
          record.directory,
          controller.signal,
          { ELECTRON_RUN_AS_NODE: '1' },
        )
      }
      await atomicJson(path.join(artifact, 'mydsh.provenance.json'), {
        source: record.source,
        revision: record.revision,
        validatedAt: new Date().toISOString(),
        validation: [
          'typescript',
          'esbuild',
          'node-syntax',
          ...(reflection.generated ? ['typert-host', 'typert-remote-client'] : []),
        ],
      })
      record.digest = `${await directoryDigest(record.directory)}:${await directoryDigest(artifact)}`
      record.artifact = artifact
      record.status = 'validated'
      await this.save(record)
      return record
    } catch (error) {
      record.status = 'failed'
      record.error = error instanceof Error ? error.message : String(error)
      await rm(artifact, { recursive: true, force: true })
      await this.save(record)
      throw error
    } finally {
      try {
        await rm(path.join(this.root(id), '.typert-workspace'), { recursive: true, force: true })
      } finally {
        releaseSignal()
        this.finish(id)
      }
      // 诊断输出只在内存中；依赖缓存可由用户清理，源码工作区继续保留。
    }
  }

  async install(id: string): Promise<ConversionRecord> {
    const record = await this.read(id)
    if (this.running.has(id) || record.status !== 'validated' || !record.digest || !record.artifact)
      throw new Error('请先完成插件验证，再安装转换产物。')
    const artifact = path.join(this.root(id), 'artifact')
    if (
      record.digest !==
      `${await directoryDigest(record.directory)}:${await directoryDigest(artifact)}`
    )
      throw new Error('源码或产物在验证后发生变化，请重新验证。')
    await this.manager.install(artifact)
    record.status = 'installed'
    await this.save(record)
    return record
  }

  cancel(id: string): void {
    this.running.get(id)?.abort(new Error('用户已取消插件转换。'))
  }

  async dispose(): Promise<void> {
    this.closing = true
    for (const controller of this.running.values()) controller.abort(new Error('运行时正在退出。'))
    if (this.running.size) await new Promise<void>(resolve => this.idleWaiters.add(resolve))
  }

  private finish(id: string): void {
    this.running.delete(id)
    if (!this.running.size) {
      for (const resolve of this.idleWaiters) resolve()
      this.idleWaiters.clear()
    }
  }

  private root(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效的转换任务标识。')
    return path.join(this.config.home, 'conversions', id)
  }

  private async read(id: string): Promise<ConversionRecord> {
    const root = this.root(id)
    const record = JSON.parse(
      await readFile(path.join(root, 'task.json'), 'utf8'),
    ) as ConversionRecord
    if (record.id !== id) throw new Error('转换任务记录不一致。')
    record.directory = path.join(root, 'source')
    if (record.artifact) record.artifact = path.join(root, 'artifact')
    return record
  }

  private save(record: ConversionRecord): Promise<void> {
    return atomicJson(path.join(this.root(record.id), 'task.json'), record)
  }

  private async prepareDependencies(
    record: ConversionRecord,
    dependencies: Record<string, string>,
    signal: AbortSignal,
  ): Promise<void> {
    const isolated = path.join(this.root(record.id), 'dependencies')
    await mkdir(isolated, { recursive: true })
    const ownDependencies = Object.fromEntries(
      Object.entries(dependencies).filter(([name]) => !SHARED_MODULES.includes(name)),
    )
    await atomicJson(path.join(isolated, 'package.json'), {
      private: true,
      dependencies: ownDependencies,
    })
    if (Object.keys(ownDependencies).length)
      await this.npm(['install', '--ignore-scripts', '--no-audit', '--no-fund'], isolated, signal)
    const modules = path.join(isolated, 'node_modules')
    await mkdir(modules, { recursive: true })
    const unpackedRoot = this.unpackedToolchainDirectory()
    for (const name of SHARED_MODULES) {
      const unpackedSource = path.join(unpackedRoot, 'node_modules', name)
      const fallbackSource = path.join(this.config.toolchainDirectory, 'node_modules', name)
      const source = await lstat(unpackedSource).then(
        () => unpackedSource,
        () => fallbackSource,
      )
      try {
        await lstat(source)
      } catch {
        continue
      }
      const destination = path.join(modules, name)
      await mkdir(path.dirname(destination), { recursive: true })
      await rm(destination, { recursive: true, force: true })
      await symlink(source, destination, DIRECTORY_LINK_TYPE)
    }
    const sourceModules = path.join(record.directory, 'node_modules')
    await rm(sourceModules, { recursive: true, force: true })
    await symlink(modules, sourceModules, DIRECTORY_LINK_TYPE)
  }

  private async run(
    executable: string,
    args: string[],
    cwd: string,
    signal: AbortSignal,
    environment: NodeJS.ProcessEnv = {},
  ): Promise<string> {
    signal.throwIfAborted()
    if (!this.config.subprocess) throw new Error('插件转换器缺少子进程监督器')
    const deadline = AbortSignal.timeout(300_000)
    const combined = AbortSignal.any([signal, deadline])
    const child = this.config.subprocess.spawn({
      argv: [executable, ...args],
      cwd,
      signal: combined,
      graceMs: 1_000,
      env: { GIT_TERMINAL_PROMPT: '0', ...environment },
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    })
    let output = ''
    const collect = (chunk: Buffer): void => {
      output = (output + chunk.toString('utf8')).slice(-64 * 1024)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    try {
      const outcome = await child.done
      if (signal.aborted) throw new Error('插件工具操作已取消。')
      if (deadline.aborted) throw new Error('插件工具执行超时，请检查依赖下载或构建错误。')
      if (outcome.exitCode !== 0)
        throw new Error(
          '插件工具执行失败（' + String(outcome.exitCode ?? '信号退出') + '）：' + output.trim(),
        )
      return output
    } finally {
      child.terminate()
      await child.waitForExit()
      child.stdout?.off('data', collect)
      child.stderr?.off('data', collect)
    }
  }

  private unpackedToolchainDirectory(): string {
    return this.config.toolchainDirectory.toLowerCase().endsWith('.asar')
      ? `${this.config.toolchainDirectory}.unpacked`
      : this.config.toolchainDirectory
  }

  private npm(args: string[], cwd: string, signal: AbortSignal): Promise<string> {
    return this.node(
      path.join(this.config.toolchainDirectory, 'node_modules/npm/bin/npm-cli.js'),
      args,
      cwd,
      signal,
    )
  }

  private build(
    options: Record<string, unknown>,
    cwd: string,
    signal: AbortSignal,
  ): Promise<string> {
    // esbuild 的 bin 可能被安装脚本替换成原生程序；固定使用 JS API 启动其随包服务。
    return this.run(
      this.config.nodeExecutable,
      [
        '-e',
        'require(process.argv[1]).buildSync(JSON.parse(process.argv[2]))',
        path.join(this.unpackedToolchainDirectory(), 'node_modules/esbuild/lib/main.js'),
        JSON.stringify(options),
      ],
      cwd,
      signal,
      { ELECTRON_RUN_AS_NODE: '1' },
    )
  }

  private node(script: string, args: string[], cwd: string, signal: AbortSignal): Promise<string> {
    return this.run(this.config.nodeExecutable, [script, ...args], cwd, signal, {
      ELECTRON_RUN_AS_NODE: '1',
      npm_config_cache: path.join(this.config.home, 'cache', 'npm'),
      npm_config_ignore_scripts: 'true',
      npm_config_update_notifier: 'false',
      GIT_TERMINAL_PROMPT: '0',
    })
  }
}

function forwardAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  const abort = (): void => controller.abort(signal?.reason)
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  return () => signal?.removeEventListener('abort', abort)
}
