/**
 * 通用图标按钮：统一封装 `icon-button` 样式与微果冻弹性按压交互。
 * 运行在 renderer；透传原生按钮属性与外部 `ref`，禁用时自动收回弹性形变。
 */
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'

import { useElasticPress } from './useElasticPress.ts'

/** 图标按钮组件参数。 */
export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 按钮无障碍名称及默认提示文本。 */
  label: string
  /** 按钮内部图标内容。 */
  children: ReactNode
  /** 透传给底层 button 元素的引用。 */
  ref?: Ref<HTMLButtonElement> | undefined
}

/** 带统一视觉风格与弹性按压反馈的通用图标按钮。 */
export function IconButton({ label, children, className = '', ref, ...props }: IconButtonProps) {
  const press = useElasticPress<HTMLButtonElement>({
    ref,
    disabled: props.disabled,
    onPointerDown: props.onPointerDown,
    onPointerEnter: props.onPointerEnter,
    onPointerLeave: props.onPointerLeave,
    onClickCapture: props.onClickCapture,
  })
  const composedClassName = className ? `icon-button ${className}` : 'icon-button'

  return (
    <button
      {...props}
      {...press.handlers}
      ref={press.ref}
      className={composedClassName}
      type={props.type ?? 'button'}
      aria-label={label}
      title={props.title ?? label}
    >
      {children}
    </button>
  )
}
