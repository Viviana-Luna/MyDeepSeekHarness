import { useEffect, useState } from 'react'

/** 与 layout.css 使用同一窄窗口断点：它只决定右栏能否并排与窗口按钮位置，
 *  底部读数条改按输入区容器实际宽度降级，不再由窗口宽度直接控制。 */
export function useCompactInformation(): boolean {
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 1268px)').matches)
  useEffect(() => {
    const query = window.matchMedia('(max-width: 1268px)')
    const update = () => {
      setCompact(query.matches)
    }
    update()
    query.addEventListener('change', update)
    return () => {
      query.removeEventListener('change', update)
    }
  }, [])
  return compact
}
