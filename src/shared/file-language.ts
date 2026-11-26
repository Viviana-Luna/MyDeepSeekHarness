export function languageFromPath(path: string): string {
  const byExtension: Readonly<Record<string, string>> = {
    '.c': 'c',
    '.cc': 'cpp',
    '.cpp': 'cpp',
    '.css': 'css',
    '.bash': 'shell',
    '.go': 'go',
    '.htm': 'html',
    '.html': 'html',
    '.java': 'java',
    '.js': 'javascript',
    '.json': 'json',
    '.jsx': 'javascriptreact',
    '.kt': 'kotlin',
    '.kts': 'kotlin',
    '.md': 'markdown',
    '.mjs': 'javascript',
    '.py': 'python',
    '.rs': 'rust',
    '.sh': 'shell',
    '.sql': 'sql',
    '.swift': 'swift',
    '.toml': 'toml',
    '.ts': 'typescript',
    '.tsx': 'typescriptreact',
    '.vue': 'vue',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.zsh': 'shell',
  }
  const name = path.slice(path.lastIndexOf('/') + 1)
  const extensionStart = name.lastIndexOf('.')
  return extensionStart <= 0
    ? 'text'
    : (byExtension[name.slice(extensionStart).toLowerCase()] ?? 'text')
}
