/** MyDSH 后台 SDK：重导出运行核心已有实现，不创建第二份 Cordis 或 Remote 注册表。 */
export { Context, Service } from '@deepseek-ai/cordis'
export { default as schema } from '@deepseek-ai/schemastery'
export { defineTool, validateArgs } from '@deepseek-ai/dsh-tools'
export {
  Remote,
  RemoteScope,
  RemoteError,
  TypertRemoteService,
  bindTypertRemote,
} from '@deepseek-ai/dsh-typert-protocol'
export const MYDSH_API_VERSION = 1

/** 保留标准 Cordis 插件形状，便于类型推断；装配与释放仍交由原生生命周期。 */
export function definePlugin(plugin) {
  return plugin
}
