/** 渲染会话运行状态点阵；动画仅影响视觉，不保存或推断运行状态。 */
import type { CSSProperties } from 'react'
import styles from './PixelMatrix.module.css'

/** 以独立点显示等待、思考或搜索状态，辅助文字由调用方提供。 */
export function PixelMatrix({ variant = 'wave' }: { variant?: 'wave' | 'star' | 'scan' }) {
  return (
    <span className={styles.matrix} data-variant={variant} aria-hidden="true">
      {Array.from({ length: 9 }, (_, index) => (
        <i
          key={index}
          data-center={index === 4 || undefined}
          data-cross={index % 2 === 1 || undefined}
          style={
            {
              '--phase': variant === 'scan' ? index % 3 : Math.floor(index / 3) + (index % 3),
            } as CSSProperties
          }
        />
      ))}
    </span>
  )
}
