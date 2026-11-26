import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { dialog, protocol, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { MydshRuntimeSupervisor } from './runtime-supervisor.ts'
import type { MydshPluginInfo } from '../../runtime/plugins/contracts.ts'
import { requirePluginId } from '../../runtime/plugins/contracts.ts'

export const FRONTEND_PLUGIN_CHANNEL = 'mydsh:plugins:frontend'
export const FRONTEND_PLUGIN_CHANGED = 'mydsh:plugins:changed'
/** 固定动作在主进程复核字段，业务装卸继续交给已有 Runtime 服务。 */
export function pluginOperationPayload(operation: string, value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('插件操作参数无效')
  const item = value as Record<string, unknown>
  const field =
    operation === 'mydshPlugins.list'
      ? null
      : ['mydshPlugins.install', 'mydshPlugins.update'].includes(operation)
        ? 'path'
        : 'id'
  if (Object.keys(item).some(key => key !== field)) throw new Error('插件操作包含不支持的字段')
  if (field === null) return {}
  const text = item[field]
  if (typeof text !== 'string' || text.length === 0 || text.length > 32768 || text.includes('\0'))
    throw new Error('插件操作缺少有效的标识或路径')
  if (field === 'id') requirePluginId(text)
  else if (!isAbsolute(text)) throw new Error('请选择插件文件夹的完整路径')
  return { [field]: text }
}
/** 只返回用户选择的目录；选择本身不加载或执行插件。窗口退出后的结果作废。 */
export async function choosePluginDirectory(win: BrowserWindow): Promise<string | null> {
  if (win.isDestroyed()) throw new Error('MyDSH 窗口已经关闭')
  const result = await dialog.showOpenDialog(win, {
    title: '选择 MyDSH 插件文件夹',
    buttonLabel: '选择插件',
    properties: ['openDirectory', 'dontAddToRecent'],
  })
  if (win.isDestroyed() || result.canceled) return null
  return result.filePaths[0] ?? null
}
/** 插件自定义协议描述，需与浏览器预览协议在 app ready 前一同注册。 */
export const PLUGIN_CUSTOM_SCHEME = {
  scheme: 'mydsh-plugin',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}

/** scheme 必须在 app ready 之前声明；它仅服务已启用插件的安装资源。 */
export function registerPluginScheme(): void {
  protocol.registerSchemesAsPrivileged([PLUGIN_CUSTOM_SCHEME])
}
export async function listRuntimePlugins(
  runtime: MydshRuntimeSupervisor,
): Promise<MydshPluginInfo[]> {
  if (runtime.getState().kind !== 'ready') return []
  const result = (await runtime.call('mydshPlugins/list', {})) as {
    ok: boolean
    value?: MydshPluginInfo[]
    error?: { message: string }
  }
  if (!result.ok || !Array.isArray(result.value))
    throw new Error(result.error?.message ?? '无法读取插件清单')
  return result.value
}
const resourceUrl = (plugin: MydshPluginInfo, path: string): string =>
  `mydsh-plugin://${plugin.id}/${encodeURIComponent(plugin.version)}/${path.split('/').map(encodeURIComponent).join('/')}`
/** 主进程根据清单生成地址，renderer 无法提交任意本地路径。 */
export function installPluginController(
  win: BrowserWindow,
  runtime: MydshRuntimeSupervisor,
  assertSender: (event: IpcMainInvokeEvent, window: BrowserWindow) => void,
): () => void {
  ipcMain.handle(FRONTEND_PLUGIN_CHANNEL, async event => {
    assertSender(event, win)
    return (await listRuntimePlugins(runtime))
      .filter(
        plugin => plugin.source === 'user' && plugin.enabled && plugin.running && plugin.frontend,
      )
      .map(plugin => ({
        id: plugin.id,
        version: plugin.version,
        entryUrl: resourceUrl(plugin, plugin.frontend!),
        ...(plugin.previousVersion ? { previousVersion: plugin.previousVersion } : {}),
        ...(plugin.styles?.length
          ? { styleUrls: plugin.styles.map(path => resourceUrl(plugin, path)) }
          : {}),
      }))
  })
  const notify = (): void => {
    if (!win.isDestroyed()) win.webContents.send(FRONTEND_PLUGIN_CHANGED)
  }
  const stopChanged = runtime.onPluginsChanged(notify)
  const stopReady = runtime.subscribe(state => {
    if (state.kind === 'ready') notify()
  })
  protocol.handle('mydsh-plugin', async request => {
    try {
      const url = new URL(request.url),
        parts = url.pathname.split('/').slice(1).map(decodeURIComponent)
      const version = parts.shift()
      if (
        !parts.length ||
        parts.some(
          part =>
            !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0'),
        )
      )
        return new Response(null, { status: 403 })
      const plugin = (await listRuntimePlugins(runtime)).find(
        item =>
          item.id === url.hostname &&
          item.version === version &&
          item.source === 'user' &&
          item.enabled &&
          item.running,
      )
      if (!plugin) return new Response(null, { status: 404 })
      const directory = await realpath(plugin.directory),
        path = await realpath(join(directory, ...parts))
      const within = relative(directory, path)
      if (isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`))
        return new Response(null, { status: 403 })
      const extension = path.split('.').pop() ?? ''
      const mime: Record<string, string> = {
        js: 'text/javascript',
        css: 'text/css',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        webp: 'image/webp',
        gif: 'image/gif',
        svg: 'image/svg+xml',
        woff2: 'font/woff2',
        woff: 'font/woff',
        json: 'application/json',
      }
      if (!mime[extension]) return new Response(null, { status: 403 })
      return new Response(new Uint8Array(await readFile(path)), {
        headers: {
          'content-type': mime[extension],
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        },
      })
    } catch {
      return new Response(null, { status: 404 })
    }
  })
  return () => {
    stopChanged()
    stopReady()
    ipcMain.removeHandler(FRONTEND_PLUGIN_CHANNEL)
    protocol.unhandle('mydsh-plugin')
  }
}
