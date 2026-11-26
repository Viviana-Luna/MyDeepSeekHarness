import type { DirectoryEntry } from '../project-workspace/project-types.ts'

export type FileIconName =
  | 'archive'
  | 'code'
  | 'config'
  | 'container'
  | 'data'
  | 'file'
  | 'folder'
  | 'folder-archive'
  | 'folder-assets'
  | 'folder-build'
  | 'folder-config'
  | 'folder-docs'
  | 'folder-source'
  | 'folder-test'
  | 'folder-sensitive'
  | 'image'
  | 'lock'
  | 'markdown'
  | 'react'
  | 'symlink'
  | 'terminal'
  | 'text'

export type FileIconTone =
  | 'archive'
  | 'assets'
  | 'build'
  | 'config'
  | 'data'
  | 'docs'
  | 'language'
  | 'muted'
  | 'sensitive'
  | 'source'
  | 'test'

export interface FileIconDescriptor {
  icon: FileIconName
  tone: FileIconTone
  label: string
  glyph?: string
}

const DIRECTORY_ICONS: Readonly<Record<string, FileIconDescriptor>> = Object.freeze({
  source: { icon: 'folder-source', tone: 'source', label: '源代码文件夹' },
  test: { icon: 'folder-test', tone: 'test', label: '测试文件夹' },
  docs: { icon: 'folder-docs', tone: 'docs', label: '文档文件夹' },
  config: { icon: 'folder-config', tone: 'config', label: '配置文件夹' },
  assets: { icon: 'folder-assets', tone: 'assets', label: '资源文件夹' },
  build: { icon: 'folder-build', tone: 'build', label: '构建产物文件夹' },
  archive: { icon: 'folder-archive', tone: 'archive', label: '归档文件夹' },
  sensitive: { icon: 'folder-sensitive', tone: 'sensitive', label: '敏感文件夹' },
})

const DIRECTORY_GROUPS: ReadonlyArray<
  readonly [keyof typeof DIRECTORY_ICONS, ReadonlySet<string>]
> = [
  ['source', new Set(['app', 'apps', 'lib', 'libs', 'source', 'sources', 'src'])],
  [
    'test',
    new Set([
      '__tests__',
      'e2e',
      'integration-test',
      'integration-tests',
      'spec',
      'specs',
      'test',
      'tests',
    ]),
  ],
  ['docs', new Set(['doc', 'docs', 'documentation'])],
  ['config', new Set(['.config', 'config', 'configs', 'configuration'])],
  [
    'assets',
    new Set(['asset', 'assets', 'image', 'images', 'public', 'resource', 'resources', 'static']),
  ],
  [
    'build',
    new Set(['.next', '.output', 'build', 'coverage', 'dist', 'miniapp-dist', 'out', 'target']),
  ],
  ['archive', new Set(['archive', 'archives', 'backup', 'backups'])],
  [
    'sensitive',
    new Set(['.ssh', 'credential', 'credentials', 'key', 'keys', 'private', 'secret', 'secrets']),
  ],
]

const FILE_EXTENSIONS: Readonly<Record<string, FileIconDescriptor>> = Object.freeze({
  '.bash': { icon: 'terminal', tone: 'language', label: 'Shell 脚本', glyph: 'SH' },
  '.cjs': { icon: 'code', tone: 'language', label: 'JavaScript 文件', glyph: 'JS' },
  '.css': { icon: 'code', tone: 'language', label: 'CSS 文件', glyph: 'CSS' },
  '.fish': { icon: 'terminal', tone: 'language', label: 'Shell 脚本', glyph: 'SH' },
  '.gif': { icon: 'image', tone: 'assets', label: '图像文件' },
  '.go': { icon: 'code', tone: 'language', label: 'Go 文件', glyph: 'GO' },
  '.htm': { icon: 'code', tone: 'language', label: 'HTML 文件', glyph: 'HT' },
  '.html': { icon: 'code', tone: 'language', label: 'HTML 文件', glyph: 'HT' },
  '.java': { icon: 'code', tone: 'language', label: 'Java 文件', glyph: 'J' },
  '.jpeg': { icon: 'image', tone: 'assets', label: '图像文件' },
  '.jpg': { icon: 'image', tone: 'assets', label: '图像文件' },
  '.js': { icon: 'code', tone: 'language', label: 'JavaScript 文件', glyph: 'JS' },
  '.json': { icon: 'data', tone: 'data', label: 'JSON 文件', glyph: '{}' },
  '.jsonc': { icon: 'data', tone: 'data', label: 'JSON 文件', glyph: '{}' },
  '.jsx': { icon: 'react', tone: 'language', label: 'React 文件' },
  '.kt': { icon: 'code', tone: 'language', label: 'Kotlin 文件', glyph: 'KT' },
  '.kts': { icon: 'code', tone: 'language', label: 'Kotlin 文件', glyph: 'KT' },
  '.less': { icon: 'code', tone: 'language', label: 'Less 文件', glyph: 'CSS' },
  '.log': { icon: 'text', tone: 'muted', label: '日志文件' },
  '.md': { icon: 'markdown', tone: 'docs', label: 'Markdown 文件', glyph: 'MD' },
  '.mdx': { icon: 'markdown', tone: 'docs', label: 'MDX 文件', glyph: 'MDX' },
  '.mjs': { icon: 'code', tone: 'language', label: 'JavaScript 文件', glyph: 'JS' },
  '.mts': { icon: 'code', tone: 'language', label: 'TypeScript 文件', glyph: 'TS' },
  '.png': { icon: 'image', tone: 'assets', label: '图像文件' },
  '.py': { icon: 'code', tone: 'language', label: 'Python 文件', glyph: 'PY' },
  '.rs': { icon: 'code', tone: 'language', label: 'Rust 文件', glyph: 'RS' },
  '.sass': { icon: 'code', tone: 'language', label: 'Sass 文件', glyph: 'CSS' },
  '.scss': { icon: 'code', tone: 'language', label: 'SCSS 文件', glyph: 'CSS' },
  '.sh': { icon: 'terminal', tone: 'language', label: 'Shell 脚本', glyph: 'SH' },
  '.sql': { icon: 'data', tone: 'data', label: 'SQL 文件', glyph: 'SQL' },
  '.svg': { icon: 'image', tone: 'assets', label: 'SVG 图像文件' },
  '.toml': { icon: 'config', tone: 'config', label: 'TOML 配置文件', glyph: 'TM' },
  '.ts': { icon: 'code', tone: 'language', label: 'TypeScript 文件', glyph: 'TS' },
  '.tsx': { icon: 'react', tone: 'language', label: 'React TypeScript 文件' },
  '.txt': { icon: 'text', tone: 'muted', label: '文本文件' },
  '.vue': { icon: 'code', tone: 'language', label: 'Vue 文件', glyph: 'VUE' },
  '.webp': { icon: 'image', tone: 'assets', label: '图像文件' },
  '.yaml': { icon: 'config', tone: 'config', label: 'YAML 配置文件', glyph: 'YML' },
  '.yml': { icon: 'config', tone: 'config', label: 'YAML 配置文件', glyph: 'YML' },
  '.zsh': { icon: 'terminal', tone: 'language', label: 'Shell 脚本', glyph: 'SH' },
})

const ARCHIVE_EXTENSION = /\.(?:7z|bz2|gz|rar|tar|tgz|xz|zip)$/iu
const LOCK_FILE =
  /^(?:cargo\.lock|composer\.lock|go\.sum|package-lock\.json|pnpm-lock\.yaml|poetry\.lock|yarn\.lock)$/iu

function extension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

export function describeFileIcon(entry: DirectoryEntry): FileIconDescriptor {
  const lowerName = entry.name.toLowerCase()
  if (entry.kind === 'symlink') return { icon: 'symlink', tone: 'muted', label: '符号链接' }
  if (entry.kind === 'directory') {
    for (const [group, names] of DIRECTORY_GROUPS) {
      const descriptor = DIRECTORY_ICONS[group]
      if (names.has(lowerName) && descriptor !== undefined) return descriptor
    }
    return { icon: 'folder', tone: 'muted', label: '文件夹' }
  }
  if (LOCK_FILE.test(lowerName)) return { icon: 'lock', tone: 'config', label: '依赖锁文件' }
  if (lowerName === '.env' || lowerName.startsWith('.env.')) {
    return { icon: 'lock', tone: 'sensitive', label: '环境配置文件', glyph: 'ENV' }
  }
  if (lowerName === 'dockerfile' || lowerName.startsWith('dockerfile.')) {
    return { icon: 'container', tone: 'build', label: '容器构建文件' }
  }
  if (lowerName.startsWith('readme.'))
    return { icon: 'markdown', tone: 'docs', label: '项目说明文件', glyph: 'MD' }
  if (ARCHIVE_EXTENSION.test(lowerName))
    return { icon: 'archive', tone: 'archive', label: '压缩归档文件' }
  return FILE_EXTENSIONS[extension(lowerName)] ?? { icon: 'file', tone: 'muted', label: '文件' }
}
