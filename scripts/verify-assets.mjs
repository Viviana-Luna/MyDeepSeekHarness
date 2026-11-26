import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const pngSignature = '89504e470d0a1a0a'

function readPng(relativePath) {
  const buffer = readFileSync(join(root, relativePath))
  if (buffer.subarray(0, 8).toString('hex') !== pngSignature) {
    throw new Error(`${relativePath} 不是有效 PNG。`)
  }
  // 图标使用 sRGB；把显示 Gamma 2.2 写入 PNG 会让 Electron 解码后的颜色泛白。
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    if (type === 'gAMA' && (length !== 4 || buffer.readUInt32BE(offset + 8) !== 45455)) {
      throw new Error(`${relativePath} 的 Gamma 必须符合 sRGB（45455），否则启动后图标可能泛白。`)
    }
    offset += length + 12
  }
  return {
    buffer,
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    colorType: buffer.readUInt8(25),
  }
}

function verifyPng(relativePath, expectedSize) {
  const png = readPng(relativePath)
  if (png.width !== png.height) throw new Error(`${relativePath} 必须是方形图像。`)
  if (expectedSize !== undefined && png.width !== expectedSize) {
    throw new Error(`${relativePath} 必须是 ${String(expectedSize)}×${String(expectedSize)}。`)
  }
  if (png.colorType !== 4 && png.colorType !== 6) {
    throw new Error(`${relativePath} 必须保留 Alpha 通道。`)
  }
  return png
}

const source = verifyPng('assets/app-icon-source.png')
if (source.width < 1024) throw new Error('应用图标源图边长不能小于 1024px。')
verifyPng('assets/app-icon.png', 1024)

const icns = readFileSync(join(root, 'assets/app-icon.icns'))
if (icns.subarray(0, 4).toString('ascii') !== 'icns') {
  throw new Error('assets/app-icon.icns 缺少 ICNS 文件头。')
}
if (icns.readUInt32BE(4) !== icns.length) {
  throw new Error('assets/app-icon.icns 声明的长度与文件不一致。')
}

const expectedChunks = new Map([
  ['icp4', 16],
  ['ic11', 32],
  ['ic12', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
])
const foundChunks = new Set()
for (let offset = 8; offset < icns.length;) {
  const type = icns.subarray(offset, offset + 4).toString('ascii')
  const length = icns.readUInt32BE(offset + 4)
  if (length < 8 || offset + length > icns.length) {
    throw new Error(`assets/app-icon.icns 的 ${type} 数据块长度无效。`)
  }
  const expectedSize = expectedChunks.get(type)
  if (expectedSize !== undefined) {
    const png = icns.subarray(offset + 8, offset + length)
    if (png.subarray(0, 8).toString('hex') !== pngSignature) {
      throw new Error(`assets/app-icon.icns 的 ${type} 数据块不是 PNG。`)
    }
    const width = png.readUInt32BE(16)
    const height = png.readUInt32BE(20)
    if (width !== expectedSize || height !== expectedSize) {
      throw new Error(`assets/app-icon.icns 的 ${type} 数据块尺寸错误。`)
    }
    foundChunks.add(type)
  }
  offset += length
}

for (const type of expectedChunks.keys()) {
  if (!foundChunks.has(type)) throw new Error(`assets/app-icon.icns 缺少 ${type} 数据块。`)
}

console.log('verify-assets: 应用图标源图、1024px 主图与 ICNS 内容有效。')
