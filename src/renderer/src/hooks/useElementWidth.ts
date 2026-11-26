import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

/**
 * 判断元素的内容宽度是否不小于阈值：把「放不放得下」交给容器实际宽度，而不是窗口宽度。
 *
 * 宽度测不出（尚未布局或测试环境里为 0）时按放得下处理，避免内容无故消失；
 * 只在跨过阈值时更新状态，连续拖动缩放不会逐像素触发渲染。
 * 适用于挂载时已存在、之后只随尺寸变化的元素。
 */
export function useElementWidthAtLeast<T extends HTMLElement>(
  ref: RefObject<T | null>,
  minWidth: number,
): boolean {
  const [fits, setFits] = useState(true)
  const evaluate = useRef<() => void>(() => {})
  evaluate.current = () => {
    const element = ref.current
    if (element === null) return
    const width = element.clientWidth
    if (width <= 0) return
    const next = width >= minWidth
    setFits(current => (next === current ? current : next))
  }
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    evaluate.current()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      evaluate.current()
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [minWidth, ref])
  return fits
}
