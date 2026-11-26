import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { usePopupMorph } from './usePopupMorph.ts'

const VIEWPORT_MARGIN = 8
const ANCHOR_GAP = 7
type MenuPosition = CSSProperties & { '--menu-fold'?: string }

interface AnchoredMenuProps {
  readonly id?: string
  readonly open: boolean
  readonly anchorRef: RefObject<HTMLElement | null>
  readonly align?: 'start' | 'end'
  readonly side?: 'top' | 'bottom' | 'auto'
  readonly className: string
  readonly label: string
  readonly popupRole?: 'menu' | 'listbox'
  readonly motion?: 'fold' | 'morph' | undefined
  readonly focusOnOpen?: boolean | undefined
  readonly onPointerEnter?: (() => void) | undefined
  readonly onPointerLeave?: (() => void) | undefined
  readonly onDismiss: () => void
  readonly children: ReactNode
  readonly submenu?:
    | {
        readonly id: string
        readonly anchor: HTMLElement
        readonly focus: boolean
        readonly className: string
        readonly label: string
        readonly children: ReactNode
      }
    | undefined
}

function menuItems(menu: HTMLElement): HTMLElement[] {
  return [
    ...menu.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not(:disabled):not([aria-disabled="true"]), ' +
        '[role="menuitemradio"]:not(:disabled):not([aria-disabled="true"]), ' +
        '[role="menuitemcheckbox"]:not(:disabled):not([aria-disabled="true"]), ' +
        '[role="option"]:not(:disabled):not([aria-disabled="true"])',
    ),
  ]
}

function useAdjacentMenu({
  mainRef,
  submenuRef,
  anchor,
  focus,
  mainLeft,
  mainTop,
}: {
  mainRef: RefObject<HTMLDivElement | null>
  submenuRef: RefObject<HTMLDivElement | null>
  anchor: HTMLElement | undefined
  focus: boolean
  mainLeft: CSSProperties['left']
  mainTop: CSSProperties['top']
}): MenuPosition {
  const [position, setPosition] = useState<MenuPosition>({ visibility: 'hidden' })
  useLayoutEffect(() => {
    const main = mainRef.current
    const submenu = submenuRef.current
    if (!main || !submenu || !anchor) return
    const update = () => {
      const parent = main.getBoundingClientRect()
      const row = anchor.getBoundingClientRect()
      const bounds = submenu.getBoundingClientRect()
      const maxHeight = window.innerHeight - VIEWPORT_MARGIN * 2
      const right = parent.right + ANCHOR_GAP
      const left = parent.left - ANCHOR_GAP - bounds.width
      const preferred = right + bounds.width <= window.innerWidth - VIEWPORT_MARGIN ? right : left
      const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - bounds.width - VIEWPORT_MARGIN)
      const maxTop = window.innerHeight - Math.min(bounds.height, maxHeight) - VIEWPORT_MARGIN
      setPosition({
        left: Math.max(VIEWPORT_MARGIN, Math.min(preferred, maxLeft)),
        top: Math.max(VIEWPORT_MARGIN, Math.min(row.top, maxTop)),
        maxHeight,
        visibility: 'visible',
        '--menu-fold': preferred === right ? '-64px 58% -64px -64px' : '-64px -64px -64px 58%',
      })
    }
    update()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : undefined
    observer?.observe(main)
    observer?.observe(submenu)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [anchor, mainLeft, mainRef, mainTop, submenuRef])
  useLayoutEffect(() => {
    const submenu = submenuRef.current
    if (!anchor || !focus || !submenu) return
    const frame = requestAnimationFrame(() => focusMenu(submenu))
    return () => cancelAnimationFrame(frame)
  }, [anchor, focus, submenuRef])
  return position
}

function focusMenu(menu: HTMLElement) {
  const items = menuItems(menu)
  const selected = items.find(item => item.matches('[aria-selected="true"], [aria-checked="true"]'))
  const target = selected ?? items[0] ?? menu
  target.focus()
}

function anchoredPosition(
  anchor: DOMRect,
  menu: DOMRect,
  { align, side }: Pick<AnchoredMenuProps, 'align' | 'side'>,
): MenuPosition {
  const availableAbove = anchor.top - ANCHOR_GAP - VIEWPORT_MARGIN
  const availableBelow = window.innerHeight - anchor.bottom - ANCHOR_GAP - VIEWPORT_MARGIN
  const opensAbove =
    side === 'top' ||
    (side === 'auto' && (availableAbove >= 180 || availableAbove >= availableBelow))
  const maxHeight = Math.max(120, opensAbove ? availableAbove : availableBelow)
  const renderedHeight = Math.min(menu.height, maxHeight)
  const requestedLeft = align === 'start' ? anchor.left : anchor.right - menu.width
  const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - menu.width - VIEWPORT_MARGIN)
  const top = opensAbove
    ? Math.max(VIEWPORT_MARGIN, anchor.top - ANCHOR_GAP - renderedHeight)
    : Math.min(window.innerHeight - VIEWPORT_MARGIN - renderedHeight, anchor.bottom + ANCHOR_GAP)
  return {
    left: Math.min(Math.max(VIEWPORT_MARGIN, requestedLeft), maxLeft),
    top,
    maxHeight,
    visibility: 'visible',
    '--menu-fold': opensAbove ? '58% -64px -64px -64px' : '-64px -64px 58% -64px',
  }
}

function useMenuPresence(
  open: boolean,
  menuRef: RefObject<HTMLDivElement | null>,
  manualExit: boolean,
) {
  const [present, setPresent] = useState(open)
  useLayoutEffect(() => {
    if (open) {
      setPresent(true)
      return
    }
    if (manualExit) return
    const menu = menuRef.current
    if (menu === null) return
    const animations = menu.getAnimations?.() ?? []
    if (animations.length === 0) {
      setPresent(false)
      return
    }
    // 退出期间菜单已不可交互。重新打开时忽略上次过渡结束的回调。
    let current = true
    void Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
      if (current) setPresent(false)
    })
    return () => {
      current = false
    }
  }, [manualExit, menuRef, open])
  const finishDismiss = useCallback(() => {
    setPresent(false)
  }, [])
  return { present: open || present, finishDismiss }
}

function moveMenuItemFocus(event: KeyboardEvent<HTMLDivElement>, onDismiss: () => void) {
  if (event.key === 'Tab') onDismiss()
  const items = menuItems(event.currentTarget)
  if (items.length === 0) return
  const current =
    document.activeElement instanceof HTMLElement ? items.indexOf(document.activeElement) : -1
  let next: number | undefined
  if (event.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % items.length
  if (event.key === 'ArrowUp')
    next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length
  if (event.key === 'Home') next = 0
  if (event.key === 'End') next = items.length - 1
  if (event.key === 'PageUp') next = 0
  if (event.key === 'PageDown') next = items.length - 1
  if (next === undefined) return
  event.preventDefault()
  items[next]?.focus()
}

interface AnchoredMenuLayoutOptions {
  readonly open: boolean
  readonly present: boolean
  readonly anchorRef: RefObject<HTMLElement | null>
  readonly menuRef: RefObject<HTMLDivElement | null>
  readonly submenuRef: RefObject<HTMLDivElement | null>
  readonly align: 'start' | 'end'
  readonly side: 'top' | 'bottom' | 'auto'
  readonly focusOnOpen: boolean
  readonly onDismiss: () => void
}

function useAnchoredMenuLayout(options: AnchoredMenuLayoutOptions) {
  const { open, present, anchorRef, menuRef, submenuRef, align, side, focusOnOpen, onDismiss } =
    options
  const [position, setPosition] = useState<MenuPosition>({ visibility: 'hidden' })
  const [positionedForOpen, setPositionedForOpen] = useState(false)

  useLayoutEffect(() => {
    if (!present) {
      setPosition({ visibility: 'hidden' })
      setPositionedForOpen(false)
      return
    }
    if (!open) {
      setPositionedForOpen(false)
      return
    }
    const anchor = anchorRef.current
    const menu = menuRef.current
    if (anchor === null || menu === null) return

    const update = () => {
      setPosition(
        anchoredPosition(anchor.getBoundingClientRect(), menu.getBoundingClientRect(), {
          align,
          side,
        }),
      )
      setPositionedForOpen(true)
    }
    const dismissOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return
      if (
        menu.contains(event.target) ||
        anchor.contains(event.target) ||
        submenuRef.current?.contains(event.target)
      )
        return
      onDismiss()
    }
    const dismissOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onDismiss()
      anchor.focus()
    }

    update()
    const resizeObserver =
      typeof ResizeObserver === 'function' ? new ResizeObserver(update) : undefined
    resizeObserver?.observe(anchor)
    resizeObserver?.observe(menu)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    document.addEventListener('pointerdown', dismissOutside)
    document.addEventListener('keydown', dismissOnEscape)
    const focusBeforeOpen = document.activeElement
    const frame = focusOnOpen
      ? requestAnimationFrame(() => {
          if (document.activeElement === focusBeforeOpen) focusMenu(menu)
        })
      : 0
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      resizeObserver?.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      document.removeEventListener('pointerdown', dismissOutside)
      document.removeEventListener('keydown', dismissOnEscape)
    }
  }, [align, anchorRef, focusOnOpen, menuRef, onDismiss, open, present, side, submenuRef])

  return { position, ready: open && positionedForOpen && position.visibility === 'visible' }
}

/** 将菜单定位到触发按钮，处理菜单内键盘导航及关闭时的绘制。 */
export function AnchoredMenu({
  id,
  open,
  anchorRef,
  align = 'start',
  side = 'auto',
  className,
  label,
  popupRole = 'menu',
  motion = 'fold',
  focusOnOpen = true,
  onPointerEnter,
  onPointerLeave,
  onDismiss,
  children,
  submenu,
}: AnchoredMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<SVGSVGElement>(null)
  const pathRef = useRef<SVGPathElement>(null)
  const maskRef = useRef<SVGMaskElement>(null)
  const maskBackdropRef = useRef<SVGRectElement>(null)
  const maskCutoutRef = useRef<SVGRectElement>(null)
  const submenuRef = useRef<HTMLDivElement>(null)
  const rawMaskId = useId()
  const maskId = `morph-anchor-mask-${rawMaskId.replace(/[^a-zA-Z0-9_-]/gu, '')}`
  const isMorph = motion === 'morph'
  const { present, finishDismiss } = useMenuPresence(open, menuRef, isMorph)
  const { position, ready } = useAnchoredMenuLayout({
    open,
    present,
    anchorRef,
    menuRef,
    submenuRef,
    align,
    side,
    focusOnOpen,
    onDismiss,
  })
  const submenuPosition = useAdjacentMenu({
    mainRef: menuRef,
    submenuRef,
    anchor: open ? submenu?.anchor : undefined,
    focus: submenu?.focus ?? false,
    mainLeft: position.left,
    mainTop: position.top,
  })

  usePopupMorph({
    enabled: isMorph,
    open,
    ready,
    anchorRef,
    menuRef,
    surfaceRef,
    pathRef,
    maskId,
    maskRef,
    maskBackdropRef,
    maskCutoutRef,
    onDismissComplete: finishDismiss,
  })

  useLayoutEffect(() => {
    const menu = menuRef.current
    // 只有仍停留在加载容器中的焦点才随首批选项进入列表。
    if (open && focusOnOpen && menu !== null && document.activeElement === menu) focusMenu(menu)
  }, [children, focusOnOpen, open])

  if (!present) return null

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => moveMenuItemFocus(event, onDismiss)

  const portalTarget = anchorRef.current?.closest('dialog') ?? document.body
  return createPortal(
    <>
      {isMorph && (
        <svg ref={surfaceRef} className="anchored-menu-morph-svg" aria-hidden="true">
          <defs>
            <mask
              ref={maskRef}
              id={maskId}
              data-morph-anchor-mask="true"
              maskUnits="userSpaceOnUse"
              maskContentUnits="userSpaceOnUse"
            >
              <rect ref={maskBackdropRef} data-morph-mask-backdrop="true" fill="white" />
              <rect ref={maskCutoutRef} data-morph-mask-cutout="true" fill="black" />
            </mask>
          </defs>
          <path ref={pathRef} />
        </svg>
      )}
      <div
        id={open ? id : undefined}
        ref={menuRef}
        className={className}
        style={position}
        role={open ? popupRole : undefined}
        aria-label={open ? label : undefined}
        tabIndex={-1}
        inert={!open}
        data-anchored-menu={open ? 'true' : undefined}
        data-menu-motion={open && position.visibility === 'visible' ? 'open' : 'closing'}
        data-menu-morph={isMorph ? 'settled' : undefined}
        onKeyDown={moveFocus}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
      >
        {children}
      </div>
      {open && submenu && (
        <div
          id={submenu.id}
          ref={submenuRef}
          className={submenu.className}
          style={submenuPosition}
          role="menu"
          aria-label={submenu.label}
          tabIndex={-1}
          data-anchored-menu="true"
          data-menu-motion={submenuPosition.visibility === 'visible' ? 'open' : 'closing'}
          onKeyDown={moveFocus}
        >
          {submenu.children}
        </div>
      )}
    </>,
    portalTarget,
  )
}
