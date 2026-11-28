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

function clampMaxLongEdge(maxLongEdge: number): number {
  const safeEdge = Number.isFinite(maxLongEdge) ? maxLongEdge : 1280
  return Math.max(320, Math.min(2048, Math.round(safeEdge)))
}

function encodeConstrainedNativeImage(image: Electron.NativeImage, cap: number) {
  const original = image.getSize()
  const longEdge = Math.max(original.width, original.height)
  let target = image
  if (longEdge > cap && original.width > 0 && original.height > 0) {
    const ratio = cap / longEdge
    target = image.resize({
      width: Math.max(1, Math.round(original.width * ratio)),
      height: Math.max(1, Math.round(original.height * ratio)),
      quality: 'good',
    })
  }
  const size = target.getSize()
  const png = target.toPNG()
  if (png.byteLength <= MAX_PNG_BYTES) {
    return { buffer: png, mediaType: 'image/png' as const, width: size.width, height: size.height }
  }
  const jpegHigh = target.toJPEG(82)
  if (jpegHigh.byteLength <= MAX_JPEG_BYTES) {
    return {
      buffer: jpegHigh,
      mediaType: 'image/jpeg' as const,
      width: size.width,
      height: size.height,
    }
  }
  const jpegCompact = target.toJPEG(64)
  return {
    buffer: jpegCompact,
    mediaType: 'image/jpeg' as const,
    width: size.width,
    height: size.height,
  }
}

/** 直接对内存中的 `NativeImage` 等比缩放并编码，避免主线程先编码大图 PNG 再解码缩放的双重开销。 */
export function scaleNativeImage(
  image: Electron.NativeImage,
  maxLongEdge: number,
): ReturnType<ImageScaler> {
  if (image.isEmpty()) throw new Error('截图为空，目标窗口或显示器可能尚未完成渲染')
  return encodeConstrainedNativeImage(image, clampMaxLongEdge(maxLongEdge))
}

/** 将 PNG/JPEG 截图按最大长边等比缩放并自适应选择 PNG 或 JPEG 编码，确保体积 <= 1.5 MiB。 */
export const scaleImageWithNativeImage: ImageScaler = (input, maxLongEdge) => {
  const image = nativeImage.createFromBuffer(input)
  if (image.isEmpty()) throw new Error('截图解码失败，页面可能尚未渲染完成')
  const original = image.getSize()
  const longEdge = Math.max(original.width, original.height)
  const cap = clampMaxLongEdge(maxLongEdge)
  // 已由原生工作线程缩放至上限内的 PNG 直接复用原缓冲，省去主线程重复编码开销。
  if (longEdge <= cap && isPngBuffer(input) && input.byteLength <= MAX_PNG_BYTES) {
    return { buffer: input, mediaType: 'image/png', width: original.width, height: original.height }
  }
  return encodeConstrainedNativeImage(image, cap)
}
