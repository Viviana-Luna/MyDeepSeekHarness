/**
 * 按输入摘要缓存预热 Umi 生成目录（src/renderer/src/.umi），
 * 避免路由、模型与前端配置未变化时每次类型检查、单测和构建重复启动 max setup。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative, resolve } from 'node:path'

const DEFAULT_ROOT = resolve(import.meta.dirname, '..')
const CACHE_RELATIVE_PATH = '.build/umi-setup-cache.json'
const REQUIRED_UMI_FILES = [
  'src/renderer/src/.umi/typings.d.ts',
  'src/renderer/src/.umi/exports.ts',
  'src/renderer/src/.umi/umi.ts',
]

function hashFileIfExists(hash, root, relativePath) {
  const fullPath = join(root, relativePath)
  if (!existsSync(fullPath)) {
    hash.update(`missing:${relativePath}\0`)
    return
  }
  hash.update(`file:${relativePath}\0`)
  hash.update(readFileSync(fullPath))
  hash.update('\0')
}

function hashDirectoryContents(hash, root, directoryPath) {
  if (!existsSync(directoryPath)) return
  const entries = readdirSync(directoryPath, { withFileTypes: true }).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )
  for (const entry of entries) {
    if (entry.name.startsWith('.umi') || entry.name === 'node_modules') continue
    const fullPath = join(directoryPath, entry.name)
    if (entry.isDirectory()) {
      hashDirectoryContents(hash, root, fullPath)
    } else {
      const normalized = relative(root, fullPath).replaceAll('\\', '/')
      hash.update(`file:${normalized}\0`)
      hash.update(readFileSync(fullPath))
      hash.update('\0')
    }
  }
}

function hashDirectoryListing(hash, root, directoryPath) {
  if (!existsSync(directoryPath)) return
  const entries = readdirSync(directoryPath, { withFileTypes: true }).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )
  for (const entry of entries) {
    if (entry.name.startsWith('.umi') || entry.name === 'node_modules') continue
    const fullPath = join(directoryPath, entry.name)
    const normalized = relative(root, fullPath).replaceAll('\\', '/')
    if (entry.isDirectory()) {
      hash.update(`dir:${normalized}\0`)
      hashDirectoryListing(hash, root, fullPath)
    } else {
      hash.update(`entry:${normalized}\0`)
    }
  }
}

function computeSetupFingerprint(root) {
  const hash = createHash('sha256')
  hashFileIfExists(hash, root, 'package.json')
  hashFileIfExists(hash, root, 'pnpm-lock.yaml')
  hashFileIfExists(hash, root, 'src/renderer/src/app.tsx')
  hashFileIfExists(hash, root, 'src/renderer/src/loading.tsx')
  hashDirectoryContents(hash, root, join(root, 'src/renderer/config'))
  hashDirectoryContents(hash, root, join(root, 'src/renderer/src/models'))
  hashDirectoryListing(hash, root, join(root, 'src/renderer/src/pages'))
  hashDirectoryListing(hash, root, join(root, 'src/renderer/src/layouts'))
  return hash.digest('hex')
}

function resolveMaxBin(root) {
  const req = createRequire(join(root, 'package.json'))
  const maxPackageJson = req.resolve('@umijs/max/package.json')
  const manifest = JSON.parse(readFileSync(maxPackageJson, 'utf8'))
  const binRelative = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.max
  if (typeof binRelative !== 'string') {
    throw new Error('无法定位 @umijs/max 可执行入口')
  }
  return resolve(maxPackageJson, '..', binRelative)
}

function readCachedFingerprint(cachePath) {
  if (!existsSync(cachePath)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8'))
    return typeof parsed?.fingerprint === 'string' ? parsed.fingerprint : undefined
  } catch {
    return undefined
  }
}

/**
 * 确保 Umi 渲染进程的生成类型与导出文件已就绪；输入未变时直接命中缓存返回。
 * @param {{ root?: string, force?: boolean }} [options] 根目录与强制刷新选项。
 * @returns {{ cached: boolean, fingerprint: string }}
 */
export function ensureRendererSetup(options = {}) {
  const root = options.root ?? DEFAULT_ROOT
  const force = options.force === true
  const fingerprint = computeSetupFingerprint(root)
  const cachePath = join(root, CACHE_RELATIVE_PATH)
  const outputsReady = REQUIRED_UMI_FILES.every(file => existsSync(join(root, file)))
  if (!force && outputsReady && readCachedFingerprint(cachePath) === fingerprint) {
    return { cached: true, fingerprint }
  }
  const maxBin = resolveMaxBin(root)
  const result = spawnSync(process.execPath, [maxBin, 'setup'], {
    cwd: join(root, 'src/renderer'),
    stdio: 'inherit',
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`max setup 失败，退出码 ${String(result.status)}`)
  }
  mkdirSync(join(root, '.build'), { recursive: true })
  writeFileSync(cachePath, `${JSON.stringify({ fingerprint }, null, 2)}\n`)
  return { cached: false, fingerprint }
}

if (import.meta.main) {
  ensureRendererSetup({ force: process.argv.includes('--force') })
}
