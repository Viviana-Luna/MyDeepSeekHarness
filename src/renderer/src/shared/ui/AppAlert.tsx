/** 渲染进程公共告警提示组件：支持信息、成功、警告、错误语义与悬浮不占位模式，自动倒计时并在悬停或聚焦时暂停。 */
import { AlertCircle, CheckCircle2, Info, TriangleAlert, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** 告警提示支持的视觉语义类型。 */
export type AppAlertTone = 'info' | 'success' | 'warning' | 'error'

/** 公共告警组件属性定义。 */
export interface AppAlertProps {
  readonly tone?: AppAlertTone
  readonly title: string
  readonly children?: ReactNode
  readonly onClose?: () => void
  readonly floating?: boolean
  readonly dismissAfterMs?: number
}

function alertIcon(tone: AppAlertTone) {
  if (tone === 'error') return AlertCircle
  if (tone === 'warning') return TriangleAlert
  if (tone === 'success') return CheckCircle2
  return Info
}

function defaultDismissDuration(tone: AppAlertTone, floating: boolean): number | undefined {
  if (!floating) return undefined
  return tone === 'info' || tone === 'success' ? 4_500 : 8_000
}

/** 渲染工作区或浮层告警提示；设置 floating 时通过 Portal 悬浮于顶部，不挤压主界面布局。 */
export function AppAlert({
  tone = 'info',
  title,
  children,
  onClose,
  floating = false,
  dismissAfterMs,
}: AppAlertProps) {
  const Icon = alertIcon(tone)
  const duration = dismissAfterMs ?? defaultDismissDuration(tone, floating)
  const hasClose = onClose !== undefined
  const close = useRef(onClose)
  close.current = onClose
  const remaining = useRef(duration ?? 0)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    remaining.current = duration ?? 0
  }, [children, duration, title])
  useEffect(() => {
    if (!hasClose || duration === undefined || duration <= 0 || hovered || focused) return
    const started = performance.now()
    const timer = window.setTimeout(() => {
      close.current?.()
    }, remaining.current)
    return () => {
      window.clearTimeout(timer)
      remaining.current = Math.max(0, remaining.current - (performance.now() - started))
    }
  }, [children, duration, focused, hasClose, hovered, title])

  const hasBody = children !== undefined && children !== null && children !== ''
  const role = tone === 'info' || tone === 'success' ? 'status' : 'alert'
  const alert = (
    <section
      className={`app-alert app-alert--${tone}${floating ? ' app-alert--floating' : ''}`}
      onMouseEnter={() => {
        setHovered(true)
      }}
      onMouseLeave={() => {
        setHovered(false)
      }}
      onFocusCapture={() => {
        setFocused(true)
      }}
      onBlurCapture={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false)
      }}
      role={role}
    >
      <Icon size={16} aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        {hasBody && <p>{children}</p>}
      </div>
      {onClose !== undefined && (
        <button type="button" aria-label="关闭提示" onClick={onClose}>
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </section>
  )
  return floating ? createPortal(alert, document.body) : alert
}
