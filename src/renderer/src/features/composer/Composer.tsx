import { useWorkspaceTabs } from '../workspace-tabs/WorkspaceTabsProvider.tsx'
import { PluginActions } from '../../plugins/react.tsx'
import { ArrowUp, FileText, LoaderCircle, Paperclip, Square, Terminal, X } from 'lucide-react'
import {
  DESKTOP_IMAGE_ATTACHMENT_MAX_BYTES,
  DESKTOP_IMAGE_ATTACHMENT_MAX_ITEMS,
  DESKTOP_IMAGE_ATTACHMENT_MAX_TOTAL_BYTES,
  type DesktopDroppedImage,
} from '../../../../shared/image-attachments.ts'
import {
  activeFileReferenceToken,
  formatDesktopFileMention,
  type DesktopFileReferenceCandidate,
} from '../../../../shared/file-references.ts'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { useWorkspaceSnapshot, useWorkspaceStore } from '../../hooks/useWorkspace.ts'
import { AppAlert } from '../../shared/ui/AppAlert.tsx'
import { ElasticPress } from '../../shared/ui/ElasticPress.tsx'
import {
  COMMAND_PALETTE_LISTBOX_ID,
  FILE_REFERENCE_LISTBOX_ID,
  CommandPalette,
  commandPaletteOptionId,
  type CommandPaletteItem,
} from './CommandPalette.tsx'
import {
  filterCommandPaletteItems,
  getCommandPaletteKeyAction,
  parseLeadingSlashCommand,
} from './command-palette.ts'
import { ModeSelector, ModelSelector, PermissionSelector } from './ComposerControls.tsx'
import { ComposerStatus } from './ComposerStatus.tsx'
import {
  parseHubContext,
  parseHubContextBreakdown,
  parseHubStats,
  parseHubTokenUsage,
} from '../../domain/session-hub.ts'

function attachmentSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${String(Math.max(1, Math.round(bytes / 1024)))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function containsFiles(event: DragEvent): boolean {
  return event.dataTransfer !== null && Array.from(event.dataTransfer.types).includes('Files')
}

function isSupportedImageFile(file: File): boolean {
  return /\.(?:gif|jpe?g|png|webp)$/iu.test(file.name)
}

async function imagePayloads(files: readonly File[]): Promise<readonly DesktopDroppedImage[]> {
  if (files.length === 0 || files.length > DESKTOP_IMAGE_ATTACHMENT_MAX_ITEMS) {
    throw new Error(`一次最多只能添加 ${String(DESKTOP_IMAGE_ATTACHMENT_MAX_ITEMS)} 张图片`)
  }
  let totalBytes = 0
  for (const file of files) {
    if (!/\.(?:gif|jpe?g|png|webp)$/iu.test(file.name)) {
      throw new Error('目前只支持 PNG、JPEG、WebP 或 GIF 图片附件')
    }
    if (file.size === 0 || file.size > DESKTOP_IMAGE_ATTACHMENT_MAX_BYTES) {
      throw new Error('图片必须是 16 MB 以内的非空文件')
    }
    totalBytes += file.size
    if (totalBytes > DESKTOP_IMAGE_ATTACHMENT_MAX_TOTAL_BYTES) {
      throw new Error('每条消息的图片总大小不能超过 32 MB')
    }
  }
  return Promise.all(
    files.map(async file => ({
      name: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    })),
  )
}

const commandDescriptions: Readonly<Record<string, string>> = {
  compact: '压缩以上对话内容',
  export: '导出当前会话',
  feedback: '发送关于当前会话的反馈',
  goal: '设置或查看长期任务目标',
  permission: '切换权限预设',
  plan: '进入或退出计划模式',
  model: '选择当前会话的模型',
}

/**
 * 输入卡片与其下方的会话读数条。
 *
 * 外壳按输入区容器的实际宽度启用读数条；没有读数时由读数条自身整条不渲染。
 */
export function Composer({ showReadings = true }: { readonly showReadings?: boolean }) {
  const store = useWorkspaceStore()
  const snapshot = useWorkspaceSnapshot()
  const [stoppingSessionId, setStoppingSessionId] = useState<string | null>(null)
  const [composerAnchor, setComposerAnchor] = useState<HTMLElement | null>(null)
  const [caret, setCaret] = useState(0)
  const [paletteDismissed, setPaletteDismissed] = useState(false)
  const [paletteFromButton, setPaletteFromButton] = useState(false)
  const [picker, setPicker] = useState<{
    category: 'home' | 'command' | 'skill'
    query: string
  } | null>(null)
  const [activeCommandIndex, setActiveCommandIndex] = useState(0)
  const [fileReferenceDismissed, setFileReferenceDismissed] = useState(false)
  const [activeFileReferenceIndex, setActiveFileReferenceIndex] = useState(0)
  const [fileReferenceState, setFileReferenceState] = useState<{
    readonly status: 'idle' | 'loading' | 'ready' | 'error'
    readonly candidates: readonly DesktopFileReferenceCandidate[]
    readonly error: string | null
  }>({ status: 'idle', candidates: [], error: null })
  const [draggingFiles, setDraggingFiles] = useState(false)
  const [dropError, setDropError] = useState<string | null>(null)
  const dismissError = useCallback(() => {
    setDropError(null)
    store.clearError(snapshot.error)
  }, [snapshot.error, store])
  const textarea = useRef<HTMLTextAreaElement>(null)
  const pickerButtonRef = useRef<HTMLButtonElement>(null)
  const dragDepth = useRef(0)
  const clearPaletteOrigin = useCallback(() => setPaletteFromButton(false), [])
  const session = snapshot.sessions.find(item => item.sessionId === snapshot.selectedSessionId)
  const sessionId = session?.sessionId
  const workTabs = useWorkspaceTabs()
  const composerFocused =
    sessionId !== undefined && workTabs?.split?.includes(sessionId)
      ? workTabs.focusedTabId === sessionId
      : store.getSnapshot().selectedSessionId === (sessionId ?? null) &&
        ['conversation', 'trajectory'].includes(store.getSnapshot().activeView)
  const hubValues = useMemo(
    () => session?.projections?.values ?? {},
    [session?.projections?.values],
  )
  const hubUsage = useMemo(() => parseHubTokenUsage(hubValues.tokenUsage), [hubValues])
  const hubContext = useMemo(() => parseHubContext(hubValues.contextPressure), [hubValues])
  const hubStats = useMemo(() => parseHubStats(hubValues.sessionStats), [hubValues])
  const plan = hubValues.plan as { active?: boolean; pending?: boolean } | undefined
  const planActive = plan?.pending ? !plan.active : plan?.active === true
  const newSessionProjectId = snapshot.newSessionProjectId ?? null
  const newSessionDraftActive = session === undefined && newSessionProjectId !== null
  const composerReady = session !== undefined || newSessionDraftActive
  const text =
    sessionId === undefined
      ? newSessionDraftActive
        ? (snapshot.newSessionDraft ?? '')
        : ''
      : (snapshot.sessionDrafts?.[sessionId] ?? '')
  const attachments =
    sessionId === undefined ? [] : (snapshot.sessionAttachments?.[sessionId] ?? [])
  const fileAttachments = sessionId === undefined ? [] : (snapshot.sessionFiles?.[sessionId] ?? [])
  const filesPending = fileAttachments.some(file => file.status !== 'ready')
  const choosingAttachments = snapshot.choosingAttachments ?? false
  const hostReady = snapshot.hostStatus?.kind === 'ready'
  const awaitingResponse =
    session !== undefined && snapshot.awaitingResponseSessionIds.includes(session.sessionId)
  const replyActive = session?.running === true || awaitingResponse
  const commandExecution = snapshot.sessionCommandExecution ?? null
  const commandActive =
    commandExecution?.phase === 'submitting' || commandExecution?.phase === 'running'
  const directoryState = snapshot.sessionCommandDirectory ?? {
    status: 'idle' as const,
    value: null,
    error: null,
    commandError: null,
    skillError: null,
  }
  const slashToken = parseLeadingSlashCommand(text, Math.min(caret, text.length))
  const paletteOpen =
    composerFocused &&
    session !== undefined &&
    (slashToken !== null || picker !== null) &&
    !paletteDismissed
  const paletteQuery = picker?.query ?? slashToken?.query ?? ''
  const paletteCategory = picker?.category ?? 'home'
  const fileReferenceToken = activeFileReferenceToken(text, Math.min(caret, text.length))
  const fileReferenceOpen =
    composerFocused &&
    session !== undefined &&
    fileReferenceToken !== null &&
    slashToken === null &&
    !paletteOpen &&
    !fileReferenceDismissed
  const canAttach = session !== undefined && hostReady && !choosingAttachments

  const commandItems = useMemo<CommandPaletteItem[]>(() => {
    const directory = directoryState.value
    if (directory === null) return []
    const duplicateNames = new Set(
      directory.commands
        .filter(command => directory.skills.some(skill => skill.name === command.name))
        .map(command => command.name),
    )
    const commands = directory.commands.map(command => ({
      id: `command:${command.name}`,
      label: command.name,
      description: duplicateNames.has(command.name)
        ? '与 Skill 同名，暂不能从面板执行'
        : (commandDescriptions[command.name] ??
          (command.input === undefined
            ? command.description
            : `${command.description} · 参数：${command.input.hint}`)),
      group: '命令',
      keywords: [
        command.name,
        commandDescriptions[command.name] ?? '',
        command.description,
        command.input?.hint ?? '',
      ],
      disabled: duplicateNames.has(command.name),
    }))
    const skills = directory.skills.map(skill => ({
      id: `skill:${skill.name}`,
      label: `/${skill.name}`,
      description: duplicateNames.has(skill.name)
        ? '与命令同名，暂不能从面板执行'
        : skill.description,
      group: 'Skill',
      keywords: [skill.name, skill.description, skill.whenToUse ?? ''],
      disabled: duplicateNames.has(skill.name),
    }))
    const degraded: CommandPaletteItem[] = [
      ...(directoryState.commandError === null
        ? []
        : [
            {
              id: 'command:unavailable',
              label: '命令暂不可用',
              description: directoryState.commandError,
              group: '命令',
              disabled: true,
            },
          ]),
      ...(directoryState.skillError === null
        ? []
        : [
            {
              id: 'skill:unavailable',
              label: 'Skill 暂不可用',
              description: directoryState.skillError,
              group: 'Skill',
              disabled: true,
            },
          ]),
    ]
    return [...commands, ...skills, ...degraded]
  }, [directoryState])
  const filteredCommandItems = useMemo<CommandPaletteItem[]>(() => {
    if (paletteCategory === 'home' && paletteQuery.trim() === '')
      return [
        {
          id: 'category:skill',
          label: 'Skill',
          description: '选择适合当前任务的技能',
          group: '选择类型',
        },
        {
          id: 'category:command',
          label: '命令',
          description: '压缩上下文、会话操作及其他命令',
          group: '选择类型',
        },
      ]
    return filterCommandPaletteItems(
      commandItems.filter(
        item => paletteCategory === 'home' || item.id.startsWith(`${paletteCategory}:`),
      ),
      paletteQuery,
    )
  }, [commandItems, paletteCategory, paletteQuery])
  const listboxVisible =
    paletteOpen && directoryState.status === 'ready' && filteredCommandItems.length > 0
  const navigableCommandItems = listboxVisible ? filteredCommandItems : []
  const activeCommand = listboxVisible ? filteredCommandItems[activeCommandIndex] : undefined
  const fileReferenceItems = useMemo<CommandPaletteItem[]>(
    () =>
      fileReferenceState.candidates.flatMap((candidate, index) => {
        const mention = formatDesktopFileMention(candidate, fileReferenceToken?.quoted === true)
        if (mention === null) return []
        const name = candidate.path.split('/').findLast(part => part !== '') ?? candidate.path
        return [
          {
            id: `file-reference:${String(index)}`,
            label: `${candidate.kind === 'directory' ? '文件夹' : '文件'} · ${name}${candidate.kind === 'directory' ? '/' : ''}`,
            description: candidate.path,
            group: '文件与文件夹',
          },
        ]
      }),
    [fileReferenceState.candidates, fileReferenceToken?.quoted],
  )
  const fileReferenceListVisible =
    fileReferenceOpen && fileReferenceState.status === 'ready' && fileReferenceItems.length > 0
  const activeFileReference = fileReferenceListVisible
    ? fileReferenceItems[activeFileReferenceIndex]
    : undefined

  useEffect(() => {
    if (session === undefined || snapshot.hostStatus?.kind !== 'ready' || !composerFocused) return
    void store.loadSessionModels(false, session.sessionId)
    void store.loadPermissionCatalog()
  }, [session?.sessionId, snapshot.hostStatus?.kind, store, composerFocused])

  useEffect(() => {
    setPaletteDismissed(false)
    setPicker(null)
    setActiveCommandIndex(0)
    setFileReferenceDismissed(false)
    setActiveFileReferenceIndex(0)
    setFileReferenceState({ status: 'idle', candidates: [], error: null })
    setDraggingFiles(false)
    setDropError(null)
    dragDepth.current = 0
  }, [newSessionProjectId, sessionId])

  useEffect(() => {
    if (newSessionDraftActive) textarea.current?.focus()
  }, [newSessionDraftActive, newSessionProjectId])

  useEffect(() => {
    if (!paletteOpen) return
    if (
      directoryState.status === 'idle' ||
      directoryState.status === 'stale' ||
      directoryState.status === 'error'
    ) {
      void store.loadSessionCommandDirectory(sessionId ?? null, directoryState.status === 'error')
    }
  }, [directoryState.status, paletteOpen, sessionId, store])

  useEffect(() => {
    const firstEnabled = filteredCommandItems.findIndex(item => item.disabled !== true)
    setActiveCommandIndex(firstEnabled === -1 ? 0 : firstEnabled)
  }, [filteredCommandItems])

  useEffect(() => {
    setActiveFileReferenceIndex(0)
  }, [fileReferenceItems])

  useEffect(() => {
    if (!fileReferenceOpen || fileReferenceToken === null || sessionId === undefined) {
      setFileReferenceState(previous =>
        previous.status === 'idle' ? previous : { status: 'idle', candidates: [], error: null },
      )
      return
    }
    let current = true
    const timer = window.setTimeout(() => {
      setFileReferenceState({ status: 'loading', candidates: [], error: null })
      void store.listFileReferences(sessionId, fileReferenceToken.query).then(
        candidates => {
          if (current) setFileReferenceState({ status: 'ready', candidates, error: null })
        },
        error => {
          if (!current) return
          setFileReferenceState({
            status: 'error',
            candidates: [],
            error: error instanceof Error ? error.message : '文件引用暂时不可用',
          })
        },
      )
    }, 100)
    return () => {
      current = false
      window.clearTimeout(timer)
    }
  }, [fileReferenceOpen, fileReferenceToken?.query, sessionId, store])

  useEffect(() => {
    if ((!paletteOpen && !fileReferenceOpen) || composerAnchor === null) return
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return
      if (
        event.target.closest('.composer-picker-button') !== null ||
        (event.target === textarea.current && picker === null) ||
        event.target.closest('[data-composer-palette="true"]') !== null
      )
        return
      setPaletteDismissed(true)
      setPicker(null)
      setFileReferenceDismissed(true)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [composerAnchor, fileReferenceOpen, paletteOpen, picker])

  useLayoutEffect(() => {
    const element = textarea.current
    if (element === null) return
    // 先退出弹性填充再测正文，避免把卡片的剩余留白记成文本高度。
    element.style.flex = 'none'
    element.style.height = '0px'
    element.style.height = `${String(Math.min(180, Math.max(36, element.scrollHeight)))}px`
    element.style.removeProperty('flex')
  }, [attachments.length, fileAttachments.length, snapshot.composerHeight, text])

  const submitMode = (accelerated: boolean): 'queue' | 'steer' => {
    if (session?.running !== true) return 'queue'
    const preferred = snapshot.busyEnter
    if (!accelerated) return preferred
    return preferred === 'queue' ? 'steer' : 'queue'
  }
  const send = async (accelerated = false) => {
    if (!composerReady || commandActive || filesPending) return
    const submittedText = text
    const submittedAttachments = attachments
    const mode = submitMode(accelerated)
    const accepted =
      submittedAttachments.length === 0
        ? await store.submitComposerInput(submittedText, mode, undefined, sessionId)
        : await store.submitComposerInput(submittedText, mode, submittedAttachments, sessionId)
    if (accepted) {
      if (sessionId !== undefined) store.clearSessionDraft(sessionId, submittedText)
      if (sessionId !== undefined && submittedAttachments.length > 0) {
        store.clearSessionAttachments(sessionId, submittedAttachments)
      }
      setCaret(0)
      setPaletteDismissed(false)
      setPicker(null)
    }
  }
  const selectCommand = (item: CommandPaletteItem) => {
    if (sessionId === undefined || item.disabled) return
    if (item.id === 'category:skill' || item.id === 'category:command') {
      setPicker({ category: item.id === 'category:skill' ? 'skill' : 'command', query: '' })
      return
    }
    const separator = item.id.indexOf(':')
    const name = separator === -1 ? '' : item.id.slice(separator + 1)
    if (name === '' || name === 'unavailable') return
    const remainder =
      slashToken === null ? text : text.slice(slashToken.end).replace(/^[\t\n\r ]*/u, '')
    const prefix = `/${name} `
    const next = `${prefix}${remainder}`
    const nextCaret = prefix.length + (slashToken === null ? Math.min(caret, text.length) : 0)
    store.setSessionDraft(sessionId, next)
    setCaret(nextCaret)
    setPaletteDismissed(true)
    setPicker(null)
    queueMicrotask(() => {
      textarea.current?.focus()
      textarea.current?.setSelectionRange(nextCaret, nextCaret)
    })
  }
  const openPicker = () => {
    setPaletteFromButton(true)
    setPicker({ category: 'home', query: '' })
    setPaletteDismissed(false)
    setFileReferenceDismissed(true)
  }
  const togglePicker = () => {
    if (paletteOpen && picker !== null) {
      setPicker(null)
      setPaletteDismissed(true)
      return
    }
    openPicker()
  }
  const selectFileReference = (item: CommandPaletteItem) => {
    if (sessionId === undefined || fileReferenceToken === null || item.disabled) return
    const index = Number(item.id.slice('file-reference:'.length))
    const candidate = fileReferenceState.candidates[index]
    if (candidate === undefined) return
    const mention = formatDesktopFileMention(candidate, fileReferenceToken.quoted)
    if (mention === null) {
      setDropError('这个路径无法用 @file 语法表示')
      return
    }
    const suffix = text.slice(fileReferenceToken.end)
    const separator = candidate.kind === 'file' && !/^\s/u.test(suffix) ? ' ' : ''
    const next = `${text.slice(0, fileReferenceToken.start)}${mention}${separator}${suffix}`
    const nextCaret = fileReferenceToken.start + mention.length + separator.length
    store.setSessionDraft(sessionId, next)
    setCaret(nextCaret)
    setFileReferenceDismissed(candidate.kind === 'file')
    queueMicrotask(() => {
      textarea.current?.focus()
      textarea.current?.setSelectionRange(nextCaret, nextCaret)
    })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    if (
      fileReferenceOpen &&
      fileReferenceToken !== null &&
      !(event.key === 'Enter' && event.shiftKey)
    ) {
      const action = getCommandPaletteKeyAction(
        event.key,
        fileReferenceListVisible ? fileReferenceItems : [],
        activeFileReferenceIndex,
      )
      if (action !== null) {
        event.preventDefault()
        if (action.kind === 'active') setActiveFileReferenceIndex(action.index)
        if (action.kind === 'select') {
          const item = fileReferenceItems[action.index]
          if (item !== undefined) selectFileReference(item)
        }
        if (action.kind === 'dismiss') setFileReferenceDismissed(true)
        return
      }
      if (
        event.key === 'Enter' ||
        event.key === 'Tab' ||
        event.key === 'ArrowDown' ||
        event.key === 'ArrowUp'
      ) {
        event.preventDefault()
        return
      }
    }
    if (paletteOpen && slashToken !== null && !(event.key === 'Enter' && event.shiftKey)) {
      const action = getCommandPaletteKeyAction(
        event.key,
        navigableCommandItems,
        activeCommandIndex,
      )
      if (action !== null) {
        event.preventDefault()
        if (action.kind === 'active') setActiveCommandIndex(action.index)
        if (action.kind === 'select') {
          const item = navigableCommandItems[action.index]
          if (item !== undefined) selectCommand(item)
        }
        if (action.kind === 'dismiss') setPaletteDismissed(true)
        return
      }
      if (
        event.key === 'Enter' ||
        event.key === 'Tab' ||
        event.key === 'ArrowDown' ||
        event.key === 'ArrowUp'
      ) {
        event.preventDefault()
        if (event.key === 'Enter') void send(event.metaKey || event.ctrlKey)
        return
      }
    }
    if (event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    void send(event.metaKey || event.ctrlKey)
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(event.clipboardData.files).filter(file =>
      file.type.startsWith('image/'),
    )
    if (images.length === 0) return
    if (event.clipboardData.getData('text/plain') === '') event.preventDefault()
    if (!canAttach || sessionId === undefined) {
      setDropError('当前不能附加图片，请先选择会话并等待运行核心就绪')
      return
    }
    setDropError(null)
    void imagePayloads(images)
      .then(payload => store.importSessionImages(payload, sessionId))
      .catch(error => {
        setDropError(error instanceof Error ? error.message : '无法粘贴图片')
      })
  }

  useEffect(() => {
    const importFiles = async (files: readonly File[]) => {
      setDropError(null)
      store.clearError()
      try {
        const imageFiles = files.filter(isSupportedImageFile)
        const referencedFiles = files.filter(file => !isSupportedImageFile(file))
        const images = imageFiles.length === 0 ? [] : await imagePayloads(imageFiles)
        if (images.length > 0) {
          const imported = await store.importSessionImages(images, sessionId)
          if (!imported) return
        }
        if (referencedFiles.length > 0 && sessionId !== undefined)
          await store.addSessionFiles(sessionId, referencedFiles)
      } catch (error) {
        setDropError(error instanceof Error ? error.message : '无法处理拖入的文件')
      }
    }
    const targetsThisComposer = (event: DragEvent) => {
      const panel =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>('[data-work-panel]')
          : null
      return panel ? panel.dataset.workPanel === sessionId : composerFocused
    }
    const onDragEnter = (event: DragEvent) => {
      if (!containsFiles(event) || !targetsThisComposer(event)) return
      event.preventDefault()
      dragDepth.current += 1
      if (canAttach) setDraggingFiles(true)
    }
    const onDragOver = (event: DragEvent) => {
      if (!containsFiles(event) || !targetsThisComposer(event)) return
      event.preventDefault()
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = canAttach ? 'copy' : 'none'
    }
    const onDragLeave = (event: DragEvent) => {
      if (!containsFiles(event) || !targetsThisComposer(event)) return
      event.preventDefault()
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDraggingFiles(false)
    }
    const onDrop = (event: DragEvent) => {
      if (!containsFiles(event) || !targetsThisComposer(event)) return
      event.preventDefault()
      dragDepth.current = 0
      setDraggingFiles(false)
      if (!canAttach || sessionId === undefined || event.dataTransfer === null) {
        setDropError('当前不能附加文件，请先选择会话并等待运行核心就绪')
        return
      }
      void importFiles(Array.from(event.dataTransfer.files))
    }
    document.addEventListener('dragenter', onDragEnter)
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('dragleave', onDragLeave)
    document.addEventListener('drop', onDrop)
    return () => {
      document.removeEventListener('dragenter', onDragEnter)
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('dragleave', onDragLeave)
      document.removeEventListener('drop', onDrop)
    }
  }, [canAttach, caret, sessionId, store, text])

  return (
    <>
      <section
        ref={setComposerAnchor}
        className={`composer-card${draggingFiles ? ' is-dragging-files' : ''}`}
        aria-label="消息输入"
        data-session-id={sessionId}
      >
        {draggingFiles &&
          createPortal(
            <div className="composer-drop-target" role="status">
              松开以附加文件或图片
            </div>,
            document.body,
          )}
        {(dropError ?? snapshot.error) !== null && composerFocused && (
          <AppAlert
            tone="error"
            title="操作未完成"
            floating
            dismissAfterMs={8_000}
            onClose={dismissError}
          >
            {dropError ?? snapshot.error}
          </AppAlert>
        )}
        <CommandPalette
          open={paletteOpen}
          morphAnchor={paletteFromButton ? pickerButtonRef.current : null}
          onExited={clearPaletteOrigin}
          anchor={composerAnchor}
          items={filteredCommandItems}
          query={paletteQuery}
          title={
            paletteCategory === 'skill'
              ? 'Skill'
              : paletteCategory === 'command'
                ? '命令'
                : '命令与 Skill'
          }
          emptyText={paletteCategory === 'skill' ? '没有匹配的 Skill' : '没有匹配的命令或 Skill'}
          focusSearch={picker !== null}
          onQueryChange={query => {
            setPicker({ category: paletteCategory, query })
          }}
          {...(paletteCategory === 'home'
            ? {}
            : {
                onBack: () => {
                  setPicker({ category: 'home', query: '' })
                },
              })}
          activeIndex={activeCommandIndex}
          loading={
            directoryState.status === 'idle' ||
            directoryState.status === 'loading' ||
            directoryState.status === 'stale'
          }
          error={directoryState.status === 'error' ? directoryState.error : null}
          onSelect={selectCommand}
          onActiveIndexChange={setActiveCommandIndex}
          onDismiss={() => {
            setPaletteDismissed(true)
            setPicker(null)
            textarea.current?.focus()
          }}
        />
        {fileReferenceOpen && fileReferenceToken !== null && (
          <CommandPalette
            mode="file-reference"
            anchor={composerAnchor}
            items={fileReferenceItems}
            query={fileReferenceToken.query}
            activeIndex={activeFileReferenceIndex}
            loading={
              fileReferenceState.status === 'loading' || fileReferenceState.status === 'idle'
            }
            error={fileReferenceState.status === 'error' ? fileReferenceState.error : null}
            emptyText="没有匹配的工作区文件"
            ariaLabel="文件与文件夹候选"
            onSelect={selectFileReference}
            onActiveIndexChange={setActiveFileReferenceIndex}
            onDismiss={() => {
              setFileReferenceDismissed(true)
              textarea.current?.focus()
            }}
          />
        )}
        {attachments.length > 0 && (
          <ul className="composer-attachments" aria-label="待发送图片">
            {attachments.map((attachment, index) => (
              <li
                key={`${attachment.name}:${String(index)}`}
                title={`${attachment.name} · ${attachmentSize(attachment.bytes)}`}
              >
                <img
                  src={`data:${attachment.mediaType};base64,${attachment.base64}`}
                  alt={attachment.name}
                />
                <button
                  type="button"
                  aria-label={`移除附件 ${attachment.name}`}
                  title="移除图片"
                  onClick={() => {
                    if (sessionId !== undefined) store.removeSessionAttachment(sessionId, index)
                  }}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {fileAttachments.length > 0 && (
          <ul className="composer-file-attachments" aria-label="待发送文件">
            {fileAttachments.map(file => (
              <li key={file.id} data-upload-status={file.status} title={file.error ?? file.name}>
                <FileText size={18} aria-hidden="true" />
                <div>
                  <strong>{file.name}</strong>
                  <small>
                    {attachmentSize(file.bytes)} ·{' '}
                    {file.status === 'uploading'
                      ? '正在上传…'
                      : file.status === 'ready'
                        ? '已就绪'
                        : (file.error ?? '上传失败')}
                  </small>
                </div>
                {file.status === 'error' && (
                  <button
                    type="button"
                    aria-label={`重试上传 ${file.name}`}
                    onClick={() => {
                      if (sessionId) void store.retrySessionFile(sessionId, file.id)
                    }}
                  >
                    重试
                  </button>
                )}
                <button
                  type="button"
                  aria-label={`移除附件 ${file.name}`}
                  onClick={() => {
                    if (sessionId) store.removeSessionFile(sessionId, file.id)
                  }}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          id={composerFocused ? 'composer' : `composer-${sessionId ?? 'draft'}`}
          role="combobox"
          ref={textarea}
          rows={1}
          value={text}
          aria-autocomplete="list"
          aria-controls={
            listboxVisible && picker === null
              ? COMMAND_PALETTE_LISTBOX_ID
              : fileReferenceListVisible
                ? FILE_REFERENCE_LISTBOX_ID
                : undefined
          }
          aria-expanded={(paletteOpen && picker === null) || fileReferenceOpen}
          aria-activedescendant={
            listboxVisible && picker === null && activeCommand !== undefined
              ? commandPaletteOptionId(activeCommand)
              : fileReferenceListVisible && activeFileReference !== undefined
                ? commandPaletteOptionId(activeFileReference, 'file-reference')
                : undefined
          }
          disabled={
            !composerReady ||
            !hostReady ||
            snapshot.creatingSession ||
            (session !== undefined && snapshot.sessionModels?.routable === false)
          }
          placeholder={
            !composerReady
              ? '先选择或创建一个聊天'
              : !hostReady
                ? '正在恢复运行核心…'
                : newSessionDraftActive
                  ? '输入第一条消息以创建会话…'
                  : snapshot.sessionModels?.routable === false
                    ? '当前模型提供方不可用，请先选择其他模型'
                    : session?.running
                      ? snapshot.busyEnter === 'steer'
                        ? 'Enter 插话发送，Cmd/Ctrl + Enter 加入队列…'
                        : 'Enter 加入队列，Cmd/Ctrl + Enter 插话发送…'
                      : planActive
                        ? '描述你的任务以生成计划…'
                        : '给 MyDSH 发送消息，Shift + Enter 换行…'
          }
          onChange={event => {
            if (sessionId === undefined) {
              if (newSessionDraftActive) store.setNewSessionDraft(event.currentTarget.value)
            } else {
              store.setSessionDraft(sessionId, event.currentTarget.value)
            }
            setCaret(event.currentTarget.selectionStart)
            if (!paletteOpen) setPaletteFromButton(false)
            setPicker(null)
            setPaletteDismissed(false)
            setFileReferenceDismissed(false)
          }}
          onClick={event => {
            setCaret(event.currentTarget.selectionStart)
          }}
          onSelect={event => {
            setCaret(event.currentTarget.selectionStart)
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <footer>
          <div className="composer-tools">
            <ElasticPress>
              <button
                className="composer-attachment-button"
                type="button"
                disabled={session === undefined || !hostReady || choosingAttachments}
                aria-label="附加图片"
                title="附加图片（PNG、JPEG、WebP 或 GIF）"
                onClick={() => {
                  setDropError(null)
                  void store.chooseSessionAttachments(sessionId)
                }}
              >
                {choosingAttachments ? (
                  <LoaderCircle className="spin" size={16} aria-hidden="true" />
                ) : (
                  <Paperclip size={16} aria-hidden="true" />
                )}
              </button>
            </ElasticPress>
            <PermissionSelector disabled={session === undefined || !hostReady} />
            <ModeSelector disabled={session === undefined || !hostReady} />
            {snapshot.sessionQueue.totalCount > 0 && (
              <span>{snapshot.sessionQueue.totalCount} 条待处理</span>
            )}
            <ElasticPress>
              <button
                ref={pickerButtonRef}
                className="composer-picker-button"
                type="button"
                aria-label="打开命令与 Skill"
                title="命令与 Skill"
                aria-haspopup="dialog"
                aria-expanded={paletteOpen}
                disabled={session === undefined || !hostReady}
                onClick={togglePicker}
              >
                <Terminal size={16} aria-hidden="true" />
              </button>
            </ElasticPress>
          </div>
          <div className="composer-actions">
            <PluginActions
              name="composer.actions"
              scopeKey={sessionId ?? `draft:${newSessionProjectId ?? 'no-project'}`}
            />
            <ModelSelector disabled={session === undefined || !hostReady} />
            {commandActive && commandExecution !== null && (
              <span
                className="composer-command-state"
                role="status"
                aria-label={`正在执行 /${commandExecution.name}`}
                title={`正在执行 /${commandExecution.name}`}
              >
                <LoaderCircle className="spin" size={15} aria-hidden="true" />
              </span>
            )}
            {replyActive ? (
              <ElasticPress hoverSwell>
                <button
                  className="stop-button"
                  type="button"
                  aria-label="停止运行"
                  title="停止运行"
                  disabled={!hostReady || stoppingSessionId === sessionId}
                  aria-busy={stoppingSessionId === sessionId}
                  onClick={() => {
                    if (sessionId === undefined) return
                    setStoppingSessionId(sessionId)
                    void store.cancelSession(sessionId).finally(() => {
                      setStoppingSessionId(current => (current === sessionId ? null : current))
                    })
                  }}
                >
                  <Square size={11} fill="currentColor" aria-hidden="true" />
                </button>
              </ElasticPress>
            ) : (
              <ElasticPress hoverSwell>
                <button
                  className="send-button"
                  type="button"
                  aria-label="发送"
                  disabled={
                    (text.trim() === '' &&
                      attachments.length === 0 &&
                      fileAttachments.length === 0) ||
                    filesPending ||
                    !composerReady ||
                    !hostReady ||
                    snapshot.creatingSession ||
                    snapshot.sendingMessage ||
                    commandActive ||
                    (session !== undefined && snapshot.sessionModels?.routable === false)
                  }
                  onClick={() => {
                    void send(false)
                  }}
                >
                  {snapshot.creatingSession || snapshot.sendingMessage ? (
                    <LoaderCircle className="spin" size={17} />
                  ) : (
                    <ArrowUp size={19} />
                  )}
                </button>
              </ElasticPress>
            )}
          </div>
        </footer>
      </section>
      {showReadings && (
        <ComposerStatus
          key={sessionId ?? 'no-session'}
          usage={hubUsage}
          context={hubContext}
          breakdown={parseHubContextBreakdown(hubValues.contextBreakdown)}
          stats={hubStats}
          running={replyActive}
          onRestoreFocus={() => {
            textarea.current?.focus()
          }}
        />
      )}
    </>
  )
}
