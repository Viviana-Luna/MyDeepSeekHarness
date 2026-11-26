/** renderer 空会话引导：呈现像素工坊背景、标题说明与可选预设滑块，不持有会话资源。 */
import type { ReactNode } from 'react'
import styles from './EmptyConversation.module.css'
import { PixelWorkshopBackground } from './PixelWorkshopBackground.tsx'

/** 展示空会话引导区（标题说明与预设滑块），底层铺满像素工坊微动背景。 */
export function EmptyConversation({
  title,
  description,
  preset,
}: {
  readonly title: string
  readonly description: string
  readonly preset?: ReactNode
}) {
  return (
    <section className={`workspace-view ${styles.stage}`} aria-label="空会话">
      <PixelWorkshopBackground />
      <div className={styles.content}>
        <h2>{title}</h2>
        <p>{description}</p>
        {preset}
      </div>
    </section>
  )
}
