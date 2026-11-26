import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { SessionScope, useWorkspaceSnapshot } from '../../hooks/useWorkspace.ts'
import { ConversationMain } from '../../plugins/builtin/session.tsx'
import { BrowserPanel } from '../browser/BrowserPanel.tsx'
import { FileViewer } from '../files/FileViewer.tsx'
import { FileDocumentScope } from '../project-workspace/ProjectWorkspaceProvider.tsx'
import { diffKey, useOptionalSourceControl } from '../source-control/SourceControlProvider.tsx'
import { SourceControlView } from '../source-control/SourceControlView.tsx'
import { WindowControls } from '../window/WindowControls.tsx'
import { useWorkspaceTabs, type WorkTab } from './WorkspaceTabsProvider.tsx'
import { useWorkTabs } from './useWorkTabs.ts'

/** 标签的 React 父节点始终不变，分屏只改变稳定宿主的网格位置。 */
export function WorkTabPanels({ showWindowControls = false }: { showWindowControls?: boolean }) {
  const tabs = useWorkTabs()
  const state = useWorkspaceTabs()
  const source = useOptionalSourceControl()
  const snapshot = useWorkspaceSnapshot()
  const surface = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)
  const [surfaceWidth, setSurfaceWidth] = useState(1000)
  const resizeStart = useRef<number | null>(null)
  const geometry = useRef(new Map<string, DOMRect>())
  const animations = useRef<Animation[]>([])
  const [mounted, setMounted] = useState<ReadonlySet<string>>(new Set())
  const active = tabs.find(tab => tab.active)
  const ids = JSON.stringify(tabs.map(tab => tab.id))
  const activeId = active?.id ?? null
  const activeGroup = state?.splitGroups.find(
    group =>
      activeId !== null &&
      group.tabs.includes(activeId) &&
      group.tabs.every(id => tabs.some(tab => tab.id === id)),
  )
  const split = activeGroup?.tabs ?? null
  const rawActiveId = tabs.find(tab => tab.rawActive ?? tab.active)?.id ?? null
  const navigation = `${snapshot.activeView}:${rawActiveId ?? ''}`
  const previousNavigation = useRef<{
    navigation: string
    rawId: string | null
    group: readonly [string, string] | null
  }>({ navigation: '', rawId: null, group: null })
  useLayoutEffect(() => {
    const before = previousNavigation.current
    const removedRaw = before.rawId !== null && !tabs.some(tab => tab.id === before.rawId)
    const survivor =
      removedRaw && before.group ? tabs.find(tab => before.group!.includes(tab.id)) : undefined
    previousNavigation.current = { navigation, rawId: rawActiveId, group: split }
    for (const group of state?.splitGroups ?? []) {
      for (const id of group.tabs) if (!tabs.some(tab => tab.id === id)) state?.removeTab(id)
    }
    if (survivor) {
      survivor.navigate?.()
      state?.focus(survivor.id)
      return
    }
    if (
      before.navigation !== navigation ||
      (before.group !== null && split === null) ||
      (state?.focusedTabId === null && rawActiveId !== null)
    )
      state?.focus(rawActiveId)
  }, [navigation, ids, split, state?.focusedTabId])
  useEffect(() => {
    const element = surface.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) {
        setNarrow(entry.contentRect.width < 720)
        setSurfaceWidth(entry.contentRect.width)
      }
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [])
  const focused = activeId
  const shown =
    split === null
      ? activeId === null
        ? []
        : [activeId]
      : narrow
        ? [focused ?? split[0]]
        : [...split]
  const shownKey = JSON.stringify(shown)
  useEffect(() => {
    setMounted(
      current => new Set([...current].filter(id => tabs.some(tab => tab.id === id)).concat(shown)),
    )
  }, [shownKey, ids])
  useEffect(() => {
    const host = surface.current
    if (!host) return
    const observer = new ResizeObserver(() => {
      if (!host.hasAttribute('data-drop-side') && resizeStart.current === null) return
      for (const panel of host.querySelectorAll<HTMLElement>(
        ':scope > [data-work-panel]:not([hidden])',
      ))
        geometry.current.set(panel.dataset.workPanel!, panel.getBoundingClientRect())
    })
    for (const panel of host.querySelectorAll<HTMLElement>(
      ':scope > [data-work-panel]:not([hidden])',
    ))
      observer.observe(panel)
    return () => {
      observer.disconnect()
    }
  }, [shownKey])
  const splitVisible = split !== null && !narrow
  const minimumRatio = Math.min(0.45, 320 / Math.max(1, surfaceWidth - 8))
  const clampRatio = (value: number) => Math.max(minimumRatio, Math.min(1 - minimumRatio, value))
  const ratio = clampRatio(activeGroup?.ratio ?? 0.5)
  useLayoutEffect(() => {
    const host = surface.current
    if (!host) return
    const panels = [
      ...host.querySelectorAll<HTMLElement>(':scope > [data-work-panel]:not([hidden])'),
    ]
    const previous = geometry.current
    for (const animation of animations.current) animation.cancel()
    animations.current = []
    const next = new Map<string, DOMRect>()
    for (const panel of panels) {
      const bounds = panel.getBoundingClientRect(),
        id = panel.dataset.workPanel!
      next.set(id, bounds)
      const before = previous.get(id)
      if (
        !panel.animate ||
        matchMedia('(prefers-reduced-motion: reduce)').matches ||
        previous.size === 0
      )
        continue
      const changed =
        before && (Math.abs(before.width - bounds.width) > 1 || Math.abs(before.x - bounds.x) > 1)
      if (!changed && before) continue
      const animation = panel.animate(
        before
          ? [
              {
                transform: `translate(${before.x - bounds.x}px, ${before.y - bounds.y}px) scale(${before.width / bounds.width}, ${before.height / bounds.height})`,
                transformOrigin: 'top left',
              },
              { transform: 'none', transformOrigin: 'top left' },
            ]
          : [{ opacity: 0 }, { opacity: 1 }],
        { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' },
      )
      animations.current.push(animation)
    }
    geometry.current = next
    if (animations.current.length) {
      host.dataset.layoutMoving = 'true'
      const running = animations.current
      void Promise.allSettled(running.map(animation => animation.finished)).then(() => {
        if (animations.current === running) delete host.dataset.layoutMoving
      })
    } else delete host.dataset.layoutMoving
  }, [shownKey, splitVisible])
  useEffect(
    () => () => {
      for (const animation of animations.current) animation.cancel()
      delete document.body.dataset.workbenchResizing
    },
    [],
  )
  const endResize = (cancel = false) => {
    if (cancel && resizeStart.current !== null) state?.setSplitRatio(resizeStart.current)
    resizeStart.current = null
    delete document.body.dataset.workbenchResizing
    // 下一次分屏/合并应从调整后的可见尺寸出发。
    for (const panel of surface.current?.querySelectorAll<HTMLElement>(
      ':scope > [data-work-panel]:not([hidden])',
    ) ?? [])
      geometry.current.set(panel.dataset.workPanel!, panel.getBoundingClientRect())
  }
  useEffect(() => {
    if (!splitVisible) endResize()
    const cancel = () => {
      endResize(true)
    }
    window.addEventListener('blur', cancel)
    return () => {
      window.removeEventListener('blur', cancel)
    }
  }, [splitVisible])
  const render = (tab: WorkTab, visible: boolean) => {
    if (tab.kind === 'session')
      return (
        <SessionScope.Provider value={tab.id}>
          <ConversationMain
            placement="main"
            visibility={visible ? 'foreground' : 'hidden'}
            selectionRevision={0}
          />
        </SessionScope.Provider>
      )
    if (tab.kind === 'browser')
      return (
        <BrowserPanel
          tabId={tab.id.slice('browser:'.length)}
          placement="main"
          visibility={visible ? 'foreground' : 'hidden'}
          selectionRevision={0}
        />
      )
    if (tab.kind === 'file')
      return (
        <FileDocumentScope path={tab.description}>
          <FileViewer />
        </FileDocumentScope>
      )
    if (tab.kind === 'diff') {
      const diff = source?.openedDiffs.find(
        item => tab.id === `diff:${tab.projectId}:${diffKey(item)}`,
      )
      return diff ? <SourceControlView document={diff} /> : null
    }
    if (tab.kind === 'ssh')
      return state?.sshGroup?.render(tab.id.slice('ssh:'.length), visible, tab.active)
    for (const group of state?.terminalGroups ?? []) {
      const terminal = group.tabs.find(
        item => `terminal:${group.projectAccessId}:${item.key}` === tab.id,
      )
      if (terminal) return group.render?.(terminal.key, visible)
    }
    return null
  }
  const available =
    [
      'conversation',
      'trajectory',
      'files',
      'terminal',
      'browser',
      'changes',
      'connections',
    ].includes(snapshot.activeView) && shown.length > 0
  return (
    <div
      ref={surface}
      id={available ? 'session-workspace' : undefined}
      className="island main-island workbench-surface"
      data-workbench-split={splitVisible || undefined}
      style={
        splitVisible
          ? {
              gridTemplateColumns: `minmax(0, ${ratio}fr) var(--window-gap) minmax(0, ${1 - ratio}fr)`,
            }
          : undefined
      }
      hidden={!available}
      aria-label="工作标签内容"
    >
      {available && showWindowControls && <WindowControls />}
      {tabs
        .filter(
          tab =>
            mounted.has(tab.id) || shown.includes(tab.id) || ['terminal', 'ssh'].includes(tab.kind),
        )
        .map(tab => {
          const visible = available && shown.includes(tab.id)
          const splitIndex = splitVisible ? shown.indexOf(tab.id) : -1
          let splitPane: 'left' | 'right' | undefined
          if (splitIndex === 0) splitPane = 'left'
          else if (splitIndex === 1) splitPane = 'right'
          return (
            <section
              key={tab.id}
              className={`workspace-island-content work-tab-panel${split !== null && !narrow ? ' island' : ''}`}
              hidden={!visible}
              inert={!visible}
              data-work-panel={tab.id}
              data-split-pane={splitPane}
              data-focused={focused === tab.id || undefined}
              style={{ gridColumn: splitVisible ? splitIndex * 2 + 1 : 1 }}
              aria-label={tab.title}
              onPointerDownCapture={() => {
                if (!tab.active) tab.select()
                else state?.focus(tab.id)
              }}
              onFocusCapture={() => {
                if (!tab.active) tab.select()
                else state?.focus(tab.id)
              }}
            >
              {render(tab, visible)}
            </section>
          )
        })}
      {splitVisible && (
        <div
          role="separator"
          aria-label="调整分屏比例"
          aria-orientation="vertical"
          tabIndex={0}
          aria-valuemin={Math.round(minimumRatio * 100)}
          aria-valuemax={Math.round((1 - minimumRatio) * 100)}
          aria-valuenow={Math.round(ratio * 100)}
          className="workbench-divider"
          onDoubleClick={() => {
            state?.setSplitRatio(0.5)
          }}
          onPointerDown={event => {
            if (event.button !== 0) return
            event.preventDefault()
            event.currentTarget.focus()
            event.currentTarget.setPointerCapture(event.pointerId)
            resizeStart.current = ratio
            document.body.dataset.workbenchResizing = 'true'
          }}
          onPointerMove={event => {
            if (resizeStart.current === null) return
            const bounds = surface.current!.getBoundingClientRect()
            state?.setSplitRatio(clampRatio((event.clientX - bounds.left) / bounds.width))
          }}
          onPointerUp={event => {
            endResize()
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId)
          }}
          onPointerCancel={() => {
            endResize(true)
          }}
          onLostPointerCapture={() => {
            endResize()
          }}
          onKeyDown={event => {
            if (event.key === 'Escape') {
              endResize(true)
              return
            }
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            state?.setSplitRatio(
              event.key === 'Home'
                ? minimumRatio
                : event.key === 'End'
                  ? 1 - minimumRatio
                  : clampRatio(ratio + (event.key === 'ArrowLeft' ? -0.02 : 0.02)),
            )
          }}
        />
      )}
    </div>
  )
}
