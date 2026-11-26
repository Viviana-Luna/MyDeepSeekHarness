import { Braces, Box, FunctionSquare, Hash, ListTree, Rows3 } from 'lucide-react'
import type { CSSProperties } from 'react'
import { useProjectWorkspace } from '../project-workspace/ProjectWorkspaceProvider.tsx'
import type { OutlineItemKind } from '../project-workspace/project-types.ts'

function OutlineIcon({ kind }: { kind: OutlineItemKind }) {
  if (kind === 'class') return <Box size={13} aria-hidden="true" />
  if (kind === 'interface' || kind === 'type') return <Braces size={13} aria-hidden="true" />
  if (kind === 'heading') return <Hash size={13} aria-hidden="true" />
  if (kind === 'method') return <Rows3 size={13} aria-hidden="true" />
  return <FunctionSquare size={13} aria-hidden="true" />
}

export function FileOutlinePanel() {
  const workspace = useProjectWorkspace()
  const file = workspace.selectedFile
  const items = workspace.outlineItems
  return (
    <div className="contextual-inspector file-outline-panel">
      <header>
        <div>
          <h2>大纲</h2>
        </div>
        <ListTree size={15} aria-hidden="true" />
      </header>
      {file?.kind !== 'text' ? (
        <p className="contextual-panel-empty">打开代码或 Markdown 文件后显示当前文件结构。</p>
      ) : items.length === 0 ? (
        <p className="contextual-panel-empty">当前文件没有可用大纲。</p>
      ) : (
        <nav aria-label={`${file.relativePath} 的大纲`}>
          <ul className="file-outline-list">
            {items.map(item => (
              <li key={item.id} style={{ '--outline-depth': item.depth } as CSSProperties}>
                <button
                  type="button"
                  aria-current={workspace.selectedLine === item.line ? 'location' : undefined}
                  onClick={() => {
                    workspace.revealOutlineLine(item.line)
                  }}
                >
                  <OutlineIcon kind={item.kind} />
                  <span>{item.label}</span>
                  <small>{item.line}</small>
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  )
}
