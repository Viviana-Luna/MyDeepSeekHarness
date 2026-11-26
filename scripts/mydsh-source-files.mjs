/**
 * 列出受 docs/code-style.md 约束的 MyDSH 自有源码文件，供代码规范门禁脚本共用。
 * 固定上游模块按 docs/upstream/dsh/manifest.json 排除，保持上游写法以便升级；
 * 上游模块目录中由 MyDSH 新增的少数文件单独登记在 MYDSH_FILES_IN_UPSTREAM 中。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { extname, join } from 'node:path'

/** 参与规范检查的源码扩展名；类型声明文件（.d.ts）另行排除。 */
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs'])

/** 扫描的顶层目录，覆盖 MyDSH 自有代码可能出现的全部位置。 */
const SOURCE_ROOTS = ['src', 'scripts', 'tests', 'packages']

/** 生成物与依赖目录：其中的文件不是手写源码。 */
const SKIPPED_DIRECTORY_NAMES = new Set(['node_modules', 'lib'])

/** 位于上游模块目录、但由 MyDSH 新增和维护的文件，需要纳入检查。 */
const MYDSH_FILES_IN_UPSTREAM = [
  'packages/preset/agent-presets/coding-tools.js',
  'packages/preset/agent-presets/patch-format.js',
]

/**
 * 读取上游来源清单中的模块目录。
 * @param {string} root 仓库根目录的绝对路径。
 * @returns {Set<string>} POSIX 风格的模块相对路径，例如 `packages/jobs/jobs`。
 */
function readUpstreamDirectories(root) {
  const manifestPath = join(root, 'docs/upstream/dsh/manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  return new Set(manifest.packages.map(entry => entry.path))
}

/**
 * 判断文件名是否是需要检查的手写源码。
 * @param {string} name 不含目录的文件名。
 */
function isSourceFileName(name) {
  return SOURCE_EXTENSIONS.has(extname(name)) && !name.endsWith('.d.ts')
}

/**
 * 递归收集目录下的 MyDSH 自有源码。
 * @param {string} root 仓库根目录的绝对路径。
 * @param {string} directory 相对仓库根目录的 POSIX 路径。
 * @param {Set<string>} upstreamDirectories 需要整体跳过的上游模块目录。
 * @returns {string[]} 相对仓库根目录的 POSIX 路径。
 */
function collectSourceFiles(root, directory, upstreamDirectories) {
  const files = []
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    // 用 `/` 拼接而不是 path.join：Windows 上 join 会产生反斜杠，而上游清单使用 POSIX 路径。
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) {
      const isGenerated = SKIPPED_DIRECTORY_NAMES.has(entry.name) || entry.name.startsWith('.umi')
      if (isGenerated || upstreamDirectories.has(path)) continue
      files.push(...collectSourceFiles(root, path, upstreamDirectories))
    } else if (isSourceFileName(entry.name)) {
      files.push(path)
    }
  }
  return files
}

/**
 * 列出全部受代码规范约束的 MyDSH 自有源码文件。
 * 未加入 Git 的新文件同样会被列出，使本地检查与 CI 结果一致。
 * @param {string} root 仓库根目录的绝对路径。
 * @returns {string[]} 按字典序排列、相对仓库根目录的 POSIX 路径。
 */
export function listMydshSourceFiles(root) {
  const upstreamDirectories = readUpstreamDirectories(root)
  const files = SOURCE_ROOTS.flatMap(directory =>
    collectSourceFiles(root, directory, upstreamDirectories),
  )
  return [...files, ...MYDSH_FILES_IN_UPSTREAM].toSorted()
}
