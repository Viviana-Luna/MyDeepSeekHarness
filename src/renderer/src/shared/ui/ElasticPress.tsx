/**
 * 弹性按压外壳：为按钮等可交互控件赋予灵动的按压鼓起、跟手果冻拉伸与弹簧回弹。
 * 当子节点为单个 React 元素时直接把引用、样式与事件透明注入该元素本身，
 * 避免多余包装节点破坏 CSS 子选择器、布局收缩与指针点击目标；多节点时回退为 span 外壳。
 */
import {
  cloneElement,
  isValidElement,
  useMemo,
  type HTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react'

import styles from './ElasticPress.module.css'
import { mergeRefs, useElasticPress } from './useElasticPress.ts'

interface ElasticPressProps extends HTMLAttributes<HTMLElement> {
  /** 被增强的交互控件，通常为单个原生 button。 */
  readonly children: ReactNode
  /** 外部注入的节点引用（例如 Ant Design Tooltip），透明转发给目标元素。 */
  readonly ref?: Ref<HTMLElement> | undefined
  /** 按压期间同步驱动的镜像元素，例如模式栏激活滑块。 */
  readonly mirrorRef?: RefObject<HTMLElement | null> | undefined
  /** 显式指定禁用状态；未传时也会自动读取目标元素的 disabled / aria-disabled。 */
  readonly disabled?: boolean | undefined
  /** 是否开启悬停预抬升（0.4）；适合浮动停靠栏或圆形主操作胶囊，紧凑工具按钮保持静止尺寸。 */
  readonly hoverSwell?: boolean | undefined
}

type ElementProps = Record<string, unknown> & {
  readonly ref?: Ref<HTMLElement>
  readonly className?: string
  readonly disabled?: boolean
  readonly 'aria-disabled'?: boolean | 'true' | 'false'
  readonly onPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void
  readonly onPointerEnter?: (event: ReactPointerEvent<HTMLElement>) => void
  readonly onPointerLeave?: (event: ReactPointerEvent<HTMLElement>) => void
  readonly onClickCapture?: (event: ReactMouseEvent<HTMLElement>) => void
}

/** 合并来自外层包装与子元素自身的同名事件回调，保证 Tooltip 等高阶组件不丢失交互。 */
function mergeEventProps(
  outer: Record<string, unknown>,
  inner: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...outer, ...inner }
  for (const [key, outerValue] of Object.entries(outer)) {
    const innerValue = inner[key]
    if (
      key.startsWith('on') &&
      typeof outerValue === 'function' &&
      typeof innerValue === 'function'
    ) {
      merged[key] = (...args: unknown[]) => {
        ;(innerValue as (...values: unknown[]) => void)(...args)
        ;(outerValue as (...values: unknown[]) => void)(...args)
      }
    }
  }
  return merged
}

/**
 * 为目标控件附加弹性按压能力。
 * 单元素子节点保持原有 DOM 结构不变，同时支持透传 Tooltip 等外层注入的事件与 ref。
 */
export function ElasticPress({
  children,
  className = '',
  ref: outerRef,
  mirrorRef,
  disabled,
  hoverSwell,
  ...rest
}: ElasticPressProps) {
  const singleElement = isValidElement(children) ? (children as ReactElement<ElementProps>) : null
  const childProps: ElementProps = singleElement ? singleElement.props : {}
  const targetDisabled =
    disabled ??
    (Boolean(childProps.disabled) ||
      childProps['aria-disabled'] === 'true' ||
      childProps['aria-disabled'] === true)

  const mergedEvents = mergeEventProps(rest, childProps)
  const childRef = childProps.ref
  const combinedExternalRef = useMemo(
    () =>
      outerRef === undefined && childRef === undefined ? undefined : mergeRefs(childRef, outerRef),
    [childRef, outerRef],
  )

  const press = useElasticPress<HTMLElement>({
    ref: combinedExternalRef,
    mirrorRef,
    disabled: targetDisabled,
    hoverSwell,
    onPointerDown: mergedEvents.onPointerDown as
      ((event: ReactPointerEvent<HTMLElement>) => void) | undefined,
    onPointerEnter: mergedEvents.onPointerEnter as
      ((event: ReactPointerEvent<HTMLElement>) => void) | undefined,
    onPointerLeave: mergedEvents.onPointerLeave as
      ((event: ReactPointerEvent<HTMLElement>) => void) | undefined,
    onClickCapture: mergedEvents.onClickCapture as
      ((event: ReactMouseEvent<HTMLElement>) => void) | undefined,
  })

  if (singleElement === null) {
    return (
      <span
        ref={press.ref}
        className={`${styles.press ?? ''} ${className}`.trim()}
        {...mergedEvents}
        {...press.handlers}
      >
        {children}
      </span>
    )
  }

  const combinedClassName = [styles.pressTarget, childProps.className, className]
    .filter(Boolean)
    .join(' ')

  return cloneElement(singleElement, {
    ...mergedEvents,
    ref: press.ref,
    className: combinedClassName,
    onPointerDown: press.handlers.onPointerDown,
    onPointerEnter: press.handlers.onPointerEnter,
    onPointerLeave: press.handlers.onPointerLeave,
    onClickCapture: press.handlers.onClickCapture,
  })
}
