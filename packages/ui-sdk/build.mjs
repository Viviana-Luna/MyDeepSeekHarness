/**
 * 从实际 renderer SDK 生成声明，再保留公开接口可达的声明闭包。
 * 不手写另一份 WorkspaceStore/项目接口，避免插件通过不存在的方法的类型检查。
 * 产物不含 renderer 可执行代码，运行时由宿主的共享 require 提供；支持按可达源文件摘要跳过重复编译。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '../..')
const output = join(import.meta.dirname, 'lib')
const cachePath = join(root, '.build/ui-sdk-cache.json')
// 越界检查必须用平台分隔符：Windows 上 resolve() 给出反斜杠路径，用 / 前缀会误判全部声明越界。
const outputPrefix = output + sep
const entry = join(root, 'src/renderer/src/plugins/sdk.ts')
const configPath = join(root, 'tsconfig.renderer.json')

function hashFileHex(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function isUiSdkCacheValid() {
  if (!existsSync(cachePath)) return false
  if (!existsSync(join(output, 'index.d.ts')) || !existsSync(join(output, 'exports.json'))) {
    return false
  }
  try {
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'))
    if (!cached || typeof cached.sources !== 'object' || cached.sources === null) return false
    const entries = Object.entries(cached.sources)
    if (entries.length === 0) return false
    return entries.every(([relPath, expectedHash]) => {
      const fullPath = join(root, relPath)
      return existsSync(fullPath) && hashFileHex(fullPath) === expectedHash
    })
  } catch {
    return false
  }
}

function createSdkProgram() {
  const raw = ts.readConfigFile(configPath, ts.sys.readFile)
  if (raw.error) throw new Error(ts.flattenDiagnosticMessageText(raw.error.messageText, '\n'))
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, root)
  const options = {
    ...parsed.options,
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
    declarationMap: false,
    sourceMap: false,
    incremental: false,
    rootDir: join(root, 'src'),
    outDir: output,
  }
  return ts.createProgram([entry], options)
}

function emitNormalizedDeclarations(program) {
  const declarations = new Map()
  const emitted = program.emit(undefined, (filename, text) => {
    // 资源副作用不属于类型契约；本地 .ts/.tsx 引用改为可发布声明的 .js 定位方式。
    const normalized = text
      .replace(/^import\s+['"][^'"]+\.(?:css|less|scss)['"];?\s*$/gmu, '')
      .replace(/((?:from\s*|import\s*\()\s*['"])([^'"]+)\.tsx?(['"])/gu, '$1$2.js$3')
    declarations.set(resolve(filename), normalized)
  })
  const diagnostics = [...ts.getPreEmitDiagnostics(program), ...emitted.diagnostics]
  if (diagnostics.some(item => item.category === ts.DiagnosticCategory.Error)) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCurrentDirectory: () => root,
        getCanonicalFileName: name => name,
        getNewLine: () => '\n',
      }),
    )
  }
  return declarations
}

function collectReachableDeclarations(declarations) {
  const reachable = new Set()
  const visit = filename => {
    if (reachable.has(filename)) return
    const text = declarations.get(filename)
    if (text === undefined) throw new Error(`公开接口的声明未生成：${relative(output, filename)}`)
    reachable.add(filename)
    for (const imported of ts.preProcessFile(text, true, true).importedFiles) {
      if (!imported.fileName.startsWith('.')) continue
      const next = resolve(
        dirname(filename),
        imported.fileName.replace(/\.(?:jsx?|tsx?)$/u, '.d.ts'),
      )
      if (!next.startsWith(outputPrefix)) {
        throw new Error(`公开声明越过 SDK 边界：${imported.fileName}`)
      }
      visit(next)
    }
  }
  visit(join(output, 'renderer/src/plugins/sdk.d.ts'))
  return reachable
}

function resolveSourceHashesForReachable(program, reachable) {
  const sources = {
    'packages/ui-sdk/build.mjs': hashFileHex(join(root, 'packages/ui-sdk/build.mjs')),
    'tsconfig.renderer.json': hashFileHex(configPath),
  }
  const srcRoot = join(root, 'src')
  for (const declPath of reachable) {
    const stem = relative(output, declPath).replace(/\.d\.ts$/u, '')
    for (const ext of ['.ts', '.tsx']) {
      const candidate = join(srcRoot, `${stem}${ext}`)
      if (existsSync(candidate)) {
        const rel = relative(root, candidate).replaceAll('\\', '/')
        sources[rel] = hashFileHex(candidate)
        break
      }
    }
  }
  for (const sf of program.getSourceFiles()) {
    const resolved = resolve(sf.fileName)
    if (!resolved.startsWith(srcRoot + sep) || resolved.includes(`${sep}node_modules${sep}`)) {
      continue
    }
    if (resolved.includes(`${sep}.umi`)) continue
    // 同时把 sdk.ts 直接编译涉及的共享模块记入摘要，防止纯类型重导出漏检
    const rel = relative(root, resolved).replaceAll('\\', '/')
    if (rel.startsWith('src/shared/') || rel.startsWith('src/renderer/src/plugins/')) {
      sources[rel] = hashFileHex(resolved)
    }
  }
  return sources
}

function collectRuntimeExportNames(sourceText) {
  const runtimeNames = []
  const ast = ts.createSourceFile(entry, sourceText, ts.ScriptTarget.Latest, true)
  for (const statement of ast.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
      statement.name
    ) {
      runtimeNames.push(statement.name.text)
    }
    if (
      !ts.isExportDeclaration(statement) ||
      statement.isTypeOnly ||
      !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause)
    ) {
      continue
    }
    for (const name of statement.exportClause.elements) {
      if (!name.isTypeOnly) runtimeNames.push(name.name.text)
    }
  }
  return runtimeNames
}

/**
 * 构建 @mydsh/ui 类型声明与运行导出清单；公开契约可达源码未变时直接命中缓存。
 * @param {{ force?: boolean }} [options] 是否强制忽略缓存重建。
 */
export async function buildUiSdk(options = {}) {
  if (options.force !== true && isUiSdkCacheValid()) {
    return { cached: true }
  }
  const program = createSdkProgram()
  const declarations = emitNormalizedDeclarations(program)
  const reachable = collectReachableDeclarations(declarations)
  await rm(output, { recursive: true, force: true })
  await Promise.all(
    [...reachable].map(async filename => {
      await mkdir(dirname(filename), { recursive: true })
      await writeFile(filename, declarations.get(filename))
    }),
  )
  await writeFile(
    join(output, 'index.d.ts'),
    "// 由真实 renderer SDK 生成，修改源码后重新运行 build.mjs。\nexport * from './renderer/src/plugins/sdk.js'\n",
  )
  const runtimeNames = collectRuntimeExportNames(await readFile(entry, 'utf8'))
  await writeFile(
    join(output, 'exports.json'),
    `${JSON.stringify({ apiVersion: 1, exports: runtimeNames.toSorted() }, null, 2)}\n`,
  )
  const sources = resolveSourceHashesForReachable(program, reachable)
  await mkdir(dirname(cachePath), { recursive: true })
  await writeFile(cachePath, `${JSON.stringify({ sources }, null, 2)}\n`)
  console.log(
    `@mydsh/ui 已从真实接口生成 ${String(reachable.size)} 个声明文件，${String(runtimeNames.length)} 个运行导出。`,
  )
  return { cached: false }
}

if (import.meta.main) {
  await buildUiSdk({ force: process.argv.includes('--force') })
}
