import { isRecord } from './validation.ts'
export const DESKTOP_FILE_REFERENCE_MAX_CANDIDATES = 20
export const DESKTOP_FILE_REFERENCE_MAX_PATH_LENGTH = 4_096

export interface DesktopFileReferenceCandidate {
  readonly path: string
  readonly kind: 'file' | 'directory'
}

export interface DesktopActiveFileReferenceToken {
  readonly start: number
  readonly end: number
  readonly prefix: string
  readonly query: string
  readonly quoted: boolean
}

export const DESKTOP_FILE_REFERENCE_CHANNELS = Object.freeze({
  resolveDroppedFiles: 'dsh-desktop:file-references:resolve-dropped-files',
})

function candidate(value: unknown): DesktopFileReferenceCandidate {
  if (
    !isRecord(value) ||
    typeof value.path !== 'string' ||
    value.path === '' ||
    value.path.length > DESKTOP_FILE_REFERENCE_MAX_PATH_LENGTH ||
    (value.kind !== 'file' && value.kind !== 'directory')
  ) {
    throw new Error('DSH Host 返回了无效的文件引用候选')
  }
  return { path: value.path, kind: value.kind }
}

export function parseDesktopFileReferenceCandidates(
  value: unknown,
): readonly DesktopFileReferenceCandidate[] {
  if (!Array.isArray(value) || value.length > DESKTOP_FILE_REFERENCE_MAX_CANDIDATES) {
    throw new Error('DSH Host 返回的文件引用候选数量无效')
  }
  return value.map(candidate)
}

/**
 * 复用 DSH Web 的浏览器安全 `@file` 语法，只识别当前行光标前的活动 token。
 */
export function activeFileReferenceToken(
  text: string,
  cursor: number,
): DesktopActiveFileReferenceToken | null {
  const boundedCursor = Math.max(0, Math.min(text.length, cursor))
  const lineStart = boundedCursor === 0 ? 0 : text.lastIndexOf('\n', boundedCursor - 1) + 1
  const beforeCursor = text.slice(lineStart, boundedCursor)
  const quoted = /(?:^|\s)(@"([^"]*))$/u.exec(beforeCursor)
  if (quoted?.[1] !== undefined && quoted[2] !== undefined) {
    return {
      start: lineStart + beforeCursor.length - quoted[1].length,
      end: boundedCursor,
      prefix: quoted[1],
      query: quoted[2],
      quoted: true,
    }
  }
  const plain = /(?:^|\s)(@([^\s]*))$/u.exec(beforeCursor)
  if (plain?.[1] === undefined || plain[2] === undefined) return null
  return {
    start: lineStart + beforeCursor.length - plain[1].length,
    end: boundedCursor,
    prefix: plain[1],
    query: plain[2],
    quoted: false,
  }
}

/** 与 DSH Web 相同：空白路径加引号，目录保留可继续补全的尾斜杠。 */
export function formatDesktopFileMention(
  value: DesktopFileReferenceCandidate,
  preserveQuote = false,
): string | null {
  const path = value.kind === 'directory' ? `${value.path}/` : value.path
  for (const character of path) {
    const codePoint = character.codePointAt(0) ?? 0
    if (character === '"' || codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
      return null
  }
  const quoted = preserveQuote || /\s/u.test(path)
  if (!quoted) return `@${path}`
  if (value.kind === 'directory') return `@"${path}`
  return `@"${path}"`
}
