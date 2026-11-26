/**
 * `@mydsh/browser-automation` 包主入口：声明主进程自动化桥接服务类型并导出策略与工具插件。
 * 运行在后台 Runtime（Cordis），不持有 Electron 或浏览器原生句柄。
 */
import '@deepseek-ai/cordis'
import '@mydsh/connection-access'

/** 后台 Runtime 通过 `mainCall` 访问主进程自动化服务的受控接口。 */
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
