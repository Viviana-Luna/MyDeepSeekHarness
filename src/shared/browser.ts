/**
 * 内置浏览器跨进程共享契约：定义受控通道、状态与网址/本地预览路径解析。
 * 运行在主进程、preload 与 renderer 共享边界，不依赖 Node、Electron 或 UI 框架。
 */
export const BROWSER_CHANNELS = {
  request: 'mydsh:browser:request',
  changed: 'mydsh:browser:changed',
} as const

/** 本地项目预览使用的受控自定义协议名称。 */
export const BROWSER_PREVIEW_SCHEME_NAME = 'mydsh-preview'

/** 可在内置浏览器中打开预览的项目文件扩展名集合。 */
export const BROWSER_PREVIEWABLE_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.xhtml',
  '.svg',
  '.xml',
  '.pdf',
  '.txt',
  '.json',
  '.md',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.bmp',
  '.ico',
  '.mp4',
  '.webm',
  '.ogg',
  '.mp3',
  '.wav',
  '.m4a',
])

/** 代码编辑器和内置图片查看器无法直接渲染、点击时直接转入内置浏览器的扩展名。 */
export const BROWSER_DIRECT_OPEN_EXTENSIONS = new Set([
  '.pdf',
  '.mp4',
  '.webm',
  '.ogg',
  '.mp3',
  '.wav',
  '.m4a',
  '.avif',
  '.bmp',
  '.ico',
])

const PROJECT_ACCESS_ID_PATTERN = /^[a-f0-9]{24}$/u
const MAX_PREVIEW_PATH_LENGTH = 4096

/** 单个内置浏览器标签的实时状态快照。 */
export interface BrowserState {
  tabId?: string
  focused?: boolean
  /** 标记该次状态变化源自 AI 自动化操作，前端据此自动登记并展示对应标签页。 */
  automated?: boolean
  /** 标记该标签已被主进程主动关闭并移除，前端应同步移除对应标签页。 */
  closed?: boolean
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error: string | null
  previewPath?: string | null
}

/** 从 renderer 发往主进程浏览器控制器的受信任操作请求。 */
export type BrowserRequest = (
  | { action: 'read' | 'back' | 'forward' | 'reload' | 'stop' | 'close' | 'external' }
  | { action: 'navigate'; url: string }
  | { action: 'openFile'; projectId: string; relativePath: string }
  | {
      action: 'layout'
      visible: boolean
      bounds?: { x: number; y: number; width: number; height: number }
    }
) & { tabId?: string }

/** 新建浏览器标签时的空白状态模板。 */
export const EMPTY_BROWSER_STATE: BrowserState = {
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  error: null,
  previewPath: null,
}

function fileExtension(relativePath: string): string {
  const name = relativePath.split('/').at(-1) ?? ''
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}

function validatePreviewSegments(relativePath: string): string[] | null {
  if (
    relativePath.length === 0 ||
    relativePath.length > MAX_PREVIEW_PATH_LENGTH ||
    relativePath.includes('\0') ||
    relativePath.includes('\\') ||
    relativePath.startsWith('/')
  )
    return null
  const segments = relativePath.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return null
  return segments
}

/** 判断项目相对路径是否支持在内置浏览器中预览。 */
export function isBrowserPreviewablePath(relativePath: string): boolean {
  return BROWSER_PREVIEWABLE_EXTENSIONS.has(fileExtension(relativePath))
}

/** 判断项目相对路径是否应绕过文本/图片查看器、直接由内置浏览器打开。 */
export function isBrowserDirectOpenPath(relativePath: string): boolean {
  return BROWSER_DIRECT_OPEN_EXTENSIONS.has(fileExtension(relativePath))
}

/**
 * 为已授权项目内的文件构造受控预览协议地址。
 * @throws 项目访问标识或相对路径无效时抛出。
 */
export function previewUrlForProjectFile(projectAccessId: string, relativePath: string): string {
  if (!PROJECT_ACCESS_ID_PATTERN.test(projectAccessId)) throw new Error('项目预览标识无效')
  const segments = validatePreviewSegments(relativePath)
  if (segments === null) throw new Error('项目预览文件路径无效')
  const encodedPath = segments.map(segment => encodeURIComponent(segment)).join('/')
  return `${BROWSER_PREVIEW_SCHEME_NAME}://${projectAccessId}/${encodedPath}`
}

/**
 * 解析并校验受控预览协议地址，返回项目访问标识和规范化的相对路径。
 * 若不是有效的 `mydsh-preview:` 地址或包含非法路径段则返回 `null`。
 */
export function parsePreviewUrl(
  input: string,
): { projectAccessId: string; relativePath: string } | null {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return null
  }
  if (
    url.protocol !== `${BROWSER_PREVIEW_SCHEME_NAME}:` ||
    !PROJECT_ACCESS_ID_PATTERN.test(url.hostname) ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== ''
  )
    return null
  const rawSegments = url.pathname.split('/').slice(1)
  if (rawSegments.length === 0) return null
  const decoded: string[] = []
  for (const segment of rawSegments) {
    if (segment === '') return null
    let text: string
    try {
      text = decodeURIComponent(segment)
    } catch {
      return null
    }
    if (
      text === '' ||
      text === '.' ||
      text === '..' ||
      text.includes('/') ||
      text.includes('\\') ||
      text.includes('\0')
    )
      return null
    decoded.push(text)
  }
  const relativePath = decoded.join('/')
  if (relativePath.length > MAX_PREVIEW_PATH_LENGTH) return null
  return { projectAccessId: url.hostname, relativePath }
}

/** 仅允许普通网页导航，地址栏补全不会把未知协议转成桌面操作。 */
export function browserUrl(input: string): string {
  const value = input.trim()
  if (!value || value.length > 8192 || [...value].some(character => character.charCodeAt(0) < 32))
    throw new Error('请输入有效的网址')
  let url: URL
  try {
    url = new URL(
      /^https?:\/\//iu.test(value)
        ? value
        : /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/iu.test(value)
          ? `http://${value}`
          : /^[a-z][a-z\d+.-]*:/iu.test(value)
            ? value
            : `https://${value}`,
    )
  } catch {
    throw new Error('请输入有效的网址')
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password)
    throw new Error('内置浏览器只支持 HTTP 或 HTTPS 网页')
  return url.href
}
