/**
 * 注释门禁：检查 MyDSH 自有源码是否满足 docs/code-style.md 的两条硬性要求。
 *
 * 1. 文件开头（第一条语句之前）有一段中文注释，说明模块职责。
 * 2. 每个导出声明前有中文 JSDoc（以 `/**` 开头的块注释）。
 *
 * 尚未整理的旧文件登记在 scripts/comment-debt.json 中暂时豁免。清单只减不增：
 * 清单中的文件已经达标或已被删除时，本脚本同样失败，要求同步删除对应条目。
 */
import { readFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import ts from 'typescript'
import { listMydshSourceFiles } from './mydsh-source-files.mjs'

const root = resolve(import.meta.dirname, '..')
const DEBT_FILE = 'scripts/comment-debt.json'

/** 注释必须包含中文；只写英文或只写 lint 指令都不算说明。 */
const CHINESE_CHARACTER = /\p{Script=Han}/u
const LINT_DIRECTIVE = /^\s*(?:\/\/|\/\*)\s*(?:oxlint|eslint)-(?:disable|enable)/u

/**
 * 按扩展名选择解析方式，使 JSX 与普通脚本都能得到准确的语法树。
 * @param {string} file 相对路径。
 */
function scriptKindOf(file) {
  const kinds = {
    '.ts': ts.ScriptKind.TS,
    '.tsx': ts.ScriptKind.TSX,
    '.js': ts.ScriptKind.JS,
    '.mjs': ts.ScriptKind.JS,
    '.cjs': ts.ScriptKind.JS,
  }
  return kinds[extname(file)]
}

/**
 * 取出某个位置之前紧邻的注释文本。
 * @param {string} text 文件全文。
 * @param {number} position 语句的完整起始位置（包含前导注释）。
 * @returns {string[]} 按出现顺序排列的注释原文。
 */
function leadingComments(text, position) {
  const ranges = ts.getLeadingCommentRanges(text, position) ?? []
  return ranges.map(range => text.slice(range.pos, range.end))
}

/**
 * 判断一段注释是否算作有效说明：包含中文，且不是 lint 指令。
 * @param {string} comment 注释原文。
 */
function isExplanation(comment) {
  return CHINESE_CHARACTER.test(comment) && !LINT_DIRECTIVE.test(comment)
}

/**
 * 检查文件头注释。shebang 行之后、第一条语句之前必须出现说明性注释。
 * @param {ts.SourceFile} source 解析后的文件。
 * @returns {boolean}
 */
function hasFileHeader(source) {
  const text = source.getFullText()
  const shebang = ts.getShebang(text)
  const start = shebang === undefined ? 0 : shebang.length
  return leadingComments(text, start).some(isExplanation)
}

/**
 * 判断语句是否带有 export 修饰符。`export { a }` 和 `export * from` 只是转发，不要求说明。
 * @param {ts.Statement} statement 顶层语句。
 */
function isExportedDeclaration(statement) {
  if (ts.isExportAssignment(statement)) return true
  const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined
  return modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false
}

/**
 * 取得导出声明的名字，用于报告和识别函数重载。
 * @param {ts.Statement} statement 导出声明。
 * @returns {string}
 */
function declarationName(statement) {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.map(item => item.name.getText()).join(', ')
  }
  if (ts.isExportAssignment(statement)) return 'default'
  return statement.name?.getText() ?? 'default'
}

/**
 * 判断导出声明前是否有中文 JSDoc。
 * @param {ts.Statement} statement 导出声明。
 * @param {string} text 文件全文。
 */
function hasDocumentation(statement, text) {
  const comments = leadingComments(text, statement.getFullStart())
  const nearest = comments.at(-1)
  return nearest !== undefined && nearest.startsWith('/**') && isExplanation(nearest)
}

/**
 * 找出文件中所有缺少 JSDoc 的导出声明。
 * 同名函数重载只要求第一个声明写说明，后续签名和实现共享这段说明。
 * @param {ts.SourceFile} source 解析后的文件。
 * @returns {string[]} 形如 `第 12 行 parseManifest` 的问题描述。
 */
function findUndocumentedExports(source) {
  const text = source.getFullText()
  const problems = []
  let previousFunctionName
  for (const statement of source.statements) {
    const functionName = ts.isFunctionDeclaration(statement) ? statement.name?.getText() : undefined
    const isOverloadContinuation =
      functionName !== undefined && functionName === previousFunctionName
    previousFunctionName = functionName
    if (!isExportedDeclaration(statement) || isOverloadContinuation) continue
    if (hasDocumentation(statement, text)) continue
    const line = source.getLineAndCharacterOfPosition(statement.getStart()).line + 1
    problems.push(`第 ${String(line)} 行 ${declarationName(statement)}`)
  }
  return problems
}

/**
 * 检查单个文件，返回全部问题描述；没有问题时返回空数组。
 * @param {string} file 相对仓库根目录的路径。
 */
function inspectFile(file) {
  const text = readFileSync(join(root, file), 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindOf(file))
  const problems = hasFileHeader(source) ? [] : ['缺少说明模块职责的中文文件头注释']
  for (const declaration of findUndocumentedExports(source)) {
    problems.push(`导出声明缺少中文 JSDoc：${declaration}`)
  }
  return problems
}

/**
 * 读取暂时豁免的旧文件清单。
 * @returns {Set<string>}
 */
function readDebt() {
  const debt = JSON.parse(readFileSync(join(root, DEBT_FILE), 'utf8'))
  return new Set(debt.files)
}

const files = listMydshSourceFiles(root)
const debt = readDebt()
const failures = []

for (const file of files) {
  const problems = inspectFile(file)
  if (debt.has(file)) {
    if (problems.length === 0) failures.push(`${file} 已达标，请从 ${DEBT_FILE} 中删除`)
    continue
  }
  for (const problem of problems) failures.push(`${file}：${problem}`)
}

const existing = new Set(files)
for (const file of debt) {
  if (!existing.has(file)) failures.push(`${DEBT_FILE} 登记的 ${file} 已不存在，请删除该条目`)
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`verify-comments: ${failure}`)
  console.error('verify-comments: 注释要求见 docs/code-style.md 的“注释”一节。')
  process.exitCode = 1
} else {
  const checked = files.length - debt.size
  console.log(
    `verify-comments: ${String(checked)} 个文件通过，${String(debt.size)} 个旧文件待整理。`,
  )
}
