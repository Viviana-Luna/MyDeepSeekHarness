/** 独立性检查：允许固定移植的框架源码，禁止运行时依赖外部 DSH 或官方 WebUI。 */
import { listPackage } from '@electron/asar'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { parse } from 'yaml'

const root = resolve(import.meta.dirname, '..')
const failures = []
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const forbiddenPackages = new Set([
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-modules',
])
const app = json(join(root, 'package.json'))
const upstream = json(join(root, 'docs/upstream/dsh/manifest.json'))
const selected = new Map(upstream.packages.map(record => [record.name, record]))
// 自有提供商随核心交付，但不伪装成固定上游源码。
selected.set('@mydsh/llm-chatgpt', { name: '@mydsh/llm-chatgpt', path: 'packages/llm/llm-chatgpt' })
selected.set('@mydsh/auto-review', {
  name: '@mydsh/auto-review',
  path: 'packages/interaction/auto-review',
})
selected.set('@mydsh/ssh', { name: '@mydsh/ssh', path: 'packages/connections/ssh' })
selected.set('@mydsh/database', { name: '@mydsh/database', path: 'packages/connections/database' })
selected.set('@mydsh/connection-access', {
  name: '@mydsh/connection-access',
  path: 'packages/connections/access',
})
selected.set('@mydsh/browser-automation', {
  name: '@mydsh/browser-automation',
  path: 'packages/automation/browser',
})
selected.set('@mydsh/computer-use', {
  name: '@mydsh/computer-use',
  path: 'packages/automation/computer-use',
})
selected.set('@mydsh/cli-bridge', {
  name: '@mydsh/cli-bridge',
  path: 'packages/cli/cli-bridge',
})
if (!/^[a-f0-9]{40}$/u.test(upstream.revision)) failures.push('移植来源必须固定到完整提交 SHA')
if (!existsSync(join(root, 'docs/upstream/dsh/LICENSE'))) failures.push('缺少移植源码的上游许可证')
for (const record of selected.values()) {
  const directory = resolve(root, record.path)
  if (!/^(?:packages\/[^/.][^/]*\/[^/.][^/]*|vendor\/[^/.][^/]*)$/u.test(record.path)) {
    failures.push(`源码模块必须直接位于 packages/<领域>/<模块> 或 vendor/<依赖>：${record.name}`)
    continue
  }
  if (forbiddenPackages.has(record.name))
    failures.push(`不能引入官方产品入口或 WebUI：${record.name}`)
  const manifest = json(join(directory, 'package.json'))
  if (manifest.name !== record.name) failures.push(`源码模块身份与来源记录不一致：${record.name}`)
  for (const [name, version] of Object.entries({
    ...manifest.dependencies,
    ...manifest.peerDependencies,
  })) {
    if (
      String(version).startsWith('workspace:') &&
      !selected.has(name) &&
      !manifest.peerDependenciesMeta?.[name]?.optional
    )
      failures.push(`固定核心缺少工作区依赖：${record.name} → ${name}`)
  }
}
for (const section of [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]) {
  for (const [name, version] of Object.entries(app[section] ?? {})) {
    if (forbiddenPackages.has(name)) failures.push(`应用依赖包含官方产品入口：${name}`)
    if (String(version).startsWith('workspace:') && !selected.has(name))
      failures.push(`应用工作区依赖未纳入固定来源：${name}`)
    if (/^(?:file:(?:\/\/\/)?|link:)?(?:\/(?:Users|home)\/|[A-Za-z]:[\\/])/u.test(String(version)))
      failures.push(`应用依赖包含开发机路径：${name}`)
  }
}
const roster = json(join(root, 'packages/runtime/roster.json'))
for (const row of roster) {
  const packageName = row.name.startsWith('@')
    ? row.name.split('/').slice(0, 2).join('/')
    : row.name.split('/')[0]
  if (!selected.has(packageName) || forbiddenPackages.has(packageName))
    failures.push(`核心装配包含未交付或禁止的插件：${row.name}`)
}
const pnpm = parse(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'))
for (const [name, allowed] of Object.entries(pnpm.allowBuilds ?? {})) {
  // electron 的安装脚本只下载与当前平台匹配的 Electron 二进制，不编译、不联网安装其他内容，因此显式放行。
  if (allowed === true && !['node-pty', 'esbuild', 'electron'].includes(name))
    failures.push(`新增安装脚本未经边界声明：${name}`)
}
if (
  pnpm.patchedDependencies?.['@umijs/bundler-webpack@4.7.3'] !==
  'patches/@umijs__bundler-webpack@4.7.3.patch'
)
  failures.push('必须保留 Umi 开发服务只监听指定 loopback 地址的补丁')

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name.startsWith('.umi')) return []
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return ['.ts', '.tsx', '.js', '.mjs', '.cjs'].includes(extname(entry.name)) ? [path] : []
  })
}
// 旧管理器即使暂时没有被 import，也不能作为随应用编译的后备路径留在 src 中。
for (const file of [
  'src/main/host/dsh-cli.ts',
  'src/main/host/host-supervisor.ts',
  'src/main/host/host-authorization.ts',
]) {
  if (existsSync(join(root, file))) failures.push(`仍保留外部 CLI／端口／Cookie 启动路径：${file}`)
}
for (const path of [
  ...sourceFiles(join(root, 'src')),
  ...sourceFiles(join(root, 'packages/runtime')),
]) {
  const source = readFileSync(path, 'utf8')
  const name = relative(root, path)
  if (/\b(?:resolveDshCli|stopPortListeners|releaseHostPort|DshHostSupervisor)\b/u.test(source))
    failures.push(`仍调用外部 DSH 生命周期：${name}`)
  if (
    /(?:from\s*|import\s*\()\s*['"](?:@deepseek-ai\/dsh-web|[^'"]*deepseek-harness\/apps\/)/u.test(
      source,
    )
  )
    failures.push(`导入了官方 Web 或 CLI 入口：${name}`)
  if (
    /\b(?:createServer|listen)\s*\(/u.test(source) &&
    /(?:from\s+['"]node:(?:http|https|net)['"])/u.test(source)
  )
    failures.push(`桌面内部不能启动 HTTP/TCP 服务：${name}`)
}

function verifyRuntimeBundle(bundlePath) {
  const manifest = json(join(bundlePath, 'manifest.json'))
  if (manifest.platform !== process.platform || manifest.arch !== process.arch)
    throw new Error('核心平台或架构不匹配')
  if (manifest.version !== app.version || manifest.schemaVersion !== 1 || manifest.apiVersion !== 1)
    throw new Error('核心与应用版本或协议版本不匹配')
  const remaining = new Set(Object.keys(manifest.files ?? {}))
  const isArchived = typeof manifest.archive === 'string' && manifest.archive.length > 0
  if (isArchived ? !remaining.has(manifest.archive) : !remaining.has(manifest.entry)) {
    throw new Error('核心清单缺少入口或归档文件')
  }
  const physicalRoot = isArchived ? bundlePath : join(bundlePath, 'payload')
  let count = 0
  const walk = directory => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      const info = lstatSync(path)
      // 清单键统一为 / 形式；Windows 的 relative() 返回反斜杠，必须与安装器一致地归一。
      const key = relative(physicalRoot, path).split(/[\\/]/).join('/')
      if (isArchived && key === 'manifest.json') continue
      if (info.isSymbolicLink()) throw new Error(`核心制品不得依赖符号链接：${key}`)
      if (info.isDirectory()) {
        walk(path)
        continue
      }
      if (!info.isFile() || !remaining.has(key)) throw new Error(`核心包含清单外文件：${key}`)
      const expected = manifest.files[key]
      if (
        info.size !== expected.size ||
        createHash('sha256').update(readFileSync(path)).digest('hex') !== expected.sha256
      )
        throw new Error(`核心文件完整性不符：${key}`)
      if (process.platform !== 'win32' && expected.executable && (info.mode & 0o111) === 0)
        throw new Error(`核心工具缺少执行权限：${key}`)
      remaining.delete(key)
      count += 1
    }
  }
  for (const key of remaining) {
    if (isAbsolute(key) || key.split('/').some(part => !part || part === '..' || part === '.')) {
      throw new Error(`核心清单路径无效：${key}`)
    }
  }
  walk(physicalRoot)
  if (remaining.size) throw new Error(`核心缺少文件：${[...remaining][0]}`)
  const requiredPackages = [...selected.keys(), 'typescript', 'esbuild', 'npm']
  if (isArchived) {
    const asarEntries = new Set(
      listPackage(join(bundlePath, manifest.archive)).map(entry => entry.replaceAll('\\', '/')),
    )
    if (!asarEntries.has(`/${manifest.entry}`)) {
      throw new Error(`核心归档缺少启动入口：${manifest.entry}`)
    }
    const missing = requiredPackages.find(
      name => !asarEntries.has(`/node_modules/${name}/package.json`),
    )
    if (missing !== undefined) throw new Error(`核心归档未交付必要依赖：${missing}`)
  } else {
    const missing = requiredPackages.find(
      name => !existsSync(join(physicalRoot, 'node_modules', name, 'package.json')),
    )
    if (missing !== undefined) throw new Error(`核心未交付必要依赖：${missing}`)
  }
  return count
}

// 源码检查可以在首次构建前运行；存在制品时必须完整校验，不能用成功提示遮住跳过。
const argument = process.argv.indexOf('--bundle')
const bundle =
  argument >= 0 ? resolve(process.argv[argument + 1] ?? '') : join(root, 'lib/mydsh-runtime')
let verifiedFiles = 0
if (argument >= 0 || existsSync(bundle)) {
  try {
    verifiedFiles = verifyRuntimeBundle(bundle)
  } catch (error) {
    failures.push(`离线核心：${error.message}`)
  }
}
if (failures.length) {
  failures.forEach(failure => {
    console.error(`verify-standalone: ${failure}`)
  })
  process.exitCode = 1
} else {
  console.log(
    `verify-standalone: 固定源码、装配与独立运行边界通过；${verifiedFiles ? `已校验 ${verifiedFiles} 个核心文件` : '尚无核心制品，本次仅检查源码，发行前必须运行 build:runtime 和制品验收'}。`,
  )
}
