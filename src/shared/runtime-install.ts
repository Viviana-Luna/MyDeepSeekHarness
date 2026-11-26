/** 随应用交付的核心清单；文件摘要由构建阶段生成，安装阶段逐项复核。 */
export interface RuntimeBundleManifest {
  schemaVersion: 1
  /** 旧收据可缺省；新安装包必须匹配本机平台和架构。 */
  platform?: string
  arch?: string
  version: string
  apiVersion: 1
  entry: string
  dataSchemaVersion: number
  files: Record<string, RuntimeBundleFile>
}

export interface RuntimeBundleFile {
  sha256: string
  size: number
  /** 原生工具和脚本需要保留执行权限，其他文件统一采用普通读取权限。 */
  executable?: boolean
}

/** 安装进度不包含用户路径，可直接用于启动页。 */
export interface RuntimeInstallProgress {
  phase: 'checking' | 'installing' | 'verifying' | 'ready'
  completed: number
  total: number
  message: string
}
