/** renderer 文件路径栏：以紧凑形式展示当前文件路径，不持有文件或编辑器状态。 */

/** 展示路径末尾的目录与文件名，完整路径保留给辅助技术和提示。 */
export function FileBreadcrumb({ path }: { readonly path: string }) {
  const parts = path.split('/').filter(Boolean)
  const visible = parts.slice(-3)
  return (
    <nav className="file-breadcrumb" aria-label={`文件路径：${path}`} title={path}>
      <div aria-hidden="true">
        {parts.length > visible.length && <span className="file-breadcrumb__ellipsis">…</span>}
        {visible.map((part, index) => (
          <span key={`${String(index)}:${part}`} className="file-breadcrumb__part">
            {part}
          </span>
        ))}
      </div>
    </nav>
  )
}
