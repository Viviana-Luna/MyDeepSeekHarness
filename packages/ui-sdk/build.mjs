/**
 * 从实际 renderer SDK 生成声明，再保留公开接口可达的声明闭包。
 * 不手写另一份 WorkspaceStore/项目接口，避免插件通过不存在的方法的类型检查。
 * 产物不含 renderer 可执行代码，运行时由宿主的共享 require 提供。
 */
import ts from 'typescript'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const output = join(import.meta.dirname, 'lib')
// 越界检查必须用平台分隔符：Windows 上 resolve() 给出反斜杠路径，用 / 前缀会误判全部声明越界。
const outputPrefix = output + sep
const entry = join(root, 'src/renderer/src/plugins/sdk.ts')
const configPath = join(root, 'tsconfig.renderer.json')
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
const program = ts.createProgram([entry], options)
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
const declarationEntry = join(output, 'renderer/src/plugins/sdk.d.ts')
const reachable = new Set()
function visit(filename) {
  if (reachable.has(filename)) return
  const text = declarations.get(filename)
  if (text === undefined) throw new Error(`公开接口的声明未生成：${relative(output, filename)}`)
  reachable.add(filename)
  for (const imported of ts.preProcessFile(text, true, true).importedFiles) {
    if (!imported.fileName.startsWith('.')) continue
    const next = resolve(dirname(filename), imported.fileName.replace(/\.(?:jsx?|tsx?)$/u, '.d.ts'))
    if (!next.startsWith(outputPrefix))
      throw new Error(`公开声明越过 SDK 边界：${imported.fileName}`)
    visit(next)
  }
}
visit(declarationEntry)
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
const source = await readFile(entry, 'utf8')
const runtimeNames = []
for (const statement of ts.createSourceFile(entry, source, ts.ScriptTarget.Latest, true)
  .statements) {
  if (
    ts.isFunctionDeclaration(statement) &&
    statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
    statement.name
  )
    runtimeNames.push(statement.name.text)
  if (
    !ts.isExportDeclaration(statement) ||
    statement.isTypeOnly ||
    !statement.exportClause ||
    !ts.isNamedExports(statement.exportClause)
  )
    continue
  for (const name of statement.exportClause.elements)
    if (!name.isTypeOnly) runtimeNames.push(name.name.text)
}
await writeFile(
  join(output, 'exports.json'),
  `${JSON.stringify({ apiVersion: 1, exports: runtimeNames.toSorted() }, null, 2)}\n`,
)
console.log(
  `@mydsh/ui 已从真实接口生成 ${reachable.size} 个声明文件，${runtimeNames.length} 个运行导出。`,
)
