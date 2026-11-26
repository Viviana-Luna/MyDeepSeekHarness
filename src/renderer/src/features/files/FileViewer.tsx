import { ArrowLeft, ArrowRight, FileCode2, Globe, RotateCcw, Save } from 'lucide-react'
import { lazy, Suspense, useEffect, useState } from 'react'
import { isBrowserPreviewablePath } from '../../../../shared/browser.ts'
import { useWorkspaceStore } from '../../hooks/useWorkspace.ts'
import { useProjectWorkspace } from '../project-workspace/ProjectWorkspaceProvider.tsx'
import { useWorkspaceTabs } from '../workspace-tabs/WorkspaceTabsProvider.tsx'
import { AppAlert } from '../../shared/ui/AppAlert.tsx'
import type { IslandPresentationProps } from '../../plugins/registry.ts'
import { FileBreadcrumb } from './FileBreadcrumb.tsx'
import './files.css'

const loadCodeEditor = () => import('./CodeEditor.tsx')
const CodeEditor = lazy(loadCodeEditor)

export function FileViewer(_props: Partial<IslandPresentationProps> = {}) {
  const workspace = useProjectWorkspace()
  const store = useWorkspaceStore()
  const tabs = useWorkspaceTabs()
  const [cursor, setCursor] = useState({ line: 1, column: 1 })
  const file = workspace.selectedFile
  const project = store.selectedProject()
  const canPreviewInBrowser =
    file !== null &&
    isBrowserPreviewablePath(file.relativePath) &&
    project?.projectAccessId !== undefined &&
    window.dshDesktop?.browser !== undefined &&
    tabs !== null
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadCodeEditor()
    }, 500)
    return () => {
      window.clearTimeout(timer)
    }
  }, [])

  if (file === null) {
    return (
      <section className="workspace-view viewer-state" aria-label="文件查看器">
        <FileCode2 size={24} />
        <strong>从左侧文件树选择文件</strong>
        <span>UTF-8 文本可在这里编辑并保存；文件与聊天共用顶部标签。</span>
      </section>
    )
  }
  return (
    <section
      className={`workspace-view ${file.kind === 'image' ? 'image-viewer' : 'code-viewer'}`}
      aria-label="文件查看器"
      data-file-path={file.relativePath}
    >
      <FileBreadcrumb path={file.relativePath} />
      {file.kind === 'text' && workspace.fileConflict !== null && (
        <div className="file-conflict-panel">
          <AppAlert
            tone="warning"
            title="文件已在磁盘上发生变化"
            onClose={workspace.dismissFileConflict}
          >
            为避免覆盖外部修改，当前保存已经停止。可以重新载入磁盘内容，或确认覆盖刚刚检测到的版本。
          </AppAlert>
          <div className="file-conflict-panel__actions">
            <button
              type="button"
              disabled={workspace.fileSaving}
              onClick={() => {
                workspace.dismissFileConflict()
              }}
            >
              取消
            </button>
            <button
              type="button"
              disabled={workspace.fileSaving}
              onClick={() => {
                void workspace.reloadSelectedFile()
              }}
            >
              重新载入
            </button>
            <button
              className="file-conflict-panel__overwrite"
              type="button"
              disabled={workspace.fileSaving}
              onClick={() => {
                void workspace.saveFile(workspace.fileConflict?.currentRevision)
              }}
            >
              仍然覆盖
            </button>
          </div>
        </div>
      )}
      {file.kind === 'image' ? (
        <div className="image-viewer__canvas">
          <img
            alt={file.relativePath}
            draggable={false}
            src={`data:${file.mediaType};base64,${file.base64}`}
          />
        </div>
      ) : (
        <Suspense
          fallback={
            <div className="code-editor code-editor--loading" role="status">
              正在加载代码编辑器…
            </div>
          }
        >
          <CodeEditor
            file={file}
            content={workspace.fileDraft ?? file.content}
            selectedLine={workspace.selectedLine}
            saving={workspace.fileSaving}
            onChange={workspace.updateFileDraft}
            onSave={() => {
              void workspace.saveFile()
            }}
            onOutlineChange={workspace.updateOutline}
            onActiveLineChange={workspace.updateActiveFileLine}
            onCursorChange={setCursor}
          />
        </Suspense>
      )}
      <footer className="view-statusbar file-statusbar" aria-label="文件状态与操作">
        <div className="file-statusbar__navigation">
          <button
            className="view-tool-button"
            type="button"
            aria-label="返回上一个文件"
            title="返回上一个文件"
            disabled={!workspace.canNavigateBack}
            onClick={() => {
              workspace.navigateFileHistory(-1)
            }}
          >
            <ArrowLeft size={14} />
          </button>
          <button
            className="view-tool-button"
            type="button"
            aria-label="前进到下一个文件"
            title="前进到下一个文件"
            disabled={!workspace.canNavigateForward}
            onClick={() => {
              workspace.navigateFileHistory(1)
            }}
          >
            <ArrowRight size={14} />
          </button>
        </div>
        <div className="file-statusbar__details">
          {file.kind === 'text' ? (
            <>
              <span>
                行 {cursor.line}，列 {cursor.column}
              </span>
              <span className="file-statusbar__encoding">UTF-8</span>
              <span>{file.language}</span>
            </>
          ) : (
            <span>
              {file.mediaType} · {file.byteLength.toLocaleString()} bytes
            </span>
          )}
        </div>
        {(file.kind === 'text' || canPreviewInBrowser) && (
          <div className="file-statusbar__actions">
            {canPreviewInBrowser && (
              <button
                type="button"
                className="view-tool-button file-preview-browser-button"
                aria-label="在内置浏览器中打开"
                title="在内置浏览器中打开"
                onClick={() => {
                  if (project?.projectAccessId === undefined || tabs === null) return
                  void tabs
                    .openBrowserFile({
                      projectId: project.id,
                      projectAccessId: project.projectAccessId,
                      relativePath: file.relativePath,
                    })
                    .then(opened => {
                      if (opened) store.setView('browser')
                    })
                }}
              >
                <Globe size={14} aria-hidden="true" />
                <span>浏览器打开</span>
              </button>
            )}
            {file.kind === 'text' && (
              <>
                {workspace.fileDirty && <span className="file-dirty-status">未保存</span>}
                <button
                  className="view-tool-button"
                  type="button"
                  aria-label="放弃文件更改"
                  title="放弃更改"
                  disabled={!workspace.fileDirty || workspace.fileSaving}
                  onClick={() => {
                    workspace.discardFileChanges()
                  }}
                >
                  <RotateCcw size={14} />
                </button>
                <button
                  type="button"
                  className="view-tool-button file-save-button"
                  disabled={!workspace.fileDirty || workspace.fileSaving}
                  onClick={() => {
                    void workspace.saveFile()
                  }}
                >
                  <Save size={14} />
                  {workspace.fileSaving ? '保存中' : '保存'}
                </button>
              </>
            )}
          </div>
        )}
      </footer>
    </section>
  )
}
