import type { Context, Plugin } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-agent'
import '@deepseek-ai/dsh-session'
import '@deepseek-ai/dsh-settings'
import '@deepseek-ai/dsh-system-prompt'
import '@deepseek-ai/dsh-api-workspace-files'
import '@deepseek-ai/dsh-api-workspace-controller'

export { Context, Service } from '@deepseek-ai/cordis'
export { default as schema } from '@deepseek-ai/schemastery'
export { defineTool, validateArgs } from '@deepseek-ai/dsh-tools'
export type {
  ToolDefinition,
  ToolRunContext,
  ParameterSchemaSpec,
  ValueSchemaSpec,
} from '@deepseek-ai/dsh-tools'
export {
  Remote,
  RemoteScope,
  RemoteError,
  TypertRemoteService,
  bindTypertRemote,
} from '@deepseek-ai/dsh-typert-protocol'
export type {
  InvocationDescriptor,
  TypertClientRemote,
  TypertCodec,
} from '@deepseek-ai/dsh-typert-protocol'
export declare const MYDSH_API_VERSION: 1

/** 后台插件的数据归属；宿主不会把插件目录作为数据写入位置。 */
export interface MydshPluginConfig {
  home: string
}

/** 插件保持原生 Cordis 生命周期，依赖和副作用通过 Context 注册。 */
export declare function definePlugin<T extends Plugin>(plugin: T): T

export interface MydshPluginManifest {
  id: string
  name: string
  version: string
  apiVersion: 1
  backend?: string
  frontend?: string
  styles?: string[]
  dependencies?: Record<string, string>
  /** 初始配置传入 apply(ctx, config)，home 始终由宿主覆盖。 */
  config?: Record<string, unknown>
  capabilities?: string[]
}

/** 只列当前正式服务；具体方法由随运行核心发布的服务类型声明合并补充。 */
export type MydshPluginContext = Context
