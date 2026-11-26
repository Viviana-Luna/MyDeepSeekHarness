/** 显示围栏代码的工具栏；换行仅影响显示，复制读取代码原文。 */
import { Check, Copy, WrapText } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { writeClipboard } from './clipboard.ts'
import styles from './MessageCodeBlock.module.css'

/** 渲染代码块的语言标签、自动换行开关和复制反馈。 */
export function MessageCodeBlock({
  language,
  children,
}: {
  language: string | undefined
  children: ReactNode
}) {
  const preRef = useRef<HTMLPreElement>(null)
  const [wrap, setWrap] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (copyState === 'idle') return
    const timer = window.setTimeout(() => setCopyState('idle'), 1800)
    return () => window.clearTimeout(timer)
  }, [copyState])
  const copy = async () => {
    const text = preRef.current?.textContent
    if (text === undefined || text === null) return
    // Markdown 渲染器会在围栏内容末尾补一个换行，只去掉这一个。
    const copied = await writeClipboard(text.replace(/\n$/u, ''))
    if (preRef.current) setCopyState(copied ? 'copied' : 'failed')
  }
  return (
    <div className={styles.block} data-code-block="true" data-wrap={wrap}>
      <div className={styles.toolbar}>
        <span className={styles.language}>{language || '代码块'}</span>
        <button
          type="button"
          aria-label="自动换行"
          title="自动换行"
          aria-pressed={wrap}
          onClick={() => setWrap(value => !value)}
        >
          <WrapText size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="复制代码"
          title="复制代码"
          onClick={() => {
            void copy()
          }}
        >
          {copyState === 'copied' ? (
            <Check size={15} aria-hidden="true" />
          ) : (
            <Copy size={15} aria-hidden="true" />
          )}
        </button>
        <span className="visually-hidden" role="status">
          {copyState === 'copied' && '已复制代码'}
          {copyState === 'failed' && '复制失败，请重试'}
        </span>
      </div>
      <pre ref={preRef}>{children}</pre>
    </div>
  )
}
