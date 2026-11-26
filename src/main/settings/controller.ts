import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import {
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  type Event as ElectronEvent,
  type IpcMainInvokeEvent,
  type NativeImage,
} from 'electron'
import {
  DESKTOP_SETTINGS_CHANNELS,
  DesktopSettingsStore,
  DesktopSettingsValidationError,
  parseDesktopBackgroundApplyRequest,
  parseDesktopBackgroundChooseRequest,
  parseDesktopBackgroundSelectionId,
  type DesktopBackgroundCropRect,
  type DesktopBackgroundSelection,
  type DesktopSettingsSnapshot,
} from './desktop-settings.ts'

const MAX_BACKGROUND_SOURCE_BYTES = 32 * 1024 * 1024
const MAX_BACKGROUND_EDGE = 8_192
const MAX_BACKGROUND_PREVIEW_EDGE = 1_600
const MAX_BACKGROUND_OUTPUT_EDGE = 4_096
const BACKGROUND_SELECTION_TTL_MS = 5 * 60 * 1_000

interface PreparedBackgroundSelection {
  selection: DesktopBackgroundSelection
  image: NativeImage
}

export interface DesktopSettingsController {
  requestOpen(): void
  publish(snapshot: DesktopSettingsSnapshot): DesktopSettingsSnapshot
  dispose(): void
}

function decodeBackgroundImage(path: string): NativeImage {
  let stats
  try {
    stats = statSync(path)
  } catch {
    throw new DesktopSettingsValidationError('无法读取所选背景图片')
  }
  if (!stats.isFile() || stats.size === 0 || stats.size > MAX_BACKGROUND_SOURCE_BYTES) {
    throw new DesktopSettingsValidationError('背景源文件必须是 32 MB 以内的非空图片')
  }
  const image = nativeImage.createFromPath(path)
  if (image.isEmpty()) throw new DesktopSettingsValidationError('无法解码所选背景图片')
  const { width, height } = image.getSize()
  if (width <= 0 || height <= 0 || width > MAX_BACKGROUND_EDGE || height > MAX_BACKGROUND_EDGE) {
    throw new DesktopSettingsValidationError('背景图片边长必须在 1 到 8192 像素之间')
  }
  return image
}

function backgroundPreviewDataUrl(image: NativeImage): string {
  const { width, height } = image.getSize()
  const scale = Math.min(1, MAX_BACKGROUND_PREVIEW_EDGE / Math.max(width, height))
  const preview =
    scale < 1
      ? image.resize({
          width: Math.max(1, Math.round(width * scale)),
          height: Math.max(1, Math.round(height * scale)),
          quality: 'best',
        })
      : image
  return preview.toDataURL()
}

function cropBackgroundImage(
  image: NativeImage,
  crop: DesktopBackgroundCropRect,
  targetAspectRatio: number,
): Buffer {
  const source = image.getSize()
  let width = Math.max(1, Math.round(crop.width * source.width))
  let height = Math.max(1, Math.round(crop.height * source.height))
  let x = Math.round(crop.x * source.width)
  let y = Math.round(crop.y * source.height)
  width = Math.min(width, source.width)
  height = Math.min(height, source.height)
  x = Math.min(Math.max(0, x), source.width - width)
  y = Math.min(Math.max(0, y), source.height - height)
  const actualAspectRatio = width / height
  if (Math.abs(Math.log(actualAspectRatio / targetAspectRatio)) > 0.03) {
    throw new DesktopSettingsValidationError('背景图片裁剪区域与目标浮岛比例不一致')
  }
  let result = image.crop({ x, y, width, height })
  const size = result.getSize()
  const scale = Math.min(1, MAX_BACKGROUND_OUTPUT_EDGE / Math.max(size.width, size.height))
  if (scale < 1) {
    result = result.resize({
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
      quality: 'best',
    })
  }
  const png = result.toPNG()
  if (png.byteLength === 0) throw new DesktopSettingsValidationError('无法生成裁剪后的背景图片')
  return png
}

function settingsOperation<T>(operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    if (error instanceof DesktopSettingsValidationError) throw error
    console.error('桌面设置内部操作失败：', error)
    // oxlint-disable-next-line eslint/preserve-caught-error -- cause 可能包含本机路径，不能跨 IPC 返回 renderer。
    throw new Error('桌面设置操作失败，请检查应用数据目录权限后重试')
  }
}

async function asyncSettingsOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof DesktopSettingsValidationError) throw error
    console.error('桌面设置内部操作失败：', error)
    // oxlint-disable-next-line eslint/preserve-caught-error -- cause 可能包含本机路径，不能跨 IPC 返回 renderer。
    throw new Error('桌面设置操作失败，请检查应用数据目录权限后重试')
  }
}

async function chooseBackgroundImage(
  win: BrowserWindow,
  requestInput: unknown,
  verificationPath?: string,
): Promise<PreparedBackgroundSelection | null> {
  const request = parseDesktopBackgroundChooseRequest(requestInput)
  let path = verificationPath
  if (path === undefined) {
    const result = await dialog.showOpenDialog(win, {
      title: '选择桌面背景图片',
      buttonLabel: '裁剪这张图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    })
    path = result.filePaths[0]
    if (result.canceled || path === undefined) return null
  }
  const image = decodeBackgroundImage(path)
  const { width, height } = image.getSize()
  return {
    image,
    selection: {
      id: randomUUID(),
      layer: request.layer,
      previewDataUrl: backgroundPreviewDataUrl(image),
      sourceWidth: width,
      sourceHeight: height,
      targetAspectRatio: request.targetAspectRatio,
    },
  }
}

function removeSettingsIpcHandlers(): void {
  for (const channel of [
    DESKTOP_SETTINGS_CHANNELS.read,
    DESKTOP_SETTINGS_CHANNELS.update,
    DESKTOP_SETTINGS_CHANNELS.chooseBackground,
    DESKTOP_SETTINGS_CHANNELS.applyBackground,
    DESKTOP_SETTINGS_CHANNELS.cancelBackground,
    DESKTOP_SETTINGS_CHANNELS.clearBackground,
  ])
    ipcMain.removeHandler(channel)
}

export function installDesktopSettingsController(options: {
  window: BrowserWindow
  store: DesktopSettingsStore
  assertSender: (event: IpcMainInvokeEvent) => void
  isTrustedRendererPage: (url: string) => boolean
  verificationBackgroundPath?: string
  onPublished?: (snapshot: DesktopSettingsSnapshot) => void
}): DesktopSettingsController {
  const { window: win, store, assertSender, isTrustedRendererPage, onPublished } = options
  const contents = win.webContents
  let pendingBackground: (PreparedBackgroundSelection & { expiresAt: number }) | undefined
  let pendingBackgroundExpiry: NodeJS.Timeout | undefined

  const clearPendingBackground = (selectionId?: string): boolean => {
    if (selectionId !== undefined && pendingBackground?.selection.id !== selectionId) return false
    if (pendingBackgroundExpiry !== undefined) clearTimeout(pendingBackgroundExpiry)
    pendingBackgroundExpiry = undefined
    pendingBackground = undefined
    return true
  }

  const retainPendingBackground = (prepared: PreparedBackgroundSelection): void => {
    clearPendingBackground()
    pendingBackground = { ...prepared, expiresAt: Date.now() + BACKGROUND_SELECTION_TTL_MS }
    const selectionId = prepared.selection.id
    pendingBackgroundExpiry = setTimeout(() => {
      clearPendingBackground(selectionId)
    }, BACKGROUND_SELECTION_TTL_MS)
    pendingBackgroundExpiry.unref()
  }

  const requirePendingBackground = (selectionId: string): PreparedBackgroundSelection => {
    if (
      pendingBackground === undefined ||
      pendingBackground.selection.id !== selectionId ||
      pendingBackground.expiresAt <= Date.now()
    ) {
      clearPendingBackground()
      throw new DesktopSettingsValidationError('背景图片选择已过期，请重新选择图片')
    }
    return pendingBackground
  }

  const publish = (snapshot: DesktopSettingsSnapshot): DesktopSettingsSnapshot => {
    if (process.platform === 'darwin' && !win.isDestroyed()) {
      win.setVibrancy(null)
    }
    if (!win.isDestroyed() && !contents.isDestroyed()) {
      contents.send(DESKTOP_SETTINGS_CHANNELS.changed, snapshot)
    }
    if (onPublished !== undefined) {
      try {
        onPublished(snapshot)
      } catch (error) {
        console.warn('桌面设置广播后的窗口同步失败：', error)
      }
    }
    return snapshot
  }

  const requestOpen = (): void => {
    if (win.isDestroyed() || contents.isDestroyed() || !isTrustedRendererPage(contents.getURL()))
      return
    contents.send(DESKTOP_SETTINGS_CHANNELS.openRequested)
  }

  publish(store.read())
  ipcMain.handle(DESKTOP_SETTINGS_CHANNELS.read, event => {
    return settingsOperation(() => {
      assertSender(event)
      return store.read()
    })
  })
  ipcMain.handle(DESKTOP_SETTINGS_CHANNELS.update, (event, patch: unknown) => {
    return settingsOperation(() => {
      assertSender(event)
      return publish(store.update(patch))
    })
  })
  ipcMain.handle(DESKTOP_SETTINGS_CHANNELS.chooseBackground, async (event, request: unknown) => {
    return asyncSettingsOperation(async () => {
      assertSender(event)
      const prepared = await chooseBackgroundImage(win, request, options.verificationBackgroundPath)
      if (prepared === null) return null
      assertSender(event)
      retainPendingBackground(prepared)
      return prepared.selection
    })
  })
  ipcMain.handle(DESKTOP_SETTINGS_CHANNELS.applyBackground, (event, requestInput: unknown) => {
    return settingsOperation(() => {
      assertSender(event)
      const request = parseDesktopBackgroundApplyRequest(requestInput)
      const prepared = requirePendingBackground(request.selectionId)
      const png = cropBackgroundImage(
        prepared.image,
        request.crop,
        prepared.selection.targetAspectRatio,
      )
      const snapshot = store.setBackground(prepared.selection.layer, png)
      clearPendingBackground(request.selectionId)
      return publish(snapshot)
    })
  })
  ipcMain.handle(DESKTOP_SETTINGS_CHANNELS.cancelBackground, (event, selectionIdInput: unknown) => {
    return settingsOperation(() => {
      assertSender(event)
      clearPendingBackground(parseDesktopBackgroundSelectionId(selectionIdInput))
    })
  })
  ipcMain.handle(DESKTOP_SETTINGS_CHANNELS.clearBackground, (event, layer: unknown) => {
    return settingsOperation(() => {
      assertSender(event)
      return publish(store.clearBackground(layer))
    })
  })
  const clearPendingBackgroundOnNavigation = (
    _event: ElectronEvent,
    _url: string,
    _isInPlace: boolean,
    isMainFrame: boolean,
  ): void => {
    if (isMainFrame) clearPendingBackground()
  }
  contents.on('did-start-navigation', clearPendingBackgroundOnNavigation)

  return {
    requestOpen,
    publish,
    dispose: () => {
      clearPendingBackground()
      removeSettingsIpcHandlers()
      if (!contents.isDestroyed()) {
        contents.removeListener('did-start-navigation', clearPendingBackgroundOnNavigation)
      }
    },
  }
}
