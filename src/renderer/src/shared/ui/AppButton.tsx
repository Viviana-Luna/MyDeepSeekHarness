/**
 * 全平台统一按钮组件：基于 Ant Design Button 封装发送按钮同源的立体嵌压风格与弹性按压。
 * 运行在 renderer；默认注入 ElasticPress 按压反馈，透传标准 Button 属性与 ref。
 */
import { Button, type ButtonProps } from 'antd'
import type { Ref } from 'react'

import { ElasticPress } from './ElasticPress.tsx'

/** 全平台按钮语义变体。 */
export type AppButtonVariant = 'default' | 'primary' | 'danger' | 'danger-solid' | 'ghost' | 'text'

/** 全平台统一按钮属性，透传标准 Ant Design Button 参数并扩展语义变体、胶囊圆角与弹性按压开关。 */
export interface AppButtonProps extends Omit<ButtonProps, 'variant' | 'type' | 'danger' | 'ghost'> {
  /** 按钮语义变体：默认次级、主操作、危险描边、危险实心、透明描边或纯文字。 */
  readonly variant?: AppButtonVariant | undefined
  /** 是否以 999px 胶囊圆角呈现。 */
  readonly pill?: boolean | undefined
  /** 是否开启 ElasticPress 弹性按压反馈，默认开启；关闭后显式避让全局弹性委托。 */
  readonly elastic?: boolean | undefined
  /** 透传给底层按钮或锚点元素的引用。 */
  readonly ref?: Ref<HTMLButtonElement | HTMLAnchorElement> | undefined
}

interface ResolvedAntButtonProps {
  readonly type: NonNullable<ButtonProps['type']>
  readonly danger: boolean
  readonly ghost: boolean
}

const VARIANT_MAP: Readonly<Record<AppButtonVariant, ResolvedAntButtonProps>> = {
  default: { type: 'default', danger: false, ghost: false },
  primary: { type: 'primary', danger: false, ghost: false },
  danger: { type: 'default', danger: true, ghost: false },
  'danger-solid': { type: 'primary', danger: true, ghost: false },
  ghost: { type: 'default', danger: false, ghost: true },
  text: { type: 'text', danger: false, ghost: false },
}

/** 与输入区发送/停止按钮同源的可复用平台按钮组件。 */
export function AppButton({
  variant = 'default',
  pill = false,
  elastic = true,
  className = '',
  shape,
  ref,
  ...rest
}: AppButtonProps) {
  const resolved = VARIANT_MAP[variant]
  const composedClassName = [
    'mydsh-btn',
    `mydsh-btn--${variant}`,
    pill ? 'mydsh-btn--pill' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ')
  const resolvedShape = pill ? (shape ?? 'round') : shape

  const buttonNode = (
    <Button
      {...rest}
      {...(ref !== undefined ? { ref } : {})}
      {...(resolvedShape !== undefined ? { shape: resolvedShape } : {})}
      {...(elastic ? {} : { 'data-no-elastic-press': 'true' })}
      type={resolved.type}
      danger={resolved.danger}
      ghost={resolved.ghost}
      className={composedClassName}
      data-mydsh-variant={variant}
    />
  )

  if (!elastic) return buttonNode
  return <ElasticPress disabled={Boolean(rest.disabled || rest.loading)}>{buttonNode}</ElasticPress>
}
