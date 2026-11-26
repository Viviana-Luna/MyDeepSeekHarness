import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { usePopupMorph } from './usePopupMorph.ts'

const VIEWPORT_MARGIN = 8
const ANCHOR_GAP = 7
/** 面板超过可用高度时开始滚动的最小高度：低于它就直接压到视口边缘。 */
const MIN_USABLE_HEIGHT = 120

/** `AnchoredPanel` 的面板属性。 */
interface AnchoredPanelProps {
  readonly open: boolean
  readonly anchor: HTMLElement | null
  readonly align?: 'start' | 'end'
  readonly side?: 'top' | 'bottom' | 'auto'
  readonly motion?: 'fold' | 'morph' | undefined
  readonly focusOnOpen?: boolean | undefined
  readonly onExited?: (() => void) | undefined
  readonly className?: string | undefined
  readonly label: string
  readonly onDismiss: () => void
  readonly children: ReactNode
}

function computePanelPosition(
  anchorBounds: DOMRect,
  panelBounds: DOMRect,
  align: 'start' | 'end',
  side: 'top' | 'bottom' | 'auto',
): CSSProperties {
  const availableAbove = anchorBounds.top - ANCHOR_GAP - VIEWPORT_MARGIN
  const availableBelow = window.innerHeight - anchorBounds.bottom - ANCHOR_GAP - VIEWPORT_MARGIN
  const resolvedSide =
    side === 'auto'
      ? availableAbove >= 160 || availableAbove >= availableBelow
        ? 'top'
        : 'bottom'
      : side
  const availableHeight = resolvedSide === 'top' ? availableAbove : availableBelow
  const maxHeight = Math.max(MIN_USABLE_HEIGHT, availableHeight)
  const renderedHeight = Math.min(panelBounds.height, maxHeight)
  const requestedLeft =
    align === 'start' ? anchorBounds.left : anchorBounds.right - panelBounds.width
  const left = Math.min(
    Math.max(VIEWPORT_MARGIN, requestedLeft),
    Math.max(VIEWPORT_MARGIN, window.innerWidth - panelBounds.width - VIEWPORT_MARGIN),
  )
  const top =
    resolvedSide === 'top'
      ? Math.max(VIEWPORT_MARGIN, anchorBounds.top - ANCHOR_GAP - renderedHeight)
      : Math.min(
          window.innerHeight - VIEWPORT_MARGIN - renderedHeight,
          anchorBounds.bottom + ANCHOR_GAP,
        )
  return { position: 'fixed', left, top, maxHeight, visibility: 'visible' }
}

interface AnchoredPanelLayoutOptions {
  readonly open: boolean
  readonly present: boolean
  readonly activeAnchor: HTMLElement | null
  readonly panelRef: RefObject<HTMLDivElement | null>
  readonly align: 'start' | 'end'
  readonly side: 'top' | 'bottom' | 'auto'
  readonly focusOnOpen: boolean
  readonly children: ReactNode
  readonly onDismiss: () => void
}

function useAnchoredPanelLayout(options: AnchoredPanelLayoutOptions) {
  const { open, present, activeAnchor, panelRef, align, side, focusOnOpen, children, onDismiss } =
    options
  const [position, setPosition] = useState<CSSProperties>({
    position: 'fixed',
    visibility: 'hidden',
  })
  const [positionedForOpen, setPositionedForOpen] = useState(false)

  useLayoutEffect(() => {
    if (!present || activeAnchor === null) {
      setPosition({ position: 'fixed', visibility: 'hidden' })
      setPositionedForOpen(false)
      return
    }
    if (!open) {
      setPositionedForOpen(false)
      return
    }
    const panel = panelRef.current
    if (panel === null) return

    const update = () => {
      if (!activeAnchor.isConnected) {
        onDismiss()
        return
      }
      setPosition(
        computePanelPosition(
          activeAnchor.getBoundingClientRect(),
          panel.getBoundingClientRect(),
          align,
          side,
        ),
      )
      setPositionedForOpen(true)
    }
    const dismissOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return
      if (panel.contains(event.target) || activeAnchor.contains(event.target)) return
      // 面板内部嵌套的 Select 下拉层会 Portal 到 body，选择选项时不关闭所属面板。
      if (event.target instanceof Element && event.target.closest('.ant-select-dropdown') !== null)
        return
      onDismiss()
    }
    const dismissOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)') !== null)
        return
      event.preventDefault()
      onDismiss()
      if (focusOnOpen) activeAnchor.focus()
    }

    update()
    const resizeObserver =
      typeof ResizeObserver === 'function' ? new ResizeObserver(update) : undefined
    resizeObserver?.observe(activeAnchor)
    resizeObserver?.observe(panel)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    document.addEventListener('pointerdown', dismissOutside)
    document.addEventListener('keydown', dismissOnEscape)
    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      document.removeEventListener('pointerdown', dismissOutside)
      document.removeEventListener('keydown', dismissOnEscape)
    }
  }, [activeAnchor, align, children, focusOnOpen, onDismiss, open, panelRef, present, side])

  useLayoutEffect(() => {
    if (!open || !focusOnOpen || position.visibility !== 'visible') return
    const panel = panelRef.current
    if (panel === null) return
    const frame = requestAnimationFrame(() => panel.focus())
    return () => cancelAnimationFrame(frame)
  }, [focusOnOpen, open, panelRef, position.visibility])

  return { position, ready: open && positionedForOpen && position.visibility === 'visible' }
}

/**
 * 只读信息面板：按锚点定位、默认向上展开、点击外部或按 Escape 关闭。
 *
 * 与 `AnchoredMenu` 的区别是它不承担菜单语义：不移动焦点、不声明
 * `role="menu"`，也不参与方向键巡逻。状态条的读数面板需要在鼠标、键盘和
 * 触控下都可打开，但不应把焦点从输入框里抢走。
 */
export function AnchoredPanel({
  open,
  anchor,
  align = 'start',
  side = 'auto',
  motion = 'fold',
  focusOnOpen = false,
  onExited,
  className,
  label,
  onDismiss,
  children,
}: AnchoredPanelProps) {
  const isMorph = motion === 'morph'
  const [morphPresent, setMorphPresent] = useState(false)
  const present = isMorph ? open || morphPresent : open
  const retainedRef = useRef<{ anchor: HTMLElement; label: string; children: ReactNode } | null>(
    null,
  )
  if (open && anchor !== null) {
    retainedRef.current = { anchor, label, children }
  }
  const activeAnchor = open ? anchor : (retainedRef.current?.anchor ?? anchor)
  const activeLabel = open ? label : (retainedRef.current?.label ?? label)
  const activeChildren = open ? children : (retainedRef.current?.children ?? children)
  const panelRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<SVGSVGElement>(null)
  const pathRef = useRef<SVGPathElement>(null)
  const anchorRef = useRef<HTMLElement | null>(null)
  anchorRef.current = activeAnchor

  const finishDismiss = useCallback(() => {
    setMorphPresent(false)
    retainedRef.current = null
    onExited?.()
  }, [onExited])

  useLayoutEffect(() => {
    if (!isMorph) {
      setMorphPresent(false)
      return
    }
    if (open && anchor !== null) setMorphPresent(true)
  }, [anchor, isMorph, open])

  const { position, ready } = useAnchoredPanelLayout({
    open,
    present,
    activeAnchor,
    panelRef,
    align,
    side,
    focusOnOpen,
    children,
    onDismiss,
  })

  usePopupMorph({
    enabled: isMorph,
    open,
    ready,
    anchorRef,
    menuRef: panelRef,
    surfaceRef,
    pathRef,
    onDismissComplete: finishDismiss,
  })

  if (!present || activeAnchor === null) return null

  const portalTarget = activeAnchor.closest('dialog') ?? document.body
  return createPortal(
    <>
      {isMorph && (
        <svg ref={surfaceRef} className="anchored-menu-morph-svg" aria-hidden="true">
          <path ref={pathRef} />
        </svg>
      )}
      <div
        ref={panelRef}
        className={className ?? ''}
        style={position}
        role={open ? 'dialog' : undefined}
        aria-label={open ? activeLabel : undefined}
        tabIndex={focusOnOpen && open ? -1 : undefined}
        inert={!open || undefined}
        data-anchored-panel={open ? 'true' : undefined}
        data-menu-motion={
          isMorph ? (open && position.visibility === 'visible' ? 'open' : 'closing') : undefined
        }
        data-menu-morph={isMorph ? 'settled' : undefined}
      >
        {activeChildren}
      </div>
    </>,
    portalTarget,
  )
}
