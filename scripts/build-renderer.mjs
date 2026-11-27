/**
 * 按前端与共享源码摘要缓存 renderer 生产构建产物（lib/renderer），
 * 当仅修改主进程、后台服务或测试脚本时跳过重复的 Umi 全量打包。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative, resolve } from 'node:path'
import { ensureRendererSetup } from './setup-renderer.mjs'

const DEFAULT_ROOT = resolve(import.meta.dirname, '..')
const CACHE_RELATIVE_PATH = '.build/renderer-build-cache.json'

function hashSingleFile(hash, root, relativePath) {
  const fullPath = join(root, relativePath)
  if (!existsSync(fullPath)) {
    hash.update(`missing:${relativePath}\0`)
    return
  }
  hash.update(`file:${relativePath}\0`)
  hash.update(readFileSync(fullPath))
  hash.update('\0')
}

function hashDirectoryTree(hash, root, directoryPath) {
  if (!existsSync(directoryPath)) return
  const entries = readdirSync(directoryPath, { withFileTypes: true }).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )
  for (const entry of entries) {
    if (entry.name.startsWith('.umi') || entry.name === 'node_modules') continue
    const fullPath = join(directoryPath, entry.name)
    if (entry.isDirectory()) {
      hashDirectoryTree(hash, root, fullPath)
    } else {
      const normalized = relative(root, fullPath).replaceAll('\\', '/')
      hash.update(`file:${normalized}\0`)
      hash.update(readFileSync(fullPath))
      hash.update('\0')
    }
  }
}

function computeRendererFingerprint(root) {
  const hash = createHash('sha256')
  hash.update(`node:${process.versions.node}\0`)
  for (const file of [
    'package.json',
    'pnpm-lock.yaml',
    'tsconfig.json',
    'tsconfig.renderer.json',
  ]) {
    hashSingleFile(hash, root, file)
  }
  hashDirectoryTree(hash, root, join(root, 'src/shared'))
  hashDirectoryTree(hash, root, join(root, 'src/renderer'))
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

function readCachedRendererFingerprint(cachePath) {
  if (!existsSync(cachePath)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8'))
    return typeof parsed?.fingerprint === 'string' ? parsed.fingerprint : undefined
  } catch {
    return undefined
  }
}

/**
 * 构建本地 renderer 生产产物；输入指纹未变化且产物存在时直接复用。
 * @param {{ root?: string, force?: boolean }} [options] 根目录与强制重编选项。
 */
export function buildRenderer(options = {}) {
  const root = options.root ?? DEFAULT_ROOT
  const force = options.force === true
  ensureRendererSetup({ root, force })
  const fingerprint = computeRendererFingerprint(root)
  const cachePath = join(root, CACHE_RELATIVE_PATH)
  const outputReady = existsSync(join(root, 'lib/renderer/index.html'))
  if (!force && outputReady && readCachedRendererFingerprint(cachePath) === fingerprint) {
    console.log('renderer 构建已复用增量缓存。')
    return { cached: true, fingerprint }
  }
  const maxBin = resolveMaxBin(root)
  const result = spawnSync(process.execPath, [maxBin, 'build'], {
    cwd: join(root, 'src/renderer'),
    stdio: 'inherit',
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`max build 失败，退出码 ${String(result.status)}`)
  }
  mkdirSync(join(root, '.build'), { recursive: true })
  writeFileSync(cachePath, `${JSON.stringify({ fingerprint }, null, 2)}\n`)
  return { cached: false, fingerprint }
}

if (import.meta.main) {
  buildRenderer({ force: process.argv.includes('--force') })
}
