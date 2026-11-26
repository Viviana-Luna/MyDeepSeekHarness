import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  showOpenDialog: vi.fn(),
  createFromBuffer: vi.fn(() => ({ isEmpty: () => false })),
  assertSender: vi.fn(),
}))

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  dialog: { showOpenDialog: mocked.showOpenDialog },
  ipcMain: { handle: mocked.handle, removeHandler: mocked.removeHandler },
  nativeImage: { createFromBuffer: mocked.createFromBuffer },
}))

import { installAttachmentController } from '../src/main/attachments/attachment-controller.ts'
import { DESKTOP_ATTACHMENT_CHANNELS } from '../src/shared/image-attachments.ts'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5+kL8AAAAASUVORK5CYII=',
  'base64',
)

afterEach(() => {
  vi.clearAllMocks()
})

describe('附件图片选择控制器', () => {
  it('返回无路径图片附件，并保留名称、媒体类型、base64 和字节数', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-attachments-'))
    try {
      const file = join(root, 'sample.png')
      writeFileSync(file, PNG)
      mocked.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [file] })

      let handler!: (event: unknown) => Promise<readonly unknown[]>
      mocked.handle.mockImplementation((channel: string, callback: typeof handler) => {
        if (channel === DESKTOP_ATTACHMENT_CHANNELS.chooseImages) handler = callback
      })

      const controller = installAttachmentController({
        window: {} as never,
        assertSender: mocked.assertSender,
      })

      const event = { sender: 'trusted' }
      const result = await handler(event)
      expect(mocked.assertSender).toHaveBeenCalledWith(event)
      expect(mocked.showOpenDialog).toHaveBeenCalledWith(
        {},
        expect.objectContaining({
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
        }),
      )
      expect(result).toEqual([
        {
          name: 'sample.png',
          mediaType: 'image/png',
          base64: PNG.toString('base64'),
          bytes: PNG.byteLength,
        },
      ])

      controller.dispose()
      expect(mocked.removeHandler).toHaveBeenCalledWith(DESKTOP_ATTACHMENT_CHANNELS.chooseImages)
      expect(mocked.removeHandler).toHaveBeenCalledWith(DESKTOP_ATTACHMENT_CHANNELS.importImages)
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })

  it('拒绝扩展名与内容不匹配的文件', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-attachments-'))
    try {
      const file = join(root, 'fake.png')
      writeFileSync(file, Buffer.from('不是图片'))
      mocked.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [file] })

      let handler!: (event: unknown) => Promise<readonly unknown[]>
      mocked.handle.mockImplementation((channel: string, callback: typeof handler) => {
        if (channel === DESKTOP_ATTACHMENT_CHANNELS.chooseImages) handler = callback
      })

      installAttachmentController({
        window: {} as never,
        assertSender: mocked.assertSender,
      })

      const event = { sender: 'trusted' }
      await expect(handler(event)).rejects.toThrow('文件内容与扩展名不匹配')
      expect(mocked.assertSender).toHaveBeenCalledWith(event)
      expect(readFileSync(file, 'utf8')).toBe('不是图片')
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })

  it('把 renderer 主动拖入的图片字节转换为无路径附件，并拒绝伪图片', async () => {
    const handlers = new Map<
      string,
      (event: unknown, input?: unknown) => Promise<readonly unknown[]>
    >()
    mocked.handle.mockImplementation((channel: string, callback: never) => {
      handlers.set(
        channel,
        callback as (event: unknown, input?: unknown) => Promise<readonly unknown[]>,
      )
    })

    installAttachmentController({
      window: {} as never,
      assertSender: mocked.assertSender,
    })

    const handler = handlers.get(DESKTOP_ATTACHMENT_CHANNELS.importImages)
    expect(handler).toBeDefined()
    const event = { sender: 'trusted' }
    await expect(
      handler?.(event, [{ name: '拖入.png', bytes: new Uint8Array(PNG) }]),
    ).resolves.toEqual([
      {
        name: '拖入.png',
        mediaType: 'image/png',
        base64: PNG.toString('base64'),
        bytes: PNG.byteLength,
      },
    ])
    await expect(
      handler?.(event, [{ name: '伪装.png', bytes: new TextEncoder().encode('不是图片') }]),
    ).rejects.toThrow('文件内容与扩展名不匹配')
    expect(mocked.assertSender).toHaveBeenCalledWith(event)
  })
})
