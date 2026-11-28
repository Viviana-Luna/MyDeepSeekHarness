/**
 * 构建固定版本的离线核心：源码并发编译、依赖闭包按 Node 规则提升、21k+ 文件并发摘要，
 * 并通过输入内容指纹缓存跳过未变更的重复编译与打包。
 */
/* oxlint-disable no-await-in-loop -- 依赖树提升与清单修补按拓扑顺序写入，避免同目录竞争。 */
import { build, transform } from 'esbuild'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { buildDatabase } from '../../packages/connections/database/build.mjs'
import { buildSsh } from '../../packages/connections/ssh/build.mjs'
import { buildDesktopServices } from '../../packages/desktop-services/build.mjs'
import { buildChatGPT } from '../../packages/llm/llm-chatgpt/build.mjs'
import { buildUiSdk } from '../../packages/ui-sdk/build.mjs'
import { patchNodePty } from './patch-node-pty.mjs'
import { packRuntimeAsar, pruneRuntimeStaging } from './runtime-prune.mjs'
import { prepareWindowsTools } from './windows-tools.mjs'

const root = resolve(import.meta.dirname, '../..')
const cachePath = join(root, '.build/runtime-build-cache.json')
const bundle = join(root, 'lib/mydsh-runtime')
const payload = join(root, '.build/runtime-staging')
const librariesOnly = process.argv.includes('--libraries-only')
const forceBuild = process.argv.includes('--force')

const LOCAL_PACKAGE_PATHS = [
  'packages/connections/ssh',
  'packages/connections/database',
  'packages/connections/access',
  'packages/llm/llm-chatgpt',
  'packages/compaction/compaction-chatgpt',
  'packages/interaction/auto-review',
  'packages/automation/browser',
  'packages/automation/computer-use',
  'packages/cli/cli-bridge',
]

const SKIPPED_HASH_DIRS = new Set([
  'lib',
  'dist',
  'node_modules',
  '.git',
  '.umi',
  '.umi-production',
  '.umi-test',
])

const readJson = async path => JSON.parse(await readFile(path, 'utf8'))
const exists = async path =>
  stat(path).then(
    () => true,
    () => false,
  )

function fixExportEntry(value) {
  if (typeof value === 'string') {
    return value.replace('./lib/types/', './lib/').replace(/\.[cm]js$/u, '.js')
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fixExportEntry(v)]))
  }
  return value
}

function runConcurrent(items, concurrency, worker) {
  let cursor = 0
  const results = Array.from({ length: items.length })
  const step = async () => {
    const index = cursor
    cursor += 1
    if (index >= items.length) return
    results[index] = await worker(items[index], index)
    await step()
  }
  const count = Math.min(concurrency, items.length)
  return Promise.all(Array.from({ length: count }, () => step())).then(() => results)
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(entry => {
      const fullPath = join(directory, entry.name)
      return entry.isDirectory() ? walk(fullPath) : Promise.resolve([fullPath])
    }),
  )
  return nested.flat()
}

function hashInputPathSync(hash, relativeTarget) {
  const fullTarget = join(root, relativeTarget)
  if (!existsSync(fullTarget)) {
    hash.update(`missing:${relativeTarget}\0`)
    return
  }
  const stack = [fullTarget]
  while (stack.length > 0) {
    const current = stack.pop()
    const entries = readdirSync(current, { withFileTypes: true }).toSorted((a, b) =>
      b.name.localeCompare(a.name),
    )
    for (const entry of entries) {
      if (SKIPPED_HASH_DIRS.has(entry.name) || entry.name.startsWith('.umi')) continue
      const childPath = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(childPath)
      } else {
        const key = relative(root, childPath).replaceAll('\\', '/')
        hash.update(`file:${key}\0`)
        hash.update(readFileSync(childPath))
        hash.update('\0')
      }
    }
  }
}

function hashSingleFileSync(hash, relativeFile) {
  const fullFile = join(root, relativeFile)
  if (!existsSync(fullFile)) {
    hash.update(`missing:${relativeFile}\0`)
    return
  }
  hash.update(`file:${relativeFile}\0`)
  hash.update(readFileSync(fullFile))
  hash.update('\0')
}

function computeLibrariesHash(records) {
  const hash = createHash('sha256')
  for (const file of [
    'package.json',
    'pnpm-lock.yaml',
    'docs/upstream/dsh/manifest.json',
    'scripts/core/build-runtime.mjs',
  ]) {
    hashSingleFileSync(hash, file)
  }
  for (const record of records.values()) {
    hashInputPathSync(hash, record.path)
  }
  return hash.digest('hex')
}

function hashExactDirectorySync(hash, relativeTarget) {
  const fullTarget = join(root, relativeTarget)
  if (!existsSync(fullTarget)) {
    hash.update(`missing:${relativeTarget}\0`)
    return
  }
  const stack = [fullTarget]
  while (stack.length > 0) {
    const current = stack.pop()
    const entries = readdirSync(current, { withFileTypes: true }).toSorted((a, b) =>
      b.name.localeCompare(a.name),
    )
    for (const entry of entries) {
      const childPath = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(childPath)
      } else {
        const key = relative(root, childPath).replaceAll('\\', '/')
        hash.update(`file:${key}\0`)
        hash.update(readFileSync(childPath))
        hash.update('\0')
      }
    }
  }
}

function computeBundleHash(librariesHash) {
  const hash = createHash('sha256')
  hash.update(`libs:${librariesHash}\0platform:${process.platform}\0arch:${process.arch}\0`)
  for (const file of ['docs/plugin-development.zh.md', 'tsconfig.json']) {
    hashSingleFileSync(hash, file)
  }
  for (const directory of [
    'docs/upstream/dsh',
    'packages/runtime',
    'packages/plugin-sdk',
    'packages/ui-sdk',
    'packages/desktop-services',
    'src/runtime',
    'src/shared',
    'scripts/core',
  ]) {
    hashInputPathSync(hash, directory)
  }
  hashExactDirectorySync(hash, 'packages/ui-sdk/lib')
  return hash.digest('hex')
}

function readBuildCache() {
  if (!existsSync(cachePath)) return {}
  try {
    return JSON.parse(readFileSync(cachePath, 'utf8'))
  } catch {
    return {}
  }
}

function areLibrariesReady(records) {
  for (const record of records.values()) {
    if (!existsSync(join(root, record.path, 'lib'))) return false
  }
  return (
    existsSync(
      join(root, records.get('@deepseek-ai/dsh-subprocess-local').path, 'lib/runner.js'),
    ) &&
    existsSync(
      join(root, records.get('@deepseek-ai/dsh-session-persistence-jsonl').path, 'lib/worker.cjs'),
    )
  )
}

function isBundleReady(expectedVersion) {
  const manifestFile = join(bundle, 'manifest.json')
  if (!existsSync(manifestFile) || !existsSync(join(bundle, 'runtime.asar'))) return false
  try {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    return (
      manifest.version === expectedVersion &&
      manifest.archive === 'runtime.asar' &&
      manifest.platform === process.platform &&
      manifest.arch === process.arch
    )
  } catch {
    return false
  }
}

async function loadPackageRecords() {
  const provenance = await readJson(join(root, 'docs/upstream/dsh/manifest.json'))
  const records = new Map(provenance.packages.map(pkg => [pkg.name, pkg]))
  // MyDSH 自有业务包单独登记，不写入固定上游来源清单。
  for (const packagePath of LOCAL_PACKAGE_PATHS) {
    const pkg = await readJson(join(root, packagePath, 'package.json'))
    records.set(pkg.name, { name: pkg.name, path: packagePath, version: pkg.version })
  }
  return records
}

async function compileSourceFile(sourceRoot, filePath, libDirectory) {
  const out = join(libDirectory, relative(sourceRoot, filePath).replace(/\.[cm]?tsx?$/u, '.js'))
  await mkdir(dirname(out), { recursive: true })
  const result = await transform(await readFile(filePath, 'utf8'), {
    loader: filePath.endsWith('tsx') ? 'tsx' : 'ts',
    format: 'esm',
    target: 'es2024',
    sourcefile: relative(root, filePath),
    tsconfigRaw: {
      compilerOptions: { experimentalDecorators: false, useDefineForClassFields: true },
    },
    logLevel: 'error',
  })
  await writeFile(
    out,
    result.code.replace(
      /(from\s*['"]|import\s*\(\s*['"])([^'"]+)\.(?:tsx?|mts)(['"])/gu,
      '$1$2.js$3',
    ),
  )
}

async function compilePackageLibrary(record) {
  const directory = join(root, record.path)
  const source = join(directory, 'src')
  const lib = join(directory, 'lib')
  await rm(lib, { recursive: true, force: true })
  await mkdir(lib, { recursive: true })
  if (await exists(source)) {
    const sourceFiles = (await walk(source)).filter(
      path => /\.[cm]?tsx?$/u.test(path) && !path.endsWith('.d.ts'),
    )
    await runConcurrent(sourceFiles, 24, path => compileSourceFile(source, path, lib))
  }
  if (await exists(join(directory, 'contracts'))) {
    await cp(join(directory, 'contracts'), lib, { recursive: true })
  }
  const manifest = await readJson(join(directory, 'package.json'))
  // 上游 bundled entry 与逐文件编译路径对齐，类型快照保留在 types/。
  manifest.exports = fixExportEntry(manifest.exports)
  manifest.main = fixExportEntry(manifest.main)
  if (manifest.module) manifest.module = fixExportEntry(manifest.module)
  for (const [key, value] of Object.entries(manifest.exports || {})) {
    const target = typeof value === 'string' ? value : value.default
    if (
      !target ||
      target.includes('*') ||
      !target.endsWith('.js') ||
      (await exists(join(directory, target)))
    ) {
      continue
    }
    const sub = key === '.' ? 'index' : key.slice(2)
    const candidate = join(lib, sub, 'index.js')
    if (await exists(candidate)) {
      await writeFile(
        join(directory, target),
        `export * from './${relative(lib, candidate).split(/[\\/]/u).join('/')}'\n`,
      )
    }
  }
  await writeFile(join(directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

async function buildAllLibraries(records) {
  await runConcurrent([...records.values()], 6, record => compilePackageLibrary(record))
  // bin.js 被包装入口导入时 import.meta.main 为 false，必须显式进入私有 runner。
  await writeFile(
    join(root, records.get('@deepseek-ai/dsh-subprocess-local').path, 'lib/runner.js'),
    "import { consumeRunnerSelection } from './runner-launch.js'\nimport { runSelectedSubprocessRunner } from './bin.js'\nconst selection = consumeRunnerSelection()\nif (selection === undefined) process.exitCode = 127\nelse await runSelectedSubprocessRunner(selection)\n",
  )
  await writeFile(
    join(root, records.get('@deepseek-ai/dsh-session-persistence-jsonl').path, 'lib/worker.cjs'),
    "void import('./worker.js')\n",
  )
}

/** 工作区链接由 pnpm 管理；离线制品中的依赖声明固定到实际随包版本。 */
function pinWorkspaceDependencies(manifest, records) {
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, version] of Object.entries(manifest[field] || {})) {
      if (version.startsWith('workspace:')) {
        const record = records.get(name)
        if (!record) throw new Error(`无法固定工作区依赖版本：${manifest.name} → ${name}`)
        manifest[field][name] = record.version
      }
    }
  }
}

async function resolveDependencyDirectory(records, req, dep) {
  if (records.has(dep)) return join(root, records.get(dep).path)
  for (const candidate of req.resolve.paths(dep) || []) {
    if (await exists(join(candidate, dep, 'package.json'))) {
      return join(candidate, dep)
    }
  }
  return undefined
}

/** 按 Node 查找规则提升相同依赖，版本冲突只安装到消费者目录，产物不含符号链接。 */
async function installPackageClosure(context, name, sourceDirectory, consumer = payload) {
  const { records, installed } = context
  const canonical = await realpath(sourceDirectory)
  const meta = await readJson(join(canonical, 'package.json'))
  let target = join(payload, 'node_modules', name)
  const previous = installed.get(target)
  if (previous && previous !== canonical) target = join(consumer, 'node_modules', name)
  if (installed.get(target) === canonical) return
  if (installed.has(target)) throw new Error(`依赖版本冲突：${name}`)
  installed.set(target, canonical)
  await mkdir(dirname(target), { recursive: true })
  // Windows 的 relative() 返回反斜杠，必须兼容两种分隔符，避免把 node_modules 打进离线核心。
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
    filter: path => !excluded.includes(relative(canonical, path).split(/[\\/]/u)[0]),
  })
  if (process.platform === 'win32' && name === 'node-pty') {
    await patchNodePty(target, meta.version)
  }
  if (records.has(name)) {
    pinWorkspaceDependencies(meta, records)
    delete meta.devDependencies
    delete meta.scripts
    delete meta.dsh
    await writeFile(join(target, 'package.json'), `${JSON.stringify(meta, null, 2)}\n`)
  }
  const req = createRequire(join(canonical, 'package.json'))
  const dependencyMap = {
    ...meta.dependencies,
    ...meta.optionalDependencies,
    ...(records.has(name) ? meta.peerDependencies : {}),
  }
  for (const [dep] of Object.entries(dependencyMap)) {
    const directory = await resolveDependencyDirectory(records, req, dep)
    if (!directory) {
      if (meta.optionalDependencies?.[dep] || meta.peerDependenciesMeta?.[dep]?.optional) continue
      throw new Error(`缺少运行依赖：${name} → ${dep}`)
    }
    await installPackageClosure(context, dep, directory, target)
  }
}

async function copyRuntimeAssetsAndServices(appVersion, context) {
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
  ]) {
    await installPackageClosure(context, name, join(root, 'node_modules', name))
  }
  await cp(join(root, 'packages/runtime/roster.json'), join(payload, 'roster.json'))
  await cp(join(root, 'packages/runtime/entry.mjs'), join(payload, 'entry.js'))
  for (const name of [
    'directory-picker',
    'plugin-tools',
    'plugin-resolution',
    'plugin-typert',
    'subprocess',
    'windows-private-directory',
  ]) {
    await cp(join(root, `packages/runtime/${name}.mjs`), join(payload, `${name}.js`))
  }
  await cp(join(root, 'packages/runtime/private-files.mjs'), join(payload, 'private-files.mjs'))
  await cp(join(root, 'packages/runtime/canonical-path.mjs'), join(payload, 'canonical-path.mjs'))
  await cp(join(root, 'packages/plugin-sdk'), join(payload, 'node_modules/@mydsh/sdk'), {
    recursive: true,
    filter: path =>
      !relative(join(root, 'packages/plugin-sdk'), path).split(/[\\/]/u).includes('node_modules'),
  })
  await cp(join(root, 'packages/ui-sdk'), join(payload, 'node_modules/@mydsh/ui'), {
    recursive: true,
    filter: path =>
      !/(?:^|[\\/])build\.mjs$/u.test(path) &&
      !relative(join(root, 'packages/ui-sdk'), path).split(/[\\/]/u).includes('node_modules'),
  })
  await writeFile(
    join(payload, 'package.json'),
    `${JSON.stringify({ name: 'mydsh-runtime', version: appVersion, type: 'module', private: true })}\n`,
  )
}

async function bundleDesktopModules(context) {
  const { records } = context
  await Promise.all([buildChatGPT(payload), buildSsh(payload), buildDatabase(payload)])
  await Promise.all([
    cp(join(root, 'packages/connections/ssh/lib'), join(payload, 'node_modules/@mydsh/ssh/lib'), {
      recursive: true,
    }),
    cp(
      join(root, 'packages/connections/database/lib'),
      join(payload, 'node_modules/@mydsh/database/lib'),
      { recursive: true },
    ),
    cp(
      join(root, 'packages/llm/llm-chatgpt/lib'),
      join(payload, 'node_modules/@mydsh/llm-chatgpt/lib'),
      { recursive: true },
    ),
  ])
  await buildDesktopServices(payload, join(payload, 'node_modules/@mydsh/desktop-services'))
  for (const name of ['@mydsh/sdk', '@mydsh/ui', '@mydsh/desktop-services']) {
    const file = join(payload, 'node_modules', name, 'package.json')
    const manifest = await readJson(file)
    pinWorkspaceDependencies(manifest, records)
    await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`)
  }
  await installPackageClosure(
    context,
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
}

function stopStagedEsbuild() {
  try {
    const requireStaged = createRequire(join(payload, 'package.json'))
    const stagedEsbuild = requireStaged('esbuild')
    stagedEsbuild.stop?.()
  } catch {
    /* 暂存目录尚未安装 esbuild 或服务未启动时无需停止。 */
  }
}

async function removeStagingDirectory() {
  stopStagedEsbuild()
  await rm(payload, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}

async function writeRuntimeManifest(appVersion, moduleCount) {
  stopStagedEsbuild()
  await pruneRuntimeStaging(payload)
  await rm(bundle, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  await mkdir(bundle, { recursive: true })
  await packRuntimeAsar(payload, join(bundle, 'runtime.asar'))
  await removeStagingDirectory()

  const sourceNotice = join(bundle, 'licenses/deepseek-harness')
  await mkdir(sourceNotice, { recursive: true })
  for (const name of ['LICENSE', 'manifest.json', 'README.zh.md']) {
    await cp(join(root, 'docs/upstream/dsh', name), join(sourceNotice, name))
  }
  await prepareWindowsTools(bundle)
  const sortedPaths = (await walk(bundle)).toSorted()
  // 清单键必须是跨平台一致的 / 形式：并发计算磁盘物理文件摘要后按字典序组装。
  const entries = await runConcurrent(sortedPaths, 32, async path => {
    const [bytes, info] = await Promise.all([readFile(path), stat(path)])
    const key = relative(bundle, path).split(/[\\/]/u).join('/')
    return [
      key,
      {
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
        ...(info.mode & 0o111 ? { executable: true } : {}),
      },
    ]
  })
  const files = Object.fromEntries(entries)
  await writeFile(
    join(bundle, 'manifest.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        platform: process.platform,
        arch: process.arch,
        version: appVersion,
        apiVersion: 1,
        dataSchemaVersion: 1,
        archive: 'runtime.asar',
        entry: 'entry.js',
        files,
      },
      null,
      2,
    )}\n`,
  )
  console.log(
    `MyDSH 离线核心已构建：${String(entries.length)} 个物理文件（含 runtime.asar），${String(moduleCount)} 个源码模块。`,
  )
}

const app = await readJson(join(root, 'package.json'))
const records = await loadPackageRecords()
const cached = readBuildCache()
const initialLibrariesHash = computeLibrariesHash(records)
const librariesCached =
  !forceBuild && cached.librariesHash === initialLibrariesHash && areLibrariesReady(records)

if (!librariesCached) {
  await buildAllLibraries(records)
}

const steadyLibrariesHash = librariesCached ? initialLibrariesHash : computeLibrariesHash(records)
if (librariesOnly) {
  if (!librariesCached) {
    await mkdir(dirname(cachePath), { recursive: true })
    await writeFile(
      cachePath,
      `${JSON.stringify({ ...cached, librariesHash: steadyLibrariesHash }, null, 2)}\n`,
    )
  }
  process.exit(0)
}

await buildUiSdk({ force: forceBuild })
const bundleHash = computeBundleHash(steadyLibrariesHash)
if (!forceBuild && cached.bundleHash === bundleHash && isBundleReady(app.version)) {
  console.log(`MyDSH 离线核心已复用增量缓存（版本 ${app.version}）。`)
  process.exit(0)
}

await removeStagingDirectory()
await mkdir(payload, { recursive: true })
const installContext = { records, installed: new Map() }
try {
  for (const record of records.values()) {
    await installPackageClosure(installContext, record.name, join(root, record.path))
  }
  await copyRuntimeAssetsAndServices(app.version, installContext)
  await bundleDesktopModules(installContext)
  await writeRuntimeManifest(app.version, records.size)
} finally {
  await removeStagingDirectory()
}
await mkdir(dirname(cachePath), { recursive: true })
await writeFile(
  cachePath,
  `${JSON.stringify({ librariesHash: steadyLibrariesHash, bundleHash }, null, 2)}\n`,
)
