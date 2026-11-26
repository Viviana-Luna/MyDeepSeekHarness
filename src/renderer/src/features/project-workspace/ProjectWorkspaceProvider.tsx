import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SetStateAction,
} from 'react'
import { useWorkspaceSnapshot, useWorkspaceStore } from '../../hooks/useWorkspace.ts'
import {
  parseDirectoryListing,
  parseContentSearchResult,
  parseFileIndexQueryResult,
  parseFileIndexStatus,
  parseFileWorkspaceState,
  parseProjectFile,
  parseProjectFileWriteResult,
  type DirectoryListing,
  type ContentSearchResult,
  type FileIndexQueryResult,
  type FileIndexStatus,
  type FileWorkspaceTab,
  type ProjectFile,
  type ProjectFileWriteResult,
  type OutlineItem,
} from './project-types.ts'
import { DESKTOP_FILE_WORKSPACE_LIMITS } from '../../../../shared/file-workspace-state.ts'

interface FileDocument {
  selectedFile: ProjectFile
  fileDraft: string | null
  fileSaving: boolean
  fileConflict: Extract<ProjectFileWriteResult, { status: 'conflict' }> | null
  outlineItems: readonly OutlineItem[]
  selectedLine: number | null
}

interface ProjectWorkspaceState {
  documents: Readonly<Record<string, FileDocument>>
  closeProjectTabs(sessionIds: readonly string[], closeOthers: () => void): void
  directories: Readonly<Record<string, DirectoryListing>>
  expandedDirectories: ReadonlySet<string>
  selectedFile: ProjectFile | null
  fileDraft: string | null
  fileDirty: boolean
  fileSaving: boolean
  fileConflict: Extract<ProjectFileWriteResult, { status: 'conflict' }> | null
  outlineItems: readonly OutlineItem[]
  unsavedChangesReason: string | null
  unsavedChangesPaths: readonly string[]
  selectedLine: number | null
  openFiles: readonly FileWorkspaceTab[]
  canNavigateBack: boolean
  canNavigateForward: boolean
  treeScrollLeft: number
  treeScrollTop: number
  fileIndexStatus: FileIndexStatus
  loading: boolean
  error: string | null
  clearError(): void
  refresh(): Promise<void>
  toggleDirectory(relativePath: string): Promise<void>
  openFile(relativePath: string, line?: number): Promise<void>
  openFileFromConversation(relativePath: string, line?: number): Promise<boolean>
  openPinnedFile(relativePath: string): Promise<void>
  selectFileTab(relativePath: string): void
  pinFile(relativePath: string): void
  closeFileTab(relativePath: string): void
  navigateFileHistory(direction: -1 | 1): void
  revealDirectory(relativePath: string): Promise<void>
  updateTreeScroll(left: number, top: number): void
  updateFileDraft(content: string, path?: string): void
  saveFile(overwriteRevision?: string, path?: string): Promise<boolean>
  reloadSelectedFile(path?: string): Promise<void>
  discardFileChanges(path?: string): void
  dismissFileConflict(path?: string): void
  updateOutline(items: readonly OutlineItem[], path?: string): void
  updateActiveFileLine(line: number, path?: string): void
  revealOutlineLine(line: number): void
  resolveUnsavedChanges(choice: 'save' | 'discard' | 'cancel'): Promise<void>
  selectProject(projectId: string | null): void
  navigateProjectTab(projectId: string, action: () => void): void
  selectSession(sessionId: string, showAllProjects?: boolean): void
  selectSessionTab(sessionId: string): void
  closeSessionTab(sessionId: string): void
  createSession(projectId?: string, agentPreset?: string): void
  createWorkspace(): void
  buildFileIndex(force?: boolean): Promise<void>
  queryFiles(query: string): Promise<FileIndexQueryResult>
  searchContent(query: string, caseSensitive: boolean): Promise<ContentSearchResult>
  cancelContentSearch(): void
}

interface PendingUnsavedAction {
  readonly kind: 'navigation' | 'close'
  readonly reason: string
  readonly paths?: readonly string[]
  readonly run: () => unknown | Promise<unknown>
  readonly cancel?: () => unknown | Promise<unknown>
}

interface OpenFileOptions {
  pin?: boolean
  preserveTabs?: boolean
  historyIndex?: number
  skipHistory?: boolean
  silent?: boolean
  activateView?: boolean
  reload?: boolean
}

const ProjectWorkspaceContext = createContext<ProjectWorkspaceState | null>(null)

const EMPTY_FILE_INDEX_STATUS: FileIndexStatus = Object.freeze({
  phase: 'idle',
  fileCount: 0,
})

const MAX_FILE_HISTORY = 100

function parentDirectory(relativePath: string): string {
  const separator = relativePath.lastIndexOf('/')
  return separator < 0 ? '' : relativePath.slice(0, separator)
}

function directoryAncestors(relativePath: string): string[] {
  if (relativePath === '') return ['']
  const segments = relativePath.split('/').filter(Boolean)
  return ['', ...segments.map((_segment, index) => segments.slice(0, index + 1).join('/'))]
}

function message(error: unknown): string {
  const raw = error instanceof Error ? error.message : '项目工作区操作失败'
  return raw
    .replace(/^Error invoking remote method '[^']+': Error:\s*/u, '')
    .replace(/^Error:\s*/u, '')
}

export function ProjectWorkspaceProvider({ children }: { children: ReactNode }) {
  const store = useWorkspaceStore()
  const snapshot = useWorkspaceSnapshot()
  const selectedSession = snapshot.sessions.find(
    session => session.sessionId === snapshot.selectedSessionId,
  )
  const projectId =
    snapshot.selectedProjectId ??
    snapshot.projects.find(project => project.cwd === selectedSession?.cwd)?.id ??
    null
  const projectAccessId =
    snapshot.projects.find(project => project.id === projectId)?.projectAccessId ?? null
  const fileWorkspaceApi = window.dshDesktop?.fileWorkspace
  const generation = useRef(0)
  const fileIndexRequestGeneration = useRef(0)
  const fileRequestGeneration = useRef(0)
  const contentSearchRequestGeneration = useRef(0)
  const projectIdRef = useRef(projectId)
  projectIdRef.current = projectId
  const projectAccessIdRef = useRef(projectAccessId)
  projectAccessIdRef.current = projectAccessId
  const [directories, setDirectories] = useState<Record<string, DirectoryListing>>({})
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(new Set(['']))
  const [documents, setDocuments] = useState<Record<string, FileDocument>>({})
  const documentsRef = useRef(documents)
  documentsRef.current = documents
  const [activePath, setActivePath] = useState<string | null>(null)
  const activePathRef = useRef(activePath)
  activePathRef.current = activePath
  const currentDocument = activePath === null ? undefined : documents[activePath]
  const selectedFile = currentDocument?.selectedFile ?? null
  const fileDraft = currentDocument?.fileDraft ?? null
  const fileSaving = currentDocument?.fileSaving ?? false
  const fileConflict = currentDocument?.fileConflict ?? null
  const outlineItems = currentDocument?.outlineItems ?? []
  const selectedLine = currentDocument?.selectedLine ?? null
  const setSelectedFile = useCallback((file: ProjectFile | null) => {
    activePathRef.current = file?.relativePath ?? null
    setActivePath(file?.relativePath ?? null)
    if (file)
      setDocuments(current => ({
        ...current,
        [file.relativePath]: current[file.relativePath]
          ? { ...current[file.relativePath]!, selectedFile: file }
          : {
              selectedFile: file,
              fileDraft: file.kind === 'text' ? file.content : null,
              fileSaving: false,
              fileConflict: null,
              outlineItems: [],
              selectedLine: null,
            },
      }))
  }, [])
  const updateDocument = useCallback(
    <K extends keyof FileDocument>(
      key: K,
      value: SetStateAction<FileDocument[K]>,
      path = activePathRef.current,
    ) => {
      if (path === null) return
      setDocuments(current => {
        const doc = current[path]
        if (!doc) return current
        const next =
          typeof value === 'function'
            ? (value as (previous: FileDocument[K]) => FileDocument[K])(doc[key])
            : value
        return { ...current, [path]: { ...doc, [key]: next } }
      })
    },
    [],
  )
  const setFileDraft = useCallback(
    (value: SetStateAction<string | null>) => {
      updateDocument('fileDraft', value)
    },
    [updateDocument],
  )
  const setFileConflict = useCallback(
    (value: FileDocument['fileConflict']) => {
      updateDocument('fileConflict', value)
    },
    [updateDocument],
  )
  const setOutlineItems = useCallback(
    (value: readonly OutlineItem[]) => {
      updateDocument('outlineItems', value)
    },
    [updateDocument],
  )
  const setSelectedLine = useCallback(
    (value: SetStateAction<number | null>) => {
      updateDocument('selectedLine', value)
    },
    [updateDocument],
  )
  const [unsavedChangesReason, setUnsavedChangesReason] = useState<string | null>(null)
  const pendingUnsavedAction = useRef<PendingUnsavedAction | null>(null)
  const [openFiles, setOpenFiles] = useState<FileWorkspaceTab[]>([])
  const [fileHistory, setFileHistory] = useState<string[]>([])
  useEffect(() => {
    const opened = new Set(openFiles.map(file => file.relativePath))
    setDocuments(current =>
      Object.keys(current).some(path => !opened.has(path))
        ? Object.fromEntries(Object.entries(current).filter(([path]) => opened.has(path)))
        : current,
    )
  }, [openFiles])
  const [fileHistoryIndex, setFileHistoryIndex] = useState(-1)
  const [recentFiles, setRecentFiles] = useState<string[]>([])
  const [treeScrollLeft, setTreeScrollLeft] = useState(0)
  const [treeScrollTop, setTreeScrollTop] = useState(0)
  const [workspaceRestored, setWorkspaceRestored] = useState(false)
  const [fileIndexStatus, setFileIndexStatus] = useState<FileIndexStatus>(EMPTY_FILE_INDEX_STATUS)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const directoriesRef = useRef(directories)
  directoriesRef.current = directories
  const openFilesRef = useRef(openFiles)
  openFilesRef.current = openFiles
  const fileHistoryRef = useRef(fileHistory)
  fileHistoryRef.current = fileHistory
  const fileHistoryIndexRef = useRef(fileHistoryIndex)
  fileHistoryIndexRef.current = fileHistoryIndex
  const clearError = useCallback(() => {
    setError(null)
  }, [])
  const hasDirtyDocuments = Object.values(documents).some(
    doc => doc.selectedFile.kind === 'text' && doc.fileDraft !== doc.selectedFile.content,
  )
  const fileDirty =
    selectedFile?.kind === 'text' && fileDraft !== null && fileDraft !== selectedFile.content

  /** 刷新文件索引和目录；用户配置的项目任务由独立任务服务管理。 */
  const performRefresh = useCallback(async (): Promise<DirectoryListing | null> => {
    const currentGeneration = ++generation.current
    const currentIndexGeneration = ++fileIndexRequestGeneration.current
    fileRequestGeneration.current += 1
    contentSearchRequestGeneration.current += 1
    const project = store.selectedProject()
    setSelectedFile(null)
    setFileDraft(null)
    setFileConflict(null)
    setOutlineItems([])
    setSelectedLine(null)
    setFileIndexStatus(EMPTY_FILE_INDEX_STATUS)
    setError(null)
    if (project?.cwd === undefined || project.projectAccessId === undefined) {
      setDirectories({})
      setFileIndexStatus(EMPTY_FILE_INDEX_STATUS)
      setLoading(false)
      return null
    }
    setLoading(true)
    setFileIndexStatus({ phase: 'building', fileCount: 0 })
    void store
      .callProject('buildFileIndex', { force: true })
      .then(value => {
        if (
          fileIndexRequestGeneration.current !== currentIndexGeneration ||
          projectIdRef.current !== projectId
        )
          return
        setFileIndexStatus(parseFileIndexStatus(value))
      })
      .catch((caught: unknown) => {
        if (
          fileIndexRequestGeneration.current !== currentIndexGeneration ||
          projectIdRef.current !== projectId
        )
          return
        setFileIndexStatus({
          phase: 'error',
          fileCount: 0,
          message: message(caught),
        })
      })
    let loadedRoot: DirectoryListing | null = null
    try {
      const directoryValue = await store.callProject('listDirectory', { relativePath: '' })
      if (generation.current !== currentGeneration) return null
      const root = parseDirectoryListing(directoryValue)
      loadedRoot = root
      setDirectories({ '': root })
      setExpandedDirectories(new Set(['']))
    } catch (caught) {
      if (generation.current === currentGeneration) setError(message(caught))
    } finally {
      if (generation.current === currentGeneration) {
        setLoading(false)
      }
    }
    return loadedRoot
  }, [projectId, store])

  const toggleDirectory = useCallback(
    async (relativePath: string) => {
      if (expandedDirectories.has(relativePath)) {
        setExpandedDirectories(current => {
          const next = new Set(current)
          next.delete(relativePath)
          return next
        })
        return
      }
      try {
        let listing = directories[relativePath]
        if (listing === undefined) {
          const loadedListing = parseDirectoryListing(
            await store.callProject('listDirectory', { relativePath }),
          )
          listing = loadedListing
          setDirectories(current => ({ ...current, [relativePath]: loadedListing }))
        }
        setExpandedDirectories(current => new Set(current).add(relativePath))
        setError(null)
      } catch (caught) {
        setError(message(caught))
      }
    },
    [directories, expandedDirectories, store],
  )

  const revealDirectory = useCallback(
    async (relativePath: string) => {
      const ancestors = directoryAncestors(relativePath)
      try {
        const missing = ancestors.filter(path => directoriesRef.current[path] === undefined)
        const loaded = await Promise.all(
          missing.map(
            async path =>
              [
                path,
                parseDirectoryListing(
                  await store.callProject('listDirectory', { relativePath: path }),
                ),
              ] as const,
          ),
        )
        if (loaded.length > 0) {
          setDirectories(current => ({ ...current, ...Object.fromEntries(loaded) }))
        }
        const available = new Set([
          ...Object.keys(directoriesRef.current),
          ...loaded.map(([path]) => path),
        ])
        setExpandedDirectories(
          current => new Set([...current, ...ancestors.filter(path => available.has(path))]),
        )
        setError(null)
      } catch (caught) {
        setError(message(caught))
      }
    },
    [store],
  )

  const updateTreeScroll = useCallback((left: number, top: number) => {
    if (!Number.isFinite(left) || !Number.isFinite(top)) return
    setTreeScrollLeft(Math.max(0, Math.round(left)))
    setTreeScrollTop(Math.max(0, Math.round(top)))
  }, [])

  const pinFile = useCallback((relativePath: string) => {
    const tab = openFilesRef.current.find(candidate => candidate.relativePath === relativePath)
    if (tab === undefined || tab.pinned) return
    if (
      openFilesRef.current.filter(candidate => candidate.pinned).length >=
      DESKTOP_FILE_WORKSPACE_LIMITS.maxPinnedFiles
    ) {
      setError(`最多只能固定 ${String(DESKTOP_FILE_WORKSPACE_LIMITS.maxPinnedFiles)} 个文件标签`)
      return
    }
    setOpenFiles(current => {
      return current.map(candidate =>
        candidate.relativePath === relativePath ? { ...candidate, pinned: true } : candidate,
      )
    })
  }, [])

  const queueUnsavedAction = useCallback((action: PendingUnsavedAction) => {
    const paths =
      action.paths ??
      Object.keys(documentsRef.current).filter(path => {
        const doc = documentsRef.current[path]!
        return doc.selectedFile.kind === 'text' && doc.fileDraft !== doc.selectedFile.content
      })
    if (paths.length === 0) {
      void action.run()
      return
    }
    if (pendingUnsavedAction.current !== null && action.kind !== 'close') return
    pendingUnsavedAction.current = { ...action, paths }
    setUnsavedChangesReason(action.reason)
  }, [])

  const loadFile = useCallback(
    async (
      relativePath: string,
      line?: number,
      options: OpenFileOptions = {},
    ): Promise<boolean> => {
      const existingTab = openFilesRef.current.find(tab => tab.relativePath === relativePath)
      if (
        options.pin === true &&
        existingTab?.pinned !== true &&
        openFilesRef.current.filter(tab => tab.pinned).length >=
          DESKTOP_FILE_WORKSPACE_LIMITS.maxPinnedFiles
      ) {
        if (options.silent !== true) {
          setError(
            `最多只能固定 ${String(DESKTOP_FILE_WORKSPACE_LIMITS.maxPinnedFiles)} 个文件标签`,
          )
        }
        return false
      }
      const requestGeneration = ++fileRequestGeneration.current
      const requestProjectId = projectId
      setLoading(true)
      if (options.silent !== true) setError(null)
      try {
        const cached = options.reload ? undefined : documentsRef.current[relativePath]
        const file =
          cached?.selectedFile ??
          parseProjectFile(await store.callProject('readFile', { relativePath, trackRecent: true }))
        if (
          fileRequestGeneration.current !== requestGeneration ||
          projectIdRef.current !== requestProjectId
        )
          return false
        setSelectedFile(file)
        if (!cached) {
          setFileDraft(file.kind === 'text' ? file.content : null)
          setFileConflict(null)
          setOutlineItems([])
        }
        setSelectedLine(Number.isSafeInteger(line) && Number(line) > 0 ? Number(line) : null)
        if (options.preserveTabs !== true) {
          setOpenFiles(current => {
            const existing = current.find(tab => tab.relativePath === relativePath)
            if (existing !== undefined) {
              return options.pin === true && !existing.pinned
                ? current.map(tab =>
                    tab.relativePath === relativePath ? { ...tab, pinned: true } : tab,
                  )
                : current
            }
            if (options.pin === true) return [...current, { relativePath, pinned: true }]
            return [...current.filter(tab => tab.pinned), { relativePath, pinned: false }]
          })
        }
        setRecentFiles(current =>
          [relativePath, ...current.filter(path => path !== relativePath)].slice(0, 100),
        )
        if (options.historyIndex !== undefined) {
          setFileHistoryIndex(options.historyIndex)
        } else if (options.skipHistory !== true) {
          const history = fileHistoryRef.current.slice(0, fileHistoryIndexRef.current + 1)
          if (history.at(-1) !== relativePath) history.push(relativePath)
          const bounded = history.slice(-MAX_FILE_HISTORY)
          setFileHistory(bounded)
          setFileHistoryIndex(bounded.length - 1)
        }
        setError(null)
        if (options.activateView !== false) store.setView('files')
        return true
      } catch (caught) {
        if (
          fileRequestGeneration.current === requestGeneration &&
          projectIdRef.current === requestProjectId &&
          options.silent !== true
        )
          setError(message(caught))
        return false
      } finally {
        if (
          fileRequestGeneration.current === requestGeneration &&
          projectIdRef.current === requestProjectId
        )
          setLoading(false)
      }
    },
    [projectId, store],
  )

  const performOpenFile = useCallback(
    async (relativePath: string, line?: number, options: OpenFileOptions = {}) => {
      const preview = openFilesRef.current.find(tab => !tab.pinned)
      const document =
        preview === undefined ? undefined : documentsRef.current[preview.relativePath]
      const replacesPreview =
        options.pin !== true &&
        options.preserveTabs !== true &&
        !openFilesRef.current.some(tab => tab.relativePath === relativePath)
      if (
        replacesPreview &&
        preview &&
        document?.selectedFile.kind === 'text' &&
        document.fileDraft !== document.selectedFile.content
      ) {
        queueUnsavedAction({
          kind: 'navigation',
          paths: [preview.relativePath],
          reason: `打开 ${relativePath}`,
          run: () => loadFile(relativePath, line, options),
        })
        return false
      }
      return loadFile(relativePath, line, options)
    },
    [loadFile, queueUnsavedAction],
  )

  useEffect(() => {
    let active = true
    setWorkspaceRestored(false)
    setDocuments({})
    setOpenFiles([])
    setFileHistory([])
    setFileHistoryIndex(-1)
    setRecentFiles([])
    setTreeScrollLeft(0)
    setTreeScrollTop(0)
    void (async () => {
      const root = await performRefresh()
      if (!active || projectAccessId === null || root === null) {
        if (active && projectAccessId === null) setWorkspaceRestored(true)
        return
      }
      if (fileWorkspaceApi === undefined) {
        setWorkspaceRestored(true)
        return
      }
      const restored = parseFileWorkspaceState(await fileWorkspaceApi.read(projectAccessId))
      if (!active || restored === null || restored.projectId !== projectAccessId) {
        if (active) setWorkspaceRestored(true)
        return
      }
      const candidateFiles = [
        ...restored.pinnedFiles,
        ...(restored.previewFile === undefined ? [] : [restored.previewFile]),
      ]
      const directoryPaths = new Set([
        ...restored.expandedDirectories,
        ...candidateFiles.map(parentDirectory),
      ])
      directoryPaths.delete('')
      const loadedEntries = await Promise.all(
        [...directoryPaths].map(async relativePath => {
          try {
            return [
              relativePath,
              parseDirectoryListing(await store.callProject('listDirectory', { relativePath })),
            ] as const
          } catch {
            return null
          }
        }),
      )
      if (!active || projectIdRef.current !== projectId) return
      const loadedDirectories: Record<string, DirectoryListing> = { '': root }
      for (const entry of loadedEntries) {
        if (entry !== null) loadedDirectories[entry[0]] = entry[1]
      }
      const validFile = (relativePath: string): boolean =>
        loadedDirectories[parentDirectory(relativePath)]?.entries.some(
          entry => entry.kind === 'file' && entry.relativePath === relativePath,
        ) === true
      const pinnedFiles = restored.pinnedFiles
        .filter(validFile)
        .slice(0, DESKTOP_FILE_WORKSPACE_LIMITS.maxPinnedFiles)
      const previewFile =
        restored.previewFile !== undefined &&
        !pinnedFiles.includes(restored.previewFile) &&
        validFile(restored.previewFile)
          ? restored.previewFile
          : undefined
      const tabs: FileWorkspaceTab[] = [
        ...pinnedFiles.map(relativePath => ({ relativePath, pinned: true })),
        ...(previewFile === undefined ? [] : [{ relativePath: previewFile, pinned: false }]),
      ]
      const activeFile =
        restored.activeFile !== undefined &&
        tabs.some(tab => tab.relativePath === restored.activeFile)
          ? restored.activeFile
          : tabs[0]?.relativePath
      setDirectories(loadedDirectories)
      setExpandedDirectories(
        new Set(
          restored.expandedDirectories
            .filter(path => path === '' || loadedDirectories[path] !== undefined)
            .concat(''),
        ),
      )
      setOpenFiles(tabs)
      setRecentFiles(restored.recentFiles.filter(validFile).slice(0, 100))
      setTreeScrollLeft(restored.treeScrollLeft)
      setTreeScrollTop(restored.treeScrollTop)
      if (activeFile !== undefined) {
        const opened = await performOpenFile(activeFile, restored.activeLine, {
          preserveTabs: true,
          skipHistory: true,
          silent: true,
          activateView: false,
        })
        if (active && opened) {
          setFileHistory([activeFile])
          setFileHistoryIndex(0)
        } else if (active) {
          setOpenFiles(current => current.filter(tab => tab.relativePath !== activeFile))
        }
      }
      if (active) setWorkspaceRestored(true)
    })().catch((caught: unknown) => {
      if (!active) return
      setError(`无法恢复文件工作区：${message(caught)}`)
    })
    return () => {
      active = false
      generation.current += 1
      fileIndexRequestGeneration.current += 1
      fileRequestGeneration.current += 1
      contentSearchRequestGeneration.current += 1
      void store.callProject('cancelContentSearch').catch(() => undefined)
    }
  }, [fileWorkspaceApi, performOpenFile, performRefresh, projectAccessId, projectId, store])

  useEffect(() => {
    if (!workspaceRestored || projectAccessId === null || fileWorkspaceApi === undefined) return
    const timer = window.setTimeout(() => {
      const previewFile = openFiles.find(tab => !tab.pinned)?.relativePath
      void fileWorkspaceApi
        .save({
          projectId: projectAccessId,
          pinnedFiles: openFiles
            .filter(tab => tab.pinned)
            .map(tab => tab.relativePath)
            .slice(0, DESKTOP_FILE_WORKSPACE_LIMITS.maxPinnedFiles),
          ...(previewFile === undefined ? {} : { previewFile }),
          ...(selectedFile === null ? {} : { activeFile: selectedFile.relativePath }),
          ...(selectedLine === null ? {} : { activeLine: selectedLine }),
          expandedDirectories: [
            '',
            ...[...expandedDirectories]
              .filter(path => path !== '')
              .slice(-(DESKTOP_FILE_WORKSPACE_LIMITS.maxExpandedDirectories - 1)),
          ],
          recentFiles: recentFiles.slice(0, DESKTOP_FILE_WORKSPACE_LIMITS.maxRecentFiles),
          treeScrollLeft,
          treeScrollTop,
        })
        .catch((caught: unknown) => {
          if (projectAccessIdRef.current === projectAccessId) {
            setError(`无法保存文件工作区：${message(caught)}`)
          }
        })
    }, 300)
    return () => {
      window.clearTimeout(timer)
    }
  }, [
    expandedDirectories,
    fileWorkspaceApi,
    openFiles,
    projectAccessId,
    recentFiles,
    selectedFile,
    selectedLine,
    treeScrollLeft,
    treeScrollTop,
    workspaceRestored,
  ])

  const updateFileDraft = useCallback(
    (content: string, path = activePathRef.current) => {
      const targetFile = path === null ? undefined : documentsRef.current[path]?.selectedFile
      if (targetFile?.kind !== 'text') return
      updateDocument('fileDraft', content, path)
      updateDocument('fileConflict', null, path)
      setOpenFiles(current => {
        const pinnedCount = current.filter(tab => tab.pinned).length
        if (pinnedCount >= DESKTOP_FILE_WORKSPACE_LIMITS.maxPinnedFiles) return current
        return current.map(tab =>
          tab.relativePath === targetFile.relativePath && !tab.pinned
            ? { ...tab, pinned: true }
            : tab,
        )
      })
    },
    [selectedFile],
  )

  const saveFile = useCallback(
    async (overwriteRevision?: string, path = activePathRef.current): Promise<boolean> => {
      const document = path === null ? undefined : documentsRef.current[path]
      const targetFile = document?.selectedFile
      const draft = document?.fileDraft ?? null
      const saving = document?.fileSaving ?? false
      const dirty = targetFile?.kind === 'text' && draft !== targetFile.content
      if (targetFile?.kind !== 'text' || draft === null || saving) return false
      if (!dirty && overwriteRevision === undefined) return true
      const requestGeneration = generation.current
      const requestProjectId = projectId
      const requestPath = targetFile.relativePath
      updateDocument('fileSaving', true, requestPath)
      setError(null)
      try {
        const result = parseProjectFileWriteResult(
          await store.callProject('writeFile', {
            relativePath: requestPath,
            content: draft,
            expectedRevision: targetFile.revision,
            ...(overwriteRevision === undefined ? {} : { overwriteRevision }),
          }),
        )
        if (
          generation.current !== requestGeneration ||
          projectIdRef.current !== requestProjectId ||
          targetFile.relativePath !== requestPath
        )
          return false
        if (result.status === 'conflict') {
          updateDocument('fileConflict', result, requestPath)
          return false
        }
        updateDocument('selectedFile', result.file, requestPath)
        updateDocument('fileDraft', result.file.content, requestPath)
        updateDocument('fileConflict', null, requestPath)
        return true
      } catch (caught) {
        if (generation.current === requestGeneration && projectIdRef.current === requestProjectId)
          setError(message(caught))
        return false
      } finally {
        if (generation.current === requestGeneration && projectIdRef.current === requestProjectId)
          updateDocument('fileSaving', false, requestPath)
      }
    },
    [fileDirty, fileDraft, fileSaving, projectId, selectedFile, store],
  )

  const reloadSelectedFile = useCallback(
    async (path = activePathRef.current) => {
      const targetFile = path === null ? undefined : documentsRef.current[path]?.selectedFile
      if (targetFile?.kind !== 'text') return
      const requestProjectId = projectId
      const requestPath = targetFile.relativePath
      const ownsDocument = () =>
        projectIdRef.current === requestProjectId &&
        documentsRef.current[requestPath]?.selectedFile === targetFile
      updateDocument('fileSaving', true, requestPath)
      setError(null)
      try {
        const file = parseProjectFile(
          await store.callProject('readFile', {
            relativePath: requestPath,
            trackRecent: true,
          }),
        )
        if (!ownsDocument()) return
        updateDocument('selectedFile', file, requestPath)
        updateDocument('fileDraft', file.kind === 'text' ? file.content : null, requestPath)
        updateDocument('fileConflict', null, requestPath)
      } catch (caught) {
        if (ownsDocument()) setError(message(caught))
      } finally {
        if (ownsDocument()) updateDocument('fileSaving', false, requestPath)
      }
    },
    [projectId, selectedFile, store],
  )

  const discardFileChanges = useCallback(
    (path = activePathRef.current) => {
      const file = path === null ? undefined : documentsRef.current[path]?.selectedFile
      updateDocument('fileDraft', file?.kind === 'text' ? file.content : null, path)
      updateDocument('fileConflict', null, path)
      setError(null)
    },
    [updateDocument],
  )
  const dismissFileConflict = useCallback(
    (path = activePathRef.current) => {
      updateDocument('fileConflict', null, path)
    },
    [updateDocument],
  )
  const updateOutline = useCallback(
    (items: readonly OutlineItem[], path = activePathRef.current) => {
      updateDocument('outlineItems', items, path)
    },
    [updateDocument],
  )
  const updateActiveFileLine = useCallback(
    (line: number, path = activePathRef.current) => {
      if (!Number.isSafeInteger(line) || line <= 0) return
      updateDocument('selectedLine', line, path)
    },
    [updateDocument],
  )
  const revealOutlineLine = useCallback(
    (line: number) => {
      if (!Number.isSafeInteger(line) || line <= 0) return
      setSelectedLine(current => (current === line ? null : line))
      if (selectedLine === line) {
        requestAnimationFrame(() => {
          setSelectedLine(line)
        })
      }
    },
    [selectedLine],
  )

  const resolveUnsavedChanges = useCallback(
    async (choice: 'save' | 'discard' | 'cancel') => {
      const action = pendingUnsavedAction.current
      if (action === null) return
      if (choice === 'cancel') {
        pendingUnsavedAction.current = null
        setUnsavedChangesReason(null)
        await action.cancel?.()
        return
      }
      // 文件保存按顺序执行，冲突时停止并保留其余文档。
      /* oxlint-disable no-await-in-loop */
      for (const path of action.paths ?? []) {
        if (choice === 'save') {
          if (!(await saveFile(undefined, path))) return
        } else discardFileChanges(path)
      }
      /* oxlint-enable no-await-in-loop */
      pendingUnsavedAction.current = null
      setUnsavedChangesReason(null)
      await action.run()
    },
    [discardFileChanges, saveFile],
  )

  const performWorkspaceRefresh = useCallback(async () => {
    const rememberedPath = selectedFile?.relativePath
    const activeLine = selectedLine
    const expanded = [...expandedDirectories]
    await performRefresh()
    await Promise.all(expanded.filter(path => path !== '').map(path => revealDirectory(path)))
    if (rememberedPath !== undefined) {
      const opened = await performOpenFile(rememberedPath, activeLine ?? undefined, {
        preserveTabs: true,
        skipHistory: true,
        reload: true,
      })
      if (!opened)
        setOpenFiles(current => current.filter(tab => tab.relativePath !== rememberedPath))
    }
  }, [
    expandedDirectories,
    performOpenFile,
    performRefresh,
    revealDirectory,
    selectedFile?.relativePath,
    selectedLine,
  ])

  const refresh = useCallback(async () => {
    if (!fileDirty) {
      await performWorkspaceRefresh()
      return
    }
    queueUnsavedAction({
      kind: 'navigation',
      reason: '刷新文件工作台',
      run: performWorkspaceRefresh,
    })
  }, [fileDirty, performWorkspaceRefresh, queueUnsavedAction])

  const openFile = useCallback(
    async (relativePath: string, line?: number) => {
      if (selectedFile?.relativePath === relativePath) {
        setSelectedLine(
          Number.isSafeInteger(line) && Number(line) > 0 ? Number(line) : selectedLine,
        )
        store.setView('files')
        return
      }
      await performOpenFile(relativePath, line)
    },
    [
      fileDirty,
      performOpenFile,
      queueUnsavedAction,
      selectedFile?.relativePath,
      selectedLine,
      store,
    ],
  )

  const openFileFromConversation = useCallback(
    async (relativePath: string, line: number | undefined): Promise<boolean> => {
      const intent = store.captureIslandCollaborationIntent()
      if (intent === null) return false
      const run = async (): Promise<boolean> => {
        let opened = true
        if (selectedFile?.relativePath === relativePath) {
          setSelectedLine(
            Number.isSafeInteger(line) && Number(line) > 0 ? Number(line) : selectedLine,
          )
        } else {
          opened = await performOpenFile(relativePath, line, { activateView: false })
        }
        return opened && store.presentIslandCollaboration(intent, 'files', 'main')
      }
      if (!fileDirty || selectedFile?.relativePath === relativePath) return run()
      queueUnsavedAction({
        kind: 'navigation',
        reason: `打开 ${relativePath}`,
        run,
      })
      return false
    },
    [
      fileDirty,
      performOpenFile,
      queueUnsavedAction,
      selectedFile?.relativePath,
      selectedLine,
      store,
    ],
  )

  const openPinnedFile = useCallback(
    async (relativePath: string) => {
      if (selectedFile?.relativePath === relativePath) {
        pinFile(relativePath)
        store.setView('files')
        return
      }
      const run = () => performOpenFile(relativePath, undefined, { pin: true })
      if (fileDirty) {
        queueUnsavedAction({ kind: 'navigation', reason: `打开并固定 ${relativePath}`, run })
        return
      }
      await run()
    },
    [fileDirty, performOpenFile, pinFile, queueUnsavedAction, selectedFile?.relativePath, store],
  )

  const selectFileTab = useCallback(
    (relativePath: string) => {
      if (!openFilesRef.current.some(tab => tab.relativePath === relativePath)) return
      void openFile(relativePath)
    },
    [openFile],
  )

  const performCloseFileTab = useCallback(
    async (relativePath: string) => {
      const current = openFilesRef.current
      const index = current.findIndex(tab => tab.relativePath === relativePath)
      if (index < 0) return
      const remaining = current.filter(tab => tab.relativePath !== relativePath)
      setOpenFiles(remaining)
      setDocuments(docs => {
        const next = { ...docs }
        delete next[relativePath]
        return next
      })
      if (selectedFile?.relativePath !== relativePath) return
      setSelectedFile(null)
      setFileDraft(null)
      setFileConflict(null)
      setOutlineItems([])
      setSelectedLine(null)
      const recentPath = recentFiles.find(
        path => path !== relativePath && remaining.some(tab => tab.relativePath === path),
      )
      const replacement =
        recentPath === undefined
          ? remaining[Math.min(index, remaining.length - 1)]
          : remaining.find(tab => tab.relativePath === recentPath)
      if (replacement === undefined) {
        return
      }
      const opened = await performOpenFile(replacement.relativePath, undefined, {
        preserveTabs: true,
        skipHistory: true,
      })
      if (!opened)
        setOpenFiles(currentTabs =>
          currentTabs.filter(tab => tab.relativePath !== replacement.relativePath),
        )
    },
    [performOpenFile, recentFiles, selectedFile?.relativePath],
  )

  const closeFileTab = useCallback(
    (relativePath: string) => {
      const doc = documentsRef.current[relativePath]
      if (doc?.selectedFile.kind === 'text' && doc.fileDraft !== doc.selectedFile.content) {
        queueUnsavedAction({
          kind: 'navigation',
          paths: [relativePath],
          reason: `关闭 ${relativePath}`,
          run: () => performCloseFileTab(relativePath),
        })
        return
      }
      void performCloseFileTab(relativePath)
    },
    [fileDirty, performCloseFileTab, queueUnsavedAction, selectedFile?.relativePath],
  )

  const navigateFileHistory = useCallback(
    (direction: -1 | 1) => {
      const targetIndex = fileHistoryIndexRef.current + direction
      const target = fileHistoryRef.current[targetIndex]
      if (target === undefined) return
      const run = () => performOpenFile(target, undefined, { historyIndex: targetIndex })
      if (fileDirty && selectedFile?.relativePath !== target) {
        queueUnsavedAction({ kind: 'navigation', reason: `返回 ${target}`, run })
        return
      }
      void run()
    },
    [fileDirty, performOpenFile, queueUnsavedAction, selectedFile?.relativePath],
  )

  const selectProject = useCallback(
    (nextProjectId: string | null) => {
      if (nextProjectId === snapshot.selectedProjectId) return
      queueUnsavedAction({
        kind: 'navigation',
        reason: '切换项目',
        run: () => {
          store.selectProject(nextProjectId)
        },
      })
    },
    [queueUnsavedAction, snapshot.selectedProjectId, store],
  )

  const navigateProjectTab = useCallback(
    (targetProjectId: string, action: () => void) => {
      const run = () => {
        if (targetProjectId !== projectId) store.selectProject(targetProjectId)
        action()
      }
      if (targetProjectId === projectId || !hasDirtyDocuments) {
        run()
        return
      }
      queueUnsavedAction({ kind: 'navigation', reason: '切换到其他项目的工作标签', run })
    },
    [hasDirtyDocuments, fileDirty, projectId, queueUnsavedAction, store],
  )

  const selectSession = useCallback(
    (sessionId: string, showAllProjects = false) => {
      const session = snapshot.sessions.find(item => item.sessionId === sessionId)
      const targetProjectId =
        session?.cwd === undefined
          ? null
          : (snapshot.projects.find(project => project.cwd === session.cwd)?.id ?? null)
      const action = () => {
        if (showAllProjects) store.selectProject(null)
        store.selectSession(sessionId)
      }
      if (!hasDirtyDocuments || targetProjectId === projectId) {
        action()
        return
      }
      queueUnsavedAction({ kind: 'navigation', reason: '切换到其他项目的会话', run: action })
    },
    [
      hasDirtyDocuments,
      fileDirty,
      projectId,
      queueUnsavedAction,
      snapshot.projects,
      snapshot.sessions,
      store,
    ],
  )

  const sessionProjectId = useCallback(
    (sessionId: string): string | null => {
      const session = snapshot.sessions.find(item => item.sessionId === sessionId)
      if (session?.cwd === undefined) return null
      return snapshot.projects.find(project => project.cwd === session.cwd)?.id ?? null
    },
    [snapshot.projects, snapshot.sessions],
  )

  const selectSessionTab = useCallback(
    (sessionId: string) => {
      const action = () => {
        store.selectSessionTab(sessionId)
      }
      if (!hasDirtyDocuments || sessionProjectId(sessionId) === projectId) {
        action()
        return
      }
      queueUnsavedAction({
        kind: 'navigation',
        reason: '切换到其他项目的会话标签',
        run: action,
      })
    },
    [
      hasDirtyDocuments,
      fileDirty,
      projectId,
      queueUnsavedAction,
      sessionProjectId,
      snapshot.selectedSessionId,
      store,
    ],
  )

  const closeSessionTab = useCallback(
    (sessionId: string) => {
      const index = snapshot.openedSessionIds.indexOf(sessionId)
      if (index < 0) return
      if (
        snapshot.selectedSessionId !== sessionId ||
        snapshot.activeView === 'files' ||
        snapshot.activeView === 'terminal'
      ) {
        store.closeSessionTab(sessionId)
        return
      }
      const remaining = snapshot.openedSessionIds.filter(id => id !== sessionId)
      const adjacentSessionId = remaining[Math.min(index, remaining.length - 1)]
      const nextProjectId =
        adjacentSessionId === undefined
          ? snapshot.selectedProjectId
          : sessionProjectId(adjacentSessionId)
      const action = () => {
        store.closeSessionTab(sessionId)
      }
      if (!hasDirtyDocuments || nextProjectId === projectId) {
        action()
        return
      }
      queueUnsavedAction({
        kind: 'navigation',
        reason: '关闭会话标签并切换到其他项目',
        run: action,
      })
    },
    [
      hasDirtyDocuments,
      fileDirty,
      projectId,
      queueUnsavedAction,
      sessionProjectId,
      snapshot.openedSessionIds,
      snapshot.selectedProjectId,
      snapshot.selectedSessionId,
      snapshot.activeView,
      store,
    ],
  )

  const createSession = useCallback(
    (targetProjectId?: string, agentPreset?: string) => {
      if (!hasDirtyDocuments || targetProjectId === undefined || targetProjectId === projectId) {
        void store.createSession(targetProjectId, agentPreset)
        return
      }
      queueUnsavedAction({
        kind: 'navigation',
        reason: '在其他项目中新建会话',
        run: () => store.createSession(targetProjectId, agentPreset),
      })
    },
    [hasDirtyDocuments, fileDirty, projectId, queueUnsavedAction, store],
  )

  const createWorkspace = useCallback(() => {
    const run = async () => {
      setError(null)
      try {
        await store.createWorkspace()
      } catch (caught) {
        setError(message(caught))
      }
    }
    queueUnsavedAction({
      kind: 'navigation',
      reason: '创建并切换到新项目',
      run,
    })
  }, [queueUnsavedAction, store])

  useEffect(() => {
    const lifecycle = window.dshDesktop?.lifecycle
    if (lifecycle === undefined) return
    const dirty = Object.values(documents).some(
      doc => doc.selectedFile.kind === 'text' && doc.fileDraft !== doc.selectedFile.content,
    )
    void lifecycle.setDocumentEdited(dirty).catch((caught: unknown) => {
      setError(message(caught))
    })
    return lifecycle.onCloseRequested(() => {
      if (!dirty) {
        void lifecycle.resolveClose('proceed')
        return
      }
      queueUnsavedAction({
        kind: 'close',
        reason: '关闭 MyDSH',
        run: () => lifecycle.resolveClose('proceed'),
        cancel: () => lifecycle.resolveClose('cancel'),
      })
    })
  }, [documents, fileDirty, queueUnsavedAction])

  const buildFileIndex = useCallback(
    async (force = false) => {
      const requestGeneration = ++fileIndexRequestGeneration.current
      const requestProjectId = projectId
      setFileIndexStatus(current => ({
        phase: 'building',
        fileCount: current.fileCount,
      }))
      try {
        const status = parseFileIndexStatus(await store.callProject('buildFileIndex', { force }))
        if (
          fileIndexRequestGeneration.current === requestGeneration &&
          projectIdRef.current === requestProjectId
        )
          setFileIndexStatus(status)
      } catch (caught) {
        if (
          fileIndexRequestGeneration.current !== requestGeneration ||
          projectIdRef.current !== requestProjectId
        )
          return
        setFileIndexStatus({
          phase: 'error',
          fileCount: 0,
          message: message(caught),
        })
      }
    },
    [projectId, store],
  )

  const queryFiles = useCallback(
    async (query: string) => {
      const requestProjectId = projectId
      const result = parseFileIndexQueryResult(await store.callProject('queryFiles', { query }))
      if (projectIdRef.current !== requestProjectId) throw new Error('项目已切换，请重新搜索文件')
      return result
    },
    [projectId, store],
  )

  const searchContent = useCallback(
    async (query: string, caseSensitive: boolean) => {
      const requestGeneration = ++contentSearchRequestGeneration.current
      const requestProjectId = projectId
      const result = parseContentSearchResult(
        await store.callProject('searchContent', {
          query,
          caseSensitive,
        }),
      )
      if (
        contentSearchRequestGeneration.current !== requestGeneration ||
        projectIdRef.current !== requestProjectId
      )
        throw new Error('项目内容搜索已取消')
      return result
    },
    [projectId, store],
  )

  const cancelContentSearch = useCallback(() => {
    contentSearchRequestGeneration.current += 1
    void store.callProject('cancelContentSearch').catch(() => undefined)
  }, [store])

  const closeProjectTabs = useCallback(
    (sessionIds: readonly string[], closeOthers: () => void) => {
      queueUnsavedAction({
        kind: 'navigation',
        reason: '关闭工作区的全部标签',
        run: () => {
          fileRequestGeneration.current += 1
          setOpenFiles([])
          setDocuments({})
          setSelectedFile(null)
          closeOthers()
          for (const id of sessionIds.filter(
            candidate => candidate !== store.getSnapshot().selectedSessionId,
          ))
            store.closeSessionTab(id)
          const active = store.getSnapshot().selectedSessionId
          if (active && sessionIds.includes(active)) store.closeSessionTab(active, true)
        },
      })
    },
    [queueUnsavedAction, setSelectedFile, store],
  )

  const value = useMemo<ProjectWorkspaceState>(
    () => ({
      documents,
      closeProjectTabs,
      directories,
      expandedDirectories,
      selectedFile,
      fileDraft,
      fileDirty,
      fileSaving,
      fileConflict,
      outlineItems,
      unsavedChangesReason,
      unsavedChangesPaths: pendingUnsavedAction.current?.paths ?? [],
      selectedLine,
      openFiles,
      canNavigateBack: fileHistoryIndex > 0,
      canNavigateForward: fileHistoryIndex >= 0 && fileHistoryIndex < fileHistory.length - 1,
      treeScrollLeft,
      treeScrollTop,
      fileIndexStatus,
      loading,
      error,
      clearError,
      refresh,
      toggleDirectory,
      openFile,
      openFileFromConversation,
      openPinnedFile,
      selectFileTab,
      pinFile,
      closeFileTab,
      navigateFileHistory,
      revealDirectory,
      updateTreeScroll,
      updateFileDraft,
      saveFile,
      reloadSelectedFile,
      discardFileChanges,
      dismissFileConflict,
      updateOutline,
      updateActiveFileLine,
      revealOutlineLine,
      resolveUnsavedChanges,
      selectProject,
      navigateProjectTab,
      selectSession,
      selectSessionTab,
      closeSessionTab,
      createSession,
      createWorkspace,
      buildFileIndex,
      queryFiles,
      searchContent,
      cancelContentSearch,
    }),
    [
      documents,
      closeProjectTabs,
      directories,
      expandedDirectories,
      selectedFile,
      fileDraft,
      fileDirty,
      fileSaving,
      fileConflict,
      outlineItems,
      unsavedChangesReason,
      selectedLine,
      openFiles,
      fileHistory,
      fileHistoryIndex,
      treeScrollLeft,
      treeScrollTop,
      fileIndexStatus,
      loading,
      error,
      clearError,
      refresh,
      toggleDirectory,
      openFile,
      openFileFromConversation,
      openPinnedFile,
      selectFileTab,
      pinFile,
      closeFileTab,
      navigateFileHistory,
      revealDirectory,
      updateTreeScroll,
      updateFileDraft,
      saveFile,
      reloadSelectedFile,
      discardFileChanges,
      dismissFileConflict,
      updateOutline,
      updateActiveFileLine,
      revealOutlineLine,
      resolveUnsavedChanges,
      selectProject,
      navigateProjectTab,
      selectSession,
      selectSessionTab,
      closeSessionTab,
      createSession,
      createWorkspace,
      buildFileIndex,
      queryFiles,
      searchContent,
      cancelContentSearch,
    ],
  )
  return (
    <ProjectWorkspaceContext.Provider value={value}>{children}</ProjectWorkspaceContext.Provider>
  )
}

export function useProjectWorkspace(): ProjectWorkspaceState {
  const value = useContext(ProjectWorkspaceContext)
  if (value === null) throw new Error('ProjectWorkspaceProvider 尚未挂载')
  return value
}

/** 两个文件视图读取各自文档，动作继续由同一个文件工作区拥有。 */
export function FileDocumentScope({ path, children }: { path: string; children: ReactNode }) {
  const workspace = useProjectWorkspace()
  const doc = workspace.documents[path]
  if (!doc) return null
  return (
    <ProjectWorkspaceContext.Provider
      value={{
        ...workspace,
        ...doc,
        updateFileDraft: content => {
          workspace.updateFileDraft(content, path)
        },
        saveFile: revision => workspace.saveFile(revision, path),
        reloadSelectedFile: () => workspace.reloadSelectedFile(path),
        discardFileChanges: () => {
          workspace.discardFileChanges(path)
        },
        dismissFileConflict: () => {
          workspace.dismissFileConflict(path)
        },
        updateOutline: items => {
          workspace.updateOutline(items, path)
        },
        updateActiveFileLine: line => {
          workspace.updateActiveFileLine(line, path)
        },
        fileDirty: doc.selectedFile.kind === 'text' && doc.fileDraft !== doc.selectedFile.content,
      }}
    >
      {children}
    </ProjectWorkspaceContext.Provider>
  )
}
