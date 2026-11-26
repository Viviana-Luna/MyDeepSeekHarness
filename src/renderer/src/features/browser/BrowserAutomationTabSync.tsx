/**
 * 内置浏览器自动化标签同步桥：监听主进程 `mydsh:browser:changed` 事件并同步到工作台顶栏标签。
 * 当 AI 在主进程打开或操控内置浏览器标签时，自动在当前项目分组登记标签页并尝试与当前会话并排展示，方便用户实时观看或手动登录。
 */
import { useEffect, useRef } from 'react'
import type { BrowserState } from '../../../../shared/browser.ts'
import { useWorkspaceStore } from '../../hooks/useWorkspace.ts'
import { useWorkspaceTabs, type WorkTab } from '../workspace-tabs/WorkspaceTabsProvider.tsx'
import { useWorkTabs } from '../workspace-tabs/useWorkTabs.ts'

interface SyncContextSnapshot {
  tabs: ReturnType<typeof useWorkspaceTabs>
  store: ReturnType<typeof useWorkspaceStore>
  workTabs: readonly WorkTab[]
}

function resolveTabTitle(value: BrowserState): string {
  const previewName = value.previewPath?.split('/').at(-1) ?? ''
  return value.title || previewName || value.url || '新网页'
}

function resolveTargetProjectId(context: SyncContextSnapshot): string {
  const activeTab = context.workTabs.find(tab => tab.active)
  if (activeTab && activeTab.kind !== 'ssh') return activeTab.projectId
  return context.store.selectedProject()?.id ?? 'unassigned'
}

function revealAutomatedTab(
  context: SyncContextSnapshot,
  tabId: string,
  revealed: Set<string>,
): void {
  const { tabs, store, workTabs } = context
  if (!tabs) return
  const browserWorkId = `browser:${tabId}`
  const activeTab = workTabs.find(tab => tab.active)
  const alreadyVisible =
    activeTab?.id === browserWorkId || Boolean(tabs.split?.includes(browserWorkId))
  if (alreadyVisible) {
    revealed.add(tabId)
    return
  }
  if (revealed.has(tabId)) return
  if (activeTab?.kind === 'browser') {
    revealed.add(tabId)
    tabs.selectBrowser(tabId)
    store.setView('browser')
    return
  }
  if (activeTab && activeTab.id !== browserWorkId) {
    // 优先与当前聊天/工作标签左右并排，同时保持原标签焦点，不打断用户输入或审批卡片交互。
    // 若当前活动标签已在其他分屏组中，不强行抢占视图也不标记已展示，以便取消分屏后仍可自动并排。
    if (tabs.splitTab(browserWorkId, activeTab.id, 'right')) {
      revealed.add(tabId)
      tabs.focus(activeTab.id)
    }
    return
  }
  revealed.add(tabId)
  tabs.selectBrowser(tabId)
  store.setView('browser')
}

/** 挂载在工作台根部的无渲染同步器，负责把主进程 AI 操控的内置浏览器页签同步到前端顶栏与分屏视图。 */
export function BrowserAutomationTabSync() {
  const tabs = useWorkspaceTabs()
  const store = useWorkspaceStore()
  const workTabs = useWorkTabs()
  const contextRef = useRef<SyncContextSnapshot>({ tabs, store, workTabs })
  contextRef.current = { tabs, store, workTabs }
  const revealedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const activeIds = new Set(tabs?.browserTabs.map(tab => tab.id) ?? [])
    for (const id of revealedRef.current) {
      if (!activeIds.has(id)) revealedRef.current.delete(id)
    }
  }, [tabs?.browserTabs])

  useEffect(() => {
    const bridge = window.dshDesktop?.browser
    if (!bridge) return
    return bridge.onChanged(value => {
      const current = contextRef.current
      if (!current.tabs) return
      const tabId = value.tabId ?? 'default'
      if (value.closed) {
        revealedRef.current.delete(tabId)
        current.tabs.removeBrowserTab(tabId)
        return
      }
      const hasPage = Boolean(
        value.automated || value.url || value.loading || value.title || value.previewPath,
      )
      const exists = current.tabs.browserTabs.some(tab => tab.id === tabId)
      if (!exists && !hasPage) return
      const title = resolveTabTitle(value)
      if (exists && !value.automated) {
        if (value.title || value.previewPath || value.url) {
          current.tabs.updateBrowser(tabId, title)
        }
        return
      }
      const targetProjectId = resolveTargetProjectId(current)
      const registered = current.tabs.ensureBrowserTab(
        tabId,
        targetProjectId,
        title,
        value.automated === true,
      )
      if (value.automated && registered) {
        revealAutomatedTab(current, tabId, revealedRef.current)
      }
    })
  }, [])

  return null
}
