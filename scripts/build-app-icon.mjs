/**
 * 从 MyDSH Logo 的 PNG 源图生成 macOS 主图与 ICNS 容器。
 *
 * `iconutil` 在当前 macOS 版本不能重新封装自己解出的 iconset，因此这里使用
 * 系统 `sips` 生成 PNG 尺寸，再按公开 ICNS 块结构封装 PNG 数据。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const assetDirectory = join(root, 'assets')
const sourcePath = join(assetDirectory, 'app-icon-source.png')
const masterPath = join(assetDirectory, 'app-icon.png')
const icnsPath = join(assetDirectory, 'app-icon.icns')

if (process.platform !== 'darwin') {
  throw new Error('应用图标导出只支持 macOS，因为它依赖系统 sips。')
}

function runSips(args) {
  const result = spawnSync('/usr/bin/sips', args, { encoding: 'utf8' })
  if (result.status === 0) return
  const detail = result.stderr.trim() || result.stdout.trim() || `退出码 ${String(result.status)}`
  throw new Error(`应用图标导出失败：${detail}`)
}

function createIcnsChunk(type, png) {
  const header = Buffer.alloc(8)
  header.write(type, 0, 4, 'ascii')
  header.writeUInt32BE(png.length + header.length, 4)
  return Buffer.concat([header, png])
}

mkdirSync(assetDirectory, { recursive: true })
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'mydsh-app-icon-'))

try {
  // 源图已有 48px 透明边距；缩放后让可见图形约占 824px，再居中补齐画布。
  const scaledPath = join(temporaryDirectory, 'app-icon-scaled.png')
  runSips(['-z', '910', '910', sourcePath, '--out', scaledPath])
  runSips(['-p', '1024', '1024', scaledPath, '--out', masterPath])

  const pngBySize = new Map()
  for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
    if (size === 1024) {
      pngBySize.set(size, readFileSync(masterPath))
      continue
    }
    const path = join(temporaryDirectory, `app-icon-${String(size)}.png`)
    runSips(['-z', String(size), String(size), masterPath, '--out', path])
    pngBySize.set(size, readFileSync(path))
  }

  const chunkSpecs = [
    ['icp4', 16],
    ['icp5', 32],
    ['ic11', 32],
    ['icp6', 64],
    ['ic12', 64],
    ['ic07', 128],
    ['ic08', 256],
    ['ic13', 256],
    ['ic09', 512],
    ['ic14', 512],
    ['ic10', 1024],
  ]
  const chunks = chunkSpecs.map(([type, size]) => {
    const png = pngBySize.get(size)
    if (png === undefined) throw new Error(`缺少 ${String(size)}px 应用图标。`)
    return createIcnsChunk(type, png)
  })
  const body = Buffer.concat(chunks)
  const header = Buffer.alloc(8)
  header.write('icns', 0, 4, 'ascii')
  header.writeUInt32BE(body.length + header.length, 4)
  writeFileSync(icnsPath, Buffer.concat([header, body]), { mode: 0o644 })
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true })
}

console.log('build-app-icon: 已生成 assets/app-icon.png 与 assets/app-icon.icns。')
