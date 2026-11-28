/**
 * 用户扩展共享模块解析钩子：仅在当前后台 Runtime 进程内将用户插件对宿主共享包的导入重定向到核心实例。
 * 运行在后台 Runtime；拥有 `module.registerHooks` 句柄，由调用方在停止时统一注销。
 */
import { createRequire, registerHooks } from 'node:module'
import { join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { canonicalRuntimePath as canonical } from './canonical-path.mjs'

/**
 * 注册用户扩展与转换产物对 `@deepseek-ai/cordis` 及 `@mydsh/sdk` 的共享模块解析钩子。
 * @param {string} runtimeDirectory 核心运行根目录（可为 `runtime.asar` 或普通目录）。
 * @param {string} home MyDSH 用户数据根目录。
 * @returns {{ deregister: () => void }} 供退出阶段解除模块钩子的句柄。
 */
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
