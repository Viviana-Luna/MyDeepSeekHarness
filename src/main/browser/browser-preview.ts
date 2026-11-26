/**
 * 内置浏览器本地项目文件预览协议模块：在浏览器独立 Session 上注册 `mydsh-preview:`，
 * 复核已授权项目的边界、符号链接逃逸、跨域拦截和静态子资源 MIME 类型，不监听任何本地端口。
 */
import { createReadStream } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, sep } from 'node:path'
import { Readable } from 'node:stream'
import type { CustomScheme, Session } from 'electron'
import { BROWSER_PREVIEW_SCHEME_NAME, parsePreviewUrl } from '../../shared/browser.ts'

const MAX_PREVIEW_FILE_BYTES = 64 * 1024 * 1024
const PROJECT_ID_PATTERN = /^[a-f0-9]{24}$/u

const PREVIEW_MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.xhtml': 'application/xhtml+xml; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'application/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
}

/** 必须在 Electron `app` ready 前随插件协议一起声明的特权协议描述。 */
export const BROWSER_PREVIEW_SCHEME: CustomScheme = {
  scheme: BROWSER_PREVIEW_SCHEME_NAME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
  },
}

/** 已通过项目边界校验的预览文件元数据。 */
export interface ResolvedPreviewFile {
  readonly realRoot: string
  readonly realPath: string
  readonly relativePath: string
  readonly size: number
}

/** 预览协议处理器控制器：按活跃浏览器标签维护已授权项目的引用计数并负责卸载清理。 */
export interface BrowserPreviewProtocolController {
  authorize(projectAccessId: string): void
  release(projectAccessId: string): void
  dispose(): void
}

function validateRelativeSegments(relativePath: string): string[] {
  if (
    relativePath.length === 0 ||
    relativePath.length > 4096 ||
    relativePath.includes('\0') ||
    relativePath.includes('\\') ||
    relativePath.startsWith('/')
  )
    throw new Error('项目预览文件路径无效')
  const segments = relativePath.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..'))
    throw new Error('项目预览文件路径越界')
  return segments
}

/** 根据文件扩展名返回适合浏览器渲染的 MIME 类型。 */
export function mimeTypeForPreviewPath(filePath: string): string {
  const extension = extname(filePath).toLowerCase()
  return PREVIEW_MIME_TYPES[extension] ?? 'application/octet-stream'
}

/**
 * 在已授权的项目目录内解析预览文件真实路径，拒绝任何越界路径、符号链接逃逸与超大文件。
 * @throws 项目未授权、路径非法、文件不存在或超出 64 MiB 上限时抛出。
 */
export async function resolvePreviewFile(
  resolveProjectDirectory: (projectId: unknown) => string,
  projectAccessId: unknown,
  relativePathInput: unknown,
): Promise<ResolvedPreviewFile> {
  if (typeof projectAccessId !== 'string' || !PROJECT_ID_PATTERN.test(projectAccessId))
    throw new Error('项目预览标识无效')
  if (typeof relativePathInput !== 'string') throw new Error('项目预览文件路径无效')
  const segments = validateRelativeSegments(relativePathInput)
  const rootPath = resolveProjectDirectory(projectAccessId)
  const realRoot = await realpath(rootPath)
  const candidatePath = join(realRoot, ...segments)
  let realTarget: string
  try {
    realTarget = await realpath(candidatePath)
  } catch {
    throw new Error('要预览的项目文件不存在')
  }
  const within = relative(realRoot, realTarget)
  if (within === '' || isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`))
    throw new Error('项目预览文件越出项目目录边界')
  const info = await stat(realTarget)
  if (!info.isFile()) throw new Error('请求预览的路径不是普通文件')
  if (info.size > MAX_PREVIEW_FILE_BYTES) throw new Error('文件超过内置浏览器预览的 64 MiB 上限')
  return {
    realRoot,
    realPath: realTarget,
    relativePath: segments.join('/'),
    size: info.size,
  }
}

function matchesPreviewOrigin(headerValue: string, projectAccessId: string): boolean {
  try {
    const parsed = new URL(headerValue)
    return (
      parsed.protocol === `${BROWSER_PREVIEW_SCHEME_NAME}:` &&
      parsed.hostname === projectAccessId &&
      parsed.port === ''
    )
  } catch {
    return false
  }
}

function isCrossSiteOrForeignOrigin(request: Request, projectAccessId: string): boolean {
  const fetchSite = request.headers.get('sec-fetch-site')?.toLowerCase()
  if (fetchSite === 'cross-site') return true
  const origin = request.headers.get('origin')
  if (origin !== null && origin !== 'null' && !matchesPreviewOrigin(origin, projectAccessId))
    return true
  const referer = request.headers.get('referer')
  if (referer !== null && referer !== '' && !matchesPreviewOrigin(referer, projectAccessId))
    return true
  return false
}

function parseByteRange(
  header: string | null,
  totalSize: number,
): { start: number; end: number } | 'invalid' | null {
  if (header === null || header.trim() === '') return null
  const match = /^bytes=(\d*)-(\d*)$/iu.exec(header.trim())
  if (match === null) return 'invalid'
  const startText = match[1] ?? ''
  const endText = match[2] ?? ''
  if (startText === '' && endText === '') return 'invalid'
  if (totalSize === 0) return 'invalid'
  if (startText === '') {
    const suffix = Number(endText)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid'
    const start = Math.max(0, totalSize - suffix)
    return { start, end: totalSize - 1 }
  }
  const start = Number(startText)
  const rawEnd = endText === '' ? totalSize - 1 : Number(endText)
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(rawEnd) ||
    start < 0 ||
    start >= totalSize
  )
    return 'invalid'
  const end = Math.min(totalSize - 1, rawEnd)
  if (end < start) return 'invalid'
  return { start, end }
}

function baseHeaders(mimeType: string, extra: Record<string, string> = {}): Headers {
  return new Headers({
    'content-type': mimeType,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    'accept-ranges': 'bytes',
    ...extra,
  })
}

async function buildPreviewResponse(
  request: Request,
  resolved: ResolvedPreviewFile,
): Promise<Response> {
  const mimeType = mimeTypeForPreviewPath(resolved.realPath)
  const range = parseByteRange(request.headers.get('range'), resolved.size)
  if (range === 'invalid') {
    return new Response(null, {
      status: 416,
      headers: { 'content-range': `bytes */${String(resolved.size)}`, 'cache-control': 'no-store' },
    })
  }
  if (range !== null) {
    const length = range.end - range.start + 1
    const headers = baseHeaders(mimeType, {
      'content-length': String(length),
      'content-range': `bytes ${String(range.start)}-${String(range.end)}/${String(resolved.size)}`,
    })
    if (request.method === 'HEAD') return new Response(null, { status: 206, headers })
    const stream = Readable.toWeb(
      createReadStream(resolved.realPath, { start: range.start, end: range.end }),
    ) as ReadableStream
    return new Response(stream, { status: 206, headers })
  }
  const headers = baseHeaders(mimeType, { 'content-length': String(resolved.size) })
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
  const bytes = await readFile(resolved.realPath)
  return new Response(new Uint8Array(bytes), { status: 200, headers })
}

/**
 * 在浏览器独立分区上安装 `mydsh-preview:` 协议处理器，仅放行活跃预览标签已授权的项目资源。
 * 调用方应在窗口关闭或控制器销毁时调用 `dispose()` 以清理引用计数和协议处理器。
 */
export function installBrowserPreviewProtocol(options: {
  readonly browserSession: Session
  readonly resolveProjectDirectory?: (projectId: unknown) => string
}): BrowserPreviewProtocolController {
  const authorizedCounts = new Map<string, number>()
  const protocol = options.browserSession.protocol
  let disposed = false

  if (protocol && typeof protocol.handle === 'function') {
    protocol.handle(BROWSER_PREVIEW_SCHEME_NAME, async request => {
      if (disposed || !options.resolveProjectDirectory) return new Response(null, { status: 404 })
      if (request.method !== 'GET' && request.method !== 'HEAD')
        return new Response(null, { status: 405 })
      const parsed = parsePreviewUrl(request.url)
      if (parsed === null) return new Response(null, { status: 403 })
      if (isCrossSiteOrForeignOrigin(request, parsed.projectAccessId))
        return new Response(null, { status: 403 })
      if ((authorizedCounts.get(parsed.projectAccessId) ?? 0) <= 0)
        return new Response(null, { status: 403 })
      try {
        const resolved = await resolvePreviewFile(
          options.resolveProjectDirectory,
          parsed.projectAccessId,
          parsed.relativePath,
        )
        return await buildPreviewResponse(request, resolved)
      } catch {
        return new Response(null, { status: 404 })
      }
    })
  }

  return {
    authorize(projectAccessId) {
      if (disposed || !PROJECT_ID_PATTERN.test(projectAccessId)) return
      authorizedCounts.set(projectAccessId, (authorizedCounts.get(projectAccessId) ?? 0) + 1)
    },
    release(projectAccessId) {
      const next = (authorizedCounts.get(projectAccessId) ?? 0) - 1
      if (next <= 0) authorizedCounts.delete(projectAccessId)
      else authorizedCounts.set(projectAccessId, next)
    },
    dispose() {
      if (disposed) return
      disposed = true
      authorizedCounts.clear()
      if (protocol && typeof protocol.unhandle === 'function')
        protocol.unhandle(BROWSER_PREVIEW_SCHEME_NAME)
    },
  }
}
