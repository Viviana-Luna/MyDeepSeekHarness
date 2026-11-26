/** MyDSH 插件清单是安装契约；依赖只接受已安装插件的精确版本或通配符。 */
export interface MydshPluginManifest {
  id: string
  name: string
  version: string
  apiVersion: 1
  backend?: string
  frontend?: string
  styles?: string[]
  dependencies?: Record<string, string>
  /** 随插件版本交付的初始配置；持续可编辑设置由插件注册到 settings 服务。 */
  config?: Record<string, unknown>
  capabilities?: string[]
}

export interface MydshPluginInfo extends MydshPluginManifest {
  source: 'builtin' | 'user'
  enabled: boolean
  /** 当前版本仍可服务；来自存活资源，不受待重启操作影响，也不写入磁盘。 */
  running: boolean
  status: 'disabled' | 'active' | 'waiting' | 'pending' | 'error'
  error?: string
  /** 只有启用成功的版本才暴露资源路径；主进程仍须复核文件边界。 */
  directory: string
  previousVersion?: string
  pending?: { action: 'enable' | 'disable' | 'update' | 'uninstall'; version?: string }
}
