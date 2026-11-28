/**
 * 随应用交付的离线核心清单与启动阶段进度契约。
 * 供主进程准备器、打包验收脚本与启动页状态桥接共享，保持平台与框架无关。
 */

/** 随应用交付的核心清单；物理文件摘要由构建阶段生成，供打包验收或完整性复核使用。 */
export interface RuntimeBundleManifest {
  schemaVersion: 1
  /** 旧收据可缺省；新制品必须匹配本机平台和架构。 */
  platform?: string
  arch?: string
  version: string
  apiVersion: 1
  /** 核心归档文件名（如 `'runtime.asar'`）；缺省时兼容未归档的 `payload/` 目录夹具。 */
  archive?: string
  entry: string
  dataSchemaVersion: number
  files: Record<string, RuntimeBundleFile>
}

/** 清单内单个磁盘物理文件的校验元数据。 */
export interface RuntimeBundleFile {
  sha256: string
  size: number
  /** 原生工具和脚本需要保留执行权限，其他文件统一采用普通读取权限。 */
  executable?: boolean
}

/** 核心准备进度描述，不包含用户本地路径，可直接用于启动页展示。 */
export interface RuntimeInstallProgress {
  phase: 'checking' | 'installing' | 'verifying' | 'ready'
  completed: number
  total: number
  message: string
}
