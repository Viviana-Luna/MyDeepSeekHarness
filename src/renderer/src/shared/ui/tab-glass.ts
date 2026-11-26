/** 渲染进程中顶部标签和预设栏共用的透镜材质与折射几何。 */
import { LiquidGlassEngine, type LiquidGlassHost } from 'liquid-glass-web-react'

/** 创建同文档折射滤镜。调用方在控件卸载时销毁引擎。 */
export function createTabGlass(host: LiquidGlassHost, width: number, height: number) {
  const engine = new LiquidGlassEngine(host, {
    width,
    height,
    strength: 0.018,
    chromaticAberration: 0.16,
    depth: 8,
    curvature: 0.85,
    glow: 0.12,
    edgeHighlight: 0.35,
    specular: 0.7,
  })
  const filter = host.defsHost.querySelector('filter')
  if (filter !== null) {
    // Electron 的内容安全策略允许当前文档的完整资源地址。
    host.filtered.style.filter = `url("${new URL(`#${filter.id}`, document.baseURI).href}")`
  }
  return engine
}

/** 同步拉伸折射区域和描边，复用原始位移图。每帧在引擎更新位置之后调用。 */
export function scaleTabGlass(
  lens: HTMLElement,
  regions: readonly SVGElement[],
  scaleX: number,
  scaleY: number,
): void {
  for (const region of regions) {
    const left = Number(region.getAttribute('x'))
    const top = Number(region.getAttribute('y'))
    const width = Number(region.getAttribute('width'))
    const height = Number(region.getAttribute('height'))
    region.setAttribute('x', String(left + (width * (1 - scaleX)) / 2))
    region.setAttribute('y', String(top + (height * (1 - scaleY)) / 2))
    region.setAttribute('width', String(width * scaleX))
    region.setAttribute('height', String(height * scaleY))
  }
  lens.style.transform += ` scale(${String(scaleX)}, ${String(scaleY)})`
}
