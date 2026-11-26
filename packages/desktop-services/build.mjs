/** 在临时标准包里检查后端源码并生成真实 Typert；不把 renderer 或全仓声明送入分析器。 */
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { generatePluginTypert } from '../runtime/plugin-typert.mjs'

const root = resolve(import.meta.dirname, '../..')

/** toolchain 必须已有固定版 Cordis、Typert、TypeScript、esbuild 与 @mydsh/sdk。 */
export async function buildDesktopServices(toolchain, destination) {
  const temporary = await mkdtemp(join(tmpdir(), 'mydsh-desktop-services-'))
  const source = join(temporary, 'source')
  const requireTool = createRequire(join(toolchain, 'package.json'))
  const ts = requireTool('typescript')
  try {
    await mkdir(source, { recursive: true })
    // 保留真实仓库相对关系，复制到单个标准包 src 下；源码只维护一份。
    await Promise.all(
      [
        'packages/desktop-services/src',
        'src/runtime/workspace',
        'src/runtime/terminal',
        'src/shared',
        'src/runtime/filesystem',
      ].map(path => cp(join(root, path), join(source, 'src', path), { recursive: true })),
    )
    const manifest = JSON.parse(await readFile(join(import.meta.dirname, 'package.json'), 'utf8'))
    await writeFile(join(source, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
    // Windows 普通账户没有符号链接特权，目录链接改用 junction；lstat 仍把它报告为符号链接。
    await symlink(
      join(toolchain, 'node_modules'),
      join(source, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const config = {
      compilerOptions: {
        target: 'ES2024',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        lib: ['ES2024', 'DOM'],
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        noImplicitOverride: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        types: ['node'],
        noEmit: true,
        allowImportingTsExtensions: true,
        skipLibCheck: true,
      },
      files: [
        'src/packages/desktop-services/src/index.ts',
        'src/packages/desktop-services/src/types.ts',
      ],
    }
    const configFile = join(source, 'tsconfig.json')
    await writeFile(configFile, JSON.stringify(config, null, 2) + '\n')
    const parsed = ts.parseJsonConfigFileContent(config, ts.sys, source, undefined, configFile)
    const program = ts.createProgram(parsed.fileNames, parsed.options)
    const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)]
    if (diagnostics.length)
      throw new Error(
        ts.formatDiagnosticsWithColorAndContext(diagnostics, {
          getCanonicalFileName: file => file,
          getCurrentDirectory: () => source,
          getNewLine: () => '\n',
        }),
      )
    await mkdir(destination, { recursive: true })
    await writeFile(join(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
    await cp(join(import.meta.dirname, 'README.md'), join(destination, 'README.md'))
    const result = await generatePluginTypert(source, destination, toolchain)
    if (!result.generated) throw new Error('桌面核心服务没有生成 Remote 契约')
    return destination
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const toolchain = resolve(process.argv[2] ?? join(root, 'lib/mydsh-runtime/payload'))
  const destination = resolve(process.argv[3] ?? join(root, 'lib/desktop-services'))
  await buildDesktopServices(toolchain, destination)
  console.log(`桌面核心服务与 Remote 契约已构建：${destination}`)
}
