import { Component, type ErrorInfo, type ReactNode } from 'react'

interface State {
  error: Error | null
}

/**
 * 兜底处理子组件渲染和生命周期中的异常，保留重新加载入口。
 * 事件处理器和异步 RPC 的失败仍由对应功能处理，不会自动进入这个边界。
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('MyDSH renderer 启动失败：', error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <main className="fatal-screen" role="alert">
          <strong>桌面界面启动失败</strong>
          <p>{this.state.error.message}</p>
          <button
            type="button"
            onClick={() => {
              window.location.reload()
            }}
          >
            重新加载
          </button>
        </main>
      )
    }
    return this.props.children
  }
}
