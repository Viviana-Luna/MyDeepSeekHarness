import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const files = ['README.md', 'package.json', 'AGENTS.md']
// 目录归位不批量改写固定上游文字；仍检查 MyDSH 自有代码和来源修改说明。
const upstreamDirectories = new Set(
  JSON.parse(readFileSync(join(root, 'docs/upstream/dsh/manifest.json'), 'utf8')).packages.map(
    record => record.path,
  ),
)

function collect(directory) {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    if (entry.name.startsWith('.umi') || ['node_modules', 'lib'].includes(entry.name)) return []
    // manifest 记录的是 POSIX 风格路径；Windows 的 join 会给反斜杠，先统一再比对豁免名单。
    const path = join(directory, entry.name).replaceAll('\\', '/')
    if (upstreamDirectories.has(path)) return []
    if (entry.isDirectory()) return collect(path)
    return ['.md', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.swift'].includes(extname(entry.name))
      ? [path]
      : []
  })
}

for (const directory of ['docs', 'src', 'tests', 'scripts', 'native', 'packages'])
  files.push(...collect(directory))

const issueMarkers = [['TO', 'DO'].join(''), ['FIX', 'ME'].join(''), ['X', 'XX'].join('')]
const failures = []

for (const file of files) {
  const source = readFileSync(join(root, file), 'utf8')
  const markerPattern = new RegExp(`(?:${issueMarkers.join('|')})(?:\\([^)]*\\))?:`, 'u')
  if (markerPattern.test(source)) failures.push(`${file} 包含未归属的临时事项标记`)
}

const readme = readFileSync(join(root, 'README.md'), 'utf8')
if (/\bv\d+\.\d+\.\d+(?:-[\da-z.-]+)?\b/iu.test(readme)) {
  failures.push('README.md 不应硬编码当前发行版本')
}

// 产品首页与协作契约不得继续描述已移除的外部 Host 启动架构。
for (const file of ['README.md', 'AGENTS.md', 'docs/renderer.md', 'docs/release.md']) {
  const text = readFileSync(join(root, file), 'utf8')
  for (const obsolete of [
    '本机安装的 `dsh` 是唯一 Host',
    '应用不内置 DSH、Node、插件',
    'dsh web --no-open',
    '启动 URL 的 Cookie 交换',
  ]) {
    if (text.includes(obsolete)) failures.push(`${file} 仍描述旧运行架构：${obsolete}`)
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`verify-prose: ${failure}`)
  process.exitCode = 1
} else {
  console.log(`verify-prose: 已检查 ${String(files.length)} 个自有文字文件。`)
}
