/**
 * 弹性按压的 React 绑定：为单个控件注入原生指针追踪、可选镜像节点与 ref 合并能力。
 * 运行在 renderer；挂载时标记 data-elastic-managed，使全局委托自动避让，不重复施力。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type Ref,
  type RefCallback,
  type RefObject,
} from 'react'

import { ElasticPressMotion } from './elasticPressMotion.ts'
import { isPressDisabled, prefersReducedMotion, PressSession } from './elasticPressSession.ts'

/** 挂到目标元素上的弹性按压与悬停事件处理器。 */
export interface ElasticPressHandlers<T extends HTMLElement = HTMLElement> {
  readonly onPointerDown: (event: ReactPointerEvent<T>) => void
  readonly onPointerEnter: (event: ReactPointerEvent<T>) => void
  readonly onPointerLeave: (event: ReactPointerEvent<T>) => void
  readonly onClickCapture: (event: ReactMouseEvent<T>) => void
}

/** `useElasticPress` 的可选配置，全部字段均为可选。 */
export interface UseElasticPressOptions<T extends HTMLElement = HTMLElement> {
  /** 与外部持有的 ref 合并，不覆盖原 ref。 */
  readonly ref?: Ref<T> | undefined
  /** 按压期间同步镜像变换的节点，例如模式栏激活滑块。 */
  readonly mirrorRef?: RefObject<HTMLElement | null> | undefined
  /** 控件是否处于禁用态；按压或悬停中变为禁用时立即收回动画。 */
  readonly disabled?: boolean | undefined
  /** 是否启用 FlClash NavigationDock 风格的悬停预抬升（0.4）；默认仅对浮动停靠栏或主胶囊开启。 */
  readonly hoverSwell?: boolean | undefined
  /** 调用方自身的指针按下回调，将在确认处理前透传执行。 */
  readonly onPointerDown?: ((event: ReactPointerEvent<T>) => void) | undefined
  /** 调用方自身的指针悬停进入回调。 */
  readonly onPointerEnter?: ((event: ReactPointerEvent<T>) => void) | undefined
  /** 调用方自身的指针悬停离开回调。 */
  readonly onPointerLeave?: ((event: ReactPointerEvent<T>) => void) | undefined
  /** 调用方自身的捕获阶段点击回调，在未取消点击时执行。 */
  readonly onClickCapture?: ((event: ReactMouseEvent<T>) => void) | undefined
}

/** `useElasticPress` 返回的元素引用回调和事件处理器。 */
export interface ElasticPressBinding<T extends HTMLElement = HTMLElement> {
  readonly ref: RefCallback<T>
  readonly handlers: ElasticPressHandlers<T>
}

/** 安全地向单个 ref 写入节点引用，并保留 React 19 的回调清理能力。 */
function assignRef<T>(target: Ref<T> | undefined, value: T | null): void | (() => void) {
  if (typeof target === 'function') return target(value)
  if (target !== undefined && target !== null) target.current = value
  return undefined
}

/**
 * 合并多个 React ref，支持回调 ref 和 RefObject。
 * @param refs 需要同时接收节点引用的 ref 列表。
 */
export function mergeRefs<T>(...refs: readonly (Ref<T> | undefined)[]): RefCallback<T> {
  return value => {
    const cleanups: Array<() => void> = []
    for (const target of refs) {
      const cleanup = assignRef(target, value)
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    }
    if (cleanups.length === 0) return undefined
    return () => {
      for (const cleanup of cleanups) cleanup()
    }
  }
}

interface ManagedPressState<T extends HTMLElement> {
  readonly session: PressSession
  readonly elementRef: RefObject<T | null>
  readonly motionRef: RefObject<ElasticPressMotion | null>
  readonly disabled: boolean | undefined
  readonly hoverSwell: boolean | undefined
  readonly mirrorRef: RefObject<HTMLElement | null> | undefined
}

function useManagedPressLifecycle<T extends HTMLElement>(
  state: ManagedPressState<T>,
): RefCallback<T> {
  const { session, elementRef, motionRef, disabled, hoverSwell, mirrorRef } = state

  useEffect(() => {
    session.setDisabled(disabled ?? false)
    if (disabled || !hoverSwell) motionRef.current?.setHovered(false)
  }, [disabled, hoverSwell, motionRef, session])

  useLayoutEffect(() => {
    motionRef.current?.setMirror(mirrorRef?.current ?? null)
    return () => {
      motionRef.current?.setMirror(null)
    }
  }, [mirrorRef, motionRef])

  useEffect(
    () => () => {
      session.dispose(true)
      motionRef.current = null
      if (elementRef.current !== null) {
        delete elementRef.current.dataset.elasticManaged
        elementRef.current = null
      }
    },
    [elementRef, motionRef, session],
  )

  return useCallback<RefCallback<T>>(
    element => {
      const previous = elementRef.current
      if (element !== null && previous !== null && previous !== element) {
        session.dispose(true)
        motionRef.current = null
        delete previous.dataset.elasticManaged
      }
      if (element !== null) {
        element.dataset.elasticManaged = 'true'
        elementRef.current = element
        return
      }
      if (previous !== null && !previous.isConnected) {
        session.dispose(true)
        motionRef.current = null
        delete previous.dataset.elasticManaged
        elementRef.current = null
      }
    },
    [elementRef, motionRef, session],
  )
}

/**
 * 为任意可交互控件添加灵动的弹性按压、跟手拖拽形变与松手弹簧回弹。
 * @param options 外部 ref 合并、联动镜像节点、禁用态与原生事件回调透传。
 */
export function useElasticPress<T extends HTMLElement = HTMLElement>(
  options: UseElasticPressOptions<T> = {},
): ElasticPressBinding<T> {
  const sessionRef = useRef<PressSession | null>(null)
  sessionRef.current ??= new PressSession()
  const session = sessionRef.current
  const elementRef = useRef<T | null>(null)
  const motionRef = useRef<ElasticPressMotion | null>(null)
  const localRef = useManagedPressLifecycle({
    session,
    elementRef,
    motionRef,
    disabled: options.disabled,
    hoverSwell: options.hoverSwell,
    mirrorRef: options.mirrorRef,
  })

  const externalRef = options.ref
  const ref = useMemo(
    () => (externalRef === undefined ? localRef : mergeRefs(localRef, externalRef)),
    [externalRef, localRef],
  )

  const onPointerDown = (event: ReactPointerEvent<T>) => {
    options.onPointerDown?.(event)
    const element = elementRef.current
    if (element === null) return
    motionRef.current ??= new ElasticPressMotion(element)
    session.begin(event, element, motionRef.current, {
      disabled: options.disabled,
      mirror: options.mirrorRef?.current ?? null,
    })
  }

  const onPointerEnter = (event: ReactPointerEvent<T>) => {
    options.onPointerEnter?.(event)
    if (!options.hoverSwell || event.pointerType === 'touch' || prefersReducedMotion()) return
    const element = elementRef.current
    if (element === null || !element.isConnected) return
    if (isPressDisabled(element, options.disabled)) return
    motionRef.current ??= new ElasticPressMotion(element)
    motionRef.current.setHovered(true, options.mirrorRef?.current ?? null)
  }

  const onPointerLeave = (event: ReactPointerEvent<T>) => {
    options.onPointerLeave?.(event)
    motionRef.current?.setHovered(false)
  }

  const onClickCapture = (event: ReactMouseEvent<T>) => {
    if (session.interceptClick(event)) return
    options.onClickCapture?.(event)
  }

  return { ref, handlers: { onPointerDown, onPointerEnter, onPointerLeave, onClickCapture } }
}
