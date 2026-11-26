import { basename } from 'node:path'
import { lstatSync, readFileSync } from 'node:fs'
import { BrowserWindow, dialog, ipcMain, nativeImage, type IpcMainInvokeEvent } from 'electron'
import {
  DESKTOP_ATTACHMENT_CHANNELS,
  DESKTOP_IMAGE_ATTACHMENT_MAX_BYTES,
  DESKTOP_IMAGE_ATTACHMENT_MAX_ITEMS,
  DESKTOP_IMAGE_ATTACHMENT_MAX_TOTAL_BYTES,
  desktopImageMediaTypeFromFileName,
  detectDesktopImageMediaType,
  type DesktopDroppedImage,
  type DesktopImageAttachment,
  parseDesktopDroppedImages,
  parseDesktopImageAttachments,
} from '../../shared/image-attachments.ts'

export interface DesktopAttachmentController {
  dispose(): void
}

function invalidSelection(subject: string): never {
  throw new Error('图片附件' + subject)
}

function attachmentFromBytes(name: string, bytes: Buffer): DesktopImageAttachment {
  const expectedMediaType = desktopImageMediaTypeFromFileName(name)
  if (expectedMediaType === null) {
    return invalidSelection('文件扩展名必须是 png、jpg、jpeg、webp 或 gif')
  }
  const mediaType = detectDesktopImageMediaType(bytes)
  if (mediaType === null || mediaType !== expectedMediaType) {
    return invalidSelection('文件内容与扩展名不匹配')
  }
  const image = nativeImage.createFromBuffer(bytes)
  if (image.isEmpty()) return invalidSelection('无法解码所选图片')
  return {
    name,
    mediaType,
    base64: bytes.toString('base64'),
    bytes: bytes.byteLength,
  }
}

function readAttachment(path: string): DesktopImageAttachment {
  let stats
  try {
    stats = lstatSync(path)
  } catch {
    return invalidSelection('无法读取所选文件')
  }
  if (!stats.isFile() || stats.size === 0 || stats.size > DESKTOP_IMAGE_ATTACHMENT_MAX_BYTES) {
    return invalidSelection('文件必须是 16 MB 以内的非空普通图片文件')
  }
  const bytes = readFileSync(path)
  if (bytes.byteLength !== stats.size) return invalidSelection('无法读取所选图片文件')
  return attachmentFromBytes(basename(path), bytes)
}

function importImages(input: unknown): readonly DesktopImageAttachment[] {
  const images = parseDesktopDroppedImages(input)
  return parseDesktopImageAttachments(
    images.map((image: DesktopDroppedImage) => {
      const bytes = Buffer.from(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength)
      return attachmentFromBytes(image.name, bytes)
    }),
  )
}

async function chooseImages(
  win: BrowserWindow,
  event: IpcMainInvokeEvent,
  assertSender: (event: IpcMainInvokeEvent) => void,
): Promise<readonly DesktopImageAttachment[]> {
  assertSender(event)
  const result = await dialog.showOpenDialog(win, {
    title: '选择图片附件',
    buttonLabel: '附加所选图片',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
  })
  assertSender(event)
  if (result.canceled || result.filePaths.length === 0) return []
  if (result.filePaths.length > DESKTOP_IMAGE_ATTACHMENT_MAX_ITEMS) {
    return invalidSelection('一次最多只能选择 16 张图片')
  }
  let totalBytes = 0
  const selections = result.filePaths.map(path => {
    const selection = readAttachment(path)
    totalBytes += selection.bytes
    if (totalBytes > DESKTOP_IMAGE_ATTACHMENT_MAX_TOTAL_BYTES) {
      invalidSelection('总大小必须在 32 MB 以内')
    }
    return selection
  })
  return parseDesktopImageAttachments(selections)
}

export function installAttachmentController(options: {
  window: BrowserWindow
  assertSender: (event: IpcMainInvokeEvent) => void
}): DesktopAttachmentController {
  const { window: win, assertSender } = options

  ipcMain.handle(DESKTOP_ATTACHMENT_CHANNELS.chooseImages, async event => {
    assertSender(event)
    return chooseImages(win, event, assertSender)
  })
  ipcMain.handle(DESKTOP_ATTACHMENT_CHANNELS.importImages, async (event, input) => {
    assertSender(event)
    return importImages(input)
  })

  return {
    dispose: () => {
      ipcMain.removeHandler(DESKTOP_ATTACHMENT_CHANNELS.chooseImages)
      ipcMain.removeHandler(DESKTOP_ATTACHMENT_CHANNELS.importImages)
    },
  }
}
