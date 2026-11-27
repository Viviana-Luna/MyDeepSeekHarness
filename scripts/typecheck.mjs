/**
 * 并行增量构建入口的 TypeScript 类型检查器：
 * 先按需预热 Umi 类型，再以有界并发和 .build/tsbuildinfo 增量缓存检查全部工程配置。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { availableParallelism } from 'node:os'
import { join, resolve } from 'node:path'
import { ensureRendererSetup } from './setup-renderer.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const BUILD_INFO_DIRECTORY = join(ROOT, '.build/tsbuildinfo')

const TYPECHECK_PROJECTS = [
  'tsconfig.json',
  'tsconfig.tests.json',
  'tsconfig.renderer.json',
  'packages/llm/llm-chatgpt/tsconfig.json',
  'packages/compaction/compaction-chatgpt/tsconfig.json',
  'packages/connections/ssh/tsconfig.json',
  'packages/interaction/auto-review/tsconfig.json',
  'packages/connections/access/tsconfig.json',
  'packages/connections/database/tsconfig.json',
  'packages/automation/browser/tsconfig.json',
  'packages/automation/computer-use/tsconfig.json',
  'packages/cli/cli-bridge/tsconfig.json',
]

function resolveTscBin(root) {
  const req = createRequire(join(root, 'package.json'))
  return req.resolve('typescript/bin/tsc')
}

function projectSlug(projectPath) {
  return projectPath.replaceAll('/', '__').replace(/\.json$/u, '')
}

function checkSingleProject(tscBin, projectPath) {
  const buildInfoFile = join(BUILD_INFO_DIRECTORY, `${projectSlug(projectPath)}.tsbuildinfo`)
  const args = [
    tscBin,
    '--pretty',
    'false',
    '--noEmit',
    '--incremental',
    '--tsBuildInfoFile',
    buildInfoFile,
    '-p',
    join(ROOT, projectPath),
  ]
  return new Promise((resolveCheck, rejectCheck) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      output += chunk
    })
    child.stderr.on('data', chunk => {
      output += chunk
    })
    child.once('error', rejectCheck)
    child.once('close', code => {
      resolveCheck({ projectPath, ok: code === 0, code: code ?? 1, output })
    })
  })
}

function runPool(items, concurrency, worker) {
  let cursor = 0
  const results = Array.from({ length: items.length })
  const step = async () => {
    const index = cursor
    cursor += 1
    if (index >= items.length) return
    results[index] = await worker(items[index])
    await step()
  }
  const workerCount = Math.min(concurrency, items.length)
  return Promise.all(Array.from({ length: workerCount }, () => step())).then(() => results)
}

function parseFilterArgument(argv) {
  const flag = argv.find(arg => arg.startsWith('--filter='))
  return flag === undefined ? undefined : flag.slice('--filter='.length).trim()
}

/**
 * 并行运行仓库内各 TypeScript 工程的增量类型检查。
 * @param {{ force?: boolean, filter?: string }} [options] 强制清理缓存或按路径子串过滤。
 */
export async function runTypecheck(options = {}) {
  const startedAt = performance.now()
  const force = options.force === true
  if (force) {
    rmSync(BUILD_INFO_DIRECTORY, { recursive: true, force: true })
  }
  ensureRendererSetup({ root: ROOT, force })
  mkdirSync(BUILD_INFO_DIRECTORY, { recursive: true })
  const filter = options.filter
  const selected =
    filter === undefined || filter === ''
      ? TYPECHECK_PROJECTS
      : TYPECHECK_PROJECTS.filter(item => item.includes(filter))
  if (selected.length === 0) {
    throw new Error(`未找到匹配 "${String(filter)}" 的 tsconfig 工程`)
  }
  const tscBin = resolveTscBin(ROOT)
  const concurrency = Math.max(1, Math.min(availableParallelism(), 6))
  const results = await runPool(selected, concurrency, project =>
    checkSingleProject(tscBin, project),
  )
  const failed = results.filter(item => !item.ok)
  if (failed.length > 0) {
    for (const item of failed) {
      process.stderr.write(`\n[typecheck] ${item.projectPath} 失败：\n${item.output}`)
    }
    process.exitCode = 1
    return
  }
  const elapsedSeconds = ((performance.now() - startedAt) / 1000).toFixed(2)
  console.log(`typecheck: ${String(selected.length)} 个工程通过（${elapsedSeconds}s）。`)
}

if (import.meta.main) {
  const filter = parseFilterArgument(process.argv.slice(2))
  await runTypecheck({
    force: process.argv.includes('--force'),
    ...(filter === undefined ? {} : { filter }),
  })
}
