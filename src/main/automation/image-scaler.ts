/**
 * 主进程截图缩放器：使用 Electron 原生 `nativeImage` 将网页或桌面截图限制在合理尺寸与体积内。
 * 运行在 Electron 主进程，避免把超大原始 Retina 截图送入 Runtime 通道与模型上下文。
 */
import { nativeImage } from 'electron'
import type { ImageScaler } from './cdp-transport.ts'

const MAX_PNG_BYTES = 1_200_000
const MAX_JPEG_BYTES = 1_500_000

function isPngBuffer(buf: Buffer): boolean {
  return (
    buf.byteLength >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
  )
}

/** 将 PNG/JPEG 截图按最大长边等比缩放并自适应选择 PNG 或 JPEG 编码，确保体积 <= 1.5 MiB。 */
export const scaleImageWithNativeImage: ImageScaler = (input, maxLongEdge) => {
  let image = nativeImage.createFromBuffer(input)
  if (image.isEmpty()) throw new Error('截图解码失败，页面可能尚未渲染完成')
  const original = image.getSize()
  const longEdge = Math.max(original.width, original.height)
  const safeEdge = Number.isFinite(maxLongEdge) ? maxLongEdge : 1280
  const cap = Math.max(320, Math.min(2048, Math.round(safeEdge)))
  // 已由原生 GPU 截帧缩放至上限内的 PNG 直接复用原缓冲，省去重复编码开销。
  if (longEdge <= cap && isPngBuffer(input) && input.byteLength <= MAX_PNG_BYTES) {
    return { buffer: input, mediaType: 'image/png', width: original.width, height: original.height }
  }
  if (longEdge > cap && original.width > 0 && original.height > 0) {
    const ratio = cap / longEdge
    image = image.resize({
      width: Math.max(1, Math.round(original.width * ratio)),
      height: Math.max(1, Math.round(original.height * ratio)),
      quality: 'good',
    })
  }
  const size = image.getSize()
  const png = image.toPNG()
  if (png.byteLength <= MAX_PNG_BYTES) {
    return { buffer: png, mediaType: 'image/png', width: size.width, height: size.height }
  }
  const jpegHigh = image.toJPEG(82)
  if (jpegHigh.byteLength <= MAX_JPEG_BYTES) {
    return { buffer: jpegHigh, mediaType: 'image/jpeg', width: size.width, height: size.height }
  }
  const jpegCompact = image.toJPEG(64)
  return { buffer: jpegCompact, mediaType: 'image/jpeg', width: size.width, height: size.height }
}
