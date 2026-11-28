import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

export interface TerminalTabContribution {
  readonly key: string
  readonly number: number
  readonly title: string
  readonly status: 'starting' | 'running' | 'exited' | 'error'
  readonly description: string
}

export interface TerminalTabGroup {
  readonly projectAccessId: string
  readonly activeKey: string
  readonly tabs: readonly TerminalTabContribution[]
  select(key: string): void
  close(key: string): void
  create?(): void
  render?(key: string, visible: boolean): ReactNode
}

/** 窗口级 SSH 标签的导航与呈现，由连接工作区负责建立和关闭通道。 */
export interface SshTabGroup {
  readonly activeId: string | null
  readonly busy: boolean
  readonly tabs: readonly { id: string; title: string; description: string }[]
  select(id: string | null): void
  close(id: string): void
  render(id: string, visible: boolean, focused: boolean): ReactNode
}

export interface WorkSplitGroup {
  readonly tabs: readonly [string, string]
  readonly ratio: number
}

/** 工作台内置浏览器标签描述：普通网页仅含标题，本地项目预览额外绑定项目访问标识与路径。 */
export interface BrowserTab {
  id: string
  projectId: string
  title: string
  previewTarget?: {
    readonly projectAccessId: string
    readonly relativePath: string
  }
}
export interface WorkTab {
  id: string
  kind: 'session' | 'file' | 'terminal' | 'ssh' | 'browser' | 'diff'
  projectId: string
  title: string
  description: string
  active: boolean
  rawActive?: boolean
  navigate?(): void
  running?: boolean
  unread?: boolean
  preview?: boolean
  dirty?: boolean
  closeLabel?: string
  closeDisabled?: boolean
  select(): void
  close(): void
  pin?: () => void
}

interface WorkspaceTabsState {
  readonly error: string | null
  clearError(): void
  readonly browserTabs: readonly BrowserTab[]
  readonly activeBrowserId: string | null
  readonly splitGroups: readonly WorkSplitGroup[]
  readonly split: readonly [string, string] | null
  readonly splitRatio: number
  setSplitRatio(ratio: number): void
  readonly focusedTabId: string | null
  focus(id: string | null): void
  splitTab(id: string, beside: string, side: 'left' | 'right'): boolean
  swapSplit(id: string, side: 'left' | 'right'): boolean
  merge(id?: string): void
  removeTab(id: string): void
  replaceSplitTab(fromId: string, toId: string): boolean
  openBrowser(projectId: string): void
  ensureBrowserTab(
    id: string,
    projectId: string,
    title?: string,
    reassignProject?: boolean,
  ): boolean
  removeBrowserTab(id: string): void
  openBrowserFile(target: {
    readonly projectId: string
    readonly projectAccessId: string
    readonly relativePath: string
  }): Promise<boolean>
  selectBrowser(id: string): void
  closeBrowser(id: string): Promise<void>
  updateBrowser(id: string, title: string): void
  readonly terminalGroups: readonly TerminalTabGroup[]
  readonly activeTerminalProjectAccessId: string | null
  selectTerminalProject(projectAccessId: string | null): void
  publishTerminalGroup(group: TerminalTabGroup): void
  removeTerminalGroup(projectAccessId: string): void
  readonly sshGroup: SshTabGroup | null
  publishSshGroup(group: SshTabGroup | null): void
}

const WorkspaceTabsContext = createContext<WorkspaceTabsState | null>(null)

/** 顶栏只订阅终端的导航描述；PTY 和组件生命周期仍由终端工作区拥有。 */
export function WorkspaceTabsProvider({ children }: { children: ReactNode }) {
  const [error, setError] = useState<string | null>(null)
  const clearError = useCallback(() => {
    setError(null)
  }, [])
  const [browserTabs, setBrowserTabs] = useState<readonly BrowserTab[]>([])
  const browserTabsRef = useRef(browserTabs)
  browserTabsRef.current = browserTabs
  const [activeBrowserId, selectBrowser] = useState<string | null>(null)
  const [splitGroups, setSplitGroups] = useState<readonly WorkSplitGroup[]>([])
  const splitGroupsRef = useRef(splitGroups)
  splitGroupsRef.current = splitGroups
  const updateGroups = useCallback(
    (change: (current: readonly WorkSplitGroup[]) => readonly WorkSplitGroup[]) => {
      const next = change(splitGroupsRef.current)
      splitGroupsRef.current = next
      setSplitGroups(next)
    },
    [],
  )
  const [focusedTabId, setFocusedTabId] = useState<string | null>(null)
  const focusedTabIdRef = useRef(focusedTabId)
  focusedTabIdRef.current = focusedTabId
  const activeGroup = splitGroups.find(
    group => focusedTabId !== null && group.tabs.includes(focusedTabId),
  )
  const split = activeGroup?.tabs ?? null
  const splitRatio = activeGroup?.ratio ?? 0.5
  const focus = useCallback((id: string | null) => {
    focusedTabIdRef.current = id
    setFocusedTabId(id)
  }, [])
  const setSplitRatio = useCallback(
    (ratio: number) => {
      const id = focusedTabIdRef.current
      updateGroups(current =>
        current.map(group =>
          id !== null && group.tabs.includes(id) ? { ...group, ratio } : group,
        ),
      )
    },
    [updateGroups],
  )
  const splitTab = useCallback(
    (id: string, beside: string, side: 'left' | 'right') => {
      // 双标签组已经满员，任何入口都不能隐式替换成员或拆出其中一个。
      if (
        id === beside ||
        splitGroupsRef.current.some(group => group.tabs.includes(id) || group.tabs.includes(beside))
      )
        return false
      updateGroups(current => [
        ...current,
        { tabs: side === 'left' ? [id, beside] : [beside, id], ratio: 0.5 },
      ])
      focus(id)
      return true
    },
    [focus, updateGroups],
  )
  const swapSplit = useCallback(
    (id: string, side: 'left' | 'right') => {
      const group = splitGroupsRef.current.find(item => item.tabs.includes(id))
      if (!group || group.tabs[side === 'left' ? 0 : 1] === id) return false
      updateGroups(current =>
        current.map(item =>
          item === group ? { ...item, tabs: [item.tabs[1], item.tabs[0]] } : item,
        ),
      )
      focus(id)
      return true
    },
    [focus, updateGroups],
  )
  const merge = useCallback(
    (id = focusedTabIdRef.current) => {
      updateGroups(current => current.filter(group => id === null || !group.tabs.includes(id)))
    },
    [updateGroups],
  )
  const removeTab = useCallback(
    (id: string) => {
      updateGroups(current => current.filter(group => !group.tabs.includes(id)))
      if (focusedTabIdRef.current === id) focus(null)
    },
    [focus, updateGroups],
  )
  const replaceSplitTab = useCallback(
    (fromId: string, toId: string): boolean => {
      if (fromId === toId) return false
      const currentGroups = splitGroupsRef.current
      if (!currentGroups.some(group => group.tabs.includes(fromId))) return false
      const isOccupiedElsewhere = currentGroups.some(
        group => !group.tabs.includes(fromId) && group.tabs.includes(toId),
      )
      if (isOccupiedElsewhere) {
        removeTab(fromId)
        return false
      }
      updateGroups(current =>
        current.flatMap(group => {
          if (!group.tabs.includes(fromId)) return [group]
          const beside = group.tabs[0] === fromId ? group.tabs[1] : group.tabs[0]
          if (beside === toId) return []
          const nextTabs: readonly [string, string] =
            group.tabs[0] === fromId ? [toId, group.tabs[1]] : [group.tabs[0], toId]
          return [{ ...group, tabs: nextTabs }]
        }),
      )
      if (focusedTabIdRef.current === fromId) focus(toId)
      return true
    },
    [focus, removeTab, updateGroups],
  )
  const openBrowser = useCallback((projectId: string) => {
    const id = crypto.randomUUID()
    const next = [...browserTabsRef.current, { id, projectId, title: '新网页' }]
    browserTabsRef.current = next
    setBrowserTabs(next)
    selectBrowser(id)
  }, [])
  const ensureBrowserTab = useCallback(
    (id: string, projectId: string, title?: string, reassignProject = false): boolean => {
      const existing = browserTabsRef.current.find(tab => tab.id === id)
      if (existing) {
        const nextTitle = title || existing.title
        const canReassign =
          reassignProject &&
          existing.projectId !== projectId &&
          !splitGroupsRef.current.some(group => group.tabs.includes(`browser:${id}`))
        const nextProjectId = canReassign ? projectId : existing.projectId
        if (nextTitle !== existing.title || nextProjectId !== existing.projectId) {
          const next = browserTabsRef.current.map(tab =>
            tab.id === id ? { ...tab, title: nextTitle, projectId: nextProjectId } : tab,
          )
          browserTabsRef.current = next
          setBrowserTabs(next)
        }
        return true
      }
      if (browserTabsRef.current.length >= 12) return false
      const next = [...browserTabsRef.current, { id, projectId, title: title || '新网页' }]
      browserTabsRef.current = next
      setBrowserTabs(next)
      return true
    },
    [],
  )
  const removeBrowserTab = useCallback(
    (id: string) => {
      const closing = browserTabsRef.current.find(tab => tab.id === id)
      if (closing === undefined) return
      const remaining = browserTabsRef.current.filter(tab => tab.id !== id)
      browserTabsRef.current = remaining
      setBrowserTabs(remaining)
      const nextInProject = remaining.findLast(tab => tab.projectId === closing.projectId)
      selectBrowser(current => (current === id ? (nextInProject?.id ?? null) : current))
      removeTab(`browser:${id}`)
    },
    [removeTab],
  )
  const openBrowserFile = useCallback(
    async (target: {
      readonly projectId: string
      readonly projectAccessId: string
      readonly relativePath: string
    }): Promise<boolean> => {
      const bridge = window.dshDesktop?.browser
      if (!bridge) {
        setError('内置浏览器需要在 MyDSH 桌面应用中使用')
        return false
      }
      const existing = browserTabsRef.current.find(
        tab =>
          tab.previewTarget?.projectAccessId === target.projectAccessId &&
          tab.previewTarget.relativePath === target.relativePath,
      )
      if (existing) {
        selectBrowser(existing.id)
        try {
          await bridge.request({
            action: 'openFile',
            tabId: existing.id,
            projectId: target.projectAccessId,
            relativePath: target.relativePath,
          })
          return true
        } catch (cause) {
          setError(
            cause instanceof Error
              ? cause.message.replace(
                  /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/u,
                  '',
                )
              : '无法在内置浏览器中打开文件',
          )
          return false
        }
      }
      if (browserTabsRef.current.length >= 12) {
        setError('一个窗口最多打开 12 个浏览器标签')
        return false
      }
      const id = crypto.randomUUID()
      const fileName = target.relativePath.split('/').at(-1) ?? target.relativePath
      const nextTab: BrowserTab = {
        id,
        projectId: target.projectId,
        title: fileName,
        previewTarget: {
          projectAccessId: target.projectAccessId,
          relativePath: target.relativePath,
        },
      }
      const added = [...browserTabsRef.current, nextTab]
      browserTabsRef.current = added
      setBrowserTabs(added)
      selectBrowser(id)
      try {
        await bridge.request({
          action: 'openFile',
          tabId: id,
          projectId: target.projectAccessId,
          relativePath: target.relativePath,
        })
        return true
      } catch (cause) {
        const rolledBack = browserTabsRef.current.filter(tab => tab.id !== id)
        browserTabsRef.current = rolledBack
        setBrowserTabs(rolledBack)
        selectBrowser(current => (current === id ? (rolledBack.at(-1)?.id ?? null) : current))
        setError(
          cause instanceof Error
            ? cause.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/u, '')
            : '无法在内置浏览器中打开文件',
        )
        return false
      }
    },
    [],
  )
  const closeBrowser = useCallback(
    async (id: string) => {
      try {
        await window.dshDesktop?.browser?.request({ action: 'close', tabId: id })
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/u, '')
            : '关闭网页失败，请重试',
        )
        return
      }
      const closing = browserTabsRef.current.find(tab => tab.id === id)
      const remaining = browserTabsRef.current.filter(tab => tab.id !== id)
      browserTabsRef.current = remaining
      setBrowserTabs(remaining)
      const nextInProject =
        closing === undefined
          ? undefined
          : remaining.findLast(tab => tab.projectId === closing.projectId)
      selectBrowser(current => (current === id ? (nextInProject?.id ?? null) : current))
      removeTab(`browser:${id}`)
    },
    [removeTab],
  )
  const updateBrowser = useCallback((id: string, title: string) => {
    if (!browserTabsRef.current.some(tab => tab.id === id && tab.title !== title)) return
    const next = browserTabsRef.current.map(tab => (tab.id === id ? { ...tab, title } : tab))
    browserTabsRef.current = next
    setBrowserTabs(next)
  }, [])
  const [terminalGroups, setTerminalGroups] = useState<readonly TerminalTabGroup[]>([])
  const terminalGroupsRef = useRef(terminalGroups)
  terminalGroupsRef.current = terminalGroups
  const [activeTerminalProjectAccessId, selectTerminalProject] = useState<string | null>(null)
  const [sshGroup, publishSshGroup] = useState<SshTabGroup | null>(null)
  const publishTerminalGroup = useCallback((group: TerminalTabGroup) => {
    const next = [
      ...terminalGroupsRef.current.filter(item => item.projectAccessId !== group.projectAccessId),
      group,
    ]
    terminalGroupsRef.current = next
    setTerminalGroups(next)
    if (group.tabs.length > 0) {
      selectTerminalProject(current => current ?? group.projectAccessId)
    } else {
      selectTerminalProject(current =>
        current === group.projectAccessId
          ? (next.findLast(item => item.tabs.length > 0)?.projectAccessId ?? null)
          : current,
      )
    }
  }, [])
  const removeTerminalGroup = useCallback((projectAccessId: string) => {
    const next = terminalGroupsRef.current.filter(item => item.projectAccessId !== projectAccessId)
    terminalGroupsRef.current = next
    setTerminalGroups(next)
    selectTerminalProject(current =>
      current === projectAccessId
        ? (next.findLast(item => item.tabs.length > 0)?.projectAccessId ?? null)
        : current,
    )
  }, [])
  const value = useMemo(
    () => ({
      error,
      clearError,
      terminalGroups,
      activeTerminalProjectAccessId,
      selectTerminalProject,
      publishTerminalGroup,
      removeTerminalGroup,
      sshGroup,
      publishSshGroup,
      browserTabs,
      activeBrowserId,
      splitGroups,
      split,
      splitRatio,
      setSplitRatio,
      focusedTabId,
      focus,
      splitTab,
      swapSplit,
      merge,
      removeTab,
      replaceSplitTab,
      openBrowser,
      ensureBrowserTab,
      removeBrowserTab,
      openBrowserFile,
      selectBrowser,
      closeBrowser,
      updateBrowser,
    }),
    [
      error,
      clearError,
      terminalGroups,
      activeTerminalProjectAccessId,
      publishTerminalGroup,
      removeTerminalGroup,
      sshGroup,
      browserTabs,
      activeBrowserId,
      splitGroups,
      split,
      splitRatio,
      setSplitRatio,
      focusedTabId,
      focus,
      splitTab,
      swapSplit,
      merge,
      removeTab,
      replaceSplitTab,
      openBrowser,
      ensureBrowserTab,
      removeBrowserTab,
      openBrowserFile,
      closeBrowser,
      updateBrowser,
    ],
  )
  return <WorkspaceTabsContext.Provider value={value}>{children}</WorkspaceTabsContext.Provider>
}

export function useWorkspaceTabs() {
  return useContext(WorkspaceTabsContext)
}
