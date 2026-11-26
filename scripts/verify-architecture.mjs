import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const sourceRoot = join(root, 'src')
const failures = []
const expectedSourceDirectories = new Set(['main', 'preload', 'renderer', 'runtime', 'shared'])

function sourceFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.umi')) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(path))
    else files.push(path)
  }
  return files
}

for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) {
    failures.push(`src 根目录不得平铺业务文件：${entry.name}`)
    continue
  }
  if (!expectedSourceDirectories.has(entry.name))
    failures.push(`src 包含未声明的运行时分区：${entry.name}`)
}

for (const directory of expectedSourceDirectories) {
  const path = join(sourceRoot, directory)
  try {
    if (!statSync(path).isDirectory()) failures.push(`缺少源码分区：src/${directory}`)
  } catch {
    failures.push(`缺少源码分区：src/${directory}`)
  }
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (manifest.main !== 'lib/main/index.js') failures.push('Electron 入口必须是 lib/main/index.js')
for (const dependency of ['react', 'react-dom', 'antd', '@umijs/max']) {
  if (manifest.devDependencies?.[dependency] === undefined)
    failures.push(`缺少 renderer 构建依赖：${dependency}`)
}

const rendererConfig = readFileSync(join(sourceRoot, 'renderer', 'config', 'config.ts'), 'utf8')
if (
  !rendererConfig.includes("history: { type: 'memory' }") ||
  !rendererConfig.includes("outputPath: '../../lib/renderer'")
) {
  failures.push('Umi 必须使用内存路由并生成主进程加载的本地 renderer 产物')
}
if (!rendererConfig.includes("script-src 'self'") || rendererConfig.includes('unsafe-eval')) {
  failures.push('renderer 安全策略必须限制脚本来源且禁止动态代码求值')
}

const rendererBaseStyles = readFileSync(
  join(sourceRoot, 'renderer', 'src', 'styles', 'base.css'),
  'utf8',
)
if (/font\s*:[^;]*\binherit\b/iu.test(rendererBaseStyles)) {
  failures.push(
    'renderer 基础字体不得用含 inherit 的 font 简写；必须分别声明字体、字号、字重和行高',
  )
}
for (const requiredDeclaration of [
  'font-family: var(--font-ui)',
  'font-size: var(--text-body)',
  'font-weight: var(--weight-regular)',
]) {
  if (!rendererBaseStyles.includes(requiredDeclaration)) {
    failures.push(`renderer 基础字体缺少声明：${requiredDeclaration}`)
  }
}

const rendererApp = readFileSync(
  join(sourceRoot, 'renderer', 'src', 'pages', 'workspace', 'index.tsx'),
  'utf8',
)
if (!rendererApp.includes('<AppearanceSystem>')) {
  failures.push('renderer 必须常驻挂载独立外观系统，不能依赖设置对话框应用主题')
}

const rendererFiles = sourceFiles(join(sourceRoot, 'renderer', 'src')).filter(path =>
  ['.ts', '.tsx'].includes(extname(path)),
)
for (const sourcePath of rendererFiles) {
  const source = readFileSync(sourcePath, 'utf8')
  const name = relative(root, sourcePath)
  if (/from\s+['"](?:node:|electron)/u.test(source))
    failures.push(`${name} 不得导入 Node 或 Electron`)
  if (/from\s+['"][^'"]*\/(?:main|runtime)\//u.test(source))
    failures.push(`${name} 不得越过平台契约导入主进程或后台运行时`)
}

// 后台业务可以使用 Node 与 Cordis，但不能取得 Electron 窗口或导入前端状态。
for (const sourcePath of sourceFiles(join(sourceRoot, 'runtime')).filter(
  path => extname(path) === '.ts',
)) {
  const source = readFileSync(sourcePath, 'utf8')
  if (/from\s+['"](?:electron|react|[^'"]*\/renderer\/)/u.test(source))
    failures.push(`${relative(root, sourcePath)} 不得依赖 Electron 或 renderer`)
}
const main = readFileSync(join(sourceRoot, 'main', 'index.ts'), 'utf8')
for (const setting of ['sandbox: true', 'contextIsolation: true', 'nodeIntegration: false']) {
  if (!main.includes(setting)) failures.push(`主窗口缺少安全设置：${setting}`)
}

for (const sourcePath of sourceFiles(join(sourceRoot, 'shared')).filter(
  path => extname(path) === '.ts',
)) {
  const source = readFileSync(sourcePath, 'utf8')
  const name = relative(root, sourcePath)
  if (/from\s+['"](?:node:|electron|react)/u.test(source)) {
    failures.push(`${name} 必须保持平台与框架无关`)
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exitCode = 1
} else {
  console.log(
    `verify-architecture: ${String(rendererFiles.length)} 个 renderer TypeScript 模块通过边界检查`,
  )
}
