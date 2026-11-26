/**
 * `@mydsh/computer-use` 主入口：声明主进程自动化服务上下文并导出策略与 8 个桌面操控工具。
 * 运行在后台 Runtime，不直接触碰系统权限或原生键鼠句柄。
 */
import '@deepseek-ai/cordis'
import '@mydsh/connection-access'

/** 后台 Runtime 访问主进程自动化总控的接口定义。 */
export interface MydshAutomationSystemService {
  call<T = unknown>(
    method: string,
    payload?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mydshAutomationSystem: MydshAutomationSystemService
  }
}

export * from './policy.ts'
export * from './permission-negotiation.ts'
export * from './screenshot-output.ts'
export { apply, inject } from './tools.ts'
