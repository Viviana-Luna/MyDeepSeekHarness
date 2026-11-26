import { isRecord } from './validation.ts'
export const DESKTOP_IMAGE_ATTACHMENT_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const

export type DesktopImageAttachmentMediaType = (typeof DESKTOP_IMAGE_ATTACHMENT_MEDIA_TYPES)[number]

const DESKTOP_IMAGE_EXTENSION_MEDIA_TYPES = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
} as const satisfies Record<string, DesktopImageAttachmentMediaType>)

export function desktopImageMediaTypeFromFileName(
  fileName: string,
): DesktopImageAttachmentMediaType | null {
  const dot = fileName.lastIndexOf('.')
  if (dot < 0) return null
  const extension = fileName.slice(dot).toLowerCase()
  return (
    DESKTOP_IMAGE_EXTENSION_MEDIA_TYPES[
      extension as keyof typeof DESKTOP_IMAGE_EXTENSION_MEDIA_TYPES
    ] ?? null
  )
}

export function detectDesktopImageMediaType(
  data: Uint8Array,
): DesktopImageAttachmentMediaType | null {
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  )
    return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
    return 'image/jpeg'
  if (
    data.length >= 12 &&
    String.fromCharCode(...data.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...data.subarray(8, 12)) === 'WEBP'
  )
    return 'image/webp'
  if (data.length >= 6) {
    const header = String.fromCharCode(...data.subarray(0, 6))
    if (header === 'GIF87a' || header === 'GIF89a') return 'image/gif'
  }
  return null
}

export const DESKTOP_ATTACHMENT_CHANNELS = Object.freeze({
  chooseImages: 'dsh-desktop:attachments:choose-images',
  importImages: 'dsh-desktop:attachments:import-images',
})

export const DESKTOP_IMAGE_ATTACHMENT_MAX_NAME_LENGTH = 255
export const DESKTOP_IMAGE_ATTACHMENT_MAX_BYTES = 16 * 1024 * 1024
export const DESKTOP_IMAGE_ATTACHMENT_MAX_ITEMS = 16
export const DESKTOP_IMAGE_ATTACHMENT_MAX_COUNT = DESKTOP_IMAGE_ATTACHMENT_MAX_ITEMS
export const DESKTOP_IMAGE_ATTACHMENT_MAX_TOTAL_BYTES = 32 * 1024 * 1024

export interface DesktopImageAttachment {
  readonly name: string
  readonly mediaType: DesktopImageAttachmentMediaType
  readonly base64: string
  readonly bytes: number
}

export interface DesktopDroppedImage {
  readonly name: string
  readonly bytes: Uint8Array
}

function invalidAttachment(subject: string): never {
  throw new Error('图片附件' + subject)
}

function mediaType(value: unknown): DesktopImageAttachmentMediaType {
  if (
    typeof value !== 'string' ||
    !DESKTOP_IMAGE_ATTACHMENT_MEDIA_TYPES.includes(value as DesktopImageAttachmentMediaType)
  ) {
    return invalidAttachment('媒体类型无效')
  }
  return value as DesktopImageAttachmentMediaType
}

function base64(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
  ) {
    return invalidAttachment('Base64 数据无效')
  }
  return value
}

function bytes(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > DESKTOP_IMAGE_ATTACHMENT_MAX_BYTES
  ) {
    return invalidAttachment('字节数无效')
  }
  return value
}

function base64ByteLength(value: string): number {
  const runtime = globalThis as typeof globalThis & {
    atob?: (input: string) => string
    Buffer?: {
      from(input: string, encoding: 'base64'): { byteLength: number }
    }
  }
  if (typeof runtime.atob === 'function') return runtime.atob(value).length
  if (runtime.Buffer !== undefined) return runtime.Buffer.from(value, 'base64').byteLength
  return invalidAttachment('运行时不支持 Base64 校验')
}

function attachment(value: unknown): DesktopImageAttachment {
  if (!isRecord(value)) return invalidAttachment('记录无效')
  const name =
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    value.name.length <= DESKTOP_IMAGE_ATTACHMENT_MAX_NAME_LENGTH
      ? value.name
      : invalidAttachment('名称无效')
  const mediaTypeValue = mediaType(value.mediaType)
  const base64Value = base64(value.base64)
  const bytesValue = bytes(value.bytes)
  if (base64ByteLength(base64Value) !== bytesValue) {
    return invalidAttachment('Base64 与字节数不一致')
  }
  return {
    name,
    mediaType: mediaTypeValue,
    base64: base64Value,
    bytes: bytesValue,
  }
}

/**
 * 严格解析图片附件列表，只保留 renderer 需要的无路径字段。
 */
export function parseDesktopImageAttachments(input: unknown): readonly DesktopImageAttachment[] {
  if (!Array.isArray(input) || input.length > DESKTOP_IMAGE_ATTACHMENT_MAX_ITEMS) {
    return invalidAttachment('列表必须是 16 张以内的图片附件')
  }
  let totalBytes = 0
  const attachments = input.map(item => {
    const parsed = attachment(item)
    totalBytes += parsed.bytes
    if (totalBytes > DESKTOP_IMAGE_ATTACHMENT_MAX_TOTAL_BYTES) {
      invalidAttachment(
        '总大小必须在 ' + DESKTOP_IMAGE_ATTACHMENT_MAX_TOTAL_BYTES / (1024 * 1024) + ' MB 以内',
      )
    }
    return parsed
  })
  return attachments
}

/**
 * 严格解析用户主动拖入 renderer 的图片字节，不接收或返回本机路径。
 */
export function parseDesktopDroppedImages(input: unknown): readonly DesktopDroppedImage[] {
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    input.length > DESKTOP_IMAGE_ATTACHMENT_MAX_ITEMS
  ) {
    return invalidAttachment('拖放列表必须是 1 至 16 张图片')
  }
  let totalBytes = 0
  return input.map(item => {
    if (!isRecord(item)) return invalidAttachment('拖放记录无效')
    const name =
      typeof item.name === 'string' &&
      item.name.length > 0 &&
      item.name.length <= DESKTOP_IMAGE_ATTACHMENT_MAX_NAME_LENGTH &&
      !item.name.includes('/') &&
      !item.name.includes('\\') &&
      !item.name.includes(String.fromCharCode(0))
        ? item.name
        : invalidAttachment('拖放文件名称无效')
    if (
      !(item.bytes instanceof Uint8Array) ||
      item.bytes.byteLength === 0 ||
      item.bytes.byteLength > DESKTOP_IMAGE_ATTACHMENT_MAX_BYTES
    ) {
      return invalidAttachment('拖放文件必须是 16 MB 以内的非空图片')
    }
    totalBytes += item.bytes.byteLength
    if (totalBytes > DESKTOP_IMAGE_ATTACHMENT_MAX_TOTAL_BYTES) {
      invalidAttachment(
        '总大小必须在 ' + DESKTOP_IMAGE_ATTACHMENT_MAX_TOTAL_BYTES / (1024 * 1024) + ' MB 以内',
      )
    }
    return { name, bytes: item.bytes }
  })
}
