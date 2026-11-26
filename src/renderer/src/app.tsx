/**
 * renderer 应用根入口：设置桌面平台属性、防止浮层滚动偏移、挂载全局弹性按压与错误边界。
 * 运行在 Electron renderer；为所有内置界面与动态插件控件提供统一的全局按压体验。
 */
import { useEffect, type ReactNode } from 'react'

import { DESKTOP_WINDOW_CORNER_RADIUS } from '../../shared/window.ts'
import { AppErrorBoundary } from './components/AppErrorBoundary.tsx'
import { installGlobalElasticPress } from './shared/ui/elasticPressGlobal.ts'

// 桌面界面的默认语言同时用于读屏和浏览器语义。
document.documentElement.lang = 'zh-CN'
document.documentElement.dataset.platform = /Windows/u.test(navigator.userAgent)
  ? 'win32'
  : 'darwin'
// macOS 由系统裁切窗口；这里只用近似外角计算浮岛曲率，不对页面重复裁切。
const windowOuterRadius = `${String(DESKTOP_WINDOW_CORNER_RADIUS)}px`
document.documentElement.style.setProperty('--window-outer-radius', windowOuterRadius)
if (document.documentElement.dataset.platform === 'win32')
  document.documentElement.style.setProperty('--window-clip-radius', windowOuterRadius)

/**
 * 根链用 overflow: clip 断掉滚动容器，但 Chromium 仍允许给根元素写入滚动偏移。
 * 只要 portal 到 body 的浮层（Tooltip、下拉菜单、插件浮层）越出视口，
 * focus 或 scrollIntoView 就可能留下偏移：外壳会被顶出视口，浮层也会跟着错位。
 * 这里把根偏移压回零，窗口尺寸变化时同样复位。
 */
function resetRootScroll(): void {
  for (const element of [
    document.documentElement,
    document.body,
    document.getElementById('root'),
  ]) {
    if (element === null) continue
    if (element.scrollTop !== 0) element.scrollTop = 0
    if (element.scrollLeft !== 0) element.scrollLeft = 0
  }
}

document.addEventListener('scroll', resetRootScroll, { capture: true, passive: true })
window.addEventListener('resize', resetRootScroll)
resetRootScroll()

function ElasticPressRoot({ children }: { readonly children: ReactNode }) {
  useEffect(() => installGlobalElasticPress(), [])
  return <>{children}</>
}

/** Umi 在创建页面前装配全局按压委托与错误边界，页面与路由异常使用同一恢复入口。 */
export function rootContainer(container: ReactNode): ReactNode {
  return (
    <ElasticPressRoot>
      <AppErrorBoundary>{container}</AppErrorBoundary>
    </ElasticPressRoot>
  )
}
