import { RefreshCw, Search, SearchCode } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useWorkspaceStore } from '../../../../../hooks/useWorkspace.ts'
import { useProjectWorkspace } from '../../../../../features/project-workspace/ProjectWorkspaceProvider.tsx'
import { useWorkspaceTabs } from '../../../../../features/workspace-tabs/WorkspaceTabsProvider.tsx'
import { IconButton } from '../../../../../shared/ui/IconButton.tsx'
import { QuickOpenDialog } from '../../../../../features/files/QuickOpenDialog.tsx'
import { ProjectSearchDialog } from '../../../../../features/files/ProjectSearchDialog.tsx'
import { ProjectFileTree } from '../../../../../features/files/ProjectFileTree.tsx'
import '../../../../../features/files/files.css'

export function FileLeftPanel() {
  const store = useWorkspaceStore()
  const workspace = useProjectWorkspace()
  const tabs = useWorkspaceTabs()
  const root = workspace.directories['']
  const [quickOpen, setQuickOpen] = useState(false)
  const [projectSearch, setProjectSearch] = useState(false)
  const closeQuickOpen = useCallback(() => {
    setQuickOpen(false)
  }, [])
  const closeProjectSearch = useCallback(() => {
    setProjectSearch(false)
  }, [])
  const openInBrowser = useCallback(
    async (relativePath: string) => {
      const project = store.selectedProject()
      if (project?.projectAccessId === undefined || tabs === null) return
      const opened = await tabs.openBrowserFile({
        projectId: project.id,
        projectAccessId: project.projectAccessId,
        relativePath,
      })
      if (opened) store.setView('browser')
    },
    [store, tabs],
  )
  const canOpenInBrowser =
    tabs !== null &&
    window.dshDesktop?.browser !== undefined &&
    store.selectedProject()?.projectAccessId !== undefined
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.key.toLocaleLowerCase() === 'p') {
        event.preventDefault()
        setQuickOpen(true)
      } else if (event.shiftKey && event.key.toLocaleLowerCase() === 'f') {
        event.preventDefault()
        setProjectSearch(true)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [])
  return (
    <section className="navigation-mode" aria-label="项目文件树">
      <header className="navigation-mode__header">
        <div>
          <strong>项目文件</strong>
        </div>
        <div className="navigation-mode__actions">
          <IconButton
            label={
              /Mac/u.test(navigator.platform) ? '快速打开文件（⌘P）' : '快速打开文件（Ctrl+P）'
            }
            disabled={root === undefined}
            onClick={() => {
              setQuickOpen(true)
            }}
          >
            <Search size={15} />
          </IconButton>
          <IconButton
            label={
              /Mac/u.test(navigator.platform)
                ? '搜索项目内容（⇧⌘F）'
                : '搜索项目内容（Ctrl+Shift+F）'
            }
            disabled={root === undefined}
            onClick={() => {
              setProjectSearch(true)
            }}
          >
            <SearchCode size={15} />
          </IconButton>
          <IconButton
            label="刷新项目文件"
            disabled={workspace.loading}
            onClick={() => {
              void workspace.refresh()
            }}
          >
            <RefreshCw className={workspace.loading ? 'spin' : ''} size={15} />
          </IconButton>
        </div>
      </header>
      <ProjectFileTree
        onOpenFile={workspace.openFile}
        onOpenPinnedFile={workspace.openPinnedFile}
        onOpenInBrowser={canOpenInBrowser ? openInBrowser : undefined}
      />
      <QuickOpenDialog open={quickOpen} onClose={closeQuickOpen} />
      <ProjectSearchDialog open={projectSearch} onClose={closeProjectSearch} />
    </section>
  )
}
