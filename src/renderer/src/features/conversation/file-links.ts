export interface ConversationFileTarget {
  readonly path: string
  readonly line?: number
}

function hasControlCharacter(value: string): boolean {
  return [...value].some(
    character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  )
}

/** 消息链接的目标与显示名称分开解析，不按扩展名筛选文件。 */
export function parseFileLink(value: string): ConversationFileTarget | undefined {
  const hash = value.indexOf('#')
  const destination = hash < 0 ? value : value.slice(0, hash)
  if (destination.includes('?')) return undefined
  let path: string
  try {
    path = decodeURIComponent(destination)
  } catch {
    return undefined
  }
  if (
    !path ||
    hasControlCharacter(path) ||
    /^[\\/]{2}/u.test(path) ||
    /^[a-z][a-z\d+.-]*:/iu.test(path)
  )
    return undefined
  if (hash < 0) return { path }
  const match = /^L([1-9]\d*)(?:-L([1-9]\d*))?$/u.exec(value.slice(hash + 1))
  if (match === null) return undefined
  const line = Number(match[1])
  const end = Number(match[2] ?? match[1])
  return Number.isSafeInteger(line) && Number.isSafeInteger(end) && end >= line
    ? { path, line }
    : undefined
}

/** 转为现有项目接口接受的相对路径；实际访问与符号链接仍由主进程复核。 */
export function projectRelativeFilePath(path: string, cwd?: string): string | undefined {
  if (
    !path ||
    path.length > 4_096 ||
    hasControlCharacter(path) ||
    path.includes('\\') ||
    /^[a-z][a-z\d+.-]*:/iu.test(path) ||
    path.startsWith('//')
  )
    return undefined
  const root = cwd?.replace(/\/+$/u, '')
  if (path.startsWith('/')) {
    if (root === undefined || !path.startsWith(`${root}/`)) return undefined
    path = path.slice(root.length + 1)
  }
  const segments: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '..') {
      if (segments.length === 0) return undefined
      segments.pop()
    } else if (segment !== '' && segment !== '.') segments.push(segment)
  }
  return segments.length > 0 ? segments.join('/') : undefined
}

/** 简称只在已知文件中唯一匹配，歧义不能通过项目过滤被掩盖。 */
export function resolveFileMention(
  value: string,
  files: readonly string[],
  cwd?: string,
): string | undefined {
  const paths = [...new Set(files.map(path => projectRelativeFilePath(path, cwd) ?? path))]
  const exact = projectRelativeFilePath(value, cwd)
  const matches =
    exact !== undefined && paths.includes(exact)
      ? [exact]
      : paths.filter(path => path.slice(path.lastIndexOf('/') + 1) === value)
  return matches.length === 1 ? projectRelativeFilePath(matches[0]!, cwd) : undefined
}
