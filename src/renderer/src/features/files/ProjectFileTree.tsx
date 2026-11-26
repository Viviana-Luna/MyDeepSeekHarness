/**
 * 项目文件树组件：渲染项目目录层级、文件图标、快速浏览器预览入口与右键菜单。
 * 运行在 renderer；展开目录和打开文件动作通过 `ProjectWorkspaceProvider` 与工作台标签协同完成。
 */
import {
  Atom,
  ChevronDown,
  ChevronRight,
  Container,
  Database,
  File,
  FileArchive,
  FileCode2,
  FileCog,
  FileImage,
  FileLock2,
  FileSymlink,
  FileTerminal,
  FileText,
  FileType,
  Folder,
  FolderArchive,
  FolderCode,
  FolderCog,
  FolderKanban,
  FolderKey,
  FolderOpen,
  FolderOpenDot,
  FolderOutput,
  FolderSearch,
  Globe,
  LoaderCircle,
  type LucideIcon,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { isBrowserDirectOpenPath, isBrowserPreviewablePath } from '../../../../shared/browser.ts'
import { AnchoredMenu } from '../../shared/ui/AnchoredMenu.tsx'
import { useProjectWorkspace } from '../project-workspace/ProjectWorkspaceProvider.tsx'
import type { DirectoryEntry } from '../project-workspace/project-types.ts'
import { describeFileIcon, type FileIconName } from './file-icon-registry.ts'

const FILE_ICONS: Readonly<Partial<Record<FileIconName, LucideIcon>>> = Object.freeze({
  archive: FileArchive,
  code: FileCode2,
  config: FileCog,
  container: Container,
  data: Database,
  file: File,
  'folder-archive': FolderArchive,
  'folder-assets': FolderOpenDot,
  'folder-build': FolderOutput,
  'folder-config': FolderCog,
  'folder-docs': FolderKanban,
  'folder-source': FolderCode,
  'folder-test': FolderSearch,
  'folder-sensitive': FolderKey,
  folder: Folder,
  image: FileImage,
  lock: FileLock2,
  markdown: FileText,
  react: Atom,
  symlink: FileSymlink,
  terminal: FileTerminal,
  text: FileType,
})

function FileTreeIcon({ entry, expanded }: { entry: DirectoryEntry; expanded: boolean }) {
  const descriptor = describeFileIcon(entry)
  const Icon =
    entry.kind === 'directory' && expanded ? FolderOpen : (FILE_ICONS[descriptor.icon] ?? File)
  return (
    <span
      aria-hidden="true"
      className="file-icon"
      data-icon={descriptor.icon}
      data-tone={descriptor.tone}
    >
      {descriptor.glyph === undefined ? (
        <Icon size={15} strokeWidth={1.8} />
      ) : (
        <span className="file-icon__glyph">{descriptor.glyph}</span>
      )}
    </span>
  )
}

interface TreeEntryProps {
  readonly entry: DirectoryEntry
  readonly depth: number
  readonly onOpenFile: (relativePath: string) => void | Promise<unknown>
  readonly onOpenPinnedFile?: ((relativePath: string) => void | Promise<unknown>) | undefined
  readonly onOpenInBrowser?: ((relativePath: string) => void | Promise<unknown>) | undefined
  readonly pendingPath?: string | null | undefined
}

function TreeFileEntry({
  entry,
  depth,
  onOpenFile,
  onOpenPinnedFile,
  onOpenInBrowser,
  pendingPath,
}: TreeEntryProps) {
  const workspace = useProjectWorkspace()
  const selected = workspace.selectedFile?.relativePath === entry.relativePath
  const rowRef = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const dismissMenu = useCallback(() => {
    setMenuOpen(false)
  }, [])
  useEffect(() => {
    if (!selected) return
    rowRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [selected])

  const pending = pendingPath === entry.relativePath
  const canPreviewInBrowser =
    entry.kind === 'file' &&
    onOpenInBrowser !== undefined &&
    isBrowserPreviewablePath(entry.relativePath)
  const directBrowserOpen = canPreviewInBrowser && isBrowserDirectOpenPath(entry.relativePath)
  const hasContextMenu =
    entry.kind === 'file' && (canPreviewInBrowser || onOpenPinnedFile !== undefined)

  return (
    <li>
      <div className={`tree-row-shell${selected ? ' is-selected' : ''}`}>
        <button
          ref={rowRef}
          className={`tree-row${selected ? ' is-selected' : ''}`}
          style={{ paddingInlineStart: `${String(22 + depth * 14)}px` }}
          type="button"
          disabled={entry.kind === 'symlink'}
          aria-busy={pending || undefined}
          aria-current={selected ? 'page' : undefined}
          aria-keyshortcuts={hasContextMenu ? 'Shift+F10' : undefined}
          aria-label={`${entry.name}，${describeFileIcon(entry).label}`}
          title={
            entry.kind === 'symlink'
              ? `${entry.relativePath}（为避免越过项目边界，暂不跟随符号链接）`
              : entry.relativePath
          }
          onClick={event => {
            if (pending || event.detail > 1) return
            if (directBrowserOpen) void onOpenInBrowser?.(entry.relativePath)
            else void onOpenFile(entry.relativePath)
          }}
          onDoubleClick={
            directBrowserOpen || onOpenPinnedFile === undefined
              ? undefined
              : () => {
                  void onOpenPinnedFile(entry.relativePath)
                }
          }
          onContextMenu={
            hasContextMenu
              ? event => {
                  event.preventDefault()
                  setMenuOpen(true)
                }
              : undefined
          }
          onKeyDown={
            hasContextMenu
              ? event => {
                  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))
                    return
                  event.preventDefault()
                  setMenuOpen(true)
                }
              : undefined
          }
        >
          {pending ? (
            <LoaderCircle className="spin" size={15} aria-hidden="true" />
          ) : (
            <FileTreeIcon entry={entry} expanded={false} />
          )}
          <span className="tree-row__name">{entry.name}</span>
        </button>
        {canPreviewInBrowser && (
          <button
            type="button"
            className="tree-row__action"
            aria-label={`在内置浏览器中打开 ${entry.name}`}
            title="在内置浏览器中打开"
            onClick={event => {
              event.stopPropagation()
              void onOpenInBrowser?.(entry.relativePath)
            }}
          >
            <Globe size={13} aria-hidden="true" />
          </button>
        )}
      </div>
      {hasContextMenu && (
        <AnchoredMenu
          open={menuOpen}
          anchorRef={rowRef}
          className="file-tree-context-menu"
          label={`${entry.name} 操作`}
          onDismiss={dismissMenu}
        >
          {canPreviewInBrowser && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                dismissMenu()
                void onOpenInBrowser?.(entry.relativePath)
              }}
            >
              在内置浏览器中打开
            </button>
          )}
          {!directBrowserOpen && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                dismissMenu()
                void onOpenFile(entry.relativePath)
              }}
            >
              在编辑器中打开
            </button>
          )}
          {!directBrowserOpen && onOpenPinnedFile !== undefined && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                dismissMenu()
                void onOpenPinnedFile(entry.relativePath)
              }}
            >
              固定标签打开
            </button>
          )}
        </AnchoredMenu>
      )}
    </li>
  )
}

function TreeEntry({
  entry,
  depth,
  onOpenFile,
  onOpenPinnedFile,
  onOpenInBrowser,
  pendingPath,
}: TreeEntryProps) {
  const workspace = useProjectWorkspace()
  const expanded = workspace.expandedDirectories.has(entry.relativePath)
  const children = workspace.directories[entry.relativePath]?.entries ?? []
  if (entry.kind === 'directory') {
    return (
      <li>
        <button
          className="tree-row"
          style={{ paddingInlineStart: `${String(8 + depth * 14)}px` }}
          type="button"
          title={entry.relativePath}
          aria-label={`${entry.name}，${describeFileIcon(entry).label}`}
          aria-expanded={expanded}
          onClick={() => {
            void workspace.toggleDirectory(entry.relativePath)
          }}
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <FileTreeIcon entry={entry} expanded={expanded} />
          <span className="tree-row__name">{entry.name}</span>
        </button>
        {expanded && children.length > 0 && (
          <ul>
            {children.map(child => (
              <TreeEntry
                key={child.relativePath}
                entry={child}
                depth={depth + 1}
                onOpenFile={onOpenFile}
                onOpenPinnedFile={onOpenPinnedFile}
                onOpenInBrowser={onOpenInBrowser}
                pendingPath={pendingPath}
              />
            ))}
          </ul>
        )}
      </li>
    )
  }
  return (
    <TreeFileEntry
      entry={entry}
      depth={depth}
      onOpenFile={onOpenFile}
      onOpenPinnedFile={onOpenPinnedFile}
      onOpenInBrowser={onOpenInBrowser}
      pendingPath={pendingPath}
    />
  )
}

/**
 * 渲染当前项目的可折叠文件树及底部索引状态提示。
 * 支持单击编辑/图片预览，以及对 HTML、SVG、PDF 等可预览文件触发内置浏览器打开。
 */
export function ProjectFileTree({
  onOpenFile,
  onOpenPinnedFile,
  onOpenInBrowser,
  persistScroll = true,
  pendingPath = null,
}: {
  readonly onOpenFile: (relativePath: string) => void | Promise<unknown>
  readonly onOpenPinnedFile?: ((relativePath: string) => void | Promise<unknown>) | undefined
  readonly onOpenInBrowser?: ((relativePath: string) => void | Promise<unknown>) | undefined
  readonly persistScroll?: boolean
  readonly pendingPath?: string | null
}) {
  const workspace = useProjectWorkspace()
  const root = workspace.directories['']
  const treeRef = useRef<HTMLUListElement>(null)
  useEffect(() => {
    if (!persistScroll) return
    const tree = treeRef.current
    if (tree === null) return
    tree.scrollLeft = workspace.treeScrollLeft
    tree.scrollTop = workspace.treeScrollTop
  }, [persistScroll, root, workspace.treeScrollLeft, workspace.treeScrollTop])
  const hasEntries = root !== undefined && root.entries.length > 0
  return (
    <>
      {root === undefined && (
        <p className="navigation-empty">
          {workspace.loading ? '正在读取文件树…' : '当前项目没有可显示的文件树。'}
        </p>
      )}
      {root !== undefined && root.entries.length === 0 && (
        <p className="navigation-empty">当前项目目录为空。</p>
      )}
      {hasEntries && (
        <ul
          ref={treeRef}
          className="file-tree"
          onScroll={
            persistScroll
              ? event => {
                  workspace.updateTreeScroll(
                    event.currentTarget.scrollLeft,
                    event.currentTarget.scrollTop,
                  )
                }
              : undefined
          }
        >
          {root.entries.map(entry => (
            <TreeEntry
              key={entry.relativePath}
              entry={entry}
              depth={0}
              onOpenFile={onOpenFile}
              onOpenPinnedFile={onOpenPinnedFile}
              onOpenInBrowser={onOpenInBrowser}
              pendingPath={pendingPath}
            />
          ))}
        </ul>
      )}
      {root?.truncated && <p className="navigation-note">目录项目过多，仅显示前 1000 项。</p>}
      {workspace.fileIndexStatus.phase === 'building' && (
        <p className="navigation-note">正在建立文件索引…</p>
      )}
      {workspace.fileIndexStatus.phase === 'partial' && (
        <p className="navigation-note">文件索引只完成了一部分。</p>
      )}
      {workspace.fileIndexStatus.phase === 'error' && (
        <p className="navigation-error">
          {workspace.fileIndexStatus.message ?? '文件索引暂不可用。'}
        </p>
      )}
    </>
  )
}
