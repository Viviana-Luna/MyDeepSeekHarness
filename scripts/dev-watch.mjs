/**
 * 桌面端本地文件监听开发启动器（pnpm run dev:watch）：
 * 先执行增量构建并启动常驻 Electron 窗口，随后监听前端与共享契约目录变化，
 * 保存文件后自动利用 Webpack 磁盘缓存快速重编 lib/renderer 并触发窗口无感刷新。
 */
import electronExecutable from 'electron'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, watch } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildRenderer } from './build-renderer.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const WATCH_TARGETS = ['src/renderer/src', 'src/renderer/config', 'src/shared']

function runInitialBuild() {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawnSync(npmCmd, ['run', 'build'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    throw new Error(`初始增量构建失败，退出码 ${String(result.status)}`)
  }
}

function shouldIgnoreChangedPath(filename) {
  if (!filename) return false
  const normalized = String(filename).replaceAll('\\', '/')
  return normalized.startsWith('.umi') || normalized.includes('/.umi')
}

/**
 * 启动常驻 Electron 桌面窗口与前端源码保存监听循环。
 */
export function startDevWatch() {
  runInitialBuild()
  let building = false
  let pendingRebuild = false
  let debounceTimer

  const triggerRendererRebuild = () => {
    if (building) {
      pendingRebuild = true
      return
    }
    building = true
    const startedAt = performance.now()
    try {
      const outcome = buildRenderer({ root: ROOT })
      if (!outcome.cached) {
        const elapsed = ((performance.now() - startedAt) / 1000).toFixed(2)
        console.info(`[dev:watch] 前端产物已更新（${elapsed}s）。`)
      }
    } catch (error) {
      console.error('[dev:watch] 前端重编失败：', error)
    } finally {
      building = false
      if (pendingRebuild) {
        pendingRebuild = false
        triggerRendererRebuild()
      }
    }
  }

  const watchers = WATCH_TARGETS.filter(rel => existsSync(join(ROOT, rel))).map(rel =>
    watch(join(ROOT, rel), { recursive: true }, (_event, filename) => {
      if (shouldIgnoreChangedPath(filename)) return
      if (debounceTimer !== undefined) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined
        triggerRendererRebuild()
      }, 200)
    }),
  )

  const env = { ...process.env, MYDSH_DEV_WATCH: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electronExecutable, ['.'], { cwd: ROOT, env, stdio: 'inherit' })

  const cleanup = () => {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer)
    for (const watcher of watchers) watcher.close()
  }

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      cleanup()
      if (child.exitCode === null) child.kill(sig)
    })
  }

  child.once('exit', code => {
    cleanup()
    process.exit(code ?? 0)
  })
}

if (import.meta.main) {
  startDevWatch()
}
