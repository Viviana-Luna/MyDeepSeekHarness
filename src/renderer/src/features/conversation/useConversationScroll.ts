import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
  type UIEventHandler,
} from 'react'

const DEFAULT_BOTTOM_THRESHOLD = 32
const UNINITIALIZED_SESSION = Symbol('uninitialized-session')

export interface ConversationScrollPosition {
  scrollTop: number
  anchorSeq: string | undefined
  anchorTop: number
  atBottom: boolean
}

export interface ConversationScrollOptions {
  /** 当前会话身份；首次进入定位最新，再次进入恢复阅读位置。 */
  readonly sessionKey: string | null
  readonly positions?: Map<string, ConversationScrollPosition>
  /** 最早内容的稳定版本，例如第一条原始事件的 seq。 */
  readonly headVersion: unknown
  /** 最新内容的稳定版本；只有尾部内容真正变化时才应改变。 */
  readonly tailVersion: unknown
  /** 距离滚动底部多少像素仍视为“位于最新处”。 */
  readonly bottomThreshold?: number
}

export interface ConversationScrollController {
  /** 必须挂到真正拥有 overflow 的滚动容器。 */
  readonly scrollRef: RefObject<HTMLElement | null>
  /** 挂到同一个滚动容器，用来识别读者是否离开最新位置。 */
  readonly onScroll: UIEventHandler<HTMLElement>
  readonly isAtBottom: boolean
  readonly hasUnread: boolean
  /** 显式返回最新内容，同时清除未读标记。 */
  readonly scrollToBottom: () => void
  readonly scrollToElement: (element: HTMLElement) => void
  /**
   * 在请求更早历史前调用。若传入当前可见的稳定消息节点，前插后会优先保持该节点；
   * 节点不可用时退回到滚动高度差补偿。
   */
  readonly capturePrependAnchor: (anchor?: HTMLElement | null) => void
  /** 更早历史请求失败或没有改变 headVersion 时，丢弃待恢复锚点。 */
  readonly cancelPrependAnchor: () => void
}

interface PendingPrependAnchor {
  readonly headVersion: unknown
  readonly element: HTMLElement | null
  readonly elementTop: number | null
  readonly scrollHeight: number
  readonly scrollTop: number
}

function normalizedThreshold(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_BOTTOM_THRESHOLD
}

function bottomOffset(element: HTMLElement): number {
  return Math.max(0, element.scrollHeight - element.clientHeight)
}

function nearBottom(element: HTMLElement, threshold: number): boolean {
  return bottomOffset(element) - element.scrollTop <= threshold
}

function relativeTop(element: HTMLElement, scrollport: HTMLElement): number {
  return element.getBoundingClientRect().top - scrollport.getBoundingClientRect().top
}

/**
 * 管理顺序会话列表的滚动约定：首次进入吸底、只在读者仍位于底部时跟随尾部、
 * 离底后累计一个未读提示，并在向列表头部前插历史时保持阅读位置。
 */
export function useConversationScroll({
  sessionKey,
  headVersion,
  tailVersion,
  bottomThreshold,
  positions,
}: ConversationScrollOptions): ConversationScrollController {
  const threshold = normalizedThreshold(bottomThreshold)
  const scrollRef = useRef<HTMLElement>(null)
  const mountedScrollportRef = useRef<HTMLElement | null>(null)
  const sessionRef = useRef<string | null | typeof UNINITIALIZED_SESSION>(UNINITIALIZED_SESSION)
  const tailVersionRef = useRef<unknown>(tailVersion)
  const atBottomRef = useRef(true)
  const pendingPrependRef = useRef<PendingPrependAnchor | null>(null)
  const readingAnchorRef = useRef<{ element: HTMLElement; top: number; width: number } | null>(null)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const [hasUnread, setHasUnread] = useState(false)

  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current
    if (element === null) return
    pendingPrependRef.current = null
    element.scrollTop = bottomOffset(element)
    atBottomRef.current = true
    setIsAtBottom(true)
    setHasUnread(false)
    if (sessionKey !== null)
      positions?.set(sessionKey, {
        scrollTop: element.scrollTop,
        anchorSeq: undefined,
        anchorTop: 0,
        atBottom: true,
      })
  }, [positions, sessionKey])

  const capturePrependAnchor = useCallback(
    (anchor?: HTMLElement | null) => {
      const scrollport = scrollRef.current
      if (scrollport === null) return
      const usableAnchor =
        anchor !== undefined && anchor !== null && scrollport.contains(anchor) ? anchor : null
      pendingPrependRef.current = {
        headVersion,
        element: usableAnchor,
        elementTop: usableAnchor === null ? null : relativeTop(usableAnchor, scrollport),
        scrollHeight: scrollport.scrollHeight,
        scrollTop: scrollport.scrollTop,
      }
    },
    [headVersion],
  )

  const cancelPrependAnchor = useCallback(() => {
    pendingPrependRef.current = null
  }, [])

  const rememberReadingAnchor = useCallback(() => {
    const port = scrollRef.current
    if (port === null) return
    const top = port.getBoundingClientRect().top + 64
    const element = [...port.querySelectorAll<HTMLElement>('[data-conversation-seq]')].find(
      row => row.getBoundingClientRect().bottom > top,
    )
    readingAnchorRef.current =
      element === undefined
        ? null
        : {
            element,
            top: relativeTop(element, port),
            width: port.querySelector('ol')?.getBoundingClientRect().width ?? 0,
          }
    if (sessionKey !== null && sessionRef.current === sessionKey) {
      positions?.set(sessionKey, {
        scrollTop: port.scrollTop,
        anchorSeq: element?.dataset.conversationSeq,
        anchorTop: element === undefined ? 0 : relativeTop(element, port),
        atBottom: atBottomRef.current,
      })
    }
  }, [positions, sessionKey])

  const onScroll = useCallback<UIEventHandler<HTMLElement>>(() => {
    const element = scrollRef.current
    if (element === null) return
    const pending = pendingPrependRef.current
    if (pending !== null) {
      const anchoredElement = pending.element
      const usableAnchor =
        anchoredElement !== null && element.contains(anchoredElement) ? anchoredElement : null
      pendingPrependRef.current = {
        ...pending,
        element: usableAnchor,
        elementTop: usableAnchor === null ? null : relativeTop(usableAnchor, element),
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
      }
    }
    const nextAtBottom = nearBottom(element, threshold)
    atBottomRef.current = nextAtBottom
    setIsAtBottom(nextAtBottom)
    if (nextAtBottom) setHasUnread(false)
    rememberReadingAnchor()
  }, [threshold, rememberReadingAnchor])

  const scrollToElement = useCallback(
    (target: HTMLElement) => {
      const port = scrollRef.current
      if (port === null || !port.contains(target)) return
      pendingPrependRef.current = null
      port.scrollTop += relativeTop(target, port) - 28
      const nextAtBottom = nearBottom(port, threshold)
      atBottomRef.current = nextAtBottom
      setIsAtBottom(nextAtBottom)
      if (nextAtBottom) setHasUnread(false)
      rememberReadingAnchor()
    },
    [threshold, rememberReadingAnchor],
  )

  // 宽度变化会重新排版整段历史；离底时保留可见消息的位置，吸底时继续跟随最新。
  useLayoutEffect(() => {
    const port = scrollRef.current
    if (port === null || typeof ResizeObserver === 'undefined') return
    rememberReadingAnchor()
    const observer = new ResizeObserver(() => {
      if (pendingPrependRef.current !== null) return
      const anchor = readingAnchorRef.current
      if (atBottomRef.current) scrollToBottom()
      else if (
        anchor &&
        port.contains(anchor.element) &&
        anchor.width !== port.querySelector('ol')?.getBoundingClientRect().width
      ) {
        port.scrollTop += relativeTop(anchor.element, port) - anchor.top
      }
      rememberReadingAnchor()
    })
    observer.observe(port)
    const list = port.querySelector('ol')
    if (list) observer.observe(list)
    return () => {
      observer.disconnect()
    }
  }, [sessionKey, headVersion, scrollToBottom, rememberReadingAnchor])

  // 每次提交后核对版本，而不是依赖某个加载布尔值；这样 loading 占位导致滚动节点
  // 重新挂载时，首次可用的真实节点仍会执行会话吸底。
  useLayoutEffect(() => {
    const scrollport = scrollRef.current
    if (scrollport === null) return

    const scrollportChanged = mountedScrollportRef.current !== scrollport
    const firstMount = sessionRef.current === UNINITIALIZED_SESSION
    const sessionChanged = !firstMount && !Object.is(sessionRef.current, sessionKey)
    if (scrollportChanged || firstMount || sessionChanged) {
      mountedScrollportRef.current = scrollport
      sessionRef.current = sessionKey
      tailVersionRef.current = tailVersion
      pendingPrependRef.current = null
      const saved = sessionKey === null ? undefined : positions?.get(sessionKey)
      if (saved !== undefined && !saved.atBottom) {
        scrollport.scrollTop = saved.scrollTop
        const anchor = [
          ...scrollport.querySelectorAll<HTMLElement>('[data-conversation-seq]'),
        ].find(element => element.dataset.conversationSeq === saved.anchorSeq)
        if (anchor !== undefined)
          scrollport.scrollTop += relativeTop(anchor, scrollport) - saved.anchorTop
        atBottomRef.current = false
        setIsAtBottom(false)
        setHasUnread(false)
        rememberReadingAnchor()
      } else scrollToBottom()
      return
    }

    const pending = pendingPrependRef.current
    if (pending !== null && !Object.is(pending.headVersion, headVersion)) {
      const anchoredElement = pending.element
      if (
        anchoredElement !== null &&
        scrollport.contains(anchoredElement) &&
        pending.elementTop !== null
      ) {
        scrollport.scrollTop += relativeTop(anchoredElement, scrollport) - pending.elementTop
      } else {
        scrollport.scrollTop = pending.scrollTop + (scrollport.scrollHeight - pending.scrollHeight)
      }
      pendingPrependRef.current = null
      const nextAtBottom = nearBottom(scrollport, threshold)
      atBottomRef.current = nextAtBottom
      setIsAtBottom(nextAtBottom)
    }

    const tailChanged = !Object.is(tailVersionRef.current, tailVersion)
    tailVersionRef.current = tailVersion
    if (!tailChanged) return

    if (atBottomRef.current) {
      scrollToBottom()
    } else {
      setHasUnread(true)
    }
  })

  return {
    scrollRef,
    onScroll,
    isAtBottom,
    hasUnread,
    scrollToBottom,
    scrollToElement,
    capturePrependAnchor,
    cancelPrependAnchor,
  }
}
