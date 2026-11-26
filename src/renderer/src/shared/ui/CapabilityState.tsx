import type { LucideIcon } from 'lucide-react'

export function CapabilityState({
  icon: Icon,
  title,
  detail,
}: {
  icon: LucideIcon
  title: string
  detail: string
}) {
  return (
    <div className="capability-state" role="status">
      <span className="capability-state__icon">
        <Icon size={21} strokeWidth={1.7} />
      </span>
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  )
}
