/**
 * 浏览器多模态截图输出辅助：校验当前模型图像输入能力，并将主进程截图存入 `ctx.attachments` 返回图片块。
 * 复用 `read_image` 的标准 `{ type: 'image', attachment }` 契约，避免把 base64 写入 JSONL 会话日志。
 */
import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId, type AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type LlmRuntime from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { sanitizeUntrustedWebText, sanitizeWebUrlForOutput } from './policy.ts'

/** 工具结果中引用的已持久化截图附件元数据。 */
export interface StoredScreenshotImage {
  readonly attachmentId: string
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
  readonly originalDimensions?: { readonly width: number; readonly height: number }
}

/** `browser_screenshot` 的结构化输出载荷。 */
export interface BrowserScreenshotToolValue {
  readonly target: 'embedded' | 'external'
  readonly tab_id: string
  readonly url: string
  readonly title: string
  readonly viewport_width: number
  readonly viewport_height: number
  readonly image: StoredScreenshotImage
}

/** `browser_screenshot` 对应的工具输出 Schema。 */
export const BROWSER_SCREENSHOT_OUTPUT_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    target: { type: 'string' as const, enum: ['embedded', 'external'], required: true },
    tab_id: { type: 'string' as const, required: true },
    url: { type: 'string' as const, required: true },
    title: { type: 'string' as const, required: true },
    viewport_width: { type: 'integer' as const, required: true },
    viewport_height: { type: 'integer' as const, required: true },
    image: {
      type: 'object' as const,
      additionalProperties: false,
      required: true,
      properties: {
        attachmentId: { type: 'string' as const, required: true },
        mediaType: {
          type: 'string' as const,
          enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
          required: true,
        },
        bytes: { type: 'integer' as const, required: true },
        width: { type: 'integer' as const, required: true },
        height: { type: 'integer' as const, required: true },
        name: { type: 'string' as const },
        originalDimensions: {
          type: 'object' as const,
          additionalProperties: false,
          properties: {
            width: { type: 'integer' as const, required: true },
            height: { type: 'integer' as const, required: true },
          },
        },
      },
    },
  },
} as const

/** 校验附件服务可用，避免在截图完成后才因缺少附件存储失败。 */
export function assertAttachmentsAvailableForBrowser(ctx: Context): AttachmentStore {
  const attachments = ctx.get('attachments') as AttachmentStore | undefined
  if (!attachments) {
    throw new Error('当前运行时未挂载附件服务，无法返回多模态截图，请改用 browser_snapshot')
  }
  return attachments
}

/** 校验当前会话路由的模型是否声明支持 `image` 输入模态；非多模态模型引导改用 `browser_snapshot`。 */
export async function assertVisionModelForBrowser(
  ctx: Context,
  exec: ToolRunContext,
): Promise<void> {
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  const llm = ctx.get('llm') as LlmRuntime | undefined
  if (!provider || !model || !llm) {
    throw new Error(
      'MODEL_VISION_UNAVAILABLE：无法解析当前模型视觉能力，请改用 browser_snapshot 读取页面结构',
    )
  }
  const info = await llm.resolveModelInfo(provider, model, exec.signal)
  if (!info.inputModalities?.includes('image')) {
    throw new Error(
      `MODEL_NO_VISION：当前模型「${model}」不支持图片输入，请优先使用 browser_snapshot 读取页面交互树，或切换到支持视觉的模型后再截图`,
    )
  }
}

/** 将主进程返回的 base64 截图落盘到 `ctx.attachments` 并返回精简引用。 */
export async function saveBrowserScreenshotAttachment(
  ctx: Context,
  input: { base64: string; mediaType: 'image/png' | 'image/jpeg'; name: string },
): Promise<StoredScreenshotImage> {
  const attachments = assertAttachmentsAvailableForBrowser(ctx)
  const data = Buffer.from(input.base64, 'base64')
  const saved = await attachments.saveImage({
    data,
    mediaType: input.mediaType,
    name: input.name,
  })
  return {
    attachmentId: String(saved.attachmentId),
    mediaType: saved.mediaType,
    bytes: saved.bytes,
    width: saved.width,
    height: saved.height,
    ...(saved.name ? { name: saved.name } : {}),
    ...(saved.originalDimensions ? { originalDimensions: saved.originalDimensions } : {}),
  }
}

/** 将截图工具结果渲染为「精简元信息文本 + 标准多模态图片附件块」。 */
export function renderBrowserScreenshotOutput(value: BrowserScreenshotToolValue) {
  const metaText = JSON.stringify({
    target: value.target,
    tab_id: value.tab_id,
    url: sanitizeWebUrlForOutput(value.url),
    title: sanitizeUntrustedWebText(value.title, 200, true),
    viewport_width: value.viewport_width,
    viewport_height: value.viewport_height,
    image_width: value.image.width,
    image_height: value.image.height,
    bytes: value.image.bytes,
  })
  return [
    { type: 'text' as const, text: metaText },
    {
      type: 'image' as const,
      attachment: {
        attachmentId: AttachmentId(value.image.attachmentId),
        mediaType: value.image.mediaType,
        bytes: value.image.bytes,
        width: value.image.width,
        height: value.image.height,
        ...(value.image.name ? { name: value.image.name } : {}),
        ...(value.image.originalDimensions
          ? { originalDimensions: value.image.originalDimensions }
          : {}),
      },
    },
  ]
}
