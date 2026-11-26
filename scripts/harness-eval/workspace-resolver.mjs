/**
 * 评测用源码工作区模块解析器：在仅执行 `--libraries-only` 编译的源码测试环境中解析工作区包名与子路径。
 */
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))

const MYDSH_PACKAGES = [
  ['@mydsh/llm-chatgpt', 'packages/llm/llm-chatgpt'],
  ['@mydsh/compaction-chatgpt', 'packages/compaction/compaction-chatgpt'],
  ['@mydsh/auto-review', 'packages/interaction/auto-review'],
  ['@mydsh/ssh', 'packages/connections/ssh'],
  ['@mydsh/database', 'packages/connections/database'],
  ['@mydsh/connection-access', 'packages/connections/access'],
  ['@mydsh/browser-automation', 'packages/automation/browser'],
  ['@mydsh/computer-use', 'packages/automation/computer-use'],
  ['@mydsh/cli-bridge', 'packages/cli/cli-bridge'],
]

function buildPackageMap() {
  const upstream = JSON.parse(
    readFileSync(join(REPO_ROOT, 'docs/upstream/dsh/manifest.json'), 'utf8'),
  )
  const map = new Map()
  for (const item of upstream.packages) {
    map.set(item.name, join(REPO_ROOT, item.path))
  }
  for (const [name, relPath] of MYDSH_PACKAGES) {
    map.set(name, join(REPO_ROOT, relPath))
  }
  return map
}

const PACKAGE_MAP = buildPackageMap()

function splitSpecifier(specifier) {
  const parts = specifier.split('/')
  const pkgLen = specifier.startsWith('@') ? 2 : 1
  const pkgName = parts.slice(0, pkgLen).join('/')
  const rest = parts.slice(pkgLen).join('/')
  return { pkgName, subpath: rest ? `./${rest}` : '.' }
}

function resolveTargetUrl(specifier) {
  if (!specifier.startsWith('@deepseek-ai/') && !specifier.startsWith('@mydsh/')) {
    return undefined
  }
  const { pkgName, subpath } = splitSpecifier(specifier)
  const pkgDir = PACKAGE_MAP.get(pkgName)
  if (!pkgDir) return undefined
  if (subpath === './package.json') {
    return pathToFileURL(join(pkgDir, 'package.json')).href
  }
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  const entry = manifest.exports?.[subpath]
  let rel
  if (typeof entry === 'string') rel = entry
  else if (typeof entry === 'object' && entry !== null) rel = entry.default ?? entry.import
  else if (subpath === '.') rel = manifest.main ?? './lib/index.js'
  if (!rel) return undefined
  return pathToFileURL(resolve(pkgDir, rel)).href
}

let hooksInstalled = false

/** 确保当前进程注册一次源码工作区 ESM 解析钩子。 */
export function ensureWorkspaceModuleHooks() {
  if (hooksInstalled) return
  hooksInstalled = true
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const mapped = resolveTargetUrl(specifier)
      if (mapped) return { url: mapped, shortCircuit: true }
      return nextResolve(specifier, context)
    },
  })
}

ensureWorkspaceModuleHooks()

/** 将工作区包说明符解析为本地编译产物的 `file://` URL（供 Node 与 Vitest 共用）。 */
export function resolveWorkspaceModuleUrl(specifier) {
  return resolveTargetUrl(specifier) ?? specifier
}

/**
 * 向评测或单测的 Cordis 根上下文注入工作区包解析钩子，使 `Loader` 与 `AgentPresets` 可直接装载完整源码模块。
 */
export function installWorkspacePresetResolver(ctx) {
  ensureWorkspaceModuleHooks()
  ctx.provide('pluginPackages', {
    packageOf(specifier) {
      const { pkgName } = splitSpecifier(specifier)
      return PACKAGE_MAP.get(pkgName)
    },
  })
  ctx.loader.internal = {
    import(specifier) {
      const target = resolveWorkspaceModuleUrl(specifier)
      return import(/* @vite-ignore */ target)
    },
  }
}
