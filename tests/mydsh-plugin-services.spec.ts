import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { Context } from '@deepseek-ai/cordis'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { createMydshPluginServices } from '../src/runtime/plugins/index.ts'

const moduleUrl = (file: string): string => JSON.stringify(pathToFileURL(file).href)

async function writeSource(directory: string, version: string, fails = false): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(
    path.join(directory, 'package.json'),
    JSON.stringify({
      name: 'sample',
      version,
      type: 'module',
      mydshBuild: { backend: 'index.ts' },
    }),
  )
  await writeFile(
    path.join(directory, 'mydsh.plugin.json'),
    JSON.stringify({
      id: 'sample',
      name: '验收插件',
      apiVersion: 1,
      version,
      backend: 'dist/backend.js',
      config: { label: version, home: '/invalid-manifest-home' },
    }),
  )
  await writeFile(
    path.join(directory, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'NodeNext',
        target: 'ES2022',
        strict: true,
        skipLibCheck: true,
        types: [],
      },
      include: ['index.ts'],
    }),
  )
  await writeFile(
    path.join(directory, 'index.ts'),
    `import type { Context } from '@deepseek-ai/cordis';\nexport function apply(ctx: Context, config: { label: string; home: string }) { ${fails ? 'throw new Error("候选版本启动失败")' : "ctx.provide('convertedExample', config.label); ctx.provide('convertedHome', config.home)"} }\n`,
  )
}

async function prepareToolchain(temporary: string): Promise<string> {
  const directory = path.join(temporary, 'toolchain')
  await mkdir(path.join(directory, 'node_modules/@mydsh'), { recursive: true })
  await Promise.all(
    ['typescript', 'esbuild', 'npm'].map(name =>
      symlink(
        path.join(process.cwd(), 'node_modules', name),
        path.join(directory, 'node_modules', name),
        process.platform === 'win32' ? 'junction' : 'dir',
      ),
    ),
  )
  const provenance = JSON.parse(await readFile('docs/upstream/dsh/manifest.json', 'utf8')) as {
    packages: Array<{ name: string; path: string }>
  }
  for (const entry of provenance.packages) {
    const destination = path.join(directory, 'node_modules', entry.name)
    await mkdir(path.dirname(destination), { recursive: true })
    await symlink(
      path.resolve(entry.path),
      destination,
      process.platform === 'win32' ? 'junction' : 'dir',
    )
  }
  // 与 build-runtime 一致跳过 node_modules：cp 会把工作区链接重建为需要特权的符号链接，解引用又会因循环链接失败。
  await cp('packages/plugin-sdk', path.join(directory, 'node_modules/@mydsh/sdk'), {
    recursive: true,
    filter: source => !source.split(path.sep).includes('node_modules'),
  })
  // @mydsh/sdk 的嵌套依赖用一条目录链接补回；Windows 上取 junction，同样不需要符号链接特权。
  await symlink(
    path.join(process.cwd(), 'packages/plugin-sdk/node_modules'),
    path.join(directory, 'node_modules/@mydsh/sdk/node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  await cp('packages/runtime/plugin-typert.mjs', path.join(directory, 'plugin-typert.js'))
  await cp('packages/runtime/canonical-path.mjs', path.join(directory, 'canonical-path.mjs'))
  await writeFile(path.join(directory, 'package.json'), '{"type":"module"}')
  return directory
}

async function writeRemoteSource(directory: string, exportsReady: boolean): Promise<void> {
  await mkdir(path.join(directory, 'src'), { recursive: true })
  const exports = exportsReady
    ? {
        '.': { types: './lib/index.d.ts', default: './dist/backend.js' },
        './typert': { types: './lib/typert.host.d.ts', default: './lib/typert.host.js' },
        './remote': {
          types: './lib/typert.remote-client.d.ts',
          default: './lib/typert.remote-client.js',
        },
      }
    : undefined
  await writeFile(
    path.join(directory, 'package.json'),
    JSON.stringify({
      name: 'sample-remote',
      version: '1.0.0',
      type: 'module',
      mydshBuild: { backend: 'src/index.ts' },
      exports,
      files: [
        'lib/typert.host.js',
        'lib/typert.host.d.ts',
        'lib/typert.remote-client.js',
        'lib/typert.remote-client.d.ts',
      ],
    }),
  )
  await writeFile(
    path.join(directory, 'mydsh.plugin.json'),
    JSON.stringify({
      id: 'sample-remote',
      name: 'Remote 验收插件',
      apiVersion: 1,
      version: '1.0.0',
      backend: 'dist/backend.js',
    }),
  )
  await writeFile(
    path.join(directory, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'NodeNext',
        target: 'ES2022',
        strict: true,
        skipLibCheck: true,
        types: [],
      },
      include: ['src'],
    }),
  )
  await writeFile(
    path.join(directory, 'src/index.ts'),
    `import {Context, Remote, TypertRemoteService} from '@mydsh/sdk';\ndeclare module '@deepseek-ai/cordis' {interface Context {sampleRemote:SampleRemote}}\nexport class SampleRemote extends TypertRemoteService {constructor(ctx:Context){super(ctx,'sampleRemote')} @Remote echo(value:string):string{return value}}\nexport function apply(ctx:Context):void {new SampleRemote(ctx)}\n`,
  )
}

describe('MyDSH 插件安装与源码转换', () => {
  it('使用真实随包工具构建源码，安装、停用、升级和恢复时清理 Cordis 资源', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'mydsh-plugin-'))
    const context = new Context()
    await context.plugin(LocalSubprocessRuntime).await()
    let busy = false
    const toolchainDirectory = await prepareToolchain(temporary)
    const services = createMydshPluginServices(context, {
      subprocess: context.subprocess,
      home: path.join(temporary, 'home'),
      nodeExecutable: process.execPath,
      toolchainDirectory,
      isBusy: () => (busy ? '当前任务仍在使用插件。' : undefined),
    })
    try {
      const source = path.join(temporary, 'source')
      await writeSource(source, '1.0.0')
      const original = await readFile(path.join(source, 'index.ts'), 'utf8')
      await services.initialize()
      const first = await services.converter.prepare({ kind: 'local', path: source })
      await services.converter.validate(first.id)
      await services.converter.install(first.id)
      expect(context.get('convertedExample')).toBe('1.0.0')
      expect(context.get('convertedHome')).toBe(path.join(temporary, 'home/data/plugins/sample'))
      expect(services.manager.list()[0]?.running).toBe(true)
      await services.manager.disable('sample')
      expect(context.get('convertedExample')).toBeUndefined()
      expect(services.manager.list()[0]?.running).toBe(false)
      await services.manager.enable('sample')
      await writeSource(source, '2.0.0')
      const second = await services.converter.prepare({ kind: 'local', path: source })
      await services.converter.validate(second.id)
      await services.converter.install(second.id)
      expect(context.get('convertedExample')).toBe('2.0.0')
      await services.manager.rollback('sample')
      expect(context.get('convertedExample')).toBe('1.0.0')
      const remoteSource = path.join(temporary, 'remote-source')
      await writeRemoteSource(remoteSource, true)
      const remote = await services.converter.prepare({ kind: 'local', path: remoteSource })
      const validated = await services.converter.validate(remote.id)
      // Vite 的测试导入器不执行 Node registerHooks；在真实 Node 中验证共享实例及 Remote 生命周期。
      const bundle = path.join(temporary, 'plugin-services.mjs')
      await build({
        entryPoints: ['src/runtime/plugins/index.ts'],
        outfile: bundle,
        bundle: true,
        platform: 'node',
        format: 'esm',
        packages: 'external',
      })
      const require = createRequire(path.join(toolchainDirectory, 'package.json'))
      const remoteCheck = `
        import assert from 'node:assert/strict'; import {mkdir} from 'node:fs/promises';
        import {Context} from ${moduleUrl(require.resolve('@deepseek-ai/cordis'))};
        import {TypertRegistry} from ${moduleUrl(require.resolve('@deepseek-ai/dsh-typert-registry'))};
        import {createMydshPluginServices} from ${moduleUrl(bundle)};
        import {installPluginResolution} from ${moduleUrl(path.join(process.cwd(), 'packages/runtime/plugin-resolution.mjs'))};
        const home=${JSON.stringify(path.join(temporary, 'remote-home'))}, toolchain=${JSON.stringify(toolchainDirectory)};
        await mkdir(home,{recursive:true}); const hooks=installPluginResolution(toolchain,home), ctx=new Context();
        const services=createMydshPluginServices(ctx,{home,nodeExecutable:process.execPath,toolchainDirectory:toolchain});
        try {await ctx.plugin(TypertRegistry); await services.initialize(); await services.manager.install(${JSON.stringify(validated.artifact)});
          const descriptor=ctx.typert.local.get('sampleRemote/echo'), parameter=descriptor?.parameters[0]?.codec;
          assert.equal(parameter?.mode,'strict'); assert.equal(descriptor?.result.mode,'strict');
          assert.equal(parameter.create().parse('内容'),'内容'); assert.throws(()=>parameter.create().parse(123)); assert.throws(()=>descriptor.result.create().parse(123));
          await services.manager.disable('sample-remote'); assert.equal(ctx.typert.local.get('sampleRemote/echo'),undefined);
          console.log('Remote 严格校验与卸载通过');
        } finally {await services.dispose();await ctx.fiber.dispose();hooks.deregister()}
      `
      const check = await promisify(execFile)(process.execPath, [
        '--input-type=module',
        '-e',
        remoteCheck,
      ])
      expect(check.stdout).toContain('Remote 严格校验与卸载通过')
      busy = true
      expect((await services.manager.disable('sample')).status).toBe('pending')
      expect(services.manager.list()[0]?.running).toBe(true)
      expect(context.get('convertedExample')).toBe('1.0.0')
      busy = false
      await services.manager.disable('sample')
      expect(services.manager.list()[0]?.running).toBe(false)
      const frontend = path.join(temporary, 'frontend')
      await mkdir(frontend)
      await writeFile(
        path.join(frontend, 'mydsh.plugin.json'),
        JSON.stringify({
          id: 'sample-ui',
          name: '前端插件',
          version: '1.0.0',
          apiVersion: 1,
          frontend: 'client.js',
        }),
      )
      await writeFile(
        path.join(frontend, 'client.js'),
        'globalThis.__MYDSH_PLUGINS__.define("sample-ui", function() {})\n',
      )
      expect((await services.manager.install(frontend)).running).toBe(true)
      busy = true
      expect((await services.manager.disable('sample-ui')).running).toBe(true)
      busy = false
      expect((await services.manager.disable('sample-ui')).running).toBe(false)
      expect(
        await readFile(path.join(temporary, 'home/config/plugins.json'), 'utf8'),
      ).not.toContain('"running"')
      expect(await readFile(path.join(first.directory, 'index.ts'), 'utf8')).toBe(original)
    } finally {
      await services.dispose()
      await context.fiber.dispose()
      await rm(temporary, { recursive: true, force: true })
    }
  }, 30_000)

  it('候选版本启动失败后恢复原版本，验证后被改动的产物不能安装', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'mydsh-plugin-failure-'))
    const context = new Context()
    await context.plugin(LocalSubprocessRuntime).await()
    const toolchainDirectory = await prepareToolchain(temporary)
    const services = createMydshPluginServices(context, {
      subprocess: context.subprocess,
      home: path.join(temporary, 'home'),
      nodeExecutable: process.execPath,
      toolchainDirectory,
    })
    try {
      await services.initialize()
      const source = path.join(temporary, 'source')
      await writeSource(source, '1.0.0')
      const first = await services.converter.prepare({ kind: 'local', path: source })
      await services.converter.validate(first.id)
      await services.converter.install(first.id)
      await writeSource(source, '2.0.0', true)
      const failed = await services.converter.prepare({ kind: 'local', path: source })
      await services.converter.validate(failed.id)
      await expect(services.converter.install(failed.id)).rejects.toThrow('已保留原版本')
      expect(context.get('convertedExample')).toBe('1.0.0')
      expect(services.manager.list()[0]?.version).toBe('1.0.0')
      await writeFile(path.join(failed.directory, 'index.ts'), '源码已经修改\n')
      await expect(services.converter.install(failed.id)).rejects.toThrow('重新验证')
      const remoteSource = path.join(temporary, 'remote-source')
      await writeRemoteSource(remoteSource, false)
      const remote = await services.converter.prepare({ kind: 'local', path: remoteSource })
      await expect(services.converter.validate(remote.id)).rejects.toThrow(
        '必须公开 ./typert、./remote',
      )
      const reservedDirectory = path.join(temporary, 'reserved')
      await cp(services.manager.list()[0]!.directory, reservedDirectory, { recursive: true })
      const reserved = JSON.parse(
        await readFile(path.join(reservedDirectory, 'mydsh.plugin.json'), 'utf8'),
      ) as Record<string, unknown>
      await writeFile(
        path.join(reservedDirectory, 'mydsh.plugin.json'),
        JSON.stringify({ ...reserved, id: 'mydsh.reserved' }),
      )
      await expect(services.manager.install(reservedDirectory)).rejects.toThrow('保留标识')
    } finally {
      await services.dispose()
      await context.fiber.dispose()
      await rm(temporary, { recursive: true, force: true })
    }
  }, 30_000)
})
