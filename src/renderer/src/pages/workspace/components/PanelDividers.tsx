import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { useWorkspaceSnapshot, useWorkspaceStore } from '../../../hooks/useWorkspace.ts'
import { useModes } from '../../../plugins/react.tsx'
import {
  COMPOSER_HEIGHT_RANGE,
  PANEL_WIDTH_RANGES,
  type PanelName,
} from '../../../domain/panel-layout.ts'

const KEYBOARD_STEP = 10
const POINTER_RESIZE_THRESHOLD = 3

function panelWidth(snapshot: ReturnType<typeof useWorkspaceSnapshot>, panel: PanelName): number {
  return panel === 'navigation' ? snapshot.navigationWidth : snapshot.informationWidth
}

function renderedPanelWidth(panel: PanelName, fallback: number): number {
  if (panel === 'navigation') return fallback
  const element = document.querySelector<HTMLElement>('.info-island')
  const rendered = element?.getBoundingClientRect().width
  return rendered !== undefined && Number.isFinite(rendered) && rendered > 0 ? rendered : fallback
}

function PanelDivider({ panel }: { panel: PanelName }) {
  const store = useWorkspaceStore()
  const snapshot = useWorkspaceSnapshot()
  const [resizing, setResizing] = useState(false)
  const [compactNavigation, setCompactNavigation] = useState(false)
  const pointerId = useRef<number | null>(null)
  const resizeStart = useRef<{ clientX: number; width: number } | null>(null)
  const resizedDuringGesture = useRef(false)
  const resizeStartedOnCapsule = useRef(false)
  const suppressNextToggle = useRef(false)
  const collapsed =
    panel === 'navigation' ? snapshot.navigationCollapsed : snapshot.informationCollapsed
  const range = PANEL_WIDTH_RANGES[panel]
  const width = panelWidth(snapshot, panel)
  const resizeDisabled = collapsed || compactNavigation

  useEffect(() => {
    if (panel !== 'navigation' || typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(max-width: 780px)')
    const update = () => {
      setCompactNavigation(media.matches)
    }
    update()
    media.addEventListener('change', update)
    return () => {
      media.removeEventListener('change', update)
    }
  }, [panel])
  const resize =
    panel === 'navigation'
      ? (value: number) => {
          store.resizeNavigation(value)
        }
      : (value: number) => {
          store.resizeInformation(value)
        }
  const toggle =
    panel === 'navigation'
      ? () => {
          store.toggleNavigation()
        }
      : () => {
          store.toggleInformation()
        }

  const beginResize = (event: PointerEvent<HTMLDivElement>) => {
    if (resizeDisabled || event.button !== 0) return
    pointerId.current = event.pointerId
    resizeStart.current = { clientX: event.clientX, width: renderedPanelWidth(panel, width) }
    resizedDuringGesture.current = false
    resizeStartedOnCapsule.current =
      event.target instanceof Element && event.target.closest('.panel-divider__capsule') !== null
    suppressNextToggle.current = false
    event.currentTarget.setPointerCapture(event.pointerId)
    setResizing(true)
    event.preventDefault()
  }
  const continueResize = (event: PointerEvent<HTMLDivElement>) => {
    if (pointerId.current !== event.pointerId) return
    if (resizeStart.current === null) return
    const delta = event.clientX - resizeStart.current.clientX
    if (Math.abs(delta) < POINTER_RESIZE_THRESHOLD) return
    resizedDuringGesture.current = true
    resize(resizeStart.current.width + delta * (panel === 'navigation' ? 1 : -1))
  }
  const finishResize = (event: PointerEvent<HTMLDivElement>) => {
    if (pointerId.current !== event.pointerId) return
    const startedOnCapsule = resizeStartedOnCapsule.current
    const resized = resizedDuringGesture.current
    pointerId.current = null
    resizeStart.current = null
    suppressNextToggle.current = startedOnCapsule
    resizeStartedOnCapsule.current = false
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setResizing(false)
    if (startedOnCapsule) {
      if (!resized && event.type === 'pointerup') toggle()
      queueMicrotask(() => {
        suppressNextToggle.current = false
      })
    }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (resizeDisabled) return
    if (event.key === 'Home') {
      store.resetPanelWidth(panel)
      event.preventDefault()
      return
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const direction = event.key === 'ArrowRight' ? 1 : -1
    resize(
      renderedPanelWidth(panel, width) +
        direction * KEYBOARD_STEP * (panel === 'navigation' ? 1 : -1),
    )
    event.preventDefault()
  }
  const collapseLabel =
    panel === 'navigation'
      ? collapsed
        ? '展开项目面板'
        : '收起项目面板'
      : collapsed
        ? '展开右侧浮岛'
        : '收起右侧浮岛'
  const icon =
    panel === 'navigation' ? (
      collapsed ? (
        <ChevronRight size={15} />
      ) : (
        <ChevronLeft size={15} />
      )
    ) : collapsed ? (
      <ChevronLeft size={15} />
    ) : (
      <ChevronRight size={15} />
    )

  return (
    <div
      className={`panel-divider panel-divider--${panel}${resizing ? ' is-resizing' : ''}`}
      role="separator"
      aria-label={panel === 'navigation' ? '调整项目面板宽度' : '调整右侧浮岛宽度'}
      aria-orientation="vertical"
      aria-valuemin={range.minimum}
      aria-valuemax={range.maximum ?? undefined}
      aria-valuenow={width}
      aria-disabled={resizeDisabled}
      tabIndex={resizeDisabled ? -1 : 0}
      onDoubleClick={event => {
        if (!resizeDisabled && (event.target as HTMLElement).closest('button') === null)
          store.resetPanelWidth(panel)
      }}
      onKeyDown={onKeyDown}
      onPointerDown={beginResize}
      onPointerMove={continueResize}
      onPointerUp={finishResize}
      onPointerCancel={finishResize}
      onLostPointerCapture={finishResize}
    >
      <button
        className="panel-divider__capsule"
        type="button"
        aria-label={collapseLabel}
        title={
          resizeDisabled
            ? collapseLabel
            : `${collapseLabel}；拖动分隔线或胶囊调整宽度，双击分隔线恢复默认`
        }
        onClick={event => {
          if (suppressNextToggle.current) {
            suppressNextToggle.current = false
            event.preventDefault()
            return
          }
          toggle()
        }}
      >
        {icon}
      </button>
    </div>
  )
}

export function ComposerDivider() {
  const store = useWorkspaceStore()
  const snapshot = useWorkspaceSnapshot()
  const [resizing, setResizing] = useState(false)
  const pointerId = useRef<number | null>(null)
  const resizeStart = useRef<{ clientY: number; height: number } | null>(null)

  const finishResize = (event: PointerEvent<HTMLDivElement>) => {
    if (pointerId.current !== event.pointerId) return
    pointerId.current = null
    resizeStart.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setResizing(false)
  }

  return (
    <div
      className={`panel-divider panel-divider--composer${resizing ? ' is-resizing' : ''}`}
      role="separator"
      aria-label="调整输入区高度"
      aria-orientation="horizontal"
      aria-valuemin={COMPOSER_HEIGHT_RANGE.minimum}
      aria-valuemax={COMPOSER_HEIGHT_RANGE.maximum}
      aria-valuenow={snapshot.composerHeight}
      tabIndex={0}
      title="拖动调整输入区高度，双击或按 Home 恢复默认"
      onDoubleClick={() => {
        store.resetComposerHeight()
      }}
      onKeyDown={event => {
        if (event.key === 'Home') {
          store.resetComposerHeight()
          event.preventDefault()
          return
        }
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        store.resizeComposer(
          snapshot.composerHeight + (event.key === 'ArrowUp' ? 1 : -1) * KEYBOARD_STEP,
        )
        event.preventDefault()
      }}
      onPointerDown={event => {
        if (event.button !== 0) return
        pointerId.current = event.pointerId
        resizeStart.current = { clientY: event.clientY, height: snapshot.composerHeight }
        event.currentTarget.setPointerCapture(event.pointerId)
        setResizing(true)
        event.preventDefault()
      }}
      onPointerMove={event => {
        if (pointerId.current !== event.pointerId || resizeStart.current === null) return
        const delta = event.clientY - resizeStart.current.clientY
        if (Math.abs(delta) < POINTER_RESIZE_THRESHOLD) return
        store.resizeComposer(resizeStart.current.height - delta)
      }}
      onPointerUp={finishResize}
      onPointerCancel={finishResize}
      onLostPointerCapture={finishResize}
    />
  )
}

function WorkspaceResizeCorner() {
  const store = useWorkspaceStore()
  const snapshot = useWorkspaceSnapshot()
  const [resizing, setResizing] = useState(false)
  const pointerId = useRef<number | null>(null)
  const resizeStart = useRef<{
    clientX: number
    clientY: number
    informationWidth: number
    composerHeight: number
  } | null>(null)

  const reset = () => {
    store.resetPanelWidth('information')
    store.resetComposerHeight()
  }
  const finishResize = (event: PointerEvent<HTMLDivElement>) => {
    if (pointerId.current !== event.pointerId) return
    pointerId.current = null
    resizeStart.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setResizing(false)
  }

  return (
    <div
      className={`panel-resize-corner${resizing ? ' is-resizing' : ''}`}
      role="button"
      aria-label="同时调整右侧浮岛宽度和输入区高度"
      tabIndex={0}
      title="拖动同时调整右侧浮岛宽度和输入区高度，双击或按 Home 恢复默认"
      onDoubleClick={reset}
      onKeyDown={event => {
        if (event.key === 'Home') {
          reset()
          event.preventDefault()
          return
        }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          store.resizeInformation(
            renderedPanelWidth('information', snapshot.informationWidth) +
              (event.key === 'ArrowLeft' ? 1 : -1) * KEYBOARD_STEP,
          )
          event.preventDefault()
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          store.resizeComposer(
            snapshot.composerHeight + (event.key === 'ArrowUp' ? 1 : -1) * KEYBOARD_STEP,
          )
          event.preventDefault()
        }
      }}
      onPointerDown={event => {
        if (event.button !== 0) return
        pointerId.current = event.pointerId
        resizeStart.current = {
          clientX: event.clientX,
          clientY: event.clientY,
          informationWidth: renderedPanelWidth('information', snapshot.informationWidth),
          composerHeight: snapshot.composerHeight,
        }
        event.currentTarget.setPointerCapture(event.pointerId)
        setResizing(true)
        event.preventDefault()
      }}
      onPointerMove={event => {
        if (pointerId.current !== event.pointerId || resizeStart.current === null) return
        const deltaX = event.clientX - resizeStart.current.clientX
        const deltaY = event.clientY - resizeStart.current.clientY
        if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < POINTER_RESIZE_THRESHOLD) return
        store.resizeInformation(resizeStart.current.informationWidth - deltaX)
        store.resizeComposer(resizeStart.current.composerHeight - deltaY)
      }}
      onPointerUp={finishResize}
      onPointerCancel={finishResize}
      onLostPointerCapture={finishResize}
    />
  )
}

/** 装配左右栏分隔条及输入区调节柄，统一使用工作台的尺寸偏好。 */
export function PanelDividers() {
  const snapshot = useWorkspaceSnapshot()
  const modes = useModes()
  const composerResizable =
    modes.some(mode => mode.id === snapshot.activeView && mode.showComposer) &&
    snapshot.pendingInteractions.length === 0

  return (
    <>
      <PanelDivider panel="navigation" />
      <PanelDivider panel="information" />
      {composerResizable && !snapshot.informationCollapsed && <WorkspaceResizeCorner />}
    </>
  )
}
