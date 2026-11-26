import { realpathSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * 仅在当前 Runtime 进程内，为插件代码解析宿主共享模块。
 * 其他来源和依赖继续由 Node 正常解析，不设置全局 NODE_PATH，也不写用户模块目录。
 */
/**
 * Windows 上 realpathSync 会返回 8.3 短路径（如 RAINY_~1），与异步 realpath 的长路径无法直接比较，
 * 因此统一使用原生实现：它和异步 realpath 一样返回规范长路径，POSIX 上两者行为相同。
 */
const canonical = path => realpathSync.native(path)

export function installPluginResolution(runtimeDirectory, home) {
  const runtime = canonical(runtimeDirectory)
  const resolveFromRuntime = createRequire(pathToFileURL(join(runtime, 'package.json')))
  const shared = new Map([
    ['@deepseek-ai/cordis', pathToFileURL(resolveFromRuntime.resolve('@deepseek-ai/cordis')).href],
    ['@mydsh/sdk', pathToFileURL(resolveFromRuntime.resolve('@mydsh/sdk')).href],
  ])
  const pluginRoot = join(canonical(home), 'plugins') + sep
  const conversionRoot = join(canonical(home), 'conversions') + sep
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      const replacement = shared.get(specifier)
      if (!replacement || !context.parentURL?.startsWith('file:'))
        return nextResolve(specifier, context)
      let parent
      try {
        parent = canonical(fileURLToPath(context.parentURL))
      } catch {
        return nextResolve(specifier, context)
      }
      const conversionRelative = parent.startsWith(conversionRoot)
        ? parent.slice(conversionRoot.length).split(sep)
        : []
      const fromArtifact =
        /^[a-f0-9-]{36}$/.test(conversionRelative[0] ?? '') && conversionRelative[1] === 'artifact'
      if (!parent.startsWith(pluginRoot) && !fromArtifact) return nextResolve(specifier, context)
      return { url: replacement, shortCircuit: true }
    },
  })
}
