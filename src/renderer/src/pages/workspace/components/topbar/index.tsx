/**
 * 顶部工作标签栏与单标签态 Liquid Glass 浮动操作胶囊：管理标签混排、分屏预览、平铺选择与新建入口。
 * 运行在 renderer；按顶栏显隐状态自动在 `.session-chrome` 与 `.floating-tab-actions` 之间切换操作控件。
 */
import {
  ChevronLeft,
  ChevronRight,
  FileCode2,
  Globe,
  Columns2,
  LayoutGrid,
  LoaderCircle,
  MessageSquare,
  Pin,
  TerminalSquare,
  X,
} from 'lucide-react'
import { Dropdown, Modal, Input } from 'antd'
import { createPortal } from 'react-dom'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react'
import { useWorkspaceSnapshot, useWorkspaceStore } from '../../../../hooks/useWorkspace.ts'
import { useProjectWorkspace } from '../../../../features/project-workspace/ProjectWorkspaceProvider.tsx'
import { useSessionTabGlass } from './useSessionTabGlass.ts'
import { ElasticPress } from '../../../../shared/ui/ElasticPress.tsx'
import { NewTabMenu, type NewTabMenuItem } from './NewTabMenu.tsx'
import { WindowControls } from '../../../../features/window/WindowControls.tsx'
import { useWorkspaceTabs } from '../../../../features/workspace-tabs/WorkspaceTabsProvider.tsx'
import './session-tabs.css'
import { DESKTOP_TERMINAL_LIMITS } from '../../../../../../shared/terminal.ts'
import { AppAlert } from '../../../../shared/ui/AppAlert.tsx'
import {
  resolveWorkTabGroups,
  useWorkTabs,
} from '../../../../features/workspace-tabs/useWorkTabs.ts'
import { useOptionalSourceControl } from '../../../../features/source-control/SourceControlProvider.tsx'
import type { WorkTab } from '../../../../features/workspace-tabs/WorkspaceTabsProvider.tsx'

function tabKindLabel(tab: WorkTab) {
  return {
    session: '聊天',
    terminal: '终端',
    ssh: 'SSH',
    browser: '网页',
    diff: 'Git 差异',
    file: '文件',
  }[tab.kind]
}

/** 顶栏收起时渲染于主浮岛右上角的苹果 Liquid Glass 液态玻璃操作胶囊。 */
function FloatingTabActions({
  newTabRef,
  newItems,
  onOpenOverview,
  onCreateTab,
}: {
  readonly newTabRef: RefObject<HTMLButtonElement | null>
  readonly newItems: readonly NewTabMenuItem[]
  readonly onOpenOverview: () => void
  readonly onCreateTab: (key: string) => void
}) {
  return (
    <div
      className="floating-tab-actions"
      data-floating-tab-actions="true"
      role="toolbar"
      aria-label="工作标签操作"
    >
      <span className="floating-tab-actions__glass" aria-hidden="true" />
      <NewTabMenu
        visible
        buttonRef={newTabRef}
        buttonClassName="floating-tab-actions__button"
        iconSize={16}
        elastic
        items={newItems}
        primaryKey="session"
        onSelect={onCreateTab}
      />
      <ElasticPress>
        <button
          type="button"
          className="new-session-tab floating-tab-actions__button"
          aria-label="平铺选择标签"
          title="平铺选择标签（Ctrl / ⌘ S）"
          onClick={onOpenOverview}
        >
          <LayoutGrid size={15} aria-hidden="true" />
        </button>
      </ElasticPress>
    </div>
  )
}

/** 顶部工作标签导航：多标签或侧栏收起时展示完整标签栏；单标签且侧栏展开（或 Windows 平台）时由右侧液态玻璃浮动胶囊承载新建与平铺操作。 */
export function Topbar({
  visible,
  floatingActions,
}: {
  visible: boolean
  floatingActions?: boolean
}) {
  const showFloatingActions =
    floatingActions ?? (!visible || document.documentElement.dataset.platform === 'win32')
  const snapshot = useWorkspaceSnapshot()
  const store = useWorkspaceStore()
  const workspace = useProjectWorkspace()
  const terminalTabs = useWorkspaceTabs()
  const source = useOptionalSourceControl()
  const project = store.selectedProject()
  const resources = useWorkTabs()
  // 混排只管理导航顺序，文件与终端仍由各自领域拥有。
  const [order, setOrder] = useState<readonly string[]>([])
  const resourceKeys = JSON.stringify(resources.map(tab => tab.id))
  useEffect(() => {
    const ids = JSON.parse(resourceKeys) as string[]
    setOrder(current => [
      ...current.filter(id => ids.includes(id)),
      ...ids.filter(id => !current.includes(id)),
    ])
  }, [resourceKeys])
  const ordered = resources.toSorted((left, right) => {
    const a = order.indexOf(left.id),
      b = order.indexOf(right.id)
    return (a < 0 ? order.length : a) - (b < 0 ? order.length : b)
  })
  const { groups, activeGroup, groupTabs, sshTabs } = resolveWorkTabGroups(
    ordered,
    snapshot.projects,
    project?.id,
  )
  const overviewGroups = [...groups, { id: 'ssh', name: 'SSH', tabs: sshTabs }]
  const visited = new Set<string>()
  const tabUnits = groupTabs.flatMap(tab => {
    if (visited.has(tab.id)) return []
    const split = terminalTabs?.splitGroups.find(group => group.tabs.includes(tab.id))
    const members = split?.tabs
      .map(id => groupTabs.find(item => item.id === id))
      .filter((item): item is WorkTab => item !== undefined) ?? [tab]
    const paired = members.length === 2
    for (const member of members) visited.add(member.id)
    return [
      {
        id: paired ? JSON.stringify(members.map(member => member.id).toSorted()) : tab.id,
        tabs: members,
        paired,
      },
    ]
  })
  const tabs = tabUnits.flatMap(unit => unit.tabs)
  const tabLayout = JSON.stringify([
    activeGroup?.id,
    tabUnits.map(unit => unit.tabs.map(tab => [tab.id, tab.title, tab.preview, tab.running])),
  ])
  const moveTab = (id: string, index: number) => {
    const from = tabUnits.findIndex(unit => unit.tabs.some(tab => tab.id === id))
    if (from < 0 || index < 0 || index >= tabUnits.length || from === index) return
    const nextUnits = [...tabUnits]
    const [moving] = nextUnits.splice(from, 1)
    nextUnits.splice(index, 0, moving!)
    const groupIds = new Set(tabs.map(tab => tab.id))
    const nextGroup = nextUnits.flatMap(unit => unit.tabs.map(tab => tab.id))
    let cursor = 0
    const next = ordered.map(tab => (groupIds.has(tab.id) ? nextGroup[cursor++]! : tab.id))
    setOrder(next)
    const sessionOrder = [...snapshot.openedSessionIds]
    next
      .filter(tabId => sessionOrder.includes(tabId))
      .forEach((tabId, target) => {
        const previous = sessionOrder.indexOf(tabId)
        if (previous === target) return
        sessionOrder.splice(previous, 1)
        sessionOrder.splice(target, 0, tabId)
        store.moveSessionTab(tabId, target)
      })
  }
  const selectedId = tabs.find(tab => tab.active)?.id ?? null
  const displayedSplit = terminalTabs?.splitGroups.find(
    group => selectedId !== null && group.tabs.includes(selectedId),
  )
  const [drop, setDrop] = useState<{
    left: number
    top: number
    width: number
    height: number
    leftWidth: number
    side: 'left' | 'right'
    action: 'split' | 'swap'
  } | null>(null)
  const [dropInvalid, setDropInvalid] = useState(false)
  const splitPartner = (id: string) => {
    if (!terminalTabs || terminalTabs.splitGroups.some(group => group.tabs.includes(id)))
      return undefined
    const beside =
      tabs.find(item => item.id !== id && item.active) ?? tabs.find(item => item.id !== id)
    return beside && !terminalTabs.splitGroups.some(group => group.tabs.includes(beside.id))
      ? beside
      : undefined
  }
  const dropAction = (id: string, side: 'left' | 'right' | null) => {
    if (displayedSplit?.tabs.includes(id))
      return side !== null && displayedSplit.tabs[side === 'left' ? 0 : 1] !== id
        ? ('swap' as const)
        : null
    return splitPartner(id) ? ('split' as const) : null
  }
  const leftPaneWidth = (surface: HTMLElement | undefined | null, rect: DOMRect | undefined) => {
    if (!surface || !rect) return 0
    const left =
      displayedSplit &&
      [...surface.querySelectorAll<HTMLElement>(':scope > [data-work-panel]:not([hidden])')].find(
        pane => pane.dataset.workPanel === displayedSplit.tabs[0],
      )
    return left
      ? left.getBoundingClientRect().width
      : (rect.width -
          (Number.parseFloat(getComputedStyle(surface).getPropertyValue('--window-gap')) || 8)) /
          2
  }
  const [dragPreview, setDragPreview] = useState<{ tab: WorkTab; excerpt: string } | null>(null)
  const previewCard = useRef<HTMLDivElement>(null)
  const previewContent = useRef<HTMLDivElement>(null)
  const previewSnapshot = useRef<HTMLElement | null>(null)
  const previewScroll = useRef<{ element: HTMLElement; top: number; left: number }[]>([])
  const previewPosition = useRef({ x: 0, y: 0, offsetX: 0, offsetY: 14 })
  const previewOrigin = useRef<DOMRect | null>(null)
  const previewAnimation = useRef<Animation | null>(null)
  const previewFrame = useRef(0)
  const dragTracking = useRef<{ id: string; x: number; y: number } | null>(null)
  const refreshDrop = useRef<() => void>(() => {})
  refreshDrop.current = () => {
    const tracking = dragTracking.current
    if (!tracking) return
    const surface = document.querySelector<HTMLElement>('.workbench-surface:not([hidden])')
    const rect = surface?.getBoundingClientRect()
    const leftWidth = leftPaneWidth(surface, rect)
    const side: 'left' | 'right' | null =
      rect &&
      rect.width >= 720 &&
      tracking.y >= rect.top &&
      tracking.y <= rect.bottom &&
      tracking.x >= rect.left &&
      tracking.x <= rect.right
        ? tracking.x < rect.left + leftWidth
          ? 'left'
          : 'right'
        : null
    const action = dropAction(tracking.id, side)
    setDropInvalid(action === null && !displayedSplit?.tabs.includes(tracking.id))
    const next =
      rect && side && action
        ? {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            leftWidth,
            side,
            action,
          }
        : null
    setDrop(current => (JSON.stringify(current) === JSON.stringify(next) ? current : next))
    if (surface) {
      if (next) surface.dataset.dropSide = side!
      else delete surface.dataset.dropSide
    }
  }
  const paintPreview = () => {
    const point = previewPosition.current
    if (previewCard.current)
      previewCard.current.style.transform = `translate3d(${point.x - point.offsetX}px, ${point.y - point.offsetY}px, 0)`
  }
  useLayoutEffect(() => {
    if (!dragPreview) return
    paintPreview()
    if (previewSnapshot.current && previewContent.current) {
      previewContent.current.replaceChildren(previewSnapshot.current)
      for (const { element, top, left } of previewScroll.current) {
        element.scrollTop = top
        element.scrollLeft = left
      }
    }
    const surface = document.querySelector<HTMLElement>('.workbench-surface:not([hidden])')
    if (!surface) return
    const observer = new ResizeObserver(() => {
      refreshDrop.current()
    })
    observer.observe(surface)
    refreshDrop.current()
    return () => {
      observer.disconnect()
    }
  }, [dragPreview])
  useEffect(
    () => () => {
      cancelAnimationFrame(previewFrame.current)
      previewAnimation.current?.cancel()
      delete document.body.dataset.workbenchDragging
      document.querySelector<HTMLElement>('.workbench-surface')?.removeAttribute('data-drop-side')
    },
    [],
  )
  const splitTab = (id: string, side: 'left' | 'right') => {
    const tab = resources.find(item => item.id === id)
    const beside = splitPartner(id)
    if (!tab || !beside || !terminalTabs || !terminalTabs.splitTab(id, beside.id, side))
      return false
    tab.pin?.()
    beside.pin?.()
    tab.select()
    return true
  }
  const finishPreview = (
    target: { x: number; y: number; width: number; height: number } | null,
    landing: boolean,
  ) => {
    cancelAnimationFrame(previewFrame.current)
    paintPreview()
    const card = previewCard.current
    const clear = () => {
      setDragPreview(null)
      previewSnapshot.current = null
      previewScroll.current = []
      delete document.body.dataset.workbenchDragging
    }
    if (
      !card ||
      !target ||
      !card.animate ||
      matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      clear()
      return
    }
    const scale = landing ? 1.04 : 0.82
    const targetX = landing ? target.x + (target.width - card.offsetWidth * scale) / 2 : target.x
    const targetY = landing ? target.y + 24 : target.y
    const animation = card.animate(
      [
        { transform: card.style.transform, opacity: 1 },
        { transform: `translate3d(${targetX}px, ${targetY}px, 0) scale(${scale})`, opacity: 0 },
      ],
      { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' },
    )
    previewAnimation.current = animation
    void animation.finished
      .then(() => {
        if (previewAnimation.current === animation) {
          previewAnimation.current = null
          clear()
        }
      })
      .catch(() => {})
  }
  const dragTab = (
    id: string,
    x: number,
    y: number,
    phase: 'detach' | 'move' | 'drop' | 'cancel',
  ) => {
    const surface = document.querySelector<HTMLElement>('.workbench-surface:not([hidden])')
    const rect = surface?.getBoundingClientRect()
    const leftWidth = leftPaneWidth(surface, rect)
    const side: 'left' | 'right' | null =
      rect &&
      rect.width >= 720 &&
      y >= rect.top &&
      y <= rect.bottom &&
      x >= rect.left &&
      x <= rect.right
        ? x < rect.left + leftWidth
          ? 'left'
          : 'right'
        : null
    const action = dropAction(id, side)
    if (phase === 'detach') {
      const tab = resources.find(item => item.id === id)
      if (!tab) return false
      previewAnimation.current?.cancel()
      previewAnimation.current = null
      const origin =
        [...document.querySelectorAll<HTMLElement>('[data-session-tab]')]
          .find(node => node.dataset.sessionTab === id)
          ?.getBoundingClientRect() ?? null
      previewOrigin.current = origin
      previewPosition.current = {
        x,
        y,
        offsetX: Math.min(260, Math.max(24, x - (origin?.left ?? x))),
        offsetY: 14,
      }
      const pane = [...document.querySelectorAll<HTMLElement>('[data-work-panel]')].find(
        node => node.dataset.workPanel === id,
      )
      previewSnapshot.current = null
      previewScroll.current = []
      if (pane && !pane.hidden && tab.kind !== 'browser') {
        const clone = pane.cloneNode(true) as HTMLElement
        const sourceElements = [pane, ...pane.querySelectorAll<HTMLElement>('*')]
        const clonedElements = [clone, ...clone.querySelectorAll<HTMLElement>('*')]
        sourceElements.forEach((original, index) => {
          const copy = clonedElements[index]!
          if (original.scrollTop || original.scrollLeft)
            previewScroll.current.push({
              element: copy,
              top: original.scrollTop,
              left: original.scrollLeft,
            })
          if (original instanceof HTMLTextAreaElement && copy instanceof HTMLTextAreaElement)
            copy.value = original.value
        })
        clone.inert = true
        clone.removeAttribute('data-work-panel')
        clone.removeAttribute('hidden')
        clone.querySelectorAll('script, iframe, video, audio, object, embed').forEach(node => {
          node.remove()
        })
        for (const node of [clone, ...clone.querySelectorAll<HTMLElement>('*')]) {
          node.removeAttribute('id')
          node.removeAttribute('name')
          node.removeAttribute('autofocus')
          node.removeAttribute('aria-controls')
        }
        const originals = pane.querySelectorAll('canvas')
        clone.querySelectorAll('canvas').forEach((canvas, index) => {
          try {
            const image = document.createElement('img')
            image.src = originals[index]!.toDataURL()
            image.style.cssText = canvas.style.cssText
            canvas.replaceWith(image)
          } catch {
            canvas.remove()
          }
        })
        const bounds = pane.getBoundingClientRect()
        clone.style.cssText = `position:absolute;inset:0;width:${bounds.width}px;height:${bounds.height}px;transform:scale(${288 / bounds.width});transform-origin:top left;pointer-events:none`
        previewSnapshot.current = clone
      }
      const address = pane?.querySelector<HTMLInputElement>('[aria-label="网页地址"]')?.value
      const content = pane?.querySelector<HTMLElement>(
        '[aria-label="会话对话"], .cm-content, .xterm-screen, .workspace-view[role="status"]',
      )
      const excerpt =
        address ||
        (tab.kind === 'session' ? snapshot.sessionDrafts[id] : '') ||
        (content?.innerText || content?.textContent)?.trim().slice(0, 900) ||
        tab.description
      setDragPreview({ tab, excerpt })
      document.body.dataset.workbenchDragging = 'true'
    }
    if (phase === 'move' || phase === 'detach') {
      dragTracking.current = { id, x, y }
      previewPosition.current.x = x
      previewPosition.current.y = y
      cancelAnimationFrame(previewFrame.current)
      previewFrame.current = requestAnimationFrame(paintPreview)
      refreshDrop.current()
      return false
    }
    dragTracking.current = null
    setDrop(null)
    if (surface) delete surface.dataset.dropSide
    const accepted =
      phase === 'drop' &&
      side !== null &&
      action !== null &&
      (action === 'swap' ? terminalTabs?.swapSplit(id, side) === true : splitTab(id, side))
    const gap = surface
      ? Number.parseFloat(getComputedStyle(surface).getPropertyValue('--window-gap')) || 8
      : 8
    finishPreview(
      accepted && rect
        ? {
            x: side === 'left' ? rect.left : rect.left + leftWidth + gap,
            y: rect.top,
            width: side === 'left' ? leftWidth : rect.width - leftWidth - gap,
            height: rect.height,
          }
        : previewOrigin.current,
      accepted,
    )
    return accepted
  }
  const {
    stripRef,
    rootRef,
    materialRef,
    defsRef,
    lensRef,
    overflow,
    canScrollLeft,
    canScrollRight,
    scrollByPage,
  } = useSessionTabGlass(visible, selectedId, tabLayout, moveTab, dragTab)
  const closingId = useRef<string | null>(null)
  const newTabRef = useRef<HTMLButtonElement>(null)

  useLayoutEffect(() => {
    const strip = stripRef.current
    if (strip === null) return
    if (closingId.current !== null && !resources.some(tab => tab.id === closingId.current)) {
      const activeElement = document.activeElement
      const lostFocus =
        activeElement === null ||
        activeElement === document.body ||
        (!visible && strip.contains(activeElement))
      if (lostFocus) {
        const focusableNewTab =
          newTabRef.current !== null && !newTabRef.current.disabled ? newTabRef.current : null
        const focusTarget = visible
          ? (strip.querySelector<HTMLButtonElement>('[aria-selected="true"]') ?? focusableNewTab)
          : (focusableNewTab ??
            document.querySelector<HTMLButtonElement>('.session-search-trigger'))
        focusTarget?.focus()
      }
      closingId.current = null
    }
  }, [resourceKeys, visible, stripRef])

  const [overview, setOverview] = useState(false)
  const [query, setQuery] = useState('')
  useEffect(() => {
    if (overview && resources.length === 0) setOverview(false)
  }, [overview, resources.length])
  const closeTab = (id: string) => {
    const tab = resources.find(item => item.id === id)
    if (!tab || tab.closeDisabled) return
    closingId.current = id
    tab.close()
  }

  const mergeSplit = (id = selectedId) => {
    if (id === null) return
    const group = terminalTabs?.splitGroups.find(item => item.tabs.includes(id))
    if (!group) return
    const focused = group.tabs.includes(terminalTabs?.focusedTabId ?? '')
      ? terminalTabs?.focusedTabId
      : id
    resources.find(tab => tab.id === focused)?.navigate?.()
    terminalTabs?.merge(id)
  }

  const closeGroup = (group: { id: string; tabs: readonly WorkTab[] }) => {
    setOverview(false)
    const sessions = group.tabs.filter(tab => tab.kind === 'session').map(tab => tab.id)
    const closeOthers = () => {
      for (const tab of group.tabs) {
        if (!['session', 'file', 'diff'].includes(tab.kind)) tab.close()
      }
      if (group.id === project?.id) source?.closeDiffs()
    }
    if (group.id === project?.id) workspace.closeProjectTabs(sessions, closeOthers)
    else {
      closeOthers()
      for (const id of sessions) workspace.closeSessionTab(id)
    }
  }
  useEffect(() => {
    const keydown = (event: globalThis.KeyboardEvent) => {
      if ((!event.metaKey && !event.ctrlKey) || event.altKey || event.shiftKey || event.isComposing)
        return
      const key = event.key.toLowerCase()
      if (!['s', 'w'].includes(key)) return
      if (
        !overview &&
        [...document.querySelectorAll<HTMLElement>('[role="dialog"], dialog[open]')].some(node =>
          node.checkVisibility?.(),
        )
      )
        return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (key === 's') {
        setQuery('')
        setOverview(open => !open)
      } else if (selectedId !== null) closeTab(selectedId)
    }
    const off = window.dshDesktop?.onTabAction?.(({ action, browserId }) => {
      if (
        !overview &&
        [...document.querySelectorAll<HTMLElement>('[role="dialog"], dialog[open]')].some(node =>
          node.checkVisibility?.(),
        )
      )
        return
      if (action === 'overview') {
        setQuery('')
        setOverview(open => !open)
      } else {
        const target = browserId ? `browser:${browserId}` : selectedId
        if (target !== null) closeTab(target)
      }
    })
    window.addEventListener('keydown', keydown, true)
    return () => {
      off?.()
      window.removeEventListener('keydown', keydown, true)
    }
  }, [selectedId, resources, overview])
  const terminalOwner =
    (activeGroup?.id !== undefined && activeGroup.id !== 'unassigned'
      ? snapshot.projects.find(item => item.id === activeGroup.id)
      : undefined) ??
    project ??
    snapshot.projects.find(item => item.projectAccessId !== undefined)
  const newItems = [
    {
      key: 'session',
      label: '新聊天',
      icon: <MessageSquare size={15} />,
      disabled: snapshot.creatingSession || snapshot.hostStatus?.kind !== 'ready',
    },
    {
      key: 'terminal',
      label: '新终端',
      icon: <TerminalSquare size={15} />,
      disabled:
        !terminalOwner?.projectAccessId ||
        (terminalTabs?.terminalGroups.reduce((count, group) => count + group.tabs.length, 0) ??
          0) >= DESKTOP_TERMINAL_LIMITS.maxTerminals,
    },
    {
      key: 'browser',
      label: '新浏览器',
      icon: <Globe size={15} />,
      disabled: (terminalTabs?.browserTabs.length ?? 0) >= 12,
    },
  ]
  const createTab = (key: string) => {
    if (key === 'session')
      workspace.createSession(
        activeGroup?.id === 'unassigned'
          ? undefined
          : (activeGroup?.id ?? snapshot.selectedProjectId ?? undefined),
      )
    else if (key === 'terminal') {
      if (terminalOwner?.projectAccessId !== undefined) {
        terminalTabs?.selectTerminalProject(terminalOwner.projectAccessId)
      }
      const group = terminalTabs?.terminalGroups.find(
        item => item.projectAccessId === terminalOwner?.projectAccessId,
      )
      group?.create?.()
      store.setView('terminal')
    } else {
      const browserProjectId =
        activeGroup?.id !== undefined && activeGroup.id !== 'unassigned'
          ? activeGroup.id
          : (project?.id ?? snapshot.projects[0]?.id ?? 'unassigned')
      terminalTabs?.openBrowser(browserProjectId)
      store.setView('browser')
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault()
      const tab = tabs[index]
      if (tab !== undefined)
        moveTab(
          tab.id,
          tabUnits.findIndex(unit => unit.tabs.some(item => item.id === tab.id)) +
            (event.key === 'ArrowLeft' ? -1 : 1),
        )
      return
    }
    let next: number
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
    else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = tabs.length - 1
    else if (event.key === 'Delete') {
      event.preventDefault()
      const tab = tabs[index]
      if (tab !== undefined) closeTab(tab.id)
      return
    } else return
    event.preventDefault()
    // 焦点先移动，Enter/Space 才执行导航，避免文件保存提示打断方向键浏览。
    stripRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
  }

  const openOverview = () => {
    setQuery('')
    setOverview(true)
  }

  return (
    <>
      <header
        className="session-chrome"
        aria-label="工作区导航"
        aria-hidden={!visible}
        inert={!visible}
      >
        <div
          className="session-tabs-frame"
          data-overflow={overflow || undefined}
          data-scroll-left={canScrollLeft || undefined}
          data-scroll-right={canScrollRight || undefined}
        >
          <button
            type="button"
            className="session-tab-scroll session-tab-scroll--left"
            aria-label="向左滚动工作标签"
            title="向左滚动标签（也可使用鼠标滚轮）"
            hidden={!overflow}
            disabled={!canScrollLeft}
            onClick={() => {
              scrollByPage(-1)
            }}
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <div className="session-tabs" role="tablist" aria-label="已打开的工作标签" ref={stripRef}>
            <div
              className="session-tab-glass"
              ref={rootRef}
              data-no-selection={selectedId === null || undefined}
            >
              <div className="session-tab-material" ref={materialRef} aria-hidden="true">
                <div className="session-tab-track" />
              </div>
              <div className="session-tab-content">
                <div className="session-tab-items" role="presentation">
                  {activeGroup !== undefined && (
                    <div className="session-tab-group" role="group" aria-label={activeGroup.name}>
                      {tabUnits.map(unit => (
                        <div
                          className="session-tab-unit"
                          key={unit.id}
                          data-tab-unit={unit.id}
                          data-split-group={
                            unit.paired ? JSON.stringify(unit.tabs.map(tab => tab.id)) : undefined
                          }
                          role={unit.paired ? 'group' : undefined}
                          aria-label={
                            unit.paired
                              ? `分屏组：${unit.tabs.map(tab => tab.title).join(' 与 ')}`
                              : undefined
                          }
                        >
                          {unit.tabs.map(tab => {
                            const index = tabs.indexOf(tab)
                            const selected = tab.id === selectedId
                            const title = tab.title
                            const pairedGroup = terminalTabs?.splitGroups.find(group =>
                              group.tabs.includes(tab.id),
                            )
                            const pairedTab =
                              pairedGroup &&
                              resources.find(
                                item => item.id === pairedGroup.tabs.find(id => id !== tab.id),
                              )
                            return (
                              <Dropdown
                                key={tab.id}
                                trigger={['contextMenu']}
                                menu={{
                                  items: [
                                    {
                                      key: 'left',
                                      label: '向左分屏',
                                      disabled: splitPartner(tab.id) === undefined,
                                    },
                                    {
                                      key: 'right',
                                      label: '向右分屏',
                                      disabled: splitPartner(tab.id) === undefined,
                                    },
                                    { key: 'merge', label: '合并分屏', disabled: !pairedGroup },
                                    { key: 'close', label: '关闭标签' },
                                    ...(activeGroup !== undefined && activeGroup.tabs.length > 0
                                      ? [{ key: 'close-group', label: '关闭当前工作区全部标签' }]
                                      : []),
                                  ],
                                  onClick: ({ key }) => {
                                    if (key === 'merge') mergeSplit(tab.id)
                                    else if (key === 'close') closeTab(tab.id)
                                    else if (key === 'close-group' && activeGroup !== undefined)
                                      closeGroup(activeGroup)
                                    else splitTab(tab.id, key as 'left' | 'right')
                                  },
                                }}
                              >
                                <div
                                  className="session-tab-shell"
                                  data-selected={selected || undefined}
                                  data-kind={tab.kind}
                                  data-split-member={pairedGroup !== undefined || undefined}
                                  data-preview={tab.preview || undefined}
                                  data-dirty={tab.dirty || undefined}
                                >
                                  <button
                                    type="button"
                                    role="tab"
                                    id={
                                      tab.kind === 'ssh'
                                        ? `ssh-terminal-tab-${tab.id.slice('ssh:'.length)}`
                                        : undefined
                                    }
                                    aria-selected={selected}
                                    aria-controls="session-workspace"
                                    aria-label={title}
                                    title={
                                      pairedTab
                                        ? `${tab.description} · 与「${pairedTab.title}」组成分屏组，点击恢复`
                                        : tab.description
                                    }
                                    aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Control+Shift+ArrowLeft Control+Shift+ArrowRight"
                                    tabIndex={
                                      selected || (selectedId === null && index === 0) ? 0 : -1
                                    }
                                    data-session-tab={tab.id}
                                    data-work-tab={tab.kind}
                                    className="session-tab"
                                    onClick={tab.select}
                                    onDoubleClick={tab.pin}
                                    onKeyDown={event => {
                                      if (
                                        (event.ctrlKey || event.metaKey) &&
                                        event.shiftKey &&
                                        ['ArrowLeft', 'ArrowRight'].includes(event.key)
                                      ) {
                                        event.preventDefault()
                                        splitTab(
                                          tab.id,
                                          event.key === 'ArrowLeft' ? 'left' : 'right',
                                        )
                                      } else onKeyDown(event, index)
                                    }}
                                  >
                                    {tab.running ? (
                                      <LoaderCircle
                                        className="spin"
                                        size={13}
                                        aria-label="进行中"
                                      />
                                    ) : tab.kind === 'browser' ? (
                                      <Globe size={13} aria-hidden="true" />
                                    ) : ['file', 'diff'].includes(tab.kind) ? (
                                      <FileCode2 size={13} aria-hidden="true" />
                                    ) : ['terminal', 'ssh'].includes(tab.kind) ? (
                                      <TerminalSquare size={13} aria-hidden="true" />
                                    ) : (
                                      <MessageSquare size={13} aria-hidden="true" />
                                    )}
                                    <span>{title}</span>
                                    {pairedGroup && <Columns2 size={12} aria-label="分屏组成员" />}
                                    {tab.unread && (
                                      <i className="session-tab-unread" aria-label="有未读更新" />
                                    )}
                                  </button>
                                  {tab.preview && (
                                    <button
                                      type="button"
                                      className="session-tab-pin"
                                      aria-label={`固定 ${tab.description}`}
                                      title="固定文件"
                                      onClick={tab.pin}
                                    >
                                      <Pin size={12} aria-hidden="true" />
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    className="session-tab-close"
                                    disabled={tab.closeDisabled}
                                    aria-label={
                                      tab.closeLabel ??
                                      (tab.kind === 'file'
                                        ? `关闭 ${tab.description}`
                                        : `关闭标签：${title}`)
                                    }
                                    title={
                                      tab.kind === 'session'
                                        ? '关闭标签，保留会话'
                                        : tab.kind === 'ssh'
                                          ? '关闭标签并断开 SSH'
                                          : tab.kind === 'terminal'
                                            ? '关闭终端并结束进程'
                                            : '关闭文件'
                                    }
                                    onClick={() => {
                                      closeTab(tab.id)
                                    }}
                                  >
                                    <X size={12} aria-hidden="true" />
                                  </button>
                                </div>
                              </Dropdown>
                            )
                          })}
                        </div>
                      ))}
                    </div>
                  )}
                  {tabs.length === 0 && (
                    <span className="session-tabs-empty">
                      {snapshot.newSessionProjectId === null ? 'MyDSH' : '新会话'}
                    </span>
                  )}
                </div>
              </div>
              <div className="session-glass-filter" ref={defsRef} aria-hidden="true" />
              <div className="session-tab-lens tab-glass-lens" aria-hidden="true" ref={lensRef} />
            </div>
          </div>
          <button
            type="button"
            className="session-tab-scroll session-tab-scroll--right"
            aria-label="向右滚动工作标签"
            title="向右滚动标签（也可使用鼠标滚轮）"
            hidden={!overflow}
            disabled={!canScrollRight}
            onClick={() => {
              scrollByPage(1)
            }}
          >
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
        {visible && (
          <>
            {!showFloatingActions && (
              <button
                type="button"
                className="new-session-tab"
                aria-label="平铺选择标签"
                title="平铺选择标签（Ctrl / ⌘ S）"
                onClick={openOverview}
              >
                <LayoutGrid size={16} aria-hidden="true" />
              </button>
            )}
            {displayedSplit && (
              <button
                type="button"
                className="new-session-tab"
                aria-label="合并分屏"
                title="合并分屏"
                onClick={() => {
                  mergeSplit()
                }}
              >
                <Columns2 size={16} aria-hidden="true" />
              </button>
            )}
            {!showFloatingActions && (
              <NewTabMenu
                visible={visible}
                buttonRef={newTabRef}
                items={newItems}
                primaryKey="session"
                onSelect={createTab}
              />
            )}
            <WindowControls />
          </>
        )}
      </header>
      {showFloatingActions && (
        <FloatingTabActions
          newTabRef={newTabRef}
          newItems={newItems}
          onOpenOverview={openOverview}
          onCreateTab={createTab}
        />
      )}
      {dragPreview &&
        createPortal(
          <div className="tab-drag-layer" aria-hidden="true">
            {drop && (
              <div
                className="tab-split-preview"
                style={{
                  left: drop.left,
                  top: drop.top,
                  width: drop.width,
                  height: drop.height,
                  gridTemplateColumns: `${drop.leftWidth}px minmax(0, 1fr)`,
                }}
                data-side={drop.side}
                data-drop-action={drop.action}
              >
                <div data-target={drop.side === 'left' || undefined}>
                  <span>
                    {drop.action === 'swap'
                      ? drop.side === 'left'
                        ? '松开交换到左侧'
                        : '移到左侧'
                      : drop.side === 'left'
                        ? '松开置于左侧'
                        : '保留在左侧'}
                  </span>
                </div>
                <div data-target={drop.side === 'right' || undefined}>
                  <span>
                    {drop.action === 'swap'
                      ? drop.side === 'right'
                        ? '松开交换到右侧'
                        : '移到右侧'
                      : drop.side === 'right'
                        ? '松开置于右侧'
                        : '保留在右侧'}
                  </span>
                </div>
              </div>
            )}
            <div
              className="tab-drag-card"
              ref={previewCard}
              data-preview-kind={dragPreview.tab.kind}
              data-drop-invalid={dropInvalid || undefined}
            >
              <header>
                <span>{tabKindLabel(dragPreview.tab)}</span>
                <strong>{dragPreview.tab.title}</strong>
              </header>
              <div className="tab-drag-snapshot" ref={previewContent}>
                {!previewSnapshot.current && (
                  <div className="tab-drag-excerpt">
                    <strong>{dragPreview.tab.title}</strong>
                    <p>{dragPreview.excerpt}</p>
                  </div>
                )}
              </div>
              <footer>
                {dropInvalid
                  ? '每组最多两个标签，松开后返回'
                  : drop?.action === 'swap'
                    ? '松开后交换左右位置'
                    : drop
                      ? `松开后置于${drop.side === 'left' ? '左' : '右'}侧`
                      : displayedSplit?.tabs.includes(dragPreview.tab.id)
                        ? '拖到另一侧交换位置 · Esc 取消'
                        : '拖到内容区分屏 · Esc 取消'}
              </footer>
            </div>
          </div>,
          document.body,
        )}
      <Modal
        title="选择工作标签"
        open={overview}
        onCancel={() => {
          setOverview(false)
        }}
        footer={null}
        width="min(1000px, 90vw)"
        className="tab-overview"
        destroyOnHidden
      >
        <Input
          autoFocus
          aria-label="搜索工作标签"
          placeholder="搜索标签或工作区"
          value={query}
          onChange={event => {
            setQuery(event.target.value)
          }}
        />
        <div
          className="tab-overview-groups"
          onKeyDown={event => {
            if (
              !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(
                event.key,
              )
            )
              return
            const buttons = [
              ...event.currentTarget.querySelectorAll<HTMLButtonElement>('.tab-overview-select'),
            ]
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
            const offset = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? buttons.length - 1
                  : (index + offset + buttons.length) % buttons.length
            event.preventDefault()
            buttons[next]?.focus()
          }}
        >
          {overviewGroups.map(group => {
            const matchedTabs = group.tabs.filter(tab =>
              `${group.name} ${tab.title} ${tab.description}`
                .toLocaleLowerCase()
                .includes(query.trim().toLocaleLowerCase()),
            )
            if (matchedTabs.length === 0) return null
            return (
              <section key={group.id} className="tab-overview-group" aria-label={group.name}>
                <header className="tab-overview-group__header">
                  <strong>{group.name}</strong>
                  <span>{group.tabs.length} 个标签</span>
                  <button
                    type="button"
                    className="session-group-close tab-overview-group__close"
                    aria-label={`关闭 ${group.name} 的全部标签`}
                    title="关闭此工作区的全部标签"
                    onClick={() => {
                      closeGroup(group)
                    }}
                  >
                    <X size={13} aria-hidden="true" />
                    <span>关闭整组</span>
                  </button>
                </header>
                <div className="tab-overview-grid">
                  {matchedTabs.map(tab => (
                    <article
                      key={tab.id}
                      className="tab-overview-card"
                      data-active={tab.active || undefined}
                    >
                      <button
                        type="button"
                        className="tab-overview-select"
                        onClick={() => {
                          tab.select()
                          setOverview(false)
                        }}
                      >
                        <span className="tab-overview-type">
                          {tabKindLabel(tab)}
                          {tab.running ? ' · 进行中' : ''}
                        </span>
                        <strong>{tab.title}</strong>
                        <span>{tab.description}</span>
                        <small>{group.name}</small>
                      </button>
                      <button
                        type="button"
                        className="tab-overview-close"
                        disabled={tab.closeDisabled}
                        aria-label={`关闭标签：${tab.title}`}
                        onClick={() => {
                          closeTab(tab.id)
                        }}
                      >
                        <X size={14} />
                      </button>
                    </article>
                  ))}
                </div>
              </section>
            )
          })}
          {resources.length === 0 && <p>没有已打开的标签</p>}
        </div>
      </Modal>
      {terminalTabs?.error && (
        <AppAlert tone="error" title="标签操作未完成" floating onClose={terminalTabs.clearError}>
          {terminalTabs.error}
        </AppAlert>
      )}
    </>
  )
}
