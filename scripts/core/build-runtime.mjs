/* oxlint-disable no-await-in-loop -- 模块输出与依赖提升按顺序写入，防止同路径发生竞争。 */
/** 构建固定版本的离线核心：源码逐包编译，运行依赖闭包随安装包交付。 */
import { build, transform } from 'esbuild'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { cp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { buildChatGPT } from '../../packages/llm/llm-chatgpt/build.mjs'
import { buildSsh } from '../../packages/connections/ssh/build.mjs'
import { buildDatabase } from '../../packages/connections/database/build.mjs'
import { buildDesktopServices } from '../../packages/desktop-services/build.mjs'
import { prepareWindowsTools } from './windows-tools.mjs'
import { patchNodePty } from './patch-node-pty.mjs'
const root = resolve(import.meta.dirname, '../..')
const provenance = JSON.parse(await readFile(join(root, 'docs/upstream/dsh/manifest.json'), 'utf8'))
const app = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const bundle = join(root, 'lib/mydsh-runtime'),
  payload = join(bundle, 'payload')
const records = new Map(provenance.packages.map(p => [p.name, p]))
const sshPath = 'packages/connections/ssh'
const sshPackage = JSON.parse(await readFile(join(root, sshPath, 'package.json'), 'utf8'))
records.set(sshPackage.name, { name: sshPackage.name, path: sshPath, version: sshPackage.version })
const databasePath = 'packages/connections/database'
const databasePackage = JSON.parse(await readFile(join(root, databasePath, 'package.json'), 'utf8'))
records.set(databasePackage.name, {
  name: databasePackage.name,
  path: databasePath,
  version: databasePackage.version,
})
const accessPath = 'packages/connections/access'
const accessPackage = JSON.parse(await readFile(join(root, accessPath, 'package.json'), 'utf8'))
records.set(accessPackage.name, {
  name: accessPackage.name,
  path: accessPath,
  version: accessPackage.version,
})
// MyDSH 自有提供商单独登记，不写入固定上游来源清单。
const chatgptPath = 'packages/llm/llm-chatgpt'
const chatgptPackage = JSON.parse(await readFile(join(root, chatgptPath, 'package.json'), 'utf8'))
records.set(chatgptPackage.name, {
  name: chatgptPackage.name,
  path: chatgptPath,
  version: chatgptPackage.version,
})
const compactionPath = 'packages/compaction/compaction-chatgpt'
const compactionPackage = JSON.parse(
  await readFile(join(root, compactionPath, 'package.json'), 'utf8'),
)
records.set(compactionPackage.name, {
  name: compactionPackage.name,
  path: compactionPath,
  version: compactionPackage.version,
})
const reviewPath = 'packages/interaction/auto-review'
const reviewPackage = JSON.parse(await readFile(join(root, reviewPath, 'package.json'), 'utf8'))
records.set(reviewPackage.name, {
  name: reviewPackage.name,
  path: reviewPath,
  version: reviewPackage.version,
})
const browserAutomationPath = 'packages/automation/browser'
const browserAutomationPackage = JSON.parse(
  await readFile(join(root, browserAutomationPath, 'package.json'), 'utf8'),
)
records.set(browserAutomationPackage.name, {
  name: browserAutomationPackage.name,
  path: browserAutomationPath,
  version: browserAutomationPackage.version,
})
const computerUsePath = 'packages/automation/computer-use'
const computerUsePackage = JSON.parse(
  await readFile(join(root, computerUsePath, 'package.json'), 'utf8'),
)
records.set(computerUsePackage.name, {
  name: computerUsePackage.name,
  path: computerUsePath,
  version: computerUsePackage.version,
})
const cliBridgePath = 'packages/cli/cli-bridge'
const cliBridgePackage = JSON.parse(
  await readFile(join(root, cliBridgePath, 'package.json'), 'utf8'),
)
records.set(cliBridgePackage.name, {
  name: cliBridgePackage.name,
  path: cliBridgePath,
  version: cliBridgePackage.version,
})
const fix = value =>
  typeof value === 'string'
    ? value.replace('./lib/types/', './lib/').replace(/\.[cm]js$/, '.js')
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fix(v)]))
      : value
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))
const exists = async path =>
  stat(path).then(
    () => true,
    () => false,
  )
async function walk(dir) {
  const paths = []
  for (const f of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, f.name)
    if (f.isDirectory()) paths.push(...(await walk(p)))
    else paths.push(p)
  }
  return paths
}
// 编译到各包自身 lib，确保开发 renderer 与正式核心使用同一份 Cordis。
for (const record of records.values()) {
  const directory = join(root, record.path),
    source = join(directory, 'src'),
    lib = join(directory, 'lib')
  await rm(lib, { recursive: true, force: true })
  await mkdir(lib, { recursive: true })
  if (await exists(source))
    for (const path of await walk(source)) {
      if (!/\.[cm]?tsx?$/.test(path) || path.endsWith('.d.ts')) continue
      const out = join(lib, relative(source, path).replace(/\.[cm]?tsx?$/, '.js'))
      await mkdir(dirname(out), { recursive: true })
      const result = await transform(await readFile(path, 'utf8'), {
        loader: path.endsWith('tsx') ? 'tsx' : 'ts',
        format: 'esm',
        target: 'es2024',
        sourcefile: relative(root, path),
        tsconfigRaw: {
          compilerOptions: { experimentalDecorators: false, useDefineForClassFields: true },
        },
        logLevel: 'error',
      })
      await writeFile(
        out,
        result.code.replace(
          /(from\s*['"]|import\s*\(\s*['"])([^'"]+)\.(?:tsx?|mts)(['"])/g,
          '$1$2.js$3',
        ),
      )
    }
  if (await exists(join(directory, 'contracts')))
    await cp(join(directory, 'contracts'), lib, { recursive: true })
  const manifest = await readJson(join(directory, 'package.json'))
  // 上游 bundled entry 与逐文件编译路径对齐，类型快照保留在 types/。
  manifest.exports = fix(manifest.exports)
  manifest.main = fix(manifest.main)
  if (manifest.module) manifest.module = fix(manifest.module)
  for (const [key, value] of Object.entries(manifest.exports || {})) {
    const target = typeof value === 'string' ? value : value.default
    if (
      !target ||
      target.includes('*') ||
      !target.endsWith('.js') ||
      (await exists(join(directory, target)))
    )
      continue
    const sub = key === '.' ? 'index' : key.slice(2)
    const candidate = join(lib, sub, 'index.js')
    if (await exists(candidate))
      await writeFile(
        join(directory, target),
        `export * from './${relative(lib, candidate).split(/[\\/]/).join('/')}'\n`,
      )
  }
  await writeFile(join(directory, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
}
// bin.js 被包装入口导入时 import.meta.main 为 false，必须显式进入私有 runner。
await writeFile(
  join(root, records.get('@deepseek-ai/dsh-subprocess-local').path, 'lib/runner.js'),
  "import { consumeRunnerSelection } from './runner-launch.js'\nimport { runSelectedSubprocessRunner } from './bin.js'\nconst selection = consumeRunnerSelection()\nif (selection === undefined) process.exitCode = 127\nelse await runSelectedSubprocessRunner(selection)\n",
)
await writeFile(
  join(root, records.get('@deepseek-ai/dsh-session-persistence-jsonl').path, 'lib/worker.cjs'),
  "void import('./worker.js')\n",
)
if (process.argv.includes('--libraries-only')) process.exit(0)
await rm(bundle, { recursive: true, force: true })
await mkdir(payload, { recursive: true })
const installed = new Map()
/** 工作区链接由 pnpm 管理；离线制品中的依赖声明固定到实际随包版本。 */
function pinWorkspaceDependencies(manifest) {
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies'])
    for (const [name, version] of Object.entries(manifest[field] || {}))
      if (version.startsWith('workspace:')) {
        const record = records.get(name)
        if (!record) throw new Error(`无法固定工作区依赖版本：${manifest.name} → ${name}`)
        manifest[field][name] = record.version
      }
}
/** 按 Node 查找规则提升相同依赖，版本冲突只安装到消费者目录，产物不含符号链接。 */
async function install(name, sourceDirectory, consumer = payload) {
  const canonical = await realpath(sourceDirectory),
    meta = await readJson(join(canonical, 'package.json'))
  let target = join(payload, 'node_modules', name)
  const previous = installed.get(target)
  if (previous && previous !== canonical) target = join(consumer, 'node_modules', name)
  if (installed.get(target) === canonical) return
  if (installed.has(target)) throw new Error(`依赖版本冲突：${name}`)
  installed.set(target, canonical)
  await mkdir(dirname(target), { recursive: true })
  // Windows 的 relative() 返回反斜杠，只按 / 切分会漏掉全部过滤项，把 node_modules 等打进离线核心。
  // 上游包的类型快照位于 types；自有包以 src 提供类型，交付时保留。
  const excluded = records.has(name)
    ? [
        'node_modules',
        '.git',
        ...(records.get(name).source ? ['src'] : []),
        'upstream-package.json',
        'contracts',
      ]
    : ['node_modules', '.git']
  await cp(canonical, target, {
    recursive: true,
    dereference: true,
    filter: path => !excluded.includes(relative(canonical, path).split(/[\\/]/)[0]),
  })
  if (process.platform === 'win32' && name === 'node-pty' && meta.version !== '1.1.0')
    await patchNodePty(target, meta.version)
  if (records.has(name)) {
    pinWorkspaceDependencies(meta)
    delete meta.devDependencies
    delete meta.scripts
    delete meta.dsh
    await writeFile(join(target, 'package.json'), JSON.stringify(meta, null, 2) + '\n')
  }
  const req = createRequire(join(canonical, 'package.json'))
  for (const [dep] of Object.entries({
    ...meta.dependencies,
    ...meta.optionalDependencies,
    ...(records.has(name) ? meta.peerDependencies : {}),
  })) {
    let directory
    if (records.has(dep)) directory = join(root, records.get(dep).path)
    else {
      const search = req.resolve.paths(dep) || []
      for (const candidate of search)
        if (await exists(join(candidate, dep, 'package.json'))) {
          directory = join(candidate, dep)
          break
        }
    }
    if (!directory) {
      if (meta.optionalDependencies?.[dep] || meta.peerDependenciesMeta?.[dep]?.optional) continue
      throw new Error(`缺少运行依赖：${name} → ${dep}`)
    }
    await install(dep, directory, target)
  }
}
for (const record of records.values()) await install(record.name, join(root, record.path))
await cp(
  join(root, 'docs/plugin-development.zh.md'),
  join(payload, 'node_modules/@mydsh/cli-bridge/skills/mydsh-plugin-development/development.md'),
)
for (const name of [
  'typescript',
  'esbuild',
  'npm',
  '@types/node',
  '@types/react',
  '@types/react-dom',
  '@vscode/ripgrep',
])
  await install(name, join(root, 'node_modules', name))
await cp(join(root, 'packages/runtime/roster.json'), join(payload, 'roster.json'))
await cp(join(root, 'packages/runtime/entry.mjs'), join(payload, 'entry.js'))
for (const name of [
  'directory-picker',
  'plugin-tools',
  'plugin-resolution',
  'plugin-typert',
  'subprocess',
  'windows-private-directory',
])
  await cp(join(root, `packages/runtime/${name}.mjs`), join(payload, `${name}.js`))
await cp(join(root, 'packages/runtime/private-files.mjs'), join(payload, 'private-files.mjs'))
await cp(join(root, 'packages/plugin-sdk'), join(payload, 'node_modules/@mydsh/sdk'), {
  recursive: true,
  filter: path =>
    !relative(join(root, 'packages/plugin-sdk'), path).split(/[\\/]/).includes('node_modules'),
})
await import('../../packages/ui-sdk/build.mjs')
await cp(join(root, 'packages/ui-sdk'), join(payload, 'node_modules/@mydsh/ui'), {
  recursive: true,
  filter: path =>
    !/(?:^|[\\/])build\.mjs$/.test(path) &&
    !relative(join(root, 'packages/ui-sdk'), path).split(/[\\/]/).includes('node_modules'),
})
await writeFile(
  join(payload, 'package.json'),
  JSON.stringify({ name: 'mydsh-runtime', version: app.version, type: 'module', private: true }) +
    '\n',
)
await buildChatGPT(payload)
await buildSsh(payload)
await buildDatabase(payload)
await cp(join(root, sshPath, 'lib'), join(payload, 'node_modules/@mydsh/ssh/lib'), {
  recursive: true,
})
await cp(join(root, databasePath, 'lib'), join(payload, 'node_modules/@mydsh/database/lib'), {
  recursive: true,
})
await cp(join(root, chatgptPath, 'lib'), join(payload, 'node_modules/@mydsh/llm-chatgpt/lib'), {
  recursive: true,
})
await buildDesktopServices(payload, join(payload, 'node_modules/@mydsh/desktop-services'))
for (const name of ['@mydsh/sdk', '@mydsh/ui', '@mydsh/desktop-services']) {
  const file = join(payload, 'node_modules', name, 'package.json'),
    manifest = await readJson(file)
  pinWorkspaceDependencies(manifest)
  await writeFile(file, JSON.stringify(manifest, null, 2) + '\n')
}
await install(
  'node-pty',
  join(root, 'node_modules/node-pty'),
  join(payload, 'node_modules/@mydsh/desktop-services'),
)
await build({
  entryPoints: [join(root, 'src/runtime/plugins/index.ts')],
  outfile: join(payload, 'services/plugins.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'es2024',
  packages: 'external',
})
// 上游多数业务包共用根许可证，必须随已安装核心保留来源、原许可和适配记录。
const sourceNotice = join(payload, 'licenses/deepseek-harness')
await mkdir(sourceNotice, { recursive: true })
for (const name of ['LICENSE', 'manifest.json', 'README.zh.md'])
  await cp(join(root, 'docs/upstream/dsh', name), join(sourceNotice, name))
await prepareWindowsTools(payload)
const files = {}
// 清单键必须是跨平台一致的 / 形式：Windows 的 relative() 返回反斜杠，安装器的相对路径校验会拒绝它。
for (const path of (await walk(payload)).toSorted()) {
  const bytes = await readFile(path),
    info = await stat(path)
  files[relative(payload, path).split(/[\\/]/).join('/')] = {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    ...(info.mode & 0o111 ? { executable: true } : {}),
  }
}
await writeFile(
  join(bundle, 'manifest.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      platform: process.platform,
      arch: process.arch,
      version: app.version,
      apiVersion: 1,
      dataSchemaVersion: 1,
      entry: 'entry.js',
      files,
    },
    null,
    2,
  ) + '\n',
)
console.log(
  `MyDSH 离线核心已构建：${Object.keys(files).length} 个文件，${records.size} 个源码模块。`,
)
