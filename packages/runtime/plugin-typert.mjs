import { cp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Windows 普通账户没有符号链接特权，目录链接改用 junction；lstat 仍把它报告为符号链接。 */
const DIRECTORY_LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir'

/** TypeScript 统一返回正斜杠路径；Windows 的本地路径是反斜杠，比较与写入前先统一。 */
const slash = value => value.replaceAll('\\', '/')

/**
 * 将一个扩展临时映射为 Typert 的单包工作区，复用上游分析器与产物格式。
 * 不修改原始源码、不分析全部核心插件，也不以源码反射代替编译期校验。
 */
export async function generatePluginTypert(
  sourceInput,
  artifact,
  toolchainInput,
  configFile = 'tsconfig.json',
) {
  // TypeScript 的模块解析按真实路径记录文件（Windows 上是长路径），调用方传入的短路径无法与它比较，入口统一成规范路径。
  const source = realpathSync.native(sourceInput)
  const toolchain = realpathSync.native(toolchainInput)
  const requireTool = createRequire(join(toolchain, 'package.json'))
  const ts = requireTool('typescript')
  const configPath = join(source, configFile)
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error) throw new Error('无法读取插件 TypeScript 配置。')
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    dirname(configPath),
    undefined,
    configPath,
  )
  if (parsed.errors.length)
    throw new Error(ts.formatDiagnosticsWithColorAndContext(parsed.errors, diagnosticHost(ts)))
  const program = ts.createProgram(parsed.fileNames, parsed.options)
  const checker = program.getTypeChecker()
  let remoteMethods = 0
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || !resolve(file.fileName).startsWith(resolve(source) + sep))
      continue
    const visit = node => {
      if (ts.canHaveDecorators(node))
        for (const decorator of ts.getDecorators(node) ?? []) {
          const expression = ts.isCallExpression(decorator.expression)
            ? decorator.expression.expression
            : decorator.expression
          let symbol = checker.getSymbolAtLocation(expression)
          if (symbol && symbol.flags & ts.SymbolFlags.Alias)
            symbol = checker.getAliasedSymbol(symbol)
          if (symbol?.name === 'Remote' || symbol?.name === 'RemoteScope') remoteMethods++
        }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  if (!remoteMethods) return { generated: false }
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  if (!manifest.exports?.['./typert'] || !manifest.exports?.['./remote'])
    throw new Error(
      '后台声明了 @Remote：package.json 必须公开 ./typert、./remote，并按 MyDSH 插件开发文档列出生成文件；不能使用运行时反射回退。',
    )
  if (typeof manifest.name !== 'string') throw new Error('公开 Remote 的插件必须声明 npm 包名。')
  const compiler = join(dirname(source), '.typert-workspace')
  const packageDirectory = join(compiler, 'packages', 'plugin')
  await rm(compiler, { recursive: true, force: true })
  try {
    await cp(source, packageDirectory, {
      recursive: true,
      filter: file =>
        !relative(source, file)
          .split(sep)
          .some(part => part === 'node_modules' || part === '.git'),
    })
    await symlink(
      join(source, 'node_modules'),
      join(packageDirectory, 'node_modules'),
      DIRECTORY_LINK_TYPE,
    )
    // 上游分析器通过包归属识别 Remote 符号。只登记固定协议的声明快照，不编译核心。
    const protocolDirectory = join(compiler, 'packages', 'protocol')
    const protocolPackage = dirname(
      requireTool.resolve('@deepseek-ai/dsh-typert-protocol/package.json'),
    )
    await cp(join(protocolPackage, 'types'), join(protocolDirectory, 'types'), { recursive: true })
    await json(join(protocolDirectory, 'package.json'), {
      name: '@deepseek-ai/dsh-typert-protocol',
      type: 'module',
      exports: { '.': './types/index.d.ts', './types': './types/types.d.ts' },
    })
    await json(join(protocolDirectory, 'tsconfig.json'), {
      files: ['./types/index.d.ts', './types/types.d.ts'],
    })
    const sdkDirectory = join(compiler, 'packages', 'sdk')
    const sdkSource = dirname(requireTool.resolve('@mydsh/sdk'))
    await mkdir(sdkDirectory, { recursive: true })
    await cp(join(sdkSource, 'index.d.ts'), join(sdkDirectory, 'index.d.ts'))
    await json(join(sdkDirectory, 'package.json'), {
      name: '@mydsh/sdk',
      type: 'module',
      exports: { '.': './index.d.ts' },
    })
    await json(join(sdkDirectory, 'tsconfig.json'), { files: ['./index.d.ts'] })
    await symlink(
      join(source, 'node_modules'),
      join(sdkDirectory, 'node_modules'),
      DIRECTORY_LINK_TYPE,
    )
    await symlink(
      join(source, 'node_modules'),
      join(protocolDirectory, 'node_modules'),
      DIRECTORY_LINK_TYPE,
    )
    const paths = {
      ...parsed.options.paths,
      '@mydsh/sdk': [join(sdkDirectory, 'index.d.ts')],
      '@deepseek-ai/dsh-typert-protocol': [join(protocolDirectory, 'types/index.d.ts')],
      '@deepseek-ai/dsh-typert-protocol/types': [join(protocolDirectory, 'types/types.d.ts')],
    }
    // references 仅包含当前扩展。原配置通过绝对路径继承，保持用户的模块解析约定。
    // TypeScript 返回正斜杠路径，Windows 上直接与本地反斜杠前缀比较会把全部文件滤掉，先统一再比较与写入。
    const sourcePrefix = `${slash(resolve(source))}/`
    await json(join(packageDirectory, 'tsconfig.json'), {
      extends: join(source, configFile),
      compilerOptions: { rootDir: packageDirectory },
      files: parsed.fileNames
        .filter(file => slash(file).startsWith(sourcePrefix))
        .map(file => slash(relative(source, file))),
      include: [],
      exclude: [],
    })
    await json(join(compiler, 'tsconfig.host.json'), {
      extends: join(source, configFile),
      compilerOptions: { rootDir: compiler, paths },
      files: [],
      include: [],
      references: [
        { path: './packages/plugin/tsconfig.json' },
        { path: './packages/protocol/tsconfig.json' },
        { path: './packages/sdk/tsconfig.json' },
      ],
    })
    const { WorkspaceTypertGenerator } = await import(
      pathToFileURL(requireTool.resolve('@deepseek-ai/dsh-typert-generator')).href
    )
    const generator = new WorkspaceTypertGenerator(compiler, { checkDiagnostics: false })
    const generated = generator.generate([manifest.name], ['host'])
    const host = generated.find(item => item.package === manifest.name && item.face === 'host')
    if (!host?.remote)
      throw new Error(
        '检测到 @Remote，但公共导出未生成调用契约。请公开服务入口、显式类型和相关类型子路径。',
      )
    const directory = join(artifact, 'lib')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'typert.host.js'), host.js)
    await writeFile(join(directory, 'typert.host.d.ts'), host.dts)
    await writeFile(join(directory, 'typert.remote-client.js'), host.remote.js)
    await writeFile(join(directory, 'typert.remote-client.d.ts'), host.remote.dts)
    // 为生成的客户端声明保留插件公开类型；绝不把整个 TypeScript 项目放进产物。
    const declarationProgram = ts.createProgram(parsed.fileNames, {
      ...parsed.options,
      noEmit: false,
      declaration: true,
      emitDeclarationOnly: false,
      declarationMap: false,
      sourceMap: false,
      incremental: false,
      composite: false,
      rewriteRelativeImportExtensions: true,
      rootDir: join(source, 'src'),
      outDir: directory,
    })
    const emitted = declarationProgram.emit()
    if (emitted.emitSkipped || emitted.diagnostics.length)
      throw new Error(
        ts.formatDiagnosticsWithColorAndContext(emitted.diagnostics, diagnosticHost(ts)) ||
          '无法生成插件公开类型声明。',
      )
    const { build } = requireTool('esbuild')
    const registryRequire = createRequire(requireTool.resolve('@deepseek-ai/dsh-typert-registry'))
    // Zod 随生成产物打包；其他插件不需要为了类型校验另行安装运行依赖。
    for (const name of ['typert.host.js', 'typert.remote-client.js']) {
      const file = join(directory, name)
      await build({
        stdin: { contents: await readFile(file, 'utf8'), sourcefile: name, resolveDir: toolchain },
        bundle: true,
        platform: 'neutral',
        format: 'esm',
        target: 'es2022',
        outfile: file,
        alias: { zod: registryRequire.resolve('zod') },
        logLevel: 'silent',
      })
    }
    // 公共类型子路径是客户端声明的组成部分，不能在产物清单中静默删掉。
    const checkTarget = async value => {
      if (typeof value === 'string') {
        if (value === './package.json') return
        if (
          !value.startsWith('./') ||
          value.split('/').includes('..') ||
          value.includes('*') ||
          !(await stat(join(artifact, value)).catch(() => undefined))?.isFile()
        )
          throw new Error(`插件公开导出没有对应构建产物：${value}`)
      } else if (value && typeof value === 'object')
        await Promise.all(Object.values(value).map(checkTarget))
      else throw new Error('插件公开导出必须指向明确的构建文件。')
    }
    await checkTarget(manifest.exports)
    return { generated: true, package: manifest.name, exports: manifest.exports }
  } finally {
    await rm(compiler, { recursive: true, force: true })
  }
}

function diagnosticHost(ts) {
  return {
    getCanonicalFileName: file => file,
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getNewLine: () => '\n',
  }
}
async function json(file, value) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value, null, 2) + '\n')
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  const result = await generatePluginTypert(...process.argv.slice(2))
  process.stdout.write(JSON.stringify(result) + '\n')
}
