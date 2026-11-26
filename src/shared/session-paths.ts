/**
 * 会话日志在数据目录中的物理路径规则，跨进程共享的纯函数。
 * 规则来自 DSH JSONL 后端：会话目录名是会话 ID 的逐字符转义，项目目录名来自 cwd；
 * 不遵守这套规则会破坏父子会话引用，导入与导出必须使用同一份实现。
 */

/** 会话日志文件名：session.vN.jsonl 或 session.jsonl，可选 .zstd 后缀。 */
export const SESSION_LOG_GENERATION = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/u

/**
 * 逐字符转义为可安全作为目录名的 ASCII 片段：仅保留字母、数字和 . _ -，其余字符转成 ~XXXX。
 */
function escapeSegmentCharacters(raw: string): string {
  return raw
    .split('')
    .map(char =>
      /^[A-Za-z0-9._-]$/u.test(char)
        ? char
        : `~${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
    )
    .join('')
}

/**
 * 把会话 ID 转成它在 sessions/<项目>/<会话> 布局中的目录名。
 * 会话 ID 本身不更换，否则父子会话引用会失效。
 * @throws 输入为空时抛出。
 */
export function sessionDirectorySegment(raw: string): string {
  if (!raw) throw new Error('会话标识不能为空。')
  if (raw === '.' || raw === '..') return raw.replaceAll('.', '~002E')
  return escapeSegmentCharacters(raw)
}

/**
 * 把会话的 cwd 转成它在 sessions/<项目>/<会话> 布局中的项目目录名。
 * cwd 缺失的会话统一落在 _no-cwd 目录；路径分隔符折叠为连字符，超长截断到 251 个字符。
 */
export function sessionProjectDirectoryKey(cwd?: string): string {
  if (cwd === undefined) return '_no-cwd'
  const readable = escapeSegmentCharacters(cwd.replace(/[/\\:]+/gu, '-'))
  return `--${(readable.replace(/^-+/u, '') || 'root').slice(0, 251)}--`
}
