/** 格式化对话中折叠的工具摘要；展开详情仍保留原始数据。 */

/** 清理单行 Markdown 标记，供思考过程预览使用。 */
export function stripMarkdownInline(text: string): string {
  return text
    .replace(/^\s*(?:#+\s*|[-*>]\s+)/u, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/\*\*|__|`|~~/gu, '')
    .trim()
}

const textValue = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim().replace(/\\"/gu, '"') : null

function formatUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    let path = url.pathname
    try {
      path = decodeURIComponent(path)
    } catch {
      path = '/…'
    }
    return `${url.hostname.replace(/^www\./u, '')}${path === '/' ? '' : ` › ${path.replace(/^\//u, '')}`}`
  } catch {
    return null
  }
}

/** 将常见工具参数转换为单行摘要；无法解析的结构化输入不暴露原始 JSON。 */
export function formatToolSummary(
  name: string | null,
  input: string | null,
  fallback: string,
): string {
  let value: unknown = input
  if (input) {
    try {
      value = JSON.parse(input) as unknown
    } catch {
      value = input
    }
  }
  if (typeof value === 'string') {
    const clean = value.trim()
    if (/^https?:\/\//iu.test(clean)) return formatUrl(clean) ?? '无法解析网址'
    return formatUrl(clean) ?? (/^[{[]/u.test(clean) ? '查看调用详情' : stripMarkdownInline(clean))
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const data = value as Record<string, unknown>
    const query = data.queries ?? data.query ?? data.q
    const queries = (Array.isArray(query) ? query : [query])
      .map(textValue)
      .filter((item): item is string => item !== null)
    if (queries.length > 0)
      return queries.length > 1
        ? `${queries.slice(0, 2).join(' · ')}（共 ${String(queries.length)} 项）`
        : queries[0]!
    const rawUrl = data.url ?? (Array.isArray(data.urls) ? data.urls[0] : data.urls)
    const url = textValue(rawUrl)
    if (url !== null) return formatUrl(url) ?? '无法解析网址'
    const path = textValue(data.path ?? data.file_path ?? data.filePath)
    const pattern = textValue(data.pattern)
    if (pattern !== null && /grep|glob|search/iu.test(name ?? ''))
      return `“${pattern}”${path ? ` in ${path}` : ''}`
    if (path !== null) {
      const start = data.start_line ?? data.offset
      const end = data.end_line
      return `${path}${typeof start === 'number' ? `:L${String(start)}${typeof end === 'number' ? `-L${String(end)}` : ''}` : ''}`
    }
    const command = textValue(data.description) ?? textValue(data.command ?? data.cmd)
    if (command !== null) return command.split(/\r?\n/u)[0]!.replace(/\s+/gu, ' ')
    return '查看调用详情'
  }
  return /^[{[]/u.test(fallback.trim()) ? '查看调用详情' : stripMarkdownInline(fallback)
}
