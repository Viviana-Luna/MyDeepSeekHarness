/**
 * 从明确指定的上游工作树导入 MyDSH 使用的框架和业务源码。
 * 此命令仅用于开发时更新固定基线；应用构建和运行不访问该工作树。
 */
import { readdirSync, readFileSync, existsSync, mkdirSync, cpSync, writeFileSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

const source = resolve(process.argv[2] ?? '')
if (!process.argv[2]) throw new Error('请显式提供 DSH 源码目录')
const root = resolve(import.meta.dirname, '../..')
const previousProvenance = JSON.parse(
  readFileSync(join(root, 'docs/upstream/dsh/manifest.json'), 'utf8'),
)
const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: source,
  encoding: 'utf8',
}).trim()
if (sourceRevision !== previousProvenance.revision)
  throw new Error('更新基线前必须先审查并重建 MyDSH 补丁，不能直接覆盖固定移植层')
const requireSource = createRequire(join(source, 'package.json'))
const yaml = requireSource('js-yaml')
const schema = yaml.JSON_SCHEMA.extend(
  new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    construct: value => ({ __jsExpr: value }),
  }),
)
const base = yaml.load(
  readFileSync(join(source, 'packages/bundle/base/cordis.patch.yml'), 'utf8'),
  { schema },
)[0].insert
// 保留当前桌面功能所需的能力，排除 CLI、Web 外壳、遥测和其他平台入口。
const omit = new Set([
  'tool-plugin-manager',
  'plugin-manager',
  'hmr',
  'plugin-package-inventory-deepseek',
  'session-telemetry-otel',
  'ptc-runtime',
  'workflow-ptc',
  'tool-workflow',
  'tool-ralph',
  'web',
  'web-search-deepseek',
  'web-fetch-http',
  'tool-web',
])
const roster = base.filter(row => !omit.has(row.id))
const additions = [
  'workspace',
  'session-reference',
  'file-reference-local',
  'session-stats',
  'session-turn-outline',
  'message-feedback',
  'api-session-controller',
  'api-workspace-controller',
  'api-workspace-files',
  'api-settings-controller',
  'api-remotes',
  'client-connection',
  'client-file-upload',
  'agent-presets',
]
for (const name of additions) roster.push({ id: name, name: `@deepseek-ai/dsh-${name}` })
// 原生系统模块直接固定已发布二进制，不把原生仓库的构建工具带入产品。
const nativeVersions = { '@deepseek-ai/node-addon-system': '0.1.2' }
const all = new Map()
function scan(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      ['node_modules', 'lib', '.git', 'tests', 'fixtures'].includes(entry.name)
    )
      continue
    const path = join(dir, entry.name),
      file = join(path, 'package.json')
    if (existsSync(file)) {
      const manifest = JSON.parse(readFileSync(file, 'utf8'))
      if (manifest.name) all.set(manifest.name, { path, manifest })
    } else scan(path)
  }
}
scan(join(source, 'packages'))
scan(join(source, 'vendor'))
function packageName(spec) {
  return spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
}
const queue = [
  ...roster.map(row => packageName(row.name)),
  '@deepseek-ai/cordis-plugin-loader',
  '@deepseek-ai/cordis-plugin-include',
  '@deepseek-ai/dsh-typert-generator',
]
const selected = new Map()
while (queue.length) {
  const name = queue.shift()
  if (selected.has(name)) continue
  const pkg = all.get(name)
  if (!pkg) throw new Error(`找不到所选上游包：${name}`)
  selected.set(name, pkg)
  for (const dep of Object.keys({ ...pkg.manifest.dependencies, ...pkg.manifest.peerDependencies }))
    if (all.has(dep)) queue.push(dep)
}
const rewrite = value =>
  typeof value === 'string'
    ? value.replace(/^(\.\/)?lib\/types\//, '$1types/')
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]))
      : value
const records = []
for (const [name, { path, manifest }] of selected) {
  const local = join(root, relative(source, path)),
    src = join(path, 'src')
  mkdirSync(local, { recursive: true })
  if (existsSync(src))
    cpSync(src, join(local, 'src'), {
      recursive: true,
      filter: p => !/(?:\.spec|\.test)\.[cm]?tsx?$/.test(p),
    })
  for (const entry of ['assets', 'presets', 'config', 'LICENSE', 'LICENSE.md', 'README.zh.md'])
    if (existsSync(join(path, entry)))
      cpSync(join(path, entry), join(local, entry), { recursive: true })
  if (existsSync(join(path, 'lib/types')))
    cpSync(join(path, 'lib/types'), join(local, 'types'), {
      recursive: true,
      filter: p => !p.endsWith('.map'),
    })
  // 固定基线的协议模型作为源码快照保存；后续修改 Remote 时由 Typert 重新生成。
  for (const entry of [
    'typert.host.js',
    'typert.remote-client.js',
    'typert.host.d.ts',
    'typert.remote-client.d.ts',
  ])
    if (existsSync(join(path, 'lib', entry))) {
      mkdirSync(join(local, 'contracts'), { recursive: true })
      cpSync(join(path, 'lib', entry), join(local, 'contracts', entry))
    }
  writeFileSync(join(local, 'upstream-package.json'), JSON.stringify(manifest, null, 2) + '\n')
  const adapted = {
    ...manifest,
    private: true,
    types: rewrite(manifest.types),
    exports: rewrite(manifest.exports),
  }
  for (const key of ['scripts', 'devDependencies', 'publishConfig', 'dsh']) delete adapted[key]
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies'])
    if (adapted[field]) {
      adapted[field] = { ...adapted[field] }
      for (const dependency of Object.keys(adapted[field]))
        if (nativeVersions[dependency]) adapted[field][dependency] = nativeVersions[dependency]
    }
  writeFileSync(join(local, 'package.json'), JSON.stringify(adapted, null, 2) + '\n')
  records.push({
    name,
    path: relative(root, local),
    source: relative(source, path),
    version: manifest.version,
  })
}
const notice = join(root, 'docs/upstream/dsh')
mkdirSync(notice, { recursive: true })
cpSync(join(source, 'LICENSE'), join(notice, 'LICENSE'))
const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: source,
  encoding: 'utf8',
}).trim()
writeFileSync(
  join(notice, 'manifest.json'),
  JSON.stringify(
    {
      repository: 'https://github.com/deepseek-ai/deepseek-harness',
      revision,
      backports: previousProvenance.backports,
      packages: records,
    },
    null,
    2,
  ) + '\n',
)
roster.find(row => row.id === 'message-feedback').config = { maxNoteBytes: 8192 }
writeFileSync(join(root, 'packages/runtime/roster.json'), JSON.stringify(roster, null, 2) + '\n')
// Windows ACL 修复先完整重放，再应用 MyDSH 的启动与异步终端适配。
for (const name of ['windows-acl-delete.patch', 'windows-runtime.patch'])
  execFileSync('git', ['apply', join(root, 'scripts/core/patches', name)], {
    cwd: root,
    stdio: 'inherit',
  })
// utilityProcess 的可执行文件不能直接充当 CLI；用应用主程序的 Node 模式启动私有 runner。
const runner = join(root, 'packages/subprocess/subprocess-local/src/runner-launch.ts')
writeFileSync(
  runner,
  readFileSync(runner, 'utf8')
    .replace(
      'return [process.execPath,',
      'return [process.env.MYDSH_NODE_EXECUTABLE ?? process.execPath,',
    )
    .replace(
      "SYSTEMD_LOG_TARGET: 'null',",
      "SYSTEMD_LOG_TARGET: 'null',\n    ...(process.env.MYDSH_NODE_EXECUTABLE ? { ELECTRON_RUN_AS_NODE: '1' } : {}),",
    ),
)
// MyDSH 只提供本地 IPC。补丁同时更新源码和声明；上游变化导致无法重放时必须人工审查。
execFileSync('git', ['apply', join(root, 'scripts/core/patches/connection-ipc.patch')], {
  cwd: root,
  stdio: 'inherit',
})
console.log(`导入 ${records.length} 个框架与业务源码包；基线 ${revision}`)
