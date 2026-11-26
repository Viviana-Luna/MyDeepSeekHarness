export const DESKTOP_FILE_WORKSPACE_CHANNELS = Object.freeze({
  read: 'dsh-desktop:file-state:read',
  save: 'dsh-desktop:file-state:save',
})

export const DESKTOP_FILE_WORKSPACE_LIMITS = Object.freeze({
  maxProjects: 100,
  maxPinnedFiles: 12,
  maxExpandedDirectories: 100,
  maxRecentFiles: 100,
  maxRelativePathLength: 4_096,
  maxScrollOffset: 10_000_000,
})

export interface DesktopFileWorkspaceState {
  projectId: string
  pinnedFiles: readonly string[]
  previewFile?: string
  activeFile?: string
  activeLine?: number
  expandedDirectories: readonly string[]
  recentFiles: readonly string[]
  treeScrollLeft: number
  treeScrollTop: number
}
